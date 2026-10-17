#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <FS.h>
#include <LittleFS.h>
#include <ESP8266WebServer.h>

// ===== Pins (adjust to your board) =====
#define pumb1start D1
#define pumb1stop D2
#define pumb2start D5
#define pumb2stop D6
#define port1 D7
#define port2 D8

// ===== Defaults (will be overridden by saved values) =====
String WIFI_SSID_DEFAULT = "Abdo123";             // value1 (user name)
String WIFI_PASS_DEFAULT = "01063677938Abdo123@"; // value2 (password)
String MQTT_SERVER_DEFAULT = "192.168.1.5";       // value3 (mqtt address)
String PORT_NAME_DEFAULT = "PORT-01";             // value4 (stored only)
String STATIC_IP_DEFAULT = "";                    // value5
String GATEWAY_DEFAULT = "192.168.1.1";           // value6
String SUBNET_DEFAULT = "255.255.255.0";          // value7

// ===== Flow thresholds (hysteresis) =====
// Pump2 ON if avgFlow < LOW for LOW_FLOW_TIME_TO_START_MS
// Pump2 OFF if avgFlow > HIGH for HIGH_FLOW_TIME_TO_STOP_MS
float FLOW_LOW_START = 50.0;
float FLOW_HIGH_STOP = 80.0;
const unsigned long LOW_FLOW_TIME_TO_START_MS = 10000;
const unsigned long HIGH_FLOW_TIME_TO_STOP_MS = 3000;

// Pump1 debounce / grace-off
const unsigned long PUMP1_DEBOUNCE_MS = 0;
const unsigned long PUMP1_GRACE_OFF_MS = 0;

// ===== MQTT topics =====
const char *TOPIC_AVAIL = "bumpbroker/availability";
const char *TOPIC_PORTS_STATUS = "ports/status";
const char *TOPIC_PUMP_OVERRIDE = "bump/override";
const char *TOPIC_THR_LOW_SET = "bump/threshold/low_set";
const char *TOPIC_THR_HIGH_SET = "bump/threshold/high_set";
const char *TOPIC_THR_LOW_CUR = "bumpbroker/threshold/low";
const char *TOPIC_THR_HIGH_CUR = "bumpbroker/threshold/high";
const char *TOPIC_PUMP2_ACTIVE_CUR = "pump2/running";
const char *TOPIC_PUMP1_RUNNING_CUR = "pump1/running";

// ===== Files (LittleFS) =====
const char *F_USERNAME = "/username.txt"; // WiFi SSID
const char *F_PASSWORD = "/password.txt"; // WiFi Password
const char *F_MQTT = "/mqtt_address.txt";
const char *F_PORTNAME = "/port_id.txt"; // stored only
const char *F_IP = "/esp_local_ip.txt";
const char *F_GW = "/gateway.txt";
const char *F_SN = "/subnet.txt";
const char *F_THR_LOW = "/flow_low.txt";
const char *F_THR_HIGH = "/flow_high.txt";

// ===== Globals =====
WiFiClient espClient;
PubSubClient client(espClient);
ESP8266WebServer server(80);

// runtime config (populated from FS or defaults)
String ui_user, ui_pass, ui_mqtt, ui_port, ui_ip, ui_gw, ui_sn;

const uint8_t MAX_PORTS = 8;
float recentFlow[MAX_PORTS] = {0};
bool portsActive = false;
bool pump1Running = false;
bool pump2Running = false;
int active;

// Wait time before restarting after a pump2 -> pump1 downgrade (non-blocking)
const unsigned long PUMP_RESTART_DELAY_MS = 14000;
bool restartWait = false;
unsigned long restartWaitSince = 0;

unsigned long lastPortsChange = 0;
int lastActiveCount = 0;
bool pendingPump1Stop = false;

