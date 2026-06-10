import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  nativeTheme,
  screen,
  Tray,
  type BrowserWindowConstructorOptions
} from 'electron'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { autoUpdater } from 'electron-updater'
import { DatabaseService } from '../../services/database'
import { ConfigService } from '../../services/config'
import { LogService } from '../../services/logService'
import { appUpdateService } from '../../services/appUpdateService'
import { mcpProxyService } from '../../services/mcp/proxyService'
import { voiceTranscribeServiceWhisper } from '../../services/voiceTranscribeServiceWhisper'
import { attachWindowStartupDiagnostics, markStartupMilestone } from '../startupDiagnostics'
import type { ImageViewerOpenOptions, MainProcessContext, WindowManager } from '../context'

type ReleaseAnnouncementPayload = {
  version: string
  releaseBody?: string
  releaseNotes?: string
  generatedAt?: string
}

function getReleaseAnnouncementPath(): string {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  return isDev
    ? join(__dirname, '../.tmp/release-announcement.json')
    : join(process.resourcesPath, 'release-announcement.json')
}

function syncPackagedReleaseAnnouncement(ctx: MainProcessContext) {
  const configService = ctx.getConfigService()
  if (!configService) return

  const announcementPath = getReleaseAnnouncementPath()
  if (!existsSync(announcementPath)) return

  try {
    const raw = readFileSync(announcementPath, 'utf8')
    const payload = JSON.parse(raw) as ReleaseAnnouncementPayload
    if (!payload || typeof payload !== 'object') return

    const version = String(payload.version || '').trim()
    if (!version || version !== app.getVersion()) return

    const releaseBody = String(payload.releaseBody || '').trim()
    const releaseNotes = String(payload.releaseNotes || '').trim()

    const storedVersion = configService.get('releaseAnnouncementVersion')
    const storedBody = configService.get('releaseAnnouncementBody')
    const storedNotes = configService.get('releaseAnnouncementNotes')

    if (
      storedVersion === version &&
      storedBody === releaseBody &&
      storedNotes === releaseNotes
    ) {
      return
    }

    configService.set('releaseAnnouncementVersion', version)
    configService.set('releaseAnnouncementBody', releaseBody)
    configService.set('releaseAnnouncementNotes', releaseNotes)
    ctx.getLogService()?.info('ReleaseAnnouncement', '已同步本地版本公告', {
      version,
      hasBody: Boolean(releaseBody),
      hasNotes: Boolean(releaseNotes)
    })
  } catch (error) {
    ctx.getLogService()?.warn('ReleaseAnnouncement', '同步本地版本公告失败', { error: String(error) })
  }
}

function getThemeQueryParams(ctx: MainProcessContext): string {
  const configService = ctx.getConfigService()
  if (!configService) return ''
  const theme = configService.get('theme') || 'cloud-dancer'
  const themeMode = configService.get('themeMode') || 'light'
  return `theme=${encodeURIComponent(theme)}&mode=${encodeURIComponent(themeMode)}`
}

function getThemeQuery(ctx: MainProcessContext): Record<string, string> {
  const configService = ctx.getConfigService()
  return {
    theme: configService?.get('theme') || 'cloud-dancer',
    mode: configService?.get('themeMode') || 'light'
  }
}

function getAppIconPath(ctx: MainProcessContext): string {
  const isDev = !!process.env.VITE_DEV_SERVER_URL

  if (process.platform === 'darwin') {
    return isDev
      ? join(__dirname, '../public/icon.icns')
      : join(process.resourcesPath, 'icon.icns')
  }

  return isDev
    ? join(__dirname, '../public/icon.ico')
    : join(process.resourcesPath, 'icon.ico')
}

function loadNativeImageIfValid(iconPath: string, purpose: string): ReturnType<typeof nativeImage.createFromPath> | null {
  if (!existsSync(iconPath)) {
    console.warn(`[Icon] ${purpose} not found: ${iconPath}`)
    return null
  }

  try {
    const image = nativeImage.createFromPath(iconPath)
    if (image.isEmpty()) {
      console.warn(`[Icon] ${purpose} failed to load: ${iconPath}`)
      return null
    }
    return image
  } catch (error) {
    console.warn(`[Icon] ${purpose} failed to load: ${iconPath}`, error)
    return null
  }
}

