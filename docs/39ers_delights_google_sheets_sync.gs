/**
 * 39ers Delights POS → Google Sheets
 * Paste into Extensions → Apps Script in the destination spreadsheet.
 * Tabs are generated automatically with readable headers. Transaction and audit rows
 * are upserted/deduplicated; the item, menu, and inventory tabs are refreshed snapshots.
 */
const POS_TIME_ZONE = 'Asia/Manila';

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const payload = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (payload.app === '39ers Delights POS' && payload.action === 'submitMobileOrder') {
      return jsonResponse(saveMobileOrder_(payload));
    }
    if (payload.app === '39ers Delights POS' && ['confirmMobileOrder', 'rejectMobileOrder'].includes(payload.action)) {
      return jsonResponse(updateMobileOrderStatus_(payload.token, payload.action === 'confirmMobileOrder' ? 'CONFIRMED' : 'REJECTED'));
    }
    if (payload.app !== '39ers Delights POS' || payload.schemaVersion !== 1) {
      return jsonResponse({ ok: false, message: 'Unsupported payload' });
    }
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    ss.setSpreadsheetTimeZone(POS_TIME_ZONE);

    // A void removes the original transaction from active sales reporting while its reason
    // is retained in Audit History and in the dedicated long-term Voided Transactions tab.
    const voidedIds = (payload.voidedTransactions || []).map(r => String(r.transactionId || '')).filter(Boolean);
    deleteTransactionRows_(ss, 'Sales Transactions', voidedIds);

    upsertRows_(ss, 'Sales Transactions',
      ['Transaction ID', 'Transaction Date & Time (ISO)', 'Transaction Date & Time (Philippines)', 'Total Amount (PHP)', 'Amount Received (PHP)', 'Change Given (PHP)', 'Payment Method', 'Order Mode', 'Total Items'],
      (payload.transactions || []).map(r => [r.transactionId, r.transactionDateTime, r.localDateTime || formatLocal_(r.transactionDateTime), Number(r.totalAmount) || 0, Number(r.amountReceived) || 0, Number(r.changeGiven) || 0, r.paymentMethod || '', r.orderMode || '', Number(r.itemCount) || 0]), 0);

    upsertRows_(ss, 'Audit History',
      ['Audit ID', 'Change Date & Time (ISO)', 'Change Date & Time (Philippines)', 'Event Type', 'Description', 'Details (JSON)'],
      (payload.auditHistory || []).map(r => [r.auditId, r.dateTime, formatLocal_(r.dateTime), r.event, r.description, r.details || '{}']), 0);

    replaceRows_(ss, 'Voided Transactions',
      ['Transaction ID', 'Voided At (ISO)', 'Voided At (Philippines)', 'Original Total (PHP)', 'Exact Reason', 'Manager Action'],
      (payload.voidedTransactions || []).map(r => [r.transactionId, r.voidedAt, formatLocal_(r.voidedAt), Number(r.originalTotal) || 0, r.reason || '', r.managerAction || 'Transaction voided']));

    replaceRows_(ss, 'Sales Items',
      ['Transaction ID', 'Transaction Date & Time (ISO)', 'Item Name', 'Size / Option', 'Quantity', 'Unit Price (PHP)', 'Line Total (PHP)'],
      (payload.transactionItems || []).map(r => [r.transactionId, r.transactionDateTime, r.itemName, r.option, Number(r.quantity) || 0, Number(r.unitPrice) || 0, Number(r.lineTotal) || 0]));

    replaceRows_(ss, 'Menu Catalog',
      ['Item ID', 'Menu Item Name', 'Category', 'Available Price Options', 'Icon'],
      (payload.menuCatalog || []).map(r => [r.itemId, r.itemName, r.category, r.variants, r.icon]));

    replaceRows_(ss, 'Inventory',
      ['Item ID', 'Menu Item Name', 'Stock Quantity', 'Stock Tracking'],
      (payload.inventory || []).map(r => [r.itemId, r.itemName, r.stockQuantity, r.stockTracking]));

    // CEO dashboard snapshots are refreshed on every automatic POS sync.
    // Raw transaction and line-item tabs above remain the auditable source data.
    const ceoReports = Array.isArray(payload.ceoReports) ? payload.ceoReports : [];
    replaceRows_(ss, 'CEO Summary',
      ['Period Key', 'Reporting Period', 'From (ISO)', 'To (ISO)', 'Successful Orders', 'Net Recorded Sales (PHP)', 'Average Order Value (PHP)', 'Units Sold', 'Report Generated At (ISO)'],
      ceoReports.map(r => [r.period || '', r.label || '', r.from || '', r.to || '', Number(r.orders) || 0, Number(r.sales) || 0, Number(r.averageOrder) || 0, Number(r.units) || 0, payload.exportedAt || '']));
    replaceRows_(ss, 'CEO Item Report',
      ['Period Key', 'Reporting Period', 'Item Name', 'Category', 'Quantity Sold', 'Item Sales (PHP)', 'Orders Containing Item'],
      ceoReports.flatMap(r => (r.items || []).map(i => [r.period || '', r.label || '', i.title || '', i.category || '', Number(i.qty) || 0, Number(i.sales) || 0, Number(i.orders) || 0])));
    replaceRows_(ss, 'CEO Daily Trend',
      ['Period Key', 'Reporting Period', 'Date (Philippines)', 'Recorded Sales (PHP)'],
      ceoReports.flatMap(r => (r.daily || []).map(d => [r.period || '', r.label || '', d.date || '', Number(d.sales) || 0])));
    replaceRows_(ss, 'CEO Transactions',
      ['Period Key', 'Reporting Period', 'Transaction ID', 'Transaction Date & Time (ISO)', 'Total (PHP)', 'Payment Method', 'Order Mode', 'Units'],
      ceoReports.flatMap(r => (r.transactions || []).map(t => [r.period || '', r.label || '', t.id || '', t.date || '', Number(t.total) || 0, t.payment || '', t.orderMode || '', Number(t.itemCount) || 0])));
    replaceRows_(ss, 'CEO Insights',
      ['Period Key', 'Reporting Period', 'Insight', 'Generated At (ISO)'],
      ceoReports.flatMap(r => {
        const items = r.items || [];
        const insights = [];
        if (Number(r.orders) > 0) insights.push('Recorded ' + r.orders + ' successful order(s), generating PHP ' + (Number(r.sales) || 0).toFixed(2) + ' with average order value PHP ' + (Number(r.averageOrder) || 0).toFixed(2) + '.');
        else insights.push('No completed, non-voided orders were included in this reporting period.');
        if (items.length) insights.push('Top item by quantity: ' + items[0].title + ' (' + items[0].qty + ' units, PHP ' + (Number(items[0].sales) || 0).toFixed(2) + ' item sales).');
        if (items.length && Number(r.sales) > 0) insights.push('Item totals are based on stored order line items; they may not equal order totals where discounts, VAT or promos are applied.');
        insights.push('These are sales indicators, not profit estimates; ingredient costs, waste, payroll and operating expenses are not included.');
        return insights.map(x => [r.period || '', r.label || '', x, payload.exportedAt || '']);
      }));

    const status = getOrCreateSheet_(ss, 'Sync Status');
    status.clearContents();
    status.getRange(1, 1, 4, 2).setValues([
      ['Field', 'Value'],
      ['Last successful sync (Philippines)', Utilities.formatDate(new Date(), POS_TIME_ZONE, 'yyyy-MM-dd hh:mm:ss a')],
      ['POS snapshot generated at (ISO)', payload.exportedAt || ''],
      ['Time zone', POS_TIME_ZONE]
    ]);
    styleSheet_(status);
    return jsonResponse({ ok: true, syncedAt: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    return jsonResponse({ ok: false, message: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * GET endpoints use JSONP because browsers commonly block direct cross-origin reads
 * from Apps Script web apps. Supported actions: getMenu and listMobileOrders.
 */
function doGet(e) {
  const params = (e && e.parameter) || {};
  const action = params.action || '';
  let result;
  try {
    if (action === 'getMenu') result = getMobileMenu_();
    else if (action === 'listMobileOrders') result = listMobileOrders_(params.status || 'PENDING');
    else result = { ok: false, message: 'Unsupported action' };
  } catch (err) { result = { ok: false, message: String(err) }; }
  const callback = String(params.callback || '');
  const json = JSON.stringify(result);
  if (callback && /^[A-Za-z_$][0-9A-Za-z_$\.]*$/.test(callback)) {
    return ContentService.createTextOutput(callback + '(' + json + ');').setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return jsonResponse(result);
}

function saveMobileOrder_(payload) {
  if (!payload.token || !payload.code || !Array.isArray(payload.items) || !payload.items.length) return { ok: false, message: 'Invalid order' };
  // Revalidate submitted item IDs, variant names, prices and quantities against the current catalog.
  // Never trust totals or prices supplied by a customer's browser.
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const catalog = getMobileMenu_();
  if (!catalog.ok) return { ok: false, message: 'Menu catalog is not initialized. Sync the POS menu first.' };
  const cleanItems = [];
  let calculatedTotal = 0;
  for (const raw of payload.items) {
    const item = catalog.menu.find(m => m.itemId === String(raw.itemId));
    const variant = item && item.variants.find(v => v.name === String(raw.variantName));
    const qty = Number(raw.qty);
    if (!item || !variant || !Number.isInteger(qty) || qty < 1 || qty > 99) return { ok: false, message: 'An item, price option or quantity is invalid. Please refresh the menu and retry.' };
    cleanItems.push({ itemId: item.itemId, itemName: item.itemName, category: item.category, variantName: variant.name, price: variant.price, qty: qty });
    calculatedTotal += variant.price * qty;
  }
  const sh = getOrCreateSheet_(ss, 'Mobile Orders');
  const headers = mobileOrderHeaders_();
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  const tokenCol = 1;
  const last = sh.getLastRow();
  if (last > 1) {
    const tokens = sh.getRange(2, tokenCol, last - 1, 1).getValues().flat().map(String);
    if (tokens.includes(String(payload.token))) return { ok: true, duplicate: true };
  }
  const now = new Date();
  const row = [String(payload.token), String(payload.code), payload.createdAt || now.toISOString(), formatLocal_(payload.createdAt || now.toISOString()), String(payload.station || 'Counter'), String(payload.orderMode === 'Takeout' ? 'Takeout' : 'Dine-In'), calculatedTotal, String(payload.notes || '').slice(0, 500), JSON.stringify(cleanItems), 'PENDING', '', ''];
  sh.appendRow(row);
  styleSheet_(sh);
  return { ok: true, token: payload.token, code: payload.code };
}

function updateMobileOrderStatus_(token, status) {
  if (!token) return { ok: false, message: 'Missing order token' };
  const sh = getOrCreateSheet_(SpreadsheetApp.getActiveSpreadsheet(), 'Mobile Orders');
  const headers = mobileOrderHeaders_();
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (sh.getLastRow() < 2) return { ok: false, message: 'Order not found' };
  const tokens = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().flat().map(String);
  const idx = tokens.indexOf(String(token));
  if (idx < 0) return { ok: false, message: 'Order not found' };
  const row = idx + 2;
  sh.getRange(row, 10).setValue(status);
  sh.getRange(row, 11).setValue(new Date().toISOString());
  sh.getRange(row, 12).setValue(formatLocal_(new Date().toISOString()));
  return { ok: true, status: status };
}

function listMobileOrders_(status) {
  const sh = getOrCreateSheet_(SpreadsheetApp.getActiveSpreadsheet(), 'Mobile Orders');
  const headers = mobileOrderHeaders_();
  if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  const last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, headers.length).getValues() : [];
  const orders = rows.filter(r => !status || String(r[9]) === String(status)).map(r => ({
    token: String(r[0]), code: String(r[1]), createdAt: String(r[2]), dateTime: String(r[3]), station: String(r[4]),
    orderMode: String(r[5]), total: Number(r[6]) || 0, notes: String(r[7] || ''),
    items: safeParseItems_(r[8]), status: String(r[9]), updatedAt: String(r[10] || '')
  })).reverse();
  return { ok: true, orders: orders.slice(0, 100) };
}

function getMobileMenu_() {
  const sh = getOrCreateSheet_(SpreadsheetApp.getActiveSpreadsheet(), 'Menu Catalog');
  const last = sh.getLastRow();
  if (last < 2) return { ok: false, message: 'No menu catalog found. Open POS and sync all data first.' };
  const rows = sh.getRange(2, 1, last - 1, Math.min(5, sh.getLastColumn())).getValues();
  const menu = rows.map(r => ({ itemId: String(r[0] || ''), itemName: String(r[1] || ''), category: String(r[2] || ''), variants: parseVariants_(String(r[3] || '')) })).filter(i => i.itemId && i.itemName && i.variants.length);
  return { ok: true, menu: menu };
}

function parseVariants_(raw) {
  return raw.split(/\s*\|\s*/).map(part => {
    const match = part.match(/^(.*?):\s*₱?\s*([0-9]+(?:\.[0-9]+)?)$/);
    return match ? { name: match[1].trim(), price: Number(match[2]) } : null;
  }).filter(Boolean);
}
function safeParseItems_(value) { try { const x = JSON.parse(String(value || '[]')); return Array.isArray(x) ? x : []; } catch (_) { return []; } }
function mobileOrderHeaders_() { return ['Order Token', '4-Digit Order Code', 'Submitted At (ISO)', 'Submitted At (Philippines)', 'Table / Station', 'Order Mode', 'Submitted Total (PHP)', 'Special Notes', 'Items (JSON)', 'Status', 'Status Updated At (ISO)', 'Status Updated At (Philippines)']; }

function deleteTransactionRows_(ss, sheetName, transactionIds) {
  const ids = new Set((transactionIds || []).map(String));
  if (!ids.size) return;
  const sh = ss.getSheetByName(sheetName);
  if (!sh || sh.getLastRow() < 2) return;
  // Transaction ID is column A in both Sales Transactions and Sales Items.
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().flat().map(String);
  for (let i = values.length - 1; i >= 0; i--) {
    if (ids.has(values[i])) sh.deleteRow(i + 2);
  }
}

function upsertRows_(ss, name, headers, incoming, keyColumnIndex) {
  const sheet = getOrCreateSheet_(ss, name);
  const existingLastRow = sheet.getLastRow();
  const existing = existingLastRow > 1 ? sheet.getRange(2, 1, existingLastRow - 1, headers.length).getValues() : [];
  const rowByKey = new Map();
  existing.forEach((row, i) => rowByKey.set(String(row[keyColumnIndex]), i));
  incoming.forEach(row => {
    const key = String(row[keyColumnIndex] || '');
    if (!key) return;
    if (rowByKey.has(key)) existing[rowByKey.get(key)] = row;
    else { rowByKey.set(key, existing.length); existing.push(row); }
  });
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (existing.length) sheet.getRange(2, 1, existing.length, headers.length).setValues(existing);
  styleSheet_(sheet);
}

function replaceRows_(ss, name, headers, rows) {
  const sheet = getOrCreateSheet_(ss, name);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  styleSheet_(sheet);
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function styleSheet_(sheet) {
  const width = sheet.getLastColumn();
  if (!width) return;
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, width).setFontWeight('bold').setWrap(true);
  sheet.getDataRange().setVerticalAlignment('top');
  sheet.autoResizeColumns(1, width);
  for (let col = 1; col <= width; col++) {
    if (sheet.getColumnWidth(col) > 360) sheet.setColumnWidth(col, 360);
  }
}

function formatLocal_(isoValue) {
  if (!isoValue) return '';
  const date = new Date(isoValue);
  if (isNaN(date.getTime())) return String(isoValue);
  return Utilities.formatDate(date, POS_TIME_ZONE, 'yyyy-MM-dd hh:mm:ss a');
}

function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

// Run manually once in the Apps Script editor to create the expected tabs and grant permissions.
function setupPosSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(POS_TIME_ZONE);
  [
    ['Sales Transactions', ['Transaction ID', 'Transaction Date & Time (ISO)', 'Transaction Date & Time (Philippines)', 'Total Amount (PHP)', 'Amount Received (PHP)', 'Change Given (PHP)', 'Payment Method', 'Order Mode', 'Total Items']],
    ['Sales Items', ['Transaction ID', 'Transaction Date & Time (ISO)', 'Item Name', 'Size / Option', 'Quantity', 'Unit Price (PHP)', 'Line Total (PHP)']],
    ['Audit History', ['Audit ID', 'Change Date & Time (ISO)', 'Change Date & Time (Philippines)', 'Event Type', 'Description', 'Details (JSON)']],
    ['Voided Transactions', ['Transaction ID', 'Voided At (ISO)', 'Voided At (Philippines)', 'Original Total (PHP)', 'Exact Reason', 'Manager Action']],
    ['Menu Catalog', ['Item ID', 'Menu Item Name', 'Category', 'Available Price Options', 'Icon']],
    ['Inventory', ['Item ID', 'Menu Item Name', 'Stock Quantity', 'Stock Tracking']],
    ['CEO Summary', ['Period Key', 'Reporting Period', 'From (ISO)', 'To (ISO)', 'Successful Orders', 'Net Recorded Sales (PHP)', 'Average Order Value (PHP)', 'Units Sold', 'Report Generated At (ISO)']],
    ['CEO Item Report', ['Period Key', 'Reporting Period', 'Item Name', 'Category', 'Quantity Sold', 'Item Sales (PHP)', 'Orders Containing Item']],
    ['CEO Daily Trend', ['Period Key', 'Reporting Period', 'Date (Philippines)', 'Recorded Sales (PHP)']],
    ['CEO Transactions', ['Period Key', 'Reporting Period', 'Transaction ID', 'Transaction Date & Time (ISO)', 'Total (PHP)', 'Payment Method', 'Order Mode', 'Units']],
    ['CEO Insights', ['Period Key', 'Reporting Period', 'Insight', 'Generated At (ISO)']],
    ['Sync Status', ['Field', 'Value']],
    ['Mobile Orders', mobileOrderHeaders_()]
  ].forEach(([name, headers]) => {
    const sh = getOrCreateSheet_(ss, name);
    if (sh.getLastRow() === 0) sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    styleSheet_(sh);
  });
}
