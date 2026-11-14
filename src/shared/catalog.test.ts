import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { branchKey as serverBranchKey, platform } from '../catalog/platform.js'
import {
  branchKey,
  choosePlatform,
  deviceStateLabel,
  devicesPending,
  groupBuilds,
  humanModel,
} from './catalog.js'

describe('The catalog rules the server and the web app share', () => {
  it('makes the same branch key as the server, for any branch name', () => {
    for (const name of [
      'master',
      'paul/offline',
      'feature/ü-ñ-日本',
      'a+b/c?d=e',
      '~>~',
    ])
      assert.equal(branchKey(name), serverBranchKey(name), name)
  })

  it('chooses the platform as the server does: the address, the remembered one, then the browser', () => {
    const agents = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X)',
      'Mozilla/5.0 (Linux; Android 15)',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'curl/8',
    ]
    for (const agent of agents) {
      assert.equal(
        choosePlatform(null, undefined, agent),
        platform(undefined, undefined, agent),
      )
      assert.equal(choosePlatform(null, 'tvos', agent), 'tvos')
      assert.equal(
        choosePlatform(null, 'bogus', agent),
        platform(undefined, 'bogus', agent),
      )
      assert.equal(choosePlatform('android', 'tvos', agent), 'android')
    }
  })

  it('groups a run’s variants, Default first then by name in byte order', () => {
    const groups = groupBuilds([
      { id: 1, run: 'r1', variant: 'staging' },
      { id: 2, run: null, variant: '' },
      { id: 3, run: 'r1', variant: '' },
      { id: 4, run: 'r1', variant: 'Beta' },
      { id: 5, run: 'r2', variant: 'b' },
      { id: 6, run: 'r2', variant: 'a' },
    ])
    assert.deepEqual(
      groups.map((group) => group.map((build) => build.id)),
      [[3, 4, 1], [2], [6, 5]],
    )
  })

  it('words devices for people, and says when Devices should look again', () => {
    assert.equal(humanModel('iPhone15Pro'), 'iPhone 15 Pro')
    assert.equal(humanModel('iPadPro11'), 'iPad Pro11')
    assert.equal(humanModel('iPhone16,1'), 'iPhone 16,1')
    assert.equal(humanModel('Watch'), 'Watch')
    assert.equal(deviceStateLabel('pending'), 'Waiting to register with Apple')
    assert.equal(deviceStateLabel('retired'), 'retired')
    assert.equal(
      devicesPending([{ status: 'registered', message: 'ok' }]),
      false,
    )
    assert.equal(devicesPending([{ status: 'registered', message: '' }]), true)
    assert.equal(devicesPending([{ status: 'processing', message: 'x' }]), true)
    assert.equal(devicesPending([{ status: 'error', message: '' }]), false)
  })
})
