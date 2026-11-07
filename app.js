(() => {
'use strict';

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

const DEFAULTS = {
  units: 'mph',
  fov: 65,
  cooldown: 45,
  confirmReads: 1,
  minConf: 40,
  centreOnly: true,
  scanWidth: 1280,
  speedLimit: 30,
  sound: true,
  vibrate: true,
  thumbs: true,
  retain: 800,
  facing: 'environment',
  dvlaApiKey: 'DvlaSearchDemoAccount',
  dvlaProxyUrl: ''
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

/* Flexible UK Registration Parser (Fixes Manual Lookup Error) */
const CURRENT = /^[A-Z]{2}\d{2}[A-Z]{3}$/;
const PREFIX = /^[A-Z]\d{1,3}[A-Z]{3}$/;
const SUFFIX = /^[A-Z]{3}\d{1,3}[A-Z]$/;

function cleanPlate(p) {
  return String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function plateFormat(p) {
  const c = cleanPlate(p);
  if (CURRENT.test(c)) return 'current';
  if (PREFIX.test(c)) return 'prefix';
  if (SUFFIX.test(c)) return 'suffix';
  if (c.length >= 2 && c.length <= 8) return 'generic';
  return null;
}
function fmtPlate(p) {
  const c = cleanPlate(p);
  if (CURRENT.test(c)) return c.slice(0, 4) + ' ' + c.slice(4);
  if (PREFIX.test(c)) return c.slice(0, -3) + ' ' + c.slice(-3);
  if (SUFFIX.test(c)) return c.slice(0, 3) + ' ' + c.slice(3);
  return c || p;
}
function plateInfo(p) {
  const c = cleanPlate(p);
  const f = plateFormat(c);
  if (f === 'current') {
    const n = parseInt(c.slice(2, 4), 10);
    const sep = n >= 51;
    const year = sep ? 2000 + n - 50 : 2000 + n;
    return { format: 'Current (2001+)', year, region: 'UK Office' };
  }
  return { format: 'Standard Registration', year: 2018, region: 'UK' };
}
function validPlate(p) {
  return !!plateFormat(p);
}
function extractPlates(s) {
  const clean = cleanPlate(s);
  if (validPlate(clean)) return [{ plate: clean, corr: 0 }];
  return [];
}
function plateHTML(p, size = 'sm') {
  return `<span class="plate ${size}"><span class="gb">GB</span><span class="reg">${esc(fmtPlate(p))}</span></span>`;
}

/* Fictional Vehicle Data Engine & Optional DVLA VES API Integration */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = h << 13 | h >>> 19; }
  return (h ^= h >>> 16) >>> 0;
}
function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const addMonths = (d, m) => { const x = new Date(d); x.setMonth(x.getMonth() + m); return x; };
const fmtDate = d => d ? (d instanceof Date ? d : new Date(d)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '–';

const MAKES = {
  'ROLLS ROYCE': ['FUTURAMA', 'PHANTOM', 'GHOST'],
  Ford: ['Fiesta', 'Focus', 'Transit'], Vauxhall: ['Corsa', 'Astra'],
  Volkswagen: ['Golf', 'Polo'], BMW: ['3 Series', '5 Series'],
  Audi: ['A4', 'A6'], Nissan: ['Qashqai', 'Leaf']
};
const COLOURS = ['BLACK', 'WHITE', 'SILVER', 'GREY', 'BLUE', 'RED', 'PINK'];
const recCache = new Map();

function generateFictionalRecord(plate) {
  const c = cleanPlate(plate);
  const rng = mulberry32(xmur3(c));
  const info = plateInfo(c);
  const now = new Date();
  
  let make = 'ROLLS ROYCE', model = 'FUTURAMA';
  if (c !== 'FAB1') {
    make = pick(rng, Object.keys(MAKES));
    model = pick(rng, MAKES[make]);
  }

  const rec = {
    registrationNumber: c,
    make: make.toUpperCase(),
    model: model.toUpperCase(),
    colour: c === 'FAB1' ? 'PINK' : pick(rng, COLOURS),
    yearOfManufacture: info.year || 2015,
    fuelType: 'PETROL',
    engineCapacity: 2400,
    co2Emissions: 140,
    info,
    isRealDvlaData: false
  };

  rec.taxStatus = rng() < 0.9 ? 'Taxed' : 'Untaxed';
  rec.taxDueDate = addMonths(now, 6).toISOString().slice(0, 10);
  rec.motStatus = 'Valid';
  rec.motExp = addMonths(now, 8).toISOString().slice(0, 10);
  rec.insurance = 'Insured';
  rec.marker = null;

  return rec;
}

async function fetchDvlaRecord(plate) {
  if (!settings.dvlaApiKey) return null;
  const endpoint = settings.dvlaProxyUrl || 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'x-api-key': settings.dvlaApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrationNumber: cleanPlate(plate) })
    });
    if (res.ok) {
      const data = await res.json();
      data.isRealDvlaData = true;
      data.insurance = 'Insured';
      data.info = plateInfo(plate);
      return data;
    }
  } catch (err) {
    console.warn('DVLA API call skipped/failed:', err);
  }
  return null;
}

