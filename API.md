# واجهات الخدمة — REST · Socket.IO · MQTT

> هذا الملف يوصّف **ما هو منفَّذ فعلًا في الكود** (تم التحقق من كل نموذج هنا
> بطلب حقيقي على السيرفر). العقد المطلوب من الواجهة الأمامية موجود في
> [backend.md](backend.md)، والفروق بينهما مجمّعة في [القسم ١١](#١١-الفروق-عن-backendmd).
>
> آخر تحديث: 2026-09-19

## المحتويات

1. [التشغيل والإعدادات](#١-التشغيل-والإعدادات)
2. [قواعد عامة في REST](#٢-قواعد-عامة-في-rest)
3. [المصادقة — `/api/auth`](#٣-المصادقة--apiauth)
4. [المنافذ — `/api/ports`](#٤-المنافذ--apiports)
5. [المشغّلون — `/api/operators`](#٥-المشغّلون--apioperators)
6. [السجل — `/api/history`](#٦-السجل--apihistory) (يُكتب من رسائل الجهاز، لا من الواجهة)
7. [التقارير — `/api/reports`](#٧-التقارير--apireports)
8. [Socket.IO](#٨-socketio)
9. [MQTT — الاتصال بالأجهزة](#٩-mqtt--الاتصال-بالأجهزة)
10. [المزامنة الخارجية (SCADA / Receipt API) والباركود](#١٠-المزامنة-الخارجية-scada--receipt-api-والباركود)
11. [الفروق عن backend.md](#١١-الفروق-عن-backendmd)

---

## ١. التشغيل والإعدادات

```bash
npm install
npm run migrate   # نقل بيانات PostgreSQL القديمة (مرة واحدة، اختياري)
npm run dev       # أو: npm start
```

| | |
| --- | --- |
| REST API | `http://localhost:3000` — المنفذ من `PORT` |
| Socket.IO | `http://localhost:5000` — المنفذ من `SOCKET_PORT` |
| MQTT broker | `mqtt://localhost:1883` — من `MQTT_URL` |
| قاعدة البيانات | SQLite: `data/filling_system.db` — من `SQLITE_PATH` |

الـ REST متاح على منفذَي 3000 و5000 معًا (نفس تطبيق Express يستمع مرتين)،
والـ Socket.IO على 5000 فقط.

متغيرات [.env](.env):

```ini
PORT=3000
SOCKET_PORT=5000
SQLITE_PATH=./data/filling_system.db
MQTT_URL=mqtt://localhost:1883
# DB_* لا تُستخدم إلا في سكربت النقل من PostgreSQL
```

> **تنبيه:** `SQLITE_PATH` نسبي لمجلد التشغيل، فشغّل الخدمة من جذر المشروع.

---

## ٢. قواعد عامة في REST

- كل المسارات تحت البادئة **`/api`**.
- الطلب والرد `application/json` (يُقبل أيضًا `x-www-form-urlencoded`).
- **CORS مفتوح للجميع** (`cors()` بإعداداته الافتراضية): كل الأصول،
  وترويسات الطلب تُرد كما هي فترويسة `Authorization` مسموحة.
- **المصادقة اختياريّة افتراضيًا**: التوكن يُتحقَّق منه إن أُرسل، ولا يُشترط
  إرساله إلا إذا ضبطت `AUTH_REQUIRED=true` — راجع [القسم ٣](#٣-المصادقة--apiauth).
- الحقول المحجوزة عن الرد: `operator.pass` لا يُعاد في أي استجابة.
- الأوقات تُرجَع نصًا بصيغة `YYYY-MM-DD HH:MM:SS` بالتوقيت المحلي.
- الأرقام تُرجَع كأرقام JSON (لا كنصوص).

### أخطاء موحّدة

| الحالة | الرد |
| --- | --- |
| مسار غير معروف | `404` · `{"error":"Route not found"}` |
| عنصر غير موجود | `404` · `{"error":"port not found"}` أو `{"error":"Operator not found"}` |
| حقول ناقصة | `400` · `{"error":"…"}` |
| قيمة فريدة مكرَّرة (`operator.code`/`operator.username`) | `409` · `{"error":"code \"0770\" is already in use"}` — راجع [القسم ٥](#٥-المشغّلون--apioperators) |
| خطأ غير متوقع | `500` · `{"error":"Internal server error"}` |

---

## ٣. المصادقة — `/api/auth`

كلمات المرور مخزّنة مشفّرة بـ **scrypt** بصيغة `scrypt$<salt>$<hash>`.
أي كلمة مرور قديمة بنص صريح تبقى مقبولة، وتُستبدل بنسخة مشفّرة تلقائيًا
عند أول تسجيل دخول ناجح.

### وضع التفعيل — `AUTH_REQUIRED`

| القيمة | السلوك |
| --- | --- |
| `false` (افتراضي) | التوكن **اختياري**: يُتحقَّق منه إن أُرسل (وتُرفض التوكنات التالفة، أو تلك الخاصة بمشغّل مَحذوف، بـ 401)، لكن غيابه لا يمنع أي مسار. يسمح بعمل الواجهة بجلسة محلية كما في backend.md §1.1 |
| `true` | كل المسارات تحتاج توكنًا صالحًا؛ وتعديل المنافذ والمشغّلين يحتاج `role = admin` |

> **القيمة الحالية في [.env](.env): `true`.**

عند `AUTH_REQUIRED=true`:

| المسار | الصلاحية |
| --- | --- |
| `GET` للمنافذ/المشغّلين/السجل/التقارير | أي مستخدم مسجَّل |
| `POST` للسجل | أي مستخدم مسجَّل |
| `POST`/`PUT`/`DELETE` للمنافذ والمشغّلين | `admin` فقط |
| `/api/auth/*` | مفتوح دائمًا |

الأخطاء: `401` · `{"error":"Authentication required"}` (بلا توكن، و`AUTH_REQUIRED=true`)
— `401` · `{"error":"Invalid or expired token"}` (توقيع تالف/منتهي) — `401` ·
`{"error":"Operator no longer exists"}` (صاحب التوكن حُذف من `operator`) —
`401` · `{"error":"Session has been logged out"}` (نودّى `POST /api/auth/logout`
— التفاصيل أدناه) — `403` · `{"error":"Admin role required"}`. الثلاثة
الأخيرة تُفحص من القاعدة **في كل طلب**، لا من صلاحية التوقيع فقط.

### `POST /api/auth/login`

```json
{ "username": "ali", "password": "134" }
```

`username` يقبل **`operator.username` أو `operator.code`**، فيمكن للمشغّل
الدخول بكوده. (تُقبل أيضًا المفاتيح `user`/`code` و`pass` كأسماء بديلة.)

الرد `200`:

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "user": { "id": 4, "name": "ali", "username": "ali", "role": "admin" }
}
```

- بيانات خاطئة أو مستخدم غير موجود ⇒ `401` · `{"error":"Invalid credentials"}`
- حقل ناقص ⇒ `400` · `{"error":"username and password are required"}`

التوكن JWT موقّع بـ HS256، صلاحيته من `JWT_EXPIRES_IN` (افتراضي `12h`)،
وحمولته `{ sub, name, username, role, jti, iat, exp }`. السر من `JWT_SECRET`،
وإن لم يُضبط يُولَّد مرة واحدة ويُحفظ في `data/.jwt_secret` حتى لا تُلغى
التوكنات عند كل إعادة تشغيل.

ترسله الواجهة بعد ذلك في كل طلب:

```
Authorization: Bearer <token>
```

### `POST /api/auth/logout` — إبطال فعلي لهذه الجلسة بعينها

```
POST /api/auth/logout
Authorization: Bearer <token>
```

الرد `200` · `{ "message": "Logged out" }`، أو `401` بنفس أخطاء أي مسار
محمي أعلاه إن كان التوكن غير صالح أصلًا.

**كيف يعمل:** كل توكن يحمل `jti` فريدًا (UUID) وُلِّد وقت `login`، وسُجِّل
كصف في جدول `sessions` (`jti`, `operatorId`, `expiresAt`). `logout` يحذف
**صف هذا التوكن بعينه**. `resolveOperator` (middleware/auth.js، ومستخدَمة
من `transport/socket.js` لأمر `start_filling`) تتحقق مع كل طلب أن جلسة
التوكن ما زالت موجودة في `sessions` — فبمجرد حذفها يُرفض التوكن فورًا بـ
`401` · `{"error":"Session has been logged out"}`، ولو حاول استخدامه في
اتصال Socket.IO **جديد** بعد ذلك.

**بعكس تصميم أول (`operator.tokenVersion`، مُزال الآن): تسجيل الخروج هنا
لا يمس أي جلسة أخرى لنفس المشغّل** — دخول من متصفحين أو جهازين لنفس
الحساب يعطي `jti` مختلفًا لكل منهما، و`logout` من أحدهما لا يبطل الآخر.
مؤكَّد عمليًا: تسجيلا دخول متتاليان لنفس المشغّل، ثم `logout` بتوكن الأول
فقط — التوكن الأول رُفض فورًا، والثاني ظل يعمل.

جلسات منتهية الصلاحية طبيعيًا (لا `logout` صريح) لا تُحذف فور انتهائها؛
`Session.isActive` تتجاهلها فورًا (شرط `expiresAt` في الاستعلام)، وتُحذف
فعليًا من الجدول عند الإقلاع ثم كل ساعة (`app.js`) حتى لا يكبر بلا داعٍ.

### `GET /api/auth/me`

للتحقق من صلاحية التوكن وجلب بيانات المستخدم المحدَّثة من القاعدة.

الرد `200` · `{ "user": { …كائن المشغّل كاملًا بدون pass… } }`
أو `401` بأحد الأخطاء الأربعة أعلاه.

---

## ٤. المنافذ — `/api/ports`

إعدادات كل منفذ تعبئة. الحقل `name` هو **المفتاح الوحيد** الذي يربط
الصف بأحداث Socket.IO وبتوبيكات MQTT للجهاز، وهو فريد (`UNIQUE`).

### كائن المنفذ

```json
{
  "id": 1,
  "name": "port1",
  "mode": "modbus",
  "baudrate": 9600,
  "serialFrame": "SERIAL_8N1",
  "endian": "little",
  "slaveId": 4,
  "registerAddress": 1,
  "flowRateAddress": 1,
  "firstCloseTime": 2,
  "secondCloseTime": 1,
  "firstCloseLag": 1,
  "SecondCloseLag": 1,
  "pidTime": 1,
  "addedTime": 1,
  "registerType": "input",
  "valveType": "type1",
  "createdAt": "2026-08-31 21:50:32"
}
```

| الحقل | النوع | ملاحظات |
| --- | --- | --- |
| `name` | نص، فريد | مفتاح الـ socket والـ MQTT |
| `mode` | نص | `modbus` \| `pulse` \| `milli ampere` — افتراضي `modbus`. قيمة أخرى تُرفض بقيد CHECK |
| `baudrate` | رقم | افتراضي 9600 |
| `serialFrame` | نص | `SERIAL_8N1` … `SERIAL_8E2` — افتراضي `SERIAL_8N1` |
| `endian` | نص | ترتيب بايتات قراءة العداد |
| `slaveId` | رقم | عنوان الجهاز على Modbus |
| `registerAddress` | رقم | ريجستر العداد التراكمي |
| `flowRateAddress` | رقم | ريجستر معدل التدفق |
| `firstCloseTime` / `secondCloseTime` | رقم (ms) | مدة مرحلتي الغلق الأولى والثانية |
| `firstCloseLag` / `SecondCloseLag` | رقم (لتر) | الكمية المتبقية التي تبدأ عندها كل مرحلة |
| `pidTime` | رقم (ms) | مدة الغلق الأخير (`thirdCloseTime` في الفيرموير) |
| `addedTime` | رقم (ms) | وقت إضافي يُزاد على الغلق الأخير |
| `registerType` | نص | نوع الريجستر (holding / input) |
| `valveType` | نص | نوع الصمام — راجع [القسم ١٠](#١٠-الفروق-عن-backendmd) |

> `SecondCloseLag` بحرف S كبير — غير متسق مع أخواته عمدًا حفاظًا على التوافق
> مع الواجهة.

### `GET /api/ports`

بدون معاملات. الرد `200` بمصفوفة كائنات مرتبة بـ `id` تصاعديًا.

### `GET /api/ports/:id`

الرد `200` بكائن واحد، أو `404` · `{"error":"port not found"}`.

### `POST /api/ports`

الحقل الإلزامي الوحيد `name`؛ وأي حقل غائب يأخذ قيمته الافتراضية.

```json
{
  "name": "port4",
  "baudrate": 19200,
  "endian": "big",
  "registerType": "holding",
  "valveType": "valve",
  "slaveId": 3,
  "registerAddress": 40001,
  "flowRateAddress": 40003,
  "firstCloseTime": 1000,
  "secondCloseTime": 1500,
  "firstCloseLag": 400,
  "SecondCloseLag": 250,
  "pidTime": 1000,
  "addedTime": 300
}
```

الرد `201`:

```json
{ "message": "port created successfully", "port": { "id": 5, "name": "port4", "…": "…" } }
```

- `name` مكرر ⇒ `500` (قيد `UNIQUE`).
- `name` غائب ⇒ `400` · `{"error":"Name are required"}`.

### `PUT /api/ports/:id`

نفس كائن `POST` بدون `id`. **التحديث جزئي**: أي حقل غائب من الطلب يبقى
كما هو في القاعدة، فيمكن إرسال حقل واحد فقط:

```json
{ "addedTime": 333 }
```

الرد `200` · `{ "message": "port updated successfully", "port": { … } }`
أو `404` إن لم يوجد المنفذ.

### `DELETE /api/ports/:id`

الرد `200` · `{ "message": "port deleted successfully", "port": { … } }`
أو `404`.

> تعديل أي منفذ لا يُدفع للجهاز تلقائيًا؛ الجهاز يقرأ إعداداته عند إقلاعه
> فقط (راجع [مصافحة الإقلاع](#مصافحة-الإقلاع-conf)). لدفع الإعدادات فورًا
> أعِد تشغيل الجهاز بـ `<port>/reset`.

---

## ٥. المشغّلون — `/api/operators`

### كائن المشغّل

```json
{
  "id": 4,
  "name": "ali",
  "username": "ali",
  "role": "admin",
  "code": "134",
  "phone": "999",
  "createdAt": "2026-01-19 19:12:55"
}
```

| الحقل | النوع | ملاحظات |
| --- | --- | --- |
| `name` | نص، إلزامي | الاسم المعروض |
| `username` | نص، فريد، اختياري | لتسجيل الدخول لاحقًا |
| `role` | نص | `admin` \| `operator` — افتراضي `operator` |
| `code` | **نص**، فريد، إلزامي | كود الدخول للمشغّل. نص عمدًا: الأصفار البادئة مهمة (`"0770"`) |
| `phone` | نص | ١١ رقمًا |
| `pass` | — | **لا يُعاد في أي استجابة** |

### `GET /api/operators`

الرد `200` بمصفوفة، بدون `pass`.

### `GET /api/operators/:id`

الرد `200` بكائن واحد، أو `404` · `{"error":"Operator not found"}`.

### `POST /api/operators`

كل الحقول الأربعة إلزامية:

```json
{ "name": "زياد", "code": "0770", "pass": "secret", "phone": "01099887766" }
```

اختياريًا `username` و`role`. الرد `201`:

```json
{
  "message": "Operator created successfully",
  "Operator": { "id": 19, "name": "زياد", "username": null, "role": "operator",
                "code": "0770", "phone": "01099887766", "createdAt": "2026-08-31 21:50:58" }
}
```

- حقل ناقص ⇒ `400` · `{"error":"Name, code, pass, and phone are required"}`
- `code` أو `username` مكرر ⇒ `409` · `{"error":"code \"0770\" is already in use"}`
  (اسم الحقل نفسه بيُستخرج من قيد `UNIQUE` في القاعدة)

> مفتاح الكائن في الرد `Operator` بحرف O كبير (موروث من الكود الأصلي).

### `PUT /api/operators/:id`

**تحديث جزئي**: أي حقل غائب يبقى كما هو. وتحديدًا:

```json
{ "name": "زياد محمد", "code": "0770", "phone": "01099887766" }
```

إرسال الطلب **بدون `pass`** يعني «أبقِ كلمة المرور الحالية» — الرد `200`
وكلمة المرور لا تتغير.

- المشغّل غير موجود ⇒ `404`
- `code` أو `username` مكرر مع مشغّل آخر ⇒ `409` (نفس شكل رد الإنشاء أعلاه)

### `DELETE /api/operators/:id`

الرد `200` · `{ "message": "Operator deleted successfully", "Operator": { … } }`
أو `404`. سجلات `history` المرتبطة تبقى، ويصبح `operatorId` فيها `NULL`.

---

## ٦. السجل — `/api/history`

### كائن السجل

```json
{
  "id": 13,
  "portNum": "port2",
  "operatorId": 6,
  "truckNum": "345",
  "receiptNum": "678",
  "requiredQuantity": 10,
  "actualQuantity": 9.7,
  "startMeter": null,
  "endMeter": null,
  "entryTime": "2026-01-21 14:14:26",
  "exitTime": "2026-01-21 14:15:02"
}
```

| الحقل | ملاحظات |
| --- | --- |
| `portNum` | اسم المنفذ (`ports_setting.name`) |
| `operatorId` | **رقم** — مفتاح خارجي لـ `operator.id`، أو `NULL` |
| `requiredQuantity` / `actualQuantity` | أرقام |
| `startMeter` / `endMeter` | قراءة العداد التراكمي عند البدء والإيقاف — أساس تقارير §1.5 |
| `exitTime` | `NULL` تعني أن التعبئة **لم تُغلق بعد** |

### من يكتب السجل؟ **الجهاز، لا الواجهة**

> ⚠️ هذا يخالف backend.md الذي لا يذكر كتابة تلقائية إطلاقًا (كان مفترَضًا
> أن الواجهة تفتح وتغلق السجل بنفسها بنداءي `POST`). السلوك الحالي أدق:
> لو أُغلق المتصفح أو انقطعت الشبكة أثناء التعبئة، الجهاز يكمل عمله فعليًا
> ويجب أن يُسجَّل — والواجهة لا تملك معلومة كهذه أصلًا.

المنطق في `src/services/fillingSessions.js`، ومُوصَّل من `src/transport/mqtt.js`:

| رسالة الجهاز | الأثر على `history` |
| --- | --- |
| `<port>/state = filling` (غير retained) | **يفتح** سجلًا جديدًا: `startMeter` = آخر قراءة `flowmeter` معروفة (أو ما أرسلته الواجهة إن وصل قبله)، وبيانات المشغّل/الشاحنة/الإيصال إن كانت وصلت (انظر أدناه) |
| `<port>/flowmeter` | تُحفظ كآخر قراءة عداد للمنفذ — أساس `startMeter`/`endMeter` وإشارة على أن السائل ما زال يتحرك |
| `<port>/state = stop` أو `emergency_stop` (غير retained) | **يغلق** السجل المفتوح: `actualQuantity` = فرق آخر قراءتي عداد، `endMeter` = آخر قراءة. الإغلاق ينتظر «سكون» العداد بضع ثوانٍ (`FILL_SETTLE_MS`, افتراضي 5000، سقف `FILL_MAX_SETTLE_MS` = 60000) لأن الجهاز يعلن `stop` قبل أن يتوقف السائل فعليًا |
| `<port>/logdata` | تعبئة تمّت وقت انقطاع الشبكة، أُرسلت لاحقًا من طابور الجهاز. تُخزَّن سجلًا **كاملًا** (فتح+إغلاق دفعة واحدة، بلا مشغّل/شاحنة/إيصال — الجهاز لا يعرفها). صيغة CSV: `required,delta,end[,prev]`؛ `startMeter` = `prev` إن وُجد وإلا `end - delta`. سجل مكرر (نفس النص خلال `FILL_LOG_DEDUPE_MS`، افتراضي دقيقة) يُهمَل |
| `<port>/availability = offline` | لا يُغلق السجل — الصمّام قد يكون ما زال يعمل، والإغلاق الصحيح ينتظر عودة الجهاز وإعلانه |
| رسائل **retained** (تُعاد عند إعادة اتصال الجهاز، أو عند إقلاع سيرفر MQTT) | تُتجاهَل من جهة السجل (لا فتح ولا إغلاق) حتى لا يكرّر كل إقلاع للسيرفر سجلات تعبئات قديمة. تُبثّ لـ Socket.IO كالمعتاد |

سجل مفتوح موجود بالفعل لحظة `state = filling` جديدة (تعبئة سابقة لم
تُغلق، بسبب انقطاع أو إعادة تشغيل) يُغلق تلقائيًا كـ«تعبئة مهجورة»
(`actualQuantity`/`endMeter` بأفضل قراءة متاحة) قبل فتح السجل الجديد.

عند إعادة تشغيل السيرفر، `sessions.resume()` يحمّل كل سجل `exitTime IS NULL`
من القاعدة ليعرف أي منفذ له سجل مفتوح، فيغلقه صحيحًا عند وصول `stop` التالية
بدل أن يفتح سجلًا مكررًا.

### من أين تأتي بيانات المشغّل/الشاحنة/الإيصال؟

الجهاز لا يعرفها. تصل من الواجهة عبر `start_filling` (Socket.IO، انظر
[٨.١](#٨-socketio)) أو `POST /api/history`، وتُخزَّن مؤقتًا في الذاكرة حتى
يفتح الجهاز السجل فتُلحَق به تلقائيًا. لو وصلت **بعد** فتح السجل (تأخّر في
الشبكة مثلًا) تُلحَق بالسجل المفتوح فورًا ويُبَث `history_updated`. بيانات
معلَّقة أكثر من `FILL_META_TTL_MS` (افتراضي 10 دقائق) بلا سجل يفتحه الجهاز
تُهمَل — على الأرجح كانت لأمر `start` رفضه الجهاز.

### `GET /api/history`

| المعامل | إلزامي | ملاحظات |
| --- | --- | --- |
| `port` | لا | اسم منفذ، أو **`all_ports`** لكل المنافذ. الغياب = `all_ports` |
| `from` | لا | بداية النطاق. الغياب = بلا حد أدنى |
| `to` | لا | نهاية النطاق. الغياب = بلا حد أقصى |

`from` و`to` يُقبلان بأي من هذه الصيغ ويُحوّلان داخليًا إلى التوقيت المحلي:
ISO كامل (`2026-08-31T09:12:04.000Z`)، أو `YYYY-MM-DD HH:mm:ss`، أو
`YYYY-MM-DD`، أو epoch بالملّي ثانية.

```
GET /api/history?port=all_ports&from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z
GET /api/history?port=port2&from=2026-01-01&to=2026-02-01
```

الرد `200` بمصفوفة مرتبة بـ `id` **تنازليًا** (الأحدث أولًا). لا يوجد
ترقيم صفحات — يُعاد النطاق كاملًا.

### `POST /api/history` — نقل بيانات الواجهة فقط (لا يكتب السجل)

لهذا المسار **شكلان** بنفس حمولتَي backend.md §2.1، لكن أثرهما تغيّر:
لا يفتحان ولا يغلقان سجلًا بأنفسهما، بل يُلحقان بياناتهما بالسجل الذي
يقوده الجهاز (انظر أعلاه).

#### أ) بيانات بداية تعبئة

```json
{
  "portNum": "port1",
  "operatorId": "123",
  "truckNum": "5567",
  "receiptNum": "88213",
  "requiredQuantity": "40",
  "flowmeter_value": 10250.5
}
```

- الحقول الإلزامية (لتمييز الشكل): `portNum`, `operatorId`, `truckNum`,
  `receiptNum`, `requiredQuantity`.
- `operatorId` يُقبل كـ **id أو `code` أو `username` أو `name`** ويُحوَّل إلى
  `operator.id` عند إلحاقه بالسجل. القيمة غير المعروفة تُخزَّن `NULL` مع
  تحذير في السجل (لا يفشل الطلب).

الرد `201`:

```json
{
  "message": "Log inserted successfully",
  "mode": "esp-driven",
  "note": "history is recorded from ESP messages; this payload only supplies operator/truck/receipt data",
  "meta": { "operatorId": "123", "truckNum": "5567", "receiptNum": "88213", "requiredQuantity": 40, "startMeter": 10250.5 },
  "Operator": { "id": 14, "portNum": "port1", "exitTime": null, "...": "السجل المفتوح حاليًا للمنفذ، أو null إن لم يفتحه الجهاز بعد" }
}
```

#### ب) إشعار إغلاق (اختياري — الإغلاق الفعلي من الجهاز)

```json
{ "portNum": "port1", "actualQuantity": 39.8, "endMeter": 10290.3 }
```

نفس الشكل (`portNum` + `actualQuantity`) مقبول كإقرار استلام فقط؛ **لا
يغلق شيئًا** — الإغلاق الحقيقي يحدث تلقائيًا عند `<port>/state = stop`.

- الحمولة لا تطابق أي شكل ⇒ `400` مع شرح الشكلين المتوقعين.

### `GET /api/history/session/:port` — تشخيص جلسة التعبئة الحيّة

مسار جديد للاطّلاع على حالة `fillingSessions.js` في الذاكرة (وليس فقط ما
في القاعدة) — مفيد لتتبّع لماذا لم يُفتح/يُغلق سجل كما هو متوقَّع.

```
GET /api/history/session/port1
```

```json
{
  "port": "port1",
  "session": {
    "port": "port1",
    "openId": 14,
    "startMeter": 10250.5,
    "lastMeter": 10289.9,
    "pendingMeta": null,
    "closing": false
  },
  "openRecord": { "id": 14, "portNum": "port1", "exitTime": null, "...": "..." }
}
```

`closing: true` يعني أن `stop` وصلت والسيرفر ينتظر سكون العداد قبل
الإغلاق الفعلي.

### وضع التوافق القديم

`HISTORY_API_WRITES=true` في `.env` يعيد السلوك القديم بالكامل: `POST`
يفتح/يغلق السجل بنفسه بشكليه الأصليين (كما في الإصدارات السابقة من هذا
الملف)، ومنطق الجهاز في `fillingSessions.js` يبقى يعمل بالتوازي — قد
يؤدي هذا لسجلات مزدوجة، فهو مخصَّص للتراجع المؤقت فقط، وليس للتشغيل العادي.

---

## ٧. التقارير — `/api/reports`

تقرير مجمَّع لكل منفذ في فترة. الحقول **بحروف صغيرة** والقيمة المميزة
**`allPorts`** (بعكس السجل الذي يستخدم `all_ports`) — كما في backend.md §1.5.
يُقبل `all_ports` أيضًا تسهيلًا.

### `GET /api/reports`

| المعامل | إلزامي | ملاحظات |
| --- | --- | --- |
| `port` | لا | اسم منفذ، أو `allPorts` لكل المنافذ. الغياب = `allPorts` |
| `from` / `to` | لا | نفس الصيغ المقبولة في السجل |

```
GET /api/reports?port=allPorts&from=2026-08-01T00:00:00.000Z&to=2026-08-31T23:59:59.000Z
```

الرد `200`:

```json
[
  {
    "portnum": "port1",
    "startmeter": 10250.5,
    "endmeter": 10890.2,
    "metervalue": 639.7,
    "receiptvalue": 640,
    "saving": 0,
    "deficit": 0.3,
    "carcount": 16
  }
]
```

| الحقل | كيف يُحسب |
| --- | --- |
| `startmeter` | أول `history.startMeter` مسجّلة في الفترة (`null` إن لم توجد) |
| `endmeter` | آخر `history.endMeter` مسجّلة في الفترة (`null` إن لم توجد) |
| `metervalue` | `endmeter - startmeter` |
| `receiptvalue` | مجموع `requiredQuantity` (ما حُرِّرت به إيصالات) |
| `deficit` | `receiptvalue - metervalue` إن كان موجبًا، وإلا `0` |
| `saving` | `metervalue - receiptvalue` إن كان موجبًا، وإلا `0` |
| `carcount` | عدد سجلات التعبئة في الفترة |

- الإجماليات تُحسب في المتصفح؛ الخادم يعيد صفًا لكل منفذ فقط.
- مع `allPorts` يُعاد صف لكل منفذ معرَّف في `ports_setting` **حتى لو لا
  تعبئة له في الفترة** (أصفار)، زائد أي منفذ ظهر في السجل ولو لم يعد معرَّفًا.
- **حالة البيانات القديمة:** السجلات المنقولة من PostgreSQL بلا
  `startMeter`/`endMeter`، فإن لم توجد أي قراءة عداد في الفترة يُحسب
  `metervalue` من مجموع `actualQuantity` ويبقى `startmeter`/`endmeter`
  بقيمة `null` — حتى لا تظهر التقارير أصفارًا بلا سبب.
- الأرقام مقرَّبة إلى ٣ منازل عشرية.

---

## ٨. Socket.IO

- العنوان: `http://localhost:5000` (CORS: كل الأصول، `GET` و`POST`).
- كل أحداث الحالة تُبَث لكل العملاء (`io.emit`) والعميل يفلتر بحسب `port` في
  الحمولة. `join_port` ينضم لغرفة باسم المنفذ أيضًا، لكن البث الحالي لا
  يعتمد عليها — فالواجهة تعمل سواء استُخدم `join_port` أو لا.
- **`start_filling` وحده يتطلّب توكنًا** — عبر مصافحة الاتصال، لا ترويسة
  REST:
  ```js
  io("http://localhost:5000", { auth: { token } })
  ```
  الفحص يقرأ صاحب التوكن من القاعدة **مع كل نداء `start_filling`** (لا مرة
  واحدة وقت الاتصال، نفس `resolveOperator` المستخدَمة في REST) — فحذف
  مشغّل، أو تسجيل خروج **هذه الجلسة بعينها** بـ `POST /api/auth/logout`،
  أثناء اتصال socket قديم لسه شغال يمنع أمره التالي فورًا (جلسات أخرى
  لنفس المشغّل غير متأثرة). بلا `auth.token`، أو بتوكن تالف/لمشغّل
  محذوف/لجلسة مسجَّل خروجها، الأمر **يُتجاهل بصمت** (تحذير في سجل الخادم
  فقط) إلا إذا كان `AUTH_REQUIRED=false` ولم يُرسَل توكن أصلًا — عندها
  يُسمح به (بنش تيست بلا مصادقة، backend.md §1.1).
  بقية الأحداث (`stop_filling`, `stop_all_ports`, …) غير محمية عمدًا:
  إيقاف صمّام طارئ يجب أن يظل ممكنًا حتى من عميل فقد صلاحيته.

### ٨.١ ما يستقبله الخادم من العميل

| الحدث | الحمولة | السلوك |
| --- | --- | --- |
| `start_filling` | كائن (أدناه) | ينشر أمري MQTT: الكمية ثم `start` |
| `stop_filling` | `{ "port": "port1" }` | ينشر `force_stop` على `<port>/state` |
| `join_port` | `"port1"` (نص، ويُقبل `{ port }`) | ينضم لغرفة المنفذ **ويعيد إرسال حالته الحالية فورًا** |
| `leave_port` | `"port1"` (نص، ويُقبل `{ port }`) | يخرج من الغرفة |
| `stop_all_ports` | `{}` | ينشر `force_stop` على **كل** منفذ في `ports_setting` |
| `update_field` | `{ port, field, value }` | يُعاد بثه كما هو لبقية العملاء (`socket.broadcast`) |
| `toggle_ai_mode` | `{}` | يشغّل/يوقف عملية بايثون، ويبث `ai_mode_status` |

```jsonc
// start_filling
{
  "port": "port1",
  "required_quantity": "40",   // يُقبل رقمًا أو نصًا
  "receipt_number": "88213",   // يُحفظ ويُلحَق بالسجل الذي يفتحه الجهاز
  "truck_number": "5567",      // كذلك
  "flowmeter_value": 10250.5,  // كذلك (يُستخدم كـ startMeter إن لم تصل قراءة flowmeter بعد)
  "operator_id": "1234"        // كذلك — id أو code أو username أو الاسم
}
```

`start_filling` يُرفض بصمت (مع تحذير في سجل الخادم) إذا:

- `port` غائب، أو
- `required_quantity` ليست رقمًا، أو ليست في المدى `0 < q < 100` — وهو
  نفس المدى الذي يفرضه الفيرموير، فأي قيمة خارجه سيتجاهلها الجهاز أصلًا، أو
- التوكن مفقود/غير صالح — راجع شرط `auth.token` أعلاه.

عند النجاح: بيانات `receipt_number`/`truck_number`/`flowmeter_value`/
`operator_id` تُحفظ في الذاكرة (`fillingSessions.attachMeta`)، ثم يُنشر
أمران بالترتيب: `<port>/quantity` ثم `<port>/state = start` (الترتيب مهم:
الجهاز يرفض `start` قبل أن تصله كمية). لا يُكتب شيء في `history` هنا —
الكتابة تحدث لاحقًا عندما يعلن الجهاز فعليًا `<port>/state = filling`
(انظر [القسم ٦](#٦-السجل--apihistory)).

`stop_all_ports` شبكة أمان: الواجهة ترسل `stop_filling` لكل منفذ قبله، وهو
يضمن وصول `force_stop` لكل منفذ معرَّف حتى لو لم تكن بطاقته معروضة.

`toggle_ai_mode` يشغّل `src/utils/ai/app.py` (مجلد التشغيل `src/` لأن
السكربت يحمّل موديله من مسار نسبي). الحالة **مشتركة بين كل العملاء**، وأي
فشل في تشغيل بايثون يُبلَّغ عنه بـ `ai_mode_status: { running: false }`.

### ٨.٢ ما يبثه الخادم للعميل

كل حدث خاص بمنفذ يحمل `{ port, data }`، و`data` **نص دائمًا** كما وصل من
الجهاز. الأحداث الرقمية تحمل معه `value` رقميًا للتسهيل.

| الحدث | الحمولة | المصدر |
| --- | --- | --- |
| `flowmeter` | `{ "port":"port1", "data":"123.456", "value":123.456 }` | قراءة العداد التراكمية |
| `flow_rate` | `{ "port":"port1", "data":"42.500", "value":42.5 }` | معدل التدفق |
| `state` | `{ "port":"port1", "data":"filling" }` | `filling` \| `stoping` \| `stop` \| `emergency_stop` |
| `valve_state` | `{ "port":"port1", "data":"open" }` | `close` \| `opening` \| `open` \| `closing` — راجع الملاحظة أدناه |
| `availability` | `{ "port":"port1", "data":"online" }` | `online` \| `offline` |
| `logdata` | `{ "port":"port1", "data":"40,39.8,10290.3,10250.5" }` | سجلات مخزّنة على الجهاز |
| `debug` | `{ "port":"port1", "data":"[FLOW] rate: 42.500" }` | رسائل تشخيص الجهاز |
| `plate_capture` | `{ "data":"start" }` — **بلا `port`** | طلب تصوير لوحة السيارة (`cam1/esp`) |
| `ai_mode_status` | `{ "running": true }` — **بلا `port`** | حالة التشغيل الذكي |
| `update_field` | كما أرسله العميل | مزامنة حقول الإدخال بين الشاشات |
| `history_open` | `{ "port":"port1", "record": {...} }` | فُتح سجل جديد — الجهاز أعلن `state = filling` |
| `history_closed` | `{ "port":"port1", "record": {...}, "reason": "stop" }` | أُغلق السجل — `reason` هي `stop` \| `emergency_stop` \| `abandoned` |
| `history_offline` | `{ "port":"port1", "record": {...} }` | سجل كامل استُلم من `<port>/logdata` (تعبئة تمّت أثناء انقطاع الجهاز) |
| `history_updated` | `{ "port":"port1", "record": {...} }` | بيانات واجهة (مشغّل/شاحنة/إيصال) وصلت متأخرة وأُلحقت بسجل مفتوح بالفعل |

**`flowmeter` قراءة تراكمية للعدّاد وليست فرقًا** — الكمية الفعلية =
القراءة الحالية − القراءة لحظة البدء.

**`valve_state` مطبَّع لمفردات الواجهة**: الفيرموير يرسل
`closing_first`/`closing_second`/`closing_final`، والخادم يحوّلها كلها إلى
`data: "closing"` ويضع الأصل في حقل إضافي `raw`:

```json
{ "port": "port1", "data": "closing", "raw": "closing_second" }
```

**الحالة تُرسل فورًا عند الاتصال.** الخادم يحتفظ بآخر قيمة لكل منفذ
(`flowmeter`, `flow_rate`, `state`, `valve_state`, `availability`) ويعيد
بثها للعميل الجديد لحظة اتصاله، ومرة أخرى عند `join_port` للمنفذ المطلوب،
مع `ai_mode_status`. فلا تبقى البطاقة فاضية في انتظار أول تغيير.
(`logdata` و`debug` ليست حالة فلا تُعاد.)

**بيانات التعبئة (شاحنة/إيصال/كمية مطلوبة) لها مصدر مختلف:** هي جزء من
سجل `history` المفتوح، لا من تليمتري الجهاز، فمخزن الـ snapshot أعلاه لا
يحملها. لذلك عند الاتصال — ومرة أخرى عند `join_port` لمنفذ بعينه — يقرأ
الخادم كل سجل `history` مفتوح حاليًا ويبثه `history_open`
(`{ port, record }`، نفس شكل الحدث في [القسم ٦](#٦-السجل--apihistory)).
هذا ما يملأ الكارت ببيانات التعبئة الجارية حتى لو اتصل العميل (أو حدَّث
الصفحة) بعد أن بدأت التعبئة فعلًا.

---

## ٩. MQTT — الاتصال بالأجهزة

- البروكر: `mqtt://localhost:1883`، معرّف عميل الخادم `filling_server_<pid>`.
- `<port>` في التوبيكات = `ports_setting.name` = `truck_id` على الجهاز
  (من `/port_id.txt` في ذاكرة الجهاز). لا بد أن يتطابقا حرفيًا.
- الخادم يشترك في توبيكات الأجهزة فقط: `+/flowmeter`, `+/flow_rate`,
  `+/state`, `+/valve_state`, `+/availability`, `+/logdata`, `+/update`,
  `+/debug`, `cam1/esp`.
- `state`/`flowmeter`/`logdata`/`availability` تُغذّي أيضًا منطق كتابة
  `history` تلقائيًا (`src/services/fillingSessions.js`) — تفصيل كامل في
  [القسم ٦](#٦-السجل--apihistory). رسالة **retained** (تُعاد عند إعادة
  اتصال الجهاز، أو إعادة اشتراك السيرفر بعد إعادة تشغيله) تُبثّ لـ
  Socket.IO كالمعتاد لكنها **لا** تفتح ولا تغلق سجلًا — يُميَّزها السيرفر
  عبر `packet.retain` في مستمع `mqttClient.on("message", ...)`.

### ٩.١ من الجهاز إلى الخادم

| التوبيك | الحمولة | retained | ملاحظات |
| --- | --- | --- | --- |
| `<port>/flowmeter` | `"123.456"` | ✔ | عند التغيّر وبفاصل ≥ 500ms |
| `<port>/flow_rate` | `"42.500"` | ✔ | عند التغيّر وبفاصل ≥ 500ms |
| `<port>/state` | `filling` \| `stoping` \| `stop` \| `emergency_stop` | ✔ | حالة المنفذ |
| `<port>/valve_state` | `close` \| `opening` \| `open` \| `closing_first` \| `closing_second` \| `closing_final` | ✔ | تُنشر عند التغيّر فقط |
| `<port>/availability` | `online` \| `offline` | ✔ | `offline` هي Last Will من البروكر |
| `<port>/logdata` | CSV | ✘ | ردًا على `send_logs` فقط |
| `<port>/update` | `"config"` | ✔ | طلب الإعدادات، يتكرر كل ٥ ثوانٍ حتى يوصل الرد |
| `<port>/debug` | `"[FLOW] rate: 42.500"` | ✘ | فقط عند تفعيل `DEBUG_MODE` في الفيرموير |
| `cam1/esp` | `"start"` | ✘ | طلب تصوير لوحة |

صيغة `logdata` (تعبئة تمت أثناء انقطاع الشبكة):
`requiredQuantity,actualQuantity,flowmeterValue,flowmeterAtStart` — وفي وضع
الـ pulse ثلاثة حقول بدون الأخير.

### ٩.٢ من الخادم إلى الجهاز

كل الأوامر **QoS 1 وبدون retain**؛ أمر محفوظ (retained) كان سيُعاد تسليمه
عند كل إعادة اتصال للجهاز فيفتح الصمام من تلقاء نفسه. الاستثناء الوحيد هو
الحمولة الفارغة على `<port>/update` وهي retained لأن الغرض منها **مسح**
الطلب المحفوظ.

| التوبيك | الحمولة | مَن ينشره اليوم |
| --- | --- | --- |
| `<port>/quantity` | `"12.5"` | `start_filling` |
| `<port>/state` | `start` \| `force_stop` | `start_filling` / `stop_filling` |
| `<port>/conf` | ١٥ حقلًا مفصولة بفواصل | ردًا على `<port>/update` |
| `<port>/update` | `""` (retained) | لمسح الطلب المحفوظ بعد الرد عليه |
| `<port>/reset` | أي قيمة | — الجهاز يشترك فيه، ولا ناشر في الخادم بعد |
| `<port>/refresh` | أي قيمة | — يطلب من الجهاز إعادة بث حالته كاملة |
| `<port>/send_logs` | أي قيمة | — يطلب إرسال السجلات المخزّنة |
| `<port>/recapture` | أي قيمة | — يسمح بتصوير لوحة جديدة |

> `<port>/state` يُستخدم في الاتجاهين: الأوامر منه وإليه. الخادم يتجاهل
> صدى أوامره (`start` / `force_stop`) فلا يعيد بثها للواجهة، والجهاز
> يتجاهل أي حمولة ليست أمرًا.

### مصافحة الإقلاع (conf)

```
الجهاز  → <port>/update = "config"        (retained، ويتكرر كل ٥ ثوان)
الخادم  → <port>/conf   = "modbus,9600,…" (QoS 1)
الخادم  → <port>/update = ""              (retained، لمسح الطلب)
```

الخادم يبني `conf` من صف `ports_setting` المطابق للاسم. **إذا كان الصف
غير موجود، أو `mode` ليس `modbus`، أو إحدى القيم غير مفهومة للفيرموير،
فلا يُرسل شيء** ويُسجَّل السبب في الكونسول — الجهاز يظل يسأل، وهذا أفضل
من إرسال أزمنة غلق خاطئة لصمام حقيقي.

### صيغة `conf` — ترتيب الحقول

```
modbus,9600,SERIAL_8N1,AABBCCDD,1,0,1000,1500,400,250,1000,300,2,HOLDING,valve
```

| # | المصدر في `ports_setting` | المعنى في الفيرموير |
| --- | --- | --- |
| 0 | `mode` | نوع القراءة (`modbus` فقط مدعوم حاليًا) |
| 1 | `baudrate` | سرعة المنفذ التسلسلي |
| 2 | `serialFrame` | إطار البيانات |
| 3 | `endian` | `AABBCCDD` أو غيرها |
| 4 | `slaveId` | عنوان الجهاز |
| 5 | `registerAddress` | ريجستر العداد |
| 6 | `firstCloseTime` | مدة الغلق الأول |
| 7 | `secondCloseTime` | مدة الغلق الثاني |
| 8 | `firstCloseLag` | كمية بدء الغلق الأول |
| 9 | `SecondCloseLag` | كمية بدء الغلق الثاني |
| 10 | `pidTime` | مدة الغلق الأخير |
| 11 | `addedTime` | وقت إضافي |
| 12 | `flowRateAddress` | ريجستر معدل التدفق |
| 13 | `registerType` | `HOLDING` أو `INPUT` |
| 14 | `valveType` | `valve` \| `bump` \| `valve and bump` |

الخادم يوحّد المفردات قبل الإرسال، لأن الفيرموير يقارن نصوصًا بحرفها:

| العمود | القيم المقبولة في القاعدة | ما يُرسل للجهاز |
| --- | --- | --- |
| `endian` | `aabbccdd`, `abcd`, `big` | `AABBCCDD` |
| | `ddccbbaa` | `DDCCBBAA` |
| | `cdab`, `little` | `CDAB` |
| `registerType` | `holding` | `HOLDING` |
| | `input` | `INPUT` |
| `valveType` | `valve` | `valve` |
| | `bump`, `pump` | `bump` |
| | `valve and bump`, `valve and pump` | `valve and bump` |

أي قيمة أخرى ⇒ **لا يُرسل conf** ويُطبع الخطأ مع القيم المقبولة.

> حجم حزمة الفيرموير محدود بـ 256 بايت (PubSubClient)، فاحتفظ بـ `conf`
> قصيرًا.

---

## ١٠. المزامنة الخارجية (SCADA / Receipt API) والباركود

مضافة لمطابقة `sync_and_barcode.md` (توثيق النظام القديم Python) — راجعه
للسياق الكامل. **السيرفرين الحقيقيين (SCADA وReceipt API) غير متصلين حاليًا**؛
كل ما يلي متسامح مع فشل الاتصال بهما تمامًا: أي خطأ يُسجَّل في اللوج فقط ولا
يوقف أو يؤخر تعبئة فعلية عند المشغّل.

### ١٠.١ إعدادات المزامنة — `/api/sync-settings`

صف واحد قابل للتعديل من الـ UI (بدل قيم مكتوبة في الكود). القيم الافتراضية
= عناوين النظام القديم، وهي غير شغالة حاليًا.

| المسار | الطريقة | الحماية | الوصف |
| --- | --- | --- | --- |
| `/api/sync-settings` | `GET` | `requireAuth` | يرجع الصف الحالي |
| `/api/sync-settings` | `PUT` | `requireAdmin` | يعدّل أي حقل من الحقول أدناه (الحقول الغائبة تبقى كما هي) |

```jsonc
{
  "scadaEnabled": 1,
  "scadaHost": "197.134.251.84",
  "scadaPort": 11001,
  "receiptApiEnabled": 1,
  "receiptApiBaseUrl": "http://172.16.0.99:8090/KorapTmp",
  "receiptRefreshMinutes": 60
}
```

تعديل `scadaHost`/`scadaPort` عبر `PUT` يطبَّق فورًا على أول تعبئة تالية —
اتصال SCADA الحالي يُغلق ويُعاد بناؤه على العنوان الجديد بلا حاجة لإعادة
تشغيل الخادم.

### ١٠.٢ خرائط قنوات SCADA — `/api/scada-channels`

كل منفذ محتاج خريطة قنوات (channel id لكل حقل بيتبعت بروتوكول `P` عليه)
قبل ما مزامنة SCADA تشتغل له — لو مفيش خريطة، المزامنة بتتخطّى المنفذ ده
بصمت (تحذير في اللوج فقط).

| المسار | الطريقة | الحماية | الوصف |
| --- | --- | --- | --- |
| `/api/scada-channels` | `GET` | `requireAuth` | كل الخرائط |
| `/api/scada-channels/:portNum` | `GET` | `requireAuth` | خريطة منفذ واحد |
| `/api/scada-channels/:portNum` | `PUT` | `requireAdmin` | إنشاء/تحديث خريطة المنفذ (`400` لو `portNum` مش موجود في `ports_setting`) |
| `/api/scada-channels/:portNum` | `DELETE` | `requireAdmin` | حذف الخريطة |

```jsonc
// PUT /api/scada-channels/port1
{
  "truckCh": "1", "operatorCh": "2", "requiredCh": "3", "receiptCh": "4",
  "inTimeCh": "5", "flowmeterCh": "6", "flowTimeCh": "7",
  "actualCh": "8", "outTimeCh": "9"
}
```

### ١٠.٣ عرض الإيصالات — `/api/receipts`

| المسار | الطريقة | الحماية | الوصف |
| --- | --- | --- | --- |
| `/api/receipts` | `GET` | `requireAuth` | قائمة الإيصالات — فلترة اختيارية `?checked=0\|1&search=&from=&to=` (بتاريخ `fetchedAt`) |
| `/api/receipts/:receiptNum` | `GET` | `requireAuth` | إيصال واحد (`404` لو غير موجود) |

```jsonc
{ "receiptNum": "88213", "waterQuantity": 30, "checked": 0, "syncPending": 0, "fetchedAt": "2026-09-19 16:38:33" }
```

`syncPending = 1` تعني فشل تعليم الاستهلاك على Receipt API وقتها، وإنه
هيتحاول تاني تلقائيًا (`services/receiptSync.js#retryPendingConsume`).

### ١٠.٤ متى تُبعث بيانات SCADA؟

بلا نداء إضافي من الواجهة — `fillingSessions.js` بيبعتها تلقائيًا:

- عند فتح سجل (`state = filling` من الجهاز) → `send_readings_1` (رقم
  العربية، ثم المشغّل/الكمية المطلوبة/الإيصال/وقت الدخول، ثم قراءة العداد).
- عند إغلاق سجل (`stop` / `emergency_stop`) → `send_readings_2` (الكمية
  الفعلية/وقت الخروج/قراءة العداد النهائية).
- عند بدء تشغيل الخادم → مزامنة أي سجل مقفول لسه ما اتزامنش (مقابل
  `state IS NULL` في النظام القديم).

### ١٠.٥ الباركود — حدث Socket.IO `check_receipt`

بديل مباشر لضغطة "بدء" لما المشغّل يمسح باركود إيصال. **نفس شرط التوكن
المطبَّق على `start_filling`** (راجع [القسم ٨](#٨-socketio)) لأنه بيؤدي لنفس
النتيجة (فتح صمام) عند النجاح.

```jsonc
// العميل يبعت
{
  "port": "port1",
  "receipt_number": "88213",   // أو رقم المشغّل نفسه = وضع أزمات
  "truck_number": "5567",
  "operator_id": "1234",
  "required_quantity": 20      // مطلوب في وضع الأزمات فقط (كمية يدوية)
}
```

الخادم يرد بحدث `receipt_check_result` دايمًا، وبينادي `start_filling`
تلقائيًا لو الحالة `valid` أو `crisis_ok`:

| `status` | المعنى | نداء `start_filling` تلقائي؟ |
| --- | --- | --- |
| `valid` | الإيصال موجود ومش مستخدَم | ✅ (وبعدين `POST /Consume` على Receipt API) |
| `crisis_ok` | وضع أزمات، العربية لسه ما اتملتش النهارده | ✅ (بلا إيصال) |
| `already_used` | الإيصال مستهلَك بالفعل | ❌ |
| `not_found` | الإيصال مش موجود محليًا (بعد محاولة تحديث من الـ API) | ❌ |
| `crisis_blocked` | العربية دي اتملت في وضع الأزمات النهارده بالفعل | ❌ |

سجل `history` بتاع التعبئة الناتجة بياخد `fillMode = 'crisis'` في حالة
الأزمات (`normal` غير كده) — وده أساس فحص "مرة واحدة في اليوم للعربية".

---

## ١١. الفروق عن backend.md

### ما بقي مختلفًا

| # | العقد يقول | الواقع |
| --- | --- | --- |
| 1 | `valveType` ∈ `type1 \| type2` | الفيرموير يفهم `valve \| bump \| valve and bump` فقط، وأي قيمة غيرها تعني أن الصمام **لا يتحرك**. صفوف القاعدة الحالية كلها `type1` فلا يُرسل لها conf — **قرار مطلوب**: تغيير قائمة الواجهة، أو تثبيت خريطة `type1 → …` |
| 2 | `state` ∈ `filling \| stop` | يوجد أيضًا `stoping` (أثناء الغلق) و`emergency_stop` — يمكن للواجهة تجاهلهما، فـ `stop` تأتي بعدهما دائمًا |
| 3 | `operatorId` نصًا (`"1234"`) | رقم (مفتاح خارجي لـ `operator.id`)، لكن الإدخال يقبل id أو code أو username أو الاسم ويحوّلها |
| 4 | `POST /api/history` غير موثق في العقد | منفَّذ، لكن **لا يكتب السجل** — ينقل بيانات المشغّل/الشاحنة/الإيصال فقط ليُلحقها السيرفر بسجل يفتحه الجهاز. موثق هنا في [القسم ٦](#٦-السجل--apihistory) |
| 5 | لا شيء عن `mode`/`serialFrame` | عمودان إضافيان في القاعدة وفي الـ API بقيم افتراضية، لازمان لبناء conf |
| 6 | تسجيل السجل | العقد ساكت تمامًا عن هذا (لا يذكر كتابة تلقائية ولا يدويّة) — الواقع أن الخادم **يكتب تلقائيًا** من رسائل الجهاز (`state`/`flowmeter`/`logdata`)، وليس من نداء الواجهة. أدق مما افترضه العقد ضمنيًا، لكنه فرق يستحق الذكر |

### ما تمّت تسويته

| العقد | الحالة |
| --- | --- |
| `POST /api/auth/login` | ✅ منفَّذ + `GET /api/auth/me` + `POST /api/auth/logout` (إبطال فعلي لكل جلسة على حدة عبر جدول `sessions`/`jti`)، مع تشفير scrypt وترقية تلقائية لكلمات المرور القديمة |
| `GET /api/reports` | ✅ منفَّذ بالحقول والقيمة المميزة `allPorts` كما في §1.5 |
| `join_port` / `leave_port` / `stop_all_ports` | ✅ منفَّذة |
| إرسال الحالة فورًا عند الاتصال / `join_port` | ✅ الخادم يحتفظ بآخر حالة لكل منفذ ويعيد بثها |
| `valve_state` بمفردات الواجهة | ✅ `closing_*` تُطبَّع إلى `closing` (والأصل في `raw`) |
| «التحقق من جانب الخادم إلزامي» | ✅ متاح بـ `AUTH_REQUIRED=true` (اختياري افتراضيًا حتى لا تنكسر جلسة الواجهة المحلية) |

الأنواع التي كانت تخالف العقد بسبب PostgreSQL (`baudrate` و`code`
و`requiredQuantity` كنصوص) صحّت تلقائيًا بعد الانتقال إلى SQLite.

---

## ملحق: أمثلة `curl` جاهزة

```bash
API=http://localhost:3000/api

# المنافذ
curl -s $API/ports | jq
curl -s $API/ports/1 | jq
curl -s -X POST $API/ports -H 'Content-Type: application/json' \
     -d '{"name":"port4","baudrate":9600,"valveType":"valve","registerType":"holding","endian":"big"}'
curl -s -X PUT $API/ports/1 -H 'Content-Type: application/json' -d '{"addedTime":300}'
curl -s -X DELETE $API/ports/5

# المشغّلون
curl -s $API/operators | jq
curl -s -X POST $API/operators -H 'Content-Type: application/json' \
     -d '{"name":"زياد","code":"0770","pass":"secret","phone":"01099887766"}'
curl -s -X PUT $API/operators/19 -H 'Content-Type: application/json' \
     -d '{"name":"زياد محمد"}'          # بدون pass ⇒ كلمة المرور تبقى

# المصادقة
TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
        -d '{"username":"ali","password":"134"}' | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" $API/auth/me | jq

curl -s -X POST $API/auth/logout -H "Authorization: Bearer $TOKEN" | jq
# نفس $TOKEN بعد كده يترفض بـ 401 "Session has been logged out" على أي مسار

# السجل — يُقرأ كالمعتاد، لكن يُكتب من رسائل الجهاز لا من هذه النداءات
curl -s "$API/history?port=all_ports&from=2026-01-01&to=2026-12-31" | jq

# ينقل بيانات المشغّل/الشاحنة/الإيصال فقط — تُلحَق بالسجل الذي يفتحه الجهاز
curl -s -X POST $API/history -H 'Content-Type: application/json' \
     -d '{"portNum":"port1","operatorId":"123","truckNum":"5567","receiptNum":"88213","requiredQuantity":40,"flowmeter_value":10250.5}'

# تشخيص جلسة التعبئة الحيّة (السجل المفتوح، آخر قراءة عداد)
curl -s "$API/history/session/port1" | jq

# التقارير
curl -s "$API/reports?port=allPorts&from=2026-01-01&to=2026-12-31" | jq
```

```bash
# مراقبة كل رسائل MQTT
mosquitto_sub -h localhost -t '#' -v

# محاكاة جهاز يطلب إعداداته
mosquitto_pub -h localhost -t 'port1/update' -m 'config' -r

# أوامر يدوية
mosquitto_pub -h localhost -t 'port1/quantity' -m '12.5'
mosquitto_pub -h localhost -t 'port1/state'    -m 'start'
mosquitto_pub -h localhost -t 'port1/state'    -m 'force_stop'
mosquitto_pub -h localhost -t 'port1/refresh'  -m '1'
```
