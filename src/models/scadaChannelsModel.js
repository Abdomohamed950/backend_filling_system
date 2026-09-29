const db = require("../config/database");

// خريطة قنوات SCADA لكل منفذ — تُحرَّر من الـ UI (أدمن فقط)
const scadaChannels = {
  findAll: async () => {
    const result = await db.query("SELECT * FROM scada_channels ORDER BY portNum ASC");
    return result.rows;
  },

  findByPort: async (portNum) => {
    const result = await db.query(
      "SELECT * FROM scada_channels WHERE lower(portNum) = lower($1) LIMIT 1",
      [String(portNum).trim()]
    );
    return result.rows[0];
  },

  // إنشاء أو تحديث خريطة منفذ في نداء واحد — الـ UI تبعت الصف كامل دايمًا
  upsert: async (portNum, fields) => {
    const {
      truckCh,
      operatorCh,
      requiredCh,
      receiptCh,
      inTimeCh,
      flowmeterCh,
      flowTimeCh,
      actualCh,
      outTimeCh,
    } = fields;

    const query = `
      INSERT INTO scada_channels
        (portNum, truckCh, operatorCh, requiredCh, receiptCh,
         inTimeCh, flowmeterCh, flowTimeCh, actualCh, outTimeCh)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT(portNum) DO UPDATE SET
        truckCh     = excluded.truckCh,
        operatorCh  = excluded.operatorCh,
        requiredCh  = excluded.requiredCh,
        receiptCh   = excluded.receiptCh,
        inTimeCh    = excluded.inTimeCh,
        flowmeterCh = excluded.flowmeterCh,
        flowTimeCh  = excluded.flowTimeCh,
        actualCh    = excluded.actualCh,
        outTimeCh   = excluded.outTimeCh
      RETURNING *
    `;
    const values = [
      String(portNum).trim(),
      truckCh ?? null,
      operatorCh ?? null,
      requiredCh ?? null,
      receiptCh ?? null,
      inTimeCh ?? null,
      flowmeterCh ?? null,
      flowTimeCh ?? null,
      actualCh ?? null,
      outTimeCh ?? null,
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  },

  delete: async (portNum) => {
    const result = await db.query(
      "DELETE FROM scada_channels WHERE lower(portNum) = lower($1) RETURNING *",
      [String(portNum).trim()]
    );
    return result.rows[0];
  },
};

module.exports = scadaChannels;
