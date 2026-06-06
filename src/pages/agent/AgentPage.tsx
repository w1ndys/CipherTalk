/**
 * AI Agent 对话页（Phase C）——使用 AI SDK 的 useChat + AI Elements 组件。
 * 数据：useChat 走 IpcChatTransport（IPC → AI 子进程 → 流式 UIMessageChunk）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from 'react'
import { useChat } from '@ai-sdk/react'
import { isToolUIPart, type ChatStatus, type UIMessage } from 'ai'
import { Surface } from '@heroui/react'
import { AtSign, BarChart3, Braces, Brain, CheckIcon, Clock3, FileText, History, Image as ImageIcon, Quote, Search, SquarePen, Trash2, Users, Wrench, X } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useChatStore } from '@/stores/chatStore'
import { Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageAttachment, MessageAttachments, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputProvider,
  PromptInputSpeechButton,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
  usePromptInputController,
} from '@/components/ai-elements/prompt-input'
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorName,
  ModelSelectorTrigger,
} from '@/components/ai-elements/model-selector'
import { Button } from '@/components/ui/button'
import AIProviderLogo from '@/components/ai/AIProviderLogo'
import { getAIProviders, type AIModelInfo, type AIProviderInfo } from '@/types/ai'
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from '@/components/ai-elements/chain-of-thought'
import { Loader } from '@/components/ai-elements/loader'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { IpcChatTransport, type AgentModelConfig, type AgentProgressEvent, type AgentReasoningEffort, type AgentScope } from '@/features/aiagent/transport/ipcChatTransport'
import * as configService from '@/services/config'

const PROMPT_PRESETS = [
  { label: '最近聊了什么', text: '最近一周我和大家主要聊了什么？按主题总结，并列出关键时间。', icon: Clock3 },
  { label: '找相关记录', text: '帮我找一下最近聊到“”的聊天记录，按相关度排序。', icon: Search },
  { label: '统计高频联系人', text: '统计最近一个月互动最多的联系人，并说明互动高峰时间。', icon: BarChart3 },
]

const REASONING_EFFORT_OPTIONS: Array<{ value: AgentReasoningEffort; label: string }> = [
  { value: 'auto', label: '思考：自动' },
  { value: 'minimal', label: '思考：最少' },
  { value: 'low', label: '思考：低' },
  { value: 'medium', label: '思考：中' },
  { value: 'high', label: '思考：高' },
]

function PromptPresetMenuItem({ label, text, icon: Icon }: (typeof PROMPT_PRESETS)[number]) {
  const { textInput } = usePromptInputController()
  return (
    <PromptInputActionMenuItem onSelect={() => textInput.setInput(text)}>
      <Icon className="size-4" />
      {label}
    </PromptInputActionMenuItem>
  )
}

function AgentPromptSubmit({ busy, status }: { busy: boolean; status: ChatStatus }) {
  const { textInput, attachments } = usePromptInputController()
  const disabled = !busy && !textInput.value.trim() && attachments.files.length === 0
  return <PromptInputSubmit disabled={disabled} status={status} />
}

type AgentModelItem = {
  chef: string
  chefSlug: string
  id: string
  name: string
  modelDetail?: AIModelInfo
  disabled?: boolean
}

// 与设置页 ModelCapabilityStrip 同一套能力图标
const CAPABILITY_ICONS = [
  { key: 'reasoning', label: '推理', icon: Brain, on: (d: AIModelInfo) => d.capabilities.reasoning },
  { key: 'tool', label: '工具调用', icon: Wrench, on: (d: AIModelInfo) => d.capabilities.toolCall },
  { key: 'structured', label: '结构化输出', icon: Braces, on: (d: AIModelInfo) => d.capabilities.structuredOutput },
  { key: 'image', label: '图像输入', icon: ImageIcon, on: (d: AIModelInfo) => d.modalities.input.includes('image') },
  { key: 'pdf', label: 'PDF', icon: FileText, on: (d: AIModelInfo) => d.modalities.input.includes('pdf') },
]

function ModelCapabilityIcons({ detail }: { detail: AIModelInfo }) {
  const active = CAPABILITY_ICONS.filter((item) => item.on(detail))
  if (active.length === 0) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
      {active.map(({ key, label, icon: Icon }) => (
        <span className="inline-flex" key={key} title={`${label}：支持`}>
          <Icon className="size-3.5" />
        </span>
      ))}
    </span>
  )
}

const ModelItem = memo(
  ({ model, selectedModel, onSelect }: { model: AgentModelItem; selectedModel: string; onSelect: (id: string) => void }) => {
    const handleSelect = useCallback(() => {
      if (!model.disabled) onSelect(model.id)
    }, [model.disabled, model.id, onSelect])
    return (
      <ModelSelectorItem disabled={model.disabled} key={model.id} onSelect={handleSelect} value={model.id}>
        {model.chefSlug && <AIProviderLogo providerId={model.chefSlug} alt={model.chef} className="shrink-0" size={20} />}
        <ModelSelectorName>{model.name}</ModelSelectorName>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {model.modelDetail && <ModelCapabilityIcons detail={model.modelDetail} />}
          {model.disabled && <span className="text-[10px] text-muted-foreground">无工具</span>}
          {selectedModel === model.id ? <CheckIcon className="size-4" /> : <div className="size-4" />}
        </span>
      </ModelSelectorItem>
    )
  }
)
ModelItem.displayName = 'ModelItem'

function MessageChainOfThought({ active, children }: { active: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(active)
  const prevActive = useRef(active)
  useEffect(() => {
    if (prevActive.current !== active) {
      prevActive.current = active
      setOpen(active)
    }
  }, [active])
  return (
    <ChainOfThought onOpenChange={setOpen} open={open}>
      <ChainOfThoughtHeader />
      <ChainOfThoughtContent>{children}</ChainOfThoughtContent>
    </ChainOfThought>
  )
}

function formatToolName(toolName: string) {
  if (toolName === 'delegate_analysis') return '委托子助手'
  return toolName.replace(/[_-]+/g, ' ')
}

function renderChainLabel(label: string, active: boolean) {
  if (!active) return label
  return (
    <Shimmer as="span" duration={1.25}>
      {label}
    </Shimmer>
  )
}

function formatElapsed(ms: number) {
  return `${Math.round(ms / 100) / 10}s`
}

function toolProgressKey(toolName: string, toolCallId?: string) {
  return toolCallId ? `call:${toolCallId}` : `name:${toolName}`
}

function toolPartProgressKey(part: unknown, toolName: string) {
  const toolCallId = typeof (part as { toolCallId?: unknown }).toolCallId === 'string'
    ? (part as { toolCallId: string }).toolCallId
    : undefined
  return toolProgressKey(toolName, toolCallId)
}

function collectToolBadges(value: unknown, badges: string[] = []): string[] {
  if (badges.length >= 6 || value == null) return badges
  if (typeof value === 'string') {
    const matches = value.match(/\b(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s"'<>)]*)?/gi) || []
    for (const match of matches) {
      const normalized = match.replace(/^https?:\/\//i, '').replace(/\/$/, '')
      if (!badges.includes(normalized)) badges.push(normalized)
      if (badges.length >= 6) break
    }
    return badges
  }
  if (Array.isArray(value)) {
    for (const item of value) collectToolBadges(item, badges)
    return badges
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) collectToolBadges(item, badges)
  }
  return badges
}

// ====== @ 提及（聚焦某个联系人/群的数据）======
type MentionTarget = {
  username: string
  displayName: string
  kind: 'person' | 'group' | 'official'
  avatarUrl?: string
}

const MENTION_SESSION_PAGE_SIZE = 1000
const MENTION_RESULT_BATCH_SIZE = 30

function classifyTarget(username: string): MentionTarget['kind'] {
  if (username.endsWith('@chatroom')) return 'group'
  if (username.startsWith('gh_')) return 'official'
  return 'person'
}

function toMentionTarget(username: string, displayName?: string, avatarUrl?: string): MentionTarget {
  return {
    username,
    displayName: displayName || username,
    kind: classifyTarget(username),
    avatarUrl,
  }
}

function getAvatarLetter(name: string): string {
  const text = name.trim()
  return text ? text.slice(0, 1).toUpperCase() : '?'
}

function buildFallbackConversationTitle(text: string): string {
  const normalized = text
    .replace(/@\S+\[[^\]]+\]/g, '')
    .replace(/[？?。！!，,、：:\s]+/g, ' ')
    .trim()
  return (normalized || '新对话').slice(0, 18)
}

type AgentConversationRecord = {
  id: number
  title: string
  scope?: AgentScope
  modelProvider?: string
  modelId?: string
  updatedAt: number
}

type AgentConversationLoaded = AgentConversationRecord & {
  messages: UIMessage[]
}

function MentionAvatar({ target, className = 'size-7' }: { target: MentionTarget; className?: string }) {
  const [avatarUrl, setAvatarUrl] = useState(target.avatarUrl || '')
  const [imageError, setImageError] = useState(false)

  useEffect(() => {
    setAvatarUrl(target.avatarUrl || '')
    setImageError(false)
  }, [target.avatarUrl, target.username])

  useEffect(() => {
    if (avatarUrl || imageError) return
    let cancelled = false
    void (async () => {
      try {
        const result = await (window as any)?.electronAPI?.chat?.getContactAvatar?.(target.username)
        if (!cancelled && result?.avatarUrl) setAvatarUrl(result.avatarUrl)
      } catch {
        // 头像兜底失败时保持文字占位。
      }
    })()
    return () => {
      cancelled = true
    }
  }, [avatarUrl, imageError, target.username])

  return (
    <span
      className={`${className} inline-flex shrink-0 items-center justify-center overflow-hidden rounded-(--agent-radius,12px) bg-muted text-muted-foreground text-xs`}
    >
      {avatarUrl && !imageError ? (
        <img
          alt=""
          className="size-full object-cover"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={avatarUrl}
          onError={() => setImageError(true)}
        />
      ) : target.kind === 'group' ? (
        <Users className="size-4" />
      ) : (
        <span>{getAvatarLetter(target.displayName || target.username)}</span>
      )}
    </span>
  )
}

/**
 * 提及栏：渲染已选 chips + 输入框里键入 @ 时弹出联系人/群选择列表。
 * 必须放在 PromptInputProvider 内（用 usePromptInputController 读写输入框）。
 */
