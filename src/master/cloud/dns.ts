import type { MasterDatabase } from '../database.js'
import type { CloudProvider, DnsRecord } from './digitalocean.js'
import { fqdn, type CloudHostDns, type CloudHostRow } from './hosts.js'

/**
 * A cloud host's A record on DigitalOcean DNS. Reconcile makes the record
 * when there is none, adopts one that already holds the host's address,
 * points the record Mason made at a recreated droplet, and never touches a
 * record Mason did not make.
 */
export class HostDns implements CloudHostDns {
  constructor(private readonly master: MasterDatabase) {}

  private record(name: string, id: string | null, owned: boolean): void {
    this.master.db
      .prepare(
        "UPDATE cloud_hosts SET dns_record_id=?,dns_owned=?,updated_at=? WHERE name=? AND state<>'removed'",
      )
      .run(id, owned ? 1 : 0, this.master.now(), name)
  }

  async reconcile(
    row: CloudHostRow,
    provider: CloudProvider,
  ): Promise<string | undefined> {
    const name = fqdn(row)
    if (name == null || row.dns_domain == null || row.address == null)
      return undefined
    if (provider.dnsRecords == null)
      return `The ${row.provider} provider keeps no DNS records`
    const domains = (await provider.domains?.()) ?? []
    if (!domains.includes(row.dns_domain))
      return `The account's DNS holds no domain ${row.dns_domain}`
    const records = await provider.dnsRecords(row.dns_domain, name)
    const ours = records.find((record) => record.id === row.dns_record_id)
    const matching = records.find((record) => record.data === row.address)
    if (matching != null) {
      // Adopted: a record found rather than made stays not ours.
      if (matching.id !== row.dns_record_id)
        this.record(
          row.name,
          matching.id,
          row.dns_owned === 1 && matching.id === ours?.id,
        )
      return undefined
    }
    if (ours != null && row.dns_owned === 1) {
      await provider.updateDnsRecord!(row.dns_domain, ours.id, row.address)
      return undefined
    }
    const foreign = records[0]
    if (foreign != null)
      return `${name} points at ${foreign.data}, not this host`
    const made = await provider.createDnsRecord!(
      row.dns_domain,
      row.dns_name!,
      row.address,
    )
    this.record(row.name, made.id, true)
    return undefined
  }

  async remove(row: CloudHostRow, provider: CloudProvider): Promise<void> {
    if (
      row.dns_owned !== 1 ||
      row.dns_record_id == null ||
      row.dns_domain == null
    )
      return
    await provider.deleteDnsRecord?.(row.dns_domain, row.dns_record_id)
  }
}

export type { DnsRecord }
