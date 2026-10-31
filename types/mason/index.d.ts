/**
 * Types for Mason Masonfiles (`Masonfile.ts`).
 *
 * A pipeline Masonfile exports `setup(m: Setup)`, which declares workflows and
 * stages, and the stage functions that do the work, each receiving a `Stage`
 * context. The reference is `docs/masonfile.md` in the Mason repository.
 *
 * Import these with `import type`, which Node's type stripping erases, so a
 * Masonfile needs nothing at run time.
 */

/** A JSON value: what stage functions return and parameters carry. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  // An optional field may be undefined; JSON leaves it out.
  | { [key: string]: Json | undefined }

/** A length of time: `'90s'`, `'20m'`, `'4h'`, `'7d'`. */
export type Duration = `${number}s` | `${number}m` | `${number}h` | `${number}d`

export type Os = 'macos' | 'linux' | 'windows'
export type Arch = 'arm64' | 'x64'
export type Role = 'admin' | 'manager' | 'developer' | 'tester'
export type Platform = 'ios' | 'android' | 'macos' | 'windows'
export type TriggerKind =
  | 'push'
  | 'request'
  | 'schedule'
  | 'after'
  | 'deviceRegistered'
export type StageStatus =
  | 'succeeded'
  | 'unstable'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'interrupted'
  | 'skipped'

/**
 * Where a stage may run: a node type name (`'mac-xcode'`), `'master'` for the
 * master's own worker, or fields that must all match.
 */
export type NodeSelector =
  | string
  | {
      type?: string
      os?: Os
      arch?: Arch
      labels?: string[]
    }

/** Tool versions a stage needs; missing ones are installed before it starts. */
export interface Tools {
  /**
   * Each version-managed tool takes a version, or `'project'` for the
   * version the repository pins (section 7 lists the files). Versions are
   * installed side by side; the stage's are first on `PATH`.
   *
   * Node: major or exact, `'24'` or `'24.11.1'`; also in `NODE_BINARY`.
   */
  node?: string
  /** Temurin JDK, major or exact: `'21'`. */
  java?: string
  /** Toolchain: `'1.82.0'`, `'stable'`. */
  rust?: string
  /** CPython, minor or exact: `'3.12'`, `'3.12.7'`. */
  python?: string
  /** Minor or exact: `'1.23'`, `'1.23.4'`. */
  go?: string
  /** CRuby, minor or exact: `'3.3'`, `'3.3.5'`; built once per node, gems per version. */
  ruby?: string
  /** `sdkmanager` packages, `'platforms;android-35'`. */
  android?: string[]
  /** Exact version, range, Xcode build number, `'latest'` or `'latest-beta'`. */
  xcode?: string
  /** Simulator runtimes, `'iOS 26.1'`. */
  simulators?: string[]
  /** Homebrew formulae (macOS). */
  brew?: string[]
  /** apt packages (Linux). */
  apt?: string[]
  /** dnf packages (Linux). */
  dnf?: string[]
  /**
   * An exact CocoaPods version (`'1.16.2'`), macOS only: installed with its
   * own Ruby, no Homebrew or administrator needed. The stage's Xcode
   * compiles its native gems.
   */
  cocoapods?: string
  /** `'accept'`: this Masonfile accepts the Android SDK licences, so `android` packages install on any node. */
  androidLicenses?: 'accept'
}

export type ParamValue = string | number | boolean

export type ParamSpec =
  | {
      type: 'choice'
      choices: string[]
      default?: string
      description?: string
    }
  | { type: 'boolean'; default?: boolean; description?: string }
  | {
      type: 'number'
      default?: number
      min?: number
      max?: number
      description?: string
    }
  | { type: 'text'; default?: string; description?: string }
  | {
      type: 'string'
      default?: string
      pattern?: string
      description?: string
    }

export type Trigger =
  | { push: true }
  | { request: true }
  | { schedule: string; branches?: string[] }
  | { after: { workflow: string; status?: 'success' | 'completed' } }
  | { deviceRegistered: true }

