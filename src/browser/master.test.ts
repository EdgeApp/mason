import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { clientPasswordHash } from '../auth/passwordKdf.js'
import {
  clientParameters,
  DEFAULT_PASSWORD_COSTS,
} from '../auth/passwordProtocol.js'
import {
  start,
  workerHash,
  type CopyButton,
  type Form,
  type Output,
  type PageDeps,
} from './master.js'
import { respond, type WorkerRequest } from './passwordWorker.js'

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r))
}

/** A form with named fields and outputs, and its submit listener. */
function form(
  kind: string,
  fields: Record<string, unknown>,
): Form & { submit: () => void; outputs: Record<string, Output> } {
  let listener: ((event: { preventDefault: () => void }) => void) | undefined
  const outputs: Record<string, Output> = {
    status: { textContent: '', hidden: true },
    deployKey: { textContent: '', hidden: true },
    backupKey: { textContent: '', hidden: true },
  }
  return {
    dataset: { mason: kind },
    addEventListener: (_type, fn): void => {
      listener = fn
    },
    elements: { namedItem: (name) => fields[name] ?? null },
    querySelector: (selector) =>
      outputs[/data-field="([^"]+)"/.exec(selector)?.[1] ?? ''] ?? null,
    submit: (): void => {
      listener!({ preventDefault: () => undefined })
    },
    outputs,
  }
}

function page(
  forms: Form[],
  replies: Record<string, { status: number; body: unknown }>,
  csrf = 'proof',
): {
  deps: PageDeps
  calls: Array<{ url: string; init: RequestInit }>
  visits: string[]
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const visits: string[] = []
  const deps: PageDeps = {
    fetch: async (url, init) => {
      calls.push({ url, init })
      const reply = replies[`${init.method} ${url}`] ?? {
        status: 500,
        body: 'not json',
      }
      return new Response(
        typeof reply.body === 'string'
          ? reply.body
          : JSON.stringify(reply.body),
        { status: reply.status },
      )
    },
    hash: async (request) =>
      request.password === 'boom'
        ? { error: 'Could not hash' }
        : {
            clientHash: `hash-of-${request.password}`,
            ...(request.kind === 'new'
              ? { clientParameters: { p: 1 } as never }
              : {}),
          },
    assign: (url) => visits.push(url),
    copy: async () => undefined,
  }
  start(
    {
      querySelectorAll: (selector) =>
        selector.startsWith('form') ? forms : [],
      querySelector: () => (csrf === '' ? null : { content: csrf }),
    },
    deps,
  )
  return { deps, calls, visits }
}
const body = (init: RequestInit): unknown => JSON.parse(String(init.body))

