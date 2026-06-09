import { ipcMain } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { UIMessage } from 'ai'
import type { MainProcessContext } from '../context'
import type { AgentProviderConfig, AgentProviderConfigOverride, AgentScope } from '../../services/agent/types'

/** 进行中的 agent 运行：runId → AbortController，用于取消。 */
const agentAborters = new Map<string, AbortController>()
const AGENT_RUN_PROXY_CACHE_TTL_MS = 5 * 60 * 1000
const AGENT_PREP_RERANK_TIMEOUT_MS = 1500

let agentRunProxyRefreshedAt = 0
let agentRunProxyRefreshPromise: Promise<string | null> | null = null

async function refreshAgentRunProxyCached(refreshResolvedProxyUrl: () => Promise<string | null>): Promise<string | null> {
  const now = Date.now()
  if (agentRunProxyRefreshPromise) return agentRunProxyRefreshPromise
  if (now - agentRunProxyRefreshedAt < AGENT_RUN_PROXY_CACHE_TTL_MS) return null

  agentRunProxyRefreshPromise = refreshResolvedProxyUrl()
    .finally(() => {
      agentRunProxyRefreshedAt = Date.now()
      agentRunProxyRefreshPromise = null
    })

  return agentRunProxyRefreshPromise
}

function textFromUiMessage(message: UIMessage): string {
  const anyMessage = message as any
  if (typeof anyMessage.content === 'string') return anyMessage.content
  if (!Array.isArray(anyMessage.parts)) return ''
  return anyMessage.parts
    .map((part: any) => {
      if (!part || typeof part !== 'object') return ''
      if (part.type === 'text') return String(part.text || '')
      if (typeof part.text === 'string') return part.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function lastUserTextFromUiMessages(messages: UIMessage[] = []): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return textFromUiMessage(messages[i])
  }
  return ''
}

function scopeToLogData(scope?: AgentScope): Record<string, unknown> {
  if (!scope || scope.kind === 'global') return { scopeKind: 'global' }
  return {
    scopeKind: 'session',
    sessionId: scope.sessionId,
    hasDisplayName: Boolean(scope.displayName),
  }
}

function hostFromUrl(url: string): string | null {
  if (!url) return null
  try {
    return new URL(url).host || null
  } catch {
    return null
  }
}

function shouldStripProviderMetadata(providerConfig: AgentProviderConfig): boolean {
  if (providerConfig.providerKind !== 'openai-responses') return false
  const host = hostFromUrl(providerConfig.baseURL)
  return providerConfig.name === 'custom' || (host !== null && host !== 'api.openai.com')
}

function stripRemoteResponseRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripRemoteResponseRefs(item))
  }
  if (!value || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (
      key === 'providerMetadata' ||
      key === 'callProviderMetadata' ||
      key === 'resultProviderMetadata' ||
      key === 'providerOptions' ||
      key === 'itemId' ||
      key === 'item_id' ||
      key === 'responseId' ||
      key === 'response_id' ||
      key === 'previousResponseId' ||
      key === 'previous_response_id'
    ) {
      continue
    }
    if (typeof child === 'string' && /^(msg|rs|resp)_[A-Za-z0-9_-]+$/.test(child)) {
      continue
    }
    out[key] = stripRemoteResponseRefs(child)
  }
  return out
}

function stripUiMessageProviderMetadata(messages: UIMessage[] = []): UIMessage[] {
  return stripRemoteResponseRefs(messages) as UIMessage[]
}

function providerToLogData(providerConfig: AgentProviderConfig): Record<string, unknown> {
  return {
    provider: providerConfig.name,
    protocol: providerConfig.providerKind,
    model: providerConfig.model,
    baseURLHost: hostFromUrl(providerConfig.baseURL),
    hasBaseURL: Boolean(providerConfig.baseURL),
    hasApiKey: Boolean(providerConfig.apiKey),
    hasProxy: Boolean(providerConfig.proxyUrl),
    reasoningEffort: providerConfig.reasoningEffort || null,
  }
}

