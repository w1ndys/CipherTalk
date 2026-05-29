import { X } from 'lucide-react'
import { AiAgentPanel } from '../../../features/aiagent/AiAgentPanel'
import type { ChatSession } from '../../../types/models'

interface SessionAiAgentPanelProps {
  isClosing: boolean
  session: ChatSession
  onClose: () => void
}

export function SessionAiAgentPanel({
  isClosing,
  session,
  onClose
}: SessionAiAgentPanelProps) {
  const sessionName = session.displayName || session.username

  return (
    <div className={`detail-panel session-aiagent-panel${isClosing ? ' closing' : ''}`}>
      <div className="detail-header">
        <h4>AI 助手</h4>
        <button className="close-btn" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="session-aiagent-panel__body">
        <AiAgentPanel
          scope={{ kind: 'session', sessionId: session.username, sessionName }}
          layout="embedded"
          composerFeatures={{ mention: false }}
        />
      </div>
    </div>
  )
}
