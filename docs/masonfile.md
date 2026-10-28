# Masonfile reference

A project's `Masonfile.ts` tells Mason how to build it. This document is the
reference for the Masonfile API and for the parts of Mason it relies on: nodes,
workflows, stages, the stage context, build numbers and Apple signing. The
TypeScript types are in [`types/mason/index.d.ts`](../types/mason/index.d.ts),
the types-only package `@mason/types`.

## 1. Model in one page

- A **project** is one repository, configured on the master: its app IDs,
  branch rules, secrets and settings. People see projects according to their
  role (admin, manager, developer, tester).
- A project's `Masonfile.ts` defines one or more **workflows** (`build`,
  `nightly`, `release`, …). A workflow is a graph of **stages**.
- A **run** is one execution of one workflow at one pinned commit. Runs are
  numbered per project and workflow (`build #412`).
- A **stage** is one exported TypeScript function executed on one **worker
  node** chosen by the stage's node selector. Stages run in declaration order
  unless grouped as **parallel**, expanded as a **matrix**, or wired
  explicitly with `needs`.
- Stages pass **files** to each other with stash/unstash, and pass small
  **values** by returning them. Runs pass files to later runs, including runs
  of other workflows, through saved **artifacts**.
- **Published builds** are the installable packages (IPA, APK, DMG, EXE, MSI)
  that appear on the host under the project's home, for testers whose groups
  include the app. **Artifacts**
  are everything else a run saves: reports, test results, logs, binaries.
- Every byte a stage prints — its own `console.log` and everything it runs —
  is streamed live to the master and the host and kept with the run.
- **Only the master holds repository credentials.** Workers fetch source code
  from the master over its WebSocket link and never talk to GitHub.
- **Configuration lives in the Masonfile.** Anything about how a project
  builds — workflows, triggers, stages, node selection, tools, build-number
  schemes, retention, artifact visibility — is code in `Masonfile.ts`, versioned
  with the branch it builds. The master holds only state (counters, runs,
  devices), secrets and credentials, and the few settings that guard against
  a branch granting itself something: which branches may build at all, which
  app IDs a project owns, which nodes may sign, and cloud budgets.

### Two kinds of code in one file

A Masonfile exports:

1. **`setup(m)`** — declares workflows and stages. Mason runs it on a worker,
   **with no secrets**: no secret environment variables, no injected files, no
   upload tokens. It must be deterministic for a given commit, branch, trigger
   and parameters, and must not have side effects. It returns nothing; it
   records the graph by calling `m`. The master caches the validated graph by
   commit, workflow, branch, trigger and parameters, so setup runs only when
   that combination is new.
2. **Stage functions** — the work. Each is an exported `async function` that
   receives a `Stage` context. It runs on the worker the stage was assigned to,
   receives only the secrets that stage declared, and talks to Mason only
   through the context.

```ts
import type { Setup, Stage } from '@mason/types'

export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber('app.edge.eddy', { format: 'YYMMDDCC', check: 'apple' })
  m.stage('test', { on: 'linux', tools: { node: '24' }, run: unitTests })
  m.stage('mac', { on: 'mac-xcode', publishes: ['app.edge.eddy'], run: buildMac })
}

export async function unitTests(ctx: Stage) {
  await ctx.sh('npm ci && npm test')
}

export async function buildMac(ctx: Stage) {
  const build = ctx.getBuildNumber('app.edge.eddy')
  await ctx.sh(`scripts/make-dmg.sh ${build}`)
  await ctx.publish({ app: 'app.edge.eddy', platform: 'macos',
                      path: `build/Eddy-${build}.dmg`, version: '0.3.3', buildNumber: build })
}
```

`import type` is erased by Node's type stripping, so the file needs nothing at
run time: every capability comes through `m` and `ctx`. The types are only for
editors and type-checking: the types-only package `@mason/types` provides
them (in the Mason repository under `types/mason/`; it is not yet published to
npm, so a repository vendors it or maps the import with `paths`). A repository
without it still builds; only the editor loses the types. Mason
itself is not on npm (section 2 shows how it installs).

Stage functions are referenced **by value** (`run: buildMac`); setup maps each
reference to its export name. A function that is not exported is an error,
because the stage run imports the module and calls the export by name. Ordinary
non-exported helpers (like `archiveIos` in section 13) can be called from
stage functions freely.

Module top-level code runs in both kinds of run. Keep it to imports and
constants.

## 2. Nodes and node types

A worker **node** is a computer running `mason worker`. It needs no
configuration file: on first start it creates its identity and prints a
pairing key and its addresses:

```sh
sudo mason worker --install      # installs the service and helper, prints the pairing key
# Pairing key: mason1:mldsa65:…
```

Mason installs like Homebrew, with one command and no Node or npm needed
beforehand:

```sh
/bin/bash -c "$(curl -fsSL https://github.com/EdgeApp/mason/releases/latest/download/install.sh)"
# or: wget -qO- …/install.sh | bash
```

It downloads the Mason release for the computer's OS and architecture from
GitHub, which bundles its own Node runtime, and puts `mason` on the `PATH`.
While the Mason repository is private, the installer needs a GitHub token
(`GITHUB_TOKEN`, or a signed-in `gh`); nodes joining a cluster can instead use
the host's copy, `curl -fsSL https://<host>/install.sh | bash`, which needs
none.
Then `sudo mason worker --install` as above.
An administrator enters the pairing key and the node's address (URL, IP
address or DNS name) in **Add node** on the master, or through the API. The
master pairs, then sets the node's name, type and labels and manages its
software (below). macOS and Linux work this way; Windows uses a PowerShell
equivalent when Windows workers are supported.

The node reports its OS (`macos`, `linux`, `windows`), architecture (`arm64`,
`x64`), installed Xcodes, free disk and installed tools. The master keeps the
list of nodes and their types; types are free-form names an administrator
chooses (`mac-xcode`, `linux`, `mac-simulators`).

A stage's **node selector** says where it may run:

```ts fragment
on: 'mac-xcode'                                   // a node of this type
on: { os: 'linux' }                               // any Linux node
on: { type: 'mac-xcode', labels: ['apple-signing'] }
on: { os: 'macos', arch: 'arm64', labels: ['simulators'] }
on: 'master'                                      // the master's own worker, if it has one
```

All given fields must match. `tools` (section 7) also constrain placement:
a node qualifies only if it has the tools or can install them.

### Node types carry their software

A node type is defined on the master with the software every node of that
type keeps installed, and the master keeps each node at that state:

```json
{
  "type": "mac-xcode",
  "os": "macos",
  "software": {
    "xcode": ["26.1", "26.0.1"],
    "simulators": ["iOS 26.1", "watchOS 26.1"],
    "commandLineTools": true,
    "rosetta": true,
    "brew": ["cocoapods", "xcodegen", "swiftlint"],
    "node": ["24"],
    "java": ["21"]
  },
  "settings": { "neverSleep": true, "developerMode": true, "uiAutomation": true }
}
```

A Linux type lists `apt` (or `dnf`) packages and `docker: true` instead of
Xcode and Homebrew. Anything a stage's `tools` asks for beyond its type is
installed on demand. When a node needs something only a person can do, the
master shows it on the node's page as a checklist item with instructions, and
does not assign stages that depend on it until it is done.

A stage waits in `queued` until a matching node is free. If no paired node or
cloud pool could ever match, the run fails at setup validation with the unmet
selector.

### Cloud node types

A node type can also be backed by a **cloud pool** an administrator configures
on the master. Each pool names a **cloud account** added on the master's Cloud
page. When a stage needs that type and no node of it is free, the master starts
a cloud machine in that account, which then behaves like an in-house computer
until it has been idle for an hour:

