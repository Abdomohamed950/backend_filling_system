#include "WifiManager.h"
#include "MQTTManager.h"

WifiManager wifi;
MQTTManager mqtt;

void setup() {
  Serial.begin(115200);

  wifi.begin();

  while (!wifi.isConnected()) {
    wifi.handle();
    delay(100);
  }

  mqtt.begin();
  pinMode(D5, OUTPUT);
  pinMode(D6, OUTPUT);
  pinMode(D7, OUTPUT);

  digitalWrite(D5, 0);
  digitalWrite(D6, 0);
  digitalWrite(D7, 0);
}

void loop() {
  // wifi.handle();
  mqtt.handle();
}
