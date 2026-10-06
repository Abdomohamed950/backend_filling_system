/*
 * dev_mode — وضع منفصل تمامًا عن مسار التعبئة العادي.
 *
 * الواجهة تبعت dev_mode {enabled} لتشغيله/إيقافه (حالة مشتركة بين كل العملاء،
 * زي ai_mode). مغلق افتراضيًا: وهو مغلق، المستمع على MQTT بيرجع فورًا
 * ولا يُنشر أي شيء، فالسلوك الحالي للسيرفر ما بيتغيرش.
 *
 * يتحكم في مؤشر الـ stepper (makit/traffic) لكل منفذ بعدد لفّات قابل للضبط
 * من الواجهة بدل القيم الثابتة اللي كانت في esp_car/traffic:
 *   readyTurns  موضع الجاهزية (كان target_position = 4.1)
 *   stopTurns   موضع أول خطوة عند انتهاء التعبئة (كان 3.1)
 *   homeTurns   موضع الصفر المؤقت قبل العودة للجاهزية (كان 0)
 *
 * MQTT (السيرفر -> traffic، غير retained):
 *   <port>/turns        عدد اللفّات المطلوب، 0..MAX_TURNS
 *   <port>/turns_ready  readyTurns الحالي (retained - إعداد مش أمر حركة، فالجهاز
 *                       يعرف موضع الجاهزية بعد أي إعادة تشغيل)
 * وبيستمع على <port>/state (اللي السيرفر مشترك فيه أصلًا في transport/mqtt.js)
 * من غير ما يغيّر في ذلك الملف.
 *
 * Socket events (العميل -> السيرفر):
 *   dev_mode        { enabled }
 *   dev_get_turns   (port اختياري)  -> dev_turns { port, ...turns } لكل منفذ
 *   dev_set_turns   { port, readyTurns?, stopTurns?, homeTurns? }
 *   dev_move        { port, turns }  حركة يدوية للمعايرة
 *   dev_capture_plate               تشغيل قراءة الرقم يدويًا (بدل زرار main_makit)
 *   dev_get_settings                -> dev_settings (إعدادات الكاميرا/القراءة)
 *   dev_set_settings { camId?, camIndex?, camBackend?, plateDigits?, plateFrames?, roi?, debugDir? }
 *   dev_list_cameras                -> dev_cameras { cameras: [{index, device}] }
 * Socket events (السيرفر -> العميل):
 *   dev_mode_status { enabled }
 *   dev_turns       { port, readyTurns, stopTurns, homeTurns }
 *   dev_plate_image { camera, file, url }  صورة "جرّب القراءة" اتحفظت (قبل نتيجة الـ OCR)
 *   dev_plate       { camera, number }  الرقم المقروء من شاشة العربية (null لو فشلت القراءة)
 *   dev_settings    { camId, camIndex, camBackend, plateDigits, plateFrames, roi, debugDir }
 *   dev_cameras     { platform, backend, backends, cameras }
 *   dev_error       { event, message }
 *
 * قراءة رقم العربية: عند تشغيل dev_mode بيشغّل السيرفر utils/ai/plate_reader.py
 * (كاميرا USB على اللابتوب + OCR) وبيوقّفه عند الإيقاف. القارئ بيسمع على
 * <cam>/esp = "start" (main_makit بينشرها عند الزرار) ويرد على <cam>/plate.
 * إعدادات الكاميرا بتتضبط من الواجهة (dev_set_settings) وبتتحفظ في جدول
 * dev_mode_settings، وبتتمرر للقارئ كمتغيرات بيئة DEV_* عند تشغيله. تغييرها
 * أثناء تشغيل dev_mode بيعيد تشغيل القارئ تلقائيًا.
 */

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const db = require("../config/database");
const devCycle = require("./devCycle");
const { resolveOperator, AUTH_REQUIRED } = require("../middleware/auth");

// حد الفيرموير في traffic.ino: turns >= 0 && turns <= 6.6
const MAX_TURNS = 6.6;
const DEFAULTS = { readyTurns: 4.1, stopTurns: 3.1, homeTurns: 0 };
const CAM_BACKENDS = ["auto", "v4l2", "avfoundation", "any"];
const FIELDS = Object.keys(DEFAULTS);

// فواصل التسلسل عند stop (كانت delay() ثابتة في esp_car) — بدون حجب الـ loop
const STEP_GAP_MS = 3000;
const COMMAND_OPTS = { qos: 1, retain: false };

