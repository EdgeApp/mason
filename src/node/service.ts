import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { PAIRING_FILE } from './identity.js'
import type { Role } from './serve.js'

/** What service installation needs from the operating system. */
export interface ServiceSystem {
  platform: 'darwin' | 'linux'
  /** Effective user ID of this process. */
  euid: number
  env: Record<string, string | undefined>
  /** A user's IDs and home directory, or undefined when there is none. */
  user(name: string): { uid: number; gid: number; home: string } | undefined
  /** Creates a system user with a home directory and no login shell. */
  createSystemUser(name: string, home: string, groups: string[]): void
  groupExists(name: string): boolean
  writeFile(
    file: string,
    content: string,
    owner: { uid: number; gid: number },
    mode: number,
  ): void
  removeFile(file: string): void
  makeDirectory(
    dir: string,
    owner: { uid: number; gid: number },
    mode: number,
  ): void
  /** Runs a command; `allowFailure` ignores a nonzero exit. */
  run(command: string, args: string[], allowFailure?: boolean): void
}

export interface ServiceRequest {
  role: Role
  coWorker?: boolean
  /** `--data` as given, or undefined for the service user's default. */
  data?: string
  /** `--user` as given. */
  user?: string
  /** The program that starts Mason: Node and the CLI script, or a launcher. */
  program: string[]
  /** Options passed on to the service (`--port`, `--link-port`, …). */
  args: string[]
  /** A cloud machine's pairing file's content, written owner-only into the data directory. */
  pairingFile?: string
}

export interface ServiceInstall {
  label: string
  file: string
  user: string
  uid: number
  data: string
}

const SYSTEM_USER = 'mason'
const SYSTEM_HOME = '/var/lib/mason'

export const serviceLabel = (role: Role): string => `app.mason.${role}`

/** Escapes a string for a launchd plist. */
function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}
/** Quotes a word for a systemd `ExecStart=` line. */
function systemdWord(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
}

/**
 * The account a service runs as: `--user`, else the user who ran `sudo`, else
 * — on a Linux machine with only root, as on a fresh server or under
 * cloud-init — the `mason` system user.
 */
function serviceUser(
  request: ServiceRequest,
  system: ServiceSystem,
): { name: string; uid: number; gid: number; home: string; created: boolean } {
  if (system.euid !== 0)
    throw new Error('Installing a service needs root: run it with sudo')
  let name = request.user ?? system.env.SUDO_USER
  if (name === 'root') name = undefined
  if (name == null) {
    if (system.platform === 'darwin')
      throw new Error(
        'Run this with sudo from the account the service should run as, or pass --user',
      )
    let account = system.user(SYSTEM_USER)
    let created = false
    if (account == null) {
      system.createSystemUser(
        SYSTEM_USER,
        SYSTEM_HOME,
        system.groupExists('docker') ? ['docker'] : [],
      )
      account = system.user(SYSTEM_USER)
      created = true
      if (account == null) throw new Error('Could not create the mason user')
    }
    return { name: SYSTEM_USER, ...account, created }
  }
  const account = system.user(name)
  if (account == null) throw new Error(`No user named ${name}`)
  if (account.uid === 0) throw new Error('A Mason service never runs as root')
  return { name, ...account, created: false }
}

/** A node's update request, in its data directory: `{ version, at }`. */
export const UPDATE_REQUEST = 'update-request.json'

/** The systemd units (`.path` and `.service`) that update a role's install as root. */
export function updaterUnit(role: string): string {
  return `mason-${role}-update`
}

