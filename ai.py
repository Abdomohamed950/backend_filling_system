import os, cv2, time, threading, torch, signal, sys
from ultralytics import YOLO
import paho.mqtt.client as mqtt
import easyocr
import re
import numpy as np

positions = {
    "port1": (0, 200),
    "port2": (1550, 200),
}

IMG_SIZE = 768
DISPLAY_SCALE = 0.5

MQTT_BROKER = "localhost"
MQTT_PORT = 1883

COLOR_MAP = {
    "truck": (255, 165, 0),
    "filling": (0, 255, 255),
    "filled": (0, 0, 255),
}

os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp|stimeout;5000000"

reader = easyocr.Reader(['en'], gpu=False)

# ── detect if display is available ──
# macOS/Windows مفيهمش DISPLAY (X11) بس عندهم شاشة؛ DISPLAY بيتفحص على Linux بس
HEADLESS = sys.platform.startswith("linux") and os.environ.get("DISPLAY", "") == ""


def preprocess_for_ocr(crop):
    h, w = crop.shape[:2]
    scale = max(3, 300 // min(h, w) + 1)
    upscaled = cv2.resize(crop, (w * scale, h * scale), interpolation=cv2.INTER_CUBIC)
    gray = cv2.cvtColor(upscaled, cv2.COLOR_BGR2GRAY)
    mean_val = np.mean(gray)
    if mean_val < 127:
        gray = cv2.bitwise_not(gray)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(4, 4))
    gray = clahe.apply(gray)
    gray = cv2.fastNlMeansDenoising(gray, h=15)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return binary


def extract_number_from_box(frame, box_xyxy):
    h_frame, w_frame = frame.shape[:2]
    x1, y1, x2, y2 = map(int, box_xyxy)
    box_h = y2 - y1
    box_w = x2 - x1
    expand_up = int(box_h * 2.0)
    expand_side = int(box_w * 0.5)
    crop_x1 = max(0, x1 - expand_side)
    crop_x2 = min(w_frame, x2 + expand_side)
    crop_y1 = max(0, y1 - expand_up)
    crop_y2 = y2
    crop = frame[crop_y1:crop_y2, crop_x1:crop_x2]
    if crop.size == 0:
        return None
    processed = preprocess_for_ocr(crop)
    results_raw = reader.readtext(crop, detail=1, allowlist='0123456789')
    results_proc = reader.readtext(processed, detail=1, allowlist='0123456789')
    best_number = None
    best_conf = 0.0
    for results in [results_raw, results_proc]:
        for (bbox, text, conf) in results:
            clean = re.sub(r'[^\d]', '', text)
            if clean and conf > best_conf:
                best_conf = conf
                best_number = clean
    return best_number if best_number else None


def extract_number_fullframe_fallback(frame):
    h, w = frame.shape[:2]
    crop = frame[:int(h * 0.7), :]
    resized = cv2.resize(crop, (800, 600))
    results = reader.readtext(resized, detail=1, allowlist='0123456789')
    best_number = None
    best_conf = 0.0
    for (bbox, text, conf) in results:
        clean = re.sub(r'[^\d]', '', text)
        if len(clean) >= 2 and conf > best_conf:
            best_conf = conf
            best_number = clean
    return best_number


