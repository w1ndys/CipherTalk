import { useState, useRef, useEffect } from 'react'
import type { AgentConversationSummary, AgentMessageRecord } from '../../../types/electron'
import type { AttachedResource, CardBlock, Message, AssistantBlock, ToolBlock, TextBlock, ThinkingBlock } from '../types'

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
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type !== 'thinking') continue
    const b = blocks[i] as ThinkingBlock
    if (!b.streaming) break // 已关闭的块，跳出循环创建新块
    if (b.streaming === streaming) return blocks
    return [...blocks.slice(0, i), { ...b, streaming }, ...blocks.slice(i + 1)]
  }
  return [...blocks, { type: 'thinking' as const, text: '', streaming }]
}

function appendThinkBlock(blocks: AssistantBlock[], text: string, streaming = true): AssistantBlock[] {
  if (!text) return blocks
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].type !== 'thinking') continue
    const existing = blocks[i] as ThinkingBlock
    const updated: ThinkingBlock = { ...existing, text: existing.text + text, streaming }
    return [...blocks.slice(0, i), updated, ...blocks.slice(i + 1)]
  }
  return [...blocks, { type: 'thinking' as const, text, streaming }]
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

function hasToolError(result: unknown, depth = 0): boolean {
  if (depth > 4 || result == null) return false
  if (typeof result === 'string') {
    const parsed = parseJsonMaybe(result)
    return parsed ? hasToolError(parsed, depth + 1) : false
  }
  if (Array.isArray(result)) {
    return result.some(item => hasToolError(item, depth + 1))
  }
  if (typeof result !== 'object') return false

  const obj = result as Record<string, unknown>
  if (obj.success === false || obj.isError === true) return true
  if (typeof obj.error === 'string' && obj.error.trim()) return true
  return hasToolError(obj.result, depth + 1) || hasToolError(obj.data, depth + 1)
}

function createExportCard(sessionId: unknown, sessionName?: unknown): CardBlock | null {
  const id = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!id) return null
  const name = typeof sessionName === 'string' && sessionName.trim() ? sessionName.trim() : undefined
  return { type: 'card', kind: 'export-wizard', sessionId: id, sessionName: name }
}

function extractExportCardFromResult(result: unknown, depth = 0): CardBlock | null {
  if (depth > 5 || result == null) return null

  if (typeof result === 'string') {
    const parsed = parseJsonMaybe(result)
    return parsed ? extractExportCardFromResult(parsed, depth + 1) : null
  }

  if (Array.isArray(result)) {
    for (const item of result) {
      const card = extractExportCardFromResult(item, depth + 1)
      if (card) return card
    }
    return null
  }

  if (typeof result !== 'object') return null

  const obj = result as Record<string, unknown>
  if (obj.__ct_card === 'export-wizard') {
    return createExportCard(obj.sessionId, obj.sessionName)
  }

  const content = obj.content
  if (Array.isArray(content)) {
    for (const item of content) {
      const card = extractExportCardFromResult(item, depth + 1)
      if (card) return card
      if (typeof item === 'object' && item) {
        const text = (item as Record<string, unknown>).text
        if (typeof text === 'string') {
          const textCard = extractExportCardFromResult(text, depth + 1)
          if (textCard) return textCard
        }
      }
    }
  }

  for (const key of ['result', 'data', 'payload', 'text', 'message']) {
    const card = extractExportCardFromResult(obj[key], depth + 1)
    if (card) return card
  }

  return null
}

function findLatestExportToolCard(blocks: AssistantBlock[]): CardBlock | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.type !== 'tool') continue
    const tool = block as ToolBlock
    if (!isInitiateExportTool(tool.name)) continue
    return createExportCard(tool.args?.sessionId, tool.args?.sessionName)
  }
  return null
}

function appendExportCard(blocks: AssistantBlock[], card: CardBlock): AssistantBlock[] {
  const exists = blocks.some(block =>
    block.type === 'card'
    && block.kind === 'export-wizard'
    && (block.sessionId || '') === (card.sessionId || '')
  )
  return exists ? blocks : [...blocks, card]
}

