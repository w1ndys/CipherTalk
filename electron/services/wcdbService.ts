/**
 * WcdbService —— WcdbCore 的 Worker 代理层。
 * 业务层（chatService / snsService / dbAdapter）调用签名保持不变，事件 'change' 来自 native 管道。
 * Worker 崩溃会 reject 所有 pending 并在 2 秒后自动重启。
 * TODO(tl): 已在 vite.config.ts 声明 wcdbWorker 入口；若变更打包布局请同步 resolveWorkerPath()。
 */
import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import { app } from 'electron'
import { ConfigService } from './config'

type WorkerRequest = { id: number; type: string; payload?: any }
type WorkerResponse = { id: number; result?: any; error?: string; type?: string; payload?: any }
type Pending = { resolve: (value: any) => void; reject: (reason: any) => void }
type OpenPayload = { dbPath: string; hexKey: string; wxid: string }

const PARAMS_UNSUPPORTED = 'native 未支持参数化查询'

function bufferToHex(buffer: Buffer): string {
  return Array.from(buffer)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function sqlLiteral(value: any): string {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'object' && value && typeof value.type === 'string' && 'value' in value) {
    return sqlLiteral(value.value)
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (Buffer.isBuffer(value)) return `X'${bufferToHex(value)}'`
  if (value instanceof Uint8Array) return `X'${bufferToHex(Buffer.from(value))}'`
  return `'${String(value).replace(/'/g, "''")}'`
}

function inlineParams(sql: string, params: any[]): string {
  let index = 0
  let out = ''
  let quote: '"' | "'" | '`' | null = null

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]
    if (quote) {
      out += ch
      if (ch === quote) {
        if (sql[i + 1] === quote) out += sql[++i]
        else quote = null
      }
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      out += ch
      continue
    }
    if (ch === '?' && index < params.length) {
      out += sqlLiteral(params[index++])
      continue
    }
    out += ch
  }

  if (index !== params.length) {
    throw new Error(`参数数量不匹配: expected ${index}, got ${params.length}`)
  }
  return out
}

const WORKER_FILE = 'wcdbWorker.js'
const RESTART_DELAY_MS = 2000

export class WcdbService extends EventEmitter {
  private worker: Worker | null = null
  private pending = new Map<number, Pending>()
  private seq = 0
  private initPromise: Promise<void> | null = null
  private openPromise: Promise<boolean> | null = null
  private lastOpenPayload: OpenPayload | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private shuttingDown = false

