import { CheckCircle, XCircle, ExternalLink } from 'lucide-react'
import type { ExportResult } from '../types'

interface ExportResultModalProps {
  result: ExportResult
  /** 成功数量的单位，例如「个会话」「个联系人」「条朋友圈」 */
  unitLabel: string
  onOpenFolder: () => void
  onClose: () => void
}

export default function ExportResultModal({ result, unitLabel, onOpenFolder, onClose }: ExportResultModalProps) {
  return (
    <div className="export-overlay">
      <div className="export-result-modal">
        <div className={`result-icon ${result.success ? 'success' : 'error'}`}>
          {result.success ? <CheckCircle size={48} /> : <XCircle size={48} />}
        </div>
        <h3>{result.success ? '导出完成' : '导出失败'}</h3>
        {result.success ? (
          <p className="result-text">
            {result.successCount !== undefined
              ? `成功导出 ${result.successCount} ${unitLabel}`
              : '导出成功'}
            {result.failCount ? `，${result.failCount} 个失败` : ''}
          </p>
        ) : (
          <p className="result-text error">{result.error}</p>
        )}
        <div className="result-actions">
          {result.success && (
            <button className="open-folder-btn" onClick={onOpenFolder}>
              <ExternalLink size={16} />
              <span>打开文件夹</span>
            </button>
          )}
          <button className="close-btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
