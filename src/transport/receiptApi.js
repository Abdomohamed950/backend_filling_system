/*
 * HTTP client لـ Receipt API (KorapTmp) — مقابل get_receipts_from_api /
 * update_receipt_status في database.py القديم. يستخدم fetch المدمج في Node
 * (v18+) بدل إضافة axios.
 */

const TIMEOUT_MS = 3000;

/** GET {baseUrl}/today?from=&to= */
async function fetchToday(baseUrl, fromDate, toDate) {
  const url = `${baseUrl}/today?from=${encodeURIComponent(fromDate)}&to=${encodeURIComponent(toDate)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET /today -> HTTP ${res.status}`);
  return res.json();
}

/** POST {baseUrl}/Consume */
async function postConsume(baseUrl, payload) {
  const res = await fetch(`${baseUrl}/Consume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`POST /Consume -> HTTP ${res.status}`);
  return res.json().catch(() => null);
}

module.exports = { fetchToday, postConsume };
