#include <ESP8266WiFi.h> // Change to ESP8266 WiFi library
#include <PubSubClient.h>
#include <FS.h>
#include <LittleFS.h>
#include <ESP8266WebServer.h>

// ======= variables =======
float current_position;
float target_position = 4.1; // موضع الجاهزية، السيرفر يحدّثه عبر <port>/turns_ready (dev_mode)

// ======= WIFI + Config (LittleFS) =======
// Defaults (overridden by saved values)
String WIFI_SSID_DEFAULT = "Abdo123";
String WIFI_PASS_DEFAULT = "01063677938Abdo123@";
String MQTT_SERVER_DEFAULT = "192.168.1.6";
String STATIC_IP_DEFAULT = ""; // leave empty for DHCP
String GATEWAY_DEFAULT = "192.168.1.1";
String SUBNET_DEFAULT = "255.255.255.0";

// Files
const char *F_USERNAME = "/username.txt";
const char *F_PASSWORD = "/password.txt";
const char *F_MQTT = "/mqtt_address.txt";
const char *F_IP = "/esp_local_ip.txt";
const char *F_GW = "/gateway.txt";
const char *F_SN = "/subnet.txt";
const char *F_PORTNAME = "/port_id.txt";
const char *F_THR_LOW = "/flow_low.txt";
const char *F_THR_HIGH = "/flow_high.txt";

// Runtime config
String ui_user, ui_pass, ui_mqtt, ui_port, ui_ip, ui_gw, ui_sn;

// Extra defaults/thresholds to mirror bumpbroker structure
String PORT_NAME_DEFAULT = "port1";
float FLOW_LOW_START = 50.0f;
float FLOW_HIGH_STOP = 80.0f;

// ======= MQTT معلومات =======
const int mqtt_port = 1883;
// Topics تُبنى من اسم المنفذ (ui_port) بعد تحميل الإعدادات
String mqtt_topic_turns;
String mqtt_topic_turns_ready;
String mqtt_topic_state;

bool yello_blink = 0;
bool green_blink = 0;

WiFiClient espClient;
PubSubClient client(espClient);
ESP8266WebServer server(80);

// AP fallback
bool apMode = false;
String apSsid = "";
// (No AP portal in this version to match bumpbroker logic)

// FS helpers
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

// ======= Pins =======
#define STEPS_PER_REV 200
#define DIR_PIN D5 // Update to ESP8266 GPIO pins
#define STEP_PIN D6
#define LIMIT_SWITCH_PIN D1
#define red_led D2
#define green_led D4
#define yello_led D3

// ======= Functions =======
void stepMotor(int steps, bool dir)
{
    digitalWrite(DIR_PIN, dir);
    for (int i = 0; i < steps; i++)
    {
        yield();
        digitalWrite(STEP_PIN, HIGH);
        delayMicroseconds(2000);
        digitalWrite(STEP_PIN, LOW);
        delayMicroseconds(2000);
    }
}

// ======= Homing Function =======
void homeMotor()
{
    Serial.println("Homing motor...");

    // الاتجاه ناحية limit switch
    digitalWrite(DIR_PIN, LOW);
    while (digitalRead(LIMIT_SWITCH_PIN))
    {
        yield();
        digitalWrite(STEP_PIN, HIGH);
        delayMicroseconds(2000);
        digitalWrite(STEP_PIN, LOW);
        delayMicroseconds(2000);
    }

    Serial.println("Limit switch hit! Moving back...");

    // ابعد 14 خطوة عن limit switch
    stepMotor(6.6 * STEPS_PER_REV, true); // true = عكس الاتجاه اللي رايح بيه للـ switch

    // خلي دي هي الموضع 0
    current_position = 0;
    digitalWrite(green_led, 0);
    digitalWrite(red_led, 1);

    Serial.println("Home position set at 14 steps away from switch!");
}

