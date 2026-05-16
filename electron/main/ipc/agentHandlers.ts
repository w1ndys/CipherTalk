import { ipcMain } from 'electron'
import type { MainProcessContext } from '../context'

const requestMap = new Map<string, AbortController>()
const THINK_OPEN_TAG = '<think>'
const THINK_BLOCK_RE = /<think>([\s\S]*?)<\/think>\s*/gi

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

export function registerAgentHandlers(ctx: MainProcessContext): void {
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
    enabledTools?: Array<{ type: string; function: { name: string; description?: string; parameters?: Record<string, unknown> } }>
    scopedSessions?: Array<{ id: string; name: string }>
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
        agentConversationDb.appendMessage(convId, 'user', options.message)
      }

      void (async () => {
        let assistantText = ''
        let reasoningText = ''
        try {
          const { BUILTIN_TOOL_SCHEMAS } = await import('../../services/agentBuiltinTools')
          const mergedTools = [...BUILTIN_TOOL_SCHEMAS, ...(options.enabledTools || [])]

          let systemPromptSuffix: string | undefined
          if (options.scopedSessions && options.scopedSessions.length > 0) {
            const list = options.scopedSessions.map(s => `- ${s.name}（sessionId: ${s.id}）`).join('\n')
            systemPromptSuffix = `用户已指定以下会话范围，请优先围绕这些会话回答，使用工具时传入对应的 sessionId：\n${list}`
          }

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
                  const result = await executeBuiltinTool(toolName, args as Record<string, unknown>)
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

          if (convId && agentConversationDb.isInitialized()) {
            let blocksJson: string | undefined
            const extracted = extractThinkTaggedContent(assistantText)
            let savedText = extracted.text

            if (!reasoningText && extracted.thinkingText) {
              reasoningText = extracted.thinkingText
            }

            if (reasoningText) {
              blocksJson = JSON.stringify([
                { type: 'thinking', text: reasoningText },
                { type: 'text', text: savedText },
              ])
            }
            agentConversationDb.appendMessage(convId, 'assistant', savedText, blocksJson)
          }

          event.sender.send('agent:done', { requestId, conversationId: convId })
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e)
          if (msg !== 'Aborted') {
            ctx.getLogService()?.error('Agent', '对话失败', { error: msg })
            event.sender.send('agent:error', { requestId, message: msg })
          } else {
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
      return { success: true, messages: agentConversationDb.getMessages(id) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('agent:deleteConversation', async (_, id: number) => {
    try {
      const { agentConversationDb } = await import('../../services/agentConversationDb')
      if (!agentConversationDb.isInitialized()) return { success: false, error: '数据库未初始化' }
      agentConversationDb.deleteConversation(id)
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
