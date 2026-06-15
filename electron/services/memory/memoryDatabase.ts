import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { basename, dirname, join } from 'path'
import { ConfigService } from '../config'
import {
  MEMORY_DB_NAME,
  MEMORY_SOURCE_TYPES,
  type MemoryDatabaseStats,
  type MemoryEvidenceRef,
  type MemoryItem,
  type MemoryItemInput,
  type MemoryItemRow,
  type MemorySourceType
} from './memorySchema'

export type MemoryKeywordSearchOptions = {
  query: string
  sessionId?: string
  sourceTypes?: MemorySourceType[]
  startTimeMs?: number
  endTimeMs?: number
  limit?: number
}

export type MemoryKeywordSearchHit = {
  item: MemoryItem
  rank: number
  score: number
  retrievalSource: 'memory_fts' | 'memory_like'
}

export type MemoryListOptions = {
  sourceType?: MemorySourceType
  sourceTypes?: MemorySourceType[]
  sessionId?: string
  tags?: string[]
  withoutTags?: string[]
  minConfidence?: number
  limit?: number
  offset?: number
}

export type MemoryMarkdownExportResult = {
  files: string[]
  itemCount: number
}

export type MemoryDiaryEntry = {
  date: string
  title: string
  excerpt: string
  content?: string
  updatedAt: number
}

export type MemoryMigrationStatus = {
  needed: boolean
  legacyDbPath: string
  memoryBankPath: string
  itemCount: number
  migratedItemCount: number
  error?: string
}

export type MemoryMigrationResult = MemoryMigrationStatus & {
  success: boolean
  deletedFiles: string[]
  deleteErrors?: string[]
  skippedItemCount?: number
}

type MemoryItemIndex = {
  byUid: Map<string, MemoryItem>
  fileById: Map<number, string>
  maxId: number
  itemCount: number
}

const MEMORY_BANK_DIR = 'memory-bank'
const META_FILE = 'META.md'
const ITEMS_DIR = 'items'
const SELF_REFERENCE_DIR = 'ct-self-reference'
const LEGACY_SELF_REFERENCE_DIR = `${'co'}${'la'}-self-reference`
export const AI_USER_PROFILE_UID = 'profile:ai-user-profile'
export const ONBOARDING_PROFILE_UIDS = [
  'profile:user-name',
  'profile:energy-focus',
  'profile:coping-pattern',
  'profile:interaction-preference'
]
const ONBOARDING_PROFILE_UID_SET = new Set(ONBOARDING_PROFILE_UIDS)
// 仅迁移新版 Markdown 记忆系统实际使用的「策展型」记忆类型；旧版 message/conversation_block/
// timeline_summary/media 是为已移除的向量检索逐条消息建的索引，新系统用不到，迁过来只会砸出
// 上万个 .md 文件并拖垮 listMemoryItems/syncDerivedMarkdown，故按 source_type 过滤掉。
const MIGRATABLE_SOURCE_TYPES: MemorySourceType[] = ['fact', 'relationship', 'profile']
const MIGRATABLE_SOURCE_TYPES_SQL = MIGRATABLE_SOURCE_TYPES.map((type) => `'${type}'`).join(', ')

export type MarkdownMemoryRetrievalMode = 'fact' | 'recent' | 'topic'

export type MarkdownMemoryRetrieval = {
  mode: MarkdownMemoryRetrievalMode
  context: string
  itemIds: number[]
  sourceFiles: string[]
}

function nowMs(): number {
  return Date.now()
}

function getCacheBasePath(): string {
  const configService = new ConfigService()
  try {
    return configService.getCacheBasePath()
  } finally {
    configService.close()
  }
}

function normalizeNullableText(value?: string | null): string | null {
  const text = String(value || '').trim()
  return text || null
}

function normalizeNumber(value: unknown, fallback: number): number {
  const numberValue = Number(value)
  return Number.isFinite(numberValue) ? numberValue : fallback
}

function clamp01(value: unknown, fallback: number): number {
  const numberValue = normalizeNumber(value, fallback)
  return Math.max(0, Math.min(1, numberValue))
}

function safeJsonParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return safeJsonParse<string[]>(value, [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  }
  return []
}

function parseEvidenceRefs(value: unknown): MemoryEvidenceRef[] {
  const parsed = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? safeJsonParse<unknown[]>(value, [])
      : []
  return parsed
    .map((item): MemoryEvidenceRef | null => {
      if (!item || typeof item !== 'object') return null
      const source = item as Record<string, unknown>
      const sessionId = String(source.sessionId || '').trim()
      const localId = Number(source.localId)
      const createTime = Number(source.createTime)
      const sortSeq = Number(source.sortSeq)
      if (!sessionId || !Number.isFinite(localId) || !Number.isFinite(createTime) || !Number.isFinite(sortSeq)) return null
      const senderUsername = String(source.senderUsername || '').trim()
      const excerpt = String(source.excerpt || '').trim()
      return {
        sessionId,
        localId,
        createTime,
        sortSeq,
        ...(senderUsername ? { senderUsername } : {}),
        ...(excerpt ? { excerpt } : {})
      }
    })
    .filter((item): item is MemoryEvidenceRef => Boolean(item))
}

function safeSourceType(value: unknown): MemorySourceType {
  return MEMORY_SOURCE_TYPES.includes(value as MemorySourceType)
    ? value as MemorySourceType
    : 'fact'
}

function safeFileSegment(value: string): string {
  const text = String(value || 'memory').trim() || 'memory'
  return text.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'memory'
}

function markdownEscape(value: string): string {
  return String(value || '').replace(/\r\n/g, '\n').trim()
}

function inlineMarkdown(value: string): string {
  return markdownEscape(value).replace(/\s+/g, ' ').trim()
}

function stripSentenceEnd(value: string): string {
  return inlineMarkdown(value).replace(/[。！？.!?]+$/g, '').trim()
}

function extractMemoryValue(content: string, prefix: string, quotedPattern?: RegExp): string {
  const text = stripSentenceEnd(content)
  const quoted = quotedPattern?.exec(text)
  if (quoted?.[1]) return inlineMarkdown(quoted[1])
  if (text.startsWith(prefix)) return stripSentenceEnd(text.slice(prefix.length))
  return text
}

