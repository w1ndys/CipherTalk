import { ipcMain } from 'electron'
import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { imageDecryptService } from '../../services/imageDecryptService'
import { imageKeyService } from '../../services/imageKeyService'
import { videoService } from '../../services/videoService'
import { wxKeyService } from '../../services/wxKeyService'
import { wxKeyServiceMac } from '../../services/wxKeyServiceMac'
import type { MainProcessContext } from '../context'

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

  // 图片密钥获取（通过 DLL 从缓存目录获取 code，用前端 wxid 计算密钥）
  ipcMain.handle('imageKey:getImageKeys', async (event, userDir: string) => {
    ctx.getLogService()?.info('ImageKey', '开始获取图片密钥（DLL 本地扫描模式）', { userDir })
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

        const accounts: any[] = parsed.accounts ?? []
        if (!accounts.length || !accounts[0]?.keys?.length) {
          ctx.getLogService()?.warn('ImageKey', 'DLL 未返回有效密钥码，将尝试内存扫描兜底')
          return null
        }

        const codes: number[] = accounts[0].keys.map((k: any) => k.code)
        ctx.getLogService()?.info('ImageKey', `DLL 提取到 ${codes.length} 个密钥码`, {
          codes,
          dllFoundWxids: accounts.map((a: any) => a.wxid)
        })

        // 从 userDir 提取前端已配置好的正确 wxid
        let targetWxid = ''
        if (userDir) {
          const dirName = userDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
          if (dirName.startsWith('wxid_')) {
            targetWxid = dirName
          }
        }

        if (!targetWxid) {
          targetWxid = accounts[0].wxid
          ctx.getLogService()?.warn('ImageKey', '无法从 userDir 提取 wxid，使用 DLL 发现的', { targetWxid })
        }

        // CleanWxid: 截断到第二个下划线
        const cleanWxid = (wxid: string): string => {
          const first = wxid.indexOf('_')
          if (first === -1) return wxid
          const second = wxid.indexOf('_', first + 1)
          if (second === -1) return wxid
          return wxid.substring(0, second)
        }
        const cleanedWxid = cleanWxid(targetWxid)

        const crypto = require('crypto')
        const code = codes[0]
        const xorKey = code & 0xFF
        const dataToHash = code.toString() + cleanedWxid
        const md5Full = crypto.createHash('md5').update(dataToHash).digest('hex')
        const aesKey = md5Full.substring(0, 16)

        event.sender.send('imageKey:progress', `密钥获取成功 (wxid: ${targetWxid}, code: ${code})`)
        ctx.getLogService()?.info('ImageKey', '图片密钥获取成功（DLL 模式）', { wxid: targetWxid, code, xorKey, aesKey })

        return { success: true as const, xorKey, aesKey }
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
        userDir,
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
