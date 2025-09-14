// googleSheetScheduler.js
const { google } = require('googleapis');
const path = require('path');

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

let auth;
// Credenciales: primero variable de entorno GOOGLE_CREDENTIALS (JSON string), si no, credentials.json local
if (process.env.GOOGLE_CREDENTIALS) {
  console.log('[Scheduler] Usando credenciales desde GOOGLE_CREDENTIALS');
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key.replace(/\\n/g, '\n'),
    SCOPES
  );
} else {
  const KEYFILEPATH = path.join(__dirname, 'credentials.json');
  console.log(`[Scheduler] Usando credenciales desde archivo: ${KEYFILEPATH}`);
  auth = new google.auth.GoogleAuth({
    keyFile: KEYFILEPATH,
    scopes: SCOPES,
  });
}

/**
 * Selecciona M índices aproximadamente equiespaciados de un array de longitud N (incluye primero y último).
 * Si M >= N, devuelve todos.
 */
function pickEvenly(times, M) {
  const N = times.length;
  if (M >= N) return [...times];

  const step = (N - 1) / (M - 1);
  const chosen = [];
  const used = new Set();

  for (let j = 0; j < M; j++) {
    let idx = Math.round(j * step);
    if (idx < 0) idx = 0;
    if (idx > N - 1) idx = N - 1;
    if (!used.has(idx)) {
      used.add(idx);
      chosen.push(times[idx]);
    }
  }

  // Si por redondeos quedaron menos de M, completar con los no usados en orden
  for (let i = 0; chosen.length < M && i < N; i++) {
    if (!used.has(i)) {
      used.add(i);
      chosen.push(times[i]);
    }
  }
  return chosen;
}

/**
 * Obtiene los días y horarios disponibles desde una Google Spreadsheet específica.
 * Solo devuelve los primeros 3 días con la lógica: [4, 4, 3] slots por día.
 * @param {string} spreadsheetId
 * @param {string} sheetRange  Ej. 'Hoja1!A:C'
 * @returns {Promise<Array<{day: string, slots: string[]}> | {error: string, details?: string}>}
 */
async function getAvailableSlots(spreadsheetId, sheetRange) {
  console.log(`[Scheduler] getAvailableSlots -> sheet: ${spreadsheetId}, range: ${sheetRange}`);

  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: sheetRange,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      console.log('[Scheduler] No hay filas en el rango.');
      return [];
    }

    // Construir estructura { day, availableTimes[] } leyendo columna A (día), B (hora), C (cliente/estado)
    const orderedDaysData = [];
    const dayMap = new Map();
    let currentDay = null;

    rows.forEach((row, idx) => {
      const dayFromCell = (row[0] || '').toString().trim();  // Col A
      const time = (row[1] || '').toString().trim();         // Col B
      const status = (row[2] || '').toString().trim();       // Col C (ocupado si NO está vacío)

      if (dayFromCell) currentDay = dayFromCell;
      const hasDay = currentDay && currentDay.trim() !== '';
      const hasTime = time !== '';

      if (hasDay && hasTime) {
        const isFree = status === ''; // libre solo si la columna C está vacía
        if (isFree) {
          if (!dayMap.has(currentDay)) {
            const obj = { day: currentDay, availableTimes: [] };
            dayMap.set(currentDay, obj);
            orderedDaysData.push(obj); // mantiene el orden de aparición
          }
          dayMap.get(currentDay).availableTimes.push(time);
        }
      }
    });

    if (orderedDaysData.length === 0) {
      console.log('[Scheduler] No hay horarios libres.');
      return [];
    }

    // Aplicar tu lógica: Día1→4, Día2→4, Día3→3 (si hay menos, mostrar los que haya)
    const perDayTargets = [4, 4, 3];
    const result = [];

    for (let i = 0; i < Math.min(3, orderedDaysData.length); i++) {
      const { day, availableTimes } = orderedDaysData[i];

      if (!Array.isArray(availableTimes) || availableTimes.length === 0) continue;

      const target = perDayTargets[i]; // 4, 4, 3
      const chosen = pickEvenly(availableTimes, target);

      if (chosen.length > 0) {
        result.push({ day, slots: chosen });
      }
    }

    console.log('[Scheduler] Resultado:', JSON.stringify(result));
    return result;

  } catch (err) {
    console.error('[Scheduler] Error en getAvailableSlots:', err);
    return { error: 'Error Interno del Scheduler', details: err.message || String(err) };
  }
}

module.exports = { getAvailableSlots };
