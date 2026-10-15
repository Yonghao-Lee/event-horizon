'use strict';

// ============================================================================
// EVENT HORIZON — a black hole game with real-time gravitational lensing.
// The world is drawn to an offscreen 2D canvas, then a WebGL fragment shader
// bends that image around every black hole and paints accretion disks.
// ============================================================================

const view = document.getElementById('view');
const scene = document.createElement('canvas');
const ctx = scene.getContext('2d');
const hudEl = document.getElementById('hud');
const boardEl = document.getElementById('board');
const bannerEl = document.getElementById('banner');
const overlayEl = document.getElementById('overlay');
const goalEl = document.getElementById('goal');
const pauseEl = document.getElementById('pause');

let W = 0, H = 0, DPR = 1;
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// WebGL lensing pass
// ---------------------------------------------------------------------------
const MAX_HOLES = 16;
const gl = view.getContext('webgl', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
let glProg = null, glTex = null, glU = {};

const VERT = `
attribute vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
uniform sampler2D tex;
uniform vec2 res;
uniform float time;
uniform int n;
uniform vec4 holes[${MAX_HOLES}];   // x, y, radius (px), spin
uniform float modes[${MAX_HOLES}];  // 0 player, 1 danger, 2 prey, 3 boss

vec3 diskHot(float m) {
  if (m < 0.5) return vec3(1.0, 0.95, 0.82);
  if (m < 1.5) return vec3(1.0, 0.72, 0.82);
  if (m < 2.5) return vec3(0.85, 0.95, 1.0);
  return vec3(0.95, 0.85, 1.0);
}
vec3 diskCool(float m) {
  if (m < 0.5) return vec3(1.0, 0.42, 0.06);
  if (m < 1.5) return vec3(0.95, 0.05, 0.25);
  if (m < 2.5) return vec3(0.12, 0.42, 1.0);
  return vec3(0.55, 0.08, 1.0);
}

// Accretion disk emission at offset q from the hole center (tilted ellipse).
vec3 disk(vec2 q, float r, float spin, float m) {
  vec2 e = vec2(q.x, q.y / 0.24);
  float rr = length(e) / r;
  float band = smoothstep(1.45, 1.85, rr) * (1.0 - smoothstep(2.4, 4.6, rr));
  if (band <= 0.0) return vec3(0.0);
  float a = atan(e.y, e.x);
  float sw = 0.55 + 0.45 * sin(a * 4.0 + rr * 5.0 - time * 3.0 * spin);
  sw *= 0.7 + 0.3 * sin(a * 11.0 - rr * 13.0 + time * 5.0 * spin);
  float doppler = 1.0 + 0.6 * spin * cos(a);
  vec3 c = mix(diskCool(m), diskHot(m), 1.0 - smoothstep(1.6, 3.6, rr));
  return c * band * sw * doppler * 1.7;
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, res.y - gl_FragCoord.y);
  vec2 off = vec2(0.0);
  float shadow = 0.0;
  vec3 back = vec3(0.0);
  vec3 front = vec3(0.0);

  for (int i = 0; i < ${MAX_HOLES}; i++) {
    if (i >= n) break;
    vec2 c = holes[i].xy;
    float r = holes[i].z;
    float spin = holes[i].w;
    float m = modes[i];
    vec2 d = p - c;
    float dist = max(length(d), 0.001);
    vec2 dir = d / dist;
    float rE = r * 1.3;
    float fall = 1.0 - smoothstep(r * 7.0, r * 13.0, dist);
    vec2 lens = dir * (rE * rE / dist) * fall;
    off -= lens;

    float inside = 1.0 - smoothstep(r * 0.96, r * 1.0, dist);
    shadow = max(shadow, inside);

    // Light from the far side of the disk, bent over and under the shadow.
    back += disk(d - lens, r, spin, m) * (1.0 - inside);
    // Near side of the disk crossing in front of the shadow.
    if (d.y > 0.0) front += disk(d, r, spin, m) * inside;
    // Photon ring.
    float rq = (dist - r * 1.03) / (r * 0.05 + 0.6);
    float ring = exp(-rq * rq);
    front += diskHot(m) * ring * 0.9;
  }

  vec2 s = clamp((p + off) / res, vec2(0.0), vec2(1.0));
  vec3 col = texture2D(tex, s).rgb;
  col += back;
  col *= 1.0 - shadow;
  col += front;

  // Vignette + gentle tone map.
  vec2 uv = gl_FragCoord.xy / res - 0.5;
  col *= 1.0 - dot(uv, uv) * 0.7;
  col = col / (1.0 + col * 0.15);
  gl_FragColor = vec4(col, 1.0);
}
`;

function initGL() {
  if (!gl) return false;
  const sh = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  };
  const vs = sh(gl.VERTEX_SHADER, VERT), fs = sh(gl.FRAGMENT_SHADER, FRAG);
  if (!vs || !fs) return false;
  glProg = gl.createProgram();
  gl.attachShader(glProg, vs);
  gl.attachShader(glProg, fs);
  gl.linkProgram(glProg);
  if (!gl.getProgramParameter(glProg, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(glProg));
    return false;
  }
  gl.useProgram(glProg);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(glProg, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  glTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, glTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  for (const name of ['tex', 'res', 'time', 'n', 'holes', 'modes']) {
    glU[name] = gl.getUniformLocation(glProg, name);
  }
  gl.uniform1i(glU.tex, 0);
  return true;
}

const useGL = initGL();
if (!useGL) {
  // Fallback: show the 2D scene directly and draw holes as plain discs.
  scene.id = 'view';
  view.replaceWith(scene);
}

function resize() {
  DPR = Math.min(window.devicePixelRatio || 1, 1.5);
  W = Math.floor(innerWidth * DPR);
  H = Math.floor(innerHeight * DPR);
  scene.width = W; scene.height = H;
  if (useGL) {
    view.width = W; view.height = H;
    view.style.width = innerWidth + 'px';
    view.style.height = innerHeight + 'px';
    gl.viewport(0, 0, W, H);
  } else {
    scene.style.width = innerWidth + 'px';
    scene.style.height = innerHeight + 'px';
  }
}
addEventListener('resize', resize);
resize();

const holeData = new Float32Array(MAX_HOLES * 4);
const modeData = new Float32Array(MAX_HOLES);

function renderGL(list, time) {
  gl.bindTexture(gl.TEXTURE_2D, glTex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, scene);
  holeData.fill(0);
  modeData.fill(0);
  list.forEach((h, i) => {
    holeData[i * 4] = h.sx; holeData[i * 4 + 1] = h.sy;
    holeData[i * 4 + 2] = h.sr; holeData[i * 4 + 3] = h.spin;
    modeData[i] = h.mode;
  });
  gl.uniform2f(glU.res, W, H);
  gl.uniform1f(glU.time, time);
  gl.uniform1i(glU.n, list.length);
  gl.uniform4fv(glU.holes, holeData);
  gl.uniform1fv(glU.modes, modeData);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

// ---------------------------------------------------------------------------
// Procedural sprites
// ---------------------------------------------------------------------------
function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function dustSprite() {
  const c = makeCanvas(32), g = c.getContext('2d');
  const hue = rand(190, 240);
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, `hsla(${hue},60%,90%,1)`);
  gr.addColorStop(0.4, `hsla(${hue},50%,70%,0.6)`);
  gr.addColorStop(1, `hsla(${hue},50%,50%,0)`);
  g.fillStyle = gr;
  g.fillRect(0, 0, 32, 32);
  return { c, ext: 1.6 };
}

function asteroidSprite() {
  const S = 64, c = makeCanvas(S), g = c.getContext('2d');
  const pts = 11, base = S * 0.46;
  g.beginPath();
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * TAU, r = base * rand(0.72, 1);
    g.lineTo(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r);
  }
  g.closePath();
  const l = rand(28, 45);
  const gr = g.createRadialGradient(S * 0.35, S * 0.35, 2, S / 2, S / 2, base);
  gr.addColorStop(0, `hsl(${rand(20, 40)},18%,${l + 25}%)`);
  gr.addColorStop(1, `hsl(${rand(10, 30)},20%,${l - 15}%)`);
  g.fillStyle = gr;
  g.fill();
  g.save();
  g.clip();
  for (let i = 0; i < 6; i++) {
    g.fillStyle = 'rgba(0,0,0,0.25)';
    g.beginPath();
    g.arc(rand(10, S - 10), rand(10, S - 10), rand(2, 7), 0, TAU);
    g.fill();
  }
  g.restore();
  return { c, ext: 1.0 };
}

