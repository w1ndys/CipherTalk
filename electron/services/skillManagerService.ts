import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync, readdirSync, rmSync, mkdirSync, mkdtempSync, renameSync } from 'fs'
import { join } from 'path'
import AdmZip from 'adm-zip'
import type { AgentSkillContextItem } from './agent/types'

type AdmZipFull = InstanceType<typeof AdmZip> & {
  getEntries(): Array<{ entryName: string }>
  extractAllTo(targetPath: string, overwrite: boolean): void
}

export type SkillInfo = {
  name: string
  version: string
  description: string
  builtin: boolean
}

type SkillDocument = {
  name: string
  version: string
  description: string
  content: string
}

const BUILTIN_SKILLS = new Set(['ct-mcp-copilot'])
const DEFAULT_AGENT_ALL_SKILL_BUDGET = 30_000
const SKILL_DOCS_CACHE_TTL_MS = 5 * 60 * 1000

function parseSkillFrontmatter(content: string): { name: string; version: string; description: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const raw = match?.[1] ?? ''

  const values: Record<string, string> = {}
  const lines = raw.split(/\r?\n/)
  let index = 0

  while (index < lines.length) {
    const line = lines[index]
    const matchLine = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/)
    if (!matchLine) {
      index += 1
      continue
    }

    const key = matchLine[1]
    const value = matchLine[2].trim()
    if (value === '>' || value === '|') {
      const blockLines: string[] = []
      index += 1
      while (index < lines.length && (/^\s+/.test(lines[index]) || lines[index].trim() === '')) {
        blockLines.push(lines[index].trim())
        index += 1
      }
      values[key] = value === '>' ? blockLines.join(' ').replace(/\s+/g, ' ').trim() : blockLines.join('\n').trim()
      continue
    }

    values[key] = value.replace(/^['"]|['"]$/g, '')
    index += 1
  }

  return {
    name: values.name || '',
    version: values.version || '0.0.0',
    description: values.description || '',
  }
}

function getSkillRoots(): string[] {
  return [
    join(process.resourcesPath, 'builtin-skills'),
    join(process.resourcesPath, 'app.asar'),
    join(process.resourcesPath, 'app.asar.unpacked'),
    join(app.getAppPath(), 'resources', 'builtin-skills'),
    join(process.cwd(), 'resources', 'builtin-skills'),
    app.getAppPath(),
    process.cwd(),
  ]
}

function resolveSkillDir(skillName: string): string | null {
  for (const root of getSkillRoots()) {
    const candidate = join(root, skillName)
    if (existsSync(join(candidate, 'SKILL.md'))) return candidate
    const alt = join(root, 'skills', skillName)
    if (existsSync(join(alt, 'SKILL.md'))) return alt
  }
  return null
}

let _cacheBasePath: string | null = null

export function setUserSkillsCachePath(cacheBasePath: string): void {
  _cacheBasePath = cacheBasePath
}

function getUserSkillsDir(): string {
  const base = _cacheBasePath || join(app.getPath('userData'), 'CipherTalk')
  return join(base, 'skills')
}

function scanSkillDir(baseDir: string, builtin: boolean): SkillInfo[] {
  if (!existsSync(baseDir)) return []
  const results: SkillInfo[] = []
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillMdPath = join(baseDir, entry.name, 'SKILL.md')
    if (!existsSync(skillMdPath)) continue
    try {
      const content = readFileSync(skillMdPath, 'utf8')
      const meta = parseSkillFrontmatter(content)
      results.push({
        name: meta.name || entry.name,
        version: meta.version,
        description: meta.description,
        builtin,
      })
    } catch {
      results.push({ name: entry.name, version: '0.0.0', description: '', builtin })
    }
  }
  return results
}

function findSkillDirectoryRecursive(baseDir: string): string | null {
  if (!existsSync(baseDir)) return null
  if (existsSync(join(baseDir, 'SKILL.md'))) return baseDir
  for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
    const entryPath = join(baseDir, entry.name)
    if (!entry.isDirectory()) continue
    if (existsSync(join(entryPath, 'SKILL.md'))) return entryPath
    const nested = findSkillDirectoryRecursive(entryPath)
    if (nested) return nested
  }
  return null
}

