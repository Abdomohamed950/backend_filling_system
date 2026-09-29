#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <ModbusMaster.h>
#include <FS.h>
#include <LittleFS.h>
#include <ESP8266WebServer.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <Encoder.h>
#include "defines.h"
#include <LiquidCrystal_I2C.h>

// #define testing_mode
#define DEBUG_MODE

int rx = 3;
int encoder_pass = 0;
bool manual;
bool captured = 0;
String lastMqttState = "stop";
unsigned long lastReconnectAttempt = 0;
const unsigned long RECONNECT_INTERVAL_MS = 5000;
unsigned long reconnectIntervalMs = RECONNECT_INTERVAL_MS;
const unsigned long MAX_RECONNECT_INTERVAL_MS = 30000;
unsigned long reconnectPauseUntilMs = 0;
uint8_t reconnectFailures = 0;

typedef union
{
    uint32_t intVal;
    float f;
} int2f;

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

int MIN_MA = 4;  // Default 4-20mA sensor minimum
int MAX_MA = 20; // Default 4-20mA sensor maximum
int RESISTANCE_OHM = 250;
float leter_per_pulse;

#define MIN_FLOW 0.0
#define MAX_FLOW 100.0

int TIME_OPEN_DC;

// ==================== إضافة State Machines ====================

enum ValveState
{
    VALVE_CLOSED,
    VALVE_OPENING,
    VALVE_OPEN,
    VALVE_CLOSING_FIRST,
    VALVE_CLOSING_SECOND,
    VALVE_CLOSING_FINAL
};

enum FillingState
{
    FILLING_IDLE,
    FILLING_RUNNING,
    FILLING_CLOSING_FIRST,
    FILLING_CLOSING_SECOND,
    FILLING_CLOSING_FINAL,
    FILLING_COMPLETE,
    FILLING_EMERGENCY_STOP
};

ValveState currentValveState = VALVE_CLOSED;
FillingState currentFillingState = FILLING_IDLE;
String portState = "stop";
unsigned long stateStartTime = 0;

bool firstCloseDone = false;
bool secondCloseDone = false;
bool thirdCloseDone = false;
bool emergencyStopRequested = false;
bool actionInProgress = false;
const unsigned long MIN_ACTION_INTERVAL = 1000;
unsigned long lastActionTime = 0;

uint16_t result = 1;
volatile float flow_meter_value = 0;
volatile float flow_rate_value = 0;
volatile float flow_meter_prev_value = 0;
float remain_Quantity;
float required_Quantity = 0;
bool is_running = false;
bool is_closing = false;
bool updated = true;
String logdata = "";
bool force_stop = 1;
bool isButtonPressed = false;
unsigned long pressStartTime = 0;
String valve_type;

bool offline = false;
int litter = 1000;

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

WiFiClient espClient;
PubSubClient client(espClient);
ModbusMaster node;

// Pre-computed MQTT topics to avoid heap fragmentation
String topicFlowmeter;
String topicFlowRate;
String topicState;
String topicValveState;
String topicLogdata;
String topicUpdate;
String topicAvailability;
String topicDebug;

void initMqttTopics()
{
    topicFlowmeter = String(truck_id) + "/flowmeter";
    topicFlowRate = String(truck_id) + "/flow_rate";
    topicState = String(truck_id) + "/state";
    topicValveState = String(truck_id) + "/valve_state";
    topicLogdata = String(truck_id) + "/logdata";
    topicUpdate = String(truck_id) + "/update";
    topicAvailability = String(truck_id) + "/availability";
    topicDebug = String(truck_id) + "/debug";
}

// Debug logging helper - sends to Serial and MQTT
void debugLog(const char *category, const char *message)
{
#ifdef DEBUG_MODE
    Serial.printf("[%s] %s\n", category, message);
    if (!offline && client.connected() && topicDebug.length() > 0)
    {
        String debugMsg = String("[") + category + "] " + message;
        client.publish(topicDebug.c_str(), debugMsg.c_str());
    }
#endif
}

// Debug logging with value - for numeric data
void debugLogValue(const char *category, const char *message, float value)
{
#ifdef DEBUG_MODE
    Serial.printf("[%s] %s: %.3f\n", category, message, value);
    if (!offline && client.connected() && topicDebug.length() > 0)
    {
        String debugMsg = String("[") + category + "] " + message + ": " + String(value, 3);
        client.publish(topicDebug.c_str(), debugMsg.c_str());
    }
#endif
}

// Debug logging with unsigned long value - for timing data
void debugLogTime(const char *category, const char *message, unsigned long value)
{
#ifdef DEBUG_MODE
    Serial.printf("[%s] %s: %lu ms\n", category, message, value);
    if (!offline && client.connected() && topicDebug.length() > 0)
    {
        String debugMsg = String("[") + category + "] " + message + ": " + String(value) + " ms";
        client.publish(topicDebug.c_str(), debugMsg.c_str());
    }
#endif
}

int write_index = 0;

String config[15];

LiquidCrystal_I2C lcd(0x27, 20, 4);

// ==================== دوال State Management ====================

String valveStateToString(ValveState state)
{
    switch (state)
    {
    case VALVE_CLOSED:
        return "close";
    case VALVE_OPENING:
        return "opening";
    case VALVE_OPEN:
        return "open";
    case VALVE_CLOSING_FIRST:
        return "closing_first";
    case VALVE_CLOSING_SECOND:
        return "closing_second";
    case VALVE_CLOSING_FINAL:
        return "closing_final";
    default:
        return "unknown";
    }
}

String fillingStateToString(FillingState state)
{
    switch (state)
    {
    case FILLING_IDLE:
        return "idle";
    case FILLING_RUNNING:
        return "running";
    case FILLING_CLOSING_FIRST:
        return "closing_first";
    case FILLING_CLOSING_SECOND:
        return "closing_second";
    case FILLING_CLOSING_FINAL:
        return "closing_final";
    case FILLING_COMPLETE:
        return "complete";
    case FILLING_EMERGENCY_STOP:
        return "emergency_stop";
    default:
        return "unknown";
    }
}

void updateValveState(ValveState newState)
{
    if (currentValveState != newState)
    {
        currentValveState = newState;
        if (!offline && client.connected() && topicValveState.length() > 0)
        {
            String stateStr = valveStateToString(newState);
            client.publish(topicValveState.c_str(), stateStr.c_str(), true);
        }
        debugLog("VALVE", valveStateToString(newState).c_str());
    }
}

void updatePortState(String newState)
{
    if (portState != newState)
    {
        portState = newState;
        if (!offline && client.connected() && topicState.length() > 0)
            client.publish(topicState.c_str(), newState.c_str(), true);
        debugLog("PORT", newState.c_str());
    }
}

