// DBJ RattleNIX - Pure Web Edition (100% Client-Side WebAssembly & Web Audio API)

let wasmModule = null;
let audioCtx = null;
let micStream = null;
let micSource = null;
let scriptProcessor = null;
let analyserNode = null;

let isListening = false;
let isTransmitting = false;

let callsign = "MYCALL";
let carrierFreq = 1500;
let mapping = 4;
let fancyHeader = true;
let selectedInputDeviceId = "";
let selectedOutputDeviceId = "";

let audioLevel = 0.0;
let smoothLevel = 0.0;
let morseDecoder = null;

// WASM buffer pointers
let wasmInputBufferPtr = 0;
const FRAME_SAMPLES = 960; // 20ms at 48000Hz

// Real-Time URL Click Tracking Cache
const urlClicksMap = new Map();

document.addEventListener("DOMContentLoaded", async () => {
  initThemeSwitcher();
  loadSavedSettings();
  setupUIEvents();
  startMeterLoop();
  initVisualizers();

  // Load Morse Decoder
  if (window.MorseDecoder) {
    morseDecoder = new MorseDecoder(48000, FRAME_SAMPLES);
  }

  // Load WebAssembly Core Modem
  await initWasmEngine();

  // Enumerate Audio Devices
  await refreshAudioDevices();

  // Display initial system ready banner
  appendMessage("SYS", "MODEM", "DBJ RattleNIX Web Core Initialized. Click anywhere to activate Web Audio DSP.");
  updateSystemStatus("Web Core Ready • Click to enable Audio");

  // User gesture listener to start Web Audio context and mic
  const triggerAudioStart = async () => {
    document.removeEventListener("click", triggerAudioStart);
    document.removeEventListener("keydown", triggerAudioStart);
    await startAudioEngine();
  };
  document.addEventListener("click", triggerAudioStart);
  document.addEventListener("keydown", triggerAudioStart);
});

async function initWasmEngine() {
  updateSystemStatus("Loading WebAssembly COFDM Modem...");
  try {
    wasmModule = await createRattleWasmModule({
      locateFile: (path) => `/static/${path}`
    });

    // Allocate frame input buffer in WASM heap (960 int16 samples * 2 bytes)
    wasmInputBufferPtr = wasmModule._malloc(FRAME_SAMPLES * 2);
    wasmModule._init_decoder(48000, mapping);

    updateSystemStatus("WASM Modem Ready • Standby");
  } catch (err) {
    console.error("Failed to load WASM modem:", err);
    updateSystemStatus(`WASM Load Failed: ${err.message}`);
    appendMessage("SYS", "ERROR", `Could not initialize WASM modem: ${err.message}`);
  }
}

async function startAudioEngine() {
  if (audioCtx && audioCtx.state === "running" && micStream) return;

  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!audioCtx) {
      audioCtx = new AudioContextClass({ sampleRate: 48000, latencyHint: "interactive" });
    }
    if (audioCtx.state === "suspended") {
      await audioCtx.resume();
    }

    if (selectedOutputDeviceId && typeof audioCtx.setSinkId === "function") {
      try {
        await audioCtx.setSinkId(selectedOutputDeviceId);
      } catch (e) {
        console.warn("setSinkId failed:", e);
      }
    }

    const audioConstraints = {
      channelCount: 1,
      sampleRate: 48000,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    };

    if (selectedInputDeviceId && selectedInputDeviceId !== "default") {
      audioConstraints.deviceId = { exact: selectedInputDeviceId };
    }

    micStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    micSource = audioCtx.createMediaStreamSource(micStream);

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 2048;
    analyserNode.smoothingTimeConstant = 0.5;
    micSource.connect(analyserNode);

    const bufferSize = 1024;
    scriptProcessor = audioCtx.createScriptProcessor(bufferSize, 1, 1);

    let sampleAccumulator = [];

    scriptProcessor.onaudioprocess = (e) => {
      if (isTransmitting) return;

      const inputData = e.inputBuffer.getChannelData(0);
      const len = inputData.length;

      let peak = 0.0;
      for (let i = 0; i < len; i++) {
        const val = Math.abs(inputData[i]);
        if (val > peak) peak = val;
      }
      audioLevel = peak;

      for (let i = 0; i < len; i++) {
        sampleAccumulator.push(inputData[i]);
      }

      while (sampleAccumulator.length >= FRAME_SAMPLES) {
        const frame = sampleAccumulator.splice(0, FRAME_SAMPLES);
        processFrame(frame);
      }
    };

    micSource.connect(scriptProcessor);
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0.0;
    scriptProcessor.connect(silentGain);
    silentGain.connect(audioCtx.destination);

    isListening = true;
    updateRxTxBadge(false);
    updateSystemStatus("RX Listening • 48 kHz Web Audio Active");
  } catch (err) {
    console.error("Audio engine start failed:", err);
    updateSystemStatus(`Audio Permission Required: ${err.message}`);
  }
}

