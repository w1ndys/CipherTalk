import { ipcMain } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { chatService } from '../../services/chatService'
import { cancelSessionVectorIndexJob, getSessionVectorIndexStateForUi, startSessionVectorIndexJob } from '../workers/sessionVectorIndexJobs'
import { getSessionMemoryBuildStateForUi, startSessionMemoryBuildJob } from '../workers/sessionMemoryBuildJobs'
import type { MainProcessContext } from '../context'

/**
 * AI IPC。
 * 摘要流、QA 流、向量索引和记忆构建都保留原事件名；Worker 生命周期交给 workers 模块管理。
 */
export function registerAiHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('ai:getProviders', async () => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      return aiService.getAllProviders()
    } catch (e) {
      console.error('[AI] 获取提供商列表失败:', e)
      return []
    }
  })

  ipcMain.handle('ai:generatePosterTheme', async (_, options: {
    description: string
    provider?: string
    apiKey?: string
    model?: string
  }) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      const css = await aiService.generatePosterTheme(options)
      return { success: true, css }
    } catch (e) {
      console.error('[AI] 生成海报主题失败:', e)
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  })

  // 代理相关
  ipcMain.handle('ai:getProxyStatus', async () => {
    try {
      const { proxyService } = await import('../../services/ai/proxyService')
      const proxyUrl = await proxyService.getSystemProxy()
      return {
        success: true,
        hasProxy: !!proxyUrl,
        proxyUrl: proxyUrl || null
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:refreshProxy', async () => {
    try {
      const { proxyService } = await import('../../services/ai/proxyService')
      proxyService.clearCache()
      const proxyUrl = await proxyService.getSystemProxy()
      return {
        success: true,
        hasProxy: !!proxyUrl,
        proxyUrl: proxyUrl || null,
        message: proxyUrl ? `已刷新代理: ${proxyUrl}` : '未检测到代理，使用直连'
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:testProxy', async (_, proxyUrl: string, testUrl?: string) => {
    try {
      const { proxyService } = await import('../../services/ai/proxyService')
      const success = await proxyService.testProxy(proxyUrl, testUrl)
      return {
        success,
        message: success ? '代理连接正常' : '代理连接失败'
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:testConnection', async (_, provider: string, apiKey: string) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      return await aiService.testConnection(provider, apiKey)
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:estimateCost', async (_, messageCount: number, provider: string) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      // 简单估算：每条消息约50个字符，约33 tokens
      const estimatedTokens = messageCount * 33
      const cost = aiService.estimateCost(estimatedTokens, provider)
      return { success: true, tokens: estimatedTokens, cost }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getUsageStats', async (_, startDate?: string, endDate?: string) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      const stats = aiService.getUsageStats(startDate, endDate)
      return { success: true, stats }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getSummaryHistory', async (_, sessionId: string, limit?: number) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      const history = aiService.getSummaryHistory(sessionId, limit)
      return { success: true, history }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:listSessionQAConversations', async (_, sessionId: string, limit?: number) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      return { success: true, conversations: aiService.listSessionQAConversations(sessionId, limit) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getSessionQAConversation', async (_, conversationId: number) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      const conversation = aiService.getSessionQAConversation(conversationId)
      return conversation
        ? { success: true, conversation }
        : { success: false, error: '问答会话不存在或已删除' }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:createSessionQAConversation', async (_, options: {
    sessionId: string
    sessionName?: string
    linkedSummaryId?: number
  }) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      return { success: true, conversation: aiService.createSessionQAConversation(options) }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:renameSessionQAConversation', async (_, conversationId: number, title: string) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      const success = aiService.renameSessionQAConversation(conversationId, title)
      return { success }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:deleteSessionQAConversation', async (_, conversationId: number) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      const success = aiService.deleteSessionQAConversation(conversationId)
      return { success }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:deleteSummary', async (_, id: number) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      const success = aiService.deleteSummary(id)
      return { success }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:renameSummary', async (_, id: number, customName: string) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      const success = aiService.renameSummary(id, customName)
      return { success }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:cleanExpiredCache', async () => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      aiService.cleanExpiredCache()
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  // 读取 AI 服务使用指南
  ipcMain.handle('ai:readGuide', async (_, guideName: string) => {
    try {
      const guidePath = join(__dirname, '../electron/services/ai', guideName)
      if (!existsSync(guidePath)) {
        return { success: false, error: '指南文件不存在' }
      }
      const content = readFileSync(guidePath, 'utf-8')
      return { success: true, content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:generateSummary', async (event, sessionId: string, timeRange: number, options: {
    provider: string
    apiKey: string
    model: string
    detail: 'simple' | 'normal' | 'detailed'
    systemPromptPreset?: 'default' | 'decision-focus' | 'action-focus' | 'risk-focus' | 'custom'
    customSystemPrompt?: string
    customRequirement?: string
    sessionName?: string
    enableThinking?: boolean
  }) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')

      // 初始化服务
      aiService.init()

      // 计算时间范围
      const endTime = Math.floor(Date.now() / 1000)
      const startTime = timeRange > 0 ? endTime - (timeRange * 24 * 60 * 60) : undefined

      // 获取指定时间范围内的消息，超出上限时优先保留范围内最新消息。
      const messageLimit = ctx.getConfigService()?.get('aiMessageLimit') || 3000
      const messagesResult = await chatService.getMessagesByTimeRangeForSummary(sessionId, {
        startTime,
        endTime,
        limit: messageLimit
      })
      if (!messagesResult.success || !messagesResult.messages) {
        return { success: false, error: '获取消息失败' }
      }

      const summaryMessages = messagesResult.messages
      if (summaryMessages.length === 0) {
        return { success: false, error: '该时间范围内没有消息' }
      }

      const actualTimeRangeStart = startTime ?? summaryMessages[0].createTime
      const inputMessageScopeNote = messagesResult.hasMore
        ? `当前时间范围内消息较多，本次仅分析其中最新 ${summaryMessages.length} 条消息。请明确基于这批最新消息归纳重点，避免误判为已覆盖完整时间范围。`
        : undefined

      // 获取消息中所有发送者的联系人信息
      const contacts = new Map()
      const senderSet = new Set<string>()

      // 添加会话对象
      senderSet.add(sessionId)

      // 添加所有消息发送者
      summaryMessages.forEach((msg: any) => {
        if (msg.senderUsername) {
          senderSet.add(msg.senderUsername)
        }
      })

      // 添加自己
      const myWxid = ctx.getConfigService()?.get('myWxid')
      if (myWxid) {
        senderSet.add(myWxid)
      }

      // 批量获取联系人信息
      for (const username of Array.from(senderSet)) {
        // 如果是自己，优先尝试获取详细用户信息
        if (username === myWxid) {
          const selfInfo = await chatService.getMyUserInfo()
          if (selfInfo.success && selfInfo.userInfo) {
            contacts.set(username, {
              username: selfInfo.userInfo.wxid,
              remark: '',
              nickName: selfInfo.userInfo.nickName,
              alias: selfInfo.userInfo.alias
            })
            continue // 已获取到，跳过后续常规查找
          }
        }

        // 常规查找
        const contact = await chatService.getContact(username)
        if (contact) {
          contacts.set(username, contact)
        }
      }

      // 生成摘要（流式输出）
      const result = await aiService.generateSummary(
        summaryMessages,
        contacts,
        {
          sessionId,
          timeRangeDays: timeRange,
          timeRangeStart: actualTimeRangeStart,
          timeRangeEnd: endTime,
          inputMessageScopeNote,
          provider: options.provider,
          apiKey: options.apiKey,
          model: options.model,
          detail: options.detail,
          systemPromptPreset: options.systemPromptPreset,
          customSystemPrompt: options.customSystemPrompt,
          customRequirement: options.customRequirement,
          sessionName: options.sessionName,
          enableThinking: options.enableThinking
        },
        (chunk: string) => {
          // 发送流式数据到渲染进程
          event.sender.send('ai:summaryChunk', chunk)
        }
      )

      if (process.env.NODE_ENV === 'development') {
        console.log('[AI] 摘要生成完成，结果:', {
          sessionId: result.sessionId,
          messageCount: result.messageCount,
          hasMore: Boolean(messagesResult.hasMore),
          summaryLength: result.summaryText?.length || 0
        })
      }

      return { success: true, result }
    } catch (e) {
      console.error('[AI] 生成摘要失败:', e)
      ctx.getLogService()?.error('AI', '生成摘要失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:askSessionQuestion', async (event, options: {
    sessionId: string
    sessionName?: string
    question: string
    summaryText?: string
    structuredAnalysis?: any
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    provider: string
    apiKey: string
    model: string
    enableThinking?: boolean
  }) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')

      aiService.init()

      const result = await aiService.answerSessionQuestion(
        {
          sessionId: options.sessionId,
          sessionName: options.sessionName,
          question: options.question,
          summaryText: options.summaryText,
          structuredAnalysis: options.structuredAnalysis,
          history: options.history,
          provider: options.provider,
          apiKey: options.apiKey,
          model: options.model,
          enableThinking: options.enableThinking
        },
        (streamEvent) => {
          if (streamEvent.type === 'content_delta') {
            event.sender.send('ai:sessionQaChunk', streamEvent.text)
          }
        },
        (progress) => {
          event.sender.send('ai:sessionQaProgress', progress)
        }
      )

      return { success: true, result }
    } catch (e) {
      console.error('[AI] 单会话问答失败:', e)
      ctx.getLogService()?.error('AI', '单会话问答失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:startSessionQuestion', async (event, options: {
    requestId?: string
    conversationId?: number
    sessionId: string
    sessionName?: string
    question: string
    summaryText?: string
    structuredAnalysis?: any
    history?: Array<{ role: 'user' | 'assistant'; content: string }>
    provider: string
    apiKey: string
    model: string
    enableThinking?: boolean
  }) => {
    try {
      const { sessionQAJobService } = await import('../../services/ai/sessionQAJobService')
      return sessionQAJobService.start(options, event.sender)
    } catch (e) {
      console.error('[AI] 启动单会话问答任务失败:', e)
      ctx.getLogService()?.error('AI', '启动单会话问答任务失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:cancelSessionQuestion', async (_, requestId: string) => {
    try {
      const { sessionQAJobService } = await import('../../services/ai/sessionQAJobService')
      return await sessionQAJobService.cancel(requestId)
    } catch (e) {
      console.error('[AI] 取消单会话问答任务失败:', e)
      ctx.getLogService()?.error('AI', '取消单会话问答任务失败', { error: String(e) })
      return { success: false, requestId, error: String(e) }
    }
  })

  ipcMain.handle('ai:getSessionVectorIndexState', async (_, sessionId: string) => {
    try {
      return {
        success: true,
        result: await getSessionVectorIndexStateForUi(sessionId)
      }
    } catch (e) {
      console.error('[AI] 获取会话向量索引状态失败:', e)
      ctx.getLogService()?.error('AI', '获取会话向量索引状态失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:prepareSessionVectorIndex', async (event, options: { sessionId: string }) => {
    try {
      const result = await startSessionVectorIndexJob(options.sessionId, event.sender)
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 准备会话向量索引失败:', e)
      ctx.getLogService()?.error('AI', '准备会话向量索引失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:cancelSessionVectorIndex', async (_, sessionId: string) => {
    try {
      return await cancelSessionVectorIndexJob(sessionId)
    } catch (e) {
      console.error('[AI] 取消会话向量索引失败:', e)
      ctx.getLogService()?.error('AI', '取消会话向量索引失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getSessionMemoryBuildState', async (_, sessionId: string) => {
    try {
      return {
        success: true,
        result: await getSessionMemoryBuildStateForUi(sessionId)
      }
    } catch (e) {
      console.error('[AI] 获取会话记忆构建状态失败:', e)
      ctx.getLogService()?.error('AI', '获取会话记忆构建状态失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:prepareSessionMemory', async (event, options: { sessionId: string }) => {
    try {
      const sessionId = String(options?.sessionId || '').trim()
      if (!sessionId) {
        return { success: false, error: 'sessionId 不能为空' }
      }

      const result = await startSessionMemoryBuildJob(sessionId, event.sender)
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 构建会话记忆失败:', e)
      ctx.getLogService()?.error('AI', '构建会话记忆失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getSessionProfileMemoryState', async (_, sessionId: string) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      aiService.init()
      return {
        success: true,
        result: aiService.getSessionProfileMemoryState(String(sessionId || '').trim())
      }
    } catch (e) {
      console.error('[AI] 获取会话画像记忆状态失败:', e)
      ctx.getLogService()?.error('AI', '获取会话画像记忆状态失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:buildSessionProfileMemory', async (_, options: {
    sessionId: string
    sessionName?: string
    provider: string
    apiKey: string
    model: string
  }) => {
    try {
      const { aiService } = await import('../../services/ai/aiService')
      aiService.init()
      const result = await aiService.buildSessionProfileMemory({
        sessionId: options.sessionId,
        sessionName: options.sessionName,
        provider: options.provider,
        apiKey: options.apiKey,
        model: options.model
      })
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 构建会话画像记忆失败:', e)
      ctx.getLogService()?.error('AI', '构建会话画像记忆失败', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getEmbeddingModelProfiles', async () => {
    try {
      const { localEmbeddingModelService } = await import('../../services/search/embeddingModelService')
      const { embeddingRuntimeService } = await import('../../services/search/embeddingRuntimeService')
      return {
        success: true,
        result: localEmbeddingModelService.listProfiles(),
        currentProfileId: localEmbeddingModelService.getCurrentProfileId(),
        embeddingMode: embeddingRuntimeService.getMode()
      }
    } catch (e) {
      console.error('[AI] 获取语义模型列表失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:setEmbeddingMode', async (_, mode: string) => {
    try {
      const { embeddingRuntimeService } = await import('../../services/search/embeddingRuntimeService')
      const result = embeddingRuntimeService.setMode(mode)
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 设置语义向量模式失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:setEmbeddingModelProfile', async (_, profileId: string) => {
    try {
      const { localEmbeddingModelService } = await import('../../services/search/embeddingModelService')
      const result = localEmbeddingModelService.setCurrentProfileId(profileId)
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 设置语义模型失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:setEmbeddingVectorDim', async (_, profileId: string, dim: number) => {
    try {
      const { localEmbeddingModelService } = await import('../../services/search/embeddingModelService')
      const result = localEmbeddingModelService.setVectorDim(profileId, dim)
      return {
        success: true,
        result,
        vectorModelId: localEmbeddingModelService.getVectorModelId(profileId)
      }
    } catch (e) {
      console.error('[AI] 设置语义向量维度失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getEmbeddingDeviceStatus', async () => {
    try {
      const { localEmbeddingModelService } = await import('../../services/search/embeddingModelService')
      const { embeddingRuntimeService } = await import('../../services/search/embeddingRuntimeService')
      return {
        success: true,
        result: localEmbeddingModelService.getDeviceStatus(),
        embeddingMode: embeddingRuntimeService.getMode()
      }
    } catch (e) {
      console.error('[AI] 获取语义向量计算模式失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:setEmbeddingDevice', async (_, device: string) => {
    try {
      const { localEmbeddingModelService } = await import('../../services/search/embeddingModelService')
      const result = localEmbeddingModelService.setCurrentDevice(device)
      return {
        success: true,
        result,
        status: localEmbeddingModelService.getDeviceStatus()
      }
    } catch (e) {
      console.error('[AI] 设置语义向量计算模式失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getEmbeddingModelStatus', async (_, profileId?: string) => {
    try {
      const { localEmbeddingModelService } = await import('../../services/search/embeddingModelService')
      return {
        success: true,
        result: await localEmbeddingModelService.getModelStatus(profileId)
      }
    } catch (e) {
      console.error('[AI] 获取语义模型状态失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:downloadEmbeddingModel', async (event, profileId?: string) => {
    try {
      const { localEmbeddingModelService } = await import('../../services/search/embeddingModelService')
      const result = await localEmbeddingModelService.downloadModel(profileId, (progress) => {
        event.sender.send('ai:embeddingModelDownloadProgress', progress)
      })
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 下载语义模型失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:cancelEmbeddingModelDownload', async (_, profileId?: string) => {
    try {
      const { localEmbeddingModelService } = await import('../../services/search/embeddingModelService')
      return localEmbeddingModelService.cancelDownloadModel(profileId)
    } catch (e) {
      console.error('[AI] 暂停语义模型下载失败:', e)
      return { success: false, cancelled: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:clearEmbeddingModel', async (_, profileId?: string) => {
    try {
      const { localEmbeddingModelService } = await import('../../services/search/embeddingModelService')
      return {
        success: true,
        result: await localEmbeddingModelService.clearModel(profileId)
      }
    } catch (e) {
      console.error('[AI] 清理语义模型失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:getOnlineEmbeddingProviders', async () => {
    try {
      const { onlineEmbeddingService } = await import('../../services/search/onlineEmbeddingService')
      return {
        success: true,
        result: onlineEmbeddingService.listProviders()
      }
    } catch (e) {
      console.error('[AI] 获取在线向量厂商失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:listOnlineEmbeddingConfigs', async () => {
    try {
      const { onlineEmbeddingService } = await import('../../services/search/onlineEmbeddingService')
      return {
        success: true,
        result: onlineEmbeddingService.listConfigs(),
        currentConfigId: onlineEmbeddingService.getCurrentConfigId()
      }
    } catch (e) {
      console.error('[AI] 获取在线向量配置失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:saveOnlineEmbeddingConfig', async (_, payload: any) => {
    try {
      const { onlineEmbeddingService } = await import('../../services/search/onlineEmbeddingService')
      return {
        success: true,
        result: await onlineEmbeddingService.saveConfig(payload)
      }
    } catch (e) {
      console.error('[AI] 保存在线向量配置失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:deleteOnlineEmbeddingConfig', async (_, configId: string) => {
    try {
      const { onlineEmbeddingService } = await import('../../services/search/onlineEmbeddingService')
      return {
        success: true,
        result: onlineEmbeddingService.deleteConfig(configId)
      }
    } catch (e) {
      console.error('[AI] 删除在线向量配置失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:setCurrentOnlineEmbeddingConfig', async (_, configId: string) => {
    try {
      const { onlineEmbeddingService } = await import('../../services/search/onlineEmbeddingService')
      const result = onlineEmbeddingService.setCurrentConfig(configId)
      if (!result) {
        return { success: false, error: '在线向量配置不存在' }
      }
      return { success: true, result }
    } catch (e) {
      console.error('[AI] 切换在线向量配置失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:testOnlineEmbeddingConfig', async (_, payload: any) => {
    try {
      const { onlineEmbeddingService } = await import('../../services/search/onlineEmbeddingService')
      return {
        success: true,
        result: await onlineEmbeddingService.testConfig(payload)
      }
    } catch (e) {
      console.error('[AI] 测试在线向量配置失败:', e)
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('ai:clearSemanticVectorIndex', async (_, vectorModel?: string) => {
    try {
      const { chatSearchIndexService } = await import('../../services/search/chatSearchIndexService')
      return {
        success: true,
        result: chatSearchIndexService.clearSemanticVectorIndex(vectorModel)
      }
    } catch (e) {
      console.error('[AI] 清理语义向量索引失败:', e)
      return { success: false, error: String(e) }
    }
  })

}
