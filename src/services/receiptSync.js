/*
 * مزامنة Receipt API — مقابل get_receipts_from_api / update_receipt_status /
 * check_receipt في database.py القديم.
 *
 * تحسين مقصود على مخاطرة موثّقة في القديم: لو فشل POST /Consume، الإيصال
 * بيتعلّم checked=1 محليًا برضه (عشان متوقفش المشغّل)، لكن بيتعلّم كمان
 * syncPending=1 عشان retryPendingConsume() تعيد المحاولة لاحقًا بدل ما
 * يفضل الفارق بين المحلي والسيرفر للأبد.
 */

const receiptApi = require("../transport/receiptApi");
const SyncSettings = require("../models/syncSettingsModel");
const Receipts = require("../models/receiptsModel");
const { toLocalStamp } = require("../utils/time");

/*
 * شكل الـ JSON الحقيقي الراجع من /today مش مؤكد (السيرفر مقفول حاليًا وقت
 * كتابة هذا الكود) — الـ mapping معزول هنا عشان يتعدّل بسهولة لما يشتغل.
 */
function mapApiReceipt(item) {
  return {
    receiptNum: String(item.receipt_number ?? item.receiptNum ?? item.ReceiptNumber ?? "").trim(),
    waterQuantity: Number(item.water_quantity ?? item.waterQuantity ?? item.Quantity ?? 0),
  };
}

function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toLocalStamp(d).slice(0, 10); // YYYY-MM-DD
}

async function getReceiptsFromApi() {
  const settings = await SyncSettings.get();
  if (!settings.receiptApiEnabled) return 0;

  try {
    const raw = await receiptApi.fetchToday(
      settings.receiptApiBaseUrl,
      dateOffset(-1),
      dateOffset(1)
    );
    const list = (Array.isArray(raw) ? raw : raw?.data || [])
      .map(mapApiReceipt)
      .filter((r) => r.receiptNum);
    const inserted = await Receipts.upsertMany(list);
    if (inserted) console.log(`🧾 Receipt API: ${inserted} إيصال جديد`);
    return inserted;
  } catch (err) {
    console.error(`❌ Receipt API GET /today فشل: ${err.message}`);
    return 0;
  }
}

async function updateReceiptStatus(receiptNum) {
  const settings = await SyncSettings.get();

  try {
    if (settings.receiptApiEnabled) {
      await receiptApi.postConsume(settings.receiptApiBaseUrl, { receipt_number: receiptNum });
    }
    await Receipts.markChecked(receiptNum);
  } catch (err) {
    console.error(`❌ Receipt API POST /Consume فشل (${receiptNum}): ${err.message}`);
    // زي القديم: نعلّمه مستهلَك محليًا حتى لو فشل السيرفر، عشان متوقفش المشغّل
    await Receipts.markChecked(receiptNum);
    await Receipts.markSyncPending(receiptNum, true);
  }
}

/** يعيد محاولة POST /Consume لأي إيصال اتعلّم محليًا لكن فشل إرساله للسيرفر */
async function retryPendingConsume() {
  const settings = await SyncSettings.get();
  if (!settings.receiptApiEnabled) return;

  const pending = await Receipts.findPendingConsume();
  for (const receipt of pending) {
    try {
      await receiptApi.postConsume(settings.receiptApiBaseUrl, {
        receipt_number: receipt.receiptNum,
      });
      await Receipts.markSyncPending(receipt.receiptNum, false);
      console.log(`✅ Receipt API: إعادة إرسال ${receipt.receiptNum} نجحت`);
    } catch {
      // لسه السيرفر مقفول — يتحاول تاني في الجولة الجاية
    }
  }
}

async function checkReceipt(receiptNum) {
  return Receipts.findByNum(receiptNum);
}

module.exports = { getReceiptsFromApi, updateReceiptStatus, retryPendingConsume, checkReceipt };