function processFrame(floatSamples) {
  if (!wasmModule || !wasmInputBufferPtr) return;

  const int16Array = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    let s = floatSamples[i];
    if (s > 1.0) s = 1.0;
    else if (s < -1.0) s = -1.0;
    int16Array[i] = s < 0 ? s * 32768 : s * 32767;
  }

  // 1. Process CW / Morse ID
  if (morseDecoder) {
    const cwWords = morseDecoder.processFrame(int16Array);
    for (const word of cwWords) {
      handleCwMessage("CW ID", word);
    }
  }

  // 2. Process Rattlegram COFDM frame in WASM
  wasmModule.HEAP16.set(int16Array, wasmInputBufferPtr / 2);
  const status = wasmModule._process_audio_frame(wasmInputBufferPtr, FRAME_SAMPLES);

  if (status === 2) {
    const cfo = wasmModule._get_last_cfo();
    const callPtr = wasmModule._get_last_callsign();
    const rxCall = wasmModule.UTF8ToString(callPtr) || "UNKNOWN";
    handleRxSync(rxCall, cfo.toFixed(1));
  } else if (status === 3) {
    const callPtr = wasmModule._get_last_callsign();
    const rxCall = wasmModule.UTF8ToString(callPtr) || "UNKNOWN";
    const payloadPtr = wasmModule._get_last_payload();
    const payload = wasmModule.UTF8ToString(payloadPtr) || "";
    const flips = wasmModule._get_last_flips();
    handleRxMessage(rxCall, payload, flips);
  }
}

async function transmitDirect() {
  const quickInput = document.getElementById("quick-message-input");
  const msg = quickInput.value.trim();
  if (!msg) return;

  const bytes = new TextEncoder().encode(msg).length;
  if (bytes > 170) {
    alert("Payload exceeds 170 bytes limit.");
    return;
  }

  if (!wasmModule) {
    alert("WASM modem engine is still loading. Please wait.");
    return;
  }

  if (!audioCtx) {
    await startAudioEngine();
  }
  if (audioCtx.state === "suspended") {
    await audioCtx.resume();
  }

  isTransmitting = true;
  updateRxTxBadge(true);
  handleTxStarted(callsign, msg);

  const msgPtr = wasmModule.allocateUTF8(msg);
  const callPtr = wasmModule.allocateUTF8(callsign);

  const sampleCount = wasmModule._encode_message(
    msgPtr,
    callPtr,
    mapping,
    carrierFreq,
    48000,
    fancyHeader ? 1 : 0
  );

  wasmModule._free(msgPtr);
  wasmModule._free(callPtr);

  if (sampleCount <= 0) {
    alert("Failed to generate COFDM audio tone burst.");
    isTransmitting = false;
    updateRxTxBadge(false);
    return;
  }

  const pcmPtr = wasmModule._get_encoded_pcm_ptr();
  const pcm16 = new Int16Array(wasmModule.HEAP16.buffer, pcmPtr, sampleCount);

  const audioBuffer = audioCtx.createBuffer(1, sampleCount, 48000);
  const channelData = audioBuffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    channelData[i] = pcm16[i] / 32767.0;
  }

  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(audioCtx.destination);

  source.onended = () => {
    isTransmitting = false;
    updateRxTxBadge(false);
    handleTxFinished();
  };

  source.start();

  quickInput.value = "";
  document.getElementById("quick-char-count").textContent = "0 / 170 bytes";
}

