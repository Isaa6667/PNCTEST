(() => {
'use strict';

/* ------------------------------------------------------------------ helpers */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rad = d => d * Math.PI / 180;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
};

/* ----------------------------------------------------------------- settings */
const DEFAULTS = {
  units: 'mph',
  fov: 65,            // horizontal field of view of the camera, degrees
  cooldown: 45,       // seconds a plate must be unseen before it is logged again
  confirmReads: 2,    // reads needed before a plate is accepted
  minConf: 55,        // minimum OCR confidence
  centreOnly: true,   // scan only the middle of the frame (faster, fewer false reads)
  scanWidth: 1280,
  speedLimit: 30,     // limit used for the "estimated speeding" alert (0 = off)
  sound: true,
  vibrate: true,
  thumbs: true,
  retain: 800,
  facing: 'environment'
};
const settings = Object.assign({}, DEFAULTS, store.get('pw.settings', {}));
const saveSettings = () => store.set('pw.settings', settings);

let LOG = store.get('pw.log', []);
let HOT = store.get('pw.hotlist', []);
let saveTimer = null;
function saveLog() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveLogNow, 1200);
}
function saveLogNow() {
  if (LOG.length > settings.retain) LOG.splice(0, LOG.length - settings.retain);
  let tries = 0;
  while (!store.set('pw.log', LOG) && tries++ < 6) LOG.splice(0, Math.ceil(LOG.length * 0.2));
}
window.addEventListener('pagehide', saveLogNow);
const saveHot = () => store.set('pw.hotlist', HOT);

/* ------------------------------------------------------------- UK plate logic */
const CURRENT = /^[A-HJ-PR-WY][A-Z]\d{2}[A-HJ-PR-Z]{3}$/;
const PREFIX = /^[A-HJ-NPR-TV-Y]\d{1,3}[A-HJ-PR-Z]{3}$/;
const SUFFIX = /^[A-HJ-PR-Z]{3}\d{1,3}[A-HJ-NPR-TV-Y]$/;
const TO_L = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G' };
const TO_D = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
const REGION = {
  A: 'Anglia', B: 'Birmingham', C: 'Cymru (Wales)', D: 'Deeside to Shrewsbury', E: 'Essex', F: 'Forest and Fens',
  G: 'Garden of England (Kent)', H: 'Hampshire and Dorset', K: 'Milton Keynes', L: 'London', M: 'Manchester and Merseyside',
  N: 'North', O: 'Oxford', P: 'Preston', R: 'Reading', S: 'Scotland', V: 'Severn Valley', W: 'West of England', Y: 'Yorkshire'
};
const OLD_LETTERS = 'ABCDEFGHJKLMNPRSTVWXY';

function plateFormat(p) {
  if (CURRENT.test(p)) return 'current';
  if (PREFIX.test(p)) return 'prefix';
  if (SUFFIX.test(p)) return 'suffix';
  return null;
}
function fmtPlate(p) {
  const f = plateFormat(p);
  if (f === 'current') return p.slice(0, 4) + ' ' + p.slice(4);
  if (f === 'prefix') return p.slice(0, -3) + ' ' + p.slice(-3);
  if (f === 'suffix') return p.slice(0, 3) + ' ' + p.slice(3);
  return p;
}
function plateInfo(p) {
  const f = plateFormat(p);
  if (f === 'current') {
    const n = parseInt(p.slice(2, 4), 10);
    const sep = n >= 51;
    const year = sep ? 2000 + n - 50 : 2000 + n;
    const start = sep ? new Date(year, 8, 1) : new Date(year, 2, 1);
    return {
      format: 'Current (2001 onwards)', year, start, window: sep ? `September ${year} to February ${year + 1}` : `March to August ${year}`,
      region: REGION[p[0]] || 'Unknown DVLA office', memory: p.slice(0, 2)
    };
  }
  if (f === 'prefix') {
    const i = OLD_LETTERS.indexOf(p[0]);
    const year = i <= 16 ? 1983 + i : [1999, 2000, 2000, 2001][i - 17];
    return { format: 'Prefix (1983 to 2001)', year, start: new Date(year, 7, 1), window: `about ${year}`, region: 'Not decoded for older formats', memory: null };
  }
  if (f === 'suffix') {
    const i = OLD_LETTERS.indexOf(p[p.length - 1]);
    const year = 1963 + i;
    return { format: 'Suffix (1963 to 1983)', year, start: new Date(year, 7, 1), window: `about ${year}`, region: 'Not decoded for older formats', memory: null };
  }
  return { format: 'Unrecognised', year: null, start: null, window: '', region: '', memory: null };
}
function validPlate(p) {
  const f = plateFormat(p);
  if (!f) return false;
  if (f === 'current') {
    const n = parseInt(p.slice(2, 4), 10);
    if (n < 2) return false;
    if (plateInfo(p).start > new Date()) return false; // plate cannot be issued in the future
  }
  return true;
}
function fixCurrent(w) {
  let out = '', corr = 0;
  for (let i = 0; i < 7; i++) {
    const c = w[i], wantDigit = i === 2 || i === 3;
    if (wantDigit) {
      if (/\d/.test(c)) out += c; else if (TO_D[c]) { out += TO_D[c]; corr++; } else out += '?';
    } else {
      if (/[A-Z]/.test(c)) out += c; else if (TO_L[c]) { out += TO_L[c]; corr++; } else out += '?';
    }
  }
  return { text: out, corr };
}
function extractPlates(s) {
  const out = [];
  for (let i = 0; i + 7 <= s.length; i++) {
    const { text, corr } = fixCurrent(s.slice(i, i + 7));
    if (corr <= 1 && validPlate(text)) out.push({ plate: text, corr });
  }
  if (!out.length && s.length >= 5 && s.length <= 7 && validPlate(s)) out.push({ plate: s, corr: 0 });
  return out;
}
function plateHTML(p, size = 'sm') {
  return `<span class="plate ${size}"><span class="gb">GB</span><span class="reg">${esc(fmtPlate(p))}</span></span>`;
}

/* -------------------------------------------- fictional vehicle record engine */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
  h = Math.imul(h ^ h >>> 16, 2246822507); h = Math.imul(h ^ h >>> 13, 3266489909);
  return (h ^= h >>> 16) >>> 0;
}
function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const addMonths = (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };
const fmtDate = d => d ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '–';
const fmtMonth = d => d ? d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : '–';

const MAKES = {
  Ford: ['Fiesta', 'Focus', 'Transit', 'Puma', 'Kuga'], Vauxhall: ['Corsa', 'Astra', 'Mokka', 'Vivaro'],
  Volkswagen: ['Golf', 'Polo', 'Passat', 'Transporter', 'Tiguan'], BMW: ['1 Series', '3 Series', '5 Series', 'X1'],
  Audi: ['A3', 'A4', 'Q3'], Toyota: ['Yaris', 'Corolla', 'Aygo', 'RAV4'], Nissan: ['Qashqai', 'Juke', 'Micra', 'Leaf'],
  Honda: ['Civic', 'Jazz', 'CR-V'], 'Mercedes-Benz': ['A-Class', 'C-Class', 'Sprinter'], Kia: ['Sportage', 'Ceed', 'Picanto'],
  Hyundai: ['i10', 'i20', 'Tucson'], Peugeot: ['208', '2008', 'Partner'], Renault: ['Clio', 'Captur', 'Megane'],
  Skoda: ['Octavia', 'Fabia', 'Kodiaq'], MINI: ['Cooper', 'Countryman'], 'Land Rover': ['Defender', 'Discovery Sport'],
  Tesla: ['Model 3', 'Model Y']
};
const VANS = new Set(['Transit', 'Vivaro', 'Transporter', 'Sprinter', 'Partner']);
const EVS = new Set(['Leaf', 'Model 3', 'Model Y']);
const COLOURS = ['Black', 'White', 'Silver', 'Grey', 'Blue', 'Red', 'Green', 'Orange', 'Brown', 'Yellow'];
const recCache = new Map();

