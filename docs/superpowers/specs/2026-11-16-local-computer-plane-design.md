# Local computer plane

This design builds every task in `docs/plans/self-host-computer.md`. That plan is the HTTP contract. This document names the modules, the state file, the Incus boundary, and the tests. It does not reopen the plan's decisions.

The Mac app stays the client. `lib/server/orgo.ts` is not rewritten. `BOPS_ORGO_ORIGIN` points at this process. Unset it and the app talks to Orgo again.

## Decisions

- One Node 24 process. No new npm dependency. Relative imports. The plane does not import `cloud/`.
- `host/server.ts` binds the port and composes route modules. Each route family lives in its own file from the start, the same arrangement `cloud/server.ts` uses.
- Incus sits behind one interface. `node --test host/test/` injects a fake driver, a temp state directory, and a manual clock. The real `incus` binary is used only when the process is started without an injected driver. A green test does not mean a guest resumed.
- One JSON file, `host/state/plane.json`. Not SQLite. Not Postgres.

## Process

`host/server.ts` exports `start({ driver, statePath, now, host, port })`. Production calls it with the CLI driver, `host/state/plane.json`, `Date.now`, and the bind address below. Tests pass the fake, a temp file, and a clock they move.

Default bind is `127.0.0.1:8788`. `BOPS_HOST_ADDR` may name another loopback address and port. A value that is not loopback refuses to start. The process prints `non-loopback bind is unsupported` and exits non-zero. The operator terminates TLS in front before any LAN listener exists. The plane does not mint a certificate.

Bearer required on every route except `GET /health`, the websockify socket, and `PUT /api/files/uploads/{token}`. The account bearer is the value of `ORGO_API_KEY`, compared in memory and never written to the state file. A missing or unknown bearer is 401 `{ "error": "unauthorized" }`.

Each request logs one line: method, route template, status, milliseconds, and computer id when the path has one. The line never includes the bearer, bash command text, key file contents, screenshot bytes, response bodies, the websockify `token`, the upload token, or `vnc_password`. `PUT /api/files/uploads/{token}` is logged with that template, not the raw path.

`host/http.ts` holds the route type, JSON read and write, and upgrade refusal. Limits: JSON bodies 1 MB, upload bytes the size declared at start. A larger body is 413.

## Modules

| File | Owns | Calls |
| --- | --- | --- |
| `host/server.ts` | Bind, auth gate, request log, route composition, websockify upgrade | route modules, state, driver |
| `host/http.ts` | Route and upgrade types, `sendJson`, `HttpError` | nothing in `host/` |
| `host/auth.ts` | Account key and computer-key bearer checks | state |
| `host/state.ts` | Load, lock, atomic replace | the filesystem |
| `host/incus.ts` | Driver type and typed failures | nothing |
| `host/incus-cli.ts` | Driver via the `incus` binary, argument vector only | `incus` |
| `host/incus-fake.ts` | In-memory driver for tests | nothing |
| `host/wake.ts` | Due routines and idle suspend | state, driver, clock |
| `host/log.ts` | The one log line | stdout |
| `host/routes/computers.ts` | Computer, screen, bash, input, screenshot, ssh, key, resize, clone, fork, webrtc | state, driver |
| `host/routes/workspaces.ts` | Workspaces, members, invites, delete preview, project delete | state |
| `host/routes/routines.ts` | Routines, runs, the bops map, activity | state, wake |
| `host/routes/egress.ts` | Devices, upstream, residential proxy | state |
| `host/routes/files.ts` | Upload start, byte PUT, complete | state, driver |
| `host/routes/settings.ts` | `GET` and `PUT /api/bops/settings` | state |
| `host/routes/closed.ts` | Secrets, deploys, domains, sync paths | nothing |
| `host/image/build.mjs` | Local image from `orgo/bops-base.mjs` | a Linux builder |
| `host/routes.md` | Every path the app calls, with a class | the route-freeze test |

`host/image/build.mjs` is not imported by the server. It does not call `https://www.orgo.ai/api/templates`. The image alias the plane accepts as `template_ref` is `bops-base`. Any other ref is 400.

## Incus driver