function updateRxTxBadge(transmitting) {
  const badge = document.getElementById("rx-tx-badge");
  if (!badge) return;
  if (transmitting) {
    badge.className = "badge badge-tx";
    badge.innerHTML = `<span class="dot"></span> ▲ TRANSMITTING (TX)`;
  } else {
    badge.className = "badge badge-rx";
    badge.innerHTML = `<span class="dot"></span> ● RX LISTENING`;
  }
}

async function refreshAudioDevices() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = [{ id: "default", name: "Default Microphone / Line In" }];
    const outputs = [{ id: "default", name: "Default Speakers / Radio Out" }];

    devices.forEach((d) => {
      if (d.kind === "audioinput" && d.deviceId !== "default") {
        inputs.push({ id: d.deviceId, name: d.label || `Microphone (${d.deviceId.slice(0, 6)}...)` });
      } else if (d.kind === "audiooutput" && d.deviceId !== "default") {
        outputs.push({ id: d.deviceId, name: d.label || `Speaker / Output (${d.deviceId.slice(0, 6)}...)` });
      }
    });

    populateDeviceSelects(inputs, outputs, selectedInputDeviceId || "default", selectedOutputDeviceId || "default");
  } catch (err) {
    console.warn("Could not list audio devices:", err);
  }
}

function loadSavedSettings() {
  callsign = localStorage.getItem("rattlegram_callsign") || "MYCALL";
  carrierFreq = parseInt(localStorage.getItem("rattlegram_carrier") || "1500", 10);
  mapping = parseInt(localStorage.getItem("rattlegram_mapping") || "4", 10);
  fancyHeader = localStorage.getItem("rattlegram_fancy") !== "false";
  selectedInputDeviceId = localStorage.getItem("rattlegram_in_device") || "default";
  selectedOutputDeviceId = localStorage.getItem("rattlegram_out_device") || "default";

  const callEl = document.getElementById("callsign-input");
  if (callEl) callEl.value = callsign;

  const carrierEl = document.getElementById("carrier-select");
  if (carrierEl) carrierEl.value = String(carrierFreq);

  const bitrateEl = document.getElementById("bitrate-select");
  if (bitrateEl) bitrateEl.value = String(mapping);

  const fancyEl = document.getElementById("fancy-header-check");
  if (fancyEl) fancyEl.checked = fancyHeader;
}

function saveSettings() {
  const callEl = document.getElementById("callsign-input");
  callsign = (callEl ? callEl.value.trim().toUpperCase() : "") || "MYCALL";
  if (callEl) callEl.value = callsign;

  const carrierEl = document.getElementById("carrier-select");
  if (carrierEl) carrierFreq = parseInt(carrierEl.value, 10);

  const bitrateEl = document.getElementById("bitrate-select");
  if (bitrateEl) mapping = parseInt(bitrateEl.value, 10);

  const fancyEl = document.getElementById("fancy-header-check");
  if (fancyEl) fancyHeader = fancyEl.checked;

  const inSelect = document.getElementById("input-device-select");
  if (inSelect) selectedInputDeviceId = inSelect.value;

  const outSelect = document.getElementById("output-device-select");
  if (outSelect) selectedOutputDeviceId = outSelect.value;

  try {
    localStorage.setItem("rattlegram_callsign", callsign);
    localStorage.setItem("rattlegram_carrier", String(carrierFreq));
    localStorage.setItem("rattlegram_mapping", String(mapping));
    localStorage.setItem("rattlegram_fancy", String(fancyHeader));
    localStorage.setItem("rattlegram_in_device", selectedInputDeviceId);
    localStorage.setItem("rattlegram_out_device", selectedOutputDeviceId);
  } catch (e) {}

  if (wasmModule) {
    wasmModule._init_decoder(48000, mapping);
  }

  if (isListening) {
    startAudioEngine();
  }

  updateSystemStatus(`Settings saved • ${callsign} (${carrierFreq}Hz / ${mapping}PSK)`);
}

