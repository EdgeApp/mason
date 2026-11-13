// What Install apps' routes share on each node: the device and platform a
// request carries, a grant's files, and the registration QR code.
import type { Request, Response } from 'express'
import QRCode from 'qrcode'
import type { Platform } from '../validation.js'
import type { FileRequest } from './install.js'
import { platform } from './platform.js'
import type { CatalogSource } from './source.js'

/** The device cookie each node keeps for its own origin. */
export const deviceCookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 30 * 86400000,
}

/** The device a request's cookie selects, unchecked: the source checks it is the caller's. */
export function selectedDevice(req: Request): number | undefined {
  const id = /(?:^|;\s*)__Host-mason-device=(\d+)(?:;|$)/.exec(
    req.headers.cookie ?? '',
  )?.[1]
  return id == null ? undefined : Number(id)
}

/** The platform a catalog request is for: `?platform=`, the remembered choice, else the browser's. */
export function chosenPlatform(req: Request): Platform {
  const preferences = (req.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('mason-platform='))
  return platform(
    req.query.platform,
    preferences.length === 1 ? preferences[0]!.slice(15) : undefined,
    req.get('user-agent') ?? '',
  )
}

/**
 * A grant's manifest or package, from `/install/:token/:part`: false (and
 * nothing sent) for a part that is neither. Grants carry no session.
 */
export async function sendInstallFile(
  files: CatalogSource,
  req: Request,
  res: Response,
): Promise<boolean> {
  const part = String(req.params.part)
  if (part !== 'manifest.plist' && part !== 'artifact') return false
  const request: FileRequest = {
    method: req.method === 'HEAD' ? 'HEAD' : 'GET',
    ...(req.get('range') == null ? {} : { range: req.get('range')! }),
    ...(req.get('if-range') == null ? {} : { ifRange: req.get('if-range')! }),
  }
  await files.installFile(String(req.params.token), part, request, res)
  return true
}

/** The device-registration QR code: an SVG of the address it opens. */
export async function qrSvg(url: string): Promise<string> {
  return await QRCode.toString(url, {
    type: 'svg',
    margin: 2,
    color: { dark: '#10151e', light: '#ffffff' },
  })
}
