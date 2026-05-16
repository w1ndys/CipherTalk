export type MessageRole = 'user' | 'assistant'

export interface ThinkingBlock {
  type: 'thinking'
  text: string
  streaming?: boolean
}

export interface ToolResult {
  kind: 'snippet' | 'terminal' | 'diff' | 'list'
  lang?: string
  text?: string
  items?: string[]
}

export interface ToolBlock {
  type: 'tool'
  name: string
  status: 'running' | 'ok' | 'error'
  args?: Record<string, unknown>
  result?: ToolResult | null
  duration?: string
}

export interface TextBlock {
  type: 'text'
  text: string
}

export type AssistantBlock = ThinkingBlock | ToolBlock | TextBlock

export interface Message {
  id: string
  role: MessageRole
  content?: string
  blocks?: AssistantBlock[]
  streaming?: boolean
  attached?: AttachedResource[]
}

export interface ConversationItem {
  id: string
  title: string
  preview: string
  time: string
}

export interface ConversationGroup {
  group: string
  items: ConversationItem[]
}

export interface SlashCommand {
  command: string
  description: string
}

export interface AttachMenuItem {
  id: string
  label: string
  description: string
  icon: 'file' | 'image' | 'database' | 'globe' | 'cpu'
}

export interface AttachedResource {
  id: string
  label: string
  icon: AttachMenuItem['icon']
}

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface McpServer {
  id: string
  name: string
  toolCount: number
  status: McpServerStatus
  error?: string
}

export interface AgentSkill {
  id: string
  name: string
  description: string
  builtin?: boolean
}
