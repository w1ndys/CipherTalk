import { ipcMain } from 'electron'
import { exportService, type ExportOptions, type MomentsExportOptions } from '../../services/exportService'
import type { MainProcessContext } from '../context'

/**
 * 导出 IPC。
 * export:progress 是长任务进度事件，必须绑定到发起导出的 renderer。
 */
export function registerExportHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('export:exportSessions', async (event, sessionIds: string[], outputDir: string, options: ExportOptions) => {
    return exportService.exportSessions(sessionIds, outputDir, options, (progress) => {
      event.sender.send('export:progress', progress)
    })
  })

  ipcMain.handle('export:exportSession', async (event, sessionId: string, outputPath: string, options: ExportOptions) => {
    return exportService.exportSessionToChatLab(sessionId, outputPath, options, (progress) => {
      event.sender.send('export:progress', progress)
    })
  })

  ipcMain.handle('export:exportContacts', async (event, outputDir: string, options: any) => {
    return exportService.exportContacts(outputDir, options, (progress) => {
      event.sender.send('export:progress', progress)
    })
  })

  ipcMain.handle('export:exportMoments', async (event, outputDir: string, options: MomentsExportOptions) => {
    return exportService.exportMoments(outputDir, options, (progress) => {
      event.sender.send('export:progress', progress)
    })
  })

  // 数据分析相关

}
