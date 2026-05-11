import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2, RefreshCw, Image as ImageIcon, Play, PlayCircle, Video, Link, FileText, FileArchive, Users, Phone, MapPin, UserRound, MessageSquare } from 'lucide-react'
import { Qwen } from '@lobehub/icons'
import { useChatStore } from '../../../../stores/chatStore'
import MessageContent from '../../../../components/MessageContent'
import { LivePhotoIcon } from '../../../../components/LivePhotoIcon'
import type { ChatSession, Message } from '../../../../types/models'
import { checkOnlineSttConfigReady } from '../../utils/sttConfig'
import { ChannelVideoCard, LinkSource, LinkThumb, MiniProgramThumb } from './AppMessageCards'
import { emojiDataUrlCache, enqueueDecrypt, globalVoiceManager, imageDataUrlCache, lastIncrementalUpdateTime, videoInfoCache } from './mediaState'
import type { CachedVideoInfo } from './mediaState'

interface MessageBubbleProps {
  message: Message;
  session: ChatSession;
  showTime?: boolean;
  myAvatarUrl?: string;
  isGroupChat?: boolean;
  hasImageKey?: boolean;
  onContextMenu?: (e: React.MouseEvent, message: Message, handlers?: any) => void;
  isSelected?: boolean;
  quoteStyle?: 'default' | 'wechat';
}