```json
{
  "type": "linux-cloud",
  "account": "digitalocean",
  "provider": "digitalocean",
  "region": "sfo3",
  "size": "s-4vcpu-8gb",
  "image": "ubuntu-24-04-x64",
  "labels": ["docker"],
  "maxNodes": 2,
  "slots": 2,
  "ttlMinutes": 60,
  "maxHoursPerNode": 12
}
```

- **Reused like your own computer.** A running cloud machine takes any number
  of stages of its type, `slots` at a time, and keeps its checkouts, installed
  tools and caches between them, so later stages start fast.
- **Snapshot instead of starting from scratch.** When a machine has run no
  stage for `ttlMinutes` (default 60), the master retires it: it stops Mason,
  removes the node's identity and any stage leftovers, powers the machine off,
  saves a provider **snapshot**, destroys the machine, and replaces the pool's
  previous snapshot with the new one. The snapshot and the machine are recorded
  in the master's database.
- **Restore from the snapshot.** The next time the pool needs a machine, the
  master creates it from that snapshot. It boots with the tools and caches it
  had, generates a fresh identity, pairs with a new one-time secret, and is
  ready in the time it takes to boot plus any software the node type gained
  since. Several machines can start from the same snapshot; each gets its own
  identity.
- **Fallback.** If the snapshot is gone (deleted by hand, or the provider
  cannot use it), the master starts from the plain `image` instead, installs
  Mason and the node type's software, and snapshots that machine when it
  retires, so the following start is fast again.
- A new machine installs Mason from the host, or, while the master has no
  host, the master's own release from GitHub. Pools are added and edited on
  the Nodes page, where the region, size and image lists come from the
  provider. A master with no worker connected starts a machine from its first
  pool to run a run's setup, so a cluster can be cloud machines alone.
- The machine's first-boot data carries the one-time pairing secret; the
  master dials it, checks the secret, pins its key, and assigns stages. The
  provider's firewall admits the link port only from the master's public
  address; the master checks that address every minute and updates the rule
  when it changes.
- `maxNodes` caps concurrent machines; stages wait rather than exceed it.
  `maxHoursPerNode` retires a machine after its current stage even if it never
  goes idle. On startup the master lists the provider's machines and snapshots
  tagged with its pools and deletes any it has no record of, so a crash cannot
  leak machines or snapshots.
- **Monthly budget.** Cloud spend is capped at **$200 per calendar month**
  across all pools (an administrator can change the cap). The master counts
  machine running time at each size's price plus snapshot storage, since the
  provider account also pays for other machines. At 80% it warns
  administrators on the master. At the cap it creates no new machines:
  running stages finish, idle machines retire, and stages that need a cloud
  type wait with the reason "monthly cloud budget reached" until the next
  month or a raised cap.
- A pool can also run on **NoMac** (Apple silicon Macs with Xcode, by the
  minute): the master starts a NoMac Mac, installs Mason on it for the user,
  runs the worker as a NoMac service, and reaches it through NoMac's SSH
  gateway, so the Mac accepts no inbound connection. NoMac runs one Mac at a
  time per account for up to eight hours; its Macs are never snapshotted, and
  a retired one is stopped.
- DigitalOcean (Linux) is the first provider. A provider's API key is a cloud
  account on the master: an administrator or manager adds it on the Cloud page
  (or with `mason cloud accounts add --key-stdin`), where Mason checks it and
  shows the account's state. The key is kept only in the master's database and
  its encrypted backups, and is never shown again; an account a pool uses
  cannot be removed.

## 3. Workflows

Stages declared directly on `m` belong to the default workflow `build`, which
runs on pushes to automatic branches and on requests. Additional workflows:

```ts fragment
m.workflow('nightly', {
  triggers: [{ schedule: '0 3 * * *', branches: ['master'] }],
}, (w) => {
  w.stage('soak', { on: 'mac-simulators', timeout: '4h', run: soakTests })
})

m.workflow('release', {
  triggers: [{ request: true }],
  params: {
    track: { type: 'choice', choices: ['testflight', 'store'], default: 'testflight' },
    notes: { type: 'text' },
  },
  concurrency: { group: 'project', cancelPrevious: false },
}, (w) => { /* … */ })
```

### Workflow options

| Option | Meaning |
| --- | --- |
| `triggers` | When runs start (below). Default for `build`: `[{ push: true }, { request: true }]`. |
| `params` | Typed parameters shown on the request form and accepted by the API. |
| `env` | Non-secret environment for every stage. |
| `timeout` | Whole-run limit. Default 4 h. |
| `concurrency` | `{ group: 'branch' \| 'workflow' \| 'project' \| string, cancelPrevious?: boolean }`. One run per group at a time; `cancelPrevious` cancels the older run instead of queueing. Default `{ group: 'branch' }`. |
| `keep` | Retention: `{ runs?: number, days?: number, artifactDays?: number, stashes?: number }`. `stashes` (default 3) is how many recent runs keep their stashes for restarts. |
| `failFast` | Cancel running stages when any stage fails. Default `true`. |

### Triggers

| Trigger | Starts a run when |
| --- | --- |
| `{ push: true }` | A new commit appears on a branch whose master branch rule is `automatic` — reported by a GitHub webhook within seconds, or found by the master's poll. |
| `{ request: true }` | A developer, manager or admin, or a `build` API key, requests it. |
| `{ schedule: '<cron>', branches: [...] }` | The cron time passes (master's time zone). |
| `{ after: { workflow, status?: 'success' \| 'completed' } }` | Another workflow of the same project finishes a run of the same commit. Runs of other projects cannot be started or awaited. |
| `{ deviceRegistered: true }` | A new iOS device is provisioned (rebuild ad hoc builds). |

The master's **branch rules decide which branches may build at all**. A
Masonfile trigger can narrow that, never widen it: a schedule on a branch with
no rule does nothing, and a push trigger fires only on `automatic` branches.

**Webhooks.** The host exposes `POST /api/webhooks/github/<project>`. GitHub
calls it on every push; the host checks the size and rate, and passes the raw
body and signature header to the master over the master's link. The master
verifies the signature with the project's webhook secret (which never leaves
the master) and schedules the push. While the master is unreachable the host
keeps the latest delivery per project and branch and passes it on when the
link returns. The master still polls every 5 minutes, so a missed webhook
only delays a build.

### Parameters

```ts fragment
params: {
  track:  { type: 'choice', choices: ['testflight', 'store'], default: 'testflight' },
  dryRun: { type: 'boolean', default: true },
  shards: { type: 'number', default: 4, min: 1, max: 16 },
  notes:  { type: 'text' },          // multi-line
  tag:    { type: 'string', pattern: '^v\\d+\\.\\d+\\.\\d+$' },
}
```

Values are validated by the master before the run starts and are visible in
setup (`m.params`) and stages (`ctx.run.params`). Parameters are not secrets.

## 4. Stages and ordering

```ts fragment
const test = m.stage('test', { on: 'linux', run: unitTests })

const builds = m.parallel('build', {
  ios:     { on: 'mac-xcode', run: buildIos,     publishes: ['com.example.app'] },
  android: { on: 'linux',     run: buildAndroid, publishes: ['com.example.app'] },
  cli:     { on: 'linux',     run: buildCli },
})

m.stage('e2e', { on: 'mac-simulators', run: endToEnd })
```

- **Sequential by default.** A stage with no `needs` runs after the stage or
  group declared before it. The first stage starts immediately.
- **`m.parallel(name, stages, options?)`** runs its members at the same time on
  their own nodes. The group finishes when every member finishes. With
  `failFast` (the workflow default) one failure cancels the others.
- **`needs`** overrides the default with explicit dependencies:
  `needs: [test]` starts right after `test`, even if other stages were
  declared in between. `needs: []` starts at once. Dependencies form a graph;
  cycles are rejected at setup.
- A stage runs only if everything it needs **succeeded** (or was `unstable`,
  unless `requireSuccess: true`). Otherwise it is `skipped`.