function planetSprite() {
  const S = 160, c = makeCanvas(S), g = c.getContext('2d');
  const R = S * 0.3, cx = S / 2, cy = S / 2;
  const hue = rand(0, 360);
  const ringed = Math.random() < 0.35;
  const drawRing = (frontHalf) => {
    g.save();
    g.translate(cx, cy);
    g.rotate(-0.35);
    g.scale(1, 0.28);
    g.beginPath();
    if (frontHalf) g.arc(0, 0, R * 1.6, 0, Math.PI);
    else g.arc(0, 0, R * 1.6, Math.PI, TAU);
    g.lineWidth = R * 0.35;
    g.strokeStyle = `hsla(${hue + 30},40%,75%,0.55)`;
    g.stroke();
    g.restore();
  };
  if (ringed) drawRing(false);
  g.save();
  g.beginPath();
  g.arc(cx, cy, R, 0, TAU);
  g.clip();
  g.fillStyle = `hsl(${hue},55%,45%)`;
  g.fillRect(0, 0, S, S);
  for (let y = cy - R; y < cy + R; y += rand(3, 9)) {
    g.fillStyle = `hsla(${hue + rand(-25, 25)},${rand(40, 70)}%,${rand(35, 70)}%,0.55)`;
    g.fillRect(0, y, S, rand(2, 7));
  }
  const sh = g.createRadialGradient(cx - R * 0.4, cy - R * 0.4, R * 0.1, cx, cy, R * 1.1);
  sh.addColorStop(0, 'rgba(255,255,255,0.25)');
  sh.addColorStop(0.5, 'rgba(0,0,0,0)');
  sh.addColorStop(1, 'rgba(0,0,0,0.75)');
  g.fillStyle = sh;
  g.fillRect(0, 0, S, S);
  g.restore();
  if (ringed) drawRing(true);
  // atmosphere glow
  const at = g.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.15);
  at.addColorStop(0, `hsla(${hue},80%,70%,0.35)`);
  at.addColorStop(1, `hsla(${hue},80%,70%,0)`);
  g.fillStyle = at;
  g.fillRect(0, 0, S, S);
  return { c, ext: S / (2 * R) };
}

function starSprite() {
  const S = 160, c = makeCanvas(S), g = c.getContext('2d');
  const palette = [[210, 100, 75], [50, 100, 70], [25, 100, 60], [0, 100, 62], [190, 90, 80]];
  const [h, s, l] = palette[Math.floor(Math.random() * palette.length)];
  const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  gr.addColorStop(0, '#fff');
  gr.addColorStop(0.18, `hsl(${h},${s}%,${l + 15}%)`);
  gr.addColorStop(0.33, `hsla(${h},${s}%,${l}%,0.55)`);
  gr.addColorStop(0.55, `hsla(${h},${s}%,${l - 10}%,0.15)`);
  gr.addColorStop(1, `hsla(${h},${s}%,${l - 20}%,0)`);
  g.fillStyle = gr;
  g.fillRect(0, 0, S, S);
  // diffraction spikes
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = `hsla(${h},${s}%,85%,0.35)`;
  g.lineWidth = 1.5;
  g.beginPath();
  g.moveTo(S / 2, 4); g.lineTo(S / 2, S - 4);
  g.moveTo(4, S / 2); g.lineTo(S - 4, S / 2);
  g.stroke();
  return { c, ext: 1 / 0.3 };
}

function galaxySprite() {
  const S = 256, c = makeCanvas(S), g = c.getContext('2d');
  const hue = rand(180, 320);
  const core = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.18);
  core.addColorStop(0, 'rgba(255,245,225,1)');
  core.addColorStop(1, 'rgba(255,220,180,0)');
  g.globalCompositeOperation = 'lighter';
  const arms = Math.random() < 0.5 ? 2 : 3;
  for (let i = 0; i < 2200; i++) {
    const t = Math.pow(Math.random(), 0.7);
    const arm = Math.floor(Math.random() * arms);
    const a = arm * (TAU / arms) + t * 5.5 + rand(-0.35, 0.35) * (1 - t * 0.5);
    const r = t * S * 0.46;
    const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r * 0.85;
    const blue = Math.random() < 0.6;
    g.fillStyle = blue ? `hsla(${hue},80%,75%,${0.5 * (1 - t) + 0.15})` : `hsla(40,90%,80%,${0.4 * (1 - t) + 0.1})`;
    const sz = rand(0.6, 1.8);
    g.fillRect(x, y, sz, sz);
  }
  g.fillStyle = core;
  g.fillRect(0, 0, S, S);
  return { c, ext: 1.0 };
}

// Silly things that drifted into space. Always edible, each with a reaction.
const FUNNY = [
  ['🐄', 'MOO?!'], ['🦆', 'QUACK'], ['🍕', 'EXTRA CHEESE'], ['🚽', 'FLUSHED'],
  ['🧦', 'FOUND THE LOST SOCK'], ['🍩', "D'OH!"], ['🐈', 'NOT THE CAT!'], ['🛸', 'ABDUCTED THE ALIENS'],
  ['🥔', 'SPACE POTATO'], ['🎸', 'ROCK & ROLL'], ['🦖', 'EXTINCT. AGAIN.'], ['🧀', 'MOON CHEESE'],
  ['🛒', 'CLEANUP ON AISLE ∞'], ['🍌', 'BANANA FOR SCALE'], ['🦄', 'NOT SO MAGICAL NOW'], ['🧻', 'TP RUN'],
  ['🐧', 'NOOT NOOT'], ['🌮', 'TACO TUESDAY'], ['📎', 'IT LOOKS LIKE YOU’RE DYING'], ['🎅', 'NAUGHTY LIST'],
];

function funnySprite([emoji, quip]) {
  const S = 96, c = makeCanvas(S), g = c.getContext('2d');
  g.font = `${S * 0.78}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(255,255,255,0.55)';
  g.shadowBlur = 10;
  g.fillText(emoji, S / 2, S / 2 + S * 0.05);
  return { c, ext: 1.15, quip };
}

const CAT = (() => {
  const S = 256, c = makeCanvas(S), g = c.getContext('2d');
  g.font = `${S * 0.8}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.shadowColor = 'rgba(255,200,120,0.9)';
  g.shadowBlur = 30;
  g.fillText('🐱', S / 2, S / 2 + S * 0.05);
  return c;
})();

