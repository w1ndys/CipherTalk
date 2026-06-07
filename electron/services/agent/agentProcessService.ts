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
import type { AgentProgressEvent, AgentProviderConfig, AgentRunInput } from './types'

const UTILITY_FILE = 'aiAgentUtilityProcess.js'
const RESTART_DELAY_MS = 2000

type Pending = {
  resolve: (value: any) => void
  reject: (reason: any) => void
  type: string
  startedAt: number
}

type AgentProcessLogger = {
  debug?(category: string, message: string, data?: any): void
  info(category: string, message: string, data?: any): void
  warn(category: string, message: string, data?: any): void
  error(category: string, message: string, data?: any): void
}

function errorToLogData(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

function truncateLogText(text: string, maxLength = 2000): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...<truncated>` : text
}

export class AgentProcessService {
  private worker: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private chunkHandlers = new Map<string, (chunk: UIMessageChunk) => void>()
  private progressHandlers = new Map<string, (progress: AgentProgressEvent) => void>()
  private seq = 0
  private runSeq = 0
  private initPromise: Promise<void> | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private shuttingDown = false
  private logger: AgentProcessLogger | null = null

  setLogger(logger: AgentProcessLogger | null): void {
    this.logger = logger
  }

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
    onProgress?: (progress: AgentProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const runId = `run-${++this.runSeq}`
    this.chunkHandlers.set(runId, onChunk)
    if (onProgress) this.progressHandlers.set(runId, onProgress)
    if (signal) {
      signal.addEventListener('abort', () => { void this.call('abort', { runId }).catch(() => undefined) })
    }
    try {
      await this.call<{ done: boolean }>('run', { runId, ...input })
    } finally {
      this.chunkHandlers.delete(runId)
      this.progressHandlers.delete(runId)
    }
  }

  async generateTitle(input: { firstMessage: string; providerConfig: AgentProviderConfig }): Promise<string> {
    const result = await this.call<{ title: string }>('generateTitle', input)
    return result.title
  }

  shutdown(): void {
    this.shuttingDown = true
    const w = this.worker
    this.worker = null
    this.initPromise = null
    this.rejectAllPending('agent utility process shutdown')
    this.chunkHandlers.clear()
    this.progressHandlers.clear()
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
        this.logger?.error('AIAgentProcess', `未找到 ${UTILITY_FILE}`, {
          candidates: this.getUtilityPathCandidates(),
          packaged: isElectronPackaged(),
          appPath: getAppPath(),
          resourcesPath: process.resourcesPath || null,
        })
        reject(new Error(`未找到 ${UTILITY_FILE}`))
        return
      }

      let worker: UtilityProcess
      try {
        this.logger?.warn('AIAgentProcess', '准备启动 AI Agent utility process', {
          utilityPath,
          packaged: isElectronPackaged(),
        })
        worker = utilityProcess.fork(utilityPath, [], {
          serviceName: 'CipherTalk AI Agent',
          stdio: 'pipe',
          env: { ...process.env, CT_AGENT_WCDB_PROXY: '1' },
        })
      } catch (e: any) {
        this.initPromise = null
        this.logger?.error('AIAgentProcess', '启动 AI Agent utility process 失败', errorToLogData(e))
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
        this.logger?.warn('AIAgentProcess', 'AI Agent utility process 已启动', {
          pid: worker.pid ?? null,
        })
      })

      worker.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) {
          console.log(`[aiAgentUtility:${worker.pid ?? 'unknown'}] ${text}`)
          this.logger?.debug?.('AIAgentProcess', 'AI Agent utility stdout', {
            pid: worker.pid ?? null,
            text: truncateLogText(text),
          })
        }
      })
      worker.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim()
        if (text) {
          console.error(`[aiAgentUtility:${worker.pid ?? 'unknown'}] ${text}`)
          this.logger?.warn('AIAgentProcess', 'AI Agent utility stderr', {
            pid: worker.pid ?? null,
            text: truncateLogText(text),
          })
        }
      })

      worker.on('message', (msg: any) => {
        if (msg?.type === 'wcdb:call') {
          void this.handleWcdbCall(worker, msg.payload)
          return
        }
        if (msg?.type === 'mcp:callTool') {
          void this.handleMcpCall(worker, msg.payload)
          return
        }
        if (msg?.id === 0 && msg.type === 'ready') {
          if (!readyFired) {
            readyFired = true
            this.logger?.warn('AIAgentProcess', 'AI Agent utility process 已就绪', {
              pid: worker.pid ?? null,
            })
            resolve()
          }
          return
        }
        if (msg?.id === -1 && msg.type === 'chunk') {
          const { runId, chunk } = msg.payload || {}
          this.chunkHandlers.get(runId)?.(chunk)
          return
        }
        if (msg?.id === -2 && msg.type === 'progress') {
          const { runId, progress } = msg.payload || {}
          this.progressHandlers.get(runId)?.(progress)
          return
        }
        if (typeof msg?.id === 'number') {
          const pending = this.pending.get(msg.id)
          if (!pending) return
          this.pending.delete(msg.id)
          if (msg.error) {
            this.logger?.error('AIAgentProcess', 'AI Agent utility 调用失败', {
              id: msg.id,
              type: pending.type,
              elapsedMs: Date.now() - pending.startedAt,
              error: msg.error,
            })
            pending.reject(new Error(msg.error))
          } else {
            this.logger?.debug?.('AIAgentProcess', 'AI Agent utility 调用完成', {
              id: msg.id,
              type: pending.type,
              elapsedMs: Date.now() - pending.startedAt,
            })
            pending.resolve(msg.result)
          }
        }
      })

      worker.on('error', (type, location) => {
        console.error('[agentProcessService] utility process fatal:', { pid: worker.pid, type, location })
        this.logger?.error('AIAgentProcess', 'AI Agent utility process fatal', {
          pid: worker.pid ?? null,
          type,
          location,
        })
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
          this.logger?.warn('AIAgentProcess', 'AI Agent utility process 退出，准备自动重启', {
            pid: pid ?? null,
            code,
            restartDelayMs: RESTART_DELAY_MS,
          })
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
        this.logger?.error('AIAgentProcess', 'AI Agent utility process 自动重启失败', errorToLogData(e))
      })
    }, RESTART_DELAY_MS)
  }

  private rejectAllPending(reason: string): void {
    if (this.pending.size === 0) return
    const count = this.pending.size
    const err = new Error(reason)
    for (const { reject } of this.pending.values()) {
      try { reject(err) } catch { /* ignore */ }
    }
    this.pending.clear()
    this.logger?.warn('AIAgentProcess', '已拒绝所有等待中的 AI Agent utility 调用', {
      reason,
      count,
    })
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

  /**
   * 处理子进程发来的 MCP 代理请求：MCP 连接只存在主进程，Agent 子进程只拿到只读工具描述。
   */
  private async handleMcpCall(
    worker: UtilityProcess,
    payload: { reqId: number; serverName: string; toolName: string; args?: Record<string, unknown> },
  ): Promise<void> {
    const reqId = payload?.reqId
    try {
      const { mcpClientService } = await import('../mcpClientService')
      const response = await mcpClientService.callTool(
        payload.serverName,
        payload.toolName,
        payload.args && typeof payload.args === 'object' ? payload.args : {},
      )
      if (!response.success) throw new Error(response.error || 'MCP tool call failed')
      worker.postMessage({ type: 'mcp:result', payload: { reqId, result: response.result } })
    } catch (e: any) {
      worker.postMessage({ type: 'mcp:result', payload: { reqId, error: e?.message || String(e) } })
    }
  }

  private async call<T = any>(type: string, payload: any): Promise<T> {
    await this.initWorker()
    const w = this.worker
    if (!w) throw new Error('AI agent utility process 未就绪')
    const id = ++this.seq
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, type, startedAt: Date.now() })
      try {
        w.postMessage({ id, type, payload })
      } catch (e: any) {
        this.pending.delete(id)
        this.logger?.error('AIAgentProcess', 'agent postMessage 失败', {
          id,
          type,
          ...errorToLogData(e),
        })
        reject(new Error(`agent postMessage 失败: ${e?.message || String(e)}`))
      }
    })
  }

  private getUtilityPathCandidates(): string[] {
    const appPath = getAppPath()
    const resourcesRoot = process.resourcesPath || appPath
    return isElectronPackaged()
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
  }

  private resolveUtilityPath(): string | null {
    return this.getUtilityPathCandidates().find((c) => existsSync(c)) || null
  }
}

export const agentProcessService = new AgentProcessService()
