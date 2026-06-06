import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import type { UIMessage } from 'ai'
import { ConfigService } from '../config'
import type { AgentScope } from './types'

const DB_NAME = 'agent_conversations.db'

export interface AgentConversationRecord {
  id: number
  accountId: string
  scope: AgentScope
  title: string
  modelProvider: string
  modelId: string
  createdAt: number
  updatedAt: number
}

export interface AgentConversationMessage {
  id: number
  conversationId: number
  role: string
  message: UIMessage
  createdAt: number
}

export interface AgentConversationLoaded extends AgentConversationRecord {
  messages: UIMessage[]
}

interface AppendRawResponseInput {
  conversationId?: number | null
  runId: string
  chunkIndex: number
  chunk: unknown
  scope?: AgentScope
  modelProvider?: string
  modelId?: string
}

interface CreateConversationInput {
  scope?: AgentScope
  title?: string
  modelProvider?: string
  modelId?: string
}

interface ListConversationOptions {
  scope?: AgentScope
  limit?: number
}

function toScope(kind: string, sessionId?: string | null, displayName?: string | null): AgentScope {
  if (kind === 'session' && sessionId) {
    return { kind: 'session', sessionId, displayName: displayName || undefined }
  }
  return { kind: 'global' }
}

function scopeColumns(scope?: AgentScope): { kind: string; sessionId: string | null; displayName: string | null } {
  if (scope?.kind === 'session') {
    return {
      kind: 'session',
      sessionId: scope.sessionId,
      displayName: scope.displayName || null,
    }
  }
  return { kind: 'global', sessionId: null, displayName: null }
}

function safeJsonParseMessage(value: string): UIMessage | null {
  try {
    const parsed = JSON.parse(value)
    if (parsed && typeof parsed === 'object') return parsed as UIMessage
  } catch {
    // ignore malformed historical rows
  }
  return null
}

export class AgentConversationStore {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  private getCacheBasePath(): string {
    const config = new ConfigService()
    try {
      const cachePath = String(config.get('cachePath') || '').trim()
      return cachePath || join(process.cwd(), 'cache')
    } finally {
      config.close()
    }
  }

  private getAccountId(): string {
    const config = new ConfigService()
    try {
      const active = config.getActiveAccount()
      const wxid = String(config.get('myWxid') || '').trim()
      return active?.id || wxid || 'default'
    } finally {
      config.close()
    }
  }

