import { FolderOpen } from 'lucide-react'

interface ExportPathSelectProps {
  exportFolder: string
  onSelect: () => void
}

export default function ExportPathSelect({ exportFolder, onSelect }: ExportPathSelectProps) {
  return (
    <div className="export-path-select" onClick={onSelect}>
      <FolderOpen size={16} />
      <span className="path-text">{exportFolder || '点击选择导出位置'}</span>
      <span className="change-text">更改</span>
    </div>
  )
}
