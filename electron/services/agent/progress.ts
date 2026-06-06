import { AsyncLocalStorage } from 'async_hooks'
import type { AgentProgressEvent, AgentProgressReporter } from './types'

const progressStorage = new AsyncLocalStorage<AgentProgressReporter>()
const depthStorage = new AsyncLocalStorage<number>()

export async function withAgentProgress<T>(
  reporter: AgentProgressReporter | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!reporter) return fn()
  return progressStorage.run(reporter, fn)
}

/** 委托子 Agent 期间提升进度深度：其内工具进度带 depth≥1，前端据此标"子助手"。 */
export async function withSubAgentScope<T>(fn: () => Promise<T>): Promise<T> {
  const depth = (depthStorage.getStore() ?? 0) + 1
  return depthStorage.run(depth, fn)
}

export function reportAgentProgress(event: Omit<AgentProgressEvent, 'at'>): void {
  const reporter = progressStorage.getStore()
  if (!reporter) return
  reporter({ depth: depthStorage.getStore() ?? 0, ...event, at: Date.now() })
}
