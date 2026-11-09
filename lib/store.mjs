import { createHash, timingSafeEqual } from "node:crypto";
import { getStore } from "@netlify/blobs";

// IMPORTANT: Call this from inside a Netlify Functions v2 request handler.
// Netlify injects the site ID and Blobs token into the active request context.
// Do not create/cache the store at module-import time.
export function createRequestStore() {
  return getStore("39ers-delights-mobile-orders");
}

const hash = value => createHash("sha256").update(value).digest("hex");

export async function verifyStoreKey(request, store, { registerIfMissing = false } = {}) {
  if (!store) throw new TypeError("A request-scoped Netlify Blobs store is required.");
  const key = request.headers.get("x-store-key") || "";
  if (key.length < 32 || key.length > 200) return false;

  const presented = hash(key);
  const stored = await store.get("pos-device-key-hash", { type: "text" });

  if (!stored && registerIfMissing) {
    // Only the first POS device can register the shared store key.
    await store.set("pos-device-key-hash", presented, { onlyIfNew: true });
    const registered = await store.get("pos-device-key-hash", { type: "text" });
    return registered === presented;
  }

  if (!stored || stored.length !== presented.length) return false;
  return timingSafeEqual(Buffer.from(stored), Buffer.from(presented));
}

export function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...extraHeaders },
  });
}
