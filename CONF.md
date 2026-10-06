# إعدادات المنفذ وبناء الـ conf (modbus و pulse)

الـ **conf** هو نص بيبعته السيرفر للجهاز (`main_makit`) على `<port>/conf`، وبيتبني من صف المنفذ في جدول `ports_setting`.
الواجهة بتحفظ القيم عن طريق `POST /api/ports` و`PUT /api/ports/:id`، والسيرفر هو اللي بيحوّلها لنص.

> الملف ده بيغطي وضعين: **modbus** و**pulse**. وضع `milli ampere` مش مدعوم في بناء الـ conf لسه (السيرفر بيرفض ويكتب في الـ log).

---

## 1) إزاي الجهاز بياخد الإعدادات

1. الجهاز لما يشتغل بينشر `<port>/update = config`، ويكرر كل 5 ثواني لحد ما يستلم رد.
2. السيرفر بيدوّر على صف المنفذ **بالاسم** (`name` = `truck_id` على الجهاز)، وبيبني الـ conf وبيبعته على `<port>/conf` (غير retained).
3. الجهاز بيقسم النص على الفواصل وبيطبّق القيم **مرة واحدة** في `setup()` (البود ريت، أوقات القفل، نوع الفلقة...). فاستلام conf جديد لوحده مش بيغيّر حاجة.
4. عشان كده بعد `PUT` على إعدادات المنفذ السيرفر بيبعت `<port>/reset`، فالجهاز يعيد التشغيل ويطلب الـ conf من تاني.

### إعادة تشغيل الجهاز بعد التعديل
الرد على `PUT /api/ports/:id` فيه حقل `device` بيقول إيه اللي حصل:

```json
"device": { "sent": true }
// أو
"device": { "sent": false, "reason": "busy" | "offline" | "renamed" | "mqtt_down" }
```

| `reason` | معناه | الجهاز بياخد القيم الجديدة إمتى |
|---|---|---|
| `busy` | المنفذ بيعبّي (`filling` / `stoping`)، والـ reset كان هيقطع الفلقة في نص التعبئة | بعد ما تعمله restart يدوي أو يتعمل reset تاني بعد التعبئة. **مفيش إعادة محاولة تلقائية** |
| `offline` | الجهاز مش متصل | لوحده أول ما يشتغل ويطلب الـ conf |
| `renamed` | اسم المنفذ اتغيّر، والجهاز لسه بيستخدم الاسم القديم في الـ topics | بعد ما تغيّر الاسم على الجهاز نفسه (صفحة إعداداته) |
| `mqtt_down` | السيرفر مش متصل بالـ broker | بعد ما الـ broker يرجع |

---

## 2) الحقول المشتركة (modbus و pulse)

| الحقل | النوع | الوحدة | ملاحظات |
|---|---|---|---|
| `name` | string | | مطلوب وفريد. لازم يطابق `truck_id` على الجهاز |
| `mode` | string | | `"modbus"` أو `"pulse"`. أي قيمة تانية: السيرفر مابيبعتش conf |
| `firstCloseTime` | رقم | ms | مدة القفل في المرحلة الأولى |
| `secondCloseTime` | رقم | ms | مدة القفل في المرحلة الثانية |
| `pidTime` | رقم | ms | مدة القفل في المرحلة **الثالثة**. اسمه كده تاريخياً، وهو `thirdCloseTime` في الجهاز |
| `addedTime` | رقم | ms | زمن إضافي (في modbus بيتضاف لزمن فتح الفلقة الكلي، وفي pulse على مرحلتي القفل التانية والتالتة) |
| `firstCloseLag` | رقم | | بداية القفل الأول |
| `SecondCloseLag` | رقم | | بداية القفل التاني (**S كبيرة**) |
| `valveType` | string | | `valve` أو `bump` أو `valve and bump` فقط. القيم المقبولة كمان: `pump` ← `bump`، و`valve and pump` ← `valve and bump`. غير كده السيرفر بيرفض |

أي حقل رقمي فاضي بيتحول لصفر، **ما عدا** `litersPerPulse` في pulse (الفاضي فيه بيترفض).

---

## 3) modbus

### الحقول الإضافية

