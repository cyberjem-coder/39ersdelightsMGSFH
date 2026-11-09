import { createRequestStore, verifyStoreKey, json } from "../../lib/store.mjs";

function cleanMenu(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 1000).map(row => {
    const stockTracked = row?.stockTracked === true;
    const rawStockQuantity = Number(row?.stockQuantity);
    // Fail closed for a tracked item with an invalid quantity rather than making it orderable.
    const stockQuantity = stockTracked
      ? (Number.isInteger(rawStockQuantity) && rawStockQuantity >= 0 ? rawStockQuantity : 0)
      : null;
    const manualSoldOut = row?.manualSoldOut === true;
    const isSoldOut = manualSoldOut || (stockTracked && stockQuantity === 0) || row?.isSoldOut === true;
    return {
      itemId: String(row?.itemId ?? row?.id ?? "").slice(0, 120),
      itemName: String(row?.itemName ?? row?.title ?? "").slice(0, 200),
      category: String(row?.category ?? "").slice(0, 120),
      icon: String(row?.icon ?? "").slice(0, 80),
      stockTracked,
      stockQuantity,
      manualSoldOut,
      isSoldOut,
      variants: (Array.isArray(row?.variants) ? row.variants : []).slice(0, 30)
        .map(v => ({
          name: String(v?.name ?? "Regular").slice(0, 120),
          price: Number(v?.price) || 0,
        }))
        .filter(v => Number.isFinite(v.price) && v.price > 0 && v.price <= 100000),
    };
  }).filter(item => item.itemId && item.itemName && item.variants.length);
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const RETRY_DELAYS = [300];
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function getErrorStatus(error) {
  return Number(error?.status ?? error?.statusCode ?? error?.response?.status ?? error?.cause?.status ?? 0);
}

function isRetryableStorageError(error) {
  const status = getErrorStatus(error);
  if (RETRYABLE_STATUSES.has(status)) return true;
  const message = String(error?.message ?? error ?? "");
  return /timeout|timed out|temporar|network|fetch failed|socket|ECONNRESET|ETIMEDOUT|EAI_AGAIN|502|503|504|429|internal server error|bad gateway|service unavailable/i.test(message);
}

// A short, bounded retry covers temporary Blobs/API network failures while
// keeping the synchronous Netlify Function comfortably within its time budget.
async function withStorageRetry(operationName, operation) {
  let lastError;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= RETRY_DELAYS.length || !isRetryableStorageError(error)) throw error;
      console.warn(`[mobile-menu] ${operationName} transient failure; retry ${attempt + 1}/${RETRY_DELAYS.length}`, error?.message || error);
      await wait(RETRY_DELAYS[attempt]);
    }
  }
  throw lastError;
}

async function handleRequest(request, setStage, store) {
  if (request.method === "GET") {
    setStage("menu_storage_read");
    const saved = await withStorageRetry("menu read", () => store.get("customer-menu", { type: "json" }));
    return json({ ok: true, menu: Array.isArray(saved?.menu) ? saved.menu : [], updatedAt: saved?.updatedAt ?? null });
  }

  if (request.method === "PUT") {
    // Authorization itself reads/writes Blobs; keep its failure distinct from the menu write.
    setStage("cashier_authorization_storage");
    const authorized = await withStorageRetry("cashier authorization", () =>
      verifyStoreKey(request, store, { registerIfMissing: true })
    );
    if (!authorized) {
      return json({ ok: false, message: "This POS device is not authorized to publish the menu." }, 403);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ ok: false, message: "Invalid JSON request." }, 400); }

    const menu = cleanMenu(body?.menu);
    if (!menu.length) return json({ ok: false, message: "The POS menu is empty or has no valid priced variants." }, 400);

    // Prevent unexpectedly large snapshots from being sent to Blobs.
    const serialized = JSON.stringify(menu);
    if (serialized.length > 3_500_000) {
      return json({ ok: false, message: "The menu snapshot is too large to publish. Please review menu images or descriptions and try again." }, 413);
    }

    const updatedAt = new Date().toISOString();
    const snapshot = { menu, updatedAt };
    // This is an overwrite of one fixed key, so retrying the identical snapshot is safe.
    setStage("menu_storage_write");
    const saved = await withStorageRetry("menu write", () => store.setJSON("customer-menu", snapshot));
    return json({ ok: true, count: menu.length, updatedAt, modified: saved?.modified ?? true });
  }

  return json({ ok: false, message: "Method not allowed." }, 405, { Allow: "GET, PUT" });
}

function safeDiagnostic(error, stage) {
  const providerStatus = getErrorStatus(error);
  const rawCode = String(error?.code ?? error?.cause?.code ?? "");
  const errorCode = /^[A-Za-z0-9_:-]{1,48}$/.test(rawCode) ? rawCode : null;
  const rawName = String(error?.name ?? "Error");
  const errorType = /^[A-Za-z][A-Za-z0-9_]{0,48}$/.test(rawName) ? rawName : "Error";
  return {
    stage,
    errorType,
    errorCode,
    providerStatus: providerStatus > 0 && providerStatus < 600 ? providerStatus : null,
  };
}

export default async function handler(request) {
  let failureStage = "request_handling";
  try {
    // Create the Blobs client during the request so Netlify's runtime credentials
    // are available. Do not move this back to module scope.
    const store = createRequestStore();
    return await handleRequest(request, stage => { failureStage = stage; }, store);
  } catch (error) {
    const incidentId = `menu-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const diagnostic = safeDiagnostic(error, failureStage);
    console.error(`[mobile-menu] ${incidentId} ${request.method} failed at ${failureStage}`, error?.stack || error);
    return json({
      ok: false,
      code: "MENU_SERVICE_TEMPORARILY_UNAVAILABLE",
      message: "Netlify could not publish or load the menu right now. Please try again in a moment.",
      incidentId,
      diagnostic,
    }, 503, {
      "Retry-After": "2",
      "X-Menu-Incident-Id": incidentId,
      "X-Menu-Diagnostic-Stage": failureStage,
    });
  }
}

export const config = { path: "/api/mobile-menu", method: ["GET", "PUT"] };
