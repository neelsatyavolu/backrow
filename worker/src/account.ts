// Account endpoints under /api/account. The browser sends a key derived from
// the password (never the password itself), and stores a profile it sealed
// itself; see shared/account.ts. Codes for confirming an email or resetting a
// password are sent through Resend.

import { isAuthKey, isCode, isProfileBlob, normalizeEmail } from "../../shared/account";
import { randomId, toBase64Url } from "../../shared/crypto";
import type { Env } from "./env";

const CODE_TTL_MS = 15 * 60_000;
const CODE_TRIES = 5;
const SESSION_TTL_MS = 90 * 24 * 60 * 60_000;
const FROM = "Backrow <no-reply@n3el.dev>";

type Purpose = "signup" | "reset";
type Reply = (body: unknown, status?: number) => Response;

interface UserRow {
  id: string;
  salt: string;
  hash: string;
  profile: string | null;
}

interface CodeRow {
  code_hash: string;
  pending: string | null;
  expires_at: number;
  tries: number;
}

async function sha256(text: string): Promise<string> {
  return toBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

function sameHash(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  return ea.length === eb.length && crypto.subtle.timingSafeEqual(ea, eb);
}

// The auth key is already stretched with PBKDF2 in the browser, so a salted
// SHA-256 is enough here (and fits the Worker's CPU budget).
const hashAuth = (salt: string, auth: string) => sha256(`${salt}:${auth}`);
const hashCode = (email: string, purpose: Purpose, code: string) => sha256(`${purpose}:${email}:${code}`);

function newCode(): string {
  const [n] = crypto.getRandomValues(new Uint32Array(1));
  return String(n! % 1_000_000).padStart(6, "0");
}

async function newSession(env: Env, userId: string): Promise<string> {
  const token = randomId(40);
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await sha256(token), userId, Date.now() + SESSION_TTL_MS)
    .run();
  return token;
}

async function sessionUser(env: Env, request: Request): Promise<string | null> {
  const token = request.headers.get("Authorization")?.match(/^Bearer ([a-z2-9]{40})$/)?.[1];
  if (!token) return null;
  const row = await env.DB.prepare("SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(await sha256(token), Date.now())
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

/** Local development only: DEV_CODES=1 in .dev.vars, which is never deployed. */
const devCodes = (env: Env) => !env.RESEND_API_KEY && env.DEV_CODES === "1";

/**
 * Sends a code. A local dev server set up with DEV_CODES hands the code back
 * in the response instead, so the flow can be tested without email.
 */
async function sendCode(env: Env, email: string, purpose: Purpose, code: string): Promise<{ devCode?: string } | null> {
  if (devCodes(env)) return { devCode: code };
  if (!env.RESEND_API_KEY) return null;
  const action = purpose === "signup" ? "confirm your email" : "reset your password";
  const text = `Your Backrow code is ${code}. Enter it to ${action}. It expires in 15 minutes.\n\nIf you didn't ask for this, you can ignore this email.`;
  const html = `<p>Your Backrow code is</p><p style="font:600 28px monospace;letter-spacing:4px">${code}</p><p>Enter it to ${action}. It expires in 15 minutes.</p><p style="color:#777">If you didn't ask for this, you can ignore this email.</p>`;
  return (await sendEmail(env, email, `Your Backrow code: ${code}`, text, html)) ? {} : null;
}

async function sendEmail(env: Env, to: string, subject: string, text: string, html: string): Promise<boolean> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], subject, text, html }),
    });
    if (!res.ok) console.error("resend failed", res.status, await res.text());
    return res.ok;
  } catch (err) {
    console.error("resend failed", err);
    return false;
  }
}

async function limited(env: Env, ...keys: string[]): Promise<boolean> {
  for (const key of keys) if (!(await env.AUTH_LIMITER.limit({ key })).success) return true;
  return false;
}

