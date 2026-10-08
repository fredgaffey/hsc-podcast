// STOP (2026-07-09): Repo locked until 6 Nov 2026 (after the HSC). No work here without tangible study gain. See STOP-UNTIL-NOV-6.md. Go do past papers.
(() => {
  const PROGRESS_KEY = "podcast-progress";
  const THEME_KEY = "podcast-theme";
  const SPEED_KEY = "podcast-speed";
  const DEFAULT_VOICE_KEY = "podcast-default-voice";
  const DOWNLOADS_KEY = "podcast-downloads";          // localStorage index of downloaded episodes
  const DOWNLOAD_ALL_VOICES_KEY = "podcast-download-all-voices";
  const BLOCK_MOBILE_KEY = "podcast-block-mobile-data"; // default ON ("0" = off)
  const DOWNLOADS_CACHE = "podcast-downloads-v1";     // must match service-worker.js
  const SPEED_UNIT_KEY = "podcast-speed-unit";        // "mult" (×) | "sps" (syllables/sec)
  const LISTEN_LOG_KEY = "podcast-listen-log";        // { "YYYY-MM-DD": wall-clock secondsSpent }
  const VOICE_LOG_KEY = "podcast-voice-log";          // { voiceName: content-seconds actually played }
  const LAST_SUBJECT_KEY = "podcast-last-subject";    // remember which subject was last open
  const SIMPLE_SPEED_KEY = "podcast-simple-speed";    // "1" = simple dropdown speed picker (screen-off/low-speed mode)
  const HS_ENGINE_KEY = "podcast-speechwarp";         // "0" = user opted out of the speechwarp engine in high-speed mode (default on)
  const PLAYER_MIN_KEY = "podcast-player-min";        // "1" = now-playing bar minimised to save space
  const SUBJECTS_KEY = "podcast-subjects";            // JSON array of chosen subject ids (onboarding); absent = show all
  const ONBOARDED_KEY = "podcast-onboarded";          // "1" once the first-run subject picker has been completed/skipped

  // Speed is shown in syllables/second, not "×". BASE_SPS is the narration's
  // natural rate at 1× playback: this content runs ~140 wpm (modules)–177
  // (case studies) at ~1.5 syllables/word → ~3.75 syl/s. Tune BASE_WPM to taste.
  const BASE_WPM = 150;
  const SYLLABLES_PER_WORD = 1.5;
  const BASE_SPS = (BASE_WPM * SYLLABLES_PER_WORD) / 60;

  const SPEED_OPTIONS = [];
  for (let s = 0.25; s <= 16; s += 0.25) SPEED_OPTIONS.push(Math.round(s * 100) / 100);

  // FEATURE-12: fire-and-forget usage telemetry (auth.js batches + posts to the backend).
  const track = (event, props) => { try { window.Telemetry && window.Telemetry.track(event, props); } catch (e) {} };
  // BUG-30: audio-less card-only module prefixes — kept as flashcards, hidden from the podcast list.
  const CARD_ONLY_PREFIXES = new Set(["MEM", "EPC"]);
  // Subjects that have a set-text plot map (content/<id>/<text>/scenes.json).
  const PLOT_MAP_SUBJECTS = new Set(["english-standard"]);

  let fullManifest = null;       // { subjects: [...] } as loaded from manifest.json
  let currentSubject = null;     // id of the subject currently in view
  let currentLibMode = "podcasts"; // which library mode is showing: "podcasts" | "papers"
  let manifest = null;           // the current subject's view: { modules: [...] }
  let currentEpisode = null;
  let currentVoiceIndex = 0;
  let loadToken = 0;          // guards against stale loadedmetadata on rapid src changes
  let lastSavedAt = 0;
  let lastListenTick = 0;     // wall-clock ms of the previous timeupdate while playing
  let pendingListenSecs = 0;  // wall seconds, flushed to the daily log every few seconds
  let pendingContentSecs = 0; // content seconds played (wall × rate), flushed to the voice log
  let isSeeking = false;
  let lastAutoAdvanceAt = 0;  // wall-clock ms of the last auto-advance (runaway-cascade guard)
  let showRemaining = false;
  let sleepIdx = 0;
  let sleepTimeout = null;
  let swipeStartX = 0;
  let swipeStartY = 0;
  let queue = [];
  let advanceTimer = null;
  let syncParas = null;       // transcript sync: [{el, startFrac, endFrac}]
  let syncActiveEl = null;
  let lastSyncScroll = 0;     // perf.now() of last transcript auto-scroll (throttle)

  // --- DOM refs ---
  const audioEl = document.getElementById("audio");
  // Hybrid audio (see speed-engine.js). DEFAULT backend in high-speed mode: the speechwarp
  // engine (nonlinear Speedy/Sonic speed-up in an AudioWorklet), audible and followable to
  // 16x on any device but no background playback. FALLBACK: the native <audio> element with
  // preservesPitch — used in screen-off mode, for long-form audio, and when the Settings
  // toggle is off. In engine mode a silent looping element anchors the iOS media session so
  // lock-screen / headphone controls still work. See createHybridAudio.
  const audio = window.createHybridAudio ? window.createHybridAudio(audioEl) : audioEl;

  // --- BUG-36 audio diagnostics (ring buffer; no behaviour change) ---
  // Records timestamped audio/media-session events so we can see what iOS actually does through a
  // pause→lock→resume cycle instead of guessing. Read/copied from Settings → About → Audio log.
  // Persisted to localStorage so it SURVIVES a reload/PWA relaunch — critical because iOS may
  // relaunch a backgrounded PWA on unlock, which would otherwise wipe the in-memory log and hide the
  // very sequence we're after. A "=== app load ===" marker on startup makes any relaunch visible.
  const AUDIO_LOG_KEY = "hsc-audio-log";
  let AUDIO_LOG = [];
  try { AUDIO_LOG = JSON.parse(localStorage.getItem(AUDIO_LOG_KEY) || "[]"); } catch (e) { AUDIO_LOG = []; }
  if (!Array.isArray(AUDIO_LOG)) AUDIO_LOG = [];
  AUDIO_LOG.push({ t: Date.now(), line: "=== app load ===" });
  function persistAudioLog() { try { localStorage.setItem(AUDIO_LOG_KEY, JSON.stringify(AUDIO_LOG.slice(-250))); } catch (e) {} }
  function alog(msg, extra) {
    let line = msg;
    try {
      const bits = [
        "paused=" + audioEl.paused,
        "t=" + (audioEl.currentTime || 0).toFixed(1),
        "rate=" + (audioEl.playbackRate || 1),
        "ready=" + audioEl.readyState,
        "net=" + audioEl.networkState,
        "vis=" + document.visibilityState,
      ];
      if (audioEl.error) bits.push("err=" + audioEl.error.code);
      if ("mediaSession" in navigator) bits.push("ms=" + navigator.mediaSession.playbackState);
      if (audioCtx) bits.push("ctx=" + audioCtx.state);
      if (extra) bits.push(extra);
      line += " {" + bits.join(" ") + "}";
    } catch (e) {}
    AUDIO_LOG.push({ t: Date.now(), line });
    if (AUDIO_LOG.length > 250) AUDIO_LOG.shift();
    persistAudioLog();
  }
  // Passively record the element's own lifecycle — these fire regardless of who called play().
  // 'playing' is the key one: it means audio is actually producing output (not just currentTime moving).
  ["play", "playing", "pause", "waiting", "stalled", "suspend", "ended", "error", "loadstart"].forEach((ev) =>
    audioEl.addEventListener(ev, () => alog("evt:" + ev))
  );
  document.addEventListener("visibilitychange", () => alog("vis:" + document.visibilityState));

  // --- BUG-36 experimental "background pause" mode (Settings toggle, default OFF) -------------------
  // Validates the re-encode plan's premise: does routing <audio> through a session-holding WebAudio
  // graph actually fix lock-screen pause→resume? Attempt 5 proved this routing only *breaks* HIGH speed
  // — so this mode forces 1× (see the playbackRate sites). If it confirms resume works at 1×, Step 2
  // pre-renders each voice at the target speed, so we can play at 1× AND keep high speed. crossOrigin
  // must be set before the first src, so it's applied at init when the mode is on (toggling reloads).
  const BG_PAUSE_KEY = "hsc-bg-pause";
  // CONCLUDED OFF. The WebAudio 1× test (build 4f9346d) logged ctx=interrupted the moment the app was
  // backgrounded — iOS suspends the WebAudio context for a backgrounded PWA and the silent keepalive
  // can't prevent it. So WebAudio can't hold the session either (same wall as native), AND routing
  // breaks native background *playback* + adds a pause stutter — strictly worse. Left OFF: native high
  // speed + working background playback. Set localStorage BG_PAUSE_KEY='1' only to re-inspect the graph.
  // TODO (task #19): strip the dormant WebAudio graph + kicks + diagnostics for good.
  function bgPauseMode() { return localStorage.getItem(BG_PAUSE_KEY) === "1"; }
  let audioCtx = null, mediaSrcNode = null, silentKeepalive = null;
  if (bgPauseMode()) audioEl.crossOrigin = "anonymous";
  function ensureAudioGraph() {
    if (audioCtx || !bgPauseMode()) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      audioCtx = new AC();
      mediaSrcNode = audioCtx.createMediaElementSource(audioEl);
      mediaSrcNode.connect(audioCtx.destination);
      // 1s of silence, looped forever — keeps the audio session active while the element is paused.
      const buf = audioCtx.createBuffer(1, Math.max(1, Math.floor(audioCtx.sampleRate)), audioCtx.sampleRate);
      silentKeepalive = audioCtx.createBufferSource();
      silentKeepalive.buffer = buf; silentKeepalive.loop = true;
      silentKeepalive.connect(audioCtx.destination); silentKeepalive.start(0);
      alog("graph:created", "sr=" + audioCtx.sampleRate);
    } catch (e) { audioCtx = null; mediaSrcNode = null; silentKeepalive = null; alog("graph:FAILED", "err=" + (e && e.name)); }
  }
  function resumeAudioGraph() {
    if (!bgPauseMode()) return;
    ensureAudioGraph();
    if (audioCtx && audioCtx.state === "suspended") audioCtx.resume().then(() => alog("ctx:resumed")).catch((e) => alog("ctx:resume-failed", "err=" + (e && e.name)));
  }
  ["pointerdown", "keydown"].forEach((ev) => document.addEventListener(ev, resumeAudioGraph, { passive: true }));
  alog("bg-mode", bgPauseMode() ? "ON (WebAudio 1x test)" : "off (native)");

  const viewSubjects = document.getElementById("view-subjects");
  const viewSubjectHub = document.getElementById("view-subject-hub");
  const viewLibrary = document.getElementById("view-library");
  const viewEpisode = document.getElementById("view-episode");
  const viewMap = document.getElementById("view-map");
  const viewModules = document.getElementById("view-modules");
  const viewModule = document.getElementById("view-module");
  const viewCards = document.getElementById("view-cards");
  const views = { subjects: viewSubjects, hub: viewSubjectHub, library: viewLibrary, episode: viewEpisode, map: viewMap, modules: viewModules, module: viewModule, cards: viewCards };
  const btnBack = document.getElementById("btn-back");
  const btnTheme = document.getElementById("btn-theme");
  const btnSleep = document.getElementById("btn-sleep");
  const btnStats = document.getElementById("btn-stats");
  const btnQueue = document.getElementById("btn-queue");
  const queueOverlay = document.getElementById("queue-overlay");
  const queueListEl = document.getElementById("queue-list");
  const btnQueueClear = document.getElementById("btn-queue-clear");
  const qNowTitleEl = document.getElementById("q-now-title");
  const btnSettings = document.getElementById("btn-settings");
  const settingsOverlay = document.getElementById("settings-overlay");
  const btnSettingsClose = document.getElementById("btn-settings-close");
  const defaultVoiceSelect = document.getElementById("default-voice-select");
  const dlAllVoicesToggle = document.getElementById("dl-all-voices");
  const blockMobileToggle = document.getElementById("block-mobile-data");
  const introTitleToggle = document.getElementById("intro-title");
  const speedEngineToggle = document.getElementById("speed-engine");
  const INTRO_KEY = "podcast-intro";                  // default ON ("0" = off)
  const introEnabled = () => localStorage.getItem(INTRO_KEY) !== "0";
  const quizSplitToggle = document.getElementById("quiz-split-subject");
  const QUIZ_SPLIT_KEY = "podcast-quiz-split-subject"; // default OFF ("1" = split daily quiz per subject)
  const quizSplitBySubject = () => localStorage.getItem(QUIZ_SPLIT_KEY) === "1";
  const fsrsRetentionSelect = document.getElementById("fsrs-retention");
  const fsrsStepsInput = document.getElementById("fsrs-steps");
  const storageUsageEl = document.getElementById("storage-usage");
  const btnClearDownloads = document.getElementById("btn-clear-downloads");
  const btnInstall = document.getElementById("btn-install");
  const installHint = document.getElementById("install-hint");
  const queueBadge = document.getElementById("queue-badge");
  const playerTimeEl = document.querySelector(".player-time");
  const playerBar = document.getElementById("player-bar");
  const btnPlay = document.getElementById("btn-play");
  const btnRewind = document.getElementById("btn-rewind");
  const btnForward = document.getElementById("btn-forward");
  const progressBarEl = document.getElementById("progress-bar");
  const timeCurrent = document.getElementById("time-current");
  const timeTotal = document.getElementById("time-total");
  const themeColorMeta = document.getElementById("theme-color-meta");
  const voiceSelect = document.getElementById("voice-select");
  const speedSlider = document.getElementById("speed-slider");
  const speedInput = document.getElementById("speed-input");
  const btnSpeedDown = document.getElementById("btn-speed-down");
  const btnSpeedUp = document.getElementById("btn-speed-up");
  const speedUnitEl = document.getElementById("speed-unit");
  const speedUnitSelect = document.getElementById("speed-unit-select");
  const episodeTitleEl = document.getElementById("episode-title");
  const episodeContentEl = document.getElementById("episode-content");
  const tabBtns = document.querySelectorAll(".tab-btn");
  const episodeTabs = document.querySelector(".tabs");
  const advanceToast = document.getElementById("advance-toast");
  const advanceTitleEl = document.getElementById("advance-title");
  const advanceCountdownEl = document.getElementById("advance-countdown");
  const btnAdvanceCancel = document.getElementById("btn-advance-cancel");
  const statsOverlay = document.getElementById("stats-overlay");
  const statsContent = document.getElementById("stats-content");
  const btnStatsClose = document.getElementById("btn-stats-close");
  const btnReview = document.getElementById("btn-review");
  const reviewOverlay = document.getElementById("review-overlay");
  const reviewContent = document.getElementById("review-content");
  const quizArea = document.getElementById("quiz-area");
  const libSearchInput = document.getElementById("library-search");
  const libSearchWrap = document.getElementById("library-search-wrap");
  const playerEpTitle = document.getElementById("player-ep-title");
  const playerEpSub = document.getElementById("player-ep-sub");

  function setHidden(el, hidden) {
    if (hidden) el.setAttribute("hidden", "");
    else el.removeAttribute("hidden");
  }

  // --- Bottom-sheet overlays: open/close with focus management (a11y) ---
  // Move focus into the sheet on open and restore it to the opener on close, so
  // keyboard/screen-reader users aren't stranded. Paired with role="dialog".
  let sheetOpener = null;
  let savedScrollY = 0;
  // Lock the page behind a sheet so it can't scroll. Uses the position:fixed technique
  // (iOS Safari ignores `overflow:hidden` on body) and preserves/restores scroll position.
  function lockBodyScroll() {
    if (document.body.classList.contains("sheet-open")) return;
    savedScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.style.top = `-${savedScrollY}px`;
    document.body.classList.add("sheet-open");
  }
  function unlockBodyScroll() {
    if (!document.body.classList.contains("sheet-open")) return;
    document.body.classList.remove("sheet-open");
    document.body.style.top = "";
    window.scrollTo(0, savedScrollY);
  }
  function openSheet(overlay) {
    sheetOpener = document.activeElement;
    setHidden(overlay, false);
    lockBodyScroll();
    const panel = overlay.querySelector(".stats-panel");
    const target = panel && (panel.querySelector(".sheet-close") || panel);
    if (target) { if (target === panel) panel.tabIndex = -1; target.focus(); }
  }
  function closeSheet(overlay) {
    setHidden(overlay, true);
    if (!activeSheet()) unlockBodyScroll(); // only release when no sheet remains open
    if (sheetOpener && typeof sheetOpener.focus === "function") sheetOpener.focus();
    sheetOpener = null;
    // If the review sheet was opened via a subject's #/…/quizzes route, drop back to the
    // hub URL so the hash reflects what's on screen (and re-tapping the tile reopens it).
    if (overlay === reviewOverlay && /\/quizzes$/.test(window.location.hash)) {
      const hub = window.location.hash.replace(/\/quizzes$/, "");
      history.replaceState(null, "", hub);
    }
  }
  function activeSheet() {
    return [statsOverlay, reviewOverlay, settingsOverlay, queueOverlay].find((o) => o && !o.hidden) || null;
  }

  // Dismiss a bottom-sheet overlay by swiping its panel down (when scrolled to top).
  function enableSheetDismiss(overlay) {
    const panel = overlay.querySelector(".stats-panel");
    if (!panel) return;
    const closeBtn = panel.querySelector(".sheet-close");
    if (closeBtn) closeBtn.addEventListener("click", () => closeSheet(overlay));
    // BUG-32: an always-reachable sticky grab handle — swipe it down OR tap it to close, from
    // anywhere in the sheet (the ✕/header scroll out of view once you scroll the body).
    if (!panel.querySelector(".sheet-grip")) {
      const grip = document.createElement("div");
      grip.className = "sheet-grip";
      grip.setAttribute("role", "button");
      grip.setAttribute("aria-label", "Close (drag down or tap)");
      grip.addEventListener("click", () => closeSheet(overlay));
      panel.insertBefore(grip, panel.firstChild);
    }
    let startY = 0, dy = 0, dragging = false;
    panel.addEventListener("touchstart", (e) => {
      // Swipe-down to dismiss works from the sticky grip (always reachable) or the header.
      // Never start a dismiss-drag on the scrollable list/rows.
      if (!e.target.closest(".q-head, .stats-header, .sheet-grip")) { dragging = false; return; }
      startY = e.touches[0].clientY; dy = 0; dragging = true;
    }, { passive: true });
    panel.addEventListener("touchmove", (e) => {
      if (!dragging) return;
      dy = e.touches[0].clientY - startY;
      if (dy > 0) { panel.style.transition = "none"; panel.style.transform = `translateY(${dy}px)`; }
    }, { passive: true });
    panel.addEventListener("touchend", () => {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = "";
      panel.style.transform = "";
      if (dy > 90) closeSheet(overlay);
    }, { passive: true });
    // iOS fires touchcancel (not touchend) when the system takes over the touch
    // (notification pull-down, app switch, palm). Without this the sheet stays stuck
    // mid-drag: translated down with transition:none and never snapping back.
    panel.addEventListener("touchcancel", () => {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = "";
      panel.style.transform = "";
    }, { passive: true });
  }

  // --- Speed control ---
  const DEFAULT_SPEED_IDX = 3; // 1.0x

  function getCurrentSpeedIdx() { return parseInt(speedSlider.value, 10); }
  function getCurrentSpeed() { return SPEED_OPTIONS[getCurrentSpeedIdx()]; }

  // Display helpers — the speed is editable either as a playback multiplier ("×")
  // or as syllables/second, chosen in Settings (default: ×).
  function speedUnitMode() { return localStorage.getItem(SPEED_UNIT_KEY) === "sps" ? "sps" : "mult"; }
  function speedUnitLabel() { return speedUnitMode() === "sps" ? "syl/s" : "×"; }
  function speedNum(mult) {
    if (speedUnitMode() === "sps") {
      const v = BASE_SPS * mult;
      return v >= 10 ? Math.round(v).toString() : v.toFixed(1);
    }
    return (Math.round(mult * 100) / 100).toString(); // multiplier, e.g. 1.5
  }
  function fmtSpeed(mult) { return speedNum(mult) + (speedUnitMode() === "sps" ? " syl/s" : "×"); }

  function setSpeed(index) {
    const i = Math.max(0, Math.min(SPEED_OPTIONS.length - 1, index));
    speedSlider.value = i;
    const s = SPEED_OPTIONS[i];
    speedInput.value = speedNum(s);
    if (speedUnitEl) speedUnitEl.textContent = speedUnitLabel();
    if (speedPickerBtn) speedPickerBtn.textContent = fmtSpeed(s);
    audio.playbackRate = bgPauseMode() ? 1 : s; // bg-pause mode plays at 1× (WebAudio can't do high rate)
    localStorage.setItem(SPEED_KEY, i);
    if (audio.duration) {
      timeTotal.textContent = fmtTime(audio.duration / s);
      updateTimeDisplay();
    }
  }

  function applySpeedInput() {
    const val = parseFloat(speedInput.value.replace(/[^0-9.]/g, ""));
    if (isNaN(val)) { speedInput.value = speedNum(getCurrentSpeed()); return; }
    // In × mode the typed value IS the multiplier; in syl/s mode convert it.
    const raw = speedUnitMode() === "sps" ? val / BASE_SPS : val;
    const mult = Math.max(0.25, Math.min(16, raw));
    const idx = SPEED_OPTIONS.reduce((best, s, i) =>
      Math.abs(s - mult) < Math.abs(SPEED_OPTIONS[best] - mult) ? i : best, 0);
    setSpeed(idx);
  }

  function initSpeed() {
    const stored = parseInt(localStorage.getItem(SPEED_KEY), 10);
    setSpeed(isNaN(stored) ? DEFAULT_SPEED_IDX : stored);
  }

  speedSlider.addEventListener("input", () => setSpeed(getCurrentSpeedIdx()));
  btnSpeedDown.addEventListener("click", () => setSpeed(getCurrentSpeedIdx() - 1));
  btnSpeedUp.addEventListener("click", () => setSpeed(getCurrentSpeedIdx() + 1));
  speedInput.addEventListener("focus", () => speedInput.select());
  speedInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { applySpeedInput(); speedInput.blur(); }
    if (e.key === "Escape") { speedInput.value = speedNum(getCurrentSpeed()); speedInput.blur(); }
    if (e.key === "ArrowUp") { e.preventDefault(); setSpeed(getCurrentSpeedIdx() + 1); }
    if (e.key === "ArrowDown") { e.preventDefault(); setSpeed(getCurrentSpeedIdx() - 1); }
  });
  speedInput.addEventListener("blur", applySpeedInput);

  // --- Simple speed picker (opt-in, "screen-off / low-speed" mode) ---
  // When enabled in Settings, the wide slider is replaced by a tap-to-open menu of
  // common speeds. Each preset maps to the nearest SPEED_OPTIONS index (all exact here).
  const SIMPLE_SPEED_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const speedControlEl = document.querySelector(".speed-control");
  const speedPickerEl = document.getElementById("speed-picker");
  const speedPickerBtn = document.getElementById("speed-picker-btn");
  const speedPickerMenu = document.getElementById("speed-picker-menu");
  const simpleSpeedToggle = document.getElementById("simple-speed");
  // Default ON (screen-off/native mode) — a one-time migration below opts existing
  // high-speed users out so they aren't suddenly capped.
  function simpleSpeedMode() { return localStorage.getItem(SIMPLE_SPEED_KEY) !== "0"; }
  function speedIdxFor(mult) {
    return SPEED_OPTIONS.reduce((best, s, i) =>
      Math.abs(s - mult) < Math.abs(SPEED_OPTIONS[best] - mult) ? i : best, 0);
  }
  function buildSpeedPickerMenu() {
    if (!speedPickerMenu) return;
    speedPickerMenu.innerHTML = "";
    const cur = getCurrentSpeed();
    SIMPLE_SPEED_PRESETS.forEach((mult) => {
      const opt = document.createElement("button");
      opt.className = "speed-picker-opt";
      opt.setAttribute("role", "option");
      opt.textContent = fmtSpeed(mult);
      if (Math.abs(mult - cur) < 0.01) { opt.classList.add("sel"); opt.setAttribute("aria-selected", "true"); }
      opt.addEventListener("click", () => { setSpeed(speedIdxFor(mult)); closeSpeedPicker(); });
      speedPickerMenu.appendChild(opt);
    });
  }
  function openSpeedPicker() {
    if (!speedPickerMenu) return;
    buildSpeedPickerMenu();
    setHidden(speedPickerMenu, false);
    if (speedPickerBtn) speedPickerBtn.setAttribute("aria-expanded", "true");
  }
  function closeSpeedPicker() {
    if (!speedPickerMenu) return;
    setHidden(speedPickerMenu, true);
    if (speedPickerBtn) speedPickerBtn.setAttribute("aria-expanded", "false");
  }
  function applySpeedUI() {
    const simple = simpleSpeedMode();
    if (speedControlEl) setHidden(speedControlEl, simple);
    if (speedPickerEl) setHidden(speedPickerEl, !simple);
    if (!simple) closeSpeedPicker();
    // Simple mode caps at the picker's top preset (2×) — clamp down if we were faster,
    // so we never hand a >4× rate to the native backend (which browsers mute).
    if (simple) {
      const cap = SIMPLE_SPEED_PRESETS[SIMPLE_SPEED_PRESETS.length - 1];
      if (getCurrentSpeed() > cap) setSpeed(speedIdxFor(cap));
    }
    setSpeed(getCurrentSpeedIdx()); // refresh both the input and the picker-button label
  }

  // --- Engine ↔ mode coupling ---
  // Simple/screen-off mode MUST use the native <audio> backend: it's the only one that
  // plays with the screen off / app backgrounded (the Web Audio engine's AudioContext
  // is suspended in the background by iOS and can't be resumed there — an OS limit).
  // High-speed mode uses the Web Audio engine so it stays audible past ~4× (where
  // browsers mute native playbackRate). So: effective engine = high-speed mode AND the
  // user wants it AND the device supports it.
  function wantsHsEngine() { return localStorage.getItem(HS_ENGINE_KEY) !== "0"; }
  // The old WSOLA engine was retired on 2026-07-08 for clarity (BUG-28); speechwarp replaces
  // it as the high-speed default. Screen-off mode stays native — it's the only backend that
  // plays in the background.
  function effectiveEngine() {
    return !simpleSpeedMode() && wantsHsEngine() && !!audio.engineAvailable;
  }
  function syncEngine(reload) {
    if (!audio.setEngineEnabled) return;
    const target = effectiveEngine();
    if (audio.engineEnabled === target) return;
    audio.setEngineEnabled(target);
    // The backend switch only takes effect on the next load(); reload in place, resuming
    // position and keeping play state, so it feels immediate.
    if (reload && currentEpisode) {
      const playing = !audio.paused;
      persistProgress();
      loadEpisode(currentEpisode, { autoplay: playing });
    }
  }
  if (speedPickerBtn) speedPickerBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    speedPickerMenu && speedPickerMenu.hidden ? openSpeedPicker() : closeSpeedPicker();
  });
  document.addEventListener("click", (e) => {
    if (speedPickerMenu && !speedPickerMenu.hidden && !e.target.closest("#speed-picker")) closeSpeedPicker();
  });

  initSpeed();
  // One-time migration: screen-off mode is the default, but existing high-speed users
  // (a saved speed above the 2× cap) keep high-speed mode so we don't silently slow them
  // down. Must run before applySpeedUI()/syncEngine() read it.
  if (localStorage.getItem(SIMPLE_SPEED_KEY) === null) {
    const storedIdx = parseInt(localStorage.getItem(SPEED_KEY), 10);
    const storedSpeed = isNaN(storedIdx) ? 1 : (SPEED_OPTIONS[storedIdx] || 1);
    if (storedSpeed > 2) {
      try { localStorage.setItem(SIMPLE_SPEED_KEY, "0"); } catch (e) {}
    }
  }
  applySpeedUI();
  syncEngine(false);

  // --- Theme ---
  const HLJS_THEMES = {
    dark:  "vendor/github-dark-dimmed.min.css",
    light: "vendor/github.min.css",
  };

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    setHidden(btnTheme.querySelector(".icon-sun"), theme === "light");
    setHidden(btnTheme.querySelector(".icon-moon"), theme !== "light");
    themeColorMeta.content = theme === "light" ? "#ffffff" : "#121212";
    document.getElementById("hljs-theme").href = HLJS_THEMES[theme] || HLJS_THEMES.dark;
    episodeContentEl.querySelectorAll("pre code").forEach((el) => {
      el.removeAttribute("data-highlighted");
      if (window.hljs) hljs.highlightElement(el);
    });
  }

  function initTheme() {
    const stored = localStorage.getItem(THEME_KEY);
    const theme = stored || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    applyTheme(theme);
  }

  btnTheme.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
  initTheme();

  // --- Progress storage ---
  function loadProgress() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {}; }
    catch { return {}; }
  }
  function getEpisodeProgress(id) {
    return loadProgress()[id] || { progressPct: 0, lastVoice: null, completed: false };
  }
  function saveEpisodeProgress(id, patch) {
    const all = loadProgress();
    all[id] = { ...all[id], ...patch };
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(all));
    window.Sync && window.Sync.scheduleSync();
  }

  // --- Utils ---
  function fmtTime(secs) {
    if (!secs || isNaN(secs)) return "0:00";
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  function fmtDuration(secs) {
    if (!secs || isNaN(secs) || secs <= 0) return "";
    if (secs < 60) return "<1m";
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return h ? h + "h " + m + "m" : m + "m";
  }

  function cleanVoiceName(name) {
    const parts = name.split("_").slice(1).filter(Boolean);
    return parts.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || name;
  }

  // Shared play-triangle icon (same path as the player-bar button) so every
  // circular play button renders an identical, centered SVG instead of glyph
  // or CSS-border hacks.
  const playIcon = (s = 16) =>
    `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
  const downloadIcon = (s = 15) =>
    `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor"><path d="M12 16l-5-5 1.4-1.4L11 12.2V4h2v8.2l2.6-2.6L17 11z"/><path d="M5 18h14v2H5z"/></svg>`;
  const checkIcon = (s = 15) =>
    `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>`;
  const pauseIcon = (s = 16) =>
    `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>`;
  // Three horizontal lines = "drag to reorder" (a ⋮ reads as a click-menu instead).
  const handleIcon = (s = 20) =>
    `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="currentColor"><rect x="4" y="7" width="16" height="2" rx="1"/><rect x="4" y="11" width="16" height="2" rx="1"/><rect x="4" y="15" width="16" height="2" rx="1"/></svg>`;
  const eqIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><rect x="3" y="10" width="3" height="4" rx="1.5"/><rect x="8" y="7" width="3" height="10" rx="1.5"/><rect x="13" y="4" width="3" height="16" rx="1.5"/><rect x="18" y="9" width="3" height="6" rx="1.5"/></svg>`;
  const trashIcon = `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M6 7h12l-1 13a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 7zm3-3h6l1 2h4v2H4V6h4l1-2z"/></svg>`;
  let queueSortable = null;

  function updateProgressFill(pct) {
    progressBarEl.style.setProperty("--pct", pct * 100 + "%");
  }

  // --- Sleep timer ---
  const SLEEP_MINUTES = [null, 15, 30, 45, 60];

  function updateSleepBtn() {
    const mins = SLEEP_MINUTES[sleepIdx];
    if (mins) {
      btnSleep.textContent = mins + "m";
      btnSleep.classList.add("sleep-active");
    } else {
      btnSleep.innerHTML = `<svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor"><path d="M21 10.78V8c0-1.65-1.35-3-3-3h-4c-.77 0-1.47.3-2 .78-.53-.48-1.23-.78-2-.78H6C4.35 5 3 6.35 3 8v2.78c-.61.55-1 1.34-1 2.22v6h2v-2h16v2h2v-6c0-.88-.39-1.67-1-2.22z"/></svg>`;
      btnSleep.classList.remove("sleep-active");
    }
  }

  btnSleep.addEventListener("click", () => {
    clearTimeout(sleepTimeout);
    sleepIdx = (sleepIdx + 1) % SLEEP_MINUTES.length;
    const mins = SLEEP_MINUTES[sleepIdx];
    if (mins) {
      sleepTimeout = setTimeout(() => {
        audio.pause();
        sleepIdx = 0;
        updateSleepBtn();
      }, mins * 60 * 1000);
    }
    updateSleepBtn();
  });

  // --- Time display (speed-adjusted) ---
  function updateTimeDisplay() {
    if (!audio.duration) return;
    const rate = audio.playbackRate || 1;
    if (showRemaining) {
      timeCurrent.textContent = "-" + fmtTime((audio.duration - audio.currentTime) / rate);
    } else {
      timeCurrent.textContent = fmtTime(audio.currentTime / rate);
    }
    timeTotal.textContent = fmtTime(audio.duration / rate);
  }

  playerTimeEl.addEventListener("click", () => {
    showRemaining = !showRemaining;
    updateTimeDisplay();
  });

  // --- Keyboard shortcuts ---
  document.addEventListener("keydown", (e) => {
    const tag = document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (!currentEpisode) return;
    if (e.key === " ") { e.preventDefault(); audio.paused ? audio.play() : audio.pause(); }
    if (e.key === "ArrowLeft") { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - 30); }
    if (e.key === "ArrowRight") { e.preventDefault(); audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 30); }
  });

  // --- Swipe right to go back ---
  viewEpisode.addEventListener("touchstart", (e) => {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
  }, { passive: true });
  viewEpisode.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = Math.abs(e.changedTouches[0].clientY - swipeStartY);
    if (dx > 60 && dy < 60 && swipeStartX < 60) navigateToLibrary();
  }, { passive: true });

  // --- Queue ---
  function updateQueueBadge() {
    if (queue.length > 0) {
      queueBadge.textContent = queue.length;
      setHidden(btnQueue, false);
    } else {
      setHidden(btnQueue, true);
    }
  }

  // How many started flashcards (total>0) are due right now. Reads localStorage only
  // (no quiz fetch), so it's cheap to call often. Drives both the top-bar badge and
  // the home-screen "daily quiz" box.
  // Count flashcards due right now. Pass a subjectId to count only that subject's cards
  // (SR keys are "<subject>:<epId>::<qId>", so a prefix match scopes them).
  function reviewsDueCount(subjectId) {
    let due = 0;
    const sr = loadSR();
    const now = Date.now();
    const prefix = subjectId ? subjectId + ":" : null;
    for (const k in sr) {
      if (prefix && !k.startsWith(prefix)) continue;
      const c = sr[k];
      if (c && c.total && c.due && new Date(c.due).getTime() <= now) due++;
    }
    return due;
  }

  // Badge the Review button with how many flashcards are due right now, so the study
  // loop is visible from the top bar.
  function updateReviewBadge() {
    if (!btnReview) return;
    let badge = btnReview.querySelector(".queue-badge");
    const due = reviewsDueCount();
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "queue-badge";
      btnReview.appendChild(badge);
    }
    badge.textContent = due > 99 ? "99+" : String(due);
    setHidden(badge, due === 0);
  }

  // Sync the library's +/✓ queue buttons to the current queue, in place (no
  // re-render, so an open module stays open).
  function syncQueueButtons() {
    viewLibrary.querySelectorAll(".episode-row").forEach((row) => {
      const b = row.querySelector(".ep-queue-btn");
      if (!b) return;
      const inQ = queue.includes(row.dataset.epId);
      b.classList.toggle("in-queue", inQ);
      b.textContent = inQ ? "✓" : "+";
      b.setAttribute("aria-label", inQ ? "Remove from queue" : "Add to queue");
    });
  }

  // The queue button opens the "Up Next" panel (it no longer wipes the queue).
  btnQueue.addEventListener("click", () => { renderQueuePanel(); openSheet(queueOverlay); });
  queueOverlay.addEventListener("click", (e) => { if (e.target === queueOverlay) closeSheet(queueOverlay); });
  enableSheetDismiss(queueOverlay);
  if (btnQueueClear) btnQueueClear.addEventListener("click", () => {
    queue = [];
    updateQueueBadge();
    syncQueueButtons();
    renderQueuePanel();
  });

  // A deterministic, on-brand colored art tile (no real per-episode artwork).
  function episodeModuleName(id) {
    if (!manifest) return "";
    for (const mod of manifest.modules) {
      if (mod.episodes.some((e) => e.id === id)) return GROUP_NAMES[mod.prefix] || mod.prefix;
    }
    return "";
  }
  function refreshNowRow() {
    const btn = queueListEl && queueListEl.querySelector(".q-now-row .q-pp");
    if (btn) btn.innerHTML = audio.paused ? playIcon(16) : pauseIcon(16);
  }

  function queueRowHTML(id, kind, num) {
    const ep = kind === "now" ? currentEpisode : findEpisode(id);
    const title = ep ? ep.title : id;
    const sub = ep ? episodeModuleName(ep.id) : "";
    const lead = kind === "now"
      ? `<span class="q-num q-num-now">${eqIcon}</span>`
      : `<span class="q-num">${num}</span>`;
    const ctrl = kind === "now"
      ? `<button class="q-pp" aria-label="Play or pause">${audio.paused ? playIcon(16) : pauseIcon(16)}</button>`
      : `<button class="q-del" aria-label="Remove from queue" title="Remove">&#10005;</button>
         <span class="q-handle" aria-label="Drag to reorder" title="Drag to reorder">${handleIcon(20)}</span>`;
    const swipeBg = kind === "now" ? "" : `<div class="q-swipe-bg">${trashIcon}</div>`;
    return `<div class="${kind === "now" ? "q-now-row" : "q-row"}" data-ep-id="${ep ? ep.id : id}">
      ${swipeBg}
      <div class="q-fg">
        ${lead}
        <span class="q-text"><span class="q-title">${title}</span><span class="q-sub">${sub}</span></span>
        ${ctrl}
      </div>
    </div>`;
  }

  function renderQueuePanel() {
    if (!queueListEl) return;
    if (qNowTitleEl) qNowTitleEl.textContent = currentEpisode ? currentEpisode.title : "nothing";

    let html = currentEpisode ? queueRowHTML(currentEpisode.id, "now") : "";
    html += queue.map((id, i) => queueRowHTML(id, "queued", i + 1)).join("");
    if (!queue.length) {
      html += `<p class="setting-hint">Nothing queued. Add episodes with the + button, or Start a module.</p>`;
    }
    queueListEl.innerHTML = html;
    if (btnQueueClear) setHidden(btnQueueClear, !queue.length);

    const nowRow = queueListEl.querySelector(".q-now-row");
    if (nowRow) nowRow.querySelector(".q-pp").addEventListener("click", (e) => {
      e.stopPropagation();
      audio.paused ? audio.play() : audio.pause();
    });
    attachQueueGestures();

    // Drag-to-reorder via SortableJS (smooth, animates neighbours, touch + mouse).
    if (window.Sortable) {
      if (queueSortable) { try { queueSortable.destroy(); } catch (_) {} }
      queueSortable = window.Sortable.create(queueListEl, {
        handle: ".q-handle",
        draggable: ".q-row",
        animation: 160,
        ghostClass: "q-ghost",
        chosenClass: "q-chosen",
        // iOS has no native HTML5 drag; force the JS fallback and append the moving
        // clone to <body> so a transformed ancestor (the sheet) can't offset it.
        forceFallback: true,
        fallbackOnBody: true,
        fallbackTolerance: 4,
        onEnd: () => {
          queue = [...queueListEl.querySelectorAll(".q-row")].map((r) => r.dataset.epId);
          queueListEl.querySelectorAll(".q-row .q-num").forEach((el, i) => { el.textContent = i + 1; });
          updateQueueBadge();
          syncQueueButtons();
        },
      });
    }
  }

  // Tap a row to play; swipe left to remove (reorder is handled by SortableJS).
  function attachQueueGestures() {
    queueListEl.querySelectorAll(".q-row").forEach((row) => {
      const fg = row.querySelector(".q-fg");
      const handle = row.querySelector(".q-handle");
      const del = row.querySelector(".q-del");
      const id = row.dataset.epId;
      let sx = 0, sy = 0, dx = 0, swiping = false, active = false;

      // explicit remove button (works with a mouse on desktop)
      if (del) del.addEventListener("click", (e) => { e.stopPropagation(); animateRemove(row, id); });

      // tap-to-play + swipe-left-to-remove (anywhere on the row except the handle / ✕)
      fg.addEventListener("pointerdown", (e) => {
        if (handle.contains(e.target) || (del && del.contains(e.target))) return;
        active = true; swiping = false; dx = 0; sx = e.clientX; sy = e.clientY;
        try { fg.setPointerCapture(e.pointerId); } catch (_) {}
      });
      fg.addEventListener("pointermove", (e) => {
        if (!active) return;
        const mx = e.clientX - sx, my = e.clientY - sy;
        if (!swiping && Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) swiping = true;
        if (swiping) {
          dx = Math.min(0, mx);
          fg.style.transition = "none";
          fg.style.transform = `translateX(${dx}px)`;   // slides left, revealing the red
          row.classList.toggle("q-will-remove", dx < -90);
        }
      });
      fg.addEventListener("pointerup", (e) => {
        if (!active) return;
        active = false;
        if (swiping) {
          if (dx < -90) { animateRemove(row, id); return; }
          fg.style.transition = "transform .18s ease";
          fg.style.transform = "";
          row.classList.remove("q-will-remove");
        } else if (Math.abs((e.clientX || sx) - sx) < 8) {
          playFromQueue(id);
        }
      });
      fg.addEventListener("pointercancel", () => {
        active = false;
        fg.style.transition = "transform .18s ease";
        fg.style.transform = "";
        row.classList.remove("q-will-remove");
      });
    });
  }
  // Collapse the row to height 0 so the rows below glide up, then drop it.
  function animateRemove(row, id) {
    if (row.dataset.removing) return;
    row.dataset.removing = "1";
    const h = row.offsetHeight;
    row.style.overflow = "hidden";
    const done = () => removeFromQueue(id);
    if (row.animate) {
      const anim = row.animate(
        [{ height: h + "px", opacity: 1 }, { height: "0px", opacity: 0 }],
        { duration: 200, easing: "ease-in-out" }
      );
      anim.onfinish = done;
      anim.oncancel = done;
    } else {
      done();
    }
  }
  function removeFromQueue(id) {
    const i = queue.indexOf(id);
    if (i >= 0) queue.splice(i, 1);
    updateQueueBadge();
    syncQueueButtons();
    renderQueuePanel();
  }
  function playFromQueue(id) {
    const ep = findEpisode(id);
    if (!ep || !guardPlayable(ep)) return;
    const i = queue.indexOf(id);
    if (i >= 0) queue.splice(i, 1);
    updateQueueBadge();
    syncQueueButtons();
    closeSheet(queueOverlay);
    loadEpisode(ep, { autoplay: true });
    navigateToEpisode(ep.id);
  }

  // --- Auto-advance ---
  function dismissAdvanceToast() {
    clearInterval(advanceTimer);
    advanceTimer = null;
    setHidden(advanceToast, true);
  }

  function showAdvanceToast(nextEp) {
    // Cancel any countdown already running before starting a new one. Without this, a second
    // `ended` (e.g. fast-forwarding to the end while a toast is already up) overwrites
    // `advanceTimer` and orphans the previous interval — which can never be cleared, so once
    // its countdown passes 0 it re-fires loadEpisode(autoplay) every second forever (the
    // ~1 Hz loop that overrides pause and keeps reloading the episode).
    dismissAdvanceToast();
    advanceTitleEl.textContent = nextEp.title;
    let countdown = 3;
    advanceCountdownEl.textContent = countdown;
    setHidden(advanceToast, false);
    advanceTimer = setInterval(() => {
      countdown--;
      if (countdown > 0) { advanceCountdownEl.textContent = countdown; return; }
      dismissAdvanceToast(); // clears advanceTimer + hides the toast before we load
      loadEpisode(nextEp, { autoplay: true, fromStart: true });
      navigateToEpisode(nextEp.id);
    }, 1000);
  }

  btnAdvanceCancel.addEventListener("click", dismissAdvanceToast);

  function getNextEpisode(ep) {
    const flat = [];
    const groups = new Map();
    manifest.modules.forEach((mod) => {
      if (!groups.has(mod.prefix)) groups.set(mod.prefix, []);
      mod.episodes.forEach((e) => groups.get(mod.prefix).push({ ...e, _moduleNum: mod.moduleNum }));
    });
    groups.forEach((episodes) => {
      episodes.sort((a, b) => (a._moduleNum - b._moduleNum) || ((a.unit || 0) - (b.unit || 0)));
      episodes.forEach((e) => flat.push(e));
    });
    const idx = flat.findIndex((e) => e.id === ep.id);
    if (idx < 0) return null;
    // Land on the next *due* episode: skip ones with no audio yet, and ones already
    // completed, so auto-advance / "next" moves on to the next unfinished episode instead
    // of replaying something that's already done. If everything ahead is finished, stop.
    for (let i = idx + 1; i < flat.length; i++) {
      const e = flat[i];
      if (!e.voices || !e.voices.length) continue;
      if (getEpisodeProgress(e.id).completed) continue;
      return e;
    }
    return null;
  }

  // --- Lock-screen / OS media controls (Media Session API) ---
  function episodeSubtitle(ep) {
    if (!manifest) return "";
    for (const mod of manifest.modules) {
      if (mod.episodes.some((e) => e.id === ep.id)) return GROUP_NAMES[mod.prefix] || mod.prefix;
    }
    return "";
  }
  function updateMediaSession() {
    if (!("mediaSession" in navigator) || !currentEpisode) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: currentEpisode.title,
        artist: episodeSubtitle(currentEpisode),
        album: (document.querySelector(".brand") || {}).textContent || "Podcast",
        artwork: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      });
    } catch (e) { /* MediaMetadata unsupported */ }
  }
  // BUG-36 (attempt 6d): background-resume via a local seek nudge. Ground truth (docs/audio-background-
  // resume.md §8) showed *resuming a paused* element in the background is a phantom (iOS deactivated its
  // session → frozen + silent). Runs ONLY when document.hidden, so normal foreground playback and the
  // native high-speed path are completely untouched (no WebAudio, unlike attempt 5).
  // NO reload in the background. The load()-based re-init (attempts 6/6b/6c) is dead: iOS suspends the
  // network for a backgrounded PWA, so the reload STALLS (log: evt:stalled, ready stuck at 1) and never
  // completes until you unlock — and worse it resets the element to t=0/rate=1, which the never-firing
  // canplay never restored, corrupting position + speed. The remaining, purely-local lever: when the
  // buffer is still present (the usual pause→resume case) nudge currentTime to force the decoder to
  // re-establish its output, preserving position AND rate. Can't stall, can't corrupt state.
  function backgroundResumeKick() {
    const rate = getCurrentSpeed();
    const pos = audio.currentTime || 0;
    alog("bg:seek-kick", "pos=" + pos.toFixed(1) + " rs=" + audio.readyState);
    try { if (audio.readyState >= 2 && pos > 0.3) audio.currentTime = pos - 0.25; } catch (e) {}
    audio.playbackRate = rate;
    audio.play().then(() => { audio.playbackRate = rate; alog("bg:play resolved"); }).catch((e) => alog("bg:play REJECTED", "reason=" + (e && e.name)));
  }

  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch (e) {} };
    set("play", () => {
      alog("MS:play handler");
      resumeAudioGraph(); // no-op unless bg-pause mode; reconnects the WebAudio session on the lock-screen gesture
      if (bgPauseMode()) { audio.play().then(() => alog("MS:play resolved")).catch((e) => alog("MS:play REJECTED", "reason=" + (e && e.name))); return; }
      if (document.hidden) backgroundResumeKick();
      else audio.play().then(() => alog("MS:play resolved")).catch((e) => alog("MS:play REJECTED", "reason=" + (e && e.name)));
    });
    set("pause", () => { alog("MS:pause handler"); audio.pause(); });
    set("seekbackward", (d) => { audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 30)); });
    set("seekforward", (d) => { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + ((d && d.seekOffset) || 30)); });
    set("seekto", (d) => { if (d && d.seekTime != null && audio.duration) audio.currentTime = d.seekTime; });
    set("nexttrack", () => { const n = getNextEpisode(currentEpisode); if (n) { loadEpisode(n, { autoplay: true, fromStart: true }); navigateToEpisode(n.id); } });
  }
  setupMediaSession();

  // FEATURE-9: flush progress + push a sync when the app is hidden/backgrounded (session end),
  // so it lands on the server even if the 4s sync debounce hasn't fired. Progress itself is saved
  // to localStorage first, so it survives even offline.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "hidden") return;
    flushListenLog();
    persistProgress();
    if (window.Sync && window.Sync.syncNow) window.Sync.syncNow().catch(() => {});
  });

  // --- Audio events ---
  // stopTitleIntro first: if the user starts playback while the spoken title intro is
  // still pending/playing, the intro is cancelled instead of talking over the episode.
  // (The intro's own done() → play() lands here too, but by then it has already
  // cleared its cancel handle, so this is a no-op on the normal intro path.)
  audio.addEventListener("play", () => { stopTitleIntro(); setPlayState(true); lastListenTick = Date.now(); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing"; track("play", { ep: currentEpisode && currentEpisode.id, speed: getCurrentSpeed() }); });
  audio.addEventListener("pause", () => { setPlayState(false); flushListenLog(); lastListenTick = 0; persistProgress(); if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused"; });
  audio.addEventListener("ended", () => {
    flushListenLog(); // credit time to the finished episode's voice before advancing
    if (currentEpisode) saveEpisodeProgress(currentEpisode.id, { progressPct: 1, completed: true });
    setPlayState(false);
    // Runaway guard: real episodes are minutes long, so two `ended` events within a couple
    // of seconds mean something is cascading (an episode ending the instant it loads). Stop
    // auto-advancing rather than loop forever — the user can still advance manually.
    const now = Date.now();
    if (now - lastAutoAdvanceAt < 2000) { lastAutoAdvanceAt = now; return; }
    lastAutoAdvanceAt = now;
    if (queue.length > 0) {
      const nextId = queue.shift();
      updateQueueBadge();
      if (!viewLibrary.hidden) renderLibrary();
      const nextEp = findEpisode(nextId);
      if (nextEp) { loadEpisode(nextEp, { autoplay: true, fromStart: true }); navigateToEpisode(nextEp.id); }
      return;
    }
    const nextEp = getNextEpisode(currentEpisode);
    // Nothing to advance to: pause so the hybrid engine's silent media-session anchor
    // stops looping (otherwise it keeps the lock-screen "playing" after the last episode).
    // Harmless for the native backend (already ended). Auto-advance goes through the
    // nextEp path below, which keeps the anchor running for the next episode.
    if (!nextEp) { audio.pause(); return; }
    // Screen off / app backgrounded: skip the countdown toast and advance immediately,
    // while the audio session is still warm (gives the next track the best chance of
    // starting in the background on iOS). Foreground keeps the nice "Up next" countdown.
    if (document.hidden) { loadEpisode(nextEp, { autoplay: true, fromStart: true }); navigateToEpisode(nextEp.id); }
    else showAdvanceToast(nextEp);
  });
  audio.addEventListener("loadedmetadata", () => {
    timeTotal.textContent = fmtTime(audio.duration / (getCurrentSpeed() || 1));
  });
  audio.addEventListener("timeupdate", () => {
    if (!audio.duration || isSeeking) return;
    const pct = audio.currentTime / audio.duration;
    progressBarEl.value = pct;
    updateProgressFill(pct);
    updateTimeDisplay();
    updateTranscriptHighlight();
    if ("mediaSession" in navigator && navigator.mediaSession.setPositionState && isFinite(audio.duration)) {
      try { navigator.mediaSession.setPositionState({ duration: audio.duration, position: Math.min(audio.currentTime, audio.duration), playbackRate: audio.playbackRate || 1 }); } catch (e) {}
    }
    const now = Date.now();
    // Accumulate real time spent listening into today's bucket (ignore the big
    // jump after a pause/seek via the <2s cap).
    if (!audio.paused && lastListenTick) {
      const dt = (now - lastListenTick) / 1000;
      if (dt > 0 && dt < 2) {
        pendingListenSecs += dt;
        pendingContentSecs += dt * (audio.playbackRate || 1); // content actually played
      }
    }
    lastListenTick = now;
    if (now - lastSavedAt > 5000) { lastSavedAt = now; flushListenLog(); persistProgress(); }
  });

  function setPlayState(playing) {
    setHidden(btnPlay.querySelector(".icon-play"), playing);
    setHidden(btnPlay.querySelector(".icon-pause"), !playing);
    if (btnPlayMini) {
      setHidden(btnPlayMini.querySelector(".icon-play"), playing);
      setHidden(btnPlayMini.querySelector(".icon-pause"), !playing);
    }
    if (queueOverlay && !queueOverlay.hidden) refreshNowRow();
  }

  // --- Minimise / expand the now-playing bar (frees up screen space) ---
  const btnPlayerMin = document.getElementById("btn-player-min");
  const btnPlayMini = document.getElementById("btn-play-mini");
  function applyPlayerMin(min) {
    playerBar.classList.toggle("min", min);
    if (btnPlayerMin) {
      btnPlayerMin.setAttribute("aria-pressed", min ? "true" : "false");
      btnPlayerMin.setAttribute("aria-label", min ? "Expand player" : "Minimise player");
      setHidden(btnPlayerMin.querySelector(".icon-min"), min);
      setHidden(btnPlayerMin.querySelector(".icon-max"), !min);
    }
  }
  function setPlayerMin(min) {
    localStorage.setItem(PLAYER_MIN_KEY, min ? "1" : "0");
    applyPlayerMin(min);
  }
  applyPlayerMin(localStorage.getItem(PLAYER_MIN_KEY) === "1");
  if (btnPlayerMin) btnPlayerMin.addEventListener("click", (e) => {
    e.stopPropagation();
    setPlayerMin(!playerBar.classList.contains("min"));
  });
  // Tapping the title area while minimised expands it again.
  const playerNowEl = document.querySelector(".player-now");
  if (playerNowEl) playerNowEl.addEventListener("click", (e) => {
    if (!playerBar.classList.contains("min")) return;
    if (e.target.closest("#btn-play-mini, #btn-player-min")) return;
    setPlayerMin(false);
  });

  // --- Controls ---
  const togglePlay = () => {
    if (!currentEpisode) return;
    if (audio.paused) { alog("btn:play"); resumeAudioGraph(); audio.play().then(() => alog("btn:play resolved")).catch((e) => alog("btn:play REJECTED", "reason=" + (e && e.name))); }
    else { alog("btn:pause"); audio.pause(); }
  };
  btnPlay.addEventListener("click", togglePlay);
  if (btnPlayMini) btnPlayMini.addEventListener("click", (e) => { e.stopPropagation(); togglePlay(); });
  btnRewind.addEventListener("click", () => {
    audio.currentTime = Math.max(0, audio.currentTime - 30);
  });
  btnForward.addEventListener("click", () => {
    audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 30);
  });

  progressBarEl.addEventListener("mousedown", () => { isSeeking = true; });
  progressBarEl.addEventListener("touchstart", () => { isSeeking = true; }, { passive: true });
  progressBarEl.addEventListener("input", () => {
    const pct = parseFloat(progressBarEl.value);
    updateProgressFill(pct);
    if (audio.duration) { audio.currentTime = pct * audio.duration; updateTimeDisplay(); }
  });
  progressBarEl.addEventListener("change", () => {
    if (audio.duration) audio.currentTime = parseFloat(progressBarEl.value) * audio.duration;
    isSeeking = false;
  });
  progressBarEl.addEventListener("mouseup", () => { isSeeking = false; });
  progressBarEl.addEventListener("touchend", () => { isSeeking = false; });

  voiceSelect.addEventListener("change", () => {
    switchVoice(parseInt(voiceSelect.value, 10));
  });

  // --- Episode loading ---
  // Episode ids are namespaced "<subject>:<id>" (globally unique), so search every subject.
  function findEpisode(id) {
    if (!fullManifest) return null;
    for (const s of fullManifest.subjects) {
      for (const mod of s.modules) {
        const ep = mod.episodes.find((e) => e.id === id);
        if (ep) return ep;
      }
    }
    return null;
  }

  // Show the current episode title (and module) in the in-app player bar, so you can
  // always tell what's playing and see it change when episodes auto-advance.
  function updatePlayerNow() {
    if (playerEpTitle) playerEpTitle.textContent = currentEpisode ? currentEpisode.title : "";
    if (playerEpSub) playerEpSub.textContent = currentEpisode ? episodeSubtitle(currentEpisode) : "";
  }

  // Grey-highlight the currently-playing episode row in the library (updated in place so
  // the highlight follows auto-advance without a full re-render).
  function updatePlayingRow() {
    viewLibrary.querySelectorAll(".episode-row").forEach((row) => {
      row.classList.toggle("ep-row-playing", !!currentEpisode && row.dataset.epId === currentEpisode.id);
    });
  }

  function loadEpisode(ep, { autoplay, fromStart }) {
    dismissAdvanceToast(); // a user-initiated load cancels any pending auto-advance
    // Kill any in-flight spoken title from the previous load. Loads that go through the
    // intro path replace it anyway; every other load (no titleAudio, intro turned off,
    // autoplay:false view, no-voices early return) would otherwise leave the old title
    // speaking over whatever plays next.
    stopTitleIntro();
    // Save the OUTGOING episode's position before we switch. Advancing (auto-advance,
    // queue, manual next, or tapping another episode) reassigns currentEpisode and
    // resets audio.src below, which zeroes currentTime — so without this the outgoing
    // episode's progress is lost. The periodic 5s save doesn't cover the last few
    // seconds, and there's no network dependency (localStorage), so this matters even
    // offline. Guards in persistProgress make it a no-op on the very first load. (BUG-19)
    persistProgress();
    flushListenLog();
    // If we're about to speak the title/quiz intro for the new episode, stop the
    // outgoing episode first so the spoken intro can't play over it. Do it here —
    // while currentEpisode and the audio position still point at the outgoing
    // episode — so it composes with the progress-save above; the async 'pause' event
    // then no-ops (setAudioSource's load() resets audio.duration to NaN before it
    // fires, and pending listen time was just flushed). (BUG-18)
    if (autoplay && introEnabled() && ep.titleAudio && !audio.paused) audio.pause();
    currentEpisode = ep;
    // No audio generated for this episode yet — show it read-only (the notes/quiz still
    // render via showView). Hide the player instead of crashing on ep.voices[…].file.
    if (!ep.voices || !ep.voices.length) {
      playerBar.hidden = true;
      setHidden(btnSleep, true);
      if (autoplay) showToast("No audio for this episode yet — notes only.");
      return;
    }
    const progress = getEpisodeProgress(ep.id);
    currentVoiceIndex = ep.voices.findIndex((v) => v.name === progress.lastVoice);
    if (currentVoiceIndex < 0) {
      const def = localStorage.getItem(DEFAULT_VOICE_KEY);
      currentVoiceIndex = def ? ep.voices.findIndex((v) => v.name === def) : -1;
      if (currentVoiceIndex < 0) currentVoiceIndex = 0;
    }

    playerBar.hidden = false;
    setHidden(btnSleep, false);
    updateSleepBtn();

    voiceSelect.innerHTML = "";
    ep.voices.forEach((v, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = cleanVoiceName(v.name);
      if (i === currentVoiceIndex) opt.selected = true;
      voiceSelect.appendChild(opt);
    });

    // Auto-advance and "next" always start the next episode from the beginning; only an
    // explicit open/continue resumes a saved position. Resuming on auto-advance let a next
    // episode that was saved near its end play a tiny tail, fire `ended`, and advance again
    // — a runaway cascade of short snippets that overrode pause (the lock-screen loop).
    const resumePct = fromStart ? 0 : (progress.progressPct || 0);
    setAudioSource(ep.voices[currentVoiceIndex], resumePct, autoplay);
    updateMediaSession(); // set lock-screen title/artist/artwork for this episode
    updatePlayerNow();    // show the title in the in-app player bar too
    updatePlayingRow();   // grey-highlight this episode in the library list
  }

  function setAudioSource(voice, resumePct, autoplay) {
    const token = ++loadToken;
    audio.src = voice.file;
    audio.load();
    // Start playback as synchronously as possible (don't wait for loadedmetadata) so that,
    // when auto-advancing in the background, iOS still treats the audio session as active.
    if (autoplay) {
      const introUrl = introEnabled() && currentEpisode && currentEpisode.titleAudio;
      if (introUrl) playTitleIntro(introUrl, () => { if (token === loadToken) audio.play().catch(() => {}); });
      else audio.play().catch(() => {});
    }
    audio.addEventListener("loadedmetadata", () => {
      if (token !== loadToken) return; // a newer load superseded this one
      // Don't resume at the very end (a completed episode has progressPct≈1) — that
      // would sit at the end and instantly auto-advance instead of replaying.
      if (resumePct && resumePct < 0.999 && audio.duration) audio.currentTime = resumePct * audio.duration;
      audio.playbackRate = bgPauseMode() ? 1 : getCurrentSpeed();
      timeTotal.textContent = fmtTime(audio.duration / getCurrentSpeed());
    }, { once: true });
  }

  // Play a short break, then speak the episode title (a small clip in the question voice),
  // then `done()` starts the episode. Falls back to starting immediately on any error so a
  // missing/failed intro never blocks playback.
  let introAudioEl = null;
  let introCancel = null;
  // BUG-18 follow-up: the intro must die the moment anything else takes over playback,
  // or the title keeps talking over the episode. Called when the main audio starts
  // playing (any play path: button, spacebar, lock screen, transcript tap — especially
  // during the intro's 1.2s silent lead-in, when a tap on Play races it) and on every
  // loadEpisode (a new load that skips the intro path would otherwise leave the old
  // title speaking over the new episode). After a cancel, done() never runs — whoever
  // cancelled is already driving playback.
  function stopTitleIntro() { if (introCancel) introCancel(); }
  function playTitleIntro(url, done) {
    try {
      // BUG-18: make sure the episode audio isn't playing over the spoken title. The intro's
      // done() callback is the only thing that (re)starts it, so pausing here can't strand it.
      try { audio.pause(); } catch {}
      stopTitleIntro();
      const intro = introAudioEl = new Audio(url);
      let settled = false; // started, errored, or cancelled — whichever comes first wins
      const finish = (after) => {
        if (settled) return;
        settled = true;
        introAudioEl = null;
        introCancel = null;
        if (after) after();
      };
      introCancel = () => finish(() => { try { intro.pause(); } catch {} });
      const go = () => finish(done);
      intro.addEventListener("ended", () => setTimeout(go, 400), { once: true }); // gap after title
      intro.addEventListener("error", go, { once: true });
      // The break before the title. The settled check keeps a cancelled intro from
      // starting to speak when this timer fires.
      setTimeout(() => { if (!settled) intro.play().catch(go); }, 1200);
    } catch { done(); }
  }

  function switchVoice(index) {
    if (!currentEpisode || index === currentVoiceIndex) return;
    flushListenLog(); // attribute time played so far to the current voice first
    const pct = audio.duration ? audio.currentTime / audio.duration : 0;
    const wasPlaying = !audio.paused;
    currentVoiceIndex = index;
    voiceSelect.value = index;
    const voice = currentEpisode.voices[index];
    const token = ++loadToken;
    audio.src = voice.file;
    audio.load();
    audio.addEventListener("loadedmetadata", () => {
      if (token !== loadToken) return; // a newer load superseded this one
      if (audio.duration) audio.currentTime = pct * audio.duration;
      audio.playbackRate = bgPauseMode() ? 1 : getCurrentSpeed();
      timeTotal.textContent = fmtTime(audio.duration / getCurrentSpeed());
      if (wasPlaying) audio.play().catch(() => {});
    }, { once: true });
    saveEpisodeProgress(currentEpisode.id, { lastVoice: voice.name });
    // Remember this voice globally so the next/fresh episode starts in it and
    // the Settings "Default voice" stays in sync.
    localStorage.setItem(DEFAULT_VOICE_KEY, voice.name);
    defaultVoiceSelect.value = voice.name;
  }

  function persistProgress() {
    if (!currentEpisode || !audio.duration) return;
    const pct = audio.currentTime / audio.duration;
    // Note: completion is NOT set from position — scrubbing to the end shouldn't
    // mark an episode done. Only the "ended" event (actually reaching the end)
    // marks it completed.
    saveEpisodeProgress(currentEpisode.id, {
      progressPct: pct,
      lastVoice: currentEpisode.voices[currentVoiceIndex].name,
      lastPlayed: new Date().toISOString(),
    });
  }

  // --- Daily listening log (wall-clock time spent, for the stats graph) ---
  function loadListenLog() {
    try { return JSON.parse(localStorage.getItem(LISTEN_LOG_KEY)) || {}; } catch { return {}; }
  }
  function loadVoiceLog() {
    try { return JSON.parse(localStorage.getItem(VOICE_LOG_KEY)) || {}; } catch { return {}; }
  }
  function flushListenLog() {
    if (pendingListenSecs <= 0 && pendingContentSecs <= 0) return;
    if (pendingListenSecs > 0) {
      const log = loadListenLog();
      const day = new Date().toISOString().substring(0, 10);
      log[day] = Math.round((log[day] || 0) + pendingListenSecs);
      localStorage.setItem(LISTEN_LOG_KEY, JSON.stringify(log));
    }
    // Attribute content actually played to the current voice (TTS model).
    if (pendingContentSecs > 0 && currentEpisode) {
      const name = currentEpisode.voices[currentVoiceIndex]?.name;
      if (name) {
        const vlog = loadVoiceLog();
        vlog[name] = Math.round((vlog[name] || 0) + pendingContentSecs);
        localStorage.setItem(VOICE_LOG_KEY, JSON.stringify(vlog));
      }
    }
    pendingListenSecs = 0;
    pendingContentSecs = 0;
    window.Sync && window.Sync.scheduleSync();
  }

  // --- Subject config — now per-subject, sourced from the manifest (manifest.subjects[]).
  // These hold the CURRENT subject's values; setSubject() repoints them when you switch
  // subjects. Module names (GROUP_NAMES), the Year 11/12 split (YEAR_MAP), section order
  // (YEAR_ORDER) and the repo link (REPO_URL) all come from that subject's subject.json.
  let REPO_URL = "";
  let GROUP_NAMES = {};
  let YEAR_MAP = {};
  let YEAR_ORDER = ["Case Studies", "Year 12", "Year 11", "Other"];

  function subjectMeta(id) {
    return (fullManifest && fullManifest.subjects.find((s) => s.id === id)) || null;
  }
  // Module name for a (subject, prefix) pair — used by the cross-subject study hub where
  // GROUP_NAMES (the current subject's) isn't enough.
  function groupNameFor(subjectId, prefix) {
    const s = subjectMeta(subjectId);
    return (s && s.groupNames && s.groupNames[prefix]) || prefix;
  }

  // Switch the app to a subject: repoint the current-subject config + the `manifest` view
  // that the library/episode/stats code reads. Returns false for an unknown id.
  function setSubject(id) {
    const s = subjectMeta(id);
    if (!s) return false;
    if (currentSubject !== id) track("subject_open", { id });
    currentSubject = id;
    manifest = { modules: s.modules };
    GROUP_NAMES = s.groupNames || {};
    YEAR_MAP = s.yearMap || {};
    YEAR_ORDER = s.yearOrder || ["Case Studies", "Year 12", "Year 11", "Other"];
    REPO_URL = s.repoUrl || "";
    if (repoLink) repoLink.href = REPO_URL;
    const brandEl = document.querySelector(".brand");
    if (brandEl) brandEl.textContent = s.shortName || s.name || "HSC Study";
    try { localStorage.setItem(LAST_SUBJECT_KEY, id); } catch {}
    return true;
  }
  // Ensure a given subject is the active one (no-op if already active).
  function ensureSubject(id) { return currentSubject === id || setSubject(id); }

  function computeStats() {
    const progress = loadProgress();
    let totalListenedSecs = 0;
    let completedCount = 0;
    const days = new Set();
    const allEps = [];
    // Per-subject when one is open; global (all subjects) on the picker. Tag modules with
    // their subject so the "by module" grouping can disambiguate (e.g. both have CASE).
    const global = !manifest;
    const mods = global
      ? (fullManifest ? fullManifest.subjects.flatMap((s) => s.modules.map((m) => ({ ...m, _subject: s.id }))) : [])
      : manifest.modules;
    mods.forEach((mod) => mod.episodes.forEach((ep) => allEps.push(ep)));

    for (const ep of allEps) {
      const p = progress[ep.id];
      if (!p) continue;
      if (p.completed) completedCount++;
      if (p.lastPlayed) days.add(p.lastPlayed.substring(0, 10));
    }

    const sortedDays = [...days].sort().reverse();
    let streak = 0;
    if (sortedDays.length > 0) {
      const today = new Date().toISOString().substring(0, 10);
      const yesterday = new Date(Date.now() - 86400000).toISOString().substring(0, 10);
      if (sortedDays[0] === today || sortedDays[0] === yesterday) {
        streak = 1;
        for (let i = 1; i < sortedDays.length; i++) {
          const diff = (new Date(sortedDays[i - 1]) - new Date(sortedDays[i])) / 86400000;
          if (diff <= 1) streak++;
          else break;
        }
      }
    }

    const groups = new Map();
    mods.forEach((mod) => {
      const key = global ? `${mod._subject}:${mod.prefix}` : mod.prefix;
      const name = global ? `${subjShort(mod._subject)} · ${groupNameFor(mod._subject, mod.prefix)}`
                          : (GROUP_NAMES[mod.prefix] || mod.prefix);
      if (!groups.has(key)) groups.set(key, { name, total: 0, done: 0 });
      const g = groups.get(key);
      mod.episodes.forEach((ep) => { g.total++; if (progress[ep.id]?.completed) g.done++; });
    });

    // Per-voice breakdown + total content heard, from actual playback (immune to
    // scrubbing — only counts seconds the audio really played).
    const voiceSecs = loadVoiceLog();
    totalListenedSecs = Object.values(voiceSecs).reduce((a, b) => a + (b || 0), 0);

    // Daily time-spent log → totals for the graph + cards.
    const log = loadListenLog();
    const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().substring(0, 10);
    let timeSpentTotal = 0, thisWeekSecs = 0, bestDaySecs = 0;
    for (const [day, s] of Object.entries(log)) {
      timeSpentTotal += s;
      if (s > bestDaySecs) bestDaySecs = s;
      if (day >= weekAgo) thisWeekSecs += s;
    }

    return {
      totalListenedSecs, completedCount, totalCount: allEps.length, streak, groups,
      voiceSecs, log, timeSpentTotal, thisWeekSecs, bestDaySecs,
    };
  }

  function renderStats() {
    const stats = computeStats();
    const speed = getCurrentSpeed();

    function fmtStat(secs) {
      if (!secs || secs < 60) return "<1m";
      const h = Math.floor(secs / 3600);
      const m = Math.round((secs % 3600) / 60);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    const listenedStr = fmtStat(stats.totalListenedSecs);
    // Actual time saved by listening faster = content heard − wall time spent.
    const savedStr = fmtStat(Math.max(0, stats.totalListenedSecs - stats.timeSpentTotal));

    // Listening-over-time: last 30 days, time spent per day.
    const N = 30;
    const todayStr = new Date().toISOString().substring(0, 10);
    const days = [];
    let maxDay = 1;
    for (let i = N - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().substring(0, 10);
      const s = stats.log[d] || 0;
      days.push({ d, s });
      if (s > maxDay) maxDay = s;
    }
    const chartHTML = days.map(({ d, s }) => {
      const h = s > 0 ? Math.max(Math.round((s / maxDay) * 100), 6) : 0;
      const cls = "day-bar" + (d === todayStr ? " day-bar-today" : "") + (s > 0 ? "" : " day-bar-empty");
      return `<div class="day-col" title="${d} · ${Math.round(s / 60)} min"><div class="${cls}" style="height:${h}%"></div></div>`;
    }).join("");

    // By voice (TTS model) breakdown.
    const voiceEntries = Object.entries(stats.voiceSecs).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
    const maxVoice = voiceEntries.length ? voiceEntries[0][1] : 1;
    const voiceHTML = voiceEntries.length
      ? voiceEntries.map(([name, secs]) => `
        <div class="voice-row">
          <span class="voice-name">${cleanVoiceName(name)}</span>
          <div class="voice-track"><div class="voice-fill" style="width:${Math.max(Math.round((secs / maxVoice) * 100), 3)}%"></div></div>
          <span class="voice-time">${fmtStat(secs)}</span>
        </div>`).join("")
      : `<p class="setting-hint">Play an episode to see your voice breakdown.</p>`;

    let groupsHTML = "";
    stats.groups.forEach((g) => {
      const pct = g.total ? Math.round((g.done / g.total) * 100) : 0;
      groupsHTML += `
        <div class="stats-module">
          <div class="stats-module-header">
            <span>${g.name}</span>
            <span class="stats-module-count">${g.done}/${g.total}</span>
          </div>
          <div class="stats-module-track"><div class="stats-module-fill" style="width:${pct}%"></div></div>
        </div>`;
    });

    statsContent.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-value">${fmtStat(stats.timeSpentTotal)}</div><div class="stat-label">Time spent</div></div>
        <div class="stat-card"><div class="stat-value">${stats.streak}🔥</div><div class="stat-label">Day streak</div></div>
        <div class="stat-card"><div class="stat-value">${fmtStat(stats.thisWeekSecs)}</div><div class="stat-label">This week</div></div>
        <div class="stat-card"><div class="stat-value">${stats.completedCount}/${stats.totalCount}</div><div class="stat-label">Episodes done</div></div>
        <div class="stat-card"><div class="stat-value">${listenedStr}</div><div class="stat-label">Content heard</div></div>
        <div class="stat-card"><div class="stat-value">${savedStr}</div><div class="stat-label">Time saved</div></div>
      </div>
      <h3 class="stats-section-title">Last 30 days</h3>
      <div class="day-chart">${chartHTML}</div>
      <h3 class="stats-section-title">By voice</h3>
      ${voiceHTML}
      <h3 class="stats-section-title">By module</h3>
      ${groupsHTML}`;
  }

  btnStats.addEventListener("click", () => {
    if (!fullManifest) return; // global stats on the picker; per-subject inside a subject
    renderStats();
    openSheet(statsOverlay);
  });
  statsOverlay.addEventListener("click", (e) => {
    if (e.target === statsOverlay) closeSheet(statsOverlay);
  });
  enableSheetDismiss(statsOverlay);

  if (btnReview) btnReview.addEventListener("click", openReview);
  if (reviewOverlay) {
    reviewOverlay.addEventListener("click", (e) => { if (e.target === reviewOverlay) closeSheet(reviewOverlay); });
    enableSheetDismiss(reviewOverlay);
  }

  // --- Downloads ---
  // The DOWNLOADS cache (see service-worker.js) holds the bytes; this localStorage
  // index is the fast source of truth for the UI: { [epId]: { voices:[names], at } }.
  function loadDownloads() {
    try { return JSON.parse(localStorage.getItem(DOWNLOADS_KEY)) || {}; } catch { return {}; }
  }
  function saveDownloads(all) { localStorage.setItem(DOWNLOADS_KEY, JSON.stringify(all)); }
  function isDownloaded(id) { return !!loadDownloads()[id]; }

  // The default voice for an episode = global default if this episode has it, else
  // the first voice. (Distinct from loadEpisode's resume logic, which prefers the
  // per-episode last-played voice.)
  function defaultVoiceForEpisode(ep) {
    const def = localStorage.getItem(DEFAULT_VOICE_KEY);
    return (def && ep.voices.find((v) => v.name === def)) || ep.voices[0];
  }
  function chosenVoiceNames(ep) {
    if (localStorage.getItem(DOWNLOAD_ALL_VOICES_KEY) === "1") return ep.voices.map((v) => v.name);
    const v = defaultVoiceForEpisode(ep);
    return v ? [v.name] : [];
  }
  function episodeAssets(ep, voiceNames) {
    const urls = voiceNames
      .map((n) => ep.voices.find((v) => v.name === n))
      .filter(Boolean)
      .map((v) => v.file);
    [ep.scriptPath, ep.supplementaryPath, ep.quizPath, ep.pdfPath, ep.mgPdfPath]
      .forEach((p) => { if (p) urls.push(p); });
    return urls;
  }

  // --- Mobile-data download guard ---
  const EST_BYTES_PER_SEC = 12300; // ~98 kbps m4a (measured), for download size estimates
  function estEpisodeBytes(ep) {
    return chosenVoiceNames(ep).reduce((sum, n) => {
      const v = ep.voices.find((x) => x.name === n);
      return sum + (v && v.duration ? v.duration * EST_BYTES_PER_SEC : 0);
    }, 0);
  }
  function connInfo() {
    return navigator.connection || navigator.mozConnection || navigator.webkitConnection || null;
  }
  function blockMobileData() { return localStorage.getItem(BLOCK_MOBILE_KEY) !== "0"; } // default ON

  // Latency proxy for "am I on a slow/mobile link?" — most browsers (esp. iOS Safari)
  // don't expose connection type, but round-trip time does: Wi-Fi/broadband to a CDN edge
  // is typically <100 ms, mobile data is usually higher. We warm up the connection, then
  // take the best of two tiny same-origin requests (best ≈ true RTT, least noise).
  async function probeLatencyMs() {
    try {
      await fetch("icons/icon-32.png?lat=" + Date.now(), { cache: "no-store" }); // warm-up
      let best = Infinity;
      for (let i = 0; i < 2; i++) {
        const t = performance.now();
        await fetch("icons/icon-32.png?lat=" + Date.now() + "-" + i, { cache: "no-store" });
        best = Math.min(best, performance.now() - t);
      }
      return best;
    } catch { return Infinity; }
  }

  // Resolves true if a ~estBytes download may proceed under the mobile-data setting.
  async function mayDownload(estBytes) {
    if (!blockMobileData()) return true;
    const c = connInfo();
    if (c) {
      if (c.type === "wifi" || c.type === "ethernet") return true; // definitely not mobile
      if (c.saveData || c.type === "cellular" || /(slow-2g|2g|3g)/.test(c.effectiveType || "")) {
        showToast("Downloads are blocked on mobile data (change in Settings).");
        return false;
      }
      if (c.effectiveType === "4g") return true; // fast link → allow silently
    }
    // No reliable signal (iOS) — use latency: fast link → allow silently; slow → confirm.
    const lat = await probeLatencyMs();
    if (lat < 150) return true;
    const mb = estBytes ? Math.max(1, Math.round(estBytes / 1e6)) : 0;
    return window.confirm(mb
      ? `This looks like a slow or mobile connection (~${Math.round(lat)} ms).\nDownload about ${mb} MB now?`
      : "This looks like a slow or mobile connection. Download now?");
  }

  let persistRequested = false;
  async function downloadEpisode(ep, onProgress, signal) {
    if (!persistRequested && navigator.storage && navigator.storage.persist) {
      persistRequested = true;
      try { await navigator.storage.persist(); } catch {}
    }
    const voiceNames = chosenVoiceNames(ep);
    const urls = episodeAssets(ep, voiceNames);
    const cache = await caches.open(DOWNLOADS_CACHE);
    let done = 0;
    if (onProgress) onProgress(0, urls.length);
    for (const url of urls) {
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!(await cache.match(url))) {
        const res = await fetch(url, signal ? { signal } : undefined);
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
        await cache.put(url, res);
      }
      done++;
      if (onProgress) onProgress(done, urls.length);
    }
    const all = loadDownloads();
    all[ep.id] = { voices: voiceNames, at: new Date().toISOString() };
    saveDownloads(all);
  }

  async function deleteEpisode(ep) {
    const all = loadDownloads();
    const voiceNames = all[ep.id]?.voices || ep.voices.map((v) => v.name);
    const cache = await caches.open(DOWNLOADS_CACHE);
    for (const url of episodeAssets(ep, voiceNames)) await cache.delete(url);
    delete all[ep.id];
    saveDownloads(all);
  }

  async function downloadModule(group, { onEpisodeState, onProgress, signal } = {}) {
    const eps = group.episodes;
    let done = 0;
    for (const ep of eps) {
      if (signal && signal.aborted) throw new DOMException("Aborted", "AbortError");
      if (!isDownloaded(ep.id)) {
        if (onEpisodeState) onEpisodeState(ep.id, "busy");
        try {
          await downloadEpisode(ep, null, signal);
        } catch (err) {
          if (onEpisodeState) onEpisodeState(ep.id, "idle"); // un-stick the row we marked busy
          throw err;
        }
      }
      if (onEpisodeState) onEpisodeState(ep.id, "done");
      done++;
      if (onProgress) onProgress(done, eps.length);
    }
  }

  async function clearAllDownloads() {
    await caches.delete(DOWNLOADS_CACHE);
    localStorage.removeItem(DOWNLOADS_KEY);
  }

  async function storageUsage() {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      return { usage, quota };
    }
    return { usage: 0, quota: 0 };
  }

  function fmtBytes(n) {
    if (!n) return "0 MB";
    const mb = n / (1024 * 1024);
    return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB";
  }

  // Reflect a download button's state (idle / busy / done) in place.
  function setDlState(btn, state) {
    if (!btn) return;
    btn.classList.remove("dl-busy", "dl-done");
    if (state === "busy") {
      btn.classList.add("dl-busy");
      btn.innerHTML = `<span class="dl-spinner"></span>`;
      btn.setAttribute("aria-label", "Downloading…");
    } else if (state === "done") {
      btn.classList.add("dl-done");
      btn.innerHTML = checkIcon(15);
      btn.setAttribute("aria-label", "Delete download");
    } else {
      btn.innerHTML = downloadIcon(15);
      btn.setAttribute("aria-label", "Download");
    }
  }

  // Re-sync a module's download button (✓ vs ↓) after a single episode in it is
  // downloaded or deleted, so the header reflects whether the whole module is saved.
  function syncModuleDlBtn(row) {
    const modEl = row.closest(".module");
    const mdlBtn = modEl && modEl.querySelector(".module-dl");
    if (!mdlBtn || mdlBtn.classList.contains("dl-busy")) return;
    // Check the module's whole episode set (from the store), not just rendered rows:
    // a filtered/search view renders a subset, and [].every() is vacuously true, so
    // the DOM-only check could mis-report the all-downloaded state. (BUG-14)
    let ids;
    try { ids = JSON.parse(modEl.dataset.epIds || "[]"); } catch { ids = []; }
    const allDl = ids.length > 0 && ids.every((id) => isDownloaded(id));
    mdlBtn.classList.toggle("dl-done", allDl);
    mdlBtn.innerHTML = allDl ? checkIcon(16) : downloadIcon(16);
    mdlBtn.setAttribute("aria-label", allDl ? "Delete module download" : "Download module");
  }

  let toastTimer = null;
  function showToast(msg) {
    const el = document.getElementById("toast");
    if (!el) return;
    // Unhide first, then set text: mutating the text while the live region is in the
    // a11y tree is what triggers the screen-reader announcement (role=status).
    setHidden(el, false);
    el.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setHidden(el, true), 3200);
  }

  // Offline, only downloaded episodes can play. Block + explain otherwise.
  function guardPlayable(ep) {
    if (navigator.onLine || isDownloaded(ep.id)) return true;
    showToast("Not downloaded — connect to the internet to play this.");
    return false;
  }

  // --- Settings ---
  function getVoiceCatalog() {
    const names = [];
    // Current subject's modules, or every subject's when none is selected (the picker).
    const mods = manifest ? manifest.modules
      : (fullManifest ? fullManifest.subjects.flatMap((s) => s.modules) : []);
    mods.forEach((mod) => mod.episodes.forEach((ep) =>
      (ep.voices || []).forEach((v) => { if (!names.includes(v.name)) names.push(v.name); })));
    return names;
  }

  function populateDefaultVoiceSelect() {
    const names = getVoiceCatalog();
    const current = localStorage.getItem(DEFAULT_VOICE_KEY) || names[0] || "";
    defaultVoiceSelect.innerHTML = "";
    names.forEach((name) => {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = cleanVoiceName(name);
      if (name === current) opt.selected = true;
      defaultVoiceSelect.appendChild(opt);
    });
  }

  function refreshStorageUsage() {
    if (!storageUsageEl) return;
    storageUsageEl.textContent = "…";
    storageUsage().then(({ usage }) => { storageUsageEl.textContent = fmtBytes(usage); });
  }

  // Settings → About → Build: the git short hash of the running build, tap to reveal that
  // build's commit message. Sourced from /build.json (written per deploy by deploy.sh) and
  // precached per-build, so it always matches the shell actually running on this device —
  // handy for confirming a new deploy has actually installed (PWA updates are sticky).
  let _buildInfo = null;
  function refreshBuildVersion() {
    const el = document.getElementById("build-version");
    const msg = document.getElementById("build-message");
    if (msg) msg.hidden = true;
    if (!el) return;
    if (_buildInfo) { el.textContent = _buildInfo.build || "unknown"; return; }
    fetch("/build.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("no build.json"))))
      .then((info) => { _buildInfo = info; el.textContent = info.build || "unknown"; })
      .catch(() => { el.textContent = "dev"; });
  }
  const buildVersionBtn = document.getElementById("build-version");
  if (buildVersionBtn) buildVersionBtn.addEventListener("click", () => {
    const msg = document.getElementById("build-message");
    if (!msg || !_buildInfo) return;
    const date = _buildInfo.date ? new Date(_buildInfo.date).toLocaleString() : "";
    msg.textContent = (_buildInfo.message || "(no commit message)") + (date ? " · " + date : "");
    msg.hidden = !msg.hidden;
  });

  // BUG-36 audio diagnostics: dump the ring buffer as relative-time lines (t=+Ns).
  function formatAudioLog() {
    if (!AUDIO_LOG.length) return "(no audio events yet — play something first)";
    const t0 = AUDIO_LOG[0].t;
    return AUDIO_LOG.map((e) => "+" + ((e.t - t0) / 1000).toFixed(1) + "s  " + e.line).join("\n");
  }
  const audioLogShow = document.getElementById("audio-log-show");
  const audioLogOut = document.getElementById("audio-log-out");
  if (audioLogShow && audioLogOut) audioLogShow.addEventListener("click", () => {
    audioLogOut.textContent = formatAudioLog();
    audioLogOut.hidden = !audioLogOut.hidden;
  });
  const audioLogCopy = document.getElementById("audio-log-copy");
  if (audioLogCopy) audioLogCopy.addEventListener("click", () => {
    const text = formatAudioLog();
    const done = () => { audioLogCopy.textContent = "Copied"; setTimeout(() => (audioLogCopy.textContent = "Copy"), 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(() => { audioLogOut.hidden = false; audioLogOut.textContent = text; });
    else { audioLogOut.hidden = false; audioLogOut.textContent = text; }
  });
  const audioLogClear = document.getElementById("audio-log-clear");
  if (audioLogClear) audioLogClear.addEventListener("click", () => {
    AUDIO_LOG.length = 0;
    AUDIO_LOG.push({ t: Date.now(), line: "=== cleared ===" });
    persistAudioLog();
    if (audioLogOut && !audioLogOut.hidden) audioLogOut.textContent = formatAudioLog();
    audioLogClear.textContent = "Cleared";
    setTimeout(() => (audioLogClear.textContent = "Clear"), 1500);
  });

  btnSettings.addEventListener("click", () => {
    if (!fullManifest) return; // settings are global — available on the picker too
    populateDefaultVoiceSelect();
    if (dlAllVoicesToggle) dlAllVoicesToggle.checked = localStorage.getItem(DOWNLOAD_ALL_VOICES_KEY) === "1";
    if (blockMobileToggle) blockMobileToggle.checked = blockMobileData();
    if (introTitleToggle) introTitleToggle.checked = introEnabled();
    if (quizSplitToggle) quizSplitToggle.checked = quizSplitBySubject();
    if (speedEngineToggle) {
      speedEngineToggle.checked = wantsHsEngine();
      // No AudioWorklet → nothing to toggle. Hide the toggle + its hint.
      if (!audio.engineAvailable) {
        const row = speedEngineToggle.closest(".setting-row");
        const hint = row && row.nextElementSibling;
        if (row) setHidden(row, true);
        if (hint && hint.classList.contains("setting-hint")) setHidden(hint, true);
      }
    }
    if (fsrsRetentionSelect) fsrsRetentionSelect.value = String(fsrsSettings().retention);
    if (fsrsStepsInput) fsrsStepsInput.value = fsrsSettings().steps;
    if (speedUnitSelect) speedUnitSelect.value = speedUnitMode();
    if (simpleSpeedToggle) simpleSpeedToggle.checked = simpleSpeedMode();
    refreshStorageUsage();
    refreshBuildVersion();
    updateInstallUI();
    if (window.Sync) window.Sync.renderPanel();
    openSheet(settingsOverlay);
  });
  if (speedUnitSelect) speedUnitSelect.addEventListener("change", () => {
    localStorage.setItem(SPEED_UNIT_KEY, speedUnitSelect.value === "sps" ? "sps" : "mult");
    setSpeed(getCurrentSpeedIdx()); // refresh the player display + unit label
  });
  if (simpleSpeedToggle) simpleSpeedToggle.addEventListener("change", () => {
    localStorage.setItem(SIMPLE_SPEED_KEY, simpleSpeedToggle.checked ? "1" : "0");
    applySpeedUI();
    syncEngine(true); // simple mode ⇒ native (background); high-speed mode ⇒ speechwarp
  });
  const btnChooseSubjects = document.getElementById("btn-choose-subjects");
  if (btnChooseSubjects) btnChooseSubjects.addEventListener("click", () => {
    closeSheet(settingsOverlay);
    openSubjectPicker(true);   // re-run the first-run onboarding picker (welcome variant)
  });
  // FEATURE-13: send free-text feedback to the backend.
  const btnFeedbackSend = document.getElementById("btn-feedback-send");
  const feedbackText = document.getElementById("feedback-text");
  const feedbackStatus = document.getElementById("feedback-status");
  if (btnFeedbackSend) btnFeedbackSend.addEventListener("click", async () => {
    const text = (feedbackText.value || "").trim();
    if (!text) { if (feedbackStatus) feedbackStatus.textContent = "Type something first."; return; }
    btnFeedbackSend.disabled = true;
    try {
      await window.Feedback.send(text);
      feedbackText.value = "";
      if (feedbackStatus) feedbackStatus.textContent = "Thanks — sent! 🙏";
      track("feedback_sent");
    } catch (e) {
      if (feedbackStatus) feedbackStatus.textContent = "Couldn't send — check your connection and retry.";
    } finally { btnFeedbackSend.disabled = false; }
  });
  settingsOverlay.addEventListener("click", (e) => {
    if (e.target === settingsOverlay) closeSheet(settingsOverlay);
  });
  enableSheetDismiss(settingsOverlay);
  defaultVoiceSelect.addEventListener("change", () => {
    const name = defaultVoiceSelect.value;
    localStorage.setItem(DEFAULT_VOICE_KEY, name);
    if (currentEpisode) {
      const idx = currentEpisode.voices.findIndex((v) => v.name === name);
      if (idx >= 0) switchVoice(idx);
    }
  });
  // BUG-26: size helpers for the download/delete warnings.
  const GB = 1024 * 1024 * 1024;
  function estDownloadedBytes() {
    const dls = loadDownloads(); let bytes = 0;
    for (const id of Object.keys(dls)) {
      const ep = findEpisode(id); if (!ep) continue;
      const names = dls[id].voices || ep.voices.map((v) => v.name);
      for (const n of names) { const v = ep.voices.find((x) => x.name === n); if (v && v.duration) bytes += v.duration * EST_BYTES_PER_SEC; }
    }
    return bytes;
  }
  function estBackfillBytes() {
    const dls = loadDownloads(); let bytes = 0;
    for (const id of Object.keys(dls)) {
      const ep = findEpisode(id); if (!ep) continue;
      const have = new Set(dls[id].voices || []);
      for (const v of ep.voices) if (!have.has(v.name) && v.duration) bytes += v.duration * EST_BYTES_PER_SEC;
    }
    return bytes;
  }
  async function backfillAllVoices() {
    const ids = Object.keys(loadDownloads());
    let n = 0;
    for (const id of ids) { const ep = findEpisode(id); if (!ep) continue; try { await downloadEpisode(ep); n++; } catch (e) {} }
    refreshStorageUsage();
    if (!viewLibrary.hidden) renderLibrary();
    if (n) showToast("Extra voices downloaded for your saved episodes.");
  }
  if (dlAllVoicesToggle) dlAllVoicesToggle.addEventListener("change", async () => {
    if (!dlAllVoicesToggle.checked) { localStorage.setItem(DOWNLOAD_ALL_VOICES_KEY, ""); return; }
    // BUG-26: turning it on back-fills the missing voices for already-saved episodes. Warn
    // before downloading more than ~3 GB, and revert the toggle if the user declines.
    const extra = estBackfillBytes();
    if (extra > 3 * GB && !confirm(`This will download about ${fmtBytes(extra)} of extra voices for your saved episodes. Continue?`)) {
      dlAllVoicesToggle.checked = false;
      return;
    }
    localStorage.setItem(DOWNLOAD_ALL_VOICES_KEY, "1");
    if (extra > 0) { if (!(await mayDownload(extra))) return; backfillAllVoices(); }
  });
  if (introTitleToggle) introTitleToggle.addEventListener("change", () => {
    localStorage.setItem(INTRO_KEY, introTitleToggle.checked ? "1" : "0");
  });
  if (quizSplitToggle) quizSplitToggle.addEventListener("change", () => {
    localStorage.setItem(QUIZ_SPLIT_KEY, quizSplitToggle.checked ? "1" : "0");
  });
  if (speedEngineToggle && audio.setEngineEnabled) speedEngineToggle.addEventListener("change", () => {
    // This toggle records the user's high-speed-engine INTENT; the reconciler decides
    // whether it's actually active (it's overridden to native while in simple mode).
    localStorage.setItem(HS_ENGINE_KEY, speedEngineToggle.checked ? "1" : "0");
    syncEngine(true);
  });
  if (blockMobileToggle) blockMobileToggle.addEventListener("change", () => {
    // Stored inverted: default (absent) = ON; "0" = off.
    localStorage.setItem(BLOCK_MOBILE_KEY, blockMobileToggle.checked ? "1" : "0");
  });
  function saveFsrsSettings() {
    const cur = fsrsSettings();
    const retention = fsrsRetentionSelect ? parseFloat(fsrsRetentionSelect.value) : cur.retention;
    const steps = fsrsStepsInput && fsrsStepsInput.value.trim() ? fsrsStepsInput.value.trim() : cur.steps;
    localStorage.setItem(FSRS_SETTINGS_KEY, JSON.stringify({ retention, steps }));
    _fsrs = null; // force the engine to rebuild with new params
    window.Sync && window.Sync.scheduleSync();
  }
  if (fsrsRetentionSelect) fsrsRetentionSelect.addEventListener("change", saveFsrsSettings);
  if (fsrsStepsInput) fsrsStepsInput.addEventListener("change", saveFsrsSettings);
  if (btnClearDownloads) btnClearDownloads.addEventListener("click", async () => {
    const freed = estDownloadedBytes();
    const msg = freed > 0
      ? `Delete all downloaded episodes? This frees about ${fmtBytes(freed)} of voice audio. They'll need to be downloaded again for offline use.`
      : "Delete all downloaded episodes? They'll need to be downloaded again for offline use.";
    if (!confirm(msg)) return;
    await clearAllDownloads();
    refreshStorageUsage();
    if (!viewLibrary.hidden) renderLibrary();
    showToast("Downloads cleared.");
  });

  // --- Library ---
  function getLastPlayedEpisode() {
    const progress = loadProgress();
    let latestEp = null, latestTime = 0;
    for (const [id, p] of Object.entries(progress)) {
      if (p.lastPlayed && !p.completed) {
        const t = new Date(p.lastPlayed).getTime();
        if (t > latestTime) { latestTime = t; latestEp = findEpisode(id); }
      }
    }
    return latestEp;
  }

  // Start a whole module: resume the first unlistened episode (at its saved
  // position) and replace the queue with every episode after it.
  function startModule(group) {
    const eps = group.episodes.filter((e) => e.voices && e.voices.length); // playable only
    if (!eps.length) { showToast("No audio in this module yet."); return; }
    let idx = eps.findIndex((e) => !getEpisodeProgress(e.id).completed);
    if (idx < 0) idx = 0; // all completed → start from the top
    if (!guardPlayable(eps[idx])) return;
    queue = eps.slice(idx + 1).map((e) => e.id);
    updateQueueBadge();
    loadEpisode(eps[idx], { autoplay: true });
    navigateToEpisode(eps[idx].id);
  }

  // Find a rendered episode row's download button within a module element.
  function rowDlBtn(groupEl, epId) {
    const row = groupEl.querySelector(`.episode-row[data-ep-id="${CSS.escape(epId)}"]`);
    return row && row.querySelector(".ep-dl-btn");
  }

  // Download or remove an entire module, keeping the module's row buttons and the
  // module button in sync as it goes (no full re-render → the module stays open).
  let moduleDlAbort = null; // AbortController for the in-flight module download (one at a time)
  async function handleModuleDownload(group, groupEl, mdlBtn) {
    // A tap on a module that's mid-download cancels it (episodes already saved stay saved).
    if (mdlBtn.classList.contains("dl-busy")) {
      if (moduleDlAbort) moduleDlAbort.abort();
      return;
    }
    const syncRow = (id, state) => {
      const b = rowDlBtn(groupEl, id);
      setDlState(b, state);
      const r = b && b.closest(".episode-row");
      if (r) r.classList.toggle("ep-downloaded", state === "done");
    };
    if (mdlBtn.classList.contains("dl-done")) {
      for (const ep of group.episodes) {
        await deleteEpisode(ep);
        syncRow(ep.id, "idle");
      }
      setDlState(mdlBtn, "idle");
      return;
    }
    const estBytes = group.episodes.filter((e) => !isDownloaded(e.id)).reduce((s, e) => s + estEpisodeBytes(e), 0);
    if (!(await mayDownload(estBytes))) return;
    const controller = new AbortController();
    moduleDlAbort = controller;
    setDlState(mdlBtn, "busy");
    mdlBtn.setAttribute("aria-label", "Cancel download"); // tap again to stop
    mdlBtn.title = "Tap to stop downloading";
    try {
      await downloadModule(group, { onEpisodeState: syncRow, signal: controller.signal });
      setDlState(mdlBtn, "done");
    } catch (err) {
      const stopped = err && err.name === "AbortError";
      setDlState(mdlBtn, group.episodes.every((e) => isDownloaded(e.id)) ? "done" : "idle");
      if (stopped) {
        showToast("Download stopped.");
      } else {
        console.error("[download:module]", err);
        showToast("Module download failed — check your connection.");
      }
    } finally {
      mdlBtn.removeAttribute("title");
      if (moduleDlAbort === controller) moduleDlAbort = null;
    }
  }

  // The subject picker (landing screen). One tile per subject with its overall progress.
  // FEATURE-10: drag-to-reorder subjects. Order is an array of subject ids in the user's
  // preferred order; unlisted/new subjects are appended. Persisted locally and sync-scheduled.
  const SUBJECT_ORDER_KEY = "podcast-subject-order";
  function loadSubjectOrder() {
    try { const v = JSON.parse(localStorage.getItem(SUBJECT_ORDER_KEY)); return Array.isArray(v) ? v : []; }
    catch { return []; }
  }
  function saveSubjectOrder(ids) {
    try { localStorage.setItem(SUBJECT_ORDER_KEY, JSON.stringify(ids)); } catch (e) {}
    window.Sync && window.Sync.scheduleSync();
  }
  function sortByOrder(items) {
    const order = loadSubjectOrder();
    if (!order.length) return items;
    const pos = new Map(order.map((id, i) => [id, i]));
    return items.slice().sort((a, b) =>
      (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9));
  }
  let subjectsSortable = null;
  function enableSubjectReorder(grid) {
    if (!window.Sortable) return;
    if (subjectsSortable) { try { subjectsSortable.destroy(); } catch (e) {} }
    subjectsSortable = window.Sortable.create(grid, {
      draggable: ".subject-tile",
      animation: 160,
      delay: 250, delayOnTouchOnly: true,   // quick tap = open subject; long-press = drag to reorder
      forceFallback: true, fallbackOnBody: true, fallbackTolerance: 5,
      ghostClass: "subject-ghost",
      onEnd: () => saveSubjectOrder([...grid.querySelectorAll(".subject-tile")].map((t) => t.dataset.subjectId)),
    });
  }

  function renderSubjects() {
    if (!viewSubjects) return;
    viewSubjects.innerHTML = "";
    const brandEl = document.querySelector(".brand");
    if (brandEl) brandEl.textContent = "HSC Study";
    const progress = loadProgress();

    // Daily-quiz box — sits at the very top so it's the first thing you see. One tap
    // starts a quiz straight away (no config screen): the lowest-barrier way to study.
    const due = reviewsDueCount();
    const quizBox = document.createElement("button");
    quizBox.className = "daily-quiz";
    quizBox.innerHTML = `
      <span class="dq-icon">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3l14 9-14 9z"/></svg>
      </span>
      <span class="dq-text">
        <span class="dq-title">Start your daily quiz</span>
        <span class="dq-sub">${due > 0
          ? `${due} due now · keep your knowledge fresh`
          : "Quick questions to keep your knowledge fresh"}</span>
      </span>
      <span class="dq-cta">${due > 0 ? `<span class="dq-count">${due > 99 ? "99+" : due}</span>` : ""}<span class="dq-start">Start now</span></span>`;
    quizBox.addEventListener("click", () => startDailyQuiz());
    viewSubjects.appendChild(quizBox);

    // Fine-tune option: for when you want to pick specific subjects/topics and how many,
    // rather than the one-tap general quiz above. Opens the full review hub.
    const tuneBtn = document.createElement("button");
    tuneBtn.className = "dq-tune";
    tuneBtn.innerHTML = `
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>
      <span>Choose specific topics &amp; how many</span>`;
    tuneBtn.addEventListener("click", () => openReview());
    viewSubjects.appendChild(tuneBtn);

    const intro = document.createElement("div");
    intro.className = "subjects-intro";
    intro.innerHTML = `<h1 class="subjects-title">HSC Study</h1><p class="subjects-sub">Choose a subject</p>`;
    viewSubjects.appendChild(intro);

    // "Edit subjects" affordance — lets you reopen the picker to add/remove subjects.
    const chosen = chosenSubjectIds();
    if (chosen) {
      const editBar = document.createElement("button");
      editBar.className = "subjects-edit-link";
      editBar.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg><span>Edit subjects</span>`;
      editBar.addEventListener("click", () => openSubjectPicker(false));
      viewSubjects.appendChild(editBar);
    }

    const grid = document.createElement("div");
    grid.className = "subjects-grid";
    // Unify the two tile sources (podcast subjects + paper-only banks) into one ordered list
    // so drag-reorder (FEATURE-10) works across both.
    const manifestIds = new Set((fullManifest ? fullManifest.subjects : []).map((s) => s.id));
    const items = [];
    (fullManifest ? fullManifest.subjects : [])
      .filter((s) => !chosen || chosen.includes(s.id))
      .forEach((s) => items.push({ id: s.id, kind: "subject", s }));
    GENERATOR_BANKS.filter(([bid]) => !manifestIds.has(bid))
      .filter(([bid]) => !chosen || chosen.includes(bid))
      .forEach(([bid, bname]) => items.push({ id: bid, kind: "bank", name: bname }));

    sortByOrder(items).forEach((it) => {
      const tile = document.createElement("button");
      tile.className = "subject-tile";
      tile.dataset.subjectId = it.id;
      if (it.kind === "subject") {
        const eps = it.s.modules.flatMap((m) => m.episodes);
        const total = eps.length;
        const done = eps.filter((e) => progress[e.id] && progress[e.id].completed).length;
        const pct = total ? Math.round((done / total) * 100) : 0;
        tile.innerHTML = `
          <span class="subject-name">${it.s.name}</span>
          <span class="subject-meta">${total} episodes · ${done}/${total} listened</span>
          <span class="subject-track"><span class="subject-fill" style="width:${pct}%"></span></span>`;
        tile.addEventListener("click", () => { window.location.hash = `#/s/${encodeURIComponent(it.id)}`; });
      } else {
        tile.innerHTML = `
          <span class="subject-name">${it.name}</span>
          <span class="subject-meta">Past-paper question bank · generate practice papers</span>`;
        tile.addEventListener("click", () => { window.location.href = `generator.html?subject=${encodeURIComponent(it.id)}`; });
      }
      grid.appendChild(tile);
    });
    viewSubjects.appendChild(grid);
    enableSubjectReorder(grid);   // FEATURE-10: long-press / drag a tile to reorder
  }

  // Subjects with a baked past-paper question bank (content/<id>/questions.json).
  // Paper-only subjects (past papers in R2, no podcast episodes) — shown as generator tiles.
  // Seeded with the core few; replaced at load by content/paper-subjects.json (all subjects
  // that have papers in the bucket) so the onboarding picker can offer every one of them.
  let GENERATOR_BANKS = [
    ["maths-advanced", "Mathematics Advanced"],
    ["physics", "Physics"],
    ["dt", "Design & Technology"],
  ];
  async function loadPaperSubjects() {
    try {
      const reg = await fetch("content/paper-subjects.json", { cache: "no-store" }).then((r) => r.json());
      if (Array.isArray(reg) && reg.length) {
        GENERATOR_BANKS = reg.filter((r) => (r.papers || 0) > 0).map((r) => [r.id, r.name]);
      }
    } catch (e) { /* keep the seeded fallback */ }
  }

  // --- Subject selection / first-run onboarding ---
  // With many subjects a full grid is unusable, so on first run (no stored prefs) we ask the
  // user to search + pick the subjects they study; the picker box stores an id list in
  // SUBJECTS_KEY and renderSubjects() then shows only those. Absent = show everything.
  const subjectsOverlay = document.getElementById("subjects-overlay");
  const subjectsSearch = document.getElementById("subjects-search");
  const subjectsPickList = document.getElementById("subjects-pick-list");
  const subjectsPickSave = document.getElementById("subjects-pick-save");
  const subjectsPickAll = document.getElementById("subjects-pick-all");
  const subjectsPickIntro = document.getElementById("subjects-pick-intro");
  let pickerState = null; // Set<id> of selections while the picker is open

  function chosenSubjectIds() {
    try { const v = JSON.parse(localStorage.getItem(SUBJECTS_KEY)); return Array.isArray(v) && v.length ? v : null; }
    catch { return null; }
  }
  function isOnboarded() { return localStorage.getItem(ONBOARDED_KEY) === "1"; }
  function markOnboarded() { try { localStorage.setItem(ONBOARDED_KEY, "1"); } catch {} }

  // All pickable subjects: those with episodes (manifest) plus generator-only banks, in order.
  function selectableSubjects() {
    const subs = (fullManifest ? fullManifest.subjects : []).map((s) => ({ id: s.id, name: s.name }));
    const ids = new Set(subs.map((s) => s.id));
    GENERATOR_BANKS.filter(([bid]) => !ids.has(bid)).forEach(([bid, bname]) => subs.push({ id: bid, name: bname }));
    return subs;
  }

  function renderSubjectPicker(filter) {
    if (!subjectsPickList) return;
    const q = (filter || "").trim().toLowerCase();
    subjectsPickList.innerHTML = "";
    const matches = selectableSubjects().filter((s) => !q || s.name.toLowerCase().includes(q));
    if (!matches.length) {
      subjectsPickList.innerHTML = `<p class="subjects-pick-empty">No subjects match “${q}”.</p>`;
      return;
    }
    matches.forEach((s) => {
      const row = document.createElement("label");
      row.className = "subjects-pick-row";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "setting-toggle";
      cb.checked = pickerState.has(s.id);
      cb.addEventListener("change", () => {
        cb.checked ? pickerState.add(s.id) : pickerState.delete(s.id);
        updatePickSave();
      });
      const name = document.createElement("span");
      name.className = "subjects-pick-name";
      name.textContent = s.name;
      row.appendChild(cb);
      row.appendChild(name);
      subjectsPickList.appendChild(row);
    });
  }
  function updatePickSave() {
    if (!subjectsPickSave) return;
    const n = pickerState ? pickerState.size : 0;
    subjectsPickSave.textContent = n ? `Continue with ${n} subject${n > 1 ? "s" : ""}` : "Continue";
  }
  function openSubjectPicker(firstRun) {
    if (!subjectsOverlay) return;
    pickerState = new Set(chosenSubjectIds() || []);
    if (subjectsPickIntro) subjectsPickIntro.textContent = firstRun
      ? "Welcome! Search and pick the subjects you're studying — just the ones you want on your home screen. You can change these any time in Settings."
      : "Pick the subjects you want on your home screen. Change these any time.";
    if (subjectsSearch) subjectsSearch.value = "";
    renderSubjectPicker("");
    updatePickSave();
    openSheet(subjectsOverlay);
  }
  function commitSubjectPicker(ids) {
    try {
      if (ids && ids.length) localStorage.setItem(SUBJECTS_KEY, JSON.stringify(ids));
      else localStorage.removeItem(SUBJECTS_KEY); // none chosen ⇒ show all
    } catch {}
    markOnboarded();
    closeSheet(subjectsOverlay);
    renderSubjects();
    maybeWalkthrough();   // FEATURE-15: show the tour right after first-run subject picking
  }
  if (subjectsSearch) subjectsSearch.addEventListener("input", () => renderSubjectPicker(subjectsSearch.value));
  if (subjectsPickSave) subjectsPickSave.addEventListener("click", () => {
    // Preserve manifest order rather than click order.
    const ids = selectableSubjects().map((s) => s.id).filter((id) => pickerState.has(id));
    commitSubjectPicker(ids);
  });
  if (subjectsPickAll) subjectsPickAll.addEventListener("click", () => commitSubjectPicker(null));
  if (subjectsOverlay) {
    subjectsOverlay.addEventListener("click", (e) => { if (e.target === subjectsOverlay) { markOnboarded(); closeSheet(subjectsOverlay); } });
    enableSheetDismiss(subjectsOverlay);
    const x = subjectsOverlay.querySelector(".sheet-close");
    if (x) x.addEventListener("click", () => { markOnboarded(); renderSubjects(); });
  }
  // Trigger the first-run picker once the manifest is loaded and we're on the subject grid.
  function maybeOnboard() {
    if (isOnboarded()) { maybeWalkthrough(); return; }
    if (!fullManifest || fullManifest.subjects.length <= 1) { markOnboarded(); maybeWalkthrough(); return; }
    if (viewSubjects && !viewSubjects.hidden) openSubjectPicker(true);
    else maybeWalkthrough();
  }

  // FEATURE-15: quick "how to use the app" walkthrough.
  const WALKTHROUGH_KEY = "podcast-walkthrough-seen";
  const walkthroughOverlay = document.getElementById("walkthrough-overlay");
  const WT_STEPS = [
    { e: "👋", t: "Welcome to HSC Study", x: "Podcasts, quizzes and past papers for your HSC subjects — all in one place." },
    { e: "📚", t: "Your subjects", x: "Pick the subjects you study on the home screen. Add/remove them any time in Settings → Subjects, and drag a tile to reorder." },
    { e: "🎧", t: "Listen your way", x: "Play an episode and set the speed — it goes well past normal and keeps playing with the screen off. Tap ⌄ to shrink the player." },
    { e: "🧠", t: "Quiz yourself", x: "Every episode has a quiz, and your daily quiz keeps knowledge fresh with spaced repetition." },
    { e: "📄", t: "Past papers", x: "Open a subject's Paper Generator to browse whole past papers (filter by year/school), or build a custom practice paper from real questions." },
    { e: "☁️", t: "Sync your progress", x: "Log in under Settings → Sync and your progress follows you to any device." },
  ];
  let wtStep = 0;
  function renderWtStep() {
    const s = WT_STEPS[wtStep];
    document.getElementById("wt-emoji").textContent = s.e;
    document.getElementById("wt-title").textContent = s.t;
    document.getElementById("wt-text").textContent = s.x;
    document.getElementById("wt-dots").innerHTML = WT_STEPS.map((_, i) => `<span class="wt-dot${i === wtStep ? " on" : ""}"></span>`).join("");
    document.getElementById("wt-next").textContent = wtStep === WT_STEPS.length - 1 ? "Done" : "Next";
  }
  function openWalkthrough() { if (!walkthroughOverlay) return; wtStep = 0; renderWtStep(); openSheet(walkthroughOverlay); }
  function finishWalkthrough() { try { localStorage.setItem(WALKTHROUGH_KEY, "1"); } catch (e) {} closeSheet(walkthroughOverlay); }
  function maybeWalkthrough() { if (localStorage.getItem(WALKTHROUGH_KEY) !== "1") openWalkthrough(); }
  if (walkthroughOverlay) {
    document.getElementById("wt-next").addEventListener("click", () => {
      if (wtStep >= WT_STEPS.length - 1) finishWalkthrough(); else { wtStep++; renderWtStep(); }
    });
    document.getElementById("wt-skip").addEventListener("click", finishWalkthrough);
    const x = walkthroughOverlay.querySelector(".sheet-close");
    if (x) x.addEventListener("click", finishWalkthrough);
    walkthroughOverlay.addEventListener("click", (e) => { if (e.target === walkthroughOverlay) finishWalkthrough(); });
  }
  const btnWalkthrough = document.getElementById("btn-walkthrough");
  if (btnWalkthrough) btnWalkthrough.addEventListener("click", () => { closeSheet(settingsOverlay); openWalkthrough(); });

  // The per-subject hub: one level below the subject grid. Splits a subject into its
  // three modes — Podcasts, Quizzes, Past Papers — each opening its own surface.
  function renderSubjectHub() {
    if (!viewSubjectHub) return;
    viewSubjectHub.innerHTML = "";
    const s = subjectMeta(currentSubject);
    if (!s) return;
    const brandEl = document.querySelector(".brand");
    if (brandEl) brandEl.textContent = s.shortName || s.name || "HSC Study";
    const progress = loadProgress();
    const id = encodeURIComponent(s.id);

    // Podcast episodes exclude the synthetic EXAM (past papers) module.
    const podModules = s.modules.filter((m) => m.prefix !== "EXAM" && !CARD_ONLY_PREFIXES.has(m.prefix));
    const podEps = podModules.flatMap((m) => m.episodes);
    const podDone = podEps.filter((e) => progress[e.id] && progress[e.id].completed).length;
    const hasPapers = s.modules.some((m) => m.prefix === "EXAM");
    const paperCount = s.modules.filter((m) => m.prefix === "EXAM").flatMap((m) => m.episodes).length;
    const due = reviewsDueCount(s.id);

    const intro = document.createElement("div");
    intro.className = "subjects-intro";
    intro.innerHTML = `<h1 class="subjects-title">${s.name}</h1><p class="subjects-sub">Choose what to study</p>`;
    viewSubjectHub.appendChild(intro);

    const grid = document.createElement("div");
    grid.className = "subjects-grid hub-grid";

    const podIcon = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><path d="M12 18v4"/></svg>`;
    const quizIcon = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M14 3v5h5"/><path d="M9 13l2 2 4-4"/></svg>`;
    const paperIcon = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h8"/></svg>`;

    const makeTile = (icon, name, sub, hash, badge) => {
      const tile = document.createElement("button");
      tile.className = "subject-tile hub-tile";
      tile.innerHTML = `
        <span class="hub-tile-icon">${icon}</span>
        <span class="hub-tile-text">
          <span class="subject-name">${name}</span>
          <span class="subject-meta">${sub}</span>
        </span>
        ${badge ? `<span class="hub-tile-badge">${badge > 99 ? "99+" : badge}</span>` : ""}
        <span class="hub-tile-chev">&#8250;</span>`;
      tile.addEventListener("click", () => { window.location.hash = hash; });
      grid.appendChild(tile);
    };

    makeTile(podIcon, "Podcasts",
      `${podEps.length} episode${podEps.length === 1 ? "" : "s"} · ${podDone}/${podEps.length} listened`,
      `#/s/${id}/podcasts`);
    makeTile(quizIcon, "Quizzes",
      due > 0 ? `${due} card${due === 1 ? "" : "s"} due for review` : "Flashcards & spaced repetition",
      `#/s/${id}/quizzes`, due);
    if (hasPapers) {
      makeTile(paperIcon, "Past Papers",
        `${paperCount} paper${paperCount === 1 ? "" : "s"} · generate & mark`,
        `#/s/${id}/papers`);
    }
    // Plot map — set-text scene arc with live position tracking. English Standard only
    // for now; add the subject id here once another text has a scenes.json.
    if (PLOT_MAP_SUBJECTS.has(s.id)) {
      const mapIcon = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c3-6 5 2 8-4s5 3 10-6"/><circle cx="3" cy="17" r="1.6"/><circle cx="11" cy="13" r="1.6"/><circle cx="21" cy="7" r="1.6"/></svg>`;
      makeTile(mapIcon, "Modules",
        "Common · A · B · C",
        `#/s/${id}/modules`);
    }
    // Paper generator entry — subjects with a question bank open the generator scoped
    // to this subject (full navigation; the generator is its own page).
    if (GENERATOR_BANKS.some(([bid]) => bid === s.id)) {
      const genIcon = `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v4H4z"/><path d="M4 12h10"/><path d="M4 16h10"/><path d="M4 20h7"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M18.5 16v3l1.5 1"/></svg>`;
      const tile = document.createElement("button");
      tile.className = "subject-tile hub-tile";
      tile.innerHTML = `
        <span class="hub-tile-icon">${genIcon}</span>
        <span class="hub-tile-text">
          <span class="subject-name">Paper Generator</span>
          <span class="subject-meta">Build a custom practice paper from real questions</span>
        </span>
        <span class="hub-tile-chev">&#8250;</span>`;
      tile.addEventListener("click", () => { window.location.href = `generator.html?subject=${encodeURIComponent(s.id)}`; });
      grid.appendChild(tile);
    }

    viewSubjectHub.appendChild(grid);
  }

  function renderLibrary(mode) {
    viewLibrary.innerHTML = "";
    // Remember the mode so bare re-renders (search input, sync updates) keep it.
    if (mode) currentLibMode = mode;
    const papersMode = currentLibMode === "papers";
    // Podcasts mode shows every module except the synthetic EXAM (past papers) module and the
    // card-only revision decks (MEM/EPC — audio-less; BUG-30). Their cards still load into the
    // flashcard/quiz pool from the manifest; they just don't render as blank podcast episodes.
    // Papers mode shows only EXAM. A subject's library is one mode or the other.
    const srcModules = manifest.modules.filter((m) =>
      papersMode ? m.prefix === "EXAM" : (m.prefix !== "EXAM" && !CARD_ONLY_PREFIXES.has(m.prefix)));
    const q = papersMode ? "" : ((libSearchInput && libSearchInput.value) || "").trim().toLowerCase();

    // Continue-listening banner — podcasts only, and hidden while searching (results are the focus).
    const lastEp = (q || papersMode) ? null : getLastPlayedEpisode();
    if (lastEp) {
      const prog = getEpisodeProgress(lastEp.id);
      const pct = Math.round((prog.progressPct || 0) * 100);
      const banner = document.createElement("div");
      banner.className = "continue-banner";
      banner.innerHTML = `
        <div class="continue-info">
          <div class="continue-label">Continue listening</div>
          <div class="continue-title">${lastEp.title}</div>
          <div class="continue-track"><div class="continue-fill" style="width:${pct}%"></div></div>
        </div>
        <button class="continue-play" aria-label="Resume">${playIcon(18)}</button>`;
      banner.querySelector(".continue-play").addEventListener("click", (e) => {
        e.stopPropagation();
        if (!guardPlayable(lastEp)) return;
        loadEpisode(lastEp, { autoplay: true });
        navigateToEpisode(lastEp.id);
      });
      banner.addEventListener("click", () => navigateToEpisode(lastEp.id));
      viewLibrary.appendChild(banner);
    }

    const groups = new Map();
    srcModules.forEach((mod) => {
      if (!groups.has(mod.prefix)) groups.set(mod.prefix, { prefix: mod.prefix, episodes: [] });
      mod.episodes.forEach((ep) => groups.get(mod.prefix).episodes.push({ ...ep, _moduleNum: mod.moduleNum }));
    });

    // Bucket modules into Year 11 / Year 12 / Case Studies sections (see YEAR_MAP).
    const byYear = {};
    groups.forEach((group) => {
      const year = YEAR_MAP[group.prefix] || "Other";
      (byYear[year] || (byYear[year] = [])).push(group);
    });

    // An episode matches the search query by its title or its module name.
    const matches = (ep, group) =>
      !q || ep.title.toLowerCase().includes(q) ||
      (GROUP_NAMES[group.prefix] || group.prefix).toLowerCase().includes(q);

    let shown = 0;
    YEAR_ORDER.filter((y) => byYear[y]).forEach((year) => {
      // Keep only modules with at least one matching episode under the query.
      const yearGroups = byYear[year]
        .map((group) => ({ group, hits: group.episodes.filter((ep) => matches(ep, group)).length }))
        .filter((g) => g.hits > 0);
      if (!yearGroups.length) return; // no orphan year header when nothing matches

      // Papers mode is a single "Past Papers" group; its module name already says so,
      // so skip the redundant year header.
      if (!papersMode) {
        const yh = document.createElement("div");
        yh.className = "year-header";
        yh.textContent = year;
        viewLibrary.appendChild(yh);
      }
      yearGroups.sort((a, b) => Math.min(...a.group.episodes.map((e) => e._moduleNum)) - Math.min(...b.group.episodes.map((e) => e._moduleNum)));
      yearGroups.forEach(({ group }) => {
      group.episodes.sort((a, b) => (a._moduleNum - b._moduleNum) || ((a.unit || 0) - (b.unit || 0)));

      const groupEl = document.createElement("div");
      groupEl.className = "module";
      // Full episode-id set for this module, so the module download button can be
      // synced against the whole module from the store — not just the rows that
      // happen to be rendered (a search view renders only matching rows). (BUG-14)
      groupEl.dataset.epIds = JSON.stringify(group.episodes.map((e) => e.id));
      if (q || papersMode) groupEl.classList.add("open"); // auto-expand matched/paper episodes

      const completed = group.episodes.filter((e) => getEpisodeProgress(e.id).completed).length;
      const name = GROUP_NAMES[group.prefix] || group.prefix;
      const allDl = group.episodes.every((e) => isDownloaded(e.id));
      const head = document.createElement("div");
      head.className = "module-head";
      // Papers (EXAM) have no audio: no play-all / download controls, and "attempted"
      // rather than "listened" (BUG-3).
      head.innerHTML = `
        ${papersMode ? "" : `<button class="module-start" aria-label="Start ${name}">${playIcon(16)}</button>
        <button class="module-dl${allDl ? " dl-done" : ""}" aria-label="${allDl ? "Delete module download" : "Download module"}">${allDl ? checkIcon(16) : downloadIcon(16)}</button>`}
        <button class="module-toggle">
          <span class="module-name">${name}</span>
          <span class="module-meta">${papersMode ? `${group.episodes.length} paper${group.episodes.length === 1 ? "" : "s"}` : `${completed}/${group.episodes.length} listened`}</span>
          <span class="module-chev">&#8250;</span>
        </button>`;
      head.querySelector(".module-toggle").addEventListener("click", () => groupEl.classList.toggle("open"));
      head.querySelector(".module-start")?.addEventListener("click", (e) => {
        e.stopPropagation();
        startModule(group);
      });
      const mdlBtn = head.querySelector(".module-dl");
      mdlBtn?.addEventListener("click", (e) => {
        e.stopPropagation();
        handleModuleDownload(group, groupEl, mdlBtn);
      });
      groupEl.appendChild(head);

      if (!papersMode) {
        const progTrack = document.createElement("div");
        progTrack.className = "module-progress-track";
        progTrack.innerHTML = `<div class="module-progress-fill" style="width:${(completed / group.episodes.length) * 100}%"></div>`;
        groupEl.appendChild(progTrack);
      }

      const episodesEl = document.createElement("div");
      episodesEl.className = "module-episodes";
      if (group.prefix === "CASE") {
        // Case Studies: nest a collapsible sub-dropdown per module/topic
        // (ep.caseGroup), preserving the manifest's doc order within each.
        const subs = new Map();
        group.episodes.forEach((ep) => {
          if (!matches(ep, group)) return;
          const gname = ep.caseGroup || "Other";
          if (!subs.has(gname)) subs.set(gname, []);
          subs.get(gname).push(ep);
        });
        subs.forEach((eps, gname) => {
          const sub = document.createElement("div");
          sub.className = "case-subgroup" + (q ? " open" : "");
          const sdone = eps.filter((e) => getEpisodeProgress(e.id).completed).length;
          const sh = document.createElement("button");
          sh.className = "case-subhead";
          sh.innerHTML = `<span class="case-subchev">&#8250;</span><span class="case-subname">${gname}</span><span class="case-submeta">${sdone}/${eps.length}</span>`;
          sh.addEventListener("click", () => sub.classList.toggle("open"));
          sub.appendChild(sh);
          const seps = document.createElement("div");
          seps.className = "case-subeps";
          eps.forEach((ep, i) => { seps.appendChild(renderEpisodeRow(ep, i + 1)); shown++; });
          sub.appendChild(seps);
          episodesEl.appendChild(sub);
        });
        // Star key as the last row of the Case Studies dropdown.
        if (!q) {
          const key = document.createElement("div");
          key.className = "module-key";
          key.textContent = "⭐ = HSC importance — ⭐⭐⭐ most important; ⭐⭐ worth knowing; ⭐ least critical (can still appear)";
          episodesEl.appendChild(key);
        }
      } else {
        // While searching, show only matching rows but keep each episode's real position.
        group.episodes.forEach((ep, i) => {
          if (!matches(ep, group)) return;
          episodesEl.appendChild(renderEpisodeRow(ep, i + 1));
          shown++;
        });
      }
      groupEl.appendChild(episodesEl);

      viewLibrary.appendChild(groupEl);
      });
    });

    if (q && !shown) {
      const empty = document.createElement("p");
      empty.className = "load-error";
      empty.textContent = `No episodes match “${libSearchInput.value.trim()}”.`;
      viewLibrary.appendChild(empty);
    }
  }

  function renderEpisodeRow(ep, index) {
    const row = document.createElement("div");
    row.dataset.epId = ep.id;
    const progress = getEpisodeProgress(ep.id);
    const done = progress.completed;
    const dl = isDownloaded(ep.id);
    const playing = !!currentEpisode && currentEpisode.id === ep.id;
    row.className = "episode-row" + (done ? " ep-row-done" : "") + (dl ? " ep-downloaded" : "") + (playing ? " ep-row-playing" : "");
    const pct = Math.round((progress.progressPct || 0) * 100);
    const rawDur = ep.voices?.[0]?.duration;
    const durStr = rawDur ? fmtDuration(rawDur / getCurrentSpeed()) : "";
    const inQueue = queue.includes(ep.id);
    // Past papers aren't audio — no play / download / queue controls (BUG-3). The row is
    // still tappable (opens the paper); a chevron signals that.
    const isPaper = !!ep.paper;

    row.innerHTML = `
      <span class="ep-index${done ? " ep-done" : ""}">${done ? "&#10003;" : index}</span>
      <div class="ep-main">
        <div class="ep-title-row">
          <span class="ep-title">${ep.title}</span>
          ${durStr ? `<span class="ep-duration">${durStr}</span>` : ""}
        </div>
        ${pct > 0 ? `<div class="ep-progress-track"><div class="ep-progress-fill" style="width:${pct}%"></div></div>` : ""}
      </div>
      ${isPaper ? `<span class="ep-open-chev" aria-hidden="true">&#8250;</span>` : `
      <button class="ep-dl-btn${dl ? " dl-done" : ""}" aria-label="${dl ? "Delete download" : "Download"}">${dl ? checkIcon(15) : downloadIcon(15)}</button>
      <button class="ep-queue-btn${inQueue ? " in-queue" : ""}" aria-label="${inQueue ? "Remove from queue" : "Add to queue"}">${inQueue ? "&#10003;" : "+"}</button>
      <button class="ep-play" aria-label="Play ${ep.title}">${playIcon(16)}</button>`}`;

    const dlBtn = row.querySelector(".ep-dl-btn");
    dlBtn?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (dlBtn.classList.contains("dl-busy")) return;
      if (dlBtn.classList.contains("dl-done")) {
        await deleteEpisode(ep);
        setDlState(dlBtn, "idle");
        row.classList.remove("ep-downloaded");
        syncModuleDlBtn(row);
        return;
      }
      if (!(await mayDownload(estEpisodeBytes(ep)))) return;
      setDlState(dlBtn, "busy");
      try {
        await downloadEpisode(ep);
        setDlState(dlBtn, "done");
        row.classList.add("ep-downloaded");
        syncModuleDlBtn(row);
      } catch (err) {
        console.error("[download]", err);
        setDlState(dlBtn, "idle");
        showToast("Download failed — check your connection.");
      }
    });

    const qBtn = row.querySelector(".ep-queue-btn");
    qBtn?.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = queue.indexOf(ep.id);
      const adding = idx < 0;
      if (adding) queue.push(ep.id);
      else queue.splice(idx, 1);
      // Update the button in place rather than re-rendering, so the open module
      // stays open and you can keep adding episodes.
      qBtn.classList.toggle("in-queue", adding);
      qBtn.textContent = adding ? "✓" : "+";
      qBtn.setAttribute("aria-label", adding ? "Remove from queue" : "Add to queue");
      updateQueueBadge();
    });
    row.querySelector(".ep-play")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!guardPlayable(ep)) return;
      loadEpisode(ep, { autoplay: true });
      navigateToEpisode(ep.id);
    });
    row.addEventListener("click", () => navigateToEpisode(ep.id));
    return row;
  }

  // --- Routing ---
  // Routes: #/  → subject picker · #/s/<subject> → that subject's hub (Podcasts /
  //   Quizzes / Past Papers) · #/s/<subject>/podcasts|papers → that mode's library ·
  //   #/s/<subject>/quizzes → the subject-scoped review sheet over the hub ·
  //   #/episode/<subject:id> → an episode (subject inferred from its namespaced id).
  function navigateToEpisode(id) { window.location.hash = `#/episode/${encodeURIComponent(id)}`; }
  function navigateToHub() {
    window.location.hash = currentSubject ? `#/s/${encodeURIComponent(currentSubject)}` : "#/";
  }
  // Back to whichever library mode the user is browsing (papers vs podcasts).
  function navigateToLibrary() {
    if (!currentSubject) { window.location.hash = "#/"; return; }
    const mode = currentLibMode === "papers" ? "papers" : "podcasts";
    window.location.hash = `#/s/${encodeURIComponent(currentSubject)}/${mode}`;
  }
  function navigateToSubjects() { window.location.hash = "#/"; }

  function handleRoute() {
    if (!fullManifest) return; // not loaded yet; init's fetch calls handleRoute once ready
    dismissAdvanceToast(); // any navigation cancels a pending auto-advance
    const hash = window.location.hash;

    const epMatch = hash.match(/^#\/episode\/(.+)$/);
    if (epMatch) {
      const ep = findEpisode(decodeURIComponent(epMatch[1]));
      if (ep) { ensureSubject(ep._subject); showView("episode", ep); return; }
    }
    // Mode sub-routes must be tested before the bare-subject route (whose `.+` also matches them).
    // Module sub-route: #/s/<subject>/m/<CODE>
    const modMatch = hash.match(/^#\/s\/(.+)\/m\/([A-Z]{2})$/);
    if (modMatch && setSubject(decodeURIComponent(modMatch[1]))) {
      showView("module", modMatch[2]); return;
    }
    const modeMatch = hash.match(/^#\/s\/(.+)\/(podcasts|papers|quizzes|map|modules|cards)$/);
    if (modeMatch && setSubject(decodeURIComponent(modeMatch[1]))) {
      const mode = modeMatch[2];
      if (mode === "quizzes") { showView("hub"); openReview(currentSubject); return; }
      if (mode === "map") { showView("map"); return; }
      if (mode === "modules") { showView("modules"); return; }
      if (mode === "cards") { showView("cards"); return; }
      showView("library", mode); return;
    }
    const subMatch = hash.match(/^#\/s\/(.+)$/);
    if (subMatch && setSubject(decodeURIComponent(subMatch[1]))) {
      showView("hub"); return;
    }
    showView("subjects");
  }

  function showView(route, arg) {
    stopPaperTimer(); // leaving any view kills a running paper clock
    Object.entries(views).forEach(([name, el]) => { el.hidden = name !== route; });
    window.scrollTo({ top: 0, behavior: "instant" });

    if (route === "subjects") {
      setHidden(btnBack, true);
      if (libSearchWrap) setHidden(libSearchWrap, true);
      renderSubjects();
    } else if (route === "hub") {
      // Back to the subject picker (worth a tap even with one subject: the daily quiz lives there).
      setHidden(btnBack, false);
      btnBack.textContent = "← Subjects";
      if (libSearchWrap) setHidden(libSearchWrap, true);
      renderSubjectHub();
    } else if (route === "modules") {
      setHidden(btnBack, false);
      btnBack.textContent = `← ${subjShort(currentSubject)}`;
      if (libSearchWrap) setHidden(libSearchWrap, true);
      if (window.SetTextModules) window.SetTextModules.renderModuleIndex(viewModules, subjectMeta(currentSubject));
    } else if (route === "module") {
      setHidden(btnBack, false);
      btnBack.textContent = "← Modules";
      if (libSearchWrap) setHidden(libSearchWrap, true);
      if (window.SetTextModules) window.SetTextModules.renderModule(viewModule, subjectMeta(currentSubject), arg);
    } else if (route === "cards") {
      setHidden(btnBack, false);
      btnBack.textContent = "← Common Module";
      if (libSearchWrap) setHidden(libSearchWrap, true);
      if (window.PlotMap) window.PlotMap.renderCards(viewCards);
    } else if (route === "map") {
      // Plot map for a set text (English Standard). Position-tracked as a percentage
      // through the book, so it follows whatever audio the listener supplied.
      setHidden(btnBack, false);
      btnBack.textContent = `← ${subjShort(currentSubject)}`;
      if (libSearchWrap) setHidden(libSearchWrap, true);
      if (window.PlotMap) window.PlotMap.render(viewMap, audio, subjectMeta(currentSubject));
    } else if (route === "library") {
      const mode = arg === "papers" ? "papers" : "podcasts";
      setHidden(btnBack, false);
      btnBack.textContent = `← ${subjShort(currentSubject)}`;
      // Papers have no search; podcasts do.
      if (libSearchWrap) setHidden(libSearchWrap, mode === "papers");
      renderLibrary(mode);
    } else if (route === "episode") {
      const episode = arg;
      // Remember which mode this episode belongs to so Back returns to the right library.
      currentLibMode = episode.paper ? "papers" : "podcasts";
      setHidden(btnBack, false);
      btnBack.textContent = episode.paper ? "← Past Papers" : "← Podcasts";
      if (libSearchWrap) setHidden(libSearchWrap, true);
      episodeTitleEl.textContent = episode.title;
      quizState = null;
      if (episode.paper) {
        // Past papers are their own thing: no Script/References/Quiz tabs, no audio player.
        setHidden(episodeTabs, true);
        setHidden(episodeContentEl, true);
        setHidden(quizArea, false);
        renderPaperView(episode);
        return;
      }
      setHidden(episodeTabs, false);
      // Nudge toward the quiz: once an episode is finished, opening it lands on the
      // Quiz tab (active recall) instead of References. Otherwise show References.
      const finished = getEpisodeProgress(episode.id).completed;
      const tab = finished && episode.quizPath ? "quiz" : "supplementary";
      tabBtns.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
      if (tab === "quiz") {
        setHidden(episodeContentEl, true);
        setHidden(quizArea, false);
        renderQuizTab(episode);
      } else {
        setHidden(episodeContentEl, false);
        setHidden(quizArea, true);
        renderMarkdownTab(episode, "supplementary");
      }
      if (!currentEpisode || currentEpisode.id !== episode.id) {
        loadEpisode(episode, { autoplay: false });
      }
    }
  }

  // --- Markdown ---
  function copyToClipboard(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).catch(() => {});
    } else {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  // Parse markdown without letting `marked` mangle LaTeX: pull math spans out
  // first (so _, *, \ inside them survive), parse, then splice them back.
  function mathSafeParse(md) {
    const math = [];
    const protectedMd = md.replace(/\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)/g, (m) => {
      math.push(m);
      return `@@MATH${math.length - 1}@@`;
    });
    return marked.parse(protectedMd).replace(/@@MATH(\d+)@@/g, (_, i) => math[+i]);
  }

  // Render LaTeX math with KaTeX. Uses $$…$$ and \[…\] for display, \(…\) for
  // inline — deliberately NOT single $, so dollar amounts in content don't break.
  function renderMath(el) {
    if (!el || !window.renderMathInElement) return;
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"],
      });
    } catch (_) {}
  }

  // Group consecutive image-only paragraphs into a swipeable carousel. A lone image is
  // left as-is; two or more in a row become one carousel (captions from the alt text).
  function buildCarousels(root) {
    const isImgPara = (el) => el && el.tagName === "P" && el.children.length === 1 &&
      el.firstElementChild.tagName === "IMG" && !el.textContent.trim();
    const kids = [...root.children];
    let i = 0;
    while (i < kids.length) {
      if (!isImgPara(kids[i])) { i++; continue; }
      const run = [];
      while (i < kids.length && isImgPara(kids[i])) run.push(kids[i++]);
      if (run.length < 2) continue;
      const imgs = run.map((p) => p.firstElementChild);
      const car = document.createElement("div");
      car.className = "img-carousel";
      car.innerHTML = `
        <div class="carousel-track">
          ${imgs.map((im) => `<div class="carousel-slide"><img src="${im.getAttribute("src")}" alt="${im.alt || ""}">${im.alt ? `<div class="carousel-cap">${im.alt}</div>` : ""}</div>`).join("")}
        </div>
        <button class="carousel-arrow carousel-prev" aria-label="Previous">‹</button>
        <button class="carousel-arrow carousel-next" aria-label="Next">›</button>
        <div class="carousel-dots">${imgs.map((_, k) => `<span class="carousel-dot${k === 0 ? " active" : ""}"></span>`).join("")}</div>`;
      run[0].replaceWith(car);
      run.slice(1).forEach((p) => p.remove());
      const track = car.querySelector(".carousel-track");
      const dots = [...car.querySelectorAll(".carousel-dot")];
      const slideTo = (k) => track.scrollTo({ left: track.clientWidth * k, behavior: "smooth" });
      const current = () => Math.round(track.scrollLeft / track.clientWidth);
      track.addEventListener("scroll", () => {
        const k = current();
        dots.forEach((d, j) => d.classList.toggle("active", j === k));
      }, { passive: true });
      car.querySelector(".carousel-prev").addEventListener("click", () => slideTo(Math.max(0, current() - 1)));
      car.querySelector(".carousel-next").addEventListener("click", () => slideTo(Math.min(imgs.length - 1, current() + 1)));
      dots.forEach((d, k) => d.addEventListener("click", () => slideTo(k)));
    }
  }

  function enhanceCodeBlocks() {
    episodeContentEl.querySelectorAll("pre").forEach((pre) => {
      const code = pre.querySelector("code");
      if (!code) return;
      if (window.hljs) hljs.highlightElement(code);
      if (pre.querySelector(".copy-btn")) return;
      const btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.textContent = "Copy";
      btn.addEventListener("click", () => {
        copyToClipboard(code.textContent);
        btn.textContent = "Copied!";
        btn.classList.add("copied");
        setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 2000);
      });
      pre.appendChild(btn);
    });
  }

  async function renderMarkdownTab(ep, tab) {
    const path = tab === "script" ? ep.scriptPath : ep.supplementaryPath;
    if (!path) { episodeContentEl.innerHTML = "<p><em>Not available.</em></p>"; return; }
    episodeContentEl.innerHTML = "<p><em>Loading…</em></p>";
    try {
      const res = await fetch(path);
      const text = await res.text();
      const stripped = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
      episodeContentEl.innerHTML = mathSafeParse(stripped);
      enhanceCodeBlocks();
      buildCarousels(episodeContentEl);
      renderMath(episodeContentEl);
      if (tab === "script") buildTranscriptSync(); else { syncParas = null; syncActiveEl = null; }
      updateJumpCurrentBtn();
      window.scrollTo({ top: 0, behavior: "instant" });
    } catch {
      syncParas = null;
      episodeContentEl.innerHTML = navigator.onLine
        ? "<p><em>Failed to load.</em></p>"
        : "<p><em>Not available offline — download this episode to read it here.</em></p>";
    }
  }

  // --- Transcript sync (Option 1: estimate each paragraph's time from its word
  // count, proportional to the audio length). Highlight + auto-scroll the current
  // paragraph; tap a paragraph to seek there. Approximate (drifts a few seconds).
  function buildTranscriptSync() {
    syncParas = null; syncActiveEl = null;
    const els = [...episodeContentEl.querySelectorAll("p")].filter((el) => el.textContent.trim());
    if (!els.length) return;
    const counts = els.map((el) => Math.max(1, el.textContent.trim().split(/\s+/).length));
    const totalWords = counts.reduce((a, b) => a + b, 0);
    let acc = 0;
    syncParas = els.map((el, i) => {
      const startFrac = acc / totalWords;
      acc += counts[i];
      const endFrac = acc / totalWords;
      el.classList.add("sync-para");
      el.addEventListener("click", () => {
        if (!audio.duration) return;
        audio.currentTime = startFrac * audio.duration;
        if (audio.paused) audio.play();
      });
      return { el, startFrac, endFrac };
    });
    updateTranscriptHighlight();
  }

  function updateTranscriptHighlight() {
    if (!syncParas || episodeContentEl.hidden || !audio.duration) return;
    const frac = audio.currentTime / audio.duration;
    let active = syncParas.find((p) => frac >= p.startFrac && frac < p.endFrac) || syncParas[syncParas.length - 1];
    if (!active || active.el === syncActiveEl) { updateJumpCurrentBtn(); return; }
    if (syncActiveEl) syncActiveEl.classList.remove("para-active");
    active.el.classList.add("para-active");
    syncActiveEl = active.el;
    // Auto-scroll to follow along, but throttled so rapid paragraph changes (e.g. at high
    // playback speed) can't make the page jitter around. Only scroll when off-screen.
    const now = performance.now();
    if (now - lastSyncScroll < 1500) { updateJumpCurrentBtn(); return; }
    const r = active.el.getBoundingClientRect();
    if (r.top < 130 || r.bottom > window.innerHeight - 40) {
      lastSyncScroll = now;
      active.el.scrollIntoView({ block: "center", behavior: "smooth" });
    }
    updateJumpCurrentBtn();
  }

  // --- "Jump to where the audio is playing" button ---
  // Auto-scroll follows along, but if the reader scrolls away (or auto-scroll is throttled
  // at high speed) this floating button re-centres on the currently-playing paragraph.
  const btnJumpCurrent = document.getElementById("btn-jump-current");
  function jumpTargetOffscreen() {
    if (!syncActiveEl) return false;
    const r = syncActiveEl.getBoundingClientRect();
    return r.bottom < 120 || r.top > window.innerHeight - 40;
  }
  function updateJumpCurrentBtn() {
    if (!btnJumpCurrent) return;
    const onScript = syncParas && !episodeContentEl.hidden && !viewEpisode.hidden;
    setHidden(btnJumpCurrent, !(onScript && syncActiveEl && jumpTargetOffscreen()));
  }
  if (btnJumpCurrent) btnJumpCurrent.addEventListener("click", () => {
    if (!syncActiveEl) return;
    lastSyncScroll = performance.now(); // don't let auto-scroll fight this manual jump
    syncActiveEl.scrollIntoView({ block: "center", behavior: "smooth" });
    setHidden(btnJumpCurrent, true);
  });
  let jumpScrollRaf = 0;
  window.addEventListener("scroll", () => {
    if (jumpScrollRaf) return;
    jumpScrollRaf = requestAnimationFrame(() => { jumpScrollRaf = 0; updateJumpCurrentBtn(); });
  }, { passive: true });

  // === QUIZ ===
  const QUIZ_SR_KEY = "podcast-quiz-sr";
  let quizState = null;

  function loadSR() {
    try { return JSON.parse(localStorage.getItem(QUIZ_SR_KEY)) || {}; } catch { return {}; }
  }
  function saveSR(all) { localStorage.setItem(QUIZ_SR_KEY, JSON.stringify(all)); }
  function srKey(ep, q) { return `${ep.id}::${q.id}`; }

  // --- Spaced repetition: FSRS (Anki's modern engine, via vendored ts-fsrs) ---
  // Grades map to FSRS ratings: 1 = Again · 2 = Hard · 3 = Good · 4 = Easy.
  const FSRS_SETTINGS_KEY = "podcast-fsrs-settings";
  function fsrsSettings() {
    const def = { retention: 0.9, steps: "1m 10m" };
    try { return { ...def, ...(JSON.parse(localStorage.getItem(FSRS_SETTINGS_KEY)) || {}) }; }
    catch { return def; }
  }
  let _fsrs = null, _fsrsKey = "";
  function fsrsEngine() {
    const s = fsrsSettings();
    const key = JSON.stringify(s);
    if (_fsrs && _fsrsKey === key) return _fsrs;
    const steps = (s.steps || "").trim().split(/\s+/).filter(Boolean);
    _fsrs = window.FSRS.fsrs(window.FSRS.generatorParameters({
      request_retention: s.retention,
      learning_steps: steps.length ? steps : ["1m", "10m"],
      enable_fuzz: true,
    }));
    _fsrsKey = key;
    return _fsrs;
  }
  // Stored cards keep FSRS state plus correct/total (for accuracy + sync merge). Dates are
  // stored as ISO strings; revive them (and migrate old SM-2 cards) into a real FSRS card.
  function reviveCard(raw) {
    if (!raw || raw.stability === undefined) return window.FSRS.createEmptyCard(new Date());
    return { ...raw, due: new Date(raw.due), last_review: raw.last_review ? new Date(raw.last_review) : undefined };
  }
  function getCard(ep, q) {
    const raw = loadSR()[srKey(ep, q)];
    const card = reviveCard(raw);
    card.correct = (raw && raw.correct) || 0;
    card.total = (raw && raw.total) || 0;
    return card;
  }
  // Days from now until a given grade's next due date — drives the button previews.
  function previewDays(card, grade) {
    if (!window.FSRS) return grade;
    const rec = fsrsEngine().repeat(card, new Date());
    return (new Date(rec[grade].card.due).getTime() - Date.now()) / 86400000;
  }
  // Apply a grade and persist. mcCorrect feeds the accuracy stat separately.
  function gradeCard(ep, q, grade, mcCorrect) {
    const all = loadSR();
    const k = srKey(ep, q);
    const prev = all[k];
    const bump = { correct: ((prev && prev.correct) || 0) + (mcCorrect ? 1 : 0), total: ((prev && prev.total) || 0) + 1 };
    if (!window.FSRS) {
      all[k] = { ...(prev || {}), ...bump, due: new Date(Date.now() + 86400000).toISOString() };
    } else {
      const { card: next } = fsrsEngine().next(reviveCard(prev), new Date(), grade);
      all[k] = {
        ...next, ...bump,
        due: new Date(next.due).toISOString(),
        last_review: next.last_review ? new Date(next.last_review).toISOString() : new Date().toISOString(),
      };
    }
    saveSR(all);
    window.Sync && window.Sync.scheduleSync();
  }

  // Human-readable interval, Anki-style: 10m / 3d / 2.1mo / 1.4y.
  function fmtInterval(d) {
    if (d < 1) return `${Math.max(1, Math.round(d * 1440))}m`;
    if (d < 30) return `${Math.round(d)}d`;
    if (d < 365) { const m = d / 30; return `${m < 10 ? m.toFixed(1).replace(/\.0$/, "") : Math.round(m)}mo`; }
    return `${(d / 365).toFixed(1).replace(/\.0$/, "")}y`;
  }

  function isDue(ep, q) {
    const raw = loadSR()[srKey(ep, q)];
    if (!raw || !raw.total) return true; // new / never seen
    return new Date(raw.due) <= new Date();
  }

  async function renderQuizTab(ep) {
    quizArea.innerHTML = "";
    if (!ep.quizPath) {
      quizArea.innerHTML = `<div class="quiz-empty"><p>No quiz yet for this episode.</p></div>`;
      return;
    }
    quizArea.innerHTML = `<div class="quiz-empty"><p>Loading…</p></div>`;
    try {
      const data = await fetch(ep.quizPath).then((r) => r.json());
      data.questions.forEach((q) => { q._ep = ep; }); // tag each question with its episode
      // Past papers render in their own dedicated view (renderPaperView), never this tab.
      quizState = { ep, allQuestions: data.questions, items: [], questions: [], current: 0, score: 0,
                    answered: false, mode: null, missed: [], container: quizArea, onExit: renderQuizPicker };
      renderQuizPicker();
    } catch {
      quizArea.innerHTML = `<div class="quiz-empty"><p>Failed to load quiz.</p></div>`;
    }
  }

  // Bucket a question for the type filter (short+extended collapse to "written").
  function qTypeBucket(q) {
    return q.type === "short" || q.type === "extended" ? "written" : (q.type || "mc");
  }
  function qOrigin(q) {
    const s = q && q.source;
    return s && typeof s === "object" ? s.origin : null;
  }
  // Does a question pass the picker's current type + origin filters?
  function quizFilterMatch(q) {
    const t = quizState.filterType || "all";
    const o = quizState.filterOrigin || "all";
    return (t === "all" || qTypeBucket(q) === t) && (o === "all" || qOrigin(q) === o);
  }

  function renderQuizPicker() {
    const { ep, allQuestions } = quizState;
    if (!quizState.filterType) quizState.filterType = "all";
    if (!quizState.filterOrigin) quizState.filterOrigin = "all";
    const sr = loadSR();
    const totalAttempts = allQuestions.reduce((n, q) => n + (sr[srKey(ep, q)]?.total || 0), 0);
    const totalCorrect = allQuestions.reduce((n, q) => n + (sr[srKey(ep, q)]?.correct || 0), 0);
    const pct = totalAttempts ? Math.round((totalCorrect / totalAttempts) * 100) : null;

    // Build chip rows only for facets that actually vary in this quiz.
    const typeLabels = { mc: "Multiple choice", recall: "Active recall", worked: "Worked", written: "Written" };
    const typeCounts = {};
    allQuestions.forEach((q) => { const b = qTypeBucket(q); typeCounts[b] = (typeCounts[b] || 0) + 1; });
    const originCounts = {};
    allQuestions.forEach((q) => { const o = qOrigin(q); if (o) originCounts[o] = (originCounts[o] || 0) + 1; });

    const chip = (group, val, label, count) =>
      `<button class="filter-chip${(quizState["filter" + group] || "all") === val ? " sel" : ""}" data-group="${group}" data-val="${val}">${label}${count != null ? ` <span class="chip-n">${count}</span>` : ""}</button>`;

    const typeRow = Object.keys(typeCounts).length > 1
      ? `<div class="filter-row"><span class="filter-label">Type</span><div class="filter-chips">
           ${chip("Type", "all", "All")}
           ${["mc", "recall", "worked", "written"].filter((t) => typeCounts[t]).map((t) => chip("Type", t, typeLabels[t], typeCounts[t])).join("")}
         </div></div>`
      : "";
    const originRow = Object.keys(originCounts).length > 1
      ? `<div class="filter-row"><span class="filter-label">Source</span><div class="filter-chips">
           ${chip("Origin", "all", "All")}
           ${["hsc", "trial", "textbook", "ai"].filter((o) => originCounts[o]).map((o) => chip("Origin", o, (ORIGIN_META[o] || {}).label || o, originCounts[o])).join("")}
         </div></div>`
      : "";

    const pool = allQuestions.filter(quizFilterMatch);

    quizArea.innerHTML = `
      <div class="quiz-picker">
        <div class="recall-prompt">
          <div class="recall-title">After listening — active recall</div>
          <ol class="recall-list">
            <li>Jot down the 3 main ideas from memory.</li>
            <li>Explain the key concept out loud in your own words.</li>
            <li>Then test yourself below — without looking at the notes.</li>
          </ol>
        </div>
        <div class="quiz-picker-stats">
          <span class="qps-count">${allQuestions.length} questions</span>
          ${pct !== null ? `<span class="qps-score">${pct}% accuracy</span>` : ""}
        </div>
        ${typeRow || originRow ? `<div class="quiz-filters">${typeRow}${originRow}</div>` : ""}
        <div class="quiz-modes">
          <button class="quiz-mode-btn" id="btn-quiz-practice"${pool.length ? "" : " disabled"}>
            <div class="qmb-icon">📝</div>
            <div class="qmb-title">Practice</div>
            <div class="qmb-desc">${pool.length} question${pool.length === 1 ? "" : "s"}, shuffled</div>
          </button>
        </div>
      </div>`;

    quizArea.querySelectorAll(".filter-chip").forEach((btn) =>
      btn.addEventListener("click", () => {
        quizState["filter" + btn.dataset.group] = btn.dataset.val;
        renderQuizPicker();
      }));
    document.getElementById("btn-quiz-practice").addEventListener("click", () => startQuiz("practice"));
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startQuiz(mode) {
    const { ep, allQuestions } = quizState;
    const base = allQuestions.filter(quizFilterMatch); // honour the picker's type/source chips
    const items = mode === "review" ? base.filter((q) => isDue(ep, q)) : [...base];
    beginSession(items, mode);
  }

  // Run a quiz session over a fixed pool of questions (each tagged with q._ep). Used by
  // the per-episode quiz and the cross-subject Mix quiz alike.
  function beginSession(items, mode) {
    quizState.items = items;
    // Papers are sequential (exam order); every other mode shuffles.
    quizState.questions = mode === "paper" ? [...items] : shuffle(items);
    quizState.current = 0;
    quizState.score = 0;
    quizState.answered = false;
    quizState.mode = mode;
    quizState.missed = [];
    quizState.answers = [];
    if (mode === "paper") startPaperTimer();
    renderQuestion();
  }

  // --- Provenance / traceability (shared across every question type) ---
  // Each question carries source = { origin, ref, year?, page?, url? } (see QUIZ_STYLE_GUIDE).
  // Legacy quizzes used a plain string `source` + `sourceUrl`; both are handled here.
  const ORIGIN_META = {
    hsc:      { label: "HSC",          cls: "src-hsc" },
    trial:    { label: "Trial",        cls: "src-trial" },
    textbook: { label: "Textbook",     cls: "src-textbook" },
    ai:       { label: "AI-generated", cls: "src-ai" },
  };
  // Small pill shown on the question itself (so AI items are always labelled up front).
  function sourceBadgeHtml(q) {
    const s = q && q.source;
    if (!s || typeof s === "string" || !s.origin) return "";
    const m = ORIGIN_META[s.origin] || { label: s.origin, cls: "src-other" };
    return `<span class="src-badge ${m.cls}">${m.label}</span>`;
  }
  // Which subject a quiz question belongs to (id from the tag, the episode, or the
  // namespaced "<subject>:<id>" episode id), as a header chip. Empty if unknown.
  function quizSubjectHtml(q) {
    const ep = q && q._ep;
    const id = (q && q._subject) || (ep && ep._subject) ||
      (ep && typeof ep.id === "string" && ep.id.includes(":") ? ep.id.split(":")[0] : null);
    return id ? `<span class="quiz-subject">${subjShort(id)}</span>` : "";
  }
  // Full provenance line + "View source ↗" link, shown in the answer/reveal panel.
  function sourceLineHtml(q) {
    const s = q && q.source;
    if (!s) return "";
    if (typeof s === "string") { // legacy string form
      return `<p class="feedback-source">Source: ${
        q.sourceUrl ? `<a class="paper-dl-link" href="${q.sourceUrl}" download>${s} — ⬇ download paper</a>` : s
      }</p>`;
    }
    if (!s.origin) return "";
    const m = ORIGIN_META[s.origin] || { label: s.origin };
    const ref = [s.ref, s.page ? `p.${s.page}` : ""].filter(Boolean).join(", ");
    const link = s.url
      ? ` · <a class="src-link" href="${s.url}" target="_blank" rel="noopener noreferrer">View source ↗</a>`
      : "";
    const note = s.origin === "ai" ? " — AI-generated, verify against your syllabus" : "";
    return `<p class="feedback-source">Source: ${m.label}${ref ? " — " + ref : ""}${note}${link}</p>`;
  }

  // Render the FSRS self-grade buttons (Again/Hard/Good/Easy) into `gradesEl`, then advance on
  // click. mcCorrect: true/false for objective questions; null → infer from grade (≥ Good = correct).
  function attachFsrsGrades(gradesEl, ep, q, mcCorrect) {
    const card = getCard(ep, q);
    const grades = [
      { g: 1, label: "Again", cls: "g-again" },
      { g: 2, label: "Hard", cls: "g-hard" },
      { g: 3, label: "Good", cls: "g-good" },
      { g: 4, label: "Easy", cls: "g-easy" },
    ];
    gradesEl.innerHTML = grades.map((x) =>
      `<button class="grade-btn ${x.cls}" data-g="${x.g}"><span class="grade-iv">${fmtInterval(previewDays(card, x.g))}</span><span class="grade-lbl">${x.label}</span></button>`
    ).join("");
    gradesEl.querySelectorAll(".grade-btn").forEach((btn) =>
      btn.addEventListener("click", () => {
        const g = parseInt(btn.dataset.g, 10);
        const corr = mcCorrect == null ? g >= 3 : mcCorrect;
        gradeCard(ep, q, g, corr);
        updateReviewBadge();
        advanceQuiz();
      })
    );
  }

  function renderQuestion() {
    const { questions, current } = quizState;
    const c = quizState.container;
    const q = questions[current];
    // Type-aware renderers (MC falls through to the default renderer below).
    if (q.type === "short" || q.type === "extended") return renderWrittenQuestion();
    if (q.type === "recall") return renderRecallQuestion();
    if (q.type === "worked") return renderWorkedQuestion();
    const total = questions.length;

    c.innerHTML = `
      <div class="quiz-session">
        <div class="quiz-header">
          <button class="quiz-exit-btn" id="btn-quiz-exit">✕ Exit</button>
          ${quizSubjectHtml(q)}
          ${quizState.isPaper && quizState.timerMode !== "off" ? `<span class="paper-timer" id="paper-timer"></span>` : ""}
          <span class="quiz-progress-text">${current + 1} / ${total}</span>
        </div>
        <div class="quiz-progress-track">
          <div class="quiz-progress-fill" style="width:${Math.round(((current + 1) / total) * 100)}%"></div>
        </div>
        <div class="quiz-question-wrap">
          ${quizState.mode === "mix" && q._ep ? `<div class="quiz-source">${q._ep.title}</div>` : ""}
          ${sourceBadgeHtml(q) ? `<div class="quiz-badges">${sourceBadgeHtml(q)}</div>` : ""}
          ${q.image ? `<img class="quiz-stimulus" src="${q.image}" alt="">` : ""}
          <p class="quiz-q-text">${q.q}</p>
          <div class="quiz-options">
            ${(q.options || []).map((opt, i) => `<button class="quiz-option" data-index="${i}">${opt}</button>`).join("")}
          </div>
          <div class="quiz-feedback" id="quiz-feedback" hidden>
            <div class="quiz-feedback-inner" id="quiz-feedback-inner"></div>
            <div class="quiz-grades" id="quiz-grades"></div>
          </div>
        </div>
      </div>`;

    c.querySelector("#btn-quiz-exit").addEventListener("click", () => {
      quizState.mode = null;
      (quizState.onExit || renderQuizPicker)();
    });
    c.querySelectorAll(".quiz-option").forEach((btn) => {
      btn.addEventListener("click", () => handleAnswer(parseInt(btn.dataset.index, 10)));
    });
    if (quizState.isPaper) onQuestionShown(q);
    renderMath(c); // render math in the question + options
  }

  function handleAnswer(chosen) {
    if (quizState.answered) return;
    quizState.answered = true;

    const { questions, current } = quizState;
    const c = quizState.container;
    const q = questions[current];
    const ep = q._ep || quizState.ep;
    const correct = chosen === q.answer;
    track("quiz_answer", { correct, subject: currentSubject, paper: !!quizState.isPaper });

    if (correct) quizState.score++;
    else quizState.missed.push(q);
    quizState.answers[current] = { q, chosen, correct };

    // Past papers: simple right/wrong (no FSRS). Record it, then either advance silently
    // (mark-at-end) or show the answer + a Next button (mark-as-you-go).
    if (quizState.isPaper) {
      recordPaperAnswer(ep, q, correct);
      maybeCompletePaper(ep);
      if (quizState.markMode === "atend") { advanceQuiz(); return; }
      return showPaperFeedback(c, chosen, correct, q);
    }

    c.querySelectorAll(".quiz-option").forEach((btn, i) => {
      btn.disabled = true;
      if (i === q.answer) btn.classList.add("opt-correct");
      else if (i === chosen) btn.classList.add("opt-wrong");
      else btn.classList.add("opt-dim");
    });

    const inner = c.querySelector("#quiz-feedback-inner");
    inner.innerHTML = `
      <div class="feedback-verdict ${correct ? "verdict-correct" : "verdict-wrong"}">
        ${correct ? "✓ Correct" : "✗ Incorrect"}
      </div>
      ${q.explanation ? `<p class="feedback-explanation">${q.explanation}</p>` : ""}
      ${sourceLineHtml(q)}
      <p class="grade-prompt">How well did you know it?</p>`;
    renderMath(inner); // render math in the explanation

    // Anki-style self-grade: Again / Hard / Good / Easy, each showing its next interval.
    const card = getCard(ep, q);
    const grades = [
      { g: 1, label: "Again", cls: "g-again" },
      { g: 2, label: "Hard", cls: "g-hard" },
      { g: 3, label: "Good", cls: "g-good" },
      { g: 4, label: "Easy", cls: "g-easy" },
    ];
    const gradesEl = c.querySelector("#quiz-grades");
    gradesEl.innerHTML = grades.map((x) =>
      `<button class="grade-btn ${x.cls}" data-g="${x.g}"><span class="grade-iv">${fmtInterval(previewDays(card, x.g))}</span><span class="grade-lbl">${x.label}</span></button>`
    ).join("");
    gradesEl.querySelectorAll(".grade-btn").forEach((btn) =>
      btn.addEventListener("click", () => {
        gradeCard(ep, q, parseInt(btn.dataset.g, 10), correct);
        updateReviewBadge();
        maybeCompletePaper(ep);
        advanceQuiz();
      })
    );
    setHidden(c.querySelector("#quiz-feedback"), false);
  }

  function advanceQuiz() {
    if (quizState.current + 1 >= quizState.questions.length) {
      renderQuizSummary();
    } else {
      quizState.current++;
      quizState.answered = false;
      renderQuestion();
    }
  }

  function renderQuizSummary() {
    if (quizState.isPaper) return renderPaperResults();
    const { score, questions, missed } = quizState;
    const c = quizState.container;
    const total = questions.length;
    const pct = Math.round((score / total) * 100);
    const emoji = pct >= 80 ? "🏆" : pct >= 60 ? "👍" : "📚";
    const backLabel = quizState.onExit && quizState.onExit !== renderQuizPicker ? "← Back to review" : "← Back to quiz menu";

    c.innerHTML = `
      <div class="quiz-summary">
        <div class="quiz-summary-score">
          <div class="summary-emoji">${emoji}</div>
          <div class="summary-fraction">${score}/${total}</div>
          <div class="summary-pct">${pct}% correct</div>
        </div>
        <div class="quiz-summary-actions">
          <button class="quiz-action-btn" id="btn-quiz-again">Do these again</button>
          ${missed.length > 0
            ? `<button class="quiz-action-btn quiz-action-secondary" id="btn-quiz-missed">Retry ${missed.length} missed</button>`
            : ""}
          <button class="quiz-action-btn quiz-action-ghost" id="btn-quiz-back">${backLabel}</button>
        </div>
      </div>`;

    c.querySelector("#btn-quiz-again").addEventListener("click", () => beginSession(quizState.items, quizState.mode));
    c.querySelector("#btn-quiz-missed")?.addEventListener("click", () => beginSession(quizState.missed, quizState.mode));
    c.querySelector("#btn-quiz-back").addEventListener("click", () => {
      quizState.mode = null;
      (quizState.onExit || renderQuizPicker)();
    });
  }

  // === PAST PAPERS (own view, simple right/wrong tracking, NOT FSRS) ===
  // Paper progress is deliberately separate from the FSRS spaced-rep store: papers are sat
  // like mock exams, not flashcards. We record attempted + correct/incorrect (MC) or a
  // self-mark (written). Wrong MCs can be pushed INTO FSRS later via the results-screen bridge.
  const PAPER_KEY = "podcast-paper";
  function loadPaper() { try { return JSON.parse(localStorage.getItem(PAPER_KEY)) || {}; } catch { return {}; } }
  function savePaper(all) { localStorage.setItem(PAPER_KEY, JSON.stringify(all)); }
  function paperState(ep, q) { return loadPaper()[srKey(ep, q)] || null; }
  function recordPaperAnswer(ep, q, correct) {
    const all = loadPaper(); const k = srKey(ep, q); const prev = all[k] || {};
    all[k] = { ...prev, type: q.type || "mc", attempted: true, total: (prev.total || 0) + 1, correct: !!correct };
    savePaper(all);
  }
  function recordPaperMark(ep, q, awarded) {
    const all = loadPaper(); const k = srKey(ep, q); const prev = all[k] || {};
    all[k] = { ...prev, type: q.type, attempted: true, total: (prev.total || 0) + 1,
               mark: awarded, outOf: q.marks, correct: q.marks ? awarded / q.marks >= 0.5 : null };
    savePaper(all);
  }

  // --- Paper timer (exam-style clock). Counts up; counts DOWN when "Timed" is on. ---
  function fmtClock(ms) {
    const neg = ms < 0; const s = Math.floor(Math.abs(ms) / 1000);
    return `${neg ? "-" : ""}${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }
  function fmtMins(min) {
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h}h ${m ? m + "m" : ""}`.trim() : `${m}m`;
  }
  // Timer modes: "off" · "perq" (each question = marks × minPerMark) · "section" (a countdown
  // per exam section) · "full" (one countdown of totalMin across the session). Values overridable.
  function startPaperTimer() {
    stopPaperTimer();
    quizState.sessionStart = Date.now();
    quizState.qStart = quizState.secStart = Date.now();
    quizState.curSection = null;
    if (quizState.timerMode !== "off") quizState.timerInterval = setInterval(updatePaperTimer, 1000);
  }
  // Called when a new question is shown: (re)start the per-question / per-section clock.
  function onQuestionShown(q) {
    if (!quizState || !quizState.isPaper) return;
    if (quizState.timerMode === "perq") {
      quizState.qStart = Date.now();
      quizState.qTarget = Math.max(0.5, (q.marks || 1) * (quizState.minPerMark || 1)) * 60000;
    } else if (quizState.timerMode === "section") {
      const sec = q.section || "?";
      if (sec !== quizState.curSection) {
        quizState.curSection = sec;
        quizState.secStart = Date.now();
        quizState.secTarget = (((quizState.sectionMin || {})[sec]) || 20) * 60000;
      }
    }
    updatePaperTimer();
  }
  function updatePaperTimer() {
    const el = quizState && quizState.container && quizState.container.querySelector("#paper-timer");
    if (!el || quizState.timerMode === "off") return;
    let remaining;
    if (quizState.timerMode === "perq") remaining = (quizState.qTarget || 0) - (Date.now() - quizState.qStart);
    else if (quizState.timerMode === "section") remaining = (quizState.secTarget || 0) - (Date.now() - quizState.secStart);
    else remaining = (quizState.totalMin || 0) * 60000 - (Date.now() - quizState.sessionStart);
    el.textContent = `⏱ ${fmtClock(remaining)}`;
    el.classList.toggle("timer-over", remaining < 0);
  }
  function stopPaperTimer() {
    if (quizState && quizState.timerInterval) { clearInterval(quizState.timerInterval); quizState.timerInterval = null; }
  }

  // Locally-saved written-answer drafts, keyed like SR cards (subject:epId::qId).
  const WRITTEN_KEY = "podcast-written";
  function loadWritten() { try { return JSON.parse(localStorage.getItem(WRITTEN_KEY)) || {}; } catch { return {}; } }
  function loadWrittenDraft(ep, q) { return loadWritten()[srKey(ep, q)] || ""; }
  function saveWrittenDraft(ep, q, text) {
    const all = loadWritten(); all[srKey(ep, q)] = text;
    localStorage.setItem(WRITTEN_KEY, JSON.stringify(all));
  }

  // MC paper feedback: highlight the answer + explanation, then a Next button (no FSRS grades).
  function showPaperFeedback(c, chosen, correct, q) {
    c.querySelectorAll(".quiz-option").forEach((btn, i) => {
      btn.disabled = true;
      if (i === q.answer) btn.classList.add("opt-correct");
      else if (i === chosen) btn.classList.add("opt-wrong");
      else btn.classList.add("opt-dim");
    });
    const inner = c.querySelector("#quiz-feedback-inner");
    inner.innerHTML = `
      <div class="feedback-verdict ${correct ? "verdict-correct" : "verdict-wrong"}">${correct ? "✓ Correct" : "✗ Incorrect"}</div>
      ${q.explanation ? `<p class="feedback-explanation">${q.explanation}</p>` : ""}
      <p class="feedback-source">Answer from the official NESA marking guidelines · explanation written by AI — verify if unsure.</p>`;
    renderMath(inner);
    const last = quizState.current + 1 >= quizState.questions.length;
    const grades = c.querySelector("#quiz-grades");
    grades.innerHTML = `<button class="paper-next-btn" id="btn-paper-next">${last ? "Finish paper" : "Next question"} →</button>`;
    grades.querySelector("#btn-paper-next").addEventListener("click", advanceQuiz);
    setHidden(c.querySelector("#quiz-feedback"), false);
  }

  // Entry point for a past paper (its own dedicated view, not the episode quiz tab).
  async function renderPaperView(ep) {
    quizArea.innerHTML = `<div class="quiz-empty"><p>Loading paper…</p></div>`;
    try {
      const data = await fetch(ep.quizPath).then((r) => r.json());
      data.questions.forEach((q) => { q._ep = ep; });
      const t = data.time || {};
      quizState = { ep, allQuestions: data.questions, items: [], questions: [], current: 0, score: 0,
                    answered: false, mode: null, missed: [], container: quizArea,
                    onExit: renderPaperConfig, isPaper: true, markMode: "asyougo",
                    sectionFilter: "all", answers: [], time: data.time || null,
                    timerMode: "off", minPerMark: 2, totalMin: t.working || 60,
                    sectionMin: t.sections || null, timerInterval: null };
      renderPaperConfig();
    } catch {
      quizArea.innerHTML = `<div class="quiz-empty"><p>Couldn't load this paper.</p></div>`;
    }
  }

  // The paper's config / launch screen: pick marking mode + which sections, then start.
  function renderPaperConfig() {
    stopPaperTimer();
    const { ep, allQuestions } = quizState;
    const paper = loadPaper();
    const time = quizState.time;
    const mc = allQuestions.filter((q) => q.type === "mc");
    const written = allQuestions.filter((q) => q.type !== "mc");
    const totalMarks = allQuestions.reduce((n, q) => n + (q.marks || 0), 0);
    const doneCount = allQuestions.filter((q) => paper[srKey(ep, q)]?.attempted).length;
    const filter = quizState.sectionFilter || "all";
    const inFilter = (q) => filter === "all" ? true : filter === "mc" ? q.type === "mc" : q.type !== "mc";
    const selected = allQuestions.filter(inFilter);
    const selMarks = selected.reduce((n, q) => n + (q.marks || 0), 0);
    const typeLabel = (t) => t === "mc" ? "MC" : t === "extended" ? "Ext" : "Short";
    const rows = allQuestions.map((q, i) => {
      const st = paper[srKey(ep, q)];
      const cls = !st || !st.attempted ? "new" : st.correct === false ? "wrong" : "done";
      const tick = cls === "done" ? "✓" : cls === "wrong" ? "✗" : "";
      return `<li class="paper-qrow${inFilter(q) ? "" : " pq-off"}" data-i="${i}">
          <span class="pq-tick pq-${cls}">${tick}</span>
          <span class="pq-no">Q${q.qNo || i + 1}</span>
          <span class="pq-type pq-${q.type || "mc"}">${typeLabel(q.type)}</span>
          <span class="pq-marks">${q.marks || 1} mark${(q.marks || 1) === 1 ? "" : "s"}</span>
        </li>`;
    }).join("");
    quizArea.innerHTML = `
      <div class="paper-view">
        <div class="paper-hero">
          <div class="paper-hero-marks">${totalMarks}<span>marks</span></div>
          <div class="paper-hero-meta">
            <div>${allQuestions.length} questions · ${doneCount}/${allQuestions.length} attempted</div>
            <div class="paper-hero-sections">
              <span><b>${mc.length}</b> multiple choice</span>
              <span><b>${written.length}</b> written</span>
              ${time && time.working ? `<span>⏱ <b>${fmtMins(time.working)}</b> working time</span>` : ""}
            </div>
          </div>
        </div>

        ${ep.pdfPath || ep.mgPdfPath ? `<div class="paper-downloads">
          ${ep.pdfPath ? `<a class="paper-pdf-link" href="${ep.pdfPath}" target="_blank" rel="noopener" download="${ep.title} — exam paper.pdf">⬇ Exam paper (PDF)</a>` : ""}
          ${ep.mgPdfPath ? `<a class="paper-pdf-link" href="${ep.mgPdfPath}" target="_blank" rel="noopener" download="${ep.title} — marking guidelines.pdf">⬇ Marking guidelines (PDF)</a>` : ""}
        </div>` : ""}

        <div class="paper-config">
          <div class="pc-row">
            <span class="pc-label">Marking</span>
            <div class="seg" id="cfg-mark">
              <button class="seg-btn${quizState.markMode === "asyougo" ? " sel" : ""}" data-mark="asyougo">As I go</button>
              <button class="seg-btn${quizState.markMode === "atend" ? " sel" : ""}" data-mark="atend">At the end</button>
            </div>
          </div>
          <div class="pc-row">
            <span class="pc-label">Timer</span>
            <div class="seg" id="cfg-timer">
              <button class="seg-btn${quizState.timerMode === "off" ? " sel" : ""}" data-tm="off">Off</button>
              <button class="seg-btn${quizState.timerMode === "perq" ? " sel" : ""}" data-tm="perq">Per question</button>
              ${quizState.sectionMin ? `<button class="seg-btn${quizState.timerMode === "section" ? " sel" : ""}" data-tm="section">Per section</button>` : ""}
              <button class="seg-btn${quizState.timerMode === "full" ? " sel" : ""}" data-tm="full">Whole paper</button>
            </div>
          </div>
          ${quizState.timerMode === "perq" ? `<div class="pc-row">
            <span class="pc-label">Per mark</span>
            <span class="pc-num"><input type="number" id="cfg-minpermark" min="0.5" step="0.5" value="${quizState.minPerMark}"> min / mark</span>
          </div>` : ""}
          ${quizState.timerMode === "full" ? `<div class="pc-row">
            <span class="pc-label">Total</span>
            <span class="pc-num"><input type="number" id="cfg-totalmin" min="1" step="1" value="${quizState.totalMin}"> minutes</span>
          </div>` : ""}
          ${quizState.timerMode === "section" && quizState.sectionMin ? `<div class="pc-row">
            <span class="pc-label">Sections</span>
            <span class="pc-num pc-sections">${Object.entries(quizState.sectionMin).map(([s, m]) => `${s}: ${m}m`).join(" · ")}</span>
          </div>` : ""}
          <div class="pc-row">
            <span class="pc-label">Include</span>
            <div class="seg" id="cfg-filter">
              <button class="seg-btn${filter === "all" ? " sel" : ""}" data-filter="all">Whole paper</button>
              <button class="seg-btn${filter === "mc" ? " sel" : ""}" data-filter="mc">MC only</button>
              <button class="seg-btn${filter === "written" ? " sel" : ""}" data-filter="written">Written only</button>
            </div>
          </div>
        </div>

        <button class="paper-start-btn" id="btn-paper-start">Start — ${selected.length} questions · ${selMarks} marks →</button>

        <div class="paper-qlist-head">Questions</div>
        <ol class="paper-qlist">${rows}</ol>
      </div>`;
    quizArea.querySelectorAll("#cfg-mark .seg-btn").forEach((btn) =>
      btn.addEventListener("click", () => { quizState.markMode = btn.dataset.mark; renderPaperConfig(); }));
    quizArea.querySelectorAll("#cfg-filter .seg-btn").forEach((btn) =>
      btn.addEventListener("click", () => { quizState.sectionFilter = btn.dataset.filter; renderPaperConfig(); }));
    quizArea.querySelectorAll("#cfg-timer .seg-btn").forEach((btn) =>
      btn.addEventListener("click", () => { quizState.timerMode = btn.dataset.tm; renderPaperConfig(); }));
    quizArea.querySelector("#cfg-minpermark")?.addEventListener("input", (e) => {
      const v = parseFloat(e.target.value); if (v > 0) quizState.minPerMark = v;
    });
    quizArea.querySelector("#cfg-totalmin")?.addEventListener("input", (e) => {
      const v = parseInt(e.target.value, 10); if (v > 0) quizState.totalMin = v;
    });
    quizArea.querySelector("#btn-paper-start").addEventListener("click", () => {
      const items = allQuestions.filter(inFilter);
      if (items.length) beginSession(items, "paper");
    });
    quizArea.querySelectorAll(".paper-qrow").forEach((row) =>
      row.addEventListener("click", () => beginSession([allQuestions[parseInt(row.dataset.i, 10)]], "paper")));
  }

  // Written (short/extended) question: read stimulus + type an answer, reveal a model answer
  // and marking criteria, then self-grade out of the marks (which feeds the same SR engine).
  function renderWrittenQuestion() {
    const { questions, current } = quizState;
    const c = quizState.container;
    const q = questions[current];
    const ep = q._ep || quizState.ep;
    const total = questions.length;
    const mins = Math.max(1, Math.round((q.marks || 1) * 1.8));
    const narrow = c !== quizArea; // review bottom-sheet → force single column
    const criteria = Array.isArray(q.criteria) ? q.criteria : [];
    c.innerHTML = `
      <div class="quiz-session written-session${narrow ? " written-narrow" : ""}">
        <div class="quiz-header">
          <button class="quiz-exit-btn" id="btn-quiz-exit">✕ Exit</button>
          ${quizSubjectHtml(q)}
          ${quizState.isPaper && quizState.timerMode !== "off" ? `<span class="paper-timer" id="paper-timer"></span>` : ""}
          <span class="quiz-progress-text">${current + 1} / ${total}</span>
        </div>
        <div class="quiz-progress-track">
          <div class="quiz-progress-fill" style="width:${Math.round(((current + 1) / total) * 100)}%"></div>
        </div>
        <div class="written-grid">
          <div class="written-stimulus">
            <div class="written-meta">
              <span class="pq-no">Q${q.qNo || current + 1}</span>
              <span class="pq-marks">${q.marks} mark${q.marks === 1 ? "" : "s"}</span>
              <span class="pq-time">~${mins} min</span>
              <span class="pq-type pq-${q.type}">${q.type === "extended" ? "Extended response" : "Short answer"}</span>
              ${sourceBadgeHtml(q)}
            </div>
            ${q.image ? `<img class="quiz-stimulus" src="${q.image}" alt="">` : ""}
            <p class="quiz-q-text">${q.q}</p>
          </div>
          <div class="written-answer">
            <textarea class="sync-input written-input" id="written-input" placeholder="Type your answer…"></textarea>
            <div class="written-actions">
              <button class="quiz-action-btn quiz-action-secondary" id="btn-written-share">Share / Email</button>
              <button class="quiz-action-btn" id="btn-written-reveal">Reveal model answer</button>
            </div>
            <div class="written-reveal" id="written-reveal" hidden>
              ${q.modelAnswer ? `<div class="written-model"><div class="wm-h">Model answer</div><div class="wm-body">${q.modelAnswer}</div></div>` : ""}
              ${criteria.length ? `<div class="written-criteria"><div class="wm-h">Marking criteria</div><ul>${criteria.map((cc) => `<li><span class="wc-marks">${cc.marks}</span><span class="wc-desc">${cc.descriptor}</span></li>`).join("")}</ul></div>` : ""}
              ${sourceLineHtml(q)}
              <div class="written-selfgrade">
                <p class="grade-prompt">Mark yourself out of ${q.marks}</p>
                <div class="mark-pills">${Array.from({ length: (q.marks || 0) + 1 }, (_, m) => `<button class="mark-pill" data-m="${m}">${m}</button>`).join("")}</div>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    const ta = c.querySelector("#written-input");
    ta.value = loadWrittenDraft(ep, q);
    ta.addEventListener("input", () => saveWrittenDraft(ep, q, ta.value));
    c.querySelector("#btn-quiz-exit").addEventListener("click", () => { quizState.mode = null; (quizState.onExit || renderQuizPicker)(); });
    c.querySelector("#btn-written-share").addEventListener("click", () => shareWritten(ep, q, ta.value));
    c.querySelector("#btn-written-reveal").addEventListener("click", () => {
      const r = c.querySelector("#written-reveal");
      setHidden(r, false);
      renderMath(r);
    });
    c.querySelectorAll(".mark-pill").forEach((btn) =>
      btn.addEventListener("click", () => {
        c.querySelectorAll(".mark-pill").forEach((b) => b.classList.toggle("sel", b === btn));
        selfGradeWritten(ep, q, parseInt(btn.dataset.m, 10));
      }));
    if (quizState.isPaper) onQuestionShown(q);
    renderMath(c);
  }

  // === ACTIVE RECALL ("what's the key point?") — retrieve from memory, reveal, FSRS self-grade. ===
  function renderRecallQuestion() {
    const { questions, current } = quizState;
    const c = quizState.container;
    const q = questions[current];
    const ep = q._ep || quizState.ep;
    const total = questions.length;
    const points = Array.isArray(q.keyPoints) ? q.keyPoints : [];
    c.innerHTML = `
      <div class="quiz-session recall-session">
        <div class="quiz-header">
          <button class="quiz-exit-btn" id="btn-quiz-exit">✕ Exit</button>
          <span class="quiz-progress-text">${current + 1} / ${total}</span>
        </div>
        <div class="quiz-progress-track">
          <div class="quiz-progress-fill" style="width:${Math.round(((current + 1) / total) * 100)}%"></div>
        </div>
        <div class="quiz-question-wrap">
          <div class="quiz-badges"><span class="type-badge type-recall">Active recall</span>${sourceBadgeHtml(q)}</div>
          ${q.image ? `<img class="quiz-stimulus" src="${q.image}" alt="">` : ""}
          <p class="quiz-q-text">${q.q}</p>
          <p class="recall-hint">Say it out loud or jot it down from memory — then check.</p>
          <button class="quiz-action-btn" id="btn-recall-reveal">Show key points</button>
          <div class="recall-reveal" id="recall-reveal" hidden>
            <ul class="recall-points">${points.map((p) => `<li>${p}</li>`).join("")}</ul>
            ${q.explanation ? `<p class="feedback-explanation">${q.explanation}</p>` : ""}
            ${sourceLineHtml(q)}
            <p class="grade-prompt">How well did you recall it?</p>
            <div class="quiz-grades" id="quiz-grades"></div>
          </div>
        </div>
      </div>`;
    c.querySelector("#btn-quiz-exit").addEventListener("click", () => { quizState.mode = null; (quizState.onExit || renderQuizPicker)(); });
    c.querySelector("#btn-recall-reveal").addEventListener("click", (e) => {
      e.currentTarget.setAttribute("hidden", "");
      const r = c.querySelector("#recall-reveal");
      setHidden(r, false);
      attachFsrsGrades(c.querySelector("#quiz-grades"), ep, q, null); // no objective answer → infer from grade
      renderMath(r);
    });
    renderMath(c);
  }

  // === WORKED CALCULATION — optional numeric auto-check, then reveal step-by-step working. ===
  function renderWorkedQuestion() {
    const { questions, current } = quizState;
    const c = quizState.container;
    const q = questions[current];
    const ep = q._ep || quizState.ep;
    const total = questions.length;
    const hasNum = typeof q.answerValue === "number";
    const steps = Array.isArray(q.working) ? q.working : [];
    const unit = q.answerUnit ? ` ${q.answerUnit}` : "";
    c.innerHTML = `
      <div class="quiz-session worked-session">
        <div class="quiz-header">
          <button class="quiz-exit-btn" id="btn-quiz-exit">✕ Exit</button>
          <span class="quiz-progress-text">${current + 1} / ${total}</span>
        </div>
        <div class="quiz-progress-track">
          <div class="quiz-progress-fill" style="width:${Math.round(((current + 1) / total) * 100)}%"></div>
        </div>
        <div class="quiz-question-wrap">
          <div class="quiz-badges"><span class="type-badge type-worked">Worked</span>${sourceBadgeHtml(q)}</div>
          ${q.image ? `<img class="quiz-stimulus" src="${q.image}" alt="">` : ""}
          <p class="quiz-q-text">${q.q}</p>
          ${q.given ? `<p class="worked-given"><span class="wg-label">Given:</span> ${q.given}</p>` : ""}
          ${hasNum ? `<div class="worked-input-row">
              <input class="worked-input" id="worked-input" type="text" inputmode="decimal" placeholder="Your answer" autocomplete="off">
              ${q.answerUnit ? `<span class="worked-unit">${q.answerUnit}</span>` : ""}
            </div>` : ""}
          <button class="quiz-action-btn" id="btn-worked-reveal">${hasNum ? "Check & reveal working" : "Reveal working"}</button>
          <div class="worked-reveal" id="worked-reveal" hidden>
            <div class="worked-verdict" id="worked-verdict" hidden></div>
            <ol class="worked-steps">${steps.map((s) => `<li>${s}</li>`).join("")}</ol>
            ${q.explanation ? `<p class="feedback-explanation">${q.explanation}</p>` : ""}
            ${sourceLineHtml(q)}
            <p class="grade-prompt">How well did you know it?</p>
            <div class="quiz-grades" id="quiz-grades"></div>
          </div>
        </div>
      </div>`;
    c.querySelector("#btn-quiz-exit").addEventListener("click", () => { quizState.mode = null; (quizState.onExit || renderQuizPicker)(); });
    c.querySelector("#btn-worked-reveal").addEventListener("click", (e) => {
      e.currentTarget.setAttribute("hidden", "");
      let correct = null;
      if (hasNum) {
        const raw = (c.querySelector("#worked-input").value || "").trim();
        const val = parseFloat(raw);
        const tol = typeof q.tolerance === "number" ? q.tolerance : 0;
        const v = c.querySelector("#worked-verdict");
        if (raw === "" || !isFinite(val)) {
          correct = null; // didn't attempt the number → leave accuracy to the self-grade
          v.className = "worked-verdict";
          v.textContent = `Answer: ${q.answerValue}${unit}`;
        } else {
          correct = Math.abs(val - q.answerValue) <= tol;
          v.className = `worked-verdict ${correct ? "verdict-correct" : "verdict-wrong"}`;
          v.textContent = correct
            ? `✓ Correct — ${q.answerValue}${unit}`
            : `✗ You wrote ${raw}; answer is ${q.answerValue}${unit}`;
        }
        setHidden(v, false);
      }
      const r = c.querySelector("#worked-reveal");
      setHidden(r, false);
      attachFsrsGrades(c.querySelector("#quiz-grades"), ep, q, correct);
      renderMath(r);
    });
    renderMath(c);
  }

  // Written self-mark — recorded in the simple paper store (NOT FSRS), then advance.
  function selfGradeWritten(ep, q, awarded) {
    recordPaperMark(ep, q, awarded);
    maybeCompletePaper(ep);
    setTimeout(advanceQuiz, 250);
  }

  // Share the question + the student's typed answer (Web Share on mobile, mailto fallback).
  async function shareWritten(ep, q, text) {
    const body = `${ep.title} — Q${q.qNo || ""} (${q.marks} marks)\n\n${q.q}\n\nMy answer:\n${text || "(blank)"}`;
    const data = { title: `${ep.title} — Q${q.qNo || ""}`.trim(), text: body };
    if (navigator.share && (!navigator.canShare || navigator.canShare(data))) {
      try { await navigator.share(data); return; } catch { return; }
    }
    window.location.href = `mailto:?subject=${encodeURIComponent(data.title)}&body=${encodeURIComponent(body)}`;
  }

  // Mark a paper complete once every question has been attempted.
  function maybeCompletePaper(ep) {
    if (!quizState || !quizState.isPaper) return;
    const p = loadPaper();
    if (quizState.allQuestions.every((q) => p[srKey(ep, q)]?.attempted)) {
      saveEpisodeProgress(ep.id, { completed: true });
    }
  }

  // Paper results: score + per-question breakdown, plus the opt-in bridge that pushes the
  // multiple-choice questions you got WRONG into the FSRS spaced-review deck (MC only).
  function renderPaperResults() {
    const timeTaken = quizState.timerStart ? Date.now() - quizState.timerStart : 0;
    stopPaperTimer();
    const c = quizState.container;
    const ep = quizState.ep;
    const qs = quizState.questions;
    const ans = quizState.answers;
    const mc = qs.filter((q) => q.type === "mc");
    const mcCorrect = mc.filter((q) => ans[qs.indexOf(q)]?.correct).length;
    const written = qs.filter((q) => q.type !== "mc");
    const wrongMC = mc.filter((q) => { const a = ans[qs.indexOf(q)]; return a && !a.correct; });
    const pct = mc.length ? Math.round((mcCorrect / mc.length) * 100) : null;
    const emoji = pct === null ? "📝" : pct >= 80 ? "🏆" : pct >= 60 ? "👍" : "📚";
    const rows = qs.map((q, i) => {
      if (q.type !== "mc") {
        const st = paperState(ep, q);
        const mk = st && st.mark != null ? `${st.mark}/${st.outOf}` : "attempted";
        return `<div class="review-row"><div class="rr-head"><span class="pq-no">Q${q.qNo || i + 1}</span>
            <span class="rr-tag">Written — self-marked ${mk}</span></div></div>`;
      }
      const a = ans[i];
      const correct = a && a.correct;
      return `<div class="review-row">
          <div class="rr-head"><span class="pq-no">Q${q.qNo || i + 1}</span>
            <span class="rr-verdict ${correct ? "verdict-correct" : "verdict-wrong"}">${correct ? "✓ Correct" : "✗ Incorrect"}</span></div>
          <p class="rr-q">${q.q}</p>
          <p class="rr-ans">Your answer: ${a && q.options[a.chosen] != null ? q.options[a.chosen] : "—"}</p>
          ${!correct ? `<p class="rr-ans rr-correct">Correct: ${q.options[q.answer]}</p>` : ""}
          ${q.explanation ? `<p class="feedback-explanation">${q.explanation}</p>` : ""}
        </div>`;
    }).join("");
    c.innerHTML = `
      <div class="quiz-summary paper-results">
        <div class="quiz-summary-score">
          <div class="summary-emoji">${emoji}</div>
          <div class="summary-fraction">${mcCorrect}/${mc.length}</div>
          <div class="summary-pct">multiple choice${written.length ? ` · ${written.length} written attempted` : ""}</div>
          ${timeTaken ? `<div class="summary-time">⏱ Time taken: ${fmtClock(timeTaken)}</div>` : ""}
        </div>
        ${wrongMC.length ? `<button class="quiz-action-btn" id="btn-bridge">↻ Add ${wrongMC.length} wrong question${wrongMC.length > 1 ? "s" : ""} to spaced review</button>` : ""}
        <div class="review-list">${rows}</div>
        <div class="quiz-summary-actions">
          ${wrongMC.length ? `<button class="quiz-action-btn quiz-action-secondary" id="btn-redo-wrong">Redo ${wrongMC.length} I got wrong</button>` : ""}
          <button class="quiz-action-btn quiz-action-ghost" id="btn-quiz-back">← Back to paper</button>
        </div>
      </div>`;
    const bridge = c.querySelector("#btn-bridge");
    if (bridge) bridge.addEventListener("click", () => {
      // grade=1 ("Again") creates a due FSRS card; loadAllQuestions then surfaces these MCs.
      wrongMC.forEach((q) => gradeCard(ep, q, 1, false));
      allQuestionsCache = null;
      updateReviewBadge();
      bridge.textContent = `✓ Added to spaced review`;
      bridge.disabled = true;
    });
    c.querySelector("#btn-redo-wrong")?.addEventListener("click", () => beginSession(wrongMC, "paper"));
    renderMath(c);
    c.querySelector("#btn-quiz-back").addEventListener("click", () => { quizState.mode = null; (quizState.onExit || renderPaperConfig)(); });
  }

  // === END QUIZ ===

  // === REVIEW / STUDY HUB (subject-wide: mix quiz, known/learning split, diagnostic) ===
  let allQuestionsCache = null;
  // Pool quiz questions across ALL subjects so the study hub is global. Each question is
  // tagged with its episode (q._ep), module prefix (q._prefix) and subject (q._subject).
  async function loadAllQuestions() {
    if (allQuestionsCache) return allQuestionsCache;
    const list = [];
    (fullManifest ? fullManifest.subjects : []).forEach((s) =>
      s.modules.forEach((m) => m.episodes.forEach((e) => {
        if (e.quizPath) list.push({ ep: e, prefix: m.prefix, subject: s.id });
      })));
    const sr = loadSR();
    const results = await Promise.all(list.map(({ ep, prefix, subject }) =>
      fetch(ep.quizPath).then((r) => (r.ok ? r.json() : null)).then((d) => {
        if (!d || !Array.isArray(d.questions)) return [];
        let qs = d.questions;
        // Past papers stay OUT of the spaced-review hub by default — only the multiple-choice
        // questions explicitly bridged from a results screen (so they have an FSRS card) appear.
        if (ep.paper) qs = qs.filter((q) => sr[`${ep.id}::${q.id}`]);
        qs.forEach((q) => { q._ep = ep; q._prefix = prefix; q._subject = subject; });
        return qs;
      }).catch(() => [])
    ));
    allQuestionsCache = results.flat();
    return allQuestionsCache;
  }

  // Classify a question from its spaced-repetition card: never tried / still learning / known.
  function classifyCard(q) {
    const raw = loadSR()[srKey(q._ep, q)];
    if (!raw || !raw.total) return "new";
    const notDue = new Date(raw.due) > new Date();
    const reviewState = window.FSRS && raw.state === window.FSRS.State.Review;
    if (reviewState && notDue) return "known"; // graduated to review and not yet due
    return "weak";
  }

  function openReview(subjectScope) {
    if (!fullManifest) return;
    openSheet(reviewOverlay);
    renderReviewHub(subjectScope);
  }

  const TOPIC_SEP = "␟";  // composite topic key: "<subject>␟<prefix>"
  const topicKey = (q) => q._subject + TOPIC_SEP + q._prefix;
  const subjShort = (id) => { const s = subjectMeta(id); return s ? (s.shortName || s.name) : id; };

  async function renderReviewHub(subjectScope) {
    reviewContent.innerHTML = `<div class="quiz-empty"><p>Loading…</p></div>`;
    let all = await loadAllQuestions();
    // Scoped review (opened from a subject's Quizzes tile): only that subject's cards.
    if (subjectScope) all = all.filter((q) => q._subject === subjectScope);
    if (!all.length) { reviewContent.innerHTML = `<div class="quiz-empty"><p>No quizzes available yet.</p></div>`; return; }

    // Treat a scoped hub as single-subject: no per-subject prefixes or collapsible wrappers.
    const multiSubject = !subjectScope && fullManifest.subjects.length > 1;
    const buckets = { new: 0, weak: 0, known: 0 };
    const groups = {};  // composite topic key -> stats
    all.forEach((q) => {
      const cls = classifyCard(q);
      buckets[cls]++;
      const k = topicKey(q);
      const g = groups[k] || (groups[k] = { subject: q._subject, prefix: q._prefix, total: 0, correct: 0, known: 0, n: 0 });
      const c = getCard(q._ep, q);
      g.n++; g.total += c.total || 0; g.correct += c.correct || 0;
      if (cls === "known") g.known++;
    });
    const topics = Object.entries(groups).map(([key, g]) => ({
      key,
      name: (multiSubject ? `${subjShort(g.subject)} · ` : "") + groupNameFor(g.subject, g.prefix),
      mastery: Math.round((g.known / g.n) * 100), attempted: g.total > 0,
    })).sort((a, b) => a.mastery - b.mastery);
    const weakest = topics.find((t) => t.attempted);

    // Mix-topic picker grouped Subject → Year → module (each subject uses its own yearMap).
    const present = [...new Set(all.map(topicKey))];
    const presentSet = new Set(present);
    const subjectsHtml = fullManifest.subjects
      .filter((s) => !subjectScope || s.id === subjectScope)
      .map((s) => {
      const yMap = s.yearMap || {};
      const yOrder = s.yearOrder || YEAR_ORDER;
      const prefixes = [...new Set(s.modules.map((m) => m.prefix))].filter((p) => presentSet.has(s.id + TOPIC_SEP + p));
      if (!prefixes.length) return "";
      const byYear = {};
      prefixes.forEach((p) => { const y = yMap[p] || "Other"; (byYear[y] || (byYear[y] = [])).push(p); });
      const years = [...yOrder.filter((y) => byYear[y]), ...Object.keys(byYear).filter((y) => !yOrder.includes(y))];
      const inner = years.map((y) => `
          <div class="mix-year-lbl">${y}</div>
          ${byYear[y].map((p) => `<label class="mix-topic"><input type="checkbox" class="mix-topic-cb" data-subject="${s.id}" value="${s.id + TOPIC_SEP + p}" checked> ${groupNameFor(s.id, p)}</label>`).join("")}
        `).join("");
      // Single subject: no collapsible wrapper. Multiple: a collapsed dropdown per subject.
      if (!multiSubject) return `<div class="mix-subject">${inner}</div>`;
      return `<details class="mix-subject">
        <summary class="mix-subject-sum">
          <input type="checkbox" class="mix-subject-cb" data-subject="${s.id}" checked>
          <span class="mix-subject-name">${s.name}</span>
          <span class="mix-subject-count">${prefixes.length}</span>
          <span class="mix-sum-chev">&#8250;</span>
        </summary>
        <div class="mix-subject-body">${inner}</div>
      </details>`;
    }).join("");

    reviewContent.innerHTML = `
      <div class="review-hub">
        <section class="review-sec">
          <h3 class="review-h">Mixed flashcards</h3>
          <p class="review-sub">Choose topics and what to include, then how many — they're jumbled together${multiSubject ? ", across every subject" : ""}.</p>
          <div class="mix-topics">
            ${subjectsHtml}
          </div>
          <div class="mix-year-lbl">Include</div>
          <div class="mix-scope">
            <button class="mix-scope-btn sel" data-scope="all">All</button>
            <button class="mix-scope-btn" data-scope="weak">Still learning</button>
            <button class="mix-scope-btn" data-scope="new">Not started</button>
          </div>
          <div class="mix-year-lbl">How many</div>
          <div class="review-mix-btns">
            <button class="review-pill" data-n="10">10</button>
            <button class="review-pill" data-n="20">20</button>
            <button class="review-pill" data-n="50">50</button>
            <button class="review-pill" data-n="0">All</button>
          </div>
        </section>
        <section class="review-sec">
          <h3 class="review-h">Your progress</h3>
          <div class="review-buckets">
            <div class="rb rb-known"><span class="rb-num">${buckets.known}</span><span class="rb-lbl">Known</span></div>
            <div class="rb rb-weak"><span class="rb-num">${buckets.weak}</span><span class="rb-lbl">Still learning</span></div>
            <div class="rb rb-new"><span class="rb-num">${buckets.new}</span><span class="rb-lbl">Not started</span></div>
          </div>
          <button class="review-drill" id="btn-review-drill"${buckets.weak === 0 ? " disabled" : ""}>${buckets.weak > 0 ? `Drill the ${buckets.weak} you're still learning` : "Nothing to drill yet"}</button>
        </section>
        <section class="review-sec">
          <h3 class="review-h">By topic</h3>
          ${weakest ? `<p class="review-sub">Weakest area: <strong>${weakest.name}</strong> — a good place to revise next.</p>` : `<p class="review-sub">Do some questions and your strong/weak topics will show here.</p>`}
          <div class="review-topics">
            ${topics.map((t) => `
              <div class="rt">
                <div class="rt-row"><span class="rt-name">${t.name}</span><span class="rt-pct">${t.mastery}% known</span></div>
                <div class="rt-track"><div class="rt-fill" style="width:${t.mastery}%"></div></div>
              </div>`).join("")}
          </div>
        </section>
      </div>`;

    reviewContent.querySelectorAll(".mix-scope-btn").forEach((b) =>
      b.addEventListener("click", () =>
        reviewContent.querySelectorAll(".mix-scope-btn").forEach((x) => x.classList.toggle("sel", x === b))));
    // A subject-level checkbox toggles all of that subject's topic checkboxes — and its
    // click must not also open/close the <details> dropdown it sits inside.
    reviewContent.querySelectorAll(".mix-subject-cb").forEach((cb) => {
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () =>
        reviewContent.querySelectorAll(`.mix-topic-cb[data-subject="${cb.dataset.subject}"]`)
          .forEach((c) => { c.checked = cb.checked; }));
    });
    reviewContent.querySelectorAll(".review-mix-btns .review-pill").forEach((b) =>
      b.addEventListener("click", () => {
        const keys = [...reviewContent.querySelectorAll(".mix-topic-cb:checked")].map((cb) => cb.value);
        const sel = reviewContent.querySelector(".mix-scope-btn.sel");
        runMix(keys, sel ? sel.dataset.scope : "all", parseInt(b.dataset.n, 10));
      }));
    const drill = reviewContent.querySelector("#btn-review-drill");
    if (drill && !drill.disabled) drill.addEventListener("click", () => runMix(present, "weak", 0));
  }

  // One-tap daily quiz — no config screen. Opens the review sheet and jumps straight
  // into ~12 questions: whatever's due first, topped up with fresh ones so there's
  // always a full quiz. Lowest-barrier way into the study loop.
  async function startDailyQuiz() {
    openSheet(reviewOverlay);
    reviewContent.innerHTML = `<div class="quiz-empty"><p>Loading…</p></div>`;
    const all = await loadAllQuestions();
    if (!all.length) { reviewContent.innerHTML = `<div class="quiz-empty"><p>No quizzes available yet.</p></div>`; return; }
    const N = 12;
    // "Due" = a card you've started that's ready for review (matches the top-bar badge).
    // New/unseen cards don't count here so real reviews come first; we top up with fresh
    // questions to always fill a quiz.
    const sr = loadSR();
    const now = Date.now();
    const isReviewDue = (q) => { const c = sr[srKey(q._ep, q)]; return !!(c && c.total && c.due && new Date(c.due).getTime() <= now); };
    const isUnseen = (q) => { const c = sr[srKey(q._ep, q)]; return !c || !c.total; };

    // Split-by-subject mode: work one subject at a time. Pick the first subject (in
    // manifest order) that still has anything to study — due reviews first, else unseen
    // cards — so you finish a subject before the rotation moves to the next one.
    let candidates = all;
    if (quizSplitBySubject()) {
      const ids = fullManifest.subjects.map((s) => s.id);
      const target =
        ids.find((id) => all.some((q) => q._subject === id && isReviewDue(q))) ||
        ids.find((id) => all.some((q) => q._subject === id && isUnseen(q))) ||
        ids[0];
      candidates = all.filter((q) => q._subject === target);
    }

    const due = shuffle(candidates.filter(isReviewDue));
    let pool = due.slice(0, N);
    if (pool.length < N) {
      const dueSet = new Set(pool);
      const fresh = shuffle(candidates.filter((q) => !dueSet.has(q))).slice(0, N - pool.length);
      pool = shuffle([...pool, ...fresh]);
    }
    quizState = { ep: null, allQuestions: all, items: pool, questions: [], current: 0, score: 0,
                  answered: false, mode: "mix", missed: [], container: reviewContent, onExit: renderReviewHub };
    beginSession(pool, "mix");
  }

  async function runMix(topicKeys, scope, n) {
    const all = await loadAllQuestions();
    const keys = new Set(topicKeys);
    let pool = all.filter((q) => keys.has(topicKey(q)));
    if (scope === "weak") pool = pool.filter((q) => classifyCard(q) === "weak");
    else if (scope === "new") pool = pool.filter((q) => classifyCard(q) === "new");
    pool = shuffle(pool);
    if (n && n > 0) pool = pool.slice(0, n);
    if (!pool.length) { showToast("No questions match — pick more topics or a wider range."); return; }
    quizState = { ep: null, allQuestions: all, items: pool, questions: [], current: 0, score: 0,
                  answered: false, mode: "mix", missed: [], container: reviewContent, onExit: renderReviewHub };
    beginSession(pool, "mix");
  }
  // === END REVIEW ===

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.toggle("active", b === btn));
      const match = window.location.hash.match(/^#\/episode\/(.+)$/);
      if (match) {
        const ep = findEpisode(decodeURIComponent(match[1]));
        if (!ep) return;
        if (btn.dataset.tab === "quiz") {
          setHidden(episodeContentEl, true);
          setHidden(quizArea, false);
          renderQuizTab(ep);
        } else {
          setHidden(episodeContentEl, false);
          setHidden(quizArea, true);
          renderMarkdownTab(ep, btn.dataset.tab);
        }
      }
    });
  });

  window.addEventListener("hashchange", handleRoute);
  btnBack.addEventListener("click", () => {
    // Walk one level up the hierarchy: episode → mode library → subject hub → subject picker.
    if (!viewEpisode.hidden) navigateToLibrary();
    else if (!viewLibrary.hidden) navigateToHub();
    else if (viewSubjectHub && !viewSubjectHub.hidden) navigateToSubjects();
    else navigateToSubjects();
  });

  // Library search: re-render the (filtered) library as the user types.
  if (libSearchInput) {
    libSearchInput.addEventListener("input", () => { if (!viewLibrary.hidden) renderLibrary(); });
  }

  // Quiz keyboard: 1–4 picks an answer, then 1–4 grades (Again/Hard/Good/Easy).
  document.addEventListener("keydown", (e) => {
    if (!quizState || quizState.mode == null || !quizState.container) return;
    const tag = document.activeElement.tagName;
    if (tag === "INPUT" || tag === "SELECT") return;
    const c = quizState.container;

    // Past-paper runner keybindings: 1–4 / A–D pick an option; Enter / Space / → advance.
    if (quizState.isPaper) {
      if (tag === "TEXTAREA") return; // typing a written answer
      if (quizState.answered) {
        if (["Enter", " ", "ArrowRight", "n", "N"].includes(e.key)) {
          const next = c.querySelector("#btn-paper-next");
          if (next) { e.preventDefault(); next.click(); }
        }
        return;
      }
      let idx = -1;
      const n = parseInt(e.key, 10);
      if (n >= 1 && n <= 4) idx = n - 1;
      else if (/^[a-dA-D]$/.test(e.key)) idx = e.key.toLowerCase().charCodeAt(0) - 97;
      if (idx >= 0) {
        const opts = c.querySelectorAll(".quiz-option");
        if (idx < opts.length) { e.preventDefault(); opts[idx].click(); }
      }
      return;
    }

    if (tag === "TEXTAREA") return;
    const n = parseInt(e.key, 10);
    if (!(n >= 1 && n <= 4)) return;
    if (quizState.answered) {
      const btn = c.querySelector(`.grade-btn[data-g="${n}"]`);
      if (btn) { e.preventDefault(); btn.click(); }
    } else {
      const opts = c.querySelectorAll(".quiz-option");
      if (n <= opts.length) { e.preventDefault(); opts[n - 1].click(); }
    }
  });

  // Keyboard for open bottom-sheets: Escape closes; Tab is trapped inside the panel
  // (so focus can't wander to the page behind an aria-modal dialog).
  document.addEventListener("keydown", (e) => {
    const sheet = activeSheet();
    if (!sheet) return;
    if (e.key === "Escape") { closeSheet(sheet); return; }
    if (e.key === "Tab") {
      const focusables = sheet.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      const list = Array.from(focusables).filter((el) => !el.disabled && el.offsetParent !== null);
      if (!list.length) return;
      const first = list[0], last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  // --- Footer repo link (per-subject) ---
  const repoLink = document.getElementById("repo-link");
  if (repoLink) repoLink.href = REPO_URL;

  // --- Offline state ---
  const offlineBanner = document.getElementById("offline-banner");
  function updateOnlineState() {
    document.body.classList.toggle("offline", !navigator.onLine);
    if (offlineBanner) setHidden(offlineBanner, navigator.onLine);
  }
  window.addEventListener("online", updateOnlineState);
  window.addEventListener("offline", updateOnlineState);
  updateOnlineState();

  // Ask the browser to keep our data (progress, stats, downloads) — makes it far
  // less likely to be evicted under storage pressure. Signing in is the real
  // backup; this protects local data in the meantime.
  if (navigator.storage && navigator.storage.persist) {
    persistRequested = true;
    navigator.storage.persist().catch(() => {});
  }

  // --- Install (Add to Home Screen) ---
  let deferredInstall = null;
  function isStandalone() {
    return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
  }
  function updateInstallUI() {
    if (!btnInstall || !installHint) return;
    if (isStandalone()) {
      setHidden(btnInstall, true);
      installHint.textContent = "App installed ✓";
    } else if (deferredInstall) {
      setHidden(btnInstall, false);
      installHint.textContent = "Add this app to your home screen for full-screen, offline access.";
    } else {
      setHidden(btnInstall, true);
      installHint.textContent = /iphone|ipad|ipod/i.test(navigator.userAgent)
        ? "On iPhone/iPad: tap Share, then “Add to Home Screen”."
        : "In Chrome/Edge, use the install icon in the address bar to add the app.";
    }
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstall = e;
    updateInstallUI();
  });
  window.addEventListener("appinstalled", () => { deferredInstall = null; updateInstallUI(); });
  if (btnInstall) btnInstall.addEventListener("click", async () => {
    if (!deferredInstall) return;
    deferredInstall.prompt();
    await deferredInstall.userChoice.catch(() => {});
    deferredInstall = null;
    updateInstallUI();
  });
  updateInstallUI();

  // When a sync pulls remote changes, refresh the library if it's showing.
  window.addEventListener("sync-updated", () => { updateReviewBadge(); if (!viewLibrary.hidden) renderLibrary(); });

  // --- Service worker & controlled updates ---
  // A new shell no longer force-reloads the page the instant it deploys (that interrupted playback
  // mid-session and made every deploy a surprise). Instead the new worker sits in "waiting" and the
  // page applies it only when it's safe/wanted:
  //   • the user swipes UP or taps "Check for update" in Settings → About (explicit "refresh now"), or
  //   • the app is idle (paused) once an update is ready — applied immediately, no time delay.
  // Applying = postMessage SKIP_WAITING → the worker takes over → controllerchange → one reload.
  if ("serviceWorker" in navigator) {
    let swReg = null;
    let waitingWorker = null;   // the installed-but-waiting new shell, once one exists
    let updateReady = false;
    let reloadingForUpdate = false;

    function applyUpdate(reason) {
      if (reloadingForUpdate || !updateReady) return;
      reloadingForUpdate = true;
      alog("sw:apply-update", "why=" + reason);
      // Tell the waiting worker to take over; controllerchange (below) then reloads. If for some
      // reason there's no waiting worker handle, just reload — the new shell is already cached.
      if (waitingWorker) waitingWorker.postMessage({ type: "SKIP_WAITING" });
      else window.location.reload();
    }
    function maybeAutoUpdate() {
      // Apply as soon as it's safe (paused, so we never cut off listening). Swipe-up / the
      // Settings button ignore the paused check — those are explicit requests.
      if (updateReady && audio.paused) applyUpdate("auto-while-paused");
    }
    function markUpdateReady(worker) {
      waitingWorker = worker || waitingWorker;
      if (updateReady) return;
      updateReady = true;
      alog("sw:update-ready");
      showUpdateBanner();
      maybeAutoUpdate();
    }

    navigator.serviceWorker.addEventListener("controllerchange", () => {
      // Fires when the (now-former) waiting worker takes control after SKIP_WAITING. Reload once
      // onto the new shell. Guarded so we never loop.
      if (!reloadingForUpdate) return;
      window.location.reload();
    });

    navigator.serviceWorker.register("/service-worker.js", { updateViaCache: "none" })
      .then((reg) => {
        swReg = reg;
        // A worker already waiting from a previous visit.
        if (reg.waiting && navigator.serviceWorker.controller) markUpdateReady(reg.waiting);
        // A worker that finishes installing while we're running becomes our pending update.
        reg.addEventListener("updatefound", () => {
          const nw = reg.installing;
          if (!nw) return;
          nw.addEventListener("statechange", () => {
            if (nw.state === "installed" && navigator.serviceWorker.controller) markUpdateReady(nw);
          });
        });
        reg.update().catch(() => {});
      })
      .catch(() => {});

    // Settings → About → "Check for update": force a fresh check against service-worker.js right
    // now (bypassing the browser's own ~24h poll interval) and apply immediately if one's waiting.
    const checkUpdateBtn = document.getElementById("check-update-btn");
    if (checkUpdateBtn) checkUpdateBtn.addEventListener("click", () => {
      if (!swReg) return;
      checkUpdateBtn.disabled = true;
      checkUpdateBtn.textContent = "Checking…";
      swReg.update().catch(() => {}).then(() => {
        // updatefound/statechange land asynchronously; give them a beat to flip updateReady.
        setTimeout(() => {
          if (updateReady) { applyUpdate("manual-check"); return; }
          checkUpdateBtn.disabled = false;
          checkUpdateBtn.textContent = "Up to date";
          setTimeout(() => { checkUpdateBtn.textContent = "Check for update"; }, 1500);
        }, 1200);
      });
    });

    // Swipe UP anywhere = "refresh now", but only does anything once an update is actually waiting,
    // so it never disturbs normal scrolling on an up-to-date app. A deliberate, mostly-vertical
    // upward swipe of a good fraction of the screen.
    let swipeStartY = null, swipeStartX = null;
    window.addEventListener("touchstart", (e) => {
      if (!updateReady || e.touches.length !== 1) { swipeStartY = null; return; }
      swipeStartY = e.touches[0].clientY; swipeStartX = e.touches[0].clientX;
    }, { passive: true });
    window.addEventListener("touchend", (e) => {
      if (swipeStartY == null || !e.changedTouches[0]) return;
      const dy = swipeStartY - e.changedTouches[0].clientY;      // + = up
      const dx = Math.abs(e.changedTouches[0].clientX - swipeStartX);
      swipeStartY = null;
      if (dy > window.innerHeight * 0.25 && dy > dx * 1.5) applyUpdate("swipe-up");
    }, { passive: true });

    // Catch an update that arrived while backgrounded, once we're foreground + paused again.
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") maybeAutoUpdate(); });

    // Small, dismissible hint so the swipe-up gesture is discoverable (also tappable to apply).
    function showUpdateBanner() {
      if (document.getElementById("update-banner")) return;
      const b = document.createElement("button");
      b.id = "update-banner";
      b.type = "button";
      b.textContent = "Update ready — swipe up to refresh";
      b.setAttribute("aria-label", "Update ready — tap or swipe up to refresh");
      b.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:9999;padding:10px 16px;border:none;border-radius:999px;background:#2563eb;color:#fff;font:600 13px/1 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.3)";
      b.addEventListener("click", () => applyUpdate("banner-tap"));
      document.body.appendChild(b);
    }
  }

  // --- Init ---
  // Accept both the unified manifest ({subjects:[...]}) and, defensively, a legacy
  // single-subject one ({modules:[...]}) — the latter is wrapped as one nameless subject.
  function normaliseManifest(data) {
    if (Array.isArray(data.subjects)) return data;
    return { subjects: [{ id: "default", name: "Library", shortName: "Library",
                          groupNames: {}, yearMap: {},
                          yearOrder: ["Case Studies", "Year 12", "Year 11", "Other"],
                          repoUrl: "", modules: data.modules || [] }] };
  }
  // Namespace every episode id as "<subject>:<id>" (globally unique) and tag it with its
  // subject, so progress/SR/downloads/routing all key cleanly across subjects.
  function indexManifest(data) {
    data.subjects.forEach((s) => s.modules.forEach((m) => m.episodes.forEach((e) => {
      e._subject = s.id;
      if (!String(e.id).startsWith(s.id + ":")) e.id = `${s.id}:${e.id}`;
    })));
    return data;
  }

  // BUG-8: the home screen only renders after the manifest loads. A hard reload bypasses the
  // service worker (so its cache fallback doesn't apply), and a storm of SW-bypassing requests
  // can fail — leaving a blank home screen. Retry a few times, and keep a last-good copy in
  // localStorage to fall back on so the app still boots even when every fetch fails.
  const MANIFEST_CACHE_KEY = "podcast-manifest-cache";
  async function loadManifestData() {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch("manifest.json");
        if (!r.ok) throw new Error("manifest HTTP " + r.status);
        const data = await r.json();
        try { localStorage.setItem(MANIFEST_CACHE_KEY, JSON.stringify(data)); } catch (e) {}
        return data;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      }
    }
    try {
      const cached = localStorage.getItem(MANIFEST_CACHE_KEY);
      if (cached) { console.warn("[init] manifest fetch failed — booting from cached copy"); return JSON.parse(cached); }
    } catch (e) {}
    throw lastErr;
  }
  loadManifestData()
    .then(async (data) => {
      fullManifest = indexManifest(normaliseManifest(data));
      await loadPaperSubjects();   // expand the subject pool to every paper subject before rendering
      // If there's exactly one subject, skip the picker and enter it directly.
      if (fullManifest.subjects.length === 1) setSubject(fullManifest.subjects[0].id);
      // Otherwise, if a hash deep-links a subject/episode, handleRoute sets it; if not and
      // we have a remembered last subject, pre-select it so #/ can be made to land there.
      else if (!window.location.hash || window.location.hash === "#/") {
        const last = (() => { try { return localStorage.getItem(LAST_SUBJECT_KEY); } catch { return null; } })();
        if (last && subjectMeta(last)) setSubject(last);
      }
      handleRoute();
      // Resume-on-open: if we landed on a subject's library (not the picker or a deep-linked
      // episode), warm the player bar with the last-played, unfinished episode — paused.
      if (!currentEpisode && !viewLibrary.hidden) {
        const le = getLastPlayedEpisode();
        if (le) loadEpisode(le, { autoplay: false });
      }
      updateReviewBadge();
      track("open", { subjects: fullManifest ? fullManifest.subjects.length : 0 });
      maybeOnboard();
    })
    .catch((err) => {
      console.error("[init] failed to load manifest", err);
      (viewSubjects || viewLibrary).innerHTML = '<p class="load-error">Couldn’t load the library — check your connection and reload.</p>';
    });
})();
