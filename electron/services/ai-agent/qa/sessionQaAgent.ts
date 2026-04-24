import type OpenAI from 'openai'
import type { AIProvider } from '../../ai/providers/base'
import { executeMcpTool } from '../../mcp/dispatcher'
import type {
  McpMessageItem,
  McpSearchMessagesPayload,
  McpSessionContextPayload
} from '../../mcp/types'
import type { StructuredAnalysis, SummaryEvidenceRef } from '../types/analysis'

export interface SessionQAHistoryMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface SessionQAToolCall {
  toolName: 'get_session_context' | 'search_messages'
  args: Record<string, unknown>
  summary: string
}

export type SessionQAProgressStage = 'intent' | 'tool' | 'context' | 'answer'
export type SessionQAProgressStatus = 'running' | 'completed' | 'failed'

export interface SessionQAProgressEvent {
  id: string
  stage: SessionQAProgressStage
  status: SessionQAProgressStatus
  title: string
  detail?: string
  toolName?: SessionQAToolCall['toolName']
  query?: string
  count?: number
  createdAt: number
}

export interface SessionQAAgentOptions {
  sessionId: string
  sessionName?: string
  question: string
  summaryText?: string
  structuredAnalysis?: StructuredAnalysis
  history?: SessionQAHistoryMessage[]
  provider: AIProvider
  model: string
  enableThinking?: boolean
  onChunk: (chunk: string) => void
  onProgress?: (event: SessionQAProgressEvent) => void
}

export interface SessionQAAgentResult {
  answerText: string
  evidenceRefs: SummaryEvidenceRef[]
  toolCalls: SessionQAToolCall[]
  promptText: string
}

const MAX_CONTEXT_MESSAGES = 40
const MAX_SEARCH_QUERIES = 6
const MAX_SEARCH_HITS = 8
const MAX_CONTEXT_WINDOWS = 4
const SEARCH_CONTEXT_BEFORE = 6
const SEARCH_CONTEXT_AFTER = 6
const MAX_HISTORY_MESSAGES = 8
const MAX_SUMMARY_CHARS = 3000
const MAX_STRUCTURED_CHARS = 4000
const MAX_MESSAGE_TEXT = 220

type SearchPayloadWithQuery = { query: string; payload: McpSearchMessagesPayload }
type SearchHitWithQuery = McpSearchMessagesPayload['hits'][number] & { query: string }
type ContextWindow = {
  source: 'search' | 'latest'
  query?: string
  anchor?: McpMessageItem
  messages: McpMessageItem[]
}

function compactText(value?: string, limit = MAX_MESSAGE_TEXT): string {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return ''
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

function buildProgressEvent(
  event: Omit<SessionQAProgressEvent, 'createdAt'>
): SessionQAProgressEvent {
  return {
    ...event,
    createdAt: Date.now()
  }
}

function emitProgress(
  options: SessionQAAgentOptions,
  event: Omit<SessionQAProgressEvent, 'createdAt'>
) {
  options.onProgress?.(buildProgressEvent(event))
}

function filterThinkChunk(chunk: string, state: { isThinking: boolean }): string {
  let remaining = chunk
  let visible = ''

  while (remaining.length > 0) {
    if (state.isThinking) {
      const closeIndex = remaining.indexOf('</think>')
      if (closeIndex < 0) {
        break
      }

      state.isThinking = false
      remaining = remaining.slice(closeIndex + '</think>'.length)
      continue
    }

    const openIndex = remaining.indexOf('<think>')
    if (openIndex < 0) {
      visible += remaining
      break
    }

    visible += remaining.slice(0, openIndex)
    state.isThinking = true
    remaining = remaining.slice(openIndex + '<think>'.length)
  }

  return visible
}

function stripThinkBlocks(value: string): string {
  return value.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

function stripJsonFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()
}

function formatTime(timestampMs: number): string {
  if (!timestampMs) return 'unknown'
  const date = new Date(timestampMs)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day} ${hour}:${minute}`
}

function describeSender(message: McpMessageItem): string {
  if (message.sender.isSelf) return '我'
  return message.sender.username || '对方'
}

function formatMessageLine(message: McpMessageItem): string {
  const text = compactText(message.text, MAX_MESSAGE_TEXT) || `[${message.kind}]`
  return `- ${formatTime(message.timestampMs)} | ${describeSender(message)} | ${text}`
}

function toEvidenceRef(sessionId: string, message: McpMessageItem, preview?: string): SummaryEvidenceRef | null {
  if (!message.cursor) return null

  return {
    sessionId,
    localId: message.cursor.localId,
    createTime: message.cursor.createTime,
    sortSeq: message.cursor.sortSeq,
    senderUsername: message.sender.username || undefined,
    senderDisplayName: describeSender(message),
    previewText: compactText(preview || message.text, 180) || `[${message.kind}]`
  }
}

function dedupeEvidenceRefs(items: SummaryEvidenceRef[]): SummaryEvidenceRef[] {
  const seen = new Set<string>()
  const result: SummaryEvidenceRef[] = []

  for (const item of items) {
    const key = `${item.localId}:${item.createTime}:${item.sortSeq}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
    if (result.length >= 8) break
  }

  return result
}

