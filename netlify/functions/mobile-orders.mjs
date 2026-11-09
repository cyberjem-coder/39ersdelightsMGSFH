import { createRequestStore, verifyStoreKey, json } from "../../lib/store.mjs";

const orderKey = token => `order-${token}`;

export default async function handler(request) {
  // Netlify Blobs credentials are supplied in the active Functions request context.
  const store = createRequestStore();
  const url = new URL(request.url);

  if (request.method === "GET") {
    const token = url.searchParams.get("token");
    if (token) {
      const order = await store.get(orderKey(token), { type: "json" });
      if (!order) return json({ ok: false, message: "Order not found." }, 404);
      return json({ ok: true, order: { token: order.token, code: order.code, status: order.status } });
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
      items.push({
        itemId: item.itemId,
        itemName: item.itemName,
        category: item.category,
        variantName: variant.name,
        price,
        qty,
      });
    }

    const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
    const order = {
      token,
      code: String(body?.code ?? "").replace(/\D/g, "").slice(0, 6) || String(Math.floor(1000 + Math.random() * 9000)),
      station: String(body?.station ?? "Counter").slice(0, 60),
      orderMode: body?.orderMode === "Takeout" ? "Takeout" : "Dine-In",
      notes: String(body?.notes ?? "").slice(0, 500),
      items,
      total: Number(total.toFixed(2)),
      status: "PENDING",
      dateTime: String(body?.dateTime ?? "").slice(0, 80),
      createdAt: String(body?.createdAt ?? new Date().toISOString()).slice(0, 50),
      updatedAt: new Date().toISOString(),
    };

    const saved = await store.setJSON(orderKey(token), order, { onlyIfNew: true });
    if (!saved.modified) return json({ ok: false, message: "This order was already submitted. Please do not submit it again." }, 409);
    return json({ ok: true, token, order: { code: order.code, total: order.total, status: order.status } }, 201);
  }

  if (request.method === "PATCH") {
    if (!(await verifyStoreKey(request, store))) return json({ ok: false, message: "POS device not authorized." }, 403);
    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, message: "Invalid JSON request." }, 400); }

    const status = body?.action === "confirmMobileOrder" ? "CONFIRMED"
      : body?.action === "rejectMobileOrder" ? "REJECTED" : "";
    const token = String(body?.token ?? "");
    if (!status || !token) return json({ ok: false, message: "Unknown action or missing order token." }, 400);

    const existing = await store.getWithMetadata(orderKey(token), { type: "json" });
    if (!existing) return json({ ok: false, message: "Order not found." }, 404);
    if (existing.data.status !== "PENDING") {
      return json({ ok: false, message: `Order is already ${existing.data.status}.` }, 409);
    }

    const updated = {
      ...existing.data,
      status,
      updatedAt: new Date().toISOString(),
    };
    const saved = await store.setJSON(orderKey(token), updated, { onlyIfMatch: existing.etag });
    if (!saved.modified) return json({ ok: false, message: "This order was updated by another cashier. Refresh the queue." }, 409);
    return json({ ok: true, token, status });
  }

  return json({ ok: false, message: "Method not allowed." }, 405, { Allow: "GET, POST, PATCH" });
}

export const config = { path: "/api/mobile-orders", method: ["GET", "POST", "PATCH"] };
