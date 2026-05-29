import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, ChevronDown, ChevronUp, ListOrdered, MessageSquare, MessageSquareDashed, Pin, RefreshCw, Search, X } from 'lucide-react'
import { List } from 'react-window'
import type { RowComponentProps } from 'react-window'
import MessageContent from '../../../components/MessageContent'
import type { ChatSession } from '../../../types/models'

type SidebarItem =
  | {
      kind: 'session'
      session: ChatSession
      isCollapsedChild?: boolean
      foldGroupExpanded?: boolean
      foldGroupUnreadTotal?: number
    }
  | { kind: 'pinned-fold-bar'; folded: boolean }

export interface SessionRowData {
  items: SidebarItem[]
  currentSessionId: string | null
  onSelect: (s: ChatSession) => void
  onToggleCollapsedGroup: () => void
  onTogglePinnedFolded: () => void
  formatTime: (t: number) => string
}

const SESSION_ROW_HEIGHT = 72
const PINNED_FOLD_BAR_HEIGHT = 40

export function SessionAvatar({ session, size = 48 }: { session: ChatSession; size?: number }) {
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [isVisible, setIsVisible] = useState(false)
  const imgRef = useRef<HTMLImageElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isGroup = session.username.includes('@chatroom')

  // 懒加载：使用 IntersectionObserver 检测头像是否进入可视区域
  useEffect(() => {
    if (!containerRef.current) return

    const element = containerRef.current

    // 如果没有 avatarUrl，不需要懒加载
    if (!session.avatarUrl) {
      setIsVisible(false)
      return
    }

    // 使用 IntersectionObserver 监听，不立即加载
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        rootMargin: '50px', // 提前 50px 开始加载
        threshold: 0
      }
    )

    observer.observe(element)

    return () => {
      observer.disconnect()
    }
  }, [session.avatarUrl])

  // 当 avatarUrl 变化时重置加载状态（但保持 isVisible，避免闪烁）
  useEffect(() => {
    if (session.avatarUrl) {
      setImageLoaded(false)
      setImageError(false)
      // 不重置 isVisible，避免已经可见的头像重新隐藏
    }
  }, [session.avatarUrl])

  // 检查图片是否已经从缓存加载完成
  useEffect(() => {
    if (isVisible && session.avatarUrl && imgRef.current) {
      // 如果图片已经加载完成（可能是从缓存加载的）
      if (imgRef.current.complete && imgRef.current.naturalWidth > 0) {
        setImageLoaded(true)
        setImageError(false)
      }
    }
  }, [isVisible, session.avatarUrl])

  // 添加超时处理，避免一直显示骨架屏
  useEffect(() => {
    if (!isVisible || !session.avatarUrl || imageLoaded || imageError) return

    const timeoutId = setTimeout(() => {
      // 如果 5 秒后还没加载完成，检查图片状态
      if (imgRef.current) {
        if (imgRef.current.complete) {
          if (imgRef.current.naturalWidth > 0) {
            setImageLoaded(true)
          } else {
            setImageError(true)
          }
        }
      }
    }, 5000)

    return () => clearTimeout(timeoutId)
  }, [isVisible, session.avatarUrl, imageLoaded, imageError])

  const hasValidUrl = session.avatarUrl && !imageError
  const shouldLoadImage = hasValidUrl && isVisible

  return (
    <div
      ref={containerRef}
      className={`session-avatar ${isGroup ? 'group' : ''} ${shouldLoadImage && !imageLoaded && !imageError ? 'loading' : ''}`}
      style={{ width: size, height: size }}
    >
      {shouldLoadImage && !imageError ? (
        <>
          {!imageLoaded && (
            <div className="avatar-skeleton" />
          )}
          <img
            ref={imgRef}
            src={session.avatarUrl}
            alt=""
            className={imageLoaded ? 'loaded' : ''}
            style={{
              opacity: imageLoaded ? 1 : 0,
              transition: 'opacity 0.2s ease-in-out',
              position: imageLoaded ? 'relative' : 'absolute',
              zIndex: imageLoaded ? 1 : 0
            }}
            onLoad={() => {
              setImageLoaded(true)
              setImageError(false)
            }}
            onError={() => {
              setImageError(true)
              setImageLoaded(false)
            }}
            loading="lazy"
          />
        </>
      ) : (
        <div className="avatar-skeleton" />
      )}
    </div>
  )
}

