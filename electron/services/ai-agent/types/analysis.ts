import { z } from 'zod'

export const MAX_FACT_EVIDENCE_REFS = 3

function toTrimmedString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function toNormalizedScore(value: unknown, fallback: number): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN

  if (!Number.isFinite(numeric)) {
    return fallback
  }

  if (numeric > 1 && numeric <= 100) {
    return Math.max(0, Math.min(1, numeric / 100))
  }

  return Math.max(0, Math.min(1, numeric))
}

function toNormalizedInteger(value: unknown, fallback = 0): number {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number(value)
      : Number.NaN

  if (!Number.isFinite(numeric)) {
    return fallback
  }

  return Math.max(0, Math.floor(numeric))
}

function normalizeTodoStatus(value: unknown): 'open' | 'done' | 'unknown' {
  const text = toTrimmedString(value).toLowerCase()
  if (['done', 'closed', 'completed', 'resolved', 'finished'].includes(text)) return 'done'
  if (['open', 'todo', 'pending', 'active', 'in_progress', 'in-progress'].includes(text)) return 'open'
  return 'unknown'
}

function normalizeRiskSeverity(value: unknown): 'low' | 'medium' | 'high' {
  const text = toTrimmedString(value).toLowerCase()
  if (['low', 'minor'].includes(text)) return 'low'
  if (['high', 'critical', 'major'].includes(text)) return 'high'
  return 'medium'
}

function normalizeBlockEvidenceId(value: unknown): string {
  const raw = typeof value === 'object' && value !== null
    ? toTrimmedString((value as Record<string, unknown>).id ?? (value as Record<string, unknown>).ref ?? (value as Record<string, unknown>).messageId)
    : toTrimmedString(value)

  if (!raw) return ''

  const match = raw.toLowerCase().match(/m\s*0*(\d{1,3})/)
  if (!match) return ''

  return `m${match[1].padStart(3, '0')}`
}

function toEvidenceRefKeyList(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const refs: string[] = []

  for (const item of value) {
    const normalized = normalizeBlockEvidenceId(item)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    refs.push(normalized)
  }

  return refs
}

const stringFieldSchema = z.any().transform(toTrimmedString)
const scoreFieldSchema = z.any().transform((value) => toNormalizedScore(value, 0.5))
const importanceFieldSchema = z.any().transform((value) => toNormalizedScore(value, 0.5))
const integerFieldSchema = z.any().transform((value) => toNormalizedInteger(value, 0))
const extractedEvidenceRefsSchema = z.any().transform(toEvidenceRefKeyList)

const rawExtractedStructuredAnalysisSchema = z.object({
  overview: stringFieldSchema.optional().default(''),
  topics: z.array(z.object({
    name: stringFieldSchema.optional().default(''),
    importance: importanceFieldSchema.optional().default(0.5)
  })).optional().catch([]),
  decisions: z.array(z.object({
    text: stringFieldSchema.optional().default(''),
    confidence: scoreFieldSchema.optional().default(0.5),
    evidenceRefs: extractedEvidenceRefsSchema.optional().default([])
  })).optional().catch([]),
  todos: z.array(z.object({
    owner: stringFieldSchema.optional().default(''),
    task: stringFieldSchema.optional().default(''),
    deadline: stringFieldSchema.optional().default(''),
    status: z.any().transform(normalizeTodoStatus).optional().default('unknown'),
    confidence: scoreFieldSchema.optional().default(0.5),
    evidenceRefs: extractedEvidenceRefsSchema.optional().default([])
  })).optional().catch([]),
  risks: z.array(z.object({
    text: stringFieldSchema.optional().default(''),
    severity: z.any().transform(normalizeRiskSeverity).optional().default('medium'),
    confidence: scoreFieldSchema.optional().default(0.5),
    evidenceRefs: extractedEvidenceRefsSchema.optional().default([])
  })).optional().catch([]),
  events: z.array(z.object({
    text: stringFieldSchema.optional().default(''),
    date: stringFieldSchema.optional().default(''),
    confidence: scoreFieldSchema.optional().default(0.5),
    evidenceRefs: extractedEvidenceRefsSchema.optional().default([])
  })).optional().catch([]),
  openQuestions: z.array(z.object({
    text: stringFieldSchema.optional().default('')
  })).optional().catch([])
}).passthrough()

type RawExtractedStructuredAnalysis = z.infer<typeof rawExtractedStructuredAnalysisSchema>

export interface TopicFact {
  name: string
  importance: number
}

export interface ExtractedDecisionFact {
  text: string
  confidence: number
  evidenceRefs: string[]
}

