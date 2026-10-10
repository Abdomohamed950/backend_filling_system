/*
 * مزامنة SCADA (TCP، بروتوكول "P <channel> <value> <row_id>\n") — مقابل
 * send_readings_1 / send_readings_2 / synchronize_data في database.py القديم.
 *
 * فرق مقصود عن القديم: كل دالة هنا لازم تبتلع أخطاءها (اتصال مقطوع، رد غير
 * رقمي...) وترجع من غير ما ترمي استثناء — النداء من fillingSessions.js
 * fire-and-forget، فمزامنة SCADA أبدًا متأخرش أو توقف فتح/قفل سجل محلي.
 */

const { ScadaClient } = require("../transport/scada");
const ScadaChannels = require("../models/scadaChannelsModel");
const ScadaServers = require("../models/scadaServersModel");
const db = require("../config/database");
const { nowStamp } = require("../utils/time");

// serverId -> { client, key } — كل سيرفر له اتصاله وcircuit breaker بتاعه
const clients = new Map();

/** يُنادى بعد أي تعديل على قايمة السيرفرات: الاتصالات بتتقفل وتتبني من جديد عند الحاجة */
function invalidateClient() {
  for (const { client } of clients.values()) client.close();
  clients.clear();
}

function getClient(server) {
  const key = `${server.host}:${server.port}`;
  const cached = clients.get(server.id);
  if (cached && cached.key === key) return cached.client;
  if (cached) cached.client.close();
  const client = new ScadaClient({ host: server.host, port: server.port });
  clients.set(server.id, { client, key });
  return client;
}

const label = (server) => `${server.name ? server.name + " " : ""}${server.host}:${server.port}`;

const isNumeric = (v) => typeof v === "string" && /^\d+$/.test(v);

/** يبني "P <ch> <value> <rowOrFlow>\n" — القيمة الأخيرة "null" لو مفيش ربط */
function buildMessage(channel, value, linkId) {
  return `P ${channel} ${value ?? "null"} ${linkId ?? "null"}\n`;
}

// ---- حالة المزامنة لكل (سجل، سيرفر) ----
const getState = async (historyId, serverId) =>
  (
    await db.query("SELECT * FROM scada_sync_state WHERE historyId = $1 AND serverId = $2", [
      historyId,
      serverId,
    ])
  ).rows[0] || null;

const ensureState = (historyId, serverId) =>
  db.query("INSERT OR IGNORE INTO scada_sync_state (historyId, serverId) VALUES ($1, $2)", [
    historyId,
    serverId,
  ]);

const setRowId = (historyId, serverId, rowId) =>
  db.query("UPDATE scada_sync_state SET rowId = $3 WHERE historyId = $1 AND serverId = $2", [
    historyId,
    serverId,
    String(rowId),
  ]);

const setFlowId = (historyId, serverId, flowId) =>
  db.query("UPDATE scada_sync_state SET flowId = $3 WHERE historyId = $1 AND serverId = $2", [
    historyId,
    serverId,
    String(flowId),
  ]);

const markSynced = (historyId, serverId) =>
  db.query("UPDATE scada_sync_state SET synced = 1 WHERE historyId = $1 AND serverId = $2", [
    historyId,
    serverId,
  ]);

/** بداية تعبئة على سيرفر واحد — مقابل send_readings_1 */
async function startOnServer(server, history, channels) {
  const historyId = history.id;
  const scada = getClient(server);

  const rowId = await scada.sendReceive(buildMessage(channels.truckCh, history.truckNum, null));
  // تصحيح مقصود لمشكلة موثّقة في القديم (database.py:610): فحص null قبل
  // استخدام الرد، بدل ما نفترض إنه string دايمًا
  if (!rowId || !isNumeric(rowId)) {
    console.error(`❌ SCADA ${label(server)}: رد row_id غير صالح (${rowId}) للسجل #${historyId}`);
    return;
  }
  await setRowId(historyId, server.id, rowId);

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
      await setFlowId(historyId, server.id, flowId);
      if (channels.flowTimeCh) {
        await scada.sendReceive(buildMessage(channels.flowTimeCh, history.entryTime, flowId));
      }
    } else {
      console.error(`❌ SCADA ${label(server)}: رد flow_id غير صالح (${flowId}) للسجل #${historyId}`);
    }
  }
}

/** نهاية تعبئة على سيرفر واحد — مقابل send_readings_2 */
async function endOnServer(server, history, channels) {
  const historyId = history.id;
  let state = await getState(historyId, server.id);
  if (!state) return; // السيرفر اتضاف/اتفعّل بعد بداية التعبئة دي: متخصوش

  // البداية ما اتبعتتش (مثلاً السيرفر كان واقع وقت الفتح) — ابعتها الأول
  if (!state.rowId) {
    await startOnServer(server, history, channels);
    state = await getState(historyId, server.id);
    if (!state || !state.rowId) return; // لسه فاشلة — لا داعي نكمل
  }

  const scada = getClient(server);
  const rowId = state.rowId;

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
      await setFlowId(historyId, server.id, flowId);
      if (channels.flowTimeCh) {
        await scada.sendReceive(
          buildMessage(channels.flowTimeCh, history.exitTime || nowStamp(), flowId)
        );
      }
    } else {
      console.error(`❌ SCADA ${label(server)}: رد flow_id غير صالح (${flowId}) للسجل #${historyId}`);
    }
  }

  await markSynced(historyId, server.id);
  console.log(`✅ SCADA ${label(server)}: سجل #${historyId} اتزامن`);
}

