import type { ReactNode } from 'react'
import { RefreshCw, User, Users, MessageSquare } from 'lucide-react'
import type { ContactExportOptions } from '../types'
import type { ExportShared } from '../hooks/useExportShared'
import type { useContactExport } from '../hooks/useContactExport'
import { contactFormatOptions } from '../constants'
import ExportSearchBar from './ExportSearchBar'
import ContactList from './ContactList'
import FormatPicker from './FormatPicker'
import ExportPathSelect from './ExportPathSelect'
import ExportActionButton from './ExportActionButton'

interface ContactsExportPanelProps {
  contact: ReturnType<typeof useContactExport>
  shared: ExportShared
  tabs: ReactNode
}

export default function ContactsExportPanel({ contact, shared, tabs }: ContactsExportPanelProps) {
  const {
    filteredContacts,
    selectedContacts,
    contactSearchKeyword,
    setContactSearchKeyword,
    isLoadingContacts,
    contactOptions,
    setContactOptions,
    loadContacts,
    toggleContact,
    toggleSelectAllContacts,
    startContactExport
  } = contact

  const allSelected = selectedContacts.size === filteredContacts.length && filteredContacts.length > 0

  const setContactType = (key: keyof ContactExportOptions['contactTypes'], value: boolean) =>
    setContactOptions(prev => ({
      ...prev,
      contactTypes: { ...prev.contactTypes, [key]: value }
    }))

  return (
    <>
      <div className="session-panel contacts-panel">
        <div className="panel-header">
          <h2>通讯录预览</h2>
          <button className="icon-btn" onClick={loadContacts} disabled={isLoadingContacts}>
            <RefreshCw size={18} className={isLoadingContacts ? 'spin' : ''} />
          </button>
        </div>

        <ExportSearchBar
          value={contactSearchKeyword}
          onChange={setContactSearchKeyword}
          placeholder="搜索联系人..."
        />

        <div className="select-actions">
          <button className="select-all-btn" onClick={toggleSelectAllContacts}>
            {allSelected ? '取消全选' : '全选'}
          </button>
          <span className="selected-count">
            {selectedContacts.size > 0 ? `已选 ${selectedContacts.size} 个` : `共 ${filteredContacts.length} 个联系人`}
          </span>
        </div>

        <ContactList
          isLoading={isLoadingContacts}
          contacts={filteredContacts}
          selectedContacts={selectedContacts}
          onToggle={toggleContact}
        />
      </div>

      <div className="settings-panel">
        <div className="panel-header">
          <h2>导出设置</h2>
          {tabs}
        </div>

        <div className="settings-content">
          <div className="setting-section">
            <h3>导出格式</h3>
            <FormatPicker
              options={contactFormatOptions}
              value={contactOptions.format}
              onChange={(value) => setContactOptions(prev => ({ ...prev, format: value as ContactExportOptions['format'] }))}
              className="contact-formats"
            />
          </div>

          <div className="setting-section">
            <h3>联系人类型</h3>
            <div className="export-options">
              <label className="checkbox-item">
                <input
                  type="checkbox"
                  checked={contactOptions.contactTypes.friends}
                  onChange={e => setContactType('friends', e.target.checked)}
                />
                <div className="custom-checkbox"></div>
                <User size={16} />
                <span>好友</span>
              </label>
              <label className="checkbox-item">
                <input
                  type="checkbox"
                  checked={contactOptions.contactTypes.groups}
                  onChange={e => setContactType('groups', e.target.checked)}
                />
                <div className="custom-checkbox"></div>
                <Users size={16} />
                <span>群聊</span>
              </label>
              <label className="checkbox-item">
                <input
                  type="checkbox"
                  checked={contactOptions.contactTypes.officials}
                  onChange={e => setContactType('officials', e.target.checked)}
                />
                <div className="custom-checkbox"></div>
                <MessageSquare size={16} />
                <span>公众号</span>
              </label>
            </div>
          </div>

          <div className="setting-section">
            <h3>导出选项</h3>
            <div className="export-options">
              <label className="checkbox-item">
                <input
                  type="checkbox"
                  checked={contactOptions.exportAvatars}
                  onChange={e => setContactOptions(prev => ({ ...prev, exportAvatars: e.target.checked }))}
                />
                <div className="custom-checkbox"></div>
                <span>导出头像</span>
              </label>
            </div>
          </div>

          <div className="setting-section">
            <h3>导出位置</h3>
            <ExportPathSelect exportFolder={shared.exportFolder} onSelect={shared.selectExportFolder} />
          </div>
        </div>

        <ExportActionButton
          label="导出通讯录"
          isExporting={shared.isExporting}
          disabled={!shared.exportFolder || shared.isExporting}
          onClick={startContactExport}
        />
      </div>
    </>
  )
}
