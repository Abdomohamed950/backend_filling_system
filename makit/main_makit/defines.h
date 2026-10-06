// إعدادات الشبكة
String ssid = "";
String password = "";
String truck_id = "";
String mqtt_server = "";
String esp_local_ip = "";
String esp_gateway = "";
String esp_subnet = "";
const int mqtt_port = 1883;

const char *ap_ssid = "main_makit_config";
const char *ap_password = "12345678";

IPAddress local_IP;
IPAddress gateway;
IPAddress subnet;
IPAddress dns(8, 8, 8, 8);

bool oled = 0; // 1 for oled 0 for lcd

// Modbus إعداد ات

#define MAX485_DE D0
#define MAX485_RE_NEG D0
#define RELAY_OPEN D6
#define RELAY_CLOSE D5
#define ENCODER_PIN_A D3
#define ENCODER_PIN_B D4
#define ENCODER_BUTTON D8
#define FLOW_SENSOR_PIN A0

#define REG_IN_ROW 2

#define ADC_RESOLUTION 1024 // دقة قراءة ADC (مثلاً في أردوينو 10-bit)
#define V_REF 3300          // الجهد المرجعي للمتحكم (5V → 5000mV)

#define QUEUE_SIZE 100
#define STRING_MAX_LENGTH 50
