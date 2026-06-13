import { Download, Loader2 } from 'lucide-react'

interface ExportActionButtonProps {
  label: string
  isExporting: boolean
  disabled: boolean
  onClick: () => void
}

export default function ExportActionButton({ label, isExporting, disabled, onClick }: ExportActionButtonProps) {
  return (
    <div className="export-action">
      <button className="export-btn" onClick={onClick} disabled={disabled}>
        {isExporting ? (
          <>
            <Loader2 size={18} className="spin" />
            <span>导出中...</span>
          </>
        ) : (
          <>
            <Download size={18} />
            <span>{label}</span>
          </>
        )}
      </button>
    </div>
  )
}