function getRecord(plate) {
  if (recCache.has(plate)) return recCache.get(plate);
  const rng = mulberry32(xmur3(plate));
  const info = plateInfo(plate);
  const now = new Date();
  const make = pick(rng, Object.keys(MAKES));
  const model = pick(rng, MAKES[make]);
  const year = info.year ?? 2004 + Math.floor(rng() * 12);
  const age = now.getFullYear() - year;
  const ev = EVS.has(model);
  const fuel = ev ? 'Electric' : (age < 10 ? pick(rng, ['Petrol', 'Petrol', 'Diesel', 'Hybrid electric']) : pick(rng, ['Petrol', 'Petrol', 'Diesel']));
  let regDate = null;
  if (plateFormat(plate) === 'current') {
    const sep = parseInt(plate.slice(2, 4), 10) >= 51;
    regDate = new Date(info.year, (sep ? 8 : 2) + Math.floor(rng() * 6), 1 + Math.floor(rng() * 27));
  }

  const rec = {
    plate, make, model, colour: pick(rng, COLOURS), year, regDate,
    type: VANS.has(model) ? 'Light goods vehicle' : 'Car',
    fuel, cc: ev ? null : 900 + Math.floor(rng() * 21) * 100,
    keepers: 1 + Math.floor(rng() * 5), info
  };

  const rt = rng();
  rec.tax = rt < 0.91 ? 'Taxed' : rt < 0.96 ? 'Untaxed' : 'SORN';
  rec.taxExp = rec.tax === 'Taxed' ? addMonths(now, 1 + Math.floor(rng() * 11)) : addMonths(now, -(1 + Math.floor(rng() * 8)));

  if (age < 3) { rec.mot = 'Not yet due'; rec.motExp = null; rng(); rng(); }
  else {
    const rm = rng();
    if (rm < 0.88) { rec.mot = 'Valid'; rec.motExp = addMonths(now, 1 + Math.floor(rng() * 11)); }
    else if (rm < 0.97) { rec.mot = 'Expired'; rec.motExp = addMonths(now, -(1 + Math.floor(rng() * 6))); }
    else { rec.mot = 'No MOT record'; rec.motExp = null; }
  }
  rec.insurance = rng() < 0.93 ? 'Insured' : 'No insurance on MID';

  const rk = rng();
  rec.marker = rk < 0.006 ? 'Reported stolen'
    : rk < 0.014 ? 'Vehicle of interest (intelligence marker)'
    : rk < 0.02 ? 'Suspected cloned plate'
    : rk < 0.026 ? 'Recorded as scrapped, plate still in use' : null;

  recCache.set(plate, rec);
  return rec;
}

function evaluate(plate) {
  const rec = getRecord(plate);
  const flags = [];
  if (rec.marker) flags.push({ t: rec.marker, sev: 'alert' });
  if (rec.insurance !== 'Insured') flags.push({ t: 'No insurance', sev: 'alert' });
  const hl = HOT.find(h => h.plate === plate);
  if (hl) flags.push({ t: 'Hotlist: ' + (hl.note || 'no note'), sev: 'alert' });
  if (rec.tax === 'Untaxed') flags.push({ t: 'Untaxed', sev: 'warn' });
  if (rec.tax === 'SORN') flags.push({ t: 'SORN but on road', sev: 'warn' });
  if (rec.mot === 'Expired') flags.push({ t: 'MOT expired', sev: 'warn' });
  if (rec.mot === 'No MOT record') flags.push({ t: 'No MOT record', sev: 'warn' });
  const sev = flags.some(f => f.sev === 'alert') ? 'alert' : flags.length ? 'warn' : 'ok';
  if (!flags.length) flags.push({ t: 'No markers', sev: 'ok' });
  return { rec, flags, sev };
}
const flagsHTML = flags => `<div class="flags">${flags.map(f => `<span class="flag ${f.sev}">${esc(f.t)}</span>`).join('')}</div>`;

/* -------------------------------------------------------------------- state */
const S = {
  running: false, demo: false, stream: null, worker: null, geoId: null,
  pos: null, ownSpeed: null, speedAt: 0,
  tracks: new Map(), pending: new Map(), lastEntry: new Map(),
  boxes: [], frameW: 1280, frameH: 720, scanMs: 0, scans: 0,
  wake: null, ac: null, demoScene: [], dirty: true, toastCount: 0
};
const video = $('#video'), overlay = $('#overlay'), octx = overlay.getContext('2d');
const cvFull = document.createElement('canvas'), cvScan = document.createElement('canvas');
const xFull = cvFull.getContext('2d', { willReadFrequently: true });
const xScan = cvScan.getContext('2d', { willReadFrequently: true });

const MPS = { mph: 2.23694, kph: 3.6 };
const toUnit = mps => mps * MPS[settings.units];
const fmtSpeed = mps => (mps == null || isNaN(mps)) ? '--' : Math.round(toUnit(mps));
const speedText = mps => mps == null ? '–' : `${fmtSpeed(mps)} ${settings.units}`;

/* -------------------------------------------------------------------- audio */
function initAudio() {
  try { S.ac = S.ac || new (window.AudioContext || window.webkitAudioContext)(); S.ac.resume(); } catch { /* ignore */ }
}
function beep(freq, dur, delay = 0) {
  if (!settings.sound || !S.ac) return;
  const t = S.ac.currentTime + delay, o = S.ac.createOscillator(), g = S.ac.createGain();
  o.type = 'square'; o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(S.ac.destination); o.start(t); o.stop(t + dur + 0.02);
}
function notifySound(sev) {
  if (sev === 'alert') { beep(880, 0.14); beep(1175, 0.14, 0.18); beep(880, 0.14, 0.36); if (settings.vibrate && navigator.vibrate) navigator.vibrate([200, 100, 200]); }
  else if (sev === 'warn') beep(660, 0.14);
  else beep(1400, 0.04);
}

