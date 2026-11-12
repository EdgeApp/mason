import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { before, describe, it } from 'mocha'
import { WEB_ASSETS, webBundlesDir } from '../node/webRoutes.js'

describe('scripts/bundle-web.mjs', () => {
  let names: string[]
  let html: string
  const read = (name: string): string =>
    readFileSync(path.join(webBundlesDir, name), 'utf8')

  before(() => {
    names = readdirSync(webBundlesDir).sort()
    html = read('index.html')
  })

  it('writes hashed app, stylesheet and worker files, theme-boot.js and index.html', () => {
    assert.deepEqual(
      names.map((name) => name.replace(/-[A-Z0-9]{8}\./, '-[hash].')),
      [
        'app-[hash].css',
        'app-[hash].js',
        'index.html',
        'password-worker-[hash].js',
        'theme-boot.js',
      ],
    )
  })

  it('names each file in index.html, theme-boot.js first and synchronously', () => {
    const boot = html.indexOf(
      `<script src="${WEB_ASSETS}/theme-boot.js"></script>`,
    )
    assert(boot > 0)
    for (const name of names.filter((name) => name !== 'index.html'))
      assert(html.includes(`${WEB_ASSETS}/${name}"`), name)
    const css = names.find((name) => name.endsWith('.css'))!
    const app = names.find((name) => /^app-.*\.js$/.test(name))!
    assert(boot < html.indexOf(css) && html.indexOf(css) < html.indexOf(app))
    assert.match(
      html,
      new RegExp(`<script type="module" src="${WEB_ASSETS}/${app}">`),
    )
    assert.match(html, /<div id="root"><\/div>/)
  })

  it('builds app.css from the library, the tokens and the components, in that order', () => {
    const css = read(names.find((name) => name.endsWith('.css'))!)
    const library = css.indexOf('--label-primary:')
    const bridge = css.indexOf('html:root:not([data-theme=light])')
    const component = css.indexOf('.m-app{')
    assert(library >= 0 && bridge > library && component > bridge)
    assert.doesNotMatch(css, /\.x-[a-z]/)
    // The fonts stay where the node serves them.
    for (const font of ['geist-variable', 'jetbrains-mono-variable'])
      assert(css.includes(`url(/assets/fonts/${font}.woff2)`), font)
  })

  it('applies the stored Appearance from theme-boot.js', () => {
    const boot = read('theme-boot.js')
    assert.match(boot, /mason-appearance/)
    assert.doesNotMatch(boot, /\bimport\b|\bexport\b/)
  })
})
