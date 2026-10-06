const db = require("../config/database");

const port = {
  // إنشاء الجداول أصبح مركزيًا في config/schema.js
  createTable: async () => db.init(),

  // إنشاء منفذ جديد
  create: async (portSettingData) => {
    const {
      name,
      mode,
      baudrate,
      serialFrame,
      endian,
      slaveId,
      registerAddress,
      firstCloseTime,
      secondCloseTime,
      firstCloseLag,
      SecondCloseLag,
      pidTime,
      addedTime,
      flowRateAddress,
      registerType,
      valveType,
      litersPerPulse,
      thirdCloseLag,
    } = portSettingData;

    const query = `
      INSERT INTO ports_setting (
        name, mode, baudrate, serialFrame, endian, "slaveId", "registerAddress",
        "firstCloseTime", "secondCloseTime", "firstCloseLag", "SecondCloseLag",
        "pidTime", "addedTime", "flowRateAddress", "registerType", "valveType",
        "litersPerPulse", "thirdCloseLag")
      VALUES ($1, COALESCE($2,'modbus'), COALESCE($3,9600), COALESCE($4,'SERIAL_8N1'),
              $5, $6, $7, COALESCE($8,0), COALESCE($9,0), COALESCE($10,0),
              COALESCE($11,0), COALESCE($12,0), COALESCE($13,0), COALESCE($14,0),
              $15, $16, $17, COALESCE($18,0))
      RETURNING *
    `;
    const values = [
      name,
      mode,
      baudrate,
      serialFrame,
      endian,
      slaveId,
      registerAddress,
      firstCloseTime,
      secondCloseTime,
      firstCloseLag,
      SecondCloseLag,
      pidTime,
      addedTime,
      flowRateAddress,
      registerType,
      valveType,
      litersPerPulse,
      thirdCloseLag,
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  },

  // الحصول على جميع المنافذ
  findAll: async () => {
    const result = await db.query(
      "SELECT * FROM ports_setting ORDER BY id ASC"
    );
    return result.rows;
  },

  // الحصول على منفذ بواسطة ID
  findById: async (id) => {
    const result = await db.query("SELECT * FROM ports_setting WHERE id = $1", [
      id,
    ]);
    return result.rows[0];
  },

  // الحصول على منفذ بواسطة الاسم (نفس truck_id في الـ mqtt topics)
  findByName: async (name) => {
    const result = await db.query(
      "SELECT * FROM ports_setting WHERE lower(name) = lower($1) LIMIT 1",
      [String(name).trim()]
    );
    return result.rows[0];
  },

  // تحديث منفذ — أي حقل غائب من الطلب يبقى كما هو
  update: async (id, portData) => {
    const {
      name,
      mode,
      baudrate,
      serialFrame,
      endian,
      slaveId,
      registerAddress,
      firstCloseTime,
      secondCloseTime,
      firstCloseLag,
      SecondCloseLag,
      pidTime,
      addedTime,
      flowRateAddress,
      registerType,
      valveType,
      litersPerPulse,
      thirdCloseLag,
    } = portData;

    const query = `
      UPDATE ports_setting
      SET name              = COALESCE($1,  name),
          mode              = COALESCE($2,  mode),
          baudrate          = COALESCE($3,  baudrate),
          serialFrame       = COALESCE($4,  serialFrame),
          endian            = COALESCE($5,  endian),
          "slaveId"         = COALESCE($6,  "slaveId"),
          "registerAddress" = COALESCE($7,  "registerAddress"),
          "firstCloseTime"  = COALESCE($8,  "firstCloseTime"),
          "secondCloseTime" = COALESCE($9,  "secondCloseTime"),
          "firstCloseLag"   = COALESCE($10, "firstCloseLag"),
          "SecondCloseLag"  = COALESCE($11, "SecondCloseLag"),
          "pidTime"         = COALESCE($12, "pidTime"),
          "addedTime"       = COALESCE($13, "addedTime"),
          "flowRateAddress" = COALESCE($14, "flowRateAddress"),
          "registerType"    = COALESCE($15, "registerType"),
          "valveType"       = COALESCE($16, "valveType"),
          "litersPerPulse"  = COALESCE($17, "litersPerPulse"),
          "thirdCloseLag"   = COALESCE($18, "thirdCloseLag")
      WHERE id = $19
      RETURNING *
    `;
    const values = [
      name,
      mode,
      baudrate,
      serialFrame,
      endian,
      slaveId,
      registerAddress,
      firstCloseTime,
      secondCloseTime,
      firstCloseLag,
      SecondCloseLag,
      pidTime,
      addedTime,
      flowRateAddress,
      registerType,
      valveType,
      litersPerPulse,
      thirdCloseLag,
      id,
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  },

  // حذف منفذ
  delete: async (id) => {
    const result = await db.query(
      "DELETE FROM ports_setting WHERE id = $1 RETURNING *",
      [id]
    );
    return result.rows[0];
  },
};

module.exports = port;
