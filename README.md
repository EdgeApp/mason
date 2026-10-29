# Mason

Mason builds, signs and distributes apps. A cluster has three kinds of node,
each the same `mason` program:

- the **master** holds the only database: projects, people, keys, settings,
  runs, build numbers and the Apple and GitHub credentials. It dials every
  other node over an authenticated WebSocket link and decides what runs where.
- **workers** run Masonfile stages. They keep no configuration of their own;
  the master tells each one which tools its node type needs.
- the **host** serves the catalog, installs, device registration and sign-in
  from a replicated cache, and keeps serving builds while the master is away.
  It holds no secrets.

The Masonfile reference, with every option and the stage API, is
[docs/masonfile.md](docs/masonfile.md).

## Installing

A release needs no Node.js or npm. On each computer:

```sh
/bin/bash -c "$(curl -fsSL https://github.com/EdgeApp/mason/releases/latest/download/install.sh)"
# or, once a host serves the current release:
/bin/bash -c "$(curl -fsSL https://builds.example.test/install.sh)" -- --from https://builds.example.test
```

Then start each role as a service (data in `~/.mason` unless `--data` says
otherwise):

```sh
sudo mason master --install --port 9400      # with --worker, the master also runs stages
sudo mason worker --install --link-port 9410
sudo mason host --install --port 8443 --link-port 9420
mason status                                  # role, state, version, fingerprint, web address
```

A host on a public server can leave TLS to a terminator on the same machine,
such as Caddy with `builds.example.test { reverse_proxy 127.0.0.1:9200 }`:
its web port then serves plain HTTP on loopback, while the link stays on Mason's
own TLS for the master to reach:

```sh
sudo mason host --install --listen 127.0.0.1 --port 9200 --web-plain --link-listen 0.0.0.0 --link-port 9310
```

On first start the master prints a six-digit setup code. Create the first
administrator in the browser at the master's address, or from its terminal:

```sh
mason setup --username ada --password-stdin --api-key-out ~/.mason/admin.key
```

`mason update` installs a newer release on a node and restarts its services.

## Pairing nodes

A new worker or host prints a pairing key when it first starts. Pair it from
the master's Nodes page (**Add node**), or from the master's computer:

```sh
mason nodes add --address 192.168.1.20:9410 --key mason1:…
mason nodes set second --type mac-xcode --label apple-signing --slots 2
mason settings set host --file host.json     # {"origin": "https://builds.example.test"}
```

Node types (`mason settings set nodeTypes`) list the software every node of
that type keeps: Xcode versions, Node, Java, the Android SDK packages (their
licences accepted by an administrator per type) and Homebrew or apt packages.
Each node's page lists what still needs a person, such as a macOS permission.

`mason cluster check` reports every node: linked or not, its Mason version
against the master's, a worker's last inventory and quarantine, and the
host's cache revision lag, outbox depth and refused messages. It exits
non-zero until everything is green. A host the master made on a cloud
provider shows as updating to the master's release while it does.

A host the master made on a cloud provider follows the master's release.
After `mason update` on the master, the master asks the host over its link to
update; the host writes the request in its data directory and a root unit
that `--install` set up (`mason-host-update.path`) installs that release and
restarts it. No SSH is involved. The Nodes page shows the host as
**updating** until it links again on the release, or the reason it could not.
A host installed before this has no such unit: run `sudo mason update` on it
once, or recreate it.

## Projects

A project is a GitHub repository with a Masonfile, the app IDs it owns, its
secrets and its branch rules. Add one with **Add project** on the master's
dashboard: the master reads the repository with its own GitHub credentials,
reads the Masonfile on the default branch to list the app IDs it publishes,
records the ones the project owns (with their Apple team), saves the branch
rules and creates the GitHub webhook. From the terminal:

```sh
mason projects set phones --file project.json
mason projects get phones
```

Branch rules are globs, first match wins: `automatic` builds every new
commit (at most 20 automatic branches per project), `request` builds only
when someone asks. Deleted branches stop polling; forks never build.

## Pipelines

A pipeline Masonfile declares workflows of stages, each with the node it
runs on, the tools it needs, the secrets it may read and the app IDs it
publishes. `setup` runs on a worker with no secrets; the master checks the
graph it returns and schedules the stages. Requests come from the dashboard,
`POST /api/v2/runs`, pushes and schedules:

