'use strict';
// 好好睡：睡前放鬆聲音。所有聲音都在手機上即時合成，不需要音檔。

const SR = 44100;
const LOOP = 60;      // 「鎖屏也能播」模式：先合成 60 秒再循環播放
const WARM = 2;       // 先讓濾波器穩定，再取循環音源
const BREATH = 10;    // 一次呼吸 10 秒＝每分鐘 6 次
const INHALE = 4;     // 吸 4 秒、吐 6 秒（吐氣較長比較放鬆）
const NOISE_SEC = 20;
const FADE_SEC = 60;  // 定時結束前最後 60 秒慢慢變小聲

const LAYERS = [
  { id: 'waves', name: '海浪呼吸', desc: '浪聲變大時吸氣、浪退時吐氣，一分鐘 6 次。' },
  { id: 'pad', name: '柔和和弦', desc: '很慢、很輕的和弦（以 432 Hz 調音）。' },
  { id: 'rain', name: '雨聲', desc: '柔和的粉紅噪音，可以蓋過外面的雜音。' },
  { id: 'brown', name: '低沉噪音', desc: '像遠方的風或冷氣聲，比雨聲更低沉。' },
  { id: 'tone', name: '單一頻率', desc: '純音，赫茲數可以自己選。' },
  { id: 'binaural', name: '雙耳節拍', desc: '左右耳頻率差一點點，要戴耳機才有效果。' },
];

const PRESETS = [
  { name: '慢呼吸＋海浪（建議）', layers: { waves: 0.7, pad: 0.3 } },
  { name: '柔和音樂', layers: { pad: 0.6, rain: 0.15 } },
  { name: '雨聲', layers: { rain: 0.5, brown: 0.25 } },
  { name: '432 Hz', layers: { tone: 0.25, pad: 0.25 }, hz: 432 },
  { name: '雙耳節拍（耳機）', layers: { binaural: 0.35, rain: 0.15 }, beat: 4 },
  { name: '低沉噪音', layers: { brown: 0.55 } },
];

const TIMERS = [[15, '15 分'], [30, '30 分'], [45, '45 分'], [60, '1 小時'], [90, '1.5 小時'], [0, '整晚']];
const HZ_CHOICES = [174, 396, 432, 528];
const BEATS = [[6, '6 Hz 放鬆'], [4, '4 Hz 放空'], [2, '2 Hz 入睡']];
const MODES = [['compat', '鎖屏也能播'], ['live', '即時調整']];

const DEFAULT_STATE = {
  layers: {
    waves: { on: true, vol: 0.7 }, pad: { on: true, vol: 0.3 }, rain: { on: false, vol: 0.4 },
    brown: { on: false, vol: 0.4 }, tone: { on: false, vol: 0.25 }, binaural: { on: false, vol: 0.35 },
  },
  hz: 432, beat: 4, timer: 30, mode: 'compat',
};

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem('sleeptone') || '{}');
    const st = { ...structuredClone(DEFAULT_STATE), ...s };
    st.layers = { ...structuredClone(DEFAULT_STATE.layers), ...(s.layers || {}) };
    return st;
  } catch { return structuredClone(DEFAULT_STATE); }
}
let state = loadState();
const save = () => localStorage.setItem('sleeptone', JSON.stringify(state));

// 頻率對齊到 1/60 Hz，60 秒循環時接縫才不會有喀聲
const q = f => Math.round(f * LOOP) / LOOP;

// ───────── 聲音素材 ─────────
const cache = {};

function makeBuffer(seconds, channels, fill) {
  const n = seconds * SR, F = SR; // 頭尾用 1 秒交叉淡化，循環無接縫
  const buf = new AudioBuffer({ length: n, numberOfChannels: channels, sampleRate: SR });
  for (let c = 0; c < channels; c++) {
    const g = fill(n + F);
    const out = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] = i < F ? g[i] * (i / F) + g[n + i] * (1 - i / F) : g[i];
  }
  return buf;
}

