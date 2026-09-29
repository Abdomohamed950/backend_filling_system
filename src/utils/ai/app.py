import cv2
from ultralytics import YOLO
import paho.mqtt.client as mqtt

# إعدادات MQTT
MQTT_BROKER = "localhost"   # broker IP
MQTT_PORT = 1883
MQTT_TOPIC = "cam1/port1"

client = mqtt.Client()
client.connect(MQTT_BROKER, MQTT_PORT, 60)

# تحميل الموديل
model = YOLO(r"utils/ai/best.pt")

# رابط الكاميرا RTSP
rtsp_url = "rtsp://admin:ASDzxc_123@172.16.104.147:554/stream1"

# فتح الكاميرا
#cap = cv2.VideoCapture(rtsp_url)
cap = cv2.VideoCapture(0)

if not cap.isOpened():
    print("❌ لم يتم فتح رابط RTSP, تأكد من الرابط أو الكاميرا")
    exit()

while True:
    ret, frame = cap.read()
    if not ret:
        print("⚠️ لم أتمكن من قراءة فريم من الكاميرا، إعادة المحاولة...")
        continue

    # تشغيل الموديل على الفريم
    results = model.predict(frame, imgsz=640, verbose=False)

    frame_labels = []

    for box in results[0].boxes:
        cls_id = int(box.cls[0].item())
        conf = float(box.conf[0].item())      # confidence
        label = results[0].names[cls_id]      # class name

        print(f"Detected: {label} ({conf:.2f})")

        if conf > 0.90 and label == "Truck":
            frame_labels.append("Truck")

        elif conf > 0.85 and label == "waterpipe":
            frame_labels.append("waterpipe")

        elif conf > 0.85 and label == "filling":
            frame_labels.append("filling")

        elif conf > 0.70 and label == "filled":
            frame_labels.append("filled")
        else:
            print("No Objects")

    # إرسال رسالة MQTT لو فيه label
    if frame_labels:
        message = ",".join(frame_labels)
        client.publish(MQTT_TOPIC, message)
        print(f"MQTT sent: {message} -> {MQTT_TOPIC}")

    # عرض الفريم مع النتائج
    annotated_frame = results[0].plot()
    cv2.imshow('Detection', annotated_frame)

    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
client.disconnect()

