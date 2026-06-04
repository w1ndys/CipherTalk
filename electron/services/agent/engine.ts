/**
 * 编排引擎 —— 用 AI SDK 的 ToolLoopAgent 跑 ReAct 循环，流式产出 UIMessageChunk。
 * 运行在 AI utilityProcess 子进程内（见文档 §3.1/§5.2）。
 */
import { ToolLoopAgent, stepCountIs, type UIMessageChunk } from 'ai'
import { createLanguageModel } from './provider'
import { buildSystemPrompt } from './prompts'
import { buildTools } from './tools'
import type { AgentRunInput } from './types'

const MAX_STEPS = 24

export async function runAgent(
  input: AgentRunInput,
  onChunk: (chunk: UIMessageChunk) => void,
  signal?: AbortSignal,
): Promise<void> {
  const agent = new ToolLoopAgent({
    model: createLanguageModel(input.providerConfig),
    instructions: buildSystemPrompt(input.scope),
    tools: buildTools(input.scope),
    stopWhen: stepCountIs(MAX_STEPS),
  })

  const result = await agent.stream({ messages: input.messages, abortSignal: signal })
  for await (const chunk of result.toUIMessageStream()) {
    onChunk(chunk)
  }
}
