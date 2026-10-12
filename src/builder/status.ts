import { escape, stylesheet } from '../view.js'
import type { QueueEntry } from './server.js'

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`
  if (m > 0) return `${m} min ${String(s).padStart(2, '0')} s`
  return `${s} s`
}
function time(ms: number): string {
  return `<time data-at="${ms}" datetime="${new Date(ms).toISOString()}">${escape(new Date(ms).toISOString().replace('T', ' ').slice(0, 19))} UTC</time>`
}
function elapsed(since: number, now: number): string {
  return `<span data-since="${since}">${duration(now - since)}</span>`
}
function field(label: string, value: string): string {
  return `<dt>${escape(label)}</dt><dd>${value}</dd>`
}
function card(job: QueueEntry, appName: string, now: number): string {
  const active = job.status !== 'queued'
  const commit = job.commit_sha ?? job.requested_commit
  const caller =
    job.client_ip == null
      ? 'Not recorded'
      : `${escape(job.client_ip)}${job.client_name == null ? '' : ` <small>${escape(job.client_name)}</small>`}`
  const held =
    job.quarantine === 1 && job.status !== 'running' && job.status !== 'queued'
      ? `<p class="notice">Holding the worker after ${escape(job.status.replace('_', ' '))}${job.quarantine_reason == null ? '' : `: ${escape(job.quarantine_reason)}`}</p>`
      : ''
  return `<article class="card job"><h2>${escape(appName)} <span class="branch">${escape(job.branch)}</span></h2>${held}<dl>${[
    field('App', `${escape(appName)} <small>${escape(job.app)}</small>`),
    field(
      'Commit',
      commit == null ? 'Resolved at checkout' : `<code>${escape(commit)}</code>`,
    ),
    field('Branch', escape(job.branch)),
    field('Status', escape(job.status.replaceAll('_', ' '))),
    field('Queued', time(job.created)),
    active && job.started != null ? field('Started', time(job.started)) : '',
    job.finished != null ? field('Finished', time(job.finished)) : '',
    !active
      ? field('In queue for', elapsed(job.created, now))
      : job.started == null
        ? ''
        : job.status === 'running'
          ? field('Running for', elapsed(job.started, now))
          : field('Ran for', duration((job.finished ?? now) - job.started)),
    field('Queued by', job.trigger === 'poll' ? 'Branch poll' : 'API'),
    job.trigger === 'api' ? field('Caller IP', caller) : '',
  ].join('')}</dl></article>`
}

const styles = `.job{max-width:none}.job h2{margin:0 0 14px}.branch{color:#8d9bad;font-weight:450}.job dl{display:grid;grid-template-columns:max-content 1fr;gap:8px 20px;margin:0}.job dt{color:#8d9bad}.job dd{margin:0;overflow-wrap:anywhere}.job dd small{display:inline;margin-left:6px}.job code{font-size:13px;color:#abc9f0}.job .notice{margin:0 0 14px}.empty{color:#8d9bad}section{margin-bottom:36px}@media(max-width:600px){.job dl{grid-template-columns:1fr;gap:2px}.job dd{margin-bottom:8px}}`

// Times arrive in UTC and durations as of rendering; the script shows times
// in the viewer's zone and keeps durations counting until the next refresh.
const script = `const f=s=>{s=Math.max(0,Math.floor(s/1e3));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),r=s%60;return h?h+' h '+String(m).padStart(2,'0')+' min':m?m+' min '+String(r).padStart(2,'0')+' s':r+' s'};for(const e of document.querySelectorAll('[data-at]'))e.textContent=new Date(+e.dataset.at).toLocaleString();const t=()=>{for(const e of document.querySelectorAll('[data-since]'))e.textContent=f(Date.now()-e.dataset.since)};setInterval(t,1e3)`

export function statusPage(
  jobs: QueueEntry[],
  appNames: Map<string, string>,
  now: number,
  nonce: string,
  recent: QueueEntry[] = [],
): string {
  const render = (job: QueueEntry): string =>
    card(job, appNames.get(job.app) ?? job.app, now)
  const active = jobs.filter((job) => job.status !== 'queued')
  const queued = jobs.filter((job) => job.status === 'queued')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>Build queue · Mason</title><style nonce="${nonce}">${stylesheet}${styles}</style></head><body><header><span class="brand">Mason<span>Build queue</span></span></header><main><section><h1>Building</h1>${
    active.length === 0
      ? '<p class="empty">Nothing is building.</p>'
      : active.map(render).join('')
  }</section><section><h1>Queued <span class="branch">${queued.length}</span></h1>${
    queued.length === 0
      ? '<p class="empty">The queue is empty.</p>'
      : queued.map(render).join('')
  }</section><section><h1>Recent Builds</h1>${
    recent.length === 0
      ? '<p class="empty">No recent builds yet.</p>'
      : recent.map(render).join('')
  }</section></main><script nonce="${nonce}">${script}</script></body></html>`
}