function getRecord(plate) {
  const c = cleanPlate(plate);
  if (recCache.has(c)) return recCache.get(c);
  const fictional = generateFictionalRecord(c);
  recCache.set(c, fictional);
  if (settings.dvlaApiKey) {
    fetchDvlaRecord(c).then(real => {
      if (real) { recCache.set(c, real); S.dirty = true; renderRoute(); }
    });
  }
  return fictional;
}

function evaluate(plate) {
  const c = cleanPlate(plate);
  const rec = getRecord(c);
  const flags = [];
  if (rec.marker) flags.push({ t: rec.marker, sev: 'alert' });
  if (rec.insurance !== 'Insured') flags.push({ t: 'No insurance', sev: 'alert' });
  const hl = HOT.find(h => cleanPlate(h.plate) === c);
  if (hl) flags.push({ t: 'Watchlist: ' + (hl.note || 'Hotlist match'), sev: 'alert' });
  if (rec.taxStatus === 'Untaxed') flags.push({ t: 'Untaxed', sev: 'warn' });
  if (rec.motStatus === 'Expired') flags.push({ t: 'MOT Expired', sev: 'warn' });

  const sev = flags.some(f => f.sev === 'alert') ? 'alert' : flags.length ? 'warn' : 'ok';
  if (!flags.length) flags.push({ t: 'No PNC markers', sev: 'ok' });
  return { rec, flags, sev };
}
const flagsHTML = flags => `<div class="flags">${flags.map(f => `<span class="flag ${f.sev}">${esc(f.t)}</span>`).join('')}</div>`;

/* State management & Camera loop */
const S = {
  running: false, demo: false, stream: null, worker: null,
  ownSpeed: null, tracks: new Map(), pending: new Map(), lastEntry: new Map(),
  boxes: [], frameW: 1280, frameH: 720, scanMs: 0, scans: 0, dirty: true
};
const video = $('#video'), overlay = $('#overlay'), octx = overlay.getContext('2d');
const cvFull = document.createElement('canvas'), cvScan = document.createElement('canvas');
const xFull = cvFull.getContext('2d', { willReadFrequently: true });
const xScan = cvScan.getContext('2d', { willReadFrequently: true });

const MPS = { mph: 2.23694, kph: 3.6 };
const toUnit = mps => mps * MPS[settings.units];
const fmtSpeed = mps => (mps == null || isNaN(mps)) ? '--' : Math.round(toUnit(mps));

/* Tesseract Worker Initialization Fix */
async function ensureWorker() {
  if (S.worker) return;
  if (typeof Tesseract === 'undefined') throw new Error('OCR Library script not loaded.');
  setStatus('Loading OCR Engine...');
  S.worker = await Tesseract.createWorker('eng');
  await S.worker.setParameters({
    tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    tessedit_pageseg_mode: '11'
  });
}

async function startCamera() {
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: settings.facing }, width: { ideal: 1280 }, height: { ideal: 720 } }
  });
  video.srcObject = S.stream;
  await video.play();
}

function stopCamera() {
  if (S.stream) S.stream.getTracks().forEach(t => t.stop());
  S.stream = null; video.srcObject = null;
}

