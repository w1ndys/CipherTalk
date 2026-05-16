import type { AgentRetriever } from './ai-agent/qa/data/retriever'
import type { ChatSearchIndexService } from './search/chatSearchIndexService'

export type BuiltinToolDef = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export const BUILTIN_TOOL_SCHEMAS: BuiltinToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'ct_list_sessions',
      description: '列出用户的微信会话（私聊、群聊）列表，返回会话名称和 sessionId。在需要了解用户有哪些聊天或需要定位特定会话时使用。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回数量，默认 20，最多 100' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ct_list_contacts',
      description: '列出用户的微信通讯录联系人，包括好友和群组。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回数量，默认 30，最多 200' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ct_search_messages',
      description: '在微信会话中按关键词搜索消息。有向量索引的会话使用混合检索（FTS + 向量 + reranker），无向量的使用高质量关键词检索。可指定 sessionId 限定范围，不填则跨最近会话搜索。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '搜索关键词' },
          sessionId: { type: 'string', description: '（可选）限定搜索的会话 sessionId，不填则跨多个最近会话搜索' },
          limit: { type: 'number', description: '返回结果数，默认 20，最多 50' }
        },
        required: ['keyword']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ct_get_recent_messages',
      description: '获取指定微信会话的最近消息记录。需要先通过 ct_list_sessions 获取 sessionId。',
      parameters: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: '会话的 sessionId（从 ct_list_sessions 获取）' },
          limit: { type: 'number', description: '返回消息数量，默认 15，最多 50' }
        },
        required: ['sessionId']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ct_grep_messages',
      description: '用正则表达式在聊天记录中精确匹配内容。适合查找特定格式的信息：手机号、金额、日期、链接、合同编号、特定词组等。返回带上下文的匹配片段。可指定 sessionId 限定单个会话，不填则扫描最近活跃的多个会话。指定时间范围时使用 SQL 级别过滤，可覆盖历史全量消息；不指定时间范围则扫描最近消息。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript 正则表达式，如 "1[3-9]\\\\d{9}" 匹配手机号，"\\\\d+元" 匹配金额' },
          sessionId: { type: 'string', description: '（可选）限定搜索的会话 sessionId，不填则跨最近会话搜索' },
          sender: { type: 'string', description: '（可选）按发送人过滤，模糊匹配用户名，填 "我" 则只看自己发的消息' },
          startTime: { type: 'number', description: '（可选）起始时间戳（Unix 秒），配合 endTime 限定时间范围，可查任意历史区间' },
          endTime: { type: 'number', description: '（可选）结束时间戳（Unix 秒），不填则到最新消息' },
          limit: { type: 'number', description: '返回结果数，默认 20，最多 50' },
          caseInsensitive: { type: 'boolean', description: '是否忽略大小写，默认 true' }
        },
        required: ['pattern']
      }
    }
  }
]

type SearchHitRow = {
  sessionId: string
  sessionName: string
  text: string
  sender: string | null
  time: number
  score: number
  source: string
}

/**
 * 对单个会话执行最优搜索：
 * - 有向量索引 → 完整混合检索（FTS + 向量 + RRF + reranker）
 * - 仅有 FTS 索引 → 高质量关键词检索（BM25 + LIKE + RRF）
 * - 两者都没有 → 原始扫描兜底
 */
async function searchOneSession(
  retriever: InstanceType<typeof AgentRetriever>,
  indexService: InstanceType<typeof ChatSearchIndexService>,
  sessionId: string,
  sessionName: string | undefined,
  keyword: string,
  limit: number
): Promise<SearchHitRow[]> {
  const vectorState = indexService.getSessionVectorIndexState(sessionId)
  const hasVectors = vectorState.vectorizedCount > 0

  const { result } = await retriever.search({
    sessionId,
    query: keyword,
    semanticQuery: hasVectors ? keyword : undefined,
    limit,
    expandEvidence: false
  })

  return result.hits.map(hit => ({
    sessionId: hit.session.sessionId,
    sessionName: sessionName ?? hit.session.displayName,
    text: hit.message.text,
    sender: hit.message.sender.isSelf ? '我' : (hit.message.sender.displayName || hit.message.sender.username),
    time: hit.message.timestamp,
    score: hit.score,
    source: hit.retrievalSource
  }))
}

