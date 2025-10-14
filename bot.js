// bot.js (Versión Completa con demoras)

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    getContentType,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { Boom } = require('@hapi/boom');
const express = require('express');
const qrcodePackage = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const scheduler = require('./googleSheetScheduler'); // Asegúrate que este archivo existe y es correcto

let activeQRCodes = {};
let sessionStatuses = {};

const sessionsConfig = [
    {
        id: 'jony_lager',
        name: 'Jony Lager',
        infoFilePath: path.join(__dirname, 'respuestas', 'jony_lager', 'info.txt'),
        photosFolderPath: path.join(__dirname, 'respuestas', 'jony_lager', 'fotos'),
        spreadsheetId: '1E-Vzmk-dPw4ko7C9uvpuVsp-mYxNio-33HaOmJvEM9A', // Ejemplo, reemplaza con tu ID real
        sheetNameAndRange: 'Hoja1!A:C', // Ejemplo, reemplaza con tu rango real
        dayLimitConfig: [ { limit: 5 }, { limit: 4 }, { limit: 2 } ], // Ejemplo
        schedulerWelcomeMessage: "🎉 Aquí tienes los horarios disponibles. Estas reservando una sesión que incluye 7 imagenes finales + 1 Porta Retrato 10x15, beneficio exclusivo para clientes nuevos:\n\n",
        schedulerBookingQuestion: "Solo reserva un horario si tienes seguridad de que asistiras, ¿Cuál de estos horarios te gustaría reservar?",
        schedulerNoSlotsMessage: "😢 ¡Vaya! Parece que por ahora no tenemos horarios disponibles. ¡Vuelve a consultarnos pronto! 🗓️✨",
        schedulerErrorMessage: "😕 ¡Oh no! Parece que tuve un problema al buscar los horarios."
    },
    {
        id: 'album_magico',
        name: 'Album Magico',
        infoFilePath: path.join(__dirname, 'respuestas', 'album_magico', 'info.txt'),
        photosFolderPath: path.join(__dirname, 'respuestas', 'album_magico', 'fotos'),
        spreadsheetId: '1DHQildo2Jewb6Ib9HgdcxS6VY_4Sx0Kg0GzHEUEONFU', // Ejemplo, reemplaza con tu ID real
        sheetNameAndRange: 'Hoja1!A:C', // Ejemplo, reemplaza con tu rango real
        dayLimitConfig: [ { limit: 5 }, { limit: 4 }, { limit: 2 } ], // Ejemplo
        schedulerWelcomeMessage: "🎉 ¡Claro que sí! 🎉 Aquí tienes los horarios que encontré especialmente para ti:\n\n",
        schedulerBookingQuestion: "📸 ¿Qué horario eliges para capturar tus momentos? ✨ ¡Espero tu elección!",
        schedulerNoSlotsMessage: "😥 Ups! Parece que todos nuestros horarios mágicos están ocupados por el momento. ¡Consulta más tarde! 🧚‍♀️",
        schedulerErrorMessage: "⚠️ ¡Ay! Hubo un pequeño duende travieso en el sistema de horarios."
    }
];

const infoKeywords = ["info", "recibida", "información", "informacion", "quiero saber"];
const schedulerKeywords = ["fdgdgdg", "hfhgfhfd"];

