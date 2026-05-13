import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { invalidArgument, notImplemented } from '../errors.js'
import { patchConfig } from '../config.js'
import { getPlatformNativeDir } from '../runtimePaths.js'
import { dataService } from './dataService.js'
import type { KeyService } from './types.js'
import type { RuntimeConfig } from '../types.js'

function assertHexKey(hex: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw invalidArgument('key 必须是 64 位十六进制字符串')
  }
}

export class LocalKeyService implements KeyService {
  async setKey(hex: string): Promise<{ saved: boolean; keyHex: string }> {
    assertHexKey(hex)
    patchConfig({ keyHex: hex.toLowerCase() })
    return { saved: true, keyHex: hex.toLowerCase() }
  }

  async testKey(config: RuntimeConfig): Promise<{ validFormat: boolean; connection?: { attempted: boolean; ok: boolean; sessionCount?: number; error?: string } }> {
    if (config.keyHex) assertHexKey(config.keyHex)
    const status = await dataService.getStatus(config)
    return { validFormat: Boolean(config.keyHex), connection: status.connection }
  }

  async getKey(_config: RuntimeConfig): Promise<{ keyHex: string }> {
    const dllPath = join(getPlatformNativeDir(), process.platform === 'darwin' ? 'libwx_key.dylib' : 'wx_key.dll')
    if (!existsSync(dllPath)) {
      throw notImplemented(`key get native bridge (${dllPath})`)
    }

    if (process.platform === 'win32') {
      try {
        execFileSync('tasklist', ['/FI', 'IMAGENAME eq Weixin.exe', '/NH'], { encoding: 'utf8' })
      } catch {
        throw invalidArgument('无法检查微信进程状态')
      }
    }

    throw notImplemented('key get')
  }
}

export const keyService = new LocalKeyService()
