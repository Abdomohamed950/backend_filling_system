const db = require("../config/database");
const { toLocalStamp } = require("../utils/time");

const MIN_STAMP = "0000-01-01 00:00:00";
const MAX_STAMP = "9999-12-31 23:59:59";

// أسماء الحقول في تقارير backend.md §1.5 بحروف صغيرة (بعكس السجل) — مقصودة
const round3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

/*
 * صف التقرير لمنفذ واحد:
 *   startmeter   أول قراءة عداد مسجّلة في الفترة
 *   endmeter     آخر قراءة عداد مسجّلة في الفترة
 *   metervalue   endmeter - startmeter (ما مرّ فعلًا من العداد)
 *   receiptvalue مجموع الكميات المطلوبة (ما حُرِّر به إيصال)
 *   deficit      receiptvalue - metervalue إن كان موجبًا
 *   saving       metervalue - receiptvalue إن كان موجبًا
 *   carcount     عدد عمليات التعبئة
 *
 * ملاحظة: السجلات المنقولة من PostgreSQL بلا startMeter/endMeter، فإن لم
 * توجد أي قراءة عداد في الفترة يُحسب metervalue من مجموع الكميات الفعلية.
 */
function buildRow(portNum, rows) {
  const withStart = rows.filter((r) => r.startMeter !== null);
  const withEnd = rows.filter((r) => r.endMeter !== null);

  const startmeter = withStart.length ? Number(withStart[0].startMeter) : null;
  const endmeter = withEnd.length
    ? Number(withEnd[withEnd.length - 1].endMeter)
    : null;

  const metervalue =
    startmeter !== null && endmeter !== null
      ? round3(endmeter - startmeter)
      : round3(rows.reduce((sum, r) => sum + (Number(r.actualQuantity) || 0), 0));

  const receiptvalue = round3(
    rows.reduce((sum, r) => sum + (Number(r.requiredQuantity) || 0), 0)
  );

  const diff = round3(receiptvalue - metervalue);

  return {
    portnum: portNum,
    startmeter,
    endmeter,
    metervalue,
    receiptvalue,
    saving: diff < 0 ? round3(-diff) : 0,
    deficit: diff > 0 ? diff : 0,
    carcount: rows.length,
  };
}

const Report = {
  /** port = اسم منفذ أو 'allPorts' (يُقبل أيضًا 'all_ports') */
  build: async ({ port, from, to }) => {
    const fromStamp = toLocalStamp(from, MIN_STAMP);
    const toStamp = toLocalStamp(to, MAX_STAMP);
    const allPorts = !port || port === "allPorts" || port === "all_ports";

    let names;
    if (allPorts) {
      // صف لكل منفذ معرّف، حتى الذي لا تعبئة له في الفترة
      const configured = await db.query(
        "SELECT name FROM ports_setting ORDER BY id ASC"
      );
      const seen = await db.query(
        `SELECT DISTINCT "portNum" AS name FROM history
         WHERE "entryTime" BETWEEN $1 AND $2`,
        [fromStamp, toStamp]
      );
      names = [
        ...new Set([
          ...configured.rows.map((r) => r.name),
          ...seen.rows.map((r) => r.name),
        ]),
      ];
    } else {
      names = [port];
    }

    const report = [];
    for (const name of names) {
      const { rows } = await db.query(
        `SELECT "requiredQuantity", "actualQuantity", "startMeter", "endMeter"
         FROM history
         WHERE "portNum" = $1 AND "entryTime" BETWEEN $2 AND $3
         ORDER BY "entryTime" ASC, id ASC`,
        [name, fromStamp, toStamp]
      );
      report.push(buildRow(name, rows));
    }

    return report;
  },
};

module.exports = Report;
