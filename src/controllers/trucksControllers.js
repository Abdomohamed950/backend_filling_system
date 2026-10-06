const Trucks = require("../models/trucksModel");
const sessions = require("../services/fillingSessions");

// الواجهة بتسمع truck_updated / truck_deleted عشان تحدّث الجدول من غير refetch
const notify = (event, payload) => sessions.broadcast(event, payload);

const isConflict = (err) => /UNIQUE/i.test(err.message);
const isBadInput = (err) => /must be|is required/.test(err.message);

function fail(res, err, label) {
  if (isConflict(err)) return res.status(409).json({ error: "plate already exists" });
  if (isBadInput(err)) return res.status(400).json({ error: err.message });
  console.error(`Error ${label}:`, err);
  return res.status(500).json({ error: "Internal server error" });
}

module.exports = {
  getTrucks: async (req, res) => {
    try {
      res.json(await Trucks.findAll());
    } catch (err) {
      fail(res, err, "listing trucks");
    }
  },

  createTruck: async (req, res) => {
    try {
      const truck = await Trucks.create(req.body || {});
      notify("truck_updated", { truck });
      res.status(201).json({ message: "truck created successfully", truck });
    } catch (err) {
      fail(res, err, "creating truck");
    }
  },

  updateTruck: async (req, res) => {
    try {
      const truck = await Trucks.update(req.params.id, req.body || {});
      if (!truck) return res.status(404).json({ error: "truck not found" });
      notify("truck_updated", { truck });
      res.json({ message: "truck updated successfully", truck });
    } catch (err) {
      fail(res, err, "updating truck");
    }
  },

  deleteTruck: async (req, res) => {
    try {
      const removed = await Trucks.remove(req.params.id);
      if (!removed) return res.status(404).json({ error: "truck not found" });
      notify("truck_deleted", { id: Number(req.params.id) });
      res.json({ message: "truck deleted successfully" });
    } catch (err) {
      fail(res, err, "deleting truck");
    }
  },

  // POST /trucks/:id/reset-trips، أو /trucks/reset-trips لكل الشاحنات
  resetTrips: async (req, res) => {
    try {
      await Trucks.resetTrips(req.params.id);
      notify("trucks_reset", { id: req.params.id ? Number(req.params.id) : null });
      res.json({ message: "trips reset" });
    } catch (err) {
      fail(res, err, "resetting trips");
    }
  },
};
