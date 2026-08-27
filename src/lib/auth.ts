import crypto from "crypto";
import { NextRequest } from "next/server";

export const ADMIN_SESSION_COOKIE = "admin_session";

const SESSION_PAYLOAD = "authenticated";

function getAdminPassword(): string {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new Error("ADMIN_PASSWORD must be set (see .env.local.example)");
  }
  return password;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyPassword(candidate: string): boolean {
  return timingSafeStringEqual(candidate, getAdminPassword());
}

// The session cookie is an HMAC of a fixed string, keyed by the admin
// password. There's no per-user session store to manage - anyone who knows
// the password can derive a valid cookie, and that's the whole trust model
// for a single-admin app.
export function createSessionToken(): string {
  return crypto.createHmac("sha256", getAdminPassword()).update(SESSION_PAYLOAD).digest("hex");
}

export function verifySessionToken(token: string | undefined | null): boolean {
  if (!token) return false;
  return timingSafeStringEqual(token, createSessionToken());
}

export function isAuthenticatedRequest(req: NextRequest): boolean {
  return verifySessionToken(req.cookies.get(ADMIN_SESSION_COOKIE)?.value);
}
