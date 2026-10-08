// STOP (2026-07-09): Repo locked until 6 Nov 2026 (after the HSC). No work here without tangible study gain. See STOP-UNTIL-NOV-6.md. Go do past papers.
// speed-engine.js — pitch-preserving variable-speed audio for the player.
//
// Why this exists:
//   The player used to drive speed with the HTML5 `<audio>.playbackRate`.
//   Browsers MUTE that audio path above ~4x (Chrome silences playbackRate > 4),
//   so the speed slider could go to 16x but produced silence past 4x. This
//   module replaces that path with a Web Audio time-scale-modification (TSM)
//   engine: it speeds audio up WITHOUT raising pitch and stays audible all the
//   way to 16x, on any of the existing voice files (no re-rendering).
//
//   Algorithm: speechwarp (vendor/speechwarp) — Google's Speedy nonlinear
//   speed-up on top of Sonic, compiled to WebAssembly and run in an AudioWorklet.
//   Nonlinear means vowels and pauses are compressed harder than consonants, the
//   way a fast talker speeds up, so high speeds stay followable. The whole episode
//   is decoded once into memory and the worklet pulls from it at the requested
//   speed, so the TTS is never re-run per speed.
//
// Integration:
//   `createHybridAudio(el)` returns an object that quacks like the subset of the
//   HTMLAudioElement API the player uses (src, load, play, pause, paused, duration,
//   currentTime, playbackRate, and loadedmetadata/play/pause/ended/timeupdate events),
//   so app.js swaps it in with a one-line change. It wraps BOTH the raw <audio> element
//   and the TSM engine and exposes a runtime toggle (setEngineEnabled / engineEnabled /
//   engineAvailable): engine mode gives pitch-preserved audio to 16x, native mode is the
//   plain element (audible to ~4x) as a "go back" fallback. In engine mode the raw element
//   loops a silent clip to anchor the iOS media session (lock-screen / headphone controls).
//   `createSpeedAudio(fallbackEl)` remains as a single-backend factory. If the browser
//   lacks AudioWorklet the engine is unavailable and everything stays on the raw element.

