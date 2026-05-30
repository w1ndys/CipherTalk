import fs from 'fs'
import path from 'path'
import { BaseAIProvider, type ProviderKind } from './base'
import { getAppPath, getUserDataPath, isElectronPackaged } from '../../runtimePaths'

export type AIProviderProtocol = ProviderKind

export interface AIProviderMetadata {
  id: string
  name: string
  displayName: string
  description: string
  protocol: AIProviderProtocol
  baseURL: string
  models: string[]
  modelDetails?: AIModelInfo[]
  pricing: string
  pricingDetail: {
    input: number
    output: number
  }
  website?: string
  logo?: string
  optionalApiKey?: boolean
  allowCustomBaseURL?: boolean
  protocolOptions?: AIProviderProtocol[]
}

type ProviderConnectionMetadata = Omit<AIProviderMetadata, 'models' | 'modelDetails' | 'pricing' | 'pricingDetail'>

export interface AIModelInfo {
  id: string
  name: string
  providerId: string
  family?: string
  modalities: {
    input: string[]
    output: string[]
  }
  capabilities: {
    attachment: boolean
    reasoning: boolean
    toolCall: boolean
    structuredOutput: boolean
    temperature: boolean
    openWeights: boolean
  }
  limits: {
    context?: number
    input?: number
    output?: number
  }
  cost?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    inputAudio?: number
    outputAudio?: number
    reasoning?: number
    tiers?: unknown[]
    contextOver200k?: unknown
  }
  status?: string
  knowledge?: string
  releaseDate?: string
  lastUpdated?: string
  interleaved?: {
    field?: string
  }
  provider?: {
    npm?: string
    api?: string
    shape?: string
  }
}

const EMPTY_PRICING = {
  pricing: '在线获取',
  pricingDetail: { input: 0, output: 0 }
}

const PROVIDERS: ProviderConnectionMetadata[] = [
  {
    id: 'openai',
    name: 'openai',
    displayName: 'OpenAI',
    description: 'OpenAI Responses API',
    protocol: 'openai-responses',
    baseURL: 'https://api.openai.com/v1',
    website: 'https://openai.com/',
    logo: './AI-logo/openai.svg'
  },
  {
    id: 'anthropic',
    name: 'anthropic',
    displayName: 'Anthropic',
    description: 'Claude Messages API',
    protocol: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    website: 'https://www.anthropic.com/',
    logo: ''
  },
  {
    id: 'gemini',
    name: 'gemini',
    displayName: 'Gemini',
    description: 'Google Gemini 原生协议',
    protocol: 'google',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    website: 'https://ai.google.dev/',
    logo: './AI-logo/gemini-color.svg'
  },
  {
    id: 'deepseek',
    name: 'deepseek',
    displayName: 'DeepSeek',
    description: 'OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    website: 'https://www.deepseek.com/',
    logo: './AI-logo/deepseek-color.svg'
  },
  {
    id: 'qwen',
    name: 'qwen',
    displayName: '通义千问',
    description: 'DashScope OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    website: 'https://dashscope.aliyun.com/',
    logo: './AI-logo/qwen-color.svg'
  },
  {
    id: 'doubao',
    name: 'doubao',
    displayName: '豆包',
    description: '火山方舟 OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3',
    website: 'https://www.volcengine.com/product/ark',
    logo: './AI-logo/doubao-color.svg'
  },
  {
    id: 'kimi',
    name: 'kimi',
    displayName: 'Kimi',
    description: 'Moonshot OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    website: 'https://platform.moonshot.cn/',
    logo: './AI-logo/kimi-color.svg'
  },
  {
    id: 'minimax',
    name: 'minimax',
    displayName: 'MiniMax',
    description: 'MiniMax OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.minimaxi.com/v1',
    website: 'https://platform.minimaxi.com/',
    logo: './AI-logo/minimax.svg'
  },
  {
    id: 'siliconflow',
    name: 'siliconflow',
    displayName: '硅基流动',
    description: 'OpenAI-compatible 聚合接口',
    protocol: 'openai-compatible',
    baseURL: 'https://api.siliconflow.cn/v1',
    website: 'https://siliconflow.cn/',
    logo: './AI-logo/siliconflow-color.svg'
  },
  {
    id: 'xiaomi',
    name: 'xiaomi',
    displayName: 'Xiaomi MiMo',
    description: 'OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.xiaomimimo.com/v1',
    website: 'https://api.xiaomimimo.com/',
    logo: './AI-logo/xiaomimimo.svg'
  },
  {
    id: 'tencent',
    name: 'tencent',
    displayName: '腾讯元宝',
    description: '腾讯混元 OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.hunyuan.cloud.tencent.com/v1',
    website: 'https://cloud.tencent.com/product/hunyuan',
    logo: './AI-logo/yuanbao-color.svg'
  },
  {
    id: 'xai',
    name: 'xai',
    displayName: 'xAI',
    description: 'xAI OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://api.x.ai/v1',
    website: 'https://x.ai/',
    logo: './AI-logo/xai.svg'
  },
  {
    id: 'zhipu',
    name: 'zhipu',
    displayName: '智谱AI',
    description: '智谱 OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    website: 'https://open.bigmodel.cn/',
    logo: './AI-logo/zhipu-color.svg'
  },
  {
    id: 'ollama',
    name: 'ollama',
    displayName: 'Ollama (本地)',
    description: '本地 OpenAI-compatible 协议',
    protocol: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    website: 'https://ollama.com/',
    logo: './AI-logo/ollama.svg',
    optionalApiKey: true,
    allowCustomBaseURL: true
  },
  {
    id: 'custom',
    name: 'custom',
    displayName: '自定义',
    description: '自选 OpenAI Responses、OpenAI-compatible、Anthropic 或 Google 协议',
    protocol: 'openai-responses',
    baseURL: '',
    website: '',
    logo: './AI-logo/custom.svg',
    allowCustomBaseURL: true,
    protocolOptions: ['openai-responses', 'openai-compatible', 'anthropic', 'google']
  }
]

