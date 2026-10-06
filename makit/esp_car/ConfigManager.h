#ifndef CONFIG_MANAGER_H
#define CONFIG_MANAGER_H

#include <Arduino.h>
#include <LittleFS.h>
#include <map>

struct Config
{
  String ssid;
  String password;
  std::map<String, String> data;

  Config()
  {
    data["ssid"] = "";
    data["wifi_password"] = "";
    data["local_ip"] = "";
    data["gateway"] = "";
    data["subnet"] = "";
  }
};

class ConfigManager
{
public:
  static Config load();
  static void save(const Config &cfg);
};

#endif