// MQTT reconnect backoff variables
unsigned long lastReconnectAttempt = 0;
const unsigned long RECONNECT_INTERVAL_MS = 5000;
unsigned long reconnectIntervalMs = RECONNECT_INTERVAL_MS; // backoff interval
const unsigned long MAX_RECONNECT_INTERVAL_MS = 30000;
unsigned long reconnectPauseUntilMs = 0; // pause window after too many failures
uint8_t reconnectFailures = 0;           // consecutive failures

// Pump2 dwell timers
bool lowNow = false;
unsigned long lowSince = 0;
bool stopArmed = false;
unsigned long highSince = 0;

// ===== AP (fallback) =====
bool apMode = false;
String apSsid = "";

// ===== FS helpers =====
String readFile(const char *path)
{
  if (!LittleFS.exists(path))
    return "";
  File f = LittleFS.open(path, "r");
  if (!f)
    return "";
  String s = f.readString();
  f.close();
  s.trim();
  return s;
}
bool writeFile(const char *path, const String &data)
{
  File f = LittleFS.open(path, "w");
  if (!f)
    return false;
  f.print(data);
  f.close();
  return true;
}

// ===== AP fallback =====
void startAPFallback()
{
  apMode = true;
  apSsid = "BumpBroker-Setup";
  WiFi.mode(WIFI_AP);
  WiFi.softAP(apSsid.c_str());      // open network (no password)
  IPAddress myIP = WiFi.softAPIP(); // 192.168.4.1
  Serial.println();
  Serial.print("AP mode started: ");
  Serial.println(apSsid);
  Serial.print("Open http://");
  Serial.println(myIP);
}

// ===== Web UI (EXACT requested fields & style) =====
void handleRoot()
{
  String html =
      "<!DOCTYPE html>"
      "<html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
      "<style>"
      "body { font-family: Arial, sans-serif; text-align: center; background-color: #121212; color: #ffffff; padding: 20px; border-radius: 10px; }"
      "h1 { color: #ffffff; }"
      "form { display: inline-block; margin-top: 20px; background-color: #1e1e1e; padding: 20px; border-radius: 10px; text-align: left; }"
      "form div { margin-bottom: 10px; }"
      "label { display: inline-block; width: 120px; text-align: right; margin-right: 10px; }"
      "input[type='text'] { padding: 10px; margin: 5px; background-color: #333333; color: #ffffff; border: 1px solid #555555; width: 200px; }"
      "input[type='submit'] { padding: 10px; margin: 5px auto; display: block; background-color: #4CAF50; color: white; border: none; cursor: pointer; width: 80%; border-radius: 7px; }"
      "input[type='submit']:hover { background-color: #45a049; }"
      "</style></head><body>"
      "<h1>HYPER SCADA</h1>"
      "<p>filling system</p>"
      "<form action=\"/submit\" method=\"POST\">"

      "  <div><label for=\"value1\">user name:</label>"
      "      <input type=\"text\" id=\"value1\" name=\"value1\" value=\"" +
      ui_user + "\"></div>"

                "  <div><label for=\"value2\">password:</label>"
                "      <input type=\"text\" id=\"value2\" name=\"value2\" value=\"" +
      ui_pass + "\"></div>"

                "  <div><label for=\"value3\">mqtt address:</label>"
                "      <input type=\"text\" id=\"value3\" name=\"value3\" value=\"" +
      ui_mqtt + "\"></div>"

                "  <div><label for=\"value5\">esp_local_ip:</label>"
                "      <input type=\"text\" id=\"value5\" name=\"value5\" value=\"" +
      ui_ip + "\"></div>"

              "  <div><label for=\"value6\">gateway:</label>"
              "      <input type=\"text\" id=\"value6\" name=\"value6\" value=\"" +
      ui_gw + "\"></div>"

              "  <div><label for=\"value7\">subnet:</label>"
              "      <input type=\"text\" id=\"value7\" name=\"value7\" value=\"" +
      ui_sn + "\"></div>"

              "  <input type=\"submit\" value=\"Submit\">"
              "</form>"
              "</body></html>";

  server.send(200, "text/html", html);
}

