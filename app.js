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
  fov: 65,            
  cooldown: 45,       
  confirmReads: 2,    
  minConf: 55,        
  centreOnly: true,   
  scanWidth: 1280,
  speedLimit: 30,     
  sound: true,
  vibrate: true,
  thumbs: true,
  retain: 800,
  facing: 'environment',
  dvlaApiKey: '',               // Real DVLA VES API Key
  dvlaProxyUrl: ''              // Optional proxy URL to bypass browser CORS (e.g. Cloudflare Worker)
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
    if (plateInfo(p).start > new Date()) return false;
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

/* -------------------------------------- REAL DVLA VES API & FALLBACK SIMULATOR */
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
const fmtDate = d => d ? (d instanceof Date ? d : new Date(d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '–';

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
const COLOURS = ['BLACK', 'WHITE', 'SILVER', 'GREY', 'BLUE', 'RED', 'GREEN', 'ORANGE', 'BROWN', 'YELLOW'];
const recCache = new Map();

function generateFictionalRecord(plate) {
  const rng = mulberry32(xmur3(plate));
  const info = plateInfo(plate);
  const now = new Date();
  const make = pick(rng, Object.keys(MAKES));
  const model = pick(rng, MAKES[make]);
  const year = info.year ?? 2004 + Math.floor(rng() * 12);
  const age = now.getFullYear() - year;
  const ev = EVS.has(model);
  const fuel = ev ? 'ELECTRIC' : (age < 10 ? pick(rng, ['PETROL', 'PETROL', 'DIESEL', 'HYBRID ELECTRIC']) : pick(rng, ['PETROL', 'PETROL', 'DIESEL']));
  
  const rec = {
    registrationNumber: plate,
    make: make.toUpperCase(),
    model: model.toUpperCase(),
    colour: pick(rng, COLOURS),
    yearOfManufacture: year,
    type: VANS.has(model) ? 'Light goods vehicle' : 'Car',
    fuelType: fuel,
    engineCapacity: ev ? null : 900 + Math.floor(rng() * 21) * 100,
    co2Emissions: ev ? 0 : 95 + Math.floor(rng() * 80),
    keepers: 1 + Math.floor(rng() * 5),
    info,
    isRealDvlaData: false
  };

  const rt = rng();
  rec.taxStatus = rt < 0.91 ? 'Taxed' : rt < 0.96 ? 'Untaxed' : 'SORN';
  rec.taxDueDate = rec.taxStatus === 'Taxed' ? addMonths(now, 1 + Math.floor(rng() * 11)).toISOString().slice(0,10) : addMonths(now, -(1 + Math.floor(rng() * 8))).toISOString().slice(0,10);

  if (age < 3) { rec.motStatus = 'No details held by DVLA'; rec.motExp = null; }
  else {
    const rm = rng();
    if (rm < 0.88) { rec.motStatus = 'Valid'; rec.motExp = addMonths(now, 1 + Math.floor(rng() * 11)).toISOString().slice(0,10); }
    else if (rm < 0.97) { rec.motStatus = 'Expired'; rec.motExp = addMonths(now, -(1 + Math.floor(rng() * 6))).toISOString().slice(0,10); }
    else { rec.motStatus = 'No details held by DVLA'; rec.motExp = null; }
  }
  rec.insurance = rng() < 0.93 ? 'Insured' : 'No insurance on MID';

  const rk = rng();
  rec.marker = rk < 0.006 ? 'Reported stolen'
    : rk < 0.014 ? 'Vehicle of interest (intelligence marker)'
    : rk < 0.02 ? 'Suspected cloned plate'
    : rk < 0.026 ? 'Recorded as scrapped, plate still in use' : null;

  return rec;
}

// Fetch live vehicle status directly from DVLA API if API key is present
async function fetchDvlaRecord(plate) {
  if (!settings.dvlaApiKey) return null;
  const endpoint = settings.dvlaProxyUrl || 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': settings.dvlaApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ registrationNumber: plate })
    });
    if (res.ok) {
      const dvlaData = await res.json();
      dvlaData.isRealDvlaData = true;
      dvlaData.insurance = 'Insured'; // MID data is separate from DVLA VES
      dvlaData.marker = null;
      dvlaData.info = plateInfo(plate);
      return dvlaData;
    }
  } catch (err) {
    console.warn('DVLA API call failed, falling back to simulated data:', err);
  }
  return null;
}