// ======= MQTT Callback =======
void mqttCallback(char *topic, byte *payload, unsigned int length)
{
    String msg;
    for (int i = 0; i < length; i++)
    {
        msg += (char)payload[i];
    }

    Serial.print("Message [");
    Serial.print(topic);
    Serial.print("]: ");
    Serial.println(msg);

    if (String(topic) == mqtt_topic_turns)
    {
        float turns = msg.toFloat();
        Serial.print("Received turns: ");
        Serial.println(turns);

        if (turns >= 0 && turns <= 6.6)
        {
            int steps = abs(current_position - turns) * STEPS_PER_REV;
            if (current_position < turns)
                stepMotor(steps, false);
            else
                stepMotor(steps, true);

            current_position = turns;

            if (current_position == target_position)
            {
                digitalWrite(yello_led, 1);
                digitalWrite(red_led, 0);
                digitalWrite(green_led, 0);
                yello_blink = 0;
                green_blink = 0;
            }
            else if (fabs(current_position - target_position) < 0.5)
            {
                digitalWrite(yello_led, 0);
                digitalWrite(green_led, 0);
                digitalWrite(red_led, 0);
                yello_blink = 1;
                green_blink = 0;
            }
            else
            {
                digitalWrite(red_led, 1);
                digitalWrite(yello_led, 0);
                digitalWrite(green_led, 0);
                yello_blink = 0;
                green_blink = 0;
            }
        }
    }

    else if (String(topic) == mqtt_topic_turns_ready)
    {
        float ready = msg.toFloat();
        if (ready >= 0 && ready <= 6.6)
            target_position = ready;
    }

    else if (String(topic) == mqtt_topic_state)
    {
        if (msg == "filling")
        {
            digitalWrite(red_led, LOW);
            digitalWrite(yello_led, LOW);
            green_blink = 1;
            yello_blink = 0;
        }
        else if (msg == "stop")
        {
            digitalWrite(red_led, LOW);
            digitalWrite(yello_led, LOW);
            digitalWrite(green_led, HIGH);
            green_blink = 0;
            yello_blink = 0;
        }
    }
}

// ======= Web UI =======
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

                "  <div><label for=\"value4\">port name:</label>"
                "      <input type=\"text\" id=\"value4\" name=\"value4\" value=\"" +
        ui_port + "\"></div>"

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
    String port_name = server.arg("value4");
    String esp_local_ip = server.arg("value5");
    String esp_gateway = server.arg("value6");
    String esp_subnet = server.arg("value7");

    writeFile(F_USERNAME, usser_name);
    writeFile(F_PASSWORD, pass);
    writeFile(F_MQTT, mqtt_address);
    writeFile(F_PORTNAME, port_name);
    writeFile(F_IP, esp_local_ip);
    writeFile(F_GW, esp_gateway);
    writeFile(F_SN, esp_subnet);

    ui_user = usser_name;
    ui_pass = pass;
    ui_mqtt = mqtt_address;
    ui_port = port_name;
    ui_ip = esp_local_ip;
    ui_gw = esp_gateway;
    ui_sn = esp_subnet;

    server.send(200, "text/html", "<h1>Values received</h1>");
    delay(800);
    ESP.restart();
}

// AP fallback
void startAPFallback()
{
    apMode = true;
    apSsid = "MAKIT-Setup";
    WiFi.mode(WIFI_AP);
    WiFi.softAP(apSsid.c_str());
    IPAddress myIP = WiFi.softAPIP();
    Serial.println();
    Serial.print("AP mode started: ");
    Serial.println(apSsid);
    Serial.print("Open http://");
    Serial.println(myIP);
}

// (No AP portal STA+AP mode; keep exact bumpbroker logic)

