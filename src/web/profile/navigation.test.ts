import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { nodeInfo, permissionsOf } from '../test/render.js'
import {
  audience,
  currentNav,
  homeFor,
  NAV,
  navFor,
  navItem,
  navSections,
  TAB_BAR_MAX,
  tabBar,
} from './navigation.js'
import { hostProfile, masterProfile, profileFor } from './NodeProfile.js'

const labels = (
  node: 'master' | 'host',
  role: 'tester' | 'developer' | 'manager' | 'admin',
): string[] => navFor(node, permissionsOf(role)).map((entry) => entry.label)

describe('Navigation per node and role', () => {
  it('lists the design language’s destinations in order, by section', () => {
    assert.deepEqual(
      NAV.map((entry) => `${entry.section}:${entry.label}`),
      [
        'Build:Projects & apps',
        'Build:Artifacts',
        'Distribute:Install apps',
        'Distribute:Devices',
        'Cluster:Nodes',
        'Cluster:Cloud',
        'Admin:People',
        'Admin:Groups',
        'Admin:Settings',
        'Admin:Backups',
      ],
    )
  })

  it('gives each role on the master what its permissions open', () => {
    assert.deepEqual(labels('master', 'tester'), ['Install apps', 'Devices'])
    assert.deepEqual(labels('master', 'developer'), [
      'Projects & apps',
      'Artifacts',
      'Install apps',
      'Devices',
    ])
    const all = NAV.map((entry) => entry.label)
    assert.deepEqual(labels('master', 'manager'), all)
    assert.deepEqual(labels('master', 'admin'), all)
  })

  it('never lists the master’s administration on the host, whatever the role', () => {
    assert.deepEqual(labels('host', 'tester'), ['Install apps', 'Devices'])
    assert.deepEqual(labels('host', 'admin'), [
      'Projects & apps',
      'Artifacts',
      'Install apps',
      'Devices',
    ])
  })

  it('groups by section, dropping empty ones', () => {
    assert.deepEqual(
      navSections(navFor('master', permissionsOf('admin'))).map(
        (s) => `${s.section} ${s.items.length}`,
      ),
      ['Build 2', 'Distribute 2', 'Cluster 2', 'Admin 4'],
    )
    assert.deepEqual(
      navSections(navFor('host', permissionsOf('tester'))).map(
        (s) => s.section,
      ),
      ['Distribute'],
    )
  })

  it('fills the tab bar with at most five: four and More past five', () => {
    const admin = tabBar(navFor('master', permissionsOf('admin')))
    assert.deepEqual(
      admin.tabs.map((entry) => entry.short),
      ['Projects', 'Artifacts', 'Install', 'Devices'],
    )
    assert.deepEqual(
      admin.more.map((entry) => entry.label),
      ['Nodes', 'Cloud', 'People', 'Groups', 'Settings', 'Backups'],
    )
    assert(admin.tabs.length + 1 <= TAB_BAR_MAX)
    const developer = tabBar(navFor('host', permissionsOf('developer')))
    assert.equal(developer.tabs.length, 4)
    assert.deepEqual(developer.more, [])
    const five = tabBar(NAV.slice(0, 5))
    assert.equal(five.tabs.length, 5)
    assert.deepEqual(five.more, [])
  })

  it('knows the current destination by its path, the home of each role and who a page is for', () => {
    const items = navFor('master', permissionsOf('admin'))
    assert.equal(currentNav('/projects/fixture/runs', items)?.key, 'dashboard')
    assert.equal(currentNav('/groups', items)?.key, 'groups')
    assert.equal(currentNav('/groupsx', items), undefined)
    assert.equal(currentNav('/account', items), undefined)
    assert.equal(homeFor(items), '/projects')
    assert.equal(homeFor(navFor('host', permissionsOf('tester'))), '/apps')
    assert.equal(homeFor([]), '/account')
    assert.equal(navItem('backups')?.least, 'manager')
    assert.equal(navItem('nowhere'), undefined)
    assert.equal(audience('tester'), 'everyone signed in')
    assert.equal(
      audience('developer'),
      'developers, managers and administrators',
    )
    assert.equal(audience('manager'), 'managers and administrators')
    assert.equal(audience('admin'), 'administrators')
  })
})

describe('Node profiles', () => {
  it('holds what differs between the master and the host', () => {
    const master = profileFor(nodeInfo('master'))
    assert.deepEqual(
      { ...master, signIn: master.signIn('/_web/nodes') },
      { ...masterProfile('0.6.0'), signIn: '/sign-in' },
    )
    assert.equal(master.name, 'Mason Master')
    assert.equal(master.clusterChips, true)
    const host = profileFor(nodeInfo('host'))
    assert.deepEqual(
      { ...host, signIn: undefined },
      { ...hostProfile('0.6.0'), signIn: undefined },
    )
    assert.equal(host.name, 'Mason Host')
    assert.equal(host.short, 'Host')
    assert.equal(
      host.signIn('/_web/apps?platform=ios'),
      '/auth/login?return=%2F_web%2Fapps%3Fplatform%3Dios',
    )
    assert.equal(host.clusterChips || host.secrets || host.admin, false)
  })
})