(function () {
  "use strict";

  // Decode at 24 kHz — Kokoro's native rate. Speech needs nothing above ~12 kHz,
  // and a lower rate halves the decoded-PCM memory footprint for long episodes.
  const TARGET_RATE = 24000;

  // The time-stretcher is speechwarp (Speedy + Sonic in WebAssembly), vendored by
  // `npm run vendor:speechwarp`. Its ready-made AudioWorklet processor imports ./index.js,
  // so the three files stay together in vendor/speechwarp/.
  const PROCESSOR_URL = "vendor/speechwarp/speechwarp-processor.js";

  // Use `in` — do NOT read `AudioContext.prototype.audioWorklet`. It's a getter that
  // requires a real context as `this`; touching it on the prototype throws "Illegal
  // invocation" (Chrome/Safari/iOS), which previously crashed app init on load.
  function engineSupported() {
    return (
      typeof AudioContext !== "undefined" &&
      typeof AudioWorkletNode !== "undefined" &&
      "audioWorklet" in AudioContext.prototype
    );
  }

  // The Web Audio time-stretch backend (assumes engineSupported()). Presents the
  // subset of the HTMLAudioElement API the player uses, so it can be swapped in for
  // the raw <audio> element.
  function buildTsmBackend() {
    const listeners = {};
    function on(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); }
    function off(type, fn) { const a = listeners[type]; if (a) listeners[type] = a.filter((f) => f !== fn); }
    function fire(type) { (listeners[type] || []).forEach((fn) => { try { fn({ type }); } catch (e) { console.error(e); } }); }

    let ctx = null;
    let node = null;
    let loadToken = 0;
    let srcUrl = "";
    let _duration = 0;
    let _currentTime = 0;
    let _rate = 1;
    let _paused = true;
    let _ready = false;     // decoded + node wired
    let pendingPlay = false;

    function ensureContext() {
      if (ctx) return Promise.resolve();
      ctx = new AudioContext({ sampleRate: TARGET_RATE });
      // BUG-22: iOS suspends the AudioContext on rotation / backgrounding, which stops
      // playback with no way to resume from the worklet. Auto-resume whenever the context
      // is suspended but the user still intends to play (_paused === false). Safe: resuming
      // an already-running context is a no-op, and we never resume against the user's pause.
      const resumeIfWanted = () => {
        if (ctx && !_paused && ctx.state === "suspended") ctx.resume().catch(() => {});
      };
      try { ctx.addEventListener("statechange", resumeIfWanted); } catch (_) {}
      document.addEventListener("visibilitychange", resumeIfWanted);
      window.addEventListener("focus", resumeIfWanted);
      window.addEventListener("orientationchange", resumeIfWanted);
      window.addEventListener("pageshow", resumeIfWanted);
      return ctx.audioWorklet.addModule(new URL(PROCESSOR_URL, document.baseURI).href);
    }

    function load() {
      if (!srcUrl) return;
      const token = ++loadToken;
      _ready = false;
      _duration = 0;
      _currentTime = 0;

      ensureContext()
        .then(() => fetch(srcUrl))
        .then((r) => r.arrayBuffer())
        .then((buf) => ctx.decodeAudioData(buf))
        .then((audioBuf) => {
          if (token !== loadToken) return; // a newer src superseded this load

          // Downmix to mono (speech) — halves memory and the work per frame.
          const ch = audioBuf.numberOfChannels;
          const len = audioBuf.length;
          const mono = new Float32Array(len);
          for (let c = 0; c < ch; c++) {
            const d = audioBuf.getChannelData(c);
            for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
          }

          if (node) { try { node.disconnect(); } catch (e) {} }
          node = new AudioWorkletNode(ctx, "speechwarp-processor", {
            outputChannelCount: [1],
            processorOptions: { speed: _rate },
          });
          // The processor reports { frame, ended } ~6x a second whether or not it is
          // playing, and keeps reporting ended: true once done. Only surface it while
          // playing, and fire `ended` once.
          node.port.onmessage = (e) => {
            const m = e.data;
            if (m.type !== "position" || _paused) return;
            if (m.ended) { _paused = true; _currentTime = _duration; fire("ended"); return; }
            _currentTime = m.frame / ctx.sampleRate;
            fire("timeupdate");
          };
          node.connect(ctx.destination);
          node.port.postMessage({ type: "load", channels: [mono] }, [mono.buffer]);

          _duration = len / audioBuf.sampleRate;
          _ready = true;
          fire("loadedmetadata");
          if (pendingPlay) { pendingPlay = false; play(); }
        })
        .catch((err) => console.error("[speed-engine] load failed:", err));
    }

    function play() {
      if (!_ready) { pendingPlay = true; return Promise.resolve(); }
      _paused = false;
      const p = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
      return p.then(() => { node.port.postMessage({ type: "play" }); fire("play"); });
    }

    function pause() {
      pendingPlay = false;
      if (!_paused) { _paused = true; if (node) node.port.postMessage({ type: "pause" }); fire("pause"); }
    }

    return {
      addEventListener: on,
      removeEventListener: off,
      load,
      play,
      pause,
      get paused() { return _paused; },
      get duration() { return _duration; },
      get currentTime() { return _currentTime; },
      set currentTime(t) {
        _currentTime = t;
        if (node) node.port.postMessage({ type: "seek", frame: Math.round(t * ctx.sampleRate) });
        fire("timeupdate");
      },
      get playbackRate() { return _rate; },
      set playbackRate(r) {
        _rate = Math.max(0.25, Math.min(16, r));
        if (node) node.port.postMessage({ type: "speed", value: _rate });
      },
      get src() { return srcUrl; },
      set src(v) { srcUrl = v; },
    };
  }

  // Back-compat single-backend factory: the TSM engine if supported, else the raw element.
  function createSpeedAudio(fallbackEl) {
    if (!engineSupported()) {
      if (fallbackEl) console.warn("[speed-engine] AudioWorklet unavailable — using <audio> (silent above 4x).");
      return fallbackEl;
    }
    return buildTsmBackend();
  }

  // A tiny (0.05 s) silent WAV. In engine mode the raw <audio> element loops this so
  // iOS keeps the audio session + lock-screen/headphone controls alive while the Web
  // Audio engine produces the actual sound (the controls are routed to the engine).
  const SILENT_LOOP = "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";

  // Reversible hybrid audio. Wraps BOTH the raw <audio> element (native backend) and
  // the TSM engine, exposing the same API the player uses so `const audio = ...` is the
  // only integration point. A runtime toggle (setEngineEnabled) picks which backend is
  // audible; it takes effect on the next load() (the app reloads the current episode so
  // the switch feels immediate). Native mode is the exact previous behaviour — the
  // "go back" escape hatch if the engine misbehaves on a device.
  function createHybridAudio(el) {
    const PREF_KEY = "podcast-speed-engine"; // "0" = native; default engine when available
    const eng = engineSupported() ? buildTsmBackend() : null;

    // App-facing listener registry. Events from a backend are forwarded only while that
    // backend is the active one, so switching modes just changes which stream passes.
    const listeners = {};
    // Honour addEventListener's { once } option — the player attaches one-shot
    // loadedmetadata handlers on every load (setAudioSource / switchVoice). The raw
    // element auto-removes them; if we didn't, they'd pile up and re-fire on later
    // loads, resetting currentTime/rate mid-playback (the old voice-switch glitch).
    const on = (t, f, opts) => (listeners[t] || (listeners[t] = [])).push({ f, once: !!(opts && opts.once) });
    const off = (t, f) => { const a = listeners[t]; if (a) listeners[t] = a.filter((r) => r.f !== f); };
    const emit = (t) => {
      const arr = listeners[t];
      if (!arr || !arr.length) return;
      const snapshot = arr.slice();
      listeners[t] = arr.filter((r) => !r.once); // drop one-shot handlers before invoking
      snapshot.forEach((r) => { try { r.f({ type: t }); } catch (e) { console.error(e); } });
    };
    const EVENTS = ["loadedmetadata", "play", "pause", "ended", "timeupdate"];

    let engineActive = false;              // is the TSM engine the audible backend right now?
    // Default is the speechwarp engine wherever AudioWorklet exists ("0" = native). The
    // native element with preservesPitch stays as the fallback: it is what plays with the
    // screen off, and app.js forces it for screen-off mode and long-form audio.
    let enginePref = !!eng && localStorage.getItem(PREF_KEY) !== "0";
    let _src = "";
    let _rate = 1;
    let anchoring = false;                 // is the silent-loop anchor currently running on el?
    let engLoaded = false;                 // has the current src been decoded into the engine yet?

    const wire = (backend, isEng) =>
      EVENTS.forEach((t) => backend.addEventListener(t, () => { if (engineActive === isEng) emit(t); }));
    wire(el, false);
    if (eng) wire(eng, true);
    // NB: the silent anchor is deliberately left running across an episode's `ended`, so
    // that background auto-advance keeps the iOS audio session warm (a fresh el.play() in
    // the background can be rejected). It is stopped by pause() — which the app calls when
    // playback ends with nothing to advance to.

    const cur = () => (engineActive ? eng : el);

    // Native backend = pitch-preserving high speed, exactly like the browser speed
    // extensions (playbackRate + preservesPitch). Without this, native speed raises pitch
    // ("chipmunk"). Browsers may clear the flag on a src change, so (re)apply on every use.
    function setNativePitch() {
      ["preservesPitch", "webkitPreservesPitch", "mozPreservesPitch"].forEach((p) => {
        try { if (p in el) el[p] = true; } catch (e) {}
      });
    }
    setNativePitch();

    function startAnchor() {
      if (!eng || anchoring) return;
      anchoring = true;
      try {
        el.loop = true;
        el.playbackRate = 1;               // keep the anchor at 1x (>4x would mute/kill it)
        if (el.src !== SILENT_LOOP) el.src = SILENT_LOOP;
        const p = el.play(); if (p && p.catch) p.catch(() => {});
      } catch (e) {}
    }
    function stopAnchor() {
      if (!anchoring) return;
      anchoring = false;
      try { el.loop = false; el.pause(); } catch (e) {}
    }

    return {
      addEventListener: on,
      removeEventListener: off,
      // Resolve the backend from the current preference at load time (this is when a
      // toggle takes effect). In engine mode el is freed up to be the silent anchor.
      load() {
        // Long-form audio must never use the TSM engine: it fetches the WHOLE file and
        // decodeAudioData()s it into PCM. A 5-minute episode is fine; a 3-hour audiobook
        // is ~96 MB fetched and ~2 GB of PCM, which never completes — the element stays
        // at readyState 0 with no error because in engine mode it is only the silent
        // anchor. Callers mark such sources with dataset.noEngine and get the native
        // player, whose playbackRate handles these speeds without decoding anything.
        engineActive = !!enginePref && !!eng && el.dataset.noEngine !== "1";
        if (engineActive) {
          // Defer the expensive whole-file decode until play(), so merely VIEWING an
          // episode (loadEpisode autoplay:false) doesn't fetch + decode ~170 MB of PCM.
          eng.src = _src;
          engLoaded = false;
        } else {
          stopAnchor();
          setNativePitch();
          el.playbackRate = _rate;
          el.src = _src;
          el.load();
        }
      },
      play() {
        if (engineActive) {
          if (!engLoaded) { eng.playbackRate = _rate; eng.load(); engLoaded = true; }
          startAnchor();
          return eng.play(); // the engine queues the play if the decode is still in flight
        }
        setNativePitch();
        return el.play();
      },
      pause() {
        if (engineActive) { eng.pause(); stopAnchor(); return; }
        el.pause();
      },
      get paused() { return cur().paused; },
      get duration() { return cur().duration || 0; },
      get currentTime() { return cur().currentTime || 0; },
      set currentTime(t) { cur().currentTime = t; },
      get playbackRate() { return _rate; },
      set playbackRate(r) {
        _rate = r;
        if (eng) eng.playbackRate = r;
        if (!engineActive) el.playbackRate = r; // in engine mode el stays the 1x anchor
      },
      get src() { return _src; },
      set src(v) { _src = v; },
      // --- Hybrid controls (used by the Settings toggle) ---
      get engineAvailable() { return !!eng; },
      get engineEnabled() { return !!enginePref && !!eng; },
      setEngineEnabled(b) {
        enginePref = !!b && !!eng;
        try { localStorage.setItem(PREF_KEY, enginePref ? "1" : "0"); } catch (e) {}
      },
    };
  }

  window.createSpeedAudio = createSpeedAudio;
  window.createHybridAudio = createHybridAudio;
})();
