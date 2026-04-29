/**
 * OpenAI-compatible 原生 tools/tool_calls 定义与参数校验。
 */
import type { NativeToolDefinition } from '../../ai/providers/base'
import type { SessionQAToolName, ToolLoopAction } from './types'
import { normalizeToolAction } from './agentDecision'
import { isRecord, stripJsonFence } from './utils/text'

const NATIVE_SESSION_QA_TOOL_NAMES = [
  'read_summary_facts',
  'search_messages',
  'read_context',
  'read_latest',
  'read_by_time_range',
  'resolve_participant',
  'get_session_statistics',
  'get_keyword_statistics',
  'aggregate_messages',
  'answer'
] as const

const NATIVE_TOOL_NAME_SET = new Set<string>(NATIVE_SESSION_QA_TOOL_NAMES)

export type NativeSessionQAToolName = typeof NATIVE_SESSION_QA_TOOL_NAMES[number]

export interface NativeToolArgumentParseResult {
  args: Record<string, unknown>
  action: ToolLoopAction | null
  error?: string
}

export function isNativeSessionQAToolName(name: string): name is NativeSessionQAToolName {
  return NATIVE_TOOL_NAME_SET.has(name)
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required
  }
}

export function getNativeSessionQATools(): NativeToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read_summary_facts',
        description: '读取当前会话摘要和结构化摘要。适合先判断摘要是否已覆盖用户问题。',
        parameters: objectSchema({})
      }
    },
    {
      type: 'function',
      function: {
        name: 'search_messages',
        description: '用关键词和语义检索搜索当前会话中的相关消息、对话块和记忆证据。适合具体实体、项目名、原话、是否提到某事等问题。',
        parameters: objectSchema({
          query: {
            type: 'string',
            description: '短关键词、短语或实体名。保留用户问题中的专有名词、人名、项目名。'
          },
          reason: {
            type: 'string',
            description: '调用原因，简短说明为什么搜索这个词。'
          }
        }, ['query'])
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_context',
        description: '围绕 search_messages 返回的命中读取前后文。必须先有已知命中 h1/h2 后再调用。',
        parameters: objectSchema({
          hitId: {
            type: 'string',
            description: '已知搜索命中 ID，例如 h1、h2。'
          },
          beforeLimit: {
            type: 'integer',
            minimum: 1,
            maximum: 12,
            default: 6,
            description: '读取命中前多少条消息。'
          },
          afterLimit: {
            type: 'integer',
            minimum: 1,
            maximum: 12,
            default: 6,
            description: '读取命中后多少条消息。'
          },
          reason: {
            type: 'string',
            description: '调用原因。'
          }
        }, ['hitId'])
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_latest',
        description: '读取当前会话最近若干条消息。只适合没有明确时间词时兜底；如果用户说刚才、刚刚、最近、今天、昨天，应优先用 read_by_time_range。',
        parameters: objectSchema({
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 40,
            default: 40,
            description: '读取最近消息数量。'
          },
          reason: {
            type: 'string',
            description: '调用原因。'
          }
        })
      }
    },
    {
      type: 'function',
      function: {
        name: 'read_by_time_range',
        description: '按时间范围、关键词或参与者读取当前会话消息。适合用户问题带有刚才、刚刚、最近、今天、昨天、上周、某日期、某人说过什么等范围线索。',
        parameters: objectSchema({
          startTime: {
            type: 'integer',
            description: '开始时间，秒级 Unix 时间戳。没有明确范围时可省略。'
          },
          endTime: {
            type: 'integer',
            description: '结束时间，秒级 Unix 时间戳。没有明确范围时可省略。'
          },
          label: {
            type: 'string',
            description: '人类可读的时间范围标签，例如 昨晚、2025-01-01。'
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 80,
            description: '读取消息数量上限。'
          },
          keyword: {
            type: 'string',
            description: '可选关键词过滤。'
          },
          senderUsername: {
            type: 'string',
            description: '已解析出的发送者 username。通常先调用 resolve_participant。'
          },
          participantName: {
            type: 'string',
            description: '问题中的参与者昵称或备注。'
          },
          reason: {
            type: 'string',
            description: '调用原因。'
          }
        })
      }
    },
    {
      type: 'function',
      function: {
        name: 'resolve_participant',
        description: '把用户问题中的昵称、备注、人名解析为会话内 senderUsername，供后续按发送者过滤。',
        parameters: objectSchema({
          name: {
            type: 'string',
            description: '需要解析的参与者名称。'
          },
          reason: {
            type: 'string',
            description: '调用原因。'
          }
        }, ['name'])
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_session_statistics',
        description: '统计当前会话消息量、发送者分布、消息类型和可选样例。',
        parameters: objectSchema({
          startTime: {
            type: 'integer',
            description: '可选开始时间，秒级 Unix 时间戳。'
          },
          endTime: {
            type: 'integer',
            description: '可选结束时间，秒级 Unix 时间戳。'
          },
          label: {
            type: 'string',
            description: '统计范围标签。'
          },
          participantLimit: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            default: 20,
            description: '发送者排行数量上限。'
          },
          includeSamples: {
            type: 'boolean',
            default: true,
            description: '是否返回少量样例消息作为证据。'
          },
          reason: {
            type: 'string',
            description: '调用原因。'
          }
        })
      }
    },
    {
      type: 'function',
      function: {
        name: 'get_keyword_statistics',
        description: '统计关键词或短语的命中消息数、出现次数、发送者分布、时间分布和样例。',
        parameters: objectSchema({
          keywords: {
            type: 'array',
            minItems: 1,
            maxItems: 6,
            items: { type: 'string' },
            description: '要统计的关键词或短语。'
          },
          startTime: {
            type: 'integer',
            description: '可选开始时间，秒级 Unix 时间戳。'
          },
          endTime: {
            type: 'integer',
            description: '可选结束时间，秒级 Unix 时间戳。'
          },
          label: {
            type: 'string',
            description: '统计范围标签。'
          },
          matchMode: {
            type: 'string',
            enum: ['substring', 'exact'],
            default: 'substring',
            description: 'substring 表示包含匹配，exact 表示整条消息归一化后完全等于关键词。'
          },
          participantLimit: {
            type: 'integer',
            minimum: 1,
            maximum: 50,
            default: 20,
            description: '参与者排行数量上限。'
          },
          reason: {
            type: 'string',
            description: '调用原因。'
          }
        }, ['keywords'])
      }
    },
    {
      type: 'function',
      function: {
        name: 'aggregate_messages',
        description: '对已读取的上下文消息进行聚合整理。适合统计、摘要、时间线或消息类型整理。',
        parameters: objectSchema({
          metric: {
            type: 'string',
            enum: ['speaker_count', 'message_count', 'kind_count', 'timeline', 'summary'],
            default: 'summary',
            description: '聚合类型。'
          },
          reason: {
            type: 'string',
            description: '调用原因。'
          }
        })
      }
    },
    {
      type: 'function',
      function: {
        name: 'answer',
        description: '当证据已经足够，或工具观察明确显示证据不足时，调用此工具进入最终回答。',
        parameters: objectSchema({
          reason: {
            type: 'string',
            description: '为什么现在可以回答。'
          }
        })
      }
    }
  ]
}

