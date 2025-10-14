// bot.js — versión robusta (Render + Baileys)
// Requisitos: @whiskeysockets/baileys, express, pino, @hapi/boom, qrcode, qrcode-terminal

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  getContentType,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { Boom } = require('@hapi/boom');
const express = require('express');
const qrcodePackage = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const scheduler = require('./googleSheetScheduler'); // Asegúrate de tener este módulo

// ====================== ESTADO GLOBAL ======================
const AUTH_BASE = process.env.AUTH_BASE || '/data'; // monta un Persistent Disk en /data (Render)
let activeQRCodes = {};       // sessionId -> string QR
let sessionStatuses = {};     // sessionId -> estado legible
const sessionLocks = new Map(); // evita arranques duplicados por sesión
const sockets = new Map();      // sessionId -> socket activo

// ====================== CONFIGURACIÓN DE SESIONES ======================
const sessionsConfig = [
  {
    id: 'jony_lager',
    name: 'Jony Lager',
    infoFilePath: path.join(__dirname, 'respuestas', 'jony_lager', 'info.txt'),
    photosFolderPath: path.join(__dirname, 'respuestas', 'jony_lager', 'fotos'),
    spreadsheetId: '1E-Vzmk-dPw4ko7C9uvpuVsp-mYxNio-33HaOmJvEM9A',
    sheetNameAndRange: 'Hoja1!A:C',
    dayLimitConfig: [{ limit: 5 }, { limit: 4 }, { limit: 2 }],
    schedulerWelcomeMessage:
      "🎉 Aquí tienes los horarios disponibles. Estas reservando una sesión que incluye 7 imágenes finales + 1 Porta Retrato 10x15, beneficio exclusivo para clientes nuevos:\n\n",
    schedulerBookingQuestion:
      "Solo reserva un horario si tienes seguridad de que asistirás, ¿Cuál de estos horarios te gustaría reservar?",
    schedulerNoSlotsMessage:
      "😢 ¡Vaya! Parece que por ahora no tenemos horarios disponibles. ¡Vuelve a consultarnos pronto! 🗓️✨",
    schedulerErrorMessage:
      "😕 ¡Oh no! Parece que tuve un problema al buscar los horarios.",
  },
  {
    id: 'album_magico',
    name: 'Album Magico',
    infoFilePath: path.join(__dirname, 'respuestas', 'album_magico', 'info.txt'),
    photosFolderPath: path.join(__dirname, 'respuestas', 'album_magico', 'fotos'),
    spreadsheetId: '1DHQildo2Jewb6Ib9HgdcxS6VY_4Sx0Kg0GzHEUEONFU',
    sheetNameAndRange: 'Hoja1!A:C',
    dayLimitConfig: [{ limit: 5 }, { limit: 4 }, { limit: 2 }],
    schedulerWelcomeMessage:
      "🎉 ¡Claro que sí! 🎉 Aquí tienes los horarios que encontré especialmente para ti:\n\n",
    schedulerBookingQuestion:
      "📸 ¿Qué horario eliges para capturar tus momentos? ✨ ¡Espero tu elección!",
    schedulerNoSlotsMessage:
      "😥 ¡Ups! Parece que todos nuestros horarios mágicos están ocupados por el momento. ¡Consulta más tarde! 🧚‍♀️",
    schedulerErrorMessage:
      "⚠️ ¡Ay! Hubo un pequeño duende travieso en el sistema de horarios.",
  },
];

// ====================== HELPERS DE TEXTO ======================
const infoKeywords = ['info', 'recibida', 'información', 'informacion', 'quiero saber'];
const schedulerKeywords = ['fdgdgdg', 'hfhgfhfd']; // reemplaza por tus triggers reales