const SPRITES = {
  funny: FUNNY.map(funnySprite),
  dust: Array.from({ length: 6 }, dustSprite),
  asteroid: Array.from({ length: 8 }, asteroidSprite),
  planet: Array.from({ length: 10 }, planetSprite),
  star: Array.from({ length: 8 }, starSprite),
  galaxy: Array.from({ length: 5 }, galaxySprite),
};

function typeFor(r) {
  if (r < 3) return 'dust';
  if (r < 9) return 'asteroid';
  if (r < 32) return 'planet';
  if (r < 130) return 'star';
  return 'galaxy';
}

// ---------------------------------------------------------------------------
// Background starfield (parallax tiles)
// ---------------------------------------------------------------------------
function starTile(size, count, maxSz, alpha) {
  const c = makeCanvas(size), g = c.getContext('2d');
  for (let i = 0; i < count; i++) {
    const hue = Math.random() < 0.7 ? rand(200, 240) : rand(20, 50);
    g.fillStyle = `hsla(${hue},70%,${rand(75, 95)}%,${rand(0.3, 1) * alpha})`;
    const s = rand(0.5, maxSz);
    g.beginPath();
    g.arc(rand(0, size), rand(0, size), s, 0, TAU);
    g.fill();
  }
  return c;
}
function nebulaTile(size) {
  const c = makeCanvas(size), g = c.getContext('2d');
  // Tileable: draw each blob at its 9 wrapped positions.
  for (let i = 0; i < 9; i++) {
    const x = rand(0, size), y = rand(0, size), r = rand(size * 0.12, size * 0.35);
    const hue = [270, 220, 320, 190, 20][i % 5];
    for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
      const gr = g.createRadialGradient(x + ox * size, y + oy * size, 0, x + ox * size, y + oy * size, r);
      gr.addColorStop(0, `hsla(${hue},70%,45%,0.11)`);
      gr.addColorStop(1, `hsla(${hue},70%,30%,0)`);
      g.fillStyle = gr;
      g.fillRect(0, 0, size, size);
    }
  }
  return c;
}
const BG = [
  { tile: nebulaTile(1600), f: 0.015 },
  { tile: starTile(1024, 700, 1.0, 0.7), f: 0.03 },
  { tile: starTile(1024, 220, 1.5, 0.9), f: 0.07 },
  { tile: starTile(1024, 60, 2.2, 1.0), f: 0.14 },
];

function drawBackground() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#02030a';
  ctx.fillRect(0, 0, W, H);
  for (const layer of BG) {
    const T = layer.tile.width;
    const ox = ((-cam.x * layer.f * cam.z * 4) % T + T) % T;
    const oy = ((-cam.y * layer.f * cam.z * 4) % T + T) % T;
    for (let x = ox - T; x < W; x += T) {
      for (let y = oy - T; y < H; y += T) ctx.drawImage(layer.tile, x, y);
    }
  }
}

// ---------------------------------------------------------------------------
// Audio (Web Audio synthesis, no files)
// ---------------------------------------------------------------------------
const audio = { ctx: null, master: null, drone: null, filter: null, lastBlip: 0 };

function initAudio() {
  if (audio.ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const a = new AC();
  audio.ctx = a;
  audio.master = a.createGain();
  audio.master.gain.value = 0.6;
  audio.master.connect(a.destination);
  audio.filter = a.createBiquadFilter();
  audio.filter.type = 'lowpass';
  audio.filter.frequency.value = 180;
  audio.filter.Q.value = 6;
  audio.drone = a.createGain();
  audio.drone.gain.value = 0.09;
  audio.filter.connect(audio.drone);
  audio.drone.connect(audio.master);
  for (const f of [41.2, 41.6, 61.8]) {
    const o = a.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = f;
    o.connect(audio.filter);
    o.start();
  }
}

function blip(size) {
  const a = audio.ctx;
  if (!a || a.currentTime - audio.lastBlip < 0.03) return;
  audio.lastBlip = a.currentTime;
  const o = a.createOscillator(), g = a.createGain();
  const f = clamp(1400 / (1 + size * 4), 90, 1400);
  o.type = 'sine';
  o.frequency.setValueAtTime(f, a.currentTime);
  o.frequency.exponentialRampToValueAtTime(f * 0.4, a.currentTime + 0.18);
  g.gain.setValueAtTime(0.0001, a.currentTime);
  g.gain.exponentialRampToValueAtTime(0.08 + size * 0.1, a.currentTime + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + 0.25);
  o.connect(g); g.connect(audio.master);
  o.start(); o.stop(a.currentTime + 0.3);
}

function quack() {
  const a = audio.ctx;
  if (!a) return;
  [0, 0.11].forEach((dt, i) => {
    const o = a.createOscillator(), g = a.createGain(), f = a.createBiquadFilter();
    const t = a.currentTime + dt;
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(i ? 520 : 640, t);
    o.frequency.exponentialRampToValueAtTime(i ? 260 : 380, t + 0.09);
    f.type = 'bandpass';
    f.frequency.value = 1200;
    f.Q.value = 3;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(f); f.connect(g); g.connect(audio.master);
    o.start(t); o.stop(t + 0.12);
  });
}

function boom(low) {
  const a = audio.ctx;
  if (!a) return;
  const len = a.sampleRate * 1.6;
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.setValueAtTime(low ? 900 : 2400, a.currentTime);
  f.frequency.exponentialRampToValueAtTime(40, a.currentTime + 1.5);
  const g = a.createGain();
  g.gain.value = low ? 0.9 : 0.5;
  src.connect(f); f.connect(g); g.connect(audio.master);
  src.start();
}

function chord() {
  const a = audio.ctx;
  if (!a) return;
  [220, 277.2, 329.6, 440].forEach((f, i) => {
    const o = a.createOscillator(), g = a.createGain();
    o.type = 'triangle';
    o.frequency.value = f;
    const t = a.currentTime + i * 0.07;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    o.connect(g); g.connect(audio.master);
    o.start(t); o.stop(t + 2);
  });
}

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------
const RIVAL_NAMES = ['SGR A*', 'M87*', 'CYGNUS X-1', 'TON 618', 'GAIA BH1', 'V404 CYG',
  'PHOENIX A', 'GRO J1655', 'OJ 287', 'HOLM 15A', 'NGC 1277', 'A0620-00'];
let nameIdx = 0;

const TIERS = [
  { r: 0, name: 'Asteroid Devourer' },
  { r: 24, name: 'Planet Eater', sub: 'planets are now on the menu' },
  { r: 80, name: 'Star Swallower', sub: 'stars are now on the menu' },
  { r: 260, name: 'Galaxy Ender', sub: 'nothing is safe' },
];

let mode = 'title';            // title | play | dead | won
let objects = [], holes = [], particles = [];
let player = null;
let cam = { x: 0, y: 0, z: 1 };
let mouse = { x: 0, y: 0, down: false }, spaceDown = false;
const keys = new Set();
let inputMode = 'mouse';    // whichever the player touched last steers
const KEY_DIRS = {
  ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
  ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0],
};
let gameTime = 0, realTime = 0, slowmo = 1, shake = 0;
let tierIdx = 0, peakMass = 0, eaten = 0, holesEaten = 0;
let bannerTimer = 0;
let lives = 3, respawnTimer = 0, deadMass = 0;
let boss = null, bossTimer = -1, paused = false, wonTime = 0;
let winT = 0, winReset = false, winStats = null;
const flashEl = document.getElementById('flash');
const START_LIVES = 3;
const BOSS_NAME = 'THE GREAT ATTRACTOR';
const BOSS_START = 3.0;               // boss mass relative to the player when it appears
const BOSS_EAT_RATIO = 1.08 * 1.08;  // mass ratio needed to swallow the boss

