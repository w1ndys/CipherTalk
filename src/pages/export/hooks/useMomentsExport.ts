import { useState, useEffect, useCallback } from 'react'
import type { MomentPost, MomentsExportOptions } from '../types'
import type { ExportShared } from './useExportShared'

export function useMomentsExport(shared: ExportShared, active: boolean) {
  const [moments, setMoments] = useState<MomentPost[]>([])
  const [isLoadingMoments, setIsLoadingMoments] = useState(false)
  const [momentsOptions, setMomentsOptions] = useState<MomentsExportOptions>({
    format: 'html',
    startDate: '',
    endDate: ''
  })

  // 加载朋友圈预览
  const loadMoments = useCallback(async () => {
    setIsLoadingMoments(true)
    try {
      const result = await window.electronAPI.chat.connect()
      if (!result.success) {
        console.error('连接失败:', result.error)
        setIsLoadingMoments(false)
        return
      }
      const res = await window.electronAPI.sns.getTimeline(100, 0)
      if (res.success && res.timeline) {
        setMoments(res.timeline as MomentPost[])
      }
    } catch (e) {
      console.error('加载朋友圈失败:', e)
    } finally {
      setIsLoadingMoments(false)
    }
  }, [])

  // 切换到朋友圈时加载
  useEffect(() => {
    if (active && moments.length === 0) {
      loadMoments()
    }
  }, [active, moments.length, loadMoments])

  // 导出朋友圈
  const startMomentsExport = async () => {
    if (!shared.exportFolder) return

    shared.setIsExporting(true)
    shared.setExportProgress({ current: 0, total: 0, currentName: '朋友圈', phase: '准备导出', detail: '' })
    shared.setExportResult(null)

    try {
      const result = await window.electronAPI.export.exportMoments(
        shared.exportFolder,
        {
          format: momentsOptions.format,
          dateRange: (momentsOptions.startDate && momentsOptions.endDate) ? {
            start: Math.floor(new Date(momentsOptions.startDate + 'T00:00:00').getTime() / 1000),
            end: Math.floor(new Date(momentsOptions.endDate + 'T23:59:59').getTime() / 1000)
          } : null
        }
      )
      shared.setExportResult(result)
    } catch (e) {
      console.error('导出朋友圈失败:', e)
      shared.setExportResult({ success: false, error: String(e) })
    } finally {
      shared.setIsExporting(false)
    }
  }

  return {
    moments,
    isLoadingMoments,
    momentsOptions,
    setMomentsOptions,
    loadMoments,
    startMomentsExport
  }
}
