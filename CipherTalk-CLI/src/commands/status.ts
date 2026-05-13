import type { Command } from 'commander'
import { runCommand, type CommandContext } from '../commandRunner.js'
import { startInteractiveShell } from '../interactiveShell.js'
import type { GlobalCliOptions } from '../types.js'

export function registerStatusCommand(program: Command, context: CommandContext): void {
  const status = program
    .command('status')
    .description('检查配置和数据库连接状态')
    .action(async () => {
      await runCommand(status, context, async (config) => {
        const data = await context.services.data.getStatus(config)
        return { data }
      })

      const globalOptions = status.optsWithGlobals() as GlobalCliOptions
      const shouldEnterShell = context.interactive && !globalOptions.quiet && !globalOptions.format
      if (shouldEnterShell) {
        await startInteractiveShell(context, globalOptions)
      }
    })
}
