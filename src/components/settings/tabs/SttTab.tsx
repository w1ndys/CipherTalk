import { type SetStateAction, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, CheckCircle, ChevronDown, Download, Layers, Minus, Pause, Plug, Plus, RefreshCw, Trash2, Zap } from 'lucide-react'
import * as configService from '../../../services/config'
import { formatFileSize } from '../utils'
import { useSettingsStore } from '../settingsStore'
import { ProgressBar } from '../ui'

const sttLanguageOptions = [
  { value: 'zh', label: '中文', enLabel: 'Chinese' },
  { value: 'en', label: '英语', enLabel: 'English' },
  { value: 'ja', label: '日语', enLabel: 'Japanese' },
  { value: 'ko', label: '韩语', enLabel: 'Korean' },
  { value: 'yue', label: '粤语', enLabel: 'Cantonese' }
]

const sttModelTypeOptions = [
  { value: 'int8', label: 'int8 量化版', size: '235 MB', desc: '推荐，体积小、速度快' },
  { value: 'float32', label: 'float32 完整版', size: '920 MB', desc: '更高精度，体积较大' }
]

const sttOnlineLanguageOptions = [
  { value: 'auto', label: '自动识别' },
  { value: 'zh', label: '中文' },
  { value: 'en', label: '英语' },
  { value: 'ja', label: '日语' },
  { value: 'ko', label: '韩语' },
  { value: 'yue', label: '粤语' }
]

const sttOnlineProviderOptions = [
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
  { value: 'aliyun-qwen-asr', label: '阿里云 Qwen-ASR' },
  { value: 'custom', label: '自定义接口' }
] as const

const STT_ONLINE_DEFAULTS = {
  'openai-compatible': {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-transcribe'
  },
  'aliyun-qwen-asr': {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3-asr-flash'
  },
  custom: {
    baseURL: '',
    model: ''
  }
} as const

const DOWNLOAD_PAUSED_MESSAGE = '下载已暂停'

interface SttTabProps {
  active: boolean
  showMessage: (text: string, success: boolean) => void
}