```ts
type IncusFailure = "incus_down" | "host_full" | "disk_full";

type IncusDriver = {
  version(): Promise<string>;
  free(): Promise<{ ramMb: number; diskGb: number }>;
  create(input: { name: string; image: string; cpu: number; ramMb: number; diskGb: number }): Promise<{ instance: string }>;
  start(instance: string): Promise<void>;
  stop(instance: string): Promise<void>;
  restart(instance: string): Promise<void>;
  delete(instance: string): Promise<void>;
  clone(instance: string, name: string): Promise<{ instance: string }>;
  resizeDisk(instance: string, diskGb: number): Promise<void>;
  exec(instance: string, command: string, timeoutSec: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  screenshot(instance: string, screen: string, format: "jpeg" | "png", scale: number): Promise<Buffer>;
  input(instance: string, kind: "click" | "type" | "key", body: unknown, screen: string): Promise<void>;
  writeFile(instance: string, path: string, contents: Buffer, mode: number): Promise<void>;
  vncPort(instance: string, screenId: string): Promise<number>;
  sshPort(instance: string): Promise<number | null>;
};
```

The CLI driver passes `command` as one argv element to `incus exec`. It does not join the command into a host shell. `exec` kills the guest process when `timeoutSec` elapses and resolves with a non-zero `exitCode`. The client's extra 20 seconds in `lib/server/orgo.ts` are only for reading that answer. The plane does not wait those 20 seconds before killing.

`screenshot`, `input`, and `writeFile` run only while the plane's status for that computer is `running`. The HTTP layer checks status before it calls them.

The fake records the last `exec` call, can throw `incus_down` or `host_full`, and returns fixed screenshot bytes. `free()` returns whatever the test set.

Create defaults are 4 CPU, 16384 MB RAM, 80 GB disk, 1280x960. `POST /api/computers` may pass `ram` in GB; the driver receives that value in MB. Create and clone call `free()` first. When free RAM is under the request, or free disk is under 80 GB, the handler returns 409 and does not call `create` or `clone`:

```json
{ "code": "host_full", "error": "host full", "free_ram_mb": 0, "free_disk_gb": 0 }
```

`max_disk_gb` on `GET /api/computers/{id}/resize` is `current_disk_gb` plus the free disk from `free()`. A `PATCH` whose `disk_size_gb` is above that returns 409 `{ "code": "disk_full", "current_disk_gb": 80, "max_disk_gb": 80 }`.

## State

`host/state/plane.json` is version 1:

```ts
type PlaneFile = {
  version: 1;
  workspaces: Record<string, { id: string; name: string; bopsWsId: string | null }>;
  computers: Record<string, Computer>;
  routines: Record<string, Routine>;
  runs: Record<string, { id: string; routineId: string; projectId: string; body: unknown }>;
  bops: Record<string, unknown>;
  settings: { runsOn: "cloud" | "mac" | null };
  activity: Record<string, { at: number; via: string | null }>;
  keys: Record<string, StoredKey>;
  egressDevices: Record<string, { id: string; name: string; pairingCode: string }>;
  computerEgress: Record<string, { mode: "direct" | "device"; deviceId: string | null; proxyOn: false }>;
  uploads: Record<string, { token: string; desktopId: string; destPath: string; sizeBytes: number; received: boolean }>;
  ssh: Record<string, { enabled: boolean; publicKey: string | null; hostPort: number | null }>;
};

type Computer = {
  id: string;
  name: string;
  workspaceId: string;
  instance: string;
  status: "starting" | "running" | "suspending" | "suspended" | "resuming" | "stopped" | "error";
  vncPassword: string;
  cpu: number;
  ramMb: number;
  diskGb: number;
  screens: ("default" | "screen-100" | "screen-101" | "screen-102")[];
};

type Routine = {
  projectId: string;
  routineId: string;
  nextRunAt: number | null;
  onMac: boolean;
  run: string;
};

type StoredKey = {
  keyId: string;
  computerId: string;
  hash: string;
  prefix: string;
  name: string;
  createdAt: string;
  lastUsed: string | null;
  expiresAt: null;
};
```

`routines` is keyed by `projectId + "/" + routineId`. `hash` is the SHA-256 hex of the computer key. The raw computer key is not stored. `expiresAt` stays null. This plane does not expire a computer key. Delete revokes it.

A missing file is created as empty version 1 by the write path below, then health asks the driver for `version()`. A file that exists and is not valid version-1 JSON is `state_unreadable`. The plane does not overwrite it. Any other `version` is `state_unreadable`.

A write takes two locks, in order: an in-process promise queue, then a sibling `plane.lock` created with `O_EXCL`. It writes a temp file in the same directory, fsyncs, and renames over `plane.json`. The lock file is removed after the rename. A crash mid-write leaves the previous `plane.json`. Boot loads workspaces, computers, keys, routines, runs, the bops map, settings, activity, egress, uploads, and ssh from that file.

The second-process test holds `plane.lock` and checks the other process waits. The overlap test runs a routines PUT and a wake tick together and checks one `nextRunAt` survives whole.