void handleFormSubmit()
{
  String usser_name = server.arg("value1");
  String pass = server.arg("value2");
  String mqtt_address = server.arg("value3");
  String esp_local_ip = server.arg("value5");
  String esp_gateway = server.arg("value6");
  String esp_subnet = server.arg("value7");

  writeFile(F_USERNAME, usser_name);
  writeFile(F_PASSWORD, pass);
  writeFile(F_MQTT, mqtt_address);
  writeFile(F_IP, esp_local_ip);
  writeFile(F_GW, esp_gateway);
  writeFile(F_SN, esp_subnet);

  // update in-memory (for next render if needed)
  ui_user = usser_name;
  ui_pass = pass;
  ui_mqtt = mqtt_address;
  ui_ip = esp_local_ip;
  ui_gw = esp_gateway;
  ui_sn = esp_subnet;

  server.send(200, "text/html", "<h1>Values received</h1>");
  delay(800);
  ESP.restart();
}

// ===== WiFi =====
// هذا التعديل يجعل connectWiFi غير متزامنة (non-blocking) ولا تعطل الكود
// عند كل دورة loop، تنادي connectWiFiLoop() بدل connectWiFi() مباشرة

enum WiFiConnectState {
  WIFI_IDLE,
  WIFI_STARTED,
  WIFI_CONNECTING,
  WIFI_DONE,
  WIFI_FAILED
};

WiFiConnectState wifiState = WIFI_IDLE;
unsigned long wifiStartTime = 0;
unsigned long wifiLastAttempt = 0;
int wifiTries = 0;
unsigned long wifiConnectDuration = 0;

void connectWiFiStart() {
  wifiTries = 0;
  wifiStartTime = millis();

  // try to apply static IP if provided
  if (ui_ip.length() > 0 && ui_gw.length() > 0 && ui_sn.length() > 0)
  {
    IPAddress ip, gw, sn;
    ip.fromString(ui_ip);
    gw.fromString(ui_gw);
    sn.fromString(ui_sn);
    WiFi.config(ip, gw, sn);
  }
  WiFi.mode(WIFI_STA);
  WiFi.begin(ui_user.c_str(), ui_pass.c_str());
  Serial.print("Connecting WiFi");
  wifiLastAttempt = millis();
  wifiState = WIFI_CONNECTING;
}

void connectWiFiLoop() {
  if (wifiState == WIFI_IDLE || wifiState == WIFI_DONE) {
    // لم يبدأ اتصال أو تم بالفعل، لا شيء مطلوب
    return;
  }
  if (wifiState == WIFI_CONNECTING) {
    // تحقق إذا تم الاتصال أو انتهت المحاولات
    if (WiFi.status() == WL_CONNECTED) {
      wifiConnectDuration = millis() - wifiStartTime;
      Serial.println(" OK");
      Serial.print("WiFi connect time (ms): ");
      Serial.println(wifiConnectDuration);
      wifiState = WIFI_DONE;
    }
    else if (wifiTries >= 40) {
      wifiConnectDuration = millis() - wifiStartTime;
      Serial.println(" FAILED");
      Serial.print("WiFi connect time (ms): ");
      Serial.println(wifiConnectDuration);
      wifiState = WIFI_FAILED;
      startAPFallback();
    }
    else if (millis() - wifiLastAttempt >= 250) {
      Serial.print(".");
      wifiTries++;
      wifiLastAttempt = millis();
    }
  }
}

bool isWiFiConnected() {
  return (wifiState == WIFI_DONE && WiFi.status() == WL_CONNECTED);
}

// لتشغيل الاتصال:
// connectWiFiStart(); مرة واحدة فقط (عند البدء أو عند فقدان الاتصال)
// connectWiFiLoop(); في loop()
// لمعرفة الوقت المستغرق من آخر محاولة: wifiConnectDuration بالميلي ثانية (ms)

