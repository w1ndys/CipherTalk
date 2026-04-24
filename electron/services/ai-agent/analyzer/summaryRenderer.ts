import type { StructuredAnalysis } from '../types/analysis'

interface BuildLegacySummaryPromptOptions {
  targetName: string
  timeRangeLabel: string
  messageCount: number
  formattedMessages: string
  inputMessageScopeNote?: string
  customRequirement?: string
}

interface BuildStructuredSummaryPromptOptions {
  targetName: string
  timeRangeLabel: string
  messageCount: number
  blockCount: number
  analysis: StructuredAnalysis
  inputMessageScopeNote?: string
  customRequirement?: string
}

export function buildLegacySummaryUserPrompt(options: BuildLegacySummaryPromptOptions): string {
  let userPrompt = `请分析我与"${options.targetName}"的聊天记录（时间范围：${options.timeRangeLabel}，共${options.messageCount}条消息）：`

  if (options.inputMessageScopeNote && options.inputMessageScopeNote.trim()) {
    userPrompt += `\n\n补充说明：${options.inputMessageScopeNote.trim()}`
  }

  userPrompt += `\n\n${options.formattedMessages}\n\n请按照系统提示的格式生成摘要。`

  if (options.customRequirement && options.customRequirement.trim()) {
    userPrompt += `\n\n用户的额外要求：${options.customRequirement.trim()}`
  }

  return userPrompt
}

export function buildStructuredSummaryUserPrompt(options: BuildStructuredSummaryPromptOptions): string {
  let userPrompt = `请基于我与"${options.targetName}"的聊天记录结构化分析结果生成最终 Markdown 摘要（时间范围：${options.timeRangeLabel}，共${options.messageCount}条消息，分析块数：${options.blockCount}）。`

  if (options.inputMessageScopeNote && options.inputMessageScopeNote.trim()) {
    userPrompt += `\n\n补充说明：${options.inputMessageScopeNote.trim()}`
  }

 userPrompt += `\n\n说明：
- 以下 JSON 来自聊天记录分块抽取与本地归并
- 请严格基于这些结构化事实输出，不要臆造原始聊天里没有的信息
- 请不要输出 JSON，也不要解释 evidenceRefs 这些系统附带的证据索引字段
- 如果某一类内容为空，可以按系统提示省略对应标题

结构化分析结果：
${JSON.stringify(options.analysis, null, 2)}

请按照系统提示的格式生成摘要。`

  if (options.customRequirement && options.customRequirement.trim()) {
    userPrompt += `\n\n用户的额外要求：${options.customRequirement.trim()}`
  }

  return userPrompt
}
