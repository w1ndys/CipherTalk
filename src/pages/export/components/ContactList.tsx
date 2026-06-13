import { Loader2, Check, User, Users, MessageSquare } from 'lucide-react'
import type { Contact } from '../types'
import { getAvatarLetter } from '../utils'

interface ContactListProps {
  isLoading: boolean
  contacts: Contact[]
  selectedContacts: Set<string>
  onToggle: (username: string) => void
}

function getContactTypeIcon(type: string) {
  switch (type) {
    case 'friend': return <User size={14} />
    case 'group': return <Users size={14} />
    case 'official': return <MessageSquare size={14} />
    default: return <User size={14} />
  }
}

function getContactTypeName(type: string) {
  switch (type) {
    case 'friend': return '好友'
    case 'group': return '群聊'
    case 'official': return '公众号'
    default: return '其他'
  }
}

export default function ContactList({ isLoading, contacts, selectedContacts, onToggle }: ContactListProps) {
  if (isLoading) {
    return (
      <div className="loading-state">
        <Loader2 size={24} className="spin" />
        <span>加载中...</span>
      </div>
    )
  }

  if (contacts.length === 0) {
    return (
      <div className="empty-state">
        <span>暂无联系人</span>
      </div>
    )
  }

  return (
    <div className="contacts-list selectable">
      {contacts.slice(0, 100).map(contact => (
        <div
          key={contact.username}
          className={`contact-item ${selectedContacts.has(contact.username) ? 'selected' : ''}`}
          onClick={() => onToggle(contact.username)}
        >
          <div className="check-box">
            {selectedContacts.has(contact.username) && <Check size={14} />}
          </div>
          <div className="contact-avatar">
            {contact.avatarUrl ? (
              <img src={contact.avatarUrl} alt="" />
            ) : (
              <span>{getAvatarLetter(contact.displayName)}</span>
            )}
          </div>
          <div className="contact-info">
            <div className="contact-name">{contact.displayName}</div>
            {contact.remark && contact.remark !== contact.displayName && (
              <div className="contact-remark">备注: {contact.remark}</div>
            )}
          </div>
          <div className={`contact-type ${contact.type}`}>
            {getContactTypeIcon(contact.type)}
            <span>{getContactTypeName(contact.type)}</span>
          </div>
        </div>
      ))}
      {contacts.length > 100 && (
        <div className="contacts-more">
          还有 {contacts.length - 100} 个联系人...
        </div>
      )}
    </div>
  )
}
