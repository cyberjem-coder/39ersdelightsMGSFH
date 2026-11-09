# 39ers Delights POS — Complete Netlify Project

This is a complete deployable project package with the customer-facing mobile QR ordering improvements and the supplied 39ers Delights jingle.

## Folder layout

```text
.
├── public/
│   ├── index.html
│   ├── reset-pos-device.html
│   └── assets/
│       └── 39ers-delights-jingle.mp3
├── netlify/
│   └── functions/
│       ├── mobile-menu.mjs
│       ├── mobile-orders.mjs
│       └── reset-pos-device.mjs
├── lib/
│   └── store.mjs
├── docs/
│   ├── 39ers_delights_google_sheets_setup_CEO.txt
│   └── 39ers_delights_google_sheets_sync.gs
├── netlify.toml
├── package.json
├── .gitignore
└── README.md
```

The `netlify.toml` publishes `public/` and loads functions from `netlify/functions/`. Keep this folder structure exactly as shown.

## Netlify Blobs SDK version in this bundle

This complete bundle pins `@netlify/blobs` to **11.1.7** in `package.json`.
The existing Netlify site-wide store name (`39ers-delights-mobile-orders`),
menu key (`customer-menu`), cashier authorization key, and `lib/store.mjs`
helper are unchanged. Keep Netlify's Node.js setting at **24.x**; Blobs v11
requires Node.js 22.12 or newer.

The v11 release line includes a refreshed-signed-URL retry fix (11.0.3),
response-body cancellation fix (11.1.4), and a concurrent conditional-write
race fix (11.1.7). Version 11.1.7 is selected here to avoid the reported transitive
`@netlify/otel@^7.0.7` installation failure. `package.json` also pins the
transitive `@netlify/otel` dependency to `7.0.6` through npm overrides. This SDK update is a targeted attempt to address
the observed Blobs read failure, not a guarantee against all BlobsInternalError
responses or Netlify outages. See `BLOBS_SDK_UPGRADE_NOTES.txt`.

## Customer-facing mobile QR improvements

- Sticky checkout summary/button is the first item at the top of the mobile ordering page.
- The selected category gets a gold indicator that slides to the active tab; the active tab also receives a highlighted state.
- The most recently selected item card is visibly highlighted; items already in the tray remain highlighted.
- Category, Dine-In/Takeout, and item selection actions play a short two-tone sound cue.
- The supplied MP3 is loaded from `/assets/39ers-delights-jingle.mp3` and playback is attempted on each QR-page visit.
- If a mobile browser blocks autoplay, the first touch/pointer interaction attempts to start the jingle; a visible Play/Pause control remains available.

**Mobile audio limitation:** iOS Safari and some Android browsers restrict autoplay with sound until a user gesture. A website cannot override that browser policy. The package attempts autoplay, then starts the audio on the first customer interaction and provides an explicit Play jingle control. Actual behavior must be checked on the customer's phone, with media volume on and silent mode off.

## Mobile menu publish/load recovery for HTTP 502/503/504

This release specifically addresses the cashier-side **menu publish** request as well as customer-side menu reads:
- The cashier POS retries transient 502/503/504, timeout, and network failures up to four times with bounded delays. It also serializes publishing requests so multiple stock/order updates cannot send overlapping writes to the same menu key.
- The `mobile-menu` function retries transient Blobs authorization checks and menu writes. A write uses the same fixed key and same snapshot during retries, so a timed-out overwrite can safely be repeated.
- If the function catches a persistent storage failure, it returns a controlled 503 with an incident ID and `Retry-After` header. A platform/gateway 502 that happens before the function starts can still occur; the POS retries it, but Netlify function logs are needed to diagnose the platform-side cause.
- The customer page retries 502/503/504 responses, keeps the most recently loaded public menu in that customer's browser, and shows a small reconnect notice rather than removing the menu. It retries in the background once per minute.

The cached menu is display-only. Before a customer can submit an order, the page still fetches the current published menu and the mobile-orders function validates availability and stock again. A failed fresh check prevents submission; it never records a sale or deducts inventory.

If this continues, open Netlify → Functions → `mobile-menu` → Logs and look for `[mobile-menu]` plus the incident ID shown in the customer response. The logged exception is needed to identify the underlying storage/platform error. Do not clear the Netlify Blobs store or reset cashier authorization as a response to a menu 502.

