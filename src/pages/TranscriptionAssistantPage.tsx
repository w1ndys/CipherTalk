import { useMemo, useState, type DragEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  CheckCircle2,
  ClipboardCopy,
  FileAudio,
  Loader2,
  RotateCcw,
  Settings,
  Trash2,
  UploadCloud
} from 'lucide-react'
import * as configService from '../services/config'
import './TranscriptionAssistantPage.scss'

type SttMode = 'cpu' | 'gpu' | 'online'
type TaskStatus = 'processing' | 'success' | 'failed'
type TranscriptionErrorCode = 'BAD_REQUEST' | 'STT_NOT_READY' | 'INTERNAL_ERROR'

type TranscriptionTask = {
  id: string
  fileName: string
  filePath: string
  createdAt: number
  status: TaskStatus
  transcript?: string
  error?: string
  errorCode?: TranscriptionErrorCode
  sttMode?: SttMode
}

const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'amr']
const HISTORY_LIMIT = 20

function getFileName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath || '未命名音频'
}

function getExtension(filePath: string): string {
  const fileName = getFileName(filePath)
  const dotIndex = fileName.lastIndexOf('.')
  return dotIndex >= 0 ? fileName.slice(dotIndex + 1).toLowerCase() : ''
}

function isSupportedAudioPath(filePath: string): boolean {
  return AUDIO_EXTENSIONS.includes(getExtension(filePath))
}

