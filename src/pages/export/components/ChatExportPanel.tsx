import type { ReactNode } from 'react'
import { RefreshCw, Users, User, CircleUserRound, Image, Video, Smile, Mic } from 'lucide-react'
import DateRangePicker from '../../../components/DateRangePicker'
import type { ExportOptions } from '../types'
import type { ExportShared } from '../hooks/useExportShared'
import type { useChatExport } from '../hooks/useChatExport'
import { chatFormatOptions } from '../constants'
import ExportSearchBar from './ExportSearchBar'
import SessionList from './SessionList'
import FormatPicker from './FormatPicker'
import ExportPathSelect from './ExportPathSelect'
import ExportActionButton from './ExportActionButton'

interface ChatExportPanelProps {
  chat: ReturnType<typeof useChatExport>
  shared: ExportShared
  tabs: ReactNode
}

export default function ChatExportPanel({ chat, shared, tabs }: ChatExportPanelProps) {
  const {
    filteredSessions,
    selectedSessions,
    isLoading,
    searchKeyword,
    setSearchKeyword,
    sessionTypeFilter,
    setSessionTypeFilter,
    options,
    setOptions,
    loadSessions,
    toggleSession,
    toggleSelectAll,
    selectOnlyGroups,
    selectOnlyPrivate,
    startExport
  } = chat

  const allSelected = selectedSessions.size === filteredSessions.length && filteredSessions.length > 0

  const setOption = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) =>
    setOptions(prev => ({ ...prev, [key]: value }))

  return (
    <>
      <div className="session-panel">
        <div className="panel-header">
          <h2>选择会话</h2>
          <button className="icon-btn" onClick={loadSessions} disabled={isLoading}>
            <RefreshCw size={18} className={isLoading ? 'spin' : ''} />
          </button>
        </div>

        <ExportSearchBar
          value={searchKeyword}
          onChange={setSearchKeyword}
          placeholder="搜索联系人或群组..."
        />

        <div className="session-type-filter">
          <button
            className={`type-filter-btn ${sessionTypeFilter === 'all' ? 'active' : ''}`}
            onClick={() => setSessionTypeFilter('all')}
          >
            全部
          </button>
          <button
            className={`type-filter-btn ${sessionTypeFilter === 'group' ? 'active' : ''}`}
            onClick={() => setSessionTypeFilter('group')}
          >
            <Users size={13} />
            群聊
          </button>
          <button
            className={`type-filter-btn ${sessionTypeFilter === 'private' ? 'active' : ''}`}
            onClick={() => setSessionTypeFilter('private')}
          >
            <User size={13} />
            私聊
          </button>
        </div>

        <div className="select-actions">
          <div className="select-actions-left">
            <button className="select-all-btn" onClick={toggleSelectAll}>
              {allSelected ? '取消全选' : '全选'}
            </button>
            <button className="select-type-btn" onClick={selectOnlyGroups} title="仅选中列表中的群聊">
              <Users size={12} />
              选群聊
            </button>
            <button className="select-type-btn" onClick={selectOnlyPrivate} title="仅选中列表中的私聊">
              <User size={12} />
              选私聊
            </button>
          </div>
          <span className="selected-count">已选 {selectedSessions.size} 个</span>
        </div>

        <SessionList
          isLoading={isLoading}
          sessions={filteredSessions}
          selectedSessions={selectedSessions}
          onToggle={toggleSession}
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
              options={chatFormatOptions}
              value={options.format}
              onChange={(value) => setOption('format', value as ExportOptions['format'])}
            />
          </div>

          <div className="setting-section">
            <h3>时间范围</h3>
            <div className="time-options">
              <DateRangePicker
                startDate={options.startDate}
                endDate={options.endDate}
                onStartDateChange={(date) => setOption('startDate', date)}
                onEndDateChange={(date) => setOption('endDate', date)}
              />
              <p className="time-hint">不选择时间范围则导出全部消息</p>
            </div>
          </div>

          <div className="setting-section">
            <h3>导出选项</h3>
            <div className="export-options">
              <label className="checkbox-item">
                <input
                  type="checkbox"
                  checked={options.exportAvatars}
                  onChange={e => setOption('exportAvatars', e.target.checked)}
                />
                <div className="custom-checkbox"></div>
                <CircleUserRound size={16} style={{ color: 'var(--text-tertiary)' }} />
                <span>导出头像</span>
              </label>
              <label className="checkbox-item">
                <input
                  type="checkbox"
                  checked={options.exportImages}
                  onChange={e => setOption('exportImages', e.target.checked)}
                />
                <div className="custom-checkbox"></div>
                <Image size={16} style={{ color: 'var(--text-tertiary)' }} />
                <span>导出图片</span>
              </label>
              <label className="checkbox-item">
                <input
                  type="checkbox"
                  checked={options.exportVideos}
                  onChange={e => setOption('exportVideos', e.target.checked)}
                />
                <div className="custom-checkbox"></div>
                <Video size={16} style={{ color: 'var(--text-tertiary)' }} />
                <span>导出视频</span>
              </label>
              <label className="checkbox-item">
                <input
                  type="checkbox"
                  checked={options.exportEmojis}
                  onChange={e => setOption('exportEmojis', e.target.checked)}
                />
                <div className="custom-checkbox"></div>
                <Smile size={16} style={{ color: 'var(--text-tertiary)' }} />
                <span>导出表情包</span>
              </label>
              <label className="checkbox-item">
                <input
                  type="checkbox"
                  checked={options.exportVoices}
                  onChange={e => setOption('exportVoices', e.target.checked)}
                />
                <div className="custom-checkbox"></div>
                <Mic size={16} style={{ color: 'var(--text-tertiary)' }} />
                <span>导出语音</span>
              </label>
            </div>
          </div>

          <div className="setting-section">
            <h3>导出位置</h3>
            <ExportPathSelect exportFolder={shared.exportFolder} onSelect={shared.selectExportFolder} />
          </div>
        </div>

        <ExportActionButton
          label="开始导出"
          isExporting={shared.isExporting}
          disabled={selectedSessions.size === 0 || !shared.exportFolder || shared.isExporting}
          onClick={startExport}
        />
      </div>
    </>
  )
}
