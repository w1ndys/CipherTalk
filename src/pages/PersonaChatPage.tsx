/**
 * 克隆好友独立聊天窗口（/persona-chat/:sessionId）—— 手机聊天软件式的窄窗界面。
 * 三态：确认（隐私提示）→ 画像构建进度 → 气泡对话；
 * 等待回复时头部只显示「对方正在输入…」，不暴露内部检索过程。
 * 历史挂 agent 会话存储（scope kind='persona'），打开恢复、每轮保存。
 */
import { AlertCircle, Bot, CheckCircle, Loader2, MessageSquareX, Mic2, RefreshCw, Send, Square, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useChat } from '@ai-sdk/react'
import { AlertDialog, Button, ProgressBar, Label, Tooltip } from '@heroui/react'
import type { UIMessage } from 'ai'
import { PersonaChatTransport } from '../features/aiagent/transport/personaChatTransport'
import { useTtsSpeaker } from '../lib/ttsPlayer'
import { parseWechatEmoji } from '../utils/wechatEmoji'
import type { PersonaBuildProgressInfo, PersonaRecordInfo } from '../types/electron'

type Phase = 'loading' | 'confirm' | 'building' | 'chat'

function messageText(message: UIMessage): string {
  return (message.parts || [])
    .map((part) => (part && typeof part === 'object' && part.type === 'text' ? String((part as { text?: unknown }).text || '') : ''))
    .filter(Boolean)
    .join('')
}

/** 模型按"换行或／即分条"输出，两种分隔都拆成微信式的多条气泡。 */
function splitBubbles(text: string): string[] {
  return text.split(/[\n／]/).map((line) => line.trim()).filter(Boolean)
}

/** 语音气泡标记（与 personaChatEngine 的提示词约定一致）：行首 [语音]/【语音】。 */
const VOICE_MARKER_RE = /^[\[【]\s*(?:语音|voice)\s*[\]】]\s*/i

/** 表情包气泡标记（personaChatEngine 把 [表情:N] 解析后发出）：前缀 + JSON（cdnUrl/md5 等）。 */
const STICKER_BUBBLE_PREFIX = '[表情包]'

interface PersonaStickerData {
  cdnUrl?: string
  md5?: string
  productId?: string
  encryptUrl?: string
  aesKey?: string
}

interface PersonaBubble {
  text: string
  isVoice: boolean
  /** 估算语音时长（秒）：中文语速约 4 字/秒，1-60 截断 */
  seconds: number
  /** 表情包气泡：有值时渲染成表情包图片 */
  sticker?: PersonaStickerData
}

function parseBubble(raw: string): PersonaBubble {
  if (raw.startsWith(STICKER_BUBBLE_PREFIX)) {
    try {
      const sticker = JSON.parse(raw.slice(STICKER_BUBBLE_PREFIX.length)) as PersonaStickerData
      if (sticker && (sticker.cdnUrl || sticker.md5)) return { text: '', isVoice: false, seconds: 0, sticker }
    } catch { /* JSON 损坏按普通文本显示 */ }
  }
  const match = raw.match(VOICE_MARKER_RE)
  if (!match) return { text: raw, isVoice: false, seconds: 0 }
  const text = raw.slice(match[0].length).trim()
  if (!text) return { text: raw, isVoice: false, seconds: 0 }
  return { text, isVoice: true, seconds: Math.min(60, Math.max(1, Math.round(Array.from(text).length / 4))) }
}

/** 表情包 dataUrl/本地路径缓存（窗口级）：同一张表情多次出现只下载一次。 */
const stickerSrcCache = new Map<string, string>()

