const db = require("../config/database");
const { toLocalStamp } = require("../utils/time");

// الحدّ الأدنى/الأقصى للنطاق الزمني عند غياب from/to (نفس نمط historyModel)
const MIN_STAMP = "0000-01-01 00:00:00";
const MAX_STAMP = "9999-12-31 23:59:59";

// نسخة محلية من إيصالات Receipt API — مصدر التحقق لنظام الباركود (بلا شبكة)
const receipts = {
  findByNum: async (receiptNum) => {
    const result = await db.query(
      "SELECT * FROM receipts WHERE receiptNum = $1",
      [String(receiptNum).trim()]
    );
    return result.rows[0];
  },

  /*
   * قائمة الإيصالات لشاشة الواجهة — فلترة اختيارية بالحالة (checked)
   * وبتاريخ الجلب (fetchedAt)، وبحث بجزء من رقم الإيصال.
   */
  findAll: async ({ checked, from, to, search } = {}) => {
    const conditions = [];
    const values = [];

    if (checked !== undefined && checked !== null && checked !== "") {
      values.push(Number(checked) ? 1 : 0);
      conditions.push(`checked = $${values.length}`);
    }
    if (search) {
      values.push(`%${String(search).trim()}%`);
      conditions.push(`receiptNum LIKE $${values.length}`);
    }
    values.push(toLocalStamp(from, MIN_STAMP));
    conditions.push(`fetchedAt >= $${values.length}`);
    values.push(toLocalStamp(to, MAX_STAMP));
    conditions.push(`fetchedAt <= $${values.length}`);

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await db.query(
      `SELECT * FROM receipts ${where} ORDER BY fetchedAt DESC`,
      values
    );
    return result.rows;
  },

  // INSERT OR IGNORE لكل إيصال — إيصال موجود محليًا (مثلاً اتعلّم checked)
  // مايتلخبطش بنسخة قديمة راجعة من الـ API
  upsertMany: async (list) => {
    let inserted = 0;
    for (const item of list) {
      if (!item || !item.receiptNum) continue;
      const result = await db.query(
        `INSERT OR IGNORE INTO receipts (receiptNum, waterQuantity)
         VALUES ($1, $2)`,
        [String(item.receiptNum).trim(), item.waterQuantity ?? null]
      );
      inserted += result.rowCount;
    }
    return inserted;
  },

  markChecked: async (receiptNum) => {
    const result = await db.query(
      `UPDATE receipts SET checked = 1 WHERE receiptNum = $1 RETURNING *`,
      [String(receiptNum).trim()]
    );
    return result.rows[0];
  },

  markSyncPending: async (receiptNum, pending) => {
    const result = await db.query(
      `UPDATE receipts SET syncPending = $2 WHERE receiptNum = $1 RETURNING *`,
      [String(receiptNum).trim(), pending ? 1 : 0]
    );
    return result.rows[0];
  },

  findPendingConsume: async () => {
    const result = await db.query(
      "SELECT * FROM receipts WHERE syncPending = 1"
    );
    return result.rows;
  },
};

module.exports = receipts;