const PROVIDER_BY_ID = new Map(PROVIDERS.map(provider => [provider.id, provider]))
const PROVIDER_ID_ALIASES: Record<string, string> = {
  'openai-compatible': 'custom',
  'custom-responses': 'custom'
}
let modelsDevCache: { updatedAt: number; data: any } | null = null
const MODELS_DEV_CACHE_MS = 1000 * 60 * 5
const MODELS_DEV_SOURCE = process.env.CIPHERTALK_MODELS_URL || 'https://models.dev'
const MODELS_DEV_CACHE_PATH = process.env.CIPHERTALK_MODELS_PATH || path.join(
  getUserDataPath(),
  MODELS_DEV_SOURCE === 'https://models.dev' ? 'models-dev.json' : `models-dev-${Buffer.from(MODELS_DEV_SOURCE).toString('hex').slice(0, 16)}.json`
)
let modelsDevFetchPromise: Promise<any> | null = null

function toMetadata(provider: ProviderConnectionMetadata, modelDetails: AIModelInfo[] = [], pricing = EMPTY_PRICING): AIProviderMetadata {
  return {
    ...provider,
    models: modelDetails.map(model => model.id),
    modelDetails,
    pricing: pricing.pricing,
    pricingDetail: { ...pricing.pricingDetail }
  }
}

function cloneMetadata(provider: AIProviderMetadata): AIProviderMetadata {
  return {
    ...provider,
    models: [...provider.models],
    protocolOptions: provider.protocolOptions ? [...provider.protocolOptions] : undefined,
    modelDetails: provider.modelDetails?.map(model => ({
      ...model,
      modalities: { input: [...model.modalities.input], output: [...model.modalities.output] },
      capabilities: { ...model.capabilities },
      limits: { ...model.limits },
      cost: model.cost ? { ...model.cost, tiers: model.cost.tiers ? [...model.cost.tiers] : undefined } : undefined,
      interleaved: model.interleaved ? { ...model.interleaved } : undefined,
      provider: model.provider ? { ...model.provider } : undefined
    })),
    pricingDetail: { ...provider.pricingDetail }
  }
}

export function normalizeProviderId(providerId: string): string {
  return PROVIDER_ID_ALIASES[providerId] || providerId
}

function readModelsDevCacheFile(): { updatedAt: number; data: any } | null {
  try {
    if (!fs.existsSync(MODELS_DEV_CACHE_PATH)) return null
    const stat = fs.statSync(MODELS_DEV_CACHE_PATH)
    const data = JSON.parse(fs.readFileSync(MODELS_DEV_CACHE_PATH, 'utf-8'))
    return { updatedAt: stat.mtimeMs, data }
  } catch (error) {
    console.warn('[AIProviderCatalog] 读取 models.dev 缓存失败:', error instanceof Error ? error.message : String(error))
    return null
  }
}

