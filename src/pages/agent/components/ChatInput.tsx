import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import {
  AtSign,
  Database,
  Hammer,
  Mic,
  Send,
  Slash,
  SlidersHorizontal,
  Sparkles,
  UserRoundSearch,
  X,
} from 'lucide-react'
import { MCP } from '@lobehub/icons'
import type { McpServerStatus } from '../../../hooks/useMcpSkillsData'
import type { AgentSkill, AttachedResource, McpServer, SlashCommand } from '../types'

interface Props {
  onSend: (text: string, attached: AttachedResource[], readLimit: number, skillIds: string[]) => void
  disabled?: boolean
  suggestions: string[]
  slashCommands: SlashCommand[]
  mcpServers: McpServer[]
  busyServers: Set<string>
  onToggleServer: (name: string, status: McpServerStatus) => void
  skills: AgentSkill[]
}

type ContextLength = '2k' | '8k' | '32k'

const READ_LIMIT_OPTIONS = [500, 1000, 1500, 2000] as const
type ReadLimit = typeof READ_LIMIT_OPTIONS[number]

const AGENT_READ_LIMIT_KEY = 'agentReadLimit'

async function loadReadLimit(): Promise<ReadLimit> {
  try {
    const v = await window.electronAPI?.config?.get(AGENT_READ_LIMIT_KEY as any)
    const n = Number(v)
    return (READ_LIMIT_OPTIONS as readonly number[]).includes(n) ? n as ReadLimit : 500
  } catch {
    return 500
  }
}

async function saveReadLimit(v: ReadLimit): Promise<void> {
  try {
    await window.electronAPI?.config?.set(AGENT_READ_LIMIT_KEY as any, v as any)
  } catch {
    // ignore
  }
}

