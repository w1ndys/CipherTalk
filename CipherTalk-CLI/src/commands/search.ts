import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerSearchCommand(program: Command, context: CommandContext): void {
  const search = program
    .command('search')
    .argument('<keyword>', 'keyword')
    .description('全文搜索')
    .option('--session <session>', '限定会话')
    .option('--from <datetime>', '开始时间')
    .option('--to <datetime>', '结束时间')
    .action(async (_keyword: string) => {
      await runCommand(search, context, async () => context.services.advanced.search())
    })
}
