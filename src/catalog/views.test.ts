import assert from 'node:assert/strict'
import { describe, it } from 'mocha'
import { branchView, installView } from './views.js'

describe('Catalog views', () => {
  it('draws no iOS install link where there is no absolute address to fetch the manifest from', () => {
    const viewer = { node: 'master' as const, csrf: 'c', origin: '' }
    const page = branchView(
      {
        app: { id: 3, name: 'Alpha', slug: 'com.example.alpha' },
        platforms: ['ios'],
        branch: 'master',
        device: true,
        builds: [
          {
            id: 9,
            platform: 'ios',
            format: 'ipa',
            version: '1.0',
            buildNumber: '2',
            commit: 'abc',
            publishedAt: 0,
            size: 1024,
            variant: '',
            run: null,
            eligible: true,
            token: 't'.repeat(43),
          },
        ],
      },
      viewer,
      'ios',
      '/apps/3/branches/bWFzdGVy',
    )
    assert.match(
      page.body,
      /<div id="build-9" class="list-row build-row" aria-disabled="true">/,
    )
    assert.match(page.body, /need a public address for this master/)
    assert.doesNotMatch(
      page.body,
      /itms-services|data-install|action="\/builds/,
    )
    const install = installView(viewer, 't'.repeat(43))
    assert.match(install.body, /need a public address for this master/)
    assert.doesNotMatch(install.body, /itms-services/)
    // With an address, the tap opens the installer.
    assert.match(
      installView({ ...viewer, origin: 'https://m.example.test' }, 'x').body,
      /itms-services:\/\/\?action=download-manifest/,
    )
  })
})
