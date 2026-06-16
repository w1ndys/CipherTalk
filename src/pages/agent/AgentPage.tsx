/**
 * AI Agent 对话页（Phase C）——使用 AI SDK 的 useChat + AI Elements 组件。
 * 数据：useChat 走 IpcChatTransport（IPC → AI 子进程 → 流式 UIMessageChunk）。
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode, type UIEvent } from 'react'
import { useChat } from '@ai-sdk/react'
import { isToolUIPart, type ChatStatus, type UIMessage } from 'ai'
import { AlertDialog, Button as HeroButton, ButtonGroup, Dropdown, Header, Input, Label, Modal, Separator, Surface, Switch, Table, TextField, Toolbar, Tooltip } from '@heroui/react'
import { AtSign, BarChart3, Braces, Brain, CheckIcon, ChevronDown, Clock3, Code2, Copy, FileText, Globe, Hand, History, Image as ImageIcon, Info, Link2, ListChecks, Monitor, PanelLeft, PenLine, Play, Quote, RefreshCcw, Search, ShieldAlert, ShieldCheck, Slash, SquarePen, Table2, Terminal, Trash2, Users, Volume2, Wrench, X, Sparkles, type LucideIcon } from 'lucide-react'
import { Sources, SourcesContent, SourcesTrigger } from '@/components/ai-elements/sources'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import {
  Conversation,
  ConversationAutoScroll,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { analyzeMessageRenderActivity, Message, MessageAction, MessageActions, MessageAttachment, MessageAttachments, MessageContent, MessageResponse, MessageStreamingIndicator, type MessageRenderActivity } from '@/components/ai-elements/message'
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
import { ImagePreview, type ImagePreviewOriginRect } from '@/components/ImagePreview'
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
import { IpcChatTransport, type AgentModelConfig, type AgentProgressEvent, type AgentReasoningEffort, type AgentScope, type AgentToolProfile, type CodeWorkspaceRef } from '@/features/aiagent/transport/ipcChatTransport'
import { CODE_WORKSPACE_FILE_REF_MIME, CodeWorkspacePanel, CodeWorkspacePanelPopover, CodeWorkspaceSidebar, type CodeWorkspaceFileDragReference, type CodeWorkspacePanelTab } from './CodeWorkspacePanel'
import * as configService from '@/services/config'
import { useTtsSpeaker } from '@/lib/ttsPlayer'
import type { CodeWorkspaceApprovalPolicy, CodeWorkspaceApprovalRequest, CodeWorkspaceEvent, CodeWorkspaceState } from '@/types/electron'

// 提示词预设：按 AI 助手的工具能力分组；需要限定联系人或群时，用户可在正文光标处用 @ 插入。
const PROMPT_PRESET_GROUPS = [
  {
    group: '回顾总结',
    presets: [
      {
        label: '最近聊了什么',
        text: `请基于我最近一周的聊天记录，做一份结构化回顾。

要求：
1. 按主题归纳主要讨论内容，每个主题说明涉及对象、时间范围和关键结论。
2. 标出重要事项、待办、承诺、风险或情绪变化。
3. 给出 3-5 条值得我优先关注的后续行动。
4. 引用关键原话或聊天片段作为依据，不要凭空推断。
5. 如果数据不足，请说明缺口和你需要我补充的信息。`,
        icon: Clock3,
      },
      {
        label: '总结和某人的聊天',
        text: `请先用 @ 提及要总结的联系人或群，然后总结最近一个月我和该对象的聊天记录，输出一份关系与事项复盘。

要求：
1. 按时间线概括重要互动，并标出转折点。
2. 归纳主要话题、反复出现的诉求、共同关注点和未解决事项。
3. 分析交流氛围与情绪变化，但要区分“有证据的判断”和“可能的推测”。
4. 列出对方明确表达过的需求、偏好或边界。
5. 最后给出我下一步可以怎么回复或跟进的建议，并附关键证据。`,
        icon: Users,
      },
      {
        label: '回顾某天的聊天',
        text: `请回顾指定日期这一天的聊天记录，按时间顺序整理成一份日程式摘要。

日期：请在这里填写具体日期，例如 2026-06-15

要求：
1. 分上午、下午、晚上或按真实时间段梳理发生了什么。
2. 对每段聊天说明对象、主题、结论和需要跟进的事项。
3. 标出重要原话、文件、图片、链接或决定。
4. 单独列出当天最重要的 3 件事。
5. 如果某些记录缺少上下文，请明确说明。`,
        icon: History,
      },
    ],
  },
  {
    group: '查找核对',
    presets: [
      {
        label: '找相关记录',
        text: `请在我的聊天记录里检索下面这个目标，并做相关性排序。

检索目标：请在这里写关键词、事件，或用 @ 提及对象

要求：
1. 同时检索精确关键词和语义相关表达，不要只做字面匹配。
2. 每条结果给出时间、聊天对象或群、摘要、相关原因和关键原话。
3. 将结果分为“高度相关 / 可能相关 / 背景资料”。
4. 如果存在多个同名对象或歧义，请先列出歧义并说明你如何判断。
5. 最后总结这件事目前可确认的事实和仍不确定的信息。`,
        icon: Search,
      },
      {
        label: '查证某件事',
        text: `请帮我核对下面这件事在聊天记录中的来源和上下文。

核对事项：请在这里写要查证的事件、说法或关键词

要求：
1. 找出最早出现、最明确表述和后续确认或反驳的记录。
2. 给出是谁、在什么时间、在哪个聊天里说的。
3. 引用关键原话，并解释前后文语境。
4. 区分事实、转述、猜测、玩笑或情绪表达。
5. 最后给出可信度判断，以及还需要哪些证据才能确认。`,
        icon: Quote,
      },
      {
        label: '找某个主题',
        text: `请找出聊天记录中所有与下面主题相关的内容，并做主题化整理。

主题：请在这里写主题、别称或相关关键词

要求：
1. 不限于关键词命中，请包含语义相关、别称、缩写和上下文暗示。
2. 按子主题归类，每类说明代表性记录、参与对象和时间范围。
3. 标出高频观点、分歧点、重复出现的问题和已达成的结论。
4. 用时间线补充这个主题的发展变化。
5. 最后输出一份可复用的主题摘要和关键证据列表。`,
        icon: Link2,
      },
    ],
  },
  {
    group: '统计图表',
    presets: [
      {
        label: '统计高频联系人',
        text: `请统计最近一个月我互动最多的联系人，并给出可解释的分析。

要求：
1. 分别统计消息数量、互动天数、最近一次互动时间和主要互动时段。
2. 区分私聊和群聊中的直接互动，避免把群聊噪声误判为关系强度。
3. 给出 Top 10 排名，并说明每个人的主要聊天主题。
4. 分析互动高峰、异常变化和可能原因。
5. 如适合，请用表格或图表展示，并说明统计口径。`,
        icon: BarChart3,
      },
      {
        label: '群活跃排行',
        text: `请先用 @ 提及要统计的群，然后统计这个群最近一个月的发言活跃度，并生成一份群活跃分析。

要求：
1. 输出发言 Top 10 成员，包含消息数、占比、活跃天数和典型活跃时段。
2. 识别群内主要话题、关键推动者和沉默但被频繁提及的人。
3. 分析活跃度峰值对应的事件或讨论。
4. 用图表展示排行和趋势，并说明统计口径。
5. 避免把表情、撤回、系统消息等无效内容计入核心分析。`,
        icon: Table2,
      },
      {
        label: '聊天量趋势',
        text: `请统计最近三个月我每周的消息收发量，并分析趋势变化。

要求：
1. 按周输出发送量、接收量、总量和环比变化。
2. 标出异常峰值或低谷，并尝试结合聊天内容解释原因。
3. 区分私聊、群聊和朋友圈相关互动（如果数据支持）。
4. 用折线图或柱状图展示趋势，并给出简短结论。
5. 最后总结我的沟通节奏变化和可能需要关注的信号。`,
        icon: RefreshCcw,
      },
    ],
  },
  {
    group: '朋友圈',
    presets: [
      {
        label: '翻某人朋友圈',
        text: `请先用 @ 提及要查看的联系人，然后整理 TA 最近半年发布的朋友圈内容，做一份内容与状态观察。

要求：
1. 按时间线列出主要动态，概括每条的主题、情绪和可能背景。
2. 归纳 TA 最近关注的人、事、地点、兴趣或生活变化。
3. 标出互动较多或信息量较高的动态。
4. 分析时必须基于可见内容，避免过度解读隐私或动机。
5. 最后给出一份简短画像和我适合如何开启话题的建议。`,
        icon: SquarePen,
      },
      {
        label: '朋友圈之最',
        text: `请统计最近半年朋友圈相关数据，输出一份“朋友圈之最”分析。

要求：
1. 统计发布最多、互动最多、点赞或评论最多、最常出现主题等榜单。
2. 对每个榜单说明统计口径和时间范围。
3. 识别异常高互动内容，并总结可能原因。
4. 用表格或图表展示关键排行。
5. 最后给出我社交圈近期关注点和互动结构的总结。`,
        icon: ListChecks,
      },
    ],
  },
  {
    group: '记忆',
    presets: [
      {
        label: '你记住了什么',
        text: `请审计你目前保存的关于我的长期记忆，并输出一份可校对清单。

要求：
1. 按身份信息、偏好、关系、习惯、长期目标、重要事件等类别整理。
2. 每条记忆标注来源依据、置信度和可能过期风险。
3. 找出互相矛盾、含糊、过时或不应继续保留的记忆。
4. 对每条可疑记忆给出建议：保留、修改、删除或需要我确认。
5. 最后列出你还缺少哪些高价值信息，但不要主动编造。`,
        icon: Brain,
      },
    ],
  },
]

const REASONING_EFFORT_OPTIONS: Array<{ value: AgentReasoningEffort; label: string }> = [
  { value: 'auto', label: '思考：自动' },
  { value: 'minimal', label: '思考：最少' },
  { value: 'low', label: '思考：低' },
  { value: 'medium', label: '思考：中' },
  { value: 'high', label: '思考：高' },
]

const CODE_WORKSPACE_APPROVAL_POLICY_OPTIONS: Array<{
  value: CodeWorkspaceApprovalPolicy
  label: string
  description: string
  icon: LucideIcon
}> = [
  {
    value: 'on-request',
    label: '请求批准',
    description: '读敏感文件、编辑文件和运行命令时始终询问',
    icon: Hand,
  },
  {
    value: 'risk-based',
    label: '替我审批',
    description: '仅对高风险操作请求批准',
    icon: ShieldAlert,
  },
  {
    value: 'full-access',
    label: '完全访问',
    description: '代码工作区内不再请求批准',
    icon: ShieldCheck,
  },
]

function reasoningEffortLabel(value: AgentReasoningEffort, compact = false): string {
  const label = REASONING_EFFORT_OPTIONS.find((option) => option.value === value)?.label ?? '思考：自动'
  return compact ? label.replace(/^思考：/, '') : label
}

function codeWorkspaceApprovalPolicyOption(policy?: CodeWorkspaceApprovalPolicy) {
  return CODE_WORKSPACE_APPROVAL_POLICY_OPTIONS.find((option) => option.value === policy)
    ?? CODE_WORKSPACE_APPROVAL_POLICY_OPTIONS[0]
}

function codeWorkspaceApprovalPolicyToneClass(policy?: CodeWorkspaceApprovalPolicy) {
  if (policy === 'risk-based') return 'text-blue-600 dark:text-blue-300'
  if (policy === 'full-access') return 'text-amber-600 dark:text-amber-300'
  return ''
}

function CodeWorkspaceApprovalPolicyDropdown({
  policy,
  onChange,
}: {
  policy: CodeWorkspaceApprovalPolicy
  onChange: (policy: CodeWorkspaceApprovalPolicy) => void
}) {
  const current = codeWorkspaceApprovalPolicyOption(policy)
  const CurrentIcon = current.icon
  const currentToneClass = codeWorkspaceApprovalPolicyToneClass(current.value)

  return (
    <Dropdown>
      <HeroButton
        aria-label="设置代码工作区权限"
        className={`gap-1 ${currentToneClass}`}
        size="sm"
        variant="tertiary"
      >
        <CurrentIcon className="size-3.5 shrink-0" />
        <span className="max-w-24 truncate">{current.label}</span>
        <ChevronDown className="size-3 shrink-0" />
      </HeroButton>
      <Dropdown.Popover className="w-80 max-w-[calc(100vw-2rem)]" placement="top start">
        <div className="border-border/70 border-b px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-sm">如何批准代码操作？</Label>
            <span className="text-muted-foreground text-xs">同步到微信</span>
          </div>
        </div>
        <Dropdown.Menu
          selectedKeys={new Set([current.value])}
          selectionMode="single"
          onAction={(key) => onChange(String(key) as CodeWorkspaceApprovalPolicy)}
        >
          {CODE_WORKSPACE_APPROVAL_POLICY_OPTIONS.map((option) => {
            const Icon = option.icon
            const toneClass = codeWorkspaceApprovalPolicyToneClass(option.value)
            return (
              <Dropdown.Item id={option.value} key={option.value} textValue={option.label}>
                <Dropdown.ItemIndicator />
                <Icon className={`size-4 shrink-0 ${toneClass || 'text-muted'}`} />
                <div className="min-w-0 flex-1">
                  <Label className={`block truncate ${toneClass}`}>{option.label}</Label>
                  <span className="block truncate text-muted-foreground text-xs">{option.description}</span>
                </div>
              </Dropdown.Item>
            )
          })}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

const MEMORY_INTRO_FALLBACK_SRTS = {
  name: `1
00:00:00,000 --> 00:00:06,123
你好呀！我的朋友，我们今天开始，正式认识啦，我是CipherTalk。

2
00:00:06,264 --> 00:00:11,145
让我们了解一下你吧，请在下面输入框写下你的名字！
`,
  energy: `1
00:00:00,000 --> 00:00:09,153
屏幕亮着，我们有一搭没一搭地聊。屏幕灭了之后呢，你每天醒着的时间里，大部分心思被什么占着？
`,
  coping: `1
00:00:00,000 --> 00:00:10,906
日子总有那种突然脱轨的瞬间，比如计划被打乱，或者期待落空。那种时候，你更习惯一个人慢慢消化，还是干脆不管不顾先撞出去呢？
`,
  interaction: `1
00:00:00,000 --> 00:00:01,862
往后我们会聊很多。

2
00:00:02,016 --> 00:00:04,342
你希望我们之间是什么感觉呢？

3
00:00:04,500 --> 00:00:10,797
是像深夜可以随便说话的人，还是需要一个敢跟你讲真话、偶尔挑刺的同伴呢？
`,
} as const

type MemoryIntroQuestion = {
  key: keyof typeof MEMORY_INTRO_FALLBACK_SRTS
  audioFile: string
  subtitleFile: string
  placeholder: string
  memoryUid: string
  title: string
  tags: string[]
  buildContent: (answer: string) => string
}

const MEMORY_INTRO_QUESTIONS: MemoryIntroQuestion[] = [
  {
    key: 'name',
    audioFile: '记忆-写名字.mp3',
    subtitleFile: '记忆-写名字.srt',
    placeholder: '写下你的名字',
    memoryUid: 'profile:user-name',
    title: '用户名字',
    tags: ['onboarding', 'name', 'profile'],
    buildContent: (answer) => `用户的名字是 ${answer}。`,
  },
  {
    key: 'energy',
    audioFile: '记忆-精力去向.mp3',
    subtitleFile: '记忆-精力去向.srt',
    placeholder: '最近大部分心思被什么占着？',
    memoryUid: 'profile:energy-focus',
    title: '精力去向',
    tags: ['onboarding', 'energy', 'profile'],
    buildContent: (answer) => `用户最近醒着的大部分心思主要被「${answer}」占着。`,
  },
  {
    key: 'coping',
    audioFile: '记忆-应对模式.mp3',
    subtitleFile: '记忆-应对模式.srt',
    placeholder: '你通常怎么应对计划打乱或期待落空？',
    memoryUid: 'profile:coping-pattern',
    title: '应对模式',
    tags: ['onboarding', 'coping', 'profile'],
    buildContent: (answer) => `用户遇到计划被打乱、期待落空等脱轨时刻时，常见应对方式是：${answer}。`,
  },
  {
    key: 'interaction',
    audioFile: '记忆-交互偏好.mp3',
    subtitleFile: '记忆-交互偏好.srt',
    placeholder: '你希望我们之间是什么感觉？',
    memoryUid: 'profile:interaction-preference',
    title: '交互偏好',
    tags: ['onboarding', 'interaction', 'profile'],
    buildContent: (answer) => `用户希望与 AI 的互动感觉是：${answer}。`,
  },
]

const MEMORY_FINALIZING_LINES = [
  '正在把你今天说的，收进抽屉里',
  '有些瞬间不想让它散掉，正在存起来',
  '别急，让它慢慢记进去',
  '今天的你，正在变成我的记忆',
  '合上笔记本之前，让我再看一遍',
  '正在整理那些你没说出口的部分',
  '好的，都记下了——只是需要一点时间落成字',
]

function publicJiyiAsset(fileName: string): string {
  return `${import.meta.env.BASE_URL}jiyi/${fileName}`
}

type MemorySubtitleCue = {
  end: number
  start: number
  text: string
}

type MemoryCharacterTiming = {
  end: number
  start: number
}

type MemoryTypewriterTextPart = string | {
  className?: string
  text: string
}

function parseMemorySrtTimestamp(value: string) {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2}),(\d{3})$/)
  if (!match) return 0
  const [, hours, minutes, seconds, milliseconds] = match
  return Number(hours) * 3600
    + Number(minutes) * 60
    + Number(seconds)
    + Number(milliseconds) / 1000
}

function parseMemorySrt(value: string): MemorySubtitleCue[] {
  return value
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean)
      const timeLine = lines.find((line) => line.includes('-->'))
      if (!timeLine) return null
      const [startValue, endValue] = timeLine.split('-->').map((item) => item.trim())
      const text = lines.slice(lines.indexOf(timeLine) + 1).join('').trim()
      if (!text) return null
      return {
        end: parseMemorySrtTimestamp(endValue),
        start: parseMemorySrtTimestamp(startValue),
        text,
      }
    })
    .filter((cue): cue is MemorySubtitleCue => Boolean(cue))
}

function getMemoryTextFromPart(part: MemoryTypewriterTextPart) {
  return typeof part === 'string' ? part : part.text
}

function splitMemoryText(text: string) {
  return Array.from(text)
}

function isSkippableMemorySubtitleChar(char: string) {
  return /\s/.test(char)
}

function flattenMemoryParts(parts: MemoryTypewriterTextPart[]) {
  return parts.map(getMemoryTextFromPart).join('')
}

function buildMemoryCharacterTimings(lines: MemoryTypewriterTextPart[][], cues: MemorySubtitleCue[]) {
  const fullText = lines.map(flattenMemoryParts).join('')
  const displayChars = splitMemoryText(fullText)
  const displaySearchChars = displayChars
    .map((char, index) => ({ char, index }))
    .filter((item) => !isSkippableMemorySubtitleChar(item.char))
  const displaySearchText = displaySearchChars.map((item) => item.char).join('')
  const timings: Array<MemoryCharacterTiming | undefined> = Array(displayChars.length)
  let searchFrom = 0

  cues.forEach((cue) => {
    const cueChars = splitMemoryText(cue.text).filter((char) => !isSkippableMemorySubtitleChar(char))
    const cueText = cueChars.join('')
    if (!cueText) return

    const foundAt = displaySearchText.indexOf(cueText, searchFrom)
    if (foundAt < 0) return

    const step = (cue.end - cue.start) / Math.max(cueChars.length, 1)
    cueChars.forEach((_, cueIndex) => {
      const displayIndex = displaySearchChars[foundAt + cueIndex]?.index
      if (displayIndex == null) return

      timings[displayIndex] = {
        end: cue.start + step * (cueIndex + 1),
        start: cue.start + step * cueIndex
      }
    })
    searchFrom = foundAt + cueChars.length
  })

  timings.forEach((timing, index) => {
    if (timing || !isSkippableMemorySubtitleChar(displayChars[index])) return

    const previousTiming = timings[index - 1]
    const nextTiming = timings.slice(index + 1).find(Boolean)
    timings[index] = previousTiming || nextTiming || { end: 0, start: 0 }
  })

  let lastKnownEnd = cues.length > 0 ? cues[cues.length - 1].end : 0
  timings.forEach((timing, index) => {
    if (timing) {
      lastKnownEnd = timing.end
      return
    }

    timings[index] = {
      end: lastKnownEnd + 0.12,
      start: lastKnownEnd
    }
    lastKnownEnd += 0.12
  })

  return timings as MemoryCharacterTiming[]
}

function easeMemorySubtitle(value: number) {
  const clamped = Math.min(1, Math.max(0, value))
  return 1 - Math.pow(1 - clamped, 3)
}

const PLAN_DELEGATE_ANALYSIS_REQUIRED_PATTERN = /<!--\s*ciphertalk:delegate_analysis=required\s*-->/i
const PLAN_CONTROL_MARKER_PATTERN = /<!--\s*ciphertalk:delegate_analysis=(?:required|not_required)\s*-->/gi
const CODE_WORKSPACE_FILES_BLOCK_START = '<code_workspace_files>'
const CODE_WORKSPACE_FILES_BLOCK_END = '</code_workspace_files>'

function stripPlanControlMarkers(text: string): string {
  return text.replace(PLAN_CONTROL_MARKER_PATTERN, '').trim()
}

function planRequiresDelegateAnalysis(text: string): boolean {
  return PLAN_DELEGATE_ANALYSIS_REQUIRED_PATTERN.test(text)
}

function displayBasename(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean)
  return parts[parts.length - 1] || value
}

function normalizeWorkspaceFileRefPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\/+/, '').trim()
  if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return ''
  const parts = normalized.split('/').filter(Boolean)
  if (parts.some((part) => part === '..')) return ''
  return parts.join('/')
}

function workspaceFileRefFromPath(path: string, name?: string): CodeWorkspaceFileDragReference | null {
  const normalizedPath = normalizeWorkspaceFileRefPath(path)
  if (!normalizedPath) return null
  return {
    name: name?.trim() || displayBasename(normalizedPath),
    path: normalizedPath,
  }
}

function parseWorkspaceFileDragPayload(value: string): CodeWorkspaceFileDragReference | null {
  if (!value) return null
  try {
    const payload = JSON.parse(value) as Partial<CodeWorkspaceFileDragReference>
    if (typeof payload.path !== 'string') return null
    return workspaceFileRefFromPath(payload.path, typeof payload.name === 'string' ? payload.name : undefined)
  } catch {
    return null
  }
}

function hasWorkspaceFileDrag(dataTransfer: DataTransfer | null): boolean {
  return Boolean(dataTransfer && Array.from(dataTransfer.types).includes(CODE_WORKSPACE_FILE_REF_MIME))
}

function buildWorkspaceFilePrefix(refs: CodeWorkspaceFileDragReference[]): string {
  if (refs.length === 0) return ''
  return [
    CODE_WORKSPACE_FILES_BLOCK_START,
    ...refs.map((ref) => `- ${ref.path}`),
    CODE_WORKSPACE_FILES_BLOCK_END,
  ].join('\n')
}

function splitWorkspaceFilePrefix(text: string): { refs: CodeWorkspaceFileDragReference[]; text: string } {
  const trimmedStart = text.replace(/^\s+/, '')
  if (!trimmedStart.startsWith(CODE_WORKSPACE_FILES_BLOCK_START)) return { refs: [], text }
  const endIndex = trimmedStart.indexOf(CODE_WORKSPACE_FILES_BLOCK_END)
  if (endIndex < 0) return { refs: [], text }

  const body = trimmedStart.slice(CODE_WORKSPACE_FILES_BLOCK_START.length, endIndex)
  const refs = body
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^-\s*/, ''))
    .map((line) => workspaceFileRefFromPath(line))
    .filter((ref): ref is CodeWorkspaceFileDragReference => Boolean(ref))
  const rest = trimmedStart.slice(endIndex + CODE_WORKSPACE_FILES_BLOCK_END.length).replace(/^\r?\n/, '')
  return { refs, text: rest }
}

