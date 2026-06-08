/**
 * 消息向量存储与检索（纯 AI SDK：embedMany 建向量 + cosineSimilarity 算 KNN，无原生扩展）。
 *
 * 嵌入单位是「会话片段」而非单条消息：微信消息又碎又短，单条嵌入语义稀薄、跨多轮的话题召不回，
 * 故把连续消息按「字符预算 + 最大条数 + 时间间隔」切成片段，对每个片段嵌一个向量。
 *
 * - 文本来源：复用 chatSearchIndexService 已建的 message_index（listSessionMemoryMessages）。
 * - 存储：片段向量当 Float32 blob 存进独立的 chat_vectors.db（better-sqlite3，cachePath）。
 * - 检索：embedQuery(query) → 取候选片段向量 → cosineSimilarity 排序取 top-K（跳过维度不符的旧向量）。
 * - 懒构建 + 增量 + 上限：首次对某会话语义检索时切最近 N 条成片段，之后只补新增（按高水位定位）。
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'
import { cosineSimilarity } from 'ai'
import { ConfigService } from '../config'
import { chatSearchIndexService } from './chatSearchIndexService'
import { embedTexts, embedQuery, getEmbeddingConfig, type EmbeddingConfig } from '../ai/embeddingService'
import { voiceTranscribeService } from '../voiceTranscribeService'

const VECTOR_DB_NAME = 'chat_vectors.db'
const DEFAULT_SESSION_CAP = 1500 // 每个会话首次最多纳入的（最近）消息条数，控制成本/时延
const EMBED_BATCH = 64           // 每批嵌入的片段数
const CHUNK_MAX_CHARS = 600      // 单个片段的合并文本字符预算（多轮上下文，又不至于稀释向量）
const CHUNK_MAX_MSGS = 15        // 单个片段最多容纳的消息条数
const CHUNK_GAP_SECONDS = 20 * 60 // 相邻消息间隔超过此值视为新一段对话，断开
const EMBED_TEXT_CAP = 1000      // 喂给嵌入模型的片段文本硬上限（防超长消息撑爆）

export interface VectorHit {
  sessionId: string
  time: number // create_time（秒）
  isSend: number | null
  senderUsername: string | null
  excerpt: string
  score: number
  startSortSeq: number // 片段覆盖的 sort_seq 区间，供混合检索按区间去重
  endSortSeq: number
  anchor: { sessionId: string; localId: number; sortSeq: number; createTime: number }
}

interface SessionMessage {
  localId: number
  sortSeq: number
  createTime: number
  localType: number
  isSend: number | null
  senderUsername: string | null
  parsedContent: string
}

interface BuiltChunk {
  startLocalId: number
  endLocalId: number
  startSortSeq: number
  endSortSeq: number
  createTime: number       // 片段末条 create_time（秒），展示/衰减用
  anchorLocalId: number    // get_context 锚点：取片段中点，±radius 可对称覆盖
  anchorSortSeq: number
  anchorCreateTime: number
  anchorIsSend: number | null
  anchorSender: string | null
  msgCount: number
  embedText: string
  excerpt: string
}

export type VectorBuildStage = 'loading' | 'chunking' | 'embedding' | 'done'

export interface VectorBuildProgress {
  sessionId: string
  stage: VectorBuildStage
  current: number
  total: number
  indexed: number
  message: string
}

export interface VectorStoreInfo {
  dbPath: string
  exists: boolean
  sizeBytes: number
  updatedAtMs: number | null
  count: number
  dimensions: number[]
}

type VectorBuildProgressReporter = (progress: VectorBuildProgress) => void

/** 把连续消息切成会话片段（字符预算 / 最大条数 / 时间间隔三者任一触发即断开）。 */
function buildChunks(messages: SessionMessage[]): BuiltChunk[] {
  const chunks: BuiltChunk[] = []
  let group: SessionMessage[] = []
  let chars = 0

  const flush = () => {
    if (group.length === 0) return
    const first = group[0]
    const last = group[group.length - 1]
    const mid = group[Math.floor(group.length / 2)]
    const joined = group.map((m) => m.parsedContent.trim()).filter(Boolean).join('\n')
    chunks.push({
      startLocalId: first.localId,
      endLocalId: last.localId,
      startSortSeq: first.sortSeq,
      endSortSeq: last.sortSeq,
      createTime: last.createTime,
      anchorLocalId: mid.localId,
      anchorSortSeq: mid.sortSeq,
      anchorCreateTime: mid.createTime,
      anchorIsSend: mid.isSend ?? null,
      anchorSender: mid.senderUsername ?? null,
      msgCount: group.length,
      embedText: joined.slice(0, EMBED_TEXT_CAP),
      excerpt: joined.replace(/\s+/g, ' ').trim().slice(0, 240),
    })
    group = []
    chars = 0
  }

  for (const m of messages) {
    const text = m.parsedContent.trim()
    if (!text) continue
    if (group.length > 0) {
      const gap = m.createTime - group[group.length - 1].createTime
      if (chars + text.length > CHUNK_MAX_CHARS || group.length >= CHUNK_MAX_MSGS || gap > CHUNK_GAP_SECONDS) {
        flush()
      }
    }
    group.push(m)
    chars += text.length
  }
  flush()
  return chunks
}

