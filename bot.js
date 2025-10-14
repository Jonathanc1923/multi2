// bot.js — versión Render FIX ✅

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  getContentType,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { Boom } = require('@hapi/boom');
const qrcodePackage = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const AUTH_BASE = process.env.AUTH_BASE || '/data';
let activeQRCodes = {};
let sessionStatuses = {};
const sessionLocks = new Map();
const sockets = new Map();

// Configuración de sesiones
const sessionsConfig = [
  {
    id: 'jony_lager',
    name: 'Jony Lager',
    infoFilePath: path.join(__dirname, 'respuestas', 'jony_lager', 'info.txt'),
    photosFolderPath: path.join(__dirname, 'respuestas', 'jony_lager', 'fotos'),
  },
  {
    id: 'album_magico',
    name: 'Album Magico',
    infoFilePath: path.join(__dirname, 'respuestas', 'album_magico', 'info.txt'),
    photosFolderPath: path.join(__dirname, 'respuestas', 'album_magico', 'fotos'),
  },
];

// === Helpers de texto ===
const infoKeywords = ['info', 'informacion', 'información', 'quiero saber'];

function normalize(text) {
  return text?.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '') || '';
}
function containsInfoKeyword(text) {
  const n = normalize(text);
  return infoKeywords.some(k => n.includes(normalize(k)));
}

// === Core de sesión ===
async function startSession(cfg) {
  const id = cfg.id;
  const name = cfg.name;

  if (sessionLocks.get(id)) return;
  sessionLocks.set(id, true);

  const authPath = path.join(AUTH_BASE, `baileys_auth_${id}`);
  fs.mkdirSync(authPath, { recursive: true });

  const logger = pino({ level: 'silent' });
  let { state, saveCreds } = await useMultiFileAuthState(authPath);
  const { version } = await fetchLatestBaileysVersion();

  sessionStatuses[id] = 'Iniciando conexión...';
  console.log(`[${name}] Iniciando sesión con versión WA ${version}`);

  const connect = async () => {
    const sock = makeWASocket({
      version,
      logger,
      auth: state,
      printQRInTerminal: false,
      browser: [`Bot ${name}`, 'Chrome', '1.0'],
    });

    sockets.set(id, sock);
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        activeQRCodes[id] = qr;
        sessionStatuses[id] = '📱 Escanea el código QR con WhatsApp';
        qrcodeTerminal.generate(qr, { small: true });
      }
      if (connection === 'open') {
        activeQRCodes[id] = null;
        sessionStatuses[id] = 'Conectado ✅';
      }
      if (connection === 'close') {
        const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
        if (reason === DisconnectReason.loggedOut || reason === 401) {
          fs.rmSync(authPath, { recursive: true, force: true });
          console.log(`[${name}] Sesión cerrada. Nuevo QR requerido.`);
        }
        setTimeout(connect, 5000);
      }
    });

    sock.ev.on('messages.upsert', async (m) => {
      const msg = m.messages?.[0];
      if (!msg?.message || msg.key.fromMe) return;
      const type = getContentType(msg.message);
      const body =
        type === 'conversation'
          ? msg.message.conversation
          : msg.message.extendedTextMessage?.text || '';

      const chat = msg.key.remoteJid;
      if (containsInfoKeyword(body)) {
        console.log(`[${name}] Palabra clave INFO detectada`);
        const info = fs.existsSync(cfg.infoFilePath)
          ? fs.readFileSync(cfg.infoFilePath, 'utf-8')
          : 'Información no disponible.';

        await sock.sendMessage(chat, { text: info });
        if (fs.existsSync(cfg.photosFolderPath)) {
          const files = fs.readdirSync(cfg.photosFolderPath).filter(f => /\.(jpe?g|png)$/i.test(f));
          for (const f of files) {
            await sock.sendMessage(chat, { image: { url: path.join(cfg.photosFolderPath, f) } });
          }
        }
      }
    });
  };
  connect();
}

// === Servidor Express (Render necesita un puerto) ===
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  let html = `<html><head><meta charset="utf8"><title>Estado</title>
  <style>body{font-family:Arial;background:#eef;padding:20px}li{margin:8px 0;}</style>
  <meta http-equiv="refresh" content="10"></head><body><h2>Estado de Sesiones</h2><ul>`;
  for (const s of sessionsConfig) {
    html += `<li><b>${s.name}</b>: ${sessionStatuses[s.id] || 'Iniciando...'} ${
      activeQRCodes[s.id] ? `<a href="/qr/${s.id}">Ver QR</a>` : ''
    }</li>`;
  }
  html += '</ul></body></html>';
  res.send(html);
});

app.get('/qr/:id', async (req, res) => {
  const id = req.params.id;
  const qr = activeQRCodes[id];
  if (!qr) return res.send('No hay QR activo');
  const img = await qrcodePackage.toDataURL(qr);
  res.send(`<img src="${img}"><p>Escanea con WhatsApp</p>`);
});

app.listen(PORT, '0.0.0.0', () =>
  console.log(`✅ Servidor web levantado en http://localhost:${PORT}`)
);

// === Lanzar sesiones ===
(async () => {
  for (const cfg of sessionsConfig) startSession(cfg);
})();
