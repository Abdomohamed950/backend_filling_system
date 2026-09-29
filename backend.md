# عقد الواجهة الخلفية — Backend Contract

كل ما تحتاجه الواجهة الأمامية حتى تعمل بكامل وظائفها. الأسماء هنا مأخوذة
حرفيًا من الكود، فأي اختلاف في حرف واحد يعني حقلًا فارغًا على الشاشة.

يتكوّن النظام من خدمتين (يمكن دمجهما في عملية واحدة):

| الخدمة | الافتراضي | الغرض |
| --- | --- | --- |
| REST API | `http://localhost:3000` | المصادقة، الإعدادات، السجل، التقارير |
| socket.io | `http://localhost:5000` | القراءات اللحظية وأوامر التشغيل |

> **CORS مطلوب.** الواجهة تعمل على منفذ مختلف في التطوير — فعّل
> `Access-Control-Allow-Origin` للأصل الذي تخدم منه الواجهة، مع السماح
> بـ `GET, POST, PUT, DELETE, OPTIONS` وترويسة `Authorization`.

---

## 1. REST API

جميع المسارات تحت البادئة **`/api`**، أي أن `VITE_API_URL=http://localhost:3000`
يعني `http://localhost:3000/api/ports`.

إذا أُرسل توكن من `/auth/login` فستُرفقه الواجهة تلقائيًا في كل طلب لاحق
كترويسة `Authorization: Bearer <token>`.

### 1.1 المصادقة

```
POST /api/auth/login
{ "username": "ahmed", "password": "…" }
```

الاستجابة الناجحة:

```json
{
  "token": "eyJhbGciOi…",
  "user": {
    "id": 7,
    "name": "أحمد محمد",
    "username": "ahmed",
    "role": "admin"
  }
}
```

- `role` يجب أن يكون **`"admin"`** أو **`"operator"`** بالضبط — عليه يتحدد
  المسار بعد الدخول والصلاحيات.
- `token` اختياري؛ لو حُذف يعمل النظام بجلسة محلية بدون توكن.
- بيانات خاطئة ⇒ **401** أو **403**. الواجهة تعتبر هذا القرار النهائي.
- أي رد آخر (خادم غير متاح / 404 / 500) يُفهم كـ«الخادم غير جاهز»، وفي بناء
  التطوير فقط يُسمح بالحسابين المدمجين. راجع `VITE_ALLOW_OFFLINE_LOGIN`.

### 1.2 المنافذ

```
GET    /api/ports
POST   /api/ports
PUT    /api/ports/:id
DELETE /api/ports/:id
```

`GET /api/ports` يعيد مصفوفة كائنات بهذا الشكل بالضبط:

```json
[
  {
    "id": 1,
    "name": "port1",
    "baudrate": 9600,
    "endian": "little",
    "registerType": "holding",
    "valveType": "type1",
    "slaveId": 1,
    "registerAddress": 40001,
    "flowRateAddress": 40003,
    "firstCloseTime": 5,
    "secondCloseTime": 2,
    "firstCloseLag": 1,
    "SecondCloseLag": 1,
    "pidTime": 3,
    "addedTime": 0
  }
]
```

- **`SecondCloseLag` بحرف S كبير** — هكذا هي في النموذج، وهي غير متسقة مع
  أخواتها عمدًا حفاظًا على التوافق. وحّدها في الطرفين معًا إن أردت.
- القيم المسموحة: `endian` ∈ `little | big`، `registerType` ∈ `input | holding`،
  `valveType` ∈ `type1 | type2`، `baudrate` ∈ `4800 | 9600 | 19200 | 38400 | 57600 | 115200`.
- `POST`/`PUT` يستقبلان نفس الكائن بدون `id`. الواجهة تعيد الجلب بعد كل عملية،
  فيكفي أن يعيد الرد **2xx**.
- `name` هو المفتاح المستخدم في كل أحداث socket — لا بد أن يطابق ما تبثه
  البوابة.

### 1.3 المشغّلون

```
GET    /api/operators
POST   /api/operators
PUT    /api/operators/:id
DELETE /api/operators/:id
```

```json
[{ "id": 3, "name": "محمود علي", "code": "1234", "phone": "01012345678" }]
```

