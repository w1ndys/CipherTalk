import { Bot, Database, User } from 'lucide-react'
import { useAppStore } from '../../../stores/appStore'
import AIProviderLogo from '../../../components/ai/AIProviderLogo'
import type { Message } from '../types'
import { AssistantBlocks } from './AssistantBlocks'

interface Props {
  message: Message
  onCancel?: () => void
  aiProvider?: string
}

export function MessageBubble({ message, onCancel, aiProvider }: Props) {
  const isUser = message.role === 'user'
  const blocks = message.blocks || (message.content ? [{ type: 'text' as const, text: message.content }] : [])
  const userInfo = useAppStore(s => s.userInfo)

  return (
    <article className={`agent-message agent-message--${isUser ? 'user' : 'assistant'} qa-message ${isUser ? 'user' : 'assistant'}`}>
      {!isUser ? (
        <div className="agent-message__avatar" aria-hidden="true">
          {aiProvider
            ? <AIProviderLogo providerId={aiProvider} alt={aiProvider} size={22} />
            : <Bot size={18} />
          }
        </div>
      ) : (
        <div className="agent-message__user-avatar" aria-hidden="true">
          {userInfo?.avatarUrl
            ? <img src={userInfo.avatarUrl} alt="" />
            : <User size={15} />
          }
        </div>
      )}

      {isUser ? (
        <div className="agent-message__user-content">
          {message.attached && message.attached.length > 0 && (
            <div className="agent-user-attached">
              {message.attached.map(r => (
                <div key={r.id} className="agent-user-attached-chip">
                  <Database size={11} />
                  <span>{r.label}</span>
                </div>
              ))}
            </div>
          )}
          <div className="agent-message__user-bubble qa-bubble">
            <span>{message.content}</span>
          </div>
        </div>
      ) : (
        <div className="agent-message__assistant-body qa-message-body">
          <AssistantBlocks blocks={blocks} streaming={message.streaming} onStop={onCancel} />
        </div>
      )}
    </article>
  )
}
