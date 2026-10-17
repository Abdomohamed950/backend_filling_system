#include <ESP8266WiFi.h>  //for esp8266
#include <PubSubClient.h>
#include <ModbusMaster.h>
#include <FS.h>
#include <LittleFS.h>
#include <ESP8266WebServer.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <Encoder.h>
#include "defines.h"
#include <LiquidCrystal_I2C.h>  // مكتبة شاشة LCD I2C

#define testing_mode

int rx = 3;
int encoder_pass = 0;
bool manual;
bool captured = 0;
String lastMqttState = "stop";
unsigned long lastReconnectAttempt = 0;
const unsigned long RECONNECT_INTERVAL_MS = 5000;
unsigned long reconnectIntervalMs = RECONNECT_INTERVAL_MS;  // backoff interval
const unsigned long MAX_RECONNECT_INTERVAL_MS = 30000;
unsigned long reconnectPauseUntilMs = 0;  // pause window after too many failures
uint8_t reconnectFailures = 0;            // consecutive failures

typedef union {
  uint32_t intVal;
  float f;
} int2f;
uint16_t DATA[2];

int firstCloseTime;
int secondCloseTime;
int thirdCloseTime;
int firstCloseLagV;
int secondCloseLagV;
int thirdCloseLagV;
int added_time;
double ExtraWater;
int number_of_active_ports = 0;
String register_type;
int notconnected_count = 0;

int MIN_MA;
int MAX_MA;
int RESISTANCE_OHM = 250;
float leter_per_pulse;

#define MIN_FLOW 0.0
#define MAX_FLOW 100.0

int TIME_OPEN_DC;

bool firstCloseStatus = 0, secondCloseStatus = 0, thirdCloseStatus = 0;

// تعريف المتغيرات
uint16_t result = 1;
volatile float flow_meter_value = 0;
volatile float flow_rate_value = 0;
volatile float flow_meter_prev_value = 0;
float remain_Quantity;
float required_Quantity = 0;
bool is_running = false;
bool is_closing = false;  // لتتبع حالة الإغلاق الجارية
bool updated = true;
String logdata = "";
bool force_stop = 1;
bool isButtonPressed = false;
unsigned long pressStartTime = 0;
String valve_type;

bool offline = false;
int litter = 1000;

// Add global variables to track previous values
float previousFlowMeterValue = -1;
float previousFlowRateValue = -1;
String previousValveState = "";
String previousTruckState = "";

U8G2_SSD1306_128X64_NONAME_F_SW_I2C u8g2(U8G2_R0, /* clock=*/D1, /* data=*/D2, /* reset=*/U8X8_PIN_NONE);

Encoder myEnc(ENCODER_PIN_A, ENCODER_PIN_B);
int lastEncoderPos = 0;
int currentMenuIndex = 0;
int quantity = 0;
bool editingQuantity = false;
bool pass_edit = false;
int progressBar = 0;

// تعريف الopjects
WiFiClient espClient;
PubSubClient client(espClient);
ModbusMaster node;

// اعدادات الذاكره

int write_index = 0;

String config[15];

LiquidCrystal_I2C lcd(0x27, 20, 4);  // عنوان I2C للشاشة وحجمها 20x4

// Function to initialize the display
void setupDisplay() {
  if (oled) {
    u8g2.begin();  // تهيئة شاشة OLED
  } else {
    lcd.init();       // initialize the lcd
    lcd.backlight();  // تشغيل الإضاءة الخلفية
  }
}

// ------------------------------------memory functions--------------------------------

void load_index_from_fs() {
  File file = LittleFS.open("/index.txt", "r");
  if (!file || file.size() == 0) {
    write_index = 0;
  } else {
    write_index = file.parseInt();
  }
  file.close();
}

void save_index_to_fs() {
  File file = LittleFS.open("/index.txt", "w");
  if (file) {
    file.println(write_index);
    file.close();
  }
}

void add_string_to_queue(const char *str) {
  char filename[20];
  snprintf(filename, sizeof(filename), "/queue_%d.txt", write_index);

  File file = LittleFS.open(filename, "w");
  if (file) {
    file.println(str);
    file.close();
  }
  // else {
  //   Serial.printf("Failed to write to file: %s\n", filename);
  // }

  write_index = (write_index + 1) % QUEUE_SIZE;
  save_index_to_fs();
}

void sendlogs() {

  lcd.setCursor(16, 1);
  lcd.print("SYNC");
  for (int i = 0; i < QUEUE_SIZE; i++) {
    char filename[20];
    snprintf(filename, sizeof(filename), "/queue_%d.txt", i);

    File file = LittleFS.open(filename, "r");
    if (file) {
      String content = file.readStringUntil('\n');
      if (content.length() > 0) {  // Check if content is not empty
        if (client.connected())
          client.publish((String(truck_id) + "/logdata").c_str(), content.c_str());

        // Close the file before deleting it
        file.close();

        // Delete the file
        !LittleFS.remove(filename);
        // if (!LittleFS.remove(filename))
        // {
        //   Serial.printf("Failed to delete file: %s\n", filename);
        // }
      } else {
        file.close();
      }
    }
  }
  lcd.setCursor(16, 1);
  lcd.print("    ");
}

void print_queue() {
  for (int i = 0; i < QUEUE_SIZE; i++) {
    char filename[20];
    snprintf(filename, sizeof(filename), "/queue_%d.txt", i);

    File file = LittleFS.open(filename, "r");
    if (file) {
      String content = file.readStringUntil('\n');
      // Serial.printf("Queue %d: %s\n", i, content.c_str()); // Print to Serial Monitor
      file.close();
    }
    // else
    // {
    //   Serial.printf("Queue %d: [Empty]\n", i); // Indicate empty queue slot
    // }
  }
}

// ------------------------------modbus functions------------------------------------
uint32_t AABBCCDD(uint16_t firstRecv, uint16_t secondRecv) {
  uint8_t u1_right = firstRecv & 0x00ff;
  uint8_t u1_left = firstRecv >> 8;
  uint8_t u2_right = secondRecv & 0x00ff;
  uint8_t u2_left = secondRecv >> 8;
  return (((uint32_t)u2_right << 24) | ((uint32_t)u2_left << 16) | ((uint32_t)u1_right << 8) | (uint32_t)u1_left);
}

void preTransmission() {
  digitalWrite(MAX485_RE_NEG, HIGH);
  digitalWrite(MAX485_DE, HIGH);
}