/** Evaluated before a node is chosen; false shows the stage as skipped. */
export interface When {
  /** Globs: `*` within a path segment, `**` across segments. */
  branch?: string[]
  notBranch?: string[]
  trigger?: TriggerKind[]
  params?: Record<string, ParamValue>
  /** Files changed since the last successful run of this workflow on this branch. */
  changed?: string[]
}

export interface AppleOptions {
  distribution:
    | 'development'
    | 'adHoc'
    | 'appStore'
    | 'developerId'
    | 'macAppStore'
  /** The project's app ID whose bundle IDs are signed. */
  app?: string
  /** Defaults to every bundle ID configured for `app`. */
  bundleIds?: string[]
}

/** A stage function: an exported function receiving the stage context. */
export type StageFunction = (ctx: Stage) => Promise<Json | void> | Json | void

/** A stage, group or approval declared in setup, usable in `needs`. */
export interface StageRef {
  readonly name: string
  readonly kind: 'stage' | 'group' | 'approval'
}

export interface StageOptions {
  /**
   * Node selector, or a list of them: the stage runs on whichever free node
   * matches any of them. With none free, the first entry whose pool can serve
   * it starts one machine (or is already starting or waiting for one); a
   * pool that cannot now passes to the next entry.
   */
  on: NodeSelector | NodeSelector[]
  /** The exported stage function. */
  run: StageFunction
  /** Explicit dependencies; `[]` starts at once. */
  needs?: StageRef[]
  when?: When
  tools?: Tools
  /**
   * Names of project secrets this stage may read. Values are read with
   * `ctx.secret` and are also set as environment variables of the stage's
   * commands (except names the build environment sets, such as PATH); files
   * are written with `ctx.writeSecretFile`, or read through `ctx.secretFile`.
   */
  secrets?: string[]
  /**
   * Build configs, in order: at most 20, each letters, digits, dashes and
   * underscores. Each secret the stage declares is the variant of the latest
   * config that has one, else the secret's default variant (the one for all
   * configs). A secret with neither cannot be declared.
   */
  configs?: string[]
  /** Non-secret environment for this stage. */
  env?: Record<string, string>
  /** Stage limit, enforced by the worker. Default `'2h'`. */
  timeout?: Duration
  /** Fail as `timed_out` when the stage prints nothing for this long. */
  activityTimeout?: Duration
  retry?:
    | number
    | { attempts: number; on?: Array<'failed' | 'interrupted' | 'timed_out'> }
  /** Named resources held while running, across all runs of the project. */
  lock?: string | string[]
  apple?: AppleOptions
  /** App IDs this stage may publish; their build numbers are reserved. */
  publishes?: string[]
  /** Other build-number sequences this stage needs. */
  buildNumbers?: string[]
  checkout?: boolean | { submodules?: boolean; depth?: number; lfs?: boolean }
  workspace?: 'clean' | 'reuse' | { path: string; mode?: 'clean' | 'reuse' }
  cache?: Array<{ key: string; paths: string[] }>
  /** A failure marks the stage and run `unstable` instead of failed. */
  continueOnError?: boolean
  /** Skip this stage if a dependency was `unstable`. */
  requireSuccess?: boolean
}

/** One stage of a sequence inside a parallel group. */
export interface SequenceStage extends StageOptions {
  name: string
}

export interface ParallelOptions {
  needs?: StageRef[]
  /** Cancel the other members when one fails. Defaults to the workflow's. */
  failFast?: boolean
}

export type MatrixCombination<A extends MatrixAxes> = {
  [K in keyof A]: A[K][number]
}
export type MatrixAxes = Record<
  string,
  ReadonlyArray<string | number | boolean>
>

