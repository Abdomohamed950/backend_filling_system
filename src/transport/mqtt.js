const mqtt = require("mqtt");
const portModel = require("../models/portsSettingModel");
const sessions = require("../services/fillingSessions");

const MQTT_URL = process.env.MQTT_URL || "mqtt://localhost:1883";

/*
 * MQTT contract with the firmware (esp.ino).
 * <port> = truck_id on the device (/port_id.txt), e.g. "port1".
 *
 * Device -> server (retained status):
 *   <port>/flowmeter     float, 3 decimals
 *   <port>/flow_rate     float, 3 decimals
 *   <port>/state         filling | stoping | stop | emergency_stop
 *   <port>/valve_state   close | opening | open | closing_first | closing_second | closing_final
 *   <port>/availability  online | offline  (offline = broker Last Will)
 *   <port>/logdata       queued offline records (not retained)
 *   <port>/update        "config" -> asks for its configuration (retained request)
 *   <port>/debug         free-form debug text
 *   cam1/esp             "start" -> plate capture trigger
 *
 * Server -> device (commands, NEVER retained - a retained command replays on
 * every device reconnect and would re-open the valve):
 *   <port>/quantity      required quantity, 0 < q < 100 (firmware rejects the rest)
 *   <port>/state         start | force_stop
 *   <port>/conf          15 comma-separated fields, see buildConf()
 *   <port>/reset  <port>/refresh  <port>/send_logs  <port>/recapture
 */

// Topics published by the device - these are the only ones we listen to.
const DEVICE_TOPICS = [
  "flowmeter",
  "flow_rate",
  "state",
  "valve_state",
  "availability",
  "logdata",
  "update",
  "debug",
];

// Payloads we send on <port>/state. The device publishes its own status on the
// same topic, so we must drop our own echo instead of forwarding it to the UI.
const STATE_COMMANDS = ["start", "force_stop"];

const NUMERIC_TOPICS = ["flowmeter", "flow_rate"];

// مفردات الواجهة: close | open | opening | closing (backend.md §2.2)
const VALVE_STATE_ALIASES = {
  closing_first: "closing",
  closing_second: "closing",
  closing_final: "closing",
};

// Modes buildConf() can express; "milli ampere" uses yet another config[] layout.
const SUPPORTED_MODE = "modbus"; // default when the row has no mode
const SUPPORTED_MODES = ["modbus", "pulse"];

/*
 * The firmware compares these fields with exact, case-sensitive strings, so the
 * values stored in ports_setting have to be translated first:
 *   config[3]  == "AABBCCDD"      -> AABBCCDD byte order, anything else -> word swap
 *   config[13] == "HOLDING"       -> readHoldingRegisters, anything else -> readInputRegisters
 *   config[14] in valve|bump|valve and bump  -> otherwise RelayOpenDC/RelayCloseDC
 *                                              do nothing and the valve never moves
 */
const ENDIAN_ALIASES = {
  aabbccdd: "AABBCCDD",
  abcd: "AABBCCDD",
  big: "AABBCCDD",
  "big endian": "AABBCCDD",
  ddccbbaa: "DDCCBBAA",
  cdab: "CDAB",
  little: "CDAB",
  "little endian": "CDAB",
};

const REGISTER_TYPES = { holding: "HOLDING", input: "INPUT" };

const VALVE_TYPES = {
  valve: "valve",
  bump: "bump",
  pump: "bump",
  "valve and bump": "valve and bump",
  "valve and pump": "valve and bump",
};

function normalize(value, table, field, portName) {
  const key = String(value === null || value === undefined ? "" : value)
    .trim()
    .toLowerCase();
  const mapped = table[key];
  if (!mapped) {
    console.error(
      `❌ ${portName}: unknown ${field} "${value}" - expected one of ${Object.values(table)
        .filter((v, i, a) => a.indexOf(v) === i)
        .join(" | ")}`
    );
    return null;
  }
  return mapped;
}