void updateFillingState(FillingState newState)
{
    if (currentFillingState != newState)
    {
        currentFillingState = newState;
        stateStartTime = millis();
        debugLog("FILLING", fillingStateToString(newState).c_str());
    }
}

// ==================== دالة Timeout الآمنة ====================

bool executeWithTimeout(void (*operation)(), unsigned long timeoutMs, const char *operationName)
{
    unsigned long startTime = millis();
    unsigned long lastPrintTime = 0;
    unsigned long lastYieldTime = millis();

    while (millis() - startTime < timeoutMs)
    {
        operation();

        ESP.wdtFeed();

        if (millis() - lastPrintTime > 5000)
        {
            debugLogTime("TIMEOUT", operationName, millis() - startTime);
            lastPrintTime = millis();
        }

        if (millis() - lastYieldTime > 100)
        {
            yield();
            lastYieldTime = millis();
        }

        if (emergencyStopRequested)
        {
            debugLog("EMERGENCY", operationName);
            return false;
        }

        if (currentValveState == VALVE_CLOSED || currentValveState == VALVE_OPEN)
        {
            break;
        }
    }

    if (millis() - startTime >= timeoutMs)
    {
        debugLogTime("TIMEOUT_ERR", operationName, timeoutMs);
        return false;
    }

    return true;
}

void setupDisplay()
{
    if (oled)
    {
        u8g2.begin(); // تهيئة شاشة OLED
    }
    else
    {
        lcd.init();      // initialize the lcd
        lcd.backlight(); // تشغيل الإضاءة الخلفية
    }
}

// ------------------------------------memory functions--------------------------------

void load_index_from_fs()
{
    File file = LittleFS.open("/index.txt", "r");
    if (!file || file.size() == 0)
    {
        write_index = 0;
    }
    else
    {
        write_index = file.parseInt();
    }
    file.close();
}

void save_index_to_fs()
{
    File file = LittleFS.open("/index.txt", "w");
    if (file)
    {
        file.println(write_index);
        file.close();
    }
}

void add_string_to_queue(const char *str)
{
    char filename[20];
    snprintf(filename, sizeof(filename), "/queue_%d.txt", write_index);

    File file = LittleFS.open(filename, "w");
    if (file)
    {
        file.println(str);
        file.close();
    }

    write_index = (write_index + 1) % QUEUE_SIZE;
    save_index_to_fs();
}

void sendlogs()
{

    lcd.setCursor(16, 1);
    lcd.print("SYNC");
    for (int i = 0; i < QUEUE_SIZE; i++)
    {
        char filename[20];
        snprintf(filename, sizeof(filename), "/queue_%d.txt", i);

        File file = LittleFS.open(filename, "r");
        if (file)
        {
            String content = file.readStringUntil('\n');
            if (content.length() > 0)
            { // Check if content is not empty
                if (client.connected() && topicLogdata.length() > 0)
                    client.publish(topicLogdata.c_str(), content.c_str());

                // Close the file before deleting it
                file.close();

                // Delete the file
                if (!LittleFS.remove(filename))
                {
                    debugLog("FS_ERR", filename);
                }
            }
            else
            {
                file.close();
            }
        }
    }
    lcd.setCursor(16, 1);
    lcd.print("    ");
}

void print_queue()
{
    for (int i = 0; i < QUEUE_SIZE; i++)
    {
        char filename[20];
        snprintf(filename, sizeof(filename), "/queue_%d.txt", i);

        File file = LittleFS.open(filename, "r");
        if (file)
        {
            String content = file.readStringUntil('\n');
            file.close();
        }
    }
}

// ------------------------------modbus functions------------------------------------
uint32_t AABBCCDD(uint16_t firstRecv, uint16_t secondRecv)
{
    uint8_t u1_right = firstRecv & 0x00ff;
    uint8_t u1_left = firstRecv >> 8;
    uint8_t u2_right = secondRecv & 0x00ff;
    uint8_t u2_left = secondRecv >> 8;
    return (((uint32_t)u2_right << 24) | ((uint32_t)u2_left << 16) | ((uint32_t)u1_right << 8) | (uint32_t)u1_left);
}

void preTransmission()
{
    digitalWrite(MAX485_RE_NEG, HIGH);
    digitalWrite(MAX485_DE, HIGH);
}

void postTransmission()
{
    digitalWrite(MAX485_RE_NEG, LOW);
    digitalWrite(MAX485_DE, LOW);
}

void flowmeter_reader()
{
#ifdef testing_mode
    static unsigned long lastPublishTime2 = 0; //
    if (flow_meter_value != previousFlowMeterValue && millis() - lastPublishTime2 > 500)
    {                                                                                                          //
        lastPublishTime2 = millis();                                                                           //
        if (client.connected())                                                                                //
            client.publish((String(truck_id) + "/flowmeter").c_str(), String(flow_meter_value).c_str(), true); //
        previousFlowMeterValue = flow_meter_value;                                                             //
    } //

#else

    uint32_t value;
    if (register_type == "HOLDING")
    {
        digitalWrite(MAX485_DE, 0);
        result = node.readHoldingRegisters(config[5].toInt(), REG_IN_ROW);
    }
    else
    {
        digitalWrite(MAX485_DE, 0);
        result = node.readInputRegisters(config[5].toInt(), REG_IN_ROW);
    }

    if (result == node.ku8MBSuccess)
    {
        notconnected_count = 0;
        uint16_t hi = node.getResponseBuffer(0);
        uint16_t lo = node.getResponseBuffer(1);
        if (config[3] == "AABBCCDD")
        {
            value = AABBCCDD(hi, lo);
            int2f int2f_obj;
            int2f_obj.intVal = value;
            flow_meter_value = int2f_obj.f;
        }
        else
        {
            union
            {
                uint16_t u16[2];
                float f;
            } floatData;

            floatData.u16[0] = hi;
            floatData.u16[1] = lo;
            flow_meter_value = floatData.f;
        }
        static unsigned long lastPublishTime = 0;
        if (!offline && flow_meter_value != previousFlowMeterValue && millis() - lastPublishTime > 500)
        {
            if (client.connected() && topicFlowmeter.length() > 0)
            {
                client.publish(topicFlowmeter.c_str(), String(flow_meter_value, 3).c_str(), true);
                previousFlowMeterValue = flow_meter_value;
            }
            lastPublishTime = millis();
        }
    }
    else
    {
        notconnected_count++;
        if (notconnected_count > 5)
        {
            if (!offline && previousFlowMeterValue != -1)
            {
                if (client.connected() && topicFlowmeter.length() > 0)
                {
                    // Send last known valid value instead of -1 to prevent premature stopping
                    client.publish(topicFlowmeter.c_str(), String(flow_meter_value, 3).c_str(), true);
                    debugLog("FLOW", "Using last valid value due to connection issues");
                }
                // Don't set previousFlowMeterValue to -1, keep last valid value
            }
        }
    }
#endif
}

