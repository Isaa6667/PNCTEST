(() => {
'use strict';

const $ = (s, el = document) => el.querySelector(s); const $$ = (s, el = document) => [...el.querySelectorAll(s)];
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
  confirmReads: 2,
  minConf: 50,
  centreOnly: true,
  scanWidth: 1280,
  speedLimit: 30,
  sound: true,
  vibrate: true,
  thumbs: true,
  retain: 800,
  facing: 'environment',
  dvlaApiKey: '',
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

/* UK number plate regex and validation */
const CURRENT = /^[A-HJ-PR-WY][A-Z]\d{2}[A-HJ-PR-Z]{3}$/;
const PREFIX = /^[A-HJ-NPR-TV-Y]\d{1,3}[A-HJ-PR-Z]{3}$/;
const SUFFIX = /^[A-HJ-PR-Z]{3}\d{1,3}[A-HJ-NPR-TV-Y]$/;
const TO_L = { '0': 'O', '1': 'I', '5': 'S', '8': 'B', '2': 'Z', '6': 'G' };
const TO_D = { O: '0', Q: '0', D: '0', I: '1', L: '1', Z: '2', S: '5', B: '8', G: '6' };
const REGION = {
  A: 'Anglia', B: 'Birmingham', C: 'Cymru (Wales)', D: 'Deeside', E: 'Essex', F: 'Forest',
  G: 'Kent', H: 'Hampshire', K: 'Milton Keynes', L: 'London', M: 'Manchester',
  N: 'North', O: 'Oxford', P: 'Preston', R: 'Reading', S: 'Scotland', V: 'Severn', W: 'West', Y: 'Yorkshire'
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
    return { format: 'Current (2001+)', year, region: REGION[p[0]] || 'UK Office', memory: p.slice(0, 2) };
  }
  return { format: 'Legacy Format', year: null, region: 'UK', memory: null };
}
function validPlate(p) {
  return !!plateFormat(p);
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

/* Vehicle record engine & Live DVLA VES API */
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
  Ford: ['Fiesta', 'Focus', 'Transit', 'Puma'], Vauxhall: ['Corsa', 'Astra', 'Mokka'],
  Volkswagen: ['Golf', 'Polo', 'Passat'], BMW: ['1 Series', '3 Series', '5 Series'],
  Audi: ['A3', 'A4', 'Q3'], Toyota: ['Yaris', 'Corolla', 'RAV4'], Nissan: ['Qashqai', 'Juke'],
  Honda: ['Civic', 'Jazz'], 'Mercedes-Benz': ['A-Class', 'C-Class'], Kia: ['Sportage', 'Ceed'],
  Tesla: ['Model 3', 'Model Y']
};
const COLOURS = ['BLACK', 'WHITE', 'SILVER', 'GREY', 'BLUE', 'RED', 'GREEN', 'ORANGE'];
const recCache = new Map();

function generateFictionalRecord(plate) {
  const rng = mulberry32(xmur3(plate));
  const info = plateInfo(plate);
  const now = new Date();
  const make = pick(rng, Object.keys(MAKES));
  const model = pick(rng, MAKES[make]);
  const year = info.year ?? 2012 + Math.floor(rng() * 10);
  
  const rec = {
    registrationNumber: plate,
    make: make.toUpperCase(),
    model: model.toUpperCase(),
    colour: pick(rng, COLOURS),
    yearOfManufacture: year,
    fuelType: pick(rng, ['PETROL', 'DIESEL', 'HYBRID', 'ELECTRIC']),
    engineCapacity: 1200 + Math.floor(rng() * 10) * 100,
    co2Emissions: 110 + Math.floor(rng() * 60),
    info,
    isRealDvlaData: false
  };

  const rt = rng();
  rec.taxStatus = rt < 0.9 ? 'Taxed' : 'Untaxed';
  rec.taxDueDate = addMonths(now, 1 + Math.floor(rng() * 10)).toISOString().slice(0, 10);
  rec.motStatus = rng() < 0.88 ? 'Valid' : 'Expired';
  rec.motExp = addMonths(now, 1 + Math.floor(rng() * 10)).toISOString().slice(0, 10);
  rec.insurance = rng() < 0.95 ? 'Insured' : 'No insurance on MID';
  rec.marker = rng() < 0.02 ? 'Vehicle of interest (marker)' : null;

  return rec;
}

async function fetchDvlaRecord(plate) {
  if (!settings.dvlaApiKey) return null;
  const endpoint = settings.dvlaProxyUrl || 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'x-api-key': settings.dvlaApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ registrationNumber: plate })
    });
    if (res.ok) {
      const data = await res.json();
      data.isRealDvlaData = true;
      data.insurance = 'Insured';
      data.marker = null;
      data.info = plateInfo(plate);
      return data;
    }
  } catch (err) {
    console.warn('DVLA API connection error:', err);
  }
  return null;
}

function getRecord(plate) {
  if (recCache.has(plate)) return recCache.get(plate);
  const fictional = generateFictionalRecord(plate);
  recCache.set(plate, fictional);
  if (settings.dvlaApiKey) {
    fetchDvlaRecord(plate).then(real => {
      if (real) { recCache.set(plate, real); S.dirty = true; schedulePageRefresh(plate); }
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
  if (hl) flags.push({ t: 'Watchlist: ' + (hl.note || 'Hotlist match'), sev: 'alert' });
  if (rec.taxStatus === 'Untaxed') flags.push({ t: 'Untaxed', sev: 'warn' });
  if (rec.motStatus === 'Expired') flags.push({ t: 'MOT Expired', sev: 'warn' });

  const sev = flags.some
