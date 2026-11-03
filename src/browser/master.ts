import { checkNewPassword } from '../auth/passwordProtocol.js'
import type { WorkerRequest, WorkerResponse } from './passwordWorker.js'

/** The few DOM features the master's forms use, so tests can supply them. */
export interface Field {
  value: string
  readOnly?: boolean
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
    /** An invitation form's endpoints: whom the token is for, and using it. */
    lookup?: string
    accept?: string
  }
  addEventListener: (
    type: 'submit',
    listener: (event: { preventDefault: () => void }) => void,
  ) => void
  elements: { namedItem: (name: string) => unknown }
  querySelector: (selector: string) => unknown
}
/** A button that copies the command beside it (`data-copy`). */
export interface CopyButton {
  dataset: { copy?: string }
  addEventListener: (type: 'click', listener: () => void) => void
  querySelector: (selector: string) => unknown
}
export interface PageDocument {
  querySelectorAll: (selector: string) => Iterable<unknown>
  querySelector: (selector: string) => unknown
}
export interface PageDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  hash: (request: WorkerRequest) => Promise<WorkerResponse>
  assign: (url: string) => void
  /** Puts text on the clipboard. */
  copy: (text: string) => Promise<void>
  /** The page address's fragment, without the `#`: an invitation's token. */
  fragment: () => string
  /** Takes the fragment out of the address and the history, once read. */
  forgetFragment: () => void
}

const field = (form: Form, name: string): string =>
  (form.elements.namedItem(name) as Field | null)?.value ?? ''
const output = (form: Form, name: string): Output | undefined =>
  (form.querySelector(`[data-field="${name}"]`) as Output | null) ?? undefined

/** A new password, typed twice, that meets the password rules. */
function newPassword(form: Form): string {
  const password = field(form, 'password')
  if (password !== field(form, 'confirm'))
    throw new Error('The passwords do not match')
  checkNewPassword(password)
  return password
}

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

/** Wires the master's forms: sign-in, first-run setup, restore, backups, sign-out and invitations. */
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
    invite: async (form) => {
      const password = newPassword(form)
      const { clientHash, clientParameters } = await hashed({
        kind: 'new',
        password,
      })
      const accepted = await call('POST', form.dataset.accept ?? '', {
        token: invitationToken(),
        username: field(form, 'username'),
        clientHash,
        clientParameters,
      })
      if (!accepted.ok) throw new Error(await failure(accepted))
      deps.assign(form.dataset.return ?? '/')
    },
  }
  /** Says whom an invitation is for, and keeps a username they already have. */
  // An invitation's token is read once, then dropped from the address bar
  // and history, so it is not left on screen or in a bookmark.
  let token: string | undefined
  const invitationToken = (): string => {
    if (token == null) {
      token = deps.fragment()
      if (token !== '') deps.forgetFragment()
    }
    return token
  }
  const welcome = async (form: Form): Promise<void> => {
    const shown = output(form, 'welcome')
    if (invitationToken() === '')
      throw new Error('This invitation link is incomplete: copy all of it')
    const found = await call('POST', form.dataset.lookup ?? '', {
      token: invitationToken(),
    })
    if (!found.ok) throw new Error(await failure(found))
    const person = (await found.json()) as { name: string; username?: string }
    if (shown != null)
      shown.textContent = `Welcome, ${person.name}. Choose a password${person.username == null ? ' and a username' : ''} to sign in to Mason.`
    const username = form.elements.namedItem('username') as Field | null
    if (username != null && person.username != null) {
      username.value = person.username
      username.readOnly = true
    }
  }
  for (const button of doc.querySelectorAll(
    'button[data-copy]',
  ) as Iterable<CopyButton>) {
    const label = button.querySelector('[data-copy-label]') as Output | null
    button.addEventListener('click', () => {
      deps.copy(button.dataset.copy ?? '').then(
        () => {
          if (label != null) label.textContent = 'Copied'
        },
        () => {
          if (label != null) label.textContent = 'Select and copy'
        },
      )
    })
  }
  for (const form of doc.querySelectorAll(
    'form[data-mason]',
  ) as Iterable<Form>) {
    const action = actions[form.dataset.mason ?? '']
    if (action == null) continue
    if (form.dataset.mason === 'invite')
      welcome(form).catch((error: unknown) => {
        const status = output(form, 'status')
        if (status != null) {
          status.textContent = (error as Error).message
          status.hidden = false
        }
      })
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
  navigator?: { clipboard?: { writeText: (text: string) => Promise<void> } }
  Worker?: new (url: string, options: { type: 'module' }) => never
  location?: {
    assign: (url: string) => void
    hash: string
    pathname: string
    search: string
  }
  history?: {
    replaceState: (data: unknown, unused: string, url: string) => void
  }
}
// Only in a browser page: a test importing this module calls `start` itself.
if (page.document != null && page.Worker != null)
  start(page.document, {
    fetch: async (url, init) => await fetch(url, init),
    hash: workerHash(
      new page.Worker('/assets/password-worker.js', { type: 'module' }),
    ),
    assign: (url) => page.location!.assign(url),
    copy: async (text) => {
      if (page.navigator?.clipboard == null)
        throw new Error('No clipboard on this page')
      await page.navigator.clipboard.writeText(text)
    },
    fragment: () => page.location!.hash.replace(/^#/, ''),
    forgetFragment: () => {
      page.history?.replaceState(
        null,
        '',
        page.location!.pathname + page.location!.search,
      )
    },
  })
