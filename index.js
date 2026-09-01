const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const XLSX = require('xlsx');
const fs = require('fs');
const pino = require('pino');
const QRCode = require('qrcode');

// ============ CONFIG ============
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8902204232:AAEw0N7UR1amMKO9xuGV8KkHyS-kym7sCmk';
const ADMIN_IDS = (process.env.ADMIN_IDS || '6138410965').split(',').map(Number);
const MESSAGES_PER_DAY = 35;
const DELAY_MIN_MS = 3 * 60 * 1000;
const DELAY_MAX_MS = 5 * 60 * 1000;
const SEND_START_HOUR = 8;
const SEND_END_HOUR = 22;
const AUTH_DIR = './auth_info';

// ============ STATE ============
let whatsappReady = false;
let contacts = [];
let sentNumbers = new Set();
let sendingInProgress = false;
let messagesSentToday = 0;
let lastResetDate = '';
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
let waSock = null;
let manualRestart = false; // flag to suppress disconnect messages during manual restart

// ============ TELEGRAM BOT ============
const tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

function isAdmin(userId) { return ADMIN_IDS.includes(userId); }

function sendToAdmin(text, opts = {}) {
    ADMIN_IDS.forEach(id => {
        tgBot.sendMessage(id, text, opts).catch(e => console.log('TG error:', e.message));
    });
}

function sendQRToAdmin(qr) {
    QRCode.toBuffer(qr, { type: 'png', width: 400 }).then(buf => {
        ADMIN_IDS.forEach(id => {
            tgBot.sendPhoto(id, buf, {
                caption: '📱 QR Code واتساپ\n\nگوشیت رو باز کن:\nSettings → Linked Devices → Link a Device\n\n⏳ اسکن کن.'
            }).catch(e => console.log('TG photo error:', e.message));
        });
    }).catch(e => console.log('QR error:', e.message));
}

// ============ WHATSAPP ============
async function connectWhatsApp() {
    try {
        // Destroy old socket first
        if (waSock) {
            try { waSock.end(undefined); } catch(e) {}
            waSock = null;
        }

        console.log('🔄 Connecting to WhatsApp...');

        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

        waSock = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Sender', 'Chrome', '1.0.0'],
            connectTimeout: 60000,
            keepAliveIntervalMs: 30000,
        });

        waSock.ev.on('creds.update', saveCreds);

        waSock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log('📱 QR received, sending to Telegram...');
                reconnectAttempts = 0;
                manualRestart = false;
                sendQRToAdmin(qr);
            }

            if (connection === 'close') {
                whatsappReady = false;
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`❌ Connection closed. Status: ${statusCode}`);

                // If this is a manual restart, don't send disconnect messages
                // (the QR will come from the new connection)
                if (manualRestart) {
                    console.log('🔄 Manual restart in progress, skipping disconnect notification');
                    return;
                }

                if (statusCode === DisconnectReason.loggedOut) {
                    reconnectAttempts = 0;
                    sendToAdmin('❌ واتساپ از اکانت خارج شد!\n/settings بزن تا QR جدید بیاد.');
                    try { fs.rmSync(AUTH_DIR, { recursive: true }); } catch(e) {}
                } else if (statusCode === DisconnectReason.connectionClosed ||
                           statusCode === DisconnectReason.connectionLost ||
                           statusCode === DisconnectReason.connectionReplaced ||
                           statusCode === DisconnectReason.timedOut) {
                    reconnectAttempts++;
                    if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                        const delay = Math.min(reconnectAttempts * 5000, 30000);
                        console.log(`🔄 Auto-reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay/1000}s`);
                        setTimeout(() => connectWhatsApp(), delay);
                    } else {
                        reconnectAttempts = 0;
                        sendToAdmin('⚠️ واتساپ قطع شد و وصل نشد.\n/settings بزن تا QR جدید بیاد.');
                    }
                } else {
                    reconnectAttempts = 0;
                    sendToAdmin('⚠️ واتساپ قطع شد.\n/settings بزن تا QR جدید بیاد.');
                    try { fs.rmSync(AUTH_DIR, { recursive: true }); } catch(e) {}
                }
            }

            if (connection === 'open') {
                whatsappReady = true;
                reconnectAttempts = 0;
                manualRestart = false;
                console.log('✅ WhatsApp connected!');
                sendToAdmin('✅ واتساپ وصل شد! 🎉');
            }
        });
    } catch (err) {
        console.error('❌ connectWhatsApp error:', err);
        sendToAdmin(`❌ خطا در اتصال:\n${err.message}`);
    }
}

