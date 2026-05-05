(function () {
  "use strict";

  const STORAGE_KEY = "katsu-tabi-kitchen-v1";
  const FINISHED_RETURN_MS = 6 * 60 * 1000;
  /** Red border on just-finished cards after DONE (from when they land in the list). */
  const DONE_HIGHLIGHT_MS = 2 * 60 * 1000;
  const PORK_REST_DISH_KEYS = new Set(["pork-katsu-thick", "pork-katsu-thin"]);
  const PORK_REST_AFTER_DONE_SEC = 60;

  const MAX_QTY = 10;

  /** One fixed cook duration per dish (seconds), same for every quantity 1–10. */
  const DISH_PRESETS = {
    "brussels-sprouts": { label: "Brussels Sprouts", durationSec: 3 * 60 },
    "agedashi-tofu": { label: "Agedashi Tofu", durationSec: 3 * 60 },
    "baby-prawns": { label: "Baby Prawn", durationSec: 3 * 60 },
    karaage: { label: "Karaage", durationSec: 5 * 60 + 30 },
    takoyaki: { label: "Takoyaki", durationSec: 5 * 60 + 30 },
    korokke: { label: "Korokke", durationSec: 5 * 60 + 30 },
    prawn: { label: "Prawn", durationSec: 5 * 60 + 30 },
    "chicken-katsu": { label: "Chicken Katsu", durationSec: 5 * 60 + 25 },
    "pork-katsu-thick": { label: "Pork Katsu Thick", durationSec: 4 * 60 + 25 },
    "pork-katsu-thin": { label: "Pork Katsu Thin", durationSec: 4 * 60 },
    "chicken-nanban": { label: "Chicken Nanban", durationSec: 6 * 60 },
    "chicken-teriyaki": { label: "Chicken Teriyaki", durationSec: 3 * 60 },
    "salmon-teriyaki": { label: "Salmon Teriyaki", durationSec: 1 * 60 },
    "saba-teriyaki": { label: "Saba Teriyaki", durationSec: 3 * 60 },
    "tofu-ochazuke": { label: "Tofu Ochazuke", durationSec: 5 * 60 },
  };

  /** Category sections: keys listed in display order; unlisted keys go under "Other". */
  const DISH_CATEGORY_CHICKEN = ["karaage", "chicken-katsu", "chicken-nanban"];
  const DISH_CATEGORY_PORK = ["pork-katsu-thick", "pork-katsu-thin"];
  const DISH_CATEGORY_TERIYAKI = ["chicken-teriyaki", "salmon-teriyaki", "saba-teriyaki"];

  const $ = (sel, el = document) => el.querySelector(sel);

  function uuid() {
    return crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function defaultState() {
    const tid = uuid();
    return {
      tabs: [{ id: tid, name: "Station 1", timers: [], justFinished: [] }],
      activeTabId: tid,
    };
  }

  function getState() {
    const saved = loadState();
    if (saved && Array.isArray(saved.tabs) && saved.tabs.length) {
      return migrate(saved);
    }
    return defaultState();
  }

  function migrate(s) {
    s.tabs.forEach((tab) => {
      tab.timers = tab.timers || [];
      tab.timers.forEach((t) => {
        if (t.state === "resting" || t.state === "rest_done") return;
        if (t.state !== "running" && t.state !== "paused" && t.state !== "done") {
          t.state = "paused";
          if (t.pausedRemainingMs == null && t.durationSec != null) {
            t.pausedRemainingMs = t.durationSec * 1000;
          }
        }
      });
      tab.justFinished = (tab.justFinished || []).map((item) => ({
        ...item,
        movedAt: item.movedAt || Date.now(),
      }));
    });
    if (!s.tabs.some((t) => t.id === s.activeTabId)) s.activeTabId = s.tabs[0].id;
    return s;
  }

  let state = getState();
  let tickHandle = null;
  let soundPlayedFor = new Set();
  let sharedAudioCtx = null;
  /** Master gain for the current alarm; silenced by stopAlertSound (e.g. DONE). */
  let alertOutputGain = null;
  /** HTML5 alarm: Mobile Safari often blocks Web Audio until unlock; WAV + audio element plays after priming. */
  let alarmAudioPrimed = false;
  let alarmFullWavUrl = null;
  let alarmAudioEl = null;
  /** Dish keys selected for the next timer (same cook time only), in tap order. */
  let selectedDishKeyOrder = [];
  let audioUnlockBound = false;

  function unlockAudio() {
    primeHtml5Alarm();
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
      const ctx = sharedAudioCtx;
      const p = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
      p
        .then(() => {
          /* Inaudible priming pass — helps Mobile Safari treat the context as user-started. */
          const osc = ctx.createOscillator();
          const g = ctx.createGain();
          g.gain.value = 0;
          osc.connect(g);
          g.connect(ctx.destination);
          const t = ctx.currentTime;
          osc.start(t);
          osc.stop(t + 0.001);
        })
        .catch(() => {});
    } catch {
      /* ignore */
    }
  }

  function bindAudioUnlockOnFirstGesture() {
    if (audioUnlockBound) return;
    audioUnlockBound = true;
    const onUnlock = () => {
      unlockAudio();
    };
    document.addEventListener("pointerdown", onUnlock, true);
    document.addEventListener("touchstart", onUnlock, true);
    document.addEventListener("click", onUnlock, true);
  }

  function setAscii(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  /** Pre-rendered twin-bell pattern (~same timing as Web Audio alarm) as 16-bit mono WAV bytes. */
  function buildAlarmWavBytes() {
    const sampleRate = 22050;
    const bell1 = 1046;
    const bell2 = 1320;
    const strikeInterval = 0.068;
    const ringDecay = 0.088;
    const totalTime = 2.45;
    const gapBetweenAlarms = 0.38;
    const numStrikes = Math.floor(totalTime / strikeInterval);
    const durationSec = 2 * totalTime + gapBetweenAlarms;
    const numSamples = Math.ceil(sampleRate * durationSec);
    const pcm = new Float32Array(numSamples);

    function strikeAt(strikeT, freq) {
      const i0 = Math.max(0, Math.floor(strikeT * sampleRate));
      const i1 = Math.min(numSamples, Math.ceil((strikeT + ringDecay + 0.02) * sampleRate));
      for (let i = i0; i < i1; i++) {
        const t = i / sampleRate;
        const dt = t - strikeT;
        if (dt < 0 || dt >= ringDecay) continue;
        const env = Math.exp(-dt * 22);
        let s = 0.42 * Math.sin(2 * Math.PI * freq * t);
        s += 0.14 * Math.sin(2 * Math.PI * freq * 2.8 * t);
        pcm[i] += env * s;
      }
    }

    for (let round = 0; round < 2; round++) {
      const tBase = round * (totalTime + gapBetweenAlarms);
      for (let n = 0; n < numStrikes; n++) {
        const strikeT = tBase + n * strikeInterval;
        const baseFreq = n % 2 === 0 ? bell1 : bell2;
        const wobble = 1 + (n % 5) * 0.003;
        strikeAt(strikeT, baseFreq * wobble);
      }
    }

    let peak = 0.0001;
    for (let i = 0; i < numSamples; i++) peak = Math.max(peak, Math.abs(pcm[i]));
    const norm = 0.98 / peak;

    const dataSize = numSamples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    setAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    setAscii(view, 8, "WAVE");
    setAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    setAscii(view, 36, "data");
    view.setUint32(40, dataSize, true);
    let off = 44;
    for (let i = 0; i < numSamples; i++) {
      const x = Math.max(-1, Math.min(1, pcm[i] * norm));
      view.setInt16(off, Math.round(x * 32767), true);
      off += 2;
    }
    return new Uint8Array(buffer);
  }

  function getAlarmFullWavUrl() {
    if (!alarmFullWavUrl) {
      alarmFullWavUrl = URL.createObjectURL(new Blob([buildAlarmWavBytes()], { type: "audio/wav" }));
    }
    return alarmFullWavUrl;
  }

  function ensureAlarmAudioElement() {
    if (alarmAudioEl) return alarmAudioEl;
    const el = document.createElement("audio");
    el.preload = "auto";
    el.setAttribute("playsinline", "");
    el.setAttribute("webkit-playsinline", "");
    el.src = getAlarmFullWavUrl();
    el.style.display = "none";
    document.body.appendChild(el);
    alarmAudioEl = el;
    return el;
  }

  function whenAlarmAudioReady(el) {
    if (el.readyState >= 2) return Promise.resolve();
    return new Promise((resolve, reject) => {
      el.addEventListener("canplay", () => resolve(), { once: true });
      el.addEventListener("error", () => reject(new Error("alarm-audio-load")), { once: true });
    });
  }

  /** Inaudible / low-gain play so Mobile Safari allows later .play() when the timer fires. */
  function primeHtml5Alarm() {
    if (alarmAudioPrimed) return;
    void (async () => {
      try {
        const el = ensureAlarmAudioElement();
        if (!el.src) el.src = getAlarmFullWavUrl();
        await whenAlarmAudioReady(el);
        el.pause();
        el.currentTime = 0;
        const prevVol = el.volume;
        el.volume = 0.02;
        await el.play();
        el.pause();
        el.currentTime = 0;
        el.volume = prevVol > 0 ? prevVol : 1;
        alarmAudioPrimed = true;
      } catch {
        /* Next tap / timer end will retry or use Web Audio. */
      }
    })();
  }

  function tryVibrateAlarm() {
    try {
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate([180, 100, 180, 100, 280]);
      }
    } catch {
      /* ignore */
    }
  }

  function activeTab() {
    return state.tabs.find((t) => t.id === state.activeTabId);
  }

  function persist() {
    saveState(state);
  }

  function formatTime(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, "0")}`;
  }

  function stopAlertSound() {
    try {
      if (alarmAudioEl) {
        alarmAudioEl.pause();
        alarmAudioEl.currentTime = 0;
      }
    } catch {
      /* ignore */
    }
    try {
      if (!sharedAudioCtx || !alertOutputGain) return;
      const ctx = sharedAudioCtx;
      const now = ctx.currentTime;
      alertOutputGain.gain.cancelScheduledValues(now);
      alertOutputGain.gain.setValueAtTime(0, now);
      alertOutputGain.disconnect();
      alertOutputGain = null;
    } catch {
      alertOutputGain = null;
    }
  }

  async function playWebAudioAlarm() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!sharedAudioCtx) sharedAudioCtx = new Ctx();
    const ctx = sharedAudioCtx;
    if (ctx.state === "suspended") {
      try {
        await ctx.resume();
      } catch {
        return;
      }
    }
    if (ctx.state !== "running") return;
    const t0 = ctx.currentTime;
    const master = ctx.createGain();
    master.gain.setValueAtTime(0.52, t0);
    master.connect(ctx.destination);
    alertOutputGain = master;

    /* Twin-bell mechanical alarm: hammer alternates between two metal tones. */
    const bell1 = 1046;
    const bell2 = 1320;
    const strikeInterval = 0.068;
    const ringDecay = 0.088;
    const totalTime = 2.45;
    const numStrikes = Math.floor(totalTime / strikeInterval);
    const gapBetweenAlarms = 0.38;

    for (let round = 0; round < 2; round++) {
      const tBase = t0 + round * (totalTime + gapBetweenAlarms);

      for (let n = 0; n < numStrikes; n++) {
        const strikeT = tBase + n * strikeInterval;
        const baseFreq = n % 2 === 0 ? bell1 : bell2;
        const wobble = 1 + (n % 5) * 0.003;
        const freq = baseFreq * wobble;

        const tri = ctx.createOscillator();
        const triG = ctx.createGain();
        tri.type = "triangle";
        tri.frequency.setValueAtTime(freq, strikeT);
        triG.gain.setValueAtTime(0.0008, strikeT);
        triG.gain.exponentialRampToValueAtTime(0.26, strikeT + 0.002);
        triG.gain.exponentialRampToValueAtTime(0.0008, strikeT + ringDecay);
        tri.connect(triG);
        triG.connect(master);
        tri.start(strikeT);
        tri.stop(strikeT + ringDecay + 0.015);

        const harm = ctx.createOscillator();
        const harmG = ctx.createGain();
        harm.type = "sine";
        harm.frequency.setValueAtTime(freq * 2.8, strikeT);
        harmG.gain.setValueAtTime(0.0008, strikeT);
        harmG.gain.exponentialRampToValueAtTime(0.09, strikeT + 0.002);
        harmG.gain.exponentialRampToValueAtTime(0.0008, strikeT + ringDecay * 0.85);
        harm.connect(harmG);
        harmG.connect(master);
        harm.start(strikeT);
        harm.stop(strikeT + ringDecay + 0.015);
      }

      /* Quiet motor / spring undertone */
      const buzz = ctx.createOscillator();
      const buzzG = ctx.createGain();
      buzz.type = "square";
      buzz.frequency.setValueAtTime(118, tBase);
      buzzG.gain.setValueAtTime(0.0008, tBase);
      buzzG.gain.exponentialRampToValueAtTime(0.045, tBase + 0.08);
      buzzG.gain.setValueAtTime(0.045, tBase + totalTime - 0.12);
      buzzG.gain.exponentialRampToValueAtTime(0.0008, tBase + totalTime);
      buzz.connect(buzzG);
      buzzG.connect(master);
      buzz.start(tBase);
      buzz.stop(tBase + totalTime + 0.04);
    }
  }

  async function playAlertSound() {
    stopAlertSound();
    tryVibrateAlarm();
    try {
      const el = ensureAlarmAudioElement();
      await whenAlarmAudioReady(el);
      el.pause();
      el.currentTime = 0;
      await el.play();
      return;
    } catch {
      /* Often happens if HTML5 audio was never primed by a user gesture. */
    }
    try {
      await playWebAudioAlarm();
    } catch {
      /* ignore */
    }
  }

  function durationSecForDish(key) {
    const preset = DISH_PRESETS[key];
    if (!preset || preset.durationSec == null) return null;
    return preset.durationSec;
  }

  function dishLabelFromKey(key) {
    const p = DISH_PRESETS[key];
    return p ? p.label : "";
  }

  function timerNeedsPorkRest(t) {
    if (Array.isArray(t.presetKeys) && t.presetKeys.length === 1) {
      return PORK_REST_DISH_KEYS.has(t.presetKeys[0]);
    }
    const name = (t.dishName || "").trim().toLowerCase();
    return (
      name === String(DISH_PRESETS["pork-katsu-thick"].label).toLowerCase() ||
      name === String(DISH_PRESETS["pork-katsu-thin"].label).toLowerCase()
    );
  }

  function moveTimerToJustFinished(tab, t) {
    stopAlertSound();
    tab.timers = tab.timers.filter((x) => x.id !== t.id);
    tab.justFinished.push({
      id: uuid(),
      dishName: t.dishName,
      quantity: t.quantity,
      durationSec: t.durationSec,
      movedAt: Date.now(),
    });
    soundPlayedFor.delete(t.id);
    soundPlayedFor.delete(`${t.id}:rest`);
    persist();
    renderWorkspace();
  }

  function syncDishButtonAria() {
    const sel = new Set(selectedDishKeyOrder);
    document.querySelectorAll("#dish-picker .dish-btn").forEach((btn) => {
      btn.setAttribute("aria-checked", sel.has(btn.dataset.dishKey) ? "true" : "false");
    });
  }

  function getSelectedDishKeys() {
    return selectedDishKeyOrder.slice();
  }

  function clearDishSelection() {
    selectedDishKeyOrder = [];
    syncDishButtonAria();
  }

  function toggleDishKey(key) {
    if (!DISH_PRESETS[key]) return;
    const pos = selectedDishKeyOrder.indexOf(key);
    if (pos >= 0) {
      selectedDishKeyOrder.splice(pos, 1);
      syncDishButtonAria();
      showAddError("");
      attemptAutoStart();
      return;
    }
    const d = durationSecForDish(key);
    if (d == null || !Number.isFinite(d) || d <= 0) return;
    if (selectedDishKeyOrder.length) {
      const refD = durationSecForDish(selectedDishKeyOrder[0]);
      if (d !== refD) {
        showAddError(
          "Only dishes with the same cook time can run together. Deselect a dish or choose items with the same time."
        );
        return;
      }
    }
    selectedDishKeyOrder.push(key);
    syncDishButtonAria();
    showAddError("");
    attemptAutoStart();
  }

  function buildDishPicker() {
    const host = $("#dish-picker");
    host.innerHTML = "";
    selectedDishKeyOrder = [];

    const inCategory = new Set([...DISH_CATEGORY_CHICKEN, ...DISH_CATEGORY_PORK, ...DISH_CATEGORY_TERIYAKI]);
    const otherKeys = Object.keys(DISH_PRESETS)
      .filter((k) => !inCategory.has(k))
      .sort((a, b) =>
        DISH_PRESETS[a].label.localeCompare(DISH_PRESETS[b].label, undefined, { sensitivity: "base" })
      );

    const sections = [
      { title: "Chicken", keys: DISH_CATEGORY_CHICKEN },
      { title: "Pork", keys: DISH_CATEGORY_PORK },
      { title: "Teriyaki", keys: DISH_CATEGORY_TERIYAKI },
      { title: "Other dishes", keys: otherKeys },
    ];

    sections.forEach((section) => {
      const keys = section.keys.filter((k) => DISH_PRESETS[k]);
      if (!keys.length) return;

      const region = document.createElement("section");
      region.className = "dish-category";
      region.setAttribute("role", "group");
      region.setAttribute("aria-label", section.title);

      const heading = document.createElement("h3");
      heading.className = "dish-category-title";
      heading.textContent = section.title;
      region.append(heading);

      const grid = document.createElement("div");
      grid.className = "dish-category-grid";

      keys.forEach((key) => {
        const preset = DISH_PRESETS[key];
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dish-btn";
        btn.dataset.dishKey = key;
        btn.textContent = preset.label;
        btn.title = `${formatTime(preset.durationSec)} cook time`;
        btn.setAttribute("role", "checkbox");
        btn.setAttribute("aria-checked", "false");
        btn.addEventListener("click", () => {
          toggleDishKey(key);
        });
        grid.append(btn);
      });

      region.append(grid);
      host.append(region);
    });
  }

  function getSelectedQuantity() {
    const pressed = document.querySelector("#quantity-picker .qty-btn[aria-checked='true']");
    return pressed ? parseInt(pressed.dataset.qty, 10) : null;
  }

  function setSelectedQuantity(qty) {
    document.querySelectorAll("#quantity-picker .qty-btn").forEach((btn) => {
      btn.setAttribute("aria-checked", btn.dataset.qty === String(qty) ? "true" : "false");
    });
  }

  function clearQuantitySelection() {
    document.querySelectorAll("#quantity-picker .qty-btn").forEach((btn) => {
      btn.setAttribute("aria-checked", "false");
    });
  }

  function buildQuantityPicker() {
    const host = $("#quantity-picker");
    host.innerHTML = "";
    for (let q = 1; q <= MAX_QTY; q++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "qty-btn";
      btn.textContent = String(q);
      btn.dataset.qty = String(q);
      btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", "false");
      btn.addEventListener("click", () => {
        setSelectedQuantity(q);
        attemptAutoStart();
      });
      host.append(btn);
    }
  }

  function showAddError(msg) {
    const el = $("#add-form-error");
    if (!msg) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    el.hidden = false;
    el.textContent = msg;
  }

  /** Remaining time (ms); paused uses frozen value captured at Stop for exact resume. */
  function timerRemainingMs(t) {
    if (t.state === "done" || t.state === "rest_done") return 0;
    if (t.state === "paused") {
      if (t.pausedRemainingMs != null) return Math.max(0, t.pausedRemainingMs);
      return Math.max(0, (t.pausedRemainingSec ?? 0) * 1000);
    }
    if ((t.state === "running" || t.state === "resting") && t.endAt) {
      return Math.max(0, t.endAt - Date.now());
    }
    return (t.durationSec ?? 0) * 1000;
  }

  /** Whole seconds for display (ceiling so 0.3s left shows as 1s until it hits zero). */
  function timerRemainingSec(t) {
    return Math.ceil(timerRemainingMs(t) / 1000);
  }

  function tryCompleteRestTimer(t) {
    if (t.state !== "resting") return;
    if (timerRemainingMs(t) > 0) return;
    t.state = "rest_done";
    t.endAt = null;
    if (!soundPlayedFor.has(`${t.id}:rest`)) {
      soundPlayedFor.add(`${t.id}:rest`);
      playAlertSound();
    }
    persist();
  }

  function tryCompleteTimer(t) {
    if (t.state !== "running") return;
    if (timerRemainingMs(t) > 0) return;
    t.state = "done";
    t.pausedRemainingMs = null;
    t.pausedRemainingSec = 0;
    t.endAt = null;
    if (!soundPlayedFor.has(t.id)) {
      soundPlayedFor.add(t.id);
      playAlertSound();
    }
    persist();
  }

  function startTimerObject(t) {
    const ms = timerRemainingMs(t);
    t.state = "running";
    t.endAt = Date.now() + ms;
    t.pausedRemainingMs = null;
    t.pausedRemainingSec = null;
    persist();
  }

  function addTimer(dishName, quantity, durationSec, presetKeys) {
    const tab = activeTab();
    if (!dishName) {
      showAddError("Select one or more dishes with the same cook time.");
      return false;
    }
    const t = {
      id: uuid(),
      dishName,
      quantity,
      durationSec,
      state: "running",
      endAt: Date.now() + durationSec * 1000,
      pausedRemainingMs: null,
      pausedRemainingSec: null,
      createdAt: Date.now(),
      presetKeys: Array.isArray(presetKeys) && presetKeys.length ? presetKeys.slice() : null,
    };
    tab.timers.push(t);
    soundPlayedFor.delete(t.id);
    persist();
    renderWorkspace();
    return true;
  }

  function attemptAutoStart() {
    const keys = getSelectedDishKeys();
    const quantity = getSelectedQuantity();

    if (!keys.length || quantity == null) {
      showAddError("");
      return;
    }

    const durations = keys.map((k) => durationSecForDish(k));
    if (durations.some((d) => d == null || !Number.isFinite(d) || d <= 0)) {
      showAddError("No cook time is set for one of the selected dishes.");
      return;
    }
    const durationSec = durations[0];
    if (durations.some((d) => d !== durationSec)) {
      showAddError("Selected dishes must share the same cook time.");
      return;
    }

    const dishName = keys.map((k) => dishLabelFromKey(k)).join(" + ");
    showAddError("");
    if (addTimer(dishName, quantity, durationSec, keys)) {
      clearQuantitySelection();
      clearDishSelection();
    }
  }

  function sortTimers(tab) {
    tab.timers.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  function renderTabs() {
    const list = $("#tab-list");
    list.innerHTML = "";
    state.tabs.forEach((tab) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tab";
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", tab.id === state.activeTabId ? "true" : "false");
      btn.dataset.tabId = tab.id;

      const name = document.createElement("span");
      name.className = "tab-name";
      name.textContent = tab.name || "Workspace";

      const close = document.createElement("button");
      close.type = "button";
      close.className = "tab-close";
      close.setAttribute("aria-label", `Close ${tab.name}`);
      close.textContent = "×";
      close.dataset.closeTab = tab.id;

      btn.append(name);
      if (state.tabs.length > 1) btn.append(close);

      btn.addEventListener("click", (e) => {
        if (e.target.closest("[data-close-tab]")) {
          e.stopPropagation();
          removeTab(close.dataset.closeTab);
          return;
        }
        state.activeTabId = tab.id;
        persist();
        renderWorkspace();
      });

      close.addEventListener("click", (e) => {
        e.stopPropagation();
        removeTab(tab.id);
      });

      list.append(btn);
    });
  }

  function removeTab(id) {
    if (state.tabs.length <= 1) return;
    state.tabs = state.tabs.filter((t) => t.id !== id);
    if (state.activeTabId === id) state.activeTabId = state.tabs[0].id;
    persist();
    renderWorkspace();
  }

  function renderTimers() {
    const tab = activeTab();
    const ul = $("#timer-list");
    const empty = $("#timers-empty");
    sortTimers(tab);
    ul.innerHTML = "";

    if (!tab.timers.length) {
      empty.hidden = false;
    } else {
      empty.hidden = true;
    }

    tab.timers.forEach((t) => {
      const remaining = timerRemainingSec(t);
      const li = document.createElement("li");
      li.setAttribute("data-timer-id", t.id);
      li.className = "timer-card";
      if (t.state === "running") li.classList.add("timer-card--running");
      else if (t.state === "done") li.classList.add("timer-card--done");
      else if (t.state === "paused") li.classList.add("timer-card--paused");
      else if (t.state === "resting") li.classList.add("timer-card--resting");
      else if (t.state === "rest_done") li.classList.add("timer-card--done");

      const doneLike = t.state === "done" || t.state === "rest_done";

      if (doneLike) {
        li.innerHTML = `
        <div class="timer-top timer-top--done">
          <div>
            <p class="timer-dish"></p>
            <p class="timer-meta"></p>
          </div>
          <div class="timer-done-right">
            <div class="timer-remaining" aria-label="Time left"></div>
            <div class="timer-done-slot"></div>
          </div>
        </div>
        <div class="timer-actions"></div>
      `;
      } else {
        li.innerHTML = `
        <div class="timer-top">
          <div>
            <p class="timer-dish"></p>
            <p class="timer-meta"></p>
            <p class="timer-rest-note" hidden></p>
          </div>
          <div class="timer-remaining" aria-label="Time left"></div>
        </div>
        <div class="timer-actions"></div>
      `;
      }

      $(".timer-dish", li).textContent = t.dishName;
      $(".timer-meta", li).textContent = `Qty ${t.quantity} · ${formatTime(t.durationSec)} total`;

      const restNote = li.querySelector(".timer-rest-note");
      if (restNote) {
        if (t.state === "resting") {
          restNote.hidden = false;
          restNote.textContent = "Pork is resting";
        } else {
          restNote.hidden = true;
          restNote.textContent = "";
        }
      }

      const remText =
        t.state === "done" || t.state === "rest_done" ? "Done" : formatTime(remaining);
      $(".timer-remaining", li).textContent = remText;

      const actions = $(".timer-actions", li);

      if (t.state === "running") {
        const pause = document.createElement("button");
        pause.type = "button";
        pause.className = "btn btn-small";
        pause.textContent = "Stop";
        pause.addEventListener("click", () => {
          const ms = t.endAt != null ? Math.max(0, t.endAt - Date.now()) : 0;
          t.state = "paused";
          t.pausedRemainingMs = ms;
          t.pausedRemainingSec = null;
          t.endAt = null;
          persist();
          renderWorkspace();
        });
        actions.append(pause);
      } else if (t.state === "paused") {
        const resume = document.createElement("button");
        resume.type = "button";
        resume.className = "btn btn-small btn-primary";
        resume.textContent = "Resume";
        resume.addEventListener("click", () => {
          startTimerObject(t);
          soundPlayedFor.delete(t.id);
          soundPlayedFor.delete(`${t.id}:rest`);
          renderWorkspace();
        });
        actions.append(resume);
      }

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-small btn-danger";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => {
        tab.timers = tab.timers.filter((x) => x.id !== t.id);
        soundPlayedFor.delete(t.id);
        soundPlayedFor.delete(`${t.id}:rest`);
        persist();
        renderWorkspace();
      });
      actions.append(cancel);

      if (t.state !== "resting") {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "btn btn-small btn-ghost";
        reset.textContent = "Reset";
        reset.addEventListener("click", () => {
          t.state = "paused";
          t.pausedRemainingMs = t.durationSec * 1000;
          t.pausedRemainingSec = null;
          t.endAt = null;
          soundPlayedFor.delete(t.id);
          soundPlayedFor.delete(`${t.id}:rest`);
          persist();
          renderWorkspace();
        });
        actions.append(reset);
      }

      if (t.state === "done") {
        const move = document.createElement("button");
        move.type = "button";
        move.className = "btn btn-primary btn-done";
        move.textContent = "DONE";
        move.setAttribute("aria-label", "Done — move to just finished section");
        move.addEventListener("click", () => {
          if (timerNeedsPorkRest(t)) {
            stopAlertSound();
            t.state = "resting";
            t.endAt = Date.now() + PORK_REST_AFTER_DONE_SEC * 1000;
            soundPlayedFor.delete(`${t.id}:rest`);
            persist();
            renderWorkspace();
            return;
          }
          moveTimerToJustFinished(tab, t);
        });
        $(".timer-done-slot", li).append(move);
      } else if (t.state === "rest_done") {
        const move = document.createElement("button");
        move.type = "button";
        move.className = "btn btn-primary btn-done";
        move.textContent = "DONE";
        move.setAttribute("aria-label", "Done — move to just finished section");
        move.addEventListener("click", () => {
          moveTimerToJustFinished(tab, t);
        });
        $(".timer-done-slot", li).append(move);
      }

      ul.append(li);
    });
  }

  function renderJustFinished() {
    const tab = activeTab();
    const ul = $("#finished-list");
    ul.innerHTML = "";
    const now = Date.now();

    const beforeCt = tab.justFinished.length;
    tab.justFinished = tab.justFinished.filter(
      (item) => now - (item.movedAt || 0) < FINISHED_RETURN_MS
    );
    if (tab.justFinished.length !== beforeCt) persist();

    tab.justFinished.forEach((item) => {
      const left = Math.max(0, FINISHED_RETURN_MS - (now - item.movedAt));
      const li = document.createElement("li");
      li.setAttribute("data-finished-id", item.id);
      li.className = "timer-card finished-card";
      if (now - (item.movedAt || 0) < DONE_HIGHLIGHT_MS) {
        li.classList.add("finished-card--done-highlight");
      }
      li.innerHTML = `
        <div class="timer-top finished-top">
          <div class="finished-info">
            <p class="timer-dish"></p>
            <p class="timer-meta"></p>
            <p class="finished-countdown"></p>
          </div>
          <div class="finished-cook-block">
            <span class="finished-cook-label">Cook time</span>
            <p class="finished-cook-value"></p>
          </div>
        </div>
        <div class="timer-actions"></div>
      `;
      $(".timer-dish", li).textContent = item.dishName;
      $(".timer-meta", li).textContent = `Qty ${item.quantity}`;
      const cookBlock = $(".finished-cook-block", li);
      const cookVal = $(".finished-cook-value", li);
      if (item.durationSec != null && Number.isFinite(item.durationSec)) {
        cookVal.textContent = formatTime(item.durationSec);
        cookBlock.hidden = false;
      } else {
        cookBlock.hidden = true;
      }
      $(".finished-countdown", li).textContent = `Returns in ${Math.ceil(left / 1000)}s`;
      const actions = $(".timer-actions", li);
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "btn btn-small";
      dismiss.textContent = "Dismiss now";
      dismiss.addEventListener("click", () => {
        tab.justFinished = tab.justFinished.filter((x) => x.id !== item.id);
        persist();
        renderWorkspace();
      });
      actions.append(dismiss);
      ul.append(li);
    });
  }

  function escapeAttr(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  /** Lightweight UI sync for tick: do not rebuild timer rows (preserves click targets). */
  function refreshTimerListDisplay(tab) {
    const ul = $("#timer-list");
    if (!ul) return false;

    if (tab.timers.length === 0) {
      return ul.querySelector("[data-timer-id]") === null;
    }

    sortTimers(tab);
    const domIds = Array.from(ul.querySelectorAll("[data-timer-id]")).map((el) =>
      el.getAttribute("data-timer-id")
    );
    const stateIds = tab.timers.map((x) => x.id);
    if (domIds.length !== stateIds.length || domIds.some((id, i) => id !== stateIds[i])) {
      return false;
    }

    for (const t of tab.timers) {
      const li = ul.querySelector(`[data-timer-id="${escapeAttr(t.id)}"]`);
      if (!li) return false;
      const remEl = li.querySelector(".timer-remaining");
      if (!remEl) return false;
      const remText =
        t.state === "done" || t.state === "rest_done" ? "Done" : formatTime(timerRemainingSec(t));
      remEl.textContent = remText;

      const restNote = li.querySelector(".timer-rest-note");
      if (t.state === "resting") {
        if (!restNote) return false;
        restNote.hidden = false;
        restNote.textContent = "Pork is resting";
      } else if (restNote) {
        restNote.hidden = true;
        restNote.textContent = "";
      }

      li.className = "timer-card";
      if (t.state === "running") li.classList.add("timer-card--running");
      else if (t.state === "done") li.classList.add("timer-card--done");
      else if (t.state === "paused") li.classList.add("timer-card--paused");
      else if (t.state === "resting") li.classList.add("timer-card--resting");
      else if (t.state === "rest_done") li.classList.add("timer-card--done");
    }

    return true;
  }

  function refreshJustFinishedDisplay(tab, now) {
    const ul = $("#finished-list");
    if (!ul) return false;

    if (tab.justFinished.length === 0) {
      return ul.querySelector("[data-finished-id]") === null;
    }

    const domIds = Array.from(ul.querySelectorAll("[data-finished-id]")).map((el) =>
      el.getAttribute("data-finished-id")
    );
    const stateIds = tab.justFinished.map((x) => x.id);
    if (domIds.length !== stateIds.length || domIds.some((id, i) => id !== stateIds[i])) {
      return false;
    }

    for (const item of tab.justFinished) {
      const li = ul.querySelector(`[data-finished-id="${escapeAttr(item.id)}"]`);
      if (!li) return false;
      const cd = li.querySelector(".finished-countdown");
      if (!cd) return false;
      const left = Math.max(0, FINISHED_RETURN_MS - (now - (item.movedAt || 0)));
      cd.textContent = `Returns in ${Math.ceil(left / 1000)}s`;
      const hl = now - (item.movedAt || 0) < DONE_HIGHLIGHT_MS;
      li.classList.toggle("finished-card--done-highlight", hl);
    }

    return true;
  }

  function renderWorkspace() {
    renderTabs();
    renderTimers();
    renderJustFinished();
  }

  function tick() {
    const tab = activeTab();
    let needFullRender = false;

    tab.timers.forEach((t) => {
      if (t.state === "running") {
        tryCompleteTimer(t);
        if (t.state === "done") needFullRender = true;
      } else if (t.state === "resting") {
        tryCompleteRestTimer(t);
        if (t.state === "rest_done") needFullRender = true;
      }
    });

    const now = Date.now();
    const jfBefore = tab.justFinished.length;
    tab.justFinished = tab.justFinished.filter(
      (item) => now - (item.movedAt || 0) < FINISHED_RETURN_MS
    );
    if (tab.justFinished.length !== jfBefore) {
      persist();
      needFullRender = true;
    }

    if (needFullRender) {
      renderWorkspace();
      return;
    }

    let ok = refreshTimerListDisplay(tab);
    ok = refreshJustFinishedDisplay(tab, now) && ok;
    if (!ok) renderWorkspace();
  }

  function startTicking() {
    if (tickHandle) clearInterval(tickHandle);
    tickHandle = setInterval(tick, 250);
  }

  function initForm() {
    buildDishPicker();
    buildQuantityPicker();
  }

  $("#btn-add-tab").addEventListener("click", () => {
    const name = window.prompt("Workspace name (e.g. your name):", "Station");
    if (name == null || !String(name).trim()) return;
    const id = uuid();
    state.tabs.push({ id, name: String(name).trim(), timers: [], justFinished: [] });
    state.activeTabId = id;
    persist();
    renderWorkspace();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      try {
        if (sharedAudioCtx && sharedAudioCtx.state === "suspended") {
          sharedAudioCtx.resume().catch(() => {});
        }
      } catch {
        /* ignore */
      }
      renderWorkspace();
    }
  });

  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) {
      state = getState();
      soundPlayedFor.clear();
      renderWorkspace();
    }
  });

  initForm();
  bindAudioUnlockOnFirstGesture();
  renderWorkspace();
  startTicking();
})();