async function storeCode(env: Env, email: string, purpose: Purpose, code: string, pending: string | null): Promise<void> {
  await env.DB.prepare(
    "INSERT OR REPLACE INTO codes (email, purpose, code_hash, pending, expires_at, tries) VALUES (?, ?, ?, ?, ?, 0)",
  )
    .bind(email, purpose, await hashCode(email, purpose, code), pending, Date.now() + CODE_TTL_MS)
    .run();
}

/** Checks a code, counting the attempt. Returns the row when it matches. */
async function takeCode(env: Env, email: string, purpose: Purpose, code: string): Promise<CodeRow | null> {
  const row = await env.DB.prepare("SELECT code_hash, pending, expires_at, tries FROM codes WHERE email = ? AND purpose = ?")
    .bind(email, purpose)
    .first<CodeRow>();
  if (!row || row.expires_at < Date.now() || row.tries >= CODE_TRIES) return null;
  await env.DB.prepare("UPDATE codes SET tries = tries + 1 WHERE email = ? AND purpose = ?").bind(email, purpose).run();
  if (!sameHash(row.code_hash, await hashCode(email, purpose, code))) return null;
  await env.DB.prepare("DELETE FROM codes WHERE email = ? AND purpose = ?").bind(email, purpose).run();
  return row;
}

const findUser = (env: Env, email: string) =>
  env.DB.prepare("SELECT id, salt, hash, profile FROM users WHERE email = ?").bind(email).first<UserRow>();

async function signup(env: Env, body: Record<string, unknown>, ip: string, reply: Reply): Promise<Response> {
  const email = normalizeEmail(body.email);
  if (!email || !isAuthKey(body.auth)) return reply({ error: "Enter a valid email and password" }, 400);
  if (await limited(env, `ip:${ip}`, `email:${email}`)) return reply({ error: "Too many tries. Wait a minute and try again." }, 429);
  if (await findUser(env, email)) {
    // Same answer as a new signup, so the form doesn't reveal who has an account.
    const sent = devCodes(env)
      ? true
      : await sendEmail(
      env,
      email,
      "You already have a Backrow account",
      "Someone tried to create a Backrow account with this email, but you already have one. Sign in instead, or use \"Forgot password\" if you need to.\n\nIf this wasn't you, you can ignore this email.",
      "<p>Someone tried to create a Backrow account with this email, but you already have one. Sign in instead, or use “Forgot password” if you need to.</p><p style=\"color:#777\">If this wasn't you, you can ignore this email.</p>",
    );
    return sent ? reply({ ok: true }) : reply({ error: "Couldn't send the email. Try again." }, 503);
  }
  const salt = randomId(16);
  const code = newCode();
  await storeCode(env, email, "signup", code, JSON.stringify({ salt, hash: await hashAuth(salt, body.auth) }));
  const sent = await sendCode(env, email, "signup", code);
  return sent ? reply({ ok: true, ...sent }) : reply({ error: "Couldn't send the email. Try again." }, 503);
}

async function verify(env: Env, body: Record<string, unknown>, ip: string, reply: Reply): Promise<Response> {
  const email = normalizeEmail(body.email);
  if (!email || !isCode(body.code)) return reply({ error: "Enter the 6-digit code from the email" }, 400);
  if (await limited(env, `ip:${ip}`)) return reply({ error: "Too many tries. Wait a minute and try again." }, 429);
  const row = await takeCode(env, email, "signup", body.code);
  const pending = row?.pending ? (JSON.parse(row.pending) as { salt: string; hash: string }) : null;
  if (!pending) return reply({ error: "That code is wrong or has expired" }, 400);
  const id = randomId(16);
  const inserted = await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, salt, hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, pending.salt, pending.hash, Date.now())
    .run();
  if (!inserted.meta.changes) return reply({ error: "This email already has an account. Sign in instead." }, 409);
  return reply({ token: await newSession(env, id) });
}