function normalizeText(text) {
    if (!text) return '';
    return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function containsInfoKeyword(messageText) {
    const normalizedMsg = normalizeText(messageText);
    return infoKeywords.some(keyword => normalizedMsg.includes(normalizeText(keyword)));
}

function containsSchedulerKeyword(messageText) {
    const normalizedMsg = normalizeText(messageText);
    return schedulerKeywords.some(keyword => normalizedMsg.includes(normalizeText(keyword)));
}

// añade esta import arriba:
const { fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');

const sessionLocks = new Map(); // evita dobles arranques
const sockets = new Map();      // para cerrar limpio

async function startSession(sessionConfig) {
  const sessionId = sessionConfig.id;
  if (sessionLocks.get(sessionId)) {
    console.log(`[${sessionConfig.name}] Ya hay un arranque en curso, omito.`);
    return;
  }
  sessionLocks.set(sessionId, true);

  const authFolderPath = path.join(__dirname, `baileys_auth_${sessionId}`);
  fs.mkdirSync(authFolderPath, { recursive: true });

  const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' });
  const backoff = (ms) => new Promise(r => setTimeout(r, ms));

  // bucle de vida de la sesión (sin recursión)
  while (true) {
    const { version } = await fetchLatestBaileysVersion(); // <- versión correcta
    const { state, saveCreds } = await useMultiFileAuthState(authFolderPath);

    sessionStatuses[sessionId] = 'Iniciando conexión... 🤔';
    console.log(`[${sessionConfig.name}] Iniciando sesión (ID: ${sessionId}). Carpeta de Auth: ${authFolderPath}`);

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: state,
      browser: [`Bot ${sessionConfig.name} (${sessionId})`, "Chrome", "Personalizado"],
      syncFullHistory: false,
    });

    sockets.set(sessionId, sock);
    sock.ev.on('creds.update', saveCreds);

    // --- QR & OPEN iguales a tu código (puedes dejarlos) ---
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        activeQRCodes[sessionId] = qr;
        sessionStatuses[sessionId] = '📱 Escanea el código QR con WhatsApp.';
        qrcodeTerminal.generate(qr, { small: true }, () => {});
      }

      if (connection === 'open') {
        activeQRCodes[sessionId] = null;
        sessionStatuses[sessionId] = 'Conectado ✅ ¡Listo para trabajar!';
        console.log(`[${sessionConfig.name}] Conexión abierta para ${sessionId}.`);
      }

      if (connection === 'close') {
        const err = lastDisconnect?.error;
        const statusCode =
          err instanceof Boom ? err.output?.statusCode : undefined;

        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const reasonText = DisconnectReason[statusCode] || statusCode || 'desconocida';

        console.log(`[${sessionConfig.name}] Conexión cerrada (${reasonText}).`);

        // Limpieza: quita listeners y cierra socket
        try { sock.ev.removeAllListeners(); } catch {}
        try { await sock.end?.(); } catch {}

        if (isLoggedOut) {
          // borrar auth para forzar nuevo pairing
          try {
            fs.rmSync(authFolderPath, { recursive: true, force: true });
            console.log(`[${sessionConfig.name}] Auth borrada. Requerirá nuevo QR.`);
          } catch (e) {
            console.warn(`[${sessionConfig.name}] No pude borrar auth:`, e?.message);
          }
          sessionStatuses[sessionId] = '⚠️ Sesión cerrada. Necesita escanear nuevo QR.';
          // pequeño backoff y reintenta (creará carpeta de nuevo)
          await backoff(3000);
        } else {
          sessionStatuses[sessionId] = `🔴 Desconectado (${reasonText}). Reintentando...`;
          // backoff exponencial básico
          await backoff(5000);
        }

        // sal del handler; el while(true) recreará una nueva instancia
      }
    });

    // --- Tus handlers de messages.upsert (igual que ya tienes) ---
    sock.ev.on('messages.upsert', async (m) => {
      // (pega aquí el cuerpo de tu handler actual sin cambios)
      // ...
    });

    // Espera pasiva: si este sock se cierra, el handler hará cleanup
    // y el while continuará creando otro; si no, duerme un poco.
    // Esto evita que el loop consuma CPU cuando está estable:
    while (sockets.get(sessionId) === sock) {
      await backoff(1000);
    }
  } // while

  // (si alguna vez saliera del while)
  sessionLocks.delete(sessionId);
}



// --- SERVIDOR WEB EXPRESS PARA MOSTRAR QR Y ESTADOS ---
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    let html = `
        <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Estado de Bots WhatsApp</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background-color: #eef2f7; color: #333; }
            .container { max-width: 800px; margin: 20px auto; background-color: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
            h1 { color: #2c3e50; text-align: center; margin-bottom: 30px; }
            ul { list-style-type: none; padding: 0; }
            li { background-color: #f8f9fa; margin-bottom: 12px; padding: 15px 20px; border-radius: 6px; border-left: 5px solid #007bff; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; }
            li div:first-child { flex-basis: 70%; }
            li div:last-child { flex-basis: 25%; text-align: right; }
            li strong { font-size: 1.1em; color: #34495e; }
            .status { font-weight: bold; padding: 5px 10px; border-radius: 4px; color: white; display: inline-block; margin-top: 5px;}
            .status-ok { background-color: #28a745; }
            .status-qr { background-color: #ffc107; color: #333; }
            .status-error { background-color: #dc3545; }
            .status-init { background-color: #6c757d; }
            a.qr-link { background-color: #007bff; color: white; padding: 8px 12px; border-radius: 4px; text-decoration: none; font-size: 0.9em; }
            a.qr-link:hover { background-color: #0056b3; }
            .footer { text-align: center; margin-top: 30px; font-size: 0.9em; color: #777; }
        </style>
        <meta http-equiv="refresh" content="10">
        </head><body><div class="container"><h1>Estado de Bots WhatsApp</h1><ul>
    `;
    if (sessionsConfig && sessionsConfig.length > 0) {
        sessionsConfig.forEach(session => {
            const statusMsg = sessionStatuses[session.id] || 'No Iniciado Aún';
            let statusClass = 'status-init';
            if (statusMsg.includes('Conectado')) statusClass = 'status-ok';
            else if (statusMsg.includes('Escanea') || statusMsg.includes('QR')) statusClass = 'status-qr';
            else if (statusMsg.includes('Desconectado') || statusMsg.includes('Sesión cerrada') || statusMsg.includes('Error')) statusClass = 'status-error';

            html += `<li>
                            <div>
                                <strong>${session.name}</strong> (ID: ${session.id})<br>
                                <span class="status ${statusClass}">${statusMsg}</span>
                            </div>
                            <div>
                                ${activeQRCodes[session.id] ? `<a href="/qr/${session.id}" class="qr-link" target="_blank">Ver QR</a>` : ''}
                            </div>
                           </li>`;
        });
    } else {
        html += "<li>No hay sesiones configuradas.</li>";
    }
    html += `</ul><div class="footer"><p>Esta página se refresca automáticamente cada 10 segundos.</p></div></div></body></html>`;
    res.send(html);
});