### Sequences inside a parallel group

A member of `m.parallel` may be a **sequence** of stages instead of one stage.
The sequence's stages run one after another; the sequences run side by side:

```ts fragment
m.parallel('build', {
  ios: [
    { name: 'compile', on: 'mac-xcode', run: compileIos },
    { name: 'sign',    on: { type: 'mac-xcode', labels: ['apple-signing'] }, secrets: ['MATCH_PASSWORD'], run: signIos },
    { name: 'upload',  on: 'mac-xcode', publishes: ['com.example.app'], run: publishIos },
  ],
  android: [
    { name: 'compile', on: 'linux', run: compileAndroid },
    { name: 'sign',    on: 'linux', secrets: ['ANDROID_KEYSTORE'], publishes: ['com.example.app'], run: signAndroid },
  ],
  web: { on: 'linux', run: buildWeb },
})
```

Stages in a sequence are named `build/ios/compile`, `build/ios/sign`, and so
on. With `failFast`, a failure in one sequence cancels the others. Within a
sequence, a failure skips the rest of that sequence.

### Matrix

```ts fragment
m.matrix('platforms', {
  axes: { target: ['ios', 'android', 'cli'], config: ['debug', 'release'] },
  exclude: [{ target: 'cli', config: 'debug' }],
  on: ({ target }) => (target === 'ios' ? 'mac-xcode' : 'linux'),
  run: buildTarget,
})

export async function buildTarget(ctx: Stage) {
  const { target, config } = ctx.stage.matrix   // { target: 'ios', config: 'release' }
}
```

A matrix expands into one stage per combination, named
`platforms[target=ios,config=release]`, run as a parallel group. Any stage
option may be a function of the combination. Axes may come from parameters,
so a run can choose its own width:

```ts fragment
const shards = Array.from({ length: m.params.shards as number }, (_, i) => i + 1)
m.matrix('tests', { axes: { shard: shards }, on: 'linux', run: testShard })
```

All fan-out is declared in setup. A running stage cannot start stages on
other nodes; this keeps every stage able to finish without the master.

### Stage options