function writeModelsDevCacheFile(data: any): void {
  try {
    fs.mkdirSync(path.dirname(MODELS_DEV_CACHE_PATH), { recursive: true })
    fs.writeFileSync(MODELS_DEV_CACHE_PATH, JSON.stringify(data), 'utf-8')
  } catch (error) {
    console.warn('[AIProviderCatalog] 写入 models.dev 缓存失败:', error instanceof Error ? error.message : String(error))
  }
}

function getBundledModelsDevPath(): string {
  return isElectronPackaged()
    ? path.join(process.resourcesPath, 'assets', 'models-dev.json')
    : path.join(getAppPath(), 'electron', 'assets', 'models-dev.json')
}

function readBundledModelsDevData(): any | null {
  try {
    const bundledPath = getBundledModelsDevPath()
    if (!fs.existsSync(bundledPath)) return null
    return JSON.parse(fs.readFileSync(bundledPath, 'utf-8'))
  } catch (error) {
    console.warn('[AIProviderCatalog] 读取内置 models.dev 快照失败:', error instanceof Error ? error.message : String(error))
    return null
  }
}

function readAvailableModelsDevData(): any | null {
  if (modelsDevCache?.data) return modelsDevCache.data

  const diskCache = readModelsDevCacheFile()
  if (diskCache) {
    modelsDevCache = diskCache
    return diskCache.data
  }

  const bundled = readBundledModelsDevData()
  if (bundled) {
    modelsDevCache = { updatedAt: Date.now(), data: bundled }
    return bundled
  }

  return null
}

async function fetchModelsDevData(): Promise<any> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(`${MODELS_DEV_SOURCE.replace(/\/+$/, '')}/api.json`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'CipherTalk' }
    })
    if (!response.ok) {
      throw new Error(`models.dev 请求失败: ${response.status}`)
    }
    return await response.json()
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchAndCacheModelsDevData(): Promise<any> {
  if (!modelsDevFetchPromise) {
    modelsDevFetchPromise = fetchModelsDevData()
      .then((data) => {
        modelsDevCache = { updatedAt: Date.now(), data }
        writeModelsDevCacheFile(data)
        return data
      })
      .finally(() => {
        modelsDevFetchPromise = null
      })
  }

  return modelsDevFetchPromise
}

async function getModelsDevData(): Promise<any> {
  const now = Date.now()
  if (modelsDevCache && now - modelsDevCache.updatedAt < MODELS_DEV_CACHE_MS) {
    return modelsDevCache.data
  }

  const diskCache = readModelsDevCacheFile()
  if (diskCache && now - diskCache.updatedAt < MODELS_DEV_CACHE_MS) {
    modelsDevCache = diskCache
    return diskCache.data
  }

  if (process.env.CIPHERTALK_DISABLE_MODELS_FETCH === '1') {
    if (diskCache) {
      modelsDevCache = diskCache
      return diskCache.data
    }
    const bundled = readBundledModelsDevData()
    if (bundled) {
      modelsDevCache = { updatedAt: now, data: bundled }
      return bundled
    }
    return {}
  }

  try {
    return await fetchAndCacheModelsDevData()
  } catch (error) {
    if (diskCache) {
      console.warn('[AIProviderCatalog] models.dev 在线获取失败，使用本地缓存:', error instanceof Error ? error.message : String(error))
      modelsDevCache = diskCache
      return diskCache.data
    }
    const bundled = readBundledModelsDevData()
    if (bundled) {
      console.warn('[AIProviderCatalog] models.dev 在线获取失败，使用内置快照:', error instanceof Error ? error.message : String(error))
      modelsDevCache = { updatedAt: now, data: bundled }
      return bundled
    }
    throw error
  }
}

export async function refreshModelsDevCache(force = false): Promise<void> {
  const now = Date.now()
  const diskCache = readModelsDevCacheFile()
  if (!force && diskCache && now - diskCache.updatedAt < MODELS_DEV_CACHE_MS) {
    modelsDevCache = diskCache
    return
  }

  if (process.env.CIPHERTALK_DISABLE_MODELS_FETCH === '1') {
    if (diskCache) modelsDevCache = diskCache
    return
  }

  const data = await fetchModelsDevData()
  modelsDevCache = { updatedAt: Date.now(), data }
  writeModelsDevCacheFile(data)
}

