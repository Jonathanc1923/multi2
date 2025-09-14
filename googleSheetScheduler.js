// googleSheetScheduler.js
import { google } from "googleapis";
import fs from "fs";

const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

let auth;

// ===========================
// Inicializar credenciales
// ===========================
if (process.env.GOOGLE_CREDENTIALS) {
  // Render u otro server con variable de entorno
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);

  auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key.replace(/\\n/g, "\n"), // convierte los \n en saltos reales
    SCOPES
  );
} else if (fs.existsSync("credentials.json")) {
  // Local con archivo
  const credentials = JSON.parse(fs.readFileSync("credentials.json", "utf8"));

  auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    SCOPES
  );
} else {
  throw new Error("No se encontraron credenciales de Google (ni variable ni archivo)");
}

const sheets = google.sheets({ version: "v4", auth });

// ===========================
// Función para obtener horarios
// ===========================
export async function getAvailableSlots(spreadsheetId, range, limitPerDay = 3) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range,
    });

    const rows = res.data.values || [];
    if (!rows.length) return [];

    // Suponemos formato: [ Día, Hora, Cliente ]
    const grouped = {};

    for (const row of rows) {
      const [day, hour, client] = row;

      if (!day || !hour) continue;

      if (!grouped[day]) grouped[day] = [];
      // Solo mostrar horarios libres (sin cliente asignado)
      if (!client || client.trim() === "") {
        grouped[day].push(hour);
      }
    }

    // Aplicar límite de horarios por día
    const result = Object.entries(grouped).map(([day, hours]) => {
      hours.sort(); // ordenar horas
      if (hours.length > limitPerDay) {
        // Seleccionar primero, último y algunos intermedios
        const first = hours[0];
        const last = hours[hours.length - 1];
        const middle = hours[Math.floor(hours.length / 2)];
        return { day, slots: [first, middle, last] };
      } else {
        return { day, slots: hours };
      }
    });

    return result;
  } catch (err) {
    console.error("Error leyendo Google Sheets:", err.message);
    return [];
  }
}
