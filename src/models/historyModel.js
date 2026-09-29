const db = require("../config/database");
const { toLocalStamp, nowStamp } = require("../utils/time");

// الحدّ الأدنى/الأقصى للنطاق الزمني عند غياب from/to
const MIN_STAMP = "0000-01-01 00:00:00";
const MAX_STAMP = "9999-12-31 23:59:59";

/*
 * الواجهة ترسل operator_id على أنه «id المستخدم، أو username كبديل»
 * (backend.md §2.1)، ومثال §1.4 يستخدم كود المشغّل. نقبل الثلاثة
 * ونحوّلها إلى operator.id، وإلا نخزّن NULL مع تحذير بدل أن يفشل الإدخال.
 */
async function resolveOperatorId(value) {
  if (value === null || value === undefined || value === "") return null;

  const raw = String(value).trim();

  if (/^\d+$/.test(raw)) {
    const byId = await db.query("SELECT id FROM operator WHERE id = $1", [
      Number(raw),
    ]);
    if (byId.rows[0]) return byId.rows[0].id;
  }

  const byKey = await db.query(
    `SELECT id FROM operator
     WHERE code = $1 OR username = $1 OR name = $1
     LIMIT 1`,
    [raw]
  );
  if (byKey.rows[0]) return byKey.rows[0].id;

  console.warn(`⚠️  history: unknown operator "${raw}" - stored as NULL`);
  return null;
}