```sh
mason api POST /api/v2/runs --file run.json   # {"project": "phones", "branch": "main", "params": {"seat": "1"}}
mason runs list --project phones
```

Each run's page draws its stages as a graph, follows the selected stage's
steps and log live, and offers approve, cancel, restart-from-a-stage and
request-run. Apple signing, TestFlight and notarization use the master's App
Store Connect key; a stage receives only the signing material it needs for its
own duration.

## Migrating from the standalone server and builder

The master imports the existing distribution and builder databases before
its first setup and the host imports the distribution's build files:

```sh
mason import --distribution distribution.sqlite --builder builder.sqlite
mason host import --distribution distribution.sqlite --storage /srv/mason/storage
```

Where a build-number sequence should continue from numbers issued elsewhere,
set its last number on the project's page (or `POST /api/v2/build-numbers/seed`).

Existing sessions, devices, keys, builds and upload keys carry over, and the
Zealot upload API (`version_exist`, `POST /api/apps/upload`) answers as
before. Script-format Masonfiles keep working; a project moves to a pipeline
Masonfile when it is ready. The sections below document the standalone
builder and distribution server, which the cluster replaces.

## Builder role

Mason can also run a trusted build worker on a separate machine. It does not
need distribution storage or OAuth configuration. Node 24 and Git are required;
Masonfiles install their own compiler dependencies. Execute compiled commands
with `node lib/cli.js builder ...`.

Create an owner-only JSON bootstrap file (`chmod 600`) containing `workspace`
(an absolute dedicated directory), `listenHost` (defaults to `127.0.0.1`) and
`port` (defaults to `9300`). The workspace stores `builder.sqlite`, one owned clone in `checkout/`, logs, execution
locks and user-maintained files in `files/`. Do not point it at an existing clone.

Import each app using `builder app-import --config <bootstrap> --file <app.json>`.
The app file is also owner-only JSON:

```json
{
  "slug": "app.example.client",
  "name": "Example",
  "repository": "https://github.com/example/client.git",
  "platforms": ["ios", "android"],
  "timeoutSeconds": 14400,
  "env": [{ "name": "BUILD_NUMBER_FILE", "value": "/example/state/buildNum.json", "secret": false }],
  "files": [{ "destination": "private-build.json", "contents": "e30=", "env": "DEPLOY_CONFIG_FILE" }]
}
```

`position` defaults to zero and `enabled` to true. The legacy app `workspace` field is accepted for compatibility but no longer
changes the checkout location. `entrypoint` selects a relative `.ts` or `.js` file.
Otherwise Mason uses `Masonfile.ts`, then `Masonfile.js`. TypeScript must use
syntax supported by Node's native type stripping. Configured environment values
are secret by default. Injected file contents are base64, copied with mode 0600,
and removed after execution. They cannot overwrite repository files. Persistent
mutable files are maintained by the operator; supply their paths as environment
values instead of injecting them.

`builder key-create --config <bootstrap> --output <new-key-file>` writes a new
key once and prints its revocation ID. `builder key-revoke --config <bootstrap>
--id <id>` revokes it. Start the worker with `builder serve --config <bootstrap>`.
Opening the listener's root (`http://<host>:<port>/`) in a browser shows a
status page: the running build (or a finished one still holding the worker,
with its reason) and then the queued builds, next to run first. Each shows the
app, commit, branch, when it was queued, how it was queued (branch poll or
API) and an API caller's IP address. The running build also shows when it
started and how long it has run; a queued build shows how long it has waited.
The page refreshes every ten seconds. It is the only route that needs no key,
so anyone who can reach the listener can read the queue.

Everything under `/api` requires `Authorization: Bearer <key>`:

- `POST /api/jobs`: `{"app":"app.example.client","branch":"master","platforms":["ios"],"idempotencyKey":"unique-request","envVars":[{"APP_SERVER_URL":"https://preview.example.test"}]}`. The job records the caller's TCP address.
- `GET /api/queue`: jobs that are queued, running, or holding the worker, oldest first. `created` is when the job was queued and `started` is when it began running (`null` until then). `branch` is the requested branch. `commit_sha` is the pinned commit after checkout, and `requested_commit` is the commit a poll scheduled. `trigger` is `poll` when the branch check queued the job and `api` when `POST /api/jobs` did. An API job includes `client_ip`. `client_name` is that address's reverse-DNS name when the lookup answers quickly, otherwise `null`. Poll jobs leave both null.
- `GET /api/jobs/:id`: status, pinned commit, timestamps, exit code and optional result.
- `GET /api/jobs/:id/log`: bounded, redacted plain text.
- `GET /api/jobs/:id/logs`: download the full redacted build log as plain text.
- `POST /api/jobs/:id/cancel`: cancel a queued or running job.

