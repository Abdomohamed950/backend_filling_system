/*
 * تشفير كلمات المرور — scrypt من node:crypto (بلا اعتماديات إضافية).
 *
 * الصيغة المخزّنة:  scrypt$<salt_hex>$<hash_hex>
 *
 * كلمات المرور القديمة مخزّنة نصًا صريحًا في قاعدة البيانات، فـ verify()
 * تقبلها للتوافق وتُبلغ عن الحاجة إلى ترقية (needsUpgrade)، ويقوم
 * تسجيل الدخول الناجح بإعادة تخزينها مشفّرة تلقائيًا.
 */

const crypto = require("crypto");

const KEYLEN = 32;
const SALTLEN = 16;
const PREFIX = "scrypt";

function hash(plain) {
  const salt = crypto.randomBytes(SALTLEN);
  const derived = crypto.scryptSync(String(plain), salt, KEYLEN);
  return `${PREFIX}$${salt.toString("hex")}$${derived.toString("hex")}`;
}

function isHashed(stored) {
  return typeof stored === "string" && stored.startsWith(`${PREFIX}$`);
}

/** يرجّع { ok, needsUpgrade } */
function verify(plain, stored) {
  if (typeof stored !== "string" || stored.length === 0) {
    return { ok: false, needsUpgrade: false };
  }

  if (!isHashed(stored)) {
    // كلمة مرور قديمة بنص صريح
    const a = Buffer.from(String(plain));
    const b = Buffer.from(stored);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    return { ok, needsUpgrade: ok };
  }

  const [, saltHex, hashHex] = stored.split("$");
  if (!saltHex || !hashHex) return { ok: false, needsUpgrade: false };

  const expected = Buffer.from(hashHex, "hex");
  const derived = crypto.scryptSync(
    String(plain),
    Buffer.from(saltHex, "hex"),
    expected.length
  );

  return {
    ok: crypto.timingSafeEqual(derived, expected),
    needsUpgrade: false,
  };
}

module.exports = { hash, verify, isHashed };
