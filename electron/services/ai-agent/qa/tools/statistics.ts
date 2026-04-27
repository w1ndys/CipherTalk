/**
 * 统计工具：会话统计和关键词统计
 */
import { executeMcpTool } from '../../../mcp/dispatcher'
import type { McpSessionStatisticsPayload, McpKeywordStatisticsPayload, McpMessagesPayload, McpMessageItem } from '../../../mcp/types'
import type { SessionQAToolCall, ToolLoopAction, TimeRangeHint } from '../types'
import { formatTime } from '../utils/time'

function formatParticipantStatsLines(items: McpSessionStatisticsPayload['participantRankings']): string {
  if (!items.length) return '无参与者统计。'
  return items.slice(0, 12).map((item, index) =>
    `${index + 1}. ${item.displayName || item.senderUsername || item.role}：${item.messageCount} 条（发出 ${item.sentCount}，收到 ${item.receivedCount}）`
  ).join('\n')
}

export function formatSessionStatisticsText(payload: McpSessionStatisticsPayload): string {
  const kindCounts = Object.entries(payload.kindCounts).sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind}=${count}`).join('，') || '无'
  const activeHours = Object.entries(payload.hourlyDistribution).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([hour, count]) => `${hour}时=${count}`).join('，') || '无'
  return [
    `会话统计：${payload.session.displayName}`,
    `总消息 ${payload.totalMessages} 条，发出 ${payload.sentMessages} 条，收到 ${payload.receivedMessages} 条，活跃 ${payload.activeDays} 天。`,
    `首条：${payload.firstMessageTime ? formatTime(payload.firstMessageTime * 1000) : '无'}；末条：${payload.lastMessageTime ? formatTime(payload.lastMessageTime * 1000) : '无'}。`,
    `消息类型：${kindCounts}。`, `最活跃小时：${activeHours}。`,
    `发言排行：\n${formatParticipantStatsLines(payload.participantRankings)}`,
    `扫描 ${payload.scannedMessages} 条，范围内匹配 ${payload.matchedMessages} 条${payload.truncated ? '，结果因扫描上限被截断' : ''}。`
  ].join('\n')
}

export function formatKeywordStatisticsText(payload: McpKeywordStatisticsPayload): string {
  const lines = payload.keywords.map((item) => {
    const topParticipants = item.participantRankings.slice(0, 5).map((p) => `${p.displayName || p.senderUsername || p.role}=${p.messageCount}`).join('，') || '无'
    const activeHours = Object.entries(item.hourlyDistribution).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([hour, count]) => `${hour}时=${count}`).join('，') || '无'
    return [`关键词"${item.keyword}"：命中 ${item.hitCount} 条消息，出现 ${item.occurrenceCount} 次。`, `首次：${item.firstHitTime ? formatTime(item.firstHitTime * 1000) : '无'}；末次：${item.lastHitTime ? formatTime(item.lastHitTime * 1000) : '无'}。`, `发送者分布：${topParticipants}。`, `高频小时：${activeHours}。`].join('\n')
  })
  return [`关键词统计：${payload.session.displayName}`, ...lines, `扫描 ${payload.scannedMessages} 条，命中 ${payload.matchedMessages} 条${payload.truncated ? '，结果因扫描上限被截断' : ''}。`].join('\n\n')
}

export async function loadSessionStatistics(sessionId: string, action: Extract<ToolLoopAction, { action: 'get_session_statistics' }>, fallbackRange?: TimeRangeHint): Promise<{ payload?: McpSessionStatisticsPayload; toolCall?: SessionQAToolCall }> {
  const args = { sessionId, startTime: action.startTime || fallbackRange?.startTime, endTime: action.endTime || fallbackRange?.endTime, includeSamples: action.includeSamples || false, participantLimit: action.participantLimit || 20 }
  const result = await executeMcpTool('get_session_statistics', args)
  const payload = result.payload as McpSessionStatisticsPayload
  return { payload, toolCall: { toolName: 'get_session_statistics', args, summary: formatSessionStatisticsText(payload), status: payload.totalMessages > 0 ? 'completed' : 'failed', evidenceCount: payload.totalMessages } }
}

export async function loadKeywordStatistics(sessionId: string, action: Extract<ToolLoopAction, { action: 'get_keyword_statistics' }>, fallbackRange?: TimeRangeHint): Promise<{ payload?: McpKeywordStatisticsPayload; toolCall?: SessionQAToolCall }> {
  const args = { sessionId, keywords: action.keywords, startTime: action.startTime || fallbackRange?.startTime, endTime: action.endTime || fallbackRange?.endTime, matchMode: action.matchMode || 'substring', participantLimit: action.participantLimit || 20 }
  const result = await executeMcpTool('get_keyword_statistics', args)
  const payload = result.payload as McpKeywordStatisticsPayload
  return { payload, toolCall: { toolName: 'get_keyword_statistics', args, summary: formatKeywordStatisticsText(payload), status: payload.matchedMessages > 0 ? 'completed' : 'failed', evidenceCount: payload.matchedMessages } }
}

export async function loadMessagesByTimeRange(sessionId: string, input: { startTime?: number; endTime?: number; keyword?: string; senderUsername?: string; limit?: number; order?: 'asc' | 'desc' }): Promise<{ payload?: McpMessagesPayload; toolCall?: SessionQAToolCall }> {
  const args = { sessionId, offset: 0, limit: input.limit || 80, order: input.order || 'asc', includeRaw: false, ...(input.startTime ? { startTime: input.startTime } : {}), ...(input.endTime ? { endTime: input.endTime } : {}), ...(input.keyword ? { keyword: input.keyword } : {}) }
  const result = await executeMcpTool('get_messages', args)
  const payload = (result.payload || { items: [], offset: 0, limit: input.limit || 80, hasMore: false }) as McpMessagesPayload
  const items = input.senderUsername ? (payload.items || []).filter((m) => m.sender.username === input.senderUsername) : payload.items || []
  return { payload: { ...payload, items, limit: input.limit || payload.limit }, toolCall: { toolName: 'read_by_time_range', args: { ...args, ...(input.senderUsername ? { senderUsername: input.senderUsername } : {}) }, summary: result.summary } }
}

export async function loadMessagesByTimeRangeAll(sessionId: string, input: { startTime?: number; endTime?: number; senderUsername?: string; keyword?: string; maxMessages?: number }): Promise<McpMessageItem[]> {
  const limit = 200
  const maxMessages = Math.max(limit, Math.min(input.maxMessages || 10000, 20000))
  const items: McpMessageItem[] = []
  let offset = 0
  while (items.length < maxMessages) {
    const result = await executeMcpTool('get_messages', { sessionId, offset, limit, order: 'asc', includeRaw: false, ...(input.startTime ? { startTime: input.startTime } : {}), ...(input.endTime ? { endTime: input.endTime } : {}), ...(input.keyword ? { keyword: input.keyword } : {}) })
    const payload = result.payload as McpMessagesPayload
    const pageItems = input.senderUsername ? (payload.items || []).filter((m) => m.sender.username === input.senderUsername) : payload.items || []
    items.push(...pageItems)
    if (!payload.hasMore || (payload.items || []).length === 0) break
    offset += limit
  }
  return items.slice(0, maxMessages)
}
