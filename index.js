const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const XLSX = require('xlsx');
const fs = require('fs');
const pino = require('pino');
const QR = require('qrcode');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8902204232:AAEw0N7UR1amMKO9xuGV8KkHyS-kym7sCmk';
const ADMIN_IDS = (process.env.ADMIN_IDS || '6138410965').split(',').map(Number);
const MESSAGES_PER_DAY = 35;
const DELAY_MIN = 3 * 60 * 1000;
const DELAY_MAX = 5 * 60 * 1000;
const AUTH_DIR = './auth_info';

let whatsappReady = false;
let contacts = [];
let sentNumbers = new Set();
let sendingInProgress = false;
let messagesSentToday = 0;
let lastResetDate = '';

const tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
function isAdmin(id) { return ADMIN_IDS.includes(id); }
function sendAdmin(text, opts) {
    ADMIN_IDS.forEach(id => tgBot.sendMessage(id, text, opts).catch(() => {}));
}

async function sendQRAsImage(qr) {
    try {
        const buf = await QR.toBuffer(qr, { type: 'png', width: 400, margin: 2 });
        for (const id of ADMIN_IDS) {
            await tgBot.sendPhoto(id, buf, {
                caption: '📱 اسکن کن:\nSettings → Linked Devices → Link a Device'
            }).catch(e => console.log('photo err:', e.message));
        }
    } catch (e) {
        console.error('QR image error:', e);
        sendAdmin('❌ خطا در ساخت QR');
    }
}

async function connectWA() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const sock = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Sender', 'Chrome', '1.0.0'],
        });
        sock.ev.on('creds.update', saveCreds);
        sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                console.log('📱 QR received!');
                sendQRAsImage(qr);
            }
            if (connection === 'open') {
                whatsappReady = true;
                console.log('✅ WA connected');
                sendAdmin('✅ واتساپ وصل شد!');
            }
            if (connection === 'close') {
                whatsappReady = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Closed:', code);
                if (code === DisconnectReason.loggedOut) {
                    try { fs.rmSync(AUTH_DIR, { recursive: true }); } catch(e) {}
                    sendAdmin('❌ خارج شد! /settings بزن.');
                } else if (code !== DisconnectReason.connectionClosed) {
                    setTimeout(connectWA, 5000);
                }
            }
        });
    } catch (err) {
        console.error('❌ connectWA:', err.message);
        setTimeout(connectWA, 10000);
    }
}

function randomDelay() { return DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN); }
function isAllowedTime() { const h = new Date().getHours(); return h >= 8 && h < 22; }

function resetDaily() {
    const today = new Date().toDateString();
    if (lastResetDate !== today) { messagesSentToday = 0; lastResetDate = today; sentNumbers.clear(); }
}

async function sendOne(contact, tpl) {
    let msg = tpl.replace(/{name}/g, contact.name || '').replace(/{lastname}/g, contact.lastname || '');
    const num = contact.number.replace(/[^0-9]/g, '');
    const jid = num + '@s.whatsapp.net';
    try {
        const [ok] = await waSockRef.onWhatsApp(jid);
        if (!ok.exists) return false;
        await waSockRef.sendMessage(jid, { text: msg });
        return true;
    } catch { return false; }
}

let waSockRef = null;

async function startSend(tpl) {
    if (sendingInProgress) return sendAdmin('⚠️ در حال ارسال!');
    if (!whatsappReady) return sendAdmin('⚠️ واتساپ وصل نیست!');
    if (!contacts.length) return sendAdmin('⚠️ شماره‌ای نیست!');
    sendingInProgress = true;
    resetDaily();
    let s = 0, f = 0;
    sendAdmin(`🚀 شروع! ${contacts.length} شماره`);
    for (let i = 0; i < contacts.length; i++) {
        if (!sendingInProgress || !isAllowedTime() || messagesSentToday >= MESSAGES_PER_DAY) break;
        const num = contacts[i].number.replace(/[^0-9]/g, '');
        if (sentNumbers.has(num)) continue;
        if (await sendOne(contacts[i], tpl)) { s++; messagesSentToday++; sentNumbers.add(num); } else f++;
        if (s % 5 === 0 && s > 0) sendAdmin(`📊 ${s}/${contacts.length} ✅ | ${f} ❌`);
        if (i < contacts.length - 1) await new Promise(r => setTimeout(r, randomDelay()));
    }
    sendingInProgress = false;
    sendAdmin(`✅ تمام! ✅${s} ❌${f}`);
}

