import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  type ReadStream,
} from 'node:fs'
import path from 'node:path'
import type { Stream } from '../link/link.js'

const runtimeName = /^(iOS|tvOS|watchOS|visionOS|xrOS) \d+(?:\.\d+){0,2}$/

/**
 * Simulator runtimes exported once by the first node that needs one
 * (`xcodebuild -downloadPlatform -exportPath`) and served to every other
 * node, which imports it through its helper.
 */
export class RuntimeStore {
  constructor(
    readonly dir: string,
    private readonly limit = 20 * 1024 ** 3,
  ) {}

  private file(name: unknown): string {
    if (typeof name !== 'string' || !runtimeName.test(name))
      throw new Error('Invalid simulator runtime name')
    return path.join(this.dir, `${name.replace(' ', '-')}.dmg`)
  }

  has(name: unknown): boolean {
    return existsSync(this.file(name))
  }

  list(): Array<{ name: string; size: number }> {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((file) => file.endsWith('.dmg'))
      .map((file) => ({
        name: file.slice(0, -4).replace('-', ' '),
        size: statSync(path.join(this.dir, file)).size,
      }))
  }

  open(name: unknown): ReadStream | undefined {
    const file = this.file(name)
    return existsSync(file) ? createReadStream(file) : undefined
  }

  /** Receives a runtime image over a link stream. */
  async put(name: unknown, stream: Stream): Promise<number> {
    const file = this.file(name)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.${Date.now()}.part`
    const out = createWriteStream(temporary, { mode: 0o600 })
    out.on('error', () => undefined)
    let size = 0
    try {
      await new Promise<void>((resolve, reject) => {
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > this.limit) {
            stream.abort('The runtime image is too large')
            reject(new Error('The runtime image is too large'))
            return
          }
          out.write(chunk)
        })
        stream.once('end', () => {
          out.end(() => {
            resolve()
          })
        })
        stream.once('abort', (reason: string) => {
          reject(new Error(reason))
        })
      })
      renameSync(temporary, file)
    } catch (error) {
      out.destroy()
      rmSync(temporary, { force: true })
      throw error
    }
    return size
  }
}
