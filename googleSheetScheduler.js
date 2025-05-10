const { google } = require('googleapis');
const path = require('path');

// --- CONFIGURACIÓN GENERAL DEL MÓDULO ---
const KEYFILEPATH = path.join(__dirname, 'credentials.json');
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly'];

console.log(`[Scheduler] Módulo de Scheduler cargado. Usando credenciales de: ${KEYFILEPATH}`);

const auth = new google.auth.GoogleAuth({
    keyFile: KEYFILEPATH,
    scopes: SCOPES,
});

/**
 * Obtiene los días y horarios disponibles desde una Google Spreadsheet específica.
 * @param {string} spreadsheetId El ID de la Google Spreadsheet a leer.
 * @param {string} sheetRange El nombre de la hoja y el rango (ej. 'Hoja1!A:C').
 * @param {Array<{limit: number}>} dayLimitConfigArray Configuración para limitar horarios por día.
 * Ej: [{ limit: 5 }, { limit: 4 }, { limit: 2 }]. Si es null o vacío, no se aplican límites especiales.
 * @returns {Promise<Array<{day: string, availableTimes: string[]}> | {error: string, details?: string}>}
 */
async function getAvailableSlots(spreadsheetId, sheetRange, dayLimitConfigArray) {
    console.log(`[Scheduler] Iniciando getAvailableSlots para Spreadsheet ID: ${spreadsheetId}, Rango: ${sheetRange}`);
    
    const currentDayLimitConfig = Array.isArray(dayLimitConfigArray) ? dayLimitConfigArray : [];
    if (currentDayLimitConfig.length > 0) {
        console.log('[Scheduler] Aplicando configuración de límites por día:', JSON.stringify(currentDayLimitConfig));
    } else {
        console.log('[Scheduler] No se aplicará configuración especial de límites por día.');
    }

    try {
        console.log('[Scheduler] Autenticando con Google Sheets API...');
        const client = await auth.getClient();
        const sheets = google.sheets({ version: 'v4', auth: client });
        console.log('[Scheduler] Autenticación exitosa. Obteniendo datos del spreadsheet...');

        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId, // Usar el ID pasado como parámetro
            range: sheetRange,         // Usar el rango pasado como parámetro
        });
        console.log('[Scheduler] Datos recibidos de la API.');

        const rows = response.data.values;
        const orderedDaysData = [];
        console.log('[Scheduler] DEBUG: orderedDaysData inicializado. Tipo:', typeof orderedDaysData, 'Es Array:', Array.isArray(orderedDaysData));
        const dayObjectMap = new Map();
        let currentDayInSpreadsheet = null;

        if (rows && rows.length) {
            console.log(`[Scheduler] Se encontraron ${rows.length} filas en total en el rango especificado.`);
            rows.forEach((row, index) => {
                const rowIndexForLog = index + 1;
                let dayFromFile = row[0];
                const timeSlot = row[1];
                const clientName = row[2];
                let effectiveDay = null;

                if (dayFromFile && dayFromFile.trim() !== '') {
                    currentDayInSpreadsheet = dayFromFile.trim();
                    effectiveDay = currentDayInSpreadsheet;
                } else if (currentDayInSpreadsheet) {
                    effectiveDay = currentDayInSpreadsheet;
                }

                const hasEffectiveDay = effectiveDay && effectiveDay.trim() !== '';
                const hasTimeSlot = timeSlot && timeSlot.trim() !== '';

                if (hasEffectiveDay && hasTimeSlot) {
                    const isClientSlotEmpty = clientName === undefined || clientName === null || clientName.trim() === '';
                    if (isClientSlotEmpty) {
                        if (!dayObjectMap.has(effectiveDay)) {
                            const newDayObject = { day: effectiveDay, availableTimes: [] };
                            dayObjectMap.set(effectiveDay, newDayObject);
                            orderedDaysData.push(newDayObject);
                            console.log(`[Scheduler] Nuevo día con horarios disponibles: '${effectiveDay}' (Fila ${rowIndexForLog}).`);
                        }
                        dayObjectMap.get(effectiveDay).availableTimes.push(timeSlot);
                    }
                }
            });
        } else {
            console.log('[Scheduler] No se encontraron datos (filas) en el rango especificado.');
            return [];
        }
        
        console.log(`[Scheduler] Recopilación inicial completada. Días con disponibilidad: ${orderedDaysData.map(d => `${d.day} (${d.availableTimes.length} slots)`).join('; ')}`);

        const finalLimitedSlots = [];
        let daysProcessedForLimits = 0;

        for (const dayData of orderedDaysData) {
            if (currentDayLimitConfig.length > 0 && daysProcessedForLimits >= currentDayLimitConfig.length) {
                console.log(`[Scheduler] Límite de ${currentDayLimitConfig.length} días (según config) para oferta especial alcanzado.`);
                break; 
            }

            if (!dayData.availableTimes || dayData.availableTimes.length === 0) {
                console.log(`[Scheduler] Día '${dayData.day}' sin horarios disponibles, saltando.`);
                continue;
            }

            let dayConfig = { limit: Infinity }; 
            if (currentDayLimitConfig.length > 0 && daysProcessedForLimits < currentDayLimitConfig.length) {
                 dayConfig = currentDayLimitConfig[daysProcessedForLimits];
            }

            let timesToOffer = dayData.availableTimes;
            console.log(`[Scheduler] Procesando día #${daysProcessedForLimits + 1} ('${dayData.day}'). Disponibles: ${timesToOffer.length}, Límite de config aplicable: ${dayConfig.limit}`);

            if (dayData.availableTimes.length > dayConfig.limit) {
                const N = dayData.availableTimes.length; // Total de horarios disponibles originalmente
                const M = dayConfig.limit;             // Máximo de horarios a ofrecer según config
                let selectedTimesOutput = [];

                console.log(`[Scheduler]   Aplicando NUEVA selección distribuida (con primero y último): Objetivo ${M} de ${N} para '${dayData.day}'.`);

                if (M === 0) {
                    // No se seleccionan horarios si el límite es 0
                    console.log(`[Scheduler]     Límite M es 0. No se seleccionan horarios.`);
                    // selectedTimesOutput ya es []
                } else if (M === 1) {
                    // Si el límite es 1, se ofrece solo el primer horario disponible
                    selectedTimesOutput.push(dayData.availableTimes[0]);
                    console.log(`[Scheduler]     Límite M es 1. Seleccionando el primer horario: ${dayData.availableTimes[0]}`);
                } else { 
                    // M >= 2 (y N > M por la condición del if externo)
                    // Esto implica que N debe ser al menos 3 (ej. N=3, M=2)

                    // 1. Siempre incluir el primer horario disponible
                    selectedTimesOutput.push(dayData.availableTimes[0]);
                    console.log(`[Scheduler]     Incluyendo siempre el primer horario: ${dayData.availableTimes[0]}`);

                    // 2. Determinar cuántos horarios se necesitan del medio
                    // Ya hemos seleccionado el primero y planeamos seleccionar el último.
                    const numToPickFromMiddle = M - 2;

                    if (numToPickFromMiddle > 0) {
                        // Hay espacio para seleccionar horarios del medio
                        const middleCandidates = dayData.availableTimes.slice(1, N - 1); // Horarios entre el primero y el último
                        const numMiddleCandidates = middleCandidates.length;
                        
                        console.log(`[Scheduler]     Necesitamos seleccionar ${numToPickFromMiddle} horario(s) del medio. Hay ${numMiddleCandidates} candidatos en el medio: [${middleCandidates.join(', ')}]`);

                        if (numMiddleCandidates > 0) {
                            if (numMiddleCandidates <= numToPickFromMiddle) {
                                // Si hay menos o igual cantidad de candidatos en el medio que los que necesitamos, los tomamos todos.
                                selectedTimesOutput.push(...middleCandidates);
                                console.log(`[Scheduler]     Tomando todos los ${numMiddleCandidates} horarios del medio.`);
                            } else {
                                // Hay más candidatos en el medio de los que necesitamos, así que distribuimos.
                                console.log(`[Scheduler]     Distribuyendo ${numToPickFromMiddle} de ${numMiddleCandidates} horarios del medio.`);
                                for (let i = 0; i < numToPickFromMiddle; i++) {
                                    const indexInMiddle = Math.floor(i * numMiddleCandidates / numToPickFromMiddle);
                                    selectedTimesOutput.push(middleCandidates[indexInMiddle]);
                                }
                            }
                        } else {
                            console.log(`[Scheduler]     No hay horarios en el medio para seleccionar (N=${N}, M=${M}).`);
                        }
                    } else {
                        console.log(`[Scheduler]     No se necesitan horarios del medio (M=${M}). Solo se considerarán el primero y el último.`);
                    }

                    // 3. Siempre incluir el último horario disponible (N > 1 es seguro aquí)
                    selectedTimesOutput.push(dayData.availableTimes[N - 1]);
                    console.log(`[Scheduler]     Incluyendo siempre el último horario: ${dayData.availableTimes[N - 1]}`);
                }

                // 4. Eliminar duplicados (por si el primero y el último fueran los únicos, o N muy pequeño) y ordenar
                let uniqueAndSortedOutput = [...new Set(selectedTimesOutput)];

                // Función para ordenar horarios en formato "HH:MM"
                function sortTimes(a, b) {
                    const [hA, mA] = a.split(':').map(s => parseInt(s, 10));
                    const [hB, mB] = b.split(':').map(s => parseInt(s, 10));
                    if (isNaN(hA) || isNaN(mA) || isNaN(hB) || isNaN(mB)) { // Manejo básico de error de parseo
                        console.warn(`[Scheduler] Error al parsear tiempos para ordenar: ${a}, ${b}`);
                        return 0;
                    }
                    if (hA !== hB) return hA - hB;
                    return mA - mB;
                }
                uniqueAndSortedOutput.sort(sortTimes);
                
                timesToOffer = uniqueAndSortedOutput; // Asignar el resultado a timesToOffer
                console.log(`[Scheduler]     Horarios finales seleccionados para '${dayData.day}' (distribuidos, únicos y ordenados): ${timesToOffer.join(', ')}`);

            } else {
                // Si N <= M (no hay más horarios que el límite), se ofrecen todos los disponibles.
                // timesToOffer ya es dayData.availableTimes, no necesita cambio.
                console.log(`[Scheduler]   Se ofrecerán todos los ${dayData.availableTimes.length} horarios disponibles para '${dayData.day}' (ya que es <= al límite de ${dayConfig.limit}).`);
                timesToOffer = dayData.availableTimes; // Asegurarse de que timesToOffer tiene el valor correcto
            }

            if (timesToOffer.length > 0) {
                finalLimitedSlots.push({
                    day: dayData.day,
                    availableTimes: timesToOffer
                });
                console.log(`[Scheduler]   -> Ofreciendo para '${dayData.day}': ${timesToOffer.join(', ')}`);
            } else {
                console.log(`[Scheduler]   -> No quedaron horarios para ofrecer para '${dayData.day}'.`);
            }
            
            if (currentDayLimitConfig.length > 0) { // Solo incrementa si hay una configuración de límite de días activa
                 daysProcessedForLimits++;
            } else {
                // Si no hay config de límite de días, y quisieras limitar el total de días mostrados (ej. a 3)
                // podrías hacerlo aquí. Por ahora, sin config, muestra todos los días con slots.
                // if (finalLimitedSlots.length >= 3 && !currentDayLimitConfig.length) break; 
            }
        }

        if (finalLimitedSlots.length > 0) {
            console.log('[Scheduler] Horarios finales retornados:', JSON.stringify(finalLimitedSlots, null, 2));
        } else {
            console.log('[Scheduler] No se encontraron horarios para ofrecer después de filtros.');
        }
        console.log('[Scheduler] getAvailableSlots finalizado exitosamente.');
        return finalLimitedSlots;

    } catch (err) {
        console.error(`[Scheduler] Error en getAvailableSlots para Spreadsheet ID: ${spreadsheetId}`, err);
        let errorMessage = `Error al procesar horarios para ${spreadsheetId}.`;
        if (err.isGaxiosError && err.response && err.response.data && err.response.data.error) {
            errorMessage = err.response.data.error.message || err.message;
        } else if (err.message) {
            errorMessage = err.message;
        }
        return { error: 'Error Interno del Scheduler', details: errorMessage };
    }
}

module.exports = {
    getAvailableSlots
};