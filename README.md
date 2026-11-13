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
  It holds no secrets. The master serves the same Install apps and Devices
  pages to people signed in on it, getting their data and files from the
  host over its link.

The Masonfile reference, with every option and the stage API, is
[docs/masonfile.md](docs/masonfile.md). The master's HTTP API is
[docs/api.md](docs/api.md).

Nodes link only to the master. Workers report their stages and logs over
their link, and the files a stage publishes, saves or fetches travel over it
too, so a worker needs no route to the host. The host has its own link to the
master, over which it receives the master's replicated data and the files
stages publish, and forwards its pages' requests for live run updates.

## Installing

A release needs no Node.js or npm. One command on each computer installs
Mason and starts its role as a service:

```sh
curl -fsSL https://github.com/EdgeApp/mason/releases/latest/download/install.sh | bash -s -- master
curl -fsSL https://github.com/EdgeApp/mason/releases/latest/download/install.sh | bash -s -- worker
curl -fsSL https://github.com/EdgeApp/mason/releases/latest/download/install.sh | bash -s -- host
mason status        # role, state, version, fingerprint, web address
```

A cluster needs a master and at least one worker; a host is needed to serve
installs and published builds. The master can also make its host and its
workers itself on a cloud account (the Cloud and Nodes pages), installing
this same release on them.

- It asks for your password once (or run it as `… | sudo bash -s -- master`).
  The service runs as the account that ran the command, with its data in
  that account's `~/.mason`. Run as root with no other account, Linux uses a
  `mason` system user instead; on macOS the service needs a logged-in account
  for Xcode and keychains.
- Words after the role go to `mason <role> --install`: `master --worker` (the
  master also runs stages), `master --port 9400`, `host --port 8443 --link-port 9420`.
  The defaults are 9300 for the master, 9200 for the host's web and 9310 for
  links.
- `--version <x.y.z>` installs another release; without a role it installs only
  the program, and `sudo mason <role> --install` starts it later.
- `… | bash -s -- uninstall worker` stops the service and removes the program
  (`/opt/mason`, `/usr/local/bin/mason`); the data directory is kept.

### A worker on the master's computer

`master --worker` runs a worker inside the master's process. It is the
simplest, but its stages run as the master's account, which can read the
master's database and every secret in it. A worker that runs only trusted
work (signing, say) on the same computer is better installed under an account
of its own. The installer's own `--user` means "no sudo" and does not apply
here, so this takes two steps: the one-line install of the master puts the
`mason` program in place, then

```sh
sudo useradd --system --create-home --home-dir /home/mason-node --shell /usr/sbin/nologin mason-node
sudo mason worker --install --user mason-node --listen 127.0.0.1 --link-port 9310
```

