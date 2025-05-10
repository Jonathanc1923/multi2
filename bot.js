// bot.js (Versión completa con servidor web para QR)

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
// const qrcodeTerminal = require('qrcode-terminal'); // Ya no lo imprimiremos en terminal principalmente
const scheduler = require('./googleSheetScheduler');

// ----- NUEVOS REQUIRES -----
const express = require('express');
const qrcodePackage = require('qrcode'); // Para generar DataURLs de QR
// ----- FIN NUEVOS REQUIRES -----

// ----- ALMACENAMIENTO GLOBAL PARA QRs Y ESTADOS -----
let activeQRCodes = {}; // { sessionId: qrString }
let sessionStatuses = {}; // { sessionId: statusMessage }
// ----- FIN ALMACENAMIENTO GLOBAL -----


// --- Configuración de las Sesiones y Palabras Clave ---
const sessionsConfig = [
    // ... (Tu sessionsConfig exactamente como la tenías, con los spreadsheetId, etc. para Jony Lager y Album Magico)
    // Ejemplo de una entrada (asegúrate que las tuyas estén completas):
    {
        id: 'jony_lager',
        name: 'Jony Lager',
        infoFilePath: 'D:/botwsp general multiples sesiones/respuestas/jony lager/info.txt',
        photosFolderPath: 'D:/botwsp general multiples sesiones/respuestas/jony lager/fotos',
        spreadsheetId: '1E-Vzmk-dPw4ko7C9uvpuVsp-mYxNio-33HaOmJvEM9A', 
        sheetNameAndRange: 'Hoja1!A:C',
        dayLimitConfig: [ { limit: 5 }, { limit: 4 }, { limit: 2 } ],
        schedulerWelcomeMessage: "🎉 ¡Claro que sí! 🎉 Aquí tienes los horarios que encontré especialmente para ti:\n\n",
        schedulerBookingQuestion: "✨ ¿Cuál de estos maravillosos horarios te gustaría reservar? 😊 ¡Dímelo para ayudarte!",
        schedulerNoSlotsMessage: "😢 ¡Vaya! Parece que por ahora no tenemos horarios disponibles. ¡Vuelve a consultarnos pronto! 🗓️✨",
        schedulerErrorMessage: "😕 ¡Oh no! Parece que tuve un problema al buscar los horarios."
    },
    {
        id: 'album_magico',
        name: 'Album Magico',
        infoFilePath: 'D:/botwsp general multiples sesiones/respuestas/album magico/info.txt',
        photosFolderPath: 'D:/botwsp general multiples sesiones/respuestas/album magico/fotos',
        spreadsheetId: '1DHQildo2Jewb6Ib9HgdcxS6VY_4Sx0Kg0GzHEUEONFU', 
        sheetNameAndRange: 'Hoja1!A:C', 
        dayLimitConfig: [ { limit: 5 }, { limit: 4 }, { limit: 2 } ],
        schedulerWelcomeMessage: "🌟 ¡Hola! 🌟 Estos son los horarios mágicos que tenemos para tu sesión:\n\n",
        schedulerBookingQuestion: "📸 ¿Qué horario eliges para capturar tus momentos? ✨ ¡Espero tu elección!",
        schedulerNoSlotsMessage: "😥 Ups! Parece que todos nuestros horarios mágicos están ocupados por el momento. ¡Consulta más tarde! 🧚‍♀️",
        schedulerErrorMessage: "⚠️ ¡Ay! Hubo un pequeño duende travieso en el sistema de horarios."
    }
];

const infoKeywords = ["info", "cupo", "información", "informacion"];
const schedulerKeywords = ["reservar", "horarios", "agenda", "disponibilidad", "cita", "programar", "ver horarios"];

