/**
 * 长期记忆工具 —— remember / recall（L2 用户级语义记忆，Letta/LangMem 式「agent 自编辑」范式）。
 *
 * agent 在 ReAct 循环里自己决定记什么、查什么，写进 agent_memory.db 的 memory_items（FTS 关键词检索）。
 * 只存稳定的「用户画像 profile」与「长期事实 fact」，带 importance；高重要度的会在下次开场注入系统提示。
 * 复用 memoryDatabase 现成读写层——子进程经 ConfigService + better-sqlite3 直连 app 派生库（同 messageVectorService）。
 * 故意只挂在主 Agent（buildTools），子 Agent（delegate）不带，避免子任务乱写记忆。
 */
import { tool, generateObject } from 'ai'
import { z } from 'zod'
import type { AgentScope, AgentProviderConfig } from '../types'
import type { MemoryItem } from '../../memory/memorySchema'
import { memoryDatabase, hashMemoryContent } from '../../memory/memoryDatabase'
import { createLanguageModel } from '../provider'
import { embedQuery, embedTexts, getEmbeddingConfig, type EmbeddingConfig } from '../../ai/embeddingService'
import { reciprocalRankFusion } from '../../retrieval/rrf'

/** 开场注入的画像/会话事实条数上限；先取 SCAN_LIMIT 再按 importance 排序截断。 */
const INJECT_PROFILE_LIMIT = 10
const INJECT_FACT_LIMIT = 10
const SCAN_LIMIT = 50

function memoryUid(title: string, content: string): string {
  return `mem-${hashMemoryContent(title, content).slice(0, 16)}`
}

/** about 缺省回退：当前已 @ 某会话则归到该会话，否则不限定（关于用户本人）。 */
function resolveAbout(about: string | undefined, scope: AgentScope): string | null {
  const explicit = String(about || '').trim()
  if (explicit) return explicit
  if (scope.kind === 'session') return scope.sessionId
  return null
}

/** recall 走语义检索的两类记忆。 */
const VECTOR_KINDS: Array<'profile' | 'fact'> = ['profile', 'fact']

function isEmbeddingReady(cfg: EmbeddingConfig): boolean {
  return !!(cfg.enabled && cfg.apiKey && cfg.model)
}

/** 懒构建：给缺向量 / 内容已变 / 维度不符的记忆补嵌入（限定 scope 与 recall 一致）。失败由调用方兜底回退关键词。 */
async function ensureMemoryVectors(cfg: EmbeddingConfig, sessionId: string | null): Promise<void> {
  const items = memoryDatabase
    .listMemoryItems({ ...(sessionId ? { sessionId } : {}), limit: 1000 })
    .filter((m) => m.sourceType === 'profile' || m.sourceType === 'fact')
  if (items.length === 0) return
  const meta = memoryDatabase.getVectorMeta(cfg.model)
  const stale = items.filter((m) => {
    const v = meta.get(m.id)
    return !v || v.contentHash !== m.contentHash || (cfg.dimension > 0 && v.dim !== cfg.dimension)
  })
  if (stale.length === 0) return
  const BATCH = 64
  for (let i = 0; i < stale.length; i += BATCH) {
    const batch = stale.slice(i, i + BATCH)
    const vectors = await embedTexts(batch.map((m) => m.content), cfg)
    batch.forEach((m, idx) => {
      const vec = vectors[idx]
      if (!vec || vec.length === 0) return
      memoryDatabase.upsertMemoryVector(m.id, cfg.model, vec.length, m.contentHash, Buffer.from(Float32Array.from(vec).buffer))
    })
  }
}

function formatRecall(items: MemoryItem[], mode: 'keyword' | 'hybrid') {
  return {
    mode,
    count: items.length,
    memories: items.map((m) => ({
      id: m.id,
      kind: m.sourceType,
      content: m.content,
      about: m.sessionId,
      importance: m.importance,
      tags: m.tags,
    })),
  }
}

