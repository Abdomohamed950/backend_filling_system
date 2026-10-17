#include "ConfigManager.h"

Config ConfigManager::load() {
  Config cfg;
  if (!LittleFS.begin())
    LittleFS.format();

  if (LittleFS.exists("/config")) {
    File f = LittleFS.open("/config", "r");
    while (f.available()) {
      String line = f.readStringUntil('\n');
      int eq = line.indexOf('=');
      if (eq > 0) {
        String key = line.substring(0, eq);
        String val = line.substring(eq + 1);
        cfg.data[key] = val;
        if (key == "ssid")
          cfg.ssid = val;
        if (key == "password")
          cfg.password = val;
      }
    }
    f.close();
  }
  return cfg;
}

void ConfigManager::save(const Config &cfg) {
  if (!LittleFS.begin())
    LittleFS.format();

  File f = LittleFS.open("/config", "w");
  for (auto &pair : cfg.data) {
    f.printf("%s=%s\n", pair.first.c_str(), pair.second.c_str());
  }
  f.close();
}
