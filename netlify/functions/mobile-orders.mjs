import { createRequestStore, verifyStoreKey, json } from "../../lib/store.mjs";

const orderKey = token => `order-${token}`;
const proofKey = token => `payment-proof-${token}`;
const MAX_PROOF_BYTES = 900 * 1024;
const APPS_SCRIPT_URL = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec(?:\?.*)?$/;

function safeProofDataUrl(value) {
  const match = String(value || "").match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length || buffer.length > MAX_PROOF_BYTES) return null;
  return { dataUrl: String(value), contentType: match[1].toLowerCase(), sizeBytes: buffer.length };
}

function proofSummary(proof) {
  if (!proof) return null;
  return {
    fileName: proof.fileName || "GCash-payment-proof.jpg",
    contentType: proof.contentType || "image/jpeg",
    sizeBytes: Number(proof.sizeBytes) || 0,
    uploadedAt: proof.uploadedAt || "",
    status: proof.status || "PENDING_VERIFICATION",
    verifiedAt: proof.verifiedAt || "",
    sheetsSyncStatus: proof.sheetsSyncStatus || "PENDING",
    driveUrl: proof.driveUrl || "",
    sheetsSyncMessage: proof.sheetsSyncMessage || "",
  };
}

async function sendProofToGoogleSheets(url, order, proofData, proofMeta) {
  if (!url || !APPS_SCRIPT_URL.test(url)) {
    return { synced: false, status: "NOT_CONNECTED", message: "Google Sheets is not connected on this POS device. The screenshot remains safely stored with the mobile order." };
  }
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        app: "39ers Delights POS",
        action: "saveGcashPaymentProof",
        token: order.token,
        code: order.code,
        station: order.station,
        total: order.total,
        submittedAt: order.createdAt,
        uploadedAt: proofMeta.uploadedAt,
        verifiedAt: proofMeta.verifiedAt,
        verificationStatus: proofMeta.status,
        fileName: proofMeta.fileName,
        contentType: proofMeta.contentType,
        proofDataUrl: proofData.dataUrl,
      }),
      redirect: "follow",
    });
    const responseText = await response.text();
    let result;
    try { result = JSON.parse(responseText); } catch { result = null; }
    if (!response.ok || !result?.ok) {
      return { synced: false, status: "FAILED", message: result?.message || `Google Apps Script returned HTTP ${response.status}. Update and redeploy the companion Google Apps Script before retrying.` };
    }
    return { synced: true, status: "SYNCED", driveUrl: String(result.fileUrl || ""), message: "Screenshot saved to the private Google Drive folder and linked in the GCash Payment Proofs sheet." };
  } catch (error) {
    return { synced: false, status: "FAILED", message: `Google Sheets upload could not be confirmed: ${error?.message || error}` };
  }
}

