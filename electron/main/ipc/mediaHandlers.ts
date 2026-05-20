import { ipcMain } from 'electron'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { readFile } from 'fs/promises'
import { basename, dirname, join } from 'path'
import crypto from 'crypto'
import { imageDecryptService } from '../../services/imageDecryptService'
import { imageKeyService } from '../../services/imageKeyService'
import { videoService } from '../../services/videoService'
import { wxKeyService } from '../../services/wxKeyService'
import { wxKeyServiceMac } from '../../services/wxKeyServiceMac'
import type { MainProcessContext } from '../context'

type DllImageKeyAccount = {
  wxid?: string
  keys?: Array<{ code?: number | string } | number | string>
}

type DllImageKeySelection = {
  success: true
  xorKey: number
  aesKey: string
  wxid: string
  code: number
  verified: boolean
  validationAvailable: boolean
  targetWxids: string[]
  matchedWxids: string[]
  accountCount: number
  codeCount: number
} | {
  success: false
  reason: string
  validationAvailable: boolean
  targetWxids: string[]
  matchedWxids: string[]
  accountCount: number
  codeCount: number
}

const IMAGE_TEMPLATE_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07])

function normalizeAccountId(value?: string): string {
  const trimmed = String(value || '').trim()
  if (!trimmed) return ''

  if (trimmed.toLowerCase().startsWith('wxid_')) {
    const match = trimmed.match(/^(wxid_[^_]+)/i)
    return match?.[1] || trimmed
  }

  const suffixMatch = trimmed.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return suffixMatch ? suffixMatch[1] : trimmed
}

function isIgnoredAccountName(value: string): boolean {
  const lowered = value.trim().toLowerCase()
  return !lowered ||
    lowered === 'xwechat_files' ||
    lowered === 'wechat files' ||
    lowered === 'all_users' ||
    lowered === 'backup' ||
    lowered === 'wmpf' ||
    lowered === 'app_data' ||
    lowered === 'filestorage' ||
    lowered === 'image' ||
    lowered === 'image2' ||
    lowered === 'msg' ||
    lowered === 'db_storage'
}

function isReasonableAccountId(value?: string): boolean {
  const trimmed = String(value || '').trim()
  if (!trimmed) return false
  if (trimmed.includes('/') || trimmed.includes('\\')) return false
  return !isIgnoredAccountName(trimmed)
}

function pushAccountIdCandidate(candidates: string[], value?: string): void {
  const raw = String(value || '').trim()
  if (!isReasonableAccountId(raw)) return

  const pushUnique = (item: string) => {
    const trimmed = item.trim()
    if (!trimmed || candidates.includes(trimmed)) return
    candidates.push(trimmed)
  }

  pushUnique(raw)
  const normalized = normalizeAccountId(raw)
  if (normalized && normalized !== raw && isReasonableAccountId(normalized)) {
    pushUnique(normalized)
  }
}

function collectTargetWxids(userDir: string): string[] {
  const candidates: string[] = []
  let cursor = String(userDir || '').replace(/[\\/]+$/, '')

  for (let i = 0; cursor && i < 5; i++) {
    pushAccountIdCandidate(candidates, basename(cursor))
    const next = dirname(cursor)
    if (!next || next === cursor) break
    cursor = next
  }

  return candidates
}

function isImageKeyAccountDirPath(dirPath: string): boolean {
  return existsSync(join(dirPath, 'FileStorage', 'Image')) ||
    existsSync(join(dirPath, 'FileStorage', 'Image2')) ||
    existsSync(join(dirPath, 'msg', 'attach')) ||
    existsSync(join(dirPath, 'db_storage'))
}

