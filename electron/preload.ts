import { contextBridge, ipcRenderer } from 'electron'
import type { AccountProfile } from '../src/types/account'

function getMcpLaunchConfigSafe(): Promise<{
  command: string
  args: string[]
  cwd: string
  mode: 'dev' | 'packaged'
} | null> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const responseChannel = `app:getMcpLaunchConfig:response:${requestId}`
    const timeout = setTimeout(() => {
      ipcRenderer.removeAllListeners(responseChannel)
      resolve(null)
    }, 600)

    ipcRenderer.once(responseChannel, (_, payload) => {
      clearTimeout(timeout)
      resolve(payload ?? null)
    })

    ipcRenderer.send('app:getMcpLaunchConfig:request', { requestId })
  })
}

// 暴露给渲染进程的 API
contextBridge.exposeInMainWorld('electronAPI', {
  // 配置
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
    getTldCache: () => ipcRenderer.invoke('config:getTldCache'),
    setTldCache: (tlds: string[]) => ipcRenderer.invoke('config:setTldCache', tlds),
    onChanged: (callback: (payload: { key: string; value: unknown }) => void) => {
      const listener = (_: any, payload: { key: string; value: unknown }) => callback(payload)
      ipcRenderer.on('config:changed', listener)
      return () => { ipcRenderer.removeListener('config:changed', listener) }
    }
  },

  // AI 宠物（petdex 格式）
  pet: {
    listInstalled: () => ipcRenderer.invoke('pet:listInstalled') as Promise<{ success: boolean; pets?: Array<{ slug: string; displayName: string; description: string; builtin?: boolean }>; error?: string }>,
    manifest: (force?: boolean) => ipcRenderer.invoke('pet:manifest', force) as Promise<{ success: boolean; pets?: Array<{ slug: string; displayName: string; kind?: string; submittedBy?: string; spritesheetUrl: string; petJsonUrl: string }>; error?: string }>,
    install: (slug: string) => ipcRenderer.invoke('pet:install', slug) as Promise<{ success: boolean; pet?: { slug: string; displayName: string; description: string; builtin?: boolean }; error?: string }>,
    remove: (slug: string) => ipcRenderer.invoke('pet:remove', slug) as Promise<{ success: boolean; error?: string }>,
    importZip: () => ipcRenderer.invoke('pet:importZip') as Promise<{ success: boolean; canceled?: boolean; pet?: { slug: string; displayName: string; description: string; builtin?: boolean }; error?: string }>,
    getSprite: (slug: string) => ipcRenderer.invoke('pet:getSprite', slug) as Promise<{ success: boolean; dataUrl?: string; error?: string }>,
    setAgentState: (state: string) => ipcRenderer.send('pet:agentState', state),
    toggleDesktopWindow: (enabled: boolean) => ipcRenderer.invoke('pet:toggleDesktopWindow', enabled) as Promise<{ success: boolean }>,
    setBubble: (expanded: boolean) => ipcRenderer.send('pet:setBubble', expanded),
    showContextMenu: () => ipcRenderer.send('pet:showContextMenu'),
    onAgentState: (callback: (state: string) => void) => {
      const listener = (_: any, state: string) => callback(state)
      ipcRenderer.on('pet:agentState', listener)
      return () => { ipcRenderer.removeListener('pet:agentState', listener) }
    },
    onWindowMove: (callback: (x: number) => void) => {
      const listener = (_: any, x: number) => callback(x)
      ipcRenderer.on('pet:windowMove', listener)
      return () => { ipcRenderer.removeListener('pet:windowMove', listener) }
    },
    onBubbleFrame: (callback: (frame: { expanded: boolean; baseLeft: number; baseTop: number; baseWidth: number; baseHeight: number }) => void) => {
      const listener = (_: any, frame: any) => callback(frame)
      ipcRenderer.on('pet:bubbleFrame', listener)
      return () => { ipcRenderer.removeListener('pet:bubbleFrame', listener) }
    },
    onContextMenuOpened: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('pet:contextMenuOpened', listener)
      return () => { ipcRenderer.removeListener('pet:contextMenuOpened', listener) }
    },
    onNotify: (callback: (payload: { username: string; displayName: string; avatarUrl?: string; preview: string; timestamp: number }) => void) => {
      const listener = (_: any, payload: any) => callback(payload)
      ipcRenderer.on('pet:notify', listener)
      return () => { ipcRenderer.removeListener('pet:notify', listener) }
    }
  },

  // 消息提醒（会话级开关，默认全关）
  notify: {
    getEnabledSessions: () => ipcRenderer.invoke('notify:getEnabledSessions') as Promise<string[]>,
    setSessionEnabled: (username: string, enabled: boolean) => ipcRenderer.invoke('notify:setSessionEnabled', username, enabled) as Promise<{ success: boolean }>,
    setActiveSession: (sessionId: string | null) => ipcRenderer.send('notify:setActiveSession', sessionId),
    activate: () => ipcRenderer.send('notify:activate'),
  },

  accounts: {
    list: () => ipcRenderer.invoke('accounts:list') as Promise<AccountProfile[]>,
    getActive: () => ipcRenderer.invoke('accounts:getActive') as Promise<AccountProfile | null>,
    setActive: (accountId: string) => ipcRenderer.invoke('accounts:setActive', accountId) as Promise<AccountProfile | null>,
    save: (profile: Omit<AccountProfile, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>) => ipcRenderer.invoke('accounts:save', profile) as Promise<AccountProfile | null>,
    update: (accountId: string, patch: Partial<Omit<AccountProfile, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>>) =>
      ipcRenderer.invoke('accounts:update', accountId, patch) as Promise<AccountProfile | null>,
    delete: (accountId: string, deleteLocalData?: boolean) =>
      ipcRenderer.invoke('accounts:delete', accountId, deleteLocalData) as Promise<{ success: boolean; error?: string; deleted?: AccountProfile | null; nextActiveAccountId?: string }>
  },

  skillManager: {
    list: () => ipcRenderer.invoke('skillManager:list') as Promise<Array<{ name: string; version: string; description: string; builtin: boolean }>>,
    readContent: (skillName: string) => ipcRenderer.invoke('skillManager:readContent', skillName) as Promise<{ success: boolean; content?: string; error?: string }>,
    updateContent: (skillName: string, content: string) => ipcRenderer.invoke('skillManager:updateContent', skillName, content) as Promise<{ success: boolean; error?: string }>,
    exportZip: (skillName: string) => ipcRenderer.invoke('skillManager:exportZip', skillName) as Promise<{ success: boolean; outputPath?: string; fileName?: string; version?: string; error?: string }>,
    importZip: (zipPath: string) => ipcRenderer.invoke('skillManager:importZip', zipPath) as Promise<{ success: boolean; skillName?: string; error?: string }>,
    delete: (skillName: string) => ipcRenderer.invoke('skillManager:delete', skillName) as Promise<{ success: boolean; error?: string }>,
    create: (skillName: string, content: string) => ipcRenderer.invoke('skillManager:create', skillName, content) as Promise<{ success: boolean; error?: string }>,
  },

  mcpClient: {
    listConfigs: () => ipcRenderer.invoke('mcpClient:listConfigs') as Promise<Record<string, { type: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>; timeoutMs?: number; autoConnect?: boolean }>>,
    saveConfig: (name: string, config: any, overwrite?: boolean) => ipcRenderer.invoke('mcpClient:saveConfig', name, config, overwrite) as Promise<{ success: boolean; error?: string }>,
    deleteConfig: (name: string) => ipcRenderer.invoke('mcpClient:deleteConfig', name) as Promise<{ success: boolean; error?: string }>,
    connect: (name: string) => ipcRenderer.invoke('mcpClient:connect', name) as Promise<{ success: boolean; tools?: Array<{ name: string; description?: string }>; error?: string }>,
    disconnect: (name: string) => ipcRenderer.invoke('mcpClient:disconnect', name) as Promise<{ success: boolean; error?: string }>,
    listTools: (name: string) => ipcRenderer.invoke('mcpClient:listTools', name) as Promise<{ success: boolean; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>; error?: string }>,
    callTool: (name: string, toolName: string, args: any) => ipcRenderer.invoke('mcpClient:callTool', name, toolName, args) as Promise<{ success: boolean; result?: any; error?: string }>,
    listStatuses: () => ipcRenderer.invoke('mcpClient:listStatuses') as Promise<Array<{ name: string; config: any; status: string; toolCount: number; error?: string }>>,
  },

  // AI Agent（主进程 broker → AI 子进程；流式 chunk 经 agent:chunk 推回）
  agent: {
    run: (runId: string, messages: unknown[], scope?: unknown, modelConfig?: unknown, conversationId?: number | null, planMode?: boolean) =>
      ipcRenderer.invoke('agent:run', { runId, messages, scope, modelConfig, conversationId, planMode }) as Promise<{ success: boolean; error?: string }>,
    abort: (runId: string) => ipcRenderer.invoke('agent:abort', runId) as Promise<{ success: boolean }>,
    generateTitle: (firstMessage: string, modelConfig?: unknown) =>
      ipcRenderer.invoke('agent:generateTitle', { firstMessage, modelConfig }) as Promise<{ success: boolean; title?: string; error?: string }>,
    listConversations: (scope?: unknown) =>
      ipcRenderer.invoke('agent:listConversations', scope) as Promise<{ success: boolean; conversations?: unknown[]; error?: string }>,
    loadConversation: (id: number) =>
      ipcRenderer.invoke('agent:loadConversation', id) as Promise<{ success: boolean; conversation?: unknown; error?: string }>,
    createConversation: (payload: unknown) =>
      ipcRenderer.invoke('agent:createConversation', payload) as Promise<{ success: boolean; conversation?: unknown; error?: string }>,
    deleteConversation: (id: number) =>
      ipcRenderer.invoke('agent:deleteConversation', id) as Promise<{ success: boolean; error?: string }>,
    renameConversation: (id: number, title: string) =>
      ipcRenderer.invoke('agent:renameConversation', id, title) as Promise<{ success: boolean; conversation?: unknown; error?: string }>,
    saveConversationMessages: (payload: unknown) =>
      ipcRenderer.invoke('agent:saveConversationMessages', payload) as Promise<{ success: boolean; conversation?: unknown; error?: string }>,
    getLastConversation: (scope?: unknown) =>
      ipcRenderer.invoke('agent:getLastConversation', scope) as Promise<{ success: boolean; conversation?: unknown; error?: string }>,
    onChunk: (runId: string, callback: (chunk: unknown) => void): (() => void) => {
      const listener = (_e: unknown, data: { runId: string; chunk: unknown }) => {
        if (data?.runId === runId) callback(data.chunk)
      }
      ipcRenderer.on('agent:chunk', listener)
      return () => ipcRenderer.removeListener('agent:chunk', listener)
    },
    onProgress: (runId: string, callback: (progress: unknown) => void): (() => void) => {
      const listener = (_e: unknown, data: { runId: string; progress: unknown }) => {
        if (data?.runId === runId) callback(data.progress)
      }
      ipcRenderer.on('agent:progress', listener)
      return () => ipcRenderer.removeListener('agent:progress', listener)
    },
  },

  // AI 长期记忆管理（agent_memory.db）
  memory: {
    list: (opts?: {
      sourceType?: 'profile' | 'fact' | 'relationship'
      sourceTypes?: Array<'profile' | 'fact' | 'relationship'>
      sessionId?: string
      tags?: string[]
      withoutTags?: string[]
      minConfidence?: number
      limit?: number
    }) =>
      ipcRenderer.invoke('memory:list', opts) as Promise<{ success: boolean; items?: unknown[]; stats?: { itemCount: number }; error?: string }>,
    delete: (id: number) =>
      ipcRenderer.invoke('memory:delete', id) as Promise<{ success: boolean; error?: string }>,
    update: (payload: { id: number; sourceType?: 'profile' | 'fact' | 'relationship'; content?: string; importance?: number; confidence?: number; tags?: string[] }) =>
      ipcRenderer.invoke('memory:update', payload) as Promise<{ success: boolean; item?: unknown; error?: string }>,
    consolidate: () =>
      ipcRenderer.invoke('memory:consolidate') as Promise<{ success: boolean; result?: { removed: number; groups: number; scanned: number }; error?: string }>,
    exportMarkdown: (outputDir: string) =>
      ipcRenderer.invoke('memory:exportMarkdown', outputDir) as Promise<{ success: boolean; result?: { files: string[]; itemCount: number }; error?: string }>,
  },

  // 嵌入模型（语义/向量检索）
  embedding: {
    getConfig: () => ipcRenderer.invoke('embedding:getConfig') as Promise<{ success: boolean; config?: unknown; error?: string }>,
    setConfig: (patch: unknown) => ipcRenderer.invoke('embedding:setConfig', patch) as Promise<{ success: boolean; config?: unknown; error?: string }>,
    test: (cfg: unknown) => ipcRenderer.invoke('embedding:test', cfg) as Promise<{ success: boolean; dimension?: number; error?: string }>,
    sessionStatus: (sessionId: string) => ipcRenderer.invoke('embedding:sessionStatus', sessionId) as Promise<{ success: boolean; enabled?: boolean; count?: number; store?: unknown; error?: string }>,
    buildSession: (sessionId: string) => ipcRenderer.invoke('embedding:buildSession', sessionId) as Promise<{ success: boolean; indexed?: number; error?: string }>,
    agentResourceStatus: (kind: 'skill' | 'mcp_tool') =>
      ipcRenderer.invoke('embedding:agentResourceStatus', kind) as Promise<{ success: boolean; status?: unknown; error?: string }>,
    buildAgentResources: (kind: 'skill' | 'mcp_tool') =>
      ipcRenderer.invoke('embedding:buildAgentResources', kind) as Promise<{ success: boolean; indexed?: number; error?: string }>,
    onBuildProgress: (callback: (progress: unknown) => void): (() => void) => {
      const listener = (_e: unknown, progress: unknown) => callback(progress)
      ipcRenderer.on('embedding:buildProgress', listener)
      return () => ipcRenderer.removeListener('embedding:buildProgress', listener)
    },
    onAgentResourceBuildProgress: (callback: (progress: unknown) => void): (() => void) => {
      const listener = (_e: unknown, progress: unknown) => callback(progress)
      ipcRenderer.on('embedding:agentResourceBuildProgress', listener)
      return () => ipcRenderer.removeListener('embedding:agentResourceBuildProgress', listener)
    },
  },

  // 重排模型（RAG/Skills/MCP 候选重排）
  rerank: {
    getConfig: () => ipcRenderer.invoke('rerank:getConfig') as Promise<{ success: boolean; config?: unknown; error?: string }>,
    setConfig: (patch: unknown) => ipcRenderer.invoke('rerank:setConfig', patch) as Promise<{ success: boolean; config?: unknown; error?: string }>,
    test: (cfg: unknown) => ipcRenderer.invoke('rerank:test', cfg) as Promise<{ success: boolean; error?: string }>,
  },

  // 联网搜索（Tavily）—— AI Agent web_search 工具
  webSearch: {
    getConfig: () => ipcRenderer.invoke('webSearch:getConfig') as Promise<{ success: boolean; config?: unknown; error?: string }>,
    setConfig: (patch: unknown) => ipcRenderer.invoke('webSearch:setConfig', patch) as Promise<{ success: boolean; config?: unknown; error?: string }>,
    test: (cfg: unknown) => ipcRenderer.invoke('webSearch:test', cfg) as Promise<{ success: boolean; resultCount?: number; error?: string }>,
  },

  // 数据库操作
  db: {
    open: (dbPath: string, key?: string) => ipcRenderer.invoke('db:open', dbPath, key),
    query: (sql: string, params?: any[]) => ipcRenderer.invoke('db:query', sql, params),
    close: () => ipcRenderer.invoke('db:close')
  },

  // 对话框
  dialog: {
    openFile: (options: any) => ipcRenderer.invoke('dialog:openFile', options),
    saveFile: (options: any) => ipcRenderer.invoke('dialog:saveFile', options)
  },

  // 文件操作
  file: {
    delete: (filePath: string) => ipcRenderer.invoke('file:delete', filePath),
    copy: (sourcePath: string, destPath: string) => ipcRenderer.invoke('file:copy', sourcePath, destPath),
    importHomeBackground: (sourcePath: string) => ipcRenderer.invoke('file:importHomeBackground', sourcePath),
    writeBase64: (filePath: string, base64Data: string) => ipcRenderer.invoke('file:writeBase64', filePath, base64Data)
  },

  // Shell
  shell: {
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    showItemInFolder: (fullPath: string) => ipcRenderer.invoke('shell:showItemInFolder', fullPath)
  },

  // App
  app: {
    getDownloadsPath: () => ipcRenderer.invoke('app:getDownloadsPath'),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getPlatformInfo: () => ipcRenderer.invoke('app:getPlatformInfo'),
    getMcpLaunchConfig: () => getMcpLaunchConfigSafe(),
    getUpdateState: () => ipcRenderer.invoke('app:getUpdateState'),
    getUpdateSourceInfo: () => ipcRenderer.invoke('app:getUpdateSourceInfo'),
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    downloadAndInstall: () => ipcRenderer.invoke('app:downloadAndInstall'),
    getStartupDbConnected: () => ipcRenderer.invoke('app:getStartupDbConnected'),
    onDownloadProgress: (callback: (progress: {
      percent: number
      transferred: number
      total: number
      bytesPerSecond: number
    }) => void) => {
      ipcRenderer.on('app:downloadProgress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('app:downloadProgress')
    },
    onUpdateAvailable: (callback: (info: {
      hasUpdate: boolean
      forceUpdate: boolean
      currentVersion: string
      version?: string
      releaseNotes?: string
      title?: string
      message?: string
      minimumSupportedVersion?: string
      reason?: 'minimum-version' | 'blocked-version'
      checkedAt: number
      updateSource: 'r2' | 'github' | 'custom' | 'none'
      policySource: 'r2' | 'github' | 'custom' | 'none'
    }) => void) => {
      ipcRenderer.on('app:updateAvailable', (_, info) => callback(info))
      return () => ipcRenderer.removeAllListeners('app:updateAvailable')
    }
  },

  // HTTP API
  httpApi: {
    getStatus: () => ipcRenderer.invoke('httpApi:getStatus'),
    applySettings: (payload: { enabled: boolean; port: number; token: string; listenMode: 'localhost' | 'lan' }) => ipcRenderer.invoke('httpApi:applySettings', payload),
    restart: () => ipcRenderer.invoke('httpApi:restart')
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    openChatWindow: () => ipcRenderer.invoke('window:openChatWindow'),
    openMomentsWindow: (filterUsername?: string) => ipcRenderer.invoke('window:openMomentsWindow', filterUsername),
    onMomentsFilterUser: (callback: (username: string) => void) => {
      ipcRenderer.on('moments:filterUser', (_, username) => callback(username))
      return () => ipcRenderer.removeAllListeners('moments:filterUser')
    },
    openAgreementWindow: () => ipcRenderer.invoke('window:openAgreementWindow'),
    openPurchaseWindow: () => ipcRenderer.invoke('window:openPurchaseWindow'),
    openWelcomeWindow: (mode?: 'default' | 'add-account') => ipcRenderer.invoke('window:openWelcomeWindow', mode),
    completeWelcome: () => ipcRenderer.invoke('window:completeWelcome'),
    isChatWindowOpen: () => ipcRenderer.invoke('window:isChatWindowOpen'),
    closeChatWindow: () => ipcRenderer.invoke('window:closeChatWindow'),
    setTitleBarOverlay: (options: { symbolColor: string }) => ipcRenderer.send('window:setTitleBarOverlay', options),
    openImageViewerWindow: (
      imagePath: string,
      liveVideoPath?: string,
      imageList?: Array<{ imagePath: string; liveVideoPath?: string }>,
      options?: { sessionId?: string; imageMd5?: string; imageDatName?: string }
    ) => ipcRenderer.invoke('window:openImageViewerWindow', imagePath, liveVideoPath, imageList, options),
    openVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) => ipcRenderer.invoke('window:openVideoPlayerWindow', videoPath, videoWidth, videoHeight),
    openBrowserWindow: (url: string, title?: string) => ipcRenderer.invoke('window:openBrowserWindow', url, title),
    openChatHistoryWindow: (sessionId: string, messageId: number) => ipcRenderer.invoke('window:openChatHistoryWindow', sessionId, messageId),
    resizeToFitVideo: (videoWidth: number, videoHeight: number) => ipcRenderer.invoke('window:resizeToFitVideo', videoWidth, videoHeight),
    resizeContent: (width: number, height: number) => ipcRenderer.invoke('window:resizeContent', width, height),
    move: (x: number, y: number) => ipcRenderer.send('window:move', { x, y }),
    splashReady: () => ipcRenderer.send('window:splashReady'),
    onSplashFadeOut: (callback: () => void) => {
      ipcRenderer.on('splash:fadeOut', () => callback())
      return () => ipcRenderer.removeAllListeners('splash:fadeOut')
    },
    onImageListUpdate: (callback: (data: { imageList: Array<{ imagePath: string; liveVideoPath?: string }>, currentIndex: number }) => void) => {
      const listener = (_: any, data: any) => callback(data)
      ipcRenderer.on('imageViewer:setImageList', listener)
      return () => { ipcRenderer.removeListener('imageViewer:setImageList', listener) }
    }
  },

  systemAuth: {
    getStatus: () => ipcRenderer.invoke('systemAuth:getStatus') as Promise<{
      platform: string
      available: boolean
      method: 'windows-hello' | 'touch-id' | 'none'
      displayName: string
      error?: string
    }>,
    verify: (reason?: string) => ipcRenderer.invoke('systemAuth:verify', reason) as Promise<{
      success: boolean
      method: 'windows-hello' | 'touch-id' | 'none'
      error?: string
    }>
  },

  // 密钥获取
  wxKey: {
    isWeChatRunning: () => ipcRenderer.invoke('wxkey:isWeChatRunning'),
    getWeChatPid: () => ipcRenderer.invoke('wxkey:getWeChatPid'),
    killWeChat: () => ipcRenderer.invoke('wxkey:killWeChat'),
    launchWeChat: () => ipcRenderer.invoke('wxkey:launchWeChat'),
    waitForWindow: (maxWaitSeconds?: number) => ipcRenderer.invoke('wxkey:waitForWindow', maxWaitSeconds),
    startGetKey: (customWechatPath?: string, dbPath?: string) => ipcRenderer.invoke('wxkey:startGetKey', customWechatPath, dbPath),
    cancel: () => ipcRenderer.invoke('wxkey:cancel'),
    detectCurrentAccount: (dbPath?: string, maxTimeDiffMinutes?: number) => ipcRenderer.invoke('wxkey:detectCurrentAccount', dbPath, maxTimeDiffMinutes),
    onStatus: (callback: (data: { status: string; level: number }) => void) => {
      ipcRenderer.on('wxkey:status', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('wxkey:status')
    }
  },

  // 数据库路径
  dbPath: {
    autoDetect: () => ipcRenderer.invoke('dbpath:autoDetect'),
    scanWxids: (rootPath: string) => ipcRenderer.invoke('dbpath:scanWxids', rootPath),
    getDefault: () => ipcRenderer.invoke('dbpath:getDefault'),
    getBestCachePath: () => ipcRenderer.invoke('dbpath:getBestCachePath')
  },

  // WCDB 数据库
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string, isAutoConnect?: boolean) =>
      ipcRenderer.invoke('wcdb:testConnection', dbPath, hexKey, wxid, isAutoConnect),
    resolveValidWxid: (dbPath: string, hexKey: string) =>
      ipcRenderer.invoke('wcdb:resolveValidWxid', dbPath, hexKey),
    open: (dbPath: string, hexKey: string, wxid: string) =>
      ipcRenderer.invoke('wcdb:open', dbPath, hexKey, wxid),
    close: () => ipcRenderer.invoke('wcdb:close'),
    decryptDatabase: (dbPath: string, hexKey: string, wxid: string) =>
      ipcRenderer.invoke('wcdb:decryptDatabase', dbPath, hexKey, wxid),
    onDecryptProgress: (callback: (data: any) => void) => {
      ipcRenderer.on('wcdb:decryptProgress', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('wcdb:decryptProgress')
    },
    onChange: (callback: (payload: { table: string; dbPath: string; walPath: string }) => void) => {
      const listener = (_: any, payload: any) => callback(payload)
      ipcRenderer.on('wcdb:change', listener)
      return () => ipcRenderer.removeListener('wcdb:change', listener)
    }
  },

  // 数据管理
  dataManagement: {
    scanDatabases: () => ipcRenderer.invoke('dataManagement:scanDatabases'),
    decryptAll: () => ipcRenderer.invoke('dataManagement:decryptAll'),
    decryptSingleDatabase: (filePath: string) => ipcRenderer.invoke('dataManagement:decryptSingleDatabase', filePath),
    incrementalUpdate: () => ipcRenderer.invoke('dataManagement:incrementalUpdate'),
    getCurrentCachePath: () => ipcRenderer.invoke('dataManagement:getCurrentCachePath'),
    getDefaultCachePath: () => ipcRenderer.invoke('dataManagement:getDefaultCachePath'),
    migrateCache: (newCachePath: string) => ipcRenderer.invoke('dataManagement:migrateCache', newCachePath),
    scanImages: (dirPath: string) => ipcRenderer.invoke('dataManagement:scanImages', dirPath),
    decryptImages: (dirPath: string) => ipcRenderer.invoke('dataManagement:decryptImages', dirPath),
    getImageDirectories: () => ipcRenderer.invoke('dataManagement:getImageDirectories'),
    decryptSingleImage: (filePath: string) => ipcRenderer.invoke('dataManagement:decryptSingleImage', filePath),
    checkForUpdates: () => ipcRenderer.invoke('dataManagement:checkForUpdates'),
    enableAutoUpdate: (intervalSeconds?: number) => ipcRenderer.invoke('dataManagement:enableAutoUpdate', intervalSeconds),
    disableAutoUpdate: () => ipcRenderer.invoke('dataManagement:disableAutoUpdate'),
    autoIncrementalUpdate: (silent?: boolean) => ipcRenderer.invoke('dataManagement:autoIncrementalUpdate', silent),
    onProgress: (callback: (data: any) => void) => {
      ipcRenderer.on('dataManagement:progress', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('dataManagement:progress')
    },
    onUpdateAvailable: (callback: (hasUpdate: boolean) => void) => {
      ipcRenderer.on('dataManagement:updateAvailable', (_, hasUpdate) => callback(hasUpdate))
      return () => ipcRenderer.removeAllListeners('dataManagement:updateAvailable')
    }
  },

  // 图片解密
  imageDecrypt: {
    batchDetectXorKey: (dirPath: string) => ipcRenderer.invoke('imageDecrypt:batchDetectXorKey', dirPath),
    decryptImage: (inputPath: string, outputPath: string, xorKey: number, aesKey?: string) =>
      ipcRenderer.invoke('imageDecrypt:decryptImage', inputPath, outputPath, xorKey, aesKey)
  },

  // 图片解密（新 API）
  image: {
    decrypt: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number; force?: boolean; quick?: boolean }) =>
      ipcRenderer.invoke('image:decrypt', payload),
    resolveCache: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }) =>
      ipcRenderer.invoke('image:resolveCache', payload),
    onUpdateAvailable: (callback: (data: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => void) => {
      ipcRenderer.on('image:updateAvailable', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('image:updateAvailable')
    },
    onCacheResolved: (callback: (data: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => void) => {
      ipcRenderer.on('image:cacheResolved', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('image:cacheResolved')
    },
    deleteThumbnails: () => ipcRenderer.invoke('image:deleteThumbnails'),
    countThumbnails: () => ipcRenderer.invoke('image:countThumbnails'),
  },

  // 视频
  video: {
    getVideoInfo: (videoMd5: string, rawContent?: string) => ipcRenderer.invoke('video:getVideoInfo', videoMd5, rawContent),
    readFile: (videoPath: string) => ipcRenderer.invoke('video:readFile', videoPath),
    parseVideoMd5: (content: string) => ipcRenderer.invoke('video:parseVideoMd5', content),
    parseChannelVideo: (content: string) => ipcRenderer.invoke('video:parseChannelVideo', content),
    downloadChannelVideo: (videoInfo: any, key?: string) => ipcRenderer.invoke('video:downloadChannelVideo', videoInfo, key),
    onDownloadProgress: (callback: (progress: any) => void) => {
      const listener = (_: any, progress: any) => callback(progress)
      ipcRenderer.on('video:downloadProgress', listener)
      return () => ipcRenderer.removeListener('video:downloadProgress', listener)
    }
  },


  // 图片密钥获取
  imageKey: {
    getImageKeys: (userDir: string) => ipcRenderer.invoke('imageKey:getImageKeys', userDir),
    onProgress: (callback: (msg: string) => void) => {
      ipcRenderer.on('imageKey:progress', (_, msg) => callback(msg))
      return () => ipcRenderer.removeAllListeners('imageKey:progress')
    }
  },

  // 聊天
  chat: {
    connect: () => ipcRenderer.invoke('chat:connect'),
    getSessions: (offset?: number, limit?: number) => ipcRenderer.invoke('chat:getSessions', offset, limit),
    getMentionTargets: (offset?: number, limit?: number) => ipcRenderer.invoke('chat:getMentionTargets', offset, limit),
    getContacts: () => ipcRenderer.invoke('chat:getContacts'),
    getMessages: (sessionId: string, offset?: number, limit?: number) =>
      ipcRenderer.invoke('chat:getMessages', sessionId, offset, limit),
    getMessagesBefore: (
      sessionId: string,
      cursorSortSeq: number,
      limit?: number,
      cursorCreateTime?: number,
      cursorLocalId?: number
    ) =>
      ipcRenderer.invoke('chat:getMessagesBefore', sessionId, cursorSortSeq, limit, cursorCreateTime, cursorLocalId),
    getMessagesAfter: (
      sessionId: string,
      cursorSortSeq: number,
      limit?: number,
      cursorCreateTime?: number,
      cursorLocalId?: number
    ) =>
      ipcRenderer.invoke('chat:getMessagesAfter', sessionId, cursorSortSeq, limit, cursorCreateTime, cursorLocalId),
    getNewMessages: (sessionId: string, minTime: number, limit?: number) =>
      ipcRenderer.invoke('chat:getNewMessages', sessionId, minTime, limit),
    getAllVoiceMessages: (sessionId: string) =>
      ipcRenderer.invoke('chat:getAllVoiceMessages', sessionId),
    getAllImageMessages: (sessionId: string) =>
      ipcRenderer.invoke('chat:getAllImageMessages', sessionId),
    getImageData: (sessionId: string, msgId: string, createTime?: number) =>
      ipcRenderer.invoke('chat:getImageData', sessionId, msgId, createTime),
    getContact: (username: string) => ipcRenderer.invoke('chat:getContact', username),
    getContactAvatar: (username: string) => ipcRenderer.invoke('chat:getContactAvatar', username),
    resolveTransferDisplayNames: (chatroomId: string, payerUsername: string, receiverUsername: string) =>
      ipcRenderer.invoke('chat:resolveTransferDisplayNames', chatroomId, payerUsername, receiverUsername),
    getMyAvatarUrl: () => ipcRenderer.invoke('chat:getMyAvatarUrl'),
    getMyUserInfo: () => ipcRenderer.invoke('chat:getMyUserInfo'),
    downloadEmoji: (cdnUrl: string, md5?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string) => ipcRenderer.invoke('chat:downloadEmoji', cdnUrl, md5, productId, createTime, encryptUrl, aesKey),
    close: () => ipcRenderer.invoke('chat:close'),
    refreshCache: () => ipcRenderer.invoke('chat:refreshCache'),
    setCurrentSession: (sessionId: string | null) => ipcRenderer.invoke('chat:setCurrentSession', sessionId),
    getSessionDetail: (sessionId: string) => ipcRenderer.invoke('chat:getSessionDetail', sessionId),
    getVoiceData: (sessionId: string, msgId: string, createTime?: number, serverId?: number) => ipcRenderer.invoke('chat:getVoiceData', sessionId, msgId, createTime, serverId),
    getMessagesByDate: (sessionId: string, targetTimestamp: number, limit?: number) =>
      ipcRenderer.invoke('chat:getMessagesByDate', sessionId, targetTimestamp, limit),
    getMessage: (sessionId: string, localId: number) => ipcRenderer.invoke('chat:getMessage', sessionId, localId),
    pickRandomMomentFromIndex: () =>
      ipcRenderer.invoke('chat:pickRandomMomentFromIndex'),
    getDatesWithMessages: (sessionId: string, year: number, month: number) =>
      ipcRenderer.invoke('chat:getDatesWithMessages', sessionId, year, month),
    onSessionsUpdated: (callback: (sessions: any[]) => void) => {
      const listener = (_: any, sessions: any[]) => callback(sessions)
      ipcRenderer.on('chat:sessions-updated', listener)
      return () => ipcRenderer.removeListener('chat:sessions-updated', listener)
    },
    onNewMessages: (callback: (data: { sessionId: string; messages: any[] }) => void) => {
      const listener = (_: any, data: any) => callback(data)
      ipcRenderer.on('chat:new-messages', listener)
      return () => ipcRenderer.removeListener('chat:new-messages', listener)
    }
  },

  // 朋友圈
  sns: {
    getTimeline: (limit?: number, offset?: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('sns:getTimeline', limit || 20, offset || 0, usernames, keyword, startTime, endTime),
    proxyImage: (params: { url: string; key?: string | number }) =>
      ipcRenderer.invoke('sns:proxyImage', params),
    downloadImage: (params: { url: string; key?: string | number }) =>
      ipcRenderer.invoke('sns:downloadImage', params),
    downloadEmoji: (params: { url: string; encryptUrl?: string; aesKey?: string }) =>
      ipcRenderer.invoke('sns:downloadEmoji', params),
    writeExportFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('sns:writeExportFile', filePath, content),
    saveMediaToDir: (params: { url: string; key?: string | number; outputDir: string; index: number; md5?: string; isAvatar?: boolean; username?: string; isEmoji?: boolean; encryptUrl?: string; aesKey?: string }) =>
      ipcRenderer.invoke('sns:saveMediaToDir', params)
  },

  // 导出
  export: {
    exportSessions: (sessionIds: string[], outputDir: string, options: any) =>
      ipcRenderer.invoke('export:exportSessions', sessionIds, outputDir, options),
    exportSession: (sessionId: string, outputPath: string, options: any) =>
      ipcRenderer.invoke('export:exportSession', sessionId, outputPath, options),
    exportContacts: (outputDir: string, options: any) =>
      ipcRenderer.invoke('export:exportContacts', outputDir, options),
    exportMoments: (outputDir: string, options: any) =>
      ipcRenderer.invoke('export:exportMoments', outputDir, options),
    onProgress: (callback: (data: any) => void) => {
      ipcRenderer.on('export:progress', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('export:progress')
    }
  },

  // 激活
  activation: {
    getDeviceId: () => ipcRenderer.invoke('activation:getDeviceId'),
    verifyCode: (code: string) => ipcRenderer.invoke('activation:verifyCode', code),
    activate: (code: string) => ipcRenderer.invoke('activation:activate', code),
    checkStatus: () => ipcRenderer.invoke('activation:checkStatus'),
    getTypeDisplayName: (type: string | null) => ipcRenderer.invoke('activation:getTypeDisplayName', type),
    clearCache: () => ipcRenderer.invoke('activation:clearCache')
  },
  cache: {
    clearImages: () => ipcRenderer.invoke('cache:clearImages'),
    clearEmojis: () => ipcRenderer.invoke('cache:clearEmojis'),
    clearDatabases: () => ipcRenderer.invoke('cache:clearDatabases'),
    clearAIData: () => ipcRenderer.invoke('cache:clearAIData'),
    clearAll: () => ipcRenderer.invoke('cache:clearAll'),
    clearConfig: () => ipcRenderer.invoke('cache:clearConfig'),
    clearCurrentAccount: (deleteLocalData?: boolean) => ipcRenderer.invoke('cache:clearCurrentAccount', deleteLocalData),
    clearAllAccountConfigs: () => ipcRenderer.invoke('cache:clearAllAccountConfigs'),
    getCacheSize: () => ipcRenderer.invoke('cache:getCacheSize')
  },
  log: {
    getLogFiles: () => ipcRenderer.invoke('log:getLogFiles'),
    readLogFile: (filename: string) => ipcRenderer.invoke('log:readLogFile', filename),
    clearLogs: () => ipcRenderer.invoke('log:clearLogs'),
    getLogSize: () => ipcRenderer.invoke('log:getLogSize'),
    getLogDirectory: () => ipcRenderer.invoke('log:getLogDirectory'),
    setLogLevel: (level: string) => ipcRenderer.invoke('log:setLogLevel', level),
    getLogLevel: () => ipcRenderer.invoke('log:getLogLevel')
  },

  // 语音转文字 (STT)
  stt: {
    getModelStatus: () => ipcRenderer.invoke('stt:getModelStatus'),
    downloadModel: () => ipcRenderer.invoke('stt:downloadModel'),
    cancelDownloadModel: () => ipcRenderer.invoke('stt:cancelDownloadModel'),
    transcribe: (wavBase64: string, sessionId: string, createTime: number, force?: boolean) => ipcRenderer.invoke('stt:transcribe', wavBase64, sessionId, createTime, force),
    transcribeAudioFile: (filePath: string) => ipcRenderer.invoke('stt:transcribeAudioFile', filePath),
    testOnlineConfig: (overrides?: { provider?: 'openai-compatible' | 'aliyun-qwen-asr' | 'custom'; apiKey?: string; baseURL?: string; model?: string; language?: string; timeoutMs?: number }) =>
      ipcRenderer.invoke('stt-online:test-config', overrides),
    onDownloadProgress: (callback: (progress: { modelName: string; downloadedBytes: number; totalBytes?: number; percent?: number }) => void) => {
      ipcRenderer.on('stt:downloadProgress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('stt:downloadProgress')
    },
    onPartialResult: (callback: (text: string) => void) => {
      ipcRenderer.on('stt:partialResult', (_, text) => callback(text))
      return () => ipcRenderer.removeAllListeners('stt:partialResult')
    },
    getCachedTranscript: (sessionId: string, createTime: number) => ipcRenderer.invoke('stt:getCachedTranscript', sessionId, createTime),
    updateTranscript: (sessionId: string, createTime: number, transcript: string) => ipcRenderer.invoke('stt:updateTranscript', sessionId, createTime, transcript),
    clearModel: () => ipcRenderer.invoke('stt:clearModel')
  },

  // 语音转文字 - Whisper GPU 加速
  sttWhisper: {
    detectGPU: () => ipcRenderer.invoke('stt-whisper:detect-gpu'),
    checkModel: (modelType: string) => ipcRenderer.invoke('stt-whisper:check-model', modelType),
    downloadModel: (modelType: string) => ipcRenderer.invoke('stt-whisper:download-model', modelType),
    cancelDownloadModel: (modelType: string) => ipcRenderer.invoke('stt-whisper:cancel-download-model', modelType),
    clearModel: (modelType: string) => ipcRenderer.invoke('stt-whisper:clear-model', modelType),
    transcribe: (wavData: Buffer | ArrayBuffer | Uint8Array, options: { modelType?: string; language?: string }) =>
      ipcRenderer.invoke('stt-whisper:transcribe', wavData, options),
    onDownloadProgress: (callback: (progress: { downloadedBytes: number; totalBytes?: number; percent?: number }) => void) => {
      ipcRenderer.on('stt-whisper:download-progress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('stt-whisper:download-progress')
    },
    downloadGPUComponents: () => ipcRenderer.invoke('stt-whisper:download-gpu-components'),
    cancelDownloadGPUComponents: () => ipcRenderer.invoke('stt-whisper:cancel-download-gpu-components'),
    checkGPUComponents: () => ipcRenderer.invoke('stt-whisper:check-gpu-components'),
    onGPUDownloadProgress: (callback: (progress: { currentFile: string; fileProgress: number; overallProgress: number; completedFiles: number; totalFiles: number }) => void) => {
      ipcRenderer.on('stt-whisper:gpu-download-progress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('stt-whisper:gpu-download-progress')
    }
  },

  // AI 接入
  ai: {
    getProviders: () => ipcRenderer.invoke('ai:getProviders'),
    getProxyStatus: () => ipcRenderer.invoke('ai:getProxyStatus'),
    refreshProxy: () => ipcRenderer.invoke('ai:refreshProxy'),
    testProxy: (proxyUrl: string, testUrl?: string) => ipcRenderer.invoke('ai:testProxy', proxyUrl, testUrl),
    testConnection: (provider: string, apiKey: string, baseURL?: string, protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google') => ipcRenderer.invoke('ai:testConnection', provider, apiKey, baseURL, protocol),
    listModels: (options: { provider: string; apiKey?: string; baseURL?: string; protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' }) => ipcRenderer.invoke('ai:listModels', options),
    estimateCost: (messageCount: number, provider: string) => ipcRenderer.invoke('ai:estimateCost', messageCount, provider),
    readGuide: (guideName: string) => ipcRenderer.invoke('ai:readGuide', guideName)
  }
})

  // 主题由 index.html 中的内联脚本处理，这里只负责同步 localStorage
  ; (async () => {
    try {
      const theme = await ipcRenderer.invoke('config:get', 'theme') || 'cloud-dancer'
      const themeMode = await ipcRenderer.invoke('config:get', 'themeMode') || 'light'

      // 更新 localStorage 以供下次同步使用（主窗口场景）
      try {
        localStorage.setItem('theme', theme)
        localStorage.setItem('themeMode', themeMode)
      } catch (e) {
        // localStorage 可能不可用
      }
    } catch (e) {
      // 忽略错误
    }
  })()
