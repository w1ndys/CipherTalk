import { Aperture, BadgeCheck, Bot, BrainCircuit, Image as ImageIcon, Loader2, Mic, Origami, Radar, RefreshCw, Sparkles, TriangleAlert } from 'lucide-react'
import AppDatePicker from '../../../components/AppDatePicker'
import type { ChatSession } from '../../../types/models'
import type { SessionVectorIndexState } from '../../../types/ai'
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
  isPreparingVectorIndex: boolean
  vectorIndexState: SessionVectorIndexState | null
  hasPendingVectorMessages: boolean
  isVectorProviderUnavailable: boolean
  vectorIndexBadgeLabel: string
  vectorIndexPercent: number
  vectorIndexHoverRows: Array<{ label: string; value: string }>
  onVectorIndexClick: () => void | Promise<void>
  isPreparingMemoryBuild: boolean
  memoryBuildCount: number
  memoryBuildBadgeLabel: string
  memoryButtonTitle: string
  onMemoryBuildClick: () => void | Promise<void>
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
  showDetailPanel: boolean
  onToggleDetailPanel: () => void
}

export function ChatHeader({
  currentSession,
  currentSessionId,
  isRefreshingMessages,
  isLoadingMessages,
  isUpdating,
  onRefreshMessages,
  isPreparingVectorIndex,
  vectorIndexState,
  hasPendingVectorMessages,
  isVectorProviderUnavailable,
  vectorIndexBadgeLabel,
  vectorIndexPercent,
  vectorIndexHoverRows,
  onVectorIndexClick,
  isPreparingMemoryBuild,
  memoryBuildCount,
  memoryBuildBadgeLabel,
  memoryButtonTitle,
  onMemoryBuildClick,
  selectedDate,
  onSelectedDateChange,
  onJumpToDate,
  isJumpingToDate,
  isBatchTranscribing,
  batchTranscribeProgress,
  onBatchTranscribe,
  isBatchDecrypting,
  batchDecryptProgress,
  onBatchDecrypt,
  showDetailPanel,
  onToggleDetailPanel
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
        <div className="vector-index-action-wrapper">
          <button
            className={`icon-btn vector-index-btn ${isPreparingVectorIndex ? 'running active' : ''} ${vectorIndexState?.isVectorComplete ? 'complete' : ''} ${hasPendingVectorMessages ? 'pending' : ''}`}
            onClick={onVectorIndexClick}
            disabled={!currentSessionId || (isVectorProviderUnavailable && !isPreparingVectorIndex)}
            aria-label={isPreparingVectorIndex ? '取消向量化' : '增量向量化当前聊天'}
          >
            {isVectorProviderUnavailable && !isPreparingVectorIndex ? (
              <TriangleAlert size={18} />
            ) : isPreparingVectorIndex ? (
              <Radar size={18} className="vector-index-radar" />
            ) : vectorIndexState?.isVectorComplete ? (
              <BadgeCheck size={18} />
            ) : (
              <BrainCircuit size={18} />
            )}
            {vectorIndexBadgeLabel && (
              <span className="vector-index-badge">{vectorIndexBadgeLabel}</span>
            )}
          </button>
          <div className="vector-index-hover-panel" role="tooltip">
            <div className="vector-hover-header">
              <span>语义向量索引</span>
              <strong>{vectorIndexPercent}%</strong>
            </div>
            <div className="vector-hover-progress">
              <span style={{ width: `${vectorIndexPercent}%` }} />
            </div>
            <div className="vector-hover-rows">
              {vectorIndexHoverRows.map((row) => (
                <div key={row.label} className={row.label === '错误' ? 'error' : ''}>
                  <span>{row.label}</span>
                  <strong>{row.value}</strong>
                </div>
              ))}
            </div>
          </div>
        </div>
        <button
          className={`icon-btn memory-build-btn ${isPreparingMemoryBuild ? 'running active' : ''} ${memoryBuildCount > 0 ? 'complete' : ''}`}
          onClick={onMemoryBuildClick}
          disabled={!currentSessionId || isPreparingMemoryBuild}
          data-tooltip={memoryButtonTitle}
          aria-label="构建当前聊天三层记忆"
        >
          {isPreparingMemoryBuild ? (
            <Radar size={18} className="vector-index-radar" />
          ) : (
            <Origami size={18} />
          )}
          {memoryBuildBadgeLabel && (
            <span className="vector-index-badge">{memoryBuildBadgeLabel}</span>
          )}
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
        <button
          className="icon-btn ai-summary-btn"
          onClick={() => {
            window.electronAPI.window.openAISummaryWindow(
              currentSession.username,
              currentSession.displayName || currentSession.username
            )
          }}
          data-tooltip="AI 摘要"
        >
          <Sparkles size={18} />
        </button>
        <AppDatePicker
          mode="single"
          className="date-picker-wrapper"
          triggerClassName="icon-btn date-jump-btn"
          triggerVariant="icon"
          align="right"
          value={selectedDate}
          onChange={onSelectedDateChange}
          onCommit={onJumpToDate}
          placeholder="跳转到日期"
          confirmLabel="跳转"
          ariaLabel="跳转到日期"
          disabled={!currentSessionId || isJumpingToDate}
          loading={isJumpingToDate}
          showClear={false}
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
        <button
          className={`icon-btn detail-btn ${showDetailPanel ? 'active' : ''}`}
          onClick={onToggleDetailPanel}
          data-tooltip="AI 助手"
          aria-label="打开 AI 助手"
        >
          <Bot size={18} />
        </button>
      </div>
    </div>
  )
}
