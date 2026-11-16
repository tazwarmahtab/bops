export type ClosedMatch = { status: number; body: Record<string, unknown> };

export function matchClosed(method: string, path: string): ClosedMatch | null {
  if (path.startsWith("/api/secrets")) {
    return { status: 501, body: { code: "not_on_this_plane", error: "not on this plane" } };
  }
  if (
    path.includes("/deploy-projects") ||
    path.includes("/deployments") ||
    path.includes("/public-urls") ||
    (path.includes("/computers/") && path.includes("/domains"))
  ) {
    return { status: 404, body: { code: "DEPLOYS_DISABLED", error: "deploys disabled" } };
  }
  if (path === "/api/domains/search" || (path.startsWith("/api/projects/") && path.includes("/domains/"))) {
    if (method === "GET" && /^\/api\/projects\/[^/]+\/domains$/.test(path)) {
      return null;
    }
    return { status: 501, body: { code: "not_on_this_plane", error: "not on this plane" } };
  }
  for (const segment of ["/crm", "/skills", "/skill-labels", "/access", "/orbit", "/bops/apps"]) {
    if (path.includes(segment)) {
      return { status: 404, body: { error: "not found" } };
    }
  }
  return null;
}

export function closedRoutes(method: string, path: string): ClosedMatch | null {
  return matchClosed(method, path);
}