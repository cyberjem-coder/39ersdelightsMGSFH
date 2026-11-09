import { createRequestStore, json } from "../../lib/store.mjs";
import { timingSafeEqual } from "node:crypto";

function tokenMatches(provided, expected) {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  if (provided.length < 24 || provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

export default async function handler(request) {
  if (request.method !== "POST") {
    return json({ ok: false, message: "Method not allowed." }, 405, { Allow: "POST" });
  }

  const expected = process.env.POS_DEVICE_RESET_TOKEN || "";
  if (expected.length < 24) {
    return json({ ok: false, message: "Device reset is not configured. Set POS_DEVICE_RESET_TOKEN in Netlify environment variables and redeploy." }, 503);
  }

  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, message: "Invalid request." }, 400); }

  if (!tokenMatches(body?.token, expected)) {
    return json({ ok: false, message: "The reset code is incorrect." }, 403);
  }

  // Create the Blobs client within this request handler so Netlify can provide
  // the correct site-scoped credentials. This deletes only the cashier key hash.
  const store = createRequestStore();
  await store.delete("pos-device-key-hash");
  return json({ ok: true, message: "Cashier device authorization has been reset. Return to the cashier POS in the intended Chrome browser and open the QR ordering panel to register and publish the menu." });
}

export const config = { path: "/api/reset-pos-device", method: ["POST"] };
