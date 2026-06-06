/**
 * query_sql —— 【高级·只读】让 AI 自己写 SQL 查原微信库，覆盖结构化工具够不到的灵活查询。
 *
 * 安全红线：原微信库是不可恢复的真实数据。本工具强制只读——只放行单条 SELECT/WITH/EXPLAIN/PRAGMA table_info，
 * 任何写入/DDL/事务语句一律拒绝（execute 前静态校验）。读经 wcdb 代理转发到主进程。
 */
import { tool } from 'ai'
import { z } from 'zod'

const READ_ONLY_HEAD = /^(select|with|explain)\b/i
const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|replace|attach|detach|vacuum|reindex|truncate|begin|commit|rollback|pragma)\b/i

/** 校验为单条只读语句，返回去掉尾分号的 SQL；不合规抛错。 */
function assertReadOnly(sql: string): string {
  const s = String(sql || '').trim().replace(/;\s*$/, '')
  if (!s) throw new Error('SQL 为空')
  if (s.includes(';')) throw new Error('只允许单条语句（不要用分号拼多条）')
  const isPragmaInfo = /^pragma\s+(table_info|table_xinfo|table_list)\b/i.test(s)
  if (!READ_ONLY_HEAD.test(s) && !isPragmaInfo) {
    throw new Error('只允许只读查询：SELECT / WITH / EXPLAIN / PRAGMA table_info')
  }
  // PRAGMA table_info 已单独放行；其余 PRAGMA 及一切写入/DDL/事务关键字拒绝
  if (!isPragmaInfo && FORBIDDEN.test(s)) {
    throw new Error('禁止写入 / DDL / 事务 / 其它 PRAGMA 语句')
  }
  return s
}

/** 防止把头像/图片等大字段或二进制塞爆上下文。 */
function sanitizeCell(value: unknown): unknown {
  if (value == null) return value
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return '[blob]'
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`
  return value
}

export const querySql = tool({
  description:
    '【高级·只读】直接对原微信库跑你自己写的 SQL，用于结构化工具覆盖不到的灵活查询。' +
    '仅允许单条只读 SELECT / WITH / EXPLAIN / PRAGMA table_info；写入/DDL 会被直接拒绝。\n' +
    'kind 选库：\n' +
    '- contact：联系人/群。表 contact(username,remark,nick_name,alias,…)、chatroom_member(room_id,member_id)、name2id(rowid,username)。\n' +
    '- session：会话表 SessionTable(username,sort_timestamp,last_timestamp,…)；群 username 以 @chatroom 结尾。\n' +
    '- message：聊天正文，按库分片，需传 dbPath；表名形如 msg_<hash>，列含 local_type/create_time/is_send/real_sender_id；群发送者经 Name2Id(rowid,user_name) 映射 real_sender_id。\n' +
    "探索结构：SELECT name FROM sqlite_master WHERE type='table'，或 PRAGMA table_info(\"表名\")。" +
    '别 SELECT 头像/图片等大字段。优先用结构化工具，本工具留给特殊查询。',
  inputSchema: z.object({
    kind: z.enum(['contact', 'session', 'message']).describe('目标库'),
    sql: z.string().describe('单条只读 SQL'),
    dbPath: z.string().optional().describe("kind='message' 时指定分片库的绝对路径；不传会返回可用 dbPath 列表"),
    params: z.array(z.union([z.string(), z.number(), z.null()])).optional().describe('SQL 中 ? 占位对应的参数值'),
    limit: z.number().int().min(1).max(1000).default(100).describe('返回行数上限'),
  }),
  execute: async ({ kind, sql, dbPath, params, limit }) => {
    try {
      const safe = assertReadOnly(sql)
      const { dbAdapter } = await import('../../dbAdapter')

      let path = ''
      if (kind === 'message') {
        if (!dbPath) {
          const { findMessageDbPaths } = await import('../../dbStoragePaths')
          return { error: "kind='message' 需要 dbPath，请从下列任选", availableDbPaths: findMessageDbPaths() }
        }
        path = dbPath
      }

      const rows = await dbAdapter.all<Record<string, unknown>>(kind, path, safe, params || [])
      const limited = rows.slice(0, limit).map((row) => {
        const out: Record<string, unknown> = {}
        for (const key of Object.keys(row)) out[key] = sanitizeCell(row[key])
        return out
      })
      return { rowCount: rows.length, truncated: rows.length > limit, rows: limited }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  },
})
