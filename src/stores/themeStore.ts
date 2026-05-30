import { create } from 'zustand'

export type ThemeMode = 'light' | 'dark' | 'system'
export type NavLayout = 'sidebar' | 'dock'

interface ThemeState {
  themeMode: ThemeMode
  navLayout: NavLayout
  dockAutoHide: boolean
  isLoaded: boolean
  setThemeMode: (mode: ThemeMode) => void
  setNavLayout: (layout: NavLayout) => void
  setDockAutoHide: (v: boolean) => void
  toggleThemeMode: () => void
  loadTheme: () => Promise<void>
}

export const useThemeStore = create<ThemeState>()((set, get) => ({
  themeMode: 'light',
  navLayout: 'sidebar',
  dockAutoHide: true,
  isLoaded: false,

  setThemeMode: async (mode) => {
    set({ themeMode: mode })
    try {
      await window.electronAPI.config.set('themeMode', mode)
    } catch (e) {
      console.error('保存主题模式失败:', e)
    }
  },

  setNavLayout: async (layout) => {
    set({ navLayout: layout })
    try {
      await window.electronAPI.config.set('navLayout', layout)
    } catch (e) {
      console.error('保存导航布局失败:', e)
    }
  },

  setDockAutoHide: async (v) => {
    set({ dockAutoHide: v })
    try {
      await window.electronAPI.config.set('dockAutoHide', v)
    } catch (e) {
      console.error('保存 Dock 自动收起失败:', e)
    }
  },

  toggleThemeMode: () => {
    const newMode = get().themeMode === 'light' ? 'dark' : 'light'
    get().setThemeMode(newMode)
  },

  loadTheme: async () => {
    try {
      const themeMode = await window.electronAPI.config.get('themeMode') as ThemeMode | undefined
      let navLayout = await window.electronAPI.config.get('navLayout') as NavLayout | undefined
      const dockAutoHide = await window.electronAPI.config.get('dockAutoHide') as boolean | undefined
      const nextThemeMode: ThemeMode = themeMode === 'dark' || themeMode === 'system' ? themeMode : 'light'

      // 一次性迁移：统一切换到左侧边栏布局（与窗口标题栏融为一体的微信式布局）
      const migrated = await window.electronAPI.config.get('navLayoutMigratedV7') as boolean | undefined
      if (!migrated) {
        navLayout = 'sidebar'
        try {
          await window.electronAPI.config.set('navLayout', 'sidebar')
          await window.electronAPI.config.set('navLayoutMigratedV7', true)
        } catch (e) {
          console.error('迁移导航布局失败:', e)
        }
      }

      set({
        themeMode: nextThemeMode,
        navLayout: navLayout || 'sidebar',
        dockAutoHide: dockAutoHide ?? true,
        isLoaded: true
      })
    } catch (e) {
      console.error('加载主题失败:', e)
      set({ isLoaded: true })
    }
  }
}))