| Option | Meaning |
| --- | --- |
| `on` | Node selector (section 2). Required except for `approval`. |
| `run` | The exported stage function. |
| `needs` | Explicit dependencies (stage or group references). |
| `when` | Condition evaluated before a node is chosen (below). False → `skipped`. |
| `tools` | Tool versions the stage needs (section 7). |
| `secrets` | Names of project secrets the stage may read. Nothing else is delivered. |
| `env` | Non-secret environment for this stage. |
| `timeout` | Stage limit, enforced by the worker. Default 2 h. |
| `activityTimeout` | Fail the stage as `timed_out` when it prints nothing for this long (`'20m'`), catching hung simulators and prompts waiting for input. Default none. |
| `retry` | `number` or `{ attempts, on?: ('failed' \| 'interrupted' \| 'timed_out')[] }`. Each attempt is a fresh run of the function, possibly on another node. |
| `lock` | Named resource(s) held while running, across all runs of the project (`'ios-signing'`, `'device-farm'`). |
| `apple` | Apple signing for this stage (section 12): `{ distribution, app?, bundleIds? }`. |
| `publishes` | App IDs this stage may publish. Build numbers are reserved for them before the stage starts (section 8). |
| `buildNumbers` | Other build-number sequences this stage needs (section 8). |
| `checkout` | `true` (default), `false`, or `{ submodules?: boolean, depth?: number, lfs?: boolean }`. The source comes from the master (below). |
| `workspace` | `'clean'` (default: reset to the pinned commit), `'reuse'` (keep untracked files from the node's last run of this stage), or `{ path, mode? }` (below). |
| `cache` | `[{ key: string, paths: string[] }]` restored before and saved after, per node. |
| `continueOnError` | A failure marks the stage and run `unstable` instead of failed. |
| `requireSuccess` | Skip this stage if a dependency was `unstable`. |

### Custom workspace paths

```ts fragment
workspace: { path: 'app-ios', mode: 'reuse' }
```

`path` names a directory under the node's workspace root that the checkout
uses instead of Mason's per-branch directory. Every stage and run that names
the same path on a node shares it, so build products such as DerivedData or
Gradle caches survive between runs and branches. Mason holds an implicit lock
on the path while a stage uses it. `mode` is `reuse` (default for a custom
path: the checkout is moved to the pinned commit without deleting untracked
files) or `clean`. An absolute path is accepted only when the node's
`workspaceRoots` setting on the master lists it, so a Masonfile cannot reach
arbitrary directories.

### Source code

Workers have no GitHub credentials, deploy keys or tokens. Every checkout comes
from the master:

- The master keeps a bare mirror of each project repository, fetched from
  GitHub with its own credentials. Before a run's setup or a stage is assigned,
  the master makes sure its mirror contains the pinned commit (and the
  submodule commits and LFS objects the stage asks for).
- The worker runs ordinary `git fetch` against a remote that is a Mason link
  stream: git's built-in `ext::` transport starts Mason's proxy, which carries
  git's own protocol (v2) over the master's link to `git upload-pack` running on
  the master's mirror. Git's negotiation is unchanged, so a worker fetches only
  objects it lacks, and shallow fetches (`depth`) work.
- The master serves **only `git-upload-pack`** (fetch) on these streams, only
  for repositories the run's project may use, and only while a stage of that
  project is assigned to that worker. Pushes and other repositories are
  refused.
- Submodules are fetched the same way: the master rewrites each submodule URL
  to its own stream, for submodule repositories the project lists. LFS objects
  come through a git-lfs custom transfer agent that asks the master for each
  object.
- `ctx.checkout({ repository, ref, path })` fetches an additional repository
  the project lists, the same way.
- Because the checkout finishes before the stage starts, a stage never needs
  the master for source code, even if the link drops.
- `ctx.git.tag(name, { message?, push?: boolean })` creates a tag on the pinned
  commit. With `push: true` the **master** pushes it to GitHub with its own
  credentials, if the project's settings allow tag pushes; the worker never
  pushes.

### Conditions

Setup already knows the branch, trigger and parameters, so most conditions
are plain TypeScript:

```ts fragment
if (m.branch === 'master') m.stage('deploy', { … })
```

`when` exists for conditions that should show the stage as **skipped** in the
run view, and for path changes:

```ts fragment
when: {
  branch: ['master', 'release/**'],     // globs; * within a segment, ** across
  notBranch: ['wip/**'],
  trigger: ['push', 'schedule'],
  params: { dryRun: false },
  changed: ['ios/**', 'shared/**'],      // files changed since the last successful run of this workflow on this branch
}
```

### Approvals

```ts fragment
const ship = m.approval('ship', {
  needs: [e2e],
  roles: ['admin', 'manager'],            // roles that may approve (default: admin and manager)
  message: 'Upload this build to the store?',
  timeout: '24h',                          // then the run is cancelled
  params: { notes: { type: 'text' } },     // collected from the approver
})
m.stage('upload', { needs: [ship], on: 'mac-xcode', secrets: ['ASC_KEY'], run: uploadToStore })
```

The run pauses at `awaiting approval`. The master and the host show Approve
and Reject to people with an allowed role. The approver and their parameters
are recorded and available as `await ctx.output('ship')`. An approval holds no node.

### Post stages

```ts fragment
m.post({
  always:  { on: 'linux', run: collectReports },
  failure: { on: 'linux', secrets: ['SLACK_WEBHOOK'], run: notifyFailure },
  fixed:   { on: 'linux', secrets: ['SLACK_WEBHOOK'], run: notifyFixed },
})
```

Mason has no built-in notifications; post stages send them, with the
webhook or credentials as declared secrets.

Conditions: `always`, `success`, `unstable`, `failure`, `aborted`, `fixed`
(this run succeeded after the previous one did not), `regression` (the
reverse). Post stages run after every other stage has finished, in that order.
A failing post stage marks the run failed.

## 5. The stage context

```ts
import type { Stage } from '@mason/types'

export async function buildIos(ctx: Stage) {
  ctx.log.info(`building ${ctx.run.branch} on ${ctx.node.name}`)
  await ctx.unstash('web-bundle')
  const build = ctx.getBuildNumber('com.example.app')
  await ctx.sh('scripts/build-ios.sh', {
    env: { BUILD_NUMBER: build, MATCH_PASSWORD: ctx.secret('MATCH_PASSWORD') },
  })
  await ctx.tests('junit', 'fastlane/test_output/*.xml')
  await ctx.publish({ app: 'com.example.app', platform: 'ios',
                      path: 'build/App.ipa', buildNumber: build })
  return { ipaSize: (await ctx.fs.stat('build/App.ipa')).size }
}
```

### Running commands

- `ctx.sh(command, options?)` runs through `/bin/sh -c`, and through
  PowerShell on Windows workers when those are supported. `ctx.exec(file, args, options?)` runs without a
  shell. Both stream stdout and stderr into the log, reject on a nonzero exit
  unless `allowFailure: true`, and resolve with `{ code, stdout, stderr }`
  (captured output is capped; the full output is in the log).
- Options: `cwd` (relative to the workspace), `env` (added for that command
  only), `timeout`, `input` (stdin), `quiet` (log the command line only, and its last 40 lines
  of output when it fails).
- Every process a stage starts belongs to the stage. Cancel, timeout and
  failure stop the whole process tree (the existing guardian).

### Secrets

- `ctx.secret(name)` returns a secret the stage declared in `secrets`;
  anything else throws. `ctx.secretFile(name)` returns the path of a declared
  secret file, written owner-only into the stage's private directory and
  deleted afterwards.
- Secrets are **not** in `process.env`. A command sees one only when the stage
  passes it in `env`, so tools the stage runs do not inherit every secret.
- Secret values, and their base64 and URL-encoded forms, are masked in the log
  and in returned values.

### Values between stages

- A stage function may **return** a JSON value up to 64 KiB. Later stages read
  it with `await ctx.output(name)`, typed by the caller:
  `await ctx.output<{ version: string }>('test')`.
- `ctx.run` — `{ id, number, workflow, branch, commit, trigger, params, url,
  changes }`, where `changes` lists the commits (`{ sha, subject, author }`)
  since the workflow's last successful run on this branch.
- `ctx.stage` — `{ name, attempt, matrix }`. `ctx.node` — `{ name, type, os, xcode?,
  arch, labels }`. `ctx.workspace` — the checkout directory.

### Files between stages: stash

- `ctx.stash(name, paths, options?)` packs files (globs, relative to the
  workspace) for later stages of the same run. `ctx.unstash(name, options?)`
  unpacks them (`into`: a directory). A stash is gone when the run ends.
- Mason delivers a stage's stashes to its node **before** the stage starts,
  so a running stage never waits on the master for them.

### Artifacts

```ts fragment
await ctx.artifacts.save('coverage', 'coverage/**', { kind: 'report', entry: 'coverage/index.html' })
await ctx.artifacts.save('cli', 'dist/mason-cli.tgz')
await ctx.tests('junit', 'reports/**/*.xml')
```

- `ctx.artifacts.save(name, paths, options?)` saves files with the run.
  Paths and `ctx.publish`'s `path` are relative to the checkout, or absolute
  inside it, as `ctx.apple.archive` resolves with.
  `kind`: `file` (default), `report` (an HTML tree browsable on the host,
  opened at `entry`), `log`, `data`. Artifacts are listed on the run page and
  downloadable by developers, managers and admins. `visibleTo: 'testers'` also shows an
  artifact, beside the run's published builds, to testers who can see that
  app, for release notes or screenshots; otherwise testers see only published
  builds.
- `ctx.tests(format, paths)` parses `junit`, `xunit` or `tap` results, saves
  them, shows passes, failures and trends on the run page, and marks the stage
  `unstable` when tests failed (`failOn: 'failure'` makes it fail instead).
- `ctx.artifacts.fetch(query, into)` downloads artifacts of **another run**,
  including another workflow's:
  `{ workflow: 'build', branch?: string, commit?: string, status?: 'success', name: 'cli' }`.
  Without `commit` it takes the latest matching run.
- Artifacts are stored by the host, on its disk or in S3-compatible object
  storage (DigitalOcean Spaces, AWS S3) configured on the host. Retention
  follows the workflow's `keep`.

### Published builds

`ctx.publish` is how a build's output reaches testers on the host. It replaces
the Zealot-compatible upload API for pipeline Masonfiles: the stage needs no
API token, no channel key and no upload configuration.

```ts fragment
await ctx.publish({
  app: 'app.edge.eddy',            // must be an app ID of this project and listed in `publishes`
  platform: 'macos',
  path: 'build/Eddy-412.dmg',
  version: '0.3.3',                // required for DMG/EXE/MSI; read from IPA/APK and checked
  buildNumber: '412',              // the number from ctx.getBuildNumber for this app
  changelog?: string,
  metadata?: Record<string, unknown>,
})
```

The file is uploaded to the host, verified (bundle identity, format, digest),
and becomes installable once the master confirms it. `publish` resolves when
the host has the file with `{ buildId, url, installUrl, visible }`; the run
page shows when it became visible to testers.

| Zealot upload API | `ctx.publish` |
| --- | --- |
| API token and channel key in the build's private config | Nothing: the stage's upload token is issued by the master with the stage |
| Channel chosen by `channel_key` | Channel chosen by `app` and `platform`; the master creates it for the project's app ID |
| Desktop identity sent in `custom_fields.mason` | `version`, `buildNumber` arguments |
| `version_exist` to avoid duplicate uploads | Unnecessary: build numbers are reserved per stage, and publishing the same file again (a retry) returns the existing build; a different file under the same number is refused |
| `branch`, `git_commit`, `ci_url` fields | Filled in from the run |
| `changelog` field | `changelog` argument; defaults to the commit subjects since the last published build of that app and branch |

The Zealot-compatible API stays on the host for script Masonfiles and for
builds made outside Mason.

### Build numbers

`ctx.getBuildNumber(key)` returns the build number reserved for this stage,
rendered by the scheme `setup` declared (section 8). Calling it again returns
the same value.

### Logging

- `console.log`, `console.error` and all command output go to the stage log.
- Colour is kept: commands run with `FORCE_COLOR=1`, `CLICOLOR_FORCE=1` and
  `TERM=xterm-256color` (turn off per command with `color: false`), and the
  master and host render ANSI colours, bold and underline in the log view.
  Downloaded logs keep the escape codes; a plain-text download strips them.
- `ctx.log.info|warn|error(message)` add levelled lines.
- `ctx.log.section(title, fn)` groups output into a collapsible section.
- `ctx.describe(text)` sets the run's one-line description
  (`TestFlight 1.4.2 (412)`).

### Results and control

- Returning normally → `succeeded`. Throwing → `failed`, with the error in the
  log. `ctx.unstable(reason)` → `unstable`.
- `ctx.signal` is an `AbortSignal` fired on cancel or timeout; long waits
  should honour it.
- Helpers: `ctx.retry(attempts, fn)`, `ctx.timeout(duration, fn)`,
  `ctx.sleep(duration)`, `ctx.waitUntil(fn, { timeout, interval })`.
- `ctx.cache.restore(key, paths)` / `ctx.cache.save(key, paths)` for
  node-local caches beyond the declarative `cache` option.
- `ctx.checkout({ repository, ref, path })` checks out an additional
  repository that the project's settings allow.
- `ctx.fs` — small promise wrappers (`stat`, `read`, `write`, `glob`) scoped to
  the workspace.

## 6. Logs

- The stage's stdout and stderr, and those of every process it starts, are
  captured by the worker, masked, timestamped, attributed to the stage, and
  streamed to the master over its link. The master forwards them to the host.
  Both show them live and keep them with the run.
- Setup output is logged the same way, as the run's first section.
- Each `ctx.sh` and `ctx.exec` command, `ctx.log.section`, `ctx.publish`,
  `ctx.stash` and `ctx.artifacts.save` call is recorded as a **step** of its
  stage, with its status, duration and the log lines it produced. The run
  view lists a stage's steps when the stage is selected, the way Jenkins lists
  a stage's steps.
- Visibility: **developers**, **managers** and **admins**
  see logs on the master and the host; **testers** do not.
- If the master is unreachable, the worker keeps the log locally and sends it
  when the link returns; nothing is lost.
- ANSI colour and formatting are rendered in both log views.

## 7. Tools

```ts fragment
tools: {
  node: '24',              // major or exact version
  java: '21',
  rust: '1.90.0',
  android: ['platforms;android-35', 'build-tools;35.0.0'],
  xcode: '>=26 <27',       // installed from the master's Xcode downloads when missing
  simulators: ['iOS 26.1'],
  brew: ['cocoapods'],     // macOS
  apt: ['libssl-dev'],     // Linux
}
```

Missing tools are installed before the stage starts (stage status
`preparing`) and put first on `PATH` (`JAVA_HOME`, `ANDROID_HOME`,
`DEVELOPER_DIR` set accordingly):

- Node, Java, Rust and the Android SDK go into the node's tools directory from
  official archives with verified checksums.
- **Xcode** is downloaded by each node itself, directly from Apple, when the
  master tells it to (section 12 explains the sign-in). The node checks
  Apple's signature, installs it side by side as
  `/Applications/Xcode-<version>.app`, accepts the license and runs first
  launch. A stage selects one with `DEVELOPER_DIR`; nodes never change the
  system-wide Xcode for a stage.
- **Simulator runtimes** are downloaded by each node with `xcodebuild
  -downloadPlatform`, which needs no Apple ID.
- Homebrew and its packages, apt/dnf packages, Command Line Tools and Rosetta
  are installed by the node's privileged helper.

Stages share installed tools; an administrator can pin or remove versions per
node type, and unused Xcodes are removed when disk space runs low.

### Several Xcodes on one node

A node keeps as many Xcode versions as its type and its stages need, side by
side as `/Applications/Xcode-<version>.app`. Each stage chooses its own, so
different branches, releases and apps can build with different Xcodes on the
same Mac:

```ts fragment
tools: { xcode: '26.0.1' }          // exact version
tools: { xcode: '>=26 <27' }        // newest installed match
tools: { xcode: '17A400' }          // exact Xcode build number
tools: { xcode: 'latest' }          // newest release the node type allows
tools: { xcode: 'latest-beta' }     // newest beta, when the node type allows betas
```

- **Per branch, automatically.** The Masonfile lives in the repository, so a
  release branch that still declares `xcode: '26.0.1'` keeps building with it
  while `master` moves to `'26.1'`. When a stage that needs Xcode (an `apple`
  option or `os: 'macos'`) gives no `xcode`, Mason reads the repository's
  `.xcode-version` file, the convention `xcodes` and hosted CI services use; if
  there is none, the node type's default applies.
- **Everything in the stage uses that Xcode.** Mason sets `DEVELOPER_DIR` for
  the stage's whole process tree, so `xcodebuild`, `xcrun`, `clang`, `swift`,
  `simctl`, `stapler`, `ld`, `git` from the Xcode
  toolchain and tools such as CocoaPods that call them all resolve inside the
  chosen Xcode. `ctx.apple.archive`, `testflight` and `notarize` use it too.
  Mason never runs `xcode-select -s` for a stage, so concurrent work and later
  stages are unaffected; `xcode-select -p` keeps showing the node's default.
  Tools that hard-code `/Applications/Xcode.app` are not redirected; avoid them
  or pass the path from `ctx.node.xcode.path`.
- **The stage log starts with the Xcode it used** (`xcodebuild -version`, path,
  SDKs), and `ctx.node.xcode` gives `{ version, build, path, sdks }`.
- **First launch and simulators per version.** Before a stage, Mason checks
  `xcodebuild -checkFirstLaunchStatus` for the chosen Xcode and runs first
  launch if needed (installing a newer Xcode's system components can leave an
  older one needing it). The simulator runtimes the stage lists are installed
  for that Xcode with its own `xcodebuild -downloadPlatform`, and a stage that
  lists `simulators` gets a device set private to the stage (`simctl
  --set`, at `ctx.node.simulatorSet` and in `MASON_SIMULATOR_SET`), removed
  when the stage ends, so runtimes from different Xcodes do not collide.
- **macOS compatibility.** Not every Xcode runs on every macOS (an older Xcode
  may refuse to launch on a newer macOS, and a new Xcode needs a minimum
  macOS). Each node reports which installed Xcodes actually launch, and a
  stage is placed only on a node where its Xcode can run; a version that can
  never run on any node fails at setup with the reason.
- **Testing across Xcodes** is a matrix:

```ts fragment
m.matrix('xcode-compat', {
  axes: { xcode: ['26.0.1', '26.1'] },
  on: 'mac-xcode',
  tools: ({ xcode }) => ({ xcode }),
  run: unitTestsIos,
})
```

## 8. Build numbers

Build-number schemes are configured in `setup`; no master setting is
involved. A stage asks for its number with `ctx.getBuildNumber()` and passes it
to its own build script however it likes.

### Declaring a scheme

```ts
import type { Setup, Stage } from '@mason/types'

export function setup(m: Setup) {
  m.buildNumber('com.example.app')                                   // 1, 2, 3, … for the app
  m.buildNumber('app.edge.eddy', { scope: 'branch' })                    // separate count per branch
  m.buildNumber('com.example.camera', { format: 'YYMMDDCC' })     // 26101701, 26101702, …
  m.buildNumber('android-version-code', { start: 4000 })                 // any named sequence, not only app IDs
  m.buildNumber('nightly', { format: 'YYYY.MM.DD.CCC', scope: 'branch', timeZone: 'America/Los_Angeles' })
}
```

`m.buildNumber(key, options?)` declares a sequence. The key is an app ID or any
name. Options:

| Option | Meaning |
| --- | --- |
| `scope` | `'app'` (default): one sequence for the key across all branches. `'branch'`: an independent sequence per branch. |
| `format` | How the number is rendered. Default `'N'`: a plain integer. Tokens below. |
| `start` | The lowest number to hand out. Raising it later skips ahead; lowering it never goes backwards. |
| `timeZone` | Time zone for date tokens. Default UTC. |
| `check` | `'apple'` (at most three dot-separated integers, as `CFBundleVersion` requires), `'android'` (an integer up to 2,100,000,000, as `versionCode` requires), or none. Setup fails if the format could ever break the rule. |
| `apps` | App IDs that take their numbers from this sequence instead of their own, so every app of a run publishes with the same number (`m.buildNumber('app', { format: 'YYMMDDCC', apps: ['com.example.app', 'com.example.camera'] })`). An app ID belongs to one sequence at most. |

Format tokens:

| Token | Renders |
| --- | --- |
| `YYYY`, `YY` | Year, four or two digits |
| `MM`, `DD`, `HH` | Month, day, hour, two digits |
| `C`, `CC`, `CCC`, … | The count within the current date part, starting at 1, zero-padded to the number of `C`s; it restarts when the rendered date part changes |
| `N` | The count, never restarting and not padded |
| anything else | Kept as written (`.`, `-`, digits) |

So `YYMMDDCC` gives `26101701` for the first build on 17 October 2026, then
`26101702`, and `26101801` the next day. A count that outgrows its digits (a
100th build in one day with `CC`) fails the stage with a message to widen the
format, rather than producing a number that sorts lower.

### Getting a number in a stage

```ts fragment
m.stage('mac', { on: 'mac-xcode', buildNumbers: ['app.edge.eddy'], run: buildMac })

export async function buildMac(ctx: Stage) {
  const build = ctx.getBuildNumber('app.edge.eddy')          // '26101702'
  await ctx.sh(`scripts/make-dmg.sh --build-number ${build}`)
}
```

- `ctx.getBuildNumber(key)` returns the rendered number as a string. Calling
  it again in the same stage returns the same value.
- A stage gets numbers for the keys it lists in `buildNumbers`, plus the app
  ID of everything in `publishes`. The master reserves them when it assigns the
  stage and sends them with it, so a stage has its numbers even while the
  master is unreachable.
- The stages of one run share a number per sequence: two stages publishing
  one app, or apps of one sequence, get the same number.
- A retried attempt of a stage reuses its numbers; a new run, or a restart of
  that stage, gets new ones. A number is never handed out to two runs, even if a
  run fails.
- An undeclared key uses the default scheme (`scope: 'app'`, `format: 'N'`).

### Where the state lives

- The counters live in the master database, keyed by project, sequence key,
  branch (for `scope: 'branch'`) and date part, and are included in the
  master's encrypted git backups. Only the scheme is in the Masonfile.
- Because each branch carries its own Masonfile, a branch can change its scheme.
  Mason keeps every sequence **strictly increasing** when compared as
  numbers: if a new format would render a value lower than one already handed
  out for that key and scope, setup fails and names the conflict (raise
  `start`, or change the format).
- `scope: 'branch'` gives two branches the same numbers. App Store Connect
  rejects a second upload with the same version and build number, so a
  per-branch scheme for an app that more than one branch sends to TestFlight
  should include a date (`YYMMDDCC`) or use `scope: 'app'`. Setup warns when a
  workflow that calls `ctx.apple.testflight` uses a per-branch scheme without a
  date.
- A manager sets where a sequence stands, so numbers continue rather than
  restart when a project moves to Mason: on the project's page, or with
  `POST /api/v2/build-numbers/seed` and `{ project, key, branch, last }`. The
  next number follows `last`; nothing is lowered. Two Mason instances building
  the same apps keep apart with the `countBase` setting, which offsets every
  count one instance renders.

## 9. Running while the master is away

When a stage starts, its node already has everything it needs: the stage
definition, the checked-out source, its secrets, its stashes, its reserved
build numbers, and an upload token for the host. If the master's link drops:

- the stage keeps running to completion and enforces its own timeout;
- the log, result, return value, stashes it creates and artifacts are kept on
  the node and delivered when the link returns;
- `publish` and `artifacts.save` upload to the host directly; the master
  confirms publication when it reconnects;
- the master shows the stage as `running (disconnected)` until it hears back
  or the stage's timeout passes with no word, when it marks it `interrupted`;
- calls that need the master during a stage — `artifacts.fetch` from another
  run, `ctx.output` of a stage that finished elsewhere after this one started
  — wait for the link (they normally resolve before the stage starts).

### When the master restarts

Run state — stages, assignments, reservations, approvals, stash locations —
is in the master database, written before each step takes effect. After a
master restart (an upgrade, a crash, a power cut):

- workers that were running stages keep running them and report when the
  master redials, as in a link drop;
- queued and waiting stages are scheduled again; approvals still wait;
- cloud machines are reconciled with the provider: the master's own machines
  that are still in use are kept, unknown ones are deleted;
- nothing is rerun that already finished, and nothing is assigned twice.

### Restarting a run from a stage

A developer, manager or admin can restart a finished run **from a chosen
stage**, from the run page or `POST /api/v2/runs/:id/restart {"from": "e2e"}`.
The new run uses the same commit and parameters, keeps the results, outputs,
stashes and artifacts of every stage that does not depend on the chosen one,
and runs the chosen stage and everything after it. Stages that publish get new
build-number reservations. The restart uses the original run's recorded
graph. Approval gates among the restarted stages ask again; an earlier
approval is never carried over.

To make this possible, Mason keeps the stashes of a workflow's most recent
runs: `keep.stashes` (default 3 runs) in the workflow options.

## 10. Script Masonfiles

Existing Masonfiles keep working. A project whose format is `script` runs
`Masonfile.ts` (or `.js`) as one stage named `build` on a node matching the
project's script selector, with every project secret and file injected into
the environment and the `MASON_*` variables of today, exactly as now.

## 11. Versions

- `m.apiVersion(1)` declares the Masonfile API version. Workers support the
  API versions of their Mason major version; setup fails clearly otherwise.
- Mason follows semver. All nodes must share the master's major version. The
  master pushes its minor and patch updates to workers, which install them
  when idle and restart.

## 12. Apple signing and distribution

Mason does what Fastlane's `match`, `cert`, `sigh`, `produce`, `gym`, `pilot`
and `notarize` do, natively. Nothing on any node needs Fastlane, Ruby or
Bundler. The master only makes HTTPS calls to Apple's APIs, so it can run on
Linux or macOS. Mac workers build and sign with Xcode, and need no setup for
it: everything they need comes from the master with each stage.

### Setup on the master

An administrator gives the master, per Apple team:

- an **App Store Connect API key** (issuer ID, key ID and the `.p8` private
  key, with the App Manager role). It stays on the master; workers never
  receive it.
- the **signing certificates** Mason may use, per kind (Apple Development,
  Apple Distribution, Developer ID Application, Developer ID Installer). Each is
  either **imported** — from a `.p12`, or from an existing Fastlane Match
  repository and its passphrase, so current certificates keep working and
  nothing is revoked — or **created** by Mason: it generates the private key,
  sends a certificate signing request through the API, and stores the result.
  Private keys live only in the master database (and its encrypted backups).
- per project app ID: its Apple team, the **bundle IDs** it signs (the app and
  each extension, for example `com.example.app` and
  `com.example.app.widgets`), and its platform (iOS, macOS, both).

### Profiles are automatic

Whenever a stage with an `apple` option is assigned, the master makes sure a
valid provisioning profile exists for each of its bundle IDs and the stage's
distribution, and creates or regenerates one when:

- none exists, or it has expired or expires within 14 days;
- its certificate changed, expired or was revoked;
- for development and ad hoc profiles, the set of enabled devices changed
  (devices registered on the host are added to Apple's device list
  automatically, as today).

Bundle IDs missing from the Apple account are created (Fastlane `produce`);
their capabilities (push, App Groups, iCloud, …) are taken from the
entitlements of the previous successful archive and kept in sync, so a new
capability needs only an entitlements change and one build. Profiles are
cached on the master and delivered with the stage; a stage never waits on
Apple to start unless a profile must be regenerated.

Apple's API can create, read, download and delete profiles but cannot change
one, so a profile's device list is fixed when it is created. Mason
"updates" a profile by creating its replacement first and then deleting the
old one, so a valid profile always exists. Mason names its profiles
predictably (`Mason AdHoc com.example.app`) and only ever deletes profiles
it created, recognised by their IDs; profiles made by hand are left alone.
Every bundle ID — the app and each extension — has its own profile.

**When a device is registered** on the host:

1. The master registers the UDID with Apple unless Apple already has it, and
   shows the device as processing until Apple enables it.
2. It immediately replaces the **development** and **ad hoc** profiles of
   every bundle ID of every iOS app ID, with the full list of enabled devices.
   App Store and Developer ID profiles contain no devices and are untouched.
3. It queues iOS builds of each project's automatic branches, because existing
   builds cannot install on the new device; *Prepare for this device* rebuilds
   one specific build.
4. The next stage signs with the new profiles, and the host checks each
   uploaded IPA's embedded profile before offering it to that device.

**When an app ID is added** on the master:

1. The master creates any of its bundle IDs missing from the Apple account and
   the profiles each distribution needs, at once, so problems show on the
   settings page rather than at the first build.
2. Capabilities come from entitlements, which a brand-new app does not have
   yet: the first build archives, the master syncs the missing capabilities
   (which invalidates the profiles it just made), regenerates them, and retries
   that stage once.
3. TestFlight also needs an App Store Connect app record for the bundle ID,
   which Apple's API cannot create; the master checks for it and lists it on
   the app's checklist until it exists.

**Limits.** Apple allows 100 registered devices of each kind (iPhone, iPad,
Mac, …) per membership year, and disabling a device does not free its slot
until the membership renews. The master shows the slots used and refuses new
registrations with a clear message when they run out. Certificates warn 30
days before they expire.

### Apple ID for Xcode downloads

Signing and TestFlight need only the API key. Downloading an Xcode `.xip`
from Apple needs a signed-in Apple ID (an unauthenticated request is
redirected to `developer.apple.com/unauthorized`). Hosted CI services avoid
signing in per build by installing Xcode into machine images ahead of time;
Mason does the equivalent with one sign-in, on the master:

- An administrator stores the Apple ID and password in the master's settings
  and signs in from the master UI, typing the two-factor code there when Apple
  asks. Apple then trusts that session for roughly two to four weeks; the
  master asks an administrator for a new code only when Apple ends it.
- When a node must install an Xcode version, the master uses its session to
  obtain Apple's **download-only** authorization for that file (the
  `ADCDownloadAuth` cookie Apple's own download flow issues) and sends just
  that to the node over the link. The node downloads the `.xip` straight from
  Apple. The Apple ID, password and session never leave the master, and no
  node ever signs in to Apple.
- If the session has lapsed and no administrator has entered a new code, nodes
  can install from Mason's mirror instead: the first `.xip` of each version a
  node downloads is also copied to the host's storage, and later installs of
  that version fetch it from there.
- No node needs Xcode's own Accounts sign-in: Mason signs manually with
  profiles from the master, which also works for projects set to automatic
  signing because the build settings are overridden for the build.

### Signing on the worker

```ts fragment
m.stage('ios', {
  on: { type: 'mac-xcode', labels: ['apple-signing'] },
  apple: { distribution: 'appStore', app: 'com.example.app' },
  publishes: ['com.example.app'],
  run: buildIos,
})
```

`distribution` is one of `development`, `adHoc`, `appStore` (App Store and
TestFlight), `developerId` (macOS outside the App Store), `macAppStore`.
`bundleIds` defaults to every bundle ID configured for `app`.

Before the stage function runs, the worker:

- creates a temporary keychain with a random password, imports the signing
  identity, allows `codesign` to use it without prompting, and appends it to
  the user's keychain search list, later removing only that entry (it never
  reorders the list or changes the default keychain);
