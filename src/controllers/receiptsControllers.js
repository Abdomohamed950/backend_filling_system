const receipts = require("../models/receiptsModel");

const receiptsController = {
  // GET /api/receipts?checked=0|1&from=&to=&search=
  getReceipts: async (req, res) => {
    try {
      const { checked, from, to, search } = req.query;
      const rows = await receipts.findAll({ checked, from, to, search });
      res.json(rows);
    } catch (error) {
      console.error("Error fetching receipts:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  // GET /api/receipts/:receiptNum
  getReceiptByNum: async (req, res) => {
    try {
      const { receiptNum } = req.params;
      const found = await receipts.findByNum(receiptNum);
      if (!found) return res.status(404).json({ error: "receipt not found" });
      res.json(found);
    } catch (error) {
      console.error("Error fetching receipt:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};

module.exports = receiptsController;
