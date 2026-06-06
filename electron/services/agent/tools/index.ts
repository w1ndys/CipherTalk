/**
 * 工具装配。按 scope 返回 ToolSet 给 ToolLoopAgent。
 * 工具职责与串联见文档 §7 / prompts.ts。chat_stats（统计）/ summarize_period（子 Agent 摘要）后置。
 */
import type { ToolSet } from 'ai'
import type { AgentScope } from '../types'
import { listContacts } from './listContacts'
import { searchMessages } from './searchMessages'
import { semanticSearch } from './semanticSearch'
import { getContext } from './getContext'
import { getTimeline } from './getTimeline'
import { chatStats } from './chatStats'
import { listGroups } from './listGroups'
import { groupMembers } from './groupMembers'
import { groupMemberRanking } from './groupMemberRanking'
import { querySql } from './querySql'

export function buildTools(_scope: AgentScope): ToolSet {
  return {
    list_contacts: listContacts,
    search_messages: searchMessages,
    semantic_search: semanticSearch,
    get_context: getContext,
    get_timeline: getTimeline,
    chat_stats: chatStats,
    list_groups: listGroups,
    group_members: groupMembers,
    group_member_ranking: groupMemberRanking,
    query_sql: querySql,
  }
}
