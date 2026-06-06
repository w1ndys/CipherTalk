/**
 * search_messages —— 精确关键词检索（全文匹配派生库 memory_items）。
 * 命中里带 anchor（消息锚点），可交给 get_context 展开原文核对、标注出处。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { toLocalTime } from './shared'

export const searchMessages = tool({
  description:
    '按精确关键词检索聊天记录（全文匹配），适合"谁提过 X / 搜含某个词的消息 / 找某件具体的事"。' +
    '每条命中带 anchor 字段（消息锚点），拿到后用 get_context 展开前后原文来核对、引用。' +
    '想找"语义相似 / 某主题大概聊了啥"用 semantic_search；要数量/排名/频率用统计；' +
    '限定某人/某群时先用 list_contacts 拿 username 填进 sessionId。',
  inputSchema: z.object({
    query: z.string().describe('关键词，可多个词用空格分隔'),
    sessionId: z.string().optional().describe('限定某会话/群（username，来自 list_contacts）'),
    startTimeMs: z.number().optional().describe('起始时间，毫秒时间戳'),
    endTimeMs: z.number().optional().describe('结束时间，毫秒时间戳'),
    limit: z.number().int().min(1).max(50).default(10).describe('返回条数上限'),
  }),
  execute: async ({ query, sessionId, startTimeMs, endTimeMs, limit }) => {
    try {
      const { memoryDatabase } = await import('../../memory/memoryDatabase')
      const hits = memoryDatabase.searchMemoryItemsByKeyword({ query, sessionId, startTimeMs, endTimeMs, limit })
      return hits.map((hit) => {
        const item = hit.item
        const ref = item.sourceRefs?.[0]
        return {
          sessionId: item.sessionId,
          title: item.title,
          excerpt: item.content.slice(0, 300),
          time: toLocalTime(item.timeEnd ?? item.timeStart),
          matchSource: hit.retrievalSource, // memory_fts（全文）/ memory_like（模糊）
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
