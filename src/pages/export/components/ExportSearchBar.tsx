import { Search, X } from 'lucide-react'

interface ExportSearchBarProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
}

export default function ExportSearchBar({ value, onChange, placeholder }: ExportSearchBarProps) {
  return (
    <div className="search-bar">
      <Search size={16} />
      <input
        type="text"
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      {value && (
        <button className="clear-btn" onClick={() => onChange('')}>
          <X size={14} />
        </button>
      )}
    </div>
  )
}
