/* plotmap.js — interactive plot map for English Standard set texts.
 *
 * Renders a narrative arc from content/<subject>/<text>/scenes.json: x is position
 * through the book, y is dramatic intensity derived from arcStage, so the climax
 * reads as the peak. Tapping a scene opens its summary and its quotes, and seeks
 * the audio to that point.
 *
 * Position is tracked as a PERCENTAGE through the book, never as a timestamp, so
 * the map follows whatever audio the listener supplies regardless of its length.
 *
 * The novel itself is in copyright and is not distributed with this app. The player
 * ships a short placeholder track; the listener loads their own audiobook file, which
 * is held locally in IndexedDB and never uploaded.
 */
(function () {
  "use strict";

  var TEXT_BASE = "content/english-standard/past-the-shallows/";
  var STAGE_Y = { exposition: 0.22, rising: 0.55, climax: 1.0, falling: 0.45, resolution: 0.2 };
  var STAGE_LABEL = {
    exposition: "Exposition", rising: "Rising action",
    climax: "Climax", falling: "Falling action", resolution: "Resolution",
  };

  var scenes = [], quotes = [], activeId = null, audio = null, loaded = false;
  var root, svgWrap, detailEl, statusEl, placeholderUrl = null, priv = null;
  // Read-along reader state (renders the user's own private PDF via pdf.js).
  var pdfDoc = null, pdfPages = [], pdfNumPages = 0, readerOpen = false,
      followAudio = true, userScrolledAt = 0, lastSyncPage = 0;
  var currentTab = "map", readMode = "pdf", textBuilt = false, allQuotesBuilt = false;
  var bookLoaded = false, bookParas = [], bookTotalWords = 0, bookByPage = {};

  /* ---------- tiny IndexedDB store for the listener's own audio file ---------- */
  var DB = "pts-audio", STORE = "files";
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open(DB, 1);
      r.onupgradeneeded = function () {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbPut(key, val) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = res; tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, "readonly");
        var q = tx.objectStore(STORE).get(key);
        q.onsuccess = function () { res(q.result); };
        q.onerror = function () { rej(q.error); };
      });
    });
  }

  /* ---------- position <-> scene ---------- */
  function pctNow() {
    if (!audio || !audio.duration || !isFinite(audio.duration)) return null;
    return (audio.currentTime / audio.duration) * 100;
  }
  function sceneAtPct(p) {
    if (p == null) return null;
    for (var i = 0; i < scenes.length; i++) {
      if (p >= scenes[i].startPct && p < scenes[i].endPct) return scenes[i];
    }
    return scenes.length ? scenes[scenes.length - 1] : null;
  }

  /* ---------- rendering ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  var W = 1400, H = 300, PAD_T = 34, PAD_B = 58;

  function xOf(pct) { return (pct / 100) * (W - 40) + 20; }
  function yOf(sc) {
    var base = STAGE_Y[sc.arcStage] != null ? STAGE_Y[sc.arcStage] : 0.5;
    // Give the long "rising" stretch a gentle ramp so it climbs toward the climax.
    if (sc.arcStage === "rising") {
      var rs = scenes.filter(function (s) { return s.arcStage === "rising"; });
      var i = rs.indexOf(sc);
      if (i >= 0 && rs.length > 1) base = 0.34 + (0.44 * i) / (rs.length - 1);
    }
    return PAD_T + (1 - base) * (H - PAD_T - PAD_B);
  }

  function buildSvg() {
    var pts = scenes.map(function (s) {
      return [xOf((s.startPct + s.endPct) / 2), yOf(s)];
    });
    var path = pts.map(function (p, i) { return (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1); }).join(" ");
    var area = path + " L" + pts[pts.length - 1][0].toFixed(1) + " " + (H - PAD_B) +
               " L" + pts[0][0].toFixed(1) + " " + (H - PAD_B) + " Z";

    // Band labels. The last three stages each occupy only a few percent of the book,
    // so their labels collide on a single baseline. Lay them out with real collision
    // detection: measure each label's extent, clamp it inside the viewBox, then drop it
    // to the first row where it clears whatever is already on that row.
    var bands = "", labels = "";
    var rowRight = [];             // rightmost occupied x per row
    var seen = {};
    scenes.forEach(function (s) {
      if (seen[s.arcStage]) return;
      seen[s.arcStage] = 1;
      var group = scenes.filter(function (x) { return x.arcStage === s.arcStage; });
      var x0 = xOf(group[0].startPct), x1 = xOf(group[group.length - 1].endPct);
      bands += '<rect class="pm-band pm-band-' + s.arcStage + '" x="' + x0.toFixed(1) + '" y="' + PAD_T +
               '" width="' + Math.max(1, x1 - x0).toFixed(1) + '" height="' + (H - PAD_T - PAD_B) + '"/>';

      var label = STAGE_LABEL[s.arcStage] || s.arcStage;
      var half = (label.length * 7.5) / 2;      // ~13px uppercase with letter-spacing
      var cx = (x0 + x1) / 2;
      cx = Math.max(half + 2, Math.min(W - half - 2, cx));   // keep inside the viewBox
      var left = cx - half, right = cx + half;

      var row = 0;
      while (rowRight[row] != null && left < rowRight[row] + 8) row++;
      rowRight[row] = right;

      labels += '<text class="pm-bandlabel" x="' + cx.toFixed(1) +
                '" y="' + (H - PAD_B + 20 + row * 15) + '">' + esc(label) + "</text>";
    });
    bands += labels;

    // Both the turning point and its aftermath are tagged climax; label the run once
    // so the two captions don't overprint each other.
    var climaxScenes = scenes.filter(function (x) { return x.arcStage === "climax"; });
    var climaxLabelId = climaxScenes.length ? climaxScenes[0].id : null;

    var nodes = scenes.map(function (s, i) {
      var cx = xOf((s.startPct + s.endPct) / 2), cy = yOf(s);
      var cls = "pm-node" + (s.arcStage === "climax" ? " pm-node-climax" : "") +
                (s.id === activeId ? " pm-node-active" : "");
      return '<g class="' + cls + '" data-scene="' + esc(s.id) + '" tabindex="0" role="button" ' +
             'aria-label="' + esc(s.order + ". " + s.title) + '">' +
             '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' +
             (s.arcStage === "climax" ? 11 : 7) + '"/>' +
             '<text class="pm-nodenum" x="' + cx.toFixed(1) + '" y="' + (cy + 4).toFixed(1) + '">' +
             (s.arcStage === "climax" ? "" : s.order) + "</text>" +
             (s.arcStage === "climax" && s.id === climaxLabelId
               ? '<text class="pm-climaxlabel" x="' + cx.toFixed(1) + '" y="' + (cy - 20).toFixed(1) + '">CLIMAX</text>'
               : "") +
             "</g>";
    }).join("");

    return '<svg class="pm-svg" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="xMinYMid meet" role="img">' +
      bands +
      '<path class="pm-area" d="' + area + '"/>' +
      '<path class="pm-line" d="' + path + '"/>' +
      '<line class="pm-playhead" id="pm-playhead" x1="0" y1="' + PAD_T + '" x2="0" y2="' + (H - PAD_B) + '" style="display:none"/>' +
      nodes +
      "</svg>";
  }

  function quoteCards(sc) {
    var qs = quotes.filter(function (q) { return q.sceneId === sc.id; });
    if (!qs.length) return '<p class="pm-noquotes">No quotes pinned to this scene yet.</p>';
    return '<ul class="pm-quotes">' + qs.map(function (q) {
      return '<li class="pm-quote pm-pri-' + esc(q.priority) + '">' +
        '<blockquote>&ldquo;' + esc(q.quote) + '&rdquo;</blockquote>' +
        '<div class="pm-qmeta">' + esc(q.theme || "") +
        (q.chapter != null ? " &middot; ch " + esc(q.chapter) : "") +
        (q.pdfPage != null ? " &middot; p" + esc(q.pdfPage) : "") + "</div>" +
        (q.mnemonic ? '<div class="pm-qmnemonic">' + esc(q.mnemonic) + "</div>" : "") +
        "</li>";
    }).join("") + "</ul>";
  }

  function renderDetail(sc) {
    if (!sc) { detailEl.innerHTML = '<p class="pm-hint">Pick a scene on the arc above.</p>'; return; }
    var chap = sc.chapters && sc.chapters.length
      ? "ch " + sc.chapters.join(", ")
      : '<span class="pm-unverified" title="The source text has no chapter markers; this scene is not pinned to a verified chapter">chapter not pinned</span>';
    detailEl.innerHTML =
      '<div class="pm-dhead">' +
        '<span class="pm-stage pm-stage-' + esc(sc.arcStage) + '">' + esc(STAGE_LABEL[sc.arcStage] || sc.arcStage) + "</span>" +
        "<h3>" + esc(sc.order + ". " + sc.title) + "</h3>" +
      "</div>" +
      '<div class="pm-dmeta">' + chap + " &middot; p" + esc(sc.pdfPageStart) + "&ndash;" + esc(sc.pdfPageEnd) +
        " &middot; " + sc.startPct.toFixed(1) + "%&ndash;" + sc.endPct.toFixed(1) + "% through" +
        (sc.verified ? "" : ' &middot; <span class="pm-unverified">unverified</span>') +
      "</div>" +
      "<p class=\"pm-summary\">" + esc(sc.summary) + "</p>" +
      '<div class="pm-tags">' +
        (sc.characters || []).map(function (c) { return '<span class="pm-tag pm-tag-char">' + esc(c) + "</span>"; }).join("") +
        (sc.themes || []).map(function (t) { return '<span class="pm-tag pm-tag-theme">' + esc(t) + "</span>"; }).join("") +
      "</div>" +
      '<button class="pm-jump" data-jump="' + esc(sc.id) + '">Jump to this scene</button>' +
      "<h4 class=\"pm-qhead\">Quotes here</h4>" + quoteCards(sc);
  }

  function select(id, seek) {
    var sc = scenes.filter(function (s) { return s.id === id; })[0];
    if (!sc) return;
    activeId = id;
    svgWrap.innerHTML = buildSvg();
    renderDetail(sc);
    if (seek && audio && audio.duration && isFinite(audio.duration)) {
      audio.currentTime = (sc.startPct / 100) * audio.duration;
    }
    var node = svgWrap.querySelector('[data-scene="' + id + '"]');
    if (node && node.scrollIntoView) node.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }

  function tick() {
    var p = pctNow();
    var head = document.getElementById("pm-playhead");
    if (p == null || !head) return;
    var x = xOf(p);
    head.setAttribute("x1", x); head.setAttribute("x2", x);
    head.style.display = "";
    var sc = sceneAtPct(p);
    if (sc && sc.id !== activeId) {
      activeId = sc.id;
      svgWrap.innerHTML = buildSvg();
      document.getElementById("pm-playhead").setAttribute("x1", x);
      document.getElementById("pm-playhead").setAttribute("x2", x);
      document.getElementById("pm-playhead").style.display = "";
      renderDetail(sc);
    }
    if (statusEl) {
      statusEl.textContent = sc ? "Now: " + sc.order + ". " + sc.title + "  (" + p.toFixed(1) + "% through)" : "";
    }
    if (currentTab === "read") {
      if (readMode === "book") syncBookToPct(p);
      else if (readMode === "text") syncTextToPct(p);
      else if (readerOpen) syncReaderToPct(p, false);
    }
  }

  /* ---------- audio source ---------- */
  function setStatus(msg, cls) {
    var el = document.getElementById("pm-source-msg");
    if (el) { el.textContent = msg; el.className = "pm-source-msg " + (cls || ""); }
  }

  function useFile(file) {
    if (!file) return;
    if (!/^audio\//.test(file.type) && !/\.(m4a|m4b|mp3|aac|ogg|opus|wav)$/i.test(file.name)) {
      setStatus("That doesn't look like an audio file.", "pm-err");
      return;
    }
    idbPut("audiobook", file).catch(function () {});
    attachBlob(file);
    setStatus("Loaded: " + file.name + " — stays on this device.", "pm-ok");
  }


  // The app only reveals the player bar inside loadEpisode(), which the map never calls.
  // Its controls are generic (they act on the shared <audio>), so we just show it and
  // hide the voice picker, which has no meaning for a single user-supplied file.
  function showPlayer() {
    var bar = document.getElementById("player-bar");
    if (bar) bar.hidden = false;
    var vs = document.getElementById("voice-select");
    if (vs) vs.style.display = "none";
    var t = document.getElementById("player-ep-title");
    if (t && !t.textContent) t.textContent = "Past the Shallows";
  }

  // Tell the speed engine to stay out of the way: this is hours of audio, not an
  // episode. See the dataset.noEngine guard in speed-engine.js.
  function markLongForm() {
    var el = document.getElementById("audio");
    if (el) el.dataset.noEngine = "1";
  }

  function attachBlob(blob) {
    markLongForm();
    if (!audio) return;
    try { if (audio.src && audio.src.indexOf("blob:") === 0) URL.revokeObjectURL(audio.src); } catch (e) {}
    audio.src = URL.createObjectURL(blob);
    audio.load();
    loaded = true;
    document.body.classList.add("pm-has-audio");
    showPlayer();
  }

  // No local file yet: fall back to the placeholder track so the transport behaves like
  // a normal player instead of dying silently. It says the novel isn't included and to
  // load your own file. Picking a file replaces this source entirely.
  function usePlaceholder() {
    if (!audio || loaded || !placeholderUrl) return;
    markLongForm();
    audio.src = placeholderUrl;
    audio.load();
    document.body.classList.remove("pm-has-audio");
    showPlayer();
  }

  var TOKEN_KEY = "pts:audiotoken";

  function privUrl(token) {
    return priv.worker.replace(/\/+$/, "") + "/" + priv.key.replace(/^\/+/, "") +
           "?t=" + encodeURIComponent(token);
  }

  // A stored token is good until it expires; only prompt when there isn't a live one.
  function storedToken() {
    try {
      var v = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
      return v && v.exp > Math.floor(Date.now() / 1000) + 60 ? v.token : null;
    } catch (e) { return null; }
  }

  // Sign-in uses the SAME derivation as auth.js: authToken = base64(PBKDF2(password,
  // salt + "|auth", 150k, SHA-256)). The password never leaves the device; the server
  // only ever compares SHA-256(authToken) against users.auth_hash.
  function b64(buf) {
    var b = new Uint8Array(buf), s = "";
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s);
  }
  function deriveAuthToken(password, salt) {
    var te = new TextEncoder();
    return crypto.subtle.importKey("raw", te.encode(password), "PBKDF2", false, ["deriveBits"])
      .then(function (base) {
        return crypto.subtle.deriveBits(
          { name: "PBKDF2", salt: te.encode(salt + "|auth"), iterations: 150000, hash: "SHA-256" },
          base, 256);
      }).then(b64);
  }

  function showSignIn() {
    var box = document.getElementById("pm-pinbox");
    if (!box) return;
    box.hidden = false;
    box.innerHTML =
      '<label class="pm-pinlabel" for="pm-user">Sign in to play your copy</label>' +
      '<div class="pm-pinrow">' +
        '<input id="pm-user" class="pm-field" type="text" autocomplete="username" ' +
          'autocapitalize="none" spellcheck="false" placeholder="username">' +
        '<input id="pm-pass" class="pm-field" type="password" autocomplete="current-password" ' +
          'placeholder="password">' +
        '<button class="pm-pick" id="pm-signin">Sign in</button>' +
      '</div>';
    var u = document.getElementById("pm-user"), pw = document.getElementById("pm-pass");
    try { u.value = (JSON.parse(localStorage.getItem("sync:session") || "null") || {}).username || ""; } catch (e) {}
    (u.value ? pw : u).focus();
    function submit() { signIn(u.value.trim().toLowerCase(), pw.value); }
    document.getElementById("pm-signin").addEventListener("click", submit);
    [u, pw].forEach(function (el) {
      el.addEventListener("keydown", function (e) { if (e.key === "Enter") submit(); });
    });
  }

  function signIn(username, password) {
    if (!username || !password) { setStatus("Enter both username and password.", "pm-err"); return; }
    var base = priv.worker.replace(/\/+$/, "");
    setStatus("Signing in\u2026", "");
    return fetch(base + "/salt?username=" + encodeURIComponent(username))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.salt) throw new Error("no such account");
        return deriveAuthToken(password, j.salt);
      })
      .then(function (authToken) {
        return fetch(base + "/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: username, authToken: authToken }),
        });
      })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, body: j }; }); })
      .then(function (res) {
        if (res.ok && res.body.token) {
          try { localStorage.setItem(TOKEN_KEY, JSON.stringify(res.body)); } catch (e) {}
          attachPrivate(res.body.token);
          var box = document.getElementById("pm-pinbox");
          if (box) { box.hidden = true; box.innerHTML = ""; }
          setStatus("Signed in as " + username + " \u2014 press play.", "pm-ok");
          return true;
        }
        if (res.status === 429) setStatus("Too many attempts \u2014 locked out briefly.", "pm-err");
        else setStatus("Wrong username or password.", "pm-err");
        return false;
      })
      .catch(function (e) {
        setStatus("Sign-in failed: " + (e && e.message), "pm-err");
        return false;
      });
  }

  function unlockPrivate() {
    if (!priv) return Promise.resolve(false);
    var tok = storedToken();
    if (tok) { attachPrivate(tok); setStatus("Unlocked \u2014 press play.", "pm-ok"); return Promise.resolve(true); }
    showSignIn();
    return Promise.resolve(false);
  }


  // Download-for-offline. Streaming 142MB on every run is wasteful and fails on a bad
  // signal, so pull it once with the session token, keep the blob in IndexedDB, and let
  // restore() play it locally from then on. Progress is reported from Content-Length.
  function downloadOffline() {
    if (!priv) return Promise.resolve(false);
    var tok = storedToken();
    if (!tok) { showSignIn(); return Promise.resolve(false); }
    var btn = document.getElementById("pm-download");
    if (btn) { btn.disabled = true; }

    var url = priv.worker.replace(/\/+$/, "") + "/" + priv.key.replace(/^\/+/, "");
    return fetch(url, { headers: { Authorization: "Bearer " + tok } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        var total = parseInt(r.headers.get("Content-Length") || "0", 10);
        if (!r.body || !r.body.getReader) return r.blob();
        var reader = r.body.getReader(), chunks = [], got = 0;
        return (function pump() {
          return reader.read().then(function (res) {
            if (res.done) return new Blob(chunks, { type: "audio/mp4" });
            chunks.push(res.value); got += res.value.length;
            if (total) setStatus("Downloading \u2014 " + Math.round((got / total) * 100) + "%", "");
            else setStatus("Downloading \u2014 " + (got / 1048576).toFixed(0) + " MB", "");
            return pump();
          });
        })();
      })
      .then(function (blob) {
        return idbPut("audiobook", blob).then(function () {
          attachBlob(blob);
          setStatus("Saved offline (" + (blob.size / 1048576).toFixed(0) +
                    " MB). Works with no signal.", "pm-ok");
          if (btn) { btn.disabled = false; btn.textContent = "Re-download"; }
          return true;
        });
      })
      .catch(function (e) {
        setStatus("Download failed: " + (e && e.message), "pm-err");
        if (btn) btn.disabled = false;
        return false;
      });
  }

  function attachPrivate(token) {
    if (!audio) return;
    markLongForm();
    audio.src = privUrl(token);
    audio.load();
    loaded = true;
    document.body.classList.add("pm-has-audio");
    showPlayer();
  }

  function restore() {
    return idbGet("audiobook").then(function (f) {
      if (f) {
        attachBlob(f);
        setStatus("Loaded: " + (f.name || "your file") + " — stays on this device.", "pm-ok");
        return true;
      }
      if (priv && storedToken()) { attachPrivate(storedToken()); return true; }
      usePlaceholder();
      return false;
    }).catch(function () { usePlaceholder(); return false; });
  }

  /* ---------- public ---------- */
  // cfg is the subject manifest entry; we read audioBaseUrl + setTexts[..].placeholderAudio
  // from it so the R2 location lives in subject.json, not hard-coded here.
  /* ---------- read-along reader (renders the user's OWN private PDF) ----------
     The novel text never ships with the app and is never public. The PDF lives in
     the same private, sign-in-gated R2 bucket as the audio; pdf.js streams it with
     Range requests using the account token. Pages auto-follow the audio position via
     the existing scene->pdfPage anchors, so a highlight box moves as you listen. */
  function setReadMsg(m) { var el = document.getElementById("pm-read-msg"); if (el) el.textContent = m || ""; }

  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = "vendor/pdf.min.js";
      s.onload = function () {
        try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js"; } catch (e) {}
        res(window.pdfjsLib);
      };
      s.onerror = function () { rej(new Error("reader failed to load")); };
      document.head.appendChild(s);
    });
  }

  // The PDF sits beside the audio key in the private bucket (book.m4a -> book.pdf).
  function pdfUrl(token) {
    var keyPdf = (priv.key || "").replace(/\.[^.]+$/, ".pdf");
    return priv.worker.replace(/\/+$/, "") + "/" + keyPdf.replace(/^\/+/, "") +
           "?t=" + encodeURIComponent(token);
  }

  function openReader() {
    if (readerOpen) return; // PDF already loaded; visibility handled by showReadMode
    var tok = storedToken();
    if (!tok) {
      var setup = document.getElementById("pm-setup"); if (setup) setup.hidden = false;
      showSignIn();
      setReadMsg("Sign in above to load your book.");
      return;
    }
    setReadMsg("Loading your PDF…");
    var follow = document.getElementById("pm-follow");
    if (follow) follow.addEventListener("change", function () { followAudio = follow.checked; });
    loadPdfJs().then(function (pdfjsLib) {
      return pdfjsLib.getDocument({ url: pdfUrl(tok), rangeChunkSize: 262144 }).promise;
    }).then(function (doc) {
      pdfDoc = doc; pdfNumPages = doc.numPages; readerOpen = true;
      return buildPages();
    }).then(function () {
      setReadMsg("");
      var p = pctNow(); if (p != null) syncReaderToPct(p, true);
    }).catch(function (e) {
      setReadMsg("Couldn't open the PDF: " + (e && e.message || e));
    });
  }

  function buildPages() {
    var host = document.getElementById("pm-pages");
    host.innerHTML = ""; pdfPages = [];
    host.style.maxHeight = "72vh"; host.style.overflowY = "auto";
    host.addEventListener("scroll", function () { userScrolledAt = Date.now(); });
    return pdfDoc.getPage(1).then(function (pg) {
      var vp = pg.getViewport({ scale: 1 });
      var ratio = vp.height / vp.width;
      for (var i = 1; i <= pdfNumPages; i++) {
        var d = document.createElement("div");
        d.className = "pm-page"; d.setAttribute("data-page", i);
        d.style.position = "relative"; d.style.margin = "0 auto 10px";
        d.style.width = "100%"; d.style.paddingBottom = (ratio * 100) + "%";
        d.style.background = "rgba(127,127,127,0.08)";
        host.appendChild(d);
        pdfPages.push({ el: d, rendered: false, rendering: false });
      }
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) { if (en.isIntersecting) renderPage(parseInt(en.target.getAttribute("data-page"), 10)); });
      }, { root: host, rootMargin: "800px 0px" });
      pdfPages.forEach(function (p) { io.observe(p.el); });
    });
  }

  function renderPage(num) {
    var slot = pdfPages[num - 1];
    if (!slot || slot.rendered || slot.rendering) return;
    slot.rendering = true;
    pdfDoc.getPage(num).then(function (pg) {
      var host = slot.el;
      var cssW = host.clientWidth || 600;
      var vp1 = pg.getViewport({ scale: 1 });
      var dpr = window.devicePixelRatio || 1;
      var vp = pg.getViewport({ scale: (cssW / vp1.width) * dpr });
      var canvas = document.createElement("canvas");
      canvas.width = vp.width; canvas.height = vp.height;
      canvas.style.width = "100%"; canvas.style.height = "auto"; canvas.style.display = "block";
      host.style.paddingBottom = ""; host.style.background = ""; host.innerHTML = "";
      host.appendChild(canvas);
      return pg.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    }).then(function () { slot.rendered = true; slot.rendering = false; })
      .catch(function () { slot.rendering = false; });
  }

  // Map percentage-through-the-book to a PDF page using the scene anchors, matching
  // the same pctNow() model the plot arc already uses.
  function pageForPct(p) {
    var sc = sceneAtPct(p);
    if (sc && sc.pdfPageStart) {
      var span = (sc.endPct - sc.startPct) || 1;
      var frac = Math.max(0, Math.min(1, (p - sc.startPct) / span));
      var pEnd = sc.pdfPageEnd || sc.pdfPageStart;
      return Math.round(sc.pdfPageStart + frac * (pEnd - sc.pdfPageStart));
    }
    return Math.max(1, Math.min(pdfNumPages, Math.round((p / 100) * pdfNumPages)));
  }

  function syncReaderToPct(p, force) {
    if (!readerOpen) return;
    if (!force && !followAudio) return;
    if (!force && Date.now() - userScrolledAt < 4000) return; // don't yank the page while reading
    var num = Math.max(1, Math.min(pdfNumPages, pageForPct(p)));
    if (num === lastSyncPage && !force) return;
    lastSyncPage = num;
    var pn = document.getElementById("pm-pagenum");
    if (pn) pn.textContent = "Page " + num + " of " + pdfNumPages;
    var slot = pdfPages[num - 1];
    if (!slot) return;
    pdfPages.forEach(function (pp) { pp.el.style.boxShadow = ""; });
    slot.el.style.boxShadow = "0 0 0 3px #4a9eff";   // the box that moves as you listen
    renderPage(num);
    if (num > 1) renderPage(num - 1);
    if (num < pdfNumPages) renderPage(num + 1);
    // Scroll the reader pane itself (scrollIntoView picks the wrong ancestor here).
    var host = document.getElementById("pm-pages");
    if (host) {
      var top = slot.el.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
      host.scrollTo({ top: Math.max(0, top - 6), behavior: "auto" });
    }
  }

  function injectReaderStyles() {
    if (document.getElementById("pm-reader-styles")) return;
    var s = document.createElement("style");
    s.id = "pm-reader-styles";
    s.textContent =
      ".pm-tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}" +
      ".pm-readmodes{display:flex;gap:6px;margin:0 0 10px}" +
      ".pm-tab{padding:8px 14px;border-radius:10px;border:1px solid rgba(127,127,127,.3);" +
        "background:var(--bg-card);color:inherit;font-weight:600;cursor:pointer;font-size:.95rem}" +
      ".pm-tab-active{background:var(--accent,#4a9eff);color:#fff;border-color:transparent}" +
      ".pm-pages{max-height:72vh;overflow-y:auto}" +
      ".pm-reader-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px}" +
      ".pm-pagenum{font-weight:600;padding:2px 8px;border:1px solid currentColor;border-radius:6px}" +
      ".pm-textreader{max-height:72vh;overflow-y:auto}" +
      ".pm-tblock{padding:12px 14px;margin:0 0 10px;border-radius:12px;background:var(--bg-card)}" +
      ".pm-tblock-current{box-shadow:0 0 0 3px var(--accent,#4a9eff)}" +
      ".pm-tblock h4{margin:0 0 6px}" +
      ".pm-tblock blockquote{margin:8px 0 0;padding-left:10px;border-left:3px solid var(--accent,#4a9eff)}" +
      ".pm-aq{padding:12px 14px;margin:0 0 10px;border-radius:12px;background:var(--bg-card)}" +
      ".pm-aq blockquote{margin:0 0 6px}" +
      ".pm-aq-meta{font-size:.85rem;opacity:.7}" +
      ".pm-bookreader{max-height:74vh;overflow-y:auto;line-height:1.75;font-size:1.05rem;padding:0 4px}" +
      ".pm-bpara{position:relative;margin:0 0 1em;padding:4px 8px;border-radius:6px;transition:background .15s}" +
      ".pm-bpara-current{background:rgba(74,158,255,.14)}" +
      ".pm-bprog{display:none}" +
      ".pm-bpara-current .pm-bprog{display:block;position:absolute;left:0;bottom:0;height:3px;" +
        "background:var(--accent,#4a9eff);width:0;border-radius:2px}" +
      ".pm-bookhead{position:sticky;top:0;z-index:2;padding:6px 0 8px;background:var(--bg,transparent)}";
    document.head.appendChild(s);
  }

  function showTab(name) {
    currentTab = name;
    root.querySelectorAll(".pm-panel").forEach(function (p) { p.hidden = p.getAttribute("data-panel") !== name; });
    root.querySelectorAll(".pm-tab[data-tab]").forEach(function (t) {
      t.classList.toggle("pm-tab-active", t.getAttribute("data-tab") === name);
    });
    if (name === "read") showReadMode(readMode);
    if (name === "quotes") renderAllQuotes();
  }

  function showReadMode(mode) {
    readMode = mode;
    var panels = { pdf: "pm-reader", book: "pm-bookreader", text: "pm-textreader" };
    var buttons = { pdf: "pm-mode-pdf", book: "pm-mode-book", text: "pm-mode-text" };
    Object.keys(panels).forEach(function (m) {
      var pnl = document.getElementById(panels[m]); if (pnl) pnl.hidden = m !== mode;
      var btn = document.getElementById(buttons[m]); if (btn) btn.classList.toggle("pm-tab-active", m === mode);
    });
    var bookhead = document.getElementById("pm-bookhead"); if (bookhead) bookhead.hidden = mode !== "book";
    var p = pctNow();
    if (mode === "pdf") openReader();
    else if (mode === "book") { openBookText(); if (p != null) syncBookToPct(p); }
    else { renderTextReader(); if (p != null) syncTextToPct(p); }
  }

  // Book text mode: a verbatim reader of a text file the user supplies from their OWN
  // copy of the novel (never produced by the app). Reads book.md from the same private,
  // sign-in-gated bucket; highlights and slides through the current paragraph as the
  // audio plays, mapping position by word-fraction the same way the plot arc uses pct.
  function openBookText() {
    if (bookLoaded) return;
    var host = document.getElementById("pm-bookreader");
    if (!host) return;
    var tok = storedToken();
    if (!tok) { host.innerHTML = '<p class="pm-hint">Sign in (Audio setup) to read your book.</p>'; return; }
    host.innerHTML = '<p class="pm-hint">Preparing your book text…</p>';
    loadPdfJs().then(function (pdfjsLib) {
      if (pdfDoc) return pdfDoc;
      return pdfjsLib.getDocument({ url: pdfUrl(tok) }).promise.then(function (d) {
        pdfDoc = d; pdfNumPages = d.numPages; return d;
      });
    }).then(function (doc) {
      return extractParagraphs(doc);
    }).then(function (paras) {
      renderBookParas(host, paras);
      bookLoaded = true;
      var p = pctNow(); if (p != null) syncBookToPct(p);
    }).catch(function (e) {
      host.innerHTML = '<p class="pm-err">Could not read the book text: ' + esc(e && e.message) + "</p>";
    });
  }

  // Pull the verbatim text straight out of the user's OWN PDF, in their browser — nothing
  // is generated or stored by the app. Group text items into lines by vertical position,
  // then start a new paragraph on an indented line (how novels mark paragraphs).
  function extractParagraphs(doc) {
    var paras = [], cur = "", curPage = 1;
    function flush() { var t = cur.trim(); if (t) paras.push({ text: t, page: curPage }); cur = ""; }
    var chain = Promise.resolve();
    for (var n = 1; n <= doc.numPages; n++) {
      (function (pageNum) {
        chain = chain.then(function () {
          return doc.getPage(pageNum).then(function (page) {
            return page.getTextContent().then(function (tc) {
              var items = tc.items.filter(function (it) { return it.str && it.str.trim(); });
              if (!items.length) return;
              var leftMargin = Infinity;
              items.forEach(function (it) { leftMargin = Math.min(leftMargin, it.transform[4]); });
              var lines = [], lastY = null, line = null;
              items.forEach(function (it) {
                var y = it.transform[5], x = it.transform[4];
                if (lastY === null || Math.abs(y - lastY) > 3) { line = { x: x, text: "" }; lines.push(line); }
                line.text += it.str;
                lastY = y;
              });
              lines.forEach(function (ln) {
                var text = ln.text.replace(/\s+/g, " ").trim();
                if (!text || /^\d{1,4}$/.test(text)) return; // drop bare page numbers
                if (ln.x > leftMargin + 8) { flush(); cur = text; curPage = pageNum; } // indent => new paragraph
                else { if (!cur) curPage = pageNum; cur += (cur ? " " : "") + text; }
              });
            });
          });
        });
      })(n);
    }
    return chain.then(function () { flush(); return paras; });
  }

  function renderBookParas(host, paras) {
    host.addEventListener("scroll", function () { userScrolledAt = Date.now(); });
    bookParas = []; bookByPage = {}; bookTotalWords = 0;
    var html = "";
    paras.forEach(function (para, i) {
      var wc = para.text.split(/\s+/).filter(Boolean).length;
      bookParas.push({ idx: i, page: para.page, words: wc });
      bookTotalWords += wc;
      (bookByPage[para.page] = bookByPage[para.page] || []).push(i);
      html += '<p class="pm-bpara" data-idx="' + i + '" data-page="' + para.page + '">' +
        esc(para.text) + '<span class="pm-bprog"></span></p>';
    });
    host.innerHTML = html;
  }

  // Fractional PDF page for a position, from the scene anchors (same map the PDF reader
  // uses). This is the only per-position timing we have; it keeps the highlight within a
  // page instead of drifting, and it skips the un-narrated front matter automatically.
  function pageForPctFloat(p) {
    var sc = sceneAtPct(p);
    if (sc && sc.pdfPageStart) {
      var span = (sc.endPct - sc.startPct) || 1;
      var frac = Math.max(0, Math.min(1, (p - sc.startPct) / span));
      var pEnd = sc.pdfPageEnd || sc.pdfPageStart;
      return sc.pdfPageStart + frac * (pEnd - sc.pdfPageStart);
    }
    return Math.max(1, Math.min(pdfNumPages, (p / 100) * pdfNumPages));
  }

  function syncBookToPct(p) {
    var host = document.getElementById("pm-bookreader");
    if (!host || host.hidden || !bookParas.length) return;
    var fpage = pageForPctFloat(p);
    var page = Math.max(1, Math.floor(fpage));
    var within = Math.max(0, Math.min(0.999, fpage - page));
    // Pick the paragraph: those starting on this page, indexed by position through the page;
    // if none start here (a paragraph spans it), fall back to the last one before it.
    var idx;
    var onPage = bookByPage[page];
    if (onPage && onPage.length) {
      idx = onPage[Math.floor(within * onPage.length)];
    } else {
      idx = bookParas[0].idx;
      for (var i = 0; i < bookParas.length; i++) { if (bookParas[i].page <= page) idx = bookParas[i].idx; else break; }
    }
    var paras = host.querySelectorAll(".pm-bpara");
    paras.forEach(function (el) { el.classList.remove("pm-bpara-current"); var pr = el.querySelector(".pm-bprog"); if (pr) pr.style.width = "0"; });
    var cur = paras[idx];
    if (!cur) return;
    cur.classList.add("pm-bpara-current");
    var prog = cur.querySelector(".pm-bprog");
    if (prog) prog.style.width = Math.round(within * 100) + "%";
    var box = document.getElementById("pm-bookpage");
    if (box) box.textContent = "Page " + page + " of " + pdfNumPages;
    if (Date.now() - userScrolledAt > 4000) {
      var top = cur.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
      host.scrollTo({ top: Math.max(0, top - 40), behavior: "auto" });
    }
  }

  // Text mode: a reflowable, scrolling companion built from the app's OWN scene
  // summaries and pinned quotes (never the novel text), following the audio.
  function renderTextReader() {
    var host = document.getElementById("pm-textreader");
    if (!host || textBuilt) return;
    if (!scenes.length) { host.innerHTML = '<p class="pm-hint">Loading…</p>'; return; }
    host.addEventListener("scroll", function () { userScrolledAt = Date.now(); });
    host.innerHTML = scenes.map(function (sc) {
      var qs = quotes.filter(function (q) { return q.sceneId === sc.id; });
      return '<div class="pm-tblock" data-scene="' + esc(sc.id) + '">' +
        "<h4>" + esc(sc.order + ". " + sc.title) + "</h4>" +
        '<div class="pm-aq-meta">' + esc(STAGE_LABEL[sc.arcStage] || sc.arcStage) +
          " &middot; p" + esc(sc.pdfPageStart) + "&ndash;" + esc(sc.pdfPageEnd) + "</div>" +
        "<p>" + esc(sc.summary) + "</p>" +
        qs.map(function (q) {
          return "<blockquote>&ldquo;" + esc(q.quote) + "&rdquo;" +
            '<div class="pm-aq-meta">' + esc(q.theme || "") +
            (q.pdfPage != null ? " &middot; p" + esc(q.pdfPage) : "") + "</div></blockquote>";
        }).join("") +
        "</div>";
    }).join("");
    textBuilt = true;
  }

  function syncTextToPct(p) {
    var host = document.getElementById("pm-textreader");
    if (!host || host.hidden) return;
    var sc = sceneAtPct(p);
    if (!sc) return;
    var target = null;
    host.querySelectorAll(".pm-tblock").forEach(function (b) {
      var on = b.getAttribute("data-scene") === sc.id;
      b.classList.toggle("pm-tblock-current", on);
      if (on) target = b;
    });
    if (target && Date.now() - userScrolledAt > 4000) {
      var top = target.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
      host.scrollTo({ top: Math.max(0, top - 6), behavior: "auto" });
    }
  }

  function renderAllQuotes() {
    var host = document.getElementById("pm-allquotes");
    if (!host || allQuotesBuilt) return;
    if (!quotes.length) { host.innerHTML = '<p class="pm-hint">Loading quotes…</p>'; return; }
    var sorted = quotes.slice().sort(function (a, b) {
      return (a.priority - b.priority) || ((a.pdfPage || 0) - (b.pdfPage || 0));
    });
    host.innerHTML = sorted.map(function (q) {
      return '<div class="pm-aq pm-pri-' + esc(q.priority) + '">' +
        "<blockquote>&ldquo;" + esc(q.quote) + "&rdquo;</blockquote>" +
        '<div class="pm-aq-meta">' + esc(q.theme || "") +
          (q.chapter != null ? " &middot; ch " + esc(q.chapter) : "") +
          (q.pdfPage != null ? " &middot; p" + esc(q.pdfPage) : "") +
          (q.sceneTitle ? " &middot; " + esc(q.sceneTitle) : "") + "</div>" +
        (q.mnemonic ? '<div class="pm-qmnemonic">' + esc(q.mnemonic) + "</div>" : "") +
        "</div>";
    }).join("");
    allQuotesBuilt = true;
  }

  function render(container, audioEl, cfg) {
    root = container; audio = audioEl;
    placeholderUrl = null;
    if (cfg && cfg.setTexts) {
      var base = (cfg.audioBaseUrl || "content").replace(/\/+$/, "");
      Object.keys(cfg.setTexts).forEach(function (k) {
        var t = cfg.setTexts[k];
        if (t && t.plotMap && !placeholderUrl) {
          if (t.placeholderAudio) placeholderUrl = base + "/" + String(t.placeholderAudio).replace(/^\/+/, "");
          if (t.privateAudio && t.privateAudio.worker) priv = t.privateAudio;
          if (t.slug) TEXT_BASE = "content/" + cfg.id + "/" + t.slug + "/";
        }
      });
    }
    injectReaderStyles();
    root.innerHTML =
      '<div class="pm-wrap">' +
        '<div class="pm-source">' +
          '<div class="pm-source-row">' +
            '<button class="pm-pick pm-pick-alt" id="pm-setup-toggle" aria-expanded="false">Audio setup ▾</button>' +
          '</div>' +
          '<div class="pm-setup" id="pm-setup" hidden>' +
            '<button class="pm-pick" id="pm-pick">Choose your audiobook file</button>' +
            '<button class="pm-pick pm-pick-alt" id="pm-unlock" hidden>Sign in to play</button>' +
            '<button class="pm-pick pm-pick-alt" id="pm-download" hidden>Save offline</button>' +
            '<input type="file" id="pm-file" accept="audio/*,.m4b,.m4a,.mp3" hidden>' +
            '<div class="pm-pinbox" id="pm-pinbox" hidden></div>' +
            '<div class="pm-source-msg" id="pm-source-msg">Past the Shallows is in copyright, so no recording ships with this app. ' +
              'Load your own file — it stays on this device and is never uploaded.</div>' +
          '</div>' +
        "</div>" +
        '<div class="pm-tabs" role="tablist">' +
          '<button class="pm-tab pm-tab-active" data-tab="map">Plot map</button>' +
          '<button class="pm-tab" data-tab="read">Read along</button>' +
          '<button class="pm-tab" data-tab="quotes">Quotes</button>' +
        '</div>' +
        '<div class="pm-status" id="pm-status"></div>' +
        '<div class="pm-panel" data-panel="map">' +
          '<div class="pm-svgwrap" id="pm-svgwrap"></div>' +
          '<div class="pm-detail" id="pm-detail"></div>' +
        '</div>' +
        '<div class="pm-panel" data-panel="read" hidden>' +
          '<div class="pm-readmodes">' +
            '<button class="pm-tab pm-tab-active" id="pm-mode-pdf" data-mode="pdf">PDF</button>' +
            '<button class="pm-tab" id="pm-mode-book" data-mode="book">Book text</button>' +
            '<button class="pm-tab" id="pm-mode-text" data-mode="text">Summary</button>' +
          '</div>' +
          '<div class="pm-reader" id="pm-reader">' +
            '<div class="pm-reader-head">' +
              '<label class="pm-follow"><input type="checkbox" id="pm-follow" checked> Follow audio</label>' +
              '<span class="pm-pagenum" id="pm-pagenum"></span>' +
              '<span class="pm-read-msg" id="pm-read-msg"></span>' +
            '</div>' +
            '<div class="pm-pages" id="pm-pages"></div>' +
          '</div>' +
          '<div class="pm-textreader" id="pm-textreader" hidden></div>' +
          '<div class="pm-bookhead" id="pm-bookhead" hidden><span class="pm-pagenum" id="pm-bookpage"></span></div>' +
          '<div class="pm-bookreader" id="pm-bookreader" hidden></div>' +
        '</div>' +
        '<div class="pm-panel" data-panel="quotes" hidden>' +
          '<div class="pm-allquotes" id="pm-allquotes"></div>' +
        '</div>' +
      "</div>";
    svgWrap = document.getElementById("pm-svgwrap");
    detailEl = document.getElementById("pm-detail");
    statusEl = document.getElementById("pm-status");

    if (priv) {
      var ub = document.getElementById("pm-unlock");
      ub.hidden = false;
      ub.addEventListener("click", function () { unlockPrivate(); });
      var db = document.getElementById("pm-download");
      db.hidden = false;
      db.addEventListener("click", function () { downloadOffline(); });
    }
    // Tab bar (Plot map / Read along / Quotes) + reading-mode toggle (PDF / Text).
    root.querySelectorAll(".pm-tab[data-tab]").forEach(function (t) {
      t.addEventListener("click", function () { showTab(t.getAttribute("data-tab")); });
    });
    var mpdf = document.getElementById("pm-mode-pdf"), mtext = document.getElementById("pm-mode-text"),
        mbook = document.getElementById("pm-mode-book");
    if (mpdf) mpdf.addEventListener("click", function () { showReadMode("pdf"); });
    if (mbook) mbook.addEventListener("click", function () { showReadMode("book"); });
    if (mtext) mtext.addEventListener("click", function () { showReadMode("text"); });
    document.getElementById("pm-pick").addEventListener("click", function () {
      document.getElementById("pm-file").click();
    });
    document.getElementById("pm-file").addEventListener("change", function (e) {
      useFile(e.target.files && e.target.files[0]);
    });
    // Collapse the setup controls (file / sign-in / offline) — they eat space, and are
    // rarely needed once signed in. Start collapsed for a signed-in device, open otherwise.
    var pmSetup = document.getElementById("pm-setup");
    var pmSetupToggle = document.getElementById("pm-setup-toggle");
    if (pmSetup) pmSetup.hidden = !!storedToken();
    if (pmSetupToggle) {
      pmSetupToggle.setAttribute("aria-expanded", pmSetup && !pmSetup.hidden ? "true" : "false");
      pmSetupToggle.addEventListener("click", function () {
        if (!pmSetup) return;
        pmSetup.hidden = !pmSetup.hidden;
        pmSetupToggle.setAttribute("aria-expanded", pmSetup.hidden ? "false" : "true");
        pmSetupToggle.textContent = pmSetup.hidden ? "Audio setup ▾" : "Audio setup ▴";
      });
    }
    svgWrap.addEventListener("click", function (e) {
      var g = e.target.closest && e.target.closest("[data-scene]");
      if (g) select(g.getAttribute("data-scene"), true);
    });
    svgWrap.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      var g = e.target.closest && e.target.closest("[data-scene]");
      if (g) { e.preventDefault(); select(g.getAttribute("data-scene"), true); }
    });
    detailEl.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-jump]");
      if (b) select(b.getAttribute("data-jump"), true);
    });

    // ContentGate transparently handles both plaintext (local dev) and the encrypted
    // build produced by tools/encrypt_content.py, prompting once if the folder is gated.
    var get = (window.ContentGate && window.ContentGate.getJSON)
      ? function (n) { return window.ContentGate.getJSON(TEXT_BASE, n); }
      : function (n) { return fetch(TEXT_BASE + n, { cache: "no-store" }).then(function (r) { return r.json(); }); };

    var load = Promise.all([get("scenes.json"), get("quotes.json")]).then(function (res) {
      scenes = res[0].scenes || [];
      quotes = res[1].quotes || [];
      svgWrap.innerHTML = buildSvg();
      renderDetail(null);
      if (currentTab === "quotes") renderAllQuotes();
      if (currentTab === "read" && readMode === "text") renderTextReader();
    }).catch(function (err) {
      svgWrap.innerHTML = '<p class="pm-err">Could not load the scene map. ' + esc(err && err.message) + "</p>";
    });

    if (audio && !audio.__pmBound) {
      audio.__pmBound = true;
      audio.addEventListener("timeupdate", tick);
      audio.addEventListener("seeked", tick);
    }
    restore();
    return load;
  }


  /* ---------- quote flashcards ---------- */
  // Same quotes.json the map uses, in recall form: cue on the front, quote plus its
  // technique and mnemonic on the back. Priority 1 is the memorise-first set.
  var cardIdx = 0, cardDeck = [], cardShown = false;

  function renderCardFace() {
    var el = document.getElementById("fc-card");
    if (!el || !cardDeck.length) return;
    var q = cardDeck[cardIdx];
    var counter = document.getElementById("fc-count");
    if (counter) counter.textContent = (cardIdx + 1) + " / " + cardDeck.length;
    el.className = "fc-card pm-pri-" + esc(q.priority);
    el.innerHTML = cardShown
      ? '<blockquote class="fc-quote">&ldquo;' + esc(q.quote) + "&rdquo;</blockquote>" +
        '<div class="fc-meta">' + esc(q.theme || "") +
          (q.chapter != null ? " &middot; ch " + esc(q.chapter) : "") +
          (q.sceneTitle ? " &middot; " + esc(q.sceneTitle) : "") + "</div>" +
        (q.core ? '<div class="fc-core">' + esc(q.core) + "</div>" : "") +
        (q.mnemonic ? '<div class="fc-mnemonic">' + esc(q.mnemonic) + "</div>" : "")
      : '<div class="fc-cue">' + esc(q.cue || q.theme || "Recall the quote") + "</div>" +
        '<div class="fc-tap">tap to reveal</div>';
  }

  function stepCard(n) {
    if (!cardDeck.length) return;
    cardIdx = (cardIdx + n + cardDeck.length) % cardDeck.length;
    cardShown = false;
    renderCardFace();
  }

  function renderCards(container) {
    container.innerHTML =
      '<div class="fc-wrap">' +
        '<div class="fc-bar">' +
          '<select id="fc-filter" class="meta-select" aria-label="Filter cards">' +
            '<option value="all">All quotes</option>' +
            '<option value="1">Memorise first</option>' +
            '<option value="2">Next</option>' +
            '<option value="3">If time</option>' +
          "</select>" +
          '<span class="fc-count" id="fc-count"></span>' +
        "</div>" +
        '<div class="fc-card" id="fc-card" role="button" tabindex="0"></div>' +
        '<div class="fc-nav">' +
          '<button class="pm-pick pm-pick-alt" id="fc-prev">Back</button>' +
          '<button class="pm-pick" id="fc-next">Next</button>' +
        "</div>" +
      "</div>";

    var get = (window.ContentGate && window.ContentGate.getJSON)
      ? function (n) { return window.ContentGate.getJSON(TEXT_BASE, n); }
      : function (n) { return fetch(TEXT_BASE + n).then(function (r) { return r.json(); }); };

    var all = [];
    get("quotes.json").then(function (d) {
      all = d.quotes || [];
      cardDeck = all.slice();
      cardIdx = 0; cardShown = false;
      renderCardFace();
    }).catch(function (e) {
      container.innerHTML = '<p class="pm-err">Could not load quotes. ' + esc(e && e.message) + "</p>";
    });

    document.getElementById("fc-filter").addEventListener("change", function (e) {
      var v = e.target.value;
      cardDeck = v === "all" ? all.slice()
        : all.filter(function (q) { return String(q.priority) === v; });
      cardIdx = 0; cardShown = false;
      renderCardFace();
    });
    var card = document.getElementById("fc-card");
    card.addEventListener("click", function () { cardShown = !cardShown; renderCardFace(); });
    card.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); cardShown = !cardShown; renderCardFace(); }
    });
    document.getElementById("fc-next").addEventListener("click", function () { stepCard(1); });
    document.getElementById("fc-prev").addEventListener("click", function () { stepCard(-1); });
  }

  window.PlotMap = { render: render, renderCards: renderCards, select: select, hasAudio: function () { return loaded; } };
})();