function resolveImageKeyUserDir(userDir: string): string {
  const normalized = String(userDir || '').trim().replace(/[\\/]+$/, '')
  if (!normalized) return userDir
  if (existsSync(normalized)) return normalized

  const targetWxids = collectTargetWxids(normalized)
  const targetLower = targetWxids.map(wxid => normalizeAccountId(wxid).toLowerCase()).filter(Boolean)
  const parent = dirname(normalized)
  if (!parent || parent === normalized || !existsSync(parent)) return normalized

  const parentName = normalizeAccountId(basename(parent)).toLowerCase()
  if (targetLower.includes(parentName) && isImageKeyAccountDirPath(parent)) {
    return parent
  }

  try {
    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const normalizedEntry = normalizeAccountId(entry.name).toLowerCase()
      if (!targetLower.includes(normalizedEntry)) continue
      const candidate = join(parent, entry.name)
      if (isImageKeyAccountDirPath(candidate)) return candidate
    }
  } catch {
    // ignore
  }

  return normalized
}

function sameAccountId(left?: string, right?: string): boolean {
  const normalizedLeft = normalizeAccountId(left).toLowerCase()
  const normalizedRight = normalizeAccountId(right).toLowerCase()
  return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight)
}

function getDllAccountCodes(account: DllImageKeyAccount): number[] {
  const keys = Array.isArray(account.keys) ? account.keys : []
  const codes: number[] = []

  for (const item of keys) {
    const rawCode = typeof item === 'object' && item !== null ? item.code : item
    const code = Number(rawCode)
    if (!Number.isFinite(code) || code < 0) continue
    if (!codes.includes(code)) codes.push(code)
  }

  return codes
}

function findTemplateCiphertext(userDir: string, limit = 64): Buffer | null {
  const rootDir = String(userDir || '').trim()
  if (!rootDir || !existsSync(rootDir)) return null

  const files: string[] = []
  const stack = [rootDir]

  while (stack.length && files.length < limit) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (files.length >= limit) break
      const fullPath = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && entry.name.endsWith('_t.dat')) {
        files.push(fullPath)
      }
    }
  }

  files.sort((a, b) => {
    try {
      return statSync(b).mtimeMs - statSync(a).mtimeMs
    } catch {
      return 0
    }
  })

  for (const file of files) {
    try {
      const data = readFileSync(file)
      if (data.length >= 0x1F && data.subarray(0, 6).equals(IMAGE_TEMPLATE_MAGIC)) {
        return data.subarray(0x0F, 0x1F)
      }
    } catch {
      // ignore unreadable cache files
    }
  }

  return null
}

function isLikelyImageHeader(data: Buffer): boolean {
  return (
    (data[0] === 0xFF && data[1] === 0xD8 && data[2] === 0xFF) ||
    (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4E && data[3] === 0x47) ||
    (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) ||
    (data[0] === 0x77 && data[1] === 0x78 && data[2] === 0x67 && data[3] === 0x66) ||
    (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46)
  )
}

function verifyDerivedAesKey(aesKey: string, ciphertext: Buffer): boolean {
  try {
    const keyBytes = Buffer.from(aesKey, 'ascii').subarray(0, 16)
    const decipher = crypto.createDecipheriv('aes-128-ecb', keyBytes, null)
    decipher.setAutoPadding(false)
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return isLikelyImageHeader(decrypted)
  } catch {
    return false
  }
}

function deriveDllImageKeys(code: number, wxid: string): { xorKey: number; aesKey: string } {
  const cleanedWxid = normalizeAccountId(wxid)
  const xorKey = code & 0xFF
  const aesKey = crypto.createHash('md5').update(code.toString() + cleanedWxid).digest('hex').substring(0, 16)
  return { xorKey, aesKey }
}

function collectDerivationWxids(account: DllImageKeyAccount, targetWxids: string[], includeTargets: boolean): string[] {
  const wxids: string[] = []

  if (includeTargets) {
    for (const wxid of targetWxids) {
      pushAccountIdCandidate(wxids, wxid)
    }
  }

  pushAccountIdCandidate(wxids, account.wxid)
  return wxids
}

