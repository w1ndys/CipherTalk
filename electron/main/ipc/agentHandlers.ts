import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'

const requestMap = new Map<string, AbortController>()
const THINK_OPEN_TAG = '<think>'
const THINK_BLOCK_RE = /<think>([\s\S]*?)<\/think>\s*/gi
type AgentExportCardBlock = {
  type: 'card'
  kind: 'export-wizard'
  sessionId: string
  sessionName?: string
}
type AgentSavedTextBlock = {
  type: 'text'
  text: string
}
type AgentSavedThinkingBlock = {
  type: 'thinking'
  text: string
}
type AgentSavedToolBlock = {
  type: 'tool'
  name: string
  status: 'running' | 'ok' | 'error'
  args?: Record<string, unknown>
  result?: { kind: 'snippet'; text: string }
  toolCallId?: string
}
type AgentSavedBlock = AgentSavedTextBlock | AgentSavedThinkingBlock | AgentSavedToolBlock | AgentExportCardBlock

function genRequestId(): string {
  return `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function extractThinkTaggedContent(content: string): { thinkingText: string; text: string } {
  let thinkingText = ''
  let found = false
  let text = content.replace(THINK_BLOCK_RE, (_, thinkContent: string) => {
    found = true
    thinkingText += `${thinkingText ? '\n\n' : ''}${thinkContent}`
    return ''
  })

  const openIndex = text.toLowerCase().indexOf(THINK_OPEN_TAG)
  if (openIndex >= 0) {
    found = true
    thinkingText += `${thinkingText ? '\n\n' : ''}${text.slice(openIndex + THINK_OPEN_TAG.length)}`
    text = text.slice(0, openIndex)
  }

  return found ? { thinkingText, text } : { thinkingText: '', text: content }
}

function normalizeToolName(toolName?: string): string {
  const raw = (toolName || '').trim()
  return raw.split('__').pop() || raw
}

function isInitiateExportTool(toolName?: string): boolean {
  return normalizeToolName(toolName) === 'ct_initiate_export'
}

function parseJsonMaybe(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function createExportCardBlock(sessionId: unknown, sessionName?: unknown): AgentExportCardBlock | null {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!id) return null
  const name = typeof sessionName === 'string' && sessionName.trim() ? sessionName.trim() : undefined
  return { type: 'card', kind: 'export-wizard', sessionId: id, sessionName: name }
}

function extractExportCardBlock(result: unknown, depth = 0): AgentExportCardBlock | null {
  if (depth > 5 || result == null) return null

  if (typeof result === 'string') {
    const parsed = parseJsonMaybe(result)
    return parsed ? extractExportCardBlock(parsed, depth + 1) : null
  }

  if (Array.isArray(result)) {
    for (const item of result) {
      const card = extractExportCardBlock(item, depth + 1)
      if (card) return card
    }
    return null
  }

  if (typeof result !== 'object') return null

  const obj = result as Record<string, unknown>
  if (obj.__ct_card === 'export-wizard') {
    return createExportCardBlock(obj.sessionId, obj.sessionName)
  }

  const content = obj.content
  if (Array.isArray(content)) {
    for (const item of content) {
      const card = extractExportCardBlock(item, depth + 1)
      if (card) return card
      if (typeof item === 'object' && item) {
        const text = (item as Record<string, unknown>).text
        if (typeof text === 'string') {
          const textCard = extractExportCardBlock(text, depth + 1)
          if (textCard) return textCard
        }
      }
    }
  }

  for (const key of ['result', 'data', 'payload', 'text', 'message']) {
    const card = extractExportCardBlock(obj[key], depth + 1)
    if (card) return card
  }

  return null
}

function hasCardBlock(cards: AgentExportCardBlock[], next: AgentExportCardBlock): boolean {
  return cards.some(card => card.sessionId === next.sessionId)
}

function appendSavedTextBlock(blocks: AgentSavedBlock[], text: string): AgentSavedBlock[] {
  if (!text) return blocks
  const lastIndex = blocks.length - 1
  if (lastIndex >= 0 && blocks[lastIndex].type === 'text') {
    const existing = blocks[lastIndex] as AgentSavedTextBlock
    return [...blocks.slice(0, lastIndex), { ...existing, text: existing.text + text }]
  }
  return [...blocks, { type: 'text', text }]
}

function appendSavedToolBlock(
  blocks: AgentSavedBlock[],
  toolCallId: string,
  name: string,
  args: Record<string, unknown>
): AgentSavedBlock[] {
  return [...blocks, { type: 'tool', name, status: 'running', args, toolCallId }]
}

function finalizeSavedToolBlock(
  blocks: AgentSavedBlock[],
  toolCallId: string | undefined,
  toolName: string,
  result: unknown,
  error?: string
): AgentSavedBlock[] {
  let updated = false
  const normalizedName = normalizeToolName(toolName)
  return blocks.map(block => {
    if (updated || block.type !== 'tool' || block.status !== 'running') return block
    const sameCall = Boolean(toolCallId && block.toolCallId === toolCallId)
    const sameName = normalizeToolName(block.name) === normalizedName
    if (!sameCall && !sameName) return block
    updated = true
    return {
      ...block,
      status: error ? 'error' : 'ok',
      result: { kind: 'snippet', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) },
    }
  })
}

function appendSavedExportCard(blocks: AgentSavedBlock[], card: AgentExportCardBlock): AgentSavedBlock[] {
  const exists = blocks.some(block =>
    block.type === 'card'
    && block.kind === 'export-wizard'
    && block.sessionId === card.sessionId
  )
  return exists ? blocks : [...blocks, card]
}

function stripInternalToolIds(blocks: AgentSavedBlock[]): AgentSavedBlock[] {
  return blocks.map(block => {
    if (block.type !== 'tool') return block
    const { toolCallId: _toolCallId, ...clean } = block
    return clean
  })
}

function collectVisibleText(blocks: AgentSavedBlock[]): string {
  return blocks
    .filter((block): block is AgentSavedTextBlock => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function serializeSavedBlocks(blocks: AgentSavedBlock[], reasoningText = ''): {
  content: string
  blocksJson?: string
} {
  let visibleBlocks = stripInternalToolIds(blocks)
  const content = collectVisibleText(visibleBlocks)

  if (reasoningText) {
    visibleBlocks = [
      { type: 'thinking', text: reasoningText },
      ...visibleBlocks,
    ]
  }

  return {
    content,
    blocksJson: visibleBlocks.length > 0 ? JSON.stringify(visibleBlocks) : undefined,
  }
}

function markRunningToolsAs(blocks: AgentSavedBlock[], status: 'error' | 'ok', message?: string): AgentSavedBlock[] {
  return blocks.map(block => {
    if (block.type !== 'tool' || block.status !== 'running') return block
    return {
      ...block,
      status,
      result: message ? { kind: 'snippet', text: message } : block.result,
    }
  })
}

export function registerAgentHandlers(ctx: MainProcessContext): void {
  const lastAgentConversationKey = 'lastAgentConversationId'

  ipcMain.handle('agent:sendMessage', async (event, options: {
    requestId?: string
    conversationId?: number
    history: Array<{ role: string; content: string }>
    message: string
    provider: string
    apiKey: string
    model: string
    enableThinking?: boolean
    systemPrompt?: string
    commandHint?: string
    readLimit?: number
    enabledTools?: Array<{ type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>
    scopedSessions?: Array<{ id: string; name: string }>
    skillIds?: string[]
  }) => {
    const requestId = options.requestId?.trim() || genRequestId()
    if (requestMap.has(requestId)) {
      return { success: false, requestId, error: '相同 requestId 的请求已存在' }
    }

    const controller = new AbortController()
    requestMap.set(requestId, controller)

    let convId: number | undefined = options.conversationId

    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      const { agentChatService } = await import('../../services/agentChatService')

      if (agentConversationDb.isInitialized()) {
        if (!convId) {
          convId = agentConversationDb.createConversation('新对话')
        }
        ctx.getConfigService()?.set(lastAgentConversationKey as any, convId as any)
        agentConversationDb.appendMessage(convId, 'user', options.message)
      }

      void (async () => {
        let assistantText = ''
        let reasoningText = ''
        let savedBlocks: AgentSavedBlock[] = []
        const exportCards: AgentExportCardBlock[] = []
        const exportToolArgs = new Map<string, Record<string, unknown>>()
        let assistantSaved = false
        const saveAssistantSnapshot = (statusMessage?: string) => {
          if (!convId || !agentConversationDb.isInitialized() || assistantSaved) return

          const extracted = extractThinkTaggedContent(assistantText)
          if (savedBlocks.length === 0 && extracted.text) {
            savedBlocks = appendSavedTextBlock(savedBlocks, extracted.text)
          }
          if (!reasoningText && extracted.thinkingText) {
            reasoningText = extracted.thinkingText
          }
          const finalBlocks = statusMessage
            ? markRunningToolsAs(savedBlocks, 'error', statusMessage)
            : savedBlocks
          const serialized = serializeSavedBlocks(finalBlocks, reasoningText)
          if (!serialized.content && !serialized.blocksJson) return
          agentConversationDb.appendMessage(convId, 'assistant', serialized.content, serialized.blocksJson)
          assistantSaved = true
        }
        try {
          const { BUILTIN_TOOL_SCHEMAS } = await import('../../services/agentBuiltinTools')
          const { mcpClientService } = await import('../../services/mcpClientService')
          const mcpToolSchemas = mcpClientService.getConnectedToolSchemas()
            .flatMap(({ serverName, tools }) =>
              tools.map(tool => ({
                type: 'function' as const,
                function: {
                  name: `${serverName}__${tool.name}`,
                  description: tool.description || '',
                  parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
                }
              }))
            )
          const mergedTools = [...BUILTIN_TOOL_SCHEMAS, ...mcpToolSchemas, ...(options.enabledTools || [])]

          const suffixParts: string[] = []
          if (options.scopedSessions && options.scopedSessions.length > 0) {
            const list = options.scopedSessions.map(s => `- ${s.name}（sessionId: ${s.id}）`).join('\n')
            suffixParts.push(`用户已指定以下会话范围，请优先围绕这些会话回答，使用工具时传入对应的 sessionId：\n${list}`)
          }
          if (options.commandHint) {
            suffixParts.push(options.commandHint)
          }
          if (options.skillIds && options.skillIds.length > 0) {
            const { skillManagerService } = await import('../../services/skillManagerService')
            for (const skillId of options.skillIds) {
              const r = skillManagerService.readSkillContent(skillId)
              if (r.success && r.content) {
                suffixParts.push(r.content)
              }
            }
          }
          const systemPromptSuffix = suffixParts.length > 0 ? suffixParts.join('\n\n') : undefined

          assistantText = await agentChatService.sendMessage({
            history: options.history as any,
            message: options.message,
            provider: options.provider,
            apiKey: options.apiKey,
            model: options.model,
            enableThinking: options.enableThinking !== false,
            systemPrompt: options.systemPrompt || undefined,
            systemPromptSuffix,
            signal: controller.signal,
            enabledTools: mergedTools as any,
            onStreamEvent: (streamEvent) => {
              if (streamEvent.type === 'tool_call_done' && isInitiateExportTool(streamEvent.toolCall.function.name)) {
                let args: Record<string, unknown> = {}
                try {
                  args = streamEvent.toolCall.function.arguments
                    ? JSON.parse(streamEvent.toolCall.function.arguments)
                    : {}
                } catch {
                  args = {}
                }
                exportToolArgs.set(streamEvent.toolCall.id, args)
              }
              if (streamEvent.type === 'content_delta') {
                savedBlocks = appendSavedTextBlock(savedBlocks, streamEvent.text)
              }
              if (streamEvent.type === 'tool_call_done') {
                let args: Record<string, unknown> = {}
                try {
                  args = streamEvent.toolCall.function.arguments
                    ? JSON.parse(streamEvent.toolCall.function.arguments)
                    : {}
                } catch {
                  args = { arguments: streamEvent.toolCall.function.arguments }
                }
                savedBlocks = appendSavedToolBlock(
                  savedBlocks,
                  streamEvent.toolCall.id,
                  streamEvent.toolCall.function.name,
                  args
                )
              }
              if (streamEvent.type === 'tool_result' && isInitiateExportTool(streamEvent.toolName) && !streamEvent.error) {
                const fallbackArgs = streamEvent.toolCallId ? exportToolArgs.get(streamEvent.toolCallId) : undefined
                const card = extractExportCardBlock(streamEvent.result)
                  || createExportCardBlock(fallbackArgs?.sessionId, fallbackArgs?.sessionName)
                if (card && !hasCardBlock(exportCards, card)) {
                  exportCards.push(card)
                }
              }
              if (streamEvent.type === 'tool_result') {
                savedBlocks = finalizeSavedToolBlock(
                  savedBlocks,
                  streamEvent.toolCallId,
                  streamEvent.toolName,
                  streamEvent.result,
                  streamEvent.error
                )
                const latestCard = exportCards[exportCards.length - 1]
                if (latestCard && isInitiateExportTool(streamEvent.toolName) && !streamEvent.error) {
                  savedBlocks = appendSavedExportCard(savedBlocks, latestCard)
                }
              }
              if (streamEvent.type === 'reasoning_delta') {
                reasoningText += streamEvent.text
                if (reasoningText.length === streamEvent.text.length) {
                  console.log('[Agent] 收到首个 reasoning_delta，长度:', streamEvent.text.length)
                }
              }
              if (streamEvent.type === 'message_done' && streamEvent.reasoningContent) {
                reasoningText = streamEvent.reasoningContent.length > reasoningText.length
                  ? streamEvent.reasoningContent
                  : reasoningText
              }
              event.sender.send('agent:streamEvent', { requestId, event: streamEvent })
            },
            mcpCallTool: async (serverName, toolName, args) => {
              if (!serverName && toolName.startsWith('ct_')) {
                try {
                  const { executeBuiltinTool } = await import('../../services/agentBuiltinTools')
                  const result = await executeBuiltinTool(toolName, args as Record<string, unknown>, { readLimit: options.readLimit })
                  return { success: true, result }
                } catch (e) {
                  return { success: false, error: String(e) }
                }
              }
              try {
                const { mcpClientService } = await import('../../services/mcpClientService')
                return await mcpClientService.callTool(serverName, toolName, args)
              } catch (e) {
                return { success: false, error: String(e) }
              }
            }
          })

          saveAssistantSnapshot()

          event.sender.send('agent:done', { requestId, conversationId: convId })
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg !== 'Aborted') {
            saveAssistantSnapshot(msg)
            ctx.getLogService()?.error('Agent', '对话失败', { error: msg })
            event.sender.send('agent:error', { requestId, message: msg })
          } else {
            saveAssistantSnapshot('已取消')
            event.sender.send('agent:done', { requestId, conversationId: convId })
          }
        } finally {
          requestMap.delete(requestId)
        }
      })()

      return { success: true, requestId, conversationId: convId }
    } catch (e) {
      requestMap.delete(requestId)
      return { success: false, requestId, error: String(e) }
    }
  })

  ipcMain.handle('agent:cancel', async (_, requestId: string) => {
    const controller = requestMap.get(requestId)
    if (controller) {
      controller.abort()
      requestMap.delete(requestId)
      return { success: true }
    }
    return { success: false, error: '未找到对应请求' }
  })

  ipcMain.handle('agent:listConversations', async () => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: true, conversations: [] }
      return { success: true, conversations: agentConversationDb.listConversations() }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('agent:loadConversation', async (_, id: number) => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: false, error: '数据库未初始化' }
      const messages = agentConversationDb.getMessages(id)
      if (messages.length > 0 || agentConversationDb.hasConversation(id)) {
        ctx.getConfigService()?.set(lastAgentConversationKey as any, id as any)
      }
      return { success: true, messages }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('agent:deleteConversation', async (_, id: number) => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: false, error: '数据库未初始化' }
      agentConversationDb.deleteConversation(id)
      const current = ctx.getConfigService()?.get(lastAgentConversationKey as any)
      if (Number(current) === id) {
        ctx.getConfigService()?.set(lastAgentConversationKey as any, 0 as any)
      }
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('agent:newConversation', async () => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: false, error: '数据库未初始化' }
      const id = agentConversationDb.createConversation()
      ctx.getConfigService()?.set(lastAgentConversationKey as any, id as any)
      return { success: true, id }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('agent:appendLocalMessages', async (_, options: {
    conversationId?: number
    messages: Array<{
      role: 'user' | 'assistant'
      content?: string
      blocks?: unknown[]
    }>
  }) => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: false, error: '数据库未初始化' }

      let convId = options.conversationId
      if (!convId) {
        convId = agentConversationDb.createConversation('新对话')
      }
      ctx.getConfigService()?.set(lastAgentConversationKey as any, convId as any)

      for (const message of options.messages || []) {
        const role = message.role === 'assistant' ? 'assistant' : 'user'
        const content = String(message.content || '')
        const blocksJson = Array.isArray(message.blocks) && message.blocks.length > 0
          ? JSON.stringify(message.blocks)
          : undefined
        agentConversationDb.appendMessage(convId, role, content, blocksJson)
      }

      return { success: true, conversationId: convId }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('agent:getLastConversationId', async () => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: true }
      const id = Number(ctx.getConfigService()?.get(lastAgentConversationKey as any))
      if (!Number.isInteger(id) || id <= 0 || !agentConversationDb.hasConversation(id)) {
        return { success: true }
      }
      return { success: true, id }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('agent:updateTitle', async (_, id: number, title: string) => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: false, error: '数据库未初始化' }
      agentConversationDb.updateTitle(id, title)
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('agent:generateTitle', async (_, options: {
    conversationId: number
    userMessage: string
    assistantResponse: string
    provider: string
    apiKey: string
    model: string
  }) => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      const { aiService } = await import('../../services/ai/aiService')
      const title = await aiService.generateAgentTitle({
        provider: options.provider,
        apiKey: options.apiKey,
        model: options.model,
        userMessage: options.userMessage,
        assistantResponse: options.assistantResponse,
      })
      if (agentConversationDb.isInitialized()) {
        agentConversationDb.updateTitle(options.conversationId, title)
      }
      return { success: true, title }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}
