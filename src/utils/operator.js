// Commands sent to the firmware (esp.ino).
// They are published with retain: false on purpose - the device subscribes to
// <port>/state, so a retained "start" would be replayed by the broker on every
// reconnect and re-open the valve on its own.
const COMMAND_OPTS = { qos: 1, retain: false };

const sessions = require("../services/fillingSessions");

// esp.ino callback(): a quantity is accepted only when 0 < qty < 100
const MIN_QUANTITY = 0;
const MAX_QUANTITY = 100;

function start_filling(mqttClient, data) {
  const port = data && data.port;
  if (!port) {
    console.warn("⚠️  start_filling ignored: no port in payload");
    return false;
  }

  const qty = Number(data.required_quantity);
  if (!Number.isFinite(qty) || qty <= MIN_QUANTITY || qty >= MAX_QUANTITY) {
    console.warn(
      `⚠️  start_filling ignored: quantity ${data.required_quantity} out of range (0 < q < ${MAX_QUANTITY})`
    );
    return false;
  }

  /*
   * بيانات المشغّل/الشاحنة/الإيصال يعرفها هذا الأمر فقط — الجهاز لا يعرفها.
   * تُحفظ هنا ولا تُكتب في القاعدة: السجل يُفتح عندما يعلن الجهاز أنه بدأ
   * فعلًا (<port>/state=filling)، فلو رفض الكمية أو لم يستجب فلا سجل وهمي.
   */
  sessions.attachMeta(port, { ...data, required_quantity: qty });

  // Order matters: the device refuses "start" until it has a quantity.
  mqttClient.publish(`${port}/quantity`, String(qty), COMMAND_OPTS);
  mqttClient.publish(`${port}/state`, "start", COMMAND_OPTS);
  console.log(`▶️  ${port} start, quantity=${qty}`);
  return true;
}

function stop_filling(mqttClient, data) {
  const port = data && data.port;
  if (!port) {
    console.warn("⚠️  stop_filling ignored: no port in payload");
    return false;
  }

  // "force_stop" - the plain "stop" branch is commented out in the firmware.
  mqttClient.publish(`${port}/state`, "force_stop", COMMAND_OPTS);
  console.log(`⏹️  ${port} force_stop`);
  return true;
}

module.exports = { start_filling, stop_filling };
