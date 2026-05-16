import { useState, useRef, useEffect } from 'react'
import type { AgentConversationSummary, AgentMessageRecord } from '../../../types/electron'
import type { AttachedResource, Message, AssistantBlock, ToolBlock, TextBlock, ThinkingBlock } from '../types'

function recordToMessage(r: AgentMessageRecord): Message {
  let blocks: AssistantBlock[] | undefined
  if (r.blocksJson) {
    try { blocks = JSON.parse(r.blocksJson) } catch {}
  }
  return {
    id: String(r.id),
    role: r.role as Message['role'],
    content: r.content || undefined,
    blocks,
  }
}

async function getProviderSettings(): Promise<{ provider: string; apiKey: string; model: string; enableThinking: boolean }> {
  const defaults = { provider: 'zhipu', apiKey: '', model: '', enableThinking: true }
  try {
    const api = window.electronAPI
    if (!api?.config) return defaults
    const currentProvider = (await api.config.get('aiCurrentProvider') as string) || defaults.provider
    const providerConfigs = (await api.config.get('aiProviderConfigs') as Record<string, { apiKey: string; model: string }>) || {}
    const enableThinking = (await api.config.get('aiEnableThinking')) !== false
    const cfg = providerConfigs[currentProvider] || { apiKey: '', model: '' }
    return { provider: currentProvider, apiKey: cfg.apiKey || '', model: cfg.model || '', enableThinking }
  } catch {
    return defaults
  }
}

const THINK_OPEN_TAG = '<think>'
const THINK_CLOSE_TAG = '</think>'

function appendTextBlock(blocks: AssistantBlock[], text: string): AssistantBlock[] {
  if (!text) return blocks
  const lastIdx = blocks.length - 1
  if (lastIdx >= 0 && blocks[lastIdx].type === 'text') {
    const updated: TextBlock = { ...(blocks[lastIdx] as TextBlock), text: (blocks[lastIdx] as TextBlock).text + text }
    return [...blocks.slice(0, lastIdx), updated]
  }
  return [...blocks, { type: 'text', text } as TextBlock]
}

function setThinkingStreaming(blocks: AssistantBlock[], streaming: boolean): AssistantBlock[] {
  let changed = false
  const next = blocks.map(b => {
    if (b.type !== 'thinking') return b
    const existing = b as ThinkingBlock
    if (existing.streaming === streaming) return b
    changed = true
    return { ...existing, streaming }
  })
  return changed ? next : blocks
}

function ensureThinkingBlock(blocks: AssistantBlock[], streaming = true): AssistantBlock[] {
  const thinkIdx = blocks.findIndex(b => b.type === 'thinking')
  if (thinkIdx >= 0) {
    const existing = blocks[thinkIdx] as ThinkingBlock
    if (existing.streaming === streaming) return blocks
    return [...blocks.slice(0, thinkIdx), { ...existing, streaming }, ...blocks.slice(thinkIdx + 1)]
  }
  return [{ type: 'thinking' as const, text: '', streaming }, ...blocks]
}

function appendThinkBlock(blocks: AssistantBlock[], text: string, streaming = true): AssistantBlock[] {
  if (!text) return blocks
  const thinkIdx = blocks.findIndex(b => b.type === 'thinking')
  if (thinkIdx >= 0) {
    const existing = blocks[thinkIdx] as ThinkingBlock
    const updated: ThinkingBlock = { ...existing, text: existing.text + text, streaming }
    return [...blocks.slice(0, thinkIdx), updated, ...blocks.slice(thinkIdx + 1)]
  }
  return [{ type: 'thinking' as const, text, streaming }, ...blocks]
}

