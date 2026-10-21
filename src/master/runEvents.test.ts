import assert from 'node:assert/strict'
import {
  appendFileSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import express from 'express'
import { after, before, describe, it } from 'mocha'
import { streamRunEvents, streamSnapshots } from './runEvents.js'

interface Event {
  id?: string
  event: string
  data: string
}

/** Reads a server-sent event stream until it ends or `stop` says so. */
async function events(
  url: string,
  headers: Record<string, string>,
  stop: (seen: Event[]) => boolean = () => false,
): Promise<Event[]> {
  return await new Promise((resolve, reject) => {
    const seen: Event[] = []
    const request = http.get(url, { headers }, (response) => {
      let buffer = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        buffer += chunk
        let end
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          if (block.startsWith(':')) continue
          const event: Event = { event: 'message', data: '' }
          for (const line of block.split('\n')) {
            const [field, ...rest] = line.split(': ')
            const value = rest.join(': ')
            if (field === 'id') event.id = value
            else if (field === 'event') event.event = value
            else if (field === 'data') event.data = value
          }
          seen.push(event)
          if (stop(seen)) {
            request.destroy()
            resolve(seen)
            return
          }
        }
      })
      response.on('end', () => resolve(seen))
    })
    request.on('error', (error) =>
      error.message === 'socket hang up' ? resolve([]) : reject(error),
    )
  })
}

describe('Run events', function () {
  this.timeout(30_000)
  let server: http.Server
  let base: string
  let log: string
  const state = {
    status: 'running',
    finished: false,
    stages: [{ name: 'build', status: 'running' }],
  }
  let queue = 'one'
  before(async () => {
    const dir = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'events-'),
    )
    log = path.join(dir, 'build.log')
    writeFileSync(log, 'first\nsecond\npart')
    const app = express()
    app.get('/events', (req, res) => {
      streamRunEvents(
        req,
        res,
        {
          snapshot: (stage) =>
            req.query.gone === '1'
              ? undefined
              : JSON.stringify({ ...state, stage }),
          finished: () => state.finished,
          logFile: () => log,
        },
        {
          logs: req.query.tester !== '1',
          intervalMs: 20,
          ...(req.query.max == null ? {} : { maxMs: Number(req.query.max) }),
        },
      )
    })
    app.get('/queue', (req, res) => {
      streamSnapshots(req, res, 'queue', () => queue, {
        intervalMs: 20,
        maxMs: 2000,
      })
    })
    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve) => server.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  after(() => {
    server.close()
  })
  const stream = { accept: 'text/event-stream' }

  it('U18.3 sends stages, then whole log lines in order with their end offsets, and resumes from the last event ID without gaps or repeats', async () => {
    const first = await events(`${base}/events?stage=build`, stream, (seen) =>
      seen.some((event) => event.event === 'log'),
    )
    assert.equal(first[0]!.event, 'stages')
    assert.equal(JSON.parse(first[0]!.data).stage, 'build')
    const chunk = first.find((event) => event.event === 'log')!
    // The partial last line waits until it is complete.
    assert.deepEqual(JSON.parse(chunk.data), {
      stage: 'build',
      text: 'first\nsecond\n',
      first: 1,
    })
    assert.equal(chunk.id, String(Buffer.byteLength('first\nsecond\n')))
    appendFileSync(log, ' line\nthird\n')
    const resumed = await events(
      `${base}/events?stage=build`,
      { ...stream, 'last-event-id': chunk.id! },
      (seen) => seen.some((event) => event.event === 'log'),
    )
    assert.deepEqual(
      JSON.parse(resumed.find((event) => event.event === 'log')!.data),
      { stage: 'build', text: 'part line\nthird\n', first: 3 },
    )
    // `after` does the same for a page that knows where its log ends.
    const after = await events(
      `${base}/events?stage=build&after=${Buffer.byteLength('first\n')}`,
      stream,
      (seen) => seen.some((event) => event.event === 'log'),
    )
    assert.equal(
      JSON.parse(after.find((event) => event.event === 'log')!.data).first,
      2,
    )
  })

  it('U18.3 sends a stage change when it happens and ends when the run finishes and its log is drained', async () => {
    const seen = events(`${base}/events?stage=build`, stream)
    await new Promise((resolve) => setTimeout(resolve, 100))
    state.stages = [{ name: 'build', status: 'succeeded' }]
    appendFileSync(log, 'tail without newline')
    state.finished = true
    const all = await seen
    const stages = all.filter((event) => event.event === 'stages')
    assert(stages.length >= 2)
    assert.match(stages.at(-1)!.data, /succeeded/)
    assert.match(
      all.filter((event) => event.event === 'log').at(-1)!.data,
      /tail without newline/,
    )
    assert.equal(all.at(-1)!.event, 'end')
  })

  it('U18.3 testers get no log events; a client that does not stream gets one snapshot; a removed run says so', async () => {
    const tester = await events(`${base}/events?stage=build&tester=1`, stream)
    assert.deepEqual(
      tester.map((event) => event.event),
      ['stages', 'end'],
    )
    const once = await events(`${base}/events?stage=build`, {})
    assert.deepEqual(
      once.map((event) => event.event),
      ['stages', 'log', 'end'],
    )
    assert.deepEqual(
      (await events(`${base}/events?gone=1`, stream)).map(
        (event) => event.event,
      ),
      ['gone'],
    )
    state.finished = false
    const limited = await events(`${base}/events?max=50`, stream)
    assert.equal(limited[0]!.event, 'stages')
    assert(!limited.some((event) => event.event === 'end'))
  })

  it('U18.3 streams the queue whenever it changes', async () => {
    const seen = events(`${base}/queue`, stream, (all) => all.length >= 2)
    await new Promise((resolve) => setTimeout(resolve, 60))
    queue = 'two'
    assert.deepEqual(
      (await seen).map((event) => event.data),
      ['one', 'two'],
    )
    assert.deepEqual(
      (await events(`${base}/queue`, {})).map((event) => event.data),
      ['two'],
    )
  })
})