/**
 * إعادة إرسال سجل مقفول لسيرفر واحد (resync): بيحدّث صف scada_sync_state الموجود
 * بالقيم الجديدة من السيرفر. بيرجع true لو اتزامن؛ وإلا بيرجّع الحالة القديمة.
 */
async function resendRecord(server, history, channels) {
  const old = await getState(history.id, server.id);
  await ensureState(history.id, server.id);
  await db.query(
    "UPDATE scada_sync_state SET rowId = NULL, flowId = NULL, synced = 0 WHERE historyId = $1 AND serverId = $2",
    [history.id, server.id]
  );
  let ok = false;
  try {
    await endOnServer(server, history, channels);
    ok = Boolean((await getState(history.id, server.id))?.synced);
  } finally {
    if (!ok && old) {
      await db.query(
        "UPDATE scada_sync_state SET rowId = $3, flowId = $4, synced = $5 WHERE historyId = $1 AND serverId = $2",
        [history.id, server.id, old.rowId, old.flowId, old.synced]
      );
    }
  }
  return ok;
}

/** يشغّل fn(server) على كل السيرفرات بالتوازي؛ فشل سيرفر بيتسجل وما بيأثرش على الباقي */
async function forEachServer(servers, fn, what, historyId) {
  await Promise.allSettled(
    servers.map(async (server) => {
      try {
        await fn(server);
      } catch (err) {
        console.error(`❌ SCADA ${label(server)} ${what} (#${historyId}): ${err.message}`);
      }
    })
  );
}

/** بيحمّل السجل وخريطة القنوات والسيرفرات المفعّلة، أو null لو مفيش حاجة تتبعت */
async function loadContext(historyId) {
  const servers = await ScadaServers.findEnabled(); // بتتقرا كل مرة: التعديل بيسري فورًا
  if (!servers.length) return null;

  const history = await findHistoryById(historyId);
  if (!history) return null;

  const channels = await ScadaChannels.findByPort(history.portNum);
  if (!channels) {
    console.warn(`⚠️  SCADA: لا توجد خريطة قنوات للمنفذ ${history.portNum} — تخطّي المزامنة`);
    return null;
  }
  return { servers, history, channels };
}

/** بداية تعبئة — لكل سيرفر مفعّل بالتوازي */
async function sendReadings1(historyId) {
  await run(async () => {
    const ctx = await loadContext(historyId);
    if (!ctx) return;
    const { servers, history, channels } = ctx;
    for (const server of servers) await ensureState(historyId, server.id);
    await forEachServer(servers, (server) => startOnServer(server, history, channels), "sendReadings1", historyId);
  }, "sendReadings1", historyId);
}

/** نهاية تعبئة — لكل سيرفر مفعّل بالتوازي */
async function sendReadings2(historyId) {
  await run(async () => {
    const ctx = await loadContext(historyId);
    if (!ctx) return;
    const { servers, history, channels } = ctx;
    await forEachServer(servers, (server) => endOnServer(server, history, channels), "sendReadings2", historyId);
  }, "sendReadings2", historyId);
}

/** مقابل synchronize_data — بيتنادى مرة عند بدء التشغيل، لكل سيرفر على حدة */
async function synchronizeBacklog() {
  const servers = await ScadaServers.findEnabled();

  await Promise.allSettled(
    servers.map(async (server) => {
      try {
        const reachable = await getClient(server).connect();
        if (!reachable) {
          console.warn(`⚠️  SCADA ${label(server)}: غير متاح عند بدء التشغيل — تخطّي مزامنة السجلات المتأخرة`);
          return;
        }

        const { rows: backlog } = await db.query(
          `SELECT h.* FROM scada_sync_state st JOIN history h ON h.id = st.historyId
           WHERE st.serverId = $1 AND st.synced = 0 AND h.exitTime IS NOT NULL
           ORDER BY h.id ASC`,
          [server.id]
        );
        if (!backlog.length) return;

        console.log(`🔄 SCADA ${label(server)}: مزامنة ${backlog.length} سجل متأخر...`);
        for (const record of backlog) {
          try {
            const channels = await ScadaChannels.findByPort(record.portNum);
            if (!channels) continue;
            await endOnServer(server, record, channels);
          } catch (err) {
            console.error(`❌ SCADA ${label(server)}: فشلت مزامنة السجل #${record.id}: ${err.message}`);
            // نكمل الباقي — سجل واحد فاشل ميوقفش الباقي (زي database.py:894)
          }
        }
      } catch (err) {
        console.error(`❌ SCADA ${label(server)} backlog: ${err.message}`);
      }
    })
  );
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

module.exports = {
  sendReadings1,
  sendReadings2,
  synchronizeBacklog,
  invalidateClient,
  resendRecord,
  getClient,
  label,
};
