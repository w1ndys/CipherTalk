import { parentPort, workerData } from 'worker_threads'
import { chatSearchIndexService } from './services/search/chatSearchIndexService'

type VectorWorkerData = {
  sessionId: string
}

const data = workerData as VectorWorkerData

parentPort?.on('message', (message: { type?: string }) => {
  if (message?.type === 'cancel') {
    chatSearchIndexService.cancelSessionVectorIndex(data.sessionId)
  }
})

async function run() {
  try {
    const state = await chatSearchIndexService.prepareSessionVectorIndex(data.sessionId, (progress) => {
      parentPort?.postMessage({
        type: 'progress',
        sessionId: data.sessionId,
        progress
      })
    })
    parentPort?.postMessage({
      type: 'completed',
      sessionId: data.sessionId,
      state
    })
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      sessionId: data.sessionId,
      error: String(error)
    })
  }
}

void run()
