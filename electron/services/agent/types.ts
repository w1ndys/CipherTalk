/**
 * AI Agent 编排层 —— 类型与子进程通信协议。
 * 编排全程跑在独立的 AI utilityProcess 子进程（见 Docs/密语AI-Agent开发文档（AI-SDK版）.md §3.1）。
 */
import type { JSONSchema7, ModelMessage, UIMessageChunk } from 'ai'

/** AI SDK provider 协议种类（对齐 ai/providers/base.ts 的 ProviderKind）。 */
export type ProviderKind = 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google'

/** 由主进程注入子进程的 provider 配置（子进程不依赖 ConfigService/Electron app）。 */
export interface AgentProviderConfig {
  providerKind: ProviderKind
  name: string
  apiKey: string
  baseURL: string
  model: string
  headers?: Record<string, string>
  reasoningEffort?: AgentReasoningEffort
  /** 主进程注入的系统代理 URL（子进程无 session 探测不了）；空/无则直连。 */
  proxyUrl?: string
}

export type AgentReasoningEffort = 'auto' | 'minimal' | 'low' | 'medium' | 'high'

export interface AgentProviderConfigOverride {
  provider?: string
  apiKey?: string
  model?: string
  baseURL?: string
  protocol?: ProviderKind
  reasoningEffort?: AgentReasoningEffort
}

/** 提问范围：全局 / 限定单个会话（@ 某联系人或群时收窄）。 */
export type AgentScope =
  | { kind: 'global' }
  | { kind: 'session'; sessionId: string; displayName?: string }

export interface AgentMcpToolDescriptor {
  name: string
  serverName: string
  toolName: string
  description?: string
  inputSchema?: JSONSchema7
}

export interface AgentSkillContextItem {
  name: string
  version: string
  description: string
  content: string
}

export type AgentProgressStage =
  | 'run_started'
  | 'tool_started'
  | 'tool_finished'
  | 'indexing'
  | 'searching'
  | 'run_finished'
  | 'error'

export interface AgentProgressEvent {
  stage: AgentProgressStage
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
  /** 进度深度：0=主 Agent，≥1=子 Agent（委托）；前端据此区分展示。 */
  depth?: number
  at: number
}

export type AgentProgressReporter = (event: AgentProgressEvent) => void

/** 一次 agent 运行的输入。 */
export interface AgentRunInput {
  messages: ModelMessage[]
  providerConfig: AgentProviderConfig
  scope: AgentScope
  mcpTools?: AgentMcpToolDescriptor[]
  skills?: AgentSkillContextItem[]
}

// ========= 主进程 ↔ AI 子进程 postMessage 协议 =========
// 约定：id===0 && type==='ready' 为启动就绪信号；id===-1 && type==='chunk' 为流式 UI 消息块。

export type AgentRequest =
  | { id: number; type: 'ping' }
  | { id: number; type: 'run'; payload: { runId: string } & AgentRunInput }
  | { id: number; type: 'abort'; payload: { runId: string } }

export type AgentResponse =
  | { id: number; result?: unknown; error?: string }
  | { id: 0; type: 'ready' }
  | { id: -1; type: 'chunk'; payload: { runId: string; chunk: UIMessageChunk } }
  | { id: -2; type: 'progress'; payload: { runId: string; progress: AgentProgressEvent } }
