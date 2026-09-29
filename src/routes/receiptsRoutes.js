const express = require("express");
const router = express.Router();
const receiptsController = require("../controllers/receiptsControllers");
const { requireAuth } = require("../middleware/auth");

router.get("/receipts", requireAuth, receiptsController.getReceipts);
router.get("/receipts/:receiptNum", requireAuth, receiptsController.getReceiptByNum);

module.exports = router;
