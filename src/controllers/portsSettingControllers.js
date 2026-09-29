const port = require("../models/portsSettingModel");

const portController = {
  // إنشاء مستخدم جديد
  createPort: async (req, res) => {
    try {
      const {
        name,
        mode,
        baudrate,
        serialFrame,
        endian,
        slaveId,
        registerAddress,
        firstCloseTime,
        secondCloseTime,
        firstCloseLag,
        SecondCloseLag,
        pidTime,
        addedTime,
        flowRateAddress,
        registerType,
        valveType,
      } = req.body;
      console.log(req.body);
      if (!name) {
        return res.status(400).json({
          error: "Name are required",
        });
      }

      const newport = await port.create({
        name,
        mode,
        baudrate,
        serialFrame,
        endian,
        slaveId,
        registerAddress,
        firstCloseTime,
        secondCloseTime,
        firstCloseLag,
        SecondCloseLag,
        pidTime,
        addedTime,
        flowRateAddress,
        registerType,
        valveType,
      });
      res.status(201).json({
        message: "port created successfully",
        port: newport,
      });
    } catch (error) {
      console.error("Error creating port:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  // الحصول على جميع المنافذ
  getPorts: async (req, res) => {
    try {
      const ports = await port.findAll();
      res.json(ports);
    } catch (error) {
      console.error("Error fetching ports:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  // الحصول على منفذ بواسطة ID
  getportById: async (req, res) => {
    try {
      const { id } = req.params;
      // لا تسمِّه port — كان يظلّل الـ import ويرجّع 500 دائمًا
      const found = await port.findById(id);

      if (!found) {
        return res.status(404).json({ error: "port not found" });
      }

      res.json(found);
    } catch (error) {
      console.error("Error fetching port:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  // تحديث مستخدم
  updateport: async (req, res) => {
    try {
      const { id } = req.params;
      const {
        name,
        mode,
        baudrate,
        serialFrame,
        endian,
        slaveId,
        registerAddress,
        firstCloseTime,
        secondCloseTime,
        firstCloseLag,
        SecondCloseLag,
        pidTime,
        addedTime,
        flowRateAddress,
        registerType,
        valveType,
      } = req.body;

      const existingport = await port.findById(id);
      if (!existingport) {
        return res.status(404).json({ error: "port not found" });
      }

      const updatedport = await port.update(id, {
        name,
        mode,
        baudrate,
        serialFrame,
        endian,
        slaveId,
        registerAddress,
        firstCloseTime,
        secondCloseTime,
        firstCloseLag,
        SecondCloseLag,
        pidTime,
        addedTime,
        flowRateAddress,
        registerType,
        valveType,
      });
      res.json({
        message: "port updated successfully",
        port: updatedport,
      });
    } catch (error) {
      console.error("Error updating port:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  // حذف مستخدم
  deletePort: async (req, res) => {
    try {
      const { id } = req.params;

      const existingport = await port.findById(id);
      if (!existingport) {
        return res.status(404).json({ error: "port not found" });
      }

      const deletedport = await port.delete(id);
      res.json({
        message: "port deleted successfully",
        port: deletedport,
      });
    } catch (error) {
      console.error("Error deleting port:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};

module.exports = portController;