const CONF_THROTTLE_MS = 2000;
const lastConfSent = new Map();

/**
 * pulse branch of setup() in main_makit.ino - 10 fields:
 *   0 mode ("pulse")        5 secondCloseLag   (liters)
 *   1 litersPerPulse        6 thirdCloseTime   (pidTime, ms)
 *   2 firstCloseTime (ms)   7 thirdCloseLag    (liters)
 *   3 secondCloseTime (ms)  8 addedTime (ms)
 *   4 firstCloseLag (liters) 9 valveType
 * The firmware closes in three stages as the remaining quantity drops under
 * firstCloseLag, then secondCloseLag, then thirdCloseLag (its else-if chain
 * assumes first >= second >= third), so any other order is refused here.
 * litersPerPulse <= 0 would leave the counter frozen and the valve open.
 */
function buildPulseConf(portName, row, num) {
  const valveType = normalize(row.valveType, VALVE_TYPES, "valveType", portName);
  if (!valveType) return null;

  const litersPerPulse = Number(row.litersPerPulse);
  if (!Number.isFinite(litersPerPulse) || litersPerPulse <= 0) {
    console.error(
      `❌ ${portName}: litersPerPulse must be a number > 0 for pulse mode (got "${row.litersPerPulse}")`
    );
    return null;
  }

  const lags = [num(row.firstCloseLag), num(row.SecondCloseLag), num(row.thirdCloseLag)];
  if (lags.some((l) => l < 0) || lags[0] < lags[1] || lags[1] < lags[2]) {
    console.error(
      `❌ ${portName}: close lags must satisfy first >= second >= third >= 0 (got ${lags.join(", ")})`
    );
    return null;
  }

  const conf = [
    "pulse",
    litersPerPulse,
    num(row.firstCloseTime),
    num(row.secondCloseTime),
    lags[0],
    lags[1],
    num(row.pidTime),
    lags[2],
    num(row.addedTime),
    valveType,
  ].join(",");

  if (conf.split(",").length !== 10) {
    console.error(`❌ malformed pulse conf for ${portName}: ${conf}`);
    return null;
  }
  return conf;
}

/**
 * Build the config string the firmware expects on <port>/conf.
 * Modbus layout below; pulse has its own (see buildPulseConf).
 * Field order must match config[] in esp.ino (modbus branch of setup()):
 *   0 mode            7  secondCloseTime
 *   1 baudrate        8  firstCloseLag
 *   2 serial frame    9  secondCloseLag
 *   3 endian          10 thirdCloseTime (pidTime)
 *   4 slaveId         11 addedTime
 *   5 flowmeter reg   12 flow rate reg
 *   6 firstCloseTime  13 registerType      14 valveType
 * splitString() is called with maxParts = 15, so exactly 15 fields must be sent.
 *
 * Returns null when the settings are unknown: better to leave the device asking
 * (it retries every 5s) than to hand it close timings that don't match its valve.
 */
async function buildConf(portName) {
  let row = null;
  try {
    row = await portModel.findByName(portName);
  } catch (err) {
    console.error(`❌ conf lookup failed for ${portName}:`, err.message);
    return null;
  }

  if (!row) {
    console.error(`❌ no ports_setting row named "${portName}" - not sending conf`);
    return null;
  }

  const num = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  const mode = String(row.mode || SUPPORTED_MODE).trim();
  if (!SUPPORTED_MODES.includes(mode)) {
    console.error(
      `❌ ${portName}: mode "${mode}" is not supported by buildConf() yet (only ${SUPPORTED_MODES.join(", ")})`
    );
    return null;
  }
  if (mode === "pulse") return buildPulseConf(portName, row, num);

  const endian = normalize(row.endian, ENDIAN_ALIASES, "endian", portName);
  const registerType = normalize(
    row.registerType,
    REGISTER_TYPES,
    "registerType",
    portName
  );
  const valveType = normalize(row.valveType, VALVE_TYPES, "valveType", portName);

  // Sending an unrecognised token means the device reads the wrong registers or
  // never actuates the valve at all - refuse instead.
  if (!endian || !registerType || !valveType) return null;

  const fields = [
    mode,
    num(row.baudrate, 9600),
    String(row.serialFrame || "SERIAL_8N1").trim(),
    endian,
    num(row.slaveId, 1),
    num(row.registerAddress),
    num(row.firstCloseTime),
    num(row.secondCloseTime),
    num(row.firstCloseLag),
    num(row.SecondCloseLag),
    num(row.pidTime),
    num(row.addedTime),
    num(row.flowRateAddress),
    registerType,
    valveType,
  ];

  const conf = fields.join(",");

  // A comma inside any field shifts every following index on the device.
  if (conf.split(",").length !== 15) {
    console.error(`❌ malformed conf for ${portName}: ${conf}`);
    return null;
  }

  return conf;
}

