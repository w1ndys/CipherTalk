import { useState } from 'react'
import { Lock, Fingerprint, Check, ShieldCheck, Save, AlertCircle } from 'lucide-react'
import { useAuthStore } from '../../../stores/authStore'
import { ConfirmDialog } from '../ui'

interface SecurityTabProps {
  isMac: boolean
  showMessage: (text: string, success: boolean) => void
}

interface SecurityConfirmState {
  show: boolean
  title: string
  message: string
  onConfirm: () => void
}

function SecurityTab({ isMac, showMessage }: SecurityTabProps) {
  const { isAuthEnabled, enableAuth, disableAuth, setupPassword, authMethod } = useAuthStore()
  const [passwordInput, setPasswordInput] = useState('')
  const [showPasswordInput, setShowPasswordInput] = useState(false)
  const [securityConfirm, setSecurityConfirm] = useState<SecurityConfirmState>({
    show: false, title: '', message: '', onConfirm: () => { }
  })

  const biometricLabel = isMac ? 'Touch ID' : 'Windows Hello'

  const activateBiometric = async () => {
    showMessage(`正在等待${biometricLabel}验证...`, true)
    const result = await enableAuth()
    if (result.success) {
      showMessage(`已启用${biometricLabel}`, true)
      setShowPasswordInput(false)
    } else {
      showMessage(result.error || '启用失败', false)
    }
  }

  const handleSecurityMethodSelect = async (method: 'biometric' | 'password') => {
    // 1. 如果点击的是当前已激活的方法 -> 关闭
    if (isAuthEnabled && authMethod === method) {
      await disableAuth()
      showMessage('已关闭应用锁', true)
      if (method === 'password') {
        setShowPasswordInput(false)
        setPasswordInput('')
      }
      return
    }

    // 2. 如果点击的是另一个方法 -> 确认切换
    if (isAuthEnabled && authMethod !== method) {
      setSecurityConfirm({
        show: true,
        title: '切换认证方式',
        message: method === 'biometric'
          ? `切换到${biometricLabel}将清除当前的密码设置，是否继续？`
          : '切换到密码认证将清除当前的生物识别设置，是否继续？',
        onConfirm: async () => {
          await disableAuth()
          if (method === 'biometric') {
            activateBiometric()
          } else {
            setShowPasswordInput(true)
          }
          setSecurityConfirm(prev => ({ ...prev, show: false }))
        }
      })
      return
    }

    // 3. 如果当前未激活任何方法 -> 直接开启
    if (method === 'biometric') {
      activateBiometric()
    } else {
      setShowPasswordInput(true)
    }
  }

  return (
    <div className="tab-content">
      <h3 className="section-title">安全保护</h3>
      <div className="section-desc">
        {isMac ? '配置应用启动时的安全验证方式。macOS 优先使用 Touch ID，设备不支持时可改用自定义密码。' : '配置应用启动时的安全验证方式，保护您的隐私数据。'}
      </div>

      <div className="security-grid">
        <div
          className={`security-card ${isAuthEnabled && authMethod === 'biometric' ? 'active' : ''}`}
          onClick={() => handleSecurityMethodSelect('biometric')}
          style={{ cursor: 'pointer' }}
        >
          <div className="security-preview-area">
            <div className="preview-lock-screen">
              <div className="preview-avatar">
                <Lock size={20} />
              </div>
              <div className="preview-badge">
                <Fingerprint /> {biometricLabel}
              </div>
              <div className="preview-btn" />
            </div>
          </div>
          <div className="security-content">
            <div className="security-header">
              <span className="security-title">{biometricLabel}</span>
              {isAuthEnabled && authMethod === 'biometric' && (
                <div className="theme-check" style={{ position: 'relative', top: 0, right: 0, transform: 'scale(1)', background: 'var(--primary)', boxShadow: 'none' }}>
                  <Check size={12} />
                </div>
              )}
            </div>
            <div className="security-desc">
              {isMac
                ? '使用 macOS 系统 Touch ID 进行验证。设备未启用或不支持时，请改用自定义密码。'
                : '使用系统的面部识别、指纹或 PIN 码进行验证。体验最流畅，安全性高。'}
            </div>
          </div>
        </div>

        {/* Custom Password Card */}
        <div
          className={`security-card ${isAuthEnabled && authMethod === 'password' ? 'active' : ''}`}
          onClick={() => handleSecurityMethodSelect('password')}
          style={{ cursor: 'pointer' }}
        >
          <div className="security-preview-area">
            <div className="preview-lock-screen">
              <div className="preview-avatar">
                <ShieldCheck size={20} />
              </div>
              <div className="preview-input" />
              <div className="preview-btn" style={{ width: '32px' }} />
            </div>
          </div>
          <div className="security-content">
            <div className="security-header">
              <span className="security-title">自定义应用密码</span>
              {isAuthEnabled && authMethod === 'password' && (
                <div className="theme-check" style={{ position: 'relative', top: 0, right: 0, transform: 'scale(1)', background: 'var(--primary)', boxShadow: 'none' }}>
                  <Check size={12} />
                </div>
              )}
            </div>
            <div className="security-desc">
              {isMac
                ? '设置应用专属密码。当前 macOS 侧只提供这一种应用锁方式。'
                : '设置应用专属密码。如果不方便使用生物识别，或者需要在多台设备间同步配置时推荐。'}
            </div>

            {/* Input area - prevent click propagation to avoid toggling card off while typing */}
            {(showPasswordInput || (isAuthEnabled && authMethod === 'password')) && (
              <div
                className="password-setup-inline"
                onClick={(e) => e.stopPropagation()}
                style={{ cursor: 'default' }}
              >
                <label className="field-label">
                  {authMethod === 'password' ? '修改密码 (留空不修改)' : '设置新密码'}
                </label>
                <div className="password-input-row">
                  <input
                    type="password"
                    className="field-input"
                    value={passwordInput}
                    onChange={(e) => setPasswordInput(e.target.value)}
                    placeholder="******"
                  />
                  <button
                    className="btn btn-primary"
                    disabled={!passwordInput}
                    onClick={async () => {
                      if (!passwordInput) return
                      const result = await setupPassword(passwordInput)
                      if (result.success) {
                        showMessage(authMethod === 'password' ? '密码已更新' : '已启用密码锁', true)
                        setPasswordInput('')
                        setShowPasswordInput(false)
                      } else {
                        showMessage(result.error || '设置失败', false)
                      }
                    }}
                  >
                    <Save size={14} /> 保存
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Confirmation Modal */}
      {securityConfirm.show && (
        <ConfirmDialog
          title={securityConfirm.title}
          titleIcon={<AlertCircle className="text-warning" size={20} color="#f59e0b" />}
          message={securityConfirm.message}
          actions={(
            <>
              <button
                className="btn btn-secondary"
                onClick={() => setSecurityConfirm(prev => ({ ...prev, show: false }))}
              >
                取消
              </button>
              <button
                className="btn btn-primary"
                onClick={securityConfirm.onConfirm}
              >
                确定
              </button>
            </>
          )}
        />
      )}
    </div>
  )
}

export default SecurityTab
