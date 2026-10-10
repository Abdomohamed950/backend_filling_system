/*
 * dev_mode — دورة التعبئة التلقائية (بدون إيصالات).
 * بيتحمّل من services/devMode.js فقط، ومابيعملش حاجة وdev_mode مقفول.
 *
 * الشاحنات مش جزء من dev_mode: جدول trucks عام (models/trucksModel.js، و
 * REST على /api/trucks). الدورة بتستخدمه بس:
 *   - شاحنة مسجّلة: كميتها (أو defaultQuantity لو فاضية) وحد نقلاتها لو مفعّل
 *   - شاحنة غير مسجّلة: تعدي بالكمية الافتراضية ومن غير حد
 * عدّ النقلات نفسه في fillingSessions.closeRecord (لكل التعبئات، مش الدورة بس).
 *
 * الدورة (dev_start_cycle {port}) — الزرار اللي في الواجهة:
 *   moving   -> السيرفر يبعت <port>/turns = readyTurns (العربية تحت المنفذ)
 *   reading  -> بعد arriveWaitMs يطلب قراءة الرقم من الكاميرا (<cam>/esp = start)
 *   starting -> الرقم اتقرا ومفيش حد نقلات واقف في طريقه: يبعت الكمية + start
 *               (نفس start_filling العادي، من غير فحص إيصال)
 *   filling  -> الجهاز أعلن state=filling
 *   leaving  -> state=stop: العربية تمشي (stopTurns ثم homeTurns)
 *   done
 * أي فشل (رقم مش اتقرا / النقلات خلصت / الجهاز مابدأش) بيطلع كـ phase "blocked"
 * مع reason، والعربية بترجع للبيت من غير تعبئة.
 *
 * Socket events (العميل -> السيرفر):
 *   dev_start_cycle  { port, receipt_number? }  (الباركود المتمسح، بيتسجّل في history)
 *   dev_cancel_cycle { port }
 * (السيرفر -> العميل):
 *   dev_cycle  { port, phase, ...extra }
 */

const { start_filling, stop_filling } = require("../utils/operator");
const { getSnapshot } = require("../transport/mqtt");
const Trucks = require("../models/trucksModel");

const READ_TIMEOUT_MS = 20000; // انتظار نتيجة plate_reader
const START_TIMEOUT_MS = 30000; // انتظار state=filling بعد أمر start

/**
 * deps: { listPorts() -> Promise<string[]>, getMqtt, io, isEnabled, getSettings, getTurns, publishTurns,
 *         leave(port) -> Promise, clearLeave(port), triggerPlate() }
 */
