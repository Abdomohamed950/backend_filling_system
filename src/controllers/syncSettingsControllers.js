const syncSettings = require("../models/syncSettingsModel");
const scadaSync = require("../services/scadaSync");

const syncSettingsController = {
  getSettings: async (req, res) => {
    try {
      const settings = await syncSettings.get();
      res.json(settings);
    } catch (error) {
      console.error("Error fetching sync settings:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  updateSettings: async (req, res) => {
    try {
      const {
        scadaEnabled,
        scadaHost,
        scadaPort,
        receiptApiEnabled,
        receiptApiBaseUrl,
        receiptRefreshMinutes,
      } = req.body;

      const updated = await syncSettings.update({
        scadaEnabled,
        scadaHost,
        scadaPort,
        receiptApiEnabled,
        receiptApiBaseUrl,
        receiptRefreshMinutes,
      });

      // لو الـ host/port اتغيّروا، لازم اتصال SCADA الحالي يتقفل ويتعاد بناؤه
      // على العنوان الجديد من أول طلب جاي، بدل ما يفضل متصل بالقديم
      scadaSync.invalidateClient();

      res.json({ message: "sync settings updated successfully", settings: updated });
    } catch (error) {
      console.error("Error updating sync settings:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};

module.exports = syncSettingsController;