app.get('/qr/:sessionId', async (req, res) => {
    const sessionId = req.params.sessionId;
    const session = sessionsConfig.find(s => s.id === sessionId);
    const sessionName = session ? session.name : sessionId;
    const qrString = activeQRCodes[sessionId];

    let htmlResponse = `
        <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Código QR para ${sessionName}</title>
        <style>
            body { font-family: Arial, sans-serif; text-align: center; margin-top: 30px; background-color: #f0f0f0; }
            .qr-container { background-color: white; padding: 20px; border-radius: 8px; display: inline-block; box-shadow: 0 0 10px rgba(0,0,0,0.1); }
            img { display: block; margin: 15px auto; border: 1px solid #ccc; }
            textarea { width: 90%; max-width: 350px; margin-top: 10px; font-family: monospace; font-size: 0.8em; }
            p.status-msg { margin-top: 20px; font-size: 1.1em; }
            a { color: #007bff; text-decoration: none; margin-top:20px; display:inline-block;}
        </style>
        </head><body><div class="qr-container">
    `;

    if (qrString) {
        try {
            const qrImage = await qrcodePackage.toDataURL(qrString, { width: 280, margin: 2 });
            htmlResponse += `
                <h2>Código QR para ${sessionName}</h2>
                <p>Escanea este código con WhatsApp:</p>
                <img src="${qrImage}" alt="Código QR para ${sessionName}"/>
                <details><summary>Ver string del QR</summary><textarea rows="4" cols="35" readonly>${qrString}</textarea></details>
                <p class="status-msg" style="color: #E87500;">Este QR es temporal. La página se refrescará.</p>
                <script>setTimeout(() => window.location.reload(), 25000);</script>
            `;
        } catch (err) {
            console.error(`[WebQR] Error al generar imagen QR para ${sessionId}:`, err);
            htmlResponse += `<h2 style="color:red;">Error al generar QR</h2><p>Revisa la consola del bot.</p><script>setTimeout(() => window.location.reload(), 10000);</script>`;
        }
    } else {
        const status = sessionStatuses[sessionId] || 'Intentando conectar o ya conectado.';
        htmlResponse += `
            <h2>Código QR para ${sessionName}</h2>
            <p class="status-msg" style="color: #0056b3;">No hay un código QR activo en este momento.</p>
            <p>Estado Actual: <strong>${status}</strong></p>
            <p style="color: grey; font-size: small;">Esta página se refrescará en 10 segundos.</p>
            <script>setTimeout(() => window.location.reload(), 10000);</script>
        `;
    }
    htmlResponse += `<br><a href="/">Volver al listado de sesiones</a></div></body></html>`;
    res.send(htmlResponse);
});


// --- Ejecución Principal ---
async function main() {
    console.log("Iniciando todos los bots de WhatsApp...");
    if (!sessionsConfig || sessionsConfig.length === 0) {
        console.error("No hay sesiones configuradas en 'sessionsConfig'. El bot no se iniciará.");
        return;
    }

    for (const config of sessionsConfig) {
        if (!sessionStatuses[config.id]) {
            sessionStatuses[config.id] = 'Pendiente de inicio...';
        }
        try {
            await startSession(config);
        } catch (error) {
            console.error(`[${config.name || 'Sesión Desconocida'}] Fallo CRÍTICO al intentar iniciar la sesión:`, error);
            sessionStatuses[config.id] = `Error Crítico al Iniciar ❌`;
        }
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Servidor web para QR y estados escuchando en http://localhost:${PORT} (o la URL pública si se despliega)`);
        console.log(`Accede a los QR en: /qr/<session_id> (ej. /qr/jony_lager)`);
        console.log(`Página de estado principal en: /`);
    });

    console.log("Proceso de inicio de sesiones Baileys lanzado.");
    console.log("El servidor web está corriendo para mostrar los QR y estados.");
}

main().catch(err => {
    console.error("Error FATAL en la ejecución principal del bot (main):", err);
    process.exit(1);
});