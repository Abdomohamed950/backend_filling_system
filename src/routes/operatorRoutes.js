const express = require("express");
const router = express.Router();
const OperatorController = require("../controllers/operatorControllers");
const { requireAuth, requireAdmin } = require("../middleware/auth");

// Routes
router.post("/operators", requireAdmin, OperatorController.createOperator);
router.get("/operators", requireAuth, OperatorController.getOperators);
router.get("/operators/:id", requireAuth, OperatorController.getOperatorById);
router.put("/operators/:id", requireAdmin, OperatorController.updateOperator);
router.delete("/operators/:id", requireAdmin, OperatorController.deleteOperator);

module.exports = router;
