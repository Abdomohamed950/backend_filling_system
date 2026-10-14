/*
 * حذف قراءات فترة من سيرفر SCADA عبر TCP قبل resync (بدل stored procedure
 * CarMovements_DeleteReadings في النظام القديم).
 *
 * صيغة الرسالة (من صاحب السيرفر): X <ChannelNumber> <FromISO> <ToISO>
 *   مثال: X 27 2025-05-08T03:30:16 2025-05-23T14:13:37
 * التاريخ ISO 8601 من غير مسافات. صيغة الرد (isDeleteAck) لسه مبدئية.
 */

/** 'YYYY-MM-DD HH:MM:SS' (المحلي) -> 'YYYY-MM-DDTHH:MM:SS' */
const toIso = (stamp) => String(stamp).trim().replace(" ", "T");

/** الرسالة المبعوتة لقناة واحدة (لازم تنتهي بـ \n) */
function buildDeleteMessage(channel, from, to) {
  return `X ${channel} ${toIso(from)} ${toIso(to)}\n`;
}

/** هل الرد معناه إن الحذف نجح؟ (مبدئيًا: "ok" أو رقم = عدد المحذوف) */
function isDeleteAck(reply) {
  if (typeof reply !== "string") return false;
  return /^ok$/i.test(reply.trim()) || /^\d+$/.test(reply.trim());
}

// السيرفر بيمسح من غير ما يرد بـ ack: بعد آخر أمر بنستنى شوية قبل أول P عشان المسح يخلص
const SETTLE_MS = Number(process.env.SCADA_DELETE_SETTLE_MS ?? 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * بيبعت أمر الحذف لكل قناة بالتسلسل.
 *  - رد صالح (ok / رقم) = تمام. رد تاني (مثلًا ERR) = فشل.
 *  - مفيش رد والاتصال لسه شغال = اتبعت ومتأكدناش (السيرفر مبيعملش ack): بنكمل.
 *  - مفيش رد والاتصال اتقفل = فشل.
 * أي فشل بيرمي خطأ بيسمّي القنوات اللي اتبعتت قبلها (مفيش transaction في
 * البروتوكول؛ الحذف بيتعاد بأمان).
 */
async function deleteReadings(client, from, to, channels) {
  const sent = [];
  let acked = 0;
  for (const channel of channels) {
    const reply = await client.sendReceive(buildDeleteMessage(channel, from, to));
    const done = sent.length ? ` (اتبعتت قبلها: ${sent.join(", ")})` : "";
    if (reply === null || reply === undefined) {
      if (!client.isAlive()) throw new Error(`channel ${channel}: connection lost${done}`);
    } else if (isDeleteAck(reply)) {
      acked++;
    } else {
      throw new Error(`channel ${channel}: unexpected reply (${reply})${done}`);
    }
    sent.push(channel);
  }
  if (acked < sent.length && SETTLE_MS > 0) await sleep(SETTLE_MS);
  return { sent, acked };
}

module.exports = { deleteReadings, buildDeleteMessage, isDeleteAck };