function removeLeadingSlashCommand(value: string) {
  const match = value.match(/^\/[^\s/]{0,32}$/)
  if (!match) return value
  return ''
}

function PromptPresetButton({ showGroupSeparator = false }: { showGroupSeparator?: boolean }) {
  const { textInput } = usePromptInputController()
  const [isOpen, setIsOpen] = useState(false)

  const applyPreset = (text: string) => {
    textInput.setInput(text)
    setIsOpen(false)
  }

  return (
    <Dropdown isOpen={isOpen} onOpenChange={setIsOpen}>
      <HeroButton aria-label="打开提示词列表" isIconOnly size="sm" variant="tertiary" onPress={() => setIsOpen(true)}>
        {showGroupSeparator && <ButtonGroup.Separator />}
        <Sparkles className="size-3.5" />
      </HeroButton>
      <Dropdown.Popover className="min-w-64 overflow-hidden" placement="top start">
        <Dropdown.Menu className="ct-agent-scrollbar max-h-[min(20rem,52vh)] overflow-y-auto">
          {PROMPT_PRESET_GROUPS.map(({ group, presets }) => (
            <Dropdown.Section key={group}>
              <Header>{group}</Header>
              {presets.map((preset) => {
                const Icon = preset.icon
                return (
                  <Dropdown.Item id={`preset-${preset.label}`} key={preset.label} textValue={preset.label} onAction={() => applyPreset(preset.text)}>
                    <Icon className="size-4 shrink-0 text-muted" />
                    <Label>{preset.label}</Label>
                  </Dropdown.Item>
                )
              })}
            </Dropdown.Section>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

type SlashCommandButtonProps = {
  commands: SlashCommandItem[]
  showGroupSeparator?: boolean
}

type SlashCommandItem = {
  aliases?: string[]
  commands: string[]
  description: string
  icon: typeof Slash
  id: string
  label: string
  action: () => void | Promise<void>
}

function SlashCommandButton({
  commands,
  showGroupSeparator = false,
}: SlashCommandButtonProps) {
  const { textInput } = usePromptInputController()
  const value = textInput.value
  const slashMatch = value.match(/^\/([^\s/]{0,32})$/)
  const query = slashMatch ? slashMatch[1].toLowerCase() : null
  const [manualOpen, setManualOpen] = useState(false)
  const applyingCommandRef = useRef(false)
  const isOpen = manualOpen || query !== null
  const filteredCommands = useMemo(
    () => commands.filter((command) => {
      if (!query) return true
      const haystack = [...command.commands, command.label, command.description, ...(command.aliases || [])].join(' ').toLowerCase()
      return haystack.includes(query)
    }),
    [commands, query]
  )

  const openSlashMenu = () => {
    setManualOpen(true)
  }

  const cancelSlashMenu = () => {
    setManualOpen(false)
    const next = removeLeadingSlashCommand(textInput.value)
    if (next !== textInput.value) textInput.setInput(next)
  }

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setManualOpen(true)
      return
    }
    if (applyingCommandRef.current) {
      applyingCommandRef.current = false
      setManualOpen(false)
      return
    }
    cancelSlashMenu()
  }

  const applyCommand = (command: typeof commands[number]) => {
    applyingCommandRef.current = true
    const next = removeLeadingSlashCommand(textInput.value)
    if (next !== textInput.value) textInput.setInput(next)
    setManualOpen(false)
    void command.action()
  }

  return (
    <Dropdown isOpen={isOpen} onOpenChange={handleOpenChange}>
      <HeroButton aria-label="打开斜杠命令" isIconOnly size="sm" variant="tertiary" onPress={openSlashMenu}>
        {showGroupSeparator && <ButtonGroup.Separator />}
        <Slash className="size-3.5" />
      </HeroButton>
      <Dropdown.Popover className="ct-agent-scrollbar max-h-72 min-w-72 overflow-y-auto" placement="top start">
        <Dropdown.Menu>
          <Dropdown.Section>
            <Header>斜杠命令</Header>
            {filteredCommands.length > 0
              ? filteredCommands.map((command) => {
                  const Icon = command.icon
                  return (
                    <Dropdown.Item id={command.id} key={command.id} textValue={`${command.commands.join(' ')} ${command.label}`} onAction={() => applyCommand(command)}>
                      <Icon className="size-4 shrink-0 text-muted" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <Label>{command.label}</Label>
                        <span className="truncate text-muted-foreground text-xs">{command.description}</span>
                      </div>
                      <span className="ml-auto shrink-0 rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {command.commands[0]}
                      </span>
                    </Dropdown.Item>
                  )
                })
              : (
                  <Dropdown.Item id="slash-empty" textValue="没有匹配的斜杠命令">
                    <Label className="text-muted-foreground">没有匹配的斜杠命令</Label>
                  </Dropdown.Item>
                )}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

function AgentPromptSubmit({ busy, status, workspaceReferenceCount }: { busy: boolean; status: ChatStatus; workspaceReferenceCount: number }) {
  const { textInput, attachments } = usePromptInputController()
  const disabled = !busy && !textInput.value.trim() && attachments.files.length === 0 && workspaceReferenceCount === 0
  return <PromptInputSubmit disabled={disabled} status={status} />
}

function AgentPromptPrimaryAction({ busy, status, workspaceReferenceCount }: { busy: boolean; status: ChatStatus; workspaceReferenceCount: number }) {
  const { textInput, attachments } = usePromptInputController()
  const hasSubmitContent = textInput.value.trim().length > 0 || attachments.files.length > 0 || workspaceReferenceCount > 0

  if (!busy && !hasSubmitContent) {
    return (
      <PromptInputSpeechButton
        aria-label="语音输入"
        language="zh-CN"
        size="icon-sm"
        variant="primary"
      />
    )
  }

  return <AgentPromptSubmit busy={busy} status={status} workspaceReferenceCount={workspaceReferenceCount} />
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

// 进行中默认展开（让用户看到 AI 正在干啥），结束后自动收起；用户手动点过则尊重用户的选择。
function MessageChainOfThought({ active, children }: { active: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(active)
  const userToggledRef = useRef(false)
  useEffect(() => {
    if (!userToggledRef.current) setOpen(active)
  }, [active])
  return (
    <ChainOfThought onOpenChange={(value) => { userToggledRef.current = true; setOpen(value) }} open={open}>
      <ChainOfThoughtHeader>执行过程</ChainOfThoughtHeader>
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
  generate_image: '生成图片',
  search_stickers: '翻表情包',
  send_sticker: '发表情包',
  send_random_image: '抽一张图片',
  send_wechat_media: '发送微信媒体',
  export_chat: '导出聊天记录',
  persona_control: '数字分身',
  auto_memory: '自动记忆',
  final_review: '最终审核',
}

type PersonaControlOutput = {
  success?: boolean
  action?: 'open_persona_chat' | 'ask_persona_build' | 'build_persona' | 'build_session_vectors'
  sessionId?: string
  displayName?: string
  message?: string
  error?: string
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

function getPersonaControlOutput(part: unknown): PersonaControlOutput | null {
  const p = part as { type?: unknown; state?: unknown; output?: unknown }
  if (p?.type !== 'tool-persona_control' || p.state !== 'output-available') return null
  if (!p.output || typeof p.output !== 'object') return null
  return p.output as PersonaControlOutput
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

function getDelegateTasks(part: unknown): string[] {
  const input = (part as { input?: unknown }).input
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  const tasks = (input as { tasks?: unknown }).tasks
  if (Array.isArray(tasks)) {
    return tasks
      .map((item) => {
        if (!item || typeof item !== 'object') return ''
        const task = (item as { task?: unknown }).task
        return typeof task === 'string' ? task.trim() : ''
      })
      .filter(Boolean)
  }
  const task = (input as { task?: unknown }).task
  return typeof task === 'string' && task.trim() ? [task.trim()] : []
}

const SUB_AGENT_PROGRESS_LIMIT = 48
const AGENT_PENDING_TITLE = '正在准备请求'
const AGENT_PREP_PROGRESS_TITLE = '大模型准备中'
// 准备阶段由主进程合并成单一可见步骤；这里只隐藏可能存在的本地占位项。
const HIDDEN_PREP_PROGRESS_TITLES = new Set([
  AGENT_PENDING_TITLE,
])

type AgentMessagePart = UIMessage['parts'][number]
type AgentChainPart = AgentMessagePart & {
  input?: unknown
  output?: unknown
  state?: string
  errorText?: string
}

function isAgentChainPart(part: AgentMessagePart): part is AgentChainPart {
  return part.type === 'reasoning' || isToolUIPart(part)
}

// 参考 Claude 的消息展示：按 parts 原始顺序渲染，只把"连续"的思考/工具调用合并成一个执行过程块，
// 思考与正文交错时保持时间顺序，而不是把所有思考都提到正文前面。
type AgentRenderSegment =
  | { kind: 'chain'; items: Array<{ part: AgentChainPart; index: number }> }
  | { kind: 'part'; part: AgentMessagePart; index: number }

function buildRenderSegments(parts: UIMessage['parts']): AgentRenderSegment[] {
  const segments: AgentRenderSegment[] = []
  parts.forEach((part, index) => {
    if (part.type === 'step-start') return
    if (isAgentChainPart(part)) {
      const last = segments[segments.length - 1]
      if (last?.kind === 'chain') last.items.push({ part, index })
      else segments.push({ kind: 'chain', items: [{ part, index }] })
    } else {
      segments.push({ kind: 'part', part, index })
    }
  })
  return segments
}

function shouldDisplayAgentProgress(progress: AgentProgressEvent) {
  if (progress.stage === 'error') return true
  if (progress.visible === false) return false
  if ((progress.depth ?? 0) === 0 && progress.stage === 'run_started' && progress.title === AGENT_PREP_PROGRESS_TITLE) return true
  if ((progress.depth ?? 0) === 0 && progress.stage === 'run_started' && HIDDEN_PREP_PROGRESS_TITLES.has(progress.title)) return false
  if ((progress.depth ?? 0) === 0 && progress.stage === 'run_finished' && progress.title === '回答生成完成') return false
  return true
}

function subAgentProgressGroupKey(progress: AgentProgressEvent) {
  return [
    progress.parentToolCallId || 'delegate',
    progress.subTaskId || progress.subTaskTitle || 'single',
  ].join(':')
}

function subAgentProgressKey(progress: AgentProgressEvent) {
  const groupKey = subAgentProgressGroupKey(progress)
  if (progress.toolCallId) return `${groupKey}:call:${progress.toolCallId}`
  if (progress.toolName && (progress.stage === 'tool_started' || progress.stage === 'tool_finished' || progress.stage === 'error')) {
    return `${groupKey}:tool:${progress.depth ?? 0}:${progress.toolName}`
  }
  return `${groupKey}:event:${progress.depth ?? 0}:${progress.stage}:${progress.title}:${progress.sessionId ?? ''}`
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

// 等待模型首个输出的空窗期（可能 2~12s）轮播的安抚文案：让"死等"看起来像"它在忙"
const MODEL_WAITING_PHRASES = [
  '大模型正在酝酿措辞…',
  '正在翻箱倒柜整理思路…',
  '灵感马上就位…',
  '正在斟酌怎么回你…',
  '大模型还在打草稿…',
  '快了快了，正在组织语言…',
]

function WaitingPhraseStep() {
  const [index, setIndex] = useState(() => Math.floor(Math.random() * MODEL_WAITING_PHRASES.length))
  useEffect(() => {
    const timer = window.setInterval(
      () => setIndex((value) => (value + 1) % MODEL_WAITING_PHRASES.length),
      3200,
    )
    return () => window.clearInterval(timer)
  }, [])
  return (
    <ChainOfThoughtStep
      icon={Sparkles}
      label={renderChainLabel(MODEL_WAITING_PHRASES[index], true)}
      status="active"
    />
  )
}

function AgentProgressChain({ active, waiting = false, events }: { active: boolean; waiting?: boolean; events: AgentProgressEvent[] }) {
  if (events.length === 0) return null
  const latestKey = subAgentProgressKey(events[events.length - 1])

  return (
    <MessageChainOfThought active={active}>
      {events.map((progress) => {
        const key = subAgentProgressKey(progress)
        const stepActive = active
          && !waiting
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
      {waiting && <WaitingPhraseStep />}
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

type SubAgentProgressGroup = {
  key: string
  title: string
  events: AgentProgressEvent[]
  latest: AgentProgressEvent
}

function groupSubAgentProgress(events: AgentProgressEvent[]): SubAgentProgressGroup[] {
  const groups = new Map<string, AgentProgressEvent[]>()
  for (const event of events) {
    const key = subAgentProgressGroupKey(event)
    groups.set(key, [...(groups.get(key) || []), event])
  }
  return Array.from(groups.entries()).map(([key, groupEvents], index) => {
    const latest = groupEvents[groupEvents.length - 1]
    return {
      key,
      title: latest.subTaskTitle || `子任务 ${index + 1}`,
      events: groupEvents,
      latest,
    }
  })
}

function formatSubAgentPanelTitle(groups: SubAgentProgressGroup[], latest: AgentProgressEvent) {
  if (groups.length <= 1) return subAgentPanelTitle(latest)
  const finished = groups.filter((group) => group.latest.stage === 'run_finished').length
  const failed = groups.filter((group) => group.latest.stage === 'error').length
  if (finished + failed >= groups.length) {
    return failed > 0 ? `子助手完成 ${finished}/${groups.length}` : `子助手已完成 ${groups.length}/${groups.length}`
  }
  return `${groups.length} 个子任务并行分析中`
}

function SubAgentProgressPanel({ events, tasks }: { events: AgentProgressEvent[]; tasks?: string[] }) {
  if (events.length === 0) return null
  const latestKey = subAgentProgressKey(events[events.length - 1])
  const latest = events[events.length - 1]
  const toolCount = new Set(events.map((event) => event.toolName).filter(Boolean)).size
  const groups = groupSubAgentProgress(events)
  const finishedGroups = groups.filter((group) => group.latest.stage === 'run_finished').length
  const failedGroups = groups.filter((group) => group.latest.stage === 'error').length

  return (
    <section
      aria-live="polite"
      className="mt-2 rounded-(--agent-radius,12px) border border-border bg-surface/80 px-3 py-2.5 text-xs shadow-xs"
    >
      <div className="mb-2 flex min-w-0 items-center gap-2 font-medium text-foreground">
        <Sparkles className="size-3.5 shrink-0" />
        <span className="shrink-0">{formatSubAgentPanelTitle(groups, latest)}</span>
        <span className="min-w-0 truncate text-muted-foreground font-normal">
          {formatSubAgentProgressTitle(latest)}
        </span>
      </div>
      {tasks && tasks.length > 0 && (
        <div className="mb-2 rounded-(--agent-radius,12px) bg-muted/50 px-2 py-1.5 text-muted-foreground">
          <div className="mb-0.5 text-[11px] text-foreground">委托任务</div>
          {tasks.length === 1 ? (
            <div className="line-clamp-3 whitespace-pre-wrap wrap-break-word">{tasks[0]}</div>
          ) : (
            <ol className="list-inside list-decimal space-y-0.5">
              {tasks.slice(0, 4).map((task, index) => (
                <li className="line-clamp-2 whitespace-pre-wrap wrap-break-word" key={`${index}-${task}`}>
                  {task}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <div className="mb-2 flex flex-wrap gap-1">
        <span className="rounded-full bg-muted/60 px-2 py-0.5 text-muted-foreground">{events.length} 条进度</span>
        {groups.length > 1 && <span className="rounded-full bg-muted/60 px-2 py-0.5 text-muted-foreground">完成 {finishedGroups}/{groups.length}</span>}
        {failedGroups > 0 && <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">失败 {failedGroups}</span>}
        {toolCount > 0 && <span className="rounded-full bg-muted/60 px-2 py-0.5 text-muted-foreground">{toolCount} 个工具</span>}
        <span className="rounded-full bg-muted/60 px-2 py-0.5 text-muted-foreground">最近 {formatProgressTime(latest.at)}</span>
      </div>
      <div className="space-y-2">
        {groups.map((group) => {
          const groupLatestKey = subAgentProgressKey(group.latest)
          return (
            <div className="rounded-(--agent-radius,12px) bg-muted/30 px-2 py-1.5" key={group.key}>
              {groups.length > 1 && (
                <div className="mb-1 flex min-w-0 items-center gap-2 font-medium text-foreground">
                  <span className={`size-1.5 shrink-0 rounded-full ${subAgentProgressDotClass(group.latest)}`} />
                  <span className="min-w-0 flex-1 truncate">{group.title}</span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">{formatSubAgentStage(group.latest)}</span>
                </div>
              )}
              <div className="space-y-1">
                {group.events.slice(groups.length > 1 ? -4 : -SUB_AGENT_PROGRESS_LIMIT).map((progress) => {
                  const Icon = subAgentProgressIcon(progress)
                  const itemKey = subAgentProgressKey(progress)
                  const meta = formatSubAgentProgressMeta(progress)
                  const active = (itemKey === latestKey || itemKey === groupLatestKey)
                    && progress.stage !== 'tool_finished'
                    && progress.stage !== 'run_finished'
                    && progress.stage !== 'error'
                  return (
                    <div
                      className="flex min-w-0 items-start gap-2 rounded-(--agent-radius,12px) px-1 py-0.5 text-muted-foreground"
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

type MentionQueryState = {
  end: number
  query: string
  start: number
}

function getPromptTextareaElement(): HTMLTextAreaElement | null {
  if (typeof document === 'undefined') return null
  const active = document.activeElement
  if (active instanceof HTMLTextAreaElement && active.name === 'message') return active
  return document.querySelector<HTMLTextAreaElement>('.agent-prompt-input textarea[name="message"]')
}

function focusPromptTextareaAt(position: number) {
  if (typeof window === 'undefined') return
  window.requestAnimationFrame(() => {
    const textarea = getPromptTextareaElement()
    if (!textarea) return
    textarea.focus()
    textarea.setSelectionRange(position, position)
  })
}

function isAsciiWordChar(value: string): boolean {
  return /^[A-Za-z0-9_]$/.test(value)
}

function getMentionQueryAtCursor(value: string): MentionQueryState | null {
  const textarea = getPromptTextareaElement()
  const cursor = textarea && textarea.value === value ? textarea.selectionStart : value.length
  const beforeCursor = value.slice(0, cursor)
  const match = beforeCursor.match(/@([^\s@\[\]\r\n]{0,24})$/)
  if (!match) return null
  const query = match[1] || ''
  const start = cursor - query.length - 1
  if (start > 0 && isAsciiWordChar(value[start - 1] || '')) return null
  return {
    end: cursor,
    query,
    start,
  }
}

function insertMentionTriggerAtPromptCursor(value: string): { nextValue: string; nextCursor: number } {
  const textarea = getPromptTextareaElement()
  const start = textarea && textarea.value === value ? textarea.selectionStart : value.length
  const end = textarea && textarea.value === value ? textarea.selectionEnd : value.length
  const before = value.slice(0, start)
  const after = value.slice(end)
  const prefix = before && !/\s$/.test(before) ? ' ' : ''
  const suffix = after && !/^\s/.test(after) ? ' ' : ''
  const nextValue = `${before}${prefix}@${suffix}${after}`
  return { nextValue, nextCursor: before.length + prefix.length + 1 }
}

function removePromptTextRange(value: string, start: number, end: number): { nextValue: string; nextCursor: number } {
  const before = value.slice(0, start)
  const after = value.slice(end)
  const nextAfter = before && /\s$/.test(before) ? after.replace(/^\s+/, '') : after
  const spacer = before && nextAfter && !/\s$/.test(before) && !/^\s/.test(nextAfter) ? ' ' : ''
  let nextValue = `${before}${spacer}${nextAfter}`
  let nextCursor = before.length + spacer.length

  if (start === 0) {
    const trimmed = nextValue.replace(/^[ \t]+/, '')
    nextCursor = Math.max(0, nextCursor - (nextValue.length - trimmed.length))
    nextValue = trimmed
  }

  return { nextValue, nextCursor }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function removeMentionTokenFromPromptText(text: string, target: MentionTarget): string {
  const displayName = escapeRegExp(target.displayName)
  const username = escapeRegExp(target.username)
  return text
    .replace(new RegExp(`(^|\\s)@${displayName}\\[${username}\\](?=\\s|$)`, 'g'), '$1')
    .replace(new RegExp(`(^|\\s)@${displayName}(?=\\s|$)`, 'g'), '$1')
    .replace(/^[ \t]+/, '')
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
  workspaceFiles: CodeWorkspaceFileDragReference[]
  textByPartIndex: Map<number, string>
} {
  const textByPartIndex = new Map<number, string>()
  const firstTextIndex = parts.findIndex((part) => part.type === 'text')
  if (firstTextIndex < 0) return { mentions: [], workspaceFiles: [], textByPartIndex }

  const firstTextPart = parts[firstTextIndex] as Extract<UIMessage['parts'][number], { type: 'text' }>
  const parsed = splitMentionPrefix(firstTextPart.text || '')
  const workspaceParsed = splitWorkspaceFilePrefix(parsed.text)
  if (parsed.mentions.length > 0 || workspaceParsed.refs.length > 0) {
    textByPartIndex.set(firstTextIndex, workspaceParsed.text)
  }
  return {
    mentions: parsed.mentions,
    workspaceFiles: workspaceParsed.refs,
    textByPartIndex,
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

function MentionTargetChips({
  targets,
  align = 'start',
  onRemove,
}: {
  targets: MentionTarget[]
  align?: 'start' | 'end'
  onRemove?: (target: MentionTarget) => void
}) {
  if (targets.length === 0) return null
  return (
    <div className={`flex max-w-full flex-wrap gap-1.5 ${align === 'end' ? 'ml-auto justify-end' : ''}`}>
      {targets.map((target) => (
        <span
          className="inline-flex h-7 max-w-56 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-1.5 pr-2 font-medium text-primary text-xs"
          key={target.username}
          title={`${target.displayName} · ${target.username}`}
        >
          <MentionAvatar className="size-5" target={target} />
          <span className="min-w-0 truncate">@{target.displayName}</span>
          {target.kind === 'group' && <span className="shrink-0 text-[10px] opacity-75">群</span>}
          {onRemove && (
            <button
              aria-label={`移除 ${target.displayName}`}
              className="-mr-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full opacity-65 transition hover:bg-primary/15 hover:opacity-100"
              onClick={() => onRemove(target)}
              onMouseDown={(event) => event.preventDefault()}
              type="button"
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

function WorkspaceFileReferenceChips({
  refs,
  align = 'start',
  onRemove,
}: {
  refs: CodeWorkspaceFileDragReference[]
  align?: 'start' | 'end'
  onRemove?: (path: string) => void
}) {
  if (refs.length === 0) return null
  return (
    <div className={`flex max-w-full flex-wrap gap-1.5 ${align === 'end' ? 'ml-auto justify-end' : ''}`}>
      {refs.map((ref) => (
        <span
          className="inline-flex max-w-56 items-center gap-1.5 rounded-full border border-border/70 bg-muted/70 px-2 py-0.5 text-muted-foreground text-xs"
          key={ref.path}
          title={ref.path}
        >
          <Code2 className="size-3.5 shrink-0 text-accent" />
          <span className="truncate">{ref.name || displayBasename(ref.path)}</span>
          {onRemove && (
            <button
              aria-label={`移除 ${ref.name || displayBasename(ref.path)}`}
              className="ml-0.5 shrink-0 opacity-60 hover:opacity-100"
              onClick={() => onRemove(ref.path)}
              type="button"
            >
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
    </div>
  )
}

function AgentPromptAssetHeader({
  onRemoveWorkspaceFileReference,
  workspaceFileReferences,
}: {
  onRemoveWorkspaceFileReference: (path: string) => void
  workspaceFileReferences: CodeWorkspaceFileDragReference[]
}) {
  const { attachments } = usePromptInputController()
  if (workspaceFileReferences.length === 0 && attachments.files.length === 0) return null

  return (
    <PromptInputHeader className="flex-col items-stretch gap-1.5 px-3 pt-2 pb-0">
      <WorkspaceFileReferenceChips
        onRemove={onRemoveWorkspaceFileReference}
        refs={workspaceFileReferences}
      />
      <PromptInputAttachments className="p-0">
        {(attachment) => <PromptInputAttachment data={attachment} />}
      </PromptInputAttachments>
    </PromptInputHeader>
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
  onSearch,
}: {
  sessions: MentionTarget[]
  mentions: MentionTarget[]
  hasMore: boolean
  isLoading: boolean
  onAdd: (m: MentionTarget) => void
  onLoadMore: () => void
  onRemove: (m: MentionTarget) => void
  onSearch: (query: string) => void
}) {
  const { textInput } = usePromptInputController()
  const value = textInput.value
  const [queryState, setQueryState] = useState<MentionQueryState | null>(() => getMentionQueryAtCursor(value))
  const query = queryState?.query ?? null
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

  const refreshQueryState = useCallback(() => {
    setQueryState(getMentionQueryAtCursor(textInput.value))
  }, [textInput.value])

  useEffect(() => {
    refreshQueryState()
  }, [refreshQueryState])

  useEffect(() => {
    if (typeof document === 'undefined') return
    document.addEventListener('selectionchange', refreshQueryState)
    return () => {
      document.removeEventListener('selectionchange', refreshQueryState)
    }
  }, [refreshQueryState])

  useEffect(() => {
    setVisibleLimit(MENTION_RESULT_BATCH_SIZE)
  }, [query, pickedKey])

  useEffect(() => {
    if (query !== null && sessions.length === 0 && hasMore && !isLoading) onLoadMore()
  }, [hasMore, isLoading, onLoadMore, query, sessions.length])

  useEffect(() => {
    const q = query?.trim()
    if (!q) return
    const timer = window.setTimeout(() => onSearch(q), 180)
    return () => window.clearTimeout(timer)
  }, [onSearch, query])

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
    if (!queryState) return
    onAdd(s)
    const { nextCursor, nextValue } = removePromptTextRange(value, queryState.start, queryState.end)
    textInput.setInput(nextValue)
    setQueryState(null)
    focusPromptTextareaAt(nextCursor)
  }

  const removeSelectedMention = (target: MentionTarget) => {
    onRemove(target)
    const nextValue = removeMentionTokenFromPromptText(textInput.value, target)
    if (nextValue !== textInput.value) textInput.setInput(nextValue)
    focusPromptTextareaAt(nextValue.length)
  }

  return (
    <>
      {mentions.length > 0 && (
        <div className="w-full px-3 pt-2">
          <MentionTargetChips targets={mentions} onRemove={removeSelectedMention} />
        </div>
      )}
      <div className="relative h-0 w-full self-stretch">
        {query !== null && (
          <div
            className="absolute bottom-full left-3 z-50 mb-2 w-80 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-(--agent-radius,12px) border border-border bg-popover p-1 shadow-lg"
          >
            <div className="max-h-80 overflow-y-auto pr-1 [scrollbar-gutter:stable]" onScroll={handleResultsScroll}>
              {results.length > 0 ? (
                <>
                  {results.map((s) => (
                    <button
                      className="flex w-full items-center gap-2 rounded-(--agent-radius,12px) px-2 py-1.5 text-left text-sm hover:bg-accent"
                      key={s.username}
                      onClick={() => select(s)}
                      onMouseDown={(event) => event.preventDefault()}
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
                    : hasMore || sessions.length === 0
                      ? (
                        <button className="rounded-(--agent-radius,12px) px-2 py-1 hover:bg-accent" onClick={onLoadMore} type="button">
                          {sessions.length === 0 ? '重新加载联系人' : '继续加载更多会话'}
                        </button>
                      )
                      : '未找到匹配的联系人'}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
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
        const { nextCursor, nextValue } = insertMentionTriggerAtPromptCursor(v)
        textInput.setInput(nextValue)
        focusPromptTextareaAt(nextCursor)
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
    parentToolCallId: event.parentToolCallId,
    subTaskId: event.subTaskId,
    subTaskTitle: event.subTaskTitle,
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

type AgentMemoryIntroStatus = 'checking' | 'hidden' | 'needed'

function MemoryIntroSubtitle({
  charTimings,
  currentTime,
  lineStarts,
  lines,
}: {
  charTimings: MemoryCharacterTiming[]
  currentTime: number
  lineStarts: number[]
  lines: MemoryTypewriterTextPart[][]
}) {
  return (
    <article className="flex min-h-32 w-full max-w-7xl flex-col justify-center gap-5 px-4 text-[15px] leading-8 text-black/86 drop-shadow-[0_2px_12px_rgba(255,255,255,0.55)] dark:text-white/88 dark:drop-shadow-[0_2px_12px_rgba(0,0,0,0.55)]">
      {lines.map((parts, lineIndex) => (
        <p className="m-0 text-center text-xl font-semibold leading-9 sm:text-2xl sm:leading-10" key={`memory-line-${lineIndex}`}>
          <MemoryTypewriterText
            charTimings={charTimings}
            currentTime={currentTime}
            parts={parts}
            startIndex={lineStarts[lineIndex] || 0}
          />
        </p>
      ))}
    </article>
  )
}

function MemoryTypewriterText({
  charTimings,
  currentTime,
  parts,
  startIndex,
}: {
  charTimings: MemoryCharacterTiming[]
  currentTime: number
  parts: MemoryTypewriterTextPart[]
  startIndex: number
}) {
  const lineStart = charTimings[startIndex]?.start ?? 0
  if (currentTime < lineStart) return null

  let cursor = 0

  return (
    <>
      {parts.map((part, partIndex) => {
        const text = getMemoryTextFromPart(part)
        const className = typeof part === 'string' ? undefined : part.className
        const chars = splitMemoryText(text)
        const content = chars.map((char, charIndex) => {
          const index = startIndex + cursor + charIndex
          const timing = charTimings[index]
          const charStart = timing?.start ?? Number.POSITIVE_INFINITY
          const charEnd = timing?.end ?? charStart + 0.12
          const raw = (currentTime - charStart) / Math.max(charEnd - charStart, 0.001)
          const eased = easeMemorySubtitle(raw)
          const style = {
            opacity: eased,
            transform: `translate3d(0, ${(1 - eased) * 0.38}em, 0)`,
            filter: `blur(${(1 - eased) * 1.2}px)`,
            transition: 'opacity 220ms cubic-bezier(0.16, 1, 0.3, 1), transform 220ms cubic-bezier(0.16, 1, 0.3, 1), filter 220ms cubic-bezier(0.16, 1, 0.3, 1)',
            willChange: eased < 1 ? 'opacity, transform, filter' : undefined
          } satisfies CSSProperties

          return (
            <span className={`memory-intro-shimmer-char inline-block whitespace-pre-wrap ${className || ''}`} key={`${index}-${char}`} style={style}>
              {char}
            </span>
          )
        })

        cursor += chars.length

        return (
          <Fragment key={partIndex}>{content}</Fragment>
        )
      })}
    </>
  )
}

function AgentMemoryIntro({ onMemoryCreated }: { onMemoryCreated: () => void }) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const progressFillRef = useRef<HTMLDivElement | null>(null)
  const audioProgressFrameRef = useRef<number | null>(null)
  const decodedDurationRef = useRef(0)
  const lastStateProgressRef = useRef(-1)
  const [step, setStep] = useState(0)
  const question = MEMORY_INTRO_QUESTIONS[Math.min(step, MEMORY_INTRO_QUESTIONS.length - 1)]
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [finalizingLineIndex, setFinalizingLineIndex] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [cues, setCues] = useState<MemorySubtitleCue[]>(() => parseMemorySrt(MEMORY_INTRO_FALLBACK_SRTS.name))
  const currentAnswer = answers[question.key] || ''
  const lines = useMemo<MemoryTypewriterTextPart[][]>(() => cues.map((cue) => [cue.text]), [cues])
  const lineStarts = useMemo(() => {
    return lines.reduce<number[]>((starts, parts, index) => {
      if (index === 0) {
        starts.push(0)
        return starts
      }
      const previousLineLength = lines[index - 1].reduce(
        (sum, part) => sum + splitMemoryText(getMemoryTextFromPart(part)).length,
        0
      )
      starts.push(starts[index - 1] + previousLineLength)
      return starts
    }, [])
  }, [lines])
  const charTimings = useMemo(() => buildMemoryCharacterTimings(lines, cues), [cues, lines])

  useEffect(() => {
    let cancelled = false
    setCues(parseMemorySrt(MEMORY_INTRO_FALLBACK_SRTS[question.key]))
    void fetch(publicJiyiAsset(question.subtitleFile))
      .then((res) => (res.ok ? res.text() : ''))
      .then((text) => {
        if (cancelled || !text) return
        const parsed = parseMemorySrt(text)
        if (parsed.length > 0) setCues(parsed)
      })
      .catch(() => {
        // 字幕读取失败时使用内置兜底。
      })
    return () => {
      cancelled = true
    }
  }, [question.key, question.subtitleFile])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const syncAudioProgress = () => {
      const duration = decodedDurationRef.current || audio.duration
      if (Number.isFinite(duration) && duration > 0) {
        const nextProgress = Math.min(100, (audio.currentTime / duration) * 100)

        if (progressFillRef.current) {
          progressFillRef.current.style.transform = `translate3d(0, 0, 0) scaleX(${nextProgress / 100})`
        }

        if (
          Math.abs(nextProgress - lastStateProgressRef.current) >= 0.12
          || nextProgress === 100
        ) {
          lastStateProgressRef.current = nextProgress
          setCurrentTime(audio.currentTime)
        }
      }
      audioProgressFrameRef.current = window.requestAnimationFrame(syncAudioProgress)
    }

    decodedDurationRef.current = 0
    void fetch(publicJiyiAsset(question.audioFile))
      .then((res) => res.arrayBuffer())
      .then((buffer) => {
        const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!AudioContextCtor) return
        const context = new AudioContextCtor()
        return context.decodeAudioData(buffer).then((decoded) => {
          decodedDurationRef.current = decoded.duration
          void context.close()
        }).catch(() => {
          void context.close()
        })
      })
      .catch(() => {
        // 音频时长解析失败时回退到 HTMLAudioElement.duration。
      })

    audio.currentTime = 0
    setCurrentTime(0)
    lastStateProgressRef.current = -1
    if (progressFillRef.current) {
      progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(0)'
    }
    audio.load()
    void audio.play().catch(() => {
      // Electron/浏览器策略可能拦截自动播放；用户输入时仍可继续流程。
    })
    audioProgressFrameRef.current = window.requestAnimationFrame(syncAudioProgress)

    return () => {
      if (audioProgressFrameRef.current !== null) {
        window.cancelAnimationFrame(audioProgressFrameRef.current)
        audioProgressFrameRef.current = null
      }
      audio.pause()
      audio.currentTime = 0
      setCurrentTime(0)
      if (progressFillRef.current) {
        progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(0)'
      }
    }
  }, [question.audioFile])

  useEffect(() => {
    setError('')
  }, [step])

  useEffect(() => {
    if (!finalizing) return
    audioRef.current?.pause()
    const timer = window.setInterval(() => {
      setFinalizingLineIndex((index) => (index + 1) % MEMORY_FINALIZING_LINES.length)
    }, 1800)
    return () => window.clearInterval(timer)
  }, [finalizing])

  const submitCurrentAnswer = useCallback(async () => {
    const trimmed = currentAnswer.trim()
    if (!trimmed) {
      setError(question.placeholder)
      return
    }
    setSaving(true)
    setError('')
    try {
      const res = await window.electronAPI.memory.create({
        memoryUid: question.memoryUid,
        sourceType: 'profile',
        title: question.title,
        content: question.buildContent(trimmed),
        importance: 0.95,
        confidence: 1,
        tags: question.tags,
      })
      if (!res.success) throw new Error(res.error || '保存记忆失败')
      if (step >= MEMORY_INTRO_QUESTIONS.length - 1) {
        setFinalizing(true)
        const startedAt = Date.now()
        const consolidate = window.electronAPI.memory.consolidate()
        const minimumVisible = new Promise((resolve) => window.setTimeout(resolve, Math.max(0, 3200 - (Date.now() - startedAt))))
        const [consolidateRes] = await Promise.all([consolidate, minimumVisible])
        if (!consolidateRes.success) throw new Error(consolidateRes.error || '整理记忆失败')
        onMemoryCreated()
      } else {
        setStep((value) => value + 1)
      }
    } catch (err) {
      setFinalizing(false)
      setError(err instanceof Error ? err.message : '保存记忆失败')
    } finally {
      setSaving(false)
    }
  }, [currentAnswer, onMemoryCreated, question, step])

  return (
    <div className="absolute inset-0 z-30 overflow-hidden bg-background">
      <style>
        {`
          .memory-intro-shimmer-char {
            --memory-shimmer-base: rgba(0, 0, 0, 0.86);
            --memory-shimmer-glint: rgba(255, 255, 255, 0.96);
            background-image: linear-gradient(105deg, var(--memory-shimmer-base) 0%, var(--memory-shimmer-base) 34%, var(--memory-shimmer-glint) 48%, var(--memory-shimmer-base) 62%, var(--memory-shimmer-base) 100%);
            background-position: 120% 0;
            background-size: 230% 100%;
            -webkit-background-clip: text;
            background-clip: text;
            color: transparent;
            -webkit-text-fill-color: transparent;
            animation: memoryIntroShimmer 3.6s linear infinite;
          }

          .dark .memory-intro-shimmer-char,
          [data-theme="dark"] .memory-intro-shimmer-char {
            --memory-shimmer-base: rgba(255, 255, 255, 0.88);
            --memory-shimmer-glint: rgba(165, 243, 252, 0.98);
          }

          @keyframes memoryIntroShimmer {
            0% { background-position: 120% 0; }
            100% { background-position: -120% 0; }
          }
        `}
      </style>
      <div className="absolute inset-0 bg-[linear-gradient(135deg,rgba(20,184,166,0.22),rgba(244,63,94,0.12)_48%,rgba(15,23,42,0.18))]" />
      <div className="absolute inset-[-18%] bg-[linear-gradient(115deg,rgba(255,255,255,0.34),rgba(148,163,184,0.14)_42%,rgba(20,184,166,0.2))] blur-3xl dark:opacity-60" />
      <div className="absolute inset-0 bg-background/40 backdrop-blur-2xl" />
      <audio
        aria-hidden="true"
        preload="auto"
        ref={audioRef}
        src={publicJiyiAsset(question.audioFile)}
        onEnded={() => {
          lastStateProgressRef.current = 100
          const duration = decodedDurationRef.current || audioRef.current?.duration || 0
          setCurrentTime(duration)
          if (progressFillRef.current) {
            progressFillRef.current.style.transform = 'translate3d(0, 0, 0) scaleX(1)'
          }
        }}
      />

      <div className="relative z-10 flex size-full items-center justify-center px-6 py-10">
        <div className="grid w-full max-w-340 overflow-hidden">
          {finalizing ? (
            <section
              aria-label="正在整理记忆"
              className="col-start-1 row-start-1 flex min-h-105 flex-col items-center justify-center gap-8 px-4 text-center transition-all duration-500 ease-out"
            >
              <p className="m-0 max-w-260 text-balance text-2xl font-semibold leading-10 text-black/86 drop-shadow-[0_2px_12px_rgba(255,255,255,0.55)] transition-all duration-500 dark:text-white/88 dark:drop-shadow-[0_2px_12px_rgba(0,0,0,0.55)] sm:text-3xl sm:leading-12">
                <span className="memory-intro-shimmer-char inline-block" key={finalizingLineIndex}>
                  {MEMORY_FINALIZING_LINES[finalizingLineIndex]}
                </span>
              </p>
              <div className="h-px w-full max-w-160 overflow-hidden bg-white/12">
                <div className="h-full origin-left animate-pulse bg-linear-to-r from-white/35 via-cyan-100/85 to-fuchsia-200/80" />
              </div>
            </section>
          ) : (
            <section
              aria-label="首次记忆询问"
              className="col-start-1 row-start-1 flex min-h-105 flex-col items-center justify-center gap-8 transition-all duration-500 ease-out"
              key={question.key}
            >
              <MemoryIntroSubtitle charTimings={charTimings} currentTime={currentTime} lineStarts={lineStarts} lines={lines} />
              <div className="flex w-full max-w-160 flex-col">
                <TextField
                  aria-label={question.placeholder}
                  fullWidth
                  isDisabled={saving}
                  isInvalid={Boolean(error)}
                  name={`memory-intro-${question.key}`}
                  value={currentAnswer}
                  onChange={(value) => {
                    setAnswers((prev) => ({ ...prev, [question.key]: value }))
                    if (error) setError('')
                  }}
                >
                  <Input
                    autoFocus
                    className="focus-visible:border-border! focus-visible:ring-0! data-[focus-visible=true]:border-border! data-[focus-visible=true]:ring-0!"
                    placeholder={error || question.placeholder}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        void submitCurrentAnswer()
                      }
                    }}
                  />
                </TextField>
                <HeroButton
                  aria-hidden={!currentAnswer.trim()}
                  className={`transition-all duration-300 ease-out ${
                    currentAnswer.trim()
                      ? 'pointer-events-auto mt-3 max-h-12 translate-y-0 opacity-100 blur-0'
                      : 'pointer-events-none mt-0 max-h-0 -translate-y-2 overflow-hidden opacity-0 blur-sm'
                  }`}
                  fullWidth
                  isDisabled={!currentAnswer.trim()}
                  isPending={saving}
                  onPress={() => { void submitCurrentAnswer() }}
                  size="lg"
                  variant="primary"
                >
                  <CheckIcon className="size-4" />
                  {step >= MEMORY_INTRO_QUESTIONS.length - 1 ? '完成' : '继续'}
                </HeroButton>
                <div
                  aria-label="记忆引导播放进度"
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={Math.round(Math.min(100, Math.max(0, lastStateProgressRef.current)))}
                  className="mt-3 h-px w-full overflow-hidden bg-white/12"
                  role="progressbar"
                >
                  <div
                    ref={progressFillRef}
                    className="h-full origin-left bg-linear-to-r from-white/35 via-cyan-100/85 to-fuchsia-200/80 will-change-transform"
                    style={{ transform: 'translate3d(0, 0, 0) scaleX(0)' }}
                  />
                </div>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

export default function AgentPage() {
  const [presets, setPresets] = useState<configService.AiConfigPreset[]>([])
  const [providersInfo, setProvidersInfo] = useState<AIProviderInfo[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('current')
  const [reasoningEffort, setReasoningEffort] = useState<AgentReasoningEffort>('auto')
  const [generatedImagePreview, setGeneratedImagePreview] = useState<{ src: string; originRect?: ImagePreviewOriginRect } | null>(null)
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
  const [codeWorkspaceState, setCodeWorkspaceState] = useState<CodeWorkspaceState | null>(null)
  const [codeWorkspaceApproval, setCodeWorkspaceApproval] = useState<CodeWorkspaceApprovalRequest | null>(null)
  const [workspaceSidebarOpen, setWorkspaceSidebarOpen] = useState(false)
  const [codeWorkspacePanelOpen, setCodeWorkspacePanelOpen] = useState(false)
  const [codeWorkspacePanelTab, setCodeWorkspacePanelTab] = useState<CodeWorkspacePanelTab>('preview')
  const [codeWorkspaceLogs, setCodeWorkspaceLogs] = useState<string[]>([])
  const codeWorkspaceRef = useRef<CodeWorkspaceRef | null>(null)
  codeWorkspaceRef.current = codeWorkspaceState?.workspace ?? null
  const handleSelectCodeWorkspace = useCallback(async () => {
    const result = await window.electronAPI.agentWorkspace.selectWorkspace()
    if (result.success && result.state) {
      setCodeWorkspaceState(result.state)
      setCodeWorkspaceLogs(result.state.recentLogs || [])
      setAgentNotice('')
    } else if (!result.canceled) {
      setAgentNotice(`代码工作区选择失败：${result.error || '未知错误'}`)
    }
  }, [])
  const handleCodeWorkspaceApprovalPolicyChange = useCallback(async (policy: CodeWorkspaceApprovalPolicy) => {
    const result = await window.electronAPI.agentWorkspace.setApprovalPolicy(policy)
    if (result.success && result.state) {
      setCodeWorkspaceState(result.state)
      setCodeWorkspaceLogs(result.state.recentLogs || [])
      setAgentNotice('')
    } else {
      setAgentNotice(`代码权限设置失败：${result.error || '未知错误'}`)
    }
  }, [])
  const handleApproveCodeWorkspace = useCallback((requestId: string) => {
    setCodeWorkspaceApproval(null)
    void window.electronAPI.agentWorkspace.approve(requestId)
  }, [])
  const handleRejectCodeWorkspace = useCallback((requestId: string) => {
    setCodeWorkspaceApproval(null)
    void window.electronAPI.agentWorkspace.reject(requestId)
  }, [])
  const handleStopCodeDevServer = useCallback(async () => {
    const result = await window.electronAPI.agentWorkspace.stopDevServer()
    if (result.success && result.state) {
      setCodeWorkspaceState(result.state)
      setCodeWorkspaceLogs(result.state.recentLogs || [])
    } else if (!result.success) {
      setAgentNotice(`停止开发服务器失败：${result.error || '未知错误'}`)
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.agentWorkspace.getState().then((result) => {
      if (cancelled || !result.success || !result.state) return
      setCodeWorkspaceState(result.state)
      setCodeWorkspaceLogs(result.state.recentLogs || [])
    })
    const offApproval = window.electronAPI.agentWorkspace.onApprovalRequest((request) => {
      setCodeWorkspaceApproval(request)
    })
    const offEvent = window.electronAPI.agentWorkspace.onWorkspaceEvent((event: CodeWorkspaceEvent) => {
      if (event.state) {
        setCodeWorkspaceState(event.state)
        setCodeWorkspaceLogs(event.state.recentLogs || [])
      }
      if (event.log) {
        setCodeWorkspaceLogs((prev) => [...prev, event.log!].slice(-600))
      }
      if (event.type === 'preview-url') {
        setCodeWorkspacePanelTab('preview')
      }
      if (event.type === 'approval-resolved' && event.requestId) {
        setCodeWorkspaceApproval((current) => current?.requestId === event.requestId ? null : current)
      }
    })
    return () => {
      cancelled = true
      offApproval()
      offEvent()
    }
  }, [])
  const [currentProviderId, setCurrentProviderId] = useState('')
  const [currentModelId, setCurrentModelId] = useState('')
  const [currentProviderConfig, setCurrentProviderConfig] = useState<configService.AiProviderConfig | null>(null)
  const [toolElapsedByKey, setToolElapsedByKey] = useState<Record<string, number>>({})
  const [agentProgress, setAgentProgress] = useState<AgentProgressEvent[]>([])
  const [agentRunPending, setAgentRunPending] = useState(false)
  const [subAgentProgress, setSubAgentProgress] = useState<AgentProgressEvent[]>([])
  const [agentNotice, setAgentNotice] = useState('')
  const [usageDetailsModal, setUsageDetailsModal] = useState<AgentMessageMetadata | null>(null)
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null)
  const { speakingKey: speakingMessageId, speak: speakMessage, stop: stopSpeakingMessage } = useTtsSpeaker()
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
    if (presets.some((preset) => presetMatchesCurrentConfig(preset, currentProviderId, currentProviderConfig))) {
      return list
    }
    if (!currentProviderId && !currentModelId) return list
    const currentDetail = modelInfoByKey.get(`${currentProviderId}::${currentModelId}`) || modelInfoByKey.get(currentModelId)
    return [{
      chef: currentProviderId || 'custom',
      chefSlug: currentProviderId,
      id: 'current',
      name: currentModelId ? `当前配置 · ${currentModelId}` : '当前配置',
      modelDetail: currentDetail,
      disabled: currentDetail ? !currentDetail.capabilities.toolCall : false,
    }, ...list]
  }, [currentModelId, currentProviderConfig, currentProviderId, presets, modelInfoByKey])
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
  const [workspaceFileReferences, setWorkspaceFileReferences] = useState<CodeWorkspaceFileDragReference[]>([])
  const [workspaceFileDragOver, setWorkspaceFileDragOver] = useState(false)
  const [sourceNameById, setSourceNameById] = useState<Record<string, string>>({})
  const mentionOffsetRef = useRef(0)
  const mentionLoadingRef = useRef(false)
  const mentionHasMoreRef = useRef(true)
  const mentionConnectedRef = useRef(false)
  const mentionSeenRef = useRef(new Set<string>())
  const mentionSearchSeqRef = useRef(0)
  const addMention = useCallback(
    (m: MentionTarget) => setMentions((prev) => (prev.some((x) => x.username === m.username) ? prev : [...prev, m])),
    []
  )
  const removeMention = useCallback((m: MentionTarget) => {
    setMentions((prev) => prev.filter((item) => item.username !== m.username))
  }, [])
  const addWorkspaceFileReference = useCallback((ref: CodeWorkspaceFileDragReference) => {
    setWorkspaceFileReferences((prev) => (prev.some((item) => item.path === ref.path) ? prev : [...prev, ref]))
  }, [])
  const removeWorkspaceFileReference = useCallback((path: string) => {
    setWorkspaceFileReferences((prev) => prev.filter((item) => item.path !== path))
  }, [])
  useEffect(() => {
    setWorkspaceFileReferences([])
    setWorkspaceFileDragOver(false)
  }, [codeWorkspaceState?.workspace?.id])
  const handleWorkspaceFileDragOver = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setWorkspaceFileDragOver(true)
  }, [])
  const handleWorkspaceFileDragLeave = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return
    const nextTarget = event.relatedTarget as Node | null
    if (nextTarget && event.currentTarget.contains(nextTarget)) return
    setWorkspaceFileDragOver(false)
  }, [])
  const handleWorkspaceFileDrop = useCallback((event: DragEvent<HTMLFormElement>) => {
    if (!hasWorkspaceFileDrag(event.dataTransfer)) return
    event.preventDefault()
    setWorkspaceFileDragOver(false)
    const ref = parseWorkspaceFileDragPayload(event.dataTransfer.getData(CODE_WORKSPACE_FILE_REF_MIME))
    if (ref) addWorkspaceFileReference(ref)
  }, [addWorkspaceFileReference])
  const processedPersonaActionsRef = useRef(new Set<string>())
  // 单个 @ → 锁定该会话 scope；多个/零个 → 全局（多个走消息注入，见 handleSubmit）
  const scopeRef = useRef<AgentScope>({ kind: 'global' })
  const submitScopeRef = useRef<AgentScope | null>(null)
  const activeScopeRef = useRef<AgentScope>({ kind: 'global' })
  scopeRef.current =
    mentions.length === 1
      ? { kind: 'session', sessionId: mentions[0].username, displayName: mentions[0].displayName }
      : { kind: 'global' }

  const handleAgentProgress = useCallback((progress: AgentProgressEvent) => {
    const displayProgress = shouldDisplayAgentProgress(progress)
    // 准备阶段的 run_started 步骤只进执行过程链，不推桌宠气泡。
    const petWorthy = progress.stage !== 'run_started'
    if ((progress.depth ?? 0) === 0 && petWorthy && (displayProgress || progress.stage === 'run_finished' || progress.stage === 'error')) {
      window.electronAPI.pet.sendAgentProgress({
        stage: progress.stage,
        title: progress.stage === 'run_finished' && !displayProgress ? 'AI 助手已完成' : progress.title,
        detail: progress.detail,
      })
    }
    if ((progress.depth ?? 0) > 0) {
      if (displayProgress) setSubAgentProgress((prev) => mergeSubAgentProgress(prev, progress))
    } else {
      if (displayProgress) {
        setAgentProgress((prev) => {
          const withoutLocalPending = prev.filter((item) => item.title !== AGENT_PENDING_TITLE)
          return mergeSubAgentProgress(withoutLocalPending, progress)
        })
      }
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
    if (!text) return
    void speakMessage(messageId, text)
  }, [speakMessage])

  useEffect(() => {
    return () => { stopSpeakingMessage() }
  }, [stopSpeakingMessage])
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
      () => (codeWorkspaceRef.current ? 'hybrid' : 'chat') as AgentToolProfile,
      () => codeWorkspaceRef.current,
    ),
    [handleAgentProgress]
  )
  // 流式 chunk 合并到每 50ms 更新一次 UI，避免 token 级高频重渲染拖卡滚动
  const { messages, sendMessage, setMessages, status, stop } = useChat({ transport, experimental_throttle: 50 })
  const [modelOpen, setModelOpen] = useState(false)
  const busy = status === 'submitted' || status === 'streaming'
  const [memoryIntroStatus, setMemoryIntroStatus] = useState<AgentMemoryIntroStatus>('checking')
  const markMemoryIntroSatisfied = useCallback(() => {
    setMemoryIntroStatus('hidden')
  }, [])
  useEffect(() => {
    let cancelled = false
    void window.electronAPI.memory.list({
      sourceTypes: ['profile', 'fact', 'relationship'],
      limit: 1,
    })
      .then((res) => {
        if (cancelled) return
        const hasUserMemory = res.success && Array.isArray(res.items) && res.items.length > 0
        setMemoryIntroStatus(hasUserMemory ? 'hidden' : 'needed')
      })
      .catch(() => {
        if (!cancelled) setMemoryIntroStatus('hidden')
      })
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    if (!busy && !agentRunPending) return
    for (const message of messages) {
      if (message.role !== 'assistant') continue
      for (let index = 0; index < message.parts.length; index += 1) {
        const output = getPersonaControlOutput(message.parts[index])
        if (!output?.success || !output.action || !output.sessionId) continue
        const key = `${message.id}:${index}:${output.action}:${output.sessionId}`
        if (processedPersonaActionsRef.current.has(key)) continue
        processedPersonaActionsRef.current.add(key)

        const displayName = output.displayName || output.sessionId
        if (output.action === 'open_persona_chat') {
          setAgentNotice(`正在打开「${displayName}」的数字分身...`)
          void window.electronAPI.window.openPersonaChatWindow(output.sessionId)
            .then(() => setAgentNotice(`已打开「${displayName}」的数字分身。`))
            .catch((error) => setAgentNotice(error instanceof Error ? error.message : '打开数字分身失败'))
          continue
        }

        if (output.action === 'build_session_vectors') {
          setAgentNotice(`正在为「${displayName}」建立语义索引...`)
          void window.electronAPI.embedding.buildSession(output.sessionId)
            .then((result) => {
              setAgentNotice(result.success
                ? `「${displayName}」的语义索引已建立。`
                : `语义索引建立失败：${result.error || '未知错误'}`)
            })
            .catch((error) => setAgentNotice(error instanceof Error ? error.message : '语义索引建立失败'))
          continue
        }

        if (output.action === 'build_persona') {
          setAgentNotice(`正在克隆「${displayName}」的数字分身...`)
          void window.electronAPI.persona.build({ sessionId: output.sessionId, displayName })
            .then((result) => {
              setAgentNotice(result.success
                ? `「${displayName}」的数字分身已创建成功。请重新说「打开${displayName}数字分身」进入对话。`
                : `数字分身克隆失败：${result.error || '未知错误'}`)
            })
            .catch((error) => setAgentNotice(error instanceof Error ? error.message : '数字分身克隆失败'))
        }
      }
    }
  }, [agentRunPending, busy, messages])
  // 模型空窗期：流已建立（status=streaming）但助手消息还没有任何可见输出（最多只有 step-start），
  // 即"模型首 token 还没到"——这段最长可达十几秒，用轮播文案兜住
  const lastMessageForWait = messages[messages.length - 1]
  const waitingFirstModelOutput = busy && (
    !lastMessageForWait
    || lastMessageForWait.role === 'user'
    || (lastMessageForWait.role === 'assistant' && !lastMessageForWait.parts.some((part) => part.type !== 'step-start'))
  )
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
    && ((status !== 'streaming' && (status === 'submitted' || agentRunPending)) || waitingFirstModelOutput)
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
  // Agent 运行状态 → 桌宠动作：跑→run，报错→failed，收尾→done(挥手 2.6s)。
  const petAgentState = busy ? 'running' : agentNotice ? 'failed' : 'idle'
  const petPrevBusyRef = useRef(false)
  useEffect(() => {
    if (petAgentState === 'idle' && petPrevBusyRef.current) {
      window.electronAPI.pet?.setAgentState('done')
      const timer = window.setTimeout(() => {
        window.electronAPI.pet?.setAgentState('idle')
      }, 2600)
      petPrevBusyRef.current = false
      return () => window.clearTimeout(timer)
    }
    petPrevBusyRef.current = petAgentState === 'running'
    window.electronAPI.pet?.setAgentState(petAgentState)
  }, [petAgentState])

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
    if (mentionLoadingRef.current) {
      console.info('[AgentMention][renderer] load skipped: already loading')
      return
    }
    mentionLoadingRef.current = true
    setMentionLoading(true)
    const chat = (window as any)?.electronAPI?.chat
    const offset = mentionOffsetRef.current

    console.info('[AgentMention][renderer] load start', {
      offset,
      limit: MENTION_SESSION_PAGE_SIZE,
      knownSessions: sessions.length,
      hasMore: mentionHasMoreRef.current,
      connected: mentionConnectedRef.current,
      hasChatApi: !!chat,
      hasGetMentionTargets: !!chat?.getMentionTargets,
    })

    try {
      if (!mentionConnectedRef.current) {
        try {
          const connectResult = await chat?.connect?.()
          console.info('[AgentMention][renderer] chat connect result', {
            success: connectResult?.success,
            error: connectResult?.error,
          })
        } catch (error) {
          console.warn('[AgentMention][renderer] chat connect threw', { error: String(error) })
        }
        mentionConnectedRef.current = true
      }

      const res = await chat?.getMentionTargets?.(offset, MENTION_SESSION_PAGE_SIZE)
      console.info('[AgentMention][renderer] load result', {
        success: res?.success,
        sessions: Array.isArray(res?.sessions) ? res.sessions.length : null,
        hasMore: res?.hasMore,
        error: res?.error,
      })
      if (res?.success && Array.isArray(res.sessions)) {
        appendMentionTargets(
          res.sessions
            .map((s: any) => toMentionTarget(s.username, s.displayName, s.avatarUrl))
        )
        mentionOffsetRef.current = offset + MENTION_SESSION_PAGE_SIZE
        updateMentionHasMore(!!res.hasMore)
        return
      }
      updateMentionHasMore(sessions.length === 0)
    } catch (error) {
      console.warn('[AgentMention][renderer] load threw', { error: String(error) })
      updateMentionHasMore(sessions.length === 0)
    } finally {
      mentionLoadingRef.current = false
      setMentionLoading(false)
    }
  }, [appendMentionTargets, sessions.length, updateMentionHasMore])

  const searchMentionSessions = useCallback(async (query: string) => {
    const keyword = query.trim()
    if (!keyword) return
    const seq = ++mentionSearchSeqRef.current
    const chat = (window as any)?.electronAPI?.chat
    setMentionLoading(true)
    console.info('[AgentMention][renderer] search start', {
      seq,
      keywordLength: keyword.length,
      limit: MENTION_SESSION_PAGE_SIZE,
      connected: mentionConnectedRef.current,
      hasChatApi: !!chat,
      hasGetMentionTargets: !!chat?.getMentionTargets,
    })

    try {
      if (!mentionConnectedRef.current) {
        try {
          const connectResult = await chat?.connect?.()
          console.info('[AgentMention][renderer] search connect result', {
            seq,
            success: connectResult?.success,
            error: connectResult?.error,
          })
        } catch (error) {
          console.warn('[AgentMention][renderer] search connect threw', { seq, error: String(error) })
        }
        mentionConnectedRef.current = true
      }

      const res = await chat?.getMentionTargets?.(0, MENTION_SESSION_PAGE_SIZE, keyword)
      console.info('[AgentMention][renderer] search result', {
        seq,
        latestSeq: mentionSearchSeqRef.current,
        success: res?.success,
        sessions: Array.isArray(res?.sessions) ? res.sessions.length : null,
        hasMore: res?.hasMore,
        error: res?.error,
      })
      if (seq === mentionSearchSeqRef.current && res?.success && Array.isArray(res.sessions)) {
        appendMentionTargets(
          res.sessions.map((s: any) => toMentionTarget(s.username, s.displayName, s.avatarUrl))
        )
      }
    } catch (error) {
      console.warn('[AgentMention][renderer] search threw', { seq, error: String(error) })
    } finally {
      if (seq === mentionSearchSeqRef.current) setMentionLoading(false)
    }
  }, [appendMentionTargets])

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

  const slashCommands = useMemo<SlashCommandItem[]>(() => [
    {
      id: 'status',
      commands: ['/status'],
      aliases: ['zhuangtai', '状态'],
      label: '查看状态',
      description: '显示模型、工作区、预览和 token 状态',
      icon: Info,
      action: () => {
        const workspace = codeWorkspaceState?.workspace
        const devServer = codeWorkspaceState?.devServer
        const tokenLine = conversationUsage.hasAny
          ? `Token：输入 ${formatTokenCount(conversationUsage.input)}，输出 ${formatTokenCount(conversationUsage.output)}，共 ${formatTokenCount(conversationUsage.total)}`
          : 'Token：暂无本次会话用量'
        setAgentNotice([
          '状态：',
          `模型：${selectedModelData?.name || '未选择'}`,
          `工作区：${workspace ? displayBasename(workspace.root) : '未选择'}`,
          `开发服务器：${devServer?.running ? (devServer.previewUrl || devServer.command || '运行中') : '未运行'}`,
          `联网搜索：${webSearchOn ? '已开启' : '未开启'}`,
          `计划模式：${planMode ? '已开启' : '未开启'}`,
          tokenLine,
        ].join('\n'))
      },
    },
    {
      id: 'plan',
      commands: ['/plan'],
      aliases: ['jihua', '计划'],
      label: planMode ? '关闭计划模式' : '开启计划模式',
      description: '切换下一轮是否先生成执行计划',
      icon: ListChecks,
      action: () => setPlanMode((value) => !value),
    },
    {
      id: 'clear',
      commands: ['/clear', '/new'],
      aliases: ['qingkong', 'xin', '清空', '新对话'],
      label: '新对话 / 清空',
      description: '清空当前线程并回到新对话',
      icon: SquarePen,
      action: handleNewConversation,
    },
    {
      id: 'workspace',
      commands: ['/workspace'],
      aliases: ['code', 'files', '工作区', '文件'],
      label: '打开工作区',
      description: '打开左侧文件树和工作区选择',
      icon: PanelLeft,
      action: () => setWorkspaceSidebarOpen(true),
    },
    {
      id: 'preview',
      commands: ['/preview'],
      aliases: ['yulan', '预览'],
      label: '打开预览',
      description: '打开代码工作区预览面板',
      icon: Monitor,
      action: () => {
        setCodeWorkspacePanelTab('preview')
        setCodeWorkspacePanelOpen(true)
      },
    },
    {
      id: 'logs',
      commands: ['/logs'],
      aliases: ['rizhi', 'terminal', '日志', '终端'],
      label: '打开日志',
      description: '打开开发服务器日志面板',
      icon: Terminal,
      action: () => {
        setCodeWorkspacePanelTab('logs')
        setCodeWorkspacePanelOpen(true)
      },
    },
    {
      id: 'model',
      commands: ['/model'],
      aliases: ['moxing', '模型'],
      label: '选择模型',
      description: '打开模型和思考强度选择',
      icon: Brain,
      action: () => setModelOpen(true),
    },
    {
      id: 'search',
      commands: ['/search'],
      aliases: ['web', '联网', '搜索'],
      label: webSearchOn ? '关闭联网搜索' : '开启联网搜索',
      description: '切换 Tavily 联网搜索工具',
      icon: Globe,
      action: () => toggleWebSearch(),
    },
  ], [
    codeWorkspaceState,
    conversationUsage,
    handleNewConversation,
    planMode,
    selectedModelData,
    toggleWebSearch,
    webSearchOn,
  ])

  const slashCommandByName = useMemo(() => {
    const map = new Map<string, SlashCommandItem>()
    for (const command of slashCommands) {
      for (const name of command.commands) map.set(name.toLowerCase(), command)
    }
    return map
  }, [slashCommands])

  const runSlashCommandText = useCallback(async (value: string) => {
    const match = value.trim().match(/^\/[^\s/]+$/)
    if (!match) return false
    const command = slashCommandByName.get(match[0].toLowerCase())
    if (!command) return false
    await command.action()
    return true
  }, [slashCommandByName])

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
      setCurrentProviderConfig(currentConfig)
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
    const currentMentions = mentions
    if (message.files.length === 0 && currentMentions.length === 0 && workspaceFileReferences.length === 0 && await runSlashCommandText(message.text)) {
      return
    }
    if (!selectedModelSupportsTools) {
      setAgentNotice('当前模型不支持工具调用，无法查询本地聊天记录。请切换到带“工具调用”能力的模型。')
      return
    }
    const isFirstUserMessage = messages.length === 0
    const firstMessageForTitle = message.text.trim()
    let text = message.text.trim()
    const currentWorkspaceFileReferences = workspaceFileReferences
    if (currentMentions.length > 0) {
      const mentionLine = currentMentions.map((m) => `@${m.displayName}[${m.username}]`).join(' ')
      text = text ? `${mentionLine}\n${text}` : mentionLine
    }
    if (currentWorkspaceFileReferences.length > 0) {
      const workspaceFilePrefix = buildWorkspaceFilePrefix(currentWorkspaceFileReferences)
      text = text ? `${workspaceFilePrefix}\n${text}` : workspaceFilePrefix
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
    setAgentProgress([])
    setAgentRunPending(true)
    setSubAgentProgress([])

    try {
      const titleText = firstMessageForTitle || currentWorkspaceFileReferences.map((ref) => ref.name || displayBasename(ref.path)).join(' ')
      if (!conversationIdRef.current) {
        const fallback = buildFallbackConversationTitle(titleText || text)
        setConversationTitle(fallback)
        await createConversation(submitScope, fallback)
      }

      if (isFirstUserMessage) generateTitleFromFirstMessage(titleText || text)

      const sendPromise = Promise.resolve(sendMessage({ text, files: message.files })).finally(() => {
        submitScopeRef.current = null
        setAgentRunPending(false)
      })
      void sendPromise
      setMentions([])
      setWorkspaceFileReferences([])
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

    stopSpeakingMessage()
    setAgentNotice('')
    setAgentProgress([])
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
    setAgentProgress([])
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
    const model = models.find((item) => item.id === id)
    if (!model || model.disabled) return
    setSelectedPresetId(id)
    setModelOpen(false)
  }, [models])

  const handleReasoningEffortSelect = useCallback((value: string) => {
    if (!REASONING_EFFORT_OPTIONS.some((option) => option.value === value)) return
    setReasoningEffort(value as AgentReasoningEffort)
    setModelOpen(false)
  }, [])

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
      className="relative flex h-full min-h-0 flex-col overflow-hidden"
      style={{ '--agent-radius': '12px' } as CSSProperties}
      variant="transparent"
    >
      <div className="relative flex h-14 shrink-0 items-center justify-center border-b border-border/60 px-3">
        <div className="absolute left-3 top-1/2 flex -translate-y-1/2 items-center">
          <Tooltip delay={0}>
            <HeroButton
              aria-label="工作区文件树"
              className="size-9 p-0"
              isIconOnly
              onPress={() => setWorkspaceSidebarOpen((open) => !open)}
              size="md"
              variant={workspaceSidebarOpen ? 'secondary' : 'tertiary'}
            >
              <PanelLeft className="size-[18px]" />
            </HeroButton>
            <Tooltip.Content placement="bottom">{workspaceSidebarOpen ? '隐藏工作区文件树' : '显示工作区文件树'}</Tooltip.Content>
          </Tooltip>
        </div>
        <div className="absolute left-1/2 top-1/2 min-w-0 max-w-[min(36rem,calc(100%_-_14rem))] -translate-x-1/2 -translate-y-1/2">
          {titleEditing ? (
            <input
              aria-label="编辑对话名称"
              className="h-9 w-90 max-w-[calc(100vw_-_14rem)] rounded-(--agent-radius,12px) border border-border bg-background px-3 text-center font-medium text-foreground text-sm outline-none focus:border-ring focus:ring-[3px] focus:ring-ring/30"
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
            <Tooltip delay={0}>
              <button
                className="group inline-flex h-9 min-w-0 max-w-full items-center justify-center gap-1.5 rounded-(--agent-radius,12px) px-3 text-center hover:bg-accent/40"
                onClick={beginTitleEdit}
                type="button"
              >
                <span className="truncate font-medium text-sm text-foreground">
                  {titleSaving ? '保存中...' : titleLoading ? '生成标题中...' : conversationTitle}
                </span>
                <PenLine className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </button>
              <Tooltip.Content placement="bottom">
                {titleLoading ? '正在生成标题' : `编辑对话名称：${conversationTitle}`}
              </Tooltip.Content>
            </Tooltip>
          )}
        </div>
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          <Toolbar aria-label="对话操作" className="gap-1.5 p-0">
            <CodeWorkspacePanelPopover
              activeTab={codeWorkspacePanelTab}
              isOpen={codeWorkspacePanelOpen}
              logs={codeWorkspaceLogs}
              onActiveTabChange={setCodeWorkspacePanelTab}
              onOpenChange={setCodeWorkspacePanelOpen}
              onStopDevServer={handleStopCodeDevServer}
              state={codeWorkspaceState}
            />
            <div className="flex items-center gap-1.5">
              <Dropdown isOpen={recordsOpen} onOpenChange={setRecordsOpen}>
                <HeroButton
                  aria-label="对话记录"
                  className="size-9 p-0"
                  isIconOnly
                  render={(buttonProps) => <button {...buttonProps} title="对话记录" />}
                  size="md"
                  variant="tertiary"
                >
                  <History className="size-[18px]" />
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
              <Tooltip delay={0}>
                <HeroButton
                  aria-label="新建对话"
                  className="size-9 p-0"
                  isIconOnly
                  onPress={handleNewConversation}
                  size="md"
                  variant="tertiary"
                >
                  <SquarePen className="size-[18px]" />
                </HeroButton>
                <Tooltip.Content placement="bottom">新建对话</Tooltip.Content>
              </Tooltip>
            </div>
          </Toolbar>
        </div>
      </div>
      {memoryIntroStatus === 'checking' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
          <Loader />
        </div>
      ) : memoryIntroStatus === 'needed' ? (
        <AgentMemoryIntro onMemoryCreated={markMemoryIntroSatisfied} />
      ) : (
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {workspaceSidebarOpen && (
            <CodeWorkspaceSidebar
              onSelect={handleSelectCodeWorkspace}
              state={codeWorkspaceState}
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <Conversation className="min-h-0 flex-1">
        <ConversationAutoScroll enabled={shouldAnchorLatestUser} trigger={latestUserMessageId} />
        <ConversationContent
          className={
            messages.length === 0
              ? 'mx-auto h-full w-full min-w-80 max-w-[82%] pt-4 pb-12'
              : 'mx-auto w-full min-w-80 max-w-[82%] pt-4 pb-12'
          }
        >
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="开始查询聊天记录"
              description="输入问题后，助手会基于本地聊天数据回答"
            />
          ) : (
            messages.map((message, messageIndex) => {
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
              const orderedSegments = buildRenderSegments(message.parts)
              const userFileParts = message.role === 'user'
                ? message.parts
                  .map((part, index) => ({ part, index }))
                  .filter((item): item is { part: Extract<UIMessage['parts'][number], { type: 'file' }>; index: number } => item.part.type === 'file')
                : []
              const hasRenderableUserText = message.role === 'user'
                && message.parts.some((part, index) => {
                  if (part.type !== 'text') return false
                  const displayText = userDisplay?.textByPartIndex.get(index) ?? part.text
                  return Boolean(displayText.trim())
                })
              const shouldRenderMessageContent = message.role !== 'user' || hasRenderableUserText
              // generate_image / send_sticker / send_random_image 的产出图：正文区直接展示
              const renderGeneratedImageTool = (part: AgentMessagePart, index: number) => {
                if (!isAgentChainPart(part)) return null
                const isSticker = part.type === 'tool-send_sticker'
                const isRandomImage = part.type === 'tool-send_random_image'
                const isGenerated = part.type === 'tool-generate_image'
                if ((!isSticker && !isRandomImage && !isGenerated) || part.state !== 'output-available') return null
                const output = part.output as { filePath?: unknown; from?: unknown; sender?: unknown; time?: unknown } | undefined
                const filePath = String(output?.filePath || '')
                if (!filePath) return null
                const imageSrc = `local-image://${encodeURIComponent(filePath)}`
                const caption = isRandomImage
                  ? [output?.sender, output?.from, output?.time].map((v) => String(v || '')).filter(Boolean).join(' · ')
                  : ''
                return (
                  <div className="mt-1 w-fit" key={`genimg-${index}`}>
                    <button
                      className="block w-fit cursor-pointer border-0 bg-transparent p-0 text-left"
                      onClick={(event) => {
                        const rect = event.currentTarget.getBoundingClientRect()
                        setGeneratedImagePreview({
                          src: imageSrc,
                          originRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
                        })
                      }}
                      title="点击预览"
                      type="button"
                    >
                      <img
                        alt={isSticker ? '表情包' : isRandomImage ? '聊天记录里的图片' : 'AI 生成的图片'}
                        className={isSticker
                          ? 'max-h-40 max-w-40 rounded-(--agent-radius,12px)'
                          : 'max-h-90 max-w-full rounded-(--agent-radius,12px) border border-border/60 shadow-xs'}
                        src={imageSrc}
                      />
                    </button>
                    {caption && (
                      <div className="mt-1 text-muted-foreground text-xs">{caption}</div>
                    )}
                  </div>
                )
              }
              const renderChainSegment = (segment: Array<{ part: AgentChainPart; index: number }>, segmentActive: boolean) => (
                <MessageChainOfThought active={segmentActive} key={`chain-${segment[0]?.index ?? 0}`}>
                  {segment.map(({ part, index }) => {
                    if (part.type === 'reasoning') {
                      const reasoningActive = isReasoningStreaming && index === message.parts.length - 1
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
                    const done = part.state === 'output-available' || part.state === 'output-error' || part.state === 'output-denied'
                    const toolLabel = formatToolName(toolName)
                    const elapsedMs = toolElapsedByKey[toolPartProgressKey(part, toolName)]
                    const stateLabel = part.state === 'approval-requested'
                      ? '等待确认'
                      : part.state === 'approval-responded'
                        ? '已确认'
                        : part.state === 'output-denied'
                          ? '已拒绝'
                          : ''
                    const label = [
                      toolLabel,
                      done && elapsedMs ? formatElapsed(elapsedMs) : stateLabel,
                    ].filter(Boolean).join(' · ')
                    const badges = collectToolBadges(part.input)
                    const delegateTasks = toolName === 'delegate_analysis' ? getDelegateTasks(part) : undefined
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
                        {part.state === 'output-denied' && (
                          <p className="text-muted-foreground text-xs">用户拒绝了这次工具操作。</p>
                        )}
                        {toolName === 'delegate_analysis' && subAgentEventsForMessage.length > 0 && (
                          <SubAgentProgressPanel events={subAgentEventsForMessage} tasks={delegateTasks} />
                        )}
                      </ChainOfThoughtStep>
                    )
                  })}
                </MessageChainOfThought>
              )
              return (
                <Message from={message.role} key={message.id}>
                  {userDisplay && <MentionTargetChips align="end" targets={userDisplay.mentions} />}
                  {userDisplay && <WorkspaceFileReferenceChips align="end" refs={userDisplay.workspaceFiles} />}
                  {userFileParts.length > 0 && (
                    <MessageAttachments className="justify-end">
                      {userFileParts.map(({ part, index }) => (
                        <MessageAttachment data={part} key={`user-file-${index}`} />
                      ))}
                    </MessageAttachments>
                  )}
                  {shouldRenderMessageContent && (
                    <MessageContent>
                      {isPlanMessage && assistantDisplayText && (
                        <PlanCard streaming={assistantTextStreaming} text={assistantDisplayText} />
                      )}
                      {orderedSegments.map((segment, segmentIndex) => {
                        const isLastSegment = segmentIndex === orderedSegments.length - 1
                        if (segment.kind === 'chain') {
                          // 只有位于消息末尾、还在运行中的执行过程块保持展开；后面已经出正文的块自动收起。
                          const segmentActive = chainActive && isLastSegment
                          return (
                            <div className="space-y-2" key={`chain-${segment.items[0]?.index ?? 0}`}>
                              {renderChainSegment(segment.items, segmentActive)}
                              {segment.items.map(({ part, index }) => renderGeneratedImageTool(part, index))}
                            </div>
                          )
                        }
                        const { part, index } = segment
                        if (part.type === 'text') {
                          // 计划消息的正文已经在 PlanCard 里展示，这里不再重复渲染。
                          if (isPlanMessage) return null
                          const displayText = userDisplay?.textByPartIndex.get(index) ?? part.text
                          if (!displayText) return null
                          return (
                            <MessageResponse
                              isStreaming={assistantTextStreaming && isLastSegment}
                              key={`text-${index}`}
                              showStreamingIndicator={false}
                            >
                              {displayText}
                            </MessageResponse>
                          )
                        }
                        if (part.type === 'file') {
                          if (message.role === 'user') return null
                          return (
                            <MessageAttachments key={`file-${index}`}>
                              <MessageAttachment data={part} />
                            </MessageAttachments>
                          )
                        }
                        return null
                      })}
                      {outputActivitySteps.length > 0 && (
                        <MessageChainOfThought active={chainActive}>
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
                      {assistantTextStreaming && <MessageStreamingIndicator />}
                      {message.role === 'assistant' && (
                        <MessageSources items={extractSources(message.parts)} nameOf={sessionNameOf} />
                      )}
                      {message.role === 'assistant' && !(isLastMessage && busy) && (
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
                  )}
                </Message>
              )
            })
          )}
          {showAgentProgressChain && (
            <Message from="assistant">
              <MessageContent>
                <AgentProgressChain
                  active={status === 'submitted' || agentRunPending || waitingFirstModelOutput}
                  events={agentProgress}
                  waiting={waitingFirstModelOutput}
                />
              </MessageContent>
            </Message>
          )}
          {agentNotice && (
            <div
              className={`mt-3 whitespace-pre-line rounded-(--agent-radius,12px) border px-3 py-2 text-xs ${
                agentNotice.startsWith('状态：')
                  ? 'border-border bg-muted/35 text-muted-foreground'
                  : 'border-destructive/30 bg-destructive/5 text-destructive'
              }`}
            >
              {agentNotice}
            </div>
          )}
          {busy && subAgentProgress.length > 0 && !lastAssistantMessageHasDelegateTool && <SubAgentProgressPanel events={subAgentProgress} />}
          {status === 'submitted' && agentProgress.length === 0 && <Loader />}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="shrink-0 pt-2 pb-1">
        <PromptInputProvider>
          <PromptInput
            accept="image/*,.txt,.md,.json,.csv,.pdf,application/pdf"
            className={`agent-prompt-input mx-auto mb-1 w-full min-w-80 max-w-[82%] **:data-[slot=input-group]:rounded-(--agent-radius,12px) **:data-[slot=input-group]:border-border **:data-[slot=input-group]:bg-surface **:data-[slot=input-group]:shadow-xs ${workspaceFileDragOver ? '**:data-[slot=input-group]:ring-2 **:data-[slot=input-group]:ring-primary/45' : ''}`}
            maxFiles={6}
            maxFileSize={8 * 1024 * 1024}
            multiple
            onDragLeave={handleWorkspaceFileDragLeave}
            onDragOver={handleWorkspaceFileDragOver}
            onDrop={handleWorkspaceFileDrop}
            onSubmit={handleSubmit}
            style={{ '--agent-radius': '22px' } as CSSProperties}
          >
            <AgentPromptAssetHeader
              onRemoveWorkspaceFileReference={removeWorkspaceFileReference}
              workspaceFileReferences={workspaceFileReferences}
            />

            <PromptInputBody>
              <MentionField
                hasMore={mentionHasMore}
                isLoading={mentionLoading}
                mentions={mentions}
                onAdd={addMention}
                onLoadMore={loadMentionSessions}
                onRemove={removeMention}
                onSearch={searchMentionSessions}
                sessions={sessions}
              />
              <PromptInputTextarea
                className="pt-1.5 pb-2"
                placeholder="问问你的聊天记录，Enter 发送，Shift + Enter 换行…"
              />
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
                  <PromptPresetButton showGroupSeparator />
                  <SlashCommandButton
                    commands={slashCommands}
                    showGroupSeparator
                  />
                  <MentionTriggerButton showGroupSeparator />
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

                {codeWorkspaceState?.workspace && (
                  <CodeWorkspaceApprovalPolicyDropdown
                    policy={codeWorkspaceState.workspace.approvalPolicy}
                    onChange={handleCodeWorkspaceApprovalPolicyChange}
                  />
                )}
              </PromptInputTools>

              <div className="flex items-center gap-2">
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
                  <Dropdown.Popover className="max-h-96 min-w-72 overflow-y-auto" placement="top end">
                    <Dropdown.Menu
                      disabledKeys={disabledModelKeys}
                      selectedKeys={selectedModelKeys}
                      selectionMode="single"
                      onAction={(key) => handleModelSelect(String(key))}
                    >
                      <Dropdown.SubmenuTrigger>
                        <Dropdown.Item id="reasoning-effort" textValue="思考强度">
                          <Brain className="size-4 shrink-0 text-muted" />
                          <Label className="min-w-0 flex-1 text-left">思考强度</Label>
                          <span className="shrink-0 text-muted-foreground text-xs">
                            {reasoningEffortLabel(reasoningEffort, true)}
                          </span>
                          <Dropdown.SubmenuIndicator />
                        </Dropdown.Item>
                        <Dropdown.Popover className="min-w-44" placement="right top">
                          <Dropdown.Menu
                            selectedKeys={new Set([reasoningEffort])}
                            selectionMode="single"
                            onAction={(key) => handleReasoningEffortSelect(String(key))}
                          >
                            {REASONING_EFFORT_OPTIONS.map((option) => (
                              <Dropdown.Item id={option.value} key={option.value} textValue={option.label}>
                                <Dropdown.ItemIndicator />
                                <Label>{option.label}</Label>
                              </Dropdown.Item>
                            ))}
                          </Dropdown.Menu>
                        </Dropdown.Popover>
                      </Dropdown.SubmenuTrigger>
                      <Separator />
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
                <ButtonGroup size="sm">
                  <AgentPromptPrimaryAction busy={busy} status={status} workspaceReferenceCount={workspaceFileReferences.length} />
                </ButtonGroup>
              </div>
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
        <div className="mx-auto flex w-full min-w-80 max-w-[82%] items-center justify-between gap-3 px-2">
          <CodeWorkspacePanel
            approval={codeWorkspaceApproval}
            className="min-w-0 flex-1"
            onApprove={handleApproveCodeWorkspace}
            onReject={handleRejectCodeWorkspace}
            onSelect={handleSelectCodeWorkspace}
            onStopDevServer={handleStopCodeDevServer}
            state={codeWorkspaceState}
          />
          {conversationUsage.hasAny && (
            <div className="ml-auto flex shrink-0 items-center justify-end gap-3 whitespace-nowrap text-[11px] text-muted-foreground">
              <span>本次会话Token用量</span>
              <span>输入 {formatTokenCount(conversationUsage.input)}</span>
              <span>输出 {formatTokenCount(conversationUsage.output)}</span>
              <span className="font-medium text-foreground/80">共 {formatTokenCount(conversationUsage.total)}</span>
            </div>
          )}
        </div>
      </div>
          </div>
        </div>
      )}
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
      {generatedImagePreview && (
        <ImagePreview
          src={generatedImagePreview.src}
          originRect={generatedImagePreview.originRect}
          onClose={() => setGeneratedImagePreview(null)}
        />
      )}
    </Surface>
  )
}
