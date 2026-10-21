import type express from 'express'
import { cookie } from '../auth/routes.js'
import { testBanner, type WebAppContext } from '../node/webApp.js'
import { escape } from '../view.js'
import { MASTER_SESSION_COOKIE, type MasterSession } from './auth.js'
import { can } from './permissions.js'
import { sessionActor } from './auth.js'
import type { Master } from './runtime.js'

/** A master page: the base styles, the forms script, and the banners that apply. */
function masterPage(
  context: WebAppContext,
  master: Master,
  title: string,
  content: string,
  session?: MasterSession,
): string {
  const notice = master.configured() ? master.backups.notice() : undefined
  const banner =
    notice == null
      ? ''
      : `<p class="notice" role="alert">${escape(notice)}. <a href="/backups">Backups</a></p>`
  const navigation =
    session == null
      ? ''
      : `<span>${escape(session.name)} · ${escape(session.role)}</span><form method="post" data-mason="sign-out"><button class="secondary">Sign out</button></form>`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Mason</title>${session == null ? '' : `<meta name="mason-csrf" content="${escape(session.csrf)}">`}<link rel="stylesheet" href="/assets/style.css"><script type="module" src="/assets/master.js"></script></head><body><header><a class="brand" href="/">Mason<span>Build master</span></a><nav>${navigation}</nav></header><main>${testBanner(context)}${banner}<h1>${escape(title)}</h1>${content}</main></body></html>`
}

const status = '<p class="notice" role="status" data-field="status" hidden></p>'

const setupPage = `<section class="card"><h2>Create the first account</h2><p>Enter the six-digit setup code this master printed in its terminal when it started. The first account is an administrator.</p><form data-mason="setup"><label for="code">Setup code</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" required><p><button>Create account</button></p>${status}</form></section><section class="card"><h2>Restore from a backup</h2><p>Rebuild this master from its encrypted git backup instead.</p><form data-mason="restore"><label for="restore-code">Setup code</label><input id="restore-code" name="code" inputmode="numeric" pattern="[0-9]{6}" required><label for="repository">Backup repository</label><input id="repository" name="repository" placeholder="git@github.com:owner/mason-backup.git" required><label for="key">Backup key file</label><input id="key" name="key" type="file" required><label for="date">Date (optional, YYYY-MM-DD)</label><input id="date" name="date" pattern="\\d{4}-\\d{2}-\\d{2}"><p><button class="secondary">Restore</button></p>${status}</form></section>`

const signInPage = `<section class="card"><form data-mason="sign-in"><label for="username">Username</label><input id="username" name="username" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><p><button>Sign in</button></p>${status}</form></section>`

function backupsPage(master: Master, session: MasterSession): string {
  const actor = sessionActor(session)
  const backups = master.backups.status()
  const value = (master.settings.value('backup') ?? {}) as {
    repository?: string
    branch?: string
    deployKey?: { publicKey: string }
  }
  const state = backups.backedUp
    ? `<p>Last backup ${escape(new Date(backups.lastSuccess!.at).toISOString())} (${escape(backups.lastSuccess!.commit.slice(0, 12))}).</p>`
    : backups.lastFailure != null
      ? `<p>The last backup failed: ${escape(backups.lastFailure.error)}</p>`
      : '<p>No backup has run yet.</p>'
  const key =
    backups.configured && can(actor, 'backups.key')
      ? `<section class="card"><h2>Backup key</h2><p>Store this key somewhere safe outside this master. Without it no backup can be restored.</p><pre data-field="backupKey">${escape(master.backups.keyText())}</pre>${
          master.backups.needsConfirmation(session.accountId)
            ? `<form data-mason="backup-confirm"><p><button>I have stored the backup key</button></p>${status}</form>`
            : '<p>You confirmed you stored this key.</p>'
        }</section>`
      : ''
  return `<section class="card"><p>Every hour the master encrypts a snapshot of its database and pushes it to a git repository. Add the deploy key below to that repository with write access.</p>${state}<form data-mason="backup"><label for="repository">Repository</label><input id="repository" name="repository" value="${escape(value.repository ?? '')}" placeholder="git@github.com:owner/mason-backup.git" required><label for="branch">Branch</label><input id="branch" name="branch" value="${escape(value.branch ?? 'master')}" required><p><button>Save</button></p><p>Deploy key</p><pre data-field="deployKey"${value.deployKey == null ? ' hidden' : ''}>${escape(value.deployKey?.publicKey ?? '')}</pre><pre data-field="backupKey" hidden></pre>${status}</form><p><a href="/">Skip for now</a></p></section>${key}`
}

/** The master's pages: setup until the first account exists, then sign-in, home and backups. */
export function masterPages(
  app: express.Express,
  context: WebAppContext,
  master: Master,
): void {
  const session = (req: express.Request): MasterSession | undefined =>
    master.auth.session(cookie(req, MASTER_SESSION_COOKIE))
  const send = (
    res: express.Response,
    title: string,
    content: string,
    current?: MasterSession,
    code = 200,
  ): void => {
    res.status(code).send(masterPage(context, master, title, content, current))
  }
  app.get('/', (req, res) => {
    if (!master.configured()) {
      send(res, 'Set up this master', setupPage)
      return
    }
    const current = session(req)
    if (current == null) {
      res.redirect(303, '/sign-in')
      return
    }
    // An administrator sees the Backups page until they confirm the key.
    if (
      can(sessionActor(current), 'backups.key') &&
      master.backups.needsConfirmation(current.accountId)
    ) {
      res.redirect(303, '/backups')
      return
    }
    const notices = master.notices()
    send(
      res,
      'Mason',
      `<section class="card"><p>Signed in as ${escape(current.name)}.</p>${notices.length === 0 ? '' : `<ul>${notices.map((line) => `<li>${escape(line)}</li>`).join('')}</ul>`}</section>`,
      current,
    )
  })
  app.get('/sign-in', (req, res) => {
    if (!master.configured()) {
      res.redirect(303, '/')
      return
    }
    if (session(req) != null) {
      res.redirect(303, '/')
      return
    }
    send(res, 'Sign in', signInPage)
  })
  app.get('/backups', (req, res) => {
    const current = session(req)
    if (current == null) {
      res.redirect(303, master.configured() ? '/sign-in' : '/')
      return
    }
    if (!can(sessionActor(current), 'settings.read')) {
      send(
        res,
        'Backups',
        '<p>Backups are for managers and administrators.</p>',
        current,
        403,
      )
      return
    }
    send(res, 'Backups', backupsPage(master, current), current)
  })
  // Every other page needs a signed-in user once the master is set up.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/')) {
      next()
      return
    }
    if (!master.configured()) {
      next()
      return
    }
    if (session(req) == null) {
      res.redirect(303, '/sign-in')
      return
    }
    next()
  })
}
