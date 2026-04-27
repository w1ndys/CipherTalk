/**
 * Agent 决策 Prompt 构建
 */
import type {
  EvidenceQuality,
  IntentRoute,
  KnownSearchHit,
  ParticipantResolution,
  SearchPayloadWithQuery,
  ContextWindow,
  ToolObservation
} from '../types'
import { MAX_SUMMARY_CHARS, MAX_TOOL_CALLS, MAX_SEARCH_RETRIES } from '../types'
import { compactText, stripThinkBlocks } from '../utils/text'
import { formatTime } from '../utils/time'
import { buildObservationText, buildKnownHitsText } from '../evidence'

function buildAvailableToolSchemaText(): string {
  return `可调用工具：
1. read_summary_facts args={}
   读取当前摘要和结构化摘要。适合先判断摘要是否已经覆盖问题。
2. read_latest args={"limit":40}
   读取最近消息。只适合最近进展或其它工具无法提供线索时兜底。
3. read_by_time_range args={"startTime":秒级时间戳,"endTime":秒级时间戳,"label":"昨天晚上","limit":80,"keyword":"可选关键词","participantName":"可选昵称"}
   按时间/关键词/参与者读取消息。
4. resolve_participant args={"name":"张三"}
   把昵称、备注或问题中的人名解析为 senderUsername。
5. search_messages args={"query":"关键词或短语"}
   混合检索消息、对话块和记忆证据。适合具体词、原话、实体、产品名、技术名、是否提到过等问题。
6. read_context args={"hitId":"h1","beforeLimit":6,"afterLimit":6}
   围绕 search_messages 命中读取前后文。必须已有命中 h1/h2 后再用。
7. get_session_statistics args={"startTime":秒级时间戳,"endTime":秒级时间戳,"participantLimit":20,"includeSamples":true}
   统计当前会话消息量、发送者、类型和样例。
8. get_keyword_statistics args={"keywords":["关键词"],"matchMode":"substring","startTime":秒级时间戳,"endTime":秒级时间戳}
   统计某些词/短语出现次数、发送者分布和样例。
9. aggregate_messages args={"metric":"speaker_count|message_count|kind_count|timeline|summary"}
   对已读取消息做聚合整理。`
}

export interface BuildDecisionPromptInput {
  sessionName: string
  question: string
  route: IntentRoute
  summaryText?: string
  structuredContext?: string
  historyText: string
  observations: ToolObservation[]
  knownHits: KnownSearchHit[]
  resolvedParticipants: ParticipantResolution[]
  aggregateText?: string
  summaryFactsRead: boolean
  toolCallsUsed: number
  evidenceQuality: EvidenceQuality
  searchRetries: number
  searchPayloads: SearchPayloadWithQuery[]
  contextWindows: ContextWindow[]
}

/**
 * 构建 Agent 自主决策 prompt
 */
export function buildAutonomousAgentPrompt(input: BuildDecisionPromptInput): string {
  const totalSearchHits = input.searchPayloads.reduce((sum, item) => sum + item.payload.hits.length, 0)
  const totalContextMessages = input.contextWindows.reduce((sum, window) => sum + window.messages.length, 0)
  const searchedKeywords = input.searchPayloads.map((item) => item.query).join('、') || '无'
  const inferredRange = input.route.timeRange
    ? `${input.route.timeRange.label || '时间范围'} ${input.route.timeRange.startTime || ''}-${input.route.timeRange.endTime || ''}`
    : '无'
  const searchHints = input.route.searchQueries.join('、') || '无'

  return `你是 CipherTalk 的本地聊天记录问答 Agent。你要自主决定下一步：输出一小段文字、调用一个本地工具，或给出最终答案。

当前时间：${formatTime(Date.now())}
会话：${input.sessionName}

用户问题：
${input.question}

多轮上下文：
${input.historyText || '无'}

当前摘要预览：
${compactText(stripThinkBlocks(input.summaryText || ''), MAX_SUMMARY_CHARS) || '无'}

结构化摘要 JSON：
${input.structuredContext || '无'}

内部线索（仅作参考，不是固定路线）：
- 启发式问题类型：${input.route.intent}
- 时间线索：${inferredRange}
- 检索关键词线索：${searchHints}
- 参与者线索：${input.route.participantHints.join('、') || '无'}

已读状态：
- 已读摘要事实：${input.summaryFactsRead ? '是' : '否'}
- 工具预算：${input.toolCallsUsed}/${MAX_TOOL_CALLS}
- 证据质量：${input.evidenceQuality}
- 搜索命中总数：${totalSearchHits}
- 已读取上下文消息数：${totalContextMessages}
- 已搜索关键词：${searchedKeywords}
- 搜索 0 命中重试次数：${input.searchRetries}/${MAX_SEARCH_RETRIES}

已解析参与者：
${input.resolvedParticipants.length > 0
    ? input.resolvedParticipants.map((item) => `${item.displayName || item.query} => ${item.senderUsername || '未解析'} (${item.confidence})`).join('\n')
    : '无'}

聚合/统计结果：
${input.aggregateText || '无'}

已知搜索命中：
${buildKnownHitsText(input.knownHits)}

工具观察：
${buildObservationText(input.observations)}

${buildAvailableToolSchemaText()}

输出格式必须是严格 JSON，只能三选一：
1. {"action":"assistant_text","content":"我先查一下相关记录。"}
2. {"action":"tool_call","toolName":"search_messages","args":{"query":"关键词"},"reason":"为什么调用"}
3. {"action":"final_answer","content":"最终回答文本","reason":"为什么现在可以回答"}

决策规则：
- 可以先用 assistant_text 给用户一句自然的进度文字，然后继续调用工具。
- 寒暄、感谢、能力询问等不需要聊天记录的问题，可以直接 final_answer，不要调用工具。
- 事实类、证据类、原话类、是否提到某词、统计类问题，必须先有证据再 final_answer。
- 证据质量为 none 时，不要 final_answer；优先 search_messages、get_session_statistics、get_keyword_statistics、read_by_time_range 或 read_summary_facts。例外：工具观察明确为 content_not_found 时，应 final_answer 说明证据不足。
- 搜索 0 命中时先看工具观察里的失败原因：content_not_found 表示关键词和语义检索都无证据，应回答证据不足；vector_unavailable 或 keyword_miss_only 才换更核心/同义关键词或按时间读取。
- read_context 只能在已有搜索命中 h1/h2 后调用。
- 工具预算接近用完时，若仍无证据，可以调用 read_latest 兜底。
- final_answer.content 是给用户看的最终答案，可以在 JSON 字符串内使用 Markdown 标题、列表、表格和引用；但整个响应本身仍必须是可解析 JSON。
- 不要输出 Markdown 代码块，不要解释 JSON 之外的内容。`
}
