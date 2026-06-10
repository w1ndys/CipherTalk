import { useEffect, useRef, useState } from 'react'
import { gsap } from 'gsap'
import { useGSAP } from '@gsap/react'
import './SplashPage.css'

gsap.registerPlugin(useGSAP)

// 开机日志：前两行打完即 OK，最后一行保持运行态（光标闪烁），退场时瞬间补上 OK
const BOOT_LINES = [
  { label: '校验本地环境', dots: 12 },
  { label: '连接数据库', dots: 14 },
  { label: '整理聊天索引', dots: 12 },
]

function BootLine({ label, dots, index }: { label: string; dots: number; index: number }) {
  return (
    <div className="boot-line" data-line={index}>
      <span className="boot-char boot-prompt">&gt;&nbsp;</span>
      {Array.from(label).map((ch, i) => (
        <span className="boot-char" key={`c${i}`}>{ch}</span>
      ))}
      <span className="boot-char">&nbsp;</span>
      {Array.from({ length: dots }).map((_, i) => (
        <span className="boot-char boot-dot" key={`d${i}`}>.</span>
      ))}
      <span className="boot-char">&nbsp;</span>
      <span className="boot-ok">OK</span>
      <span className="boot-caret">▍</span>
    </div>
  )
}

function SplashPage() {
  const rootRef = useRef<HTMLDivElement>(null)
  const introRef = useRef<gsap.core.Timeline | null>(null)
  const idleRef = useRef<gsap.core.Tween[]>([])
  const [fadeOut, setFadeOut] = useState(false)
  const [version, setVersion] = useState('')

  useEffect(() => {
    const readyTimer = setTimeout(() => {
      try {
        // @ts-ignore - splashReady 方法在运行时可用
        window.electronAPI?.window?.splashReady?.()
      } catch (e) {
        console.error('通知启动屏就绪失败:', e)
      }
    }, 1000)

    window.electronAPI?.app?.getVersion?.()
      .then((v: string) => setVersion(v))
      .catch(() => undefined)

    const cleanup = window.electronAPI?.window?.onSplashFadeOut?.(() => setFadeOut(true))

    return () => {
      clearTimeout(readyTimer)
      cleanup?.()
    }
  }, [])

  // 入场（CRT 通电 → logo 点亮 → 日志打印）+ 待机循环（扫描带 / 辉光呼吸 / 光标闪烁）
  useGSAP(() => {
    const mm = gsap.matchMedia()

    mm.add('(prefers-reduced-motion: reduce)', () => {
      gsap.set('.boot-char', { autoAlpha: 1 })
      gsap.set('.boot-ok', { autoAlpha: 1, scale: 1 })
      gsap.set('.boot-caret', { autoAlpha: 0 })
      gsap.set('.crt-logo-wrap', { autoAlpha: 1 })
      gsap.from(rootRef.current, { opacity: 0, duration: 0.3, ease: 'power1.out' })
    })

    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const tl = gsap.timeline()
      introRef.current = tl

      // 通电：屏幕从一条亮线垂直展开，伴随一次白闪
      tl.fromTo('.crt-card',
        { scaleY: 0.015, opacity: 0.85, transformOrigin: '50% 50%' },
        { scaleY: 1, opacity: 1, duration: 0.34, ease: 'power3.out' },
      )
        .fromTo('.crt-flash', { opacity: 0.85 }, { opacity: 0, duration: 0.28, ease: 'power2.out' }, '<')
        // logo 点亮：阶梯式闪两下再稳定，辉光同步绽开
        .fromTo('.crt-logo-wrap', { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.34, ease: 'steps(3)' }, '-=0.06')
        .fromTo('.crt-logo-glow', { opacity: 0, scale: 0.86 }, { opacity: 1, scale: 1, duration: 0.5, ease: 'power2.out' }, '<')

      // 日志逐行打印
      BOOT_LINES.forEach((line, i) => {
        const lineSel = `.boot-line[data-line="${i}"]`
        const isLast = i === BOOT_LINES.length - 1
        tl.set(`${lineSel} .boot-caret`, { autoAlpha: 1 }, i === 0 ? '-=0.1' : '+=0.12')
        tl.to(`${lineSel} .boot-char`, { autoAlpha: 1, duration: 0.01, stagger: 0.026 })
        if (!isLast) {
          tl.to(`${lineSel} .boot-ok`, { autoAlpha: 1, scale: 1, duration: 0.16, ease: 'back.out(3)' }, '+=0.1')
          tl.set(`${lineSel} .boot-caret`, { autoAlpha: 0 })
        }
      })

      // 待机循环：同步创建以便 context 自动清理
      idleRef.current = [
        // 最后一行光标闪烁
        gsap.fromTo(`.boot-line[data-line="${BOOT_LINES.length - 1}"] .boot-caret`,
          { opacity: 1 }, { opacity: 0, duration: 0.55, ease: 'steps(1)', repeat: -1, yoyo: true, delay: 2.4 },
        ),
        // 一条微亮的扫描带缓缓掠过屏幕
        gsap.fromTo('.crt-scanband', { yPercent: -120 }, {
          yPercent: 900, duration: 5.5, ease: 'none', repeat: -1, repeatDelay: 2.2, delay: 1.2,
        }),
        // logo 辉光呼吸
        gsap.to('.crt-logo-glow', { opacity: 0.6, duration: 2.2, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 1.4 }),
        // 偶发的轻微画面闪烁（CRT 质感）
        gsap.to('.crt-flicker', {
          opacity: 0.045, duration: 0.07, ease: 'steps(1)', yoyo: true, repeat: -1, repeatDelay: 1.9, delay: 2,
        }),
      ]
    })
  }, { scope: rootRef })

  // 退场：补上最后一行 OK → 断电收成一条亮线（主窗就绪信号后 350ms 内窗口销毁）
  useGSAP(() => {
    if (!fadeOut) return
    introRef.current?.kill()
    for (const tween of idleRef.current) tween.kill()
    const lastSel = `.boot-line[data-line="${BOOT_LINES.length - 1}"]`
    gsap.timeline()
      .set(`${lastSel} .boot-char`, { autoAlpha: 1 })
      .set(`${lastSel} .boot-caret`, { autoAlpha: 0 })
      .set(`${lastSel} .boot-ok`, { autoAlpha: 1, scale: 1 })
      .to('.crt-flash', { opacity: 0.5, duration: 0.07, ease: 'steps(1)', yoyo: true, repeat: 1 }, 0.08)
      .to('.crt-card', { scaleY: 0.01, opacity: 0, duration: 0.2, ease: 'power3.in' }, 0.1)
      .to(rootRef.current, { opacity: 0, duration: 0.26 }, 0.04)
  }, { dependencies: [fadeOut], scope: rootRef })

  return (
    <div className="splash-page" ref={rootRef}>
      <div className="crt-card">
        <div className="crt-scanlines" aria-hidden="true" />
        <div className="crt-scanband" aria-hidden="true" />
        <div className="crt-content">
          <div className="crt-logo-wrap">
            <div className="crt-logo-glow" aria-hidden="true" />
            <img
              className="crt-logo-img"
              src="./About.png"
              alt="密语 CipherTalk"
            />
          </div>
          <div className="boot-log" role="status" aria-label="正在启动">
            {BOOT_LINES.map((line, i) => (
              <BootLine key={line.label} label={line.label} dots={line.dots} index={i} />
            ))}
          </div>
        </div>
        <div className="crt-vignette" aria-hidden="true" />
        <div className="crt-flicker" aria-hidden="true" />
        <div className="crt-flash" aria-hidden="true" />
        {version && <div className="crt-version">v{version}</div>}
      </div>
    </div>
  )
}

export default SplashPage