function appendAssistantChunk(
  blocks: AssistantBlock[],
  chunk: string,
  parsingThink: boolean
): { blocks: AssistantBlock[]; parsingThink: boolean } {
  let remaining = chunk
  let next = [...blocks]
  let nextParsingThink = parsingThink

  while (remaining.length > 0) {
    if (nextParsingThink) {
      const closeIndex = remaining.indexOf(THINK_CLOSE_TAG)
      if (closeIndex < 0) {
        next = appendThinkBlock(next, remaining, true)
        break
      }

      next = appendThinkBlock(next, remaining.slice(0, closeIndex), false)
      next = setThinkingStreaming(next, false)
      nextParsingThink = false
      remaining = remaining.slice(closeIndex + THINK_CLOSE_TAG.length)
      continue
    }

    const openIndex = remaining.indexOf(THINK_OPEN_TAG)
    if (openIndex < 0) {
      next = setThinkingStreaming(next, false)
      next = appendTextBlock(next, remaining)
      break
    }

    next = setThinkingStreaming(next, false)
    next = appendTextBlock(next, remaining.slice(0, openIndex))
    next = ensureThinkingBlock(next, true)
    nextParsingThink = true
    remaining = remaining.slice(openIndex + THINK_OPEN_TAG.length)
  }

  return { blocks: next, parsingThink: nextParsingThink }
}

function updateStreamingMessage(
  msgs: Message[],
  msgId: string | null,
  newText: string,
  parsingThinkRef: { current: boolean }
): Message[] {
  if (!msgId) return msgs
  let nextParsingThink = parsingThinkRef.current
  return msgs.map(m => {
    if (m.id !== msgId) return m
    const result = appendAssistantChunk(m.blocks ? [...m.blocks] : [], newText, nextParsingThink)
    nextParsingThink = result.parsingThink
    parsingThinkRef.current = nextParsingThink
    return { ...m, blocks: result.blocks }
  })
}

// 把 thinking text 累积到 ThinkingBlock.text（字符串拼接，不再按行分割）
function appendThinkText(msgs: Message[], msgId: string | null, text: string): Message[] {
  if (!msgId || !text) return msgs
  return msgs.map(m => {
    if (m.id !== msgId) return m
    const blocks = [...(m.blocks || [])]
    return { ...m, blocks: appendThinkBlock(blocks, text, true) }
  })
}

function appendToolBlock(msgs: Message[], msgId: string | null, toolName: string, args: Record<string, unknown>): Message[] {
  if (!msgId) return msgs
  return msgs.map(m => {
    if (m.id !== msgId) return m
    const newBlock: ToolBlock = { type: 'tool', name: toolName, status: 'running', args }
    return { ...m, blocks: [...(m.blocks || []), newBlock] }
  })
}

function appendToolCallBlock(msgs: Message[], msgId: string | null, toolName: string, argsText: string, toolCallId?: string): Message[] {
  let args: Record<string, unknown> = {}
  try {
    args = argsText ? JSON.parse(argsText) : {}
  } catch {
    args = { arguments: argsText }
  }
  const blockName = toolName || toolCallId || 'tool_call'
  return appendToolBlock(msgs, msgId, blockName, args)
}

function finalizeToolBlock(msgs: Message[], msgId: string | null, toolName: string, result: unknown, error?: string): Message[] {
  if (!msgId) return msgs
  return msgs.map(m => {
    if (m.id !== msgId) return m
    let updated = false
    const blocks: AssistantBlock[] = (m.blocks || []).map(b => {
      if (!updated && b.type === 'tool' && (b as ToolBlock).name === toolName && (b as ToolBlock).status === 'running') {
        updated = true
        const resultVal: ToolBlock['result'] = { kind: 'snippet', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }
        return { ...b, status: error ? 'error' : 'ok', result: resultVal } as ToolBlock
      }
      return b
    })
    return { ...m, blocks }
  })
}

function markStreamingDone(msgs: Message[], msgId: string | null): Message[] {
  if (!msgId) return msgs
  return msgs.map(m => {
    if (m.id !== msgId) return m
    // 关闭所有还在 streaming 状态的思考块（思考完成后折叠）
    const blocks = (m.blocks || []).map(b =>
      b.type === 'thinking' ? { ...(b as ThinkingBlock), streaming: false } : b
    )
    return { ...m, streaming: false, blocks }
  })
}

function markStreamingError(msgs: Message[], msgId: string | null, message: string): Message[] {
  if (!msgId) return msgs
  return msgs.map(m => {
    if (m.id !== msgId) return m
    const blocks = (m.blocks || []).map(b =>
      b.type === 'thinking' ? { ...(b as ThinkingBlock), streaming: false } : b
    )
    const errorBlock: TextBlock = { type: 'text', text: `\n\n❌ ${message}` }
    return { ...m, streaming: false, blocks: [...blocks, errorBlock] }
  })
}

