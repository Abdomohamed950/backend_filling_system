# إعداد باك إند الكاميرا — المطلوب من الواجهة

السيرفر بقى يشتغل على **Linux و macOS**. اختيار نوع الكاميرا بيتم من شاشة إعدادات الكاميرا الموجودة في dev_mode (نفس الشاشة اللي فيها `camId` و`camIndex`). التفاصيل الكاملة للـ events في [DEV_MODE.md](DEV_MODE.md) قسم 2.3.

## اللي اتضاف

### 1) حقل جديد في الإعدادات: `camBackend`

| الحقل | النوع | الافتراضي | القيم المسموحة |
|---|---|---|---|
| `camBackend` | string | `"auto"` | `"auto"` \| `"v4l2"` \| `"avfoundation"` \| `"any"` |

- `auto`: السيرفر يختار بنفسه (`v4l2` على Linux، `avfoundation` على macOS). ده الاختيار الصح في 99% من الحالات.
- `v4l2`: Linux فقط.
- `avfoundation`: macOS فقط.
- `any`: OpenCV يختار لوحده (احتياطي لو الاتنين مشغلوش).

بيتقرا من `dev_settings` وبيتبعت بـ `dev_set_settings` زي باقي الحقول (ممكن تبعته لوحده).

### 2) رد `dev_cameras` اتغيّر

```json
{
  "platform": "darwin",
  "backend": "avfoundation",
  "backends": ["auto", "v4l2", "avfoundation", "any"],
  "cameras": [
    { "index": 0, "device": "FaceTime HD Camera" },
    { "index": 1, "device": "USB Camera" }
  ]
}
```

| الحقل | الاستخدام |
|---|---|
| `platform` | نظام السيرفر: `linux` أو `darwin` (للعرض بس) |
| `backend` | الباك إند **الفعلي** المستخدم دلوقتي (يعني `auto` اتحوّل لإيه) |
| `backends` | القيم اللي تتحط في القايمة المنسدلة (متهاردكودهاش) |
| `cameras[].index` | القيمة اللي تتبعت في `camIndex` |
| `cameras[].device` | الاسم اللي يتعرض للمستخدم. على Linux هو `/dev/videoN`، وعلى macOS اسم الكاميرا |

> على macOS لو السيرفر ماقدرش يجيب الأسماء، بيرجع `Camera 0..3` كقايمة عامة والمستخدم يجرّب.

## المطلوب في الشاشة

1. **قايمة منسدلة "Camera backend"** من `backends`، والقيمة الحالية من `settings.camBackend`.
   - جنبها نص صغير: `الفعلي: {backend}` (مفيد لما تكون القيمة `auto`).
2. **قايمة اختيار الكاميرا** (اللي موجودة) من `cameras`: اعرض `device`، وابعت `index` في `camIndex`.
3. **زرار "تحديث القايمة"** يبعت `dev_list_cameras` تاني. وابعته كمان:
   - لما الشاشة تفتح.
   - بعد ما المستخدم يغيّر `camBackend` (لأن القايمة بتتغير بتغيّره).
4. **زرار "جرّب القراءة"** (اللي موجود) يبعت `dev_capture_plate`.

## ترتيب الـ events

```
فتح الشاشة:
  → dev_get_settings
  → dev_list_cameras
  ← dev_settings   { ..., camBackend: "auto", camIndex: 0 }
  ← dev_cameras    { platform, backend, backends, cameras }

المستخدم يغيّر الباك إند أو الكاميرا:
  → dev_set_settings { "camBackend": "avfoundation", "camIndex": 1 }
  ← dev_settings     (بيوصل لكل العملاء بالقيم الجديدة)
  → dev_list_cameras (علشان القايمة تتحدّث)
```

## ملاحظات مهمة

- لو dev_mode **شغال** وغيّرت أي إعداد كاميرا، السيرفر بيعيد تشغيل القارئ لوحده. فاعرض للمستخدم "جاري إعادة تشغيل الكاميرا..." لثواني.
- القيمة الغلط بترجع `dev_error`:
  ```json
  { "event": "dev_set_settings", "message": "camBackend must be one of: auto, v4l2, avfoundation, any" }
  ```
  اعرض `message` للمستخدم زي ما هي.
- التغيير محتاج توكن لو `AUTH_REQUIRED=true` (نفس باقي `dev_set_*`). القراءة (`dev_get_settings` و`dev_list_cameras`) مفتوحة.
- على macOS أول مرة بتشتغل الكاميرا، النظام بيطلب إذن الكاميرا للـ Terminal. لو الكاميرا مفتوحة ومفيش صورة، المشكلة غالباً الإذن، **مش** الواجهة. ممكن تحط تلميح بسيط تحت القايمة لما `platform === "darwin"`.
- ما تفترضش إن `camIndex` ثابت بين الأنظمة: على Linux هو رقم `/dev/videoN` (ممكن يبقى 0 و2 مثلاً)، وعلى macOS ترتيب الكاميرا. اعتمد دايماً على القايمة الراجعة من `dev_cameras`.
