/**
 * 文本处理工具函数
 */
import { MAX_MESSAGE_TEXT } from '../types'

/**
 * 压缩文本到指定长度，去除多余空白
 */
export function compactText(value?: string, limit = MAX_MESSAGE_TEXT): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

/**
 * 过滤流式 chunk 中的 <think> 标签
 */
export function filterThinkChunk(chunk: string, state: { isThinking: boolean }): string {
  let remaining = chunk
  let visible = ''

  while (remaining.length > 0) {
    if (state.isThinking) {
      const closeIndex = remaining.indexOf('</think>')
      if (closeIndex < 0) {
        break
      }

      state.isThinking = false
      remaining = remaining.slice(closeIndex + '</think>'.length)
      continue
    }

    const openIndex = remaining.indexOf('<think>')
    if (openIndex < 0) {
      visible += remaining
      break
    }

    visible += remaining.slice(0, openIndex)
    state.isThinking = true
    remaining = remaining.slice(openIndex + '<think>'.length)
  }

  return visible
}

/**
 * 移除文本中所有 <think>...</think> 块
 */
export function stripThinkBlocks(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

/**
 * 移除 JSON 代码围栏
 */
export function stripJsonFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

/**
 * 判断值是否为 Record 对象
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 限制工具参数数值到合理范围
 */
export function clampToolLimit(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(Math.floor(parsed), max))
}

/**
 * 限制 token 预算到合理范围
 */
export function clampTokenBudget(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(Math.floor(parsed), max))
}

/**
 * 规范化字符串数组，去重并限制长度
 */
export function normalizeStringArray(value: unknown, limit = 4): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    const text = compactText(String(item || ''), 48)
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
    if (result.length >= limit) break
  }
  return result
}

/**
 * 去重并限制紧凑查询数组
 */
export function uniqueCompactQueries(values: Array<string | undefined>, limit: number, maxLength: number): string[] {
  const seen = new Set<string>()
  const queries: string[] = []
  for (const value of values) {
    const query = compactText(String(value || ''), maxLength)
    const key = query.toLowerCase()
    if (!query || seen.has(key)) continue
    seen.add(key)
    queries.push(query)
    if (queries.length >= limit) break
  }
  return queries
}
