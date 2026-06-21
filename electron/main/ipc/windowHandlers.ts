import { BrowserWindow, ipcMain } from 'electron'
import type { ImageViewerListItem, ImageViewerOpenOptions, MainProcessContext } from '../context'

type TitleBarOverlayState = {
  hidden: boolean
  symbolColor: string
}

const titleBarOverlayStates = new WeakMap<BrowserWindow, TitleBarOverlayState>()

function shouldForceHideMacWindowButtons(win: BrowserWindow): boolean {
  const url = win.webContents.getURL()
  return url.includes('#/splash') || url.includes('#/pet-window')
}

function applyTitleBarOverlay(win: BrowserWindow, state: TitleBarOverlayState) {
  try {
    if (process.platform === 'darwin') {
      if (shouldForceHideMacWindowButtons(win)) {
        win.setWindowButtonVisibility(false)
        win.setWindowButtonPosition({ x: -100, y: -100 })
        return
      }

      win.setWindowButtonVisibility(!state.hidden)
      return
    }

    win.setTitleBarOverlay({
      color: '#00000000',
      symbolColor: state.hidden ? '#00000000' : state.symbolColor,
      height: state.hidden ? 0 : 40
    })
  } catch {
    // 某些窗口未启用 titleBarOverlay。
  }
}

export function registerWindowHandlers(ctx: MainProcessContext): void {
  ipcMain.on('window:splashReady', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && process.platform === 'darwin' && shouldForceHideMacWindowButtons(win)) {
      win.setWindowButtonVisibility(false)
      win.setWindowButtonPosition({ x: -100, y: -100 })
    }
    ctx.setSplashReady(true)
  })

  ipcMain.on('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })

  ipcMain.on('window:maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win?.isMaximized()) {
      win.unmaximize()
    } else {
      win?.maximize()
    }
  })

  ipcMain.on('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  ipcMain.handle(
    'window:openImageViewerWindow',
    (
      _,
      imagePath: string,
      liveVideoPath?: string,
      imageList?: ImageViewerListItem[],
      options?: ImageViewerOpenOptions
    ) => {
      const win = ctx.getWindowManager().openImageViewerWindow(imagePath, liveVideoPath, options)
      if (imageList && imageList.length > 1) {
        const currentIndex = imageList.findIndex(item => item.imagePath === imagePath)
        win.webContents.once('did-finish-load', () => {
          if (!win.isDestroyed()) {
            win.webContents.send('imageViewer:setImageList', {
              imageList,
              currentIndex: currentIndex >= 0 ? currentIndex : 0
            })
          }
        })
      }
    }
  )

  ipcMain.handle('window:openVideoPlayerWindow', (_, videoPath: string, videoWidth?: number, videoHeight?: number) => {
    ctx.getWindowManager().openVideoPlayerWindow(videoPath, videoWidth, videoHeight)
  })

  ipcMain.handle('window:resizeToFitVideo', (event, videoWidth: number, videoHeight: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || !videoWidth || !videoHeight) return

    const { screen } = require('electron')
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize
    const titleBarHeight = 40
    const aspectRatio = videoWidth / videoHeight
    const maxWidth = Math.floor(screenWidth * 0.85)
    const maxHeight = Math.floor(screenHeight * 0.85)

    let winWidth: number
    let winHeight: number

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

    win.setSize(winWidth, winHeight)
    win.center()
  })

  ipcMain.handle('window:openBrowserWindow', (_, url: string, title?: string) => {
    ctx.getWindowManager().openBrowserWindow(url, title)
  })

  ipcMain.handle('window:openChatHistoryWindow', (_, sessionId: string, messageId: number) => {
    ctx.getWindowManager().openChatHistoryWindow(sessionId, messageId)
    return true
  })

  ipcMain.on('window:setTitleBarOverlay', (event, options: { hidden?: boolean; symbolColor?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      const currentState = titleBarOverlayStates.get(win) ?? {
        hidden: false,
        symbolColor: '#1a1a1a'
      }
      const nextState = {
        hidden: typeof options.hidden === 'boolean' ? options.hidden : currentState.hidden,
        symbolColor: options.symbolColor ?? currentState.symbolColor
      }

      titleBarOverlayStates.set(win, nextState)
      applyTitleBarOverlay(win, nextState)
    }
  })

  ipcMain.handle('window:openChatWindow', async () => {
    ctx.getWindowManager().openChatWindow()
    return true
  })

  ipcMain.handle('window:openMomentsWindow', async (_event, filterUsername?: string) => {
    ctx.getWindowManager().openMomentsWindow(filterUsername)
    return true
  })

  ipcMain.handle('window:openPersonaChatWindow', async (_event, sessionId: string) => {
    ctx.getWindowManager().openPersonaChatWindow(String(sessionId || '').trim())
    return true
  })

  ipcMain.handle('window:openPosterStyleWindow', async () => {
    ctx.getWindowManager().openPosterStyleWindow()
    return true
  })

  ipcMain.handle('window:openAgreementWindow', async () => {
    ctx.getWindowManager().openAgreementWindow()
    return true
  })

  ipcMain.handle('window:openPurchaseWindow', async () => {
    ctx.getWindowManager().openPurchaseWindow()
    return true
  })

  ipcMain.handle('window:openWelcomeWindow', async (_, mode?: 'default' | 'add-account') => {
    ctx.getWindowManager().openWelcomeWindow(mode || 'default')
    return true
  })

  ipcMain.handle('window:completeWelcome', async () => {
    return ctx.getWindowManager().completeWelcome()
  })

  ipcMain.handle('window:isChatWindowOpen', async () => {
    return ctx.getWindowManager().isChatWindowOpen()
  })

  ipcMain.handle('window:closeChatWindow', async () => {
    return ctx.getWindowManager().closeChatWindow()
  })

  ipcMain.handle('window:resizeContent', async (event, width: number, height: number) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win) {
      const { screen } = require('electron')
      const currentScreen = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      const workArea = currentScreen.workAreaSize
      const maxWidth = Math.floor(workArea.width * 0.85)
      const maxHeight = Math.floor(workArea.height * 0.85)

      let targetWidth = width
      let targetHeight = height

      if (targetWidth > maxWidth || targetHeight > maxHeight) {
        const ratio = Math.min(maxWidth / targetWidth, maxHeight / targetHeight)
        targetWidth = Math.floor(targetWidth * ratio)
        targetHeight = Math.floor(targetHeight * ratio)
      }

      const finalWidth = Math.max(targetWidth, 560)
      const finalHeight = Math.max(targetHeight, 300)

      win.setSize(finalWidth, finalHeight)
      win.center()
    }
    return true
  })

  ipcMain.on('window:move', (event, { x, y }) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (win && !win.isDestroyed()) {
      const bounds = win.getBounds()
      win.setBounds({
        x: bounds.x + x,
        y: bounds.y + y,
        width: bounds.width,
        height: bounds.height
      })
    }
  })
}