- installs the stage's profiles where Xcode looks for them;
- removes both when the stage ends — success, failure, cancel or crash
  recovery — so no signing material stays on the node.

Any macOS node can sign without being prepared for it: no certificates,
profiles, Apple ID or keychain setup on the node. A project can restrict
signing to nodes with a label (for example to keep signing keys off cloud
machines). The signing identity's private key is the one credential a worker
ever holds, and only for the length of a stage.

### `ctx.apple`

```ts
import type { Stage } from '@mason/types'

export async function buildIos(ctx: Stage) {
  const build = ctx.getBuildNumber('com.example.app')
  const { ipa, dsyms } = await ctx.apple.archive({
    workspace: 'ios/App.xcworkspace',
    scheme: 'App',
    configuration: 'Release',
    version: '1.4.2',
    buildNumber: build,
  })
  if (ipa == null) throw new Error('No IPA was exported')
  await ctx.publish({ app: 'com.example.app', platform: 'ios', path: ipa, buildNumber: build })
  await ctx.artifacts.save('dsyms', dsyms)
  await ctx.apple.testflight({
    path: ipa,
    whatToTest: ctx.run.changes.map((c) => c.subject).join('\n'),
    groups: ['Internal', 'Coaches'],
    usesNonExemptEncryption: false,
  })
}
```