function MessageBubble({ message, session, showTime, myAvatarUrl, isGroupChat, hasImageKey, onContextMenu, isSelected, quoteStyle = 'default' }: MessageBubbleProps) {
  const syncVersion = useChatStore(state => state.syncVersion)
  const lastSyncVersionRef = useRef(syncVersion)

  const isPatAppMsg = (() => {
    const content = message.rawContent || message.parsedContent || ''
    if (!content) return false
    // WeChat “拍一拍”通常是 appmsg.type=62，并携带 patinfo
    return /<appmsg[\s\S]*?>[\s\S]*?<type>\s*62\s*<\/type>/i.test(content) || /<patinfo[\s\S]*?>/i.test(content)
  })()

  const isSystem = message.localType === 10000 || isPatAppMsg
  const isEmoji = message.localType === 47
  const isImage = message.localType === 3
  const isVideo = message.localType === 43
  const isVoice = message.localType === 34
  const isSent = message.isSend === 1
  const [senderAvatarUrl, setSenderAvatarUrl] = useState<string | undefined>(undefined)
  const [senderName, setSenderName] = useState<string | undefined>(undefined)
  const [transferPayerName, setTransferPayerName] = useState<string | undefined>(undefined)
  const [transferReceiverName, setTransferReceiverName] = useState<string | undefined>(undefined)
  const [emojiError, setEmojiError] = useState(false)
  const [emojiLoading, setEmojiLoading] = useState(false)
  const [imageError, setImageError] = useState(false)
  const [imageLoading, setImageLoading] = useState(false)

  // 语音相关状态
  const [voiceLoading, setVoiceLoading] = useState(false)
  const [voicePlaying, setVoicePlaying] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceDataUrl, setVoiceDataUrl] = useState<string | null>(null)
  const voiceRef = useRef<HTMLAudioElement>(null)

  // 语音转文字 (STT) 状态
  const [sttTranscript, setSttTranscript] = useState<string | null>(null)
  const [sttLoading, setSttLoading] = useState(false)
  const [sttError, setSttError] = useState<string | null>(null)
  const [sttProvider, setSttProvider] = useState<'aliyun-qwen-asr' | null>(null)
  const [isEditingStt, setIsEditingStt] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [imageHasUpdate, setImageHasUpdate] = useState(false)
  const [imageClicked, setImageClicked] = useState(false)
  const imageUpdateCheckedRef = useRef<string | null>(null)
  const imageClickTimerRef = useRef<number | null>(null)
  const imageRecoveringRef = useRef(false)
  const lastRecoverTriedPathRef = useRef<string | null>(null)
  const [isVisible, setIsVisible] = useState(false)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const imageContainerRef = useRef<HTMLDivElement>(null)

  // 视频相关状态
  const [videoInfo, setVideoInfo] = useState<CachedVideoInfo | null>(null)
  const [videoLoading, setVideoLoading] = useState(false)
  const videoContainerRef = useRef<HTMLDivElement>(null)
  const videoCacheKey = message.videoMd5 || `local:${message.localId}`

  // 从缓存获取表情包 data URL
  const cacheKey = message.emojiMd5 || message.emojiCdnUrl || ''
  const [emojiLocalPath, setEmojiLocalPath] = useState<string | undefined>(
    () => emojiDataUrlCache.get(cacheKey)
  )

  // 图片缓存
  const imageCacheKey = message.imageMd5 || message.imageDatName || `local:${message.localId}`
  const [imageLocalPath, setImageLocalPath] = useState<string | undefined>(
    () => imageDataUrlCache.get(imageCacheKey)
  )
  const [imageLiveVideoPath, setImageLiveVideoPath] = useState<string | undefined>()

  // 引用图片缓存
  const quotedImageCacheKey = message.quotedImageMd5 || ''
  const [quotedImageLocalPath, setQuotedImageLocalPath] = useState<string | undefined>(
    () => quotedImageCacheKey ? imageDataUrlCache.get(quotedImageCacheKey) : undefined
  )

  // 引用表情包缓存
  const quotedEmojiCacheKey = message.quotedEmojiMd5 || ''
  const [quotedEmojiLocalPath, setQuotedEmojiLocalPath] = useState<string | undefined>(
    () => quotedEmojiCacheKey ? emojiDataUrlCache.get(quotedEmojiCacheKey) : undefined
  )

  const formatTime = (timestamp: number): string => {
    const date = new Date(timestamp * 1000)
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }) + ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  // 获取头像首字母
  const getAvatarLetter = (name: string): string => {
    if (!name) return '?'
    const chars = [...name]
    return chars[0] || '?'
  }

  // 下载表情包
  const downloadEmoji = () => {
    if (emojiLoading) return

    // 没有 cdnUrl 也没有 md5，无法获取
    if (!message.emojiCdnUrl && !message.emojiMd5) {
      return
    }

    // 先检查缓存
    const cached = emojiDataUrlCache.get(cacheKey)
    if (cached) {
      setEmojiLocalPath(cached)
      setEmojiError(false)
      return
    }

    setEmojiLoading(true)
    setEmojiError(false)

    // 如果有 cdnUrl，优先下载；否则仅通过 md5 查找本地缓存
    const cdnUrl = message.emojiCdnUrl || ''
    window.electronAPI.chat.downloadEmoji(cdnUrl, message.emojiMd5, message.productId, message.createTime, message.emojiEncryptUrl, message.emojiAesKey).then((result: { success: boolean; localPath?: string; error?: string }) => {
      if (result.success && result.localPath) {
        emojiDataUrlCache.set(cacheKey, result.localPath)
        setEmojiLocalPath(result.localPath)
      } else {
        console.error('[ChatPage] 表情包下载失败:', result.error)
        setEmojiError(true)
      }
    }).catch((e) => {
      console.error('[ChatPage] 表情包下载异常:', e)
      setEmojiError(true)
    }).finally(() => {
      setEmojiLoading(false)
    })
  }

  // 请求图片解密
  const requestImageDecrypt = useCallback(async (forceUpdate = false) => {
    if (!isImage || imageLoading) return
    setImageLoading(true)
    setImageError(false)

    try {
      if (message.imageMd5 || message.imageDatName) {
        const result = await window.electronAPI.image.decrypt({
          sessionId: session.username,
          imageMd5: message.imageMd5 || undefined,
          imageDatName: message.imageDatName,
          createTime: message.createTime,
          force: forceUpdate
        })

        // 先检查错误情况
        if (!result.success) {

          setImageError(true)
          return
        }

        // 成功情况
        if (result.localPath) {
          imageDataUrlCache.set(imageCacheKey, result.localPath)
          setImageLocalPath(result.localPath)
          if ((result as any).liveVideoPath) setImageLiveVideoPath((result as any).liveVideoPath)
          // 如果返回的是缩略图，标记有更新可用
          setImageHasUpdate(Boolean((result as { isThumb?: boolean }).isThumb))

          return (result as any).liveVideoPath as string | undefined
        }
      }
      setImageError(true)
    } catch {
      setImageError(true)
    } finally {
      setImageLoading(false)
    }
  }, [isImage, imageLoading, message.imageMd5, message.imageDatName, session.username, imageCacheKey])

  // 点击图片解密
  const handleImageClick = useCallback(() => {
    if (imageClickTimerRef.current) {
      window.clearTimeout(imageClickTimerRef.current)
    }
    setImageClicked(true)
    imageClickTimerRef.current = window.setTimeout(() => {
      setImageClicked(false)
    }, 800)
    void requestImageDecrypt()
  }, [requestImageDecrypt])

  // 清理定时器
  useEffect(() => {
    return () => {
      if (imageClickTimerRef.current) {
        window.clearTimeout(imageClickTimerRef.current)
      }
    }
  }, [])

  // 使用 IntersectionObserver 检测图片是否进入可视区域（懒加载）
  useEffect(() => {
    if (!isImage || !imageContainerRef.current) return

    const scrollRoot = imageContainerRef.current.closest('.message-list') as HTMLElement | null
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        root: scrollRoot,
        rootMargin: '1000px 0px',
        threshold: 0
      }
    )

    observer.observe(imageContainerRef.current)

    return () => observer.disconnect()
  }, [isImage])

  // 视频懒加载
  useEffect(() => {
    if (!isVideo || !videoContainerRef.current) return

    const scrollRoot = videoContainerRef.current.closest('.message-list') as HTMLElement | null
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        root: scrollRoot,
        rootMargin: '200px 0px',
        threshold: 0
      }
    )

    observer.observe(videoContainerRef.current)

    return () => observer.disconnect()
  }, [isVideo])

  // 引用图片/表情也按消息气泡可见性延后加载，避免一页消息挂载时同时发起大量 IPC。
  useEffect(() => {
    const hasQuotedMedia = Boolean(message.quotedImageMd5 || message.quotedEmojiMd5 || message.quotedEmojiCdnUrl)
    if (!hasQuotedMedia || isVisible || !bubbleRef.current) return

    const scrollRoot = bubbleRef.current.closest('.message-list') as HTMLElement | null
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setIsVisible(true)
            observer.disconnect()
          }
        })
      },
      {
        root: scrollRoot,
        rootMargin: '1000px 0px',
        threshold: 0
      }
    )

    observer.observe(bubbleRef.current)

    return () => observer.disconnect()
  }, [message.quotedImageMd5, message.quotedEmojiMd5, message.quotedEmojiCdnUrl, isVisible])

  // 加载视频信息
  useEffect(() => {
    if (!isVideo || !isVisible || videoInfo || videoLoading) return
    if (!message.videoMd5 && !message.rawContent) return

    // 先检查缓存
    const cached = videoInfoCache.get(videoCacheKey)
    if (cached) {
      // 智能缓存失效：如果视频不存在，且缓存时间早于最后一次增量更新，则重新获取
      const shouldRefetch = !cached.exists && cached.cachedAt < lastIncrementalUpdateTime

      console.log('[Video][Renderer] cache-check', {
        localId: message.localId,
        sessionId: session.username,
        videoCacheKey,
        videoMd5: message.videoMd5,
        hasCached: true,
        cachedExists: cached.exists,
        shouldRefetch,
        diagnostics: cached.diagnostics
      })

      if (!shouldRefetch) {
        setVideoInfo(cached)
        return
      }

      // 需要重新获取，清除旧缓存
      videoInfoCache.delete(videoCacheKey)
    }

    setVideoLoading(true)
    console.log('[Video][Renderer] request-start', {
      localId: message.localId,
      sessionId: session.username,
      videoCacheKey,
      videoMd5: message.videoMd5,
      rawPreview: String(message.rawContent || '').replace(/\s+/g, ' ').slice(0, 220)
    })
    window.electronAPI.video.getVideoInfo(message.videoMd5 || '', message.rawContent).then((result) => {
      if (result && result.success) {
        const info = {
          exists: result.exists,
          videoUrl: result.videoUrl,
          coverUrl: result.coverUrl,
          thumbUrl: result.thumbUrl,
          diagnostics: result.diagnostics,
          cachedAt: Date.now()  // 记录缓存时间
        }
        videoInfoCache.set(videoCacheKey, info)
        setVideoInfo(info)
        console.log('[Video][Renderer] request-success', {
          localId: message.localId,
          sessionId: session.username,
          videoCacheKey,
          exists: result.exists,
          videoUrl: result.videoUrl,
          diagnostics: result.diagnostics
        })
        if (!result.exists && result.diagnostics) {
          console.warn('[Video] 视频定位失败:', {
            localId: message.localId,
            diagnostics: result.diagnostics
          })
        }
      } else {
        const info = { exists: false, cachedAt: Date.now() }
        videoInfoCache.set(videoCacheKey, info)
        setVideoInfo(info)
        console.warn('[Video][Renderer] request-unsuccessful', {
          localId: message.localId,
          sessionId: session.username,
          videoCacheKey,
          result
        })
      }
    }).catch((error) => {
      const info = { exists: false, cachedAt: Date.now() }
      videoInfoCache.set(videoCacheKey, info)
      setVideoInfo(info)
      console.error('[Video][Renderer] request-error', {
        localId: message.localId,
        sessionId: session.username,
        videoCacheKey,
        error: String(error)
      })
    }).finally(() => {
      setVideoLoading(false)
    })
  }, [isVideo, isVisible, videoInfo, videoLoading, message.videoMd5, message.rawContent, message.localId, videoCacheKey])

  // 播放视频 - 打开独立窗口
  const handlePlayVideo = useCallback(async () => {
    if (!videoInfo?.videoUrl) return

    // 直接打开独立视频播放窗口
    try {
      await window.electronAPI.window.openVideoPlayerWindow(videoInfo.videoUrl)
    } catch {
      // 忽略错误
    }
  }, [videoInfo?.videoUrl])

  // 语音播放处理
  const handlePlayVoice = useCallback(async () => {
    if (voiceLoading) return

    // 如果已经有数据，直接播放/暂停
    if (voiceDataUrl && voiceRef.current) {
      if (voicePlaying) {
        voiceRef.current.pause()
        setVoicePlaying(false)
        globalVoiceManager.stop(voiceRef.current)
      } else {
        voiceRef.current.currentTime = 0
        // 停止其他正在播放的语音，确保同一时间只播放一条
        globalVoiceManager.play(voiceRef.current, () => {
          voiceRef.current?.pause()
          setVoicePlaying(false)
        })
        voiceRef.current.play()
        setVoicePlaying(true)
      }
      return
    }

    // 加载语音数据
    setVoiceLoading(true)
    setVoiceError(null)
    try {
      const result = await window.electronAPI.chat.getVoiceData(session.username, String(message.localId), message.createTime)
      if (result.success && result.data) {
        const dataUrl = `data:audio/wav;base64,${result.data}`
        setVoiceDataUrl(dataUrl)
        // 等待状态更新后播放
        requestAnimationFrame(() => {
          if (voiceRef.current) {
            // 停止其他正在播放的语音
            globalVoiceManager.play(voiceRef.current, () => {
              voiceRef.current?.pause()
              setVoicePlaying(false)
            })
            voiceRef.current.play()
            setVoicePlaying(true)
          }
        })
      } else {
        setVoiceError(result.error || '加载失败')
      }
    } catch (e) {
      setVoiceError(String(e))
    } finally {
      setVoiceLoading(false)
    }
  }, [voiceLoading, voiceDataUrl, voicePlaying, session.username, message.localId])

  // 语音播放结束
  const handleVoiceEnded = useCallback(() => {
    setVoicePlaying(false)
    if (voiceRef.current) globalVoiceManager.stop(voiceRef.current)
  }, [])

  // 语音转文字处理
  const handleTranscribeVoice = useCallback(async (e?: React.MouseEvent, force = false) => {
    e?.stopPropagation() // 阻止触发播放

    if (sttLoading || (sttTranscript && !force)) return // 已转写或正在转写

    console.log('[STT] 开始转写...')
    setSttLoading(true)
    setSttError(null)

    try {
      // 检查 STT 模式
      const sttMode = await window.electronAPI.config.get('sttMode') || 'cpu'
      console.log('[STT] 当前模式:', sttMode)

      // 根据模式检查对应的模型
      let modelExists = false
      let modelName = ''
      
      if (sttMode === 'gpu') {
        setSttProvider(null)
        // 检查 Whisper 模型
        const whisperModelType = (await window.electronAPI.config.get('whisperModelType') as string) || 'small'
        console.log('[ChatPage] 读取到的 Whisper 模型类型:', whisperModelType)
        
        const modelStatus = await window.electronAPI.sttWhisper.checkModel(whisperModelType)
        modelExists = modelStatus.exists
        modelName = `Whisper ${whisperModelType}`
        
        if (!modelExists) {
          if (window.confirm(`Whisper ${whisperModelType} 模型未下载，是否立即下载？\n下载完成后将自动开始转写。`)) {
            setSttLoading(true)
            setSttTranscript('准备下载模型...')

            const removeProgress = window.electronAPI.sttWhisper.onDownloadProgress((p) => {
              const pct = p.percent || 0
              setSttTranscript(`正在下载模型... ${pct.toFixed(1)}%`)
            })

            try {
              const dlResult = await window.electronAPI.sttWhisper.downloadModel(whisperModelType)
              removeProgress()

              if (dlResult.success) {
                setSttTranscript('模型下载完成，正在初始化引擎...')
                await new Promise(r => setTimeout(r, 2000))
                setSttLoading(false)
                await handleTranscribeVoice(undefined, true)
                return
              } else {
                setSttError(dlResult.error || '模型下载失败')
                setSttTranscript(null)
              }
            } catch (e) {
              removeProgress()
              setSttError(`模型下载出错: ${e}`)
              setSttTranscript(null)
            }
          }
          setSttLoading(false)
          return
        }
      } else if (sttMode === 'online') {
        const onlineReady = await checkOnlineSttConfigReady()
        modelExists = onlineReady.ready
        const onlineProvider = await window.electronAPI.config.get('sttOnlineProvider')
        setSttProvider(onlineProvider === 'aliyun-qwen-asr' ? 'aliyun-qwen-asr' : null)
        modelName = onlineProvider === 'aliyun-qwen-asr'
          ? '阿里云 Qwen-ASR'
          : onlineProvider === 'custom'
            ? '自定义在线接口'
            : 'OpenAI 兼容在线转写'

        if (!modelExists) {
          setSttError(onlineReady.error || '在线转写配置不完整，请先到设置页补齐')
          setSttLoading(false)
          return
        }
      } else {
        setSttProvider(null)
        // 检查 SenseVoice 模型
        const modelStatus = await window.electronAPI.stt.getModelStatus()
        modelExists = !!(modelStatus.success && modelStatus.exists)
        modelName = 'SenseVoice'
        
        if (!modelExists) {
          if (window.confirm('语音识别模型未下载，是否立即下载？(约245MB)\n下载完成后将自动开始转写。')) {
            setSttLoading(true)
            setSttTranscript('准备下载模型...')

            const removeProgress = window.electronAPI.stt.onDownloadProgress((p) => {
              const pct = p.percent || 0
              setSttTranscript(`正在下载模型... ${pct.toFixed(1)}%`)
            })

            try {
              const dlResult = await window.electronAPI.stt.downloadModel()
              removeProgress()

              if (dlResult.success) {
                setSttTranscript('模型下载完成，正在初始化引擎...')
                await new Promise(r => setTimeout(r, 2000))
                setSttLoading(false)
                await handleTranscribeVoice(undefined, true)
                return
              } else {
                setSttError(dlResult.error || '模型下载失败')
                setSttTranscript(null)
              }
            } catch (e) {
              removeProgress()
              setSttError(`模型下载出错: ${e}`)
              setSttTranscript(null)
            }
          }
          setSttLoading(false)
          return
        }
      }

      console.log('[STT] 模型已就绪:', modelName)

      // 如果没有语音数据，先获取
      let wavBase64 = voiceDataUrl?.replace('data:audio/wav;base64,', '')

      if (!wavBase64) {
        console.log('[STT] 获取语音数据...')
        const result = await window.electronAPI.chat.getVoiceData(
          session.username,
          String(message.localId),
          message.createTime
        )
        console.log('[STT] 语音数据:', { success: result.success, dataLength: result.data?.length })
        if (!result.success || !result.data) {
          setSttError(result.error || '获取语音数据失败')
          setSttLoading(false)
          return
        }
        wavBase64 = result.data
        // 同时缓存语音数据
        setVoiceDataUrl(`data:audio/wav;base64,${wavBase64}`)
      }

      // 监听实时结果（CPU 模式与阿里云在线模式支持）
      let removeListener: (() => void) | undefined
      if (sttMode === 'cpu' || sttMode === 'online') {
        removeListener = window.electronAPI.stt.onPartialResult((text) => {
          setSttTranscript(text)
        })
      }

      // 开始转写 - 传递 sessionId 和 createTime 用于缓存
      const result = await window.electronAPI.stt.transcribe(wavBase64, session.username, message.createTime, force)

      removeListener?.()

      if (result.success && result.transcript) {
        setSttTranscript(result.transcript)
      } else {
        setSttError(result.error || '转写失败')
      }
    } catch (e) {
      console.error('[STT] 转写异常:', e)
      setSttError(String(e))
    } finally {
      setSttLoading(false)
    }
  }, [sttLoading, sttTranscript, voiceDataUrl, session.username, message.localId, message.createTime, checkOnlineSttConfigReady])

  // 群聊中获取发送者信息
  const [isLoadingSender, setIsLoadingSender] = useState(false)

  useEffect(() => {
    if (isGroupChat && !isSent && message.senderUsername) {
      setIsLoadingSender(true)
      window.electronAPI.chat.getContactAvatar(message.senderUsername).then((result: { avatarUrl?: string; displayName?: string } | null) => {
        if (result) {
          setSenderAvatarUrl(result.avatarUrl)
          setSenderName(result.displayName)
        }
        setIsLoadingSender(false)
      }).catch(() => {
        setIsLoadingSender(false)
      })
    }
  }, [isGroupChat, isSent, message.senderUsername])

  // 解析转账消息的付款方和收款方显示名称
  useEffect(() => {
    if (!message.transferPayerUsername || !message.transferReceiverUsername) return
    if (message.localType !== 49 && message.localType !== 8589934592049) return
    window.electronAPI.chat.resolveTransferDisplayNames(
      session.username,
      message.transferPayerUsername,
      message.transferReceiverUsername
    ).then((result: { payerName: string; receiverName: string }) => {
      setTransferPayerName(result.payerName)
      setTransferReceiverName(result.receiverName)
    }).catch(() => {})
  }, [message.transferPayerUsername, message.transferReceiverUsername, session.username])

  // 自动下载表情包
  useEffect(() => {
    if (emojiLocalPath) return
    // 有 cdnUrl 或 md5 都可以尝试获取
    if (isEmoji && (message.emojiCdnUrl || message.emojiMd5) && !emojiLoading && !emojiError) {
      downloadEmoji()
    }
  }, [isEmoji, message.emojiCdnUrl, message.emojiMd5, message.productId, emojiLocalPath, emojiLoading, emojiError])

  // 自动尝试从缓存解析图片，如果没有缓存则自动解密（仅在可见时触发，5秒超时）
  useEffect(() => {
    if (!isImage) return
    if (!message.imageMd5 && !message.imageDatName) return
    if (!isVisible) return  // 只有可见时才加载

    // 如果是新一轮全局同步且之前没成功，允许重试
    const isNewSync = syncVersion > lastSyncVersionRef.current
    if (imageUpdateCheckedRef.current === imageCacheKey && !isNewSync) return

    if (imageLocalPath && !isNewSync) return  // 如果已经有本地路径且不是强制同步，不需要再解析
    if (imageLoading) return  // 已经在加载中

    lastSyncVersionRef.current = syncVersion
    imageUpdateCheckedRef.current = imageCacheKey

    let cancelled = false
    let timeoutId: number | null = null

    const doDecrypt = async () => {
      if (cancelled) return
      setImageLoading(true)

      // 设置 5 秒超时
      const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
        timeoutId = window.setTimeout(() => resolve({ timeout: true }), 5000)
      })

      const decryptPromise = (async () => {
        if (cancelled) return { cancelled: true }
        // 先尝试从缓存获取
        try {
          const result = await window.electronAPI.image.resolveCache({
            sessionId: session.username,
            imageMd5: message.imageMd5 || undefined,
            imageDatName: message.imageDatName,
            createTime: message.createTime
          })
          if (cancelled) return { cancelled: true }
          if (result.success && result.localPath) {
            return { success: true, localPath: result.localPath, hasUpdate: result.hasUpdate, liveVideoPath: (result as any).liveVideoPath }
          }
        } catch {
          // 继续尝试解密
        }

        if (cancelled) return { cancelled: true }

        // 缓存中没有，自动尝试解密
        try {
          const decryptResult = await window.electronAPI.image.decrypt({
            sessionId: session.username,
            imageMd5: message.imageMd5 || undefined,
            imageDatName: message.imageDatName,
            createTime: message.createTime,
            force: false
          })
          if (cancelled) return { cancelled: true }
          if (decryptResult.success && decryptResult.localPath) {
            return { success: true, localPath: decryptResult.localPath, liveVideoPath: (decryptResult as any).liveVideoPath }
          }
        } catch {
          // 解密失败
        }
        return { failed: true }
      })()

      const result = await Promise.race([decryptPromise, timeoutPromise])

      if (timeoutId) {
        window.clearTimeout(timeoutId)
        timeoutId = null
      }

      if (cancelled) return

      if ('timeout' in result) {
        // 超时，显示手动解密按钮
        setImageError(true)
        setImageLoading(false)
        return
      }

      if ('cancelled' in result) return

      if ('success' in result && result.localPath) {
        imageDataUrlCache.set(imageCacheKey, result.localPath)
        setImageLocalPath(result.localPath)
        if ('liveVideoPath' in result && (result as any).liveVideoPath) setImageLiveVideoPath((result as any).liveVideoPath)
        setImageError(false)
        if ('hasUpdate' in result) {
          setImageHasUpdate(Boolean(result.hasUpdate))
        }
      } else {
        setImageError(true)
      }
      setImageLoading(false)
    }

    // 使用队列控制并发
    enqueueDecrypt(doDecrypt)

    return () => {
      cancelled = true
      if (timeoutId) window.clearTimeout(timeoutId)
    }
  }, [isImage, message.imageMd5, message.imageDatName, isVisible, imageCacheKey, imageLocalPath, session.username, syncVersion])

  // 若已显示缩略图且检测到高清图可用，循环尝试升级（防止首轮时机过早）
  useEffect(() => {
    if (!isImage) return
    if (!isVisible) return
    if (!imageLocalPath) return
    if (!imageLocalPath.toLowerCase().includes('_thumb')) return
    if (!imageHasUpdate) return
    const timer = window.setInterval(() => {
      if (!imageLoading) {
        void requestImageDecrypt(true)
      }
    }, 6000)

    if (!imageLoading) {
      void requestImageDecrypt(true)
    }

    return () => {
      window.clearInterval(timer)
    }
  }, [isImage, isVisible, imageLocalPath, imageHasUpdate, imageLoading, requestImageDecrypt])

  const handleOpenImage = useCallback(() => {
    if (!imageLocalPath) return

    void window.electronAPI.window.openImageViewerWindow(imageLocalPath, imageLiveVideoPath).catch((error) => {
      console.error('[ChatPage] 打开图片查看器失败:', error)
    })
  }, [imageLocalPath, imageLiveVideoPath])

  const recoverBrokenImagePath = useCallback(async () => {
    if (!isImage) return
    if ((!message.imageMd5 && !message.imageDatName) || !session.username) return
    if (imageRecoveringRef.current) return

    const failedPath = imageLocalPath || '__empty__'
    if (lastRecoverTriedPathRef.current === failedPath && !imageHasUpdate) {
      return
    }
    lastRecoverTriedPathRef.current = failedPath
    imageRecoveringRef.current = true
    setImageLoading(true)

    try {
      const payload = {
        sessionId: session.username,
        imageMd5: message.imageMd5 || undefined,
        imageDatName: message.imageDatName,
        createTime: message.createTime
      }

      try {
        const cached = await window.electronAPI.image.resolveCache(payload)
        if (cached.success && cached.localPath && cached.localPath !== imageLocalPath) {
          imageDataUrlCache.set(imageCacheKey, cached.localPath)
          setImageLocalPath(cached.localPath)
          setImageHasUpdate(cached.localPath.toLowerCase().includes('_thumb'))
          setImageError(false)
          return
        }
      } catch {
        // continue to force decrypt
      }

      try {
        const refreshed = await window.electronAPI.image.decrypt({ ...payload, force: true })
        if (refreshed.success && refreshed.localPath) {
          imageDataUrlCache.set(imageCacheKey, refreshed.localPath)
          setImageLocalPath(refreshed.localPath)
          setImageHasUpdate(Boolean((refreshed as { isThumb?: boolean }).isThumb))
          if ((refreshed as any).liveVideoPath) {
            setImageLiveVideoPath((refreshed as any).liveVideoPath)
          }
          setImageError(false)
          return
        }
      } catch {
        // keep error state
      }

      setImageError(true)
    } finally {
      setImageLoading(false)
      imageRecoveringRef.current = false
    }
  }, [
    isImage,
    message.imageMd5,
    message.imageDatName,
    session.username,
    imageLocalPath,
    imageHasUpdate,
    imageCacheKey
  ])

  // 自动检查转写缓存
  useEffect(() => {
    if (!isVoice || sttTranscript || sttLoading) return

    window.electronAPI.stt.getCachedTranscript(session.username, message.createTime).then((result) => {
      if (result.success && result.transcript) {
        setSttTranscript(result.transcript)
      }
    }).catch(() => {
    })
  }, [isVoice, session.username, message.createTime, sttTranscript, sttLoading])






  // 监听图片更新事件
  useEffect(() => {
    if (!isImage) return
    const unsubscribe = window.electronAPI.image.onUpdateAvailable((payload) => {
      const matchesCacheKey =
        payload.cacheKey === message.imageMd5 ||
        payload.cacheKey === message.imageDatName ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matchesCacheKey) {
        setImageHasUpdate(true)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [isImage, message.imageDatName, message.imageMd5])

  // 监听缓存解析事件
  useEffect(() => {
    if (!isImage) return
    const unsubscribe = window.electronAPI.image.onCacheResolved((payload) => {
      const matchesCacheKey =
        payload.cacheKey === message.imageMd5 ||
        payload.cacheKey === message.imageDatName ||
        (payload.imageMd5 && payload.imageMd5 === message.imageMd5) ||
        (payload.imageDatName && payload.imageDatName === message.imageDatName)
      if (matchesCacheKey) {
        imageDataUrlCache.set(imageCacheKey, payload.localPath)
        setImageLocalPath(payload.localPath)
        setImageHasUpdate(payload.localPath.toLowerCase().includes('_thumb'))
        setImageError(false)
      }
    })
    return () => {
      unsubscribe?.()
    }
  }, [isImage, imageCacheKey, message.imageDatName, message.imageMd5])

  // 引用图片自动解密
  useEffect(() => {
    if (!message.quotedImageMd5) return
    if (!isVisible) return
    if (quotedImageLocalPath) return

    let cancelled = false
    const doDecrypt = async () => {
      if (cancelled) return
      try {
        // 先尝试从缓存获取
        const cached = await window.electronAPI.image.resolveCache({
          sessionId: session.username,
          imageMd5: message.quotedImageMd5
        })
        if (cancelled) return
        if (cached.success && cached.localPath) {
          imageDataUrlCache.set(message.quotedImageMd5!, cached.localPath)
          setQuotedImageLocalPath(cached.localPath)
          return
        }

        // 自动解密
        const result = await window.electronAPI.image.decrypt({
          sessionId: session.username,
          imageMd5: message.quotedImageMd5,
          force: false
        })
        if (cancelled) return
        if (result.success && result.localPath) {
          imageDataUrlCache.set(message.quotedImageMd5!, result.localPath)
          setQuotedImageLocalPath(result.localPath)
        }
      } catch { }
    }

    enqueueDecrypt(doDecrypt)
    return () => {
      cancelled = true
    }
  }, [message.quotedImageMd5, quotedImageLocalPath, session.username, isVisible])

  // 引用表情包自动下载
  useEffect(() => {
    if (!message.quotedEmojiMd5 && !message.quotedEmojiCdnUrl) return
    if (!isVisible) return
    if (quotedEmojiLocalPath) return

    const cdnUrl = message.quotedEmojiCdnUrl || ''
    const md5 = message.quotedEmojiMd5 || ''

    // 先检查缓存
    if (md5 && emojiDataUrlCache.has(md5)) {
      setQuotedEmojiLocalPath(emojiDataUrlCache.get(md5))
      return
    }

    let cancelled = false
    window.electronAPI.chat.downloadEmoji(cdnUrl, md5).then((result: any) => {
      if (cancelled) return
      if (result.success && result.localPath) {
        if (md5) emojiDataUrlCache.set(md5, result.localPath)
        setQuotedEmojiLocalPath(result.localPath)
      }
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [message.quotedEmojiMd5, message.quotedEmojiCdnUrl, quotedEmojiLocalPath, isVisible])

  if (isSystem) {
    // 系统类消息：包含“拍一拍”等 appmsg(type=62)
    let systemText = message.parsedContent || '[系统消息]'
    if (isPatAppMsg) {
      try {
        const content = message.rawContent || message.parsedContent || ''
        const xmlContent = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
        const parser = new DOMParser()
        const doc = parser.parseFromString(xmlContent, 'text/xml')
        systemText = (doc.querySelector('title')?.textContent || systemText || '[拍一拍]').trim()
      } catch {
        // ignore
      }
    }
    return (
      <div className="message-bubble system">
        <div className="bubble-content"><MessageContent content={systemText} /></div>
      </div>
    )
  }

  const bubbleClass = isSent ? 'sent' : 'received'

  // 头像逻辑：
  // - 自己发的：使用 myAvatarUrl
  // - 群聊中对方发的：使用发送者头像
  // - 私聊中对方发的：使用会话头像
  const avatarUrl = isSent
    ? myAvatarUrl
    : (isGroupChat ? senderAvatarUrl : session.avatarUrl)
  const avatarLetter = isSent
    ? '我'
    : getAvatarLetter(isGroupChat ? (senderName || '?') : (session.displayName || session.username))

  // 是否有引用消息
  const hasQuote = message.quotedContent && message.quotedContent.length > 0

  // 渲染消息内容
  const renderContent = () => {
    // 带引用的消息 (经典模式)
    if (hasQuote && quoteStyle === 'default') {
      return (
        <div className="bubble-content">
          <div className="quoted-message" onClick={(quotedImageLocalPath || quotedEmojiLocalPath) ? (e) => { e.stopPropagation(); window.electronAPI.window.openImageViewerWindow((quotedImageLocalPath || quotedEmojiLocalPath)!) } : undefined} style={(quotedImageLocalPath || quotedEmojiLocalPath) ? { cursor: 'pointer' } : undefined}>
            <div className="quoted-message-content">
              <div className="quoted-text-container">
                {message.quotedSender && <span className="quoted-sender">{message.quotedSender}</span>}
                <span className="quoted-text">{(quotedImageLocalPath || quotedEmojiLocalPath) ? null : message.quotedContent}</span>
              </div>
              {quotedImageLocalPath && (
                <div className="quoted-image-container">
                  <img
                    src={quotedImageLocalPath}
                    alt="引用图片"
                    className="quoted-image-thumb"
                  />
                </div>
              )}
              {!quotedImageLocalPath && quotedEmojiLocalPath && (
                <div className="quoted-image-container">
                  <img
                    src={quotedEmojiLocalPath}
                    alt="表情"
                    className="quoted-image-thumb"
                  />
                </div>
              )}
            </div>
          </div>
          <div className="message-text"><MessageContent content={message.parsedContent} /></div>
        </div>
      )
    }

    // 图片消息
    if (isImage) {
      // 没有配置密钥时显示提示（优先级最高）
      if (hasImageKey === false) {
        return (
          <div className="image-no-key" ref={imageContainerRef}>
            <ImageIcon size={24} />
            <span>请配置图片解密密钥</span>
          </div>
        )
      }

      // 已有缓存图片，直接显示
      if (imageLocalPath) {
        return (
          <>
            <div className="image-message-wrapper" ref={imageContainerRef}>
              <img
                src={imageLocalPath}
                alt="图片"
                className="image-message"
                onClick={() => { void handleOpenImage() }}
                onLoad={() => setImageError(false)}
                onError={() => {
                  setImageError(true)
                  void recoverBrokenImagePath()
                }}
              />
              {imageHasUpdate && (
                <button
                  type="button"
                  className="image-update-button"
                  title="检测到高清图，点击更新"
                  onClick={(e) => {
                    e.stopPropagation()
                    void requestImageDecrypt(true)
                  }}
                >
                  <RefreshCw size={14} />
                </button>
              )}
              {imageLiveVideoPath && (
                <div className="media-badge live">
                  <LivePhotoIcon size={14} />
                </div>
              )}
              {imageLoading && (
                <div className="image-loading-overlay">
                  <Loader2 size={20} className="spin" />
                </div>
              )}
            </div>

          </>
        )
      }

      // 未进入可视区域时显示占位符
      if (!isVisible) {
        return (
          <div className="image-placeholder" ref={imageContainerRef}>
            <ImageIcon size={24} />
          </div>
        )
      }

      if (imageLoading) {
        return (
          <div className="image-loading" ref={imageContainerRef}>
            <Loader2 size={20} className="spin" />
          </div>
        )
      }

      // 解密失败或未解密
      return (
        <button
          className={`image-unavailable ${imageClicked ? 'clicked' : ''}`}
          onClick={handleImageClick}
          disabled={imageLoading}
          type="button"
          ref={imageContainerRef as unknown as React.RefObject<HTMLButtonElement>}
        >
          <ImageIcon size={24} />
          <span>图片未解密</span>
          <span className="image-action">{imageClicked ? '已点击…' : '点击解密'}</span>
        </button>
      )
    }

    // 视频消息
    if (isVideo) {
      // 未进入可视区域时显示占位符
      if (!isVisible) {
        return (
          <div className="video-placeholder" ref={videoContainerRef}>
            <Video size={24} />
          </div>
        )
      }

      // 加载中
      if (videoLoading) {
        return (
          <div className="video-loading" ref={videoContainerRef}>
            <Loader2 size={20} className="spin" />
          </div>
        )
      }

      // 视频不存在
      if (!videoInfo?.exists || !videoInfo.videoUrl) {
        return (
          <button
            className="video-unavailable"
            ref={videoContainerRef as unknown as React.RefObject<HTMLButtonElement>}
            title={videoInfo?.diagnostics?.summary || '点击重试'}
            onClick={() => {
              // 清除缓存并重新加载
              console.log('[Video][Renderer] retry-click', {
                localId: message.localId,
                sessionId: session.username,
                videoCacheKey,
                diagnostics: videoInfo?.diagnostics
              })
              videoInfoCache.delete(videoCacheKey)
              setVideoInfo(null)
              setVideoLoading(false)
            }}
            type="button"
          >
            <Video size={24} />
            <span>视频不可用</span>
            {videoInfo?.diagnostics?.summary && (
              <span className="video-reason">{videoInfo.diagnostics.summary}</span>
            )}
            <span className="video-action">点击重试</span>
          </button>
        )
      }

      // 默认显示缩略图，点击打开独立播放窗口
      const thumbSrc = videoInfo.thumbUrl || videoInfo.coverUrl
      return (
        <div className="video-thumb-wrapper" ref={videoContainerRef} onClick={handlePlayVideo}>
          {thumbSrc ? (
            <img src={thumbSrc} alt="视频缩略图" className="video-thumb" />
          ) : (
            <div className="video-thumb-placeholder">
              <Video size={32} />
            </div>
          )}
          <div className="video-play-button">
            <Play size={36} fill="currentColor" />
          </div>
          {message.videoDuration && message.videoDuration > 0 && (
            <span className="video-duration-tag">
              {Math.floor(message.videoDuration / 60)}:{String(message.videoDuration % 60).padStart(2, '0')}
            </span>
          )}
        </div>
      )
    }

    // 语音消息
    if (isVoice) {
      const duration = message.voiceDuration || 0
      const displayDuration = duration > 0 ? `${Math.round(duration)}"` : ''
      // 根据时长计算宽度（最小60px，最大200px，每秒增加约10px）
      const minWidth = 60
      const maxWidth = 200
      const width = Math.min(maxWidth, Math.max(minWidth, minWidth + duration * 10))

      // 语音图标组件
      const VoiceIcon = () => {
        if (voiceLoading) {
          return <Loader2 size={18} className="spin" />
        }
        if (voiceError) {
          return <AlertCircle size={18} className="voice-error-icon" />
        }
        if (voicePlaying) {
          return (
            <div className={`voice-waves ${isSent ? 'sent' : ''}`}>
              <span></span>
              <span></span>
              <span></span>
            </div>
          )
        }
        return (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        )
      }

      return (
        <div className="voice-bubble-container">
          <div
            className="bubble-content voice-bubble"
            style={{ minWidth: `${width}px` }}
            onClick={handlePlayVoice}
          >
            <div
              className={`voice-message ${voicePlaying ? 'playing' : ''} ${voiceError ? 'error' : ''} ${isSent ? 'sent' : ''}`}
            >
              {isSent ? (
                <>
                  <span className="voice-duration">{displayDuration}</span>
                  <div className="voice-icon"><VoiceIcon /></div>
                </>
              ) : (
                <>
                  <div className="voice-icon"><VoiceIcon /></div>
                  <span className="voice-duration">{displayDuration}</span>
                </>
              )}
              {voiceDataUrl && (
                <audio
                  ref={voiceRef}
                  src={voiceDataUrl}
                  onEnded={handleVoiceEnded}
                  onError={() => setVoiceError('播放失败')}
                />
              )}
            </div>
          </div>

          {/* 转文字按钮或转写结果 */}
          {sttTranscript ? (
            isEditingStt ? (
              <div className="stt-edit-container" onClick={e => e.stopPropagation()}>
                <textarea
                  className="stt-edit-textarea"
                  value={editContent}
                  onChange={e => setEditContent(e.target.value)}
                  autoFocus
                  onContextMenu={e => e.stopPropagation()}
                />
                <div className="stt-edit-actions">
                  <button
                    className="stt-edit-btn cancel"
                    onClick={(e) => {
                      e.stopPropagation()
                      setIsEditingStt(false)
                    }}
                  >
                    取消
                  </button>
                  <button
                    className="stt-edit-btn save"
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (editContent.trim() !== sttTranscript) {
                        setSttTranscript(editContent)
                        try {
                          await window.electronAPI.stt.updateTranscript(session.username, message.createTime, editContent)
                        } catch (err) {
                          console.error('更新转写缓存失败:', err)
                        }
                      }
                      setIsEditingStt(false)
                    }}
                  >
                    保存
                  </button>
                </div>
              </div>
            ) : (
              <div className="stt-transcript" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>{sttTranscript}</span>
                {sttLoading && <Loader2 size={12} className="spin" style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />}
              </div>
            )
          ) : (
            <button
              className={`stt-button ${sttLoading ? 'loading' : ''} ${sttError ? 'error' : ''}`}
              onClick={handleTranscribeVoice}
              disabled={sttLoading}
              title={sttError || '点击转文字'}
            >
              {sttLoading ? (
                sttProvider === 'aliyun-qwen-asr' ? (
                  <Qwen.Color className="stt-provider-loading-icon" size={18} />
                ) : (
                  <Loader2 size={12} className="spin" />
                )
              ) : sttError ? (
                <AlertCircle size={12} />
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M4 7V4h16v3" />
                  <path d="M9 20h6" />
                  <path d="M12 4v16" />
                </svg>
              )}
              {(sttProvider !== 'aliyun-qwen-asr' || !sttLoading) && (
                <span>{sttLoading ? '转写中' : sttError ? '重试' : '转文字'}</span>
              )}
            </button>
          )}
          {sttError && (
            <div className="stt-error-msg" style={{ fontSize: '11px', color: '#ff4d4f', marginTop: '4px', marginLeft: '4px' }}>
              {sttError}
            </div>
          )}
        </div>
      )
    }

    // 表情包消息
    if (isEmoji) {
      // 没有 cdnUrl 也没有 md5，或加载失败，显示占位符
      const cannotFetch = !message.emojiCdnUrl && !message.emojiMd5
      if (cannotFetch || emojiError) {
        return (
          <div className="emoji-unavailable">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="10" />
              <path d="M8 15s1.5 2 4 2 4-2 4-2" />
              <line x1="9" y1="9" x2="9.01" y2="9" />
              <line x1="15" y1="9" x2="15.01" y2="9" />
            </svg>
            <span>表情包未缓存</span>
          </div>
        )
      }

      // 显示加载中
      if (emojiLoading || !emojiLocalPath) {
        return (
          <div className="emoji-loading">
            <Loader2 size={20} className="spin" />
          </div>
        )
      }

      // 显示表情图片
      return (
        <img
          src={emojiLocalPath}
          alt="表情"
          className="emoji-image"
          onError={() => setEmojiError(true)}
        />
      )
    }

    // 链接消息 (AppMessage)
    const isAppMsg = message.rawContent?.includes('<appmsg') || (message.parsedContent && message.parsedContent.includes('<appmsg'))

    if (isAppMsg) {
      let title = '链接'
      let desc = ''
      let url = ''
      let thumbUrl = ''
      let appMsgType = ''
      let isPat = false
      let textAnnouncement = ''
      let cdnthumbmd5 = ''
      let sourcedisplayname = ''
      let sourceusername = ''
      let coverPicUrl = ''

      try {
        const content = message.rawContent || message.parsedContent || ''
        // 简单清理 XML 前缀（如 wxid:）
        const xmlContent = content.substring(content.indexOf('<msg>'))

        const parser = new DOMParser()
        const doc = parser.parseFromString(xmlContent, 'text/xml')

        title = doc.querySelector('title')?.textContent || '链接'
        desc = (doc.querySelector('des')?.textContent || '').replace(/\\n/g, '\n')
        url = doc.querySelector('url')?.textContent || ''
        appMsgType = doc.querySelector('appmsg > type')?.textContent || doc.querySelector('type')?.textContent || ''
        isPat = appMsgType === '62' || Boolean(doc.querySelector('patinfo'))
        textAnnouncement = doc.querySelector('textannouncement')?.textContent || ''
        cdnthumbmd5 = doc.querySelector('cdnthumbmd5')?.textContent || ''
        sourcedisplayname = doc.querySelector('sourcedisplayname')?.textContent || ''
        sourceusername = doc.querySelector('sourceusername')?.textContent || ''
        coverPicUrl = doc.querySelector('coverpicimageurl')?.textContent || ''
      } catch (e) {
        console.error('解析 AppMsg 失败:', e)
      }

      // 拍一拍 (appmsg type=62)：这是系统类消息，不按链接卡片渲染
      if (isPat) {
        const text = (title || '').trim() || '[拍一拍]'
        return (
          <div className="bubble-content">
            <MessageContent content={text} />
          </div>
        )
      }

      // 群公告消息 (type=87)
      if (appMsgType === '87') {
        const announcementText = textAnnouncement || desc || '群公告'
        return (
          <div className="announcement-message">
            <div className="announcement-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M22 17H2a3 3 0 0 0 3-3V9a7 7 0 0 1 14 0v5a3 3 0 0 0 3 3zm-8.27 4a2 2 0 0 1-3.46 0" />
              </svg>
            </div>
            <div className="announcement-content">
              <div className="announcement-label">群公告</div>
              <div className="announcement-text">{announcementText}</div>
            </div>
          </div>
        )
      }

      // 聊天记录 (type=19)
      if (appMsgType === '19') {
        const displayTitle = title || '群聊的聊天记录'

        return (
          <div
            className="link-message chat-record-message"
            onClick={(e) => {
              e.stopPropagation()
              window.electronAPI.window.openChatHistoryWindow(session.username, message.localId)
            }}
            title="点击查看详细聊天记录"
          >
            <div className="link-header">
              <div className="link-title" title={displayTitle}>
                {displayTitle}
              </div>
            </div>
            <div className="link-body">
              <div className="chat-record-preview">
                <div className="chat-record-desc">
                  {desc || '点击打开查看完整聊天记录'}
                </div>
              </div>
              <div className="chat-record-icon">
                <MessageSquare size={18} />
              </div>
            </div>
          </div>
        )
      }

      // 文件消息 (type=6)：渲染为文件卡片
      if (appMsgType === '6') {
        // 优先使用从接口获取的文件信息，否则从 XML 解析
        const fileName = message.fileName || title || '文件'
        const fileSize = message.fileSize
        const fileExt = message.fileExt || fileName.split('.').pop()?.toLowerCase() || ''
        const fileMd5 = message.fileMd5

        // 格式化文件大小
        const formatFileSize = (bytes: number | undefined): string => {
          if (!bytes) return ''
          if (bytes < 1024) return `${bytes} B`
          if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
          if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
          return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
        }

        // 根据扩展名选择图标
        const getFileIcon = (ext: string) => {
          const archiveExts = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2']
          if (archiveExts.includes(ext)) {
            return <FileArchive size={28} />
          }
          return <FileText size={28} />
        }

        // 点击文件消息，定位到文件所在文件夹并选中文件
        const handleFileClick = async () => {
          try {
            // 获取用户设置的微信原始存储目录（不是解密缓存目录）
            const wechatDir = await window.electronAPI.config.get('dbPath') as string
            if (!wechatDir) {
              console.error('未设置微信存储目录')
              return
            }

            // 获取当前用户信息
            const userInfo = await window.electronAPI.chat.getMyUserInfo()
            if (!userInfo.success || !userInfo.userInfo) {
              console.error('无法获取用户信息')
              return
            }

            const wxid = userInfo.userInfo.wxid

            // 文件存储在 {微信存储目录}\{账号文件夹}\msg\file\{年-月}\ 目录下
            // 根据消息创建时间计算日期目录
            const msgDate = new Date(message.createTime * 1000)
            const year = msgDate.getFullYear()
            const month = String(msgDate.getMonth() + 1).padStart(2, '0')
            const dateFolder = `${year}-${month}`

            // 构建完整文件路径（包括文件名）
            const filePath = `${wechatDir}\\${wxid}\\msg\\file\\${dateFolder}\\${fileName}`

            // 使用 showItemInFolder 在文件管理器中定位并选中文件
            try {
              await window.electronAPI.shell.showItemInFolder(filePath)
            } catch (err) {
              // 如果文件不存在或路径错误，尝试只打开文件夹
              console.warn('无法定位到具体文件，尝试打开文件夹:', err)
              const fileDir = `${wechatDir}\\${wxid}\\msg\\file\\${dateFolder}`
              const result = await window.electronAPI.shell.openPath(fileDir)

              // 如果还是失败，打开上级目录
              if (result) {
                console.warn('无法打开月份文件夹，尝试打开上级目录')
                const parentDir = `${wechatDir}\\${wxid}\\msg\\file`
                await window.electronAPI.shell.openPath(parentDir)
              }
            }
          } catch (error) {
            console.error('打开文件夹失败:', error)
          }
        }

        return (
          <div
            className="file-message"
            onClick={handleFileClick}
            style={{ cursor: 'pointer' }}
            title="点击定位到文件所在文件夹"
          >
            <div className="file-icon">
              {getFileIcon(fileExt)}
            </div>
            <div className="file-info">
              <div className="file-name" title={fileName}>{fileName}</div>
              <div className="file-meta">
                {fileSize ? formatFileSize(fileSize) : ''}
              </div>
            </div>
          </div>
        )
      }

      // 转账消息 (type=2000)：渲染为转账卡片
      if (appMsgType === '2000') {
        try {
          const content = message.rawContent || message.parsedContent || ''
          const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
          const parser = new DOMParser()
          const transferDoc = parser.parseFromString(xmlStr, 'text/xml')

          const feedesc = transferDoc.querySelector('feedesc')?.textContent || ''
          const payMemo = transferDoc.querySelector('pay_memo')?.textContent || ''
          const paysubtype = transferDoc.querySelector('paysubtype')?.textContent || '1'

          // paysubtype: 1=待收款, 3=已收款
          const isReceived = paysubtype === '3'

          // 构建 "A 转账给 B" 描述
          const transferDesc = transferPayerName && transferReceiverName
            ? `${transferPayerName} 转账给 ${transferReceiverName}`
            : ''

          return (
            <div className={`transfer-message ${isReceived ? 'received' : ''}`}>
              <div className="transfer-icon">
                {isReceived ? (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                    <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                    <path d="M12 20l6 6 10-12" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                    <circle cx="20" cy="20" r="18" stroke="white" strokeWidth="2" />
                    <path d="M12 20h16M20 12l8 8-8 8" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </div>
              <div className="transfer-info">
                {transferDesc && <div className="transfer-desc">{transferDesc}</div>}
                <div className="transfer-amount">{feedesc}</div>
                {payMemo && <div className="transfer-memo">{payMemo}</div>}
                <div className="transfer-label">{isReceived ? '已收款' : '微信转账'}</div>
              </div>
            </div>
          )
        } catch (e) {
          return (
            <div className="bubble-content">
              <MessageContent content={message.parsedContent} />
            </div>
          )
        }
      }

      // 红包消息 (type=2001)
      if (appMsgType === '2001') {
        try {
          const content = message.rawContent || message.parsedContent || ''
          const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
          const parser = new DOMParser()
          const doc = parser.parseFromString(xmlStr, 'text/xml')
          const greeting = doc.querySelector('receivertitle')?.textContent || doc.querySelector('sendertitle')?.textContent || ''
          return (
            <div className="hongbao-message">
              <div className="hongbao-icon">
                <svg width="32" height="32" viewBox="0 0 40 40" fill="none">
                  <rect x="4" y="6" width="32" height="28" rx="4" fill="white" fillOpacity="0.3" />
                  <rect x="4" y="6" width="32" height="14" rx="4" fill="white" fillOpacity="0.2" />
                  <circle cx="20" cy="20" r="6" fill="white" fillOpacity="0.4" />
                  <text x="20" y="24" textAnchor="middle" fill="white" fontSize="12" fontWeight="bold">¥</text>
                </svg>
              </div>
              <div className="hongbao-info">
                <div className="hongbao-greeting">{greeting || '恭喜发财，大吉大利'}</div>
                <div className="hongbao-label">微信红包</div>
              </div>
            </div>
          )
        } catch {
          return <div className="bubble-content"><MessageContent content={message.parsedContent} /></div>
        }
      }

      // 微信礼物 (type=115)
      if (appMsgType === '115') {
        try {
          const content = message.rawContent || ''
          const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
          const parser = new DOMParser()
          const doc = parser.parseFromString(xmlStr, 'text/xml')
          const wish = doc.querySelector('wishmessage')?.textContent || '送你一份心意'
          const skutitle = doc.querySelector('skutitle')?.textContent || ''
          const skuimg = doc.querySelector('skuimgurl')?.textContent || ''
          const skuprice = doc.querySelector('skuprice')?.textContent || ''
          const priceYuan = skuprice ? (parseInt(skuprice) / 100).toFixed(2) : ''
          return (
            <div className="gift-message">
              {skuimg && <img className="gift-img" src={skuimg} alt="" referrerPolicy="no-referrer" />}
              <div className="gift-info">
                <div className="gift-wish">{wish}</div>
                {skutitle && <div className="gift-name">{skutitle}</div>}
                {priceYuan && <div className="gift-price">¥{priceYuan}</div>}
                <div className="gift-label">微信礼物</div>
              </div>
            </div>
          )
        } catch {
          return <div className="bubble-content"><MessageContent content={message.parsedContent} /></div>
        }
      }

      // 音乐分享 (type=3)
      if (appMsgType === '3') {
        try {
          const content = message.rawContent || ''
          const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
          const parser = new DOMParser()
          const doc = parser.parseFromString(xmlStr, 'text/xml')
          const title = doc.querySelector('title')?.textContent || ''
          const des = doc.querySelector('des')?.textContent || ''
          const url = doc.querySelector('url')?.textContent || ''
          const albumUrl = doc.querySelector('songalbumurl')?.textContent || ''
          const appname = doc.querySelector('appname')?.textContent || ''
          return (
            <div className="music-message" onClick={() => url && window.electronAPI.shell.openExternal(url)}>
              <div className="music-cover">
                {albumUrl ? <img src={albumUrl} alt="" referrerPolicy="no-referrer" /> : <Play size={24} />}
              </div>
              <div className="music-info">
                <div className="music-title">{title || '未知歌曲'}</div>
                {des && <div className="music-artist">{des}</div>}
                {appname && <div className="music-source">{appname}</div>}
              </div>
            </div>
          )
        } catch {
          return <div className="bubble-content"><MessageContent content={message.parsedContent} /></div>
        }
      }

      // 视频号消息 (type=51)
      if (appMsgType === '51') {
        try {
          const content = message.rawContent || message.parsedContent || ''
          const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
          const p = new DOMParser()
          const d = p.parseFromString(xmlStr, 'text/xml')
          const finder = d.querySelector('finderFeed')
          if (finder) {
            const getCDATA = (tag: string) => finder.querySelector(tag)?.textContent?.trim() || ''
            const media = finder.querySelector('mediaList media')
            const getMediaCDATA = (tag: string) => media?.querySelector(tag)?.textContent?.trim() || ''
            const channelInfo = {
              title: getCDATA('desc') || '视频号视频',
              author: getCDATA('nickname'),
              avatar: getCDATA('avatar'),
              thumbUrl: getMediaCDATA('thumbUrl'),
              coverUrl: getMediaCDATA('coverUrl'),
              duration: parseInt(getMediaCDATA('videoPlayDuration')) || undefined,
            }
            return <ChannelVideoCard info={channelInfo} />
          }
        } catch (e) {
          // fallthrough to generic link
        }
      }

      // 小程序消息 (type=33 或 type=36)
      if (appMsgType === '33' || appMsgType === '36') {
        try {
          const content = message.rawContent || message.parsedContent || ''
          const xmlStr = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
          const p = new DOMParser()
          const d = p.parseFromString(xmlStr, 'text/xml')
          const weappinfo = d.querySelector('weappinfo')
          const weappiconurl = weappinfo?.querySelector('weappiconurl')?.textContent?.trim() || ''
          const thumbRawUrl = weappinfo?.querySelector('weapppagethumbrawurl')?.textContent?.trim() || ''

          return (
            <div className="miniprogram-card">
              <div className="miniprogram-header">
                {weappiconurl ? (
                  <img className="miniprogram-icon" src={weappiconurl} alt="" referrerPolicy="no-referrer" />
                ) : (
                  <div className="miniprogram-icon-placeholder" />
                )}
                <span className="miniprogram-name">{sourcedisplayname || '小程序'}</span>
              </div>
              <div className="miniprogram-title">{title}</div>
              <div className="miniprogram-cover">
                {cdnthumbmd5 && session ? (
                  <MiniProgramThumb imageMd5={cdnthumbmd5} sessionId={session.username} fallbackUrl={thumbRawUrl} iconUrl={weappiconurl} />
                ) : thumbRawUrl ? (
                  <img className="miniprogram-cover-img" src={thumbRawUrl} alt="" referrerPolicy="no-referrer" />
                ) : weappiconurl ? (
                  <div className="miniprogram-cover-icon"><img src={weappiconurl} alt="" referrerPolicy="no-referrer" /></div>
                ) : (
                  <div className="miniprogram-cover-placeholder" />
                )}
              </div>
              <div className="miniprogram-footer">
                <svg className="miniprogram-logo" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="7" cy="12" r="3" /><circle cx="17" cy="12" r="3" /><path d="M10 12h4" /></svg>
                <span>小程序</span>
              </div>
            </div>
          )
        } catch (e) {
          // fallthrough to generic link
        }
      }

      if (url && coverPicUrl && appMsgType === '5') {
        return (
          <div className="link-message link-message--cover" onClick={(e) => { e.stopPropagation(); window.electronAPI.window.openBrowserWindow(url, title) }}>
            <div className="link-cover">
              <img src={coverPicUrl} alt="" referrerPolicy="no-referrer" />
            </div>
            <div className="link-header"><span className="link-title">{title}</span></div>
            {sourcedisplayname ? <LinkSource username={sourceusername} name={sourcedisplayname} badge="公众号图文" /> : <div className="link-source"><span className="card-badge">公众号图文</span></div>}
          </div>
        )
      }

      if (url) {
        return (
          <div
            className="link-message"
            onClick={(e) => {
              e.stopPropagation()
              // 使用自定义的浏览器窗口打开链接
              window.electronAPI.window.openBrowserWindow(url, title)
            }}
          >
            <div className="link-header">
              <span className="link-title">{title}</span>
            </div>
            <div className="link-body">
              <div className="link-desc">{desc}</div>
              {cdnthumbmd5 && session ? (
                <LinkThumb imageMd5={cdnthumbmd5} sessionId={session.username} />
              ) : (
                <div className="link-thumb-placeholder"><Link size={24} /></div>
              )}
            </div>
            {sourcedisplayname && <LinkSource username={sourceusername} name={sourcedisplayname} badge="公众号文章" />}
          </div>
        )
      }
    }

    // 名片消息
    if (message.localType === 42) {
      const raw = message.rawContent || ''
      const nickname = raw.match(/nickname="([^"]*)"/)?.[1] || '未知'
      const avatar = raw.match(/bigheadimgurl="([^"]*)"/)?.[1] || raw.match(/smallheadimgurl="([^"]*)"/)?.[1]
      const alias = raw.match(/alias="([^"]*)"/)?.[1]
      const province = raw.match(/province="([^"]*)"/)?.[1]
      return (
        <div className="contact-card-message">
          <div className="contact-card-avatar">
            {avatar ? <img src={avatar} alt="" referrerPolicy="no-referrer" /> : <UserRound size={24} />}
          </div>
          <div className="contact-card-info">
            <div className="contact-card-name">{nickname}</div>
            {(alias || province) && <div className="contact-card-detail">{[alias, province].filter(Boolean).join(' · ')}</div>}
          </div>
          <div className="contact-card-badge">个人名片</div>
        </div>
      )
    }

    // 位置消息
    if (message.localType === 48) {
      const raw = message.rawContent || ''
      const poiname = raw.match(/poiname="([^"]*)"/)?.[1] || ''
      const label = raw.match(/label="([^"]*)"/)?.[1] || ''
      const lat = parseFloat(raw.match(/x="([^"]*)"/)?.[1] || '0')
      const lng = parseFloat(raw.match(/y="([^"]*)"/)?.[1] || '0')
      const zoom = 15
      const n = Math.pow(2, zoom)
      const tileX = Math.floor((lng + 180) / 360 * n)
      const tileY = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n)
      const tileUrl = `https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${tileX}&y=${tileY}&z=${zoom}`
      return (
        <div className="location-message" onClick={() => window.electronAPI.shell.openExternal(`https://uri.amap.com/marker?position=${lng},${lat}&name=${encodeURIComponent(poiname || label)}`)}>
          <div className="location-text">
            <MapPin size={16} className="location-icon" />
            <div className="location-info">
              {poiname && <div className="location-name">{poiname}</div>}
              {label && <div className="location-label">{label}</div>}
            </div>
          </div>
          {lat !== 0 && lng !== 0 && (
            <div className="location-map">
              <img src={tileUrl} alt="" referrerPolicy="no-referrer" />
              <div className="location-pin"><MapPin size={20} fill="#e25b4a" color="#fff" /></div>
            </div>
          )}
        </div>
      )
    }

    // 通话消息
    if (message.localType === 50) {
      const raw = message.rawContent || ''
      const isVideoCall = /<room_type>0<\/room_type>/.test(raw)
      const Icon = isVideoCall ? Video : Phone
      return (
        <div className="bubble-content" style={{ display: 'flex', alignItems: 'center', gap: 6, flexDirection: isSent ? 'row-reverse' : 'row' }}>
          <Icon size={16} style={{ transform: isSent ? 'scaleX(-1)' : undefined }} />
          <span>{message.parsedContent}</span>
        </div>
      )
    }

    // 调试非文本类型的未适配消息
    if (message.localType !== 1) {
      console.log('[ChatPage] 未适配的消息:', message)
    }
    // 普通消息
    return <div className="bubble-content"><MessageContent content={message.parsedContent} /></div>
  }

  return (
    <>
      {showTime && (
        <div className="time-divider">
          <span>{formatTime(message.createTime)}</span>
        </div>
      )}
      <div
        ref={bubbleRef}
        className={`message-bubble ${bubbleClass} ${isEmoji && message.emojiCdnUrl && !emojiError ? 'emoji' : ''} ${isImage ? 'image' : ''} ${isVideo ? 'video' : ''} ${isVoice ? 'voice' : ''} ${isSelected ? 'selected' : ''}`}
        onContextMenu={(e) => {
          if (onContextMenu) {
            onContextMenu(e, message, {
              reTranscribe: isVoice ? () => handleTranscribeVoice(undefined, true) : undefined,
              editStt: (isVoice && sttTranscript) ? () => {
                setEditContent(sttTranscript)
                setIsEditingStt(true)
              } : undefined
            })
          }
        }}
      >
        <div className="bubble-avatar">
          {isLoadingSender && isGroupChat && !isSent ? (
            <div className="avatar-skeleton-wrapper">
              <span className="avatar-skeleton" />
            </div>
          ) : avatarUrl ? (
            <img src={avatarUrl} alt="" />
          ) : (
            <span className="avatar-letter">{avatarLetter}</span>
          )}
        </div>
        <div className="bubble-body">
          {/* 群聊中显示发送者名称 */}
          {isGroupChat && !isSent && (
            <div className="sender-name">
              {isLoadingSender ? (
                <span className="sender-skeleton" />
              ) : (
                senderName || '群成员'
              )}
            </div>
          )}
          {renderContent()}

          {/* 引用消息 - 移至下方，单行显示 */}
          {hasQuote && quoteStyle === 'wechat' && (
            <div className="bubble-quote">
              <div className="quote-content" onClick={(quotedImageLocalPath || quotedEmojiLocalPath) ? (e) => { e.stopPropagation(); window.electronAPI.window.openImageViewerWindow((quotedImageLocalPath || quotedEmojiLocalPath)!) } : undefined} style={(quotedImageLocalPath || quotedEmojiLocalPath) ? { cursor: 'pointer' } : undefined}>
                <span className="quote-text">
                  {(() => {
                    let sender = message.quotedSender
                    if (!sender && message.rawContent) {
                      const match = message.rawContent.match(/<displayname>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/displayname>/)
                      if (match) sender = match[1]
                    }
                    return sender ? <span className="quote-sender">{sender}: </span> : null
                  })()}
                  {(quotedImageLocalPath || quotedEmojiLocalPath) ? null : message.quotedContent}
                </span>
                {quotedImageLocalPath && (
                  <img src={quotedImageLocalPath} alt="" className="quote-image-thumb" />
                )}
                {!quotedImageLocalPath && quotedEmojiLocalPath && (
                  <img src={quotedEmojiLocalPath} alt="表情" className="quote-image-thumb" />
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  )
}


function areMessageBubblePropsEqual(prev: MessageBubbleProps, next: MessageBubbleProps) {
  return prev.message === next.message &&
    prev.session === next.session &&
    prev.showTime === next.showTime &&
    prev.myAvatarUrl === next.myAvatarUrl &&
    prev.isGroupChat === next.isGroupChat &&
    prev.hasImageKey === next.hasImageKey &&
    prev.isSelected === next.isSelected &&
    prev.quoteStyle === next.quoteStyle
}

export default memo(MessageBubble, areMessageBubblePropsEqual)
