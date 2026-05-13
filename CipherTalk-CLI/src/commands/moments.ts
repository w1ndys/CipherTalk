import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerMomentsCommand(program: Command, context: CommandContext): void {
  const moments = program
    .command('moments')
    .description('朋友圈数据')
    .option('--from <date>', '开始日期')
    .option('--to <date>', '结束日期')
    .action(async () => {
      await runCommand(moments, context, async () => context.services.advanced.moments())
    })
}
