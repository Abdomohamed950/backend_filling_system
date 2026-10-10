/*
 * إعادة مزامنة SCADA لسيرفر واحد عن فترة زمنية — job في الخلفية مع تقدّم عبر
 * socket (scada_resync_progress). الحالة في الذاكرة بس (تضيع مع إعادة التشغيل).
 * الإرسال نفسه من scadaSync.resendRecord؛ هنا التسلسل والتقدّم والإلغاء بس.
 */

const crypto = require("crypto");
const db = require("../config/database");
const ScadaChannels = require("../models/scadaChannelsModel");
const scadaSync = require("./scadaSync");
const scadaDelete = require("../transport/scadaDelete");

const DELAY_MS = Number(process.env.SCADA_RESYNC_DELAY_MS ?? 100); // بين السجلات
const UNREACHABLE_MS = Number(process.env.SCADA_RESYNC_UNREACHABLE_MS ?? 120000); // بعدها failed
const EMIT_EVERY_MS = 300;
const KEEP_MS = 60 * 60 * 1000;

let io = null;
const jobs = new Map(); // serverId -> job

const init = (ioInstance) => {
  io = ioInstance;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const payload = (j) => ({
  jobId: j.jobId,
  serverId: j.serverId,
  status: j.status,
  phase: j.phase,
  total: j.total,
  done: j.sent + j.failed + j.skipped,
  sent: j.sent,
  failed: j.failed,
  skipped: j.skipped,
  from: j.from,
  to: j.to,
  ...(j.message ? { message: j.message } : {}),
});

function emit(j, force = false) {
  const now = Date.now();
  if (!force && now - j.lastEmit < EMIT_EVERY_MS) return;
  j.lastEmit = now;
  if (io) io.emit("scada_resync_progress", payload(j));
}

const getJob = (serverId) => jobs.get(serverId) || null;
const isRunning = (serverId) => jobs.get(serverId)?.status === "running";

/** يحسب total ويبدأ الـ job في الخلفية. بيرجع { jobId, total } */
async function start(server, from, to) {
  const { rows } = await db.query(
    `SELECT id FROM history WHERE exitTime IS NOT NULL AND entryTime BETWEEN $1 AND $2 ORDER BY id`,
    [from, to]
  );
  const j = {
    jobId: crypto.randomUUID(),
    serverId: server.id,
    status: "running",
    phase: "deleting", // deleting | sending
    total: rows.length,
    sent: 0,
    failed: 0,
    skipped: 0,
    from,
    to,
    cancelled: false,
    lastEmit: 0,
    cleanup: null,
  };
  const prev = jobs.get(server.id);
  if (prev?.cleanup) clearTimeout(prev.cleanup);
  jobs.set(server.id, j);
  emit(j, true);

  run(j, rows.map((r) => r.id)).catch((err) => finish(j, "failed", err.message));
  return { jobId: j.jobId, total: j.total };
}

function finish(j, status, message) {
  if (j.status !== "running") return;
  j.status = status;
  if (message) j.message = message;
  emit(j, true); // الحالة النهائية دايمًا
  j.cleanup = setTimeout(() => {
    if (jobs.get(j.serverId) === j) jobs.delete(j.serverId);
  }, KEEP_MS);
  j.cleanup.unref?.();
}

/** حذف قراءات الفترة من السيرفر قبل الإرسال (مرة واحدة، وبس لو فيه سجلات) */
async function deleteBefore(j, server) {
  emit(j, true);
  const client = scadaSync.getClient(server);
  if (!(await client.connect())) throw new Error(`server ${scadaSync.label(server)} is unreachable`);
  const reply = await scadaDelete.deleteReadings(client, j.from, j.to);
  console.log(`🗑️  SCADA resync ${scadaSync.label(server)}: اتمسحت قراءات ${j.from} → ${j.to} (رد: ${reply})`);
}

async function run(j, ids) {
  if (ids.length) {
    const first = (await db.query("SELECT * FROM scada_servers WHERE id = $1", [j.serverId])).rows[0];
    if (!first) return finish(j, "failed", "server was deleted");
    try {
      await deleteBefore(j, first);
    } catch (err) {
      // فشل الحذف = مفيش إرسال خالص (عشان ما يحصلش تكرار)
      return finish(j, "failed", `delete before resync failed: ${err.message}`);
    }
    if (j.cancelled) return finish(j, "cancelled");
  }
  j.phase = "sending";
  emit(j, true);
  let unreachableSince = 0;
  for (const id of ids) {
    if (j.cancelled) return finish(j, "cancelled");

    // السيرفر ممكن يتمسح أو يتعدّل أثناء الـ job: نقراه من جديد كل سجل
    const server = (await db.query("SELECT * FROM scada_servers WHERE id = $1", [j.serverId])).rows[0];
    if (!server) return finish(j, "failed", "server was deleted");
    const client = scadaSync.getClient(server);

    // circuit breaker: استنى بدل ما نحرق السجلات كـ failed
    while (!(await client.connect())) {
      if (j.cancelled) return finish(j, "cancelled");
      unreachableSince ||= Date.now();
      if (Date.now() - unreachableSince > UNREACHABLE_MS) {
        return finish(j, "failed", `server ${scadaSync.label(server)} is unreachable`);
      }
      await sleep(1000);
    }
    unreachableSince = 0;

    try {
      const history = (await db.query("SELECT * FROM history WHERE id = $1", [id])).rows[0];
      const channels = history && (await ScadaChannels.findByPort(history.portNum));
      if (!history || !channels) j.skipped++;
      else if (await scadaSync.resendRecord(server, history, channels)) j.sent++;
      else j.failed++;
    } catch (err) {
      console.error(`❌ SCADA resync #${id}: ${err.message}`);
      j.failed++;
    }
    emit(j);
    if (DELAY_MS > 0) await sleep(DELAY_MS);
  }
  finish(j, j.cancelled ? "cancelled" : "done");
}

/** بيرجع false لو مفيش job شغال */
function cancel(serverId) {
  const j = jobs.get(serverId);
  if (!j || j.status !== "running") return false;
  j.cancelled = true;
  return true;
}

module.exports = { init, start, cancel, getJob, isRunning, payload };
