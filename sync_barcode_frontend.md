# عقد الواجهة الأمامية — إعدادات المزامنة + الباركود

ميزة جديدة على `backend.md` — أضيفت لدعم مزامنة SCADA/Receipt API الخارجية
ونظام الباركود. هذا الملف **مستقل وكافٍ بذاته**: كل اللي محتاجه فريق الواجهة
عشان يبني الشاشات دي، بلا حاجة يرجع لملفات تانية.

> ⚠️ **مهم جدًا**: السيرفرين الحقيقيين (SCADA وReceipt API) **مش شغالين
> حاليًا**. الأدمن بيدخل عناوينهم من شاشة إعدادات (تحت) استعدادًا ليوم
> ما يرجعوا يشتغلوا. لحد ما ده يحصل، أي محاولة اتصال بيهم هتفشل بصمت من
> ناحية الخادم (بيسجل في اللوج بس) — مفيش تأثير على تعبئة حقيقية.

## القواعد العامة (نفس `backend.md`)

- REST: `http://localhost:3000/api/...`
- Socket.IO: `http://localhost:5000`
- كل مسار REST هنا يحتاج توكن `Authorization: Bearer <token>` من
  `/api/auth/login`. مسارات `PUT`/`DELETE` تحتاج **مستخدم أدمن (role=admin)**
  تحديدًا — لو التوكن لمستخدم operator عادي هيرجع `403`.
- حدث `check_receipt` (تحت) بيحتاج نفس التوكن في مصافحة اتصال الـ socket
  (`io(url, { auth: { token } })`) — تمامًا زي `start_filling`.

---

## 1) شاشة إعدادات المزامنة — `/api/sync-settings`

صف إعدادات واحد بس (مفيش قائمة، مفيش إنشاء/حذف). المفروض تبقى شاشة أدمن
فيها فورم بسيط بالحقول دي.

### `GET /api/sync-settings`

بيرجع الإعدادات الحالية (توكن أي مستخدم، مش لازم أدمن):

```json
{
  "id": 1,
  "scadaEnabled": 1,
  "scadaHost": "197.134.251.84",
  "scadaPort": 11001,
  "receiptApiEnabled": 1,
  "receiptApiBaseUrl": "http://172.16.0.99:8090/KorapTmp",
  "receiptRefreshMinutes": 60,
  "updatedAt": "2026-09-19 16:38:33"
}
```

### `PUT /api/sync-settings` (أدمن فقط)

ابعت أي حقل عايز تعدّله بس — الباقي بيفضل زي ما هو:

```json
{
  "scadaHost": "10.0.0.5",
  "scadaPort": 9999
}
```

الرد:

```json
{ "message": "sync settings updated successfully", "settings": { "...": "الصف كامل بعد التعديل" } }
```

### شرح الحقول (لعمل الفورم)

| الحقل | النوع | الوصف |
| --- | --- | --- |
| `scadaEnabled` | boolean (0/1) | سويتش "تفعيل مزامنة SCADA" |
| `scadaHost` | نص | IP سيرفر SCADA |
| `scadaPort` | رقم | بورت السيرفر (افتراضي 11001) |
| `receiptApiEnabled` | boolean (0/1) | سويتش "تفعيل مزامنة الإيصالات" |
| `receiptApiBaseUrl` | نص (URL) | عنوان Receipt API الأساسي (بدون `/today` أو `/Consume`) |
| `receiptRefreshMinutes` | رقم | كل كام دقيقة يتم تحديث الإيصالات من السيرفر تلقائيًا (افتراضي 60) |

> ملاحظة: تغيير `scadaHost`/`scadaPort` بيتطبّق فورًا على أول تعبئة تالية —
> مفيش داعي لإعادة تشغيل أي حاجة. لكن تغيير `receiptRefreshMinutes` محتاج
> إعادة تشغيل السيرفر عشان يتطبّق على دورة التحديث نفسها (السويتشات
> `*Enabled` بتتقرأ فريش كل مرة، فمتأثّرتش بالقيد ده).

---

## 2) شاشة خرائط قنوات SCADA — `/api/scada-channels`

