/*
 * سجل التعبئة يُبنى من رسائل الـ ESP — لا من نداءات الواجهة.
 *
 * دورة حياة تعبئة واحدة كما يراها البروكر (esp.ino):
 *   1. السيرفر ينشر <port>/quantity  (أمر)          → لا كتابة في القاعدة
 *   2. الجهاز يقبل الكمية ويعلن <port>/state=filling → فتح سجل   (insert_1)
 *   3. الجهاز ينشر <port>/flowmeter بشكل متصل        → آخر قراءة عداد
 *   4. الجهاز يعلن <port>/state=stop | emergency_stop → إغلاق السجل (closeById)
 *
 * لماذا الجهاز وليس الواجهة:
 *   - لو أغلق المتصفح أو انقطعت الشبكة بين المحطة والسيرفر، التعبئة تكمل
 *     على الجهاز ويجب أن تُسجَّل.
 *   - الكمية الفعلية = فرق العدّاد الذي أعلنه الجهاز، لا رقم كتبته الواجهة.
 *   - الجهاز قد يرفض الكمية (esp.ino يقبل 0 < q < 100) فلا تعبئة أصلًا؛
 *     السجل يُفتح فقط عندما يعلن الجهاز أنه بدأ فعلًا.
 *
 * ما تبقّى على الواجهة: بيانات لا يعرفها الجهاز (المشغّل، الشاحنة، الإيصال).
 * تُخزَّن هنا كـ meta مع أمر البدء وتُلحق بالسجل عند فتحه، أو تُحدَّث عليه
 * لاحقًا إن وصلت متأخرة (attachMeta).
 */

const History = require("../models/historyModel");
const { nowStamp } = require("../utils/time");
const scadaSync = require("./scadaSync");

// بيانات الواجهة تنتظر إعلان الجهاز؛ بعد هذه المدة تُعدّ منتهية الصلاحية
// (أمر بدء رُفض أو جهاز لم يستجب) فلا تُلحق بتعبئة لاحقة لا تنتمي إليها.
const META_TTL_MS = Number(process.env.FILL_META_TTL_MS) || 10 * 60 * 1000;

/*
 * الجهاز يعلن state=stop عند بدء الإغلاق الثالث، والسائل يظل يمرّ بعده
 * بثوانٍ حتى يقف العدّاد. الإغلاق الفوري يسجّل كمية أقل من الحقيقة، فننتظر
 * سكون العدّاد: أي قراءة flowmeter جديدة تعيد تشغيل المؤقّت، بسقف أقصى.
 */
const SETTLE_MS = Number(process.env.FILL_SETTLE_MS) || 5000;
const MAX_SETTLE_MS = Number(process.env.FILL_MAX_SETTLE_MS) || 60 * 1000;

// الجهاز قد يعيد نشر نفس سجل الطابور لو لم يتأكد الحذف — نتجاهل المكرر
const LOGDATA_DEDUPE_MS = Number(process.env.FILL_LOG_DEDUPE_MS) || 60 * 1000;

// حالات نهاية التعبئة على <port>/state ("stoping" مرحلة عابرة، ليست نهاية)
const END_STATES = ["stop", "emergency_stop"];

const round3 = (v) => Math.round(v * 1000) / 1000;

let io = null;

/** تُنادى مرة واحدة من app.js حتى تُبثّ أحداث السجل للواجهة */
function setIo(instance) {
  io = instance;
}

function emit(event, payload) {
  if (io) io.emit(event, payload);
}

/*
 * حالة كل منفذ في الذاكرة:
 *   meta/metaAt   بيانات الواجهة المنتظرة ووقت وصولها
 *   openId        id السجل المفتوح حاليًا (أو null)
 *   startMeter    قراءة العداد التي فُتح بها السجل
 *   lastMeter     آخر قراءة عداد وصلت من الجهاز
 *   settleTimer   مؤقّت انتظار سكون العداد بعد stop
 *   chain         تسلسل العمليات (فتح/إغلاق نفس السجل لا يتداخل)
 */
const ports = new Map();