function getWindowIconOptions(ctx: MainProcessContext): Pick<BrowserWindowConstructorOptions, 'icon'> {
  if (process.platform === 'darwin') return {}

  const image = loadNativeImageIfValid(getAppIconPath(ctx), 'window icon')
  return image ? { icon: image } : {}
}

function getDockIconPath(ctx: MainProcessContext): string {
  const isDev = !!process.env.VITE_DEV_SERVER_URL
  const devPaddedPath = join(__dirname, '../public/icon-dock.png')
  const devFallbackPath = join(__dirname, '../public/logo.png')
  return isDev
    ? (existsSync(devPaddedPath) ? devPaddedPath : devFallbackPath)
    : join(process.resourcesPath, 'icon.png')
}

function getTrayIconPath(ctx: MainProcessContext): string {
  if (process.platform === 'darwin') {
    const isDev = !!process.env.VITE_DEV_SERVER_URL
    const devTrayPath = join(__dirname, '../public/tray-mac.png')

    if (isDev && existsSync(devTrayPath)) return devTrayPath
  }

  return getAppIconPath(ctx)
}

function getTrayImage(ctx: MainProcessContext) {
  const iconPath = getTrayIconPath(ctx)
  const image = loadNativeImageIfValid(iconPath, 'tray icon')

  if (!image) return nativeImage.createEmpty()
  if (process.platform === 'darwin') return image.resize({ height: 26 })
  return image
}

function setupDevToolsShortcut(win: BrowserWindow, getTargetWindow?: () => BrowserWindow | null): void {
  if (!process.env.VITE_DEV_SERVER_URL) return

  win.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
      const target = getTargetWindow?.() || win
      if (target.webContents.isDevToolsOpened()) {
        target.webContents.closeDevTools()
      } else {
        target.webContents.openDevTools()
      }
      event.preventDefault()
    }
  })
}

function loadWindowRoute(
  ctx: MainProcessContext,
  win: BrowserWindow,
  hash: string,
  query?: Record<string, string>,
  devQueryPrefix = true
): void {
  const themeParams = getThemeQueryParams(ctx)

  if (process.env.VITE_DEV_SERVER_URL) {
    const queryString = devQueryPrefix ? `?${themeParams}` : ''
    win.loadURL(`${process.env.VITE_DEV_SERVER_URL}${queryString}#${hash}`)
    setupDevToolsShortcut(win)
    return
  }

  win.loadFile(join(__dirname, '../dist/index.html'), {
    hash,
    query: query || getThemeQuery(ctx)
  })
}

function getImageViewerQueryParams(
  ctx: MainProcessContext,
  imagePath: string,
  liveVideoPath?: string,
  options?: ImageViewerOpenOptions
): string {
  const themeParams = getThemeQueryParams(ctx)
  const imageParam = `imagePath=${encodeURIComponent(imagePath)}`
  const liveVideoParam = liveVideoPath ? `&liveVideoPath=${encodeURIComponent(liveVideoPath)}` : ''
  const sessionParam = options?.sessionId ? `&sessionId=${encodeURIComponent(options.sessionId)}` : ''
  const imageMd5Param = options?.imageMd5 ? `&imageMd5=${encodeURIComponent(options.imageMd5)}` : ''
  const imageDatNameParam = options?.imageDatName ? `&imageDatName=${encodeURIComponent(options.imageDatName)}` : ''
  return `${themeParams}&${imageParam}${liveVideoParam}${sessionParam}${imageMd5Param}${imageDatNameParam}`
}

