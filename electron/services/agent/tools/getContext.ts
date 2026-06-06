/**
 * get_context —— 按锚点展开某条消息前后的上下文原文，用于核对与标注出处。
 * 锚点来自 search_messages / semantic_search 命中里的 anchor 字段。
 * 读原微信库（经 chatService，子进程内由 wcdb 代理转发到主进程）。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { compactMessage, resolveSenders, type CompactMessage } from './shared'

export const getContext = tool({
  description:
    '展开某条消息前后的上下文原文，用来核对事实、引用出处。' +
    '入参直接用 search_messages / semantic_search 命中结果里的 anchor 字段（sessionId/sortSeq/createTime/localId 原样填）。' +
    '返回锚点前后各若干条消息（时间 + 发送者 + 原文），方便按"时间 + 发送者"标注出处。',
  inputSchema: z.object({
    sessionId: z.string().describe('会话 username（anchor.sessionId）'),
    sortSeq: z.number().describe('锚点 sortSeq（anchor.sortSeq）'),
    createTime: z.number().describe('锚点 createTime（anchor.createTime，原样传入）'),
    localId: z.number().describe('锚点 localId（anchor.localId）'),
    radius: z.number().int().min(1).max(30).default(6).describe('锚点前后各取多少条'),
  }),
  execute: async ({ sessionId, sortSeq, createTime, localId, radius }) => {
    try {
      const { chatService } = await import('../../chatService')
      const [beforeRes, anchorRes, afterRes] = await Promise.all([
        chatService.getMessagesBefore(sessionId, sortSeq, radius, createTime, localId),
        chatService.getMessageByLocalId(sessionId, localId),
        chatService.getMessagesAfter(sessionId, sortSeq, radius, createTime, localId),
      ])

      const collected = [
        ...(beforeRes.success ? beforeRes.messages || [] : []),
        ...(anchorRes.success && anchorRes.message ? [anchorRes.message] : []),
        ...(afterRes.success ? afterRes.messages || [] : []),
      ]

      // 去重 + 按时间升序
      const seen = new Set<string>()
      const ordered = collected
        .filter((m) => {
          const key = `${m.localId}:${m.sortSeq}`
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        .sort((a, b) => a.sortSeq - b.sortSeq || a.createTime - b.createTime || a.localId - b.localId)

      if (ordered.length === 0) {
        return { sessionId, messages: [] as CompactMessage[], note: '未取到上下文（会话可能未加载，或锚点无效）' }
      }

      const senderMap = await resolveSenders(ordered.map((m) => m.senderUsername || ''))
      return {
        sessionId,
        anchorLocalId: localId,
        messages: ordered.map((m) => compactMessage(m, senderMap.get(m.senderUsername || ''))),
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
