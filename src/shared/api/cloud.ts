import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  asValue,
} from 'cleaners'

/** `GET|POST /api/v2/cloud/accounts`, master only. */
export const CLOUD_ACCOUNTS_PATH = '/api/v2/cloud/accounts'
/** `PUT /api/v2/cloud/accounts/:id/key`: replaces an account's key. */
export const cloudAccountKeyPath = (id: string): string =>
  `${CLOUD_ACCOUNTS_PATH}/${encodeURIComponent(id)}/key`
/** `POST /api/v2/cloud/accounts/:id/check`: asks the provider again. */
export const cloudAccountCheckPath = (id: string): string =>
  `${CLOUD_ACCOUNTS_PATH}/${encodeURIComponent(id)}/check`
/** `DELETE /api/v2/cloud/accounts/:id`. */
export const cloudAccountPath = (id: string): string =>
  `${CLOUD_ACCOUNTS_PATH}/${encodeURIComponent(id)}`
/** `GET /api/v2/cloud/accounts/:id/catalog`: a DigitalOcean account's regions, sizes and images. */
export const cloudCatalogPath = (id: string): string =>
  `${CLOUD_ACCOUNTS_PATH}/${encodeURIComponent(id)}/catalog`

export type CloudProviderName = 'digitalocean' | 'nomac'

/** What the last check of an account's key found. */
export interface CloudAccountCheck {
  state: 'ok' | 'refused' | 'timeout' | 'unavailable' | 'error'
  checkedAt: number
  /** Why it is not ok. */
  message?: string
  digitalocean?: { email: string; dropletLimit: number; status: string }
  nomac?: {
    /** Spendable credit in dollars. */
    credit: number
    spendableSeconds: number
    concurrency: number
    spendingBlocked: boolean
  }
}

/** A cloud account as `GET /api/v2/cloud/accounts` lists it: the key only as set, and its last check. */
export interface CloudAccountView {
  id: string
  name: string
  provider: CloudProviderName
  key: { set: boolean }
  /** Whether an administrator entered its key, so a host may be made in it. */
  adminKeyed: boolean
  /** The last check, if any; the list never checks again. */
  check?: CloudAccountCheck
}

/** What `GET …/catalog` answers. */
export interface CloudCatalog {
  regions: Array<{ slug: string; name: string }>
  sizes: Array<{
    slug: string
    description: string
    /** Dollars per month. */
    priceMonthly: number
    regions: string[]
  }>
  images: Array<{ slug: string; name: string }>
}

export const asCloudProviderName = asValue('digitalocean', 'nomac')

export const asCloudAccountCheck = asObject<CloudAccountCheck>({
  state: asValue('ok', 'refused', 'timeout', 'unavailable', 'error'),
  checkedAt: asNumber,
  message: asOptional(asString),
  digitalocean: asOptional(
    asObject({ email: asString, dropletLimit: asNumber, status: asString }),
  ),
  nomac: asOptional(
    asObject({
      credit: asNumber,
      spendableSeconds: asNumber,
      concurrency: asNumber,
      spendingBlocked: asBoolean,
    }),
  ),
})

export const asCloudAccountView = asObject<CloudAccountView>({
  id: asString,
  name: asString,
  provider: asCloudProviderName,
  key: asObject({ set: asBoolean }),
  adminKeyed: asBoolean,
  check: asOptional(asCloudAccountCheck),
})
export const asCloudAccountViews = asArray(asCloudAccountView)

export const asCloudCatalog = asObject<CloudCatalog>({
  regions: asArray(asObject({ slug: asString, name: asString })),
  sizes: asArray(
    asObject({
      slug: asString,
      description: asString,
      priceMonthly: asNumber,
      regions: asArray(asString),
    }),
  ),
  images: asArray(asObject({ slug: asString, name: asString })),
})