function normalizeText(text) {
  if (!text) return '';
  return text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function containsInfoKeyword(messageText) {
  const t = normalizeText(messageText);
  return infoKeywords.some(k => t.includes(normalizeText(k)));
}
function containsSchedulerKeyword(messageText) {
  const t = normalizeText(messageText);
  return schedulerKeywords.some(k => t.includes(normalizeText(k)));
}

// ====================== LÓGICA DE SESIÓN (RECONEXIÓN NO BLOQUEANTE) ======================
async function startSession(sessionConfig) {
  const sessionId = sessionConfig.id;
  const sessionName = sessionConfig.name;

  if (sessionLocks.get(sessionId)) {
    console.log(`[${sessionName}] Ya hay un arranque en curso, omito.`);
    return;
  }
  sessionLocks.set(sessionId, true);

  const authFolderPath = path.join(AUTH_BASE, `baileys_auth_${sessionId}`);
  fs.mkdirSync(authFolderPath, { recursive: true });

  const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' });
  let authState = await useMultiFileAuthState(authFolderPath);
  const { version } = await fetchLatestBaileysVersion();

  sessionStatuses[sessionId] = 'Iniciando conexión... 🤔';
  console.log(
    `[${sessionName}] Iniciando sesión (ID: ${sessionId}). Auth: ${authFolderPath}. WA ver: ${version?.join('.')}`
  );

  let reconnectTimer = null;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const clearReconnectTimer = () => { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; } };

  const connect = async (delayMs = 0) => {
    clearReconnectTimer();
    if (delayMs) await sleep(delayMs);

    const sock = makeWASocket({
      version,
      logger,
      printQRInTerminal: false,
      auth: authState.state,
      browser: [`Bot ${sessionName} (${sessionId})`, 'Chrome', 'Personalizado'],
      syncFullHistory: false,
    });

    sockets.set(sessionId, sock);
    sock.ev.on('creds.update', authState.saveCreds);

    // ----- Eventos de conexión -----
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        activeQRCodes[sessionId] = qr;
        sessionStatuses[sessionId] = '📱 Escanea el código QR con WhatsApp.';
        console.log(`[${sessionName}] QR listo para ${sessionId}.`);
        try { qrcodeTerminal.generate(qr, { small: true }); } catch {}
      }

      if (connection === 'open') {
        activeQRCodes[sessionId] = null;
        sessionStatuses[sessionId] = 'Conectado ✅ ¡Listo para trabajar!';
        console.log(`[${sessionName}] Conexión abierta (${sessionId}).`);
      }

      if (connection === 'close') {
        const err = lastDisconnect?.error;
        const statusCode = err instanceof Boom ? err.output?.statusCode : err?.statusCode;
        const reasonText = DisconnectReason[statusCode] || statusCode || 'desconocida';
        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;

        console.log(`[${sessionName}] Conexión cerrada (${sessionId}). Razón: ${reasonText} (${statusCode}).`);

        // Limpieza del socket actual
        try { sock.ev.removeAllListeners(); } catch {}
        try { await sock.end?.(); } catch {}
        sockets.delete(sessionId);

        if (isLoggedOut) {
          // Forzar nuevo QR: limpiar auth y regenerar estado
          try {
            fs.rmSync(authFolderPath, { recursive: true, force: true });
            console.log(`[${sessionName}] Auth eliminada. Se requerirá nuevo QR.`);
          } catch (e) {
            console.warn(`[${sessionName}] No pude borrar auth: ${e?.message}`);
          }
          authState = await useMultiFileAuthState(authFolderPath);
          sessionStatuses[sessionId] = '⚠️ Sesión cerrada. Escanea un nuevo QR.';
          reconnectTimer = setTimeout(() => connect(0), 3000);
        } else {
          sessionStatuses[sessionId] = `🔴 Desconectado (${reasonText}). Reintentando...`;
          reconnectTimer = setTimeout(() => connect(0), 5000);
        }
      }
    });

    // ----- Mensajes entrantes -----
    sock.ev.on('messages.upsert', async (m) => {
      try {
        if (!m.messages || m.messages.length === 0) return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;

        const type = getContentType(msg.message);
        let receivedText = '';
        if (type === 'conversation') receivedText = msg.message.conversation;
        else if (type === 'extendedTextMessage') receivedText = msg.message.extendedTextMessage.text;

        if (!receivedText) return;

        const remoteJid = msg.key.remoteJid;
        console.log(`[${sessionName}] Mensaje de ${remoteJid}: "${receivedText}"`);

        // ---------- Scheduler ----------
        if (sessionConfig.spreadsheetId && sessionConfig.sheetNameAndRange && containsSchedulerKeyword(receivedText)) {
          console.log(`[${sessionName}] Trigger horario para ${remoteJid}. Sheet: ${sessionConfig.spreadsheetId}`);
          try {
            try { await sock.sendPresenceUpdate('composing', remoteJid); } catch {}
            const slots = await scheduler.getAvailableSlots(
              sessionConfig.spreadsheetId,
              sessionConfig.sheetNameAndRange,
              sessionConfig.dayLimitConfig
            );

            const welcomeMsg = sessionConfig.schedulerWelcomeMessage || 'Horarios disponibles:\n\n';
            const bookingQuestion = sessionConfig.schedulerBookingQuestion || '¿Cuál te gustaría reservar?';
            const noSlotsMsg = sessionConfig.schedulerNoSlotsMessage || 'No hay horarios disponibles.';
            const errorMsgBase = sessionConfig.schedulerErrorMessage || 'Error al buscar horarios.';
            let responseText = '';

            if (slots?.error) {
              responseText = `${errorMsgBase} Detalles: ${slots.details}.`;
            } else if (!slots || slots.length === 0) {
              responseText = noSlotsMsg;
            } else {
              responseText = welcomeMsg;
              slots.forEach((dayInfo = {}) => {
                const dayLabel = (dayInfo.day ?? '').toString();
                const dl = dayLabel.toLowerCase();
                let icon = '🗓️';
                if (dl.includes('lunes')) icon = '✅';
                else if (dl.includes('martes')) icon = '✅';
                else if (dl.includes('miércoles') || dl.includes('miercoles')) icon = '✅';
                else if (dl.includes('jueves')) icon = '✅';
                else if (dl.includes('viernes')) icon = '✅';
                else if (dl.includes('sábado') || dl.includes('sabado')) icon = '✅';
                else if (dl.includes('domingo')) icon = '✅';

                const times = Array.isArray(dayInfo.slots)
                  ? dayInfo.slots
                  : (Array.isArray(dayInfo.availableTimes) ? dayInfo.availableTimes : []);
                if (!times.length) return;

                responseText += `${icon} *${dayLabel}*:\n`;
                times.forEach(t => { responseText += `   🕒  \`${t}\`\n`; });
                responseText += '\n';
              });

              if (responseText.trim() === welcomeMsg.trim()) {
                responseText = noSlotsMsg;
              } else {
                responseText += bookingQuestion;
              }
            }

            await sleep(10000);
            try { await sock.sendPresenceUpdate('paused', remoteJid); } catch {}
            await sock.sendMessage(remoteJid, { text: responseText });
            console.log(`[${sessionName}] Horarios enviados a ${remoteJid}`);
          } catch (e) {
            try { await sock.sendPresenceUpdate('paused', remoteJid); } catch {}
            console.error(`[${sessionName}] Error horarios ${remoteJid}:`, e);
            const msgErr = sessionConfig.schedulerErrorMessage || 'Error inesperado.';
            await sock.sendMessage(remoteJid, { text: `${msgErr} Intenta de nuevo.` });
          }
          return;
        }

        // ---------- Info + Fotos ----------
        if (containsInfoKeyword(receivedText)) {
          console.log(`[${sessionName}] Trigger INFO para ${remoteJid}.`);
          try {
            try { await sock.sendPresenceUpdate('composing', remoteJid); } catch {}
            await sleep(10000);
            try { await sock.sendPresenceUpdate('paused', remoteJid); } catch {}

            const infoPath = sessionConfig.infoFilePath;
            if (fs.existsSync(infoPath)) {
              const infoText = fs.readFileSync(infoPath, 'utf-8');
              await sock.sendMessage(remoteJid, { text: infoText });
              console.log(`[${sessionName}] INFO enviada a ${remoteJid}.`);
            } else {
              console.warn(`[${sessionName}] Info no encontrada: ${infoPath}`);
              await sock.sendMessage(remoteJid, { text: `Lo siento, no pude encontrar la información solicitada para ${sessionName}.` });
            }

            const photosPath = sessionConfig.photosFolderPath;
            if (fs.existsSync(photosPath)) {
              const files = fs.readdirSync(photosPath);
              const images = files.filter(f => /\.(jpe?g|png)$/i.test(f));
              if (images.length) console.log(`[${sessionName}] Enviando ${images.length} foto(s) a ${remoteJid}.`);
              for (const img of images) {
                const imgPath = path.join(photosPath, img);
                try {
                  await sock.sendMessage(remoteJid, { image: { url: imgPath } });
                } catch (e) {
                  console.warn(`[${sessionName}] Falló envío de imagen ${img}: ${e?.message}`);
                }
                await sleep(1000);
              }
            } else {
              console.warn(`[${sessionName}] Carpeta fotos no encontrada: ${photosPath}`);
            }
          } catch (e) {
            try { await sock.sendPresenceUpdate('paused', remoteJid); } catch {}
            console.error(`[${sessionName}] Error INFO ${remoteJid}:`, e);
            await sock.sendMessage(remoteJid, { text: 'Hubo un error al procesar tu solicitud de información. Por favor, intenta más tarde.' });
          }
          return;
        }
      } catch (e) {
        console.error(`[${sessionName}] Error en messages.upsert:`, e);
      }
    });
  };

  // Disparo inicial (sin bloquear)
  connect(0);
}