/** Installs the role as a service of its user and starts it. */
export function installService(
  request: ServiceRequest,
  system: ServiceSystem,
): ServiceInstall {
  const user = serviceUser(request, system)
  const owner = { uid: user.uid, gid: user.gid }
  const data = path.resolve(request.data ?? path.join(user.home, '.mason'))
  system.makeDirectory(data, owner, 0o700)
  // A cloud machine's pairing material is in place before the service first starts.
  if (request.pairingFile != null)
    system.writeFile(
      path.join(data, PAIRING_FILE),
      request.pairingFile,
      owner,
      0o600,
    )
  const label = serviceLabel(request.role)
  const command = [
    ...request.program,
    request.role,
    ...(request.coWorker ? ['--worker'] : []),
    '--data',
    data,
    ...request.args.filter((word) => word !== '--worker'),
  ]
  if (system.platform === 'darwin') {
    const agents = path.join(user.home, 'Library', 'LaunchAgents')
    system.makeDirectory(agents, owner, 0o755)
    const file = path.join(agents, label + '.plist')
    const log = path.join(data, `${request.role}.log`)
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((word) => `    <string>${xml(word)}</string>`).join('\n')}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
    system.writeFile(file, plist, owner, 0o644)
    const domain = `gui/${user.uid}`
    system.run('launchctl', ['bootout', `${domain}/${label}`], true)
    system.run('launchctl', ['bootstrap', domain, file])
    return { label, file, user: user.name, uid: user.uid, data }
  }
  const unit = `mason-${request.role}`
  const file = `/etc/systemd/system/${unit}.service`
  const content = `[Unit]
Description=Mason ${request.role}
After=network-online.target
Wants=network-online.target

[Service]
User=${user.name}
Group=${user.gid}
Environment=HOME=${systemdWord(user.home)}
ExecStart=${command.map(systemdWord).join(' ')}
Restart=always
RestartSec=5
# A stage's process killed for memory fails that stage; the default (stop)
# would stop the whole service and cancel every stage on it.
OOMPolicy=continue
UMask=0077

[Install]
WantedBy=multi-user.target
`
  system.writeFile(file, content, { uid: 0, gid: 0 }, 0o644)
  // The node's updater: over its link the node only writes a request naming
  // a version in its data directory; root installs that release.
  const updater = updaterUnit(request.role)
  const requestFile = path.join(data, UPDATE_REQUEST)
  system.writeFile(
    `/etc/systemd/system/${updater}.path`,
    `[Unit]
Description=Mason ${request.role} update requests

[Path]
PathExists=${systemdWord(requestFile)}
Unit=${updater}.service

[Install]
WantedBy=multi-user.target
`,
    { uid: 0, gid: 0 },
    0o644,
  )
  system.writeFile(
    `/etc/systemd/system/${updater}.service`,
    `[Unit]
Description=Mason ${request.role} update to the requested release

[Service]
Type=oneshot
ExecStart=${[...request.program, 'update', '--request', requestFile].map(systemdWord).join(' ')}
`,
    { uid: 0, gid: 0 },
    0o644,
  )
  system.run('systemctl', ['daemon-reload'])
  system.run('systemctl', ['enable', unit])
  system.run('systemctl', ['enable', '--now', `${updater}.path`])
  system.run('systemctl', ['restart', unit])
  return { label: unit, file, user: user.name, uid: user.uid, data }
}

/** Stops and removes the role's service; its data directory stays. */
export function uninstallService(
  request: Pick<ServiceRequest, 'role' | 'user'>,
  system: ServiceSystem,
): { label: string; file: string } {
  if (system.euid !== 0)
    throw new Error('Removing a service needs root: run it with sudo')
  const label = serviceLabel(request.role)
  if (system.platform === 'darwin') {
    let name = request.user ?? system.env.SUDO_USER
    if (name === 'root') name = undefined
    if (name == null)
      throw new Error(
        'Run this with sudo from the account the service runs as, or pass --user',
      )
    const user = system.user(name)
    if (user == null) throw new Error(`No user named ${name}`)
    const file = path.join(
      user.home,
      'Library',
      'LaunchAgents',
      label + '.plist',
    )
    system.run('launchctl', ['bootout', `gui/${user.uid}/${label}`], true)
    system.removeFile(file)
    return { label, file }
  }
  const unit = `mason-${request.role}`
  const file = `/etc/systemd/system/${unit}.service`
  const updater = updaterUnit(request.role)
  system.run('systemctl', ['disable', '--now', `${updater}.path`], true)
  system.run('systemctl', ['disable', '--now', unit], true)
  system.removeFile(file)
  system.removeFile(`/etc/systemd/system/${updater}.path`)
  system.removeFile(`/etc/systemd/system/${updater}.service`)
  system.run('systemctl', ['daemon-reload'])
  return { label: unit, file }
}

type Exec = (
  command: string,
  args: string[],
  options: { encoding?: 'utf8'; stdio?: unknown },
) => string | Buffer