export interface ExtractedTodoFact {
  owner?: string
  task: string
  deadline?: string
  status: 'open' | 'done' | 'unknown'
  confidence: number
  evidenceRefs: string[]
}

export interface ExtractedRiskFact {
  text: string
  severity: 'low' | 'medium' | 'high'
  confidence: number
  evidenceRefs: string[]
}

export interface ExtractedEventFact {
  text: string
  date?: string
  confidence: number
  evidenceRefs: string[]
}

export interface OpenQuestionFact {
  text: string
}

export interface ExtractedStructuredAnalysis {
  overview: string
  topics: TopicFact[]
  decisions: ExtractedDecisionFact[]
  todos: ExtractedTodoFact[]
  risks: ExtractedRiskFact[]
  events: ExtractedEventFact[]
  openQuestions: OpenQuestionFact[]
}

export interface SummaryEvidenceRef {
  sessionId: string
  localId: number
  createTime: number
  sortSeq: number
  senderUsername?: string
  senderDisplayName?: string
  previewText: string
}

export interface DecisionFact {
  text: string
  confidence: number
  evidenceRefs: SummaryEvidenceRef[]
}

export interface TodoFact {
  owner?: string
  task: string
  deadline?: string
  status: 'open' | 'done' | 'unknown'
  confidence: number
  evidenceRefs: SummaryEvidenceRef[]
}

export interface RiskFact {
  text: string
  severity: 'low' | 'medium' | 'high'
  confidence: number
  evidenceRefs: SummaryEvidenceRef[]
}

export interface EventFact {
  text: string
  date?: string
  confidence: number
  evidenceRefs: SummaryEvidenceRef[]
}

export interface StructuredAnalysis {
  overview: string
  topics: TopicFact[]
  decisions: DecisionFact[]
  todos: TodoFact[]
  risks: RiskFact[]
  events: EventFact[]
  openQuestions: OpenQuestionFact[]
}

export interface StandardizedAnalysisMessage {
  messageKey: string
  localId: number
  createTime: number
  sortSeq: number
  sender: string
  senderUsername?: string
  messageType: string
  content: string
  formattedLine: string
  charCount: number
}

export interface AnalysisBlock {
  blockId: string
  index: number
  messages: StandardizedAnalysisMessage[]
  renderedText: string
  messageCount: number
  charCount: number
  startTime: number
  endTime: number
}

function sanitizeExtractedStructuredAnalysis(input: RawExtractedStructuredAnalysis): ExtractedStructuredAnalysis {
  return {
    overview: input.overview || '',
    topics: input.topics
      .map((item) => ({
        name: item.name,
        importance: item.importance
      }))
      .filter((item) => item.name),
    decisions: input.decisions
      .map((item) => ({
        text: item.text,
        confidence: item.confidence,
        evidenceRefs: item.evidenceRefs.slice(0, MAX_FACT_EVIDENCE_REFS)
      }))
      .filter((item) => item.text),
    todos: input.todos
      .map((item) => ({
        owner: item.owner || undefined,
        task: item.task,
        deadline: item.deadline || undefined,
        status: item.status,
        confidence: item.confidence,
        evidenceRefs: item.evidenceRefs.slice(0, MAX_FACT_EVIDENCE_REFS)
      }))
      .filter((item) => item.task),
    risks: input.risks
      .map((item) => ({
        text: item.text,
        severity: item.severity,
        confidence: item.confidence,
        evidenceRefs: item.evidenceRefs.slice(0, MAX_FACT_EVIDENCE_REFS)
      }))
      .filter((item) => item.text),
    events: input.events
      .map((item) => ({
        text: item.text,
        date: item.date || undefined,
        confidence: item.confidence,
        evidenceRefs: item.evidenceRefs.slice(0, MAX_FACT_EVIDENCE_REFS)
      }))
      .filter((item) => item.text),
    openQuestions: input.openQuestions
      .map((item) => ({ text: item.text }))
      .filter((item) => item.text)
  }
}

export function stripExtractedEvidenceRefs(analysis: ExtractedStructuredAnalysis): StructuredAnalysis {
  return {
    overview: analysis.overview,
    topics: analysis.topics.map((item) => ({ ...item })),
    decisions: analysis.decisions.map((item) => ({
      text: item.text,
      confidence: item.confidence,
      evidenceRefs: []
    })),
    todos: analysis.todos.map((item) => ({
      owner: item.owner,
      task: item.task,
      deadline: item.deadline,
      status: item.status,
      confidence: item.confidence,
      evidenceRefs: []
    })),
    risks: analysis.risks.map((item) => ({
      text: item.text,
      severity: item.severity,
      confidence: item.confidence,
      evidenceRefs: []
    })),
    events: analysis.events.map((item) => ({
      text: item.text,
      date: item.date,
      confidence: item.confidence,
      evidenceRefs: []
    })),
    openQuestions: analysis.openQuestions.map((item) => ({ ...item }))
  }
}