function getMessageCursorKey(message: McpMessageItem): string {
  return `${message.cursor.localId}:${message.cursor.createTime}:${message.cursor.sortSeq}`
}

function dedupeMessagesByCursor(messages: McpMessageItem[]): McpMessageItem[] {
  const seen = new Set<string>()
  const result: McpMessageItem[] = []

  for (const message of messages) {
    const key = getMessageCursorKey(message)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(message)
  }

  return result.sort((a, b) => {
    if (a.cursor.sortSeq !== b.cursor.sortSeq) return a.cursor.sortSeq - b.cursor.sortSeq
    if (a.cursor.createTime !== b.cursor.createTime) return a.cursor.createTime - b.cursor.createTime
    return a.cursor.localId - b.cursor.localId
  })
}

function dedupeSearchHits(hits: SearchHitWithQuery[]): SearchHitWithQuery[] {
  const seen = new Set<string>()
  const result: SearchHitWithQuery[] = []

  for (const hit of hits) {
    const key = getMessageCursorKey(hit.message)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(hit)
  }

  return result.sort((a, b) => b.score - a.score || b.message.timestampMs - a.message.timestampMs)
}

function normalizeSearchQuery(value: string, limit = 32): string {
  return compactText(value, limit)
    .replace(/[？?！!。，,；;：:"“”‘’()（）【】\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isGenericSearchQuery(value: string): boolean {
  const normalized = normalizeSearchQuery(value).replace(/\s+/g, '')
  if (!normalized) return true
  return /^(什么|哪个|哪些|什么时候|为什么|怎么|如何|最近|刚刚|刚才|我们|他们|对方|是否|有没有|是不是|可以|看到|知道|消息|聊天|内容|问题|回复|回答)$/.test(normalized)
}

function expandSearchQueries(question: string, modelQueries: string[]): string[] {
  const candidates: string[] = []
  const push = (value: string) => {
    const query = normalizeSearchQuery(value)
    if (!query || isGenericSearchQuery(query)) return
    candidates.push(query)
  }

  for (const query of modelQueries) {
    push(query)
    const compact = query.replace(/\s+/g, '')
    if (/[\u4e00-\u9fa5]/.test(compact) && compact.length >= 4) {
      push(compact.slice(-2))
      push(compact.slice(-3))
    }
  }

  for (const query of extractHeuristicQueries(question)) {
    push(query)
    const compact = query.replace(/\s+/g, '')
    if (/[\u4e00-\u9fa5]/.test(compact) && compact.length >= 4) {
      push(compact.slice(-2))
      push(compact.slice(-3))
    }
  }

  const seen = new Set<string>()
  const unique: string[] = []
  for (const query of candidates) {
    const normalized = query.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    unique.push(query)
    if (unique.length >= MAX_SEARCH_QUERIES) break
  }

  return unique
}

function shouldUseRecentFallback(question: string): boolean {
  return /(最近|刚刚|刚才|今天|昨天|前面|上面|最后|最新|刚聊|recent|latest)/i.test(question)
}

function extractHeuristicQueries(question: string): string[] {
  const normalized = question
    .replace(/[？?！!。，,；;：:"“”‘’()（）【】\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const words = normalized
    .split(' ')
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .filter((item) => !/^(什么|哪个|哪些|什么时候|为什么|怎么|如何|最近|我们|他们|对方|是否|有没有|是不是)$/.test(item))

  if (words.length > 0) {
    return words.slice(0, MAX_SEARCH_QUERIES)
  }

  const compact = normalized.replace(/\s+/g, '')
  if (compact.length >= 4) {
    return [compact.slice(0, Math.min(8, compact.length))]
  }

  return []
}

async function proposeSearchQueries(
  provider: AIProvider,
  model: string,
  question: string
): Promise<string[]> {
  const fallback = extractHeuristicQueries(question)

  try {
    const response = await provider.chat([
      {
        role: 'system',
        content: '你负责把用户关于单个聊天会话的问题改写为少量中文消息检索关键词。只输出 JSON。'
      },
      {
        role: 'user',
        content: `从下面问题中提取 0 到 3 个适合在微信聊天记录里做 substring 检索的关键词。不要输出泛词、人称代词或完整问句。\n\n问题：${question}\n\nJSON 格式：{"queries":["关键词1","关键词2"]}`
      }
    ], {
      model,
      temperature: 0.1,
      maxTokens: 180,
      enableThinking: false
    })

    const parsed = JSON.parse(stripJsonFence(response)) as { queries?: unknown }
    if (!Array.isArray(parsed.queries)) return fallback

    const queries = parsed.queries
      .map((item) => compactText(String(item || ''), 24))
      .filter((item) => item.length >= 2)
      .filter((item, index, array) => array.indexOf(item) === index)
      .slice(0, MAX_SEARCH_QUERIES)

    return queries.length > 0 ? queries : fallback
  } catch {
    return fallback
  }
}

async function loadLatestContext(sessionId: string): Promise<{
  payload?: McpSessionContextPayload
  toolCall?: SessionQAToolCall
}> {
  const args = {
    sessionId,
    mode: 'latest',
    beforeLimit: MAX_CONTEXT_MESSAGES,
    includeRaw: false
  }
  const result = await executeMcpTool('get_session_context', args)
  return {
    payload: result.payload as McpSessionContextPayload,
    toolCall: {
      toolName: 'get_session_context',
      args,
      summary: result.summary
    }
  }
}

async function searchSessionMessages(sessionId: string, query: string): Promise<{
  payload?: McpSearchMessagesPayload
  toolCall?: SessionQAToolCall
}> {
  const args = {
    sessionId,
    query,
    limit: MAX_SEARCH_HITS,
    matchMode: 'substring',
    includeRaw: false
  }
  const result = await executeMcpTool('search_messages', args)
  return {
    payload: result.payload as McpSearchMessagesPayload,
    toolCall: {
      toolName: 'search_messages',
      args,
      summary: result.summary
    }
  }
}

async function loadContextAroundMessage(sessionId: string, message: McpMessageItem): Promise<{
  payload?: McpSessionContextPayload
  toolCall?: SessionQAToolCall
}> {
  const args = {
    sessionId,
    mode: 'around',
    anchorCursor: message.cursor,
    beforeLimit: SEARCH_CONTEXT_BEFORE,
    afterLimit: SEARCH_CONTEXT_AFTER,
    includeRaw: false
  }
  const result = await executeMcpTool('get_session_context', args)
  return {
    payload: result.payload as McpSessionContextPayload,
    toolCall: {
      toolName: 'get_session_context',
      args,
      summary: result.summary
    }
  }
}

function buildStructuredContext(analysis?: StructuredAnalysis): string {
  if (!analysis) return ''

  return compactText(JSON.stringify(analysis), MAX_STRUCTURED_CHARS)
}

function buildHistoryContext(history: SessionQAHistoryMessage[] = []): string {
  return history
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => `${item.role === 'user' ? '用户' : 'AI'}：${compactText(item.content, 500)}`)
    .join('\n')
}

function buildAnswerPrompt(input: {
  sessionName: string
  question: string
  summaryText?: string
  structuredContext?: string
  contextWindows: ContextWindow[]
  searchPayloads: SearchPayloadWithQuery[]
  historyText: string
  usedRecentFallback: boolean
}): string {
  const contextText = input.contextWindows.length > 0
    ? input.contextWindows.map((window, index) => {
      const heading = window.source === 'search'
        ? `上下文窗口 ${index + 1}（关键词：${window.query || '未知'}，围绕命中消息）`
        : `兜底上下文 ${index + 1}（最近消息）`
      const lines = window.messages.length > 0
        ? window.messages.map(formatMessageLine).join('\n')
        : '无上下文消息。'
      return `${heading}\n${lines}`
    }).join('\n\n')
    : '无可用上下文。'

  const searchContext = input.searchPayloads.length > 0
    ? input.searchPayloads.map(({ query, payload }) => {
      const lines = payload.hits.length > 0
        ? payload.hits.map((hit) => formatMessageLine(hit.message)).join('\n')
        : '无命中。'
      return `关键词：${query}\n${lines}`
    }).join('\n\n')
    : '未执行关键词检索或没有可用关键词。'

  return `你是 CipherTalk 的单会话 AI 助手。请只基于提供的本地聊天上下文回答，不要编造未出现的事实。

会话：${input.sessionName}

用户问题：
${input.question}

多轮上下文：
${input.historyText || '无'}

当前摘要：
${compactText(stripThinkBlocks(input.summaryText || ''), MAX_SUMMARY_CHARS) || '无'}

结构化摘要 JSON：
${input.structuredContext || '无'}

按需读取的消息上下文：
${contextText}

关键词检索结果：
${searchContext}

上下文策略：
${input.usedRecentFallback ? '关键词未命中或问题偏向最近对话，本次使用最近消息作为兜底上下文。' : '本次优先使用关键词检索命中的消息，并围绕命中位置按需读取上下文。'}

回答要求：
1. 用中文直接回答问题。
2. 如果证据不足，明确说“当前证据不足”，并说明还需要什么线索。
3. 能引用依据时，在回答末尾加“依据”小节，用时间、发送人和原文预览列 1 到 5 条。
4. 不要输出工具调用过程，不要输出 JSON。`
}

export async function answerSessionQuestionWithAgent(
  options: SessionQAAgentOptions
): Promise<SessionQAAgentResult> {
  const toolCalls: SessionQAToolCall[] = []
  const evidenceCandidates: SummaryEvidenceRef[] = []

  emitProgress(options, {
    id: 'intent',
    stage: 'intent',
    status: 'running',
    title: '识别问题意图',
    detail: '正在判断问题适合读取最近上下文还是关键词检索'
  })

  const modelQueries = await proposeSearchQueries(options.provider, options.model, options.question)
  const queries = expandSearchQueries(options.question, modelQueries)

  emitProgress(options, {
    id: 'intent',
    stage: 'intent',
    status: 'completed',
    title: '识别问题意图',
    detail: queries.length > 0
      ? `检索关键词：${queries.join('、')}`
      : '未提取到稳定关键词，将主要依据最近上下文回答',
    count: queries.length
  })

  const searchPayloads: SearchPayloadWithQuery[] = []
  const rawHits: SearchHitWithQuery[] = []

  for (const [index, query] of queries.entries()) {
    const progressId = `tool-search-${index}`

    emitProgress(options, {
      id: progressId,
      stage: 'tool',
      status: 'running',
      title: '检索相关消息',
      detail: `关键词：${query}`,
      toolName: 'search_messages',
      query
    })

    try {
      const search = await searchSessionMessages(options.sessionId, query)
      if (search.toolCall) toolCalls.push(search.toolCall)
      if (search.payload) {
        searchPayloads.push({ query, payload: search.payload })
        rawHits.push(...search.payload.hits.map((hit) => ({ ...hit, query })))
        for (const hit of search.payload.hits) {
          const ref = toEvidenceRef(options.sessionId, hit.message, hit.excerpt)
          if (ref) evidenceCandidates.push(ref)
        }
      }

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'completed',
        title: '检索相关消息',
        detail: `关键词：${query}，命中 ${search.payload?.hits.length || 0} 条`,
        toolName: 'search_messages',
        query,
        count: search.payload?.hits.length || 0
      })
    } catch (error) {
      toolCalls.push({
        toolName: 'search_messages',
        args: { sessionId: options.sessionId, query },
        summary: `检索失败：${String(error)}`
      })

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'failed',
        title: '检索相关消息失败',
        detail: `关键词：${query}，${compactText(String(error), 120)}`,
        toolName: 'search_messages',
        query
      })
    }
  }

  const searchHits = dedupeSearchHits(rawHits)
  const totalSearchHits = searchPayloads.reduce((sum, item) => sum + item.payload.hits.length, 0)
  const contextWindows: ContextWindow[] = []
  let usedRecentFallback = false

  if (searchHits.length > 0) {
    const contextTargets = searchHits.slice(0, MAX_CONTEXT_WINDOWS)
    for (const [index, hit] of contextTargets.entries()) {
      const progressId = `tool-hit-context-${index}`

      emitProgress(options, {
        id: progressId,
        stage: 'tool',
        status: 'running',
        title: '读取命中上下文',
        detail: `关键词：${hit.query}，读取命中消息前后 ${SEARCH_CONTEXT_BEFORE + SEARCH_CONTEXT_AFTER} 条`,
        toolName: 'get_session_context',
        query: hit.query
      })

      try {
        const context = await loadContextAroundMessage(options.sessionId, hit.message)
        if (context.toolCall) toolCalls.push(context.toolCall)
        const messages = context.payload?.items || []
        contextWindows.push({
          source: 'search',
          query: hit.query,
          anchor: hit.message,
          messages
        })

        for (const message of messages) {
          const ref = toEvidenceRef(options.sessionId, message)
          if (ref) evidenceCandidates.push(ref)
        }

        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'completed',
          title: '读取命中上下文',
          detail: `关键词：${hit.query}，读取到 ${messages.length} 条上下文消息`,
          toolName: 'get_session_context',
          query: hit.query,
          count: messages.length
        })
      } catch (error) {
        emitProgress(options, {
          id: progressId,
          stage: 'tool',
          status: 'failed',
          title: '读取命中上下文失败',
          detail: `关键词：${hit.query}，${compactText(String(error), 120)}`,
          toolName: 'get_session_context',
          query: hit.query
        })
      }
    }
  }

  if (contextWindows.length === 0 || (searchHits.length === 0 && shouldUseRecentFallback(options.question))) {
    usedRecentFallback = true
    emitProgress(options, {
      id: 'tool-latest-context',
      stage: 'tool',
      status: 'running',
      title: '读取最近上下文',
      detail: searchHits.length === 0
        ? `关键词未命中，读取最近 ${MAX_CONTEXT_MESSAGES} 条作为兜底`
        : `问题偏向最近对话，补充最近 ${MAX_CONTEXT_MESSAGES} 条消息`,
      toolName: 'get_session_context'
    })

    try {
      const latest = await loadLatestContext(options.sessionId)
      if (latest.toolCall) toolCalls.push(latest.toolCall)
      const latestMessages = latest.payload?.items || []
      contextWindows.push({
        source: 'latest',
        messages: latestMessages
      })

      for (const message of latestMessages.slice(-8)) {
        const ref = toEvidenceRef(options.sessionId, message)
        if (ref) evidenceCandidates.push(ref)
      }

      emitProgress(options, {
        id: 'tool-latest-context',
        stage: 'tool',
        status: 'completed',
        title: '读取最近上下文',
        detail: `读取到 ${latestMessages.length} 条最近消息`,
        toolName: 'get_session_context',
        count: latestMessages.length
      })
    } catch (error) {
      emitProgress(options, {
        id: 'tool-latest-context',
        stage: 'tool',
        status: 'failed',
        title: '读取最近上下文失败',
        detail: compactText(String(error), 120),
        toolName: 'get_session_context'
      })
      throw error
    }
  }

  const contextMessageCount = dedupeMessagesByCursor(contextWindows.flatMap((window) => window.messages)).length

  emitProgress(options, {
    id: 'context',
    stage: 'context',
    status: 'completed',
    title: '整理回答依据',
    detail: usedRecentFallback
      ? `检索命中 ${totalSearchHits} 条，兜底读取上下文 ${contextMessageCount} 条`
      : `检索命中 ${totalSearchHits} 条，按需读取上下文 ${contextMessageCount} 条`,
    count: contextMessageCount
  })

  const promptText = buildAnswerPrompt({
    sessionName: options.sessionName || options.sessionId,
    question: options.question,
    summaryText: options.summaryText,
    structuredContext: buildStructuredContext(options.structuredAnalysis),
    contextWindows,
    searchPayloads,
    historyText: buildHistoryContext(options.history),
    usedRecentFallback
  })

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    {
      role: 'system',
      content: '你是严谨的本地聊天记录问答助手。你必须基于给定上下文回答，并在证据不足时明确承认不足。'
    },
    {
      role: 'user',
      content: promptText
    }
  ]

  emitProgress(options, {
    id: 'answer',
    stage: 'answer',
    status: 'running',
    title: '生成回答',
    detail: '正在基于上下文生成回答'
  })

  let answerText = ''
  const enableThinking = options.enableThinking !== false
  const thinkFilterState = { isThinking: false }
  await options.provider.streamChat(
    messages,
    {
      model: options.model,
      temperature: 0.3,
      maxTokens: 1600,
      enableThinking
    },
    (chunk) => {
      const visibleChunk = enableThinking ? chunk : filterThinkChunk(chunk, thinkFilterState)
      if (!visibleChunk) return
      answerText += visibleChunk
      options.onChunk(visibleChunk)
    }
  )

  const finalAnswerText = stripThinkBlocks(answerText)

  emitProgress(options, {
    id: 'answer',
    stage: 'answer',
    status: 'completed',
    title: '生成回答',
    detail: '回答生成完成'
  })

  return {
    answerText: finalAnswerText,
    evidenceRefs: dedupeEvidenceRefs(evidenceCandidates),
    toolCalls,
    promptText
  }
}