// ======= WIFI Connect (like bumpbroker) =======
void connectWiFi()
{
    Serial.println();
    Serial.print("WiFi: trying SSID=\"");
    Serial.print(ui_user);
    Serial.println("\" ...");

    if (ui_ip.length() > 0 && ui_gw.length() > 0 && ui_sn.length() > 0)
    {
        IPAddress ip, gw, sn;
        ip.fromString(ui_ip);
        gw.fromString(ui_gw);
        sn.fromString(ui_sn);
        WiFi.config(ip, gw, sn);
    }
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    WiFi.disconnect(true);
    delay(100);
    WiFi.begin(ui_user.c_str(), ui_pass.c_str());
    Serial.print("Connecting WiFi");
    int tries = 0;
    while (WiFi.status() != WL_CONNECTED && tries < 40)
    {
        delay(250);
        Serial.print(".");
        tries++;
    }
    bool ok = (WiFi.status() == WL_CONNECTED);
    Serial.println(ok ? " OK" : " FAILED");
    if (ok)
    {
        Serial.print("WiFi IP: ");
        Serial.println(WiFi.localIP());
    }
    if (!ok)
        startAPFallback();
}

// ======= MQTT Connect (like bumpbroker, uses ui_mqtt) =======
void connectToMQTT()
{
    client.setServer(ui_mqtt.c_str(), mqtt_port);
    if (WiFi.status() != WL_CONNECTED)
    {
        Serial.println("MQTT: skipped (WiFi not connected)");
        return;
    }
    Serial.print("MQTT: target=");
    Serial.print(ui_mqtt);
    Serial.print(":");
    Serial.println(mqtt_port);
    while (!client.connected() && WiFi.status() == WL_CONNECTED)
    {
        Serial.print("Attempting MQTT connection...");
        String cid = String("makit-") + String(ESP.getChipId(), HEX);
        if (client.connect(cid.c_str()))
        {
            Serial.println("connected");
            client.subscribe(mqtt_topic_turns.c_str());
            client.subscribe(mqtt_topic_turns_ready.c_str());
            client.subscribe(mqtt_topic_state.c_str());
        }
        else
        {
            static int mqtt_fail_count = 0;
            Serial.print("failed, rc=");
            Serial.print(client.state());
            Serial.println(" try again in 1 seconds");
            delay(1000);
            mqtt_fail_count++;
            if (mqtt_fail_count >= 5)
            {
                Serial.println("MQTT: Too many failed attempts, starting AP fallback.");
                startAPFallback();
                mqtt_fail_count = 0; // Reset counter after fallback
                break;               // Exit the while loop
            }
        }
    }
}

// ======= Setup =======
void setup()
{
    Serial.begin(115200);
    pinMode(DIR_PIN, OUTPUT);
    pinMode(STEP_PIN, OUTPUT);
    pinMode(LIMIT_SWITCH_PIN, INPUT);
    pinMode(red_led, OUTPUT);
    pinMode(green_led, OUTPUT);
    pinMode(yello_led, OUTPUT);

    // إطفاء الليدات مبدئياً
    digitalWrite(red_led, LOW);
    digitalWrite(green_led, LOW);
    digitalWrite(yello_led, LOW);

    homeMotor();

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
    mqtt_topic_turns = ui_port + "/turns";
    mqtt_topic_turns_ready = ui_port + "/turns_ready";
    mqtt_topic_state = ui_port + "/state";
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

    connectWiFi();
    client.setCallback(mqttCallback);
    if (WiFi.status() == WL_CONNECTED)
    {
        connectToMQTT();
    }
}

// ======= Loop =======
void loop()
{
    if (!apMode)
    {
        if (WiFi.status() != WL_CONNECTED)
            connectWiFi();
        if (WiFi.status() == WL_CONNECTED)
        {
            if (!client.connected())
                connectToMQTT();
            client.loop();
        }
    }
    server.handleClient();
    static unsigned long lastblinkred = 0;
    if (yello_blink && lastblinkred + 500 < millis())
    {
        lastblinkred = millis();
        digitalWrite(yello_led, !digitalRead(yello_led));
    }
    static unsigned long lastblinkgreen = 0;
    if (green_blink && lastblinkgreen + 500 < millis())
    {
        lastblinkgreen = millis();
        digitalWrite(green_led, !digitalRead(green_led));
    }
}
