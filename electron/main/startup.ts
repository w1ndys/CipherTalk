import { net } from 'electron'
import { ConfigService } from '../services/config'
import { appUpdateService } from '../services/appUpdateService'
import { chatService } from '../services/chatService'
import { httpApiService } from '../services/httpApiService'
import { getMcpProxyConfig } from '../services/mcp/runtime'
import { mcpProxyService } from '../services/mcp/proxyService'
import { mcpClientService } from '../services/mcpClientService'
import { wcdbService } from '../services/wcdbService'
import { monitorBridge } from '../services/monitorBridge'
import { logStartupError, markStartupMilestone, warnStartupMilestone } from './startupDiagnostics'
import type { MainProcessContext } from './context'

async function waitForDevServer(url: string, maxWait = 15000, interval = 300): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < maxWait) {
    try {
      const response = await net.fetch(url)
      if (response.ok) return true
    } catch {
      // 开发服务器还没就绪，继续轮询。
    }
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  return false
}

function ensureConfigService(ctx: MainProcessContext): ConfigService {
  const current = ctx.getConfigService()
  if (current) return current

  markStartupMilestone('startup:ensure-config-create-start')
  const configService = new ConfigService()
  ctx.setConfigService(configService)
  markStartupMilestone('startup:ensure-config-create-done')
  return configService
}

async function openConfiguredWcdb(dbPath: string, decryptKey: string, wxid: string): Promise<boolean> {
  try {
    markStartupMilestone('startup:wcdb-worker-init-start')
    await wcdbService.initWorker()
    markStartupMilestone('startup:wcdb-worker-init-done')
    markStartupMilestone('startup:wcdb-open-start', { wxid, dbPath })
    const connected = await wcdbService.open(dbPath, decryptKey, wxid)
    markStartupMilestone('startup:wcdb-open-done', { connected })
    return connected
  } catch (e) {
    logStartupError('startup:wcdb-open-failed', e)
    console.error('[startup] WCDB 启动连接失败:', (e as Error)?.message || e)
    return false
  }
}

/**
 * 启动阶段数据库连接编排。
 * 配置不完整时打开引导窗口；配置完整时用启动屏承接连接过程，并把结果写回 context。
 */
export async function checkAndConnectOnStartup(ctx: MainProcessContext): Promise<boolean> {
  const configService = ensureConfigService(ctx)

  const wxid = configService.get('myWxid')
  const dbPath = configService.get('dbPath')
  const decryptKey = configService.get('decryptKey')
  markStartupMilestone('startup:config-snapshot', {
    hasWxid: Boolean(wxid),
    hasDbPath: Boolean(dbPath),
    hasDecryptKey: Boolean(decryptKey)
  })

  if (!wxid || !dbPath || !decryptKey) {
    markStartupMilestone('startup:welcome-window-open-start')
    ctx.getWindowManager().openWelcomeWindow()
    markStartupMilestone('startup:welcome-window-open-done')
    return false
  }

  if (process.env.VITE_DEV_SERVER_URL) {
    markStartupMilestone('startup:dev-server-wait-start')
    const serverReady = await waitForDevServer(process.env.VITE_DEV_SERVER_URL)
    markStartupMilestone('startup:dev-server-wait-done', { serverReady })
    if (!serverReady) {
      try {
        const connected = await openConfiguredWcdb(String(dbPath), String(decryptKey), String(wxid))
        ctx.setStartupDbConnected(connected)
        return connected
      } catch {
        return false
      }
    }
  }

  markStartupMilestone('startup:splash-window-create-start')
  ctx.getWindowManager().createSplashWindow()
  markStartupMilestone('startup:splash-window-create-done')
  ctx.setSplashReady(false)

  return new Promise<boolean>((resolve) => {
    const checkReady = setInterval(() => {
      if (ctx.getSplashReady()) {
        clearInterval(checkReady)
        openConfiguredWcdb(String(dbPath), String(decryptKey), String(wxid)).then(async (connected) => {
          if (connected) {
            // 预加载会话、联系人和前 5 个会话的消息，最多等 5s 以免阻塞启动屏
            await Promise.race([
              chatService.preloadData(),
              new Promise<void>(resolve => setTimeout(resolve, 5000))
            ])
          }
          await ctx.getWindowManager().closeSplashWindow()
          ctx.setStartupDbConnected(connected)
          resolve(connected)
        }).catch(async (e) => {
          logStartupError('startup:configured-wcdb-connect-failed', e)
          console.error('启动时连接数据库失败:', e)
          await ctx.getWindowManager().closeSplashWindow()
          resolve(false)
        })
      }
    }, 100)

    // 超时保护：避免启动屏 IPC 没回来时应用卡在启动页。
    setTimeout(async () => {
      clearInterval(checkReady)
      const currentSplashWindow = ctx.getSplashWindow()
      if (currentSplashWindow && !currentSplashWindow.isDestroyed()) {
        await ctx.getWindowManager().closeSplashWindow()
      }
      if (!ctx.getSplashReady()) {
        warnStartupMilestone('startup:splash-ready-timeout')
        resolve(false)
      }
    }, 30000)
  })
}