| الحقل | القيمة | لو فاضي |
|---|---|---|
| `baudrate` | رقم | 9600 |
| `serialFrame` | `SERIAL_8N1` أو `SERIAL_8N2` أو `SERIAL_8O1` أو `SERIAL_8O2` أو `SERIAL_8E1` أو `SERIAL_8E2` | `SERIAL_8N1` |
| `endian` | `big` أو `big endian` أو `abcd` أو `aabbccdd` ← `AABBCCDD`، و`ddccbbaa` ← `DDCCBBAA`، و`cdab` أو `little` أو `little endian` ← `CDAB` | **غير معروف أو فاضي = رفض** |
| `slaveId` | رقم | 1 |
| `registerAddress` | عنوان ريجيستر التدفق التراكمي | 0 |
| `flowRateAddress` | عنوان ريجيستر معدل التدفق | 0 |
| `registerType` | `holding` أو `input` | **غير معروف أو فاضي = رفض** |

> الجهاز بيفرّق بين `AABBCCDD` وأي قيمة تانية بس (التانية بيعتبرها ترتيب الكلمات المعكوس).

### نص الـ conf (15 حقل بالظبط)

```
modbus,<baudrate>,<serialFrame>,<endian>,<slaveId>,<registerAddress>,<firstCloseTime>,<secondCloseTime>,<firstCloseLag>,<SecondCloseLag>,<pidTime>,<addedTime>,<flowRateAddress>,<registerType>,<valveType>
```

| # | الحقل في الجهاز | من |
|---|---|---|
| 0 | mode | `mode` |
| 1 | baudrate | `baudrate` |
| 2 | serial frame | `serialFrame` |
| 3 | endian | `endian` |
| 4 | slave id | `slaveId` |
| 5 | flowmeter register | `registerAddress` |
| 6 | firstCloseTime | `firstCloseTime` |
| 7 | secondCloseTime | `secondCloseTime` |
| 8 | firstCloseLag | `firstCloseLag` |
| 9 | secondCloseLag | `SecondCloseLag` |
| 10 | thirdCloseTime | `pidTime` |
| 11 | addedTime | `addedTime` |
| 12 | flow rate register | `flowRateAddress` |
| 13 | registerType | `registerType` |
| 14 | valveType | `valveType` |

مثال:

```
modbus,9600,SERIAL_8N1,AABBCCDD,1,0,2000,1500,300,100,1000,200,2,HOLDING,valve
```

---

## 4) pulse

### الحقول الإضافية (جداد)

| الحقل | القيمة | القيود |
|---|---|---|
| `litersPerPulse` | لتر لكل نبضة | **مطلوب، رقم > 0**. العداد في الجهاز بيزيد بالقيمة دي مقسومة على 1000، فلو صفر أو فاضي العداد مش بيتحرك والفلقة تفضل مفتوحة |
| `thirdCloseLag` | بداية القفل التالت (النهائي) | رقم ≥ 0 |

> حقول modbus (`baudrate` و`serialFrame` و`endian` و`slaveId` و`registerAddress` و`flowRateAddress` و`registerType`) **مابتتبعتش** في pulse. الواجهة تقدر تخفيها لما `mode = pulse`.

### ترتيب التأخيرات
لازم `firstCloseLag ≥ SecondCloseLag ≥ thirdCloseLag ≥ 0`. الجهاز بيقفل على 3 مراحل بالترتيب ده كل ما المتبقي ينزل، وأي ترتيب تاني بيخلّي مراحل القفل تتخطى أو تتلخبط، فالسيرفر بيرفضه.

### نص الـ conf (10 حقول بالظبط)

```
pulse,<litersPerPulse>,<firstCloseTime>,<secondCloseTime>,<firstCloseLag>,<SecondCloseLag>,<pidTime>,<thirdCloseLag>,<addedTime>,<valveType>
```

| # | الحقل في الجهاز | من |
|---|---|---|
| 0 | mode | `"pulse"` |
| 1 | litersPerPulse | `litersPerPulse` |
| 2 | firstCloseTime | `firstCloseTime` |
| 3 | secondCloseTime | `secondCloseTime` |
| 4 | firstCloseLag | `firstCloseLag` |
| 5 | secondCloseLag | `SecondCloseLag` |
| 6 | thirdCloseTime | `pidTime` |
| 7 | thirdCloseLag | `thirdCloseLag` |
| 8 | addedTime | `addedTime` |
| 9 | valveType | `valveType` |

