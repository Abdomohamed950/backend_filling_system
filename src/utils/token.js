/*
 * توكن JWT لتسجيل الدخول.
 *
 * السر يُقرأ من JWT_SECRET في .env؛ وإن لم يوجد يُولَّد مرة واحدة ويُحفظ
 * في data/.jwt_secret حتى لا تُلغى التوكنات عند كل إعادة تشغيل.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const EXPIRES_IN = process.env.JWT_EXPIRES_IN || "12h";

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;

  const dir = path.join(__dirname, "..", "..", "data");
  const file = path.join(dir, ".jwt_secret");

  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    fs.mkdirSync(dir, { recursive: true });
    const secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, secret, { mode: 0o600 });
    console.log(`🔑 JWT secret generated at ${file}`);
    return secret;
  }
}

const SECRET = loadSecret();

/*
 * jti فريد لكل توكن (لا لكل مشغّل) هو ما يتيح إبطال جلسة واحدة بعينها
 * عند logout دون التأثير على بقية أجهزة نفس المشغّل — راجع models/sessionModel.js
 * ومنطق التحقق في middleware/auth.js. الحمولة وحدها لا تكفي لتحديد صلاحية
 * الجلسة؛ يجب أن يكون jti مسجَّلًا في جدول sessions.
 */
function sign(user) {
  const jti = crypto.randomUUID();
  const signed = jwt.sign(
    {
      sub: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      jti,
    },
    SECRET,
    { expiresIn: EXPIRES_IN }
  );

  const { exp } = jwt.decode(signed);
  return { token: signed, jti, expiresAt: new Date(exp * 1000) };
}

/** يرجّع الحمولة أو null إن كان التوكن غير صالح/منتهيًا */
function verify(token) {
  try {
    return jwt.verify(token, SECRET);
  } catch {
    return null;
  }
}

/** يستخرج التوكن من ترويسة Authorization: Bearer <token> */
function fromHeader(req) {
  const header = req.headers.authorization || "";
  const [scheme, value] = header.split(" ");
  if (!value || scheme.toLowerCase() !== "bearer") return null;
  return value.trim();
}

module.exports = { sign, verify, fromHeader, EXPIRES_IN };
