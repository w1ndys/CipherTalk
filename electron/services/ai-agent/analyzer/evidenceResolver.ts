import type {
  ExtractedDecisionFact,
  ExtractedEventFact,
  ExtractedRiskFact,
  ExtractedStructuredAnalysis,
  ExtractedTodoFact,
  StandardizedAnalysisMessage,
  StructuredAnalysis,
  SummaryEvidenceRef
} from '../types/analysis'
import { MAX_FACT_EVIDENCE_REFS, stripExtractedEvidenceRefs } from '../types/analysis'

const MAX_PREVIEW_CHARS = 120

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text
  }

  return `${text.slice(0, maxChars - 3).trimEnd()}...`
}

function normalizeInlineText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\n+/g, ' ')
    .trim()
}

function buildPreviewText(message: StandardizedAnalysisMessage): string {
  const baseContent = normalizeInlineText(message.content)
  if (baseContent) {
    if (message.messageType === '文本') {
      return truncateText(baseContent, MAX_PREVIEW_CHARS)
    }

    return truncateText(`[${message.messageType}] ${baseContent}`, MAX_PREVIEW_CHARS)
  }

  return truncateText(normalizeInlineText(message.formattedLine), MAX_PREVIEW_CHARS)
}

function buildEvidenceRef(sessionId: string, message: StandardizedAnalysisMessage): SummaryEvidenceRef {
  return {
    sessionId,
    localId: message.localId,
    createTime: message.createTime,
    sortSeq: message.sortSeq,
    senderUsername: message.senderUsername || undefined,
    senderDisplayName: message.sender || undefined,
    previewText: buildPreviewText(message)
  }
}

function resolveEvidenceRefs(
  evidenceKeys: string[],
  messageIndex: Map<string, { message: StandardizedAnalysisMessage; order: number }>,
  sessionId: string
): SummaryEvidenceRef[] {
  const resolved = evidenceKeys
    .map((key) => {
      const entry = messageIndex.get(key)
      return entry
        ? {
            order: entry.order,
            ref: buildEvidenceRef(sessionId, entry.message)
          }
        : null
    })
    .filter((item): item is { order: number; ref: SummaryEvidenceRef } => Boolean(item))

  resolved.sort((a, b) => a.order - b.order)

  const seen = new Set<string>()
  const refs: SummaryEvidenceRef[] = []

  for (const item of resolved) {
    const dedupeKey = `${item.ref.localId}:${item.ref.createTime}:${item.ref.sortSeq}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)
    refs.push(item.ref)
    if (refs.length >= MAX_FACT_EVIDENCE_REFS) {
      break
    }
  }

  return refs
}

function resolveDecisionFacts(
  items: ExtractedDecisionFact[],
  messageIndex: Map<string, { message: StandardizedAnalysisMessage; order: number }>,
  sessionId: string
): StructuredAnalysis['decisions'] {
  return items
    .map((item) => ({
      text: item.text,
      confidence: item.confidence,
      evidenceRefs: resolveEvidenceRefs(item.evidenceRefs, messageIndex, sessionId)
    }))
    .filter((item) => item.text && item.evidenceRefs.length > 0)
}

function resolveTodoFacts(
  items: ExtractedTodoFact[],
  messageIndex: Map<string, { message: StandardizedAnalysisMessage; order: number }>,
  sessionId: string
): StructuredAnalysis['todos'] {
  return items
    .map((item) => ({
      owner: item.owner,
      task: item.task,
      deadline: item.deadline,
      status: item.status,
      confidence: item.confidence,
      evidenceRefs: resolveEvidenceRefs(item.evidenceRefs, messageIndex, sessionId)
    }))
    .filter((item) => item.task && item.evidenceRefs.length > 0)
}

function resolveRiskFacts(
  items: ExtractedRiskFact[],
  messageIndex: Map<string, { message: StandardizedAnalysisMessage; order: number }>,
  sessionId: string
): StructuredAnalysis['risks'] {
  return items
    .map((item) => ({
      text: item.text,
      severity: item.severity,
      confidence: item.confidence,
      evidenceRefs: resolveEvidenceRefs(item.evidenceRefs, messageIndex, sessionId)
    }))
    .filter((item) => item.text && item.evidenceRefs.length > 0)
}

function resolveEventFacts(
  items: ExtractedEventFact[],
  messageIndex: Map<string, { message: StandardizedAnalysisMessage; order: number }>,
  sessionId: string
): StructuredAnalysis['events'] {
  return items
    .map((item) => ({
      text: item.text,
      date: item.date,
      confidence: item.confidence,
      evidenceRefs: resolveEvidenceRefs(item.evidenceRefs, messageIndex, sessionId)
    }))
    .filter((item) => item.text && item.evidenceRefs.length > 0)
}

export function resolveStructuredAnalysisEvidence(
  analysis: ExtractedStructuredAnalysis,
  standardizedMessages: StandardizedAnalysisMessage[],
  sessionId: string
): StructuredAnalysis {
  const messageIndex = new Map<string, { message: StandardizedAnalysisMessage; order: number }>()

  standardizedMessages.forEach((message, index) => {
    messageIndex.set(message.messageKey, { message, order: index })
  })

  return {
    overview: analysis.overview,
    topics: analysis.topics.map((item) => ({ ...item })),
    decisions: resolveDecisionFacts(analysis.decisions, messageIndex, sessionId),
    todos: resolveTodoFacts(analysis.todos, messageIndex, sessionId),
    risks: resolveRiskFacts(analysis.risks, messageIndex, sessionId),
    events: resolveEventFacts(analysis.events, messageIndex, sessionId),
    openQuestions: analysis.openQuestions.map((item) => ({ ...item }))
  }
}

export function fallbackStructuredAnalysisWithoutEvidence(
  analysis: ExtractedStructuredAnalysis
): StructuredAnalysis {
  return stripExtractedEvidenceRefs(analysis)
}