- **لا تُعِد `pass` أبدًا** في `GET` — الواجهة لا تعرضها.
- `POST` يستقبل `{ name, code, pass, phone }`.
- `PUT` يستقبل نفس الحقول، لكن **`pass` يُحذف من الطلب إذا تركه المستخدم
  فارغًا**. تعامَل مع غياب `pass` على أنه «أبقِ كلمة المرور الحالية» — وإلا
  سيفقد كل مشغَّل كلمة مروره عند أي تعديل بسيط.
- `phone` نص من ١١ رقمًا.
- المعرّف `id: 0` محجوز لحساب المدير المدمج ولا يظهر في هذه القائمة.

### 1.4 السجل

```
GET /api/history?port=all_ports&from=<ISO>&to=<ISO>
```

```json
[
  {
    "id": 981,
    "portNum": "port1",
    "operatorId": "1234",
    "truckNum": "5567",
    "receiptNum": "88213",
    "requiredQuantity": 40,
    "actualQuantity": 39.8,
    "entryTime": "2026-08-31T09:12:04.000Z",
    "exitTime": "2026-08-31T09:26:41.000Z"
  }
]
```

- القيمة المميزة لكل المنافذ هنا هي **`all_ports`**.
- `from`/`to` سلاسل ISO كاملة (`toISOString()`).
- الأوقات تُقبل كـ ISO أو `"YYYY-MM-DD HH:mm:ss"` أو epoch — المحلّل في
  `lib/format.js` يتعامل مع الثلاثة.
- الفرز والبحث والترقيم يتم في المتصفح، فأعِد نطاق الفترة كاملًا. لو توقعت
  عشرات الآلاف من السجلات فالأفضل نقل الترقيم إلى الخادم.

### 1.5 التقارير

```
GET /api/reports?port=allPorts&from=<ISO>&to=<ISO>
```

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

- ⚠️ **الحقول هنا بحروف صغيرة** (`portnum`) بعكس السجل (`portNum`)، والقيمة
  المميزة **`allPorts`** بعكس `all_ports`. هذا موروث من الكود الأصلي وأبقيته
  كما هو. لو ستكتب الخلفية من الصفر فوحّدها — أخبرني وأعدّل الواجهة لتطابق.
- الإجماليات تُحسب في المتصفح؛ أعِد صفًا لكل منفذ فقط.

### 1.6 إعدادات المزامنة الخارجية (SCADA / Receipt API)

شاشة أدمن لتعديل عناوين سيرفري SCADA وReceipt API بدل ما تكون مكتوبة في
الكود — **السيرفرين مش شغالين حاليًا**، القيم دي إعداد مستقبلي.

```
GET/PUT /api/sync-settings
```

```jsonc
{
  "scadaEnabled": 1, "scadaHost": "197.134.251.84", "scadaPort": 11001,
  "receiptApiEnabled": 1, "receiptApiBaseUrl": "http://172.16.0.99:8090/KorapTmp",
  "receiptRefreshMinutes": 60
}
```

وخريطة قنوات SCADA لكل منفذ (مطلوبة قبل ما مزامنة SCADA تشتغل لمنفذ معيّن):

```
GET/PUT/DELETE /api/scada-channels/:portNum
```

```jsonc
{
  "truckCh": "1", "operatorCh": "2", "requiredCh": "3", "receiptCh": "4",
  "inTimeCh": "5", "flowmeterCh": "6", "flowTimeCh": "7",
  "actualCh": "8", "outTimeCh": "9"
}
```

كلاهما `GET` بتوكن عادي، `PUT`/`DELETE` بتوكن أدمن.

وشاشة عرض الإيصالات:

```
GET /api/receipts?checked=0|1&search=&from=&to=
GET /api/receipts/:receiptNum
```

```jsonc
{ "receiptNum": "88213", "waterQuantity": 30, "checked": 0, "syncPending": 0, "fetchedAt": "2026-09-19 16:38:33" }
```

---

## 2. بوابة socket.io

### 2.1 ما ترسله الواجهة

