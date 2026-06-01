import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Alert,
  Button,
  Card,
  Chip,
  Description,
  Disclosure,
  FieldError,
  Input,
  Label,
  ScrollShadow,
  Spinner,
  Switch,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Toast,
  toast,
} from '@heroui/react'
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  FileText,
  Globe,
  Link2,
  Network,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import * as configService from '../services/config'
import { useTitleBarStore } from '../stores/titleBarStore'

const HTTP_API_DOC_URL = 'https://ciphertalk.apifox.cn/'

type HttpApiListenMode = 'localhost' | 'lan'

type HttpApiStatus = {
  running: boolean
  host: string
  listenMode: HttpApiListenMode
  port: number
  enabled: boolean
  startedAt: string
  uptimeMs: number
  tokenConfigured: boolean
  tokenPreview: string
  baseUrl: string
  chatlabBaseUrl: string
  lanAddresses: string[]
  endpoints: Array<{ method: string; path: string; desc: string }>
  lastError: string
}

type MetricCardProps = {
  label: string
  value: ReactNode
  helper?: string
}

function formatDuration(durationMs: number) {
  if (!durationMs || durationMs <= 0) return '0 秒'

  const totalSeconds = Math.floor(durationMs / 1000)
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  const parts = [
    days > 0 ? `${days} 天` : null,
    hours > 0 ? `${hours} 小时` : null,
    minutes > 0 ? `${minutes} 分钟` : null,
    seconds > 0 ? `${seconds} 秒` : null,
  ].filter(Boolean)

  return parts.slice(0, 3).join(' ')
}

function createRandomToken() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `ct_${crypto.randomUUID().replace(/-/g, '')}`
  }

  const randomPart = Math.random().toString(36).slice(2)
  const randomPart2 = Math.random().toString(36).slice(2)
  return `ct_${Date.now().toString(36)}_${randomPart}${randomPart2}`
}

function getEndpointUrl(baseUrl: string, path: string) {
  if (path === '/v1' || path === '/v1/') {
    return baseUrl
  }

  return `${baseUrl}${path.replace(/^\/v1/, '')}`
}

function MetricCard({ label, value, helper }: MetricCardProps) {
  return (
    <Card className="p-2.25 rounded-2xl border border-border bg-surface">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">{label}</span>
        {typeof value === 'string'
          ? <span className="text-sm font-bold text-foreground">{value}</span>
          : value}
        {helper && (
          <span className="text-xs text-muted">{helper}</span>
        )}
      </div>
    </Card>
  )
}

