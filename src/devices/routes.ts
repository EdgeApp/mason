import express, { Router } from 'express'
import { asString } from 'cleaners'
import QRCode from 'qrcode'
import { Accounts, type Session } from '../auth/accounts.js'
import { csrf, navigation, sessionContext } from '../auth/routes.js'
import { Store, digest } from '../store.js'
import { asId, text } from '../validation.js'
import { escape, page } from '../view.js'
import { verifyCms } from './cms.js'
import { decodePlist } from './plist.js'
import { DEVICE_COOKIE, Devices, type DeviceRelay } from './store.js'

const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 30 * 86400000,
}
const hidden = (s: Session): string =>
  `<input type="hidden" name="csrf" value="${escape(s.csrf)}">`
const labels: Record<string, string> = {
  pending: 'Waiting to register with Apple',
  processing: 'Apple registration is processing',
  registered: 'Registered with Apple',
  error: 'Preparation needs attention',
}
export function deviceCallbackRoutes(
  store: Store,
  relay?: DeviceRelay,
): Router {
  const router = Router(),
    devices = new Devices(store, relay)
  let active = 0
  const windows = new Map<string, { count: number; at: number }>()
  router.post(
    '/devices/callback/:token',
    (req, res, next) => {
      if (
        !store.config.devices ||
        !/^[A-Za-z0-9_-]{43}$/.test(req.params.token) ||
        active >= 4
      ) {
        res.status(400).send('Registration is unavailable')
        return
      }
      const now = Date.now(),
        key = req.ip ?? 'unknown'
      for (const [ip, w] of windows) if (now - w.at > 60000) windows.delete(ip)
      const w = windows.get(key) ?? { count: 0, at: now }
      windows.set(key, w)
      if (++w.count > 30) {
        res.status(429).send('Try again shortly')
        return
      }
      const row = store.db
        .prepare(
          'SELECT hash FROM device_challenges WHERE hash=? AND expires_at>? AND device_id IS NULL',
        )
        .get(digest(req.params.token), store.now())
      if (!row) {
        res
          .status(410)
          .send(
            'This registration request has expired. Return to Mason and try again.',
          )
        return
      }
      next()
    },
    express.raw({ type: () => true, limit: '1mb' }),
    async (req, res) => {
      active++
      let stage = 'signature'
      try {
        const cfg = store.config.devices!
        const bytes = await verifyCms(
          req.body as Buffer,
          cfg.trustStoreFile,
          true,
          cfg.openssl,
        )
        stage = 'attributes'
        const attributes = decodePlist(bytes)
        stage = 'registration'
        devices.receive(String(req.params.token), attributes)
        // Profile Service recognizes 301 as the handoff back to Safari.
        // A normal 303 makes Settings follow the HTML page as another profile.
        res.redirect(
          301,
          store.config.origin + '/devices/complete/' + String(req.params.token),
        )
      } catch {
        // Never log the token, signed payload, UDID or certificate contents.
        console.error('Mason device callback failed at ' + stage)
        res
          .status(400)
          .send(
            'Device registration could not be verified. Open Mason in Safari and start again.',
          )
      } finally {
        active--
      }
    },
  )
  return router
}
export function deviceRoutes(
  store: Store,
  accounts = new Accounts(store),
  relay?: DeviceRelay,
): Router {
  const router = Router(),
    devices = new Devices(store, relay)
  router.get(
    ['/devices', '/devices/complete/:token', '/devices/qr'],
    async (req, res) => {
      const context = sessionContext(req, accounts)
      if (!context) {
        res.redirect(
          303,
          '/auth/login?return=' + encodeURIComponent(req.originalUrl),
        )
        return
      }
      const { account, session } = context
      if (!devices.allowed(account)) {
        res.status(403).send('Tester access required')
        return
      }
      if (req.path === '/devices/qr') {
        res.type('image/svg+xml').send(
          await QRCode.toString(store.config.origin + '/devices', {
            type: 'svg',
            margin: 2,
            color: { dark: '#10151e', light: '#ffffff' },
          }),
        )
        return
      }
      if (req.params.token) {
        const row = store.db
          .prepare(
            'SELECT device_id FROM device_challenges WHERE hash=? AND account_id=? AND expires_at>?',
          )
          .get(digest(String(req.params.token)), account.id, store.now())
        // On a host the registration went to the master; its device row comes back by UDID.
        const sent = devices.registration(String(req.params.token), account.id)
        const device = row?.device_id
          ? devices.list(account.id).find((d) => d.id === row.device_id)
          : sent == null
            ? undefined
            : devices.list(account.id).find((d) => d.udid === sent)
        if (device == null && sent != null) {
          res.set('Refresh', '5')
          res.send(
            page(
              'Registering device',
              '<section class="card"><p>Mason has your device and is registering it with Apple. This page updates by itself.</p></section>',
              navigation(session, account),
            ),
          )
          return
        }
        if (device) {
          const model = device.model.replace(
            /^(iPhone|iPad|iPod)(.+)$/,
            (_match, family: string, variant: string) =>
              family + ' ' + variant.replace(/(\d|[a-z])([A-Z])/g, '$1 $2'),
          )
          res.cookie(DEVICE_COOKIE, String(device.id), cookieOptions)
          res.send(
            page(
              'Device registered',
              `<section class="card"><p>You've registered the following device: <strong>${escape(model)}</strong>.</p><p>A new build of the applications is required before you can install them on your device. Mason will prepare these builds automatically.</p><p>Builds take approximately <strong>30 to 60 minutes</strong> to become available. Please check back in that time.</p><div class="actions"><a class="button" href="/">Browse apps</a><a href="/devices">View your devices</a></div></section>`,
              navigation(session, account),
            ),
          )
          return
        }
        res
          .status(410)
          .send('Registration link is unavailable. Return to Register Device.')
        return
      }
      const current = devices.selected(account.id, req.headers.cookie)
      const own = devices.list(account.id)
      if (
        own.some(
          (d) =>
            d.status === 'pending' ||
            d.status === 'processing' ||
            (d.status === 'registered' && d.message === ''),
        )
      )
        res.set('Refresh', '15')
      const rows = own
        .map(
          (d) =>
            `<section class="card"><h2>${escape(d.name)}</h2><p>${escape(d.model)} · iOS ${escape(d.os_version)}</p><p class="device-state">${escape(labels[d.status] ?? d.status)}</p>${d.message ? `<p>${escape(d.message)}</p>` : ''}<small class="device-id">Device identifier: ${escape(d.udid)}</small><form method="post" action="/devices/${d.id}/select">${hidden(session)}<button class="secondary">${current?.id === d.id ? 'Selected device' : 'Use this device'}</button></form><form method="post" action="/devices/${d.id}/rename">${hidden(session)}<label for="name-${d.id}">Friendly name</label><input id="name-${d.id}" name="name" maxlength="120" value="${escape(d.name)}" required><button class="secondary">Save name</button></form>${d.status === 'error' ? `<form method="post" action="/devices/${d.id}/retry">${hidden(session)}<button>Retry preparation</button></form>` : ''}<form method="post" action="/devices/${d.id}/remove">${hidden(session)}<button class="secondary">Remove from my account</button></form></section>`,
        )
        .join('')
      const content =
        store.config.devices == null
          ? '<section class="card"><p>Device registration is being configured. Please try again shortly.</p></section>'
          : `<section class="card"><p>Register your iPhone or iPad once to install Mason test builds. The temporary profile shares your device identifier, model and OS version. It does not install a root certificate or enroll your device in management.</p><form method="post" action="/devices/profile">${hidden(session)}<button class="register-device">Install Registration Profile</button></form><ol><li>Open this page in Safari on your iPhone or iPad and allow the profile download.</li><li>Open Settings → Profile Downloaded → Install. The registration profile may be shown as unsigned.</li><li>Follow Apple's prompts, then return to Mason. Compatible builds will be prepared automatically.</li></ol><p>If Profile Downloaded is missing, look in Settings → General → VPN &amp; Device Management, or download the profile again. Apple removes uninstalled downloads after eight minutes.</p><p>Using a computer? Scan this code with your iPhone or iPad, then sign in.</p><img class="device-qr" src="/devices/qr" width="180" height="180" alt="QR code to open Mason device registration"><p>Android and desktop apps can be downloaded without iOS device registration.</p></section>`
      const all = account.is_admin
        ? store.db
            .prepare(
              'SELECT a.name,d.model,d.status FROM account_devices a JOIN devices d ON d.id=a.device_id ORDER BY a.created_at DESC LIMIT 500',
            )
            .all()
            .map(
              (r) =>
                `<p>${escape(asString(r.name))} · ${escape(asString(r.model))} · ${escape(labels[asString(r.status)] ?? asString(r.status))}</p>`,
            )
            .join('')
        : ''
      res.send(
        page(
          'Register Device',
          content +
            (rows ? '<h2>Your devices</h2>' + rows : '') +
            (all
              ? '<section class="card"><h2>All registered devices</h2>' +
                all +
                '</section>'
              : '') +
            '<a href="/">Browse apps</a>',
          navigation(session, account),
        ),
      )
    },
  )
  router.post('/devices/profile', (req, res) => {
    const context = sessionContext(req, accounts)
    if (
      !context ||
      !devices.allowed(context.account) ||
      !store.config.devices
    ) {
      res.status(403).send('Tester access required')
      return
    }
    csrf(req, store, context.session)
    const token = devices.challenge(context.session)
    res
      .set(
        'Content-Disposition',
        'attachment; filename="mason-device-registration.mobileconfig"',
      )
      .type('application/x-apple-aspen-config')
      .send(devices.profile(token))
  })
  router.post('/devices/:id/:action', (req, res) => {
    const context = sessionContext(req, accounts)
    if (!context || !devices.allowed(context.account)) {
      res.status(403).send('Tester access required')
      return
    }
    csrf(req, store, context.session)
    const device = devices
      .list(context.account.id)
      .find((d) => d.id === asId(Number(req.params.id)))
    if (!device) {
      res.status(404).send('Device unavailable')
      return
    }
    switch (req.params.action) {
      case 'select':
        res.cookie(DEVICE_COOKIE, String(device.id), cookieOptions)
        break
      case 'rename':
        devices.act(
          context.account.id,
          device,
          'rename',
          text(120)((req.body as { name?: unknown }).name),
        )
        break
      case 'retry':
        devices.act(context.account.id, device, 'retry')
        break
      case 'remove': {
        const wasSelected =
          devices.selected(context.account.id, req.headers.cookie)?.id ===
          device.id
        devices.act(context.account.id, device, 'remove')
        if (wasSelected) res.clearCookie(DEVICE_COOKIE, cookieOptions)
        break
      }
      default:
        res.status(404).send('Unknown action')
        return
    }
    accounts.audit(
      context.account.id,
      'device.' + String(req.params.action),
      String(device.id),
    )
    res.redirect(303, '/devices')
  })
  router.post('/builds/:id/prepare', (req, res) => {
    const context = sessionContext(req, accounts)
    if (
      !context ||
      !devices.allowed(context.account) ||
      !store.config.devices
    ) {
      res.status(403).send('Tester access required')
      return
    }
    csrf(req, store, context.session)
    const device = devices.selected(context.account.id, req.headers.cookie)
    if (!device) {
      res.redirect(303, '/devices')
      return
    }
    devices.requestBuild(
      context.account.id,
      device.id,
      asId(Number(req.params.id)),
    )
    res.send(
      page(
        'Preparing build',
        '<section class="card"><p>Mason will prepare this branch and commit for your device. This can take several minutes; the new build will appear in the app’s build list.</p><a href="/">Browse apps</a></section>',
        navigation(context.session, context.account),
      ),
    )
  })
  return router
}