const summaryEvidenceRefSchema = z.object({
  sessionId: stringFieldSchema.optional().default(''),
  localId: integerFieldSchema.optional().default(0),
  createTime: integerFieldSchema.optional().default(0),
  sortSeq: integerFieldSchema.optional().default(0),
  senderUsername: stringFieldSchema.optional().default(''),
  senderDisplayName: stringFieldSchema.optional().default(''),
  previewText: stringFieldSchema.optional().default('')
}).transform((item) => ({
  sessionId: item.sessionId,
  localId: item.localId,
  createTime: item.createTime,
  sortSeq: item.sortSeq,
  senderUsername: item.senderUsername || undefined,
  senderDisplayName: item.senderDisplayName || undefined,
  previewText: item.previewText
} satisfies SummaryEvidenceRef))

const storedStructuredAnalysisSchema = z.object({
  overview: stringFieldSchema.optional().default(''),
  topics: z.array(z.object({
    name: stringFieldSchema.optional().default(''),
    importance: importanceFieldSchema.optional().default(0.5)
  })).optional().catch([]),
  decisions: z.array(z.object({
    text: stringFieldSchema.optional().default(''),
    confidence: scoreFieldSchema.optional().default(0.5),
    evidenceRefs: z.array(summaryEvidenceRefSchema).optional().catch([])
  })).optional().catch([]),
  todos: z.array(z.object({
    owner: stringFieldSchema.optional().default(''),
    task: stringFieldSchema.optional().default(''),
    deadline: stringFieldSchema.optional().default(''),
    status: z.any().transform(normalizeTodoStatus).optional().default('unknown'),
    confidence: scoreFieldSchema.optional().default(0.5),
    evidenceRefs: z.array(summaryEvidenceRefSchema).optional().catch([])
  })).optional().catch([]),
  risks: z.array(z.object({
    text: stringFieldSchema.optional().default(''),
    severity: z.any().transform(normalizeRiskSeverity).optional().default('medium'),
    confidence: scoreFieldSchema.optional().default(0.5),
    evidenceRefs: z.array(summaryEvidenceRefSchema).optional().catch([])
  })).optional().catch([]),
  events: z.array(z.object({
    text: stringFieldSchema.optional().default(''),
    date: stringFieldSchema.optional().default(''),
    confidence: scoreFieldSchema.optional().default(0.5),
    evidenceRefs: z.array(summaryEvidenceRefSchema).optional().catch([])
  })).optional().catch([]),
  openQuestions: z.array(z.object({
    text: stringFieldSchema.optional().default('')
  })).optional().catch([])
}).transform((input) => ({
  overview: input.overview,
  topics: input.topics
    .map((item) => ({
      name: item.name,
      importance: item.importance
    }))
    .filter((item) => item.name),
  decisions: input.decisions
    .map((item) => ({
      text: item.text,
      confidence: item.confidence,
      evidenceRefs: item.evidenceRefs
    }))
    .filter((item) => item.text),
  todos: input.todos
    .map((item) => ({
      owner: item.owner || undefined,
      task: item.task,
      deadline: item.deadline || undefined,
      status: item.status,
      confidence: item.confidence,
      evidenceRefs: item.evidenceRefs
    }))
    .filter((item) => item.task),
  risks: input.risks
    .map((item) => ({
      text: item.text,
      severity: item.severity,
      confidence: item.confidence,
      evidenceRefs: item.evidenceRefs
    }))
    .filter((item) => item.text),
  events: input.events
    .map((item) => ({
      text: item.text,
      date: item.date || undefined,
      confidence: item.confidence,
      evidenceRefs: item.evidenceRefs
    }))
    .filter((item) => item.text),
  openQuestions: input.openQuestions
    .map((item) => ({ text: item.text }))
    .filter((item) => item.text)
}) satisfies StructuredAnalysis)

export const extractedStructuredAnalysisSchema: z.ZodType<ExtractedStructuredAnalysis> = rawExtractedStructuredAnalysisSchema
  .transform((input) => sanitizeExtractedStructuredAnalysis(input))

export function parseStoredStructuredAnalysis(value: unknown): StructuredAnalysis | undefined {
  if (!value) {
    return undefined
  }

  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value
    const result = storedStructuredAnalysisSchema.safeParse(parsed)
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}
