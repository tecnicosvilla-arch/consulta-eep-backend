require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (servidor sigue corriendo):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (servidor sigue corriendo):', err);
});

// ---------- CONFIG ----------
// nius.json sigue siendo un archivo estático incluido en el backend — nunca se
// escribe desde la app.
const NIUS = JSON.parse(fs.readFileSync(path.join(__dirname, 'nius.json'), 'utf-8'));

// ---------- STATE: cola de jobs (solo UNA sesión HTTP corre a la vez, el resto se encola) ----------
let jobs = {}; // jobId -> job object
let queue = []; // array de { jobId, targetNius }
let processingQueue = false;

function makeJobId() {
  return 'job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function pruneOldJobs() {
  const ids = Object.keys(jobs).filter((id) => jobs[id].status === 'done' || jobs[id].status === 'error');
  if (ids.length > 25) {
    ids
      .sort((a, b) => new Date(jobs[a].finishedAt || 0) - new Date(jobs[b].finishedAt || 0))
      .slice(0, ids.length - 25)
      .forEach((id) => delete jobs[id]);
  }
}

function createJob(targetNius, label, credenciales) {
  const jobId = makeJobId();
  jobs[jobId] = {
    credenciales, // solo en memoria; se descarta al terminar el escaneo
    id: jobId,
    status: 'queued',
    progress: 0,
    total: targetNius.length,
    results: [],
    queuedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
    ruta: label || 'todas',
  };
  queue.push({ jobId, targetNius });
  processQueue();
  pruneOldJobs();
  return jobId;
}

function queuePosition(jobId) {
  const idx = queue.findIndex((q) => q.jobId === jobId);
  return idx === -1 ? null : idx + 1;
}

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;
  while (queue.length > 0) {
    const { jobId, targetNius } = queue.shift();
    const job = jobs[jobId];
    if (!job) continue;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    await runScanJob(job, targetNius);
    delete job.credenciales;
    job.status = job.error ? 'error' : 'done';
    job.finishedAt = new Date().toISOString();
  }
  processingQueue = false;
}

// ---------- APEX BASE ----------
const APEX_BASE = 'https://appthunder.conoracle.com/ords';
const LOGIN_PAGE_URL = process.env.PORTAL_LOGIN_URL || `${APEX_BASE}/r/enerputu/facturas-eep/login`;
const HOME_PAGE_URL_BASE = `${APEX_BASE}/r/enerputu/facturas-eep/home`;

// ---------- Minimal cookie jar (Node's fetch has no built-in cookie jar) ----------
class CookieJar {
  constructor() { this.cookies = []; }
  update(setCookieHeaders) {
    (setCookieHeaders || []).forEach((sc) => {
      const parts = sc.split(';').map((s) => s.trim());
      const idx = parts[0].indexOf('=');
      if (idx <= 0) return;
      const name = parts[0].slice(0, idx);
      const value = parts[0].slice(idx + 1);
      let cpath = '/';
      parts.slice(1).forEach((p) => {
        if (p.toLowerCase().startsWith('path=')) cpath = p.slice(5);
      });
      this.cookies = this.cookies.filter((c) => !(c.name === name && c.path === cpath));
      this.cookies.push({ name, value, path: cpath });
    });
  }
  header() {
    return this.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

async function httpRequest(url, options, jar) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    Referer: 'https://appthunder.conoracle.com/',
    Origin: 'https://appthunder.conoracle.com',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'sec-ch-ua': '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
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

function decodeJsString(raw) {
  try {
    return JSON.parse('"' + raw + '"');
  } catch (e) {
    return raw.replace(/\\\//g, '/').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
}

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
  const scriptText = $('script').map((i, el) => $(el).html()).get().join('\n');
  const m = scriptText.match(/"itemId":"P1_INFOCLIE","ajaxIdentifier":"([^"]+)"/);
  state.ajaxIdentifier = m ? decodeJsString(m[1]) : null;
  const userMatch = scriptText.match(/APP_USER:\s*"([^"]+)"/);
  state.appUser = userMatch ? userMatch[1] : null;
  return state;
}

async function httpLogin(jar, { usuario: USERNAME, clave: PASSWORD }) {
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

  if (res.status >= 400) {
    const errText = await res.text().catch(() => '');
    throw new Error(`El portal respondió ${res.status} al enviar el login. ${errText.slice(0, 200)}`);
  }

  const homeUrl = `${HOME_PAGE_URL_BASE}?session=${state.instance}`;
  const homeRes = await httpRequest(homeUrl, { method: 'GET' }, jar);
  const homeHtml = await followAndGetHtml(homeRes, jar);
  const homeState = parsePageState(homeHtml);

  if (!homeState.ajaxIdentifier || homeState.appUser === 'nobody' || !homeState.appUser) {
    const looksLikeLoginPage = /P9999_USERNAME/.test(homeHtml);
    if (looksLikeLoginPage || homeState.appUser === 'nobody') {
      throw new Error(`El portal no nos reconoce como autenticados (APP_USER="${homeState.appUser}") — revisa las credenciales (botón 🔑).`);
    }
    throw new Error('Login no confirmado — el portal no devolvió la página esperada (revisa la respuesta cruda si esto persiste).');
  }
  return homeState;
}

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

