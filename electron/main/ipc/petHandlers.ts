import { dialog, ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import {
  fetchPetManifest,
  getPetSpriteDataUrl,
  hasBuiltinPet,
  importPetZip,
  installPet,
  listInstalledPets,
  removePet,
} from '../../services/petService'

export function registerPetHandlers(ctx: MainProcessContext): void {
  const ensureDefaultPet = (): void => {
    const config = ctx.getConfigService()
    if (!config || config.get('petDefaultInitialized')) return

    if (!config.get('petCurrent') && hasBuiltinPet()) {
      config.set('petCurrent', 'miyuji')
      ctx.broadcastToWindows('config:changed', { key: 'petCurrent', value: 'miyuji' })
    }
    config.set('petDefaultInitialized', true)
  }

  ensureDefaultPet()

  ipcMain.handle('pet:listInstalled', async () => {
    try {
      ensureDefaultPet()
      return { success: true, pets: listInstalledPets(ctx.getConfigService()) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('pet:manifest', async (_, force?: boolean) => {
    try {
      return { success: true, pets: await fetchPetManifest(Boolean(force)) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('pet:install', async (_, slug: string) => {
    try {
      return { success: true, pet: await installPet(slug, ctx.getConfigService()) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('pet:remove', async (_, slug: string) => {
    try {
      removePet(slug, ctx.getConfigService())
      const config = ctx.getConfigService()
      if (config?.get('petCurrent') === slug) {
        config.set('petCurrent', '')
        ctx.broadcastToWindows('config:changed', { key: 'petCurrent', value: '' })
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 从本地压缩包导入宠物：弹文件选择框 → 解压校验 → 落到 cachePath/pets/
  ipcMain.handle('pet:importZip', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择宠物压缩包',
      properties: ['openFile'],
      filters: [{ name: '宠物压缩包', extensions: ['zip'] }],
    })
    const zipPath = result.filePaths[0]
    if (result.canceled || !zipPath) return { success: false, canceled: true }
    try {
      return { success: true, pet: importPetZip(zipPath, ctx.getConfigService()) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('pet:getSprite', async (_, slug: string) => {
    const dataUrl = getPetSpriteDataUrl(slug, ctx.getConfigService())
    return dataUrl ? { success: true, dataUrl } : { success: false, error: '宠物精灵图不存在' }
  })

  // Agent 运行状态：渲染进程上报，转发给所有窗口（桌宠窗口据此切动画）
  ipcMain.on('pet:agentState', (_, state: string) => {
    ctx.broadcastToWindows('pet:agentState', state)
  })

  // 桌宠窗口请求扩窗/还原以容纳消息提醒气泡
  ipcMain.on('pet:setBubble', (_, expanded: boolean) => {
    ctx.getWindowManager().setPetBubbleExpanded(Boolean(expanded))
  })

  ipcMain.on('pet:showContextMenu', () => {
    ctx.getWindowManager().showPetContextMenu()
  })

  ipcMain.handle('pet:toggleDesktopWindow', async (_, enabled: boolean) => {
    const manager = ctx.getWindowManager()
    if (enabled) manager.openPetWindow()
    else manager.closePetWindow()
    ctx.getConfigService()?.set('petDesktopEnabled', enabled)
    ctx.broadcastToWindows('config:changed', { key: 'petDesktopEnabled', value: enabled })
    return { success: true }
  })
}