const History = {
  // إنشاء الجداول أصبح مركزيًا في config/schema.js
  createTable: async () => db.init(),

  // بداية تعبئة: يفتح سجلًا بلا exitTime
  insert_1: async (logData) => {
    const {
      portNum,
      operatorId,
      operator_id,
      truckNum,
      receiptNum,
      requiredQuantity,
      startMeter,
      flowmeter_value,
      entryTime,
      fillMode,
    } = logData;

    const query = `
      INSERT INTO history (
        "portNum", "operatorId", "truckNum", "receiptNum",
        "requiredQuantity", "startMeter", "entryTime", "fillMode")
      VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'normal'))
      RETURNING *
    `;
    const values = [
      portNum,
      await resolveOperatorId(operatorId ?? operator_id),
      truckNum,
      receiptNum,
      requiredQuantity === undefined ? null : Number(requiredQuantity),
      startMeter ?? flowmeter_value ?? null,
      toLocalStamp(entryTime, nowStamp()),
      fillMode ?? null,
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  },

  // نهاية تعبئة: يغلق أحدث سجل مفتوح للمنفذ
  insert_2: async (logData) => {
    const { portNum, actualQuantity, endMeter, exitTime } = logData;

    const query = `
      UPDATE history
      SET "actualQuantity" = $2,
          "endMeter"       = COALESCE($3, "endMeter"),
          "exitTime"       = $4
      WHERE id = (
        SELECT id FROM history
        WHERE "portNum" = $1 AND "exitTime" IS NULL
        ORDER BY id DESC LIMIT 1
      )
      RETURNING *
    `;
    const values = [
      portNum,
      actualQuantity === undefined ? null : Number(actualQuantity),
      endMeter ?? null,
      toLocalStamp(exitTime, nowStamp()),
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  },

  /*
   * سجل كامل في خطوة واحدة — للسجلات القادمة من <port>/logdata
   * (تعبئة تمّت وقت انقطاع الجهاز، فلا يوجد لها فتح ولا إغلاق منفصلان).
   * الجهاز لا يحمل ساعة، فوقت الوصول هو أفضل تقدير متاح للوقت.
   */
  insertComplete: async (logData) => {
    const {
      portNum,
      operatorId,
      operator_id,
      truckNum,
      receiptNum,
      requiredQuantity,
      actualQuantity,
      startMeter,
      endMeter,
      entryTime,
      exitTime,
    } = logData;

    const stamp = nowStamp();
    const query = `
      INSERT INTO history (
        "portNum", "operatorId", "truckNum", "receiptNum",
        "requiredQuantity", "actualQuantity", "startMeter", "endMeter",
        "entryTime", "exitTime")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `;
    const values = [
      portNum,
      await resolveOperatorId(operatorId ?? operator_id),
      truckNum ?? null,
      receiptNum ?? null,
      requiredQuantity === undefined ? null : Number(requiredQuantity),
      actualQuantity === undefined ? null : Number(actualQuantity),
      startMeter ?? null,
      endMeter ?? null,
      toLocalStamp(entryTime, stamp),
      toLocalStamp(exitTime, stamp),
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  },

  // أحدث سجل مفتوح (بلا exitTime) لمنفذ واحد
  findOpenByPort: async (portNum) => {
    const result = await db.query(
      `SELECT * FROM history
       WHERE "portNum" = $1 AND "exitTime" IS NULL
       ORDER BY id DESC LIMIT 1`,
      [portNum]
    );
    return result.rows[0] || null;
  },

  // كل السجلات المفتوحة — تُحمَّل عند الإقلاع لاستعادة الجلسات الجارية
  findAllOpen: async () => {
    const result = await db.query(
      `SELECT * FROM history WHERE "exitTime" IS NULL ORDER BY id DESC`
    );
    return result.rows;
  },

  /*
   * إغلاق سجل محدد بالـ id — بعكس insert_2 الذي يبحث عن «أحدث سجل مفتوح».
   * الجلسة تعرف id سجلها، فالإغلاق بالـ id يمنع إغلاق سجل منفذ آخر بالخطأ.
   */
  closeById: async (id, { actualQuantity, endMeter, exitTime } = {}) => {
    const result = await db.query(
      `UPDATE history
       SET "actualQuantity" = COALESCE($2, "actualQuantity"),
           "endMeter"       = COALESCE($3, "endMeter"),
           "exitTime"       = $4
       WHERE id = $1 AND "exitTime" IS NULL
       RETURNING *`,
      [
        id,
        actualQuantity === undefined || actualQuantity === null
          ? null
          : Number(actualQuantity),
        endMeter === undefined || endMeter === null ? null : Number(endMeter),
        toLocalStamp(exitTime, nowStamp()),
      ]
    );
    return result.rows[0] || null;
  },

  /*
   * بيانات المشغّل/الشاحنة/الإيصال تأتي من الواجهة، بينما الفتح والإغلاق
   * يقودهما الجهاز — فقد يُفتح السجل قبل وصولها. هذه الدالة تُلحقها لاحقًا،
   * وتترك أي حقل غير مذكور كما هو (COALESCE).
   */
  updateMeta: async (id, meta = {}) => {
    const {
      operatorId,
      operator_id,
      truckNum,
      receiptNum,
      requiredQuantity,
      fillMode,
    } = meta;

    const rawOperator = operatorId ?? operator_id;
    const result = await db.query(
      `UPDATE history
       SET "operatorId"       = COALESCE($2, "operatorId"),
           "truckNum"         = COALESCE($3, "truckNum"),
           "receiptNum"       = COALESCE($4, "receiptNum"),
           "requiredQuantity" = COALESCE($5, "requiredQuantity"),
           "fillMode"         = COALESCE($6, "fillMode")
       WHERE id = $1
       RETURNING *`,
      [
        id,
        rawOperator === undefined || rawOperator === null
          ? null
          : await resolveOperatorId(rawOperator),
        truckNum ?? null,
        receiptNum ?? null,
        requiredQuantity === undefined || requiredQuantity === null
          ? null
          : Number(requiredQuantity),
        fillMode ?? null,
      ]
    );
    return result.rows[0] || null;
  },

  // مقابل SCADA row_id/flow_id — تُملأ بعد send_readings_1 (services/scadaSync.js)
  setScadaRowId: async (id, rowId) => {
    const result = await db.query(
      `UPDATE history SET "scadaRowId" = $2 WHERE id = $1 RETURNING *`,
      [id, String(rowId)]
    );
    return result.rows[0] || null;
  },

  setScadaFlowId: async (id, flowId) => {
    const result = await db.query(
      `UPDATE history SET "scadaFlowId" = $2 WHERE id = $1 RETURNING *`,
      [id, String(flowId)]
    );
    return result.rows[0] || null;
  },

  markScadaSynced: async (id) => {
    const result = await db.query(
      `UPDATE history SET "scadaSynced" = 1 WHERE id = $1 RETURNING *`,
      [id]
    );
    return result.rows[0] || null;
  },

  // مقابل get_unsend_logs (state IS NULL) — سجلات مقفولة لسه ما اتزامنتش مع SCADA
  findUnsyncedClosed: async () => {
    const result = await db.query(
      `SELECT * FROM history
       WHERE "scadaSynced" IS NULL AND "exitTime" IS NOT NULL
       ORDER BY id ASC`
    );
    return result.rows;
  },

  findByDateAndPort: async (params) => {
    const { port, from, to } = params;
    const fromStamp = toLocalStamp(from, MIN_STAMP);
    const toStamp = toLocalStamp(to, MAX_STAMP);

    let query, values;
    if (!port || port === "all_ports") {
      query = `SELECT * FROM history
               WHERE "entryTime" BETWEEN $1 AND $2
               ORDER BY id DESC`;
      values = [fromStamp, toStamp];
    } else {
      query = `SELECT * FROM history
               WHERE "portNum" = $1 AND "entryTime" BETWEEN $2 AND $3
               ORDER BY id DESC`;
      values = [port, fromStamp, toStamp];
    }

    const result = await db.query(query, values);
    return result.rows;
  },
};

module.exports = History;
