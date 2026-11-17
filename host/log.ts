export function logLine(method: string, template: string, status: number, ms: number, computerId: string | null) {
  const id = computerId ?? "-";
  process.stdout.write(`${method} ${template} ${status} ${ms} ${id}\n`);
}
