import * as readline from 'node:readline'
import { parseLimit, resolveRuntimeConfig } from './config.js'
import { errorEnvelope, successEnvelope, writeEnvelope } from './output.js'
import type { CommandContext } from './commandRunner.js'
import type { GlobalCliOptions, OutputFormat, RuntimeConfig } from './types.js'

export interface InteractiveCommand {
  name: string
  usage: string
  description: string
}

const COMMANDS: InteractiveCommand[] = [
  { name: '/status', usage: '/status', description: '检查配置和数据库连接状态' },
  { name: '/sessions', usage: '/sessions [--limit 20] [--type private|group|mp]', description: '列出会话' },
  { name: '/messages', usage: '/messages <会话> [--limit 50] [--cursor n]', description: '查询会话消息' },
  { name: '/contacts', usage: '/contacts [--limit 50] [--type friend|group|mp]', description: '列出联系人' },
  { name: '/contact', usage: '/contact <wxid或名称>', description: '查看联系人详情' },
  { name: '/key', usage: '/key get|test|set <hex>', description: '密钥管理' },
  { name: '/search', usage: '/search <关键词>', description: '全文搜索' },
  { name: '/stats', usage: '/stats global|contacts|time|session|keywords|group', description: '统计分析' },
  { name: '/export', usage: '/export <会话> [--output path]', description: '导出聊天数据' },
  { name: '/moments', usage: '/moments [--limit 20]', description: '朋友圈数据' },
  { name: '/report', usage: '/report [--year 2025|--all-time]', description: '年度报告数据' },
  { name: '/mcp', usage: '/mcp serve', description: '独立 MCP Server 模式' },
  { name: '/help', usage: '/help', description: '显示命令列表' },
  { name: '/exit', usage: '/exit', description: '退出交互模式' }
]

type ParsedInteractiveInput = { command: string; args: string[] }

type ParsedOptions = {
  options: Record<string, string | boolean>
  positional: string[]
}

export function getInteractiveCommands(): InteractiveCommand[] {
  return [...COMMANDS]
}

export function parseSlashInput(input: string): ParsedInteractiveInput {
  const tokens = splitArgs(input.trim())
  const command = tokens[0] || ''
  return { command, args: tokens.slice(1) }
}

function splitArgs(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let escaping = false

  for (const char of input) {
    if (escaping) {
      current += char
      escaping = false
      continue
    }
    if (char === '\\') {
      escaping = true
      continue
    }
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }

  if (current) tokens.push(current)
  return tokens
}

function parseOptions(args: string[]): ParsedOptions {
  const options: Record<string, string | boolean> = {}
  const positional: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }

    const [rawName, inlineValue] = token.slice(2).split(/=(.*)/s, 2)
    if (inlineValue !== undefined) {
      options[rawName] = inlineValue
      continue
    }

    const next = args[index + 1]
    if (next && !next.startsWith('--')) {
      options[rawName] = next
      index += 1
    } else {
      options[rawName] = true
    }
  }

  return { options, positional }
}

function showCommandList(): string {
  const width = Math.max(...COMMANDS.map((command) => command.usage.length))
  return [
    '可用命令：',
    ...COMMANDS.map((command) => `  ${command.usage.padEnd(width)}  ${command.description}`)
  ].join('\n')
}