// ====================== SERVIDOR WEB (Render necesita puerto abierto) ======================
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  let html = `
  <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Estado de Bots WhatsApp</title>
  <style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background-color: #eef2f7; color: #333; }
    .container { max-width: 900px; margin: 20px auto; background-color: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
    h1 { color: #2c3e50; text-align: center; margin-bottom: 30px; }
    ul { list-style-type: none; padding: 0; }
    li { background-color: #f8f9fa; margin-bottom: 12px; padding: 15px 20px; border-radius: 6px; border-left: 5px solid #007bff; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; }
    li div:first-child { flex-basis: 70%; }
    li div:last-child { flex-basis: 25%; text-align: right; }
    li strong { font-size: 1.1em; color: #34495e; }
    .status { font-weight: bold; padding: 5px 10px; border-radius: 4px; color: white; display: inline-block; margin-top: 5px; }
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
    html += '<li>No hay sesiones configuradas.</li>';
  }

  html += `</ul><div class="footer"><p>Esta página se refresca automáticamente cada 10 segundos.</p></div></div></body></html>`;
  res.send(html);
});

app.get('/qr/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  const session = sessionsConfig.find(s => s.id === sessionId);
  const sessionName = session ? session.name : sessionId;
  const qrString = activeQRCodes[sessionId];

  let html = `
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
      html += `
        <h2>Código QR para ${sessionName}</h2>
        <p>Escanea este código con WhatsApp:</p>
        <img src="${qrImage}" alt="Código QR para ${sessionName}"/>
        <details><summary>Ver string del QR</summary><textarea rows="4" cols="35" readonly>${qrString}</textarea></details>
        <p class="status-msg" style="color: #E87500;">Este QR es temporal. La página se refrescará.</p>
        <script>setTimeout(() => window.location.reload(), 25000);</script>
      `;
    } catch (e) {
      console.error(`[WebQR] Error al generar QR para ${sessionId}:`, e);
      html += `<h2 style="color:red;">Error al generar QR</h2><p>Revisa la consola del bot.</p><script>setTimeout(()=>window.location.reload(),10000);</script>`;
    }
  } else {
    const status = sessionStatuses[sessionId] || 'Intentando conectar o ya conectado.';
    html += `
      <h2>Código QR para ${sessionName}</h2>
      <p class="status-msg" style="color:#0056b3;">No hay un código QR activo en este momento.</p>
      <p>Estado Actual: <strong>${status}</strong></p>
      <p style="color:grey;font-size:small;">Esta página se refrescará en 10 segundos.</p>
      <script>setTimeout(()=>window.location.reload(),10000);</script>
    `;
  }

  html += `<br><a href="/">Volver al listado de sesiones</a></div></body></html>`;
  res.send(html);
});

// ====================== ARRANQUE ======================
async function main() {
  console.log('Iniciando servidor web y sesiones...');

  // 1) Render necesita un puerto abierto
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor web en http://localhost:${PORT}`);
  });

  // 2) Lanza sesiones sin bloquear el hilo principal
  if (!sessionsConfig || sessionsConfig.length === 0) {
    console.error("No hay sesiones configuradas en 'sessionsConfig'.");
    return;
  }

  for (const cfg of sessionsConfig) {
    if (!sessionStatuses[cfg.id]) sessionStatuses[cfg.id] = 'Pendiente de inicio...';
    startSession(cfg).catch(err => {
      console.error(`[${cfg.name || cfg.id}] Error crítico al iniciar:`, err);
      sessionStatuses[cfg.id] = 'Error Crítico al Iniciar ❌';
    });
  }

  console.log('Sesiones disparadas. El servidor web sirve estados y QR.');
}

// Apagado limpio
process.on('SIGINT', () => { console.log('SIGINT recibido. Saliendo...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('SIGTERM recibido. Saliendo...'); process.exit(0); });

main().catch(err => {
  console.error('Error FATAL en main:', err);
  process.exit(1);
});
