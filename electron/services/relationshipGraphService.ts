import { EventEmitter } from 'events'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import { chatService } from './chatService'
import { ConfigService } from './config'
import { groupMetadataService } from './groupMetadataService'
import { getUserDataPath } from './runtimePaths'
import type { ChatSession, Message, ContactInfo } from './chat/types'
import type {
  RelationshipGraphBuildProgress,
  RelationshipGraphCommunity,
  RelationshipGraphLink,
  RelationshipGraphNode,
  RelationshipGraphOptions,
  RelationshipGraphPathResult,
  RelationshipGraphRelationType,
  RelationshipGraphResult,
} from '../../src/types/models'

type NodeDraft = Omit<RelationshipGraphNode, 'weightedDegree' | 'degree'> & {
  weightedDegree?: number
  degree?: number
}

type LinkDraft = RelationshipGraphLink

type CachedGraph = {
  builtAt: number
  nodes: RelationshipGraphNode[]
  links: RelationshipGraphLink[]
}

type EdgeAccumulator = {
  source: string
  target: string
  type: RelationshipGraphRelationType
  weight: number
  messageCount: number
  sharedGroupCount: number
  lastActiveTime: number
  evidenceSessionIds: Set<string>
}

const CACHE_DB_NAME = 'relationship_graph.db'
const CACHE_KEY = 'default'
const SCHEMA_VERSION = '1'
const SESSION_PAGE_SIZE = 800
const GROUP_MESSAGE_PAGE_SIZE = 500
const MAX_GROUP_MESSAGES = 3000
const MAX_GROUP_PAIR_CANDIDATES = 56
const GROUP_INTERACTION_WINDOW_SECONDS = 10 * 60

function normalizeSeconds(value?: number): number | undefined {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n)
}

function isGroupSession(username: string): boolean {
  return username.includes('@chatroom')
}

function isPersonUsername(username: string): boolean {
  if (!username) return false
  if (isGroupSession(username)) return false
  if (username.startsWith('gh_')) return false
  if (username.includes('@kefu.openim')) return false
  if (username.includes('@openim')) return true
  return username.startsWith('wxid_') || !username.includes('@')
}

function edgeKey(a: string, b: string, type: RelationshipGraphRelationType): string | null {
  if (!a || !b || a === b) return null
  return a < b ? `${type}:${a}::${b}` : `${type}:${b}::${a}`
}

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a]
}

function recencyBoost(lastActiveTime?: number): number {
  const ts = normalizeSeconds(lastActiveTime)
  if (!ts) return 0
  const ageDays = Math.max(0, (Date.now() / 1000 - ts) / 86400)
  if (ageDays <= 7) return 8
  if (ageDays <= 30) return 5
  if (ageDays <= 180) return 2
  return 0
}

function displayNameOf(contact?: ContactInfo | null, fallback?: string): string {
  return String(contact?.displayName || contact?.remark || contact?.nickname || fallback || '').trim()
}

function uniqueEvidence(values: Iterable<string>): string[] {
  return Array.from(new Set(Array.from(values).filter(Boolean))).slice(0, 24)
}

class RelationshipGraphService extends EventEmitter {
  private configService = new ConfigService()
  private cacheDb: Database.Database | null = null
  private stale = true
  private building: Promise<CachedGraph> | null = null

  constructor() {
    super()
    chatService.on('dbChange', () => {
      this.stale = true
    })
  }

  markStale(): void {
    this.stale = true
  }

  private emitProgress(progress: RelationshipGraphBuildProgress): void {
    this.emit('progress', progress)
  }

