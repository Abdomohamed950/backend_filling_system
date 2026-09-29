#!/usr/bin/env node
/*
 * نقل البيانات لمرة واحدة من PostgreSQL إلى SQLite.
 *   node scripts/migrate-pg-to-sqlite.js [--force]
 *
 * يقرأ من PG بإعدادات DB_* في .env، ولا يعدّل عليها شيئًا (قراءة فقط).
 * الأوقات في PG بلا منطقة زمنية (توقيت محلي) وهي نفس صيغة SQLite هنا،
 * فتُنقل كما هي بدون تحويل.
 * التنفيذ آمن للتكرار: يتخطى الصفوف الموجودة بنفس المفتاح.
 */

require("dotenv").config();
const { Pool } = require("pg");
const db = require("../src/config/database");
const { toLocalStamp } = require("../src/utils/time");

const force = process.argv.includes("--force");

const pg = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  connectionTimeoutMillis: 4000,
});

const s = (v) => (v === null || v === undefined ? null : String(v));
const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
// pg يرجّع timestamp ككائن Date هنا (لا يوجد setTypeParser في هذا السكربت)
const t = (v) => toLocalStamp(v);

/*
 * إدخال صف بصف مع الإبلاغ عن كل صف مرفوض وسببه — لا نستخدم
 * INSERT OR IGNORE لأنه يخفي فقدان البيانات.
 */
function insertRows(label, stmt, rows, mapper) {
  let inserted = 0;
  let already = 0;
  const skipped = [];

  for (const row of rows) {
    try {
      inserted += stmt.run(...mapper(row)).changes;
    } catch (err) {
      if (/UNIQUE constraint|PRIMARY KEY/i.test(err.message)) already++;
      else skipped.push(`id=${row.id}: ${err.message}`);
    }
  }

  const extra = already ? ` (${already} موجود بالفعل)` : "";
  console.log(`✔ ${label}: ${inserted}/${rows.length} صف${extra}`);
  for (const line of skipped) console.log(`   ⚠️  مرفوض — ${line}`);
  return { inserted, already, skipped };
}

async function tableExists(name) {
  const r = await pg.query("SELECT to_regclass($1) IS NOT NULL AS ok", [
    `public.${name}`,
  ]);
  return r.rows[0].ok;
}

async function main() {
  const { file, tables } = db.init();
  console.log(`🗄️  target: ${file}`);
  console.log(`   tables: ${tables.join(", ")}\n`);

  const existing = db.db
    .prepare("SELECT COUNT(*) AS n FROM ports_setting")
    .get().n;
  if (existing > 0 && !force) {
    console.log("ℹ️  SQLite فيها بيانات بالفعل — التنفيذ سيتخطى المكرر.");
  }

  // ------------------------------------------------------------- operator
  if (await tableExists("operator")) {
    const { rows } = await pg.query("SELECT * FROM operator ORDER BY id");
    const insert = db.db.prepare(`
      INSERT INTO operator (id, name, username, pass, role, code, phone, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    // أول مشغّل يُنقل كمدير حتى يمكن الدخول بعد تنفيذ /auth/login
    let first = true;
    insertRows("operator     ", insert, rows, (r) => {
      const role = first ? "admin" : "operator";
      first = false;
      return [
        r.id,
        s(r.name),
        s(r.name), // username مبدئيًا = الاسم، عدّله من الواجهة
        s(r.pass),
        role,
        s(r.code),
        s(r.phone),
        t(r.created_at),
      ];
    });
  }

  // -------------------------------------------------------- ports_setting
  if (await tableExists("ports_setting")) {
    const { rows } = await pg.query("SELECT * FROM ports_setting ORDER BY id");
    const insert = db.db.prepare(`
      INSERT INTO ports_setting (
        id, name, mode, baudrate, serialFrame, endian, "slaveId", "registerAddress",
        "flowRateAddress", "firstCloseTime", "secondCloseTime", "firstCloseLag",
        "SecondCloseLag", "pidTime", "addedTime", "registerType", "valveType")
      VALUES (?, ?, 'modbus', ?, 'SERIAL_8N1', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertRows("ports_setting", insert, rows, (r) => [
      r.id,
      s(r.name),
      n(r.baudrate) ?? 9600,
      s(r.endian),
      n(r.slaveId),
      n(r.registerAddress),
      n(r.flowRateAddress) ?? 0,
      n(r.firstCloseTime) ?? 0,
      n(r.secondCloseTime) ?? 0,
      n(r.firstCloseLag) ?? 0,
      n(r.SecondCloseLag) ?? 0,
      n(r.pidTime) ?? 0,
      n(r.addedTime) ?? 0,
      s(r.registerType),
      s(r.valveType),
    ]);
  }

  // -------------------------------------------------------------- history
  if (await tableExists("history")) {
    const { rows } = await pg.query("SELECT * FROM history ORDER BY id");
    const insert = db.db.prepare(`
      INSERT INTO history (
        id, "portNum", "operatorId", "truckNum", "receiptNum",
        "requiredQuantity", "actualQuantity", "entryTime", "exitTime")
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertRows("history      ", insert, rows, (r) => [
      r.id,
      s(r.portNum),
      n(r.operatorId),
      s(r.truckNum),
      s(r.receiptNum),
      n(r.requiredQuantity),
      n(r.actualQuantity),
      t(r.entryTime),
      t(r.exitTime),
    ]);
    console.log(
      "  ملاحظة: startMeter/endMeter فاضية للسجلات القديمة (لم تكن موجودة في PG)."
    );
  }

  await pg.end();
  db.close();
  console.log("\n✅ تم النقل.");
}

main().catch(async (err) => {
  console.error("❌ فشل النقل:", err.message);
  try {
    await pg.end();
  } catch {}
  process.exit(1);
});
