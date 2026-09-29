const express = require("express");
const router = express.Router();
const historyController = require("../controllers/historyControllers");
const { requireAuth } = require("../middleware/auth");

// Routes
router.post("/history", requireAuth, historyController.insertLog);
router.get("/history", requireAuth, historyController.getHistory);
// تشخيص جلسة التعبئة التي يقودها الجهاز (السجل المفتوح، آخر قراءة عداد)
router.get("/history/session/:port", requireAuth, historyController.getSession);

module.exports = router;
