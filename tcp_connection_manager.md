# شرح `ScadaClient` / `scadaSync` والجداول المرتبطة بيهم (Node.js)

> توثيق تقني لكود مزامنة SCADA (TCP) في المشروع الحالي (Node.js):
> [`ScadaClient`](src/transport/scada.js#L18) (طبقة النقل الخام) + [`scadaSync.js`](src/services/scadaSync.js) (منطق البروتوكول).
> ده تحديث لملف قديم كان بيوثّق نسخة Python (`database.py: TcpConnectionManager`) — النسخة القديمة دي **مش موجودة في المشروع ده أصلاً**. للتفاصيل الكاملة عن السيرفرين الخارجيين وباقي المزامنة (Receipt API + الباركود)، شوف [`sync_and_barcode.md`](sync_and_barcode.md) (ملاحظة: هو كمان لسه بيشاور على أسماء الملفات القديمة في بعض الأماكن). لعقد الـ REST API الخاص بشاشات الإعدادات، شوف [`sync_barcode_frontend.md`](sync_barcode_frontend.md).

---

## 1. إيه هو `ScadaClient`؟

كلاس مسؤول عن **الاتصال المباشر (Raw TCP Socket)** بجهاز/سيرفر SCADA خارجي، عنوانه وبورته بيتقروا من جدول `sync_settings` (مش ثابتين في الكود زي القديم):

```
host = sync_settings.scadaHost   (افتراضي 197.134.251.84)
port = sync_settings.scadaPort   (افتراضي 11001)
```

مش بيتكلم HTTP ولا SQL — بيبعت نصوص خام على الشكل:

```
P <channel_id> <value> <row_id_or_flow_id>\n
```

وبيستقبل سطر رد واحد (عادة `row_id` أو `flow_id` رقمي) عن طريق [`sendReceive()`](src/transport/scada.js#L137).

الكلاس نفسه **مالوش أي منطق بروتوكول أو وصول لقاعدة بيانات** — هو طبقة نقل (transport) بحتة، مبني على `net.Socket` غير متزامن (event-based، مش blocking زي Python القديم). كل منطق "إيه اللي يتبعت وعلى أنهي قناة" موجود في [`scadaSync.js`](src/services/scadaSync.js) اللي بيستخدم `ScadaClient` كأداة بس.

| المسؤولية | الدالة (في `ScadaClient`) |
|---|---|
| فحص/فتح الاتصال | [`isAlive()`](src/transport/scada.js#L33) · [`connect()`](src/transport/scada.js#L41) · [`_createNew()`](src/transport/scada.js#L65) |
| إعادة الاتصال / القفل | [`reconnect()`](src/transport/scada.js#L168) · [`close()`](src/transport/scada.js#L173) |
| قراءة الرد (line-buffering على الـ stream) | [`_attachSocket()`](src/transport/scada.js#L100) · [`_onData()`](src/transport/scada.js#L111) · [`_onClose()`](src/transport/scada.js#L127) |
| إرسال/استقبال رسالة واحدة (متسلسل، طلب واحد بس في نفس اللحظة) | [`sendReceive()`](src/transport/scada.js#L137) · [`_sendReceiveOnce()`](src/transport/scada.js#L142) |
| Circuit breaker (وقف إعادة المحاولة 30 ثانية بعد فشل) | [`_inCooldown()`](src/transport/scada.js#L37) |

> **فرق مهم عن القديم:** `_txChain` (سطر [138](src/transport/scada.js#L138)) بيعمل نفس دور `self._tx_lock` القديم — كل نداء لـ `sendReceive` بينضم في طابور Promise واحد، فمفيش إرسالين في نفس اللحظة على نفس الـ socket، لكن هنا بشكل غير متزامن (async chain) مش lock حقيقي.

> **Circuit breaker جديد (مش موجود في القديم):** لو الاتصال فشل، `_lastFailureAt` بيتسجّل وأي محاولة اتصال جديدة لمدة 30 ثانية (`COOLDOWN_MS`) بترجع فورًا من غير محاولة فعلية ولا تكرار في اللوج — ده حل لمشكلة "تغريق اللوج بمحاولات إعادة اتصال كل ثانية" الموثّقة في `sync_and_barcode.md`.

---

## 2. `scadaSync.js` — منطق البروتوكول (مقابل الدوال القديمة)

| القديم (`database.py`) | الجديد (`scadaSync.js`) | الوظيفة |
|---|---|---|
| `send_readings_1` | [`sendReadings1(historyId)`](src/services/scadaSync.js#L45) | بداية تعبئة: يبعت `truckCh` الأول وياخد `row_id` من الرد، وبعدين `operatorCh/requiredCh/receiptCh/inTimeCh` مرتبطين بيه، وأخيرًا `flowmeterCh` (قراءة ابتدائية) و`flowTimeCh` |
| `send_readings_2` | [`sendReadings2(historyId)`](src/services/scadaSync.js#L100) | نهاية تعبئة: `actualCh`, `outTimeCh`, وقراءة `flowmeterCh` النهائية + `flowTimeCh` |
| `synchronize_data` | [`synchronizeBacklog()`](src/services/scadaSync.js#L154) | بتتنادى مرة واحدة عند إقلاع السيرفر — بتبعت `sendReadings2` لكل سجل مقفول لسه مش متزامن |
| (مش موجودة) | [`invalidateClient()`](src/services/scadaSync.js#L21) | تُنادى بعد أي تعديل على `sync_settings` من الـ UI، عشان الاتصال القديم يتقفل ويتعاد إنشاؤه بالعنوان الجديد **فورًا**، من غير ما يحتاج إعادة تشغيل السيرفر (خلافًا للقديم) |

**فرق سلوك مقصود ومهم:** كل دالة في `scadaSync.js` بتبتلع أخطاءها بالكامل عن طريق [`run()`](src/services/scadaSync.js#L185) (wrapper بيمسك أي exception ويسجّله باللوج بس). النداء من [`fillingSessions.js`](src/services/fillingSessions.js) هو **fire-and-forget** (`.catch()` بس، مفيش `await` لنتيجته وقفل السيشن) — يعني مزامنة SCADA **أبدًا** متأخرش أو توقف فتح/قفل سجل تعبئة محلي حقيقي، حتى لو السيرفر مقفول تمامًا (وهو فعلاً كذلك حاليًا).

---

## 3. الجداول اللي بيستخدمها

### أ) `sync_settings` — إعدادات الاتصال (صف واحد ثابت، `id = 1`)

```sql
CREATE TABLE sync_settings (
    id                    INTEGER PRIMARY KEY CHECK (id = 1),
    scadaEnabled          INTEGER NOT NULL DEFAULT 1,
    scadaHost             TEXT    NOT NULL DEFAULT '197.134.251.84',
    scadaPort             INTEGER NOT NULL DEFAULT 11001,
    receiptApiEnabled     INTEGER NOT NULL DEFAULT 1,
    receiptApiBaseUrl     TEXT    NOT NULL DEFAULT 'http://172.16.0.99:8090/KorapTmp',
    receiptRefreshMinutes INTEGER NOT NULL DEFAULT 60,
    updatedAt             TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
)
```

| | Backend | Frontend (Admin) |
|---|---|---|
| **بيتقرا في** | [`SyncSettings.get()`](src/models/syncSettingsModel.js#L5) — بينادى في أول كل `sendReadings1/2` و`synchronizeBacklog` عشان يشيك `scadaEnabled` ويجيب `host/port` | `GET /api/sync-settings` عبر [`getSettings()`](src/controllers/syncSettingsControllers.js#L5) — أي مستخدم مسجّل (`requireAuth`) |
| **بيتكتب من** | [`SyncSettings.update()`](src/models/syncSettingsModel.js#L10) — `UPDATE` جزئي (`COALESCE`) | `PUT /api/sync-settings` عبر [`updateSettings()`](src/controllers/syncSettingsControllers.js#L15) — أدمن بس (`requireAdmin`) |

> ⚠️ لو `scadaEnabled = 0`، `sendReadings1/2` و`synchronizeBacklog` بترجع فورًا من غير أي محاولة اتصال.
> ✅ خلافًا للنظام القديم: تغيير `scadaHost`/`scadaPort` من شاشة الإعدادات **بيتفعّل فورًا** — الـ controller بينادي [`scadaSync.invalidateClient()`](src/controllers/syncSettingsControllers.js#L37) بعد كل `PUT`، فالاتصال الجاي هيستخدم العنوان الجديد.

### ب) `scada_channels` — خريطة (منفذ ⇄ رقم قناة على السيرفر الخارجي)

```sql
CREATE TABLE scada_channels (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    portNum     TEXT    NOT NULL UNIQUE REFERENCES ports_setting(name) ON UPDATE CASCADE,
    truckCh     TEXT,
    operatorCh  TEXT,
    requiredCh  TEXT,
    receiptCh   TEXT,
    inTimeCh    TEXT,
    flowmeterCh TEXT,
    flowTimeCh  TEXT,
    actualCh    TEXT,
    outTimeCh   TEXT
)
```

كل صف = منفذ (port) واحد، وكل عمود = **رقم القناة** على سيرفر الـ SCADA اللي المفروض تتبعت له كل قيمة (مش القيمة نفسها). `portNum` مربوط بـ `ports_setting.name` بـ Foreign Key حقيقي (مش موجود في القديم).

| | Backend | Frontend (Admin) |
|---|---|---|
| **بيتقرا في** | [`ScadaChannels.findByPort(portNum)`](src/models/scadaChannelsModel.js#L10) — بينادى جوّه [`sendReadings1`](src/services/scadaSync.js#L53) و[`sendReadings2`](src/services/scadaSync.js#L108) **في كل مزامنة** عشان يعرف يبعت القيمة على أنهي قناة | `GET /api/scada-channels/:portNum` |
| | [`ScadaChannels.findAll()`](src/models/scadaChannelsModel.js#L5) | `GET /api/scada-channels` — شاشة القنوات في الأدمن |
| **بيتكتب من** | [`ScadaChannels.upsert(portNum, fields)`](src/models/scadaChannelsModel.js#L19) — INSERT أو UPDATE (`ON CONFLICT`) | `PUT /api/scada-channels/:portNum` (أدمن بس) |
| **بيتمسح من** | [`ScadaChannels.delete(portNum)`](src/models/scadaChannelsModel.js#L65) | `DELETE /api/scada-channels/:portNum` (أدمن بس) |

المسارات موجودة في [`scadaChannelsRoutes.js`](src/routes/scadaChannelsRoutes.js)، والـ controller في [`scadaChannelsControllers.js`](src/controllers/scadaChannelsControllers.js).

> ⚠️ لو `findByPort` رجعت `null` (مفيش خريطة قنوات لمنفذ معيّن)، `sendReadings1`/`sendReadings2` بتوقف فورًا وتسجّل تحذير (`⚠️ SCADA: لا توجد خريطة قنوات للمنفذ ...`) — نفس فكرة "توقف الإرسال بالكامل لهذا المنفذ" في القديم، لكن هنا بتحذير مش خطأ فادح، وبتبتلعه `run()` فمفيش تأثير على السجل المحلي.
> كل عمود قناة اختياري: لو `channels.actualCh` أو أي عمود تاني فاضي (`null`)، الحقل المرتبط بيه ببساطة **متبعتش** (مفيش خطأ)، شوف الشرط `if (!ch || ...) continue` في [`sendReadings1`](src/services/scadaSync.js#L78) والشروط المشابهة في [`sendReadings2`](src/services/scadaSync.js#L125).

### ج) `history` — سجل كل عملية تعبئة (المصدر الرئيسي للبيانات المُرسَلة)

الأعمدة المتعلقة بمزامنة SCADA بس (باقي الأعمدة في جدول `history` الكامل تخص التعبئة نفسها، مش موضوع الملف ده):

```sql
-- أعمدة SCADA (أُضيفت لجدول history عبر migration، schema.js)
scadaRowId  TEXT     -- الـ row_id الراجع من أول رسالة (truckCh) في sendReadings1
scadaFlowId TEXT     -- الـ flow_id الراجع من رسالة flowmeterCh
scadaSynced INTEGER  -- NULL = لسه مش متزامن كامل، 1 = اتزامن (يقابل logs.state القديم)
```

| | Backend | Frontend |
|---|---|---|
| **بيتقرا في** | `findHistoryById(id)` (استعلام مباشر [`SELECT * FROM history WHERE id = $1`](src/services/scadaSync.js#L180)) — بينادى في أول `sendReadings1`/`sendReadings2` | مفيش قراءة مباشرة من واجهة الأدمن لأعمدة `scada*` تحديدًا |
| | [`History.findUnsyncedClosed()`](src/models/historyModel.js#L258) — `WHERE scadaSynced IS NULL AND exitTime IS NOT NULL` | بتتنادى مرة واحدة وقت بدء التطبيق في [`app.js:82`](src/app.js#L82) عبر `synchronizeBacklog` |
| **بيتكتب من** | [`History.insert_1()`](src/models/historyModel.js) — فتح سجل جديد | يُستدعى من [`fillingSessions.js`](src/services/fillingSessions.js) لحظة فتح تعبئة — **قبل** ما ينادي `sendReadings1` (سطر [251](src/services/fillingSessions.js#L251)) |
| | [`History.setScadaRowId(id, rowId)`](src/models/historyModel.js#L233) | بينادى **من جوّه** `scadaSync.sendReadings1` نفسه — بعد أول رد صالح من السيرفر |
| | [`History.setScadaFlowId(id, flowId)`](src/models/historyModel.js#L241) | بينادى من جوّه `sendReadings1`/`sendReadings2` بعد رد `flowmeterCh` صالح |
| | [`History.closeById()`](src/models/historyModel.js) | يُستدعى من `fillingSessions.js` لحظة قفل المنفذ — **قبل** ما ينادي `sendReadings2` (سطر [329](src/services/fillingSessions.js#L329)) |
| | [`History.markScadaSynced(id)`](src/models/historyModel.js#L249) | بينادى **من جوّه** `sendReadings2` بعد نجاح الإرسال الكامل — ده اللي بيوقف إعادة المحاولة |

**ملاحظة مهمة:** `history.scadaSynced` هو **آلية إعادة المحاولة الوحيدة**، بالضبط زي `logs.state` القديم. أي سجل يفضل `scadaSynced = NULL` لحد ما `sendReadings2` (مباشرة أو عبر `synchronizeBacklog`) ينجح وينادي `markScadaSynced`.

> **فرق عن القديم:** بدل عمود واحد `row_id`، هنا عمودين منفصلين `scadaRowId` و`scadaFlowId` (لأن `truckCh` و`flowmeterCh` كل واحد بيرجع معرّف مستقل يتلزّق بيه باقي الرسائل المرتبطة بيه).

### د) جداول مرتبطة بشكل غير مباشر

| الجدول | مين بيستخدمه | العلاقة بـ TCP |
|---|---|---|
| `ports_setting` | [`portsSettingModel.js`](src/models/portsSettingModel.js) | مش بيتقرا مباشرة من `scadaSync.js`، لكن `scada_channels.portNum` مربوط بيه بـ Foreign Key — يعني مينفعش تعمل خريطة قنوات لمنفذ مش موجود في `ports_setting` (بيرجع `400` من [`upsertByPort`](src/controllers/scadaChannelsControllers.js#L38)) |
| `operator` | — | القديم كان بيحوّل اسم الأوبريتور لكود قبل الإرسال (`get_operator_id` في `synchronize_data`). **الكود الحالي مبيعملش الخطوة دي** — `history.operatorId` بيتبعت زي ما هو (رقم الـ FK) في `operatorCh` من غير أي تحويل إضافي |

---

## 4. مين بينادي مين — خريطة كاملة (Frontend → Backend → TCP)

```mermaid
flowchart LR
    subgraph Frontend[Admin UI]
        AI_CH["شاشة قنوات SCADA<br/>GET/PUT/DELETE /api/scada-channels"]
        AI_SS["شاشة إعدادات المزامنة<br/>GET/PUT /api/sync-settings"]
    end

    subgraph Device[جهاز التعبئة]
        FS["fillingSessions.js<br/>فتح/قفل سجل تعبئة"]
    end

    subgraph Backend[Node.js]
        SS[scadaSync.js]
        SC["ScadaClient<br/>transport/scada.js"]
    end

    subgraph DB[SQLite]
        T_hist[(history)]
        T_ch[(scada_channels)]
        T_settings[(sync_settings)]
        T_ports[(ports_setting)]
    end

    FS -- "History.insert_1() ثم sendReadings1(id)" --> SS
    FS -- "History.closeById() ثم sendReadings2(id)" --> SS
    SS -- "get / setScadaRowId / setScadaFlowId / markScadaSynced" --> T_hist

    "بدء تشغيل السيرفر (app.js)" -- "synchronizeBacklog()" --> SS
    SS -- "findUnsyncedClosed" --> T_hist

    SS -- "findByPort (كل رسالة)" --> T_ch
    SS -- "SyncSettings.get (كل مزامنة)" --> T_settings

    SC == "P channel_id value row_id\n" ==> SCADA[["سيرفر SCADA / host:port من sync_settings<br/>(افتراضي :11001)"]]
    SS -- "sendReceive عبر" --> SC

    AI_CH -- "upsert / delete" --> T_ch
    AI_CH -. "FK: portNum" .-> T_ports
    AI_SS -- "update" --> T_settings
    AI_SS -- "invalidateClient()" --> SC
```

---

## 5. خلاصة سريعة

- **`ScadaClient` نفسه بلا أي منطق بروتوكول** — مجرد transport على `net.Socket` مع circuit breaker (كولداون 30 ثانية) وطابور إرسال متسلسل (`_txChain`).
- **`scadaSync.js`** هو المعادل الكامل لدوال `TcpConnectionManager` القديمة (`send_readings_1/2`, `synchronize_data`) — وبيضيف عليها: تسامح كامل مع الأخطاء (fire-and-forget)، وإعادة بناء الاتصال فورًا عند تغيير الإعدادات (`invalidateClient`).
- **`sync_settings`** = مكان الـ `host`/`port`/`enabled` — قابل للتعديل من الأدمن **وبيتفعّل فورًا** (خلافًا لجدول `addresses` القديم اللي كان محتاج إعادة تشغيل).
- **`scada_channels`** = "على أنهي رقم قناة يتبعت كل حقل" لكل منفذ — بيتعدّل من شاشة الأدمن، مربوط بـ Foreign Key حقيقي بـ `ports_setting`، وأي عمود فاضي فيه يبقى معناه "الحقل ده متبعتش" (مش خطأ).
- **`history.scadaRowId` / `scadaFlowId` / `scadaSynced`** = بديل `logs.row_id`/`logs.state` القديم — `scadaSynced` هو آلية إعادة المحاولة الوحيدة.
- **`fillingSessions.js`** هو المصدر لكل استدعاءات الإرسال الفعلي (`sendReadings1/2`) عند فتح/قفل سجل تعبئة حقيقي، ومزامنة SCADA أبدًا مبتأثرش على هذا السجل حتى لو السيرفر الخارجي مقفول بالكامل (وهو فعلاً كذلك حاليًا).
