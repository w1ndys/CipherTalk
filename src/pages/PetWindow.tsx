import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useCurrentPetLoader } from '@/features/pets/PetContext'
import { PetSprite } from '@/features/pets/PetSprite'
import { PET_STATES, petStateForAgent, type PetAgentState, type PetStateId } from '@/features/pets/petStates'
import { DEFAULT_FLAIR_POOL, useIdleFlair } from '@/features/pets/useIdleFlair'

type NotifyPayload = {
  username: string
  displayName: string
  avatarUrl?: string
  preview: string
  timestamp: number
}

type BubbleFrame = {
  expanded: boolean
  baseLeft: number
  baseTop: number
  baseWidth: number
  baseHeight: number
}

const NOTICE_DURATION_MS = 5000
const NOTICE_QUEUE_MAX = 5
const DEFAULT_BUBBLE_FRAME: BubbleFrame = {
  expanded: false,
  baseLeft: 0,
  baseTop: 0,
  baseWidth: 150,
  baseHeight: 170,
}

/** 消息提醒气泡：头像 + 昵称 + 预览，点击把主窗口带到前台。 */
function PetNotice({ notice, onClose }: { notice: NotifyPayload; onClose: () => void }) {
  const [avatarError, setAvatarError] = useState(false)
  const showAvatar = notice.avatarUrl && !avatarError

  return (
    <div
      className="pet-notice mb-1 flex max-w-70 cursor-pointer items-center gap-2 rounded-2xl bg-black/72 px-2.5 py-1.5 text-left shadow-lg backdrop-blur-sm"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      onClick={() => window.electronAPI.notify.activate()}
      role="button"
    >
      {showAvatar ? (
        <img
          src={notice.avatarUrl}
          alt=""
          className="size-7 shrink-0 rounded-full object-cover"
          onError={() => setAvatarError(true)}
        />
      ) : (
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/20 text-[11px] font-medium text-white">
          {(notice.displayName || '?').slice(0, 1)}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-[11px] font-medium text-white/95">{notice.displayName}</div>
        <div className="truncate text-[10px] text-white/70">{notice.preview}</div>
      </div>
      <button
        aria-label="关闭提醒"
        className="shrink-0 rounded-full p-0.5 text-white/60 hover:text-white/90"
        onClick={(e) => {
          e.stopPropagation()
          onClose()
        }}
        type="button"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

/**
 * 桌面悬浮桌宠窗口（透明无边框，跟随 Agent 运行状态切动画）。
 * 整个窗口是拖拽区域，悬停时右上角出现关闭按钮；拖动时按方向播跑/跳动画。
 * 收到消息提醒时，在桌宠上方弹出气泡（主进程会临时扩窗腾出空间）。
 */
export default function PetWindow() {
  const pet = useCurrentPetLoader()
  const [agentState, setAgentState] = useState<PetAgentState>('idle')
  const [dragState, setDragState] = useState<PetStateId | null>(null)
  const [notice, setNotice] = useState<NotifyPayload | null>(null)
  const [bubbleFrame, setBubbleFrame] = useState<BubbleFrame>(DEFAULT_BUBBLE_FRAME)
  const [isPointerInside, setIsPointerInside] = useState(false)
  const [hoverFlair, setHoverFlair] = useState<PetStateId | null>(null)

  const queueRef = useRef<NotifyPayload[]>([])
  const showingRef = useRef(false)
  const dismissTimerRef = useRef(0)
  const hoverFlairTimerRef = useRef(0)

  const clearHoverState = useCallback(() => {
    setIsPointerInside(false)
    setHoverFlair(null)
    window.clearTimeout(hoverFlairTimerRef.current)
  }, [])

  const triggerHoverFlair = useCallback(() => {
    if (agentState !== 'idle' || dragState !== null) return
    const next = DEFAULT_FLAIR_POOL[Math.floor(Math.random() * DEFAULT_FLAIR_POOL.length)]
    setHoverFlair(next)
    window.clearTimeout(hoverFlairTimerRef.current)
    hoverFlairTimerRef.current = window.setTimeout(() => {
      setHoverFlair(null)
    }, PET_STATES[next].durationMs * 2)
  }, [agentState, dragState])

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    const root = document.getElementById('root')
    if (root) root.style.background = 'transparent'
  }, [])

  // 提醒气泡队列：一次只显示一条，自动消失后接着弹下一条；队列空了通知主进程还原窗口尺寸
  const showNext = useCallback(() => {
    const next = queueRef.current.shift()
    if (!next) {
      showingRef.current = false
      setNotice(null)
      window.electronAPI.pet.setBubble(false)
      return
    }
    showingRef.current = true
    setNotice(next)
    window.electronAPI.pet.setBubble(true)
    window.clearTimeout(dismissTimerRef.current)
    dismissTimerRef.current = window.setTimeout(() => showNext(), NOTICE_DURATION_MS)
  }, [])

  const dismissNotice = useCallback(() => {
    window.clearTimeout(dismissTimerRef.current)
    showNext()
  }, [showNext])

  useEffect(() => {
    const off = window.electronAPI.pet.onNotify((payload) => {
      const queue = queueRef.current
      // 合并同一个人的多条，避免刷屏
      const idx = queue.findIndex((n) => n.username === payload.username)
      if (idx >= 0) queue[idx] = payload
      else queue.push(payload)
      if (queue.length > NOTICE_QUEUE_MAX) queue.shift()
      if (!showingRef.current) showNext()
    })
    return () => {
      off()
      window.clearTimeout(dismissTimerRef.current)
      window.clearTimeout(hoverFlairTimerRef.current)
      window.electronAPI.pet.setBubble(false)
    }
  }, [showNext])

  useEffect(() => {
    const off = window.electronAPI.pet.onBubbleFrame((frame) => {
      setBubbleFrame(frame.expanded ? frame : DEFAULT_BUBBLE_FRAME)
    })
    return off
  }, [])

  useEffect(() => {
    const off = window.electronAPI.pet.onContextMenuOpened(clearHoverState)
    return off
  }, [clearHoverState])

  useEffect(() => {
    let doneTimer = 0
    const off = window.electronAPI.pet.onAgentState((state) => {
      window.clearTimeout(doneTimer)
      if (state === 'done') {
        setAgentState('done')
        doneTimer = window.setTimeout(() => setAgentState('idle'), 2600)
        return
      }
      if (state === 'running' || state === 'failed' || state === 'idle') {
        setAgentState(state)
      }
    })
    return () => {
      window.clearTimeout(doneTimer)
      off()
    }
  }, [])

  // 拖动动作：一拖就锁定跑姿（默认原地跑），只在有明确水平位移时切左/右跑方向，
  // 期间绝不切别的动作避免闪烁；停止移动 800ms 后才复原。
  useEffect(() => {
    let lastX: number | null = null
    let settleTimer = 0
    const off = window.electronAPI.pet.onWindowMove((x) => {
      window.clearTimeout(settleTimer)
      setDragState((current) => {
        let next: PetStateId = current ?? 'running'
        if (lastX !== null) {
          const dx = x - lastX
          if (dx > 2) next = 'running-right'
          else if (dx < -2) next = 'running-left'
          // |dx| ≤ 2：保持当前跑姿不变
        }
        return next
      })
      lastX = x
      settleTimer = window.setTimeout(() => {
        setDragState(null)
        lastX = null
      }, 800)
    })
    return () => {
      window.clearTimeout(settleTimer)
      off()
    }
  }, [])

  // 空闲彩蛋（Codex 同款）：待机且没在拖动/悬停时，不定时来一段随机小动作
  const flair = useIdleFlair(agentState === 'idle' && dragState === null && !isPointerInside)

  const state: PetStateId = dragState
    ?? (agentState === 'idle' && hoverFlair ? hoverFlair : agentState === 'idle' && flair ? flair : petStateForAgent(agentState))

  const petStageStyle: React.CSSProperties = {
    WebkitAppRegion: 'drag',
    background: 'transparent',
    height: bubbleFrame.baseHeight,
    left: bubbleFrame.baseLeft,
    position: 'absolute',
    top: bubbleFrame.baseTop,
    width: bubbleFrame.baseWidth,
  } as React.CSSProperties

  const noticeLayerStyle: React.CSSProperties = {
    WebkitAppRegion: 'no-drag',
    maxWidth: '17.5rem',
    position: 'absolute',
  } as React.CSSProperties

  if (bubbleFrame.baseTop > 0) {
    noticeLayerStyle.bottom = `calc(100% - ${bubbleFrame.baseTop}px + 4px)`
  } else {
    noticeLayerStyle.top = bubbleFrame.baseTop + bubbleFrame.baseHeight + 4
  }

  if (bubbleFrame.baseLeft > 0) {
    noticeLayerStyle.right = `calc(100% - ${bubbleFrame.baseLeft + bubbleFrame.baseWidth}px)`
  } else {
    noticeLayerStyle.left = bubbleFrame.baseLeft
  }

  return (
    <div
      className="relative h-screen w-screen overflow-hidden"
      onContextMenu={(event) => {
        event.preventDefault()
        clearHoverState()
        window.electronAPI.pet.showContextMenu()
      }}
      onPointerEnter={() => {
        setIsPointerInside(true)
        triggerHoverFlair()
      }}
      onPointerLeave={clearHoverState}
      style={{ WebkitAppRegion: 'drag', background: 'transparent' } as React.CSSProperties}
    >
      {notice && (
        <div style={noticeLayerStyle}>
          <PetNotice notice={notice} onClose={dismissNotice} />
        </div>
      )}
      <div className="flex flex-col items-center justify-end overflow-hidden pb-1" style={petStageStyle}>
        <button
          aria-label="收起桌宠"
          className={`absolute top-1 right-1 rounded-full bg-black/30 p-1 text-white/80 transition-opacity hover:bg-black/50 ${isPointerInside ? 'opacity-100' : 'opacity-0'}`}
          onClick={() => void window.electronAPI.pet.toggleDesktopWindow(false)}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          type="button"
        >
          <X className="size-3.5" />
        </button>
        {pet ? (
          <>
            <PetSprite label={pet.displayName} scale={0.62} src={pet.spriteUrl} state={state} />
            <span className={`mt-0.5 rounded-full bg-black/30 px-2 py-0.5 text-[10px] text-white/90 transition-opacity ${isPointerInside ? 'opacity-100' : 'opacity-0'}`}>
              {pet.displayName}
            </span>
          </>
        ) : (
          <span className="rounded-(--agent-radius,12px) bg-black/40 px-3 py-2 text-center text-white/90 text-xs">
            还没选宠物
            <br />
            去「AI 宠物」页挑一只吧
          </span>
        )}
      </div>
    </div>
  )
}