/** The real operating system; `exec` runs its commands. */
export function hostSystem(
  platform: NodeJS.Platform = process.platform,
  exec: Exec = execFileSync as unknown as Exec,
): ServiceSystem {
  if (platform !== 'darwin' && platform !== 'linux')
    throw new Error('Services are installed on macOS and Linux')
  const output = (command: string, args: string[]): string | undefined => {
    try {
      return String(
        exec(command, args, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
      ).trim()
    } catch {
      return undefined
    }
  }
  return {
    platform,
    euid: process.geteuid?.() ?? -1,
    env: process.env,
    user(name): { uid: number; gid: number; home: string } | undefined {
      if (!/^[a-z_][a-z0-9_.-]*$/i.test(name)) return undefined
      const uid = output('id', ['-u', name])
      const gid = output('id', ['-g', name])
      if (uid == null || gid == null) return undefined
      const home =
        platform === 'darwin'
          ? output('dscl', ['.', '-read', `/Users/${name}`, 'NFSHomeDirectory'])
              ?.split(':')[1]
              ?.trim()
          : output('getent', ['passwd', name])?.split(':')[5]
      if (home == null || home === '') return undefined
      return { uid: Number(uid), gid: Number(gid), home }
    },
    createSystemUser(name, home, groups): void {
      exec(
        'useradd',
        [
          '--system',
          '--create-home',
          '--home-dir',
          home,
          '--shell',
          '/usr/sbin/nologin',
          ...(groups.length === 0 ? [] : ['--groups', groups.join(',')]),
          name,
        ],
        { stdio: 'ignore' },
      )
    },
    groupExists: (name) => output('getent', ['group', name]) != null,
    writeFile(file, content, owner, mode): void {
      writeFileSync(file, content, { mode })
      chmodSync(file, mode)
      chownSync(file, owner.uid, owner.gid)
    },
    removeFile: (file) => rmSync(file, { force: true }),
    makeDirectory(dir, owner, mode): void {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode })
      chmodSync(dir, mode)
      chownSync(dir, owner.uid, owner.gid)
    },
    run(command, args, allowFailure = false): void {
      try {
        exec(command, args, { stdio: 'ignore' })
      } catch (error) {
        if (!allowFailure) throw error
      }
    },
  }
}

export const HELPER_LABEL = 'app.mason.helper'

/**
 * Installs the privileged helper as a root LaunchDaemon (macOS) or systemd
 * unit (Linux) serving the given user's Mason service.
 */
export function installHelperService(
  request: Pick<ServiceRequest, 'user' | 'program'>,
  system: ServiceSystem,
): { label: string; file: string } {
  const user = serviceUser(
    {
      role: 'worker',
      program: request.program,
      args: [],
      ...(request.user == null ? {} : { user: request.user }),
    },
    system,
  )
  const command = [...request.program, 'helper', '--user', user.name]
  const root = { uid: 0, gid: 0 }
  if (system.platform === 'darwin') {
    const file = `/Library/LaunchDaemons/${HELPER_LABEL}.plist`
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${HELPER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${command.map((word) => `    <string>${xml(word)}</string>`).join('\n')}
  </array>
  <key>UserName</key><string>root</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Library/Logs/mason-helper.log</string>
  <key>StandardErrorPath</key><string>/Library/Logs/mason-helper.log</string>
</dict>
</plist>
`
    system.writeFile(file, plist, root, 0o644)
    system.run('launchctl', ['bootout', `system/${HELPER_LABEL}`], true)
    system.run('launchctl', ['bootstrap', 'system', file])
    return { label: HELPER_LABEL, file }
  }
  const file = '/etc/systemd/system/mason-helper.service'
  const content = `[Unit]
Description=Mason privileged helper for ${user.name}

[Service]
ExecStart=${command.map(systemdWord).join(' ')}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`
  system.writeFile(file, content, root, 0o644)
  system.run('systemctl', ['daemon-reload'])
  system.run('systemctl', ['enable', 'mason-helper'])
  system.run('systemctl', ['restart', 'mason-helper'])
  return { label: 'mason-helper', file }
}

/** Stops and removes the helper; its stored master key goes with it. */
export function uninstallHelperService(
  system: ServiceSystem,
  keyFile: string,
): { label: string; file: string } {
  if (system.euid !== 0)
    throw new Error('Removing a service needs root: run it with sudo')
  system.removeFile(keyFile)
  if (system.platform === 'darwin') {
    const file = `/Library/LaunchDaemons/${HELPER_LABEL}.plist`
    system.run('launchctl', ['bootout', `system/${HELPER_LABEL}`], true)
    system.removeFile(file)
    return { label: HELPER_LABEL, file }
  }
  const file = '/etc/systemd/system/mason-helper.service'
  system.run('systemctl', ['disable', '--now', 'mason-helper'], true)
  system.removeFile(file)
  system.run('systemctl', ['daemon-reload'])
  return { label: 'mason-helper', file }
}