/* ---------------------------------------------------------------------- GPS */
function haversine(a, b) {
  const R = 6371000, dLat = rad(b.latitude - a.lat), dLon = rad(b.longitude - a.lon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
function startGPS() {
  if (!navigator.geolocation || S.geoId != null) return;
  S.geoId = navigator.geolocation.watchPosition(p => {
    const c = p.coords;
    let sp = c.speed;
    if ((sp == null || isNaN(sp)) && S.pos) {
      const dt = (p.timestamp - S.pos.t) / 1000;
      if (dt > 0.5 && c.accuracy < 30) sp = haversine(S.pos, c) / dt;
    }
    S.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: p.timestamp };
    if (sp != null && !isNaN(sp)) { S.ownSpeed = sp; S.speedAt = Date.now(); }
  }, err => { S.gpsErr = err.code === 1 ? 'denied' : 'error'; }, { enableHighAccuracy: true, maximumAge: 500, timeout: 15000 });
}
function stopGPS() { if (S.geoId != null) navigator.geolocation.clearWatch(S.geoId); S.geoId = null; S.pos = null; S.ownSpeed = null; }
const ownSpeedNow = () => (S.demo || Date.now() - S.speedAt < 6000) ? S.ownSpeed : null;

/* --------------------------------------------------------- camera / OCR loop */
async function startCamera() {
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: settings.facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }
  });
  S.stream.getVideoTracks().forEach(t => t.addEventListener('ended', () => { if (S.running && !S.demo) setStatus('Camera stopped. Tap Stop, then Start live scanning again.'); }));
  video.srcObject = S.stream;
  await video.play();
}
function stopCamera() {
  if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  S.stream = null; video.srcObject = null;
}
async function ensureWorker() {
  if (S.worker) return;
  if (!window.Tesseract) throw new Error('The OCR engine could not load. Check your connection and reload.');
  setStatus('Loading OCR engine (first time only)…');
  S.worker = await Tesseract.createWorker('eng', 1, {});
  await S.worker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    tessedit_pageseg_mode: '11',
    user_defined_dpi: '150'
  });
}
function preprocess(ctx, w, h) {
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) { const g = d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11; d[i] = g; sum += g; }
  const mean = sum / (d.length / 4);
  for (let i = 0; i < d.length; i += 4) {
    const g = clamp((d[i] - mean) * 1.6 + mean, 0, 255);
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
}
function groupWords(words) {
  const ws = words.map(w => ({
    t: (w.text || '').toUpperCase().replace(/[^A-Z0-9]/g, ''), c: w.confidence,
    x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1
  })).filter(w => w.t.length && w.c >= 30).sort((a, b) => a.x0 - b.x0);
  const groups = [];
  for (const w of ws) {
    const h = w.y1 - w.y0;
    const g = groups.find(g => {
      const gh = g.y1 - g.y0, dy = Math.abs((g.y0 + g.y1) / 2 - (w.y0 + w.y1) / 2), gap = w.x0 - g.x1;
      return dy < 0.5 * Math.max(gh, h) && gap > -0.5 * h && gap < 2.5 * h;
    });
    if (g) { g.t += w.t; g.x1 = Math.max(g.x1, w.x1); g.y0 = Math.min(g.y0, w.y0); g.y1 = Math.max(g.y1, w.y1); g.cs.push(w.c); }
    else groups.push({ t: w.t, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1, cs: [w.c] });
  }
  return groups;
}
async function scanOnce() {
  if (!video.videoWidth || video.readyState < 2) return;
  const W = Math.min(settings.scanWidth, video.videoWidth), k = W / video.videoWidth, H = Math.round(video.videoHeight * k);
  if (cvFull.width !== W || cvFull.height !== H) { cvFull.width = W; cvFull.height = H; }
  S.frameW = W; S.frameH = H;
  xFull.drawImage(video, 0, 0, W, H);
  const roi = settings.centreOnly
    ? { x: Math.round(W * 0.08), y: Math.round(H * 0.18), w: Math.round(W * 0.84), h: Math.round(H * 0.64) }
    : { x: 0, y: 0, w: W, h: H };
  S.roi = roi;
  cvScan.width = roi.w; cvScan.height = roi.h;
  xScan.drawImage(cvFull, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
  preprocess(xScan, roi.w, roi.h);
  const { data } = await S.worker.recognize(cvScan);
  const words = data.words || (data.lines || []).flatMap(l => l.words || []);
  const found = new Map();
  for (const g of groupWords(words)) {
    const conf = g.cs.reduce((a, b) => a + b, 0) / g.cs.length;
    for (const m of extractPlates(g.t)) {
      const c = conf - m.corr * 8;
      if (c < settings.minConf) continue;
      const bbox = { x0: g.x0 + roi.x, y0: g.y0 + roi.y, x1: g.x1 + roi.x, y1: g.y1 + roi.y };
      if (!found.has(m.plate) || found.get(m.plate).conf < c) found.set(m.plate, { plate: m.plate, conf: c, bbox, frameW: W, frameH: H });
    }
  }
  for (const c of found.values()) onDetect(c);
}
async function scanLoop() {
  while (S.running && !S.demo) {
    const t0 = performance.now();
    try { await scanOnce(); S.scans++; } catch (e) { console.error(e); setStatus('Scan error: ' + e.message); await sleep(500); }
    S.scanMs = S.scanMs ? S.scanMs * 0.7 + (performance.now() - t0) * 0.3 : performance.now() - t0;
    await sleep(20);
  }
}

/* -------------------------------------------------------------- demo engine */
function randomPlate() {
  const A = 'ABCDEFGHKLMNOPRSVWY', B = 'ABCDEFGHJKLMNOPRSTUVWXY', L = 'ABCDEFGHJKLMNOPRSTUVWXYZ';
  const r = s => s[Math.floor(Math.random() * s.length)];
  const age = Math.random() < 0.5 ? 10 + Math.floor(Math.random() * 16) : 60 + Math.floor(Math.random() * 17);
  return r(A) + r(B) + String(age).padStart(2, '0') + r(L) + r(L) + r(L);
}
const focalPx = (w) => (w / 2) / Math.tan(rad(settings.fov) / 2);
async function demoLoop() {
  let lead = null, extras = [], tick = 0;
  while (S.running && S.demo) {
    const now = Date.now();
    S.ownSpeed = 13.4 + 2.2 * Math.sin(now / 6000);
    S.speedAt = now;
    if (!lead || now > lead.end) {
      lead = { plate: randomPlate(), dist: 22 + Math.random() * 25, rel: (Math.random() - 0.5) * 6, end: now + 14000 + Math.random() * 12000, sway: Math.random() * 6 };
    }
    lead.dist = clamp(lead.dist + lead.rel * 0.8, 7, 75);
    if (Math.random() < 0.22 && extras.length < 2) extras.push({ plate: randomPlate(), dist: 10 + Math.random() * 40, rel: (Math.random() - 0.5) * 10, left: 2 + Math.floor(Math.random() * 3), x: Math.random() < 0.5 ? 0.25 : 0.75 });
    const W = 1280, H = 720, f = focalPx(W);
    S.frameW = W; S.frameH = H; S.roi = null;
    const scene = [];
    const emit = (v, cx) => {
      const hpx = f * 0.079 / v.dist, w = hpx * 5.3, h = hpx;
      const bbox = { x0: cx - w / 2, x1: cx + w / 2, y0: H * 0.56 - h / 2, y1: H * 0.56 + h / 2 };
      scene.push({ plate: v.plate, bbox, hpx });
      onDetect({ plate: v.plate, conf: 82 + Math.random() * 14, bbox, frameW: W, frameH: H });
    };
    emit(lead, W / 2 + Math.sin(now / 2500 + lead.sway) * 18);
    extras = extras.filter(e => e.left-- > 0);
    extras.forEach(e => { e.dist = clamp(e.dist + e.rel * 0.8, 6, 80); emit(e, W * e.x); });
    S.demoScene = scene;
    tick++;
    S.scans++; S.scanMs = 800;
    await sleep(800);
  }
}
function drawDemoScene(ctx, W, H) {
  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.45);
  sky.addColorStop(0, '#294a78'); sky.addColorStop(1, '#a9c1d9');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H * 0.45);
  ctx.fillStyle = '#3a3f47'; ctx.fillRect(0, H * 0.45, W, H * 0.55);
  ctx.fillStyle = '#4a515c';
  ctx.beginPath(); ctx.moveTo(W * 0.46, H * 0.45); ctx.lineTo(W * 0.54, H * 0.45); ctx.lineTo(W * 0.95, H); ctx.lineTo(W * 0.05, H); ctx.fill();
  ctx.strokeStyle = '#e8e8e8'; ctx.lineWidth = 6; ctx.setLineDash([40, 40]); ctx.lineDashOffset = -(Date.now() / 12) % 80;
  ctx.beginPath(); ctx.moveTo(W * 0.5, H * 0.45); ctx.lineTo(W * 0.5, H); ctx.stroke(); ctx.setLineDash([]);
  for (const v of S.demoScene) {
    const b = v.bbox, pw = v.hpx * 6.6, ph = v.hpx * 1.45, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    ctx.fillStyle = '#20252d'; ctx.fillRect(cx - pw * 1.7, cy - ph * 3.2, pw * 3.4, ph * 5);
    ctx.fillStyle = '#12161b'; ctx.fillRect(cx - pw * 1.4, cy - ph * 2.6, pw * 2.8, ph * 1.6);
    ctx.fillStyle = '#c4202c'; ctx.fillRect(cx - pw * 1.6, cy - ph * 0.9, pw * 0.35, ph * 0.5); ctx.fillRect(cx + pw * 1.25, cy - ph * 0.9, pw * 0.35, ph * 0.5);
    ctx.fillStyle = '#f6c915'; ctx.fillRect(cx - pw / 2, cy - ph / 2, pw, ph);
    ctx.fillStyle = '#0b3a9a'; ctx.fillRect(cx - pw / 2, cy - ph / 2, pw * 0.07, ph);
    ctx.fillStyle = '#111'; ctx.font = `800 ${v.hpx * 1.38}px Arial Narrow, Arial, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(fmtPlate(v.plate), cx + pw * 0.03, cy + ph * 0.04);
  }
}

/* ------------------------------------------------------ tracking and logging */
function onDetect(c) {
  const now = Date.now(), plate = c.plate;
  let tr = S.tracks.get(plate);
  if (!tr) {
    let p = S.pending.get(plate);
    if (!p || now - p.first > 8000) p = { n: 0, first: now };
    p.n++; S.pending.set(plate, p);
    S.boxes.push({ plate, bbox: c.bbox, t: now, sev: 'pending', conf: c.conf });
    if (p.n < settings.confirmReads) return;
    S.pending.delete(plate);
    tr = { plate, first: now, samples: [], est: null };
    S.tracks.set(plate, tr);
  }
  tr.last = now;
  const hpx = Math.max(2, c.bbox.y1 - c.bbox.y0);
  tr.dist = focalPx(c.frameW) * 0.079 / hpx;   // UK plate characters are 79 mm tall
  tr.samples.push({ t: now, dist: tr.dist });
  tr.samples = tr.samples.filter(s => now - s.t < 10000);
  tr.est = estimateSpeed(tr);

  const ev = evaluate(plate);
  S.boxes.push({ plate, bbox: c.bbox, t: now, sev: ev.sev, conf: c.conf });

  const le = S.lastEntry.get(plate);
  let entry = le && LOG.find(e => e.id === le.id);
  const fresh = !entry || now - le.t > settings.cooldown * 1000;
  if (fresh) {
    entry = {
      id: uid(), ts: now, last: now, plate, conf: Math.round(c.conf),
      lat: S.pos?.lat ?? null, lon: S.pos?.lon ?? null, acc: S.pos?.acc ?? null,
      own: ownSpeedNow(), front: null, rel: null, dist: tr.dist, maxFront: null, seen: 1, speeding: false,
      thumb: settings.thumbs ? takeThumb(c) : null, demo: S.demo
    };
    LOG.push(entry);
    saveLog();
    showToast(entry, ev);
    notifySound(ev.sev);
  } else {
    entry.last = now; entry.seen++;
    entry.conf = Math.max(entry.conf, Math.round(c.conf));
  }
  S.lastEntry.set(plate, { id: entry.id, t: now });
  entry.dist = tr.dist;
  if (tr.est) {
    entry.rel = tr.est.rel; entry.front = tr.est.front;
    if (tr.est.front != null) entry.maxFront = Math.max(entry.maxFront ?? 0, tr.est.front);
    checkSpeeding(entry, tr);
  }
  S.dirty = true;
  schedulePageRefresh(plate);
}
function estimateSpeed(tr) {
  const now = Date.now(), s = tr.samples.filter(x => now - x.t < 8000);
  if (s.length < 4) return null;
  const t0 = s[0].t, span = (s[s.length - 1].t - t0) / 1000;
  if (span < 2) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of s) { const x = (p.t - t0) / 1000; sx += x; sy += p.dist; sxx += x * x; sxy += x * p.dist; }
  const n = s.length, den = n * sxx - sx * sx;
  if (!den) return null;
  const rel = (n * sxy - sx * sy) / den;           // metres per second, positive means pulling away
  const own = ownSpeedNow();
  return { rel, front: own == null ? null : Math.max(0, own + rel), n };
}
function checkSpeeding(entry, tr) {
  if (!settings.speedLimit || entry.speeding || entry.front == null || tr.est.n < 5) return;
  if (toUnit(entry.front) > settings.speedLimit * 1.1) {
    entry.speeding = true;
    showToast(entry, { rec: getRecord(entry.plate), flags: [{ t: `Estimated ${speedText(entry.front)} in a ${settings.speedLimit} ${settings.units} limit`, sev: 'alert' }], sev: 'alert' }, 'Speed alert');
    notifySound('alert');
  }
}
function takeThumb(c) {
  try {
    if (S.demo) return null;
    const b = c.bbox, w = b.x1 - b.x0, h = b.y1 - b.y0, px = w * 0.5, py = h * 1.6;
    const sx = clamp(b.x0 - px, 0, cvFull.width), sy = clamp(b.y0 - py, 0, cvFull.height);
    const sw = Math.min(cvFull.width - sx, w + px * 2), sh = Math.min(cvFull.height - sy, h + py * 2);
    const t = document.createElement('canvas'); t.width = 200; t.height = Math.max(20, Math.round(200 * sh / sw));
    t.getContext('2d').drawImage(cvFull, sx, sy, sw, sh, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.55);
  } catch { return null; }
}
setInterval(() => {            // forget vehicles that have left the picture
  const now = Date.now();
  for (const [k, t] of S.tracks) if (now - t.last > 10000) S.tracks.delete(k);
}, 2000);

/* -------------------------------------------------------------------- toasts */
function showToast(entry, ev, title) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${ev.sev}`;
  el.setAttribute('role', 'button'); el.tabIndex = 0;
  el.dataset.plate = entry.plate;
  const rec = ev.rec;
  el.innerHTML = `
    <div>${entry.thumb ? `<img src="${entry.thumb}" alt="">` : ''}${plateHTML(entry.plate, 'sm')}</div>
    <div>
      <div class="t-title">${esc(title || (ev.sev === 'alert' ? 'Alert' : ev.sev === 'warn' ? 'Check this vehicle' : 'Vehicle logged'))}: ${esc(rec.colour)} ${esc(rec.make)} ${esc(rec.model)}</div>
      ${flagsHTML(ev.flags.slice(0, 3))}
      <div class="t-open">Tap for full record</div>
    </div>
    <button class="t-x" aria-label="Dismiss">×</button>`;
  const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 260); };
  el.addEventListener('click', e => { if (e.target.closest('.t-x')) { e.stopPropagation(); close(); return; } location.hash = '#/v/' + entry.plate; close(); });
  el.addEventListener('keydown', e => { if (e.key === 'Enter') el.click(); });
  box.prepend(el);
  while (box.children.length > 4) box.lastChild.remove();
  setTimeout(close, ev.sev === 'alert' ? 25000 : ev.sev === 'warn' ? 12000 : 7000);
}