function normalizeModelsDevProviderId(providerId: string): string[] {
  const aliases: Record<string, string[]> = {
    gemini: ['google', 'google-generative-ai', 'gemini'],
    qwen: ['alibaba', 'dashscope', 'qwen'],
    doubao: ['bytedance', 'volcengine', 'doubao'],
    kimi: ['moonshotai', 'moonshot', 'kimi'],
    siliconflow: ['siliconflow'],
    zhipu: ['zhipuai', 'zhipu', 'bigmodel'],
    tencent: ['tencent-tokenhub', 'tencent', 'hunyuan'],
    xai: ['xai'],
    minimax: ['minimax']
  }
  return aliases[providerId] || [providerId]
}

function getModelsDevProvider(data: any, providerId: string): any | undefined {
  const providers = data?.providers || data
  for (const candidate of normalizeModelsDevProviderId(providerId)) {
    if (providers?.[candidate]) return providers[candidate]
  }
  return undefined
}

function getModelsDevModelEntries(provider: any): any[] {
  const models = provider?.models || provider
  if (Array.isArray(models)) return models
  if (models && typeof models === 'object') return Object.values(models)
  return []
}

function isTextChatModel(model: any): boolean {
  const input = Array.isArray(model?.modalities?.input) ? model.modalities.input : []
  const output = Array.isArray(model?.modalities?.output) ? model.modalities.output : []
  if (output.length > 0 && !output.includes('text')) return false
  if (input.length > 0 && !input.includes('text')) return false
  const id = String(model?.id || model?.name || '').toLowerCase()
  return !['embedding', 'rerank', 'whisper', 'tts', 'transcribe', 'speech', 'moderation', 'dall-e', 'image'].some(pattern => id.includes(pattern))
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(item => String(item || '').trim()).filter(Boolean) : []
}

function optionalNumber(value: unknown): number | undefined {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : undefined
}

