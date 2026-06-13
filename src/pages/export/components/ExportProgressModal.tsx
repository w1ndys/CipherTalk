import { Loader2 } from 'lucide-react'
import type { ExportOptions, ExportProgress } from '../types'

interface ExportProgressModalProps {
  progress: ExportProgress
  options: ExportOptions
}

export default function ExportProgressModal({ progress, options }: ExportProgressModalProps) {
  return (
    <div className="export-overlay">
      <div className="export-progress-modal">
        <div className="progress-spinner">
          <Loader2 size={32} className="spin" />
        </div>
        <h3>正在导出</h3>
        {progress.phase && <p className="progress-phase">{progress.phase}</p>}
        {progress.currentName && (
          <p className="progress-text">当前会话: {progress.currentName}</p>
        )}
        {progress.detail && <p className="progress-detail">{progress.detail}</p>}
        {!progress.currentName && !progress.detail && (
          <p className="progress-text">准备中...</p>
        )}
        <div className="progress-export-options">
          <span>格式: {options.format.toUpperCase()}</span>
          {options.exportImages && <span> · 含图片</span>}
          {options.exportVideos && <span> · 含视频</span>}
          {options.exportEmojis && <span> · 含表情</span>}
          {options.exportVoices && <span> · 含语音</span>}
          {options.exportAvatars && <span> · 含头像</span>}
        </div>
        {progress.total > 0 && (
          <>
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: `${(progress.current / progress.total) * 100}%` }}
              />
            </div>
            <p className="progress-count">{progress.current} / {progress.total} 个会话</p>
          </>
        )}
      </div>
    </div>
  )
}
