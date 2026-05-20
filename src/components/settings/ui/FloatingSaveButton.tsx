import { Save } from 'lucide-react'
import './FloatingSaveButton.scss'

interface FloatingSaveButtonProps {
  hasChanges: boolean
  disabled?: boolean
  onClick: () => void
}

function FloatingSaveButton({ hasChanges, disabled = false, onClick }: FloatingSaveButtonProps) {
  return (
    <button
      className={`floating-save-btn ${hasChanges ? 'has-changes' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={hasChanges ? '有未保存的更改，点击保存' : '保存配置'}
    >
      <Save size={20} />
    </button>
  )
}

export default FloatingSaveButton
