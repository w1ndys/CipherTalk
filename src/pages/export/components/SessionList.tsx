import { Loader2, Check } from 'lucide-react'
import type { ChatSession } from '../types'
import { getAvatarLetter } from '../utils'

interface SessionListProps {
  isLoading: boolean
  sessions: ChatSession[]
  selectedSessions: Set<string>
  onToggle: (username: string) => void
}

export default function SessionList({ isLoading, sessions, selectedSessions, onToggle }: SessionListProps) {
  if (isLoading) {
    return (
      <div className="loading-state">
        <Loader2 size={24} className="spin" />
        <span>加载中...</span>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="empty-state">
        <span>暂无会话</span>
      </div>
    )
  }

  return (
    <div className="export-session-list">
      {sessions.map(session => (
        <div
          key={session.username}
          className={`export-session-item ${selectedSessions.has(session.username) ? 'selected' : ''}`}
          onClick={() => onToggle(session.username)}
        >
          <div className="check-box">
            {selectedSessions.has(session.username) && <Check size={14} />}
          </div>
          <div className="export-avatar">
            {session.avatarUrl ? (
              <img src={session.avatarUrl} alt="" />
            ) : (
              <span className={session.username.includes('@chatroom') ? 'group-placeholder' : ''}>
                {session.username.includes('@chatroom') ? '群' : getAvatarLetter(session.displayName || session.username)}
              </span>
            )}
          </div>
          <div className="export-session-info">
            <div className="export-session-name">{session.displayName || session.username}</div>
            <div className="export-session-summary">{session.summary || '暂无消息'}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
