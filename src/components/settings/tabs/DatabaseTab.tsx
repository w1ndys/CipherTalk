import { useEffect, useState } from 'react'
import { AlertCircle, Check, CheckCircle, ChevronDown, Download, Eye, EyeOff, FolderOpen, FolderSearch, ImageIcon, Key, Plug, RefreshCw, RotateCcw, Save, Search, ShieldCheck, Trash2, User, X, Zap } from 'lucide-react'
import { useAppStore } from '../../../stores/appStore'
import type { AccountProfile } from '../../../types/account'
import { dialog } from '../../../services/ipc'
import * as configService from '../../../services/config'
import { useSettingsStore } from '../settingsStore'
import { ConfirmDialog } from '../ui'

interface DatabaseTabProps {
  showMessage: (text: string, success: boolean) => void
  reloadConfig: () => Promise<unknown>
  onSave: () => void
}

function DatabaseTab({ showMessage, reloadConfig, onSave }: DatabaseTabProps) {
  const { setDbConnected, setLoading, setMyWxid: setCurrentWxid, userInfo } = useAppStore()
  const isMac = window.navigator.platform.toLowerCase().includes('mac')
  const decryptKey = useSettingsStore(s => s.config.decryptKey)
  const dbPath = useSettingsStore(s => s.config.dbPath)
  const wxid = useSettingsStore(s => s.config.wxid)
  const cachePath = useSettingsStore(s => s.config.cachePath)
  const imageXorKey = useSettingsStore(s => s.config.imageXorKey)
  const imageAesKey = useSettingsStore(s => s.config.imageAesKey)
  const editingAccountId = useSettingsStore(s => s.config.editingAccountId)
  const skipIntegrityCheck = useSettingsStore(s => s.config.skipIntegrityCheck)
  const autoUpdateDatabase = useSettingsStore(s => s.config.autoUpdateDatabase)
  const autoUpdateCheckInterval = useSettingsStore(s => s.config.autoUpdateCheckInterval)
  const autoUpdateMinInterval = useSettingsStore(s => s.config.autoUpdateMinInterval)
  const autoUpdateDebounceTime = useSettingsStore(s => s.config.autoUpdateDebounceTime)
  const hasUnsavedChanges = useSettingsStore(s => s.hasUnsavedChanges)
  const setField = useSettingsStore(s => s.setField)
  const setFields = useSettingsStore(s => s.setFields)
  const commit = useSettingsStore(s => s.commit)
  const setDecryptKey = (value: string) => setField('decryptKey', value)
  const setDbPath = (value: string) => setField('dbPath', value)
  const setWxid = (value: string) => setField('wxid', value)
  const setCachePath = (value: string) => setField('cachePath', value)
  const setImageXorKey = (value: string) => setField('imageXorKey', value)
  const setImageAesKey = (value: string) => setField('imageAesKey', value)
  const setEditingAccountId = (value: string) => setField('editingAccountId', value)
  const setSkipIntegrityCheck = (value: boolean) => setField('skipIntegrityCheck', value)
  const setAutoUpdateDatabase = (value: boolean) => setField('autoUpdateDatabase', value)
  const setAutoUpdateCheckInterval = (value: number) => setField('autoUpdateCheckInterval', value)
  const setAutoUpdateMinInterval = (value: number) => setField('autoUpdateMinInterval', value)
  const setAutoUpdateDebounceTime = (value: number) => setField('autoUpdateDebounceTime', value)

  const [accountsList, setAccountsList] = useState<AccountProfile[]>([])
  const [activeAccountId, setActiveAccountId] = useState('')
  const [wxidOptions, setWxidOptions] = useState<string[]>([])
  const [showWxidDropdown, setShowWxidDropdown] = useState(false)
  const [isScanningWxid, setIsScanningWxid] = useState(false)
  const [isAccountVerified, setIsAccountVerified] = useState(false)
  const [isVerifyingAccount, setIsVerifyingAccount] = useState(false)
  const [isLoading, setIsLoadingState] = useState(false)
  const [isTesting, setIsTesting] = useState(false)
  const [isGettingKey, setIsGettingKey] = useState(false)
  const [keyStatus, setKeyStatus] = useState('')
  const [showDecryptKey, setShowDecryptKey] = useState(false)
  const [showXorKey, setShowXorKey] = useState(false)
  const [showAesKey, setShowAesKey] = useState(false)
  const [securityConfirm, setSecurityConfirm] = useState<{ show: boolean; title: string; message: string; onConfirm: () => void }>({ show: false, title: '', message: '', onConfirm: () => { } })

  useEffect(() => {
    refreshAccountsState()
  }, [])
  const getAccountDisplayName = (account?: AccountProfile | null) => {
    if (!account) return '未命名账号'

    const activeNickname = account.id === activeAccountId ? userInfo?.nickName?.trim() : ''
    if (activeNickname) return activeNickname

    const savedName = account.displayName?.trim()
    if (savedName && savedName !== '未命名账号') return savedName

    return account.wxid?.trim() || '未命名账号'
  }

  const buildAccountPayload = () => {
    const currentAccount = accountsList.find(item => item.id === editingAccountId)
    const currentDisplayName = currentAccount?.displayName?.trim()
    const preferredDisplayName = userInfo?.nickName?.trim()
      || (currentDisplayName && currentDisplayName !== '未命名账号' ? currentDisplayName : '')
      || wxid.trim()
      || '未命名账号'

    return {
      wxid: wxid.trim(),
      dbPath: dbPath.trim(),
      decryptKey: decryptKey.trim(),
      cachePath: cachePath.trim(),
      imageXorKey: imageXorKey.trim(),
      imageAesKey: imageAesKey.trim(),
      displayName: preferredDisplayName
    }
  }

  const applyAccountToForm = (account: AccountProfile | null) => {
    setEditingAccountId(account?.id || '')
    setDecryptKey(account?.decryptKey || '')
    setDbPath(account?.dbPath || '')
    setWxid(account?.wxid || '')
    setCachePath(account?.cachePath || '')
    setImageXorKey(account?.imageXorKey || '')
    setImageAesKey(account?.imageAesKey || '')
    setIsAccountVerified(Boolean(account?.decryptKey && account?.dbPath && account?.wxid))
  }

  const refreshAccountsState = async (preferredEditingId?: string) => {
    const [accounts, activeAccount] = await Promise.all([
      configService.listAccounts(),
      configService.getActiveAccount()
    ])
    setAccountsList(accounts)
    setActiveAccountId(activeAccount?.id || '')

    const editingId = preferredEditingId || editingAccountId || activeAccount?.id || accounts[0]?.id || ''
    const editingAccount = accounts.find(item => item.id === editingId) || activeAccount || accounts[0] || null
    applyAccountToForm(editingAccount)
    return { accounts, activeAccount, editingAccount }
  }

  const handleGetKey = async () => {
    if (isGettingKey) return
    setIsGettingKey(true)
    setKeyStatus(isMac ? '正在准备 macOS helper...' : '正在检查微信进程...')

    try {
      if (isMac) {
        const removeListener = window.electronAPI.wxKey.onStatus(({ status }) => {
          setKeyStatus(status)
        })

        const result = await window.electronAPI.wxKey.startGetKey(undefined, dbPath || undefined)
        removeListener()

        if (result.success && result.key) {
          setDecryptKey(result.key)

          if (dbPath) {
            const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, result.key)
            if (resolved.success && resolved.wxid) {
              setWxid(resolved.wxid)
              setIsAccountVerified(true)
              showMessage(`密钥获取成功！已验证账号: ${resolved.wxid}`, true)
              setKeyStatus('')
              return
            }
          }

          if (result.validatedWxid) {
            setWxid(result.validatedWxid)
            setIsAccountVerified(true)
            showMessage(`密钥获取成功！已验证账号: ${result.validatedWxid}`, true)
            setKeyStatus('')
            return
          }

          setKeyStatus('正在检测当前登录账号...')

          let accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
          }

          if (accountInfo) {
            setWxid(accountInfo.wxid)
            setIsAccountVerified(false)
            showMessage(`密钥获取成功！已识别候选账号: ${accountInfo.wxid}，请继续验证目录。`, true)
          } else {
            const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
            setWxidOptions(wxids)
            setIsAccountVerified(false)

            if (wxids.length === 1) {
              setWxid(wxids[0])
              showMessage('密钥获取成功，已识别到 1 个候选账号目录，请继续验证。', true)
            } else if (wxids.length > 1) {
              setShowWxidDropdown(true)
              showMessage(`密钥获取成功，识别到 ${wxids.length} 个候选账号目录，请选择后验证。`, true)
            } else {
              showMessage('密钥获取成功，请手动填写或扫描账号目录后继续验证。', true)
            }
          }

          setKeyStatus('')
        } else {
          showMessage(result.error || '获取密钥失败', false)
          setKeyStatus('')
        }

        return
      }

      const isRunning = await window.electronAPI.wxKey.isWeChatRunning()
      if (isRunning) {
        const shouldKill = window.confirm('检测到微信正在运行，需要重启微信才能获取密钥。\n是否关闭当前微信？')
        if (!shouldKill) {
          setKeyStatus('已取消')
          setIsGettingKey(false)
          return
        }
        setKeyStatus('正在关闭微信...')
        await window.electronAPI.wxKey.killWeChat()
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      setKeyStatus('正在启动微信...')
      const launched = await window.electronAPI.wxKey.launchWeChat()
      if (!launched) {
        showMessage('微信启动失败，请检查安装路径', false)
        setKeyStatus('')
        setIsGettingKey(false)
        return
      }

      setKeyStatus('等待微信窗口加载...')
      const windowReady = await window.electronAPI.wxKey.waitForWindow(15)
      if (!windowReady) {
        showMessage('等待微信窗口超时', false)
        setKeyStatus('')
        setIsGettingKey(false)
        return
      }

      const removeListener = window.electronAPI.wxKey.onStatus(({ status }) => {
        setKeyStatus(status)
      })

      setKeyStatus('Hook 已安装，请登录微信...')
      const result = await window.electronAPI.wxKey.startGetKey(undefined, dbPath || undefined)
      removeListener()

      if (result.success && result.key) {
        setDecryptKey(result.key)

        // 自动检测当前登录的微信账号
        setKeyStatus('正在检测当前登录账号...')

        // 先尝试较短的时间范围（刚登录的情况）
        let accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10) // 10分钟

        // 如果没找到，尝试更长的时间范围
        if (!accountInfo) {
          accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60) // 1小时
        }

        if (accountInfo) {
          setWxid(accountInfo.wxid)
          showMessage(`密钥获取成功！已自动绑定账号: ${accountInfo.wxid}`, true)
        } else {
          showMessage('密钥获取成功，已自动保存！（未能自动检测账号，请手动输入 wxid）', true)
        }
        setKeyStatus('')
      } else {
        showMessage(result.error || '获取密钥失败', false)
        setKeyStatus('')
      }
    } catch (e) {
      showMessage(`获取密钥失败: ${e}`, false)
      setKeyStatus('')
    } finally {
      setIsGettingKey(false)
    }
  }

  const handleCancelGetKey = async () => {
    await window.electronAPI.wxKey.cancel()
    setIsGettingKey(false)
    setKeyStatus('')
  }

  const handleOpenWelcomeWindow = async () => {
    try {
      await window.electronAPI.window.openWelcomeWindow('add-account')
    } catch (e) {
      showMessage('打开引导窗口失败', false)
    }
  }

  const handleSelectAccountForEdit = (account: AccountProfile) => {
    applyAccountToForm(account)
    setFields({
      decryptKey: account.decryptKey || '',
      dbPath: account.dbPath || '',
      wxid: account.wxid || '',
      cachePath: account.cachePath || '',
      imageXorKey: account.imageXorKey || '',
      imageAesKey: account.imageAesKey || '',
      editingAccountId: account.id
    })
    commit()
  }

  const handleSwitchAccountAndReconnect = async () => {
    if (!editingAccountId || editingAccountId === activeAccountId) {
      showMessage('当前没有待切换账号', false)
      return
    }

    if (hasUnsavedChanges) {
      showMessage('请先保存当前账号表单，再执行切换', false)
      return
    }

    const target = accountsList.find((item) => item.id === editingAccountId)
    if (!target) {
      showMessage('待切换账号不存在', false)
      return
    }

    if (!target.dbPath || !target.decryptKey || !target.wxid) {
      showMessage('待切换账号配置不完整，请先保存并补全账号信息', false)
      return
    }

    setIsLoadingState(true)
    setLoading(true, '正在切换账号...')
    try {
      const switched = await configService.setActiveAccount(target.id)
      if (!switched) {
        throw new Error('切换账号失败')
      }

      const result = await window.electronAPI.wcdb.testConnection(target.dbPath, target.decryptKey, target.wxid)
      if (!result.success) {
        throw new Error(result.error || '账号重连失败')
      }

      await window.electronAPI.chat.close()
      await window.electronAPI.chat.refreshCache()
      await window.electronAPI.chat.connect()
      setDbConnected(true, target.dbPath)
      setCurrentWxid(target.wxid)
      await refreshAccountsState(target.id)
      showMessage(`已切换到账号：${getAccountDisplayName(target)}`, true)
    } catch (e) {
      showMessage(`切换账号失败: ${e}`, false)
    } finally {
      setIsLoadingState(false)
      setLoading(false)
    }
  }

  const handleDeleteAccount = (account: AccountProfile) => {
    setSecurityConfirm({
      show: true,
      title: '删除账号',
      message: `删除账号 ${getAccountDisplayName(account)}？此操作仅删除配置，不删除本地解密数据。`,
      onConfirm: async () => {
        const result = await configService.deleteAccount(account.id, false)
        if (result.success) {
          await refreshAccountsState(result.nextActiveAccountId)
          showMessage('账号已删除', true)
        } else {
          showMessage(result.error || '删除账号失败', false)
        }
        setSecurityConfirm(prev => ({ ...prev, show: false }))
      }
    })
  }

  const handleDeleteAccountWithLocalData = (account: AccountProfile) => {
    setSecurityConfirm({
      show: true,
      title: '删除账号并清理本地数据',
      message: `将删除账号 ${getAccountDisplayName(account)} 的配置，并尝试删除该账号对应的本地解密数据库缓存。`,
      onConfirm: async () => {
        const result = await configService.deleteAccount(account.id, true)
        if (result.success) {
          await refreshAccountsState(result.nextActiveAccountId)
          showMessage('账号及其本地数据已删除', true)
        } else {
          showMessage(result.error || '删除账号失败', false)
        }
        setSecurityConfirm(prev => ({ ...prev, show: false }))
      }
    })
  }

  const handleClearCurrentAccountConfig = (deleteLocalData = false) => {
    setSecurityConfirm({
      show: true,
      title: deleteLocalData ? '清除当前账号并删除本地数据' : '清除当前账号',
      message: deleteLocalData
        ? '将清除当前账号配置，并尝试删除该账号对应的本地解密数据库缓存。'
        : '将只清除当前账号配置，不影响其他账号和全局设置。',
      onConfirm: async () => {
        const result = await window.electronAPI.cache.clearCurrentAccount(deleteLocalData)
        if (result.success) {
          await refreshAccountsState(activeAccountId)
          showMessage('当前账号配置已清除', true)
        } else {
          showMessage(result.error || '清除当前账号失败', false)
        }
        setSecurityConfirm(prev => ({ ...prev, show: false }))
      }
    })
  }

  const handleClearAllAccountConfigs = () => {
    setSecurityConfirm({
      show: true,
      title: '清空全部账号配置',
      message: '将删除所有账号配置和账号级密钥/路径信息，不会删除主题、AI、MCP、HTTP API 等通用设置。',
      onConfirm: async () => {
        const result = await window.electronAPI.cache.clearAllAccountConfigs()
        if (result.success) {
          await refreshAccountsState()
          await reloadConfig()
          showMessage('已清空全部账号配置', true)
        } else {
          showMessage(result.error || '清空全部账号配置失败', false)
        }
        setSecurityConfirm(prev => ({ ...prev, show: false }))
      }
    })
  }

  const handleSelectDbPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择微信数据库根目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setDbPath(result.filePaths[0])
        setWxid('')
        setWxidOptions([])
        setShowWxidDropdown(false)
        setIsAccountVerified(false)
        showMessage('已选择数据库目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleSelectCachePath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择缓存目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setCachePath(result.filePaths[0])
        showMessage('已选择缓存目录', true)
      }
    } catch (e) {
      showMessage('选择缓存目录失败', false)
    }
  }

  // 扫描 wxid
  const handleScanWxid = async () => {
    if (!dbPath) {
      showMessage('请先配置数据库路径', false)
      return
    }
    if (isScanningWxid) return

    setIsScanningWxid(true)
    try {
      const wxids = await window.electronAPI.dbPath.scanWxids(dbPath)
      setIsAccountVerified(false)
      if (wxids.length === 0) {
        showMessage('未检测到账号目录（需包含 db_storage 文件夹）', false)
        setWxidOptions([])
      } else if (wxids.length === 1) {
        // 只有一个账号，直接设置
        setWxid(wxids[0])
        showMessage(`已检测到候选账号目录：${wxids[0]}（待验证）`, true)
        setWxidOptions([])
        setShowWxidDropdown(false)
      } else {
        let selectedWxid = ''

        if (decryptKey.length === 64) {
          const resolved = await window.electronAPI.wcdb.resolveValidWxid(dbPath, decryptKey)
          if (resolved.success && resolved.wxid && wxids.includes(resolved.wxid)) {
            selectedWxid = resolved.wxid
            setWxid(selectedWxid)
          }
        }

        if (!selectedWxid) {
          let accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 10)
          if (!accountInfo) {
            accountInfo = await window.electronAPI.wxKey.detectCurrentAccount(dbPath, 60)
          }

          if (accountInfo && wxids.includes(accountInfo.wxid)) {
            selectedWxid = accountInfo.wxid
            setWxid(selectedWxid)
          }
        }

        setWxidOptions(wxids)
        setShowWxidDropdown(true)
        showMessage(
          selectedWxid
            ? `检测到 ${wxids.length} 个候选账号目录，已按最新活动优先选择：${selectedWxid}`
            : `检测到 ${wxids.length} 个候选账号目录，请选择后验证`,
          true
        )
      }
    } catch (e) {
      showMessage(`扫描失败: ${e}`, false)
    } finally {
      setIsScanningWxid(false)
    }
  }

  // 选择 wxid
  const handleSelectWxid = async (selectedWxid: string) => {
    setWxid(selectedWxid)
    setIsAccountVerified(false)
    setShowWxidDropdown(false)
    showMessage(`已选择候选账号目录：${selectedWxid}（待验证）`, true)
  }

  const handleVerifyAccountDirectory = async () => {
    if (!dbPath) { showMessage('请先选择数据库目录', false); return }
    if (!decryptKey || decryptKey.length !== 64) { showMessage('请先配置64位解密密钥', false); return }
    if (!wxid) { showMessage('请先选择账号目录', false); return }

    setIsVerifyingAccount(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (result.success) {
        setIsAccountVerified(true)
        showMessage(`账号目录验证成功：${wxid}`, true)
      } else {
        setIsAccountVerified(false)
        showMessage(result.error || '账号目录验证失败，请更换目录重试', false)
      }
    } catch (e) {
      setIsAccountVerified(false)
      showMessage(`账号目录验证失败: ${e}`, false)
    } finally {
      setIsVerifyingAccount(false)
    }
  }

  const handleTestConnection = async () => {
    if (!dbPath) { showMessage('请先选择数据库目录', false); return }
    if (!decryptKey) { showMessage('请先输入解密密钥', false); return }
    if (decryptKey.length !== 64) { showMessage('密钥长度必须为64个字符', false); return }
    if (!wxid) { showMessage('请先选择账号目录', false); return }
    if (!isAccountVerified) { showMessage('请先验证账号目录', false); return }

    setIsTesting(true)
    try {
      const result = await window.electronAPI.wcdb.testConnection(dbPath, decryptKey, wxid)
      if (result.success) {
        showMessage('连接测试成功！数据库可正常访问', true)
      } else {
        showMessage(result.error || '连接测试失败', false)
      }
    } catch (e) {
      showMessage(`连接测试失败: ${e}`, false)
    } finally {
      setIsTesting(false)
    }
  }

  const renderDatabaseTab = () => (
    <div className="tab-content">
      <h3 className="section-title">账号管理</h3>
      <div className="form-group">
        <button className="btn btn-secondary" onClick={handleOpenWelcomeWindow}>
          <Zap size={16} /> 新增账号引导
        </button>
        <span className="form-hint">使用引导窗口一步步新增账号，不会覆盖其他已保存账号</span>

        <div className="form-hint" style={{ marginBottom: '10px' }}>
          当前激活账号：{getAccountDisplayName(accountsList.find(item => item.id === activeAccountId) || null) || '未设置'}
        </div>
        {accountsList.length > 0 ? (
          <div className="wxid-options">
            {accountsList.map((account) => (
              <button
                key={account.id}
                className={`wxid-option ${editingAccountId === account.id ? 'is-selected' : ''}`}
                onClick={() => handleSelectAccountForEdit(account)}
              >
                <div className="wxid-option-name">
                  {getAccountDisplayName(account)}
                  {account.id === activeAccountId ? '（当前激活）' : ''}
                </div>
                <div className="field-hint">微信 ID：{account.wxid || '未设置'}</div>
                <div className="field-hint">{account.dbPath || '未设置数据库路径'}</div>
              </button>
            ))}
          </div>
        ) : (
          <div className="form-hint">当前还没有已保存账号，请先新增一个账号。</div>
        )}
        <div className="btn-row" style={{ marginTop: '12px' }}>
          <button className="btn btn-secondary" onClick={onSave} disabled={isLoading}>
            <Save size={16} /> 使用当前表单更新此账号
          </button>
          <button className="btn btn-secondary" onClick={handleSwitchAccountAndReconnect} disabled={!editingAccountId || editingAccountId === activeAccountId || isLoading}>
            <RefreshCw size={16} /> 切换并重连
          </button>
          <button
            className="btn btn-danger"
            onClick={() => {
              const account = accountsList.find(item => item.id === editingAccountId)
              if (account) handleDeleteAccount(account)
            }}
            disabled={!editingAccountId || isLoading}
          >
            <Trash2 size={16} /> 删除账号
          </button>
          <button
            className="btn btn-danger"
            onClick={() => {
              const account = accountsList.find(item => item.id === editingAccountId)
              if (account) handleDeleteAccountWithLocalData(account)
            }}
            disabled={!editingAccountId || isLoading}
          >
            <Trash2 size={16} /> 删除并清理数据
          </button>
        </div>
      </div>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>缓存目录</h3>
      <div className="form-group">
        <label>缓存目录 <span className="optional">(可选)</span></label>
        <span className="form-hint">留空使用默认目录，建议选择空间充足的磁盘</span>
        <input
          type="text"
          placeholder="留空使用默认目录"
          value={cachePath}
          onChange={(e) => setCachePath(e.target.value)}
        />
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={handleSelectCachePath}>
            <FolderOpen size={16} /> 浏览选择
          </button>
          <button className="btn btn-secondary" onClick={() => setCachePath('')}>
            <RotateCcw size={16} /> 恢复默认
          </button>
        </div>
      </div>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>数据库配置</h3>

      <div className="form-group">
        <label>解密密钥</label>
        <span className="form-hint">64位十六进制密钥，用于验证当前账号数据库连接</span>
        <div className="input-with-toggle">
          <input
            type={showDecryptKey ? 'text' : 'password'}
            placeholder="请输入或自动获取解密密钥"
            value={decryptKey}
            onChange={(e) => {
              setDecryptKey(e.target.value)
              setIsAccountVerified(false)
            }}
          />
          <button type="button" className="toggle-visibility" onClick={() => setShowDecryptKey(!showDecryptKey)}>
            {showDecryptKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        {keyStatus && <p className="key-status">{keyStatus}</p>}
        <div className="btn-row">
          <button className="btn btn-primary" onClick={handleGetKey} disabled={isGettingKey}>
            <Key size={16} /> {isGettingKey ? '获取中...' : '自动获取密钥'}
          </button>
          {isGettingKey && (
            <button className="btn btn-secondary" onClick={handleCancelGetKey}>
              <X size={16} /> 取消
            </button>
          )}
        </div>
      </div>

      <div className="form-group">
        <label>数据库根目录</label>
        <span className="form-hint">选择微信账号数据所在目录，通常是 WeChat Files 的上级或包含 db_storage 的目录</span>
        <input
          type="text"
          placeholder="请选择微信数据库根目录"
          value={dbPath}
          onChange={(e) => {
            setDbPath(e.target.value)
            setWxid('')
            setWxidOptions([])
            setShowWxidDropdown(false)
            setIsAccountVerified(false)
          }}
        />
        <div className="btn-row">
          <button className="btn btn-secondary" onClick={handleSelectDbPath}>
            <FolderOpen size={16} /> 浏览选择
          </button>
        </div>
      </div>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>图片解密</h3>
      <p className="section-desc">您只负责获取密钥，其他的交给密语-CipherTalk</p>

      <div className="form-group">
        <label>XOR 密钥</label>
        <span className="form-hint">{isMac ? 'kvcomm 校验成功后返回的 XOR 密钥，格式如 0x53' : '2位十六进制，如 0x53'}</span>
        <div className="input-with-toggle">
          <input type={showXorKey ? 'text' : 'password'} placeholder="例如: 0x12" value={imageXorKey} onChange={(e) => setImageXorKey(e.target.value)} />
          <button type="button" className="toggle-visibility" onClick={() => setShowXorKey(!showXorKey)}>
            {showXorKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      <div className="form-group">
        <label>AES 密钥</label>
        <span className="form-hint">{isMac ? '16位字符串；优先走 kvcomm + wxid 验真，失败才回退到内存扫描' : '至少16个字符（V4版本图片需要）'}</span>
        <div className="input-with-toggle">
          <input type={showAesKey ? 'text' : 'password'} placeholder="例如: b123456789012345..." value={imageAesKey} onChange={(e) => setImageAesKey(e.target.value)} />
          <button type="button" className="toggle-visibility" onClick={() => setShowAesKey(!showAesKey)}>
            {showAesKey ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
      </div>

      {imageKeyStatus && <p className="key-status">{imageKeyStatus}</p>}

      <button className="btn btn-primary" onClick={handleGetImageKey} disabled={isGettingImageKey}>
        <ImageIcon size={16} /> {isGettingImageKey ? '获取中...' : '自动获取图片密钥'}
      </button>
      <span className="form-hint">
        {isMac ? '优先扫描 kvcomm 和模板文件；只有前者不可用时才回退到微信进程内存扫描。' : '请先在电脑微信中打开几张图片，再执行自动获取。'}
      </span>

      <h3 className="section-title" style={{ marginTop: '2rem' }}>账号验证</h3>
      <div className="form-group wxid-group">
        <label>账号验证配置</label>
        <span className="form-hint">请选择或填写候选账号目录，验证成功后才会作为当前账号配置保存</span>
        <div className="wxid-row">
          <div className="input-with-dropdown">
            <input
              type="text"
              placeholder="例如 wxid_xxxxx"
              value={wxid}
              onChange={(e) => {
                setWxid(e.target.value)
                setIsAccountVerified(false)
              }}
              onFocus={() => wxidOptions.length > 0 && setShowWxidDropdown(true)}
            />
            {showWxidDropdown && wxidOptions.length > 0 && (
              <div className="wxid-dropdown">
                <div className="dropdown-header">
                  <span className="dropdown-hint">候选账号目录</span>
                  <button type="button" className="close-dropdown" onClick={() => setShowWxidDropdown(false)}>
                    <X size={14} />
                  </button>
                </div>
                <div className="dropdown-list">
                  {wxidOptions.map((option) => (
                    <div
                      key={option}
                      className={`wxid-option ${wxid === option ? 'active' : ''}`}
                      onClick={() => handleSelectWxid(option)}
                    >
                      <span className="option-icon">{wxid === option ? <Check size={14} /> : <Check size={14} className="invisible" />}</span>
                      <span className="option-text">{option}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button className="btn btn-secondary btn-icon" onClick={handleScanWxid} disabled={isScanningWxid || !dbPath}>
            <Search size={16} className={isScanningWxid ? 'spin' : ''} /> {isScanningWxid ? '扫描中...' : '扫描账号'}
          </button>
          <button className="btn btn-secondary btn-icon" onClick={handleVerifyAccountDirectory} disabled={isVerifyingAccount || !dbPath || !decryptKey || !wxid}>
            <ShieldCheck size={16} /> {isVerifyingAccount ? '验证中...' : '验证账号'}
          </button>
        </div>
        <div className="btn-row" style={{ marginTop: '10px' }}>
          <button className="btn btn-secondary" onClick={handleTestConnection} disabled={isTesting || !isAccountVerified}>
            <Plug size={16} /> {isTesting ? '测试中...' : '测试连接'}
          </button>
          <span className="form-hint" style={{ marginBottom: 0 }}>
            {isAccountVerified ? '账号目录已验证' : '账号目录未验证'}
          </span>
        </div>
      </div>
    </div>
  )

  const [isGettingImageKey, setIsGettingImageKey] = useState(false)
  const [imageKeyStatus, setImageKeyStatus] = useState('')

  const handleGetImageKey = async () => {
    if (isGettingImageKey) return
    if (!dbPath) {
      showMessage('请先配置数据库路径', false)
      return
    }
    if (!wxid) {
      showMessage('请先配置 wxid', false)
      return
    }

    setIsGettingImageKey(true)
    setImageKeyStatus('正在从缓存目录扫描图片密钥...')

    try {
      // 构建用户目录路径（用于 wxid 匹配）
      const separator = dbPath.includes('\\') && !dbPath.includes('/') ? '\\' : '/'
      const userDir = `${dbPath.replace(/[\\/]+$/, '')}${separator}${wxid}`

      const removeListener = window.electronAPI.imageKey.onProgress((msg) => {
        setImageKeyStatus(msg)
      })

      const result = await window.electronAPI.imageKey.getImageKeys(userDir)
      removeListener()

      if (result.success) {
        if (result.xorKey !== undefined) {
          const xorKeyHex = `0x${result.xorKey.toString(16).padStart(2, '0')}`
          setImageXorKey(xorKeyHex)
        }
        if (result.aesKey) {
          setImageAesKey(result.aesKey)
        }
        showMessage('图片密钥获取成功！', true)
        setImageKeyStatus('')
      } else {
        showMessage(result.error || '获取图片密钥失败', false)
        setImageKeyStatus('')
      }
    } catch (e) {
      showMessage(`获取图片密钥失败: ${e}`, false)
      setImageKeyStatus('')
    } finally {
      setIsGettingImageKey(false)
    }
  }


  return (
    <>
      {securityConfirm.show && (
        <ConfirmDialog
          title={securityConfirm.title}
          titleIcon={<AlertCircle className="text-warning" size={20} color="#f59e0b" />}
          message={securityConfirm.message}
          actions={(
            <>
              <button className="btn btn-secondary" onClick={() => setSecurityConfirm(prev => ({ ...prev, show: false }))}>取消</button>
              <button className="btn btn-primary" onClick={securityConfirm.onConfirm}>确定</button>
            </>
          )}
        />
      )}
      {renderDatabaseTab()}
    </>
  )
}

export default DatabaseTab
