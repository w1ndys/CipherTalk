/**
 * 把 provider 配置变成 AI SDK 的 LanguageModel —— 纯函数，不依赖 Electron app/ConfigService，
 * 可在 AI 子进程内调用。逻辑对齐 ai/providers/base.ts 的 getModelProvider()。
 */
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { createProxyFetch } from '../ai/proxyFetch'
import type { AgentProviderConfig } from './types'

export function createLanguageModel(config: AgentProviderConfig): LanguageModel {
  const { providerKind, name, apiKey, baseURL, model, headers, proxyUrl } = config
  const fetch = createProxyFetch(proxyUrl)

  if (providerKind === 'anthropic') {
    return createAnthropic({ apiKey, baseURL, name, headers, fetch })(model as any)
  }
  if (providerKind === 'google') {
    return createGoogleGenerativeAI({ apiKey, baseURL, name, headers, fetch })(model as any)
  }
  if (providerKind === 'openai-responses') {
    return createOpenAI({ apiKey, baseURL, name, headers, fetch }).responses(model as any)
  }

  return createOpenAICompatible({ name, apiKey, baseURL, headers, includeUsage: true, fetch }).chatModel(model)
}
