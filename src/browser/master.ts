import type { WorkerRequest, WorkerResponse } from './passwordWorker.js'

/** The few DOM features the master's forms use, so tests can supply them. */
export interface Field {
  value: string
  files?: { length: number; 0?: { text: () => Promise<string> } } | null
}
export interface Output {
  textContent: string | null
  hidden: boolean
}
export interface Form {
  /** `mason` names the action; a host's sign-in form also names its endpoints and where to go after. */
  dataset: {
    mason?: string
    parameters?: string
    session?: string
    return?: string
  }
  addEventListener: (
    type: 'submit',
    listener: (event: { preventDefault: () => void }) => void,
  ) => void
  elements: { namedItem: (name: string) => unknown }
  querySelector: (selector: string) => unknown
}
export interface PageDocument {
  querySelectorAll: (selector: string) => Iterable<Form>
  querySelector: (selector: string) => unknown
}
export interface PageDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  hash: (request: WorkerRequest) => Promise<WorkerResponse>
  assign: (url: string) => void
}

const field = (form: Form, name: string): string =>
  (form.elements.namedItem(name) as Field | null)?.value ?? ''
const output = (form: Form, name: string): Output | undefined =>
  (form.querySelector(`[data-field="${name}"]`) as Output | null) ?? undefined

/** A refusal's message, with when to retry when the master says. */
async function failure(response: Response): Promise<string> {
  const body = (await response.json().catch(() => ({}))) as {
    error?: string
    retryAt?: number
  }
  const message = body.error ?? `Request failed (${response.status})`
  if (body.retryAt == null) return message
  return `${message}. Try again at ${new Date(body.retryAt).toLocaleTimeString()}.`
}

/** Wires the master's forms: sign-in, first-run setup, restore, backups and sign-out. */
export function start(doc: PageDocument, deps: PageDeps): void {
  const csrf =
    (
      doc.querySelector('meta[name="mason-csrf"]') as {
        content?: string
      } | null
    )?.content ?? ''
  const call = async (
    method: string,
    url: string,
    body?: unknown,
  ): Promise<Response> =>
    await deps.fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        ...(csrf === '' ? {} : { 'x-mason-csrf': csrf }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  const hashed = async (
    request: WorkerRequest,
  ): Promise<{ clientHash: string; clientParameters?: unknown }> => {
    const answer = await deps.hash(request)
    if ('error' in answer) throw new Error(answer.error)
    return answer
  }
  const actions: Record<string, (form: Form) => Promise<void>> = {
    'sign-in': async (form) => {
      const username = field(form, 'username')
      const parameters = await call(
        'POST',
        form.dataset.parameters ?? '/api/v2/session/parameters',
        { username },
      )
      if (!parameters.ok) throw new Error(await failure(parameters))
      const { clientHash } = await hashed({
        kind: 'hash',
        password: field(form, 'password'),
        parameters: (await parameters.json()) as never,
      })
      const signedIn = await call(
        'POST',
        form.dataset.session ?? '/api/v2/session',
        { username, clientHash },
      )
      if (!signedIn.ok) throw new Error(await failure(signedIn))
      deps.assign(form.dataset.return ?? '/')
    },
    setup: async (form) => {
      const { clientHash, clientParameters } = await hashed({
        kind: 'new',
        password: field(form, 'password'),
      })
      const created = await call('POST', '/api/setup', {
        code: field(form, 'code'),
        username: field(form, 'username'),
        clientHash,
        clientParameters,
      })
      if (!created.ok) throw new Error(await failure(created))
      deps.assign('/backups')
    },
    restore: async (form) => {
      const files = (form.elements.namedItem('key') as Field | null)?.files
      const key = files?.[0] == null ? '' : await files[0].text()
      const restored = await call('POST', '/api/setup/restore', {
        code: field(form, 'code'),
        repository: field(form, 'repository'),
        key: key.trim(),
        ...(field(form, 'date') === '' ? {} : { date: field(form, 'date') }),
      })
      if (!restored.ok) throw new Error(await failure(restored))
      deps.assign('/sign-in')
    },
    backup: async (form) => {
      const saved = await call('PUT', '/api/v2/settings/backup', {
        repository: field(form, 'repository'),
        branch: field(form, 'branch'),
      })
      if (!saved.ok) throw new Error(await failure(saved))
      const value = (await saved.json()) as {
        deployKey?: string
        backupKey?: string
      }
      for (const name of ['deployKey', 'backupKey'] as const) {
        const target = output(form, name)
        if (target != null && value[name] != null) {
          target.textContent = value[name]
          target.hidden = false
        }
      }
    },
    'backup-confirm': async () => {
      const confirmed = await call('POST', '/api/v2/settings/backup/confirm', {
        stored: true,
      })
      if (!confirmed.ok) throw new Error(await failure(confirmed))
      deps.assign('/')
    },
    'sign-out': async () => {
      await call('DELETE', '/api/v2/session')
      deps.assign('/sign-in')
    },
  }
  for (const form of doc.querySelectorAll('form[data-mason]')) {
    const action = actions[form.dataset.mason ?? '']
    if (action == null) continue
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const status = output(form, 'status')
      if (status != null) {
        status.textContent = 'Working…'
        status.hidden = false
      }
      action(form).then(
        () => {
          if (status != null) status.textContent = ''
        },
        (error: unknown) => {
          if (status != null) status.textContent = (error as Error).message
        },
      )
    })
  }
}

/** The password worker, one request at a time. */
export function workerHash(worker: {
  postMessage: (message: WorkerRequest) => void
  onmessage: ((event: { data: WorkerResponse }) => void) | null
}): (request: WorkerRequest) => Promise<WorkerResponse> {
  let queue = Promise.resolve<unknown>(undefined)
  return async (request) => {
    const answer = queue.then(
      async () =>
        await new Promise<WorkerResponse>((resolve) => {
          worker.onmessage = (event): void => {
            resolve(event.data)
          }
          worker.postMessage(request)
        }),
    )
    queue = answer
    return await answer
  }
}

const page = globalThis as unknown as {
  document?: PageDocument
  Worker?: new (url: string, options: { type: 'module' }) => never
  location?: { assign: (url: string) => void }
}
// Only in a browser page: a test importing this module calls `start` itself.
if (page.document != null && page.Worker != null)
  start(page.document, {
    fetch: async (url, init) => await fetch(url, init),
    hash: workerHash(
      new page.Worker('/assets/password-worker.js', { type: 'module' }),
    ),
    assign: (url) => page.location!.assign(url),
  })