- **`ctx.apple.signing`** — `{ teamId, identity, keychain, profiles,
  buildSettings, exportOptions }` for stages that drive `xcodebuild` themselves.
  `buildSettings` holds `CODE_SIGN_STYLE=Manual`, `DEVELOPMENT_TEAM`,
  `CODE_SIGN_IDENTITY` and a `PROVISIONING_PROFILE_SPECIFIER` per bundle ID;
  `exportOptions` is the path of a ready `ExportOptions.plist`.
- **`ctx.apple.archive(options)`** (Fastlane `gym`) runs `xcodebuild archive`
  and `-exportArchive` with the stage's signing, sets `MARKETING_VERSION` and
  `CURRENT_PROJECT_VERSION` from `version` and `buildNumber` without editing the
  project, condenses Xcode's output in the log (full output saved as an
  artifact), and resolves with `{ archive, ipa? , app?, pkg?, dsyms }`.
  Options: `project` or `workspace`, `scheme`, `configuration`, `destination`,
  `version`, `buildNumber`, `sdk`, `xcargs`, `output`.
- **`ctx.apple.testflight(options)`** (Fastlane `pilot`) uploads the IPA (or
  macOS `.pkg`) through App Store Connect's build-upload API. The **master**,
  holding the API key, creates the build upload and its file record and
  passes the worker only the pre-signed upload URLs and headers Apple returns;
  the worker sends the file straight to Apple, and the master marks the upload
  complete. The master then waits for App Store Connect to finish processing, sets the export-compliance answer, writes "What to Test", adds
  the build to the named beta groups, and submits it for beta app review when
  an external group is named. It resolves with `{ buildId, version,
  buildNumber, state }`. Options: `path`, `whatToTest`, `groups`,
  `usesNonExemptEncryption`, `waitForProcessing` (default `true`),
  `notifyTesters` (default `true`). No Transporter, `altool` or Xcode is
  involved on the master. If the link drops mid-upload, the worker finishes
  sending to Apple and the master completes the upload when it reconnects.
