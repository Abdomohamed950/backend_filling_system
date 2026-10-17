#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <DNSServer.h>
#include "ConfigManager.h"
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define AP_SSID "esp_car"
#define AP_PASS ""
#define AP_IP IPAddress(192,168,4,1)
#define AP_GATEWAY IPAddress(192,168,4,1)
#define AP_SUBNET IPAddress(255,255,255,0)
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

class WifiManager {
public:
  WifiManager();
  void begin();
  void handle();
  bool isConnected();

private:
  ESP8266WebServer server;
  DNSServer dns;
  Adafruit_SSD1306 display = Adafruit_SSD1306(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

  void startAPMode();
  bool tryConnectSaved();
  void setupServer();
  void handleRoot();
  void handleSave();
  void redirectAll();
  String escapeHTML(String s);
};

#endif