export async function executeBuiltinTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
  const { chatService } = await import('./chatService')

  if (toolName === 'ct_list_sessions') {
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 10))
    const result = await chatService.getSessions(0, limit)
    if (!result.success) return { error: result.error }
    return (result.sessions || []).map(s => ({
      sessionId: s.username,
      name: s.displayName || s.username,
      lastMessage: s.summary,
      lastTime: s.lastTimestamp
    }))
  }

  if (toolName === 'ct_list_contacts') {
    const limit = Math.min(200, Math.max(1, Number(args.limit) || 30))
    const result = await chatService.getContacts()
    if (!result.success) return { error: result.error }
    return (result.contacts || []).slice(0, limit).map(c => ({
      username: c.username,
      name: c.displayName,
      remark: c.remark,
      type: c.type
    }))
  }

  if (toolName === 'ct_search_messages') {
    const keyword = String(args.keyword || '')
    if (!keyword) return { error: '缺少 keyword 参数' }
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 20))
    const { agentRetriever } = await import('./ai-agent/qa/data/retriever')
    const { chatSearchIndexService } = await import('./search/chatSearchIndexService')
    const sessionId = args.sessionId ? String(args.sessionId) : undefined

    if (sessionId) {
      return searchOneSession(agentRetriever, chatSearchIndexService, sessionId, undefined, keyword, limit)
    }

    // 跨会话搜索：取前 10 个最近会话，每个最多 3 条，按 score 全局排序后取 top limit
    const sessionsResult = await chatService.getSessions(0, 10)
    const sessions = sessionsResult.sessions || []
    const allHits: SearchHitRow[] = []
    for (const s of sessions) {
      const hits = await searchOneSession(
        agentRetriever, chatSearchIndexService,
        s.username, s.displayName || s.username,
        keyword, 3
      )
      allHits.push(...hits)
    }
    allHits.sort((a, b) => b.score - a.score)
    return allHits.slice(0, limit)
  }

  if (toolName === 'ct_get_recent_messages') {
    const sessionId = String(args.sessionId || '')
    if (!sessionId) return { error: '缺少 sessionId 参数' }
    const limit = Math.min(50, Math.max(1, Number(args.limit) || 15))
    const result = await chatService.getMessages(sessionId, 0, limit)
    if (!result.success) return { error: result.error }
    return (result.messages || []).map(m => {
      const raw = m.parsedContent || ''
      return {
        text: raw.length > 400 ? raw.slice(0, 400) + '…' : raw,
        sender: m.isSend === 1 ? '我' : (m.senderUsername || '对方'),
        time: m.createTime
      }
    })
  }

  if (toolName === 'ct_grep_messages') {
    const pattern = String(args.pattern || '')
    if (!pattern) return { error: '缺少 pattern 参数' }

    let regex: RegExp
    try {
      regex = new RegExp(pattern, args.caseInsensitive !== false ? 'i' : '')
    } catch (e) {
      return { error: `无效的正则表达式: ${e instanceof Error ? e.message : String(e)}` }
    }

    const limit = Math.min(50, Math.max(1, Number(args.limit) || 20))
    const sessionId = args.sessionId ? String(args.sessionId) : undefined
    const senderFilter = args.sender ? String(args.sender).toLowerCase() : undefined
    const startTime = args.startTime ? Number(args.startTime) : undefined
    const endTime = args.endTime ? Number(args.endTime) : undefined
    const hasTimeRange = startTime !== undefined || endTime !== undefined

    type GrepHit = { sessionId: string; sessionName: string; text: string; match: string; sender: string; time: number }

    const grepSession = async (sid: string, sName: string, scanLimit: number, maxHits: number): Promise<GrepHit[]> => {
      let messages: any[]
      if (hasTimeRange) {
        const r = await chatService.getMessagesByTimeRangeForSummary(sid, {
          startTime,
          endTime: endTime ?? Math.floor(Date.now() / 1000),
          limit: scanLimit
        })
        if (!r.success) return []
        messages = r.messages || []
      } else {
        const r = await chatService.getMessages(sid, 0, scanLimit)
        if (!r.success) return []
        messages = r.messages || []
      }

      const hits: GrepHit[] = []
      for (const m of messages) {
        if (hits.length >= maxHits) break
        const isSelf = m.isSend === 1
        const msgSender = isSelf ? '我' : (m.senderUsername || '对方')

        if (senderFilter) {
          if (senderFilter === '我' || senderFilter === 'me') {
            if (!isSelf) continue
          } else if (!msgSender.toLowerCase().includes(senderFilter)) {
            continue
          }
        }

        const raw = m.parsedContent || ''
        const found = raw.match(regex)
        if (!found) continue
        const idx = raw.indexOf(found[0])
        const start = Math.max(0, idx - 80)
        const end = Math.min(raw.length, idx + found[0].length + 80)
        let excerpt = raw.slice(start, end)
        if (start > 0) excerpt = '…' + excerpt
        if (end < raw.length) excerpt += '…'
        hits.push({
          sessionId: sid,
          sessionName: sName,
          text: excerpt,
          match: found[0].slice(0, 120),
          sender: msgSender,
          time: m.createTime
        })
      }
      return hits
    }

    // 有时间范围时走 SQL 过滤，扫描上限大幅提升
    const singleScanLimit = hasTimeRange ? 2000 : 500
    const crossScanLimit = hasTimeRange ? 1000 : 200

    if (sessionId) {
      const sr = await chatService.getSessions(0, 200)
      const s = (sr.sessions || []).find((x: any) => x.username === sessionId)
      return grepSession(sessionId, s?.displayName || sessionId, singleScanLimit, limit)
    }

    const sessionsResult = await chatService.getSessions(0, 20)
    const allHits: GrepHit[] = []
    for (const s of sessionsResult.sessions || []) {
      if (allHits.length >= limit) break
      const hits = await grepSession(s.username, s.displayName || s.username, crossScanLimit, limit - allHits.length)
      allHits.push(...hits)
    }
    return allHits
  }

  return { error: `未知内置工具: ${toolName}` }
}
