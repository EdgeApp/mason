// What differs between the master and the host, in one place (the design
// plan's node-profile table). Pages take the profile from context and render
// the same components on both; a difference that does not fit here is the
// API answering different shapes, fixed on the server.
import { createContext, useContext } from 'react'
import type { NodeInfo } from '../../shared/api/index.js'

export interface NodeProfile {
  role: 'master' | 'host'
  /** The breadcrumbs' first pill: "Mason Master" or "Mason Host". */
  name: string
  /** The sidebar's node pill: "Master" or "Host". */
  short: string
  version: string
  /** Where a 401 sends the browser (a full load: `PASSWORD_PATHS`), given where it was. */
  signIn: (from: string) => string
  /** Where signing out leaves for: sign-in, saying so. */
  signedOut: string
  /** The top bar's cluster chips, from the master's workers. */
  clusterChips: boolean
  /** Seeding build numbers and Secrets live on the master only. */
  secrets: boolean
  /** Master-only destinations (Nodes, Cloud, People, Groups, Settings, Backups, Add a project). */
  admin: boolean
}

export const masterProfile = (version: string): NodeProfile => ({
  role: 'master',
  name: 'Mason Master',
  short: 'Master',
  version,
  signIn: () => '/sign-in',
  signedOut: '/sign-in?signed_out=1',
  clusterChips: true,
  secrets: true,
  admin: true,
})

export const hostProfile = (version: string): NodeProfile => ({
  role: 'host',
  name: 'Mason Host',
  short: 'Host',
  version,
  signIn: (from) => `/auth/login?return=${encodeURIComponent(from)}`,
  signedOut: '/auth/login?signed_out=1',
  clusterChips: false,
  secrets: false,
  admin: false,
})

/** The profile of the node `GET /api/v2/node` describes. */
export const profileFor = (node: NodeInfo): NodeProfile =>
  node.role === 'master'
    ? masterProfile(node.version)
    : hostProfile(node.version)

export const ProfileContext = createContext<NodeProfile>(masterProfile(''))

/** The node the app runs on. */
export const useProfile = (): NodeProfile => useContext(ProfileContext)