function buildHistory(msgs: Message[]): Array<{ role: string; content: string }> {
  return msgs
    .filter(m => !m.streaming)
    .map(m => {
      if (m.role === 'user') return { role: 'user', content: m.content || '' }
      const text = (m.blocks || [])
        .filter((b): b is TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
      return { role: 'assistant', content: text }
    })
}

function createAgentRequestId(): string {
  return `agent-ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}


export function useAgentChat() {
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [conversations, setConversations] = useState<AgentConversationSummary[]>([])

  const currentRequestIdRef = useRef<string | null>(null)
  const streamingMsgIdRef = useRef<string | null>(null)
  const contentThinkModeRef = useRef(false)
  const isNewConversationRef = useRef(false)
  const firstUserMessageRef = useRef('')
  const firstAssistantResponseRef = useRef('')

  const loadConversations = async () => {
    const agentApi = window.electronAPI?.agent
    if (!agentApi) return
    const result = await agentApi.listConversations()
    if (result.success && result.conversations) {
      setConversations(result.conversations)
    }
  }

  const selectConversation = async (id: number) => {
    const agentApi = window.electronAPI?.agent
    if (!agentApi) return
    const result = await agentApi.loadConversation(id)
    if (result.success && result.messages) {
      setMessages(result.messages.map(recordToMessage))
      setConversationId(id)
    }
  }

  const deleteConversation = async (id: number) => {
    const agentApi = window.electronAPI?.agent
    if (!agentApi) return
    await agentApi.deleteConversation(id)
    if (conversationId === id) {
      setMessages([])
      setConversationId(null)
    }
    await loadConversations()
  }

  const renameConversation = async (id: number, title: string) => {
    const agentApi = window.electronAPI?.agent
    if (!agentApi) return
    await agentApi.updateTitle(id, title)
    await loadConversations()
  }

  useEffect(() => {
    loadConversations()
  }, [])

  useEffect(() => {
    const agentApi = window.electronAPI?.agent
    if (!agentApi) return

    const removeStreamEvent = agentApi.onStreamEvent(({ requestId, event }) => {
      if (requestId !== currentRequestIdRef.current) return
      if (event.type === 'content_delta') {
        setMessages(prev => updateStreamingMessage(prev, streamingMsgIdRef.current, event.text, contentThinkModeRef))
        return
      }
      if (event.type === 'reasoning_delta') {
        contentThinkModeRef.current = false
        setMessages(prev => appendThinkText(prev, streamingMsgIdRef.current, event.text))
        return
      }
      if (event.type === 'tool_call_done') {
        setMessages(prev => appendToolCallBlock(
          prev,
          streamingMsgIdRef.current,
          event.toolCall.function.name,
          event.toolCall.function.arguments,
          event.toolCall.id
        ))
        return
      }
      if (event.type === 'tool_result') {
        setMessages(prev => finalizeToolBlock(prev, streamingMsgIdRef.current, event.toolName, event.result, event.error))
        return
      }
      if (event.type === 'round_start') {
        const prevMsgId = streamingMsgIdRef.current
        const newMsgId = `a-${Date.now()}`
        streamingMsgIdRef.current = newMsgId
        contentThinkModeRef.current = false
        setMessages(prev => [
          ...markStreamingDone(prev, prevMsgId),
          { id: newMsgId, role: 'assistant' as const, blocks: [], streaming: true }
        ])
        return
      }
      if (event.type === 'message_done') {
        if (event.toolCalls?.length) return
        setMessages(prev => markStreamingDone(prev, streamingMsgIdRef.current))
        setLoading(false)
        contentThinkModeRef.current = false
      }
    })

    const removeDone = agentApi.onDone(({ requestId, conversationId: convId }) => {
      if (requestId !== currentRequestIdRef.current) return
      if (convId) setConversationId(convId)
      setMessages(prev => {
        const done = markStreamingDone(prev, streamingMsgIdRef.current)
        if (isNewConversationRef.current && streamingMsgIdRef.current) {
          const assistantMsg = done.find(m => m.id === streamingMsgIdRef.current)
          if (assistantMsg) {
            firstAssistantResponseRef.current = (assistantMsg.blocks || [])
              .filter((b): b is TextBlock => b.type === 'text')
              .map(b => b.text).join('')
          }
        }
        return done
      })
      setLoading(false)
      const msgId = streamingMsgIdRef.current
      currentRequestIdRef.current = null
      streamingMsgIdRef.current = null
      contentThinkModeRef.current = false
      if (isNewConversationRef.current && convId) {
        isNewConversationRef.current = false
        getProviderSettings().then(cfg => {
          agentApi.generateTitle({
            conversationId: convId,
            userMessage: firstUserMessageRef.current,
            assistantResponse: firstAssistantResponseRef.current,
            provider: cfg.provider,
            apiKey: cfg.apiKey,
            model: cfg.model,
          }).catch(() => {}).finally(() => loadConversations())
        })
      } else {
        loadConversations()
      }
    })

    const removeError = agentApi.onError(({ requestId, message }) => {
      if (requestId !== currentRequestIdRef.current) return
      setMessages(prev => markStreamingError(prev, streamingMsgIdRef.current, message))
      setLoading(false)
      currentRequestIdRef.current = null
      streamingMsgIdRef.current = null
      contentThinkModeRef.current = false
    })

    return () => {
      removeStreamEvent()
      removeDone()
      removeError()
    }
  }, [])

  const send = async (text: string, attached?: AttachedResource[]) => {
    if (!text.trim() || loading) return

    const agentApi = window.electronAPI?.agent
    if (!agentApi) {
      const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: text, attached: attached?.length ? attached : undefined }
      setMessages(prev => [...prev, userMsg])
      setLoading(true)
      setTimeout(() => {
        setMessages(prev => [...prev, {
          id: `a-${Date.now()}`,
          role: 'assistant',
          blocks: [{ type: 'text', text: `[Agent API 未就绪] 收到: ${text}` }]
        }])
        setLoading(false)
      }, 600)
      return
    }

    const userMsg: Message = { id: `u-${Date.now()}`, role: 'user', content: text, attached: attached?.length ? attached : undefined }
    const assistantMsgId = `a-${Date.now()}`
    const requestId = createAgentRequestId()
    currentRequestIdRef.current = requestId
    streamingMsgIdRef.current = assistantMsgId
    contentThinkModeRef.current = false
    if (conversationId === null) {
      isNewConversationRef.current = true
      firstUserMessageRef.current = text
    }

    setMessages(prev => [
      ...prev,
      userMsg,
      { id: assistantMsgId, role: 'assistant', blocks: [], streaming: true }
    ])
    setLoading(true)

    const history = buildHistory(messages)
    const providerSettings = await getProviderSettings()

    const scopedSessions = (attached || [])
      .filter(r => r.icon === 'database')
      .map(r => ({ id: r.id, name: r.label }))

    const result = await agentApi.sendMessage({
      requestId,
      conversationId: conversationId ?? undefined,
      history,
      message: text,
      provider: providerSettings.provider,
      apiKey: providerSettings.apiKey,
      model: providerSettings.model,
      enableThinking: providerSettings.enableThinking,
      scopedSessions: scopedSessions.length > 0 ? scopedSessions : undefined
    })

    if (!result.success) {
      setMessages(prev => markStreamingError(prev, assistantMsgId, result.error || '发送失败'))
      setLoading(false)
      currentRequestIdRef.current = null
      streamingMsgIdRef.current = null
      contentThinkModeRef.current = false
      return
    }

    currentRequestIdRef.current = result.requestId
    if (result.conversationId) setConversationId(result.conversationId)
  }

  const cancel = () => {
    const reqId = currentRequestIdRef.current
    if (reqId) {
      window.electronAPI?.agent?.cancel(reqId)
      setMessages(prev => markStreamingDone(prev, streamingMsgIdRef.current))
      setLoading(false)
      currentRequestIdRef.current = null
      streamingMsgIdRef.current = null
      contentThinkModeRef.current = false
    }
  }

  const reset = () => {
    cancel()
    setMessages([])
    setConversationId(null)
    contentThinkModeRef.current = false
    isNewConversationRef.current = false
    firstUserMessageRef.current = ''
    firstAssistantResponseRef.current = ''
  }

  return {
    messages, loading, conversationId, conversations,
    send, cancel, reset,
    loadConversations, selectConversation, deleteConversation, renameConversation,
  }
}