function pinkSeries(len) {
  const a = new Float32Array(len);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
    a[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return a;
}

function brownSeries(len) {
  const a = new Float32Array(len);
  let last = 0;
  for (let i = 0; i < len; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    a[i] = last * 3.5;
  }
  return a;
}

function noise(type) {
  if (!cache[type]) {
    const fill = type === 'pink' ? pinkSeries
      : type === 'brown' ? brownSeries
      : len => { const p = pinkSeries(len), b = brownSeries(len); return p.map((v, i) => v * 0.5 + b[i] * 0.8); };
    cache[type] = makeBuffer(NOISE_SEC, 2, fill);
  }
  return cache[type];
}

// 呼吸起伏：0.12～1，吸 4 秒上升、吐 6 秒下降
function breathAt(t) {
  t %= BREATH;
  const x = t < INHALE ? 0.5 - 0.5 * Math.cos(Math.PI * t / INHALE)
    : 0.5 + 0.5 * Math.cos(Math.PI * (t - INHALE) / (BREATH - INHALE));
  return 0.12 + 0.88 * x;
}

function envBuffer() {
  if (!cache.env) {
    const buf = new AudioBuffer({ length: BREATH * SR, numberOfChannels: 1, sampleRate: SR });
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = breathAt(i / SR);
    cache.env = buf;
  }
  return cache.env;
}

// 柔和和弦：先離線合成 60 秒，之後循環播放
function padBuffer() {
  return cache.padP ||= renderPad();
}

async function renderPad() {
  const oc = new OfflineAudioContext(2, 75 * SR, SR);
  const lp = oc.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = 1400;
  lp.connect(oc.destination);
  const chords = [[50, 57, 61, 66], [47, 54, 57, 62], [43, 50, 54, 59], [45, 52, 57, 64]];
  for (let k = 0; k < 5; k++) {
    const start = k * 15;
    const g = oc.createGain();
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(1, start + 6);
    g.gain.setValueAtTime(1, start + 14);
    g.gain.linearRampToValueAtTime(0, start + 20);
    g.connect(lp);
    for (const n of chords[k % 4]) {
      const f = q(432 * Math.pow(2, (n - 69) / 12));
      for (const [d, pan] of [[-0.1, -0.3], [0.1, 0.3]]) {
        const o = oc.createOscillator();
        o.frequency.value = f + d;
        const p = oc.createStereoPanner(); p.pan.value = pan;
        const v = oc.createGain(); v.gain.value = 0.09;
        o.connect(v).connect(p).connect(g);
        o.start(start); o.stop(start + 20.1);
      }
    }
  }
  const full = await oc.startRendering();
  const buf = new AudioBuffer({ length: LOOP * SR, numberOfChannels: 2, sampleRate: SR });
  for (let c = 0; c < 2; c++) buf.copyToChannel(full.getChannelData(c).subarray(15 * SR, 75 * SR), c);
  cache.pad = buf;
  return buf;
}

// ───────── 組合聲音（即時模式與離線合成共用） ─────────
// all＝true：每種聲音都建（即時模式要能隨時開關）；false：只建打開的（離線合成省時間）
function build(ctx, dest, all) {
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(dest);
  const nodes = {};
  const layer = id => {
    const g = ctx.createGain();
    g.gain.value = state.layers[id].on ? state.layers[id].vol : 0;
    g.connect(master);
    nodes[id] = g;
    return g;
  };
  const loopSrc = buf => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0); return s; };
  const filter = (type, f) => { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; return b; };
  const gain = v => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const use = id => all || state.layers[id].on;

  if (use('waves')) { // 海浪呼吸：浪的大小與明暗跟著呼吸起伏
    // 低沉底聲＋明亮浪頭，兩層都隨呼吸起伏；浪頭起伏更大，聽起來像浪打上來又退去
    const out = layer('waves');
    const src = loopSrc(noise('wave'));
    const env = loopSrc(envBuffer());
    const body = gain(0), crest = gain(0);
    env.connect(body.gain);
    env.connect(crest.gain);
    const crestShape = gain(0); // 浪頭音量＝起伏的平方（用乘法節點做）
    env.connect(crestShape.gain);
    src.connect(filter('lowpass', 380)).connect(body).connect(gain(0.8)).connect(out);
    src.connect(filter('lowpass', 1400)).connect(crest).connect(crestShape).connect(gain(0.9)).connect(out);
  }
  if (use('pad')) loopSrc(cache.pad).connect(layer('pad'));
  if (use('rain')) loopSrc(noise('pink')).connect(filter('highpass', 300)).connect(filter('lowpass', 5000)).connect(gain(0.6)).connect(layer('rain'));
  if (use('brown')) loopSrc(noise('brown')).connect(filter('lowpass', 500)).connect(layer('brown'));
  if (use('tone')) { // 單一頻率
    const o = ctx.createOscillator();
    o.frequency.value = q(state.hz);
    o.connect(gain(0.35)).connect(layer('tone'));
    o.start(0);
    nodes.toneOsc = o;
  }
  if (use('binaural')) { // 雙耳節拍：左耳 200 Hz、右耳 200＋節拍
    const m = ctx.createChannelMerger(2);
    const l = ctx.createOscillator(), r = ctx.createOscillator();
    l.frequency.value = 200; r.frequency.value = 200 + state.beat;
    l.connect(m, 0, 0); r.connect(m, 0, 1);
    m.connect(gain(0.3)).connect(layer('binaural'));
    l.start(0); r.start(0);
    nodes.beatOsc = r;
  }
  return { master, nodes };
}

