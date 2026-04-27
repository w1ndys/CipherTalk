/**
 * Agent 自主决策：解析模型输出、选择下一步动作
 */
import type { AIProvider } from '../../ai/providers/base'
import type {
  AutonomousAgentAction,
  ToolLoopAction
} from './types'
import {
  MAX_CONTEXT_MESSAGES,
  SEARCH_CONTEXT_BEFORE,
  SEARCH_CONTEXT_AFTER
} from './types'
import { compactText, isRecord, clampToolLimit, stripThinkBlocks, stripJsonFence } from './utils/text'
import { normalizeSearchQuery } from './utils/search'
import { getFirstConcreteQuery } from './utils/search'
import { normalizeStringArray } from './utils/text'
import { buildAutonomousAgentPrompt, type BuildDecisionPromptInput } from './prompts/decision'

/**
 * 将模型原始输出规范化为 ToolLoopAction
 */
export function normalizeToolAction(raw: unknown): ToolLoopAction | null {
  if (!isRecord(raw)) return null

  const actionName = String(raw.action || raw.tool || '').trim()
  const reason = compactText(String(raw.reason || ''), 120) || undefined

  if (actionName === 'read_summary_facts') {
    return { action: 'read_summary_facts', reason }
  }

  if (actionName === 'search_messages') {
    const query = normalizeSearchQuery(String(raw.query || raw.keyword || ''), 48)
    if (!query) return null
    return { action: 'search_messages', query, reason }
  }

  if (actionName === 'read_context') {
    const cursor = isRecord(raw.cursor)
      ? {
        localId: Number(raw.cursor.localId || 0),
        createTime: Number(raw.cursor.createTime || 0),
        sortSeq: Number(raw.cursor.sortSeq || 0)
      }
      : undefined

    return {
      action: 'read_context',
      hitId: compactText(String(raw.hitId || raw.hit_id || ''), 16) || undefined,
      cursor: cursor && cursor.localId && cursor.createTime ? cursor : undefined,
      beforeLimit: clampToolLimit(raw.beforeLimit ?? raw.before_limit, SEARCH_CONTEXT_BEFORE, 12),
      afterLimit: clampToolLimit(raw.afterLimit ?? raw.after_limit, SEARCH_CONTEXT_AFTER, 12),
      reason
    }
  }

  if (actionName === 'read_latest') {
    return {
      action: 'read_latest',
      limit: clampToolLimit(raw.limit, MAX_CONTEXT_MESSAGES, MAX_CONTEXT_MESSAGES),
      reason
    }
  }

  if (actionName === 'read_by_time_range') {
    const startTime = Number(raw.startTime ?? raw.start_time)
    const endTime = Number(raw.endTime ?? raw.end_time)
    return {
      action: 'read_by_time_range',
      startTime: Number.isFinite(startTime) && startTime > 0 ? Math.floor(startTime) : undefined,
      endTime: Number.isFinite(endTime) && endTime > 0 ? Math.floor(endTime) : undefined,
      label: compactText(String(raw.label || ''), 40) || undefined,
      limit: clampToolLimit(raw.limit, MAX_CONTEXT_MESSAGES, 100),
      keyword: normalizeSearchQuery(String(raw.keyword || ''), 48) || undefined,
      senderUsername: compactText(String(raw.senderUsername || raw.sender_username || ''), 80) || undefined,
      participantName: compactText(String(raw.participantName || raw.participant_name || raw.name || ''), 48) || undefined,
      reason
    }
  }

  if (actionName === 'resolve_participant') {
    return {
      action: 'resolve_participant',
      name: compactText(String(raw.name || raw.query || raw.participantName || raw.participant_name || ''), 48) || undefined,
      reason
    }
  }

  if (actionName === 'aggregate_messages') {
    const metric = String(raw.metric || '').trim()
    return {
      action: 'aggregate_messages',
      metric: ['speaker_count', 'message_count', 'kind_count', 'timeline', 'summary'].includes(metric)
        ? metric as Extract<ToolLoopAction, { action: 'aggregate_messages' }>['metric']
        : 'summary',
      reason
    }
  }

  if (actionName === 'get_session_statistics') {
    const startTime = Number(raw.startTime ?? raw.start_time)
    const endTime = Number(raw.endTime ?? raw.end_time)
    return {
      action: 'get_session_statistics',
      startTime: Number.isFinite(startTime) && startTime > 0 ? Math.floor(startTime) : undefined,
      endTime: Number.isFinite(endTime) && endTime > 0 ? Math.floor(endTime) : undefined,
      label: compactText(String(raw.label || ''), 40) || undefined,
      participantLimit: clampToolLimit(raw.participantLimit ?? raw.participant_limit, 20, 50),
      includeSamples: Boolean(raw.includeSamples ?? raw.include_samples),
      reason
    }
  }

  if (actionName === 'get_keyword_statistics') {
    const startTime = Number(raw.startTime ?? raw.start_time)
    const endTime = Number(raw.endTime ?? raw.end_time)
    const keywords = normalizeStringArray(raw.keywords || raw.queries || raw.query ? raw.keywords || raw.queries || [raw.query] : [], 6)
      .map((item) => normalizeSearchQuery(item, 48))
      .filter(Boolean)
    const matchMode = String(raw.matchMode || raw.match_mode || '').trim()
    if (keywords.length === 0) return null
    return {
      action: 'get_keyword_statistics',
      keywords,
      startTime: Number.isFinite(startTime) && startTime > 0 ? Math.floor(startTime) : undefined,
      endTime: Number.isFinite(endTime) && endTime > 0 ? Math.floor(endTime) : undefined,
      label: compactText(String(raw.label || ''), 40) || undefined,
      matchMode: matchMode === 'exact' ? 'exact' : 'substring',
      participantLimit: clampToolLimit(raw.participantLimit ?? raw.participant_limit, 20, 50),
      reason
    }
  }

  if (actionName === 'answer') {
    return { action: 'answer', reason }
  }

  return null
}

