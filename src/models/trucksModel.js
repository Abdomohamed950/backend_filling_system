const db = require("../config/database");

const toTruck = (r) =>
  r && { ...r, limitEnabled: Boolean(r.limitEnabled), quantity: r.quantity ?? null };

// نفس حدود الفيرموير: الكمية المقبولة 0 < q < 100
function validQuantity(v) {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) && n > 0 && n < 100 ? n : null;
}

/** يتحقق من الحقول المبعوتة ويرجّع القيم المنظّفة (الحقول غير المبعوتة تتساب) */
function parse(data) {
  const out = {};
  if (data.plate !== undefined) {
    const plate = String(data.plate ?? "").trim();
    if (!plate || plate.length > 30) throw new Error("plate must be 1-30 characters");
    out.plate = plate;
  }
  if (data.quantity !== undefined) {
    if (data.quantity === null || data.quantity === "") out.quantity = null;
    else {
      out.quantity = validQuantity(data.quantity);
      if (out.quantity === null) throw new Error("quantity must be a number between 0 and 100");
    }
  }
  if (data.maxTrips !== undefined) {
    const n = Number(data.maxTrips);
    if (!Number.isInteger(n) || n < 0 || n > 9999) {
      throw new Error("maxTrips must be an integer between 0 and 9999");
    }
    out.maxTrips = n;
  }
  if (data.limitEnabled !== undefined) out.limitEnabled = data.limitEnabled ? 1 : 0;
  return out;
}

const trucks = {
  findAll: async () => {
    const { rows } = await db.query(`SELECT * FROM trucks ORDER BY plate`);
    return rows.map(toTruck);
  },

  findById: async (id) => {
    const { rows } = await db.query(`SELECT * FROM trucks WHERE id = $1`, [id]);
    return toTruck(rows[0]);
  },

  findByPlate: async (plate) => {
    if (plate === undefined || plate === null || String(plate).trim() === "") return null;
    const { rows } = await db.query(`SELECT * FROM trucks WHERE plate = $1`, [
      String(plate).trim(),
    ]);
    return toTruck(rows[0]);
  },

  create: async (data) => {
    const v = parse(data);
    if (v.plate === undefined) throw new Error("plate is required");
    const { rows } = await db.query(
      `INSERT INTO trucks (plate, quantity, limitEnabled, maxTrips)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [v.plate, v.quantity ?? null, v.limitEnabled ?? 0, v.maxTrips ?? 0]
    );
    return toTruck(rows[0]);
  },

  update: async (id, data) => {
    const cur = await trucks.findById(id);
    if (!cur) return null;
    const v = parse(data);
    const { rows } = await db.query(
      `UPDATE trucks SET plate = $1, quantity = $2, limitEnabled = $3, maxTrips = $4
       WHERE id = $5 RETURNING *`,
      [
        v.plate ?? cur.plate,
        v.quantity === undefined ? cur.quantity : v.quantity,
        v.limitEnabled ?? (cur.limitEnabled ? 1 : 0),
        v.maxTrips ?? cur.maxTrips,
        id,
      ]
    );
    return toTruck(rows[0]);
  },

  remove: async (id) => {
    const { rowCount } = await db.query(`DELETE FROM trucks WHERE id = $1`, [id]);
    return rowCount > 0;
  },

  /** id فاضي = كل الشاحنات */
  resetTrips: async (id) => {
    if (id) await db.query(`UPDATE trucks SET tripsDone = 0 WHERE id = $1`, [id]);
    else await db.query(`UPDATE trucks SET tripsDone = 0`);
  },

  /** نقلة اتمّت لشاحنة مسجّلة؛ بيرجّع الصف المحدّث أو null لو الشاحنة مش مسجّلة */
  incrementTrips: async (plate) => {
    if (plate === undefined || plate === null || String(plate).trim() === "") return null;
    const { rows } = await db.query(
      `UPDATE trucks SET tripsDone = tripsDone + 1 WHERE plate = $1 RETURNING *`,
      [String(plate).trim()]
    );
    return toTruck(rows[0]);
  },

  /**
   * بوابة حد النقلات. شاحنة غير مسجّلة أو حدها مقفول = تعدي عادي.
   * @returns {{ok: true, truck: object|null} | {ok: false, reason: "trips_exhausted", truck: object}}
   */
  checkLimit: async (plate) => {
    const truck = await trucks.findByPlate(plate);
    if (truck && truck.limitEnabled && truck.tripsDone >= truck.maxTrips) {
      return { ok: false, reason: "trips_exhausted", truck };
    }
    return { ok: true, truck };
  },
};

module.exports = trucks;
