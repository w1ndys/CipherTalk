/**
 * 参与者解析工具
 */
import { executeMcpTool } from '../../../mcp/dispatcher'
import type { McpContactsPayload } from '../../../mcp/types'
import type { ContextWindow, KnownSearchHit, ParticipantResolution, ToolLoopAction } from '../types'
import { compactText } from '../utils/text'
import { dedupeMessagesByCursor, describeSender, participantMatches } from '../utils/message'

export async function resolveParticipantName(input: {
  sessionId: string; name?: string; contextWindows: ContextWindow[]; knownHits: KnownSearchHit[]
}): Promise<ParticipantResolution> {
  const query = compactText(input.name || '', 48)
  const observedMessages = dedupeMessagesByCursor([
    ...input.contextWindows.flatMap((w) => w.messages),
    ...input.knownHits.map((h) => h.message)
  ])

  if (query) {
    const observed = observedMessages.find((m) => participantMatches(query, m))
    if (observed?.sender.username || observed?.sender.displayName) {
      return { query, senderUsername: observed.sender.username || undefined, displayName: describeSender(observed), confidence: observed.sender.username ? 'high' : 'medium', source: 'observed' }
    }
  }

  if (query) {
    try {
      const result = await executeMcpTool('list_contacts', { q: query, limit: 10, offset: 0 })
      const payload = result.payload as McpContactsPayload
      const exact = payload.items.find((c) => {
        const names = [c.displayName, c.remark || '', c.nickname || '', c.contactId]
        return names.some((n) => n && (n === query || n.toLowerCase() === query.toLowerCase()))
      }) || payload.items[0]
      if (exact) {
        return { query, senderUsername: exact.contactId, displayName: exact.displayName || exact.remark || exact.nickname || exact.contactId, confidence: exact.displayName === query || exact.remark === query || exact.nickname === query ? 'high' : 'medium', source: 'contacts' }
      }
    } catch {
      // 参与者解析失败不应中断问答
    }
  }

  return { query: query || '未指定参与者', confidence: 'low', source: 'fallback' }
}

export function findResolvedSenderUsername(action: Extract<ToolLoopAction, { action: 'read_by_time_range' }>, resolvedParticipants: ParticipantResolution[]): string | undefined {
  if (action.senderUsername) return action.senderUsername
  if (!action.participantName) return resolvedParticipants.find((i) => i.senderUsername)?.senderUsername
  const normalized = action.participantName.toLowerCase()
  return resolvedParticipants.find((i) => {
    const displayName = (i.displayName || '').toLowerCase()
    return i.query.toLowerCase() === normalized || (Boolean(displayName) && (displayName.includes(normalized) || normalized.includes(displayName)))
  })?.senderUsername
}