/* ------------------------------------------------------------- overlay / HUD */
function drawOverlay() {
  const W = S.frameW, H = S.frameH;
  if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
  octx.clearRect(0, 0, W, H);
  if (S.running && S.demo) drawDemoScene(octx, W, H);
  if (S.running && !S.demo && S.roi && settings.centreOnly) {
    octx.strokeStyle = 'rgba(246,201,21,.55)'; octx.lineWidth = 2; octx.setLineDash([12, 10]);
    octx.strokeRect(S.roi.x, S.roi.y, S.roi.w, S.roi.h); octx.setLineDash([]);
  }
  const now = Date.now();
  S.boxes = S.boxes.filter(b => now - b.t < 1800);
  for (const b of S.boxes) {
    const a = 1 - (now - b.t) / 1800;
    const col = b.sev === 'alert' ? '255,80,87' : b.sev === 'warn' ? '255,176,32' : b.sev === 'pending' ? '147,166,196' : '62,207,142';
    const x = b.bbox.x0, y = b.bbox.y0, w = b.bbox.x1 - x, h = b.bbox.y1 - y, pad = h * 0.4;
    octx.strokeStyle = `rgba(${col},${a})`; octx.lineWidth = 4;
    octx.strokeRect(x - pad, y - pad, w + pad * 2, h + pad * 2);
    octx.font = '600 22px system-ui, sans-serif';
    const label = fmtPlate(b.plate) + (b.sev === 'pending' ? ' …' : '');
    const tw = octx.measureText(label).width + 14;
    octx.fillStyle = `rgba(${col},${a})`; octx.fillRect(x - pad, y - pad - 30, tw, 28);
    octx.fillStyle = `rgba(10,22,38,${a})`; octx.textBaseline = 'middle'; octx.textAlign = 'left'; octx.fillText(label, x - pad + 7, y - pad - 15);
  }
  requestAnimationFrame(drawOverlay);
}

