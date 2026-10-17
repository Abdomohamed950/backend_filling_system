#include "MQTTManager.h"

MQTTManager::MQTTManager()
    : client(espClient), display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1)
{
    numbers[0] = 1;
    numbers[1] = 2;
    numbers[2] = 3;
    numbers[3] = 4;
}

void MQTTManager::begin()
{
    Config cfg = ConfigManager::load();

    mqttAddress = cfg.data["mqtt_address"];
    portName = cfg.data["mqtt_port"];
    mqttPort = 1883;

    if (mqttAddress == "")
        mqttAddress = "broker.hivemq.com";

    if (!display.begin(SSD1306_SWITCHCAPVCC, 0x3C))
    {
        Serial.println(F("❌ OLED not found"));
        return;
    }

    display.clearDisplay();
    display.setTextSize(2);
    display.setTextColor(SSD1306_WHITE);
    display.setCursor(10, 20);
    display.println(F("MQTT init..."));
    display.display();

    client.setServer(mqttAddress.c_str(), mqttPort);
    client.setCallback([this](char *topic, byte *payload, unsigned int length)
                       { this->onMessage(topic, payload, length); });

    connectToBroker();
    updateDisplay();
}

void MQTTManager::connectToBroker()
{
    while (!client.connected())
    {
        Serial.print("Connecting to MQTT... ");
        String clientId = "HYPER_SCADA_" + String(random(0xffff), HEX);
        if (client.connect(clientId.c_str()))
        {
            Serial.println("Connected ✅");
            client.subscribe((portName + "/state").c_str());
            client.subscribe((portName + "/remain").c_str());
        }
        else
        {
            Serial.print("failed, rc=");
            Serial.print(client.state());
            Serial.println(" retry in 5s");
            delay(5000);
        }
    }
}

void MQTTManager::handle()
{
    if (!client.connected())
        connectToBroker();
    client.loop();
}

bool MQTTManager::isConnected()
{
    return client.connected();
}

// =====================================================
// لما توصل رسالة MQTT
// =====================================================
void MQTTManager::onMessage(char *topic, byte *payload, unsigned int length)
{
    String msg;
    for (unsigned int i = 0; i < length; i++)
        msg += (char)payload[i];

    msg.trim();
    Serial.printf("📩 Message on [%s]: %s\n", topic, msg.c_str());

    if (String(topic) == (portName + "/state"))
    {
        if (msg.equalsIgnoreCase("stop"))
        {
            Serial.println("⚙️ stop received -> updating display!");
            delay(3000);
            // حركة الـ stepper (traffic) بقت من السيرفر في dev_mode: <port>/turns
            analogWrite(D5, 0);
            analogWrite(D6, 0);
            analogWrite(D7, 0);
            delay(3000);
            generateNewNumbers();
            updateDisplay();
        }
    }
    else if (String(topic) == (portName + "/remain"))
    {
        Serial.printf("⚙️ remain received: %s\n", msg.c_str());
        int remain = msg.toInt();
        analogWrite(D5, remain);
        analogWrite(D6, remain);
        analogWrite(D7, remain);
    }
}

// =====================================================
// توليد أرقام جديدة عشوائية
// =====================================================
void MQTTManager::generateNewNumbers()
{
    static int dataSet[][4] = {
        {1, 2, 3, 4},
        {5, 6, 7, 8},
        {9, 0, 1, 2},
        {3, 3, 4, 4},
        {7, 8, 9, 9}};

    static int index = 0;

    for (int i = 0; i < 4; i++)
    {
        numbers[i] = dataSet[index][i];
    }

    index++;
    if (index >= (sizeof(dataSet) / sizeof(dataSet[0])))
        index = 0;
}

// =====================================================
// عرض الأرقام على الشاشة
// =====================================================
void MQTTManager::updateDisplay()
{
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(4);
    display.setCursor(10, 10);

    for (int i = 0; i < 4; i++)
    {
        display.print(numbers[i]);
    }

    display.display();
}