bool connectToMQTT()
{
  client.setServer(ui_mqtt.c_str(), 1883);
  client.setKeepAlive(10);
  client.setSocketTimeout(2);
  
  String cid = "bumpbroker-" + String(ESP.getChipId(), HEX);
  bool ok = client.connect(cid.c_str(), TOPIC_AVAIL, 1, true, "offline");
  if (ok)
  {
    client.publish(TOPIC_AVAIL, "online", true);
    client.publish(TOPIC_THR_LOW_CUR, String(FLOW_LOW_START, 3).c_str(), true);
    client.publish(TOPIC_THR_HIGH_CUR, String(FLOW_HIGH_STOP, 3).c_str(), true);
    client.publish(TOPIC_PUMP2_ACTIVE_CUR, pump2Running ? "1" : "0", true);
    client.publish(TOPIC_PUMP1_RUNNING_CUR, pump1Running ? "1" : "0", true);
    return true;
  }
  return false;
}

void connectToMQTTLoop()
{
  if (!client.connected() && WiFi.status() == WL_CONNECTED)
  {
    unsigned long now = millis();
    // لا نحاول أثناء pause window
    if (now >= reconnectPauseUntilMs && (now - lastReconnectAttempt) > reconnectIntervalMs)
    {
      lastReconnectAttempt = now;
      if (connectToMQTT())
      {
        reconnectFailures = 0;
        reconnectIntervalMs = RECONNECT_INTERVAL_MS;
      }
      else
      {
        reconnectFailures++;
        if (reconnectIntervalMs < MAX_RECONNECT_INTERVAL_MS)
          reconnectIntervalMs = (reconnectIntervalMs * 2 <= MAX_RECONNECT_INTERVAL_MS) ? reconnectIntervalMs * 2 : MAX_RECONNECT_INTERVAL_MS;
        if (reconnectFailures >= 5)
        {
          // إيقاف المحاولات لمدة دقيقة لعدم تعطيل الـ UI
          reconnectPauseUntilMs = now + 60000;
        }
      }
    }
  }
}

// ===== Relay helpers (Latch logic) =====
void setPump1Start()
{
  // START active-HIGH pulse, STOP line stayed idle HIGH
  digitalWrite(pumb1start, HIGH);
  delay(2000);
  digitalWrite(pumb1start, LOW);
  pump1Running = true;
  if (client.connected())
  {
    client.publish(TOPIC_PUMP1_RUNNING_CUR, "1", true);
  }
}
void setPump1StopAll()
{
  // STOP active-LOW pulse for both pumps
  digitalWrite(pumb1stop, LOW);
  digitalWrite(pumb2stop, LOW);
  delay(2000);
  digitalWrite(pumb1stop, HIGH);
  digitalWrite(pumb2stop, HIGH);
  pump1Running = false;
  pump2Running = false;
  lowNow = false;
  if (client.connected())
  {
    client.publish(TOPIC_PUMP1_RUNNING_CUR, "0", true);
    client.publish(TOPIC_PUMP2_ACTIVE_CUR, "0", true);
  }
}
void setPump2Start()
{
  digitalWrite(pumb2start, HIGH);
  delay(2000);
  digitalWrite(pumb2start, LOW);
  pump2Running = true;
  if (client.connected())
  {
    client.publish(TOPIC_PUMP2_ACTIVE_CUR, "1", true);
  }
}