مثال (قيم `port1` الحالية في الـ DB):

```
pulse,1,5,5,1,1,5,0,1,valve
```

### مثال request لمنفذ pulse

```json
POST /api/ports
{
  "name": "port1",
  "mode": "pulse",
  "litersPerPulse": 1,
  "firstCloseTime": 2000,
  "secondCloseTime": 1500,
  "pidTime": 1000,
  "addedTime": 200,
  "firstCloseLag": 300,
  "SecondCloseLag": 100,
  "thirdCloseLag": 20,
  "valveType": "valve"
}
```

---

## 5) لو القيم غلط

الـ `POST` و`PUT` **مابيرفضوش** القيم دي: بيحفظوها زي ما هي. الرفض بيحصل متأخر وقت بناء الـ conf: السيرفر **مابيبعتش حاجة** وبيكتب السبب في الـ log، والجهاز يفضل يسأل كل 5 ثواني ومعاه إعداداته القديمة. فالواجهة **لازم تتحقق قبل الحفظ**.

| السبب | رسالة الـ log |
|---|---|
| `valveType` غير معروف | `unknown valveType "x" - expected one of ...` |
| `endian` أو `registerType` غير معروف (modbus) | `unknown endian / registerType ...` |
| `litersPerPulse` فاضي أو ≤ 0 (pulse) | `litersPerPulse must be a number > 0 for pulse mode` |
| ترتيب التأخيرات غلط (pulse) | `close lags must satisfy first >= second >= third >= 0` |
| `mode` غير مدعوم | `mode "..." is not supported by buildConf() yet` |
| مفيش صف بالاسم ده | `no ports_setting row named "..." - not sending conf` |

---

## 6) الوحدات (لازم تتأكد منها)

- **الأزمنة بالـ ms**: ده مؤكد من الكود (الجهاز بيقارنها بـ `millis()`). قيمة زي `5` معناها 5 ملّي ثانية مش 5 ثواني. لو الواجهة بتدخّل المستخدم ثواني، لازم تضرب في 1000 قبل الحفظ.
- **الكمية والتأخيرات واللتر لكل نبضة (pulse)**: مستنتجة من الكود مش مؤكدة: العداد بيزيد بـ `litersPerPulse / 1000` والتأخيرات بتتقسم على 1000 قبل المقارنة بالمتبقي. يعني غالباً الكمية المطلوبة بالمتر المكعّب والتأخيرات و`litersPerPulse` باللتر. جرّبها على الجهاز مرة قبل ما تثبّت القيم.

---

## 7) المطلوب من الواجهة

- [ ] اختيار `mode` (`modbus` / `pulse`) وإظهار حقول كل وضع بس.
- [ ] التحقق قبل الحفظ من القيود في الجداول فوق (`valveType`، `litersPerPulse > 0`، ترتيب التأخيرات، قيم `endian` و`registerType`).
- [ ] حقول `litersPerPulse` و`thirdCloseLag` الجداد في وضع pulse.
- [ ] بعد `PUT`: اعرض حالة `device` (اتعمله restart ولا لأ، وليه).
- [ ] تحويل الثواني لـ ms لو الواجهة بتعرضها بالثواني.

---

## 8) ملحوظة على بيانات موجودة

`port2` و`port3` في الـ DB عندهم `valveType = "type1"`، وده مش من القيم المقبولة، فالسيرفر **مش هيبعتلهم conf** لحد ما يتعدّل. `port1` سليم.

---

## 9) الملفات

| الملف | الدور |
|---|---|
| `src/transport/mqtt.js` | `buildConf` (modbus) و`buildPulseConf` (pulse)، والرد على `<port>/update`، و`applyConfigToDevice` (الـ reset) |
| `src/controllers/portsSettingControllers.js` | `PUT /api/ports/:id` وبعده بيبعت الـ reset ويرجّع `device` |
| `src/models/portsSettingModel.js` | قراءة وكتابة الصف (بما فيه `litersPerPulse` و`thirdCloseLag`) |
| `src/config/schema.js` | عمودين `litersPerPulse` و`thirdCloseLag` (schema 6)، بيتضافوا تلقائياً |
| `makit/main_makit/main_makit.ino` | `config[]` وتطبيقها في `setup()` |
