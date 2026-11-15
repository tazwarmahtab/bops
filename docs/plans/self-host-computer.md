<!-- /autoplan restore point: "/Users/tazwarmahtab/Developer/projects/B0P$/bops/.gstack/tmp/autoplan/main-autoplan-restore-20261116-014320.md" -->
# Self-host the Bops computer

Bops already runs self-hosted (`BOPS_SELF_HOSTED=1`) for chat, state, and provider keys. The bots' computers still exist only as Orgo API objects. This plan replaces that computer plane with software we run, without changing what a bot can do on a computer.

Chosen approach: a local control plane that speaks the HTTP API `lib/server/orgo.ts` already calls, backed by Incus. Set `BOPS_ORGO_ORIGIN` to it. Do not rewrite the Orgo client.

Paid networks that have no free equivalent stay: OpenAI, Composio, treg, AgentMail, AgentPhone, Twilio Verify, and domain registration. Replacing those would drop a capability. That is the opposite of this plan.

## Implementation plan

### Outcome

On one Linux host, with `BOPS_SELF_HOSTED=1`, `ORGO_API_KEY` set to a key the local plane accepts, and `BOPS_ORGO_ORIGIN` pointed at that plane:

- The Mac app creates a bot computer (4 vCPU, 16 GB RAM, 80 GB disk, 1280x960, four displays) from the packages and files already listed in `orgo/bops-base.mjs`.
- The app watches each screen through the noVNC path it already has (`BOPS_WEBRTC=0`). Take over still works, because input is the same click, type, and key routes.
- A Cloud routine wakes that computer from the routines payload, stays up while the app says it is in use, and sleeps after the idle window. A stopped computer is not woken.
- Bash, screenshots, Chrome-on-a-screen, Codex `exec-server`, and the runner's key file work as they do on Orgo.
- Deleting a computer deletes that VM and nothing else.

The app binary does not gain a second computer client. If a route the app calls is missing, that feature is broken. The route list is the contract.

### Contract: routes the plane must answer

Source: every fetch whose URL is `BOPS_ORGO_ORIGIN`. `call` and `hostingCall` prefix `/api` (`lib/server/orgo.ts` `base()`). `callOrgo` and `postOrgo` send paths that already start with `/api`. Task 1 freezes every one of those paths into `host/routes.md`. A path with no row fails the test. Each row is `implement` or a closed class named below.

Paths are the full path on the origin.

Computers, all under `/api`:

- `POST /api/computers` with `workspace_id`, `name`, `template_ref`, optional `ram`
- `GET /api/computers/{id}` including `vnc_password`, `status`, `instance_details`, `project_id` or `workspace_id`
- `DELETE /api/computers/{id}`
- `POST /api/computers/{id}/resume` resumes only a `suspended` computer. A `running` one returns 200. Any other status returns 409 and the `error` string contains "not suspended" (`wakeForUser` matches that text, `lib/server/free-hours.ts`).
- `POST /api/computers/{id}/restart`
- `GET /api/computers/{id}/resize` returns `current_disk_gb` and `max_disk_gb`. `max_disk_gb` is the current disk plus the free space the host can add. `PATCH` sends `disk_size_gb`. A stale GET that no longer fits returns 409 `disk_full` with those two numbers.
- `POST /api/computers/{id}/bash` with `command` and `timeout` seconds. The plane kills the guest process when those `timeout` seconds elapse, and returns a non-zero `exit_code` before the client aborts. `lib/server/orgo.ts` gives the command `timeout` seconds and waits 20 more only for the answer (`(timeout + 20) * 1000` ms). Killing at that later deadline means the client has already thrown `OrgoTimeout` and never sees the exit code.
- `POST /api/computers/{id}/click`, `/type`, and `/key`, with `?screen=`
- `GET /api/computers/{id}/screenshot?screen=&response_format=binary&format=&scale=`. `format` is `jpeg` or `png`. Default `jpeg` at `scale` 0.75, matching `lib/server/orgo.ts`. The plane answers within 20 seconds (`SHOT_MS`).
- `GET`, `POST`, and `DELETE /api/computers/{id}/screens`, and `PATCH` the boot screen size
- `POST /api/computers/{id}/clone` copies the Incus instance into the requested workspace
- `POST /api/computers/{instance}/fork` returns 409 `live_fork_unavailable`. `makeOwnComputer` already catches that and calls clone (`lib/server/plan.ts`).
- `GET` and `POST /api/computers/{id}/ssh`
- `POST /api/computers/{id}/webrtc` returns `webrtc: false`. The app stays on VNC.
- `PUT /api/computers/{id}/orgo-key` with no body writes `export ORGO_API_KEY='<computer key>'` to `/root/.orgo-secrets.env` mode 0600. The value is a new computer key, not the account key. The response is `{ keyId }` and does not include the secret. `GET` returns `{ keyId, prefix, name, createdAt, lastUsed, expiresAt }` or 404 `key_not_found`. `DELETE` revokes only that key.
- `POST /api/files/uploads` with `{ desktopId, filename, size_bytes, destPath }` returns 200 `{ upload_url, upload_token }` when `BOPS_UPLOAD_ORIGIN` is an `https://` origin. `upload_url` is that origin plus `/api/files/uploads/{token}`. The plane accepts `PUT` of the bytes there with no bearer. `POST /api/files/uploads/complete` with `{ desktopId, upload_token }` returns 200 only after those bytes are in the guest. If `BOPS_UPLOAD_ORIGIN` is missing or not https, the start POST returns 409 `upload_needs_https`. The client rejects every other scheme (`lib/server/runner-install.ts`, `lib/server/bot-files.ts`).
- `POST /api/bops/computer/size` with `{ size }` returns 200 `{ size, changed: false, restarted: false }` and does not change cpu, ram, or disk. `PATCH /api/computers/{id}/resize` with `{ size }` and no `disk_size_gb` does the same. Plan billing is out of scope.

Status values `GET` returns: `starting`, `running`, `suspending`, `suspended`, `resuming`, `stopped`, `error`. An idle stop is `suspended` (`computerAsleep`). `stopped` and `error` stay down (`computerStaysDown`). A screen read or screenshot of a `suspended` computer returns 409 `computer_asleep` and does not resume it. Bash, click, type, and key on `suspended` start resume, persist `resuming`, and return 409 `resume_in_progress` with `Retry-After`. They do not run in that response. The retry that finds `running` runs the command. `stopped` and `error` return 409 whose `error` text contains "not suspended" and stay down.

Workspaces, one user, under `/api`:

- `GET` and `POST /api/workspaces`, `PATCH /api/workspaces/{id}` for `name` and `bops_ws_id`. A duplicate name is 400 `WORKSPACE_NAME_TAKEN`.
- `GET /api/workspaces/{id}` returns `desktops`
- `GET /api/workspaces/{id}/delete-preview` returns the lists `deletePreview` already reads (`lib/server/orgo.ts`): `computers` as `{ id, name }`, plus `keys`, `skills`, `apps`, `madeApps`, `crmFiles`, `routines`, and `orbitIssues`. Lists this plane does not have are `[]`, not omitted. `POST /api/projects/{id}/delete` deletes that workspace. This preview is for the workspace, not a separate computer-delete dialog
- `GET`, `POST`, `PATCH`, and `DELETE` on `/api/workspaces/{id}/members` and `/api/workspaces/{id}/invite`. A single-user plane returns the owner and accepts the writes as no-ops that still 200.

Identity:

- `GET /api/user/profile` for the bearer. A computer key answers `api_key.scope: "computer"` and `computer_id`. The account key answers as the one local user.
- Do not implement `169.254.169.254`. The runner falls through to the key file when identity is 404 (`docs/cloud-runner.md`).

Screens and pixels:

- Four X displays inside the VM: `:100`, `:101`, `:102`, `:99`, matching `vm/screen_mcp.py`.
- x11vnc plus websockify on each. `GET /api/computers/{id}` returns the VNC password. The app opens that path after replacing a leading `http` with `ws`, so an `https` origin becomes `wss` (`app/api/vnc/route.ts`). A TLS front must upgrade the same path and adds `&screen=` for the other displays (`app/api/vnc/route.ts`). `host/server.ts` upgrades that path, checks `token` against `vnc_password`, and proxies to the guest port reported on resume. No `screen` is display `:99`, screen id `default`. `&screen=` selects `screen-100`, `screen-101`, or `screen-102` (`lib/server/orgo.ts` `screenId`). The socket checks `token`, not the bearer. The request log omits `token`.
- `BOPS_WEBRTC=0`. `BOPS_SCREEN_STREAM` uses that same socket with `?screen=`.

Wake and idle:

- `PUT /api/projects/{id}/routines` is the wake clock (`lib/server/routine-sync.ts`). The plane stores each routine's `nextRunAt`, `onMac`, and `run`. It starts the VM when `onMac` is false, `run` is `task`, `nextRunAt` is due (now or past), and status is not `stopped` or `error`. It does not idle-suspend while such a routine is due within 5 minutes. That 5 is [estimated]: `docs/cloud-runner.md` says the waker runs when the routine comes due, and idle suspend leaves the computer up while one is due within a few minutes.
- `GET`, `DELETE /api/projects/{id}/routines/{routineId}`, `POST` and `GET .../routines/{id}/runs` store and return what those calls send. A missing routine is 404.
- `PUT` and `GET /api/projects/{id}/bops` store the workspace map and return it. They are not the wake clock.
- `POST /api/bops/computer/active` marks the computer in use. On a self-host Mac (`BOPS_SELF_HOSTED=1`), `sayInUse` returns before that POST because `cloudOn()` is false (`lib/server/cloud.ts`, `lib/server/free-hours.ts`). Sign-in, takeover, and the 4-minute Mac beat do not arrive. A guest runner still posts `{ via: "runner" }` when its process does not set `BOPS_SELF_HOSTED`. No POST yet means the plane does not idle-suspend. After a POST with `via: "runner"`, idle is 5 minutes from the last beat. After a POST without `via`, idle is 15 minutes. Idle stop sets `suspended`.

