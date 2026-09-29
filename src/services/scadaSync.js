/*
 * مزامنة SCADA (TCP، بروتوكول "P <channel> <value> <row_id>\n") — مقابل
 * send_readings_1 / send_readings_2 / synchronize_data في database.py القديم.
 *
 * فرق مقصود عن القديم: كل دالة هنا لازم تبتلع أخطاءها (اتصال مقطوع، رد غير
 * رقمي...) وترجع من غير ما ترمي استثناء — النداء من fillingSessions.js
 * fire-and-forget، فمزامنة SCADA أبدًا متأخرش أو توقف فتح/قفل سجل محلي.
 */

const { ScadaClient } = require("../transport/scada");
const SyncSettings = require("../models/syncSettingsModel");
const ScadaChannels = require("../models/scadaChannelsModel");
const History = require("../models/historyModel");
const db = require("../config/database");
const { nowStamp } = require("../utils/time");

let client = null;
let clientKey = null; // `${host}:${port}` — لمعرفة هل الإعدادات اتغيّرت

/** يُنادى بعد أي تعديل على sync_settings من الـ UI حتى يُعاد الاتصال بالعنوان الجديد */
function invalidateClient() {
  if (client) client.close();
  client = null;
  clientKey = null;
}

async function getClient(settings) {
  const key = `${settings.scadaHost}:${settings.scadaPort}`;
  if (client && clientKey === key) return client;

  if (client) client.close();
  client = new ScadaClient({ host: settings.scadaHost, port: settings.scadaPort });
  clientKey = key;
  return client;
}

const isNumeric = (v) => typeof v === "string" && /^\d+$/.test(v);

/** يبني "P <ch> <value> <rowOrFlow>\n" — القيمة الأخيرة "null" لو مفيش ربط */
function buildMessage(channel, value, linkId) {
  return `P ${channel} ${value ?? "null"} ${linkId ?? "null"}\n`;
}

/** بداية تعبئة — مقابل send_readings_1 */
async function sendReadings1(historyId) {
  await run(async () => {
    const settings = await SyncSettings.get();
    if (!settings.scadaEnabled) return;

    const history = await findHistoryById(historyId);
    if (!history) return;

    const channels = await ScadaChannels.findByPort(history.portNum);
    if (!channels) {
      console.warn(`⚠️  SCADA: لا توجد خريطة قنوات للمنفذ ${history.portNum} — تخطّي المزامنة`);
      return;
    }

    const scada = await getClient(settings);

    const rowId = await scada.sendReceive(
      buildMessage(channels.truckCh, history.truckNum, null)
    );
    // تصحيح مقصود لمشكلة موثّقة في القديم (database.py:610): فحص null قبل
    // استخدام الرد، بدل ما نفترض إنه string دايمًا
    if (!rowId || !isNumeric(rowId)) {
      console.error(`❌ SCADA: رد row_id غير صالح (${rowId}) للسجل #${historyId}`);
      return;
    }
    await History.setScadaRowId(historyId, rowId);

    const sequential = [
      [channels.operatorCh, history.operatorId],
      [channels.requiredCh, history.requiredQuantity],
      [channels.receiptCh, history.receiptNum],
      [channels.inTimeCh, history.entryTime],
    ];
    for (const [ch, value] of sequential) {
      if (!ch || value === null || value === undefined || value === "") continue;
      await scada.sendReceive(buildMessage(ch, value, rowId));
    }

    if (channels.flowmeterCh && history.startMeter !== null) {
      const flowId = await scada.sendReceive(
        buildMessage(channels.flowmeterCh, history.startMeter, null)
      );
      if (flowId && isNumeric(flowId)) {
        await History.setScadaFlowId(historyId, flowId);
        if (channels.flowTimeCh) {
          await scada.sendReceive(buildMessage(channels.flowTimeCh, history.entryTime, flowId));
        }
      } else {
        console.error(`❌ SCADA: رد flow_id غير صالح (${flowId}) للسجل #${historyId}`);
      }
    }
  }, "sendReadings1", historyId);
}

/** نهاية تعبئة — مقابل send_readings_2 */
async function sendReadings2(historyId) {
  await run(async () => {
    const settings = await SyncSettings.get();
    if (!settings.scadaEnabled) return;

    let history = await findHistoryById(historyId);
    if (!history) return;

    const channels = await ScadaChannels.findByPort(history.portNum);
    if (!channels) {
      console.warn(`⚠️  SCADA: لا توجد خريطة قنوات للمنفذ ${history.portNum} — تخطّي المزامنة`);
      return;
    }

    const scada = await getClient(settings);

    // البداية ما اتبعتتش (مثلاً السيرفر كان مقفول وقت الفتح) — ابعتها الأول
    if (!history.scadaRowId) {
      await sendReadings1(historyId);
      history = await findHistoryById(historyId);
      if (!history || !history.scadaRowId) return; // لسه فاشلة — لا داعي نكمل
    }

    const rowId = history.scadaRowId;

    if (channels.actualCh && history.actualQuantity !== null) {
      await scada.sendReceive(buildMessage(channels.actualCh, history.actualQuantity, rowId));
    }
    if (channels.outTimeCh && history.exitTime) {
      await scada.sendReceive(buildMessage(channels.outTimeCh, history.exitTime, rowId));
    }

    if (channels.flowmeterCh && history.endMeter !== null) {
      const flowId = await scada.sendReceive(
        buildMessage(channels.flowmeterCh, history.endMeter, null)
      );
      if (flowId && isNumeric(flowId)) {
        await History.setScadaFlowId(historyId, flowId);
        if (channels.flowTimeCh) {
          await scada.sendReceive(
            buildMessage(channels.flowTimeCh, history.exitTime || nowStamp(), flowId)
          );
        }
      } else {
        console.error(`❌ SCADA: رد flow_id غير صالح (${flowId}) للسجل #${historyId}`);
      }
    }

    await History.markScadaSynced(historyId);
    console.log(`✅ SCADA: سجل #${historyId} اتزامن`);
  }, "sendReadings2", historyId);
}

/** مقابل synchronize_data — بيتنادى مرة عند بدء التشغيل */
async function synchronizeBacklog() {
  const settings = await SyncSettings.get();
  if (!settings.scadaEnabled) return;

  const scada = await getClient(settings);
  const reachable = await scada.connect();
  if (!reachable) {
    console.warn("⚠️  SCADA: غير متاح عند بدء التشغيل — تخطّي مزامنة السجلات المتأخرة");
    return;
  }

  const backlog = await History.findUnsyncedClosed();
  if (!backlog.length) return;

  console.log(`🔄 SCADA: مزامنة ${backlog.length} سجل متأخر...`);
  for (const record of backlog) {
    try {
      await sendReadings2(record.id);
    } catch (err) {
      console.error(`❌ SCADA: فشلت مزامنة السجل #${record.id}: ${err.message}`);
      // نكمل الباقي — سجل واحد فاشل ميوقفش الباقي (زي database.py:894)
    }
  }
}

async function findHistoryById(id) {
  const result = await db.query("SELECT * FROM history WHERE id = $1", [id]);
  return result.rows[0] || null;
}

/** يغلّف أي دالة مزامنة عشان أي خطأ غير متوقع يتسجل ومايوصلش لمين نادى */
async function run(fn, label, historyId) {
  try {
    await fn();
  } catch (err) {
    console.error(`❌ SCADA ${label} (#${historyId}): ${err.message}`);
  }
}

module.exports = { sendReadings1, sendReadings2, synchronizeBacklog, invalidateClient };
