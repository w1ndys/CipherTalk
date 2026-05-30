import { useState, type ReactElement, type CSSProperties, type Key } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Avatar, Button, ScrollShadow, Separator, Tabs, Tooltip } from '@heroui/react'
import { Home, MessageSquare, BarChart3, Users, FileText, Database, Settings, SquareChevronLeft, SquareChevronRight, Download, Aperture, Network, FileAudio } from 'lucide-react'
import { MCP } from '@lobehub/icons'
import packageJson from '../../package.json'
import { useAppStore } from '../stores/appStore'
import { cn } from '../lib/utils'

const EXPANDED_WIDTH = 220
const COLLAPSED_WIDTH = 88
const NAV_ICON_SIZE = 23
const SIDEBAR_ACTION_ICON_SIZE = 23
const APP_DISPLAY_NAME = packageJson.build?.productName || packageJson.name

type RouteItem = {
  key: string
  label: string
  icon: ReactElement
  type: 'route'
  path: string
}

type ActionItem = {
  key: string
  label: string
  icon: ReactElement
  type: 'action'
  onClick: () => void
}

type NavItemConfig = RouteItem | ActionItem

function Sidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const userInfo = useAppStore(state => state.userInfo)
  const [collapsed, setCollapsed] = useState(false)
  const userDisplayName = userInfo?.nickName?.trim() || userInfo?.alias?.trim() || '未连接用户'
  const userInitial = userDisplayName.slice(0, 1).toUpperCase()

  const isActive = (path: string) => location.pathname === path

  const openChatWindow = async () => {
    try {
      await window.electronAPI.window.openChatWindow()
    } catch (e) {
      console.error('打开聊天窗口失败:', e)
    }
  }

  const openGroupAnalyticsWindow = async () => {
    try {
      await window.electronAPI.window.openGroupAnalyticsWindow()
    } catch (e) {
      console.error('打开群聊分析窗口失败:', e)
    }
  }

  const openMomentsWindow = async () => {
    try {
      await window.electronAPI.window.openMomentsWindow()
    } catch (e) {
      console.error('打开朋友圈窗口失败:', e)
    }
  }

  const navItems: NavItemConfig[] = [
    { key: 'home', label: '首页', icon: <Home size={NAV_ICON_SIZE} />, type: 'route', path: '/home' },
    { key: 'chat', label: '聊天查看', icon: <MessageSquare size={NAV_ICON_SIZE} />, type: 'action', onClick: openChatWindow },
    { key: 'moments', label: '朋友圈', icon: <Aperture size={NAV_ICON_SIZE} />, type: 'action', onClick: openMomentsWindow },
    { key: 'analytics', label: '私聊分析', icon: <BarChart3 size={NAV_ICON_SIZE} />, type: 'route', path: '/analytics' },
    { key: 'group-analytics', label: '群聊分析', icon: <Users size={NAV_ICON_SIZE} />, type: 'action', onClick: openGroupAnalyticsWindow },
    { key: 'annual-report', label: '年度报告', icon: <FileText size={NAV_ICON_SIZE} />, type: 'route', path: '/annual-report' },
    { key: 'transcription-assistant', label: '转文字助手', icon: <FileAudio size={NAV_ICON_SIZE} />, type: 'route', path: '/transcription-assistant' },
    { key: 'export', label: '导出数据', icon: <Download size={NAV_ICON_SIZE} />, type: 'route', path: '/export' },
    { key: 'data-management', label: '数据管理', icon: <Database size={NAV_ICON_SIZE} />, type: 'route', path: '/data-management' },
    { key: 'open-api', label: '开放接口', icon: <Network size={NAV_ICON_SIZE} />, type: 'route', path: '/open-api' },
    { key: 'mcp', label: 'MCP & Skills', icon: <MCP size={NAV_ICON_SIZE} />, type: 'route', path: '/mcp' },
  ]
  const activeNavKey = navItems.find(item => item.type === 'route' && isActive(item.path))?.key

  const handleNavSelectionChange = (key: Key) => {
    const item = navItems.find(navItem => navItem.key === String(key))
    if (!item) return

    if (item.type === 'route') {
      navigate(item.path)
    } else {
      item.onClick()
    }
  }

  const renderNavButton = (opts: { label: string; icon: ReactElement; active?: boolean; onPress: () => void }) => {
    const button = (
      <Button
        variant={opts.active ? 'primary' : 'ghost'}
        fullWidth={!collapsed}
        isIconOnly={collapsed}
        onPress={opts.onPress}
        aria-label={opts.label}
        className={cn(
          'rounded-full',
          collapsed ? 'h-12 w-12 min-w-12 p-0' : 'h-12 justify-start gap-2 px-3'
        )}
      >
        {collapsed ? (
          opts.icon
        ) : (
          <>
            <span className="flex w-6 shrink-0 items-center justify-center">{opts.icon}</span>
            <span className="truncate text-base font-semibold">{opts.label}</span>
          </>
        )}
      </Button>
    )

    if (!collapsed) return button

    return (
      <Tooltip delay={0}>
        <Tooltip.Trigger>{button}</Tooltip.Trigger>
        <Tooltip.Content placement="right">{opts.label}</Tooltip.Content>
      </Tooltip>
    )
  }

  const renderNavTab = (item: NavItemConfig) => {
    return (
      <Tabs.Tab
        key={item.key}
        id={item.key}
        className={cn(
          'rounded-full text-foreground transition-colors',
          collapsed ? 'h-12! w-12! min-w-12! justify-center p-0' : 'h-12! w-full justify-start gap-2 px-3'
        )}
      >
        <span className="flex w-6 shrink-0 items-center justify-center">{item.icon}</span>
        {collapsed ? (
          <span className="sr-only">{item.label}</span>
        ) : (
          <span className="truncate text-base font-semibold">{item.label}</span>
        )}
        <Tabs.Indicator />
      </Tabs.Tab>
    )
  }

  const profileAvatar = (
    <Avatar size="sm" className="shrink-0">
      {userInfo?.avatarUrl ? <Avatar.Image src={userInfo.avatarUrl} alt={userDisplayName} /> : null}
      <Avatar.Fallback>{userInitial}</Avatar.Fallback>
    </Avatar>
  )

  return (
    <aside
      className="flex shrink-0 flex-col overflow-x-hidden bg-surface-secondary backdrop-blur-[18px] transition-[width] duration-200 ease-out"
      style={{ width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH }}
    >
      <div
        className="shrink-0"
        aria-hidden="true"
        style={{
          height: 'var(--window-chrome-height)',
          WebkitAppRegion: 'drag',
        } as CSSProperties}
      />

      {/* 顶部品牌区：logo + 名称，归属侧边栏内容区 */}
      <div
        className={cn('flex shrink-0 items-center gap-2 overflow-hidden px-6 pb-2', collapsed && 'justify-center')}
        style={{
          WebkitAppRegion: 'no-drag',
        } as CSSProperties}
      >
        <img src="./logo.png" alt={APP_DISPLAY_NAME} className="h-7 w-7 shrink-0 rounded" />
        {!collapsed && <span className="truncate text-base font-semibold text-foreground">{APP_DISPLAY_NAME}</span>}
      </div>

      {/* 主导航 */}
      <ScrollShadow hideScrollBar className="min-h-0 flex-1 px-3 pt-0.5" size={32}>
        <nav className={cn(collapsed && 'flex justify-center')}>
          <Tabs
            className={cn(collapsed ? 'w-fit' : 'w-full')}
            orientation="vertical"
            selectedKey={activeNavKey}
            onSelectionChange={handleNavSelectionChange}
          >
            <Tabs.ListContainer>
              <Tabs.List
                aria-label="主导航"
                className={cn(
                  'bg-transparent p-0',
                  collapsed ? 'w-fit items-center gap-1' : 'w-full gap-1'
                )}
              >
                {navItems.map(renderNavTab)}
              </Tabs.List>
            </Tabs.ListContainer>
          </Tabs>
        </nav>
      </ScrollShadow>

      {/* 底部：分隔线 + 用户 + 设置 + 折叠 */}
      <div className="shrink-0 px-2 pb-2">
        <Separator className="my-1.5" />

        <div className={cn('flex items-center gap-2.5 overflow-hidden px-2 py-1.5', collapsed && 'justify-center')}>
          {collapsed ? (
            <Tooltip delay={0}>
              <Tooltip.Trigger aria-label={userDisplayName}>{profileAvatar}</Tooltip.Trigger>
              <Tooltip.Content placement="right">{userDisplayName}</Tooltip.Content>
            </Tooltip>
          ) : (
            <>
              {profileAvatar}
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold text-foreground">{userDisplayName}</div>
                <div className="truncate text-xs text-muted">当前用户</div>
              </div>
            </>
          )}
        </div>

        <div className={cn('flex flex-col gap-1', collapsed && 'items-center')}>
          {renderNavButton({
            label: '设置',
            icon: <Settings size={SIDEBAR_ACTION_ICON_SIZE} />,
            active: isActive('/settings'),
            onPress: () => navigate('/settings'),
          })}
          {renderNavButton({
            label: collapsed ? '展开' : '收回',
            icon: collapsed ? <SquareChevronRight size={SIDEBAR_ACTION_ICON_SIZE} /> : <SquareChevronLeft size={SIDEBAR_ACTION_ICON_SIZE} />,
            onPress: () => setCollapsed(!collapsed),
          })}
        </div>
      </div>
    </aside>
  )
}

export default Sidebar
