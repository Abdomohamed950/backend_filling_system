#!/usr/bin/env node
/*
 * إيصالات تجريبية لاختبار /api/receipts ونظام الباركود.
 *   node scripts/seed-receipts.js
 *
 * آمن للتكرار (upsert بدون تكرار صفوف). لا يلمس أي جدول تاني.
 */

const db = require("../src/config/database");
db.init();

const receiptRows = [
  // [receiptNum, waterQuantity, checked, syncPending]
  ["REC-1001", 25, 0, 0], // صالح للاستخدام
  ["REC-1002", 40, 0, 0], // صالح للاستخدام
  ["REC-1003", 15, 1, 0], // مستخدَم بالفعل ومتزامن مع السيرفر
  ["REC-1004", 30, 1, 1], // مستخدَم لكن فشل تعليمه على السيرفر (شارة "مزامنة معلّقة")
  ["REC-1005", 60, 0, 0], // صالح للاستخدام
];

const upsert = db.db.prepare(`
  INSERT INTO receipts (receiptNum, waterQuantity, checked, syncPending)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(receiptNum) DO UPDATE SET
    waterQuantity = excluded.waterQuantity,
    checked       = excluded.checked,
    syncPending   = excluded.syncPending
`);

for (const row of receiptRows) {
  upsert.run(...row);
  console.log(`✅ receipts: ${row[0]} (waterQuantity=${row[1]}, checked=${row[2]}, syncPending=${row[3]})`);
}

console.log("\n📋 جاهز للاختبار:");
console.log("   GET /api/receipts                -> كل الإيصالات الخمسة");
console.log("   GET /api/receipts?checked=0       -> REC-1001, REC-1002, REC-1005 (صالحة)");
console.log("   GET /api/receipts?checked=1       -> REC-1003, REC-1004 (مستخدَمة)");
console.log("   GET /api/receipts/REC-1004        -> syncPending=1 (فشل تعليمه على Receipt API)");
console.log("   check_receipt { receipt_number: \"REC-1001\", ... } -> status: valid, quantity: 25");
console.log("   check_receipt { receipt_number: \"REC-1003\", ... } -> status: already_used");
console.log("   check_receipt { receipt_number: \"NOPE\", ... }     -> status: not_found");
