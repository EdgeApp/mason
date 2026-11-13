import assert from 'node:assert/strict'
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, it } from 'mocha'
import type { GroupDetail } from '../../../../shared/api/admin.js'
import {
  appsFixture,
  crumbs,
  groupFixture,
  heading,
  held,
  openAdmin,
  peopleFixture,
  recorder,
  requested,
  sessionWithout,
  text,
} from '../../../test/admin.js'
import { until, where } from '../../../test/render.js'
import { groupSummary } from './groupsApi.js'

afterEach(() => cleanup())

const GROUPS = '/api/v2/groups'
const GROUP = '/api/v2/groups/2'
const APPS = '/api/v2/apps'
const PEOPLE = '/api/v2/people'

const coaches = groupFixture({
  id: 3,
  name: 'Coaches',
  apps: [{ id: 4, slug: 'app.teamstation.director' }],
  members: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
})

/** A group page's answers, with a PUT that answers the group with the body applied. */
const groupReplies = (
  group: GroupDetail = groupFixture(),
  fail?: (body: Record<string, unknown>) => string | undefined,
): {
  replies: Record<string, unknown>
  put: ReturnType<typeof recorder>
} => {
  let current = group
  const put = recorder((body) => {
    const change = body as Record<string, unknown>
    const refused = fail?.(change)
    if (refused != null) return { status: 400, body: { error: refused } }
    current = {
      ...current,
      ...(typeof change.name === 'string' ? { name: change.name } : {}),
      ...(Array.isArray(change.apps)
        ? {
            apps: (change.apps as number[]).map((id) => ({
              id,
              slug:
                appsFixture().find((app) => app.id === id)?.slug ?? `#${id}`,
            })),
          }
        : {}),
      ...(Array.isArray(change.members)
        ? { members: change.members as number[] }
        : {}),
    }
    return { status: 200, body: current }
  })
  return {
    put,
    replies: {
      [GROUP]: group,
      [APPS]: appsFixture(),
      [PEOPLE]: peopleFixture(),
      [`PUT ${GROUP}`]: put.reply,
    },
  }
}

const section = (name: 'Apps' | 'Members'): HTMLElement =>
  screen.getByRole('region', { name: new RegExp(`^${name}`) })
const rows = (name: 'Apps' | 'Members'): string[] =>
  [...section(name).querySelectorAll('li')].map(text)

