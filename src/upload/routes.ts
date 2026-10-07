import Busboy from 'busboy'
import { asObject } from 'cleaners'
import { Router, type Request, type Response } from 'express'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Store } from '../store.js'
import { asChannel, asFormat, asId, type Format } from '../validation.js'
import {
  asUploadFields,
  asVersionFields,
  uploadFieldNames,
} from './fields.js'
import { ApiKeys } from './keys.js'
import { packageIdentity } from './metadata.js'
import { uploadResponse } from './response.js'

class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
function authorize(
  store: Store,
  keys: ApiKeys,
  fields: Record<string, unknown>,
): ReturnType<typeof asChannel> {
  try {
    const row = asObject({ id: asId })(
      store.db
        .prepare('SELECT id FROM channels WHERE channel_key=?')
        .get(
          typeof fields.channel_key === 'string' ? fields.channel_key : '',
        ),
    )
    const channel = store.channel(row.id)
    keys.authenticate(fields.token, channel.app_id)
    return channel
  } catch {
    throw new UploadError(
      401,
      'Valid token and channel_key must precede the file',
    )
  }
}
function errorResponse(res: Response, error: unknown): void {
  if (res.destroyed || res.headersSent) return
  const known = error instanceof UploadError
  res.status(known ? error.status : 400).json({
    error: known ? error.message : 'Invalid upload request or package',
  })
}

