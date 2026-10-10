const db = require("../config/database");
const resync = require("../services/scadaResync");const { toLocalStamp } = require("../utils/time");

const MAX_RANGE_MS = 31 * 24 * 3600 * 1000;
const asDate = (stamp) => new Date(stamp.replace(" ", "T"));

const findServer = async (req) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return null;
  return (await db.query("SELECT * FROM scada_servers WHERE id = $1", [id])).rows[0] || null;
};

const scadaResyncController = {
  start: async (req, res) => {
    try {
      const server = await findServer(req);
      if (!server) return res.status(404).json({ error: "server not found" });

      const from = toLocalStamp(req.body?.from);
      const to = toLocalStamp(req.body?.to);
      if (!from || !to) return res.status(400).json({ error: "from and to are required valid timestamps (YYYY-MM-DD HH:MM:SS)" });
      if (from > to) return res.status(400).json({ error: "from must be <= to" });
      if (asDate(to) - asDate(from) > MAX_RANGE_MS) {
        return res.status(400).json({ error: "range must be 31 days or less" });
      }
      if (resync.isRunning(server.id)) {
        return res.status(409).json({ error: "a resync job is already running for this server" });
      }

      res.status(202).json(await resync.start(server, from, to));
    } catch (error) {
      console.error("Error starting scada resync:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  status: async (req, res) => {
    const id = Number(req.params.id);
    const job = Number.isInteger(id) ? resync.getJob(id) : null;
    if (!job) return res.status(404).json({ error: "no resync job for this server" });
    res.json(resync.payload(job));
  },

  cancel: async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || !resync.cancel(id)) {
      return res.status(409).json({ error: "no running resync job for this server" });
    }
    res.json({ message: "cancelling after the current record" });
  },
};

module.exports = scadaResyncController;
