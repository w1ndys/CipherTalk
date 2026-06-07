import Database from 'better-sqlite3'
import { cosineSimilarity } from 'ai'
import { createHash } from 'crypto'
import { existsSync, mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { ConfigService } from '../config'
import {
  MEMORY_DB_NAME,
  MEMORY_SCHEMA_VERSION,
  MEMORY_SOURCE_TYPES,
  type MemoryDatabaseStats,
  type MemoryEvidenceRef,
  type MemoryItem,
  type MemoryItemInput,
  type MemoryItemRow,
  type MemorySourceType
} from './memorySchema'

export type MemoryKeywordSearchOptions = {
  query: string
  sessionId?: string
  sourceTypes?: MemorySourceType[]
  startTimeMs?: number
  endTimeMs?: number
  limit?: number
}

export type MemoryKeywordSearchHit = {
  item: MemoryItem
  rank: number
  score: number
  retrievalSource: 'memory_fts' | 'memory_like'
}

function nowMs(): number {
  return Date.now()
}

function getCacheBasePath(): string {
  const configService = new ConfigService()
  try {
    const cachePath = String(configService.get('cachePath') || '').trim()
    return cachePath || join(process.cwd(), 'cache')
  } finally {
    configService.close()
  }
}

function normalizeNullableText(value?: string | null): string | null {
  const text = String(value || '').trim()
  return text || null
}

function normalizeNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : fallback
}

function clamp01(value: unknown, fallback: number): number {
  const numberValue = normalizeNumber(value, fallback)
  return Math.max(0, Math.min(1, numberValue))
}

function safeJsonStringify(value: unknown, fallback: unknown): string {
  try {
    return JSON.stringify(value ?? fallback)
  } catch {
    return JSON.stringify(fallback)
  }
}

