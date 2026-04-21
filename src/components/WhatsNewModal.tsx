import { ReactNode } from 'react'
import { ArrowRight, Database, Heart, Quote, Scale, Send } from 'lucide-react'
import './WhatsNewModal.scss'

interface WhatsNewModalProps {
  onClose: () => void
  version: string
}

type VisionSection = {
  key: 'memory' | 'evidence' | 'ownership'
  index: string
  icon: ReactNode
  kicker: string
  title: string
  paragraphs: string[]
  quote?: string
  quoteSource?: string
  note?: string
}

const VISION_SECTIONS: VisionSection[] = [
  {
    key: 'memory',
    index: '01',
    icon: <Heart size={20} />,
    kicker: '记忆与亲情',
    title: '为思念留下可以触摸的温度',
    paragraphs: [
      '当亲人离世后，曾经的点点滴滴往往都留在逝者的手机里，手机也成了继续思念的唯一入口。我希望这款软件能把这些记录整理为真正属于家人的数字资产。',
      '一段反复叮嘱的文字，一条“儿子（闺女），爸（妈）想你了，啥时候回家呀，回来给你做你爱吃的！”的语音，一次平凡却再也无法重来的问候。'
    ],
    quote: '死亡不是生命的终点，遗忘才是。',
    quoteSource: '《寻梦环游记》',
    note: '愿技术能替你留住一点声音、一点温度，也留住一点未曾说完的爱。'
  },
  {
    key: 'evidence',
    index: '02',
    icon: <Scale size={20} />,
    kicker: '证据与事实',
    title: '为不公保留足够有力的证据',
    paragraphs: [
      '当您遭遇不公、不平、不正，甚至被聊天中的恶意、羞辱、威胁反复消耗时，您不该只能忍受。我希望这款软件能帮您从海量记录中快速找出关键证据。',
      '把零散对话整理成清晰、完整、可追溯的事实链，让每一句伤害都有据可查，让每一次压迫都有证可举。'
    ],
    note: '人可以善良，但不该没有反击的凭据。'
  },
  {
    key: 'ownership',
    index: '03',
    icon: <Database size={20} />,
    kicker: '归档与掌控',
    title: '让聊天记录真正回到用户手中',
    paragraphs: [
      '我也希望这款软件能帮助更多普通人重新掌握自己的数字人生。聊天记录不该只是被困在某台设备里的碎片，它也可以是记忆的档案、关系的注脚、成长的年轮。',
      '无论是回望过去、整理生活、备份重要信息，还是在关键时刻还原事实、保护自己，这些数据都应该真正属于用户，而不是在设备更换、账号异常或时间流逝中悄然消失。'
    ]
  }
]

function WhatsNewModal({ onClose, version }: WhatsNewModalProps) {
  const handleTelegram = () => {
    window.electronAPI?.shell?.openExternal?.('https://t.me/+p7YzmRMBm-gzNzJl')
  }

  return (
    <div className="whats-new-overlay">
      <div className="whats-new-modal">
        <div className="modal-header">
          <span className="version-tag">开发者手记 · v{version}</span>
          <h2>开发者愿景</h2>
          <p className="vision-lead">这不是一个只会读取聊天记录的工具。</p>
          <p className="vision-intro">
            我希望它能替人留住爱，提取证据，也守住每个人自己的数字人生。
          </p>
        </div>

        <div className="modal-content">
          <div className="vision-opening">
            <div className="opening-mark" aria-hidden="true" />
            <p>
              聊天记录不只是数据，它也可能是想念、证据、关系与自我叙事。这个弹窗不再只是告诉你“更新了什么”，
              也想顺手告诉你，这个项目究竟想把什么留下来。
            </p>
          </div>

          <div className="vision-list">
            {VISION_SECTIONS.map((section) => (
              <article className={`vision-card ${section.key}`} key={section.key}>
                <div className="vision-card-top">
                  <span className="vision-index">{section.index}</span>
                  <div className="vision-icon" aria-hidden="true">
                    {section.icon}
                  </div>
                  <div className="vision-meta">
                    <span className="vision-kicker">{section.kicker}</span>
                    <h3>{section.title}</h3>
                  </div>
                </div>

                <div className="vision-body">
                  {section.paragraphs.map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}

                  {section.quote && (
                    <blockquote className="vision-quote">
                      <div className="quote-icon" aria-hidden="true">
                        <Quote size={18} />
                      </div>
                      <p>{section.quote}</p>
                      {section.quoteSource && <cite>{section.quoteSource}</cite>}
                    </blockquote>
                  )}

                  {section.note && <p className="vision-note">{section.note}</p>}
                </div>
              </article>
            ))}
          </div>
        </div>

        <div className="modal-footer">
          <div className="footer-copy">
            <span className="footer-label">CipherTalk</span>
            <p>愿每一段被留住的记录，都能在需要的时候成为温度、力量与归属。</p>
          </div>

          <div className="footer-actions">
            <button className="telegram-btn" onClick={handleTelegram}>
              <Send size={16} />
              加入 Telegram 频道
            </button>
            <button className="start-btn" onClick={onClose}>
              开始使用
              <ArrowRight size={16} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default WhatsNewModal
