/*
 * TCP client لسيرفر SCADA — بروتوكول نصّي بسيط:
 *   بيبعت "P <channel_id> <value> <row_id>\n" ويستنى سطر رد واحد.
 *
 * بايثون كانت بتستخدم socket.recv() المباشر (blocking) — هنا الـ net.Socket
 * غير متزامن (stream-based)، فمحتاجين line-buffering يدوي + طابور ردود
 * (نفس دور self._tx_lock القديم: طلب واحد بس في نفس اللحظة على نفس الاتصال).
 *
 * السيرفر الحقيقي مقفول حاليًا (مذكور في sync_and_barcode.md) — الـ circuit
 * breaker هنا يمنع محاولة إعادة اتصال كل ثانية طول الوقت وتغريق اللوج
 * (نفس المشكلة الموثقة في النظام القديم، اتحلّت هناك بفلتر لوج بس).
 */

const net = require("net");

const COOLDOWN_MS = 30 * 1000;

class ScadaClient {
  constructor({ host, port, timeout = 3000, retries = 3 }) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.retries = retries;

    this._socket = null;
    this._buffer = "";
    this._pending = null; // { resolve, timer } لطلب واحد منتظر رد
    this._txChain = Promise.resolve();
    this._lastFailureAt = 0;
    this._cooldownLogged = false;
  }

  isAlive() {
    return !!this._socket && !this._socket.destroyed;
  }

  _inCooldown() {
    return this._lastFailureAt && Date.now() - this._lastFailureAt < COOLDOWN_MS;
  }

  async connect() {
    if (this.isAlive()) return true;

    if (this._inCooldown()) {
      if (!this._cooldownLogged) {
        console.warn(
          `⚠️  SCADA (${this.host}:${this.port}): غير متاح — لن يُعاد المحاولة لمدة ${COOLDOWN_MS / 1000}s`
        );
        this._cooldownLogged = true;
      }
      return false;
    }
    this._cooldownLogged = false;

    for (let attempt = 1; attempt <= this.retries; attempt++) {
      const ok = await this._createNew();
      if (ok) return true;
      if (attempt < this.retries) await sleep(1000);
    }

    this._lastFailureAt = Date.now();
    return false;
  }

  _createNew() {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      let settled = false;

      const finish = (ok) => {
        if (settled) return;
        settled = true;
        socket.removeListener("error", onError);
        socket.removeListener("timeout", onTimeout);
        resolve(ok);
      };

      const onError = (err) => {
        console.error(`❌ SCADA connection error: ${err.message}`);
        finish(false);
      };
      const onTimeout = () => {
        socket.destroy();
        finish(false);
      };

      socket.setTimeout(this.timeout);
      socket.once("error", onError);
      socket.once("timeout", onTimeout);

      socket.connect(this.port, this.host, () => {
        socket.setTimeout(0);
        this._attachSocket(socket);
        console.log(`🔌 SCADA connected: ${this.host}:${this.port}`);
        finish(true);
      });
    });
  }

  _attachSocket(socket) {
    this._socket = socket;
    this._buffer = "";

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._onClose());
    socket.on("error", (err) => {
      console.error(`❌ SCADA socket error: ${err.message}`);
    });
  }

  _onData(chunk) {
    this._buffer += chunk.toString("utf8");
    const nl = this._buffer.indexOf("\n");
    if (nl === -1) return;

    const line = this._buffer.slice(0, nl).trim();
    this._buffer = this._buffer.slice(nl + 1);

    if (this._pending) {
      clearTimeout(this._pending.timer);
      const { resolve } = this._pending;
      this._pending = null;
      resolve(line);
    }
  }

  _onClose() {
    if (this._pending) {
      clearTimeout(this._pending.timer);
      this._pending.resolve(null);
      this._pending = null;
    }
    this._socket = null;
  }

  /** يبعت رسالة ويستنى سطر رد واحد؛ null لو فشل الاتصال أو انتهت المهلة */
  sendReceive(message) {
    this._txChain = this._txChain.then(() => this._sendReceiveOnce(message));
    return this._txChain;
  }

  async _sendReceiveOnce(message) {
    const connected = this.isAlive() || (await this.connect());
    if (!connected) return null;

    return new Promise((resolve) => {
      this._pending = {
        resolve,
        timer: setTimeout(() => {
          this._pending = null;
          resolve(null);
        }, this.timeout),
      };

      this._socket.write(message, (err) => {
        if (err) {
          console.error(`❌ SCADA write error: ${err.message}`);
          if (this._pending) {
            clearTimeout(this._pending.timer);
            this._pending = null;
          }
          resolve(null);
        }
      });
    });
  }

  async reconnect() {
    this.close();
    return this.connect();
  }

  close() {
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * فحص اتصال TCP بس (من غير ما نبعت أي رسالة بروتوكول ولا نمس الـ client الرئيسي).
 * بيرجع { reachable, latencyMs, error? } ومبيرميش استثناء.
 */
function testConnection(host, port, timeout = 3000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = new net.Socket();
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish({ reachable: true, latencyMs: Date.now() - started }));
    socket.once("timeout", () => finish({ reachable: false, error: `timeout after ${timeout}ms` }));
    socket.once("error", (err) => finish({ reachable: false, error: err.code || err.message }));
    socket.connect(port, host);
  });
}

module.exports = { ScadaClient, testConnection };