// ───────── 播放 ─────────
const audio = new Audio();
audio.preload = 'auto';
let playing = false;
let live = null;        // 即時模式：{ ctx, graph, t0 }
let loopUrl = null, fadeUrl = null, fading = false;
let endAt = 0;          // 定時結束時間（毫秒），0＝整晚
let tickTimer = null;
let session = 0;        // 每次開始／停止加一，舊的非同步結果不會誤用
let renderVer = 0;      // 同一輪設定變更時，只採用最新的合成結果
let needTap = false;
let lastT = 0;

function wavBlob(buf) {
  const ch = buf.numberOfChannels, n = buf.length;
  const dv = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true);
  dv.setUint32(24, buf.sampleRate, true); dv.setUint32(28, buf.sampleRate * ch * 2, true);
  dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch).keys()].map(c => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, data[c][i]));
    dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); o += 2;
  }
  return new Blob([dv], { type: 'audio/wav' });
}

const silentUrl = URL.createObjectURL(wavBlob(new AudioBuffer({ length: SR / 10, numberOfChannels: 1, sampleRate: SR })));

async function renderMix(fade) {
  if (state.layers.pad.on) await padBuffer();
  const oc = new OfflineAudioContext(2, (WARM + LOOP) * SR, SR);
  const g = build(oc, oc.destination, false);
  if (fade) { g.master.gain.setValueAtTime(0.9, WARM); g.master.gain.linearRampToValueAtTime(0, WARM + LOOP); }
  const full = await oc.startRendering();
  const buf = new AudioBuffer({ length: LOOP * SR, numberOfChannels: 2, sampleRate: SR });
  for (let c = 0; c < 2; c++) buf.copyToChannel(full.getChannelData(c).subarray(WARM * SR, (WARM + LOOP) * SR), c);
  return URL.createObjectURL(wavBlob(buf));
}

async function playUrl(url, at, loop) {
  const my = session, ver = renderVer;
  audio.loop = loop;
  audio.src = url;
  audio.currentTime = at;
  lastT = at;
  try {
    await audio.play();
    if (my === session && ver === renderVer && audio.src === url) needTap = false;
    return true;
  } catch {
    if (my === session && ver === renderVer && audio.src === url) needTap = true;
    return false;
  } finally {
    if (my === session && ver === renderVer) renderPlay();
  }
}

async function prepareCompat() {
  const my = session, ver = ++renderVer;
  try {
    const url = await renderMix(false);
    if (my !== session || ver !== renderVer || fading) { URL.revokeObjectURL(url); return; }
    const at = loopUrl ? audio.currentTime % LOOP : 0;
    if (loopUrl) URL.revokeObjectURL(loopUrl);
    if (fadeUrl) URL.revokeObjectURL(fadeUrl);
    loopUrl = url;
    fadeUrl = null;
    const ok = await playUrl(url, at, true);
    if (my !== session || ver !== renderVer || fading) { URL.revokeObjectURL(url); return; }
    if (ok && !endAt && state.timer) endAt = Date.now() + state.timer * 60_000;
    renderPlay();
    if (state.timer) {
      const f = await renderMix(true);
      if (my !== session || ver !== renderVer || fading) { URL.revokeObjectURL(f); return; }
      fadeUrl = f;
    }
  } catch (e) {
    if (my === session && ver === renderVer) fail(e);
  }
}

async function resumeTap() {
  const my = session, ver = renderVer;
  try {
    if (live) await live.ctx.resume();
    else await audio.play();
    if (my !== session || ver !== renderVer) return;
    needTap = live ? live.ctx.state !== 'running' : false;
    if (!live && loopUrl && !endAt && state.timer) endAt = Date.now() + state.timer * 60_000;
  } catch {
    if (my === session && ver === renderVer) needTap = true;
  } finally {
    if (my === session && ver === renderVer) renderPlay();
  }
}