كل منفذ (`port`) محتاج "خريطة قنوات" — أرقام القنوات على سيرفر SCADA اللي
كل حقل بيتبعت عليها. **لو منفذ من غير خريطة، مزامنة SCADA بتتخطّاه بصمت.**
دي شاشة أدمن كمان، غالبًا Tab أو قسم فرعي في شاشة إعدادات المنافذ الموجودة.

### `GET /api/scada-channels`

كل الخرائط الموجودة (توكن عادي):

```json
[
  { "id": 1, "portNum": "port1", "truckCh": "1", "operatorCh": "2", "requiredCh": "3",
    "receiptCh": "4", "inTimeCh": "5", "flowmeterCh": "6", "flowTimeCh": "7",
    "actualCh": "8", "outTimeCh": "9" }
]
```

### `GET /api/scada-channels/:portNum`

خريطة منفذ واحد. `404` لو مفيش خريطة له لسه.

### `PUT /api/scada-channels/:portNum` (أدمن فقط)

بيعمل إنشاء أو تحديث في نفس الوقت (upsert) — الفورم دايمًا بيبعت الصف كامل:

```json
{
  "truckCh": "1", "operatorCh": "2", "requiredCh": "3", "receiptCh": "4",
  "inTimeCh": "5", "flowmeterCh": "6", "flowTimeCh": "7",
  "actualCh": "8", "outTimeCh": "9"
}
```

- كل الحقول نصوص (أرقام القنوات كما هي على سيرفر SCADA — ممكن يبقوا حروف
  كمان حسب إعداد السيرفر، فخليها `<input type="text">` مش رقم).
  حقل فاضي/غير مبعوت = القناة دي مش هتتبعت أصلًا لهذا المنفذ.
- `400` لو `portNum` مش موجود في جدول المنافذ (`/api/ports`) — يعني لازم
  المنفذ يتعمل الأول من شاشة المنافذ العادية قبل ما تحط له خريطة قنوات.

### `DELETE /api/scada-channels/:portNum` (أدمن فقط)

بيحذف خريطة المنفذ (يرجع المنفذ لحالة "بدون مزامنة SCADA").

---

## 3) شاشة/زر الباركود — حدث Socket.IO `check_receipt`

ده اللي بيحل محل ضغطة "بدء" في وضع الباركود. المشغّل بيمسح الباركود
(بيدخل في حقل نصّي وبيعمل Enter عادةً)، والواجهة تبعت `check_receipt` بدل
`start_filling`:

```jsonc
{
  "port": "port1",
  "receipt_number": "88213",   // القيمة اللي جت من الباركود
  "truck_number": "5567",
  "operator_id": "1234",       // نفس القيمة المستخدمة في start_filling
  "required_quantity": 20      // مطلوب بس في "وضع الأزمات" (كمية تُدخل يدويًا)
}
```

**وضع الأزمات**: لو المشغّل مسح/كتب **رقمه الشخصي هو نفسه** بدل رقم إيصال
حقيقي، الخادم بيتعامل معاها كحالة أزمات (تعبئة بدون إيصال، مرة واحدة بس
للعربية في اليوم). في الحالة دي لازم الواجهة تدي المشغّل حقل لإدخال الكمية
يدويًا وتبعتها في `required_quantity`.

### الرد: `receipt_check_result`

الخادم بيبعت الحدث ده دايمًا، بعد أي `check_receipt`:

```jsonc
{ "status": "valid", "quantity": 30, "receiptNum": "88213", "fillMode": "normal" }
```

| `status` | معناه | إيه اللي يظهر للمشغّل | التعبئة بتبدأ أوتوماتيك؟ |
| --- | --- | --- | --- |
| `valid` | الإيصال موجود ومش مستخدَم | رسالة نجاح مختصرة (أو ولا حاجة، التعبئة هتبدأ فورًا) | ✅ |
| `crisis_ok` | وضع أزمات، العربية لسه ما اتملتش النهارده | رسالة تأكيد "تعبئة أزمات" | ✅ |
| `already_used` | الإيصال ده مستخدَم قبل كده | تحذير: **"الإيصال مستخدم بالفعل"** | ❌ |
| `not_found` | الإيصال مش موجود عندنا | تحذير: **"الإيصال غير موجود"** | ❌ |
| `crisis_blocked` | العربية دي اتملت في وضع الأزمات النهارده بالفعل | تحذير: **"تم ملئ هذه السيارة مرة في وضع الأزمات اليوم"** | ❌ |
| `error` | خطأ داخلي غير متوقع | تحذير عام | ❌ |

