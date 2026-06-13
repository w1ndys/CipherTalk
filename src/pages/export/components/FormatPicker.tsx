import type { FormatOption } from '../types'

interface FormatPickerProps {
  options: FormatOption[]
  value: string
  onChange: (value: string) => void
  /** 额外的容器类名，例如通讯录用的 contact-formats */
  className?: string
}

export default function FormatPicker({ options, value, onChange, className }: FormatPickerProps) {
  return (
    <div className={`format-options${className ? ` ${className}` : ''}`}>
      {options.map(fmt => (
        <div
          key={fmt.value}
          className={`format-card ${value === fmt.value ? 'active' : ''}`}
          onClick={() => onChange(fmt.value)}
        >
          <fmt.icon size={24} />
          <span className="format-label">{fmt.label}</span>
          <span className="format-desc">{fmt.desc}</span>
        </div>
      ))}
    </div>
  )
}