function MentionField({
  sessions,
  mentions,
  hasMore,
  isLoading,
  onAdd,
  onLoadMore,
  onRemove,
}: {
  sessions: MentionTarget[]
  mentions: MentionTarget[]
  hasMore: boolean
  isLoading: boolean
  onAdd: (m: MentionTarget) => void
  onLoadMore: () => void
  onRemove: (username: string) => void
}) {
  const { textInput } = usePromptInputController()
  const value = textInput.value
  // 触发条件：行首或空格后的 @，后跟 0~20 个非空白非 @ 字符（在末尾）
  const match = value.match(/(?:^|\s)@([^\s@]{0,20})$/)
  const query = match ? match[1] : null
  const [visibleLimit, setVisibleLimit] = useState(MENTION_RESULT_BATCH_SIZE)
  const picked = useMemo(() => new Set(mentions.map((m) => m.username)), [mentions])
  const pickedKey = useMemo(() => mentions.map((m) => m.username).join('\n'), [mentions])
  const allResults = useMemo(() => {
    if (query === null) return []
    const q = query.toLowerCase()
    return sessions
      .filter((s) => !picked.has(s.username))
      .filter((s) => !q || s.displayName.toLowerCase().includes(q) || s.username.toLowerCase().includes(q))
  }, [sessions, query, picked])
  const results = allResults.slice(0, visibleLimit)

  useEffect(() => {
    setVisibleLimit(MENTION_RESULT_BATCH_SIZE)
  }, [query, pickedKey])

  useEffect(() => {
    if (query !== null && sessions.length === 0 && hasMore && !isLoading) onLoadMore()
  }, [hasMore, isLoading, onLoadMore, query, sessions.length])

  const loadNextVisibleBatch = useCallback(() => {
    if (visibleLimit < allResults.length) {
      setVisibleLimit((limit) => Math.min(limit + MENTION_RESULT_BATCH_SIZE, allResults.length))
      return
    }
    if (hasMore && !isLoading) onLoadMore()
  }, [allResults.length, hasMore, isLoading, onLoadMore, visibleLimit])

  const handleResultsScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      const el = event.currentTarget
      if (el.scrollHeight - el.scrollTop - el.clientHeight > 48) return
      loadNextVisibleBatch()
    },
    [loadNextVisibleBatch]
  )

  const select = (s: MentionTarget) => {
    onAdd(s)
    const atIdx = value.lastIndexOf('@')
    textInput.setInput(atIdx >= 0 ? value.slice(0, atIdx) : value)
  }

  if (mentions.length === 0 && query === null) return null

  return (
    <div className="relative flex flex-col gap-1.5">
      {mentions.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {mentions.map((m) => (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-primary text-xs"
              key={m.username}
            >
              <MentionAvatar className="size-4" target={m} />
              <span className="max-w-32 truncate">{m.displayName}</span>
              <button
                aria-label={`移除 ${m.displayName}`}
                className="ml-0.5 opacity-60 hover:opacity-100"
                onClick={() => onRemove(m.username)}
                type="button"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      {query !== null && (
        <div
          className="absolute bottom-full left-0 z-50 mb-2 max-h-80 w-80 overflow-auto rounded-(--agent-radius,12px) border border-border bg-popover p-1 shadow-lg"
          onScroll={handleResultsScroll}
        >
          {results.length > 0 ? (
            <>
              {results.map((s) => (
                <button
                  className="flex w-full items-center gap-2 rounded-(--agent-radius,12px) px-2 py-1.5 text-left text-sm hover:bg-accent"
                  key={s.username}
                  onClick={() => select(s)}
                  type="button"
                >
                  <MentionAvatar target={s} />
                  <span className="min-w-0 flex-1 truncate">{s.displayName}</span>
                  {s.kind === 'group' && <span className="ml-auto shrink-0 text-muted-foreground text-xs">群</span>}
                </button>
              ))}
              {(visibleLimit < allResults.length || hasMore || isLoading) && (
                <button
                  className="mt-1 w-full rounded-(--agent-radius,12px) px-2 py-2 text-center text-muted-foreground text-xs hover:bg-accent"
                  disabled={isLoading}
                  onClick={loadNextVisibleBatch}
                  type="button"
                >
                  {isLoading ? '加载中…' : '加载更多会话'}
                </button>
              )}
            </>
          ) : (
            <div className="px-2 py-3 text-center text-muted-foreground text-xs">
              {isLoading
                ? '联系人加载中…'
                : hasMore
                  ? (
                    <button className="rounded-(--agent-radius,12px) px-2 py-1 hover:bg-accent" onClick={onLoadMore} type="button">
                      继续加载更多会话
                    </button>
                  )
                  : sessions.length === 0
                    ? '暂无可用私聊或群聊'
                    : '未找到匹配的联系人'}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 工具栏里的 @ 按钮：往输入框塞一个 @ 触发选择列表（提升可发现性）。 */
function MentionTriggerButton() {
  const { textInput } = usePromptInputController()
  return (
    <Button
      aria-label="提及联系人或群"
      className="size-8 rounded-(--agent-radius,12px) border-border/60 bg-transparent p-0 hover:bg-accent/50"
      onClick={() => {
        const v = textInput.value
        textInput.setInput(v && !v.endsWith(' ') && !v.endsWith('@') ? `${v} @` : `${v}@`)
      }}
      type="button"
      variant="outline"
    >
      <AtSign className="size-3.5" />
    </Button>
  )
}

// ====== 出处（让用户能核对答案来源）======
type SourceItem = { id: string; sessionId: string; localId?: number; time?: string; sender?: string; text: string }

/** 从助手消息的工具结果里抽出"被引用的真实消息"作为出处。 */
function extractSources(parts: any[]): SourceItem[] {
  const items: SourceItem[] = []
  const seen = new Set<string>()
  const push = (it: SourceItem) => {
    if (!it.text || !it.sessionId || seen.has(it.id)) return
    seen.add(it.id)
    items.push(it)
  }
  for (const part of parts) {
    if (!isToolUIPart(part) || part.state !== 'output-available') continue
    const name = part.type.replace(/^tool-/, '')
    const out: any = part.output
    if (!out || out.error) continue
    if (Array.isArray(out.evidence)) {
      for (const item of out.evidence) {
        push({
          id: String(item.id || `${item.sessionId}:${item.localId ?? item.text ?? ''}`),
          sessionId: String(item.sessionId || ''),
          localId: item.localId,
          time: item.time,
          sender: item.sender,
          text: String(item.text || ''),
        })
      }
      continue
    }
    if (name === 'get_context' || name === 'get_timeline') {
      const sid = out.sessionId
      for (const m of out.messages || []) {
        push({ id: `${sid}:${m.localId}`, sessionId: sid, localId: m.localId, time: m.time, sender: m.sender, text: m.text })
      }
    } else if (name === 'search_messages' || name === 'semantic_search') {
      const arr = Array.isArray(out) ? out : out.hits || []
      for (const h of arr) {
        const lid = h?.anchor?.localId
        push({ id: `${h.sessionId}:${lid ?? h.excerpt ?? ''}`, sessionId: h.sessionId, localId: lid, time: h.time, sender: h.sender, text: h.excerpt || h.title })
      }
    }
  }
  return items.slice(0, 15)
}

function MessageSources({
  items,
  nameOf,
  onOpen,
}: {
  items: SourceItem[]
  nameOf: (sessionId: string) => string
  onOpen: (sessionId: string) => void
}) {
  if (items.length === 0) return null
  return (
    <Sources>
      <SourcesTrigger count={items.length}>
        <Quote className="size-3.5" />
        <span className="font-medium">出处 {items.length} 条</span>
      </SourcesTrigger>
      <SourcesContent className="w-full flex-row flex-wrap gap-1.5">
        {items.map((it, index) => (
          <HoverCard closeDelay={80} key={it.id} openDelay={120}>
            <HoverCardTrigger asChild>
              <button
                className="inline-flex max-w-40 items-center gap-1 rounded-full border border-border/60 bg-card/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                onClick={() => onOpen(it.sessionId)}
                type="button"
              >
                <Quote className="size-3 shrink-0 opacity-70" />
                <span className="shrink-0">{index + 1}</span>
                <span className="truncate">{nameOf(it.sessionId)}</span>
              </button>
            </HoverCardTrigger>
            <HoverCardContent align="start" className="w-80 text-xs" side="top">
              <div className="mb-1 font-medium text-[11px] text-muted-foreground">
                {[nameOf(it.sessionId), it.sender, it.time].filter(Boolean).join(' · ')}
              </div>
              <div className="max-h-40 overflow-auto whitespace-pre-wrap text-foreground">{it.text}</div>
              <div className="mt-1.5 text-[10px] text-muted-foreground">点击打开该会话</div>
            </HoverCardContent>
          </HoverCard>
        ))}
      </SourcesContent>
    </Sources>
  )
}

function normalizeConversationRecord(value: any): AgentConversationRecord | null {
  const id = Number(value?.id)
  if (!Number.isFinite(id) || id <= 0) return null
  return {
    id,
    title: String(value?.title || '新对话'),
    scope: value?.scope,
    modelProvider: value?.modelProvider,
    modelId: value?.modelId,
    updatedAt: Number(value?.updatedAt || Date.now()),
  }
}

function normalizeLoadedConversation(value: any): AgentConversationLoaded | null {
  const record = normalizeConversationRecord(value)
  if (!record) return null
  return {
    ...record,
    messages: Array.isArray(value?.messages) ? value.messages as UIMessage[] : [],
  }
}

function modelConfigProvider(config: AgentModelConfig | null): string {
  return String(config?.provider || 'current')
}

function modelConfigId(config: AgentModelConfig | null): string {
  return String(config?.model || '')
}

function progressLine(progress: AgentProgressEvent | null): string {
  if (!progress) return ''
  const title = progress.toolName === 'delegate_analysis' ? '委托子助手分析' : progress.title
  const parts = [title]
  if (progress.detail) parts.push(progress.detail)
  if (progress.sessionsScanned) parts.push(`已扫 ${progress.sessionsScanned} 个会话`)
  if (progress.indexedCount) parts.push(`索引 ${progress.indexedCount} 条`)
  if (progress.elapsedMs) parts.push(`${Math.round(progress.elapsedMs / 100) / 10}s`)
  const line = parts.filter(Boolean).join(' · ')
  // 子 Agent（委托）内的工具进度加前缀，和主 Agent 区分
  return progress.depth && progress.depth > 0 ? `↳ 子助手 · ${line}` : line
}

type AgentUsage = {
  inputTokens?: number
  inputTokenDetails?: {
    noCacheTokens?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
  }
  outputTokens?: number
  outputTokenDetails?: {
    textTokens?: number
    reasoningTokens?: number
  }
  totalTokens?: number
}

type AgentMessageMetadata = {
  usage?: AgentUsage
  finishReason?: string
  rawFinishReason?: string
  modelProvider?: string
  modelId?: string
}

function finiteNumber(value: unknown): number | undefined {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

function parseAgentMessageMetadata(metadata: unknown): AgentMessageMetadata | null {
  if (!metadata || typeof metadata !== 'object') return null
  const value = metadata as AgentMessageMetadata
  return value.usage && typeof value.usage === 'object' ? value : null
}

function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString('zh-CN')
}

function formatEstimatedCost(value: number): string {
  if (value <= 0) return '$0.0000'
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}`
}

function estimateUsageCost(metadata: AgentMessageMetadata, modelInfoByKey: Map<string, AIModelInfo>): number | null {
  const usage = metadata.usage
  if (!usage) return null
  const modelInfo = metadata.modelProvider && metadata.modelId
    ? modelInfoByKey.get(`${metadata.modelProvider}::${metadata.modelId}`) || modelInfoByKey.get(metadata.modelId)
    : metadata.modelId
      ? modelInfoByKey.get(metadata.modelId)
      : undefined
  const cost = modelInfo?.cost
  if (!cost) return null

  const inputTokens = finiteNumber(usage.inputTokens)
  const cacheReadTokens = finiteNumber(usage.inputTokenDetails?.cacheReadTokens)
  const cacheWriteTokens = finiteNumber(usage.inputTokenDetails?.cacheWriteTokens)
  const noCacheTokens = finiteNumber(usage.inputTokenDetails?.noCacheTokens)
    ?? (inputTokens !== undefined
      ? Math.max(0, inputTokens - (cacheReadTokens || 0) - (cacheWriteTokens || 0))
      : undefined)
  const outputTokens = finiteNumber(usage.outputTokens)

  let total = 0
  let priced = false
  const add = (tokens: number | undefined, pricePerMillion: number | undefined) => {
    if (tokens === undefined || pricePerMillion === undefined) return
    total += (tokens / 1_000_000) * pricePerMillion
    priced = true
  }

  add(noCacheTokens, cost.input)
  add(cacheReadTokens, cost.cacheRead ?? cost.input)
  add(cacheWriteTokens, cost.cacheWrite ?? cost.input)
  add(outputTokens, cost.output)
  return priced ? total : null
}

function MessageUsageStats({ metadata, modelInfoByKey }: { metadata: unknown; modelInfoByKey: Map<string, AIModelInfo> }) {
  const parsed = parseAgentMessageMetadata(metadata)
  const usage = parsed?.usage
  if (!parsed || !usage) return null

  const items: Array<[string, string]> = []
  const addTokens = (label: string, value: unknown) => {
    const n = finiteNumber(value)
    if (n !== undefined) items.push([label, formatTokenCount(n)])
  }

  addTokens('输入', usage.inputTokens)
  addTokens('输出', usage.outputTokens)
  addTokens('缓存命中', usage.inputTokenDetails?.cacheReadTokens)
  addTokens('缓存写入', usage.inputTokenDetails?.cacheWriteTokens)
  addTokens('推理', usage.outputTokenDetails?.reasoningTokens)
  addTokens('总计', usage.totalTokens)

  const estimatedCost = estimateUsageCost(parsed, modelInfoByKey)
  if (estimatedCost !== null) items.push(['估算', formatEstimatedCost(estimatedCost)])
  if (parsed.finishReason) items.push(['结束', parsed.finishReason])
  if (items.length === 0) return null

  return (
    <div className="mt-3 border-border/60 border-t pt-2 text-[11px] leading-5 text-muted-foreground">
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {items.map(([label, value]) => (
          <span key={label} className="whitespace-nowrap">
            <span className="text-muted-foreground/75">{label}</span>
            <span className="ml-1 font-medium text-muted-foreground">{value}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

export default function AgentPage() {
  const [presets, setPresets] = useState<configService.AiConfigPreset[]>([])
  const [providersInfo, setProvidersInfo] = useState<AIProviderInfo[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('current')
  const [reasoningEffort, setReasoningEffort] = useState<AgentReasoningEffort>('auto')
  const [currentProviderId, setCurrentProviderId] = useState('')
  const [currentModelId, setCurrentModelId] = useState('')
  const [agentProgress, setAgentProgress] = useState<AgentProgressEvent | null>(null)
  const [toolElapsedByKey, setToolElapsedByKey] = useState<Record<string, number>>({})
  const [agentNotice, setAgentNotice] = useState('')
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) || null,
    [presets, selectedPresetId]
  )
  const modelInfoByKey = useMemo(() => {
    const map = new Map<string, AIModelInfo>()
    for (const provider of providersInfo) {
      for (const detail of provider.modelDetails || []) {
        map.set(`${provider.id}::${detail.id}`, detail)
        if (!map.has(detail.id)) map.set(detail.id, detail)
      }
    }
    return map
  }, [providersInfo])
  const models = useMemo<AgentModelItem[]>(() => {
    const list = presets.map((preset) => ({
      chef: preset.provider || '其他',
      chefSlug: preset.provider || '',
      id: preset.id,
      name: preset.name,
      modelDetail: modelInfoByKey.get(`${preset.provider}::${preset.model}`) || modelInfoByKey.get(preset.model),
      disabled: (() => {
        const detail = modelInfoByKey.get(`${preset.provider}::${preset.model}`) || modelInfoByKey.get(preset.model)
        return detail ? !detail.capabilities.toolCall : false
      })(),
    }))
    const currentDetail = modelInfoByKey.get(`${currentProviderId}::${currentModelId}`) || modelInfoByKey.get(currentModelId)
    return [{
      chef: '默认',
      chefSlug: currentProviderId,
      id: 'current',
      name: currentModelId ? `当前配置 · ${currentModelId}` : '当前配置',
      modelDetail: currentDetail,
      disabled: currentDetail ? !currentDetail.capabilities.toolCall : false,
    }, ...list]
  }, [currentModelId, currentProviderId, presets, modelInfoByKey])
  const chefs = useMemo(() => [...new Set(models.map((model) => model.chef))], [models])
  const selectedModelData = models.find((model) => model.id === selectedPresetId)
  const selectedModelSupportsTools = selectedModelData?.modelDetail
    ? selectedModelData.modelDetail.capabilities.toolCall
    : true
  useEffect(() => {
    const selected = models.find((model) => model.id === selectedPresetId)
    if (!selected?.disabled) return
    const fallback = models.find((model) => !model.disabled)
    if (fallback) setSelectedPresetId(fallback.id)
  }, [models, selectedPresetId])
  const selectedModelConfig = useMemo<AgentModelConfig | null>(() => {
    if (!selectedPreset) return { reasoningEffort }
    return {
      provider: selectedPreset.provider,
      apiKey: selectedPreset.apiKey,
      model: selectedPreset.model,
      baseURL: selectedPreset.baseURL,
      protocol: selectedPreset.protocol,
      reasoningEffort,
    }
  }, [selectedPreset, reasoningEffort])
  const selectedModelConfigRef = useRef<AgentModelConfig | null>(null)
  selectedModelConfigRef.current = selectedModelConfig

  // @ 提及：会话列表（选择源）+ 已选对象
  const [sessions, setSessions] = useState<MentionTarget[]>([])
  const [mentionHasMore, setMentionHasMore] = useState(true)
  const [mentionLoading, setMentionLoading] = useState(false)
  const [mentions, setMentions] = useState<MentionTarget[]>([])
  const mentionOffsetRef = useRef(0)
  const mentionLoadingRef = useRef(false)
  const mentionHasMoreRef = useRef(true)
  const mentionConnectedRef = useRef(false)
  const mentionSeenRef = useRef(new Set<string>())
  const addMention = useCallback(
    (m: MentionTarget) => setMentions((prev) => (prev.some((x) => x.username === m.username) ? prev : [...prev, m])),
    []
  )
  const removeMention = useCallback(
    (username: string) => setMentions((prev) => prev.filter((x) => x.username !== username)),
    []
  )
  // 单个 @ → 锁定该会话 scope；多个/零个 → 全局（多个走消息注入，见 handleSubmit）
  const scopeRef = useRef<AgentScope>({ kind: 'global' })
  const submitScopeRef = useRef<AgentScope | null>(null)
  const activeScopeRef = useRef<AgentScope>({ kind: 'global' })
  scopeRef.current =
    mentions.length === 1
      ? { kind: 'session', sessionId: mentions[0].username, displayName: mentions[0].displayName }
      : { kind: 'global' }

  const handleAgentProgress = useCallback((progress: AgentProgressEvent) => {
    setAgentProgress(progress)
    if (progress.stage === 'tool_finished' && progress.toolName && progress.elapsedMs) {
      setToolElapsedByKey((prev) => ({
        ...prev,
        [toolProgressKey(progress.toolName!, progress.toolCallId)]: progress.elapsedMs!,
      }))
    }
  }, [])
  const [conversationId, setConversationId] = useState<number | null>(null)
  const conversationIdRef = useRef(conversationId)
  conversationIdRef.current = conversationId
  const transport = useMemo(
    () => new IpcChatTransport(
      () => submitScopeRef.current ?? scopeRef.current,
      () => selectedModelConfigRef.current,
      () => conversationIdRef.current,
      handleAgentProgress,
    ),
    [handleAgentProgress]
  )
  const { messages, sendMessage, setMessages, status, stop } = useChat({ transport })
  const [modelOpen, setModelOpen] = useState(false)
  const busy = status === 'submitted' || status === 'streaming'
  const visibleAgentProgress = agentProgress
    && agentProgress.stage !== 'tool_started'
    && agentProgress.stage !== 'tool_finished'
    && agentProgress.stage !== 'run_finished'
    ? agentProgress
    : null
  const [conversationTitle, setConversationTitle] = useState('新对话')
  const [titleLoading, setTitleLoading] = useState(false)
  const titleRequestSeqRef = useRef(0)
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [conversationRecords, setConversationRecords] = useState<AgentConversationRecord[]>([])

  const appendMentionTargets = useCallback((items: MentionTarget[]) => {
    if (items.length === 0) return
    setSessions((prev) => {
      const next = [...prev]
      for (const item of items) {
        if (mentionSeenRef.current.has(item.username)) continue
        mentionSeenRef.current.add(item.username)
        next.push(item)
      }
      return next
    })
  }, [])

  const updateMentionHasMore = useCallback((hasMore: boolean) => {
    mentionHasMoreRef.current = hasMore
    setMentionHasMore(hasMore)
  }, [])

  const loadMentionSessions = useCallback(async () => {
    if (mentionLoadingRef.current || !mentionHasMoreRef.current) return
    mentionLoadingRef.current = true
    setMentionLoading(true)
    const chat = (window as any)?.electronAPI?.chat

    try {
      if (!mentionConnectedRef.current) {
        try { await chat?.connect?.() } catch { /* 配置不全则后续为空 */ }
        mentionConnectedRef.current = true
      }

      const offset = mentionOffsetRef.current
      const res = await chat?.getMentionTargets?.(offset, MENTION_SESSION_PAGE_SIZE)
      if (res?.success && Array.isArray(res.sessions)) {
        appendMentionTargets(
          res.sessions
            .map((s: any) => toMentionTarget(s.username, s.displayName, s.avatarUrl))
        )
        mentionOffsetRef.current = offset + MENTION_SESSION_PAGE_SIZE
        updateMentionHasMore(!!res.hasMore)
        return
      }
      updateMentionHasMore(false)
    } catch {
      updateMentionHasMore(false)
    } finally {
      mentionLoadingRef.current = false
      setMentionLoading(false)
    }
  }, [appendMentionTargets, updateMentionHasMore])

  const refreshConversationRecords = useCallback(async () => {
    const result = await window.electronAPI.agent.listConversations()
    if (!result.success || !Array.isArray(result.conversations)) return
    setConversationRecords(
      result.conversations
        .map(normalizeConversationRecord)
        .filter((item): item is AgentConversationRecord => !!item)
    )
  }, [])

  const persistConversationMessages = useCallback(async (
    targetId: number | null,
    nextMessages: UIMessage[],
    nextScope: AgentScope,
  ) => {
    if (!targetId || nextMessages.length === 0) return
    const config = selectedModelConfigRef.current
    const result = await window.electronAPI.agent.saveConversationMessages({
      id: targetId,
      messages: nextMessages,
      scope: nextScope,
      modelProvider: modelConfigProvider(config),
      modelId: modelConfigId(config),
    })
    if (result.success) void refreshConversationRecords()
  }, [refreshConversationRecords])

  const createConversation = useCallback(async (scope: AgentScope, title: string): Promise<number | null> => {
    const config = selectedModelConfigRef.current
    const result = await window.electronAPI.agent.createConversation({
      scope,
      title,
      modelProvider: modelConfigProvider(config),
      modelId: modelConfigId(config),
    })
    const record = result.success ? normalizeConversationRecord(result.conversation) : null
    if (!record) return null
    setConversationId(record.id)
    conversationIdRef.current = record.id
    setConversationTitle(record.title)
    void refreshConversationRecords()
    return record.id
  }, [refreshConversationRecords])

  const generateTitleFromFirstMessage = useCallback((firstMessage: string) => {
    const fallback = buildFallbackConversationTitle(firstMessage)
    setConversationTitle(fallback)
    setTitleLoading(true)
    const requestSeq = ++titleRequestSeqRef.current
    const targetConversationId = conversationIdRef.current
    void window.electronAPI.agent
      .generateTitle(firstMessage, selectedModelConfigRef.current)
      .then((result) => {
        if (requestSeq !== titleRequestSeqRef.current || targetConversationId !== conversationIdRef.current) return
        if (result.success && result.title?.trim()) {
          const nextTitle = result.title.trim().slice(0, 24)
          setConversationTitle(nextTitle)
          if (targetConversationId) {
            void window.electronAPI.agent.renameConversation(targetConversationId, nextTitle).then(() => refreshConversationRecords())
          }
        }
      })
      .finally(() => {
        if (requestSeq === titleRequestSeqRef.current && targetConversationId === conversationIdRef.current) {
          setTitleLoading(false)
        }
      })
  }, [])

  const handleNewConversation = useCallback(() => {
    if (busy) void stop()
    setMessages([])
    setMentions([])
    setConversationTitle('新对话')
    setTitleLoading(false)
    setAgentProgress(null)
    setToolElapsedByKey({})
    setAgentNotice('')
    activeScopeRef.current = { kind: 'global' }
    lastSavedMessagesRef.current = ''
    titleRequestSeqRef.current += 1
    setConversationId(null)
    setRecordsOpen(false)
  }, [busy, setMessages, stop])

  const handleOpenRecord = useCallback((record: AgentConversationRecord) => {
    if (busy) void stop()
    void window.electronAPI.agent.loadConversation(record.id).then((result) => {
      const loaded = result.success ? normalizeLoadedConversation(result.conversation) : null
      if (!loaded) return
      setMessages(loaded.messages)
      try {
        lastSavedMessagesRef.current = JSON.stringify(loaded.messages)
      } catch {
        lastSavedMessagesRef.current = ''
      }
      setConversationId(loaded.id)
      setConversationTitle(loaded.title)
      activeScopeRef.current = loaded.scope || { kind: 'global' }
      setMentions([])
      setAgentProgress(null)
      setToolElapsedByKey({})
      setAgentNotice('')
      setTitleLoading(false)
      titleRequestSeqRef.current += 1
      setRecordsOpen(false)
    })
  }, [busy, setMessages, stop])

  const handleDeleteRecord = useCallback((record: AgentConversationRecord) => {
    void window.electronAPI.agent.deleteConversation(record.id).then((result) => {
      if (!result.success) return
      setConversationRecords((prev) => prev.filter((item) => item.id !== record.id))
      if (conversationIdRef.current === record.id) {
        setMessages([])
        setConversationId(null)
        setConversationTitle('新对话')
        activeScopeRef.current = { kind: 'global' }
        lastSavedMessagesRef.current = ''
        setAgentProgress(null)
        setToolElapsedByKey({})
      }
    })
  }, [setMessages])

  useEffect(() => {
    let cancelled = false
    void configService.getAiConfigPresets().then((items) => {
      if (cancelled) return
      setPresets(items)
      setSelectedPresetId((current) => {
        if (current !== 'current' && items.some((item) => item.id === current)) return current
        return items[0]?.id || 'current'
      })
    })
    void getAIProviders().then((items) => {
      if (!cancelled) setProvidersInfo(items)
    })
    void Promise.all([configService.getAiProvider(), configService.getAiModel()]).then(([provider, model]) => {
      if (cancelled) return
      setCurrentProviderId(provider)
      setCurrentModelId(model)
    })
    void window.electronAPI.agent.listConversations().then((result) => {
      if (cancelled || !result.success || !Array.isArray(result.conversations)) return
      setConversationRecords(
        result.conversations
          .map(normalizeConversationRecord)
          .filter((item): item is AgentConversationRecord => !!item)
      )
    })
    return () => {
      cancelled = true
    }
  }, [refreshConversationRecords])

  const handleSubmit = (message: PromptInputMessage) => {
    if (busy) {
      void stop()
      return
    }
    if (!selectedModelSupportsTools) {
      setAgentNotice('当前模型不支持工具调用，无法查询本地聊天记录。请切换到带“工具调用”能力的模型。')
      return
    }
    void (async () => {
      const isFirstUserMessage = messages.length === 0
      const firstMessageForTitle = message.text.trim()
      let text = message.text.trim()
      const currentMentions = mentions
      if (currentMentions.length > 0) {
        const mentionLine = currentMentions.map((m) => `@${m.displayName}[${m.username}]`).join(' ')
        text = text ? `${mentionLine}\n${text}` : mentionLine
      }
      if (!text && message.files.length === 0) return

      const submitScope: AgentScope =
        currentMentions.length === 1
          ? { kind: 'session', sessionId: currentMentions[0].username, displayName: currentMentions[0].displayName }
          : { kind: 'global' }
      activeScopeRef.current = submitScope
      submitScopeRef.current = submitScope
      setAgentNotice('')
      setAgentProgress({ stage: 'run_started', title: '准备发送问题', at: Date.now() })

      if (!conversationIdRef.current) {
        const fallback = buildFallbackConversationTitle(firstMessageForTitle || text)
        setConversationTitle(fallback)
        await createConversation(submitScope, fallback)
      }

      if (isFirstUserMessage) generateTitleFromFirstMessage(firstMessageForTitle || text)

      await Promise.resolve(sendMessage({ text, files: message.files })).finally(() => {
        submitScopeRef.current = null
      })
      setMentions([])
    })()
  }

  const handleModelSelect = useCallback((id: string) => {
    if (models.find((model) => model.id === id)?.disabled) return
    setSelectedPresetId(id)
    setModelOpen(false)
  }, [models])

  const lastSavedMessagesRef = useRef('')
  useEffect(() => {
    if (busy || !conversationId || messages.length === 0) return
    let signature = ''
    try {
      signature = JSON.stringify(messages)
    } catch {
      signature = `${messages.length}:${Date.now()}`
    }
    if (signature === lastSavedMessagesRef.current) return
    lastSavedMessagesRef.current = signature
    void persistConversationMessages(conversationId, messages, activeScopeRef.current)
  }, [busy, conversationId, messages, persistConversationMessages])

  // 出处：会话名解析 + 点击打开该会话
  const navigate = useNavigate()
  const setCurrentSession = useChatStore((s) => s.setCurrentSession)
  const sessionNameMap = useMemo(() => new Map(sessions.map((s) => [s.username, s.displayName])), [sessions])
  const sessionNameOf = useCallback((sessionId: string) => sessionNameMap.get(sessionId) || sessionId, [sessionNameMap])
  const openInChat = useCallback(
    (sessionId: string) => {
      if (!sessionId) return
      setCurrentSession(sessionId)
      navigate('/home')
    },
    [navigate, setCurrentSession]
  )

  return (
    <Surface
      className="flex h-full min-h-0 flex-col"
      style={{ '--agent-radius': '12px' } as CSSProperties}
      variant="transparent"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-4">
        <div className="min-w-0">
          <h2 className="truncate font-medium text-sm text-foreground">
            {titleLoading ? '生成标题中...' : conversationTitle}
          </h2>
        </div>
        <div className="relative flex items-center gap-1">
          <Button
            aria-label="对话记录"
            className="size-8 rounded-(--agent-radius,12px) p-0"
            onClick={() => setRecordsOpen((open) => !open)}
            title="对话记录"
            type="button"
            variant="ghost"
          >
            <History className="size-4" />
          </Button>
          <Button
            aria-label="新建对话"
            className="size-8 rounded-(--agent-radius,12px) p-0"
            onClick={handleNewConversation}
            title="新建对话"
            type="button"
            variant="ghost"
          >
            <SquarePen className="size-4" />
          </Button>
          {recordsOpen && (
            <div className="absolute right-0 top-10 z-50 w-72 overflow-hidden rounded-(--agent-radius,12px) border border-border bg-popover p-1 shadow-lg">
              {conversationRecords.length > 0 ? (
                conversationRecords.map((record) => (
                  <div className="flex items-center gap-1 rounded-(--agent-radius,12px) hover:bg-accent" key={record.id}>
                    <button
                      className="flex min-w-0 flex-1 flex-col px-2 py-1.5 text-left"
                      onClick={() => handleOpenRecord(record)}
                      type="button"
                    >
                      <span className="w-full truncate text-sm text-foreground">{record.title}</span>
                      <span className="text-muted-foreground text-xs">
                        {new Date(record.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </button>
                    <button
                      aria-label={`删除 ${record.title}`}
                      className="mr-1 inline-flex size-7 shrink-0 items-center justify-center rounded-(--agent-radius,12px) text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => handleDeleteRecord(record)}
                      type="button"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))
              ) : (
                <div className="px-2 py-3 text-center text-muted-foreground text-xs">暂无对话记录</div>
              )}
            </div>
          )}
        </div>
      </div>
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="mx-auto w-full min-w-80 max-w-[82%] py-4">
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="开始查询聊天记录"
              description="输入问题后，助手会基于本地聊天数据回答"
            />
          ) : (
            messages.map((message, messageIndex) => {
              const chainParts = message.parts.filter((part) => part.type === 'reasoning' || isToolUIPart(part))
              const isLastMessage = messageIndex === messages.length - 1
              const lastPart = message.parts[message.parts.length - 1]
              const isReasoningStreaming = isLastMessage && status === 'streaming' && lastPart?.type === 'reasoning'
              const chainActive = isLastMessage && busy
              return (
                <Message from={message.role} key={message.id}>
                  <MessageContent>
                    {chainParts.length > 0 && (
                      <MessageChainOfThought active={chainActive}>
                        {chainParts.map((part, index) => {
                          if (part.type === 'reasoning') {
                            const reasoningActive = isReasoningStreaming && index === chainParts.length - 1
                            return (
                              <ChainOfThoughtStep
                                icon={Brain}
                                key={`chain-${index}`}
                                label={renderChainLabel('Reasoning', reasoningActive)}
                                status={reasoningActive ? 'active' : 'complete'}
                              >
                                <div className="whitespace-pre-wrap text-muted-foreground text-sm">
                                  {part.text}
                                </div>
                              </ChainOfThoughtStep>
                            )
                          }
                          const toolName = part.type.replace(/^tool-/, '')
                          const done = part.state === 'output-available' || part.state === 'output-error'
                          const toolLabel = formatToolName(toolName)
                          const elapsedMs = toolElapsedByKey[toolPartProgressKey(part, toolName)]
                          const label = done && elapsedMs ? `${toolLabel} · ${formatElapsed(elapsedMs)}` : toolLabel
                          const badges = collectToolBadges(part.input)
                          if (part.state === 'output-available') collectToolBadges(part.output, badges)
                          return (
                            <ChainOfThoughtStep
                              icon={toolName.includes('search') ? Search : Wrench}
                              key={`chain-${index}`}
                              label={renderChainLabel(label, !done)}
                              status={done ? 'complete' : 'active'}
                            >
                              {badges.length > 0 && (
                                <ChainOfThoughtSearchResults>
                                  {badges.map((badge) => (
                                    <ChainOfThoughtSearchResult key={badge}>
                                      {badge}
                                    </ChainOfThoughtSearchResult>
                                  ))}
                                </ChainOfThoughtSearchResults>
                              )}
                              {part.state === 'output-error' && part.errorText && (
                                <p className="text-destructive text-xs">{part.errorText}</p>
                              )}
                            </ChainOfThoughtStep>
                          )
                        })}
                      </MessageChainOfThought>
                    )}
                    {message.parts.map((part, index) => {
                      if (part.type === 'text') {
                        return <MessageResponse key={`text-${index}`}>{part.text}</MessageResponse>
                      }
                      if (part.type === 'file') {
                        return (
                          <MessageAttachments key={`file-${index}`}>
                            <MessageAttachment data={part} />
                          </MessageAttachments>
                        )
                      }
                      return null
                    })}
                    {message.role === 'assistant' && (
                      <MessageSources items={extractSources(message.parts)} nameOf={sessionNameOf} onOpen={openInChat} />
                    )}
                    {message.role === 'assistant' && (
                      <MessageUsageStats metadata={message.metadata} modelInfoByKey={modelInfoByKey} />
                    )}
                  </MessageContent>
                </Message>
              )
            })
          )}
          {(agentNotice || visibleAgentProgress) && (
            <div className={`mt-3 rounded-(--agent-radius,12px) border px-3 py-2 text-xs ${agentNotice ? 'border-destructive/30 bg-destructive/5 text-destructive' : 'border-border/60 bg-muted/40 text-muted-foreground'}`}>
              {agentNotice || progressLine(visibleAgentProgress)}
            </div>
          )}
          {status === 'submitted' && <Loader />}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="shrink-0">
        <PromptInputProvider>
          <PromptInput
            accept="image/*,.txt,.md,.json,.csv"
            className="mx-auto mb-3 w-full min-w-80 max-w-[82%] **:data-[slot=input-group]:rounded-(--agent-radius,12px) **:data-[slot=input-group]:border-border **:data-[slot=input-group]:bg-surface **:data-[slot=input-group]:shadow-xs"
            maxFiles={6}
            maxFileSize={8 * 1024 * 1024}
            multiple
            onSubmit={handleSubmit}
          >
            <PromptInputHeader className="flex-col items-stretch gap-2 border-b">
              <MentionField
                hasMore={mentionHasMore}
                isLoading={mentionLoading}
                mentions={mentions}
                onAdd={addMention}
                onLoadMore={loadMentionSessions}
                onRemove={removeMention}
                sessions={sessions}
              />
              <PromptInputAttachments className="p-0">
                {(attachment) => <PromptInputAttachment data={attachment} />}
              </PromptInputAttachments>
            </PromptInputHeader>

            <PromptInputBody>
              <PromptInputTextarea placeholder="问问你的聊天记录，Enter 发送，Shift + Enter 换行…" />
            </PromptInputBody>

            <PromptInputFooter>
              <PromptInputTools className="flex-wrap">
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger aria-label="更多输入操作" />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments label="添加图片或文件" />
                    {PROMPT_PRESETS.map((preset) => (
                      <PromptPresetMenuItem key={preset.label} {...preset} />
                    ))}
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
                <MentionTriggerButton />
                <PromptInputSpeechButton aria-label="语音输入" language="zh-CN" />

                <PromptInputSelect
                  onValueChange={(value) => setReasoningEffort(value as AgentReasoningEffort)}
                  value={reasoningEffort}
                >
                  <PromptInputSelectTrigger aria-label="思考程度" className="h-8 gap-1.5 rounded-(--agent-radius,12px) px-2.5">
                    <Brain className="size-3.5" />
                    <PromptInputSelectValue />
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent align="start" position="popper" side="top">
                    {REASONING_EFFORT_OPTIONS.map((option) => (
                      <PromptInputSelectItem key={option.value} value={option.value}>
                        {option.label}
                      </PromptInputSelectItem>
                    ))}
                  </PromptInputSelectContent>
                </PromptInputSelect>

                <ModelSelector onOpenChange={setModelOpen} open={modelOpen}>
                  <ModelSelectorTrigger asChild>
                    <Button className="max-w-48 rounded-(--agent-radius,12px) border-border/60 bg-transparent hover:bg-accent/50" variant="outline">
                      {selectedModelData?.chefSlug && (
                        <AIProviderLogo providerId={selectedModelData.chefSlug} alt={selectedModelData.chef} className="shrink-0" size={18} />
                      )}
                      {selectedModelData?.name && (
                        <ModelSelectorName>{selectedModelData.name}</ModelSelectorName>
                      )}
                    </Button>
                  </ModelSelectorTrigger>
                  <ModelSelectorContent>
                    <ModelSelectorInput placeholder="搜索模型..." />
                    <ModelSelectorList>
                      <ModelSelectorEmpty>没有匹配的模型</ModelSelectorEmpty>
                      {chefs.map((chef) => (
                        <ModelSelectorGroup heading={chef} key={chef}>
                          {models
                            .filter((model) => model.chef === chef)
                            .map((model) => (
                              <ModelItem
                                key={model.id}
                                model={model}
                                onSelect={handleModelSelect}
                                selectedModel={selectedPresetId}
                              />
                            ))}
                        </ModelSelectorGroup>
                      ))}
                    </ModelSelectorList>
                  </ModelSelectorContent>
                </ModelSelector>
              </PromptInputTools>

              <AgentPromptSubmit busy={busy} status={status} />
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
      </div>
    </Surface>
  )
}