void postTransmission() {
  digitalWrite(MAX485_RE_NEG, LOW);
  digitalWrite(MAX485_DE, LOW);
}

void flowmeter_reader() {
#ifdef testing_mode
  static unsigned long lastPublishTime2 = 0;                                                              //
  if (flow_meter_value != previousFlowMeterValue && millis() - lastPublishTime2 > 500) {                  //
    lastPublishTime2 = millis();                                                                          //
    if (client.connected())                                                                               //
      client.publish((String(truck_id) + "/flowmeter").c_str(), String(flow_meter_value).c_str(), true);  //
    previousFlowMeterValue = flow_meter_value;                                                            //
  } //

#else

  uint32_t value;
  if (register_type == "HOLDING") {
    digitalWrite(MAX485_DE, 0);
    result = node.readHoldingRegisters(config[5].toInt(), REG_IN_ROW);
  } else {
    digitalWrite(MAX485_DE, 0);
    result = node.readInputRegisters(config[5].toInt(), REG_IN_ROW);
  }

  if (result == node.ku8MBSuccess) {
    notconnected_count = 0;
    uint16_t hi = node.getResponseBuffer(0);
    uint16_t lo = node.getResponseBuffer(1);
    if (config[3] == "AABBCCDD") {
      value = AABBCCDD(hi, lo);
      int2f int2f_obj;
      int2f_obj.intVal = value;
      flow_meter_value = int2f_obj.f;
    } else {
      union {
        uint16_t u16[2];
        float f;
      } floatData;

      floatData.u16[0] = hi;
      floatData.u16[1] = lo;
      flow_meter_value = floatData.f;
    }
    static unsigned long lastPublishTime = 0;
    if (!offline && flow_meter_value != previousFlowMeterValue && millis() - lastPublishTime > 500) {
      if (client.connected()) {
        client.publish((String(truck_id) + "/flowmeter").c_str(), String(flow_meter_value, 3).c_str(), true);
        previousFlowMeterValue = flow_meter_value;
      }
      lastPublishTime = millis();
    }
  } else {
    notconnected_count++;
    if (notconnected_count > 5) {
      if (!offline && previousFlowMeterValue != -1) {
        if (client.connected()) {
          client.publish((String(truck_id) + "/flowmeter").c_str(), "-1", true);
          // ESP.restart();
        }
        previousFlowMeterValue = -1;
      }
    }
  }
#endif
}

void flow_rate_reader() {
#ifdef testing_mode
  flow_rate_value = 0;
  static unsigned long lastPublishTimee = 0;
  if (!offline && flow_rate_value != previousFlowRateValue && millis() - lastPublishTimee > 500) {
    if (client.connected()) {
      client.publish((String(truck_id) + "/flow_rate").c_str(), String(flow_rate_value).c_str(), true);
      previousFlowRateValue = flow_rate_value;
    }
    lastPublishTimee = millis();
  }

#else
  uint32_t value;
  if (register_type == "HOLDING") {
    digitalWrite(MAX485_DE, 0);
    result = node.readHoldingRegisters(config[12].toInt(), REG_IN_ROW);
  } else {
    digitalWrite(MAX485_DE, 0);
    result = node.readInputRegisters(config[12].toInt(), REG_IN_ROW);
  }

  if (result == node.ku8MBSuccess) {
    uint16_t hi = node.getResponseBuffer(0);
    uint16_t lo = node.getResponseBuffer(1);

    if (config[3] == "AABBCCDD") {
      value = AABBCCDD(hi, lo);
      int2f int2f_obj;
      int2f_obj.intVal = value;
      flow_rate_value = int2f_obj.f;
    } else {
      union {
        uint16_t u16[2];
        float f;
      } floatData;

      floatData.u16[0] = hi;
      floatData.u16[1] = lo;
      flow_rate_value = floatData.f;
    }
  }
  static unsigned long lastPublishTimee = 0;
  if (!offline && flow_rate_value != previousFlowRateValue && millis() - lastPublishTimee > 500) {
    if (client.connected()) {
      client.publish((String(truck_id) + "/flow_rate").c_str(), String(flow_rate_value).c_str(), true);
      previousFlowRateValue = flow_rate_value;
    }
    lastPublishTimee = millis();
  }
#endif
}

void pulse_calc() {

  static unsigned long lastPublishTime = 0;
  if (flow_meter_value != previousFlowMeterValue && millis() - lastPublishTime > 500) {
    if (client.connected()) {
      client.publish((String(truck_id) + "/flowmeter").c_str(), String(flow_meter_value).c_str(), true);
      previousFlowMeterValue = flow_meter_value;
    }
    lastPublishTime = millis();
  }
}

// ------------------------------------valve functions-------------------------------
void RelayOpenDC(void) {
  if (valve_type == "valve" || valve_type == "valve and bump") {
    digitalWrite(RELAY_CLOSE, LOW);
    digitalWrite(RELAY_OPEN, HIGH);
    unsigned long td = millis();
    while ((millis() - td < TIME_OPEN_DC)) {
      ESP.wdtFeed();
      yield();
      if (offline) {
        scroll();
        // لا ترسل MQTT في وضع الoffline
      } else {
        handleEncoderActions();
        static unsigned long last = 0;
        if (millis() - last > 100) {
          last = millis();
          if (config[0] == "modbus")
          {
            flowmeter_reader();
            flow_rate_reader();
          }
          if (previousValveState != "opening") {
            if (!offline && client.connected())
              client.publish((String(truck_id) + "/valve_state").c_str(), "opening", true);
            previousValveState = "opening";
          }
          if (!offline)
            client.loop();
        }
      }
    }
    digitalWrite(RELAY_OPEN, LOW);
    digitalWrite(PUMP_PIN, HIGH);
  }
}
void RelayCloseDC(uint32_t closeTime, const char *closingState) {
  if (valve_type == "valve" || valve_type == "valve and bump") {
    digitalWrite(RELAY_OPEN, LOW);
    digitalWrite(RELAY_CLOSE, HIGH);
    unsigned long td = millis();
    while ((millis() - td < closeTime)) {
      ESP.wdtFeed();
      yield();
      if (offline)
        scroll();
      else
        handleEncoderActions();
      static unsigned long lasst = 0;
      if (millis() - lasst > 100) {
        lasst = millis();
        if (config[0] == "modbus")
        {
          flowmeter_reader();
          flow_rate_reader();
        }
        if (previousValveState != closingState) {
          if (!offline && client.connected()) {
            client.publish((String(truck_id) + "/valve_state").c_str(), closingState, true);
            previousValveState = closingState;
          }
        }
        if (!offline)
          client.loop();
      }
    }
    digitalWrite(RELAY_CLOSE, LOW);

    // Final close done: valve is fully closed
    if (strcmp(closingState, "closing_final") == 0) {
      if (!offline && client.connected())
        client.publish((String(truck_id) + "/valve_state").c_str(), "close", true);
      previousValveState = "close";
    }
  }
}

