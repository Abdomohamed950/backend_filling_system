const express = require("express");
const router = express.Router();
const portController = require("../controllers/portsSettingControllers");
const { requireAuth, requireAdmin } = require("../middleware/auth");

// Routes
router.post("/ports", requireAdmin, portController.createPort);
router.get("/ports", requireAuth, portController.getPorts);
router.get("/ports/:id", requireAuth, portController.getportById);
router.put("/ports/:id", requireAdmin, portController.updateport);
router.delete("/ports/:id", requireAdmin, portController.deletePort);

module.exports = router;

// {
//     "name": "port1",
//     "baudrate":"4800",
//     "endian": "little",
//     "registerType": "input",
//     "valveType": "type1",
//     "slaveId": 2,
//     "registerAddress": 1,
//     "firstCloseTime": 2,
//     "secondCloseTime": 1,
//     "firstCloseLag": 1,
//     "SecondCloseLag": 1,
//     "pidTime": 1,
//     "addedTime": 1,
//     "flowRateAddress": 1,
// }
