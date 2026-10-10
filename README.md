
## Builder role

Mason can also run a trusted build worker on a separate machine. It does not
need distribution storage or OAuth configuration. Node 24 and Git are required;
Masonfiles install their own compiler dependencies. Execute compiled commands
with `node lib/cli.js builder ...`.

Create an owner-only JSON bootstrap file (`chmod 600`) containing `workspace`
(an absolute dedicated directory), `listenHost` (defaults to `127.0.0.1`) and
`port` (defaults to `9300`). The workspace stores `builder.sqlite`, owned bare
clones in `git/`, reusable branch worktrees in `git-worktrees/`, logs, execution
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

`position` defaults to zero and `enabled` to true. `workspace` optionally selects
a worktree subdirectory; `entrypoint` selects a relative `.ts` or `.js` file.
Otherwise Mason uses `Masonfile.ts`, then `Masonfile.js`. TypeScript must use
syntax supported by Node's native type stripping. Configured environment values
are secret by default. Injected file contents are base64, copied with mode 0600,
and removed after execution. They cannot overwrite repository files. Persistent
mutable files are maintained by the operator; supply their paths as environment
values instead of injecting them.

`builder key-create --config <bootstrap> --output <new-key-file>` writes a new
key once and prints its revocation ID. `builder key-revoke --config <bootstrap>
--id <id>` revokes it. Start the worker with `builder serve --config <bootstrap>`.
All REST operations require `Authorization: Bearer <key>`:

- `POST /api/jobs`: `{"app":"app.example.client","branch":"master","platforms":["ios"],"idempotencyKey":"unique-request","envVars":[{"APP_SERVER_URL":"https://preview.example.test"}]}`.
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
Mason fetches from GitHub, pins the branch commit, resets its owned worktree and
removes all old worktree contents before injection. Git credentials come from
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
