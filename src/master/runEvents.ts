import { closeSync, openSync, readSync, statSync } from 'node:fs'
import type express from 'express'

/** What a run's event stream reads. */
export interface RunEventSource {
  /** The run's status, stages and the selected stage's steps, as JSON; undefined when the run is gone. */
  snapshot: (stage: string | undefined) => string | undefined
  /** Whether the run has finished. */
  finished: () => boolean
  /** The selected stage's log file. */
  logFile: (stage: string) => string
}

/** Bytes of a file from `start` to `end`. */
function read(file: string, start: number, end: number): Buffer {
  const out = Buffer.alloc(end - start)
  const fd = openSync(file, 'r')
  try {
    let at = 0
    while (at < out.length) {
      const got = readSync(fd, out, at, out.length - at, start + at)
      if (got === 0) break
      at += got
    }
    return out.subarray(0, at)
  } finally {
    closeSync(fd)
  }
}

/** Newlines in the first `end` bytes of a file, so a resumed stream numbers its lines. */
function linesBefore(file: string, end: number): number {
  if (end <= 0) return 0
  let count = 0
  for (const byte of read(file, 0, end)) if (byte === 0x0a) count++
  return count
}

/**
 * A run's Server-Sent Events: `stages` whenever its status, stages or the
 * selected stage's steps change; `log` with the selected stage's new
 * complete lines, each event's ID the byte offset it ends at, so a
 * reconnect sending `Last-Event-ID` resumes without gaps or repeats; and
 * `end` once the run has finished and its log is drained. `logs: false`
 * (testers) sends no log events. A client that does not accept
 * `text/event-stream` gets one snapshot and the log so far.
 */
export function streamRunEvents(
  req: express.Request,
  res: express.Response,
  source: RunEventSource,
  options: {
    logs: boolean
    intervalMs?: number
    maxMs?: number
    now?: () => number
  },
): void {
  const stage =
    typeof req.query.stage === 'string' && req.query.stage !== ''
      ? req.query.stage
      : undefined
  const resume = Number(req.get('last-event-id') ?? req.query.after ?? 0)
  let offset = Number.isSafeInteger(resume) && resume > 0 ? resume : 0
  const file = stage == null ? undefined : source.logFile(stage)
  let line = file == null || offset === 0 ? 1 : linesBefore(file, offset) + 1
  const now = options.now ?? Date.now
  const until = now() + (options.maxMs ?? 15 * 60_000)
  const streaming = (req.get('accept') ?? '').includes('text/event-stream')
  res.status(200)
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  let last: string | undefined
  let beat = now()
  let timer: NodeJS.Timeout | undefined
  const stop = (): void => {
    clearTimeout(timer)
    if (!res.writableEnded) res.end()
  }
  req.on('close', stop)
  const tick = (): void => {
    if (res.writableEnded) return
    const snapshot = source.snapshot(stage)
    if (snapshot == null) {
      res.write('event: gone\ndata: {}\n\n')
      stop()
      return
    }
    const finished = source.finished()
    if (snapshot !== last) {
      last = snapshot
      res.write(`event: stages\ndata: ${snapshot}\n\n`)
    }
    let drained = true
    if (options.logs && file != null) {
      const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0
      if (size > offset) {
        const chunk = read(file, offset, size)
        // Whole lines only, unless the run is over and nothing more will come.
        const end = finished ? chunk.length : chunk.lastIndexOf(0x0a) + 1
        if (end > 0) {
          const text = chunk.subarray(0, end).toString('utf8')
          res.write(
            `id: ${offset + end}\nevent: log\ndata: ${JSON.stringify({ stage, text, first: line })}\n\n`,
          )
          offset += end
          line += text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
        }
        drained = offset >= size
      }
    }
    if (finished && drained) {
      res.write('event: end\ndata: {}\n\n')
      stop()
      return
    }
    if (now() >= until || !streaming) {
      // The browser reconnects with its last event ID; a client that did
      // not ask for a stream gets what there is now.
      stop()
      return
    }
    if (now() - beat >= 15_000) {
      beat = now()
      res.write(': keep-alive\n\n')
    }
    timer = setTimeout(tick, options.intervalMs ?? 500)
  }
  tick()
}

/** A snapshot of a value whenever it changes, as `event: <name>` until the client leaves. */
export function streamSnapshots(
  req: express.Request,
  res: express.Response,
  name: string,
  snapshot: () => string,
  options: { intervalMs?: number; maxMs?: number; now?: () => number } = {},
): void {
  const now = options.now ?? Date.now
  const until = now() + (options.maxMs ?? 15 * 60_000)
  const streaming = (req.get('accept') ?? '').includes('text/event-stream')
  res.status(200)
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  let last: string | undefined
  let timer: NodeJS.Timeout | undefined
  const stop = (): void => {
    clearTimeout(timer)
    if (!res.writableEnded) res.end()
  }
  req.on('close', stop)
  const tick = (): void => {
    if (res.writableEnded) return
    const value = snapshot()
    if (value !== last) {
      last = value
      res.write(`event: ${name}\ndata: ${value}\n\n`)
    }
    if (now() >= until || !streaming) {
      stop()
      return
    }
    timer = setTimeout(tick, options.intervalMs ?? 1000)
  }
  tick()
}
