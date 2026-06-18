/**
 * 编排引擎 —— 用 AI SDK 的 ToolLoopAgent 跑 ReAct 循环，流式产出 UIMessageChunk。
 * 运行在 AI utilityProcess 子进程内（见文档 §3.1/§5.2）。
 */
import { generateText, smoothStream, ToolLoopAgent, stepCountIs, type ModelMessage, type UIMessageChunk } from 'ai'
import type { SystemModelMessage } from '@ai-sdk/provider-utils'
import { createLanguageModel } from './provider'
import { buildAgentPromptParts, CODE_WORKSPACE_PROMPT, IMAGE_GEN_PROMPT, PLAN_MODE_PROMPT, WEB_SEARCH_PROMPT } from './prompts'
import { isWebSearchAvailable } from '../ai/webSearchService'
import { isImageGenAvailable } from '../ai/imageGenService'
import { applyAnthropicCacheControl, buildPromptCacheKey, buildProviderOptions } from './cache'
import { buildCodeOnlyTools, buildPlanModeTools, buildTools } from './tools'
import { afterTurnMemory, buildMemoryContext, preloadRelevantMemories } from './tools/memory'
import { compactMessages } from './compaction'
import { runFinalReview, summarizeToolOutput, type ToolOutputSummary } from './finalReview'
import { loopGuardCondition, withToolTimeouts } from './guards'
import { reportAgentProgress, withAgentProgress } from './progress'
import { getCachedStartupMemory, warmStartupMemory } from './runtimeCache'
import { buildToolRuntimeContext } from './toolPolicy'
import type { AgentProgressReporter, AgentProviderConfig, AgentRunInput } from './types'

const MAX_STEPS = 24
const DEFAULT_AGENT_TEMPERATURE = 0.2

type SegmenterLike = {
  segment(input: string): Iterable<unknown>
}

function createSmoothStreamChunker(): 'word' | SegmenterLike {
  const segmenterCtor = (Intl as unknown as {
    Segmenter?: new (locales?: string | string[], options?: { granularity?: 'grapheme' | 'word' | 'sentence' }) => SegmenterLike
  }).Segmenter
  return segmenterCtor ? new segmenterCtor('zh', { granularity: 'word' }) : 'word'
}

export function buildAgentInstructions(
  input: AgentRunInput,
  memoryContext: string,
  relevantMemoryContext: string,
  tools: ReturnType<typeof buildTools>,
  webSearchOn = false,
  imageGenOn = false,
): { instructions: SystemModelMessage[]; tools: ReturnType<typeof buildTools>; promptCacheKey: string } {
  const promptParts = buildAgentPromptParts(input.scope, input.skills, {
    includeWechatOutbound: input.outputMode === 'wechat',
    includeWechatReplyMedia: input.allowWechatReplyMedia === true,
  })
  const dynamicSystem = [
    promptParts.dynamicSystem,
    input.planMode ? PLAN_MODE_PROMPT : '',
    input.codeWorkspace ? CODE_WORKSPACE_PROMPT : '',
    webSearchOn ? WEB_SEARCH_PROMPT : '',
    imageGenOn ? IMAGE_GEN_PROMPT : '',
    memoryContext,
    relevantMemoryContext,
  ].filter(Boolean).join('\n')
  const instructions: SystemModelMessage[] = [
    { role: 'system', content: promptParts.cacheableSystem },
    ...(dynamicSystem ? [{ role: 'system' as const, content: dynamicSystem }] : []),
  ]
  const promptCacheKey = buildPromptCacheKey(promptParts, tools)

  if (input.providerConfig.providerKind === 'anthropic') {
    const cached = applyAnthropicCacheControl(instructions, tools)
    return { instructions: cached.messages, tools: cached.tools, promptCacheKey }
  }

  return { instructions, tools, promptCacheKey }
}

/** 取最后一条 user 消息的纯文本，供 L1 自动抽取。 */
function lastUserText(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m.role !== 'user') continue
    if (typeof m.content === 'string') return m.content
    if (Array.isArray(m.content)) {
      return m.content
        .map((p) => (p && typeof p === 'object' && 'type' in p && (p as { type?: unknown }).type === 'text'
          ? String((p as { text?: unknown }).text || '')
          : ''))
        .filter(Boolean)
        .join('\n')
    }
    return ''
  }
  return ''
}