function readModelDetailsFromModelsDevProvider(providerId: string, provider: any): AIModelInfo[] {
  return getModelsDevModelEntries(provider)
    .filter(isTextChatModel)
    .map((model: any): AIModelInfo | null => {
      const id = String(model?.id || model?.name || '').replace(/^models\//, '').trim()
      if (!id) return null

      return {
        id,
        name: String(model?.name || id),
        providerId,
        family: model?.family ? String(model.family) : undefined,
        modalities: {
          input: toStringArray(model?.modalities?.input),
          output: toStringArray(model?.modalities?.output)
        },
        capabilities: {
          attachment: Boolean(model?.attachment),
          reasoning: Boolean(model?.reasoning),
          toolCall: Boolean(model?.tool_call),
          structuredOutput: Boolean(model?.structured_output),
          temperature: model?.temperature !== false,
          openWeights: Boolean(model?.open_weights)
        },
        limits: {
          context: optionalNumber(model?.limit?.context),
          input: optionalNumber(model?.limit?.input),
          output: optionalNumber(model?.limit?.output)
        },
        cost: model?.cost ? {
          input: optionalNumber(model.cost.input),
          output: optionalNumber(model.cost.output),
          cacheRead: optionalNumber(model.cost.cache_read),
          cacheWrite: optionalNumber(model.cost.cache_write),
          inputAudio: optionalNumber(model.cost.input_audio),
          outputAudio: optionalNumber(model.cost.output_audio),
          reasoning: optionalNumber(model.cost.reasoning),
          tiers: Array.isArray(model.cost.tiers) ? model.cost.tiers : undefined,
          contextOver200k: model.cost.context_over_200k
        } : undefined,
        status: model?.status ? String(model.status) : undefined,
        knowledge: model?.knowledge ? String(model.knowledge) : undefined,
        releaseDate: model?.release_date ? String(model.release_date) : undefined,
        lastUpdated: model?.last_updated ? String(model.last_updated) : undefined,
        interleaved: model?.interleaved ? { field: model.interleaved.field ? String(model.interleaved.field) : undefined } : undefined,
        provider: model?.provider ? {
          npm: model.provider.npm ? String(model.provider.npm) : undefined,
          api: model.provider.api ? String(model.provider.api) : undefined,
          shape: model.provider.shape ? String(model.provider.shape) : undefined
        } : undefined
      }
    })
    .filter((model): model is AIModelInfo => Boolean(model))
}

function getPricingFromModelsDevProvider(provider: any): { pricing: string; pricingDetail: { input: number; output: number } } {
  const pricedModels = getModelsDevModelEntries(provider)
    .filter(isTextChatModel)
    .map((model: any) => ({
      input: Number(model?.cost?.input),
      output: Number(model?.cost?.output)
    }))
    .filter(item => Number.isFinite(item.input) && Number.isFinite(item.output))

  if (pricedModels.length === 0) return EMPTY_PRICING

  const cheapest = pricedModels.reduce((best, item) => (
    item.input + item.output < best.input + best.output ? item : best
  ), pricedModels[0])

  return {
    pricing: `$${cheapest.input}/1M input, $${cheapest.output}/1M output 起`,
    pricingDetail: {
      input: cheapest.input / 1000,
      output: cheapest.output / 1000
    }
  }
}

async function enrichProvider(provider: ProviderConnectionMetadata): Promise<AIProviderMetadata> {
  try {
    const data = await getModelsDevData()
    return enrichProviderWithModelsDevData(provider, data)
  } catch (error) {
    console.warn('[AIProviderCatalog] models.dev 获取失败:', error instanceof Error ? error.message : String(error))
    return toMetadata(provider)
  }
}

function enrichProviderWithModelsDevData(provider: ProviderConnectionMetadata, data: any): AIProviderMetadata {
  const modelsDevProvider = getModelsDevProvider(data, provider.id)
  if (!modelsDevProvider) return toMetadata(provider)

  return toMetadata(
    provider,
    readModelDetailsFromModelsDevProvider(provider.id, modelsDevProvider),
    getPricingFromModelsDevProvider(modelsDevProvider)
  )
}

export async function getProviderDefinitions(): Promise<AIProviderMetadata[]> {
  const data = readAvailableModelsDevData()
  if (!data) return PROVIDERS.map(provider => toMetadata(provider))
  return PROVIDERS.map(provider => enrichProviderWithModelsDevData(provider, data))
}

export function getProviderDefinition(providerId: string): AIProviderMetadata | undefined {
  const resolvedProviderId = normalizeProviderId(providerId)
  const provider = PROVIDER_BY_ID.get(resolvedProviderId)
  if (!provider) return undefined

  const data = modelsDevCache?.data
  if (!data) return toMetadata(provider)

  const modelsDevProvider = getModelsDevProvider(data, resolvedProviderId)
  if (!modelsDevProvider) return toMetadata(provider)

  return cloneMetadata(toMetadata(
    provider,
    readModelDetailsFromModelsDevProvider(resolvedProviderId, modelsDevProvider),
    getPricingFromModelsDevProvider(modelsDevProvider)
  ))
}

export async function getProviderDefinitionOnline(providerId: string): Promise<AIProviderMetadata | undefined> {
  const provider = PROVIDER_BY_ID.get(normalizeProviderId(providerId))
  return provider ? enrichProvider(provider) : undefined
}

export class CatalogAIProvider extends BaseAIProvider {
  name: string
  displayName: string
  models: string[]
  pricing: { input: number; output: number }
  private definition: AIProviderMetadata

  constructor(definition: AIProviderMetadata, apiKey: string, baseURL?: string) {
    const effectiveBaseURL = baseURL || definition.baseURL
    super(apiKey, effectiveBaseURL, definition.protocol)
    this.definition = definition
    this.name = definition.name
    this.displayName = definition.displayName
    this.models = definition.models
    this.pricing = definition.pricingDetail
  }

  protected getDefaultHeaders(): Record<string, string> | undefined {
    if (this.definition.id !== 'tencent' || !this.apiKey.includes('|')) {
      return undefined
    }

    const [secretId, secretKey] = this.apiKey.split('|').map(part => part.trim())
    if (!secretId || !secretKey) return undefined
    return { Authorization: `Bearer ${secretId};${secretKey}` }
  }
}

export async function getModelsDevModels(providerId: string): Promise<string[]> {
  const data = await getModelsDevData()
  const resolvedProviderId = normalizeProviderId(providerId)
  const provider = getModelsDevProvider(data, resolvedProviderId)
  return provider ? Array.from(new Set(readModelDetailsFromModelsDevProvider(resolvedProviderId, provider).map(model => model.id))) : []
}

export async function getModelsDevModelDetails(providerId: string): Promise<AIModelInfo[]> {
  const data = await getModelsDevData()
  const resolvedProviderId = normalizeProviderId(providerId)
  const provider = getModelsDevProvider(data, resolvedProviderId)
  return provider ? readModelDetailsFromModelsDevProvider(resolvedProviderId, provider) : []
}
