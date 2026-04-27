/**
 * 最终回答 Prompt 构建
 */
import type {
  ContextWindow,
  IntentRoute,
  ParticipantResolution,
  SearchPayloadWithQuery
} from '../types'
import { MAX_SUMMARY_CHARS } from '../types'
import { compactText, stripThinkBlocks } from '../utils/text'
import { formatMessageLine } from '../utils/message'
import { getRouteLabel } from '../intent/router'

export interface BuildAnswerPromptInput {
  sessionName: string
  question: string
  route: IntentRoute
  summaryText?: string
  structuredContext?: string
  summaryFactsText?: string
  contextWindows: ContextWindow[]
  searchPayloads: SearchPayloadWithQuery[]
  aggregateText?: string
  resolvedParticipants: ParticipantResolution[]
  historyText: string
  usedRecentFallback: boolean
}

/**
 * 构建最终回答 prompt
 */
export function buildAnswerPrompt(input: BuildAnswerPromptInput): string {
  const contextText = input.contextWindows.length > 0
    ? input.contextWindows.map((window, index) => {
      const heading = window.source === 'search'
        ? `上下文窗口 ${index + 1}（关键词：${window.query || '未知'}，围绕命中消息）`
        : window.source === 'time_range'
          ? `上下文窗口 ${index + 1}（按时间读取：${window.label || '指定范围'}）`
          : `上下文窗口 ${index + 1}（最近消息）`
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
    : '本次未执行关键词检索，或检索没有命中。'

  const participantText = input.resolvedParticipants.length > 0
    ? input.resolvedParticipants
      .map((item) => `${item.query} => ${item.displayName || '未命名'} / ${item.senderUsername || '未解析'} / ${item.confidence}`)
      .join('\n')
    : '无'

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

内部问题线索：
${getRouteLabel(input.route.intent)}（${input.route.confidence}）：${input.route.reason || '无'}

已读取摘要事实：
${input.summaryFactsText || '无'}

已解析参与者：
${participantText}

按需读取的消息上下文：
${contextText}

关键词检索结果：
${searchContext}

聚合/统计结果：
${input.aggregateText || '无'}

上下文策略：
${input.usedRecentFallback
    ? '本次读取了最近消息，适合回答最近进展或作为证据兜底。'
    : input.searchPayloads.length > 0
      ? '本次执行了关键词检索，并在需要时围绕命中读取上下文。'
      : '本次由 Agent 自主选择了摘要、时间范围、参与者或聚合工具，没有把关键词搜索作为默认入口。'}

回答要求：
1. 用中文直接回答问题。
2. 如果证据不足，明确说"当前证据不足"，并说明还需要什么线索。
3. 可以使用 Markdown 组织最终答案，包括标题、列表、表格、引用和加粗；但不要为了排版而过度复杂。
4. 能引用依据时，在回答末尾加"依据"小节，用时间、发送人和原文预览列 1 到 5 条。
5. 不要输出工具调用过程，不要输出 JSON。`
}
