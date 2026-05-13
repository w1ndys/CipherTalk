import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerStatsCommand(program: Command, context: CommandContext): void {
  const stats = program.command('stats').description('统计分析')
  const runStats = async (command: Command) => runCommand(command, context, async () => context.services.advanced.stats())

  const global = stats.command('global').description('全局统计').option('--from <datetime>').option('--to <datetime>').action(async () => runStats(global))
  const contacts = stats.command('contacts').description('联系人排名').option('--top <n>').option('--year <year>').action(async () => runStats(contacts))
  const time = stats.command('time').description('时间分布').option('--by <unit>').action(async () => runStats(time))
  const session = stats.command('session').argument('<session>').description('会话统计').action(async () => runStats(session))
  const keywords = stats.command('keywords').argument('<session>').description('关键词频率').option('--top <n>').action(async () => runStats(keywords))
  const group = stats.command('group').argument('<group>').description('群聊统计').action(async () => runStats(group))
}