function create(deps) {
  // port -> { phase, timers, truck, operatorId, started, cancelled, receiptNumber }
  const active = new Map();

  // port -> timer|null: المنافذ اللي في loop (AI mode شغال). الحالة في الذاكرة بس
  const loops = new Map();
  let aiRunning = false;
  const RETRY_MS = 1000;

  const emit = (port, phase, extra = {}, c = active.get(port)) => {
    const receipt = c?.receiptNumber;
    deps.io.emit("dev_cycle", { port, phase, ...(receipt ? { receipt_number: receipt } : {}), ...extra });
  };
  
  function clearCycleTimers(c) {
    for (const t of c.timers) clearTimeout(t);
    c.timers = [];
  }
  const later = (c, ms, fn) => c.timers.push(setTimeout(fn, ms));

  async function leave(port, c) {
    c.phase = "leaving";
    clearCycleTimers(c);
    emit(port, "leaving");
    try {
      await deps.leave(port);
    } catch (err) {
      console.error(`❌ dev cycle leave ${port}:`, err.message);
    }
    if (active.get(port) === c) {
      active.delete(port);
      emit(port, "done", {}, c);
      afterCycle(port, c);
    }
  }

  // ---- loop (AI mode) ----
  function stopLoop(port) {
    if (!loops.has(port)) return;
    clearTimeout(loops.get(port));
    loops.delete(port);
  }

  function stopAllLoops() {
    for (const port of [...loops.keys()]) stopLoop(port);
  }

  function schedule(port, ms) {
    if (!loops.has(port)) return;
    clearTimeout(loops.get(port));
    loops.set(port, setTimeout(() => runLoop(port), ms));
  }

  async function runLoop(port) {
    if (!loops.has(port) || !aiRunning || !deps.isEnabled()) return;
    try {
      await start(port, null);
    } catch (err) {
      // الكاميرا مشغولة بمنفذ تاني: جرّب تاني قريب (تتابع). غير كده استنى loopDelaySec
      const camBusy = /still reading/.test(err.message);
      if (!camBusy) console.warn(`⚠️  dev loop ${port}: ${err.message}`);
      schedule(port, camBusy ? RETRY_MS : Math.max(RETRY_MS, deps.getSettings().loopDelaySec * 1000));
    }
  }

  // بعد done: لو المنفذ في loop، استنى loopDelaySec (القيمة وقت بدء الانتظار) وابدأ دورة جديدة
  function afterCycle(port, c) {
    if (!loops.has(port)) return;
    if (!aiRunning || !deps.isEnabled()) return stopLoop(port);
    if (c.blockReason === "trips_exhausted") {
      stopLoop(port);
      deps.io.emit("dev_error", {
        event: "dev_cycle_loop",
        port,
        message: `loop stopped on ${port}: trips_exhausted`,
      });
      return;
    }
    const ms = deps.getSettings().loopDelaySec * 1000;
    emit(port, "waiting", { nextInMs: ms }, c);
    schedule(port, ms);
  }

  // AI mode أو dev_mode اتغيّر: ابدأ/أوقف الـ loop (الدورة الجارية بتكمل لحد done)
  async function syncLoop(running) {
    if (running !== undefined) aiRunning = Boolean(running);
    if (!aiRunning || !deps.isEnabled()) return stopAllLoops();
    let ports = [];
    try {
      ports = await deps.listPorts();
    } catch (err) {
      return console.error("❌ dev loop ports:", err.message);
    }
    if (!aiRunning || !deps.isEnabled()) return;
    for (const port of ports) {
      if (loops.has(port)) continue;
      loops.set(port, null);
      // دورة شغالة على المنفذ؟ afterCycle هيكمل الـ loop بعد done
      if (!active.has(port)) schedule(port, 0);
    }
  }

  function block(port, c, reason, extra = {}) {
    c.blockReason = reason;
    console.warn(`⛔ dev cycle ${port}: ${reason}`);
    emit(port, "blocked", { reason, ...extra });
    return leave(port, c);
  }

  async function start(port, operator, receiptNumber) {
    if (!deps.isEnabled()) throw new Error("dev_mode is off");
    if (!port) throw new Error("port is required");
    if (active.has(port)) throw new Error(`a cycle is already running on ${port}`);
    // الكاميرا واحدة: دورتين مش هينفع يقروا رقمين في نفس الوقت
    for (const c of active.values()) {
      if (c.phase === "moving" || c.phase === "reading") {
        throw new Error("another cycle is still reading a plate");
      }
    }

    const last = new Map(getSnapshot(port));
    if (last.get("availability")?.data !== "online") throw new Error(`${port} is offline`);
    const state = last.get("state")?.data;
    if (state === "filling" || state === "stoping") throw new Error(`${port} is busy (${state})`);

    const c = { phase: "moving", timers: [], truck: null, operatorId: operator?.id, started: false, receiptNumber };
    active.set(port, c);

    deps.clearLeave(port); // خروج عربية سابقة لسه شغال: ما نتصادمش معاه
    const turns = await deps.getTurns(port);
    emit(port, "moving", { turns: turns.readyTurns });
    deps.publishTurns(port, turns.readyTurns);
    later(c, deps.getSettings().arriveWaitMs, () => {
      c.phase = "reading";
      emit(port, "reading");
      deps.triggerPlate();
      later(c, READ_TIMEOUT_MS, () => block(port, c, "read_failed"));
    });
  }

  // الرقم المقروء من الكاميرا (dev_plate): بيخص الدورة اللي في مرحلة reading
  async function onPlate(number) {
    const entry = [...active.entries()].find(([, c]) => c.phase === "reading");
    if (!entry) return;
    const [port, c] = entry;
    clearCycleTimers(c);

    try {
      if (!number) return block(port, c, "read_failed");

      // شاحنة غير مسجّلة بتعدي بالكمية الافتراضية ومن غير حد
      const gate = await Trucks.checkLimit(number);
      if (!gate.ok) {
        return block(port, c, gate.reason, {
          plate: number,
          tripsDone: gate.truck.tripsDone,
          maxTrips: gate.truck.maxTrips,
        });
      }

      const truck = gate.truck;
      const quantity = truck?.quantity ?? deps.getSettings().defaultQuantity;
      c.truck = { plate: number };
      c.phase = "starting";
      emit(port, "starting", { plate: number, quantity, registered: Boolean(truck) });

      const ok = start_filling(deps.getMqtt(), {
        port,
        required_quantity: quantity,
        truck_number: number,
        operator_id: c.operatorId,
        ...(c.receiptNumber ? { receipt_number: c.receiptNumber } : {}),
        fill_mode: "normal",
      });
      if (!ok) return block(port, c, "invalid_quantity", { plate: number, quantity });

      later(c, START_TIMEOUT_MS, () => {
        stop_filling(deps.getMqtt(), { port }); // لو الجهاز بدأ متأخر ما يفضلش شغال
        block(port, c, "start_timeout", { plate: number });
      });
    } catch (err) {
      console.error(`❌ dev cycle ${port} plate:`, err.message);
      block(port, c, "error", { message: err.message });
    }
  }

  /**
   * state من الجهاز (غير retained). بيرجع true لو دورة شايلة المنفذ، فـ devMode
   * مايشغّلش تسلسل الخروج بتاعه مرتين.
   */
  function onState(port, state) {
    const c = active.get(port);
    if (!c) return false;

    if (state === "filling" && c.phase === "starting") {
      clearCycleTimers(c);
      c.started = true;
      c.phase = "filling";
      emit(port, "filling", { plate: c.truck.plate });
      return true;
    }

    const ended = state === "stop" || state === "emergency_stop";
    if (ended && c.phase === "filling") {
      // عدّ النقلة بيحصل في fillingSessions.closeRecord (بعد ما العداد يستقر)
      const counted = state === "stop" && !c.cancelled;
      emit(port, c.cancelled ? "cancelled" : counted ? "filled" : "aborted", { plate: c.truck.plate });
      leave(port, c);
      return true;
    }
    return true; // starting/moving/reading: stop قديم أو صدى، نتجاهله بدل ما يطلّع العربية
  }

  function cancel(port) {
    stopLoop(port); // إلغاء يدوي بيوقف الـ loop على المنفذ
    const c = active.get(port);
    if (!c) return;
    c.cancelled = true;
    clearCycleTimers(c);
    if (c.phase === "starting" || c.phase === "filling") {
      stop_filling(deps.getMqtt(), { port });
      if (c.phase === "starting") {
        emit(port, "cancelled");
        leave(port, c);
      } // filling: لما stop توصل onState يقفل الدورة (من غير عدّ نقلة)
      return;
    }
    if (c.phase === "leaving") return;
    emit(port, "cancelled");
    leave(port, c);
  }

  // dev_mode اتقفل: انسى الدورات (التعبئة الجارية بتكمل في المسار العادي)
  function reset() {
    stopAllLoops();
    for (const c of active.values()) clearCycleTimers(c);
    active.clear();
  }

  function registerSocket(socket, on) {
    on(
      "dev_start_cycle",
      async (data, operator) => {
        const receipt = data && data.receipt_number != null ? String(data.receipt_number).trim() : "";
        await start(data && data.port, operator, receipt || undefined);
      },
      { auth: true }
    );
    on(
      "dev_cancel_cycle",
      (data) => {
        if (!data || !data.port) throw new Error("port is required");
        cancel(data.port);
      },
      { auth: true }
    );
  }

  return { registerSocket, onPlate, onState, reset, syncLoop };
}

module.exports = { create };
