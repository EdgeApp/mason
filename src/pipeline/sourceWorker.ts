// The master's worker for reading Masonfile sources: Node's type stripping
// can fail for the rest of a thread, so it never runs on the master's own.
import { isMainThread, parentPort } from 'node:worker_threads'
import { readSource } from './pushTriggers.js'

if (!isMainThread)
  parentPort!.on('message', (message: { id: number; source: string }) => {
    try {
      parentPort!.postMessage({
        id: message.id,
        facts: readSource(message.source),
      })
    } catch {
      parentPort!.postMessage({ id: message.id, failed: true })
    }
  })
