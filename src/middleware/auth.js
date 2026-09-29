/*
 * المصادقة على مستوى الطلب.
 *
 * الواجهة تعمل بجلسة محلية بدون توكن (backend.md §1.1)، فالتفعيل الكامل
 * اختياري عبر AUTH_REQUIRED=true في .env:
 *
 *   attachUser   — يُطبَّق على كل الطلبات: يتحقق من التوكن إن وُجد ويضع
 *                  req.user، ويرفض التوكن التالف بـ 401. غيابه لا يمنع شيئًا.
 *   requireAuth  — يمنع الطلب بلا توكن صالح، إلا إذا AUTH_REQUIRED=false.
 *   requireAdmin — requireAuth + role === 'admin'.
 *
 * التوكن موقّع وقت الدخول فقط، فحذف صف operator بعدها لا يُبطل التوكنات
 * القديمة تلقائيًا — توقيعه يظل صحيحًا حتى ينتهي (JWT_EXPIRES_IN). resolveOperator
 * تسدّ الفجوة دي بالتحقق من القاعدة **في كل طلب**، لا من صلاحية التوقيع فقط؛
 * تُستخدم هنا ومن transport/socket.js لنفس السبب على أوامر التشغيل.
 */

const token = require("../utils/token");
const Operator = require("../models/operatorModel");
const Session = require("../models/sessionModel");

const AUTH_REQUIRED =
  String(process.env.AUTH_REQUIRED || "false").toLowerCase() === "true";

/**
 * يتحقق من توقيع التوكن، وجود صاحبه، وأن جلسته (jti) لسه مسجَّلة في
 * sessions ولم تُحذف بـ logout، ويرجّع { operator, reason }: operator
 * بيانات المشغّل الحالية من القاعدة (فتحديث الصلاحية يسري فورًا بلا إعادة
 * دخول) مع jti التوكن نفسه (يحتاجه authControllers.logout ليعرف أي جلسة
 * يحذف) لو التوكن سليم بكل معانيه، أو operator: null مع reason توضّح
 * السبب: 'missing' (بلا توكن) · 'invalid' (توقيع تالف/منتهي) · 'deleted'
 * (حُذف صاحبه) · 'revoked' (هذه الجلسة بعينها سُجِّل خروجها أو حُذفت).
 */
async function resolveOperator(raw) {
  if (!raw) return { operator: null, reason: "missing" };

  const payload = token.verify(raw);
  if (!payload) return { operator: null, reason: "invalid" };

  const operator = await Operator.findById(payload.sub);
  if (!operator) return { operator: null, reason: "deleted" };

  const active = await Session.isActive(payload.jti);
  if (!active) return { operator: null, reason: "revoked" };

  return {
    operator: {
      id: operator.id,
      name: operator.name,
      username: operator.username,
      role: operator.role,
      jti: payload.jti,
    },
    reason: null,
  };
}

const ATTACH_USER_MESSAGES = {
  invalid: "Invalid or expired token",
  deleted: "Operator no longer exists",
  revoked: "Session has been logged out",
};

async function attachUser(req, res, next) {
  const raw = token.fromHeader(req);
  if (!raw) return next();

  const { operator, reason } = await resolveOperator(raw);
  if (!operator) {
    return res.status(401).json({ error: ATTACH_USER_MESSAGES[reason] || "Unauthorized" });
  }

  req.user = operator;
  next();
}

function requireAuth(req, res, next) {
  if (!AUTH_REQUIRED) return next();
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  next();
}

function requireAdmin(req, res, next) {
  if (!AUTH_REQUIRED) return next();
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Admin role required" });
  }
  next();
}

module.exports = { attachUser, requireAuth, requireAdmin, resolveOperator, AUTH_REQUIRED };