  private getCacheDir(): string {
    const configured = String(this.configService.get('cachePath') || '').trim()
    const dir = configured || join(getUserDataPath(), 'cache')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  private getCacheDb(): Database.Database {
    if (this.cacheDb) return this.cacheDb
    const db = new Database(join(this.getCacheDir(), CACHE_DB_NAME))
    db.pragma('journal_mode = WAL')
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graph_snapshot (
        key TEXT PRIMARY KEY,
        built_at INTEGER NOT NULL,
        graph_json TEXT NOT NULL
      );
    `)
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', SCHEMA_VERSION)
    this.cacheDb = db
    return db
  }

  private loadCachedGraph(): CachedGraph | null {
    try {
      const row = this.getCacheDb()
        .prepare('SELECT built_at as builtAt, graph_json as graphJson FROM graph_snapshot WHERE key = ?')
        .get(CACHE_KEY) as { builtAt: number; graphJson: string } | undefined
      if (!row?.graphJson) return null
      const parsed = JSON.parse(row.graphJson) as Pick<CachedGraph, 'nodes' | 'links'>
      if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.links)) return null
      return { builtAt: Number(row.builtAt || Date.now()), nodes: parsed.nodes, links: parsed.links }
    } catch {
      return null
    }
  }

  private saveCachedGraph(graph: CachedGraph): void {
    this.getCacheDb()
      .prepare('INSERT OR REPLACE INTO graph_snapshot (key, built_at, graph_json) VALUES (?, ?, ?)')
      .run(CACHE_KEY, graph.builtAt, JSON.stringify({ nodes: graph.nodes, links: graph.links }))
  }

  async getGraph(options: RelationshipGraphOptions = {}): Promise<RelationshipGraphResult> {
    try {
      let graph = this.loadCachedGraph()
      if (!graph || this.stale) {
        graph = await this.rebuildBaseGraph()
      }
      return this.toResult(graph, options)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async rebuild(options: RelationshipGraphOptions = {}): Promise<RelationshipGraphResult> {
    try {
      const graph = await this.rebuildBaseGraph(true)
      return this.toResult(graph, options)
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  async getPath(sourceId: string, targetId: string, options: RelationshipGraphOptions = {}): Promise<RelationshipGraphPathResult> {
    const result = await this.getGraph({ ...options, includeIsolated: false })
    if (!result.success || !result.nodes || !result.links) {
      return { success: false, error: result.error || '图谱不可用' }
    }
    const nodeIds = new Set(result.nodes.map(node => node.id))
    if (!nodeIds.has(sourceId) || !nodeIds.has(targetId)) {
      return { success: false, error: '联系人不在当前图谱筛选结果中' }
    }
    if (sourceId === targetId) return { success: true, nodeIds: [sourceId], links: [] }

    const adjacency = new Map<string, Array<{ next: string; link: RelationshipGraphLink }>>()
    for (const link of result.links) {
      const source = String(link.source)
      const target = String(link.target)
      if (!adjacency.has(source)) adjacency.set(source, [])
      if (!adjacency.has(target)) adjacency.set(target, [])
      adjacency.get(source)!.push({ next: target, link })
      adjacency.get(target)!.push({ next: source, link })
    }

    const queue = [sourceId]
    const visited = new Set([sourceId])
    const prev = new Map<string, { node: string; link: RelationshipGraphLink }>()
    while (queue.length > 0) {
      const current = queue.shift()!
      const neighbors = (adjacency.get(current) || [])
        .sort((a, b) => Number(b.link.weight || 0) - Number(a.link.weight || 0))
      for (const item of neighbors) {
        if (visited.has(item.next)) continue
        visited.add(item.next)
        prev.set(item.next, { node: current, link: item.link })
        if (item.next === targetId) {
          const pathNodes = [targetId]
          const pathLinks: RelationshipGraphLink[] = []
          let cursor = targetId
          while (cursor !== sourceId) {
            const p = prev.get(cursor)
            if (!p) break
            pathLinks.unshift(p.link)
            pathNodes.unshift(p.node)
            cursor = p.node
          }
          return { success: true, nodeIds: pathNodes, links: pathLinks }
        }
        queue.push(item.next)
      }
    }
    return { success: false, error: '没有找到关系路径' }
  }

  private async rebuildBaseGraph(force = false): Promise<CachedGraph> {
    if (this.building && !force) return this.building
    this.building = this.buildGraphInternal()
    try {
      return await this.building
    } finally {
      this.building = null
    }
  }

  private async buildGraphInternal(): Promise<CachedGraph> {
    this.emitProgress({ stage: 'loading', message: '正在读取联系人和会话' })

    const myInfo = await chatService.getMyUserInfo()
    if (!myInfo.success || !myInfo.userInfo?.wxid) {
      throw new Error(myInfo.error || '请先连接微信数据库')
    }

    const contactsResult = await chatService.getContacts()
    const contacts = contactsResult.contacts || []
    const contactMap = new Map(contacts.map(contact => [contact.username, contact]))
    const nodes = new Map<string, NodeDraft>()
    const edges = new Map<string, EdgeAccumulator>()

    const addNode = (id: string, patch: Partial<NodeDraft> = {}) => {
      if (!isPersonUsername(id) && id !== myInfo.userInfo!.wxid) return
      const current = nodes.get(id)
      const contact = contactMap.get(id)
      const label = patch.label || displayNameOf(contact, id)
      nodes.set(id, {
        id,
        label,
        avatarUrl: patch.avatarUrl || contact?.avatarUrl || current?.avatarUrl,
        kind: patch.kind || current?.kind || (id === myInfo.userInfo!.wxid ? 'self' : 'other'),
        communityId: current?.communityId,
        lastActiveTime: Math.max(Number(current?.lastActiveTime || 0), Number(patch.lastActiveTime || 0)) || undefined,
      })
    }

    const addEdge = (
      a: string,
      b: string,
      type: RelationshipGraphRelationType,
      amount: { weight: number; messageCount?: number; sharedGroupCount?: number; lastActiveTime?: number; evidenceSessionId?: string }
    ) => {
      if (!isPersonUsername(a) && a !== myInfo.userInfo!.wxid) return
      if (!isPersonUsername(b) && b !== myInfo.userInfo!.wxid) return
      const key = edgeKey(a, b, type)
      if (!key) return
      const [source, target] = orderedPair(a, b)
      let edge = edges.get(key)
      if (!edge) {
        edge = {
          source,
          target,
          type,
          weight: 0,
          messageCount: 0,
          sharedGroupCount: 0,
          lastActiveTime: 0,
          evidenceSessionIds: new Set<string>(),
        }
        edges.set(key, edge)
      }
      edge.weight += amount.weight
      edge.messageCount += amount.messageCount || 0
      edge.sharedGroupCount += amount.sharedGroupCount || 0
      edge.lastActiveTime = Math.max(edge.lastActiveTime, normalizeSeconds(amount.lastActiveTime) || 0)
      if (amount.evidenceSessionId) edge.evidenceSessionIds.add(amount.evidenceSessionId)
    }

    addNode(myInfo.userInfo.wxid, {
      label: myInfo.userInfo.nickName || myInfo.userInfo.alias || '我',
      avatarUrl: myInfo.userInfo.avatarUrl,
      kind: 'self',
    })
    for (const contact of contacts) {
      if (contact.type === 'friend' || contact.type === 'former_friend' || contact.type === 'other') {
        addNode(contact.username, {
          label: contact.displayName,
          avatarUrl: contact.avatarUrl,
          kind: contact.type === 'friend' ? 'friend' : 'other',
          lastActiveTime: contact.lastContactTime,
        })
      }
    }

    const sessions = await this.loadAllSessions()
    this.emitProgress({ stage: 'sessions', message: '正在计算私聊关系', current: 0, total: sessions.length })

    const groupSessions: ChatSession[] = []
    let sessionIndex = 0
    for (const session of sessions) {
      sessionIndex += 1
      if (isGroupSession(session.username)) {
        groupSessions.push(session)
        continue
      }
      if (!isPersonUsername(session.username)) continue

      const detail = await chatService.getSessionDetail(session.username).catch(() => null)
      const messageCount = detail?.success ? Number(detail.detail?.messageCount || 0) : 0
      const latest = normalizeSeconds(detail?.detail?.latestMessageTime || session.lastTimestamp || session.sortTimestamp)
      const weight = Math.max(1, Math.log1p(Math.max(messageCount, 1)) * 4 + recencyBoost(latest))

      addNode(session.username, {
        label: session.displayName || displayNameOf(contactMap.get(session.username), session.username),
        avatarUrl: session.avatarUrl || contactMap.get(session.username)?.avatarUrl,
        kind: 'friend',
        lastActiveTime: latest,
      })
      addEdge(myInfo.userInfo.wxid, session.username, 'direct_chat', {
        weight,
        messageCount,
        lastActiveTime: latest,
        evidenceSessionId: session.username,
      })

      if (sessionIndex % 100 === 0) {
        this.emitProgress({ stage: 'sessions', message: `正在计算私聊关系 ${sessionIndex}/${sessions.length}`, current: sessionIndex, total: sessions.length })
      }
    }

    this.emitProgress({ stage: 'groups', message: '正在计算群聊共同关系', current: 0, total: groupSessions.length })
    for (let i = 0; i < groupSessions.length; i += 1) {
      const group = groupSessions[i]
      await this.addGroupEdges(group, contactMap, addNode, addEdge)
      this.emitProgress({ stage: 'groups', message: `正在计算群聊共同关系 ${i + 1}/${groupSessions.length}`, current: i + 1, total: groupSessions.length })
    }

    this.emitProgress({ stage: 'analyzing', message: '正在分析社群和中心性' })
    const graph = this.finalizeGraph(nodes, edges)
    this.emitProgress({ stage: 'caching', message: '正在写入关系网络缓存' })
    this.saveCachedGraph(graph)
    this.stale = false
    this.emitProgress({ stage: 'done', message: '关系网络构建完成', current: graph.nodes.length, total: graph.nodes.length })
    return graph
  }

  private async loadAllSessions(): Promise<ChatSession[]> {
    const all: ChatSession[] = []
    for (let offset = 0; ; offset += SESSION_PAGE_SIZE) {
      const result = await chatService.getSessions(offset, SESSION_PAGE_SIZE)
      if (!result.success) throw new Error(result.error || '获取会话失败')
      const page = result.sessions || []
      all.push(...page)
      if (!result.hasMore || page.length === 0) break
    }
    return all
  }

  private async scanSessionMessages(sessionId: string, limit: number): Promise<Message[]> {
    const first = await chatService.getMessages(sessionId, 0, GROUP_MESSAGE_PAGE_SIZE)
    if (!first.success || !first.messages) return []
    const messages = [...first.messages]
    let hasMore = !!first.hasMore
    while (hasMore && messages.length < limit) {
      const oldest = messages[0]
      if (!oldest) break
      const next = await chatService.getMessagesBefore(
        sessionId,
        oldest.sortSeq,
        Math.min(GROUP_MESSAGE_PAGE_SIZE, limit - messages.length),
        oldest.createTime,
        oldest.localId
      )
      if (!next.success || !next.messages?.length) break
      messages.unshift(...next.messages)
      hasMore = !!next.hasMore
    }
    return messages.slice(-limit).sort((a, b) => Number(a.createTime || 0) - Number(b.createTime || 0))
  }

  private async addGroupEdges(
    group: ChatSession,
    contactMap: Map<string, ContactInfo>,
    addNode: (id: string, patch?: Partial<NodeDraft>) => void,
    addEdge: (
      a: string,
      b: string,
      type: RelationshipGraphRelationType,
      amount: { weight: number; messageCount?: number; sharedGroupCount?: number; lastActiveTime?: number; evidenceSessionId?: string }
    ) => void
  ): Promise<void> {
    const messages = await this.scanSessionMessages(group.username, MAX_GROUP_MESSAGES).catch(() => [])
    const members = await groupMetadataService.getGroupMembers(group.username).catch(() => [])
    const active = new Map<string, { count: number; lastActiveTime: number }>()

    for (const member of members) {
      if (!isPersonUsername(member.username)) continue
      addNode(member.username, {
        label: member.displayName || displayNameOf(contactMap.get(member.username), member.username),
        avatarUrl: member.avatarUrl || contactMap.get(member.username)?.avatarUrl,
        kind: contactMap.has(member.username) ? 'friend' : 'group_member',
      })
    }

    let previous: Message | null = null
    for (const message of messages) {
      const sender = String(message.senderUsername || '').trim()
      if (!isPersonUsername(sender)) continue
      const ts = normalizeSeconds(message.createTime) || 0
      const item = active.get(sender) || { count: 0, lastActiveTime: 0 }
      item.count += 1
      item.lastActiveTime = Math.max(item.lastActiveTime, ts)
      active.set(sender, item)
      addNode(sender, {
        label: displayNameOf(contactMap.get(sender), sender),
        avatarUrl: contactMap.get(sender)?.avatarUrl,
        kind: contactMap.has(sender) ? 'friend' : 'group_member',
        lastActiveTime: ts,
      })

      const prevSender = String(previous?.senderUsername || '').trim()
      const prevTs = normalizeSeconds(previous?.createTime) || 0
      if (previous && prevSender && prevSender !== sender && isPersonUsername(prevSender) && ts - prevTs <= GROUP_INTERACTION_WINDOW_SECONDS) {
        addEdge(prevSender, sender, 'group_interaction', {
          weight: 1.5,
          messageCount: 1,
          lastActiveTime: ts,
          evidenceSessionId: group.username,
        })
      }
      previous = message
    }

    const candidates = Array.from(active.entries())
      .sort((a, b) => b[1].count - a[1].count || b[1].lastActiveTime - a[1].lastActiveTime)
      .slice(0, MAX_GROUP_PAIR_CANDIDATES)

    for (let i = 0; i < candidates.length; i += 1) {
      for (let j = i + 1; j < candidates.length; j += 1) {
        const [a, aStats] = candidates[i]
        const [b, bStats] = candidates[j]
        const coActivity = Math.min(aStats.count, bStats.count)
        addEdge(a, b, 'same_group', {
          weight: Math.min(4, 0.2 + Math.log1p(coActivity) * 0.35),
          sharedGroupCount: 1,
          lastActiveTime: Math.max(aStats.lastActiveTime, bStats.lastActiveTime),
          evidenceSessionId: group.username,
        })
      }
    }
  }

  private finalizeGraph(nodes: Map<string, NodeDraft>, edges: Map<string, EdgeAccumulator>): CachedGraph {
    const links: RelationshipGraphLink[] = Array.from(edges.values()).map(edge => ({
      source: edge.source,
      target: edge.target,
      type: edge.type,
      weight: Number(edge.weight.toFixed(3)),
      messageCount: edge.messageCount || undefined,
      sharedGroupCount: edge.sharedGroupCount || undefined,
      lastActiveTime: edge.lastActiveTime || undefined,
      evidenceSessionIds: uniqueEvidence(edge.evidenceSessionIds),
    }))

    const nodeList = Array.from(nodes.values()).map(node => ({
      ...node,
      degree: 0,
      weightedDegree: 0,
    })) as RelationshipGraphNode[]

    this.assignNodeMetrics(nodeList, links)
    this.assignCommunities(nodeList, links)

    return {
      builtAt: Date.now(),
      nodes: nodeList,
      links,
    }
  }

  private assignNodeMetrics(nodes: RelationshipGraphNode[], links: RelationshipGraphLink[]): void {
    const nodeMap = new Map(nodes.map(node => [node.id, node]))
    for (const node of nodes) {
      node.degree = 0
      node.weightedDegree = 0
    }
    for (const link of links) {
      const source = nodeMap.get(String(link.source))
      const target = nodeMap.get(String(link.target))
      if (!source || !target) continue
      source.degree += 1
      target.degree += 1
      source.weightedDegree = Number((source.weightedDegree + link.weight).toFixed(3))
      target.weightedDegree = Number((target.weightedDegree + link.weight).toFixed(3))
      const last = normalizeSeconds(link.lastActiveTime)
      if (last) {
        source.lastActiveTime = Math.max(Number(source.lastActiveTime || 0), last)
        target.lastActiveTime = Math.max(Number(target.lastActiveTime || 0), last)
      }
    }
  }

  private assignCommunities(nodes: RelationshipGraphNode[], links: RelationshipGraphLink[]): void {
    try {
      const graph = new Graph({ type: 'undirected', multi: false })
      for (const node of nodes) graph.addNode(node.id)
      for (const link of links) {
        const source = String(link.source)
        const target = String(link.target)
        if (!graph.hasNode(source) || !graph.hasNode(target) || graph.hasEdge(source, target)) continue
        graph.addUndirectedEdge(source, target, { weight: Math.max(0.01, Number(link.weight || 0.01)) })
      }
      const communities = louvain(graph, { getEdgeWeight: 'weight' }) as Record<string, number>
      for (const node of nodes) node.communityId = `c${communities[node.id] ?? 0}`
    } catch {
      this.assignComponentCommunities(nodes, links)
    }
  }

  private assignComponentCommunities(nodes: RelationshipGraphNode[], links: RelationshipGraphLink[]): void {
    const adjacency = new Map<string, string[]>()
    for (const node of nodes) adjacency.set(node.id, [])
    for (const link of links) {
      const source = String(link.source)
      const target = String(link.target)
      adjacency.get(source)?.push(target)
      adjacency.get(target)?.push(source)
    }
    const visited = new Set<string>()
    let community = 0
    for (const node of nodes) {
      if (visited.has(node.id)) continue
      const id = `c${community++}`
      const stack = [node.id]
      visited.add(node.id)
      while (stack.length) {
        const current = stack.pop()!
        const currentNode = nodes.find(item => item.id === current)
        if (currentNode) currentNode.communityId = id
        for (const next of adjacency.get(current) || []) {
          if (visited.has(next)) continue
          visited.add(next)
          stack.push(next)
        }
      }
    }
  }

  private toResult(graph: CachedGraph, options: RelationshipGraphOptions): RelationshipGraphResult {
    const relationTypes = new Set(options.relationTypes || ['direct_chat', 'same_group', 'group_interaction'])
    const startTime = normalizeSeconds(options.startTime)
    const endTime = normalizeSeconds(options.endTime)
    const minWeight = Math.max(0, Number(options.minWeight || 0))
    const query = String(options.query || '').trim().toLowerCase()

    let links = graph.links.filter(link => {
      if (!relationTypes.has(link.type)) return false
      if (Number(link.weight || 0) < minWeight) return false
      const last = normalizeSeconds(link.lastActiveTime)
      if (startTime && (!last || last < startTime)) return false
      if (endTime && (!last || last > endTime)) return false
      return true
    })

    const connectedIds = new Set<string>()
    for (const link of links) {
      connectedIds.add(String(link.source))
      connectedIds.add(String(link.target))
    }

    let nodes = graph.nodes.filter(node => options.includeIsolated !== false || connectedIds.has(node.id))
    if (options.communityId) {
      const allowed = new Set(nodes.filter(node => node.communityId === options.communityId).map(node => node.id))
      nodes = nodes.filter(node => allowed.has(node.id))
      links = links.filter(link => allowed.has(String(link.source)) && allowed.has(String(link.target)))
    }
    if (query) {
      const matching = new Set(nodes
        .filter(node => node.label.toLowerCase().includes(query) || node.id.toLowerCase().includes(query))
        .map(node => node.id))
      const expanded = new Set(matching)
      for (const link of links) {
        const source = String(link.source)
        const target = String(link.target)
        if (matching.has(source)) expanded.add(target)
        if (matching.has(target)) expanded.add(source)
      }
      nodes = nodes.filter(node => expanded.has(node.id))
      links = links.filter(link => expanded.has(String(link.source)) && expanded.has(String(link.target)))
    }

    nodes = nodes.map(node => ({ ...node }))
    links = links.map(link => ({ ...link, evidenceSessionIds: [...link.evidenceSessionIds] }))
    this.assignNodeMetrics(nodes, links)

    const nodeIds = new Set(nodes.map(node => node.id))
    links = links.filter(link => nodeIds.has(String(link.source)) && nodeIds.has(String(link.target)))
    const communities = this.buildCommunities(nodes)
    const rankings = {
      central: [...nodes].sort((a, b) => b.weightedDegree - a.weightedDegree).slice(0, 24),
      isolated: nodes.filter(node => node.degree === 0).sort((a, b) => (b.lastActiveTime || 0) - (a.lastActiveTime || 0)).slice(0, 24),
      active: [...nodes].sort((a, b) => (b.lastActiveTime || 0) - (a.lastActiveTime || 0)).slice(0, 24),
    }

    return {
      success: true,
      nodes,
      links,
      communities,
      rankings,
      similar: this.buildSimilar(nodes, links),
      stats: {
        nodeCount: nodes.length,
        linkCount: links.length,
        directChatCount: links.filter(link => link.type === 'direct_chat').length,
        sameGroupCount: links.filter(link => link.type === 'same_group').length,
        groupInteractionCount: links.filter(link => link.type === 'group_interaction').length,
        isolatedCount: nodes.filter(node => node.degree === 0).length,
        communityCount: communities.length,
        builtAt: graph.builtAt,
        stale: this.stale,
      },
    }
  }

  private buildCommunities(nodes: RelationshipGraphNode[]): RelationshipGraphCommunity[] {
    const map = new Map<string, RelationshipGraphCommunity>()
    for (const node of nodes) {
      const id = node.communityId || 'c0'
      const item = map.get(id) || { id, label: `社群 ${id.replace(/^c/, '')}`, size: 0, weight: 0 }
      item.size += 1
      item.weight = Number((item.weight + node.weightedDegree).toFixed(3))
      map.set(id, item)
    }
    return Array.from(map.values()).sort((a, b) => b.size - a.size)
  }

  private buildSimilar(nodes: RelationshipGraphNode[], links: RelationshipGraphLink[]): Record<string, RelationshipGraphNode[]> {
    const nodeMap = new Map(nodes.map(node => [node.id, node]))
    const neighbors = new Map<string, Set<string>>()
    for (const node of nodes) neighbors.set(node.id, new Set())
    for (const link of links) {
      const source = String(link.source)
      const target = String(link.target)
      neighbors.get(source)?.add(target)
      neighbors.get(target)?.add(source)
    }
    const anchors = [...nodes].sort((a, b) => b.weightedDegree - a.weightedDegree).slice(0, 80)
    const result: Record<string, RelationshipGraphNode[]> = {}
    for (const anchor of anchors) {
      const anchorNeighbors = neighbors.get(anchor.id) || new Set()
      if (anchorNeighbors.size === 0) continue
      const scored = nodes
        .filter(node => node.id !== anchor.id)
        .map(node => {
          const otherNeighbors = neighbors.get(node.id) || new Set()
          let intersection = 0
          for (const id of anchorNeighbors) if (otherNeighbors.has(id)) intersection += 1
          const union = new Set([...anchorNeighbors, ...otherNeighbors]).size || 1
          return { node, score: intersection / union }
        })
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || b.node.weightedDegree - a.node.weightedDegree)
        .slice(0, 6)
        .map(item => nodeMap.get(item.node.id)!)
      if (scored.length) result[anchor.id] = scored
    }
    return result
  }
}

export const relationshipGraphService = new RelationshipGraphService()