export function parseNativeToolCallArguments(
  toolName: string,
  rawArguments: string | Record<string, unknown> | null | undefined
): NativeToolArgumentParseResult {
  if (!isNativeSessionQAToolName(toolName)) {
    return {
      args: {},
      action: null,
      error: `未知工具：${toolName}`
    }
  }

  let args: Record<string, unknown> = {}

  try {
    if (typeof rawArguments === 'string') {
      const text = stripJsonFence(rawArguments.trim())
      if (text) {
        const parsed = JSON.parse(text)
        if (!isRecord(parsed)) {
          return { args: {}, action: null, error: `${toolName} 参数必须是 JSON object。` }
        }
        args = parsed
      }
    } else if (isRecord(rawArguments)) {
      args = rawArguments
    }
  } catch (error) {
    return {
      args: {},
      action: null,
      error: `${toolName} 参数 JSON 解析失败：${error instanceof Error ? error.message : String(error)}`
    }
  }

  const action = normalizeToolAction({ ...args, action: toolName })
  if (!action) {
    return {
      args,
      action: null,
      error: `${toolName} 参数未通过本地安全校验。`
    }
  }

  return { args, action }
}

export function toSessionQAToolName(toolName: string): SessionQAToolName {
  return isNativeSessionQAToolName(toolName) ? toolName : 'answer'
}