describe('Groups', () => {
  it('lists each group with its counts, each opening its page', async () => {
    openAdmin('/groups', {
      ...groupReplies().replies,
      [GROUPS]: [groupFixture(), coaches],
    })
    await heading('Groups')
    assert.equal(crumbs().at(-1), 'Groups')
    screen.getByText('The apps each group’s members see in their catalog.')
    const testers = await screen.findByRole('link', { name: /Testers/ })
    assert.equal(testers.getAttribute('href'), '/groups/2')
    assert.equal(text(testers), 'Testers2 apps · 2 members')
    assert.equal(
      text(screen.getByRole('link', { name: /Coaches/ })),
      'Coaches1 app · 12 members',
    )
    assert.equal(groupSummary(1, 1), '1 app · 1 member')
    fireEvent.click(testers)
    await until(() => where.path === '/groups/2')
    await heading('Testers')
  })

  it('says when there are no groups, shows a skeleton while loading and a failed read with Retry', async () => {
    openAdmin('/groups', { [GROUPS]: [] })
    await screen.findByRole('heading', { name: 'No groups.' })
    cleanup()
    const slow = held(200, [])
    openAdmin('/groups', { [GROUPS]: slow.reply })
    await heading('Groups')
    screen.getByLabelText('Loading the groups')
    slow.release()
    await screen.findByRole('heading', { name: 'No groups.' })
    cleanup()
    const app = openAdmin('/groups', {
      [GROUPS]: { status: 500, body: { error: 'Database locked' } },
    })
    await screen.findByText('The groups could not be read')
    app.node.set(GROUPS, [groupFixture()])
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByRole('link', { name: /Testers/ })
  })

  it('adds a group in a form sheet and opens it; a refusal stays in the sheet', async () => {
    const post = recorder((_body, n) =>
      n === 1
        ? { status: 409, body: { error: 'A group named QA exists' } }
        : {
            status: 201,
            body: groupFixture({ id: 5, name: 'QA', apps: [], members: [] }),
          },
    )
    openAdmin('/groups', {
      [GROUPS]: [],
      [`POST ${GROUPS}`]: post.reply,
      '/api/v2/groups/5': groupFixture({
        id: 5,
        name: 'QA',
        apps: [],
        members: [],
      }),
      [APPS]: appsFixture(),
      [PEOPLE]: peopleFixture(),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Add group' }))
    const sheet = await screen.findByRole('dialog', { name: 'Add a group' })
    const name = within(sheet).getByLabelText('Name') as HTMLInputElement
    assert.equal(name.maxLength, 120)
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add group' }))
    await within(sheet).findByText('Enter a name.')
    fireEvent.change(name, { target: { value: ' QA ' } })
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add group' }))
    await within(sheet).findByText('A group named QA exists')
    assert.deepEqual(post.bodies, [{ name: 'QA' }])
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add group' }))
    await screen.findByText('QA added')
    await until(() => where.path === '/groups/5')
    await heading('QA')
  })

  it('shows plain text without groups.change: no add, rename, pickers or removal', async () => {
    const viewer = sessionWithout('manager', ['groups.change'])
    openAdmin('/groups', { [GROUPS]: [groupFixture()] }, 'manager', viewer)
    await screen.findByRole('link', { name: /Testers/ })
    assert.equal(screen.queryByRole('button', { name: 'Add group' }), null)
    cleanup()
    openAdmin('/groups/2', groupReplies().replies, 'manager', viewer)
    await heading('Testers')
    await until(() => rows('Members').length === 2)
    assert.equal(screen.queryByRole('button', { name: 'Rename' }), null)
    assert.equal(screen.queryByRole('button', { name: 'Remove group' }), null)
    assert.equal(screen.queryByRole('button', { name: 'Add app' }), null)
    assert.equal(screen.queryByRole('button', { name: /^Remove / }), null)
    cleanup()
    openAdmin('/groups', { [GROUPS]: [] }, 'developer')
    await screen.findByText(/Groups is for/)
  })
})

describe('A group', () => {
  it('shows its apps (name and slug) and members (name and first email) in the catalog’s order', async () => {
    openAdmin(
      '/groups/2',
      groupReplies(
        groupFixture({
          apps: [
            { id: 2, slug: 'app.teamstation.tv' },
            { id: 1, slug: 'app.teamstation.app' },
            { id: 99, slug: 'app.gone' },
          ],
          members: [9, 7, 42],
        }),
      ).replies,
    )
    await heading('Testers')
    assert.deepEqual(crumbs().slice(-2), ['Groups', 'Testers'])
    screen.getByText('Its members see its apps in their catalog.')
    await until(() => rows('Apps').length === 3)
    assert.deepEqual(rows('Apps'), [
      'TeamStationapp.teamstation.app',
      'TeamStation TVapp.teamstation.tv',
      'app.gone',
    ])
    assert.match(text(section('Apps').querySelector('header')), /Apps\s*3/)
    await until(() => rows('Members').length === 3)
    assert.deepEqual(rows('Members'), [
      'SSam Riverasam@example.test',
      'AAda Lovelace',
      'PPerson #42',
    ])
  })

  it('says when a section is empty, and loads and fails each catalog in its own section', async () => {
    const slow = held(200, appsFixture())
    const { replies } = groupReplies(groupFixture({ apps: [], members: [] }))
    const app = openAdmin('/groups/2', {
      ...replies,
      [APPS]: slow.reply,
      [PEOPLE]: { status: 500, body: { error: 'People are unavailable' } },
    })
    await heading('Testers')
    within(section('Apps')).getByLabelText('Loading the apps')
    assert.equal(
      within(section('Apps')).queryByRole('button', { name: 'Add app' }),
      null,
    )
    slow.release()
    await within(section('Apps')).findByText('No apps yet.')
    await within(section('Members')).findByText('The members could not be read')
    within(section('Members')).getByText('People are unavailable')
    app.node.set(PEOPLE, peopleFixture())
    fireEvent.click(
      within(section('Members')).getByRole('button', { name: 'Retry' }),
    )
    await within(section('Members')).findByText('No members yet.')
  })

  it('shows "No such group" for an unknown or malformed id', async () => {
    openAdmin('/groups/77', {
      '/api/v2/groups/77': { status: 404, body: { error: 'No such group' } },
    })
    await heading('No such group')
    screen.getByText('There is no such group.')
    assert.equal(
      screen.getByRole('link', { name: 'All groups' }).getAttribute('href'),
      '/groups',
    )
    cleanup()
    const app = openAdmin('/groups/abc', {})
    await heading('No such group')
    assert.ok(
      app.node.requests.every((request) => !request.includes('/groups/abc')),
    )
  })

  it('shows a skeleton while the group loads, and a failed read with Retry', async () => {
    const slow = held(200, groupFixture())
    const { replies } = groupReplies()
    const app = openAdmin('/groups/2', { ...replies, [GROUP]: slow.reply })
    await heading('Group')
    screen.getByLabelText('Loading the group')
    slow.release()
    await heading('Testers')
    cleanup()
    const failed = openAdmin('/groups/2', {
      ...replies,
      [GROUP]: { status: 500, body: { error: 'Database locked' } },
    })
    await screen.findByText('The group could not be read')
    failed.node.set(GROUP, groupFixture())
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await heading('Testers')
    void app
  })

  it('renames in an edit block: Enter saves, Escape cancels, unchanged sends nothing, a refusal stays', async () => {
    const { replies, put } = groupReplies(groupFixture(), (body) =>
      body.name === 'Coaches' ? 'A group named Coaches exists' : undefined,
    )
    openAdmin('/groups/2', replies)
    await heading('Testers')
    const rename = screen.getByRole('button', { name: 'Rename' })
    fireEvent.click(rename)
    let field = (await screen.findByLabelText('Name')) as HTMLInputElement
    assert.equal(field.value, 'Testers')
    assert.equal(document.activeElement, field)
    // Escape puts it back.
    fireEvent.change(field, { target: { value: 'Other' } })
    fireEvent.keyDown(field, { key: 'Escape' })
    assert.equal(screen.queryByLabelText('Name'), null)
    await until(() => document.activeElement === rename, 'focus back on Rename')
    // Unchanged: nothing is sent.
    fireEvent.click(rename)
    field = (await screen.findByLabelText('Name')) as HTMLInputElement
    fireEvent.submit(field.closest('form')!)
    await until(() => screen.queryByLabelText('Name') == null)
    assert.equal(put.bodies.length, 0)
    // Empty is refused here.
    fireEvent.click(rename)
    field = (await screen.findByLabelText('Name')) as HTMLInputElement
    fireEvent.change(field, { target: { value: '  ' } })
    fireEvent.submit(field.closest('form')!)
    await screen.findByText('Enter a name.')
    // A refusal keeps the field and says why.
    fireEvent.change(field, { target: { value: 'Coaches' } })
    fireEvent.submit(field.closest('form')!)
    await screen.findByText('A group named Coaches exists')
    assert.equal(field.value, 'Coaches')
    // Cancel closes it.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    assert.equal(screen.queryByLabelText('Name'), null)
    // Enter saves; the heading and crumbs follow.
    fireEvent.click(rename)
    field = (await screen.findByLabelText('Name')) as HTMLInputElement
    fireEvent.change(field, { target: { value: 'Beta testers' } })
    fireEvent.submit(field.closest('form')!)
    await heading('Beta testers')
    await screen.findByText('Renamed to Beta testers')
    assert.deepEqual(crumbs().slice(-2), ['Groups', 'Beta testers'])
    assert.deepEqual(put.bodies.at(-1), { name: 'Beta testers' })
    assert.equal(screen.queryByLabelText('Name'), null)
  })

  it('keeps the rename field busy while it saves, and Escape waits for the answer', async () => {
    const answer = held(200, groupFixture({ name: 'Renamed' }))
    const { replies } = groupReplies()
    const app = openAdmin('/groups/2', {
      ...replies,
      [`PUT ${GROUP}`]: answer.reply,
    })
    await heading('Testers')
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const field = (await screen.findByLabelText('Name')) as HTMLInputElement
    fireEvent.change(field, { target: { value: 'Renamed' } })
    fireEvent.submit(field.closest('form')!)
    await requested(app, `PUT ${GROUP}`)
    assert.equal(field.readOnly, true)
    assert.equal(
      screen.getByRole('button', { name: 'Save' }).getAttribute('aria-busy'),
      'true',
    )
    fireEvent.submit(field.closest('form')!)
    fireEvent.keyDown(field, { key: 'Escape' })
    screen.getByLabelText('Name')
    answer.release()
    await heading('Renamed')
    assert.equal(
      app.node.requests.filter((request) => request === `PUT ${GROUP}`).length,
      1,
    )
  })

  it('adds and removes apps with the picker, each toggle saved in order, with a toast', async () => {
    const { replies, put } = groupReplies()
    const app = openAdmin('/groups/2', replies)
    await heading('Testers')
    const add = await within(section('Apps')).findByRole('button', {
      name: 'Add app',
    })
    assert.equal(add.getAttribute('aria-expanded'), 'false')
    fireEvent.click(add)
    assert.equal(add.getAttribute('aria-expanded'), 'true')
    const search = within(section('Apps')).getByRole('searchbox', {
      name: 'Find an app',
    })
    assert.equal(search.getAttribute('placeholder'), 'App name or ID')
    // The first three enabled apps: the disabled kiosk is skipped.
    const boxes = (): string[] =>
      within(section('Apps'))
        .queryAllByRole('checkbox')
        .map((box) => box.getAttribute('aria-label')!)
    assert.deepEqual(boxes(), [
      'TeamStation in Testers',
      'TeamStation TV in Testers',
      'Director in Testers',
    ])
    fireEvent.change(search, { target: { value: 'KIOSK' } })
    assert.deepEqual(boxes(), ['Old Kiosk in Testers'])
    fireEvent.change(search, { target: { value: 'nope' } })
    within(section('Apps')).getByText('Nothing matches.')
    fireEvent.change(search, { target: { value: 'teamstation' } })
    fireEvent.click(
      within(section('Apps')).getByRole('checkbox', {
        name: 'Director in Testers',
      }),
    )
    fireEvent.click(
      within(section('Apps')).getByRole('checkbox', {
        name: 'TeamStation TV in Testers',
      }),
    )
    await until(() => put.bodies.length === 2, 'both saves')
    assert.deepEqual(put.bodies, [{ apps: [1, 2, 4] }, { apps: [1, 4] }])
    await until(() => rows('Apps').length === 2)
    assert.deepEqual(rows('Apps'), [
      'TeamStationapp.teamstation.app',
      'Directorapp.teamstation.director',
    ])
    await screen.findByText('TeamStation TV removed from Testers')
    // Undo puts it back.
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await until(() => put.bodies.length === 3)
    assert.deepEqual(put.bodies[2], { apps: [1, 4, 2] })
    await screen.findByText('TeamStation TV added to Testers')
    // Done closes it and gives focus back to Add.
    fireEvent.click(
      within(section('Apps')).getByRole('button', { name: 'Done' }),
    )
    assert.equal(within(section('Apps')).queryByRole('searchbox'), null)
    await until(() => document.activeElement === add, 'focus back on Add app')
    // Add again closes an open picker too.
    fireEvent.click(add)
    fireEvent.click(add)
    assert.equal(within(section('Apps')).queryByRole('searchbox'), null)
    void app
  })

  it('adds and removes members; a refusal shows under the section until the picker opens again', async () => {
    const { replies, put } = groupReplies(groupFixture(), (body) =>
      Array.isArray(body.members) && (body.members as number[]).includes(10)
        ? 'Grace Hopper cannot join'
        : undefined,
    )
    openAdmin('/groups/2', replies)
    await heading('Testers')
    const add = await within(section('Members')).findByRole('button', {
      name: 'Add member',
    })
    fireEvent.click(add)
    const search = within(section('Members')).getByRole('searchbox', {
      name: 'Find a person',
    })
    assert.equal(search.getAttribute('placeholder'), 'Name or email')
    fireEvent.change(search, { target: { value: 'grace@' } })
    fireEvent.click(
      within(section('Members')).getByRole('checkbox', {
        name: 'Grace Hopper in Testers',
      }),
    )
    await within(section('Members')).findByText('Grace Hopper cannot join')
    // Escape closes; the refusal stays, since the change did not happen.
    fireEvent.keyDown(within(section('Members')).getByRole('searchbox'), {
      key: 'Escape',
    })
    within(section('Members')).getByText('Grace Hopper cannot join')
    // Opening again forgets it.
    fireEvent.click(add)
    assert.equal(
      within(section('Members')).queryByText('Grace Hopper cannot join'),
      null,
    )
    // A row's own Remove takes a member out (tier 1: no confirm, Undo).
    fireEvent.click(
      within(section('Members')).getByRole('button', {
        name: 'Remove Jo Park from Testers',
      }),
    )
    await until(() => rows('Members').length === 1)
    assert.deepEqual(put.bodies.at(-1), { members: [7] })
    await screen.findByText('Jo Park removed from Testers')
    // A second address finds a person too.
    fireEvent.change(within(section('Members')).getByRole('searchbox'), {
      target: { value: 'home.test' },
    })
    within(section('Members')).getByRole('checkbox', {
      name: 'Sam Rivera in Testers',
    })
  })

  it('removes the group after a tier-2 confirm and returns to Groups; a refusal shows on the page', async () => {
    const answer = held(200, null)
    const { replies } = groupReplies()
    const app = openAdmin('/groups/2', {
      ...replies,
      [`DELETE ${GROUP}`]: answer.reply,
      [GROUPS]: [],
    })
    await heading('Testers')
    fireEvent.click(screen.getByRole('button', { name: 'Remove group' }))
    let alert = await screen.findByRole('alertdialog', {
      name: 'Remove Testers?',
    })
    within(alert).getByText(/Its members no longer see its apps/)
    fireEvent.click(within(alert).getByRole('button', { name: 'Keep it' }))
    await until(() => screen.queryByRole('alertdialog') == null)
    fireEvent.click(screen.getByRole('button', { name: 'Remove group' }))
    alert = await screen.findByRole('alertdialog', { name: 'Remove Testers?' })
    const confirm = within(alert).getByRole('button', { name: 'Remove group' })
    assert.ok(confirm.className.includes('m-btn--danger-filled'))
    fireEvent.click(confirm)
    await requested(app, `DELETE ${GROUP}`)
    assert.equal(confirm.getAttribute('aria-busy'), 'true')
    answer.release()
    await until(() => where.path === '/groups')
    await screen.findByText('Testers removed')
    cleanup()
    openAdmin('/groups/2', {
      ...replies,
      [`DELETE ${GROUP}`]: { status: 403, body: { error: 'Not allowed' } },
    })
    await heading('Testers')
    fireEvent.click(screen.getByRole('button', { name: 'Remove group' }))
    alert = await screen.findByRole('alertdialog', { name: 'Remove Testers?' })
    fireEvent.click(within(alert).getByRole('button', { name: 'Remove group' }))
    await screen.findByText('Not allowed')
    assert.equal(where.path, '/groups/2')
  })
})
