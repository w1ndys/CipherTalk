import { FileJson, FileText, Table, FileCode, FileSpreadsheet, Database, User } from 'lucide-react'
import type { FormatOption } from './types'

export const chatFormatOptions: FormatOption[] = [
  { value: 'chatlab', label: 'ChatLab', icon: FileCode, desc: '标准格式，支持其他软件导入' },
  { value: 'chatlab-jsonl', label: 'ChatLab JSONL', icon: FileCode, desc: '流式格式，适合大量消息' },
  { value: 'json', label: 'JSON', icon: FileJson, desc: '详细格式，包含完整消息信息' },
  { value: 'html', label: 'HTML', icon: FileText, desc: '网页格式，可直接浏览' },
  { value: 'txt', label: 'TXT', icon: Table, desc: '纯文本，通用格式' },
  { value: 'excel', label: 'Excel', icon: FileSpreadsheet, desc: '电子表格，适合统计分析' },
  { value: 'sql', label: 'PostgreSQL', icon: Database, desc: '数据库脚本，便于导入到数据库' }
]

export const contactFormatOptions: FormatOption[] = [
  { value: 'json', label: 'JSON', icon: FileJson, desc: '结构化数据，便于程序处理' },
  { value: 'csv', label: 'CSV', icon: FileSpreadsheet, desc: '表格格式，可用Excel打开' },
  { value: 'vcf', label: 'vCard', icon: User, desc: '通讯录标准格式，可导入手机' }
]

export const momentsFormatOptions: FormatOption[] = [
  { value: 'html', label: 'HTML', icon: FileText, desc: '网页格式，仿朋友圈样式可直接浏览' },
  { value: 'json', label: 'JSON', icon: FileJson, desc: '结构化数据，便于程序处理' },
  { value: 'excel', label: 'Excel', icon: FileSpreadsheet, desc: '电子表格，适合统计分析' }
]