async function requestNewQR() {
    try {
        console.log('⚙️ Requesting new QR...');
        manualRestart = true; // suppress old disconnect messages
        
        // Destroy old socket
        if (waSock) {
            try { waSock.end(undefined); } catch(e) {}
            waSock = null;
        }
        whatsappReady = false;
        reconnectAttempts = 0;

        // Delete old auth to force new QR
        if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true });
        }

        // Small delay to let old socket fully close
        await new Promise(r => setTimeout(r, 1000));

        // Connect fresh
        await connectWhatsApp();
    } catch (err) {
        console.error('❌ requestNewQR error:', err);
        sendToAdmin(`❌ خطا: ${err.message}`);
        manualRestart = false;
    }
}

// ============ MESSAGE SENDING ============
function randomDelay() {
    return DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
}

function isAllowedTime() {
    const hour = new Date().getHours();
    return hour >= SEND_START_HOUR && hour < SEND_END_HOUR;
}

function resetDailyCounter() {
    const today = new Date().toDateString();
    if (lastResetDate !== today) {
        messagesSentToday = 0;
        lastResetDate = today;
        sentNumbers.clear();
    }
}

async function sendMessageToContact(contact, messageTemplate) {
    if (!whatsappReady || !waSock) return false;
    let message = messageTemplate;
    if (contact.name) message = message.replace(/{name}/g, contact.name);
    if (contact.lastname) message = message.replace(/{lastname}/g, contact.lastname);
    const number = contact.number.replace(/[^0-9]/g, '');
    const jid = number + '@s.whatsapp.net';
    try {
        const [exists] = await waSock.onWhatsApp(jid);
        if (!exists.exists) return false;
        await waSock.sendMessage(jid, { text: message });
        return true;
    } catch (err) {
        console.error(`❌ Send failed ${number}:`, err.message);
        return false;
    }
}

async function startSending(messageTemplate) {
    if (sendingInProgress) return sendToAdmin('⚠️ ارسال در حال انجام!');
    if (!whatsappReady) return sendToAdmin('⚠️ واتساپ وصل نیست!');
    if (contacts.length === 0) return sendToAdmin('⚠️ لیست شماره‌ها خالیه!');
    sendingInProgress = true;
    resetDailyCounter();
    let sent = 0, failed = 0;
    sendToAdmin(`🚀 شروع ارسال!\n📱 ${contacts.length} شماره`);
    for (let i = 0; i < contacts.length; i++) {
        if (!sendingInProgress) { sendToAdmin('🛑 متوقف شد.'); break; }
        resetDailyCounter();
        if (messagesSentToday >= MESSAGES_PER_DAY) { sendToAdmin(`⏸️ لیمیت روزانه.`); break; }
        if (!isAllowedTime()) { sendToAdmin(`⏸️ خارج از ساعات ارسال.`); break; }
        const c = contacts[i];
        const num = c.number.replace(/[^0-9]/g, '');
        if (sentNumbers.has(num)) continue;
        const ok = await sendMessageToContact(c, messageTemplate);
        if (ok) { sent++; messagesSentToday++; sentNumbers.add(num); }
        else failed++;
        if (sent % 5 === 0 && sent > 0) sendToAdmin(`📊 ${sent}/${contacts.length} ✅ | ${failed} ❌`);
        if (i < contacts.length - 1) await new Promise(r => setTimeout(r, randomDelay()));
    }
    sendingInProgress = false;
    sendToAdmin(`✅ تمام شد! ✅${sent} ❌${failed}`);
}

// ============ TELEGRAM COMMANDS ============
tgBot.onText(/\/start/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    tgBot.sendMessage(msg.from.id,
        `🤖 ربات واتساپ\n\n` +
        `/settings - QR جدید\n` +
        `/status - وضعیت\n` +
        `/send متن - ارسال\n` +
        `/stop - توقف\n` +
        `/contacts - لیست شماره‌ها\n` +
        `/limit - لیمیت\n` +
        `/addaccess [ID] - دسترسی\n` +
        `/accesslist - لیست دسترسی\n\n` +
        `📎 فایل اکسل بفرست`
    );
});

tgBot.onText(/\/settings/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    console.log(`⚙️ /settings from ${msg.from.id}`);
    sendToAdmin('🔄 در حال دریافت QR کد...');
    requestNewQR();
});

tgBot.onText(/\/status/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    resetDailyCounter();
    tgBot.sendMessage(msg.from.id,
        `📱 واتساپ: ${whatsappReady ? '✅ وصل' : '❌ قطع'}\n` +
        `📋 شماره‌ها: ${contacts.length}\n` +
        `📨 امروز: ${messagesSentToday}/${MESSAGES_PER_DAY}\n` +
        `🔄 ارسال: ${sendingInProgress ? 'بله' : 'خیر'}`
    );
});

