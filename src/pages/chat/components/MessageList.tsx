import { Check, ChevronDown, Loader2 } from 'lucide-react'
import { useCallback, useRef } from 'react'
import type { RefObject } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import ChatBackground from '../../../components/ChatBackground'
import type { ChatSession, Message } from '../../../types/models'
import type { ContextMenuState, QuoteStyle } from '../types'
import { getMessageDomKey } from '../utils/messageKeys'
import { isGroupChat, isSystemMessage } from '../utils/messageGuards'
import { formatDateDivider, shouldShowDateDivider } from '../utils/time'
import MessageBubble from './messageBubble/MessageBubble'

interface MessageListProps {
  currentSession: ChatSession
  isLoadingMessages: boolean
  messages: Message[]
  hasMoreMessages: boolean
  isLoadingMore: boolean
  messageListRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  myAvatarUrl?: string
  hasImageKey: boolean | null
  quoteStyle: QuoteStyle
  selectedMessages: Set<number>
  selectMode: boolean
  onToggleSelect: (localId: number) => void
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>
  showScrollToBottom: boolean
  scrollToBottom: (smooth?: boolean | React.MouseEvent) => void
}

export function MessageList({
  currentSession,
  isLoadingMessages,
  messages,
  hasMoreMessages,
  isLoadingMore,
  messageListRef,
  onScroll,
  myAvatarUrl,
  hasImageKey,
  quoteStyle,
  selectedMessages,
  selectMode,
  onToggleSelect,
  setContextMenu,
  showScrollToBottom,
  scrollToBottom
}: MessageListProps) {
  // Keep a stable ref to messages so estimateSize/getItemKey callbacks
  // don't recreate on every render
  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const estimateSize = useCallback((index: number) => {
    const msg = messagesRef.current[index]
    if (!msg) return 64
    // System messages (localType 10000) are compact
    if (msg.localType === 10000) return 36
    return 64
  }, [])

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => messageListRef.current,
    estimateSize,
    overscan: 10,
    getItemKey: (index) => {
      const msg = messagesRef.current[index]
      return msg ? getMessageDomKey(msg) : `msg-${index}`
    },
  })

  if (isLoadingMessages && messages.length === 0) {
    return (
      <div
        className="message-list message-list--loading"
        ref={messageListRef}
      >
        <ChatBackground />
        <div className="loading-messages" aria-busy="true" aria-label="加载消息中">
          <div className="message-skeleton-date" />
          {[0, 1, 2, 3, 4].map(i => (
            <div
              className={`message-skeleton-row ${i === 1 || i === 4 ? 'sent' : 'received'}`}
              key={i}
            >
              <div className="message-skeleton-avatar" />
              <div className="message-skeleton-main">
                <div className="message-skeleton-name" />
                <div className="message-skeleton-bubble">
                  <span className="message-skeleton-line" />
                  <span className="message-skeleton-line message-skeleton-line--mid" />
                  {i !== 1 ? <span className="message-skeleton-line message-skeleton-line--short" /> : null}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`message-list${selectMode ? ' select-mode' : ''}`}
      ref={messageListRef}
      onScroll={onScroll}
    >
      <ChatBackground />
      {hasMoreMessages && (
        <div className={`load-more-trigger ${isLoadingMore ? 'loading' : ''}`}>
          {isLoadingMore ? (
            <>
              <Loader2 size={14} />
              <span>加载更多...</span>
            </>
          ) : (
            <span>向上滚动加载更多</span>
          )}
        </div>
      )}

      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: 'relative',
          width: '100%',
        }}
      >
        {virtualizer.getVirtualItems().map((virtualItem) => {
          const msg = messages[virtualItem.index]
          const prevMsg = virtualItem.index > 0 ? messages[virtualItem.index - 1] : undefined
          const showDateDivider = shouldShowDateDivider(msg, prevMsg)
          const showTime = !prevMsg || (msg.createTime - prevMsg.createTime > 300)
          const isSent = msg.isSend === 1
          const isSystem = isSystemMessage(msg)
          const wrapperClass = isSystem ? 'system' : (isSent ? 'sent' : 'received')
          const messageDomKey = getMessageDomKey(msg)
          const isSelectable = selectMode && !isSystem
          const isSelected = selectedMessages.has(msg.localId)

          return (
            <div
              key={virtualItem.key}
              className={`message-wrapper ${wrapperClass}${isSelectable ? ' selectable' : ''}${isSelectable && isSelected ? ' selected' : ''}`}
              data-message-key={messageDomKey}
              data-index={virtualItem.index}
              ref={virtualizer.measureElement}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualItem.start}px)`,
              }}
              onClick={isSelectable ? () => onToggleSelect(msg.localId) : undefined}
            >
              {isSelectable && (
                <div className={`select-checkbox${isSelected ? ' checked' : ''}`}>
                  {isSelected && <Check size={13} strokeWidth={3} />}
                </div>
              )}
              {showDateDivider && (
                <div className="date-divider">
                  <span>{formatDateDivider(msg.createTime)}</span>
                </div>
              )}
              <MessageBubble
                message={msg}
                session={currentSession}
                showTime={!showDateDivider && showTime}
                myAvatarUrl={myAvatarUrl}
                isGroupChat={isGroupChat(currentSession.username)}
                hasImageKey={hasImageKey === true}
                quoteStyle={quoteStyle}
                onContextMenu={(e, message, handlers) => {
                  if (message.localType === 10000) {
                    return
                  }

                  e.preventDefault()
                  e.stopPropagation()

                  const menuWidth = 160
                  let menuItemCount = 1
                  if (message.localType !== 34 && message.localType !== 3 && message.localType !== 43) {
                    menuItemCount += 2
                  }
                  if (message.localType !== 3 && message.localType !== 43) {
                    menuItemCount += 1
                  }
                  if (message.localType === 34) {
                    menuItemCount += 1
                  }
                  if (handlers?.reTranscribe) {
                    menuItemCount += 1
                  }
                  if (handlers?.editStt) {
                    menuItemCount += 1
                  }
                  const menuHeight = menuItemCount * 38 + 12
                  let x = e.clientX
                  let y = e.clientY

                  if (x + menuWidth > window.innerWidth) {
                    x = window.innerWidth - menuWidth - 10
                  }
                  if (y + menuHeight > window.innerHeight) {
                    y = window.innerHeight - menuHeight - 10
                  }

                  setContextMenu({
                    x,
                    y,
                    message,
                    session: currentSession,
                    handlers
                  })
                }}
                isSelected={selectedMessages.has(msg.localId)}
              />
            </div>
          )
        })}
      </div>

      <div className={`scroll-to-bottom ${showScrollToBottom ? 'show' : ''}`} onClick={scrollToBottom}>
        <ChevronDown size={16} />
        <span>回到底部</span>
      </div>
    </div>
  )
}
