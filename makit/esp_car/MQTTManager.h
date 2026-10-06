#ifndef MQTT_MANAGER_H
#define MQTT_MANAGER_H

#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "ConfigManager.h"

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

class MQTTManager {
public:
    MQTTManager();
    void begin();
    void handle();
    bool isConnected();

private:
    WiFiClient espClient;
    PubSubClient client;
    Adafruit_SSD1306 display;

    String mqttAddress;
    String portName;
    int mqttPort;

    int numbers[4]; 

    void connectToBroker();
    void onMessage(char* topic, byte* payload, unsigned int length);
    void updateDisplay();
    void generateNewNumbers();
};

#endif