A private client JSON file contains `url` and `keyFile`. Run `builder build
--client-config <file> --app <slug> [--branch <branch>] [--platform ios,android]` to
submit once and wait for completion. Failure, cancellation and partial builds
return nonzero. A disconnected client can inspect its printed job ID; it does
not resubmit automatically.

Mason supplies `MASON_APP`, `MASON_BRANCH`, `MASON_COMMIT`, `MASON_JOB_ID`,
`MASON_WORKSPACE`, `MASON_PLATFORMS` (comma separated), and `MASON_RESULT_FILE`.
A Masonfile may write JSON up to 64 KiB to the result path. Exit zero means
success; partial builds must exit nonzero. Upload credentials are ordinary
private app config, separate from builder API keys. Mason does not interpret
deploy commands or upload packages itself.

One worker executes one job at a time. Each request snapshots its definition.
Mason fetches from GitHub, pins the branch commit, switches its single clone to that commit and
removes all old generated and untracked contents before injection. Masonfiles
install dependencies in that checkout. Switching repositories replaces the
clone at the same path, so branches and repositories cannot accumulate build
directories. Old `git-worktrees/` and `git/` directories from previous versions
can be removed during maintenance after all guardians have stopped. Git credentials come from
the worker account's credential helper or SSH environment. The existing `/log`
view is capped at 4 MiB; `/logs` streams the complete retained stdout and stderr,
including checkout commands and failure messages. Completed records and both
log files expire after fourteen days. The queue is capped
at 100 active jobs. Keys authorize arbitrary configured branches: callers and
repository code must be trusted. This is not a sandbox. Literal configured secret
values are masked in logs and results, but scripts can disclose transformed
values or credentials loaded from files. Restrict the listener to a trusted
network and use TLS when that network is not trusted.

A guardian stops descendants on cancellation, timeout or server disconnect.
Ordinary nonzero compiler exits stay `failed`, with their exit code and result,
and release the worker after fresh process checks. Transient process-inspection
failures are retried, and defunct processes are not treated as running builds.
If injected-file cleanup fails after processes stop, Mason discards its owned
checkout. A persistent filesystem cleanup problem is reported as `cleanup_error`
and does not hold other jobs; the affected checkout must be recreated before use.

Masonfiles must forward signals and must not daemonize or deliberately escape
job ownership. An uncertain guardian crash quarantines the queue instead of
starting another build over a potentially live process. Stop the service,
inspect and stop remaining job processes, then explicitly run `builder recover
--config <bootstrap> --job <id> --confirm-stopped yes`. Never use recovery without
checking. Recovery removes recorded injections; the next checkout is cleaned.
Completed jobs retain their original status, timestamps, exit code and result
when recovery releases a hold. `quarantine_reason` explains holds caused by
remaining process groups, unavailable terminal process inspection or a lost
guardian. An active job's `quarantine: 1` is normal ownership; it is a queue hold
when attached to a terminal job. Cleanup failures do not relabel a completed
compiler result as `interrupted`; that status describes an interrupted execution.
Distribution remains independently operated and accepts equal build numbers on
different branches, while preserving uniqueness within each channel and branch.

### Builder admin API

`builder key-create --config <bootstrap> --output <new-key-file> --role admin`
creates a key that can also manage app definitions over HTTP, so a new app
needs no file on the builder. Admin keys build like any other key; ordinary
keys get 403 from these routes, which accept JSON bodies up to 1 MiB:

- `GET /api/admin/apps` and `GET /api/admin/apps/:slug`: definitions without
  secrets. Secret environment entries show only `name` and `secret: true`;
  injected files show `destination`, `env` and their size in `bytes`.
