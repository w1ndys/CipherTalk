/**
 * 嵌入服务 —— 独立的嵌入模型配置（语义/向量检索用），与聊天模型分开。
 * 配置存 ConfigService.embeddingConfig；provider 构造方式对齐 base.ts 的 getModelProvider。
 * 可在主进程与 AI 子进程复用（ConfigService 在两边都能解析路径）。
 */
import { embed, embedMany } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import { ConfigService } from '../config'
import { createProxyFetch, getResolvedProxyUrl } from './proxyFetch'

export interface EmbeddingConfig {
  enabled: boolean
  provider: string
  protocol: 'openai-compatible' | 'openai'
  apiKey: string
  baseURL: string
  model: string
  dimension: number
}

/** 读取持久化的嵌入配置。 */
export function getEmbeddingConfig(): EmbeddingConfig {
  const cs = new ConfigService()
  try {
    return cs.get('embeddingConfig')
  } finally {
    cs.close()
  }
}

/** 写入嵌入配置（部分字段合并）。 */
export function saveEmbeddingConfig(patch: Partial<EmbeddingConfig>): EmbeddingConfig {
  const cs = new ConfigService()
  try {
    const next = { ...cs.get('embeddingConfig'), ...patch }
    cs.set('embeddingConfig', next)
    return next
  } finally {
    cs.close()
  }
}

function buildEmbeddingModel(cfg: EmbeddingConfig) {
  if (!cfg.apiKey) throw new Error('未配置嵌入模型 API Key')
  if (!cfg.model) throw new Error('未配置嵌入模型')
  const fetch = createProxyFetch(getResolvedProxyUrl())
  if (cfg.protocol === 'openai') {
    return createOpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL || undefined, name: 'embedding', fetch }).textEmbeddingModel(cfg.model)
  }
  return createOpenAICompatible({ name: 'embedding', apiKey: cfg.apiKey, baseURL: cfg.baseURL, fetch }).textEmbeddingModel(cfg.model)
}

/** 批量嵌入（建索引用）。 */
export async function embedTexts(texts: string[], cfg?: EmbeddingConfig): Promise<number[][]> {
  if (texts.length === 0) return []
  const model = buildEmbeddingModel(cfg || getEmbeddingConfig())
  const { embeddings } = await embedMany({ model, values: texts })
  return embeddings
}

/** 单条嵌入（查询用）。 */
export async function embedQuery(text: string, cfg?: EmbeddingConfig): Promise<number[]> {
  const model = buildEmbeddingModel(cfg || getEmbeddingConfig())
  const { embedding } = await embed({ model, value: text })
  return embedding
}

/** 测试嵌入配置：成功则回传实际维度。 */
export async function testEmbeddingConfig(cfg: EmbeddingConfig): Promise<{ success: boolean; dimension?: number; error?: string }> {
  try {
    const vector = await embedQuery('密语语义检索连接测试', cfg)
    if (!Array.isArray(vector) || vector.length === 0) {
      return { success: false, error: '嵌入返回为空' }
    }
    return { success: true, dimension: vector.length }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}
