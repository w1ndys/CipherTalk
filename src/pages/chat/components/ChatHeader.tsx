import { Aperture, Image as ImageIcon, Loader2, Mic, RefreshCw } from 'lucide-react'
import { DateJumpPicker } from './DateJumpPicker'
import type { ChatSession } from '../../../types/models'
import { isGroupChat } from '../utils/messageGuards'
import { SessionAvatar } from './SessionSidebar'

type Progress = {
  current: number
  total: number
}

interface ChatHeaderProps {
  currentSession: ChatSession
  currentSessionId: string | null
  isRefreshingMessages: boolean
  isLoadingMessages: boolean
  isUpdating: boolean
  onRefreshMessages: () => void | Promise<void>
  selectedDate: string
  onSelectedDateChange: (value: string) => void
  onJumpToDate: (dateValue?: string) => void | Promise<void>
  isJumpingToDate: boolean
  isBatchTranscribing: boolean
  batchTranscribeProgress: Progress
  onBatchTranscribe: () => void | Promise<void>
  isBatchDecrypting: boolean
  batchDecryptProgress: Progress
  onBatchDecrypt: () => void | Promise<void>
}

export function ChatHeader({
  currentSession,
  currentSessionId,
  isRefreshingMessages,
  isLoadingMessages,
  isUpdating,
  onRefreshMessages,
  selectedDate,
  onSelectedDateChange,
  onJumpToDate,
  isJumpingToDate,
  isBatchTranscribing,
  batchTranscribeProgress,
  onBatchTranscribe,
  isBatchDecrypting,
  batchDecryptProgress,
  onBatchDecrypt
}: ChatHeaderProps) {
  return (
    <div className="message-header">
      <SessionAvatar session={currentSession} size={40} />
      <div className="header-info">
        <h3>
          {currentSession.displayName || currentSession.username}
          {currentSession.isWeCom && (
            currentSession.weComCorp
              ? <span className="wecom-corp" title="企业微信">@{currentSession.weComCorp}</span>
              : <span className="wecom-badge" title="企业微信">企</span>
          )}
        </h3>
        {isGroupChat(currentSession.username) && (
          <div className="header-subtitle">群聊</div>
        )}
      </div>
      <div className="header-actions">
        <button
          className="icon-btn refresh-messages-btn"
          onClick={onRefreshMessages}
          disabled={isRefreshingMessages || isLoadingMessages}
          data-tooltip="刷新消息"
        >
          <RefreshCw size={18} className={isRefreshingMessages || isUpdating ? 'spin' : ''} />
        </button>
        {!isGroupChat(currentSession.username) && (
          <button
            className="icon-btn moments-btn"
            onClick={() => window.electronAPI.window.openMomentsWindow(currentSession.username)}
            data-tooltip="查看朋友圈"
          >
            <Aperture size={18} />
          </button>
        )}
        <DateJumpPicker
          value={selectedDate}
          onChange={onSelectedDateChange}
          onJump={onJumpToDate}
          disabled={!currentSessionId || isJumpingToDate}
          loading={isJumpingToDate}
        />
        <button
          className="icon-btn batch-transcribe-btn"
          style={{ position: 'relative', zIndex: 10 }}
          onClick={onBatchTranscribe}
          disabled={isBatchTranscribing || !currentSessionId}
          data-tooltip={isBatchTranscribing ? `批量转写中 (${batchTranscribeProgress.current}/${batchTranscribeProgress.total})` : '批量语音转文字'}
        >
          {isBatchTranscribing ? (
            <Loader2 size={18} className="spin" />
          ) : (
            <Mic size={18} />
          )}
        </button>
        <button
          className="icon-btn batch-decrypt-btn"
          style={{ position: 'relative', zIndex: 10 }}
          onClick={onBatchDecrypt}
          disabled={isBatchDecrypting || !currentSessionId}
          data-tooltip={isBatchDecrypting ? `批量解密中 (${batchDecryptProgress.current}/${batchDecryptProgress.total})` : '批量解密图片'}
        >
          {isBatchDecrypting ? (
            <Loader2 size={18} className="spin" />
          ) : (
            <ImageIcon size={18} />
          )}
        </button>
      </div>
    </div>
  )
}