function trackToolChunk(
  chunk: UIMessageChunk,
  toolNames: Map<string, string>,
  summaries: ToolOutputSummary[],
  pendingToolCalls?: Map<string, { toolName: string; input?: unknown }>,
): void {
  if ('toolCallId' in chunk && 'toolName' in chunk && typeof chunk.toolCallId === 'string' && typeof chunk.toolName === 'string') {
    toolNames.set(chunk.toolCallId, chunk.toolName)
  }
  if (chunk.type === 'tool-input-available') {
    pendingToolCalls?.set(chunk.toolCallId, { toolName: chunk.toolName, input: chunk.input })
    return
  }
  if (
    chunk.type === 'tool-input-error' ||
    chunk.type === 'tool-output-error' ||
    chunk.type === 'tool-output-denied'
  ) {
    pendingToolCalls?.delete(chunk.toolCallId)
    return
  }
  if (chunk.type !== 'tool-output-available') return
  pendingToolCalls?.delete(chunk.toolCallId)
  const toolName = toolNames.get(chunk.toolCallId) || 'unknown_tool'
  summaries.push(summarizeToolOutput(toolName, chunk.output))
}

function hasToolEvidence(summaries: ToolOutputSummary[]): boolean {
  return summaries.some((summary) => (
    summary.evidence.length > 0 ||
    Object.values(summary.counts).some((count) => count > 0)
  ))
}

function shouldRunFinalReview(userText: string, assistantText: string, summaries: ToolOutputSummary[]): boolean {
  if (!hasToolEvidence(summaries)) return false
  const text = `${userText}\n${assistantText}`
  return /聊天|消息|记录|朋友圈|群|联系人|谁|哪个|哪里|什么时候|时间|提到|说过|统计|排行|最近|今天|昨天|\d{4}[-/年]\d{1,2}/.test(text)
}

function withCacheHitRate(usage: unknown): unknown {
  if (!usage || typeof usage !== 'object') return usage
  const inputTokens = Number((usage as { inputTokens?: unknown }).inputTokens)
  const details = (usage as { inputTokenDetails?: { cacheReadTokens?: unknown } }).inputTokenDetails
  const cacheReadTokens = Number(details?.cacheReadTokens)
  const cacheHitRate = Number.isFinite(inputTokens) && inputTokens > 0 && Number.isFinite(cacheReadTokens)
    ? cacheReadTokens / inputTokens
    : undefined
  return cacheHitRate === undefined ? usage : { ...(usage as Record<string, unknown>), cacheHitRate }
}

function appendFinalReviewCorrection(
  review: { evidenceScore: number; issues: string[]; correction?: string },
  onChunk: (chunk: UIMessageChunk) => void,
): string {
  const correction = String(review.correction || '').trim()
  if (!correction) return ''
  const toolCallId = `final-review-${Date.now()}`
  const textId = `${toolCallId}-text`
  const appendText = `\n\n> 核查修正：${correction}`

  onChunk({ type: 'start-step' })
  onChunk({
    type: 'tool-input-available',
    toolCallId,
    toolName: 'final_review',
    input: { evidenceScore: review.evidenceScore },
  })
  onChunk({
    type: 'tool-output-available',
    toolCallId,
    output: {
      status: 'needs_correction',
      evidenceScore: review.evidenceScore,
      issues: review.issues,
      correction,
    },
  })
  onChunk({ type: 'finish-step' })

  onChunk({ type: 'text-start', id: textId })
  onChunk({ type: 'text-delta', id: textId, delta: appendText })
  onChunk({ type: 'text-end', id: textId })
  return appendText
}

/**
 * L1 自动记忆：主回答流完后抽取稳定事实写库，并把每条写入作为合成 auto_memory 工具 part 注入思考链
 * （static 工具形态 tool-input/output-available，前端 isToolUIPart 可识别）。失败静默。
 */
