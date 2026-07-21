require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (servidor sigue corriendo):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (servidor sigue corriendo):', err);
});

// ---------- CONFIG ----------
const USERNAME = process.env.PORTAL_USER;
const PASSWORD = process.env.PORTAL_PASS;

const NIUS = JSON.parse(fs.readFileSync(path.join(__dirname, 'nius.json'), 'utf-8'));

// ---------- SHARED DATA: the uploaded Excel rows, visible to every device ----------
const SHARED_DATA_FILE = path.join(__dirname, 'shared-data.json');
let sharedRows = [];
try {
  if (fs.existsSync(SHARED_DATA_FILE)) {
    sharedRows = JSON.parse(fs.readFileSync(SHARED_DATA_FILE, 'utf-8'));
  }
} catch (e) {
  sharedRows = [];
}
function persistSharedRows() {
  fs.writeFile(SHARED_DATA_FILE, JSON.stringify(sharedRows), () => {}); // fire-and-forget
}

// ---------- SHARED CORTES: service-cutoff records, visible to every device ----------
const CORTES_FILE = path.join(__dirname, 'cortes.json');
let cortes = [];
try {
  if (fs.existsSync(CORTES_FILE)) {
    cortes = JSON.parse(fs.readFileSync(CORTES_FILE, 'utf-8'));
  }
} catch (e) {
  cortes = [];
}
function persistCortes() {
  fs.writeFile(CORTES_FILE, JSON.stringify(cortes), () => {});
}

// ---------- SHARED ROUTE-LINIERO ASSIGNMENTS ----------
const RUTA_LINIEROS_FILE = path.join(__dirname, 'ruta-linieros.json');
let rutaLinieros = {}; // { [ruta]: linieroName }
try {
  if (fs.existsSync(RUTA_LINIEROS_FILE)) {
    rutaLinieros = JSON.parse(fs.readFileSync(RUTA_LINIEROS_FILE, 'utf-8'));
  }
} catch (e) {
  rutaLinieros = {};
}
function persistRutaLinieros() {
  fs.writeFile(RUTA_LINIEROS_FILE, JSON.stringify(rutaLinieros), () => {});
}

// ---------- SHARED RESULTS: one status per NIU, visible to every device ----------
const SHARED_RESULTS_FILE = path.join(__dirname, 'shared-results.json');
let sharedResults = {}; // niu -> { pagado, ultimoPago, estadoPago, checkedAt }
try {
  if (fs.existsSync(SHARED_RESULTS_FILE)) {
    sharedResults = JSON.parse(fs.readFileSync(SHARED_RESULTS_FILE, 'utf-8'));
  }
} catch (e) {
  sharedResults = {};
}
function persistSharedResults() {
  fs.writeFile(SHARED_RESULTS_FILE, JSON.stringify(sharedResults), () => {}); // fire-and-forget
}
function recordSharedResult(niu, data) {
  sharedResults[niu] = { ...data, checkedAt: new Date().toISOString() };
  persistSharedResults();
}

// ---------- APEX BASE ----------
const APEX_BASE = 'https://appthunder.conoracle.com/ords';
const LOGIN_PAGE_URL = process.env.PORTAL_LOGIN_URL || `${APEX_BASE}/r/enerputu/facturas-eep/login`;

// ---------- Minimal cookie jar (Node's fetch has no built-in cookie jar) ----------
class CookieJar {
  constructor() { this.cookies = new Map(); }
  update(setCookieHeaders) {
    (setCookieHeaders || []).forEach((sc) => {
      const pair = sc.split(';')[0];
      const idx = pair.indexOf('=');
      if (idx > 0) this.cookies.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    });
  }
  header() {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

async function httpRequest(url, options, jar) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Cookie: jar.header(),
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers, redirect: 'manual' });
  if (typeof res.headers.getSetCookie === 'function') {
    jar.update(res.headers.getSetCookie());
  } else if (res.headers.raw) {
    jar.update(res.headers.raw()['set-cookie']);
  }
  return res;
}

// Follows redirects manually (so cookies set at each hop are captured), returns the final HTML body.
async function followAndGetHtml(res, jar) {
  let current = res;
  let hops = 0;
  while (current.status >= 300 && current.status < 400 && hops < 5) {
    const location = current.headers.get('location');
    if (!location) break;
    const nextUrl = new URL(location, APEX_BASE).toString();
    current = await httpRequest(nextUrl, { method: 'GET' }, jar);
    hops++;
  }
  return current.text();
}