// 会话列表行组件（使用 memo 优化性能）
export const SessionRow = (props: RowComponentProps<SessionRowData>) => {
  const { index, style, items, currentSessionId, onSelect, onToggleCollapsedGroup, onTogglePinnedFolded, formatTime } = props
  const item = items[index]

  // 「折叠置顶聊天」分隔条
  if (item.kind === 'pinned-fold-bar') {
    return (
      <div
        style={style}
        className={`pinned-fold-bar ${item.folded ? 'folded' : 'expanded'}`}
        onClick={onTogglePinnedFolded}
        title={item.folded ? '展开置顶聊天' : '折叠置顶聊天'}
      >
        <ListOrdered size={16} />
        <span className="bar-title">折叠置顶聊天</span>
        {item.folded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </div>
    )
  }

  const session = item.session

  // 折叠的聊天 虚拟会话项（来自 @placeholder_foldgroup）
  if (session.isFoldGroup) {
    const summary = (session.summary || '').split('\n')[0] || '暂无消息'
    const foldedUnread = item.foldGroupUnreadTotal ?? 0
    const hasUnread = foldedUnread > 0
    return (
      <div
        style={style}
        className={`session-item fold-group ${item.foldGroupExpanded ? 'expanded' : ''}`}
        onClick={onToggleCollapsedGroup}
      >
        <div className="session-avatar fold-group-avatar" style={{ width: 48, height: 48 }}>
          <MessageSquareDashed size={26} />
          {hasUnread && <span className="fold-group-unread-dot" aria-label="有新消息" />}
        </div>
        <div className="session-info">
          <div className="session-top">
            <div className="session-name-wrap">
              <span className="session-name">{session.displayName || '折叠的聊天'}</span>
            </div>
            <span className="session-time">{formatTime(session.lastTimestamp || session.sortTimestamp)}</span>
          </div>
          <div className="session-bottom">
            <span className="session-summary">
              <MessageContent content={summary} disableLinks={true} />
            </span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      style={style}
      className={`session-item ${currentSessionId === session.username ? 'active' : ''}${session.isPinned ? ' pinned' : ''}${item.isCollapsedChild ? ' collapsed-child' : ''}`}
      onClick={() => onSelect(session)}
    >
      <SessionAvatar session={session} size={48} />
      <div className="session-info">
        <div className="session-top">
          <div className="session-name-wrap">
            {session.isPinned && <Pin size={12} className="pin-icon" />}
            <span className="session-name">{session.displayName || session.username}</span>
            {session.isWeCom && (
              session.weComCorp
                ? <span className="wecom-corp" title="企业微信">@{session.weComCorp}</span>
                : <span className="wecom-badge" title="企业微信">企</span>
            )}
          </div>
          <span className="session-time">{formatTime(session.lastTimestamp || session.sortTimestamp)}</span>
        </div>
        <div className="session-bottom">
          <span className="session-summary">
            {(() => {
              const summary = session.summary || '暂无消息'
              const firstLine = summary.split('\n')[0]
              const hasMoreLines = summary.includes('\n')
              return (
                <>
                  <MessageContent content={firstLine} disableLinks={true} />
                  {hasMoreLines && <span>...</span>}
                </>
              )
            })()}
          </span>
          {session.unreadCount > 0 && (
            <span className="unread-badge">
              {session.unreadCount > 99 ? '99+' : session.unreadCount}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

interface SessionSidebarProps {
  sidebarRef: React.RefObject<HTMLDivElement | null>
  searchInputRef: React.RefObject<HTMLInputElement | null>
  sidebarWidth: number
  searchKeyword: string
  onSearch: (keyword: string) => void
  onCloseSearch: () => void
  onRefresh: () => void | Promise<void>
  isLoadingSessions: boolean
  isUpdating: boolean
  connectionError: string | null
  onRetryConnect: () => void | Promise<void>
  filteredSessions: ChatSession[]
  currentSessionId: string | null
  onSelectSession: (session: ChatSession) => void
  formatTime: (timestamp: number) => string
}

export function SessionSidebar({
  sidebarRef,
  searchInputRef,
  sidebarWidth,
  searchKeyword,
  onSearch,
  onCloseSearch,
  onRefresh,
  isLoadingSessions,
  isUpdating,
  connectionError,
  onRetryConnect,
  filteredSessions,
  currentSessionId,
  onSelectSession,
  formatTime
}: SessionSidebarProps) {
  const [collapsedGroupExpanded, setCollapsedGroupExpanded] = useState(false)
  const [pinnedFolded, setPinnedFolded] = useState<boolean>(() => {
    try { return localStorage.getItem('ct-pinned-folded') === '1' } catch { return false }
  })
  const togglePinnedFolded = () => {
    setPinnedFolded(v => {
      const next = !v
      try { localStorage.setItem('ct-pinned-folded', next ? '1' : '0') } catch {}
      return next
    })
  }
  const isSearching = searchKeyword.trim().length > 0

  // 把 sessions 分组（用于决定底部栏是否显示，以及折叠群子项渲染）
  const { pinned, normal, collapsed } = useMemo(() => {
    const pinned: ChatSession[] = []
    const normal: ChatSession[] = []
    const collapsed: ChatSession[] = []
    for (const s of filteredSessions) {
      if (s.isCollapsed) collapsed.push(s)
      else if (s.isPinned) pinned.push(s)
      else normal.push(s)
    }
    return { pinned, normal, collapsed }
  }, [filteredSessions])

  // 构造虚拟列表行项
  // - 置顶在最上面（除非用户开了底部"折叠置顶聊天"）
  // - 其他会话按时间排序，"折叠的聊天" 虚拟会话 (@placeholder_foldgroup) 由后端自然返回，按时间一起排
  // - 点击"折叠的聊天"虚拟项时，展开 isCollapsed=true 的群聊作为子项渲染在其后
  const items = useMemo<SidebarItem[]>(() => {
    if (isSearching) {
      return filteredSessions.map(s => ({ kind: 'session' as const, session: s }))
    }

    const collapsedSorted = [...collapsed].sort((a, b) => (b.sortTimestamp || 0) - (a.sortTimestamp || 0))
    const unreadTotal = collapsedSorted.reduce((sum, s) => sum + (s.unreadCount || 0), 0)

    const list: SidebarItem[] = []
    if (pinned.length > 0) {
      if (!pinnedFolded) {
        for (const s of pinned) list.push({ kind: 'session', session: s })
        list.push({ kind: 'pinned-fold-bar', folded: false })
      } else {
        list.push({ kind: 'pinned-fold-bar', folded: true })
      }
    }
    for (const s of normal) {
      if (s.isFoldGroup) {
        list.push({
          kind: 'session',
          session: s,
          foldGroupExpanded: collapsedGroupExpanded,
          foldGroupUnreadTotal: unreadTotal
        })
        if (collapsedGroupExpanded) {
          for (const c of collapsedSorted) {
            list.push({ kind: 'session', session: c, isCollapsedChild: true })
          }
        }
      } else {
        list.push({ kind: 'session', session: s })
      }
    }
    return list
  }, [filteredSessions, collapsedGroupExpanded, isSearching, pinned, normal, collapsed, pinnedFolded])

  const listContainerRef = useRef<HTMLDivElement>(null)
  const [stickyBarVisible, setStickyBarVisible] = useState(false)
  // 自定义浮层滚动条：thumbTop/thumbHeight 为指示器的位置和高度；scrolling=true 时强制可见
  const [scrollbar, setScrollbar] = useState<{ thumbTop: number; thumbHeight: number; show: boolean; scrolling: boolean }>(
    { thumbTop: 0, thumbHeight: 0, show: false, scrolling: false }
  )
  const scrollIdleTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const container = listContainerRef.current
    if (!container) return
    const scrollEl = container.querySelector('div') as HTMLDivElement | null
    if (!scrollEl) return

    const barOffsetBottom = pinned.length * SESSION_ROW_HEIGHT + PINNED_FOLD_BAR_HEIGHT
    const update = (fromScroll = false) => {
      const sh = scrollEl.scrollHeight
      const ch = scrollEl.clientHeight
      const st = scrollEl.scrollTop

      // sticky bar 兜底（仅当置顶展开时）
      if (pinnedFolded || pinned.length === 0 || isSearching) {
        setStickyBarVisible(false)
      } else {
        setStickyBarVisible(barOffsetBottom > st + ch)
      }

      // 自定义滚动条指示器
      if (sh <= ch + 1) {
        setScrollbar({ thumbTop: 0, thumbHeight: 0, show: false, scrolling: false })
        return
      }
      const thumbHeight = Math.max(28, (ch * ch) / sh)
      const maxThumbTop = ch - thumbHeight
      const thumbTop = (st / (sh - ch)) * maxThumbTop
      setScrollbar(prev => ({
        thumbTop,
        thumbHeight,
        show: true,
        scrolling: fromScroll ? true : prev.scrolling
      }))
      if (fromScroll) {
        if (scrollIdleTimerRef.current) window.clearTimeout(scrollIdleTimerRef.current)
        scrollIdleTimerRef.current = window.setTimeout(() => {
          setScrollbar(prev => ({ ...prev, scrolling: false }))
        }, 1200)
      }
    }
    update(false)
    const onScroll = () => update(true)
    scrollEl.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(() => update(false))
    ro.observe(scrollEl)
    return () => {
      scrollEl.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (scrollIdleTimerRef.current) window.clearTimeout(scrollIdleTimerRef.current)
    }
  }, [pinned.length, pinnedFolded, isSearching, items.length])

  return (
    <div
      className="session-sidebar"
      ref={sidebarRef}
      style={{ width: sidebarWidth, minWidth: sidebarWidth, maxWidth: sidebarWidth }}
    >
      <div className="session-header">
        <div className="search-row">
          <div className="search-box expanded">
            <Search size={14} />
            <input
              ref={searchInputRef}
              type="text"
              placeholder="搜索"
              value={searchKeyword}
              onChange={(e) => onSearch(e.target.value)}
            />
            {searchKeyword && (
              <button className="close-search" onClick={onCloseSearch}>
                <X size={12} />
              </button>
            )}
          </div>
          <button
            className="icon-btn refresh-btn"
            onClick={onRefresh}
            disabled={isLoadingSessions}
            data-tooltip="刷新会话列表"
          >
            <RefreshCw size={16} className={isLoadingSessions || isUpdating ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {connectionError && (
        <div className="connection-error">
          <AlertCircle size={16} />
          <span>{connectionError}</span>
          <button onClick={onRetryConnect}>重试</button>
        </div>
      )}

      {isLoadingSessions ? (
        <div className="loading-sessions">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="skeleton-item">
              <div className="skeleton-avatar" />
              <div className="skeleton-content">
                <div className="skeleton-line" />
                <div className="skeleton-line" />
              </div>
            </div>
          ))}
        </div>
      ) : items.length > 0 ? (
        <div
          ref={listContainerRef}
          className="session-list"
          style={{ flex: 1, overflow: 'hidden', minHeight: 0, position: 'relative' }}
        >
          {/* @ts-ignore - 类型定义不匹配但不影响运行 */}
          <List
            style={{ height: '100%', width: '100%' }}
            rowCount={items.length}
            rowHeight={(index: number) =>
              items[index]?.kind === 'pinned-fold-bar' ? PINNED_FOLD_BAR_HEIGHT : SESSION_ROW_HEIGHT
            }
            rowProps={{
              items,
              currentSessionId,
              onSelect: onSelectSession,
              onToggleCollapsedGroup: () => setCollapsedGroupExpanded(v => !v),
              onTogglePinnedFolded: togglePinnedFolded,
              formatTime
            }}
            rowComponent={SessionRow}
          />
          {stickyBarVisible && (
            <div
              className="pinned-fold-bar expanded pinned-fold-bar-sticky"
              onClick={togglePinnedFolded}
              title="折叠置顶聊天"
            >
              <ListOrdered size={16} />
              <span className="bar-title">折叠置顶聊天</span>
              <ChevronUp size={16} />
            </div>
          )}
          {scrollbar.show && (
            <div className={`overlay-scrollbar ${scrollbar.scrolling ? 'scrolling' : ''}`}>
              <div
                className="overlay-scrollbar-thumb"
                style={{ transform: `translateY(${scrollbar.thumbTop}px)`, height: scrollbar.thumbHeight }}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="empty-sessions">
          <MessageSquare />
          <p>暂无会话</p>
          <p className="hint">请先在数据管理页面解密数据库</p>
        </div>
      )}
    </div>
  )
}