let mqttClient = null;
let io = null;
let enabled = false;
let tableReady = false;
let plateProc = null;
let cycle = null;

// صور "جرّب القراءة" (بتتحفظ قبل الـ OCR) — بتتخدم من app.js على /api/plate-captures
const CAPTURES_DIR = path.join(__dirname, "..", "..", "data", "plate_captures");
const PLATE_SCRIPT = path.join(__dirname, "..", "utils", "ai", "plate_reader.py");

// الافتراضيات؛ القيم المحفوظة من الواجهة بتغطي عليها
const SETTINGS_DEFAULTS = {
  camId: "cam1",
  camIndex: 0,
  camBackend: "auto", // auto | v4l2 | avfoundation | any
  plateDigits: 4,
  plateFrames: 5,
  roi: null, // { x, y, w, h } كنسب 0..1 من الصورة، أو null = الصورة كلها
  debugDir: "",
  defaultQuantity: 10, // الكمية الثابتة لشاحنة مالهاش كمية خاصة (0 < q < 100)
  arriveWaitMs: 5000, // انتظار وصول العربية تحت المنفذ قبل قراءة الرقم
};
let settings = { ...SETTINGS_DEFAULTS };
let subscribedPlateTopics = [];

const plateTopic = () => `${settings.camId}/plate`;
const plateImageTopic = () => `${settings.camId}/plate_image`;
const triggerTopic = () => `${settings.camId}/esp`;

// port -> [timeout ids] لإلغاء تسلسل جارٍ لو وصلت حالة جديدة
const timers = new Map();

async function ensureTable() {
  if (tableReady) return;
  await db.query(
    `CREATE TABLE IF NOT EXISTS dev_mode_turns (
       port       TEXT PRIMARY KEY,
       readyTurns REAL NOT NULL,
       stopTurns  REAL NOT NULL,
       homeTurns  REAL NOT NULL
     )`
  );
  await db.query(
    `CREATE TABLE IF NOT EXISTS dev_mode_settings (
       id   INTEGER PRIMARY KEY CHECK (id = 1),
       json TEXT NOT NULL
     )`
  );
  tableReady = true;
}

async function loadSettings() {
  await ensureTable();
  const { rows } = await db.query(`SELECT json FROM dev_mode_settings WHERE id = 1`);
  let saved = {};
  try {
    saved = rows[0] ? JSON.parse(rows[0].json) : {};
  } catch (_) {}
  settings = { ...SETTINGS_DEFAULTS, ...saved };
  return settings;
}

const intIn = (v, min, max, name) => {
  const n = Number(v);
  if (v === null || v === "" || !Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
};

function validateRoi(roi) {
  if (roi === null) return null;
  const out = {};
  for (const k of ["x", "y", "w", "h"]) {
    const n = Number(roi && roi[k]);
    if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error(`roi.${k} must be between 0 and 1`);
    out[k] = n;
  }
  if (out.w <= 0 || out.h <= 0 || out.x + out.w > 1 || out.y + out.h > 1) {
    throw new Error("roi must stay inside the image (x+w <= 1, y+h <= 1, w,h > 0)");
  }
  return out;
}

async function saveSettings(patch) {
  const next = { ...(await loadSettings()) };
  if (patch.camId !== undefined) {
    const id = String(patch.camId).trim();
    // بيدخل في اسم توبيك MQTT: ممنوع / و + و # والمسافات
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) throw new Error("camId must be letters, digits, _ or -");
    next.camId = id;
  }
  if (patch.camIndex !== undefined) next.camIndex = intIn(patch.camIndex, 0, 63, "camIndex");
  if (patch.camBackend !== undefined) {
    const b = String(patch.camBackend).trim().toLowerCase();
    if (!CAM_BACKENDS.includes(b)) throw new Error(`camBackend must be one of: ${CAM_BACKENDS.join(", ")}`);
    next.camBackend = b;
  }
  if (patch.plateDigits !== undefined) next.plateDigits = intIn(patch.plateDigits, 1, 12, "plateDigits");
  if (patch.plateFrames !== undefined) next.plateFrames = intIn(patch.plateFrames, 1, 20, "plateFrames");
  if (patch.roi !== undefined) next.roi = validateRoi(patch.roi);
  if (patch.debugDir !== undefined) next.debugDir = String(patch.debugDir || "").trim();
  if (patch.defaultQuantity !== undefined) {
    const q = Number(patch.defaultQuantity);
    if (patch.defaultQuantity === null || patch.defaultQuantity === "" || !Number.isFinite(q) || q <= 0 || q >= 100) {
      throw new Error("defaultQuantity must be a number between 0 and 100");
    }
    next.defaultQuantity = q;
  }
  if (patch.arriveWaitMs !== undefined) next.arriveWaitMs = intIn(patch.arriveWaitMs, 0, 60000, "arriveWaitMs");
  await db.query(
    `INSERT INTO dev_mode_settings (id, json) VALUES (1, $1)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`,
    [JSON.stringify(next)]
  );
  settings = next;
  return next;
}

