"""
dev_mode: يقرأ رقم العربية من الصورة الظاهرة على شاشة esp_car (OLED) عن طريق
كاميرا USB موصولة باللابتوب، ويبعته على MQTT. ملف منفصل عن ai.py (كاميرات RTSP).

يشغّله/يوقّفه السيرفر مع dev_mode (src/services/devMode.js)، ويتشغّل يدويًا
للتجربة:  python3 src/utils/ai/plate_reader.py

MQTT:
  <cam>/esp    "start" (من main_makit عند الزرار، أو dev_capture_plate من الواجهة)
               -> يلتقط ويقرأ
  <cam>/esp    "capture" (زرار "جرّب القراءة" في الواجهة) = نفس "start" لكن بيحفظ
               صورة الكاميرا الأول قبل الـ OCR ويبعت اسم الملف على <cam>/plate_image
  <cam>/plate  الرقم المقروء (digits فقط)، أو "" لو فشل القراءة (غير retained)

إعدادات (متغيرات بيئة):
  MQTT_URL           mqtt://localhost:1883 (نفس متغير السيرفر)
  DEV_CAM_ID         cam1
  DEV_CAM_INDEX      0         رقم جهاز الكاميرا (/dev/videoN على Linux، index على macOS)
  DEV_CAM_BACKEND    auto      auto | v4l2 | avfoundation | any  (auto = حسب النظام)
  DEV_PLATE_DIGITS   4         عدد الخانات المتوقع (esp_car بيعرض 4 أرقام)
  DEV_PLATE_ROI      x,y,w,h   اختياري، كنسب 0..1 من الصورة لتضييق القراءة على الشاشة
  DEV_PLATE_FRAMES   5         عدد الفريمات اللي بيتصوّت عليها (الـ OLED بيرتعش)
  DEV_PLATE_DEBUG    مسار مجلد لحفظ الفريمات للمعايرة (اختياري)
  DEV_OCR_GPU        auto    auto = GPU لو CUDA متاح | 1 = GPU (CUDA أو Apple MPS) | 0 = CPU
  DEV_PLATE_MAX_SIDE 800     أكبر ضلع للصورة قبل الـ OCR (تصغير = أسرع)
  DEV_PLATE_CAPTURES مسار مجلد لحفظ صورة "جرّب القراءة" قبل الـ OCR (اختياري)
"""

import os
import re
import sys
import time
import threading
from collections import Counter
from urllib.parse import urlparse

import cv2
import numpy as np
import easyocr
import paho.mqtt.client as mqtt

CAM_ID = os.environ.get("DEV_CAM_ID", "cam1")
CAM_INDEX = int(os.environ.get("DEV_CAM_INDEX", "0"))
CAM_BACKEND = os.environ.get("DEV_CAM_BACKEND", "auto").lower()
DIGITS = int(os.environ.get("DEV_PLATE_DIGITS", "4"))
FRAMES = int(os.environ.get("DEV_PLATE_FRAMES", "5"))
DEBUG_DIR = os.environ.get("DEV_PLATE_DEBUG", "")
CAPTURES_DIR = os.environ.get("DEV_PLATE_CAPTURES", "")
MAX_CAPTURES = 50  # أقدم صور بتتمسح عشان المجلد ما يكبرش
ROI = None
if os.environ.get("DEV_PLATE_ROI"):
    ROI = tuple(float(v) for v in os.environ["DEV_PLATE_ROI"].split(","))

_url = urlparse(os.environ.get("MQTT_URL", "mqtt://localhost:1883"))
MQTT_HOST = _url.hostname or "localhost"
MQTT_PORT = _url.port or 1883

TOPIC_TRIGGER = f"{CAM_ID}/esp"
TOPIC_RESULT = f"{CAM_ID}/plate"
TOPIC_IMAGE = f"{CAM_ID}/plate_image"