function shellFormat(config: RuntimeConfig): OutputFormat {
  return config.defaultFormat
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function commandLimit(options: Record<string, string | boolean>, fallback: number): number {
  return parseLimit(asString(options.limit), fallback)
}

async function runShellCommand(line: string, context: CommandContext, globals: GlobalCliOptions): Promise<boolean> {
  const parsed = parseSlashInput(line)
  if (!parsed.command) return true
  if (!parsed.command.startsWith('/')) {
    context.output.stderr('交互模式命令需要以 / 开头，例如 /status。')
    return true
  }

  const { options, positional } = parseOptions(parsed.args)
  const config = resolveRuntimeConfig({ ...globals, limit: asString(options.limit) || globals.limit })
  const format = shellFormat(config)

  try {
    switch (parsed.command) {
      case '/':
      case '/help':
        context.output.stdout(showCommandList())
        return true
      case '/exit':
      case '/quit':
        return false
      case '/status': {
        const data = await context.services.data.getStatus(config)
        writeEnvelope(context.output, successEnvelope(data), format)
        return true
      }
      case '/sessions': {
        const limit = commandLimit(options, config.defaultLimit)
        const result = await context.services.data.listSessions(config, {
          limit,
          type: asString(options.type)
        })
        writeEnvelope(context.output, successEnvelope({ sessions: result.sessions }, { total: result.sessions.length, limit, hasMore: result.hasMore }), format)
        return true
      }
      case '/messages': {
        const session = positional[0]
        if (!session) throw new Error('用法: /messages <会话> [--limit 50]')
        const limit = commandLimit(options, config.defaultLimit)
        const result = await context.services.data.getMessages(config, session, {
          limit,
          cursor: asString(options.cursor),
          direction: asString(options.direction),
          type: asString(options.type),
          from: asString(options.from),
          to: asString(options.to)
        })
        writeEnvelope(context.output, successEnvelope({ messages: result.messages }, { total: result.messages.length, limit, cursor: result.cursor }), format)
        return true
      }
      case '/contacts': {
        const limit = commandLimit(options, config.defaultLimit)
        const result = await context.services.data.listContacts(config, {
          limit,
          type: asString(options.type)
        })
        writeEnvelope(context.output, successEnvelope({ contacts: result.contacts }, { total: result.contacts.length, limit }), format)
        return true
      }
      case '/contact': {
        const contact = positional[0]
        if (!contact) throw new Error('用法: /contact <wxid或名称>')
        const data = await context.services.data.getContactInfo(config, contact)
        writeEnvelope(context.output, successEnvelope({ contact: data }, { total: data ? 1 : 0 }), format)
        return true
      }
      case '/key': {
        const action = positional[0]
        if (action === 'set') {
          const hex = positional[1]
          if (!hex) throw new Error('用法: /key set <hex>')
          writeEnvelope(context.output, successEnvelope(await context.services.key.setKey(hex)), format)
          return true
        }
        if (action === 'test') {
          writeEnvelope(context.output, successEnvelope(await context.services.key.testKey(config)), format)
          return true
        }
        if (action === 'get') {
          writeEnvelope(context.output, successEnvelope(await context.services.key.getKey(config)), format)
          return true
        }
        throw new Error('用法: /key get|test|set <hex>')
      }
      case '/search':
        await context.services.advanced.search()
        return true
      case '/stats':
        await context.services.advanced.stats()
        return true
      case '/export':
        await context.services.advanced.exportChat()
        return true
      case '/moments':
        await context.services.advanced.moments()
        return true
      case '/report':
        await context.services.advanced.report()
        return true
      case '/mcp':
        if (positional[0] === 'serve') {
          await context.services.advanced.mcpServe()
          return true
        }
        throw new Error('用法: /mcp serve')
      default:
        context.output.stderr(`未知命令: ${parsed.command}\n输入 / 查看所有命令。`)
        return true
    }
  } catch (error) {
    writeEnvelope(context.output, errorEnvelope(error), format)
    return true
  }
}

export async function startInteractiveShell(context: CommandContext, globals: GlobalCliOptions): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return

  const input = process.stdin
  const output = process.stdout
  const prompt = 'miyu> '
  let buffer = ''
  let closed = false

  readline.emitKeypressEvents(input)
  input.setRawMode?.(true)
  input.resume()

  const render = () => {
    readline.clearLine(output, 0)
    readline.cursorTo(output, 0)
    output.write(`${prompt}${buffer}`)
  }

  const printList = () => {
    output.write(`\n${showCommandList()}\n`)
    render()
  }

  output.write('\n已进入 miyu 交互模式。输入 / 自动显示命令，输入 /exit 退出。\n')
  render()

  await new Promise<void>((resolve) => {
    const close = () => {
      if (closed) return
      closed = true
      input.off('keypress', onKeypress)
      input.setRawMode?.(false)
      output.write('\n')
      resolve()
    }

    const execute = async () => {
      const line = buffer.trim()
      buffer = ''
      output.write('\n')
      input.setRawMode?.(false)
      const shouldContinue = await runShellCommand(line, context, globals)
      if (!shouldContinue) {
        close()
        return
      }
      input.setRawMode?.(true)
      render()
    }

    const onKeypress = (char: string, key: readline.Key) => {
      if (key.ctrl && key.name === 'c') {
        close()
        return
      }
      if (key.name === 'return' || key.name === 'enter') {
        void execute()
        return
      }
      if (key.name === 'backspace') {
        buffer = buffer.slice(0, -1)
        render()
        return
      }
      if (key.name === 'tab') {
        printList()
        return
      }
      if (key.name === 'escape') return
      if (!char) return

      buffer += char
      render()
      if (buffer === '/') printList()
    }

    input.on('keypress', onKeypress)
  })
}