// --------------------------------------wifi function------------------------------
String readFile(const char *path) {
  File file = LittleFS.open(path, "r");
  if (!file)
    return "";
  String content = file.readString();
  file.close();
  return content;
}

// Function to write values
void writeFile(const char *path, String message) {
  File file = LittleFS.open(path, "w");
  if (file) {
    file.print(message);
    file.close();
  }
}

ESP8266WebServer server(80);

// Row 0, cols 18-19: N = network (WiFi) connected, M = MQTT connected
void drawStatusLcd() {
  if (oled) return;
  lcd.setCursor(18, 0);
  lcd.print(WiFi.status() == WL_CONNECTED ? "N" : " ");
  lcd.print(client.connected() ? "M" : " ");
}

void setup_wifi() {

  WiFi.config(local_IP, gateway, subnet, dns);
  WiFi.begin(ssid, password);
  unsigned long startAttemptTime = millis();

  while (WiFi.status() != WL_CONNECTED && millis() - startAttemptTime < 10000) {
    delay(500);
  }

  if (WiFi.status() == WL_CONNECTED) {
    drawStatusLcd();
  } else {
    startAPMode();
  }
}

void startAPMode() {
  if (oled) {
    u8g2.clearBuffer();
    u8g2.setFont(u8g2_font_6x12_tf);
    u8g2.setCursor(0, 10);
    u8g2.print("start config mode");
    u8g2.sendBuffer();
  } else {
    lcd.setCursor(0, 0);
    lcd.print("start config mode   ");
  }
  WiFi.softAP(ap_ssid, ap_password);

  server.on("/", handleRoot);
  server.on("/submit", HTTP_POST, handleFormSubmit);
  server.begin();
  while (1) {
    ESP.wdtFeed();
    yield();
    handleEncoderActions();
    server.handleClient();
    static unsigned long lastRestartTime = millis();
    if (millis() - lastRestartTime >= 600000) {
      ESP.restart();
    }
  }
}

void handleRoot() {
  server.send(200, "text/html",
              "<!DOCTYPE html>"
              "<html>"
              "<head>"
              "<style>"
              "body { "
              "    font-family: Arial, sans-serif; "
              "    text-align: center; "
              "    background-color: #121212; "
              "    color: #ffffff; "
              "    padding: 20px; "
              "    border-radius: 10px; "
              "}"
              "h1 { color: #ffffff; }"
              "form { "
              "    display: inline-block; "
              "    margin-top: 20px; "
              "    background-color: #1e1e1e; "
              "    padding: 20px; "
              "    border-radius: 10px; "
              "    text-align: left; "
              "}"
              "form div {"
              "    margin-bottom: 10px;"
              "}"
              "label {"
              "    display: inline-block;"
              "    width: 120px;"
              "    text-align: right;"
              "    margin-right: 10px;"
              "}"
              "input[type='text'] { "
              "    padding: 10px; "
              "    margin: 5px; "
              "    background-color: #333333; "
              "    color: #ffffff; "
              "    border: 1px solid #555555; "
              "    width: 200px;"
              "}"
              "input[type='submit'] { "
              "    padding: 10px; "
              "    margin: 5px auto; "
              "    display: block; "
              "    background-color: #4CAF50; "
              "    color: white; "
              "    border: none; "
              "    cursor: pointer; "
              "    width: 80%;"
              "    border-radius: 7px;"
              "}"
              "input[type='submit']:hover { "
              "    background-color: #45a049; "
              "}"
              "</style>"
              "</head>"
              "<body>"
              "<h1>HYPER SCADA</h1>"
              "<p>filling system</p>"
              "<form action=\"/submit\" method=\"POST\">"
              "    <div>"
              "        <label for=\"value1\">user name:</label>"
              "        <input type=\"text\" id=\"value1\" name=\"value1\">"
              "    </div>"
              "    <div>"
              "        <label for=\"value2\">password:</label>"
              "        <input type=\"text\" id=\"value2\" name=\"value2\">"
              "    </div>"
              "    <div>"
              "        <label for=\"value3\">mqtt address:</label>"
              "        <input type=\"text\" id=\"value3\" name=\"value3\">"
              "    </div>"
              "    <div>"
              "        <label for=\"value4\">port name:</label>"
              "        <input type=\"text\" id=\"value4\" name=\"value4\">"
              "    </div>"
              "    <div>"
              "        <label for=\"value5\">esp_local_ip:</label>"
              "        <input type=\"text\" id=\"value5\" name=\"value5\">"
              "    </div>"
              "    <div>"
              "        <label for=\"value6\">gateway:</label>"
              "        <input type=\"text\" id=\"value6\" name=\"value6\" value=\"192.168.1.1\">"
              "    </div>"
              "    <div>"
              "        <label for=\"value7\">subnet:</label>"
              "        <input type=\"text\" id=\"value7\" name=\"value7\" value=\"255.255.255.0\">"
              "    </div>"
              "    <input type=\"submit\" value=\"Submit\">"
              "</form>"
              "</body>"
              "</html>");
}

void handleFormSubmit() {
  String usser_name = server.arg("value1");
  String pass = server.arg("value2");
  String mqtt_address = server.arg("value3");
  String port_id = server.arg("value4");
  String esp_local_ip = server.arg("value5");
  String esp_gateway = server.arg("value6");
  String esp_subnet = server.arg("value7");
  writeFile("/username.txt", usser_name);
  writeFile("/password.txt", pass);
  writeFile("/mqtt_address.txt", mqtt_address);
  writeFile("/port_id.txt", port_id);
  writeFile("/esp_local_ip.txt", esp_local_ip);
  writeFile("/gateway.txt", esp_gateway);
  writeFile("/subnet.txt", esp_subnet);

  server.send(200, "text/html", "<h1>Values received</h1>");
  ESP.restart();
}

