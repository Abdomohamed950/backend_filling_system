/*
 * منطق التحقق من الباركود — مقابل receipt_check() في operator_interface.py
 * القديم، بما فيه "وضع الأزمات" (إدخال رقم المشغّل بدل الإيصال).
 */

const db = require("../config/database");
const Receipts = require("../models/receiptsModel");
const receiptSync = require("./receiptSync");

const CRISIS_BLOCKED_MESSAGE = "تم ملئ هذه السيارة مرة في وضع الأزمات اليوم";
const NOT_FOUND_MESSAGE = "الإيصال غير موجود";
const ALREADY_USED_MESSAGE = "الإيصال مستخدم بالفعل";

/** هل الشاحنة دي اتملت في وضع الأزمات النهارده بالفعل؟ (مقابل get_truck_today) */
async function truckFilledInCrisisToday(truckNum) {
  if (!truckNum) return false;
  const result = await db.query(
    `SELECT 1 FROM history
     WHERE "truckNum" = $1 AND "fillMode" = 'crisis'
       AND date("entryTime") = date('now','localtime')
     LIMIT 1`,
    [truckNum]
  );
  return result.rows.length > 0;
}

/**
 * @param {{port, receiptNumber, operatorId, truckNum, manualQuantity}} data
 * @returns {Promise<{status:string, message?:string, quantity?:number, receiptNum?:string, fillMode?:string}>}
 */
async function checkReceipt({ receiptNumber, operatorId, truckNum, manualQuantity }) {
  const raw = String(receiptNumber ?? "").trim();

  // وضع الأزمات: المشغّل دخّل رقمه الشخصي بدل رقم إيصال
  if (operatorId !== undefined && operatorId !== null && raw === String(operatorId).trim()) {
    const blocked = await truckFilledInCrisisToday(truckNum);
    if (blocked) return { status: "crisis_blocked", message: CRISIS_BLOCKED_MESSAGE };

    const quantity = Number(manualQuantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      return { status: "crisis_blocked", message: "الكمية المدخلة غير صالحة" };
    }
    return { status: "crisis_ok", quantity, fillMode: "crisis" };
  }

  let receipt = await Receipts.findByNum(raw);
  if (!receipt) {
    await receiptSync.getReceiptsFromApi(); // يمكن وصل لسه ولحقناه
    receipt = await Receipts.findByNum(raw);
  }
  if (!receipt) return { status: "not_found", message: NOT_FOUND_MESSAGE };
  if (receipt.checked) return { status: "already_used", message: ALREADY_USED_MESSAGE };

  return {
    status: "valid",
    quantity: receipt.waterQuantity,
    receiptNum: receipt.receiptNum,
    fillMode: "normal",
  };
}

module.exports = { checkReceipt };
