import { ipcMain } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { UIMessage } from 'ai'
import type { MainProcessContext } from '../context'
import type { AgentProviderConfigOverride, AgentScope } from '../../services/agent/types'

/** 进行中的 agent 运行：runId → AbortController，用于取消。 */
const agentAborters = new Map<string, AbortController>()

export function registerAiHandlers(_ctx: MainProcessContext): void {
  // ========= AI Agent（跑在独立 utilityProcess 子进程，主进程仅做 broker）=========
  ipcMain.handle('agent:run', async (event, payload: {
    runId: string
    messages: UIMessage[]
    scope?: AgentScope
    modelConfig?: AgentProviderConfigOverride | null
  }) => {
    const sender = event.sender
    const { runId } = payload
    const send = (chunk: unknown) => { if (!sender.isDestroyed()) sender.send('agent:chunk', { runId, chunk }) }
    const aborter = new AbortController()
    agentAborters.set(runId, aborter)
    try {
      const { agentProcessService } = await import('../../services/agent/agentProcessService')
      const { resolveProviderConfig } = await import('../../services/agent/resolveProviderConfig')
      const { convertToModelMessages } = await import('ai')
      const providerConfig = resolveProviderConfig(payload.modelConfig)
      const messages = await convertToModelMessages(payload.messages)
      await agentProcessService.run(
        { messages, providerConfig, scope: payload.scope ?? { kind: 'global' } },
        (chunk) => send(chunk),
        aborter.signal,
      )
      send('[DONE]')
      return { success: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      send({ type: 'error', errorText: message })
      send('[DONE]')
      return { success: false, error: message }
    } finally {
      agentAborters.delete(runId)
    }
  })

  ipcMain.handle('agent:abort', (_e, runId: string) => {
    agentAborters.get(runId)?.abort()
    return { success: true }
  })


  ipcMain.handle('ai:getProviders', async () => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      return aiService.getAllProviders()
    } catch (e) {
      console.error('[AI] 获取提供商列表失败:', e)
      return []
    }
  })

  ipcMain.handle('ai:getProxyStatus', async () => {
    try {
      const { proxyService } = await import('../../services/ai/proxyService')
      const proxyUrl = await proxyService.getSystemProxy()
      return {
        success: true,
        hasProxy: !!proxyUrl,
        proxyUrl: proxyUrl || null
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:refreshProxy', async () => {
    try {
      const { proxyService } = await import('../../services/ai/proxyService')
      proxyService.clearCache()
      const proxyUrl = await proxyService.getSystemProxy()
      return {
        success: true,
        hasProxy: !!proxyUrl,
        proxyUrl: proxyUrl || null,
        message: proxyUrl ? `已刷新代理: ${proxyUrl}` : '未检测到代理，使用直连'
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:testProxy', async (_, proxyUrl: string, testUrl?: string) => {
    try {
      const { proxyService } = await import('../../services/ai/proxyService')
      const success = await proxyService.testProxy(proxyUrl, testUrl)
      return {
        success,
        message: success ? '代理连接正常' : '代理连接失败'
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:testConnection', async (_, provider: string, apiKey: string, baseURL?: string, protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google') => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      return await aiService.testConnection(provider, apiKey, baseURL, protocol)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:listModels', async (_, options: { provider: string; apiKey?: string; baseURL?: string; protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' }) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      return await aiService.listProviderModels(options)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:estimateCost', async (_, messageCount: number, provider: string) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      const estimatedTokens = messageCount * 33
      const cost = aiService.estimateCost(estimatedTokens, provider)
      return { success: true, tokens: estimatedTokens, cost }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:readGuide', async (_, guideName: string) => {
    try {
      const guidePath = join(__dirname, '../electron/services/ai', guideName)
      if (!existsSync(guidePath)) {
        return { success: false, error: '指南文件不存在' }
      }
      const content = readFileSync(guidePath, 'utf-8')
      return { success: true, content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })
}