function createTaskId(): string {
  return `stt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function formatTaskTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

function getModeLabel(mode?: SttMode): string {
  if (mode === 'gpu') return 'GPU'
  if (mode === 'online') return '在线'
  if (mode === 'cpu') return 'CPU'
  return '读取中'
}

function getStatusLabel(status: TaskStatus): string {
  if (status === 'processing') return '处理中'
  if (status === 'success') return '成功'
  return '失败'
}

function TranscriptionAssistantPage() {
  const navigate = useNavigate()
  const [history, setHistory] = useState<TranscriptionTask[]>([])
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [copiedTaskId, setCopiedTaskId] = useState<string | null>(null)

  const activeTask = useMemo(() => {
    if (!activeTaskId) return history[0] || null
    return history.find(item => item.id === activeTaskId) || history[0] || null
  }, [activeTaskId, history])

  const isProcessing = history.some(item => item.status === 'processing')

  const pushTask = (task: TranscriptionTask) => {
    setHistory(prev => [task, ...prev.filter(item => item.id !== task.id)].slice(0, HISTORY_LIMIT))
    setActiveTaskId(task.id)
  }

  const pushFailedTask = (filePath: string, error: string, errorCode: TranscriptionErrorCode = 'BAD_REQUEST') => {
    pushTask({
      id: createTaskId(),
      fileName: getFileName(filePath),
      filePath,
      createdAt: Date.now(),
      status: 'failed',
      error,
      errorCode
    })
  }

  const openSttSettings = () => {
    navigate('/settings?tab=stt')
  }

  const transcribeFile = async (rawFilePath: string) => {
    const filePath = String(rawFilePath || '').trim()
    if (!filePath) {
      pushFailedTask('未选择文件', '未读取到音频文件路径')
      return
    }

    if (!isSupportedAudioPath(filePath)) {
      pushFailedTask(filePath, `不支持的音频格式: ${getExtension(filePath) || 'unknown'}`)
      return
    }

    if (isProcessing) return

    const taskId = createTaskId()
    let currentMode: SttMode | undefined
    try {
      currentMode = await configService.getSttMode()
    } catch {
      currentMode = undefined
    }

    pushTask({
      id: taskId,
      fileName: getFileName(filePath),
      filePath,
      createdAt: Date.now(),
      status: 'processing',
      sttMode: currentMode
    })

    try {
      const result = await window.electronAPI.stt.transcribeAudioFile(filePath)
      setHistory(prev => prev.map(item => item.id === taskId
        ? {
            ...item,
            status: result.success && result.transcript ? 'success' : 'failed',
            transcript: result.transcript,
            error: result.success ? undefined : (result.error || '转写失败'),
            errorCode: result.errorCode,
            sttMode: result.sttMode || currentMode
          }
        : item
      ))
    } catch (error) {
      setHistory(prev => prev.map(item => item.id === taskId
        ? {
            ...item,
            status: 'failed',
            error: String(error),
            errorCode: 'INTERNAL_ERROR',
            sttMode: currentMode
          }
        : item
      ))
    }
  }

  const openFileDialog = async () => {
    if (isProcessing) return
    const result = await window.electronAPI.dialog.openFile({
      title: '选择音频文件',
      filters: [{ name: '音频文件', extensions: AUDIO_EXTENSIONS }],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths?.[0]) return
    await transcribeFile(result.filePaths[0])
  }

  const handleDrop = async (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault()
    setIsDragging(false)
    if (isProcessing) return

    const file = event.dataTransfer.files?.[0] as (File & { path?: string }) | undefined
    const filePath = file?.path || ''
    if (!filePath) {
      pushFailedTask(file?.name || '拖入文件', '无法读取拖入文件的本地路径，请使用“选择音频”')
      return
    }
    await transcribeFile(filePath)
  }

  const copyTranscript = async (task: TranscriptionTask) => {
    if (!task.transcript) return
    await navigator.clipboard.writeText(task.transcript)
    setCopiedTaskId(task.id)
    window.setTimeout(() => {
      setCopiedTaskId(current => current === task.id ? null : current)
    }, 1600)
  }

  const clearActiveTask = () => {
    if (!activeTask) return
    setHistory(prev => prev.filter(item => item.id !== activeTask.id))
    setActiveTaskId(null)
  }

  return (
    <div className="transcription-assistant-page">
      <header className="transcription-assistant-header">
        <div>
          <h1>转文字助手</h1>
          <p>选择本地音频文件，按当前语音转文字配置生成文本。</p>
        </div>
        <button type="button" className="secondary-action" onClick={openSttSettings}>
          <Settings size={18} />
          <span>语音设置</span>
        </button>
      </header>

      <button
        type="button"
        className={`audio-dropzone ${isDragging ? 'dragging' : ''}`}
        disabled={isProcessing}
        onClick={() => void openFileDialog()}
        onDragEnter={(event) => {
          event.preventDefault()
          if (!isProcessing) setIsDragging(true)
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => void handleDrop(event)}
      >
        <span className="dropzone-icon">
          <UploadCloud size={30} />
        </span>
        <span className="dropzone-title">选择或拖入音频文件</span>
        <span className="dropzone-meta">mp3 / wav / m4a / aac / flac / ogg / opus / amr</span>
        <span className="dropzone-action">
          <FileAudio size={18} />
          <span>{isProcessing ? '转写中' : '选择音频'}</span>
        </span>
      </button>

      <section className="task-panel">
        <div className="panel-heading">
          <h2>当前任务</h2>
          {activeTask && (
            <span className={`status-pill ${activeTask.status}`}>
              {activeTask.status === 'processing' && <Loader2 size={14} className="spin" />}
              {activeTask.status === 'success' && <CheckCircle2 size={14} />}
              {activeTask.status === 'failed' && <AlertCircle size={14} />}
              {getStatusLabel(activeTask.status)}
            </span>
          )}
        </div>

        {activeTask ? (
          <div className="current-task">
            <div className="current-task-main">
              <FileAudio size={22} />
              <div>
                <strong>{activeTask.fileName}</strong>
                <span>{activeTask.filePath}</span>
              </div>
            </div>
            <div className="current-task-meta">
              <span>模式：{getModeLabel(activeTask.sttMode)}</span>
              <span>{formatTaskTime(activeTask.createdAt)}</span>
            </div>
          </div>
        ) : (
          <div className="empty-state">暂无任务</div>
        )}
      </section>

      <section className="result-panel">
        <div className="panel-heading">
          <h2>转写结果</h2>
        </div>

        {activeTask?.status === 'success' ? (
          <>
            <textarea className="transcript-output" readOnly value={activeTask.transcript || ''} />
            <div className="result-actions">
              <button type="button" className="primary-action" onClick={() => void copyTranscript(activeTask)}>
                <ClipboardCopy size={17} />
                <span>{copiedTaskId === activeTask.id ? '已复制' : '复制文本'}</span>
              </button>
              <button type="button" className="secondary-action" onClick={clearActiveTask}>
                <Trash2 size={17} />
                <span>清空结果</span>
              </button>
              <button type="button" className="secondary-action" onClick={() => void openFileDialog()} disabled={isProcessing}>
                <RotateCcw size={17} />
                <span>重新选择</span>
              </button>
            </div>
          </>
        ) : activeTask?.status === 'failed' ? (
          <div className="error-state">
            <AlertCircle size={22} />
            <div>
              <strong>{activeTask.errorCode || '转写失败'}</strong>
              <p>{activeTask.error || '请稍后重试'}</p>
              {activeTask.errorCode === 'STT_NOT_READY' && (
                <button type="button" className="primary-action compact" onClick={openSttSettings}>
                  <Settings size={16} />
                  <span>去语音转文字设置</span>
                </button>
              )}
            </div>
          </div>
        ) : activeTask?.status === 'processing' ? (
          <div className="processing-state">
            <Loader2 size={24} className="spin" />
            <span>正在转写音频</span>
          </div>
        ) : (
          <div className="empty-state">选择音频后显示转写文本</div>
        )}
      </section>

      <section className="history-panel">
        <div className="panel-heading">
          <h2>最近任务</h2>
          <span>{history.length}/{HISTORY_LIMIT}</span>
        </div>

        {history.length > 0 ? (
          <div className="history-list">
            {history.map(task => (
              <button
                type="button"
                key={task.id}
                className={`history-row ${activeTask?.id === task.id ? 'active' : ''}`}
                onClick={() => setActiveTaskId(task.id)}
              >
                <span className={`history-status ${task.status}`}>
                  {task.status === 'processing' ? <Loader2 size={14} className="spin" /> : null}
                  {task.status === 'success' ? <CheckCircle2 size={14} /> : null}
                  {task.status === 'failed' ? <AlertCircle size={14} /> : null}
                </span>
                <span className="history-title">{task.fileName}</span>
                <span className="history-mode">{getModeLabel(task.sttMode)}</span>
                <span className="history-time">{formatTaskTime(task.createdAt)}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-state">暂无最近任务</div>
        )}
      </section>
    </div>
  )
}

export default TranscriptionAssistantPage
