const db = require("../config/database");

/*
 * قائمة الجلسات (توكنات) المسموح بها فعليًا — سطر واحد لكل تسجيل دخول.
 * التوكن JWT صالح توقيعًا لا يكفي وحده: middleware/auth.js يتحقق أيضًا
 * أن جلسته (jti) لا تزال هنا ولم تنتهِ. logout يحذف سطرًا واحدًا بعينه،
 * فيبطل هذا التوكن فقط دون التأثير على أجهزة أخرى لنفس المشغّل.
 */
const sessionModel = {
  // يُنادى عند تسجيل الدخول — يسجّل التوكن الجديد كجلسة صالحة
  create: async (jti, operatorId, expiresAt) => {
    await db.query(
      `INSERT INTO sessions (jti, operatorId, expiresAt) VALUES ($1, $2, $3)`,
      [jti, operatorId, expiresAt]
    );
  },

  // يُنادى مع كل طلب محمي (middleware/auth.js) — صالحة لو موجودة ولم تنتهِ بعد
  isActive: async (jti) => {
    const result = await db.query(
      `SELECT 1 FROM sessions WHERE jti = $1 AND expiresAt > datetime('now','localtime')`,
      [jti]
    );
    return result.rows.length > 0;
  },

  // logout: يحذف جلسة واحدة فقط — لا يمس بقية جلسات نفس المشغّل
  revoke: async (jti) => {
    const result = await db.query(`DELETE FROM sessions WHERE jti = $1`, [jti]);
    return result.rowCount > 0;
  },

  /*
   * انتهاء صلاحية الجلسة الطبيعي (JWT_EXPIRES_IN) لا يحذف سطرها تلقائيًا —
   * isActive تتجاهلها فتظل غير مؤذية، لكن الجدول يكبر بلا داعٍ بمرور الوقت
   * بلا تنضيف. تُنادى دوريًا من app.js.
   */
  pruneExpired: async () => {
    const result = await db.query(
      `DELETE FROM sessions WHERE expiresAt <= datetime('now','localtime')`
    );
    return result.rowCount;
  },
};

module.exports = sessionModel;
