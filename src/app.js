const express = require("express");
const http = require("http");
const cors = require("cors");

const authRoutes = require("./routes/authRoutes");
const operatorRoutes = require("./routes/operatorRoutes");
const portRoutes = require("./routes/portsSettingRoutes");
const historyRoutes = require("./routes/historyRoutes");
const reportRoutes = require("./routes/reportRoutes");
const syncSettingsRoutes = require("./routes/syncSettingsRoutes");
const scadaChannelsRoutes = require("./routes/scadaChannelsRoutes");
const scadaServersRoutes = require("./routes/scadaServersRoutes");
const receiptsRoutes = require("./routes/receiptsRoutes");
const trucksRoutes = require("./routes/trucksRoutes");
const { attachUser, AUTH_REQUIRED } = require("./middleware/auth");
const db = require("./config/database");
const { CAPTURES_DIR } = require("./services/devMode");
const Session = require("./models/sessionModel");
const SyncSettings = require("./models/syncSettingsModel");

// user modules
const socket = require("./transport/socket");
const mqtt = require("./transport/mqtt");
const sessions = require("./services/fillingSessions");
const scadaSync = require("./services/scadaSync");
const receiptSync = require("./services/receiptSync");

// socket and mqtt setup
const app = express();
const server = http.createServer(app);
const SOCKET_PORT = Number(process.env.SOCKET_PORT) || 5000;
server.listen(SOCKET_PORT, "0.0.0.0", () => {
  console.log(`🚀 Server running on http://localhost:${SOCKET_PORT}`);
});

const mqttClient = mqtt.mqtt_setup();
const io = socket.socket_setup(mqttClient, server);
// السجل يُبنى من رسائل الجهاز؛ الجلسة تحتاج io لتبثّ history_open/history_closed
sessions.setIo(io);
mqtt.mqtt_messages(mqttClient, io);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// يتحقق من التوكن إن وُجد ويضع req.user — الفرض الكامل بـ AUTH_REQUIRED=true
app.use(attachUser);
console.log(`🔐 Auth: ${AUTH_REQUIRED ? "مفروضة على مسارات التعديل" : "اختيارية (AUTH_REQUIRED=false)"}`);

// صور "جرّب القراءة" في dev_mode (بتتحفظ قبل الـ OCR)
app.use("/api/plate-captures", express.static(CAPTURES_DIR));

// Routes
app.use("/api", authRoutes);
app.use("/api", operatorRoutes);
app.use("/api", portRoutes);
app.use("/api", historyRoutes);
app.use("/api", reportRoutes);
app.use("/api", syncSettingsRoutes);
app.use("/api", scadaChannelsRoutes);
app.use("/api", scadaServersRoutes);
app.use("/api", receiptsRoutes);
app.use("/api", trucksRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// إنشاء كل الجداول والفهارس (كان ينشئ جدول operator فقط)
const initializeDatabase = async () => {
  try {
    const { file, version, tables } = db.init();
    console.log(`🗄️  SQLite ready: ${file}`);
    console.log(`   schema v${version} | tables: ${tables.join(", ")}`);

    // تعبئة كانت جارية وقت إيقاف السيرفر: استعد سجلها ليُغلق عند وصول stop
    await sessions.resume();
    console.log("📖 السجل يُكتب من رسائل الـ ESP (services/fillingSessions.js)");

    // مزامنة SCADA للسجلات المتأخرة (state=NULL) — مرة واحدة عند الإقلاع،
    // زي synchronize_data في database.py القديم. متسامحة مع فشل الاتصال.
    scadaSync
      .synchronizeBacklog()
      .catch((err) => console.error("❌ scadaSync.synchronizeBacklog فشل:", err.message));

    // إيصالات Receipt API: جلب أولي + تحديث دوري (افتراضي كل ساعة، من sync_settings)
    receiptSync
      .getReceiptsFromApi()
      .catch((err) => console.error("❌ receiptSync.getReceiptsFromApi فشل:", err.message));

    const receiptSettings = await SyncSettings.get();
    const refreshMs = (receiptSettings.receiptRefreshMinutes || 60) * 60 * 1000;
    setInterval(() => {
      receiptSync
        .getReceiptsFromApi()
        .catch((err) => console.error("❌ receiptSync.getReceiptsFromApi فشل:", err.message));
      receiptSync
        .retryPendingConsume()
        .catch((err) => console.error("❌ receiptSync.retryPendingConsume فشل:", err.message));
    }, refreshMs);

    // جلسات JWT منتهية طبيعيًا (JWT_EXPIRES_IN) لا تُحذف من sessions تلقائيًا
    // (isActive تتجاهلها فقط) — تنضيف عند الإقلاع، ثم كل ساعة، حتى لا يكبر
    // الجدول بلا داعٍ على سيرفر يفضل شغالًا لأسابيع.
    const pruned = await Session.pruneExpired();
    if (pruned) console.log(`🧹 حُذفت ${pruned} جلسة منتهية`);
    setInterval(() => {
      Session.pruneExpired().catch((err) =>
        console.error("❌ تنضيف الجلسات المنتهية فشل:", err.message)
      );
    }, 60 * 60 * 1000);
  } catch (error) {
    console.error("Error initializing database:", error);
    throw error;
  }
};

module.exports = { app, initializeDatabase };
