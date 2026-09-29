const Report = require("../models/reportModel");

const reportController = {
  // GET /api/reports?port=allPorts&from=<ISO>&to=<ISO>
  getReports: async (req, res) => {
    try {
      const { port, from, to } = req.query;
      const report = await Report.build({ port, from, to });
      res.json(report);
    } catch (error) {
      console.error("Error building reports:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};

module.exports = reportController;
