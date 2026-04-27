import { app, type WebContents } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { Worker } from 'worker_threads'
import type {
  SessionQAJobEvent,
  SessionQACancelResult,
  SessionQAStartResult
} from '../../../src/types/ai'
import type { SessionQAOptions } from './aiService'
import { dataManagementService } from '../dataManagementService'

type SessionQAJob = {
  requestId: string
  worker: Worker
  sender: WebContents
  seq: number
}

type SessionQAStartOptions = SessionQAOptions & {
  requestId?: string
}

function createRequestId(): string {
  return `qa-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

class SessionQAJobService {
  private jobs = new Map<string, SessionQAJob>()
  private vectorWarmupJobs = new Map<string, Worker>()

  start(options: SessionQAStartOptions, sender: WebContents): SessionQAStartResult {
    const requestId = options.requestId?.trim() || createRequestId()
    if (this.jobs.has(requestId)) {
      return { success: false, requestId, error: '相同 requestId 的问答任务已存在' }
    }

    const workerPath = this.findWorkerPath()
    if (!workerPath) {
      return { success: false, requestId, error: '未找到 sessionQaWorker.js' }
    }

    const { requestId: _ignored, ...workerOptions } = options
    const worker = new Worker(workerPath, {
      workerData: {
        requestId,
        options: workerOptions
      }
    })

    const job: SessionQAJob = {
      requestId,
      worker,
      sender,
      seq: 0
    }
    this.jobs.set(requestId, job)
    dataManagementService.pauseForAi()
    this.warmupVectorIndex(workerOptions.sessionId)

    worker.on('message', (message) => {
      this.forwardEvent(requestId, message as Partial<SessionQAJobEvent>)
    })

    worker.on('error', (error) => {
      this.forwardEvent(requestId, {
        kind: 'error',
        error: String(error)
      })
      this.jobs.delete(requestId)
    })

    worker.on('exit', (code) => {
      dataManagementService.resumeFromAi()
      const current = this.jobs.get(requestId)
      if (!current) return
      if (code !== 0) {
        this.forwardEvent(requestId, {
          kind: 'error',
          error: `问答任务异常退出，代码：${code}`
        })
      }
      this.jobs.delete(requestId)
    })

    return { success: true, requestId }
  }

  async cancel(requestId: string): Promise<SessionQACancelResult> {
    const job = this.jobs.get(requestId)
    if (!job) {
      return { success: false, requestId, error: '问答任务不存在或已结束' }
    }

    this.jobs.delete(requestId)
    await job.worker.terminate()
    this.send(job, {
      requestId,
      seq: ++job.seq,
      kind: 'cancelled',
      createdAt: Date.now()
    })
    return { success: true, requestId }
  }

  private forwardEvent(requestId: string, event: Partial<SessionQAJobEvent>) {
    const job = this.jobs.get(requestId)
    if (!job) return

    const nextEvent: SessionQAJobEvent = {
      requestId,
      seq: typeof event.seq === 'number' ? event.seq : ++job.seq,
      kind: event.kind || 'error',
      createdAt: typeof event.createdAt === 'number' ? event.createdAt : Date.now(),
      progress: event.progress,
      chunk: event.chunk,
      result: event.result,
      error: event.error
    }

    this.send(job, nextEvent)
    if (nextEvent.kind === 'final' || nextEvent.kind === 'error' || nextEvent.kind === 'cancelled') {
      this.jobs.delete(requestId)
      void job.worker.terminate().catch(() => undefined)
    }
  }

  private send(job: SessionQAJob, event: SessionQAJobEvent) {
    if (job.sender.isDestroyed()) return
    job.sender.send('ai:sessionQaEvent', event)
  }

  private findWorkerPath(): string | null {
    return this.findElectronWorkerPath('sessionQaWorker.js')
  }

  private warmupVectorIndex(sessionId: string) {
    if (!sessionId || this.vectorWarmupJobs.has(sessionId)) return

    const workerPath = this.findElectronWorkerPath('sessionVectorIndexWorker.js')
    if (!workerPath) return

    const worker = new Worker(workerPath, {
      workerData: { sessionId }
    })
    this.vectorWarmupJobs.set(sessionId, worker)
    dataManagementService.pauseForAi()

    worker.on('message', (message: { type?: string; error?: string }) => {
      if (message?.type === 'error') {
        console.warn('[SessionQAJob] 后台语义向量增强失败:', message.error)
      }
    })
    worker.on('error', (error) => {
      console.warn('[SessionQAJob] 后台语义向量增强 Worker 异常:', error)
      this.vectorWarmupJobs.delete(sessionId)
    })
    worker.on('exit', () => {
      dataManagementService.resumeFromAi()
      this.vectorWarmupJobs.delete(sessionId)
    })
  }

  private findElectronWorkerPath(fileName: string): string | null {
    const candidates = app.isPackaged
      ? [
          join(process.resourcesPath, 'app.asar.unpacked', 'dist-electron', fileName),
          join(process.resourcesPath, 'dist-electron', fileName),
          join(__dirname, fileName),
          join(__dirname, '..', '..', fileName),
          join(__dirname, '..', fileName)
        ]
      : [
          join(__dirname, fileName),
          join(__dirname, '..', '..', fileName),
          join(__dirname, '..', fileName),
          join(app.getAppPath(), 'dist-electron', fileName)
        ]

    return candidates.find((candidate) => existsSync(candidate)) || null
  }
}

export const sessionQAJobService = new SessionQAJobService()
