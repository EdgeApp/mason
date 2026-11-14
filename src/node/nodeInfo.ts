import { Router } from 'express'
import { NODE_PATH, type NodeInfo } from '../shared/api/index.js'
import { repository, version } from '../version.js'

/** The release this node runs, when it comes from a GitHub repository. */
export function releaseInfo(): Pick<NodeInfo, 'release'> {
  return repository == null ? {} : { release: { repository, version } }
}

/**
 * `GET /api/v2/node`: what the web app reads before anyone signs in. It
 * needs no session, so a node mounts it ahead of its gates and forwarder.
 */
export function nodeInfoRoutes(info: () => NodeInfo): Router {
  const router = Router()
  router.get(NODE_PATH, (_req, res) => {
    res.json(info())
  })
  return router
}