function parseStringArrayJson(value: string): string[] {
  try {
    const parsed = JSON.parse(value || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function parseEvidenceRefsJson(value: string): MemoryEvidenceRef[] {
  try {
    const parsed = JSON.parse(value || '[]')
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((item): MemoryEvidenceRef | null => {
        if (!item || typeof item !== 'object') return null
        const source = item as Record<string, unknown>
        const sessionId = String(source.sessionId || '').trim()
        const localId = Number(source.localId)
        const createTime = Number(source.createTime)
        const sortSeq = Number(source.sortSeq)
        if (!sessionId || !Number.isFinite(localId) || !Number.isFinite(createTime) || !Number.isFinite(sortSeq)) {
          return null
        }
        const senderUsername = String(source.senderUsername || '').trim()
        const excerpt = String(source.excerpt || '').trim()
        return {
          sessionId,
          localId,
          createTime,
          sortSeq,
          ...(senderUsername ? { senderUsername } : {}),
          ...(excerpt ? { excerpt } : {})
        }
      })
      .filter((item): item is MemoryEvidenceRef => Boolean(item))
  } catch {
    return []
  }
}

function toTimestampSeconds(value?: number): number | null {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null
  const numberValue = Number(value)
  return numberValue > 10_000_000_000 ? Math.floor(numberValue / 1000) : Math.floor(numberValue)
}

function escapeFtsPhrase(value: string): string {
  return `"${String(value || '').replace(/"/g, '""')}"`
}

function buildMemoryFtsQuery(query: string): string {
  const normalized = String(query || '')
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[，。！？；：、“”‘’（）()[\]{}<>《》|\\/+=*_~`#$%^&-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return ''

  const terms = normalized
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
  return terms.length > 1
    ? terms.map(escapeFtsPhrase).join(' AND ')
    : escapeFtsPhrase(normalized)
}

function buildMemoryFilterSql(
  options: Pick<MemoryKeywordSearchOptions, 'sessionId' | 'sourceTypes' | 'startTimeMs' | 'endTimeMs'>,
  params: Record<string, unknown>
): string {
  const clauses: string[] = []
  if (options.sessionId) {
    clauses.push('m.session_id = @sessionId')
    params.sessionId = options.sessionId
  }

  const sourceTypes = Array.from(new Set((options.sourceTypes || []).filter((type) => MEMORY_SOURCE_TYPES.includes(type))))
  if (sourceTypes.length > 0) {
    const placeholders = sourceTypes.map((_, index) => `@sourceType${index}`)
    sourceTypes.forEach((sourceType, index) => {
      params[`sourceType${index}`] = sourceType
    })
    clauses.push(`m.source_type IN (${placeholders.join(', ')})`)
  }

  const startTime = toTimestampSeconds(options.startTimeMs)
  if (startTime) {
    clauses.push('COALESCE(m.time_end, m.time_start, 0) >= @startTime')
    params.startTime = startTime
  }

  const endTime = toTimestampSeconds(options.endTimeMs)
  if (endTime) {
    clauses.push('COALESCE(m.time_start, m.time_end, 0) <= @endTime')
    params.endTime = endTime
  }

  return clauses.length ? `AND ${clauses.join(' AND ')}` : ''
}

function safeSourceType(value: string): MemorySourceType {
  return MEMORY_SOURCE_TYPES.includes(value as MemorySourceType)
    ? value as MemorySourceType
    : 'message'
}

function toMemoryItem(row: MemoryItemRow): MemoryItem {
  return {
    id: Number(row.id),
    memoryUid: row.memory_uid,
    sourceType: safeSourceType(row.source_type),
    sessionId: row.session_id,
    contactId: row.contact_id,
    groupId: row.group_id,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    entities: parseStringArrayJson(row.entities_json),
    tags: parseStringArrayJson(row.tags_json),
    importance: Number(row.importance || 0),
    confidence: Number(row.confidence || 0),
    timeStart: row.time_start == null ? null : Number(row.time_start),
    timeEnd: row.time_end == null ? null : Number(row.time_end),
    sourceRefs: parseEvidenceRefsJson(row.source_refs_json),
    createdAt: Number(row.created_at || 0),
    updatedAt: Number(row.updated_at || 0)
  }
}

export function hashMemoryContent(title: string, content: string): string {
  return createHash('sha256')
    .update(`${String(title || '').trim()}\n${String(content || '')}`)
    .digest('hex')
}

export class MemoryDatabase {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  getDbPath(): string {
    return join(getCacheBasePath(), MEMORY_DB_NAME)
  }

  getDb(): Database.Database {
    const nextDbPath = this.getDbPath()
    const dir = dirname(nextDbPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    if (this.db && this.dbPath === nextDbPath) {
      return this.db
    }

    if (this.db) {
      this.close()
    }

    const db = new Database(nextDbPath)
    this.db = db
    this.dbPath = nextDbPath
    this.ensureSchema(db)
    return db
  }

  ensureReady(): void {
    this.getDb()
  }

  close(): void {
    if (!this.db) return
    try {
      this.db.close()
    } finally {
      this.db = null
      this.dbPath = null
    }
  }

  private ensureSchema(db: Database.Database): void {
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.pragma('foreign_keys = ON')

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_uid TEXT NOT NULL UNIQUE,
        source_type TEXT NOT NULL,
        session_id TEXT,
        contact_id TEXT,
        group_id TEXT,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        entities_json TEXT NOT NULL DEFAULT '[]',
        tags_json TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 1,
        time_start INTEGER,
        time_end INTEGER,
        source_refs_json TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_items_source_type
        ON memory_items(source_type);
      CREATE INDEX IF NOT EXISTS idx_memory_items_session_time
        ON memory_items(session_id, time_start, time_end);
      CREATE INDEX IF NOT EXISTS idx_memory_items_contact
        ON memory_items(contact_id);
      CREATE INDEX IF NOT EXISTS idx_memory_items_group
        ON memory_items(group_id);
      CREATE INDEX IF NOT EXISTS idx_memory_items_hash
        ON memory_items(content_hash);
    `)

    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id    INTEGER NOT NULL,
        model_id     TEXT NOT NULL,
        dim          INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        embedding    BLOB NOT NULL,
        indexed_at   INTEGER NOT NULL,
        PRIMARY KEY (memory_id, model_id)
      );
    `)

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_items_fts USING fts5(
        title,
        content,
        entities,
        tags,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `)
    this.syncMemoryFtsIndex(db)

    db.prepare(`
      INSERT OR REPLACE INTO memory_meta(key, value, updated_at)
      VALUES ('schema_version', ?, ?)
    `).run(MEMORY_SCHEMA_VERSION, nowMs())
  }

  private syncMemoryFtsIndex(db: Database.Database): void {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_items m
      LEFT JOIN memory_items_fts f ON f.rowid = m.id
      WHERE f.rowid IS NULL
    `).get() as { count: number } | undefined
    if (!Number(row?.count || 0)) return

    db.prepare(`
      INSERT INTO memory_items_fts(rowid, title, content, entities, tags)
      SELECT id, title, content, entities_json, tags_json
      FROM memory_items
      WHERE id NOT IN (SELECT rowid FROM memory_items_fts)
    `).run()
  }

  private upsertMemoryFtsRow(item: MemoryItem): void {
    const db = this.getDb()
    db.prepare('DELETE FROM memory_items_fts WHERE rowid = ?').run(item.id)
    db.prepare(`
      INSERT INTO memory_items_fts(rowid, title, content, entities, tags)
      VALUES (@id, @title, @content, @entities, @tags)
    `).run({
      id: item.id,
      title: item.title,
      content: item.content,
      entities: safeJsonStringify(item.entities || [], []),
      tags: safeJsonStringify(item.tags || [], [])
    })
  }

  upsertMemoryItem(input: MemoryItemInput): MemoryItem {
    const db = this.getDb()
    const timestamp = nowMs()
    const memoryUid = String(input.memoryUid || '').trim()
    const content = String(input.content || '')
    const title = String(input.title || '')
    if (!memoryUid) throw new Error('memoryUid is required')
    if (!content.trim()) throw new Error('memory content is required')
    if (!MEMORY_SOURCE_TYPES.includes(input.sourceType)) {
      throw new Error(`Unsupported memory source type: ${input.sourceType}`)
    }

    const existing = db.prepare('SELECT created_at FROM memory_items WHERE memory_uid = ?')
      .get(memoryUid) as { created_at: number } | undefined
    const createdAt = Number(existing?.created_at || timestamp)
    const contentHash = input.contentHash || hashMemoryContent(title, content)

    db.prepare(`
      INSERT INTO memory_items (
        memory_uid, source_type, session_id, contact_id, group_id,
        title, content, content_hash, entities_json, tags_json,
        importance, confidence, time_start, time_end, source_refs_json,
        created_at, updated_at
      ) VALUES (
        @memoryUid, @sourceType, @sessionId, @contactId, @groupId,
        @title, @content, @contentHash, @entitiesJson, @tagsJson,
        @importance, @confidence, @timeStart, @timeEnd, @sourceRefsJson,
        @createdAt, @updatedAt
      )
      ON CONFLICT(memory_uid) DO UPDATE SET
        source_type = excluded.source_type,
        session_id = excluded.session_id,
        contact_id = excluded.contact_id,
        group_id = excluded.group_id,
        title = excluded.title,
        content = excluded.content,
        content_hash = excluded.content_hash,
        entities_json = excluded.entities_json,
        tags_json = excluded.tags_json,
        importance = excluded.importance,
        confidence = excluded.confidence,
        time_start = excluded.time_start,
        time_end = excluded.time_end,
        source_refs_json = excluded.source_refs_json,
        updated_at = excluded.updated_at
    `).run({
      memoryUid,
      sourceType: input.sourceType,
      sessionId: normalizeNullableText(input.sessionId),
      contactId: normalizeNullableText(input.contactId),
      groupId: normalizeNullableText(input.groupId),
      title,
      content,
      contentHash,
      entitiesJson: safeJsonStringify(input.entities || [], []),
      tagsJson: safeJsonStringify(input.tags || [], []),
      importance: normalizeNumber(input.importance, 0),
      confidence: clamp01(input.confidence, 1),
      timeStart: input.timeStart ?? null,
      timeEnd: input.timeEnd ?? null,
      sourceRefsJson: safeJsonStringify(input.sourceRefs || [], []),
      createdAt,
      updatedAt: timestamp
    })

    const item = this.getMemoryItemByUid(memoryUid)
    if (!item) throw new Error('Failed to load upserted memory item')
    this.upsertMemoryFtsRow(item)
    return item
  }

  getMemoryItemById(id: number): MemoryItem | null {
    const row = this.getDb().prepare('SELECT * FROM memory_items WHERE id = ?').get(id) as MemoryItemRow | undefined
    return row ? toMemoryItem(row) : null
  }

  getMemoryItemByUid(memoryUid: string): MemoryItem | null {
    const row = this.getDb().prepare('SELECT * FROM memory_items WHERE memory_uid = ?').get(memoryUid) as MemoryItemRow | undefined
    return row ? toMemoryItem(row) : null
  }

  listMemoryItems(options: {
    sourceType?: MemorySourceType
    sessionId?: string
    limit?: number
    offset?: number
  } = {}): MemoryItem[] {
    const clauses: string[] = []
    const params: Record<string, unknown> = {}

    if (options.sourceType) {
      clauses.push('source_type = @sourceType')
      params.sourceType = options.sourceType
    }
    if (options.sessionId) {
      clauses.push('session_id = @sessionId')
      params.sessionId = options.sessionId
    }

    const limit = Math.max(1, Math.min(Math.floor(options.limit || 100), 1000))
    const offset = Math.max(0, Math.floor(options.offset || 0))
    params.limit = limit
    params.offset = offset

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.getDb().prepare(`
      SELECT * FROM memory_items
      ${whereSql}
      ORDER BY COALESCE(time_end, time_start, updated_at) DESC, id DESC
      LIMIT @limit OFFSET @offset
    `).all(params) as MemoryItemRow[]
    return rows.map(toMemoryItem)
  }

  countMemoryItems(options: {
    sourceType?: MemorySourceType
    sessionId?: string
  } = {}): number {
    const clauses: string[] = []
    const params: Record<string, unknown> = {}

    if (options.sourceType) {
      clauses.push('source_type = @sourceType')
      params.sourceType = options.sourceType
    }
    if (options.sessionId) {
      clauses.push('session_id = @sessionId')
      params.sessionId = options.sessionId
    }

    const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const row = this.getDb().prepare(`
      SELECT COUNT(*) AS count FROM memory_items
      ${whereSql}
    `).get(params) as { count: number } | undefined
    return Number(row?.count || 0)
  }

  searchMemoryItemsByKeyword(options: MemoryKeywordSearchOptions): MemoryKeywordSearchHit[] {
    const query = String(options.query || '').trim()
    if (!query) return []

    const db = this.getDb()
    const limit = Math.max(1, Math.min(Math.floor(options.limit || 80), 500))
    const rowsById = new Map<number, MemoryKeywordSearchHit>()
    const params: Record<string, unknown> = { limit }
    const filterSql = buildMemoryFilterSql(options, params)
    const ftsQuery = buildMemoryFtsQuery(query)

    if (ftsQuery) {
      const ftsRows = db.prepare(`
        SELECT m.*, bm25(memory_items_fts) AS fts_rank
        FROM memory_items_fts
        JOIN memory_items m ON m.id = memory_items_fts.rowid
        WHERE memory_items_fts MATCH @ftsQuery
          ${filterSql}
        ORDER BY fts_rank ASC, COALESCE(m.time_end, m.time_start, m.updated_at) DESC, m.id DESC
        LIMIT @limit
      `).all({
        ...params,
        ftsQuery
      }) as Array<MemoryItemRow & { fts_rank: number }>

      ftsRows.forEach((row, index) => {
        rowsById.set(Number(row.id), {
          item: toMemoryItem(row),
          rank: index + 1,
          score: Number((1000 + Math.max(0, 100 - Number(row.fts_rank || 0))).toFixed(4)),
          retrievalSource: 'memory_fts'
        })
      })
    }

    const likeParams: Record<string, unknown> = { ...params, likeQuery: `%${query}%` }
    const likeFilterSql = buildMemoryFilterSql(options, likeParams)
    const likeRows = db.prepare(`
      SELECT m.*
      FROM memory_items m
      WHERE (
        m.title LIKE @likeQuery
        OR m.content LIKE @likeQuery
        OR m.entities_json LIKE @likeQuery
        OR m.tags_json LIKE @likeQuery
      )
        ${likeFilterSql}
      ORDER BY COALESCE(m.time_end, m.time_start, m.updated_at) DESC, m.id DESC
      LIMIT @limit
    `).all(likeParams) as MemoryItemRow[]

    let likeRank = 1
    for (const row of likeRows) {
      const id = Number(row.id)
      if (rowsById.has(id)) continue
      rowsById.set(id, {
        item: toMemoryItem(row),
        rank: likeRank,
        score: 500,
        retrievalSource: 'memory_like'
      })
      likeRank += 1
    }

    return Array.from(rowsById.values())
      .sort((a, b) => b.score - a.score || b.item.importance - a.item.importance || b.item.updatedAt - a.item.updatedAt)
      .slice(0, limit)
      .map((hit, index) => ({ ...hit, rank: index + 1 }))
  }

  deleteMemoryItem(id: number): boolean {
    const db = this.getDb()
    db.prepare('DELETE FROM memory_items_fts WHERE rowid = ?').run(id)
    db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id)
    const result = db.prepare('DELETE FROM memory_items WHERE id = ?').run(id)
    return result.changes > 0
  }

  /** 分组（session_id × source_type）超量淘汰：每组按 importance×新近度保留前 cap 条，删其余。返回删除数。 */
  consolidate(capPerGroup = 50): { removed: number; groups: number; scanned: number } {
    const all = this.listMemoryItems({ limit: 1000 })
    const groups = new Map<string, MemoryItem[]>()
    for (const m of all) {
      const key = `${m.sessionId ?? ''}::${m.sourceType}`
      const bucket = groups.get(key)
      if (bucket) bucket.push(m)
      else groups.set(key, [m])
    }
    let removed = 0
    for (const items of groups.values()) {
      if (items.length <= capPerGroup) continue
      const sorted = [...items].sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
      for (const victim of sorted.slice(capPerGroup)) {
        if (this.deleteMemoryItem(victim.id)) removed += 1
      }
    }
    return { removed, groups: groups.size, scanned: all.length }
  }

  // ===== 语义检索：记忆向量（memory_embeddings，Float32 blob，与 messageVectorService 同套存取）=====

  /** 写入/更新某记忆在某嵌入模型下的向量。 */
  upsertMemoryVector(memoryId: number, modelId: string, dim: number, contentHash: string, embedding: Buffer): void {
    this.getDb().prepare(`
      INSERT INTO memory_embeddings (memory_id, model_id, dim, content_hash, embedding, indexed_at)
      VALUES (@memoryId, @modelId, @dim, @contentHash, @embedding, @indexedAt)
      ON CONFLICT(memory_id, model_id) DO UPDATE SET
        dim = excluded.dim,
        content_hash = excluded.content_hash,
        embedding = excluded.embedding,
        indexed_at = excluded.indexed_at
    `).run({ memoryId, modelId, dim, contentHash, embedding, indexedAt: nowMs() })
  }

  /** 某模型下已建向量的元信息（memory_id → {contentHash, dim}），供懒构建判断哪些缺失/过期。 */
  getVectorMeta(modelId: string): Map<number, { contentHash: string; dim: number }> {
    const rows = this.getDb().prepare(
      'SELECT memory_id, content_hash, dim FROM memory_embeddings WHERE model_id = ?'
    ).all(modelId) as Array<{ memory_id: number; content_hash: string; dim: number }>
    const map = new Map<number, { contentHash: string; dim: number }>()
    for (const row of rows) map.set(Number(row.memory_id), { contentHash: row.content_hash, dim: Number(row.dim) })
    return map
  }

  /** 向量 KNN：对候选记忆算 cosine，降序返回 {item, score}。维度不符的旧向量跳过。 */
  searchMemoryVectors(
    queryVec: number[],
    modelId: string,
    opts: { sourceTypes?: MemorySourceType[]; sessionId?: string; limit?: number } = {}
  ): Array<{ item: MemoryItem; score: number }> {
    const db = this.getDb()
    const clauses: string[] = ['e.model_id = @modelId']
    const params: Record<string, unknown> = { modelId }
    if (opts.sessionId) {
      clauses.push('m.session_id = @sessionId')
      params.sessionId = opts.sessionId
    }
    const sourceTypes = Array.from(new Set((opts.sourceTypes || []).filter((t) => MEMORY_SOURCE_TYPES.includes(t))))
    if (sourceTypes.length > 0) {
      const placeholders = sourceTypes.map((_, i) => `@st${i}`)
      sourceTypes.forEach((t, i) => { params[`st${i}`] = t })
      clauses.push(`m.source_type IN (${placeholders.join(', ')})`)
    }
    const rows = db.prepare(`
      SELECT m.*, e.dim AS e_dim, e.embedding AS e_embedding
      FROM memory_embeddings e
      JOIN memory_items m ON m.id = e.memory_id
      WHERE ${clauses.join(' AND ')}
    `).all(params) as Array<MemoryItemRow & { e_dim: number; e_embedding: Buffer }>

    const scored: Array<{ item: MemoryItem; score: number }> = []
    for (const row of rows) {
      if (Number(row.e_dim) !== queryVec.length) continue
      const buf = row.e_embedding
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
      const vec = Array.from(new Float32Array(ab))
      let score = 0
      try {
        score = cosineSimilarity(queryVec, vec)
      } catch {
        continue
      }
      scored.push({ item: toMemoryItem(row), score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, Math.max(1, Math.floor(opts.limit || 10)))
  }

  getStats(): MemoryDatabaseStats {
    const db = this.getDb()
    const itemRow = db.prepare('SELECT COUNT(*) AS count FROM memory_items').get() as { count: number }

    return {
      itemCount: Number(itemRow.count || 0)
    }
  }
}

export const memoryDatabase = new MemoryDatabase()
