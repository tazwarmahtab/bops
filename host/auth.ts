import { createHash, timingSafeEqual } from "node:crypto";
import type { PlaneFile } from "./state.ts";

export function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function sameSecret(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export type Actor = { kind: "account" } | { kind: "computer"; computerId: string; keyId: string };

export function who(token: string, accountKey: string, file: PlaneFile): Actor | null {
  if (accountKey && sameSecret(token, accountKey)) return { kind: "account" };
  const hash = sha256(token);
  const key = Object.values(file.keys).find((item) => item.hash === hash);
  return key ? { kind: "computer", computerId: key.computerId, keyId: key.keyId } : null;
}