function selectDllImageKey(accounts: DllImageKeyAccount[], userDir: string): DllImageKeySelection {
  const resolvedUserDir = resolveImageKeyUserDir(userDir)
  const accountsWithCodes = accounts.filter(account => getDllAccountCodes(account).length > 0)
  const targetWxids = collectTargetWxids(userDir)
  const matchedAccounts = accountsWithCodes.filter(account =>
    targetWxids.some(targetWxid => sameAccountId(account.wxid, targetWxid))
  )
  const matchedWxids = matchedAccounts.map(account => account.wxid).filter((wxid): wxid is string => Boolean(wxid))
  const matchedSet = new Set(matchedAccounts)
  const orderedAccounts = [
    ...matchedAccounts,
    ...accountsWithCodes.filter(account => !matchedSet.has(account))
  ]
  const codeCount = accountsWithCodes.reduce((total, account) => total + getDllAccountCodes(account).length, 0)
  const ciphertext = findTemplateCiphertext(resolvedUserDir)
  const validationAvailable = Boolean(ciphertext)
  const base = {
    validationAvailable,
    targetWxids,
    matchedWxids,
    accountCount: accounts.length,
    codeCount
  }
  const fail = (reason: string): DllImageKeySelection => ({ success: false, reason, ...base })

  if (!accountsWithCodes.length) {
    return fail('DLL 未返回有效密钥码')
  }

  if (ciphertext) {
    for (const account of orderedAccounts) {
      const wxids = collectDerivationWxids(account, targetWxids, targetWxids.length > 0)
      for (const wxid of wxids) {
        for (const code of getDllAccountCodes(account)) {
          const { xorKey, aesKey } = deriveDllImageKeys(code, wxid)
          if (!verifyDerivedAesKey(aesKey, ciphertext)) continue
          return {
            success: true,
            xorKey,
            aesKey,
            wxid,
            code,
            verified: true,
            ...base
          }
        }
      }
    }

    return fail('DLL 派生的 AES 密钥均未通过模板验证')
  }

  const fallbackAccount = matchedAccounts[0] ?? (
    targetWxids.length === 0 || accountsWithCodes.length === 1 ? accountsWithCodes[0] : null
  )
  if (!fallbackAccount) {
    return fail('DLL 返回账号未匹配当前账号，且缺少模板密文，无法安全选择密钥码')
  }

  const fallbackCodes = getDllAccountCodes(fallbackAccount)
  if (fallbackCodes.length !== 1) {
    return fail('缺少模板密文且候选密钥码不唯一，无法安全选择 AES 密钥')
  }

  const wxid = collectDerivationWxids(fallbackAccount, targetWxids, matchedAccounts.includes(fallbackAccount))[0]
  const code = fallbackCodes[0]
  if (!wxid || code === undefined) {
    return fail('DLL 返回的账号或密钥码不完整')
  }

  const { xorKey, aesKey } = deriveDllImageKeys(code, wxid)
  return {
    success: true,
    xorKey,
    aesKey,
    wxid,
    code,
    verified: false,
    ...base
  }
}

/**
 * 图片、图片密钥和视频 IPC。
 * imageKey:progress 与 video:downloadProgress 是前端进度条依赖的事件边界。
 */