async function login(env: Env, body: Record<string, unknown>, ip: string, reply: Reply): Promise<Response> {
  const email = normalizeEmail(body.email);
  if (!email || !isAuthKey(body.auth)) return reply({ error: "Enter a valid email and password" }, 400);
  if (await limited(env, `ip:${ip}`, `email:${email}`)) return reply({ error: "Too many tries. Wait a minute and try again." }, 429);
  const user = await findUser(env, email);
  const hash = await hashAuth(user?.salt ?? "none", body.auth);
  if (!user || !sameHash(user.hash, hash)) return reply({ error: "Wrong email or password" }, 401);
  return reply({ token: await newSession(env, user.id) });
}

async function resetRequest(env: Env, body: Record<string, unknown>, ip: string, reply: Reply): Promise<Response> {
  const email = normalizeEmail(body.email);
  if (!email) return reply({ error: "Enter a valid email" }, 400);
  if (await limited(env, `ip:${ip}`, `email:${email}`)) return reply({ error: "Too many tries. Wait a minute and try again." }, 429);
  // Answers the same whether or not the account exists.
  if (!(await findUser(env, email))) return reply({ ok: true });
  const code = newCode();
  await storeCode(env, email, "reset", code, null);
  const sent = await sendCode(env, email, "reset", code);
  return sent ? reply({ ok: true, ...sent }) : reply({ error: "Couldn't send the email. Try again." }, 503);
}

async function reset(env: Env, body: Record<string, unknown>, ip: string, reply: Reply): Promise<Response> {
  const email = normalizeEmail(body.email);
  if (!email || !isCode(body.code) || !isAuthKey(body.auth)) return reply({ error: "Enter the code and a new password" }, 400);
  if (await limited(env, `ip:${ip}`)) return reply({ error: "Too many tries. Wait a minute and try again." }, 429);
  const user = await findUser(env, email);
  if (!user || !(await takeCode(env, email, "reset", body.code))) return reply({ error: "That code is wrong or has expired" }, 400);
  const salt = randomId(16);
  // The old profile was sealed with a key from the old password, so it can't
  // be opened any more; clear it and sign out every other device.
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET salt = ?, hash = ?, profile = NULL WHERE id = ?").bind(salt, await hashAuth(salt, body.auth), user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
  ]);
  return reply({ token: await newSession(env, user.id) });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > 32 * 1024) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function handleAccount(request: Request, env: Env, action: string, reply: Reply): Promise<Response> {
  const method = request.method;
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";

  if (method === "POST" && ["signup", "verify", "login", "reset-request", "reset"].includes(action)) {
    const body = await readJson(request);
    if (!body) return reply({ error: "Invalid request" }, 400);
    if (action === "signup") return signup(env, body, ip, reply);
    if (action === "verify") return verify(env, body, ip, reply);
    if (action === "login") return login(env, body, ip, reply);
    if (action === "reset-request") return resetRequest(env, body, ip, reply);
    return reset(env, body, ip, reply);
  }

  const userId = await sessionUser(env, request);
  if (!userId) return reply({ error: "Signed out. Sign in again." }, 401);

  if (method === "GET" && action === "profile") {
    const row = await env.DB.prepare("SELECT profile FROM users WHERE id = ?").bind(userId).first<{ profile: string | null }>();
    return reply({ profile: row?.profile ?? null });
  }
  if (method === "PUT" && action === "profile") {
    const body = await readJson(request);
    if (!body || !isProfileBlob(body.profile)) return reply({ error: "Invalid profile" }, 400);
    await env.DB.prepare("UPDATE users SET profile = ? WHERE id = ?").bind(body.profile, userId).run();
    return reply({ ok: true });
  }
  if (method === "POST" && action === "logout") {
    const token = request.headers.get("Authorization")!.slice(7);
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
    return reply({ ok: true });
  }
  if (method === "DELETE" && action === "") {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId),
      env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
    ]);
    return reply({ ok: true });
  }
  return reply({ error: "Not found" }, 404);
}
