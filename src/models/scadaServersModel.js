const db = require("../config/database");

// سيرفرات SCADA — القايمة بتتستبدل كلها في transaction واحدة (PUT /scada-servers)
const scadaServers = {
  findAll: async () => {
    const result = await db.query("SELECT * FROM scada_servers ORDER BY id ASC");
    return result.rows;
  },

  findEnabled: async () => {
    const result = await db.query("SELECT * FROM scada_servers WHERE enabled = 1 ORDER BY id ASC");
    return result.rows;
  },

  /** servers: مصفوفة متحقَّق منها {id?, name, host, port, enabled}. أي خطأ = rollback كامل */
  replaceAll: (servers) => {
    const conn = db.db;
    const tx = conn.transaction((list) => {
      const existing = new Set(conn.prepare("SELECT id FROM scada_servers").all().map((r) => r.id));
      for (const s of list) {
        if (s.id !== undefined && !existing.has(s.id)) {
          const err = new Error(`server id ${s.id} not found`);
          err.status = 400;
          throw err;
        }
      }
      const keep = new Set(list.filter((s) => s.id !== undefined).map((s) => s.id));
      const del = conn.prepare("DELETE FROM scada_servers WHERE id = ?");
      for (const id of existing) if (!keep.has(id)) del.run(id);

      const upd = conn.prepare(
        `UPDATE scada_servers SET name = ?, host = ?, port = ?, enabled = ?,
                updatedAt = datetime('now','localtime') WHERE id = ?`
      );
      const ins = conn.prepare("INSERT INTO scada_servers (name, host, port, enabled) VALUES (?, ?, ?, ?)");
      for (const s of list) {
        if (s.id !== undefined) upd.run(s.name, s.host, s.port, s.enabled, s.id);
        else ins.run(s.name, s.host, s.port, s.enabled);
      }
      return conn.prepare("SELECT * FROM scada_servers ORDER BY id ASC").all();
    });
    return tx(servers);
  },
};

module.exports = scadaServers;
