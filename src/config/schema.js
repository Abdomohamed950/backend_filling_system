/*
 * مخطط قاعدة البيانات (SQLite) — كل الجداول اللي يحتاجها عقد الواجهة backend.md
 *
 * ملاحظات عن الأنواع:
 * - أسماء الأعمدة مطابقة حرفيًا لما تنتظره الواجهة، بما فيها "SecondCloseLag"
 *   بحرف S كبير (backend.md §1.2).
 * - INTEGER/REAL يرجعان أرقامًا في JS، فاختفت مشكلة أن pg كان يرجّع
 *   bigint و numeric كنصوص.
 * - الأوقات TEXT بصيغة 'YYYY-MM-DD HH:MM:SS' بالتوقيت المحلي — نفس ما كان
 *   يخرج من PostgreSQL، وهي إحدى الصيغ التي يقبلها محلّل lib/format.js.
 *   الصيغة ثابتة الطول فالمقارنة النصية = مقارنة زمنية صحيحة.
 */

const DDL = [
  // ---------------------------------------------------------------- operator
  `CREATE TABLE IF NOT EXISTS operator (
     id        INTEGER PRIMARY KEY AUTOINCREMENT,
     name      TEXT    NOT NULL,
     username  TEXT    UNIQUE,                 -- تسجيل الدخول (§1.1)
     pass      TEXT    NOT NULL,
     role      TEXT    NOT NULL DEFAULT 'operator'
                       CHECK (role IN ('admin','operator')),
     code      TEXT    NOT NULL UNIQUE,        -- كود المشغّل (نص: الأصفار البادئة مهمة)
     phone     TEXT,
     createdAt TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
   )`,

  `CREATE UNIQUE INDEX IF NOT EXISTS idx_operator_code ON operator(code)`,

  /*
   * جلسات تسجيل الدخول — سطر واحد لكل توكن صادر (v3، محل عمود
   * operator.tokenVersion في v2). كل توكن يحمل jti فريدًا؛ resolveOperator
   * (middleware/auth.js) يقبله فقط لو له سطر هنا لم تنتهِ صلاحيته، فـ
   * logout يحذف سطر هذا التوكن بعينه دون التأثير على أجهزة/متصفحات أخرى
   * لنفس المشغّل — بعكس tokenVersion التي كانت تُبطل كل جلساته دفعة واحدة.
   */
  `CREATE TABLE IF NOT EXISTS sessions (
     jti        TEXT    PRIMARY KEY,
     operatorId INTEGER NOT NULL REFERENCES operator(id) ON DELETE CASCADE,
     createdAt  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
     expiresAt  TEXT    NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_sessions_operator ON sessions(operatorId)`,
  // لتنضيف الجلسات المنتهية طبيعيًا (services/sessionCleanup لاحقًا، أو عند كل طلب)
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires  ON sessions(expiresAt)`,

  // ----------------------------------------------------------- ports_setting
  `CREATE TABLE IF NOT EXISTS ports_setting (
     id              INTEGER PRIMARY KEY AUTOINCREMENT,
     name            TEXT    NOT NULL UNIQUE,  -- مفتاح كل أحداث socket و MQTT topics
     mode            TEXT    NOT NULL DEFAULT 'modbus'
                             CHECK (mode IN ('modbus','pulse','milli ampere')),
     baudrate        INTEGER NOT NULL DEFAULT 9600,
     serialFrame     TEXT    NOT NULL DEFAULT 'SERIAL_8N1',
     endian          TEXT    DEFAULT 'big',
     slaveId         INTEGER DEFAULT 1,
     registerAddress INTEGER DEFAULT 0,
     flowRateAddress INTEGER DEFAULT 0,
     firstCloseTime  INTEGER NOT NULL DEFAULT 0,
     secondCloseTime INTEGER NOT NULL DEFAULT 0,
     firstCloseLag   INTEGER NOT NULL DEFAULT 0,
     SecondCloseLag  INTEGER NOT NULL DEFAULT 0,
     pidTime         INTEGER NOT NULL DEFAULT 0,   -- = thirdCloseTime في الفيرموير
     addedTime       INTEGER NOT NULL DEFAULT 0,
     registerType    TEXT    DEFAULT 'holding',
     valveType       TEXT    DEFAULT 'valve',
     createdAt       TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
   )`,

  // ----------------------------------------------------------------- history
  `CREATE TABLE IF NOT EXISTS history (
     id               INTEGER PRIMARY KEY AUTOINCREMENT,
     portNum          TEXT    NOT NULL,
     operatorId       INTEGER REFERENCES operator(id) ON UPDATE CASCADE
                                                      ON DELETE SET NULL,
     truckNum         TEXT,
     receiptNum       TEXT,
     requiredQuantity REAL,
     actualQuantity   REAL,
     startMeter       REAL,      -- قراءة العداد لحظة البدء  (لازمة لتقارير §1.5)
     endMeter         REAL,      -- قراءة العداد لحظة الإيقاف
     entryTime        TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
     exitTime         TEXT
   )`,

  `CREATE INDEX IF NOT EXISTS idx_history_entry_time ON history(entryTime)`,
  `CREATE INDEX IF NOT EXISTS idx_history_port_time  ON history(portNum, entryTime)`,
  `CREATE INDEX IF NOT EXISTS idx_history_operator   ON history(operatorId)`,
  // للبحث عن التعبئة المفتوحة الخاصة بمنفذ (إغلاق السجل عند الإيقاف)
  `CREATE INDEX IF NOT EXISTS idx_history_open       ON history(portNum, exitTime)`,

  /*
   * إعدادات مزامنة SCADA/Receipt API — صف واحد ثابت (id=1) قابل للتعديل من
   * الـ UI. القيم الافتراضية = عناوين النظام القديم (Python)، مع العلم أن
   * السيرفرين مش شغالين حاليًا — كل كود المزامنة لازم يتحمّل فشل الاتصال بيهم
   * من غير ما يأثر على التعبئة الفعلية (انظر sync_and_barcode.md).
   */
  `CREATE TABLE IF NOT EXISTS sync_settings (
     id                    INTEGER PRIMARY KEY CHECK (id = 1),
     scadaEnabled          INTEGER NOT NULL DEFAULT 1,
     scadaHost             TEXT    NOT NULL DEFAULT '197.134.251.84',
     scadaPort             INTEGER NOT NULL DEFAULT 11001,
     receiptApiEnabled     INTEGER NOT NULL DEFAULT 1,
     receiptApiBaseUrl     TEXT    NOT NULL DEFAULT 'http://172.16.0.99:8090/KorapTmp',
     receiptRefreshMinutes INTEGER NOT NULL DEFAULT 60,
     updatedAt             TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
   )`,

  // خرائط قنوات SCADA لكل منفذ (channel id لكل حقل يُبعت بروتوكول P عليه)
  `CREATE TABLE IF NOT EXISTS scada_channels (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     portNum     TEXT    NOT NULL UNIQUE REFERENCES ports_setting(name) ON UPDATE CASCADE,
     truckCh     TEXT,
     operatorCh  TEXT,
     requiredCh  TEXT,
     receiptCh   TEXT,
     inTimeCh    TEXT,
     flowmeterCh TEXT,
     flowTimeCh  TEXT,
     actualCh    TEXT,
     outTimeCh   TEXT
   )`,

  // نسخة محلية من إيصالات Receipt API — مصدر التحقق لنظام الباركود
  `CREATE TABLE IF NOT EXISTS receipts (
     receiptNum    TEXT    PRIMARY KEY,
     waterQuantity REAL,
     checked       INTEGER NOT NULL DEFAULT 0,
     syncPending   INTEGER NOT NULL DEFAULT 0,
     fetchedAt     TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
   )`,
];

const SCHEMA_VERSION = 4;

/*
 * "CREATE TABLE IF NOT EXISTS" لا يضيف عمودًا جديدًا لجدول موجود بالفعل —
 * فقاعدة بيانات منشأة على v2 محتاجة ALTER TABLE صريح لإزالة tokenVersion
 * (محل sessions الآن). محمي بفحص PRAGMA حتى تبقى الدالة قابلة للتكرار
 * (لا تفشل على قاعدة أُنشئت من الصفر بالفعل بدون العمود).
 */
function dropColumnIfExists(db, table, column) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (cols.includes(column)) db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
}

// عكس dropColumnIfExists — يضيف عمودًا لجدول موجود بالفعل (v4: مزامنة SCADA)
function addColumnIfMissing(db, table, column, ddlType) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN "${column}" ${ddlType}`);
  }
}

function migrate(db) {
  db.exec("BEGIN");
  try {
    for (const stmt of DDL) db.exec(stmt);
    dropColumnIfExists(db, "operator", "tokenVersion");

    // v4: مزامنة SCADA + نظام الباركود (state=NULL يعني "لسه مش متزامن")
    addColumnIfMissing(db, "history", "scadaRowId", "TEXT");
    addColumnIfMissing(db, "history", "scadaFlowId", "TEXT");
    addColumnIfMissing(db, "history", "scadaSynced", "INTEGER");
    addColumnIfMissing(db, "history", "fillMode", "TEXT NOT NULL DEFAULT 'normal'");

    db.exec("INSERT OR IGNORE INTO sync_settings (id) VALUES (1)");

    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    )
    .all()
    .map((r) => r.name);

  return { version: SCHEMA_VERSION, tables };
}

module.exports = { migrate, SCHEMA_VERSION };