// Parses the hidden APEX form fields out of any page (login or home) needed to submit forms.
function parsePageState(html) {
  const $ = cheerio.load(html);
  const state = {
    flowId: $('#pFlowId').attr('value'),
    flowStepId: $('#pFlowStepId').attr('value'),
    instance: $('#pInstance').attr('value'),
    submissionId: $('#pPageSubmissionId').attr('value'),
    protectedVal: $('#pPageItemsProtected').attr('value'),
    salt: $('#pSalt').attr('value'),
    context: $('#pContext').attr('value'),
  };
  // The popup LOV's ajaxIdentifier lives inside an inline <script>, e.g.
  // apex.widget.popupLov({"itemId":"P1_INFOCLIE","ajaxIdentifier":"XXXX", ...})
  const scriptText = $('script').map((i, el) => $(el).html()).get().join('\n');
  const m = scriptText.match(/"itemId":"P1_INFOCLIE","ajaxIdentifier":"([^"]+)"/);
  state.ajaxIdentifier = m ? m[1].replace(/\\\//g, '/') : null;
  return state;
}

async function httpLogin(jar) {
  let res = await httpRequest(LOGIN_PAGE_URL, { method: 'GET' }, jar);
  const loginHtml = await followAndGetHtml(res, jar);
  const state = parsePageState(loginHtml);

  const body = new URLSearchParams();
  body.set('p_flow_id', state.flowId);
  body.set('p_flow_step_id', state.flowStepId);
  body.set('p_instance', state.instance);
  body.set('p_request', 'LOGIN');
  body.set('p_reload_on_submit', 'S');
  body.set('p_page_submission_id', state.submissionId);
  body.set('p_json', JSON.stringify({
    pageItems: {
      itemsToSubmit: [
        { n: 'P9999_USERNAME', v: USERNAME },
        { n: 'P9999_PASSWORD', v: PASSWORD },
        { n: 'P9999_REMEMBER', v: 'N' },
      ],
      protected: state.protectedVal,
      rowVersion: '',
      formRegionChecksums: [],
    },
    salt: state.salt,
  }));

  const acceptUrl = `${APEX_BASE}/wwv_flow.accept?p_context=${encodeURIComponent(state.context)}`;
  res = await httpRequest(acceptUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
    body: body.toString(),
  }, jar);

  const homeHtml = await followAndGetHtml(res, jar);
  const homeState = parsePageState(homeHtml);
  if (!homeState.ajaxIdentifier) {
    throw new Error('Login no confirmado — el portal no devolvió la página esperada (¿usuario/contraseña incorrectos?)');
  }
  return homeState;
}

// Searches the NIU popup (AJAX), returns the internal record id APEX expects (not the NIU itself).
async function httpSearchNiu(jar, state, niu) {
  const body = new URLSearchParams();
  body.set('p_flow_id', state.flowId);
  body.set('p_flow_step_id', state.flowStepId);
  body.set('p_instance', state.instance);
  body.set('p_debug', '');
  body.set('p_json', JSON.stringify({
    regions: [{
      id: 'P1_INFOCLIE',
      ajaxIdentifier: state.ajaxIdentifier,
      fetchData: { search: String(niu), sortColumn: null, sortDirection: null, version: 1, firstRow: 1, maxRows: 100 },
    }],
    salt: state.salt,
  }));

  const url = `${APEX_BASE}/wwv_flow.ajax?p_context=${encodeURIComponent(state.context)}`;
  const res = await httpRequest(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
    body: body.toString(),
  }, jar);

  const json = await res.json();
  const values = json?.regions?.[0]?.fetchedData?.values || [];
  const match = values.find(([display]) => display && display.includes(`(${niu})`));
  return match ? { internalId: match[1], display: match[0] } : null;
}

// Submits "Consultar" for the selected internal id — the portal does a FULL page
// reload here (p_reload_on_submit=S), so the response is the entire results page.
async function httpConsultar(jar, state, internalId) {
  const body = new URLSearchParams();
  body.set('p_flow_id', state.flowId);
  body.set('p_flow_step_id', state.flowStepId);
  body.set('p_instance', state.instance);
  body.set('p_request', 'Consultar');
  body.set('p_reload_on_submit', 'S');
  body.set('p_page_submission_id', state.submissionId);
  body.set('p_json', JSON.stringify({
    pageItems: {
      itemsToSubmit: [{ n: 'P1_INFOCLIE', v: internalId }, { n: 'P1_FACTCONS', v: '' }],
      protected: state.protectedVal,
      rowVersion: '',
      formRegionChecksums: [],
    },
    salt: state.salt,
  }));

  const acceptUrl = `${APEX_BASE}/wwv_flow.accept?p_context=${encodeURIComponent(state.context)}`;
  const res = await httpRequest(acceptUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
    body: body.toString(),
  }, jar);

  const html = await followAndGetHtml(res, jar);
  return html; // caller re-parses page state from this + extracts the Pagos table
}