Egress:

- `GET` and `POST /api/egress-devices`, `GET` and `POST /api/computers/{id}/egress/upstream`, `POST /api/computers/{id}/residential-proxy`.
- "Route through this Mac" is Headscale: the VM runs the Tailscale client already installed by `orgo/bops-base.mjs`, joined to a Headscale tailnet, with the Mac as an exit node when the user picks device mode. `POST /api/egress-devices` returns `{ id, name, pairing_code }`. `GET /api/computers/{id}/egress/upstream` returns `{ mode, device_id, proxy_on }`. `POST /api/computers/{id}/residential-proxy` with `{ enabled: false }` returns 200 (`egress.proxyOff`). `{ enabled: true }` returns 409 `residential_unavailable`. `POST /api/computers/{id}/egress/upstream` with `mode: "residential"` records direct egress and returns 200. `mode: "device"` sets the Headscale exit node. Do not ship the closed `orgo-relay` binary.

Apps on the computer:

- Deploy, logs, rollback, public URLs, and custom-domain attach return 404 `DEPLOYS_DISABLED`. `lib/server/orgo.ts` already maps that code to hosting closed. The client deploys an Ingot changeset, and the `ingot` binary is not in this repo. Your Apps is deferred in `TODOS.md`.
- `GET /api/projects/{id}/domains` returns `{ registrar: false, enabled: false, domains: [] }`. Settings closes from that GET (`lib/server/workspace-domains.ts`). `POST /api/projects/{id}/domains` returns 501 `not_on_this_plane`.

Closed paths:

- `GET` and `PUT /api/bops/settings` are `implement`. `GET` returns `{ runsOn }` as `cloud` or `mac`. `PUT { runsOn: "cloud" }` returns 200 and is what `GET` returns afterward. `lib/server/runner.ts` treats 404 or 405 on this route as "bots stay on the Mac", so it is not a closed route. A path the freeze finds that this plan does not implement is a row in `host/routes.md`. Sync families whose callers treat 404 or 405 with no `code` as absent, and retry status >= 500 (`made-apps-sync`, `orbit-sync`, `access-sync`, `crm-sync`, `workspace-skills`), return 404 with no `code`. That includes `/api/projects/{id}/crm` and `/api/projects/{id}/skills`. A 501 on those paths is retried, so they must not use `not_on_this_plane`.
- Every method under `/api/secrets` is `501 not_on_this_plane` with a `code` and an `error` string, including `GET` and `POST /api/secrets`, `POST /api/secrets/reveal`, `POST /api/secrets/call`, and `DELETE /api/secrets/{name}`. None of them is 404. `revealKey` turns a 404 into "that key isn't in your vault" (`lib/server/keys.ts`). The vault broker is deferred in `TODOS.md`. Keys will not work through this plane until that plan exists.

Image:

- An Incus image built from `orgo/bops-base.mjs`: the apt list, Node 24, pinned Codex, pinned Claude Code, `vm/` files, four-screen layout hook. The image build does not call `https://www.orgo.ai/api/templates`.
- `template_ref` on create selects that local image. Unknown refs 400.

Auth and tenancy:

- One account bearer, the value of `ORGO_API_KEY`. No device-code login. Self-host already skips the Orgo sign-in screen when that key is set (README).
- Computer keys are a second secret, minted by `PUT /api/computers/{id}/orgo-key`. Delete of a computer revokes the computer key and leaves the account key.
- Bearer required on every route except `GET /health`, the websockify socket, and `PUT /api/files/uploads/{token}`. That PUT has no `Authorization` header. The token in the path is the credential (`lib/server/runner-install.ts`).
- The plane is single-tenant. It does not speak to Bops Cloud, Stripe, or orgo-web plan tables.
- Listens on `127.0.0.1:8788` when the app is on that same machine. When the Mac is another machine, `BOPS_HOST_ADDR` is the Linux address the Mac can reach, and `BOPS_ORGO_ORIGIN` is that URL. The README example uses the Linux host, not the Mac's loopback.

### Tasks

