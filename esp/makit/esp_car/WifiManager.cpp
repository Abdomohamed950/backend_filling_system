#include "WifiManager.h"

// ===================== Constructor =====================
WifiManager::WifiManager() : server(80) {}

// ===================== Begin =====================
void WifiManager::begin()
{
    if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C))
    {
        Serial.println(F("❌ OLED not found"));
    }

    if (!tryConnectSaved())
        startAPMode();
    else
        Serial.println("Connected to saved WiFi.");
}

// ===================== Try Connect Saved =====================
bool WifiManager::tryConnectSaved()
{
    Config cfg = ConfigManager::load();
    if (cfg.data["ssid"] == "")
        return false;

    WiFi.mode(WIFI_STA);
    WiFi.begin(cfg.data["ssid"].c_str(), cfg.data["wifi_password"].c_str());
    if (cfg.data["local_ip"] != "" && cfg.data["gateway"] != "" && cfg.data["subnet"] != "")
    {
        IPAddress localIP, gateway, subnet;
        if (localIP.fromString(cfg.data["local_ip"]) && gateway.fromString(cfg.data["gateway"]) && subnet.fromString(cfg.data["subnet"]))
        {
            WiFi.config(localIP, gateway, subnet);
        }
        else
        {
            Serial.println("Invalid static IP configuration. Using DHCP.");
        }
    }
    Serial.printf("Connecting to %s ...\n", cfg.data["ssid"].c_str());

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < 15000)
    {
        delay(500);
        Serial.print(".");
    }

    if (WiFi.status() == WL_CONNECTED)
    {
        Serial.printf("\nConnected! IP: %s\n", WiFi.localIP().toString().c_str());
        return true;
    }

    Serial.println("\nFailed to connect.");
    return false;
}

// ===================== Start Access Point =====================
void WifiManager::startAPMode()
{

    Serial.println("Starting Access Point Mode...");
    display.clearDisplay();
    display.setTextSize(1);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(0, 0);
    display.println("📡 AP MODE");
    display.println();
    display.println("SSID:");
    display.println(AP_SSID);
    display.println();
    display.println("IP: 192.168.4.1");
    display.display();

    WiFi.mode(WIFI_AP);
    WiFi.softAPConfig(AP_IP, AP_GATEWAY, AP_SUBNET);
    WiFi.softAP(AP_SSID, AP_PASS);

    dns.start(53, "*", AP_IP);
    setupServer();

    Serial.println("AP Mode Started!");
    Serial.print("SSID: ");
    Serial.println(AP_SSID);
    Serial.println("IP: 192.168.4.1");
}

// ===================== Setup Server =====================
void WifiManager::setupServer()
{
    server.on("/", std::bind(&WifiManager::handleRoot, this));
    server.on("/save", std::bind(&WifiManager::handleSave, this));
    server.onNotFound(std::bind(&WifiManager::redirectAll, this));
    server.begin();
}

// ===================== Escape HTML =====================
String WifiManager::escapeHTML(String s)
{
    s.replace("&", "&amp;");
    s.replace("<", "&lt;");
    s.replace(">", "&gt;");
    s.replace("\"", "&quot;");
    s.replace("'", "&#39;");
    return s;
}

// ===================== Handle Root =====================
void WifiManager::handleRoot()
{
    Config cfg = ConfigManager::load();

    auto V = [&](String key, String def = "")
    {
        return cfg.data[key] != "" ? escapeHTML(cfg.data[key]) : def;
    };

    String html =
        "<!DOCTYPE html>"
        "<html><head><meta charset='utf-8'>"
        "<style>"
        "body {font-family: Arial, sans-serif; text-align:center; background-color:#121212; color:#ffffff; padding:20px; border-radius:10px;}"
        "h1 {color:#ffffff;}"
        "form {display:inline-block; margin-top:20px; background-color:#1e1e1e; padding:20px; border-radius:10px; text-align:left;}"
        "form div {margin-bottom:10px;}"
        "label {display:inline-block; width:130px; text-align:right; margin-right:10px;}"
        "input[type='text'],input[type='password'] {padding:10px; margin:5px; background-color:#333333; color:#ffffff; border:1px solid #555555; width:200px;}"
        "input[type='submit'] {padding:10px; margin:10px auto; display:block; background-color:#4CAF50; color:white; border:none; cursor:pointer; width:80%; border-radius:7px;}"
        "input[type='submit']:hover {background-color:#45a049;}"
        "fieldset {border:1px solid #444; border-radius:8px; padding:10px; margin-top:15px;}"
        "legend {color:#00e676; font-weight:bold;}"
        "</style></head><body>"
        "<h1>HYPER SCADA</h1><p>Filling System Setup</p>"

        "<form action='/save' method='POST'>"

        "<fieldset><legend>Wi-Fi Settings</legend>"
        "<div><label>WiFi SSID:</label><input type='text' name='ssid' value='" +
        V("ssid") + "'></div>"
                    "<div><label>WiFi Pass:</label><input type='text' name='wifi_password' value='" +
        V("wifi_password") + "'></div>"
                             "</fieldset>"

                             "<fieldset><legend>MQTT Settings</legend>"
                             "<div><label>MQTT Address:</label><input type='text' name='mqtt_address' value='" +
        V("mqtt_address") + "'></div>"
                            "<div><label>MQTT Port:</label><input type='text' name='mqtt_port' value='" +
        V("mqtt_port", "port1") + "'></div>"
                                  "</fieldset>"

                                  "<fieldset><legend>Network Settings</legend>"
                                  "<div><label>ESP Local IP:</label><input type='text' name='local_ip' value='" +
        V("local_ip") + "'></div>"
                        "<div><label>Gateway:</label><input type='text' name='gateway' value='" +
        V("gateway", "192.168.1.1") + "'></div>"
                                      "<div><label>Subnet:</label><input type='text' name='subnet' value='" +
        V("subnet", "255.255.255.0") + "'></div>"
                                       "</fieldset>"

                                       "<input type='submit' value='💾 Save & Reboot'>"
                                       "</form></body></html>";

    server.send(200, "text/html", html);
}

// ===================== Handle Save =====================
void WifiManager::handleSave()
{
    Config newCfg;
    for (uint8_t i = 0; i < server.args(); i++)
        newCfg.data[server.argName(i)] = server.arg(i);

    ConfigManager::save(newCfg);

    server.send(200, "text/html",
                "<html><body style='background:#121212;color:white;text-align:center;padding-top:50px;'>"
                "<h2>💾 Saved successfully</h2><p>Rebooting in 2 seconds...</p>"
                "</body></html>");
    delay(2000);
    ESP.restart();
}

// ===================== Redirect All =====================
void WifiManager::redirectAll()
{
    server.sendHeader("Location", "/", true);
    server.send(302, "text/plain", "");
}

// ===================== Handle Loop =====================
void WifiManager::handle()
{
    dns.processNextRequest();
    server.handleClient();
    yield();
}

// ===================== Connection State =====================
bool WifiManager::isConnected()
{
    return WiFi.status() == WL_CONNECTED;
}