/** Streaming boundary. No file is opened until a scoped key authenticates. */
async function receive(
  req: Request,
  store: Store,
  keys: ApiKeys,
): Promise<{
  reservation: string
  format: Format
  size: number
  digest: string
  fields: ReturnType<typeof asUploadFields>
  channel: ReturnType<typeof asChannel>
}> {
  const fields: Record<string, unknown> = Object.create(null)
  for (const [key, value] of Object.entries(req.query)) {
    if (!uploadFieldNames.has(key) || typeof value !== 'string')
      throw new UploadError(400, 'Unsupported or duplicate upload field')
    fields[key] = value
  }
  const encoding = req.headers['content-encoding']
  if (encoding != null && encoding !== 'identity')
    throw new UploadError(415, 'Compressed request bodies are unsupported')
  const parser = Busboy({
    headers: req.headers,
    limits: {
      fileSize: store.config.packageBytes + 1,
      files: 1,
      fields: 11,
      parts: 13,
      fieldSize: 65536,
      fieldNameSize: 80,
      headerPairs: 50,
    },
  })
  let reservation: string | undefined,
    format: Format | undefined,
    channel: ReturnType<typeof asChannel> | undefined,
    size = 0,
    fileTask: Promise<void> | undefined,
    fileStream: Readable | undefined,
    failed: unknown,
    seen = false
  const hash = createHash('sha256')
  let fail: (error: unknown) => void = () => {}
  const onAborted = (): void =>
    fail(new UploadError(400, 'Upload interrupted'))
  const onIdle = (): void => fail(new UploadError(408, 'Upload timed out'))
  const timer = setTimeout(onIdle, 90 * 60000)
  req.setTimeout(60000, onIdle)
  req.once('aborted', onAborted)
  try {
    await new Promise<void>((resolve, reject) => {
      fail = (error): void => {
        if (failed != null) return
        failed = error
        req.unpipe(parser)
        req.pause()
        fileStream?.destroy(new Error('Transfer stopped'))
        parser.destroy()
        reject(error)
      }
      parser.on('error', fail)
      parser.on('filesLimit', () =>
        fail(new UploadError(400, 'Exactly one file is required')),
      )
      parser.on('fieldsLimit', () =>
        fail(new UploadError(400, 'Too many upload fields')),
      )
      parser.on('partsLimit', () =>
        fail(new UploadError(400, 'Too many upload parts')),
      )
      parser.on('field', (name, value, info) => {
        if (
          info.nameTruncated ||
          info.valueTruncated ||
          !uploadFieldNames.has(name) ||
          Object.hasOwn(fields, name)
        ) {
          fail(
            new UploadError(
              400,
              'Unsupported, oversized or duplicate upload field',
            ),
          )
          return
        }
        fields[name] = value
      })
      parser.on('file', (name, stream, info) => {
        fileStream = stream
        stream.on('error', fail)
        try {
          if (seen || name !== 'file')
            throw new UploadError(400, 'Exactly one file is required')
          seen = true
          channel = authorize(store, keys, fields)
          format = asFormat(info.filename.split('.').pop()?.toLowerCase())
          const allowed: unknown = JSON.parse(channel.formats)
          if (!Array.isArray(allowed) || !allowed.includes(format))
            throw new UploadError(400, 'File format does not match channel')
          const key = keys.authenticate(fields.token, channel.app_id)
          try {
            reservation = store.reserve(key.id, store.config.packageBytes)
          } catch {
            throw new UploadError(
              503,
              'Upload capacity is unavailable; retry later',
            )
          }
          stream.once('limit', () =>
            fail(new UploadError(413, 'Package exceeds upload limit')),
          )
          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback): void {
              size += chunk.length
              hash.update(chunk)
              callback(null, chunk)
            },
          })
          fileTask = pipeline(
            stream,
            counter,
            createWriteStream(store.incomingPath(reservation), {
              flags: 'wx',
              mode: 0o600,
            }),
          )
          void fileTask.catch(fail)
        } catch (error) {
          fail(error)
        }
      })
      parser.once('close', () => {
        if (failed == null) resolve()
      })
      req.pipe(parser)
    })
    await fileTask
    if (failed != null) throw failed
    if (
      reservation == null ||
      format == null ||
      channel == null ||
      size === 0
    )
      throw new UploadError(400, 'A nonempty package file is required')
    const cleaned = asUploadFields(fields)
    authorize(store, keys, fields)
    return {
      reservation,
      format,
      channel,
      fields: cleaned,
      size,
      digest: hash.digest('hex'),
    }
  } catch (error) {
    // Wait for the file descriptor to close before removing an interrupted stage.
    await fileTask?.catch(() => {})
    if (reservation != null) store.cancel(reservation)
    throw error
  } finally {
    clearTimeout(timer)
    req.setTimeout(0)
    req.off('timeout', onIdle)
    req.off('aborted', onAborted)
  }
}
export function uploadRoutes(store: Store): Router {
  const router = Router(),
    keys = new ApiKeys(store)
  const attempts = new Map<string, { count: number; until: number }>()
  router.use('/api/apps', (req, res, next) => {
    const now = store.now(),
      id = req.ip ?? 'unknown'
    for (const [key, value] of attempts)
      if (value.until <= now) attempts.delete(key)
    const prior = attempts.get(id) ?? { count: 0, until: now + 60000 }
    if (
      ++prior.count > 120 ||
      (!attempts.has(id) && attempts.size >= 10000)
    ) {
      errorResponse(res, new UploadError(429, 'Too many API requests'))
      return
    }
    attempts.set(id, prior)
    next()
  })
  router.post('/api/apps/upload', async (req, res) => {
    let reservation: string | undefined
    try {
      const received = await receive(req, store, keys)
      reservation = received.reservation
      const { fields, channel, format, size, digest } = received
      if (Object.hasOwn(fields.custom_fields, 'masonUpload'))
        throw new UploadError(400, 'masonUpload is reserved metadata')
      const identity = await packageIdentity(
        store.incomingPath(reservation),
        format,
        fields.custom_fields,
      )
      let build
      try {
        build = store.publish(
          reservation,
          {
            channelId: channel.id,
            branch: fields.branch,
            commit: fields.git_commit,
            ...identity,
            format,
            size,
            digest,
            changelog: fields.changelog,
            source: fields.source,
            customFields: JSON.stringify({
              masonUpload: {
                ci_url: fields.ci_url,
                release_type: fields.release_type,
                custom_fields: fields.custom_fields,
              },
            }),
          },
          () => {
            authorize(store, keys, fields)
          },
        )
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Build publication conflict'
        )
          throw new UploadError(
            409,
            'Build number conflicts with an existing publication',
          )
        throw error
      }
      reservation = undefined
      try {
        store.prune()
      } catch {
        console.error('Mason post-upload retention check failed')
      }
      res.status(201).json(uploadResponse(store, build))
    } catch (error) {
      if (reservation != null) store.cancel(reservation)
      // A rejected unread request must not keep streaming on a reusable socket.
      res.set('Connection', 'close')
      errorResponse(res, error)
      res.once('finish', () => req.destroy())
    }
  })
  router.get('/api/apps/version_exist', (req, res) => {
    try {
      const fields = asVersionFields(req.query),
        channel = authorize(store, keys, fields)
      if (
        fields.git_commit == null &&
        (fields.release_version == null || fields.build_version == null)
      )
        throw new UploadError(
          400,
          'Provide bundle_id and git_commit or release_version and build_version',
        )
      const found = store
        .builds(channel.app_id)
        .find(
          (build) =>
            build.channel_id === channel.id &&
            build.bundle_id === fields.bundle_id &&
            (fields.git_commit == null ||
              build.commit_hash === fields.git_commit) &&
            (fields.release_version == null ||
              build.version === fields.release_version) &&
            (fields.build_version == null ||
              build.build_number === fields.build_version),
        )
      if (found == null) throw new UploadError(404, 'Build not found')
      res.json(uploadResponse(store, found))
    } catch (error) {
      errorResponse(res, error)
    }
  })
  return router
}