// الباك إند الفعلي اللي القارئ هيستخدمه (نفس منطق auto في plate_reader.py)
function effectiveBackend() {
  if (settings.camBackend !== "auto") return settings.camBackend;
  if (process.platform === "darwin") return "avfoundation";
  if (process.platform === "linux") return "v4l2";
  return "any";
}

function listCameras() {
  if (effectiveBackend() === "v4l2") {
    try {
      return fs
        .readdirSync("/dev")
        .map((f) => /^video(\d+)$/.exec(f))
        .filter(Boolean)
        .map((m) => ({ index: Number(m[1]), device: `/dev/${m[0]}` }))
        .sort((a, b) => a.index - b.index);
    } catch (_) {
      return [];
    }
  }
  if (process.platform === "darwin") {
    // macOS مفيهوش /dev/videoN: بنجيب الأسماء من system_profiler (ترتيبها = index في AVFoundation)
    try {
      const out = execFileSync("system_profiler", ["SPCameraDataType", "-json"], { timeout: 5000 });
      const items = JSON.parse(out.toString()).SPCameraDataType || [];
      if (items.length) return items.map((c, i) => ({ index: i, device: c._name || `Camera ${i}` }));
    } catch (_) {}
  }
  // مفيش طريقة لعمل enumerate: قايمة indices شائعة والمستخدم يجرّب
  return [0, 1, 2, 3].map((i) => ({ index: i, device: `Camera ${i}` }));
}

function syncPlateSubscription() {
  const topics = [plateTopic(), plateImageTopic()];
  const stale = subscribedPlateTopics.filter((t) => !topics.includes(t));
  if (stale.length) mqttClient.unsubscribe(stale);
  subscribedPlateTopics = topics;
  mqttClient.subscribe(topics, { qos: 1 });
}

function validTurns(v) {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) && n >= 0 && n <= MAX_TURNS ? n : null;
}

async function getTurns(port) {
  await ensureTable();
  const { rows } = await db.query(
    `SELECT "readyTurns","stopTurns","homeTurns" FROM dev_mode_turns WHERE port = $1`,
    [port]
  );
  return { port, ...DEFAULTS, ...(rows[0] || {}) };
}

async function setTurns(port, patch) {
  const current = await getTurns(port);
  const next = { ...current };
  for (const f of FIELDS) {
    if (patch[f] === undefined) continue;
    const n = validTurns(patch[f]);
    if (n === null) throw new Error(`${f} must be a number between 0 and ${MAX_TURNS}`);
    next[f] = n;
  }
  await db.query(
    `INSERT INTO dev_mode_turns (port,"readyTurns","stopTurns","homeTurns")
     VALUES ($1,$2,$3,$4)
     ON CONFLICT(port) DO UPDATE SET
       "readyTurns"=excluded."readyTurns",
       "stopTurns"=excluded."stopTurns",
       "homeTurns"=excluded."homeTurns"`,
    [port, next.readyTurns, next.stopTurns, next.homeTurns]
  );
  return next;
}

function publishTurns(port, turns) {
  mqttClient.publish(`${port}/turns`, String(turns), COMMAND_OPTS);
  console.log(`🔧 dev_mode ${port}/turns -> ${turns}`);
}

function publishReady(port, turns) {
  mqttClient.publish(`${port}/turns_ready`, String(turns), { qos: 1, retain: true });
}

// port -> resolve() للـ Promise بتاعة تسلسل الخروج، عشان إلغاؤه ما يسيبش حد معلّق
const leaveResolvers = new Map();

function clearTimers(port) {
  for (const t of timers.get(port) || []) clearTimeout(t);
  timers.delete(port);
  const done = leaveResolvers.get(port);
  if (done) {
    leaveResolvers.delete(port);
    done();
  }
}

/*
 * خروج العربية بعد التعبئة: stopTurns ثم homeTurns وتفضل في البيت.
 * (كانت بترجع readyTurns لوحدها؛ دلوقتي رجوعها تحت المنفذ بيتم بدورة
 * dev_start_cycle من الواجهة.) بترجع Promise بتخلص بعد آخر خطوة.
 */
