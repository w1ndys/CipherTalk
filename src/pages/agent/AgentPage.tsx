/**
 * AI Agent 对话页（Phase C）——使用 AI SDK 的 useChat + AI Elements 组件。
 * 数据：useChat 走 IpcChatTransport（IPC → AI 子进程 → 流式 UIMessageChunk）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type UIEvent } from 'react'
import { useChat } from '@ai-sdk/react'
import { isToolUIPart, type ChatStatus, type UIMessage } from 'ai'
import { AlertDialog, Button as HeroButton, ButtonGroup, Dropdown, Header, Label, Modal, Separator, Surface, Switch, Table, Toolbar } from '@heroui/react'
import { AtSign, BarChart3, Braces, Brain, CheckIcon, ChevronDown, Clock3, Code2, Copy, FileText, Globe, History, Image as ImageIcon, Info, Link2, ListChecks, PenLine, Play, Quote, RefreshCcw, Search, Slash, SquarePen, Table2, Trash2, Users, Volume2, Wrench, X, Sparkles } from 'lucide-react'
import { Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import {
  Conversation,
  ConversationAutoScroll,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { analyzeMessageRenderActivity, Message, MessageAction, MessageActions, MessageAttachment, MessageAttachments, MessageContent, MessageResponse, type MessageRenderActivity } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputProvider,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
  usePromptInputController,
} from '@/components/ai-elements/prompt-input'
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

const PLAN_DELEGATE_ANALYSIS_REQUIRED_PATTERN = /<!--\s*ciphertalk:delegate_analysis=required\s*-->/i
const PLAN_CONTROL_MARKER_PATTERN = /<!--\s*ciphertalk:delegate_analysis=(?:required|not_required)\s*-->/gi

function stripPlanControlMarkers(text: string): string {
  return text.replace(PLAN_CONTROL_MARKER_PATTERN, '').trim()
}

function planRequiresDelegateAnalysis(text: string): boolean {
  return PLAN_DELEGATE_ANALYSIS_REQUIRED_PATTERN.test(text)
}

function SlashPresetButton({ showGroupSeparator = false }: { showGroupSeparator?: boolean }) {
  const { textInput } = usePromptInputController()
  const value = textInput.value
  const slashMatch = value.match(/(?:^|\s)\/([^\s/]{0,20})$/)
  const query = slashMatch ? slashMatch[1].toLowerCase() : null
  const presets = useMemo(
    () => PROMPT_PRESETS.filter((preset) => !query || preset.label.toLowerCase().includes(query) || preset.text.toLowerCase().includes(query)),
    [query]
  )
  const [manualOpen, setManualOpen] = useState(false)
  const isOpen = manualOpen || query !== null

  const openSlashMenu = () => {
    const v = textInput.value
    textInput.setInput(v && !v.endsWith(' ') && !v.endsWith('/') ? `${v} /` : `${v}/`)
    setManualOpen(true)
  }

  const applyPreset = (text: string) => {
    if (query !== null) {
      const slashIdx = value.lastIndexOf('/')
      const prefix = slashIdx >= 0 ? value.slice(0, slashIdx).trimEnd() : ''
      textInput.setInput(prefix ? `${prefix} ${text}` : text)
    } else {
      textInput.setInput(text)
    }
    setManualOpen(false)
  }

  return (
    <Dropdown isOpen={isOpen} onOpenChange={setManualOpen}>
      <HeroButton aria-label="打开预设" isIconOnly size="sm" variant="tertiary" onPress={openSlashMenu}>
        {showGroupSeparator && <ButtonGroup.Separator />}
        <Slash className="size-3.5" />
      </HeroButton>
      <Dropdown.Popover className="min-w-56" placement="top start">
        <Dropdown.Menu>
          {presets.map((preset) => {
            const Icon = preset.icon
            return (
              <Dropdown.Item id={`preset-${preset.label}`} key={preset.label} textValue={preset.label} onAction={() => applyPreset(preset.text)}>
                <Icon className="size-4 shrink-0 text-muted" />
                <Label>{preset.label}</Label>
              </Dropdown.Item>
            )
          })}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
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
  ({ model }: { model: AgentModelItem }) => {
    return (
      <Dropdown.Item id={model.id} key={model.id} textValue={model.name}>
        <Dropdown.ItemIndicator />
        {model.chefSlug && <AIProviderLogo providerId={model.chefSlug} alt={model.chef} className="shrink-0" size={20} />}
        <Label className="min-w-0 flex-1 truncate text-left">{model.name}</Label>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {model.modelDetail && <ModelCapabilityIcons detail={model.modelDetail} />}
          {model.disabled && <span className="text-[10px] text-muted-foreground">无工具</span>}
        </span>
      </Dropdown.Item>
    )
  }
)
ModelItem.displayName = 'ModelItem'

// 计划模式专用：把"执行计划"正文装进单独的可折叠卡片，默认收起，点击标题展开看详情。
function PlanCard({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1.5 overflow-hidden rounded-xl border border-border bg-surface">
      <button
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-medium text-sm hover:bg-muted/40"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <ListChecks className="size-4 shrink-0 text-muted-foreground" />
        <span>执行计划</span>
        {streaming
          ? <span className="font-normal text-muted-foreground text-xs">生成中…</span>
          : <span className="font-normal text-muted-foreground text-xs">{open ? '点击收起' : '点击展开查看详情'}</span>}
        <ChevronDown className={`ml-auto size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-border border-t px-3 py-2">
          <MessageResponse isStreaming={streaming}>{text}</MessageResponse>
        </div>
      )}
    </div>
  )
}

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

const TOOL_LABELS: Record<string, string> = {
  delegate_analysis: '委托子助手',
  remember: '保存记忆',
  recall: '查找记忆',
  list_memories: '查看记忆',
  forget: '删除记忆',
  consolidate_memory: '整理记忆',
  search_moments: '搜索朋友圈',
  moments_stats: '朋友圈统计',
  web_search: '联网搜索',
  auto_memory: '自动记忆',
  final_review: '最终审核',
}

function formatToolName(toolName: string) {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.slice(5).split('__')
    const server = parts[0] || 'server'
    const tool = parts.slice(1).join('__') || 'tool'
    return `MCP: ${server}/${tool}`
  }
  return TOOL_LABELS[toolName] ?? toolName.replace(/[_-]+/g, ' ')
}

/** @ 单个会话且其未建语义索引时，提示建立（可建/可跳过，跳过后本会话不再提示）。 */
function SessionVectorizePrompt({ session, dismissed }: { session: { username: string; displayName?: string }; dismissed: { current: Set<string> } }) {
  const [status, setStatus] = useState<{ enabled: boolean; count: number } | null>(null)
  const [building, setBuilding] = useState(false)
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    let cancelled = false
    setHidden(dismissed.current.has(session.username))
    void window.electronAPI.embedding.sessionStatus(session.username).then((r) => {
      if (!cancelled && r.success) setStatus({ enabled: !!r.enabled, count: r.count ?? 0 })
    })
    return () => { cancelled = true }
  }, [session.username, dismissed])

  if (hidden || !status || !status.enabled || status.count > 0) return null

  const build = async () => {
    setBuilding(true)
    try {
      const r = await window.electronAPI.embedding.buildSession(session.username)
      if (r.success) setStatus({ enabled: true, count: r.indexed ?? 0 })
    } finally {
      setBuilding(false)
    }
  }
  const skip = () => { dismissed.current.add(session.username); setHidden(true) }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
      <Sparkles className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">为「{session.displayName || session.username}」建立语义索引，AI 可按语义检索这段聊天。</span>
      <Button size="sm" variant="default" onClick={() => void build()} disabled={building}>
        {building ? '建立中…' : '建立'}
      </Button>
      <Button size="sm" variant="ghost" onClick={skip} disabled={building}>跳过</Button>
    </div>
  )
}

function renderChainLabel(label: string, active: boolean) {
  if (!active) return label
  return (
    <Shimmer as="span" duration={1.25}>
      {label}
    </Shimmer>
  )
}