// ---------------------------------mqtt functions-------------------------------------
String message = "";
void callback(char *topic, byte *payload, unsigned int length) {
  message = "";
  String topicStr = String(topic);

  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }

  if (topicStr == String(truck_id) + "/quantity") {
    float qty = message.toFloat();
    if (qty > 0 && qty < 100) {
      required_Quantity = qty;
      flow_meter_prev_value = flow_meter_value;
      if (client.connected())
        client.publish((String(truck_id) + "/state").c_str(), "filling", true);
    }
  }

  else if (topicStr == String(truck_id) + "/logdata")
    logdata = message;

  else if (topicStr == String(truck_id) + "/reset")
    ESP.restart();

  else if (topicStr == String(truck_id) + "/state") {
    lastMqttState = message;
    if (message == "start") {
      is_running = true;
      firstCloseStatus = 0;
      secondCloseStatus = 0;
      thirdCloseStatus = 0;
      RelayOpenDC();
      if (valve_type == "bump")
        digitalWrite(RELAY_OPEN, 1);
      if (client.connected())
        client.publish((String(truck_id) + "/valve_state").c_str(), "open", true);
      previousValveState = "open";
    }

    else if (message == "stop")
    {
      is_running = false;
      if (client.connected())
        client.publish((String(truck_id) + "/valve_state").c_str(), "close", true);
      previousValveState = "close";
    }

    else if (message == "force_stop")
    {
      thirdCloseStatus = 1;
      if (client.connected())
        client.publish((String(truck_id) + "/state").c_str(), "stoping", true);
      digitalWrite(PUMP_PIN, LOW);
      RelayCloseDC(TIME_OPEN_DC + added_time, "closing_final");
      if (valve_type == "bump")
        digitalWrite(RELAY_OPEN, 0);
      if (client.connected())
        client.publish((String(truck_id) + "/state").c_str(), "stop", true);
    }
  }

  else if (topicStr == String(truck_id) + "/conf") {
    splitString(message, ',', config, 15);
    updated = false;
  }

  else if (topicStr == String(truck_id) + "/send_logs") {
    sendlogs();
  }

  else if (topicStr == String(truck_id) + "/recapture") {
    captured = 0;
  }
}

void splitString(const String &str, char delimiter, String result[], int maxParts) {
  int currentIndex = 0;
  int startIndex = 0;
  int endIndex = str.indexOf(delimiter);

  while (endIndex >= 0 && currentIndex < maxParts - 1) {
    result[currentIndex++] = str.substring(startIndex, endIndex);
    startIndex = endIndex + 1;
    endIndex = str.indexOf(delimiter, startIndex);
  }
  result[currentIndex] = str.substring(startIndex);
}

void reconnect() {

  String availabilityTopicStr = String(truck_id) + "/availability";
  String clientIdStr = String("ESPTruckClient_") + truck_id;
  String quantityTopic = String(truck_id) + "/quantity";
  String stateTopic = String(truck_id) + "/state";
  String refreshTopic = String(truck_id) + "/refresh";
  String logdataTopic = String(truck_id) + "/logdata";
  String confTopic = String(truck_id) + "/conf";
  String resetTopic = String(truck_id) + "/reset";
  String sendLogsTopic = String(truck_id) + "/send_logs";
  const char *TOPIC_PORTS_STATUS = "ports/status";

  const char *willTopic = availabilityTopicStr.c_str();
  const char *willMessage = "offline";

  if (client.connect(clientIdStr.c_str(), willTopic, 1, true, willMessage)) {
    drawStatusLcd();

    client.publish(availabilityTopicStr.c_str(), "online", true);
    client.subscribe(quantityTopic.c_str());
    client.subscribe(stateTopic.c_str());
    client.subscribe(refreshTopic.c_str());
    client.subscribe(logdataTopic.c_str());
    client.subscribe(confTopic.c_str());
    client.subscribe(resetTopic.c_str());
    client.subscribe(sendLogsTopic.c_str());
    client.subscribe(TOPIC_PORTS_STATUS);
  }
}

// ------------------------------------lcd----------------------------------------
bool isBold[3] = { false, false, false };

void drawMenu_oled() {
  u8g2.clearBuffer();

  u8g2.setFont(u8g2_font_6x12_tf);
  u8g2.setCursor(90, 15);
  u8g2.print("[");
  u8g2.print(flow_meter_value);
  u8g2.print("]");

  // **Quantity Row**
  u8g2.setFont(isBold[0] ? u8g2_font_6x13B_tf : u8g2_font_6x12_tf);
  u8g2.setCursor(5, 15);
  if (currentMenuIndex == 0)
    u8g2.print("> ");
  u8g2.print("Quantity: ");
  u8g2.print(quantity);

  // **Start Row**
  u8g2.setFont(isBold[1] ? u8g2_font_6x13B_tf : u8g2_font_6x12_tf);
  u8g2.setCursor(5, 30);
  if (currentMenuIndex == 1)
    u8g2.print("> ");
  u8g2.print("Start");

  // **Stop Row**
  u8g2.setFont(isBold[2] ? u8g2_font_6x13B_tf : u8g2_font_6x12_tf);
  u8g2.setCursor(5, 45);
  if (currentMenuIndex == 2)
    u8g2.print("> ");
  u8g2.print("Stop");

  drawProgressBar_oled();
  u8g2.sendBuffer();
}

