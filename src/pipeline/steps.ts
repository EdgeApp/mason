/**
 * The step-API channel between a stage runner process and the worker that
 * started it: requests the stage context makes of the worker (stash,
 * artifacts, publish, late outputs, …) and notices it sends (step records,
 * the run description, its result). It runs over Node's IPC channel.
 */

export interface Port {
  send(message: unknown): unknown
  on(event: 'message', listener: (message: unknown) => void): unknown
  off(event: 'message', listener: (message: unknown) => void): unknown
}

type Message =
  | { t: 'req'; id: number; method: string; params: unknown }
  | { t: 'res'; id: number; ok: true; value: unknown }
  | { t: 'res'; id: number; ok: false; error: string }
  | { t: 'note'; type: string; data: unknown }

export type RequestHandler = (
  method: string,
  params: unknown,
) => Promise<unknown> | unknown
export type NoticeHandler = (type: string, data: unknown) => void

export class StepError extends Error {}

export class StepChannel {
  private next = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >()
  private handler: RequestHandler = (method) => {
    throw new StepError(`${method} is not available on this node`)
  }
  private readonly notices = new Set<NoticeHandler>()
  private closed = false
  private readonly listener = (message: unknown): void => {
    this.receive(message as Message)
  }

  constructor(private readonly port: Port) {
    port.on('message', this.listener)
  }

  /** Asks the other side to run `method`; rejects with its error message. */
  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) throw new StepError('The step channel is closed')
    const id = this.next++
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.post({ t: 'req', id, method, params: params ?? null })
    })
  }

  notify(type: string, data?: unknown): void {
    if (!this.closed) this.post({ t: 'note', type, data: data ?? null })
  }

  handle(handler: RequestHandler): void {
    this.handler = handler
  }

  onNotice(handler: NoticeHandler): void {
    this.notices.add(handler)
  }

  /** Rejects every outstanding request and stops listening. */
  close(reason = 'The step channel closed'): void {
    if (this.closed) return
    this.closed = true
    this.port.off('message', this.listener)
    for (const { reject } of this.pending.values())
      reject(new StepError(reason))
    this.pending.clear()
  }

  private post(message: Message): void {
    try {
      this.port.send(message)
    } catch {
      this.close()
    }
  }

  private receive(message: Message): void {
    if (message == null || typeof message !== 'object') return
    if (message.t === 'res') {
      const pending = this.pending.get(message.id)
      if (pending == null) return
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.value)
      else pending.reject(new StepError(message.error))
    } else if (message.t === 'req') {
      const { id } = message
      Promise.resolve()
        .then(async () => await this.handler(message.method, message.params))
        .then(
          (value) => {
            this.post({ t: 'res', id, ok: true, value: value ?? null })
          },
          (error: unknown) => {
            this.post({
              t: 'res',
              id,
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            })
          },
        )
    } else if (message.t === 'note')
      for (const handler of this.notices) handler(message.type, message.data)
  }
}
