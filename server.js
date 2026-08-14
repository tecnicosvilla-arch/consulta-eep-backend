require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

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
const USERNAME = process.env.PORTAL_USER;
const PASSWORD = process.env.PORTAL_PASS;

// nius.json sigue siendo un archivo estático incluido en el backend — nunca se
// escribe desde la app, así que no necesita vivir en Supabase.
const NIUS = JSON.parse(fs.readFileSync(path.join(__dirname, 'nius.json'), 'utf-8'));

// ---------- SUPABASE ----------
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
  console.error('Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en las variables de entorno');
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  realtime: { transport: ws },
});

// Envuelve una ruta async: si la promesa falla, el error llega al middleware
// de errores en vez de dejar la petición colgada (Express 4 no captura esto solo).
function ah(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- SHARED DATA: el listado del Excel subido, visible en todos los dispositivos ----------
// Tabla Supabase: shared_rows(niu text, fecha date, data jsonb, updated_at) — PK (niu, fecha)
// Cada archivo subido queda como su propia "foto" del día (mismos NIU en distintos
// días NO se sobreescriben entre sí — solo se sobreescribe si es el mismo día).
async function getSharedRows() {
  const { data, error } = await supabase.from('shared_rows').select('niu, fecha, data');
  if (error) throw error;
  // La columna `fecha` (date) manda sobre lo que pueda traer data.fecha, por si acaso.
  return (data || []).map((r) => ({ ...r.data, niu: r.niu, fecha: r.fecha }));
}
async function upsertSharedRows(rows, fecha) {
  if (rows.length === 0) return;
  const records = rows.map((r) => ({
    niu: r.niu,
    fecha,
    data: { ...r, fecha },
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabase.from('shared_rows').upsert(records, { onConflict: 'niu,fecha' });
  if (error) throw error;
}
// El teléfono/celular es un dato "pegado" al NIU en general (no cambia por día),
// así que se actualiza en TODAS las filas (todas las fechas) que existan de ese NIU.
async function updateTelefono(niu, telefono, celular) {
  const { data, error } = await supabase.from('shared_rows').select('fecha, data').eq('niu', niu);
  if (error) throw error;
  if (!data || data.length === 0) throw new Error('NIU no encontrado en el listado');
  const clean = (v) => (v && !/^0+$/.test(v) ? v : null);
  const updates = data.map((row) => {
    const merged = { ...row.data };
    if (telefono !== undefined) merged.telefono = clean(telefono);
    if (celular !== undefined) merged.celular = clean(celular);
    return { niu, fecha: row.fecha, data: merged, updated_at: new Date().toISOString() };
  });
  const { error: upErr } = await supabase.from('shared_rows').upsert(updates, { onConflict: 'niu,fecha' });
  if (upErr) throw upErr;
  return updates[0] ? updates[0].data : null;
}
async function deleteAllSharedRows() {
  const { error } = await supabase.from('shared_rows').delete().neq('niu', '__never__');
  if (error) throw error;
}

// ---------- SHARED CORTES: registros de suspensión de servicio ----------
// Tabla Supabase: cortes(id text PK, niu, nombre, direccion, ruta, liniero, tipo, fecha, subido_cortes)
function mapCorteFromDb(row) {
  return {
    id: row.id,
    niu: row.niu,
    nombre: row.nombre,
    direccion: row.direccion,
    ruta: row.ruta,
    liniero: row.liniero,
    tipo: row.tipo,
    fecha: row.fecha,
    subidoCortes: row.subido_cortes,
  };
}
async function getCortes() {
  const { data, error } = await supabase.from('cortes').select('*').order('fecha', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapCorteFromDb);
}
async function insertCorte(record) {
  const { error } = await supabase.from('cortes').insert({
    id: record.id,
    niu: record.niu,
    nombre: record.nombre,
    direccion: record.direccion,
    ruta: record.ruta,
    liniero: record.liniero,
    tipo: record.tipo,
    fecha: record.fecha,
    subido_cortes: false,
  });
  if (error) throw error;
}
async function marcarCorteSubido(id) {
  const { data, error } = await supabase
    .from('cortes')
    .update({ subido_cortes: true })
    .eq('id', id)
    .select()
    .maybeSingle();
  if (error) throw error;
  return data ? mapCorteFromDb(data) : null;
}

// ---------- ASIGNACIÓN RUTA -> LINIERO ----------
// Tabla Supabase: ruta_linieros(ruta text PK, liniero)
async function getRutaLinieros() {
  const { data, error } = await supabase.from('ruta_linieros').select('*');
  if (error) throw error;
  const obj = {};
  (data || []).forEach((r) => { obj[r.ruta] = r.liniero; });
  return obj;
}
async function setRutaLiniero(ruta, liniero) {
  const { error } = await supabase.from('ruta_linieros').upsert({ ruta, liniero }, { onConflict: 'ruta' });
  if (error) throw error;
}

// ---------- SHARED RESULTS: un estado de pago por NIU (real, confirmado en el portal) ----------
// Tabla Supabase: shared_results(niu text PK, data jsonb, checked_at)
async function getSharedResults() {
  const { data, error } = await supabase.from('shared_results').select('niu, data');
  if (error) throw error;
  const obj = {};
  (data || []).forEach((r) => { obj[r.niu] = r.data; });
  return obj;
}
async function recordSharedResult(niu, resultData) {
  const payload = { ...resultData, checkedAt: new Date().toISOString() };
  const { error } = await supabase
    .from('shared_results')
    .upsert({ niu, data: payload, checked_at: payload.checkedAt }, { onConflict: 'niu' });
  if (error) throw error;
  // Si el portal ya confirmó el pago real, la marca manual "pagado sin confirmar"
  // (si existía) ya no hace falta — se limpia sola.
  if (resultData.pagado) {
    await deletePagoManual(niu).catch((e) => console.error('No se pudo limpiar pago manual de', niu, e));
  }
}
async function deleteAllSharedResults() {
  const { error } = await supabase.from('shared_results').delete().neq('niu', '__never__');
  if (error) throw error;
}

// ---------- PAGOS MANUALES: "el cliente me mostró que ya pagó" pero el portal aún no lo refleja ----------
// Tabla Supabase: pagos_manuales(niu text PK, liniero, fecha timestamptz)
// Global por NIU (no por día) — se limpia sola cuando el escaneo real confirma el pago.
async function getPagosManuales() {
  const { data, error } = await supabase.from('pagos_manuales').select('*');
  if (error) throw error;
  const obj = {};
  (data || []).forEach((r) => { obj[r.niu] = { liniero: r.liniero, fecha: r.fecha }; });
  return obj;
}
async function setPagoManual(niu, liniero) {
  const { error } = await supabase
    .from('pagos_manuales')
    .upsert({ niu, liniero: liniero || null, fecha: new Date().toISOString() }, { onConflict: 'niu' });
  if (error) throw error;
}
async function deletePagoManual(niu) {
  const { error } = await supabase.from('pagos_manuales').delete().eq('niu', niu);
  if (error) throw error;
}
async function deleteAllPagosManuales() {
  const { error } = await supabase.from('pagos_manuales').delete().neq('niu', '__never__');
  if (error) throw error;
}

// ---------- SHARED COMPARTIDOS: comprobantes ya compartidos ----------
// Tabla Supabase: compartidos(id bigint identity PK, niu, numero_factura, liniero, fecha)
async function getCompartidos() {
  const { data, error } = await supabase.from('compartidos').select('*').order('fecha', { ascending: true });
  if (error) throw error;
  return (data || []).map((r) => ({ niu: r.niu, numeroFactura: r.numero_factura, liniero: r.liniero, fecha: r.fecha }));
}
async function insertCompartido(record) {
  const { error } = await supabase.from('compartidos').insert({
    niu: record.niu,
    numero_factura: record.numeroFactura,
    liniero: record.liniero,
    fecha: record.fecha,
  });
  if (error) throw error;
}

// ---------- CICLO MENSUAL: el listado + resultados se reinician cada mes ----------
// Tabla Supabase: month_tracker(id int PK = 1, month text) — una sola fila
async function getDataMonth() {
  const { data, error } = await supabase.from('month_tracker').select('month').eq('id', 1).maybeSingle();
  if (error) throw error;
  return data ? data.month : null;
}
async function setDataMonth(month) {
  const { error } = await supabase.from('month_tracker').upsert({ id: 1, month }, { onConflict: 'id' });
  if (error) throw error;
}
function currentMonthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
async function resetMonthlyData() {
  await Promise.all([deleteAllSharedRows(), deleteAllSharedResults(), deleteAllPagosManuales()]);
}
async function checkMonthRollover() {
  const now = currentMonthKey();
  const dataMonth = await getDataMonth();
  if (dataMonth === now) return;
  // Primera vez que corre (no hay fila en month_tracker todavía): solo registra
  // el mes sin borrar nada — evita reiniciar datos reales solo porque el
  // servidor se desplegó a mitad de mes.
  if (dataMonth !== null) {
    await resetMonthlyData();
  }
  await setDataMonth(now);
}

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

function createJob(targetNius, label) {
  const jobId = makeJobId();
  jobs[jobId] = {
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
      throw new Error(`El portal no nos reconoce como autenticados (APP_USER="${homeState.appUser}") — revisa PORTAL_USER / PORTAL_PASS en las variables de entorno.`);
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
      await recordSharedResult(item.niu, {
        pagado,
        ultimoPago: r.fechaPago || (r.empty ? 'Sin pagos registrados' : 'No disponible'),
        estadoPago: r.estadoPago || null,
        fechaRegistroPago: r.fechaRegistroPago || null,
        valorPagado: r.valorPagado || null,
        medioPago: r.medioPago || null,
        entidadRecaudo: r.entidadRecaudo || null,
        numeroCuenta: r.numeroCuenta || null,
        numeroFactura: r.numeroFactura || null,
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

app.post('/api/reset-mes', ah(async (req, res) => {
  await resetMonthlyData();
  await setDataMonth(currentMonthKey());
  res.json({ ok: true, message: 'Listado y resultados de pago reiniciados. Los reportes de meses anteriores se conservan.' });
}));

app.get('/api/data/rows', ah(async (req, res) => {
  await checkMonthRollover();
  const rows = await getSharedRows();
  res.json({ rows });
}));

app.post('/api/data/telefono', ah(async (req, res) => {
  const { niu, telefono, celular } = req.body || {};
  if (!niu) return res.status(400).json({ ok: false, message: 'Se requiere niu' });
  const row = await updateTelefono(niu, telefono, celular);
  res.json({ ok: true, row });
}));

app.post('/api/data/rows', ah(async (req, res) => {
  await checkMonthRollover();
  if (!req.body || !Array.isArray(req.body.rows)) {
    return res.status(400).json({ ok: false, message: 'Se esperaba { rows: [...] }' });
  }
  // La fecha viene del nombre del archivo (extraída en el frontend). Si no llega
  // por algún motivo, se usa hoy como respaldo.
  const fecha = req.body.fecha || todayIso();

  const allExisting = await getSharedRows();
  // "Última versión conocida" de cada NIU (sin importar el día) — de ahí se
  // hereda el teléfono/celular si el archivo nuevo no lo trae.
  const latestByNiu = {};
  allExisting.forEach((r) => {
    if (!latestByNiu[r.niu] || r.fecha > latestByNiu[r.niu].fecha) latestByNiu[r.niu] = r;
  });
  // Filas que YA existían para este mismo día (para el conteo nuevos/actualizados)
  const existingForThisDate = new Set(allExisting.filter((r) => r.fecha === fecha).map((r) => r.niu));

  let nuevos = 0;
  let actualizados = 0;
  const mergedRows = req.body.rows.map((r) => {
    if (existingForThisDate.has(r.niu)) actualizados++; else nuevos++;
    const merged = { ...r, fecha };
    const carry = latestByNiu[r.niu];
    if (!merged.telefono && carry && carry.telefono) merged.telefono = carry.telefono;
    if (!merged.celular && carry && carry.celular) merged.celular = carry.celular;
    return merged;
  });

  await upsertSharedRows(mergedRows, fecha);

  const totalNiusUnicos = new Set([...Object.keys(latestByNiu), ...mergedRows.map((r) => r.niu)]).size;
  res.json({ ok: true, total: totalNiusUnicos, nuevos, actualizados, fecha });
}));

app.get('/api/results', ah(async (req, res) => {
  await checkMonthRollover();
  const results = await getSharedResults();
  res.json({ results });
}));

app.get('/api/pagos-manuales', ah(async (req, res) => {
  const pagosManuales = await getPagosManuales();
  res.json({ pagosManuales });
}));

app.post('/api/pagos-manuales', ah(async (req, res) => {
  const { niu, liniero } = req.body || {};
  if (!niu) return res.status(400).json({ ok: false, message: 'Se requiere niu' });
  await setPagoManual(niu, liniero);
  res.json({ ok: true });
}));

app.delete('/api/pagos-manuales/:niu', ah(async (req, res) => {
  await deletePagoManual(req.params.niu);
  res.json({ ok: true });
}));

app.get('/api/cortes', ah(async (req, res) => {
  await checkMonthRollover();
  const list = await getCortes();
  res.json({ cortes: list });
}));

app.post('/api/cortes', ah(async (req, res) => {
  await checkMonthRollover();
  const { niu, nombre, direccion, ruta, liniero, tipo, hora } = req.body || {};
  if (!niu || !liniero || !tipo) {
    return res.status(400).json({ ok: false, message: 'Se requiere niu, liniero y tipo' });
  }
  const now = new Date();
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
    tipo,
    fecha: fecha.toISOString(),
    subidoCortes: false,
  };
  await insertCorte(record);
  res.json({ ok: true, record });
}));

app.post('/api/cortes/:id/subido', ah(async (req, res) => {
  const record = await marcarCorteSubido(req.params.id);
  if (!record) return res.status(404).json({ ok: false, message: 'Corte no encontrado' });
  res.json({ ok: true, record });
}));

app.get('/api/rutas-linieros', ah(async (req, res) => {
  const rutaLinieros = await getRutaLinieros();
  res.json({ rutaLinieros });
}));

app.post('/api/rutas-linieros', ah(async (req, res) => {
  const { ruta, liniero } = req.body || {};
  if (!ruta) return res.status(400).json({ ok: false, message: 'Se requiere ruta' });
  await setRutaLiniero(ruta, liniero || '');
  const rutaLinieros = await getRutaLinieros();
  res.json({ ok: true, rutaLinieros });
}));

app.get('/api/rutas', (req, res) => {
  const counts = {};
  NIUS.forEach((n) => { counts[n.ruta] = (counts[n.ruta] || 0) + 1; });
  const rutas = Object.keys(counts).sort((a, b) => Number(a) - Number(b)).map((r) => ({ ruta: r, cantidad: counts[r] }));
  res.json(rutas);
});

app.get('/api/nius', (req, res) => res.json(NIUS));

app.get('/api/compartidos', ah(async (req, res) => {
  await checkMonthRollover();
  const list = await getCompartidos();
  res.json({ compartidos: list });
}));

app.post('/api/compartidos', ah(async (req, res) => {
  await checkMonthRollover();
  const { niu, numeroFactura, liniero } = req.body || {};
  if (!niu) return res.status(400).json({ ok: false, message: 'Se requiere niu' });
  const record = { niu, numeroFactura: numeroFactura || null, liniero: liniero || null, fecha: new Date().toISOString() };
  await insertCompartido(record);
  res.json({ ok: true, record });
}));

app.get('/health', (req, res) => res.json({ ok: true }));

// Middleware de errores — captura cualquier fallo de las rutas envueltas en ah(...)
app.use((err, req, res, next) => {
  console.error('Error en la petición:', err);
  res.status(500).json({ ok: false, message: 'Error interno: ' + err.message });
});

checkMonthRollover().catch((err) => console.error('Error verificando el mes al iniciar:', err));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Servidor corriendo en puerto ' + PORT));