export function registerMediaHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('imageDecrypt:batchDetectXorKey', async (_, dirPath: string) => {
    try {
      const key = await imageDecryptService.batchDetectXorKey(dirPath)
      return { success: true, key }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('imageDecrypt:decryptImage', async (_, inputPath: string, outputPath: string, xorKey: number, aesKey?: string) => {
    try {
      ctx.getLogService()?.info('ImageDecrypt', '开始解密图片', { inputPath, outputPath })
      await imageDecryptService.decryptToFile(inputPath, outputPath, xorKey, aesKey)
      ctx.getLogService()?.info('ImageDecrypt', '图片解密成功', { outputPath })
      return { success: true }
    } catch (e) {
      ctx.getLogService()?.error('ImageDecrypt', '图片解密失败', { inputPath, error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  // 新的图片解密 API（来自 WeFlow）
  ipcMain.handle('image:decrypt', async (_, payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number; force?: boolean }) => {
    const result = await imageDecryptService.decryptImage(payload)
    if (!result.success) {
      ctx.getLogService()?.error('ImageDecrypt', '图片解密失败', { payload, error: result.error })
    }
    return result
  })

  ipcMain.handle('image:resolveCache', async (_, payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }) => {
    const result = await imageDecryptService.resolveCachedImage(payload)
    if (!result.success) {
      ctx.getLogService()?.warn('ImageDecrypt', '图片缓存解析失败', { payload, error: result.error })
    }
    return result
  })

  ipcMain.handle('image:countThumbnails', async () => {
    return imageDecryptService.countThumbnails()
  })

  ipcMain.handle('image:deleteThumbnails', async () => {
    return imageDecryptService.deleteThumbnails()
  })

  // 视频相关
  ipcMain.handle('video:getVideoInfo', async (_, videoMd5: string, rawContent?: string) => {
    try {
      const result = await videoService.getVideoInfo(videoMd5, rawContent)
      return { success: true, ...result }
    } catch (e) {
      return { success: false, error: String(e), exists: false }
    }
  })

  ipcMain.handle('video:readFile', async (_, videoPath: string) => {
    try {
      if (!existsSync(videoPath)) {
        return { success: false, error: '视频文件不存在' }
      }
      // 视频文件可能很大，必须异步读取，避免阻塞主进程事件循环。
      const buffer = await readFile(videoPath)
      const base64 = buffer.toString('base64')
      return { success: true, data: `data:video/mp4;base64,${base64}` }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('video:parseVideoMd5', async (_, content: string) => {
    try {
      const md5 = videoService.parseVideoMd5(content)
      return { success: true, md5 }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 视频号相关
  ipcMain.handle('video:parseChannelVideo', async (_, content: string) => {
    try {
      const videoInfo = videoService.parseChannelVideoFromXml(content)
      return { success: true, videoInfo }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('video:downloadChannelVideo', async (event, videoInfo: any, key?: string) => {
    try {
      const result = await videoService.downloadChannelVideo(
        videoInfo,
        key,
        (progress) => {
          // 发送进度更新到渲染进程
          event.sender.send('video:downloadProgress', {
            objectId: videoInfo.objectId,
            ...progress
          })
        }
      )
      return result
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  })

  // 图片密钥获取：Windows 优先用 DLL 提取 code，并用当前账号模板验证派生 AES 密钥。
  ipcMain.handle('imageKey:getImageKeys', async (event, userDir: string) => {
    const resolvedUserDir = resolveImageKeyUserDir(userDir)
    ctx.getLogService()?.info('ImageKey', '开始获取图片密钥（DLL 本地扫描模式）', { userDir, resolvedUserDir })
    if (process.platform === 'darwin') {
      try {
        const kvcommResult = await wxKeyServiceMac.autoGetImageKey(
          userDir,
          (message) => event.sender.send('imageKey:progress', message)
        )

        if (kvcommResult.success) {
          ctx.getLogService()?.info('ImageKey', 'macOS kvcomm 图片密钥获取成功', {
            xorKey: kvcommResult.xorKey,
            aesKey: kvcommResult.aesKey
          })
          return kvcommResult
        }

        ctx.getLogService()?.warn('ImageKey', 'macOS kvcomm 方案失败，切换内存扫描', { error: kvcommResult.error })
        event.sender.send('imageKey:progress', 'kvcomm 方案失败，正在尝试内存扫描...')

        const scanResult = await wxKeyServiceMac.autoGetImageKeyByMemoryScan(
          userDir,
          (message) => event.sender.send('imageKey:progress', message)
        )

        if (scanResult.success) {
          ctx.getLogService()?.info('ImageKey', 'macOS 内存扫描图片密钥获取成功', {
            xorKey: scanResult.xorKey,
            aesKey: scanResult.aesKey
          })
        } else {
          ctx.getLogService()?.error('ImageKey', 'macOS 图片密钥获取失败', { error: scanResult.error })
        }

        return scanResult
      } catch (e) {
        ctx.getLogService()?.error('ImageKey', 'macOS 图片密钥获取异常', { error: String(e) })
        return { success: false, error: String(e) }
      }
    }

    try {
      // ========== 方案一：DLL 本地扫描（优先） ==========
      const dllResult = await (async () => {
        const initSuccess = await wxKeyService.initialize()
        if (!initSuccess) {
          ctx.getLogService()?.warn('ImageKey', 'DLL 初始化失败，将尝试内存扫描兜底')
          return null
        }

        event.sender.send('imageKey:progress', '正在从缓存目录扫描图片密钥...')

        const result = wxKeyService.getImageKey()
        if (!result.success || !result.json) {
          ctx.getLogService()?.warn('ImageKey', 'DLL GetImageKey 失败，将尝试内存扫描兜底', { error: result.error })
          return null
        }

        let parsed: any
        try {
          parsed = JSON.parse(result.json)
        } catch {
          ctx.getLogService()?.warn('ImageKey', '解析 DLL 返回数据失败，将尝试内存扫描兜底')
          return null
        }

        const accounts: DllImageKeyAccount[] = Array.isArray(parsed.accounts) ? parsed.accounts : []
        if (!accounts.length) {
          ctx.getLogService()?.warn('ImageKey', 'DLL 未返回有效密钥码，将尝试内存扫描兜底')
          return null
        }

        const selection = selectDllImageKey(accounts, resolvedUserDir)
        ctx.getLogService()?.info('ImageKey', 'DLL 图片密钥候选解析完成', {
          targetWxids: selection.targetWxids,
          matchedWxids: selection.matchedWxids,
          accountCount: selection.accountCount,
          codeCount: selection.codeCount,
          validationAvailable: selection.validationAvailable,
          dllFoundWxids: accounts.map((a: any) => a.wxid)
        })

        if (!selection.success) {
          ctx.getLogService()?.warn('ImageKey', 'DLL 图片密钥未命中，将尝试内存扫描兜底', {
            reason: selection.reason,
            targetWxids: selection.targetWxids,
            matchedWxids: selection.matchedWxids,
            validationAvailable: selection.validationAvailable
          })
          return null
        }

        if (!selection.verified) {
          ctx.getLogService()?.warn('ImageKey', '未找到 V2 模板密文，返回 DLL 匹配账号的未验证派生密钥', {
            wxid: selection.wxid,
            code: selection.code
          })
        }

        const verifiedLabel = selection.verified ? '已验证' : '未验证'
        event.sender.send('imageKey:progress', `密钥获取成功 (${verifiedLabel}, wxid: ${selection.wxid}, code: ${selection.code})`)
        ctx.getLogService()?.info('ImageKey', '图片密钥获取成功（DLL 模式）', {
          wxid: selection.wxid,
          code: selection.code,
          xorKey: selection.xorKey,
          aesKey: selection.aesKey,
          verified: selection.verified
        })

        return { success: true as const, xorKey: selection.xorKey, aesKey: selection.aesKey }
      })()

      if (dllResult) return dllResult

      // ========== 方案二：内存扫描兜底 ==========
      ctx.getLogService()?.info('ImageKey', '切换到内存扫描兜底方案', { userDir })
      event.sender.send('imageKey:progress', 'DLL 方式失败，正在尝试内存扫描方式...')

      const wechatPid = wxKeyService.getWeChatPid()
      if (!wechatPid) {
        return { success: false, error: '获取图片密钥失败：DLL 扫描失败且未检测到微信进程（内存扫描需要微信正在运行）' }
      }

      ctx.getLogService()?.info('ImageKey', '检测到微信进程，开始内存扫描', { pid: wechatPid })

      const memResult = await imageKeyService.getImageKeys(
        resolvedUserDir,
        wechatPid,
        (msg) => event.sender.send('imageKey:progress', msg)
      )

      if (memResult.success) {
        ctx.getLogService()?.info('ImageKey', '图片密钥获取成功（内存扫描兜底）', {
          xorKey: memResult.xorKey,
          aesKey: memResult.aesKey
        })
      } else {
        ctx.getLogService()?.error('ImageKey', '内存扫描兜底也失败', { error: memResult.error })
      }

      return memResult
    } catch (e) {
      ctx.getLogService()?.error('ImageKey', '图片密钥获取异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  // 聊天相关

}
