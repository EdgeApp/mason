import type express from 'express'
import { nodeWebApp, sendPage, type WebAppContext } from '../node/webApp.js'

/** The host's public web listener. */
export function hostApp(context: WebAppContext): express.Express {
  const app = nodeWebApp(context)
  app.get('/', (_req, res) => {
    sendPage(
      res,
      context,
      'Mason',
      '<section class="card"><p>This Mason host is waiting for its master.</p></section>',
      503,
    )
  })
  app.use((_req, res) => {
    res.status(404).send('Not found')
  })
  return app
}
