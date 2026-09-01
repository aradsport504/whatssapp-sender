const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const XLSX = require('xlsx');
const fs = require('fs');
const http = require('http');
const pino = require('pino');
const QR = require('qrcode');
const { ProxyAgent } = require('proxy-agent');

// ============ CONFIG ============
const TG_TOKEN = process.env.TELEGRAM_TOKEN || '8902204232:AAEw0N7UR1amMKO9xuGV8KkHyS-kym7sCmk';
const ADMINS = (process.env.ADMIN_IDS || '6138410965').split(',').map(Number);
const PROXY_URL = process.env.PROXY_URL || ''; // socks5://user:pass@host:port  or  http://user:pass@host:port
const MAX_MSGS = 35;
const DELAY_MIN = 3 * 60 * 1000;
const DELAY_MAX = 5 * 60 * 1000;
const AUTH_DIR = './auth_info';

// Health check
http.createServer((_, res) => { res.writeHead(200); res.end('OK'); }).listen(process.env.PORT || 3000);

// ============ STATE ============
let waReady = false;
let contacts = [];
let sentNums = new Set();
let sending = false;
let sentToday = 0;
let lastDay = '';
let sock = null;
let connecting = false;
let reconnectTimer = null;

const tg = new TelegramBot(TG_TOKEN, { polling: true });
const isAdmin = (id) => ADMINS.includes(id);
const tell = (t) => ADMINS.forEach(id => tg.sendMessage(id, t).catch(() => {}));

// ============ PROXY ============
let proxyAgent = null;
if (PROXY_URL) {
    try {
        proxyAgent = new ProxyAgent(PROXY_URL);
        console.log('🌐 Proxy configured:', PROXY_URL.replace(/\/\/.*@/, '//***@'));
    } catch (e) {
        console.error('❌ Proxy error:', e.message);
    }
} else {
    console.log('⚠️ No PROXY_URL set — WhatsApp may block cloud IP');
}

// ============ QR → Telegram ============
async function sendQR(data) {
    try {
        const buf = await QR.toBuffer(data, { type: 'png', width: 400, margin: 2 });
        for (const id of ADMINS) {
            await tg.sendPhoto(id, buf, {
                caption: '📱 اسکن کن:\nSettings → Linked Devices → Link a Device'
            }).catch(e => console.log('photo err:', e.message));
        }
        console.log('✅ QR sent to Telegram');
    } catch (e) {
        console.error('QR err:', e.message);
    }
}

// ============ CONNECT WHATSAPP ============
function connectWA() {
    if (connecting) return;
    connecting = true;
    console.log('🔄 connectWA() proxy:', proxyAgent ? 'YES' : 'NO');

    useMultiFileAuthState(AUTH_DIR).then(({ state, saveCreds }) => {
        const opts = {
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
            },
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Sender', 'Chrome', '1.0.0'],
            connectTimeout: 60000,
            defaultQueryTimeoutMs: 120000,
        };

        if (proxyAgent) {
            opts.agent = proxyAgent;
        }

        const s = makeWASocket(opts);
        sock = s;

        s.ev.on('creds.update', saveCreds);

        s.ev.on('connection.update', (u) => {
            const { connection, lastDisconnect, qr } = u;

            if (qr) {
                console.log('📱 QR RECEIVED!');
                connecting = false;
                sendQR(qr);
            }

            if (connection === 'open') {
                waReady = true;
                connecting = false;
                console.log('✅ WA CONNECTED');
                tell('✅ واتساپ وصل شد!');
            }

            if (connection === 'close') {
                waReady = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Close code:', code);

                // 405/440 = connectionReplaced — DON'T reconnect
                if (code === 440 || code === 405) {
                    connecting = false;
                    tell('⚠️ session جایگزین شد.\nLinked Devices رو چک کن.\n/settings بزن.');
                    return;
                }

                // 401 = loggedOut
                if (code === 401) {
                    connecting = false;
                    try { fs.rmSync(AUTH_DIR, { recursive: true }); } catch(e) {}
                    tell('❌ خارج شد. /settings بزن.');
                    return;
                }

                // Other — reconnect
                connecting = false;
                if (reconnectTimer) clearTimeout(reconnectTimer);
                reconnectTimer = setTimeout(connectWA, 5000);
            }
        });
    }).catch(err => {
        console.error('❌ Auth err:', err.message);
        connecting = false;
        try { fs.rmSync(AUTH_DIR, { recursive: true }); } catch(e) {}
        reconnectTimer = setTimeout(connectWA, 5000);
    });
}

function restartWA() {
    tell('🔄 ریستارت...');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (sock) { try { sock.end(undefined); } catch(e) {} sock = null; }
    waReady = false;
    connecting = false;
    try { fs.rmSync(AUTH_DIR, { recursive: true }); } catch(e) {}
    setTimeout(connectWA, 2000);
}

// ============ MESSAGING ============
function randDelay() { return DELAY_MIN + Math.random() * (DELAY_MAX - DELAY_MIN); }
function allowed() { const h = new Date().getHours(); return h >= 8 && h < 22; }
function resetDay() { const d = new Date().toDateString(); if (lastDay !== d) { sentToday = 0; lastDay = d; sentNums.clear(); } }

async function sendOne(c, tpl) {
    const msg = tpl.replace(/{name}/g, c.name || '').replace(/{lastname}/g, c.lastname || '');
    const num = c.number.replace(/[^0-9]/g, '');
    try {
        const [r] = await sock.onWhatsApp(num + '@s.whatsapp.net');
        if (!r.exists) return false;
        await sock.sendMessage(num + '@s.whatsapp.net', { text: msg });
        return true;
    } catch { return false; }
}