- `PUT /api/admin/apps/:slug`: add (201) or replace (200) the definition, in
  the same format as `app-import`. A `slug` in the body must match the path.
  Because secrets are never returned, an environment entry
  `{"name":"UPLOAD_TOKEN","keep":true}` or a file entry
  `{"destination":"deployConfig.json","keep":true}` reuses the stored value;
  a kept file may set a new `env`. Entries left out are removed.

A new app starts with the default build settings, like an imported one.
Queued and running jobs keep the definition they snapshotted.

### Automatic branch builds

The authenticated builder API exposes `GET /api/apps` and
`GET /api/apps/:slug/build-settings`, including each app's default branch,
automatic branches and persisted progress. Update an app with
`PUT /api/apps/:slug/build-settings` and this complete configuration:

```json
{
  "defaultBranch": "master",
  "automaticBranches": ["master", "feature/example"]
}
```

The same builder API key authorizes these endpoints. Settings are separate from
private app definitions; the API never returns injected files or secrets, and
reimporting a definition preserves its build settings. Existing and newly
imported apps default to `master` with automation disabled until configured.
Omitting `branch` from a manual job or the build client uses the app's default.

Mason checks configured remote Git refs at startup and every five minutes.
Apps sharing a repository and branch share one lookup per poll. Enabling a
branch schedules its current head on the next check. Subsequent checks schedule
new commits, or retry an unsuccessful automatic build at most twice: three
automatic attempts total for each app/branch/commit. Each attempt is reserved
atomically when queued; cancellation, timeout and interruption consume that
reservation. Remote lookup failures and a full or quarantined queue consume no
attempt. Manual builds have their own behavior and do not consume this budget.

Automatic jobs snapshot the app definition and pin the polled commit, even if
the branch moves while waiting. They use the stored environment and all the
app's supported platforms, and execute through the ordinary serial worker.
One pending build per app/branch prevents duplicate scheduling; the next poll
uses the latest head after that job ends. A successful commit is not rebuilt,
and an exhausted commit is not retried merely because the service restarts or
the branch is disabled, re-enabled or moved away and back.

Branch state includes `lastSuccessfulCommit`, `lastAttemptedCommit`,
`lastJobId`, `attempts`, `observedCommit`, `lastChecked` and `pollError`.
These fields describe automatic builds. Success requires a successful job at
the requested commit; a failed newer commit leaves the previous success
visible. State and per-commit retry budgets survive the fourteen-day job/log
retention window. API job responses mark automatic jobs with `automatic: 1`
and include their `requested_commit` as well as the executed `commit_sha`.

Set `automaticBranches` to `[]` to stop future scheduling. Disabling an app
also pauses its rules. Already queued or running jobs retain their snapshots;
use the ordinary job cancellation endpoint if they should be stopped.
Automatic builds still require a valid Masonfile and working app-specific
build, signing and upload settings. Partial results remain failures.

Per-job `envVars` is optional: an array of single-entry string maps. Values
replace stored app environment values for this job only. Omit it or pass `[]`
to use defaults; stored definitions and subsequent jobs remain unchanged.
Names must follow the configured environment-name rules. Reserved `MASON_*`
and runtime injection names, duplicate names, and injected-file environment
bindings cannot be overridden. Each object must contain exactly one variable.
There can be at most 100 variables, 4,096 characters per value (no NUL), and
8 KiB of serialized overrides; the entire HTTP request still has an 8 KiB limit.

Overrides are included in the private queued snapshot and idempotency check.
Reordering variables does not change a request, but changing a value with the
same idempotency key is rejected. All override values are masked in job logs
and results, and are never returned as request configuration in the API.
They reach the Masonfile child after checkout, not the builder or Git process.
Build scripts remain trusted code and can deliberately disclose their inputs.

The full-log API uses the same builder key as other job operations. It returns
`Content-Disposition: attachment` with a job-specific filename and supports
HTTP byte ranges for large downloads. Running jobs return a snapshot of output
available so far; download again after the job reaches a terminal status.
`X-Mason-Log-Capture: full` identifies complete capture for jobs started by this
version. Older jobs fall back to their retained bounded log with
`X-Mason-Log-Capture: legacy`; previously discarded output cannot be recovered.
Queued jobs without a log and unknown IDs return 404; unauthenticated requests
return 401. Output deliberately suppressed by repository build scripts never
reaches Mason. Full logs consume disk according to actual output, rather than
stopping at 4 MiB.

### Registering iOS test devices

