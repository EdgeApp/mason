import type express from 'express'
import { nodeWebApp, sendPage, type WebAppContext } from '../node/webApp.js'
import { masterApi } from './api.js'
import { projectsApi } from './projectsApi.js'
import type { Master } from './runtime.js'

export interface MasterWebContext extends WebAppContext {
  configured: () => boolean
  master: Master
}

/** The master's web listener: its UI and API. */
export function masterApp(context: MasterWebContext): express.Express {
  const app = nodeWebApp(context)
  app.use(projectsApi(context.master))
  app.use(
    masterApi({
      keys: context.master.keys,
      settings: context.master.settings,
      registry: context.master.registry,
    }),
  )
  app.get('/', (_req, res) => {
    if (context.configured())
      sendPage(res, context, 'Mason', '<p>This master is set up.</p>')
    else
      sendPage(
        res,
        context,
        'Set up this master',
        '<section class="card"><p>This Mason master has no account yet. Create the first account with <code>mason setup</code> on this computer, using the setup code the master printed when it started.</p></section>',
      )
  })
  app.use((_req, res) => {
    res.status(404).send('Not found')
  })
  return app
}