void drawMenu_lcd() {
  // استخدام clear مرة واحدة فقط لتجنب الرعشة المتكررة
  static bool firstDraw = true;
  if (firstDraw) {
    lcd.clear();
    firstDraw = false;
  }

  // **Quantity Row**
  lcd.setCursor(0, 0);
  if (currentMenuIndex == 0)
    lcd.print(">");
  else
    lcd.print(" ");
  lcd.print(quantity);
  if (isBold[0])
    lcd.print("*");
  else
    lcd.print(" ");
  lcd.print("[");
  lcd.print(flow_meter_value);
  lcd.print("]");
  // مسح باقي السطر (20 عمود)
  String row0 = String(currentMenuIndex == 0 ? ">" : " ") + String(quantity) + String(isBold[0] ? "*" : " ") + "[" + String(flow_meter_value) + "]";
  for (int i = row0.length(); i < 18; i++) {
    lcd.print(" ");
  }
  drawStatusLcd();

  // **Start Row** - استخدام is_running بدل isBold
  lcd.setCursor(0, 1);
  if (currentMenuIndex == 1)
    lcd.print(">");
  else
    lcd.print(" ");
  if (is_running)
    lcd.print("Starting");
  else
    lcd.print("Start  ");
  // مسح باقي السطر حتى العمود 10
  String row1Start = String(currentMenuIndex == 1 ? ">" : " ") + String(is_running ? "Starting" : "Start  ");
  for (int i = row1Start.length(); i < 10; i++) {
    lcd.print(" ");
  }

  // **Stop Row** - استخدام is_closing بدل isBold
  lcd.setCursor(10, 1);
  if (currentMenuIndex == 2)
    lcd.print(">");
  else
    lcd.print(" ");
  if (is_closing)
    lcd.print("Stoping");
  else
    lcd.print("Stop   ");
  // مسح باقي السطر
  String row1Stop = String(currentMenuIndex == 2 ? ">" : " ") + String(is_closing ? "Stoping" : "Stop   ");
  for (int i = row1Stop.length(); i < 10; i++) {
    lcd.print(" ");
  }

  // **Automatic Mode Row**
  lcd.setCursor(0, 2);
  if (currentMenuIndex == 3)
    lcd.print(">");
  else
    lcd.print(" ");
  if (isBold[3]) {
    lcd.print("automatic pass: ");
    lcd.print(encoder_pass);
    // مسح باقي السطر
    String row2 = String(currentMenuIndex == 3 ? ">" : " ") + "automatic pass: " + String(encoder_pass);
    for (int i = row2.length(); i < 20; i++) {
      lcd.print(" ");
    }
  } else {
    lcd.print("auto mode");
    // Flow rate on the right side of the row
    String rate = String("F:") + String(flow_rate_value, 1);
    lcd.setCursor(10, 2);
    lcd.print(rate);
    for (int i = rate.length(); i < 10; i++) {
      lcd.print(" ");
    }
  }
}

int previousQuantity = -1;   // Initialize with an invalid value
int previousMenuIndex = -1;  // Initialize with an invalid value
int pre_encoder_pass = -1;
int pr_flow_meter_value = -1;
bool previousIsRunning = false;  // لتتبع حالة is_running
bool previousIsClosing = false;  // لتتبع حالة is_closing
bool press = 0;

void scroll() {
  int newEncoderPos = myEnc.read() / 4;

  if (newEncoderPos != lastEncoderPos) {
    if (editingQuantity) {
      quantity += (newEncoderPos > lastEncoderPos) ? 1 : -1;
      if (quantity < 0)
        quantity = 0;
      lastEncoderPos = newEncoderPos;
    }

    if (pass_edit) {
      encoder_pass += (newEncoderPos > lastEncoderPos) ? 1 : -1;
      if (encoder_pass < 0)
        encoder_pass = 0;
      lastEncoderPos = newEncoderPos;
    }

    else {

      currentMenuIndex += (newEncoderPos > lastEncoderPos) ? 1 : -1;
      if (currentMenuIndex < 0)
        currentMenuIndex = 0;
      if (currentMenuIndex > 3)
        currentMenuIndex = 3;
      lastEncoderPos = newEncoderPos;
    }
  }

  static unsigned long lastDebounceTime = 0;
  static unsigned long lastActionTime = 0;         // لمنع الضغطات المتكررة السريعة
  const unsigned long ACTION_DEBOUNCE_TIME = 500;  // 500ms بين كل action

  if (millis() - lastDebounceTime > 50) {
    lastDebounceTime = millis();
    if (digitalRead(ENCODER_BUTTON) == HIGH) {
      while (digitalRead(ENCODER_BUTTON) == HIGH)
        ;

      // منع الضغطات المتكررة السريعة (debounce للـ actions)
      if (millis() - lastActionTime < ACTION_DEBOUNCE_TIME) {
        return;
      }
      lastActionTime = millis();

      press = 1;

      // فقط للـ quantity والـ automatic mode نستخدم isBold
      if (currentMenuIndex == 0 || currentMenuIndex == 3) {
        isBold[currentMenuIndex] = !isBold[currentMenuIndex];
      }

      if (currentMenuIndex == 0) {
        editingQuantity = !editingQuantity;
      } else if (currentMenuIndex == 1) {
        // Start - فقط لو التعبئة مش شغالة
        if (!is_running) {
          startFunction();
        }
      } else if (currentMenuIndex == 2) {
        // Stop - يسمح بالإغلاق حتى لو الصمام مغلق (لإغلاق أكتر)
        // لكن يمنع لو جاري الإغلاق حالياً
        stopFunction();
      } else if (currentMenuIndex == 3) {
        pass_edit = !pass_edit;
        if (encoder_pass == 12) {
          encoder_pass = 0;
          writeFile("/manual.txt", "0");
          ESP.restart();
        } else {
          encoder_pass = 0;
        }
      }
    }
  }

  // Update the display only if values have changed
  static unsigned long lastUpdateTime = 0;
  // تحديث الشاشة لو:
  // - مر ثانية (للتحديث الدوري)
  // - تغيرت القيم المهمة
  // - تغيرت حالة is_running أو is_closing (للتحديث الفوري)
  if (millis() - lastUpdateTime >= 1000 || previousQuantity != quantity || press || previousMenuIndex != currentMenuIndex || pre_encoder_pass != encoder_pass || previousIsRunning != is_running || previousIsClosing != is_closing) {
    lastUpdateTime = millis();
    press = 0;
    if (oled) {
      drawMenu_oled();
    } else {
      drawMenu_lcd();
    }
    previousQuantity = quantity;
    previousMenuIndex = currentMenuIndex;
    pre_encoder_pass = encoder_pass;
    pr_flow_meter_value = flow_meter_value;
    previousIsRunning = is_running;
    previousIsClosing = is_closing;
    isButtonPressed = false;  // Reset the button press flag after updating the display
  }

  static unsigned long lastDrawTime = 0;
  if (millis() - lastDrawTime >= 100) {
    lastDrawTime = millis();
    if (!oled) {
      drawProgressBar_lcd();
    }
  }
}

void drawProgressBar_oled() {
  u8g2.drawFrame(5, 55, 118, 8);
  u8g2.drawBox(5, 55, progressBar, 8);
}

void drawProgressBar_lcd() {
  lcd.setCursor(0, 3);
  int progressBlocks = (progressBar * 18) / 100;  // Assuming 100 is max progress

  lcd.print("[");
  for (int i = 0; i < 18; i++) {
    if (i < progressBlocks) {
      lcd.print("#");
    } else {
      lcd.print(" ");
    }
  }
  lcd.print("]");
}

