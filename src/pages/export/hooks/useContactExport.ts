import { useState, useEffect, useCallback } from 'react'
import type { Contact, ContactExportOptions } from '../types'
import type { ExportShared } from './useExportShared'

export function useContactExport(shared: ExportShared, active: boolean) {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [filteredContacts, setFilteredContacts] = useState<Contact[]>([])
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set())
  const [contactSearchKeyword, setContactSearchKeyword] = useState('')
  const [isLoadingContacts, setIsLoadingContacts] = useState(false)
  const [contactOptions, setContactOptions] = useState<ContactExportOptions>({
    format: 'json',
    exportAvatars: true,
    contactTypes: {
      friends: true,
      groups: false,
      officials: false
    }
  })

  // 加载通讯录
  const loadContacts = useCallback(async () => {
    setIsLoadingContacts(true)
    try {
      const result = await window.electronAPI.chat.connect()
      if (!result.success) {
        console.error('连接失败:', result.error)
        setIsLoadingContacts(false)
        return
      }
      const contactsResult = await window.electronAPI.chat.getContacts()
      if (contactsResult.success && contactsResult.contacts) {
        setContacts(contactsResult.contacts)
        setFilteredContacts(contactsResult.contacts)
      }
    } catch (e) {
      console.error('加载通讯录失败:', e)
    } finally {
      setIsLoadingContacts(false)
    }
  }, [])

  // 切换到通讯录时加载
  useEffect(() => {
    if (active && contacts.length === 0) {
      loadContacts()
    }
  }, [active, contacts.length, loadContacts])

  // 通讯录搜索过滤
  useEffect(() => {
    let filtered = contacts

    // 类型过滤
    filtered = filtered.filter(c => {
      if (c.type === 'friend' && !contactOptions.contactTypes.friends) return false
      if (c.type === 'group' && !contactOptions.contactTypes.groups) return false
      if (c.type === 'official' && !contactOptions.contactTypes.officials) return false
      return true
    })

    // 关键词过滤
    if (contactSearchKeyword.trim()) {
      const lower = contactSearchKeyword.toLowerCase()
      filtered = filtered.filter(c =>
        c.displayName?.toLowerCase().includes(lower) ||
        c.remark?.toLowerCase().includes(lower) ||
        c.username.toLowerCase().includes(lower)
      )
    }

    setFilteredContacts(filtered)
  }, [contactSearchKeyword, contacts, contactOptions.contactTypes])

  const toggleContact = (username: string) => {
    const newSet = new Set(selectedContacts)
    if (newSet.has(username)) {
      newSet.delete(username)
    } else {
      newSet.add(username)
    }
    setSelectedContacts(newSet)
  }

  const toggleSelectAllContacts = () => {
    if (selectedContacts.size === filteredContacts.length && filteredContacts.length > 0) {
      setSelectedContacts(new Set())
    } else {
      setSelectedContacts(new Set(filteredContacts.map(c => c.username)))
    }
  }

  // 导出通讯录
  const startContactExport = async () => {
    if (!shared.exportFolder) return

    shared.setIsExporting(true)
    shared.setExportResult(null)

    try {
      const result = await window.electronAPI.export.exportContacts(
        shared.exportFolder,
        {
          format: contactOptions.format,
          exportAvatars: contactOptions.exportAvatars,
          contactTypes: contactOptions.contactTypes,
          selectedUsernames: selectedContacts.size > 0 ? Array.from(selectedContacts) : undefined
        }
      )
      shared.setExportResult(result)
    } catch (e) {
      console.error('导出通讯录失败:', e)
      shared.setExportResult({ success: false, error: String(e) })
    } finally {
      shared.setIsExporting(false)
    }
  }

  return {
    filteredContacts,
    selectedContacts,
    contactSearchKeyword,
    setContactSearchKeyword,
    isLoadingContacts,
    contactOptions,
    setContactOptions,
    loadContacts,
    toggleContact,
    toggleSelectAllContacts,
    startContactExport
  }
}
