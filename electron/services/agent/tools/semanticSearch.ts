/**
 * semantic_search —— 语义/混合检索工具。execute 直接调现有 retrievalEngine（不重写）。
 * 骨架阶段 retrievalEngine 仍是关键词版（FTS+LIKE+RRF）；向量上线后自动生效（Phase D）。
 */
import { tool } from 'ai'
import { z } from 'zod'

export const semanticSearch = tool({
  description:
    '按语义相似度查找相关会话片段，适合"聊过类似 X 吗 / 某主题都说了啥"这类需要理解含义的问题。' +
    '可用 sessionId / 时间范围先缩小范围。精确关键词请用 search_messages；数量/排名/总和请用 chat_stats。',
  inputSchema: z.object({
    query: z.string().describe('自然语言检索意图'),
    sessionId: z.string().optional().describe('限定会话 id'),
    startTimeMs: z.number().optional().describe('起始时间（毫秒时间戳）'),
    endTimeMs: z.number().optional().describe('结束时间（毫秒时间戳）'),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  execute: async (args) => {
    try {
      const { retrievalEngine } = await import('../../retrieval/retrievalEngine')
      const result = await retrievalEngine.search(args)
      return result.hits.map((hit) => ({
        sessionId: hit.memory.sessionId,
        title: hit.memory.title,
        excerpt: hit.memory.content.slice(0, 300),
        time: hit.memory.timeEnd ?? hit.memory.timeStart,
        evidenceCount: hit.evidence.length,
      }))
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
