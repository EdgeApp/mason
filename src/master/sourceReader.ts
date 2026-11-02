import { Worker } from 'node:worker_threads'
import type { SourceFacts } from '../pipeline/pushTriggers.js'

interface Queued {
  source: string
  resolve: (facts: SourceFacts) => void
}

/**
 * Reads Masonfile sources in a worker thread, one at a time: an input that
 * makes Node's type stripping fail, or that takes longer than `timeoutMs`
 * from when the worker starts it, costs only that worker, which is
 * replaced, and reads as nothing known. Reads queued behind it go on to
 * the next worker.
 */
export class SourceReader {
  private worker: Worker | undefined
  private next = 0
  private readonly queue: Queued[] = []
  private current:
    | ({ id: number; worker: Worker; timer: NodeJS.Timeout } & Queued)
    | undefined

  constructor(public timeoutMs = 5000) {}

  private start(): Worker {
    if (this.worker != null) return this.worker
    const worker = new Worker(
      new URL('../../lib/pipeline/sourceWorker.js', import.meta.url),
      { resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } },
    )
    worker.on(
      'message',
      (message: { id: number; facts?: SourceFacts; failed?: true }) => {
        if (message.failed === true) this.replace(worker)
        else this.finish(message.id, message.facts ?? {})
      },
    )
    worker.on('error', () => this.replace(worker))
    worker.on('exit', () => this.replace(worker))
    this.worker = worker
    return worker
  }

  /** Hands the next queued read to the worker; an idle worker holds no process open. */
  private pump(): void {
    if (this.current != null) return
    const queued = this.queue.shift()
    if (queued == null) {
      this.worker?.unref()
      return
    }
    const worker = this.start()
    worker.ref()
    const id = ++this.next
    const timer = setTimeout(() => this.replace(worker), this.timeoutMs)
    timer.unref()
    this.current = { ...queued, id, worker, timer }
    worker.postMessage({ id, source: queued.source })
  }

  private finish(id: number, facts: SourceFacts): void {
    const current = this.current
    if (current?.id !== id) return
    clearTimeout(current.timer)
    this.current = undefined
    current.resolve(facts)
    this.pump()
  }

  /** Drops a worker that failed or ran too long; its read knows nothing. */
  private replace(worker: Worker): void {
    if (this.worker !== worker) return
    this.worker = undefined
    void worker.terminate()
    if (this.current?.worker === worker) this.finish(this.current.id, {})
  }

  read(source: string): Promise<SourceFacts> {
    return new Promise((resolve) => {
      this.queue.push({ source, resolve })
      this.pump()
    })
  }

  async close(): Promise<void> {
    for (const queued of this.queue.splice(0)) queued.resolve({})
    const worker = this.worker
    if (worker != null) this.replace(worker)
  }
}
