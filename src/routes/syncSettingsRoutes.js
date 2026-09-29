const express = require("express");
const router = express.Router();
const syncSettingsController = require("../controllers/syncSettingsControllers");
const { requireAuth, requireAdmin } = require("../middleware/auth");

router.get("/sync-settings", requireAuth, syncSettingsController.getSettings);
router.put("/sync-settings", requireAdmin, syncSettingsController.updateSettings);

module.exports = router;