// Extracts the most recent row of the "Pagos" table from a results page's HTML.
function extractPagoInfo(html) {
  const $ = cheerio.load(html);
  const container = $('[id^="R1694343654926727037"][id$="_data_panel"]');
  if (container.length === 0) return { empty: true };
  const rows = container.find('tr').filter((i, el) => $(el).find('td').length > 0);
  if (rows.length === 0) return { empty: true };
  const cells = $(rows[0]).find('td');
  const cellText = (i) => (cells.eq(i).text() || '').trim();
  return {
    empty: false,
    fechaRegistroPago: cellText(0) || null, // "DD-MES-YYYY hh:mmAM/PM" — has the exact TIME
    estadoPago: cellText(1) || null,
    fechaPago: cellText(3) || null, // dd/mm/yyyy — date only
    observaciones: cellText(8) || null,
  };
}

function monthsEs() {
  return ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
}

function parseFechaPago(fechaStr) {
  // Expects "dd/mm/yyyy"
  if (!fechaStr) return null;
  const match = fechaStr.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  return { day: parseInt(match[1], 10), month: parseInt(match[2], 10) - 1, year: parseInt(match[3], 10) };
}

// Consults a single NIU using an already-logged-in session (jar + state).
// Returns the payment info, and the FRESH page state (salt/submissionId rotate
// on every full page load, so the caller must keep using the returned state).
async function checkNiuHttp(jar, state, niu) {
  const found = await httpSearchNiu(jar, state, niu);
  if (!found) {
    return { encontrado: false, empty: true, seleccionMostrada: 'NO ENCONTRADO en la búsqueda', state };
  }
  const html = await httpConsultar(jar, state, found.internalId);
  const newState = parsePageState(html);
  const pago = extractPagoInfo(html);
  return { encontrado: true, seleccionMostrada: found.display, ...pago, state: newState.ajaxIdentifier ? newState : state };
}

async function runScanJob(job, targetNius) {
  if (!USERNAME || !PASSWORD) {
    job.error = 'Faltan PORTAL_USER / PORTAL_PASS en las variables de entorno';
    return;
  }

  const jar = new CookieJar();
  let state;
  try {
    state = await httpLogin(jar);
  } catch (e) {
    job.error = 'No se pudo iniciar sesión: ' + e.message;
    return;
  }

  const now = new Date();

  for (const item of targetNius) {
    try {
      const r = await checkNiuHttp(jar, state, item.niu);
      state = r.state; // carry forward the rotated tokens for the next iteration
      const fecha = r.fechaPago ? parseFechaPago(r.fechaPago) : null;
      const pagado = !!(
        fecha &&
        fecha.year === now.getFullYear() &&
        fecha.month === now.getMonth() &&
        r.estadoPago &&
        r.estadoPago.toLowerCase().includes('aplicado')
      );
      job.results.push({
        niu: item.niu,
        nombre: item.nombre,
        direccion: item.direccion,
        ultimoPago: r.fechaPago || (r.empty ? 'Sin pagos registrados' : 'No disponible'),
        estadoPago: r.estadoPago || null,
        fechaRegistroPago: r.fechaRegistroPago || null,
        pagado,
        diagnostico_seleccion: r.seleccionMostrada || null,
      });
      recordSharedResult(item.niu, {
        pagado,
        ultimoPago: r.fechaPago || (r.empty ? 'Sin pagos registrados' : 'No disponible'),
        estadoPago: r.estadoPago || null,
        fechaRegistroPago: r.fechaRegistroPago || null,
      });
    } catch (e) {
      job.results.push({
        niu: item.niu,
        nombre: item.nombre,
        direccion: item.direccion,
        ultimoPago: 'ERROR: ' + e.message,
        pagado: false,
      });
    }
    job.progress++;
  }
}
// ---------- ROUTES ----------
app.post('/api/scan/start', (req, res) => {
  let targetList;
  let label;

  if (req.body && Array.isArray(req.body.nius) && req.body.nius.length > 0) {
    // Frontend sent an explicit list (usually extracted from an uploaded Excel)
    targetList = req.body.nius.map((n) => (typeof n === 'string' ? { niu: n } : n));
    label = req.body.ruta || `lista personalizada (${targetList.length})`;
  } else {
    // Backward-compatible fallback: filter the bundled nius.json by ruta
    const ruta = (req.body && req.body.ruta) || (req.query && req.query.ruta) || null;
    targetList = ruta ? NIUS.filter((n) => String(n.ruta) === String(ruta)) : NIUS;
    label = ruta || 'todas';
  }

  if (targetList.length === 0) return res.json({ ok: false, message: 'La lista de matriculas está vacía' });

  const jobId = createJob(targetList, label);
  const pos = queuePosition(jobId);
  const message = pos && pos > 1
    ? `En cola (posición ${pos}) — ${targetList.length} matriculas, alguien más está usando el servidor`
    : `Escaneo iniciado para ${targetList.length} matriculas`;

  res.json({ ok: true, jobId, message });
});