installs the worker as that account, with its data in `/home/mason-node/.mason`,
listening on loopback so only the master on that computer reaches it. Pair it
with the address `127.0.0.1:9310` and the pairing key the install prints (it is
also in the worker's first log lines). Without `--user`, `sudo mason worker
--install` installs for the account that ran `sudo`, and reuses that account's
`~/.mason`, which on the master's computer is the master's own: the worker
then refuses to start because the directory is in use.

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

`mason update` installs a newer release on a node and restarts its services,
then asks the root helper (`mason-helper`, or `app.mason.helper` on macOS) to
restart into it once the requests it is serving are done; a helper that does
not answer is restarted by its service manager as root, and the update says
when it could not be. It keeps the new release and the one that ran before
it, and removes older releases and failed installs from the install directory
(`/opt/mason`, or `~/.mason/app` for a user install). Worker updates the
master pushes do the same: the helper answers the push, restarts the worker,
and restarts itself once no other request is in progress, taking no new one
meanwhile.

## Pairing nodes

A new worker or host prints a pairing key when it first starts. Pair it from
the master's Nodes page (**Add node**), or from the master's computer:

```sh
mason nodes add --address 192.168.1.20:9310 --key mason1:…
mason nodes set second --type mac-xcode --label setup --label apple-signing --slots 2
mason settings set host --file host.json     # {"origin": "https://builds.example.test"}
```

A stage runs on a node that matches its `on` selector: the node's type, OS and
architecture, and every label the selector names. A node's name, type, labels
and slots are set on the Nodes page (each node's **Edit**), with
`PUT /api/v2/nodes/:fingerprint`, or with `mason nodes set`; each replaces the
node's labels with the ones it is given. A worker may also be paired with its
type and labels.

A run's setup, which executes the branch's Masonfile, runs only on nodes
labelled `setup`. Every new node, permanent cloud node and pool carries that
label until an administrator removes it. A node dedicated to some stages
takes a type and a label of its own and no `setup`: it then never runs a
setup, and takes a stage only when the stage's selector matches it, by its
type or label, or by OS and architecture alone. Stages that should stay off
it select by type. A signing node that holds an Android keystore, for example:

```sh
mason nodes set jack3 --name android-signer --type android-signer --label android-signing --slots 1
```

with the signing stage `on: { labels: ['android-signing'] }` and
`checkout: false`, so the node gets the stashed packages and the Masonfile
but none of the repository (see [docs/masonfile.md](docs/masonfile.md)).
A secret reaches only the node running a stage that declares it, so a
keystore only the signing stage declares reaches only the signing node.

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

## Signing in

People sign in to the master's pages, and to the host's, with a username and
password, or with a sign-in provider such as Google (Settings → **Sign-in**).
The host offers the enabled providers at its own address. The master offers
them once its public address is set in the same card (the `master` setting,
`{"origin": "https://mason-admin.example.com:9300"}`); register both callback
URLs the card shows with the provider. A master on an internal network needs
a name in a public domain that resolves to its private address, and a
certificate the browsers trust; only the browser visits the provider's sign-in
pages and the callback, and the master calls the provider's token endpoint.
A provider signs someone in when it confirms an email address that a person
on the People page has.

Someone added on the People page without a provider can be sent an
invitation link instead (**Invite**, or **Make an invitation link** when
adding them). Mason sends no email: copy the link to them. It opens on the
host, valid for a week and once, and lets them choose a username and a
password that then sign them in on the host and the master.
An administrator can instead set a person's username and password on the
People page (**Set password**, or the Add form), and tell them; setting it
ends the person's sessions.

## The pages

The master and the host serve the same web app, a React single-page app
(`src/web/`) that reads everything through the JSON API and `/live`. Every
page address on either node answers the app's shell; the server draws no
page itself. The app is dark by default; the account menu's **Appearance**
switches it to Light or to Match system, and the choice is kept in that
browser.

Every signed-in page has the same navigation, showing each person what
their role reaches: **Projects & apps** (`/projects`) and **Artifacts** for
developers and up; **Install apps** and **Devices** for everyone; and, on
the master only, **Nodes**, **Cloud**, **People**, **Groups**, **Settings**
and **Backups** for managers and administrators. On a desktop it is a
sidebar, on a tablet a rail, and on a phone a tab bar with **More**. The
master opens on Projects & apps for developers and up; a tester's home is
Install apps on both nodes, and to a tester `/projects` and everything
under it do not exist (404). A master with no host yet says on Install apps
and Devices that installs come from a host. The top bar's account menu
holds **Your account**, Appearance and **Sign out**; its bell lists the
approvals waiting for the viewer and, for managers, the master's notices.
⌘K (or the search capsule) searches projects, app IDs, runs by number,
commits and branches.

Above each page's title, its breadcrumbs say where it is. The first is
**Mason Master** on the master and **Mason Host** on the host, and opens
that node's home; the last is the page itself. A project's pages go
Projects › the project › Runs and builds (or Masonfile, or Secrets), and a
run's page Projects › the project › Runs and builds › Run N. An app ID's
pages go Projects › the project › the app ID › Runs and builds (or Build
numbers). Install apps goes Install apps › the app › the branch, and
Artifacts › the project › Run N; Devices, Your account and the master's
Nodes, Cloud, People, Groups › a group, Settings and Backups are one level
each, as the navigation lists them.

Each app ID of a project has its own pages on both nodes, for developers
and up: `/projects/<project>/apps/<app ID>` is its **Runs and builds**, the
runs whose workflow publishes that app ID (from a stage or a post stage)
and only the branches that have one, with `?branch=` as on the project; and
`…/build-numbers` is its **Build numbers**: the sequence it takes its
numbers from (its own key, or a shared one, saying which app IDs it is
shared with), else the default scheme (`N`, across branches). On the master
a manager can set where that sequence stands there; the host shows it read
only. An app ID the project does not have answers 404 under the project.
⌘K search opens an app ID's page for developers and up, and a tester's
Install apps page for testers.

While the host cannot reach its master, its pages say so and keep showing
what it holds; what needs the master is disabled with the reason.

### Registering iOS test devices

**Devices** offers a temporary Profile Service download (**Install
Registration Profile**). On the master a registration started there returns
to the master once the device is registered, and needs the master's public
address (its `master` setting): without one, Devices and iOS installs link
to the host. In Safari on an iPhone or iPad, download the profile, then open
Settings → Profile Downloaded → Install. The device sends a signed
UDID/model/OS response to Mason. The registration is saved to the signed-in
person's account. Model names default to `iPhone13 of mark@example` and can
be edited. Desktop visitors can scan a QR code to open the flow on their
phone.

Registration does not install an app signing certificate, root CA, or MDM
payload. The profile is unsigned; Apple's profile-installation warning is
expected. Only UDID, PRODUCT and VERSION are requested. Device callbacks verify
CMS signatures against Apple's roots (`src/devices/apple-roots.pem`, public
certificates from Apple's PKI website) and an expiring one-use account/session
challenge. Apple's built-in device identity certificate dates are ignored as
specified by its Profile Service documentation; the signature, chain and device
issuer are verified. New registrations never implicitly grant tester access.

The host serves registration and sends each device to the master through its
outbox. The master registers the device with Apple through its App Store
Connect key, replaces the development and ad hoc profiles of every iOS app ID
with the full list of enabled iPhones, iPads, iPods, Apple Watches and Vision
Pros (the new profile is made before the old one is deleted; Apple TVs, which
Apple refuses on iOS profiles, are left out), and queues builds of the
automatic branches of each project with an app for the device; no worker and
no Apple credential outside the master is involved. **Prepare for this
device** queues a new build of that package's exact branch and commit.

Mason verifies and records device membership and expiry from each IPA's
embedded Apple-signed ad hoc profile, including the app identifier.
Installation grants are bound to the selected account-owned device and checked
again at manifest/artifact download. Unregistered, incompatible and expired
profiles are never presented as ready. Android and desktop downloads keep their
existing behavior.

Apple's annual device allowance still applies. Removing an account association
does not disable the device at Apple, recover a device slot, or revoke downloaded
apps. Use the Apple developer account to manage that separate device lifecycle.
See `src/devices/NOTICE.md` for Zealot and DeviceKit attribution.

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
commit, `request` builds only when someone asks. Each poll looks at every
automatic branch and decides at most 20 changed ones per project: exact
rules first, then the Masonfile's literal push branches, then the
longest-waiting (see [Triggers](docs/masonfile.md#triggers)). Deleted
branches stop polling; forks never build. `*` matches within one path
segment and `**` across: to let the Masonfile's push triggers choose among
every branch, the rule is `**` → automatic, since `*` misses branches like
`paul/x`.

A project's secrets are named values and files, each limited to build
configs, on the project's **Secrets** tab: administrators and managers add,
edit, replace and delete them there and see the audit, and developers see
their names and configs. Each change is to one variant, made on the tab or
through `/api/v2/projects/<slug>/secrets` (a file up to 5 MiB), and is pushed
in an encrypted backup before it is saved, so changing secrets needs backups
configured. Every view and change is audited. A host forwards an API request
of at most 512 KB, a file of about 380 KiB once in base64, so send a larger
file to the master directly.

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

## Pulling builds

Scripts download published builds with an API key, from the host or the
master:

```sh
curl -sS -H "Authorization: Bearer $KEY" "$HOST/api/v2/builds?project=phones&latest=1"
curl -sS -L -OJ -H "Authorization: Bearer $KEY" "$HOST/api/v2/builds/41/download"
```

The host answers from its own copy of the builds and its storage, so it
keeps serving while the master is offline, up to the host's offline grace
window; the master relays the same requests to the host. A download is the
file with its SHA-256 in `ETag` and `Repr-Digest`, or a five-minute signed
link when the build is stored in a Space. Developers and up see every app's
builds, testers their groups' apps, and a scoped key only its projects. See
[Builds](docs/api.md#14-builds) in docs/api.md.

## Migrating from the standalone server and builder

The master imports the existing distribution and builder databases before
its first setup and the host imports the distribution's build files:

```sh
mason import --distribution distribution.sqlite --builder builder.sqlite
mason host import --distribution distribution.sqlite --storage /srv/mason/storage
```

Where a build-number sequence should continue from numbers issued elsewhere,
set its last number on the project's page (or `POST /api/v2/build-numbers/seed`).

Existing sessions, devices, keys and builds carry over; upload keys do not,
since the cluster has no Zealot upload API (`mason import` reports how many it
skipped). Builds are published only by pipeline stages, through `ctx.publish`.
Script-format Masonfiles keep running but cannot publish; a project moves to
a pipeline Masonfile when it is ready.

The standalone distribution server (`mason serve --config`), its upload
and admin keys (`mason keys create|list|revoke --config`, `mason keys
import`) and the standalone builder (`mason builder …`) are retired: the
cluster replaces them. The maintenance commands that read the old
distribution database stay: `mason migrate|prune|status|accounts --config
<file>`, `admin-grant`, `admin-revoke`, `rewrite-teamstation-subjects` and
`devices-inspect --config <file>` (which backfills device metadata from
retained IPAs).
