// The server's page table decides the shell's 403, 404 or 200; the app's
// decides what it draws there. Both declare each page's access, so this
// checks they say the same for every page.
import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { policy } from '../../master/permissions.js'
import {
  PAGE_ROUTES as SERVER_ROUTES,
  type PageRoute as ServerRoute,
} from '../../node/webRoutes.js'
import { PAGE_ROUTES } from './routes.js'

/** The server's routes by each of their paths. */
const server = new Map<string, ServerRoute>(
  SERVER_ROUTES.flatMap((route) =>
    (Array.isArray(route.path) ? route.path : [route.path]).map(
      (path) => [path, route] as const,
    ),
  ),
)

/**
 * Pages the app draws outside its signed-in table (`AppRoutes`' own: home,
 * each node's sign-in and invitations).
 */
const bare = ['/', '/sign-in', '/auth/login', '/auth/invite']

/**
 * A page the server answers outside its page table: a device's
 * registration, which src/catalog/shell.ts answers 403 without
 * `devices.register`.
 */
const elsewhere = '/devices/complete/:token'

describe('Each page’s access on the server and in the app', () => {
  it('declares every signed-in page in both tables', () => {
    assert.deepEqual(
      PAGE_ROUTES.map((route) => route.path)
        .filter((path) => path !== elsewhere)
        .sort(),
      [...server.keys()].filter((path) => !bare.includes(path)).sort(),
    )
    assert.equal(server.get(elsewhere), undefined)
  })

  it('gives each page the same permission, hiddenWithout and nodes on both sides', () => {
    for (const route of PAGE_ROUTES) {
      const answered = server.get(route.path)
      if (answered == null) continue
      assert.deepEqual(
        {
          permission: route.permission,
          hiddenWithout: route.hiddenWithout,
          masterOnly: route.masterOnly,
          hostOnly: false,
        },
        {
          permission: answered.permission,
          hiddenWithout: answered.hiddenWithout,
          masterOnly: answered.masterOnly === true,
          hostOnly: answered.hostOnly === true,
        },
        route.path,
      )
    }
    assert.equal(
      PAGE_ROUTES.find((route) => route.path === elsewhere)?.permission,
      'devices.register',
    )
  })

  it('names the least role holding each page’s permission on its 403', () => {
    for (const route of PAGE_ROUTES)
      if (route.permission != null)
        assert.equal(route.least, policy[route.permission], route.path)
  })
})