const BEST_KEY = 'eventHorizon.best';
function loadBest() {
  try { return JSON.parse(localStorage.getItem(BEST_KEY)) || {}; } catch (e) { return {}; }
}
function saveBest(update) {
  const best = { ...loadBest(), ...update };
  try { localStorage.setItem(BEST_KEY, JSON.stringify(best)); } catch (e) { /* storage unavailable */ }
  return best;
}
const fmtTime = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
function bestLine() {
  const b = loadBest();
  const parts = [];
  if (b.mass) parts.push(`best mass ${fmtMass(b.mass)} M☉`);
  if (b.time) parts.push(`fastest universe ${fmtTime(b.time)}`);
  return parts.length ? `<p class="best">${parts.join(' &nbsp;·&nbsp; ')}</p>` : '';
}

const radiusOf = (M) => Math.sqrt(M);
// How big a hole of world-radius r appears on screen (device px).
const screenRadius = (r) => 22 * DPR * Math.pow(r / 10, 0.3);
const maxSpeed = (r) => 300 * DPR * (r / screenRadius(r)) * Math.pow(r / 10, -0.08);

function makeHole(x, y, M, isPlayer) {
  return {
    x, y, vx: 0, vy: 0, M, r: radiusOf(M), isPlayer,
    name: isPlayer ? 'YOU' : RIVAL_NAMES[nameIdx++ % RIVAL_NAMES.length],
    spin: Math.random() < 0.5 ? -1 : 1, alive: true,
    think: 0, tx: 0, ty: 0, wander: rand(0, TAU), invuln: 0, boss: false,
    fed: 0, quasar: 0,   // Eddington limit: recent intake, and remaining flare time
  };
}

function viewHalfDiag() {
  const targetZ = player ? screenRadius(player.r) / player.r : cam.z;
  return Math.hypot(W, H) / 2 / Math.min(cam.z, targetZ);
}

function spawnObject(x, y, refR) {
  const u = Math.random();
  let ratio;
  if (u < 0.66) ratio = rand(0.07, 0.4);
  else if (u < 0.94) ratio = rand(0.4, 0.92);
  else ratio = rand(1.3, 2.6);
  const funny = Math.random() < 0.1;
  const r = refR * (funny ? rand(0.5, 0.85) : ratio);
  const type = funny ? 'funny' : typeFor(r);
  const list = SPRITES[type];
  const sp = list[Math.floor(Math.random() * list.length)];
  const a = rand(0, TAU), s = rand(0, refR * 1.5);
  objects.push({
    x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r, type, sp,
    rot: rand(0, TAU), vr: rand(-0.6, 0.6) * (type === 'galaxy' ? 0.15 : type === 'funny' ? 3 : 1),
    stretch: 1, sa: 0,
  });
}

function spawnRival(minD, maxD) {
  const a = rand(0, TAU), d = rand(minD, maxD);
  // Mix of prey and predators around the player's size.
  const big = Math.random() < 0.4 + tierIdx * 0.06;
  const k = big ? rand(1.2, 2.2 + tierIdx * 0.1) : rand(0.25, 0.85);
  const dist = Math.max(d, (player.r + radiusOf(player.M * k)) * 4);
  const h = makeHole(player.x + Math.cos(a) * dist, player.y + Math.sin(a) * dist, player.M * k, false);
  holes.push(h);
}

function resetWorld() {
  objects = []; particles = [];
  nameIdx = Math.floor(rand(0, RIVAL_NAMES.length));
  player = makeHole(0, 0, 100, true);
  holes = [player];
  cam.x = 0; cam.y = 0; cam.z = screenRadius(player.r) / player.r;
  const hd = viewHalfDiag();
  for (let i = 0; i < 380; i++) {
    const a = rand(0, TAU), d = rand(player.r * 4, hd * 1.6);
    spawnObject(Math.cos(a) * d, Math.sin(a) * d, player.r);
  }
  for (let i = 0; i < 6; i++) spawnRival(hd * 1.3, hd * 2.6);
  tierIdx = 0; peakMass = player.M; eaten = 0; holesEaten = 0;
  gameTime = 0; slowmo = 1; shake = 0;
  lives = START_LIVES; respawnTimer = 0; boss = null; bossTimer = -1; paused = false;
}

function calmScene() {
  resetWorld();
  holes = [player];
}

function startGame() {
  initAudio();
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  resetWorld();
  mode = 'play';
  winReset = false;
  overlayEl.classList.add('hidden');
  setPaused(false);
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
addEventListener('mousemove', (e) => {
  mouse.x = e.clientX * DPR; mouse.y = e.clientY * DPR;
  if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) inputMode = 'mouse';
});
addEventListener('mousedown', () => { mouse.down = true; });
addEventListener('mouseup', () => { mouse.down = false; });
addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  inputMode = 'mouse';
  mouse.x = t.clientX * DPR; mouse.y = t.clientY * DPR;
}, { passive: true });
addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  mouse.x = t.clientX * DPR; mouse.y = t.clientY * DPR;
}, { passive: true });
addEventListener('keydown', (e) => {
  if (KEY_DIRS[e.code]) {
    keys.add(e.code);
    inputMode = 'keys';
    e.preventDefault();
  }
  if ((e.code === 'KeyP' || e.code === 'Escape') && mode === 'play') {
    setPaused(!paused);
    return;
  }
  if (e.code === 'Space') {
    spaceDown = true;
    e.preventDefault();
    if (!e.repeat && !overlayEl.classList.contains('hidden')) startGame();
  }
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === 'Space') spaceDown = false;
});
addEventListener('blur', () => {
  keys.clear(); spaceDown = false; mouse.down = false;
  if (mode === 'play') setPaused(true);
});
function setPaused(p) {
  paused = p;
  pauseEl.classList.toggle('hidden', !p);
  if (audio.ctx) p ? audio.ctx.suspend() : audio.ctx.resume();
}
pauseEl.addEventListener('click', () => setPaused(false));
overlayEl.addEventListener('click', startGame);

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------
function burst(x, y, h, count, color, size) {
  for (let i = 0; i < count; i++) {
    const a = rand(0, TAU), s = rand(0.5, 2) * h.r;
    particles.push({
      x: x + rand(-size, size), y: y + rand(-size, size),
      vx: Math.cos(a) * s - (y - h.y) * h.spin * 2, vy: Math.sin(a) * s + (x - h.x) * h.spin * 2,
      life: rand(0.5, 1.4), max: 1.4, color, size: rand(0.06, 0.16) * h.r, hole: h,
    });
  }
}

const COLORS = { funny: '#ffffff', dust: '#bcd4ff', asteroid: '#e8c39a', planet: '#9fe0ff', star: '#fff1b0', galaxy: '#e7b8ff' };

