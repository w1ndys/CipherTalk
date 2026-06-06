/**
 * delegate_analysis —— 子 Agent 委托（见文档 §9.3 / D7）。
 *
 * 把「读大量消息」的子任务交给独立的 ToolLoopAgent 跑完，只把结论 + 出处回给主 Agent，
 * 子任务翻的原始消息不进主上下文（配合 compaction，进一步压住上下文体积）。
 * 子 Agent 用 buildBaseTools（不含本工具，避免递归委托），带步数上限 + 死循环检测。
 * 出处：从子 Agent 各工具结果里聚合 evidence 回传，让主 Agent 也能给可点 Sources（带出处硬要求）。
 */
import { ToolLoopAgent, stepCountIs, tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { createLanguageModel } from '../provider'
import { buildSystemPrompt } from '../prompts'
import { loopGuardCondition } from '../guards'
import { withSubAgentScope } from '../progress'
import type { AgentEvidenceItem } from './shared'
import type { AgentProviderConfig, AgentScope } from '../types'

const SUB_AGENT_MAX_STEPS = 12
const MAX_DELEGATED_EVIDENCE = 15

/** 从子 Agent 的各步工具结果里聚合 evidence（去重、限量），供主 Agent 标注可点出处。 */
function collectEvidence(steps: ReadonlyArray<{ toolResults?: ReadonlyArray<{ output?: unknown }> }>): AgentEvidenceItem[] {
  const out: AgentEvidenceItem[] = []
  const seen = new Set<string>()
  for (const step of steps) {
    for (const tr of step.toolResults ?? []) {
      const ev = (tr.output as { evidence?: unknown } | undefined)?.evidence
      if (!Array.isArray(ev)) continue
      for (const item of ev as AgentEvidenceItem[]) {
        const id = item?.id
        if (!id || seen.has(id)) continue
        seen.add(id)
        out.push(item)
        if (out.length >= MAX_DELEGATED_EVIDENCE) return out
      }
    }
  }
  return out
}

const DELEGATE_SUFFIX =
  '\n\n你现在是被主助手委托的【子助手】：只专注完成下面这一个子任务，' +
  '用工具查到的真实数据得出结论，简洁作答并在结论里标注关键出处（时间 + 发送者）。' +
  '不要寒暄、不要复述任务，直接给结论。' +
  '你自己没有 delegate_analysis 工具，请直接用其它工具完成，不要尝试再委托。'

export function createDelegateAnalysis(opts: {
  providerConfig: AgentProviderConfig
  scope: AgentScope
  /** 子 Agent 用的工具集（应为 buildBaseTools 结果，不含 delegate_analysis）。 */
  buildSubTools: () => ToolSet
}) {
  return tool({
    description:
      '把需要读大量消息的子任务委托给独立子助手，只回结论（原始消息不进你的上下文）。' +
      '适合「总结某人某段时间都聊了啥 / 梳理某话题的来龙去脉」这类要翻很多条的重活。' +
      'task 写清要分析什么、范围（哪个会话 username / 时间段）、期望结论形式。' +
      '简单精确查询直接用 search_messages / chat_stats，别委托。',
    inputSchema: z.object({
      task: z.string().describe('委托的子任务：分析什么、范围（会话 username / 时间段）、期望结论形式'),
    }),
    execute: async ({ task }, { abortSignal }) => {
      try {
        const subAgent = new ToolLoopAgent({
          model: createLanguageModel(opts.providerConfig),
          instructions: buildSystemPrompt(opts.scope) + DELEGATE_SUFFIX,
          tools: opts.buildSubTools(),
          stopWhen: [stepCountIs(SUB_AGENT_MAX_STEPS), loopGuardCondition()],
        })
        const result = await withSubAgentScope(() => subAgent.generate({ prompt: task, abortSignal }))
        const conclusion = result.text.trim()
        return {
          conclusion: conclusion || '（子助手未得出结论，可能任务过大或数据不足，建议缩小范围重试）',
          steps: result.steps.length,
          evidence: collectEvidence(result.steps),
        }
      } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) }
      }
    },
  })
}
