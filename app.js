(() => {
  const canvas = document.getElementById("field");
  const ctx = canvas.getContext("2d", { alpha: true });
  const readout = document.getElementById("readout");
  const bpmInput = document.getElementById("bpm");
  const gravityInput = document.getElementById("gravity");
  const chaosInput = document.getElementById("chaos");
  const undoButton = document.getElementById("undo");
  const velocityToggle = document.getElementById("velocityToggle");
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
  const HISTORY_LIMIT = 32;
  const GATE_MIN_VELOCITY = 0.25;
  const GATE_MAX_VELOCITY = 1.4;
  const GATE_BASE_REACH = 13;
  const GATE_MAX_REACH = 34;
  const PLANET_PALETTE = [
    { r: 217, g: 187, b: 86 },
    { r: 244, g: 231, b: 184 },
    { r: 215, g: 227, b: 219 },
    { r: 238, g: 203, b: 208 },
    { r: 218, g: 177, b: 86 }
  ];
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
    velocityEnabled: false,
    camera: { x: 0, y: 0, scale: 1 },
    pointers: new Map(),
    pinch: null,
    dragging: null,
    drawing: null,
    sampleTarget: null,
    history: [],
    activeParamEdit: "",
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

  function makeChaosProfile(segments = 8) {
    const weights = [];
    for (let i = 0; i < segments; i += 1) {
      let weight = rnd(0.26, 1.85);
      if (Math.random() < 0.24) weight *= rnd(0.22, 0.58);
      if (Math.random() < 0.2) weight *= rnd(1.65, 2.8);
      weights.push(clamp(weight, 0.08, 3.2));
    }
    const total = weights.reduce((sum, value) => sum + value, 0) || 1;
    const points = [0];
    let cursor = 0;
    for (const weight of weights) {
      cursor += weight / total;
      points.push(cursor);
    }
    points[points.length - 1] = 1;
    return points;
  }

  function ensureChaosProfile(body, lap) {
    const segments = body.chaosSegments || 8;
    if (!body.chaosProfile || body.chaosProfile.length !== segments + 1 || body.chaosLap !== lap) {
      body.chaosProfile = makeChaosProfile(segments);
      body.chaosLap = lap;
    }
    return body.chaosProfile;
  }

  function chaosWarpPhase(phase, body, lap) {
    const amount = clamp(state.chaos, 0, 1);
    if (!amount) return phase;
    const segments = body.chaosSegments || 8;
    const profile = ensureChaosProfile(body, lap);
    const scaled = phase * segments;
    const index = Math.min(segments - 1, Math.floor(scaled));
    const local = scaled - index;
    const ease = local * local * (3 - local * 2);
    const start = profile[index];
    const end = profile[index + 1];
    const warped = start + (end - start) * ease;
    return phase + (warped - phase) * amount;
  }

  function chaosWarpAngle(rawAngle, body) {
    const turns = Math.floor(rawAngle / TAU);
    const phase = wrapAngle(rawAngle) / TAU;
    return (turns + chaosWarpPhase(phase, body, turns)) * TAU;
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
      const initialAngle = rnd(0, TAU);
      const body = {
        orbit,
        id: uid(),
        angle: initialAngle,
        rawAngle: initialAngle,
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
        chaosSegments: pick([5, 7, 9, 11]),
        chaosLap: null,
        chaosProfile: null,
        muted: false,
        sample: null,
        sampleName: "",
        volume: 1,
        pitch: 0,
        sliceStart: 0,
        sliceEnd: 1,
        activeSample: null,
        colorTone: rnd(0, 1),
        colorSeed: rnd(0, 1)
      };
      bodies.push(body);
      if (!firstBody) firstBody = body;
    }
    orbits.push(orbit);
    return { orbit, body: firstBody };
  }

  function snapshotField() {
    return {
      sampleTargetId: state.sampleTarget ? state.sampleTarget.id : "",
      orbits: orbits.map((orbit) => ({
        id: orbit.id,
        x: orbit.x,
        y: orbit.y,
        r: orbit.r,
        sx: orbit.sx,
        sy: orbit.sy,
        tilt: orbit.tilt,
        spin: orbit.spin,
        wobble: orbit.wobble,
        phase: orbit.phase,
        groovePhase: orbit.groovePhase,
        grooveRate: orbit.grooveRate,
        grooveDepth: orbit.grooveDepth,
        grooveSkew: orbit.grooveSkew,
        shapeDrift: orbit.shapeDrift,
        gates: orbit.gates.map((gate) => ({ ...gate })),
        beats: orbit.beats,
        muted: orbit.muted
      })),
      bodies: bodies.map((body) => ({
        id: body.id,
        orbitId: body.orbit.id,
        angle: body.angle,
        rawAngle: Number.isFinite(body.rawAngle) ? body.rawAngle : body.angle,
        direction: body.direction,
        speed: body.speed,
        mass: body.mass,
        size: body.size,
        x: body.x,
        y: body.y,
        px: body.px,
        py: body.py,
        lastTrigger: body.lastTrigger,
        lastLoopTrigger: body.lastLoopTrigger,
        chaosSegments: body.chaosSegments,
        chaosLap: body.chaosLap,
        chaosProfile: body.chaosProfile ? body.chaosProfile.slice() : null,
        muted: body.muted,
        sample: body.sample,
        sampleName: body.sampleName,
        volume: body.volume,
        pitch: body.pitch,
        sliceStart: body.sliceStart,
        sliceEnd: body.sliceEnd,
        colorTone: body.colorTone,
        colorSeed: body.colorSeed
      }))
    };
  }

  function pushHistory() {
    state.history.push(snapshotField());
    if (state.history.length > HISTORY_LIMIT) state.history.shift();
  }

  function restoreSnapshot(snapshot) {
    if (!snapshot) return;
    stopActiveSamples();
    const orbitMap = new Map();
    orbits.length = 0;
    bodies.length = 0;
    for (const savedOrbit of snapshot.orbits) {
      const orbit = {
        ...savedOrbit,
        gates: savedOrbit.gates.map((gate) => ({ ...gate }))
      };
      orbitMap.set(orbit.id, orbit);
      orbits.push(orbit);
    }
    for (const savedBody of snapshot.bodies) {
      const orbit = orbitMap.get(savedBody.orbitId);
      if (!orbit) continue;
      const body = {
        ...savedBody,
        orbit,
        chaosSegments: savedBody.chaosSegments || pick([5, 7, 9, 11]),
        chaosLap: Number.isFinite(savedBody.chaosLap) ? savedBody.chaosLap : null,
        chaosProfile: savedBody.chaosProfile ? savedBody.chaosProfile.slice() : null,
        activeSample: null
      };
      delete body.orbitId;
      bodies.push(body);
    }
    state.sampleTarget = bodies.find((body) => body.id === snapshot.sampleTargetId) || null;
    state.dragging = null;
    state.drawing = null;
    state.pinch = null;
    state.pointers.clear();
    updateSampleButton(state.sampleTarget);
    renderPlanetList();
  }

  function undoLast() {
    const snapshot = state.history.pop();
    if (!snapshot) return;
    restoreSnapshot(snapshot);
  }

  function resetField(remember = false) {
    if (remember) pushHistory();
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
      if (body.activeSample.sources) {
        for (const source of body.activeSample.sources) source.stop();
      } else if (body.activeSample.src) {
        body.activeSample.src.stop();
      }
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

  function paletteColor(value) {
    const tone = clamp(value, 0, 1) * (PLANET_PALETTE.length - 1);
    const index = Math.min(PLANET_PALETTE.length - 2, Math.floor(tone));
    const mix = tone - index;
    const a = PLANET_PALETTE[index];
    const b = PLANET_PALETTE[index + 1];
    return {
      r: Math.round(a.r + (b.r - a.r) * mix),
      g: Math.round(a.g + (b.g - a.g) * mix),
      b: Math.round(a.b + (b.b - a.b) * mix)
    };
  }

  function planetColorCss(body, alpha = 1) {
    const color = paletteColor(body ? body.colorTone : 0.5);
    return `rgba(${color.r},${color.g},${color.b},${alpha})`;
  }

  function sampleSlice(body) {
    const start = clamp(body && Number.isFinite(body.sliceStart) ? body.sliceStart : 0, 0, 0.98);
    const end = clamp(body && Number.isFinite(body.sliceEnd) ? body.sliceEnd : 1, start + 0.02, 1);
    return { start, end };
  }

  function waveformSvg(body) {
    if (!body || !body.sample) return '<div class="waveform empty"></div>';
    const data = body.sample.getChannelData(0);
    const bars = 52;
    const step = Math.max(1, Math.floor(data.length / bars));
    const points = [];
    for (let i = 0; i < bars; i += 1) {
      let peak = 0;
      const start = i * step;
      const end = Math.min(data.length, start + step);
      for (let j = start; j < end; j += 1) peak = Math.max(peak, Math.abs(data[j]));
      const x = (i / (bars - 1)) * 100;
      const y = 50 - peak * 42;
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    for (let i = bars - 1; i >= 0; i -= 1) {
      const peak = Math.abs(50 - Number(points[i].split(",")[1])) / 42;
      const x = (i / (bars - 1)) * 100;
      const y = 50 + peak * 42;
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }
    const slice = sampleSlice(body);
    const inX = slice.start * 100;
    const outX = slice.end * 100;
    return `
      <svg class="waveform" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
        <rect class="slice-range" x="${inX}" y="1.5" width="${Math.max(0.5, outX - inX)}" height="25"></rect>
        <polygon points="${points.join(" ")}"></polygon>
        <line class="slice-in" x1="${inX}" y1="2" x2="${inX}" y2="26"></line>
        <line class="slice-out" x1="${outX}" y1="2" x2="${outX}" y2="26"></line>
      </svg>
    `;
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
      const slice = sampleSlice(body);
      const sliceStart = Math.round(slice.start * 100);
      const sliceEnd = Math.round(slice.end * 100);
      const color = planetColorCss(body, 0.82);
      return `
        <article class="planet-row${selected}${muted}" data-body-id="${body.id}" style="--planet-color: ${color}">
          <div class="planet-main">
            <button type="button" data-action="replace" title="replace sample">◇︎</button>
            <div class="planet-name" title="${safeName}">${safeName}</div>
            <button type="button" data-action="mute" title="mute">${body.muted ? "○︎" : "◐︎"}</button>
            <button type="button" data-action="delete" title="delete">×︎</button>
          </div>
          ${waveformSvg(body)}
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
          <label class="planet-param color-param">
            <span>col</span>
            <input type="range" min="0" max="1" step="0.001" value="${body.colorTone}" data-param="color">
            <output aria-hidden="true"></output>
          </label>
          <label class="planet-param">
            <span>in</span>
            <input type="range" min="0" max="0.98" step="0.001" value="${slice.start}" data-param="sliceStart">
            <output>${sliceStart}</output>
          </label>
          <label class="planet-param">
            <span>out</span>
            <input type="range" min="0.02" max="1" step="0.001" value="${slice.end}" data-param="sliceEnd">
            <output>${sliceEnd}</output>
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
    const tilt = orbit.tilt;
    const c = Math.cos(-tilt);
    const s = Math.sin(-tilt);
    const dx = point.x - orbit.x;
    const dy = point.y - orbit.y;
    const localX = dx * c - dy * s;
    const localY = dx * s + dy * c;
    const breathing = 1;
    return Math.atan2(localY / orbit.sy, localX / (orbit.sx * breathing));
  }

  function hitRadius(size) {
    return size / Math.max(0.35, state.camera.scale);
  }

  function orbitEdgeDistance(orbit, point, time) {
    const angle = orbitAngleAtPoint(orbit, point, time);
    const edge = gatePosition(orbit, angle, time);
    return Math.hypot(point.x - edge.x, point.y - edge.y);
  }

  function pointOnOrbit(orbit, angle, time) {
    const breathing = 1;
    const shape = 1;
    const localX = Math.cos(angle) * orbit.r * orbit.sx * breathing;
    const localY = Math.sin(angle) * orbit.r * orbit.sy * shape;
    const p = rotatePoint(localX, localY, orbit.tilt);
    return { x: orbit.x + p.x, y: orbit.y + p.y };
  }

  function gatePosition(orbit, angle, time) {
    const breathing = 1;
    const localX = Math.cos(angle) * orbit.r * orbit.sx * breathing;
    const localY = Math.sin(angle) * orbit.r * orbit.sy;
    const p = rotatePoint(localX, localY, orbit.tilt);
    return { x: orbit.x + p.x, y: orbit.y + p.y };
  }

  function gateVelocity(gate) {
    return clamp(gate && Number.isFinite(gate.velocity) ? gate.velocity : 1, GATE_MIN_VELOCITY, GATE_MAX_VELOCITY);
  }

  function gateReach(gate) {
    if (!state.velocityEnabled) return GATE_BASE_REACH;
    const normalized = (gateVelocity(gate) - GATE_MIN_VELOCITY) / (GATE_MAX_VELOCITY - GATE_MIN_VELOCITY);
    return GATE_BASE_REACH + normalized * (GATE_MAX_REACH - GATE_BASE_REACH);
  }

  function gateVelocityFromDistance(distance) {
    const normalized = clamp(distance / 82, 0, 1);
    return GATE_MIN_VELOCITY + normalized * (GATE_MAX_VELOCITY - GATE_MIN_VELOCITY);
  }

  function gateSegment(orbit, gate, time) {
    const breathing = 1;
    const tilt = orbit.tilt;
    const gateX = Math.cos(gate.angle) * orbit.r;
    const gateY = Math.sin(gate.angle) * orbit.r;
    const reach = gateReach(gate);
    const tickX = Math.cos(gate.angle) * reach;
    const tickY = Math.sin(gate.angle) * reach;
    const a = rotatePoint((gateX - tickX) * orbit.sx * breathing, (gateY - tickY) * orbit.sy, tilt);
    const b = rotatePoint((gateX + tickX) * orbit.sx * breathing, (gateY + tickY) * orbit.sy, tilt);
    return {
      a: { x: orbit.x + a.x, y: orbit.y + a.y },
      b: { x: orbit.x + b.x, y: orbit.y + b.y }
    };
  }

  function segmentDistance(point, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lenSq = dx * dx + dy * dy;
    if (!lenSq) return Math.hypot(point.x - a.x, point.y - a.y);
    const t = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / lenSq, 0, 1);
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    return Math.hypot(point.x - x, point.y - y);
  }

  function gateHitDistance(orbit, gate, point, time) {
    const segment = gateSegment(orbit, gate, time);
    return segmentDistance(point, segment.a, segment.b);
  }

  function initAudio() {
    if (audio) return audio.ctx.resume().then(() => unlockAudio());
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return Promise.resolve();
    const actx = new AudioContext();
    const master = actx.createGain();
    const comp = actx.createDynamicsCompressor();
    let recorderDestination = null;
    if (typeof actx.createMediaStreamDestination === "function") {
      try {
        recorderDestination = actx.createMediaStreamDestination();
      } catch (error) {
        recorderDestination = null;
      }
    }
    master.gain.value = 0.72;
    master.connect(comp);
    comp.connect(actx.destination);
    if (recorderDestination) {
      try {
        comp.connect(recorderDestination);
      } catch (error) {
        recorderDestination = null;
      }
    }
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
          state.audioReady = !!audio;
        })
        .catch(() => {
          state.audioReady = false;
        });
    } catch (error) {
      state.audioReady = false;
      return Promise.resolve();
    }
  }

  function requestSampleForBody(body) {
    if (!body) return;
    safeResumeAudio();
    state.sampleTarget = body;
    sampleInput.value = "";
    sampleInput.click();
  }

  function currentBodyLabel(body) {
    if (!body) return "sample";
    return body.sampleName ? body.sampleName.slice(0, 24) : "choose";
  }

  function updateSampleButton(body, fallback = "") {
    const label = body
      ? (body.sampleName ? currentBodyLabel(body) : (fallback || "choose"))
      : (fallback || "sample");
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
    body.sliceStart = Number.isFinite(body.sliceStart) ? body.sliceStart : 0;
    body.sliceEnd = Number.isFinite(body.sliceEnd) ? body.sliceEnd : 1;
    updateSampleButton(body);
    renderPlanetList();
    trigger("sample", body.x, body.y, 0.8, body);
  }

  function decodeAudioData(arrayBuffer) {
    return new Promise((resolve, reject) => {
      if (!audio || !audio.ctx) {
        reject(new Error("AudioContext is not ready"));
        return;
      }
      let settled = false;
      const done = (buffer) => {
        if (settled) return;
        settled = true;
        resolve(buffer);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      try {
        const copy = arrayBuffer.slice(0);
        const result = audio.ctx.decodeAudioData(copy, done, fail);
        if (result && typeof result.then === "function") result.then(done, fail);
      } catch (error) {
        fail(error);
      }
    });
  }

  function readSampleFile(file) {
    if (file && typeof file.arrayBuffer === "function") {
      return file.arrayBuffer().catch(() => readSampleFileWithReader(file));
    }
    return readSampleFileWithReader(file);
  }

  function readSampleFileWithReader(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("Sample file could not be read"));
      reader.readAsArrayBuffer(file);
    });
  }

  function playSample(body, energy, x, y, kind) {
    if (!body || !body.sample) return false;
    const now = audio.ctx.currentTime;
    const src = audio.ctx.createBufferSource();
    const gain = audio.ctx.createGain();
    const filter = audio.ctx.createBiquadFilter();
    const playbackRate = clamp(pitchRatio(body), 0.25, 4);
    const levelBase = 0.22 * clamp(energy, 0.35, 1.7);

    src.buffer = body.sample;
    src.playbackRate.value = playbackRate;
    const slice = sampleSlice(body);
    const sampleOffset = body.sample.duration * slice.start;
    const sampleDuration = body.sample.duration * (slice.end - slice.start);
    const duration = sampleDuration / playbackRate;
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
    filter.Q.value = 0.25;
    gain.gain.setValueAtTime(0.0001, now);
    const level = levelBase * body.volume;
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, level), now + 0.004);
    gain.gain.setValueAtTime(Math.max(0.0001, level), fadeStart);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration + 0.025);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(audio.master);
    const token = uid();
    body.activeSample = { src, gain, levelBase, token };
    src.onended = () => {
      if (body.activeSample && body.activeSample.token === token) body.activeSample = null;
    };
    src.start(now, sampleOffset, sampleDuration);
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
    if (body && !body.sample) return;
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
      orbit.tilt += orbit.spin * dt * 0.003;
    }

    for (const body of bodies) {
      body.px = body.x;
      body.py = body.y;
      const previousAngle = body.angle;
      const secondsPerLap = (60 / state.bpm) * body.orbit.beats;
      const rawMotion = (TAU / secondsPerLap) * body.direction;
      body.rawAngle = Number.isFinite(body.rawAngle) ? body.rawAngle : body.angle;
      body.rawAngle += rawMotion * dt;
      body.angle = chaosWarpAngle(body.rawAngle, body);
      const motion = body.angle - previousAngle;
      const p = pointOnOrbit(body.orbit, body.angle, time);
      body.x = p.x;
      body.y = p.y;

      if (!body.muted && !body.orbit.muted) {
        for (const gate of body.orbit.gates) {
          if (
            !gate.muted &&
            crossedAngle(previousAngle, body.angle, gate.angle, rawMotion) &&
            now - body.lastLoopTrigger > 0.12
          ) {
            body.lastLoopTrigger = now;
            const gateEnergy = state.velocityEnabled ? gateVelocity(gate) : 1;
            trigger("kick", body.x, body.y, (0.74 + body.mass * 0.18) * gateEnergy, body);
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
    ctx.rotate(orbit.tilt);
    ctx.scale(orbit.sx, orbit.sy);
    ctx.beginPath();
    ctx.ellipse(0, 0, orbit.r, orbit.r, 0, 0, TAU);
    ctx.strokeStyle = orbit.muted ? "rgba(44,48,50,0.18)" : "rgba(44,48,50,0.88)";
    ctx.lineWidth = 1;
    ctx.stroke();
    for (const gate of orbit.gates) {
      const gateX = Math.cos(gate.angle) * orbit.r;
      const gateY = Math.sin(gate.angle) * orbit.r;
      const reach = gateReach(gate);
      const tickX = Math.cos(gate.angle) * reach;
      const tickY = Math.sin(gate.angle) * reach;
      ctx.beginPath();
      ctx.moveTo(gateX - tickX, gateY - tickY);
      ctx.lineTo(gateX + tickX, gateY + tickY);
      const alpha = state.velocityEnabled ? 0.32 + (gateVelocity(gate) / GATE_MAX_VELOCITY) * 0.54 : 0.9;
      ctx.strokeStyle = orbit.muted || gate.muted ? "rgba(44,48,50,0.2)" : `rgba(44,48,50,${alpha})`;
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
      ctx.strokeStyle = body.sample ? planetColorCss(body, 0.72) : "rgba(44,48,50,0.58)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(body.x, body.y, body.size + 1, 0, TAU);
      ctx.fillStyle = body.muted || body.orbit.muted
        ? planetColorCss(body, 0.22)
        : body.sample
          ? planetColorCss(body, 0.96)
          : planetColorCss(body, 0.72);
      ctx.fill();
      if (body.sample) {
        ctx.beginPath();
        ctx.arc(body.x, body.y, body.size + 7, 0, TAU);
        ctx.strokeStyle = planetColorCss(body, 0.48);
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
      } else if (state.drawing.kind === "gate") {
        const segment = gateSegment(state.drawing.orbit, state.drawing, time);
        ctx.moveTo(segment.a.x, segment.a.y);
        ctx.lineTo(segment.b.x, segment.b.y);
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
    let bestD = hitRadius(30);
    const time = performance.now() / 1000;
    for (const orbit of orbits) {
      for (const gate of orbit.gates) {
        const d = gateHitDistance(orbit, gate, pos, time);
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
    for (const orbit of orbits) {
      const d = orbitEdgeDistance(orbit, pos, time);
      if (d < bestD) {
        best = { type: "orbit", item: orbit };
        bestD = d;
      }
    }
    return best;
  }

  function nearestOrbit(pos) {
    let best = null;
    let bestD = hitRadius(42);
    const time = performance.now() / 1000;
    for (const orbit of orbits) {
      const d = orbitEdgeDistance(orbit, pos, time);
      if (d < bestD) {
        best = orbit;
        bestD = d;
      }
    }
    return best;
  }

  function nearestDeletable(pos) {
    let best = null;
    let bestD = hitRadius(28);
    const time = performance.now() / 1000;
    for (const orbit of orbits) {
      for (const gate of orbit.gates) {
        const d = gateHitDistance(orbit, gate, pos, time);
        if (d < bestD) {
          best = { type: "gate", item: gate, orbit };
          bestD = d;
        }
      }
    }
    for (const body of bodies) {
      const d = Math.hypot(pos.x - body.x, pos.y - body.y);
      if (d < Math.min(bestD, hitRadius(24))) {
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

  function beginPinch(points) {
    state.pinch = {
      distance: pointerDistance(points[0], points[1]),
      center: pointerCenter(points[0], points[1]),
      camera: { ...state.camera }
    };
    state.dragging = null;
    state.drawing = null;
  }

  function updatePinch(points) {
    if (!state.pinch) return;
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
  }

  function touchPosition(touch) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top
    };
  }

  function touchPoints(event) {
    return Array.from(event.touches).slice(0, 2).map(touchPosition);
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
      beginPinch(Array.from(state.pointers.values()));
      return;
    }
    if (state.pointers.size > 1) return;

    const pos = pointerPosition(event);

    if (state.tool === "mute") {
      const found = nearestObject(pos);
      if (found) {
        pushHistory();
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
        pushHistory();
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
        const angle = orbitAngleAtPoint(orbit, pos, performance.now() / 1000);
        if (state.velocityEnabled) {
          state.drawing = { kind: "gate", orbit, startX: pos.x, startY: pos.y, angle, velocity: 1 };
        } else {
          pushHistory();
          orbit.gates.push({ id: uid(), angle, muted: false });
          const p = gatePosition(orbit, angle, performance.now() / 1000);
          state.pulse.push({ x: p.x, y: p.y, r: 6, life: 1, kind: "sample" });
        }
      }
      return;
    }

    if (state.tool === "move") {
      const found = nearestObject(pos);
      if (found) {
        pushHistory();
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
      updatePinch(Array.from(state.pointers.values()).slice(0, 2));
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
    } else if (state.drawing.kind === "gate") {
      state.drawing.angle = orbitAngleAtPoint(state.drawing.orbit, pos, performance.now() / 1000);
      state.drawing.velocity = gateVelocityFromDistance(Math.hypot(pos.x - state.drawing.startX, pos.y - state.drawing.startY));
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
      pushHistory();
      const created = makeOrbit(state.drawing.x, state.drawing.y, state.drawing.r);
      state.sampleTarget = created.body;
      updateSampleButton(created.body);
      renderPlanetList();
      requestSampleForBody(created.body);
    } else if (state.drawing.kind === "gate") {
      pushHistory();
      state.drawing.orbit.gates.push({
        id: uid(),
        angle: state.drawing.angle,
        velocity: state.drawing.velocity,
        muted: false
      });
      const p = gatePosition(state.drawing.orbit, state.drawing.angle, performance.now() / 1000);
      state.pulse.push({ x: p.x, y: p.y, r: 6, life: 1, kind: "sample" });
    }
    state.drawing = null;
  }

  function onTouchStart(event) {
    if (event.touches.length < 2) return;
    event.preventDefault();
    requestWakeLock();
    safeResumeAudio();
    state.pointers.clear();
    beginPinch(touchPoints(event));
  }

  function onTouchMove(event) {
    if (event.touches.length < 2 || !state.pinch) return;
    event.preventDefault();
    updatePinch(touchPoints(event));
  }

  function onTouchEnd(event) {
    if (event.touches.length >= 2) {
      beginPinch(touchPoints(event));
      return;
    }
    if (state.pinch) event.preventDefault();
    state.pinch = null;
    state.pointers.clear();
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
    updateSampleButton(target, "reading");
    initAudio()
      .then(() => readSampleFile(file))
      .then(decodeAudioData)
      .then((buffer) => {
        if (!bodies.includes(target)) return;
        state.audioReady = true;
        state.stopped = false;
        stopButton.textContent = "stop";
        pushHistory();
        assignSampleToBody(target, buffer, file.name);
      })
      .catch(() => {
        if (state.sampleTarget === target) updateSampleButton(target, "failed");
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
      pushHistory();
      removeObject({ type: "body", item: body });
      return;
    }
    state.sampleTarget = body;
    updateSampleButton(body);
    if (action === "mute") {
      pushHistory();
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
    const paramKey = `${body.id}:${event.target.dataset.param}`;
    if (state.activeParamEdit !== paramKey) {
      pushHistory();
      state.activeParamEdit = paramKey;
    }
    if (event.target.dataset.param === "volume") {
      body.volume = value;
      if (body.activeSample && body.activeSample.gain) {
        body.activeSample.gain.gain.setValueAtTime(Math.max(0.0001, body.activeSample.levelBase * body.volume), audio.ctx.currentTime);
      }
    }
    if (event.target.dataset.param === "pitch") {
      body.pitch = value;
      if (body.activeSample && body.activeSample.src) {
        body.activeSample.src.playbackRate.setValueAtTime(clamp(pitchRatio(body), 0.25, 4), audio.ctx.currentTime);
      }
    }
    if (event.target.dataset.param === "color") {
      body.colorTone = value;
      row.style.setProperty("--planet-color", planetColorCss(body, 0.82));
    }
    if (event.target.dataset.param === "sliceStart") {
      body.sliceStart = Math.min(value, sampleSlice(body).end - 0.02);
      event.target.value = String(body.sliceStart);
    }
    if (event.target.dataset.param === "sliceEnd") {
      body.sliceEnd = Math.max(value, sampleSlice(body).start + 0.02);
      event.target.value = String(body.sliceEnd);
    }
    if (event.target.dataset.param === "sliceStart" || event.target.dataset.param === "sliceEnd") {
      const slice = sampleSlice(body);
      const inLine = row.querySelector(".waveform .slice-in");
      const outLine = row.querySelector(".waveform .slice-out");
      const range = row.querySelector(".waveform .slice-range");
      const inX = String(slice.start * 100);
      const outX = String(slice.end * 100);
      if (inLine) {
        inLine.setAttribute("x1", inX);
        inLine.setAttribute("x2", inX);
      }
      if (outLine) {
        outLine.setAttribute("x1", outX);
        outLine.setAttribute("x2", outX);
      }
      if (range) {
        range.setAttribute("x", inX);
        range.setAttribute("width", String(Math.max(0.5, (slice.end - slice.start) * 100)));
      }
    }
    const output = event.target.parentElement.querySelector("output");
    if (output) {
      if (event.target.dataset.param === "volume") {
        output.textContent = String(Math.round(body.volume * 100));
      } else if (event.target.dataset.param === "pitch") {
        output.textContent = String(Math.round(body.pitch * 10) / 10);
      } else if (event.target.dataset.param === "sliceStart") {
        output.textContent = String(Math.round(sampleSlice(body).start * 100));
      } else if (event.target.dataset.param === "sliceEnd") {
        output.textContent = String(Math.round(sampleSlice(body).end * 100));
      }
    }
  });

  planetList.addEventListener("change", () => {
    state.activeParamEdit = "";
  });

  if (undoButton) undoButton.addEventListener("click", undoLast);
  if (velocityToggle) {
    velocityToggle.addEventListener("click", () => {
      state.velocityEnabled = !state.velocityEnabled;
      velocityToggle.classList.toggle("active", state.velocityEnabled);
      velocityToggle.setAttribute("aria-pressed", String(state.velocityEnabled));
    });
  }
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
  clearButton.addEventListener("click", () => resetField(true));

  canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
  canvas.addEventListener("pointermove", onPointerMove, { passive: false });
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("lostpointercapture", onPointerUp);
  canvas.addEventListener("touchstart", onTouchStart, { passive: false });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd, { passive: false });
  canvas.addEventListener("touchcancel", onTouchEnd, { passive: false });
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
  window.addEventListener("pointerup", () => {
    state.activeParamEdit = "";
  });
  window.addEventListener("resize", () => {
    resize();
  });

  resize();
  resetField();
  requestAnimationFrame(animate);
})();