export function createRemember(scope: AgentScope) {
  return tool({
    description:
      '记住一条关于用户的长期记忆，跨对话保留（下次开场会注入高重要度记忆）。' +
      '只在用户透露稳定的偏好/身份/重要关系或事实时用（如"我是产品经理""我女朋友叫小美""老王是我室友"）；' +
      '一次性、琐碎、或能直接从聊天记录查到的别记。记之前可先用 recall 查是否已记过，避免重复。',
    inputSchema: z.object({
      content: z.string().min(1).describe('要记住的事实，一句话写清'),
      kind: z.enum(['profile', 'fact']).default('fact')
        .describe('profile=关于用户本人的画像/偏好；fact=其它长期事实（含关于某联系人）'),
      about: z.string().optional().describe('这条记忆关于谁（联系人/会话 username）；不填且当前已 @ 某会话则默认归到该会话'),
      importance: z.number().min(0).max(1).default(0.5).describe('重要度 0~1，越高越会在开场被注入系统提示'),
      tags: z.array(z.string()).optional().describe('可选标签，便于检索'),
    }),
    execute: async ({ content, kind, about, importance, tags }) => {
      try {
        const text = content.trim()
        const title = text.slice(0, 40)
        const sessionId = resolveAbout(about, scope)
        const item = memoryDatabase.upsertMemoryItem({
          memoryUid: memoryUid(title, text),
          sourceType: kind,
          sessionId,
          contactId: sessionId,
          title,
          content: text,
          importance,
          tags: tags || [],
        })
        return { remembered: true, id: item.id, kind: item.sourceType, importance: item.importance, about: sessionId }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

export function createRecall(scope: AgentScope) {
  return tool({
    description:
      '检索你记过的长期记忆（用户画像/偏好/长期事实）。回答涉及用户个人情况、偏好、长期关系时先查一下。',
    inputSchema: z.object({
      query: z.string().min(1).describe('检索意图/关键词'),
      about: z.string().optional().describe('限定关于某联系人/会话 username；不填且已 @ 某会话则默认该会话'),
      limit: z.number().int().min(1).max(30).default(10).describe('返回条数上限'),
    }),
    execute: async ({ query, about, limit }) => {
      try {
        const sessionId = resolveAbout(about, scope)
        const filter = { ...(sessionId ? { sessionId } : {}), sourceTypes: VECTOR_KINDS }
        // 关键词路：始终算（也作为向量不可用时的回退）
        const keywordHits = memoryDatabase.searchMemoryItemsByKeyword({ query, ...filter, limit: limit * 2 })

        const cfg = getEmbeddingConfig()
        if (isEmbeddingReady(cfg)) {
          try {
            await ensureMemoryVectors(cfg, sessionId)
            const queryVec = await embedQuery(query, cfg)
            const vectorHits = memoryDatabase.searchMemoryVectors(queryVec, cfg.model, { ...filter, limit: limit * 2 })
            if (vectorHits.length > 0) {
              // 向量 + 关键词按排名 RRF 融合（key=记忆 id）
              const merged = reciprocalRankFusion<MemoryItem>(
                [
                  vectorHits.map((h, i) => ({ item: h.item, rank: i + 1 })),
                  keywordHits.map((h, i) => ({ item: h.item, rank: i + 1 })),
                ],
                (item) => String(item.id),
              )
              return formatRecall(merged.slice(0, limit).map((m) => m.item), 'hybrid')
            }
          } catch {
            /* 向量任一步失败（未建/API 错）→ 落回关键词 */
          }
        }
        return formatRecall(keywordHits.slice(0, limit).map((h) => h.item), 'keyword')
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

export function createListMemories(scope: AgentScope) {
  return tool({
    description:
      '列出已记的长期记忆（按范围/类型浏览，不带检索词）。用于盘点、整理前查看；要按内容找用 recall。',
    inputSchema: z.object({
      about: z.string().optional().describe('限定关于某联系人/会话 username；不填且已 @ 某会话则默认该会话'),
      kind: z.enum(['profile', 'fact']).optional().describe('只看某类；不填两类都列'),
      limit: z.number().int().min(1).max(100).default(30).describe('返回条数上限'),
    }),
    execute: async ({ about, kind, limit }) => {
      try {
        const sessionId = resolveAbout(about, scope)
        const items = memoryDatabase.listMemoryItems({
          ...(kind ? { sourceType: kind } : {}),
          ...(sessionId ? { sessionId } : {}),
          limit,
        })
        return {
          count: items.length,
          memories: items.map((m) => ({
            id: m.id,
            kind: m.sourceType,
            content: m.content,
            about: m.sessionId,
            importance: m.importance,
            tags: m.tags,
          })),
        }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

export function createForget() {
  return tool({
    description:
      '删除一条过时或记错的长期记忆（id 来自 recall / list_memories）。' +
      '用户纠正"我已经不是…了 / 那条记错了"时，先 forget 旧的再 remember 新的。',
    inputSchema: z.object({
      id: z.number().int().describe('要删除的记忆 id（来自 recall / list_memories）'),
    }),
    execute: async ({ id }) => {
      try {
        const ok = memoryDatabase.deleteMemoryItem(id)
        return ok ? { forgotten: true, id } : { forgotten: false, id, reason: '未找到该记忆' }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

export function createConsolidate() {
  return tool({
    description:
      '整理记忆：按"关于谁 × 类型"分组，每组只保留最重要的若干条，删掉低价值冗余，防止记忆库越积越乱。' +
      '记了很多条、或用户让你"整理一下记忆"时调用。',
    inputSchema: z.object({}),
    execute: async () => {
      try {
        // 确定性巩固：分组超量淘汰，逻辑在 memoryDatabase（IPC 管理界面共用）。语义合并（需 LLM）留后续。
        return memoryDatabase.consolidate()
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}

/** 读高重要度长期记忆拼成系统提示片段；无记忆返回空串，读失败不影响 agent。 */
export async function buildMemoryContext(scope: AgentScope): Promise<string> {
  try {
    const profiles = memoryDatabase
      .listMemoryItems({ sourceType: 'profile', limit: SCAN_LIMIT })
      .sort((a, b) => b.importance - a.importance)
      .slice(0, INJECT_PROFILE_LIMIT)

    const facts = scope.kind === 'session'
      ? memoryDatabase
          .listMemoryItems({ sourceType: 'fact', sessionId: scope.sessionId, limit: SCAN_LIMIT })
          .sort((a, b) => b.importance - a.importance)
          .slice(0, INJECT_FACT_LIMIT)
      : []

    if (profiles.length === 0 && facts.length === 0) return ''

    const lines = [...profiles, ...facts].map((m) => `- ${m.content.slice(0, 120)}`)
    return `\n\n# 你记住的长期记忆\n以下是你在过往对话中记下的、关于用户的长期记忆，回答时可参考；若与当前对话冲突，以当前对话为准。需要更多细节用 recall 检索。\n${lines.join('\n')}`
  } catch {
    return ''
  }
}

// ============ L1 自动来源：一轮对话结束后从对话里抽取稳定事实，自动写入 ============

const AUTO_MEMORY_MAX = 5
/** 自动抽取的记忆 confidence 低于主动 remember（默认 1），标记其来源不如用户明说可靠。 */
const AUTO_MEMORY_CONFIDENCE = 0.6
const AUTO_MEMORY_MIN_USER_CHARS = 6

export interface AutoMemoryResult {
  id: number
  content: string
  kind: 'profile' | 'fact'
  importance: number
}

/**
 * L1：用一次 LLM 调用从本轮对话抽取「关于用户的稳定事实/偏好」，自动写入（confidence=0.6，tags=['auto']）。
 * 抽取前把已记内容塞进 prompt 让模型别重复；upsert 按 uid=hash 幂等挡完全重复。失败返回 []（不影响主回答）。
 */
export async function extractMemories(opts: {
  scope: AgentScope
  providerConfig: AgentProviderConfig
  userText: string
  assistantText: string
  signal?: AbortSignal
}): Promise<AutoMemoryResult[]> {
  const { scope, providerConfig, userText, assistantText, signal } = opts
  if (userText.trim().length < AUTO_MEMORY_MIN_USER_CHARS) return []

  try {
    const sessionId = scope.kind === 'session' ? scope.sessionId : null
    const existing = memoryDatabase
      .listMemoryItems({ ...(sessionId ? { sessionId } : {}), limit: 30 })
      .map((m) => m.content)
    const known = existing.length
      ? `\n\n已记过的（不要重复抽取）：\n${existing.map((c) => `- ${c}`).join('\n')}`
      : ''

    const { object } = await generateObject({
      model: createLanguageModel(providerConfig),
      schema: z.object({
        memories: z
          .array(
            z.object({
              content: z.string().describe('一句话写清的稳定长期事实/偏好'),
              kind: z.enum(['profile', 'fact']),
              importance: z.number().min(0).max(1),
            }),
          )
          .max(AUTO_MEMORY_MAX),
      }),
      abortSignal: signal,
      system:
        '你从对话中抽取「关于用户本人的、值得长期记住的稳定事实/偏好」（身份、职业、长期偏好、重要关系）。' +
        '只抽用户明确陈述过的，不要推断、不要抽一次性或琐碎信息。没有可抽的就返回空数组。',
      prompt: `对话：\n用户：${userText}\n助手：${assistantText}${known}`,
    })

    const out: AutoMemoryResult[] = []
    for (const m of object.memories) {
      const content = m.content.trim()
      if (!content) continue
      const title = content.slice(0, 40)
      const item = memoryDatabase.upsertMemoryItem({
        memoryUid: memoryUid(title, content),
        sourceType: m.kind,
        sessionId,
        contactId: sessionId,
        title,
        content,
        importance: m.importance,
        confidence: AUTO_MEMORY_CONFIDENCE,
        tags: ['auto'],
      })
      out.push({ id: item.id, content, kind: m.kind, importance: item.importance })
    }
    return out
  } catch {
    return []
  }
}