## Existing POS and order workflow retained

The full POS page is preserved, with the previously-added Sold Out and mobile ordering controls included. The project retains existing menu/category and variant editing, cart and checkout, VAT, discounts/promotions, receipts, transaction records, inventory, audit and reports, Google Sheets setup/sync files, cashier authorization, QR menu publishing, incoming mobile-order review, and order import.

Mobile-order confirmation continues to import into the POS cart only. It does not complete a sale or deduct inventory. The normal cashier checkout remains the sale-recording and stock-deduction path.

Sold Out behavior included:
- Automatically unavailable when a tracked inventory item reaches zero.
- Manual Sold Out override from the POS inventory controls.
- QR menu shows Sold Out and disables ordering for unavailable items.
- The order API rechecks published Sold Out status and tracked stock before accepting an order.

## Important data and deployment notes

- This ZIP contains application source and the supplied jingle. It does **not** contain live browser localStorage, Netlify Blobs orders, sales history, inventory records, device keys, or secrets.
- Do not clear browser data or delete the existing Netlify Blobs store when deploying this package.
- Keep the existing Google Apps Script deployment and spreadsheet data. The Google Sheets setup and sync source files in `docs/` are included unchanged from the previous project package.
- Existing cashier inventory/sales data remains in the browser profile where the POS has been used. Keep that browser profile and your separate backups.
- Do not commit private tokens or environment-variable values to GitHub. The device-reset function requires `POS_DEVICE_RESET_TOKEN` only when used.

## Upload to an existing GitHub repository

1. Make a backup of the repository and work on the separate `mobile-qr-update` branch, not the production branch.
2. Extract this ZIP on your computer. Upload the **contents** of the extracted folder to the repository root, preserving the paths shown in the folder layout above. Do not upload the ZIP itself, and do not upload the containing parent folder as an extra nested directory.
3. If the repository already has root-level files such as `index.html`, `mobile-menu.mjs`, `mobile-orders.mjs`, `store.mjs`, or `reset-pos-device.mjs`, leave them in place. The Netlify configuration uses the correctly located `public/`, `netlify/functions/`, and `lib/` copies.
4. Keep `netlify.toml` at repository root. It should contain:

   ```toml
   [build]
     publish = "public"
     functions = "netlify/functions"

   [functions]
     node_bundler = "esbuild"
   ```

5. If GitHub prompts about an existing same-named root file, do not guess. Check that `netlify.toml` matches the block above and that `package.json` includes `@netlify/blobs`. Keep the repository backup before committing changes.
6. Create a pull request from `mobile-qr-update` into the production branch and use a Netlify Deploy Preview first, if Deploy Previews are enabled. Do not merge until the POS, mobile menu, order submission, Sold Out behavior, and jingle have been checked.

## Before going live

Test with a real phone:
- QR opens the customer order page and menu loads.
- Checkout bar is at the very top and remains visible when scrolling.
- Gold category indicator visibly moves when another category is selected.
- Selected product card visibly highlights when a variant is tapped.
- Tap feedback sound is audible.
- Jingle starts automatically where the phone permits it, or starts on the first touch / Play jingle tap.
- Sold Out items cannot be added or submitted.
- A test order reaches the cashier queue; confirming imports it into the cart only.
- A normal test checkout records the sale and updates tracked stock as expected.

This package has passed static syntax and archive-integrity checks in the local build environment. It has not been deployed to the user's Netlify site or tested on the user's actual phone.

## Menu error diagnostics (additional in this bundle)

This bundle also includes a diagnostic stage in errors from `/api/mobile-menu`.
When an operation fails, the function returns a sanitized diagnostic summary:
- `cashier_authorization_storage`
- `menu_storage_read`
- `menu_storage_write`

The cashier POS displays the stage and safe error metadata alongside the incident ID.
This is intended to identify which storage operation failed when Netlify function logs
are not accessible. It does not expose raw stack traces, device keys, or tokens.

See `MENU_ERROR_DIAGNOSTICS.txt` for the short guide. This is diagnostic instrumentation,
not a guarantee that Netlify or its storage service will never return a 502/503/504.


## Latest storage-context correction

The Netlify Blobs store is now created inside each Functions v2 request handler rather than at module import time. The site-wide store name and keys are unchanged. See `REQUEST_SCOPED_BLOBS_FIX_NOTES.txt` for safe deployment instructions.