def capture_backend():
    """باك إند OpenCV المناسب: V4L2 على Linux، AVFoundation على macOS."""
    if CAM_BACKEND == "auto":
        if sys.platform == "darwin":
            return cv2.CAP_AVFOUNDATION
        if sys.platform.startswith("linux"):
            return cv2.CAP_V4L2
        return cv2.CAP_ANY
    return {
        "v4l2": cv2.CAP_V4L2,
        "avfoundation": cv2.CAP_AVFOUNDATION,
    }.get(CAM_BACKEND, cv2.CAP_ANY)


MAX_SIDE = int(os.environ.get("DEV_PLATE_MAX_SIDE", "800"))
CONF_OK = 0.6  # ثقة كفاية لقبول القراءة من أول محاولة من غير المعالجة التانية


def use_gpu():
    mode = os.environ.get("DEV_OCR_GPU", "auto").lower()
    if mode in ("0", "false", "off"):
        return False
    if mode in ("1", "true", "on"):
        return True
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:
        return False


reader = easyocr.Reader(["en"], gpu=use_gpu())

latest = None
latest_lock = threading.Lock()
running = True


def grab_loop():
    """يفضل قارئ الكاميرا شغال عشان ما نقرأش فريم قديم من الـ buffer."""
    global latest
    cap = None
    while running:
        if cap is None or not cap.isOpened():
            cap = cv2.VideoCapture(CAM_INDEX, capture_backend())
            cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
            cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
            if not cap.isOpened():
                print(f"❌ camera {CAM_INDEX} not available, retrying...", flush=True)
                time.sleep(2)
                continue
            print(f"📷 camera {CAM_INDEX} open", flush=True)
        ok, frame = cap.read()
        if not ok or frame is None:
            cap.release()
            cap = None
            time.sleep(0.5)
            continue
        with latest_lock:
            latest = frame
    if cap is not None:
        cap.release()


def crop_roi(frame):
    if not ROI:
        return frame
    h, w = frame.shape[:2]
    x, y, rw, rh = ROI
    return frame[int(y * h):int((y + rh) * h), int(x * w):int((x + rw) * w)]