function renderOutputActivitySteps(activity: MessageRenderActivity, isStreaming: boolean) {
  const steps: Array<{ key: string; icon: typeof BarChart3; label: string; doneLabel: string; active: boolean }> = []
  if (activity.hasChart || activity.pendingChart) {
    steps.push({
      key: 'chart',
      icon: BarChart3,
      label: '正在生成图表',
      doneLabel: '已生成图表',
      active: isStreaming,
    })
  }
  if (activity.hasTable || activity.pendingTable) {
    steps.push({
      key: 'table',
      icon: Table2,
      label: '正在整理表格',
      doneLabel: '已整理表格',
      active: isStreaming,
    })
  }
  if (activity.hasCode || activity.pendingCode) {
    steps.push({
      key: 'code',
      icon: Code2,
      label: '正在生成代码块',
      doneLabel: '已生成代码块',
      active: isStreaming,
    })
  }
  if (activity.hasLink || activity.pendingLink) {
    steps.push({
      key: 'link',
      icon: Link2,
      label: '正在处理链接',
      doneLabel: activity.linkCount > 0 ? `已处理链接 ${activity.linkCount} 条` : '已处理链接',
      active: isStreaming && (activity.pendingLink || activity.hasLink),
    })
  }
  return steps
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

function getDelegateTask(part: unknown): string | undefined {
  const input = (part as { input?: unknown }).input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
  const task = (input as { task?: unknown }).task
  return typeof task === 'string' && task.trim() ? task.trim() : undefined
}

const SUB_AGENT_PROGRESS_LIMIT = 12
const AGENT_PENDING_TITLE = '正在准备请求'

function subAgentProgressKey(progress: AgentProgressEvent) {
  if (progress.toolCallId) return `call:${progress.toolCallId}`
  if (progress.toolName && (progress.stage === 'tool_started' || progress.stage === 'tool_finished' || progress.stage === 'error')) {
    return `tool:${progress.depth ?? 0}:${progress.toolName}`
  }
  return `event:${progress.depth ?? 0}:${progress.stage}:${progress.title}:${progress.sessionId ?? ''}`
}

function mergeSubAgentProgress(prev: AgentProgressEvent[], progress: AgentProgressEvent) {
  const key = subAgentProgressKey(progress)
  const next = prev.filter((item) => subAgentProgressKey(item) !== key)
  return [...next, progress].slice(-SUB_AGENT_PROGRESS_LIMIT)
}

function formatSubAgentStage(progress: AgentProgressEvent) {
  switch (progress.stage) {
    case 'tool_started':
      return '开始'
    case 'tool_finished':
      return '完成'
    case 'indexing':
      return '索引'
    case 'searching':
      return '检索'
    case 'error':
      return '出错'
    case 'run_finished':
      return '完成'
    case 'run_started':
    default:
      return '启动'
  }
}

function formatSubAgentProgressTitle(progress: AgentProgressEvent) {
  if (progress.toolName) return `${formatToolName(progress.toolName)} · ${formatSubAgentStage(progress)}`
  return progress.title
}

function formatSubAgentProgressMeta(progress: AgentProgressEvent): string[] {
  const meta: string[] = []
  if (progress.depth != null) meta.push(`深度 ${progress.depth}`)
  if (progress.messagesScanned != null) meta.push(`扫描 ${progress.messagesScanned} 条`)
  if (progress.indexedCount != null) meta.push(`索引 ${progress.indexedCount} 条`)
  if (progress.sessionsScanned != null) meta.push(`会话 ${progress.sessionsScanned}`)
  if (progress.coverage) meta.push(progress.coverage)
  if (progress.elapsedMs != null) meta.push(formatElapsed(progress.elapsedMs))
  if (progress.detail) meta.push(progress.detail)
  return meta
}

function subAgentProgressIcon(progress: AgentProgressEvent) {
  if (progress.stage === 'searching') return Search
  if (progress.stage === 'indexing') return Sparkles
  if (progress.stage === 'error') return Info
  return Wrench
}

function agentProgressIcon(progress: AgentProgressEvent) {
  const title = progress.title || ''
  if (progress.stage === 'error') return Info
  if (title.includes('记忆')) return Brain
  if (title.includes('工具')) return Wrench
  if (title.includes('模型')) return Sparkles
  return Sparkles
}

function AgentProgressChain({ active, events }: { active: boolean; events: AgentProgressEvent[] }) {
  if (events.length === 0) return null
  const latestKey = subAgentProgressKey(events[events.length - 1])

  return (
    <MessageChainOfThought active={active}>
      {events.map((progress) => {
        const key = subAgentProgressKey(progress)
        const stepActive = active
          && key === latestKey
          && progress.stage !== 'run_finished'
          && progress.stage !== 'error'
        return (
          <ChainOfThoughtStep
            description={progress.detail}
            icon={agentProgressIcon(progress)}
            key={key}
            label={renderChainLabel(formatSubAgentProgressTitle(progress), stepActive)}
            status={stepActive ? 'active' : progress.stage === 'error' ? 'pending' : 'complete'}
          />
        )
      })}
    </MessageChainOfThought>
  )
}

function subAgentProgressDotClass(progress: AgentProgressEvent) {
  if (progress.stage === 'error') return 'bg-destructive'
  if (progress.stage === 'tool_finished' || progress.stage === 'run_finished') return 'bg-emerald-500'
  return 'bg-foreground/70'
}

function formatProgressTime(value: number) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function subAgentPanelTitle(latest: AgentProgressEvent) {
  if (latest.stage === 'error') return '子助手出错'
  if ((latest.depth ?? 0) === 0) {
    if (latest.stage === 'run_finished') return 'AI 助手已完成'
    return 'AI 助手准备中'
  }
  if (latest.stage === 'run_finished') return '子助手已完成'
  return '子助手运行中'
}

function SubAgentProgressPanel({ events, task }: { events: AgentProgressEvent[]; task?: string }) {
  if (events.length === 0) return null
  const latestKey = subAgentProgressKey(events[events.length - 1])
  const latest = events[events.length - 1]
  const toolCount = new Set(events.map((event) => event.toolName).filter(Boolean)).size

  return (
    <section
      aria-live="polite"
      className="mt-2 rounded-(--agent-radius,12px) border border-border bg-surface/80 px-3 py-2.5 text-xs shadow-xs"
    >
      <div className="mb-2 flex min-w-0 items-center gap-2 font-medium text-foreground">
        <Sparkles className="size-3.5 shrink-0" />
        <span className="shrink-0">{subAgentPanelTitle(latest)}</span>
        <span className="min-w-0 truncate text-muted-foreground font-normal">
          {formatSubAgentProgressTitle(latest)}
        </span>
      </div>
      {task && (
        <div className="mb-2 rounded-(--agent-radius,12px) bg-muted/50 px-2 py-1.5 text-muted-foreground">
          <div className="mb-0.5 text-[11px] text-foreground">委托任务</div>
          <div className="line-clamp-3 whitespace-pre-wrap wrap-break-word">{task}</div>
        </div>
      )}
      <div className="mb-2 flex flex-wrap gap-1">
        <span className="rounded-full bg-muted/60 px-2 py-0.5 text-muted-foreground">{events.length} 条进度</span>
        {toolCount > 0 && <span className="rounded-full bg-muted/60 px-2 py-0.5 text-muted-foreground">{toolCount} 个工具</span>}
        <span className="rounded-full bg-muted/60 px-2 py-0.5 text-muted-foreground">最近 {formatProgressTime(latest.at)}</span>
      </div>
      <div className="space-y-1">
        {events.map((progress) => {
          const Icon = subAgentProgressIcon(progress)
          const itemKey = subAgentProgressKey(progress)
          const meta = formatSubAgentProgressMeta(progress)
          const active = itemKey === latestKey
            && progress.stage !== 'tool_finished'
            && progress.stage !== 'run_finished'
            && progress.stage !== 'error'
          return (
            <div
              className="flex min-w-0 items-start gap-2 rounded-(--agent-radius,12px) px-1.5 py-1 text-muted-foreground"
              key={itemKey}
            >
              <span className="relative mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
                <Icon className="size-3.5" />
                <span className={`absolute -right-0.5 -top-0.5 size-1.5 rounded-full ${subAgentProgressDotClass(progress)} ${active ? 'animate-pulse' : ''}`} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-foreground">{formatSubAgentProgressTitle(progress)}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{formatProgressTime(progress.at)}</span>
                </div>
                {meta.length > 0 && (
                  <div className="mt-0.5 flex min-w-0 flex-wrap gap-1">
                    {meta.map((item) => (
                      <span
                        className="max-w-full truncate rounded-(--agent-radius,12px) bg-muted/60 px-1.5 py-0.5"
                        key={item}
                        title={item}
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
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

const RETRIEVAL_MODE_LABELS: Record<string, string> = {
  hybrid: '召回: 混合',
  keyword: '召回: 关键词',
  vector: '召回: 向量',
}

const RETRIEVAL_FALLBACK_LABELS: Record<string, string> = {
  missing_session: '回退: 未限定会话',
  embedding_not_ready: '回退: 未配置向量',
  vector_no_hits: '回退: 向量无命中',
  vector_error: '回退: 向量失败',
}

const MATCHED_BY_LABELS: Record<string, string> = {
  both: '命中: 向量+关键词',
  vector: '命中: 向量',
  keyword: '命中: 关键词',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function pushBadge(badges: string[], label?: string) {
  if (label && !badges.includes(label)) badges.push(label)
}

function collectMatchedByBadges(value: unknown, badges: string[]) {
  const items = Array.isArray(value) ? value : []
  const seen = new Set<string>()
  for (const item of items) {
    const obj = asRecord(item)
    const matchedBy = typeof obj?.matchedBy === 'string' ? obj.matchedBy : ''
    if (matchedBy) seen.add(matchedBy)
  }
  for (const key of ['both', 'vector', 'keyword']) {
    if (seen.has(key)) pushBadge(badges, MATCHED_BY_LABELS[key])
  }
}

function collectRetrievalBadges(toolName: string, output: unknown): string[] {
  if (toolName !== 'semantic_search' && toolName !== 'recall' && toolName !== 'search_messages') return []
  const obj = asRecord(output)
  if (!obj) return []
  const retrieval = asRecord(obj.retrieval)
  const badges: string[] = []
  const mode = typeof retrieval?.mode === 'string'
    ? retrieval.mode
    : typeof obj.mode === 'string'
      ? obj.mode
      : ''
  pushBadge(badges, RETRIEVAL_MODE_LABELS[mode] || (mode ? `召回: ${mode}` : undefined))
  const fallbackReason = typeof retrieval?.fallbackReason === 'string' ? retrieval.fallbackReason : ''
  pushBadge(badges, RETRIEVAL_FALLBACK_LABELS[fallbackReason])
  const rerank = asRecord(retrieval?.rerank)
  if (rerank?.applied === true) pushBadge(badges, '重排: 已应用')
  else if (rerank?.enabled === true) pushBadge(badges, '重排: 已回退')
  collectMatchedByBadges(toolName === 'recall' ? obj.memories : obj.hits, badges)
  return badges.slice(0, 5)
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

function splitMentionPrefix(text: string): { mentions: MentionTarget[]; text: string } {
  const mentions: MentionTarget[] = []
  let rest = text

  while (true) {
    const match = rest.match(/^@([^\[\]\r\n]+)\[([^\]\r\n]+)\][ \t]*/)
    if (!match) break

    const displayName = match[1].trim()
    const username = match[2].trim()
    if (!displayName || !username) break

    mentions.push(toMentionTarget(username, displayName))
    rest = rest.slice(match[0].length)
  }

  if (mentions.length === 0) return { mentions, text }
  return { mentions, text: rest.replace(/^\r?\n/, '') }
}

function getUserMessageDisplay(parts: UIMessage['parts']): {
  mentions: MentionTarget[]
  textByPartIndex: Map<number, string>
} {
  const textByPartIndex = new Map<number, string>()
  const firstTextIndex = parts.findIndex((part) => part.type === 'text')
  if (firstTextIndex < 0) return { mentions: [], textByPartIndex }

  const firstTextPart = parts[firstTextIndex] as Extract<UIMessage['parts'][number], { type: 'text' }>
  const parsed = splitMentionPrefix(firstTextPart.text || '')
  if (parsed.mentions.length > 0) textByPartIndex.set(firstTextIndex, parsed.text)
  return { mentions: parsed.mentions, textByPartIndex }
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

function UserMessageMentions({ mentions }: { mentions: MentionTarget[] }) {
  if (mentions.length === 0) return null
  return (
    <div className="ml-auto flex max-w-full flex-wrap justify-end gap-1.5">
      {mentions.map((mention) => (
        <span
          className="inline-flex max-w-72 items-center gap-1.5 rounded-full border border-border/60 bg-card/60 px-2 py-0.5 text-[11px] text-muted-foreground"
          key={mention.username}
          title={mention.displayName}
        >
          <MentionAvatar className="size-4" target={mention} />
          <span className="truncate">@{mention.displayName}</span>
        </span>
      ))}
    </div>
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
function MentionTriggerButton({ showGroupSeparator = false }: { showGroupSeparator?: boolean }) {
  const { textInput } = usePromptInputController()
  return (
    <HeroButton
      aria-label="提及联系人或群"
      isIconOnly
      onPress={() => {
        const v = textInput.value
        textInput.setInput(v && !v.endsWith(' ') && !v.endsWith('@') ? `${v} @` : `${v}@`)
      }}
      size="sm"
      variant="tertiary"
    >
      {showGroupSeparator && <ButtonGroup.Separator />}
      <AtSign className="size-3.5" />
    </HeroButton>
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
}: {
  items: SourceItem[]
  nameOf: (sessionId: string) => string
}) {
  if (items.length === 0) return null
  const senderNameOf = (item: SourceItem) => item.sender || nameOf(item.sessionId)
  return (
    <Sources>
      <SourcesTrigger count={items.length}>
        <Quote className="size-3.5" />
        <span className="font-medium">出处 {items.length} 条</span>
      </SourcesTrigger>
      <SourcesContent className="w-full flex-row flex-wrap gap-1.5">
        {items.map((it, index) => {
          const senderName = senderNameOf(it)
          return (
            <HoverCard closeDelay={80} key={it.id} openDelay={120}>
              <HoverCardTrigger asChild>
                <span className="inline-flex max-w-40 items-center gap-1 rounded-full border border-border/60 bg-card/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                  <Quote className="size-3 shrink-0 opacity-70" />
                  <span className="shrink-0">{index + 1}</span>
                  <span className="truncate">{senderName}</span>
                </span>
              </HoverCardTrigger>
              <HoverCardContent align="start" className="w-80 text-xs" side="top">
                <div className="mb-1 font-medium text-[11px] text-muted-foreground">
                  {[senderName, it.time].filter(Boolean).join(' · ')}
                </div>
                <div className="max-h-40 overflow-auto whitespace-pre-wrap text-foreground">{it.text}</div>
              </HoverCardContent>
            </HoverCard>
          )
        })}
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

function normalizeConfigText(value?: string) {
  return String(value || '').trim()
}

function normalizeConfigBaseURL(value?: string) {
  return normalizeConfigText(value).replace(/\/+$/, '')
}

function presetMatchesCurrentConfig(
  preset: configService.AiConfigPreset,
  provider: string,
  currentConfig: configService.AiProviderConfig | null,
) {
  if (!currentConfig) return false
  return preset.provider === provider
    && normalizeConfigText(preset.apiKey) === normalizeConfigText(currentConfig.apiKey)
    && normalizeConfigText(preset.model) === normalizeConfigText(currentConfig.model)
    && normalizeConfigBaseURL(preset.baseURL) === normalizeConfigBaseURL(currentConfig.baseURL)
    && normalizeConfigText(preset.protocol) === normalizeConfigText(currentConfig.protocol)
}

function resolveDefaultPresetId(
  presets: configService.AiConfigPreset[],
  provider: string,
  currentConfig: configService.AiProviderConfig | null,
  activePresetId: string,
) {
  const activePreset = presets.find((preset) => preset.id === activePresetId)
  if (activePreset && presetMatchesCurrentConfig(activePreset, provider, currentConfig)) return activePreset.id
  return presets.find((preset) => presetMatchesCurrentConfig(preset, provider, currentConfig))?.id || 'current'
}

type AgentUsage = {
  inputTokens?: number
  cacheHitRate?: number
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
  raw?: unknown
}

type AgentMessageMetadata = {
  usage?: AgentUsage
  finishReason?: string
  rawFinishReason?: string
  modelProvider?: string
  modelId?: string
  /** 计划模式生成的消息：正文是"执行计划"，前端用可折叠卡片展示（默认收起）。 */
  planMode?: boolean
  ciphertalk?: {
    subAgentProgress?: AgentProgressEvent[]
    toolElapsed?: Record<string, number>
  }
}

function isAgentProgressEvent(value: unknown): value is AgentProgressEvent {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<AgentProgressEvent>
  return typeof item.stage === 'string'
    && typeof item.title === 'string'
    && typeof item.at === 'number'
}

function readSubAgentProgressFromMessage(message: UIMessage): AgentProgressEvent[] {
  const metadata = (message as { metadata?: AgentMessageMetadata }).metadata
  const value = metadata?.ciphertalk?.subAgentProgress
  return Array.isArray(value) ? value.filter(isAgentProgressEvent) : []
}

function progressSignature(events: AgentProgressEvent[]): string {
  return JSON.stringify(events.map((event) => ({
    stage: event.stage,
    title: event.title,
    detail: event.detail,
    toolName: event.toolName,
    toolCallId: event.toolCallId,
    depth: event.depth,
    at: event.at,
  })))
}

function attachSubAgentProgressToLastAssistant(messages: UIMessage[], progress: AgentProgressEvent[]): UIMessage[] {
  if (progress.length === 0) return messages
  const targetIndex = [...messages].reverse().findIndex((message) => message.role === 'assistant')
  if (targetIndex < 0) return messages
  const index = messages.length - 1 - targetIndex
  const current = readSubAgentProgressFromMessage(messages[index])
  if (progressSignature(current) === progressSignature(progress)) return messages

  return messages.map((message, i) => {
    if (i !== index) return message
    const metadata = ((message as { metadata?: AgentMessageMetadata }).metadata || {}) as AgentMessageMetadata
    return {
      ...message,
      metadata: {
        ...metadata,
        ciphertalk: {
          ...(metadata.ciphertalk || {}),
          subAgentProgress: progress,
        },
      },
    } as UIMessage
  })
}

function readToolElapsedFromMessage(message: UIMessage): Record<string, number> {
  const value = (message as { metadata?: AgentMessageMetadata }).metadata?.ciphertalk?.toolElapsed
  if (!value || typeof value !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [key, ms] of Object.entries(value)) {
    if (typeof ms === 'number' && Number.isFinite(ms)) out[key] = ms
  }
  return out
}

function sameToolElapsed(a: Record<string, number>, b: Record<string, number>): boolean {
  const aKeys = Object.keys(a)
  if (aKeys.length !== Object.keys(b).length) return false
  return aKeys.every((key) => a[key] === b[key])
}

/** 把工具步骤耗时写进各助手消息 metadata，重开会话后思考链里的工具步骤仍显示 "· X.Xs"。 */
function attachToolElapsedToMessages(messages: UIMessage[], toolElapsedByKey: Record<string, number>): UIMessage[] {
  let changed = false
  const next = messages.map((message) => {
    if (message.role !== 'assistant') return message
    const elapsed: Record<string, number> = {}
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue
      const toolName = part.type.replace(/^tool-/, '')
      const ms = toolElapsedByKey[toolPartProgressKey(part, toolName)]
      if (typeof ms === 'number' && Number.isFinite(ms)) elapsed[toolPartProgressKey(part, toolName)] = ms
    }
    if (Object.keys(elapsed).length === 0) return message
    if (sameToolElapsed(readToolElapsedFromMessage(message), elapsed)) return message
    changed = true
    const metadata = ((message as { metadata?: AgentMessageMetadata }).metadata || {}) as AgentMessageMetadata
    return {
      ...message,
      metadata: {
        ...metadata,
        ciphertalk: {
          ...(metadata.ciphertalk || {}),
          toolElapsed: elapsed,
        },
      },
    } as UIMessage
  })
  return changed ? next : messages
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
  if (value <= 0) return '约 $0.0000'
  return `约 $${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}`
}

function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`
}

function formatFinishReason(value: string): string {
  switch (value) {
    case 'stop':
      return '正常结束'
    case 'tool-calls':
      return '工具调用'
    case 'length':
      return '长度限制'
    case 'content-filter':
      return '内容过滤'
    case 'error':
      return '出错'
    case 'other':
      return '其他'
    default:
      return value
  }
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

function estimateCacheSavings(metadata: AgentMessageMetadata, modelInfoByKey: Map<string, AIModelInfo>): number | null {
  const usage = metadata.usage
  if (!usage) return null
  const modelInfo = metadata.modelProvider && metadata.modelId
    ? modelInfoByKey.get(`${metadata.modelProvider}::${metadata.modelId}`) || modelInfoByKey.get(metadata.modelId)
    : metadata.modelId
      ? modelInfoByKey.get(metadata.modelId)
      : undefined
  const cost = modelInfo?.cost
  const inputPrice = finiteNumber(cost?.input)
  const cacheReadPrice = finiteNumber(cost?.cacheRead)
  const cacheReadTokens = finiteNumber(usage.inputTokenDetails?.cacheReadTokens)
  if (inputPrice === undefined || cacheReadPrice === undefined || cacheReadTokens === undefined || cacheReadTokens <= 0) return null
  return Math.max(0, (cacheReadTokens / 1_000_000) * (inputPrice - cacheReadPrice))
}

type UsageDetailRow = {
  id: string
  label: string
  value: ReactNode
  note?: string
}

function buildUsageDetailRows(metadata: AgentMessageMetadata, modelInfoByKey: Map<string, AIModelInfo>): UsageDetailRow[] {
  const rows: UsageDetailRow[] = []
  const usage = metadata.usage
  const add = (id: string, label: string, value: unknown, note?: string) => {
    if (value === undefined || value === null || value === '') return
    rows.push({ id, label, value: String(value), note })
  }
  const addTokens = (id: string, label: string, value: unknown, note?: string) => {
    const n = finiteNumber(value)
    if (n !== undefined) rows.push({ id, label, value: formatTokenCount(n), note })
  }

  add('model', '模型', [metadata.modelProvider, metadata.modelId].filter(Boolean).join(' / '))
  if (metadata.finishReason) add('finishReason', '结束原因', formatFinishReason(metadata.finishReason), metadata.rawFinishReason)

  addTokens('inputTokens', '输入 tokens', usage?.inputTokens)
  const cacheHitRate = finiteNumber(usage?.cacheHitRate)
    ?? (() => {
      const inputTokens = finiteNumber(usage?.inputTokens)
      const cacheReadTokens = finiteNumber(usage?.inputTokenDetails?.cacheReadTokens)
      return inputTokens && cacheReadTokens !== undefined ? cacheReadTokens / inputTokens : undefined
    })()
  if (cacheHitRate !== undefined) add('cacheHitRate', '缓存命中率', formatPercent(cacheHitRate))
  addTokens('noCacheTokens', '普通输入 tokens', usage?.inputTokenDetails?.noCacheTokens)
  addTokens('cacheReadTokens', '缓存读 tokens', usage?.inputTokenDetails?.cacheReadTokens)
  addTokens('cacheWriteTokens', '缓存写入 tokens', usage?.inputTokenDetails?.cacheWriteTokens)
  addTokens('outputTokens', '输出 tokens', usage?.outputTokens)
  addTokens('textTokens', '文本输出 tokens', usage?.outputTokenDetails?.textTokens)
  addTokens('reasoningTokens', '推理 tokens', usage?.outputTokenDetails?.reasoningTokens)
  addTokens('totalTokens', '总 tokens', usage?.totalTokens, '服务商口径，可能包含推理或额外开销')

  const estimatedCost = estimateUsageCost(metadata, modelInfoByKey)
  if (estimatedCost !== null) add('estimatedCost', '估算费用', formatEstimatedCost(estimatedCost), '按本地模型价格表估算')
  const cacheSavings = estimateCacheSavings(metadata, modelInfoByKey)
  if (cacheSavings !== null && cacheSavings > 0) add('cacheSavings', '缓存节省', formatEstimatedCost(cacheSavings), '按普通输入价与缓存读价差估算')

  if (usage?.raw) {
    rows.push({
      id: 'rawUsage',
      label: '服务商原始 usage',
      value: (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 p-2 text-[11px]">
          {JSON.stringify(usage.raw, null, 2)}
        </pre>
      ),
    })
  }

  return rows
}

function messageTextOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
    .trim()
}

function MessageUsageStats({
  canRegenerate,
  metadata,
  messageText,
  copied,
  regenerating,
  speaking,
  onCopy,
  onOpenDetails,
  onRegenerate,
  onSpeak,
}: {
  canRegenerate: boolean
  metadata: unknown
  messageText: string
  copied: boolean
  regenerating: boolean
  speaking: boolean
  onCopy: () => void
  onOpenDetails: (data: AgentMessageMetadata) => void
  onRegenerate: () => void
  onSpeak: () => void
}) {
  const parsed = parseAgentMessageMetadata(metadata)
  if (!parsed && !messageText) return null

  return (
    <div className="mt-3 border-border/60 border-t pt-2 text-[11px] leading-5 text-muted-foreground">
      <div className="flex items-center">
        <MessageActions className="shrink-0">
          <MessageAction
            disabled={!messageText}
            label="复制"
            onClick={onCopy}
            tooltip={copied ? '已复制' : '复制'}
          >
            {copied ? <CheckIcon className="size-3.5" /> : <Copy className="size-3.5" />}
          </MessageAction>
          <MessageAction
            disabled={!messageText}
            label={speaking ? '停止播放' : '播放'}
            onClick={onSpeak}
            tooltip={speaking ? '停止播放' : '播放'}
          >
            <Volume2 className={`size-3.5 ${speaking ? 'text-accent-foreground' : ''}`} />
          </MessageAction>
          <MessageAction
            disabled={!canRegenerate || regenerating}
            label="重新生成"
            onClick={onRegenerate}
            tooltip="重新生成"
          >
            <RefreshCcw className={`size-3.5 ${regenerating ? 'animate-spin' : ''}`} />
          </MessageAction>
          <MessageAction
            disabled={!parsed}
            label="详情"
            onClick={() => parsed && onOpenDetails(parsed)}
            startsGroup
            tooltip="详情"
          >
            <Info className="size-3.5" />
          </MessageAction>
        </MessageActions>
      </div>
    </div>
  )
}

function UsageDetailsModal({
  data,
  modelInfoByKey,
  onClose,
}: {
  data: AgentMessageMetadata
  modelInfoByKey: Map<string, AIModelInfo>
  onClose: () => void
}) {
  const rows = buildUsageDetailRows(data, modelInfoByKey)

  return (
    <Modal>
      <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open) onClose() }}>
        <Modal.Container className="px-3 sm:px-6" placement="center">
          <Modal.Dialog aria-label="AI 用量详情" className="w-fit! max-w-[calc(100vw-24px)]! overflow-hidden! border-0! bg-transparent! p-0! shadow-none! sm:max-w-260!">
            <Table>
              <Table.ScrollContainer className="max-h-[calc(100vh-124px)] overflow-auto">
                <Table.Content aria-label="AI 用量详情" className="min-w-150">
                  <Table.Header>
                    <Table.Column isRowHeader>项目</Table.Column>
                    <Table.Column>值</Table.Column>
                    <Table.Column>说明</Table.Column>
                  </Table.Header>
                  <Table.Body>
                    {rows.map((row) => (
                      <Table.Row id={row.id} key={row.id}>
                        <Table.Cell className="font-medium text-foreground">{row.label}</Table.Cell>
                        <Table.Cell>{row.value}</Table.Cell>
                        <Table.Cell className="text-muted-foreground">{row.note || ''}</Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Content>
              </Table.ScrollContainer>
              <Table.Footer className="justify-end">
                <HeroButton size="sm" variant="secondary" onPress={onClose}>关闭</HeroButton>
              </Table.Footer>
            </Table>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export default function AgentPage() {
  const [presets, setPresets] = useState<configService.AiConfigPreset[]>([])
  const [providersInfo, setProvidersInfo] = useState<AIProviderInfo[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('current')
  const [reasoningEffort, setReasoningEffort] = useState<AgentReasoningEffort>('auto')
  // 计划模式：开启后本轮只出执行计划、不下结论，等用户点"开始执行"再跑（参考 ClaudeCode/Codex）
  const [planMode, setPlanMode] = useState(false)
  const planModeRef = useRef(planMode)
  planModeRef.current = planMode
  // 标记当前在途的这次运行是否为计划模式（finish 前 metadata 还没回来，流式期间靠它判定计划卡片）
  const runIsPlanRef = useRef(false)
  // 联网搜索（Tavily）：全局开关，存在 config，模型自己决定何时联网；+ 菜单里快捷开关
  const [webSearchOn, setWebSearchOn] = useState(false)
  const [webSearchHasKey, setWebSearchHasKey] = useState(false)
  useEffect(() => {
    void window.electronAPI.webSearch?.getConfig().then((res) => {
      if (res.success && res.config) {
        const cfg = res.config as { enabled?: boolean; apiKey?: string }
        setWebSearchOn(Boolean(cfg.enabled))
        setWebSearchHasKey(Boolean(cfg.apiKey))
      }
    })
  }, [])
  const toggleWebSearch = useCallback(async () => {
    const next = !webSearchOn
    if (next) {
      // 重新读一遍配置，避免本次会话内刚在设置里填了 key 但缓存还是“无 key”
      const res = await window.electronAPI.webSearch?.getConfig()
      const hasKey = res?.success ? Boolean((res.config as { apiKey?: string } | undefined)?.apiKey) : webSearchHasKey
      setWebSearchHasKey(hasKey)
      if (!hasKey) {
        setAgentNotice('请先在 设置 → AI 接入 → 联网 里填写 Tavily API Key，再开启联网搜索。')
        return
      }
    }
    setWebSearchOn(next)
    void window.electronAPI.webSearch?.setConfig({ enabled: next })
  }, [webSearchOn, webSearchHasKey])
  const [currentProviderId, setCurrentProviderId] = useState('')
  const [currentModelId, setCurrentModelId] = useState('')
  const [toolElapsedByKey, setToolElapsedByKey] = useState<Record<string, number>>({})
  const [agentProgress, setAgentProgress] = useState<AgentProgressEvent[]>([])
  const [agentRunPending, setAgentRunPending] = useState(false)
  const [subAgentProgress, setSubAgentProgress] = useState<AgentProgressEvent[]>([])
  const [agentNotice, setAgentNotice] = useState('')
  const [usageDetailsModal, setUsageDetailsModal] = useState<AgentMessageMetadata | null>(null)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null)
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
      chef: '自定义',
      chefSlug: currentProviderId,
      id: 'current',
      name: currentModelId ? `自定义配置 · ${currentModelId}` : '自定义配置',
      modelDetail: currentDetail,
      disabled: currentDetail ? !currentDetail.capabilities.toolCall : false,
    }, ...list]
  }, [currentModelId, currentProviderId, presets, modelInfoByKey])
  const chefs = useMemo(() => [...new Set(models.map((model) => model.chef))], [models])
  const disabledModelKeys = useMemo(() => models.filter((model) => model.disabled).map((model) => model.id), [models])
  const selectedModelKeys = useMemo(() => new Set([selectedPresetId]), [selectedPresetId])
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
  const [sourceNameById, setSourceNameById] = useState<Record<string, string>>({})
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
  // 已"跳过"向量化提示的会话（本次运行内不再提示）
  const dismissedVecRef = useRef(new Set<string>())
  // 单个 @ → 锁定该会话 scope；多个/零个 → 全局（多个走消息注入，见 handleSubmit）
  const scopeRef = useRef<AgentScope>({ kind: 'global' })
  const submitScopeRef = useRef<AgentScope | null>(null)
  const activeScopeRef = useRef<AgentScope>({ kind: 'global' })
  scopeRef.current =
    mentions.length === 1
      ? { kind: 'session', sessionId: mentions[0].username, displayName: mentions[0].displayName }
      : { kind: 'global' }

  const handleAgentProgress = useCallback((progress: AgentProgressEvent) => {
    if ((progress.depth ?? 0) > 0) {
      setSubAgentProgress((prev) => mergeSubAgentProgress(prev, progress))
    } else {
      setAgentProgress((prev) => {
        const withoutLocalPending = prev.filter((item) => item.title !== AGENT_PENDING_TITLE)
        return mergeSubAgentProgress(withoutLocalPending, progress)
      })
      if (progress.stage === 'run_started') {
        setSubAgentProgress([])
      } else if (progress.stage === 'run_finished' || progress.stage === 'error') {
        setAgentRunPending(false)
      }
    }

    if (progress.stage === 'tool_finished' && progress.toolName && progress.elapsedMs) {
      setToolElapsedByKey((prev) => ({
        ...prev,
        [toolProgressKey(progress.toolName!, progress.toolCallId)]: progress.elapsedMs!,
      }))
    }
  }, [])

  const handleCopyAssistantMessage = useCallback(async (messageId: string, text: string) => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return
    await navigator.clipboard.writeText(text)
    setCopiedMessageId(messageId)
    window.setTimeout(() => {
      setCopiedMessageId((current) => current === messageId ? null : current)
    }, 1600)
  }, [])

  const handleSpeakAssistantMessage = useCallback((messageId: string, text: string) => {
    if (!text || typeof window === 'undefined' || !('speechSynthesis' in window)) return
    if (speakingMessageId === messageId) {
      window.speechSynthesis.cancel()
      setSpeakingMessageId(null)
      return
    }

    window.speechSynthesis.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.lang = 'zh-CN'
    utterance.onend = () => setSpeakingMessageId((current) => current === messageId ? null : current)
    utterance.onerror = () => setSpeakingMessageId((current) => current === messageId ? null : current)
    setSpeakingMessageId(messageId)
    window.speechSynthesis.speak(utterance)
  }, [speakingMessageId])

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel()
      }
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
      () => planModeRef.current,
    ),
    [handleAgentProgress]
  )
  const { messages, sendMessage, setMessages, status, stop } = useChat({ transport })
  const [modelOpen, setModelOpen] = useState(false)
  const busy = status === 'submitted' || status === 'streaming'
  const latestUserMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].role === 'user') return messages[i].id
    }
    return ''
  }, [messages])
  const shouldAnchorLatestUser = busy && !!latestUserMessageId
  const lastAssistantMessageHasDelegateTool = useMemo(() => {
    const last = messages[messages.length - 1]
    return !!last && last.role === 'assistant' && last.parts.some((part) => (
      isToolUIPart(part) && part.type.replace(/^tool-/, '') === 'delegate_analysis'
    ))
  }, [messages])
  // 本次会话累计 token 用量（各助手消息 usage 求和），供输入框底部展示
  const conversationUsage = useMemo(() => {
    let input = 0
    let output = 0
    let hasAny = false
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      const usage = parseAgentMessageMetadata(message.metadata)?.usage
      if (!usage) continue
      hasAny = true
      input += finiteNumber(usage.inputTokens) ?? 0
      output += finiteNumber(usage.outputTokens) ?? 0
    }
    return { input, output, total: input + output, hasAny }
  }, [messages])
  const showAgentProgressChain = agentProgress.length > 0
    && status !== 'streaming'
    && (status === 'submitted' || agentRunPending)
  const [conversationTitle, setConversationTitle] = useState('新对话')
  const [titleLoading, setTitleLoading] = useState(false)
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [titleSaving, setTitleSaving] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleCommitInFlightRef = useRef(false)
  const titleIgnoreBlurRef = useRef(false)
  const titleRequestSeqRef = useRef(0)
  const [recordsOpen, setRecordsOpen] = useState(false)
  const [conversationRecords, setConversationRecords] = useState<AgentConversationRecord[]>([])
  const [recordPendingDelete, setRecordPendingDelete] = useState<AgentConversationRecord | null>(null)
  const [recordDeleting, setRecordDeleting] = useState(false)

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
    setTitleEditing(false)
    setTitleDraft('')
    setTitleLoading(false)
    setToolElapsedByKey({})
    setAgentProgress([])
    setAgentRunPending(false)
    setSubAgentProgress([])
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
      setTitleEditing(false)
      setTitleDraft('')
      activeScopeRef.current = loaded.scope || { kind: 'global' }
      setMentions([])
      const restoredToolElapsed: Record<string, number> = {}
      for (const message of loaded.messages) Object.assign(restoredToolElapsed, readToolElapsedFromMessage(message))
      setToolElapsedByKey(restoredToolElapsed)
      setAgentProgress([])
      setAgentRunPending(false)
      setSubAgentProgress([])
      setAgentNotice('')
      setTitleLoading(false)
      titleRequestSeqRef.current += 1
      setRecordsOpen(false)
    })
  }, [busy, setMessages, stop])

  const handleDeleteRecord = useCallback(async (record: AgentConversationRecord) => {
    try {
      const result = await window.electronAPI.agent.deleteConversation(record.id)
      if (!result.success) {
        setAgentNotice(result.error || '删除对话失败')
        return false
      }
      setConversationRecords((prev) => prev.filter((item) => item.id !== record.id))
      if (conversationIdRef.current === record.id) {
        setMessages([])
        setConversationId(null)
        setConversationTitle('新对话')
        setTitleEditing(false)
        setTitleDraft('')
        activeScopeRef.current = { kind: 'global' }
        lastSavedMessagesRef.current = ''
        setToolElapsedByKey({})
        setAgentProgress([])
        setAgentRunPending(false)
        setSubAgentProgress([])
      }
      return true
    } catch (error) {
      setAgentNotice(error instanceof Error ? error.message : '删除对话失败')
      return false
    }
  }, [setMessages])

  const confirmDeleteRecord = useCallback(async () => {
    if (!recordPendingDelete) return
    const target = recordPendingDelete
    setRecordDeleting(true)
    const deleted = await handleDeleteRecord(target)
    setRecordDeleting(false)
    if (deleted) setRecordPendingDelete(null)
  }, [handleDeleteRecord, recordPendingDelete])

  const beginTitleEdit = useCallback(() => {
    titleRequestSeqRef.current += 1
    titleIgnoreBlurRef.current = false
    titleCommitInFlightRef.current = false
    setTitleLoading(false)
    setTitleDraft(conversationTitle)
    setTitleEditing(true)
  }, [conversationTitle])

  const cancelTitleEdit = useCallback(() => {
    titleIgnoreBlurRef.current = true
    setTitleEditing(false)
    setTitleDraft('')
  }, [])

  const commitTitleEdit = useCallback(async () => {
    if (titleCommitInFlightRef.current) return
    titleCommitInFlightRef.current = true
    const nextTitle = titleDraft.trim().slice(0, 80) || '新对话'
    const currentTitle = conversationTitle.trim() || '新对话'
    setTitleEditing(false)
    setTitleDraft('')
    if (nextTitle === currentTitle) {
      titleCommitInFlightRef.current = false
      return
    }

    setConversationTitle(nextTitle)
    const targetId = conversationIdRef.current
    if (!targetId) {
      titleCommitInFlightRef.current = false
      return
    }

    setTitleSaving(true)
    try {
      const result = await window.electronAPI.agent.renameConversation(targetId, nextTitle)
      if (result.success) {
        const record = normalizeConversationRecord(result.conversation)
        if (record) {
          setConversationRecords((prev) => prev.map((item) => item.id === record.id ? record : item))
        } else {
          void refreshConversationRecords()
        }
      } else {
        setAgentNotice(result.error || '重命名对话失败')
      }
    } finally {
      setTitleSaving(false)
      titleCommitInFlightRef.current = false
    }
  }, [conversationTitle, refreshConversationRecords, titleDraft])

  useEffect(() => {
    if (!titleEditing) return
    const timer = window.setTimeout(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [titleEditing])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [items, provider, activePresetId] = await Promise.all([
        configService.getAiConfigPresets(),
        configService.getAiProvider(),
        configService.getActiveAiConfigPresetId(),
      ])
      const currentConfig = await configService.getAiProviderConfig(provider)
      if (cancelled) return
      setPresets(items)
      setCurrentProviderId(provider)
      setCurrentModelId(currentConfig?.model || '')
      const defaultPresetId = resolveDefaultPresetId(items, provider, currentConfig, activePresetId)
      setSelectedPresetId((current) => {
        if (current !== 'current' && items.some((item) => item.id === current)) return current
        return defaultPresetId
      })
    })()
    void getAIProviders().then((items) => {
      if (!cancelled) setProvidersInfo(items)
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

  const handleSubmit = async (message: PromptInputMessage) => {
    if (busy) {
      void stop()
      setSubAgentProgress([])
      return
    }
    if (!selectedModelSupportsTools) {
      setAgentNotice('当前模型不支持工具调用，无法查询本地聊天记录。请切换到带“工具调用”能力的模型。')
      return
    }
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
    runIsPlanRef.current = planModeRef.current
    setAgentNotice('')
    setAgentProgress([{ stage: 'run_started', title: AGENT_PENDING_TITLE, detail: '正在创建会话并准备上下文', at: Date.now() }])
    setAgentRunPending(true)
    setSubAgentProgress([])

    try {
      if (!conversationIdRef.current) {
        const fallback = buildFallbackConversationTitle(firstMessageForTitle || text)
        setConversationTitle(fallback)
        await createConversation(submitScope, fallback)
      }

      if (isFirstUserMessage) generateTitleFromFirstMessage(firstMessageForTitle || text)

      const sendPromise = Promise.resolve(sendMessage({ text, files: message.files })).finally(() => {
        submitScopeRef.current = null
        setAgentRunPending(false)
      })
      void sendPromise
      setMentions([])
    } catch (error) {
      submitScopeRef.current = null
      setAgentRunPending(false)
      throw error
    }
  }

  const handleRegenerateAssistantMessage = useCallback((messageIndex: number) => {
    if (busy || !selectedModelSupportsTools) return
    const userIndex = (() => {
      for (let index = messageIndex - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') return index
      }
      return -1
    })()
    if (userIndex < 0) return

    const userMessage = messages[userIndex]
    const text = messageTextOf(userMessage)
    const files = userMessage.parts.filter((part): part is Extract<UIMessage['parts'][number], { type: 'file' }> => part.type === 'file')
    if (!text && files.length === 0) return

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel()
      setSpeakingMessageId(null)
    }
    setAgentNotice('')
    setAgentProgress([{ stage: 'run_started', title: AGENT_PENDING_TITLE, detail: '正在重新生成回答', at: Date.now() }])
    setAgentRunPending(true)
    setSubAgentProgress([])
    runIsPlanRef.current = planModeRef.current
    submitScopeRef.current = activeScopeRef.current
    setMessages(messages.slice(0, userIndex))

    const sendPromise = Promise.resolve(sendMessage({ text, files })).finally(() => {
      submitScopeRef.current = null
      setAgentRunPending(false)
    })
    void sendPromise
  }, [busy, messages, selectedModelSupportsTools, sendMessage, setMessages])

  // 计划模式确认：关闭计划模式并让 Agent 按上一条计划开始执行（沿用当前会话 scope）
  const handleExecutePlan = useCallback(() => {
    if (busy || !selectedModelSupportsTools) return
    planModeRef.current = false
    runIsPlanRef.current = false
    setPlanMode(false)
    setAgentNotice('')
    setAgentProgress([{ stage: 'run_started', title: AGENT_PENDING_TITLE, detail: '正在按计划执行', at: Date.now() }])
    setAgentRunPending(true)
    setSubAgentProgress([])
    submitScopeRef.current = activeScopeRef.current
    const sendPromise = Promise.resolve(sendMessage({ text: '请按上面的计划开始执行，按需调用工具或委托子助手，直接给出最终结果，不要再重复计划。', files: [] })).finally(() => {
      submitScopeRef.current = null
      setAgentRunPending(false)
    })
    void sendPromise
  }, [busy, selectedModelSupportsTools, sendMessage])

  const handleModelSelect = useCallback((id: string) => {
    if (models.find((model) => model.id === id)?.disabled) return
    setSelectedPresetId(id)
    setModelOpen(false)
  }, [models])

  const lastSavedMessagesRef = useRef('')
  useEffect(() => {
    if (busy || !conversationId || messages.length === 0) return
    const messagesWithSubAgentProgress = attachSubAgentProgressToLastAssistant(messages, subAgentProgress)
    if (messagesWithSubAgentProgress !== messages) {
      setMessages(messagesWithSubAgentProgress)
      return
    }
    const messagesWithToolElapsed = attachToolElapsedToMessages(messagesWithSubAgentProgress, toolElapsedByKey)
    if (messagesWithToolElapsed !== messagesWithSubAgentProgress) {
      setMessages(messagesWithToolElapsed)
      return
    }
    let signature = ''
    try {
      signature = JSON.stringify(messagesWithToolElapsed)
    } catch {
      signature = `${messagesWithToolElapsed.length}:${Date.now()}`
    }
    if (signature === lastSavedMessagesRef.current) return
    lastSavedMessagesRef.current = signature
    void persistConversationMessages(conversationId, messagesWithToolElapsed, activeScopeRef.current)
  }, [busy, conversationId, messages, persistConversationMessages, setMessages, subAgentProgress, toolElapsedByKey])

  // 出处：会话名解析
  const sessionNameMap = useMemo(() => new Map(sessions.map((s) => [s.username, s.displayName])), [sessions])
  const sourceSessionIdKey = useMemo(() => {
    const ids = new Set<string>()
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (const source of extractSources(message.parts)) ids.add(source.sessionId)
    }
    return Array.from(ids).sort().join('\n')
  }, [messages])
  useEffect(() => {
    const ids = sourceSessionIdKey.split('\n').filter(Boolean)
    const missing = ids.filter((id) => !sessionNameMap.has(id) && !sourceNameById[id])
    if (missing.length === 0) return

    let cancelled = false
    void (async () => {
      try {
        await window.electronAPI.chat.connect?.()
      } catch {
        // 未连接时仍尝试走头像/联系人查询兜底。
      }
      return Promise.all(
        missing.map(async (id) => {
          try {
            const result = await window.electronAPI.chat.getContactAvatar(id)
            return [id, result?.displayName || id] as const
          } catch {
            return [id, id] as const
          }
        })
      )
    })().then((entries) => {
      if (cancelled) return
      setSourceNameById((prev) => {
        const next = { ...prev }
        for (const [id, displayName] of entries) next[id] = displayName
        return next
      })
    })

    return () => {
      cancelled = true
    }
  }, [sessionNameMap, sourceNameById, sourceSessionIdKey])
  const sessionNameOf = useCallback((sessionId: string) => (
    sessionNameMap.get(sessionId) || sourceNameById[sessionId] || sessionId
  ), [sessionNameMap, sourceNameById])

  return (
    <Surface
      className="flex h-full min-h-0 flex-col"
      style={{ '--agent-radius': '12px' } as CSSProperties}
      variant="transparent"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-border/60 px-4">
        <div className="min-w-0 flex-1 pr-3">
          {titleEditing ? (
            <input
              aria-label="编辑对话名称"
              className="h-8 w-full max-w-90 rounded-(--agent-radius,12px) border border-border bg-background px-2 font-medium text-foreground text-sm outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/30"
              disabled={titleSaving}
              onBlur={() => {
                if (titleIgnoreBlurRef.current) {
                  titleIgnoreBlurRef.current = false
                  return
                }
                void commitTitleEdit()
              }}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void commitTitleEdit()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelTitleEdit()
                }
              }}
              ref={titleInputRef}
              value={titleDraft}
            />
          ) : (
            <button
              className="group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-(--agent-radius,12px) px-1 py-1 text-left hover:bg-accent/40"
              onClick={beginTitleEdit}
              title="编辑对话名称"
              type="button"
            >
              <span className="truncate font-medium text-sm text-foreground">
                {titleSaving ? '保存中...' : titleLoading ? '生成标题中...' : conversationTitle}
              </span>
              <PenLine className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          )}
        </div>
        <div className="relative">
          <Toolbar aria-label="对话操作" className="p-0">
            <ButtonGroup size="sm" variant="tertiary">
              <Dropdown isOpen={recordsOpen} onOpenChange={setRecordsOpen}>
                <HeroButton
                  aria-label="对话记录"
                  className="size-8 p-0"
                  isIconOnly
                  size="sm"
                  variant="tertiary"
                >
                  <History className="size-4" />
                </HeroButton>
                <Dropdown.Popover className="w-[min(28rem,calc(100vw-2rem))]" placement="bottom end">
                  <Dropdown.Menu
                    disabledKeys={conversationRecords.length > 0 ? undefined : ['empty-conversation-records']}
                    selectedKeys={conversationId ? [conversationId] : []}
                    selectionMode="single"
                    className="max-h-[min(70vh,32rem)] overflow-y-auto"
                    onAction={(key) => {
                      const record = conversationRecords.find((item) => String(item.id) === String(key))
                      if (record) handleOpenRecord(record)
                    }}
                  >
                    {conversationRecords.length > 0 ? conversationRecords.map((record) => {
                      return (
                        <Dropdown.Item
                          className="min-h-14 gap-3 py-2.5"
                          id={record.id}
                          key={record.id}
                          textValue={record.title}
                        >
                          <Dropdown.ItemIndicator />
                          <Clock3 className="size-4 shrink-0 text-muted" />
                          <span className="min-w-0 flex-1">
                            <Label className="block truncate font-medium text-sm">{record.title}</Label>
                            <span className="block truncate text-muted-foreground text-xs">
                              {new Date(record.updatedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </span>
                          <span
                            className="ms-auto flex shrink-0"
                            onClick={(event) => event.stopPropagation()}
                            onMouseDown={(event) => event.stopPropagation()}
                            onPointerDown={(event) => event.stopPropagation()}
                          >
                            <HeroButton
                              aria-label={`删除 ${record.title}`}
                              className="size-8 p-0 text-muted-foreground hover:text-danger"
                              isIconOnly
                              size="sm"
                              variant="ghost"
                              onPress={() => {
                                setRecordPendingDelete(record)
                                setRecordsOpen(false)
                              }}
                            >
                              <Trash2 className="size-4" />
                            </HeroButton>
                          </span>
                        </Dropdown.Item>
                      )
                    }) : (
                      <Dropdown.Item
                        className="min-h-20 justify-center py-6 text-center text-muted-foreground text-sm"
                        id="empty-conversation-records"
                        key="empty-conversation-records"
                        textValue="暂无对话记录"
                      >
                        暂无对话记录
                      </Dropdown.Item>
                    )}
                  </Dropdown.Menu>
                </Dropdown.Popover>
              </Dropdown>
              <HeroButton
                aria-label="新建对话"
                className="size-8 p-0"
                isIconOnly
                onPress={handleNewConversation}
              >
                <ButtonGroup.Separator />
                <SquarePen className="size-4" />
              </HeroButton>
            </ButtonGroup>
          </Toolbar>
        </div>
      </div>
      <Conversation className="min-h-0 flex-1">
        <ConversationAutoScroll enabled={shouldAnchorLatestUser} trigger={latestUserMessageId} />
        <ConversationContent className="mx-auto w-full min-w-80 max-w-[82%] pt-4 pb-12">
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
              const assistantText = message.role === 'assistant' ? messageTextOf(message) : ''
              const assistantTextStreaming = message.role === 'assistant' && isLastMessage && status === 'streaming'
              // 计划模式生成的消息：正文(执行计划)走 PlanCard 折叠卡片，不再走普通 Markdown 渲染。
              // 完成后看 metadata.planMode；流式期间 metadata 还没回来，靠在途标记 runIsPlanRef 判定。
              const isPlanMessage = message.role === 'assistant' && (
                (message.metadata as AgentMessageMetadata | undefined)?.planMode === true
                || (isLastMessage && busy && runIsPlanRef.current)
              )
              const assistantDisplayText = isPlanMessage ? stripPlanControlMarkers(assistantText) : assistantText
              const planNeedsDelegateAnalysis = isPlanMessage && planRequiresDelegateAnalysis(assistantText)
              const outputActivity = message.role === 'assistant'
                ? analyzeMessageRenderActivity(assistantDisplayText, assistantTextStreaming)
                : null
              const outputActivitySteps = outputActivity ? renderOutputActivitySteps(outputActivity, assistantTextStreaming) : []
              const userDisplay = message.role === 'user' ? getUserMessageDisplay(message.parts) : null
              const persistedSubAgentEvents = message.role === 'assistant' ? readSubAgentProgressFromMessage(message) : []
              const subAgentEventsForMessage = message.role === 'assistant'
                ? (isLastMessage && subAgentProgress.length > 0 ? subAgentProgress : persistedSubAgentEvents)
                : []
              return (
                <Message from={message.role} key={message.id}>
                  {userDisplay && <UserMessageMentions mentions={userDisplay.mentions} />}
                  <MessageContent>
                    {(chainParts.length > 0 || outputActivitySteps.length > 0) && (
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
                          const delegateTask = toolName === 'delegate_analysis' ? getDelegateTask(part) : undefined
                          if (part.state === 'output-available') {
                            for (const badge of collectRetrievalBadges(toolName, part.output)) pushBadge(badges, badge)
                            collectToolBadges(part.output, badges)
                          }
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
                              {toolName === 'delegate_analysis' && subAgentEventsForMessage.length > 0 && (
                                <SubAgentProgressPanel events={subAgentEventsForMessage} task={delegateTask} />
                              )}
                            </ChainOfThoughtStep>
                          )
                        })}
                        {outputActivitySteps.map((step) => {
                          const Icon = step.icon
                          return (
                            <ChainOfThoughtStep
                              icon={Icon}
                              key={`output-${step.key}`}
                              label={renderChainLabel(step.active ? step.label : step.doneLabel, step.active)}
                              status={step.active ? 'active' : 'complete'}
                            />
                          )
                        })}
                      </MessageChainOfThought>
                    )}
                    {isPlanMessage && assistantDisplayText && (
                      <PlanCard streaming={assistantTextStreaming} text={assistantDisplayText} />
                    )}
                    {message.parts.map((part, index) => {
                      if (part.type === 'text') {
                        // 计划消息的正文已经在 PlanCard 里展示，这里不再重复渲染。
                        if (isPlanMessage) return null
                        const displayText = userDisplay?.textByPartIndex.get(index) ?? part.text
                        if (!displayText && !assistantTextStreaming) return null
                        return (
                          <MessageResponse isStreaming={assistantTextStreaming} key={`text-${index}`}>
                            {displayText}
                          </MessageResponse>
                        )
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
                      <MessageSources items={extractSources(message.parts)} nameOf={sessionNameOf} />
                    )}
                    {message.role === 'assistant' && (
                      <MessageUsageStats
                        canRegenerate={selectedModelSupportsTools}
                        copied={copiedMessageId === message.id}
                        metadata={message.metadata}
                        messageText={assistantDisplayText}
                        onCopy={() => { void handleCopyAssistantMessage(message.id, assistantDisplayText) }}
                        onOpenDetails={setUsageDetailsModal}
                        onRegenerate={() => handleRegenerateAssistantMessage(messageIndex)}
                        onSpeak={() => handleSpeakAssistantMessage(message.id, assistantDisplayText)}
                        regenerating={busy}
                        speaking={speakingMessageId === message.id}
                      />
                    )}
                    {isPlanMessage && isLastMessage && !busy && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <HeroButton
                          isDisabled={!selectedModelSupportsTools}
                          onPress={handleExecutePlan}
                          size="sm"
                          variant="primary"
                        >
                          <Play className="size-3.5" />
                          开始执行
                        </HeroButton>
                        {planNeedsDelegateAnalysis && (
                          <span className="inline-flex items-center gap-1 rounded-(--agent-radius,12px) border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-700 text-xs dark:text-amber-300">
                            <Users className="size-3.5" />
                            预计会委托子助手
                          </span>
                        )}
                        <span className="text-muted-foreground text-xs">确认计划后点此执行，或直接回复修改计划</span>
                      </div>
                    )}
                  </MessageContent>
                </Message>
              )
            })
          )}
          {showAgentProgressChain && (
            <Message from="assistant">
              <MessageContent>
                <AgentProgressChain active={status === 'submitted' || agentRunPending} events={agentProgress} />
              </MessageContent>
            </Message>
          )}
          {agentNotice && (
            <div className="mt-3 rounded-(--agent-radius,12px) border border-destructive/30 bg-destructive/5 px-3 py-2 text-destructive text-xs">
              {agentNotice}
            </div>
          )}
          {busy && subAgentProgress.length > 0 && !lastAssistantMessageHasDelegateTool && <SubAgentProgressPanel events={subAgentProgress} />}
          {status === 'submitted' && agentProgress.length === 0 && <Loader />}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="shrink-0 pt-2 pb-4">
        <PromptInputProvider>
          <PromptInput
            accept="image/*,.txt,.md,.json,.csv"
            className="mx-auto mb-2 w-full min-w-80 max-w-[82%] **:data-[slot=input-group]:rounded-(--agent-radius,12px) **:data-[slot=input-group]:border-border **:data-[slot=input-group]:bg-surface **:data-[slot=input-group]:shadow-xs"
            maxFiles={6}
            maxFileSize={8 * 1024 * 1024}
            multiple
            onSubmit={handleSubmit}
            style={{ '--agent-radius': '22px' } as CSSProperties}
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
              {mentions.length === 1 && (
                <SessionVectorizePrompt session={mentions[0]} dismissed={dismissedVecRef} />
              )}
              <PromptInputAttachments className="p-0">
                {(attachment) => <PromptInputAttachment data={attachment} />}
              </PromptInputAttachments>
            </PromptInputHeader>

            <PromptInputBody>
              <PromptInputTextarea placeholder="问问你的聊天记录，Enter 发送，Shift + Enter 换行…" />
            </PromptInputBody>

            <PromptInputFooter>
              <PromptInputTools className="flex-wrap gap-2">
                <ButtonGroup size="sm" variant="tertiary">
                  <PromptInputActionMenu>
                    <PromptInputActionMenuTrigger aria-label="更多输入操作" variant="tertiary" />
                    <PromptInputActionMenuContent>
                      <PromptInputActionAddAttachments label="添加图片或文件" />
                      <Dropdown.Item
                        id="plan-mode"
                        textValue="计划模式"
                        onAction={() => setPlanMode((value) => !value)}
                      >
                        <ListChecks className="size-4 shrink-0 text-muted" />
                        <Label>计划模式</Label>
                        <span className="ml-auto inline-flex pointer-events-none">
                          <Switch aria-label="计划模式" isSelected={planMode}>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                          </Switch>
                        </span>
                      </Dropdown.Item>
                      <Dropdown.Item
                        id="web-search"
                        textValue="联网搜索"
                        onAction={toggleWebSearch}
                      >
                        <Globe className="size-4 shrink-0 text-muted" />
                        <Label>联网搜索</Label>
                        <span className="ml-auto inline-flex pointer-events-none">
                          <Switch aria-label="联网搜索" isSelected={webSearchOn}>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                          </Switch>
                        </span>
                      </Dropdown.Item>
                    </PromptInputActionMenuContent>
                  </PromptInputActionMenu>
                  <SlashPresetButton showGroupSeparator />
                  <MentionTriggerButton showGroupSeparator />
                  <PromptInputSpeechButton aria-label="语音输入" language="zh-CN" showGroupSeparator variant="tertiary" />
                </ButtonGroup>

                {planMode && (
                  <HeroButton
                    aria-label="关闭计划模式"
                    className="gap-1"
                    onPress={() => setPlanMode(false)}
                    size="sm"
                    variant="secondary"
                  >
                    <ListChecks className="size-3.5" />
                    计划模式
                    <X className="size-3" />
                  </HeroButton>
                )}

                {webSearchOn && (
                  <HeroButton
                    aria-label="关闭联网搜索"
                    className="gap-1"
                    onPress={toggleWebSearch}
                    size="sm"
                    variant="secondary"
                  >
                    <Globe className="size-3.5" />
                    联网搜索
                    <X className="size-3" />
                  </HeroButton>
                )}

                <Separator orientation="vertical" variant="tertiary" />

                <ButtonGroup size="sm" variant="tertiary">
                  <Dropdown>
                    <HeroButton aria-label="思考程度" size="sm" variant="tertiary">
                      <Brain className="size-3.5" />
                      {REASONING_EFFORT_OPTIONS.find((option) => option.value === reasoningEffort)?.label ?? '思考：自动'}
                      <ChevronDown className="size-3.5" />
                    </HeroButton>
                    <Dropdown.Popover placement="top start">
                      <Dropdown.Menu
                        selectedKeys={new Set([reasoningEffort])}
                        selectionMode="single"
                        onAction={(key) => setReasoningEffort(key as AgentReasoningEffort)}
                      >
                        {REASONING_EFFORT_OPTIONS.map((option) => (
                          <Dropdown.Item id={option.value} key={option.value} textValue={option.label}>
                            <Dropdown.ItemIndicator />
                            <Label>{option.label}</Label>
                          </Dropdown.Item>
                        ))}
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                </ButtonGroup>

                <ButtonGroup size="sm" variant="tertiary">
                  <Dropdown isOpen={modelOpen} onOpenChange={setModelOpen}>
                    <HeroButton aria-label="选择模型" className="max-w-56" size="sm" variant="tertiary">
                      {selectedModelData?.chefSlug && (
                        <AIProviderLogo providerId={selectedModelData.chefSlug} alt={selectedModelData.chef} className="shrink-0" size={18} />
                      )}
                      {selectedModelData?.name && (
                        <span className="min-w-0 flex-1 truncate text-left">{selectedModelData.name}</span>
                      )}
                      <ChevronDown className="size-3.5 shrink-0" />
                    </HeroButton>
                    <Dropdown.Popover className="max-h-96 min-w-72 overflow-y-auto" placement="top start">
                      <Dropdown.Menu
                        disabledKeys={disabledModelKeys}
                        selectedKeys={selectedModelKeys}
                        selectionMode="single"
                        onAction={(key) => handleModelSelect(String(key))}
                      >
                        {chefs.map((chef) => (
                          <Dropdown.Section key={chef}>
                            <Header>{chef}</Header>
                            {models
                              .filter((model) => model.chef === chef)
                              .map((model) => (
                                <ModelItem key={model.id} model={model} />
                              ))}
                          </Dropdown.Section>
                        ))}
                      </Dropdown.Menu>
                    </Dropdown.Popover>
                  </Dropdown>
                </ButtonGroup>

              </PromptInputTools>

              <ButtonGroup size="sm">
                <AgentPromptSubmit busy={busy} status={status} />
              </ButtonGroup>
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
        {conversationUsage.hasAny && (
          <div className="mx-auto mb-1 flex w-full min-w-80 max-w-[82%] flex-wrap items-center justify-end gap-x-3 gap-y-0.5 px-2 text-[11px] text-muted-foreground">
            <span>本次会话Token用量</span>
            <span>输入 {formatTokenCount(conversationUsage.input)}</span>
            <span>输出 {formatTokenCount(conversationUsage.output)}</span>
            <span className="font-medium text-foreground/80">共 {formatTokenCount(conversationUsage.total)}</span>
          </div>
        )}
      </div>
      {usageDetailsModal !== null && (
        <UsageDetailsModal
          data={usageDetailsModal}
          modelInfoByKey={modelInfoByKey}
          onClose={() => setUsageDetailsModal(null)}
        />
      )}
      <AlertDialog.Backdrop
        isOpen={recordPendingDelete !== null}
        onOpenChange={(open) => {
          if (!open && !recordDeleting) setRecordPendingDelete(null)
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-100">
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger">
                <Trash2 className="size-5" />
              </AlertDialog.Icon>
              <AlertDialog.Heading>删除这条对话记录？</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p>删除后无法恢复。</p>
              {recordPendingDelete && (
                <p className="mt-2 truncate font-medium text-foreground">{recordPendingDelete.title}</p>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <HeroButton
                isDisabled={recordDeleting}
                variant="tertiary"
                onPress={() => setRecordPendingDelete(null)}
              >
                取消
              </HeroButton>
              <HeroButton isDisabled={recordDeleting} variant="danger" onPress={confirmDeleteRecord}>
                {recordDeleting ? '删除中...' : '删除'}
              </HeroButton>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </Surface>
  )
}