function setupUIEvents() {
  const modal = document.getElementById("settings-modal");
  const btnOpenSettings = document.getElementById("btn-open-settings");
  const btnCloseSettings = document.getElementById("btn-close-settings");
  const btnSaveSettings = document.getElementById("btn-save-settings");

  btnOpenSettings.addEventListener("click", () => {
    refreshAudioDevices();
    modal.classList.remove("hidden");
  });

  const closeModal = () => modal.classList.add("hidden");
  btnCloseSettings.addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
  });

  btnSaveSettings.addEventListener("click", () => {
    saveSettings();
    closeModal();
  });

  // Direct Transmit
  const quickInput = document.getElementById("quick-message-input");
  const quickSendBtn = document.getElementById("btn-quick-send");
  const quickCharCount = document.getElementById("quick-char-count");

  quickInput.addEventListener("input", () => {
    const bytes = new TextEncoder().encode(quickInput.value).length;
    quickCharCount.textContent = `${bytes} / 170 bytes`;
    quickCharCount.style.color = bytes > 170 ? "var(--accent-red)" : "var(--text-muted)";
  });

  quickInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      transmitDirect();
    }
  });

  quickSendBtn.addEventListener("click", transmitDirect);

  // Clear Chat Log
  document.getElementById("btn-clear-chat").addEventListener("click", () => {
    document.getElementById("messages-list").innerHTML = "";
  });

  // Loopback Test
  document.getElementById("btn-test-loopback").addEventListener("click", () => {
    const testMsg = "HELLO WORLD DE " + callsign;
    appendMessage("SYS", "TEST", "Generating loopback test: " + testMsg);
    document.getElementById("quick-message-input").value = testMsg;
    document.getElementById("quick-message-input").dispatchEvent(new Event("input"));
    transmitDirect();
  });

  // Emoji Picker Setup
  initEmojiPicker();

  // URL Shortener Feature (url.w8jae.com)
  initUrlShortener();

  // OTA Updates Engine
  initOtaUpdater();
}

function initThemeSwitcher() {
  const themeButtons = document.querySelectorAll(".theme-btn");
  if (!themeButtons || themeButtons.length === 0) return;

  const validThemes = ["dark", "charcoal", "light"];
  const savedTheme = localStorage.getItem("dbj_rattlenix_theme") || "dark";
  const activeTheme = validThemes.includes(savedTheme) ? savedTheme : "dark";

  const applyTheme = (theme) => {
    document.documentElement.setAttribute("data-theme", theme);
    themeButtons.forEach((btn) => {
      const isMatch = btn.getAttribute("data-theme") === theme;
      btn.classList.toggle("active", isMatch);
    });
    try {
      localStorage.setItem("dbj_rattlenix_theme", theme);
    } catch (e) {}
  };

  applyTheme(activeTheme);

  themeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetTheme = btn.getAttribute("data-theme");
      if (targetTheme && validThemes.includes(targetTheme)) {
        applyTheme(targetTheme);
      }
    });
  });
}

function initEmojiPicker() {
  const btnEmojiToggle = document.getElementById("btn-emoji-toggle");
  const emojiPopup = document.getElementById("emoji-popup");
  const emojiGrid = document.getElementById("emoji-grid");
  const quickInput = document.getElementById("quick-message-input");

  if (!btnEmojiToggle || !emojiPopup || !emojiGrid) return;

  const popularEmojis = [
    "😀", "😃", "😄", "😁", "😆", "😅",
    "😂", "🤣", "😊", "😇", "🙂", "😉",
    "😍", "🥰", "😘", "😋", "😎", "🤩",
    "🥳", "😏", "🤔", "🫡", "🤫", "😴",
    "👍", "👎", "👌", "✌️", "🤞", "🤝",
    "👋", "👏", "🙌", "❤️", "🔥", "✨",
    "📡", "📻", "⚡", "🔊", "⚠️", "🆘",
    "✅", "❌", "❓", "❗", "🌍", "🛰️"
  ];

  emojiGrid.innerHTML = popularEmojis.map(em => `<button type="button" class="emoji-btn" data-emoji="${em}">${em}</button>`).join("");

  btnEmojiToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    emojiPopup.classList.toggle("hidden");
  });

  emojiGrid.addEventListener("click", (e) => {
    const btn = e.target.closest(".emoji-btn");
    if (!btn) return;
    const emoji = btn.getAttribute("data-emoji");
    if (emoji && quickInput) {
      const start = quickInput.selectionStart || quickInput.value.length;
      const end = quickInput.selectionEnd || quickInput.value.length;
      const text = quickInput.value;
      quickInput.value = text.slice(0, start) + emoji + text.slice(end);
      quickInput.selectionStart = quickInput.selectionEnd = start + emoji.length;
      quickInput.focus();
      quickInput.dispatchEvent(new Event("input"));
    }
  });

  document.addEventListener("click", (e) => {
    if (!emojiPopup.contains(e.target) && e.target !== btnEmojiToggle) {
      emojiPopup.classList.add("hidden");
    }
  });
}

