import { useEffect, useMemo, useState, type Key } from 'react'
import { Button as HeroButton, Modal, ScrollShadow, Switch, Tabs, toast } from '@heroui/react'
import { Check, Download, FileArchive, HelpCircle, Loader2, Monitor, Search, Trash2 } from 'lucide-react'
import { cn } from '../lib/utils'
import { PetSprite } from '../features/pets/PetSprite'

type InstalledPet = { slug: string; displayName: string; description: string; spriteUrl: string }
type OnlinePet = { slug: string; displayName: string; submittedBy?: string; spritesheetUrl: string }

const ONLINE_PAGE_SIZE = 30

/**
 * AI 宠物页：宠物库（petdex.dev 在线画廊）/ 已安装 两个 Tab，
 * 支持在线领养和本地压缩包导入。选中的宠物展示在 AI 助手页和桌面桌宠。
 */
export default function PetsPage() {
  const [tab, setTab] = useState<'gallery' | 'installed'>('gallery')
  const [helpOpen, setHelpOpen] = useState(false)
  const [installed, setInstalled] = useState<InstalledPet[]>([])
  const [currentSlug, setCurrentSlug] = useState('')
  const [desktopEnabled, setDesktopEnabled] = useState(false)
  const [online, setOnline] = useState<OnlinePet[] | null>(null)
  const [onlineError, setOnlineError] = useState('')
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(ONLINE_PAGE_SIZE)
  const [installingSlug, setInstallingSlug] = useState('')
  const [importing, setImporting] = useState(false)

  const loadInstalled = async () => {
    const res = await window.electronAPI.pet.listInstalled()
    if (!res.success || !res.pets) return
    const pets = await Promise.all(res.pets.map(async (pet) => {
      const sprite = await window.electronAPI.pet.getSprite(pet.slug)
      return sprite.success && sprite.dataUrl ? { ...pet, spriteUrl: sprite.dataUrl } : null
    }))
    setInstalled(pets.filter((pet): pet is InstalledPet => pet !== null))
  }

  useEffect(() => {
    void loadInstalled()
    void window.electronAPI.config.get('petCurrent').then((value) => setCurrentSlug((value as string) || ''))
    void window.electronAPI.config.get('petDesktopEnabled').then((value) => setDesktopEnabled(Boolean(value)))
    window.electronAPI.pet.manifest()
      .then((res) => {
        if (res.success && res.pets) setOnline(res.pets)
        else setOnlineError(res.error || '在线宠物库加载失败')
      })
      .catch((error) => setOnlineError(String(error)))
  }, [])

  const filteredOnline = useMemo(() => {
    if (!online) return []
    const installedSlugs = new Set(installed.map((pet) => pet.slug))
    const keyword = query.trim().toLowerCase()
    return online.filter((pet) => {
      if (installedSlugs.has(pet.slug)) return false
      if (!keyword) return true
      return pet.slug.includes(keyword) || pet.displayName.toLowerCase().includes(keyword)
    })
  }, [online, installed, query])

  const selectPet = async (slug: string) => {
    await window.electronAPI.config.set('petCurrent', slug)
    setCurrentSlug(slug)
  }

  const removePet = async (slug: string) => {
    await window.electronAPI.pet.remove(slug)
    if (currentSlug === slug) setCurrentSlug('')
    void loadInstalled()
  }

  const installPet = async (slug: string) => {
    setInstallingSlug(slug)
    try {
      const res = await window.electronAPI.pet.install(slug)
      if (res.success) {
        await loadInstalled()
        if (!currentSlug) await selectPet(slug)
        toast.success(`已领养 ${res.pet?.displayName || slug}`)
      } else {
        toast.danger(res.error || '安装失败')
      }
    } finally {
      setInstallingSlug('')
    }
  }

  const importZip = async () => {
    setImporting(true)
    try {
      const res = await window.electronAPI.pet.importZip()
      if (res.success && res.pet) {
        await loadInstalled()
        if (!currentSlug) await selectPet(res.pet.slug)
        toast.success(`已导入 ${res.pet.displayName}`)
      } else if (!res.canceled) {
        toast.danger(res.error || '导入失败')
      }
    } finally {
      setImporting(false)
    }
  }

  const toggleDesktop = async (enabled: boolean) => {
    setDesktopEnabled(enabled)
    await window.electronAPI.pet.toggleDesktopWindow(enabled)
  }

  const petGridClass = 'grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8'

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* 顶栏：Tab 切换 + 说明 + 桌宠开关 */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <Tabs selectedKey={tab} onSelectionChange={(key: Key) => setTab(key === 'installed' ? 'installed' : 'gallery')}>
          <Tabs.ListContainer>
            <Tabs.List aria-label="宠物页签">
              <Tabs.Tab id="gallery">
                宠物库
                <Tabs.Indicator />
              </Tabs.Tab>
              <Tabs.Tab className="whitespace-nowrap" id="installed">
                已安装{installed.length > 0 ? `（${installed.length}）` : ''}
                <Tabs.Indicator />
              </Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>
        <div className="flex items-center gap-3">
          <HeroButton
            aria-label="使用说明"
            isIconOnly
            onPress={() => setHelpOpen(true)}
            size="sm"
            variant="ghost"
          >
            <HelpCircle className="size-4.5" />
          </HeroButton>
          <label className="flex shrink-0 cursor-pointer items-center gap-2 text-foreground text-sm">
            <Monitor className="size-4 text-muted" />
            桌面桌宠
            <Switch aria-label="桌面悬浮桌宠" isSelected={desktopEnabled} onChange={(selected) => void toggleDesktop(Boolean(selected))}>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch>
          </label>
        </div>
      </div>

      <ScrollShadow hideScrollBar className="min-h-0 flex-1 pb-3" size={56}>
        {tab === 'gallery' ? (
          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted text-sm">
                petdex.dev 开源画廊{online ? ` · ${filteredOnline.length} 只可领养` : ''}
              </span>
              <div className="relative">
                <Search className="-translate-y-1/2 absolute top-1/2 left-2.5 size-4 text-muted" />
                <input
                  className="h-9 w-60 rounded-full border border-border bg-surface pr-3 pl-8 text-foreground text-sm outline-none placeholder:text-muted focus:border-primary"
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setVisibleCount(ONLINE_PAGE_SIZE)
                  }}
                  placeholder="搜索宠物…"
                  value={query}
                />
              </div>
            </div>
            {!online && !onlineError && (
              <p className="flex items-center gap-2 px-1 py-6 text-muted text-sm">
                <Loader2 className="size-4 animate-spin" />
                正在加载在线宠物库…
              </p>
            )}
            {onlineError && (
              <p className="rounded-2xl border border-danger/30 bg-danger/5 px-4 py-3 text-danger text-sm">
                {onlineError}
              </p>
            )}
            {online && (
              <>
                <div className={petGridClass}>
                  {filteredOnline.slice(0, visibleCount).map((pet) => (
                    <div
                      className="flex flex-col items-center gap-1.5 rounded-2xl border border-border p-3"
                      key={pet.slug}
                      title={pet.submittedBy ? `by ${pet.submittedBy}` : pet.displayName}
                    >
                      <PetSprite scale={0.4} src={pet.spritesheetUrl} state="idle" />
                      <span className="w-full truncate text-center text-foreground text-xs">{pet.displayName}</span>
                      <HeroButton
                        className="h-7 w-full min-w-0 rounded-full text-xs"
                        isDisabled={installingSlug !== ''}
                        onPress={() => void installPet(pet.slug)}
                        size="sm"
                        variant="secondary"
                      >
                        {installingSlug === pet.slug
                          ? <Loader2 className="size-3 animate-spin" />
                          : <Download className="size-3" />}
                        领养
                      </HeroButton>
                    </div>
                  ))}
                </div>
                {filteredOnline.length > visibleCount && (
                  <div className="mt-3 flex justify-center">
                    <HeroButton className="rounded-full" onPress={() => setVisibleCount((count) => count + ONLINE_PAGE_SIZE)} size="sm" variant="tertiary">
                      加载更多（还有 {filteredOnline.length - visibleCount} 只）
                    </HeroButton>
                  </div>
                )}
              </>
            )}
          </section>
        ) : (
          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <span className="text-muted text-sm">点击宠物选用或取消，悬停可删除</span>
              <HeroButton
                className="rounded-full"
                isDisabled={importing}
                onPress={() => void importZip()}
                size="sm"
                variant="secondary"
              >
                {importing ? <Loader2 className="size-3.5 animate-spin" /> : <FileArchive className="size-3.5" />}
                导入压缩包
              </HeroButton>
            </div>
            {installed.length === 0 ? (
              <p className="rounded-2xl border border-border border-dashed px-4 py-8 text-center text-muted text-sm">
                还没有宠物，去宠物库领养一只，或导入下载好的宠物压缩包
              </p>
            ) : (
              <div className={petGridClass}>
                {installed.map((pet) => {
                  const selected = pet.slug === currentSlug
                  return (
                    <button
                      className={cn(
                        'group relative flex flex-col items-center gap-1.5 rounded-2xl border p-3 transition-colors',
                        selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-surface-tertiary'
                      )}
                      key={pet.slug}
                      onClick={() => void selectPet(selected ? '' : pet.slug)}
                      title={selected ? '点击取消展示' : pet.description || pet.displayName}
                      type="button"
                    >
                      <PetSprite scale={0.4} src={pet.spriteUrl} state={selected ? 'waving' : 'idle'} />
                      <span className="w-full truncate text-center text-foreground text-xs">{pet.displayName}</span>
                      {selected && (
                        <span className="absolute top-1.5 left-1.5 rounded-full bg-primary p-0.5 text-primary-foreground">
                          <Check className="size-3" />
                        </span>
                      )}
                      <span
                        className="absolute top-1.5 right-1.5 rounded-full p-1 text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                        onClick={(event) => {
                          event.stopPropagation()
                          void removePet(pet.slug)
                        }}
                        role="button"
                        title="删除宠物"
                      >
                        <Trash2 className="size-3.5" />
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </section>
        )}
      </ScrollShadow>

      {/* 使用说明 */}
      {helpOpen && (
        <Modal>
          <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open) setHelpOpen(false) }}>
            <Modal.Container className="px-3 sm:px-6" placement="center">
              <Modal.Dialog aria-label="AI 宠物说明" className="w-full max-w-110">
                <div className="flex flex-col gap-3 p-5 text-foreground text-sm leading-relaxed">
                  <h2 className="font-semibold text-base">AI 宠物是什么？</h2>
                  <p>
                    挑一只像素小伙伴陪你用 AI 助手：新对话时它在对话区中间等你，开聊后站在输入框上方——AI
                    回复时它会奔跑，出错会沮丧，完成后挥手庆祝，闲下来还会随机做点小动作。
                  </p>
                  <p>
                    打开「桌面桌宠」后，宠物会悬浮在桌面上实时反映 AI 运行状态，拖动它还会跟着跑跳。
                  </p>
                  <p className="text-muted text-xs">
                    宠物来自开源画廊 petdex.dev（与 Codex Pets 同一格式，约 3000 只），也可以导入下载好的宠物压缩包（pet.json
                    + 精灵图）。宠物素材版权归各自作者所有。
                  </p>
                </div>
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      )}
    </div>
  )
}
