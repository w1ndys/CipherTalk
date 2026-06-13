import { Loader2, Image, Heart, MessageSquare } from 'lucide-react'
import type { MomentPost } from '../types'
import { getAvatarLetter } from '../utils'

interface MomentsListProps {
  isLoading: boolean
  moments: MomentPost[]
}

export default function MomentsList({ isLoading, moments }: MomentsListProps) {
  if (isLoading) {
    return (
      <div className="loading-state">
        <Loader2 size={24} className="spin" />
        <span>加载中...</span>
      </div>
    )
  }

  if (moments.length === 0) {
    return (
      <div className="empty-state">
        <span>暂无朋友圈数据</span>
      </div>
    )
  }

  return (
    <>
      <div className="select-actions">
        <span className="selected-count">预览最近 {moments.length} 条 · 导出按时间范围筛选</span>
      </div>
      <div className="export-session-list">
        {moments.map(m => (
          <div
            key={m.id || `${m.username}_${m.createTime}`}
            className="export-session-item moment-preview-item"
          >
            <div className="export-avatar">
              {m.avatarUrl ? (
                <img src={m.avatarUrl} alt="" />
              ) : (
                <span>{getAvatarLetter(m.nickname || m.username)}</span>
              )}
            </div>
            <div className="export-session-info">
              <div className="export-session-name">
                {m.nickname || m.username}
                <span className="moment-time">
                  {m.createTime ? new Date(m.createTime * 1000).toLocaleString('zh-CN') : ''}
                </span>
              </div>
              <div className="export-session-summary">
                {m.contentDesc || (m.media && m.media.length > 0 ? '[图片/视频]' : '[无文字内容]')}
              </div>
              <div className="moment-meta">
                {m.media && m.media.length > 0 && <span><Image size={11} /> {m.media.length}</span>}
                {m.likes && m.likes.length > 0 && <span><Heart size={11} /> {m.likes.length}</span>}
                {m.comments && m.comments.length > 0 && <span><MessageSquare size={11} /> {m.comments.length}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
