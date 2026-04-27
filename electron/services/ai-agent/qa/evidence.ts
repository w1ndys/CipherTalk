/**
 * 证据质量评估和搜索失败诊断
 */
import type {
  ContextWindow,
  EvidenceQuality,
  KnownSearchHit,
  SearchFailureReason,
  SearchPayloadWithQuery,
  SessionQAIntentType,
  ToolObservation
} from './types'
import type { McpSearchMessagesPayload } from '../../mcp/types'
import { compactText } from './utils/text'
import { formatCursor, formatMessageLine, getMessageCursorKey } from './utils/message'
import type { ToolLoopAction } from './types'

/**
 * 评估当前证据质量
 */
export function assessEvidenceQuality(input: {
  searchPayloads: SearchPayloadWithQuery[]
  contextWindows: ContextWindow[]
  summaryFactsRead: boolean
  aggregateText?: string
  intent: SessionQAIntentType
}): EvidenceQuality {
  const summaryHasFacts = input.summaryFactsRead
  const aggregateText = compactText(input.aggregateText || '', 120)
  const aggregateHasFacts = Boolean(aggregateText) && !/^没有可聚合的消息/.test(aggregateText)
  const totalSearchHits = input.searchPayloads.reduce((sum, item) => sum + item.payload.hits.length, 0)
  const totalContextMessages = input.contextWindows.reduce((sum, window) => sum + window.messages.length, 0)
  const hasSearchHits = totalSearchHits > 0
  const hasContext = totalContextMessages > 0

  if (!summaryHasFacts && !aggregateHasFacts && !hasSearchHits && !hasContext) {
    return 'none'
  }

  const needsSearchEvidence = input.intent === 'exact_evidence'
    || input.intent === 'media_or_file'
    || input.intent === 'stats_or_count'

  if (needsSearchEvidence) {
    if (hasSearchHits && totalSearchHits >= 2) return 'sufficient'
    if (hasSearchHits || aggregateHasFacts) return 'weak'
    if (summaryHasFacts && !hasSearchHits) return 'weak'
    return hasContext ? 'weak' : 'none'
  }

  if (summaryHasFacts || aggregateHasFacts) return 'sufficient'
  if (hasSearchHits) return 'sufficient'
  if (hasContext) return 'weak'
  return 'none'
}

/**
 * 判断是否所有搜索均为确定性失败（内容不存在）
 */
export function hasConclusiveSearchFailure(searchPayloads: SearchPayloadWithQuery[]): boolean {
  return searchPayloads.length > 0
    && searchPayloads.every((item) =>
      item.payload.hits.length === 0
      && interpretSearchFailure(item.payload).reason === 'content_not_found'
    )
}

/**
 * 描述向量检索跳过原因
 */
export function describeVectorSkipReason(reason?: string): string {
  if (!reason) return '原因未知'

  const labels: Record<string, string> = {
    exact_match_mode: '精确匹配模式',
    empty_semantic_query: '语义查询为空',
    vector_provider_unavailable: '向量能力不可用',
    vector_index_incomplete: '向量索引未完成',
    indexed_search_unavailable: '本地索引不可用，已回退扫描',
    search_index_not_ready: '搜索索引未就绪，已回退扫描'
  }

  return reason
    .split(',')
    .map((item) => labels[item] || item)
    .join('、')
}

/**
 * 解释搜索失败原因
 */
export function interpretSearchFailure(payload?: McpSearchMessagesPayload): {
  reason: SearchFailureReason
  suggestion: string
} {
  if (!payload) {
    return {
      reason: 'keyword_miss_only',
      suggestion: '换更短的关键词重试'
    }
  }

  const vector = payload.vectorSearch

  if (vector?.attempted) {
    if (vector.error) {
      return {
        reason: 'vector_unavailable',
        suggestion: `向量检索执行异常（${compactText(vector.error, 80)}），建议换关键词或改用按时间范围读取`
      }
    }

    if (vector.hitCount === 0) {
      return {
        reason: 'content_not_found',
        suggestion: '关键词和语义检索均无命中，内容可能确实不存在，建议直接回答证据不足'
      }
    }
  }

  if (!vector?.attempted && vector?.skippedReason) {
    return {
      reason: 'vector_unavailable',
      suggestion: `向量索引未可用（${describeVectorSkipReason(vector.skippedReason)}），建议换关键词或改用按时间范围读取`
    }
  }

  return {
    reason: 'keyword_miss_only',
    suggestion: '仅关键词未命中，可尝试更短或同义词'
  }
}

