const db = require("../config/database");
const Operator = require("../models/operatorModel");
const Session = require("../models/sessionModel");
const password = require("../utils/password");
const token = require("../utils/token");
const { toLocalStamp } = require("../utils/time");

const authController = {
  // POST /api/auth/login   { username, password }
  login: async (req, res) => {
    try {
      const username = req.body.username ?? req.body.user ?? req.body.code;
      const plain = req.body.password ?? req.body.pass;

      if (!username || !plain) {
        return res
          .status(400)
          .json({ error: "username and password are required" });
      }

      // يقبل username أو code المشغّل
      const user = await Operator.findByLogin(String(username).trim());
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const { ok, needsUpgrade } = password.verify(plain, user.pass);
      if (!ok) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      // ترقية شفّافة: كلمة المرور القديمة (نص صريح) تُخزَّن مشفّرة بعد أول دخول ناجح
      if (needsUpgrade) {
        try {
          await db.query("UPDATE operator SET pass = $1 WHERE id = $2", [
            password.hash(plain),
            user.id,
          ]);
          console.log(`🔒 password hashed for operator ${user.id}`);
        } catch (err) {
          console.error("⚠️  password upgrade failed:", err.message);
        }
      }

      // jti فريد لهذا التوكن تحديدًا — يُسجَّل كجلسة صالحة حتى يقدر logout
      // لاحقًا يحذف هذه الجلسة بعينها دون التأثير على أجهزة أخرى للمشغّل نفسه
      const { token: signed, jti, expiresAt } = token.sign(user);
      await Session.create(jti, user.id, toLocalStamp(expiresAt));

      res.json({
        token: signed,
        user: {
          id: user.id,
          name: user.name,
          username: user.username,
          role: user.role,
        },
      });
    } catch (error) {
      console.error("Error logging in:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  },

  // GET /api/auth/me   — للتحقق من صلاحية التوكن
  me: async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const fresh = await Operator.findById(req.user.id);
    if (!fresh) {
      return res.status(401).json({ error: "Operator no longer exists" });
    }
    res.json({ user: fresh });
  },

  /*
   * POST /api/auth/logout — يحذف جلسة *هذا التوكن بعينه* (req.user.jti،
   * أضافه resolveOperator) من sessions، فيبطله فورًا (middleware/auth.js).
   * بلا هذا، "تسجيل الخروج" كان مجرد مسح localStorage — التوكن نفسه يفضل
   * صالح لغاية انتهاء صلاحيته الطبيعية حتى لو مسحته الواجهة.
   *
   * بعكس التصميم السابق (عمود tokenVersion لكل مشغّل)، هذا لا يمس أي
   * جلسة أخرى لنفس المشغّل على جهاز/متصفح آخر.
   */
  logout: async (req, res) => {
    if (!req.user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    await Session.revoke(req.user.jti);
    res.json({ message: "Logged out" });
  },
};

module.exports = authController;