function errorToLogData(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

export function registerAiHandlers(ctx: MainProcessContext): void {
  // ========= AI Agent（跑在独立 utilityProcess 子进程，主进程仅做 broker）=========
  ipcMain.handle('agent:run', async (event, payload: {
    runId: string
    messages: UIMessage[]
    scope?: AgentScope
    modelConfig?: AgentProviderConfigOverride | null
    conversationId?: number | null
    planMode?: boolean
  }) => {
    const sender = event.sender
    const { runId } = payload
    const send = (chunk: unknown) => { if (!sender.isDestroyed()) sender.send('agent:chunk', { runId, chunk }) }
    const sendProgress = (progress: unknown) => { if (!sender.isDestroyed()) sender.send('agent:progress', { runId, progress }) }
    const aborter = new AbortController()
    const logger = ctx.getLogService()
    const startedAt = Date.now()
    const scope = payload.scope ?? { kind: 'global' as const }
    const initialLastUserText = lastUserTextFromUiMessages(payload.messages || [])
    const baseRunData = {
      runId,
      conversationId: payload.conversationId ?? null,
      messageCount: payload.messages?.length ?? 0,
      lastUserTextLength: initialLastUserText.length,
      ...scopeToLogData(scope),
    }
    let stage = 'start'
    let chunkCount = 0
    let progressCount = 0
    let lastActivityAt = startedAt
    let lastActivityKind = 'start'
    let idleWarningCount = 0
    let watchdog: NodeJS.Timeout | null = null
    agentAborters.set(runId, aborter)
    const sendPrepProgress = (title: string, detail?: string, visible = false) => {
      lastActivityAt = Date.now()
      lastActivityKind = 'progress'
      idleWarningCount = 0
      if (!visible) return
      progressCount += 1
      sendProgress({
        stage: 'run_started',
        title,
        detail,
        elapsedMs: Date.now() - startedAt,
        at: Date.now(),
      })
    }
    logger?.warn('AIAgent', 'AI Agent 请求开始', baseRunData)
    try {
      stage = 'import_services'
      sendPrepProgress('正在准备 Agent', undefined, true)
      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      agentProcessService.setLogger(logger)
      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const { convertToModelMessages } = await import('ai')
      stage = 'refresh_proxy'
      sendPrepProgress('正在检测代理')
      await refreshAgentRunProxyCached(refreshResolvedProxyUrl) // 主进程探测系统代理并持久化，供子进程 agent/嵌入读取
      stage = 'resolve_provider'
      sendPrepProgress('正在准备模型配置')
      const providerConfig = resolveProviderConfig(payload.modelConfig)
      stage = 'convert_messages'
      sendPrepProgress('正在整理消息')
      const uiMessages = shouldStripProviderMetadata(providerConfig)
        ? stripUiMessageProviderMetadata(payload.messages)
        : payload.messages
      const messages = await convertToModelMessages(uiMessages)
      const lastUserText = lastUserTextFromUiMessages(payload.messages)
      stage = 'load_context_services'
      sendPrepProgress('正在加载上下文服务')
      const { mcpClientService } = await import('../../services/mcpClientService')
      const { buildReadOnlyMcpToolDescriptors } = await import('../../services/agent/mcpToolPolicy')
      const { skillManagerService } = await import('../../services/skillManagerService')
      const { rerankCandidates } = await import('../../services/ai/rerankService')
      const { agentResourceVectorService } = await import('../../services/agent/agentResourceVectorService')
      const readOnlyMcpTools = buildReadOnlyMcpToolDescriptors(mcpClientService.getConnectedToolSchemas())
      let mcpCandidates = readOnlyMcpTools
      stage = 'select_mcp_candidates'
      sendPrepProgress('正在筛选 MCP 工具', `只读工具 ${readOnlyMcpTools.length} 个`)
      if (agentResourceVectorService.isReady()) {
        try {
          const mcpVectorStatus = agentResourceVectorService.getMcpStatus(readOnlyMcpTools)
          const canUseMcpVector = mcpVectorStatus.enabled
            && mcpVectorStatus.currentCount > 0
            && mcpVectorStatus.count === mcpVectorStatus.currentCount
            && mcpVectorStatus.staleCount === 0
          if (canUseMcpVector) {
            const vectorMcpTools = await agentResourceVectorService.searchMcpTools(
              lastUserText,
              readOnlyMcpTools,
              24,
              undefined,
              { requireCurrent: true },
            )
            if (vectorMcpTools.length > 0) mcpCandidates = vectorMcpTools
          } else if (mcpVectorStatus.currentCount > 0) {
            logger?.warn('AIAgent', 'MCP 工具向量未就绪，跳过请求期向量补建', {
              ...baseRunData,
              currentCount: mcpVectorStatus.currentCount,
              indexedCount: mcpVectorStatus.count,
              staleCount: mcpVectorStatus.staleCount,
            })
          }
        } catch (error) {
          console.warn('[agent:run] MCP vector candidate selection failed, fallback to all read-only tools:', error)
          logger?.warn('AIAgent', 'MCP 工具向量候选选择失败，回退到全部只读工具', {
            ...baseRunData,
            ...errorToLogData(error),
          })
        }
      }
      stage = 'rerank_mcp_tools'
      sendPrepProgress('正在重排 MCP 工具', `候选 ${mcpCandidates.length} 个`)
      const { items: mcpTools, meta: mcpRerankMeta } = await rerankCandidates(
        lastUserText,
        mcpCandidates.map((tool) => ({
          item: tool,
          text: [
            `MCP ${tool.serverName}/${tool.toolName}`,
            tool.name,
            tool.description || '',
            tool.inputSchema ? JSON.stringify(tool.inputSchema).slice(0, 1000) : '',
          ].filter(Boolean).join('\n'),
        })),
        { topN: 8, timeoutMsOverride: AGENT_PREP_RERANK_TIMEOUT_MS },
      )
      stage = 'select_skills'
      sendPrepProgress('正在选择技能')
      const skills = await skillManagerService.selectSkillsForAgent(lastUserText)
      if (mcpTools.length > 0 || skills.length > 0) {
        console.info('[agent:run] injected context', {
          mcpTools: mcpTools.map((tool) => `${tool.serverName}/${tool.toolName}`),
          skills: skills.map((skill) => skill.name),
        })
      }
      logger?.warn('AIAgent', 'AI Agent 配置与上下文准备完成', {
        ...baseRunData,
        elapsedMs: Date.now() - startedAt,
        provider: providerToLogData(providerConfig),
        modelMessageCount: messages.length,
        readOnlyMcpToolCount: readOnlyMcpTools.length,
        mcpCandidateCount: mcpCandidates.length,
        selectedMcpToolCount: mcpTools.length,
        selectedMcpTools: mcpTools.map((tool) => `${tool.serverName}/${tool.toolName}`),
        mcpRerankApplied: mcpRerankMeta.applied,
        mcpRerankError: mcpRerankMeta.error || null,
        selectedSkillCount: skills.length,
        selectedSkills: skills.map((skill) => skill.name),
      })
      stage = 'run_agent_process'
      sendPrepProgress('正在交给 Agent 进程')
      watchdog = setInterval(() => {
        const idleMs = Date.now() - lastActivityAt
        if (idleMs < 10000) return
        if (idleWarningCount >= 6) return
        idleWarningCount += 1
        logger?.warn('AIAgent', 'AI Agent 运行中暂无新输出', {
          ...baseRunData,
          stage,
          elapsedMs: Date.now() - startedAt,
          idleMs,
          chunkCount,
          progressCount,
          lastActivityKind,
        })
      }, 15000)
      logger?.warn('AIAgent', 'AI Agent 已交给 utility process 运行', {
        ...baseRunData,
        elapsedMs: Date.now() - startedAt,
      })
      await agentProcessService.run(
        { messages, providerConfig, scope, mcpTools, skills, planMode: payload.planMode === true },
        (chunk) => {
          chunkCount += 1
          lastActivityAt = Date.now()
          lastActivityKind = 'chunk'
          idleWarningCount = 0
          send(chunk)
        },
        (progress) => {
          progressCount += 1
          lastActivityAt = Date.now()
          lastActivityKind = 'progress'
          idleWarningCount = 0
          sendProgress(progress)
        },
        aborter.signal,
      )
      stage = 'done'
      send('[DONE]')
      logger?.warn('AIAgent', 'AI Agent 请求完成', {
        ...baseRunData,
        elapsedMs: Date.now() - startedAt,
        chunkCount,
        progressCount,
      })
      return { success: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger?.error('AIAgent', 'AI Agent 请求失败', {
        ...baseRunData,
        stage,
        elapsedMs: Date.now() - startedAt,
        chunkCount,
        progressCount,
        ...errorToLogData(e),
      })
      sendProgress({ stage: 'error', title: 'AI 助手运行失败', detail: message, at: Date.now() })
      send({ type: 'error', errorText: message })
      send('[DONE]')
      return { success: false, error: message }
    } finally {
      if (watchdog) clearInterval(watchdog)
      agentAborters.delete(runId)
    }
  })

  ipcMain.handle('agent:listConversations', async (_event, scope?: AgentScope) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      return { success: true, conversations: agentConversationStore.list({ scope }) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:loadConversation', async (_event, id: number) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      const conversation = agentConversationStore.load(Number(id))
      return conversation
        ? { success: true, conversation }
        : { success: false, error: 'AI 对话不存在' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:createConversation', async (_event, payload: {
    scope?: AgentScope
    title?: string
    modelProvider?: string
    modelId?: string
  }) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      return { success: true, conversation: agentConversationStore.create(payload || {}) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:deleteConversation', async (_event, id: number) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      agentConversationStore.remove(Number(id))
      return { success: true }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:renameConversation', async (_event, id: number, title: string) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      return { success: true, conversation: agentConversationStore.rename(Number(id), title) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:saveConversationMessages', async (_event, payload: {
    id: number
    messages: UIMessage[]
    scope?: AgentScope
    modelProvider?: string
    modelId?: string
  }) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      if (payload.scope || payload.modelProvider !== undefined || payload.modelId !== undefined) {
        agentConversationStore.updateMeta(Number(payload.id), {
          scope: payload.scope,
          modelProvider: payload.modelProvider,
          modelId: payload.modelId,
        })
      }
      const conversation = agentConversationStore.replaceMessages(Number(payload.id), payload.messages || [])
      return { success: true, conversation }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:getLastConversation', async (_event, scope?: AgentScope) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      return { success: true, conversation: agentConversationStore.getLast(scope) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:abort', (_e, runId: string) => {
    ctx.getLogService()?.warn('AIAgent', '收到 AI Agent 取消请求', { runId })
    agentAborters.get(runId)?.abort()
    return { success: true }
  })

  // ========= 嵌入模型（语义/向量检索）=========
  ipcMain.handle('embedding:getConfig', async () => {
    try {
      const { getEmbeddingConfig } = await import('../../services/ai/embeddingService')
      return { success: true, config: getEmbeddingConfig() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('embedding:setConfig', async (_e, patch: Record<string, unknown>) => {
    try {
      const { saveEmbeddingConfig } = await import('../../services/ai/embeddingService')
      return { success: true, config: saveEmbeddingConfig(patch as any) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('embedding:test', async (_e, cfg: any) => {
    try {
      const { testEmbeddingConfig } = await import('../../services/ai/embeddingService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl() // 测试也走代理，保证"测试通过=实际可用"
      return await testEmbeddingConfig(cfg)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('webSearch:getConfig', async () => {
    try {
      const { getWebSearchConfig } = await import('../../services/ai/webSearchService')
      return { success: true, config: getWebSearchConfig() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('webSearch:setConfig', async (_e, patch: Record<string, unknown>) => {
    try {
      const { saveWebSearchConfig } = await import('../../services/ai/webSearchService')
      return { success: true, config: saveWebSearchConfig(patch as any) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('webSearch:test', async (_e, cfg: any) => {
    try {
      const { testWebSearchConfig } = await import('../../services/ai/webSearchService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl() // 测试也走代理，保证"测试通过=实际可用"
      return await testWebSearchConfig(cfg)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 某会话的向量化状态：是否启用嵌入 + 已建片段数
  ipcMain.handle('embedding:sessionStatus', async (_e, sessionId: string) => {
    try {
      const { getEmbeddingConfig } = await import('../../services/ai/embeddingService')
      const { messageVectorService } = await import('../../services/search/messageVectorService')
      const cfg = getEmbeddingConfig()
      const store = messageVectorService.getSessionVectorStoreInfo(sessionId)
      return { success: true, enabled: messageVectorService.isReady(cfg), count: store.count, store }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 主动为某会话构建向量（懒构建的手动触发；增量，已建则只补新增）
  ipcMain.handle('embedding:buildSession', async (event, sessionId: string) => {
    try {
      const { getEmbeddingConfig } = await import('../../services/ai/embeddingService')
      const { messageVectorService } = await import('../../services/search/messageVectorService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const sender = event.sender
      const cfg = getEmbeddingConfig()
      if (!messageVectorService.isReady(cfg)) {
        return { success: false, error: '未启用或未配置嵌入模型（请先在设置 → 嵌入中配置并启用）' }
      }
      await refreshResolvedProxyUrl()
      const indexed = await messageVectorService.ensureSessionVectors(sessionId, cfg, undefined, (progress) => {
        if (!sender.isDestroyed()) sender.send('embedding:buildProgress', progress)
      })
      return { success: true, indexed }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('embedding:agentResourceStatus', async (_e, kind: 'skill' | 'mcp_tool') => {
    try {
      const { getEmbeddingConfig } = await import('../../services/ai/embeddingService')
      const { agentResourceVectorService } = await import('../../services/agent/agentResourceVectorService')
      const cfg = getEmbeddingConfig()
      if (kind === 'skill') {
        const { skillManagerService } = await import('../../services/skillManagerService')
        return { success: true, status: agentResourceVectorService.getSkillStatus(skillManagerService.getSkillResourceDocuments(), cfg) }
      }
      const { mcpClientService } = await import('../../services/mcpClientService')
      const { buildReadOnlyMcpToolDescriptors } = await import('../../services/agent/mcpToolPolicy')
      const tools = buildReadOnlyMcpToolDescriptors(mcpClientService.getConnectedToolSchemas())
      return { success: true, status: agentResourceVectorService.getMcpStatus(tools, cfg) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('embedding:buildAgentResources', async (event, kind: 'skill' | 'mcp_tool') => {
    try {
      const { getEmbeddingConfig } = await import('../../services/ai/embeddingService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const { agentResourceVectorService } = await import('../../services/agent/agentResourceVectorService')
      const cfg = getEmbeddingConfig()
      if (!agentResourceVectorService.isReady(cfg)) {
        return { success: false, error: '未启用或未配置嵌入模型（请先在设置 → 嵌入中配置并启用）' }
      }
      const sender = event.sender
      await refreshResolvedProxyUrl()
      if (kind === 'skill') {
        const { skillManagerService } = await import('../../services/skillManagerService')
        const indexed = await agentResourceVectorService.buildSkills(skillManagerService.getSkillResourceDocuments(), cfg, (progress) => {
          if (!sender.isDestroyed()) sender.send('embedding:agentResourceBuildProgress', progress)
        })
        return { success: true, indexed }
      }
      const { mcpClientService } = await import('../../services/mcpClientService')
      const { buildReadOnlyMcpToolDescriptors } = await import('../../services/agent/mcpToolPolicy')
      const tools = buildReadOnlyMcpToolDescriptors(mcpClientService.getConnectedToolSchemas())
      if (tools.length === 0) return { success: false, error: '暂无可向量化的已连接只读 MCP 工具' }
      const indexed = await agentResourceVectorService.buildMcpTools(tools, cfg, (progress) => {
        if (!sender.isDestroyed()) sender.send('embedding:agentResourceBuildProgress', progress)
      })
      return { success: true, indexed }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ========= 重排模型（RAG/Skills/MCP 候选重排）=========
  ipcMain.handle('rerank:getConfig', async () => {
    try {
      const { getRerankConfig } = await import('../../services/ai/rerankService')
      return { success: true, config: getRerankConfig() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('rerank:setConfig', async (_e, patch: Record<string, unknown>) => {
    try {
      const { saveRerankConfig } = await import('../../services/ai/rerankService')
      return { success: true, config: saveRerankConfig(patch as any) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('rerank:test', async (_e, cfg: any) => {
    try {
      const { testRerankConfig } = await import('../../services/ai/rerankService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl()
      return await testRerankConfig(cfg)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ========= AI 长期记忆管理（agent_memory.db；纯 DB，无 LLM 依赖）=========
  ipcMain.handle('memory:list', async (_event, opts?: {
    sourceType?: 'profile' | 'fact' | 'relationship'
    sourceTypes?: Array<'profile' | 'fact' | 'relationship'>
    sessionId?: string
    tags?: string[]
    withoutTags?: string[]
    minConfidence?: number
    limit?: number
  }) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const items = memoryDatabase.listMemoryItems({
        ...(opts?.sourceType ? { sourceType: opts.sourceType } : {}),
        ...(Array.isArray(opts?.sourceTypes) ? { sourceTypes: opts.sourceTypes } : {}),
        ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(Array.isArray(opts?.tags) ? { tags: opts.tags } : {}),
        ...(Array.isArray(opts?.withoutTags) ? { withoutTags: opts.withoutTags } : {}),
        ...(opts?.minConfidence !== undefined ? { minConfidence: opts.minConfidence } : {}),
        limit: opts?.limit ?? 300,
      })
      return { success: true, items, stats: memoryDatabase.getStats() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:delete', async (_event, id: number) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      return { success: memoryDatabase.deleteMemoryItem(Number(id)) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:update', async (_event, payload: {
    id: number
    sourceType?: 'profile' | 'fact' | 'relationship'
    content?: string
    importance?: number
    confidence?: number
    tags?: string[]
  }) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const id = Number(payload?.id)
      if (!Number.isFinite(id)) return { success: false, error: '无效的记忆 id' }
      const content = String(payload?.content || '').trim()
      if (!content) return { success: false, error: '记忆内容不能为空' }
      const item = memoryDatabase.updateMemoryItem(id, {
        ...(payload.sourceType ? { sourceType: payload.sourceType } : {}),
        title: content.slice(0, 40),
        content,
        ...(payload.importance !== undefined ? { importance: payload.importance } : {}),
        ...(payload.confidence !== undefined ? { confidence: payload.confidence } : {}),
        ...(Array.isArray(payload.tags) ? { tags: payload.tags } : {}),
      })
      return item ? { success: true, item } : { success: false, error: '未找到该记忆' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:consolidate', async () => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const { getEmbeddingConfig } = await import('../../services/ai/embeddingService')
      const cfg = getEmbeddingConfig()
      // 管理界面整理：用已建向量做语义去重（不现场补嵌入）+ 超量淘汰；未配嵌入则仅超量淘汰
      const semantic = cfg.enabled && cfg.apiKey && cfg.model ? { modelId: cfg.model } : undefined
      return { success: true, result: memoryDatabase.consolidate(50, semantic) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:exportMarkdown', async (_event, outputDir: string) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      return { success: true, result: memoryDatabase.exportMarkdown(outputDir) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('agent:generateTitle', async (_event, payload: {
    firstMessage: string
    modelConfig?: AgentProviderConfigOverride | null
  }) => {
    try {
      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl()
      const providerConfig = resolveProviderConfig(payload.modelConfig)
      const title = await agentProcessService.generateTitle({
        firstMessage: payload.firstMessage,
        providerConfig,
      })
      return { success: true, title }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })


  ipcMain.handle('ai:getProviders', async () => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      return aiService.getAllProviders()
    } catch (e) {
      console.error('[AI] 获取提供商列表失败:', e)
      return []
    }
  })

  ipcMain.handle('ai:getProxyStatus', async () => {
    try {
      const { proxyService } = await import('../../services/ai/proxyService')
      const proxyUrl = await proxyService.getSystemProxy()
      return {
        success: true,
        hasProxy: !!proxyUrl,
        proxyUrl: proxyUrl || null
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:refreshProxy', async () => {
    try {
      const { proxyService } = await import('../../services/ai/proxyService')
      proxyService.clearCache()
      const proxyUrl = await proxyService.getSystemProxy()
      return {
        success: true,
        hasProxy: !!proxyUrl,
        proxyUrl: proxyUrl || null,
        message: proxyUrl ? `已刷新代理: ${proxyUrl}` : '未检测到代理，使用直连'
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:testProxy', async (_, proxyUrl: string, testUrl?: string) => {
    try {
      const { proxyService } = await import('../../services/ai/proxyService')
      const success = await proxyService.testProxy(proxyUrl, testUrl)
      return {
        success,
        message: success ? '代理连接正常' : '代理连接失败'
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:testConnection', async (_, provider: string, apiKey: string, baseURL?: string, protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google') => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl() // 测试连接也走代理，保证"测试通过=实际可用"
      return await aiService.testConnection(provider, apiKey, baseURL, protocol)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:listModels', async (_, options: { provider: string; apiKey?: string; baseURL?: string; protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' }) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      return await aiService.listProviderModels(options)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:estimateCost', async (_, messageCount: number, provider: string) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      const estimatedTokens = messageCount * 33
      const cost = aiService.estimateCost(estimatedTokens, provider)
      return { success: true, tokens: estimatedTokens, cost }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:readGuide', async (_, guideName: string) => {
    try {
      const guidePath = join(__dirname, '../electron/services/ai', guideName)
      if (!existsSync(guidePath)) {
        return { success: false, error: '指南文件不存在' }
      }
      const content = readFileSync(guidePath, 'utf-8')
      return { success: true, content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}