  const homeUrl = `${HOME_PAGE_URL_BASE}?session=${state.instance}`;
  const homeRes = await httpRequest(homeUrl, { method: 'GET' }, jar);
  const html = await followAndGetHtml(homeRes, jar);
  return html;
}

function extractPagoInfo(html) {
  const $ = cheerio.load(html);
  const container = $('[id^="R1694343654926727037"][id$="_data_panel"]');
  if (container.length === 0) return { empty: true };
  const rows = container.find('tr').filter((i, el) => $(el).find('td').length > 0);
  if (rows.length === 0) return { empty: true };
  const cells = $(rows[0]).find('td');
  const cellText = (i) => (cells.eq(i).text() || '').trim();
  const observaciones = cellText(8) || null;
  const facturaMatch = observaciones ? observaciones.match(/Pago Factura:\s*(\d+)/i) : null;
  return {
    empty: false,
    fechaRegistroPago: cellText(0) || null,
    estadoPago: cellText(1) || null,
    tipoPago: cellText(2) || null,
    fechaPago: cellText(3) || null,
    valorPagado: cellText(4) || null,
    medioPago: cellText(5) || null,
    entidadRecaudo: cellText(6) || null,
    numeroCuenta: cellText(7) || null,
    observaciones,
    numeroFactura: facturaMatch ? facturaMatch[1] : null,
  };
}

function monthsEs() {
  return ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
}

function parseFechaPago(fechaStr) {
  if (!fechaStr) return null;
  const match = fechaStr.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  return { day: parseInt(match[1], 10), month: parseInt(match[2], 10) - 1, year: parseInt(match[3], 10) };
}

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
  const cred = job.credenciales;
  if (!cred || !cred.usuario || !cred.clave) {
    job.error = 'Faltan las credenciales del portal — configúralas con el botón 🔑';
    return;
  }

  const jar = new CookieJar();
  let state;
  try {
    state = await httpLogin(jar, cred);
  } catch (e) {
    job.error = 'No se pudo iniciar sesión: ' + e.message;
    return;
  }

  const now = new Date();

  for (const item of targetNius) {
    try {
      const r = await checkNiuHttp(jar, state, item.niu);
      state = r.state;
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
        valorPagado: r.valorPagado || null,
        medioPago: r.medioPago || null,
        entidadRecaudo: r.entidadRecaudo || null,
        numeroCuenta: r.numeroCuenta || null,
        numeroFactura: r.numeroFactura || null,
        pagado,
        diagnostico_seleccion: r.seleccionMostrada || null,
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
    targetList = req.body.nius.map((n) => (typeof n === 'string' ? { niu: n } : n));
    label = req.body.ruta || `lista personalizada (${targetList.length})`;
  } else {
    const ruta = (req.body && req.body.ruta) || (req.query && req.query.ruta) || null;
    targetList = ruta ? NIUS.filter((n) => String(n.ruta) === String(ruta)) : NIUS;
    label = ruta || 'todas';
  }

  if (targetList.length === 0) return res.json({ ok: false, message: 'La lista de matriculas está vacía' });

  const jobId = createJob(targetList, label, req.body && req.body.credenciales);
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

app.get('/api/nius', (req, res) => res.json(NIUS));

app.get('/health', (req, res) => res.json({ ok: true }));

// Middleware de errores
app.use((err, req, res, next) => {
  console.error('Error en la petición:', err);
  res.status(500).json({ ok: false, message: 'Error interno: ' + err.message });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor corriendo en puerto ' + PORT));