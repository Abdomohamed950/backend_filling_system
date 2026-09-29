const scadaChannels = require("../models/scadaChannelsModel");

const scadaChannelsController = {
  getAll: async (req, res) => {
    try {
      const channels = await scadaChannels.findAll();
      res.json(channels);
    } catch (error) {
      console.error("Error fetching scada channels:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  getByPort: async (req, res) => {
    try {
      const { portNum } = req.params;
      const found = await scadaChannels.findByPort(portNum);
      if (!found) return res.status(404).json({ error: "channel map not found" });
      res.json(found);
    } catch (error) {
      console.error("Error fetching scada channel map:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  upsertByPort: async (req, res) => {
    try {
      const { portNum } = req.params;
      const {
        truckCh,
        operatorCh,
        requiredCh,
        receiptCh,
        inTimeCh,
        flowmeterCh,
        flowTimeCh,
        actualCh,
        outTimeCh,
      } = req.body;

      const updated = await scadaChannels.upsert(portNum, {
        truckCh,
        operatorCh,
        requiredCh,
        receiptCh,
        inTimeCh,
        flowmeterCh,
        flowTimeCh,
        actualCh,
        outTimeCh,
      });
      res.json({ message: "channel map saved successfully", channels: updated });
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
        return res.status(400).json({ error: `port "${req.params.portNum}" not found in ports_setting` });
      }
      console.error("Error saving scada channel map:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  deleteByPort: async (req, res) => {
    try {
      const { portNum } = req.params;
      const deleted = await scadaChannels.delete(portNum);
      if (!deleted) return res.status(404).json({ error: "channel map not found" });
      res.json({ message: "channel map deleted successfully", channels: deleted });
    } catch (error) {
      console.error("Error deleting scada channel map:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};

module.exports = scadaChannelsController;