tgBot.onText(/\/stop/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    sendingInProgress = false;
    tgBot.sendMessage(msg.from.id, '🛑 متوقف شد.');
});

tgBot.onText(/\/send (.+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const tpl = match[1];
    if (!tpl.includes('{name}'))
        return tgBot.sendMessage(msg.from.id, '⚠️ متن باید `{name}` داشته باشه.\nمثال: سلام {name} 👋');
    tgBot.sendMessage(msg.from.id, `✅ ثبت شد:\n${tpl}\n\n🚀 شروع...`);
    startSending(tpl);
});

tgBot.onText(/\/contacts/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    if (!contacts.length) return tgBot.sendMessage(msg.from.id, 'خالیه. فایل اکسل بفرست.');
    let list = contacts.slice(0, 20).map((c, i) => `${i+1}. ${c.number} - ${c.name || '-'}`).join('\n');
    if (contacts.length > 20) list += `\n... +${contacts.length - 20}`;
    tgBot.sendMessage(msg.from.id, `📋 (${contacts.length}):\n\n${list}`);
});

tgBot.onText(/\/limit/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    resetDailyCounter();
    tgBot.sendMessage(msg.from.id,
        `📊 امروز: ${messagesSentToday}/${MESSAGES_PER_DAY}\n⏰ ${DELAY_MIN_MS/60000}-${DELAY_MAX_MS/60000} دقیقه فاصله\n🕐 ${SEND_START_HOUR}:00-${SEND_END_HOUR}:00`
    );
});

tgBot.onText(/\/addaccess (.+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const id = parseInt(match[1]);
    if (isNaN(id)) return tgBot.sendMessage(msg.from.id, '❌ نامعتبر');
    if (ADMIN_IDS.includes(id)) return tgBot.sendMessage(msg.from.id, '⚠️ از قبل داره.');
    ADMIN_IDS.push(id);
    tgBot.sendMessage(msg.from.id, `✅ اضافه شد: ${id}`);
});

tgBot.onText(/\/accesslist/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const list = ADMIN_IDS.map((id, i) => `${i+1}. ${id}${id === 6138410965 ? ' (مالک)' : ''}`).join('\n');
    tgBot.sendMessage(msg.from.id, `👥 دسترسی‌ها:\n${list}`);
});

// Handle Excel
tgBot.on('document', async (msg) => {
    if (!isAdmin(msg.from.id)) return;
    if (!msg.document.file_name.match(/\.(xlsx|xls|csv)$/i))
        return tgBot.sendMessage(msg.from.id, '❌ فقط اکسل یا CSV.');
    try {
        const file = await tgBot.getFile(msg.document.file_id);
        const url = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
        const res = await fetch(url);
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(Buffer.from(buf));
        const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        contacts = data.map(row => ({
            number: String(row['شماره'] || row['phone'] || row['Phone'] || Object.values(row)[0] || '').trim(),
            name: String(row['اسم'] || row['name'] || row['Name'] || row['نام'] || Object.values(row)[1] || '').trim()
        })).filter(c => c.number);
        fs.writeFileSync('./contacts.json', JSON.stringify(contacts, null, 2));
        let list = `✅ ${contacts.length} شماره آپلود شد:\n\n`;
        contacts.slice(0, 10).forEach((c, i) => list += `${i+1}. ${c.number} - ${c.name || '-'}\n`);
        if (contacts.length > 10) list += `... +${contacts.length - 10}`;
        tgBot.sendMessage(msg.from.id, list);
    } catch (err) {
        tgBot.sendMessage(msg.from.id, `❌ خطا: ${err.message}`);
    }
});

// ============ STARTUP ============
async function main() {
    console.log('🚀 Starting WhatsApp Sender Bot...');
    if (fs.existsSync('./contacts.json')) {
        contacts = JSON.parse(fs.readFileSync('./contacts.json', 'utf8'));
        console.log(`📋 ${contacts.length} contacts loaded`);
    }
    await connectWhatsApp();
    sendToAdmin(
        '🤖 ربات آماده شد!\n\n' +
        '۱. /settings بزن تا QR بیاد\n' +
        '۲. اسکن کن\n' +
        '۳. فایل اکسل بفرست\n' +
        '۴. /send سلام {name} ...'
    );
}

main().catch(err => {
    console.error('💀 Fatal:', err);
    process.exit(1);
});
