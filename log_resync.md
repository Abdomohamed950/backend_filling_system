# إعادة مزامنة السجلات خلال فترة زمنية (`synchronize_log`)

## نظرة عامة

زرار **"مزامنه السجل"** في لوحة الأدمن بيعيد إرسال سجلات التعبئة المحفوظة محلياً (SQLite) إلى SQL Server عن فترة زمنية محددة.
الفكرة: **امسح أولاً كل قراءات الفترة من السيرفر، ثم أعد إدخالها من الجدول المحلي**، عشان ما يحصلش تكرار.

الملفات المعنية:

| الملف | الدالة | الدور |
|---|---|---|
| `src/admin_interface.py:302` | — | إنشاء زرار "مزامنه السجل" وربطه بـ `resend_log` |
| `src/admin_interface.py:947` | `resend_log` | قراءة الفترة من الواجهة والاتصال بالسيرفر |
| `src/database.py:356` | `synchronize_log` | الحذف ثم إعادة الإرسال |

## الخطوات بالترتيب

### 1. الواجهة (`resend_log`)

```python
def resend_log(self):
    start_date = self.start_date_entryy.dateTime().toString("yyyy-MM-dd HH:mm:ss")
    end_date = self.end_date_entryy.dateTime().toString("yyyy-MM-dd HH:mm:ss")
    server = SqlServerConnectionManager(local=self.local)
    server._create_new()
    if server._is_alive():
        print("time start: ", start_date)
        print("time end: ", end_date)
        server.synchronize_log(start_date, end_date)
```

- بتاخد تاريخ البداية والنهاية بصيغة `yyyy-MM-dd HH:mm:ss`.
- بتفتح اتصال جديد بـ SQL Server.
- لو الاتصال مش شغال مفيش أي حاجة بتحصل ولا فيه رسالة للمستخدم.

### 2. حذف القراءات القديمة من السيرفر (قبل أي إرسال)

أول حاجة بتحصل في `synchronize_log` هي استدعاء الـ stored procedure **`CarMovements_DeleteReadings`** على SQL Server:

```python
# src/database.py:356-367
def synchronize_log(self, start_date, end_date):
    conn, cursor = self.get_connection()
    if conn is None or cursor is None:
        print("Unable to connect to SQL Server")
        return

    try:
        sql = """EXEC [dbo].[CarMovements_DeleteReadings] @From = ?, @To = ?, @ChannelNumber = ?"""
        cursor.execute(sql, start_date, end_date, self.local.get_channel_entry(self.local.get_ports()[0][0])[0])
        conn.commit()
    except:
        return
```

**إزاي الحذف كان بيشتغل:**

- الـ procedure بتاخد 3 باراميترات:
  - `@From` = بداية الفترة.
  - `@To` = نهاية الفترة.
  - `@ChannelNumber` = رقم القناة (channel) على السيرفر.
- رقم القناة بيتجاب من أول بورت في الجدول المحلي:
  - `self.local.get_ports()[0][0]` ← اسم أول بورت.
  - `self.local.get_channel_entry(<port>)[0]` ← أول عنصر في الـ channel entry، وهو رقم قناة **رقم العربية** (`truck_number_chanel`).
- الحذف بيتم على السيرفر **بالكامل جوه الـ procedure**، والكود المحلي بس بينفذها ويعمل `commit`.
- الحذف بيتم **مرة واحدة قبل اللوب**، مش لكل سجل.
- لو حصل أي خطأ، الدالة بتخرج من غير ما تسجل خطأ (`except: return`)، فمفيش إرسال وبرضه مفيش رسالة.

> ملاحظة: كود الـ procedure نفسها (`CarMovements_DeleteReadings`) **مش موجود في المشروع**، هي معرّفة على SQL Server. اللي موجود في الكود هو استدعاؤها فقط. لازم نراجع تعريفها على السيرفر لو عايزين نعرف بالظبط أنهي جداول بتتمسح وبأي شرط.

### 3. جلب السجلات المحلية

```python
sql = "{CALL InsertReadings_CarMovement (?, ?, ?, ?)}"

records = self.local.range_log(start_date, end_date)
if not records:
    print("No logs to synchronize.")
    return
```

- `range_log` بتجيب سجلات SQLite في الفترة.
- لو مفيش سجلات بتخرج. لكن الحذف في الخطوة 2 يكون تم فعلاً، فبيانات الفترة تفضل ناقصة على السيرفر.

### 4. إعادة إدخال كل سجل

بيظهر `QProgressDialog` فيه زرار Cancel. وبعدين لكل سجل:

1. تجهيز القيم: المشغّل (`None` ← `"00"`، واسم ← ID بـ `get_operator_id`)، رقم العربية، رقم الإيصال، الكميات، قراءة العداد، وقتي الدخول والخروج، وقراءة العداد الابتدائية.
2. جلب `channel_entry` للبورت. لو مش 9 عناصر السجل بيتخطى مع log.
3. استدعاء `InsertReadings_CarMovement` داخل transaction:

```python
conn.autocommit = False
# 1) العربية → بترجع row_id (معرّف الحركة)
cursor.execute(sql, (int(truck_number_chanel), str(truck_number), None, None))
# ... nextset/fetchone للحصول على row_id

# 2) باقي الحقول مربوطة بنفس row_id
cursor.execute(sql, (int(operator_id_chanel), operator_id, row_id, None))
cursor.execute(sql, (int(receipt_number_chanel), receipt_number, row_id, None))
cursor.execute(sql, (int(required_quantity_chanel), required_quantity, row_id, None))
cursor.execute(sql, (int(actual_quantity_chanel), actual_quantity, row_id, None))
cursor.execute(sql, (int(in_time_chanel), entry_time, row_id, None))
cursor.execute(sql, (int(out_time_chanel), logout_time, row_id, None))

# 3) قراءة العداد النهائية → flow_id، ثم وقت الخروج مربوط بيها
cursor.execute(sql, (int(flowmeter_chanel), flow_meter_reading, None, None))
# ... nextset/fetchone للحصول على flow_id
cursor.execute(sql, (int(flow_time), logout_time, None, flow_id))

# 4) قراءة العداد الابتدائية (لو موجودة) + وقت الدخول
if start_flow_meter_reading is not None:
    cursor.execute(sql, (int(flowmeter_chanel), start_flow_meter_reading, None, None))
    # ... flow_id جديد
    cursor.execute(sql, (int(flow_time), entry_time, None, flow_id))
conn.commit()
```

- لو حصل خطأ في سجل: `rollback` للسجل ده بس ويكمل على اللي بعده.

## نقاط الضعف

- **الحذف والإرسال مش ذريين**: لو الحذف نجح والإرسال فشل أو اتلغى (زرار Cancel)، بيانات الفترة بتضيع من السيرفر جزئياً أو كلياً.
- **الحذف بيتم حتى لو مفيش سجلات محلية** للفترة.
- **أخطاء الحذف بتتبلع** (`except:` فاضية بدون log).
- **الحذف بيعتمد على أول بورت فقط** لتحديد `@ChannelNumber`.
- فشل سجلات فردية بيتسجل في log بس، والمستخدم مش بيتبلغ.

## الفرق عن الأزرار التانية

| الزرار | الدالة | بيمسح من السيرفر؟ |
|---|---|---|
| مزامنه السجل | `synchronize_log` | نعم (الفترة كلها) |
| إرسال السجلات غير المرسلة | `synchronize_data` | لا، بس بيبعت اللي `sync_status` بتاعه 0 |
| مزامنه الاجهزة | `esp_syncing` | لا، بيبعث MQTT `<port>/send_logs` للـ ESP |