async function runLeaveSequence(port) {
  clearTimers(port);
  const t = await getTurns(port);
  const steps = [t.stopTurns, t.homeTurns];
  return new Promise((resolve) => {
    leaveResolvers.set(port, resolve);
    const ids = steps.map((turns, i) =>
      setTimeout(() => {
        publishTurns(port, turns);
        if (i === steps.length - 1) {
          timers.delete(port);
          leaveResolvers.delete(port);
          resolve();
        }
      }, i * STEP_GAP_MS)
    );
    timers.set(port, ids);
  });
}

function onMqttMessage(topic, message, packet) {
  if (!enabled) return;

  if (topic === plateTopic()) {
    const number = message.toString().trim();
    io.emit("dev_plate", { camera: settings.camId, number: number || null });
    cycle.onPlate(number || null);
    return;
  }
  if (topic === plateImageTopic()) {
    const file = path.basename(message.toString().trim());
    if (file) io.emit("dev_plate_image", { camera: settings.camId, file, url: `/api/plate-captures/${file}` });
    return;
  }
  const parts = topic.split("/");
  if (parts.length !== 2 || parts[1] !== "state") return;

  // رسالة retained = صدى حالة قديمة، وأوامرنا (start/force_stop) على نفس التوبيك
  if (packet && packet.retain) return;
  const msg = message.toString().trim();

  const port = parts[0];
  // لو في دورة dev_start_cycle على المنفذ ده، هي اللي بتتحكم في خروج العربية
  const handledByCycle = cycle.onState(port, msg);
  if (msg === "stop") {
    if (!handledByCycle) {
      runLeaveSequence(port).catch((err) =>
        console.error(`❌ dev_mode leave sequence ${port}:`, err.message)
      );
    }
  } else if (msg === "filling") {
    clearTimers(port); // تعبئة جديدة تلغي أي تسلسل لسه شغال
  }
}

async function publishAllReady() {
  const { rows } = await db.query(`SELECT name FROM ports_setting`);
  for (const { name } of rows) publishReady(name, (await getTurns(name)).readyTurns);
}

function readerEnv() {
  const env = {
    ...process.env,
    DEV_CAM_ID: settings.camId,
    DEV_CAM_INDEX: String(settings.camIndex),
    DEV_CAM_BACKEND: settings.camBackend,
    DEV_PLATE_DIGITS: String(settings.plateDigits),
    DEV_PLATE_FRAMES: String(settings.plateFrames),
    DEV_PLATE_DEBUG: settings.debugDir || "",
    DEV_PLATE_CAPTURES: CAPTURES_DIR,
  };
  if (settings.roi) {
    env.DEV_PLATE_ROI = [settings.roi.x, settings.roi.y, settings.roi.w, settings.roi.h].join(",");
  } else {
    delete env.DEV_PLATE_ROI;
  }
  return env;
}

function startPlateReader() {
  if (plateProc) return;
  const proc = spawn("python3", [PLATE_SCRIPT], {
    env: readerEnv(),
    cwd: path.join(__dirname, ".."),
  });
  plateProc = proc;
  proc.stdout.on("data", (d) => console.log(`[plate_reader] ${d}`.trimEnd()));
  proc.stderr.on("data", (d) => console.error(`[plate_reader] ${d}`.trimEnd()));
  // بدون المستمع ده يسقط السيرفر كله لو python3 مش موجود
  proc.on("error", (err) => {
    console.error(`❌ plate_reader failed to start: ${err.message}`);
    if (plateProc === proc) plateProc = null;
  });
  proc.on("close", (code) => {
    console.log(`plate_reader exited (${code})`);
    if (plateProc === proc) plateProc = null; // مش بنمسح عملية جديدة بعد restart
  });
}

function stopPlateReader() {
  if (plateProc) plateProc.kill();
  plateProc = null;
}

async function setEnabled(value) {
  enabled = Boolean(value);
  if (enabled) {
    try {
      await loadSettings();
    } catch (err) {
      console.error("❌ dev_mode settings:", err.message);
    }
    syncPlateSubscription();
    startPlateReader();
  } else stopPlateReader();
  if (!enabled) {
    cycle.reset();
    for (const port of [...timers.keys()]) clearTimers(port);
  }
  console.log(`🧪 dev_mode ${enabled ? "ON" : "OFF"}`);
  io.emit("dev_mode_status", { enabled });
  if (enabled) publishAllReady().catch((err) => console.error("❌ dev_mode turns_ready:", err.message));
}