/** Any stage option except `run` and `needs` may depend on the combination. */
export type MatrixOptions<A extends MatrixAxes> = {
  axes: A
  exclude?: Array<Partial<MatrixCombination<A>>>
  run: StageFunction
  needs?: StageRef[]
  failFast?: boolean
} & {
  [K in Exclude<keyof StageOptions, 'run' | 'needs'>]?:
    | StageOptions[K]
    | ((combination: MatrixCombination<A>) => StageOptions[K])
} & {
  on:
    | NodeSelector
    | NodeSelector[]
    | ((combination: MatrixCombination<A>) => NodeSelector | NodeSelector[])
}

export interface ApprovalOptions {
  needs?: StageRef[]
  /** Roles that may approve. Default admin and manager. */
  roles?: Role[]
  message?: string
  /** Then the run is cancelled. */
  timeout?: Duration
  /** Collected from the approver. */
  params?: Record<string, ParamSpec>
  run?: never
  on?: never
}

export interface PostStages {
  always?: StageOptions
  success?: StageOptions
  unstable?: StageOptions
  failure?: StageOptions
  aborted?: StageOptions
  /** This run succeeded after the previous one did not. */
  fixed?: StageOptions
  /** This run failed after the previous one succeeded. */
  regression?: StageOptions
}

export interface WorkflowOptions {
  /** Default for `build`: `[{ push: true }, { request: true }]`. */
  triggers?: Trigger[]
  params?: Record<string, ParamSpec>
  env?: Record<string, string>
  /** Whole-run limit. Default `'4h'`. */
  timeout?: Duration
  /** One run per group at a time. Default `{ group: 'branch' }`. */
  concurrency?: {
    group: 'branch' | 'workflow' | 'project' | (string & {})
    cancelPrevious?: boolean
  }
  keep?: {
    runs?: number
    days?: number
    artifactDays?: number
    stashes?: number
  }
  /** Cancel running stages when any stage fails. Default `true`. */
  failFast?: boolean
}

export interface BuildNumberOptions {
  /** `'app'` (default): one sequence across branches; `'branch'`: one per branch. */
  scope?: 'app' | 'branch'
  /** Tokens `YYYY YY MM DD HH`, `C…` (count within the date part), `N`. Default `'N'`. */
  format?: string
  start?: number
  /** For date tokens. Default UTC. */
  timeZone?: string
  check?: 'apple' | 'android'
  /**
   * App IDs that take their numbers from this sequence, so every app of a
   * run publishes with the same number.
   */
  apps?: string[]
  /**
   * Numbers each run holds, 1 to 100 (default 1): a run gets N and keeps N
   * to N+block−1; the next run's number comes after the block (N+block, or
   * the next day's first number for a dated format). Needs a format of digits
   * ending in its count (`YYMMDDCC`, `N`).
   */
  block?: number
}

/** Declares the stages of one workflow. */
export interface WorkflowBuilder {
  stage(name: string, options: StageOptions): StageRef
  parallel(
    name: string,
    members: Record<string, StageOptions | SequenceStage[]>,
    options?: ParallelOptions,
  ): StageRef
  matrix<const A extends MatrixAxes>(
    name: string,
    options: MatrixOptions<A>,
  ): StageRef
  approval(name: string, options?: ApprovalOptions): StageRef
  post(stages: PostStages): void
}

/** The object `setup(m)` receives. It runs with no secrets. */
export interface Setup extends WorkflowBuilder {
  /** Declares the Masonfile API version. */
  apiVersion(version: 1): void
  buildNumber(key: string, options?: BuildNumberOptions): void
  workflow(
    name: string,
    options: WorkflowOptions,
    declare: (w: WorkflowBuilder) => void,
  ): void
  /** The workflow this setup run is for. */
  readonly currentWorkflow: string
  readonly branch: string
  readonly commit: string
  readonly trigger: TriggerKind
  readonly params: Readonly<Record<string, ParamValue>>
}