- **`ctx.apple.notarize(options)`** (Fastlane `notarize`) notarizes a DMG, ZIP
  or PKG through Apple's notary web API. The **master** opens the submission
  with its API key and passes the worker only the temporary, single-submission
  upload credentials Apple returns; the worker uploads the file, the master
  polls for the result, and the worker staples the ticket with `xcrun stapler`,
  which needs no credentials. A rejection fails the stage with Apple's log attached
  as an artifact. Options: `path`, `staple` (default `true`).

### Fastlane coverage

| Fastlane | Mason |
| --- | --- |
| `match` (certificates and profiles from a repository) | Certificates stored on the master; Match repositories importable |
| `cert`, `sigh` | Automatic certificates and profiles on the master |
| `register_devices` | Devices registered on the host are added automatically |
| `produce` | Missing bundle IDs created; capabilities synced from entitlements |
| `gym` / `build_app` | `ctx.apple.archive` |
| `increment_build_number`, `increment_version_number` | `buildNumber` and `version` passed to `archive` (project files untouched) |
| `pilot` / `upload_to_testflight` | `ctx.apple.testflight` |
| `notarize` | `ctx.apple.notarize` |
| `setup_ci`, `create_keychain`, `unlock_keychain` | Automatic temporary keychain per stage |
| `xcpretty` | Condensed Xcode output in the log; full output as an artifact |

App Store release submission (`deliver`: metadata, screenshots, submit for
review) is not in this version.

## 13. Example: a complete app

