import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { androidManifest } from './androidManifest.js'
import { NOT_SIMULATOR, plistIdentity, simulatorIdentity } from './plist.js'
if (!isMainThread) {
  try {
    const data: unknown = workerData
    if (
      data == null ||
      typeof data !== 'object' ||
      !('buffer' in data) ||
      !('format' in data) ||
      !(data.buffer instanceof Uint8Array) ||
      data.buffer.length > 1024 * 1024
    )
      throw new Error('Invalid metadata')
    const buffer = Buffer.from(data.buffer)
    const result =
      data.format === 'ipa'
        ? plistIdentity(buffer)
        : data.format === 'apk'
          ? androidManifest(buffer)
          : data.format === 'zip'
            ? simulatorIdentity(buffer)
            : undefined
    if (result == null) throw new Error('Unknown metadata format')
    parentPort!.postMessage({ ok: true, identity: result })
  } catch (error) {
    // Only a device app in a simulator zip is told apart; any other failure is just invalid.
    parentPort!.postMessage({
      ok: false,
      ...((error as Error).message === NOT_SIMULATOR
        ? { reason: NOT_SIMULATOR }
        : {}),
    })
  }
}
