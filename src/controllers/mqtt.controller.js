// Kept for backwards compatibility only.
// The MQTT contract with the firmware lives in one place: ../transport/mqtt.js
// (this file used to hold a second, diverging copy with a hardcoded conf string).
module.exports = require("../transport/mqtt");