describe('Master page script', () => {
  it('signs in with the client hash of the account’s parameters, never the password', async () => {
    const signIn = form('sign-in', {
      username: { value: 'paul' },
      password: { value: 'Correct-Horse-9' },
    })
    const { calls, visits } = page([signIn], {
      'POST /api/v2/session/parameters': { status: 200, body: { salt: 's' } },
      'POST /api/v2/session': { status: 200, body: { role: 'admin' } },
    })
    signIn.submit()
    assert.equal(signIn.outputs.status!.textContent, 'Working…')
    await settle()
    assert.deepEqual(body(calls[1]!.init), {
      username: 'paul',
      clientHash: 'hash-of-Correct-Horse-9',
    })
    assert(!JSON.stringify(calls).includes('"Correct-Horse-9"'))
    assert.equal(
      (calls[0]!.init.headers as Record<string, string>)['x-mason-csrf'],
      'proof',
    )
    assert.deepEqual(visits, ['/'])
    assert.equal(signIn.outputs.status!.textContent, '')
  })

  it('signs in on a host through the endpoints its form names, and returns where it was going', async () => {
    const signIn = form('sign-in', {
      username: { value: 'tess' },
      password: { value: 'Tess-Horse-9' },
    })
    Object.assign(signIn.dataset, {
      parameters: '/auth/password/parameters',
      session: '/auth/password',
      return: '/apps/3',
    })
    const { calls, visits } = page([signIn], {
      'POST /auth/password/parameters': { status: 200, body: { salt: 's' } },
      'POST /auth/password': { status: 200, body: { signedIn: true } },
    })
    signIn.submit()
    await settle()
    assert.deepEqual(
      calls.map((call) => call.url),
      ['/auth/password/parameters', '/auth/password'],
    )
    assert.deepEqual(body(calls[1]!.init), {
      username: 'tess',
      clientHash: 'hash-of-Tess-Horse-9',
    })
    assert.deepEqual(visits, ['/apps/3'])
  })

  it('shows a refusal with when to try again', async () => {
    const signIn = form('sign-in', {
      username: { value: 'paul' },
      password: { value: 'x' },
    })
    page(
      [signIn],
      {
        'POST /api/v2/session/parameters': { status: 200, body: {} },
        'POST /api/v2/session': {
          status: 429,
          body: { error: 'Too many failed sign-ins', retryAt: 0 },
        },
      },
      '',
    )
    signIn.submit()
    await settle()
    assert.match(
      signIn.outputs.status!.textContent!,
      /Too many failed sign-ins\. Try again at/,
    )
    const failing = form('sign-in', {
      username: { value: 'p' },
      password: { value: 'x' },
    })
    page([failing], {})
    failing.submit()
    await settle()
    assert.equal(failing.outputs.status!.textContent, 'Request failed (500)')
    const broken = form('sign-in', {
      username: { value: 'p' },
      password: { value: 'boom' },
    })
    page([broken], {
      'POST /api/v2/session/parameters': { status: 200, body: {} },
    })
    broken.submit()
    await settle()
    assert.equal(broken.outputs.status!.textContent, 'Could not hash')
  })

  it('creates the first account with a new client hash and moves to backups', async () => {
    const setup = form('setup', {
      code: { value: '123456' },
      username: { value: 'owner' },
      password: { value: 'Owner-Horse-9' },
    })
    const { calls, visits } = page([setup], {
      'POST /api/setup': { status: 201, body: {} },
    })
    setup.submit()
    await settle()
    assert.deepEqual(body(calls[0]!.init), {
      code: '123456',
      username: 'owner',
      clientHash: 'hash-of-Owner-Horse-9',
      clientParameters: { p: 1 },
    })
    assert.deepEqual(visits, ['/backups'])
    const refused = form('setup', {
      code: { value: '1' },
      username: { value: 'o' },
      password: { value: 'p' },
    })
    page([refused], {
      'POST /api/setup': { status: 429, body: { error: 'Wait', retryAt: 1 } },
    })
    refused.submit()
    await settle()
    assert.match(refused.outputs.status!.textContent!, /^Wait\. Try again at/)
  })

  it('restores from a key file and a date, and configures backups showing the keys', async () => {
    const restore = form('restore', {
      code: { value: '123456' },
      repository: { value: 'git@github.com:o/b.git' },
      key: {
        files: {
          length: 1,
          0: { text: async () => ' mason-backup-key-v1:abc \n' },
        },
      },
      date: { value: '2026-10-01' },
    })
    const backup = form('backup', {
      repository: { value: 'git@github.com:o/b.git' },
      branch: { value: 'master' },
    })
    const confirm = form('backup-confirm', {})
    const signOut = form('sign-out', {})
    const unknown = form('nothing', {})
    const { calls, visits } = page(
      [restore, backup, confirm, signOut, unknown],
      {
        'POST /api/setup/restore': { status: 202, body: { restart: true } },
        'PUT /api/v2/settings/backup': {
          status: 200,
          body: {
            deployKey: 'ssh-ed25519 AAA',
            backupKey: 'mason-backup-key-v1:k',
          },
        },
        'POST /api/v2/settings/backup/confirm': { status: 200, body: {} },
        'DELETE /api/v2/session': { status: 200, body: null },
      },
    )
    restore.submit()
    backup.submit()
    confirm.submit()
    signOut.submit()
    await settle()
    assert.deepEqual(
      body(calls.find((call) => call.url === '/api/setup/restore')!.init),
      {
        code: '123456',
        repository: 'git@github.com:o/b.git',
        key: 'mason-backup-key-v1:abc',
        date: '2026-10-01',
      },
    )
    assert.equal(backup.outputs.deployKey!.textContent, 'ssh-ed25519 AAA')
    assert.equal(backup.outputs.deployKey!.hidden, false)
    assert.equal(backup.outputs.backupKey!.textContent, 'mason-backup-key-v1:k')
    assert.deepEqual(visits.sort(), ['/', '/sign-in', '/sign-in'])
    // Failures stay on the page.
    const bad = form('restore', {
      code: { value: '1' },
      repository: { value: 'r' },
      key: { files: null },
      date: { value: '' },
    })
    const badBackup = form('backup', {
      repository: { value: 'x' },
      branch: { value: 'm' },
    })
    const badConfirm = form('backup-confirm', {})
    page([bad, badBackup, badConfirm], {})
    bad.submit()
    badBackup.submit()
    badConfirm.submit()
    await settle()
    for (const each of [bad, badBackup, badConfirm])
      assert.equal(each.outputs.status!.textContent, 'Request failed (500)')
  })

  it('copies a command from its button and says whether it worked', async () => {
    const button = (
      copy: string,
    ): CopyButton & { click: () => void; label: Output } => {
      let listener: (() => void) | undefined
      const label: Output = { textContent: 'Copy', hidden: false }
      return {
        dataset: { copy },
        addEventListener: (_type, fn): void => {
          listener = fn
        },
        querySelector: (selector) =>
          selector === '[data-copy-label]' ? label : null,
        click: (): void => {
          listener!()
        },
        label,
      }
    }
    const good = button('sudo mason worker --install --link-port 9410')
    const bad = button('refused')
    const copied: string[] = []
    start(
      {
        querySelectorAll: (selector) =>
          selector === 'button[data-copy]' ? [good, bad] : [],
        querySelector: () => null,
      },
      {
        fetch: async () => new Response('{}'),
        hash: async () => ({ error: 'unused' }),
        assign: () => undefined,
        copy: async (text) => {
          if (text === 'refused') throw new Error('No clipboard')
          copied.push(text)
        },
      },
    )
    good.click()
    bad.click()
    await settle()
    assert.deepEqual(copied, ['sudo mason worker --install --link-port 9410'])
    assert.equal(good.label.textContent, 'Copied')
    assert.equal(bad.label.textContent, 'Select and copy')
  })

  it('passes requests to the password worker one at a time', async () => {
    const worker = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      seen: [] as WorkerRequest[],
      postMessage(message: WorkerRequest): void {
        this.seen.push(message)
        setImmediate(() =>
          this.onmessage?.({ data: { clientHash: message.password } }),
        )
      },
    }
    const hash = workerHash(worker as never)
    const [a, b] = await Promise.all([
      hash({ kind: 'new', password: 'one' }),
      hash({ kind: 'new', password: 'two' }),
    ])
    assert.deepEqual([a, b], [{ clientHash: 'one' }, { clientHash: 'two' }])
    assert.equal(worker.seen.length, 2)
  })
})

