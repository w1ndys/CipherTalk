/**
 * AI Agent 对话页（Phase C）——使用 AI SDK 的 useChat + AI Elements 组件。
 * 数据：useChat 走 IpcChatTransport（IPC → AI 子进程 → 流式 UIMessageChunk）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import { isToolUIPart, type ChatStatus } from 'ai'
import { BarChart3, Clock3, Database, Search, Sparkles } from 'lucide-react'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageAttachment, MessageAttachments, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuItem,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHeader,
  PromptInputProvider,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSpeechButton,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
  usePromptInputController,
} from '@/components/ai-elements/prompt-input'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Loader } from '@/components/ai-elements/loader'
import { IpcChatTransport, type AgentModelConfig } from '@/features/aiagent/transport/ipcChatTransport'
import * as configService from '@/services/config'

const PROMPT_PRESETS = [
  { label: '最近聊了什么', text: '最近一周我和大家主要聊了什么？按主题总结，并列出关键时间。', icon: Clock3 },
  { label: '找相关记录', text: '帮我找一下最近聊到“”的聊天记录，按相关度排序。', icon: Search },
  { label: '统计高频联系人', text: '统计最近一个月互动最多的联系人，并说明互动高峰时间。', icon: BarChart3 },
]

function PromptPresetButton({ label, text, icon: Icon }: (typeof PROMPT_PRESETS)[number]) {
  const { textInput } = usePromptInputController()
  return (
    <PromptInputButton onClick={() => textInput.setInput(text)}>
      <Icon className="size-3.5" />
      {label}
    </PromptInputButton>
  )
}

function PromptPresetMenuItem({ label, text, icon: Icon }: (typeof PROMPT_PRESETS)[number]) {
  const { textInput } = usePromptInputController()
  return (
    <PromptInputActionMenuItem onSelect={() => textInput.setInput(text)}>
      <Icon className="size-4" />
      {label}
    </PromptInputActionMenuItem>
  )
}

function AgentPromptSubmit({ busy, status }: { busy: boolean; status: ChatStatus }) {
  const { textInput, attachments } = usePromptInputController()
  const disabled = !busy && !textInput.value.trim() && attachments.files.length === 0
  return <PromptInputSubmit disabled={disabled} status={status} />
}

export default function AgentPage() {
  const [presets, setPresets] = useState<configService.AiConfigPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('current')
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) || null,
    [presets, selectedPresetId]
  )
  const selectedModelConfig = useMemo<AgentModelConfig | null>(() => {
    if (!selectedPreset) return null
    return {
      provider: selectedPreset.provider,
      apiKey: selectedPreset.apiKey,
      model: selectedPreset.model,
      baseURL: selectedPreset.baseURL,
      protocol: selectedPreset.protocol,
    }
  }, [selectedPreset])
  const selectedModelConfigRef = useRef<AgentModelConfig | null>(null)
  selectedModelConfigRef.current = selectedModelConfig

  const transport = useMemo(
    () => new IpcChatTransport({ kind: 'global' }, () => selectedModelConfigRef.current),
    []
  )
  const { messages, sendMessage, status, stop } = useChat({ transport })
  const [scopeMode, setScopeMode] = useState('global')
  const busy = status === 'submitted' || status === 'streaming'

  useEffect(() => {
    let cancelled = false
    void configService.getAiConfigPresets().then((items) => {
      if (cancelled) return
      setPresets(items)
      setSelectedPresetId((current) => {
        if (current !== 'current' && items.some((item) => item.id === current)) return current
        return items[0]?.id || 'current'
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleSubmit = (message: PromptInputMessage) => {
    if (busy) {
      void stop()
      return
    }
    const text = message.text.trim()
    if (!text && message.files.length === 0) return
    void sendMessage({ text, files: message.files })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Conversation className="flex-1">
        <ConversationContent>
          {messages.length === 0 ? (
            <ConversationEmptyState
              title="AI 助手"
              description="用自然语言问问你的聊天记录吧"
            />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.parts.map((part, index) => {
                    if (part.type === 'text') {
                      return <MessageResponse key={index}>{part.text}</MessageResponse>
                    }
                    if (part.type === 'file') {
                      return (
                        <MessageAttachments key={index}>
                          <MessageAttachment data={part} />
                        </MessageAttachments>
                      )
                    }
                    if (part.type === 'reasoning') {
                      return (
                        <Reasoning key={index} isStreaming={status === 'streaming'}>
                          <ReasoningTrigger />
                          <ReasoningContent>{part.text}</ReasoningContent>
                        </Reasoning>
                      )
                    }
                    if (isToolUIPart(part)) {
                      return (
                        <Tool key={index}>
                          <ToolHeader type={part.type as `tool-${string}`} state={part.state} />
                          <ToolContent>
                            <ToolInput input={part.input} />
                            <ToolOutput output={part.output} errorText={part.errorText} />
                          </ToolContent>
                        </Tool>
                      )
                    }
                    return null
                  })}
                </MessageContent>
              </Message>
            ))
          )}
          {status === 'submitted' && <Loader />}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div style={{ padding: 12 }}>
        <PromptInputProvider>
          <PromptInput
            accept="image/*,.txt,.md,.json,.csv"
            maxFiles={6}
            maxFileSize={8 * 1024 * 1024}
            multiple
            onSubmit={handleSubmit}
          >
            <PromptInputHeader className="border-b">
              <PromptInputAttachments className="p-0">
                {(attachment) => <PromptInputAttachment data={attachment} />}
              </PromptInputAttachments>
              <div className="flex w-full flex-wrap items-center gap-1">
                {PROMPT_PRESETS.map((preset) => (
                  <PromptPresetButton key={preset.label} {...preset} />
                ))}
              </div>
            </PromptInputHeader>

            <PromptInputBody>
              <PromptInputTextarea placeholder="问问你的聊天记录，Enter 发送，Shift + Enter 换行…" />
            </PromptInputBody>

            <PromptInputFooter className="flex-wrap">
              <PromptInputTools>
                <PromptInputActionMenu>
                  <PromptInputActionMenuTrigger aria-label="更多输入操作" />
                  <PromptInputActionMenuContent>
                    <PromptInputActionAddAttachments label="添加图片或文件" />
                    {PROMPT_PRESETS.map((preset) => (
                      <PromptPresetMenuItem key={preset.label} {...preset} />
                    ))}
                  </PromptInputActionMenuContent>
                </PromptInputActionMenu>
                <PromptInputSpeechButton aria-label="语音输入" language="zh-CN" />
              </PromptInputTools>

              <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
                <PromptInputSelect value={scopeMode} onValueChange={setScopeMode}>
                  <PromptInputSelectTrigger aria-label="检索范围" className="h-8 max-w-28 px-2">
                    <Database className="size-3.5" />
                    <PromptInputSelectValue />
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent>
                    <PromptInputSelectItem value="global">全局记录</PromptInputSelectItem>
                    <PromptInputSelectItem disabled value="session">当前会话</PromptInputSelectItem>
                  </PromptInputSelectContent>
                </PromptInputSelect>

                <PromptInputSelect value={selectedPresetId} onValueChange={setSelectedPresetId}>
                  <PromptInputSelectTrigger aria-label="模型路由" className="h-8 max-w-28 px-2">
                    <Sparkles className="size-3.5" />
                    <PromptInputSelectValue />
                  </PromptInputSelectTrigger>
                  <PromptInputSelectContent>
                    <PromptInputSelectItem value="current">当前配置</PromptInputSelectItem>
                    {presets.map((preset) => (
                      <PromptInputSelectItem key={preset.id} value={preset.id}>
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate">{preset.name}</span>
                          <span className="truncate text-xs text-muted-foreground">{preset.provider} · {preset.model}</span>
                        </span>
                      </PromptInputSelectItem>
                    ))}
                  </PromptInputSelectContent>
                </PromptInputSelect>

                <AgentPromptSubmit busy={busy} status={status} />
              </div>
            </PromptInputFooter>
          </PromptInput>
        </PromptInputProvider>
      </div>
    </div>
  )
}