## Status

`starting` → `running` → `suspending` → `suspended`. `suspended` → `resuming` → `running`. `stopped` and `error` have no resume edge. An idle stop is `suspended`, which is Incus stopped plus this status. The plane never reports an idle stop as `stopped`.

`POST /api/computers/{id}/resume` on `suspended` moves to `resuming`, calls `start`, then `running`. On `running` it returns 200. Any other status returns 409 and the `error` string contains `not suspended`.

A screenshot or screen read of `suspended` returns 409 `{ "code": "computer_asleep", "error": "computer asleep" }` and does not call the driver. The same read while `starting` or `resuming` returns 409 `resume_in_progress` with `Retry-After: 2` and does not call the driver.

Bash, click, type, and key on `suspended` set `resuming`, call `start` once, return 409 `{ "code": "resume_in_progress", "error": "resume in progress" }` with `Retry-After: 2`, and do not call `exec` or `input` in that response. If that `start` rejects, status returns to `suspended` and the response is 503 `{ "code": "incus_down", "error": "incus down" }`. A computer already `starting` or `resuming` returns that same 409 and does not call `start` again. The retry that finds `running` performs the action. `stopped` and `error` return 409 whose `error` contains `not suspended` and stay down. `PUT /api/computers/{id}/orgo-key` and `POST /api/files/uploads/complete` use this same status table, because both write into the guest.

`GET /api/computers/{id}` returns `id`, `name`, `status`, `vnc_password`, `workspace_id`, `project_id` (the same workspace id), and `instance_details: { webrtc: false }`. `GET /api/workspaces/{id}` returns `desktops` as `{ id, name }` for computers in that workspace.

`GET` and `POST /api/computers/{id}/ssh` do not resume and do not call `start`. `GET` returns `{ enabled, authorized_key_set, ipv4_host, ipv4_port, ssh_user, ssh_command }`. Until a POST has stored a key, `enabled` is false, `authorized_key_set` is false, and the host, port, user, and command are null. `POST { public_key }` stores the key and sets `enabled` true. Until the guest is `running` and the file is written, `GET` returns `enabled: true`, `authorized_key_set: false`, and null host, port, and command, and the POST body is `{ enabled: true, pending: true }`. The next transition to `running` writes `authorized_keys` with that key only. After that write, `GET` returns `authorized_key_set: true`, `ipv4_host` set to the loopback address the process bound, `ipv4_port` from `sshPort`, and `ssh_command` `ssh root@<host> -p <port>`. `ssh_user` is `root`. `sshPort` returning null keeps `ipv4_port` and `ssh_command` null.

A fifth screen create returns 409 `{ "error": "four displays" }` and no `code`. Screen ids are `default` (`:99`), `screen-100`, `screen-101`, and `screen-102`. The websockify socket with no `screen` uses `default`. `&screen=` selects the other three. The socket checks `token` against `vncPassword` and proxies to `vncPort`. It does not check the bearer.

`POST /api/computers/{instance}/fork` returns 409 `{ "code": "live_fork_unavailable", "error": "live fork unavailable" }`. Clone copies the instance. `POST /api/computers/{id}/webrtc` returns `{ "webrtc": false }`.

`POST` and `PATCH` size changes that carry `{ size }` and no `disk_size_gb` return 200 `{ "size", "changed": false, "restarted": false }` and do not change cpu, ram, or disk.

A second `POST /api/computers` with the same name returns 409 `{ "error": "name taken" }`. A duplicate workspace name returns 400 `{ "code": "WORKSPACE_NAME_TAKEN", "error": "name taken" }`. Delete of an unknown computer or workspace is 404.

## Wake

`PUT /api/projects/{id}/routines` stores each routine's `nextRunAt`, `onMac`, and `run`. An empty list stores an empty list for that project and wakes nothing. `PUT` and `GET /api/projects/{id}/bops` store and return the workspace map. Wake never reads that map for `nextRunAt`.

`host/wake.ts` exports `tick(now: number)`. Production calls it every 60 seconds. Tests call it with a clock they pass. A routine starts the guest when `onMac` is false, `run` is `task`, `nextRunAt` is at or before `now`, and status is not `stopped` or `error`. A failed start is logged and the stored status is left as it was. The next tick tries again.

`POST /api/bops/computer/active` carries `{ via: "runner" }` or `{}`. It does not carry a computer id. A computer bearer updates that computer. An account bearer updates every computer. Idle suspend is skipped when that computer has no activity POST yet, and when a task routine with `onMac` false is due within 5 minutes. After a POST with `via: "runner"`, idle is 5 minutes from `at`. After any other POST, idle is 15 minutes. The idle stop sets `suspended` and calls `stop`. Tests move `now`. They do not sleep for those windows.