| الحدث | الحمولة | متى |
| --- | --- | --- |
| `join_port` | `"port1"` (نص) | عند ظهور بطاقة المنفذ |
| `leave_port` | `"port1"` (نص) | عند إخفائها |
| `start_filling` | انظر أدناه | ضغط «ابدأ» |
| `stop_filling` | `{ port }` | ضغط «توقف» |
| `stop_all_ports` | `{}` | «إغلاق جميع المنافذ» (يسبقه `stop_filling` لكل منفذ) |
| `update_field` | `{ port, field, value }` | كل تعديل في حقول الإدخال |
| `toggle_ai_mode` | `{}` | زر التشغيل الذكي |

```jsonc
// start_filling
{
  "port": "port1",
  "receipt_number": "88213",
  "truck_number": "5567",
  "required_quantity": "40",   // نص كما ورد من حقل الإدخال
  "actual_quantity": 0,
  "flowmeter_value": 10250.5,  // قراءة العداد لحظة البدء
  "operator_id": "1234"        // id المستخدم، أو username كبديل
}
```

`field` في `update_field` يكون أحد: `truckNumber` | `receiptNumber` | `requiredQuantity`.
أعِد بثّها لبقية العملاء في نفس الغرفة حتى تتزامن محطتان تعرضان نفس المنفذ.

### 2.2 ما تنتظره الواجهة

كل حدث خاص بمنفذ يجب أن يحمل **`{ port, data }`**؛ الواجهة تتجاهل أي حمولة
لا يطابق فيها `port` اسم البطاقة.

| الحدث | `data` | الأثر على الشاشة |
| --- | --- | --- |
| `availability` | `"online"` \| `"offline"` | النقطة الملونة، وتعطيل زر «ابدأ» |
| `state` | `"filling"` \| `"stop"` | قفل حقول الإدخال وبدء عدّاد الزمن |
| `valve_state` | `"close"` \| `"open"` \| `"opening"` \| `"closing"` | لون وحركة عجلة الصمام |
| `flowmeter` | رقم | قراءة العداد ومستوى الخزان |
| `ai_mode_status` | `{ "running": true }` ← بلا `port` | حالة زر التشغيل الذكي |

نقطتان مهمّتان:

1. **`flowmeter` قراءة تراكمية للعدّاد وليست فرقًا.** الواجهة تلتقط القيمة
   لحظة الضغط على «ابدأ» وتحسب `الكمية الفعلية = القراءة الحالية − قراءة البدء`.
   لو أرسلت فرقًا فستظهر الكمية سالبة أو صفرًا.
2. **`state: "stop"` هو ما يُنهي العملية** على الشاشة (يفكّ قفل الحقول ويوقف
   العدّاد). لا تكتفِ بـ `valve_state: "close"`.

عند اتصال عميل جديد أو عند `join_port`، ابعث الحالة الراهنة فورًا
(`availability` + `valve_state` + `flowmeter`) وإلا ستبقى البطاقة تعرض
«غير متصل» حتى أول تغيير فعلي.

### 2.3 الباركود — `check_receipt`

بديل لضغطة «ابدأ» لما المشغّل يمسح باركود إيصال. ابعت `check_receipt`
بدل `start_filling` مباشرة:

```jsonc
{
  "port": "port1",
  "receipt_number": "88213",   // أو رقم المشغّل نفسه = وضع أزمات (كمية يدوية)
  "truck_number": "5567",
  "operator_id": "1234",
  "required_quantity": 20      // مطلوب في وضع الأزمات فقط
}
```

الخادم يرد `receipt_check_result` دايمًا (`{ status, message?, quantity? }`)،
و`status` يكون أحد: `valid` | `crisis_ok` | `already_used` | `not_found` |
`crisis_blocked`. في حالتي `valid`/`crisis_ok` الخادم بينادي `start_filling`
تلقائيًا من عنده — الواجهة مش محتاجة تبعته تاني.

---

## 3. أمور غير مرتبطة بالـ API

- **حد الكمية**: الواجهة ترفض أي كمية مطلوبة أكبر من **100**
  (`MAX_QUANTITY` في `op_port.jsx`). عدّلها لتطابق سعة صهاريجك.
- **التحقق من جانب الخادم إلزامي.** كل تحقق في الواجهة هو تحسين لتجربة
  المستخدم فقط، ولا يُعتمد عليه أمنيًا.
- **التوكن يُحفظ في `localStorage`** تحت `fs-token`. إن كنت تفضّل كوكي
  `HttpOnly` فأخبرني لأعدّل `lib/api.js`.