let sharedClient = null;

function mqtt_setup() {
  const mqttClient = mqtt.connect(MQTT_URL, {
    clientId: `filling_server_${process.pid}`,
    reconnectPeriod: 2000,
    clean: true,
  });

  mqttClient.on("connect", () => {
    console.log(`✅ Connected to MQTT broker (${MQTT_URL})`);

    // Only what the devices publish - "#" also fed our own commands back to us.
    const filters = DEVICE_TOPICS.map((t) => `+/${t}`).concat("cam1/esp");
    mqttClient.subscribe(filters, { qos: 1 }, (err) => {
      if (err) console.error("❌ MQTT subscribe failed:", err.message);
      else console.log("📡 Subscribed to:", filters.join(", "));
    });
  });

  mqttClient.on("error", (err) => console.error("❌ MQTT error:", err.message));
  mqttClient.on("offline", () => console.warn("⚠️  MQTT client offline"));

  sharedClient = mqttClient;
  return mqttClient;
}

/*
 * آخر حالة معروفة لكل منفذ: { [event]: payload }.
 * البروكر يحفظ الرسائل retained، لكن ذلك يفيد المشتركين الجدد على MQTT فقط —
 * أي عميل socket.io جديد لن يرى شيئًا حتى أول تغيير. هذا المخزن يسمح بإعادة
 * بث الحالة الحالية عند الاتصال أو عند join_port (backend.md §2.2).
 */
const lastByPort = new Map();

function remember(port, event, payload) {
  if (!lastByPort.has(port)) lastByPort.set(port, new Map());
  lastByPort.get(port).set(event, payload);
}

/** أحداث الحالة الحالية لمنفذ واحد: [[event, payload], …] */
function getSnapshot(port) {
  const events = lastByPort.get(port);
  return events ? [...events.entries()] : [];
}

/** أحداث الحالة الحالية لكل المنافذ المعروفة */
function getAllSnapshots() {
  const out = [];
  for (const port of lastByPort.keys()) out.push(...getSnapshot(port));
  return out;
}

/*
 * الفيرموير بيطبّق الإعدادات مرة واحدة بس في setup() (baudrate، أوقات القفل،
 * نوع الفلقة، slave id) وبعدها بيدخل while(1)، فاستلام <port>/conf جديد
 * لوحده مش بيغيّرها. بعد تعديل ports_setting لازم الجهاز يتعمله reset: بيقوم،
 * يطلب <port>/update، والسيرفر يرد بالـ conf الجديد (المسار الموجود فوق).
 *
 * مابنعملش reset وهو بيعبّي (هيقطع الفلقة في نص التعبئة)، ولا لجهاز offline
 * (هياخد القيم الجديدة لوحده أول ما يشتغل).
 * @returns {{sent: boolean, reason?: "busy"|"offline"|"mqtt_down"}}
 */
