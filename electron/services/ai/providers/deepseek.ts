import type OpenAI from 'openai'
import { BaseAIProvider, ChatOptions } from './base'

/**
 * DeepSeek 提供商元数据
 */
export const DeepSeekMetadata = {
  id: 'deepseek',
  name: 'deepseek',
  displayName: 'DeepSeek',
  description: '最便宜的选择，性价比极高',
  models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  pricing: '¥0.001/1K tokens',
  pricingDetail: {
    input: 0.001,   // 0.001元/1K tokens（最便宜）
    output: 0.002
  },
  website: 'https://www.deepseek.com/',
  logo: './AI-logo/deepseek-color.svg'
}

const MODEL_MAPPING: Record<string, string> = {
  // 兼容历史配置和手动输入，但实际请求不再发送即将弃用的旧模型名
  'DeepSeek V3': 'deepseek-v4-flash',
  'DeepSeek R1 (推理)': 'deepseek-v4-flash',
  'deepseek-chat': 'deepseek-v4-flash',
  'deepseek-reasoner': 'deepseek-v4-flash'
}

/**
 * DeepSeek 提供商
 */
export class DeepSeekProvider extends BaseAIProvider {
  name = DeepSeekMetadata.name
  displayName = DeepSeekMetadata.displayName
  models = DeepSeekMetadata.models
  pricing = DeepSeekMetadata.pricingDetail

  constructor(apiKey: string) {
    super(apiKey, 'https://api.deepseek.com')
  }

  /**
   * 获取真实模型ID
   */
  private getModelId(displayName: string): string {
    return MODEL_MAPPING[displayName] || displayName
  }

  private buildRequestParams(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions | undefined,
    stream: boolean
  ) {
    const enableThinking = options?.enableThinking !== false
    const requestParams: any = {
      model: this.getModelId(options?.model || this.models[0]),
      messages,
      max_tokens: options?.maxTokens,
      stream,
      thinking: {
        type: enableThinking ? 'enabled' : 'disabled'
      }
    }

    if (enableThinking) {
      requestParams.reasoning_effort = 'high'
    } else {
      requestParams.temperature = options?.temperature ?? 0.7
    }

    return requestParams
  }

  /**
   * 重写 chat 方法以使用新版 DeepSeek V4 模型和 thinking 参数
   */
  async chat(messages: OpenAI.Chat.ChatCompletionMessageParam[], options?: ChatOptions): Promise<string> {
    const client = await this.getClient()
    const response = await client.chat.completions.create(
      this.buildRequestParams(messages, options, false)
    )

    return response.choices[0]?.message?.content || ''
  }

  /**
   * 重写 streamChat 方法以使用新版 DeepSeek V4 模型和 thinking 参数
   */
  async streamChat(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    options: ChatOptions,
    onChunk: (chunk: string) => void
  ): Promise<void> {
    const client = await this.getClient()
    const stream = await client.chat.completions.create(
      this.buildRequestParams(messages, options, true)
    ) as any

    let isThinking = false

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta
      const content = delta?.content || ''
      const reasoning = delta?.reasoning_content || ''

      if (reasoning) {
        if (!isThinking) {
          onChunk('<think>')
          isThinking = true
        }
        onChunk(reasoning)
      } else if (content) {
        if (isThinking) {
          onChunk('</think>')
          isThinking = false
        }
        onChunk(content)
      }
    }

    if (isThinking) {
      onChunk('</think>')
    }
  }
}
