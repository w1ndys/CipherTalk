import { useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from 'react'
import { CircleDashed, Xmark } from '@gravity-ui/icons'
import { nanoid } from 'nanoid'
import { createLiquidGlassMap, type GlassFilterMap, type GlassShapeOptions } from '../../../utils/liquidGlass'
import type { ChatSession, Message } from '../../../types/models'
import {
  REPLY_SUGGEST_CONFIG_KEY,
  type ReplySuggestSettings,
  buildFriendPersonaContext,
  buildMyPersonaContext,
  buildMyRecentTexts,
  buildSuggestContext,
  collectPendingImages,
  getReplySuggestSettings,
  loadFriendPersona,
  loadMyPersona,
  splitSuggestionBursts,
} from '../replySuggest'
import { useTopToast } from '../hooks/useTopToast'

const QUIET_MS = 5000
// 只对"刚收到"的对方消息生成建议：超过这个时长的老消息（比如翻历史、切进老会话）不触发
const FRESH_SECONDS = 10 * 60

// 液态玻璃折射贴图参数：卡片/胶囊是圆角矩形（气泡同款），关闭按钮是圆形（与朋友圈/Agent 按钮同参）
const GLASS_RECT: GlassShapeOptions = { halfX: 0.22, halfY: 0.14, radius: 0.7, edge: 0.2, feather: 1.2, strength: 1.6 }
const GLASS_CIRCLE: GlassShapeOptions = { halfX: 0.18, halfY: 0.18, radius: 0.18, edge: 0.02, feather: 0.35, strength: 3 }

type GlassShellProps = {
  as?: 'div' | 'button'
  shape?: GlassShapeOptions
  children: ReactNode
} & HTMLAttributes<HTMLElement> & { type?: 'button'; 'aria-label'?: string }

/**
 * 液态玻璃外壳（同 LiquidGlassBubble 方案）：按自身尺寸生成位移贴图，
 * backdrop-filter 折射背后的消息内容；卡片尺寸随内容变，ResizeObserver 跟随重建。
 * 贴图未就绪时不写行内样式，退回 CSS 里的普通毛玻璃兜底。
 */
function GlassShell({ as: Tag = 'div', shape = GLASS_RECT, children, style: _ignored, ...rest }: GlassShellProps) {
  const ref = useRef<HTMLElement | null>(null)
  const [filterId] = useState(() => `reply-glass-${nanoid(6)}`)
  const [map, setMap] = useState<GlassFilterMap | null>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => {
      const rect = el.getBoundingClientRect()
      const next = createLiquidGlassMap(Math.round(rect.width), Math.round(rect.height), shape)
      if (next) setMap(next)
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
    // shape 是模块级常量，不会变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const backdrop = map ? `url(#${filterId}) blur(2px) saturate(180%) brightness(1.05)` : undefined
  return (
    <Tag
      ref={ref as never}
      style={backdrop ? { backdropFilter: backdrop, WebkitBackdropFilter: backdrop } : undefined}
      {...rest}
    >
      {map && (
        <svg aria-hidden="true" focusable="false" style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}>
          <filter
            id={filterId}
            colorInterpolationFilters="sRGB"
            filterUnits="userSpaceOnUse"
            x="0"
            y="0"
            width={map.width}
            height={map.height}
          >
            <feImage href={map.href} xlinkHref={map.href} width={map.width} height={map.height} result="displacementMap" />
            <feDisplacementMap in="SourceGraphic" in2="displacementMap" scale={map.scale} xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
      )}
      {children}
    </Tag>
  )
}

/**
 * 悬浮回复建议栏：开启后，最后一条消息是对方发来且 5 秒内没有更新时，
 * 用最近上下文调一次轻量模型生成建议卡片；点击卡片复制到剪贴板。
 * 无建议时不渲染任何 DOM。
 */
export function ReplySuggestBar({ session, messages }: { session: ChatSession; messages: Message[] }) {
  const [settings, setSettings] = useState<ReplySuggestSettings | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { showTopToast } = useTopToast()
  // 已生成过建议的触发消息 key，避免同一条消息反复触发（含失败后的重试风暴）
  const handledKeyRef = useRef<string | null>(null)
  // 生成代次：我发出新消息后 +1，作废还在飞的旧生成结果
  const runSeqRef = useRef(0)
  const sessionRef = useRef(session.username)
  sessionRef.current = session.username

  // 会话级设置：加载 + 跟随 config 变更（ChatHeader 下拉里改动后这里立即生效）
  useEffect(() => {
    let cancelled = false
    void getReplySuggestSettings(session.username).then((s) => {
      if (!cancelled) setSettings(s)
    })
    const off = window.electronAPI.config.onChanged(({ key }) => {
      if (key !== REPLY_SUGGEST_CONFIG_KEY) return
      void getReplySuggestSettings(session.username).then((s) => {
        if (!cancelled) setSettings(s)
      })
    })
    return () => { cancelled = true; off() }
  }, [session.username])

  // 切会话/关闭功能：清空现有建议
  useEffect(() => {
    setSuggestions([])
    setError(null)
    handledKeyRef.current = null
  }, [session.username])

  useEffect(() => {
    if (settings && !settings.enabled) {
      setSuggestions([])
      setError(null)
    }
  }, [settings])

  const generate = useCallback(async (current: ReplySuggestSettings) => {
    const username = sessionRef.current
    const runSeq = runSeqRef.current
    setLoading(true)
    setError(null)
    try {
      // 自画像：likeme 用画像卡做模仿；其它风格也拿它的连发/字数统计做连发自适应
      const myPersona = await loadMyPersona(session.username)
      let myPersonaContext: string | undefined
      let myRecentTexts: string[] | undefined
      if (current.style === 'likeme') {
        if (myPersona) {
          myPersonaContext = buildMyPersonaContext(myPersona)
        } else {
          myRecentTexts = buildMyRecentTexts(messages)
        }
      }
      const myStats = myPersona
        ? { avgBurst: myPersona.stats.avgFriendBurst, avgChars: myPersona.stats.avgFriendMsgChars }
        : undefined
      // 深度模式：克隆过对方的话，把 TA 的画像也喂进去（没克隆则静默跳过）
      let friendPersonaContext: string | undefined
      if (current.deep) {
        const friendPersona = await loadFriendPersona(session.username)
        if (friendPersona) friendPersonaContext = buildFriendPersonaContext(friendPersona)
      }
      // 上下文（语音换转写文字）+ 对方待回复的图片（多模态模型会看图）
      const [context, images] = await Promise.all([
        buildSuggestContext(username, messages, current.deep),
        collectPendingImages(username, messages),
      ])
      const voiceReplaced = context.filter((c) => c.text.startsWith('[语音] ')).length
      console.log(
        `[ReplySuggest] 生成开始：上下文 ${context.length} 条（语音转写 ${voiceReplaced} 条），待附图片 ${images.length} 张`
        + `${images.length > 0 ? `（${images.map((img) => `${Math.round(img.base64.length * 0.75 / 1024)}KB`).join(' / ')}）` : ''}`
        + `，风格=${current.style}，深度=${current.deep}`,
      )
      const res = await window.electronAPI.agent.replySuggest({
        contactName: session.displayName || session.username,
        sessionId: session.username,
        context,
        style: current.style,
        count: current.count,
        deep: current.deep,
        myRecentTexts,
        myPersonaContext,
        myStats,
        friendPersonaContext,
        images: images.length > 0 ? images : undefined,
      })
      // 生成期间切走了会话、或我已经自己回过了，丢弃结果
      if (sessionRef.current !== username || runSeqRef.current !== runSeq) return
      if (res.success && res.suggestions?.length) {
        const vision = res.visionSupport === undefined ? '未知(按可尝试处理)' : res.visionSupport ? '支持' : '不支持'
        console.log(
          `[ReplySuggest] 生成完成：${res.suggestions.length} 条建议，实际附图 ${res.imagesAttached ?? 0} 张，模型图像输入=${vision}`,
        )
        setSuggestions(res.suggestions)
      } else if (!res.success) {
        console.warn('[ReplySuggest] 生成失败:', res.error)
        setError(res.error || '生成失败')
      }
    } catch (e) {
      console.warn('[ReplySuggest] 生成失败:', e)
      if (sessionRef.current === username && runSeqRef.current === runSeq) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setLoading(false)
    }
    // messages 刻意不进依赖：generate 只在触发定时器到点时调用，用当时闭包里的列表即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.displayName, session.username, messages])

  // 触发机制：最后一条是"刚收到"的对方消息，5 秒静默后生成。新消息到达会重跑本 effect，
  // cleanup 清掉旧定时器，天然构成"5 秒内没有更新才触发"的防抖。
  useEffect(() => {
    if (!settings?.enabled) return
    const last = messages[messages.length - 1]
    if (!last || !last.parsedContent?.trim()) return
    if (last.isSend === 1) {
      // 我已经回过了：作废还在飞的生成，清掉残留建议
      runSeqRef.current += 1
      setSuggestions([])
      setError(null)
      return
    }
    // 老消息不触发：翻历史/切进最后一条是很久前的会话，不该冒建议
    if (Date.now() / 1000 - last.createTime > FRESH_SECONDS) return
    const key = `${session.username}:${last.localId}:${last.createTime}`
    if (key === handledKeyRef.current) return
    // 有新消息进来，旧建议已过时
    setSuggestions([])
    setError(null)
    const timer = setTimeout(() => {
      handledKeyRef.current = key
      void generate(settings)
    }, QUIET_MS)
    return () => clearTimeout(timer)
  }, [messages, settings, session.username, generate])

  // seq/total：连发建议逐条复制时提示第几条，单条时 seq 传 0
  const handleCopy = useCallback((text: string, seq = 0, total = 1) => {
    void navigator.clipboard.writeText(text)
      .then(() => showTopToast(seq > 0 ? `已复制第 ${seq}/${total} 条，逐条粘贴发送` : '已复制，去微信粘贴发送'))
      .catch(() => showTopToast('复制失败', false))
  }, [showTopToast])

  const handleRetry = useCallback(() => {
    setError(null)
    if (settings) void generate(settings)
  }, [settings, generate])

  if (!settings?.enabled) return null
  if (!loading && !error && suggestions.length === 0) return null

  return (
    <div className="reply-suggest-bar" aria-live="polite">
      {loading ? (
        <GlassShell className="reply-suggest-bar__loading">
          <CircleDashed width={14} height={14} className="animate-spin" />
          <span>正在生成回复建议…</span>
        </GlassShell>
      ) : error ? (
        <>
          <GlassShell className="reply-suggest-bar__error" title={error}>
            <span>建议生成失败</span>
            <button className="reply-suggest-bar__retry" type="button" onClick={handleRetry}>
              重试
            </button>
          </GlassShell>
          <GlassShell
            as="button"
            aria-label="关闭提示"
            className="reply-suggest-bar__close"
            shape={GLASS_CIRCLE}
            type="button"
            onClick={() => setError(null)}
          >
            <Xmark width={14} height={14} />
          </GlassShell>
        </>
      ) : (
        <>
          <div className="reply-suggest-bar__cards">
            {suggestions.map((text, index) => {
              const segs = splitSuggestionBursts(text)
              return (
                <GlassShell className="reply-suggest-bar__card" key={`${index}:${text}`}>
                  {segs.map((seg, segIndex) => (
                    <button
                      className="reply-suggest-bar__seg"
                      key={`${segIndex}:${seg}`}
                      title={segs.length > 1 ? `点击复制第 ${segIndex + 1}/${segs.length} 条` : '点击复制'}
                      type="button"
                      onClick={() => handleCopy(seg, segs.length > 1 ? segIndex + 1 : 0, segs.length)}
                    >
                      {segs.length > 1 && <span className="reply-suggest-bar__seg-index">{segIndex + 1}</span>}
                      <span className="reply-suggest-bar__seg-text">{seg}</span>
                    </button>
                  ))}
                </GlassShell>
              )
            })}
          </div>
          <GlassShell
            as="button"
            aria-label="关闭建议"
            className="reply-suggest-bar__close"
            shape={GLASS_CIRCLE}
            type="button"
            onClick={() => setSuggestions([])}
          >
            <Xmark width={14} height={14} />
          </GlassShell>
        </>
      )}
    </div>
  )
}
