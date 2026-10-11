import { loadConfig } from '../config.js'
import { Store } from '../store.js'
import { asId, asFileKey } from '../validation.js'
import { inspectProvisioning, saveProvisioning } from './provisioning.js'
export async function backfillDevices(file: string): Promise<void> {
  const store = new Store(loadConfig(file))
  let verified = 0,
    unavailable = 0
  try {
    const cfg = store.config.devices
    if (!cfg) throw new Error('Device registration must be configured')
    for (const row of store.db
      .prepare(
        "SELECT id,file_key FROM builds WHERE state='ready' AND format='ipa' AND expires_at>?",
      )
      .all(store.now())) {
      try {
        saveProvisioning(
          store,
          asId(row.id),
          await inspectProvisioning(
            store.filePath(asFileKey(row.file_key)),
            cfg.trustStoreFile,
            cfg.openssl,
          ),
        )
        verified++
      } catch {
        unavailable++
      }
    }
    console.log(JSON.stringify({ verified, unavailable }))
  } finally {
    store.close()
  }
}