def preprocess(img):
    h, w = img.shape[:2]
    # بنكبّر بس لو الصورة صغيرة (ROI ضيق)؛ الصورة الكبيرة أصلاً مش محتاجة تكبير
    short = max(1, min(h, w))
    if short < 200:
        scale = -(-300 // short)  # ceil
        img = cv2.resize(img, (w * scale, h * scale), interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # شاشة OLED: أرقام فاتحة على خلفية غامقة
    if np.mean(gray) < 127:
        gray = cv2.bitwise_not(gray)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return binary


def shrink(img):
    """بيصغّر الصورة لو أكبر ضلع فيها أكبر من MAX_SIDE (سرعة الـ OCR بتتناسب مع المساحة)."""
    h, w = img.shape[:2]
    big = max(h, w)
    if MAX_SIDE <= 0 or big <= MAX_SIDE:
        return img
    f = MAX_SIDE / big
    return cv2.resize(img, (int(w * f), int(h * f)), interpolation=cv2.INTER_AREA)


def read_digits(img):
    """(الرقم، الثقة) أو (None, 0). بيجمّع الأجزاء اللي EasyOCR بيقسمها يمين/شمال.
    بيجرّب الصورة الأصلية الأول، ومش بيعمل المعالجة التانية لو القراءة الأولى واثقة."""
    img = shrink(img)
    best = (None, 0.0)
    for make in (lambda: img, lambda: preprocess(img)):
        parts = reader.readtext(make(), detail=1, allowlist="0123456789")
        parts.sort(key=lambda p: p[0][0][0])  # من الشمال لليمين
        text = "".join(re.sub(r"\D", "", p[1]) for p in parts)
        if len(text) != DIGITS or not parts:
            continue
        conf = sum(p[2] for p in parts) / len(parts)
        if conf > best[1]:
            best = (text, conf)
        if best[1] >= CONF_OK:
            break
    return best


def save_capture(client):
    """يحفظ فريم الكاميرا الحالي (كامل + ROI) قبل الـ OCR ويبعت اسم الملف."""
    if not CAPTURES_DIR:
        return
    frame = None
    for _ in range(25):  # استنى أول فريم لو الكاميرا لسه بتفتح
        with latest_lock:
            frame = None if latest is None else latest.copy()
        if frame is not None:
            break
        time.sleep(0.2)
    if frame is None:
        return
    os.makedirs(CAPTURES_DIR, exist_ok=True)
    name = f"{int(time.time() * 1000)}.jpg"
    cv2.imwrite(os.path.join(CAPTURES_DIR, name), frame)
    if ROI:
        cv2.imwrite(os.path.join(CAPTURES_DIR, name.replace(".jpg", "_roi.jpg")), crop_roi(frame))
    old = sorted(f for f in os.listdir(CAPTURES_DIR) if f.endswith(".jpg") and not f.endswith("_roi.jpg"))
    for f in old[:-MAX_CAPTURES]:
        for victim in (f, f.replace(".jpg", "_roi.jpg")):
            try:
                os.remove(os.path.join(CAPTURES_DIR, victim))
            except OSError:
                pass
    client.publish(TOPIC_IMAGE, name, qos=1, retain=False)
    print(f"📸 saved {name}", flush=True)


def capture_and_read():
    votes = Counter()
    conf_sum = Counter()
    started = time.time()
    need = FRAMES // 2 + 1  # أغلبية: مفيش داعي نكمّل بعد ما رقم ياخد أغلبية الفريمات
    for i in range(FRAMES):
        with latest_lock:
            frame = None if latest is None else latest.copy()
        if frame is None:
            time.sleep(0.2)
            continue
        roi = crop_roi(frame)
        if DEBUG_DIR:
            os.makedirs(DEBUG_DIR, exist_ok=True)
            cv2.imwrite(os.path.join(DEBUG_DIR, f"{int(time.time())}_{i}.jpg"), roi)
        number, conf = read_digits(roi)
        if number:
            votes[number] += 1
            conf_sum[number] += conf
        if votes and max(votes.values()) >= need:
            break
        time.sleep(0.15)  # فريمات مختلفة بدل نفس الفريم

    print(f"⏱️ OCR {time.time() - started:.1f}s ({i + 1}/{FRAMES} frames)", flush=True)
    if not votes:
        return None
    # الأكتر تكرارًا، وعند التعادل الأعلى ثقة
    return max(votes, key=lambda n: (votes[n], conf_sum[n]))


busy = threading.Lock()


def handle_trigger(client, save=False):
    if not busy.acquire(blocking=False):
        return  # قراءة جارية بالفعل
    try:
        if save:
            save_capture(client)
        number = capture_and_read()
        client.publish(TOPIC_RESULT, number or "", qos=1, retain=False)
        print(f"🔢 {TOPIC_RESULT}: {number or '(not read)'}", flush=True)
    finally:
        busy.release()


def on_connect(client, userdata, flags, reason_code, properties=None):
    print(f"✅ MQTT connected ({MQTT_HOST}:{MQTT_PORT})", flush=True)
    client.subscribe(TOPIC_TRIGGER, qos=1)


def on_message(client, userdata, msg):
    cmd = msg.payload.decode(errors="ignore").strip()
    if msg.retain or cmd not in ("start", "capture"):
        return
    threading.Thread(target=handle_trigger, args=(client, cmd == "capture"), daemon=True).start()


def main():
    global running
    threading.Thread(target=grab_loop, daemon=True).start()

    # paho 2.x محتاج callback_api_version؛ 1.x ما يعرفهوش
    if hasattr(mqtt, "CallbackAPIVersion"):
        client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2)
    else:
        client = mqtt.Client()
    client.on_connect = on_connect
    client.on_message = on_message
    client.connect(MQTT_HOST, MQTT_PORT, 60)
    try:
        client.loop_forever()
    except KeyboardInterrupt:
        pass
    finally:
        running = False


if __name__ == "__main__":
    sys.exit(main())