describe('Password worker', function () {
  this.timeout(60_000)
  it('computes the protocol’s client hash for an account’s parameters', async () => {
    const parameters = clientParameters('ab'.repeat(16), DEFAULT_PASSWORD_COSTS)
    const answer = await respond({
      kind: 'hash',
      password: 'Correct-Horse-9',
      parameters,
    })
    assert.deepEqual(answer, {
      clientHash: await clientPasswordHash('Correct-Horse-9', parameters),
    })
  })

  it('calibrates a new password’s costs and gives it a random salt', async () => {
    const seen: number[] = []
    const answer = await respond(
      { kind: 'new', password: 'Owner-Horse-9' },
      (bytes) => bytes.fill(7),
      async (_password, parameters) => {
        seen.push(parameters.iterations)
        await new Promise((resolve) => setTimeout(resolve, 5))
        return 'ab'.repeat(32)
      },
    )
    assert('clientParameters' in answer, JSON.stringify(answer))
    assert.equal(answer.clientParameters!.salt, '07'.repeat(16))
    // About three seconds of hashing when the baseline took about 5 ms.
    assert(
      answer.clientParameters!.iterations > DEFAULT_PASSWORD_COSTS.iterations,
    )
    assert.equal(seen[1], answer.clientParameters!.iterations)
    assert.equal(answer.clientHash, 'ab'.repeat(32))
    assert.deepEqual(
      await respond({
        kind: 'hash',
        password: 'x'.repeat(2000),
        parameters: clientParameters('ab'.repeat(16)),
      }),
      { error: 'Password is too long' },
    )
  })
})