function init(client, ioInstance) {
  mqttClient = client;
  io = ioInstance;
  cycle = devCycle.create({
    getMqtt: () => mqttClient,
    io,
    isEnabled: () => enabled,
    getSettings: () => settings,
    getTurns,
    publishTurns,
    leave: runLeaveSequence,
    clearLeave: clearTimers,
    triggerPlate: () => mqttClient.publish(triggerTopic(), "start", COMMAND_OPTS),
  });
  mqttClient.on("message", onMqttMessage);
  // نفس سبب mqtt.js: الاشتراكات بتضيع مع clean:true عند كل reconnect
  // (الاشتراك نفسه بيتم عند تشغيل dev_mode فقط، فمفيش أثر وهو مقفول)
  mqttClient.on("connect", () => {
    if (enabled) syncPlateSubscription();
  });
  process.on("exit", stopPlateReader);
}

function registerSocket(socket) {
  const fail = (event, err) => {
    console.error(`❌ ${event}:`, err.message);
    socket.emit("dev_error", { event, message: err.message });
  };

  /*
   * on(event, handler, { auth }): أي خطأ بيرجع للعميل كـ dev_error.
   * الأوامر اللي بتغيّر أو بتحرّك (auth: true) بتتحقق من المشغّل بنفس قاعدة
   * start_filling في transport/socket.js، لأن dev_start_cycle بيفتح الفلقة
   * وsocket.io مفيهوش middleware. القراءات مفتوحة.
   */
  const on = (event, handler, { auth = false } = {}) => {
    socket.on(event, async (data) => {
      try {
        let operator = null;
        if (auth) {
          const raw = socket.handshake.auth?.token;
          ({ operator } = await resolveOperator(raw));
          if (!operator && (AUTH_REQUIRED || raw)) {
            console.warn(`⚠️  ${event} رُفض: ${socket.id}`);
            throw new Error("unauthorized");
          }
        }
        await handler(data, operator);
      } catch (err) {
        fail(event, err);
      }
    });
  };

  socket.emit("dev_mode_status", { enabled });

  on("dev_mode", (data) => setEnabled(data && data.enabled), { auth: true });

  on("dev_get_turns", async (data) => {
    const port = typeof data === "string" ? data : data && data.port;
    let names = port ? [port] : [];
    if (!port) {
      const { rows } = await db.query(`SELECT name FROM ports_setting ORDER BY name`);
      names = rows.map((r) => r.name);
    }
    for (const name of names) socket.emit("dev_turns", await getTurns(name));
  });

  on(
    "dev_set_turns",
    async (data) => {
      if (!data || !data.port) throw new Error("port is required");
      const saved = await setTurns(data.port, data);
      io.emit("dev_turns", saved);
      if (enabled) publishReady(saved.port, saved.readyTurns);
    },
    { auth: true }
  );

  on(
    "dev_capture_plate",
    () => {
      if (!enabled) throw new Error("dev_mode is off");
      // "capture" = زي "start" بس القارئ بيحفظ الصورة قبل الـ OCR
      mqttClient.publish(triggerTopic(), "capture", COMMAND_OPTS);
    },
    { auth: true }
  );

  on("dev_get_settings", async () => {
    socket.emit("dev_settings", await loadSettings());
  });

  on(
    "dev_set_settings",
    async (data) => {
      const saved = await saveSettings(data || {});
      io.emit("dev_settings", saved);
      if (enabled) {
        // الكاميرا/الرقم/الـ ROI بتتقرأ وقت التشغيل: أعد تشغيل القارئ بالقيم الجديدة
        stopPlateReader();
        syncPlateSubscription();
        startPlateReader();
      }
    },
    { auth: true }
  );

  on("dev_list_cameras", () => {
    socket.emit("dev_cameras", {
      platform: process.platform,
      backend: effectiveBackend(),
      backends: CAM_BACKENDS,
      cameras: listCameras(),
    });
  });

  on(
    "dev_move",
    (data) => {
      if (!enabled) throw new Error("dev_mode is off");
      if (!data || !data.port) throw new Error("port is required");
      const turns = validTurns(data.turns);
      if (turns === null) throw new Error(`turns must be a number between 0 and ${MAX_TURNS}`);
      clearTimers(data.port);
      publishTurns(data.port, turns);
    },
    { auth: true }
  );

  cycle.registerSocket(socket, on);
}

module.exports = { init, registerSocket, MAX_TURNS, CAPTURES_DIR };
