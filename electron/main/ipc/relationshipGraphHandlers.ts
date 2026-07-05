import { ipcMain } from 'electron'
import { relationshipGraphService } from '../../services/relationshipGraphService'
import type { MainProcessContext } from '../context'
import type { RelationshipGraphOptions } from '../../../src/types/models'

export function registerRelationshipGraphHandlers(ctx: MainProcessContext): void {
  relationshipGraphService.on('progress', (progress) => {
    ctx.broadcastToWindows('relationshipGraph:progress', progress)
  })

  ipcMain.handle('relationshipGraph:getGraph', async (_, options?: RelationshipGraphOptions) => {
    return relationshipGraphService.getGraph(options || {})
  })

  ipcMain.handle('relationshipGraph:rebuild', async (_, options?: RelationshipGraphOptions) => {
    return relationshipGraphService.rebuild(options || {})
  })

  ipcMain.handle('relationshipGraph:getPath', async (_, sourceId: string, targetId: string, options?: RelationshipGraphOptions) => {
    return relationshipGraphService.getPath(sourceId, targetId, options || {})
  })
}