export interface CommandOptions {
  /** Relative to the workspace. */
  cwd?: string
  /** Added for this command only. Declared value secrets are already set. */
  env?: Record<string, string>
  timeout?: Duration
  /** Standard input. */
  input?: string | Uint8Array
  /** Log the command line only; on failure, its last 40 lines too. */
  quiet?: boolean
  /** Resolve instead of rejecting on a nonzero exit. */
  allowFailure?: boolean
  /** Set `false` to run without forced colour. */
  color?: boolean
}

export type CommandResult = {
  code: number
  /** Captured output is capped; the full output is in the log. */
  stdout: string
  stderr: string
}

export interface RunInfo {
  id: string
  number: number
  workflow: string
  branch: string
  commit: string
  trigger: TriggerKind
  params: Readonly<Record<string, ParamValue>>
  url: string
  /** Commits since the workflow's last successful run on this branch. */
  changes: Array<{ sha: string; subject: string; author: string }>
}

export interface NodeInfo {
  name: string
  type: string
  os: Os
  arch: Arch
  labels: string[]
  xcode?: { version: string; build: string; path: string; sdks: string[] }
  /** The stage's own simulator device set, for `simctl --set`, when it lists simulators (also `MASON_SIMULATOR_SET`). */
  simulatorSet?: string
}

export interface ArtifactOptions {
  kind?: 'file' | 'report' | 'log' | 'data'
  /** For `report`: the page the viewer opens. */
  entry?: string
  /** Also show this artifact to testers who can see the app. */
  visibleTo?: 'testers'
}

export interface ArtifactQuery {
  workflow: string
  branch?: string
  commit?: string
  status?: 'success'
  name: string
}

export type TestSummary = {
  passed: number
  failed: number
  skipped: number
  failures: Array<{ name: string; message: string }>
}

export interface PublishOptions {
  /** An app ID of this project, listed in the stage's `publishes`. */
  app: string
  platform: Platform
  path: string
  /**
   * One of several files of this build (`arm64-v8a`, `linux-x64`): 1 to 32
   * letters, digits, `.`, `_` or `-`, starting with a letter or digit.
   * Omitted, the file is the default variant. A run publishes each variant
   * once, from any of its stages or attempts; another file for it is
   * refused, so a retried stage must reproduce its files exactly.
   */
  variant?: string
  /** Required for DMG/EXE/MSI; read from IPA/APK and checked. */
  version?: string
  /**
   * An IPA's or APK's own number is read from it (this must match it); a
   * DMG/EXE/MSI's is this, defaulting to `getBuildNumber`'s. Either way it
   * is one of the run's: N, or N to N+block−1 with a `block`.
   */
  buildNumber?: string
  changelog?: string
  metadata?: Record<string, Json>
}

export type PublishResult = {
  buildId: number
  url: string
  installUrl: string
  visible: boolean
  /** `''` for the default variant. */
  variant: string
}

export interface AppleSigning {
  teamId: string
  identity: string
  keychain: string
  profiles: Record<string, string>
  buildSettings: Record<string, string>
  /** Path of a ready `ExportOptions.plist`. */
  exportOptions: string
}

export interface ArchiveOptions {
  project?: string
  workspace?: string
  scheme: string
  configuration?: string
  destination?: string
  version?: string
  buildNumber?: string
  sdk?: string
  xcargs?: string[]
  output?: string
  /** Added to xcodebuild's environment, which the project's build scripts see. */
  env?: Record<string, string>
}

export type ArchiveResult = {
  archive: string
  ipa?: string
  app?: string
  pkg?: string
  dsyms: string
}

export interface TestflightOptions {
  path: string
  whatToTest?: string
  groups?: string[]
  usesNonExemptEncryption?: boolean
  waitForProcessing?: boolean
  notifyTesters?: boolean
}

export interface NotarizeOptions {
  path: string
  staple?: boolean
}

/** The context a stage function receives. */
export interface Stage {
  readonly run: RunInfo
  readonly stage: {
    name: string
    attempt: number
    matrix: Readonly<Record<string, string | number | boolean>>
  }
  readonly node: NodeInfo
  /** The checkout directory. */
  readonly workspace: string
  /** Fired on cancel or timeout. */
  readonly signal: AbortSignal

