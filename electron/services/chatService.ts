import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import { fileURLToPath } from 'url'
import * as fzstd from 'fzstd'
import { ChatServiceState } from './chat/state'
import { getAppPath, getDocumentsPath, getExePath, isElectronPackaged } from './runtimePaths'
import { dbAdapter } from './dbAdapter'
import { getDbStoragePath } from './dbStoragePaths'
import { wcdbService } from './wcdbService'
import { imageDecryptService } from './imageDecryptService'
import { getMessageTableColumns } from './messageDbScanner'
import { buildMessageStatsWhere, quoteIdent, recordStatsError } from './statsSqlHelpers'
import type { StatsPartialError } from './statsConstants'
import {
  compareMessageCursorAsc,
  compareMessageCursorDesc,
  messageIdentityKey,
  type ChatSession,
  type ContactInfo,
  type Message,
  type ChatLabSourceMessage,
  type ChatRecordItem,
  type Contact,
} from './chat/types'
import {
  detectContactInfoType,
  emojiCache,
  emojiDownloading,
} from './chat/constants'
import {
  cleanAccountDirName,
  findAccountDir,
  shouldKeepSession,
} from './chat/accountUtils'
import {
  cleanString,
  cleanSystemMessage,
  coerceRowNumber,
  decodeBinaryContent,
  decodeHtmlEntities,
  decodeMaybeCompressed,
  decodeMessageContent,
  decodePackedInfo,
  extractXmlAttribute,
  extractXmlValue,
  getRowField,
  looksLikeBase64,
  looksLikeHex,
  looksLikeWxid,
  stripSenderPrefix,
} from './chat/rowDecoders'
import {
  getMessageTypeLabel,
  parseChatHistory,
  parseEmojiInfo,
  parseFileInfo,
  parseImageDatNameFromRow,
  parseImageInfo,
  parseMessageContent,
  parseQuoteMessage,
  parseType49,
  parseVideoDuration,
  parseVideoMd5,
  parseVoiceDuration,
  parseVoipMessage,
  processSummary,
  sanitizeQuotedContent,
} from './chat/contentParsers'
import { resolveWeComCorpName } from './chat/weComResolver'
import {
  findMessageDbs,
  findSessionTables,
  checkTableExists,
  resolveMyRowId,
  refreshMessageDbCache as refreshMessageDbCacheImpl,
} from './chat/tableResolver'
import {
  resolveRowIsSend,
  resolveMessageLocalType,
  isMessageVisibleForSession,
  normalizeMessagesForUi,
  updateSessionCursorFromPage,
  getMessagesViaNativeCursor,
  rowToMessage,
} from './chat/messageMapper'

export type {
  ChatSession,
  ContactInfo,
  Message,
  ChatLabSourceMessage,
  ChatRecordItem,
  Contact,
}

class ChatService extends EventEmitter {
  private state = new ChatServiceState()

  constructor() {
    super()
  }

  /**
   * 设置当前聚焦的会话 ID
   * 用于增量同步时只推送当前会话的消息
   */
  setCurrentSession(sessionId: string | null): void {
    this.state.currentSessionId = sessionId
  }

  /**
   * 启动屏预加载：DB 连接成功后在后台预热会话列表、联系人和前几个会话的消息。
   * startup.ts 通过 Promise.race 加 5s 超时调用此方法，保证不会无限阻塞启动屏。
   */
  async preloadData(): Promise<void> {
    const t0 = Date.now()
    try {
      const sessionsResult = await this.getSessions(0, 300)
      this.state.preloadCache.sessions = {
        success: sessionsResult.success,
        sessions: sessionsResult.sessions,
        hasMore: sessionsResult.hasMore
      }

      const contactsResult = await this.getContacts()
      this.state.preloadCache.contacts = contactsResult

      if (sessionsResult.success && sessionsResult.sessions?.length) {
        const topSessions = sessionsResult.sessions.slice(0, 5)
        await Promise.all(topSessions.map(async (session) => {
          const result = await this.getMessages(session.username, 0, 50)
          if (result.success) {
            this.state.preloadCache.messages.set(session.username, {
              success: result.success,
              messages: result.messages,
              hasMore: result.hasMore
            })
          }
        }))
      }

      this.state.preloadCache.builtAt = Date.now()
      console.log(`[ChatService] 预加载完成，耗时 ${Date.now() - t0}ms，会话 ${this.state.preloadCache.sessions?.sessions?.length ?? 0} 条，消息缓存 ${this.state.preloadCache.messages.size} 个会话`)
    } catch (e) {
      console.warn('[ChatService] 预加载失败:', e)
    }
  }

  /**
   * 获取解密后的数据库目录（仅用于表情包/文件路径解析等非数据库场景）
   */
  private getDecryptedDbDir(): string {
    const cachePath = this.state.configService.get('cachePath')
    if (cachePath) return cachePath

    if (process.env.VITE_DEV_SERVER_URL) {
      const documentsPath = getDocumentsPath()
      return path.join(documentsPath, 'CipherTalkData')
    }

    const exePath = getExePath()
    const installDir = path.dirname(exePath)

    const isOnCDrive = /^[cC]:/i.test(installDir) || installDir.startsWith('\\')

    if (isOnCDrive) {
      const documentsPath = getDocumentsPath()
      return path.join(documentsPath, 'CipherTalkData')
    }

    return path.join(installDir, 'CipherTalkData')
  }

  /**
   * 连接数据库。业务层仍调用 chatService.connect，但实际句柄由 wcdbService Worker 管理。
   */
  async connect(): Promise<{ success: boolean; error?: string }> {
    try {
      const wxid = String(this.state.configService.get('myWxid') || '').trim()
      const dbPath = String(this.state.configService.get('dbPath') || '').trim()
      const decryptKey = String(this.state.configService.get('decryptKey') || '').trim()

      if (!wxid || !dbPath || !decryptKey) {
        return { success: false, error: '数据库配置不完整' }
      }

      const opened = await wcdbService.open(dbPath, decryptKey, wxid)
      return opened ? { success: true } : { success: false, error: 'WCDB 打开失败' }
    } catch (e: any) {
      return { success: false, error: e?.message || String(e) }
    }
  }

  /**
   * 关闭数据库连接（no-op；真正的 close 由 wcdbService 接管）
   */
  close(): void {
    // 清理本地缓存（真正的句柄由 wcdbService 的 Worker 管理）
    this.state.sessionTableCache.clear()
    this.state.sessionTableCacheTime = 0
    this.state.knownMessageDbFiles.clear()
    this.state.myRowIdCache.clear()
    this.state.hasName2IdCache.clear()
    this.state.contactColumnsCache = null
    this.state.weComCorpNameCache.clear()
    this.state.hasOpenImWordingTable = null
    this.state.avatarBase64Cache.clear()
    this.state.preloadCache.sessions = null
    this.state.preloadCache.contacts = null
    this.state.preloadCache.messages.clear()
    this.state.preloadCache.builtAt = 0
  }

  /**
   * 关闭指定的数据库文件（no-op；wcdbService 统一管理）
   */
  closeDatabase(_fileName: string): void {
    // 不再持有本地 better-sqlite3 句柄。清掉相关缓存即可。
    this.state.sessionTableCache.clear()
    this.state.sessionTableCacheTime = 0
    this.state.knownMessageDbFiles.clear()
    this.state.avatarBase64Cache.clear()
    this.state.contactColumnsCache = null
    this.state.weComCorpNameCache.clear()
    this.state.hasOpenImWordingTable = null
  }

  /**
   * 由 startup.ts 调用：把 monitorBridge 的变更事件桥接成 chatService 自身的 EventEmitter
   * 暂时只做事件转发；不在这里做 query 或 push。
   */
  attachMonitor(bridge: { on: (evt: string, cb: (p: any) => void) => void }): void {
    bridge.on('change', (payload) => {
      if (payload?.table === 'Session' || payload?.table === 'Message' || payload?.table === 'Contact') {
        this.emit('dbChange', payload)
      }
    })
  }

