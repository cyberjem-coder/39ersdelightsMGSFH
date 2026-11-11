import { createHmac, createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

const CONFIG_KEY = "pos-security-config-v1";
const COOKIE_NAME = "39ers_pos_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 240000;

function cookieValue(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}

function safeEqualText(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function makePinRecord(pin) {
  const salt = randomBytes(16);
  const derived = pbkdf2Sync(pin, salt, PBKDF2_ITERATIONS, 32, "sha256");
  return { salt: salt.toString("base64url"), hash: derived.toString("base64url"), iterations: PBKDF2_ITERATIONS };
}

function verifyPin(pin, record) {
  try {
    if (!/^\d{4,12}$/.test(String(pin || "")) || !record?.salt || !record?.hash) return false;
    const salt = Buffer.from(record.salt, "base64url");
    const expected = Buffer.from(record.hash, "base64url");
    const actual = pbkdf2Sync(String(pin), salt, Number(record.iterations) || PBKDF2_ITERATIONS, expected.length, "sha256");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}

function signSession(config) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_TTL_MS, ver: Number(config.sessionVersion) || 1 })).toString("base64url");
  const signature = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export async function verifyPosSession(request, store) {
  try {
    const config = await store.get(CONFIG_KEY, { type: "json" });
    if (!config?.pinRecord || !config?.sessionSecret) return false;
    const token = cookieValue(request, COOKIE_NAME);
    if (!token || token.length > 2048) return false;
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return false;
    const expected = createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
    if (!safeEqualText(signature, expected)) return false;
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number(decoded.exp) > Date.now() && Number(decoded.ver) === (Number(config.sessionVersion) || 1);
  } catch { return false; }
}

export function posSessionCookie(token) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

export function clearPosSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export { CONFIG_KEY, COOKIE_NAME, makePinRecord, verifyPin, signSession, safeEqualText };
