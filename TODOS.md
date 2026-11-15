# TODOS

## Infrastructure

### Local computer plane

**What:** Build the Incus plane in `host/` that speaks the Orgo HTTP API this app already calls.

**Why:** The Mac can point `BOPS_ORGO_ORIGIN` at a machine the operator runs. The contract is written. The process, image, and tests are not.

**Context:** Deferred from plan: `docs/plans/self-host-computer.md`. Tasks 1–14, the route contract, and `node --test host/test/` are this item. Do not narrow the routes. Do not replace OpenAI, Composio, treg, AgentMail, AgentPhone, or Twilio. Keys, Your Apps, and a second host stay the items below.

**Effort:** XL
**Priority:** P1
**Depends on:** None

### Vault broker on the local plane

**What:** Store key names and values on the plane and answer `/api/secrets` the way `lib/server/keys.ts` calls it.

**Why:** Pointing `BOPS_ORGO_ORIGIN` at this plane sends the Keys page there. `revealKey` treats 404 as "that key isn't in your vault anymore," so the plane returns 501 `not_on_this_plane` instead. Keys do not work until this exists.

**Context:** The computer plan (`docs/plans/self-host-computer.md`) implements computers, routines, and the screen socket. It does not store secrets or call providers with them. Start from `vault()` in `lib/server/keys.ts`. Do not log values.

**Effort:** XL
**Priority:** P2
**Depends on:** The computer plane's route freeze lists `/api/secrets` as `501 not_on_this_plane`.

### Second computer host

**What:** Run more than one Linux machine behind the local computer plane.

**Why:** One box caps how many 16 GB computers fit. A second host is how a self-hoster grows past that RAM.

**Context:** The accepted plan is one Incus host (`docs/plans/self-host-computer.md`). The plane's state file has no host id. Start by adding a host field to each computer record and a create that picks the host with free RAM. Do not do this until one host creates, watches, and wakes a computer.

**Effort:** XL
**Priority:** P3
**Depends on:** The single-host plane in `docs/plans/self-host-computer.md` is proven with `node --test host/test/` and the manual screen check.

### Your Apps on the local plane

**What:** Build and serve a workspace app from the changeset the Mac already sends, and put Caddy in front of its port.

**Why:** The app's deploy calls expect an Ingot changeset. This plane returns 404 `DEPLOYS_DISABLED` because the `ingot` binary is not in the repo.

**Context:** `lib/server/orgo.ts` maps that code to hosting closed. `lib/server/ingot.ts` is the client. Start only if a buildable source exists that the existing deploy routes can point at. Do not invent a second deploy API in the Mac app.

**Effort:** XL
**Priority:** P2
**Depends on:** The computer plane answers deploy routes with 404 `DEPLOYS_DISABLED`.