  sh(command: string, options?: CommandOptions): Promise<CommandResult>
  exec(
    file: string,
    args?: string[],
    options?: CommandOptions,
  ): Promise<CommandResult>

  /** A value secret the stage declared, the variant its configs choose; anything else throws. */
  secret(name: string): string
  /** Path of a declared secret file (the variant the stage's configs choose), in the stage's private directory, deleted after the stage. */
  secretFile(name: string): string
  /**
   * Writes a declared secret file to `<directory>/<name>` inside the
   * checkout (`'.'` is its root) and returns the path. The directory is
   * created; a file or symlink already at the target is set aside and put
   * back when the stage ends, and a directory there is refused. The secret
   * file is removed when the stage ends, however it ends. `mode` defaults to
   * owner-only (0o600); a file the build ships, such as a resource copied
   * into an app bundle, needs a readable one (0o644).
   */
  writeSecretFile(
    name: string,
    directory: string,
    options?: { mode?: number },
  ): Promise<string>

  /** The value another stage (or an approval) returned. */
  output<T extends Json = Json>(stage: string): Promise<T>
  getBuildNumber(key: string): string

  stash(
    name: string,
    paths: string | string[],
    options?: { exclude?: string[] },
  ): Promise<void>
  unstash(name: string, options?: { into?: string }): Promise<void>

  readonly artifacts: {
    save(
      name: string,
      paths: string | string[],
      options?: ArtifactOptions,
    ): Promise<void>
    /** Downloads artifacts of another run; resolves with the files written. */
    fetch(query: ArtifactQuery, into: string): Promise<string[]>
  }
  tests(
    format: 'junit' | 'xunit' | 'tap',
    paths: string | string[],
    options?: { failOn?: 'unstable' | 'failure' },
  ): Promise<TestSummary>
  publish(options: PublishOptions): Promise<PublishResult>

  readonly log: {
    info(message: string): void
    warn(message: string): void
    error(message: string): void
    section<T>(title: string, body: () => Promise<T> | T): Promise<T>
  }
  /** Sets the run's one-line description. */
  describe(text: string): void
  /** Ends the stage as `unstable` when it returns. */
  unstable(reason: string): void

  retry<T>(attempts: number, body: () => Promise<T>): Promise<T>
  timeout<T>(
    duration: Duration,
    body: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>
  sleep(duration: Duration): Promise<void>
  waitUntil(
    condition: () => boolean | Promise<boolean>,
    options?: { timeout?: Duration; interval?: Duration },
  ): Promise<void>

  readonly cache: {
    restore(key: string, paths: string[]): Promise<boolean>
    save(key: string, paths: string[]): Promise<void>
  }
  /** Checks out an additional repository the project allows. */
  checkout(options: {
    repository: string
    ref?: string
    path: string
  }): Promise<void>
  /** Small promise wrappers scoped to the workspace. */
  readonly fs: {
    stat(path: string): Promise<{
      size: number
      isFile: boolean
      isDirectory: boolean
      mtimeMs: number
    }>
    read(path: string): Promise<string>
    write(path: string, data: string | Uint8Array): Promise<void>
    glob(patterns: string | string[]): Promise<string[]>
  }
  readonly git: {
    /** Tags the pinned commit; `push` is performed by the master. */
    tag(
      name: string,
      options?: { message?: string; push?: boolean },
    ): Promise<void>
  }
  readonly apple: {
    readonly signing: AppleSigning
    archive(options: ArchiveOptions): Promise<ArchiveResult>
    testflight(options: TestflightOptions): Promise<{
      buildId: string
      version: string
      buildNumber: string
      state: string
    }>
    notarize(
      options: NotarizeOptions,
    ): Promise<{ id: string; status: 'accepted' }>
  }
}