function grow(h, dm) {
  h.M += dm;
  h.r = radiusOf(h.M);
}

// A rival that swallows more than half its own mass in a short burst goes quasar.
const EDDINGTON = 0.5;
function feed(h, dm) {
  if (h.isPlayer || h.boss) return;
  h.fed += dm / h.M;
}

function goQuasar(h) {
  h.quasar = 3;
  h.fed = 0;
  const sx = W / 2 + (h.x - cam.x) * cam.z, sy = H / 2 + (h.y - cam.y) * cam.z;
  if (sx > 0 && sx < W && sy > 0 && sy < H) {
    popup(`${h.name} WENT QUASAR!`, h.x, h.y - h.r * 2.5);
    boom(false);
  }
}

function eatObject(h, o) {
  const dm = o.r * o.r * 0.7;
  if (!h.boss) grow(h, dm);
  feed(h, dm);
  burst(o.x, o.y, h, Math.min(24, 4 + Math.floor(o.r / h.r * 30)), COLORS[o.type], o.r);
  if (h.isPlayer && mode === 'play') {
    eaten++;
    if (o.type === 'funny') {
      quack();
      popup(o.sp.quip, o.x, o.y);
    } else {
      blip(o.r / h.r);
    }
    shake = Math.max(shake, (o.r / h.r) * 6);
  }
}

function updateHoles(dt) {
  const hd = viewHalfDiag();
  for (const h of holes) {
    if (!h.alive) continue;
    const ms = maxSpeed(h.r);
    let dx, dy, speed;
    h.invuln = Math.max(0, h.invuln - dt);
    if (h.isPlayer) {
      if (mode !== 'play' && !h.cat) { h.vx *= 0.9; h.vy *= 0.9; continue; }
      let d;
      if (inputMode === 'keys') {
        dx = 0; dy = 0;
        for (const k of keys) { dx += KEY_DIRS[k][0]; dy += KEY_DIRS[k][1]; }
        speed = dx || dy ? ms : 0;
        if (!dx && !dy) { dx = h.vx; dy = h.vy; }
        d = Math.hypot(dx, dy) || 1;
      } else {
        const mx = cam.x + (mouse.x - W / 2) / cam.z;
        const my = cam.y + (mouse.y - H / 2) / cam.z;
        dx = mx - h.x; dy = my - h.y;
        d = Math.hypot(dx, dy) || 1;
        speed = Math.min(ms, d * 2.5);
      }
      const boosting = (mouse.down || spaceDown) && h.M > 60;
      if (boosting) {
        speed = ms * 1.8;
        const loss = h.M * 0.06 * dt;
        grow(h, -loss);
        if (Math.random() < 0.8) {
          particles.push({
            x: h.x - dx / d * h.r * 1.1 + rand(-h.r, h.r) * 0.4,
            y: h.y - dy / d * h.r * 1.1 + rand(-h.r, h.r) * 0.4,
            vx: -dx / d * ms * rand(0.4, 1), vy: -dy / d * ms * rand(0.4, 1),
            life: 0.6, max: 0.6, color: '#ffcf7a', size: h.r * 0.12, hole: null,
          });
        }
      }
      dx /= d; dy /= d;
    } else if (h.boss) {
      // The boss relentlessly stalks the player, but slowly.
      const target = player.alive && player.invuln <= 0 ? player : null;
      if (target) { h.tx = target.x - h.x; h.ty = target.y - h.y; }
      else { h.wander += rand(-0.5, 0.5) * dt * 10; h.tx = Math.cos(h.wander); h.ty = Math.sin(h.wander); }
      const d = Math.hypot(h.tx, h.ty) || 1;
      dx = h.tx / d; dy = h.ty / d;
      speed = ms * (target ? 0.74 : 0.3);
    } else if (h.quasar > 0) {
      // Erupting: drifts, sheds mass, sprays jets of plasma.
      h.quasar -= dt;
      grow(h, -h.M * 0.24 * dt);
      dx = h.vx; dy = h.vy;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d; dy /= d;
      speed = ms * 0.25;
      for (let i = 0; i < 3; i++) {
        const dir = Math.random() < 0.5 ? -1 : 1, v = h.r * rand(10, 18);
        particles.push({
          x: h.x + rand(-0.2, 0.2) * h.r, y: h.y + dir * h.r * 1.1,
          vx: rand(-0.5, 0.5) * h.r, vy: dir * v,
          life: 0.7, max: 0.7, color: Math.random() < 0.5 ? '#bfe6ff' : '#ffffff', size: h.r * 0.22, hole: null,
        });
      }
    } else {
      h.fed = Math.max(0, h.fed - dt * 0.12);
      if (h.fed > EDDINGTON) goQuasar(h);
      h.think -= dt;
      if (h.think <= 0) {
        h.think = rand(0.2, 0.45);
        let fx = 0, fy = 0;
        let chase = null, chaseD = Infinity;
        for (const o of holes) {
          if (o === h || !o.alive) continue;
          const ddx = o.x - h.x, ddy = o.y - h.y, d = Math.hypot(ddx, ddy);
          if (o.r > h.r * 1.08 && d < h.r * 16) {
            fx -= ddx / d * (h.r * 16 - d); fy -= ddy / d * (h.r * 16 - d);
          } else if (h.r > o.r * 1.08 && d < h.r * 11 && d < chaseD && !o.boss && (!o.isPlayer || (gameTime > 6 && o.invuln <= 0))) {
            chase = o; chaseD = d;
          }
        }
        if (chase && (fx * fx + fy * fy) < 1) {
          h.tx = chase.x - h.x; h.ty = chase.y - h.y;
        } else if (fx * fx + fy * fy >= 1) {
          h.tx = fx; h.ty = fy;
        } else {
          // Graze: head toward the nearest edible object, with some wander.
          let best = null, bd = h.r * 12;
          for (const o of objects) {
            if (o.r >= h.r) continue;
            const d = Math.abs(o.x - h.x) + Math.abs(o.y - h.y);
            if (d < bd) { bd = d; best = o; }
          }
          h.wander += rand(-0.8, 0.8);
          if (best) { h.tx = best.x - h.x; h.ty = best.y - h.y; }
          else { h.tx = Math.cos(h.wander); h.ty = Math.sin(h.wander); }
        }
      }
      const d = Math.hypot(h.tx, h.ty) || 1;
      dx = h.tx / d; dy = h.ty / d;
      speed = ms * (0.82 + tierIdx * 0.04);
      // Rivals that outgrow the player evaporate (Hawking radiation) so nobody snowballs.
      if (h.M > player.M * 3) grow(h, -h.M * 0.3 * dt);
    }
    const k = Math.min(1, dt * 3.5);
    h.vx += (dx * speed - h.vx) * k;
    h.vy += (dy * speed - h.vy) * k;
    h.x += h.vx * dt;
    h.y += h.vy * dt;
  }

  // Holes eating holes.
  for (const a of holes) {
    if (!a.alive || a.quasar > 0 || a.cat) continue;
    for (const b of holes) {
      if (a === b || !b.alive || b.cat || a.r <= b.r * 1.08) continue;
      if (b.isPlayer && (mode !== 'play' || b.invuln > 0)) continue;
      if (b.boss && !a.isPlayer) continue;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < a.r * 0.9) {
        b.alive = false;
        if (b.isPlayer) deadMass = b.M;
        if (!a.boss) { grow(a, b.M * 0.8); feed(a, b.M * 0.8); }
        burst(b.x, b.y, a, 60, b.isPlayer ? '#ffb347' : '#ffd6f0', b.r);
        if (a.isPlayer && b.boss) {
          win();
        } else if (a.isPlayer) {
          holesEaten++;
          shake = 18;
          boom(false);
          showBanner(`${b.name} CONSUMED`, `+${fmtMass(b.M * 0.8)}`);
        }
        if (b.isPlayer) die(a);
      }
    }
  }

  // Keep a population of rivals around the player.
  holes = holes.filter((h) => h.alive && (h.isPlayer || h.boss || Math.hypot(h.x - player.x, h.y - player.y) < Math.max(hd * 4, player.r * 40)));
  if (mode === 'play') {
    while (holes.filter((h) => !h.isPlayer && !h.boss).length < 9) {
      spawnRival(Math.max(hd * 1.4, player.r * 14), Math.max(hd * 2.6, player.r * 26));
    }
  }
}

