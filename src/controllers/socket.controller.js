const { Server } = require("socket.io");
let { start_filling, stop_filling } = require("../utils/operator");
const { spawn } = require("child_process");

function socket_setup(mqttClient, server) {
    const io = new Server(server, {
      cors: {
        origin: "*", // React frontend
        methods: ["GET", "POST"],
      },
    });

    // Socket.IO handling
    io.on("connection", (socket) => {
      console.log("🟢 Client connected:", socket.id);

      socket.on("update_field", (data) => {
        socket.broadcast.emit("update_field", data);
      });

      socket.on("start_filling", (data) => start_filling(mqttClient, data));

      socket.on("stop_filling", (data) => stop_filling(mqttClient, data));

      let aiModeProcess = null;
      let aiModeRunning = false; // حالة مشتركة

      socket.on("toggle_ai_mode", () => {
        if (aiModeRunning) {
          console.log("Stopping AI mode");
          aiModeProcess.kill();
          aiModeProcess = null;
          aiModeRunning = false;

          // ابعت لكل الأجهزة الحالة الجديدة
          io.emit("ai_mode_status", { running: false });
        } else {
          console.log("Starting AI mode");
          aiModeProcess = spawn("python3", ["utils/ai/app.py", "arg1", "arg2"]);
          aiModeRunning = true;

          aiModeProcess.stdout.on("data", (data) => {
            console.log(`Output: ${data}`);
          });

          aiModeProcess.stderr.on("data", (data) => {
            console.error(`Error: ${data}`);
          });

          aiModeProcess.on("close", (code) => {
            console.log(`Process exited with code ${code}`);
            aiModeProcess = null;
            aiModeRunning = false;

            // برودكاست الحالة بعد الإيقاف
            io.emit("ai_mode_status", { running: false });
          });

          // برودكاست الحالة بعد التشغيل
          io.emit("ai_mode_status", { running: true });
        }
      });
    });
    
    return io;
}

module.exports = { socket_setup };