  /**
   * 获取会话列表
   */
  async getSessions(offset?: number, limit?: number): Promise<{ success: boolean; sessions?: ChatSession[]; hasMore?: boolean; error?: string }> {
    try {
      // 消费预加载缓存（仅首页请求）
      const isFirstPage = !offset || offset === 0
      if (isFirstPage && this.state.preloadCache.builtAt > 0 &&
          Date.now() - this.state.preloadCache.builtAt < this.state.PRELOAD_CACHE_TTL &&
          this.state.preloadCache.sessions) {
        const cached = this.state.preloadCache.sessions
        this.state.preloadCache.sessions = null
        return cached
      }

      // 获取表列表
      const tables = await dbAdapter.all<{ name: string }>(
        'session',
        '',
        "SELECT name FROM sqlite_master WHERE type='table'"
      )
      const tableNames = tables.map(t => t.name)

      // 查找会话表
      let sessionTableName: string | null = null
      for (const name of ['SessionTable', 'Session', 'session']) {
        if (tableNames.includes(name)) {
          sessionTableName = name
          break
        }
      }

      if (!sessionTableName) {
        return { success: false, error: '未找到会话表' }
      }

      // 查询数据（支持分页）
      const safeOffset = Math.max(0, Math.floor(Number(offset) || 0))
      const safeLimit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 300)))
      const rows = await dbAdapter.all<any>(
        'session',
        '',
        `SELECT * FROM ${sessionTableName} ORDER BY sort_timestamp DESC LIMIT ? OFFSET ?`,
        [safeLimit + 1, safeOffset]
      )

      // 转换为 ChatSession
      const sessions: ChatSession[] = []
      for (const row of rows.slice(0, safeLimit)) {
        const username = row.username || row.user_name || row.userName || ''

        if (!shouldKeepSession(username)) continue

        const sortTs = row.sort_timestamp || row.sortTimestamp || 0
        const lastTs = row.last_timestamp || row.lastTimestamp || sortTs

        const isFoldGroup = username === '@placeholder_foldgroup'
        sessions.push({
          username,
          type: row.type || 0,
          unreadCount: row.unread_count || row.unreadCount || 0,
          summary: processSummary(row.summary || row.digest || '', row.last_msg_type || row.lastMsgType || 1),
          sortTimestamp: sortTs,
          lastTimestamp: lastTs,
          lastMsgType: row.last_msg_type || row.lastMsgType || 0,
          displayName: isFoldGroup ? '折叠的聊天' : username,
          isWeCom: !isFoldGroup && username.includes('@openim'),
          isFoldGroup: isFoldGroup || undefined
        })
      }

      // 获取联系人信息
      await this.enrichSessionsWithContacts(sessions)

      return { success: true, sessions, hasMore: rows.length > safeLimit }
    } catch (e) {
      console.error('ChatService: 获取会话列表失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 补充联系人信息
   */
  private async enrichSessionsWithContacts(sessions: ChatSession[]): Promise<void> {
    if (sessions.length === 0) return

    try {
      // 检查 contact 表是否存在
      const tables = await dbAdapter.all<any>(
        'contact',
        '',
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact'"
      )

      if (tables.length === 0) {
        return
      }

      // 使用缓存的列信息
      if (!this.state.contactColumnsCache) {
        const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
        const columnNames = columns.map((c: any) => c.name)

        const hasBigHeadUrl = columnNames.includes('big_head_url')
        const hasSmallHeadUrl = columnNames.includes('small_head_url')
        const hasExtraBuffer = columnNames.includes('extra_buffer')

        const selectCols = ['username', 'remark', 'nick_name', 'alias']
        if (hasBigHeadUrl) selectCols.push('big_head_url')
        if (hasSmallHeadUrl) selectCols.push('small_head_url')
        if (hasExtraBuffer) selectCols.push('extra_buffer')
        if (columnNames.includes('flag')) selectCols.push('flag')

        this.state.contactColumnsCache = { hasBigHeadUrl, hasSmallHeadUrl, hasExtraBuffer, selectCols }
      }

      const { hasBigHeadUrl, hasSmallHeadUrl, hasExtraBuffer, selectCols } = this.state.contactColumnsCache

      const usernames = Array.from(new Set(sessions.map(s => s.username).filter(Boolean)))
      if (usernames.length === 0) return

      const contacts: any[] = []
      for (let i = 0; i < usernames.length; i += 400) {
        const batch = usernames.slice(i, i + 400)
        const placeholders = batch.map(() => '?').join(',')
        const batchContacts = await dbAdapter.all<any>(
          'contact',
          '',
          `SELECT ${selectCols.join(', ')}
           FROM contact
           WHERE username IN (${placeholders})`,
          batch
        )
        contacts.push(...batchContacts)
      }
      const contactMap = new Map<string, any>(contacts.map((contact: any) => [contact.username, contact]))

      for (const session of sessions) {
        const contact = contactMap.get(session.username)
        if (!contact) continue
        session.displayName = contact.remark || contact.nick_name || contact.alias || session.username
        if (hasBigHeadUrl && contact.big_head_url) {
          session.avatarUrl = contact.big_head_url
        } else if (hasSmallHeadUrl && contact.small_head_url) {
          session.avatarUrl = contact.small_head_url
        }
        if (session.isWeCom && hasExtraBuffer && contact.extra_buffer) {
          session.weComCorp = await resolveWeComCorpName(this.state, 
            contact.extra_buffer,
            [contact.remark, contact.nick_name, contact.alias, session.username]
          )
        }
        // contact.flag 位标记：第 11 位 (0x800) = 置顶；第 28 位 (0x10000000) = 折叠的群聊
        const flag = Number(contact.flag) || 0
        if (flag & 0x800) session.isPinned = true
        if (flag & 0x10000000) session.isCollapsed = true
      }
    } catch (e) {
      console.error('ChatService: 获取联系人信息失败:', e)
    }
  }

  /**
   * 获取通讯录列表
   */
  async getContacts(): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
    try {
      // 消费预加载缓存
      if (this.state.preloadCache.builtAt > 0 &&
          Date.now() - this.state.preloadCache.builtAt < this.state.PRELOAD_CACHE_TTL &&
          this.state.preloadCache.contacts) {
        const cached = this.state.preloadCache.contacts
        this.state.preloadCache.contacts = null
        return cached
      }

      // 获取会话表的最后联系时间
      const lastContactTimeMap = new Map<string, number>()
      try {
        const tables = await dbAdapter.all<any>(
          'session',
          '',
          "SELECT name FROM sqlite_master WHERE type='table'"
        )
        const tableNames = tables.map((t: any) => t.name)

        let sessionTableName: string | null = null
        for (const name of ['SessionTable', 'Session', 'session']) {
          if (tableNames.includes(name)) {
            sessionTableName = name
            break
          }
        }

        if (sessionTableName) {
          const sessionRows = await dbAdapter.all<any>(
            'session',
            '',
            `SELECT username, user_name, userName, sort_timestamp, sortTimestamp FROM ${sessionTableName}`
          )

          for (const row of sessionRows) {
            const username = row.username || row.user_name || row.userName || ''
            const timestamp = row.sort_timestamp || row.sortTimestamp || 0
            if (username && timestamp) {
              lastContactTimeMap.set(username, timestamp)
            }
          }
        }
      } catch (e) {
        // 忽略错误，继续使用默认排序
      }

      // 获取表结构
      const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
      const columnNames = columns.map((c: any) => c.name)

      const hasBigHeadUrl = columnNames.includes('big_head_url')
      const hasSmallHeadUrl = columnNames.includes('small_head_url')
      const hasLocalType = columnNames.includes('local_type')
      const hasType = columnNames.includes('type')
      const hasExtraBuffer = columnNames.includes('extra_buffer')

      const selectCols = ['username', 'remark', 'nick_name', 'alias', 'quan_pin', 'flag']
      if (hasBigHeadUrl) selectCols.push('big_head_url')
      if (hasSmallHeadUrl) selectCols.push('small_head_url')
      if (hasLocalType) selectCols.push('local_type')
      if (hasType) selectCols.push('type')
      if (hasExtraBuffer) selectCols.push('extra_buffer')

      const rows = await dbAdapter.all<any>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact`
      )

      const contacts: ContactInfo[] = []

      for (const row of rows) {
        const username = row.username || ''
        if (!username) continue

        const type = detectContactInfoType(username, row)
        if (!type) continue

        const displayName = row.remark || row.nick_name || row.alias || username
        let avatarUrl: string | undefined
        if (hasBigHeadUrl && row.big_head_url) {
          avatarUrl = row.big_head_url
        } else if (hasSmallHeadUrl && row.small_head_url) {
          avatarUrl = row.small_head_url
        }

        const isWeCom = username.includes('@openim') && !username.includes('@kefu.openim')
        const weComCorp = (isWeCom && hasExtraBuffer && row.extra_buffer)
          ? await resolveWeComCorpName(this.state, row.extra_buffer, [row.remark, row.nick_name, row.alias, username])
          : undefined

        contacts.push({
          username,
          displayName,
          remark: row.remark || undefined,
          nickname: row.nick_name || undefined,
          avatarUrl,
          type,
          isWeCom: isWeCom || undefined,
          weComCorp,
          lastContactTime: lastContactTimeMap.get(username) || 0
        } as ContactInfo & { lastContactTime: number })
      }

      // 按最近联系时间排序（有联系记录的在前，时间越近越靠前）
      contacts.sort((a, b) => {
        const timeA = (a as any).lastContactTime || 0
        const timeB = (b as any).lastContactTime || 0
        if (timeA && timeB) {
          return timeB - timeA
        }
        if (timeA && !timeB) return -1
        if (!timeA && timeB) return 1
        return a.displayName.localeCompare(b.displayName, 'zh-CN')
      })

      return { success: true, contacts }
    } catch (e) {
      console.error('ChatService: 获取通讯录失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 刷新消息数据库缓存（解密后调用）
   */
  refreshMessageDbCache(): void {
    refreshMessageDbCacheImpl(this.state)
    // 尝试推送增量消息（fire-and-forget，避免把同步方法改成 async）
    void this.checkNewMessagesForCurrentSession()
  }

  /**
   * 获取消息列表（支持跨多个数据库合并，已优化）
   */
  async getMessages(
    sessionId: string,
    offset: number = 0,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    try {
      // 消费预加载缓存（仅首页且缓存中有该会话）
      if (!offset && this.state.preloadCache.builtAt > 0 &&
          Date.now() - this.state.preloadCache.builtAt < this.state.PRELOAD_CACHE_TTL &&
          this.state.preloadCache.messages.has(sessionId)) {
        const cached = this.state.preloadCache.messages.get(sessionId)!
        this.state.preloadCache.messages.delete(sessionId)
        return cached
      }

      const normalizedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 50)))

      if (Math.max(0, Math.floor(Number(offset) || 0)) === 0) {
        const nativeDirect = await wcdbService.getNativeMessages(sessionId, normalizedLimit + 1, 0)
        if (nativeDirect.success && nativeDirect.rows) {
          const normalized = normalizeMessagesForUi(
            nativeDirect.rows.map(row => rowToMessage(this.state, row)),
            sessionId,
            normalizedLimit
          )
          const page = normalized.messages
          updateSessionCursorFromPage(this.state, sessionId, page)
          return { success: true, messages: page, hasMore: normalized.hasExtra }
        }

        const nativeCursor = await getMessagesViaNativeCursor(this.state, sessionId, normalizedLimit)
        if (nativeCursor.success) {
          return nativeCursor
        }
      }

      // 获取当前用户的 wxid
      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      // 使用缓存查找会话对应的数据库和表
      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      // 从所有数据库收集消息
      let allMessages: Message[] = []
      const minFetchPerDb = Math.max(offset + limit + 1, 100)

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')

          // 获取当前用户的 rowid（使用缓存）
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          // 构造查询 SQL（与原 getPreparedStatement 语义一致）
          let sql: string
          let params: any[]
          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ? OFFSET ?`
            params = [myRowId, minFetchPerDb, 0]
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ? OFFSET ?`
            params = [minFetchPerDb, 0]
          } else {
            sql = `SELECT * FROM ${tableName} ORDER BY sort_seq DESC, create_time DESC, local_id DESC LIMIT ? OFFSET ?`
            params = [minFetchPerDb, 0]
          }

          const rows = await dbAdapter.all<any>('message', dbPath, sql, params)

          // 批量处理消息
          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const localType = resolveMessageLocalType(row, 1)
            const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)

            // 只在需要时解析表情包和引用消息
            let emojiCdnUrl: string | undefined
            let emojiMd5: string | undefined
            let emojiProductId: string | undefined
            let quotedContent: string | undefined
            let quotedSender: string | undefined
            let quotedImageMd5: string | undefined
            let quotedEmojiMd5: string | undefined
            let quotedEmojiCdnUrl: string | undefined
            let imageMd5: string | undefined
            let imageDatName: string | undefined
            let isLivePhoto: boolean | undefined
            let videoMd5: string | undefined
            let videoDuration: number | undefined
            let voiceDuration: number | undefined

            if (localType === 47 && content) {
              const emojiInfo = parseEmojiInfo(content)
              emojiCdnUrl = emojiInfo.cdnUrl
              emojiMd5 = emojiInfo.md5
              emojiProductId = emojiInfo.productId
            } else if (localType === 3 && content) {
              const imageInfo = parseImageInfo(content)
              imageMd5 = imageInfo.md5
              imageDatName = parseImageDatNameFromRow(row)
              isLivePhoto = imageInfo.isLivePhoto
            } else if (localType === 43 && content) {
              videoMd5 = parseVideoMd5(content)
              videoDuration = parseVideoDuration(content)
            } else if (localType === 34 && content) {
              voiceDuration = parseVoiceDuration(content)
            } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
              const quoteInfo = parseQuoteMessage(content)
              quotedContent = quoteInfo.content
              quotedSender = quoteInfo.sender
              quotedImageMd5 = quoteInfo.imageMd5
              quotedEmojiMd5 = quoteInfo.emojiMd5
              quotedEmojiCdnUrl = quoteInfo.emojiCdnUrl
            }

            let fileName: string | undefined
            let fileSize: number | undefined
            let fileExt: string | undefined
            let fileMd5: string | undefined
            if (localType === 49 && content) {
              const fileInfo = parseFileInfo(content)
              fileName = fileInfo.fileName
              fileSize = fileInfo.fileSize
              fileExt = fileInfo.fileExt
              fileMd5 = fileInfo.fileMd5
            }

            let chatRecordList: ChatRecordItem[] | undefined
            if (content) {
              const xmlType = extractXmlValue(content, 'type')
              if (xmlType === '19' || localType === 49) {
                chatRecordList = parseChatHistory(content)
              }
            }

            let transferPayerUsername: string | undefined
            let transferReceiverUsername: string | undefined
            if ((localType === 49 || localType === 8589934592049) && content) {
              const xmlType = extractXmlValue(content, 'type')
              if (xmlType === '2000') {
                transferPayerUsername = extractXmlValue(content, 'payer_username') || undefined
                transferReceiverUsername = extractXmlValue(content, 'receiver_username') || undefined
              }
            }

            const parsedContent = parseMessageContent(content, localType)

            allMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent,
              rawContent: content,
              emojiCdnUrl,
              emojiMd5,
              productId: emojiProductId,
              quotedContent,
              quotedSender,
              quotedImageMd5,
              quotedEmojiMd5,
              quotedEmojiCdnUrl,
              imageMd5,
              imageDatName,
              isLivePhoto,
              videoMd5,
              videoDuration,
              voiceDuration,
              fileName,
              fileSize,
              fileExt,
              fileMd5,
              chatRecordList,
              transferPayerUsername,
              transferReceiverUsername
            })
          }
        } catch (e: any) {
          // 检测数据库损坏错误
          if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
            console.error(`[ChatService] 数据库损坏: ${dbPath}`, e)
            // 刷新缓存，强制重新解密
            this.refreshMessageDbCache()
          } else {
            console.error('ChatService: 查询消息失败:', e)
          }
        }
      }

      // 按 sort_seq 降序排序（最新的在前）
      allMessages.sort(compareMessageCursorDesc)

      // 去重（同一条消息可能在多个数据库中）
      const seen = new Set<string>()
      allMessages = allMessages.filter(msg => {
        if (!isMessageVisibleForSession(sessionId, msg)) return false
        const key = messageIdentityKey(msg)
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      // 应用 offset 和 limit
      const hasMore = allMessages.length > offset + limit
      const messages = allMessages.slice(offset, offset + limit)

      // 反转使最新消息在最后（UI 显示顺序）
      messages.reverse()

      // 更新增量游标（仅在拉取最新一页时）
      if (offset === 0 && messages.length > 0) {
        const latestMsg = messages[messages.length - 1]
        const currentCursor = this.state.sessionCursor.get(sessionId) || 0
        if (latestMsg.sortSeq > currentCursor) {
          this.state.sessionCursor.set(sessionId, latestMsg.sortSeq)
        }
      }

      return { success: true, messages, hasMore }
    } catch (e) {
      console.error('ChatService: 获取消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取指定时间之后的新消息。
   * 优先走 WeFlow native cursor；cursor 不可用时回退到现有最新页查询。
   */
  async getNewMessages(
    sessionId: string,
    minTime: number,
    limit: number = 1000
  ): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    const normalizedMinTime = Number(minTime) > 1e12
      ? Math.floor(Number(minTime) / 1000)
      : Math.max(0, Math.floor(Number(minTime) || 0))
    const normalizedLimit = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 1000)))

    try {
      const nativeResult = await wcdbService.getNewMessages(sessionId, normalizedMinTime, normalizedLimit)
      if (nativeResult.success) {
        let messages = (nativeResult.rows || [])
          .map(row => rowToMessage(this.state, row))
          .filter(msg => isMessageVisibleForSession(sessionId, msg))
          .filter(msg => Number(msg.createTime || 0) >= normalizedMinTime)

        const seen = new Set<string>()
        messages = messages
          .sort(compareMessageCursorAsc)
          .filter(msg => {
            const key = messageIdentityKey(msg)
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })

        if (messages.length > 0) {
          const latestMsg = messages[messages.length - 1]
          const currentCursor = this.state.sessionCursor.get(sessionId) || 0
          if (latestMsg.sortSeq > currentCursor) {
            this.state.sessionCursor.set(sessionId, latestMsg.sortSeq)
          }
        }

        return { success: true, messages }
      }

      console.warn('[ChatService] native cursor getNewMessages 失败，回退到最新页查询:', nativeResult.error)
      const fallback = await this.getMessages(sessionId, 0, Math.min(normalizedLimit, 200))
      if (!fallback.success || !fallback.messages) {
        return { success: false, error: nativeResult.error || fallback.error || '获取新消息失败' }
      }
      return {
        success: true,
        messages: fallback.messages.filter(msg => Number(msg.createTime || 0) >= normalizedMinTime)
      }
    } catch (e) {
      console.error('ChatService: 获取新消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 摘要专用：按精确时间范围读取消息，并优先保留范围内最新消息。
   */
  async getMessagesByTimeRangeForSummary(
    sessionId: string,
    options: {
      startTime?: number
      endTime: number
      limit: number
    }
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    try {
      const normalizedLimit = Number.isFinite(options.limit) ? Math.max(1, Math.floor(options.limit)) : 50
      const startTime = Number.isFinite(options.startTime) && Number(options.startTime) > 0
        ? Math.floor(Number(options.startTime))
        : undefined
      const endTime = Number.isFinite(options.endTime) && Number(options.endTime) > 0
        ? Math.floor(Number(options.endTime))
        : Math.floor(Date.now() / 1000)

      if (startTime !== undefined && startTime > endTime) {
        return { success: true, messages: [], hasMore: false }
      }

      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''
      const dbTablePairs = await findSessionTables(this.state, sessionId)

      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      let allMessages: Message[] = []
      const fetchLimitPerDb = normalizedLimit + 1

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          const whereParts: string[] = []
          const params: Array<number> = []

          if (startTime !== undefined) {
            whereParts.push(hasName2IdTable ? 'm.create_time >= ?' : 'create_time >= ?')
            params.push(startTime)
          }

          whereParts.push(hasName2IdTable ? 'm.create_time <= ?' : 'create_time <= ?')
          params.push(endTime)

          const whereClause = `WHERE ${whereParts.join(' AND ')}`

          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ${whereClause}
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [myRowId, ...params, fetchLimitPerDb])
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ${whereClause}
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [...params, fetchLimitPerDb])
          } else {
            sql = `SELECT *
                   FROM ${tableName}
                   ${whereClause}
                   ORDER BY sort_seq DESC, create_time DESC, local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [...params, fetchLimitPerDb])
          }

          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const localType = resolveMessageLocalType(row, 1)
            const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)
            const parsedContent = parseMessageContent(content, localType)
            const xmlType = content ? extractXmlValue(content, 'type') : undefined
            const chatRecordList = content && (xmlType === '19' || localType === 49)
              ? parseChatHistory(content)
              : undefined

            allMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent: parsedContent || '',
              rawContent: content,
              chatRecordList
            })
          }
        } catch (e: any) {
          if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
            console.error(`[ChatService] 摘要查询遇到损坏数据库: ${dbPath}`, e)
            this.refreshMessageDbCache()
          } else {
            console.error('ChatService: 摘要时间范围查询失败:', e)
          }
        }
      }

      allMessages.sort(compareMessageCursorDesc)

      const seen = new Set<string>()
      const uniqueMessages = allMessages.filter((msg) => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      const hasMore = uniqueMessages.length > normalizedLimit
      const messages = uniqueMessages.slice(0, normalizedLimit)
      messages.reverse()

      return { success: true, messages, hasMore }
    } catch (e) {
      console.error('ChatService: 摘要时间范围查询失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 基于 sortSeq 游标，获取更早的消息（严格小于 cursorSortSeq）
   */
  async getMessagesBefore(
    sessionId: string,
    cursorSortSeq: number,
    limit: number = 50,
    cursorCreateTime?: number,
    cursorLocalId?: number
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    try {
      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      let allMessages: Message[] = []
      const fetchLimitPerDb = Math.max(limit + 1, 50)
      const effectiveCursorCreateTime = cursorCreateTime ?? Number.MAX_SAFE_INTEGER
      const effectiveCursorLocalId = cursorLocalId ?? Number.MAX_SAFE_INTEGER

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.sort_seq < ?
                     OR (m.sort_seq = ? AND m.create_time < ?)
                     OR (m.sort_seq = ? AND m.create_time = ? AND m.local_id < ?)
                   )
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              myRowId,
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.sort_seq < ?
                     OR (m.sort_seq = ? AND m.create_time < ?)
                     OR (m.sort_seq = ? AND m.create_time = ? AND m.local_id < ?)
                   )
                   ORDER BY m.sort_seq DESC, m.create_time DESC, m.local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else {
            sql = `SELECT * FROM ${tableName}
                   WHERE (
                     sort_seq < ?
                     OR (sort_seq = ? AND create_time < ?)
                     OR (sort_seq = ? AND create_time = ? AND local_id < ?)
                   )
                   ORDER BY sort_seq DESC, create_time DESC, local_id DESC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          }

          for (const row of rows) {
            allMessages.push(rowToMessage(this.state, row))
          }
        } catch (e: any) {
          if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
            console.error(`[ChatService] 数据库损坏: ${dbPath}`, e)
            this.refreshMessageDbCache()
          } else {
            console.error('ChatService: 查询更早消息失败:', e)
          }
        }
      }

      allMessages.sort(compareMessageCursorDesc)

      const seen = new Set<string>()
      allMessages = allMessages.filter(msg => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      const hasMore = allMessages.length > limit
      const messages = allMessages.slice(0, limit)
      messages.reverse()

      return { success: true, messages, hasMore }
    } catch (e) {
      console.error('ChatService: 获取更早消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 基于 sortSeq 游标，获取更新的消息（严格大于 cursorSortSeq）
   */
  async getMessagesAfter(
    sessionId: string,
    cursorSortSeq: number,
    limit: number = 50,
    cursorCreateTime?: number,
    cursorLocalId?: number
  ): Promise<{ success: boolean; messages?: Message[]; hasMore?: boolean; error?: string }> {
    try {
      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      let allMessages: Message[] = []
      const fetchLimitPerDb = Math.max(limit + 1, 50)
      const effectiveCursorCreateTime = cursorCreateTime ?? Number.MIN_SAFE_INTEGER
      const effectiveCursorLocalId = cursorLocalId ?? Number.MIN_SAFE_INTEGER

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.sort_seq > ?
                     OR (m.sort_seq = ? AND m.create_time > ?)
                     OR (m.sort_seq = ? AND m.create_time = ? AND m.local_id > ?)
                   )
                   ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              myRowId,
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE (
                     m.sort_seq > ?
                     OR (m.sort_seq = ? AND m.create_time > ?)
                     OR (m.sort_seq = ? AND m.create_time = ? AND m.local_id > ?)
                   )
                   ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          } else {
            sql = `SELECT * FROM ${tableName}
                   WHERE (
                     sort_seq > ?
                     OR (sort_seq = ? AND create_time > ?)
                     OR (sort_seq = ? AND create_time = ? AND local_id > ?)
                   )
                   ORDER BY sort_seq ASC, create_time ASC, local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [
              cursorSortSeq,
              cursorSortSeq,
              effectiveCursorCreateTime,
              cursorSortSeq,
              effectiveCursorCreateTime,
              effectiveCursorLocalId,
              fetchLimitPerDb
            ])
          }

          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const localType = resolveMessageLocalType(row, 1)
            const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)

            let emojiCdnUrl: string | undefined
            let emojiMd5: string | undefined
            let emojiProductId: string | undefined
            let quotedContent: string | undefined
            let quotedSender: string | undefined
            let quotedImageMd5: string | undefined
            let quotedEmojiMd5: string | undefined
            let quotedEmojiCdnUrl: string | undefined
            let imageMd5: string | undefined
            let imageDatName: string | undefined
            let isLivePhoto: boolean | undefined
            let videoMd5: string | undefined
            let videoDuration: number | undefined
            let voiceDuration: number | undefined

            if (localType === 47 && content) {
              const emojiInfo = parseEmojiInfo(content)
              emojiCdnUrl = emojiInfo.cdnUrl
              emojiMd5 = emojiInfo.md5
              emojiProductId = emojiInfo.productId
            } else if (localType === 3 && content) {
              const imageInfo = parseImageInfo(content)
              imageMd5 = imageInfo.md5
              imageDatName = parseImageDatNameFromRow(row)
              isLivePhoto = imageInfo.isLivePhoto
            } else if (localType === 43 && content) {
              videoMd5 = parseVideoMd5(content)
              videoDuration = parseVideoDuration(content)
            } else if (localType === 34 && content) {
              voiceDuration = parseVoiceDuration(content)
            } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
              const quoteInfo = parseQuoteMessage(content)
              quotedContent = quoteInfo.content
              quotedSender = quoteInfo.sender
              quotedImageMd5 = quoteInfo.imageMd5
              quotedEmojiMd5 = quoteInfo.emojiMd5
              quotedEmojiCdnUrl = quoteInfo.emojiCdnUrl
            }

            let fileName: string | undefined
            let fileSize: number | undefined
            let fileExt: string | undefined
            let fileMd5: string | undefined
            if (localType === 49 && content) {
              const fileInfo = parseFileInfo(content)
              fileName = fileInfo.fileName
              fileSize = fileInfo.fileSize
              fileExt = fileInfo.fileExt
              fileMd5 = fileInfo.fileMd5
            }

            let chatRecordList: ChatRecordItem[] | undefined
            if (content) {
              const xmlType = extractXmlValue(content, 'type')
              if (xmlType === '19' || localType === 49) {
                chatRecordList = parseChatHistory(content)
              }
            }

            let transferPayerUsername: string | undefined
            let transferReceiverUsername: string | undefined
            if ((localType === 49 || localType === 8589934592049) && content) {
              const xmlType = extractXmlValue(content, 'type')
              if (xmlType === '2000') {
                transferPayerUsername = extractXmlValue(content, 'payer_username') || undefined
                transferReceiverUsername = extractXmlValue(content, 'receiver_username') || undefined
              }
            }

            const parsedContent = parseMessageContent(content, localType)

            allMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent,
              rawContent: content,
              emojiCdnUrl,
              emojiMd5,
              productId: emojiProductId,
              quotedContent,
              quotedSender,
              quotedImageMd5,
              quotedEmojiMd5,
              quotedEmojiCdnUrl,
              imageMd5,
              imageDatName,
              isLivePhoto,
              videoMd5,
              videoDuration,
              voiceDuration,
              fileName,
              fileSize,
              fileExt,
              fileMd5,
              chatRecordList,
              transferPayerUsername,
              transferReceiverUsername
            })
          }
        } catch (e: any) {
          if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
            console.error(`[ChatService] 数据库损坏: ${dbPath}`, e)
            this.refreshMessageDbCache()
          } else {
            console.error('ChatService: 查询更新消息失败:', e)
          }
        }
      }

      allMessages.sort(compareMessageCursorAsc)

      const seen = new Set<string>()
      allMessages = allMessages.filter(msg => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      const hasMore = allMessages.length > limit
      const messages = allMessages.slice(0, limit)

      return { success: true, messages, hasMore }
    } catch (e) {
      console.error('ChatService: 获取更新消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * ChatLab Pull 轻量消息查询。
   * 只返回协议组装所需的最小字段，避免媒体路径解析和富结构展开。
   */
  async getMessagesForChatLab(
    sessionId: string,
    options?: {
      startTime?: number
      endTime?: number
      watermark?: number
      offset?: number
      limit?: number
    }
  ): Promise<{ success: boolean; messages?: ChatLabSourceMessage[]; hasMore?: boolean; error?: string }> {
    try {
      const normalizedOffset = Number.isFinite(options?.offset) ? Math.max(0, Math.floor(options?.offset || 0)) : 0
      const normalizedLimit = Number.isFinite(options?.limit) ? Math.max(1, Math.min(500, Math.floor(options?.limit || 100))) : 100
      const startTime = Number.isFinite(options?.startTime) && Number(options?.startTime) > 0
        ? Math.floor(Number(options?.startTime))
        : undefined
      const endTime = Number.isFinite(options?.endTime) && Number(options?.endTime) > 0
        ? Math.floor(Number(options?.endTime))
        : undefined
      const watermark = Number.isFinite(options?.watermark) && Number(options?.watermark) > 0
        ? Math.floor(Number(options?.watermark))
        : undefined
      const effectiveEndTime = endTime !== undefined && watermark !== undefined
        ? Math.min(endTime, watermark)
        : (endTime ?? watermark)

      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''
      const dbTablePairs = await findSessionTables(this.state, sessionId)

      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      const allMessages: ChatLabSourceMessage[] = []
      const fetchLimitPerDb = Math.max(normalizedOffset + normalizedLimit + 1, 100)

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          const whereParts: string[] = []
          const params: Array<number> = []

          if (startTime) {
            whereParts.push(hasName2IdTable ? 'm.create_time >= ?' : 'create_time >= ?')
            params.push(startTime)
          }
          if (effectiveEndTime) {
            whereParts.push(hasName2IdTable ? 'm.create_time <= ?' : 'create_time <= ?')
            params.push(effectiveEndTime)
          }

          const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''

          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ${whereClause}
                   ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [myRowId, ...params, fetchLimitPerDb])
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   ${whereClause}
                   ORDER BY m.sort_seq ASC, m.create_time ASC, m.local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [...params, fetchLimitPerDb])
          } else {
            sql = `SELECT *
                   FROM ${tableName}
                   ${whereClause}
                   ORDER BY sort_seq ASC, create_time ASC, local_id ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [...params, fetchLimitPerDb])
          }

          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const localType = resolveMessageLocalType(row, 1)
            const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)
            const parsedContent = parseMessageContent(content, localType)
            const xmlType = content ? extractXmlValue(content, 'type') : undefined
            const chatRecordList = content && (xmlType === '19' || localType === 49)
              ? parseChatHistory(content)
              : undefined

            allMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent: parsedContent || '',
              rawContent: content,
              chatRecordList
            })
          }
        } catch (e: any) {
          if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
            console.error(`[ChatService] ChatLab 查询遇到损坏数据库: ${dbPath}`, e)
            this.refreshMessageDbCache()
          } else {
            console.error('ChatService: ChatLab 轻量查询失败:', e)
          }
        }
      }

      allMessages.sort(compareMessageCursorAsc)

      const seen = new Set<string>()
      const uniqueMessages = allMessages.filter((msg) => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      const hasMore = uniqueMessages.length > normalizedOffset + normalizedLimit
      const messages = uniqueMessages.slice(normalizedOffset, normalizedOffset + normalizedLimit)

      return { success: true, messages, hasMore }
    } catch (e) {
      console.error('ChatService: ChatLab 轻量查询失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取会话的所有语音消息（用于批量转写）
   * 复用 getMessages 的查询逻辑，只查询语音消息类型
   */
  async getAllVoiceMessages(
    sessionId: string
  ): Promise<{ success: boolean; messages?: Message[]; error?: string }> {
    try {
      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      // 使用与 getMessages 相同的方法查找会话对应的表
      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      let allVoiceMessages: Message[] = []

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          // 查询所有语音消息 (localType = 34)
          // 检查表结构
          const columns = await dbAdapter.all<any>('message', dbPath, `PRAGMA table_info('${tableName}')`)
          const columnNames = columns.map((c: any) => c.name.toLowerCase())
          const hasTypeColumn = columnNames.includes('type')
          const hasLocalTypeColumn = columnNames.includes('local_type')

          // 构建 WHERE 条件
          let typeCondition = ''
          if (hasLocalTypeColumn && hasTypeColumn) {
            typeCondition = '(local_type = 34 OR type = 34)'
          } else if (hasLocalTypeColumn) {
            typeCondition = 'local_type = 34'
          } else if (hasTypeColumn) {
            typeCondition = 'type = 34'
          } else {
            console.warn(`[ChatService] 表 ${tableName} 没有 local_type 或 type 列，跳过`)
            continue
          }

          // 构建完整的 SQL 查询
          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE ${typeCondition}
                   ORDER BY m.sort_seq DESC`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [myRowId])
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE ${typeCondition}
                   ORDER BY m.sort_seq DESC`
            rows = await dbAdapter.all<any>('message', dbPath, sql)
          } else {
            sql = `SELECT * FROM ${tableName}
                   WHERE ${typeCondition}
                   ORDER BY sort_seq DESC`
            rows = await dbAdapter.all<any>('message', dbPath, sql)
          }

          // 处理查询结果
          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const localType = resolveMessageLocalType(row, 1)
            const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)
            const voiceDuration = parseVoiceDuration(content)

            allVoiceMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent: '',
              rawContent: content,
              voiceDuration
            })
          }
        } catch (e: any) {
          console.error(`[ChatService] 查询语音消息失败 (${dbPath}):`, e)
        }
      }

      // 按 sort_seq 降序排序
      allVoiceMessages.sort(compareMessageCursorDesc)

      // 去重
      const seen = new Set<string>()
      allVoiceMessages = allVoiceMessages.filter(msg => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      console.log(`[ChatService] 共找到 ${allVoiceMessages.length} 条语音消息（去重后）`)

      return { success: true, messages: allVoiceMessages }
    } catch (e) {
      console.error('[ChatService] 获取所有语音消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取会话的所有图片消息（用于批量解密）
   */
  async getAllImageMessages(
    sessionId: string
  ): Promise<{ success: boolean; images?: { imageMd5?: string; imageDatName?: string; createTime?: number }[]; error?: string }> {
    try {
      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      const images: { imageMd5?: string; imageDatName?: string; createTime?: number }[] = []

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const columns = await dbAdapter.all<any>('message', dbPath, `PRAGMA table_info('${tableName}')`)
          const columnNames = columns.map((c: any) => c.name.toLowerCase())
          const hasLocalTypeColumn = columnNames.includes('local_type')
          const hasTypeColumn = columnNames.includes('type')

          let typeCondition = ''
          if (hasLocalTypeColumn && hasTypeColumn) {
            typeCondition = '(local_type = 3 OR type = 3)'
          } else if (hasLocalTypeColumn) {
            typeCondition = 'local_type = 3'
          } else if (hasTypeColumn) {
            typeCondition = 'type = 3'
          } else {
            continue
          }

          const rows = await dbAdapter.all<any>(
            'message',
            dbPath,
            `SELECT * FROM ${tableName} WHERE ${typeCondition}`
          )

          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const imageInfo = parseImageInfo(content)
            const datName = parseImageDatNameFromRow(row)
            if (imageInfo.md5 || datName) {
              images.push({ imageMd5: imageInfo.md5, imageDatName: datName, createTime: row.create_time })
            }
          }
        } catch (e: any) {
          console.error(`[ChatService] 查询图片消息失败:`, e)
        }
      }

      // 去重
      const seen = new Set<string>()
      const unique = images.filter(img => {
        const key = img.imageMd5 || img.imageDatName || ''
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })

      console.log(`[ChatService] 共找到 ${unique.length} 条图片消息（去重后）`)
      return { success: true, images: unique }
    } catch (e) {
      console.error('[ChatService] 获取所有图片消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 根据日期获取消息（用于日期跳转）
   * @param sessionId 会话ID
   * @param targetTimestamp 目标日期的 Unix 时间戳（秒）
   * @param limit 返回消息数量
   * @returns 返回目标日期当天或之后最近的消息列表
   */
  async getMessagesByDate(
    sessionId: string,
    targetTimestamp: number,
    limit: number = 50
  ): Promise<{ success: boolean; messages?: Message[]; targetIndex?: number; error?: string }> {
    try {
      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: false, error: '未找到该会话的消息表' }
      }

      // 计算目标日期的开始时间戳（当天 00:00:00）
      const targetDate = new Date(targetTimestamp * 1000)
      targetDate.setHours(0, 0, 0, 0)
      const dayStartTimestamp = Math.floor(targetDate.getTime() / 1000)

      // 从所有数据库查找目标日期或之后的第一条消息
      let allMessages: Message[] = []

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
          const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

          // 查询目标日期或之后的消息，按时间升序获取
          let sql: string
          let rows: any[]

          if (hasName2IdTable && myRowId !== null) {
            sql = `SELECT m.*,
                   CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                   n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE m.create_time >= ?
                   ORDER BY m.create_time ASC, m.sort_seq ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [myRowId, dayStartTimestamp, limit * 2])
          } else if (hasName2IdTable) {
            sql = `SELECT m.*, n.user_name AS sender_username
                   FROM ${tableName} m
                   LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                   WHERE m.create_time >= ?
                   ORDER BY m.create_time ASC, m.sort_seq ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [dayStartTimestamp, limit * 2])
          } else {
            sql = `SELECT * FROM ${tableName}
                   WHERE create_time >= ?
                   ORDER BY create_time ASC, sort_seq ASC
                   LIMIT ?`
            rows = await dbAdapter.all<any>('message', dbPath, sql, [dayStartTimestamp, limit * 2])
          }

          // 处理消息
          for (const row of rows) {
            const content = decodeMessageContent(row.message_content, row.compress_content)
            const localType = resolveMessageLocalType(row, 1)
            const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)

            let emojiCdnUrl: string | undefined
            let emojiMd5: string | undefined
            let emojiProductId: string | undefined
            let quotedContent: string | undefined
            let quotedSender: string | undefined
            let quotedImageMd5: string | undefined
            let quotedEmojiMd5: string | undefined
            let quotedEmojiCdnUrl: string | undefined
            let imageMd5: string | undefined
            let imageDatName: string | undefined
            let isLivePhoto: boolean | undefined
            let videoMd5: string | undefined
            let videoDuration: number | undefined
            let voiceDuration: number | undefined

            if (localType === 47 && content) {
              const emojiInfo = parseEmojiInfo(content)
              emojiCdnUrl = emojiInfo.cdnUrl
              emojiMd5 = emojiInfo.md5
              emojiProductId = emojiInfo.productId
            } else if (localType === 3 && content) {
              const imageInfo = parseImageInfo(content)
              imageMd5 = imageInfo.md5
              imageDatName = parseImageDatNameFromRow(row)
              isLivePhoto = imageInfo.isLivePhoto
            } else if (localType === 43 && content) {
              videoMd5 = parseVideoMd5(content)
              videoDuration = parseVideoDuration(content)
            } else if (localType === 34 && content) {
              voiceDuration = parseVoiceDuration(content)
            } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
              const quoteInfo = parseQuoteMessage(content)
              quotedContent = quoteInfo.content
              quotedSender = quoteInfo.sender
              quotedImageMd5 = quoteInfo.imageMd5
              quotedEmojiMd5 = quoteInfo.emojiMd5
              quotedEmojiCdnUrl = quoteInfo.emojiCdnUrl
            }

            let fileName: string | undefined
            let fileSize: number | undefined
            let fileExt: string | undefined
            let fileMd5: string | undefined
            if (localType === 49 && content) {
              const fileInfo = parseFileInfo(content)
              fileName = fileInfo.fileName
              fileSize = fileInfo.fileSize
              fileExt = fileInfo.fileExt
              fileMd5 = fileInfo.fileMd5
            }

            let chatRecordList: ChatRecordItem[] | undefined
            if (content) {
              const xmlType = extractXmlValue(content, 'type')
              if (xmlType === '19' || localType === 49) {
                chatRecordList = parseChatHistory(content)
              }
            }

            let transferPayerUsername: string | undefined
            let transferReceiverUsername: string | undefined
            if ((localType === 49 || localType === 8589934592049) && content) {
              const xmlType = extractXmlValue(content, 'type')
              if (xmlType === '2000') {
                transferPayerUsername = extractXmlValue(content, 'payer_username') || undefined
                transferReceiverUsername = extractXmlValue(content, 'receiver_username') || undefined
              }
            }

            const parsedContent = parseMessageContent(content, localType)

            allMessages.push({
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent,
              rawContent: content,
              emojiCdnUrl,
              emojiMd5,
              productId: emojiProductId,
              quotedContent,
              quotedSender,
              quotedImageMd5,
              quotedEmojiMd5,
              quotedEmojiCdnUrl,
              imageMd5,
              imageDatName,
              isLivePhoto,
              videoMd5,
              videoDuration,
              voiceDuration,
              fileName,
              fileSize,
              fileExt,
              fileMd5,
              chatRecordList,
              transferPayerUsername,
              transferReceiverUsername
            })
          }
        } catch (e) {
          console.error('ChatService: 按日期查询消息失败:', e)
        }
      }

      // 按时间升序排序
      allMessages.sort((a, b) => a.createTime - b.createTime || a.sortSeq - b.sortSeq)

      // 去重
      const seen = new Set<string>()
      allMessages = allMessages.filter(msg => {
        const key = `${msg.serverId}-${msg.localId}-${msg.createTime}-${msg.sortSeq}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })

      // 取前 limit 条
      const messages = allMessages.slice(0, limit)

      if (messages.length === 0) {
        return { success: true, messages: [], targetIndex: -1 }
      }

      return { success: true, messages, targetIndex: 0 }
    } catch (e) {
      console.error('ChatService: 按日期获取消息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取指定月份中有消息的日期列表
   * @param sessionId 会话ID
   * @param year 年份
   * @param month 月份 (1-12)
   * @returns 有消息的日期字符串列表 (YYYY-MM-DD)
   */
  async getDatesWithMessages(
    sessionId: string,
    year: number,
    month: number
  ): Promise<{ success: boolean; dates?: string[]; error?: string }> {
    try {
      const dbTablePairs = await findSessionTables(this.state, sessionId)
      if (dbTablePairs.length === 0) {
        return { success: true, dates: [] }
      }

      // 计算该月的起止时间戳
      // 注意：month 参数是 1-12，但 Date 构造函数用 0-11
      const startDate = new Date(year, month - 1, 1, 0, 0, 0)
      const endDate = new Date(year, month, 0, 23, 59, 59, 999) // 下个月第0天即本月最后一天

      const startTimestamp = Math.floor(startDate.getTime() / 1000)
      const endTimestamp = Math.floor(endDate.getTime() / 1000)

      const datesSet = new Set<string>()

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          // 只查询 create_time 字段以优化性能
          const sql = `SELECT create_time FROM ${tableName}
                       WHERE create_time BETWEEN ? AND ?`

          const rows = await dbAdapter.all<{ create_time: number }>('message', dbPath, sql, [startTimestamp, endTimestamp])

          for (const row of rows) {
            const date = new Date(row.create_time * 1000)
            const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
            datesSet.add(dateStr)
          }
        } catch (e) {
          console.error(`ChatService: 查询表 ${tableName} 日期失败`, e)
        }
      }

      // 排序
      const sortedDates = Array.from(datesSet).sort()

      return { success: true, dates: sortedDates }
    } catch (e) {
      console.error('ChatService: 获取有消息的日期失败:', e)
      return { success: false, error: String(e) }
    }
  }


  async getContact(username: string): Promise<Contact | null> {
    try {
      const row = await dbAdapter.get<any>(
        'contact',
        '',
        'SELECT username, alias, remark, nick_name as nickName FROM contact WHERE username = ?',
        [username]
      )

      if (!row) return null

      return {
        username: row.username,
        alias: row.alias || '',
        remark: row.remark || '',
        nickName: row.nickName || ''
      }
    } catch {
      return null
    }
  }

  /**
   * 获取联系人头像和显示名称（用于群聊消息）
   */
  async getContactAvatar(username: string): Promise<{ avatarUrl?: string; displayName?: string; weComCorp?: string } | null> {
    if (!username) return null

    try {
      // 使用缓存的列信息
      if (!this.state.contactColumnsCache) {
        const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
        const columnNames = columns.map((c: any) => c.name)

        const hasBigHeadUrl = columnNames.includes('big_head_url')
        const hasSmallHeadUrl = columnNames.includes('small_head_url')
        const hasExtraBuffer = columnNames.includes('extra_buffer')

        const selectCols = ['username', 'remark', 'nick_name', 'alias']
        if (hasBigHeadUrl) selectCols.push('big_head_url')
        if (hasSmallHeadUrl) selectCols.push('small_head_url')
        if (hasExtraBuffer) selectCols.push('extra_buffer')
        if (columnNames.includes('flag')) selectCols.push('flag')

        this.state.contactColumnsCache = { hasBigHeadUrl, hasSmallHeadUrl, hasExtraBuffer, selectCols }
      }

      const { hasBigHeadUrl, hasSmallHeadUrl, hasExtraBuffer, selectCols } = this.state.contactColumnsCache

      const row = await dbAdapter.get<any>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
        [username]
      )

      if (!row) {
        const avatarUrl = await this.getAvatarFromHeadImageDb(username)
        return avatarUrl ? { avatarUrl, displayName: username } : null
      }

      const displayName = row.remark || row.nick_name || row.alias || username
      let avatarUrl = (hasBigHeadUrl && row.big_head_url)
        ? row.big_head_url
        : (hasSmallHeadUrl && row.small_head_url)
          ? row.small_head_url
          : undefined

      // 如果没有头像 URL，尝试从 head_image.db 获取
      if (!avatarUrl) {
        avatarUrl = await this.getAvatarFromHeadImageDb(username)
      }

      let weComCorp: string | undefined
      if (username.includes('@openim') && !username.includes('@kefu.openim') && hasExtraBuffer && row.extra_buffer) {
        weComCorp = await resolveWeComCorpName(this.state, 
          row.extra_buffer,
          [row.remark, row.nick_name, row.alias, username]
        )
      }

      return { avatarUrl, displayName, weComCorp }
    } catch {
      return null
    }
  }

  /**
   * 解析转账消息中的付款方和收款方显示名称
   * 优先使用群昵称（从 chatroom_info 表），群昵称为空时回退到微信昵称/备注
   */
  async resolveTransferDisplayNames(
    chatroomId: string,
    payerUsername: string,
    receiverUsername: string
  ): Promise<{ payerName: string; receiverName: string }> {
    try {
      // 如果是群聊，尝试从 contact.db 获取群昵称
      let groupNicknames: Record<string, string> = {}
      if (chatroomId.endsWith('@chatroom')) {
        try {
          // 尝试从 chatroom_info 表获取群成员昵称
          const tables = await dbAdapter.all<any>(
            'contact',
            '',
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%chatroom%'"
          )
          for (const t of tables) {
            try {
              const rows = await dbAdapter.all<any>(
                'contact',
                '',
                `SELECT * FROM ${t.name} WHERE chatroom_name = ? OR username = ?`,
                [chatroomId, chatroomId]
              )
              for (const row of rows) {
                const roomData = row.room_data || row.ext_buffer || ''
                if (roomData && typeof roomData === 'string') {
                  const memberRegex = /<member>[\s\S]*?<username>(.*?)<\/username>[\s\S]*?<displayName>(.*?)<\/displayName>[\s\S]*?<\/member>/gi
                  let match
                  while ((match = memberRegex.exec(roomData)) !== null) {
                    if (match[1] && match[2]) {
                      groupNicknames[match[1]] = match[2]
                    }
                  }
                }
              }
            } catch { /* 表结构不匹配，跳过 */ }
          }
        } catch { /* 查询失败，继续用联系人信息兜底 */ }
      }

      // 获取当前用户 wxid，用于识别"自己"
      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

      // 解析名称：自己 > 群昵称 > 备注 > 昵称 > alias > wxid
      const resolveName = async (username: string): Promise<string> => {
        if (!username) return username

        if (myWxid && (username === myWxid || username === cleanedMyWxid)) {
          const myGroupNick = groupNicknames[username]
          if (myGroupNick) return myGroupNick
          try {
            const myInfo = await this.getMyUserInfo()
            if (myInfo.success && myInfo.userInfo?.nickName) {
              return myInfo.userInfo.nickName
            }
          } catch { /* ignore */ }
          return '我'
        }

        const groupNick = groupNicknames[username]
        if (groupNick) return groupNick

        const contact = await this.getContact(username)
        if (contact) {
          return contact.remark || contact.nickName || contact.alias || username
        }
        return username
      }

      const [payerName, receiverName] = await Promise.all([
        resolveName(payerUsername),
        resolveName(receiverUsername)
      ])

      return { payerName, receiverName }
    } catch {
      return { payerName: payerUsername, receiverName: receiverUsername }
    }
  }

  /**
   * 从 head_image.db 获取头像（转换为 base64 data URL）
   */
  private async getAvatarFromHeadImageDb(username: string): Promise<string | undefined> {
    if (!username) return undefined

    try {
      // 检查缓存
      if (this.state.avatarBase64Cache.has(username)) {
        return this.state.avatarBase64Cache.get(username)
      }

      const row = await dbAdapter.get<any>(
        'head_image',
        '',
        'SELECT image_buffer FROM head_image WHERE username = ?',
        [username]
      )

      if (!row || !row.image_buffer) return undefined

      // 将 Buffer 转换为 base64 data URL
      const buffer = Buffer.from(row.image_buffer)
      const base64 = buffer.toString('base64')
      const dataUrl = `data:image/jpeg;base64,${base64}`

      // 缓存结果
      this.state.avatarBase64Cache.set(username, dataUrl)

      return dataUrl
    } catch (e: any) {
      // 如果是数据库损坏错误，只记录一次警告，避免刷屏
      if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
        if (!this.state.headImageDbCorrupted) {
          console.warn(`[ChatService] head_image.db 数据库文件损坏，头像功能可能受影响`)
          this.state.headImageDbCorrupted = true
        }
      } else {
        console.error(`获取 ${username} 的头像失败:`, e)
      }
      return undefined
    }
  }

  /**
   * 获取当前用户的头像 URL
   */
  async getMyAvatarUrl(): Promise<{ success: boolean; avatarUrl?: string; error?: string }> {
    try {
      const myWxid = this.state.configService.get('myWxid')
      if (!myWxid) {
        return { success: false, error: '未配置微信ID' }
      }

      // 检查 contact 表是否存在
      const tables = await dbAdapter.all<any>(
        'contact',
        '',
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact'"
      )

      if (tables.length === 0) {
        return { success: false, error: 'contact 表不存在' }
      }

      // 获取表结构
      const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
      const columnNames = columns.map((c: any) => c.name)

      const hasBigHeadUrl = columnNames.includes('big_head_url')
      const hasSmallHeadUrl = columnNames.includes('small_head_url')

      if (!hasBigHeadUrl && !hasSmallHeadUrl) {
        return { success: false, error: '联系人表中没有头像字段' }
      }

      const selectCols = ['username']
      if (hasBigHeadUrl) selectCols.push('big_head_url')
      if (hasSmallHeadUrl) selectCols.push('small_head_url')

      // 使用原始 wxid 查询
      const row = await dbAdapter.get<any>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
        [myWxid]
      )

      if (!row) {
        // 如果找不到，尝试用清理后的 wxid
        const cleanedWxid = cleanAccountDirName(myWxid)

        const row2 = await dbAdapter.get<any>(
          'contact',
          '',
          `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
          [cleanedWxid]
        )

        if (!row2) {
          const fallbackAvatarUrl = await this.getAvatarFromHeadImageDb(cleanedWxid || myWxid) || await this.getAvatarFromHeadImageDb(myWxid)
          return { success: true, avatarUrl: fallbackAvatarUrl }
        }

        const avatarUrl2 = (hasBigHeadUrl && row2.big_head_url)
          ? row2.big_head_url
          : (hasSmallHeadUrl && row2.small_head_url)
            ? row2.small_head_url
            : undefined
        const resolvedAvatarUrl2 = avatarUrl2 || await this.getAvatarFromHeadImageDb(row2.username || cleanedWxid)

        return { success: true, avatarUrl: resolvedAvatarUrl2 }
      }

      const avatarUrl = (hasBigHeadUrl && row.big_head_url)
        ? row.big_head_url
        : (hasSmallHeadUrl && row.small_head_url)
          ? row.small_head_url
          : undefined
      const resolvedAvatarUrl = avatarUrl || await this.getAvatarFromHeadImageDb(row.username || myWxid)

      return { success: true, avatarUrl: resolvedAvatarUrl }
    } catch (e) {
      console.error('ChatService: 获取当前用户头像失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取当前用户的完整信息（昵称、微信号、头像）
   */
  async getMyUserInfo(): Promise<{
    success: boolean
    userInfo?: {
      wxid: string
      nickName: string
      alias: string
      avatarUrl: string
    }
    error?: string
  }> {
    try {
      const myWxid = this.state.configService.get('myWxid')
      if (!myWxid) {
        return { success: false, error: '未配置微信ID' }
      }

      // 检查 contact 表是否存在
      const tables = await dbAdapter.all<any>(
        'contact',
        '',
        "SELECT name FROM sqlite_master WHERE type='table' AND name='contact'"
      )

      if (tables.length === 0) {
        return { success: false, error: 'contact 表不存在' }
      }

      // 获取表结构
      const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
      const columnNames = columns.map((c: any) => c.name)

      const hasBigHeadUrl = columnNames.includes('big_head_url')
      const hasSmallHeadUrl = columnNames.includes('small_head_url')

      const selectCols = ['username', 'nick_name', 'alias']
      if (hasBigHeadUrl) selectCols.push('big_head_url')
      if (hasSmallHeadUrl) selectCols.push('small_head_url')

      // 使用原始 wxid 查询
      let row = await dbAdapter.get<any>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
        [myWxid]
      )

      if (!row) {
        // 如果找不到，尝试用清理后的 wxid
        const cleanedWxid = cleanAccountDirName(myWxid)
        row = await dbAdapter.get<any>(
          'contact',
          '',
          `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
          [cleanedWxid]
        )
      }

      if (!row) {
        const cleanedWxid = cleanAccountDirName(myWxid)
        const fallbackAvatarUrl = await this.getAvatarFromHeadImageDb(cleanedWxid || myWxid) || await this.getAvatarFromHeadImageDb(myWxid)
        return {
          success: true,
          userInfo: {
            wxid: myWxid,
            nickName: '',
            alias: '',
            avatarUrl: fallbackAvatarUrl || ''
          }
        }
      }

      const avatarUrl = (hasBigHeadUrl && row.big_head_url)
        ? row.big_head_url
        : (hasSmallHeadUrl && row.small_head_url)
          ? row.small_head_url
          : ''
      const resolvedAvatarUrl = avatarUrl || await this.getAvatarFromHeadImageDb(row.username || myWxid) || ''

      return {
        success: true,
        userInfo: {
          wxid: myWxid,
          nickName: row.nick_name || '',
          alias: row.alias || '',
          avatarUrl: resolvedAvatarUrl
        }
      }
    } catch (e) {
      console.error('ChatService: 获取当前用户信息失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 从 misc.db 获取 UIN（微信账号ID）
   * UIN 用于表情包缓存解密的密钥派生
   */
  async getUinFromMiscDb(): Promise<string | null> {
    try {
      // 尝试从 DBInfo 表获取 UIN
      try {
        const row = await dbAdapter.get<any>(
          'misc',
          '',
          "SELECT value FROM DBInfo WHERE key = 'uin'"
        )

        if (row && row.value) {
          return String(row.value)
        }
      } catch {
        // DBInfo 表可能不存在或结构不同
      }

      // 备选：尝试从其他可能的表获取 UIN
      try {
        const tables = await dbAdapter.all<any>(
          'misc',
          '',
          "SELECT name FROM sqlite_master WHERE type='table'"
        )
        for (const table of tables) {
          const tableName = table.name
          if (tableName.toLowerCase().includes('info') || tableName.toLowerCase().includes('account')) {
            try {
              const columns = await dbAdapter.all<any>('misc', '', `PRAGMA table_info(${tableName})`)
              const columnNames = columns.map((c: any) => c.name)

              if (columnNames.includes('uin')) {
                const uinRow = await dbAdapter.get<any>('misc', '', `SELECT uin FROM ${tableName} LIMIT 1`)
                if (uinRow && uinRow.uin) {
                  return String(uinRow.uin)
                }
              }
            } catch {
              // 跳过无法查询的表
            }
          }
        }
      } catch {
        // 无法扫描表
      }

      return null
    } catch (e) {
      console.error('ChatService: 从 misc.db 获取 UIN 失败:', e)
      return null
    }
  }

  /**
   * 获取表情包缓存解密所需的 UIN 和 keyString
   * - UIN: 从 misc.db 获取，或从配置读取
   * - keyString: 使用 myWxid（已在配置中）
   */
  async getEmoticonDecryptionParams(): Promise<{ uin: string | null; keyString: string | null }> {
    try {
      // 优先从 misc.db 自动获取 UIN
      let uin = await this.getUinFromMiscDb()

      // 如果自动获取失败，尝试从配置读取
      if (!uin) {
        uin = this.state.configService.get('emoticonUin') || null
      }

      // keyString 使用 myWxid
      const keyString = this.state.configService.get('myWxid') || null

      return { uin, keyString }
    } catch (e) {
      console.error('ChatService: 获取表情包解密参数失败:', e)
      return { uin: null, keyString: null }
    }
  }

  /**
   * 解密表情包缓存文件
   * 使用 AES-128-CBC (IV=Key) + XOR 掩码
   * 密钥派生: MD5(str(UIN) + keyString + "EMOTICON") → 小写十六进制 → 前16字符
   */
  async decryptEmoticonCache(filePath: string): Promise<Buffer | null> {
    try {
      if (!fs.existsSync(filePath)) {
        return null
      }

      // 获取解密参数
      const params = await this.getEmoticonDecryptionParams()
      if (!params.uin || !params.keyString) {
        console.warn('ChatService: 缺少表情包解密参数 (UIN 或 keyString)')
        return null
      }

      // 读取加密文件
      const encryptedBuffer = fs.readFileSync(filePath)
      if (encryptedBuffer.length === 0) {
        return null
      }

      const crypto = require('crypto')

      // 密钥派生: MD5(str(UIN) + keyString + "EMOTICON")
      const keyMaterial = String(params.uin) + params.keyString + 'EMOTICON'
      const keyHash = crypto.createHash('md5').update(keyMaterial).digest('hex').toLowerCase()
      const keyHex = keyHash.substring(0, 16)
      const key = Buffer.from(keyHex, 'utf8')

      // 复制缓冲区以便修改
      const workBuffer = Buffer.from(encryptedBuffer)

      // 应用 XOR 掩码到前32字节
      // XOR 掩码是密钥的重复
      const xorMask = Buffer.alloc(32)
      for (let i = 0; i < 32; i++) {
        xorMask[i] = key[i % key.length]
      }

      for (let i = 0; i < Math.min(32, workBuffer.length); i++) {
        workBuffer[i] ^= xorMask[i]
      }

      // AES-128-CBC 解密，IV = Key
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, key)
      decipher.setAutoPadding(true)

      const decrypted = Buffer.concat([
        decipher.update(workBuffer),
        decipher.final()
      ])

      return decrypted
    } catch (e) {
      console.error('ChatService: 表情包缓存解密失败:', e)
      return null
    }
  }

  /**
   * 获取商店表情包的备选 URL 列表
   * 尝试不同的域名和扩展名组合
   */
  private getAlternativeStoreEmojiUrls(productId: string, md5: string): string[] {
    const urls: string[] = []

    try {
      const prefix = 'com.tencent.xin.emoticon.'
      if (!productId.startsWith(prefix)) {
        return urls
      }

      const productPath = productId.substring(prefix.length)

      // 多个可能的域名
      const baseUrls = [
        'https://emoji.qpic.cn/resource/emoticon',
        'https://mmbiz.qpic.cn/mmemoticon',
        'https://emoji.weixin.qq.com/resource/emoticon',
      ]

      // 多个可能的扩展名
      const extensions = ['webp', 'png', 'jpg']

      // 生成所有组合
      for (const baseUrl of baseUrls) {
        for (const ext of extensions) {
          urls.push(`${baseUrl}/${productPath}/${md5}.${ext}`)
        }
      }
    } catch (e) {
      // 忽略错误
    }

    return urls
  }

  /**
   * 构造商店表情包的 URL
   * 根据 productId 和 MD5 拼接微信表情资源 CDN 链接
   * 
   * 规则来源：iWeChat 项目的表情解析逻辑
   * URL 格式：https://emoji.weixin.qq.com/resource/emoticon/{product_path}/{md5}.{ext}
   */
  private constructStoreEmojiUrl(productId: string, md5: string): string | null {
    try {
      // 移除前缀 "com.tencent.xin.emoticon."
      const prefix = 'com.tencent.xin.emoticon.'
      if (!productId.startsWith(prefix)) {
        return null
      }

      const productPath = productId.substring(prefix.length)

      // 尝试多种可能的扩展名和域名
      const baseUrls = [
        'https://emoji.weixin.qq.com/resource/emoticon',
        'https://emoji.qpic.cn/resource/emoticon',
        'https://mmbiz.qpic.cn/mmemoticon',
      ]

      const extensions = ['gif', 'webp', 'png']

      // 返回第一个可能的 URL（后续会尝试下载）
      // 优先使用 gif 格式
      return `${baseUrls[0]}/${productPath}/${md5}.gif`
    } catch (e) {
      return null
    }
  }

  /**
   * 从本地文件系统查找表情包文件
   * 用于商店表情包，当消息中没有 CDN URL 时
   */
  private async findLocalEmojiFile(md5: string, productId: string): Promise<string | null> {
    try {
      const dbPath = this.state.configService.get('dbPath')
      const myWxid = this.state.configService.get('myWxid')

      if (!dbPath || !myWxid || !fs.existsSync(dbPath)) {
        return null
      }

      const accountDirName = findAccountDir(dbPath, myWxid)
      if (!accountDirName) {
        return null
      }

      const accountRootDir = path.join(dbPath, accountDirName)
      const md5Lower = md5.toLowerCase()

      // 商店表情包可能的路径
      const candidatePaths: string[] = [
        // 路径 1: All Users/Emoji/<package_id>/<md5>
        path.join(dbPath, 'All Users', 'Emoji', productId, md5Lower),
        path.join(dbPath, 'All Users', 'Emoji', productId, md5),

        // 路径 2: <wxid>/FileStorage/Stickers/<package_id>/<md5>
        path.join(accountRootDir, 'FileStorage', 'Stickers', productId, md5Lower),
        path.join(accountRootDir, 'FileStorage', 'Stickers', productId, md5),

        // 路径 3: <wxid>/business/emoticon/<package_id>/<md5>
        path.join(accountRootDir, 'business', 'emoticon', productId, md5Lower),
        path.join(accountRootDir, 'business', 'emoticon', productId, md5),

        // 路径 4: <wxid>/Stickers/<package_id>/<md5>
        path.join(accountRootDir, 'Stickers', productId, md5Lower),
        path.join(accountRootDir, 'Stickers', productId, md5),
      ]

      // 路径 5: 搜索 cache 目录下的 Emoticon 子目录（微信缓存，按月份分组）
      const cacheDir = path.join(accountRootDir, 'cache')
      if (fs.existsSync(cacheDir)) {
        try {
          const cacheDirs = fs.readdirSync(cacheDir)
          for (const subDir of cacheDirs) {
            const emoticonDir = path.join(cacheDir, subDir, 'Emoticon')
            if (fs.existsSync(emoticonDir)) {
              candidatePaths.push(path.join(emoticonDir, md5Lower))
              candidatePaths.push(path.join(emoticonDir, md5))
            }
          }
        } catch (e) {
          // 忽略 cache 目录读取错误
        }
      }

      // 检查每个候选路径
      for (const candidatePath of candidatePaths) {
        if (fs.existsSync(candidatePath)) {
          const stat = fs.statSync(candidatePath)
          if (stat.isFile() && stat.size > 0) {
            return candidatePath
          }
        }
      }

      // 如果直接路径不存在，尝试在目录中查找（可能有扩展名）
      for (const candidatePath of candidatePaths) {
        const dir = path.dirname(candidatePath)
        if (fs.existsSync(dir)) {
          try {
            const files = fs.readdirSync(dir)
            const baseName = path.basename(candidatePath)

            // 查找匹配的文件（可能有 .gif, .png 等扩展名）
            for (const file of files) {
              if (file.toLowerCase().startsWith(baseName.toLowerCase())) {
                const fullPath = path.join(dir, file)
                const stat = fs.statSync(fullPath)
                if (stat.isFile() && stat.size > 0) {
                  return fullPath
                }
              }
            }
          } catch (e) {
            // 忽略目录读取错误
          }
        }
      }

      // 尝试从打包文件中提取
      const extractedFile = await this.extractEmojiFromPackage(md5, productId)
      if (extractedFile) {
        return extractedFile
      }

      return null
    } catch (e) {
      return null
    }
  }

  /**
   * 从打包文件中提取表情包
   * 商店表情包通常打包存储，需要使用 offset 和 size 提取
   */
  private async extractEmojiFromPackage(md5: string, productId: string): Promise<string | null> {
    try {
      // 从数据库获取 offset 和 size
      const row = await dbAdapter.get<any>(
        'emoticon',
        '',
        `SELECT emoticon_offset_, emoticon_size_
         FROM kStoreEmoticonFilesTable
         WHERE LOWER(md5_) = LOWER(?) AND package_id_ = ?`,
        [md5, productId]
      )

      if (!row || !row.emoticon_offset_ || !row.emoticon_size_) {
        return null
      }

      const offset = row.emoticon_offset_
      const size = row.emoticon_size_

      // 查找打包文件
      const dbPath = this.state.configService.get('dbPath')
      const myWxid = this.state.configService.get('myWxid')

      if (!dbPath || !myWxid) {
        return null
      }

      const accountDirName = findAccountDir(dbPath, myWxid)
      if (!accountDirName) {
        return null
      }

      const accountRootDir = path.join(dbPath, accountDirName)

      // 打包文件可能的路径
      const packagePaths = [
        path.join(accountRootDir, 'FileStorage', 'Stickers', productId),
        path.join(accountRootDir, 'business', 'emoticon', productId),
        path.join(accountRootDir, 'Stickers', productId),
        path.join(dbPath, 'All Users', 'Emoji', productId),
      ]

      let packageFile: string | null = null

      // 查找打包文件（可能是目录中的某个文件）
      for (const packageDir of packagePaths) {
        if (!fs.existsSync(packageDir)) continue

        try {
          const stat = fs.statSync(packageDir)

          // 如果是文件，直接使用
          if (stat.isFile()) {
            packageFile = packageDir
            break
          }

          // 如果是目录，查找可能的打包文件
          if (stat.isDirectory()) {
            const files = fs.readdirSync(packageDir)

            // 查找可能的打包文件（通常是最大的文件或特定名称）
            for (const file of files) {
              const filePath = path.join(packageDir, file)
              const fileStat = fs.statSync(filePath)

              if (fileStat.isFile()) {
                // 检查文件大小是否足够包含我们要提取的数据
                if (fileStat.size >= offset + size) {
                  packageFile = filePath
                  break
                }
              }
            }

            if (packageFile) break
          }
        } catch (e) {
          // 忽略错误
        }
      }

      if (!packageFile) {
        return null
      }

      const buffer = fs.readFileSync(packageFile)

      if (buffer.length < offset + size) {
        return null
      }

      const emojiData = buffer.slice(offset, offset + size)

      // 保存到缓存目录
      const cacheDir = this.getEmojiCacheDir()
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true })
      }

      // 检测文件格式
      const ext = this.detectImageExtension(emojiData) || '.gif'
      const outputPath = path.join(cacheDir, `${md5}${ext}`)

      fs.writeFileSync(outputPath, emojiData)

      return outputPath
    } catch (e) {
      return null
    }
  }

  /**
   * 从消息数据库中查找表情包 CDN URL
   * 用于商店表情包，因为它们的完整 URL（包含 filekey）只存在于消息内容中
   */
  private async findEmojiUrlFromMessages(md5: string, createTime?: number): Promise<string | null> {
    try {
      // 查找所有消息数据库
      const { allDbs } = findMessageDbs(this.state)

      if (allDbs.length === 0) return null

      // 遍历所有消息数据库，查找匹配的表情消息
      for (const dbPath of allDbs) {
        try {
          // 查找所有消息表
          const tables = await dbAdapter.all<any>(
            'message',
            dbPath,
            "SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'"
          )

          for (const table of tables) {
            const tableName = table.name as string

            try {
              let rows: any[]

              // 如果有 createTime，使用时间范围查询（更精确）
              if (createTime) {
                const timeStart = createTime - 5
                const timeEnd = createTime + 5

                rows = await dbAdapter.all<any>(
                  'message',
                  dbPath,
                  `SELECT local_id, create_time, message_content, compress_content
                   FROM ${tableName}
                   WHERE local_type = 47
                   AND create_time >= ?
                   AND create_time <= ?
                   LIMIT 100`,
                  [timeStart, timeEnd]
                )
              } else {
                // 没有 createTime，查询最近的表情消息（按时间倒序）
                rows = await dbAdapter.all<any>(
                  'message',
                  dbPath,
                  `SELECT local_id, create_time, message_content, compress_content
                   FROM ${tableName}
                   WHERE local_type = 47
                   ORDER BY create_time DESC
                   LIMIT 200`
                )
              }

              for (const row of rows) {
                const content = decodeMessageContent(row.message_content, row.compress_content)
                if (!content) continue

                // 解析表情信息
                const emojiInfo = parseEmojiInfo(content)

                // 检查 MD5 是否匹配（不区分大小写）
                if (emojiInfo.md5 && emojiInfo.md5.toLowerCase() === md5.toLowerCase()) {
                  if (emojiInfo.cdnUrl) {
                    return emojiInfo.cdnUrl
                  }
                }
              }
            } catch (e: any) {
              // 忽略单个表查询错误（静默处理损坏的表）
            }
          }
        } catch (e: any) {
          // 忽略损坏的数据库（静默处理）
        }
      }

      return null
    } catch (e) {
      return null
    }
  }

  /**
   * 获取表情包缓存目录
   */
  private getEmojiCacheDir(): string {
    const cachePath = this.state.configService.get('cachePath')
    if (cachePath) {
      return path.join(cachePath, 'Emojis')
    }
    // 回退到默认目录
    return path.join(this.getDecryptedDbDir(), 'Emojis')
  }

  /**
   * 下载或获取表情包本地缓存
   * 如果 cdnUrl 为空但 md5 存在，则尝试通过本地存储或多种拼接规则下载
   */
  async downloadEmoji(cdnUrl: string, md5?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string): Promise<{ success: boolean; localPath?: string; cachePath?: string; error?: string }> {
    // 如果没有 cdnUrl 也没有 md5，无法处理
    if (!cdnUrl && !md5) {
      return { success: false, error: '无效的 CDN URL 和 MD5' }
    }

    // 生成缓存 key
    const cacheKey = md5 || this.hashString(cdnUrl)

    // 检查内存缓存
    const cached = emojiCache.get(cacheKey)
    if (cached && fs.existsSync(cached)) {
      const dataUrl = this.fileToDataUrl(cached)
      if (dataUrl) {
        return { success: true, localPath: dataUrl, cachePath: cached }
      }
    }

    // 检查是否正在下载
    const downloading = emojiDownloading.get(cacheKey)
    if (downloading) {
      const result = await downloading
      if (result) {
        const dataUrl = this.fileToDataUrl(result)
        if (dataUrl) {
          return { success: true, localPath: dataUrl, cachePath: result }
        }
      }
      return { success: false, error: '下载失败' }
    }

    // 确保缓存目录存在
    const cacheDir = this.getEmojiCacheDir()
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true })
    }

    // 检查本地是否已有缓存文件
    const extensions = ['.gif', '.png', '.webp', '.jpg', '.jpeg']
    for (const ext of extensions) {
      const filePath = path.join(cacheDir, `${cacheKey}${ext}`)
      if (fs.existsSync(filePath)) {
        emojiCache.set(cacheKey, filePath)
        const dataUrl = this.fileToDataUrl(filePath)
        if (dataUrl) {
          return { success: true, localPath: dataUrl, cachePath: filePath }
        }
      }
    }

    // [精简] 基础 ID 与链接获取
    let effectiveProductId = productId
    let finalCdnUrl = cdnUrl

    // 尝试从本地数据库补充 productId (商店表情包)
    if (!effectiveProductId && md5) {
      try {
        const row = await dbAdapter.get<any>(
          'emoticon',
          '',
          'SELECT package_id_ FROM kStoreEmoticonFilesTable WHERE LOWER(md5_) = LOWER(?)',
          [md5]
        )
        if (row?.package_id_) {
          effectiveProductId = row.package_id_
        }
      } catch (e) { }
    }

    // [New] 尝试从本地数据库查找 CDN URL (修复: 增强匹配逻辑、不区分大小写)
    if (!finalCdnUrl && md5) {
      const targetKinds: string[] = ['emoticon', 'emotion']

      // 优先查询 kNonStoreEmoticonTable (非商店表情包，最常用)
      const priorityTables = [
        { name: 'kNonStoreEmoticonTable', md5Col: 'md5', urlCols: ['cdn_url', 'encrypt_url', 'extern_url'] },
        { name: 'kStoreEmoticonFilesTable', md5Col: 'md5_', urlCols: [] }, // 商店表情包需要通过 package_id 构建
      ]

      // 备用表名（兼容旧版本）
      const candidateTables = ['CustomEmoticon', 'Emoticon', 'EmojiInfo', 'SmileyInfo', 'EmoticonInfo']
      let found = false

      for (const kind of targetKinds) {
        // 1. 优先查询已知表结构
        for (const tableInfo of priorityTables) {
          try {
            const tableExists = await dbAdapter.get<any>(
              kind,
              '',
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
              [tableInfo.name]
            )
            if (!tableExists) continue

            if (tableInfo.urlCols.length > 0) {
              // kNonStoreEmoticonTable: 尝试多个 URL 字段
              for (const urlCol of tableInfo.urlCols) {
                try {
                  const row = await dbAdapter.get<any>(
                    kind,
                    '',
                    `SELECT ${urlCol} as url FROM ${tableInfo.name} WHERE LOWER(${tableInfo.md5Col}) = LOWER(?) LIMIT 1`,
                    [md5]
                  )
                  if (row?.url) {
                    finalCdnUrl = row.url
                    found = true
                    break
                  }
                } catch (err) { }
              }
            }

            if (found) break
          } catch (err) { }
        }

        if (found) break

        // 2. 备用：动态查询未知表结构
        for (const tableName of candidateTables) {
          try {
            // 检查表是否存在
            const tableExists = await dbAdapter.get<any>(
              kind,
              '',
              "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
              [tableName]
            )
            if (!tableExists) continue

            // 动态获取列名以适配不同版本 (md5 vs md5_, cdnUrl vs cdn_url)
            const columns = await dbAdapter.all<any>(kind, '', `PRAGMA table_info(${tableName})`)
            const colNames = columns.map((c: any) => c.name)
            const md5Col = colNames.find((c: string) => ['md5', 'md5_'].includes(c.toLowerCase()))
            const urlCol = colNames.find((c: string) => ['cdnurl', 'cdn_url', 'cdnurl_', 'url', 'encrypturl', 'encrypt_url'].includes(c.toLowerCase()))

            if (md5Col && urlCol) {
              // 使用 LOWER 确保 MD5 大小写不一致也能匹配 (微信数据库中 MD5 有时是大写)
              const row = await dbAdapter.get<any>(
                kind,
                '',
                `SELECT ${urlCol} as url FROM ${tableName} WHERE LOWER(${md5Col}) = LOWER(?) LIMIT 1`,
                [md5]
              )
              if (row?.url) {
                finalCdnUrl = row.url
                found = true
                break
              }
            }
          } catch (err) { }
        }
        if (found) break
      }
    }

    // [Critical] 如果仍然没有 CDN URL，尝试从消息数据库中提取（商店表情包的关键）
    if (!finalCdnUrl && md5) {
      try {
        const emojiUrl = await this.findEmojiUrlFromMessages(md5, createTime)
        if (emojiUrl) {
          finalCdnUrl = emojiUrl
        }
      } catch (e) {
        // 忽略错误
      }
    }

    // [New] 如果仍然没有 URL，尝试通过 productId 构造 URL（商店表情包）
    if (!finalCdnUrl && md5 && effectiveProductId) {
      try {
        const constructedUrl = this.constructStoreEmojiUrl(effectiveProductId, md5)
        if (constructedUrl) {
          finalCdnUrl = constructedUrl
        }
      } catch (e) {
        // 忽略构造 URL 失败
      }
    }

    // [New] 如果仍然没有 URL，尝试从本地文件系统查找（商店表情包）
    if (!finalCdnUrl && md5 && effectiveProductId) {
      try {
        const localFile = await this.findLocalEmojiFile(md5, effectiveProductId)
        if (localFile) {
          const dataUrl = this.fileToDataUrl(localFile)
          if (dataUrl) {
            emojiCache.set(cacheKey, localFile)
            return { success: true, localPath: dataUrl, cachePath: localFile }
          }
        }
      } catch (e) {
        // 忽略查找本地文件失败
      }
    }

    if (!finalCdnUrl && !effectiveProductId) {
      // 非商店表情包，尝试备选 URL
      const fallbackUrls: string[] = [
        `https://emoji.qpic.cn/wx_emoji/${md5}/0`,
        `https://emoji.qpic.cn/wx_emoji/${md5}/126`
      ]

      for (const url of fallbackUrls) {
        try {
          const localPath = await this.doDownloadEmoji(url, cacheKey, cacheDir)
          if (localPath) {
            const dataUrl = this.fileToDataUrl(localPath)
            if (dataUrl) {
              emojiCache.set(cacheKey, localPath)
              return { success: true, localPath: dataUrl, cachePath: localPath }
            }
          }
        } catch (e) { }
      }

      return { success: false, error: '表情包不可用：未找到 CDN URL，本地文件也不存在' }
    }

    if (!finalCdnUrl) {
      return { success: false, error: '商店表情包暂不可用：需要从微信重新下载' }
    }

    // 普通 CDN 下载流程
    try {
      const localPath = await this.doDownloadEmoji(finalCdnUrl, cacheKey, cacheDir)
      if (localPath) {
        emojiCache.set(cacheKey, localPath)
        const dataUrl = this.fileToDataUrl(localPath)
        if (dataUrl) return { success: true, localPath: dataUrl, cachePath: localPath }
      }
    } catch (e) {
      // 忽略下载失败
    }

    // 如果是商店表情包且下载失败，尝试其他扩展名和域名
    if (effectiveProductId && md5) {
      const alternativeUrls = this.getAlternativeStoreEmojiUrls(effectiveProductId, md5)

      for (const altUrl of alternativeUrls) {
        try {
          const localPath = await this.doDownloadEmoji(altUrl, cacheKey, cacheDir)
          if (localPath) {
            emojiCache.set(cacheKey, localPath)
            const dataUrl = this.fileToDataUrl(localPath)
            if (dataUrl) {
              return { success: true, localPath: dataUrl, cachePath: localPath }
            }
          }
        } catch (e) {
          // 继续尝试下一个
        }
      }
    }

    // encryptUrl fallback: 下载加密表情并用 AES 解密
    if (encryptUrl && aesKey) {
      try {
        const encLocalPath = await this.doDownloadEmoji(encryptUrl.replace(/&amp;/g, '&'), cacheKey + '_enc', cacheDir)
        if (encLocalPath) {
          const encData = fs.readFileSync(encLocalPath)
          const crypto = require('crypto')
          const keyBuf = Buffer.from(crypto.createHash('md5').update(aesKey).digest('hex').slice(0, 16), 'utf8')
          const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuf, null)
          decipher.setAutoPadding(true)
          const decrypted = Buffer.concat([decipher.update(encData), decipher.final()])
          const ext = this.detectImageExtension(decrypted) || '.gif'
          const outputPath = path.join(cacheDir, `${cacheKey}${ext}`)
          fs.writeFileSync(outputPath, decrypted)
          try { fs.unlinkSync(encLocalPath) } catch { }
          emojiCache.set(cacheKey, outputPath)
          const dataUrl = this.fileToDataUrl(outputPath)
          if (dataUrl) return { success: true, localPath: dataUrl, cachePath: outputPath }
        }
      } catch (e) {
        console.warn('[ChatService] encryptUrl fallback 失败:', e)
      }
    }

    return { success: false, error: '下载失败' }
  }

  /**
   * 将文件转为 data URL (带 ZSTD 解压与 XOR 解密)
   */
  private fileToDataUrl(filePath: string): string | null {
    try {
      let buffer = fs.readFileSync(filePath)
      if (!buffer || buffer.length === 0) return null

      // 1. ZSTD 解压缩
      const zstdMagic = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
      const zstdIndex = buffer.indexOf(zstdMagic)
      if (zstdIndex !== -1 && zstdIndex < 256) {
        try {
          const decompressed = Buffer.from(fzstd.decompress(buffer.slice(zstdIndex)))
          if (decompressed.length > 0) buffer = decompressed
        } catch (e) { }
      }

      // 2. 格式识别与 XOR 解密
      let mimeType = this.detectMimeType(buffer)
      let decryptedBuffer = buffer

      if (!mimeType) {
        const xorKeyHex = this.state.configService.get('imageXorKey')
        const xorKey = xorKeyHex ? parseInt(xorKeyHex, 16) : null

        // 尝试偏移 0 和 16
        for (const offset of [0, 16]) {
          if (buffer.length <= offset) continue
          const part = buffer.slice(offset)

          // 尝试配置的 XOR Key
          if (xorKey !== null && !isNaN(xorKey)) {
            const temp = Buffer.alloc(part.length)
            for (let i = 0; i < part.length; i++) temp[i] = part[i] ^ xorKey
            const m = this.detectMimeType(temp)
            if (m) {
              decryptedBuffer = temp
              mimeType = m
              break
            }
          }

          // 简单暴力破解单字节 XOR (仅常用图片头)
          const heads = [0x47, 0x89, 0xFF] // GIF, PNG, JPG
          for (const head of heads) {
            const key = part[0] ^ head
            const temp = Buffer.alloc(part.length)
            for (let i = 0; i < part.length; i++) temp[i] = part[i] ^ key
            const m = this.detectMimeType(temp)
            if (m) {
              decryptedBuffer = temp
              mimeType = m
              break
            }
          }
          if (mimeType) break
        }
      }

      if (!mimeType) mimeType = 'image/gif' // 兜底

      return `data:${mimeType};base64,${decryptedBuffer.toString('base64')}`
    } catch (e) {
      return null
    }
  }

  /**
   * 辅助：探测 Buffer 是哪种图片格式
   */
  private detectMimeType(buffer: Buffer): string | null {
    if (buffer.length < 4) return null
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return 'image/png'
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return 'image/jpeg'
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return 'image/webp'
    return null
  }

  /**
   * 执行表情包下载 (深度模拟微信环境)
   */
  private doDownloadEmoji(url: string, cacheKey: string, cacheDir: string): Promise<string | null> {
    return new Promise((resolve) => {
      try {
        // 强制升级 http 到 https (解决 ECONNRESET)
        if (url.startsWith('http://') && (url.includes('qq.com') || url.includes('wechat.com'))) {
          url = url.replace('http://', 'https://')
        }

        const urlObj = new URL(url)
        const protocol = url.startsWith('https') ? https : http

        // 使用真实微信 PC 端 Headers
        const options = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x67001431) NetType/WIFI MiniProgramEnv/Windows WindowsWechat/3.9.11.17(0x63090b11) XWEB/1158',
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Connection': 'keep-alive'
          },
          // [Fix] 针对腾讯/微信 CDN 域名跳过证书验证
          rejectUnauthorized: false,
          timeout: 10000
        }

        const request = protocol.get(url, options, (response) => {
          // 处理重定向 (支持多级跳转)
          if (response.statusCode === 301 || response.statusCode === 302 || response.statusCode === 303 || response.statusCode === 307) {
            const redirectUrl = response.headers.location
            if (redirectUrl) {
              const fullRedirectUrl = redirectUrl.startsWith('http') ? redirectUrl : `${urlObj.protocol}//${urlObj.host}${redirectUrl}`
              this.doDownloadEmoji(fullRedirectUrl, cacheKey, cacheDir).then(resolve)
              return
            }
          }

          if (response.statusCode !== 200) {
            resolve(null)
            return
          }

          const chunks: Buffer[] = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => {
            const buffer = Buffer.concat(chunks)
            if (buffer.length === 0) {
              resolve(null)
              return
            }

            // 根据二进制内容自动纠正文件后缀
            const ext = this.detectImageExtension(buffer) || this.getExtFromUrl(url) || '.gif'
            const filePath = path.join(cacheDir, `${cacheKey}${ext}`)

            try {
              if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true })
              fs.writeFileSync(filePath, buffer)
              resolve(filePath)
            } catch (err) {
              resolve(null)
            }
          })
          response.on('error', () => resolve(null))
        })

        request.on('error', (err) => {
          resolve(null)
        })
        request.setTimeout(15000, () => {
          request.destroy()
          resolve(null)
        })
      } catch (e) {
        resolve(null)
      }
    })
  }

  /**
   * 检测图片格式
   */
  private detectImageExtension(buffer: Buffer): string | null {
    if (buffer.length < 12) return null

    // GIF
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return '.gif'
    }
    // PNG
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return '.png'
    }
    // JPEG
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return '.jpg'
    }
    // WEBP
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return '.webp'
    }

    return null
  }

  /**
   * 从 URL 获取扩展名
   */
  private getExtFromUrl(url: string): string | null {
    try {
      const pathname = new URL(url).pathname
      const ext = path.extname(pathname).toLowerCase()
      if (['.gif', '.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
        return ext
      }
    } catch { }
    return null
  }

  /**
   * 简单的字符串哈希
   */
  private hashString(str: string): string {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(16)
  }

  /**
   * 获取会话详情信息
   */
  async getSessionDetail(sessionId: string): Promise<{
    success: boolean
    detail?: {
      wxid: string
      displayName: string
      remark?: string
      nickName?: string
      alias?: string
      avatarUrl?: string
      messageCount: number
      firstMessageTime?: number
      latestMessageTime?: number
      messageTables: { dbName: string; tableName: string; count: number }[]
      errors?: StatsPartialError[]
      partialFailureCount?: number
    }
    error?: string
  }> {
    try {
      // 获取联系人信息
      let displayName = sessionId
      let remark: string | undefined
      let nickName: string | undefined
      let alias: string | undefined
      let avatarUrl: string | undefined

      try {
        if (!this.state.contactColumnsCache) {
          const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
          const columnNames = columns.map((c: any) => c.name)

          const hasBigHeadUrl = columnNames.includes('big_head_url')
          const hasSmallHeadUrl = columnNames.includes('small_head_url')
          const hasExtraBuffer = columnNames.includes('extra_buffer')

          const selectCols = ['username', 'remark', 'nick_name', 'alias']
          if (hasBigHeadUrl) selectCols.push('big_head_url')
          if (hasSmallHeadUrl) selectCols.push('small_head_url')
          if (hasExtraBuffer) selectCols.push('extra_buffer')
          if (columnNames.includes('flag')) selectCols.push('flag')

          this.state.contactColumnsCache = { hasBigHeadUrl, hasSmallHeadUrl, hasExtraBuffer, selectCols }
        }

        const { hasBigHeadUrl, hasSmallHeadUrl, selectCols } = this.state.contactColumnsCache

        const contact = await dbAdapter.get<any>(
          'contact',
          '',
          `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
          [sessionId]
        )

        if (contact) {
          remark = contact.remark || undefined
          nickName = contact.nick_name || undefined
          alias = contact.alias || undefined
          displayName = remark || nickName || alias || sessionId

          if (hasBigHeadUrl && contact.big_head_url) {
            avatarUrl = contact.big_head_url
          } else if (hasSmallHeadUrl && contact.small_head_url) {
            avatarUrl = contact.small_head_url
          }

          if (!avatarUrl) {
            avatarUrl = await this.getAvatarFromHeadImageDb(sessionId)
          }
        }
      } catch { }

      if (!avatarUrl) {
        avatarUrl = await this.getAvatarFromHeadImageDb(sessionId)
      }

      // 查找所有包含该会话消息的数据库和表
      const dbTablePairs = await findSessionTables(this.state, sessionId)
      const messageTables: { dbName: string; tableName: string; count: number }[] = []
      let totalMessageCount = 0
      let firstMessageTime: number | undefined
      let latestMessageTime: number | undefined
      const errors: StatsPartialError[] = []

      for (const { tableName, dbPath } of dbTablePairs) {
        try {
          const columns = await getMessageTableColumns(dbPath, tableName)
          const where = buildMessageStatsWhere({ contentColumn: columns.contentColumn || undefined })
          const safeTable = quoteIdent(tableName)

          // 获取消息数量（排除系统消息 / 撤回 / 拍一拍 / 空内容）
          const countResult = await dbAdapter.get<any>(
            'message',
            dbPath,
            `SELECT COUNT(*) as count FROM ${safeTable} ${where.sql}`,
            where.params
          )
          const count = Number(countResult?.count ?? 0)
          totalMessageCount += count

          // 获取时间范围
          const timeResult = await dbAdapter.get<any>(
            'message',
            dbPath,
            `SELECT MIN(create_time) as first_time, MAX(create_time) as last_time
             FROM ${safeTable} ${where.sql}`,
            where.params
          )

          if (timeResult) {
            if (timeResult.first_time !== null && timeResult.first_time !== undefined && timeResult.first_time > 0) {
              if (firstMessageTime === undefined || timeResult.first_time < firstMessageTime) {
                firstMessageTime = timeResult.first_time
              }
            }
            if (timeResult.last_time !== null && timeResult.last_time !== undefined && timeResult.last_time > 0) {
              if (latestMessageTime === undefined || timeResult.last_time > latestMessageTime) {
                latestMessageTime = timeResult.last_time
              }
            }
          }

          messageTables.push({
            dbName: path.basename(dbPath),
            tableName,
            count
          })
        } catch (e) {
          recordStatsError(errors, e, { dbPath, tableName, prefix: '[ChatService][SessionDetail]' })
        }
      }

      const extra = errors.length > 0
        ? { errors, partialFailureCount: errors.length }
        : {}

      return {
        success: true,
        detail: {
          wxid: sessionId,
          displayName,
          remark,
          nickName,
          alias,
          avatarUrl,
          messageCount: totalMessageCount,
          firstMessageTime,
          latestMessageTime,
          messageTables,
          ...extra,
        }
      }
    } catch (e) {
      console.error('ChatService: 获取会话详情失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 查找 media 数据库文件
   */
  private findMediaDbs(): string[] {
    const root = getDbStoragePath()
    if (!root) return []

    const mediaDbFiles: string[] = []

    try {
      const collect = (dir: string, depth = 0) => {
        if (depth > 5) return
        let entries: fs.Dirent[]
        try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
        for (const entry of entries) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            collect(full, depth + 1)
          } else if (entry.isFile()) {
            const lower = entry.name.toLowerCase()
            if (lower.startsWith('media') && lower.endsWith('.db')) {
              mediaDbFiles.push(full)
            }
          }
        }
      }
      collect(root)
    } catch (e) {
      console.error('[ChatService][Voice] 查找 media 数据库失败:', e)
    }

    return mediaDbFiles
  }

  /**
   * 获取单条消息
   */
  public async getMessageByLocalId(sessionId: string, localId: number): Promise<{ success: boolean; message?: Message; error?: string }> {
    const dbTablePairs = await findSessionTables(this.state, sessionId)
    const myWxid = this.state.configService.get('myWxid')
    const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

    for (const { tableName, dbPath } of dbTablePairs) {
      try {
        const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
        const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)

        let row: any
        if (hasName2IdTable && myRowId !== null) {
          row = await dbAdapter.get<any>(
            'message',
            dbPath,
            `SELECT m.*,
                    CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                    n.user_name AS sender_username
                    FROM ${tableName} m
                    LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                    WHERE m.local_id = ?`,
            [myRowId, localId]
          )
        } else if (hasName2IdTable) {
          row = await dbAdapter.get<any>(
            'message',
            dbPath,
            `SELECT m.*, n.user_name AS sender_username
                    FROM ${tableName} m
                    LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
                    WHERE m.local_id = ?`,
            [localId]
          )
        } else {
          row = await dbAdapter.get<any>(
            'message',
            dbPath,
            `SELECT * FROM ${tableName} WHERE local_id = ?`,
            [localId]
          )
        }

        if (row) {
          const content = decodeMessageContent(row.message_content, row.compress_content)
          const localType = resolveMessageLocalType(row, 1)
          const isSend = resolveRowIsSend(this.state, row, row.sender_username || null)

          let emojiCdnUrl: string | undefined
          let emojiMd5: string | undefined
          let emojiProductId: string | undefined
          let quotedContent: string | undefined
          let quotedSender: string | undefined
          let quotedImageMd5: string | undefined
          let quotedEmojiMd5: string | undefined
          let quotedEmojiCdnUrl: string | undefined
          let imageMd5: string | undefined
          let imageDatName: string | undefined
          let isLivePhoto: boolean | undefined
          let videoMd5: string | undefined
          let videoDuration: number | undefined
          let voiceDuration: number | undefined

          if (localType === 47 && content) {
            const emojiInfo = parseEmojiInfo(content)
            emojiCdnUrl = emojiInfo.cdnUrl
            emojiMd5 = emojiInfo.md5
            emojiProductId = emojiInfo.productId
          } else if (localType === 3 && content) {
            const imageInfo = parseImageInfo(content)
            imageMd5 = imageInfo.md5
            imageDatName = parseImageDatNameFromRow(row)
            isLivePhoto = imageInfo.isLivePhoto
          } else if (localType === 43 && content) {
            videoMd5 = parseVideoMd5(content)
            videoDuration = parseVideoDuration(content)
          } else if (localType === 34 && content) {
            voiceDuration = parseVoiceDuration(content)
          } else if (localType === 244813135921 || (content && content.includes('<type>57</type>'))) {
            const quoteInfo = parseQuoteMessage(content)
            quotedContent = quoteInfo.content
            quotedSender = quoteInfo.sender
            quotedImageMd5 = quoteInfo.imageMd5
            quotedEmojiMd5 = quoteInfo.emojiMd5
            quotedEmojiCdnUrl = quoteInfo.emojiCdnUrl
          }

          let fileName: string | undefined
          let fileSize: number | undefined
          let fileExt: string | undefined
          let fileMd5: string | undefined
          if (localType === 49 && content) {
            const fileInfo = parseFileInfo(content)
            fileName = fileInfo.fileName
            fileSize = fileInfo.fileSize
            fileExt = fileInfo.fileExt
            fileMd5 = fileInfo.fileMd5
          }

          let chatRecordList: ChatRecordItem[] | undefined
          if (content) {
            const xmlType = extractXmlValue(content, 'type')
            if (xmlType === '19' || localType === 49) {
              chatRecordList = parseChatHistory(content)
            }
          }

          let transferPayerUsername: string | undefined
          let transferReceiverUsername: string | undefined
          if ((localType === 49 || localType === 8589934592049) && content) {
            const xmlType = extractXmlValue(content, 'type')
            if (xmlType === '2000') {
              transferPayerUsername = extractXmlValue(content, 'payer_username') || undefined
              transferReceiverUsername = extractXmlValue(content, 'receiver_username') || undefined
            }
          }

          return {
            success: true,
            message: {
              localId: row.local_id || 0,
              serverId: row.server_id || 0,
              localType,
              createTime: row.create_time || 0,
              sortSeq: row.sort_seq || 0,
              isSend,
              senderUsername: row.sender_username || null,
              parsedContent: parseMessageContent(content, localType),
              rawContent: content,
              emojiCdnUrl,
              emojiMd5,
              productId: emojiProductId,
              quotedContent,
              quotedSender,
              quotedImageMd5,
              quotedEmojiMd5,
              quotedEmojiCdnUrl,
              imageMd5,
              imageDatName,
              isLivePhoto,
              videoMd5,
              videoDuration,
              voiceDuration,
              fileName,
              fileSize,
              fileExt,
              fileMd5,
              chatRecordList,
              transferPayerUsername,
              transferReceiverUsername
            }
          }
        }
      } catch (e) {
        // 忽略单个表查询错误
      }
    }

    return { success: false, error: 'Message not found' }
  }

  /**
   * 从指定消息库/表读取消息。
   * randomMomentService 会先在具体表中抽样；这里必须用同一张表还原，避免 local_id 跨库/跨表重复导致消息和会话错配。
   */
  public async getMessageByLocalIdFromTable(
    sessionId: string,
    localId: number,
    tableName: string,
    dbPath: string
  ): Promise<{ success: boolean; message?: Message; error?: string }> {
    try {
      const hasName2IdTable = await checkTableExists(this.state, dbPath, 'Name2Id')
      const myWxid = this.state.configService.get('myWxid')
      const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''
      const myRowId = await resolveMyRowId(this.state, dbPath, myWxid, cleanedMyWxid, hasName2IdTable)
      const qTable = quoteIdent(tableName)

      let row: any
      if (hasName2IdTable && myRowId !== null) {
        row = await dbAdapter.get<any>(
          'message',
          dbPath,
          `SELECT m.*,
                  CASE WHEN m.real_sender_id = ? THEN 1 ELSE 0 END AS computed_is_send,
                  n.user_name AS sender_username
           FROM ${qTable} m
           LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
           WHERE m.local_id = ?`,
          [myRowId, localId]
        )
      } else if (hasName2IdTable) {
        row = await dbAdapter.get<any>(
          'message',
          dbPath,
          `SELECT m.*, n.user_name AS sender_username
           FROM ${qTable} m
           LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid
           WHERE m.local_id = ?`,
          [localId]
        )
      } else {
        row = await dbAdapter.get<any>(
          'message',
          dbPath,
          `SELECT * FROM ${qTable} WHERE local_id = ?`,
          [localId]
        )
      }

      if (!row) {
        return { success: false, error: 'Message not found' }
      }

      const message = rowToMessage(this.state, row)
      if (!isMessageVisibleForSession(sessionId, message)) {
        return { success: false, error: 'Message does not belong to session' }
      }

      return { success: true, message }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取图片数据（base64）。
   * 与 WeFlow 一致，作为聊天页图片渲染的 localId 兜底通道。
   */
  async getImageData(sessionId: string, msgId: string, createTime?: number): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const localId = parseInt(msgId, 10)
      if (isNaN(localId)) {
        return { success: false, error: '无效的消息ID' }
      }

      const msgResult = await this.getMessageByLocalId(sessionId, localId)
      if (!msgResult.success || !msgResult.message) {
        return { success: false, error: '未找到消息' }
      }

      const msg = msgResult.message
      if (msg.localType !== 3) {
        return { success: false, error: '该消息不是图片' }
      }

      const payload = {
        sessionId,
        imageMd5: msg.imageMd5 || undefined,
        imageDatName: msg.imageDatName || String(msg.localId),
        createTime: createTime || msg.createTime,
        force: false
      }

      let result = await imageDecryptService.resolveCachedImage(payload)
      if (!result.success || !result.localPath) {
        result = await imageDecryptService.decryptImage(payload)
      }

      if (!result.success || !result.localPath) {
        return { success: false, error: result.error || '图片解密失败' }
      }

      if (result.localPath.startsWith('data:')) {
        const base64Data = result.localPath.split(',')[1]
        return base64Data ? { success: true, data: base64Data } : { success: false, error: '图片数据为空' }
      }

      const filePath = result.localPath.startsWith('file:')
        ? fileURLToPath(result.localPath)
        : result.localPath

      if (!fs.existsSync(filePath)) {
        return { success: false, error: '图片缓存文件不存在' }
      }

      const imageData = fs.readFileSync(filePath)
      return { success: true, data: imageData.toString('base64') }
    } catch (e) {
      console.error('ChatService: getImageData 失败:', e)
      return { success: false, error: String(e) }
    }
  }

  /**
   * 获取语音数据（解码为 WAV base64）
   * 同一秒内可能有多条语音消息，需用 serverId 精确匹配，缺失时按 rowid 顺序映射兜底
   */
  async getVoiceData(
    sessionId: string,
    msgId: string,
    createTime?: number,
    serverId?: number
  ): Promise<{ success: boolean; data?: string; error?: string }> {
    try {
      const localId = parseInt(msgId, 10)
      if (isNaN(localId)) {
        return { success: false, error: '无效的消息ID' }
      }

      // 如果未传入 createTime 或 serverId，从数据库读取
      let msgCreateTime = createTime
      let msgServerId = serverId
      if (!msgCreateTime || !msgServerId) {
        const result = await this.getMessageByLocalId(sessionId, localId)
        if (result.success && result.message) {
          if (!msgCreateTime) msgCreateTime = result.message.createTime
          if (!msgServerId) msgServerId = result.message.serverId
        }
      }

      if (!msgCreateTime) {
        return { success: false, error: '未找到消息时间戳' }
      }

      // 查找 media 数据库
      const mediaDbs = this.findMediaDbs()

      if (mediaDbs.length === 0) {
        return { success: false, error: '未找到媒体数据库' }
      }

      // 构建查找候选：sessionId, myWxid
      const candidates: string[] = []
      if (sessionId) candidates.push(sessionId)
      const myWxid = this.state.configService.get('myWxid')
      if (myWxid && !candidates.includes(myWxid)) {
        candidates.push(myWxid)
      }

      // 同时间戳冲突时使用的相对索引：在 MSG_x 中同 createTime 的所有语音消息按 local_id 升序后，当前消息所在位置
      let sameTimeIndex: number | null = null
      const getSameTimeIndex = async (): Promise<number> => {
        if (sameTimeIndex !== null) return sameTimeIndex
        try {
          const dbTablePairs = await findSessionTables(this.state, sessionId)
          const allLocalIds: number[] = []
          for (const { tableName, dbPath } of dbTablePairs) {
            try {
              const rows = await dbAdapter.all<any>(
                'message', dbPath,
                `SELECT * FROM ${tableName} WHERE create_time = ?`,
                [msgCreateTime]
              )
              for (const r of rows) {
                if (resolveMessageLocalType(r, 1) !== 34) continue
                const lid = coerceRowNumber(getRowField(r, ['local_id', 'localId', 'id', 'ID']), 0)
                if (lid > 0) allLocalIds.push(lid)
              }
            } catch { }
          }
          const uniqueSorted = Array.from(new Set(allLocalIds)).sort((a, b) => a - b)
          const idx = uniqueSorted.indexOf(localId)
          sameTimeIndex = idx >= 0 ? idx : 0
        } catch {
          sameTimeIndex = 0
        }
        return sameTimeIndex
      }

      // 在 media 数据库中查找语音数据
      let silkData: Buffer | null = null

      for (const dbPath of mediaDbs) {
        try {
          // 查找 VoiceInfo 表
          const tables = await dbAdapter.all<any>(
            'message',
            dbPath,
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'VoiceInfo%'"
          )

          if (tables.length === 0) {
            continue
          }

          const voiceTable = tables[0].name

          // 获取表结构
          const columns = await dbAdapter.all<any>('message', dbPath, `PRAGMA table_info('${voiceTable}')`)
          const columnNames = columns.map((c: any) => c.name.toLowerCase())

          // 找到数据列
          const dataColumn = columnNames.find((c: string) =>
            c === 'voice_data' || c === 'buf' || c === 'voicebuf' || c === 'data'
          )
          if (!dataColumn) {
            continue
          }

          // 找到 chat_name_id 列
          const chatNameIdColumn = columnNames.find((c: string) =>
            c === 'chat_name_id' || c === 'chatnameid' || c === 'chat_nameid'
          )

          // 找到时间列
          const timeColumn = columnNames.find((c: string) =>
            c === 'create_time' || c === 'createtime' || c === 'time'
          )

          // 找到 svr_id 列（用于精确匹配，避免同时间戳冲突）
          const svrIdColumn = columnNames.find((c: string) =>
            c === 'msg_svr_id' || c === 'msgsvrid' || c === 'svr_id' || c === 'svrid' ||
            c === 'server_id' || c === 'serverid'
          )

          // 查找 Name2Id 表
          const name2IdTables = await dbAdapter.all<any>(
            'message',
            dbPath,
            "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Name2Id%'"
          )
          const name2IdTable = name2IdTables.length > 0 ? name2IdTables[0].name : null

          // 策略 A: 用 svr_id 精确匹配（同时间戳消息也能区分）
          if (svrIdColumn && msgServerId && msgServerId > 0) {
            if (chatNameIdColumn && name2IdTable) {
              for (const candidate of candidates) {
                const n2i = await dbAdapter.get<any>(
                  'message', dbPath,
                  `SELECT rowid FROM ${name2IdTable} WHERE user_name = ?`,
                  [candidate]
                )
                if (!n2i?.rowid) continue
                const sql = `SELECT ${dataColumn} AS data FROM ${voiceTable} WHERE ${chatNameIdColumn} = ? AND ${svrIdColumn} = ? LIMIT 1`
                const row = await dbAdapter.get<any>('message', dbPath, sql, [n2i.rowid, msgServerId])
                if (row?.data) {
                  silkData = this.decodeVoiceBlob(row.data)
                  if (silkData) break
                }
              }
            }
            if (!silkData) {
              const sql = `SELECT ${dataColumn} AS data FROM ${voiceTable} WHERE ${svrIdColumn} = ? LIMIT 1`
              const row = await dbAdapter.get<any>('message', dbPath, sql, [msgServerId])
              if (row?.data) {
                silkData = this.decodeVoiceBlob(row.data)
              }
            }
          }

          // 策略 B: chat_name_id + create_time 按 rowid 顺序映射（兼容无 svr_id 列的旧表）
          if (!silkData && chatNameIdColumn && timeColumn && name2IdTable) {
            for (const candidate of candidates) {
              const name2IdRow = await dbAdapter.get<any>(
                'message',
                dbPath,
                `SELECT rowid FROM ${name2IdTable} WHERE user_name = ?`,
                [candidate]
              )

              if (!name2IdRow?.rowid) {
                continue
              }

              const chatNameId = name2IdRow.rowid

              const rows = await dbAdapter.all<any>(
                'message', dbPath,
                `SELECT ${dataColumn} AS data FROM ${voiceTable} WHERE ${chatNameIdColumn} = ? AND ${timeColumn} = ? ORDER BY rowid ASC`,
                [chatNameId, msgCreateTime]
              )

              if (rows.length === 0) continue
              if (rows.length === 1) {
                silkData = this.decodeVoiceBlob(rows[0].data)
                if (silkData) break
                continue
              }
              const idx = await getSameTimeIndex()
              const pick = rows[Math.min(idx, rows.length - 1)]
              if (pick?.data) {
                silkData = this.decodeVoiceBlob(pick.data)
                if (silkData) break
              }
            }
          }

          // 策略 C: 仅 create_time 兜底，同样按 rowid 顺序处理多条
          if (!silkData && timeColumn) {
            const rows = await dbAdapter.all<any>(
              'message', dbPath,
              `SELECT ${dataColumn} AS data FROM ${voiceTable} WHERE ${timeColumn} = ? ORDER BY rowid ASC`,
              [msgCreateTime]
            )
            if (rows.length === 1) {
              silkData = this.decodeVoiceBlob(rows[0].data)
            } else if (rows.length > 1) {
              const idx = await getSameTimeIndex()
              const pick = rows[Math.min(idx, rows.length - 1)]
              if (pick?.data) silkData = this.decodeVoiceBlob(pick.data)
            }
          }

          if (silkData) break
        } catch (e) {
          // 忽略单个数据库打开失败
        }
      }

      if (!silkData) {
        return { success: false, error: '未找到语音数据' }
      }

      // 使用 silk-wasm 解码
      try {
        const pcmData = await this.decodeSilkToPcm(silkData, 24000)
        if (!pcmData) {
          return { success: false, error: 'Silk 解码失败' }
        }

        // PCM -> WAV
        const wavData = this.createWavBuffer(pcmData, 24000)

        return { success: true, data: wavData.toString('base64') }
      } catch (e) {
        return { success: false, error: '语音解码失败: ' + String(e) }
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /**
   * 解码语音 Blob 数据
   */
  private decodeVoiceBlob(raw: any): Buffer | null {
    if (!raw) return null
    if (Buffer.isBuffer(raw)) return raw
    if (raw instanceof Uint8Array) return Buffer.from(raw)
    if (Array.isArray(raw)) return Buffer.from(raw)
    if (typeof raw === 'string') {
      const trimmed = raw.trim()
      // 尝试 hex 解码
      if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
        try {
          return Buffer.from(trimmed, 'hex')
        } catch { }
      }
      // 尝试 base64 解码
      try {
        return Buffer.from(trimmed, 'base64')
      } catch { }
    }
    if (typeof raw === 'object' && Array.isArray(raw.data)) {
      return Buffer.from(raw.data)
    }
    return null
  }

  /**
   * 解码 Silk 数据为 PCM
   * 使用 silk-wasm（纯 JS/WASM）
   */
  private async decodeSilkToPcm(silkData: Buffer, sampleRate: number): Promise<Buffer | null> {
    try {
      // 找到 silk-wasm 的 WASM 文件
      let wasmPath: string

      if (isElectronPackaged()) {
        // 打包后，WASM 文件在 app.asar.unpacked 中
        wasmPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
        if (!fs.existsSync(wasmPath)) {
          wasmPath = path.join(process.resourcesPath, 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
        }
      } else {
        // 开发环境
        wasmPath = path.join(getAppPath(), 'node_modules', 'silk-wasm', 'lib', 'silk.wasm')
      }

      if (!fs.existsSync(wasmPath)) {
        return null
      }

      const silkWasm = require('silk-wasm')
      const result = await silkWasm.decode(silkData, sampleRate)

      return Buffer.from(result.data)
    } catch (e) {
      return null
    }
  }


  /**
   * 创建 WAV 文件 Buffer
   */
  private createWavBuffer(pcmData: Buffer, sampleRate: number = 24000, channels: number = 1): Buffer {
    const pcmLength = pcmData.length
    const header = Buffer.alloc(44)

    // RIFF header
    header.write('RIFF', 0)
    header.writeUInt32LE(36 + pcmLength, 4)
    header.write('WAVE', 8)

    // fmt chunk
    header.write('fmt ', 12)
    header.writeUInt32LE(16, 16)           // chunk size
    header.writeUInt16LE(1, 20)            // audio format (PCM)
    header.writeUInt16LE(channels, 22)     // channels
    header.writeUInt32LE(sampleRate, 24)   // sample rate
    header.writeUInt32LE(sampleRate * channels * 2, 28)  // byte rate
    header.writeUInt16LE(channels * 2, 32) // block align
    header.writeUInt16LE(16, 34)           // bits per sample

    // data chunk
    header.write('data', 36)
    header.writeUInt32LE(pcmLength, 40)

    return Buffer.concat([header, pcmData])
  }

  /**
   * 启动自动增量同步（保留签名作为 no-op；实时同步已迁移到 monitorBridge）
   */
  startAutoSync(_intervalMs = 5000) {
    // no-op，等待 monitorBridge 推送
  }

  /**
   * 停止自动同步（保留签名作为 no-op）
   */
  stopAutoSync() {
    // no-op
  }

  /**
   * 检查数据库是否有更新（保留签名作为 no-op；真正的变更来自 monitorBridge）
   */
  async checkUpdates(_force: boolean = false) {
    // no-op
  }

  /**
   * 检查当前会话的新消息并推送（保留签名作为 no-op；真正的增量推送走 monitorBridge）
   */
  private async checkNewMessagesForCurrentSession(): Promise<void> {
    // no-op；等待 wcdb monitor 推送变更后再由 attachMonitor 处理
  }

  /**
   * 解析会话对应的消息表路径（可能跨多个 .db），供 randomMomentService 等模块使用。
   */
  public async getSessionMessageTables(sessionId: string): Promise<{ tableName: string; dbPath: string }[]> {
    return findSessionTables(this.state, sessionId)
  }
}

export const chatService = new ChatService()