function portState(port) {
  let s = ports.get(port);
  if (!s) {
    s = {
      meta: null,
      metaAt: 0,
      openId: null,
      startMeter: null,
      lastMeter: null,
      settleTimer: null,
      settleDeadline: 0,
      settleReason: null,
      lastLog: null,
      lastLogAt: 0,
      chain: Promise.resolve(),
    };
    ports.set(port, s);
  }
  return s;
}

/*
 * كل الكتابات الخاصة بمنفذ تمرّ في طابور واحد. بدون ذلك يمكن أن يسبق
 * إغلاقٌ فتحَه (رسائل MQTT تصل تباعًا وكل معالجة async).
 */
function serialize(port, task) {
  const s = portState(port);
  s.chain = s.chain
    .catch(() => {})
    .then(task)
    .catch((err) =>
      console.error(`❌ history(${port}): ${err.message}`)
    );
  return s.chain;
}

const toNum = (v) => {
  if (v === null || v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/*
 * الواجهة ترسل نفس البيانات بأسمين مختلفين: snake_case في حدث
 * start_filling (backend.md §2.1) وcamelCase في POST /api/history.
 * نقبل الشكلين ونرجّع الحقول الموجودة فقط حتى لا يمسح COALESCE قيمة بـ null.
 */
function normalizeMeta(raw) {
  if (!raw || typeof raw !== "object") return null;

  const pick = (...keys) => {
    for (const key of keys) {
      const v = raw[key];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
  };

  const meta = {
    operatorId: pick("operatorId", "operator_id"),
    truckNum: pick("truckNum", "truck_number", "truckNumber"),
    receiptNum: pick("receiptNum", "receipt_number", "receiptNumber"),
    requiredQuantity: toNum(pick("requiredQuantity", "required_quantity")),
    startMeter: toNum(pick("startMeter", "flowmeter_value")),
    // 'crisis' = دخل المشغّل رقمه بدل الإيصال (services/barcodeFlow.js)
    fillMode: pick("fillMode", "fill_mode"),
  };

  for (const key of Object.keys(meta)) {
    if (meta[key] === undefined) delete meta[key];
  }

  return Object.keys(meta).length ? meta : null;
}

/**
 * بيانات الواجهة مع أمر البدء. لا تكتب سجلًا: السجل يُفتح عندما يعلن الجهاز
 * state=filling. لو كان هناك سجل مفتوح بالفعل (وصلت البيانات متأخرة) تُلحق به.
 */
function attachMeta(port, raw) {
  const meta = normalizeMeta(raw);
  if (!port || !meta) return null;

  const s = portState(port);
  s.meta = { ...(s.meta || {}), ...meta };
  s.metaAt = Date.now();

  if (s.openId) {
    const id = s.openId;
    serialize(port, async () => {
      const row = await History.updateMeta(id, s.meta);
      if (row) {
        console.log(`📝 ${port}: بيانات الواجهة أُلحقت بالسجل #${row.id}`);
        emit("history_updated", { port, record: row });
      }
    });
  }

  return s.meta;
}

/** يسحب meta الصالحة (وينسى المنتهية الصلاحية) */
function takeMeta(s, port) {
  if (!s.meta) return null;
  if (Date.now() - s.metaAt > META_TTL_MS) {
    console.warn(`⚠️  ${port}: بيانات واجهة منتهية الصلاحية — أُهملت`);
    s.meta = null;
    return null;
  }
  const meta = s.meta;
  s.meta = null;
  return meta;
}

function clearSettle(s) {
  if (s.settleTimer) clearTimeout(s.settleTimer);
  s.settleTimer = null;
  s.settleDeadline = 0;
  s.settleReason = null;
}

/** آخر قراءة عداد — أساس startMeter/endMeter وإشارة أن السائل ما زال يمرّ */
function onFlowmeter(port, value) {
  if (!Number.isFinite(value)) return;
  const s = portState(port);
  const changed = s.lastMeter !== value;
  s.lastMeter = value;

  // العداد ما زال يتحرك بعد stop: مدّد الانتظار حتى يسكن (بحد أقصى)
  if (changed && s.settleTimer) armSettle(port, s.settleReason);
}

/** <port>/state من الجهاز — الرسائل retained تُستثنى (انظر transport/mqtt.js) */
function onState(port, state) {
  if (state === "filling") return openRecord(port);
  if (END_STATES.includes(state)) return scheduleClose(port, state);
  return undefined; // "stoping" مرحلة عابرة
}

function openRecord(port) {
  return serialize(port, async () => {
    const s = portState(port);
    clearSettle(s);

    /*
     * سجل مفتوح موجود قبل بدء تعبئة جديدة = تعبئة سابقة لم تُغلق (توقف
     * السيرفر أو انقطع الجهاز قبل إعلان stop). نغلقه بما نعرفه بدل أن
     * نُلحق التعبئة الجديدة بسجل لا ينتمي إليها.
     */
    const stale = await History.findOpenByPort(port);
    if (stale) {
      const abandoned = await History.closeById(stale.id, {
        actualQuantity: meterDelta(stale.startMeter, s.lastMeter),
        endMeter: s.lastMeter,
        exitTime: nowStamp(),
      });
      console.warn(
        `⚠️  ${port}: سجل #${stale.id} كان مفتوحًا — أُغلق كتعبئة مهجورة`
      );
      if (abandoned) emit("history_closed", { port, record: abandoned, reason: "abandoned" });
    }

    const meta = takeMeta(s, port) || {};
    const startMeter = meta.startMeter ?? s.lastMeter ?? null;

    const row = await History.insert_1({
      portNum: port,
      operatorId: meta.operatorId,
      truckNum: meta.truckNum,
      receiptNum: meta.receiptNum,
      requiredQuantity: meta.requiredQuantity,
      startMeter,
      entryTime: nowStamp(),
    });

    s.openId = row.id;
    s.startMeter = row.startMeter;
    console.log(
      `📖 ${port}: فُتح سجل #${row.id} (startMeter=${row.startMeter}, required=${row.requiredQuantity})`
    );
    emit("history_open", { port, record: row });

    // مزامنة SCADA fire-and-forget — أبدًا متأخرش أو توقف فتح السجل المحلي
    scadaSync.sendReadings1(row.id).catch((err) =>
      console.error(`❌ scadaSync.sendReadings1(#${row.id}) فشل: ${err.message}`)
    );
  });
}

/** ينتظر سكون العداد ثم يغلق — لأن الجهاز يعلن stop قبل توقف السائل */
function armSettle(port, reason) {
  const s = portState(port);
  const now = Date.now();
  if (!s.settleDeadline) s.settleDeadline = now + MAX_SETTLE_MS;
  s.settleReason = reason;

  if (s.settleTimer) clearTimeout(s.settleTimer);
  const wait = Math.max(0, Math.min(SETTLE_MS, s.settleDeadline - now));
  s.settleTimer = setTimeout(() => closeRecord(port, reason), wait);
}

function scheduleClose(port, reason) {
  return serialize(port, async () => {
    const s = portState(port);

    // السيرفر أُعيد تشغيله أثناء التعبئة: استعد id السجل من القاعدة
    if (!s.openId) {
      const open = await History.findOpenByPort(port);
      if (!open) return; // stop عند إقلاع الجهاز بلا تعبئة — لا شيء للإغلاق
      s.openId = open.id;
      s.startMeter = open.startMeter;
    }

    armSettle(port, reason);
  });
}

function meterDelta(startMeter, endMeter) {
  const start = Number(startMeter);
  const end = Number(endMeter);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  // عدّاد تراكمي: الفرق السالب يعني تصفير/تبديل العدّاد، لا كمية سالبة
  if (end < start) return null;
  return round3(end - start);
}

function closeRecord(port, reason) {
  return serialize(port, async () => {
    const s = portState(port);
    clearSettle(s);

    const id = s.openId;
    if (!id) return;
    s.openId = null;

    const endMeter = Number.isFinite(s.lastMeter) ? s.lastMeter : null;
    const actualQuantity = meterDelta(s.startMeter, endMeter);
    if (endMeter !== null && actualQuantity === null) {
      console.warn(
        `⚠️  ${port}: تعذّر حساب الكمية الفعلية (start=${s.startMeter}, end=${endMeter})`
      );
    }

    const row = await History.closeById(id, {
      actualQuantity,
      endMeter,
      exitTime: nowStamp(),
    });
    s.startMeter = null;

    if (!row) {
      console.warn(`⚠️  ${port}: السجل #${id} كان مغلقًا بالفعل`);
      return;
    }

    console.log(
      `📕 ${port}: أُغلق سجل #${row.id} (${reason}) actual=${row.actualQuantity}, endMeter=${row.endMeter}`
    );
    emit("history_closed", { port, record: row, reason });

    // مزامنة SCADA fire-and-forget — أبدًا متأخرش أو توقف قفل السجل المحلي
    scadaSync.sendReadings2(row.id).catch((err) =>
      console.error(`❌ scadaSync.sendReadings2(#${row.id}) فشل: ${err.message}`)
    );
  });
}

/*
 * <port>/logdata — تعبئة تمّت وقت انقطاع الجهاز، يعيد إرسالها بعد الاتصال.
 * الصيغة من esp.ino (add_string_to_queue):
 *   required,delta,flowmeter[,flowmeter_prev]
 * بلا وقت (الجهاز بلا ساعة) وبلا مشغّل/شاحنة/إيصال (لا يعرفها).
 */
function onLogData(port, raw) {
  const text = String(raw || "").trim();
  if (!text) return undefined;

  const s = portState(port);
  const now = Date.now();
  if (s.lastLog === text && now - s.lastLogAt < LOGDATA_DEDUPE_MS) {
    console.warn(`⚠️  ${port}: logdata مكرر — أُهمل (${text})`);
    return undefined;
  }
  s.lastLog = text;
  s.lastLogAt = now;

  const parts = text.split(",").map((v) => Number(v.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) {
    console.error(`❌ ${port}: logdata غير مفهوم — "${text}"`);
    return undefined;
  }

  const [requiredQuantity, delta, endMeter, prevMeter] = parts;
  const startMeter = Number.isFinite(prevMeter)
    ? prevMeter
    : round3(endMeter - delta);

  return serialize(port, async () => {
    const row = await History.insertComplete({
      portNum: port,
      requiredQuantity,
      actualQuantity: round3(delta),
      startMeter,
      endMeter,
    });
    console.log(
      `📥 ${port}: سجل offline #${row.id} (required=${row.requiredQuantity}, actual=${row.actualQuantity})`
    );
    emit("history_offline", { port, record: row });
  });
}

/*
 * انقطاع الجهاز أثناء تعبئة: لا نغلق السجل. الصمّام قد يكون ما زال يعمل،
 * والجهاز عند عودته ينشر حالته (وسجلات الطابور) فيُغلق حينها بقراءة صحيحة.
 */
function onAvailability(port, availability) {
  if (availability !== "offline") return;
  const s = portState(port);
  if (s.openId) {
    console.warn(
      `⚠️  ${port}: انقطع أثناء التعبئة — السجل #${s.openId} يبقى مفتوحًا حتى عودته`
    );
  }
}

/** استعادة السجلات المفتوحة بعد إعادة تشغيل السيرفر */
async function resume() {
  const open = await History.findAllOpen();
  const resumed = [];
  for (const row of open) {
    const s = portState(row.portNum);
    if (s.openId) continue; // أحدث سجل للمنفذ فقط (الترتيب تنازلي)
    s.openId = row.id;
    s.startMeter = row.startMeter;
    resumed.push(`${row.portNum}#${row.id}`);
  }
  if (resumed.length) {
    console.log(`↩️  تعبئات مفتوحة استُعيدت: ${resumed.join(", ")}`);
  }
  return resumed;
}

/** للاستخدام من REST: الحالة الحالية لمنفذ (تشخيص) */
function getSession(port) {
  const s = ports.get(port);
  if (!s) return null;
  return {
    port,
    openId: s.openId,
    startMeter: s.startMeter,
    lastMeter: s.lastMeter,
    pendingMeta: s.meta,
    closing: Boolean(s.settleTimer),
  };
}

module.exports = {
  setIo,
  attachMeta,
  onFlowmeter,
  onState,
  onLogData,
  onAvailability,
  resume,
  getSession,
  END_STATES,
};