export function ChatInput({
  onSend, disabled, suggestions, slashCommands,
  mcpServers, busyServers, onToggleServer, skills,
}: Props) {
  const [value, setValue] = useState('')
  const [showSlash, setShowSlash] = useState(false)
  const [showMention, setShowMention] = useState(false)
  const [showMcp, setShowMcp] = useState(false)
  const [showSkills, setShowSkills] = useState(false)
  const [showContext, setShowContext] = useState(false)
  const [attached, setAttached] = useState<AttachedResource[]>([])
  const [enabledSkills, setEnabledSkills] = useState<Set<string>>(new Set())
  const [temperature, setTemperature] = useState(0.7)
  const [contextLength, setContextLength] = useState<ContextLength>('8k')
  const [readLimit, setReadLimit] = useState<ReadLimit>(500)
  const [mentionSessions, setMentionSessions] = useState<Array<{ id: string; name: string; summary?: string; avatarUrl?: string }>>([])
  const [mentionLoading, setMentionLoading] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionSearchRef = useRef<HTMLInputElement>(null)
  const mentionLoadingRef = useRef(false)
  const mentionLoadedRef = useRef(false)

  // 一次性拉取所有会话（最多 1000 条），后续纯客户端过滤
  const loadMentionSessions = useCallback(async () => {
    if (mentionLoadingRef.current || mentionLoadedRef.current) return
    mentionLoadingRef.current = true
    setMentionLoading(true)
    try {
      const result = await window.electronAPI?.chat?.getSessions?.(0, 1000)
      if (result?.success && result.sessions) {
        mentionLoadedRef.current = true
        setMentionSessions(result.sessions.map((s: { username: string; displayName?: string; summary?: string; avatarUrl?: string }) => ({
          id: s.username,
          name: s.displayName || s.username,
          summary: s.summary,
          avatarUrl: s.avatarUrl
        })))
      }
    } catch {
      // ignore
    } finally {
      mentionLoadingRef.current = false
      setMentionLoading(false)
    }
  }, [])

  // 过滤逻辑：名字或摘要包含关键词（拼音首字母粗匹配）
  const filteredMentionSessions = useMemo(() => {
    const q = mentionQuery.trim().toLowerCase()
    if (!q) return mentionSessions
    return mentionSessions.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.summary || '').toLowerCase().includes(q)
    )
  }, [mentionSessions, mentionQuery])

  useEffect(() => {
    loadReadLimit().then(setReadLimit)
  }, [])

  // 弹窗打开时自动聚焦搜索框
  useEffect(() => {
    if (showMention) {
      requestAnimationFrame(() => mentionSearchRef.current?.focus())
    } else {
      setMentionQuery('')
    }
  }, [showMention])

  const closeAll = () => {
    setShowSlash(false)
    setShowMention(false)
    setShowMcp(false)
    setShowSkills(false)
    setShowContext(false)
  }

  const visibleSlashCommands = useMemo(() => {
    if (!value.startsWith('/')) return slashCommands
    const commandPrefix = value.split(' ')[0]
    return slashCommands.filter(item => item.command.startsWith(commandPrefix))
  }, [slashCommands, value])

  useEffect(() => {
    if (!showSlash && !showMention && !showMcp && !showSkills && !showContext) return
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest('.agent-popover-host')) return
      closeAll()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [showMention, showSlash, showMcp, showSkills, showContext])

  const submit = () => {
    const text = value.trim()
    if (!text || disabled) return
    onSend(text, attached, readLimit, [...enabledSkills])
    setValue('')
    setAttached([])
    closeAll()
    requestAnimationFrame(() => resizeTextarea())
  }

  const resizeTextarea = () => {
    const textarea = textareaRef.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() }
    if (e.key === '/' && !value) { setShowSlash(true) }
    if (e.key === 'Escape' && showMention) { setShowMention(false); return }
    if (e.key === 'Escape') closeAll()
  }

  const toggleSkill = (id: string) => {
    setEnabledSkills(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const connectedCount = mcpServers.filter(s => s.status === 'connected').length
  const skillEnabledCount = enabledSkills.size

  return (
    <footer className="agent-composer-wrap">
      {suggestions.length ? (
        <div className="agent-suggestions">
          {suggestions.map(suggestion => (
            <button key={suggestion} type="button" onClick={() => onSend(suggestion, [], readLimit, [])} disabled={disabled}>
              <Sparkles size={12} />
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      <div className="agent-composer" onClick={() => textareaRef.current?.focus()}>
        {attached.length ? (
          <div className="agent-composer__attached">
            {attached.map(item => (
              <span className="agent-attached-chip" key={item.id}>
                <Database size={13} />
                {item.label}
                <button
                  type="button"
                  onClick={event => {
                    event.stopPropagation()
                    setAttached(current => current.filter(r => r.id !== item.id))
                  }}
                  title="移除附件"
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          disabled={disabled}
          className="agent-composer__textarea"
          placeholder="给 Agent 安排一个任务... 按 @ 引用，按 / 输入命令"
          onChange={event => {
            const text = event.target.value
            setValue(text)
            // 检测光标前的 @query 模式，自动打开 / 更新引用搜索
            const cursor = event.target.selectionStart ?? text.length
            const match = text.slice(0, cursor).match(/@(\S*)$/)
            if (match) {
              if (!showMention) { setShowMention(true); loadMentionSessions() }
              setMentionQuery(match[1])
            }
            setShowSlash(text.startsWith('/') && !text.includes(' '))
            resizeTextarea()
          }}
          onKeyDown={handleKeyDown}
        />

        <div className="agent-composer__bar">
          <div className="agent-composer__left">
            {/* 引用对象 */}
            <div className="agent-popover-host">
              <button
                type="button"
                className={`agent-mention-button${showMention ? ' is-open' : ''}`}
                onClick={event => { event.stopPropagation(); closeAll(); setShowMention(v => { if (!v) loadMentionSessions(); return !v }) }}
                title="引用对象"
              >
                <AtSign size={15} />
              </button>
              {showMention ? (
                <ComposerPopover title="引用会话" onClose={() => setShowMention(false)}>
                  <div className="agent-mention-search-wrap">
                    <UserRoundSearch size={13} />
                    <input
                      ref={mentionSearchRef}
                      className="agent-mention-search"
                      placeholder="搜索会话..."
                      value={mentionQuery}
                      onChange={e => setMentionQuery(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Escape') setShowMention(false) }}
                    />
                  </div>
                  {mentionLoading ? (
                    <div className="agent-popover-empty"><span>加载中...</span></div>
                  ) : filteredMentionSessions.length === 0 ? (
                    <div className="agent-popover-empty">
                      <UserRoundSearch size={16} />
                      <span>{mentionQuery ? `没有匹配"${mentionQuery}"的会话` : '暂无会话'}</span>
                    </div>
                  ) : filteredMentionSessions.map(session => {
                    const alreadyAttached = attached.some(r => r.id === session.id)
                    return (
                      <button
                        className={`agent-popover-row${alreadyAttached ? ' is-active' : ''}`}
                        key={session.id}
                        type="button"
                        onClick={() => {
                          if (!alreadyAttached) {
                            setAttached(current => [
                              ...current,
                              { id: session.id, label: session.name, icon: 'database' as const }
                            ])
                          }
                          // 清除 textarea 里的 @query 文本
                          const textarea = textareaRef.current
                          if (textarea) {
                            const cursor = textarea.selectionStart ?? value.length
                            const before = value.slice(0, cursor)
                            const m = before.match(/@\S*$/)
                            if (m) setValue(before.slice(0, -m[0].length) + value.slice(cursor))
                          }
                          setShowMention(false)
                          requestAnimationFrame(() => textareaRef.current?.focus())
                        }}
                      >
                        <SessionAvatar name={session.name} avatarUrl={session.avatarUrl} />
                        <span className="agent-popover-row__text">
                          <strong>{session.name}</strong>
                          {session.summary ? <small>{session.summary}</small> : null}
                        </span>
                      </button>
                    )
                  })}
                </ComposerPopover>
              ) : null}
            </div>

            {/* 斜杠命令 */}
            <div className="agent-popover-host">
              <button
                type="button"
                className={`agent-command-button${showSlash ? ' is-open' : ''}`}
                onClick={event => { event.stopPropagation(); closeAll(); setShowSlash(v => !v) }}
                title="命令"
              >
                <Slash size={15} />
              </button>
              {showSlash ? (
                <ComposerPopover title="命令" onClose={() => setShowSlash(false)}>
                  {visibleSlashCommands.map(item => (
                    <button
                      className="agent-popover-row agent-popover-row--command"
                      key={item.command}
                      type="button"
                      onClick={() => {
                        setValue(`${item.command} `)
                        setShowSlash(false)
                        textareaRef.current?.focus()
                      }}
                    >
                      <code>{item.command}</code>
                      <small>{item.description}</small>
                    </button>
                  ))}
                </ComposerPopover>
              ) : null}
            </div>

            <div className="agent-composer__divider" />

            {/* MCP 服务器 */}
            <div className="agent-popover-host">
              <button
                type="button"
                className={`agent-tool-button${showMcp ? ' is-open' : ''}`}
                onClick={event => { event.stopPropagation(); closeAll(); setShowMcp(v => !v) }}
                title="MCP 服务"
              >
                <MCP size={13} />
                <span>MCP</span>
                {connectedCount > 0 && (
                  <span className="agent-tool-badge">{connectedCount}</span>
                )}
              </button>
              {showMcp ? (
                <ComposerPopover title="MCP 服务" onClose={() => setShowMcp(false)}>
                  {mcpServers.length === 0 ? (
                    <p className="agent-popover-empty">暂无已配置的 MCP 服务器</p>
                  ) : mcpServers.map(server => {
                    const isBusy = busyServers.has(server.id)
                    const isOn = server.status === 'connected'
                    return (
                      <button
                        className="agent-popover-row agent-popover-row--toggle"
                        key={server.id}
                        type="button"
                        disabled={isBusy}
                        onClick={() => onToggleServer(server.name, server.status)}
                      >
                        <span className={`agent-server-status agent-server-status--${server.status}`} />
                        <span className="agent-popover-row__text">
                          <strong>{server.name}</strong>
                          <small>
                            {server.status === 'error' && server.error
                              ? server.error
                              : `${server.toolCount} 个工具`}
                          </small>
                        </span>
                        <span className={`agent-toggle${isOn ? ' is-on' : ''}${isBusy ? ' is-busy' : ''}`} />
                      </button>
                    )
                  })}
                </ComposerPopover>
              ) : null}
            </div>

            {/* Skills */}
            <div className="agent-popover-host">
              <button
                type="button"
                className={`agent-tool-button${showSkills ? ' is-open' : ''}`}
                onClick={event => { event.stopPropagation(); closeAll(); setShowSkills(v => !v) }}
                title="技能"
              >
                <Hammer size={13} />
                <span>Skills</span>
                {skillEnabledCount > 0 && (
                  <span className="agent-tool-badge">{skillEnabledCount}</span>
                )}
              </button>
              {showSkills ? (
                <ComposerPopover title="技能" onClose={() => setShowSkills(false)}>
                  {skills.length === 0
                    ? <p className="agent-popover-empty">暂无已导入的技能</p>
                    : skills.map(skill => {
                        const isEnabled = enabledSkills.has(skill.id)
                        return (
                          <button
                            className="agent-popover-row agent-popover-row--toggle"
                            key={skill.id}
                            type="button"
                            onClick={() => toggleSkill(skill.id)}
                          >
                            <span className="agent-popover-row__icon"><Hammer size={14} /></span>
                            <span className="agent-popover-row__text">
                              <strong>{skill.name}</strong>
                              <small>{skill.description}</small>
                            </span>
                            {skill.builtin && <span className="agent-skill-tag">内置</span>}
                            <span className={`agent-toggle${isEnabled ? ' is-on' : ''}`} />
                          </button>
                        )
                      })
                  }
                </ComposerPopover>
              ) : null}
            </div>

            {/* 上下文设置 */}
            <div className="agent-popover-host">
              <button
                type="button"
                className={`agent-tool-button${showContext ? ' is-open' : ''}`}
                onClick={event => { event.stopPropagation(); closeAll(); setShowContext(v => !v) }}
                title="上下文设置"
              >
                <SlidersHorizontal size={13} />
              </button>
              {showContext ? (
                <ComposerPopover title="上下文设置" onClose={() => setShowContext(false)}>
                  <div className="agent-ctx-row">
                    <label>
                      创意程度
                      <span className="agent-ctx-value">{temperature.toFixed(1)}</span>
                    </label>
                    <input
                      className="agent-ctx-slider"
                      type="range"
                      min={0}
                      max={1}
                      step={0.1}
                      value={temperature}
                      onChange={e => setTemperature(Number(e.target.value))}
                    />
                    <div className="agent-ctx-slider-labels">
                      <span>精确</span>
                      <span>创意</span>
                    </div>
                  </div>
                  <div className="agent-ctx-row">
                    <label>上下文长度</label>
                    <div className="agent-ctx-chips">
                      {(['2k', '8k', '32k'] as ContextLength[]).map(len => (
                        <button
                          key={len}
                          type="button"
                          className={`agent-ctx-chip${contextLength === len ? ' is-active' : ''}`}
                          onClick={() => setContextLength(len)}
                        >
                          {len.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="agent-ctx-row">
                    <label>读取条数上限</label>
                    <div className="agent-ctx-chips">
                      {READ_LIMIT_OPTIONS.map(n => (
                        <button
                          key={n}
                          type="button"
                          className={`agent-ctx-chip${readLimit === n ? ' is-active' : ''}`}
                          onClick={() => { setReadLimit(n); void saveReadLimit(n) }}
                        >
                          {n}
                        </button>
                      ))}
                    </div>
                  </div>
                </ComposerPopover>
              ) : null}
            </div>
          </div>

          <div className="agent-composer__right">
            <button className="agent-round-button" type="button" title="语音输入" disabled={disabled}>
              <Mic size={14} />
            </button>
            <button
              className={`agent-send-button${value.trim() ? ' is-ready' : ''}`}
              type="button"
              onClick={submit}
              disabled={!value.trim() || disabled}
              title="发送"
            >
              <Send size={15} />
            </button>
          </div>
        </div>
      </div>

      <div className="agent-composer-hint">
        <span><kbd>Enter</kbd> 发送</span>
        <span><kbd>Shift</kbd> + <kbd>Enter</kbd> 换行</span>
        <span><kbd>@</kbd> 引用</span>
        <span><kbd>/</kbd> 命令</span>
        <span>AI生成，请注意甄别！</span>
      </div>
    </footer>
  )
}

function ComposerPopover({
  title,
  children,
  onClose,
  onScrollNearBottom,
}: {
  title: string
  children: ReactNode
  onClose: () => void
  onScrollNearBottom?: () => void
}) {
  const listRef = useRef<HTMLDivElement>(null)

  const handleScroll = () => {
    const el = listRef.current
    if (!el || !onScrollNearBottom) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 60) {
      onScrollNearBottom()
    }
  }

  return (
    <div className="agent-popover" onClick={event => event.stopPropagation()}>
      <div className="agent-popover__title">
        <span>{title}</span>
        <button type="button" onClick={onClose} title="关闭">
          <X size={12} />
        </button>
      </div>
      <div className="agent-popover__list" ref={listRef} onScroll={handleScroll}>{children}</div>
    </div>
  )
}

function SessionAvatar({ name, avatarUrl }: { name: string; avatarUrl?: string }) {
  const initial = (name || '?')[0].toUpperCase()
  const hue = [...(name || '')].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360

  if (avatarUrl) {
    return (
      <img
        className="agent-session-avatar"
        src={avatarUrl}
        alt={name}
        onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none' }}
      />
    )
  }
  return (
    <span
      className="agent-session-avatar agent-session-avatar--fallback"
      style={{ background: `hsl(${hue} 55% 48%)` }}
    >
      {initial}
    </span>
  )
}
