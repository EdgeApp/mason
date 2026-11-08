# Master API reference

The Mason master serves its HTTP API under `/api/v2/` on its web listener.
The dashboard, the `mason api` command and scripts all use it. This document
is the reference for every route under `/api/v2/`, for how callers
authenticate, and, briefly, for the few routes outside `/api/v2/` that
clients still use. The host forwards most of these routes to the master
(see [Requests through the host](#requests-through-the-host)); it answers
the builds routes itself (see [Builds](#14-builds)).

## Conventions

- Bodies are JSON (`Content-Type: application/json`), and so are answers,
  except log downloads (`text/plain`) and build downloads, which answer the
  file or a redirect to it (section 14). Live updates come over the `/live`
  WebSocket (section 4). A route that has nothing to return answers `null`.
- Times are milliseconds since the Unix epoch.
- An error answers `{ "error": "<message>" }` with one of these statuses:

  | Status | Meaning |
  | --- | --- |
  | 400 | The request is invalid: a field fails its check, or the action is refused for a reason the message gives. |
  | 401 | No credential, or one that is unknown, revoked or expired (on the host, a key revoked while the master was away once the host has synced). |
  | 403 | The caller's role, a key's scopes or the CSRF check refuses it. |
  | 404 | No such route, project, run, node or other thing the path names. |
  | 409 | The change conflicts with what exists (a name taken, a project still running). |
  | 413 | The body is over the route's limit. |
  | 429 | Sign-in or setup is locked for a while; the answer has `retryAt`. |
  | 502 | A peer did not answer: a node during pairing, a backup push, a Space. |
  | 503 | The host is not connected, or a host past its offline grace window. |
  | 500 | The host failed to answer a builds route for a reason of its own. |

  Some areas map further errors; their sections say so.
- Bodies are limited per area. The first limit that applies to a path is the
  one that holds:

  | Paths | Limit |
  | --- | --- |
  | `/api/v2/projects/:slug/secrets…` | 8 MB |
  | `/api/v2/apple/certificates`, `…/profiles`, `…/setup` | 2 MB |
  | the wizard's routes: `POST /api/v2/projects/check` (that path alone, so a project slugged `check` takes the next limit), `…/:slug/discover`, `…/:slug/wizard/…`, `…/:slug/webhook`, `…/:slug/masonfile` | 64 KB |
  | other `/api/v2/projects…` | 1 MB |
  | `/api/v2/build-numbers/…` | 1 MB |
  | `/api/v2/runs…`, `/api/v2/queue…` | 16 KB |
  | `/api/v2/session…`, `/api/v2/people…`, `/api/v2/groups…`, `/api/v2/settings/backup…`, `/api/v2/backups`, `/api/v2/storage…`, `/api/v2/cloud…` | 64 KB |
  | every other `/api/v2/…` route | 1 MB |

  A host forwards at most 512 KB.
- The master serves HTTPS. When its certificate is its own rather than one a
  public CA signed, the master logs a pin at start (`pin: sha256//…`) and
  `mason status` prints it. `mason api` uses it; with curl, pass
  `--insecure --pinnedpubkey 'sha256//…'`.

The examples use `$MASON` for the master's URL (such as
`https://mason.example.test`) and `$KEY` for an API key.

## 1. Authentication

Every `/api/v2/` route except sign-in (`POST /api/v2/session/parameters`,
`POST /api/v2/session` and `GET /api/v2/session`) needs a caller. The master
takes, in this order:

1. an `Authorization: Bearer <key>` header: an API key;
2. a request the host forwarded for one of its signed-in people, on the
   master's private API socket only;
3. the master's session cookie, from a browser signed in on the master.

A request with an `Authorization` header is judged by the key alone: a bad
key is 401 even when a session cookie is also sent.

### API keys

A key is sent as `Authorization: Bearer mason_v1_<id>.<secret>`. Keys
imported from the standalone builder are 64 hex digits and work the same way.
An unknown, revoked or expired key answers 401 `An API key is required`.
The host checks keys for the builds routes itself, against the digest of
each live key the master sends it, so a key revoked while the master is
away keeps working on the host until the host syncs again.

Each key has a role, a name and optional scopes. It acts with its own role
or its creator's current role, whichever is lower, and stops working (403
`The key’s owner is disabled`) once its creator is disabled or removed. Keys
made by the local operator (`mason keys create`, `mason setup`) have no
creator and keep their role.

Ways to get a key:

- `mason setup --username ada --password-stdin --api-key-out ~/.mason/admin.key`
  creates the first administrator and an `admin` key named `Setup key`, and
  writes its token to the file.
- `mason keys create --role developer --project phones --out phones.key`
  on the master's computer, through its control socket.
- `POST /api/v2/keys` (see [API keys](#3-api-keys)), from a session or
  another key. A key cannot have a higher role than its creator, and a
  scoped key can only make keys within its own scopes.

The token is shown once, in the answer that creates it.

**Scopes.** A key may be limited to `projects` (exact project slugs) and
`branches` (branch patterns, the same globs as branch rules). An empty list
means no limit. A scoped key:

- sees only the projects, runs and queue entries its scopes cover in lists;
- is refused (403 `This key does not cover that project or branch`) on a
  project or run outside them;
- is refused (403 `This key is scoped to projects and cannot do that`) on
  anything that is not about one project: settings, nodes, people, groups,
  storage, backups, cloud and Apple routes, and listing or revoking keys. It
  may still create keys within its own scopes.

### Browser sessions

People sign in on the master's own pages. Sign-in uses a client-hash
protocol: the browser asks for the account's Argon2id parameters, hashes
the password with them, and sends only the hash
(see [Session](#session)). The master answers with the cookie
`__Host-mason-master` (HttpOnly, Secure, SameSite=Strict, 14 days) and the
session's CSRF token.

A session ends when it expires, when the person signs out, and when their
permission version changes: a change of role, name, password, addresses,
disabled state or group membership.

Every request from a session that is not `GET`, `HEAD` or `OPTIONS` must
pass the CSRF check (`checkCsrf`):

- its `Origin` header names the host it was sent to (or is `null` with
  `Sec-Fetch-Site: same-origin`, as a no-referrer page sends);
- it carries the session's CSRF token in the `X-Mason-CSRF` header, or in a
  `csrf` field of the body.

A failure answers 403 `Untrusted origin` or `Invalid request proof`. Scripts
use API keys instead.

Repeated wrong passwords lock sign-in: 5 failures for an account or 10 from
one address within 15 minutes lock it for 15 minutes (429 with `retryAt`).

Once the `master` setting names the master's public origin, its sign-in page
also offers each enabled [sign-in method](#sign-in-methods). These are
pages, not API routes, and are limited to 120 requests a minute per address:

- `GET /auth/start/:id?return=/path` starts the provider's authorization
  code flow with PKCE, a state and (OpenID Connect) a nonce, kept for ten
  minutes and bound to the browser by the cookie `__Host-mason-master-oauth`
  (HttpOnly, Secure, SameSite=Lax). A browser that opened the master at
  another address is first sent to the same path at the master's origin; one
  already signed in is sent home.
- `GET /auth/callback/:id` uses that state once, has the master exchange the
  code with the provider, and signs in the enabled person whose email, or
  whose address for that method, is the verified email the provider
  asserts, ignoring case. It sets the session cookie and answers a page that
  moves on to the return path from the master's own origin, since a
  SameSite=Strict cookie is not sent on the provider's redirect. A provider
  that does not assert a verified email, an address nobody has, or a
  disabled person is refused (403, with the reason). A method address that
  is a person's for that method wins over another person's email. An
  unknown or disabled method, at either route, and an expired, replayed or
  foreign state are 400. Each such sign-in is audited as
  `session.provider` with the method's ID.

Without the `master` setting these pages answer 404 and the master offers
only username and password.

### Requests through the host

The host forwards `/api/jobs…`, `/api/queue…` and `/api/v2/…` (`GET`,
`POST`, `PUT` and `DELETE`, bodies up to 512 KB) to the master over the
master's link, where they meet the same routes and checks as direct
requests. While the master is unreachable the host answers 503. `/api/apps`
is not forwarded, and neither is `GET /api/v2/builds…`: the host answers
those itself, from its cache and storage, for API keys and for its own
signed-in people, and keeps answering while the master is away (see
[Builds](#14-builds)).

- A forwarded request with an `Authorization` header is an API-key request;
  the master checks the key.
- A forwarded request without one is made for a person signed in on the
  host. The host allows only the run reads and run actions below, and the
  master accepts it only while that account is enabled and its permission
  version is unchanged. It is audited as `host:<account id>`.

  | Kind | Requests | CSRF proof |
  | --- | --- | --- |
  | Run reads (`isRunRead`) | `GET /api/v2/runs/:id/logs` | none |
  | Run actions (`isRunAction`) | `POST /api/jobs`, `POST /api/jobs/:id/cancel`, `POST /api/v2/runs`, `POST /api/v2/runs/:id/cancel`, `…/restart`, `…/approve` | the host session's token in `X-Mason-CSRF` or `csrf`, from the host's own origin |

  Any other request from a host session answers 403.
- The host's `/live` is not a forwarded request: the host relays it over its
  link (see [Live updates](#live-updates)).
- The master's own session cookie is never accepted on a forwarded request,
  and sign-in and setup refuse forwarded requests (403 `Sign in on the
  master itself`).

### Roles and permissions

Every account and key has one of four roles. Each role includes the ones
below it:

| Role | In short |
| --- | --- |
| `admin` | Everything, including people, sign-in methods and the backup key. |
| `manager` | Configures Mason: projects, secrets, settings, nodes, keys, Apple, backups, groups. |
| `developer` | Reads projects and runs, requests, cancels, restarts and approves runs, makes keys up to its own role. |
| `tester` | Sees its groups' published builds on the host, and reads them through the builds routes (section 14). Through the rest of this API it can read its own person record, change its own password and sign out. |

Routes check a permission with `allow(actor, '<permission>')`, which also
applies a key's scopes, or `allowRole`, which checks only the role. The
lowest role each permission needs (`src/master/permissions.ts`):

| Permission | Role | | Permission | Role |
| --- | --- | --- | --- | --- |
| `builds.read` | tester | | `settings.read` | manager |
| `devices.register` | tester | | `settings.change` | manager |
| `apps.read` | developer | | `nodes.read` | manager |
| `projects.read` | developer | | `nodes.change` | manager |
| `runs.read` | developer | | `keys.read` | manager |
| `runs.request` | developer | | `keys.revoke` | manager |
| `runs.approve` | developer | | `apple.change` | manager |
| `keys.create` | developer | | `backups.run` | manager |
| `projects.change` | manager | | `groups.read` | manager |
| `secrets.read` | manager | | `groups.change` | manager |
| `secrets.change` | manager | | `people.read` | manager |
| `buildNumbers.seed` | manager | | `people.change` | admin |
| | | | `signIn.change` | admin |
| | | | `hosts.change` | admin |
| | | | `backups.key` | admin |

`builds.read` is checked by the builds routes (section 14), on the master
and on the host, and by the catalog; `devices.register` is checked by the
host, for its own pages and for the master's (section 15, "Install apps and
Devices").

## 2. Session and accounts

Sign-in on the master, and the people and groups that decide what each
person may do and which builds testers see. Sign-in routes answer only on
the master's own listener.

### Session

| Method and path | What it does | Who |
| --- | --- | --- |
| `POST /api/v2/session/parameters` | The Argon2id parameters to hash the password of a username or email with. | anyone |
| `POST /api/v2/session` | Signs in and sets the session cookie. | anyone |
| `GET /api/v2/session` | The signed-in session, from the cookie. | a session |
| `DELETE /api/v2/session` | Signs out and clears the cookie. | a session, with CSRF |

**`POST /api/v2/session/parameters`** takes `{ "identifier": "ada" }`: a
username (1–64 letters, digits, dots, dashes or underscores) or one of the
person's confirmed emails (anything with `@`, ignoring case). `username` is
still read when `identifier` is absent. It answers the parameters:

```json
{
  "algorithm": "argon2id",
  "version": 19,
  "memoryKiB": 32768,
  "iterations": 6,
  "parallelism": 4,
  "hashLength": 32,
  "salt": "4f1c9a0e7b2d4c6a8e0f1a2b3c4d5e6f"
}
```

An unknown username or email gets stable decoy parameters, so the answer
does not tell whether an account exists.

**`POST /api/v2/session`** takes `{ "identifier": "ada", "clientHash": "<64
lowercase hex>" }`, the 32-byte Argon2id hash of the password. A body with a
`password` field is refused (400). It answers
`{ "name", "role", "csrf" }` and sets the cookie; a wrong username, email
or password is 401, a locked account or address 429. Failures count against
the account whichever identifier named it.

**`GET /api/v2/session`** answers `{ "accountId", "name", "role", "csrf" }`,
or 401 `Not signed in`.

**`DELETE /api/v2/session`** ends the session and answers `null`.

### People

| Method and path | What it does | Permission |
| --- | --- | --- |
| `GET /api/v2/people` | Every person who is not removed. | `people.read` |
| `POST /api/v2/people` | Adds a person. 201. | `people.change` |
| `GET /api/v2/people/:id` | One person. | `people.read`, or the person themselves |
| `PUT /api/v2/people/:id` | Changes a person. | `people.change`; a person may change their own `name`, `emails` and `password` |
| `DELETE /api/v2/people/:id` | Removes a person. | `people.change` |
| `POST /api/v2/people/:id/invitation` | Makes the person's invitation link and answers it, once. 201. | `people.change` |
| `DELETE /api/v2/people/:id/invitation` | Revokes the person's invitation link. | `people.change` |

A person:

```json
{
  "id": 7,
  "name": "Ada Lovelace",
  "username": "ada",
  "role": "manager",
  "disabled": false,
  "password": true,
  "emails": [
    { "email": "ada@example.test", "confirmed": true },
    { "email": "ada@users.example.test", "confirmed": true }
  ],
  "groups": [2],
  "permissionVersion": 4,
  "createdAt": 1793450000000,
  "invitation": { "expiresAt": 1794054800000 }
}
```

`password` says whether the account can sign in to the master with a
password. `emails` are the person's email addresses, in order. An address
carries no sign-in method: any enabled method that verifies a confirmed
address signs its person in. `invitation` is there while the person has an
unused, unexpired invitation link.

The body of `POST` and `PUT` takes these fields, all optional for `PUT`:

| Field | Type |
| --- | --- |
| `name` | text, up to 120 characters |
| `username` | 1–64 letters, digits, dots, dashes or underscores; unique, ignoring case (a person may change only its case) |
| `role` | `admin`, `manager`, `developer` or `tester` (default `tester`) |
| `disabled` | boolean |
| `emails` | a list of up to 10 email addresses, each up to 320 characters, lower-cased and without repeats; it replaces the person's list. No address may be another person's |
| `confirmEmails` | addresses the person already has, to confirm |
| `password` | `{ "clientHash": "<64 hex>", "clientParameters": { … } }`, with parameters of at least 32 MiB, 6 iterations and 4 lanes |

An address already on the person keeps whether it is confirmed; one an
administrator adds is confirmed. The old `email` and `addresses` fields are
refused (400). An address a person adds to their own record is
unconfirmed: it signs nobody in until an administrator confirms it
(`confirmEmails`), and an administrator who gives that address to someone
else takes it over. A verified email from an open-admission sign-in takes
it over too. `POST` needs `name` or `username`, and a username or at least
one email; `"username": null` clears a username, which is refused when the
person would be left with neither, or with no confirmed email and no
username after having one. A person may not remove their own last
confirmed email while they have no username. Setting a password is audited as `person.password` besides
`person.create` or `person.update`; only `people.change` (administrators)
may set another person's, and the People page does it with a client hash
the browser makes from a password typed twice, as the sign-in page hashes
one. Mason never sees the password, so its length and character rules are
checked in the browser; the master holds the hash's costs to the minimums
above. `POST` also takes `"invite": true`, which makes the person's
invitation link at once and adds `"invitation": { "url", "expiresAt" }` to
the answer. A `PUT` that changes the role, disables or enables, sets a
password, or takes away an address of someone other than the caller bumps
the person's permission version, which ends their sessions; a change of
name, username or a person's own emails keeps them. Each address added or removed is audited as
`person.email.add` or `person.email.remove`, with the person's id and the
address. A raw `password` string is refused (400). 404 for an unknown
person; 409 when the username or an address is taken, or when the change
would disable, demote or remove the last enabled admin.

`DELETE` disables the account, removes its username, password, emails
and group memberships, and revokes every key it created. The record stays for
the audit history. It answers `null`.

#### Invitation links

Mason sends no email. An invitation link lets a person choose a password
(and a username, if they have none) without one: an administrator makes it
and copies it to them.

**`POST /api/v2/people/:id/invitation`** takes `{ "days": 7 }` (1–30,
default 7) and answers `{ "url", "expiresAt" }`. The URL is
`<origin>/auth/invite#<token>`: the host's origin when the `host` setting
has one, else the master's (`master` setting), else the address the request
reached the master at. The token, 32 random bytes, is the fragment, which
browsers never send to a server; the master keeps only its SHA-256 and
cannot show it again. A new link replaces the person's earlier one. A
disabled person cannot be invited (409), and `POST /api/v2/people` with
both `"invite": true` and `"disabled": true` is refused (400) without
adding anyone. It is audited as `person.invite`.

**`DELETE /api/v2/people/:id/invitation`** revokes the link
(`person.invite.revoke`) and answers `null`, also when there was none.
Disabling or removing the person revokes it too, and so does setting
their password, by an administrator or themselves (audited as
`person.invite.revoke`).

The link opens a page on the host or the master (`GET /auth/invite`) whose
script reads the token from the fragment and makes two requests, which
must come from that origin's own page (`Origin`) and are limited with the
other `/auth` pages:

- `POST /auth/invite/lookup` `{ "token" }` answers `{ "name", "username"?,
  "usernameRequired" }` (`false` when the person has a username or a
  confirmed email to sign in with)
  for a live link, or 404 `This invitation link is not valid or has
  expired` (400 on the host).
- `POST /auth/invite` `{ "token", "username", "clientHash",
  "clientParameters" }` sets the password from a client hash made as for
  `password` above (a raw `password` is refused) and the username, which a
  person who has one keeps (409 when it is taken) and a person with a
  confirmed email may leave empty. The link is used up, the
  permission version bumped, and the browser signed in (`{ "signedIn": true
  }` with the session cookie). It is audited as `person.invite.accept` by
  the person. On the host, the master does this over the host's link and
  the host signs the person in once its cache has the change.

### Groups

A group is a named set of app IDs and the people in it; testers see the
published builds of their groups' apps.

| Method and path | What it does | Permission |
| --- | --- | --- |
| `GET /api/v2/groups` | Every group, by name. | `groups.read` |
| `POST /api/v2/groups` | Adds a group. 201. | `groups.change` |
| `PUT /api/v2/groups/:id` | Renames a group or replaces its apps or members. | `groups.change` |
| `DELETE /api/v2/groups/:id` | Removes a group. | `groups.change` |

The body takes `name` (up to 120 characters, unique; required for `POST`),
`apps` (app row IDs, as `apps[].id` in a project shows them) and `members`
(person IDs). A group answers as:

```json
{
  "id": 2,
  "name": "QA",
  "apps": [{ "id": 3, "slug": "app.example.one" }],
  "members": [7, 9],
  "createdAt": 1793450000000
}
```

Adding or removing a member bumps that person's permission version. 404 for
an unknown group; 409 for a name in use; 400 for an unknown app or person.

## 3. API keys

| Method and path | What it does | Permission |
| --- | --- | --- |
| `GET /api/v2/keys` | The newest 1000 keys, without tokens. | `keys.read` |
| `POST /api/v2/keys` | Creates a key and answers its token once. 201. | `keys.create` |
| `DELETE /api/v2/keys/:id` | Revokes a key. | `keys.revoke` |

`POST /api/v2/keys` takes:

| Field | Type |
| --- | --- |
| `role` | required: `admin`, `manager`, `developer` or `tester`, no higher than the caller's |
| `name` | text, up to 120 characters (default `<role> key <id prefix>`) |
| `projects` | project slugs, each up to 160 characters |
| `branches` | branch patterns, each up to 200 characters |
| `expiresAt` | a time in the future |

```json
{
  "id": "3f9a1c7e5b2d4f60a8c1e3b5d7f90a2c",
  "name": "CI for phones",
  "role": "developer",
  "projects": ["phones"],
  "branches": ["release/*"],
  "createdAt": 1793450000000,
  "revoked": false,
  "format": "v1",
  "token": "mason_v1_3f9a1c7e5b2d4f60a8c1e3b5d7f90a2c.<secret>"
}
```

`GET` answers the same objects without `token`, with `expiresAt` when one is
set. `format` is `builder` for imported builder keys. 403 when the role or
scopes would be wider than the caller's; 400 for an expiry in the past.

`DELETE` answers `null`, 404 for an unknown key, and 403 for a key whose
role is higher than the caller's.

## 4. Runs

A run is one execution of one workflow of a project at one pinned commit.
These routes list, request, follow and act on runs. Every route that names a
run checks the permission against the run's project and branch, so a scoped
key reaches only the runs it covers; an unknown run is 404.

Refusals a request can meet (no branch rule allows the branch, a bad
parameter or commit, an unknown project, a full queue, an approval that is
not waiting) answer 400.

### A run

`GET /api/v2/runs`, `GET /api/v2/runs/:id` and the run actions answer runs
in this shape:

```json
{
  "id": "5f0c2b9e-8d1a-4c3e-9a57-2f6d1e0b7c44",
  "app": "phones",
  "project": "phones",
  "workflow": "build",
  "number": 412,
  "branch": "feature/login",
  "status": "running",
  "trigger": "request",
  "created": 1793450000000,
  "started": 1793450004000,
  "commit_sha": "9c1e5a7f3b2d4e6f8a0b1c2d3e4f5a6b7c8d9e0f",
  "automatic": 0,
  "cancel": 0,
  "quarantine": 0,
  "params": { "seat": "1" },
  "stages": [
    {
      "name": "build-ios",
      "kind": "stage",
      "status": "running",
      "display": "running",
      "attempt": 1,
      "worker": "mldsa65:Qm9Zc2V0cmFpbHNhbXBsZWZpbmdlcnByaW50MDAwMDA",
      "workerName": "mac-mini-2",
      "started": 1793450031000,
      "reused": false,
      "steps": [
        {
          "id": 3,
          "attempt": 1,
          "kind": "sh",
          "title": "npx react-native bundle",
          "status": "succeeded",
          "ms": 48211
        }
      ]
    }
  ],
  "artifacts": [],
  "tests": []
}
```

- `status` is `queued`, `running`, `succeeded`, `unstable`, `failed`,
  `cancelled`, `timed_out` or `interrupted`.
- `trigger` is `push`, `request`, `schedule`, `after`, `deviceRegistered` or
  `restart`.
- `actor` is who requested the run, as a label: `account:<id>`,
  `host:<account id>`, `key <first 6 characters of its id>`,
  `local operator`, or the trigger's own name (`poller`). `requestedBy` names
  them as the pages do: an account by its name, a key by its maker, its name
  and those six characters, `Paul Puey · key "TeamStation CI" (830f19)`.
- A run may also have `finished`, `requested_commit`, `exit_code`, `result`,
  `description`, `reason` (why it ended), and, for a restart, `restartOf`
  and `restartFrom`.
- Each stage has `kind` (`setup`, `stage`, `approval` or `script`), a
  `status` (the run statuses plus `preparing`, `awaiting_approval` and
  `skipped`) and `display`, the status as the dashboard writes it. It may
  have `finished`, `reason`, `output` (the value the stage returned),
  `group`, and `approval` with the stage's approval settings and, once
  decided, its `decision`.
- `artifacts` lists saved artifacts (`stage`, `name`, `kind`, `size`,
  `digest`, `visibleTo`, `entry`, `created`) and `tests` the test summaries
  stages reported.

### GET /api/v2/runs

Runs, newest first.

- Permission: `runs.read` (role only); the list is then filtered to what a
  key's scopes cover.
- Query: `project` (slug), `workflow`, `branch`, `status`, and `limit`
  (1–500, default 50). The scope filter applies after the limit.
- Answers a list of runs.

### POST /api/v2/runs

Requests a run of any workflow on a branch or commit.

- Permission: `runs.request`, for the project and branch. Host sessions may
  make it.
- Body:

  | Field | Type |
  | --- | --- |
  | `project` | a project slug, or an app ID the project owns (`app` is accepted as well) |
  | `branch` | a branch name, up to 200 characters (default: the project's default branch); a branch rule must allow it |
  | `workflow` | a workflow name (default `build`) |
  | `params` | an object of the workflow's parameters |
  | `commit` | a 40-hex commit to pin instead of the branch head |

  ```json
  {
    "project": "phones",
    "branch": "feature/login",
    "workflow": "build",
    "params": { "seat": "1" }
  }
  ```

- The master pins the branch head (or `commit`) at once. When that commit's
  graph for the workflow is already known, `params` is checked against the
  workflow's parameters before anything runs; otherwise setup checks it.
- Answers 202 with the run. 400 for an unknown or disabled project, a branch
  no rule allows, an invalid commit, a commit or branch the master cannot
  fetch, bad parameters, or a queue of 100 queued and running runs.

### GET /api/v2/runs/:id

One run. Permission: `runs.read`. Answers the run.

### POST /api/v2/runs/:id/cancel

Cancels a run that has not finished. Its post stages (`aborted`, `always`)
still run.

- Permission: `runs.request`. Host sessions may make it.
- Answers `{ "cancelled": true }`, or `{ "cancelled": false }` when the run
  has already finished.

### POST /api/v2/runs/:id/restart

Starts a new run from a finished one: it reuses every stage that does not
depend on the named stage, and runs that stage and its dependents again.

- Permission: `runs.request`. Host sessions may make it.
- Body: `{ "stage": "build-ios" }`.
- Answers 201 with the new run. 400 when the run has not finished, has no
  such stage, its graph is no longer kept, or the stashes of the stages it
  would reuse have expired.

### POST /api/v2/runs/:id/approve

Decides a waiting approval.

- Permission: `runs.approve`, and one of the approval's `roles` (default
  `admin` and `manager`; an admin may always decide). Host sessions may make
  it.
- Body: `{ "stage": "<approval name>", "approve": true, "params": { … } }`.
  `approve` defaults to `true`; `false` rejects the approval and cancels the
  run. `params` is checked against the approval's parameters.
- Answers the run. 400 when no approval is waiting there; 403 when the
  caller's role may not decide it.

### GET /api/v2/runs/:id/logs

A run's log as a download.

- Permission: `runs.read`. Host sessions may read it.
- Query: `stage` for one stage's log, `step` (a step `id`, with `stage`) for
  one step's lines, and `plain=1` to strip terminal escape sequences.
  Without `stage` it is the whole run's log.
- Answers `text/plain` with
  `Content-Disposition: attachment; filename="run-<id>[-<stage>][.ansi].log"`
  (`.ansi` unless `plain=1`). A stage with no log yet answers an empty body.
  404 for an unknown run or step.

### Live updates

`GET /live` upgrades to a WebSocket that sends a run's status, stages, steps
and log, and the queue, as the master records them. The master and every
host serve it on their web port; a host relays it over its link to the
master, which checks every subscription.

- Authentication: a session cookie from a page of the same node (the
  `Origin` must be that node's own), or `Authorization: Bearer <key>` from a
  script, which may send no `Origin` but never a foreign one. Anything else
  is refused before the upgrade: 401 without a credential, 403 for a
  foreign origin or a key whose owner is disabled, 429 past 16 sockets for
  one viewer, 503 on a host while the master is unreachable.
- Messages are JSON, one per frame. A page sends:

  | Message | Meaning |
  | --- | --- |
  | `{ "subscribe": "run", "run": id, "stage"?: name, "after"?: offset, "tail"?: true, "log"?: false, "follow"?: true, "key"?: key }` | the run's `run`, `stages` and `steps` events, and the stage's log from byte `after`, or from its last megabyte with `tail`, or not at all with `log: false`. Without `stage` it follows the running stage, sending the last megabyte of its log from a line's start and switching when the next stage starts; `follow` keeps following after naming a stage. |
  | `{ "subscribe": "status", "run": id }` | the run's `run` events only |
  | `{ "subscribe": "queue" }` | `queue` events: the queue panel's running and queued stages, of the runs a key's scopes cover |
  | `{ "unsubscribe": key }` | stop one subscription |

  `key` names the subscription in the frames that answer it; it defaults to
  `run:<id>`, `status:<id>` or `queue`. Each subscription is checked as the
  matching HTTP read (`runs.read` on the run's project and branch). A page
  holds 200 subscriptions at most and may send 50 messages at once and 20 a
  second after that.
- The node sends `{ "key", "event", "data" }`:

  | Event | Data |
  | --- | --- |
  | `run` | `{ "id", "number", "workflow", "branch", "status", "created", "started"?, "finished"?, "description"?, "reason"? }` |
  | `stages` | `[{ "name", "kind", "status", "attempt", "node"?, "started"?, "finished"?, "reason"?, "disconnected"? }]`, without `@setup` |
  | `steps` | `{ "stage", "steps": [{ "id", "kind", "title", "status", "ms", "parent" }] }` |
  | `log` | `{ "stage", "offset", "first", "text", "partial"? }`: `offset` is the byte the text ends at and `first` the number of its first line. A line longer than 256 KB comes in pieces marked `partial`, the last unmarked. A running stage's unfinished last line waits for its end. |
  | `queue` | `[{ "job", "project", "workflow", "number", "branch", "stage", "status", "elapsed"?, "progress"? }]` |
  | `end` | the run has finished and its log has been sent |
  | `gone` | the run does not exist |
  | `error` | `{ "error" }`, for a bad message or a refused subscription |

  An event is sent only when its data changed. To resume after a dropped
  socket, subscribe again with `after` set to the last `offset` received:
  every later line comes once, with none lost.
- The node pings every 25 seconds and closes a client that misses two. Close
  codes: 1008 when the session or key may no longer watch (final); 1012 when
  the node restarts or a host loses its link to the master (reconnect and
  resume); 4000 when a host's master is too old to serve live updates
  (final). A host older than its master has no `/live`: its upgrade fails,
  and its pages show no live updates until it is upgraded.
- Log text goes a megabyte per turn and waits while a page has a megabyte
  unread, so a page that stops reading for long (16 MB) is dropped.

## 5. Projects

A project is one repository: its app IDs, branch rules, secrets and
settings. Errors: 404 for an unknown project, 409 for a conflict.

### A project

`GET /api/v2/projects/:slug` and the routes that change a project answer:

```json
{
  "id": 1,
  "slug": "phones",
  "name": "Phones",
  "repository": "https://github.com/example/phones.git",
  "format": "pipeline",
  "timeoutSeconds": 14400,
  "enabled": true,
  "position": 0,
  "defaultBranch": "master",
  "script": {},
  "repositories": [],
  "tagPushes": false,
  "signingLabel": "apple-signing",
  "webhookSecret": { "set": true },
  "apps": [
    {
      "id": 3,
      "bundleId": "app.example.one",
      "name": "Example One",
      "platforms": ["android", "ios"],
      "apple": { "team": "ABCDE12345", "bundleIds": ["app.example.one"] }
    }
  ],
  "rules": [
    { "pattern": "master", "mode": "automatic" },
    { "pattern": "*", "mode": "request" }
  ],
  "secrets": [
    {
      "id": 12,
      "name": "SENTRY_TOKEN",
      "kind": "value",
      "configs": [],
      "text": true,
      "masked": true,
      "bytes": 40,
      "updatedAt": 1793450000000
    }
  ]
}
```

`entrypoint` appears when set. `secrets` never holds contents.

### Project routes

| Method and path | What it does | Permission |
| --- | --- | --- |
| `GET /api/v2/projects` | Every project, in position order, filtered to a key's scopes. | `projects.read` |
| `GET /api/v2/projects/:slug` | One project. | `projects.read` |
| `PUT /api/v2/projects/:slug` | Creates a project (201) or changes the fields given (200). | `projects.change` |
| `DELETE /api/v2/projects/:slug` | Deletes a project and its runs. | `projects.change` |
| `POST /api/v2/projects/:slug/apps` | Gives the project an app ID. 201. | `projects.change` |
| `DELETE /api/v2/projects/:slug/apps/:bundleId` | Releases an app ID from the project. | `projects.change` |
| `PUT /api/v2/projects/:slug/rules` | Replaces the branch rules. | `projects.change` |

**`PUT /api/v2/projects/:slug`.** The slug is letters, digits, dots, dashes
and underscores, up to 160 characters. Every field is optional, but a new
project needs `repository`:

| Field | Type |
| --- | --- |
| `name` | text, up to 120 characters (default: the slug) |
| `repository` | a GitHub repository, `https://github.com/<owner>/<repo>` or `git@github.com:<owner>/<repo>`, stored lower case with `.git` |
| `format` | `pipeline` (default) or `script` |
| `entrypoint` | a relative path to the Masonfile; `null` clears it (then `Masonfile.ts`) |
| `timeoutSeconds` | 1–86400 (default 14400) |
| `enabled` | boolean (default `true`) |
| `position` | integer (default 0) |
| `defaultBranch` | a branch name (default `master`) |
| `webhookSecret` | 16–256 characters, `{ "keep": true }` to keep the stored one, or `null` to clear it |
| `script` | for script projects: `{ "workspace", "platforms", "on" }` |
| `repositories` | up to 20 more GitHub repositories its stages may fetch |
| `tagPushes` | boolean: whether `ctx.git.tag` may push tags |
| `signingLabel` | a node label signing stages require, or `null` |

```json
{
  "name": "Phones",
  "repository": "https://github.com/example/phones",
  "defaultBranch": "master"
}
```

**`DELETE /api/v2/projects/:slug`** answers `null`; 409 while the project
has queued or running runs.

**`POST /api/v2/projects/:slug/apps`** creates the app ID if it is new and
an enabled channel for each platform, and disables the app's other
platforms. It answers the app.

| Field | Type |
| --- | --- |
| `bundleId` | required, up to 160 characters |
| `name` | required, up to 120 characters |
| `platforms` | required: one or more of `ios`, `android`, `macos`, `windows`, `tvos`, each once |
| `apple` | `{ "team": "<10 capitals and digits>", "bundleIds": [...] }`: the Apple team and every bundle ID it signs, the app ID or its extensions (default: the app ID alone) |

409 when the app ID belongs to another project.

**`DELETE /api/v2/projects/:slug/apps/:bundleId`** answers `null`. The app
and its builds stay. 404 when the project does not own it.

**`PUT /api/v2/projects/:slug/rules`** takes a list of up to 100
`{ "pattern", "mode" }`: `pattern` is a branch glob up to 200 characters
with no spaces or `~^:?[\`, and `mode` is `automatic` or `request`. The
first match decides. `*` matches within one path segment and `**` across,
so a rule for every branch, leaving the Masonfile's push triggers to narrow
it, is `**` → automatic; `*` misses branches like `paul/x`. It answers the
project.

### Add-project wizard and Masonfile

The dashboard's add-project wizard uses these routes. Each checks its
permission and that a key's scopes cover the project it names; `check` names
no project yet, so a key scoped to projects cannot use it.

| Method and path | What it does | Permission |
| --- | --- | --- |
| `POST /api/v2/projects/check` | Checks the master can read a repository. | `projects.change` |
| `POST /api/v2/projects/:slug/discover` | Starts a discovery run on the default branch. 202. | `projects.change` |
| `GET /api/v2/projects/:slug/discover` | The latest discovery run and what it found. | `projects.change` |
| `POST /api/v2/projects/:slug/wizard/apps` | Adds app IDs the Masonfile declares. | `projects.change` |
| `POST /api/v2/projects/:slug/wizard/rules` | Sets the branch rules from lines of text. | `projects.change` |
| `POST /api/v2/projects/:slug/webhook` | Creates the GitHub push webhook. | `projects.change` |
| `GET /api/v2/projects/:slug/masonfile` | The project's Masonfile at a commit. | `projects.read` |

- **`check`** takes `{ "repository": "https://github.com/example/phones" }`
  and answers `{ "repository", "slug", "defaultBranch" }`, the slug derived
  from the repository's name. 400 when it is not a GitHub repository or the
  master cannot reach it.
- **`POST …/discover`** answers `{ "run": "<run id>" }`. The run is on the
  project's default branch, so a key scoped to branches must cover it
  (403). **`GET …/discover`** answers `null` before any discovery, else
  `{ "run", "status", "reason" }` and, once the Masonfile is read, `apps` (each
  `{ "bundleId", "platforms", "bundleIds" }`) and `triggers` by workflow.
- **`wizard/apps`** takes `{ "apps": "app.example.one,app.example.two",
  "team": "ABCDE12345" }`: a comma-separated list of app IDs the discovery
  found, and an optional Apple team for those built for iOS, macOS or tvOS. It
  answers the project. 400 for an app ID the Masonfile does not declare.
- **`wizard/rules`** takes `{ "rules": "master automatic\n*" }`: one rule
  per line, a pattern and an optional mode (default `request`). It answers
  the project.
- **`webhook`** makes a webhook secret if the project has none, and asks
  GitHub for a push webhook to
  `<host origin>/api/webhooks/github/<slug>`. It answers
  `{ "created": true, "url": "…" }`; `created` is `false` when the GitHub
  connection is an SSH key, which cannot make webhooks. 400 when the `host`
  setting has no origin or GitHub refuses.
- **`masonfile`** takes `?commit=<40 or 64 hex>` and answers
  `{ "commit", "file", "text" }`. 404 when the file is not in that commit.

## 6. Secrets

A project's secrets are named variants, each a value or a file, each limited
to build configs (empty `configs` is the default variant for all configs).
Contents are never in lists; every fetch of contents is audited as viewed,
and every change is pushed in an encrypted backup before it is saved, so
changing secrets needs backups configured.

Every route checks its permission against the project, and records a refusal
in the project's secret audit when the project exists.

| Method and path | What it does | Permission |
| --- | --- | --- |
| `GET /api/v2/projects/:slug/secrets` | The variants, without contents. | `projects.read` |
| `GET /api/v2/projects/:slug/secrets/audit` | The latest audit entries. | `secrets.read` |
| `GET /api/v2/projects/:slug/secrets/:id` | One variant's contents. | `secrets.read` |
| `POST /api/v2/projects/:slug/secrets` | Adds a variant. 201. | `secrets.change` |
| `PUT /api/v2/projects/:slug/secrets/:id` | A new value, or new text for a text file. | `secrets.change` |
| `PUT /api/v2/projects/:slug/secrets/:id/file` | New bytes for a file. | `secrets.change` |
| `PUT /api/v2/projects/:slug/secrets/:id/configs` | New build configs. | `secrets.change` |
| `DELETE /api/v2/projects/:slug/secrets/:id` | Deletes a variant. | `secrets.change` |

The body limit is 8 MB, enough for the largest file (5 MiB) in base64.
Through the host the limit is 512 KB, a file of about 380 KiB.

Errors (the secrets routes' own mapping): 404 for an unknown project or
variant; 409 `Configure backups before changing secrets`; 502 when the
backup carrying the change could not be pushed (nothing is saved); 500 when
the change failed on the backup's copy, or was pushed but the live database
could not take it; 400 for a body that fails its checks.

### A variant

```json
{
  "id": 14,
  "name": "release.keystore",
  "kind": "file",
  "configs": ["release"],
  "text": false,
  "masked": true,
  "bytes": 2702,
  "updatedAt": 1793450000000
}
```

`text` is true for values and for files that are UTF-8 with no NUL.
`masked` is false only for script-project values added unmasked. Script
projects may also show `pathEnv` and `destination`.

### POST /api/v2/projects/:slug/secrets

| Field | Type |
| --- | --- |
| `kind` | required: `value` or `file` |
| `name` | required. A value's name is an environment variable name (`[A-Z_][A-Z0-9_]*`, up to 100 characters, not `MASON_…`, `NODE_OPTIONS`, `NODE_PATH`, `LD_PRELOAD`, `DYLD_INSERT_LIBRARIES`, nor a name the build environment sets, such as `PATH`, `HOME`, `CI` or `GIT_…`). A file's name is a file name in pipeline projects and a relative path in script projects. |
| `configs` | build configs, as a list or a comma-separated string: letters, digits, dashes and underscores, at most 20; empty for all configs |
| `value` | for a value: text up to 64 KiB, no NUL |
| `contents` | for a file: base64, without line breaks, up to 5 MiB decoded |
| `masked` | script projects, values only: boolean (default `true`) |
| `pathEnv` | script projects, files only: the variable that holds the file's path |

A name keeps one kind, one default variant, and each config in at most one
of its variants. Script projects take no configs. It answers 201 with the
variant.

```json
{
  "kind": "value",
  "name": "SENTRY_TOKEN",
  "configs": ["release", "beta"],
  "value": "sntrys_example_0000"
}
```

### The other secret routes

- **`GET …/secrets/:id`** answers `{ "value": "…" }` for a value,
  `{ "text": "…" }` for a text file, and `{ "contents": "<base64>" }` for a
  binary file. The fetch is audited as viewed.
- **`GET …/secrets/audit`** takes `?limit=` (1–1000, default 200) and
  answers entries newest first: `{ "id", "name", "configs", "action",
  "who", "address", "at", "detail" }`. `action` is `viewed`, `added`,
  `edited`, `replaced`, `deleted`, `configs changed` or `refused`. `address`
  ends in `via host` for forwarded requests.
- **`PUT …/secrets/:id`** takes `{ "value": "…" }` for a value or
  `{ "text": "…" }` for a text file; a binary file can only be replaced.
- **`PUT …/secrets/:id/file`** takes `{ "contents": "<base64>" }`, files
  only.
- **`PUT …/secrets/:id/configs`** takes `{ "configs": ["release"] }`.
- **`DELETE …/secrets/:id`** answers `null`.

The `PUT` routes answer the variant.

## 7. Build numbers

| Method and path | What it does | Permission |
| --- | --- | --- |
| `POST /api/v2/build-numbers/seed` | Sets where a project's build-number sequence stands. | `buildNumbers.seed`, for the project |

For a project moving to Mason with numbers already issued elsewhere: the
next number reserved for the key comes after `last`. Nothing is lowered.

```json
{ "project": "phones", "key": "app.example.one", "branch": "master", "last": "2026103104" }
```

- `key` is the sequence's key; the project's setup must have declared its
  scheme first.
- `branch` is required for a scheme numbered per branch, and ignored
  otherwise.
- `last` must have the scheme's format.

It answers `{ "key", "branch", "last" }`. 404 for an unknown project; 400
for a key with no scheme, a missing branch, or a `last` in another format.

## 8. Nodes

Workers and the host paired with the master.

| Method and path | What it does | Permission |
| --- | --- | --- |
| `GET /api/v2/nodes` | Every paired node with its inventory and software state. | `nodes.read` |
| `POST /api/v2/nodes` | Pairs a node by its address and pairing key. 201. | `nodes.change`; a host also `hosts.change` |
| `PUT /api/v2/nodes/:fingerprint` | Sets a node's name, type, labels and slots. | `nodes.change` |
| `DELETE /api/v2/nodes/:fingerprint` | Unpairs a node. | `nodes.change`; a host also `hosts.change` |

A node:

```json
{
  "id": 4,
  "fingerprint": "mldsa65:Qm9Zc2V0cmFpbHNhbXBsZWZpbmdlcnByaW50MDAwMDA",
  "role": "worker",
  "host": "192.168.1.20",
  "port": 9310,
  "name": "mac-mini-2",
  "type": "mac-xcode",
  "labels": ["setup", "apple-signing"],
  "slots": 2,
  "workspaceRoots": [],
  "version": "0.4.0",
  "addedAt": 1793450000000,
  "lastSeen": 1793453600000,
  "connected": true,
  "checklist": [],
  "inventory": {
    "version": "0.4.0",
    "os": "macos",
    "osVersion": "15.6",
    "arch": "arm64",
    "freeDisk": 412000000000,
    "xcodes": [],
    "tools": {}
  }
}
```

`checklist` lists manual steps that block the node; `reconcile` (the
progress of its software) and `update` appear when there is something to
report.

**`POST /api/v2/nodes`** takes `{ "address": "192.168.1.20:9310", "key":
"mason1:mldsa65:…" }`: the node's address and the pairing key it printed on
first start. It may also take the fields `PUT` sets (below), so a dedicated
node is paired with its labels and never carries `setup`; they are checked
before the node is paired. A host takes only a name: given any other field,
a host is refused before it pairs and can be paired again. It answers the
node. 400 for a key that is not a pairing key, a field that fails, or a host
given a worker's fields; 409 when the node is already paired; 502
when the node does not answer, or its certificate or handshake does not match
the key.

**`PUT /api/v2/nodes/:fingerprint`** takes any of:

| Field | Value |
| --- | --- |
| `name` | 1–128 characters, not all spaces, without control characters |
| `type` | up to 64 letters, digits, dots, dashes and underscores, or `""` for none |
| `labels` | a list of up to 20 labels like a type, repeats dropped; it replaces the node's labels, so a node that runs setup keeps `setup` in it |
| `slots` | 1–64 stages at a time |
| `workspaceRoots` | absolute paths for custom workspace paths |

A field left out is kept. Every field is checked before any is written, and
any other field, `address` and `key` included, is refused (400). A host
takes only a name; a type, labels, slots or workspace roots for a host are
refused (400). It answers the node and sends the node its
new type and labels. 404 for an unknown node. The Nodes page edits the same
fields, and `mason nodes set` on the master's computer does too.

**`DELETE /api/v2/nodes/:fingerprint`** answers `null`; 404 for an unknown
node.

## 9. Cloud accounts, pools, hosts and nodes

The master makes machines on cloud providers: pools of workers made on
demand, one host, and permanent cloud nodes. The provider keys are cloud
accounts, write-only once stored. Errors: 404 for an unknown account, pool,
host or node; 409 for a pool name in use; 400 otherwise.

### Cloud accounts

| Method and path | What it does | Permission |
| --- | --- | --- |
| `GET /api/v2/cloud/accounts` | The accounts and their last check. | `settings.read` |
| `POST /api/v2/cloud/accounts` | Adds an account. 201. | `settings.change` |
| `PUT /api/v2/cloud/accounts/:id/key` | Replaces the account's key: `{ "key" }`. | `settings.change`; the host's account also `hosts.change` |
| `POST /api/v2/cloud/accounts/:id/check` | Asks the provider about the key again. | `settings.read` |
| `DELETE /api/v2/cloud/accounts/:id` | Removes an account. | `settings.change`; the host's account also `hosts.change` |
| `GET /api/v2/cloud/accounts/:id/catalog` | The regions, sizes and images a pool may use. | `settings.read` |

`POST` takes:

| Field | Type |
| --- | --- |
| `name` | required, up to 80 characters |
| `provider` | required: `digitalocean` or `nomac` |
| `key` | required: a DigitalOcean API token (`dop_v1_…`), or a NoMac API key (`nmk_…`) |
| `id` | a slug of lowercase letters, digits and dashes, up to 40 (default: made from the name) |

An account answers as:

```json
{
  "id": "do-main",
  "name": "DigitalOcean main",
  "provider": "digitalocean",
  "key": { "set": true },
  "adminKeyed": true,
  "check": {
    "state": "ok",
    "checkedAt": 1793450000000,
    "digitalocean": { "email": "ops@example.test", "dropletLimit": 25, "status": "active" }
  }
}
```

`check.state` is `ok`, `refused`, `timeout`, `unavailable` or `error`, with a
`message` when not `ok`; a NoMac check has `nomac` with `credit`,
`spendableSeconds`, `concurrency` and `spendingBlocked`. `DELETE` answers
`null`; 400 while a pool or a host uses the account.

`adminKeyed` says whether an administrator entered the account's key. A
host is made only in such an account, since whoever holds the account
holds the host's droplet: a key a manager adds or replaces is not one
(the same key entered again keeps what it was), and
an administrator must enter it again (**Replace key** on the Cloud page,
`PUT …/:id/key`, or `POST` a new account) before a host is made in it. The
account is checked again, with its key unchanged, just before the host is
recorded, and a host whose account no longer holds such a key is not
reconciled: it goes to `error` until an administrator replaces the key. Changing
the key of, or removing, the account a host was made in needs
`hosts.change`. An account a host was made in before this rule counts as
keyed by an administrator. The catalog answers
`{ "regions": [{ "slug", "name" }], "sizes": [{ "slug", "description",
"priceMonthly", "regions" }], "images": [{ "slug", "name" }] }`; 400 for a
provider with no catalog (NoMac).

### Pools

Pools live in the `cloud` settings area beside the monthly budget.

| Method and path | What it does | Permission |
| --- | --- | --- |
| `GET /api/v2/cloud/pools` | The pools, each with its machines (`id`, `state`, `address`, `created`). | `settings.read` |
| `POST /api/v2/cloud/pools` | Adds a pool. 201. | `settings.change` |
| `PUT /api/v2/cloud/pools/:name` | Replaces a pool; it keeps its name. | `settings.change` |
| `DELETE /api/v2/cloud/pools/:name` | Removes a pool; its machines retire. | `settings.change` |

| Field | Type |
| --- | --- |
| `name` | required: a slug of lowercase letters, digits and dashes, up to 40 |
| `type` | required: the node type its machines serve, a slug |
| `account` | required: a cloud account ID |
| `region`, `size`, `image` | required for DigitalOcean; NoMac uses `nomac`, `standard` and `macos` |
| `labels` | labels its machines carry, slugs (default `["setup"]`) |
| `maxNodes` | 1–50 (default 1; NoMac 1) |
| `slots` | 1–64 (default 1) |
| `ttlMinutes` | idle minutes before a machine goes, 1–1440 (default 60) |
| `maxHoursPerNode` | 1–720 (default 24); NoMac 1–8 (default 8) |

Numbers may be sent as strings and `labels` as a comma-separated string, as
the dashboard's form sends them. `POST` and `PUT` answer the pool; `DELETE`
answers `null`.

### Cloud hosts

A master makes at most one host on DigitalOcean. Making, reconciling and
removing it, and pairing or unpairing any host on the Nodes routes, need
`hosts.change` (administrators): the host decides where invitation links
open and receives the client hashes of host password sign-ins, which sign
in to the master too. A manager may still give it a Space.

| Method and path | What it does | Permission |
| --- | --- | --- |
| `GET /api/v2/cloud/hosts` | The cloud host, if any. | `settings.read` |
| `POST /api/v2/cloud/hosts` | Records a host and starts making it. 201. | `hosts.change` |
| `POST /api/v2/cloud/hosts/:name/reconcile` | Checks the host again and continues making it. | `hosts.change` |
| `POST /api/v2/cloud/hosts/:name/space` | Gives the host a new Space for its builds. | `settings.change` |
| `DELETE /api/v2/cloud/hosts/:name` | Destroys the host. | `hosts.change` |

`POST /api/v2/cloud/hosts` takes:

| Field | Type |
| --- | --- |
| `name` | required: a slug, up to 40 |
| `account` | required: a DigitalOcean cloud account |
| `region` | required, 2–20 lowercase letters, digits and dashes |
| `size` | required, 2–40 of the same |
| `image` | default `ubuntu-24-04-x64` |
| `dns` | `{ "domain": "example.test", "name": "builds" }`: a record in a domain the account's DNS holds (`@` for the domain itself); the host then gets a Let's Encrypt certificate |
| `space` | `{ "bucket": "mason-builds", "region": "sfo3" }`: a new Space for its builds |

It is refused (400) when the master already has a host, the name is taken,
the account is not DigitalOcean, the domain is not in the account, or the
master has no GitHub release for the host to install.
It is refused (409) in an account whose key no administrator entered
(see [Cloud accounts](#cloud-accounts)).

The routes answer the host's record: its `name`, `account`, `region`,
`size`, `image`, `state` (`creating`, `installing`, `pairing`, `ready`,
`updating`, `error`, `removing`), `error`, `address`, `fingerprint`,
`version`, `origin`, DNS and Space fields, `labels`, `pairing` (whether it
still waits to pair) and `certificate` (`internal`, `waiting` or `trusted`).
Pairing and Space secrets are never shown.

The host's DigitalOcean firewall, which Mason writes when it makes the
host, again after the master restarts and whenever the master's address
changes, opens ports 80 and 443 to everyone and SSH (22) and
the link port to the master's public address only, so SSH from the
master's network keeps working (SSH keys are still the operator's to
install). A cloud node's firewall opens only the link port to the master.

- **`…/space`** takes `{ "bucket", "region" }`, a bucket of 3–63 lowercase
  letters, digits and dashes and a Spaces region such as `sfo3`. The host's
  storage switches to the Space once it exists. An administrator's request
  makes the Space at once; a manager's is stored, and the next check of the
  host (the master's, every ten minutes, or an administrator's reconcile)
  makes it, so a manager never sets a reconcile going.
- **`DELETE`** takes `{ "confirm": "<the host's name>", "deleteSpace": true }`
  and answers `null`. It destroys the droplet, firewall and the DNS record
  Mason made, and unpairs the host. The Space and its builds stay unless
  `deleteSpace` is `true` (or `"delete"`).

### Cloud nodes

Permanent workers the master keeps on DigitalOcean, as many as needed.

| Method and path | What it does | Permission |
| --- | --- | --- |
| `GET /api/v2/cloud/nodes` | The cloud nodes. | `settings.read` |
| `POST /api/v2/cloud/nodes` | Records a node and starts making it. 201. | `settings.change` |
| `POST /api/v2/cloud/nodes/:name/reconcile` | Checks the node again. | `settings.change` |
| `DELETE /api/v2/cloud/nodes/:name` | Destroys the node. | `settings.change` |

`POST` takes `name`, `account`, `region`, `size` and `image` as for a host,
plus `type` (the node type, a slug) and `labels` (up to 20 lowercase
labels, as a list or comma-separated; default `["setup"]`). The node gets
its type and labels once it pairs. `DELETE` takes `{ "confirm": "<name>" }`.
Answers are records in the cloud hosts' shape.

## 10. Storage

Where the host keeps builds and saved artifacts: its disk, or DigitalOcean
Spaces. Every Space Mason has used is a storage location that keeps serving
the builds in it; one location takes new builds. All routes check
`settings.change`, except `GET`, which checks `settings.read`.

| Method and path | What it does |
| --- | --- |
| `GET /api/v2/storage` | The `storage` setting and every location, with the files and bytes the host holds in each when the host answers within 5 s. |
| `POST /api/v2/storage/space` | Adds a Space by URL and key, after checking the key can write, read and delete in it. |
| `POST /api/v2/storage/space/new` | Makes a new Space and a key limited to it in a DigitalOcean cloud account. |
| `POST /api/v2/storage/disk` | New builds go to the host's disk. |
| `POST /api/v2/storage/locations/:id/use` | New builds go to this location (`disk` for the disk). |
| `DELETE /api/v2/storage/locations/:id` | Removes a Space and its builds from Mason. |

- **`space`** takes
  `{ "url": "https://mason-builds.sfo3.digitaloceanspaces.com",
  "accessKeyId": "…", "secretAccessKey": "…", "use": true }`. The URL may
  also be the region endpoint with the bucket as its path or in `bucket`.
  `secretAccessKey` may be `{ "keep": true }` to reuse the stored one.
- **`space/new`** takes `{ "account": "do-main", "bucket": "mason-builds",
  "region": "sfo3", "use": true }`. The region is one with Spaces: `sfo3`,
  `nyc3`, `ams3`, `fra1`, `lon1`, `sgp1`, `syd1`, `blr1`, `tor1`, `atl1`.
- With `"use": false` both only remember the location; otherwise new builds
  go there. Both answer the `storage` setting, and save nothing (400
  `Nothing was saved: …`) when a check or a step fails.
- A location answers as `{ "id", "kind", "active", "bucket", "region",
  "endpoint", "origin", "bucketOwned", "account", "host", "addedAt",
  "addedBy", "usage" }`; `kind` is `disk` or `space`.
- **`DELETE`** takes `{ "confirm": "<bucket>" }` and answers
  `{ "files", "bucketDeleted" }`. It deletes the bucket and key only when
  Mason made them. Refused (400) for the disk, for the location that takes
  new builds, and while the host does not answer.

## 11. Backups

The master pushes encrypted snapshots of its database to a git repository.

| Method and path | What it does | Permission |
| --- | --- | --- |
| `GET /api/v2/settings/backup` | The `backup` setting and the backup status; the backup key for administrators. | `settings.read` |
| `PUT /api/v2/settings/backup` | Configures backups. | `settings.change` |
| `POST /api/v2/settings/backup/confirm` | Records that an administrator stored the backup key. | `backups.key` |
| `GET /api/v2/backups` | The backup status. | `backups.run` |
| `POST /api/v2/backups` | Takes a backup now. | `backups.run` |

`PUT` takes:

| Field | Type |
| --- | --- |
| `repository` | a git URL such as `git@github.com:example/mason-backup.git` (SSH or HTTPS), up to 500 characters |
| `branch` | a branch name (default `master`) |
| `auth` | `deployKey` (default: the master's own SSH key, made once) or `github` (its GitHub connection) |

The setting answers with the deploy key's public half as `deployKey`, to add
to the repository, together with the status:

```json
{
  "repository": "git@github.com:example/mason-backup.git",
  "branch": "master",
  "auth": "deployKey",
  "deployKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleKeyOnly",
  "configured": true,
  "backedUp": true,
  "lastSuccess": { "at": 1793450000000, "commit": "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b", "kind": "commit", "auth": "deployKey" }
}
```

Once backups are configured, an administrator also gets `backupKey` (the key
that opens the snapshots) and `keyConfirmed`. `confirm` answers
`{ "keyConfirmed": true }`; 400 when backups are not configured or the caller
has no account (a key with no creator). `GET /api/v2/backups` and
`POST /api/v2/backups` answer the status (`configured`, `backedUp`,
`lastSuccess`, `lastFailure`); `POST` waits for the push, and is 400 when
backups are not configured.

## 12. Settings

Settings areas share two routes; each area checks its own values. Secret
fields are write-only: reads show them as `{ "set": true }`, and a write may
send `{ "keep": true }` to keep the stored value.

| Method and path | What it does | Permission |
| --- | --- | --- |
| `GET /api/v2/settings/:area` | An area's value. | `settings.read` |
| `PUT /api/v2/settings/:area` | Replaces an area's value; answers it as `GET` does. | `settings.change` |
| `PUT /api/v2/settings/signIn/methods/:id` | Adds or changes one sign-in method. | `signIn.change` |
| `DELETE /api/v2/settings/signIn/methods/:id` | Removes one sign-in method. | `signIn.change` |
| `PUT /api/v2/settings/nodeTypes/:type` | Adds or changes one node type. | `settings.change` |
| `DELETE /api/v2/settings/nodeTypes/:type` | Removes one node type. | `settings.change` |
| `PUT /api/v2/settings/cloud/budget` | Sets the cloud pools' monthly budget. | `settings.change` |

An unknown area is 404. Changing `signIn`, `master` or `host` (all of
it: `origin`, `workerOrigin` and `offlineGraceHours`) also needs
`signIn.change` (administrators): a sign-in method decides who signs in
as whom, and invitation links open at the host's or master's origin, so a
manager may not change them; the Settings page shows managers their
values without editors. A cloud host the master makes still sets `host`
itself. In `cloudAccounts`, changing the key of, or removing, the account
a cloud host was made in needs `hosts.change`. The areas:

| Area | Value |
| --- | --- |
| `host` | `{ "origin": "https://builds.example.test", "workerOrigin"?, "offlineGraceHours": 72 }`: the host's public HTTPS origin, an origin cloud machines reach it at, and hours (1–720) it serves without the master. |
| `master` | `{ "origin": "https://mason-admin.example.test:9300" }`: the master's own public HTTPS origin, where sign-in providers return the browser to the master's pages. `{}` (or an empty `origin`) offers only username and password on the master. It stays on the master. |
| `github` | `{ "kind": "token", "token" }`, `{ "kind": "app", "appId", "installationId", "privateKey" }`, or `{ "kind": "ssh" }` (the master makes a key; send `"privateKey": { "keep": true }` to keep it). A token or App is checked with GitHub on save. |
| `signIn` | `{ "methods": [ … ] }`: OIDC or OAuth 2 providers the host offers, and the master too once `master` is set (below). |
| `storage` | `{ "driver": "disk" }`, or `{ "driver": "s3", "s3": { "endpoint", "bucket", "region", "accessKeyId", "secretAccessKey" } }`. The [Storage](#10-storage) routes are the usual way to change it. |
| `backup` | Served by the [Backups](#11-backups) routes. |
| `nodeTypes` | `{ "<type>": { "software", "settings", "diskThresholdGb", "androidLicensesAccepted" } }` (below). |
| `cloud` | `{ "monthlyBudget": 200, "pools": [ … ] }`. The [Pools](#pools) routes change one pool at a time. |
| `cloudAccounts` | `{ "accounts": [{ "id", "name", "provider", "key" }] }`. The [Cloud accounts](#cloud-accounts) routes change one at a time. |
| `apple` | `{ "appleId", "teams": { "<team ID>": { "name", "issuerId", "keyId", "privateKey" } } }`: the Apple ID for Xcode downloads, and an App Store Connect key per team (`issuerId` a UUID, `keyId` ten characters, `privateKey` the `.p8` contents). A field left out keeps what is stored; `null` clears `appleId`. |
| `buildNumbers` | `{ "countBase": 0 }`, 0–9999. |

### Sign-in methods

**`PUT /api/v2/settings/signIn/methods/:id`** takes one method; its `id`
comes from the path (a lowercase provider ID such as `google`). Fields the
dashboard does not show stay as stored when the type is unchanged. With
`"create": true` it refuses (400) to replace a method of that ID. Unknown
fields are refused.

| Field | Type |
| --- | --- |
| `type` | `oidc` or `oauth2` |
| `name` | up to 80 characters |
| `issuer` | an HTTPS URL |
| `clientId` | up to 256 characters |
| `clientSecret` | up to 4096 characters, or `{ "keep": true }` |
| `enabled` | boolean (default `true`); a disabled method is kept but not offered |
| `authentication` | `post` (default) or `basic` |
| `switchParameters` | up to 8 extra authorization parameters for switching accounts |
| `signingAlgorithm` | `oidc` only: `RS256` (default), `ES256` or `EdDSA` |
| `authorizationEndpoint`, `tokenEndpoint`, `userinfoEndpoint` | `oauth2` only: HTTPS URLs |
| `scopes` | `oauth2` only: a list |
| `claims` | `oauth2` only: `{ "subject", "name", "email", "emailVerified" }` claim names |

`DELETE` removes the method; 404 when there is none. Both answer the
`signIn` area, client secrets shown as `{ "set": true }`.

Each method is registered with its provider once per place it is offered,
with these redirect (callback) URLs, which the Settings page's Sign-in card
lists for each method:

- the host: `<host origin>/auth/callback/<id>`, for example
  `https://builds.example.test/auth/callback/google`;
- the master, when the `master` setting is set:
  `<master origin>/auth/callback/<id>`, for example
  `https://mason-admin.example.test:9300/auth/callback/google`.

Only the browser visits the provider and these URLs; the master makes the
outbound token and user-info requests. So a master reachable only on an
internal network can still offer a provider: give it a name in a public
domain (Google refuses bare host names and IP addresses in redirect URIs)
that resolves, for the people who use it, to its private address, and make
sure their browsers trust its certificate (for example a certificate for
that name, or the master's own one installed as trusted). The master must
reach the provider's HTTPS endpoints.

### Node types

**`PUT /api/v2/settings/nodeTypes/:type`** takes one type's definition; the
type name is 1–40 lowercase letters, digits and dashes. With
`"create": true` it refuses (400) to replace an existing type. It keeps a
stored Android licence acceptance and does not record a new one: that takes
`PUT /api/v2/settings/nodeTypes` with every type, and
`"androidLicensesAccepted": true` on the one accepted.

```json
{
  "software": {
    "xcode": ["16.4", "26.0"],
    "xcodeDefault": "26.0",
    "allowBeta": false,
    "simulators": ["iOS 26.0"],
    "commandLineTools": true,
    "rosetta": false,
    "brew": { "formulae": ["cocoapods"], "casks": [] },
    "apt": [],
    "dnf": [],
    "docker": false,
    "node": "22",
    "java": "17",
    "android": ["platforms;android-35", "build-tools;35.0.0"]
  },
  "settings": { "noSleep": true, "devToolsSecurity": true, "automationMode": false },
  "diskThresholdGb": 40
}
```

`software` may also name `rust`, `python`, `go` and `ruby` versions. Lists
hold up to 100 names. `diskThresholdGb` (default 40) is the free disk below
which unused Xcodes and runtimes are removed. `DELETE` removes the type; 404
when there is none. Both answer the `nodeTypes` area.

### Cloud budget

**`PUT /api/v2/settings/cloud/budget`** takes `{ "monthlyBudget": 300 }`,
dollars per calendar month across all pools, and keeps the pools. It
answers the `cloud` area.

## 13. Apple

The master's Apple ID session (for Xcode downloads and team setup) and its
signing certificates and provisioning profiles. All routes need
`apple.change`. The password is write-only and the session never leaves the
master.

| Method and path | What it does |
| --- | --- |
| `GET /api/v2/apple/session` | The Apple ID session's state. |
| `POST /api/v2/apple/session` | Signs the Apple ID in; Apple usually asks for a code next. |
| `POST /api/v2/apple/session/code` | Sends Apple's two-factor code. |
| `GET /api/v2/apple/setup` | The teams the signed-in Apple ID belongs to. |
| `POST /api/v2/apple/setup` | Checks a team's signing again: its App Store Connect key and distribution certificate. |
| `GET /api/v2/apple/certificates` | The signing certificates, without private keys. |
| `POST /api/v2/apple/certificates` | Imports or creates a certificate. 201. |
| `DELETE /api/v2/apple/certificates/:id` | Removes a certificate. |
| `GET /api/v2/apple/profiles` | The provisioning profiles: `{ team, bundleId, distribution, platform, name, uuid, expiresAt }` each, `platform` being `ios`, `macos` or `tvos`. |

- The session routes answer the state:
  `{ "appleId", "state", "since", "notice", "codeVia", "error" }`, `state`
  being `signedOut`, `needsCode`, `signedIn`, `expired` or `failed`.
  **`POST …/session`** takes `{ "appleId": "ada@example.test", "password":
  "…" }` (`appleId` defaults to the stored one). **`…/session/code`** takes
  `{ "code": "123456" }`, six digits; 400 when no sign-in waits for a code.
- Once the Apple ID is signed in (directly, or after the code), the master
  sets up in the background the teams it uses: the Apple ID's only team, or
  of several, those with a stored key or an app ID assigned to them (another
  is set up with `POST …/setup` or its button on Settings → Apple). Of
  those, each with no stored key, or whose last setup failed: the team's App
  Store Connect API key, then its
  distribution certificate, then the profiles of app IDs whose Apple setup
  was incomplete. The sign-in answers without waiting. Each setup is audited
  as `apple.setup` by the person who signed in. A failure (Apple's
  certificate limit, an Apple ID without the Admin role, a team without API
  access) becomes a notice naming the team and what to do, in `mason
  status`, the dashboard and Settings → Apple, until a later setup of that
  team succeeds or the Apple ID no longer belongs to it.
- Apple answering 401 to any of the master's App Store Connect website calls
  moves the session to `expired`, with the call in `error`: sign in again.
  A 403 (the Apple ID's role or the team's API access) leaves the session
  signed in.
- **`GET …/setup`** answers `{ "keyName", "teams": [{ "id", "name" }] }`.
  **`POST …/setup`** ("Check signing again") takes `{ "team": "ABCDE12345" }`
  (optional with one team) and runs the same setup now: it keeps what still
  works and makes what is missing, then sets up the profiles of the team's
  app IDs that still lack them. It answers `{ "team": { "id", "name" },
  "key", "keyId", "certificate" }`, where `key` is `created`, `kept` or
  `replaced` and `certificate` `created` or `kept`. 400 when the Apple ID is
  in no such team or Apple allows no more distribution certificates.
- **`POST …/certificates`** takes `team` (ten capitals and digits) and one
  of:
  - `p12` (base64) and its `password`;
  - `match`: `{ "repository", "passphrase", "branch" }`, a Fastlane Match
    repository (branch default `master`);
  - `create`: `development`, `distribution`, `developerIdApplication` or
    `developerIdInstaller`, made through App Store Connect.

  It answers what was imported or created, then sets up profiles for the
  team's app IDs that still lack them.
- A certificate: `{ "id", "team", "kind", "appleId", "serial", "name",
  "sha1", "expiresAt", "source", "revoked" }`, `source` being `p12`,
  `match` or `created`. `DELETE` answers `null`; 404 for an unknown
  certificate.
- A profile: `{ "team", "bundleId", "distribution", "name", "uuid",
  "expiresAt" }`.

## 14. Builds

The published builds a caller may see, and their files. Every route needs
`builds.read`, which every role has, from an API key or a browser session.

| Method and path | What it does |
| --- | --- |
| `GET /api/v2/builds` | Builds, newest first. |
| `GET /api/v2/builds/:id` | One build. |
| `GET /api/v2/builds/:id/download` | The build's file, or a redirect to it. |

**Where they are answered.** The host answers these routes itself, from its
cache of the master's builds and from its storage, for API keys and for
people signed in on the host; it does not forward them. It keeps answering
while the master is unreachable, until the master has been away longer
than the host's `offlineGraceHours` (default 72), when it answers 503
`This Mason host has not reached its master for too long to serve builds`;
before its first sync it answers 503 `This Mason host is waiting for its
master`, as it does a key it does not hold when it was upgraded and its master has
not sent it the keys since (a master older than the host sends none). The master answers the same routes, for keys and its own
sessions, by relaying to the host over the link: the host decides what the
caller sees and serves the file, and a download streams from the host
through the master. With no host paired the master answers 503 `This
cluster has no host`, and with the host not connected, 503 `The host is not
connected`. Both answer the same builds for the same caller.

**Who sees what.**

- An `admin`, `manager` or `developer` sees every app's builds.
- A `tester` sees the builds of its groups' apps, as the host's catalog
  shows them, or of every app when a sign-in method admitted it. A
  tester-role key sees its creator's groups' apps; one with no creator sees
  none: a key made with `mason keys create`, or by another key through
  `POST /api/v2/keys`.
- A scoped key sees only builds whose app belongs to a project in its
  `projects` and whose branch matches its `branches`. A `project` query, or
  a build, outside them is 403 `This key does not cover that project or
  branch`.

A build of an app the caller does not see is 404 `No such build`, like an
unknown one. Only ready, unexpired builds of enabled apps are listed.

### GET /api/v2/builds

Query, every field optional:

| Field | Meaning |
| --- | --- |
| `project` | A project slug. |
| `app` | An app ID (`app.example.one`). |
| `branch` | A branch, exactly. |
| `platform` | `ios`, `android`, `macos`, `windows` or `tvos`. |
| `variant` | A variant name; empty (`variant=`) is the default variant, the file a stage published with none. |
| `latest` | `1` keeps only the newest build of each app, branch, platform and variant. |
| `limit` | 1–500, default 50, applied after the caller's apps and scopes. |

A field that is invalid, or given twice, is 400 (`Invalid platform`).
Answers a list of builds in this shape:

```json
{
  "id": 41,
  "app": "app.example.one",
  "appName": "Example One",
  "project": "phones",
  "branch": "master",
  "platform": "android",
  "variant": "",
  "version": "1.2.3",
  "buildNumber": "42",
  "commit": "9c1e5a7f3b2d4e6f8a0b1c2d3e4f5a6b7c8d9e0f",
  "bundleId": "app.example.one",
  "format": "apk",
  "size": 18234112,
  "digest": "8f434346648f6b96df89dda901c5176b10a6d83961dd3c1ac88b59b2dc327aa4",
  "publishedAt": 1793450000000,
  "expiresAt": 1794659600000,
  "run": "5f0c2b9e-8d1a-4c3e-9a57-2f6d1e0b7c44",
  "download": "/api/v2/builds/41/download"
}
```

`digest` is the file's SHA-256. `project` is `null` for an app no project
owns, and `run` for a build no run published. A run's variants are separate
builds with the same `run`.

### GET /api/v2/builds/:id

The build, in the shape above.

### GET /api/v2/builds/:id/download

- A build on the host's disk answers 200 with the file and
  `Content-Type`, `Content-Disposition: attachment; filename="<app>-<version>-<buildNumber>[-<variant>].<format>"`,
  `Content-Length`, `Repr-Digest: sha-256=:<base64 SHA-256>:` and
  `ETag: "<hex SHA-256>"`.
- A build stored in a Space answers 302 with a `Location` signed to read
  the file straight from the Space for five minutes (which answers with the
  same `Content-Disposition` and `Content-Type`), `Cache-Control: no-store`, `Repr-Digest` and
  `ETag`. curl and browsers do not send the `Authorization` header on to
  the Space's host.
- `HEAD` answers the same headers without the file.
- 404 `The build’s file is no longer available` when the stored file is
  missing or its size is not the build's; 502 `The build’s storage is
  unreachable` when the disk or Space cannot be read. A refusal is JSON,
  through the master too.

The host logs each download once its file is under way (`Build 41
downloaded by key 830f19 through the master`, or `Build 41 redirected to its
Space for …`); `HEAD` is not logged. Build reads are not audited.

## 15. Routes outside `/api/v2/`

### The v1 job API

The builder's job API, kept on the master with its paths and fields so
existing clients keep working. The host forwards `/api/jobs` and
`/api/queue`, not `/api/apps`. Bodies are limited to 16 KB, and unknown
fields are refused.

| Method and path | What it does | Permission |
| --- | --- | --- |
| `POST /api/jobs` | Requests a `build` run. 202. | `runs.request` |
| `GET /api/jobs/:id` | One job. | `runs.read` |
| `GET /api/jobs/:id/log` | The job's log, `text/plain`. | `runs.read` |
| `GET /api/jobs/:id/logs` | The job's log as a download (`X-Mason-Log-Capture: full`). | `runs.read` |
| `POST /api/jobs/:id/cancel` | Cancels a job: `{ "cancelled": true }`, or 409 when it is not active. | `runs.request` |
| `GET /api/queue` | Queued and running jobs. | `runs.read` |
| `GET /api/apps` | Projects with their build settings. | `apps.read` |
| `GET /api/apps/:slug/build-settings` | A project's default branch and automatic branches. | `apps.read` |
| `PUT /api/apps/:slug/build-settings` | Sets them. | `projects.change` |

`POST /api/jobs` takes `{ "app": "app.example.one", "branch": "master",
"platforms": ["ios"], "idempotencyKey": "ci-8812", "envVars":
[{ "API_URL": "https://api.example.test" }] }`: `app` is a project slug or
an app ID; `platforms` must be ones the project builds; `envVars` holds up
to 100 one-variable objects (each value up to 4096 characters) and may not
set a file secret's path variable. A repeated `idempotencyKey` from the same
caller answers the first job, or 400 when the request differs. A job has the
run's v1 fields and `stages` (`name`, `status`, `worker`).
`PUT …/build-settings` takes `{ "defaultBranch", "automaticBranches" }`, at
most 20 automatic branches, which become `automatic` rules. `GET` lists in
`branches` every branch the master has seen: `lastChecked` is the last poll
that saw it and `observedCommit` the head it last decided. A branch whose
latest push was not built has `skippedCommit` and `skippedReason`
(`<commit> has no Masonfile`, `<branch> is not in the push trigger's
branches`, or `Workflow build has no push trigger`), whether the master
decided it or setup did. A changed head the poll left for a later poll, because more than
20 of the project's branches changed at once, has `waitingCommit` and
`waitingSince` (milliseconds since the epoch) until it is decided.

### First-run setup

Until the first account exists, the master's pages create it with these
routes, gated by the six-digit setup code the master prints. They refuse
forwarded requests.

| Method and path | What it does |
| --- | --- |
| `GET /api/setup` | `{ "configured" }`, and `waitUntil` before the next code guess is checked. |
| `POST /api/setup` | Takes `{ "code", "username", "clientHash", "clientParameters" }`, creates the first administrator and signs them in. 201. |
| `POST /api/setup/restore` | Takes `{ "code", "repository", "key", "branch", "date" }` and restores the master from a backup. 202. |

A wrong code delays the next guess (5 s, then 10, 20, …); it and any guess
during the wait answer 429 with `retryAt`, and a guess during the wait is not
checked. Once the master is configured these routes
are 404.

### Install apps and Devices

The tester pages are served on both nodes, signed in with that node's
session:

| Method and path | What it does |
| --- | --- |
| `GET /`, `GET /apps` | Install apps: the apps the person may install, with a platform switch. `/` is everyone's home on both nodes. |
| `GET /apps/:appId`, `GET /apps/:appId/branches/:branchKey` | An app's branches; a branch's builds for a platform, each with its install control. |
| `POST /builds/:id/install` | A grant for the build: 303 to its package, or the iOS installer page; 409 when the selected device must be registered or the build prepared for it. |
| `POST /builds/:id/prepare` | Requests a build of that branch and commit for the selected device. |
| `GET /install/:token/manifest.plist`, `GET /install/:token/artifact` | A grant's iOS manifest and package, with no cookie: `HEAD`, a single `Range` (206 with `Content-Range`, 416 when unsatisfiable) and `If-Range`. |
| `GET /devices`, `POST /devices/profile`, `POST /devices/:id/:action` | The person's devices; a registration profile; `select`, `rename`, `retry` or `remove`. |
| `GET /devices/complete/:token` | Where a registered device lands. |

The forms post `csrf`, the session's proof, from the node's own origin. The
selected device is that node's `__Host-mason-device` cookie; a device that
is not the person's counts as none, and selecting one is 404.

**On the master** these pages draw their data from the host over the link,
for the account the master session authenticated; the host decides what
the person sees from its cache, as for its own pages. For each master session that uses them the host
keeps a relay session (`sessions.relayed = 1`, keyed by an HMAC of the
master session's digest), which holds its install grants and registration
requests, expires with the master session, ends when that session signs
out (`catalog.endSession`) or its account's permission version changes, and
never signs a browser in on the host. Install tokens live on the host; the
master relays a grant's manifest and package with the request's method,
`Range` and `If-Range`. With a paired host disconnected the pages answer
503 "The host is unreachable". A master whose cluster has no host yet opens
Projects & apps at `/` for developers and up; its Install apps and Devices
pages, and a tester's `/`, say "No host is linked yet — installs come from
a host" (200; a form post answers 503).

Projects & apps is `/projects` on both nodes, with its filters
(`?platform=`, `?project=`) there. To a tester `/projects` and every page
under it answer 404, on both nodes.

The master's public origin is its `master` setting. A manifest from the
master names its package there, and a registration started on the master
carries the host's callback URL (devices live on the host), whose 301 sends
the device back to `<master origin>/devices/complete/<token>`. Without that
setting the master serves a certificate iOS will not install from, so its
iOS rows and device registration link to the host's own pages instead, saying
installs on iPhone and iPad go through the host until the master has a
public address; other platforms still download from the master.

### The host's GitHub webhook

`POST /api/webhooks/github/<project>` is served by the host, not the
master. GitHub sends pushes there; the host checks the size (1 MiB) and
rate (60 deliveries a minute per project) and passes the raw body and
`X-Hub-Signature-256` to the master, which verifies the signature with the
project's webhook secret. It answers 202 with the master's result:
`accepted` for a push on an automatic branch, which the master then
decides (see "Deciding a push" in [docs/masonfile.md](masonfile.md#triggers);
a push it does not build shows in the build settings below), `ignored`
for any other branch, or `ok` for a ping; 401 for an
unsigned delivery, a signature that does not verify, or a project with no
webhook secret; 404 for an unknown project; 422 for a body that is not JSON
or is for another repository; and 429 when the rate is exceeded. While the
master is unreachable the host keeps the latest delivery per project and
branch and answers 202 `{ "status": "queued" }`. See "Webhooks" in
[docs/masonfile.md](masonfile.md#triggers).

## 16. Examples

```sh
MASON=https://mason.example.test
KEY=$(cat ~/.mason/admin.key)
```

List the latest runs of a project:

```sh
curl -sS -H "Authorization: Bearer $KEY" \
  "$MASON/api/v2/runs?project=phones&limit=20"
```

Request a run of the `build` workflow on a branch:

```sh
curl -sS -X POST "$MASON/api/v2/runs" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"project": "phones", "branch": "feature/login", "params": {"seat": "1"}}'
```

The answer is the new run; its `id` names it in the next requests.

Read a run, then download one stage's log without terminal colours:

```sh
RUN=5f0c2b9e-8d1a-4c3e-9a57-2f6d1e0b7c44
curl -sS -H "Authorization: Bearer $KEY" "$MASON/api/v2/runs/$RUN"
curl -sS -H "Authorization: Bearer $KEY" -o build-ios.log \
  "$MASON/api/v2/runs/$RUN/logs?stage=build-ios&plain=1"
```

Follow the same stage live (`websocat` or any WebSocket client):

```sh
echo '{"subscribe":"run","run":"'"$RUN"'","stage":"build-ios"}' |
  websocat -n -H "Authorization: Bearer $KEY" "${MASON/https:/wss:}/live"
```

Add a file secret for the `release` and `beta` build configs. The contents
are base64 without line breaks; `jq` writes the body to a file, since a
large file does not fit on a command line:

```sh
base64 < release.keystore | tr -d '\n' > keystore.b64
jq -n --rawfile contents keystore.b64 \
  '{kind: "file", name: "release.keystore", configs: ["release", "beta"], contents: $contents}' \
  > secret.json
curl -sS -X POST "$MASON/api/v2/projects/phones/secrets" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @secret.json
```

List the newest build of each app on `master` for Android, from the host
(`$HOST`) or the master, then download one and check its digest:

```sh
curl -sS -H "Authorization: Bearer $KEY" \
  "$HOST/api/v2/builds?project=phones&branch=master&platform=android&latest=1"
BUILD=41
curl -sS -H "Authorization: Bearer $KEY" "$HOST/api/v2/builds/$BUILD" | jq -r .digest
curl -sS -L -OJ -H "Authorization: Bearer $KEY" \
  "$HOST/api/v2/builds/$BUILD/download"
shasum -a 256 app.example.one-1.2.3-42.apk
```

`-L` follows a redirect to a Space; `-OJ` saves the file under the name in
`Content-Disposition`. The build's `digest` is the SHA-256 the file must
match; so are the first response's `ETag` and `Repr-Digest` (after a
redirect, the Space's own `ETag` is not).

List nodes:

```sh
curl -sS -H "Authorization: Bearer $KEY" "$MASON/api/v2/nodes"
```

Set a node's type and labels. The list replaces its labels, so a node that
runs setup keeps `setup`; a dedicated node, such as a signer, leaves it out:

```sh
NODE=$(curl -sS -H "Authorization: Bearer $KEY" "$MASON/api/v2/nodes" \
  | jq -r '.[] | select(.name == "mac-mini-2") | .fingerprint')
curl -sS -X PUT "$MASON/api/v2/nodes/$(jq -rn --arg f "$NODE" '$f|@uri')" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"type": "mac-xcode", "labels": ["setup", "apple-signing"], "slots": 2}'
```

`mason nodes set mac-mini-2 --type mac-xcode --label setup --label
apple-signing --slots 2` does the same on the master's computer.

A permanent cloud node takes its labels when it is made:

```sh
curl -sS -X POST "$MASON/api/v2/cloud/nodes" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name": "linux-1", "account": "do-main", "region": "sfo3", "size": "s-4vcpu-8gb", "type": "linux", "labels": ["setup", "android-signing"]}'
```
