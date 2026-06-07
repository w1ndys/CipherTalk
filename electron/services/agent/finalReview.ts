/**
 * Final answer review: a lightweight, no-tools audit pass that can append a short correction
 * before the UI message is finished. It is intentionally fail-open so the main answer is not lost.
 */
import { generateObject } from 'ai'
import { z } from 'zod'
import { createLanguageModel } from './provider'
import type { AgentProviderConfig } from './types'

export type ToolOutputSummary = {
  toolName: string
  error?: string
  mode?: string
  retrieval?: unknown
  counts: Record<string, number>
  matchedBy?: Record<string, number>
  evidence: Array<{
    id?: string
    sessionId?: string
    time?: string
    sender?: string
    text?: string
  }>
}

export type FinalReviewResult = {
  status: 'pass' | 'needs_correction'
  evidenceScore: number
  issues: string[]
  correction?: string
}

const MAX_TOOL_SUMMARIES = 16
const MAX_EVIDENCE_PER_TOOL = 8
const MAX_TEXT = 600

function textOf(value: unknown, max = MAX_TEXT): string | undefined {
  if (value == null) return undefined
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text ? text.slice(0, max) : undefined
}

function countArray(output: Record<string, unknown>, key: string, counts: Record<string, number>) {
  const value = output[key]
  if (Array.isArray(value)) counts[key] = value.length
}

function collectMatchedBy(items: unknown[]): Record<string, number> | undefined {
  const out: Record<string, number> = {}
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const matchedBy = textOf((item as { matchedBy?: unknown }).matchedBy, 40)
    if (!matchedBy) continue
    out[matchedBy] = (out[matchedBy] || 0) + 1
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function summarizeEvidence(items: unknown[]): ToolOutputSummary['evidence'] {
  return items.slice(0, MAX_EVIDENCE_PER_TOOL).map((item) => {
    const it = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    return {
      id: textOf(it.id, 120),
      sessionId: textOf(it.sessionId, 120),
      time: textOf(it.time, 80),
      sender: textOf(it.sender, 80),
      text: textOf(it.text ?? it.excerpt ?? it.content, 260),
    }
  }).filter((item) => item.text || item.id || item.sessionId)
}

export function summarizeToolOutput(toolName: string, output: unknown): ToolOutputSummary {
  const obj = output && typeof output === 'object' && !Array.isArray(output)
    ? output as Record<string, unknown>
    : {}
  const counts: Record<string, number> = {}
  for (const key of ['hits', 'evidence', 'messages', 'memories', 'rows']) countArray(obj, key, counts)

  const hits = Array.isArray(obj.hits) ? obj.hits : []
  const memories = Array.isArray(obj.memories) ? obj.memories : []
  const evidence = Array.isArray(obj.evidence)
    ? summarizeEvidence(obj.evidence)
    : summarizeEvidence(hits.length ? hits : memories)

  return {
    toolName,
    error: textOf(obj.error, 320),
    mode: textOf(obj.mode, 80),
    retrieval: obj.retrieval,
    counts,
    matchedBy: collectMatchedBy(hits.length ? hits : memories),
    evidence,
  }
}

function compactJson(value: unknown, max = 9000): string {
  try {
    const text = JSON.stringify(value, null, 2)
    return text.length > max ? `${text.slice(0, max)}\n...<truncated>` : text
  } catch {
    return '[]'
  }
}

const reviewSchema = z.object({
  status: z.enum(['pass', 'needs_correction']),
  evidenceScore: z.number().min(0).max(1),
  issues: z.array(z.string()).max(5).default([]),
  correction: z.string().optional(),
})

export async function runFinalReview(opts: {
  providerConfig: AgentProviderConfig
  userText: string
  assistantText: string
  toolSummaries: ToolOutputSummary[]
  signal?: AbortSignal
}): Promise<FinalReviewResult> {
  const assistantText = opts.assistantText.trim()
  if (!assistantText || opts.signal?.aborted) {
    return { status: 'pass', evidenceScore: 1, issues: [] }
  }

  try {
    const { object } = await generateObject({
      model: createLanguageModel(opts.providerConfig),
      schema: reviewSchema,
      abortSignal: opts.signal,
      system:
        '你是密语 AI 助手的最终审核器。你不能调用工具，不能重新回答，只检查助手回答是否忠于已给工具证据。' +
        '若回答涉及聊天记录事实但证据不足、把检索摘要当定论、缺少出处、或明显没有满足用户约束，status=needs_correction。' +
        '若只是措辞可优化或答案已经谨慎说明不足，status=pass。correction 必须简短，最多 180 个汉字，只写需要追加给用户的修正/证据不足说明。',
      prompt:
        `用户问题：\n${opts.userText.slice(0, 1200)}\n\n` +
        `助手回答：\n${assistantText.slice(0, 5000)}\n\n` +
        `工具证据摘要：\n${compactJson(opts.toolSummaries.slice(0, MAX_TOOL_SUMMARIES))}`,
    })

    const correction = String(object.correction || '').trim()
    if (object.status === 'needs_correction' && correction) {
      return {
        status: 'needs_correction',
        evidenceScore: object.evidenceScore,
        issues: object.issues || [],
        correction: correction.slice(0, 260),
      }
    }
    return { status: 'pass', evidenceScore: object.evidenceScore, issues: object.issues || [] }
  } catch {
    return { status: 'pass', evidenceScore: 1, issues: [] }
  }
}