function appendExportCardForToolResult(
  msgs: Message[],
  msgId: string | null,
  result: unknown
): Message[] {
  if (!msgId || hasToolError(result)) return msgs
  return msgs.map(m => {
    if (m.id !== msgId) return m
    const blocks = m.blocks || []
    const card = extractExportCardFromResult(result) || findLatestExportToolCard(blocks)
    if (!card) return m
    return { ...m, blocks: appendExportCard(blocks, card) }
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
  const lastReadLimitRef = useRef(500)

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
    const agentApi = window.electronAPI?.agent
    if (!agentApi) return
    let cancelled = false
    const restore = async () => {
      await loadConversations()
      try {
        const last = await agentApi.getLastConversationId?.()
        if (cancelled || !last?.success || !last.id) return
        const result = await agentApi.loadConversation(last.id)
        if (cancelled || !result.success || !result.messages) return
        setMessages(result.messages.map(recordToMessage))
        setConversationId(last.id)
      } catch {
        // 兼容热更新时 main 进程还没注册新 IPC 的情况。
      }
    }
    void restore()
    return () => {
      cancelled = true
    }
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
        const msgId = streamingMsgIdRef.current
        setMessages(prev => {
          let next = finalizeToolBlock(prev, msgId, event.toolName, event.result, event.error)
          if (isInitiateExportTool(event.toolName) && !event.error) {
            next = appendExportCardForToolResult(next, msgId, event.result)
          }
          return next
        })
        return
      }
      if (event.type === 'round_start') {
        contentThinkModeRef.current = false
        // 关闭当前轮次的思考块，继续在同一条消息里追加下一轮内容
        setMessages(prev => prev.map(m => {
          if (m.id !== streamingMsgIdRef.current) return m
          return { ...m, blocks: setThinkingStreaming(m.blocks || [], false) }
        }))
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
        let done = markStreamingDone(prev, streamingMsgIdRef.current)
        const msgId = streamingMsgIdRef.current
        if (msgId) {
          const assistantMsg = done.find(m => m.id === msgId)
          if (assistantMsg) {
            // 收集标题生成用的文本
            if (isNewConversationRef.current) {
              firstAssistantResponseRef.current = (assistantMsg.blocks || [])
                .filter((b): b is TextBlock => b.type === 'text')
                .map(b => b.text).join('')
            }
          }
        }
        return done
      })
      setLoading(false)
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

  const send = async (text: string, attached?: AttachedResource[], readLimit = 500, skillIds?: string[]) => {
    lastReadLimitRef.current = readLimit
    const trimmed = text.trim()
    if (!trimmed || loading) return

    // /clear 直接重置，不发给 AI
    if (trimmed === '/clear') {
      reset()
      return
    }

    // 解析其他 slash 命令，生成 commandHint 注入 system prompt
    let commandHint: string | undefined
    let forceThinking: boolean | undefined

    if (trimmed.startsWith('/')) {
      const spaceIdx = trimmed.indexOf(' ')
      const command = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed
      const arg = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : ''

      switch (command) {
        case '/search':
          commandHint = arg
            ? `用户执行了 /search 命令，搜索关键词："${arg}"。请立即调用 ct_search_messages 工具（keyword: "${arg}"），按时间倒序以列表格式呈现结果，每条包含：会话名、发送人、时间、消息摘要。若无结果，如实说明并建议相关关键词。`
            : '用户执行了 /search 命令但未提供关键词。请询问用户想要搜索什么内容。'
          break
        case '/stats':
          commandHint = arg
            ? `用户执行了 /stats 命令，目标："${arg}"。请立即：①调用 ct_list_sessions 找到"${arg}"对应的 sessionId；②调用 ct_get_recent_messages 获取近期消息；③分析消息频率、发送/接收比例、活跃时间，以结构化格式输出统计摘要。`
            : '用户执行了 /stats 命令。请先调用 ct_list_sessions 列出会话供用户选择，再针对选定会话生成统计报告。'
          break
        case '/moments':
          commandHint = arg
            ? `用户执行了 /moments 命令，条件："${arg}"。请立即调用 ct_get_moments 工具获取朋友圈动态，将条件作为 keyword 或时间范围参数传入，然后以时间线格式呈现并分析。`
            : '用户执行了 /moments 命令。请立即调用 ct_get_moments 工具获取最近朋友圈动态，以时间线格式呈现，按时间倒序排列，每条包含：作者、时间、内容、点赞数、评论摘要。'
          break
        case '/export':
          if (!arg) {
            // 无参数：直接插入空白导出卡片，不走 AI
            const userId = `u-${Date.now()}`
            const assistantId = `a-${Date.now() + 1}`
            const localMessages: Message[] = [
              { id: userId, role: 'user', content: text },
              { id: assistantId, role: 'assistant', blocks: [{ type: 'card', kind: 'export-wizard' }] },
            ]
            setMessages(prev => [...prev, ...localMessages])
            try {
              const saved = await window.electronAPI?.agent?.appendLocalMessages?.({
                conversationId: conversationId ?? undefined,
                messages: localMessages.map(msg => ({
                  role: msg.role,
                  content: msg.content,
                  blocks: msg.blocks,
                })),
              })
              if (saved?.success && saved.conversationId) {
                setConversationId(saved.conversationId)
              }
              await loadConversations()
            } catch {
              // ignore
            }
            return
          }
          // 有参数：走 AI 解析目标会话，AI 调用 ct_initiate_export 后卡片自动注入
          commandHint = `用户执行了 /export 命令，目标："${arg}"。请立即：①调用 ct_list_sessions 找到与"${arg}"最匹配的会话（sessionId 和 sessionName）；②确认匹配后立即调用 ct_initiate_export（传入 sessionId 和 sessionName）展示导出确认卡片；③用一句话告知用户找到了哪个会话。`
          break
        case '/think':
          commandHint = '用户要求对本轮问题进行深度分析。请全面审视问题的各个角度和前提假设，识别潜在的边界条件与不确定因素，充分推理后再给出有依据的结论。不要仓促作答。'
          forceThinking = true
          break
      }
    }

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
      enableThinking: forceThinking ?? providerSettings.enableThinking,
      commandHint,
      readLimit,
      scopedSessions: scopedSessions.length > 0 ? scopedSessions : undefined,
      skillIds: skillIds && skillIds.length > 0 ? skillIds : undefined,
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

  const regenerate = async (assistantMsgId: string) => {
    if (loading) return
    const agentApi = window.electronAPI?.agent
    if (!agentApi) return

    const snapshot = messages
    const idx = snapshot.findIndex(m => m.id === assistantMsgId)
    if (idx <= 0) return
    const userMsg = snapshot[idx - 1]
    if (!userMsg || userMsg.role !== 'user') return

    const text = userMsg.content || ''
    const attached = userMsg.attached
    const history = buildHistory(snapshot.slice(0, idx - 1))
    const readLimit = lastReadLimitRef.current

    const newAssistantId = `a-${Date.now()}`
    const requestId = createAgentRequestId()
    currentRequestIdRef.current = requestId
    streamingMsgIdRef.current = newAssistantId
    contentThinkModeRef.current = false

    setMessages(prev => {
      const i = prev.findIndex(m => m.id === assistantMsgId)
      const cut = i >= 0 ? i : idx
      return [
        ...prev.slice(0, cut),
        { id: newAssistantId, role: 'assistant' as const, blocks: [], streaming: true },
      ]
    })
    setLoading(true)

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
      readLimit,
      scopedSessions: scopedSessions.length > 0 ? scopedSessions : undefined,
    })

    if (!result.success) {
      setMessages(prev => markStreamingError(prev, newAssistantId, result.error || '重新生成失败'))
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
    send, cancel, reset, regenerate,
    loadConversations, selectConversation, deleteConversation, renameConversation,
  }
}