function applyConfigToDevice(port) {
  if (!sharedClient || !sharedClient.connected) return { sent: false, reason: "mqtt_down" };

  const last = new Map(getSnapshot(port));
  const availability = last.get("availability")?.data;
  const state = last.get("state")?.data;

  if (availability !== "online") return { sent: false, reason: "offline" };
  if (state === "filling" || state === "stoping") return { sent: false, reason: "busy" };

  // غير retained: reset retained كان هيعيد تشغيل الجهاز عند كل reconnect
  sharedClient.publish(`${port}/reset`, "1", { qos: 1, retain: false });
  console.log(`🔁 ${port}/reset (إعدادات المنفذ اتغيرت)`);
  return { sent: true };
}

function mqtt_messages(mqttClient, io) {
  mqttClient.on("message", async (topic, message, packet) => {
    const msg = message.toString();

    /*
     * البروكر يصفّر علم retain على الرسائل الحيّة ويرفعه فقط على ما يعيد
     * إرساله عند الاشتراك. فرسالة retained ليست تغيّر حالة جديدًا، بل صدى
     * لحالة سابقة — لا يجوز أن تفتح أو تغلق سجلًا (وإلا كرّر كل إقلاع للسيرفر
     * سجلات التعبئة الجارية). تُبثّ للواجهة كما هي، لكن جلسة التعبئة تتجاهلها.
     */
    const retained = Boolean(packet && packet.retain);

    if (topic === "cam1/esp") {
      io.emit("plate_capture", { data: msg });
      return;
    }

    const parts = topic.split("/");
    if (parts.length !== 2) return;

    const [port, top] = parts;
    if (!DEVICE_TOPICS.includes(top)) return;

    // Empty payload = a retained message being cleared.
    if (msg.length === 0) return;

    console.log("📩 " + topic + "\t" + msg);

    // The device asks for its configuration on boot (retained "config").
    if (top === "update") {
      const now = Date.now();
      if (now - (lastConfSent.get(port) || 0) < CONF_THROTTLE_MS) return;
      lastConfSent.set(port, now);

      const conf = await buildConf(port);
      if (!conf) return; // the device keeps asking every 5s

      // Not retained: the device re-asks every 5s until it gets an answer, and a
      // retained conf would re-split config[] on every reconnect, mid-filling.
      mqttClient.publish(`${port}/conf`, conf, { qos: 1, retain: false });
      // Clear the retained request so a server restart doesn't reconfigure everyone.
      mqttClient.publish(`${port}/update`, "", { qos: 1, retain: true });
      console.log(`⚙️  ${port}/conf -> ${conf}`);
      return;
    }

    // Our own start/force_stop coming back on the shared <port>/state topic.
    if (top === "state" && STATE_COMMANDS.includes(msg)) return;

    const payload = { port, data: msg };

    if (NUMERIC_TOPICS.includes(top)) {
      const value = Number(msg);
      payload.value = Number.isFinite(value) ? value : null;
    }

    // الفيرموير يرسل closing_first/second/final، والواجهة تعرف "closing" فقط.
    // data تُطبَّع إلى مفردات الواجهة، والقيمة الأصلية تبقى في raw.
    if (top === "valve_state" && VALVE_STATE_ALIASES[msg]) {
      payload.data = VALVE_STATE_ALIASES[msg];
      payload.raw = msg;
    }

    // السجلات ليست حالة — لا معنى لإعادة بثها لعميل جديد
    if (top !== "logdata" && top !== "debug") remember(port, top, payload);

    // بناء سجل التعبئة من رسائل الجهاز (services/fillingSessions.js)
    if (top === "flowmeter") sessions.onFlowmeter(port, payload.value);
    else if (top === "logdata") sessions.onLogData(port, msg);
    else if (top === "state" && !retained) sessions.onState(port, msg);
    else if (top === "availability" && !retained) sessions.onAvailability(port, msg);

    io.emit(top, payload);
  });
}

module.exports = {
  mqtt_setup,
  mqtt_messages,
  buildConf,
  applyConfigToDevice,
  getSnapshot,
  getAllSnapshots,
};
