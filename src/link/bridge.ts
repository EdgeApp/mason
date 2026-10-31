import type { Stream } from './link.js'

/**
 * Joins two link streams, as the master joins a node's stream to the
 * host's: what either end sends the other receives, in order, each chunk
 * paced by the credit of the stream it is written to. Resolves once both
 * directions have ended; an abort on either side aborts the other.
 */
export async function bridge(a: Stream, b: Stream): Promise<void> {
  const pipe = async (from: Stream, to: Stream): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      let chain = Promise.resolve()
      const fail = (reason: string): void => {
        from.abort(reason)
        to.abort(reason)
        reject(new Error(reason))
      }
      from.on('data', (chunk: Buffer) => {
        chain = chain
          .then(async () => await to.write(chunk))
          .catch((error: unknown) => {
            fail((error as Error).message)
          })
      })
      from.once('end', () => {
        void chain.then(() => {
          to.end()
          resolve()
        })
      })
      from.once('abort', (reason: string) => {
        fail(reason)
      })
    })
  }
  await Promise.all([pipe(a, b), pipe(b, a)])
}