export default async function handler(request) {
  // Netlify Blobs credentials are supplied in the active Functions request context.
  const store = createRequestStore();
  const url = new URL(request.url);

  if (request.method === "GET") {
    const proofToken = url.searchParams.get("proof");
    if (proofToken) {
      if (!/^MO-[A-Z0-9-]{6,40}$/.test(proofToken) || !(await verifyStoreKey(request, store))) {
        return json({ ok: false, message: "POS device not authorized." }, 403);
      }
      const proof = await store.get(proofKey(proofToken), { type: "json" });
      if (!proof?.dataUrl) return json({ ok: false, message: "Payment screenshot not found." }, 404);
      return json({ ok: true, proof: { ...proofSummary(proof), dataUrl: proof.dataUrl } });
    }

    const token = url.searchParams.get("token");
    if (token) {
      const order = await store.get(orderKey(token), { type: "json" });
      if (!order) return json({ ok: false, message: "Order not found." }, 404);
      return json({ ok: true, order: { token: order.token, code: order.code, status: order.status, paymentMethod: order.paymentMethod, paymentProof: proofSummary(order.paymentProof) } });
    }

    if (!(await verifyStoreKey(request, store))) return json({ ok: false, message: "POS device not authorized." }, 403);
    const status = (url.searchParams.get("status") || "PENDING").toUpperCase();
    if (!["PENDING", "CONFIRMED", "REJECTED"].includes(status)) {
      return json({ ok: false, message: "Invalid order status." }, 400);
    }

    const { blobs } = await store.list({ prefix: "order-" });
    const records = await Promise.all(blobs.map(blob => store.get(blob.key, { type: "json" })));
    const orders = records
      .filter(order => order && order.status === status)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .slice(0, 200);
    return json({ ok: true, orders });
  }

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, message: "Invalid JSON request." }, 400); }

    const token = String(body?.token ?? "");
    if (!/^MO-[A-Z0-9-]{6,40}$/.test(token)) return json({ ok: false, message: "Invalid order token." }, 400);
    const requestedItems = Array.isArray(body?.items) ? body.items : [];
    if (!requestedItems.length || requestedItems.length > 50) {
      return json({ ok: false, message: "Please submit between 1 and 50 menu lines." }, 400);
    }
    if (await store.get(orderKey(token), { type: "json" })) {
      return json({ ok: false, message: "This order was already submitted. Please do not submit it again." }, 409);
    }

    const paymentMethod = body?.paymentMethod === "GCASH_QR" ? "GCASH_QR" : "CASH";
    let paymentProof = null;
    let storedProof = null;
    if (paymentMethod === "GCASH_QR") {
      storedProof = safeProofDataUrl(body?.paymentProof?.dataUrl);
      if (!storedProof) {
        return json({ ok: false, message: "Please attach a clear GCash payment screenshot (JPEG, PNG or WebP, up to 900 KB) before submitting this GCash order." }, 400);
      }
      paymentProof = {
        fileName: String(body?.paymentProof?.fileName || "GCash-payment-proof.jpg").replace(/[\\/:*?"<>|]/g, "_").slice(0, 100),
        contentType: storedProof.contentType,
        sizeBytes: storedProof.sizeBytes,
        uploadedAt: new Date().toISOString(),
        status: "PENDING_VERIFICATION",
        verifiedAt: "",
        sheetsSyncStatus: "PENDING",
        driveUrl: "",
        sheetsSyncMessage: "",
      };
    }

    const published = await store.get("customer-menu", { type: "json" });
    const publishedMenu = Array.isArray(published?.menu) ? published.menu : [];
    if (!publishedMenu.length) return json({ ok: false, message: "The store menu is not published yet." }, 503);

    // Resolve prices and names from the published POS menu. Never trust a phone's posted price.
    // Availability is checked against the latest published stock snapshot; checkout remains the final stock deduction.
    const items = [];
    const requestedQuantityByItem = new Map();
    for (const requested of requestedItems) {
      const itemId = String(requested?.itemId ?? "").slice(0, 120);
      const item = publishedMenu.find(row => String(row.itemId) === itemId);
      const variantName = String(requested?.variantName ?? "").slice(0, 120);
      const variant = item?.variants?.find(row => String(row.name) === variantName);
      const qty = Number(requested?.qty);
      if (!item || !variant || !Number.isInteger(qty) || qty < 1 || qty > 99) {
        return json({ ok: false, message: "One or more items are no longer available. Refresh the menu and try again." }, 400);
      }
      if (item.isSoldOut === true || item.manualSoldOut === true || (item.stockTracked === true && Number(item.stockQuantity) <= 0)) {
        return json({ ok: false, message: `${item.itemName} is SOLD OUT. Please remove it from your order.` }, 409);
      }
      const requestedTotal = (requestedQuantityByItem.get(itemId) || 0) + qty;
      if (item.stockTracked === true && requestedTotal > Number(item.stockQuantity)) {
        return json({ ok: false, message: `Only ${Math.max(0, Number(item.stockQuantity) || 0)} unit(s) of ${item.itemName} are currently available.` }, 409);
      }
      requestedQuantityByItem.set(itemId, requestedTotal);
      const price = Number(variant.price);
      if (!Number.isFinite(price) || price <= 0 || price > 100000) {
        return json({ ok: false, message: "A menu item has an invalid price. Please ask the cashier." }, 400);
      }
      items.push({ itemId: item.itemId, itemName: item.itemName, category: item.category, variantName: variant.name, price, qty });
    }

    const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
    const order = {
      token,
      code: String(body?.code ?? "").replace(/\D/g, "").slice(0, 6) || String(Math.floor(1000 + Math.random() * 9000)),
      station: String(body?.station ?? "Counter").slice(0, 60),
      orderMode: body?.orderMode === "Takeout" ? "Takeout" : "Dine-In",
      paymentMethod,
      paymentProof,
      notes: String(body?.notes ?? "").slice(0, 500),
      items,
      total: Number(total.toFixed(2)),
      status: "PENDING",
      dateTime: String(body?.dateTime ?? "").slice(0, 80),
      createdAt: String(body?.createdAt ?? new Date().toISOString()).slice(0, 50),
      updatedAt: new Date().toISOString(),
    };

    // Store the screenshot separately from the order list so POS polling does not download large images.
    if (storedProof) {
      await store.setJSON(proofKey(token), {
        dataUrl: storedProof.dataUrl,
        fileName: paymentProof.fileName,
        contentType: storedProof.contentType,
        sizeBytes: storedProof.sizeBytes,
        uploadedAt: paymentProof.uploadedAt,
      }, { onlyIfNew: true });
    }
    const saved = await store.setJSON(orderKey(token), order, { onlyIfNew: true });
    if (!saved.modified) return json({ ok: false, message: "This order was already submitted. Please do not submit it again." }, 409);
    return json({ ok: true, token, order: { code: order.code, total: order.total, status: order.status, paymentProof: proofSummary(order.paymentProof) } }, 201);
  }

  if (request.method === "PATCH") {
    if (!(await verifyStoreKey(request, store))) return json({ ok: false, message: "POS device not authorized." }, 403);
    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, message: "Invalid JSON request." }, 400); }

    const token = String(body?.token ?? "");
    if (!/^MO-[A-Z0-9-]{6,40}$/.test(token)) return json({ ok: false, message: "Invalid order token." }, 400);
    const existing = await store.getWithMetadata(orderKey(token), { type: "json" });
    if (!existing) return json({ ok: false, message: "Order not found." }, 404);

    if (body?.action === "verifyGcashPayment" || body?.action === "syncGcashPaymentProof") {
      const order = existing.data;
      if (order.paymentMethod !== "GCASH_QR" || !order.paymentProof) {
        return json({ ok: false, message: "This order has no GCash payment screenshot to verify." }, 400);
      }
      if (body.action === "syncGcashPaymentProof" && order.paymentProof.status !== "VERIFIED") {
        return json({ ok: false, message: "Verify the GCash payment in your GCash merchant account before syncing it." }, 409);
      }
      const proofData = await store.get(proofKey(token), { type: "json" });
      if (!proofData?.dataUrl) return json({ ok: false, message: "The stored payment screenshot is missing. Keep the order on hold and request the customer to resubmit the screenshot." }, 404);

      const now = new Date().toISOString();
      const nextProof = {
        ...order.paymentProof,
        status: body.action === "verifyGcashPayment" ? "VERIFIED" : order.paymentProof.status,
        verifiedAt: body.action === "verifyGcashPayment" ? (order.paymentProof.verifiedAt || now) : order.paymentProof.verifiedAt,
      };
      const sheetResult = await sendProofToGoogleSheets(String(body?.googleSheetsUrl || ""), order, proofData, nextProof);
      nextProof.sheetsSyncStatus = sheetResult.status;
      nextProof.driveUrl = sheetResult.driveUrl || nextProof.driveUrl || "";
      nextProof.sheetsSyncMessage = sheetResult.message;
      const updated = { ...order, paymentProof: nextProof, updatedAt: now };
      const saved = await store.setJSON(orderKey(token), updated, { onlyIfMatch: existing.etag });
      if (!saved.modified) return json({ ok: false, message: "The order changed while payment proof was being updated. Refresh the order and try again." }, 409);
      return json({
        ok: true,
        paymentProof: proofSummary(nextProof),
        sheetsSynced: sheetResult.synced,
        message: sheetResult.message,
      });
    }

    const status = body?.action === "confirmMobileOrder" ? "CONFIRMED"
      : body?.action === "rejectMobileOrder" ? "REJECTED" : "";
    if (!status) return json({ ok: false, message: "Unknown action or missing order token." }, 400);
    if (existing.data.status !== "PENDING") {
      return json({ ok: false, message: `Order is already ${existing.data.status}.` }, 409);
    }

    const updated = { ...existing.data, status, updatedAt: new Date().toISOString() };
    const saved = await store.setJSON(orderKey(token), updated, { onlyIfMatch: existing.etag });
    if (!saved.modified) return json({ ok: false, message: "This order was updated by another cashier. Refresh the queue." }, 409);
    return json({ ok: true, token, status });
  }

  return json({ ok: false, message: "Method not allowed." }, 405, { Allow: "GET, POST, PATCH" });
}

export const config = { path: "/api/mobile-orders", method: ["GET", "POST", "PATCH"] };
