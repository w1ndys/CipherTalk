/**
 * 编排引擎 —— 用 AI SDK 的 ToolLoopAgent 跑 ReAct 循环，流式产出 UIMessageChunk。
 * 运行在 AI utilityProcess 子进程内（见文档 §3.1/§5.2）。
 */
import { generateText, ToolLoopAgent, stepCountIs, type ModelMessage, type StepResult, type ToolSet, type UIMessageChunk } from 'ai'
import type { ProviderOptions } from '@ai-sdk/provider-utils'
import { createLanguageModel } from './provider'
import { buildSystemPrompt } from './prompts'
import { buildTools } from './tools'
import { buildMemoryContext, extractMemories } from './tools/memory'
import { compactMessages } from './compaction'
import { runFinalReview, summarizeToolOutput, type ToolOutputSummary } from './finalReview'
import { loopGuardCondition, withToolTimeouts } from './guards'
import { reportAgentProgress, withAgentProgress } from './progress'
import type { AgentProgressReporter, AgentProviderConfig, AgentRunInput } from './types'

const MAX_STEPS = 24

/**
 * query_sql 门控：只有当模型已经实际用过下列结构化检索/统计工具后，才把 query_sql 放进
 * activeTools 解锁。防止模型一上来就绕过专用工具直接写 SQL —— 结构化工具是一步到位的首选，
 * SQL 只是兜底。模型最差也得先尝试一次结构化工具，下一步才能拿到 SQL，不会卡死。见 prompts.ts「选工具速查」。
 */
const SQL_GATE_UNLOCK_TOOLS = new Set([
  'search_messages', 'semantic_search', 'chat_stats',
  'get_timeline', 'get_context', 'list_groups', 'group_members', 'group_member_ranking',
])

function activeToolsFor(steps: ReadonlyArray<StepResult<ToolSet>>, toolNames: string[]): string[] {
  const unlocked = steps.some((step) => step.toolCalls.some((call) => SQL_GATE_UNLOCK_TOOLS.has(call.toolName)))
  return unlocked ? toolNames : toolNames.filter((name) => name !== 'query_sql')
}

function toCamelCase(value: string): string {
  return value.replace(/[-_\s]+([a-zA-Z0-9])/g, (_match, char: string) => char.toUpperCase())
}

function buildReasoningProviderOptions(input: AgentRunInput): ProviderOptions | undefined {
  const effort = input.providerConfig.reasoningEffort
  if (!effort || effort === 'auto') return undefined
  if (input.providerConfig.providerKind !== 'openai-responses' && input.providerConfig.providerKind !== 'openai-compatible') {
    return undefined
  }

  const option = { reasoningEffort: effort }
  const keys = new Set(['openai'])
  if (input.providerConfig.providerKind === 'openai-compatible') {
    keys.add(input.providerConfig.name)
    keys.add(toCamelCase(input.providerConfig.name))
  }

  return Object.fromEntries([...keys].map((key) => [key, option])) as ProviderOptions
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
    reportAgentProgress({ stage: 'run_started', title: '开始分析聊天记录' })
    const memoryContext = await buildMemoryContext(input.scope)
    const tools = withToolTimeouts(buildTools(input.scope, input.providerConfig, input.mcpTools))
    const activeToolNames = Object.keys(tools)
    const agent = new ToolLoopAgent({
      model: createLanguageModel(input.providerConfig),
      instructions: buildSystemPrompt(input.scope, input.skills) + memoryContext,
      tools,
      // 步数上限 + 死循环检测（连续 N 步相同工具调用即停），见 guards.ts
      stopWhen: [stepCountIs(MAX_STEPS), loopGuardCondition()],
      providerOptions: buildReasoningProviderOptions(input),
      // 每步压缩上下文（裁旧工具结果/推理痕迹，见 compaction.ts）+ query_sql 门控（见 activeToolsFor）
      prepareStep: ({ messages, steps }) => ({
        messages: compactMessages(messages),
        activeTools: activeToolsFor(steps, activeToolNames),
      }),
    })

    const result = await agent.stream({ messages: input.messages, abortSignal: signal })
    // 截留 message 的 finish，等 L1 自动记忆注入完再补发，让自动写入的工具 part 落在本条消息内
    let finishChunk: UIMessageChunk | undefined
    const toolNames = new Map<string, string>()
    const toolSummaries: ToolOutputSummary[] = []
    for await (const chunk of result.toUIMessageStream({
      messageMetadata: ({ part }) => {
        if (part.type !== 'finish') return undefined
        return {
          usage: part.totalUsage,
          finishReason: part.finishReason,
          rawFinishReason: part.rawFinishReason,
          modelProvider: input.providerConfig.name,
          modelId: input.providerConfig.model,
        }
      },
    })) {
      if (chunk.type === 'finish') { finishChunk = chunk; continue }
      trackToolChunk(chunk, toolNames, toolSummaries)
      onChunk(chunk)
    }
    let assistantText = ''
    try { assistantText = await result.text } catch { /* abort/异常：跳过自动记忆 */ }
    if (assistantText && !signal?.aborted) {
      const review = await runFinalReview({
        providerConfig: input.providerConfig,
        userText: lastUserText(input.messages),
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