function setStatus(t) { $('#statusLine').textContent = t; }
function updateUI() {
  const now = Date.now();
  // chips
  const cam = $('#chipCam'), gps = $('#chipGps'), sc = $('#chipScan');
  cam.className = 'chip' + (S.running ? ' on' : '');
  cam.lastChild.textContent = S.running ? (S.demo ? 'Demo feed' : 'Camera live') : 'Camera off';
  const own = ownSpeedNow();
  if (S.geoId != null) {
    const ok = S.pos && now - S.speedAt < 6000;
    gps.className = 'chip ' + (ok ? 'on' : S.gpsErr === 'denied' ? 'bad' : 'warn');
    gps.lastChild.textContent = ok ? `GPS ±${Math.round(S.pos.acc)} m` : S.gpsErr === 'denied' ? 'GPS blocked' : 'Finding GPS…';
  } else {
    gps.className = 'chip' + (S.demo && S.running ? ' on' : ''); gps.lastChild.textContent = S.demo && S.running ? 'GPS simulated' : 'GPS off';
  }
  sc.className = 'chip' + (S.running ? ' on' : '');
  sc.lastChild.textContent = S.running ? `Scanning · ${S.scanMs ? (S.scanMs / 1000).toFixed(1) + ' s/frame' : 'starting'}` : 'Idle';
  $('#chipLog').lastChild.textContent = `${LOG.length} logged`;
  $('#viewer').classList.toggle('live', S.running);

  // HUD
  $('#ownSpeed').textContent = fmtSpeed(own); $('#ownUnit').textContent = settings.units;
  let lead = null;
  for (const t of S.tracks.values()) if (now - t.last < 2500 && (!lead || t.dist < lead.dist)) lead = t;
  const lb = $('#leadBox'), lp = $('#leadPlate');
  if (lead) {
    lp.textContent = fmtPlate(lead.plate); lp.classList.remove('none');
    $('#leadDist').textContent = `${lead.dist.toFixed(0)} m ahead`;
    const e = lead.est;
    if (e && e.front != null) { $('#leadSpeed').textContent = fmtSpeed(e.front); $('#leadNote').textContent = `Estimated from plate size and your GPS speed. Closing at ${fmtSpeed(Math.abs(e.rel))} ${settings.units}${e.rel < 0 ? ' (gaining)' : ' (pulling away)'}`; }
    else if (e) { $('#leadSpeed').textContent = '--'; $('#leadNote').textContent = `No GPS speed. Relative speed ${e.rel >= 0 ? '+' : '-'}${fmtSpeed(Math.abs(e.rel))} ${settings.units}`; }
    else { $('#leadSpeed').textContent = '--'; $('#leadNote').textContent = 'Measuring… keep the plate in view for a few seconds'; }
    lb.classList.toggle('speeding', !!(e && e.front != null && settings.speedLimit && toUnit(e.front) > settings.speedLimit * 1.1));
  } else {
    lp.textContent = 'No vehicle'; lp.classList.add('none'); $('#leadSpeed').textContent = '--'; $('#leadDist').textContent = '-- m';
    $('#leadNote').textContent = 'Estimated from plate size and your GPS speed'; lb.classList.remove('speeding');
  }
  $('#leadUnit').textContent = settings.units;

  // stats + feed
  if (S.dirty) {
    S.dirty = false;
    $('#stTotal').textContent = LOG.length;
    $('#stUnique').textContent = new Set(LOG.map(e => e.plate)).size;
    $('#stAlerts').textContent = LOG.filter(e => evaluate(e.plate).sev === 'alert').length;
    const feed = $('#feed'), rows = LOG.slice(-14).reverse();
    feed.innerHTML = rows.length ? rows.map(rowHTML).join('') : '<p class="empty">Plates appear here as soon as they are read. Tap one for the full record.</p>';
  }
  $('#stRate').textContent = S.scanMs ? (S.scanMs / 1000).toFixed(1) + ' s' : '--';
}
setInterval(updateUI, 400);