function start() {
  const my = ++session;
  lastError = '';
  needTap = false;
  playing = true;
  fading = false;
  endAt = 0;
  if (navigator.audioSession) navigator.audioSession.type = 'playback';
  if (state.mode === 'live') {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    ctx.resume().catch(() => {});
    padBuffer().then(() => {
      if (my !== session) { ctx.close(); return; }
      const graph = build(ctx, ctx.destination, true);
      const now = ctx.currentTime;
      graph.master.gain.setValueAtTime(0, now);
      graph.master.gain.linearRampToValueAtTime(0.9, now + 3);
      endAt = state.timer ? Date.now() + state.timer * 60_000 : 0;
      if (endAt) {
        const end = now + state.timer * 60;
        graph.master.gain.setValueAtTime(0.9, end - FADE_SEC);
        graph.master.gain.linearRampToValueAtTime(0, end);
      }
      live = { ctx, graph, t0: now };
      needTap = ctx.state !== 'running';
      renderPlay();
    }).catch(e => {
      ctx.close().catch(() => {});
      if (my === session) fail(e);
    });
  } else {
    // 先在使用者點擊的當下播一段靜音，iPhone 才允許之後自動接著播
    playUrl(silentUrl, 0, true);
    prepareCompat();
  }
  if ('mediaSession' in navigator) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: '好好睡', artist: '睡前放鬆聲音' });
    navigator.mediaSession.setActionHandler('pause', stop);
    navigator.mediaSession.setActionHandler('stop', stop);
  }
  clearInterval(tickTimer);
  tickTimer = setInterval(checkTimer, 1000);
  renderPlay();
}

function stop() {
  session++;
  renderVer++;
  playing = false;
  needTap = false;
  endAt = 0;
  lastT = 0;
  clearInterval(tickTimer);
  clearTimeout(rerenderTimer);
  if (live) { live.ctx.close(); live = null; }
  audio.pause();
  audio.removeAttribute('src');
  audio.load();
  for (const u of [loopUrl, fadeUrl]) if (u) URL.revokeObjectURL(u);
  loopUrl = fadeUrl = null;
  fading = false;
  renderPlay();
}

function checkTimer() {
  const t = audio.currentTime, wrapped = t < lastT;
  lastT = t;
  if (!playing || !endAt) { renderPlay(); return; }
  const left = endAt - Date.now();
  if (left <= 0) { stop(); return; }
  if (state.mode === 'compat' && !fading && fadeUrl && wrapped && left <= 2 * LOOP * 1000) {
    fading = true;
    playUrl(fadeUrl, 0, false);
  }
  renderPlay();
}
audio.addEventListener('timeupdate', checkTimer);
audio.addEventListener('ended', () => { if (fading) stop(); });

// 設定改變時套用到正在播的聲音
let rerenderTimer = null;
function applyChange() {
  save();
  if (!playing) return;
  if (live) {
    const { ctx, graph } = live;
    for (const { id } of LAYERS) {
      const L = state.layers[id];
      graph.nodes[id].gain.setTargetAtTime(L.on ? L.vol : 0, ctx.currentTime, 0.3);
    }
    graph.nodes.toneOsc.frequency.setTargetAtTime(q(state.hz), ctx.currentTime, 0.1);
    graph.nodes.beatOsc.frequency.setTargetAtTime(200 + state.beat, ctx.currentTime, 0.1);
  } else if (state.mode === 'compat' && !fading) {
    clearTimeout(rerenderTimer);
    const my = session;
    rerenderTimer = setTimeout(() => {
      if (my !== session || fading) return;
      prepareCompat();
    }, 700);
  }
}

// ───────── 畫面 ─────────
const $ = s => document.querySelector(s);
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  for (const k of kids) e.append(k);
  return e;
}

// 出錯時直接顯示在畫面上，手機上才查得到原因
let lastError = '';
function fail(e) {
  stop();
  showError(e);
}

function showError(e) {
  lastError = (e && (e.message || e.reason?.message || e.reason)) || String(e);
  renderPlay();
}
window.addEventListener('error', showError);
window.addEventListener('unhandledrejection', showError);

