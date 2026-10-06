const express = require("express");
const router = express.Router();
const trucks = require("../controllers/trucksControllers");
const { requireAuth, requireAdmin } = require("../middleware/auth");

router.get("/trucks", requireAuth, trucks.getTrucks);
router.post("/trucks", requireAdmin, trucks.createTruck);
// المسار الثابت قبل /:id عشان "reset-trips" ما يتفسّرش كـ id
router.post("/trucks/reset-trips", requireAdmin, trucks.resetTrips);
router.put("/trucks/:id", requireAdmin, trucks.updateTruck);
router.delete("/trucks/:id", requireAdmin, trucks.deleteTruck);
router.post("/trucks/:id/reset-trips", requireAdmin, trucks.resetTrips);

module.exports = router;
