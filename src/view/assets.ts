import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'

/** The fonts, icon subset, logo and their licences, beside `lib/` in a checkout and a release. */
export const assetsDir = fileURLToPath(
  new URL('../../assets/', import.meta.url),
)

const types: Record<string, string> = {
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * Serves `assets/fonts` and `assets/logo` with long-lived caching, the
 * favicon, and the shell's script. Names are matched strictly, so nothing
 * outside those folders is reachable.
 */
export function assetRoutes(): express.Router {
  const router = express.Router()
  const send = (res: express.Response, file: string): void => {
    const type = types[path.extname(file)]
    if (type == null || !existsSync(file)) {
      res.status(404).send('Not found')
      return
    }
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    res.type(type).sendFile(file, { dotfiles: 'allow' })
  }
  for (const folder of ['fonts', 'logo'])
    router.get(`/assets/${folder}/:file`, (req, res) => {
      const name = String(req.params.file)
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
        res.status(404).send('Not found')
        return
      }
      send(res, path.join(assetsDir, folder, name))
    })
  router.get('/favicon.ico', (_req, res) => {
    send(res, path.join(assetsDir, 'logo', 'favicon.ico'))
  })
  router.get('/assets/shell.js', (_req, res) => {
    res
      .type('js')
      .sendFile(
        fileURLToPath(new URL('../browser/shell.js', import.meta.url)),
        {
          dotfiles: 'allow',
        },
      )
  })
  return router
}
