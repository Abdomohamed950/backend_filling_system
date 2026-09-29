const express = require("express");
const router = express.Router();
const scadaChannelsController = require("../controllers/scadaChannelsControllers");
const { requireAuth, requireAdmin } = require("../middleware/auth");

router.get("/scada-channels", requireAuth, scadaChannelsController.getAll);
router.get("/scada-channels/:portNum", requireAuth, scadaChannelsController.getByPort);
router.put("/scada-channels/:portNum", requireAdmin, scadaChannelsController.upsertByPort);
router.delete("/scada-channels/:portNum", requireAdmin, scadaChannelsController.deleteByPort);

module.exports = router;
