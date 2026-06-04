/**
 * AI Agent 对话页（Phase C）——使用 AI SDK 的 useChat + AI Elements 组件。
 * 数据：useChat 走 IpcChatTransport（IPC → AI 子进程 → 流式 UIMessageChunk）。
 */
import { useMemo } from 'react'
import { useChat } from '@ai-sdk/react'
import { isToolUIPart } from 'ai'
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation'
import { Message, MessageContent, MessageResponse } from '@/components/ai-elements/message'
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  type PromptInputMessage,
} from '@/components/ai-elements/prompt-input'
import { Reasoning, ReasoningContent, ReasoningTrigger } from '@/components/ai-elements/reasoning'
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from '@/components/ai-elements/tool'
import { Loader } from '@/components/ai-elements/loader'
import { IpcChatTransport } from '@/features/aiagent/transport/ipcChatTransport'

export default function AgentPage() {
  const transport = useMemo(() => new IpcChatTransport({ kind: 'global' }), [])
  const { messages, sendMessage, status, stop } = useChat({ transport })
  const busy = status === 'submitted' || status === 'streaming'

  const handleSubmit = (message: PromptInputMessage) => {
    if (busy) {
      void stop()
      return
    }
    const text = message.text.trim()
    if (!text) return
    void sendMessage({ text })
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
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea placeholder="输入问题，Enter 发送…" />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputSubmit status={status} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}