// Commands
tgBot.onText(/\/start/, (m) => {
    if (!isAdmin(m.from.id)) return;
    tgBot.sendMessage(m.from.id,
        '🤖 ربات واتساپ\n\n/settings - QR جدید\n/status - وضعیت\n/send متن - ارسال\n/stop - توقف\n/contacts - شماره‌ها\n/limit - لیمیت\n/addaccess [ID] - دسترسی\n/accesslist - لیست دسترسی\n\n📎 فایل اکسل بفرست');
});

tgBot.onText(/\/settings/, (m) => {
    if (!isAdmin(m.from.id)) return;
    sendAdmin('🔄 ریستارت برای QR جدید...');
    try { fs.rmSync(AUTH_DIR, { recursive: true }); } catch(e) {}
    setTimeout(() => process.exit(0), 1000);
});

tgBot.onText(/\/status/, (m) => {
    if (!isAdmin(m.from.id)) return;
    resetDaily();
    tgBot.sendMessage(m.from.id, `📱 واتساپ: ${whatsappReady ? '✅' : '❌'}\n📋 شماره‌ها: ${contacts.length}\n📨 امروز: ${messagesSentToday}/${MESSAGES_PER_DAY}`);
});

tgBot.onText(/\/stop/, (m) => {
    if (!isAdmin(m.from.id)) return;
    sendingInProgress = false;
    tgBot.sendMessage(m.from.id, '🛑 متوقف شد.');
});

tgBot.onText(/\/send (.+)/, (m, match) => {
    if (!isAdmin(m.from.id)) return;
    if (!match[1].includes('{name}')) return tgBot.sendMessage(m.from.id, '⚠️ متن باید {name} داشته باشه');
    tgBot.sendMessage(m.from.id, '🚀 شروع...');
    startSend(match[1]);
});

tgBot.onText(/\/contacts/, (m) => {
    if (!isAdmin(m.from.id)) return;
    if (!contacts.length) return tgBot.sendMessage(m.from.id, 'خالیه.');
    let l = contacts.slice(0, 20).map((c, i) => `${i+1}. ${c.number} - ${c.name || '-'}`).join('\n');
    if (contacts.length > 20) l += `\n... +${contacts.length - 20}`;
    tgBot.sendMessage(m.from.id, `📋 (${contacts.length}):\n${l}`);
});

tgBot.onText(/\/limit/, (m) => {
    if (!isAdmin(m.from.id)) return;
    resetDaily();
    tgBot.sendMessage(m.from.id, `📊 امروز: ${messagesSentToday}/${MESSAGES_PER_DAY}\n⏰ ۳-۵ دقیقه فاصله\n🕐 ۸:۰۰-۲۲:۰۰`);
});

tgBot.onText(/\/addaccess (.+)/, (m, match) => {
    if (!isAdmin(m.from.id)) return;
    const id = parseInt(match[1]);
    if (isNaN(id) || ADMIN_IDS.includes(id)) return tgBot.sendMessage(m.from.id, '❌');
    ADMIN_IDS.push(id);
    tgBot.sendMessage(m.from.id, `✅ اضافه شد: ${id}`);
});

tgBot.onText(/\/accesslist/, (m) => {
    if (!isAdmin(m.from.id)) return;
    const l = ADMIN_IDS.map((id, i) => `${i+1}. ${id}${id === 6138410965 ? ' 👑' : ''}`).join('\n');
    tgBot.sendMessage(m.from.id, `👥 دسترسی:\n${l}`);
});

tgBot.on('document', async (m) => {
    if (!isAdmin(m.from.id)) return;
    if (!m.document.file_name.match(/\.(xlsx|xls|csv)$/i)) return tgBot.sendMessage(m.from.id, '❌ فقط اکسل');
    try {
        const file = await tgBot.getFile(m.document.file_id);
        const res = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`);
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(Buffer.from(buf));
        const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        contacts = data.map(r => ({
            number: String(r['شماره'] || r['phone'] || Object.values(r)[0] || '').trim(),
            name: String(r['اسم'] || r['name'] || r['نام'] || Object.values(r)[1] || '').trim()
        })).filter(c => c.number);
        fs.writeFileSync('./contacts.json', JSON.stringify(contacts, null, 2));
        tgBot.sendMessage(m.from.id, `✅ ${contacts.length} شماره آپلود شد`);
    } catch (e) { tgBot.sendMessage(m.from.id, `❌ ${e.message}`); }
});

// START
(async () => {
    console.log('🚀 Starting...');
    if (fs.existsSync('./contacts.json')) contacts = JSON.parse(fs.readFileSync('./contacts.json', 'utf8'));
    await connectWA();
    sendAdmin('🤖 ربات آماده!\n/settings بزن تا QR بیاد → اسکن کن → فایل اکسل بفرست → /send سلام {name} ...');
})().catch(e => { console.error('💀', e); process.exit(1); });
