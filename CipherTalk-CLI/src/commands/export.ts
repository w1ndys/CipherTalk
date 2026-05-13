import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerExportCommand(program: Command, context: CommandContext): void {
  const exportCommand = program
    .command('export')
    .argument('[session]', 'session id or name')
    .description('导出聊天数据')
    .option('--all', '导出全部会话')
    .option('--output <path>', '输出目录或文件')
    .option('--from <datetime>', '开始时间')
    .option('--to <datetime>', '结束时间')
    .option('--with-media', '同步导出媒体')
    .action(async (_session: string | undefined) => {
      await runCommand(exportCommand, context, async () => context.services.advanced.exportChat())
    })
}