function updateObjects(dt) {
  const hd = viewHalfDiag();
  const live = holes.filter((h) => h.alive && !h.cat);
  // New matter appears beyond the player's gravity reach (11r), whatever the zoom.
  const spawnIn = Math.max(hd * 1.05, player.r * 12);
  const spawnR = Math.max(hd * 1.6, player.r * 20);
  const despawnR = Math.max(hd * 2.4, player.r * 30);
  const fresh = [];

  for (const o of objects) {
    let nearest = null, nd = Infinity, ax = 0, ay = 0, eatenBy = null;
    for (const h of live) {
      const dx = h.x - o.x, dy = h.y - o.y;
      const range = h.r * 11;
      if (Math.abs(dx) > range || Math.abs(dy) > range) continue;
      const d2 = dx * dx + dy * dy;
      if (d2 > range * range) continue;
      const d = Math.sqrt(d2) || 0.001;
      const big = o.r >= h.r;
      const flaring = h.quasar > 0;
      if (!big && !flaring && d < h.r * 0.92) { eatenBy = h; break; }
      let a = 60 * h.r * (h.r * h.r) / (d2 + h.r * h.r * 0.2);
      if (big) a *= 0.12;
      if (flaring) a *= -0.5;
      ax += dx / d * a - dy / d * a * 0.35 * h.spin;
      ay += dy / d * a + dx / d * a * 0.35 * h.spin;
      if (d / h.r < nd) { nd = d / h.r; nearest = h; }

      // Tidal disruption: objects too big to swallow get torn apart.
      if (big && !flaring && d < h.r * 1.6 + o.r && Math.random() < dt * 14) {
        const fr = Math.min(o.r * rand(0.14, 0.24), h.r * 0.7);
        const ang = Math.atan2(dy, dx) + rand(-0.5, 0.5);
        const fx = o.x + Math.cos(ang) * o.r * 0.9, fy = o.y + Math.sin(ang) * o.r * 0.9;
        fresh.push({
          x: fx, y: fy, vx: o.vx + (-dy / d) * h.spin * h.r * 3, vy: o.vy + (dx / d) * h.spin * h.r * 3,
          r: fr, type: o.type, sp: o.sp, rot: rand(0, TAU), vr: rand(-3, 3), stretch: 1, sa: 0,
        });
        o.r = Math.sqrt(Math.max(0, o.r * o.r - fr * fr));
        if (h.isPlayer) shake = Math.max(shake, 2);
      }
    }
    if (eatenBy) { eatObject(eatenBy, o); o.dead = true; continue; }
    o.vx += ax * dt; o.vy += ay * dt;
    if (nearest && nd < 5) {
      const damp = 1 - Math.min(0.9, dt * 0.8);
      o.vx *= damp; o.vy *= damp;
    }
    o.x += o.vx * dt; o.y += o.vy * dt;
    o.rot += o.vr * dt;
    // Spaghettification: stretch along the direction to the nearest hole.
    const target = nearest && o.r < nearest.r ? clamp(1 + 2.2 / (nd * nd), 1, 3.5) : 1;
    o.stretch += (target - o.stretch) * Math.min(1, dt * 6);
    if (nearest) o.sa = Math.atan2(nearest.y - o.y, nearest.x - o.x);
    if (Math.hypot(o.x - player.x, o.y - player.y) > despawnR) o.dead = true;
  }
  objects = objects.filter((o) => !o.dead && o.r > 0.3).concat(fresh);

  const target = 420;
  let n = 0;
  while (objects.length < target && n++ < 30) {
    const a = rand(0, TAU), d = rand(spawnIn, spawnR);
    spawnObject(player.x + Math.cos(a) * d, player.y + Math.sin(a) * d, player.r);
  }
}

function updateParticles(dt) {
  for (const p of particles) {
    const h = p.hole;
    if (h && h.alive) {
      const dx = h.x - p.x, dy = h.y - p.y, d = Math.hypot(dx, dy) || 1;
      const a = 80 * h.r * h.r * h.r / (d * d + h.r * h.r * 0.1);
      p.vx += (dx / d * a - dy / d * a * 0.6 * h.spin) * dt;
      p.vy += (dy / d * a + dx / d * a * 0.6 * h.spin) * dt;
      p.vx *= 1 - Math.min(0.9, dt * 1.5);
      p.vy *= 1 - Math.min(0.9, dt * 1.5);
      if (d < h.r * 0.95) p.life = 0;
    }
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.life -= dt;
  }
  particles = particles.filter((p) => p.life > 0);
  if (particles.length > 1500) particles.splice(0, particles.length - 1500);
}

function die(killer) {
  lives--;
  slowmo = 0.25;
  shake = 30;
  boom(true);
  if (lives > 0) {
    respawnTimer = 1.8;
    showBanner('SPAGHETTIFIED', `by ${killer.name} · ${lives} ${lives === 1 ? 'life' : 'lives'} left`);
    return;
  }
  mode = 'dead';
  const best = loadBest();
  if (!best.mass || peakMass > best.mass) saveBest({ mass: peakMass });
  setTimeout(() => {
    if (mode !== 'dead') return;
    overlayEl.innerHTML = `
      <h1>SPAGHETTIFIED</h1>
      <div><p>Your last life was consumed by <span style="color:var(--danger)">${killer.name}</span></p>
      <p class="stat">PEAK MASS ${fmtMass(peakMass)} M☉</p>
      <p>${eaten} objects devoured &nbsp;·&nbsp; ${holesEaten} black holes consumed &nbsp;·&nbsp; ${fmtTime(gameTime)} survived<br>rank reached: ${TIERS[tierIdx].name}</p>
      ${bestLine()}
      <div class="cta">CLICK TO BE REBORN</div></div>`;
    overlayEl.classList.remove('hidden');
    calmScene();
    mode = 'title';
  }, 1400);
}

function respawn() {
  const hd = viewHalfDiag();
  player = makeHole(cam.x, cam.y, Math.max(100, deadMass * 0.6), true);
  player.invuln = 3;
  // Predators nearby lose interest; the boss gets pushed back.
  holes = holes.filter((h) => h.boss || !(h.r > player.r && Math.hypot(h.x - cam.x, h.y - cam.y) < hd * 1.2));
  if (boss && boss.alive) {
    boss.M = Math.min(boss.M, player.M * BOSS_START);
    boss.r = radiusOf(boss.M);
    const a = Math.atan2(boss.y - cam.y, boss.x - cam.x);
    boss.x = cam.x + Math.cos(a) * hd * 1.5;
    boss.y = cam.y + Math.sin(a) * hd * 1.5;
  }
  holes.push(player);
  chord();
}