void startFunction() {
  // منع الضغط مرتين - لو التعبئة شغالة بالفعل، ما نعملش حاجة
  if (is_running) {
    return;
  }

  // التحقق من أن الكمية أكبر من صفر
  if (quantity <= 0) {
    return;
  }

  // التحقق من أن valve_type معرف صح
  if (valve_type.length() == 0) {
    return;
  }

  progressBar = 0;
  is_running = 1;
  firstCloseStatus = 0;
  secondCloseStatus = 0;
  thirdCloseStatus = 0;
  flow_meter_prev_value = flow_meter_value;
  required_Quantity = quantity;

  if (valve_type == "bump")
    digitalWrite(RELAY_OPEN, 1);
  else
    RelayOpenDC();
}

// دالة الإيقاف
void stopFunction() {
  // منع الإغلاق لو الصمام جاري الإغلاق حالياً
  if (is_closing) {
    return;
  }

  // لو التعبئة متوقفة بالفعل، يسمح بالإغلاق مرة تانية (لإغلاق أكتر)
  // لكن لو التعبئة شغالة، نوقفها ونغلق الصمام
  if (is_running) {
    is_running = 0;
    isBold[1] = 0;
  }

  isBold[2] = 0;

  // إغلاق الصمام فقط لو كان مفتوح
  if (valve_type.length() > 0) {
    is_closing = true;  // تحديد أن الصمام جاري الإغلاق
    RelayCloseDC(firstCloseTime + secondCloseTime + thirdCloseTime + added_time, "closing_final");
    is_closing = false;  // إنهاء حالة الإغلاق
    if (valve_type == "bump")
      digitalWrite(RELAY_OPEN, 0);
  }

  // إعادة تعيين الحالات
  firstCloseStatus = 0;
  secondCloseStatus = 0;
  thirdCloseStatus = 0;
}

void handleEncoderActions() {
  int newEncoderPos = myEnc.read() / 4;

  if (newEncoderPos != lastEncoderPos) {

    if (pass_edit) {
      encoder_pass += (newEncoderPos > lastEncoderPos) ? 1 : -1;
      if (encoder_pass < 0)
        encoder_pass = 0;
      lastEncoderPos = newEncoderPos;
    } else {
      currentMenuIndex += (newEncoderPos > lastEncoderPos) ? 1 : -1;
      if (currentMenuIndex < 0)
        currentMenuIndex = 0;
      if (currentMenuIndex > 2)
        currentMenuIndex = 2;
      lastEncoderPos = newEncoderPos;
    }
  }

  static unsigned long lastDebounceTime = 0;
  if (millis() - lastDebounceTime > 50) {  // Debouncing logic
    lastDebounceTime = millis();
    if (digitalRead(ENCODER_BUTTON) == HIGH) {
      while (digitalRead(ENCODER_BUTTON) == HIGH)
        ;

      isBold[currentMenuIndex] = !isBold[currentMenuIndex];
      if (currentMenuIndex == 0) {
        pass_edit = !pass_edit;
        if (encoder_pass == 12) {
          encoder_pass = 0;
          writeFile("/manual.txt", "1");
          ESP.restart();
        } else {
          encoder_pass = 0;
        }
      } else if (currentMenuIndex == 1) {
        pass_edit = !pass_edit;
        if (encoder_pass == 12) {
          encoder_pass = 0;
          startAPMode();
        } else {
          encoder_pass = 0;
        }
      } else if (currentMenuIndex == 2) {
        ESP.restart();
      }
      press = 1;
    }
  }

  static unsigned long lastUpdateTime = 0;
  if (pre_encoder_pass != encoder_pass || previousMenuIndex != currentMenuIndex || press || millis() - lastUpdateTime >= 1000) {
    lastUpdateTime = millis();
    press = 0;
    // Update the display
    if (oled) {
      u8g2.clearBuffer();
      u8g2.setFont(u8g2_font_6x12_tf);

      // Restart option
      u8g2.setCursor(0, 15);
      if (currentMenuIndex == 0)
        u8g2.print("> ");
      u8g2.print("config Mode");

      // AP Mode option
      u8g2.setCursor(0, 30);
      if (currentMenuIndex == 1)
        u8g2.print("> ");
      u8g2.print("Restart");

      u8g2.sendBuffer();
    } else {
      // Row 0: flow rate, then truck id (right-aligned before N/M), N/M at columns 18-19
      String rate = String("Rate:") + String(flow_rate_value, 1);
      String id = String(truck_id);
      lcd.setCursor(0, 0);
      lcd.print(rate);
      for (int i = rate.length(); i < 18 - (int)id.length(); i++) {
        lcd.print(" ");
      }
      lcd.print(id);
      drawStatusLcd();

      // manual mode
      lcd.setCursor(0, 1);
      if (currentMenuIndex == 0)
        lcd.print(">");
      else
        lcd.print(" ");
      if (isBold[0]) {
        lcd.print("manual pass ");
        lcd.print(encoder_pass);
      } else
        lcd.print("manual mode     ");

      // AP Mode option
      lcd.setCursor(0, 2);
      if (currentMenuIndex == 1)
        lcd.print(">");
      else
        lcd.print(" ");
      if (isBold[1]) {
        lcd.print("config pass ");
        lcd.print(encoder_pass);
      } else
        lcd.print("config Mode      ");

      // Restart option
      lcd.setCursor(0, 3);
      if (currentMenuIndex == 2)
        lcd.print(">");
      else
        lcd.print(" ");
      lcd.print("Restart ");
      lcd.print(flow_meter_value);
    }

    pre_encoder_pass = encoder_pass;
    previousMenuIndex = currentMenuIndex;
  }
}

//-----------------------------------------------------------------------------------------------------------------------------------------------

float measureWaterFlow() {
  int samples = 10;
  float adcSum = 0.0;
  float adcMean, mV, current_mA, flowRate;

  for (int i = 0; i < samples; i++) {
    adcSum += analogRead(FLOW_SENSOR_PIN);
    delayMicroseconds(100);
  }

  adcMean = adcSum / samples;
  mV = (adcMean / ADC_RESOLUTION) * V_REF;
  current_mA = mV / RESISTANCE_OHM;
  current_mA = (current_mA >= MIN_MA) ? current_mA : MIN_MA;
  flowRate = map(current_mA, MIN_MA, MAX_MA, MIN_FLOW, MAX_FLOW);
  return flowRate;
}