function SttTab({ active, showMessage }: SttTabProps) {
  const sttLanguages = useSettingsStore(s => s.config.sttLanguages)
  const sttModelType = useSettingsStore(s => s.config.sttModelType)
  const sttMode = useSettingsStore(s => s.config.sttMode)
  const sttOnlineProvider = useSettingsStore(s => s.config.sttOnlineProvider)
  const sttOnlineApiKey = useSettingsStore(s => s.config.sttOnlineApiKey)
  const sttOnlineBaseURL = useSettingsStore(s => s.config.sttOnlineBaseURL)
  const sttOnlineModel = useSettingsStore(s => s.config.sttOnlineModel)
  const sttOnlineLanguage = useSettingsStore(s => s.config.sttOnlineLanguage)
  const sttOnlineTimeoutMs = useSettingsStore(s => s.config.sttOnlineTimeoutMs)
  const sttOnlineMaxConcurrency = useSettingsStore(s => s.config.sttOnlineMaxConcurrency)
  const cachePath = useSettingsStore(s => s.config.cachePath)
  const setField = useSettingsStore(s => s.setField)
  const setSttLanguagesState = (value: string[]) => setField('sttLanguages', value)
  const setSttModelType = (value: 'int8' | 'float32') => setField('sttModelType', value)
  const setSttMode = (value: 'cpu' | 'gpu' | 'online') => setField('sttMode', value)
  const setSttOnlineProvider = (value: 'openai-compatible' | 'aliyun-qwen-asr' | 'custom') => setField('sttOnlineProvider', value)
  const setSttOnlineApiKey = (value: string) => setField('sttOnlineApiKey', value)
  const setSttOnlineBaseURL = (value: string) => setField('sttOnlineBaseURL', value)
  const setSttOnlineModel = (value: string) => setField('sttOnlineModel', value)
  const setSttOnlineLanguage = (value: string) => setField('sttOnlineLanguage', value)
  const setSttOnlineTimeoutMs = (value: SetStateAction<number>) => setField('sttOnlineTimeoutMs', typeof value === 'function' ? value(sttOnlineTimeoutMs) : value)
  const setSttOnlineMaxConcurrency = (value: SetStateAction<number>) => setField('sttOnlineMaxConcurrency', typeof value === 'function' ? value(sttOnlineMaxConcurrency) : value)
  const [showSttOnlineLanguageDropdown, setShowSttOnlineLanguageDropdown] = useState(false)
  const sttOnlineLanguageRef = useRef<HTMLDivElement>(null)
  // ========== 语音转文字 (STT) 相关状态 ==========
  const [sttModelStatus, setSttModelStatus] = useState<{ exists: boolean; sizeBytes?: number } | null>(null)
  const [isLoadingSttStatus, setIsLoadingSttStatus] = useState(false)
  const [isDownloadingSttModel, setIsDownloadingSttModel] = useState(false)
  const [sttDownloadProgress, setSttDownloadProgress] = useState(0)

  // ========== Whisper GPU 加速相关状态 ==========
  const [whisperGpuInfo, setWhisperGpuInfo] = useState<{ available: boolean; provider: string; info: string } | null>(null)
  const [whisperModelType, setWhisperModelType] = useState<'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo' | 'large-v3-turbo-q5' | 'large-v3-turbo-q8'>('small')
  const [whisperModelStatus, setWhisperModelStatus] = useState<{ exists: boolean; modelPath?: string; sizeBytes?: number } | null>(null)
  const [isLoadingWhisperStatus, setIsLoadingWhisperStatus] = useState(false)
  const [isDownloadingWhisperModel, setIsDownloadingWhisperModel] = useState(false)
  const [whisperDownloadProgress, setWhisperDownloadProgress] = useState(0)
  const [useWhisperGpu, setUseWhisperGpu] = useState(false)

  // GPU 组件状态
  const [gpuComponentsStatus, setGpuComponentsStatus] = useState<{ installed: boolean; missingFiles?: string[]; gpuDir?: string } | null>(null)
  const [isDownloadingGpuComponents, setIsDownloadingGpuComponents] = useState(false)
  const [gpuDownloadProgress, setGpuDownloadProgress] = useState({ overallProgress: 0, currentFile: '' })

  // 加载 STT 模型状态
  useEffect(() => {
    if (active) {
      loadSttModelStatus()
      loadWhisperStatus()
      loadSttMode()
      checkGpuComponents()
    }
  }, [active])

  const loadSttMode = async () => {
    const savedMode = await configService.getSttMode()
    setSttMode(savedMode || 'cpu')
  }

  const handleSttModeChange = async (mode: 'cpu' | 'gpu' | 'online') => {
    setSttMode(mode)
    showMessage(
      mode === 'cpu'
        ? '已切换到 CPU 模式 (SenseVoice)'
        : mode === 'gpu'
          ? '已切换到 GPU 模式 (Whisper)'
          : '已切换到在线模式 (OpenAI 兼容)',
      true
    )
  }

  const handleTestOnlineSttConfig = async () => {
    const result = await window.electronAPI.stt.testOnlineConfig({
      provider: sttOnlineProvider,
      apiKey: sttOnlineApiKey,
      baseURL: sttOnlineBaseURL,
      model: sttOnlineModel,
      language: sttOnlineLanguage,
      timeoutMs: sttOnlineTimeoutMs
    })
    if (result.success) {
      showMessage('在线转写配置测试成功', true)
    } else {
      showMessage(result.error || '在线转写配置测试失败', false)
    }
  }

  // 监听 STT 下载进度
  useEffect(() => {
    const removeListener = window.electronAPI.stt.onDownloadProgress((progress) => {
      setSttDownloadProgress(progress.percent || 0)
    })
    return () => removeListener()
  }, [])

  const loadSttModelStatus = async () => {
    setIsLoadingSttStatus(true)
    try {
      const result = await window.electronAPI.stt.getModelStatus()
      if (result.success) {
        setSttModelStatus({
          exists: result.exists || false,
          sizeBytes: result.sizeBytes
        })
      }
    } catch (e) {
      console.error('获取 STT 模型状态失败:', e)
    } finally {
      setIsLoadingSttStatus(false)
    }
  }

  const handleDownloadSttModel = async () => {
    if (isDownloadingSttModel) return
    setIsDownloadingSttModel(true)
    setSttDownloadProgress(0)

    try {
      showMessage('正在下载语音识别模型...', true)
      const result = await window.electronAPI.stt.downloadModel()
      if (result.success) {
        showMessage('语音识别模型下载完成！', true)
        await loadSttModelStatus()
      } else if (result.error === DOWNLOAD_PAUSED_MESSAGE) {
        showMessage('语音识别模型下载已暂停，可再次点击下载继续', true)
      } else {
        showMessage(result.error || '模型下载失败', false)
      }
    } catch (e) {
      showMessage(`模型下载失败: ${e}`, false)
    } finally {
      setIsDownloadingSttModel(false)
    }
  }

  const handlePauseSttModelDownload = async () => {
    const result = await window.electronAPI.stt.cancelDownloadModel()
    if (!result.success || !result.cancelled) {
      showMessage(result.error || '暂停下载失败', false)
    }
  }

  const handleSttLanguageToggle = async (lang: string) => {
    if (sttLanguages.includes(lang) && sttLanguages.length === 1) {
      showMessage('必须至少选择一种语言', false)
      return
    }

    const newLangs = sttLanguages.includes(lang)
      ? sttLanguages.filter(l => l !== lang)
      : [...sttLanguages, lang]
    setSttLanguagesState(newLangs)
  }

  const handleSttModelTypeChange = async (type: 'int8' | 'float32') => {
    if (type === sttModelType) return

    // 如果已下载模型，切换类型需要重新下载
    if (sttModelStatus?.exists) {
      const confirmSwitch = confirm(
        `切换模型类型需要重新下载模型。\n\n` +
        `当前: ${sttModelTypeOptions.find(o => o.value === sttModelType)?.label}\n` +
        `切换到: ${sttModelTypeOptions.find(o => o.value === type)?.label} (${sttModelTypeOptions.find(o => o.value === type)?.size})\n\n` +
        `确定要切换吗？`
      )
      if (!confirmSwitch) return

      // 清除当前模型
      try {
        await window.electronAPI.stt.clearModel()
      } catch (e) {
        console.error('清除模型失败:', e)
      }
    }

    setSttModelType(type)
    await loadSttModelStatus()
    showMessage(`模型类型已切换为 ${sttModelTypeOptions.find(o => o.value === type)?.label}`, true)
  }

  // ========== Whisper GPU 相关函数 ==========
  const loadWhisperStatus = async () => {
    setIsLoadingWhisperStatus(true)
    try {
      // 加载保存的模型类型
      const savedModelType = await window.electronAPI.config.get('whisperModelType') as 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo' | 'large-v3-turbo-q5' | 'large-v3-turbo-q8' | undefined
      const modelType = savedModelType || 'small'
      setWhisperModelType(modelType)

      const gpuInfo = await window.electronAPI.sttWhisper.detectGPU()
      setWhisperGpuInfo(gpuInfo)

      const modelStatus = await window.electronAPI.sttWhisper.checkModel(modelType)
      setWhisperModelStatus(modelStatus)

      const savedUseWhisper = await window.electronAPI.config.get('useWhisperGpu') as boolean | undefined
      setUseWhisperGpu(savedUseWhisper || false)
    } catch (e) {
      console.error('加载 Whisper 状态失败:', e)
    } finally {
      setIsLoadingWhisperStatus(false)
    }
  }

  const handleDownloadWhisperModel = async () => {
    if (isDownloadingWhisperModel) return
    setIsDownloadingWhisperModel(true)
    setWhisperDownloadProgress(0)

    const unsubscribe = window.electronAPI.sttWhisper.onDownloadProgress((progress) => {
      if (progress.percent) {
        setWhisperDownloadProgress(progress.percent)
      }
    })

    try {
      const result = await window.electronAPI.sttWhisper.downloadModel(whisperModelType)
      if (result.success) {
        showMessage('Whisper 模型下载完成！', true)
        await loadWhisperStatus()
      } else if (result.error === DOWNLOAD_PAUSED_MESSAGE) {
        showMessage('Whisper 模型下载已暂停，可再次点击下载继续', true)
      } else {
        showMessage(result.error || 'Whisper 模型下载失败', false)
      }
    } catch (e) {
      showMessage(`Whisper 模型下载失败: ${e}`, false)
    } finally {
      unsubscribe()
      setIsDownloadingWhisperModel(false)
    }
  }

  const handlePauseWhisperModelDownload = async () => {
    const result = await window.electronAPI.sttWhisper.cancelDownloadModel(whisperModelType)
    if (!result.success || !result.cancelled) {
      showMessage(result.error || '暂停下载失败', false)
    }
  }

  const handleWhisperModelTypeChange = async (type: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'large-v3-turbo' | 'large-v3-turbo-q5' | 'large-v3-turbo-q8') => {
    console.log('[SettingsPage] 切换 Whisper 模型类型:', type)
    setWhisperModelType(type)
    await window.electronAPI.config.set('whisperModelType', type)
    console.log('[SettingsPage] Whisper 模型类型已保存')
    await loadWhisperStatus()
  }

  // ========== GPU 组件管理 ==========
  const checkGpuComponents = async () => {
    try {
      const status = await window.electronAPI.sttWhisper.checkGPUComponents()
      setGpuComponentsStatus(status)
    } catch (e) {
      console.error('检查 GPU 组件失败:', e)
    }
  }

  const handleDownloadGpuComponents = async () => {
    if (isDownloadingGpuComponents) return

    // 检查是否设置了缓存目录
    if (!cachePath) {
      showMessage('请先设置缓存目录', false)
      return
    }

    if (!confirm('下载 GPU 组件约 645 MB，确定要下载吗？\n下载后将自动安装到缓存目录。')) {
      return
    }

    setIsDownloadingGpuComponents(true)
    setGpuDownloadProgress({ overallProgress: 0, currentFile: '' })

    const unsubscribe = window.electronAPI.sttWhisper.onGPUDownloadProgress((progress) => {
      setGpuDownloadProgress({
        overallProgress: progress.overallProgress,
        currentFile: progress.currentFile
      })
    })

    try {
      const result = await window.electronAPI.sttWhisper.downloadGPUComponents()
      if (result.success) {
        showMessage('GPU 组件下载完成！', true)
        await checkGpuComponents()
        await loadWhisperStatus()
      } else if (result.error === DOWNLOAD_PAUSED_MESSAGE) {
        showMessage('GPU 组件下载已暂停，可再次点击下载继续', true)
      } else {
        showMessage(result.error || 'GPU 组件下载失败', false)
      }
    } catch (e) {
      showMessage(`GPU 组件下载失败: ${e}`, false)
    } finally {
      unsubscribe()
      setIsDownloadingGpuComponents(false)
    }
  }

  const handlePauseGpuComponentsDownload = async () => {
    const result = await window.electronAPI.sttWhisper.cancelDownloadGPUComponents()
    if (!result.success || !result.cancelled) {
      showMessage(result.error || '暂停下载失败', false)
    }
  }

  const handleToggleWhisperGpu = async (enabled: boolean) => {
    setUseWhisperGpu(enabled)
    await window.electronAPI.config.set('useWhisperGpu', enabled)
    showMessage(enabled ? 'Whisper GPU 加速已启用' : 'Whisper GPU 加速已禁用', true)
  }

  const renderSttTab = () => (
    <div className="tab-content">
      {/* STT 模式切换器 */}
      <div className="theme-mode-toggle" style={{ marginBottom: '2rem' }}>
        <button
          className={`mode-btn ${sttMode === 'cpu' ? 'active' : ''}`}
          onClick={() => handleSttModeChange('cpu')}
        >
          <Layers size={16} /> CPU 模式
        </button>
        <button
          className={`mode-btn ${sttMode === 'gpu' ? 'active' : ''}`}
          onClick={() => handleSttModeChange('gpu')}
        >
          <Zap size={16} /> GPU 模式
        </button>
        <button
          className={`mode-btn ${sttMode === 'online' ? 'active' : ''}`}
          onClick={() => handleSttModeChange('online')}
        >
          <Plug size={16} /> 在线模式
        </button>
      </div>

      {/* CPU 模式 - SenseVoice */}
      {sttMode === 'cpu' && (
        <>
          <h3 className="section-title">语音识别模型 (SenseVoice)</h3>
          <p className="section-desc">
            使用 SenseVoice 模型进行本地离线语音转文字，支持中文、英语、日语、韩语、粤语。
            选择合适的模型版本后下载，仅需下载一次。
          </p>

          <h4 className="subsection-title" style={{ marginTop: '1rem', marginBottom: '0.5rem', fontSize: '0.95rem', fontWeight: 500 }}>模型版本</h4>
          <div className="model-type-grid">
            {sttModelTypeOptions.map(opt => (
              <label
                key={opt.value}
                className={`model-card ${sttModelType === opt.value ? 'active' : ''} ${isDownloadingSttModel ? 'disabled' : ''}`}
              >
                <input
                  type="radio"
                  name="sttModelType"
                  value={opt.value}
                  checked={sttModelType === opt.value}
                  onChange={() => handleSttModelTypeChange(opt.value as 'int8' | 'float32')}
                  disabled={isDownloadingSttModel}
                />
                <div className="model-icon">
                  {opt.value === 'int8' ? <Zap size={24} /> : <Layers size={24} />}
                </div>
                <div className="model-info">
                  <div className="model-header">
                    <span className="model-name">{opt.label}</span>
                    <span className="model-size">{opt.size}</span>
                  </div>
                  <span className="model-desc">{opt.desc}</span>
                </div>
                {sttModelType === opt.value && <div className="model-check"><Check size={14} /></div>}
              </label>
            ))}
          </div>

          <div className="stt-model-status">
            {isLoadingSttStatus ? (
              <p>正在检查模型状态...</p>
            ) : sttModelStatus ? (
              <div className="model-info">
                <div className={`status-indicator ${sttModelStatus.exists ? 'ready' : 'missing'}`}>
                  {sttModelStatus.exists ? (
                    <>
                      <CheckCircle size={20} />
                      <span>模型已就绪</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle size={20} />
                      <span>模型未下载</span>
                    </>
                  )}
                </div>
                {sttModelStatus.exists && sttModelStatus.sizeBytes && (
                  <p className="model-size">模型大小: {formatFileSize(sttModelStatus.sizeBytes)}</p>
                )}
              </div>
            ) : (
              <p>无法获取模型状态</p>
            )}
          </div>

          {isDownloadingSttModel && (
            <ProgressBar
              value={sttDownloadProgress}
              label={`${sttDownloadProgress.toFixed(1)}%`}
              action={(
                <button type="button" className="progress-action-button" onClick={handlePauseSttModelDownload}>
                  <Pause size={14} /> 暂停
                </button>
              )}
            />
          )}

          <h3 className="section-title" style={{ marginTop: '2rem' }}>支持语言</h3>
          <p className="section-desc">选择需要识别的语言，支持多选。若选择多种语言，模型将自动检测。</p>
          <div className="language-grid">
            {sttLanguageOptions.map(opt => (
              <label
                key={opt.value}
                className={`language-card ${sttLanguages.includes(opt.value) ? 'active' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={sttLanguages.includes(opt.value)}
                  onChange={() => handleSttLanguageToggle(opt.value)}
                  disabled={sttLanguages.includes(opt.value) && sttLanguages.length === 1}
                />
                <div className="lang-info">
                  <span className="lang-name">{opt.label}</span>
                  <span className="lang-en">{opt.enLabel}</span>
                </div>
                {sttLanguages.includes(opt.value) && <div className="lang-check"><Check size={14} /></div>}
              </label>
            ))}
          </div>

          <div className="btn-row" style={{ marginTop: '1rem' }}>
            {!sttModelStatus?.exists && (
              <button
                className="btn btn-primary"
                onClick={handleDownloadSttModel}
                disabled={isDownloadingSttModel}
              >
                <Download size={16} /> {isDownloadingSttModel ? '下载中...' : '下载模型'}
              </button>
            )}
            {sttModelStatus?.exists && (
              <button
                className="btn btn-danger"
                onClick={async () => {
                  const currentModelSize = sttModelTypeOptions.find(o => o.value === sttModelType)?.size || '235 MB'
                  if (confirm(`确定要清除语音识别模型吗？下次使用需要重新下载 (${currentModelSize})。`)) {
                    try {
                      const result = await window.electronAPI.stt.clearModel()
                      if (result.success) {
                        showMessage('模型清除成功', true)
                        await loadSttModelStatus()
                      } else {
                        showMessage(result.error || '模型清除失败', false)
                      }
                    } catch (e) {
                      showMessage(`模型清除失败: ${e}`, false)
                    }
                  }
                }}
              >
                <Trash2 size={16} /> 清除模型
              </button>
            )}
            <button
              className="btn btn-secondary"
              onClick={loadSttModelStatus}
              disabled={isLoadingSttStatus}
            >
              <RefreshCw size={16} className={isLoadingSttStatus ? 'spin' : ''} /> 刷新状态
            </button>
          </div>
        </>
      )}

      {/* GPU 模式 - Whisper */}
      {sttMode === 'gpu' && (
        <>
          <h3 className="section-title">语音识别模型 (Whisper GPU)</h3>
          <p className="section-desc">
            使用 Whisper.cpp 进行 GPU 加速的语音识别，性能提升 10-15 倍。支持 NVIDIA GPU (CUDA)。
          </p>

          {/* GPU 状态卡片 */}
          <div className="gpu-status-card" style={{
            padding: '1rem',
            background: 'var(--bg-secondary)',
            borderRadius: '12px',
            marginBottom: '1.5rem',
            border: '1px solid var(--border-color)'
          }}>
            {isLoadingWhisperStatus ? (
              <p style={{ margin: 0, color: 'var(--text-secondary)' }}>正在检测 GPU...</p>
            ) : whisperGpuInfo ? (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  {whisperGpuInfo.available ? (
                    <CheckCircle size={20} style={{ color: 'var(--success-color)' }} />
                  ) : (
                    <AlertCircle size={20} style={{ color: 'var(--warning-color)' }} />
                  )}
                  <strong style={{ fontSize: '15px' }}>{whisperGpuInfo.provider}</strong>
                </div>
                <p style={{ margin: 0, fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                  {whisperGpuInfo.info}
                </p>
              </div>
            ) : (
              <p style={{ margin: 0, color: 'var(--text-secondary)' }}>无法检测 GPU 状态</p>
            )}
          </div>

          {/* GPU 组件状态 */}
          <div className="gpu-components-card" style={{
            padding: '1.25rem',
            background: 'var(--bg-secondary)',
            borderRadius: '12px',
            marginBottom: '1.5rem',
            border: '1px solid var(--border-color)',
            transition: 'all 0.3s ease'
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{
                  width: '32px',
                  height: '32px',
                  borderRadius: '8px',
                  background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center'
                }}>
                  <Download size={18} color="white" />
                </div>
                <strong style={{ fontSize: '15px' }}>GPU 加速组件</strong>
              </div>
              {gpuComponentsStatus?.installed ? (
                <span style={{
                  fontSize: '13px',
                  color: 'var(--success-color)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  padding: '0.25rem 0.75rem',
                  background: 'var(--success-bg)',
                  borderRadius: '12px',
                  fontWeight: 500
                }}>
                  <CheckCircle size={16} /> 已安装
                </span>
              ) : (
                <span style={{
                  fontSize: '13px',
                  color: 'var(--warning-color)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                  padding: '0.25rem 0.75rem',
                  background: 'var(--warning-bg)',
                  borderRadius: '12px',
                  fontWeight: 500
                }}>
                  <AlertCircle size={16} /> 未安装
                </span>
              )}
            </div>

            {gpuComponentsStatus?.installed ? (
              <div style={{
                padding: '0.75rem',
                background: 'var(--bg-tertiary)',
                borderRadius: '8px',
                fontSize: '13px',
                color: 'var(--text-secondary)',
                wordBreak: 'break-all'
              }}>
                <div style={{ marginBottom: '0.25rem', color: 'var(--text-primary)', fontWeight: 500 }}>
                  安装位置
                </div>
                {gpuComponentsStatus.gpuDir}
              </div>
            ) : (
              <>
                <div style={{
                  padding: '0.75rem',
                  background: 'var(--bg-tertiary)',
                  borderRadius: '8px',
                  marginBottom: '1rem'
                }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                    <AlertCircle size={16} style={{ marginTop: '2px', flexShrink: 0, color: 'var(--primary-color)' }} />
                    <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                      GPU 加速需要下载约 <strong style={{ color: 'var(--text-primary)' }}>645 MB</strong> 的 CUDA 组件，将安装到缓存目录。
                      <br />
                      下载支持断点续传，可随时暂停和恢复。
                    </div>
                  </div>
                </div>
                {isDownloadingGpuComponents ? (
                  <div>
                    <div style={{
                      marginBottom: '0.75rem',
                      fontSize: '13px',
                      color: 'var(--text-primary)',
                      fontWeight: 500,
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.5rem'
                    }}>
                      <div className="spinner" style={{
                        width: '14px',
                        height: '14px',
                        border: '2px solid var(--border-color)',
                        borderTopColor: 'var(--primary-color)',
                        borderRadius: '50%',
                        animation: 'spin 0.8s linear infinite'
                      }} />
                      {gpuDownloadProgress.currentFile}
                    </div>
                    <ProgressBar
                      value={gpuDownloadProgress.overallProgress}
                      label={`${gpuDownloadProgress.overallProgress.toFixed(1)}%`}
                      action={(
                        <button type="button" className="progress-action-button" onClick={handlePauseGpuComponentsDownload}>
                          <Pause size={14} /> 暂停
                        </button>
                      )}
                    />
                  </div>
                ) : (
                  <button
                    className="btn-primary"
                    onClick={handleDownloadGpuComponents}
                    style={{
                      width: '100%',
                      padding: '0.75rem 1rem',
                      borderRadius: '9999px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: '0.5rem',
                      fontSize: '14px',
                      fontWeight: 500
                    }}
                  >
                    <Download size={16} />
                    下载 GPU 组件 (645 MB)
                  </button>
                )}
              </>
            )}
          </div>

          {/* 模型选择 */}
          <h4 className="subsection-title" style={{ marginTop: '1rem', marginBottom: '0.5rem', fontSize: '0.95rem', fontWeight: 500 }}>模型大小</h4>
          <div className="model-type-grid">
            {[
              { value: 'tiny', label: 'Tiny 模型', size: '75 MB', desc: '最快速度，适合实时场景' },
              { value: 'base', label: 'Base 模型', size: '145 MB', desc: '推荐使用，速度与精度平衡' },
              { value: 'small', label: 'Small 模型', size: '488 MB', desc: '更高精度，适合准确识别' },
              { value: 'large-v3-turbo-q5', label: 'Turbo-Q5 量化', size: '540 MB', desc: '极高精度 + 小体积（推荐）' },
              { value: 'large-v3-turbo-q8', label: 'Turbo-Q8 量化', size: '835 MB', desc: '极高精度 + 高质量量化' },
              { value: 'medium', label: 'Medium 模型', size: '1.5 GB', desc: '最佳精度，需要更多时间' },
              { value: 'large-v3-turbo', label: 'Large-v3-Turbo', size: '1.62 GB', desc: '极高精度 + 快速' },
              { value: 'large-v3', label: 'Large-v3 模型', size: '3.1 GB', desc: '极高精度，专业级识别' }
            ].map(opt => (
              <label
                key={opt.value}
                className={`model-card ${whisperModelType === opt.value ? 'active' : ''} ${isDownloadingWhisperModel ? 'disabled' : ''}`}
              >
                <input
                  type="radio"
                  name="whisperModelType"
                  value={opt.value}
                  checked={whisperModelType === opt.value}
                  onChange={() => handleWhisperModelTypeChange(opt.value as any)}
                  disabled={isDownloadingWhisperModel}
                />
                <div className="model-icon">
                  <Zap size={24} />
                </div>
                <div className="model-info">
                  <div className="model-header">
                    <span className="model-name">{opt.label}</span>
                    <span className="model-size">{opt.size}</span>
                  </div>
                  <span className="model-desc">{opt.desc}</span>
                </div>
                {whisperModelType === opt.value && <div className="model-check"><Check size={14} /></div>}
              </label>
            ))}
          </div>

          {/* 模型状态 */}
          <div className="stt-model-status">
            {isLoadingWhisperStatus ? (
              <p>正在检查模型状态...</p>
            ) : whisperModelStatus ? (
              <div className="model-info">
                <div className={`status-indicator ${whisperModelStatus.exists ? 'ready' : 'missing'}`}>
                  {whisperModelStatus.exists ? (
                    <>
                      <CheckCircle size={20} />
                      <span>模型已就绪</span>
                    </>
                  ) : (
                    <>
                      <AlertCircle size={20} />
                      <span>模型未下载</span>
                    </>
                  )}
                </div>
                {whisperModelStatus.exists && whisperModelStatus.sizeBytes && (
                  <p className="model-size">模型大小: {formatFileSize(whisperModelStatus.sizeBytes)}</p>
                )}
              </div>
            ) : (
              <p>无法获取模型状态</p>
            )}
          </div>

          {/* 下载进度 */}
          {isDownloadingWhisperModel && (
            <ProgressBar
              value={whisperDownloadProgress}
              label={`${whisperDownloadProgress.toFixed(1)}%`}
              action={(
                <button type="button" className="progress-action-button" onClick={handlePauseWhisperModelDownload}>
                  <Pause size={14} /> 暂停
                </button>
              )}
            />
          )}

          {/* 操作按钮 */}
          <div className="btn-row" style={{ marginTop: '1rem' }}>
            {!whisperModelStatus?.exists && (
              <button
                className="btn btn-primary"
                onClick={handleDownloadWhisperModel}
                disabled={isDownloadingWhisperModel}
              >
                <Download size={16} /> {isDownloadingWhisperModel ? '下载中...' : '下载模型'}
              </button>
            )}
            {whisperModelStatus?.exists && (
              <button
                className="btn btn-danger"
                onClick={async () => {
                  const modelSizes = {
                    tiny: '75 MB',
                    base: '145 MB',
                    small: '488 MB',
                    medium: '1.5 GB',
                    'large-v3': '3.1 GB',
                    'large-v3-turbo': '1.62 GB',
                    'large-v3-turbo-q5': '540 MB',
                    'large-v3-turbo-q8': '835 MB'
                  }
                  const currentModelSize = modelSizes[whisperModelType]
                  if (confirm(`确定要清除 Whisper 模型吗？下次使用需要重新下载 (${currentModelSize})。`)) {
                    try {
                      const result = await window.electronAPI.sttWhisper.clearModel(whisperModelType)
                      if (result.success) {
                        showMessage('模型清除成功', true)
                        await loadWhisperStatus()
                      } else {
                        showMessage(result.error || '模型清除失败', false)
                      }
                    } catch (e) {
                      showMessage(`模型清除失败: ${e}`, false)
                    }
                  }
                }}
              >
                <Trash2 size={16} /> 清除模型
              </button>
            )}
            <button
              className="btn btn-secondary"
              onClick={loadWhisperStatus}
              disabled={isLoadingWhisperStatus}
            >
              <RefreshCw size={16} className={isLoadingWhisperStatus ? 'spin' : ''} /> 刷新状态
            </button>
          </div>
        </>
      )}

      {sttMode === 'online' && (
        <div className="stt-online-settings">
          <h3 className="section-title">在线语音转写</h3>
          <p className="section-desc">
            使用在线接口进行语音转文字，无需下载本地模型。语音数据会发送到第三方服务，可能产生网络延迟与 API 费用。
          </p>

          <div className="form-group">
            <label>提供商</label>
            <span className="form-hint">
              {sttOnlineProvider === 'openai-compatible'
                ? '选择 OpenAI 兼容时会自动补全标准路径'
                : sttOnlineProvider === 'aliyun-qwen-asr'
                  ? '阿里云走 DashScope 兼容入口，但内部使用 chat/completions + input_audio 协议'
                  : '自定义接口会直接使用你填写的完整 URL'}
            </span>
            <div className="theme-mode-toggle" style={{ marginBottom: 0 }}>
              {sttOnlineProviderOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={`mode-btn ${sttOnlineProvider === option.value ? 'active' : ''}`}
                  onClick={() => {
                    setSttOnlineProvider(option.value)

                    if (option.value === 'aliyun-qwen-asr') {
                      if (!sttOnlineBaseURL || sttOnlineBaseURL === STT_ONLINE_DEFAULTS['openai-compatible'].baseURL) {
                        setSttOnlineBaseURL(STT_ONLINE_DEFAULTS['aliyun-qwen-asr'].baseURL)
                      }
                      if (!sttOnlineModel || sttOnlineModel === STT_ONLINE_DEFAULTS['openai-compatible'].model) {
                        setSttOnlineModel(STT_ONLINE_DEFAULTS['aliyun-qwen-asr'].model)
                      }
                    } else if (option.value === 'openai-compatible') {
                      if (!sttOnlineBaseURL || sttOnlineBaseURL === STT_ONLINE_DEFAULTS['aliyun-qwen-asr'].baseURL) {
                        setSttOnlineBaseURL(STT_ONLINE_DEFAULTS['openai-compatible'].baseURL)
                      }
                      if (!sttOnlineModel || sttOnlineModel === STT_ONLINE_DEFAULTS['aliyun-qwen-asr'].model) {
                        setSttOnlineModel(STT_ONLINE_DEFAULTS['openai-compatible'].model)
                      }
                    }
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          <div className="form-group">
            <label>接口 URL</label>
            <span className="form-hint">
              {sttOnlineProvider === 'openai-compatible'
                ? '支持填写完整接口 URL，如 `https://api.openai.com/v1/audio/transcriptions`；也兼容只填 `/v1` 基地址'
                : sttOnlineProvider === 'aliyun-qwen-asr'
                  ? '建议填写 DashScope 兼容入口，如 `https://dashscope.aliyuncs.com/compatible-mode/v1`'
                  : '请输入完整接口 URL，系统会按你填写的地址原样发起请求'}
            </span>
            <input
              type="text"
              value={sttOnlineBaseURL}
              onChange={(e) => setSttOnlineBaseURL(e.target.value)}
              placeholder={
                sttOnlineProvider === 'openai-compatible'
                  ? 'https://api.openai.com/v1/audio/transcriptions'
                  : sttOnlineProvider === 'aliyun-qwen-asr'
                    ? 'https://dashscope.aliyuncs.com/compatible-mode/v1'
                    : 'https://your-api.example.com/full/path'
              }
            />
          </div>

          <div className="form-group">
            <label>API Key</label>
            <span className="form-hint">用于调用在线语音识别接口</span>
            <input
              type="password"
              value={sttOnlineApiKey}
              onChange={(e) => setSttOnlineApiKey(e.target.value)}
              placeholder="请输入在线 STT API Key"
            />
          </div>

          <div className="form-group">
            <label>模型名称</label>
            <span className="form-hint">
              {sttOnlineProvider === 'aliyun-qwen-asr'
                ? '阿里云当前可用模型为 `qwen3-asr-flash` 与 `qwen3-asr-flash-filetrans`，默认使用 `qwen3-asr-flash`'
                : '默认使用 `gpt-4o-mini-transcribe`，也可替换为兼容模型名'}
            </span>
            <input
              type="text"
              value={sttOnlineModel}
              onChange={(e) => setSttOnlineModel(e.target.value)}
              placeholder={sttOnlineProvider === 'aliyun-qwen-asr' ? 'qwen3-asr-flash' : 'gpt-4o-mini-transcribe'}
            />
          </div>

          <div className="advanced-params-grid">
            <div className="param-item">
              <label>识别语言</label>
              <div className="custom-select" ref={sttOnlineLanguageRef}>
                <button
                  type="button"
                  className={`custom-select-trigger ${showSttOnlineLanguageDropdown ? 'is-open' : ''}`}
                  onClick={() => setShowSttOnlineLanguageDropdown(prev => !prev)}
                >
                  <span>{sttOnlineLanguageOptions.find(option => option.value === sttOnlineLanguage)?.label || '自动识别'}</span>
                  <ChevronDown size={16} />
                </button>
                {showSttOnlineLanguageDropdown && (
                  <div className="custom-select-menu">
                    {sttOnlineLanguageOptions.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        className={`custom-select-option ${sttOnlineLanguage === option.value ? 'is-active' : ''}`}
                        onClick={() => {
                          setSttOnlineLanguage(option.value)
                          setShowSttOnlineLanguageDropdown(false)
                        }}
                      >
                        <span>{option.label}</span>
                        {sttOnlineLanguage === option.value && <Check size={14} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="param-item">
              <label>超时时间（毫秒）</label>
              <div className="number-control">
                <button className="control-btn minus" type="button" onClick={() => setSttOnlineTimeoutMs(prev => Math.max(5000, prev - 5000))}>
                  <Minus size={14} />
                </button>
                <div className="value-display">
                  <input
                    type="number"
                    value={sttOnlineTimeoutMs}
                    onChange={(e) => setSttOnlineTimeoutMs(Math.max(5000, Number(e.target.value) || 60000))}
                  />
                </div>
                <button className="control-btn plus" type="button" onClick={() => setSttOnlineTimeoutMs(prev => Math.min(300000, prev + 5000))}>
                  <Plus size={14} />
                </button>
              </div>
            </div>

            <div className="param-item">
              <label>批量并发数</label>
              <div className="number-control">
                <button className="control-btn minus" type="button" onClick={() => setSttOnlineMaxConcurrency(prev => Math.max(1, prev - 1))}>
                  <Minus size={14} />
                </button>
                <div className="value-display">
                  <input
                    type="number"
                    value={sttOnlineMaxConcurrency}
                    onChange={(e) => setSttOnlineMaxConcurrency(Math.max(1, Math.min(10, Number(e.target.value) || 2)))}
                  />
                </div>
                <button className="control-btn plus" type="button" onClick={() => setSttOnlineMaxConcurrency(prev => Math.min(10, prev + 1))}>
                  <Plus size={14} />
                </button>
              </div>
            </div>
          </div>

          <div className="btn-row" style={{ marginTop: '1rem' }}>
            <button className="btn btn-secondary" onClick={handleTestOnlineSttConfig}>
              <Plug size={16} /> 测试在线配置
            </button>
          </div>

          <div className="stt-instructions" style={{ marginTop: '1.5rem' }}>
            <ol>
              <li>在线模式会把语音文件发送到第三方 STT 服务进行识别</li>
              <li>识别效果取决于服务商模型、网络状况和接口限流策略</li>
              <li>批量转写会按并发数逐批发送，避免触发过高频率限制</li>
            </ol>
            <p className="note">
              <strong>注意：</strong>在线模式不再依赖本地模型下载，但会产生隐私和费用成本，请确认后再使用。
            </p>
          </div>
        </div>
      )}

    </div>
  )




  return renderSttTab()
}

export default SttTab

