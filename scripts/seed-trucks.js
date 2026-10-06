#!/usr/bin/env node
/*
 * شاحنات تجريبية = الأرقام الخمسة اللي بتعرضها شاشة esp_car (dataSet في
 * makit/esp_car/MQTTManager.cpp).
 *   node scripts/seed-trucks.js
 *
 * آمن للتكرار: upsert على plate، وبيحدّث الكمية والحد بس. tripsDone ما بيتلمسش
 * عشان تشغيل السكربت تاني ما يصفّرش النقلات. لا يلمس أي جدول تاني.
 */

const db = require("../src/config/database");
db.init();

const truckRows = [
  // [plate, quantity, limitEnabled, maxTrips]
  ["1234", 10, 0, 0], // كمية خاصة، من غير حد
  ["5678", 15, 0, 0], // كمية خاصة، من غير حد
  ["9012", 20, 1, 2], // نقلتين بس (الحد مفعّل)
  ["3344", null, 0, 0], // من غير كمية خاصة: بتاخد defaultQuantity في الدورة
  ["7899", 12, 1, 1], // نقلة واحدة بس (الحد مفعّل)
];

const upsert = db.db.prepare(`
  INSERT INTO trucks (plate, quantity, limitEnabled, maxTrips)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(plate) DO UPDATE SET
    quantity     = excluded.quantity,
    limitEnabled = excluded.limitEnabled,
    maxTrips     = excluded.maxTrips
`);

for (const row of truckRows) {
  upsert.run(...row);
  const [plate, quantity, limitEnabled, maxTrips] = row;
  console.log(
    `✅ trucks: ${plate} (quantity=${quantity ?? "default"}, limit=${limitEnabled ? `on/${maxTrips}` : "off"})`
  );
}

console.log("\n📋 جاهز للاختبار:");
console.log("   GET /api/trucks   -> الخمس شاحنات (tripsDone محفوظ لو اتعدّ قبل كده)");
console.log("   9012 -> نقلتين وبعدها trips_exhausted | 7899 -> نقلة واحدة | 3344 -> defaultQuantity");
console.log("   تصفير النقلات: POST /api/trucks/reset-trips");
