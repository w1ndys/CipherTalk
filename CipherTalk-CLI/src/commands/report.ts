import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerReportCommand(program: Command, context: CommandContext): void {
  const report = program
    .command('report')
    .description('年度报告数据')
    .option('--year <year>', '年份')
    .option('--all-time', '全时间范围')
    .action(async () => {
      await runCommand(report, context, async () => context.services.advanced.report())
    })
}
