/*
 * طبقة قاعدة البيانات — SQLite عبر better-sqlite3.
 *
 * تحافظ على نفس واجهة pg القديمة: `db.query(text, params)` ترجع
 * Promise لكائن `{ rows, rowCount }`، وتُترجم علامات pg الترتيبية
 * ($1, $2 …) إلى علامات SQLite (?) بنفس ترتيب ظهورها — فالموديلات
 * تعمل كما هي، وتبقى الاستعلامات قابلة للنقل.
 *
 * ملف القاعدة: SQLITE_PATH في .env، أو data/filling_system.db افتراضيًا.
 */

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");
require("dotenv").config();

const schema = require("./schema");

const DB_PATH = process.env.SQLITE_PATH
  ? path.resolve(process.env.SQLITE_PATH)
  : path.join(__dirname, "..", "..", "data", "filling_system.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.pragma("journal_mode = WAL"); // قراءة متزامنة مع الكتابة (socket + REST معًا)
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

/** $1,$2 … -> ?  مع بناء مصفوفة القيم بترتيب الظهور الفعلي */
function translate(text, params) {
  if (!params || params.length === 0) return { sql: text, values: [] };

  const values = [];
  const sql = text.replace(/\$(\d+)/g, (_match, n) => {
    values.push(params[Number(n) - 1]);
    return "?";
  });

  // better-sqlite3 يرفض undefined و boolean
  return {
    sql,
    values: values.map((v) => {
      if (v === undefined) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      return v;
    }),
  };
}

async function query(text, params) {
  const { sql, values } = translate(text, params);
  const stmt = db.prepare(sql);

  if (stmt.reader) {
    const rows = stmt.all(...values);
    return { rows, rowCount: rows.length };
  }

  const info = stmt.run(...values);
  return {
    rows: [],
    rowCount: info.changes,
    lastInsertRowid: info.lastInsertRowid,
  };
}

/** إنشاء كل الجداول والفهارس (idempotent) */
function init() {
  const result = schema.migrate(db);
  return { ...result, file: DB_PATH };
}

function close() {
  db.close();
}

module.exports = {
  query,
  init,
  close,
  db, // للوصول المباشر (تقارير، معاملات)
  file: DB_PATH,
  // توافق مع الكود الذي كان ينادي pool.end()
  pool: { end: async () => close() },
};