// --- Funciones Auxiliares (normalizeText, containsInfoKeyword, containsSchedulerKeyword) ---
// ... (Estas funciones permanecen igual que en tu código anterior) ...
function normalizeText(text) {
    if (!text) return '';
    return text.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

function containsInfoKeyword(messageText) {
    const normalizedMsg = normalizeText(messageText);
    return infoKeywords.some(keyword => normalizedMsg.includes(normalizeText(keyword)));
}

function containsSchedulerKeyword(messageText) {
    const normalizedMsg = normalizeText(messageText);
    return schedulerKeywords.some(keyword => normalizedMsg.includes(normalizeText(keyword)));
}

// --- Lógica Principal del Bot ---
async function startSession(sessionConfig) {
    const logger = pino({ level: 'silent' });
    const authFolderPath = path.join(__dirname, `baileys_auth_${sessionConfig.id}`);
    if (!fs.existsSync(authFolderPath)) {
        fs.mkdirSync(authFolderPath, { recursive: true });
    }
    const { state, saveCreds } = await useMultiFileAuthState(authFolderPath);

    // Inicializar estado de la sesión
    sessionStatuses[sessionConfig.id] = 'Iniciando... 🤔';

    const sock = makeWASocket({
        logger,
        printQRInTerminal: false, // Ya no necesitamos esto si usamos la web
        auth: state,
        browser: [`Bot ${sessionConfig.name} (${sessionConfig.id})`, "Chrome", "Personalizado"],
    });

    console.log(`[${sessionConfig.name}] Iniciando sesión (ID: ${sessionConfig.id})...`);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const sessionId = sessionConfig.id;
        const sessionName = sessionConfig.name;

        if (qr) {
            activeQRCodes[sessionId] = qr;
            sessionStatuses[sessionId] = '📱 Escanea el código QR con WhatsApp.';
            console.log(`[${sessionName}] Código QR generado para ${sessionId}. Disponible en la página web.`);
            // qrcodeTerminal.generate(qr, { small: true }); // Comentado: Usar interfaz web
        }

        if (connection === 'open') {
            activeQRCodes[sessionId] = null; 
            sessionStatuses[sessionId] = 'Conectado ✅ ¡Listo para trabajar!';
            console.log(`[${sessionName}] Conexión abierta para ${sessionId}. QR limpiado.`);
        } else if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            
            if (statusCode === DisconnectReason.loggedOut) {
                activeQRCodes[sessionId] = null;
                sessionStatuses[sessionId] = '⚠️ Sesión cerrada (logged out). Elimina la carpeta de autenticación (`baileys_auth_' + sessionId + '`) y reinicia el bot para obtener un nuevo QR.';
                console.log(`[${sessionName}] Sesión cerrada (logged out) para ${sessionId}. QR limpiado.`);
                // Podrías intentar limpiar la carpeta de auth aquí, pero es más seguro hacerlo manualmente.
                // if (fs.existsSync(authFolderPath)) {
                //     console.log(`[${sessionName}] Intentando eliminar carpeta de autenticación: ${authFolderPath}`);
                //     fs.rmSync(authFolderPath, { recursive: true, force: true });
                // }
            } else if (shouldReconnect) {
                sessionStatuses[sessionId] = `🔴 Desconectado. Reintentando conectar... (Razón: ${lastDisconnect?.error?.message || 'Desconocida'})`;
                console.log(`[${sessionName}] Desconectado, reintentando para ${sessionId}.`);
            } else {
                sessionStatuses[sessionId] = `🟥 Desconectado permanentemente. (Razón: ${lastDisconnect?.error?.message || 'Desconocida'})`;
                activeQRCodes[sessionId] = null; 
                console.log(`[${sessionName}] Desconectado permanentemente para ${sessionId}.`);
            }
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async (m) => {
        // ... (Tu lógica existente de messages.upsert va aquí SIN CAMBIOS)
        // Esta es la parte que maneja los mensajes "reservar", "info", etc.
        // Asegúrate de que esta sección esté completa y correcta como la tenías.
        // Ejemplo de cómo empezaría:
        if (!m.messages || m.messages.length === 0) return;
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;
        const messageType = getContentType(msg.message);
        let receivedText = '';
        if (messageType === 'conversation') receivedText = msg.message.conversation;
        else if (messageType === 'extendedTextMessage') receivedText = msg.message.extendedTextMessage.text;

        if (receivedText) {
            console.log(`[${sessionConfig.name}] Mensaje de ${msg.key.remoteJid}: "${receivedText}"`);
            const remoteJid = msg.key.remoteJid;

            // LÓGICA PARA HORARIOS
            if (sessionConfig.spreadsheetId && sessionConfig.sheetNameAndRange && containsSchedulerKeyword(receivedText)) {
                console.log(`[${sessionConfig.name}] Palabra clave de horario detectada. Consultando spreadsheet: ${sessionConfig.spreadsheetId}`);
                try {
                    const slots = await scheduler.getAvailableSlots(
                        sessionConfig.spreadsheetId,
                        sessionConfig.sheetNameAndRange,
                        sessionConfig.dayLimitConfig
                    );
                    let responseText = '';
                    const welcomeMsg = sessionConfig.schedulerWelcomeMessage || "Horarios disponibles:\n\n";
                    const bookingQuestion = sessionConfig.schedulerBookingQuestion || "¿Cuál te gustaría reservar?";
                    const noSlotsMsg = sessionConfig.schedulerNoSlotsMessage || "No hay horarios disponibles.";
                    const errorMsgBase = sessionConfig.schedulerErrorMessage || "Error al buscar horarios.";

                    if (slots.error) {
                        responseText = `${errorMsgBase} Detalles: ${slots.details}.`;
                    } else if (!slots || slots.length === 0) {
                        responseText = noSlotsMsg;
                    } else {
                        responseText = welcomeMsg;
                        slots.forEach(dayInfo => {
                            let dayEmoticon = "🗓️"; 
                            const dayLower = dayInfo.day.toLowerCase();
                            if (dayLower.includes("lunes")) dayEmoticon = "✅";
                            else if (dayLower.includes("martes")) dayEmoticon = "✅";
                            else if (dayLower.includes("miércoles") || dayLower.includes("miercoles")) dayEmoticon = "✅";
                            else if (dayLower.includes("jueves")) dayEmoticon = "✅";
                            else if (dayLower.includes("viernes")) dayEmoticon = "✅";
                            else if (dayLower.includes("sábado") || dayLower.includes("sabado")) dayEmoticon = "✅";
                            else if (dayLower.includes("domingo")) dayEmoticon = "✅";

                            responseText += `${dayEmoticon} *${dayInfo.day}*:\n`;
                            dayInfo.availableTimes.forEach(time => {
                                responseText += `  🕒  \`${time}\`\n`;
                            });
                            responseText += '\n';
                        });
                        responseText += bookingQuestion;
                    }
                    await sock.sendMessage(remoteJid, { text: responseText });
                    console.log(`[${sessionConfig.name}] Respuesta de horarios enviada a ${remoteJid}`);
                } catch (error) {
                    console.error(`[${sessionConfig.name}] Error CRÍTICO al procesar horarios:`, error);
                    const errorMsgBaseCatch = sessionConfig.schedulerErrorMessage || "Error inesperado.";
                    await sock.sendMessage(remoteJid, { text: `${errorMsgBaseCatch} Intenta de nuevo.` });
                }
                return; 
            }

            // LÓGICA PARA INFO Y FOTOS
            if (containsInfoKeyword(receivedText)) {
                // ... (Tu código para INFO y FOTOS aquí) ...
                console.log(`[${sessionConfig.name}] Palabra clave de INFO detectada.`);
                try {
                    const infoFilePath = sessionConfig.infoFilePath;
                    if (fs.existsSync(infoFilePath)) {
                        const infoText = fs.readFileSync(infoFilePath, 'utf-8');
                        await sock.sendMessage(remoteJid, { text: infoText });
                    } else {
                        await sock.sendMessage(remoteJid, { text: `Info no encontrada para ${sessionConfig.name}.` });
                    }
                    const photosFolderPath = sessionConfig.photosFolderPath;
                    if (fs.existsSync(photosFolderPath)) {
                        const files = fs.readdirSync(photosFolderPath);
                        const imageFiles = files.filter(file => /\.(jpe?g|png)$/i.test(file));
                        for (const imageFile of imageFiles) {
                            const imagePath = path.join(photosFolderPath, imageFile);
                            await sock.sendMessage(remoteJid, { image: { url: imagePath } });
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                    }
                } catch (error) {
                     console.error(`[${sessionConfig.name}] Error en INFO:`, error);
                     await sock.sendMessage(remoteJid, { text: 'Error al procesar info.' });
                }
            }
        }
    });

    return sock;
}


// --- SERVIDOR WEB EXPRESS PARA MOSTRAR QR Y ESTADOS ---
const app = express();
const PORT = process.env.PORT || 3000; // Render usa la variable de entorno PORT

app.get('/', (req, res) => {
    let html = `
        <!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Estado de Bots WhatsApp</title>
        <style>
            body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; margin: 0; padding: 20px; background-color: #eef2f7; color: #333; }
            .container { max-width: 800px; margin: 20px auto; background-color: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.1); }
            h1 { color: #2c3e50; text-align: center; margin-bottom: 30px; }
            ul { list-style-type: none; padding: 0; }
            li { background-color: #f8f9fa; margin-bottom: 12px; padding: 15px 20px; border-radius: 6px; border-left: 5px solid #007bff; display: flex; justify-content: space-between; align-items: center; }
            li strong { font-size: 1.1em; color: #34495e; }
            .status { font-weight: bold; padding: 5px 10px; border-radius: 4px; color: white; }
            .status-ok { background-color: #28a745; } /* Verde */
            .status-qr { background-color: #ffc107; color: #333; } /* Amarillo */
            .status-error { background-color: #dc3545; } /* Rojo */
            .status-init { background-color: #6c757d; } /* Gris */
            a.qr-link { background-color: #007bff; color: white; padding: 8px 12px; border-radius: 4px; text-decoration: none; font-size: 0.9em; }
            a.qr-link:hover { background-color: #0056b3; }
            .footer { text-align: center; margin-top: 30px; font-size: 0.9em; color: #777; }
        </style>
        <meta http-equiv="refresh" content="10"> </head><body><div class="container"><h1>Estado de Bots WhatsApp</h1><ul>
    `;
    if (sessionsConfig && sessionsConfig.length > 0) {
        sessionsConfig.forEach(session => {
            const statusMsg = sessionStatuses[session.id] || 'No Iniciado';
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
            img { display: block; margin: 15px auto; }
            textarea { width: 90%; max-width: 350px; margin-top: 10px; font-family: monospace; }
            p.status-msg { margin-top: 20px; font-size: 1.1em; }
            a { color: #007bff; text-decoration: none; margin-top:20px; display:inline-block;}
        </style>
        </head><body><div class="qr-container">
    `;

    if (qrString) {
        try {
            const qrImage = await qrcodePackage.toDataURL(qrString, { width: 300 });
            htmlResponse += `
                <h2>Código QR para ${sessionName}</h2>
                <p>Escanea este código con WhatsApp:</p>
                <img src="${qrImage}" alt="Código QR para ${sessionName}"/>
                <textarea rows="5" cols="40" readonly>${qrString}</textarea>
                <p class="status-msg" style="color: #E87500;">Este QR es temporal. La página se refrescará.</p>
                <script>setTimeout(() => window.location.reload(), 20000);</script> `;
        } catch (err) {
            console.error(`[WebQR] Error al generar imagen QR para ${sessionId}:`, err);
            htmlResponse += `<h2 style="color:red;">Error al generar QR</h2><p>Revisa la consola del bot.</p>`;
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

    // Iniciar todas las sesiones de Baileys
    for (const config of sessionsConfig) {
        // Inicializar estado para la UI web
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
    
    // Iniciar el servidor Express DESPUÉS de configurar los listeners de Baileys (o en paralelo si no hay dependencias)
    // En este caso, es mejor iniciarlo aquí para que las variables activeQRCodes y sessionStatuses estén disponibles.
    app.listen(PORT, '0.0.0.0', () => { // Escuchar en 0.0.0.0 para Render
        console.log(`Servidor web para QR y estados escuchando en http://localhost:${PORT} (o la URL de Render)`);
        console.log(`Accede a los QR en: /qr/<session_id> (ej. /qr/jony_lager)`);
        console.log(`Página de estado principal en: /`);
    });

    console.log("Proceso de inicio de todas las sesiones Baileys completado.");
    console.log("El servidor web está corriendo para mostrar los QR y estados.");
}

main().catch(err => {
    console.error("Error FATAL en la ejecución principal del bot (main):", err);
    // Asegurarse de que el proceso termine si hay un error fatal en main no capturado antes
    process.exit(1);
});