import { useState, useEffect } from 'react'
import { MessageList } from './components/MessageList'
import { ChatInput } from './components/ChatInput'
import { ConversationSidebar } from './components/ConversationSidebar'
import { useAiAgentChat } from './hooks/useAiAgentChat'
import { useMcpSkillsData } from '../../hooks/useMcpSkillsData'
import { AGENT_SLASH_COMMANDS, AGENT_SUGGESTIONS } from './data'
import type { AiAgentConversationSummary } from '../../types/electron'
import type { ConversationGroup, ConversationItem, Scope } from './types'
import './styles/aiagent.scss'

function formatRelativeTime(ts: number): string {
  const ms = ts > 1e10 ? ts : ts * 1000
  const diff = Date.now() - ms
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  const d = new Date(ms)
  if (diff < 86_400_000) {
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function groupConversations(convs: AiAgentConversationSummary[]): ConversationGroup[] {
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(todayStart.getDate() - 1)
  const weekStart = new Date(todayStart); weekStart.setDate(todayStart.getDate() - 7)

  const buckets: { label: string; items: ConversationItem[] }[] = [
    { label: '今天', items: [] },
    { label: '昨天', items: [] },
    { label: '最近7天', items: [] },
    { label: '更早', items: [] },
  ]

  for (const conv of convs) {
    const ms = conv.updatedAt > 1e10 ? conv.updatedAt : conv.updatedAt * 1000
    const item: ConversationItem = {
      id: String(conv.id),
      title: conv.title || '新对话',
      preview: conv.preview || '',
      time: formatRelativeTime(conv.updatedAt),
    }
    if (ms >= todayStart.getTime()) buckets[0].items.push(item)
    else if (ms >= yesterdayStart.getTime()) buckets[1].items.push(item)
    else if (ms >= weekStart.getTime()) buckets[2].items.push(item)
    else buckets[3].items.push(item)
  }

  return buckets
    .filter(b => b.items.length > 0)
    .map(b => ({ group: b.label, items: b.items }))
}

interface Props {
  scope: Scope
  layout: 'full' | 'embedded'
}

export function AiAgentPanel({ scope, layout }: Props) {
  const {
    messages, loading, conversationId, conversations,
    send, cancel, reset, regenerate,
    selectConversation, deleteConversation, renameConversation,
  } = useAiAgentChat(scope)
  const { mcpServers, skills, busyServers, toggleServer } = useMcpSkillsData()
  const [collapsed, setCollapsed] = useState(layout === 'embedded')
  const [query, setQuery] = useState('')
  const [aiProvider, setAiProvider] = useState('')

  useEffect(() => {
    window.electronAPI?.config?.get('aiCurrentProvider').then(p => {
      setAiProvider((p as string) || '')
    }).catch(() => {})
  }, [])

  const grouped = groupConversations(conversations)
  const activeId = conversationId != null ? String(conversationId) : 'new'

  return (
    <div className={`agent-page agent-page--${layout}`}>
      <ConversationSidebar
        collapsed={collapsed}
        conversations={grouped}
        activeId={activeId}
        query={query}
        onQueryChange={setQuery}
        onToggle={() => setCollapsed(v => !v)}
        onNew={reset}
        onSelect={id => selectConversation(Number(id))}
        onDelete={id => deleteConversation(Number(id))}
        onRename={(id, title) => renameConversation(Number(id), title)}
      />
      <main className="agent-main" aria-label="Agent 对话">
        <MessageList
          messages={messages}
          loading={loading}
          onCancel={cancel}
          onRegenerate={regenerate}
          aiProvider={aiProvider}
        />
        <ChatInput
          scope={scope}
          onSend={send}
          disabled={loading}
          suggestions={AGENT_SUGGESTIONS}
          slashCommands={AGENT_SLASH_COMMANDS}
          mcpServers={mcpServers}
          busyServers={busyServers}
          onToggleServer={toggleServer}
          skills={skills}
        />
      </main>
    </div>
  )
}
