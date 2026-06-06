/**
 * IpcChatTransport —— 让 @ai-sdk/react 的 useChat 走 Electron IPC 而非 HTTP。
 * sendMessages 把 UIMessage 发给主进程（→ AI 子进程），把回推的 UIMessageChunk 拼成 ReadableStream。
 * 见 Docs/密语AI-Agent开发文档（AI-SDK版）.md §5.5。
 */
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai'

export type AgentScope = { kind: 'global' } | { kind: 'session'; sessionId: string; displayName?: string }
export type AgentReasoningEffort = 'auto' | 'minimal' | 'low' | 'medium' | 'high'
export type AgentModelConfig = {
  provider?: string
  apiKey?: string
  model?: string
  baseURL?: string
  protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google'
  reasoningEffort?: AgentReasoningEffort
}

export type AgentProgressEvent = {
  stage: 'run_started' | 'tool_started' | 'tool_finished' | 'indexing' | 'searching' | 'run_finished' | 'error'
  title: string
  detail?: string
  toolName?: string
  toolCallId?: string
  sessionId?: string
  elapsedMs?: number
  messagesScanned?: number
  indexedCount?: number
  sessionsScanned?: number
  coverage?: string
  depth?: number
  at: number
}

interface AgentBridge {
  run: (runId: string, messages: unknown[], scope?: unknown, modelConfig?: AgentModelConfig | null, conversationId?: number | null) => Promise<{ success: boolean; error?: string }>
  abort: (runId: string) => Promise<{ success: boolean }>
  onChunk: (runId: string, callback: (chunk: unknown) => void) => () => void
  onProgress: (runId: string, callback: (progress: unknown) => void) => () => void
}

function getAgentBridge(): AgentBridge {
  const bridge = (window as any)?.electronAPI?.agent as AgentBridge | undefined
  if (!bridge) throw new Error('electronAPI.agent 未就绪（preload 未加载？）')
  return bridge
}

function randomRunId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `run-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

export class IpcChatTransport<UI_MESSAGE extends UIMessage = UIMessage> implements ChatTransport<UI_MESSAGE> {
  constructor(
    private readonly getScope?: () => AgentScope,
    private readonly getModelConfig?: () => AgentModelConfig | null,
    private readonly getConversationId?: () => number | null,
    private readonly onProgress?: (progress: AgentProgressEvent) => void
  ) {}

  async sendMessages(options: {
    messages: UI_MESSAGE[]
    abortSignal: AbortSignal | undefined
  }): Promise<ReadableStream<UIMessageChunk>> {
    const bridge = getAgentBridge()
    const runId = randomRunId()
    const scope = this.getScope?.() ?? { kind: 'global' }
    const messages = options.messages as unknown[]
    const modelConfig = this.getModelConfig?.() ?? null
    const conversationId = this.getConversationId?.() ?? null
    const progressHandler = this.onProgress

    options.abortSignal?.addEventListener('abort', () => { void bridge.abort(runId) })

    return new ReadableStream<UIMessageChunk>({
      start(controller) {
        const off = bridge.onChunk(runId, (chunk) => {
          if (chunk === '[DONE]') {
            controller.close()
            off()
            return
          }
          controller.enqueue(chunk as UIMessageChunk)
        })
        const offProgress = bridge.onProgress(runId, (progress) => {
          if (progress && typeof progress === 'object') {
            progressHandler?.(progress as AgentProgressEvent)
          }
        })
        // 触发主进程运行；run resolve 即代表本次结束（chunk 已通过 onChunk 推完，[DONE] 关流）
        void bridge.run(runId, messages, scope, modelConfig, conversationId).catch((error: unknown) => {
          try {
            controller.enqueue({ type: 'error', errorText: error instanceof Error ? error.message : String(error) } as UIMessageChunk)
            controller.close()
          } catch { /* 已关闭 */ }
          off()
          offProgress()
        }).finally(() => {
          offProgress()
        })
      },
    })
  }

  async reconnectToStream(): Promise<ReadableStream<UIMessageChunk> | null> {
    // 本地进程，无断线重连场景
    return null
  }
}
