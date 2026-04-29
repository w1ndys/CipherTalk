/**
 * 时间推理和格式化工具
 */
import type { TimeRangeHint } from '../types'

/**
 * 格式化时间戳为可读字符串
 */
export function formatTime(timestampMs: number): string {
  if (!timestampMs) return 'unknown'
  const date = new Date(timestampMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

/**
 * 将时间戳统一转换为毫秒
 */
export function toTimestampMs(timestamp: number): number {
  if (!timestamp) return 0
  return timestamp > 10_000_000_000 ? timestamp : timestamp * 1000
}

/**
 * 转换为 Unix 秒级时间戳
 */
export function toUnixSeconds(value: Date): number {
  return Math.floor(value.getTime() / 1000)
}

function startOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(0, 0, 0, 0)
  return next
}

function endOfDay(date: Date): Date {
  const next = new Date(date)
  next.setHours(23, 59, 59, 999)
  return next
}

function shiftDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function rangeLastMinutes(now: Date, minutes: number, label: string): TimeRangeHint {
  const start = new Date(now)
  start.setMinutes(start.getMinutes() - minutes)
  return {
    startTime: toUnixSeconds(start),
    endTime: toUnixSeconds(now),
    label
  }
}

function rangeLastHours(now: Date, hours: number, label: string): TimeRangeHint {
  const start = new Date(now)
  start.setHours(start.getHours() - hours)
  return {
    startTime: toUnixSeconds(start),
    endTime: toUnixSeconds(now),
    label
  }
}

/**
 * 根据问题中的时段词细化时间范围
 */
function applyDayPart(range: TimeRangeHint, question: string): TimeRangeHint {
  if (!range.startTime || !range.endTime) return range
  const start = new Date(range.startTime * 1000)
  const end = new Date(range.startTime * 1000)
  let matched = false

  if (/(凌晨|半夜)/.test(question)) {
    start.setHours(0, 0, 0, 0)
    end.setHours(5, 59, 59, 999)
    matched = true
  } else if (/早上|上午/.test(question)) {
    start.setHours(6, 0, 0, 0)
    end.setHours(11, 59, 59, 999)
    matched = true
  } else if (/中午/.test(question)) {
    start.setHours(11, 0, 0, 0)
    end.setHours(13, 59, 59, 999)
    matched = true
  } else if (/下午/.test(question)) {
    start.setHours(12, 0, 0, 0)
    end.setHours(17, 59, 59, 999)
    matched = true
  } else if (/晚上|夜里/.test(question)) {
    start.setHours(18, 0, 0, 0)
    end.setHours(23, 59, 59, 999)
    matched = true
  }

  if (!matched) return range
  return {
    ...range,
    startTime: toUnixSeconds(start),
    endTime: toUnixSeconds(end),
    label: `${range.label || '指定日期'}${question.match(/凌晨|半夜|早上|上午|中午|下午|晚上|夜里/)?.[0] || ''}`
  }
}

/**
 * 从自然语言问题中推断时间范围
 */
export function inferTimeRangeFromQuestion(question: string, now = new Date()): TimeRangeHint | undefined {
  const normalized = question.replace(/\s+/g, '')
  let range: TimeRangeHint | undefined

  if (/刚刚|刚才|方才|刚聊|刚说|刚发|刚问/.test(normalized)) {
    range = rangeLastMinutes(now, 30, '刚才30分钟')
  } else if (/不久前|这会儿|方才/.test(normalized)) {
    range = rangeLastHours(now, 1, '最近1小时')
  } else if (/最近|近来|当前|现在|最新/.test(normalized)) {
    range = rangeLastHours(now, 24, '最近24小时')
  } else if (/前天/.test(normalized)) {
    const date = shiftDays(now, -2)
    range = { startTime: toUnixSeconds(startOfDay(date)), endTime: toUnixSeconds(endOfDay(date)), label: '前天' }
  } else if (/昨天|昨日/.test(normalized)) {
    const date = shiftDays(now, -1)
    range = { startTime: toUnixSeconds(startOfDay(date)), endTime: toUnixSeconds(endOfDay(date)), label: '昨天' }
  } else if (/今天|今日/.test(normalized)) {
    range = { startTime: toUnixSeconds(startOfDay(now)), endTime: toUnixSeconds(endOfDay(now)), label: '今天' }
  } else if (/上周/.test(normalized)) {
    const day = now.getDay() || 7
    const thisMonday = shiftDays(startOfDay(now), 1 - day)
    const lastMonday = shiftDays(thisMonday, -7)
    const lastSunday = shiftDays(lastMonday, 6)
    range = { startTime: toUnixSeconds(lastMonday), endTime: toUnixSeconds(endOfDay(lastSunday)), label: '上周' }
  } else if (/本周|这周/.test(normalized)) {
    const day = now.getDay() || 7
    const thisMonday = shiftDays(startOfDay(now), 1 - day)
    range = { startTime: toUnixSeconds(thisMonday), endTime: toUnixSeconds(endOfDay(now)), label: '本周' }
  } else if (/上个月|上月/.test(normalized)) {
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
    range = { startTime: toUnixSeconds(start), endTime: toUnixSeconds(end), label: '上个月' }
  } else if (/这个月|本月/.test(normalized)) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1)
    range = { startTime: toUnixSeconds(start), endTime: toUnixSeconds(endOfDay(now)), label: '本月' }
  }

  const dateMatch = normalized.match(/(\d{1,2})[月/-](\d{1,2})[日号]?/)
  if (!range && dateMatch) {
    const month = Number(dateMatch[1])
    const day = Number(dateMatch[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(now.getFullYear(), month - 1, day)
      range = { startTime: toUnixSeconds(startOfDay(date)), endTime: toUnixSeconds(endOfDay(date)), label: `${month}月${day}日` }
    }
  }

  return range ? applyDayPart(range, question) : undefined
}

/**
 * 格式化时间范围标签
 */
export function formatTimeRangeLabel(range?: TimeRangeHint): string {
  if (!range?.startTime && !range?.endTime) return range?.label || '未指定时间范围'
  const start = range.startTime ? formatTime(range.startTime * 1000) : '开始'
  const end = range.endTime ? formatTime(range.endTime * 1000) : '结束'
  return range.label ? `${range.label}（${start} - ${end}）` : `${start} - ${end}`
}