**مهم**: في حالتي `valid`/`crisis_ok` الخادم بينادي `start_filling` من
عنده تلقائيًا — **الواجهة متبعتش `start_filling` تاني بنفسها**، ده هيعمل
تعبئة مزدوجة. كل اللي عليها إنها تستقبل أحداث `history_open`/`state`
العادية زي أي تعبئة بدأت بالطريقة التقليدية.

في حالات الرفض (`already_used`/`not_found`/`crisis_blocked`) الحقول
تفضل مفتوحة عشان المشغّل يجرب رقم تاني.

---

## 4) شاشة عرض الإيصالات — `/api/receipts`

لعرض قائمة الإيصالات (اللي جاية من Receipt API) في الواجهة — مين مستخدَم
ومين لسه، وكميته، وهل اتزامن مع السيرفر الخارجي.

### `GET /api/receipts`

Query params كلها اختيارية:

| الباراميتر | مثال | الوصف |
| --- | --- | --- |
| `checked` | `0` أو `1` | فلترة: غير مستخدَم / مستخدَم |
| `search` | `8821` | بحث بجزء من رقم الإيصال |
| `from`, `to` | `2026-09-01`, `2026-09-19` | فلترة بتاريخ الجلب (`fetchedAt`) |

```
GET /api/receipts?checked=0&search=882&from=2026-09-01&to=2026-09-19
```

```json
[
  {
    "receiptNum": "88213",
    "waterQuantity": 30,
    "checked": 0,
    "syncPending": 0,
    "fetchedAt": "2026-09-19 16:38:33"
  }
]
```

- **`checked`**: `0` = متاح للاستخدام، `1` = اتستهلك بالفعل (سواء عن طريق
  الباركود أو `start_filling` عادي بنفس رقم الإيصال).
- **`syncPending`**: `1` معناها إن تعليم الاستهلاك على السيرفر الخارجي
  (Receipt API) فشل وقت ما حصل، وبيُعاد إرساله تلقائيًا كل فترة — مفيد
  تعرض أيقونة تحذير صغيرة "لسه مش متأكد من مزامنته" بدل ما تخفيه.
- `waterQuantity`: الكمية المرتبطة بالإيصال (اللي بتتملى أوتوماتيك في
  حقل الكمية لما يتمسح باركود صحيح).

### `GET /api/receipts/:receiptNum`

إيصال واحد بالتفصيل. `404` لو مش موجود.

```json
{ "receiptNum": "88213", "waterQuantity": 30, "checked": 0, "syncPending": 0, "fetchedAt": "2026-09-19 16:38:33" }
```

> ملاحظة: الأعمدة دي هي كل اللي بيحتفظ بيه النظام محليًا حاليًا. لو محتاجين
> تفاصيل إضافية (اسم عميل، تاريخ إصدار الإيصال...) لازم تتضاف لما نتأكد من
> شكل رد `/today` الحقيقي بتاع Receipt API (لسه مقفول دلوقتي).

---

## أمثلة `curl` للاختبار السريع (بدون واجهة)

```bash
API=http://localhost:3000/api
TOKEN="..."   # من /api/auth/login (يوزر أدمن للـ PUT)

# قراءة الإعدادات
curl -s $API/sync-settings -H "Authorization: Bearer $TOKEN"

# تعديل عنوان SCADA
curl -s -X PUT $API/sync-settings -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"scadaHost":"10.0.0.5","scadaPort":9999}'

# خريطة قنوات منفذ
curl -s -X PUT $API/scada-channels/port1 -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"truckCh":"1","operatorCh":"2","requiredCh":"3","receiptCh":"4","inTimeCh":"5","flowmeterCh":"6","flowTimeCh":"7","actualCh":"8","outTimeCh":"9"}'

# قائمة الإيصالات الغير مستخدمة
curl -s "$API/receipts?checked=0" -H "Authorization: Bearer $TOKEN"

# إيصال واحد
curl -s "$API/receipts/88213" -H "Authorization: Bearer $TOKEN"
```

للباركود، جرّبه بـ `socket.io-client` بنفس طريقة اختبار `start_filling`
الموجودة عندك، وابعت `check_receipt` بدلها.
