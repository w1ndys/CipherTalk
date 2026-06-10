import type { BrowserWindow, Tray } from 'electron'
import type { DatabaseService } from '../services/database'
import type { ConfigService } from '../services/config'
import type { LogService } from '../services/logService'

export type AppWithQuitFlag = Electron.App & {
  isQuitting?: boolean
}

export type ImageViewerListItem = {
  imagePath: string
  liveVideoPath?: string
}

export type ImageViewerOpenOptions = {
  sessionId?: string
  imageMd5?: string
  imageDatName?: string
}

export interface WindowManager {
  createMainWindow(): BrowserWindow
  createSplashWindow(): BrowserWindow
  closeSplashWindow(): Promise<void>
  createTray(): Tray | null
  destroyTray(): void
  setDockIcon(): void
  openChatWindow(): BrowserWindow
  openMomentsWindow(filterUsername?: string): BrowserWindow
  openAgreementWindow(): BrowserWindow
  openWelcomeWindow(mode?: 'default' | 'add-account'): BrowserWindow
  openPurchaseWindow(): BrowserWindow
  openImageViewerWindow(
    imagePath: string,
    liveVideoPath?: string,
    options?: ImageViewerOpenOptions
  ): BrowserWindow
  openVideoPlayerWindow(videoPath: string, videoWidth?: number, videoHeight?: number): BrowserWindow
  openBrowserWindow(url: string, title?: string): BrowserWindow
  openChatHistoryWindow(sessionId: string, messageId: number): BrowserWindow
  completeWelcome(): boolean
  isChatWindowOpen(): boolean
  closeChatWindow(): boolean
  openPetWindow(): BrowserWindow
  closePetWindow(): void
  isPetWindowOpen(): boolean
  showPetContextMenu(): void
  setPetBubbleExpanded(expanded: boolean): void
}

export interface MainProcessContext {
  appWithQuitFlag: AppWithQuitFlag
  allowDevTools: boolean
  getDbService(): DatabaseService | null
  setDbService(service: DatabaseService | null): void
  getConfigService(): ConfigService | null
  setConfigService(service: ConfigService | null): void
  getLogService(): LogService | null
  setLogService(service: LogService | null): void
  getMainWindow(): BrowserWindow | null
  setMainWindow(window: BrowserWindow | null): void
  getSplashWindow(): BrowserWindow | null
  setSplashWindow(window: BrowserWindow | null): void
  getTray(): Tray | null
  setTray(tray: Tray | null): void
  getSplashReady(): boolean
  setSplashReady(ready: boolean): void
  getStartupDbConnected(): boolean
  setStartupDbConnected(connected: boolean): void
  getIsInstallingUpdate(): boolean
  setIsInstallingUpdate(installing: boolean): void
  broadcastToWindows(channel: string, ...args: any[]): void
  getWindowManager(): WindowManager
  setWindowManager(manager: WindowManager): void
}
