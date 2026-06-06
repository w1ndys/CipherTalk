/**
 * 编排引擎 —— 用 AI SDK 的 ToolLoopAgent 跑 ReAct 循环，流式产出 UIMessageChunk。
 * 运行在 AI utilityProcess 子进程内（见文档 §3.1/§5.2）。
 */
import { generateText, ToolLoopAgent, stepCountIs, type ProviderOptions, type UIMessageChunk } from 'ai'
import { createLanguageModel } from './provider'
import { buildSystemPrompt } from './prompts'
import { buildTools } from './tools'
import { compactMessages } from './compaction'
import { loopGuardCondition, withToolTimeouts } from './guards'
import { reportAgentProgress, withAgentProgress } from './progress'
import type { AgentProgressReporter, AgentProviderConfig, AgentRunInput } from './types'

const MAX_STEPS = 24

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

export async function runAgent(
  input: AgentRunInput,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
  onProgress?: AgentProgressReporter,
): Promise<void> {
  await withAgentProgress(onProgress, async () => {
    reportAgentProgress({ stage: 'run_started', title: '开始分析聊天记录' })
    const agent = new ToolLoopAgent({
      model: createLanguageModel(input.providerConfig),
      instructions: buildSystemPrompt(input.scope),
      tools: withToolTimeouts(buildTools(input.scope, input.providerConfig)),
      // 步数上限 + 死循环检测（连续 N 步相同工具调用即停），见 guards.ts
      stopWhen: [stepCountIs(MAX_STEPS), loopGuardCondition()],
      providerOptions: buildReasoningProviderOptions(input),
      // 每步压缩上下文：裁掉旧工具结果/推理痕迹，防长对话或多工具循环爆上下文（见 compaction.ts）
      prepareStep: ({ messages }) => ({ messages: compactMessages(messages) }),
    })

    const result = await agent.stream({ messages: input.messages, abortSignal: signal })
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
      onChunk(chunk)
    }
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