1. **Route freeze.** A test fails when a path passed to `call(`, `hostingCall(`, `callOrgo(`, or `postOrgo(` is missing from `host/routes.md`. Every row is `implement`, `404 no code`, `404 DEPLOYS_DISABLED`, or `501 not_on_this_plane`. The contract above is the seed.
2. **Incus image.** `host/image/` builds the VM image from `orgo/bops-base.mjs` inputs. `node host/image/build.mjs` on a Linux builder produces an image Incus can launch. Document the Mac-dev case: the plane runs on a Linux box, the Bops app stays on the Mac and points at it.
3. **Plane process.** `host/server.ts`, Node 24, no new dependencies beyond what the repo already has (`package.json`). Bind address is the auth section above. Bearer check on every route except `GET /health`, the websockify socket, and `PUT /api/files/uploads/{token}`. One JSON file under `host/state/` for computers, keys, routines, the workspace map, settings, and wake times. Not SQLite. Not Postgres. Read-modify-write holds an exclusive lock so the wake timer and a PUT cannot drop a `nextRunAt`.
4. **VM lifecycle.** create, resume, restart, resize disk, delete, clone. Clone copies the Incus instance. Fork returns 409 `live_fork_unavailable`. Status values are the contract list. An idle Incus stop is `suspended`, not `stopped`.
5. **Guest agent.** Bash, click, type, and key on `suspended` return 409 `resume_in_progress` and do not exec. `incus exec` runs only while the instance is `running`, on the retry that finds it running. A screenshot does not resume it. The plane kills the exec when the bash or screenshot clock fires. On resume the instance reports each display's VNC port. Screenshot bytes follow `format` and `scale`.
6. **Four screens.** Launch the displays and websockify in the image's resume hook, same layout `bops-screen-layout` already applies. Screen create and delete add or remove a display up to four. The plane proxies `/desktops/{id}/ws/websockify` to the guest port. Screen ids are `default`, `screen-100`, `screen-101`, and `screen-102`.
7. **Runner key file.** `PUT /api/computers/{id}/orgo-key` writes a new computer key, not `ORGO_API_KEY`, into `/root/.orgo-secrets.env` mode 0600. Profile of that key is this computer. Delete revokes that key only.
8. **Wake loop.** Persist `PUT /api/projects/{id}/routines` and `POST /api/bops/computer/active`. The timer starts the VM when a task routine with `onMac` false is due, and it skips `stopped` and `error`. It does not idle-suspend while such a routine is due within 5 minutes. Otherwise it sets `suspended` after the idle window that POST selected. The bops map is stored and never read for `nextRunAt`.
9. **Headscale egress.** Document a Headscale config. Device mode sets the VM's exit node to the paired Mac. The pair route returns a pairing code the existing UI can show. `{ enabled: false }` and upstream `mode: "residential"` return 200. `{ enabled: true }` returns 409 `residential_unavailable`.
10. **Your Apps stays closed.** Deploy, logs, rollback, public URL, and attach-domain return 404 `DEPLOYS_DISABLED`. Do not call Caddy for them in this plan. The client builds from an Ingot changeset, and that binary is not in the repo.
11. **Self-host profile.** `.env.example` comments `BOPS_ORGO_ORIGIN` as the Linux host URL (the Mac's loopback only when the app runs on that same box), `BOPS_UPLOAD_ORIGIN` as the https origin the runner's file PUT requires, and `BOPS_WEBRTC=0`. The README "Run it yourself" section names the Linux host, Incus, and Headscale, and says Keys and Your Apps are closed on this plane. A non-loopback bind is unsupported until the operator terminates TLS in front. The plane does not mint a certificate. No new required key besides the local `ORGO_API_KEY`.
12. **Proof.** `node --test host/test/` covers auth, create/delete, bash, screenshot bytes, wake scheduling, and a missing route. One manual check, written in the README: create a computer, open its screen in the app, run a one-line bash, confirm the runner log says `auth: key`. The same test file asserts `GET` and `POST /api/secrets`, `POST /api/secrets/reveal`, `POST /api/secrets/call`, and `DELETE /api/secrets/{name}` are 501 `not_on_this_plane` with an `error` string, and are not 404. Bash and screenshot tests also assert the call ends by the timeout `lib/server/orgo.ts` already uses, and they print duration. No separate millisecond SLA until a guest has been measured. Mark any number from that run `[measured: host/test output]`. Until then the timeout is `[estimated]` from the existing client.
13. **Health and request log.** `GET /health` returns 200 when the state file is missing or readable and Incus answers `incus version` (or the configured binary). A missing file is created empty first. A file that exists and cannot be read or parsed is 503 `state_unreadable`. Incus not answering, after the file is readable, is 503 `incus_down`. Every request logs one line: method, path, status, milliseconds, and computer id when the path has one. Never log the bearer, bash command text, key file contents, screenshot bytes, the websockify `token`, or the upload token. The upload PUT's path contains that token, so the log line uses the route template, not the raw path.
14. **Restart-safe state.** The state file is replaced atomically (write temp, fsync, rename) under the exclusive lock from task 3. A missing file is empty state and is created the same way. Boot reloads computers, keys, routines, the workspace map, settings, and wake times from it. A plane crash mid-write leaves the previous file. A test kills nothing. It writes, reloads in a second process, and checks the wake time is the same. A second test overlaps a writer and the timer and checks one `nextRunAt` survives whole.

### NOT in scope

- Replacing OpenAI, Codex, Claude Code, Composio, treg, AgentMail, AgentPhone, Twilio, or PostHog.
- Bops Cloud, iPhone chat, plans, AI credit, and multi-user Orgo accounts.
- Domain purchasing and DNS hosting. `GET /api/projects/{id}/domains` returns `registrar: false`. Attach and Let's Encrypt wait with Your Apps, because deploy is closed.
- The closed `ingot` and `orgo-relay` binaries. App repos keep using git. Home-IP routing uses Headscale.
- WebRTC UDP streaming. VNC is the supported live view.
- A fake link-local metadata service. Key-file auth is the supported runner login.
- Running the plane on macOS. Incus is Linux. The Mac app is the client.

### What already exists

- `BOPS_ORGO_ORIGIN` and `BOPS_SELF_HOSTED=1` (`lib/server/orgo-auth.ts`, README).
- The guest userspace: `vm/`, `orgo/bops-base.mjs`.
- noVNC in the app (`@novnc/novnc`, `app/api/vnc`).
- Runner key-file fallback (`lib/server/runner-key.ts`, `docs/cloud-runner.md`).
- Self-host state in `.data/`, so this plan does not add Postgres.
- Headscale is the open-source control server for the Tailscale client the image already installs.

### Failure modes the plane must not hide

- Incus down or an unreadable state file: create, resume, and every computer or workspace read return 503 `incus_down` or `state_unreadable`. They do not return an empty list or 404.
- Disk grow past the host's free space: `GET /api/computers/{id}/resize` reports `current_disk_gb` and `max_disk_gb`. `PATCH` returns 409 `disk_full` with those numbers when the host shrank since the GET. `growDisk` reads the GET, then PATCHes (`lib/server/orgo.ts`).
- Bash over time: the HTTP call ends, the guest process is killed, exit code is non-zero.
- Two `POST /api/computers` with one name: the second returns 409. A duplicate workspace name stays 400 `WORKSPACE_NAME_TAKEN`. Create or clone that needs more RAM or disk than the host has free returns 409 `host_full` with the free RAM and free disk.
- Delete of an unknown id: 404.
- A bearer that is not the account key or a live computer key: 401.
- A computer key calling workspace delete or member routes: 403.

### Verification

- `node --test host/test/`
- `npx tsc --noEmit -p .` still passes. The plane is plain TypeScript Node runs directly, same constraint as `cloud/server.ts` (erasable syntax, relative imports, no Next).
- The route-freeze test is part of `host/test/`.


<!-- autoplan-accepted:ceo -->
- GET /health returns 200 when the state file is missing or readable and Incus answers version. A missing file is created empty. A file that exists and cannot be read is 503 state_unreadable. Incus not answering after a readable file is 503 incus_down. Each request logs method, path, status, milliseconds, and computer id. The log omits bearer, bash text, key file, screenshot bytes, the websockify token, and the upload token. The upload PUT is logged as a route template (task 13).
- The state file is written by temp, fsync, and rename under an exclusive lock. A missing file is empty state. Boot reloads computers, keys, routines, the workspace map, settings, and wake times. A second process in host/test sees the same wake time, and an overlapping writer leaves one nextRunAt whole (task 14).
- Bash and screenshot tests fail when they miss the timeout already in lib/server/orgo.ts, and they print duration. No separate millisecond SLA (task 12).
- Domain purchase stays unimplemented. GET /api/projects/{id}/domains returns registrar false and enabled false. POST /api/projects/{id}/domains returns 501 not_on_this_plane.
- OpenAI, Composio, treg, AgentMail, AgentPhone, and Twilio stay as they are.
- Live view is VNC with BOPS_WEBRTC=0. Egress is Headscale. Runner auth is the key file.
- GET and PUT /api/bops/settings are implemented. PUT runsOn cloud is what GET returns afterward.
- Bash, click, type, and key on suspended return 409 resume_in_progress with Retry-After and do not run in that response. The retry that finds running runs the command. Screenshot of suspended stays 409 computer_asleep.
- The plane proxies /desktops/{id}/ws/websockify and checks the token. Screen ids are default, screen-100, screen-101, and screen-102.
- PUT /api/computers/{id}/orgo-key returns { keyId } and writes export ORGO_API_KEY= of a new computer key.
- max_disk_gb is the current disk plus the space the host can add. Create or clone that does not fit returns 409 host_full with free RAM and free disk.
- A non-loopback bind is unsupported until the operator terminates TLS. The README says Keys and Your Apps are closed on this plane.
- POST /api/files/uploads returns an https upload_url only when BOPS_UPLOAD_ORIGIN is https. Otherwise it returns 409 upload_needs_https. complete returns 200 only after the bytes are in the guest.
- POST /api/bops/computer/size and PATCH resize with size and no disk_size_gb return 200 and leave cpu, ram, and disk unchanged.
- POST /api/egress-devices returns pairing_code. GET upstream returns mode, device_id, and proxy_on.
<!-- /autoplan-accepted:ceo -->
## Review record

Decisions made before review, because the user said to lead:

- Routing rules appended to `CLAUDE.md` (the recommended setup option).
- `/office-hours` skipped. The problem, the constraint (no capability drop), and the approach (speak the existing Orgo API, Incus underneath) were already fixed in the dependency pass. A second interview would re-ask them.
- Office-hours skip is a coverage cut: the plan has no separate premise interview. Upgrade if a reviewer cannot name the user or the job to be done from this file.
- 2026-11-16 CEO selective expansion. Decisions 7–11. Health, atomic state, and the existing timeout test are in scope. Second host is in `TODOS.md`. No pull request exists, so CI watch does not apply. No review comments exist, so nothing was implemented from a review. No load test was run. The timeout assertion is a unit gate, not a capacity claim.

### Accepted obligations

<!-- autoplan-accepted:ceo -->
- GET /health returns 200 when the state file is missing or readable and Incus answers version. A missing file is created empty. A file that exists and cannot be read is 503 state_unreadable. Incus not answering after a readable file is 503 incus_down. Each request logs method, path, status, milliseconds, and computer id. The log omits bearer, bash text, key file, screenshot bytes, the websockify token, and the upload token. The upload PUT is logged as a route template (task 13).
- The state file is written by temp, fsync, and rename under an exclusive lock. A missing file is empty state. Boot reloads computers, keys, routines, the workspace map, settings, and wake times. A second process in host/test sees the same wake time, and an overlapping writer leaves one nextRunAt whole (task 14).
- Bash and screenshot tests fail when they miss the timeout already in lib/server/orgo.ts, and they print duration. No separate millisecond SLA (task 12).
- Domain purchase stays unimplemented. GET /api/projects/{id}/domains returns registrar false and enabled false. POST /api/projects/{id}/domains returns 501 not_on_this_plane.
- OpenAI, Composio, treg, AgentMail, AgentPhone, and Twilio stay as they are.
- Live view is VNC with BOPS_WEBRTC=0. Egress is Headscale. Runner auth is the key file.
- GET and PUT /api/bops/settings are implemented. PUT runsOn cloud is what GET returns afterward.
- Bash, click, type, and key on suspended return 409 resume_in_progress with Retry-After and do not run in that response. The retry that finds running runs the command. Screenshot of suspended stays 409 computer_asleep.
- The plane proxies /desktops/{id}/ws/websockify and checks the token. Screen ids are default, screen-100, screen-101, and screen-102.
- PUT /api/computers/{id}/orgo-key returns { keyId } and writes export ORGO_API_KEY= of a new computer key.
- max_disk_gb is the current disk plus the space the host can add. Create or clone that does not fit returns 409 host_full with free RAM and free disk.
- A non-loopback bind is unsupported until the operator terminates TLS. The README says Keys and Your Apps are closed on this plane.
- POST /api/files/uploads returns an https upload_url only when BOPS_UPLOAD_ORIGIN is https. Otherwise it returns 409 upload_needs_https. complete returns 200 only after the bytes are in the guest.
- POST /api/bops/computer/size and PATCH resize with size and no disk_size_gb return 200 and leave cpu, ram, and disk unchanged.
- POST /api/egress-devices returns pairing_code. GET upstream returns mode, device_id, and proxy_on.
<!-- /autoplan-accepted:ceo -->

<!-- autoplan-baseline-edits:ceo {"sourceSha256":"6c164a1d606153c8d46d48a513a8e0ffe16b3ef8d36703e76894e297955956ff","replacements":[{"oldText":"### Contract: routes the plane must answer\n\nSource: `lib/server/orgo.ts` call sites, plus the profile check the runner uses to decide a key belongs to this computer (`lib/server/orgo-auth.ts`). Task 1 freezes this list as a test so a new call site fails until the plane handles it.\n\nComputers:\n\n- `POST /computers` with `workspace_id`, `name`, `template_ref`, optional `ram`\n- `GET /computers/{id}` including `vnc_password`, `status`, `instance_details`, `project_id` or `workspace_id`\n- `DELETE /computers/{id}`\n- `POST /computers/{id}/resume`\n- `POST /computers/{id}/restart`\n- `GET /computers/{id}/resize` and `PATCH` for `disk_size_gb` and plan `size`\n- `POST /computers/{id}/bash`\n- `POST /computers/{id}/click|type|key?screen=`\n- `GET /computers/{id}/screenshot?screen=&response_format=binary`\n- `GET|POST|DELETE /computers/{id}/screens` and `PATCH` the boot screen size\n- `POST /computers/{id}/clone` and `POST /computers/{instance}/fork`\n- `GET|POST /computers/{id}/ssh`\n- `POST /computers/{id}/webrtc` may no-op and return `webrtc: false`. The app then stays on VNC.\n\nWorkspaces, one user:\n\n- `GET|POST /workspaces`, `PATCH /workspaces/{id}` for `name` and `bops_ws_id`\n- `GET /workspaces/{id}` returns `desktops`\n- `GET /workspaces/{id}/delete-preview` and `POST /projects/{id}/delete`\n- Member routes the app already calls on `/workspaces/{id}/members` and `/invite`. A single-user plane returns the owner and accepts the writes as no-ops that still 200.\n\nIdentity:\n\n- `GET /api/user/profile` for the bearer key. A computer key answers as that computer (`api_key.scope: \"computer\"`, `computer_id`). An account key answers as the one local user.\n- Do not implement `169.254.169.254` in the first cut. The runner already falls through to `/root/.orgo-secrets.env` when identity is 404 (`docs/cloud-runner.md`). The plane writes that file at create, mode 0600, and revokes the key on delete.\n\nScreens and pixels:\n\n- Four X displays inside the VM: `:100`, `:101`, `:102`, `:99`, matching `vm/screen_mcp.py`.\n- x11vnc plus websockify on each. `GET /computers/{id}` returns the VNC password the app already hands only to the local window.\n- `BOPS_WEBRTC=0` and `BOPS_SCREEN_STREAM` left to the plane's own websocket proxy with `?screen=`, because that is the path `lib/server/orgo.ts` already documents for non-tailnet screens.\n\nWake:\n\n- The Mac already tells Orgo each routine's next time (`PUT /api/projects/{id}/bops` in `docs/cloud-runner.md`). The plane stores that and starts the VM when a run is due, then lets Incus stop it after the idle window the app already sends (`via: 'runner'`).\n\nEgress:\n\n- `GET|POST /egress-devices`, `GET|POST /computers/{id}/egress/upstream`, `POST /computers/{id}/residential-proxy`.\n- \"Route through this Mac\" is Headscale: the VM runs the Tailscale client already installed by `orgo/bops-base.mjs`, joined to a Headscale tailnet, with the Mac as an exit node when the user picks device mode. Residential-proxy mode returns a clear 409 until a later plan. Do not ship the closed `orgo-relay` binary. It is not in this repo.\n\nApps on the computer:\n\n- Deploy projects, public URLs, logs, rollback, and custom-domain attach (`/computers/{id}/deploy-projects`, `/public-urls`, `/domains`) are in this plan. They are Caddy on the host, one site per port, Let's Encrypt when the name already points here.\n- Domain purchase (`POST /projects/{id}/domains` with a registrant and a price) stays unimplemented and returns the same closed shape the app already handles when `registrar` is false (`lib/server/workspace-domains.ts`). Buying a name is a registry fee, not a missing server.\n\nImage:\n\n- An Incus image built from `orgo/bops-base.mjs`: the apt list, Node 24, pinned Codex, pinned Claude Code, `vm/` files, four-screen layout hook. The image build does not call `https://www.orgo.ai/api/templates`.\n- `template_ref` on create selects that local image. Unknown refs 400.\n\nAuth and tenancy:\n\n- One bearer key in the plane's config, the value of `ORGO_API_KEY`. No device-code login. Self-host already skips the Orgo sign-in screen when that key is set (README).\n- The plane is single-tenant. It does not speak to Bops Cloud, Stripe, or orgo-web plan tables.\n\n","newText":"### Contract: routes the plane must answer\n\nSource: every fetch whose URL is `BOPS_ORGO_ORIGIN`. `call` and `hostingCall` prefix `/api` (`lib/server/orgo.ts` `base()`). `callOrgo` and `postOrgo` send paths that already start with `/api`. Task 1 freezes every one of those paths into `host/routes.md`. A path with no row fails the test. Each row is `implement` or a closed class named below.\n\nPaths are the full path on the origin.\n\nComputers, all under `/api`:\n\n- `POST /api/computers` with `workspace_id`, `name`, `template_ref`, optional `ram`\n- `GET /api/computers/{id}` including `vnc_password`, `status`, `instance_details`, `project_id` or `workspace_id`\n- `DELETE /api/computers/{id}`\n- `POST /api/computers/{id}/resume` resumes only a `suspended` computer. A `running` one returns 200. Any other status returns 409 and the `error` string contains \"not suspended\" (`wakeForUser` matches that text, `lib/server/free-hours.ts`).\n- `POST /api/computers/{id}/restart`\n- `GET /api/computers/{id}/resize` returns `current_disk_gb` and `max_disk_gb`. `max_disk_gb` is the current disk plus the free space the host can add. `PATCH` sends `disk_size_gb`. A stale GET that no longer fits returns 409 `disk_full` with those two numbers.\n- `POST /api/computers/{id}/bash` with `command` and `timeout` seconds. The plane kills the guest process at `(timeout + 20) * 1000` ms, then returns a non-zero `exit_code`.\n- `POST /api/computers/{id}/click`, `/type`, and `/key`, with `?screen=`\n- `GET /api/computers/{id}/screenshot?screen=&response_format=binary&format=&scale=`. `format` is `jpeg` or `png`. Default `jpeg` at `scale` 0.75, matching `lib/server/orgo.ts`. The plane answers within 20 seconds (`SHOT_MS`).\n- `GET`, `POST`, and `DELETE /api/computers/{id}/screens`, and `PATCH` the boot screen size\n- `POST /api/computers/{id}/clone` copies the Incus instance into the requested workspace\n- `POST /api/computers/{instance}/fork` returns 409 `live_fork_unavailable`. `makeOwnComputer` already catches that and calls clone (`lib/server/plan.ts`).\n- `GET` and `POST /api/computers/{id}/ssh`\n- `POST /api/computers/{id}/webrtc` returns `webrtc: false`. The app stays on VNC.\n- `PUT /api/computers/{id}/orgo-key` with no body writes `export ORGO_API_KEY='<computer key>'` to `/root/.orgo-secrets.env` mode 0600. The value is a new computer key, not the account key. The response is `{ keyId }` and does not include the secret. `GET` returns `{ keyId, prefix, name, createdAt, lastUsed, expiresAt }` or 404 `key_not_found`. `DELETE` revokes only that key.\n- `POST /api/files/uploads` with `{ desktopId, filename, size_bytes, destPath }` returns 200 `{ upload_url, upload_token }` when `BOPS_UPLOAD_ORIGIN` is an `https://` origin. `upload_url` is that origin plus `/api/files/uploads/{token}`. The plane accepts `PUT` of the bytes there with no bearer. `POST /api/files/uploads/complete` with `{ desktopId, upload_token }` returns 200 only after those bytes are in the guest. If `BOPS_UPLOAD_ORIGIN` is missing or not https, the start POST returns 409 `upload_needs_https`. The client rejects every other scheme (`lib/server/runner-install.ts`, `lib/server/bot-files.ts`).\n- `POST /api/bops/computer/size` with `{ size }` returns 200 `{ size, changed: false, restarted: false }` and does not change cpu, ram, or disk. `PATCH /api/computers/{id}/resize` with `{ size }` and no `disk_size_gb` does the same. Plan billing is out of scope.\n\nStatus values `GET` returns: `starting`, `running`, `suspending`, `suspended`, `resuming`, `stopped`, `error`. An idle stop is `suspended` (`computerAsleep`). `stopped` and `error` stay down (`computerStaysDown`). A screen read or screenshot of a `suspended` computer returns 409 `computer_asleep` and does not resume it. Bash, click, type, and key on `suspended` start resume, persist `resuming`, and return 409 `resume_in_progress` with `Retry-After`. They do not run in that response. The retry that finds `running` runs the command. `stopped` and `error` return 409 whose `error` text contains \"not suspended\" and stay down.\n\nWorkspaces, one user, under `/api`:\n\n- `GET` and `POST /api/workspaces`, `PATCH /api/workspaces/{id}` for `name` and `bops_ws_id`. A duplicate name is 400 `WORKSPACE_NAME_TAKEN`.\n- `GET /api/workspaces/{id}` returns `desktops`\n- `GET /api/workspaces/{id}/delete-preview` returns the lists `deletePreview` already reads (`lib/server/orgo.ts`): `computers` as `{ id, name }`, plus `keys`, `skills`, `apps`, `madeApps`, `crmFiles`, `routines`, and `orbitIssues`. Lists this plane does not have are `[]`, not omitted. `POST /api/projects/{id}/delete` deletes that workspace. This preview is for the workspace, not a separate computer-delete dialog\n- `GET`, `POST`, `PATCH`, and `DELETE` on `/api/workspaces/{id}/members` and `/api/workspaces/{id}/invite`. A single-user plane returns the owner and accepts the writes as no-ops that still 200.\n\nIdentity:\n\n- `GET /api/user/profile` for the bearer. A computer key answers `api_key.scope: \"computer\"` and `computer_id`. The account key answers as the one local user.\n- Do not implement `169.254.169.254`. The runner falls through to the key file when identity is 404 (`docs/cloud-runner.md`).\n\nScreens and pixels:\n\n- Four X displays inside the VM: `:100`, `:101`, `:102`, `:99`, matching `vm/screen_mcp.py`.\n- x11vnc plus websockify on each. `GET /api/computers/{id}` returns the VNC password. The app opens that path after replacing a leading `http` with `ws`, so an `https` origin becomes `wss` (`app/api/vnc/route.ts`). A TLS front must upgrade the same path and adds `&screen=` for the other displays (`app/api/vnc/route.ts`). `host/server.ts` upgrades that path, checks `token` against `vnc_password`, and proxies to the guest port reported on resume. No `screen` is display `:99`, screen id `default`. `&screen=` selects `screen-100`, `screen-101`, or `screen-102` (`lib/server/orgo.ts` `screenId`). The socket checks `token`, not the bearer. The request log omits `token`.\n- `BOPS_WEBRTC=0`. `BOPS_SCREEN_STREAM` uses that same socket with `?screen=`.\n\nWake and idle:\n\n- `PUT /api/projects/{id}/routines` is the wake clock (`lib/server/routine-sync.ts`). The plane stores each routine's `nextRunAt`, `onMac`, and `run`. It starts the VM when `onMac` is false, `run` is `task`, `nextRunAt` is due (now or past), and status is not `stopped` or `error`. It does not idle-suspend while such a routine is due within 5 minutes. That 5 is [estimated]: `docs/cloud-runner.md` says the waker runs when the routine comes due, and idle suspend leaves the computer up while one is due within a few minutes.\n- `GET`, `DELETE /api/projects/{id}/routines/{routineId}`, `POST` and `GET .../routines/{id}/runs` store and return what those calls send. A missing routine is 404.\n- `PUT` and `GET /api/projects/{id}/bops` store the workspace map and return it. They are not the wake clock.\n- `POST /api/bops/computer/active` marks the computer in use. No such POST yet means the plane does not idle-suspend (the app comment in `lib/server/free-hours.ts`). After a POST with `via: \"runner\"`, idle is 5 minutes from the last beat. After a POST without `via`, idle is 15 minutes. Idle stop sets `suspended`.\n\nEgress:\n\n- `GET` and `POST /api/egress-devices`, `GET` and `POST /api/computers/{id}/egress/upstream`, `POST /api/computers/{id}/residential-proxy`.\n- \"Route through this Mac\" is Headscale: the VM runs the Tailscale client already installed by `orgo/bops-base.mjs`, joined to a Headscale tailnet, with the Mac as an exit node when the user picks device mode. `POST /api/egress-devices` returns `{ id, name, pairing_code }`. `GET /api/computers/{id}/egress/upstream` returns `{ mode, device_id, proxy_on }`. `POST /api/computers/{id}/residential-proxy` with `{ enabled: false }` returns 200 (`egress.proxyOff`). `{ enabled: true }` returns 409 `residential_unavailable`. `POST /api/computers/{id}/egress/upstream` with `mode: \"residential\"` records direct egress and returns 200. `mode: \"device\"` sets the Headscale exit node. Do not ship the closed `orgo-relay` binary.\n\nApps on the computer:\n\n- Deploy, logs, rollback, public URLs, and custom-domain attach return 404 `DEPLOYS_DISABLED`. `lib/server/orgo.ts` already maps that code to hosting closed. The client deploys an Ingot changeset, and the `ingot` binary is not in this repo. Your Apps is deferred in `TODOS.md`.\n- `GET /api/projects/{id}/domains` returns `{ registrar: false, enabled: false, domains: [] }`. Settings closes from that GET (`lib/server/workspace-domains.ts`). `POST /api/projects/{id}/domains` returns 501 `not_on_this_plane`.\n\nClosed paths:\n\n- `GET` and `PUT /api/bops/settings` are `implement`. `GET` returns `{ runsOn }` as `cloud` or `mac`. `PUT { runsOn: \"cloud\" }` returns 200 and is what `GET` returns afterward. `lib/server/runner.ts` treats 404 or 405 on this route as \"bots stay on the Mac\", so it is not a closed route. A path the freeze finds that this plan does not implement is a row in `host/routes.md`. Sync families whose callers treat 404 or 405 with no `code` as absent (`made-apps-sync`, `orbit-sync`, `access-sync`) return 404 with no `code`. A 501 on those paths is retried, so they must not use `not_on_this_plane`.\n- Every method under `/api/secrets` is `501 not_on_this_plane` with a `code` and an `error` string, including `GET` and `POST /api/secrets`, `POST /api/secrets/reveal`, `POST /api/secrets/call`, and `DELETE /api/secrets/{name}`. None of them is 404. `revealKey` turns a 404 into \"that key isn't in your vault\" (`lib/server/keys.ts`). The vault broker is deferred in `TODOS.md`. Keys will not work through this plane until that plan exists.\n\nImage:\n\n- An Incus image built from `orgo/bops-base.mjs`: the apt list, Node 24, pinned Codex, pinned Claude Code, `vm/` files, four-screen layout hook. The image build does not call `https://www.orgo.ai/api/templates`.\n- `template_ref` on create selects that local image. Unknown refs 400.\n\nAuth and tenancy:\n\n- One account bearer, the value of `ORGO_API_KEY`. No device-code login. Self-host already skips the Orgo sign-in screen when that key is set (README).\n- Computer keys are a second secret, minted by `PUT /api/computers/{id}/orgo-key`. Delete of a computer revokes the computer key and leaves the account key.\n- Bearer required on every route except `GET /health` and the websockify socket.\n- The plane is single-tenant. It does not speak to Bops Cloud, Stripe, or orgo-web plan tables.\n- Listens on `127.0.0.1:8788` when the app is on that same machine. When the Mac is another machine, `BOPS_HOST_ADDR` is the Linux address the Mac can reach, and `BOPS_ORGO_ORIGIN` is that URL. The README example uses the Linux host, not the Mac's loopback.\n\n"},{"oldText":"- A routine due while the Mac is set to Cloud wakes that computer, runs, and the computer can sleep again.","newText":"- A Cloud routine wakes that computer from the routines payload, stays up while the app says it is in use, and sleeps after the idle window. A stopped computer is not woken."},{"oldText":"1. **Route freeze.** A test reads `lib/server/orgo.ts` and fails when a `call(` or `hostingCall(` path is not listed in `host/routes.md`. The list above is the seed. Add any path the test finds, including skill sync and vault name routes if they live outside `orgo.ts`.","newText":"1. **Route freeze.** A test fails when a path passed to `call(`, `hostingCall(`, `callOrgo(`, or `postOrgo(` is missing from `host/routes.md`. Every row is `implement`, `404 no code`, `404 DEPLOYS_DISABLED`, or `501 not_on_this_plane`. The contract above is the seed."},{"oldText":"3. **Plane process.** `host/server.ts`, Node 24, no new dependencies beyond what the repo already has (`package.json`). Listens on `127.0.0.1:8788` unless `BOPS_HOST_ADDR` is set. Bearer check on every route. SQLite or a JSON file under `host/state/` for computers, keys, and wake times. Not Postgres. Hosted Bops already has Postgres. This plane is the self-host computer, and a file is enough for one user.","newText":"3. **Plane process.** `host/server.ts`, Node 24, no new dependencies beyond what the repo already has (`package.json`). Bind address is the auth section above. Bearer check on every route except `GET /health` and the websockify socket. One JSON file under `host/state/` for computers, keys, routines, the workspace map, settings, and wake times. Not SQLite. Not Postgres. Read-modify-write holds an exclusive lock so the wake timer and a PUT cannot drop a `nextRunAt`."},{"oldText":"4. **VM lifecycle.** create, resume, restart, resize disk, delete, clone. Clone is a copy of the Incus instance. Fork is clone into a workspace id. Status values the app already branches on: stopped, starting, running.","newText":"4. **VM lifecycle.** create, resume, restart, resize disk, delete, clone. Clone copies the Incus instance. Fork returns 409 `live_fork_unavailable`. Status values are the contract list. An idle Incus stop is `suspended`, not `stopped`."},{"oldText":"5. **Guest agent.** A small process in the image that runs bash, xdotool click/type/key, and PNG screenshot per display, and reports VNC ports. The plane proxies the HTTP routes to it. Timeout behavior matches `orgo.ts` (bash timeout plus 20s).","newText":"5. **Guest agent.** Bash, click, type, and key on `suspended` return 409 `resume_in_progress` and do not exec. `incus exec` runs only while the instance is `running`, on the retry that finds it running. A screenshot does not resume it. The plane kills the exec when the bash or screenshot clock fires. On resume the instance reports each display's VNC port. Screenshot bytes follow `format` and `scale`."},{"oldText":"7. **Runner key file.** On create, write `ORGO_API_KEY` into `/root/.orgo-secrets.env` as the runner already parses it. Profile says that key is this computer's. Delete revokes it.","newText":"7. **Runner key file.** `PUT /api/computers/{id}/orgo-key` writes a new computer key, not `ORGO_API_KEY`, into `/root/.orgo-secrets.env` mode 0600. Profile of that key is this computer. Delete revokes that key only."},{"oldText":"8. **Wake loop.** Persist `PUT /api/projects/{id}/bops`. A timer starts the matching VM before the next due routine and stops it after the idle window.","newText":"8. **Wake loop.** Persist `PUT /api/projects/{id}/routines` and `POST /api/bops/computer/active`. The timer starts the VM when a task routine with `onMac` false is due, and it skips `stopped` and `error`. It does not idle-suspend while such a routine is due within 5 minutes. Otherwise it sets `suspended` after the idle window that POST selected. The bops map is stored and never read for `nextRunAt`."},{"oldText":"11. **Self-host profile.** `.env.example` gains commented `BOPS_ORGO_ORIGIN=http://127.0.0.1:8788` and `BOPS_WEBRTC=0`, with a paragraph in the README \"Run it yourself\" section that names the Linux host, Incus, and Headscale. No new required key besides the local `ORGO_API_KEY`.","newText":"11. **Self-host profile.** `.env.example` comments `BOPS_ORGO_ORIGIN` as the Linux host URL (the Mac's loopback only when the app runs on that same box), `BOPS_UPLOAD_ORIGIN` as the https origin the runner's file PUT requires, and `BOPS_WEBRTC=0`. The README \"Run it yourself\" section names the Linux host, Incus, and Headscale, and says Keys and Your Apps are closed on this plane. A non-loopback bind is unsupported until the operator terminates TLS in front. The plane does not mint a certificate. No new required key besides the local `ORGO_API_KEY`."},{"oldText":"- Disk grow past the host's free space: 409 with the current and max gigabytes, the shape `growDisk` already reads.","newText":"- Disk grow past the host's free space: `GET /api/computers/{id}/resize` reports `current_disk_gb` and `max_disk_gb`. `PATCH` returns 409 `disk_full` with those numbers when the host shrank since the GET. `growDisk` reads the GET, then PATCHes (`lib/server/orgo.ts`)."},{"oldText":"9. **Headscale egress.** Document a Headscale config. Device mode sets the VM's exit node to the paired Mac. The pair route returns a pairing code the existing UI can show. Residential mode returns 409 with a stable `code`.","newText":"9. **Headscale egress.** Document a Headscale config. Device mode sets the VM's exit node to the paired Mac. The pair route returns a pairing code the existing UI can show. `{ enabled: false }` and upstream `mode: \"residential\"` return 200. `{ enabled: true }` returns 409 `residential_unavailable`."},{"oldText":"13. **Health and request log.** `GET /health` returns 200 when the plane can read its state file and Incus answers `incus version` (or the configured binary). Any other state is 503 with a `code`. Every request logs one line: method, path, status, milliseconds, and computer id when the path has one. Never log the bearer, bash command text, key file contents, or screenshot bytes.","newText":"13. **Health and request log.** `GET /health` returns 200 when the state file is missing or readable and Incus answers `incus version` (or the configured binary). A missing file is created empty first. A file that exists and cannot be read or parsed is 503 `state_unreadable`. Incus not answering, after the file is readable, is 503 `incus_down`. Every request logs one line: method, path, status, milliseconds, and computer id when the path has one. Never log the bearer, bash command text, key file contents, screenshot bytes, or the websockify `token`."},{"oldText":"14. **Restart-safe state.** The state file is replaced atomically (write temp, fsync, rename). Boot reloads computers, keys, and wake times from it. A plane crash mid-write leaves the previous file. A test kills nothing. It writes, reloads in a second process, and checks the wake time is the same.","newText":"14. **Restart-safe state.** The state file is replaced atomically (write temp, fsync, rename) under the exclusive lock from task 3. A missing file is empty state and is created the same way. Boot reloads computers, keys, routines, the workspace map, settings, and wake times from it. A plane crash mid-write leaves the previous file. A test kills nothing. It writes, reloads in a second process, and checks the wake time is the same. A second test overlaps a writer and the timer and checks one `nextRunAt` survives whole."},{"oldText":"10. **Caddy for Your Apps.** Deploy, logs, rollback, public URL, and attach-domain call the host Caddy admin API. Preview passwords are Caddy basic auth. Password GET returns the current password to the owner's Bops only, as today.","newText":"10. **Your Apps stays closed.** Deploy, logs, rollback, public URL, and attach-domain return 404 `DEPLOYS_DISABLED`. Do not call Caddy for them in this plan. The client builds from an Ingot changeset, and that binary is not in the repo."},{"oldText":"One manual check, written in the README: create a computer, open its screen in the app, run a one-line bash, confirm the runner log says `auth: key`.","newText":"One manual check, written in the README: create a computer, open its screen in the app, run a one-line bash, confirm the runner log says `auth: key`. The same test file asserts `GET` and `POST /api/secrets`, `POST /api/secrets/reveal`, `POST /api/secrets/call`, and `DELETE /api/secrets/{name}` are 501 `not_on_this_plane` with an `error` string, and are not 404."},{"oldText":"- Domain purchasing and DNS hosting for names we do not already control. Attach and Let's Encrypt for a name the user already pointed here is in scope.","newText":"- Domain purchasing and DNS hosting. `GET /api/projects/{id}/domains` returns `registrar: false`. Attach and Let's Encrypt wait with Your Apps, because deploy is closed."},{"oldText":"6. **Four screens.** Launch the displays and websockify in the image's resume hook, same layout `bops-screen-layout` already applies. Screen create and delete add or remove a display up to four.","newText":"6. **Four screens.** Launch the displays and websockify in the image's resume hook, same layout `bops-screen-layout` already applies. Screen create and delete add or remove a display up to four. The plane proxies `/desktops/{id}/ws/websockify` to the guest port. Screen ids are `default`, `screen-100`, `screen-101`, and `screen-102`."},{"oldText":"- Two creates at once for one name: the second 409s.","newText":"- Two `POST /api/computers` with one name: the second returns 409. A duplicate workspace name stays 400 `WORKSPACE_NAME_TAKEN`. Create or clone that needs more RAM or disk than the host has free returns 409 `host_full` with the free RAM and free disk."}]} -->
<!-- autoplan-baseline-edits:design {"sourceSha256":"a38375cf2c9d7b563d11325482fcd8e3652f3ef757ac9678b48fdaa7239aed59","replacements":[{"oldText":"The app opens `ws://{origin}/desktops/{id}/ws/websockify?token={password}`","newText":"The app opens that path after replacing a leading `http` with `ws`, so an `https` origin becomes `wss` (`app/api/vnc/route.ts`). A TLS front must upgrade the same path"},{"oldText":"`POST /api/bops/computer/active` marks the computer in use. No such POST yet means the plane does not idle-suspend (the app comment in `lib/server/free-hours.ts`). After a POST with `via: \"runner\"`, idle is 5 minutes from the last beat. After a POST without `via`, idle is 15 minutes.","newText":"`POST /api/bops/computer/active` marks the computer in use. The app already posts it on sign-in, when a takeover or a cloud task starts, and every 4 minutes while that continues (`EVERY_MS` in `lib/server/free-hours.ts`). No such POST yet means the plane does not idle-suspend. After a POST with `via: \"runner\"`, idle is 5 minutes from the last beat. After a POST without `via`, idle is 15 minutes."},{"oldText":"- Incus down: create and resume return 503, not an empty computer id.","newText":"- Incus down or an unreadable state file: create, resume, and every computer or workspace read return 503 `incus_down` or `state_unreadable`. They do not return an empty list or 404."},{"oldText":"- `GET /api/workspaces/{id}/delete-preview` and `POST /api/projects/{id}/delete`","newText":"- `GET /api/workspaces/{id}/delete-preview` returns the lists `deletePreview` already reads (`lib/server/orgo.ts`): `computers` as `{ id, name }`, plus `keys`, `skills`, `apps`, `madeApps`, `crmFiles`, `routines`, and `orbitIssues`. Lists this plane does not have are `[]`, not omitted. `POST /api/projects/{id}/delete` deletes that workspace. This preview is for the workspace, not a separate computer-delete dialog"}]} -->
<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale | Rejected |
|---|-------|----------|----------------|-----------|-----------|----------|
| 1 | intake | Speak Orgo's existing HTTP API from a local plane. Do not add a second client in `lib/server/orgo.ts`. | Mechanical | Explicit, DRY | `BOPS_ORGO_ORIGIN` already exists. A second client would fork every computer call. | Rewrite Bops around Incus's API |
| 2 | intake | Keep OpenAI, Composio, treg, AgentMail, AgentPhone, Twilio. | Mechanical | Completeness | The requirement is no capability drop. Those products have no free peer that does the same job. | Swap them for local models, Nango, or Asterisk-only |
| 3 | intake | Runner auth is the key file, not a link-local metadata service. | Taste | Pragmatic | The runner already treats identity 404 as "use the key file." Metadata can come later without an app change. | Build `169.254.169.254` in v1 |
| 4 | intake | Live view is VNC, WebRTC off. | Mechanical | Explicit | `BOPS_WEBRTC=0` is already the supported fallback, and Orgo's UDP gateway is not in this repo. | Reimplement Orgo's WebRTC gateway |
| 5 | intake | Home egress is Headscale, not `orgo-relay`. | Mechanical | Explicit | The relay binary is closed and not in this tree. The image already installs the Tailscale client. | Block the plan on a private binary |
| 6 | intake | Domain purchase stays closed (`registrar: false`). Attach and TLS for a name the user already owns was recorded here, then superseded: attach waits with Your Apps (decision 16). | Mechanical | Completeness | A registry fee is not software. The app already has a closed-registrar state. | Pretend buying a domain is free |
| 7 | ceo | Add `GET /health` and one structured request log line. | Mechanical | Boil lakes | Operating the plane is in the blast radius and under a day. Silent failure is the thing the review is supposed to kill. | Ship the plane with no way to see it is up |
| 8 | ceo | State file is atomic and reloaded on boot. | Mechanical | Completeness | Wake times that vanish on restart mean routines never fire. Same state file, not a new database. | A second store |
| 9 | ceo | Bash and screenshot tests enforce the existing client timeout and print duration. No new latency SLA. | Mechanical | Explicit | performance-testing needs a real workload before a number is a gate. The timeout in `orgo.ts` is the contract we already have. | A Postman cloud load test, or an invented p95 |
| 10 | ceo | Defer a second host / HA. | Mechanical | Pragmatic | New infra, outside this blast radius. One Linux box is the accepted computer. | Build a cluster in this plan |
| 11 | ceo | Skip link-local metadata, WebRTC, and swapping OpenAI. | Mechanical | Explicit | Already settled in rows 2, 3, and 4. Re-opening them does not add a computer capability. | Re-litigate those three |
| 12 | ceo | Wake from `PUT /api/projects/{id}/routines`, idle from `POST /api/bops/computer/active`. Idle stop is `suspended`. | Mechanical | Explicit | Spec review, checked in `routine-sync.ts`, `free-hours.ts`, and `lib/types.ts`. The bops map has no `nextRunAt`. `stopped` means the computer stays down. | Wake from the bops map, or report idle as `stopped` |
| 13 | ceo | noVNC socket is `/desktops/{id}/ws/websockify?token=`, no bearer. | Mechanical | Explicit | `app/api/vnc/route.ts` builds that URL. The page never sends the account key. | Require the bearer on that socket |
| 14 | ceo | Computer key is minted, not `ORGO_API_KEY`. Fork returns 409 and clone copies. One JSON file. Routes are the full `/api` path. | Mechanical | Explicit | Spec review, checked in `runner-install.ts`, `plan.ts`, and `orgo.ts` `base()`. | Write the account key into the guest, or claim Incus can live-fork |
| 15 | ceo | `/api/secrets` returns 501 `not_on_this_plane`. Vault broker deferred. | Mechanical | Pragmatic | `revealKey` treats 404 as "key deleted". A broker is a second product, outside this blast radius. Proceeding means computers work and Keys does not, until that plan. | Return 404, or build the broker in this plan |
| 16 | ceo | Your Apps returns 404 `DEPLOYS_DISABLED`. | Mechanical | Explicit | The client deploys an Ingot changeset (`lib/server/orgo.ts`). The `ingot` binary is not in this repo. Caddy cannot satisfy that call. | Pretend Caddy is Ingot |
| 17 | ceo | Spec review stopped at 3 launches. Remaining gaps are not re-verified. | Mechanical | Explicit | The loop cap is 3. Scores were 4, 6, and 6. Another review of the same plan is not allowed. The open gaps are in the CEO summary. | Launch a fourth spec review |
| 18 | ceo | `GET` and `PUT /api/bops/settings` are implemented. | Mechanical | Explicit | `runner.ts` treats 404 as bots stay on the Mac, so a cloud routine never becomes due. | Leave settings in the 404 class |
| 19 | ceo | A suspended action returns 409 `resume_in_progress` and does not run in that response. | Mechanical | Explicit | Click, type, and key abort at 20 seconds (`INPUT_MS`). The client already retries `WAKE_CODES`. | Run the command inside the resume POST |
| 20 | ceo | A missing state file is empty state. `state_unreadable` is a file that exists and cannot be parsed. | Mechanical | Completeness | Otherwise health stays 503 and nothing can create the file. | Treat ENOENT as `state_unreadable` |
| 21 | ceo | The plane proxies the noVNC socket. Screen ids are `default`, `screen-100`, `screen-101`, `screen-102`. | Mechanical | Explicit | `app/api/vnc/route.ts` dials the origin. `screenId` in `orgo.ts` builds those ids. | Only start websockify inside the guest |
| 22 | ceo | `PUT orgo-key` returns `{ keyId }` and writes `ORGO_API_KEY=` in the guest file. | Mechanical | Explicit | `giveKey` requires `keyId`. `runner-key.ts` reads that variable name. | Return the secret, or write a different variable |
| 23 | ceo | `max_disk_gb` is current size plus space the host can add. Create and clone return 409 `host_full` when the host cannot fit them. | Mechanical | Completeness | `growDisk` treats `max_disk_gb` as the largest legal disk. A create with no RAM check can take down the only host. | Report free space as the max, or cap the plane at one computer |
| 24 | ceo | State read-modify-write takes an exclusive lock. | Mechanical | Completeness | The wake timer and a routines PUT can otherwise drop a `nextRunAt`. | Add SQLite for the lock |
| 25 | ceo | Non-loopback bind is unsupported until the operator terminates TLS. | Mechanical | Explicit | The bearer and the VNC token would cross the LAN. The plane does not mint a certificate. | Ship a LAN listener with no TLS |
| 26 | ceo | Do not narrow the route list because the CEO voice asked. | Mechanical | Explicit | Row 1 is the user's direction. Codex did not run, so the narrowing is not a two-voice user challenge to apply. | Drop Headscale, members, clone, and SSH in this phase |
| 27 | ceo | Keep `mode: "residential"` as 200 for direct egress. | Mechanical | Explicit | `relay.ts` posts that mode after `proxyOff` to record direct egress. `{ enabled: true }` stays 409. | Return 409 for every residential call |
| 28 | ceo | File upload returns an https URL only when `BOPS_UPLOAD_ORIGIN` is https. Size changes that are plan billing return 200 and do not resize. | Mechanical | Explicit | `runner-install.ts` and `bot-files.ts` reject any upload URL that does not start with `https://`. `setSize` for a plan is billing, which this phase does not do. | Return a loopback http URL, or pretend the computer changed size |
| 29 | design | Computer and workspace reads return 503 when Incus is down or the state file is unreadable. | Mechanical | Explicit | An empty list is the opposite of the host being down. The design voice's empty-collection case is the one that matches the client. | Return 200 with no computers |
| 30 | design | The live-view scheme is the app's existing `http` to `ws` replacement, so https becomes wss. | Mechanical | Explicit | `app/api/vnc/route.ts` already does this. The plan's `ws://` shorthand was the ambiguous part. | Add a second URL builder |
| 31 | design | The activity beat stays the app's 4-minute post. A missing POST still does not idle-suspend. | Mechanical | Explicit | `EVERY_MS` is 4 minutes. The comment in `free-hours.ts` says an app that has never posted is not suspended. | Invent a 1-minute beat, or sleep when no POST has arrived |
| 32 | design | Workspace delete-preview returns the lists `deletePreview` already parses. Residential mode stays 200 for direct egress. | Mechanical | Explicit | A new confirm body would not parse. `relay.ts` records direct egress with `mode: "residential"`. | 409 on that mode, or a computer-delete dialog with different fields |
| 33 | ship | Kill bash at the body `timeout`, and return before the client's extra 20 seconds. | Mechanical | Explicit | `orgo.ts` says the extra 20 seconds is only for the answer. Killing at `(timeout+20)*1000` means the client already threw `OrgoTimeout`. | Kill at the HTTP deadline and still promise an exit code |
| 34 | ship | Self-host Mac does not post `/api/bops/computer/active`. The runner beat still can. No POST yet still does not idle-suspend. | Mechanical | Explicit | `cloudOn()` is false when `BOPS_SELF_HOSTED=1`, and `sayInUse` returns before `postOrgo`. | Claim sign-in and takeover post on this plane |
| 35 | ship | Bearer exceptions are health, the websockify socket, and the upload PUT. The request log redacts the upload token. | Mechanical | Explicit | `runner-install.ts` PUTs the bytes with no Authorization. The token is the path. | Require a bearer on that PUT, or log the raw path |
| 36 | ship | CRM and workspace skills return 404 with no code, same as the other sync families that retry status >= 500. A missing state file is 200 only when Incus answers. | Mechanical | Explicit | `crm-sync.ts` and `workspace-skills.ts` retry 501. Task 13 already requires Incus for health 200. | Leave CRM and skills on 501, or mark a missing file healthy while Incus is down |



## CEO review sections

Mode remains SELECTIVE EXPANSION. Codex did not run (`~/.codex/config.toml` rejected by gstack). Coverage is `[single-model]`. No consensus cell is CONFIRMED.

### Current scope

Accepted and still in force: speak the existing Orgo HTTP API (row 1), keep paid providers (row 2), key-file runner auth (row 3), VNC (row 4), Headscale for device egress (row 5), domain purchase closed (row 6, purchase only), health and request log (row 7), atomic JSON state (row 8), client timeouts (row 9), one Linux host (row 10), routines wake and `suspended` idle (row 12), noVNC token socket (row 13), distinct computer key (row 14), vault 501 (row 15), Your Apps 404 `DEPLOYS_DISABLED` (row 16).

Deferred: second host (TODOS, P3), vault broker (TODOS, P2), Your Apps / Ingot (TODOS, P2).

Rejected: a second computer client, WebRTC, link-local metadata, swapping OpenAI, a fourth spec review.

Pending for Phase 4, not applied: the CEO voice's request to drop Headscale, member routes, clone, and SSH from this phase. That changes row 1. Single voice, so it is not a user-challenge auto-approval.

### Section 1: Architecture Review

The Mac app stays the client. A new Node process on one Linux host speaks `BOPS_ORGO_ORIGIN`. Incus runs the guest. The guest runs four X displays, x11vnc, and websockify. The plane proxies HTTP and the noVNC socket. Headscale is the exit-node control server the image's Tailscale client already knows how to join. State is one JSON file.

```
Mac app --HTTP/WS--> plane (host/server.ts) --incus exec/API--> guest
                         |                         |
                         JSON state                x11vnc/websockify
                         |
                         Headscale (device egress only)
```

Happy path: create returns a computer id, GET says `running`, the socket streams, bash returns output. Nil path: missing bearer is 401, except `/health`, the websockify socket, and `PUT /api/files/uploads/{token}`. Empty path: empty bash command still runs and returns its exit code. The routines PUT with an empty list stores an empty list and wakes nothing. Error path: Incus down is 503, not an empty id.

Computer status moves `starting` to `running` to `suspending` to `suspended`, and `suspended` to `resuming` to `running`. `stopped` and `error` have no resume edge. A screenshot cannot enter `resuming`.

Coupling: the plane is coupled to `lib/server/orgo.ts` on purpose. That is the contract. It is not coupled to Bops Cloud, Stripe, or Postgres.

10x load is a second 16 GB guest on the same box. The first thing that breaks is RAM. 100x is out of scope (row 10). The single point of failure is the one host and the one state file. Rollback is unsetting `BOPS_ORGO_ORIGIN`. The app talks to Orgo again. No migration to undo.

Cherry-picks: health and the atomic file fit. They do not add a second service.

Section 1 decisions, applied in the contract: `GET`/`PUT /api/bops/settings` is implemented, because a 404 there makes `lib/server/runner.ts` keep bots on the Mac and no cloud routine is ever due. The plane, not only the guest, proxies `/desktops/{id}/ws/websockify`. Create and clone return 409 `host_full` when RAM or disk will not fit. A cap of one computer is not applied. The app creates more than one bot computer, and a cap would drop that.

The CEO voice said idle sleep cannot happen because the app never posts `/api/bops/computer/active`. That is true for a hosted Mac and false for this plane. `sayInUse` posts only when `cloudOn()` is true, and `cloudOn()` is false when `BOPS_SELF_HOSTED=1`. The self-host Mac does not post on sign-in, takeover, or the 4-minute beat. A guest runner can still post `{ via: "runner" }`. No POST yet still means do not idle-suspend.

### Section 2: Error & Rescue Map

```
PATH                         | WHAT CAN GO WRONG              | CLASS
-----------------------------|--------------------------------|------------------
POST /api/computers          | Incus down                     | incus_down 503
                             | host cannot fit RAM or disk   | host_full 409
POST bash/click/type/key     | computer suspended             | resume_in_progress 409
                             | clock exceeded                 | non-zero exit
GET screenshot               | computer suspended             | computer_asleep 409
                             | over 20s                       | client timeout
GET /health                  | file exists, unreadable       | state_unreadable 503
                             | Incus version fails            | incus_down 503
                             | file missing                   | empty state, then 200 only if incus version succeeds, else incus_down 503
PUT orgo-key                 | computer gone                  | 404
GET domains                  | purchase asked                 | registrar false
hostingCall deploy           | app asks to deploy             | DEPLOYS_DISABLED 404
/api/secrets                 | Keys page                      | not_on_this_plane 501
```

```
CLASS                 | RESCUED? | RESCUE                         | USER SEES
----------------------|----------|--------------------------------|------------------
incus_down            | Y        | 503, no empty id               | computer unavailable
host_full             | Y        | 409 with free RAM and disk     | not enough room
resume_in_progress    | Y        | 409 + Retry-After, client retries | waking
computer_asleep       | Y        | 409, screenshot does not wake  | asleep, then an action wakes
state_unreadable      | Y        | 503, do not create over the file | plane broken
not_on_this_plane     | Y        | 501 with error string, not 404 | Keys closed, key not "deleted"
DEPLOYS_DISABLED      | Y        | 404 with that code             | Your Apps closed
```

A suspended click does not run inside the 20 second `INPUT_MS` clock. It returns 409 `resume_in_progress`. The retry that finds `running` runs it. There is no LLM call in this plane, so malformed model JSON is not a plane failure.

### Section 3: Security & Threat Model

| Threat | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Bearer or VNC token on a LAN bind | Med | High | Loopback is the default. A non-loopback bind is unsupported until TLS sits in front. The plane does not mint a certificate. |
| Computer key used to delete the workspace | Low | High | 403 on workspace delete and member routes. |
| Bash command logged | Med | High | The request log omits command text, bearer, key file, screenshot bytes, and `token`. |
| Guest `incus exec` as root | High | High | Accepted. The product is a bot computer. The bearer is the gate. |
| Invite 200 that did not send mail | Med | Low | Kept. The app's member routes expect 200 on a single-user plane. Hiding the controls would be an app change, which row 1 forbids. |
| Residential 200 that is not a residential IP | Med | Med | Kept for `mode: "residential"` after `proxyOff`. `lib/server/relay.ts` uses that POST to record direct egress. `{ enabled: true }` stays 409. |

No new npm dependency. Secrets stay in the state file mode of the process user, and the guest key file is 0600. Command injection is the product (bash). The plane does not shell-concatenate the command into a host shell. It passes it to `incus exec` as an argument.

### Section 4: Data Flow & Interaction Edge Cases

```
routines PUT -> validate onMac/run/nextRunAt -> state file -> wake timer -> Incus start
settings PUT -> validate runsOn cloud|mac -> state file -> GET returns it
active POST  -> record beat and via -> state file -> idle timer
```

Nil `runsOn` is the empty setting. The app's first PUT sets `cloud`. Empty routines list clears wake times. A second PUT that overlaps the timer: the state file is rewritten under an exclusive lock, so one of the two `nextRunAt` values wins whole, not a mix.

```
time     PUT routines          timer tick           state
t1       begin read
t2                            read same file
t3       write nextRunAt=A
t4                            write without A        LOST without a lock
```

The lock makes t4 wait and reread. The test is two processes, one holding the lock. A green unit test does not prove Incus serialized the VM start. `no_claim=Incus mutual exclusion (file lock only)`.

Double-create of one name: second POST 409. Navigate away during create: the VM may exist and GET shows it. Retry of create with the same name 409s rather than making a second VM.

### Section 5: Code Quality Review

`host/server.ts` follows `cloud/server.ts`: plain TypeScript, relative imports, no Next. One file will branch on every route. That is the existing cloud-server pattern, not a new framework. If a single request function grows past five branches, split by route family (`computers`, `routines`, `egress`) in the same process. Do not add a plugin loader.

SQLite stays rejected. The exclusive lock is the missing piece of the JSON choice, not a second database.

### Section 6: Test Review

`node --test host/test/` is the approved suite. New assertions inside it, not a new runner:

- Settings PUT `{ runsOn: "cloud" }` then GET returns it. A 404 is a failing test.
- Suspended click returns 409 `resume_in_progress` and does not call exec. `no_claim=guest actually resumed (status file only)`.
- Missing state file becomes empty and health is 200 if Incus answers.
- Create when the reported free RAM is under the request returns 409 `host_full`.
- Two writers: the wake time from the first is still present after the second finishes.
- Secrets routes named in task 12 are 501 and not 404.
- Screenshot of `suspended` is 409 `computer_asleep`.

The Friday test is the README manual check: create, open the screen, one bash line, runner log says `auth: key`. The hostile test is a computer key calling workspace delete, expecting 403. The chaos test is killing the plane mid-write and reloading the previous file. Flakiness: do not sleep for the 5 minute idle in the unit test. Advance a clock argument. `no_claim=wall clock idle (injected clock)`.

No Postman load test. The performance-testing skill has no collection and no shared target. Duration is printed. The gate stays the client timeout.

### Section 7: Performance Review

No ORM and no new database, so no N+1 and no index. The state file's maximum size is one user's computers, routines, and the workspace map. That is small. The wake timer is one process, payload is the due list, no retry storm: a failed start logs and tries the next minute. Slow paths: Incus create (tens of seconds, the client's existing create timeout), screenshot (20s ceiling), bash (kill at the body timeout and return before the client's extra 20 seconds). Connection count is one HTTP server and one Incus socket. Screenshot bytes are not buffered into the state file.

Numbers are `[estimated]` until `host/test` prints a duration.

### Section 8: Observability & Debuggability

The accepted cherry-pick is one log line per request: method, path, status, milliseconds, computer id. That is the day-1 signal. Health is the "is it up" metric. There is no new dashboard and no metrics product. A missing computer in a log line three weeks later is reconstructed from the state file plus that line. The runbook is the README: health 503 `incus_down` means start Incus, `state_unreadable` means do not delete the file, `host_full` means free RAM or pick a smaller `ram`.

What would make it a joy later, and is not this phase: a counter of wake starts and idle suspends. Deferred with the second host, not built now.

### Section 9: Deployment & Rollout Review

No database migration. The flag is `BOPS_ORGO_ORIGIN`. Unset it and the app uses Orgo again. Order: build the image on the Linux host, start the plane, then point the Mac. Old app and new plane: the plane must answer the routes the current app already calls. That is task 1. There is no staging cloud. The post-deploy check is health 200, then the manual screen check. Smoke is `node --test host/test/` on the Linux host.

Deploy infrastructure that would make this routine later is a systemd unit and a Caddy TLS front. The unit is a README snippet, in task 11. Caddy for Your Apps stays deferred (row 16). TLS in front of a non-loopback bind is the operator's, and the README says the remote Mac is unsupported until that exists.

### Section 10: Long-Term Trajectory Review

Debt: a JSON file with a lock, a closed vault, and a closed deploy. Path dependency: the route list is the adapter. A future substrate implements the same routes or the app changes, which this plan refuses. Reversibility is 4. Unset the origin. The VMs remain on the Linux host until deleted. Knowledge: this plan plus the README paragraph is the doc. In 12 months a new engineer should see `host/server.ts` and `host/routes.md` and know the app was not forked.

After this ships: vault broker, then Your Apps, then a second host. Those are TODOS, and the architecture does not block them. The accepted cherry-picks (health, atomic file, timeout tests) are still the right ones. The rejected metadata server and WebRTC are still not load-bearing. Settings, the socket proxy, and `host_full` were load-bearing and were missing. They are in the contract now.

The CEO voice's "narrow the phase" is the retrospective it asked for. It is not applied. Row 1 is the user's direction, and Codex did not agree because Codex did not run.

### Section 11: Design & UX Review

UI scope is the existing screen, not a new screen. The user sees the computer view they already have: asleep, waking, running, or an error from the status string. Loading is the current computer view. Empty is no computer yet, which the app already explains. Error is the plane's status and the 409 text. Success is the screen in noVNC. Partial is one display up and another still starting. The socket with no `screen` is display `:99` (`default`). `&screen=` uses `screen-100`, `screen-101`, `screen-102`.

No new visual language. DESIGN.md does not exist for this repo. The Mac app's current computer view is the design. Mobile is the existing layout. This plan does not add a layout. Accessibility of the noVNC surface is the app's existing player.

The 30-minute touch already required: the README says, in one sentence, that Keys and Your Apps are closed on this plane so the user does not hunt a spinner.

Consider `/plan-design-review` only if a later plan adds a screen. This one does not. After implementation, `/design-review` on the live computer view is the check that the asleep state still matches the app.