  // ========= 公共 API（保持与旧实现一致） =========
  async testConnection(dbPath: string, hexKey: string, wxid: string): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    return this.call('testConnection', { dbPath, hexKey, wxid })
  }

  async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
    const payload = { dbPath, hexKey, wxid }
    this.lastOpenPayload = payload
    this.openPromise = this.call<boolean>('open', payload)
      .finally(() => {
        this.openPromise = null
      })
    return this.openPromise
  }

  close(): void {
    this.lastOpenPayload = null
    // 没有 worker 时无需冷启动，直接返回（与旧同步实现行为一致）
    if (!this.worker) return
    const w = this.worker
    const id = ++this.seq
    try { w.postMessage({ id, type: 'close', payload: {} } as WorkerRequest) } catch { /* ignore */ }
  }

  shutdown(): void {
    this.shuttingDown = true
    this.lastOpenPayload = null
    this.openPromise = null
    const w = this.worker
    this.worker = null
    this.initPromise = null
    this.rejectAllPending('wcdb service shutdown')
    if (w) {
      try { w.postMessage({ id: ++this.seq, type: 'shutdown', payload: {} }) } catch { /* ignore */ }
      void w.terminate().catch(() => undefined)
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  async execQuery(kind: string, path: string, sql: string): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return this.callWithAutoOpen('execQuery', { kind, path, sql })
  }

  async execQueryWithParams(kind: string, path: string, sql: string, params?: any[]): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!params || params.length === 0) {
      return this.execQuery(kind, path, sql)
    }
    const result = await this.callWithAutoOpen('execQueryWithParams', { kind, path, sql, params })
    if (result.success || !result.error?.includes(PARAMS_UNSUPPORTED)) {
      return result
    }
    return this.execQuery(kind, path, inlineParams(sql, params))
  }

  async getSnsTimeline(limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: any[]; error?: string }> {
    return this.callWithAutoOpen('getSnsTimeline', { limit, offset, usernames, keyword, startTime, endTime })
  }

  async getNativeMessages(sessionId: string, limit: number, offset: number): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return this.callWithAutoOpen('getNativeMessages', { sessionId, limit, offset })
  }

  async openMessageCursor(
    sessionId: string,
    batchSize: number,
    ascending: boolean,
    beginTimestamp: number,
    endTimestamp: number
  ): Promise<{ success: boolean; cursor?: number; error?: string }> {
    return this.callWithAutoOpen('openMessageCursor', { sessionId, batchSize, ascending, beginTimestamp, endTimestamp })
  }

  async openMessageCursorLite(
    sessionId: string,
    batchSize: number,
    ascending: boolean,
    beginTimestamp: number,
    endTimestamp: number
  ): Promise<{ success: boolean; cursor?: number; error?: string }> {
    return this.callWithAutoOpen('openMessageCursorLite', { sessionId, batchSize, ascending, beginTimestamp, endTimestamp })
  }

  async fetchMessageBatch(cursor: number): Promise<{ success: boolean; rows?: any[]; hasMore?: boolean; error?: string }> {
    return this.callWithAutoOpen('fetchMessageBatch', { cursor })
  }

  async getMessageBatchViaCursor(
    sessionId: string,
    batchSize: number,
    ascending: boolean,
    beginTimestamp: number,
    endTimestamp: number,
    useLite: boolean = true,
    maxBatches: number = 1
  ): Promise<{ success: boolean; rows?: any[]; hasMore?: boolean; error?: string }> {
    return this.callWithAutoOpen('getMessageBatchViaCursor', {
      sessionId,
      batchSize,
      ascending,
      beginTimestamp,
      endTimestamp,
      useLite,
      maxBatches
    })
  }

  async closeMessageCursor(cursor: number): Promise<{ success: boolean; error?: string }> {
    return this.callWithAutoOpen('closeMessageCursor', { cursor })
  }

  async getNewMessages(sessionId: string, minTime: number, limit: number = 1000): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    const openRes = await this.openMessageCursor(sessionId, limit, true, minTime, 0)
    if (!openRes.success || !openRes.cursor) {
      return { success: false, error: openRes.error || '创建游标失败' }
    }
    try {
      const batch = await this.fetchMessageBatch(openRes.cursor)
      if (!batch.success) return { success: false, error: batch.error || '获取批次失败' }
      return { success: true, rows: batch.rows || [] }
    } finally {
      await this.closeMessageCursor(openRes.cursor).catch(() => undefined)
    }
  }

  async setMonitor(): Promise<boolean> {
    const res = await this.call<{ success: boolean }>('setMonitor', {})
    return !!res?.success
  }

  async stopMonitor(): Promise<void> {
    await this.call('stopMonitor', {})
  }

  async decryptSnsImage(encryptedData: Buffer, _key: string): Promise<Buffer> {
    return encryptedData
  }

  async decryptSnsVideo(encryptedData: Buffer, _key: string): Promise<Buffer> {
    return encryptedData
  }

  // ========= Worker 管理 =========
  async initWorker(): Promise<void> {
    if (this.worker) return
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise<void>((resolve, reject) => {
      const workerPath = this.resolveWorkerPath()
      if (!workerPath) {
        this.initPromise = null
        reject(new Error(`未找到 ${WORKER_FILE}`))
        return
      }

      let worker: Worker
      try {
        worker = new Worker(workerPath)
      } catch (e: any) {
        this.initPromise = null
        reject(new Error(`启动 wcdbWorker 失败: ${e?.message || String(e)}`))
        return
      }

      this.worker = worker
      let readyFired = false

      worker.on('message', (msg: WorkerResponse) => {
        // native 管道变更事件
        if (msg?.id === -1 && msg.type === 'monitor') {
          const p = msg.payload || {}
          this.emit('change', p.type, p.json)
          return
        }
        // Worker 启动就绪：下发 setPaths，然后结束 init
        if (msg?.id === 0 && msg.type === 'ready') {
          const resourcesPath = app.isPackaged
            ? join(process.resourcesPath, 'resources')
            : join(app.getAppPath(), 'resources')
          const userDataPath = app.getPath('userData')
          try {
            const id = ++this.seq
            worker.postMessage({ id, type: 'setPaths', payload: { resourcesPath, userDataPath } } as WorkerRequest)
            this.pending.set(id, {
              resolve: () => {
                if (!readyFired) {
                  readyFired = true
                  resolve()
                }
              },
              reject: (err) => {
                if (!readyFired) {
                  readyFired = true
                  reject(err instanceof Error ? err : new Error(String(err)))
                }
              }
            })
          } catch (e: any) {
            if (!readyFired) {
              readyFired = true
              reject(new Error(`wcdbWorker setPaths 失败: ${e?.message || String(e)}`))
            }
          }
          return
        }
        // 普通 RPC 回复
        if (typeof msg?.id === 'number') {
          const pending = this.pending.get(msg.id)
          if (!pending) return
          this.pending.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve(msg.result)
        }
      })

      worker.on('error', (err) => {
        console.error('[wcdbService] worker error:', err)
      })

      worker.on('exit', (code) => {
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        this.rejectAllPending(`worker crashed (exit=${code})`)
        if (!readyFired) {
          readyFired = true
          reject(new Error(`wcdbWorker 启动后立即退出，code=${code}`))
        }
        if (!this.shuttingDown) {
          console.warn(`[wcdbService] worker 退出 code=${code}，${RESTART_DELAY_MS}ms 后自动重启`)
          this.scheduleRestart()
        }
      })
    })

    try {
      await this.initPromise
    } catch (e) {
      this.initPromise = null
      throw e
    }
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.shuttingDown) return
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.shuttingDown || this.worker) return
      this.initWorker().catch((e) => {
        console.error('[wcdbService] 自动重启失败:', e?.message || e)
      })
    }, RESTART_DELAY_MS)
  }

  private rejectAllPending(reason: string): void {
    if (this.pending.size === 0) return
    const err = new Error(reason)
    for (const { reject } of this.pending.values()) {
      try { reject(err) } catch { /* ignore */ }
    }
    this.pending.clear()
  }

  private async call<T = any>(type: string, payload: any): Promise<T> {
    await this.initWorker()
    if (!this.worker) {
      throw new Error('wcdbWorker 未就绪')
    }
    const id = ++this.seq
    const w = this.worker
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        w.postMessage({ id, type, payload } as WorkerRequest)
      } catch (e: any) {
        this.pending.delete(id)
        reject(new Error(`postMessage 失败: ${e?.message || String(e)}`))
      }
    })
  }

  private async callWithAutoOpen<T extends { success?: boolean; error?: string }>(type: string, payload: any): Promise<T> {
    let result = await this.call<T>(type, payload)
    if (!this.isUninitializedResult(result)) return result

    const reopened = await this.ensureOpen()
    if (!reopened) return result

    result = await this.call<T>(type, payload)
    return result
  }

  private isUninitializedResult(result: any): boolean {
    return result?.success === false && typeof result?.error === 'string' && result.error.includes('WCDB 未初始化')
  }

  private async ensureOpen(): Promise<boolean> {
    if (this.openPromise) return this.openPromise

    let payload = this.lastOpenPayload
    if (!payload) {
      payload = this.readConfiguredOpenPayload()
      if (payload) this.lastOpenPayload = payload
    }
    if (!payload) return false

    this.openPromise = this.call<boolean>('open', payload)
      .finally(() => {
        this.openPromise = null
      })
    return this.openPromise
  }

  private readConfiguredOpenPayload(): OpenPayload | null {
    let configService: ConfigService | null = null
    try {
      configService = new ConfigService()
      const dbPath = String(configService.get('dbPath') || '').trim()
      const hexKey = String(configService.get('decryptKey') || '').trim()
      const wxid = String(configService.get('myWxid') || '').trim()
      if (!dbPath || !hexKey || !wxid) return null
      return { dbPath, hexKey, wxid }
    } catch {
      return null
    } finally {
      try { configService?.close() } catch { /* ignore */ }
    }
  }

  /**
   * 解析 wcdbWorker.js 路径。dev / packaged 候选路径参考 findElectronWorkerPath。
   * 不直接复用那个工具函数，是为了避免与 main/workers 形成循环或 ipc 依赖。
   */
  private resolveWorkerPath(): string | null {
    const candidates = app.isPackaged
      ? [
          join(process.resourcesPath, 'app.asar', 'dist-electron', WORKER_FILE),
          join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', WORKER_FILE),
          join(process.resourcesPath, 'dist-electron', WORKER_FILE),
          join(__dirname, WORKER_FILE),
          join(__dirname, '..', WORKER_FILE)
        ]
      : [
          join(__dirname, '..', WORKER_FILE),
          join(__dirname, WORKER_FILE),
          join(app.getAppPath(), 'dist-electron', WORKER_FILE)
        ]
    return candidates.find((c) => existsSync(c)) || null
  }
}

export const wcdbService = new WcdbService()