function rowHTML(e) {
  const ev = evaluate(e.plate), r = ev.rec;
  const top = ev.flags[0];
  return `<button class="row ${ev.sev}" data-plate="${e.plate}">
    ${plateHTML(e.plate, 'sm')}
    <div class="meta"><b>${esc(r.colour)} ${esc(r.make)} ${esc(r.model)}</b><span>${ev.sev === 'ok' ? 'No markers' : esc(top.t)}${ev.flags.length > 1 && ev.sev !== 'ok' ? ` +${ev.flags.length - 1}` : ''}</span></div>
    <div class="right"><b>${e.front != null ? speedText(e.front) : '–'}</b>${new Date(e.ts).toLocaleTimeString('en-GB')}</div>
  </button>`;
}

/* ------------------------------------------------------------ start and stop */
async function start(demo) {
  if (S.running) await stop();
  S.demo = demo; S.running = true; S.gpsErr = null;
  initAudio();
  $('#viewer').classList.add('live');
  S.tracks.clear(); S.pending.clear(); S.boxes = [];
  if (demo) {
    setStatus('Demo mode: simulated vehicles and speed.');
    demoLoop();
  } else {
    try {
      setStatus('Starting camera…');
      await startCamera();
      startGPS();
      await ensureWorker();
      setStatus('Scanning continuously. Keep the plate inside the dashed box.');
      scanLoop();
    } catch (e) {
      console.error(e);
      const msg = e.name === 'NotAllowedError' ? 'Camera permission was blocked. Allow camera access in your browser settings and try again.'
        : e.name === 'NotFoundError' ? 'No camera found on this device. Try demo mode.' : e.message;
      await stop(); setStatus(msg); alert(msg); return;
    }
  }
  requestWake();
  updateUI();
}
async function stop() {
  S.running = false;
  stopCamera(); stopGPS();
  if (S.wake) { try { await S.wake.release(); } catch { /* ignore */ } S.wake = null; }
  S.demoScene = []; S.scanMs = 0;
  setStatus(''); updateUI();
}
async function requestWake() {
  try { if ('wakeLock' in navigator && S.running) S.wake = await navigator.wakeLock.request('screen'); } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') requestWake(); });

/* ---------------------------------------------------------- full-page views */
const kv = rows => `<table class="kv">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>`;
const mapLink = e => e.lat == null ? '–' : `<a class="map-link" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${e.lat}&mlon=${e.lon}#map=17/${e.lat}/${e.lon}">${e.lat.toFixed(5)}, ${e.lon.toFixed(5)}</a>`;
const statusFlag = (txt, sev) => `<span class="flag ${sev}">${esc(txt)}</span>`;

function vehiclePage(plate) {
  const ev = evaluate(plate), r = ev.rec, i = r.info;
  const sights = LOG.filter(e => e.plate === plate).slice().reverse();
  const hot = HOT.some(h => h.plate === plate);
  const verdict = ev.sev === 'alert' ? 'Alert: speak to the keeper or driver' : ev.sev === 'warn' ? 'Offences possible: check documents' : 'No action indicated';
  const thumbs = sights.filter(s => s.thumb).slice(0, 8).map(s => `<img src="${s.thumb}" alt="Capture ${new Date(s.ts).toLocaleString('en-GB')}">`).join('');
  return `
  <div class="pg-head">
    <button class="btn" data-act="back">Back to scanner</button>
    <h2>Vehicle record</h2><div class="spacer"></div>
    <button class="btn" data-act="hot" data-plate="${plate}">${hot ? 'Remove from hotlist' : 'Add to hotlist'}</button>
  </div>
  <div class="pg-body">
    <div class="hero ${ev.sev}">
      ${plateHTML(plate, 'xl')}
      <div><div class="verdict">${verdict}</div>
      <div class="sub">${esc(r.colour)} ${esc(r.make)} ${esc(r.model)} · ${r.year}</div>${flagsHTML(ev.flags)}</div>
    </div>
    <div class="cols">
      <section class="card"><h3>Vehicle</h3>${kv([
        ['Make and model', `${esc(r.make)} ${esc(r.model)}`], ['Colour', esc(r.colour)], ['Type', esc(r.type)],
        ['Fuel', esc(r.fuel)], ['Engine size', r.cc ? r.cc + ' cc' : 'n/a (electric)'],
        ['First registered', r.regDate ? fmtMonth(r.regDate) : `${r.year} (approx.)`], ['Previous keepers', r.keepers - 1],
        ['Registered keeper', 'Withheld (fictional record)']])}</section>
      <section class="card"><h3>Status checks</h3>${kv([
        ['Vehicle tax', statusFlag(r.tax === 'Taxed' ? `Taxed until ${fmtDate(r.taxExp)}` : r.tax === 'SORN' ? 'SORN' : `Untaxed since ${fmtDate(r.taxExp)}`, r.tax === 'Taxed' ? 'ok' : 'warn')],
        ['MOT', statusFlag(r.mot === 'Valid' ? `Valid until ${fmtDate(r.motExp)}` : r.mot === 'Expired' ? `Expired ${fmtDate(r.motExp)}` : r.mot, r.mot === 'Valid' || r.mot === 'Not yet due' ? 'ok' : 'warn')],
        ['Insurance (MID)', statusFlag(r.insurance, r.insurance === 'Insured' ? 'ok' : 'alert')],
        ['Police marker', r.marker ? statusFlag(r.marker, 'alert') : statusFlag('None', 'ok')],
        ['Your hotlist', hot ? statusFlag(HOT.find(h => h.plate === plate).note || 'On hotlist', 'alert') : statusFlag('Not listed', 'ok')]])}</section>
      <section class="card"><h3>Plate analysis</h3>${kv([
        ['Format', esc(i.format)], ['Memory tag', i.memory ? esc(i.memory) : '–'], ['Issuing area', esc(i.region)],
        ['Age identifier', i.memory ? `${esc(plate.slice(2, 4))} = ${esc(i.window)}` : esc(i.window)],
        ['Sightings logged', sights.length]])}</section>
    </div>
    <section class="card">
      <h3>Your sightings (${sights.length})</h3>
      ${sights.length ? `<div class="tablewrap"><table class="tbl"><thead><tr><th>Time</th><th>Confidence</th><th>Your speed</th><th>Its speed (est.)</th><th>Distance</th><th>Seen</th><th>Location</th></tr></thead><tbody>
      ${sights.slice(0, 60).map(s => `<tr><td>${new Date(s.ts).toLocaleString('en-GB')}</td><td>${s.conf}%</td><td>${speedText(s.own)}</td><td>${speedText(s.front)}${s.speeding ? ' ⚠' : ''}</td><td>${s.dist != null ? s.dist.toFixed(0) + ' m' : '–'}</td><td>${s.seen}×</td><td>${mapLink(s)}</td></tr>`).join('')}
      </tbody></table></div>${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}
      <div class="toolbar" style="margin-top:12px"><button class="btn small" data-act="exportPlate" data-plate="${plate}">Export sightings (JSON)</button><button class="btn small" data-act="delPlate" data-plate="${plate}">Delete sightings</button></div>`
      : '<p class="empty">This plate has not been seen by the scanner yet. It was looked up manually.</p>'}
    </section>
  </div>`;
}

let logFilter = 'all', logQuery = '', logLimit = 150;
function logListHTML() {
  let rows = LOG.slice().reverse();
  if (logFilter !== 'all') rows = rows.filter(e => evaluate(e.plate).sev === logFilter);
  if (logQuery) rows = rows.filter(e => e.plate.includes(logQuery) || (getRecord(e.plate).make + ' ' + getRecord(e.plate).model).toUpperCase().includes(logQuery));
  const shown = rows.slice(0, logLimit);
  if (!rows.length) return '<p class="empty">Nothing matches. Start scanning, or change the filter.</p>';
  return shown.map(e => {
    const ev = evaluate(e.plate), r = ev.rec;
    return `<button class="row ${ev.sev}" data-plate="${e.plate}">
      <div>${e.thumb ? `<img src="${e.thumb}" alt="" style="height:30px;border-radius:4px;display:block;margin-bottom:4px">` : ''}${plateHTML(e.plate, 'sm')}</div>
      <div class="meta"><b>${esc(r.colour)} ${esc(r.make)} ${esc(r.model)}</b><span>${ev.sev === 'ok' ? 'No markers' : esc(ev.flags.map(f => f.t).join(', '))}</span></div>
      <div class="right"><b>${e.front != null ? speedText(e.front) : '–'}</b>${new Date(e.ts).toLocaleString('en-GB')}${e.demo ? ' · demo' : ''}</div></button>`;
  }).join('') + (rows.length > logLimit ? `<button class="btn" data-act="more">Show more (${rows.length - logLimit} left)</button>` : '');
}
function logPage() {
  return `
  <div class="pg-head"><button class="btn" data-act="back">Back to scanner</button><h2>Vehicle log</h2><div class="spacer"></div>
    <button class="btn small" data-act="csv">Export CSV</button><button class="btn small" data-act="json">Export JSON</button><button class="btn small" data-act="clear">Clear log</button></div>
  <div class="pg-body">
    <div class="toolbar">
      <input type="search" id="logSearch" placeholder="Search plate, make or model" value="${esc(logQuery)}" aria-label="Search log">
      <div class="seg" id="logSeg">${[['all', 'All'], ['alert', 'Alerts'], ['warn', 'Warnings'], ['ok', 'Clear']].map(([k, l]) => `<button data-f="${k}" class="${logFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div class="loglist" id="logList">${logListHTML()}</div>
  </div>`;
}
function hotPage() {
  return `
  <div class="pg-head"><button class="btn" data-act="back">Back to scanner</button><h2>Hotlist</h2></div>
  <div class="pg-body">
    <div class="card"><h3>Add a plate to watch for</h3>
      <form id="hotForm" class="toolbar" autocomplete="off">
        <input class="plate-input" id="hotPlate" placeholder="AB12 CDE" maxlength="9" style="max-width:190px" aria-label="Plate">
        <input type="text" id="hotNote" placeholder="Note, e.g. friend's van" style="flex:1;min-width:160px" aria-label="Note">
        <button class="btn primary" type="submit">Add</button>
      </form>
      <p class="hint" id="hotMsg"></p>
    </div>
    <div class="loglist" style="margin-top:12px">${HOT.length ? HOT.map(h => `<div class="row alert" style="cursor:default">${plateHTML(h.plate, 'sm')}<div class="meta"><b>${esc(h.note || 'No note')}</b><span>Added ${new Date(h.added).toLocaleDateString('en-GB')}</span></div><div><button class="btn small" data-act="open" data-plate="${h.plate}">Open</button> <button class="btn small" data-act="unhot" data-plate="${h.plate}">Remove</button></div></div>`).join('') : '<p class="empty">No plates on your hotlist. Anything you add triggers a red alert whenever the scanner sees it.</p>'}</div>
  </div>`;
}
function settingsPage() {
  const sel = (k, opts) => `<select data-set="${k}">${opts.map(([v, l]) => `<option value="${v}" ${String(settings[k]) === String(v) ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
  const num = (k, min, max, step = 1) => `<input type="number" data-set="${k}" min="${min}" max="${max}" step="${step}" value="${settings[k]}">`;
  const chk = (k, label) => `<div class="field check"><input type="checkbox" id="set_${k}" data-set="${k}" ${settings[k] ? 'checked' : ''}><label for="set_${k}">${label}</label></div>`;
  return `
  <div class="pg-head"><button class="btn" data-act="back">Back to scanner</button><h2>Settings</h2></div>
  <div class="pg-body">
    <div class="form-grid">
      <div class="field"><label>Speed units</label>${sel('units', [['mph', 'Miles per hour'], ['kph', 'Kilometres per hour']])}</div>
      <div class="field"><label>Camera field of view (degrees)</label>${num('fov', 40, 120)}<small>Used to turn plate size into distance. Most phone main cameras are 63 to 70. Calibrate by checking the distance reading against a plate at a known distance.</small></div>
      <div class="field"><label>Speed limit for alerts</label>${num('speedLimit', 0, 120)}<small>Flags the vehicle ahead if its estimated speed is more than 10 percent over. Set 0 to turn off.</small></div>
      <div class="field"><label>Log the same plate again after (seconds)</label>${num('cooldown', 5, 3600)}<small>A plate that stays in view is logged once and its entry keeps updating.</small></div>
      <div class="field"><label>Reads needed to accept a plate</label>${sel('confirmReads', [[1, '1 (fastest, more false reads)'], [2, '2 (balanced)'], [3, '3 (strict)']])}</div>
      <div class="field"><label>Minimum OCR confidence (%)</label>${num('minConf', 20, 95)}</div>
      <div class="field"><label>Scan resolution</label>${sel('scanWidth', [[960, '960 px (fast)'], [1280, '1280 px (balanced)'], [1920, '1920 px (reads further away, slower)']])}</div>
      <div class="field"><label>Camera</label>${sel('facing', [['environment', 'Rear camera'], ['user', 'Front camera']])}<small>Applies next time you start scanning.</small></div>
      <div class="field"><label>Maximum log entries kept</label>${num('retain', 50, 5000, 50)}</div>
    </div>
    <div style="margin:14px 0;display:grid;gap:8px">
      ${chk('centreOnly', 'Scan only the middle of the picture (faster, fewer false reads)')}
      ${chk('sound', 'Beep on new plates and alerts')}
      ${chk('vibrate', 'Vibrate on alerts')}
      ${chk('thumbs', 'Save a small photo of each plate in the log')}
    </div>
    <div class="pill-note">Everything stays on this device. The log is saved in your browser's local storage and nothing is uploaded. Clearing site data removes it.</div>
    <div class="card" style="margin-top:14px"><h3>How the speed estimate works</h3>
      <p style="margin:0 0 8px">GPS gives your own speed. The camera gives the distance to the vehicle ahead, worked out from how tall the plate characters appear (they are 79 mm tall on UK plates). The scanner tracks how that distance changes over a few seconds, adds that closing speed to your own, and gets the vehicle's speed.</p>
      <p style="margin:0">It is an estimate, not an enforcement-grade measurement. Expect errors of several mph, more at long range, with a wrong field of view setting, or with non-standard plates.</p></div>
    <div class="card" style="margin-top:14px"><h3>Feature ideas</h3><ul class="ideas">
      <li>Real DVLA Vehicle Enquiry Service lookup through a Cloudflare Pages Function that holds your API key</li>
      <li>On-device plate detection model for reading at greater range and in poor light</li>
      <li>Plate-in-view clustering so stationary parked cars are tagged as parked</li>
      <li>Trip sessions with start and end times, route trace and per-trip reports</li>
      <li>Convoy and "seen again" alerts when the same plate appears on different days or places</li>
      <li>Map view of every sighting, with clustering</li>
      <li>Voice announcements of alerts for hands-free use</li>
      <li>Installable offline app (PWA) with the OCR engine bundled</li>
    </ul></div>
  </div>`;
}

let pageRefreshT = 0;
function schedulePageRefresh(plate) {
  const m = location.hash.match(/^#\/v\/([A-Z0-9]+)/);
  if (m && m[1] === plate && Date.now() - pageRefreshT > 2000) { pageRefreshT = Date.now(); renderRoute(true); }
  else if (location.hash === '#/log') { const l = $('#logList'); if (l && Date.now() - pageRefreshT > 2000) { pageRefreshT = Date.now(); l.innerHTML = logListHTML(); } }
}
function renderRoute(keepScroll) {
  const h = location.hash || '#/', page = $('#page');
  const m = h.match(/^#\/v\/([A-Z0-9]+)$/);
  let html = '';
  if (m) html = vehiclePage(m[1]);
  else if (h === '#/log') html = logPage();
  else if (h === '#/hotlist') html = hotPage();
  else if (h === '#/settings') html = settingsPage();
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === (m ? '/log' : h.slice(1)) || (h === '#/' && a.dataset.nav === '/')));
  if (!html) { page.hidden = true; document.body.style.overflow = ''; return; }
  const top = keepScroll ? page.scrollTop : 0;
  page.innerHTML = html; page.hidden = false; page.scrollTop = top;
  document.body.style.overflow = 'hidden';
}
window.addEventListener('hashchange', () => renderRoute(false));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#page').hidden) location.hash = '#/'; });

/* ----------------------------------------------------------------- exports */
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
function exportCSV(rows) {
  const head = ['time', 'plate', 'make', 'model', 'colour', 'status', 'confidence', 'lat', 'lon', 'own_mph', 'ahead_mph_est', 'distance_m', 'times_seen'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = rows.map(e => { const ev = evaluate(e.plate), r = ev.rec; return [new Date(e.ts).toISOString(), e.plate, r.make, r.model, r.colour, ev.flags.map(f => f.t).join('; '), e.conf, e.lat, e.lon, e.own != null ? (e.own * 2.23694).toFixed(1) : '', e.front != null ? (e.front * 2.23694).toFixed(1) : '', e.dist != null ? e.dist.toFixed(1) : '', e.seen].map(q).join(','); });
  return head.join(',') + '\n' + lines.join('\n');
}

/* ------------------------------------------------------------------ events */
document.addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act, plate = act.dataset.plate;
    if (a === 'back') location.hash = '#/';
    else if (a === 'open') location.hash = '#/v/' + plate;
    else if (a === 'hot') { const i = HOT.findIndex(h => h.plate === plate); if (i >= 0) HOT.splice(i, 1); else HOT.push({ plate, note: prompt('Note for this hotlist entry (optional)') || '', added: Date.now() }); saveHot(); S.dirty = true; renderRoute(true); }
    else if (a === 'unhot') { HOT = HOT.filter(h => h.plate !== plate); saveHot(); renderRoute(true); }
    else if (a === 'more') { logLimit += 150; $('#logList').innerHTML = logListHTML(); }
    else if (a === 'csv') download('platewatch-log.csv', exportCSV(LOG), 'text/csv');
    else if (a === 'json') download('platewatch-log.json', JSON.stringify(LOG, null, 1), 'application/json');
    else if (a === 'exportPlate') download(`${plate}-sightings.json`, JSON.stringify(LOG.filter(x => x.plate === plate), null, 1), 'application/json');
    else if (a === 'delPlate') { if (confirm('Delete every logged sighting of ' + fmtPlate(plate) + '?')) { LOG = LOG.filter(x => x.plate !== plate); S.lastEntry.delete(plate); saveLogNow(); S.dirty = true; renderRoute(true); } }
    else if (a === 'clear') { if (confirm('Delete the whole log? This cannot be undone.')) { LOG = []; S.lastEntry.clear(); saveLogNow(); S.dirty = true; renderRoute(true); } }
    return;
  }
  const seg = e.target.closest('#logSeg button');
  if (seg) { logFilter = seg.dataset.f; logLimit = 150; $$('#logSeg button').forEach(b => b.classList.toggle('on', b === seg)); $('#logList').innerHTML = logListHTML(); return; }
  const row = e.target.closest('.row[data-plate]');
  if (row) location.hash = '#/v/' + row.dataset.plate;
});
document.addEventListener('input', e => {
  if (e.target.id === 'logSearch') { logQuery = e.target.value.toUpperCase().replace(/\s/g, ''); logLimit = 150; $('#logList').innerHTML = logListHTML(); }
});
document.addEventListener('change', e => {
  const k = e.target.dataset?.set; if (!k) return;
  const t = e.target;
  settings[k] = t.type === 'checkbox' ? t.checked : (t.type === 'number' || /^\d+$/.test(t.value)) ? Number(t.value) : t.value;
  saveSettings(); S.dirty = true;
});
document.addEventListener('submit', e => {
  if (e.target.id === 'lookupForm') {
    e.preventDefault();
    const p = $('#lookupInput').value.toUpperCase().replace(/[^A-Z0-9]/g, ''), msg = $('#lookupMsg');
    if (!validPlate(p)) { msg.textContent = 'That is not a valid UK registration. Try a format like AB12 CDE.'; msg.className = 'hint err'; return; }
    msg.textContent = ''; msg.className = 'hint'; location.hash = '#/v/' + p;
  }
  if (e.target.id === 'hotForm') {
    e.preventDefault();
    const p = $('#hotPlate').value.toUpperCase().replace(/[^A-Z0-9]/g, ''), msg = $('#hotMsg');
    if (!plateFormat(p)) { msg.textContent = 'That is not a valid UK registration.'; msg.className = 'hint err'; return; }
    if (!HOT.some(h => h.plate === p)) HOT.push({ plate: p, note: $('#hotNote').value.trim(), added: Date.now() });
    saveHot(); S.dirty = true; renderRoute(true);
  }
});
$('#btnStartIdle').onclick = () => start(false);
$('#btnDemoIdle').onclick = () => start(true);
$('#btnStop').onclick = () => stop();
$('#btnFlip').onclick = async () => { settings.facing = settings.facing === 'environment' ? 'user' : 'environment'; saveSettings(); if (S.running && !S.demo) await start(false); };
$('#btnExpand').onclick = () => {
  const v = $('#viewer'), on = v.classList.toggle('expanded');
  $('#btnExpand').textContent = on ? 'Collapse' : 'Expand';
  try { if (on) document.documentElement.requestFullscreen?.(); else if (document.fullscreenElement) document.exitFullscreen(); } catch { /* ignore */ }
};

/* -------------------------------------------------------------------- boot */
renderRoute(false);
drawOverlay();
updateUI();
})();