/** 表情包气泡：经主进程 downloadEmoji 下载/解密后显示真实表情包图片。 */
function PersonaStickerBubble({ sticker }: { sticker: PersonaStickerData }) {
  const cacheKey = sticker.md5 || sticker.cdnUrl || ''
  const [src, setSrc] = useState<string | undefined>(() => stickerSrcCache.get(cacheKey))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!cacheKey || src || failed) return
    let cancelled = false
    window.electronAPI.chat
      .downloadEmoji(sticker.cdnUrl || '', sticker.md5, sticker.productId, undefined, sticker.encryptUrl, sticker.aesKey)
      .then((result) => {
        if (cancelled) return
        if (result.success && result.localPath) {
          stickerSrcCache.set(cacheKey, result.localPath)
          setSrc(result.localPath)
        } else {
          setFailed(true)
        }
      })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [cacheKey, src, failed, sticker.cdnUrl, sticker.md5, sticker.productId, sticker.encryptUrl, sticker.aesKey])

  if (!cacheKey || failed) {
    return <div className="rounded-2xl rounded-tl-sm bg-surface px-3 py-2 text-sm text-muted">[表情]</div>
  }
  if (!src) {
    return (
      <div className="flex size-20 items-center justify-center rounded-2xl rounded-tl-sm bg-surface">
        <Loader2 className="animate-spin text-muted" size={16} />
      </div>
    )
  }
  return <img alt="表情包" className="max-h-28 max-w-40 rounded-lg object-contain" draggable={false} src={src} />
}

/** 微信语音条的声波图标：加载时旋转提示，播放时切换成动态音量柱。 */
function VoiceWaves({ loading, playing }: { loading: boolean; playing: boolean }) {
  if (loading) return <Loader2 className="shrink-0 animate-spin text-muted" size={16} />
  if (playing) return <VoicePlayingBars />
  return (
    <svg
      className="shrink-0"
      fill="none"
      height="16"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="2.2"
      viewBox="0 0 24 24"
      width="16"
    >
      <path d="M6 9.5a4.2 4.2 0 0 1 0 5" />
      <path d="M9.5 7a8 8 0 0 1 0 10" />
      <path d="M13 4.5a12 12 0 0 1 0 15" />
    </svg>
  )
}

function VoicePlayingBars() {
  return (
    <span aria-hidden className="inline-flex h-4 shrink-0 items-end gap-0.5 text-accent">
      {[0, 1, 2].map((item) => (
        <span
          key={item}
          className="rounded-full bg-accent animate-pulse"
          style={{ width: 3, height: `${6 + item * 3}px`, animationDelay: `${item * 120}ms` }}
        />
      ))}
    </span>
  )
}

function PersonaAvatar({ name, avatarUrl, size }: { name: string; avatarUrl?: string; size: number }) {
  const [imgError, setImgError] = useState(false)
  useEffect(() => { setImgError(false) }, [avatarUrl])
  if (avatarUrl && !imgError) {
    return (
      <img
        src={avatarUrl}
        alt={name}
        style={{ width: size, height: size }}
        className="shrink-0 rounded-full object-cover"
        onError={() => setImgError(true)}
      />
    )
  }
  return (
    <div
      style={{ width: size, height: size, fontSize: Math.max(12, size * 0.4) }}
      className="flex shrink-0 items-center justify-center rounded-full bg-default text-foreground"
    >
      {name.slice(0, 1) || '?'}
    </div>
  )
}

function getPersonaVoiceLabel(persona: PersonaRecordInfo | null): string {
  if (!persona?.ttsVoice) return ''
  if (persona.ttsVoice.provider === 'xiaomi') return '专属小米音色'
  if (persona.ttsVoice.provider === 'aliyun-qwen') return '专属通义音色'
  return '专属豆包音色'
}

