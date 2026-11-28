import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, realpathSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'mocha'

// The proxy as git starts it: lib/worker/gitProxy.js, or gitProxy.ts under tsx.
const here = fileURLToPath(import.meta.url)
const proxy = path.join(path.dirname(here), `gitProxy${path.extname(here)}`)
const node = (args: string[]): string[] => [
  ...(path.extname(here) === '.ts' ? ['--import', 'tsx'] : []),
  proxy,
  ...args,
]

interface Exit {
  code: number | null
  stdout: string
  stderr: string
}

/**
 * Starts the proxy with `args` and leaves its input open, as git does
 * while it reads the answer, after writing `input` to it.
 */
async function run(args: string[], input = ''): Promise<Exit> {
  const child = spawn(process.execPath, node(args), {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  if (input !== '') child.stdin.write(input)
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  return await new Promise<Exit>((resolve) => {
    child.on('exit', (code) => {
      child.stdin.destroy()
      resolve({ code, stdout, stderr })
    })
  })
}

/** A bridge socket that answers each connection's request line with `answer`, then ends. */
async function bridge(
  answer: string,
): Promise<{ socket: string; requests: unknown[]; close: () => void }> {
  const dir = mkdtempSync(
    path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'bridge-'),
  )
  const socket = path.join(dir, 'bridge.sock')
  const requests: unknown[] = []
  const server = net.createServer({ allowHalfOpen: true }, (connection) => {
    let header = ''
    connection.on('data', (chunk: Buffer) => {
      header += chunk.toString()
      const end = header.indexOf('\n')
      if (end < 0 || requests.length > 0) return
      requests.push(JSON.parse(header.slice(0, end)))
      connection.end(answer)
    })
  })
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  return { socket, requests, close: () => server.close() }
}

describe('git proxy', function () {
  this.timeout(20_000)

  it('U7.15 ends by itself once the master has sent everything, while git still holds its input open', async () => {
    const answer = 'x'.repeat(256 * 1024)
    const master = await bridge(answer)
    try {
      const exit = await run([
        'git-upload-pack',
        master.socket,
        'ticket',
        'https://github.com/edgeapp/edge-react-gui.git',
      ])
      assert.equal(exit.code, 0, exit.stderr)
      assert.equal(exit.stdout, answer)
      assert.deepEqual(master.requests, [
        {
          kind: 'upload-pack',
          ticket: 'ticket',
          service: 'git-upload-pack',
          repository: 'https://github.com/edgeapp/edge-react-gui.git',
        },
      ])
    } finally {
      master.close()
    }
  })

  it('U7.15 fails with 128 when the bridge is not there', async () => {
    const dir = mkdtempSync(
      path.join(realpathSync(process.env.MASON_TEST_ROOT!), 'bridge-'),
    )
    const exit = await run([
      'git-upload-pack',
      path.join(dir, 'missing.sock'),
      'ticket',
      'https://github.com/edgeapp/edge-react-gui.git',
    ])
    assert.equal(exit.code, 128)
    assert.match(exit.stderr, /^mason: .*missing\.sock/)
  })

  it('U7.15 the LFS agent ends by itself at terminate, while git-lfs still holds its input open', async () => {
    const exit = await run(
      [
        'lfs',
        '/nonexistent.sock',
        'ticket',
        'https://github.com/edgeapp/edge-react-gui.git',
      ],
      `${JSON.stringify({ event: 'init', operation: 'download' })}\n${JSON.stringify({ event: 'terminate' })}\n`,
    )
    assert.equal(exit.code, 0, exit.stderr)
    assert.equal(exit.stdout, '{}\n')
  })
})
