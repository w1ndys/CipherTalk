import { Aperture, Bell, BellOff, Bot, Download, Image as ImageIcon, Info, Loader2, Mic, RefreshCw, Sparkles } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Button, Drawer, Tooltip } from '@heroui/react'
import { DateJumpPicker } from './DateJumpPicker'
import type { ChatSession } from '../../../types/models'
import type { EmbeddingBuildProgress, EmbeddingVectorStoreInfo } from '../../../types/electron'
import { isGroupChat } from '../utils/messageGuards'
import { SessionAvatar } from './SessionSidebar'

type Progress = {
  current: number
  total: number
}

type SessionDetail = {
  wxid: string
  displayName: string
  remark?: string
  nickName?: string
  alias?: string
  avatarUrl?: string
  messageCount: number
  firstMessageTime?: number
  latestMessageTime?: number
  messageTables: { dbName: string; tableName: string; count: number }[]
}

function formatVectorProgress(progress: EmbeddingBuildProgress | null): string {
  if (!progress) return '准备语义索引…'
  if (progress.total > 0) return `${progress.message} ${progress.current}/${progress.total}`
  return progress.message
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function formatUpdatedAt(ms: number | null): string {
  if (!ms) return '无'
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatSessionTimestamp(timestamp: number): string {
  if (!timestamp) return '无'
  return new Date(timestamp * 1000).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getSessionTypeLabel(session: ChatSession): string {
  if (session.isFoldGroup) return '折叠的聊天'
  if (session.isOfficialFolder) return '公众号聚合'
  if (session.isOfficialAccount || session.username.startsWith('gh_')) return '公众号'
  if (isGroupChat(session.username)) return '群聊'
  if (session.isWeCom) return '企业微信'
  return '私聊'
}

function DetailRow({ label, value, monospace = false }: { label: string; value: ReactNode; monospace?: boolean }) {
  return (
    <div className="chat-detail-row">
      <span className="chat-detail-row__label">{label}</span>
      <span className={`chat-detail-row__value${monospace ? ' is-monospace' : ''}`}>{value}</span>
    </div>
  )
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
  isExportingVoiceSample: boolean
  onExportVoiceCloneSample: () => void | Promise<void>
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
  isExportingVoiceSample,
  onExportVoiceCloneSample,
  isBatchDecrypting,
  batchDecryptProgress,
  onBatchDecrypt
}: ChatHeaderProps) {
  // 向量化（语义索引）状态：null=未知/未启用嵌入，count=已建片段数
  const [vecBuilding, setVecBuilding] = useState(false)
  const [vecStatus, setVecStatus] = useState<{ enabled: boolean; count: number } | null>(null)
  const [vecError, setVecError] = useState<string | null>(null)
  const [vecProgress, setVecProgress] = useState<EmbeddingBuildProgress | null>(null)
  const [vecStore, setVecStore] = useState<EmbeddingVectorStoreInfo | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [notifyEnabled, setNotifyEnabled] = useState(false)
  const [contactNickName, setContactNickName] = useState('')
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null)
  const [sessionDetailLoading, setSessionDetailLoading] = useState(false)
  const headerRef = useRef<HTMLDivElement>(null)
  const [detailDrawerHost, setDetailDrawerHost] = useState<HTMLElement | null>(null)

  const getDetailDrawerHost = useCallback(() => {
    const messageShell = headerRef.current?.closest('.message-shell') as HTMLElement | null
    const messageArea = headerRef.current?.closest('.message-area') as HTMLElement | null
    return (messageShell ?? messageArea)?.querySelector('.message-content-wrapper') as HTMLElement | null
  }, [])

  useEffect(() => {
    setDetailDrawerHost(getDetailDrawerHost())
  }, [getDetailDrawerHost])

  useEffect(() => {
    let cancelled = false
    setContactNickName('')
    setSessionDetail(null)
    setSessionDetailLoading(true)

    void window.electronAPI.chat.getSessionDetail(currentSession.username)
      .then((result) => {
        if (cancelled) return
        if (result.success && result.detail) {
          setSessionDetail(result.detail)
          setContactNickName(result.detail.nickName?.trim() || currentSession.username)
        } else {
          setContactNickName(currentSession.username)
        }
      })
      .catch(() => {
        if (!cancelled) setContactNickName(currentSession.username)
      })
      .finally(() => {
        if (!cancelled) setSessionDetailLoading(false)
      })

    return () => { cancelled = true }
  }, [currentSession.username])

  // 消息提醒开关：回显当前会话是否开启，并随 config 变更同步
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.notify.getEnabledSessions().then((list) => {
      if (!cancelled) setNotifyEnabled(list.includes(currentSession.username))
    })
    const off = window.electronAPI.config.onChanged(({ key, value }) => {
      if (key === 'notifySessions' && Array.isArray(value)) {
        setNotifyEnabled((value as string[]).includes(currentSession.username))
      }
    })
    return () => { cancelled = true; off() }
  }, [currentSession.username])

  const handleToggleNotify = useCallback(() => {
    setNotifyEnabled((prev) => {
      const next = !prev
      void window.electronAPI.notify.setSessionEnabled(currentSession.username, next)
      return next
    })
  }, [currentSession.username])

  const syncDetailDrawerBounds = useCallback(() => {
    const host = detailDrawerHost ?? getDetailDrawerHost()
    if (!host) return

    const rect = host.getBoundingClientRect()
    const rootStyle = document.documentElement.style
    rootStyle.setProperty('--chat-detail-drawer-left', `${rect.left}px`)
    rootStyle.setProperty('--chat-detail-drawer-top', `${rect.top}px`)
    rootStyle.setProperty('--chat-detail-drawer-width', `${rect.width}px`)
    rootStyle.setProperty('--chat-detail-drawer-height', `${rect.height}px`)
  }, [detailDrawerHost])

  useEffect(() => {
    if (!isDetailOpen) return

    const host = detailDrawerHost ?? getDetailDrawerHost()
    if (!host) return

    syncDetailDrawerBounds()
    window.addEventListener('resize', syncDetailDrawerBounds)
    const observer = new ResizeObserver(syncDetailDrawerBounds)
    observer.observe(host)

    return () => {
      window.removeEventListener('resize', syncDetailDrawerBounds)
      observer.disconnect()
    }
  }, [detailDrawerHost, getDetailDrawerHost, isDetailOpen, syncDetailDrawerBounds])

  useEffect(() => {
    let cancelled = false
    setVecError(null)
    setVecProgress(null)
    setVecStore(null)
    if (!currentSessionId) {
      setVecStatus(null)
      return
    }
    void window.electronAPI.embedding.sessionStatus(currentSessionId).then((res) => {
      if (!cancelled && res.success) {
        setVecStatus({ enabled: !!res.enabled, count: res.count ?? 0 })
        setVecStore(res.store ?? null)
      }
    })
    return () => { cancelled = true }
  }, [currentSessionId])

  useEffect(() => {
    return window.electronAPI.embedding.onBuildProgress((progress) => {
      if (!currentSessionId || progress.sessionId !== currentSessionId) return
      setVecProgress(progress)
      if (progress.stage === 'done') {
        setVecStatus({ enabled: true, count: progress.indexed })
      }
    })
  }, [currentSessionId])

  const handleVectorize = async () => {
    if (!currentSessionId || vecBuilding) return
    setVecBuilding(true)
    setVecError(null)
    setVecProgress({
      sessionId: currentSessionId,
      stage: 'loading',
      current: 0,
      total: 0,
      indexed: vecStatus?.count ?? 0,
      message: '准备语义索引'
    })
    try {
      const res = await window.electronAPI.embedding.buildSession(currentSessionId)
      if (res.success) {
        setVecStatus({ enabled: true, count: res.indexed ?? 0 })
        const status = await window.electronAPI.embedding.sessionStatus(currentSessionId)
        if (status.success) setVecStore(status.store ?? null)
      } else setVecError(res.error || '向量化失败')
    } catch (e) {
      setVecError(e instanceof Error ? e.message : String(e))
    } finally {
      setVecBuilding(false)
    }
  }

  const vecDisabled = !currentSessionId || vecBuilding || (vecStatus !== null && !vecStatus.enabled)
  const vecTooltip = vecBuilding
    ? formatVectorProgress(vecProgress)
    : vecError
      ? `向量化失败：${vecError}`
      : vecStatus && !vecStatus.enabled
        ? '未启用嵌入模型（设置 → 嵌入）'
        : vecStatus && vecStatus.count > 0
          ? `已向量化 ${vecStatus.count} 段 · 点击更新`
          : '为此会话建立语义索引'
  const vectorEvidenceRows = vecStore
    ? [
        `片段：${vecStore.count} 段`,
        `媒体：${vecStore.mediaCount || 0} 张`,
        `维度：${vecStore.dimensions.length > 0 ? vecStore.dimensions.join(', ') : '无'}`,
        vecStore.mediaDimensions?.length ? `媒体维度：${vecStore.mediaDimensions.join(', ')}` : '',
        `文件：${vecStore.exists ? formatBytes(vecStore.sizeBytes) : '未创建'}`,
        `更新：${formatUpdatedAt(vecStore.updatedAtMs)}`,
        vecStore.dbPath,
      ]
    : []
  const sessionDisplayName = contactNickName || currentSession.username
  // 仅私聊可开消息提醒（排除群聊/公众号）
  const isPrivateSession = !isGroupChat(currentSession.username)
    && !currentSession.username.startsWith('gh_')
    && !currentSession.isOfficialAccount
    && !currentSession.isOfficialFolder
  const lastActivity = currentSession.lastTimestamp || currentSession.sortTimestamp
  const summary = currentSession.summary?.split('\n')[0]?.trim() || '暂无消息'
  const messageTables = sessionDetail?.messageTables ?? []
  const detailDrawer = (
    <Drawer.Backdrop
      className="chat-detail-backdrop"
      isOpen={isDetailOpen}
      onOpenChange={setIsDetailOpen}
      variant="transparent"
    >
      <Drawer.Content className="chat-detail-content" placement="right">
        <Drawer.Dialog className="chat-detail-drawer" aria-label="会话详情">
          <Drawer.CloseTrigger />
          <Drawer.Header>
            <Drawer.Heading>会话详情</Drawer.Heading>
          </Drawer.Header>
          <Drawer.Body>
            <div className="chat-detail-profile">
              <SessionAvatar session={currentSession} size={64} />
              <div className="chat-detail-profile__text">
                <div className="chat-detail-profile__name">{sessionDisplayName}</div>
                <div className="chat-detail-profile__meta">{getSessionTypeLabel(currentSession)}</div>
              </div>
            </div>

            <section className="chat-detail-section">
              <h4>基础信息</h4>
              <DetailRow label="昵称" value={sessionDisplayName} />
              <DetailRow label="会话 ID" value={sessionDetail?.wxid || currentSession.username} monospace />
              <DetailRow label="类型" value={getSessionTypeLabel(currentSession)} />
              {currentSession.isWeCom && (
                <DetailRow label="企业" value={currentSession.weComCorp || '企业微信'} />
              )}
              <DetailRow label="置顶" value={currentSession.isPinned ? '是' : '否'} />
              <DetailRow label="未读" value={currentSession.unreadCount > 0 ? currentSession.unreadCount : '无'} />
              <DetailRow label="最近活跃" value={formatSessionTimestamp(lastActivity)} />
            </section>

            <section className="chat-detail-section">
              <h4>消息统计</h4>
              <DetailRow label="总数" value={sessionDetailLoading ? '加载中...' : (sessionDetail?.messageCount ?? 0)} />
              <DetailRow label="最早消息" value={formatSessionTimestamp(sessionDetail?.firstMessageTime || 0)} />
              <DetailRow label="最新消息" value={formatSessionTimestamp(sessionDetail?.latestMessageTime || 0)} />
            </section>

            <section className="chat-detail-section">
              <h4>最近消息</h4>
              <div className="chat-detail-summary">{summary}</div>
            </section>

            <section className="chat-detail-section">
              <h4>消息所在数据库</h4>
              {sessionDetailLoading ? (
                <div className="chat-detail-empty">正在加载...</div>
              ) : messageTables.length > 0 ? (
                <div className="chat-detail-table-list">
                  {messageTables.map((item) => (
                    <div className="chat-detail-table-item" key={`${item.dbName}:${item.tableName}`}>
                      <div className="chat-detail-table-item__main">
                        <span className="chat-detail-table-item__db">{item.dbName}</span>
                        <span className="chat-detail-table-item__table">{item.tableName}</span>
                      </div>
                      <span className="chat-detail-table-item__count">{item.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="chat-detail-empty">未找到消息表</div>
              )}
            </section>

            <section className="chat-detail-section">
              <h4>语义索引</h4>
              <DetailRow
                label="状态"
                value={vecBuilding ? formatVectorProgress(vecProgress) : vecTooltip}
              />
              {vectorEvidenceRows.map((row, index) => (
                <DetailRow
                  key={`${index}:${row}`}
                  label={index === 0 ? '片段' : index === 1 ? '维度' : index === 2 ? '文件' : index === 3 ? '更新' : '路径'}
                  value={row.replace(/^(片段|维度|文件|更新)：/, '')}
                  monospace={index === 4}
                />
              ))}
            </section>
          </Drawer.Body>
        </Drawer.Dialog>
      </Drawer.Content>
    </Drawer.Backdrop>
  )

  return (
    <div ref={headerRef} className="message-header">
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
        {vecBuilding && (
          <div className="header-subtitle">{formatVectorProgress(vecProgress)}</div>
        )}
      </div>
      <div className="header-actions">
        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="刷新消息"
              onPress={onRefreshMessages}
              isDisabled={isRefreshingMessages || isLoadingMessages}
            >
              <RefreshCw size={18} className={isRefreshingMessages || isUpdating ? 'animate-spin' : ''} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content placement="bottom">刷新消息</Tooltip.Content>
        </Tooltip>

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="向量化（语义索引）"
              onPress={handleVectorize}
              isDisabled={vecDisabled}
            >
              {vecBuilding
                ? <Loader2 size={18} className="animate-spin" />
                : <Sparkles size={18} className={vecStatus && vecStatus.count > 0 ? 'text-primary' : ''} />}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content className="max-w-96" placement="bottom">
            <div className="space-y-1">
              <div>{vecTooltip}</div>
              {vectorEvidenceRows.length > 0 && (
                <div className="space-y-0.5 text-xs text-muted-foreground">
                  {vectorEvidenceRows.map((row, index) => (
                    <div className={index === vectorEvidenceRows.length - 1 ? 'max-w-88 truncate font-mono' : ''} key={`${index}:${row}`}>
                      {row}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Tooltip.Content>
        </Tooltip>

        {isPrivateSession && (
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label={notifyEnabled ? '关闭新消息提醒' : '开启新消息提醒'}
                onPress={handleToggleNotify}
              >
                {notifyEnabled ? <Bell size={18} className="text-primary" /> : <BellOff size={18} />}
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content placement="bottom">{notifyEnabled ? '新消息提醒已开启 · 点击关闭' : '开启新消息提醒（桌宠气泡）'}</Tooltip.Content>
          </Tooltip>
        )}

        {isPrivateSession && (
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="克隆好友"
                onPress={() => window.electronAPI.window.openPersonaChatWindow(currentSession.username)}
              >
                <Bot size={18} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content placement="bottom">克隆好友（和 TA 的数字分身聊天）</Tooltip.Content>
          </Tooltip>
        )}

        {isPrivateSession && (
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="导出复刻语音样本"
                onPress={onExportVoiceCloneSample}
                isDisabled={isExportingVoiceSample || !currentSessionId}
              >
                {isExportingVoiceSample ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content placement="bottom">{isExportingVoiceSample ? '正在导出复刻语音样本' : '导出复刻语音样本（至少 10 秒）'}</Tooltip.Content>
          </Tooltip>
        )}

        {!isGroupChat(currentSession.username) && (
          <Tooltip delay={0}>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                size="sm"
                variant="ghost"
                aria-label="查看朋友圈"
                onPress={() => window.electronAPI.window.openMomentsWindow(currentSession.username)}
              >
                <Aperture size={18} />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content placement="bottom">查看朋友圈</Tooltip.Content>
          </Tooltip>
        )}

        <DateJumpPicker
          value={selectedDate}
          onChange={onSelectedDateChange}
          onJump={onJumpToDate}
          disabled={!currentSessionId || isJumpingToDate}
          loading={isJumpingToDate}
        />

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="批量语音转文字"
              onPress={onBatchTranscribe}
              isDisabled={isBatchTranscribing || !currentSessionId}
            >
              {isBatchTranscribing ? <Loader2 size={18} className="animate-spin" /> : <Mic size={18} />}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content placement="bottom">
            {isBatchTranscribing ? `批量转写中 (${batchTranscribeProgress.current}/${batchTranscribeProgress.total})` : '批量语音转文字'}
          </Tooltip.Content>
        </Tooltip>

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="批量解密图片"
              onPress={onBatchDecrypt}
              isDisabled={isBatchDecrypting || !currentSessionId}
            >
              {isBatchDecrypting ? <Loader2 size={18} className="animate-spin" /> : <ImageIcon size={18} />}
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content placement="bottom">
            {isBatchDecrypting ? `批量解密中 (${batchDecryptProgress.current}/${batchDecryptProgress.total})` : '批量解密图片'}
          </Tooltip.Content>
        </Tooltip>

        <Tooltip delay={0}>
          <Tooltip.Trigger>
            <Button
              isIconOnly
              size="sm"
              variant="ghost"
              aria-label="会话详情"
              onPress={() => setIsDetailOpen(true)}
            >
              <Info size={18} />
            </Button>
          </Tooltip.Trigger>
          <Tooltip.Content placement="bottom">会话详情</Tooltip.Content>
        </Tooltip>
      </div>

      {detailDrawerHost ? detailDrawer : null}
    </div>
  )
}