void flow_rate_reader()
{
#ifdef testing_mode
    flow_rate_value = 0;
    static unsigned long lastPublishTimee = 0;
    if (millis() - lastPublishTimee > 500)
    {
        // Send flow_rate via debug topic instead of regular MQTT
        debugLogValue("FLOW", "rate", flow_rate_value);
        previousFlowRateValue = flow_rate_value;
        lastPublishTimee = millis();
    }

#else
    // قراءة flow_rate فقط كل 200ms لتسريع الـ loop (flowmeter أهم)
    static unsigned long lastReadTime = 0;
    if (millis() - lastReadTime < 1000)
    {
        return; // استخدم القيمة السابقة
    }
    lastReadTime = millis();

    uint32_t value;
    if (register_type == "HOLDING")
    {
        digitalWrite(MAX485_DE, 0);
        result = node.readHoldingRegisters(config[12].toInt(), REG_IN_ROW);
    }
    else
    {
        digitalWrite(MAX485_DE, 0);
        result = node.readInputRegisters(config[12].toInt(), REG_IN_ROW);
    }

    if (result == node.ku8MBSuccess)
    {
        uint16_t hi = node.getResponseBuffer(0);
        uint16_t lo = node.getResponseBuffer(1);

        if (config[3] == "AABBCCDD")
        {
            value = AABBCCDD(hi, lo);
            int2f int2f_obj;
            int2f_obj.intVal = value;
            flow_rate_value = int2f_obj.f;
        }
        else
        {
            union
            {
                uint16_t u16[2];
                float f;
            } floatData;

            floatData.u16[0] = hi;
            floatData.u16[1] = lo;
            flow_rate_value = floatData.f;
        }
    }
    static unsigned long lastPublishTimee = 0;
    if (millis() - lastPublishTimee > 100)
    {
        // Send flow_rate via debug topic instead of regular MQTT
        debugLogValue("FLOW", "rate", flow_rate_value);
        previousFlowRateValue = flow_rate_value;

        // Send ExtraWater every 100ms
        if (flow_rate_value > 0)
        {
            float extraWaterCalc = (flow_rate_value / 2.0) * (float)thirdCloseTime / litter;
            debugLogValue("CALC", "ExtraWater", extraWaterCalc);
            debugLogValue("CALC", "Remaining", remain_Quantity);
        }

        lastPublishTimee = millis();
    }
#endif
}
void pulse_calc()
{
    static unsigned long lastPublishTime = 0;
    if (flow_meter_value != previousFlowMeterValue && millis() - lastPublishTime > 500)
    {
        if (client.connected() && topicFlowmeter.length() > 0)
        {
            client.publish(topicFlowmeter.c_str(), String(flow_meter_value).c_str(), true);
            previousFlowMeterValue = flow_meter_value;
        }
        lastPublishTime = millis();
    }
}

// ------------------------------------valve functions-------------------------------
void RelayOpenDC(void)
{
    if (valve_type == "valve" || valve_type == "valve and bump")
    {
        updateValveState(VALVE_OPENING);

        digitalWrite(RELAY_CLOSE, LOW);
        digitalWrite(RELAY_OPEN, HIGH);

        unsigned long operationStartTime = millis();

        while ((millis() - operationStartTime < TIME_OPEN_DC))
        {
            ESP.wdtFeed();
            yield();

            if (offline)
            {
                scroll();
            }
            else
            {
                handleEncoderActions();

                static unsigned long last = 0;
                if (millis() - last > 100)
                {
                    last = millis();
                    if (config[0] == "modbus")
                    {
                        flowmeter_reader();
                        flow_rate_reader();
                    }

                    // إرسال حالة opening مرة واحدة فقط
                    static bool openingPublished = false;
                    if (!openingPublished && !offline && client.connected())
                    {
                        client.publish((String(truck_id) + "/valve_state").c_str(), "opening", true);
                        openingPublished = true;
                    }

                    if (!offline)
                        client.loop();
                }
            }

            // Timeout safety - إغلاق الطوارئ إذا تجاوز الوقت
            if (millis() - operationStartTime > (TIME_OPEN_DC * 2))
            {
                debugLogTime("VALVE_ERR", "Opening timeout", millis() - operationStartTime);
                emergencyStopRequested = true;
                break;
            }
        }

        digitalWrite(RELAY_OPEN, LOW);
        digitalWrite(PUMP_PIN, HIGH);
        updateValveState(VALVE_OPEN);
    }
}

void RelayCloseDC(uint32_t closeTime)
{
    if (valve_type == "valve" || valve_type == "valve and bump")
    {
        // تحديث حالة الصمام بناءً على مرحلة الإغلاق الحالية
        // Logic: We're about to close, so determine which stage we're entering
        if (secondCloseDone && !thirdCloseDone)
        {
            updateValveState(VALVE_CLOSING_FINAL);
        }
        else if (firstCloseDone && !secondCloseDone)
        {
            updateValveState(VALVE_CLOSING_SECOND);
        }
        else
        {
            updateValveState(VALVE_CLOSING_FIRST);
        }

        digitalWrite(RELAY_OPEN, LOW);
        digitalWrite(RELAY_CLOSE, HIGH);

        unsigned long operationStartTime = millis();
        unsigned long targetTime = closeTime;

        // إضافة margin أمان 20%
        unsigned long timeoutMs = targetTime * 1.2;

        while ((millis() - operationStartTime < targetTime))
        {
            ESP.wdtFeed();
            yield();

            if (offline)
                scroll();
            else
                handleEncoderActions();

            static unsigned long lasst = 0;
            if (millis() - lasst > 100)
            {
                lasst = millis();
                if (config[0] == "modbus")
                {
                    flowmeter_reader();
                    flow_rate_reader();
                }

                if (!offline)
                    client.loop();
            }

            // Timeout safety
            if (millis() - operationStartTime > timeoutMs)
            {
                debugLogTime("VALVE_ERR", "Closing timeout", millis() - operationStartTime);
                emergencyStopRequested = true;
                break;
            }
        }

        digitalWrite(RELAY_CLOSE, LOW);

        // تحديث الحالة النهائية
        if (thirdCloseDone)
        {
            updateValveState(VALVE_CLOSED);
        }
        else
        {
            // إذا لم يكن الإغلاق النهائي، الصمام مازال مفتوحاً
            updateValveState(VALVE_OPEN);
        }
    }
}

