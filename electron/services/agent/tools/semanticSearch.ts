/**
 * semantic_search —— 语义/混合检索工具。execute 直接调现有 retrievalEngine（不重写）。
 * 骨架阶段 retrievalEngine 仍是关键词版（FTS+LIKE+RRF）；向量上线后自动生效（Phase D）。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { toLocalTime } from './shared'

export const semanticSearch = tool({
  description:
    '按语义相似度查找相关会话片段，适合"聊过类似 X 吗 / 某主题都说了啥"这类需要理解含义的问题。' +
    '每条命中带 anchor 字段（消息锚点），拿到后用 get_context 展开前后原文核对、标注出处。' +
    '可用 sessionId / 时间范围先缩小范围。精确关键词请用 search_messages；要数量/排名/频率请用统计。',
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
      return result.hits.map((hit) => {
        const ref = hit.memory.sourceRefs?.[0]
        return {
          sessionId: hit.memory.sessionId,
          title: hit.memory.title,
          excerpt: hit.memory.content.slice(0, 300),
          time: toLocalTime(hit.memory.timeEnd ?? hit.memory.timeStart),
          anchor: ref
            ? { sessionId: ref.sessionId, localId: ref.localId, sortSeq: ref.sortSeq, createTime: ref.createTime }
            : null,
        }
      })
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
