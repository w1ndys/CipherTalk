import type { Contact, Message } from '../../chatService'
import { voiceTranscribeService } from '../../voiceTranscribeService'
import type { AnalysisBlock, StandardizedAnalysisMessage } from '../types/analysis'

export const ANALYSIS_MAX_MESSAGE_CHARS = 800
export const ANALYSIS_BLOCK_MAX_MESSAGES = 120
export const ANALYSIS_BLOCK_MAX_CHARS = 12000
export const ANALYSIS_BLOCK_OVERLAP_MESSAGES = 12

function formatTimestamp(timestampSeconds: number): string {
  const date = new Date(timestampSeconds * 1000)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

function truncateStandardizedLine(line: string): string {
  if (line.length <= ANALYSIS_MAX_MESSAGE_CHARS) {
    return line
  }

  const suffix = '...[已截断]'
  return `${line.slice(0, ANALYSIS_MAX_MESSAGE_CHARS - suffix.length).trimEnd()}${suffix}`
}

function detectMessageType(parsedContent: string, localType: number): string {
  if (parsedContent.startsWith('[图片]')) return '图片'
  if (parsedContent.startsWith('[视频]')) return '视频'
  if (parsedContent.startsWith('[动画表情]') || parsedContent.startsWith('[表情包]')) return '表情包'
  if (parsedContent.startsWith('[文件]')) return '文件'
  if (parsedContent.startsWith('[转账]')) return '转账'
  if (parsedContent.startsWith('[链接]')) return '链接'
  if (parsedContent.startsWith('[小程序]')) return '小程序'
  if (parsedContent.startsWith('[聊天记录]')) return '聊天记录'
  if (parsedContent.startsWith('[引用消息]') || localType === 244813135921) return '引用'
  if (parsedContent.startsWith('[位置]')) return '位置'
  if (parsedContent.startsWith('[名片]')) return '名片'
  if (parsedContent.startsWith('[通话]')) return '通话'
  if (localType === 10000) return '系统'
  if (localType === 1) return '文本'
  return '未知'
}

function formatStandardizedLine(sender: string, time: string, messageType: string, content: string): string {
  if (messageType === '系统') {
    return `[系统消息] {${time} ${content}}`
  }

  if (messageType === '图片') {
    return `[图片] {${sender}：${time}}`
  }

  if (messageType === '视频') {
    return `[视频] {${sender}：${time}}`
  }

  if (messageType === '表情包') {
    return `[表情包] {${sender}：${time}}`
  }

  return `[${messageType}] {${sender}：${time} ${content}}`
}

function buildChatRecordContent(message: Message): string {
  const recordCount = message.chatRecordList?.length || 0
  const recordLines: string[] = []
  let title = '聊天记录'

  if (message.parsedContent && message.parsedContent.startsWith('[聊天记录]')) {
    title = message.parsedContent.replace('[聊天记录]', '').trim() || '聊天记录'
  }

  recordLines.push(title)
  recordLines.push(`共${recordCount}条消息：`)

  message.chatRecordList?.forEach((record, index) => {
    const recordSender = record.sourcename || '未知'
    let recordContent = ''

    if (record.datatype === 1) {
      recordContent = record.datadesc || record.datatitle || ''
    } else if (record.datatype === 3) {
      recordContent = '[图片]'
    } else if (record.datatype === 34) {
      recordContent = '[语音]'
    } else if (record.datatype === 43) {
      recordContent = '[视频]'
    } else if (record.datatype === 47) {
      recordContent = '[表情包]'
    } else if (record.datatype === 8 || record.datatype === 49) {
      recordContent = `[文件] ${record.datatitle || record.datadesc || ''}`
    } else {
      recordContent = record.datadesc || record.datatitle || '[媒体消息]'
    }

    recordLines.push(`  第${index + 1}条 - ${recordSender}: ${recordContent}`)
  })

  return recordLines.join('\n')
}

export function standardizeMessagesForAnalysis(
  messages: Message[],
  contacts: Map<string, Contact>,
  sessionId: string
): StandardizedAnalysisMessage[] {
  const sortedMessages = [...messages].sort((a, b) =>
    Number(a.createTime || 0) - Number(b.createTime || 0)
    || Number(a.sortSeq || 0) - Number(b.sortSeq || 0)
    || Number(a.localId || 0) - Number(b.localId || 0)
  )

  const standardized: StandardizedAnalysisMessage[] = []

  for (const message of sortedMessages) {
    const contact = contacts.get(message.senderUsername || '')
    const sender = contact?.remark || contact?.nickName || message.senderUsername || '未知'
    const time = formatTimestamp(message.createTime)

    let content = ''
    let messageType = '文本'

    if (message.chatRecordList && message.chatRecordList.length > 0) {
      messageType = '聊天记录'
      content = buildChatRecordContent(message)
    } else if (message.localType === 34) {
      messageType = '语音'
      const transcript = voiceTranscribeService.getCachedTranscript(sessionId, message.createTime)
      content = transcript || message.parsedContent || '[语音消息]'
    } else if (message.localType === 10002) {
      continue
    } else {
      content = message.parsedContent || '[消息]'
      messageType = detectMessageType(content, message.localType)
    }

    if (!content && messageType !== '图片' && messageType !== '视频' && messageType !== '表情包') {
      continue
    }

    const formattedLine = truncateStandardizedLine(formatStandardizedLine(sender, time, messageType, content))
    standardized.push({
      messageKey: `${message.createTime}:${message.sortSeq}:${message.localId}`,
      localId: message.localId,
      createTime: message.createTime,
      sortSeq: message.sortSeq,
      sender,
      senderUsername: message.senderUsername || undefined,
      messageType,
      content,
      formattedLine,
      charCount: formattedLine.length
    })
  }

  return standardized
}

export function renderStandardizedMessages(messages: StandardizedAnalysisMessage[]): string {
  return messages.map((message) => message.formattedLine).join('\n')
}

export function sliceAnalysisBlocks(messages: StandardizedAnalysisMessage[]): AnalysisBlock[] {
  if (messages.length === 0) {
    return []
  }

  const blocks: AnalysisBlock[] = []
  let startIndex = 0

  while (startIndex < messages.length) {
    let endIndex = startIndex
    let charCount = 0

    while (endIndex < messages.length) {
      const nextMessage = messages[endIndex]
      const nextCount = endIndex - startIndex + 1
      const nextCharCount = charCount + nextMessage.charCount + (endIndex > startIndex ? 1 : 0)

      if (nextCount > ANALYSIS_BLOCK_MAX_MESSAGES || nextCharCount > ANALYSIS_BLOCK_MAX_CHARS) {
        break
      }

      charCount = nextCharCount
      endIndex += 1
    }

    if (endIndex === startIndex) {
      endIndex = startIndex + 1
      charCount = messages[startIndex].charCount
    }

    const blockMessages = messages.slice(startIndex, endIndex)
    const renderedText = renderStandardizedMessages(blockMessages)

    blocks.push({
      blockId: `block_${blocks.length + 1}`,
      index: blocks.length,
      messages: blockMessages,
      renderedText,
      messageCount: blockMessages.length,
      charCount: renderedText.length,
      startTime: blockMessages[0].createTime,
      endTime: blockMessages[blockMessages.length - 1].createTime
    })

    if (endIndex >= messages.length) {
      break
    }

    const overlapCount = Math.min(ANALYSIS_BLOCK_OVERLAP_MESSAGES, Math.max(0, blockMessages.length - 1))
    startIndex = endIndex - overlapCount
  }

  return blocks
}