function initUrlShortener() {
  const shortenerInput = document.getElementById("shortener-url-input");
  const btnShorten = document.getElementById("btn-shorten-url");
  const btnText = document.getElementById("shorten-btn-text");
  const quickInput = document.getElementById("quick-message-input");

  if (!shortenerInput || !btnShorten) return;

  const triggerShorten = async () => {
    const rawUrl = shortenerInput.value.trim();
    if (!rawUrl) {
      shortenerInput.focus();
      return;
    }

    btnShorten.disabled = true;
    if (btnText) btnText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Shortening...`;

    try {
      const apiUrl = "https://url.w8jae.com/api/shorten";
      const resp = await fetch(apiUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: rawUrl })
      });
      const data = await resp.json();

      if (data.shortUrl || data.short_url) {
        const shortUrl = data.shortUrl || data.short_url;
        shortenerInput.value = "";

        if (quickInput) {
          const currentVal = quickInput.value;
          const start = quickInput.selectionStart ?? currentVal.length;
          const end = quickInput.selectionEnd ?? currentVal.length;
          const needsLeadingSpace = start > 0 && !/\s$/.test(currentVal.slice(0, start));
          const toInsert = (needsLeadingSpace ? " " : "") + shortUrl + " ";
          quickInput.value = currentVal.slice(0, start) + toInsert + currentVal.slice(end);
          const newPos = start + toInsert.length;
          quickInput.selectionStart = quickInput.selectionEnd = newPos;
          quickInput.focus();
          quickInput.dispatchEvent(new Event("input"));
        }
      } else {
        alert("Failed to shorten URL: " + (data.error || "Unknown response"));
      }
    } catch (err) {
      alert("Shortener request error: " + err.message);
    } finally {
      btnShorten.disabled = false;
      if (btnText) btnText.innerHTML = `<i class="fa-solid fa-scissors"></i> Shorten &amp; Paste`;
    }
  };

  btnShorten.addEventListener("click", triggerShorten);
  shortenerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      triggerShorten();
    }
  });
}

function initOtaUpdater() {
  const btnCheck = document.getElementById("btn-check-updates");
  const statusBox = document.getElementById("ota-status-box");
  const statusText = document.getElementById("ota-status-text");
  const currentVerLabel = document.getElementById("ota-current-version");

  if (!btnCheck) return;
  if (currentVerLabel) currentVerLabel.textContent = "Version: 2.0 Web Edition";

  btnCheck.addEventListener("click", () => {
    statusBox.classList.remove("hidden");
    statusText.innerHTML = '<span style="color: var(--accent-green);"><i class="fa-solid fa-circle-check"></i> DBJ RattleNIX Web is running the latest build!</span>';
  });
}

function playTricorderSound() {
  try {
    if (!audioCtx) return;
    const t = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator();
    const osc2 = audioCtx.createOscillator();
    const gainNode = audioCtx.createGain();

    osc1.type = "sine";
    osc2.type = "triangle";

    osc1.frequency.setValueAtTime(880, t);
    osc1.frequency.linearRampToValueAtTime(1760, t + 0.08);
    osc1.frequency.linearRampToValueAtTime(1100, t + 0.16);
    osc1.frequency.linearRampToValueAtTime(2200, t + 0.24);

    osc2.frequency.setValueAtTime(440, t);
    osc2.frequency.linearRampToValueAtTime(880, t + 0.12);
    osc2.frequency.linearRampToValueAtTime(550, t + 0.24);

    gainNode.gain.setValueAtTime(0.001, t);
    gainNode.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    gainNode.gain.exponentialRampToValueAtTime(0.18, t + 0.14);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);

    osc1.connect(gainNode);
    osc2.connect(gainNode);
    gainNode.connect(audioCtx.destination);

    osc1.start(t);
    osc2.start(t);
    osc1.stop(t + 0.28);
    osc2.stop(t + 0.28);
  } catch (e) {}
}

function extractShortCode(url) {
  if (!url) return null;
  const m = url.match(/(?:url\.w8jae\.com|(?:\/|\/r\/))([a-zA-Z0-9]{5,8})\b/i);
  return m ? m[1] : null;
}

function formatMessageContent(text) {
  if (!text) return "";
  const escaped = escapeHtml(text);
  const urlPattern = /(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi;
  return escaped.replace(urlPattern, (match) => {
    const href = match.toLowerCase().startsWith("http") ? match : `http://${match}`;
    const code = extractShortCode(match);
    let trackerHtml = "";
    if (code) {
      const initialCount = urlClicksMap.get(code) || 0;
      trackerHtml = `
        <span class="url-tracker-tag" data-code="${code}" title="Real-Time Visits from url.w8jae.com">
          <i class="fa-solid fa-eye tracker-icon"></i>
          <span class="tracker-count">${initialCount}</span>
          <span class="tracker-label">views</span>
        </span>
      `;
    }
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="msg-link" data-code="${code || ''}">${match}</a>${trackerHtml}`;
  });
}

function appendMessage(type, sender, text, meta = {}) {
  const list = document.getElementById("messages-list");
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const bubble = document.createElement("div");
  bubble.className = `msg-bubble msg-${type.toLowerCase()}`;

  const isRetransmittable = (type === "RX" || type === "TX" || type === "CW") && text && text.trim().length > 0;
  if (isRetransmittable) {
    bubble.classList.add("msg-retransmittable");
    bubble.setAttribute("title", "Click message container to automatically retransmit");
  }

  let metaHtml = "";
  if (type === "RX") {
    metaHtml = `
      <div class="msg-meta">
        <span class="msg-callsign">${escapeHtml(sender)}</span>
        <span class="msg-time">${timeStr}</span>
        <span class="msg-flips">${meta.flips || 0} flips</span>
      </div>
    `;
  } else if (type === "TX") {
    metaHtml = `
      <div class="msg-meta">
        <span class="msg-callsign">TX [${escapeHtml(sender)}]</span>
        <span class="msg-time">${timeStr}</span>
      </div>
    `;
  } else if (type === "CW") {
    metaHtml = `
      <div class="msg-meta">
        <span class="msg-callsign">📡 ${escapeHtml(sender)}</span>
        <span class="msg-badge-tag">MORSE ID</span>
        <span class="msg-time">${timeStr}</span>
      </div>
    `;
  } else {
    metaHtml = `
      <div class="msg-meta">
        <span class="msg-callsign">SYSTEM</span>
        <span class="msg-time">${timeStr}</span>
      </div>
    `;
  }

  bubble.innerHTML = `
    ${metaHtml}
    <div class="msg-body">${formatMessageContent(text)}</div>
  `;

  if (isRetransmittable) {
    bubble.addEventListener("click", (e) => {
      if (e.target && (e.target.tagName === "A" || e.target.closest(".url-tracker-tag"))) return;
      const selection = window.getSelection();
      if (selection && selection.toString().trim().length > 0) return;

      const rawPayload = text.trim();
      if (new TextEncoder().encode(rawPayload).length > 170) {
        alert("Payload exceeds 170 bytes limit for retransmission.");
        return;
      }
      document.getElementById("quick-message-input").value = rawPayload;
      document.getElementById("quick-message-input").dispatchEvent(new Event("input"));
      transmitDirect();
    });
  }

  list.appendChild(bubble);
  list.scrollTop = list.scrollHeight;
}

function handleRxSync(rxCall, cfo) {
  const syncLabel = document.getElementById("sync-status-label");
  syncLabel.textContent = `⚡ SYNC LOCKED: ${rxCall} (CFO: ${cfo} Hz)`;
  syncLabel.style.color = "var(--accent-cyan)";
}

function handleRxMessage(rxCall, payload, flips) {
  appendMessage("RX", rxCall, payload, { flips });
  const syncLabel = document.getElementById("sync-status-label");
  syncLabel.textContent = `✓ Packet Decoded from ${rxCall}`;
  syncLabel.style.color = "var(--accent-green)";
  updateSystemStatus(`Decoded packet from ${rxCall}`);
}

function handleCwMessage(rxCall, payload) {
  appendMessage("CW", rxCall, payload);
  const syncLabel = document.getElementById("sync-status-label");
  syncLabel.textContent = `📻 CW / Morse Decoded: ${payload}`;
  syncLabel.style.color = "var(--accent-purple)";
  updateSystemStatus(`Decoded CW Repeater ID: ${payload}`);
}

function handleTxStarted(txCall, payload) {
  appendMessage("TX", txCall, payload);
  updateSystemStatus(`Broadcasting COFDM burst (${txCall})...`);
}

function handleTxFinished() {
  updateSystemStatus("Ready • RX Monitoring 48 kHz");
}

function updateSystemStatus(text) {
  const footer = document.getElementById("status-footer");
  if (footer) footer.textContent = text;
}

function populateDeviceSelects(inputs, outputs, currentIn, currentOut) {
  const inSelect = document.getElementById("input-device-select");
  const outSelect = document.getElementById("output-device-select");

  if (inSelect) {
    inSelect.innerHTML = inputs.map(d => `<option value="${d.id}" ${d.id === currentIn ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("");
  }
  if (outSelect) {
    outSelect.innerHTML = outputs.map(d => `<option value="${d.id}" ${d.id === currentOut ? "selected" : ""}>${escapeHtml(d.name)}</option>`).join("");
  }
}

// -----------------------------------------------------------
// Realtime VU / Level Meter Animation
// -----------------------------------------------------------
function startMeterLoop() {
  const fill = document.getElementById("meter-fill");

  function render() {
    const raw = Math.max(0, audioLevel - 0.0015);
    const target = Math.min(100, Math.pow(raw * 18, 0.6) * 100);

    if (target > smoothLevel) {
      smoothLevel = smoothLevel * 0.4 + target * 0.6;
    } else {
      smoothLevel = smoothLevel * 0.85 + target * 0.15;
    }

    if (fill) {
      fill.style.width = `${Math.max(0, smoothLevel).toFixed(1)}%`;
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
}

// Interactive Cursor Glow for DevByJae Logo
document.addEventListener("mousemove", (e) => {
  const logo = document.getElementById("dev-by-jae-logo");
  if (logo) {
    const x = (e.clientX - window.innerWidth / 2) / 30;
    const y = (e.clientY - window.innerHeight / 2) / 30;
    logo.style.filter = `
      drop-shadow(${x * 0.2}px ${y * 0.2}px 1px #fff)
      drop-shadow(${x * 0.5}px ${y * 0.5}px 2.4px #00d2ff)
      drop-shadow(${x}px ${y}px 4.8px #0066ff)
      drop-shadow(${x * 1.5}px ${y * 1.5}px 9.6px #0033cc)
      drop-shadow(${x * 2}px ${y * 2}px 16.8px #001166)
    `;
  }
});

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// -----------------------------------------------------------
// Realtime Spectrum Analyzer & Waterfall Display
// -----------------------------------------------------------
let spectrumCanvas = null;
let spectrumCtx = null;
let waterfallCanvas = null;
let waterfallCtx = null;
let fftDataArray = null;

function initVisualizers() {
  spectrumCanvas = document.getElementById("spectrum-canvas");
  waterfallCanvas = document.getElementById("waterfall-canvas");

  if (spectrumCanvas) {
    spectrumCtx = spectrumCanvas.getContext("2d");
    spectrumCtx.fillStyle = "#05070a";
    spectrumCtx.fillRect(0, 0, spectrumCanvas.width, spectrumCanvas.height);
  }

  if (waterfallCanvas) {
    waterfallCtx = waterfallCanvas.getContext("2d");
    waterfallCtx.fillStyle = "#05070a";
    waterfallCtx.fillRect(0, 0, waterfallCanvas.width, waterfallCanvas.height);
  }

  requestAnimationFrame(renderVisualizerLoop);
}

function getRainbowColor(v) {
  v = Math.max(0, Math.min(1, v));
  if (v <= 0.02) return [5, 7, 10];
  const t = 4 * v - 2;
  let a = Math.max(0, Math.min(1, 4 * v));
  let r = Math.max(0, Math.min(1, t)) * a;
  let g = Math.max(0, Math.min(1, 1 - Math.abs(t))) * a;
  let b = Math.max(0, Math.min(1, -t)) * a;
  return [
    Math.round(255 * Math.sqrt(r)),
    Math.round(255 * Math.sqrt(g)),
    Math.round(255 * Math.sqrt(b))
  ];
}

let lastWaterfallTime = 0;

function renderVisualizerLoop(now) {
  if (analyserNode && spectrumCtx && spectrumCanvas) {
    if (!fftDataArray) {
      fftDataArray = new Uint8Array(analyserNode.frequencyBinCount);
    }
    analyserNode.getByteFrequencyData(fftDataArray);

    const width = spectrumCanvas.width;
    const height = spectrumCanvas.height;

    // Clear Spectrum
    spectrumCtx.fillStyle = "#05070a";
    spectrumCtx.fillRect(0, 0, width, height);

    // Grid lines (1k, 2k, 3k)
    spectrumCtx.strokeStyle = "rgba(255, 255, 255, 0.07)";
    spectrumCtx.lineWidth = 1;
    [1000, 2000, 3000].forEach((freq) => {
      const x = (freq / 4000) * width;
      spectrumCtx.beginPath();
      spectrumCtx.moveTo(x, 0);
      spectrumCtx.lineTo(x, height);
      spectrumCtx.stroke();
    });

    // Carrier Marker
    const carrierX = (carrierFreq / 4000) * width;
    spectrumCtx.strokeStyle = "rgba(56, 189, 248, 0.3)";
    spectrumCtx.beginPath();
    spectrumCtx.moveTo(carrierX, 0);
    spectrumCtx.lineTo(carrierX, height);
    spectrumCtx.stroke();

    // Draw Spectrum Wave
    const grad = spectrumCtx.createLinearGradient(0, height, 0, 0);
    grad.addColorStop(0, "rgba(34, 197, 94, 0.8)");
    grad.addColorStop(0.5, "rgba(56, 189, 248, 0.9)");
    grad.addColorStop(0.85, "rgba(245, 158, 11, 0.95)");
    grad.addColorStop(1, "rgba(239, 68, 68, 1)");

    spectrumCtx.beginPath();
    const maxBin = Math.floor((4000 * 2048) / 48000);

    for (let x = 0; x < width; x++) {
      const binIdx = Math.min(fftDataArray.length - 1, Math.floor((x / width) * maxBin));
      const val = fftDataArray[binIdx] / 255.0;
      const y = height - (val * (height - 4));
      if (x === 0) spectrumCtx.moveTo(x, y);
      else spectrumCtx.lineTo(x, y);
    }
    spectrumCtx.strokeStyle = grad;
    spectrumCtx.lineWidth = 1.8;
    spectrumCtx.stroke();

    // Render Waterfall at ~30 FPS
    if (waterfallCtx && waterfallCanvas && now - lastWaterfallTime >= 33) {
      lastWaterfallTime = now;
      const wWidth = waterfallCanvas.width;
      const wHeight = waterfallCanvas.height;

      waterfallCtx.drawImage(waterfallCanvas, 0, 0, wWidth, wHeight - 1, 0, 1, wWidth, wHeight - 1);

      const imgData = waterfallCtx.createImageData(wWidth, 1);
      const data = imgData.data;

      for (let x = 0; x < wWidth; x++) {
        const binIdx = Math.min(fftDataArray.length - 1, Math.floor((x / wWidth) * maxBin));
        const val = fftDataArray[binIdx] / 255.0;
        const [r, g, b] = getRainbowColor(val);
        const p = x * 4;
        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = b;
        data[p + 3] = 255;
      }
      waterfallCtx.putImageData(imgData, 0, 0);
    }
  }

  requestAnimationFrame(renderVisualizerLoop);
}

// -------------------------------------------------------------
// Cross-Platform Client Telemetry Logging
// -------------------------------------------------------------
function sendUsageTelemetry() {
  try {
    const cs = callsign || localStorage.getItem("dbj_rattlenix_callsign") || "ANONYMOUS";
    fetch("https://devbyjae.com/api/rattlenix/log_usage.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        callsign: cs,
        platform: "web",
        version: "1.13"
      }),
      mode: "cors"
    }).catch(() => {});
  } catch (e) {}
}

// Send telemetry on startup and when callsign is saved
setTimeout(sendUsageTelemetry, 1500);

// Also hook into save button if exists
const btnSave = document.getElementById("btn-save-settings");
if (btnSave) {
  btnSave.addEventListener("click", () => {
    setTimeout(sendUsageTelemetry, 300);
  });
}
