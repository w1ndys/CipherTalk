import type { ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import DateRangePicker from '../../../components/DateRangePicker'
import type { MomentsExportOptions } from '../types'
import type { ExportShared } from '../hooks/useExportShared'
import type { useMomentsExport } from '../hooks/useMomentsExport'
import { momentsFormatOptions } from '../constants'
import MomentsList from './MomentsList'
import FormatPicker from './FormatPicker'
import ExportPathSelect from './ExportPathSelect'
import ExportActionButton from './ExportActionButton'

interface MomentsExportPanelProps {
  moments: ReturnType<typeof useMomentsExport>
  shared: ExportShared
  tabs: ReactNode
}

export default function MomentsExportPanel({ moments: momentsHook, shared, tabs }: MomentsExportPanelProps) {
  const {
    moments,
    isLoadingMoments,
    momentsOptions,
    setMomentsOptions,
    loadMoments,
    startMomentsExport
  } = momentsHook

  return (
    <>
      <div className="session-panel">
        <div className="panel-header">
          <h2>朋友圈预览</h2>
          <button className="icon-btn" onClick={loadMoments} disabled={isLoadingMoments}>
            <RefreshCw size={18} className={isLoadingMoments ? 'spin' : ''} />
          </button>
        </div>

        <MomentsList isLoading={isLoadingMoments} moments={moments} />
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
              options={momentsFormatOptions}
              value={momentsOptions.format}
              onChange={(value) => setMomentsOptions(prev => ({ ...prev, format: value as MomentsExportOptions['format'] }))}
            />
          </div>

          <div className="setting-section">
            <h3>时间范围</h3>
            <div className="time-options">
              <DateRangePicker
                startDate={momentsOptions.startDate}
                endDate={momentsOptions.endDate}
                onStartDateChange={(date) => setMomentsOptions(prev => ({ ...prev, startDate: date }))}
                onEndDateChange={(date) => setMomentsOptions(prev => ({ ...prev, endDate: date }))}
              />
              <p className="time-hint">不选择时间范围则导出全部朋友圈</p>
            </div>
          </div>

          <div className="setting-section">
            <h3>导出位置</h3>
            <ExportPathSelect exportFolder={shared.exportFolder} onSelect={shared.selectExportFolder} />
          </div>
        </div>

        <ExportActionButton
          label="导出朋友圈"
          isExporting={shared.isExporting}
          disabled={!shared.exportFolder || shared.isExporting || moments.length === 0}
          onClick={startMomentsExport}
        />
      </div>
    </>
  )
}
