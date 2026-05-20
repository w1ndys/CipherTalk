import { useEffect, useState } from 'react'
import { Check, Database, FolderOpen, ImageIcon, Key, Layers, RefreshCw, RotateCcw, Smile, Trash2, User } from 'lucide-react'
import { dialog } from '../../../services/ipc'
import * as configService from '../../../services/config'
import { formatFileSize } from '../utils'
import { useSettingsStore } from '../settingsStore'
import { ConfirmDialog } from '../ui'

interface DataManagementTabProps {
  showMessage: (text: string, success: boolean) => void
  reloadConfig: () => Promise<unknown>
  onClearCurrentAccountConfig: (deleteLocalData?: boolean) => void
}

function DataManagementTab({ showMessage, reloadConfig, onClearCurrentAccountConfig }: DataManagementTabProps) {
  const exportPath = useSettingsStore(s => s.config.exportPath)
  const exportDefaultDateRange = useSettingsStore(s => s.config.exportDefaultDateRange)
  const exportDefaultAvatars = useSettingsStore(s => s.config.exportDefaultAvatars)
  const setField = useSettingsStore(s => s.setField)
  const setExportPath = (value: string) => setField('exportPath', value)
  const setExportDefaultDateRange = (value: number) => setField('exportDefaultDateRange', value)
  const setExportDefaultAvatars = (value: boolean) => setField('exportDefaultAvatars', value)
  const [defaultExportPath, setDefaultExportPath] = useState('')
  const [showClearDialog, setShowClearDialog] = useState<{
    type: 'images' | 'emojis' | 'databases' | 'all' | 'currentAccount' | 'allAccounts'
    title: string
    message: string
  } | null>(null)
  const [cacheSize, setCacheSize] = useState<{ images: number; emojis: number; databases: number; logs: number; total: number } | null>(null)
  const [isLoadingCacheSize, setIsLoadingCacheSize] = useState(false)
  const [logFiles, setLogFiles] = useState<Array<{ name: string; size: number; mtime: Date }>>([])
  const [selectedLogFile, setSelectedLogFile] = useState('')
  const [logContent, setLogContent] = useState('')
  const [isLoadingLogs, setIsLoadingLogs] = useState(false)
  const [isLoadingLogContent, setIsLoadingLogContent] = useState(false)
  const [logSize, setLogSize] = useState(0)
  const [currentLogLevel, setCurrentLogLevel] = useState('WARN')

  useEffect(() => {
    loadDefaultExportPath()
    loadCacheSize()
    loadLogFiles()
  }, [])

  const loadDefaultExportPath = async () => {
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      setDefaultExportPath(downloadsPath)
    } catch (e) {
      console.error('获取默认导出路径失败:', e)
    }
  }

  const loadCacheSize = async () => {
    setIsLoadingCacheSize(true)
    try {
      const result = await window.electronAPI.cache.getCacheSize()
      if (result.success && result.size) setCacheSize(result.size)
    } catch (e) {
      console.error('获取缓存大小失败:', e)
    } finally {
      setIsLoadingCacheSize(false)
    }
  }

  const loadLogFiles = async () => {
    setIsLoadingLogs(true)
    try {
      const result = await window.electronAPI.log.getLogFiles()
      if (result.success && result.files) {
        setLogFiles(result.files.map((file: any) => ({ ...file, mtime: new Date(file.mtime) })))
        setLogSize(result.files.reduce((total: number, file: any) => total + file.size, 0))
      }
      const levelResult = await window.electronAPI.log.getLogLevel()
      if (levelResult.success && levelResult.level) setCurrentLogLevel(levelResult.level)
    } catch (e) {
      console.error('加载日志文件失败:', e)
    } finally {
      setIsLoadingLogs(false)
    }
  }

  const loadLogContent = async (filename: string) => {
    setIsLoadingLogContent(true)
    try {
      const result = await window.electronAPI.log.readLogFile(filename)
      if (result.success && result.content !== undefined) setLogContent(result.content)
    } catch (e) {
      console.error('读取日志文件失败:', e)
      showMessage('读取日志文件失败', false)
    } finally {
      setIsLoadingLogContent(false)
    }
  }

  const handleLogFileSelect = (filename: string) => {
    setSelectedLogFile(filename)
    loadLogContent(filename)
  }

  const handleOpenLogDirectory = async () => {
    try {
      const result = await window.electronAPI.log.getLogDirectory()
      if (result.success && result.directory) {
        await window.electronAPI.shell.openPath(result.directory)
      } else {
        showMessage(result.error || '打开日志目录失败', false)
      }
    } catch (e) {
      showMessage('打开日志目录失败', false)
    }
  }

  const handleLogLevelChange = async (level: string) => {
    try {
      const result = await window.electronAPI.log.setLogLevel(level)
      if (result.success) {
        setCurrentLogLevel(level)
        showMessage(`日志级别已设置为 ${level}`, true)
      } else {
        showMessage(result.error || '设置日志级别失败', false)
      }
    } catch (e) {
      showMessage('设置日志级别失败', false)
    }
  }

  const handleClearLogs = async () => {
    if (!confirm('确定要清除所有日志文件吗？此操作无法恢复。')) return
    try {
      const result = await window.electronAPI.log.clearLogs()
      if (result.success) {
        showMessage('日志已清除', true)
        setLogFiles([])
        setLogContent('')
        setSelectedLogFile('')
        setLogSize(0)
      } else {
        showMessage(result.error || '清除日志失败', false)
      }
    } catch (e) {
      showMessage('清除日志失败', false)
    }
  }

  const handleSelectExportPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择导出目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setExportPath(result.filePaths[0])
        showMessage('已设置导出目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleResetExportPath = async () => {
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      setExportPath(downloadsPath)
      showMessage('已恢复为下载目录', true)
    } catch (e) {
      showMessage('恢复默认失败', false)
    }
  }

  const handleClearImages = () => setShowClearDialog({ type: 'images', title: '清除图片', message: '此操作将删除所有解密后的图片文件，清除后无法恢复。确定要继续吗？' })
  const handleClearEmojis = () => setShowClearDialog({ type: 'emojis', title: '清除表情包', message: '此操作将删除所有解密后的表情包缓存文件，清除后无法恢复。确定要继续吗？' })
  const handleClearDatabases = () => setShowClearDialog({ type: 'databases', title: '清除数据库', message: '此操作将删除所有解密后的数据库缓存文件，清除后需要重新解密数据库才能使用聊天记录。确定要继续吗？' })
  const handleClearAllCache = () => setShowClearDialog({ type: 'all', title: '清除所有', message: '此操作将删除所有缓存数据（包括解密后的图片、表情包、数据库文件），清除后无法恢复。确定要继续吗？' })
  const handleClearCurrentAccount = () => setShowClearDialog({ type: 'currentAccount', title: '清除当前账号', message: '此操作将清除当前账号的密钥、路径等配置，不影响其他账号。确定要继续吗？' })
  const handleClearAllAccounts = () => setShowClearDialog({ type: 'allAccounts', title: '清空全部账号配置', message: '此操作将删除所有账号配置和账号级密钥/路径信息，不删除全局主题、AI、MCP、HTTP API 等通用设置。确定要继续吗？' })
  const handleClearCurrentAccountConfig = onClearCurrentAccountConfig

  const confirmClear = async () => {
    if (!showClearDialog) return
    try {
      let result
      switch (showClearDialog.type) {
        case 'images': result = await window.electronAPI.cache.clearImages(); break
        case 'emojis': result = await window.electronAPI.cache.clearEmojis(); break
        case 'databases': result = await window.electronAPI.cache.clearDatabases(); break
        case 'all': result = await window.electronAPI.cache.clearAll(); break
        case 'currentAccount': result = await window.electronAPI.cache.clearCurrentAccount(false); break
        case 'allAccounts': result = await window.electronAPI.cache.clearAllAccountConfigs(); break
      }
      if (result.success) {
        showMessage(`${showClearDialog.title}成功`, true)
        if (showClearDialog.type === 'currentAccount' || showClearDialog.type === 'allAccounts') await reloadConfig()
        else await loadCacheSize()
      } else {
        showMessage(result.error || `${showClearDialog.title}失败`, false)
      }
    } catch (e) {
      showMessage(`${showClearDialog.title}失败: ${e}`, false)
    } finally {
      setShowClearDialog(null)
    }
  }
  const renderDataManagementTab = () => (
    <div className="tab-content">
      {/* 导出设置 */}
      <section className="settings-section">
        <h3 className="section-title">导出设置</h3>

        <div className="form-group">
          <label>导出目录</label>
          <span className="form-hint">聊天记录导出的默认保存位置</span>
          <input type="text" placeholder={defaultExportPath || '系统下载目录'} value={exportPath || defaultExportPath} onChange={(e) => setExportPath(e.target.value)} />
          <div className="btn-row">
            <button className="btn btn-secondary" onClick={handleSelectExportPath}><FolderOpen size={16} /> 浏览选择</button>
            <button className="btn btn-secondary" onClick={handleResetExportPath}><RotateCcw size={16} /> 恢复默认</button>
          </div>
        </div>

        <div className="form-group">
          <label>默认日期范围</label>
          <span className="form-hint">导出时自动填充的日期范围，0表示不限制</span>
          <div className="date-range-options">
            {[
              { value: 0, label: '不限制', desc: '全部消息' },
              { value: 1, label: '今天', desc: '仅今日消息' },
              { value: 7, label: '最近7天', desc: '过去一周' },
              { value: 30, label: '最近30天', desc: '过去一个月' },
              { value: 90, label: '最近90天', desc: '过去三个月' },
              { value: 180, label: '最近180天', desc: '过去半年' },
              { value: 365, label: '最近1年', desc: '过去一年' }
            ].map(option => (
              <label
                key={option.value}
                className={`date-range-card ${exportDefaultDateRange === option.value ? 'active' : ''}`}
              >
                <input
                  type="radio"
                  name="exportDefaultDateRange"
                  value={option.value}
                  checked={exportDefaultDateRange === option.value}
                  onChange={(e) => setExportDefaultDateRange(Number(e.target.value))}
                />
                <div className="date-range-content">
                  <span className="date-range-label">{option.label}</span>
                  <span className="date-range-desc">{option.desc}</span>
                </div>
                {exportDefaultDateRange === option.value && (
                  <div className="date-range-check"><Check size={14} /></div>
                )}
              </label>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label>默认导出选项</label>
          <div className="export-default-options">
            <label className={`export-option-card ${exportDefaultAvatars ? 'active' : ''}`}>
              <input
                type="checkbox"
                checked={exportDefaultAvatars}
                onChange={(e) => setExportDefaultAvatars(e.target.checked)}
              />
              <div className="option-content">
                <div className="option-icon">
                  <User size={20} />
                </div>
                <div className="option-info">
                  <span className="option-label">默认导出头像</span>
                  <span className="option-desc">勾选后导出时默认包含头像</span>
                </div>
              </div>
              {exportDefaultAvatars && (
                <div className="option-check"><Check size={14} /></div>
              )}
            </label>
          </div>
        </div>
      </section>

      <div className="divider" style={{ margin: '2rem 0', borderBottom: '1px solid var(--border-color)', opacity: 0.1 }} />

      {/* 缓存管理 */}
      <section className="settings-section cache-management">
        <h3 className="section-title">缓存管理</h3>
        {isLoadingCacheSize ? (
          <p className="cache-loading">正在计算缓存大小...</p>
        ) : cacheSize ? (
          <div className="cache-cards">
            <div className="cache-card">
              <div className="cache-card-header">
                <ImageIcon size={20} className="cache-card-icon" />
                <span className="cache-card-label">图片缓存</span>
              </div>
              <div className="cache-card-size">{formatFileSize(cacheSize.images)}</div>
              <button type="button" className="btn btn-secondary cache-card-btn" onClick={handleClearImages}>
                <Trash2 size={14} /> 清除
              </button>
            </div>
            <div className="cache-card">
              <div className="cache-card-header">
                <Smile size={20} className="cache-card-icon" />
                <span className="cache-card-label">表情包缓存</span>
              </div>
              <div className="cache-card-size">{formatFileSize(cacheSize.emojis)}</div>
              <button type="button" className="btn btn-secondary cache-card-btn" onClick={handleClearEmojis}>
                <Trash2 size={14} /> 清除
              </button>
            </div>
            <div className="cache-card">
              <div className="cache-card-header">
                <Database size={20} className="cache-card-icon" />
                <span className="cache-card-label">数据库缓存</span>
              </div>
              <div className="cache-card-size">{formatFileSize(cacheSize.databases)}</div>
              <button type="button" className="btn btn-secondary cache-card-btn" onClick={handleClearDatabases}>
                <Trash2 size={14} /> 清除
              </button>
            </div>
            <div className="cache-card cache-card-config">
              <div className="cache-card-header">
                <Key size={20} className="cache-card-icon" />
                <span className="cache-card-label">配置信息</span>
              </div>
              <div className="cache-card-desc">密钥、路径等</div>
                <button type="button" className="btn btn-secondary cache-card-btn" onClick={handleClearCurrentAccount}>
                  <Trash2 size={14} /> 清除当前账号
                </button>
                <button type="button" className="btn btn-secondary cache-card-btn" onClick={handleClearCurrentAccountConfig.bind(null, true)}>
                  <Trash2 size={14} /> 删除当前账号并清理数据
                </button>
                <button type="button" className="btn btn-danger cache-card-btn" onClick={handleClearAllAccounts}>
                  <Trash2 size={14} /> 清空全部账号配置
                </button>
              </div>
            <div className="cache-card cache-card-total">
              <div className="cache-card-header">
                <Layers size={20} className="cache-card-icon" />
                <span className="cache-card-label">总计</span>
              </div>
              <div className="cache-card-size">{formatFileSize(cacheSize.total)}</div>
              <button type="button" className="btn btn-danger cache-card-btn" onClick={handleClearAllCache}>
                <Trash2 size={14} /> 清除所有缓存
              </button>
            </div>
          </div>
        ) : (
          <p>无法获取缓存信息</p>
        )}
      </section>

      <div className="divider" style={{ margin: '2rem 0', borderBottom: '1px solid var(--border-color)', opacity: 0.1 }} />

      {/* 日志管理 */}
      <section className="settings-section">
        <h3 className="section-title">日志管理</h3>

        <div className="form-group">
          <div className="log-stats-lite" style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1rem' }}>
            <span className="log-value">日志文件: {logFiles.length}个</span>
            <span className="log-value">总大小: {formatFileSize(logSize)}</span>
            <span className="log-value">当前级别: {currentLogLevel}</span>
          </div>

          <div className="log-level-options" style={{ marginBottom: '1rem' }}>
            {['DEBUG', 'INFO', 'WARN', 'ERROR'].map((level) => (
              <button
                key={level}
                className={`log-level-btn ${currentLogLevel === level ? 'active' : ''}`}
                onClick={() => handleLogLevelChange(level)}
              >
                {level}
              </button>
            ))}
          </div>

          <div className="btn-row">
            <button className="btn btn-secondary" onClick={handleOpenLogDirectory}>
              <FolderOpen size={16} /> 打开日志目录
            </button>
            <button className="btn btn-secondary" onClick={loadLogFiles} disabled={isLoadingLogs}>
              <RefreshCw size={16} className={isLoadingLogs ? 'spin' : ''} /> 刷新
            </button>
            <button className="btn btn-danger" onClick={handleClearLogs}>
              <Trash2 size={16} /> 清除所有日志
            </button>
          </div>
        </div>

        <div className="log-files" style={{ marginTop: '1rem' }}>
          <h4>最近日志</h4>
          {isLoadingLogs ? (
            <p>正在加载...</p>
          ) : logFiles.length > 0 ? (
            <div className="log-file-list" style={{ maxHeight: '200px', overflowY: 'auto' }}>
              {logFiles.map((file) => (
                <div
                  key={file.name}
                  className={`log-file-item ${selectedLogFile === file.name ? 'selected' : ''}`}
                  onClick={() => handleLogFileSelect(file.name)}
                >
                  <div className="log-file-info">
                    <span className="log-file-name">{file.name}</span>
                    <span className="log-file-size">{formatFileSize(file.size)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p>暂无日志文件</p>
          )}
        </div>

        {selectedLogFile && (
          <div className="log-content log-content-selectable" style={{ marginTop: '1rem' }}>
            <div className="log-content-text" style={{ maxHeight: '300px', overflowY: 'auto' }}>
              <pre>{logContent}</pre>
            </div>
          </div>
        )}
      </section>
    </div>
  )






  return (
    <>
      {showClearDialog && (
        <ConfirmDialog
          title={showClearDialog.title}
          message={showClearDialog.message}
          actions={(
            <>
              <button className="btn btn-danger" onClick={confirmClear}>确定</button>
              <button className="btn btn-secondary dialog-cancel" onClick={() => setShowClearDialog(null)}>取消</button>
            </>
          )}
        />
      )}
      {renderDataManagementTab()}
    </>
  )
}

export default DataManagementTab