async function startSend(tpl) {
    if (sending) return tell('⚠️ در حال ارسال!');
    if (!waReady || !sock) return tell('⚠️ واتساپ وصل نیست!');
    if (!contacts.length) return tell('⚠️ شماره‌ای نیست!');
    sending = true; resetDay();
    let s = 0, f = 0;
    tell(`🚀 شروع! ${contacts.length} شماره`);
    for (let i = 0; i < contacts.length; i++) {
        if (!sending || !allowed() || sentToday >= MAX_MSGS) break;
        const num = contacts[i].number.replace(/[^0-9]/g, '');
        if (sentNums.has(num)) continue;
        if (await sendOne(contacts[i], tpl)) { s++; sentToday++; sentNums.add(num); } else f++;
        if (s > 0 && s % 5 === 0) tell(`📊 ${s}/${contacts.length} ✅ | ${f} ❌`);
        if (i < contacts.length - 1) await new Promise(r => setTimeout(r, randDelay()));
    }
    sending = false;
    tell(`✅ تمام! ✅${s} ❌${f}`);
}

// ============ COMMANDS ============
tg.onText(/\/start/, (m) => {
    if (!isAdmin(m.from.id)) return;
    tg.sendMessage(m.from.id,
        '🤖 ربات واتساپ\n\n' +
        '/settings - ریستارت + QR جدید\n' +
        '/status - وضعیت\n' +
        '/send متن - ارسال ({name})\n' +
        '/stop - توقف\n' +
        '/contacts - شماره‌ها\n' +
        '/limit - لیمیت\n' +
        '/addaccess [ID]\n' +
        '/accesslist\n\n' +
        '📎 فایل اکسل بفرست');
});

tg.onText(/\/settings/, (m) => {
    if (!isAdmin(m.from.id)) return;
    restartWA();
});

tg.onText(/\/status/, (m) => {
    if (!isAdmin(m.from.id)) return;
    resetDay();
    tg.sendMessage(m.from.id,
        `📱 واتساپ: ${waReady ? '✅ وصل' : '❌ قطع'}\n📋 شماره‌ها: ${contacts.length}\n📨 امروز: ${sentToday}/${MAX_MSGS}`);
});

tg.onText(/\/stop/, (m) => {
    if (!isAdmin(m.from.id)) return;
    sending = false;
    tg.sendMessage(m.from.id, '🛑 متوقف شد.');
});

tg.onText(/\/send (.+)/, (m, match) => {
    if (!isAdmin(m.from.id)) return;
    if (!match[1].includes('{name}'))
        return tg.sendMessage(m.from.id, '⚠️ متن باید {name} داشته باشه');
    tg.sendMessage(m.from.id, '🚀 شروع...');
    startSend(match[1]);
});

tg.onText(/\/contacts/, (m) => {
    if (!isAdmin(m.from.id)) return;
    if (!contacts.length) return tg.sendMessage(m.from.id, 'خالیه.');
    let l = contacts.slice(0, 20).map((c, i) => `${i+1}. ${c.number} - ${c.name || '-'}`).join('\n');
    if (contacts.length > 20) l += `\n... +${contacts.length - 20}`;
    tg.sendMessage(m.from.id, `📋 (${contacts.length}):\n${l}`);
});

tg.onText(/\/limit/, (m) => {
    if (!isAdmin(m.from.id)) return;
    resetDay();
    tg.sendMessage(m.from.id, `📊 امروز: ${sentToday}/${MAX_MSGS}\n⏰ ۳-۵ دقیقه\n🕐 ۸-۲۲`);
});

tg.onText(/\/addaccess (.+)/, (m, match) => {
    if (!isAdmin(m.from.id)) return;
    const id = parseInt(match[1]);
    if (isNaN(id) || ADMINS.includes(id)) return tg.sendMessage(m.from.id, '❌');
    ADMINS.push(id);
    tg.sendMessage(m.from.id, `✅ ${id} اضافه شد`);
});

tg.onText(/\/accesslist/, (m) => {
    if (!isAdmin(m.from.id)) return;
    tg.sendMessage(m.from.id, ADMINS.map((id, i) => `${i+1}. ${id}${id === 6138410965 ? ' 👑' : ''}`).join('\n'));
});

tg.on('document', async (m) => {
    if (!isAdmin(m.from.id)) return;
    if (!m.document.file_name.match(/\.(xlsx|xls|csv)$/i)) return tg.sendMessage(m.from.id, '❌ فقط اکسل');
    try {
        const file = await tg.getFile(m.document.file_id);
        const res = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${file.file_path}`);
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(Buffer.from(buf));
        const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        contacts = data.map(r => ({
            number: String(r['شماره'] || r['phone'] || Object.values(r)[0] || '').trim(),
            name: String(r['اسم'] || r['name'] || r['نام'] || Object.values(r)[1] || '').trim()
        })).filter(c => c.number);
        fs.writeFileSync('./contacts.json', JSON.stringify(contacts, null, 2));
        tg.sendMessage(m.from.id, `✅ ${contacts.length} شماره`);
    } catch (e) { tg.sendMessage(m.from.id, `❌ ${e.message}`); }
});

// ============ START ============
console.log('🚀 Starting...');
if (fs.existsSync('./contacts.json')) {
    contacts = JSON.parse(fs.readFileSync('./contacts.json', 'utf8'));
    console.log(`📋 ${contacts.length} contacts`);
}
connectWA();
tell('🤖 ربات آماده!\n/settings بزن');