class MessageVectorService {
  private db: Database.Database | null = null
  private dbPath: string | null = null

  private getCacheBasePath(): string {
    const cs = new ConfigService()
    try {
      const cachePath = String(cs.get('cachePath') || '').trim()
      return cachePath || join(process.cwd(), 'cache')
    } finally {
      cs.close()
    }
  }

  private getDb(): Database.Database {
    const base = this.getCacheBasePath()
    if (!existsSync(base)) mkdirSync(base, { recursive: true })
    const next = join(base, VECTOR_DB_NAME)
    if (this.db && this.dbPath === next) return this.db
    if (this.db) {
      try { this.db.close() } catch { /* ignore */ }
    }
    const db = new Database(next)
    db.pragma('journal_mode = WAL')
    db.exec(`
      DROP TABLE IF EXISTS message_vectors;  -- 旧的 per-message 表已废弃（粒度改为片段）
      CREATE TABLE IF NOT EXISTS message_chunks (
        session_id         TEXT NOT NULL,
        start_local_id     INTEGER NOT NULL,
        end_local_id       INTEGER NOT NULL,
        start_sort_seq     INTEGER NOT NULL,
        end_sort_seq       INTEGER NOT NULL,
        create_time        INTEGER NOT NULL,
        anchor_local_id    INTEGER NOT NULL,
        anchor_sort_seq    INTEGER NOT NULL,
        anchor_create_time INTEGER NOT NULL,
        is_send            INTEGER,
        sender_username    TEXT,
        msg_count          INTEGER NOT NULL,
        excerpt            TEXT,
        dim                INTEGER NOT NULL,
        embedding          BLOB NOT NULL,
        PRIMARY KEY (session_id, end_local_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mc_session ON message_chunks(session_id);
    `)
    this.db = db
    this.dbPath = next
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

  /** 已启用且配置完整才可用。 */
  isReady(cfg?: EmbeddingConfig): boolean {
    const c = cfg || getEmbeddingConfig()
    return !!(c.enabled && c.apiKey && c.model)
  }

  private countChunks(db: Database.Database, sessionId: string): number {
    return (db.prepare('SELECT COUNT(*) AS c FROM message_chunks WHERE session_id = ?').get(sessionId) as { c: number }).c
  }

  /** 某会话已建的片段向量数（0 = 未建）。供 UI 显示向量化状态。 */
  getSessionChunkCount(sessionId: string): number {
    return this.countChunks(this.getDb(), sessionId)
  }

  /** 当前向量库的落盘位置与某会话的存储证据。 */
  getSessionVectorStoreInfo(sessionId: string): VectorStoreInfo {
    const db = this.getDb()
    const dbPath = this.dbPath || join(this.getCacheBasePath(), VECTOR_DB_NAME)
    const stat = existsSync(dbPath) ? statSync(dbPath) : null
    const rows = db.prepare(
      'SELECT dim, COUNT(*) AS c FROM message_chunks WHERE session_id = ? GROUP BY dim ORDER BY dim'
    ).all(sessionId) as Array<{ dim: number; c: number }>

    return {
      dbPath,
      exists: !!stat,
      sizeBytes: stat?.size || 0,
      updatedAtMs: stat?.mtimeMs || null,
      count: rows.reduce((sum, row) => sum + row.c, 0),
      dimensions: rows.map((row) => row.dim),
    }
  }

  /**
   * 确保某会话的片段向量已就绪（懒构建 + 增量）。返回该会话已存片段数。
   */
  async ensureSessionVectors(
    sessionId: string,
    cfg: EmbeddingConfig,
    cap = DEFAULT_SESSION_CAP,
    onProgress?: VectorBuildProgressReporter,
  ): Promise<number> {
    onProgress?.({ sessionId, stage: 'loading', current: 0, total: 0, indexed: 0, message: '读取会话消息' })
    const rawMessages = await chatSearchIndexService.listSessionMemoryMessages(sessionId)
    if (rawMessages.length === 0) {
      onProgress?.({ sessionId, stage: 'done', current: 0, total: 0, indexed: 0, message: '没有可向量化的消息' })
      return 0
    }
    const messages: SessionMessage[] = rawMessages.map((m) => {
      const transcript = Number(m.localType) === 34
        ? voiceTranscribeService.getCachedTranscript(sessionId, m.createTime) || undefined
        : undefined
      return {
        localId: m.localId,
        sortSeq: m.sortSeq,
        createTime: m.createTime,
        localType: m.localType,
        isSend: m.isSend,
        senderUsername: m.senderUsername,
        parsedContent: transcript || m.parsedContent,
      }
    })
    const db = this.getDb()
    const existingCount = this.countChunks(db, sessionId)

    // 高水位：上次已嵌入到的片段末尾位置（按 sort_seq + local_id 定位，兼容 sort_seq 并列）
    const last = db.prepare(
      'SELECT end_sort_seq AS s, end_local_id AS l FROM message_chunks WHERE session_id = ? ORDER BY end_sort_seq DESC, end_local_id DESC LIMIT 1'
    ).get(sessionId) as { s: number; l: number } | undefined

    const pending: SessionMessage[] = last
      ? messages.filter((m) => m.sortSeq > last.s || (m.sortSeq === last.s && m.localId > last.l))
      : messages.slice(-cap)
    if (pending.length === 0) {
      onProgress?.({ sessionId, stage: 'done', current: 0, total: 0, indexed: existingCount, message: '语义索引已是最新' })
      return existingCount
    }

    onProgress?.({ sessionId, stage: 'chunking', current: 0, total: pending.length, indexed: existingCount, message: '切分会话片段' })
    const chunks = buildChunks(pending)
    if (chunks.length === 0) {
      onProgress?.({ sessionId, stage: 'done', current: 0, total: 0, indexed: existingCount, message: '没有可向量化的文本片段' })
      return existingCount
    }
    onProgress?.({ sessionId, stage: 'embedding', current: 0, total: chunks.length, indexed: existingCount, message: '生成向量' })

    const insert = db.prepare(
      `INSERT OR REPLACE INTO message_chunks
       (session_id, start_local_id, end_local_id, start_sort_seq, end_sort_seq, create_time,
        anchor_local_id, anchor_sort_seq, anchor_create_time, is_send, sender_username,
        msg_count, excerpt, dim, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH)
      const vectors = await embedTexts(batch.map((c) => c.embedText), cfg)
      const write = db.transaction(() => {
        batch.forEach((c, idx) => {
          const vec = vectors[idx]
          if (!vec || vec.length === 0) return
          const buf = Buffer.from(Float32Array.from(vec).buffer)
          insert.run(
            sessionId, c.startLocalId, c.endLocalId, c.startSortSeq, c.endSortSeq, c.createTime,
            c.anchorLocalId, c.anchorSortSeq, c.anchorCreateTime, c.anchorIsSend, c.anchorSender,
            c.msgCount, c.excerpt, vec.length, buf
          )
        })
      })
      write()
      const current = Math.min(i + batch.length, chunks.length)
      onProgress?.({
        sessionId,
        stage: current >= chunks.length ? 'done' : 'embedding',
        current,
        total: chunks.length,
        indexed: this.countChunks(db, sessionId),
        message: current >= chunks.length ? '语义索引已完成' : '生成向量',
      })
    }
    return this.countChunks(db, sessionId)
  }

  /** 在某会话已存片段里做 KNN（cosineSimilarity 排序，跳过维度不符的旧向量）。 */
  searchSession(sessionId: string, queryVec: number[], limit: number): VectorHit[] {
    const db = this.getDb()
    const rows = db.prepare(
      `SELECT anchor_local_id, anchor_sort_seq, anchor_create_time, create_time,
              start_sort_seq, end_sort_seq, is_send, sender_username, excerpt, dim, embedding
       FROM message_chunks WHERE session_id = ?`
    ).all(sessionId) as Array<{
      anchor_local_id: number; anchor_sort_seq: number; anchor_create_time: number; create_time: number
      start_sort_seq: number; end_sort_seq: number
      is_send: number | null; sender_username: string | null; excerpt: string; dim: number; embedding: Buffer
    }>

    const scored: Array<{ r: (typeof rows)[number]; score: number }> = []
    for (const r of rows) {
      if (r.dim !== queryVec.length) continue // 换过嵌入模型/维度的旧向量直接跳过，避免静默 0 分污染
      const ab = r.embedding.buffer.slice(r.embedding.byteOffset, r.embedding.byteOffset + r.embedding.byteLength)
      const vec = Array.from(new Float32Array(ab))
      let score = 0
      try {
        score = cosineSimilarity(queryVec, vec)
      } catch {
        continue
      }
      scored.push({ r, score })
    }
    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, limit).map(({ r, score }) => ({
      sessionId,
      time: r.create_time,
      isSend: r.is_send,
      senderUsername: r.sender_username,
      excerpt: r.excerpt,
      score,
      startSortSeq: r.start_sort_seq,
      endSortSeq: r.end_sort_seq,
      anchor: { sessionId, localId: r.anchor_local_id, sortSeq: r.anchor_sort_seq, createTime: r.anchor_create_time },
    }))
  }
}

export const messageVectorService = new MessageVectorService()

/** 供查询侧复用：嵌入查询文本。 */
export { embedQuery }
