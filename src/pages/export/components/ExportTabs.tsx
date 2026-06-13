import { MessageSquare, Users, Camera } from 'lucide-react'
import type { ExportTab } from '../types'

interface ExportTabsProps {
  activeTab: ExportTab
  onChange: (tab: ExportTab) => void
}

export default function ExportTabs({ activeTab, onChange }: ExportTabsProps) {
  return (
    <div className="export-tabs" aria-label="导出模式">
      <button
        className={`export-tab ${activeTab === 'chat' ? 'active' : ''}`}
        onClick={() => onChange('chat')}
        type="button"
      >
        <MessageSquare size={14} />
        <span>聊天记录</span>
      </button>
      <button
        className={`export-tab ${activeTab === 'contacts' ? 'active' : ''}`}
        onClick={() => onChange('contacts')}
        type="button"
      >
        <Users size={14} />
        <span>通讯录</span>
      </button>
      <button
        className={`export-tab ${activeTab === 'moments' ? 'active' : ''}`}
        onClick={() => onChange('moments')}
        type="button"
      >
        <Camera size={14} />
        <span>朋友圈</span>
      </button>
    </div>
  )
}