function getSkillNameFromDir(dir: string): string {
  try {
    const content = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    return parseSkillFrontmatter(content).name || dir.split(/[\\/]/).pop() || 'skill'
  } catch {
    return dir.split(/[\\/]/).pop() || 'skill'
  }
}

function stripSkillFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\s*/, '').trim()
}

function compactSkillContent(content: string, maxChars: number): string {
  const body = stripSkillFrontmatter(content)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return body.length > maxChars ? `${body.slice(0, Math.max(0, maxChars - 20)).trim()}\n...<truncated>` : body
}

export class SkillManagerService {
  listSkills(): SkillInfo[] {
    const results: SkillInfo[] = []
    const seen = new Set<string>()

    for (const root of getSkillRoots()) {
      for (const skill of scanSkillDir(root, true)) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name)
          results.push(skill)
        }
      }
      for (const skill of scanSkillDir(join(root, 'skills'), true)) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name)
          results.push(skill)
        }
      }
    }

    for (const skill of scanSkillDir(getUserSkillsDir(), false)) {
      if (!seen.has(skill.name)) {
        seen.add(skill.name)
        results.push(skill)
      }
    }

    return results
  }

  readSkillContent(skillName: string): { success: boolean; content?: string; error?: string } {
    const dir = resolveSkillDir(skillName) ?? this.resolveUserSkillDir(skillName)
    if (!dir) return { success: false, error: `Skill "${skillName}" not found` }
    try {
      const content = readFileSync(join(dir, 'SKILL.md'), 'utf8')
      return { success: true, content }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  updateSkillContent(skillName: string, content: string): { success: boolean; error?: string } {
    const dir = this.resolveUserSkillDir(skillName)
    if (!dir) return { success: false, error: `User skill "${skillName}" not found. Only user-imported skills can be edited.` }
    try {
      writeFileSync(join(dir, 'SKILL.md'), content, 'utf8')
      this.invalidateSkillCaches()
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  exportSkillZip(skillName: string): { success: boolean; outputPath?: string; fileName?: string; version?: string; error?: string } {
    const sourcePath = resolveSkillDir(skillName) ?? this.resolveUserSkillDir(skillName)
    if (!sourcePath) return { success: false, error: `Skill "${skillName}" not found` }

    try {
      const content = readFileSync(join(sourcePath, 'SKILL.md'), 'utf8')
      const meta = parseSkillFrontmatter(content)
      const downloadsDir = app.getPath('downloads')
      const version = meta.version || '0.0.0'
      const fileName = `${skillName}-v${version}.zip`
      const outputPath = join(downloadsDir, fileName)
      const zip: AdmZipFull = new AdmZip() as AdmZipFull
      zip.addLocalFolder(sourcePath, skillName)
      zip.writeZip(outputPath)
      return { success: true, outputPath, fileName, version }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  }

  importSkillZip(zipPath: string): { success: boolean; skillName?: string; error?: string } {
    let tempDir: string | null = null
    try {
      const zip: AdmZipFull = new AdmZip(zipPath) as AdmZipFull
      const entries = zip.getEntries()
      if (entries.length === 0) return { success: false, error: 'Zip file is empty' }

      if (!entries.some((e: { entryName: string }) => e.entryName.split('/').pop() === 'SKILL.md')) {
        return { success: false, error: 'No SKILL.md found in zip' }
      }

      const userSkillsDir = getUserSkillsDir()
      if (!existsSync(userSkillsDir)) {
        mkdirSync(userSkillsDir, { recursive: true })
      }

      tempDir = mkdtempSync(join(app.getPath('userData'), 'skill-import-'))
      zip.extractAllTo(tempDir, true)

      const extractedDir = findSkillDirectoryRecursive(tempDir)
      if (!extractedDir) {
        return { success: false, error: 'Skill extracted but SKILL.md not found' }
      }

      const skillName = getSkillNameFromDir(extractedDir)
      if (this.resolveUserSkillDir(skillName) || resolveSkillDir(skillName)) {
        return { success: false, error: `Skill "${skillName}" already exists` }
      }

      const destDir = join(userSkillsDir, skillName)
      if (existsSync(destDir)) {
        return { success: false, error: `Skill directory "${skillName}" already exists` }
      }

      renameSync(extractedDir, destDir)
      this.invalidateSkillCaches()
      return { success: true, skillName }
    } catch (error) {
      return { success: false, error: String(error) }
    } finally {
      if (tempDir && existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    }
  }

  deleteSkill(skillName: string): { success: boolean; error?: string } {
    if (BUILTIN_SKILLS.has(skillName)) {
      return { success: false, error: `Cannot delete builtin skill "${skillName}"` }
    }

    const dir = this.resolveUserSkillDir(skillName)
    if (!dir) return { success: false, error: `Skill "${skillName}" not found` }

    try {
      rmSync(dir, { recursive: true, force: true })
      this.invalidateSkillCaches()
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  createSkill(skillName: string, content: string): { success: boolean; error?: string } {
    const userSkillsDir = getUserSkillsDir()
    const destDir = join(userSkillsDir, skillName)

    if (existsSync(destDir)) {
      return { success: false, error: `Skill "${skillName}" already exists` }
    }

    try {
      mkdirSync(destDir, { recursive: true })
      writeFileSync(join(destDir, 'SKILL.md'), content, 'utf8')
      this.invalidateSkillCaches()
      return { success: true }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  // 全量技能文档缓存：每条 Agent 消息都要读取技能上下文，同步重读全部 SKILL.md（含逐根目录 existsSync 探测）
  // 会堵事件循环几百毫秒。技能增删改时失效，TTL 兜底外部直接改文件的情况。
  private skillDocsCache: { value: SkillDocument[]; at: number } | null = null

  private invalidateSkillCaches(): void {
    this.skillDocsCache = null
  }

  private getSkillDocuments(): SkillDocument[] {
    const cached = this.skillDocsCache
    if (cached && Date.now() - cached.at < SKILL_DOCS_CACHE_TTL_MS) return cached.value
    const docs = this.listSkills()
      .map((skill) => {
        const loaded = this.readSkillContent(skill.name)
        if (!loaded.success || !loaded.content) return null
        const meta = parseSkillFrontmatter(loaded.content)
        return {
          name: meta.name || skill.name,
          version: meta.version || skill.version,
          description: meta.description || skill.description,
          content: loaded.content,
        }
      })
      .filter((item): item is SkillDocument => Boolean(item))
    this.skillDocsCache = { value: docs, at: Date.now() }
    return docs
  }

  getAllSkillsForAgentPrompt(totalBudget = DEFAULT_AGENT_ALL_SKILL_BUDGET): AgentSkillContextItem[] {
    const docs = this.getSkillDocuments()
    if (docs.length === 0) return []
    const full = docs.map((doc) => ({
      name: doc.name,
      version: doc.version,
      description: doc.description,
      content: compactSkillContent(doc.content, Number.MAX_SAFE_INTEGER),
    }))
    const fullLength = full.reduce((sum, item) => sum + item.content.length, 0)
    const safeBudget = Math.max(0, Math.floor(totalBudget))
    if (fullLength <= safeBudget) return full

    let remaining = safeBudget
    return docs.map((doc, index) => {
      const remainingDocs = Math.max(1, docs.length - index)
      const perSkillBudget = remaining > 0 ? Math.floor(remaining / remainingDocs) : 0
      const content = perSkillBudget > 0 ? compactSkillContent(doc.content, perSkillBudget) : ''
      remaining = Math.max(0, remaining - content.length)
      return {
        name: doc.name,
        version: doc.version,
        description: doc.description,
        content,
      }
    })
  }

  private resolveUserSkillDir(skillName: string): string | null {
    const dir = join(getUserSkillsDir(), skillName)
    if (existsSync(join(dir, 'SKILL.md'))) return dir
    const userSkillsDir = getUserSkillsDir()
    if (!existsSync(userSkillsDir)) return null
    for (const entry of readdirSync(userSkillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(userSkillsDir, entry.name)
      if (!existsSync(join(candidate, 'SKILL.md'))) continue
      if (getSkillNameFromDir(candidate) === skillName) return candidate
    }
    return null
  }
}

export const skillManagerService = new SkillManagerService()