class Camera:
    def __init__(self, cam_id, rtsp_url, model, device):

        # =========================
        # Camera info
        # =========================
        self.cam_id = cam_id
        self.rtsp_url = rtsp_url
        self.model = model
        self.device = device

        # =========================
        # Detection / state logic
        # =========================
        self.last_sent = None

        self.filled_confirm_count = 0
        self.FILLED_CONFIRM_FRAMES = 5

        self.idle_count = 0
        self.IDLE_RESET_FRAMES = 6

        # cycle flags
        self.filling_done = False       # filling already happened for this truck
        self.block_filling = False      # blocks filling until idle reset
        self.cycle_state = "idle"       # idle → truck → filling → filled → idle

        # =========================
        # Frame handling
        # =========================
        self.latest_frame = None
        self.lock = threading.Lock()
        self.running = True

        self.display_frame = None
        self.display_lock = threading.Lock()

        # =========================
        # MQTT
        # =========================
        self.mqtt = mqtt.Client(
            callback_api_version=mqtt.CallbackAPIVersion.VERSION2
        )

        self.mqtt.on_connect = self.on_connect
        self.mqtt.connect(MQTT_BROKER, MQTT_PORT, 60)
        self.mqtt.loop_start()

        self.topic = f"{cam_id}/cam"

    def on_connect(self, client, userdata, flags, reason_code, properties):
        print(f"✅ {self.cam_id} MQTT connected:", reason_code)

    def open_camera(self):
        cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        return cap

    def capture(self):
        cap = None
        retry = 0.5
        is_file = isinstance(self.rtsp_url, str) and self.rtsp_url.endswith(".mp4")

        while self.running:
            if cap is None or not cap.isOpened():
                cap = self.open_camera()
                if not cap.isOpened():
                    time.sleep(retry)
                    retry = min(retry * 2, 5)
                    continue
                retry = 0.5

            ok, frame = cap.read()

            if not ok or frame is None:
                if is_file:
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    continue
                cap.release()
                cap = None
                time.sleep(retry)
                retry = min(retry * 2, 5)
                continue

            frame = cv2.resize(frame, (480, 270))
            with self.lock:
                self.latest_frame = frame

    def filter_boxes(self, r):
        labels = []
        for box in r.boxes:
            cls = int(box.cls[0])
            conf = float(box.conf[0])
            name = r.names[cls].lower()
            if name == "truck" and conf >= 0.5:
                labels.append(("truck", box))
            elif name == "filling" and conf >= 0.5:
                labels.append(("filling", box))
            elif name == "filled" and conf >= 0.70:
                labels.append(("filled", box))
        return labels

    def infer(self):
        while self.running:
            with self.lock:
                frame = None if self.latest_frame is None else self.latest_frame.copy()

            if frame is None:
                time.sleep(0.01)
                continue

            results = self.model.predict(
                frame,
                imgsz=IMG_SIZE,
                device=self.device,
                half=False,
                conf=0.25,
                verbose=False
            )

            r = results[0]
            labeled_boxes = self.filter_boxes(r)
            label_names = [lb[0] for lb in labeled_boxes]

            has_truck = "truck" in label_names
            has_filling = "filling" in label_names
            has_filled = "filled" in label_names

            # ── idle counter ──
            if not has_truck and not has_filling and not has_filled:
                self.idle_count += 1
            else:
                self.idle_count = 0

            # ── idle reset — full cycle complete ──
            if self.idle_count >= self.IDLE_RESET_FRAMES:
                if self.cycle_state != "idle":
                    print(f"🔄 {self.cam_id}: idle — cycle reset, ready for new truck")
                self.cycle_state = "idle"
                self.filling_done = False
                self.block_filling = False
                self.filled_confirm_count = 0
                self.last_sent = None
                self.idle_count = 0

            # ── filled confirmation counter ──
            if has_filled:
                self.filled_confirm_count += 1
            else:
                self.filled_confirm_count = 0

            # ── state machine ──
            if self.cycle_state == "idle":
                if has_truck:
                    self.cycle_state = "truck"
                    current = "truck"
                else:
                    current = None

            elif self.cycle_state == "truck":
                if has_filled and self.filled_confirm_count >= self.FILLED_CONFIRM_FRAMES:
                    self.cycle_state = "filled"
                    self.filling_done = True
                    self.block_filling = True
                    current = "filled"
                elif has_filling and not has_filled and not self.filling_done:
                    self.cycle_state = "filling"
                    current = "filling"
                elif has_truck:
                    current = "truck"
                else:
                    current = None

            elif self.cycle_state == "filling":
                if has_filled and self.filled_confirm_count >= self.FILLED_CONFIRM_FRAMES:
                    self.cycle_state = "filled"
                    self.filling_done = True
                    self.block_filling = True
                    current = "filled"
                elif has_filling and not self.filling_done:
                    current = "filling"
                elif has_truck:
                    self.cycle_state = "truck"
                    current = "truck"
                else:
                    current = None

            elif self.cycle_state == "filled":
                # stay here until idle reset — nothing new fires
                current = None

            else:
                current = None

            # ── MQTT + OCR — only on state change ──
            if current and current != self.last_sent:
                if current == "filling":
                    filling_box = next((box for name, box in labeled_boxes if name == "filling"), None)
                    number = None
                    if filling_box is not None:
                        number = extract_number_from_box(frame, filling_box.xyxy[0])
                    if not number:
                        number = extract_number_fullframe_fallback(frame)
                    msg = f"filling-{number}" if number else "filling"
                else:
                    msg = current

                self.mqtt.publish(self.topic, msg)
                print(f"📡 {self.cam_id}: {msg}")
                self.last_sent = current

            # ── draw annotations ──
            img = r.orig_img.copy()
            for box in r.boxes:
                cls = int(box.cls[0])
                conf = float(box.conf[0])
                name = r.names[cls].lower()
                if name == "truck" and conf < 0.5:
                    continue
                if name == "filling" and conf < 0.5:
                    continue
                if name == "filled" and conf < 0.55:
                    continue
                x1, y1, x2, y2 = map(int, box.xyxy[0])
                color = COLOR_MAP.get(name, (0, 255, 0))
                cv2.rectangle(img, (x1, y1), (x2, y2), color, 2)
                cv2.putText(img, f"{name} {conf:.2f}", (x1, y1 - 8),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

            h, w = img.shape[:2]
            small = cv2.resize(img, (int(w * DISPLAY_SCALE), int(h * DISPLAY_SCALE)))
            cv2.putText(small, f"{self.cam_id} | {current or 'idle'}",
                        (10, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

            with self.display_lock:
                self.display_frame = small

    def start(self):
        threading.Thread(target=self.capture, daemon=True).start()
        threading.Thread(target=self.infer, daemon=True).start()


class CameraManager:
    def __init__(self):
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        print("Device:", self.device)
        self.model = YOLO("src/best (13).pt")
        try:
            self.model.fuse()
        except:
            pass
        self.cameras = []

    def add_camera(self, cam_id, rtsp_url):
        cam = Camera(cam_id, rtsp_url, self.model, self.device)
        cam.start()
        self.cameras.append(cam)

    def shutdown(self, *args):
        # يوقف الخيوط ويقفل النوافذ عند تغيير الـ mode (SIGTERM) أو Ctrl+C
        for cam in self.cameras:
            cam.running = False
        cv2.destroyAllWindows()
        for _ in range(5):   # ضخّ waitKey عشان الإغلاق يتنفّذ فعلاً
            cv2.waitKey(1)

    def run(self):
        # الاستجابة لإشارة الإنهاء اللي بيبعتها البرنامج الأب عند تغيير الـ mode
        signal.signal(signal.SIGTERM, lambda *a: (self.shutdown(), sys.exit(0)))
        signal.signal(signal.SIGINT, lambda *a: (self.shutdown(), sys.exit(0)))

        if HEADLESS:
            print("No display detected — running headless")
            print("Press Ctrl+C to stop")
            try:
                while True:
                    time.sleep(1)
            finally:
                self.shutdown()
                print("Stopped")
        else:
            print("🖥️  Display detected — showing windows")
            print("Press Q to quit")
            try:
                while True:
                    for cam in self.cameras:
                        with cam.display_lock:
                            if cam.display_frame is not None:
                                cv2.imshow(cam.cam_id, cam.display_frame)
                                cv2.namedWindow(cam.cam_id, cv2.WINDOW_AUTOSIZE)
                                x, y = positions.get(cam.cam_id, (0, 0))

                                #cv2.resizeWindow(cam.cam_id, 640, 360)
                                cv2.moveWindow(cam.cam_id, x, y)

                                cv2.imshow(cam.cam_id, cam.display_frame)

                                cv2.setWindowProperty(
                                    cam.cam_id,
                                    cv2.WND_PROP_TOPMOST,
                                    1
                                )
                                if sys.platform.startswith("linux"):
                                    os.system(f'wmctrl -r "{cam.cam_id}" -b add,above')
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        break
            finally:
                self.shutdown()


if __name__ == "__main__":
    manager = CameraManager()
    manager.add_camera("port1", "rtsp://admin:ASDzxc_123@192.168.25.25:554/stream1")
    manager.add_camera("port2", "rtsp://admin:ASDzxc_123@192.168.25.24:554/stream1")
    manager.run()
