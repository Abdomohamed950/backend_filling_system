const scadaServers = require("../models/scadaServersModel");
const scadaSync = require("../services/scadaSync");
const { testConnection } = require("../transport/scada");

class ValidationError extends Error {}

function parseEnabled(v) {
  if (v === undefined) return 1;
  if (v === true || v === 1 || v === "1" || v === "true") return 1;
  if (v === false || v === 0 || v === "0" || v === "false") return 0;
  throw new ValidationError("enabled must be 0/1 or boolean");
}

/** يتحقق من الـ body كله قبل أي كتابة. بيرجع القايمة المنضّفة أو يرمي ValidationError */
function validate(body) {
  if (!body || !Array.isArray(body.servers)) throw new ValidationError("servers must be an array");
  const seenKeys = new Set();
  const seenIds = new Set();
  return body.servers.map((raw, i) => {
    const at = `servers[${i}]`;
    if (!raw || typeof raw !== "object") throw new ValidationError(`${at} must be an object`);

    const host = typeof raw.host === "string" ? raw.host.trim() : "";
    if (!host) throw new ValidationError(`${at}.host is required`);

    const port = typeof raw.port === "string" && raw.port.trim() !== "" ? Number(raw.port) : raw.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ValidationError(`${at}.port must be an integer between 1 and 65535`);
    }

    let id;
    if (raw.id !== undefined && raw.id !== null) {
      const n = typeof raw.id === "string" && /^\d+$/.test(raw.id) ? Number(raw.id) : raw.id;
      if (!Number.isInteger(n)) throw new ValidationError(`${at}.id must be an integer`);
      if (seenIds.has(n)) throw new ValidationError(`${at}.id ${n} is duplicated`);
      seenIds.add(n);
      id = n;
    }

    if (raw.name != null && typeof raw.name !== "string") throw new ValidationError(`${at}.name must be a string`);
    const name = raw.name ? raw.name.trim() || null : null;

    const key = `${host.toLowerCase()}:${port}`;
    if (seenKeys.has(key)) throw new ValidationError(`duplicate server ${host}:${port}`);
    seenKeys.add(key);

    return { id, name, host, port, enabled: parseEnabled(raw.enabled) };
  });
}

const scadaServersController = {
  getAll: async (req, res) => {
    try {
      res.json(await scadaServers.findAll());
    } catch (error) {
      console.error("Error fetching scada servers:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  // اختبار اتصال TCP من غير حفظ: body { host, port } (قبل الإضافة)
  testAdhoc: async (req, res) => {
    const host = typeof req.body?.host === "string" ? req.body.host.trim() : "";
    const port = typeof req.body?.port === "string" && req.body.port.trim() !== "" ? Number(req.body.port) : req.body?.port;
    if (!host) return res.status(400).json({ error: "host is required" });
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return res.status(400).json({ error: "port must be an integer between 1 and 65535" });
    }
    res.json(await testConnection(host, port));
  },

  // اختبار سيرفر محفوظ (حتى لو enabled = 0)
  testById: async (req, res) => {
    try {
      const id = Number(req.params.id);
      const server = Number.isInteger(id) ? (await scadaServers.findAll()).find((s) => s.id === id) : null;
      if (!server) return res.status(404).json({ error: "server not found" });
      res.json(await testConnection(server.host, server.port));
    } catch (error) {
      console.error("Error testing scada server:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  replaceAll: async (req, res) => {
    try {
      const list = validate(req.body);
      const saved = scadaServers.replaceAll(list);
      // الاتصالات القديمة تتقفل؛ القايمة بتتقرا من جديد عند أول تعبئة جاية
      scadaSync.invalidateClient();
      res.json(saved);
    } catch (error) {
      if (error instanceof ValidationError || error.status === 400) {
        return res.status(400).json({ error: error.message });
      }
      console.error("Error updating scada servers:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },
};

module.exports = scadaServersController;
