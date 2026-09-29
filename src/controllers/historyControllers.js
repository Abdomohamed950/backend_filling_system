const History = require("../models/historyModel");
const sessions = require("../services/fillingSessions");

/*
 * من يكتب في history؟
 *
 * الأصل: رسائل الـ ESP (services/fillingSessions.js). الجهاز هو الذي يعرف
 * إن كانت التعبئة بدأت فعلًا، ومتى انتهت، وكم مرّ من العدّاد — والواجهة
 * قد تُغلق أو تفقد الشبكة في منتصف التعبئة فتضيع نهاية السجل.
 *
 * فبقي لـ POST /api/history دور واحد: نقل ما لا يعرفه الجهاز (المشغّل،
 * الشاحنة، الإيصال، الكمية المطلوبة) ليُلحق بالسجل الذي يفتحه الجهاز.
 * وضع التوافق القديم (الواجهة تكتب السجل بنفسها) يُفتح بـ
 * HISTORY_API_WRITES=true في .env.
 */
const API_WRITES = String(process.env.HISTORY_API_WRITES || "").toLowerCase() === "true";

// شكل «فتح سجل» كما ترسله الواجهة اليوم
const isOpenShape = (b) =>
  Boolean(b.portNum && b.operatorId && b.truckNum && b.receiptNum && b.requiredQuantity);

// شكل «إغلاق سجل»
const isCloseShape = (b) => Boolean(b.portNum) && b.actualQuantity !== undefined;

const historyController = {
  getHistory: async (req, res) => {
    try {
      const { port, from, to } = req.query;
      const logs = await History.findByDateAndPort({ port, from, to });
      res.status(200).json(logs);
    } catch (error) {
      console.error("Error fetching History:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  insertLog: async (req, res) => {
    try {
      const body = req.body || {};

      if (API_WRITES) return legacyInsert(req, res);

      if (isOpenShape(body) || isCloseShape(body)) {
        const { portNum } = body;

        // الكتابة الوحيدة الممكنة هنا: إلحاق بيانات الواجهة بسجل الجهاز
        const meta = isOpenShape(body) ? sessions.attachMeta(portNum, body) : null;
        const record = await History.findOpenByPort(portNum);

        return res.status(201).json({
          message: "Log inserted successfully",
          // السجل نفسه يفتحه ويغلقه الجهاز — هذا الرد إقرار بالاستلام
          mode: "esp-driven",
          note: "history is recorded from ESP messages; this payload only supplies operator/truck/receipt data",
          meta,
          Operator: record || null,
        });
      }

      return res.status(400).json({
        error:
          "Expected either { portNum, operatorId, truckNum, receiptNum, requiredQuantity } to supply record data, or { portNum, actualQuantity } as an end-of-filling ack",
      });
    } catch (error) {
      console.error("Error inserting to History:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  // تشخيص: حالة جلسة التعبئة الحالية لمنفذ (السجل المفتوح، آخر قراءة عداد)
  getSession: async (req, res) => {
    const { port } = req.params;
    const session = sessions.getSession(port);
    const record = await History.findOpenByPort(port);
    res.status(200).json({ port, session, openRecord: record || null });
  },
};

// السلوك القديم: الواجهة تكتب السجل بشكليه (HISTORY_API_WRITES=true)
async function legacyInsert(req, res) {
  const body = req.body || {};

  if (isOpenShape(body)) {
    const newLog = await History.insert_1(body);
    return res
      .status(201)
      .json({ message: "Log inserted successfully", Operator: newLog });
  }

  if (isCloseShape(body)) {
    const newLog = await History.insert_2(body);
    if (!newLog) {
      return res
        .status(404)
        .json({ error: `No open filling record for port "${body.portNum}"` });
    }
    return res
      .status(201)
      .json({ message: "Log inserted successfully", Operator: newLog });
  }

  return res.status(400).json({
    error:
      "Expected either { portNum, operatorId, truckNum, receiptNum, requiredQuantity } to open a record, or { portNum, actualQuantity } to close it",
  });
}

module.exports = historyController;
