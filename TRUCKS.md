# الشاحنات المسجّلة (كمية تلقائية + حد نقلات)

> **ده مش dev_mode فقط.** الجدول والـ REST وحد النقلات شغّالين في التعبئة العادية كمان. اللي dev_mode بس هو **الدورة التلقائية** اللي بتستخدم الكمية (شوف [DEV_MODE.md](DEV_MODE.md)).

## القاعدة الأساسية

**شاحنة مش مسجّلة = بتعدي عادي، من غير حد ومن غير تغيير في أي حاجة.** أي قيد بيطبّق على الشاحنات المسجّلة بس.

## الجدول `trucks`

| الحقل | النوع | المعنى |
|---|---|---|
| `id` | int | |
| `plate` | string (1–30)، فريد | رقم الشاحنة. بيتقارن **نصاً وبالظبط** مع `truck_number` اللي الواجهة بتبعته (وبيتخزن في `history.truckNum`). لو الواجهة بتبعت الرقم بصيغة مختلفة (مسافات/حروف) سجّله بنفس الصيغة |
| `quantity` | number \| null، `0 < q < 100` | الكمية اللي تتملي تلقائي بدون إيصال (الدورة في dev_mode). `null` = `defaultQuantity`. **في الدورة العادية الكمية بتيجي من الإيصال زي ما هي، ومابتتغيرش بالقيمة دي** |
| `limitEnabled` | boolean | **تشغيل/إيقاف** حد النقلات للشاحنة دي |
| `maxTrips` | int 0–9999 | أقصى عدد نقلات (بيتطبق بس لو `limitEnabled`) |
| `tripsDone` | int (للقراءة) | عدد النقلات المتعدّة. بيزيد حتى لو الحد مقفول |

## REST (`/api`)

| Method | Path | صلاحية | Body | الرد |
|---|---|---|---|---|
| GET | `/trucks` | `requireAuth` | | مصفوفة شاحنات |
| POST | `/trucks` | `requireAdmin` | `{ plate, quantity?, limitEnabled?, maxTrips? }` | `201 { truck }` |
| PUT | `/trucks/:id` | `requireAdmin` | أي حقول من فوق (المبعوت بس بيتغيّر) | `{ truck }` |
| DELETE | `/trucks/:id` | `requireAdmin` | | |
| POST | `/trucks/:id/reset-trips` | `requireAdmin` | | تصفير `tripsDone` لشاحنة |
| POST | `/trucks/reset-trips` | `requireAdmin` | | تصفير الكل |

الأخطاء: `400` قيمة غير صالحة (مع `error` بالسبب)، `404` شاحنة مش موجودة، `409` الرقم مكرر.
لمسح الكمية الخاصة ابعت `"quantity": null` في `PUT`.

## Socket events (السيرفر → كل العملاء)

| Event | Payload | متى |
|---|---|---|
| `truck_updated` | `{ truck }` | إنشاء/تعديل، وكمان بعد ما نقلة اتعدّت (تحديث `tripsDone` لايف) |
| `truck_deleted` | `{ id }` | حذف |
| `trucks_reset` | `{ id \| null }` | تصفير النقلات (`null` = الكل) |

## فين الحد بيتطبق (التعبئة العادية)

لما شاحنة **مسجّلة** و`limitEnabled` و`tripsDone >= maxTrips`:

| المسار | اللي بيحصل |
|---|---|
| `check_receipt` (الباركود) | الرد `receipt_check_result` بـ `status: "trips_exhausted"` ومعاه `message` و`tripsDone` و`maxTrips`. **الإيصال مش بيتحسب مستخدم** ومفيش تعبئة |
| `start_filling` (يدوي) | **الحدث الجديد** `start_blocked { port, reason: "trips_exhausted", plate, tripsDone, maxTrips }` للعميل اللي بعت، ومفيش تعبئة |
| الدورة التلقائية (dev_mode) | `dev_cycle` بـ `phase: "blocked"` و`reason: "trips_exhausted"` |

الرقم بيتاخد من `truck_number` (أو `truckNumber`) في الأمر. لو الأمر مفيهوش رقم شاحنة، مفيش حد.

## إزاي النقلة بتتعد

عند **إغلاق سجل التعبئة** (بعد ما العداد يستقر، مش لحظة `stop`) لشاحنة مسجّلة، بشرط:
- الإغلاق بسبب `stop` عادي (مش `emergency_stop`).
- السيرفر ما بعتش `force_stop` للتعبئة دي (إيقاف المشغّل أو إلغاء الدورة).

غير كده النقلة **ما بتتعدش**. وبعد العد السيرفر بيبث `truck_updated`.

## المطلوب من الواجهة

- [ ] شاشة شاحنات: جدول (رقم، كمية، مفتاح حد النقلات، أقصى نقلات، المنفذ `tripsDone`) + إضافة/تعديل/حذف + "تصفير النقلات". حدّث الجدول من `truck_updated` / `truck_deleted` / `trucks_reset`.
- [ ] التعامل مع `receipt_check_result.status === "trips_exhausted"` (اعرض `message`).
- [ ] الاستماع لـ `start_blocked` على التعبئة اليدوية.

## الملفات

| الملف | التغيير |
|---|---|
| `src/config/schema.js` | جدول `trucks` (إصدار schema 5). لو قاعدة البيانات فيها `dev_mode_trucks` من نسخة سابقة بتتنقل بياناتها تلقائياً والجدول القديم بيتشال |
| `src/models/trucksModel.js` | **جديد** |
| `src/controllers/trucksControllers.js`, `src/routes/trucksRoutes.js` | **جديد**، وموصّل في `app.js` |
| `src/services/fillingSessions.js` | عدّ النقلات عند إغلاق السجل + `noteForceStop` + `broadcast` |
| `src/utils/operator.js` | `stop_filling` بيسجّل إن في force_stop (سطر واحد) |
| `src/services/barcodeFlow.js` | رفض `trips_exhausted` في أول `checkReceipt` |
| `src/transport/socket.js` | بوابة الحد على `start_filling` |