  private getDb(): Database.Database {
    const basePath = this.getCacheBasePath()
    if (!existsSync(basePath)) mkdirSync(basePath, { recursive: true })

    const nextDbPath = join(basePath, DB_NAME)
    if (this.db && this.dbPath === nextDbPath) return this.db

    if (this.db) {
      try { this.db.close() } catch { /* ignore */ }
    }

    const db = new Database(nextDbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    this.db = db
    this.dbPath = nextDbPath
    this.ensureSchema(db)
    return db
  }

  close(): void {
    if (!this.db) return
    try {
      this.db.close()
    } catch {
      // ignore
    } finally {
      this.db = null
      this.dbPath = null
    }
  }

  private ensureSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        session_id TEXT,
        display_name TEXT,
        title TEXT NOT NULL,
        model_provider TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        ui_message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS agent_raw_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        conversation_id INTEGER,
        run_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        chunk_type TEXT NOT NULL DEFAULT '',
        raw_json TEXT NOT NULL,
        scope_kind TEXT NOT NULL DEFAULT 'global',
        session_id TEXT,
        model_provider TEXT NOT NULL DEFAULT '',
        model_id TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES agent_conversations(id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_agent_conv_account_scope
        ON agent_conversations(account_id, scope_kind, session_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_msg_conv
        ON agent_messages(conversation_id, created_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_raw_conv
        ON agent_raw_responses(conversation_id, created_at ASC, id ASC);
      CREATE INDEX IF NOT EXISTS idx_agent_raw_run
        ON agent_raw_responses(run_id, chunk_index ASC);
    `)
  }

  private mapConversation(row: any): AgentConversationRecord {
    return {
      id: Number(row.id),
      accountId: String(row.account_id || ''),
      scope: toScope(String(row.scope_kind || 'global'), row.session_id, row.display_name),
      title: String(row.title || '新对话'),
      modelProvider: String(row.model_provider || ''),
      modelId: String(row.model_id || ''),
      createdAt: Number(row.created_at || 0),
      updatedAt: Number(row.updated_at || 0),
    }
  }

  list(options: ListConversationOptions = {}): AgentConversationRecord[] {
    const db = this.getDb()
    const accountId = this.getAccountId()
    const limit = Math.max(1, Math.min(100, Number(options.limit || 50)))
    const filters = ['account_id = @accountId']
    const params: Record<string, unknown> = { accountId, limit }

    if (options.scope?.kind === 'session') {
      filters.push('scope_kind = @scopeKind', 'session_id = @sessionId')
      params.scopeKind = 'session'
      params.sessionId = options.scope.sessionId
    } else if (options.scope?.kind === 'global') {
      filters.push('scope_kind = @scopeKind')
      params.scopeKind = 'global'
    }

    const rows = db.prepare(`
      SELECT * FROM agent_conversations
      WHERE ${filters.join(' AND ')}
      ORDER BY updated_at DESC, id DESC
      LIMIT @limit
    `).all(params)

    return rows.map((row) => this.mapConversation(row))
  }

  create(input: CreateConversationInput = {}): AgentConversationRecord {
    const db = this.getDb()
    const accountId = this.getAccountId()
    const scope = scopeColumns(input.scope)
    const now = Date.now()
    const result = db.prepare(`
      INSERT INTO agent_conversations (
        account_id, scope_kind, session_id, display_name, title,
        model_provider, model_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      accountId,
      scope.kind,
      scope.sessionId,
      scope.displayName,
      String(input.title || '新对话').slice(0, 80),
      String(input.modelProvider || ''),
      String(input.modelId || ''),
      now,
      now,
    )

    return this.loadMeta(Number(result.lastInsertRowid))
  }

  load(id: number): AgentConversationLoaded | null {
    const meta = this.loadMeta(id, false)
    if (!meta) return null
    const rows = this.getDb().prepare(`
      SELECT * FROM agent_messages
      WHERE conversation_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(id) as any[]
    const messages = rows
      .map((row) => safeJsonParseMessage(String(row.ui_message_json || '')))
      .filter((message): message is UIMessage => !!message)
    return { ...meta, messages }
  }

  loadMeta(id: number): AgentConversationRecord
  loadMeta(id: number, required: false): AgentConversationRecord | null
  loadMeta(id: number, required = true): AgentConversationRecord | null {
    const row = this.getDb().prepare('SELECT * FROM agent_conversations WHERE id = ?').get(id)
    if (!row) {
      if (required) throw new Error(`AI 对话不存在: ${id}`)
      return null
    }
    return this.mapConversation(row)
  }

  remove(id: number): { success: boolean } {
    const db = this.getDb()
    const tx = db.transaction((conversationId: number) => {
      db.prepare('DELETE FROM agent_raw_responses WHERE conversation_id = ?').run(conversationId)
      db.prepare('DELETE FROM agent_messages WHERE conversation_id = ?').run(conversationId)
      db.prepare('DELETE FROM agent_conversations WHERE id = ?').run(conversationId)
    })
    tx(id)
    return { success: true }
  }

  rename(id: number, title: string): AgentConversationRecord {
    const nextTitle = String(title || '新对话').trim().slice(0, 80) || '新对话'
    this.getDb().prepare(`
      UPDATE agent_conversations
      SET title = ?, updated_at = ?
      WHERE id = ?
    `).run(nextTitle, Date.now(), id)
    return this.loadMeta(id)
  }

  updateMeta(id: number, patch: { scope?: AgentScope; modelProvider?: string; modelId?: string }): AgentConversationRecord {
    const scope = patch.scope ? scopeColumns(patch.scope) : null
    const db = this.getDb()
    const current = this.loadMeta(id)
    db.prepare(`
      UPDATE agent_conversations
      SET scope_kind = ?, session_id = ?, display_name = ?,
          model_provider = ?, model_id = ?, updated_at = ?
      WHERE id = ?
    `).run(
      scope?.kind || current.scope.kind,
      scope ? scope.sessionId : (current.scope.kind === 'session' ? current.scope.sessionId : null),
      scope ? scope.displayName : (current.scope.kind === 'session' ? current.scope.displayName || null : null),
      patch.modelProvider ?? current.modelProvider,
      patch.modelId ?? current.modelId,
      Date.now(),
      id,
    )
    return this.loadMeta(id)
  }

  append(id: number, messages: UIMessage[]): AgentConversationRecord {
    const db = this.getDb()
    const insert = db.prepare(`
      INSERT INTO agent_messages (conversation_id, role, ui_message_json, created_at)
      VALUES (?, ?, ?, ?)
    `)
    const tx = db.transaction((items: UIMessage[]) => {
      for (const message of items) {
        insert.run(id, String(message.role || 'unknown'), JSON.stringify(message), Date.now())
      }
      db.prepare('UPDATE agent_conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id)
    })
    tx(messages)
    return this.loadMeta(id)
  }

  replaceMessages(id: number, messages: UIMessage[]): AgentConversationRecord {
    const db = this.getDb()
    const insert = db.prepare(`
      INSERT INTO agent_messages (conversation_id, role, ui_message_json, created_at)
      VALUES (?, ?, ?, ?)
    `)
    const tx = db.transaction((items: UIMessage[]) => {
      db.prepare('DELETE FROM agent_messages WHERE conversation_id = ?').run(id)
      const baseTime = Date.now()
      items.forEach((message, index) => {
        insert.run(id, String(message.role || 'unknown'), JSON.stringify(message), baseTime + index)
      })
      db.prepare('UPDATE agent_conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id)
    })
    tx(messages)
    return this.loadMeta(id)
  }

  appendRawResponse(input: AppendRawResponseInput): void {
    const db = this.getDb()
    const accountId = this.getAccountId()
    const scope = scopeColumns(input.scope)
    let rawJson = ''
    try {
      rawJson = JSON.stringify(input.chunk)
    } catch {
      rawJson = JSON.stringify({ unserializable: String(input.chunk) })
    }
    if (rawJson === undefined) rawJson = JSON.stringify({ value: String(input.chunk) })
    const chunkType = input.chunk && typeof input.chunk === 'object' && 'type' in input.chunk
      ? String((input.chunk as { type?: unknown }).type || '')
      : typeof input.chunk

    db.prepare(`
      INSERT INTO agent_raw_responses (
        account_id, conversation_id, run_id, chunk_index, chunk_type,
        raw_json, scope_kind, session_id, model_provider, model_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      accountId,
      input.conversationId ?? null,
      input.runId,
      input.chunkIndex,
      chunkType,
      rawJson,
      scope.kind,
      scope.sessionId,
      String(input.modelProvider || ''),
      String(input.modelId || ''),
      Date.now(),
    )
  }

  getLast(scope?: AgentScope): AgentConversationRecord | null {
    return this.list({ scope, limit: 1 })[0] || null
  }
}

export const agentConversationStore = new AgentConversationStore()