function tableCell(value: string): string {
  return inlineMarkdown(value).replace(/\|/g, '\\|')
}

function diaryTitle(content: string, date: string): string {
  const heading = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('# '))
  return heading ? heading.replace(/^#\s+/, '').trim() || `${date} 日记` : `${date} 日记`
}

function diaryExcerpt(content: string): string {
  return content
    .replace(/\n## 记忆线索[\s\S]*$/u, '')
    .replace(/^# .+$/gm, '')
    .replace(/^## .+$/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260)
}

function normalizeUserProfileMarkdown(value: string): string {
  const text = markdownEscape(value)
    .replace(/\n## 事实表[\s\S]*$/u, '')
    .replace(/\n## 其他画像线索[\s\S]*$/u, '')
    .replace(/\n## 当前状态[\s\S]*$/u, '')
    .trim()
  if (!text) return ''
  return text.startsWith('# ') ? text : `# 用户档案\n\n${text}`
}

function formatDateTime(ms = nowMs()): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatDate(ms = nowMs()): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function normalizeDiarySummaryHour(value: unknown): number {
  const hour = Math.floor(Number(value))
  return Number.isFinite(hour) ? Math.max(0, Math.min(23, hour)) : 2
}

function frontMatterValue(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function parseFrontMatter(content: string): { meta: Record<string, unknown>; body: string } {
  const normalized = content.replace(/\r\n/g, '\n')
  if (!normalized.startsWith('---\n')) return { meta: {}, body: normalized }
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return { meta: {}, body: normalized }
  const raw = normalized.slice(4, end)
  const meta: Record<string, unknown> = {}
  for (const line of raw.split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    const rawValue = line.slice(idx + 1).trim()
    meta[key] = safeJsonParse(rawValue, rawValue)
  }
  return { meta, body: normalized.slice(end + 5).trim() }
}

function extractBodyText(body: string): string {
  return body
    .replace(/^# .+$/m, '')
    .replace(/^## 内容\s*/m, '')
    .trim()
}

function memoryAbout(item: MemoryItem): string {
  return item.sessionId || item.contactId || item.groupId || 'global'
}

export function hashMemoryContent(title: string, content: string): string {
  return createHash('sha256')
    .update(`${String(title || '').trim()}\n${String(content || '')}`)
    .digest('hex')
}

function normalizeSearchText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '')
    .replace(/[，。！？；：、“”‘’（）()[\]{}<>《》|\\/+=*_~`#$%^&-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitQuery(query: string): string[] {
  const normalized = normalizeSearchText(query)
  if (!normalized) return []
  const parts = normalized.split(/\s+/).filter((part) => part.length >= 2)
  return parts.length > 0 ? parts : [normalized]
}

function classifyQuery(query: string): MarkdownMemoryRetrievalMode {
  const text = String(query || '')
  const factKeywords = ['名字', '叫什么', '喜欢', '讨厌', '答应', '承诺', '偏好', '习惯', '我是谁', '了解我', '认识我']
  const recentKeywords = ['今天', '昨天', '刚才', '刚刚', '最近', '上次', '前几天']
  if (factKeywords.some((keyword) => text.includes(keyword))) return 'fact'
  if (recentKeywords.some((keyword) => text.includes(keyword))) return 'recent'
  return 'topic'
}

function toTimestampSeconds(value?: number): number | null {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null
  const numberValue = Number(value)
  return numberValue > 10_000_000_000 ? Math.floor(numberValue / 1000) : Math.floor(numberValue)
}

function rowToInput(row: MemoryItemRow): MemoryItemInput {
  return {
    memoryUid: row.memory_uid,
    sourceType: safeSourceType(row.source_type),
    sessionId: row.session_id,
    contactId: row.contact_id,
    groupId: row.group_id,
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    entities: parseStringArray(row.entities_json),
    tags: parseStringArray(row.tags_json),
    importance: Number(row.importance || 0),
    confidence: Number(row.confidence || 0),
    timeStart: row.time_start,
    timeEnd: row.time_end,
    sourceRefs: parseEvidenceRefs(row.source_refs_json)
  }
}

export class MemoryDatabase {
  private rootPath: string | null = null

  getDbPath(): string {
    return join(getCacheBasePath(), MEMORY_DB_NAME)
  }

  getMemoryBankPath(): string {
    return join(getCacheBasePath(), MEMORY_BANK_DIR)
  }

  ensureReady(): void {
    this.ensureBank()
  }

  close(): void {
    this.rootPath = null
  }

  private ensureBank(): string {
    const root = this.getMemoryBankPath()
    if (this.rootPath === root && existsSync(root)) return root
    this.migrateLegacySelfReferenceDir(root)
    mkdirSync(join(root, ITEMS_DIR), { recursive: true })
    mkdirSync(join(root, SELF_REFERENCE_DIR, 'diaries'), { recursive: true })
    mkdirSync(join(root, 'conversations'), { recursive: true })
    mkdirSync(join(root, 'tasks'), { recursive: true })
    mkdirSync(join(root, 'notes'), { recursive: true })
    this.writeIfMissing(join(root, 'MEMORY.md'), [
      '# Memory Bank Index',
      '',
      '## Key Pointers',
      '- BOOKMARKS.md - 重要瞬间日志',
      '- ct-self-reference/user-profile.md - 用户档案',
      '- ct-self-reference/relationship.md - AI 与用户的关系',
      '- ct-self-reference/diaries/ - 每日日记',
      '- conversations/ - 对话日志',
      '- tasks/ - 任务笔记',
      '- notes/ - 知识笔记',
      '',
      '## Active Context',
      'CipherTalk 使用纯 Markdown 长期记忆。',
      ''
    ].join('\n'))
    this.writeIfMissing(join(root, 'BOOKMARKS.md'), '# Bookmarks\n\n')
    this.writeIfMissing(join(root, SELF_REFERENCE_DIR, 'user-profile.md'), [
      '# 用户档案',
      '',
      '## 基本信息',
      '- 名字：（待填写）',
      '- 首次对话：（日期）',
      '',
      '## 事实表',
      '| Key | Value | 置信度 | 来源 | 更新日期 |',
      '|-----|-------|--------|------|---------|',
      '',
      '## 性格画像',
      '',
      '## 当前状态',
      ''
    ].join('\n'))
    this.writeIfMissing(join(root, SELF_REFERENCE_DIR, 'relationship.md'), '# 关系\n\n')
    this.writeIfMissing(join(root, SELF_REFERENCE_DIR, 'soul.md'), '# CT Soul\n\n')
    this.writeIfMissing(join(root, META_FILE), [
      '# Memory Bank Meta',
      '',
      'lastId: 0',
      'migratedLegacyDb: false',
      ''
    ].join('\n'))
    this.rootPath = root
    this.pruneLegacyIndexFilesOnce()
    return root
  }

  /**
   * 一次性清理旧版被写坏的「逐条消息索引」文件：早期破损的迁移会把 message/conversation_block/
   * timeline_summary/media 也全量落成 .md，几万个文件会让之后每次 listMemoryItems readdir+解析卡死。
   * 按文件名（id-sourceType-uid.md）廉价判定，不解析文件内容；用 meta 标记保证只跑一次。
   */
  private pruneLegacyIndexFilesOnce(): void {
    const meta = this.readMeta()
    if (meta.prunedLegacyIndexFiles === 'true') return
    const removed = this.pruneNonMigratableItemFiles()
    this.writeMeta({ prunedLegacyIndexFiles: true, ...(removed > 0 ? { prunedLegacyIndexCount: removed } : {}) })
  }

  private pruneNonMigratableItemFiles(): number {
    const allowed = new Set<string>(MIGRATABLE_SOURCE_TYPES)
    const itemsDir = join(this.getMemoryBankPath(), ITEMS_DIR)
    let removed = 0
    for (const name of readdirSync(itemsDir)) {
      if (!name.endsWith('.md')) continue
      const sourceType = /^\d+-([^-]+)-/.exec(name)?.[1]
      if (!sourceType || allowed.has(sourceType)) continue
      try {
        unlinkSync(join(itemsDir, name))
        removed += 1
      } catch {
        // 单个文件删除失败不阻塞初始化
      }
    }
    return removed
  }

  private migrateLegacySelfReferenceDir(root: string): void {
    const legacyDir = join(root, LEGACY_SELF_REFERENCE_DIR)
    const nextDir = join(root, SELF_REFERENCE_DIR)
    if (!existsSync(legacyDir)) return
    mkdirSync(root, { recursive: true })
    try {
      if (!existsSync(nextDir)) {
        renameSync(legacyDir, nextDir)
      } else {
        cpSync(legacyDir, nextDir, { recursive: true, force: false, errorOnExist: false })
        rmSync(legacyDir, { recursive: true, force: true })
      }
    } catch {
      try {
        cpSync(legacyDir, nextDir, { recursive: true, force: false, errorOnExist: false })
        rmSync(legacyDir, { recursive: true, force: true })
      } catch {
        // 目录迁移失败不阻塞记忆系统初始化；后续写入只使用 ct-self-reference。
      }
    }
  }

  private writeIfMissing(filePath: string, content: string): void {
    if (existsSync(filePath)) return
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content, 'utf8')
  }

  private readMeta(): Record<string, string> {
    const root = this.ensureBank()
    const file = join(root, META_FILE)
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const meta: Record<string, string> = {}
    for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
      const idx = line.indexOf(':')
      if (idx < 0 || line.trim().startsWith('#')) continue
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
    }
    return meta
  }

  private writeMeta(patch: Record<string, unknown>): void {
    const next = { ...this.readMeta(), ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, String(value)])) }
    writeFileSync(join(this.ensureBank(), META_FILE), [
      '# Memory Bank Meta',
      '',
      ...Object.entries(next).map(([key, value]) => `${key}: ${value}`),
      ''
    ].join('\n'), 'utf8')
  }

  private nextId(): number {
    const meta = this.readMeta()
    const lastId = Math.max(0, Math.floor(Number(meta.lastId || 0)))
    const next = Math.max(lastId, ...this.listMemoryItems({ limit: 10000 }).map((item) => item.id), 0) + 1
    this.writeMeta({ lastId: next })
    return next
  }

  private itemFileName(item: Pick<MemoryItem, 'id' | 'memoryUid' | 'sourceType'>): string {
    return `${String(item.id).padStart(6, '0')}-${safeFileSegment(item.sourceType)}-${safeFileSegment(item.memoryUid)}.md`
  }

  private itemFilePath(item: Pick<MemoryItem, 'id' | 'memoryUid' | 'sourceType'>): string {
    return join(this.ensureBank(), ITEMS_DIR, this.itemFileName(item))
  }

  private itemFiles(): string[] {
    const itemsDir = join(this.ensureBank(), ITEMS_DIR)
    return readdirSync(itemsDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => join(itemsDir, name))
  }

  private countItemFiles(): number {
    return this.itemFiles().length
  }

  private readItemIndex(): MemoryItemIndex {
    const byUid = new Map<string, MemoryItem>()
    const fileById = new Map<number, string>()
    let maxId = 0
    let itemCount = 0
    for (const filePath of this.itemFiles()) {
      const item = this.parseItemFile(filePath)
      if (!item || item.id <= 0) continue
      itemCount += 1
      maxId = Math.max(maxId, item.id)
      byUid.set(item.memoryUid, item)
      fileById.set(item.id, filePath)
    }
    return { byUid, fileById, maxId, itemCount }
  }

  private parseItemFile(filePath: string): MemoryItem | null {
    try {
      const raw = readFileSync(filePath, 'utf8')
      const { meta, body } = parseFrontMatter(raw)
      const content = String(meta.content || extractBodyText(body) || '')
      const title = String(meta.title || content.slice(0, 40))
      const createdAt = Number(meta.createdAt || nowMs())
      const updatedAt = Number(meta.updatedAt || createdAt)
      const sourceType = safeSourceType(meta.sourceType)
      return {
        id: Number(meta.id || 0),
        memoryUid: String(meta.memoryUid || basename(filePath, '.md')),
        sourceType,
        sessionId: normalizeNullableText(meta.sessionId as string | null),
        contactId: normalizeNullableText(meta.contactId as string | null),
        groupId: normalizeNullableText(meta.groupId as string | null),
        title,
        content,
        contentHash: String(meta.contentHash || hashMemoryContent(title, content)),
        entities: parseStringArray(meta.entities),
        tags: parseStringArray(meta.tags),
        importance: normalizeNumber(meta.importance, 0),
        confidence: clamp01(meta.confidence, 1),
        timeStart: meta.timeStart == null ? null : Number(meta.timeStart),
        timeEnd: meta.timeEnd == null ? null : Number(meta.timeEnd),
        sourceRefs: parseEvidenceRefs(meta.sourceRefs),
        createdAt,
        updatedAt
      }
    } catch {
      return null
    }
  }

  private writeItemFile(item: MemoryItem, existingFilePath?: string | null): string {
    const filePath = this.itemFilePath(item)
    if (existingFilePath && existingFilePath !== filePath && existsSync(existingFilePath)) unlinkSync(existingFilePath)
    const meta: Record<string, unknown> = {
      id: item.id,
      memoryUid: item.memoryUid,
      sourceType: item.sourceType,
      sessionId: item.sessionId,
      contactId: item.contactId,
      groupId: item.groupId,
      title: item.title,
      content: item.content,
      contentHash: item.contentHash,
      entities: item.entities,
      tags: item.tags,
      importance: item.importance,
      confidence: item.confidence,
      timeStart: item.timeStart,
      timeEnd: item.timeEnd,
      sourceRefs: item.sourceRefs,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, [
      '---',
      ...Object.entries(meta).map(([key, value]) => `${key}: ${frontMatterValue(value)}`),
      '---',
      '',
      `# ${item.title || item.sourceType}`,
      '',
      '## 内容',
      item.content.trim(),
      ''
    ].join('\n'), 'utf8')
    return filePath
  }

  private writeItem(item: MemoryItem): void {
    const existing = this.findItemFileById(item.id)
    this.writeItemFile(item, existing)
    this.syncDerivedMarkdown()
  }

  private findItemFileById(id: number): string | null {
    const itemsDir = join(this.ensureBank(), ITEMS_DIR)
    const prefix = `${String(id).padStart(6, '0')}-`
    const found = readdirSync(itemsDir).find((name) => name.startsWith(prefix) && name.endsWith('.md'))
    return found ? join(itemsDir, found) : null
  }

  private findItemByUid(memoryUid: string): MemoryItem | null {
    return this.listMemoryItems({ limit: 10000 }).find((item) => item.memoryUid === memoryUid) || null
  }

  private syncDerivedMarkdown(): void {
    const root = this.ensureBank()
    const items = this.listMemoryItems({ limit: 10000 })
      .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence || b.updatedAt - a.updatedAt)
    const formatItem = (item: MemoryItem) => (
      `- [${item.id}] ${markdownEscape(item.content)} ` +
      `(type=${item.sourceType}, confidence=${item.confidence.toFixed(2)}, importance=${item.importance.toFixed(2)}, about=${memoryAbout(item)})`
    )
    writeFileSync(join(root, 'MEMORY.md'), [
      '# Memory Bank Index',
      '',
      '## Key Pointers',
      '- BOOKMARKS.md - 重要瞬间日志',
      '- ct-self-reference/user-profile.md - 用户档案',
      '- ct-self-reference/relationship.md - AI 与用户的关系',
      '- ct-self-reference/diaries/ - 每日日记',
      '- conversations/ - 对话日志',
      '- tasks/ - 任务笔记',
      '- notes/ - 知识笔记',
      '',
      '## Active Context',
      ...items.slice(0, 80).map(formatItem),
      ''
    ].join('\n'), 'utf8')

    const aiProfileItem = items.find((item) => item.memoryUid === AI_USER_PROFILE_UID)
    const aiProfileMarkdown = aiProfileItem ? normalizeUserProfileMarkdown(aiProfileItem.content) : ''
    const visibleItems = items.filter((item) => item.memoryUid !== AI_USER_PROFILE_UID)
    const profileItems = visibleItems
      .filter((item) => item.sourceType === 'profile' || item.sourceType === 'fact' || item.sourceType === 'relationship')
    const profileByUid = new Map(profileItems.map((item) => [item.memoryUid, item]))
    const nameItem = profileByUid.get('profile:user-name')
    const energyItem = profileByUid.get('profile:energy-focus')
    const copingItem = profileByUid.get('profile:coping-pattern')
    const interactionItem = profileByUid.get('profile:interaction-preference')
    const onboardingItems = [nameItem, energyItem, copingItem, interactionItem].filter((item): item is MemoryItem => Boolean(item))
    const firstProfileAt = onboardingItems.length
      ? Math.min(...onboardingItems.map((item) => item.createdAt))
      : null
    const name = nameItem
      ? extractMemoryValue(nameItem.content, '用户的名字是')
      : '（待填写）'
    const energy = energyItem
      ? extractMemoryValue(energyItem.content, '', /主要被「(.+)」占着/)
      : '（待填写）'
    const coping = copingItem
      ? extractMemoryValue(copingItem.content, '用户遇到计划被打乱、期待落空等脱轨时刻时，常见应对方式是：')
      : '（待填写）'
    const interaction = interactionItem
      ? extractMemoryValue(interactionItem.content, '用户希望与 AI 的互动感觉是：')
      : '（待填写）'
    const profileRows = profileItems
      .map((item) => `| ${item.sourceType}-${item.id} | ${tableCell(item.content)} | ${item.confidence.toFixed(2)} | ${tableCell(item.tags.join(',') || 'memory-bank')} | ${formatDate(item.updatedAt)} |`)
    const otherProfileClues = profileItems
      .filter((item) => !ONBOARDING_PROFILE_UID_SET.has(item.memoryUid))
      .slice(0, 20)
      .map(formatItem)
    const structuredProfile = aiProfileMarkdown
      ? aiProfileMarkdown.split('\n')
      : [
          '# 用户档案',
          '',
          '## 基本信息',
          `- 名字：${name}${nameItem ? '（首次记忆引导中主动告知）。' : '。'}`,
          `- 首次建档：${firstProfileAt ? formatDate(firstProfileAt) : '（日期）'}。`,
          '- 记忆来源：AI 助手首次记忆引导。',
          '',
          '## 日常状态',
          `- 精力去向：${energy}${energyItem ? '。' : ''}`,
          '',
          '## 性格与应对',
          `- 应对模式：${coping}${copingItem ? '。' : ''}`,
          '',
          '## 交互偏好',
          `- 偏好：${interaction}${interactionItem ? '。' : ''}`,
          ''
        ]
    writeFileSync(join(root, SELF_REFERENCE_DIR, 'user-profile.md'), [
      ...structuredProfile,
      '',
      '## 事实表',
      '| Key | Value | 置信度 | 来源 | 更新日期 |',
      '|-----|-------|--------|------|---------|',
      ...profileRows,
      '',
      '## 其他画像线索',
      ...(otherProfileClues.length ? otherProfileClues : ['暂无。']),
      '',
      '## 当前状态',
      ...visibleItems.slice(0, 20).map(formatItem),
      ''
    ].join('\n'), 'utf8')
  }

  upsertMemoryItem(input: MemoryItemInput): MemoryItem {
    const memoryUid = String(input.memoryUid || '').trim()
    const content = String(input.content || '').trim()
    const title = String(input.title || content.slice(0, 40))
    if (!memoryUid) throw new Error('memoryUid is required')
    if (!content) throw new Error('memory content is required')
    const sourceType = safeSourceType(input.sourceType)
    const existing = this.findItemByUid(memoryUid)
    const timestamp = nowMs()
    const item: MemoryItem = {
      id: existing?.id ?? this.nextId(),
      memoryUid,
      sourceType,
      sessionId: normalizeNullableText(input.sessionId),
      contactId: normalizeNullableText(input.contactId),
      groupId: normalizeNullableText(input.groupId),
      title,
      content,
      contentHash: input.contentHash || hashMemoryContent(title, content),
      entities: parseStringArray(input.entities),
      tags: parseStringArray(input.tags),
      importance: normalizeNumber(input.importance, 0),
      confidence: clamp01(input.confidence, 1),
      timeStart: input.timeStart ?? null,
      timeEnd: input.timeEnd ?? null,
      sourceRefs: parseEvidenceRefs(input.sourceRefs),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp
    }
    this.writeItem(item)
    return item
  }

  getMemoryItemById(id: number): MemoryItem | null {
    const filePath = this.findItemFileById(Number(id))
    return filePath ? this.parseItemFile(filePath) : null
  }

  getMemoryItemByUid(memoryUid: string): MemoryItem | null {
    return this.findItemByUid(memoryUid)
  }

  listMemoryItems(options: MemoryListOptions = {}): MemoryItem[] {
    const itemsDir = join(this.ensureBank(), ITEMS_DIR)
    const sourceTypes = options.sourceTypes?.length
      ? Array.from(new Set(options.sourceTypes.filter((type) => MEMORY_SOURCE_TYPES.includes(type))))
      : options.sourceType
        ? [options.sourceType]
        : []
    const tags = (options.tags || []).map((tag) => String(tag).trim()).filter(Boolean)
    const withoutTags = (options.withoutTags || []).map((tag) => String(tag).trim()).filter(Boolean)
    const minConfidence = options.minConfidence === undefined ? null : clamp01(options.minConfidence, 0)
    const limit = Math.max(1, Math.min(Math.floor(options.limit || 100), 10000))
    const offset = Math.max(0, Math.floor(options.offset || 0))
    return readdirSync(itemsDir)
      .filter((name) => name.endsWith('.md'))
      .map((name) => this.parseItemFile(join(itemsDir, name)))
      .filter((item): item is MemoryItem => Boolean(item && item.id > 0))
      .filter((item) => sourceTypes.length === 0 || sourceTypes.includes(item.sourceType))
      .filter((item) => !options.sessionId || item.sessionId === options.sessionId)
      .filter((item) => minConfidence == null || item.confidence >= minConfidence)
      .filter((item) => tags.every((tag) => item.tags.includes(tag)))
      .filter((item) => withoutTags.every((tag) => !item.tags.includes(tag)))
      .sort((a, b) => (b.timeEnd || b.timeStart || b.updatedAt) - (a.timeEnd || a.timeStart || a.updatedAt) || b.id - a.id)
      .slice(offset, offset + limit)
  }

  countMemoryItems(options: { sourceType?: MemorySourceType; sessionId?: string } = {}): number {
    return this.listMemoryItems({ ...options, limit: 10000 }).length
  }

  searchMemoryItemsByKeyword(options: MemoryKeywordSearchOptions): MemoryKeywordSearchHit[] {
    const query = String(options.query || '').trim()
    if (!query) return []
    const terms = splitQuery(query)
    const startTime = toTimestampSeconds(options.startTimeMs)
    const endTime = toTimestampSeconds(options.endTimeMs)
    const limit = Math.max(1, Math.min(Math.floor(options.limit || 80), 500))
    const items = this.listMemoryItems({
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.sourceTypes ? { sourceTypes: options.sourceTypes } : {}),
      limit: 10000
    })
      .filter((item) => {
        const time = item.timeEnd || item.timeStart || Math.floor(item.updatedAt / 1000)
        if (startTime && time < startTime) return false
        if (endTime && time > endTime) return false
        return true
      })
      .map((item) => {
        const haystack = normalizeSearchText([
          item.title,
          item.content,
          item.entities.join(' '),
          item.tags.join(' '),
          memoryAbout(item)
        ].join('\n'))
        const exact = haystack.includes(normalizeSearchText(query))
        const termHits = terms.filter((term) => haystack.includes(term)).length
        const score = (exact ? 800 : 0) + termHits * 120 + item.importance * 80 + item.confidence * 40
        return { item, score }
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
      .slice(0, limit)
    return items.map((hit, index) => ({
      item: hit.item,
      rank: index + 1,
      score: Number(hit.score.toFixed(4)),
      retrievalSource: 'memory_like'
    }))
  }

  readWakeupContext(scope?: { kind?: string; sessionId?: string }): string {
    const root = this.ensureBank()
    const files: Array<{ title: string; path: string }> = [
      { title: 'MEMORY.md', path: join(root, 'MEMORY.md') },
      { title: 'user-profile.md', path: join(root, SELF_REFERENCE_DIR, 'user-profile.md') },
      { title: 'relationship.md', path: join(root, SELF_REFERENCE_DIR, 'relationship.md') },
      { title: 'soul.md', path: join(root, SELF_REFERENCE_DIR, 'soul.md') },
    ]
    const parts: string[] = ['# 记忆唤醒']
    for (const file of files) {
      const content = this.readTextFile(file.path, 12_000)
      if (!content) continue
      parts.push(`\n## ${file.title}\n${content}`)
    }

    const diaries = this.listRecentFiles(join(root, SELF_REFERENCE_DIR, 'diaries'), 2)
    if (diaries.length > 0) {
      parts.push('\n## 最近日记')
      for (const file of diaries) {
        const content = this.readTextFile(file, 6000)
        if (content) parts.push(`\n### ${basename(file)}\n${content}`)
      }
    }

    const tasks = this.listRecentFiles(join(root, 'tasks'), 5)
    if (tasks.length > 0) {
      parts.push('\n## 任务笔记')
      for (const file of tasks) {
        const content = this.readTextFile(file, 3000)
        if (content) parts.push(`\n### ${basename(file)}\n${content}`)
      }
    }

    const scopedItems = this.listMemoryItems({
      sourceTypes: ['profile', 'fact', 'relationship'],
      minConfidence: 0.7,
      withoutTags: ['pending'],
      limit: 50,
    }).filter((item) => !scope?.sessionId || !item.sessionId || item.sessionId === scope.sessionId)
    if (scopedItems.length > 0) {
      parts.push('\n## 高置信结构化记忆')
      parts.push(...scopedItems.slice(0, 40).map((item) => (
        `- [id=${item.id} type=${item.sourceType} confidence=${item.confidence.toFixed(2)} about=${memoryAbout(item)}] ${item.content}`
      )))
    }

    return parts.join('\n').slice(0, 30_000)
  }

  retrieveMarkdownContext(query: string, opts: { sessionId?: string; limit?: number } = {}): MarkdownMemoryRetrieval {
    const mode = classifyQuery(query)
    if (mode === 'fact') return this.retrieveFactContext(opts)
    if (mode === 'recent') return this.retrieveRecentContext(opts.limit ?? 3)
    return this.retrieveTopicContext(query, opts.limit ?? 8)
  }

  private retrieveFactContext(opts: { sessionId?: string }): MarkdownMemoryRetrieval {
    const root = this.ensureBank()
    const sourceFiles = [
      join(root, SELF_REFERENCE_DIR, 'user-profile.md'),
      join(root, SELF_REFERENCE_DIR, 'relationship.md'),
      join(root, 'MEMORY.md')
    ]
    const context = sourceFiles
      .map((file) => {
        const content = this.readTextFile(file, 10_000)
        return content ? `## ${basename(file)}\n${content}` : ''
      })
      .filter(Boolean)
      .join('\n\n')
    const items = this.listMemoryItems({
      sourceTypes: ['profile', 'fact', 'relationship'],
      minConfidence: 0.5,
      limit: 80,
    }).filter((item) => !opts.sessionId || !item.sessionId || item.sessionId === opts.sessionId)
    return { mode: 'fact', context, itemIds: items.map((item) => item.id), sourceFiles }
  }

  private retrieveRecentContext(days: number): MarkdownMemoryRetrieval {
    const root = this.ensureBank()
    const files = this.listRecentFiles(join(root, 'conversations'), Math.max(1, Math.min(days, 7)))
    const context = files
      .map((file) => {
        const content = this.readTextFile(file, 10_000)
        return content ? `## ${basename(file)}\n${content}` : ''
      })
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 24_000)
    return { mode: 'recent', context, itemIds: [], sourceFiles: files }
  }

  private retrieveTopicContext(query: string, limit: number): MarkdownMemoryRetrieval {
    const root = this.ensureBank()
    const files = this.listRecentFiles(join(root, 'conversations'), 365)
    const terms = splitQuery(query)
    const snippets: Array<{ file: string; score: number; text: string }> = []
    for (const file of files) {
      const content = this.readTextFile(file, 80_000)
      if (!content) continue
      const normalized = normalizeSearchText(content)
      const exact = normalized.includes(normalizeSearchText(query))
      const termHits = terms.filter((term) => normalized.includes(term)).length
      if (!exact && termHits === 0) continue
      const firstTerm = terms.find((term) => normalized.includes(term))
      const rawIndex = firstTerm ? normalized.indexOf(firstTerm) : 0
      const start = Math.max(0, rawIndex - 500)
      const end = Math.min(content.length, rawIndex + 1200)
      snippets.push({
        file,
        score: (exact ? 1000 : 0) + termHits * 100,
        text: `[${basename(file)}]\n${content.slice(start, end).trim()}`
      })
    }
    const selected = snippets
      .sort((a, b) => b.score - a.score || basename(b.file).localeCompare(basename(a.file)))
      .slice(0, Math.max(1, Math.min(limit, 20)))
    return {
      mode: 'topic',
      context: selected.map((item) => item.text).join('\n\n---\n\n').slice(0, 20_000),
      itemIds: [],
      sourceFiles: selected.map((item) => item.file)
    }
  }

  private readTextFile(filePath: string, charLimit = 20_000): string {
    try {
      if (!existsSync(filePath)) return ''
      return readFileSync(filePath, 'utf8').slice(0, charLimit)
    } catch {
      return ''
    }
  }

  private listRecentFiles(dirPath: string, limit: number): string[] {
    try {
      if (!existsSync(dirPath)) return []
      return readdirSync(dirPath)
        .filter((name) => name.endsWith('.md') && !name.startsWith('_'))
        .sort((a, b) => b.localeCompare(a))
        .slice(0, Math.max(0, limit))
        .map((name) => join(dirPath, name))
    } catch {
      return []
    }
  }

  deleteMemoryItem(id: number): boolean {
    const filePath = this.findItemFileById(Number(id))
    if (!filePath) return false
    unlinkSync(filePath)
    this.syncDerivedMarkdown()
    return true
  }

  updateMemoryItem(id: number, input: {
    sourceType?: MemorySourceType
    title?: string
    content?: string
    importance?: number
    confidence?: number
    tags?: string[]
  }): MemoryItem | null {
    const existing = this.getMemoryItemById(id)
    if (!existing) return null
    const content = input.content !== undefined ? String(input.content).trim() : existing.content
    if (!content) throw new Error('memory content is required')
    const title = input.title !== undefined ? String(input.title) : existing.title
    const item: MemoryItem = {
      ...existing,
      sourceType: input.sourceType ? safeSourceType(input.sourceType) : existing.sourceType,
      title,
      content,
      contentHash: hashMemoryContent(title, content),
      tags: input.tags ?? existing.tags,
      importance: clamp01(input.importance, existing.importance),
      confidence: clamp01(input.confidence, existing.confidence),
      updatedAt: nowMs()
    }
    this.writeItem(item)
    return item
  }

  consolidate(capPerGroup = 50): { removed: number; semanticRemoved: number; groups: number; scanned: number } {
    const all = this.listMemoryItems({ limit: 10000 })
    const groups = new Map<string, MemoryItem[]>()
    for (const item of all) {
      const key = `${item.sessionId ?? ''}::${item.sourceType}`
      const bucket = groups.get(key)
      if (bucket) bucket.push(item)
      else groups.set(key, [item])
    }
    let removed = 0
    const seenHashes = new Set<string>()
    for (const item of all) {
      const key = `${item.sessionId ?? ''}::${item.sourceType}::${item.contentHash}`
      if (!seenHashes.has(key)) {
        seenHashes.add(key)
        continue
      }
      if (this.deleteMemoryItem(item.id)) removed += 1
    }
    for (const items of groups.values()) {
      const live = items.filter((item) => this.getMemoryItemById(item.id))
      if (live.length <= capPerGroup) continue
      const sorted = [...live].sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
      for (const victim of sorted.slice(capPerGroup)) {
        if (this.deleteMemoryItem(victim.id)) removed += 1
      }
    }
    this.syncDerivedMarkdown()
    return { removed, semanticRemoved: 0, groups: groups.size, scanned: all.length }
  }

  getVectorMeta(_modelId: string): Map<number, { contentHash: string; dim: number }> {
    return new Map()
  }

  upsertMemoryVector(_memoryId: number, _modelId: string, _dim: number, _contentHash: string, _embedding: Buffer): void {
    return
  }

  searchMemoryVectors(
    _queryVec?: number[],
    _modelId?: string,
    _opts: { sourceTypes?: MemorySourceType[]; sessionId?: string; limit?: number } = {}
  ): Array<{ item: MemoryItem; score: number }> {
    return []
  }

  getStats(): MemoryDatabaseStats {
    return { itemCount: this.countItemFiles() }
  }

  exportMarkdown(outputDir: string): MemoryMarkdownExportResult {
    const targetDir = String(outputDir || '').trim()
    if (!targetDir) throw new Error('outputDir is required')
    mkdirSync(targetDir, { recursive: true })
    const files: string[] = []
    const copyRecursive = (sourceDir: string, destDir: string) => {
      mkdirSync(destDir, { recursive: true })
      for (const name of readdirSync(sourceDir, { withFileTypes: true })) {
        const source = join(sourceDir, name.name)
        const dest = join(destDir, name.name)
        if (name.isDirectory()) {
          copyRecursive(source, dest)
        } else if (name.isFile() && name.name.endsWith('.md')) {
          copyFileSync(source, dest)
          files.push(dest)
        }
      }
    }
    copyRecursive(this.ensureBank(), targetDir)
    return { files, itemCount: this.getStats().itemCount }
  }

  appendBookmark(event: string, timestamp = nowMs()): void {
    const file = join(this.ensureBank(), 'BOOKMARKS.md')
    const line = `- ${formatDateTime(timestamp)} +08:00 ${event.trim()}\n`
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '# Bookmarks\n\n'
    writeFileSync(file, current.endsWith('\n') ? current + line : `${current}\n${line}`, 'utf8')
  }

  appendConversationTurn(userText: string, assistantText: string, topic?: string, timestamp = nowMs()): void {
    const date = formatDate(timestamp)
    const file = join(this.ensureBank(), 'conversations', `${date}.md`)
    this.writeIfMissing(file, `# ${date} 对话日志\n\n`)
    const time = formatDateTime(timestamp).slice(11)
    const safeTopic = (topic || userText.slice(0, 28) || '对话').replace(/\s+/g, ' ').trim()
    const block = [
      `## ${time} +08:00 - ${safeTopic}`,
      `**用户：** ${userText.trim()}`,
      `**AI：** ${assistantText.trim()}`,
      ''
    ].join('\n')
    const current = readFileSync(file, 'utf8')
    writeFileSync(file, current.endsWith('\n') ? current + block : `${current}\n${block}`, 'utf8')
  }

  getDailyConsolidationTarget(timestamp = nowMs(), summaryHour = 2): string | null {
    const hour = new Date(timestamp).getHours()
    if (hour < normalizeDiarySummaryHour(summaryHour)) return null
    const date = formatDate(timestamp)
    const meta = this.readMeta()
    return meta.lastConsolidatedDate === date ? null : date
  }

  readDailyConsolidationSource(date: string): { conversations: string; bookmarks: string } {
    const root = this.ensureBank()
    const conversations = this.readTextFile(join(root, 'conversations', `${date}.md`), 40_000)
    const bookmarks = this.readTextFile(join(root, 'BOOKMARKS.md'), 20_000)
      .split(/\r?\n/)
      .filter((line) => line.includes(date))
      .join('\n')
    return { conversations, bookmarks }
  }

  writeDiary(date: string, content: string): void {
    const root = this.ensureBank()
    const file = join(root, SELF_REFERENCE_DIR, 'diaries', `${date}.md`)
    const text = content.trim() || [
      `# ${date} 日记`,
      '',
      '## 今日摘要',
      '暂无可整理内容。',
      ''
    ].join('\n')
    writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8')
    this.writeMeta({ lastConsolidatedDate: date, lastConsolidatedAt: new Date().toISOString() })
    this.syncDerivedMarkdown()
  }

  listDiaries(limit = 100): MemoryDiaryEntry[] {
    const root = this.ensureBank()
    const diaryDir = join(root, SELF_REFERENCE_DIR, 'diaries')
    return readdirSync(diaryDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name))
      .map((entry) => {
        const date = basename(entry.name, '.md')
        const filePath = join(diaryDir, entry.name)
        const content = readFileSync(filePath, 'utf8')
        return {
          date,
          title: diaryTitle(content, date),
          excerpt: diaryExcerpt(content),
          updatedAt: statSync(filePath).mtimeMs
        }
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, Math.max(1, Math.min(500, Math.floor(Number(limit) || 100))))
  }

  readDiary(date: string): MemoryDiaryEntry | null {
    const safeDate = String(date || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) return null
    const filePath = join(this.ensureBank(), SELF_REFERENCE_DIR, 'diaries', `${safeDate}.md`)
    if (!existsSync(filePath)) return null
    const content = readFileSync(filePath, 'utf8')
    return {
      date: safeDate,
      title: diaryTitle(content, safeDate),
      excerpt: diaryExcerpt(content),
      content,
      updatedAt: statSync(filePath).mtimeMs
    }
  }

  deleteDiary(date: string): boolean {
    const safeDate = String(date || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) return false
    const filePath = join(this.ensureBank(), SELF_REFERENCE_DIR, 'diaries', `${safeDate}.md`)
    if (!existsSync(filePath)) return false
    unlinkSync(filePath)
    this.syncDerivedMarkdown()
    return true
  }

  getMigrationStatus(): MemoryMigrationStatus {
    const legacyDbPath = this.getDbPath()
    const memoryBankPath = this.getMemoryBankPath()
    const migratedItemCount = this.getStats().itemCount
    if (!existsSync(legacyDbPath)) {
      return { needed: false, legacyDbPath, memoryBankPath, itemCount: 0, migratedItemCount }
    }
    try {
      const db = new Database(legacyDbPath, { readonly: true, fileMustExist: true })
      try {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memory_items'").get()
        if (!row) return { needed: false, legacyDbPath, memoryBankPath, itemCount: 0, migratedItemCount }
        const countRow = db.prepare(`SELECT COUNT(*) AS count FROM memory_items WHERE source_type IN (${MIGRATABLE_SOURCE_TYPES_SQL})`).get() as { count: number } | undefined
        const itemCount = Number(countRow?.count || 0)
        const meta = this.readMeta()
        const migratedLegacyCount = Number(meta.migratedLegacyItemCount || 0)
        const migratedSameDb = !meta.migratedLegacyDbPath || meta.migratedLegacyDbPath === legacyDbPath
        const completedMigration = meta.migratedLegacyDb === 'true' && migratedSameDb && (
          migratedLegacyCount >= itemCount || (!migratedLegacyCount && migratedItemCount >= itemCount)
        )
        return { needed: itemCount > 0 && !completedMigration, legacyDbPath, memoryBankPath, itemCount, migratedItemCount }
      } finally {
        db.close()
      }
    } catch (e) {
      return { needed: false, legacyDbPath, memoryBankPath, itemCount: 0, migratedItemCount, error: e instanceof Error ? e.message : String(e) }
    }
  }

  migrateLegacyDatabase(): MemoryMigrationResult {
    const status = this.getMigrationStatus()
    const deletedFiles: string[] = []
    const deleteErrors: string[] = []
    let skippedItemCount = 0
    if (!status.needed) return { ...status, success: true, deletedFiles }

    const db = new Database(status.legacyDbPath, { readonly: true, fileMustExist: true })
    try {
      const rows = db.prepare(`SELECT * FROM memory_items WHERE source_type IN (${MIGRATABLE_SOURCE_TYPES_SQL}) ORDER BY created_at ASC, id ASC`).all() as MemoryItemRow[]
      const index = this.readItemIndex()
      const meta = this.readMeta()
      let lastId = Math.max(index.maxId, Math.floor(Number(meta.lastId || 0)))

      for (const row of rows) {
        const input = rowToInput(row)
        const memoryUid = String(input.memoryUid || '').trim()
        const content = String(input.content || '').trim()
        if (!memoryUid || !content) {
          skippedItemCount += 1
          continue
        }
        const existing = index.byUid.get(memoryUid)
        const id = existing?.id ?? ++lastId
        const title = String(input.title || content.slice(0, 40))
        const timestamp = nowMs()
        const item: MemoryItem = {
          id,
          memoryUid,
          sourceType: safeSourceType(input.sourceType),
          sessionId: normalizeNullableText(input.sessionId),
          contactId: normalizeNullableText(input.contactId),
          groupId: normalizeNullableText(input.groupId),
          title,
          content,
          contentHash: input.contentHash || hashMemoryContent(title, content),
          entities: parseStringArray(input.entities),
          tags: parseStringArray(input.tags),
          importance: normalizeNumber(input.importance, 0),
          confidence: clamp01(input.confidence, 1),
          timeStart: input.timeStart ?? null,
          timeEnd: input.timeEnd ?? null,
          sourceRefs: parseEvidenceRefs(input.sourceRefs),
          createdAt: Number(row.created_at || existing?.createdAt || timestamp),
          updatedAt: Number(row.updated_at || timestamp)
        }
        const filePath = this.writeItemFile(item, index.fileById.get(id))
        index.byUid.set(memoryUid, item)
        index.fileById.set(id, filePath)
      }

      this.syncDerivedMarkdown()
      this.writeMeta({
        lastId,
        migratedLegacyDb: true,
        migratedLegacyDbPath: status.legacyDbPath,
        migratedLegacyItemCount: status.itemCount,
        migratedAt: new Date().toISOString()
      })
      const skippedText = skippedItemCount > 0 ? `，跳过 ${skippedItemCount} 条无效记录` : ''
      this.appendBookmark(`从旧版 ${MEMORY_DB_NAME} 迁移 ${rows.length - skippedItemCount} 条长期记忆${skippedText}。`)
    } finally {
      db.close()
    }

    for (const file of [
      status.legacyDbPath,
      `${status.legacyDbPath}-wal`,
      `${status.legacyDbPath}-shm`,
      `${status.legacyDbPath}-journal`
    ]) {
      if (!existsSync(file)) continue
      try {
        rmSync(file, { force: true })
        deletedFiles.push(file)
      } catch (e) {
        deleteErrors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    const next = this.getMigrationStatus()
    return {
      ...next,
      success: true,
      needed: false,
      itemCount: status.itemCount,
      migratedItemCount: this.getStats().itemCount,
      deletedFiles,
      ...(deleteErrors.length > 0 ? { deleteErrors } : {}),
      ...(skippedItemCount > 0 ? { skippedItemCount } : {})
    }
  }
}

export const memoryDatabase = new MemoryDatabase()