function spawnBoss() {
  const hd = viewHalfDiag(), a = rand(0, TAU);
  boss = makeHole(player.x + Math.cos(a) * hd * 1.4, player.y + Math.sin(a) * hd * 1.4, player.M * BOSS_START, false);
  boss.name = BOSS_NAME;
  boss.boss = true;
  holes.push(boss);
  showBanner('FINAL BOSS', `${BOSS_NAME} approaches · outgrow it, then eat it`);
  boom(true);
  shake = 14;
}

function win() {
  mode = 'won';
  wonTime = gameTime;
  winT = 0;
  winReset = false;
  winStats = { eaten, holesEaten, lives };
  shake = 10;
  boom(true);
  chord();
  const best = loadBest();
  saveBest({
    time: !best.time || wonTime < best.time ? wonTime : best.time,
    mass: !best.mass || peakMass > best.mass ? peakMass : best.mass,
  });
}

// Ending timeline: 0–2.4s the frozen universe falls into you, then a big bang.
const WIN_SWALLOW = 2.4, WIN_OVERLAY = 3.4;
function updateWin(rawDt) {
  winT += rawDt;
  if (winT < WIN_SWALLOW) {
    shake = 4 + 22 * (winT / WIN_SWALLOW);
    if (audio.ctx) audio.filter.frequency.setTargetAtTime(60, audio.ctx.currentTime, 0.4);
    return;
  }
  if (!winReset) {
    winReset = true;
    flashEl.style.transition = 'none';
    flashEl.style.opacity = 1;
    void flashEl.offsetWidth;
    flashEl.style.transition = 'opacity 2.4s ease-out';
    flashEl.style.opacity = 0;
    calmScene();
    player.cat = true;
    shake = 0;
    boom(false);
    setTimeout(() => popup('MEOW.', player.x, player.y - player.r * 6), 600);
    chord();
    setTimeout(chord, 350);
    return;
  }
  if (winT >= WIN_OVERLAY && overlayEl.classList.contains('hidden')) {
    const st = winStats;
    overlayEl.innerHTML = `
      <h1 class="small">YOU ATE THE UNIVERSE</h1>
      <div><p>${BOSS_NAME} is no more. Neither is anything else.<br>…and from the singularity, a new universe is born. You are now a cat.</p>
      <p class="stat">FINISHED IN ${fmtTime(wonTime)} · ${st.lives} ${st.lives === 1 ? 'LIFE' : 'LIVES'} LEFT</p>
      <p>${st.eaten} objects devoured &nbsp;·&nbsp; ${st.holesEaten} black holes consumed</p>
      ${bestLine()}
      <div class="cta">CLICK TO PLAY AGAIN · OR JUST BE A CAT FOR A WHILE</div></div>`;
    overlayEl.classList.remove('hidden');
  }
}

function fmtMass(M) {
  const v = M * 4.3e4; // scale so the start reads like a stellar-mass black hole... and climbs fast
  if (v >= 1e15) return v.toExponential(1);
  if (v >= 1e12) return (v / 1e12).toFixed(2) + 'T';
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toFixed(0);
}

function popup(text, x, y) {
  const el = document.createElement('div');
  el.className = 'popup';
  el.textContent = text;
  el.style.left = (W / 2 + (x - cam.x) * cam.z) / DPR + 'px';
  el.style.top = (H / 2 + (y - cam.y) * cam.z) / DPR + 'px';
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1600);
}

