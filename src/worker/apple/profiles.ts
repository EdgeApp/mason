import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { StageSigning } from '../../pipeline/assignment.js'

/** Where Xcode looks for profiles: Xcode 16 and later, and earlier releases. */
export function profileDirectories(home = homedir()): string[] {
  return [
    path.join(
      home,
      'Library',
      'Developer',
      'Xcode',
      'UserData',
      'Provisioning Profiles',
    ),
    path.join(home, 'Library', 'MobileDevice', 'Provisioning Profiles'),
  ]
}

/**
 * Installs a stage's profiles by UUID where Xcode reads them. Returns the
 * files this stage added, which are the only ones it removes; a profile
 * already there (installed by hand or by another build) is left alone.
 */
export function installProfiles(
  signing: Pick<StageSigning, 'profiles' | 'platform'>,
  home = homedir(),
): string[] {
  const extension =
    signing.platform === 'macos' ? '.provisionprofile' : '.mobileprovision'
  const added: string[] = []
  for (const dir of profileDirectories(home)) {
    mkdirSync(dir, { recursive: true })
    for (const profile of signing.profiles) {
      if (!/^[0-9A-Fa-f-]{36}$/.test(profile.uuid))
        throw new Error(`Profile ${profile.name} has an invalid UUID`)
      const file = path.join(dir, profile.uuid + extension)
      if (existsSync(file)) continue
      writeFileSync(file, Buffer.from(profile.content, 'base64'), {
        mode: 0o644,
      })
      added.push(file)
    }
  }
  return added
}

export function removeProfiles(files: string[]): void {
  for (const file of files) rmSync(file, { force: true })
}

/** Xcode's `:c99extidentifier` of a bundle ID, for per-target build settings. */
export function c99(value: string): string {
  const out = value.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[0-9]/.test(out) ? `_${out}` : out
}

const methods: Record<StageSigning['distribution'], string> = {
  development: 'debugging',
  adHoc: 'release-testing',
  appStore: 'app-store-connect',
  macAppStore: 'app-store-connect',
  developerId: 'developer-id',
}

const escape = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** `ExportOptions.plist` for the stage's distribution: manual signing with its identity and profiles. */
export function exportOptions(signing: StageSigning): string {
  const profiles = signing.profiles
    .map(
      (profile) =>
        `<key>${escape(profile.bundleId)}</key><string>${escape(profile.name)}</string>`,
    )
    .join('')
  const entries: Array<[string, string]> = [
    ['method', `<string>${methods[signing.distribution]}</string>`],
    ['teamID', `<string>${escape(signing.team)}</string>`],
    ['signingStyle', '<string>manual</string>'],
    ['signingCertificate', `<string>${escape(signing.identity.sha1)}</string>`],
    ['provisioningProfiles', `<dict>${profiles}</dict>`],
    ['destination', '<string>export</string>'],
    ['stripSwiftSymbols', '<true/>'],
    ['manageAppVersionAndBuildNumber', '<false/>'],
    ...(signing.distribution === 'adHoc' ||
    signing.distribution === 'development'
      ? ([['thinning', '<string>&lt;none&gt;</string>']] as Array<
          [string, string]
        >)
      : []),
  ]
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>${entries.map(([key, value]) => `<key>${key}</key>${value}`).join('')}</dict></plist>
`
}

/** What `ctx.apple.signing` shows a stage that drives `xcodebuild` itself. */
export interface SigningSnapshot {
  teamId: string
  identity: string
  keychain: string
  profiles: Record<string, string>
  buildSettings: Record<string, string>
  exportOptions: string
}

/**
 * The build settings that sign every target with its own profile: each
 * target's `PROVISIONING_PROFILE_SPECIFIER` resolves through its bundle ID
 * to the `MASON_PROFILE_<bundle ID>` setting naming that profile.
 */
export function signingSnapshot(
  signing: StageSigning,
  keychain: string,
  exportOptionsFile: string,
): SigningSnapshot {
  const profiles = Object.fromEntries(
    signing.profiles.map((profile) => [profile.bundleId, profile.name]),
  )
  return {
    teamId: signing.team,
    identity: signing.identity.name,
    keychain,
    profiles,
    buildSettings: {
      CODE_SIGN_STYLE: 'Manual',
      DEVELOPMENT_TEAM: signing.team,
      CODE_SIGN_IDENTITY: signing.identity.name,
      OTHER_CODE_SIGN_FLAGS: `--keychain ${keychain}`,
      PROVISIONING_PROFILE_SPECIFIER:
        '$(MASON_PROFILE_$(PRODUCT_BUNDLE_IDENTIFIER:c99extidentifier))',
      ...Object.fromEntries(
        signing.profiles.map((profile) => [
          `MASON_PROFILE_${c99(profile.bundleId)}`,
          profile.name,
        ]),
      ),
    },
    exportOptions: exportOptionsFile,
  }
}