The green **Register Device** button beside **Sign out** opens a temporary
Profile Service download. In Safari on an iPhone or iPad, download the profile,
then open Settings → Profile Downloaded → Install. The device sends a signed
UDID/model/OS response to Mason. The registration is saved to the signed-in
tester's account. Model names default to `iPhone13 of mark@example` and can be
edited. Desktop visitors can scan a QR code to open the flow on their phone.

Registration does not install an app signing certificate, root CA, or MDM
payload. The profile is unsigned; Apple's profile-installation warning is
expected. Only UDID, PRODUCT and VERSION are requested. Device callbacks verify
CMS signatures against Apple's roots and an expiring one-use account/session
challenge. Apple's built-in device identity certificate dates are ignored as
specified by its Profile Service documentation; the signature, chain and device
issuer are verified. Registration and installation require existing tester or
administrator access. New registrations never implicitly grant tester access.

Enable registration in the private distribution configuration:

```json
"devices": {
  "trustStoreFile": "/srv/mason/src/devices/apple-roots.pem",
  "openssl": "openssl"
}
```

The provided Apple root certificates are public certificates from Apple's PKI
website.

In a Mason cluster the host serves registration and sends each device to the
master through its outbox. The master registers the device with Apple through
its App Store Connect key, replaces the development and ad hoc profiles of
every iOS app ID with the full list of enabled devices (the new profile is
made before the old one is deleted), and queues iOS builds of each project's
automatic branches; no worker and no Apple credential outside the master is
involved. **Prepare for this device** queues a new build of that package's
exact branch and commit.

Mason verifies and records device membership and expiry from each uploaded
IPA's embedded Apple-signed ad hoc profile, including the app identifier.
Installation grants are bound to the selected account-owned device and checked
again at manifest/artifact download. Unregistered, incompatible and expired
profiles are never presented as ready. Android and desktop downloads keep their
existing behavior. `devices-inspect --config <distribution config>` backfills
retained IPAs.

Apple's annual device allowance still applies. Removing an account association
does not disable the device at Apple, recover a device slot, or revoke downloaded
apps. Use the Apple developer account to manage that separate device lifecycle.
See `src/devices/NOTICE.md` for Zealot and DeviceKit attribution.

## Distribution admin API

Apps, their upload channels and upload keys are managed over HTTP, so adding
an app needs no database access. An admin key authorizes it. Mint the first
one on the distribution server; the credential is printed once:

```sh
node lib/cli.js keys create --config <config> --name <name> --role admin --json
```

Save it with `keys import --file <private file>` like an upload credential.
Admin keys cannot upload packages, and upload keys cannot reach the admin API.
Admin keys are not scoped to apps and are only created with the CLI. `keys
list` shows each key's `role`; `keys revoke` revokes either kind.

Every route below takes `Authorization: Bearer <admin token>` and JSON bodies
up to 16 KiB, and is limited to 120 requests a minute:

- `GET /api/admin/apps`: every app, including disabled ones, with its channels.
  A channel's `key` is the `channel_key` its uploads send.
- `POST /api/admin/apps`: `{"slug":"app.example.desktop","name":"Desktop"}`.
  The slug is the package's bundle identifier. `position` defaults to after
  the last app and `enabled` to true. An existing slug returns 409.
- `GET` or `PATCH /api/admin/apps/:slug`: read, or change `name`, `position`
  and `enabled`. Omitted fields are kept.
- `POST /api/admin/apps/:slug/channels`: `{"platform":"macos"}` creates the
  platform's channel with a random key. `formats` defaults to every format the
  platform allows (`dmg` for macOS, `exe` and `msi` for Windows). One channel
  per platform; a second returns 409.
- `PATCH /api/admin/apps/:slug/channels/:platform`: change `formats` or
  `enabled`, or pass `"rotateKey":true` for a new channel key.
- `GET /api/admin/keys`: keys with their role, with app scopes as slugs.
- `POST /api/admin/keys`: `{"name":"Desktop builds","apps":["app.example.desktop"]}`
  creates an upload key and returns its one-time credential. `apps` may be
  `"all"`; `expiresAt` is optional epoch milliseconds.
- `POST /api/admin/keys/:id/revoke`: revoke an upload or admin key.

Unknown apps, channels and keys return 404; invalid input returns 400.
Changes are recorded in the audit table.
