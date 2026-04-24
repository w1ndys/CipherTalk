import type { AIProvider } from '../../ai/providers/base'
import type { AnalysisBlock, ExtractedStructuredAnalysis } from '../types/analysis'
import { extractedStructuredAnalysisSchema, MAX_FACT_EVIDENCE_REFS } from '../types/analysis'

interface ExtractFactsOptions {
  model: string
  sessionName: string
  timeRangeLabel: string
}

const EXTRACTION_SYSTEM_PROMPT = `你是聊天记录结构化事实抽取器。

你的任务是基于提供的单个聊天消息块，抽取稳定、可验证的结构化事实。

强制规则：
1. 只能基于消息块原文，不得臆测。
2. 只输出一个 JSON 对象，不要输出 Markdown、解释、前言或后记。
3. 若某字段没有内容，返回空字符串或空数组。
4. confidence 和 importance 使用 0 到 1 之间的小数。
5. todos.status 只能是 open、done、unknown。
6. risks.severity 只能是 low、medium、high。
7. decisions、todos、risks、events 的 evidenceRefs 必须填写 1 到 3 个消息引用 ID，且只能使用消息块里提供的 m001 / m002 这类 ID。
8. 如果某个决策、待办、风险、事件找不到明确证据，就不要输出该项。
9. 只保留对摘要有价值的主题、决策、待办、风险、事件与未决问题，忽略寒暄。

返回 JSON 结构：
{
  "overview": "一句话概览",
  "topics": [{ "name": "主题", "importance": 0.8 }],
  "decisions": [{ "text": "达成的决策", "confidence": 0.8, "evidenceRefs": ["m001", "m004"] }],
  "todos": [{ "owner": "负责人", "task": "待办内容", "deadline": "YYYY-MM-DD", "status": "open", "confidence": 0.8, "evidenceRefs": ["m008"] }],
  "risks": [{ "text": "风险描述", "severity": "medium", "confidence": 0.7, "evidenceRefs": ["m012", "m015"] }],
  "events": [{ "text": "关键事件", "date": "YYYY-MM-DD", "confidence": 0.7, "evidenceRefs": ["m010"] }],
  "openQuestions": [{ "text": "仍未明确的问题" }]
}`

function stripJsonFence(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return fenced ? fenced[1].trim() : trimmed
}

function getBlockEvidenceId(messageIndex: number): string {
  return `m${String(messageIndex + 1).padStart(3, '0')}`
}

function buildBlockEvidenceMap(block: AnalysisBlock): Map<string, string> {
  const map = new Map<string, string>()

  block.messages.forEach((message, index) => {
    map.set(getBlockEvidenceId(index), message.messageKey)
  })

  return map
}

function buildBlockEvidenceText(block: AnalysisBlock): string {
  return block.messages
    .map((message, index) => `[${getBlockEvidenceId(index)}] ${message.formattedLine}`)
    .join('\n')
}

function remapEvidenceRefs(
  evidenceRefs: string[],
  evidenceMap: Map<string, string>
): string[] {
  const seen = new Set<string>()
  const mapped: string[] = []

  for (const ref of evidenceRefs) {
    const mappedMessageKey = evidenceMap.get(ref)
    if (!mappedMessageKey || seen.has(mappedMessageKey)) continue
    seen.add(mappedMessageKey)
    mapped.push(mappedMessageKey)
    if (mapped.length >= MAX_FACT_EVIDENCE_REFS) {
      break
    }
  }

  return mapped
}

function mapBlockEvidenceRefs(
  analysis: ExtractedStructuredAnalysis,
  evidenceMap: Map<string, string>
): ExtractedStructuredAnalysis {
  return {
    overview: analysis.overview,
    topics: analysis.topics.map((item) => ({ ...item })),
    decisions: analysis.decisions
      .map((item) => ({
        text: item.text,
        confidence: item.confidence,
        evidenceRefs: remapEvidenceRefs(item.evidenceRefs, evidenceMap)
      }))
      .filter((item) => item.text && item.evidenceRefs.length > 0),
    todos: analysis.todos
      .map((item) => ({
        owner: item.owner,
        task: item.task,
        deadline: item.deadline,
        status: item.status,
        confidence: item.confidence,
        evidenceRefs: remapEvidenceRefs(item.evidenceRefs, evidenceMap)
      }))
      .filter((item) => item.task && item.evidenceRefs.length > 0),
    risks: analysis.risks
      .map((item) => ({
        text: item.text,
        severity: item.severity,
        confidence: item.confidence,
        evidenceRefs: remapEvidenceRefs(item.evidenceRefs, evidenceMap)
      }))
      .filter((item) => item.text && item.evidenceRefs.length > 0),
    events: analysis.events
      .map((item) => ({
        text: item.text,
        date: item.date,
        confidence: item.confidence,
        evidenceRefs: remapEvidenceRefs(item.evidenceRefs, evidenceMap)
      }))
      .filter((item) => item.text && item.evidenceRefs.length > 0),
    openQuestions: analysis.openQuestions.map((item) => ({ ...item }))
  }
}

function buildExtractionUserPrompt(block: AnalysisBlock, totalBlocks: number, options: ExtractFactsOptions): string {
  return `请抽取以下聊天消息块中的结构化事实。

会话名称：${options.sessionName}
时间范围：${options.timeRangeLabel}
消息块位置：第 ${block.index + 1} / ${totalBlocks} 块
本块消息数：${block.messageCount}

要求：
- 每条消息前的 [mxxx] 是可引用的证据 ID
- topics 最多保留 8 个
- decisions 最多保留 8 个，且每项 evidenceRefs 必须填写 1 到 3 个 mxxx
- todos 最多保留 12 个，且每项 evidenceRefs 必须填写 1 到 3 个 mxxx
- risks 最多保留 8 个，且每项 evidenceRefs 必须填写 1 到 3 个 mxxx
- events 最多保留 10 个，且每项 evidenceRefs 必须填写 1 到 3 个 mxxx
- openQuestions 最多保留 8 个
- 如果块内没有明确决策或待办，不要臆造

消息块正文：
${buildBlockEvidenceText(block)}`
}

export async function extractFactsFromBlocks(
  blocks: AnalysisBlock[],
  provider: AIProvider,
  options: ExtractFactsOptions
): Promise<ExtractedStructuredAnalysis[]> {
  const analyses: ExtractedStructuredAnalysis[] = []

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]
    const rawResponse = await provider.chat(
      [
        { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
        {
          role: 'user',
          content: buildExtractionUserPrompt(
            { ...block, index },
            blocks.length,
            options
          )
        }
      ],
      {
        model: options.model,
        temperature: 0.2,
        maxTokens: 1400,
        enableThinking: false
      }
    )

    const cleaned = stripJsonFence(rawResponse)
    const parsedJson = JSON.parse(cleaned)
    const parsedResult = extractedStructuredAnalysisSchema.safeParse(parsedJson)

    if (!parsedResult.success) {
      throw new Error(`结构化抽取结果不符合 schema：${parsedResult.error.message}`)
    }

    analyses.push(mapBlockEvidenceRefs(parsedResult.data, buildBlockEvidenceMap(block)))
  }

  return analyses
}