function showBanner(text, sub) {
  bannerEl.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
  bannerEl.style.opacity = 1;
  bannerTimer = 2.4;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function drawWorld() {
  const z = cam.z;
  const sx = (Math.random() - 0.5) * shake, sy = (Math.random() - 0.5) * shake;
  ctx.setTransform(z, 0, 0, z, W / 2 - cam.x * z + sx, H / 2 - cam.y * z + sy);
  const hw = W / 2 / z, hh = H / 2 / z;

  for (const o of objects) {
    const ext = o.r * o.sp.ext * Math.max(1, o.stretch);
    if (o.x + ext < cam.x - hw || o.x - ext > cam.x + hw || o.y + ext < cam.y - hh || o.y - ext > cam.y + hh) continue;
    const size = o.r * 2 * o.sp.ext;
    ctx.save();
    ctx.translate(o.x, o.y);
    if (o.stretch > 1.02) {
      ctx.rotate(o.sa);
      ctx.scale(o.stretch, 1 / Math.sqrt(o.stretch));
      ctx.rotate(-o.sa);
    }
    ctx.rotate(o.rot);
    if (o.type === 'star' || o.type === 'galaxy') ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(o.sp.c, -size / 2, -size / 2, size, size);
    ctx.restore();
  }

  ctx.globalCompositeOperation = 'lighter';
  for (const h of holes) {
    if (!h.alive || h.quasar <= 0) continue;
    const len = h.r * 14, w = h.r * (0.35 + Math.random() * 0.15);
    const fade = Math.min(1, h.quasar * 2);
    for (const dir of [-1, 1]) {
      const g = ctx.createLinearGradient(h.x, h.y, h.x, h.y + dir * len);
      g.addColorStop(0, `rgba(255,255,255,${0.95 * fade})`);
      g.addColorStop(0.15, `rgba(160,215,255,${0.7 * fade})`);
      g.addColorStop(1, 'rgba(80,140,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(h.x - w * 0.3, h.y);
      ctx.lineTo(h.x - w * 1.6, h.y + dir * len);
      ctx.lineTo(h.x + w * 1.6, h.y + dir * len);
      ctx.lineTo(h.x + w * 0.3, h.y);
      ctx.fill();
    }
  }
  if (player && player.cat) {
    const size = player.r * 9, bob = Math.sin(realTime * 2) * player.r * 0.5;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.translate(player.x, player.y + bob);
    ctx.rotate(Math.sin(realTime * 1.3) * 0.25);
    ctx.drawImage(CAT, -size / 2, -size / 2, size, size);
    ctx.restore();
    ctx.globalCompositeOperation = 'lighter';
  }
  for (const p of particles) {
    const a = clamp(p.life / p.max, 0, 1);
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    const s = p.size * (0.5 + a);
    ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function holeMode(h) {
  if (h.isPlayer) return h.invuln > 0 && Math.floor(realTime * 8) % 2 ? 2 : 0;
  if (h.boss) return 3;
  return h.r > player.r * 1.08 ? 1 : 2;
}

function screenHoles() {
  const z = cam.z, out = [];
  for (const h of holes) {
    if (!h.alive || h.cat) continue;
    const sx = W / 2 + (h.x - cam.x) * z, sy = H / 2 + (h.y - cam.y) * z;
    let sr = h.r * z;
    if (h.isPlayer && mode === 'won' && !winReset) {
      const t = clamp(winT / WIN_SWALLOW, 0, 1), e = t * t * t;
      sr += (Math.hypot(W, H) * 0.62 - sr) * e;
    }
    const m = sr * 10;
    if (sx < -m || sx > W + m || sy < -m || sy > H + m) continue;
    out.push({ sx, sy, sr, spin: h.spin, mode: holeMode(h), h });
  }
  out.sort((a, b) => b.sr - a.sr);
  return out.slice(0, MAX_HOLES);
}

function drawArrows(onScreen) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const visible = new Set(onScreen.filter((s) => s.sx > 0 && s.sx < W && s.sy > 0 && s.sy < H).map((s) => s.h));
  const pad = 26 * DPR;
  for (const h of holes) {
    if (h.isPlayer || !h.alive || visible.has(h)) continue;
    const dx = h.x - cam.x, dy = h.y - cam.y;
    const ang = Math.atan2(dy, dx);
    const t = Math.min((W / 2 - pad) / Math.abs(Math.cos(ang) || 1e-6), (H / 2 - pad) / Math.abs(Math.sin(ang) || 1e-6));
    const x = W / 2 + Math.cos(ang) * t, y = H / 2 + Math.sin(ang) * t;
    const dist = Math.hypot(dx, dy) * cam.z;
    const m = holeMode(h), danger = m === 1;
    ctx.globalAlpha = m === 3 ? 1 : clamp(1.6 - dist / (W * 1.2), 0.15, 0.9);
    ctx.fillStyle = ['#ffb347', '#ff3d6e', '#5ab8ff', '#b46bff'][m];
    const s = (m === 3 ? 18 : danger ? 11 : 8) * DPR;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    ctx.beginPath();
    ctx.moveTo(s, 0); ctx.lineTo(-s * 0.7, s * 0.7); ctx.lineTo(-s * 0.7, -s * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function drawHoles2D(list) {
  // Only used when WebGL is unavailable.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const s of list) {
    const col = ['255,170,60', '255,60,110', '90,184,255', '180,107,255'][s.mode];
    const g = ctx.createRadialGradient(s.sx, s.sy, s.sr, s.sx, s.sy, s.sr * 3);
    g.addColorStop(0, `rgba(${col},0.9)`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(s.sx, s.sy, s.sr * 3, 0, TAU); ctx.fill();
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(s.sx, s.sy, s.sr, 0, TAU); ctx.fill();
  }
}

let boardTimer = 0;
function updateHUD(dt) {
  if (bannerTimer > 0) {
    bannerTimer -= dt;
    if (bannerTimer <= 0) bannerEl.style.opacity = 0;
  }
  boardTimer -= dt;
  if (boardTimer > 0) return;
  boardTimer = 0.2;
  const calm = mode === 'title' || (mode === 'won' && winReset);
  document.body.classList.toggle('playing', !calm);
  if (calm) { hudEl.innerHTML = ''; boardEl.innerHTML = ''; goalEl.innerHTML = ''; return; }
  const hearts = '♥'.repeat(Math.max(0, lives)) + '<span class="lost">' + '♥'.repeat(START_LIVES - Math.max(0, lives)) + '</span>';
  hudEl.innerHTML = `
    <div class="big">${fmtMass(player.M)} M☉</div>
    <div class="tier">${TIERS[tierIdx].name}</div>
    <div class="lives">${hearts}</div>
    <div>${fmtTime(mode === 'won' ? wonTime : gameTime)} · devoured ${eaten} · holes ${holesEaten}</div>`;

  let label, frac, cls = '';
  if (tierIdx < TIERS.length - 1) {
    const r0 = tierIdx === 0 ? 10 : TIERS[tierIdx].r, r1 = TIERS[tierIdx + 1].r;
    frac = Math.log(player.r / r0) / Math.log(r1 / r0);
    label = `STAGE ${tierIdx + 1}/4 · NEXT RANK: ${TIERS[tierIdx + 1].name.toUpperCase()}`;
  } else if (boss && boss.alive) {
    frac = player.M / (boss.M * BOSS_EAT_RATIO);
    cls = frac >= 1 ? 'ready' : 'boss';
    label = frac >= 1 ? `YOU ARE BIG ENOUGH · EAT ${BOSS_NAME}!` : `FINAL STAGE · OUTGROW ${BOSS_NAME}`;
  } else if (mode === 'won') {
    frac = 1; cls = 'ready'; label = 'UNIVERSE CONSUMED';
  } else {
    frac = 1; cls = 'boss'; label = 'SOMETHING ENORMOUS IS COMING…';
  }
  goalEl.innerHTML = `<div class="label">${label}</div><div class="bar ${cls}"><i style="width:${clamp(frac, 0, 1) * 100}%"></i></div>`;

  const ranked = holes.filter((h) => h.alive || h.isPlayer).sort((a, b) => b.M - a.M);
  boardEl.innerHTML = '<div class="h">NEARBY</div>' + ranked.slice(0, 8).map((h) => {
    const cls = h.isPlayer ? 'me' : h.boss ? 'bossname' : (h.r > player.r * 1.08 ? 'danger' : 'prey');
    return `<div class="${cls}">${h.quasar > 0 ? '⚡ ' : ''}${h.name} &nbsp;${fmtMass(h.M)}</div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = performance.now();
function frame(now) {
  let rawDt = clamp((now - last) / 1000, 0, 0.05);
  last = now;
  if (paused) rawDt = 0;
  realTime += rawDt;
  if (mode === 'play') slowmo += (1 - slowmo) * Math.min(1, rawDt * 3);
  const frozen = mode === 'won' && !winReset;
  const dt = frozen ? 0 : rawDt * slowmo;
  if (mode === 'play') gameTime += dt;

  updateHoles(dt);
  updateObjects(dt);
  updateParticles(dt);

  if (mode === 'play') {
    peakMass = Math.max(peakMass, player.M);
    while (tierIdx < TIERS.length - 1 && player.r >= TIERS[tierIdx + 1].r) {
      tierIdx++;
      showBanner(TIERS[tierIdx].name.toUpperCase(), TIERS[tierIdx].sub);
      chord();
      if (tierIdx === TIERS.length - 1) bossTimer = 4;
    }
    if (bossTimer > 0 && player.alive) {
      bossTimer -= dt;
      if (bossTimer <= 0) spawnBoss();
    }
    if (!player.alive && respawnTimer > 0) {
      respawnTimer -= rawDt;
      if (respawnTimer <= 0) respawn();
    }
  }
  if (mode === 'won') updateWin(rawDt);

  // Camera follows the player and zooms out as it grows.
  const follow = player.alive ? player : cam;
  cam.x += (follow.x - cam.x) * Math.min(1, rawDt * 5);
  cam.y += (follow.y - cam.y) * Math.min(1, rawDt * 5);
  if (!frozen) {
    const tz = screenRadius(player.r) / player.r;
    cam.z += (tz - cam.z) * Math.min(1, rawDt * 1.5);
  }
  shake *= Math.pow(0.02, rawDt);

  if (audio.ctx && !frozen) {
    const boosting = mode === 'play' && (mouse.down || spaceDown);
    audio.filter.frequency.setTargetAtTime(boosting ? 900 : 160 + Math.min(400, player.r), audio.ctx.currentTime, 0.1);
  }

  drawBackground();
  drawWorld();
  const list = screenHoles();
  if (mode === 'play') drawArrows(list);
  if (useGL) renderGL(list, realTime);
  else drawHoles2D(list);
  updateHUD(rawDt);
  requestAnimationFrame(frame);
}

calmScene();
requestAnimationFrame(frame);
document.getElementById('titleBest').outerHTML = bestLine() || '<p></p>';