volatile unsigned long pulseCount = 0;

void IRAM_ATTR handlePulse() {
  flow_meter_value += leter_per_pulse;
}

void forcestopinterupt() {
  if (is_running) {
    is_running = false;
    RelayCloseDC(TIME_OPEN_DC + added_time, "closing_final");
    if (valve_type == "bump")
      digitalWrite(RELAY_OPEN, 0);
    if (!offline) {
      if (client.connected())
        client.publish((String(truck_id) + "/state").c_str(), "stop", true);
    }
  }
}

void car_number() {
  if (!offline && client.connected()) {
    client.publish("cam1/esp", "start");
  }
}

// ---------------------------------app begin---------------------------------------
void setup() {
#ifndef testing_mode
  delay(30000);
#endif
  LittleFS.begin();
  pinMode(RELAY_OPEN, OUTPUT);
  pinMode(RELAY_CLOSE, OUTPUT);
  pinMode(ENCODER_BUTTON, INPUT_PULLUP);
  pinMode(PUMP_PIN, OUTPUT);
  digitalWrite(PUMP_PIN, LOW);
  setupDisplay();

  manual = readFile("/manual.txt").toInt();

  if (manual) {
    String configData = readFile("/config.txt");
    if (configData.length() > 0)
      splitString(configData, ',', config, 15);
    offline = 1;
  }

  else {
    truck_id = readFile("/port_id.txt");
    ssid = readFile("/username.txt");
    password = readFile("/password.txt");
    mqtt_server = readFile("/mqtt_address.txt");
    esp_local_ip = readFile("/esp_local_ip.txt");
    esp_gateway = readFile("/gateway.txt");
    esp_subnet = readFile("/subnet.txt");

    local_IP.fromString(esp_local_ip);
    gateway.fromString(esp_gateway);
    subnet.fromString(esp_subnet);

    setup_wifi();
    client.setServer(mqtt_server.c_str(), mqtt_port);
    client.setCallback(callback);
    load_index_from_fs();

    while (!client.connected()) {

      unsigned long now = millis();
      if (now - lastReconnectAttempt > RECONNECT_INTERVAL_MS) {
        lastReconnectAttempt = now;
        reconnect();  // محاولة الاتصال مرة واحدة
      }
      handleEncoderActions();
    }

    client.publish((String(truck_id) + "/update").c_str(), "config", true);
    while (updated) {
      client.loop();
      handleEncoderActions();
    }
    client.publish((String(truck_id) + "/state").c_str(), "stop", true);
    // Save configurations to memory
    writeFile("/config.txt", message);
  }

  if (config[0] == "modbus") {
    SerialConfig frame;
    if (config[2] == "SERIAL_8N1")
      frame = SERIAL_8N1;
    else if (config[2] == "SERIAL_8N2")
      frame = SERIAL_8N2;
    else if (config[2] == "SERIAL_8O1")
      frame = SERIAL_8O1;
    else if (config[2] == "SERIAL_8O2")
      frame = SERIAL_8O2;
    else if (config[2] == "SERIAL_8E1")
      frame = SERIAL_8E1;
    else if (config[2] == "SERIAL_8E2")
      frame = SERIAL_8E2;

    pinMode(MAX485_RE_NEG, OUTPUT);
    pinMode(MAX485_DE, OUTPUT);
    postTransmission();
    Serial.begin(config[1].toInt(), frame);
    node.begin(config[4].toInt(), Serial);
    node.preTransmission(preTransmission);
    node.postTransmission(postTransmission);

    firstCloseTime = config[6].toInt();
    secondCloseTime = config[7].toInt();
    firstCloseLagV = config[8].toInt();
    secondCloseLagV = config[9].toInt();
    thirdCloseTime = config[10].toInt();
    added_time = config[11].toInt();
    register_type = config[13];
    valve_type = config[14];
    if (valve_type == "valve and bump")
      TIME_OPEN_DC = firstCloseTime + secondCloseTime + thirdCloseTime + added_time;
    else
      TIME_OPEN_DC = firstCloseTime + secondCloseTime + thirdCloseTime;
    while (1) {
      ESP.wdtFeed();
      yield();
      if (!client.connected() && !offline) {
        unsigned long now = millis();
        if (now - lastReconnectAttempt > RECONNECT_INTERVAL_MS) {
          lastReconnectAttempt = now;
          reconnect();  // محاولة الاتصال مرة واحدة
        }
      }
      modbus_loop();
    }
  }

  if (config[0] == "milli ampere") {

    MIN_MA = config[1].toInt();
    MAX_MA = config[2].toInt();
    RESISTANCE_OHM = config[3].toInt();
    firstCloseTime = config[4].toInt();
    secondCloseTime = config[5].toInt();
    firstCloseLagV = config[6].toInt();
    secondCloseLagV = config[7].toInt();
    thirdCloseTime = config[8].toInt();
    added_time = config[9].toInt();
    valve_type = config[10];
    if (valve_type == "valve and bump")
      TIME_OPEN_DC = firstCloseTime + secondCloseTime + thirdCloseTime + added_time;
    else
      TIME_OPEN_DC = firstCloseTime + secondCloseTime + thirdCloseTime;

    while (1) {
      ESP.wdtFeed();
      yield();
      if (!client.connected() && !offline) {
        unsigned long now = millis();
        if (now - lastReconnectAttempt > RECONNECT_INTERVAL_MS) {
          lastReconnectAttempt = now;
          reconnect();  // محاولة الاتصال مرة واحدة
        }
      }
      MA_loop();
    }
  }

  if (config[0] == "pulse") {

    pinMode(rx, INPUT_PULLUP);
    // attachInterrupt(digitalPinToInterrupt(rx), forcestopinterupt, FALLING);
    leter_per_pulse = (config[1].toFloat()) / 1000;
    firstCloseTime = config[2].toInt();
    secondCloseTime = config[3].toInt();
    firstCloseLagV = config[4].toInt();
    secondCloseLagV = config[5].toInt();
    thirdCloseTime = config[6].toInt();
    thirdCloseLagV = config[7].toInt();
    added_time = config[8].toInt();
    valve_type = config[9];
    if (valve_type == "valve and bump")
      TIME_OPEN_DC = firstCloseTime + secondCloseTime + thirdCloseTime + added_time;
    else
      TIME_OPEN_DC = firstCloseTime + secondCloseTime + thirdCloseTime;
    pinMode(D0, INPUT);
    pinMode(13, INPUT);
    attachInterrupt(digitalPinToInterrupt(13), handlePulse, RISING);
    while (1) {

      if (digitalRead(D0) == 1) {
        // car_number();
        captured = 0;
      } else if (digitalRead(D0) == 0 && !captured) {
        car_number();
        captured = 1;
      }
      ESP.wdtFeed();
      yield();
      if (!client.connected() && !offline) {
        unsigned long now = millis();
        if (now - lastReconnectAttempt > RECONNECT_INTERVAL_MS) {
          lastReconnectAttempt = now;
          reconnect();  // محاولة الاتصال مرة واحدة
        }
      }
      pulse_loop();
    }
  }
}

