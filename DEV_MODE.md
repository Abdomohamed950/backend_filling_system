# dev_mode — دورة العربية (التراففيك + الكاميرا + التعبئة التلقائية)

> **اللي في الملف ده بيشتغل في `dev_mode` فقط.**
> الوضع مقفول افتراضيًا. وهو مقفول السيرفر **ما بينشرش أي رسالة MQTT جديدة، ولا بيشغّل الكاميرا، ولا بيبث أي event جديد**
> (غير `dev_mode_status` اللي بيتبعت للعميل عند الاتصال عشان الواجهة تعرف الحالة).
>
> **اللي اتغيّر خارج dev_mode** (بيأثر على التشغيل العادي، متوثّق في [قسم 8](#8-تغييرات-خارج-dev_mode)):
> الشاحنات المسجّلة وحد النقلات ([TRUCKS.md](TRUCKS.md))، وإعادة تشغيل الجهاز بعد تعديل إعدادات المنفذ.

---

## 1) الفكرة

الـ makit عبارة عن عربية صغيرة بيحركها stepper (`traffic`) على مسار، وعليها شاشة (`esp_car`) بتعرض رقمها. الكاميرا بتقرأ الرقم ده، والسيرفر بيملّيها تلقائي.

| الجزء | بيعمل إيه | بيتحكم فيه مين |
|---|---|---|
| **Stepper (traffic)** | بيحرّك العربية بعدد لفّات (`<port>/turns`) | السيرفر، بعدد لفّات **بيتحدد من الواجهة لكل منفذ** (مفيش قيم hardcoded) |
| **قراءة الرقم** | كاميرا USB على اللابتوب بتصوّر شاشة العربية وبتقرأ الأرقام بـ OCR | السيرفر بيطلبها في الدورة، أو `main_makit` (وضع pulse) بزرار D0، أو يدويًا من الواجهة |
| **الدورة التلقائية** | زرار واحد في الواجهة: العربية تيجي تحت المنفذ، تتقرأ، تتملي، وتمشي | السيرفر (`devCycle.js`) |

تشغيل `dev_mode` من الواجهة بيعمل:
1. تشغيل عملية `plate_reader.py` (قراءة الكاميرا).
2. نشر `<port>/turns_ready` (retained) لكل منفذ.
3. تفعيل تسلسل خروج العربية عند `<port>/state = stop`.
4. تفعيل `dev_start_cycle`.

إيقافه بيوقّف كل ده (والتعبئة اللي شغالة بتكمل في المسار العادي).

> dev_mode متجرّب على وضع **pulse** فقط. زرار D0 على `main_makit` بيشتغل في pulse بس (في modbus الـ pin ده هو DE بتاع MAX485)، لكن الدورة والتريجر اليدوي من السيرفر شغّالين في أي وضع.

---

## 2) الـ Socket events (للواجهة)

كلها على نفس اتصال socket.io الحالي (بورت `SOCKET_PORT`، افتراضي 5000). الشاحنات على REST، شوف [TRUCKS.md](TRUCKS.md).

### 2.1 التشغيل والإيقاف

| الاتجاه | Event | Payload |
|---|---|---|
| UI → Server | `dev_mode` | `{ "enabled": true \| false }` |
| Server → كل العملاء | `dev_mode_status` | `{ "enabled": boolean }` |

- الحالة **مشتركة بين كل العملاء** (زي `ai_mode_status`). السيرفر بيبعتها لأي عميل جديد أول ما يتصل.
- الحالة بتفضل في ذاكرة السيرفر فقط: **إعادة تشغيل السيرفر بترجّعه مقفول**.

### 2.2 عدد اللفّات لكل منفذ

| الاتجاه | Event | Payload |
|---|---|---|
| UI → Server | `dev_get_turns` | `{ "port": "port1" }` أو من غير payload (كل المنافذ من `ports_setting`) |
| UI → Server | `dev_set_turns` | `{ "port": "port1", "readyTurns"?: 4.1, "stopTurns"?: 3.1, "homeTurns"?: 0 }` |
| Server → كل العملاء | `dev_turns` | `{ "port", "readyTurns", "stopTurns", "homeTurns" }` |
| UI → Server | `dev_move` | `{ "port": "port1", "turns": 2.5 }` — حركة يدوية للمعايرة (dev_mode لازم يكون شغال) |

- القيم لازم تكون **رقم بين 0 و 6.6** (حد الـ firmware). أي قيمة غير صالحة بترجع `dev_error` ومش بتتحفظ.
- `dev_set_turns` بيحدّث الحقول المبعوتة فقط؛ الباقي بيفضل زي ما هو.
- القيم الافتراضية (لو المنفذ ما اتضبطش): `readyTurns = 4.1`، `stopTurns = 3.1`، `homeTurns = 0`.

| الحقل | المعنى | كان فين |
|---|---|---|
| `readyTurns` | **تحت المنفذ**: الموضع اللي العربية بتتحرك له في الدورة (والأصفر ثابت في التراففيك لما يوصله) | `target_position = 4.1` في `traffic.ino` |
| `stopTurns` | أول موضع عند خروج العربية بعد التعبئة | `3.1` في `esp_car` |
| `homeTurns` | البيت: آخر موضع عند الخروج | `0` في `esp_car` |

**تسلسل الخروج عند `<port>/state = stop`** (dev_mode شغال): `stopTurns` ← (بعد 3 ثواني) `homeTurns`. العربية بتخرج وتفضل في البيت.
رجوعها تحت المنفذ بيتم بدورة `dev_start_cycle` (قسم 2.4) بس، مش تلقائي. وصول `filling` أثناء التسلسل بيلغيه.

### 2.3 كاميرا قراءة الرقم وإعدادات الدورة

| الاتجاه | Event | Payload |
|---|---|---|
| UI → Server | `dev_get_settings` | — |
| UI → Server | `dev_set_settings` | أي مجموعة من الحقول تحت |
| Server → كل العملاء | `dev_settings` | الإعدادات الحالية كاملة |
| UI → Server | `dev_list_cameras` | — (عشان قايمة الاختيار) |
| Server → UI | `dev_cameras` | `{ "platform": "linux", "backend": "v4l2", "backends": ["auto","v4l2","avfoundation","any"], "cameras": [{ "index": 0, "device": "/dev/video0" }] }` — على macOS الأسماء من `system_profiler` |
| UI → Server | `dev_capture_plate` | — تشغيل القراءة يدويًا. dev_mode لازم يكون شغال |
| Server → كل العملاء | `dev_plate` | `{ "camera": "cam1", "number": "1234" }` — `number: null` لو القراءة فشلت |

حقول `dev_settings` (كلها في نفس شاشة إعدادات الكاميرا في الواجهة):

| الحقل | النوع | الافتراضي | القيود | المعنى |
|---|---|---|---|---|
| `camId` | string | `"cam1"` | حروف/أرقام/`_`/`-` بس، حتى 32 | اسم الكاميرا في الـ topics (`<camId>/esp` و`<camId>/plate`) |
| `camIndex` | int | `0` | 0–63 | رقم جهاز الكاميرا (`/dev/videoN` على Linux، ترتيب الكاميرا على macOS) — خد القايمة من `dev_cameras` |
| `camBackend` | string | `"auto"` | `auto` \| `v4l2` \| `avfoundation` \| `any` | باك إند الكاميرا. `auto` = `v4l2` على Linux و`avfoundation` على macOS. القايمة وقيمة `auto` الفعلية جاية في `dev_cameras` |
| `plateDigits` | int | `4` | 1–12 | عدد خانات الرقم المتوقع. أي قراءة بعدد مختلف بتتتجاهل |
| `plateFrames` | int | `5` | 1–20 | عدد الفريمات اللي بيتصوّت عليها (الأكتر تكرارًا بيكسب) |
| `roi` | object \| null | `null` | `{x,y,w,h}` كنسب 0..1، و`x+w ≤ 1` و`y+h ≤ 1` | المربع اللي القراءة بتتركز عليه (شاشة العربية بس). `null` = الصورة كلها |
| `debugDir` | string | `""` | — | لو متحدد، القارئ بيحفظ الفريمات في المجلد ده للمعايرة |
| `arriveWaitMs` | int | `5000` | 0–60000 | في الدورة: انتظار وصول العربية تحت المنفذ قبل قراءة الرقم. حركة الـ stepper بتاخد وقت (حوالي 0.8 ثانية للفّة) فزوّده لو القراءة بتتم قبل ما العربية توصل |
| `defaultQuantity` | number | `10` | `0 < q < 100` | الكمية الثابتة في الدورة لشاحنة مش مسجّلة أو مالهاش كمية خاصة |

- الإعدادات بتتحفظ في قاعدة البيانات (بتفضل بعد إعادة تشغيل السيرفر).
- لو غيّرت إعدادات **وdev_mode شغال**، السيرفر **بيعيد تشغيل القارئ تلقائيًا** بالقيم الجديدة.
- `dev_set_settings` بيحدّث الحقول المبعوتة فقط. لمسح الـ ROI ابعت `"roi": null`.

> المقترح للواجهة: قايمة اختيار الكاميرا من `dev_cameras`، حقول رقم الخانات والفريمات و`arriveWaitMs` و`defaultQuantity`،
> ومربع اختيار ROI فوق صورة مباشرة (أو 4 حقول نسب)، مع زرار **"جرّب القراءة"** بيبعت `dev_capture_plate` وتعرض النتيجة من `dev_plate`.

### 2.4 دورة التعبئة التلقائية (من غير إيصالات)

في dev_mode مفيش فحص إيصال: الكمية بتيجي من الشاحنة المسجّلة أو من `defaultQuantity`.
**الشاحنات نفسها مش جزء من dev_mode**: جدول `trucks` عام وله REST وشغّال في التعبئة العادية كمان ([TRUCKS.md](TRUCKS.md)). اللي بتعمله الدورة:

- **رقم مسجّل:** بتملي بكميته (أو `defaultQuantity` لو كميته فاضية)، وحد النقلات بتاعه بيتطبق لو مفعّل.
- **رقم مش مسجّل:** بيعدي عادي بـ `defaultQuantity` ومن غير أي حد.

| الاتجاه | Event | Payload |
|---|---|---|
| UI → Server | `dev_start_cycle` | `{ port }` — الزرار (يظهر في dev_mode فقط) |
| UI → Server | `dev_cancel_cycle` | `{ port }` — بيوقف التعبئة لو شغالة وبيطلّع العربية، من غير ما يعد نقلة |
| Server → كل العملاء | `dev_cycle` | `{ port, phase, ...extra }` |

مراحل `phase` بالترتيب:

| phase | بيحصل إيه | extra |
|---|---|---|
| `moving` | السيرفر بيحرّك العربية تحت المنفذ (`turns = readyTurns`) | `turns` |
| `reading` | بعد `arriveWaitMs` بيطلب قراءة الرقم من الكاميرا | |
| `starting` | مفيش حد نقلات واقف: بيبعت الكمية + `start` | `plate`, `quantity`, `registered` |
| `filling` | الجهاز أعلن `state = filling` | `plate` |
| `filled` | التعبئة خلصت بـ `stop` (أو `cancelled` / `aborted` لو إلغاء/طوارئ). عدّ النقلة بيحصل بعد ما العداد يستقر ويجيلك `truck_updated` | `plate` |
| `leaving` | العربية بتخرج (`stopTurns` ثم `homeTurns`) | |
| `done` | الدورة خلصت، المنفذ جاهز لدورة جديدة | |
| `blocked` | فشل، ومفيش تعبئة. العربية بتخرج بعدها (`leaving` ← `done`) | `reason` |

أسباب `blocked`:

| reason | معناه |
|---|---|
| `read_failed` | الكاميرا ما قرتش رقم (20 ثانية) |
| `trips_exhausted` | الحد مفعّل و`tripsDone >= maxTrips` (extra: `plate`, `tripsDone`, `maxTrips`) |
| `invalid_quantity` | الكمية خارج `0 < q < 100` |
| `start_timeout` | الجهاز ما بدأش خلال 30 ثانية من `start` (السيرفر بيبعت `force_stop` احتياطي) |
| `error` | خطأ داخلي (extra: `message`) |

شروط البدء (غير كده بيرجع `dev_error`): dev_mode شغال، المنفذ `online` وفاضي (مش `filling`/`stoping`)، مفيش دورة تانية على نفس المنفذ، ومفيش دورة تانية بتقرأ رقم دلوقتي (الكاميرا واحدة).

التعبئة نفسها بتمشي في نفس مسار `start_filling` العادي، فالسجل بيتكتب في `history` بـ `truckNum` = الرقم المقروء و`requiredQuantity` = الكمية و`receiptNum` فاضي و`fillMode = normal`.

### 2.5 الأخطاء والصلاحيات

كل الأوامر اللي بتغيّر أو بتحرّك (`dev_mode`, `dev_set_*`, `dev_move`, `dev_capture_plate`, `dev_start_cycle`, `dev_cancel_cycle`) بتتحقق من المشغّل بنفس قاعدة `start_filling`
(توكن في `socket.handshake.auth.token`؛ لو `AUTH_REQUIRED=true` أو التوكن موجود وغلط بترجع `dev_error: unauthorized`). القراءات (`dev_get_*`, `dev_list_cameras`) مفتوحة.

أي حدث `dev_*` غلط بيرجع **للعميل اللي بعته بس**:

```json
{ "event": "dev_set_turns", "message": "stopTurns must be a number between 0 and 6.6" }
```

على event اسمه `dev_error`.

---

## 3) إعدادات منفذ pulse (الـ conf اللي بيروح للجهاز)

dev_mode بيشتغل على وضع **pulse**، فمنفذك لازم يتضبط بالقيم دي من شاشة إعدادات المنافذ (`POST /api/ports` للإنشاء و`PUT /api/ports/:id` للتعديل، نفس الشاشة الموجودة). مفيش event جديد.

### كيف الجهاز بياخد الإعدادات
1. الجهاز لما يشتغل بينشر `<port>/update = config` كل 5 ثواني لحد ما يستلم رد.
2. السيرفر بيقرأ صف المنفذ من `ports_setting` (بالاسم) وبيبني نص بـ 10 حقول ويبعته على `<port>/conf`.
3. الجهاز بيطبّق القيم مرة واحدة في `setup()`، فتعديل الإعدادات بعد كده محتاج restart. السيرفر بيبعت `<port>/reset` تلقائياً بعد `PUT` (إلا لو المنفذ بيعبّي أو offline أو الاسم اتغيّر، والرد فيه `device: { sent, reason? }`).

### الحقول اللي الواجهة تبعتها

| حقل الـ API | يروح لـ | الوحدة | القيود |
|---|---|---|---|
| `name` | اسم المنفذ (لازم يطابق `port_id` على الجهاز) | | مطلوب، فريد |
| `mode` | `"pulse"` | | **لازم `"pulse"`**، وإلا السيرفر مش هيبعت conf pulse |
| `litersPerPulse` | حجم النبضة الواحدة | **لتر/نبضة** | **مطلوب، رقم > 0** (عداد الجهاز بيزيد بالقيمة دي مقسومة على 1000، فلو صفر أو فاضي العداد مش بيتحرك والفلقة تفضل مفتوحة). **حقل جديد** |
| `firstCloseTime` | مدة القفل المرحلة الأولى | ms | رقم ≥ 0 |
| `secondCloseTime` | مدة القفل المرحلة الثانية | ms | رقم ≥ 0 |
| `pidTime` | مدة القفل المرحلة **الثالثة** (اسمه كده تاريخياً، هو `thirdCloseTime` في الجهاز) | ms | رقم ≥ 0 |
| `addedTime` | زمن إضافي بيتضاف على مرحلتي القفل التانية والتالتة (وعلى زمن فتح الفلقة الكلي) | ms | رقم ≥ 0 |
| `firstCloseLag` | يبدأ القفل الأول لما المتبقي يوصل لـ | لتر | رقم ≥ 0 |
| `SecondCloseLag` (S كبيرة) | يبدأ القفل التاني لما المتبقي يوصل لـ | لتر | رقم ≥ 0 |
| `thirdCloseLag` | يبدأ القفل التالت (النهائي) لما المتبقي يوصل لـ | لتر | رقم ≥ 0. **حقل جديد** |
| `valveType` | نوع الفلقة | | `valve` أو `bump` أو `valve and bump` |

> الحقول `baudrate` و`serialFrame` و`endian` و`slaveId` و`registerAddress` و`flowRateAddress` و`registerType` خاصة بـ modbus ومش بتتبعت للجهاز في pulse. تقدر الواجهة تخفيها لما `mode = pulse`.

**ترتيب التأخيرات:** لازم `firstCloseLag ≥ SecondCloseLag ≥ thirdCloseLag ≥ 0`. الجهاز بيقفل على 3 مراحل بالترتيب ده كلما المتبقي بينزل، فأي ترتيب تاني بيخلّي مراحل القفل تتخطّى أو تتلخبط.

### نص الـ conf اللي بيتبعت
ترتيب الحقول على `<port>/conf` (بيطابق `config[]` في pulse branch بتاع `main_makit.ino`):

```
pulse,<litersPerPulse>,<firstCloseTime>,<secondCloseTime>,<firstCloseLag>,<SecondCloseLag>,<pidTime>,<thirdCloseLag>,<addedTime>,<valveType>
```

مثال: `pulse,0.5,2000,1500,300,100,1000,20,200,valve`

### لو القيم غلط
الـ `POST`/`PUT` **مابيرفضوش** القيم دي (بيحفظوها زي ما هي). السيرفر بيرفض وقت بناء الـ conf: مابيبعتش حاجة، بيطبع الخطأ في الـ log، والجهاز يفضل يسأل كل 5 ثواني ومعاه إعداداته القديمة. فالواجهة **لازم تتحقق من القيود اللي فوق قبل الحفظ** (خصوصاً `litersPerPulse > 0`، وترتيب التأخيرات، و`valveType`).

> **وحدات الكمية (مستنتجة من الكود، مش مؤكدة):** عداد الـ pulse في الجهاز بيزيد بـ `litersPerPulse / 1000`، والتأخيرات بتتقسم على 1000 قبل المقارنة بالمتبقي. يعني الكمية المطلوبة (`0 < q < 100`) غالباً بالمتر المكعّب والتأخيرات و`litersPerPulse` باللتر. اتأكد من ده على الجهاز مرة قبل ما تثبّت القيم.

---

## 4) المطلوب من الواجهة (Checklist)

- [ ] زرار/مفتاح "Dev Mode" يبعت `dev_mode {enabled}` ويعرض الحالة من `dev_mode_status` (مش من الحالة المحلية).
- [ ] لما `dev_mode_status.enabled === false` اخفي كل اللي تحت. السيرفر أصلًا بيرفض الأوامر وهو مقفول.
- [ ] **زرار "ابدأ الدورة"** لكل منفذ (يظهر في dev_mode فقط) يبعت `dev_start_cycle {port}`، وزرار "إلغاء" يبعت `dev_cancel_cycle`. اعرض `dev_cycle.phase` و`reason` لو `blocked`.
- [ ] شاشة إعدادات dev_mode:
  - [ ] جدول المنافذ: لكل منفذ `readyTurns` / `stopTurns` / `homeTurns` (0–6.6)، حفظ بـ `dev_set_turns`، تحميل بـ `dev_get_turns`، وزرار "تحريك" بيبعت `dev_move`.
  - [ ] إعدادات الكاميرا والدورة (قسم 2.3): الكاميرا والـ ROI والخانات والفريمات و`arriveWaitMs` و`defaultQuantity` + زرار "جرّب القراءة".
- [ ] **إعدادات المنفذ في وضع pulse** (قسم 3): حقل `litersPerPulse` و`thirdCloseLag` الجداد، والتحقق من القيود قبل الحفظ (`litersPerPulse > 0`، `first ≥ second ≥ third`، `valveType`)، وإخفاء حقول modbus لما `mode = pulse`.
- [ ] **شاشة الشاحنات** (عامة، مش dev بس): شوف [TRUCKS.md](TRUCKS.md).
- [ ] الاستماع لـ `dev_plate`: `number` موجود ← حطه في حقل **رقم السيارة** (وراجع المستخدم). `null` ← "ما اتقرأش" والمستخدم يدخله يدوي.
- [ ] الاستماع لـ `dev_error` وعرضه.

ملحوظة: `dev_plate` مش مربوط ببورت (الكاميرا واحدة)، فالواجهة هي اللي تقرر الحقل اللي يتملي.

---

## 5) السيناريو الكامل

### 4.1 الدورة التلقائية (زرار الواجهة)

```
[الواجهة] dev_start_cycle {port}
   ▼
[السيرفر] يتأكد: dev_mode شغال، المنفذ online وفاضي
   │ publish  <port>/turns = readyTurns          ← العربية تتحرك تحت المنفذ   (moving)
   │ انتظار arriveWaitMs
   │ publish  <cam>/esp = start                                                  (reading)
   ▼
[plate_reader.py] يلتقط plateFrames فريم، يقص الـ roi، OCR، تصويت
   │ publish  <cam>/plate = "1234"   (أو "" لو فشل ← blocked: read_failed)
   ▼
[السيرفر]
   │ شاحنة مسجّلة وحدها خلص ← blocked: trips_exhausted
   │ غير كده: الكمية = كمية الشاحنة ?? defaultQuantity
   │ publish  <port>/quantity ثم <port>/state = start                           (starting)
   ▼
[main_makit] يفتح الفلقة ← state = filling                                       (filling)
   ...  flowmeter / flow_rate / valve_state  ...
[main_makit] يقفل ← state = stop                                                 (filled)
   ▼
[السيرفر]
   │ يقفل سجل history ويعد النقلة (لشاحنة مسجّلة)  ← truck_updated
   │ publish  <port>/turns = stopTurns ثم (+3s) homeTurns                        (leaving)
   ▼
[الواجهة] dev_cycle: done
```

أي فشل بيطلع `blocked` ثم `leaving` ثم `done`، من غير تعبئة.

### 4.2 قراءة الرقم لوحدها (من غير دورة)

```
[main_makit: زرار D0 (وضع pulse)]   أو   [الواجهة: dev_capture_plate]
   │ publish  cam1/esp = "start"
   ▼
[plate_reader.py] ← OCR
   │ publish  cam1/plate = "1234"
   ▼
[السيرفر: devMode.js]  ← بيشتغل فقط لو dev_mode شغال
   │ io.emit("dev_plate", { camera: "cam1", number: "1234" })
   ▼
[الواجهة] → حقل رقم السيارة
```

### 4.3 تعبئة عادية (من غير دورة) وdev_mode شغال

لو المشغّل بدأ تعبئة بنفسه (باركود أو يدوي) وdev_mode شغال: لما `state = stop` توصل، العربية بتخرج (`stopTurns` ثم `homeTurns`) بدون دورة.

---

## 6) تفاصيل MQTT (للأجهزة)

| Topic | الاتجاه | Retained | المحتوى | الاستخدام |
|---|---|---|---|---|
| `<port>/turns` | السيرفر ← traffic | لا | `0..6.6` | أمر حركة |
| `<port>/turns_ready` | السيرفر ← traffic | **نعم** | `readyTurns` | الجهاز يعرف موضع الجاهزية حتى بعد إعادة تشغيله |
| `<port>/state` | الجهاز → السيرفر | — | `stop`/`filling`/... | السيرفر بيسمعه (من غير ما يغيّر معالجة `mqtt.js`) |
| `<port>/quantity` + `<port>/state = start` | السيرفر ← main_makit | لا | كمية، `start` | بداية التعبئة في الدورة (نفس `start_filling`) |
| `<camId>/esp` | main_makit/السيرفر ← القارئ | لا | `start` | تشغيل قراءة |
| `<camId>/plate` | القارئ → السيرفر | لا | رقم أو `""` | نتيجة القراءة |

الأوامر (`turns`) **مش retained** عن قصد: لو كانت retained كانت هتتكرر عند كل reconnect وتحرّك العربية لوحدها.

---

## 7) ملفات dev_mode

### Backend
| الملف | التغيير |
|---|---|
| `src/services/devMode.js` | **جديد.** الحالة، اللفّات، تسلسل الخروج، إعدادات الكاميرا والدورة، تشغيل القارئ، الـ socket events، فحص الصلاحيات. بيعمل جدولين لوحده (`dev_mode_turns`, `dev_mode_settings`) بـ `CREATE TABLE IF NOT EXISTS` |
| `src/services/devCycle.js` | **جديد.** الدورة التلقائية (`dev_start_cycle`). بيستخدم `start_filling`/`stop_filling` الموجودين وجدول `trucks` |
| `src/utils/ai/plate_reader.py` | **جديد.** قارئ الكاميرا + OCR (EasyOCR). منفصل عن `ai.py` (كاميرات RTSP) و`app.py`. شغّال مع `paho-mqtt` 1.x و2.x |
| `src/transport/socket.js` | سطور dev_mode: `require` و`devMode.init(mqttClient, io)` و`devMode.registerSocket(socket)` (وبوابة الشاحنات على `start_filling`، قسم 8) |

### Firmware (`makit/`) — **لازم Flash بعد التعديل**
| الملف | التغيير |
|---|---|
| `traffic/traffic.ino` | بيسمع `<port>/turns` و`<port>/state` بدل `stepper/turns` و`port1/state`؛ بيستقبل `<port>/turns_ready` بدل الـ `4.1` الثابتة؛ نطاق الأصفر الوامض بقى `±0.5` حوالين موضع الجاهزية؛ حقل **port name** جديد في صفحة الإعدادات (افتراضي `port1`)، وده لازم يطابق اسم المنفذ في `ports_setting` |
| `esp_car/MQTTManager.cpp` | اتشال منه نشر `stepper/turns` (3.1 ← 0 ← 4.1) عشان ما يتعارضش مع السيرفر. باقي السلوك (الشاشة، PWM) زي ما هو |

> **تنبيه:** بعد تعديل `esp_car`، لو الـ traffic اشتغل من غير السيرفر في dev_mode مش هيتحرك على `stop` خالص (الحركة بقت من السيرفر). ده مقصود.

---

## 8) تغييرات خارج dev_mode

دي بتأثر على التشغيل العادي (مش بتتطلب dev_mode):

| التغيير | الأثر | الملفات |
|---|---|---|
| **الشاحنات وحد النقلات** | شاحنة مسجّلة وحدها خلص بتترفض في `check_receipt` (`status: "trips_exhausted"`) و`start_filling` (event `start_blocked`). غير المسجّلة بتعدي زي ما هي. النقلات بتتعد عند إغلاق سجل `stop` عادي. التفاصيل في [TRUCKS.md](TRUCKS.md) | `config/schema.js` (schema 5)، `models/trucksModel.js`، `controllers/trucksControllers.js`، `routes/trucksRoutes.js`، `app.js`، `services/fillingSessions.js`، `services/barcodeFlow.js`، `utils/operator.js` (سطر في `stop_filling`)، `transport/socket.js` |
| **conf وضع pulse** | السيرفر بقى يبني `<port>/conf` لمنافذ `mode = "pulse"` (كان modbus بس). عمودين جداد في `ports_setting`: `litersPerPulse` و`thirdCloseLag` (schema 6، بيتضافوا تلقائياً للقاعدة الموجودة). مفيش تغيير على منافذ modbus. التفاصيل في قسم 3 | `transport/mqtt.js` (`buildPulseConf`)، `config/schema.js`، `models/portsSettingModel.js`، `controllers/portsSettingControllers.js` |
| **إعادة تشغيل الجهاز بعد تعديل إعدادات المنفذ** | `PUT /api/ports/:id` بيبعت `<port>/reset` للجهاز عشان ياخد الإعدادات الجديدة (الفيرموير بيطبّقها في `setup()` بس). مابيحصلش لو المنفذ بيعبّي (`busy`)، أو offline، أو الاسم اتغيّر. الرد فيه `device: { sent, reason? }` | `transport/mqtt.js` (`applyConfigToDevice`)، `controllers/portsSettingControllers.js` |

---

## 9) التشغيل والمتطلبات

- `python3` بالمكتبات: `opencv-python`, `easyocr`, `paho-mqtt` (نفس اللي `ai.py` بيستخدمها).
- كاميرا USB على اللابتوب (`/dev/videoN`). لو أول جهاز هو الكاميرا الداخلية، اختار كاميرا الـ USB من `dev_cameras`.
- `MQTT_URL` من `.env` بيستخدمه السيرفر والقارئ.
- لو `python3` مش موجود: السيرفر بيطبع الخطأ ويكمل (مبيقعش)، لكن القراءة مش هتشتغل.
- القارئ بيتحمّل EasyOCR وقت التشغيل، فأول تشغيل ممكن ياخد ثواني قبل ما يستجيب لأول `start`.

للتجربة اليدوية بدون السيرفر:

```bash
DEV_CAM_INDEX=1 DEV_PLATE_ROI=0.2,0.3,0.5,0.4 DEV_PLATE_DEBUG=/tmp/plates \
  python3 src/utils/ai/plate_reader.py
mosquitto_pub -t cam1/esp -m start
```

---

## 10) قيود معروفة

- القارئ بيفترض الرقم **كله أرقام** و**عدد خانات ثابت** (`plateDigits`). الشاحنة المسجّلة برقم فيه حروف مش هتتعرف من الكاميرا.
- الكاميرا واحدة: `dev_plate` مش بيحدد منفذ، وحاجة واحدة بس بتقرأ في نفس الوقت.
- دقة القراءة بتعتمد على ظهور الشاشة في الكاميرا (إضاءة، زاوية، رعشة الـ OLED): اضبط `roi` وجرّب بـ `debugDir` الأول.
- القراءة اتجربت على صورة اصطناعية بس، ولسه ما اتجربتش على شاشة `esp_car` الحقيقية. منطق الدورة اتجرّب على broker وجهاز وهميين.
- حركة الـ stepper في `traffic` بتحجب الـ loop (`stepMotor`)، فهو مش بيستقبل MQTT وهو بيتحرك.
- `esp_car` لسه بيغيّر الأرقام اللي بيعرضها لوحده (5 أرقام ثابتة في الكود) وفي `stop` بيعمل `delay(3000)`. الأرقام لازم تتسجّل كشاحنات لو عايز كمية أو حد خاص بيها، وإلا بتتملي بـ `defaultQuantity` من غير حد.
- `esp_car` بيستنى `<port>/remain` لتحريك الـ PWM، لكن السيرفر مابيبعتهاش.
- `dev_mode` حالة في الذاكرة: إعادة تشغيل السيرفر بتقفله.