// --------------------------------------wifi function------------------------------
String readFile(const char *path)
{
    File file = LittleFS.open(path, "r");
    if (!file)
        return "";
    String content = file.readString();
    file.close();
    return content;
}

// Function to write values
void writeFile(const char *path, String message)
{
    File file = LittleFS.open(path, "w");
    if (file)
    {
        file.print(message);
        file.close();
    }
}

ESP8266WebServer server(80);

void setup_wifi()
{

    WiFi.config(local_IP, gateway, subnet, dns);
    WiFi.begin(ssid, password);
    unsigned long startAttemptTime = millis();

    while (WiFi.status() != WL_CONNECTED && millis() - startAttemptTime < 10000)
    {
        delay(500);
    }

    if (WiFi.status() == WL_CONNECTED)
    {
        lcd.setCursor(0, 0);
        lcd.print("network");
    }
    else
    {
        startAPMode();
    }
}

void startAPMode()
{
    if (oled)
    {
        u8g2.clearBuffer();
        u8g2.setFont(u8g2_font_6x12_tf);
        u8g2.setCursor(0, 10);
        u8g2.print("start config mode");
        u8g2.sendBuffer();
    }
    else
    {
        lcd.setCursor(0, 0);
        lcd.print("start config mode   ");
    }
    WiFi.softAP(ap_ssid, ap_password);

    server.on("/", handleRoot);
    server.on("/submit", HTTP_POST, handleFormSubmit);
    server.begin();
    while (1)
    {
        ESP.wdtFeed();
        yield();
        handleEncoderActions();
        server.handleClient();
        static unsigned long lastRestartTime = millis();
        if (millis() - lastRestartTime >= 600000)
        {
            ESP.restart();
        }
    }
}