function getRecord(plate) {
  if (recCache.has(plate)) return recCache.get(plate);
  const fictional = generateFictionalRecord(plate);
  recCache.set(plate, fictional);
  
  // Async query DVLA API and refresh state once retrieved
  if (settings.dvlaApiKey) {
    fetchDvlaRecord(plate).then(realData => {
      if (realData) {
        recCache.set(plate, realData);
        S.dirty = true;
        schedulePageRefresh(plate);
      }
    });
  }
  return fictional;
}

function evaluate(plate) {
  const rec = getRecord(plate);
  const flags = [];
  if (rec.marker) flags.push({ t: rec.marker, sev: 'alert' });
  if (rec.insurance !== 'Insured') flags.push({ t: 'No insurance', sev: 'alert' });
  const hl = HOT.find(h => h.plate === plate);
  if (hl) flags.push({ t: 'PNC Hotlist: ' + (hl.note || 'No note'), sev: 'alert' });
  
  if (rec.taxStatus === 'Untaxed') flags.push({ t: 'UNTAXED', sev: 'warn' });
  if (rec.taxStatus === 'SORN') flags.push({ t: 'SORN ON ROAD', sev: 'warn' });
  if (rec.motStatus === 'Expired') flags.push({ t: 'MOT EXPIRED', sev: 'warn' });
  if (rec.motStatus === 'No details held by DVLA') flags.push({ t: 'NO MOT HELD', sev: 'warn' });

  const sev = flags.some(f => f.sev === 'alert') ? 'alert' : flags.length ? 'warn' : 'ok';
  if (!flags.length) flags.push({ t: 'NO PNC MARKERS', sev: 'ok' });
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
const speedText = mps => mps == null ? '–' : `${fmtSpeed(mps)} ${settings.units.toUpperCase()}`;

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
  if (!window.Tesseract) throw new Error('OCR Engine offline. Verify network connection.');
  setStatus('INITIALISING ANPR OCR ENGINE...');
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
  sky.addColorStop(0, '#0a1626'); sky.addColorStop(1, '#1b3454');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H * 0.45);
  ctx.fillStyle = '#111923'; ctx.fillRect(0, H * 0.45, W, H * 0.55);
  ctx.fillStyle = '#1c2838';
  ctx.beginPath(); ctx.moveTo(W * 0.46, H * 0.45); ctx.lineTo(W * 0.54, H * 0.45); ctx.lineTo(W * 0.95, H); ctx.lineTo(W * 0.05, H); ctx.fill();
  ctx.strokeStyle = '#00ff66'; ctx.lineWidth = 4; ctx.setLineDash([40, 40]); ctx.lineDashOffset = -(Date.now() / 12) % 80;
  ctx.beginPath(); ctx.moveTo(W * 0.5, H * 0.45); ctx.lineTo(W * 0.5, H); ctx.stroke(); ctx.setLineDash([]);
  for (const v of S.demoScene) {
    const b = v.bbox, pw = v.hpx * 6.6, ph = v.hpx * 1.45, cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    ctx.fillStyle = '#090f17'; ctx.fillRect(cx - pw * 1.7, cy - ph * 3.2, pw * 3.4, ph * 5);
    ctx.fillStyle = '#05080c'; ctx.fillRect(cx - pw * 1.4, cy - ph * 2.6, pw * 2.8, ph * 1.6);
    ctx.fillStyle = '#ff2222'; ctx.fillRect(cx - pw * 1.6, cy - ph * 0.9, pw * 0.35, ph * 0.5); ctx.fillRect(cx + pw * 1.25, cy - ph * 0.9, pw * 0.35, ph * 0.5);
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
  tr.dist = focalPx(c.frameW) * 0.079 / hpx;
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
    if (tr.
