/**
 * 编排引擎 —— 用 AI SDK 的 ToolLoopAgent 跑 ReAct 循环，流式产出 UIMessageChunk。
 * 运行在 AI utilityProcess 子进程内（见文档 §3.1/§5.2）。
 */
import { generateText, ToolLoopAgent, stepCountIs, type ModelMessage, type UIMessageChunk } from 'ai'
import type { SystemModelMessage } from '@ai-sdk/provider-utils'
import { createLanguageModel } from './provider'
import { buildAgentPromptParts, PLAN_MODE_PROMPT, WEB_SEARCH_PROMPT } from './prompts'
import { isWebSearchAvailable } from '../ai/webSearchService'
import { applyAnthropicCacheControl, buildPromptCacheKey, buildProviderOptions } from './cache'
import { buildPlanModeTools, buildTools } from './tools'
import { buildMemoryContext, extractMemories, preloadRelevantMemories } from './tools/memory'
import { compactMessages } from './compaction'
import { runFinalReview, summarizeToolOutput, type ToolOutputSummary } from './finalReview'
import { loopGuardCondition, withToolTimeouts } from './guards'
import { reportAgentProgress, withAgentProgress } from './progress'
import { buildToolRuntimeContext } from './toolPolicy'
import type { AgentProgressReporter, AgentProviderConfig, AgentRunInput } from './types'

const MAX_STEPS = 24
const DEFAULT_AGENT_TEMPERATURE = 0.2

export function buildAgentInstructions(
  input: AgentRunInput,
  memoryContext: string,
  relevantMemoryContext: string,
  tools: ReturnType<typeof buildTools>,
  webSearchOn = false,
): { instructions: SystemModelMessage[]; tools: ReturnType<typeof buildTools>; promptCacheKey: string } {
  const promptParts = buildAgentPromptParts(input.scope, input.skills)
  const dynamicSystem = [
    promptParts.dynamicSystem,
    input.planMode ? PLAN_MODE_PROMPT : '',
    webSearchOn ? WEB_SEARCH_PROMPT : '',
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
): void {
  if ('toolCallId' in chunk && 'toolName' in chunk && typeof chunk.toolCallId === 'string' && typeof chunk.toolName === 'string') {
    toolNames.set(chunk.toolCallId, chunk.toolName)
  }
  if (chunk.type !== 'tool-output-available') return
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

function shouldExtractAutoMemory(userText: string): boolean {
  const text = userText.replace(/\s+/g, ' ').trim()
  if (text.length < 6) return false
  return /(我是|我叫|我的名字|我喜欢|我不喜欢|我偏好|我习惯|我是.*(人|用户|开发|学生|老师|设计|工程|产品|运营)|.+是我的(朋友|同事|家人|对象|伴侣|同学|老板|客户)|记住|以后.*记得)/.test(text)
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
    if (!shouldExtractAutoMemory(lastUserText(input.messages))) return
    const auto = await extractMemories({
      scope: input.scope,
      providerConfig: input.providerConfig,
      userText: lastUserText(input.messages),
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
    const userText = lastUserText(input.messages)
    reportAgentProgress({ stage: 'run_started', title: '正在加载长期记忆' })
    const memoryContext = await buildMemoryContext(input.scope)
    reportAgentProgress({ stage: 'run_started', title: '正在召回相关记忆' })
    const relevantMemoryContext = await preloadRelevantMemories(userText, input.scope)
    reportAgentProgress({ stage: 'run_started', title: '正在准备工具' })
    const webSearchOn = isWebSearchAvailable()
    const baseTools = withToolTimeouts(input.planMode
      ? buildPlanModeTools(input.scope)
      : buildTools(input.scope, input.providerConfig, input.mcpTools, webSearchOn))
    const prepared = buildAgentInstructions(input, memoryContext, relevantMemoryContext, baseTools, webSearchOn)
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

    reportAgentProgress({ stage: 'run_started', title: '正在请求模型' })
    const result = await agent.stream({ messages: input.messages, abortSignal: signal })
    // 截留 message 的 finish，等 L1 自动记忆注入完再补发，让自动写入的工具 part 落在本条消息内
    let finishChunk: UIMessageChunk | undefined
    const toolNames = new Map<string, string>()
    const toolSummaries: ToolOutputSummary[] = []
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
      if (chunk.type === 'finish') { finishChunk = chunk; continue }
      trackToolChunk(chunk, toolNames, toolSummaries)
      onChunk(chunk)
    }
    let assistantText = ''
    try { assistantText = await result.text } catch { /* abort/异常：跳过自动记忆 */ }
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
    }
    if (assistantText && !signal?.aborted) {
      await injectAutoMemories(assistantText, input, onChunk, signal)
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