/**
 * 格式化向量搜索诊断行
 */
export function formatVectorSearchLine(payload?: McpSearchMessagesPayload): string {
  const vector = payload?.vectorSearch
  if (!vector) return '向量索引：无诊断信息'

  const progress = vector.indexedMessages > 0
    ? `，向量化 ${vector.vectorizedMessages}/${vector.indexedMessages} 条`
    : ''
  const model = vector.model ? `，模型 ${vector.model}` : ''
  if (vector.attempted) {
    const error = vector.error ? `，错误：${compactText(vector.error, 80)}` : ''
    return `向量索引：已调用，语义命中 ${vector.hitCount} 条${progress}${model}${error}`
  }

  if (vector.requested) {
    return `向量索引：未调用，${describeVectorSkipReason(vector.skippedReason)}${progress}${model}`
  }

  return '向量索引：未请求'
}

/**
 * 获取搜索诊断信息
 */
export function getSearchDiagnostics(payload?: McpSearchMessagesPayload): string[] {
  if (!payload) return []

  const lines = [
    `检索来源：${payload.source || 'unknown'}`,
    formatVectorSearchLine(payload)
  ]

  if (payload.indexStatus) {
    lines.push(`关键词索引：${payload.indexStatus.ready ? '已使用' : '未使用'}，已索引 ${payload.indexStatus.indexedMessages} 条`)
  }

  return lines
}

/**
 * 格式化已知命中
 */
export function formatKnownHit(hit: KnownSearchHit): string {
  const source = hit.retrievalSource ? ` | source=${hit.retrievalSource}` : ''
  return `${hit.hitId} | ${formatMessageLine(hit.message)} | score=${Math.round(hit.score)}${source} | cursor=${formatCursor(hit.message.cursor)}`
}

/**
 * 构建观察文本
 */
export function buildObservationText(observations: ToolObservation[]): string {
  if (observations.length === 0) return '暂无工具观察。'

  return observations
    .slice(-10)
    .map((item, index) => `${index + 1}. ${item.title}\n${item.detail}`)
    .join('\n\n')
}

/**
 * 构建已知命中文本
 */
export function buildKnownHitsText(hits: KnownSearchHit[]): string {
  if (hits.length === 0) return '暂无命中。'
  return hits.slice(0, 16).map(formatKnownHit).join('\n')
}

/**
 * 汇总搜索结果观察
 */
export function summarizeSearchObservation(query: string, payload?: McpSearchMessagesPayload, knownHits: KnownSearchHit[] = []): string {
  const hits = payload?.hits || []
  const diagnostics = getSearchDiagnostics(payload)
  if (hits.length === 0) {
    const failure = interpretSearchFailure(payload)
    return [
      `关键词：${query}，命中 0 条。`,
      `失败原因：${failure.reason}`,
      `建议：${failure.suggestion}`,
      diagnostics.length ? diagnostics.join('\n') : ''
    ].filter(Boolean).join('\n')
  }

  const latestKnown = knownHits.slice(-Math.min(hits.length, 8))
  const lines = latestKnown.map(formatKnownHit).join('\n')
  return `关键词：${query}，命中 ${hits.length} 条。${diagnostics.length ? `\n${diagnostics.join('\n')}` : ''}\n${lines}`
}

/**
 * 查找已知命中（用于 read_context）
 */
export function findKnownHitForAction(action: Extract<ToolLoopAction, { action: 'read_context' }>, knownHits: KnownSearchHit[]): KnownSearchHit | null {
  if (action.hitId) {
    const exact = knownHits.find((hit) => hit.hitId.toLowerCase() === action.hitId!.toLowerCase())
    if (exact) return exact
  }

  if (action.cursor) {
    return knownHits.find((hit) =>
      hit.message.cursor.localId === action.cursor!.localId
      && hit.message.cursor.createTime === action.cursor!.createTime
      && hit.message.cursor.sortSeq === action.cursor!.sortSeq
    ) || null
  }

  return knownHits[0] || null
}
