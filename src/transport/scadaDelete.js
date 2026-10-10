/*
 * حذف قراءات فترة من سيرفر SCADA عبر TCP قبل resync (بدل stored procedure
 * CarMovements_DeleteReadings في النظام القديم). رسالة واحدة للفترة كلها.
 *
 * ⚠️ صيغة الرسالة والرد هنا مبدئية — عدّل الدالتين دول (buildDeleteMessage و
 * isDeleteAck) على حسب اللي السيرفر بيفهمه. باقي الكود مبيعتمدش على الصيغة.
 */

/** الرسالة المبعوتة (لازم تنتهي بـ \n). التاريخ بين " " لأن فيه مسافة */
function buildDeleteMessage(from, to) {
  return `D "${from}" "${to}"\n`;
}

/** هل الرد معناه إن الحذف نجح؟ (مبدئيًا: "ok" أو رقم = عدد المحذوف) */
function isDeleteAck(reply) {
  if (typeof reply !== "string") return false;
  return /^ok$/i.test(reply.trim()) || /^\d+$/.test(reply.trim());
}

/** بيبعت أمر الحذف ويستنى ack؛ بيرمي خطأ لو الرد مش ack أو مفيش رد */
async function deleteReadings(client, from, to) {
  const reply = await client.sendReceive(buildDeleteMessage(from, to));
  if (!isDeleteAck(reply)) throw new Error(`no valid ack for delete (${reply ?? "no reply"})`);
  return reply;
}

module.exports = { deleteReadings, buildDeleteMessage, isDeleteAck };