`GET /api/bops/settings` returns `{ "runsOn": "cloud" }` or `{ "runsOn": "mac" }`. Before any PUT, `runsOn` is `mac`. `PUT { "runsOn": "cloud" }` returns 200 and is what GET returns afterward. Any other value is 400.

## Identity, keys, members

`GET /api/user/profile` for the account bearer:

```json
{ "id": "local", "full_name": "Local", "api_key": { "scope": "account" } }
```

For a computer bearer:

```json
{ "id": "local", "api_key": { "scope": "computer", "computer_id": "<computer id>" } }
```

`profileSaysOurs` in `lib/server/orgo-auth.ts` treats a computer scope whose `computer_id` matches `BOPS_RUNNER_COMPUTER` as this computer, and treats `scope: "account"` as someone else's key. The guest file therefore receives only the computer key.

`PUT /api/computers/{id}/orgo-key` with no body mints a new key, stores its hash and an 8-character prefix matching `^[A-Za-z0-9_]{8}$`, and returns `{ "keyId" }` only. The name is `Computer key for <computer name>`. When the guest is `running`, the same request writes `export ORGO_API_KEY='<key>'` to `/root/.orgo-secrets.env` mode `0600` through `writeFile`. The value is the new computer key, not `ORGO_API_KEY` from the environment. `GET` returns `{ keyId, prefix, name, createdAt, lastUsed, expiresAt }` or 404 `{ "code": "key_not_found", "error": "key not found" }`. `DELETE` drops that key from state. When the guest is `running` it also removes the line from the file. Delete of the computer revokes its computer key and leaves the account key.

`GET /api/workspaces/{id}/members` returns `{ "members": [{ "id": "local", "role": "owner", "name": "Local" }], "invites": [] }`. `GET`, `POST`, `PATCH`, and `DELETE` on `/api/workspaces/{id}/invite`, and `POST`, `PATCH`, and `DELETE` on members, return 200 with that same body and change nothing. A computer bearer on those routes, or on workspace delete, receives 403 `{ "code": "owner_only", "error": "owner only" }`.

## Egress and closed paths

Headscale is not run by this process. `host/headscale.md` records a single-user config the operator runs, and the Tailscale client already installed by `orgo/bops-base.mjs` joins it. `POST /api/egress-devices` with `{ name }` returns `{ id, name, pairing_code }`. `GET` returns `{ devices, rendezvous }`. `rendezvous` is `BOPS_HEADSCALE_URL`, or null when that variable is unset. Each device's `online` is null. The plane does not probe the tailnet.

`GET /api/computers/{id}/egress/upstream` returns `{ mode, device_id, proxy_on }`. No choice yet is `{ "mode": "residential", "device_id": null, "proxy_on": false }`, which is direct egress. `POST` with `mode: "residential"` stores that direct record and returns 200. `mode: "device"` stores the paired device. `POST /api/computers/{id}/residential-proxy` with `{ enabled: false }` returns 200. `{ enabled: true }` returns 409 `{ "code": "residential_unavailable", "error": "residential unavailable" }`.

`GET /api/projects/{id}/domains` returns `{ "registrar": false, "enabled": false, "domains": [] }`. `POST` purchase returns 501 `{ "code": "not_on_this_plane", "error": "not on this plane" }`.

Every method under `/api/secrets` returns that same 501 body, including list, create, reveal, call, and delete. None of them is 404.

Deploy, logs, rollback, public URL, and custom-domain attach return 404 `{ "code": "DEPLOYS_DISABLED", "error": "deploys disabled" }`.

These paths return 404 `{ "error": "not found" }` and the JSON has no `code` property: the sync families `made-apps-sync`, `orbit-sync`, `access-sync`, `crm-sync`, and `workspace-skills`, including `/api/projects/{id}/crm` and `/api/projects/{id}/skills`. A 501 on those paths would be retried by the app.

`GET /api/workspaces/{id}/delete-preview` returns `computers` as `{ id, name }`, plus `keys`, `skills`, `apps`, `madeApps`, `crmFiles`, `routines`, and `orbitIssues`. Each list this plane does not have is `[]`.

## Uploads

