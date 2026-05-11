import { ChevronDown, Loader2 } from 'lucide-react'
import { useMemo } from 'react'
import type { RefObject } from 'react'
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
  setContextMenu,
  showScrollToBottom,
  scrollToBottom
}: MessageListProps) {
  const renderedMessages = useMemo(() => messages.map((msg, index) => {
    const prevMsg = index > 0 ? messages[index - 1] : undefined
    const showDateDivider = shouldShowDateDivider(msg, prevMsg)
    const showTime = !prevMsg || (msg.createTime - prevMsg.createTime > 300)
    const isSent = msg.isSend === 1
    const isSystem = isSystemMessage(msg)
    const wrapperClass = isSystem ? 'system' : (isSent ? 'sent' : 'received')
    const messageDomKey = getMessageDomKey(msg)

    return (
      <div
        key={messageDomKey}
        className={`message-wrapper ${wrapperClass}`}
        data-message-key={messageDomKey}
      >
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
  }), [
    messages,
    currentSession,
    myAvatarUrl,
    hasImageKey,
    quoteStyle,
    selectedMessages,
    setContextMenu
  ])

  if (isLoadingMessages && messages.length === 0) {
    return (
      <div className="loading-messages">
        <Loader2 size={24} />
        <span>加载消息中...</span>
      </div>
    )
  }

  return (
    <div
      className="message-list"
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

      {renderedMessages}

      <div className={`scroll-to-bottom ${showScrollToBottom ? 'show' : ''}`} onClick={scrollToBottom}>
        <ChevronDown size={16} />
        <span>回到底部</span>
      </div>
    </div>
  )
}
