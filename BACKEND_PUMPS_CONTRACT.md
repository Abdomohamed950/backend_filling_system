# عقد الـ Backend: حالة الطلمبات و الـ Pump Broker

الواجهة (Frontend) **مش بتتصل بـ MQTT**. هي بتتصل بالـ gateway عن طريق Socket.IO فقط.
فالـ backend هو المسؤول عن الاشتراك في الـ MQTT topics وتحويلها لـ socket event.

لو الـ backend ما نفّذش العقد ده، الواجهة هتعرض "Pump Broker: غير متصل" دايمًا حتى لو الـ broker شغال.

## 1. الاشتراك في MQTT (في `src/transport/mqtt.js`)

اشترك في الـ 3 topics دي (كلها retained، فالقيمة الأخيرة بتوصل أول ما تشترك):

| Topic | القيم | المعنى |
|---|---|---|
| `bumpbroker/availability` | `online` / `offline` | حالة اتصال الـ Pump Broker |
| `pump1/running` | `1` / `0` | Pump1 شغالة / واقفة |
| `pump2/running` | `1` / `0` | Pump2 شغالة / واقفة |

ملاحظات:
- الـ handler الحالي بيسمع بس topics المنافذ `<port>/...`، فلازم يتضاف تعامل منفصل للـ 3 topics دي (متعاملهمش على إنهم اسم منفذ).
- التوبيكات دي على شكل `<a>/<b>` زي توبيكات المنافذ بالظبط (`bumpbroker/availability` كان هيتفسّر كمنفذ اسمه `bumpbroker`). فلازم تتطابق بالاسم الكامل **في أول الـ handler**، قبل أي معالجة للمنافذ، وتعمل `return`.
- لازم تتضاف في `filters` بتاعة `subscribe` جوه `mqttClient.on("connect")`، وإلا الرسائل ما توصلش أصلًا.
- `offline` بتتبعت تلقائيًا من الـ broker (Last Will) لو الجهاز فصل فجأة.
- لو الـ gateway نفسه فقد الاتصال بالـ MQTT broker، اعتبر `availability = "offline"` (اربطها بـ `mqttClient.on("offline")` و`on("close")` وابعت `pumps_status`).
- الرسالة الفاضية (مسح retained) بتتجاهل.

## 2. الـ Socket event (في `src/transport/socket.js`)

**اسم الـ event:** `pumps_status` (بالظبط، حروف صغيرة وشرطة سفلية)

**الـ payload:**

```json
{ "availability": "online", "pump1": 1, "pump2": 0 }
```

| الحقل | النوع | القيم |
|---|---|---|
| `availability` | string | `"online"` أو `"offline"` (الواجهة بتقارن بـ `online` بدون حساسية لحالة الحروف، لكن ابعتها بالظبط كده) |
| `pump1` | number أو string | `1` / `0` (الواجهة بتقبل `"1"` / `"0"` برضه) |
| `pump2` | number أو string | `1` / `0` |

قواعد:
- الواجهة بتدمج الـ payload الجزئي مع آخر حالة عندها، فتقدر تبعت الحقل اللي اتغير بس (مثلًا `{ "pump1": 1 }`). لكن الأفضل تبعت الحالة الكاملة كل مرة.
- لازم يتبعت الـ event **عند أي تغيير** في أي topic من الـ 3.
- ابعته بـ `io.emit("pumps_status", state)` (لكل الـ clients).

## 3. إعادة إرسال آخر حالة للـ client الجديد (مهم)

الـ Socket.IO **مش بيعيد** الرسائل القديمة. لو الـ gateway بعت الحالة قبل ما الواجهة تفتح (أو قبل ما تسجل الـ listener)، الواجهة هتفضل على `null` وتعرض "غير متصل".

لازم الـ gateway يحتفظ بآخر حالة في الذاكرة:

```js
let pumpsState = { availability: "offline", pump1: null, pump2: null };

// عند وصول رسالة MQTT: حدّث pumpsState ثم
io.emit("pumps_status", pumpsState);

// عند اتصال أي client جديد:
io.on("connection", (socket) => {
  socket.emit("pumps_status", pumpsState);
});
```

ملاحظة: الواجهة بتعرض قسم الطلمبات متأخرًا (بعد تحميل قائمة المنافذ)، فالـ emit وقت الاتصال ممكن برضه يفوتها. عشان كده يفضّل يدعم الـ gateway طلب الحالة صراحةً:

```js
socket.on("get_pumps_status", () => socket.emit("pumps_status", pumpsState));
```

(الواجهة هتبدأ تبعت `get_pumps_status` بعد الاتصال لما الـ event ده يتأكد إنه متاح، قولنا لما يتنفذ.)

## 4. المنطق الحالي في الواجهة (للمعلومية)

- `availability` غير `online` أو لسه ما جتش = تعرض "غير متصل".
- لما الـ broker `offline`: الطلمبتين بتتعرض "غير معروف" وباهتة (القيمة الـ retained ممكن تكون قديمة).
- لما `online`: `1` = شغالة، `0` = واقفة.
- قسم الطلمبات بيظهر لما يكون فيه منفذ نوعه `valve and bump` (والسيرفر بيقبل كمان `pump` ويخزنه `bump`).

## 5. قائمة تحقق للـ Backend

- [x] (اتنفّذ في `src/transport/mqtt.js` و`socket.js`، لسه محتاج تجربة فعلية)
- [ ] الاشتراك في `bumpbroker/availability` و `pump1/running` و `pump2/running`.
- [ ] تخزين آخر حالة في الذاكرة.
- [ ] `io.emit("pumps_status", state)` عند كل تغيير.
- [ ] `socket.emit("pumps_status", state)` لكل client جديد عند الاتصال.
- [ ] (اختياري، مُوصى به) دعم `get_pumps_status`.
- [ ] تجربة: افتح الواجهة في وضع التطوير وشوف في الـ Console سطر `[socket ⇠] pumps_status {...}`.
