import { createHash, randomBytes } from "node:crypto";
import { createRequestStore, json } from "../../lib/store.mjs";
import { CONFIG_KEY, makePinRecord, verifyPin, signSession, posSessionCookie, clearPosSessionCookie, safeEqualText, verifyPosSession } from "../../lib/pos-security.mjs";

const PIN_FAIL_LIMIT = 5;
const PIN_LOCK_MS = 5 * 60 * 1000;

function validPin(pin) { return /^\d{4,12}$/.test(String(pin || "")); }
function clientBucket(request) {
  const ip = request.headers.get("x-nf-client-connection-ip") || (request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
  return createHash("sha256").update(ip || "unknown").digest("hex").slice(0, 24);
}
async function loginLockState(store, request) {
  const key = `pos-pin-attempt-${clientBucket(request)}`;
  const row = await store.get(key, { type: "json" });
  return { key, row: row || { failures: 0, lockedUntil: 0 }, blocked: Number(row?.lockedUntil || 0) > Date.now() };
}
async function recordFailedLogin(store, state) {
  const failures = Number(state.row.failures || 0) + 1;
  const lockedUntil = failures >= PIN_FAIL_LIMIT ? Date.now() + PIN_LOCK_MS : 0;
  await store.setJSON(state.key, { failures: lockedUntil ? 0 : failures, lockedUntil, updatedAt: new Date().toISOString() });
  return lockedUntil;
}
function jsonWithCookie(payload, status, cookie) {
  return json(payload, status, { "Set-Cookie": cookie });
}

export default async function handler(request) {
  const store = createRequestStore();
  if (request.method === "GET") {
    const config = await store.get(CONFIG_KEY, { type: "json" });
    return json({ ok: true, configured: Boolean(config?.pinRecord && config?.sessionSecret), authenticated: await verifyPosSession(request, store), setupAvailable: String(process.env.POS_SECURITY_SETUP_KEY || "").length >= 32 });
  }
  if (request.method !== "POST") return json({ ok: false, message: "Method not allowed." }, 405, { Allow: "GET, POST" });
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, message: "Invalid JSON request." }, 400); }
  const action = String(body?.action || "");

  if (action === "logout") return jsonWithCookie({ ok: true }, 200, clearPosSessionCookie());

  if (action === "setup") {
    const setupKey = String(process.env.POS_SECURITY_SETUP_KEY || "");
    if (setupKey.length < 32) return json({ ok: false, message: "Owner setup is not ready. Add POS_SECURITY_SETUP_KEY (at least 32 characters) to Netlify environment variables, then redeploy." }, 503);
    if (!safeEqualText(String(body?.setupKey || ""), setupKey)) return json({ ok: false, message: "The owner setup key is incorrect." }, 403);
    if (!validPin(body?.newPin)) return json({ ok: false, message: "Choose a PIN containing 4 to 12 digits." }, 400);
    const config = { version: 1, pinRecord: makePinRecord(String(body.newPin)), sessionSecret: randomBytes(32).toString("base64url"), sessionVersion: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const saved = await store.setJSON(CONFIG_KEY, config, { onlyIfNew: true });
    if (!saved.modified) return json({ ok: false, message: "POS security has already been initialized. Please log in with the current POS PIN." }, 409);
    return jsonWithCookie({ ok: true, configured: true, message: "POS security was initialized." }, 200, posSessionCookie(signSession(config)));
  }

  const config = await store.get(CONFIG_KEY, { type: "json" });
  if (!config?.pinRecord || !config?.sessionSecret) return json({ ok: false, message: "POS security has not been initialized. Complete the one-time owner setup first." }, 409);

  if (action === "login") {
    const state = await loginLockState(store, request);
    if (state.blocked) return json({ ok: false, message: "Too many incorrect PIN attempts. Wait 5 minutes before trying again." }, 429);
    if (!verifyPin(String(body?.pin || ""), config.pinRecord)) {
      const lockedUntil = await recordFailedLogin(store, state);
      return json({ ok: false, message: lockedUntil ? "Too many incorrect attempts. POS login is locked for 5 minutes." : "Incorrect POS PIN. Please try again." }, 401);
    }
    await store.delete(state.key).catch(() => {});
    return jsonWithCookie({ ok: true, authenticated: true }, 200, posSessionCookie(signSession(config)));
  }

  if (action === "changePin") {
    if (!(await verifyPosSession(request, store))) return json({ ok: false, message: "Your POS session is locked. Enter the POS PIN again." }, 401);
    if (!verifyPin(String(body?.currentPin || ""), config.pinRecord)) return json({ ok: false, message: "The current POS PIN is incorrect." }, 403);
    if (!validPin(body?.newPin)) return json({ ok: false, message: "Choose a new PIN containing 4 to 12 digits." }, 400);
    const existing = await store.getWithMetadata(CONFIG_KEY, { type: "json" });
    if (!existing?.data) return json({ ok: false, message: "POS security settings could not be loaded. Please try again." }, 503);
    const updated = { ...existing.data, pinRecord: makePinRecord(String(body.newPin)), sessionVersion: (Number(existing.data.sessionVersion) || 1) + 1, updatedAt: new Date().toISOString() };
    const saved = await store.setJSON(CONFIG_KEY, updated, { onlyIfMatch: existing.etag });
    if (!saved.modified) return json({ ok: false, message: "POS security settings changed in another session. Please try again." }, 409);
    return jsonWithCookie({ ok: true, message: "POS access PIN updated." }, 200, posSessionCookie(signSession(updated)));
  }

  return json({ ok: false, message: "Unknown POS security action." }, 400);
}

export const config = { path: "/api/pos-auth", method: ["GET", "POST"] };
