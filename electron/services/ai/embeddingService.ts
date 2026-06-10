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

/** dimension>0 时要求接口按该维度输出（需模型支持）；两种 provider key 都带，互不干扰。0 = 不指定。 */
function embeddingProviderOptions(cfg: EmbeddingConfig) {
  if (!cfg.dimension || cfg.dimension <= 0) return undefined
  return { openai: { dimensions: cfg.dimension }, openaiCompatible: { dimensions: cfg.dimension } }
}

/** 批量嵌入（建索引用）。 */
export async function embedTexts(texts: string[], cfg?: EmbeddingConfig): Promise<number[][]> {
  if (texts.length === 0) return []
  const c = cfg || getEmbeddingConfig()
  const { embeddings } = await embedMany({ model: buildEmbeddingModel(c), values: texts, providerOptions: embeddingProviderOptions(c) })
  return embeddings
}

// 查询嵌入短 TTL 缓存（含在飞请求去重）：Agent 准备阶段会对同一个问题并行做
// MCP 工具/技能两路向量筛选，靠这里共享同一次嵌入请求；“重新生成”同样命中。
const QUERY_EMBED_CACHE_TTL_MS = 60 * 1000
const QUERY_EMBED_CACHE_MAX = 20
const queryEmbedCache = new Map<string, { at: number; promise: Promise<number[]> }>()

/** 单条嵌入（查询用）。 */
export function embedQuery(text: string, cfg?: EmbeddingConfig): Promise<number[]> {
  const c = cfg || getEmbeddingConfig()
  const key = [c.protocol, c.baseURL, c.model, c.dimension || 0, text].join('\n')
  const cached = queryEmbedCache.get(key)
  if (cached && Date.now() - cached.at < QUERY_EMBED_CACHE_TTL_MS) return cached.promise

  const promise = embed({ model: buildEmbeddingModel(c), value: text, providerOptions: embeddingProviderOptions(c) })
    .then(({ embedding }) => embedding)
  queryEmbedCache.set(key, { at: Date.now(), promise })
  promise.catch(() => queryEmbedCache.delete(key)) // 失败不留缓存
  while (queryEmbedCache.size > QUERY_EMBED_CACHE_MAX) {
    const oldest = queryEmbedCache.keys().next().value
    if (oldest === undefined) break
    queryEmbedCache.delete(oldest)
  }
  return promise
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
