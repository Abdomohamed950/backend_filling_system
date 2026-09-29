const db = require("../config/database");

// صف واحد ثابت (id=1) — إعدادات SCADA/Receipt API القابلة للتعديل من الـ UI
const syncSettings = {
  get: async () => {
    const result = await db.query("SELECT * FROM sync_settings WHERE id = 1");
    return result.rows[0];
  },

  update: async (fields) => {
    const {
      scadaEnabled,
      scadaHost,
      scadaPort,
      receiptApiEnabled,
      receiptApiBaseUrl,
      receiptRefreshMinutes,
    } = fields;

    const query = `
      UPDATE sync_settings
      SET scadaEnabled          = COALESCE($1,  scadaEnabled),
          scadaHost             = COALESCE($2,  scadaHost),
          scadaPort             = COALESCE($3,  scadaPort),
          receiptApiEnabled     = COALESCE($4,  receiptApiEnabled),
          receiptApiBaseUrl     = COALESCE($5,  receiptApiBaseUrl),
          receiptRefreshMinutes = COALESCE($6,  receiptRefreshMinutes),
          updatedAt             = datetime('now','localtime')
      WHERE id = 1
      RETURNING *
    `;
    const values = [
      scadaEnabled === undefined ? null : scadaEnabled,
      scadaHost ?? null,
      scadaPort === undefined ? null : Number(scadaPort),
      receiptApiEnabled === undefined ? null : receiptApiEnabled,
      receiptApiBaseUrl ?? null,
      receiptRefreshMinutes === undefined ? null : Number(receiptRefreshMinutes),
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  },
};

module.exports = syncSettings;
