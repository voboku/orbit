(() => {
  const canvas = document.getElementById("field");
  const ctx = canvas.getContext("2d", { alpha: true });
  const readout = document.getElementById("readout");
  const bpmInput = document.getElementById("bpm");
  const gravityInput = document.getElementById("gravity");
  const chaosInput = document.getElementById("chaos");
  const recordButton = document.getElementById("record");
  const stopButton = document.getElementById("stop");
  const clearButton = document.getElementById("clear");
  const sampleButton = document.getElementById("sampleButton");
  const sampleInput = document.getElementById("sampleInput");
  const samplePanelToggle = document.getElementById("samplePanelToggle");
  const planetList = document.getElementById("planetList");
  const planetPanel = document.querySelector(".planet-panel");
  const toolButtons = Array.from(document.querySelectorAll(".tool"));

  const TAU = Math.PI * 2;
  const state = {
    dpr: 1,
    width: 1,
    height: 1,
    cx: 0,
    cy: 0,
    tool: "planet",
    bpm: Number(bpmInput.value),
    gravity: Number(gravityInput.value),
    chaos: Number(chaosInput.value),
    audioReady: false,
    stopped: false,
    muted: false,
    camera: { x: 0, y: 0, scale: 1 },
    pointers: new Map(),
    pinch: null,
    dragging: null,
    drawing: null,
    sampleTarget: null,
    recorderNode: null,
    recorderSilent: null,
    recordedChunks: [],
    recording: false,
    recordingReady: false,
    lastRecordingBlob: null,
    lastRecordingUrl: "",
    lastRecordingName: "",
    wakeLock: null,
    lastTime: performance.now(),
    pulse: [],
    intersections: [],
    eventCount: 0,
    lastEventSecond: 0
  };

  const orbits = [];
  const bodies = [];
  let audio = null;

  function rnd(min, max) {
    return min + Math.random() * (max - min);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function uid() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function wrapAngle(value) {
    return ((value % TAU) + TAU) % TAU;
  }

  function crossedAngle(previous, current, target, direction) {
    const prev = wrapAngle(previous - target);
    const now = wrapAngle(current - target);
    return direction >= 0 ? prev > now : prev < now;
  }

  function beatClock(time) {
    return time * state.bpm / 60;
  }

  function grooveWave(time, phase = 0, rate = 1, skew = 0.35) {
    const beat = beatClock(time);
    const main = Math.sin((beat * rate + phase) * TAU);
    const offbeat = Math.sin((beat * (rate * 2) + phase * 0.7) * TAU + Math.PI * skew);
    return main * 0.68 + offbeat * 0.32;
  }

  function orbitGroove(orbit, time) {
    return grooveWave(time, orbit.groovePhase, orbit.grooveRate, orbit.grooveSkew);
  }

  function pick(values) {
    return values[Math.floor(Math.random() * values.length)];
  }

  function beatsForRadius(radius) {
    if (radius < 12) return pick([0.5, 0.75, 1, 1.5]);
    if (radius < 24) return pick([0.75, 1, 1.5, 2, 3]);
    if (radius < 54) return pick([1.5, 2, 3, 4, 5]);
    if (radius < 110) return pick([3, 4, 5, 6, 7]);
    return pick([4, 5, 6, 7, 8, 12]);
  }

  function resize() {
    state.dpr = Math.min(2, window.devicePixelRatio || 1);
    state.width = window.innerWidth;
    state.height = window.innerHeight;
    state.cx = state.width * 0.5;
    state.cy = state.height * 0.5;
    canvas.width = Math.floor(state.width * state.dpr);
    canvas.height = Math.floor(state.height * state.dpr);
    canvas.style.width = `${state.width}px`;
    canvas.style.height = `${state.height}px`;
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    ctx.fillStyle = "#f7f8f6";
    ctx.fillRect(0, 0, state.width, state.height);
  }

  function screenToWorld(point) {
    return {
      x: (point.x - state.camera.x) / state.camera.scale,
      y: (point.y - state.camera.y) / state.camera.scale
    };
  }

  function screenPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    };
  }

  function zoomAt(screenPoint, nextScale) {
    const before = screenToWorld(screenPoint);
    state.camera.scale = clamp(nextScale, 0.25, 4);
    state.camera.x = screenPoint.x - before.x * state.camera.scale;
    state.camera.y = screenPoint.y - before.y * state.camera.scale;
  }

  function makeOrbit(x, y, radius, tilt = rnd(-0.35, 0.35), options = {}) {
    const orbit = {
      id: uid(),
      x,
      y,
      r: clamp(radius, 4, Math.min(state.width, state.height) * 0.42),
      sx: rnd(0.68, 1.36),
      sy: rnd(0.54, 1.12),
      tilt,
      spin: rnd(-0.72, 0.72),
      wobble: rnd(0.1, 1.2),
      phase: rnd(0, TAU),
      groovePhase: rnd(0, 1),
      grooveRate: pick([0.5, 0.75, 1, 1.5, 2, 3]),
      grooveDepth: rnd(0.55, 1.25),
      grooveSkew: rnd(0.12, 0.72),
      shapeDrift: pick([0.5, 1, 1.5, 2.5]),
      gates: [{ id: uid(), angle: -Math.PI / 2, muted: false }],
      beats: options.beats || beatsForRadius(radius),
      muted: false
    };
    const count = options.bodyCount || 1;
    let firstBody = null;
    for (let i = 0; i < count; i += 1) {
      const direction = Math.random() > 0.5 ? 1 : -1;
      const body = {
        orbit,
        id: uid(),
        angle: rnd(0, TAU),
        direction,
        speed: direction,
        mass: rnd(0.7, 1.5),
        size: rnd(3.2, 5.8),
        x,
        y,
        px: x,
        py: y,
        lastTrigger: 0,
        lastLoopTrigger: 0,
        muted: false,
        sample: null,
        sampleName: "",
        volume: 1,
        pitch: 0,
        activeSample: null,
        colorSeed: rnd(0, 1)
      };
      bodies.push(body);
      if (!firstBody) firstBody = body;
    }
    orbits.push(orbit);
    return { orbit, body: firstBody };
  }

  function resetField() {
    stopActiveSamples();
    orbits.length = 0;
    bodies.length = 0;
    state.sampleTarget = null;
    updateSampleButton(null);
    renderPlanetList();
  }

  function stopBodySample(body) {
    if (!body || !body.activeSample) return;
    try {
      body.activeSample.src.stop();
    } catch (error) {
      // The source may already be stopped.
    }
    body.activeSample = null;
  }

  function stopOrbitSamples(orbit) {
    for (const body of bodies) {
      if (body.orbit === orbit) stopBodySample(body);
    }
  }

  function stopActiveSamples() {
    for (const body of bodies) {
      stopBodySample(body);
    }
  }

  function stopTransport() {
    state.stopped = true;
    stopActiveSamples();
    stopButton.textContent = "start";
  }

  function bodyLabel(body, index) {
    return body.sampleName || `planet ${index + 1}`;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function renderPlanetList() {
    if (!planetList) return;
    if (!bodies.length) {
      planetList.innerHTML = '<div class="planet-empty">no samples</div>';
      return;
    }
    planetList.innerHTML = bodies.map((body, index) => {
      const selected = body === state.sampleTarget ? " selected" : "";
      const muted = body.muted || body.orbit.muted ? " muted" : "";
      const name = bodyLabel(body, index);
      const safeName = escapeHtml(name);
      const volume = Math.round(body.volume * 100);
      const pitch = Math.round(body.pitch * 10) / 10;
      return `
        <article class="planet-row${selected}${muted}" data-body-id="${body.id}">
          <div class="planet-main">
            <button type="button" data-action="replace" title="replace sample">◇︎</button>
            <div class="planet-name" title="${safeName}">${safeName}</div>
            <button type="button" data-action="mute" title="mute">${body.muted ? "○︎" : "◐︎"}</button>
            <button type="button" data-action="delete" title="delete">×︎</button>
          </div>
          <label class="planet-param">
            <span>vol</span>
            <input type="range" min="0" max="1.5" step="0.01" value="${body.volume}" data-param="volume">
            <output>${volume}</output>
          </label>
          <label class="planet-param">
            <span>pit</span>
            <input type="range" min="-12" max="12" step="0.1" value="${body.pitch}" data-param="pitch">
            <output>${pitch}</output>
          </label>
        </article>
      `;
    }).join("");
  }

  function findBodyById(id) {
    return bodies.find((body) => body.id === id) || null;
  }

  function startTransport() {
    resumeAudio().then(() => {
      state.audioReady = true;
      state.stopped = false;
      stopButton.textContent = "stop";
    });
  }

  function startRecording() {
    resumeAudio()
      .then(() => {
        startWavRecording();
      })
      .catch(() => {
        recordButton.textContent = "no rec";
        window.setTimeout(() => {
          recordButton.textContent = state.recordingReady ? "save" : "rec";
        }, 1400);
      });
  }

  function stopRecording() {
    if (!state.recording) return;
    stopWavRecording();
  }

  function saveRecording() {
    if (!state.lastRecordingBlob || !state.lastRecordingUrl) return;
    const link = document.createElement("a");
    link.href = state.lastRecordingUrl;
    link.download = state.lastRecordingName || `${recordingFileStamp()}.wav`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    state.recordingReady = false;
    recordButton.textContent = "rec";
    recordButton.classList.remove("ready");
  }

  function startWavRecording() {
    if (!audio || !audio.comp || !audio.ctx.createScriptProcessor) {
      recordButton.textContent = "no rec";
      window.setTimeout(() => {
        recordButton.textContent = state.recordingReady ? "save" : "rec";
      }, 1400);
      return;
    }
    if (state.lastRecordingUrl) {
      URL.revokeObjectURL(state.lastRecordingUrl);
    }
    state.lastRecordingBlob = null;
    state.lastRecordingUrl = "";
    state.lastRecordingName = "";
    state.recordingReady = false;
    const node = audio.ctx.createScriptProcessor(4096, 2, 2);
    const silent = audio.ctx.createGain();
    silent.gain.value = 0;
    state.recordedChunks = [];
    node.onaudioprocess = (event) => {
      if (!state.recording) return;
      const left = new Float32Array(event.inputBuffer.getChannelData(0));
      const right = event.inputBuffer.numberOfChannels > 1
        ? new Float32Array(event.inputBuffer.getChannelData(1))
        : new Float32Array(left);
      state.recordedChunks.push([left, right]);
      for (let channel = 0; channel < event.outputBuffer.numberOfChannels; channel += 1) {
        event.outputBuffer.getChannelData(channel).fill(0);
      }
    };
    audio.comp.connect(node);
    node.connect(silent);
    silent.connect(audio.ctx.destination);
    state.recorderNode = node;
    state.recorderSilent = silent;
    state.recording = true;
    state.audioReady = true;
    state.stopped = false;
    stopButton.textContent = "stop";
    recordButton.textContent = "stop";
    recordButton.classList.add("recording");
    recordButton.classList.remove("ready");
  }

  function stopWavRecording() {
    state.recording = false;
    recordButton.classList.remove("recording");
    if (state.recorderNode) {
      try {
        audio.comp.disconnect(state.recorderNode);
      } catch (error) {}
      state.recorderNode.disconnect();
    }
    if (state.recorderSilent) state.recorderSilent.disconnect();
    state.recorderNode = null;
    state.recorderSilent = null;
    const blob = encodeWav(state.recordedChunks, audio.ctx.sampleRate);
    state.recordedChunks = [];
    if (!blob || !blob.size || blob.size <= 44) {
      state.recordingReady = false;
      recordButton.textContent = "empty";
      window.setTimeout(() => {
        recordButton.textContent = "rec";
      }, 1400);
      return;
    }
    state.lastRecordingBlob = blob;
    state.lastRecordingUrl = URL.createObjectURL(blob);
    state.lastRecordingName = `${recordingFileStamp()}.wav`;
    state.recordingReady = true;
    recordButton.textContent = "save";
    recordButton.classList.add("ready");
  }

  function encodeWav(chunks, sampleRate) {
    const frames = chunks.reduce((sum, chunk) => sum + chunk[0].length, 0);
    const buffer = new ArrayBuffer(44 + frames * 4);
    const view = new DataView(buffer);
    writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + frames * 4, true);
    writeString(view, 8, "WAVE");
    writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 2, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 4, true);
    view.setUint16(32, 4, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, "data");
    view.setUint32(40, frames * 4, true);
    let offset = 44;
    for (const [left, right] of chunks) {
      for (let i = 0; i < left.length; i += 1) {
        view.setInt16(offset, clamp(left[i], -1, 1) * 0x7fff, true);
        offset += 2;
        view.setInt16(offset, clamp(right[i], -1, 1) * 0x7fff, true);
        offset += 2;
      }
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  function writeString(view, offset, value) {
    for (let i = 0; i < value.length; i += 1) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  }

  function recordingFileStamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, "0");
    return [
      "recording",
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`,
      `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    ].join("-");
  }

  function requestWakeLock() {
    if (!navigator.wakeLock || state.wakeLock) return;
    navigator.wakeLock.request("screen").then((lock) => {
      state.wakeLock = lock;
      lock.addEventListener("release", () => {
        state.wakeLock = null;
      });
    }).catch(() => {});
  }

  function pointerPosition(event) {
    return screenToWorld(screenPosition(event));
  }

  function rotatePoint(x, y, tilt) {
    const c = Math.cos(tilt);
    const s = Math.sin(tilt);
    return { x: x * c - y * s, y: x * s + y * c };
  }

  function orbitAngleAtPoint(orbit, point, time) {
    const groove = orbitGroove(orbit, time) * orbit.grooveDepth;
    const tilt = orbit.tilt + groove * orbit.spin * state.chaos * 0.08;
    const c = Math.cos(-tilt);
    const s = Math.sin(-tilt);
    const dx = point.x - orbit.x;
    const dy = point.y - orbit.y;
    const localX = dx * c - dy * s;
    const localY = dx * s + dy * c;
    const breathing = 1 + groove * state.chaos * 0.07;
    return Math.atan2(localY / orbit.sy, localX / (orbit.sx * breathing));
  }

  function pointOnOrbit(orbit, angle, time) {
    const groove = orbitGroove(orbit, time) * orbit.grooveDepth;
    const breathing = 1 + groove * state.chaos * 0.07;
    const shape = 1 + Math.sin(angle * 3 + beatClock(time) * TAU * orbit.shapeDrift + orbit.phase) * state.chaos * 0.08 * orbit.grooveDepth;
    const localX = Math.cos(angle) * orbit.r * orbit.sx * breathing;
    const localY = Math.sin(angle) * orbit.r * orbit.sy * shape;
    const p = rotatePoint(localX, localY, orbit.tilt + groove * orbit.spin * state.chaos * 0.08);
    return { x: orbit.x + p.x, y: orbit.y + p.y };
  }

  function gatePosition(orbit, angle, time) {
    const groove = orbitGroove(orbit, time) * orbit.grooveDepth;
    const breathing = 1 + groove * state.chaos * 0.07;
    const localX = Math.cos(angle) * orbit.r * orbit.sx * breathing;
    const localY = Math.sin(angle) * orbit.r * orbit.sy;
    const p = rotatePoint(localX, localY, orbit.tilt + groove * orbit.spin * state.chaos * 0.08);
    return { x: orbit.x + p.x, y: orbit.y + p.y };
  }

  function initAudio() {
    if (audio) return audio.ctx.resume().then(() => unlockAudio());
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return Promise.resolve();
    const actx = new AudioContext();
    const master = actx.createGain();
    const comp = actx.createDynamicsCompressor();
    const recorderDestination = actx.createMediaStreamDestination();
    master.gain.value = 0.72;
    master.connect(comp);
    comp.connect(actx.destination);
    comp.connect(recorderDestination);
    audio = { ctx: actx, master, comp, recorderDestination };
    return actx.resume().then(() => unlockAudio());
  }

  function unlockAudio() {
    if (!audio) return Promise.resolve();
    const now = audio.ctx.currentTime;
    const buffer = audio.ctx.createBuffer(1, 1, audio.ctx.sampleRate);
    const src = audio.ctx.createBufferSource();
    const gain = audio.ctx.createGain();
    gain.gain.value = 0.0001;
    src.buffer = buffer;
    src.connect(gain);
    gain.connect(audio.master);
    src.start(now);
    src.stop(now + 0.01);
    return Promise.resolve();
  }

  function resumeAudio() {
    if (!audio) return initAudio();
    if (audio.ctx.state !== "running") return audio.ctx.resume();
    return Promise.resolve();
  }

  function safeResumeAudio() {
    try {
      return Promise.resolve(resumeAudio())
        .then(() => {
          state.audioReady = true;
        })
        .catch(() => {});
    } catch (error) {
      return Promise.resolve();
    }
  }

  function requestSampleForBody(body) {
    if (!body) return;
    state.sampleTarget = body;
    sampleInput.value = "";
    sampleInput.click();
  }

  function currentBodyLabel(body) {
    if (!body) return "sample";
    return body.sampleName ? body.sampleName.slice(0, 24) : "choose";
  }

  function updateSampleButton(body, fallback = "sample") {
    const label = body ? currentBodyLabel(body) : fallback;
    if (!sampleButton) return;
    sampleButton.textContent = label;
    sampleButton.title = body && body.sampleName ? body.sampleName : label;
  }

  function pitchRatio(body) {
    return Math.pow(2, (body ? body.pitch : 0) / 12);
  }

  function assignSampleToBody(body, buffer, name) {
    stopBodySample(body);
    body.sample = buffer;
    body.sampleName = name.replace(/\.[^/.]+$/, "");
    updateSampleButton(body);
    renderPlanetList();
    trigger("sample", body.x, body.y, 0.8, body);
  }

  function decodeAudioData(arrayBuffer) {
    return new Promise((resolve, reject) => {
      const result = audio.ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (result && typeof result.then === "function") result.then(resolve, reject);
    });
  }

  function playSample(body, energy, x, y, kind) {
    if (!body || !body.sample) return false;
    const now = audio.ctx.currentTime;
    const src = audio.ctx.createBufferSource();
    const gain = audio.ctx.createGain();
    const filter = audio.ctx.createBiquadFilter();
    const speedBend = clamp((1 / body.orbit.beats) * 0.04 + energy * 0.025, 0, 0.12);
    const curveBend = kind === "snare" ? 0.08 : kind === "clap" ? -0.04 : 0;
    const baseRate = clamp(1 + speedBend + curveBend + (body.colorSeed - 0.5) * 0.08, 0.25, 4);
    const levelBase = 0.22 * clamp(energy, 0.35, 1.7);

    src.buffer = body.sample;
    src.playbackRate.value = clamp(baseRate * pitchRatio(body), 0.25, 4);
    const duration = body.sample.duration / src.playbackRate.value;
    const fadeStart = Math.max(now + 0.02, now + duration - 0.035);

    if (body.activeSample) {
      try {
        body.activeSample.src.stop(now);
      } catch (error) {
        // The previous one-shot may already have ended.
      }
      body.activeSample = null;
    }

    filter.type = "lowpass";
    filter.frequency.value = clamp(900 + (1 - y / state.height) * 7600 + energy * 1500, 700, 12000);
    filter.Q.value = 0.25 + state.chaos * 3.5;
    gain.gain.setValueAtTime(0.0001, now);
    const level = levelBase * body.volume;
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), now + 0.004);
    gain.gain.setValueAtTime(Math.max(0.0001, level), fadeStart);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration + 0.025);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(audio.master);
    const token = uid();
    body.activeSample = { src, gain, baseRate, levelBase, token };
    src.onended = () => {
      if (body.activeSample && body.activeSample.token === token) body.activeSample = null;
    };
    src.start(now);
    src.stop(now + duration + 0.04);
    return true;
  }

  function envGain(start, peak, decay) {
    const gain = audio.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + decay);
    gain.connect(audio.master);
    return gain;
  }

  function kick(energy) {
    const now = audio.ctx.currentTime;
    const osc = audio.ctx.createOscillator();
    const gain = envGain(now, 0.78 * energy, 0.44);
    osc.type = "sine";
    osc.frequency.setValueAtTime(132 + energy * 18, now);
    osc.frequency.exponentialRampToValueAtTime(37, now + 0.28);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.46);
  }

  function snare(energy) {
    const now = audio.ctx.currentTime;
    const buffer = audio.ctx.createBuffer(1, audio.ctx.sampleRate * 0.18, audio.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    const noise = audio.ctx.createBufferSource();
    const filter = audio.ctx.createBiquadFilter();
    const gain = envGain(now, 0.32 * energy, 0.2);
    filter.type = "bandpass";
    filter.frequency.value = 1450 + energy * 900;
    filter.Q.value = 0.9;
    noise.buffer = buffer;
    noise.connect(filter);
    filter.connect(gain);
    noise.start(now);
  }

  function hat(energy) {
    const now = audio.ctx.currentTime;
    const buffer = audio.ctx.createBuffer(1, audio.ctx.sampleRate * 0.07, audio.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    const src = audio.ctx.createBufferSource();
    const hp = audio.ctx.createBiquadFilter();
    const gain = envGain(now, 0.16 * energy, 0.075);
    hp.type = "highpass";
    hp.frequency.value = 6200 + energy * 2200;
    src.buffer = buffer;
    src.connect(hp);
    hp.connect(gain);
    src.start(now);
  }

  function clap(energy) {
    const now = audio.ctx.currentTime;
    for (let j = 0; j < 3; j += 1) {
      const buffer = audio.ctx.createBuffer(1, audio.ctx.sampleRate * 0.08, audio.ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
      const src = audio.ctx.createBufferSource();
      const bp = audio.ctx.createBiquadFilter();
      const gain = envGain(now + j * 0.018, 0.13 * energy, 0.11);
      bp.type = "bandpass";
      bp.frequency.value = 1850 + j * 260;
      src.buffer = buffer;
      src.connect(bp);
      bp.connect(gain);
      src.start(now + j * 0.018);
    }
  }

  function tick(energy, freq) {
    const now = audio.ctx.currentTime;
    const osc = audio.ctx.createOscillator();
    const gain = envGain(now, 0.07 * energy, 0.055);
    osc.type = "triangle";
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.07);
  }

  function trigger(kind, x, y, energy = 1, body = null) {
    state.pulse.push({ x, y, r: 6, life: 1, kind });
    state.eventCount += 1;
    if (!audio || !state.audioReady || state.muted) return;
    const e = clamp(energy, 0.35, 1.4);
    if (playSample(body, e, x, y, kind)) return;
    if (kind === "kick") kick(e);
    else if (kind === "snare") snare(e);
    else if (kind === "hat") hat(e);
    else if (kind === "clap") clap(e);
    else tick(e, 340 + e * 700);
  }

  function update(dt, time) {
    const now = performance.now() / 1000;
    state.intersections.length = 0;

    if (state.stopped) {
      state.pulse = state.pulse.filter((p) => {
        p.life -= dt * 1.9;
        p.r += dt * 78;
        return p.life > 0;
      });
      return;
    }

    for (const orbit of orbits) {
      const pull = state.gravity * 0.16;
      orbit.x += (state.cx - orbit.x) * pull * dt * 0.04;
      orbit.y += (state.cy - orbit.y) * pull * dt * 0.04;
      orbit.tilt += orbit.spin * dt * 0.012 * (0.25 + state.chaos);
    }

    for (const body of bodies) {
      body.px = body.x;
      body.py = body.y;
      const previousAngle = body.angle;
      const secondsPerLap = (60 / state.bpm) * body.orbit.beats;
      const baseMotion = (TAU / secondsPerLap) * body.direction;
      const groove = orbitGroove(body.orbit, time) * body.orbit.grooveDepth;
      const bodyLag = Math.sin((beatClock(time) * body.orbit.grooveRate * 0.5 + body.colorSeed) * TAU) * 0.06;
      const motion = baseMotion * (1 + state.chaos * (groove * 0.26 + bodyLag));
      body.angle += motion * dt;
      const p = pointOnOrbit(body.orbit, body.angle, time);
      body.x = p.x;
      body.y = p.y;

      if (!body.muted && !body.orbit.muted) {
        for (const gate of body.orbit.gates) {
          if (
            !gate.muted &&
            crossedAngle(previousAngle, body.angle, gate.angle, motion) &&
            now - body.lastLoopTrigger > 0.12
          ) {
            body.lastLoopTrigger = now;
            trigger("kick", body.x, body.y, 0.74 + body.mass * 0.18, body);
          }
        }
      }
    }

    for (let i = 0; i < bodies.length; i += 1) {
      for (let j = i + 1; j < bodies.length; j += 1) {
        const a = bodies[i];
        const b = bodies[j];
        const d = dist(a, b);
        if (d < 12 + (a.size + b.size) * 0.5) {
          state.intersections.push({ x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 });
          if (!a.muted && !b.muted && now - a.lastTrigger > 0.08 && now - b.lastTrigger > 0.08) {
            a.lastTrigger = now;
            b.lastTrigger = now;
            trigger("clap", a.x, a.y, 0.62, a);
            trigger("clap", b.x, b.y, 0.62, b);
          }
        }
      }
    }

    state.pulse = state.pulse.filter((p) => {
      p.life -= dt * 1.9;
      p.r += dt * 78;
      return p.life > 0;
    });
  }

  function drawEllipse(orbit, time) {
    ctx.save();
    ctx.translate(orbit.x, orbit.y);
    const groove = orbitGroove(orbit, time) * orbit.grooveDepth;
    ctx.rotate(orbit.tilt + groove * orbit.spin * state.chaos * 0.08);
    const breathing = 1 + groove * state.chaos * 0.07;
    ctx.scale(orbit.sx * breathing, orbit.sy);
    ctx.beginPath();
    ctx.ellipse(0, 0, orbit.r, orbit.r, 0, 0, TAU);
    ctx.strokeStyle = orbit.muted ? "rgba(44,48,50,0.18)" : "rgba(44,48,50,0.88)";
    ctx.lineWidth = 1;
    ctx.stroke();
    for (const gate of orbit.gates) {
      const gateX = Math.cos(gate.angle) * orbit.r;
      const gateY = Math.sin(gate.angle) * orbit.r;
      const tickX = Math.cos(gate.angle) * 13;
      const tickY = Math.sin(gate.angle) * 13;
      ctx.beginPath();
      ctx.moveTo(gateX - tickX, gateY - tickY);
      ctx.lineTo(gateX + tickX, gateY + tickY);
      ctx.strokeStyle = orbit.muted || gate.muted ? "rgba(44,48,50,0.2)" : "rgba(44,48,50,0.9)";
      ctx.stroke();
    }
    ctx.restore();
  }

  function draw(time) {
    ctx.fillStyle = "#f7f8f6";
    ctx.fillRect(0, 0, state.width, state.height);

    ctx.save();
    ctx.translate(state.camera.x, state.camera.y);
    ctx.scale(state.camera.scale, state.camera.scale);
    ctx.globalCompositeOperation = "source-over";
    for (const orbit of orbits) drawEllipse(orbit, time);

    for (const body of bodies) {
      ctx.beginPath();
      ctx.moveTo(body.px, body.py);
      ctx.lineTo(body.x, body.y);
      ctx.strokeStyle = body.sample ? "rgba(44,48,50,0.88)" : "rgba(44,48,50,0.78)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(body.x, body.y, body.size + 1, 0, TAU);
      ctx.fillStyle = body.muted || body.orbit.muted
        ? "rgba(44,48,50,0.24)"
        : body.sample
          ? "rgba(44,48,50,0.9)"
          : "rgba(44,48,50,0.82)";
      ctx.fill();
      if (body.sample) {
        ctx.beginPath();
        ctx.arc(body.x, body.y, body.size + 7, 0, TAU);
        ctx.strokeStyle = "rgba(44,48,50,0.62)";
        ctx.stroke();
      }
    }

    for (const hit of state.intersections) {
      ctx.beginPath();
      ctx.arc(hit.x, hit.y, 16, 0, TAU);
      ctx.strokeStyle = "rgba(44,48,50,0.46)";
      ctx.stroke();
    }

    for (const p of state.pulse) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, TAU);
      const alpha = clamp(p.life, 0, 1);
      ctx.strokeStyle = p.kind === "kick"
        ? `rgba(44,48,50,${0.36 * alpha})`
        : p.kind === "sample"
          ? `rgba(16,18,20,${0.42 * alpha})`
        : `rgba(68,82,88,${0.32 * alpha})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (state.drawing) {
      ctx.beginPath();
      if (state.drawing.kind === "planet") {
        ctx.arc(state.drawing.x, state.drawing.y, state.drawing.r, 0, TAU);
      }
      ctx.strokeStyle = "rgba(44,48,50,0.44)";
      ctx.setLineDash([4, 6]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.restore();
  }

  function animate(nowMs) {
    const dt = Math.min(0.033, (nowMs - state.lastTime) / 1000 || 0.016);
    state.lastTime = nowMs;
    const time = nowMs / 1000;
    update(dt, time);
    draw(time);
    const second = Math.floor(time);
    if (second !== state.lastEventSecond) {
      const sampled = bodies.filter((body) => body.sample).length;
      readout.textContent = `${state.bpm} bpm / ${orbits.length} orbits / ${sampled}/${bodies.length} samples / ${state.eventCount} strikes`;
      state.eventCount = 0;
      state.lastEventSecond = second;
    }
    requestAnimationFrame(animate);
  }

  function nearestObject(pos) {
    let best = null;
    let bestD = 28;
    const time = performance.now() / 1000;
    for (const body of bodies) {
      const d = Math.hypot(pos.x - body.x, pos.y - body.y);
      if (d < bestD) {
        best = { type: "body", item: body };
        bestD = d;
      }
    }
    for (const orbit of orbits) {
      for (const gate of orbit.gates) {
        const p = gatePosition(orbit, gate.angle, time);
        const d = Math.hypot(pos.x - p.x, pos.y - p.y);
        if (d < bestD) {
          best = { type: "gate", item: gate, orbit };
          bestD = d;
        }
      }
    }
    for (const orbit of orbits) {
      const d = Math.abs(Math.hypot(pos.x - orbit.x, pos.y - orbit.y) - orbit.r);
      if (d < bestD) {
        best = { type: "orbit", item: orbit };
        bestD = d;
      }
    }
    return best;
  }

  function nearestOrbit(pos) {
    let best = null;
    let bestD = 34;
    for (const orbit of orbits) {
      const d = Math.abs(Math.hypot(pos.x - orbit.x, pos.y - orbit.y) - orbit.r);
      if (d < bestD) {
        best = orbit;
        bestD = d;
      }
    }
    return best;
  }

  function nearestDeletable(pos) {
    let best = null;
    let bestD = 20;
    const time = performance.now() / 1000;
    for (const orbit of orbits) {
      for (const gate of orbit.gates) {
        const p = gatePosition(orbit, gate.angle, time);
        const d = Math.hypot(pos.x - p.x, pos.y - p.y);
        if (d < bestD) {
          best = { type: "gate", item: gate, orbit };
          bestD = d;
        }
      }
    }
    for (const body of bodies) {
      const d = Math.hypot(pos.x - body.x, pos.y - body.y);
      if (d < bestD) {
        best = { type: "body", item: body };
        bestD = d;
      }
    }
    return best;
  }

  function pointerDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function pointerCenter(a, b) {
    return { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
  }

  function removeObject(found) {
    if (!found) return;
    if (found.type === "body") {
      stopBodySample(found.item);
      const bodyIndex = bodies.indexOf(found.item);
      if (bodyIndex >= 0) bodies.splice(bodyIndex, 1);
      if (state.sampleTarget === found.item) {
        state.sampleTarget = bodies[bodies.length - 1] || null;
        updateSampleButton(state.sampleTarget);
      }
      const hasBodiesOnOrbit = bodies.some((body) => body.orbit === found.item.orbit);
      if (!hasBodiesOnOrbit) {
        const orbitIndex = orbits.indexOf(found.item.orbit);
        if (orbitIndex >= 0) orbits.splice(orbitIndex, 1);
      }
      renderPlanetList();
    } else if (found.type === "gate") {
      stopOrbitSamples(found.orbit);
      const gateIndex = found.orbit.gates.indexOf(found.item);
      if (gateIndex >= 0) found.orbit.gates.splice(gateIndex, 1);
    }
  }

  function onPointerDown(event) {
    event.preventDefault();
    requestWakeLock();
    safeResumeAudio();
    if (event.isPrimary && state.pointers.size > 0 && !state.pinch && !state.dragging && !state.drawing) {
      state.pointers.clear();
    }
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (error) {}
    state.pointers.set(event.pointerId, screenPosition(event));
    if (state.pointers.size === 2) {
      const points = Array.from(state.pointers.values());
      state.pinch = {
        distance: pointerDistance(points[0], points[1]),
        center: pointerCenter(points[0], points[1]),
        camera: { ...state.camera }
      };
      state.dragging = null;
      state.drawing = null;
      return;
    }
    if (state.pointers.size > 1) return;

    const pos = pointerPosition(event);

    if (state.tool === "mute") {
      const found = nearestObject(pos);
      if (found) {
        found.item.muted = !found.item.muted;
        if (found.item.muted) {
          if (found.type === "body") stopBodySample(found.item);
          if (found.type === "orbit") stopOrbitSamples(found.item);
          if (found.type === "gate") stopOrbitSamples(found.orbit);
        }
        if (found.type === "body") {
          state.sampleTarget = found.item;
          updateSampleButton(found.item);
          renderPlanetList();
        }
        trigger("tick", pos.x, pos.y, 0.5);
      }
      return;
    }

    if (state.tool === "delete") {
      const found = nearestDeletable(pos);
      if (found) {
        removeObject(found);
      }
      return;
    }

    if (state.tool === "sample") {
      const found = nearestObject(pos);
      if (found && found.type === "body") requestSampleForBody(found.item);
      return;
    }

    if (state.tool === "gate") {
      const orbit = nearestOrbit(pos);
      if (orbit) {
        orbit.gates.push({
          id: uid(),
          angle: orbitAngleAtPoint(orbit, pos, performance.now() / 1000),
          muted: false
        });
        state.pulse.push({ x: pos.x, y: pos.y, r: 6, life: 1, kind: "sample" });
      }
      return;
    }

    if (state.tool === "move") {
      const found = nearestObject(pos);
      if (found) {
        state.dragging = found.type === "gate"
          ? { ...found }
          : { ...found, dx: pos.x - found.item.x, dy: pos.y - found.item.y };
        if (found.type === "body") {
          state.sampleTarget = found.item;
          updateSampleButton(found.item);
          renderPlanetList();
        }
      } else {
        const screen = screenPosition(event);
        state.dragging = {
          type: "camera",
          item: state.camera,
          startX: screen.x,
          startY: screen.y,
          cameraX: state.camera.x,
          cameraY: state.camera.y
        };
      }
      return;
    }

    if (state.tool === "planet") {
      state.drawing = { kind: "planet", x: pos.x, y: pos.y, r: 4 };
    }
  }

  function onPointerMove(event) {
    if (state.pointers.has(event.pointerId)) {
      state.pointers.set(event.pointerId, screenPosition(event));
    }
    if (state.pinch && state.pointers.size >= 2) {
      const points = Array.from(state.pointers.values()).slice(0, 2);
      const distance = pointerDistance(points[0], points[1]);
      const center = pointerCenter(points[0], points[1]);
      const nextScale = state.pinch.camera.scale * (distance / state.pinch.distance);
      const worldCenter = {
        x: (state.pinch.center.x - state.pinch.camera.x) / state.pinch.camera.scale,
        y: (state.pinch.center.y - state.pinch.camera.y) / state.pinch.camera.scale
      };
      state.camera.scale = clamp(nextScale, 0.25, 4);
      state.camera.x = center.x - worldCenter.x * state.camera.scale;
      state.camera.y = center.y - worldCenter.y * state.camera.scale;
      return;
    }
    const pos = pointerPosition(event);
    if (state.dragging) {
      const item = state.dragging.item;
      if (state.dragging.type === "camera") {
        const screen = screenPosition(event);
        state.camera.x = state.dragging.cameraX + screen.x - state.dragging.startX;
        state.camera.y = state.dragging.cameraY + screen.y - state.dragging.startY;
      } else if (state.dragging.type === "gate") {
        item.angle = orbitAngleAtPoint(state.dragging.orbit, pos, performance.now() / 1000);
      } else {
        item.x = pos.x - state.dragging.dx;
        item.y = pos.y - state.dragging.dy;
      }
      return;
    }
    if (!state.drawing) return;
    if (state.drawing.kind === "planet") {
      state.drawing.r = Math.hypot(pos.x - state.drawing.x, pos.y - state.drawing.y);
    }
  }

  function onPointerUp(event) {
    if (event && state.pointers.has(event.pointerId)) {
      state.pointers.delete(event.pointerId);
    }
    if (state.pinch) {
      if (state.pointers.size < 2) state.pinch = null;
      return;
    }
    if (state.dragging) {
      state.dragging = null;
      return;
    }
    if (!state.drawing) return;
    if (state.drawing.kind === "planet" && state.drawing.r > 3) {
      const created = makeOrbit(state.drawing.x, state.drawing.y, state.drawing.r);
      state.sampleTarget = created.body;
      updateSampleButton(created.body);
      renderPlanetList();
      requestSampleForBody(created.body);
    }
    state.drawing = null;
  }

  toolButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.tool = button.dataset.tool;
      toolButtons.forEach((item) => item.classList.toggle("active", item === button));
    });
  });

  if (sampleButton) {
    sampleButton.addEventListener("click", () => {
      const target = state.sampleTarget || bodies[bodies.length - 1];
      if (target) requestSampleForBody(target);
      state.tool = "sample";
      toolButtons.forEach((item) => item.classList.toggle("active", item.dataset.tool === "sample"));
    });
  }

  if (samplePanelToggle && planetPanel) {
    samplePanelToggle.addEventListener("click", () => {
      const collapsed = !planetPanel.classList.contains("collapsed");
      planetPanel.classList.toggle("collapsed", collapsed);
      samplePanelToggle.textContent = collapsed ? "+︎" : "−︎";
      samplePanelToggle.setAttribute("aria-label", collapsed ? "Show samples" : "Hide samples");
      samplePanelToggle.setAttribute("aria-expanded", String(!collapsed));
    });
  }

  sampleInput.addEventListener("change", () => {
    const file = sampleInput.files && sampleInput.files[0];
    const target = state.sampleTarget;
    if (!file || !target) return;
    initAudio()
      .then(() => file.arrayBuffer())
      .then(decodeAudioData)
      .then((buffer) => {
        state.audioReady = true;
        state.stopped = false;
        stopButton.textContent = "stop";
        assignSampleToBody(target, buffer, file.name);
      })
      .catch(() => {
        updateSampleButton(state.sampleTarget, "failed");
      });
  });

  planetList.addEventListener("click", (event) => {
    if (event.target.closest("input")) return;
    const row = event.target.closest(".planet-row");
    if (!row) return;
    const body = findBodyById(row.dataset.bodyId);
    if (!body) return;
    const action = event.target.dataset.action || "focus";
    if (action === "delete") {
      removeObject({ type: "body", item: body });
      return;
    }
    state.sampleTarget = body;
    updateSampleButton(body);
    if (action === "mute") {
      body.muted = !body.muted;
      if (body.muted) stopBodySample(body);
    } else if (action === "replace") {
      requestSampleForBody(body);
    }
    renderPlanetList();
  });

  planetList.addEventListener("input", (event) => {
    const row = event.target.closest(".planet-row");
    if (!row || !event.target.dataset.param) return;
    const body = findBodyById(row.dataset.bodyId);
    if (!body) return;
    const value = Number(event.target.value);
    if (event.target.dataset.param === "volume") {
      body.volume = value;
      if (body.activeSample && body.activeSample.gain) {
        body.activeSample.gain.gain.setValueAtTime(Math.max(0.0001, body.activeSample.levelBase * body.volume), audio.ctx.currentTime);
      }
    }
    if (event.target.dataset.param === "pitch") {
      body.pitch = value;
      if (body.activeSample && body.activeSample.src) {
        body.activeSample.src.playbackRate.setValueAtTime(clamp(body.activeSample.baseRate * pitchRatio(body), 0.25, 4), audio.ctx.currentTime);
      }
    }
    const output = event.target.parentElement.querySelector("output");
    if (output) {
      output.textContent = event.target.dataset.param === "volume"
        ? String(Math.round(body.volume * 100))
        : String(Math.round(body.pitch * 10) / 10);
    }
  });

  recordButton.addEventListener("click", () => {
    if (state.recording) stopRecording();
    else if (state.recordingReady) saveRecording();
    else startRecording();
  });
  bpmInput.addEventListener("input", () => { state.bpm = Number(bpmInput.value); });
  gravityInput.addEventListener("input", () => { state.gravity = Number(gravityInput.value); });
  chaosInput.addEventListener("input", () => { state.chaos = Number(chaosInput.value); });
  stopButton.addEventListener("click", () => {
    if (state.stopped) startTransport();
    else stopTransport();
  });
  clearButton.addEventListener("click", resetField);

  canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
  canvas.addEventListener("pointermove", onPointerMove, { passive: false });
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("lostpointercapture", onPointerUp);
  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    const screen = screenPosition(event);
    if (event.ctrlKey || event.metaKey) {
      zoomAt(screen, state.camera.scale * Math.exp(-event.deltaY * 0.01));
    } else {
      state.camera.x -= event.deltaX;
      state.camera.y -= event.deltaY;
    }
  }, { passive: false });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !state.stopped) {
      resumeAudio().then(() => {
        state.audioReady = true;
      });
      requestWakeLock();
    }
  });
  window.addEventListener("resize", () => {
    resize();
  });

  resize();
  resetField();
  requestAnimationFrame(animate);
})();
