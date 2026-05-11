/**
 * WCDB Worker —— 在独立 worker_threads 中运行 WcdbCore。
 * 主进程通过 postMessage({ id, type, payload }) 下发请求；
 * 本 Worker 按 type 路由到 WcdbCore 对应方法，并通过 postMessage({ id, result } | { id, error }) 回复。
 *
 * 约定：
 * - id === 0 && type === 'ready' 为启动就绪信号（由 Worker 主动发出）
 * - id === -1 && type === 'monitor' 为 native pipe 的变更上行事件
 */
import { parentPort } from 'worker_threads'
import { WcdbCore } from './services/wcdbCore'

if (!parentPort) {
  throw new Error('wcdbWorker 必须在 worker_threads 中运行')
}

const core = new WcdbCore()
let monitorRegistered = false

parentPort.on('message', async (msg: any) => {
  const { id, type, payload } = msg || {}
  try {
    let result: any
    switch (type) {
      case 'setPaths':
        core.setPaths(payload.resourcesPath, payload.userDataPath)
        result = { success: true }
        break
      case 'testConnection':
        result = await core.testConnection(payload.dbPath, payload.hexKey, payload.wxid)
        break
      case 'open':
        result = await core.open(payload.dbPath, payload.hexKey, payload.wxid)
        break
      case 'close':
        core.close()
        result = { success: true }
        break
      case 'shutdown':
        core.shutdown()
        result = { success: true }
        break
      case 'isConnected':
        result = core.isConnected()
        break
      case 'execQuery':
        result = await core.execQuery(payload.kind, payload.path, payload.sql)
        break
      case 'execQueryWithParams':
        result = await core.execQueryWithParams(payload.kind, payload.path, payload.sql, payload.params)
        break
      case 'getSnsTimeline':
        result = await core.getSnsTimeline(
          payload.limit,
          payload.offset,
          payload.usernames,
          payload.keyword,
          payload.startTime,
          payload.endTime
        )
        break
      case 'getNativeMessages':
        result = await core.getNativeMessages(payload.sessionId, payload.limit, payload.offset)
        break
      case 'openMessageCursor':
        result = await core.openMessageCursor(
          payload.sessionId,
          payload.batchSize,
          payload.ascending,
          payload.beginTimestamp,
          payload.endTimestamp
        )
        break
      case 'openMessageCursorLite':
        result = await core.openMessageCursorLite(
          payload.sessionId,
          payload.batchSize,
          payload.ascending,
          payload.beginTimestamp,
          payload.endTimestamp
        )
        break
      case 'fetchMessageBatch':
        result = await core.fetchMessageBatch(payload.cursor)
        break
      case 'getMessageBatchViaCursor':
        result = await core.getMessageBatchViaCursor(
          payload.sessionId,
          payload.batchSize,
          payload.ascending,
          payload.beginTimestamp,
          payload.endTimestamp,
          payload.useLite,
          payload.maxBatches
        )
        break
      case 'closeMessageCursor':
        result = await core.closeMessageCursor(payload.cursor)
        break
      case 'setMonitor':
        if (!monitorRegistered) {
          monitorRegistered = core.setMonitor((t, j) => {
            parentPort!.postMessage({ id: -1, type: 'monitor', payload: { type: t, json: j } })
          })
        }
        result = { success: monitorRegistered }
        break
      case 'stopMonitor':
        core.stopMonitor()
        monitorRegistered = false
        result = { success: true }
        break
      default:
        result = { success: false, error: `unknown type: ${type}` }
    }
    parentPort!.postMessage({ id, result })
  } catch (e: any) {
    parentPort!.postMessage({ id, error: e?.message || String(e) })
  }
})

parentPort.postMessage({ id: 0, type: 'ready' })