async function injectAutoMemories(
  assistantText: string,
  input: AgentRunInput,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const userText = lastUserText(input.messages)
    const auto = await afterTurnMemory({
      scope: input.scope,
      providerConfig: input.providerConfig,
      userText,
      assistantText,
      signal,
    })
    if (auto.length === 0) return
    onChunk({ type: 'start-step' })
    for (const m of auto) {
      const toolCallId = `automem-${m.id}`
      onChunk({ type: 'tool-input-available', toolCallId, toolName: 'auto_memory', input: { content: m.content, kind: m.kind, importance: m.importance } })
      onChunk({ type: 'tool-output-available', toolCallId, output: { remembered: true, source: 'auto', id: m.id } })
    }
    onChunk({ type: 'finish-step' })
  } catch {
    /* 自动记忆失败不影响主回答 */
  }
}

export async function runAgent(
  input: AgentRunInput,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
  onProgress?: AgentProgressReporter,
): Promise<void> {
  await withAgentProgress(onProgress, async () => {
    // 子进程侧耗时打点：stdout 会被主进程转发到控制台，配合主进程 [agent:perf] 看完整时间线
    const perfStart = Date.now()
    let perfLast = perfStart
    const perf = (label: string, detail?: string) => {
      const now = Date.now()
      console.info(`[agent:perf:child] ${label} +${now - perfLast}ms，累计 ${now - perfStart}ms${detail ? `（${detail}）` : ''}`)
      perfLast = now
    }
    const userText = lastUserText(input.messages)
    const cachedMemoryContext = getCachedStartupMemory(input.scope)
    const memoryContext = cachedMemoryContext ?? ''
    if (cachedMemoryContext === null) {
      warmStartupMemory(input.scope, () => buildMemoryContext(input.scope))
    }
    perf('记忆上下文', cachedMemoryContext === null ? '未命中缓存，后台补建' : '缓存命中')
    const relevantMemoryContext = await preloadRelevantMemories(userText, input.scope)
    const toolsDisabled = input.toolMode === 'disabled'
    const webSearchOn = !toolsDisabled && isWebSearchAvailable()
    const imageGenOn = !toolsDisabled && isImageGenAvailable()
    const toolProfile = input.toolProfile ?? (input.codeWorkspace ? 'hybrid' : 'chat')
    const codeWorkspace = (toolProfile === 'code' || toolProfile === 'hybrid') ? (input.codeWorkspace ?? null) : null
    const baseTools = toolsDisabled
      ? {}
      : withToolTimeouts(input.planMode
        ? buildPlanModeTools(input.scope, codeWorkspace)
        : toolProfile === 'code'
          ? buildCodeOnlyTools(codeWorkspace, webSearchOn, imageGenOn)
          : buildTools(input.scope, input.providerConfig, input.mcpTools, webSearchOn, imageGenOn, codeWorkspace, {
            allowWechatReplyMedia: input.allowWechatReplyMedia === true,
            uploadedMediaContext: input.uploadedMediaContext,
          }))
    perf('构建工具集', `${Object.keys(baseTools).length} 个`)
    const prepared = buildAgentInstructions(input, memoryContext, relevantMemoryContext, baseTools, webSearchOn, imageGenOn)
    perf('组装系统提示')
    const agent = new ToolLoopAgent({
      model: createLanguageModel(input.providerConfig),
      instructions: prepared.instructions,
      tools: prepared.tools,
      temperature: DEFAULT_AGENT_TEMPERATURE,
      // 步数上限 + 死循环检测（连续 N 步相同工具调用即停），见 guards.ts
      stopWhen: [stepCountIs(MAX_STEPS), loopGuardCondition()],
      providerOptions: buildProviderOptions(input, prepared.promptCacheKey),
      // 每步压缩上下文（裁旧工具结果/推理痕迹，见 compaction.ts）+ query_sql 执行层门控状态
      prepareStep: ({ messages, steps }) => ({
        messages: compactMessages(messages),
        experimental_context: buildToolRuntimeContext(steps),
      }),
    })

    const result = await agent.stream({
      messages: input.messages,
      abortSignal: signal,
      // 文本按词匀速放流：模型突发吐一大段时不再整块砸向 UI，而是 ~10ms/词的稳定节奏。
      // 中文没有空格，用 Intl.Segmenter 做 CJK 分词（AI SDK 官方推荐做法）。
      experimental_transform: smoothStream({
        delayInMs: 10,
        chunking: createSmoothStreamChunker(),
      }),
    })
    perf('发起模型流式请求')
    // 截留 message 的 finish，等 L1 自动记忆注入完再补发，让自动写入的工具 part 落在本条消息内
    let finishChunk: UIMessageChunk | undefined
    let perfFirstEventSeen = false
    let perfFirstOutputSeen = false
    const toolNames = new Map<string, string>()
    const toolSummaries: ToolOutputSummary[] = []
    const pendingToolCalls = new Map<string, { toolName: string; input?: unknown }>()
    for await (const chunk of result.toUIMessageStream({
      messageMetadata: ({ part }) => {
        if (part.type !== 'finish') return undefined
        return {
          usage: withCacheHitRate(part.totalUsage),
          finishReason: part.finishReason,
          rawFinishReason: part.rawFinishReason,
          modelProvider: input.providerConfig.name,
          modelId: input.providerConfig.model,
          ...(input.planMode ? { planMode: true } : {}),
        }
      },
    })) {
      if (!perfFirstEventSeen) {
        perfFirstEventSeen = true
        perf('模型流首个事件', chunk.type)
      }
      if (!perfFirstOutputSeen && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-input-start')) {
        perfFirstOutputSeen = true
        perf('模型首个增量输出（真正开始回复）', chunk.type)
      }
      if (chunk.type === 'finish') { finishChunk = chunk; continue }
      trackToolChunk(chunk, toolNames, toolSummaries, pendingToolCalls)
      onChunk(chunk)
    }
    let assistantText = ''
    try { assistantText = await result.text } catch { /* abort/异常：跳过自动记忆 */ }
    perf('主回答流结束')
    if (assistantText && !signal?.aborted && shouldRunFinalReview(userText, assistantText, toolSummaries)) {
      const review = await runFinalReview({
        providerConfig: input.providerConfig,
        userText,
        assistantText,
        toolSummaries,
        signal,
      })
      if (review.status === 'needs_correction') {
        assistantText += appendFinalReviewCorrection(review, onChunk)
      }
      perf('最终审核（额外一次 LLM 调用）')
    }
    if (assistantText && !signal?.aborted) {
      await injectAutoMemories(assistantText, input, onChunk, signal)
      perf('自动记忆抽取')
    }
    if (pendingToolCalls.size > 0 && !signal?.aborted) {
      for (const [toolCallId, pending] of pendingToolCalls.entries()) {
        onChunk({
          type: 'tool-output-error',
          toolCallId,
          errorText: `工具 ${pending.toolName} 没有返回执行结果。请确认代码工作区已选择并启用；如果刚更新过 Electron 主进程/preload，需要重启应用后再试。`,
        })
      }
      perf('补齐未完成工具状态', `${pendingToolCalls.size} 个`)
    }
    if (finishChunk) onChunk(finishChunk)
    reportAgentProgress({ stage: 'run_finished', title: '回答生成完成' })
  })
}

export async function generateConversationTitle(
  input: { firstMessage: string; providerConfig: AgentProviderConfig },
  signal?: AbortSignal,
): Promise<string> {
  const firstMessage = input.firstMessage.trim().slice(0, 600)
  if (!firstMessage) return '新对话'

  const result = await generateText({
    model: createLanguageModel(input.providerConfig),
    system: '你是对话标题生成器。只输出一个中文短标题，不要解释，不要引号，不要标点装饰。',
    prompt: `根据用户第一句话生成 4 到 12 个汉字的聊天标题：\n${firstMessage}`,
    abortSignal: signal,
  })

  return sanitizeGeneratedTitle(result.text)
}

function sanitizeGeneratedTitle(value: string): string {
  const title = value
    .replace(/^[\s"'“”‘’`]+|[\s"'“”‘’`]+$/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/^标题[:：]\s*/i, '')
    .trim()
  return title.slice(0, 24) || '新对话'
}
