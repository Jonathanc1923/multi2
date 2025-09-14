// googleSheetScheduler.js
const { google } = require('googleapis');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

let auth;
if (process.env.GOOGLE_CREDENTIALS) {
  console.log('[Scheduler] Usando credenciales desde GOOGLE_CREDENTIALS');
  const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS || '{}');
  // por si vienen con "\n" literales:
  if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
  auth = new google.auth.GoogleAuth({ credentials: creds, scopes: SCOPES });
} else {
  const KEYFILEPATH = path.join(__dirname, 'credentials.json');
  console.log(`[Scheduler] Usando credenciales desde archivo: ${KEYFILEPATH}`);
  auth = new google.auth.GoogleAuth({ keyFile: KEYFILEPATH, scopes: SCOPES });
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
  for (let i = 0; chosen.length < M && i < N; i++) {
    if (!used.has(i)) {
      used.add(i);
      chosen.push(arr[i]);
    }
  }
  return chosen;
}

/**
 * Lee A:C. A = día (puede estar vacío; se “arrastra” el último día visto),
 * B = hora, C = estado/cliente (ocupado si NO está vacío).
 * Devuelve hasta 3 días con slots según lógica [4,4,3].
 */
async function getAvailableSlots(spreadsheetId, sheetRange) {
  console.log(`[Scheduler] getAvailableSlots -> sheet: ${spreadsheetId}, range: ${sheetRange}`);
  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const { data } = await sheets.spreadsheets.values.get({ spreadsheetId, range: sheetRange });
    const rows = data.values;
    if (!rows || rows.length === 0) return [];

    const orderedDaysData = [];
    const dayMap = new Map();
    let currentDay = null;

    rows.forEach((row) => {
      const dayCell = (row[0] || '').toString().trim();   // Col A
      const time = (row[1] || '').toString().trim();      // Col B
      const status = (row[2] || '').toString().trim();    // Col C

      if (dayCell) currentDay = dayCell;
      const hasDay = currentDay && currentDay.trim() !== '';
      const hasTime = time !== '';
      const isFree = status === ''; // libre solo si C está vacío

      if (hasDay && hasTime && isFree) {
        if (!dayMap.has(currentDay)) {
          const obj = { day: currentDay, availableTimes: [] };
          dayMap.set(currentDay, obj);
          orderedDaysData.push(obj);
        }
        dayMap.get(currentDay).availableTimes.push(time);
      }
    });

    if (orderedDaysData.length === 0) return [];

    const perDayTargets = [4, 4, 3];
    const result = [];

    for (let i = 0; i < Math.min(3, orderedDaysData.length); i++) {
      const { day, availableTimes } = orderedDaysData[i];
      if (!availableTimes || availableTimes.length === 0) continue;

      // Ordenar HH:MM por si están mezcladas
      const sorted = [...availableTimes].sort((a, b) => {
        const [hA, mA] = a.split(':').map(Number);
        const [hB, mB] = b.split(':').map(Number);
        return hA === hB ? mA - mB : hA - hB;
      });

      const target = perDayTargets[i]; // 4, 4, 3
      const chosen = pickEvenly(sorted, target);
      if (chosen.length > 0) result.push({ day, slots: chosen });
    }

    return result;
  } catch (err) {
    console.error('[Scheduler] Error en getAvailableSlots:', err);
    return { error: 'Error Interno del Scheduler', details: err.message || String(err) };
  }
}

module.exports = { getAvailableSlots };
