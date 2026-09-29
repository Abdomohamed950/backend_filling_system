const db = require("../config/database");
const password = require("../utils/password");

// الأعمدة التي يُسمح بإرجاعها للواجهة — بدون pass (backend.md §1.3)
const PUBLIC_COLUMNS = `id, name, username, role, code, phone, createdAt`;

const operator = {
  // إنشاء الجداول أصبح مركزيًا في config/schema.js
  createTable: async () => db.init(),

  // إنشاء مستخدم جديد
  create: async (operatorData) => {
    const { name, code, pass, phone, username, role } = operatorData;
    const query = `
      INSERT INTO operator (name, username, pass, role, code, phone)
      VALUES ($1, $2, $3, COALESCE($4,'operator'), $5, $6)
      RETURNING ${PUBLIC_COLUMNS}
    `;
    // تُخزَّن مشفّرة دائمًا (scrypt)
    const values = [name, username, password.hash(pass), role, code, phone];
    const result = await db.query(query, values);
    return result.rows[0];
  },

  // الحصول على جميع المستخدمين
  findAll: async () => {
    const result = await db.query(
      `SELECT ${PUBLIC_COLUMNS} FROM operator ORDER BY id ASC`
    );
    return result.rows;
  },

  // الحصول على مستخدم بواسطة ID
  findById: async (id) => {
    const result = await db.query(
      `SELECT ${PUBLIC_COLUMNS} FROM operator WHERE id = $1`,
      [id]
    );
    return result.rows[0];
  },

  // للمصادقة فقط — الصف كاملًا بما فيه pass. لا تُعِده في أي استجابة HTTP.
  findByLogin: async (usernameOrCode) => {
    const result = await db.query(
      `SELECT * FROM operator WHERE username = $1 OR code = $1 LIMIT 1`,
      [usernameOrCode]
    );
    return result.rows[0];
  },

  // تحديث مستخدم
  // COALESCE: أي حقل غائب من الطلب يبقى كما هو — الواجهة تحذف pass
  // إذا تركه المستخدم فارغًا، ويجب ألا يفقد المشغَّل كلمة مروره (§1.3)
  update: async (id, operatorData) => {
    const { name, code, pass, phone, username, role } = operatorData;
    const query = `
      UPDATE operator
      SET name     = COALESCE($1, name),
          code     = COALESCE($2, code),
          pass     = COALESCE($3, pass),
          phone    = COALESCE($4, phone),
          username = COALESCE($5, username),
          role     = COALESCE($6, role)
      WHERE id = $7
      RETURNING ${PUBLIC_COLUMNS}
    `;
    // pass غائب ⇒ null ⇒ COALESCE يبقي القديمة كما هي
    const values = [
      name,
      code,
      pass ? password.hash(pass) : null,
      phone,
      username,
      role,
      id,
    ];
    const result = await db.query(query, values);
    return result.rows[0];
  },

  // حذف مستخدم
  delete: async (id) => {
    const result = await db.query(
      `DELETE FROM operator WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
      [id]
    );
    return result.rows[0];
  },
};

module.exports = operator;