export default function PersonaChatPage() {
  const location = useLocation()
  const sessionId = useMemo(() => {
    const match = /^\/persona-chat\/([^/]+)/.exec(location.pathname)
    return match ? decodeURIComponent(match[1]) : ''
  }, [location.pathname])

  const [displayName, setDisplayName] = useState('')
  const [avatarUrl, setAvatarUrl] = useState<string | undefined>(undefined)
  const [myAvatarUrl, setMyAvatarUrl] = useState<string | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>('loading')
  const [persona, setPersona] = useState<PersonaRecordInfo | null>(null)
  const [buildProgress, setBuildProgress] = useState<PersonaBuildProgressInfo | null>(null)
  const [buildError, setBuildError] = useState<string | null>(null)
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [input, setInput] = useState('')
  const [clearingConversations, setClearingConversations] = useState(false)
  const [voiceCloning, setVoiceCloning] = useState(false)
  const [voiceCloneStatus, setVoiceCloneStatus] = useState<{ ok: boolean; text: string } | null>(null)
  /** 删除确认弹窗：删除分身画像 / 删除对话记录 */
  const [confirmAction, setConfirmAction] = useState<'deletePersona' | 'clearConversations' | null>(null)
  /** 待发缓冲：真人不会秒回——发出的消息先挂着，停顿几秒没有新消息了才一起交给 AI 回一轮 */
  const [pendingTexts, setPendingTexts] = useState<string[]>([])
  const pendingRef = useRef<string[]>([])
  const inputValueRef = useRef('')
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lastSavedCountRef = useRef(0)

  const transport = useMemo(() => new PersonaChatTransport(() => sessionId), [sessionId])
  const { messages, sendMessage, setMessages, status, stop, error } = useChat({ transport, experimental_throttle: 50 })
  const busy = status === 'submitted' || status === 'streaming'

  // 语音消息：模型自己决定哪条用语音发（行首 [语音] 标记），这里负责微信式的"点开听"
  const { speakingKey, speakingState, speak: speakVoice, stop: stopVoice } = useTtsSpeaker()
  /** 已听过的语音气泡 key（message.id:index）；恢复历史时全部预置为已听，新来的才有红点 */
  const [playedVoice, setPlayedVoice] = useState<Set<string>>(() => new Set())
  /** 播放失败（TTS 不可用等）兜底显示文字的气泡 */
  const [revealedVoice, setRevealedVoice] = useState<Set<string>>(() => new Set())
  /** 连播链 id：点新语音/停止时自增，旧的连播循环检测到后退出 */
  const voiceChainRef = useRef(0)
  useEffect(() => () => { stopVoice() }, [stopVoice])

  const markVoicePlayed = (key: string) => {
    setPlayedVoice((prev) => {
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      return next
    })
  }

  /** 点开一条语音：先播它，然后像微信一样自动连播本条消息里后续未听过的语音。 */
  const handlePlayVoice = async (messageId: string, bubbles: PersonaBubble[], startIndex: number) => {
    const chain = ++voiceChainRef.current
    for (let i = startIndex; i < bubbles.length; i += 1) {
      if (voiceChainRef.current !== chain) return
      const bubble = bubbles[i]
      if (!bubble.isVoice) continue
      const key = `${messageId}:${i}`
      if (i > startIndex && playedVoice.has(key)) continue
      markVoicePlayed(key)
      const res = await speakVoice(key, bubble.text, {
        awaitEnd: true,
        instructions: persona?.card.ttsInstructions,
        personaVoice: persona?.ttsVoice,
      })
      if (voiceChainRef.current !== chain || res.stopped) return
      if (!res.ok) {
        // 念不出来就把文字亮出来兜底
        setRevealedVoice((prev) => new Set(prev).add(key))
        return
      }
    }
  }
  // AI 已经开始逐条吐气泡后就不再显示"正在输入"指示器，否则像凭空多了一条带头像的消息
  const lastMessage = messages[messages.length - 1]
  const showTypingIndicator = busy && !(lastMessage?.role === 'assistant' && messageText(lastMessage).trim().length > 0)
  const headerTitle = busy ? '对方正在输入…' : (displayName || sessionId)

  // 待发缓冲计时：发完一条等 2-4 秒，期间继续发会重新计时；输入框里还有字也再等等
  const PENDING_FLUSH_MIN_MS = 2000
  const PENDING_FLUSH_MAX_MS = 4000
  const PENDING_TYPING_POSTPONE_MS = 2000

  const flushPending = () => {
    const texts = pendingRef.current
    if (texts.length === 0) return
    pendingRef.current = []
    setPendingTexts([])
    // 多条连发合成一条多行消息：渲染端按行拆气泡，和逐条发出的观感一致
    void sendMessage({ text: texts.join('\n') })
  }

  const armFlushTimer = (delayMs?: number) => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null
      if (inputValueRef.current.trim()) {
        armFlushTimer(PENDING_TYPING_POSTPONE_MS)
        return
      }
      flushPending()
    }, delayMs ?? PENDING_FLUSH_MIN_MS + Math.random() * (PENDING_FLUSH_MAX_MS - PENDING_FLUSH_MIN_MS))
  }

  const clearPending = () => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current)
      flushTimerRef.current = null
    }
    pendingRef.current = []
    setPendingTexts([])
  }

  // 卸载时清掉待发计时器
  useEffect(() => () => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current)
  }, [])

  // 窗口标题同步（任务栏/系统标题栏）
  useEffect(() => {
    document.title = busy ? '对方正在输入…' : (displayName ? `${displayName}` : '克隆好友')
  }, [busy, displayName])

  // 拉好友信息（昵称/头像）
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    void Promise.all([
      window.electronAPI.chat.getSessionDetail(sessionId),
      window.electronAPI.chat.getMyAvatarUrl(),
    ]).then(([res, myAvatarRes]) => {
      if (cancelled) return
      if (res.success && res.detail) {
        setDisplayName(res.detail.displayName || res.detail.nickName || sessionId)
        setAvatarUrl(res.detail.avatarUrl)
      } else {
        setDisplayName(sessionId)
      }
      if (myAvatarRes.success && myAvatarRes.avatarUrl) {
        setMyAvatarUrl(myAvatarRes.avatarUrl)
      }
    }).catch(() => { if (!cancelled) setDisplayName(sessionId) })
    return () => { cancelled = true }
  }, [sessionId])

  // 查画像状态；已克隆则恢复上次对话
  useEffect(() => {
    if (!sessionId) return
    let cancelled = false
    setPhase('loading')
    setBuildError(null)
    void window.electronAPI.persona.get(sessionId).then(async (res) => {
      if (cancelled) return
      if (res.success && res.persona) {
        setPersona(res.persona)
        setPhase('chat')
        // 后台自动进化：和 TA 的真实聊天新增够多时增量重蒸馏画像（静默，失败不影响聊天）
        void window.electronAPI.persona.refreshIfStale(sessionId).then((evolved) => {
          if (!cancelled && evolved.success && evolved.refreshed && evolved.persona) setPersona(evolved.persona)
        }).catch(() => { /* 静默 */ })
        try {
          const last = await window.electronAPI.agent.getLastConversation({ kind: 'persona', sessionId })
          const meta = last.success && last.conversation ? (last.conversation as { id: number }) : null
          if (!meta || cancelled) return
          const loaded = await window.electronAPI.agent.loadConversation(meta.id)
          const conv = loaded.success && loaded.conversation
            ? (loaded.conversation as { id: number; messages: UIMessage[] })
            : null
          if (conv && !cancelled) {
            setConversationId(conv.id)
            lastSavedCountRef.current = conv.messages.length
            setMessages(conv.messages)
            // 历史里的语音视为已听过：红点只给本次会话新收到的语音
            const played = new Set<string>()
            for (const message of conv.messages) {
              if (message.role !== 'assistant') continue
              splitBubbles(messageText(message)).forEach((raw, index) => {
                if (parseBubble(raw).isVoice) played.add(`${message.id}:${index}`)
              })
            }
            setPlayedVoice(played)
          }
        } catch { /* 恢复失败就从空对话开始 */ }
      } else {
        setPhase('confirm')
      }
    })
    return () => { cancelled = true }
  }, [sessionId, setMessages])

  // 画像构建进度
  useEffect(() => {
    return window.electronAPI.persona.onBuildProgress((p) => {
      if (p.sessionId === sessionId) setBuildProgress(p)
    })
  }, [sessionId])

  // 新消息自动滚到底
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, pendingTexts, busy, phase])

  // 每轮结束保存对话；保存后触发对话反思（主进程攒够未反思消息才真正跑，提炼导演笔记）
  useEffect(() => {
    if (status !== 'ready' || !conversationId || messages.length === 0) return
    if (messages.length === lastSavedCountRef.current) return
    lastSavedCountRef.current = messages.length
    void window.electronAPI.agent.saveConversationMessages({ id: conversationId, messages })
      .then(() => window.electronAPI.persona.reflect({ sessionId, conversationId }))
      .catch(() => { /* 反思失败不影响聊天 */ })
  }, [status, conversationId, messages, sessionId])

  const handleBuild = async () => {
    setPhase('building')
    setBuildError(null)
    setBuildProgress(null)
    const res = await window.electronAPI.persona.build({ sessionId, displayName })
    if (res.success && res.persona) {
      setPersona(res.persona)
      setPhase('chat')
    } else {
      setBuildError(res.error || '克隆失败')
      setPhase('confirm')
    }
  }

  const handleDelete = async () => {
    if (busy) stop()
    clearPending()
    await window.electronAPI.persona.delete(sessionId)
    setPersona(null)
    setMessages([])
    setConversationId(null)
    lastSavedCountRef.current = 0
    setPhase('confirm')
  }

  const handleCloneVoice = async () => {
    if (voiceCloning || !persona) return
    setVoiceCloning(true)
    setVoiceCloneStatus({ ok: true, text: '正在复刻声音…' })
    try {
      const res = await window.electronAPI.persona.cloneVoice({ sessionId, displayName })
      if (res.success && res.persona) {
        setPersona(res.persona)
        const providerText = res.voice?.provider === 'xiaomi'
          ? '小米音色样本'
          : res.voice?.provider === 'aliyun-qwen'
            ? '通义音色'
            : '豆包音色'
        setVoiceCloneStatus({ ok: true, text: `已绑定专属${providerText}${res.warning ? `（${res.warning}）` : ''}` })
      } else {
        setVoiceCloneStatus({ ok: false, text: res.error || '声音复刻失败' })
      }
    } catch (e) {
      setVoiceCloneStatus({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setVoiceCloning(false)
    }
  }

  const handleClearConversations = async () => {
    if (busy || clearingConversations) return
    clearPending()
    setClearingConversations(true)
    try {
      const scope = { kind: 'persona', sessionId }
      const deleteViaExistingApis = async () => {
        const list = await window.electronAPI.agent.listConversations(scope)
        if (!list.success || !Array.isArray(list.conversations)) {
          throw new Error(list.error || '读取对话记录失败')
        }
        for (const item of list.conversations) {
          const id = Number((item as { id?: unknown }).id)
          if (Number.isFinite(id) && id > 0) {
            const res = await window.electronAPI.agent.deleteConversation(id)
            if (!res.success) throw new Error(res.error || '删除对话记录失败')
          }
        }
      }
      const deleteByScope = window.electronAPI.agent.deleteConversationsByScope
      if (deleteByScope) {
        try {
          const res = await deleteByScope(scope)
          if (!res.success) throw new Error(res.error || '删除对话记录失败')
        } catch (e) {
          if (!String(e instanceof Error ? e.message : e).includes('No handler registered')) throw e
          await deleteViaExistingApis()
        }
      } else {
        await deleteViaExistingApis()
      }
      setMessages([])
      setConversationId(null)
      lastSavedCountRef.current = 0
    } catch (e) {
      window.alert(e instanceof Error ? e.message : String(e))
    } finally {
      setClearingConversations(false)
    }
  }

  const handleSend = async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    inputValueRef.current = ''
    if (!conversationId) {
      try {
        const created = await window.electronAPI.agent.createConversation({
          scope: { kind: 'persona', sessionId, displayName },
          title: `${displayName || sessionId}的分身`,
        })
        if (created.success && created.conversation) {
          setConversationId((created.conversation as { id: number }).id)
        }
      } catch { /* 创建失败不阻塞发送，本轮不持久化 */ }
    }
    // 不直接触发 AI：先进待发缓冲，停顿几秒后这一串一起交给对方回
    pendingRef.current = [...pendingRef.current, text]
    setPendingTexts(pendingRef.current)
    armFlushTimer()
  }

  if (!sessionId) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted">无效的会话</div>
    )
  }

  if (phase === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-muted">
        <Loader2 size={18} className="animate-spin" />
        <span className="text-sm">正在检查分身状态…</span>
      </div>
    )
  }

  if (phase === 'confirm') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
        <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={64} />
        <h2 className="text-lg font-semibold text-foreground">克隆「{displayName}」</h2>
        <p className="text-center text-sm text-muted">
          根据你们的聊天记录提炼 TA 的说话风格、口头禅和真实对话样本，生成一个能模仿 TA 语气聊天的数字分身。
        </p>
        <div className="flex items-start gap-2 rounded-lg bg-warning-soft p-3 text-sm text-warning-soft-foreground">
          <AlertCircle size={16} className="mt-0.5 shrink-0" />
          <span>
            克隆和聊天时，部分聊天记录会发送给你配置的 AI 模型服务商用于分析与生成。
            如使用 Ollama 等本地模型则数据不出本机。画像仅保存在本地，可随时删除。
          </span>
        </div>
        {buildError && (
          <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger-soft-foreground">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{buildError}</span>
          </div>
        )}
        <Button onPress={handleBuild}>
          <Bot className="size-4" />
          开始克隆
        </Button>
      </div>
    )
  }

  if (phase === 'building') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-8">
        {/* 呼吸光环：AI 单次调用期间百分比不动，靠动画表明没卡死 */}
        <div className="relative flex size-20 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-accent/20 animation-duration-[2.4s]" />
          <span className="absolute inset-1 animate-pulse rounded-full bg-accent/15" />
          <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={64} />
        </div>
        <h2 className="text-base font-semibold text-foreground">正在克隆「{displayName}」</h2>
        <ProgressBar aria-label="克隆进度" className="w-full" value={buildProgress?.percent ?? 0} maxValue={100}>
          <Label>{buildProgress?.title || '准备中…'}</Label>
          <ProgressBar.Output />
          <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
        </ProgressBar>
        <div className="flex items-center gap-2 text-xs text-muted">
          <Loader2 size={14} className="shrink-0 animate-spin" />
          <span className="text-center">
            {buildProgress?.detail || '分析聊天记录并调用 AI 提炼画像与真实问答，通常需要几分钟'}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 仿手机聊天头部：等待回复时只显示"对方正在输入…" */}
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 px-4">
        <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{headerTitle}</div>
          <div className="truncate text-xs text-muted">
            数字分身{persona ? ` · 基于 ${persona.stats.friendMessageCount + (persona.stats.groupMessageCount || 0)} 条消息${persona.stats.groupMessageCount ? `（含群聊发言 ${persona.stats.groupMessageCount} 条）` : ''}${persona.ttsVoice ? ` · ${getPersonaVoiceLabel(persona)}` : ''}` : ''}
          </div>
        </div>
        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant={persona?.ttsVoice ? 'secondary' : 'ghost'}
              aria-label={persona?.ttsVoice ? '重新克隆声音' : '克隆声音'}
              isDisabled={busy || voiceCloning}
              isPending={voiceCloning}
              onPress={handleCloneVoice}
            >
              <Mic2 size={16} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>{persona?.ttsVoice ? '重新克隆声音' : '克隆声音'}</Tooltip.Content>
        </Tooltip>
        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button isIconOnly size="sm" variant="ghost" aria-label="重建画像" isDisabled={busy} onPress={() => setPhase('confirm')}>
              <RefreshCw size={16} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>重建画像（聊天记录更新后可重新克隆）</Tooltip.Content>
        </Tooltip>
        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="删除对话记录"
              isDisabled={busy || clearingConversations}
              isPending={clearingConversations}
              onPress={() => setConfirmAction('clearConversations')}
            >
              <MessageSquareX size={16} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>删除该分身的所有对话记录</Tooltip.Content>
        </Tooltip>
        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button isIconOnly size="sm" variant="ghost" aria-label="删除分身" onPress={() => setConfirmAction('deletePersona')}>
              <Trash2 size={16} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content>删除分身画像</Tooltip.Content>
        </Tooltip>
      </div>

      {voiceCloneStatus && (
        <div className={`mx-4 mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
          voiceCloneStatus.ok
            ? 'bg-success-soft text-success-soft-foreground'
            : 'bg-danger-soft text-danger-soft-foreground'
        }`}>
          {voiceCloneStatus.ok ? <CheckCircle size={14} className="mt-0.5 shrink-0" /> : <AlertCircle size={14} className="mt-0.5 shrink-0" />}
          <span>{voiceCloneStatus.text}</span>
        </div>
      )}

      {/* 消息区 */}
      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 py-3">
        {messages.length === 0 && pendingTexts.length === 0 && !busy && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted">
            <Bot size={32} />
            <p className="text-sm">和「{displayName}」的分身打个招呼吧</p>
          </div>
        )}
        {messages.map((message) => {
          const rawBubbles = splitBubbles(messageText(message))
          if (rawBubbles.length === 0) return null
          const bubbles = rawBubbles.map(parseBubble)
          const isMine = message.role === 'user'
          return (
            <div key={message.id} className={`flex w-full gap-2 ${isMine ? 'justify-end' : 'justify-start'}`}>
              {!isMine && <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={30} />}
              <div className={`flex max-w-[78%] flex-col gap-1 ${isMine ? 'items-end' : 'items-start'}`}>
                {bubbles.map((bubble, index) => {
                  const bubbleKey = `${message.id}:${index}`
                  if (bubble.sticker) {
                    return <PersonaStickerBubble key={bubbleKey} sticker={bubble.sticker} />
                  }
                  if (bubble.isVoice && !isMine) {
                    const active = speakingKey === bubbleKey
                    const loading = active && speakingState?.phase === 'loading'
                    const playing = active && speakingState?.phase === 'playing'
                    const unplayed = !playedVoice.has(bubbleKey)
                    return (
                      <div key={bubbleKey} className="flex items-center gap-1.5">
                        <button
                          aria-label={active ? '停止播放语音' : `播放语音，约 ${bubble.seconds} 秒`}
                          className={`flex cursor-pointer items-center rounded-2xl rounded-tl-sm border-0 bg-surface px-3 py-2.5 text-sm text-foreground transition-colors hover:bg-surface/80 ${loading ? 'animate-pulse' : ''} ${playing ? 'ring-1 ring-accent/40' : ''}`}
                          onClick={() => { void handlePlayVoice(message.id, bubbles, index) }}
                          style={{ width: Math.min(220, 88 + bubble.seconds * 3) }}
                          type="button"
                        >
                          <VoiceWaves loading={loading} playing={playing} />
                          <span className="ml-auto text-xs text-muted">{loading ? '...' : `${bubble.seconds}″`}</span>
                        </button>
                        {unplayed && <span aria-label="未播放" className="size-2 shrink-0 rounded-full bg-red-500" />}
                        {revealedVoice.has(bubbleKey) && (
                          <span className="max-w-50 text-xs text-muted">{bubble.text}</span>
                        )}
                      </div>
                    )
                  }
                  return (
                    <div
                      key={bubbleKey}
                      className={`whitespace-pre-wrap wrap-break-word rounded-2xl px-3 py-2 text-sm ${
                        isMine
                          ? 'rounded-tr-sm bg-success-soft text-success-soft-foreground'
                          : 'rounded-tl-sm bg-surface text-foreground'
                      }`}
                    >
                      {parseWechatEmoji(bubble.text)}
                    </div>
                  )
                })}
              </div>
              {isMine && <PersonaAvatar name="我" avatarUrl={myAvatarUrl} size={30} />}
            </div>
          )
        })}
        {/* 待发缓冲气泡：已显示但还没交给 AI（等用户把话说完） */}
        {pendingTexts.length > 0 && (
          <div className="flex w-full justify-end gap-2">
            <div className="flex max-w-[78%] flex-col items-end gap-1">
              {pendingTexts.map((bubble, index) => (
                <div
                  key={`pending:${index}`}
                  className="whitespace-pre-wrap wrap-break-word rounded-2xl rounded-tr-sm bg-success-soft px-3 py-2 text-sm text-success-soft-foreground"
                >
                  {parseWechatEmoji(bubble)}
                </div>
              ))}
            </div>
            <PersonaAvatar name="我" avatarUrl={myAvatarUrl} size={30} />
          </div>
        )}
        {showTypingIndicator && (
          <div className="flex w-full items-start justify-start gap-2">
            <PersonaAvatar name={displayName} avatarUrl={avatarUrl} size={30} />
            <span className="inline-flex gap-1 rounded-2xl rounded-tl-sm bg-surface px-3 py-2.5">
              <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:0ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:150ms]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted [animation-delay:300ms]" />
            </span>
          </div>
        )}
        {error && (
          <div className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger-soft-foreground">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <span>{error.message || '生成失败，请重试'}</span>
          </div>
        )}
      </div>

      {/* 输入栏 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3 py-3">
        <input
          aria-label={`给${displayName}的分身发消息`}
          className="h-10 flex-1 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/30"
          placeholder={`给「${displayName}」发消息…`}
          value={input}
          onChange={(event) => {
            setInput(event.target.value)
            inputValueRef.current = event.target.value
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void handleSend()
            }
          }}
        />
        {busy ? (
          <Button isIconOnly aria-label="停止生成" variant="secondary" onPress={() => stop()}>
            <Square size={16} />
          </Button>
        ) : (
          <Button isIconOnly aria-label="发送" isDisabled={!input.trim()} onPress={handleSend}>
            <Send size={16} />
          </Button>
        )}
      </div>

      {/* 删除分身画像确认 */}
      <AlertDialog.Backdrop
        isOpen={confirmAction === 'deletePersona'}
        onOpenChange={(open) => { if (!open) setConfirmAction(null) }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-100">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>删除「{displayName || sessionId}」的分身？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-muted">
                画像、真实问答索引和导演笔记都会删除，需要时可重新克隆。对话记录会保留。
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">取消</Button>
              <Button slot="close" variant="danger" onPress={() => void handleDelete()}>删除分身</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>

      {/* 删除对话记录确认 */}
      <AlertDialog.Backdrop
        isOpen={confirmAction === 'clearConversations'}
        onOpenChange={(open) => { if (!open) setConfirmAction(null) }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-100">
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>删除所有对话记录？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="text-sm text-muted">
                和「{displayName || sessionId}」分身的全部对话记录将被删除，画像会保留。此操作不可撤销。
              </p>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">取消</Button>
              <Button slot="close" variant="danger" onPress={() => void handleClearConversations()}>删除记录</Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </div>
  )
}
