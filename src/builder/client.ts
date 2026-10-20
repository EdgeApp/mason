import { readFileSync, statSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { asObject, asOptional, asString } from 'cleaners'
import { readPrivateJson, noSymlinks } from '../config.js'
import { asClientConfig, statuses } from './store.js'
import { asRequest } from './config.js'
import { oneOf, text } from '../validation.js'
import { pinnedFetch } from '../node/pinnedFetch.js'

export async function buildClient(
  file: string,
  input: unknown,
  output: (value: string) => void = console.log,
): Promise<boolean> {
  file = realpathSync(file)
  const config = asClientConfig(readPrivateJson(file))
  const url = new URL(config.url)
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  )
    throw new Error('Expected builder origin')
  const keyFile = path.resolve(path.dirname(file), config.keyFile)
  noSymlinks(keyFile)
  const stat = statSync(keyFile)
  if (
    !stat.isFile() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 100 ||
    (process.getuid != null && stat.uid !== process.getuid())
  )
    throw new Error('Invalid key file permissions')
  const key = readFileSync(keyFile, 'utf8').trim()
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid builder key')
  const request = asRequest(input)
  const response = await pinnedFetch(
    new URL('/api/jobs', url),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...request,
        idempotencyKey: request.idempotencyKey ?? randomUUID(),
      }),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    },
    config.pin,
  )
  if (!response.ok) throw new Error('Builder rejected job')
  const clean = asObject({
    id: text(36),
    status: oneOf(statuses),
    commit_sha: asOptional(asString),
    result: asOptional((value: unknown): unknown => value),
  })
  let job = clean(await response.json())
  output(JSON.stringify(job))
  while (['queued', 'running'].includes(job.status)) {
    await new Promise((resolve) => setTimeout(resolve, config.pollMs))
    const response = await pinnedFetch(
      new URL(`/api/jobs/${job.id}`, url),
      {
        headers: { Authorization: `Bearer ${key}` },
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      },
      config.pin,
    )
    if (!response.ok) throw new Error('Could not read builder status')
    job = clean(await response.json())
  }
  output(JSON.stringify(job))
  return job.status === 'succeeded'
}