function renderPlay() {
  $('#play').textContent = needTap ? '點這裡開始播放' : playing ? '停止' : '開始播放';
  $('#play').classList.toggle('playing', playing);
  let s = '';
  if (lastError) s = '出錯了：' + lastError;
  else if (needTap) s = '手機擋下了播放，請再點一下上面的按鈕';
  else if (playing) {
    if (state.mode === 'compat' ? !loopUrl : !live) s = '準備中…';
    else if (endAt) {
      const m = Math.max(0, Math.ceil((endAt - Date.now()) / 60000));
      s = `${m} 分鐘後自動關閉`;
    } else s = '整晚播放';
  }
  $('#status').textContent = s;
}

function renderPresets() {
  const box = $('#presets');
  box.replaceChildren(...PRESETS.map(p => el('button', {
    textContent: p.name,
    onclick: () => {
      for (const { id } of LAYERS) {
        const v = p.layers[id];
        state.layers[id].on = v !== undefined;
        if (v !== undefined) state.layers[id].vol = v;
      }
      if (p.hz) state.hz = p.hz;
      if (p.beat) state.beat = p.beat;
      renderLayers();
      applyChange();
      if (!playing) start();
    },
  })));
}

function choiceRow(items, current, onPick, cls = 'g3') {
  return el('div', { className: `grid ${cls}` }, ...items.map(([v, label]) => el('button', {
    textContent: label, className: v === current ? 'sel' : '', onclick: () => onPick(v),
  })));
}

function renderTimers() {
  $('#timers').replaceChildren(...choiceRow(TIMERS, state.timer, v => {
    state.timer = v;
    save();
    renderTimers();
    if (playing) { stop(); start(); }
  }).children);
}

function renderModes() {
  $('#modes').replaceChildren(...choiceRow(MODES, state.mode, v => {
    const was = playing;
    if (was) stop();
    state.mode = v;
    save();
    renderModes();
    if (was) start();
  }).children);
}

function renderLayers() {
  $('#layers').replaceChildren(...LAYERS.map(({ id, name, desc }) => {
    const L = state.layers[id];
    const tog = el('button', { className: 'tog' + (L.on ? ' sel' : ''), textContent: L.on ? '開' : '關' });
    tog.onclick = () => { L.on = !L.on; renderLayers(); applyChange(); };
    const range = el('input', { type: 'range', min: 0, max: 1, step: 0.01, value: L.vol });
    range.oninput = () => { L.vol = +range.value; if (!L.on) { L.on = true; renderLayers(); } applyChange(); };
    const box = el('div', { className: 'layer' + (L.on ? '' : ' off') },
      el('div', { className: 'top' }, el('div', { className: 'name', textContent: name }), tog),
      el('div', { className: 'desc', textContent: desc }), range);
    if (id === 'tone') {
      const custom = el('input', { type: 'number', min: 20, max: 2000, step: 1, value: state.hz, placeholder: '自訂赫茲' });
      custom.onchange = () => {
        const v = Math.min(2000, Math.max(20, +custom.value || 432));
        state.hz = v; renderLayers(); applyChange();
      };
      box.append(el('div', { className: 'extra' },
        choiceRow(HZ_CHOICES.map(h => [h, h + ' Hz']), state.hz, v => { state.hz = v; renderLayers(); applyChange(); }, 'g2'),
        el('div', { style: 'margin-top:8px' }, custom)));
    }
    if (id === 'binaural') {
      box.append(el('div', { className: 'extra' },
        choiceRow(BEATS, state.beat, v => { state.beat = v; renderLayers(); applyChange(); })));
    }
    return box;
  }));
}

// 呼吸引導光球：跟海浪同步
function animate() {
  let t = null;
  if (playing && state.layers.waves.on) {
    if (live) t = live.ctx.currentTime - live.t0;
    else if (loopUrl && !audio.paused) t = audio.currentTime;
  }
  const orb = $('#orb'), txt = $('#breathText');
  if (t === null) {
    orb.style.transform = 'scale(.6)'; orb.style.opacity = '.35'; txt.textContent = '';
  } else {
    const v = breathAt(t);
    orb.style.transform = `scale(${0.55 + 0.75 * v})`;
    orb.style.opacity = String(0.35 + 0.45 * v);
    txt.textContent = (t % BREATH) < INHALE ? '吸氣' : '吐氣';
  }
  requestAnimationFrame(animate);
}

$('#play').onclick = () => (needTap ? resumeTap() : playing ? stop() : start());
renderPresets();
renderTimers();
renderModes();
renderLayers();
renderPlay();
requestAnimationFrame(animate);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
