import { randomUUID } from "node:crypto";
import { createRequestStore, verifyStoreKey, json } from "../../lib/store.mjs";
import { verifyPosSession } from "../../lib/pos-security.mjs";

const MIME_TO_EXT = new Map([
  ["image/jpeg", "jpg"], ["image/png", "png"], ["image/webp", "webp"],
  ["video/mp4", "mp4"], ["video/webm", "webm"], ["video/quicktime", "mov"],
]);
const MAX_MEDIA_BYTES = 4 * 1024 * 1024;

export default async function handler(request) {
  try {
    const store = createRequestStore();
    const url = new URL(request.url);
    if (request.method === "GET") {
      const key = url.searchParams.get("key") || "";
      if (!/^menu-media\/[a-f0-9-]{36}\.(?:jpg|png|webp|mp4|webm|mov)$/.test(key)) return json({ ok: false, message: "Invalid media key." }, 400);
      const record = await store.getWithMetadata(key, { type: "arrayBuffer" });
      if (!record?.data) return json({ ok: false, message: "Media not found." }, 404);
      const contentType = String(record.metadata?.contentType || "application/octet-stream");
      if (!MIME_TO_EXT.has(contentType)) return json({ ok: false, message: "Unsupported stored media type." }, 415);
      const headers = new Headers({
        "Content-Type": contentType,
        "Content-Length": String(record.data.byteLength),
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      });
      if (record.etag) headers.set("ETag", record.etag);
      return new Response(record.data, { status: 200, headers });
    }
    if (request.method !== "POST") return json({ ok: false, message: "Method not allowed." }, 405, { Allow: "GET, POST" });
    if (!(await verifyPosSession(request, store))) return json({ ok: false, message: "Cashier POS is locked or the session expired. Unlock the POS and try again." }, 401);
    if (!(await verifyStoreKey(request, store, { registerIfMissing: true }))) return json({ ok: false, message: "POS device not authorized to upload promotional media." }, 403);
    const contentType = (request.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const extension = MIME_TO_EXT.get(contentType);
    if (!extension) return json({ ok: false, message: "Use JPG, PNG, WebP, MP4, WebM, or MOV media." }, 415);
    const declaredLength = Number(request.headers.get("content-length") || 0);
    const isVideo = contentType.startsWith("video/");
    if (declaredLength > MAX_MEDIA_BYTES) return json({ ok: false, message: "The selected photo or video exceeds the 4 MB upload limit. Please compress it and try again." }, 413);
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > MAX_MEDIA_BYTES) return json({ ok: false, message: "The selected file is empty or exceeds the 4 MB upload limit. Please compress it and try again." }, 413);
    const key = `menu-media/${randomUUID()}.${extension}`;
    const mediaKind = request.headers.get("x-media-kind") === "banner" ? "banner" : "product";
    await store.set(key, bytes, { metadata: { contentType, mediaKind, uploadedAt: new Date().toISOString() } });
    let fileName = "promotion";
    try { fileName = decodeURIComponent(request.headers.get("x-file-name") || "promotion").slice(0, 120); } catch (_) { /* use default name */ }
    return json({ ok: true, mediaUrl: `/api/menu-media?key=${encodeURIComponent(key)}`, mediaType: isVideo ? "video" : "image", fileName, sizeBytes: bytes.byteLength }, 201);
  } catch (error) {
    console.error("[menu-media] request failed", error?.stack || error);
    return json({ ok: false, message: "Promotional media service is temporarily unavailable. Please try again." }, 503);
  }
}

export const config = { path: "/api/menu-media", method: ["GET", "POST"] };