// ===== Setup / Loop =====
void setup()
{
  Serial.begin(115200);
  delay(50);

  pinMode(pumb1start, OUTPUT);
  pinMode(pumb1stop, OUTPUT);
  pinMode(pumb2start, OUTPUT);
  pinMode(pumb2stop, OUTPUT);
  // Latch idle states
  digitalWrite(pumb1start, LOW);
  digitalWrite(pumb1stop, HIGH);
  digitalWrite(pumb2start, LOW);
  digitalWrite(pumb2stop, HIGH);

  LittleFS.begin();

  // Load UI fields from FS (or defaults)
  ui_user = readFile(F_USERNAME);
  if (ui_user == "")
    ui_user = WIFI_SSID_DEFAULT;
  ui_pass = readFile(F_PASSWORD);
  if (ui_pass == "")
    ui_pass = WIFI_PASS_DEFAULT;
  ui_mqtt = readFile(F_MQTT);
  if (ui_mqtt == "")
    ui_mqtt = MQTT_SERVER_DEFAULT;
  ui_port = readFile(F_PORTNAME);
  if (ui_port == "")
    ui_port = PORT_NAME_DEFAULT;
  ui_ip = readFile(F_IP);
  if (ui_ip == "")
    ui_ip = STATIC_IP_DEFAULT;
  ui_gw = readFile(F_GW);
  if (ui_gw == "")
    ui_gw = GATEWAY_DEFAULT;
  ui_sn = readFile(F_SN);
  if (ui_sn == "")
    ui_sn = SUBNET_DEFAULT;

  // Load thresholds if previously saved
  String v;
  if ((v = readFile(F_THR_LOW)).length())
    FLOW_LOW_START = v.toFloat();
  if ((v = readFile(F_THR_HIGH)).length())
    FLOW_HIGH_STOP = v.toFloat();
  if (FLOW_HIGH_STOP <= FLOW_LOW_START)
    FLOW_HIGH_STOP = FLOW_LOW_START + 1.0f;

  // Web routes
  server.on("/", HTTP_GET, handleRoot);
  server.on("/submit", HTTP_POST, handleFormSubmit);
  server.begin();

  connectWiFiStart();

  // Wait for WiFi connection (non-blocking)
  unsigned long wifiTimeout = millis() + 10000; // 10 seconds timeout
  while (wifiState == WIFI_CONNECTING && millis() < wifiTimeout)
  {
    connectWiFiLoop();
    server.handleClient();
    delay(10);
  }
  
  if (isWiFiConnected())
  {
    connectToMQTT();
  }

  Serial.println("BumpBroker (compat+AP, your UI) ready.");
}

void loop()
{
  if (!apMode)
  {
    // WiFi connection handling (non-blocking)
    if (WiFi.status() != WL_CONNECTED && wifiState != WIFI_CONNECTING)
    {
      connectWiFiStart();
    }
    connectWiFiLoop();
    
    // MQTT connection handling (non-blocking with backoff)
    if (isWiFiConnected())
    {
      connectToMQTTLoop();
      client.loop();
    }
  }
  server.handleClient();

  active = digitalRead(port1) + digitalRead(port2);

  if (restartWait && millis() - restartWaitSince >= PUMP_RESTART_DELAY_MS)
    restartWait = false;

  if (!restartWait)
  {
    if (active == 1 && pump2Running)
    {
      // Active ports dropped from 2 to 1: stop everything, then wait before restarting
      setPump1StopAll();
      restartWait = true;
      restartWaitSince = millis();
    }
    else if (active == 1 && !pump1Running)
    {
      setPump1Start();
    }
    else if (active > 1 && pump1Running && !pump2Running)
    {
      setPump2Start();
    }
    else if (active == 0 && pump1Running)
    {
      setPump1StopAll();
    }
  }

  // Debug (optional)
  static unsigned long lastLog = 0;
  if (millis() - lastLog > 1000)
  {
    lastLog = millis();
    Serial.print("WiFi: ");
    Serial.print(WiFi.status() == WL_CONNECTED ? "OK" : "DOWN");
    Serial.print(" | MQTT: ");
    Serial.print(client.connected() ? "OK" : "DOWN");
    Serial.print(" | PortsActive: ");
    Serial.print(active);
    Serial.print(" | Pump1: ");
    Serial.print(pump1Running);
    Serial.print(" | Pump2: ");
    Serial.println(pump2Running);
  }
}
