const express = require("express");
const router = express.Router();
const reportController = require("../controllers/reportControllers");
const { requireAuth } = require("../middleware/auth");

router.get("/reports", requireAuth, reportController.getReports);

module.exports = router;
