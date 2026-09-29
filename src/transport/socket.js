const { Server } = require("socket.io");
const path = require("path");
const { spawn } = require("child_process");

let { start_filling, stop_filling } = require("../utils/operator");
const { getSnapshot, getAllSnapshots } = require("./mqtt");
const portModel = require("../models/portsSettingModel");
const History = require("../models/historyModel");
const { resolveOperator, AUTH_REQUIRED } = require("../middleware/auth");
const barcodeFlow = require("../services/barcodeFlow");
const receiptSync = require("../services/receiptSync");

const AI_SCRIPT = path.join(__dirname, "..", "utils", "ai", "app.py");
// app.py يحمّل موديله من مسار نسبي "utils/ai/best.pt"، فمجلد التشغيل لازم يكون src/
const AI_CWD = path.join(__dirname, "..");

// حالة التشغيل الذكي مشتركة بين كل العملاء (كانت لكل socket على حدة)
let aiModeProcess = null;
let aiModeRunning = false;

function socket_setup(mqttClient, server) {
  const io = new Server(server, {
    cors: {
      origin: "*", // React frontend
      methods: ["GET", "POST"],
    },
  });

  function replay(socket, events, label) {
    for (const [event, payload] of events) socket.emit(event, payload);
    if (events.length) {
      console.log(`↩️  ${label} -> ${socket.id} (${events.length} حدث)`);
    }
  }

  // Socket.IO handling
  io.on("connection", (socket) => {
    console.log("🟢 Client connected:", socket.id);

    // الحالة الحالية فورًا، وإلا تبقى البطاقات فاضية حتى أول تغيير
    replay(socket, getAllSnapshots(), "snapshot");
    socket.emit("ai_mode_status", { running: aiModeRunning });

    /*
     * snapshot أعلاه بيرجع بس تليمتري الجهاز (state/flowmeter/valve_state)
     * من الذاكرة — سجل history المفتوح (شاحنة/إيصال/كمية مطلوبة) مش جزء
     * منه لأنه مش حدث MQTT بيتحفظ في lastByPort. فأي عميل يتصل من غير ما
     * يعمل join_port لكل بورت (زي فتح الصفحة وعرض كل الكروت مرة واحدة)
     * كان هيشوف الكارت شغال (state=filling) لكن فاضي من بيانات التعبئة.
     * نفس المنطق اللي في join_port، لكن لكل المنافذ المفتوحة دفعة واحدة.
     */
    History.findAllOpen()
      .then((records) => {
        for (const record of records) {
          socket.emit("history_open", { port: record.portNum, record });
        }
        if (records.length) {
          console.log(`↩️  open history -> ${socket.id} (${records.length} سجل)`);
        }
      })
      .catch((err) =>
        console.error(`❌ snapshot: تعذّرت قراءة السجلات المفتوحة:`, err.message)
      );

    socket.on("join_port", async (port) => {
      const name = typeof port === "string" ? port : port && port.port;
      if (!name) return;
      socket.join(name);
      replay(socket, getSnapshot(name), `join_port ${name}`);

      // تليمتري المنفذ (الحالة/العداد/الصمام) بيرجع فورًا من الـ snapshot
      // أعلاه، لكن سجل history المفتوح (شاحنة/إيصال/كمية) ملوش snapshot في
      // الذاكرة زي أحداث الجهاز — يُقرأ من القاعدة عند كل join_port، ليصل
      // حتى لعميل انضم بعد فتح السجل (مثلًا تحديث الصفحة أثناء تعبئة جارية).
      try {
        const record = await History.findOpenByPort(name);
        if (record) socket.emit("history_open", { port: name, record });
      } catch (err) {
        console.error(`❌ join_port ${name}: تعذّرت قراءة السجل المفتوح:`, err.message);
      }
    });

    socket.on("leave_port", (port) => {
      const name = typeof port === "string" ? port : port && port.port;
      if (name) socket.leave(name);
    });

    socket.on("update_field", (data) => {
      socket.broadcast.emit("update_field", data);
    });

    /*
     * REST بيتحقق من صاحب التوكن في كل طلب (middleware/auth.js)، لكن
     * start_filling أمر Socket.IO مباشر لا يمرّ على أي middleware — يوزر
     * اتحذف وعنده توكن قديم صالح التوقيع كان يقدر يفتح الصمام فعليًا رغم
     * إن كل استدعاءات REST بتاعته بقت مرفوضة. الفحص هنا بيتم من القاعدة في
     * كل مرة (مش وقت الاتصال بس)، فلو اتحذف المشغّل أثناء اتصال socket
     * قديم لسه شغال، الأمر التالي بتاعه يُرفض برضو.
     *
     * stop_filling / stop_all_ports مش متأثرين عمدًا: إيقاف صمام لازم
     * يفضل ممكن حتى من مستخدم فقد صلاحيته — إيقاف الطارئ أهم من التحقق.
     */
    socket.on("start_filling", async (data) => {
      const raw = socket.handshake.auth?.token;
      const { operator, reason } = await resolveOperator(raw);
      if (!operator) {
        if (AUTH_REQUIRED || raw) {
          console.warn(`⚠️  start_filling رُفض (${reason}): ${socket.id}`);
          return;
        }
        // AUTH_REQUIRED=false وبلا توكن أصلًا — الوضع المسموح افتراضيًا
        // (بنش تيست بدون خدمة مصادقة، backend.md §1.1).
      }
      start_filling(mqttClient, data);
    });

    /*
     * وضع الباركود (sync_and_barcode.md، الجزء الثالث): مسح إيصال بيتحقق منه
     * محليًا ويبدأ التعبئة أوتوماتيك — نفس فحص الصلاحية اللي على start_filling
     * بالظبط، لأن ده بيؤدي لفتح صمام لو الإيصال سليم.
     */
    socket.on("check_receipt", async (data) => {
      const raw = socket.handshake.auth?.token;
      const { operator, reason } = await resolveOperator(raw);
      if (!operator) {
        if (AUTH_REQUIRED || raw) {
          console.warn(`⚠️  check_receipt رُفض (${reason}): ${socket.id}`);
          return;
        }
      }

      let result;
      try {
        result = await barcodeFlow.checkReceipt({
          port: data?.port,
          receiptNumber: data?.receipt_number ?? data?.receiptNumber,
          operatorId: data?.operator_id ?? data?.operatorId ?? operator?.id,
          truckNum: data?.truck_number ?? data?.truckNumber,
          manualQuantity: data?.required_quantity ?? data?.requiredQuantity,
        });
      } catch (err) {
        console.error("❌ check_receipt failed:", err.message);
        socket.emit("receipt_check_result", { status: "error", message: "خطأ داخلي" });
        return;
      }

      socket.emit("receipt_check_result", result);

      if (result.status === "valid" || result.status === "crisis_ok") {
        start_filling(mqttClient, {
          ...data,
          required_quantity: result.quantity,
          receipt_number: result.receiptNum ?? data?.receipt_number ?? data?.receiptNumber,
          fill_mode: result.fillMode,
        });

        if (result.status === "valid") {
          receiptSync
            .updateReceiptStatus(result.receiptNum)
            .catch((err) => console.error("❌ updateReceiptStatus failed:", err.message));
        }
      }
    });

    socket.on("stop_filling", (data) => stop_filling(mqttClient, data));

    // إغلاق كل المنافذ المعرّفة — شبكة أمان بعد stop_filling لكل منفذ
    socket.on("stop_all_ports", async () => {
      try {
        const ports = await portModel.findAll();
        console.log(`🛑 stop_all_ports (${ports.length} منفذ)`);
        for (const p of ports) stop_filling(mqttClient, { port: p.name });
      } catch (err) {
        console.error("❌ stop_all_ports failed:", err.message);
      }
    });

    socket.on("toggle_ai_mode", () => {
      if (aiModeRunning) {
        console.log("Stopping AI mode");
        if (aiModeProcess) aiModeProcess.kill();
        aiModeProcess = null;
        aiModeRunning = false;

        // ابعت لكل الأجهزة الحالة الجديدة
        io.emit("ai_mode_status", { running: false });
        return;
      }

      console.log("Starting AI mode");
      aiModeProcess = spawn("python3", [AI_SCRIPT], { cwd: AI_CWD });
      aiModeRunning = true;

      aiModeProcess.stdout.on("data", (data) => {
        console.log(`Output: ${data}`);
      });

      aiModeProcess.stderr.on("data", (data) => {
        console.error(`Error: ${data}`);
      });

      // بدون هذا المستمع يسقط السيرفر كله لو python3 غير مثبّت
      aiModeProcess.on("error", (err) => {
        console.error(`❌ AI mode failed to start: ${err.message}`);
        aiModeProcess = null;
        aiModeRunning = false;
        io.emit("ai_mode_status", { running: false });
      });

      aiModeProcess.on("close", (code) => {
        console.log(`Process exited with code ${code}`);
        aiModeProcess = null;
        aiModeRunning = false;

        // برودكاست الحالة بعد الإيقاف
        io.emit("ai_mode_status", { running: false });
      });

      // برودكاست الحالة بعد التشغيل
      io.emit("ai_mode_status", { running: true });
    });

    socket.on("disconnect", () => {
      console.log("🔴 Client disconnected:", socket.id);
    });
  });

  return io;
}

module.exports = { socket_setup };
