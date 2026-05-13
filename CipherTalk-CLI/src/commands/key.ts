import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerKeyCommand(program: Command, context: CommandContext): void {
  const key = program.command('key').description('密钥管理')

  const set = key
    .command('set')
    .argument('<hex>', '64 位十六进制密钥')
    .description('保存密钥到 ~/.miyu/config.json')
    .action(async (hex: string) => {
      await runCommand(set, context, async () => {
        const result = await context.services.key.setKey(hex)
        return { data: result }
      })
    })

  const test = key
    .command('test')
    .description('测试当前密钥格式和连接')
    .action(async () => {
      await runCommand(test, context, async (config) => {
        const result = await context.services.key.testKey(config)
        return { data: result }
      })
    })

  const get = key
    .command('get')
    .description('从微信进程提取密钥')
    .action(async () => {
      await runCommand(get, context, async (config) => {
        const result = await context.services.key.getKey(config)
        return { data: result }
      })
    })
}