function OpenApiPage() {
  const [httpApiEnabled, setHttpApiEnabled] = useState(false)
  const [httpApiPort, setHttpApiPort] = useState(5031)
  const [httpApiToken, setHttpApiToken] = useState('')
  const [httpApiListenMode, setHttpApiListenMode] = useState<HttpApiListenMode>('localhost')
  const [showHttpApiToken, setShowHttpApiToken] = useState(false)
  const [httpApiStatus, setHttpApiStatus] = useState<HttpApiStatus | null>(null)
  const [isSavingHttpApi, setIsSavingHttpApi] = useState(false)
  const [isRefreshingHttpApi, setIsRefreshingHttpApi] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [nowTs, setNowTs] = useState(Date.now())

  const setTitleBarContent = useTitleBarStore((state) => state.setRightContent)

  const copyText = async (text: string, successText: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(successText)
    } catch {
      toast.danger('复制失败，请手动复制')
    }
  }

  const applyStatusToForm = (status: HttpApiStatus) => {
    setHttpApiEnabled(status.enabled)
    setHttpApiPort(status.port)
    setHttpApiListenMode(status.listenMode)
  }

  useEffect(() => {
    const load = async () => {
      try {
        const [enabled, port, token, listenMode, statusResult] = await Promise.all([
          configService.getHttpApiEnabled(),
          configService.getHttpApiPort(),
          configService.getHttpApiToken(),
          configService.getHttpApiListenMode(),
          window.electronAPI.httpApi.getStatus(),
        ])

        setHttpApiEnabled(enabled)
        setHttpApiPort(port)
        setHttpApiToken(token)
        setHttpApiListenMode(listenMode)

        if (statusResult.success && statusResult.status) {
          setHttpApiStatus(statusResult.status)
          applyStatusToForm(statusResult.status)
        }
      } catch (error) {
        toast.danger(`加载开放接口配置失败: ${error}`)
      }
    }

    load()
  }, [])

  useEffect(() => {
    if (!httpApiStatus?.running) return

    const timer = window.setInterval(() => setNowTs(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [httpApiStatus?.running])

  useEffect(() => {
    setTitleBarContent(
      <Button
        variant="secondary"
        size="sm"
        className="h-8.5 px-3 rounded-full"
        onPress={() => window.electronAPI.shell.openExternal(HTTP_API_DOC_URL)}
      >
        <FileText size={14} />
        接口文档
      </Button>
    )

    return () => setTitleBarContent(null)
  }, [setTitleBarContent])

  const refreshHttpApiStatus = async () => {
    setIsRefreshingHttpApi(true)

    try {
      const result = await window.electronAPI.httpApi.getStatus()
      if (result.success && result.status) {
        setHttpApiStatus(result.status)
        applyStatusToForm(result.status)
      } else {
        toast.danger(result.error || '获取接口状态失败')
      }
    } catch (error) {
      toast.danger(`获取接口状态失败: ${error}`)
    } finally {
      setIsRefreshingHttpApi(false)
    }
  }

  const isPortInvalid = !Number.isInteger(httpApiPort) || httpApiPort < 1 || httpApiPort > 65535
  const isLanWithoutToken = httpApiListenMode === 'lan' && !httpApiToken.trim()

  const handleSaveHttpApiSettings = async () => {
    if (isPortInvalid) {
      toast.danger('监听端口需在 1 到 65535 之间')
      return
    }

    if (isLanWithoutToken) {
      toast.danger('局域网模式必须先配置访问密钥')
      return
    }

    setIsSavingHttpApi(true)

    try {
      const result = await window.electronAPI.httpApi.applySettings({
        enabled: httpApiEnabled,
        port: httpApiPort,
        token: httpApiToken,
        listenMode: httpApiListenMode,
      })

      if (result.success && result.status) {
        setHttpApiStatus(result.status)
        applyStatusToForm(result.status)
        await Promise.all([
          configService.setHttpApiEnabled(httpApiEnabled),
          configService.setHttpApiPort(result.status.port),
          configService.setHttpApiToken(httpApiToken),
          configService.setHttpApiListenMode(httpApiListenMode),
        ])
        toast.success('开放接口配置已保存并生效')
      } else {
        toast.danger(result.error || '保存开放接口配置失败')
      }
    } catch (error) {
      toast.danger(`保存开放接口配置失败: ${error}`)
    } finally {
      setIsSavingHttpApi(false)
    }
  }

  const handleRestartHttpApi = async () => {
    setIsRefreshingHttpApi(true)

    try {
      const result = await window.electronAPI.httpApi.restart()
      if (result.success && result.status) {
        setHttpApiStatus(result.status)
        applyStatusToForm(result.status)
        toast.success('接口服务已重启')
      } else {
        toast.danger(result.error || '接口服务重启失败')
      }
    } finally {
      setIsRefreshingHttpApi(false)
    }
  }

  const status = httpApiStatus
  const startedAtMs = status?.startedAt ? new Date(status.startedAt).getTime() : 0
  const uptime = status?.running && startedAtMs > 0
    ? Math.max(0, nowTs - startedAtMs)
    : (status?.uptimeMs ?? 0)
  const uptimeText = formatDuration(uptime)

  const fallbackHost = httpApiListenMode === 'lan' && status?.lanAddresses?.[0]
    ? status.lanAddresses[0]
    : '127.0.0.1'
  const baseUrl = status?.baseUrl || `http://${fallbackHost}:${isPortInvalid ? 5031 : httpApiPort}/v1`
  const chatlabBaseUrl = status?.chatlabBaseUrl || `http://${fallbackHost}:${isPortInvalid ? 5031 : httpApiPort}/chatlab`
  const advancedEndpoints = useMemo(
    () => (status?.endpoints || []).filter((endpoint) => endpoint.path.startsWith('/v1')),
    [status?.endpoints]
  )

  const listenModeLabel = httpApiListenMode === 'lan' ? '局域网监听' : '仅本机监听'
  const listenModeHint = httpApiListenMode === 'lan'
    ? '绑定 0.0.0.0，同网段设备可直接访问。'
    : '绑定 127.0.0.1，仅当前设备可访问。'

  return (
    <>
      <Toast.Provider placement="top" />
      <ScrollShadow hideScrollBar className="h-full min-h-0 pb-3" size={56}>
        <div className="flex flex-col gap-3">
            {/* Header */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
              <div className="max-w-xl">
                <h1 className="text-[26px] md:text-[30px] font-bold text-foreground">
                  开放接口
                </h1>
                <p className="mt-1 text-sm text-muted leading-relaxed">
                  这里优先用于对接 ChatLab Pull 数据源。默认只保留必要的接入信息，原生
                  <code className="mx-1.5 px-2 py-0.5 rounded-full bg-surface-tertiary border border-border text-xs font-mono">
                    /v1
                  </code>
                  端点收进下方高级接口。
                </p>
              </div>

              <div className="flex gap-2 flex-wrap">
                <Chip color={httpApiListenMode === 'lan' ? 'accent' : 'default'} variant="secondary" size="sm">
                  {listenModeLabel}
                </Chip>
                <Chip color={httpApiToken.trim() ? 'success' : 'danger'} variant="secondary" size="sm">
                  {httpApiToken.trim() ? 'Bearer 鉴权已配置' : 'Bearer 鉴权未配置'}
                </Chip>
              </div>
            </div>

            {/* Alert banner */}
            <Alert status={httpApiEnabled ? 'accent' : 'default'}>
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>
                  {httpApiEnabled
                    ? 'HTTP API 已启用配置'
                    : 'HTTP API 当前关闭'}
                </Alert.Title>
                <Alert.Description>
                  {httpApiEnabled
                    ? '保存后会立即同步监听地址、端口和访问密钥。'
                    : '保存并应用后才会开始监听端口，对外提供接口。'}
                </Alert.Description>
              </Alert.Content>
            </Alert>

            {/* 数据源接入 */}
            <Card>
              <Card.Header>
                <Card.Title>数据源接入</Card.Title>
                <Card.Description>
                  把 HTTP API 和 ChatLab 数据源接入入口放在同一处，减少来回切换。
                </Card.Description>
              </Card.Header>
              <Card.Content>
                <div className="flex flex-col gap-[10px]">
                  {/* Enable switch */}
                  <Card className="p-2.25 rounded-2xl border border-border bg-surface">
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <span className="text-sm font-bold text-foreground">启用 HTTP API</span>
                        <p className="mt-0.5 text-xs text-muted">
                          关闭后会停止监听端口，ChatLab 和其他外部调用都不可用。
                        </p>
                      </div>

                      <Switch
                        isSelected={httpApiEnabled}
                        onChange={setHttpApiEnabled}
                        aria-label={httpApiEnabled ? '关闭 HTTP API' : '启用 HTTP API'}
                      >
                        <Switch.Control>
                          <Switch.Thumb />
                        </Switch.Control>
                      </Switch>
                    </div>
                  </Card>

                  {/* Listen mode */}
                  <Card className="p-2.25 rounded-2xl border border-border bg-surface">
                    <div className="flex flex-col gap-1.5">
                      <span className="text-sm font-bold text-foreground">监听模式</span>
                      <ToggleButtonGroup
                        selectedKeys={new Set([httpApiListenMode])}
                        onSelectionChange={(keys) => {
                          const value = Array.from(keys)[0] as string
                          if (value) setHttpApiListenMode(value as HttpApiListenMode)
                        }}
                        className="self-start"
                      >
                        <ToggleButton id="localhost">仅本机</ToggleButton>
                        <ToggleButton id="lan">局域网</ToggleButton>
                      </ToggleButtonGroup>
                      <span className="text-xs text-muted">{listenModeHint}</span>
                    </div>
                  </Card>

                  {/* Port + Token */}
                  <div className="grid grid-cols-1 md:grid-cols-[minmax(220px,280px)_1fr] gap-2">
                    {/* Port field */}
                    <TextField
                      value={String(httpApiPort)}
                      onChange={(v) => {
                        const nextPort = Number.parseInt(v, 10)
                        setHttpApiPort(Number.isNaN(nextPort) ? 0 : nextPort)
                      }}
                      isInvalid={isPortInvalid}
                      className="w-full"
                    >
                      <Label>监听端口</Label>
                      <div className="relative">
                        <Input
                          type="number"
                          placeholder="5031"
                          min={1}
                          max={65535}
                          inputMode="numeric"
                          className="pr-[52px]"
                        />
                        <div className="absolute right-0 top-0 bottom-0 flex flex-col w-[48px] -mr-[2px] border-l border-border bg-surface-tertiary rounded-r-[inherit] overflow-hidden">
                          <Button
                            isIconOnly
                            size="sm"
                            variant="tertiary"
                            aria-label="端口加 1"
                            isDisabled={httpApiPort >= 65535}
                            className="flex-1 w-full rounded-none border-b border-border"
                            onPress={() => setHttpApiPort((p) => Math.min(65535, (p > 0 ? p : 5031) + 1))}
                          >
                            <ChevronUp size={14} />
                          </Button>
                          <Button
                            isIconOnly
                            size="sm"
                            variant="tertiary"
                            aria-label="端口减 1"
                            isDisabled={httpApiPort <= 1}
                            className="flex-1 w-full rounded-none"
                            onPress={() => setHttpApiPort((p) => Math.max(1, (p > 0 ? p : 5031) - 1))}
                          >
                            <ChevronDown size={14} />
                          </Button>
                        </div>
                      </div>
                      {isPortInvalid ? (
                        <FieldError>端口必须在 1 到 65535 之间</FieldError>
                      ) : (
                        <Description>建议保持默认 5031</Description>
                      )}
                    </TextField>

                    {/* Token field */}
                    <TextField
                      value={httpApiToken}
                      onChange={setHttpApiToken}
                      isInvalid={isLanWithoutToken}
                      className="w-full"
                    >
                      <Label>访问密钥</Label>
                      <div className="relative">
                        <Input
                          type={showHttpApiToken ? 'text' : 'password'}
                          placeholder="局域网模式下必须填写"
                          className="pr-[120px]"
                        />
                        <div className="absolute right-0 top-0 bottom-0 flex items-center gap-0 shrink-0 -mr-[2px] px-1 border-l border-border bg-surface-tertiary rounded-r-[inherit]">
                          <Tooltip delay={0}>
                            <Button
                              isIconOnly
                              size="sm"
                              variant="tertiary"
                              aria-label={showHttpApiToken ? '隐藏密钥' : '显示密钥'}
                              onPress={() => setShowHttpApiToken((v) => !v)}
                            >
                              {showHttpApiToken ? <EyeOff size={16} /> : <Eye size={16} />}
                            </Button>
                            <Tooltip.Content><p>{showHttpApiToken ? '隐藏密钥' : '显示密钥'}</p></Tooltip.Content>
                          </Tooltip>

                          <Tooltip delay={0}>
                            <Button
                              isIconOnly
                              size="sm"
                              variant="tertiary"
                              aria-label="生成随机密钥"
                              onPress={() => setHttpApiToken(createRandomToken())}
                            >
                              <Sparkles size={16} />
                            </Button>
                            <Tooltip.Content><p>生成随机密钥</p></Tooltip.Content>
                          </Tooltip>

                          {httpApiToken.trim() && (
                            <Tooltip delay={0}>
                              <Button
                                isIconOnly
                                size="sm"
                                variant="tertiary"
                                aria-label="复制访问密钥"
                                onPress={() => copyText(httpApiToken, '访问密钥已复制')}
                              >
                                <Copy size={16} />
                              </Button>
                              <Tooltip.Content><p>复制访问密钥</p></Tooltip.Content>
                            </Tooltip>
                          )}
                        </div>
                      </div>
                      {isLanWithoutToken ? (
                        <FieldError>局域网模式必须先配置访问密钥</FieldError>
                      ) : (
                        <Description>调用受保护接口时使用 Authorization: Bearer &lt;token&gt;</Description>
                      )}
                    </TextField>
                  </div>

                  {/* LAN warning */}
                  {httpApiListenMode === 'lan' && (
                    <Alert status={httpApiToken.trim() ? 'warning' : 'danger'}>
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Description>
                          同一网络中的设备都可以访问当前端口。为避免裸露接口，局域网模式下必须启用 Bearer Token。
                        </Alert.Description>
                      </Alert.Content>
                    </Alert>
                  )}

                  {/* Action buttons */}
                  <div className="flex flex-col sm:flex-row gap-1.5">
                    <Button
                      variant="primary"
                      isPending={isSavingHttpApi}
                      isDisabled={isSavingHttpApi}
                      onPress={handleSaveHttpApiSettings}
                    >
                      {isSavingHttpApi ? <Spinner size="sm" color="current" /> : <Save size={16} />}
                      保存并应用
                    </Button>

                    <Button
                      variant="secondary"
                      isDisabled={isRefreshingHttpApi}
                      onPress={refreshHttpApiStatus}
                    >
                      {isRefreshingHttpApi ? <Spinner size="sm" color="current" /> : <RefreshCw size={16} />}
                      刷新状态
                    </Button>

                    <Button
                      variant="secondary"
                      isDisabled={isRefreshingHttpApi || !httpApiEnabled}
                      onPress={handleRestartHttpApi}
                    >
                      <RotateCcw size={16} />
                      重启服务
                    </Button>
                  </div>
                </div>
              </Card.Content>
            </Card>

            {/* ChatLab 数据源 */}
            <Card>
              <Card.Header>
                <Card.Title>ChatLab 数据源</Card.Title>
                <Card.Description>
                  把这组地址直接填进 ChatLab 的远程数据源配置。
                </Card.Description>
              </Card.Header>
              <Card.Content>
                <div className="flex flex-col gap-[10px]">
                  {/* Main panel */}
                  <Card className="p-2.25 rounded-2xl border border-border bg-gradient-to-b from-[rgba(15,23,42,0.02)] via-surface to-surface shadow-[0_12px_28px_rgba(15,23,42,0.05)]">
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 flex-wrap">
                        <div className="flex gap-1 items-center">
                          <div className="w-[42px] h-[42px] rounded-[14px] grid place-items-center text-accent bg-accent/10">
                            <Network size={18} />
                          </div>
                          <div>
                            <span className="text-sm font-bold text-foreground">主要数据源地址</span>
                            <p className="text-xs text-muted">
                              {httpApiEnabled ? 'ChatLab 直接连接这里即可开始发现会话。' : '请先启用 HTTP API，地址才会真正可用。'}
                            </p>
                          </div>
                        </div>

                        <Chip
                          color={httpApiEnabled ? 'success' : 'default'}
                          variant="secondary"
                          size="sm"
                        >
                          {httpApiEnabled ? '已可配置' : '等待启用'}
                        </Chip>
                      </div>

                      {/* Endpoint panel */}
                      <Card className="relative overflow-hidden rounded-[22px] border border-white/10 bg-gradient-to-br from-[rgba(25,29,34,0.98)] to-[rgba(42,47,53,0.94)] shadow-[0_18px_42px_rgba(15,23,42,0.14)]">
                        <div className="absolute inset-0 bg-gradient-to-r from-white/[0.08] to-transparent pointer-events-none" />
                        <div className="relative flex flex-col md:flex-row md:items-center">
                          <div className="flex-1 min-w-0 px-2 md:px-[10px] py-2 md:py-[9px]">
                            <div className="flex gap-[3px] items-center">
                              <Link2 size={14} className="text-white/60" />
                              <span className="text-[10px] text-white/60 uppercase tracking-wider font-bold">
                                ChatLab Base URL
                              </span>
                            </div>
                            <p className="mt-1.2 text-sm md:text-[15px] leading-relaxed font-mono text-white break-all">
                              {chatlabBaseUrl}
                            </p>
                          </div>

                          <div className="px-2 md:px-1.5 pb-2 md:pb-0 pt-0 md:pt-0 border-t md:border-t-0 md:border-l border-white/[0.08] flex items-center justify-center md:min-w-[142px]">
                            <Button
                              variant="tertiary"
                              size="sm"
                              className="w-full md:w-auto text-white border-white/15 bg-white/[0.06] hover:bg-white/[0.12] hover:border-white/25 rounded-full"
                              onPress={() => copyText(chatlabBaseUrl, 'ChatLab 数据源地址已复制')}
                            >
                              <Copy size={14} />
                              复制地址
                            </Button>
                          </div>
                        </div>
                      </Card>

                      {/* Info cards */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-1.25">
                        <Card className="p-1.5 rounded-[20px] border border-border bg-surface-tertiary">
                          <div className="flex gap-1 items-center mb-0.75">
                            {httpApiListenMode === 'lan'
                              ? <ShieldAlert size={16} className="text-accent shrink-0" />
                              : <ShieldCheck size={16} className="text-accent shrink-0" />}
                            <span className="text-xs font-bold text-foreground">
                              {httpApiListenMode === 'lan' ? '局域网监听' : '仅本机监听'}
                            </span>
                          </div>
                          <p className="text-[10px] text-muted leading-relaxed">
                            {httpApiListenMode === 'lan'
                              ? '同网段设备都能访问这组地址，适合给 ChatLab 远程拉取。'
                              : '只允许当前设备访问，适合本机调试和单端同步。'}
                          </p>
                        </Card>

                        <Card className="p-1.5 rounded-[20px] border border-border bg-surface-tertiary">
                          <div className="flex gap-1 items-center mb-0.75">
                            {httpApiToken.trim()
                              ? <ShieldCheck size={16} className="text-accent shrink-0" />
                              : <ShieldAlert size={16} className="text-danger shrink-0" />}
                            <span className="text-xs font-bold text-foreground">
                              {httpApiToken.trim() ? 'Bearer Token 已配置' : 'Bearer Token 未配置'}
                            </span>
                          </div>
                          <p className={`text-[10px] leading-relaxed ${httpApiListenMode === 'lan' && !httpApiToken.trim() ? 'text-danger' : 'text-muted'}`}>
                            {httpApiListenMode === 'lan' && !httpApiToken.trim()
                              ? '局域网模式下必须先填写 Token，当前设置不能直接保存。'
                              : httpApiToken.trim()
                                ? 'ChatLab 拉取请求会按当前设置校验 Bearer Token。'
                                : '本机模式可不填，只有需要鉴权时再配置即可。'}
                          </p>
                        </Card>
                      </div>
                    </div>
                  </Card>

                  {/* LAN addresses */}
                  {httpApiListenMode === 'lan' && (
                    <Card className="p-2.25 rounded-2xl border border-border bg-surface">
                      <div className="flex flex-col gap-1.5">
                        <div className="flex gap-1 items-center">
                          <Globe size={16} className="text-foreground" />
                          <span className="text-sm font-bold text-foreground">局域网可访问地址</span>
                        </div>

                        {status?.lanAddresses?.length
                          ? status.lanAddresses.map((address) => {
                            const url = `http://${address}:${status.port}/chatlab`
                            return (
                              <div
                                key={address}
                                className="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 p-1.5 rounded-[18px] border border-border bg-surface-tertiary"
                              >
                                <span className="text-xs font-mono text-foreground break-all">
                                  {url}
                                </span>
                                <Button
                                  variant="tertiary"
                                  size="sm"
                                  className="shrink-0 rounded-full"
                                  onPress={() => copyText(url, `${address} 地址已复制`)}
                                >
                                  <Copy size={14} />
                                  复制
                                </Button>
                              </div>
                            )
                          })
                          : (
                            <Alert status="warning">
                              <Alert.Indicator />
                              <Alert.Content>
                                <Alert.Description>
                                  已切到局域网模式，但当前没有检测到可用的 IPv4 地址。你仍可手动确认本机地址后拼接端口使用。
                                </Alert.Description>
                              </Alert.Content>
                            </Alert>
                          )}
                      </div>
                    </Card>
                  )}

                  {/* Access method + Endpoints info */}
                  <div className="grid grid-cols-1 md:grid-cols-[1.2fr_0.8fr] gap-2">
                    <Card className="p-2.25 rounded-2xl border border-border bg-surface">
                      <span className="text-sm font-bold text-foreground">接入方式</span>
                      <div className="flex flex-col gap-1.1 mt-1.5">
                        <p className="text-xs text-muted">1. 在 ChatLab 中新增远程数据源。</p>
                        <p className="text-xs text-muted">
                          2. 粘贴上方
                          <code className="mx-0.75 font-mono text-xs">/chatlab</code>
                          地址；如果配置了访问密钥，同时填入 Bearer Token。
                        </p>
                        <p className="text-xs text-muted">3. ChatLab 会自动发现会话，并按需继续拉取消息。</p>
                      </div>
                    </Card>

                    <Card className="p-2.25 rounded-2xl border border-border bg-surface">
                      <span className="text-sm font-bold text-foreground">兼容端点</span>
                      <div className="flex flex-col gap-1.1 mt-1.5">
                        <p className="text-xs text-muted">
                          <code className="mr-0.75 font-mono">GET /chatlab/sessions</code>
                          会话发现
                        </p>
                        <p className="text-xs text-muted">
                          <code className="mr-0.75 font-mono">GET /chatlab/sessions/:id/messages</code>
                          消息拉取
                        </p>
                        <p className="text-[10px] text-muted leading-relaxed">
                          兼容 ChatLab 自动补全的版本前缀，例如
                          <code className="mx-0.5 font-mono text-[10px]">/chatlab/api/v1/sessions</code>
                          。
                        </p>
                      </div>
                    </Card>
                  </div>
                </div>
              </Card.Content>
            </Card>

            {/* 服务状态 */}
            <Card>
              <Card.Header>
                <Card.Title>服务状态</Card.Title>
                <Card.Description>
                  只保留当前接入最常用的状态信息。
                </Card.Description>
              </Card.Header>
              <Card.Content>
                {status
                  ? (
                    <div className="flex flex-col gap-2">
                      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-1.5">
                        <MetricCard
                          label="运行状态"
                          value={(
                            <Chip color={status.running ? 'success' : 'danger'} variant="primary" size="sm">
                              {status.running ? '运行中' : '未运行'}
                            </Chip>
                          )}
                        />
                        <MetricCard
                          label="监听模式"
                          value={(
                            <Chip color={status.listenMode === 'lan' ? 'accent' : 'default'} variant="secondary" size="sm">
                              {status.listenMode === 'lan' ? '局域网' : '仅本机'}
                            </Chip>
                          )}
                        />
                        <MetricCard
                          label="绑定地址"
                          value={<span className="text-sm font-mono font-bold text-foreground">{status.host}:{status.port}</span>}
                        />
                        <MetricCard label="运行时长" value={uptimeText} />
                        <MetricCard
                          label="鉴权状态"
                          value={(
                            <Chip color={status.tokenConfigured ? 'success' : 'danger'} variant="primary" size="sm">
                              {status.tokenConfigured ? '已启用' : '未启用'}
                            </Chip>
                          )}
                        />
                      </div>

                      {status.lastError && (
                        <Alert status="danger">
                          <Alert.Indicator />
                          <Alert.Content>
                            <Alert.Description>
                              最近错误：{status.lastError}
                            </Alert.Description>
                          </Alert.Content>
                        </Alert>
                      )}
                    </div>
                  )
                  : (
                    <Alert status="default">
                      <Alert.Indicator />
                      <Alert.Content>
                        <Alert.Description>
                          尚未读取到接口状态，请点击"刷新状态"。
                        </Alert.Description>
                      </Alert.Content>
                    </Alert>
                  )}
              </Card.Content>
            </Card>

            {/* 高级接口 */}
            <Card>
              <Card.Header>
                <Card.Title>高级接口</Card.Title>
                <Card.Description>
                  原生 /v1 端点保留在这里，默认折叠，避免干扰 ChatLab 接入主流程。
                </Card.Description>
                <div className="flex gap-1 items-center flex-wrap ml-auto">
                  <Chip variant="secondary" size="sm">
                    {advancedEndpoints.length} 个端点
                  </Chip>
                  <Button
                    variant="tertiary"
                    size="sm"
                    onPress={() => setAdvancedOpen((v) => !v)}
                    className="rounded-full"
                  >
                    {advancedOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    {advancedOpen ? '收起' : '展开'}
                  </Button>
                </div>
              </Card.Header>
              <Card.Content>
                <Disclosure isExpanded={advancedOpen} onExpandedChange={setAdvancedOpen}>
                  <Disclosure.Content>
                    <Disclosure.Body>
                      <div className="flex flex-col gap-2">
                        {/* Base URL panel */}
                        <Card className="p-2.25 rounded-2xl border border-border bg-gradient-to-b from-[rgba(15,23,42,0.015)] via-surface to-surface">
                          <div className="flex flex-col gap-[7px]">
                            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-1.5">
                              <div className="min-w-0 flex-1">
                                <span className="text-sm font-bold text-foreground">原生 API Base URL</span>
                                <p className="mt-0.5 text-xs text-muted">
                                  只在自定义集成或调试原生接口时使用，常规 ChatLab 接入不需要关注这里。
                                </p>
                              </div>

                              <Button
                                variant="tertiary"
                                size="sm"
                                className="rounded-full shrink-0"
                                onPress={() => copyText(baseUrl, '原生 API 地址已复制')}
                              >
                                <Copy size={14} />
                                复制 Base URL
                              </Button>
                            </div>

                            <div className="w-full px-1.5 py-1.2 text-xs font-mono leading-relaxed text-foreground bg-white/[0.42] border border-border rounded-2xl break-all">
                              {baseUrl}
                            </div>
                          </div>
                        </Card>

                        {/* Endpoints grid */}
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-1.5">
                          {advancedEndpoints.map((endpoint) => {
                            const endpointUrl = getEndpointUrl(baseUrl, endpoint.path)

                            return (
                              <Card
                                key={`${endpoint.method}-${endpoint.path}`}
                                className="p-1.5 rounded-[20px] border border-border bg-surface-tertiary"
                              >
                                <div className="flex flex-col gap-1.25">
                                  <div className="flex gap-1 items-center flex-wrap">
                                    <Chip color="accent" variant="primary" size="sm">
                                      {endpoint.method}
                                    </Chip>
                                    <span className="text-xs text-foreground font-bold">
                                      {endpoint.desc}
                                    </span>
                                  </div>

                                  <code className="inline-flex self-start px-[4.6px] py-[1.8px] text-[10px] rounded-full text-muted bg-white/[0.5] border border-border font-mono">
                                    {endpoint.path}
                                  </code>

                                  <div className="w-full px-1.5 py-1.2 text-[10px] font-mono leading-relaxed text-muted bg-white/[0.42] border border-border rounded-2xl break-all">
                                    {endpointUrl}
                                  </div>

                                  <Button
                                    variant="tertiary"
                                    size="sm"
                                    className="rounded-full self-start"
                                    onPress={() => copyText(endpointUrl, `${endpoint.path} 已复制`)}
                                  >
                                    <Copy size={14} />
                                    复制端点地址
                                  </Button>
                                </div>
                              </Card>
                            )
                          })}

                          {!advancedEndpoints.length && (
                            <Alert status="default" className="col-span-full">
                              <Alert.Indicator />
                              <Alert.Content>
                                <Alert.Description>
                                  当前还没有可展示的原生 /v1 端点信息，请先刷新状态。
                                </Alert.Description>
                              </Alert.Content>
                            </Alert>
                          )}
                        </div>
                      </div>
                    </Disclosure.Body>
                  </Disclosure.Content>
                </Disclosure>
              </Card.Content>
            </Card>
        </div>
      </ScrollShadow>
    </>
  )
}

export default OpenApiPage
