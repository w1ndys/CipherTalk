import type {
  ExtractedDecisionFact,
  ExtractedEventFact,
  ExtractedRiskFact,
  ExtractedStructuredAnalysis,
  ExtractedTodoFact,
  OpenQuestionFact,
  TopicFact
} from '../types/analysis'

function normalizeComparableText(value?: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？；：、“”‘’（）【】《》,.!?:;"'()\-_/\\[\]{}]+/g, '')
}

function choosePreferredText<T extends { text?: string; name?: string }>(current: T, incoming: T): T {
  const currentValue = current.text || current.name || ''
  const incomingValue = incoming.text || incoming.name || ''
  return incomingValue.length > currentValue.length ? incoming : current
}

function mergeEvidenceKeys(current: string[], incoming: string[]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []

  for (const key of [...current, ...incoming]) {
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(key)
  }

  return merged
}

function sortByConfidence<T extends { confidence: number }>(items: T[]): T[] {
  return items.sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence
    }
    return JSON.stringify(a).localeCompare(JSON.stringify(b), 'zh-CN')
  })
}

function sortTopics(items: TopicFact[]): TopicFact[] {
  return items.sort((a, b) => b.importance - a.importance || a.name.localeCompare(b.name, 'zh-CN'))
}

const TODO_STATUS_PRIORITY: Record<ExtractedTodoFact['status'], number> = {
  done: 3,
  open: 2,
  unknown: 1
}

function mergeDecisionFact(existing: ExtractedDecisionFact, incoming: ExtractedDecisionFact): ExtractedDecisionFact {
  const preferred = incoming.confidence > existing.confidence
    ? incoming
    : incoming.confidence === existing.confidence
      ? choosePreferredText(existing, incoming)
      : existing

  return {
    ...preferred,
    evidenceRefs: mergeEvidenceKeys(existing.evidenceRefs, incoming.evidenceRefs)
  }
}

function mergeTodoFact(existing: ExtractedTodoFact, incoming: ExtractedTodoFact): ExtractedTodoFact {
  const incomingPriority = TODO_STATUS_PRIORITY[incoming.status]
  const existingPriority = TODO_STATUS_PRIORITY[existing.status]

  let preferred = existing

  if (incomingPriority > existingPriority) {
    preferred = incoming
  } else if (
    incomingPriority === existingPriority
    && (incoming.confidence > existing.confidence || incoming.task.length > existing.task.length)
  ) {
    preferred = incoming
  }

  return {
    ...preferred,
    evidenceRefs: mergeEvidenceKeys(existing.evidenceRefs, incoming.evidenceRefs)
  }
}

function mergeRiskFact(existing: ExtractedRiskFact, incoming: ExtractedRiskFact): ExtractedRiskFact {
  const preferred = incoming.confidence > existing.confidence
    ? incoming
    : incoming.confidence === existing.confidence
      ? choosePreferredText(existing, incoming)
      : existing

  return {
    ...preferred,
    evidenceRefs: mergeEvidenceKeys(existing.evidenceRefs, incoming.evidenceRefs)
  }
}

function mergeEventFact(existing: ExtractedEventFact, incoming: ExtractedEventFact): ExtractedEventFact {
  const preferred = incoming.confidence > existing.confidence
    ? incoming
    : incoming.confidence === existing.confidence
      ? choosePreferredText(existing, incoming)
      : existing

  return {
    ...preferred,
    evidenceRefs: mergeEvidenceKeys(existing.evidenceRefs, incoming.evidenceRefs)
  }
}

export function mergeStructuredAnalysisBlocks(blockResults: ExtractedStructuredAnalysis[]): ExtractedStructuredAnalysis {
  let overview = ''
  const topics = new Map<string, TopicFact>()
  const decisions = new Map<string, ExtractedDecisionFact>()
  const todos = new Map<string, ExtractedTodoFact>()
  const risks = new Map<string, ExtractedRiskFact>()
  const events = new Map<string, ExtractedEventFact>()
  const openQuestions = new Map<string, OpenQuestionFact>()

  for (const blockResult of blockResults) {
    if (blockResult.overview.trim()) {
      overview = blockResult.overview.trim()
    }

    for (const topic of blockResult.topics) {
      const key = normalizeComparableText(topic.name)
      if (!key) continue
      const existing = topics.get(key)
      if (!existing || topic.importance > existing.importance || (topic.importance === existing.importance && topic.name.length > existing.name.length)) {
        topics.set(key, topic)
      }
    }

    for (const decision of blockResult.decisions) {
      const key = normalizeComparableText(decision.text)
      if (!key) continue
      const existing = decisions.get(key)
      if (!existing) {
        decisions.set(key, decision)
        continue
      }

      decisions.set(key, mergeDecisionFact(existing, decision))
    }

    for (const todo of blockResult.todos) {
      const key = `${normalizeComparableText(todo.owner)}|${normalizeComparableText(todo.task)}|${normalizeComparableText(todo.deadline)}`
      if (!normalizeComparableText(todo.task)) continue
      const existing = todos.get(key)
      if (!existing) {
        todos.set(key, todo)
        continue
      }

      todos.set(key, mergeTodoFact(existing, todo))
    }

    for (const risk of blockResult.risks) {
      const key = normalizeComparableText(risk.text)
      if (!key) continue
      const existing = risks.get(key)
      if (!existing) {
        risks.set(key, risk)
        continue
      }

      risks.set(key, mergeRiskFact(existing, risk))
    }

    for (const event of blockResult.events) {
      const key = `${normalizeComparableText(event.text)}|${normalizeComparableText(event.date)}`
      if (!normalizeComparableText(event.text)) continue
      const existing = events.get(key)
      if (!existing) {
        events.set(key, event)
        continue
      }

      events.set(key, mergeEventFact(existing, event))
    }

    for (const question of blockResult.openQuestions) {
      const key = normalizeComparableText(question.text)
      if (!key || openQuestions.has(key)) continue
      openQuestions.set(key, question)
    }
  }

  return {
    overview,
    topics: sortTopics(Array.from(topics.values())),
    decisions: sortByConfidence(Array.from(decisions.values())),
    todos: sortByConfidence(Array.from(todos.values())),
    risks: sortByConfidence(Array.from(risks.values())),
    events: sortByConfidence(Array.from(events.values())),
    openQuestions: Array.from(openQuestions.values())
  }
}
