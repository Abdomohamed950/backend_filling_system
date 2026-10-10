const express = require("express");
const router = express.Router();
const scadaServersController = require("../controllers/scadaServersControllers");
const resyncController = require("../controllers/scadaResyncControllers");
const { requireAuth, requireAdmin } = require("../middleware/auth");

router.get("/scada-servers", requireAuth, scadaServersController.getAll);
router.put("/scada-servers", requireAdmin, scadaServersController.replaceAll);
// "/test" قبل ":id" عشان ما يتفسرش كـ id
router.post("/scada-servers/test", requireAdmin, scadaServersController.testAdhoc);
router.post("/scada-servers/:id/test", requireAdmin, scadaServersController.testById);
router.post("/scada-servers/:id/resync",requireAdmin, resyncController.start);
router.get("/scada-servers/:id/resync", requireAuth, resyncController.status);
router.post("/scada-servers/:id/resync/cancel", requireAdmin, resyncController.cancel);

module.exports = router;
