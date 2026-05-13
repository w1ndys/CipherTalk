import type { RuntimeConfig } from '../types.js'

export interface StatusData {
  configured: boolean
  configPath: string
  dbPath?: string
  wxid?: string
  nativeRoot: string
  databaseFiles: number
  connection?: {
    attempted: boolean
    ok: boolean
    sessionCount?: number
    error?: string
  }
}

export interface SessionRow {
  sessionId: string
  displayName: string
  type: 'private' | 'group' | 'mp' | 'other'
  lastMessage: string
  lastTime: number
  messageCount?: number
}

export interface MessageRow {
  localId?: number
  serverId?: number
  createTime?: number
  sortSeq?: number
  direction: 'in' | 'out' | 'unknown'
  senderUsername?: string
  type?: number | string
  content: string
  raw?: unknown
}

export interface ContactRow {
  wxid: string
  displayName: string
  type: 'friend' | 'group' | 'mp' | 'former_friend' | 'other'
  remark?: string
  nickname?: string
  avatarUrl?: string
  lastContactTime?: number
}

export interface DataService {
  getStatus(config: RuntimeConfig): Promise<StatusData>
  listSessions(config: RuntimeConfig, options: { type?: string; limit: number; offset?: number }): Promise<{ sessions: SessionRow[]; hasMore: boolean }>
  getMessages(config: RuntimeConfig, session: string, options: { limit: number; offset?: number; from?: string; to?: string; type?: string; direction?: string; cursor?: string }): Promise<{ messages: MessageRow[]; cursor: string | null }>
  listContacts(config: RuntimeConfig, options: { type?: string; limit: number }): Promise<{ contacts: ContactRow[] }>
  getContactInfo(config: RuntimeConfig, contact: string): Promise<ContactRow | null>
}

export interface KeyService {
  setKey(hex: string): Promise<{ saved: boolean; keyHex: string }>
  testKey(config: RuntimeConfig): Promise<{ validFormat: boolean; connection?: StatusData['connection'] }>
  getKey(config: RuntimeConfig): Promise<{ keyHex: string }>
}

export interface AdvancedService {
  search(): Promise<never>
  stats(): Promise<never>
  exportChat(): Promise<never>
  moments(): Promise<never>
  report(): Promise<never>
  mcpServe(): Promise<never>
}

export interface ServiceRegistry {
  data: DataService
  key: KeyService
  advanced: AdvancedService
}
