import { useState } from 'react'
import './ExportPage.css'
import type { ExportTab } from './types'
import { useExportShared } from './hooks/useExportShared'
import { useChatExport } from './hooks/useChatExport'
import { useContactExport } from './hooks/useContactExport'
import { useMomentsExport } from './hooks/useMomentsExport'
import ExportTabs from './components/ExportTabs'
import ChatExportPanel from './components/ChatExportPanel'
import ContactsExportPanel from './components/ContactsExportPanel'
import MomentsExportPanel from './components/MomentsExportPanel'
import ExportProgressModal from './components/ExportProgressModal'
import ExportResultModal from './components/ExportResultModal'

function ExportPage() {
  const [activeTab, setActiveTab] = useState<ExportTab>('chat')

  const shared = useExportShared()
  const chat = useChatExport(shared)
  const contact = useContactExport(shared, activeTab === 'contacts')
  const moments = useMomentsExport(shared, activeTab === 'moments')

  const tabs = <ExportTabs activeTab={activeTab} onChange={setActiveTab} />

  const unitLabel = activeTab === 'chat' ? '个会话' : activeTab === 'contacts' ? '个联系人' : '条朋友圈'

  return (
    <div className="export-page">
      {activeTab === 'chat' && <ChatExportPanel chat={chat} shared={shared} tabs={tabs} />}
      {activeTab === 'contacts' && <ContactsExportPanel contact={contact} shared={shared} tabs={tabs} />}
      {activeTab === 'moments' && <MomentsExportPanel moments={moments} shared={shared} tabs={tabs} />}

      {/* 导出进度弹窗 */}
      {shared.isExporting && (
        <ExportProgressModal progress={shared.exportProgress} options={chat.options} />
      )}

      {/* 导出结果弹窗 */}
      {shared.exportResult && (
        <ExportResultModal
          result={shared.exportResult}
          unitLabel={unitLabel}
          onOpenFolder={shared.openExportFolder}
          onClose={() => shared.setExportResult(null)}
        />
      )}
    </div>
  )
}

export default ExportPage