void modbus_loop() {

  if (offline) {
    scroll();
  } else {
    handleEncoderActions();
    client.loop();
  }

  flowmeter_reader();
  flow_rate_reader();

  if (is_running && !thirdCloseStatus) {
#ifdef testing_mode
    static unsigned long lastTestPulseTime = 0;
    if (millis() - lastTestPulseTime >= 500)
    { // Simulate a pulse every 100ms
      lastTestPulseTime = millis();
      flow_meter_value += 1;
    }
#endif
    if (!offline) {
      if (previousValveState != "open") {
        if (client.connected())
          client.publish((String(truck_id) + "/valve_state").c_str(), "open", true);
        previousValveState = "open";
      }
    }

    remain_Quantity = (flow_meter_prev_value + required_Quantity - flow_meter_value);

    if (flow_meter_value) {
      ExtraWater = (flow_rate_value / 2.0) * thirdCloseTime / litter;
    }

    if (offline && required_Quantity > 0) {
      int filled = required_Quantity - remain_Quantity;
      if (filled < 0)
        filled = 0;
      if (filled > required_Quantity)
        filled = required_Quantity;
      progressBar = map(filled, 0, required_Quantity, 0, 118);
      if (progressBar > 118)
        progressBar = 118;
      if (progressBar < 0)
        progressBar = 0;
    }

    if (remain_Quantity <= float(firstCloseLagV) / litter && firstCloseStatus == 0) {
      firstCloseStatus = 1;
      RelayCloseDC(firstCloseTime, "closing_first");
    }

    else if (remain_Quantity <= float(secondCloseLagV) / litter && secondCloseStatus == 0) {
      secondCloseStatus = 1;
      RelayCloseDC(secondCloseTime, "closing_second");
    }

    else if (remain_Quantity - ExtraWater / litter <= 0 && thirdCloseStatus == 0) {
      digitalWrite(PUMP_PIN, LOW);
      thirdCloseStatus = 1;
      RelayCloseDC(thirdCloseTime + added_time, "closing_final");
      if (valve_type == "bump")
        digitalWrite(RELAY_OPEN, 0);
      if (offline) {
        String logEntry = String("") + required_Quantity + "," + (flow_meter_value - flow_meter_prev_value) + "," + flow_meter_value + "," + flow_meter_prev_value;
        add_string_to_queue(logEntry.c_str());
        is_running = 0;
        isBold[1] = 0;
        isBold[2] = 0;
      }
      else
      {
        if (client.connected())
          client.publish((String(truck_id) + "/state").c_str(), "stop", true);
      }
    }
  }
}

void pulse_loop() {

  if (offline) {
    scroll();
  } else {
    handleEncoderActions();
    client.loop();
  }

  if (!digitalRead(rx))
    forcestopinterupt();

  static unsigned long lastPublishTime = 0;
  if (millis() - lastPublishTime > 100) {
    lastPublishTime = millis();

    if (!offline)
      pulse_calc();

    if (is_running && !thirdCloseStatus) {

      if (!offline) {
        if (previousValveState != "open") {
          if (client.connected())
            client.publish((String(truck_id) + "/valve_state").c_str(), "open", true);
          previousValveState = "open";
        }
      }

      remain_Quantity = (flow_meter_prev_value + required_Quantity - flow_meter_value);

      if (offline && required_Quantity > 0) {
        int filled = required_Quantity - remain_Quantity;
        if (filled < 0)
          filled = 0;
        if (filled > required_Quantity)
          filled = required_Quantity;
        progressBar = map(filled, 0, required_Quantity, 0, 118);
        if (progressBar > 118)
          progressBar = 118;
        if (progressBar < 0)
          progressBar = 0;
      }

      if (remain_Quantity <= float(firstCloseLagV) / litter && firstCloseStatus == 0) {
        RelayCloseDC(firstCloseTime, "closing_first");
        firstCloseStatus = 1;
      } else if (remain_Quantity <= float(secondCloseLagV) / litter && secondCloseStatus == 0) {
        RelayCloseDC(secondCloseTime + added_time, "closing_second");
        secondCloseStatus = 1;
      } else if (remain_Quantity <= float(thirdCloseLagV) / litter && thirdCloseStatus == 0) {
        RelayCloseDC(thirdCloseTime + added_time, "closing_final");
        if (valve_type == "bump")
          digitalWrite(RELAY_OPEN, 0);
        if (offline) {
          String logEntry = String("") + required_Quantity + "," + (flow_meter_value - flow_meter_prev_value) + "," + flow_meter_value;
          add_string_to_queue(logEntry.c_str());
          is_running = 0;
          isBold[1] = 0;
          isBold[2] = 0;
        } else {
          if (client.connected())
            client.publish((String(truck_id) + "/state").c_str(), "stop", true);
        }
        thirdCloseStatus = 1;
      }
    }
  }
}

void MA_loop() {

  handleEncoderActions();

  if (!offline && !client.connected()) {
    reconnect();
  }
  if (!offline)
    client.loop();
  static unsigned long lastPublishTime = 0;
  if (millis() - lastPublishTime > 100) {
    lastPublishTime = millis();
    if (is_running && thirdCloseStatus) {
      if (!offline && client.connected())
        client.publish((String(truck_id) + "/valve_state").c_str(), "open");
      float FlowRate = measureWaterFlow();
      ExtraWater = (FlowRate / 2.0) * thirdCloseTime / litter;
      if (remain_Quantity - ExtraWater / litter <= 0 && thirdCloseStatus == 0) {
        RelayCloseDC(thirdCloseTime + added_time, "closing_final");
        thirdCloseStatus = 1;
        if (!offline && client.connected())
          client.publish((String(truck_id) + "/state").c_str(), "stop");
      }
    }
  }
}

void loop() {
}