```ts
import type { Setup, Stage } from '@mason/types'

const APP = 'com.example.app'

export function setup(m: Setup) {
  m.apiVersion(1)
  m.buildNumber(APP, { check: 'apple' })

  m.stage('test', {
    on: 'linux',
    tools: { node: '24' },
    cache: [{ key: 'npm', paths: ['~/.npm'] }],
    run: test,
  })

  m.parallel('build', {
    ios: {
      on: { type: 'mac-xcode', labels: ['apple-signing'] },
      tools: { node: '24', xcode: '>=26' },
      apple: { distribution: 'adHoc', app: APP },
      publishes: [APP],
      run: buildIos,
    },
    android: {
      on: 'linux',
      tools: {
        node: '24',
        java: '21',
        android: ['platforms;android-35', 'build-tools;35.0.0'],
      },
      publishes: [APP],
      secrets: ['ANDROID_KEYSTORE'],
      run: buildAndroid,
    },
    web: { on: 'linux', tools: { node: '24' }, run: buildWeb },
  })

  m.stage('e2e', {
    on: 'mac-simulators',
    tools: { node: '24' },
    timeout: '90m',
    retry: { attempts: 2, on: ['failed'] },
    run: e2e,
  })

  m.post({
    failure: { on: 'linux', secrets: ['SLACK_WEBHOOK'], run: notifyFailure },
  })

  m.workflow(
    'release',
    {
      triggers: [{ request: true }],
      params: { external: { type: 'boolean', default: false } },
      concurrency: { group: 'project' },
    },
    (w) => {
      const ship = w.approval('approve', {
        roles: ['admin'],
        message: 'Send this commit to TestFlight?',
      })
      w.stage('testflight', {
        needs: [ship],
        on: 'mac-xcode',
        tools: { node: '24', xcode: '>=26' },
        apple: { distribution: 'appStore', app: APP },
        buildNumbers: [APP],
        run: releaseToTestflight,
      })
    },
  )
}

export async function test(ctx: Stage) {
  await ctx.sh('npm ci')
  await ctx.sh(
    'npm run lint && npm test -- --reporter junit --output reports/unit.xml',
    {
      allowFailure: true,
    },
  )
  await ctx.tests('junit', 'reports/*.xml')
  await ctx.stash('node_modules', ['node_modules/**'])
}

async function archiveIos(ctx: Stage) {
  await ctx.sh('npm ci && npx pod-install ios')
  const build = ctx.getBuildNumber(APP)
  const result = await ctx.apple.archive({
    workspace: 'ios/App.xcworkspace',
    scheme: 'App',
    configuration: 'Release',
    version: '1.4.2',
    buildNumber: build,
  })
  if (result.ipa == null) throw new Error('No IPA was exported')
  return { ipa: result.ipa, dsyms: result.dsyms, build }
}

export async function buildIos(ctx: Stage) {
  const { ipa, dsyms, build } = await archiveIos(ctx)
  await ctx.publish({
    app: APP,
    platform: 'ios',
    path: ipa,
    buildNumber: build,
  })
  await ctx.artifacts.save('ios-dsym', dsyms)
}

export async function buildAndroid(ctx: Stage) {
  const build = ctx.getBuildNumber(APP)
  await ctx.sh(`./gradlew assembleRelease -PversionCode=${build}`, {
    cwd: 'android',
    env: { KEYSTORE: ctx.secretFile('ANDROID_KEYSTORE') },
  })
  await ctx.publish({
    app: APP,
    platform: 'android',
    path: 'android/app/build/outputs/apk/release/app-release.apk',
    buildNumber: build,
  })
}

export async function buildWeb(ctx: Stage) {
  await ctx.unstash('node_modules')
  await ctx.sh('npm run build:web')
  await ctx.stash('web', ['dist/web/**'])
}

export async function e2e(ctx: Stage) {
  await ctx.unstash('node_modules')
  await ctx.unstash('web')
  await ctx.artifacts.fetch(
    { workflow: 'build', commit: ctx.run.commit, name: 'ios-dsym' },
    'tmp/dsym',
  )
  await ctx.sh('npm run e2e', { allowFailure: true })
  await ctx.tests('junit', 'reports/e2e/*.xml')
  await ctx.artifacts.save('screenshots', 'reports/e2e/screens/**', {
    kind: 'report',
    entry: 'reports/e2e/screens/index.html',
  })
}

export async function notifyFailure(ctx: Stage) {
  await fetch(ctx.secret('SLACK_WEBHOOK'), {
    method: 'POST',
    body: JSON.stringify({ text: `${ctx.run.url} failed` }),
  })
}

export async function releaseToTestflight(ctx: Stage) {
  const { ipa } = await archiveIos(ctx)
  await ctx.apple.testflight({
    path: ipa,
    whatToTest: ctx.run.changes.map((c) => c.subject).join('\n'),
    groups: ctx.run.params.external ? ['Internal', 'Coaches'] : ['Internal'],
    usesNonExemptEncryption: false,
  })
}
```

## 14. Jenkins coverage

| Jenkins | Mason |
| --- | --- |
| `pipeline`, `stages`, `stage`, `steps` | `setup`, `m.stage`, stage functions |
| `agent { label }`, `agent none` | `on` node selector; approvals hold no node |
| `parallel`, `failFast`, sequential `stages` inside a parallel branch | `m.parallel`, `failFast`, sequences as parallel members |
| `matrix`, `axes`, `excludes` | `m.matrix` |
| `when { branch, changeset, environment, expression, beforeAgent }` | `when`, or plain `if` in setup; `when` is always evaluated before a node is chosen |
| `environment`, `credentials()`, `withCredentials` | `env`; `secrets` + `ctx.secret`/`secretFile`, masked |
| `parameters` | workflow `params` |
| `triggers { cron, pollSCM, upstream }` | `schedule`; push detection by the master; `after` |
| `options { timeout, retry, disableConcurrentBuilds, buildDiscarder, skipDefaultCheckout, timestamps, preserveStashes }` | `timeout`, `retry`, `concurrency`, `keep`, `checkout: false`, always timestamped, `keep.stashes` |
| `timeout(activity: true)` | `activityTimeout` |
| `ansiColor` | always on; rendered on the master and host |
| `agent { node { customWorkspace } }` | `workspace: { path }` |
| Restart from stage | run restart from a chosen stage |
| Pipeline durability across controller restarts | runs resume after a master restart |
| GitHub webhook triggers | host webhook endpoint forwarded to the master; polling as fallback |
| Cloud agents (EC2, DigitalOcean plugins) | cloud node types with pools on the master |
| `input` | `m.approval` |
| `post { always, success, failure, unstable, changed, fixed, regression, aborted, cleanup }` | `m.post` (`changed` = `fixed` or `regression`; cleanup is automatic) |
| `stash`/`unstash` | `ctx.stash`/`ctx.unstash` |
| `archiveArtifacts`, `copyArtifacts` | `ctx.artifacts.save`, `ctx.artifacts.fetch` |
| `junit`, test trends | `ctx.tests` |
| `tools { jdk, nodejs }` | `tools` with automatic installation |
| `lock` (Lockable Resources) | `lock` |
| `build job:` (downstream) | `after` triggers within the project |
| `currentBuild.result`, `unstable()`, `catchError` | return/throw, `ctx.unstable`, `continueOnError` |
| `currentBuild.description`/`displayName` | `ctx.describe` |
| `sh`, `bat`, `powershell`, `dir`, `ws` | `ctx.sh`, `ctx.exec`, `cwd` |
| `retry`, `timeout`, `sleep`, `waitUntil` | `ctx.retry`, `ctx.timeout`, `ctx.sleep`, `ctx.waitUntil` |
| `checkout scm`, multiple SCMs, `sshagent` for pushes | automatic pinned checkout fetched from the master; `ctx.checkout`; `ctx.git.tag` pushed by the master |
| Shared libraries | ordinary TypeScript imports from the repository |
| Blue Ocean stage view, console log | master and host run pages with live logs |
| Build numbers (`BUILD_NUMBER`) | `ctx.run.number` per workflow; app build numbers per app ID |