/**
 * 启动时自动检测应用更新。
 * 只在生产环境触发，结果沿用 app:updateAvailable 推送给主窗口。
 */
export function checkForUpdatesOnStartup(ctx: MainProcessContext): void {
  if (process.env.VITE_DEV_SERVER_URL) {
    // 开发模式：推送一条模拟的更新通知，便于本地测试更新提示 UI（不会真实下载/安装）
    setTimeout(() => {
      const mainWindow = ctx.getMainWindow()
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:updateAvailable', appUpdateService.createSimulatedUpdateInfo())
      }
    }, 3000)
    return
  }

  setTimeout(async () => {
    try {
      const result = await appUpdateService.checkForUpdates()
      ctx.getLogService()?.info('AppUpdate', '启动时检查更新完成', {
        hasUpdate: result.hasUpdate,
        currentVersion: result.currentVersion,
        version: result.version,
        diagnostics: result.diagnostics
      })

      const mainWindow = ctx.getMainWindow()
      if (result.hasUpdate && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('app:updateAvailable', result)
      }
    } catch (error) {
      ctx.getLogService()?.error('AppUpdate', '启动时检查更新失败', { error: String(error) })
      console.error('启动时检查更新失败:', error)
    }
  }, 3000)
}

/**
 * 聊天自动同步和数据库变更监听。
 * 通过 wcdbService（WCDB Worker 代理）+ monitorBridge（native pipe 优先，fs.watch 兜底）
 * 订阅 db_storage 层的变更，再经 chatService.attachMonitor 转发给业务侧。
 */
export function startBackgroundSync(ctx: MainProcessContext): void {
  chatService.on('sessions-update-available', (sessions) => {
    ctx.broadcastToWindows('chat:sessions-updated', sessions)
  })

  // 初始化 WCDB Worker + 订阅变更。无配置时静默跳过，等待用户在 Welcome 页完成配置。
  void (async () => {
    const configService = ensureConfigService(ctx)
    const dbPath = String(configService.get('dbPath') || '').trim()
    const decryptKey = String(configService.get('decryptKey') || '').trim()
    const wxid = String(configService.get('myWxid') || '').trim()

    if (!dbPath || !decryptKey || !wxid) {
      // 首启未配置：不启动 monitor，由 Welcome 引导完成后再触发。
      markStartupMilestone('startup:background-sync-skip-unconfigured')
      return
    }

    try {
      markStartupMilestone('startup:background-wcdb-worker-init-start')
      await wcdbService.initWorker()
      markStartupMilestone('startup:background-wcdb-worker-init-done')
    } catch (e) {
      logStartupError('startup:background-wcdb-worker-init-failed', e)
      console.warn('[startup] wcdbService.initWorker 失败，monitor 将跳过:', (e as Error)?.message || e)
      return
    }

    let opened = false
    try {
      markStartupMilestone('startup:background-wcdb-open-start', { wxid, dbPath })
      opened = await wcdbService.open(dbPath, decryptKey, wxid)
      markStartupMilestone('startup:background-wcdb-open-done', { opened })
    } catch (e) {
      logStartupError('startup:background-wcdb-open-failed', e)
      console.warn('[startup] wcdbService.open 失败:', (e as Error)?.message || e)
      return
    }
    if (!opened) return

    let nativeOk = false
    try {
      markStartupMilestone('startup:background-monitor-native-start')
      nativeOk = await wcdbService.setMonitor()
      markStartupMilestone('startup:background-monitor-native-done', { nativeOk })
    } catch (e) {
      logStartupError('startup:background-monitor-native-failed', e)
      console.warn('[startup] wcdbService.setMonitor 异常，走 fs.watch 兜底:', (e as Error)?.message || e)
    }

    if (nativeOk) {
      monitorBridge.switchToNativePipe(wcdbService)
    } else {
      markStartupMilestone('startup:background-monitor-fs-start')
      await monitorBridge.start()
      markStartupMilestone('startup:background-monitor-fs-done')
    }

    // 把 monitorBridge 的 change 事件桥接给 chatService，供业务层订阅 'dbChange'。
    if (typeof (chatService as any).attachMonitor === 'function') {
      (chatService as any).attachMonitor(monitorBridge)
    }
  })()
}

