# Headscale egress

The local computer plane does **not** start Headscale. The operator runs one Headscale server, creates one user on that server, and sets `BOPS_HEADSCALE_URL` to its URL so paired devices expose the rendezvous address in `GET /api/egress-devices`.

Guest computers already include the Tailscale client from `orgo/bops-base.mjs`. After pairing a Mac with `POST /api/egress-devices`, join that machine to the same tailnet and use device mode on a computer to route through it.

Steps for the operator:

1. Run a single-user Headscale instance on hardware you control.
2. Create one user in Headscale for this deployment.
3. Export `BOPS_HEADSCALE_URL` to the Headscale server URL (for example `https://headscale.example:8080`).
4. Restart or start the plane so it records that URL as `rendezvous`.
5. On each guest, use the Tailscale client installed by the image to authenticate against that Headscale server and complete pairing with the code from the plane.

Residential proxy egress is not available on this plane; `POST /api/computers/{id}/residential-proxy` with `{ "enabled": true }` returns `residential_unavailable`.