/**
 * 解析模型返回的 Agent 动作 JSON
 */
export function parseAutonomousAgentAction(value: string, finalAnswerContentCharLimit = 4000): AutonomousAgentAction | null {
  try {
    const parsed = JSON.parse(stripJsonFence(stripThinkBlocks(value))) as Record<string, unknown>
    const action = String(parsed.action || '').trim()
    const compactPreservingLines = (content: unknown, limit = finalAnswerContentCharLimit): string | undefined => {
      const text = String(content || '').trim()
      if (!text) return undefined
      return text.length > limit ? `${text.slice(0, limit - 3)}...` : text
    }

    if (action === 'assistant_text') {
      const content = compactText(String(parsed.content || ''), 500)
      return content ? { action: 'assistant_text', content } : null
    }

    if (action === 'final_answer') {
      return {
        action: 'final_answer',
        content: compactPreservingLines(parsed.content),
        reason: compactText(String(parsed.reason || ''), 160) || undefined
      }
    }

    if (action === 'tool_call') {
      const toolName = String(parsed.toolName || parsed.tool || parsed.name || '').trim()
      if (!toolName || toolName === 'answer') {
        return {
          action: 'final_answer',
          reason: compactText(String(parsed.reason || ''), 160) || undefined
        }
      }

      const args = isRecord(parsed.args) ? parsed.args : {}
      const tool = normalizeToolAction({
        ...args,
        action: toolName,
        reason: parsed.reason || args.reason
      })
      return tool ? {
        action: 'tool_call',
        tool,
        reason: compactText(String(parsed.reason || ''), 160) || undefined
      } : null
    }

    return null
  } catch {
    return null
  }
}

/**
 * 调用模型选择下一个 Agent 动作
 */
export async function chooseNextAutonomousAgentAction(
  provider: AIProvider,
  model: string,
  input: BuildDecisionPromptInput,
  options: {
    decisionMaxTokens: number
    finalAnswerContentCharLimit: number
  }
): Promise<{ action: AutonomousAgentAction; prompt: string }> {
  const prompt = buildAutonomousAgentPrompt(input)

  try {
    const response = await provider.chat([
      {
        role: 'system',
        content: '你是自主工具编排 Agent。你只能输出一个严格 JSON 对象，不能输出 Markdown。'
      },
      {
        role: 'user',
        content: prompt
      }
    ], {
      model,
      temperature: 0.2,
      maxTokens: options.decisionMaxTokens,
      enableThinking: false
    })

    const parsed = parseAutonomousAgentAction(response, options.finalAnswerContentCharLimit)
    if (parsed) return { action: parsed, prompt }
  } catch {
    // 失败时走本地兜底，避免问答卡死。
  }

  if (input.route.intent === 'direct_answer') {
    return {
      action: {
        action: 'final_answer',
        content: '我在。你可以问我这段聊天里的内容、统计互动，或者让我帮你总结。'
      },
      prompt
    }
  }

  if (input.evidenceQuality === 'none') {
    const firstQuery = getFirstConcreteQuery(input.question, input.route.searchQueries)
    return {
      action: firstQuery
        ? { action: 'tool_call', tool: { action: 'search_messages', query: firstQuery, reason: '模型动作解析失败，使用关键词检索兜底' } }
        : { action: 'tool_call', tool: { action: 'read_latest', limit: MAX_CONTEXT_MESSAGES, reason: '模型动作解析失败，读取最近上下文兜底' } },
      prompt
    }
  }

  return {
    action: { action: 'final_answer', reason: '模型动作解析失败，但已有可用证据，进入最终回答' },
    prompt
  }
}
