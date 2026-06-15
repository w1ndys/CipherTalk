import { ipcMain } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { UIMessage } from 'ai'
import type { MainProcessContext } from '../context'
import type { AgentProviderConfig, AgentProviderConfigOverride, AgentScope, AgentToolProfile } from '../../services/agent/types'
import type { CodeWorkspaceRef } from '../../services/agent/codeWorkspaceTypes'
import type { PersonaNotes, PersonaRecord, PersonaTtsVoiceBinding } from '../../services/agent/persona/personaTypes'

/** 进行中的 agent 运行：runId → AbortController，用于取消。 */
const agentAborters = new Map<string, AbortController>()
const ttsStreamAborters = new Map<string, AbortController>()
const AGENT_RUN_PROXY_CACHE_TTL_MS = 5 * 60 * 1000
// 准备阶段重排超时：超时直接走降级路径（不影响正确性），别让慢服务拖住首包。
const AGENT_PREP_RERANK_TIMEOUT_MS = 800
const AGENT_PREP_PROGRESS_TITLE = '大模型准备中'

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

function localDateKey(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function sanitizePersonaVoiceForRenderer(ttsVoice: PersonaTtsVoiceBinding | null | undefined): PersonaTtsVoiceBinding | null {
  if (!ttsVoice) return null
  const { samplePath: _samplePath, ...safeVoice } = ttsVoice
  return safeVoice as PersonaTtsVoiceBinding
}

function sanitizePersonaForRenderer(persona: PersonaRecord | null | undefined): PersonaRecord | null {
  if (!persona) return null
  return {
    ...persona,
    ttsVoice: sanitizePersonaVoiceForRenderer(persona.ttsVoice),
  }
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

function selectionTokens(value: string): Set<string> {
  const normalized = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  const tokens = new Set<string>()
  for (const match of normalized.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    tokens.add(match[0].replace(/[_-]+/g, ''))
    for (const part of match[0].split(/[_-]+/)) {
      if (part.length >= 2) tokens.add(part)
    }
  }
  for (const match of value.matchAll(/[\u4e00-\u9fff]+/g)) {
    const text = match[0]
    for (let i = 0; i < text.length - 1; i += 1) tokens.add(text.slice(i, i + 2))
    if (text.length === 1) tokens.add(text)
  }
  return tokens
}

function scoreNameDescription(query: string, parts: Array<{ text: string; weight: number }>): number {
  const queryTokens = selectionTokens(query)
  if (queryTokens.size === 0) return 0
  let score = 0
  for (const part of parts) {
    const tokens = selectionTokens(part.text)
    for (const token of queryTokens) {
      if (tokens.has(token)) score += part.weight * (token.length >= 4 ? 2 : 1)
    }
  }
  return score
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
    toolProfile?: AgentToolProfile
    codeWorkspace?: CodeWorkspaceRef | null
  }) => {
    const sender = event.sender
    const { runId } = payload
    const send = (chunk: unknown) => { if (!sender.isDestroyed()) sender.send('agent:chunk', { runId, chunk }) }
    const sendProgress = (progress: unknown) => { if (!sender.isDestroyed()) sender.send('agent:progress', { runId, progress }) }
    const aborter = new AbortController()
    const logger = ctx.getLogService()
    const startedAt = Date.now()
    const scope = payload.scope ?? { kind: 'global' as const }
    const toolProfile: AgentToolProfile = payload.toolProfile === 'code' || payload.toolProfile === 'hybrid' || payload.toolProfile === 'chat'
      ? payload.toolProfile
      : payload.codeWorkspace ? 'hybrid' : 'chat'
    const codeWorkspace = payload.codeWorkspace && typeof payload.codeWorkspace.root === 'string'
      ? payload.codeWorkspace
      : null
    const initialLastUserText = lastUserTextFromUiMessages(payload.messages || [])
    const baseRunData = {
      runId,
      conversationId: payload.conversationId ?? null,
      messageCount: payload.messages?.length ?? 0,
      lastUserTextLength: initialLastUserText.length,
      toolProfile,
      hasCodeWorkspace: Boolean(codeWorkspace),
      ...scopeToLogData(scope),
    }
    let stage = 'start'
    let chunkCount = 0
    let progressCount = 0
    let lastActivityAt = startedAt
    let lastActivityKind = 'start'
    let idleWarningCount = 0
    let watchdog: NodeJS.Timeout | null = null
    // 发送后各阶段耗时打点：每步一行 [agent:perf] 打到控制台，完整时间线随完成日志落盘
    let perfLastAt = startedAt
    const perfTimeline: string[] = []
    const markPerf = (label: string, detail?: string) => {
      const now = Date.now()
      const entry = `${label} +${now - perfLastAt}ms${detail ? `（${detail}）` : ''}`
      perfTimeline.push(entry)
      console.info(`[agent:perf] ${runId} ${entry}，累计 ${now - startedAt}ms`)
      perfLastAt = now
    }
    // 并行任务用绝对耗时记录（互相重叠，增量没意义）
    const timedTask = async <T,>(label: string, task: Promise<T>): Promise<T> => {
      const t0 = Date.now()
      try {
        return await task
      } finally {
        const entry = `${label} 耗时 ${Date.now() - t0}ms`
        perfTimeline.push(entry)
        console.info(`[agent:perf] ${runId} ${entry}`)
      }
    }
    agentAborters.set(runId, aborter)
    let prepProgressSent = false
    // 准备阶段对用户合并成单一步骤；细分阶段只保留在 stage/perf 日志里。
    const sendPrepProgress = (visible = true) => {
      lastActivityAt = Date.now()
      lastActivityKind = 'progress'
      idleWarningCount = 0
      if (!visible || prepProgressSent) return
      prepProgressSent = true
      progressCount += 1
      sendProgress({
        stage: 'run_started',
        title: AGENT_PREP_PROGRESS_TITLE,
        category: 'prep',
        elapsedMs: Date.now() - startedAt,
        at: Date.now(),
      })
    }
    logger?.warn('AIAgent', 'AI Agent 请求开始', baseRunData)
    try {
      stage = 'import_services'
      sendPrepProgress()
      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      agentProcessService.setLogger(logger)
      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const { convertToModelMessages } = await import('ai')
      markPerf('加载主进程服务模块')
      stage = 'refresh_proxy'
      sendPrepProgress()
      await refreshAgentRunProxyCached(refreshResolvedProxyUrl) // 主进程探测系统代理并持久化，供子进程 agent/嵌入读取
      markPerf('系统代理探测')
      stage = 'resolve_provider'
      sendPrepProgress()
      const providerConfig = resolveProviderConfig(payload.modelConfig)
      markPerf('解析模型配置')
      stage = 'convert_messages'
      sendPrepProgress()
      const uiMessages = shouldStripProviderMetadata(providerConfig)
        ? stripUiMessageProviderMetadata(payload.messages)
        : payload.messages
      const messages = await convertToModelMessages(uiMessages)
      markPerf('整理消息', `${messages.length} 条`)
      const lastUserText = lastUserTextFromUiMessages(payload.messages)
      stage = 'load_context_services'
      sendPrepProgress()
      const { mcpClientService } = await import('../../services/mcpClientService')
      const { buildReadOnlyMcpToolDescriptors } = await import('../../services/agent/mcpToolPolicy')
      const { skillManagerService } = await import('../../services/skillManagerService')
      const { rerankCandidates } = await import('../../services/ai/rerankService')
      const {
        fingerprintMcpToolSchemas,
        fingerprintSkills,
        getCachedMcpToolDescriptors,
        getCachedMcpSelection,
        getCachedSkillSelection,
        setCachedMcpToolDescriptors,
        setCachedMcpSelection,
        setCachedSkillSelection,
      } = await import('../../services/agent/runtimeCache')
      const connectedMcpToolSchemas = mcpClientService.getConnectedToolSchemas()
      const mcpToolVersion = fingerprintMcpToolSchemas(connectedMcpToolSchemas)
      let readOnlyMcpTools = getCachedMcpToolDescriptors(mcpToolVersion)
      if (!readOnlyMcpTools) {
        readOnlyMcpTools = buildReadOnlyMcpToolDescriptors(connectedMcpToolSchemas)
        setCachedMcpToolDescriptors(mcpToolVersion, readOnlyMcpTools)
      }
      const skillManifestVersion = fingerprintSkills(skillManagerService.listSkills())
      markPerf('加载上下文服务模块', `只读 MCP 工具 ${readOnlyMcpTools.length} 个`)
      stage = 'select_tools_and_skills'
      sendPrepProgress()
      // MCP 工具筛选+重排 与 技能选择 互相独立，并行执行；运行期不再使用向量，
      // 只用名称和简介做轻量候选选择，避免 embedding 请求拖慢或误召回。
      const selectMcpToolsTask = async () => {
        if (readOnlyMcpTools.length === 0) {
          return {
            mcpTools: [],
            mcpRerankMeta: { enabled: false, applied: false, candidateCount: 0, resultCount: 0 },
            mcpCandidates: [],
            mcpCacheHit: false,
          }
        }
        const cached = getCachedMcpSelection(lastUserText, mcpToolVersion)
        if (cached) {
          return {
            mcpTools: cached,
            mcpRerankMeta: { enabled: false, applied: false, candidateCount: readOnlyMcpTools.length, resultCount: cached.length },
            mcpCandidates: readOnlyMcpTools,
            mcpCacheHit: true,
          }
        }
        const scoredCandidates = readOnlyMcpTools
          .map((tool) => ({
            tool,
            score: scoreNameDescription(lastUserText, [
              { text: `${tool.serverName} ${tool.toolName} ${tool.name}`, weight: 3 },
              { text: tool.description || '', weight: 2 },
            ]),
          }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        const candidates = scoredCandidates.length > 0
          ? scoredCandidates.slice(0, 24).map((item) => item.tool)
          : readOnlyMcpTools
        if (candidates.length === 0) {
          setCachedMcpSelection(lastUserText, mcpToolVersion, [])
          return {
            mcpTools: [],
            mcpRerankMeta: { enabled: false, applied: false, candidateCount: 0, resultCount: 0 },
            mcpCandidates: candidates,
            mcpCacheHit: false,
          }
        }
        const { items, meta } = await rerankCandidates(
          lastUserText,
          candidates.map((tool) => ({
            item: tool,
            text: [
              `MCP ${tool.serverName}/${tool.toolName}`,
              tool.name,
              tool.description || '',
            ].filter(Boolean).join('\n'),
          })),
          { topN: 8, timeoutMsOverride: AGENT_PREP_RERANK_TIMEOUT_MS },
        )
        setCachedMcpSelection(lastUserText, mcpToolVersion, items)
        return { mcpTools: items, mcpRerankMeta: meta, mcpCandidates: candidates, mcpCacheHit: false }
      }
      const selectSkillsTask = async () => {
        const cached = getCachedSkillSelection(lastUserText, skillManifestVersion)
        if (cached) return { skills: cached, skillCacheHit: true }
        const skills = await skillManagerService.selectSkillsForAgent(lastUserText)
        setCachedSkillSelection(lastUserText, skillManifestVersion, skills)
        return { skills, skillCacheHit: false }
      }
      const [{ mcpTools, mcpRerankMeta, mcpCandidates, mcpCacheHit }, { skills, skillCacheHit }] = await Promise.all([
        timedTask('MCP 工具筛选（名称简介+重排）', selectMcpToolsTask()),
        timedTask('技能筛选（名称简介+重排）', selectSkillsTask()),
      ])
      markPerf('工具与技能筛选', `MCP ${mcpTools.length} 个${mcpCacheHit ? '·缓存' : ''} / 技能 ${skills.length} 个${skillCacheHit ? '·缓存' : ''}`)
      sendPrepProgress()
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
        mcpSelectionCacheHit: mcpCacheHit,
        mcpRerankApplied: mcpRerankMeta.applied,
        mcpRerankError: mcpRerankMeta.error || null,
        selectedSkillCount: skills.length,
        selectedSkills: skills.map((skill) => skill.name),
        skillSelectionCacheHit: skillCacheHit,
      })
      stage = 'run_agent_process'
      sendPrepProgress()
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
      markPerf('交给 Agent 子进程')
      logger?.warn('AIAgent', 'AI Agent 已交给 utility process 运行', {
        ...baseRunData,
        elapsedMs: Date.now() - startedAt,
        prepTimeline: perfTimeline.slice(),
      })
      let firstChunkSeen = false
      let firstModelOutputSeen = false
      await agentProcessService.run(
        { messages, providerConfig, scope, mcpTools, skills, planMode: payload.planMode === true, toolProfile, codeWorkspace },
        (chunk) => {
          chunkCount += 1
          lastActivityAt = Date.now()
          lastActivityKind = 'chunk'
          idleWarningCount = 0
          const chunkType = (chunk as { type?: string })?.type || ''
          if (!firstChunkSeen) {
            firstChunkSeen = true
            markPerf('子进程回传首个 chunk', chunkType)
          }
          if (!firstModelOutputSeen && (chunkType === 'text-delta' || chunkType === 'reasoning-delta' || chunkType === 'tool-input-start')) {
            firstModelOutputSeen = true
            markPerf('模型首个增量输出', chunkType)
          }
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
      markPerf('本次运行结束')
      logger?.warn('AIAgent', 'AI Agent 请求完成', {
        ...baseRunData,
        elapsedMs: Date.now() - startedAt,
        chunkCount,
        progressCount,
        perfTimeline,
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
        perfTimeline,
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

  ipcMain.handle('agent:deleteConversationsByScope', async (_event, scope: AgentScope) => {
    try {
      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      return agentConversationStore.removeByScope(scope)
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

  // ========== 文字转语音（TTS） ==========

  ipcMain.handle('tts:getConfig', async () => {
    try {
      const { getTtsConfig, isTtsAvailable } = await import('../../services/ai/ttsService')
      const config = getTtsConfig()
      return { success: true, config, available: isTtsAvailable(config) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('tts:setConfig', async (_e, patch: Record<string, unknown>) => {
    try {
      const { saveTtsConfig } = await import('../../services/ai/ttsService')
      return { success: true, config: saveTtsConfig(patch as any) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('tts:test', async (_e, cfg: any) => {
    try {
      const { testTtsConfig } = await import('../../services/ai/ttsService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl() // 测试也走代理，保证"测试通过=实际可用"
      return await testTtsConfig(cfg)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e), errorCode: 'SYNTHESIS_FAILED' }
    }
  })

  ipcMain.handle('tts:speak', async (_e, text: string, options?: { config?: Record<string, unknown>; personaVoice?: unknown }) => {
    try {
      const { resolvePersonaVoiceTtsConfig, synthesizeSpeech } = await import('../../services/ai/ttsService')
      const configPatch = options?.config && typeof options.config === 'object' ? options.config : undefined
      const config = options?.personaVoice && typeof options.personaVoice === 'object'
        ? resolvePersonaVoiceTtsConfig(options.personaVoice as any, configPatch as any)
        : configPatch
      return await synthesizeSpeech(String(text || ''), config ? { config: config as any, useCache: true } : undefined)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e), errorCode: 'SYNTHESIS_FAILED' }
    }
  })

  ipcMain.handle('tts:streamCancel', async (_e, streamId: string) => {
    const id = String(streamId || '')
    const controller = ttsStreamAborters.get(id)
    if (controller) {
      controller.abort()
      ttsStreamAborters.delete(id)
    }
    return { success: true }
  })

  ipcMain.handle('tts:stream', async (event, streamId: string, text: string, options?: { config?: Record<string, unknown>; personaVoice?: unknown }) => {
    const id = String(streamId || '')
    const controller = new AbortController()
    if (id) ttsStreamAborters.set(id, controller)

    const sendEvent = (payload: Record<string, unknown>) => {
      if (!id || event.sender.isDestroyed()) return
      event.sender.send('tts:streamEvent', { streamId: id, ...payload })
    }

    try {
      const { resolvePersonaVoiceTtsConfig, synthesizeSpeechStream } = await import('../../services/ai/ttsService')
      const configPatch = options?.config && typeof options.config === 'object' ? options.config : undefined
      const config = options?.personaVoice && typeof options.personaVoice === 'object'
        ? resolvePersonaVoiceTtsConfig(options.personaVoice as any, configPatch as any)
        : configPatch

      sendEvent({ type: 'start' })
      const result = await synthesizeSpeechStream(String(text || ''), {
        config: config as any,
        useCache: true,
        signal: controller.signal,
        onAudioChunk: (chunk) => {
          sendEvent({
            type: 'chunk',
            audioBase64: Buffer.from(chunk.data).toString('base64'),
            format: chunk.format,
            sampleRate: chunk.sampleRate,
            channels: chunk.channels,
          })
        },
      })

      if (result.success && !result.streamed && result.audioBase64) {
        sendEvent({
          type: 'complete',
          audioBase64: result.audioBase64,
          mimeType: result.mimeType,
          cached: result.cached,
        })
      }
      sendEvent({
        type: result.success ? 'end' : 'error',
        success: result.success,
        error: result.error,
        errorCode: result.errorCode,
        streamed: result.streamed,
        cached: result.cached,
        mimeType: result.mimeType,
      })

      return result.streamed ? { ...result, audioBase64: undefined } : result
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      sendEvent({ type: 'error', success: false, error, errorCode: 'SYNTHESIS_FAILED' })
      return { success: false, error, errorCode: 'SYNTHESIS_FAILED' }
    } finally {
      if (id && ttsStreamAborters.get(id) === controller) {
        ttsStreamAborters.delete(id)
      }
    }
  })

  // ========== AI 作图 ==========

  ipcMain.handle('imageGen:getConfig', async () => {
    try {
      const { getImageGenConfig, isImageGenAvailable } = await import('../../services/ai/imageGenService')
      const config = getImageGenConfig()
      return { success: true, config, available: isImageGenAvailable(config) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('imageGen:setConfig', async (_e, patch: Record<string, unknown>) => {
    try {
      const { saveImageGenConfig } = await import('../../services/ai/imageGenService')
      return { success: true, config: saveImageGenConfig(patch as any) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('imageGen:test', async (_e, cfg: any) => {
    try {
      const { testImageGenConfig } = await import('../../services/ai/imageGenService')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      await refreshResolvedProxyUrl() // 测试也走代理，保证"测试通过=实际可用"
      return await testImageGenConfig(cfg)
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

  // ========= AI 长期记忆管理（cachePath/memory-bank；纯 Markdown）=========
  ipcMain.handle('memory:migrationStatus', async () => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      return { success: true, status: memoryDatabase.getMigrationStatus() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:migrateLegacy', async () => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      return { success: true, result: memoryDatabase.migrateLegacyDatabase() }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:list', async (_event, opts?: {
    sourceType?: string
    sourceTypes?: string[]
    sessionId?: string
    tags?: string[]
    withoutTags?: string[]
    minConfidence?: number
    limit?: number
  }) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const sourceType = String(opts?.sourceType || '').trim()
      const sourceTypes = Array.isArray(opts?.sourceTypes)
        ? opts.sourceTypes.map((type) => String(type || '').trim()).filter(Boolean)
        : undefined
      const items = memoryDatabase.listMemoryItems({
        ...(sourceType ? { sourceType: sourceType as any } : {}),
        ...(sourceTypes ? { sourceTypes: sourceTypes as any } : {}),
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

  ipcMain.handle('memory:listDiaries', async (_event, limit?: number) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      return { success: true, diaries: memoryDatabase.listDiaries(limit) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:readDiary', async (_event, date: string) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const diary = memoryDatabase.readDiary(String(date || ''))
      return diary ? { success: true, diary } : { success: false, error: '未找到该日记' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:deleteDiary', async (_event, date: string) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const deleted = memoryDatabase.deleteDiary(String(date || ''))
      return deleted ? { success: true } : { success: false, error: '未找到该日记' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:summarizeTodayDiary', async () => {
    try {
      const date = localDateKey()
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const existing = memoryDatabase.readDiary(date)
      if (existing) return { success: true, alreadyExists: true, diary: existing }

      const [
        { resolveProviderConfig },
        { runDailyDiaryConsolidation },
        { readUnreadDiarySource }
      ] = await Promise.all([
        import('../../services/agent/resolveProviderConfig'),
        import('../../services/agent/tools/memory'),
        import('../../services/memory/nightlyMemoryService')
      ])
      const customPrompt = String(ctx.getConfigService()?.get('diaryCustomPrompt' as any) || '').trim()
      const unreadMessages = await readUnreadDiarySource().catch(() => '')
      await runDailyDiaryConsolidation(date, resolveProviderConfig(), undefined, { unreadMessages, customPrompt })
      const diary = memoryDatabase.readDiary(date)
      return diary ? { success: true, alreadyExists: false, diary } : { success: false, error: '日记生成后未找到文件' }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('memory:create', async (_event, payload: {
    memoryUid?: string
    sourceType?: string
    content?: string
    title?: string
    importance?: number
    confidence?: number
    tags?: string[]
  }) => {
    try {
      const { memoryDatabase } = await import('../../services/memory/memoryDatabase')
      const content = String(payload?.content || '').trim()
      if (!content) return { success: false, error: '记忆内容不能为空' }
      const sourceType = String(payload?.sourceType || 'profile').trim()
      const memoryUid = String(payload?.memoryUid || `${sourceType}:${Date.now()}`).trim()
      const item = memoryDatabase.upsertMemoryItem({
        memoryUid,
        sourceType: sourceType as any,
        title: String(payload?.title || content.slice(0, 40)),
        content,
        ...(payload?.importance !== undefined ? { importance: payload.importance } : {}),
        ...(payload?.confidence !== undefined ? { confidence: payload.confidence } : {}),
        ...(Array.isArray(payload?.tags) ? { tags: payload.tags } : {}),
      })
      return { success: true, item }
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
    sourceType?: string
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
      const sourceType = String(payload?.sourceType || '').trim()
      const item = memoryDatabase.updateMemoryItem(id, {
        ...(sourceType ? { sourceType: sourceType as any } : {}),
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
      const { ONBOARDING_PROFILE_UIDS, memoryDatabase } = await import('../../services/memory/memoryDatabase')
      let profileBuilt = false
      let profileBuildError = ''
      const hasOnboardingProfile = ONBOARDING_PROFILE_UIDS.some((uid) => memoryDatabase.getMemoryItemByUid(uid))
      if (hasOnboardingProfile) {
        try {
          const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
          const { buildOnboardingUserProfileMemory } = await import('../../services/agent/tools/memory')
          const buildResult = await buildOnboardingUserProfileMemory(resolveProviderConfig())
          profileBuilt = buildResult.built
          profileBuildError = buildResult.reason || ''
        } catch (error) {
          profileBuildError = error instanceof Error ? error.message : String(error)
        }
      }
      return { success: true, result: { ...memoryDatabase.consolidate(50), profileBuilt, ...(profileBuildError ? { profileBuildError } : {}) } }
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

  // ========= 克隆好友（数字分身画像，agent_personas.db）=========
  // 克隆聊天：加载画像 → 子进程预检索 + 单次 generateText；完整结果按气泡经 persona:chunk 推回
  ipcMain.handle('persona:chat', async (event, payload: {
    runId: string
    sessionId: string
    messages: UIMessage[]
  }) => {
    const sender = event.sender
    const { runId } = payload
    const sessionId = String(payload?.sessionId || '').trim()
    const send = (chunk: unknown) => { if (!sender.isDestroyed()) sender.send('persona:chunk', { runId, chunk }) }
    const sendProgress = (progress: unknown) => { if (!sender.isDestroyed()) sender.send('persona:progress', { runId, progress }) }
    const aborter = new AbortController()
    const logger = ctx.getLogService()
    agentAborters.set(runId, aborter)
    try {
      if (!sessionId) return { success: false, error: '缺少 sessionId' }
      const { personaStore } = await import('../../services/agent/persona/personaStore')
      const persona = personaStore.get(sessionId)
      if (!persona) return { success: false, error: '尚未克隆该好友，请先生成画像' }

      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const { convertToModelMessages } = await import('ai')
      const providerConfig = resolveProviderConfig()
      await refreshAgentRunProxyCached(refreshResolvedProxyUrl)
      const messages = await convertToModelMessages(payload.messages || [])

      // 导演笔记（纠正规则 + 分身对话记忆）：读取失败不阻塞聊天
      let notes: PersonaNotes | undefined
      try {
        const { personaNotesStore } = await import('../../services/agent/persona/personaNotesStore')
        notes = personaNotesStore.getNotes(sessionId)
      } catch { /* 无笔记照常聊 */ }

      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      agentProcessService.setLogger(logger)
      await agentProcessService.personaChat(
        {
          providerConfig,
          persona: {
            sessionId: persona.sessionId,
            displayName: persona.displayName,
            card: persona.card,
            fewShots: persona.fewShots,
            stats: persona.stats,
            profile: persona.profile,
            notes,
            stickers: persona.stickers,
            ttsVoice: persona.ttsVoice,
          },
          messages,
        },
        send,
        sendProgress,
        aborter.signal,
      )
      send('[DONE]')
      return { success: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger?.error('Persona', '克隆聊天失败', { runId, sessionId, ...errorToLogData(e) })
      send({ type: 'error', errorText: message })
      send('[DONE]')
      return { success: false, error: message }
    } finally {
      agentAborters.delete(runId)
    }
  })

  ipcMain.handle('persona:abort', (_e, runId: string) => {
    agentAborters.get(runId)?.abort()
    return { success: true }
  })

  ipcMain.handle('persona:get', async (_event, sessionId: string) => {
    try {
      const { personaStore } = await import('../../services/agent/persona/personaStore')
      return { success: true, persona: sanitizePersonaForRenderer(personaStore.get(String(sessionId || '').trim())) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('persona:list', async () => {
    try {
      const { personaStore } = await import('../../services/agent/persona/personaStore')
      return { success: true, personas: personaStore.list().map((persona) => sanitizePersonaForRenderer(persona)) }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('persona:cloneVoice', async (_event, payload: { sessionId: string; displayName?: string }) => {
    try {
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const { clonePersonaVoiceFromSession } = await import('../../services/agent/persona/personaVoiceCloneService')
      await refreshResolvedProxyUrl()
      const result = await clonePersonaVoiceFromSession({
        sessionId: String(payload?.sessionId || '').trim(),
        displayName: String(payload?.displayName || '').trim(),
        logger: ctx.getLogService(),
      })
      if (!result.success) return result
      return {
        ...result,
        persona: sanitizePersonaForRenderer(result.persona),
        voice: sanitizePersonaVoiceForRenderer(result.voice),
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('persona:exportVoiceSample', async (_event, payload: { sessionId: string; displayName?: string; outputPath: string }) => {
    try {
      const { exportPersonaVoiceSampleFromSession } = await import('../../services/agent/persona/personaVoiceCloneService')
      return await exportPersonaVoiceSampleFromSession({
        sessionId: String(payload?.sessionId || '').trim(),
        displayName: String(payload?.displayName || '').trim(),
        outputPath: String(payload?.outputPath || '').trim(),
        minSeconds: 10,
        logger: ctx.getLogService(),
      })
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  ipcMain.handle('persona:delete', async (_event, sessionId: string) => {
    try {
      const id = String(sessionId || '').trim()
      const { personaStore } = await import('../../services/agent/persona/personaStore')
      const removed = personaStore.remove(id)
      // 问答对索引与导演笔记一并清掉（失败不影响画像删除结果）
      try {
        const { personaPairStore } = await import('../../services/agent/persona/personaPairStore')
        personaPairStore.remove(id)
        const { personaNotesStore } = await import('../../services/agent/persona/personaNotesStore')
        personaNotesStore.remove(id)
      } catch { /* ignore */ }
      return { success: removed }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // ========= 自动进化 =========
  // 防止同一分身的增量刷新/反思并发重入
  const personaEvolveInFlight = new Set<string>()
  /** 增量进化触发门槛：水位之后对方新消息达到此数才重蒸馏 */
  const PERSONA_REFRESH_MIN_FRIEND_MESSAGES = 50
  /** 对话反思触发门槛：未反思消息达到此数才跑一次 */
  const PERSONA_REFLECT_MIN_MESSAGES = 10

  // 真实数据回路：微信里和 TA 还在继续聊 → 新增消息够多时后台增量重蒸馏（打开分身时由页面触发）
  ipcMain.handle('persona:refreshIfStale', async (_event, payload: { sessionId: string }) => {
    const sessionId = String(payload?.sessionId || '').trim()
    const flightKey = `refresh:${sessionId}`
    const logger = ctx.getLogService()
    if (!sessionId) return { success: false, error: '缺少 sessionId' }
    if (personaEvolveInFlight.has(flightKey)) return { success: true, refreshed: false }
    personaEvolveInFlight.add(flightKey)
    try {
      const { personaStore } = await import('../../services/agent/persona/personaStore')
      const persona = personaStore.get(sessionId)
      if (!persona) return { success: false, error: '尚未克隆该好友' }

      const { chatSearchIndexService } = await import('../../services/search/chatSearchIndexService')
      const messages = await chatSearchIndexService.listSessionMemoryMessages(sessionId, undefined, 2000)
      // 旧画像没有水位列：按画像更新时间当水位
      const watermark = persona.corpusUntil || Math.floor(persona.updatedAt / 1000)
      const fresh = messages.filter((m) => m.createTime > watermark)
      if (fresh.length === 0) return { success: true, refreshed: false }

      const { buildPersonaCorpus, mergeTurns, extractPersonaPairs } = await import('../../services/agent/persona/personaCorpus')
      const freshCorpus = buildPersonaCorpus(fresh, persona.displayName)
      if (freshCorpus.stats.friendMessageCount < PERSONA_REFRESH_MIN_FRIEND_MESSAGES) {
        return { success: true, refreshed: false }
      }

      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const providerConfig = resolveProviderConfig()
      await refreshAgentRunProxyCached(refreshResolvedProxyUrl)

      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      agentProcessService.setLogger(logger)
      const revised = await agentProcessService.revisePersona({
        providerConfig,
        friendName: persona.displayName,
        card: persona.card,
        profile: persona.profile,
        newCorpusText: freshCorpus.corpusText,
      })

      const corpusUntil = fresh.reduce((max, m) => Math.max(max, m.createTime), watermark)
      const updated = personaStore.patch(sessionId, {
        card: revised.card,
        profile: revised.profile,
        // 新黄金样本追加在后、总量封顶（最新的优先保留）
        fewShots: [...persona.fewShots, ...revised.newFewShots].slice(-10),
        // 群聊来源标记保留：画像卡里群聊提炼的内容不会因增量修订消失
        stats: {
          ...buildPersonaCorpus(messages, persona.displayName).stats,
          ...(persona.stats.groupMessageCount
            ? { groupMessageCount: persona.stats.groupMessageCount, groupSessionCount: persona.stats.groupSessionCount }
            : {}),
        },
        corpusUntil,
      })

      // 新问答对入索引 + 补嵌入（失败不影响画像修订结果）
      try {
        const { personaPairStore } = await import('../../services/agent/persona/personaPairStore')
        personaPairStore.append(sessionId, extractPersonaPairs(mergeTurns(fresh)))
        await personaPairStore.embedPending(sessionId)
      } catch (e) {
        logger?.warn('Persona', '增量问答对索引失败', { sessionId, ...errorToLogData(e) })
      }

      logger?.warn('Persona', '画像增量进化完成', {
        sessionId,
        freshFriendMessages: freshCorpus.stats.friendMessageCount,
        newFewShots: revised.newFewShots.length,
      })
      return { success: true, refreshed: true, persona: sanitizePersonaForRenderer(updated) }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger?.error('Persona', '画像增量进化失败', { sessionId, ...errorToLogData(e) })
      return { success: false, error: message }
    } finally {
      personaEvolveInFlight.delete(flightKey)
    }
  })

  // 克隆对话回路：每轮保存后由页面触发；未反思消息够多时提炼导演笔记 + 对话摘要
  ipcMain.handle('persona:reflect', async (_event, payload: { sessionId: string; conversationId: number }) => {
    const sessionId = String(payload?.sessionId || '').trim()
    const conversationId = Number(payload?.conversationId || 0)
    const flightKey = `reflect:${sessionId}:${conversationId}`
    const logger = ctx.getLogService()
    if (!sessionId || !Number.isFinite(conversationId) || conversationId <= 0) {
      return { success: false, error: '缺少 sessionId 或 conversationId' }
    }
    if (personaEvolveInFlight.has(flightKey)) return { success: true, reflected: false }
    personaEvolveInFlight.add(flightKey)
    try {
      const { personaStore } = await import('../../services/agent/persona/personaStore')
      const persona = personaStore.get(sessionId)
      if (!persona) return { success: false, error: '尚未克隆该好友' }

      const { agentConversationStore } = await import('../../services/agent/conversationStore')
      const conversation = agentConversationStore.load(conversationId)
      if (!conversation || conversation.scope.kind !== 'persona' || conversation.scope.sessionId !== sessionId) {
        return { success: false, error: '对话不存在或不属于该分身' }
      }

      const { personaNotesStore } = await import('../../services/agent/persona/personaNotesStore')
      const reflectedCount = personaNotesStore.getReflectedCount(sessionId, conversationId)
      const unreflected = conversation.messages.slice(reflectedCount)
      if (unreflected.length < PERSONA_REFLECT_MIN_MESSAGES) return { success: true, reflected: false }

      const transcript = unreflected
        .map((m) => {
          // 表情包气泡的 JSON 载荷对反思没用，压成可读标记
          const text = textFromUiMessage(m)
            .replace(/\[表情包\]\{[^}]*\}/g, '[发了个表情包]')
            .replace(/\n+/g, '／')
            .trim()
          return text ? `${m.role === 'user' ? '我' : `${persona.displayName}（分身）`}: ${text}` : ''
        })
        .filter(Boolean)
        .join('\n')
        .slice(-8000)
      if (!transcript) {
        personaNotesStore.setReflectedCount(sessionId, conversationId, conversation.messages.length)
        return { success: true, reflected: false }
      }

      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { refreshResolvedProxyUrl } = await import('../../services/ai/proxyFetch')
      const providerConfig = resolveProviderConfig()
      await refreshAgentRunProxyCached(refreshResolvedProxyUrl)

      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      agentProcessService.setLogger(logger)
      const result = await agentProcessService.reflectPersona({
        providerConfig,
        friendName: persona.displayName,
        transcript,
      })

      if (result.corrections.length > 0) personaNotesStore.add(sessionId, 'correction', result.corrections)
      if (result.summary) {
        const date = new Date().toISOString().slice(0, 10)
        personaNotesStore.add(sessionId, 'episode', [`${date}：${result.summary}`])
      }
      personaNotesStore.setReflectedCount(sessionId, conversationId, conversation.messages.length)

      logger?.warn('Persona', '克隆对话反思完成', {
        sessionId,
        conversationId,
        corrections: result.corrections.length,
        hasSummary: !!result.summary,
      })
      return { success: true, reflected: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      logger?.error('Persona', '克隆对话反思失败', { sessionId, conversationId, ...errorToLogData(e) })
      return { success: false, error: message }
    } finally {
      personaEvolveInFlight.delete(flightKey)
    }
  })

  // 触发画像 ETL：读消息（懒索引）→ 轮次合并/统计 → 子进程 LLM 提取 → 入库；进度经 persona:buildProgress 推送
  ipcMain.handle('persona:build', async (event, payload: { sessionId: string; displayName?: string }) => {
    const sender = event.sender
    const sessionId = String(payload?.sessionId || '').trim()
    const displayName = String(payload?.displayName || '').trim() || sessionId
    const logger = ctx.getLogService()
    const { buildPersonaFromSession } = await import('../../services/agent/persona/personaBuildService')
    const result = await buildPersonaFromSession({
      sessionId,
      displayName,
      logger,
      onProgress: (progress) => {
        if (!sender.isDestroyed()) sender.send('persona:buildProgress', progress)
      },
    })
    if (result.success && result.persona) {
      return { ...result, persona: sanitizePersonaForRenderer(result.persona) }
    }
    return result
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
