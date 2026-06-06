/**
 * Agent 工具共用的小工具：时间单位归一、消息精简、发送者名解析。
 *
 * 单位约定：原微信库 create_time 是「秒」，memory 派生库用「毫秒」。工具对外统一用毫秒，
 * 喂底层时按需换算；锚点 ref 的 createTime 原样透传（chatService 期望秒）。
 */
import type { Message } from '../../chatService'

/** 归一到毫秒：秒级(<=1e12)自动 ×1000。无效返回 null。 */
export function toMs(value?: number | null): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return null
  return n > 1e12 ? n : n * 1000
}

/** 毫秒 → 秒（喂 chatService 时间范围接口）。容错：误传秒级也按秒。 */
export function msToSeconds(value?: number | null): number | undefined {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n > 1e12 ? n / 1000 : n)
}

/** 本地时区可读时间 `YYYY-MM-DD HH:mm`（用于标注出处）。 */
export function toLocalTime(value?: number | null): string | null {
  const ms = toMs(value)
  if (ms == null) return null
  const d = new Date(ms)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 批量把 username 解析成显示名（备注/昵称）。失败不致命，返回空映射。 */
export async function resolveSenders(usernames: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = Array.from(new Set(usernames.filter(Boolean)))
  if (unique.length === 0) return out
  try {
    const { resolveContactNames } = await import('../../contactNameResolver')
    const resolved = await resolveContactNames(unique)
    for (const [username, info] of resolved) out.set(username, info.displayName)
  } catch {
    /* 名称解析失败，回退用 username */
  }
  return out
}

export interface CompactMessage {
  time: string | null
  sender: string
  fromMe: boolean
  text: string
  localId: number
  sortSeq: number
  createTime: number
}

/** 把一条消息压成精简、可控大小、带出处字段的结构。 */
export function compactMessage(msg: Message, senderName?: string): CompactMessage {
  const fromMe = msg.isSend === 1
  const sender = fromMe ? '我' : senderName || msg.senderUsername || '未知'
  const text = String(msg.parsedContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  return {
    time: toLocalTime(msg.createTime),
    sender,
    fromMe,
    text,
    localId: msg.localId,
    sortSeq: msg.sortSeq,
    createTime: msg.createTime,
  }
}
