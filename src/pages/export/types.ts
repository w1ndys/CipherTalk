import type { LucideIcon } from 'lucide-react'

export type ExportTab = 'chat' | 'contacts' | 'moments'

// 会话类型筛选
export type SessionTypeFilter = 'all' | 'group' | 'private'

export interface ChatSession {
  username: string
  displayName?: string
  avatarUrl?: string
  summary: string
  lastTimestamp: number
}

export interface Contact {
  username: string
  displayName: string
  remark?: string
  nickname?: string
  avatarUrl?: string
  type: 'friend' | 'group' | 'official' | 'other'
}

export interface ExportOptions {
  format: 'chatlab' | 'chatlab-jsonl' | 'json' | 'html' | 'txt' | 'excel' | 'sql'
  startDate: string
  endDate: string
  exportAvatars: boolean
  exportImages: boolean
  exportVideos: boolean
  exportEmojis: boolean
  exportVoices: boolean
}

export interface ContactExportOptions {
  format: 'json' | 'csv' | 'vcf'
  exportAvatars: boolean
  contactTypes: {
    friends: boolean
    groups: boolean
    officials: boolean
  }
  selectedUsernames?: string[]
}

export interface MomentsExportOptions {
  format: 'json' | 'html' | 'excel'
  startDate: string
  endDate: string
}

export interface MomentPost {
  id: string
  username: string
  nickname: string
  avatarUrl?: string
  createTime: number
  contentDesc: string
  media?: { url: string }[]
  likes?: string[]
  comments?: unknown[]
}

export interface ExportResult {
  success: boolean
  successCount?: number
  failCount?: number
  error?: string
}

export interface ExportProgress {
  current: number
  total: number
  currentName: string
  phase: string
  detail: string
}

// 格式选择卡片的配置项
export interface FormatOption {
  value: string
  label: string
  icon: LucideIcon
  desc: string
}