app.get('/api/scan/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job no encontrado (puede haber expirado)' });
  res.json({
    status: job.status,
    progress: job.progress,
    total: job.total,
    queuePosition: job.status === 'queued' ? queuePosition(job.id) : null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    error: job.error,
  });
});

app.get('/api/scan/results/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job no encontrado (puede haber expirado)' });
  res.json({ results: job.results, finishedAt: job.finishedAt, status: job.status, ruta: job.ruta });
});

app.get('/api/rutas', (req, res) => {
  const counts = {};
  NIUS.forEach((n) => { counts[n.ruta] = (counts[n.ruta] || 0) + 1; });
  const rutas = Object.keys(counts).sort((a, b) => Number(a) - Number(b)).map((r) => ({ ruta: r, cantidad: counts[r] }));
  res.json(rutas);
});

app.get('/api/data/rows', (req, res) => res.json({ rows: sharedRows }));

app.post('/api/data/rows', (req, res) => {
  if (!req.body || !Array.isArray(req.body.rows)) {
    return res.status(400).json({ ok: false, message: 'Se esperaba { rows: [...] }' });
  }
  // Merge by NIU: new data replaces old for matching NIUs (fresher saldo/atraso/etc),
  // brand-new NIUs get added, and rows not present in this upload are left untouched.
  const byNiu = {};
  sharedRows.forEach((r) => { byNiu[r.niu] = r; });
  let nuevos = 0;
  let actualizados = 0;
  req.body.rows.forEach((r) => {
    if (byNiu[r.niu]) actualizados++; else nuevos++;
    byNiu[r.niu] = r;
  });
  sharedRows = Object.values(byNiu);
  persistSharedRows();
  res.json({ ok: true, total: sharedRows.length, nuevos, actualizados });
});

app.get('/api/results', (req, res) => res.json({ results: sharedResults }));

app.get('/api/cortes', (req, res) => res.json({ cortes }));

app.post('/api/cortes', (req, res) => {
  const { niu, nombre, direccion, ruta, liniero, tipo, hora } = req.body || {};
  if (!niu || !liniero || !tipo) {
    return res.status(400).json({ ok: false, message: 'Se requiere niu, liniero y tipo' });
  }
  const now = new Date();
  // If the liniero specified a different time (reporting a cut that happened earlier
  // today), use today's date with that time; otherwise use the exact current moment.
  let fecha = now;
  if (hora) {
    const [h, m] = hora.split(':').map(Number);
    fecha = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0);
  }
  const record = {
    id: 'corte_' + now.getTime() + '_' + Math.random().toString(36).slice(2, 8),
    niu,
    nombre: nombre || null,
    direccion: direccion || null,
    ruta: ruta || null,
    liniero,
    tipo, // 'poste' | 'pin' | 'notificacion'
    fecha: fecha.toISOString(),
    subidoCortes: false,
  };
  cortes.push(record);
  persistCortes();
  res.json({ ok: true, record });
});

app.post('/api/cortes/:id/subido', (req, res) => {
  const record = cortes.find((c) => c.id === req.params.id);
  if (!record) return res.status(404).json({ ok: false, message: 'Corte no encontrado' });
  record.subidoCortes = true;
  persistCortes();
  res.json({ ok: true, record });
});

app.get('/api/rutas-linieros', (req, res) => res.json({ rutaLinieros }));

app.post('/api/rutas-linieros', (req, res) => {
  const { ruta, liniero } = req.body || {};
  if (!ruta) return res.status(400).json({ ok: false, message: 'Se requiere ruta' });
  rutaLinieros[ruta] = liniero || '';
  persistRutaLinieros();
  res.json({ ok: true, rutaLinieros });
});

app.get('/api/nius', (req, res) => res.json(NIUS));

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor corriendo en puerto ' + PORT));
