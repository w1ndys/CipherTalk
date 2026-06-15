import type { MainProcessContext } from '../../main/context'
import { chatService } from '../chatService'
import { isSystemContactUsername } from '../chat/constants'
import type { ChatSession, Message } from '../chat/types'

const CHECK_INTERVAL_MS = 60 * 60 * 1000
const STARTUP_DELAY_MS = 90_000
const UNREAD_SESSION_LIMIT = 12
const UNREAD_MESSAGES_PER_SESSION = 12

function formatDiaryTime(timestamp: number): string {
  if (!timestamp) return '未知时间'
  const date = new Date(timestamp * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function messageText(message: Message): string {
  const text = String(message.parsedContent || message.rawContent || '').replace(/\s+/g, ' ').trim()
  if (text) return text.slice(0, 220)
  if (message.voiceDuration) return `[语音 ${message.voiceDuration} 秒]`
  if (message.videoDuration) return `[视频 ${message.videoDuration} 秒]`
  if (message.fileName) return `[文件 ${message.fileName}]`
  if (message.imageMd5 || message.imageDatName) return '[图片]'
  if (message.emojiMd5 || message.emojiCdnUrl) return '[表情]'
  return '[非文本消息]'
}

function isPrivateDiarySession(session: ChatSession): boolean {
  const username = String(session.username || '').trim()
  const lower = username.toLowerCase()
  if (!username || isSystemContactUsername(lower)) return false
  if (lower.includes('@chatroom')) return false
  if (lower.startsWith('gh_')) return false
  if (session.isFoldGroup || session.isOfficialFolder || session.isOfficialAccount) return false
  if (Number(session.type) === 3) return false
  return true
}

export async function readUnreadDiarySource(): Promise<string> {
  const sessionsResult = await chatService.getSessions(0, 300)
  if (!sessionsResult.success || !Array.isArray(sessionsResult.sessions)) return ''
  const unreadSessions = sessionsResult.sessions
    .filter((session) => Number(session.unreadCount || 0) > 0)
    .filter(isPrivateDiarySession)
    .sort((a, b) => Number(b.unreadCount || 0) - Number(a.unreadCount || 0) || Number(b.lastTimestamp || 0) - Number(a.lastTimestamp || 0))
    .slice(0, UNREAD_SESSION_LIMIT)
  if (unreadSessions.length === 0) return ''

  const blocks: string[] = []
  for (const session of unreadSessions) {
    const messages = await readUnreadSessionMessages(session)
    const displayName = session.displayName || session.username
    blocks.push([
      `### ${displayName}（未读 ${session.unreadCount} 条）`,
      session.summary ? `最近摘要：${session.summary}` : '',
      ...messages.map((message) => {
        const sender = message.isSend ? '我' : (message.senderUsername || displayName)
        return `- ${formatDiaryTime(message.createTime)} ${sender}：${messageText(message)}`
      })
    ].filter(Boolean).join('\n'))
  }
  return blocks.join('\n\n').slice(0, 12_000)
}

async function readUnreadSessionMessages(session: ChatSession): Promise<Message[]> {
  const limit = Math.max(1, Math.min(UNREAD_MESSAGES_PER_SESSION, Number(session.unreadCount || 0)))
  const result = await chatService.getMessages(session.username, 0, limit)
  if (!result.success || !Array.isArray(result.messages)) return []
  return [...result.messages].sort((a, b) => Number(a.createTime || 0) - Number(b.createTime || 0))
}

class NightlyMemoryService {
  private ctx: MainProcessContext | null = null
  private timer: NodeJS.Timeout | null = null
  private startupTimer: NodeJS.Timeout | null = null
  private running = false

  init(ctx: MainProcessContext): void {
    if (this.timer) return
    this.ctx = ctx
    this.timer = setInterval(() => {
      void this.check()
    }, CHECK_INTERVAL_MS)
    this.startupTimer = setTimeout(() => {
      void this.check()
    }, STARTUP_DELAY_MS)
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    this.ctx = null
  }

  private async check(): Promise<void> {
    if (this.running) return
    const config = this.ctx?.getConfigService()
    if (!config) return
    if (!String(config.get('myWxid') || '').trim()) return
    const provider = config.getAICurrentProvider()
    if (!String(config.getAIProviderConfig(provider)?.apiKey || '').trim()) return
    const summaryHour = Number(config.get('diarySummaryHour') ?? 2)
    const customPrompt = String(config.get('diaryCustomPrompt') || '').trim()
    this.running = true
    try {
      const [{ resolveProviderConfig }, { maybeRunDailyConsolidation }] = await Promise.all([
        import('../agent/resolveProviderConfig'),
        import('../agent/tools/memory')
      ])
      const unreadMessages = await readUnreadDiarySource().catch(() => '')
      await maybeRunDailyConsolidation(resolveProviderConfig(), undefined, { unreadMessages, summaryHour, customPrompt })
      this.ctx?.getLogService()?.info('NightlyMemory', '夜间记忆整理检查完成')
    } catch (error) {
      this.ctx?.getLogService()?.warn('NightlyMemory', '夜间记忆整理跳过', { error: error instanceof Error ? error.message : String(error) })
    } finally {
      this.running = false
    }
  }
}

export const nightlyMemoryService = new NightlyMemoryService()