/**
 * 启动本地 HTTP API、MCP 代理和 MCP 客户端连接恢复。
 * 这些服务依赖配置，但不依赖窗口实例，因此放在启动编排层统一管理。
 */
export async function startLocalIntegrationServices(ctx: MainProcessContext): Promise<void> {
  const configService = ctx.getConfigService()

  const httpApiEnabled = configService?.get('httpApiEnabled') ?? false
  const httpApiPort = configService?.get('httpApiPort') || 5031
  const httpApiToken = (configService?.get('httpApiToken') || '').toString()
  const configuredHttpApiListenMode = configService?.get('httpApiListenMode') === 'lan' ? 'lan' : 'localhost'
  const httpApiListenMode = configuredHttpApiListenMode === 'lan' && !httpApiToken ? 'localhost' : configuredHttpApiListenMode
  httpApiService.applySettings({
    enabled: Boolean(httpApiEnabled),
    port: Number(httpApiPort) || 5031,
    token: httpApiToken,
    listenMode: httpApiListenMode
  })
  markStartupMilestone('startup:http-api-start')
  const httpApiStartResult = await httpApiService.start()
  markStartupMilestone('startup:http-api-done', { success: httpApiStartResult.success })
  if (!httpApiStartResult.success) {
    warnStartupMilestone('startup:http-api-failed', { error: httpApiStartResult.error })
    console.error('[HttpApi] 启动失败:', httpApiStartResult.error)
  }

  const mcpProxyConfig = getMcpProxyConfig(configService ?? undefined)
  mcpProxyService.applySettings({
    host: mcpProxyConfig.host,
    port: mcpProxyConfig.port,
    token: mcpProxyConfig.token
  })
  markStartupMilestone('startup:mcp-proxy-start')
  const mcpProxyStartResult = await mcpProxyService.start()
  markStartupMilestone('startup:mcp-proxy-done', { success: mcpProxyStartResult.success })
  if (!mcpProxyStartResult.success) {
    warnStartupMilestone('startup:mcp-proxy-failed', { error: mcpProxyStartResult.error })
    console.error('[McpProxy] 启动失败:', mcpProxyStartResult.error)
    ctx.getLogService()?.error('McpProxy', '内部 MCP 代理启动失败', { error: mcpProxyStartResult.error })
  }
  markStartupMilestone('startup:mcp-client-restore-dispatch')
  mcpClientService.restoreSavedConnections().catch((e) => {
    logStartupError('startup:mcp-client-restore-failed', e)
    console.error('[McpClient] 自动恢复连接失败:', e)
  })

  try {
    const hasConfiguredAccount = Boolean(
      configService?.get('myWxid')
      && configService?.get('dbPath')
      && configService?.get('decryptKey')
    )
    if (!hasConfiguredAccount) {
      markStartupMilestone('startup:agent-db-init-skip-unconfigured')
      return
    }

    markStartupMilestone('startup:agent-db-init-start')
    const cachePath = configService?.get('cachePath') as string | undefined
    const { agentConversationDb } = await import('../services/agentConversationDb')
    agentConversationDb.init(cachePath || undefined)
    markStartupMilestone('startup:agent-db-init-done')
  } catch (e) {
    logStartupError('startup:agent-db-init-failed', e)
    console.error('[AgentConversationDb] 初始化失败:', e)
  }
}

export function stopLocalIntegrationServices(): void {
  httpApiService.stop().catch((e) => {
    console.error('[HttpApi] 停止失败:', e)
  })
  mcpProxyService.stop().catch((e) => {
    console.error('[McpProxy] 停止失败:', e)
  })
  mcpClientService.disconnectAll(false).catch((e) => {
    console.error('[McpClient] 停止失败:', e)
  })
}
