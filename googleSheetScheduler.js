// googleSheetScheduler.js
const { google } = require('googleapis');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

let auth;
// 1) Credenciales: primero GOOGLE_CREDENTIALS (JSON string), si no, credentials.json local.
if (process.env.GOOGLE_CREDENTIALS) {
  console.log('[Scheduler] Usando credenciales desde GOOGLE_CREDENTIALS');
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  auth = new google.auth.GoogleAuth({ credentials: creds, scopes: SCOPES });
} else {
  const KEYFILEPATH = path.join(__dirname, 'credentials.json');
  console.log(`[Scheduler] Usando credenciales desde archivo: ${KEYFILEPATH}`);
  auth = new google.auth.GoogleAuth({ keyFile: KEYFILEPATH, scopes: SCOPES });
}

/** Convierte "H[:MM]" (1..12) a minutos del día, asumiendo 9–12 = AM y 1–8 = PM (13..20). */
function toDayMinutes12h(t) {
  if (!t) return Number.POSITIVE_INFINITY;
  const [hStr, mStr = '0'] = t.toString().trim().split(':');
  let h = parseInt(hStr, 10);
  let m = parseInt(mStr, 10);
  if (Number.isNaN(h)) h = 0;
  if (Number.isNaN(m)) m = 0;
  // Mapear 1..8 → 13..20 (tarde), 9..12 se quedan (mañana/mediodía).
  if (h >= 1 && h <= 8) h += 12;
  return h * 60 + m;
}

/** Selecciona M elementos aproximadamente equiespaciados (incluye primero y último). */
function pickEvenly(arr, M) {
  const N = arr.length;
  if (M >= N) return [...arr];

  const step = (N - 1) / (M - 1);
  const chosen = [];
  const used = new Set();

  for (let j = 0; j < M; j++) {
    let idx = Math.round(j * step);
    if (idx < 0) idx = 0;
    if (idx > N - 1) idx = N - 1;
    if (!used.has(idx)) {
      used.add(idx);
      chosen.push(arr[idx]);
    }
  }
  // Completar si por redondeo faltó alguno
  for (let i = 0; chosen.length < M && i < N; i++) {
    if (!used.has(i)) {
      used.add(i);
      chosen.push(arr[i]);
    }
  }
  return chosen;
}

/**
 * Lee A:C. A = día (puede venir vacío; se arrastra el último), B = hora ("1..12[:MM]"), C = estado/cliente.
 * Solo considera libre si C está vacío. Devuelve hasta 3 días con slots según lógica [4,4,3].
 * @param {string} spreadsheetId
 * @param {string} sheetRange  p.ej. 'Hoja1!A:C'
 * @returns {Promise<Array<{day: string, slots: string[]}> | {error: string, details?: string}>}
 */
async function getAvailableSlots(spreadsheetId, sheetRange) {
  console.log(`[Scheduler] getAvailableSlots -> sheet: ${spreadsheetId}, range: ${sheetRange}`);
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetRange });
    const rows = data.values;
    if (!rows || rows.length === 0) return [];

    // Construir estructura { day, availableTimes[] }
    const orderedDaysData = [];
    const dayMap = new Map();
    let currentDay = null;

    rows.forEach((row) => {
      const dayCell = (row?.[0] || '').toString().trim();   // Col A
      const timeCell = (row?.[1] || '').toString().trim();  // Col B
      const status   = (row?.[2] || '').toString().trim();  // Col C (ocupado si NO está vacío)

      if (dayCell) currentDay = dayCell;
      const hasDay = !!(currentDay && currentDay.trim());
      const hasTime = !!timeCell;
      const isFree = status === ''; // Libre solo si C está vacío

      if (hasDay && hasTime && isFree) {
        if (!dayMap.has(currentDay)) {
          const obj = { day: currentDay, availableTimes: [] };
          dayMap.set(currentDay, obj);
          orderedDaysData.push(obj); // conservar orden
        }
        dayMap.get(currentDay).availableTimes.push(timeCell);
      }
    });

    if (orderedDaysData.length === 0) return [];

    // Ordenar horas y seleccionar con lógica 4,4,3
    const perDayTargets = [4, 4, 3];
    const result = [];

    for (let i = 0; i < Math.min(3, orderedDaysData.length); i++) {
      const { day, availableTimes } = orderedDaysData[i];
      if (!Array.isArray(availableTimes) || availableTimes.length === 0) continue;

      // Normalizar: quitar falsy, trim, quitar duplicados preservando orden
      const seen = new Set();
      const cleaned = [];
      for (const t of availableTimes) {
        const s = t?.toString().trim();
        if (!s) continue;
        if (!seen.has(s)) { seen.add(s); cleaned.push(s); }
      }
      if (cleaned.length === 0) continue;

      // Orden correcto: 9..12 (AM) luego 1..8 (PM)
      const sorted = cleaned.sort((a, b) => toDayMinutes12h(a) - toDayMinutes12h(b));

      const target = perDayTargets[i]; // 4, 4, 3
      const chosen = pickEvenly(sorted, target);

      if (chosen.length > 0) {
        result.push({ day, slots: chosen });
      }
    }

    return result;
  } catch (err) {
    console.error('[Scheduler] Error en getAvailableSlots:', err);
    return { error: 'Error Interno del Scheduler', details: err.message || String(err) };
  }
}

module.exports = { getAvailableSlots };