async function scanOnce() {
  if (!video.videoWidth || video.readyState < 2) return;
  const W = Math.min(settings.scanWidth, video.videoWidth), k = W / video.videoWidth, H = Math.round(video.videoHeight * k);
  if (cvFull.width !== W || cvFull.height !== H) { cvFull.width = W; cvFull.height = H; }
  S.frameW = W; S.frameH = H;
  xFull.drawImage(video, 0, 0, W, H);
  
  cvScan.width = W; cvScan.height = H;
  xScan.drawImage(cvFull, 0, 0);
  
  const { data } = await S.worker.recognize(cvScan);
  const text = (data.text || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (text.length >= 3) {
    onDetect({ plate: text, conf: data.confidence || 80, bbox: { x0: W*0.2, y0: H*0.4, x1: W*0.8, y1: H*0.6 }, frameW: W, frameH: H });
  }
}

async function scanLoop() {
  while (S.running && !S.demo) {
    const t0 = performance.now();
    try { await scanOnce(); S.scans++; } catch (e) { console.error(e); await sleep(500); }
    S.scanMs = S.scanMs ? S.scanMs * 0.7 + (performance.now() - t0) * 0.3 : performance.now() - t0;
    await sleep(20);
  }
}

function demoLoop() {
  if (!S.running || !S.demo) return;
  const W = 1280, H = 720;
  S.frameW = W; S.frameH = H;
  onDetect({ plate: 'FAB1', conf: 95, bbox: { x0: W*0.3, y0: H*0.4, x1: W*0.7, y1: H*0.6 }, frameW: W, frameH: H });
  S.scanMs = 300; S.scans++;
  setTimeout(demoLoop, 1500);
}

function onDetect(c) {
  const now = Date.now(), plate = cleanPlate(c.plate);
  if (!validPlate(plate)) return;
  
  const ev = evaluate(plate);
  S.boxes.push({ plate, bbox: c.bbox, t: now, sev: ev.sev });

  const le = S.lastEntry.get(plate);
  const fresh = !le || now - le > settings.cooldown * 1000;
  if (fresh) {
    const entry = { id: uid(), ts: now, plate, conf: Math.round(c.conf), seen: 1, demo: S.demo };
    LOG.push(entry);
    saveLog();
    showToast(entry, ev);
  }
  S.lastEntry.set(plate, now);
  S.dirty = true;
  updateUI();
}

function showToast(entry, ev) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${ev.sev}`;
  el.innerHTML = `
    <div>${plateHTML(entry.plate, 'sm')}</div>
    <div>
      <div class="t-title">${ev.sev === 'alert' ? 'PNC ALERT' : 'LOGGED'}: ${esc(ev.rec.colour)} ${esc(ev.rec.make)}</div>
      ${flagsHTML(ev.flags.slice(0, 2))}
      <div class="t-open">Tap to open record</div>
    </div>
    <button class="t-x">×</button>`;
  el.onclick = () => { location.hash = '#/v/' + entry.plate; el.remove(); };
  box.prepend(el);
  setTimeout(() => el.remove(), 7000);
}

function drawOverlay() {
  const W = S.frameW, H = S.frameH;
  if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; }
  octx.clearRect(0, 0, W, H);
  const now = Date.now();
  S.boxes = S.boxes.filter(b => now - b.t < 1500);
  for (const b of S.boxes) {
    octx.strokeStyle = '#2563eb'; octx.lineWidth = 3;
    octx.strokeRect(b.bbox.x0, b.bbox.y0, b.bbox.x1 - b.bbox.x0, b.bbox.y1 - b.bbox.y0);
  }
  requestAnimationFrame(drawOverlay);
}

function setStatus(t) { $('#statusLine').textContent = t; }
function updateUI() {
  $('#ownSpeed').textContent = fmtSpeed(S.ownSpeed);
  $('#stTotal').textContent = LOG.length;
  $('#stUnique').textContent = new Set(LOG.map(e => e.plate)).size;
  $('#stAlerts').textContent = LOG.filter(e => evaluate(e.plate).sev === 'alert').length;
  
  if (S.dirty) {
    S.dirty = false;
    const feed = $('#feed'), rows = LOG.slice(-10).reverse();
    feed.innerHTML = rows.length ? rows.map(rowHTML).join('') : '<p class="empty">No captures yet.</p>';
  }
  $('#stRate').textContent = S.scanMs ? (S.scanMs / 1000).toFixed(1) + 's' : '--';
}
setInterval(updateUI, 500);

function rowHTML(e) {
  const ev = evaluate(e.plate), r = ev.rec;
  return `<button class="row ${ev.sev}" data-plate="${e.plate}">
    ${plateHTML(e.plate, 'sm')}
    <div class="meta"><b>${esc(r.colour)} ${esc(r.make)} ${esc(r.model)}</b><span>${esc(ev.flags[0].t)}</span></div>
    <div class="right"><b>${new Date(e.ts).toLocaleTimeString('en-GB')}</b></div>
  </button>`;
}

async function start(demo) {
  if (S.running) await stop();
  S.demo = demo; S.running = true;
  $('#viewer').classList.add('live');
  if (demo) {
    setStatus('Simulator Mode Active');
    demoLoop();
  } else {
    try {
      setStatus('Starting Camera...');
      await startCamera();
      await ensureWorker();
      setStatus('Scanning...');
      scanLoop();
    } catch (e) {
      await stop(); alert('Camera initialization error: ' + e.message); return;
    }
  }
  updateUI();
}

async function stop() {
  S.running = false;
  stopCamera();
  $('#viewer').classList.remove('live');
  setStatus('Idle');
  updateUI();
}

/* PNC Full View Renderer (Fixes Manual Lookup Page Blanking) */
function vehiclePage(plate) {
  const c = cleanPlate(plate);
  const ev = evaluate(c), r = ev.rec;
  const sights = LOG.filter(e => e.plate === c).reverse();
  const hot = HOT.some(h => cleanPlate(h.plate) === c);

  return `
  <div class="pg-head">
    <button class="btn" data-act="back">← Back</button>
    <h2>PNC Vehicle Online Data: ${fmtPlate(c)}</h2>
    <div class="spacer"></div>
    <button class="btn" data-act="hot" data-plate="${c}">${hot ? 'Remove Watchlist' : 'Add Watchlist'}</button>
  </div>
  <div class="pg-body">
    <div class="hero ${ev.sev}">
      ${plateHTML(c, 'xl')}
      <div>
        <div class="verdict">${ev.sev === 'alert' ? 'ACTION INDICATED: CHECK VEHICLE' : 'VEHICLE RECORD CLEAR'}</div>
        <div class="sub">${esc(r.colour)} ${esc(r.make)} ${esc(r.model)} (${r.yearOfManufacture || '2015'})</div>
        ${flagsHTML(ev.flags)}
      </div>
    </div>
    <div class="cols">
      <section class="card">
        <h3>Vehicle Online Data (VOD)</h3>
        <table class="kv">
          <tr><td>Make / Model</td><td>${esc(r.make)} ${esc(r.model)}</td></tr>
          <tr><td>Colour</td><td>${esc(r.colour)}</td></tr>
          <tr><td>Fuel Type</td><td>${esc(r.fuelType)}</td></tr>
          <tr><td>Engine Capacity</td><td>${r.engineCapacity} cc</td></tr>
          <tr><td>Tax Status</td><td>${esc(r.taxStatus)}</td></tr>
          <tr><td>MOT Status</td><td>${esc(r.motStatus)}</td></tr>
          <tr><td>Insurer</td><td>Burchill Insurance Services</td></tr>
          <tr><td>Policy Number</td><td>D993412X</td></tr>
        </table>
      </section>
      <section class="card">
        <h3>Policyholder & Drivers</h3>
        <table class="kv">
          <tr><td>Policyholder</td><td>Lady Penelope Creighton, Slough, Berkshire</td></tr>
          <tr><td>Permitted Drivers</td><td>INSURED AND CHAUFFEUR</td></tr>
          <tr><td>Named Drivers</td><td>1. 'NOSEY' PARKER</td></tr>
          <tr><td>Class of Use</td><td>SOCIAL DOMESTIC AND PLEASURE</td></tr>
        </table>
      </section>
    </div>
  </div>`;
}

function renderRoute() {
  const h = location.hash || '#/', page = $('#page');
  const m = h.match(/^#\/v\/([A-Z0-9]+)$/i);
  if (m) {
    page.innerHTML = vehiclePage(m[1]);
    page.hidden = false;
  } else {
    page.hidden = true;
  }
}

window.addEventListener('hashchange', renderRoute);

document.addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'back' || a === 'nav-home') location.hash = '#/';
    else if (a === 'hot') {
      const p = cleanPlate(act.dataset.plate);
      const idx = HOT.findIndex(h => cleanPlate(h.plate) === p);
      if (idx >= 0) HOT.splice(idx, 1); else HOT.push({ plate: p, note: 'Manual entry', added: Date.now() });
      saveHot(); renderRoute();
    }
    return;
  }
  const row = e.target.closest('.row[data-plate]');
  if (row) location.hash = '#/v/' + row.dataset.plate;
});

document.addEventListener('submit', e => {
  if (e.target.id === 'lookupForm') {
    e.preventDefault();
    const raw = $('#lookupInput').value;
    const p = cleanPlate(raw);
    if (!p) return;
    location.hash = '#/v/' + p;
  }
});

$('#btnStartIdle').onclick = () => start(false);
$('#btnDemoIdle').onclick = () => start(true);
$('#btnStop').onclick = () => stop();
$('#btnBottomBack').onclick = () => location.hash = '#/';
$('#clockBtn').onclick = () => alert('System Time: ' + new Date().toLocaleTimeString());
$('#btnUrgent').onclick = () => alert('Urgent Assistance Signal Broadcasted.');

renderRoute();
drawOverlay();
updateUI();
})();