export function createWindowManager(ctx: MainProcessContext): WindowManager {
  let chatWindow: BrowserWindow | null = null
  let momentsWindow: BrowserWindow | null = null
  let agreementWindow: BrowserWindow | null = null
  let purchaseWindow: BrowserWindow | null = null
  let welcomeWindow: BrowserWindow | null = null
  let chatHistoryWindow: BrowserWindow | null = null
  let petWindow: BrowserWindow | null = null
  let petBaseBounds: { x: number; y: number; width: number; height: number } | null = null
  // 桌宠基础尺寸（与 openPetWindow 一致）；显示消息气泡时临时向上/左扩窗腾出空间
  const PET_BASE_WIDTH = 150
  const PET_BASE_HEIGHT = 170
  const PET_BUBBLE_WIDTH = 300
  const PET_BUBBLE_HEIGHT = 320
  let petBubbleExpanded = false
  // 程序化 setBounds 会触发 'move'，用时间窗抑制，避免桌宠误判成拖动而播跑动画
  let petSuppressMoveUntil = 0
  let lastPetContextMenuAt = 0

  const closePetWindowInternal = (): void => {
    if (petWindow && !petWindow.isDestroyed()) {
      petWindow.close()
    }
    petWindow = null
    petBaseBounds = null
    petBubbleExpanded = false
  }

  const disablePetDesktopWindow = (): void => {
    closePetWindowInternal()
    ctx.getConfigService()?.set('petDesktopEnabled', false)
    ctx.broadcastToWindows('config:changed', { key: 'petDesktopEnabled', value: false })
  }

  const showPetContextMenu = (): void => {
    if (!petWindow || petWindow.isDestroyed()) return
    const now = Date.now()
    if (now - lastPetContextMenuAt < 150) return
    lastPetContextMenuAt = now
    petWindow.webContents.send('pet:contextMenuOpened')
    const menu = Menu.buildFromTemplate([
      {
        label: '退出宠物',
        click: disablePetDesktopWindow
      }
    ])
    menu.popup({ window: petWindow })
  }

  const createTray = (): Tray | null => {
    const existingTray = ctx.getTray()
    if (existingTray) return existingTray

    let tray: Tray
    try {
      tray = new Tray(getTrayImage(ctx))
    } catch (error) {
      console.warn('[Icon] tray creation failed:', error)
      return null
    }

    ctx.setTray(tray)

    if (process.platform === 'darwin') {
      tray.setIgnoreDoubleClickEvents(true)
    }

    const showMainWindow = () => {
      const mainWindow = ctx.getMainWindow()
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    }

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: showMainWindow
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          ctx.appWithQuitFlag.isQuitting = true
          app.quit()
        }
      }
    ])

    tray.setToolTip('密语 CipherTalk')
    tray.setContextMenu(contextMenu)
    tray.on('double-click', showMainWindow)

    return tray
  }

  const manager: WindowManager = {
    createMainWindow() {
      const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: '#1a1a1a',
          height: 40
        },
        show: false
      })

      attachWindowStartupDiagnostics(win, 'main')
      ctx.setMainWindow(win)
      markStartupMilestone('window:main-services-init-start')
      const configService = ctx.getConfigService() ?? new ConfigService()
      ctx.setConfigService(configService)
      ctx.setDbService(new DatabaseService())

      const logService = new LogService(configService)
      ctx.setLogService(logService)
      syncPackagedReleaseAnnouncement(ctx)
      mcpProxyService.setLogger(logService)
      autoUpdater.logger = {
        info(message: string) {
          logService.info('AppUpdate', message)
          appUpdateService.noteUpdaterMessage(String(message), 'info')
        },
        warn(message: string) {
          logService.warn('AppUpdate', message)
          appUpdateService.noteUpdaterMessage(String(message), 'warn')
        },
        error(message: string) {
          logService.error('AppUpdate', message)
          appUpdateService.noteUpdaterMessage(String(message), 'error')
        },
        debug(message: string) {
          logService.debug('AppUpdate', message)
          appUpdateService.noteUpdaterMessage(String(message), 'info')
        }
      }
      logService.info('App', '应用启动', { version: app.getVersion() })
      markStartupMilestone('window:main-services-init-done')

      const cachePath = configService.get('cachePath')
      if (cachePath) {
        voiceTranscribeServiceWhisper.setGPUComponentsDir(cachePath)
      }

      win.once('ready-to-show', () => {
        win.show()
      })

      win.on('close', (event) => {
        const updateInfo = appUpdateService.getCachedUpdateInfo()
        if (updateInfo?.forceUpdate || ctx.getIsInstallingUpdate()) {
          ctx.appWithQuitFlag.isQuitting = true
          return
        }

        if (ctx.appWithQuitFlag.isQuitting) return

        const closeToTray = ctx.getConfigService()?.get('closeToTray')
        if (closeToTray !== false) {
          event.preventDefault()
          win.hide()
          if (!ctx.getTray()) createTray()
          return
        }

        event.preventDefault()
        ctx.appWithQuitFlag.isQuitting = true
        app.quit()
      })

      if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(process.env.VITE_DEV_SERVER_URL)
        setupDevToolsShortcut(win)
      } else {
        win.loadFile(join(__dirname, '../dist/index.html'))
      }

      return win
    },

    createSplashWindow() {
      const splash = new BrowserWindow({
        width: 460,
        height: 300,
        ...getWindowIconOptions(ctx),
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        resizable: false,
        skipTaskbar: true,
        hasShadow: false,
        show: true,
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        backgroundColor: '#00000000'
      })

      attachWindowStartupDiagnostics(splash, 'splash')
      ctx.setSplashWindow(splash)
      splash.center()

      if (process.env.VITE_DEV_SERVER_URL) {
        splash.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/splash`).catch(() => undefined)
      } else {
        splash.loadFile(join(__dirname, '../dist/index.html'), { hash: '/splash' }).catch(() => undefined)
      }

      return splash
    },

    async closeSplashWindow() {
      const splashWindow = ctx.getSplashWindow()
      if (!splashWindow || splashWindow.isDestroyed()) {
        ctx.setSplashWindow(null)
        return
      }

      splashWindow.webContents.send('splash:fadeOut')
      await new Promise(resolve => setTimeout(resolve, 350))

      const currentSplashWindow = ctx.getSplashWindow()
      if (currentSplashWindow && !currentSplashWindow.isDestroyed()) {
        currentSplashWindow.close()
        ctx.setSplashWindow(null)
      }
    },

    createTray,

    destroyTray() {
      const tray = ctx.getTray()
      if (tray) {
        tray.destroy()
        ctx.setTray(null)
      }
    },

    setDockIcon() {
      if (process.platform !== 'darwin') return

      const dockIconPath = getDockIconPath(ctx)
      if (!existsSync(dockIconPath)) return

      const dockIcon = nativeImage.createFromPath(dockIconPath)
      if (!dockIcon.isEmpty()) {
        app.dock?.setIcon(dockIcon)
      }
    },

    openChatWindow() {
      if (chatWindow && !chatWindow.isDestroyed()) {
        if (chatWindow.isMinimized()) chatWindow.restore()
        chatWindow.focus()
        return chatWindow
      }

      const isDark = nativeTheme.shouldUseDarkColors
      chatWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: '#666666',
          height: 40
        },
        show: false,
        backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0'
      })

      chatWindow.once('ready-to-show', () => chatWindow?.show())
      loadWindowRoute(ctx, chatWindow, '/chat-window')
      chatWindow.on('closed', () => {
        chatWindow = null
      })
      return chatWindow
    },

    openMomentsWindow(filterUsername?: string) {
      if (momentsWindow && !momentsWindow.isDestroyed()) {
        if (momentsWindow.isMinimized()) momentsWindow.restore()
        momentsWindow.focus()
        if (filterUsername) {
          momentsWindow.webContents.send('moments:filterUser', filterUsername)
        }
        return momentsWindow
      }

      const isDark = nativeTheme.shouldUseDarkColors
      momentsWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: '#666666',
          height: 40
        },
        show: false,
        backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0'
      })

      momentsWindow.once('ready-to-show', () => momentsWindow?.show())

      const filterParam = filterUsername ? `&filterUsername=${encodeURIComponent(filterUsername)}` : ''
      if (process.env.VITE_DEV_SERVER_URL) {
        momentsWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${getThemeQueryParams(ctx)}${filterParam}#/moments-window`)
        setupDevToolsShortcut(momentsWindow)
      } else {
        const query = getThemeQuery(ctx)
        if (filterUsername) query.filterUsername = filterUsername
        momentsWindow.loadFile(join(__dirname, '../dist/index.html'), {
          hash: '/moments-window',
          query
        })
      }

      momentsWindow.on('closed', () => {
        momentsWindow = null
      })
      return momentsWindow
    },

    openChatHistoryWindow(sessionId: string, messageId: number) {
      if (chatHistoryWindow && !chatHistoryWindow.isDestroyed()) {
        if (chatHistoryWindow.isMinimized()) chatHistoryWindow.restore()
        chatHistoryWindow.focus()

        if (process.env.VITE_DEV_SERVER_URL) {
          chatHistoryWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${getThemeQueryParams(ctx)}#/chat-history/${sessionId}/${messageId}`)
        } else {
          chatHistoryWindow.loadFile(join(__dirname, '../dist/index.html'), {
            hash: `/chat-history/${sessionId}/${messageId}`,
            query: getThemeQuery(ctx)
          })
        }
        return chatHistoryWindow
      }

      const isDark = nativeTheme.shouldUseDarkColors
      chatHistoryWindow = new BrowserWindow({
        width: 600,
        height: 800,
        minWidth: 400,
        minHeight: 500,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: isDark ? '#ffffff' : '#1a1a1a',
          height: 40
        },
        show: false,
        backgroundColor: isDark ? '#1A1A1A' : '#F0F0F0',
        autoHideMenuBar: true
      })

      chatHistoryWindow.once('ready-to-show', () => chatHistoryWindow?.show())

      if (process.env.VITE_DEV_SERVER_URL) {
        chatHistoryWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}?${getThemeQueryParams(ctx)}#/chat-history/${sessionId}/${messageId}`)
        setupDevToolsShortcut(chatHistoryWindow, () => chatHistoryWindow)
      } else {
        chatHistoryWindow.loadFile(join(__dirname, '../dist/index.html'), {
          hash: `/chat-history/${sessionId}/${messageId}`,
          query: getThemeQuery(ctx)
        })
      }

      chatHistoryWindow.on('closed', () => {
        chatHistoryWindow = null
      })
      return chatHistoryWindow
    },

    openAgreementWindow() {
      if (agreementWindow && !agreementWindow.isDestroyed()) {
        agreementWindow.focus()
        return agreementWindow
      }

      const isDark = nativeTheme.shouldUseDarkColors
      agreementWindow = new BrowserWindow({
        width: 800,
        height: 700,
        minWidth: 600,
        minHeight: 500,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: isDark ? '#FFFFFF' : '#333333',
          height: 40
        },
        show: false,
        backgroundColor: isDark ? '#1A1A1A' : '#FFFFFF'
      })

      agreementWindow.once('ready-to-show', () => agreementWindow?.show())
      loadWindowRoute(ctx, agreementWindow, '/agreement-window')
      agreementWindow.on('closed', () => {
        agreementWindow = null
      })
      return agreementWindow
    },

    openWelcomeWindow(mode: 'default' | 'add-account' = 'default') {
      if (welcomeWindow && !welcomeWindow.isDestroyed()) {
        welcomeWindow.focus()
        return welcomeWindow
      }

      welcomeWindow = new BrowserWindow({
        width: 1100,
        height: 760,
        minWidth: 900,
        minHeight: 640,
        frame: true,
        transparent: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1A1A1A' : '#FFFFFF',
        hasShadow: true,
        autoHideMenuBar: true,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        show: false
      })

      attachWindowStartupDiagnostics(welcomeWindow, 'welcome')
      welcomeWindow.once('ready-to-show', () => welcomeWindow?.show())

      const welcomeHash = mode === 'add-account' ? '/welcome-window?mode=add-account' : '/welcome-window'
      if (process.env.VITE_DEV_SERVER_URL) {
        welcomeWindow.loadURL(`${process.env.VITE_DEV_SERVER_URL}#${welcomeHash}`)
      } else {
        welcomeWindow.loadFile(join(__dirname, '../dist/index.html'), { hash: welcomeHash })
      }

      welcomeWindow.on('closed', () => {
        welcomeWindow = null
      })
      return welcomeWindow
    },

    openPurchaseWindow() {
      if (purchaseWindow && !purchaseWindow.isDestroyed()) {
        purchaseWindow.focus()
        return purchaseWindow
      }

      purchaseWindow = new BrowserWindow({
        width: 1000,
        height: 700,
        minWidth: 800,
        minHeight: 600,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        title: '获取激活码 - 密语',
        show: false,
        backgroundColor: '#FFFFFF',
        autoHideMenuBar: true
      })

      purchaseWindow.once('ready-to-show', () => purchaseWindow?.show())
      purchaseWindow.loadURL('https://pay.ldxp.cn/shop/aiqiji')
      purchaseWindow.on('closed', () => {
        purchaseWindow = null
      })
      return purchaseWindow
    },

    openImageViewerWindow(imagePath: string, liveVideoPath?: string, options?: ImageViewerOpenOptions) {
      const win = new BrowserWindow({
        width: 800,
        height: 600,
        minWidth: 560,
        minHeight: 300,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#00000000',
          symbolColor: '#ffffff',
          height: 40
        },
        show: false,
        backgroundColor: '#000000',
        autoHideMenuBar: true
      })

      win.once('ready-to-show', () => win.show())
      const queryParams = getImageViewerQueryParams(ctx, imagePath, liveVideoPath, options)
      if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/image-viewer-window?${queryParams}`)
        setupDevToolsShortcut(win)
      } else {
        win.loadFile(join(__dirname, '../dist/index.html'), {
          hash: `/image-viewer-window?${queryParams}`
        })
      }

      return win
    },

    openVideoPlayerWindow(videoPath: string, videoWidth?: number, videoHeight?: number) {
      const { screen } = require('electron')
      const primaryDisplay = screen.getPrimaryDisplay()
      const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize

      let winWidth = 854
      let winHeight = 520
      const titleBarHeight = 40

      if (videoWidth && videoHeight && videoWidth > 0 && videoHeight > 0) {
        const aspectRatio = videoWidth / videoHeight
        const maxWidth = Math.floor(screenWidth * 0.85)
        const maxHeight = Math.floor(screenHeight * 0.85)

        if (aspectRatio >= 1) {
          winWidth = Math.min(videoWidth, maxWidth)
          winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight
          if (winHeight > maxHeight) {
            winHeight = maxHeight
            winWidth = Math.floor((winHeight - titleBarHeight) * aspectRatio)
          }
        } else {
          const videoDisplayHeight = Math.min(videoHeight, maxHeight - titleBarHeight)
          winHeight = videoDisplayHeight + titleBarHeight
          winWidth = Math.floor(videoDisplayHeight * aspectRatio)
          if (winWidth < 300) {
            winWidth = 300
            winHeight = Math.floor(winWidth / aspectRatio) + titleBarHeight
          }
        }

        winWidth = Math.max(winWidth, 360)
        winHeight = Math.max(winHeight, 280)
      }

      const win = new BrowserWindow({
        width: winWidth,
        height: winHeight,
        minWidth: 360,
        minHeight: 280,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#1a1a1a',
          symbolColor: '#ffffff',
          height: 40
        },
        show: false,
        backgroundColor: '#000000',
        autoHideMenuBar: true
      })

      win.once('ready-to-show', () => win.show())
      const queryParams = `${getThemeQueryParams(ctx)}&videoPath=${encodeURIComponent(videoPath)}`
      if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/video-player-window?${queryParams}`)
        setupDevToolsShortcut(win)
      } else {
        win.loadFile(join(__dirname, '../dist/index.html'), {
          hash: `/video-player-window?${queryParams}`
        })
      }

      return win
    },

    openBrowserWindow(url: string, title?: string) {
      const win = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        ...getWindowIconOptions(ctx),
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false,
          webviewTag: true
        },
        titleBarStyle: 'hidden',
        titleBarOverlay: {
          color: '#1a1a1a',
          symbolColor: '#ffffff',
          height: 40
        },
        show: false,
        backgroundColor: '#ffffff',
        title: title || '浏览器'
      })

      win.once('ready-to-show', () => win.show())
      const queryParams = `${getThemeQueryParams(ctx)}&url=${encodeURIComponent(url)}${title ? `&title=${encodeURIComponent(title)}` : ''}`
      if (process.env.VITE_DEV_SERVER_URL) {
        win.loadURL(`${process.env.VITE_DEV_SERVER_URL}#/browser-window?${queryParams}`)
        setupDevToolsShortcut(win)
      } else {
        win.loadFile(join(__dirname, '../dist/index.html'), {
          hash: `/browser-window?${queryParams}`
        })
      }

      return win
    },

    completeWelcome() {
      if (welcomeWindow && !welcomeWindow.isDestroyed()) {
        welcomeWindow.close()
      }

      const mainWindow = ctx.getMainWindow()
      if (!mainWindow || mainWindow.isDestroyed()) {
        manager.createMainWindow()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }

      return true
    },

    isChatWindowOpen() {
      return chatWindow !== null && !chatWindow.isDestroyed()
    },

    closeChatWindow() {
      if (chatWindow && !chatWindow.isDestroyed()) {
        chatWindow.close()
        chatWindow = null
      }
      return true
    },

    openPetWindow() {
      if (petWindow && !petWindow.isDestroyed()) {
        petWindow.show()
        return petWindow
      }

      // 默认落在主屏右下角（任务栏上方），透明无边框，靠 CSS app-region 拖动
      const { workArea } = screen.getPrimaryDisplay()
      const width = 150
      const height = 170
      petWindow = new BrowserWindow({
        width,
        height,
        x: workArea.x + workArea.width - width - 24,
        y: workArea.y + workArea.height - height - 16,
        frame: false,
        transparent: true,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        webPreferences: {
          preload: join(__dirname, 'preload.js'),
          devTools: ctx.allowDevTools,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: false
        }
      })

      petWindow.setAlwaysOnTop(true, 'screen-saver')
      petWindow.once('ready-to-show', () => petWindow?.show())
      loadWindowRoute(ctx, petWindow, '/pet-window')

      petWindow.on('system-context-menu', (event) => {
        event.preventDefault()
        showPetContextMenu()
      })

      petWindow.webContents.on('context-menu', (event) => {
        event.preventDefault()
        showPetContextMenu()
      })

      // 拖动时把窗口横坐标转发给渲染端，宠物按移动方向播跑/跳动画
      petWindow.on('move', () => {
        if (!petWindow || petWindow.isDestroyed()) return
        if (Date.now() < petSuppressMoveUntil) return // 程序化扩窗，非用户拖动
        petWindow.webContents.send('pet:windowMove', petWindow.getPosition()[0])
      })

      petWindow.on('closed', () => {
        petWindow = null
      })
      return petWindow
    },

    closePetWindow() {
      closePetWindowInternal()
    },

    isPetWindowOpen() {
      return petWindow !== null && !petWindow.isDestroyed()
    },

    showPetContextMenu() {
      showPetContextMenu()
    },

    // 显示消息气泡时向右下角锚点扩窗腾出气泡空间，气泡消失后还原。仅尺寸变化，桌宠仍停在原处。
    setPetBubbleExpanded(expanded: boolean) {
      if (!petWindow || petWindow.isDestroyed()) return
      if (expanded === petBubbleExpanded) return
      petBubbleExpanded = expanded

      const b = petWindow.getBounds()
      const display = screen.getDisplayMatching(b)
      const { workArea } = display
      if (expanded) {
        petBaseBounds = { x: b.x, y: b.y, width: PET_BASE_WIDTH, height: PET_BASE_HEIGHT }
      }
      const base = petBaseBounds ?? { x: b.x, y: b.y, width: PET_BASE_WIDTH, height: PET_BASE_HEIGHT }
      const baseX = base.x
      const baseY = base.y
      const baseRight = baseX + PET_BASE_WIDTH
      const baseBottom = baseY + PET_BASE_HEIGHT
      const width = expanded ? PET_BUBBLE_WIDTH : PET_BASE_WIDTH
      const height = expanded ? PET_BUBBLE_HEIGHT : PET_BASE_HEIGHT
      const minX = workArea.x
      const minY = workArea.y
      const maxX = Math.max(minX, workArea.x + workArea.width - width)
      const maxY = Math.max(minY, workArea.y + workArea.height - height)
      const preferredX = expanded ? baseRight - width : baseX
      const preferredY = expanded ? baseBottom - height : baseY
      const x = Math.min(Math.max(preferredX, minX), maxX)
      const y = Math.min(Math.max(preferredY, minY), maxY)

      petSuppressMoveUntil = Date.now() + 400
      petWindow.setBounds({
        x,
        y,
        width,
        height,
      })
      petWindow.webContents.send('pet:bubbleFrame', {
        expanded,
        baseLeft: baseX - x,
        baseTop: baseY - y,
        baseWidth: PET_BASE_WIDTH,
        baseHeight: PET_BASE_HEIGHT,
      })
      if (!expanded) {
        petBaseBounds = null
      }
    }
  }

  return manager
}
