// bot.js (Versión con rutas relativas para servidor)

const {
    default: makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    getContentType,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path'); // <--- ASEGÚRATE QUE ESTÉ ESTE REQUIRE
const { Boom } = require('@hapi/boom');
const express = require('express');
const qrcodePackage = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const scheduler = require('./googleSheetScheduler');

let activeQRCodes = {};
let sessionStatuses = {};

const sessionsConfig = [
    {
        id: 'jony_lager',
        name: 'Jony Lager',
        infoFilePath: path.join(__dirname, 'respuestas', 'jony_lager', 'info.txt'), // RUTA RELATIVA
        photosFolderPath: path.join(__dirname, 'respuestas', 'jony_lager', 'fotos'), // RUTA RELATIVA
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
        infoFilePath: path.join(__dirname, 'respuestas', 'album_magico', 'info.txt'), // RUTA RELATIVA
        photosFolderPath: path.join(__dirname, 'respuestas', 'album_magico', 'fotos'), // RUTA RELATIVA
        spreadsheetId: '1DHQildo2Jewb6Ib9HgdcxS6VY_4Sx0Kg0GzHEUEONFU',
        sheetNameAndRange: 'Hoja1!A:C',
        dayLimitConfig: [ { limit: 5 }, { limit: 4 }, { limit: 2 } ],
        schedulerWelcomeMessage: "🎉 ¡Claro que sí! 🎉 Aquí tienes los horarios que encontré especialmente para ti:\n\n",
        schedulerBookingQuestion: "📸 ¿Qué horario eliges para capturar tus momentos? ✨ ¡Espero tu elección!",
        schedulerNoSlotsMessage: "😥 Ups! Parece que todos nuestros horarios mágicos están ocupados por el momento. ¡Consulta más tarde! 🧚‍♀️",
        schedulerErrorMessage: "⚠️ ¡Ay! Hubo un pequeño duende travieso en el sistema de horarios."
    }
];

const infoKeywords = ["info", "cupo", "información", "informacion"];
const schedulerKeywords = ["reservar", "horarios", "horario", "reserva", "agenda", "disponibilidad", "cita", "programar", "ver horarios"];

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

async function startSession(sessionConfig) {
    const logger = pino({ level: 'info' });
    const authFolderPath = path.join(__dirname, `baileys_auth_${sessionConfig.id}`);

    if (!fs.existsSync(authFolderPath)) {
        fs.mkdirSync(authFolderPath, { recursive: true });
        console.log(`[${sessionConfig.name}] Creada carpeta de autenticación: ${authFolderPath}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(authFolderPath);

    sessionStatuses[sessionConfig.id] = 'Iniciando conexión... 🤔';
    console.log(`[${sessionConfig.name}] Iniciando sesión (ID: ${sessionConfig.id}). Carpeta de Auth: ${authFolderPath}`);

    const sock = makeWASocket({
        logger,
        printQRInTerminal: false,
        auth: state,
        browser: [`Bot ${sessionConfig.name} (${sessionConfig.id})`, "Chrome", "Personalizado"],
    });

    sock.ev.on('messages.upsert', async (m) => {
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
            console.log(`[${sessionConfig.name}] Palabra clave de horario detectada para ${remoteJid}. Consultando: ${sessionConfig.spreadsheetId}`);
            try {
                // 1. Opcional: Enviar estado "escribiendo..."
                await sock.sendPresenceUpdate('composing', remoteJid);
                console.log(`[${sessionConfig.name}] Buscando horarios para ${remoteJid}...`);

                // 2. Obtener los horarios (esto puede tomar algo de tiempo)
                const slots = await scheduler.getAvailableSlots(
                    sessionConfig.spreadsheetId,
                    sessionConfig.sheetNameAndRange,
                    sessionConfig.dayLimitConfig
                );

                // 3. Preparar el mensaje de respuesta
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
                            responseText += `   🕒  \`${time}\`\n`;
                        });
                        responseText += '\n';
                    });
                    responseText += bookingQuestion;
                }
                
                console.log(`[${sessionConfig.name}] Horarios preparados para ${remoteJid}. Iniciando demora de 10 segundos.`);

                // 4. Esperar 10 segundos (10000 milisegundos)
                await new Promise(resolve => setTimeout(resolve, 10000));
                
                console.log(`[${sessionConfig.name}] Demora completada. Enviando horarios a ${remoteJid}.`);

                // 5. Opcional: Cambiar estado a "pausado"
                await sock.sendPresenceUpdate('paused', remoteJid);
                
                // 6. Enviar el mensaje
                await sock.sendMessage(remoteJid, { text: responseText });
                console.log(`[${sessionConfig.name}] Respuesta de horarios enviada a ${remoteJid}`);

            } catch (error) {
                await sock.sendPresenceUpdate('paused', remoteJid); // Asegura que se limpie el "escribiendo" en caso de error
                console.error(`[${sessionConfig.name}] Error CRÍTICO al procesar horarios para ${remoteJid}:`, error);
                const errorMsgBaseCatch = sessionConfig.schedulerErrorMessage || "Error inesperado.";
                await sock.sendMessage(remoteJid, { text: `${errorMsgBaseCatch} Intenta de nuevo.` });
            }
            return; // Importante para no procesar otras lógicas
        }

        // LÓGICA PARA INFO Y FOTOS (esta ya tenía la demora)
        if (containsInfoKeyword(receivedText)) {
            console.log(`[${sessionConfig.name}] Palabra clave de INFO detectada para ${remoteJid}.`);
            try {
                await sock.sendPresenceUpdate('composing', remoteJid);
                console.log(`[${sessionConfig.name}] Esperando 10 segundos antes de responder INFO a ${remoteJid}...`);
                await new Promise(resolve => setTimeout(resolve, 10000));
                await sock.sendPresenceUpdate('paused', remoteJid);
                console.log(`[${sessionConfig.name}] Demora completada. Enviando info a ${remoteJid}.`);

                const infoFilePathResolved = sessionConfig.infoFilePath;
                if (fs.existsSync(infoFilePathResolved)) {
                    const infoText = fs.readFileSync(infoFilePathResolved, 'utf-8');
                    await sock.sendMessage(remoteJid, { text: infoText });
                    console.log(`[${sessionConfig.name}] Texto de info enviado a ${remoteJid}.`);
                } else {
                    console.warn(`[${sessionConfig.name}] Archivo de información no encontrado en: ${infoFilePathResolved}`);
                    await sock.sendMessage(remoteJid, { text: `Lo siento, no pude encontrar la información solicitada para ${sessionConfig.name}.` });
                }

                const photosFolderPathResolved = sessionConfig.photosFolderPath;
                if (fs.existsSync(photosFolderPathResolved)) {
                    const files = fs.readdirSync(photosFolderPathResolved);
                    const imageFiles = files.filter(file => /\.(jpe?g|png)$/i.test(file));
                    if (imageFiles.length > 0) {
                         console.log(`[${sessionConfig.name}] Enviando ${imageFiles.length} foto(s) a ${remoteJid}.`);
                    }
                    for (const imageFile of imageFiles) {
                        const imagePath = path.join(photosFolderPathResolved, imageFile);
                        await sock.sendMessage(remoteJid, { image: { url: imagePath } });
                        await new Promise(resolve => setTimeout(resolve, 1000)); // Pequeña pausa entre fotos
                    }
                    if (imageFiles.length > 0) {
                       console.log(`[${sessionConfig.name}] Todas las fotos enviadas a ${remoteJid}.`);
                    }
                } else {
                    console.warn(`[${sessionConfig.name}] Carpeta de fotos no encontrada en: ${photosFolderPathResolved}`);
                }
            } catch (error) {
                await sock.sendPresenceUpdate('paused', remoteJid);
                console.error(`[${sessionConfig.name}] Error procesando INFO para ${remoteJid}:`, error);
                await sock.sendMessage(remoteJid, { text: 'Hubo un error al procesar tu solicitud de información. Por favor, intenta más tarde.' });
            }
            return; // Importante
        }
    }
});

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async (m) => {
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
                console.log(`[${sessionConfig.name}] Palabra clave de horario detectada. Consultando: ${sessionConfig.spreadsheetId}`);
                try {
                    await sock.sendPresenceUpdate('composing', remoteJid); // Opcional: "escribiendo..."
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
                                responseText += `   🕒  \`${time}\`\n`;
                            });
                            responseText += '\n';
                        });
                        responseText += bookingQuestion;
                    }
                    await sock.sendPresenceUpdate('paused', remoteJid); // Opcional: deja de "escribir"
                    await sock.sendMessage(remoteJid, { text: responseText });
                    console.log(`[${sessionConfig.name}] Respuesta de horarios enviada a ${remoteJid}`);
                } catch (error) {
                    await sock.sendPresenceUpdate('paused', remoteJid); // Asegura que se limpie el "escribiendo"
                    console.error(`[${sessionConfig.name}] Error CRÍTICO al procesar horarios:`, error);
                    const errorMsgBaseCatch = sessionConfig.schedulerErrorMessage || "Error inesperado.";
                    await sock.sendMessage(remoteJid, { text: `${errorMsgBaseCatch} Intenta de nuevo.` });
                }
                return;
            }

            // LÓGICA PARA INFO Y FOTOS
            if (containsInfoKeyword(receivedText)) {
                console.log(`[${sessionConfig.name}] Palabra clave de INFO detectada para ${remoteJid}.`);

                // -------- INICIO DE CAMBIO: AÑADIR DELAY --------
                try {
                    // 1. Opcional: Enviar estado "escribiendo..." para feedback visual
                    await sock.sendPresenceUpdate('composing', remoteJid);
                    console.log(`[${sessionConfig.name}] Esperando 10 segundos antes de responder a ${remoteJid}...`);

                    // 2. Esperar 10 segundos (10000 milisegundos)
                    await new Promise(resolve => setTimeout(resolve, 10000));

                    // 3. Opcional: Cambiar estado a "pausado" (o dejar que expire el "composing")
                    await sock.sendPresenceUpdate('paused', remoteJid);
                    console.log(`[${sessionConfig.name}] Demora completada. Enviando info a ${remoteJid}.`);

                // -------- FIN DE CAMBIO: AÑADIR DELAY --------

                    // Continuación de tu lógica original para enviar info y fotos
                    const infoFilePathResolved = sessionConfig.infoFilePath;
                    if (fs.existsSync(infoFilePathResolved)) {
                        const infoText = fs.readFileSync(infoFilePathResolved, 'utf-8');
                        await sock.sendMessage(remoteJid, { text: infoText });
                        console.log(`[${sessionConfig.name}] Texto de info enviado a ${remoteJid}.`);
                    } else {
                        console.warn(`[${sessionConfig.name}] Archivo de información no encontrado en: ${infoFilePathResolved}`);
                        await sock.sendMessage(remoteJid, { text: `Lo siento, no pude encontrar la información solicitada para ${sessionConfig.name}.` });
                    }

                    const photosFolderPathResolved = sessionConfig.photosFolderPath;
                    if (fs.existsSync(photosFolderPathResolved)) {
                        const files = fs.readdirSync(photosFolderPathResolved);
                        const imageFiles = files.filter(file => /\.(jpe?g|png)$/i.test(file));
                        if (imageFiles.length > 0) {
                             console.log(`[${sessionConfig.name}] Enviando ${imageFiles.length} foto(s) a ${remoteJid}.`);
                        }
                        for (const imageFile of imageFiles) {
                            const imagePath = path.join(photosFolderPathResolved, imageFile);
                            await sock.sendMessage(remoteJid, { image: { url: imagePath } });
                            // Pequeña pausa entre fotos para no saturar y asegurar entrega
                            await new Promise(resolve => setTimeout(resolve, 1000));
                        }
                        if (imageFiles.length > 0) {
                           console.log(`[${sessionConfig.name}] Todas las fotos enviadas a ${remoteJid}.`);
                        }
                    } else {
                        console.warn(`[${sessionConfig.name}] Carpeta de fotos no encontrada en: ${photosFolderPathResolved}`);
                    }
                } catch (error) {
                    await sock.sendPresenceUpdate('paused', remoteJid); // Asegura que se limpie el "escribiendo" en caso de error
                    console.error(`[${sessionConfig.name}] Error procesando INFO para ${remoteJid}:`, error);
                    await sock.sendMessage(remoteJid, { text: 'Hubo un error al procesar tu solicitud de información. Por favor, intenta más tarde.' });
                }
                return; // Importante para no procesar otras lógicas si ya se manejó "info"
            }
        }
    });

    return sock;
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
        console.log(`Servidor web para QR y estados escuchando en http://localhost:${PORT} (o la URL pública en Render)`);
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