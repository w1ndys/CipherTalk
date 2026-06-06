/**
 * AgentProcessService —— AI agent 子进程的主进程代理层。
 * 仿 wcdbService：utilityProcess.fork + postMessage 协议 + 崩溃自动重启 + 路径解析。
 * 主进程只做 broker：拉起/重启子进程、转发请求、把流式 chunk 回调给上层（IPC/MessagePort 在 Phase C 接）。
 */
import { utilityProcess } from 'electron'
import type { UtilityProcess } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import type { UIMessageChunk } from 'ai'
import { getAppPath, isElectronPackaged } from '../runtimePaths'
import type { AgentRunInput } from './types'

const UTILITY_FILE = 'aiAgentUtilityProcess.js'
const RESTART_DELAY_MS = 2000

type Pending = { resolve: (value: any) => void; reject: (reason: any) => void }

export class AgentProcessService {
  private worker: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private chunkHandlers = new Map<string, (chunk: UIMessageChunk) => void>()
  private seq = 0
  private runSeq = 0
  private initPromise: Promise<void> | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private shuttingDown = false

  /** 连通性自检：返回 'pong'。 */
  async ping(): Promise<string> {
    return this.call<string>('ping', undefined)
  }

  /**
   * 跑一次 agent，流式 chunk 经 onChunk 回调。Promise 在本次运行结束时 resolve。
   */
  async run(
    input: AgentRunInput,
    onChunk: (chunk: UIMessageChunk) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const runId = `run-${++this.runSeq}`
    this.chunkHandlers.set(runId, onChunk)
    if (signal) {
      signal.addEventListener('abort', () => { void this.call('abort', { runId }).catch(() => undefined) })
    }
    try {
      await this.call<{ done: boolean }>('run', { runId, ...input })
    } finally {
      this.chunkHandlers.delete(runId)
    }
  }

  shutdown(): void {
    this.shuttingDown = true
    const w = this.worker
    this.worker = null
    this.initPromise = null
    this.rejectAllPending('agent utility process shutdown')
    this.chunkHandlers.clear()
    if (w) {
      try { w.kill() } catch { /* ignore */ }
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
  }

  // ========= utilityProcess 管理 =========
  private async initWorker(): Promise<void> {
    this.shuttingDown = false
    if (this.worker) return
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise<void>((resolve, reject) => {
      const utilityPath = this.resolveUtilityPath()
      if (!utilityPath) {
        this.initPromise = null
        reject(new Error(`未找到 ${UTILITY_FILE}`))
        return
      }

      let worker: UtilityProcess
      try {
        worker = utilityProcess.fork(utilityPath, [], {
          serviceName: 'CipherTalk AI Agent',
          stdio: 'pipe',
          env: { ...process.env, CT_AGENT_WCDB_PROXY: '1' },
        })
      } catch (e: any) {
        this.initPromise = null
        reject(new Error(`启动 AI agent utility process 失败: ${e?.message || String(e)}`))
        return
      }

      this.worker = worker
      let readyFired = false
      const rejectInitOnce = (err: Error) => {
        if (!readyFired) { readyFired = true; reject(err) }
      }

      worker.on('spawn', () => {
        console.info(`[agentProcessService] utility process spawned pid=${worker.pid ?? 'unknown'}`)
      })

      worker.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) console.log(`[aiAgentUtility:${worker.pid ?? 'unknown'}] ${text}`)
      })
      worker.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) console.error(`[aiAgentUtility:${worker.pid ?? 'unknown'}] ${text}`)
      })

      worker.on('message', (msg: any) => {
        if (msg?.type === 'wcdb:call') {
          void this.handleWcdbCall(worker, msg.payload)
          return
        }
        if (msg?.id === 0 && msg.type === 'ready') {
          if (!readyFired) { readyFired = true; resolve() }
          return
        }
        if (msg?.id === -1 && msg.type === 'chunk') {
          const { runId, chunk } = msg.payload || {}
          this.chunkHandlers.get(runId)?.(chunk)
          return
        }
        if (typeof msg?.id === 'number') {
          const pending = this.pending.get(msg.id)
          if (!pending) return
          this.pending.delete(msg.id)
          if (msg.error) pending.reject(new Error(msg.error))
          else pending.resolve(msg.result)
        }
      })

      worker.on('error', (type, location) => {
        console.error('[agentProcessService] utility process fatal:', { pid: worker.pid, type, location })
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        this.rejectAllPending(`agent utility process fatal (${type})`)
        rejectInitOnce(new Error(`AI agent utility process fatal: ${type}`))
      })

      worker.on('exit', (code) => {
        const pid = worker.pid
        if (this.worker === worker) this.worker = null
        this.initPromise = null
        this.rejectAllPending(`agent utility process exited (pid=${pid ?? 'unknown'}, code=${code})`)
        rejectInitOnce(new Error(`AI agent utility process 启动后立即退出，code=${code}`))
        if (!this.shuttingDown) {
          console.warn(`[agentProcessService] utility process 退出 pid=${pid ?? 'unknown'} code=${code}，${RESTART_DELAY_MS}ms 后自动重启`)
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
      if (this.shuttingDown) return
      this.initWorker().catch((e) => {
        console.error('[agentProcessService] 自动重启失败:', e?.message || e)
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

  /**
   * 处理子进程发来的 wcdb 代理请求：用主进程已打开的 wcdbService 执行后回传。
   * 子进程的数据层（dbAdapter / chatService / contactNameResolver 等）由此复用原微信库连接。
   */
  private async handleWcdbCall(
    worker: UtilityProcess,
    payload: { reqId: number; method: string; payload: any },
  ): Promise<void> {
    const reqId = payload?.reqId
    try {
      const { wcdbService } = await import('../wcdbService')
      const result = await wcdbService.runProxiedCall(payload.method, payload.payload)
      worker.postMessage({ type: 'wcdb:result', payload: { reqId, result } })
    } catch (e: any) {
      worker.postMessage({ type: 'wcdb:result', payload: { reqId, error: e?.message || String(e) } })
    }
  }

  private async call<T = any>(type: string, payload: any): Promise<T> {
    await this.initWorker()
    const w = this.worker
    if (!w) throw new Error('AI agent utility process 未就绪')
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try {
        w.postMessage({ id, type, payload })
      } catch (e: any) {
        this.pending.delete(id)
        reject(new Error(`agent postMessage 失败: ${e?.message || String(e)}`))
      }
    })
  }

  private resolveUtilityPath(): string | null {
    const appPath = getAppPath()
    const resourcesRoot = process.resourcesPath || appPath
    const candidates = isElectronPackaged()
      ? [
          join(resourcesRoot, 'app.asar.unpacked', 'dist-electron', UTILITY_FILE),
          join(resourcesRoot, 'app.asar', 'dist-electron', UTILITY_FILE),
          join(resourcesRoot, 'dist-electron', UTILITY_FILE),
          join(__dirname, UTILITY_FILE),
          join(__dirname, '..', UTILITY_FILE),
        ]
      : [
          join(__dirname, UTILITY_FILE),
          join(__dirname, '..', UTILITY_FILE),
          join(appPath, 'dist-electron', UTILITY_FILE),
        ]
    return candidates.find((c) => existsSync(c)) || null
  }
}

export const agentProcessService = new AgentProcessService()