void handleRoot()
{
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

void handleFormSubmit()
{
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
void callback(char *topic, byte *payload, unsigned int length)
{
    message = "";
    String topicStr = String(topic);

    for (int i = 0; i < length; i++)
    {
        message += (char)payload[i];
    }

    if (topicStr == String(truck_id) + "/quantity")
    {
        float qty = message.toFloat();
        // Validate quantity - must be positive and reasonable
        if (qty > 0 && qty < 100)
        {
            required_Quantity = qty;
            flow_meter_prev_value = flow_meter_value;
            updatePortState("filling");
        }
        else
        {
            debugLog("MQTT_WARN", ("Invalid qty: " + message).c_str());
        }
        // if (client.connected())
        //     client.publish((String(truck_id) + "/state").c_str(), "filling", true);
    }

    else if (topicStr == String(truck_id) + "/logdata")
        logdata = message;

    else if (topicStr == String(truck_id) + "/reset")
        ESP.restart();

    else if (topicStr == String(truck_id) + "/state")
    {
        lastMqttState = message;
        if (message == "start")
        {
            is_running = true;
            firstCloseDone = false;
            secondCloseDone = false;
            thirdCloseDone = false;
            updateFillingState(FILLING_RUNNING);
            RelayOpenDC();
            if (valve_type == "bump")
                digitalWrite(RELAY_OPEN, 1);
            updateValveState(VALVE_OPEN);
        }

        // else if (message == "stop")
        // {
        //     is_running = false;
        //     updateValveState(VALVE_CLOSED);
        // }

        else if (message == "force_stop")
        {
            emergencyStopRequested = true;
            updateFillingState(FILLING_EMERGENCY_STOP);
            updatePortState("stoping");
            // if (client.connected())
            //     client.publish((String(truck_id) + "/state").c_str(), "stoping", true);
            digitalWrite(PUMP_PIN, LOW);
            RelayCloseDC(TIME_OPEN_DC + added_time);
            if (valve_type == "bump")
                digitalWrite(RELAY_OPEN, 0);
            updatePortState("stop");
            // if (client.connected())
            //     client.publish((String(truck_id) + "/state").c_str(), "stop", true);
        }
    }

    else if (topicStr == String(truck_id) + "/conf")
    {
        splitString(message, ',', config, 15);
        updated = false;
    }

    else if (topicStr == String(truck_id) + "/send_logs")
    {
        sendlogs();
    }

    else if (topicStr == String(truck_id) + "/recapture")
    {
        captured = 0;
    }
}

void splitString(const String &str, char delimiter, String result[], int maxParts)
{
    int currentIndex = 0;
    int startIndex = 0;
    int endIndex = str.indexOf(delimiter);

    while (endIndex >= 0 && currentIndex < maxParts - 1)
    {
        result[currentIndex++] = str.substring(startIndex, endIndex);
        startIndex = endIndex + 1;
        endIndex = str.indexOf(delimiter, startIndex);
    }
    result[currentIndex] = str.substring(startIndex);
}

void reconnect()
{

    lcd.setCursor(8, 0);
    lcd.print("    ");

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

    if (client.connect(clientIdStr.c_str(), willTopic, 1, true, willMessage))
    {
        lcd.setCursor(8, 0);
        lcd.print("mqtt");

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
bool isBold[4] = {false, false, false, false};

void drawMenu_oled()
{
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

void drawMenu_lcd()
{
    // استخدام clear مرة واحدة فقط لتجنب الرعشة المتكررة
    static bool firstDraw = true;
    if (firstDraw)
    {
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
    for (int i = row0.length(); i < 20; i++)
    {
        lcd.print(" ");
    }

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
    for (int i = row1Start.length(); i < 10; i++)
    {
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
    for (int i = row1Stop.length(); i < 10; i++)
    {
        lcd.print(" ");
    }

    // **Automatic Mode Row**
    lcd.setCursor(0, 2);
    if (currentMenuIndex == 3)
        lcd.print(">");
    else
        lcd.print(" ");
    if (isBold[3])
    {
        lcd.print("automatic pass: ");
        lcd.print(encoder_pass);
        // مسح باقي السطر
        String row2 = String(currentMenuIndex == 3 ? ">" : " ") + "automatic pass: " + String(encoder_pass);
        for (int i = row2.length(); i < 20; i++)
        {
            lcd.print(" ");
        }
    }
    else
    {
        lcd.print("automatic mode ");
        // مسح باقي السطر
        String row2 = String(currentMenuIndex == 3 ? ">" : " ") + "automatic mode ";
        for (int i = row2.length(); i < 20; i++)
        {
            lcd.print(" ");
        }
    }
}

int previousQuantity = -1;  // Initialize with an invalid value
int previousMenuIndex = -1; // Initialize with an invalid value
int pre_encoder_pass = -1;
int pr_flow_meter_value = -1;
bool previousIsRunning = false; // لتتبع حالة is_running
bool previousIsClosing = false; // لتتبع حالة is_closing
bool press = 0;

void scroll()
{
    int newEncoderPos = myEnc.read() / 4;

    if (newEncoderPos != lastEncoderPos)
    {
        if (editingQuantity)
        {
            quantity += (newEncoderPos > lastEncoderPos) ? 1 : -1;
            if (quantity < 0)
                quantity = 0;
            lastEncoderPos = newEncoderPos;
        }

        if (pass_edit)
        {
            encoder_pass += (newEncoderPos > lastEncoderPos) ? 1 : -1;
            if (encoder_pass < 0)
                encoder_pass = 0;
            lastEncoderPos = newEncoderPos;
        }

        else
        {

            currentMenuIndex += (newEncoderPos > lastEncoderPos) ? 1 : -1;
            if (currentMenuIndex < 0)
                currentMenuIndex = 0;
            if (currentMenuIndex > 3)
                currentMenuIndex = 3;
            lastEncoderPos = newEncoderPos;
        }
    }

    static unsigned long lastDebounceTime = 0;
    static unsigned long lastActionTime = 0;        // لمنع الضغطات المتكررة السريعة
    static bool lastButtonState = LOW;              // لتتبع حالة الزر السابقة
    const unsigned long ACTION_DEBOUNCE_TIME = 500; // 500ms بين كل action

    bool currentButtonState = digitalRead(ENCODER_BUTTON);

    // Edge detection - only trigger on button press (LOW to HIGH transition)
    if (currentButtonState == HIGH && lastButtonState == LOW && millis() - lastDebounceTime > 50)
    {
        lastDebounceTime = millis();

        // منع الضغطات المتكررة السريعة (debounce للـ actions)
        if (millis() - lastActionTime < ACTION_DEBOUNCE_TIME)
        {
            return;
        }
        lastActionTime = millis();

        press = 1;

        // فقط للـ quantity والـ automatic mode نستخدم isBold
        if (currentMenuIndex == 0 || currentMenuIndex == 3)
        {
            isBold[currentMenuIndex] = !isBold[currentMenuIndex];
        }

        if (currentMenuIndex == 0)
        {
            editingQuantity = !editingQuantity;
        }
        else if (currentMenuIndex == 1)
        {
            // Start - فقط لو التعبئة مش شغالة
            if (!is_running)
            {
                startFunction();
            }
        }
        else if (currentMenuIndex == 2)
        {
            // Stop - يسمح بالإغلاق حتى لو الصمام مغلق (لإغلاق أكتر)
            // لكن يمنع لو جاري الإغلاق حالياً
            stopFunction();
        }
        else if (currentMenuIndex == 3)
        {
            pass_edit = !pass_edit;
            if (encoder_pass == 12)
            {
                encoder_pass = 0;
                writeFile("/manual.txt", "0");
                ESP.restart();
            }
            else
            {
                encoder_pass = 0;
            }
        }
    }
    lastButtonState = currentButtonState; // Update button state for edge detection

    // Update the display only if values have changed
    static unsigned long lastUpdateTime = 0;
    // تحديث الشاشة لو:
    // - مر ثانية (للتحديث الدوري)
    // - تغيرت القيم المهمة
    // - تغيرت حالة is_running أو is_closing (للتحديث الفوري)
    if (millis() - lastUpdateTime >= 1000 || previousQuantity != quantity || press || previousMenuIndex != currentMenuIndex || pre_encoder_pass != encoder_pass || previousIsRunning != is_running || previousIsClosing != is_closing)
    {
        lastUpdateTime = millis();
        press = 0;
        if (oled)
        {
            drawMenu_oled();
        }
        else
        {
            drawMenu_lcd();
        }
        previousQuantity = quantity;
        previousMenuIndex = currentMenuIndex;
        pre_encoder_pass = encoder_pass;
        pr_flow_meter_value = flow_meter_value;
        previousIsRunning = is_running;
        previousIsClosing = is_closing;
        isButtonPressed = false; // Reset the button press flag after updating the display
    }

    static unsigned long lastDrawTime = 0;
    if (millis() - lastDrawTime >= 100)
    {
        lastDrawTime = millis();
        if (!oled)
        {
            drawProgressBar_lcd();
        }
    }
}

void drawProgressBar_oled()
{
    u8g2.drawFrame(5, 55, 118, 8);
    u8g2.drawBox(5, 55, progressBar, 8);
}

void drawProgressBar_lcd()
{
    lcd.setCursor(0, 3);
    int progressBlocks = (progressBar * 18) / 100; // Assuming 100 is max progress

    lcd.print("[");
    for (int i = 0; i < 18; i++)
    {
        if (i < progressBlocks)
        {
            lcd.print("#");
        }
        else
        {
            lcd.print(" ");
        }
    }
    lcd.print("]");
}

void startFunction()
{
    // منع العمليات المتداخلة
    if (actionInProgress)
    {
        debugLog("ACTION", "Busy - ignoring start");
        return;
    }

    if (millis() - lastActionTime < MIN_ACTION_INTERVAL)
    {
        debugLog("ACTION", "Too soon after last action");
        return;
    }

    // التحقق من الشروط المسبقة
    if (is_running)
    {
        debugLog("ACTION", "Already running");
        return;
    }

    if (quantity <= 0)
    {
        debugLog("ACTION", "Invalid quantity");
        return;
    }

    if (valve_type.length() == 0)
    {
        debugLog("ACTION", "Valve type not configured");
        return;
    }

    // بدء العملية
    actionInProgress = true;
    lastActionTime = millis();

    debugLog("ACTION", "Starting filling process");

    // إعادة تعيين أعلام الإغلاق
    firstCloseDone = false;
    secondCloseDone = false;
    thirdCloseDone = false;
    emergencyStopRequested = false;

    // إعداد التعبئة
    progressBar = 0;
    is_running = true;
    flow_meter_prev_value = flow_meter_value;
    required_Quantity = quantity;

    // تحديث الحالة
    updateFillingState(FILLING_RUNNING);

    // فتح الصمام/المضخة
    if (valve_type == "bump")
    {
        digitalWrite(RELAY_OPEN, 1);
        updateValveState(VALVE_OPEN);
    }
    else
    {
        RelayOpenDC();
    }

    actionInProgress = false;
}

// دالة الإيقاف
void stopFunction()
{
    // منع العمليات المتداخلة
    if (actionInProgress)
    {
        debugLog("ACTION", "Busy - ignoring stop");
        return;
    }

    if (millis() - lastActionTime < MIN_ACTION_INTERVAL)
    {
        debugLog("ACTION", "Too soon after last action");
        return;
    }

    // التحقق مما إذا كان الصمام جاري الإغلاق حالياً
    if (currentValveState == VALVE_CLOSING_FIRST || currentValveState == VALVE_CLOSING_SECOND || currentValveState == VALVE_CLOSING_FINAL)
    {
        debugLog("ACTION", "Valve already closing");
        return;
    }

    // بدء العملية
    actionInProgress = true;
    lastActionTime = millis();

    debugLog("ACTION", "Stopping filling process");

    if (is_running)
    {
        is_running = false;
        isBold[1] = false;
    }

    isBold[2] = false;

    // إغلاق الصمام
    if (valve_type.length() > 0)
    {
        updateFillingState(FILLING_CLOSING_FINAL);
        RelayCloseDC(firstCloseTime + secondCloseTime + thirdCloseTime + added_time);

        if (valve_type == "bump")
            digitalWrite(RELAY_OPEN, 0);

        updateFillingState(FILLING_COMPLETE);
    }

    // إعادة تعيين الحالات
    firstCloseDone = false;
    secondCloseDone = false;
    thirdCloseDone = false;

    actionInProgress = false;
}

void handleEncoderActions()
{
    int newEncoderPos = myEnc.read() / 4;

    if (newEncoderPos != lastEncoderPos)
    {

        if (pass_edit)
        {
            encoder_pass += (newEncoderPos > lastEncoderPos) ? 1 : -1;
            if (encoder_pass < 0)
                encoder_pass = 0;
            lastEncoderPos = newEncoderPos;
        }
        else
        {
            currentMenuIndex += (newEncoderPos > lastEncoderPos) ? 1 : -1;
            if (currentMenuIndex < 0)
                currentMenuIndex = 0;
            if (currentMenuIndex > 2)
                currentMenuIndex = 2;
            lastEncoderPos = newEncoderPos;
        }
    }

    static unsigned long lastDebounceTime = 0;
    static bool lastBtnState = LOW;
    bool currentBtnState = digitalRead(ENCODER_BUTTON);

    // Edge detection - non-blocking button handling
    if (currentBtnState == HIGH && lastBtnState == LOW && millis() - lastDebounceTime > 50)
    {
        lastDebounceTime = millis();
        isBold[currentMenuIndex] = !isBold[currentMenuIndex];
        if (currentMenuIndex == 0)
        {
            pass_edit = !pass_edit;
            if (encoder_pass == 12)
            {
                encoder_pass = 0;
                writeFile("/manual.txt", "1");
                ESP.restart();
            }
            else
            {
                encoder_pass = 0;
            }
        }
        else if (currentMenuIndex == 1)
        {
            pass_edit = !pass_edit;
            if (encoder_pass == 12)
            {
                encoder_pass = 0;
                startAPMode();
            }
            else
            {
                encoder_pass = 0;
            }
        }
        else if (currentMenuIndex == 2)
        {
            ESP.restart();
        }
        press = 1;
    }
    lastBtnState = currentBtnState; // Update for edge detection

    static unsigned long lastUpdateTime = 0;
    if (pre_encoder_pass != encoder_pass || previousMenuIndex != currentMenuIndex || press || millis() - lastUpdateTime >= 1000)
    {
        lastUpdateTime = millis();
        press = 0;
        // Update the display
        if (oled)
        {
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
        }
        else
        {
            // manual mode
            lcd.setCursor(0, 1);
            if (currentMenuIndex == 0)
                lcd.print(">");
            else
                lcd.print(" ");
            if (isBold[0])
            {
                lcd.print("manual pass ");
                lcd.print(encoder_pass);
            }
            else
                lcd.print("manual mode     ");

            // AP Mode option
            lcd.setCursor(0, 2);
            if (currentMenuIndex == 1)
                lcd.print(">");
            else
                lcd.print(" ");
            if (isBold[1])
            {
                lcd.print("config pass ");
                lcd.print(encoder_pass);
            }
            else
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

float measureWaterFlow()
{
    int samples = 10;
    float adcSum = 0.0;
    float adcMean, mV, current_mA, flowRate;

    for (int i = 0; i < samples; i++)
    {
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

void IRAM_ATTR handlePulse()
{
    pulseCount++; // Atomic increment - safer than float operations in ISR
}

// Call this in main loop to update flow_meter_value from pulse count
void updateFlowFromPulses()
{
    noInterrupts();
    unsigned long count = pulseCount;
    interrupts();
    flow_meter_value = count * leter_per_pulse;
}

void forcestopinterupt()
{
    if (is_running)
    {
        is_running = false;
        RelayCloseDC(TIME_OPEN_DC + added_time);
        if (valve_type == "bump")
            digitalWrite(RELAY_OPEN, 0);
        if (!offline)
        {
            updatePortState("stop");
            // if (client.connected())
            //     client.publish((String(truck_id) + "/state").c_str(), "stop", true);
        }
    }
}

void car_number()
{
    if (!offline && client.connected())
    {
        client.publish("cam1/esp", "start");
    }
}

// ============ دوال معالجة الحالات الجديدة ============

void handleFillingRunningState()
{
    if (!is_running || thirdCloseDone)
    {
        updateFillingState(FILLING_IDLE);
        return;
    }

#ifdef testing_mode
    static unsigned long lastTestPulseTime = 0;
    if (millis() - lastTestPulseTime >= 500 && !firstCloseDone)
    {
        lastTestPulseTime = millis();
        flow_meter_value += 1;
    }
#endif

    // تحديث حالة الصمام إذا لم تكن open بالفعل
    if (currentValveState != VALVE_OPEN)
    {
        updateValveState(VALVE_OPEN);
    }

    // حساب الكمية المتبقية
    remain_Quantity = (flow_meter_prev_value + required_Quantity - flow_meter_value);

    // حساب الماء الإضافي للتوقف
    if (flow_rate_value > 0)
    {
        ExtraWater = (flow_rate_value / 2.0) * thirdCloseTime / litter;
    }

    // تحديث progress bar للوضع offline
    if (offline && required_Quantity > 0)
    {
        int filled = required_Quantity - remain_Quantity;
        filled = constrain(filled, 0, required_Quantity);
        progressBar = map(filled, 0, required_Quantity, 0, 118);
    }

    // ============ منطق الإغلاق التدريجي المحسّن ============

    // التحقق من شروط الإغلاق بترتيب صارم
    if (!firstCloseDone && remain_Quantity <= float(firstCloseLagV) / litter)
    {
        debugLogValue("FILLING", "First close at remain", remain_Quantity);

        firstCloseDone = true;
        updateFillingState(FILLING_CLOSING_FIRST);
        RelayCloseDC(firstCloseTime);

        // العودة لحالة التشغيل بعد الإغلاق الأول
        updateFillingState(FILLING_RUNNING);
    }
    else if (!secondCloseDone && remain_Quantity <= float(secondCloseLagV) / litter)
    {
        debugLogValue("FILLING", "Second close at remain", remain_Quantity);

        // تأكد من أن الإغلاق الأول تم
        if (!firstCloseDone)
        {
            debugLog("WARNING", "Second close before first! Executing first...");
            firstCloseDone = true;
            RelayCloseDC(firstCloseTime);
        }

        secondCloseDone = true;
        updateFillingState(FILLING_CLOSING_SECOND);
        RelayCloseDC(secondCloseTime);

        // العودة لحالة التشغيل بعد الإغلاق الثاني
        updateFillingState(FILLING_RUNNING);
    }
    else if (!thirdCloseDone && (remain_Quantity * 1000 - ExtraWater) <= 0)
    {
        debugLogValue("FILLING", "Final close at remain", remain_Quantity);

        // تأكد من أن الإغلاقين الأوليين تمّا
        if (!firstCloseDone)
        {
            debugLog("WARNING", "Final close before first! Executing first...");
            firstCloseDone = true;
            RelayCloseDC(firstCloseTime);
        }

        if (!secondCloseDone)
        {
            debugLog("WARNING", "Final close before second! Executing second...");
            secondCloseDone = true;
            RelayCloseDC(secondCloseTime);
        }

        digitalWrite(PUMP_PIN, LOW);
        thirdCloseDone = true;
        updateFillingState(FILLING_CLOSING_FINAL);
        RelayCloseDC(thirdCloseTime + added_time);

        if (valve_type == "bump")
            digitalWrite(RELAY_OPEN, 0);

        // الانتقال لحالة الإكمال
        updateFillingState(FILLING_COMPLETE);
    }
}

void handleFillingClosingFirstState()
{
    // هذه الحالة تكون نشطة أثناء تنفيذ RelayCloseDC في الإغلاق الأول
    // بعد انتهاء RelayCloseDC، ستعود لـ FILLING_RUNNING
    // Use stateStartTime from updateFillingState() - it's updated on each state change

    // Timeout للإغلاق الأول
    if (millis() - stateStartTime > (firstCloseTime * 2))
    {
        debugLogTime("ERROR", "First close timeout", millis() - stateStartTime);
        emergencyStopRequested = true;
        updateFillingState(FILLING_EMERGENCY_STOP);
    }
}

void handleFillingClosingSecondState()
{
    // منطق مشابه للإغلاق الأول - use global stateStartTime

    if (millis() - stateStartTime > (secondCloseTime * 2))
    {
        debugLogTime("ERROR", "Second close timeout", millis() - stateStartTime);
        emergencyStopRequested = true;
        updateFillingState(FILLING_EMERGENCY_STOP);
    }
}

void handleFillingClosingFinalState()
{
    // Use global stateStartTime instead of static variable
    unsigned long finalCloseTime = thirdCloseTime + added_time;

    if (millis() - stateStartTime > (finalCloseTime * 2))
    {
        debugLogTime("ERROR", "Final close timeout", millis() - stateStartTime);
        emergencyStopRequested = true;
        updateFillingState(FILLING_EMERGENCY_STOP);
    }
}

void handleFillingCompleteState()
{
    // إجراءات ما بعد الإكمال
    if (offline)
    {
        String logEntry = String("") + required_Quantity + "," + (flow_meter_value - flow_meter_prev_value) + "," + flow_meter_value + "," + flow_meter_prev_value;
        add_string_to_queue(logEntry.c_str());
        is_running = false;
        isBold[1] = false;
        isBold[2] = false;

        // إعادة تعيين أعلام الإغلاق
        firstCloseDone = false;
        secondCloseDone = false;
        thirdCloseDone = false;

        // العودة للحالة الخاملة
        updateFillingState(FILLING_IDLE);
        updateValveState(VALVE_CLOSED);
    }
    else
    {
        updatePortState("stop");
        // if (client.connected())
        // {
        //     client.publish((String(truck_id) + "/state").c_str(), "stop", true);
        // }

        // الانتقال لحالة الإكمال المؤقت - use stateStartTime set by updateFillingState
        if (millis() - stateStartTime > 2000)
        { // انتظار 2 ثانية
            // إعادة تعيين أعلام الإغلاق
            firstCloseDone = false;
            secondCloseDone = false;
            thirdCloseDone = false;

            // العودة للحالة الخاملة
            updateFillingState(FILLING_IDLE);
            updateValveState(VALVE_CLOSED);
            is_running = false;
        }
    }
}

void handleFillingEmergencyState()
{
    // إجراءات الطوارئ
    digitalWrite(PUMP_PIN, LOW);
    digitalWrite(RELAY_OPEN, LOW);
    digitalWrite(RELAY_CLOSE, LOW);

    is_running = false;
    emergencyStopRequested = false;

    debugLog("EMERGENCY", "System stopped!");

    // إعادة تعيين كل شيء
    firstCloseDone = false;
    secondCloseDone = false;
    thirdCloseDone = false;

    updateFillingState(FILLING_IDLE);
    updateValveState(VALVE_CLOSED);

    updatePortState("emergency_stop");
    // if (!offline && client.connected())
    // {
    //     client.publish((String(truck_id) + "/state").c_str(), "emergency_stop", true);
    // }
}

void checkSystemTimeouts()
{
    unsigned long currentTime = millis();

    // Timeout للتعبئة العامة
    if (currentFillingState == FILLING_RUNNING && currentTime - stateStartTime > 3600000)
    { // ساعة واحدة
        debugLogTime("TIMEOUT", "Filling exceeded 1 hour", currentTime - stateStartTime);
        updateFillingState(FILLING_EMERGENCY_STOP);
    }

    // Timeout لأي حالة إغلاق
    if ((currentFillingState == FILLING_CLOSING_FIRST || currentFillingState == FILLING_CLOSING_SECOND || currentFillingState == FILLING_CLOSING_FINAL) && currentTime - stateStartTime > 120000)
    { // دقيقتان
        debugLogTime("TIMEOUT", "Closing state too long", currentTime - stateStartTime);
        updateFillingState(FILLING_EMERGENCY_STOP);
    }
}

// ============ دوال loop الرئيسية المعدلة ============

void modbus_loop()
{
    if (offline)
    {
        scroll();
    }
    else
    {
        handleEncoderActions();
        client.loop();
    }

    flowmeter_reader();
    flow_rate_reader();

    switch (currentFillingState)
    {
    case FILLING_IDLE:
        break;

    case FILLING_RUNNING:
        handleFillingRunningState();
        break;

    case FILLING_CLOSING_FIRST:
        handleFillingClosingFirstState();
        break;

    case FILLING_CLOSING_SECOND:
        handleFillingClosingSecondState();
        break;

    case FILLING_CLOSING_FINAL:
        handleFillingClosingFinalState();
        break;

    case FILLING_COMPLETE:
        handleFillingCompleteState();
        break;

    case FILLING_EMERGENCY_STOP:
        handleFillingEmergencyState();
        break;
    }

    checkSystemTimeouts();
}

void pulse_loop()
{
    // Update flow meter from atomic pulse counter
    updateFlowFromPulses();

    if (offline)
    {
        scroll();
    }
    else
    {
        handleEncoderActions();
        client.loop();
    }

    if (!digitalRead(rx))
        forcestopinterupt();

    static unsigned long lastPublishTime = 0;
    if (millis() - lastPublishTime > 100)
    {
        lastPublishTime = millis();

        if (!offline)
            pulse_calc();

        if (is_running && !thirdCloseDone)
        {

            if (!offline)
            {
                if (previousValveState != "open")
                {
                    if (client.connected())
                        client.publish((String(truck_id) + "/valve_state").c_str(), "open", true);
                    previousValveState = "open";
                }
            }

            remain_Quantity = (flow_meter_prev_value + required_Quantity - flow_meter_value);

            if (offline && required_Quantity > 0)
            {
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

            if (remain_Quantity <= float(firstCloseLagV) / litter && firstCloseDone == false)
            {
                RelayCloseDC(firstCloseTime);
                firstCloseDone = true;
            }
            else if (remain_Quantity <= float(secondCloseLagV) / litter && secondCloseDone == false)
            {
                RelayCloseDC(secondCloseTime + added_time);
                secondCloseDone = true;
            }
            else if (remain_Quantity <= float(thirdCloseLagV) / litter && thirdCloseDone == false)
            {
                RelayCloseDC(thirdCloseTime + added_time);
                if (valve_type == "bump")
                    digitalWrite(RELAY_OPEN, 0);
                if (offline)
                {
                    String logEntry = String("") + required_Quantity + "," + (flow_meter_value - flow_meter_prev_value) + "," + flow_meter_value;
                    add_string_to_queue(logEntry.c_str());
                    is_running = false;
                    isBold[1] = false;
                    isBold[2] = false;
                }
                else
                {
                    updatePortState("stop");
                    // if (client.connected())
                    //     client.publish((String(truck_id) + "/state").c_str(), "stop", true);
                }
                thirdCloseDone = true;
            }
        }
    }
}

void MA_loop()
{

    handleEncoderActions();

    if (!offline && !client.connected())
    {
        reconnect();
    }
    if (!offline)
        client.loop();
    static unsigned long lastPublishTime = 0;
    if (millis() - lastPublishTime > 100)
    {
        lastPublishTime = millis();
        if (is_running && thirdCloseDone)
        {
            if (!offline && client.connected())
                client.publish((String(truck_id) + "/valve_state").c_str(), "open");
            float FlowRate = measureWaterFlow();
            ExtraWater = (FlowRate / 2.0) * thirdCloseTime / litter;
            if (remain_Quantity - ExtraWater / litter <= 0 && thirdCloseDone == false)
            {
                RelayCloseDC(thirdCloseTime + added_time);
                thirdCloseDone = true;
                updatePortState("stop");
            }
        }
    }
}

// ---------------------------------app begin---------------------------------------
void setup()
{
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

    if (manual)
    {
        String configData = readFile("/config.txt");
        if (configData.length() > 0)
            splitString(configData, ',', config, 15);
        offline = 1;
    }

    else
    {
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
        lcd.setCursor(15, 0);
        lcd.print(String(truck_id));

        // Initialize pre-computed MQTT topics
        initMqttTopics();

        client.setServer(mqtt_server.c_str(), mqtt_port);
        client.setCallback(callback);
        load_index_from_fs();

        while (!client.connected())
        {

            unsigned long now = millis();
            if (now - lastReconnectAttempt > RECONNECT_INTERVAL_MS)
            {
                lastReconnectAttempt = now;
                reconnect(); // محاولة الاتصال مرة واحدة
            }
            handleEncoderActions();
        }

        client.publish((String(truck_id) + "/update").c_str(), "config", true);
        while (updated)
        {
            client.loop();
            handleEncoderActions();
        }
        client.publish((String(truck_id) + "/state").c_str(), "stop", true);
        writeFile("/config.txt", message);
    }

    if (config[0] == "modbus")
    {
        SerialConfig frame = SERIAL_8N1; // Default value to avoid uninitialized usage
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
        while (1)
        {
            ESP.wdtFeed();
            yield();
            if (!client.connected() && !offline)
            {
                unsigned long now = millis();
                if (now - lastReconnectAttempt > RECONNECT_INTERVAL_MS)
                {
                    lastReconnectAttempt = now;
                    reconnect(); // محاولة الاتصال مرة واحدة
                }
            }
            modbus_loop();
        }
    }

    if (config[0] == "milli ampere")
    {

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

        while (1)
        {
            ESP.wdtFeed();
            yield();
            if (!client.connected() && !offline)
            {
                unsigned long now = millis();
                if (now - lastReconnectAttempt > RECONNECT_INTERVAL_MS)
                {
                    lastReconnectAttempt = now;
                    reconnect(); // محاولة الاتصال مرة واحدة
                }
            }
            MA_loop();
        }
    }

    if (config[0] == "pulse")
    {

        pinMode(rx, INPUT_PULLUP);
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
        while (1)
        {

            if (digitalRead(D0) == 1)
            {
                captured = 0;
            }
            else if (digitalRead(D0) == 0 && !captured)
            {
                car_number();
                captured = 1;
            }
            ESP.wdtFeed();
            yield();
            if (!client.connected() && !offline)
            {
                unsigned long now = millis();
                if (now - lastReconnectAttempt > RECONNECT_INTERVAL_MS)
                {
                    lastReconnectAttempt = now;
                    reconnect(); // محاولة الاتصال مرة واحدة
                }
            }
            pulse_loop();
        }
    }
}

void loop()
{
}