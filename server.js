require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
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
const LOGIN_URL = process.env.PORTAL_LOGIN_URL ||
  'https://appthunder.conoracle.com/ords/r/enerputu/facturas-eep/login';
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

// Element IDs taken directly from the real page HTML (confirm if the portal changes)
const SEL = {
  loginUser: '#P9999_USERNAME',
  loginPass: '#P9999_PASSWORD',
  loginBtn: '#B1694315956165633214',
  lovBtn: '#P1_INFOCLIE_lov_btn',
  consultarBtn: '#B1683296795905620921',
};

// ---------- STATE: job queue (only ONE Chromium runs at a time, everyone else queues) ----------
let jobs = {}; // jobId -> job object
let queue = []; // array of { jobId, targetNius }
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

// Consults a single NIU using the already-logged-in page.
// NOTE: the popup LOV dialog markup is generated dynamically by APEX and could
// not be inspected/tested ahead of time (no live access to the authenticated
// portal). If this breaks, open the popup manually in Chrome DevTools and
// adjust the selectors below (searchInput / firstResult).
async function checkNiu(page, niu) {
  await page.click(SEL.lovBtn);
  await page.waitForSelector('input.a-PopupLOV-search', { timeout: 8000 });
  const searchInput = await page.$('input.a-PopupLOV-search');
  await searchInput.click();
  await searchInput.fill(''); // clear any leftover text
  await searchInput.type(String(niu), { delay: 80 }); // real keystrokes to trigger incremental search
  await page.waitForTimeout(1200); // debounce + AJAX round trip

  // Match the exact NIU inside the highlighted span, e.g. "Nombre (202545)"
  const items = await page.$$('li.a-IconList-item');
  let matched = null;
  for (const li of items) {
    const text = await li.textContent();
    if (text && text.includes(`(${niu})`)) {
      matched = li;
      break;
    }
  }

  if (!matched) {
    await page.keyboard.press('Escape').catch(() => {});
    return { encontrado: false, periodo: null, seleccionMostrada: `NO ENCONTRADO — ${items.length} resultados en la lista, ninguno coincidió` };
  }
  await matched.click();
  await page.waitForTimeout(400);

  // DIAGNOSTIC: capture what the visible field actually shows after selecting.
  // If this is empty or doesn't contain the NIU, the click on the popup item
  // is not registering with the framework, and that's the real bug.
  const seleccionMostrada = await page.$eval('#P1_INFOCLIE', (el) => el.value).catch(() => '(no se pudo leer)');

  // The portal does a FULL page reload on "Consultar" (p_reload_on_submit=S in
  // its form), not an AJAX partial refresh — must wait for navigation, or the
  // page context gets destroyed mid-read.
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }),
    page.click(SEL.consultarBtn),
  ]);

  const result = await page.evaluate(() => {
    const container = document.querySelector('[id^="R1694343654926727037"][id$="_data_panel"]');
    if (!container) return { empty: true, foundContainer: false };
    const rows = Array.from(container.querySelectorAll('tr')).filter((r) => r.querySelector('td'));
    if (rows.length === 0) return { empty: true, foundContainer: true };
    const cells = rows[0].querySelectorAll('td');
    return {
      empty: false,
      foundContainer: true,
      fechaRegistroPago: cells[0] ? cells[0].textContent.trim() : null, // format "DD-MES-YYYY hh:mmAM/PM" — has the exact TIME
      estadoPago: cells[1] ? cells[1].textContent.trim() : null,
      fechaPago: cells[3] ? cells[3].textContent.trim() : null, // format dd/mm/yyyy — date only, no time
      observaciones: cells[8] ? cells[8].textContent.trim() : null,
    };
  });

  return {
    encontrado: true,
    seleccionMostrada,
    empty: result.empty,
    fechaRegistroPago: result.fechaRegistroPago || null,
    estadoPago: result.estadoPago || null,
    fechaPago: result.fechaPago || null,
    observaciones: result.observaciones || null,
  };
}

async function runScanJob(job, targetNius) {
  if (!USERNAME || !PASSWORD) {
    job.error = 'Faltan PORTAL_USER / PORTAL_PASS en las variables de entorno';
    return;
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  } catch (e) {
    job.error = 'No se pudo abrir el navegador: ' + e.message;
    return;
  }

  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });
    await page.fill(SEL.loginUser, USERNAME);
    await page.fill(SEL.loginPass, PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle' }),
      page.click(SEL.loginBtn),
    ]);

    const now = new Date();

    for (const item of targetNius) {
      try {
        const r = await checkNiu(page, item.niu);
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
  } catch (e) {
    job.error = e.message;
  } finally {
    await browser.close();
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
