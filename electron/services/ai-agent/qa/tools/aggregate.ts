/**
 * 消息聚合工具
 */
import type { McpMessageItem } from '../../../mcp/types'
import type { ToolLoopAction } from '../types'
import { dedupeMessagesByCursor, describeSender, formatMessageLine } from '../utils/message'
import { formatTime } from '../utils/time'

export function aggregateMessages(messages: McpMessageItem[], metric: Extract<ToolLoopAction, { action: 'aggregate_messages' }>['metric'] = 'summary'): string {
  const unique = dedupeMessagesByCursor(messages)
  if (unique.length === 0) return '没有可聚合的消息。'

  const speakerCounts = new Map<string, number>()
  const kindCounts = new Map<string, number>()
  const dayCounts = new Map<string, number>()

  for (const message of unique) {
    const speaker = describeSender(message)
    speakerCounts.set(speaker, (speakerCounts.get(speaker) || 0) + 1)
    kindCounts.set(message.kind, (kindCounts.get(message.kind) || 0) + 1)
    const day = formatTime(message.timestampMs).slice(0, 10)
    dayCounts.set(day, (dayCounts.get(day) || 0) + 1)
  }

  const formatTop = (map: Map<string, number>, limit = 8) => Array.from(map.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => `${name}: ${count}`)
    .join('；')

  const first = unique[0]
  const last = unique[unique.length - 1]
  const samples = unique.filter((m) => m.text).slice(0, 8).map(formatMessageLine).join('\n')

  if (metric === 'speaker_count') return `消息数：${unique.length}\n发言排行：${formatTop(speakerCounts)}\n时间范围：${formatTime(first.timestampMs)} - ${formatTime(last.timestampMs)}`
  if (metric === 'message_count') return `消息数：${unique.length}\n按日期：${formatTop(dayCounts, 10)}\n时间范围：${formatTime(first.timestampMs)} - ${formatTime(last.timestampMs)}`
  if (metric === 'kind_count') return `消息数：${unique.length}\n消息类型：${formatTop(kindCounts)}`
  if (metric === 'timeline') return `消息数：${unique.length}\n按日期：${formatTop(dayCounts, 10)}\n代表消息：\n${samples || '无文本消息。'}`
  return `消息数：${unique.length}\n时间范围：${formatTime(first.timestampMs)} - ${formatTime(last.timestampMs)}\n发言分布：${formatTop(speakerCounts)}\n消息类型：${formatTop(kindCounts)}\n代表消息：\n${samples || '无文本消息。'}`
}
