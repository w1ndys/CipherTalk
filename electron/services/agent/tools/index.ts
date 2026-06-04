/**
 * 工具装配。按 scope 返回 ToolSet 给 ToolLoopAgent。
 * 骨架阶段只放 semantic_search；后续补 search_messages / get_context / chat_stats / ...（见文档 §7）。
 */
import type { ToolSet } from 'ai'
import type { AgentScope } from '../types'
import { semanticSearch } from './semanticSearch'

export function buildTools(_scope: AgentScope): ToolSet {
  return {
    semantic_search: semanticSearch,
  }
}