`POST /api/files/uploads` returns 200 `{ upload_url, upload_token }` only when `BOPS_UPLOAD_ORIGIN` is an `https://` origin. `upload_url` is that origin plus `/api/files/uploads/{token}`. Otherwise the response is 409 `{ "code": "upload_needs_https", "error": "upload needs https" }`. `PUT` of the bytes uses the token as the credential and takes no bearer. An unknown token is 404. A body whose length is not `sizeBytes` is 400 `{ "error": "size mismatch" }` and `received` stays false. `POST /api/files/uploads/complete` returns 200 only after `writeFile` has put those bytes at `destPath` in a `running` guest. Complete before the PUT is 409 `{ "error": "incomplete upload" }`.

## Health

`GET /health` is public.

1. The state file exists and is not valid version-1 JSON: 503 `{ "ok": false, "code": "state_unreadable" }`. Do not call `version()`.
2. The file is missing: create empty version 1, then call `version()`.
3. The file is valid, or was just created, and `version()` rejects: 503 `{ "ok": false, "code": "incus_down" }`.
4. Otherwise 200 `{ "ok": true }`.

While the file is `state_unreadable`, or while `version()` rejects, create, resume, and every computer or workspace read return 503 `{ "code": "state_unreadable" | "incus_down", "error": "state unreadable" | "incus down" }` with the matching code. They do not return an empty list or 404.

## Tests

`node --test host/test/` is the suite. New assertions go there. The server under test uses the fake driver.

- A path passed to `call(`, `hostingCall(`, `callOrgo(`, or `postOrgo(` that is missing from `host/routes.md` fails the test. Paths from `call` and `hostingCall` are prefixed with `/api` when the source string does not already start with `/api`. `callOrgo` and `postOrgo` are stored as written. Every row's class is `implement`, `404 no code`, `404 DEPLOYS_DISABLED`, or `501 not_on_this_plane`.
- Missing bearer is 401. `GET /health`, the websockify upgrade, and the upload PUT are not.
- `PUT { runsOn: "cloud" }` then `GET /api/bops/settings` returns `cloud`.
- Create then delete. A second create with the same name is 409.
- Create when `free()` is short of the request is 409 `host_full` and `create` was not called.
- Suspended click is 409 `resume_in_progress` and `input` was not called. Screenshot of `suspended` is 409 `computer_asleep` and `screenshot` was not called.
- Bash with `timeout: 1` resolves a non-zero `exitCode` from the fake's killed exec. The test prints duration. The limit is the client timeout already in `lib/server/orgo.ts`.
- Screenshot bytes from the fake match `format` and `scale`. The test prints duration.
- A due task routine with `onMac: false` starts on `tick`. A routine due within 5 minutes does not idle-suspend. No activity POST does not idle-suspend. `via: "runner"` suspends at 5 minutes. Any other POST suspends at 15 minutes. The test advances `now`.
- Secrets routes named in the plan's task 12 are 501 with an `error` string and are not 404.
- CRM and skills return 404 with no `code`.
- A computer bearer on workspace delete is 403 `owner_only`.
- One process writes a wake time, a second process loads the file, and the wake time matches. A writer overlapped with `tick` leaves one whole `nextRunAt`.
- A missing state file becomes empty version 1. Health is 200 when `version()` resolves, and 503 `incus_down` when it rejects. A corrupt file is 503 `state_unreadable` and is still corrupt afterward.

The README manual check, run on a Linux host with the real driver, is: create a computer, open its screen in the app, run a one-line bash, and confirm the runner log says `auth: key`.

## Docs and profile

`.env.example` comments `BOPS_ORGO_ORIGIN` as the Linux host URL, `BOPS_UPLOAD_ORIGIN` as the https origin the file PUT requires, `BOPS_WEBRTC=0`, and `BOPS_HEADSCALE_URL` as optional. The README section "Run it yourself" names the Linux host, Incus, and Headscale, says Keys and Your Apps are closed on this plane, says a non-loopback bind is unsupported until the operator terminates TLS, and includes a systemd unit snippet. No new required key besides the local `ORGO_API_KEY`.

## Out of scope

- Replacing OpenAI, Codex, Claude Code, Composio, treg, AgentMail, AgentPhone, Twilio, or PostHog.
- Rewriting `lib/server/orgo.ts` or adding a second computer client.
- Bops Cloud, iPhone chat, plans, billing, and a second host.
- The vault broker. Secrets stay 501 until that plan exists.
- Your Apps, Ingot, Caddy, domain purchase, and domain attach.
- WebRTC, a link-local metadata service, and the closed `orgo-relay` binary.
- Running the plane on macOS. Incus is Linux. The Mac app is the client.
- A wall-clock sleep in the unit tests, and a measured p95. Durations printed by a future run are `[measured: host/test output]`. Until then the timeouts are the client's.
