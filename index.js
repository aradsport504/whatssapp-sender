const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const XLSX = require('xlsx');
const fs = require('fs');
const http = require('http');
const pino = require('pino');
const QR = require('qrcode');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '';
if (!TG_TOKEN) { console.error('❌ TELEGRAM_TOKEN env missing!'); process.exit(1); }
let ADMINS = (process.env.ADMIN_IDS || '6138410965').split(',').map(Number);
try {
    if (fs.existsSync('./access.json')) {
        const extra = JSON.parse(fs.readFileSync('./access.json', 'utf8'));
        if (Array.isArray(extra)) ADMINS = [...new Set([...ADMINS, ...extra])];
    }
} catch(e) {}
const AUTH_DIR = './auth_info';

http.createServer((_, res) => { res.writeHead(200); res.end('OK'); }).listen(process.env.PORT || 3000);

// ============ STATE ============
let waReady = false;
let contacts = [];       // اکسل ذخیره‌شده در حافظه
let sending = false;
let sock = null;
let connecting = false;
let reconnectTimer = null;
let qrSent = false;
let sendQueue = [];
let sendResumeTimer = null;
let convState = {};      // مکالمه مرحله‌ای

const tg = new TelegramBot(TG_TOKEN, { polling: true });
const isAdmin = (id) => ADMINS.includes(id);
const tell = (t, opts) => ADMINS.forEach(id => tg.sendMessage(id, t, opts).catch(() => {}));

// ============ CONNECT ============
async function connectWA() {
    if (connecting) return;
    connecting = true;
    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();
        const s = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
            version, printQRInTerminal: false, logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Sender', 'Chrome', '1.0.0'], connectTimeout: 60000, defaultQueryTimeoutMs: undefined,
        });
        sock = s;
        s.ev.on('creds.update', saveCreds);
        s.ev.on('connection.update', async (u) => {
            const { connection, lastDisconnect, qr } = u;
            if (qr && !qrSent) {
                qrSent = true;
                const buf = await QR.toBuffer(qr, { type: 'png', width: 400, margin: 2 });
                for (const id of ADMINS) await tg.sendPhoto(id, buf, { caption: '📱 اسکن کن:\nSettings → Linked Devices → Link a Device' }).catch(() => {});
            }
            if (connection === 'open') { waReady = true; connecting = false; qrSent = false; tell('✅ واتساپ وصل شد! 🎉'); }
            if (connection === 'close') {
                waReady = false; connecting = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                if (code === 401) { try { fs.rmSync(AUTH_DIR, { recursive: true }); } catch(e) {} tell('❌ خارج شد. /qr یا /pair.'); }
                else if (code === 405 || code === 440) tell('⚠️ بلاک شد. /qr یا /pair.');
                else reconnectTimer = setTimeout(connectWA, 5000);
            }
        });
    } catch (err) { connecting = false; reconnectTimer = setTimeout(connectWA, 5000); }
}

function restartWA(msg) {
    tell(msg || '🔄 ریستارت...');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (sock) { try { sock.end(undefined); } catch(e) {} sock = null; }
    waReady = false; connecting = false; qrSent = false;
    try { fs.rmSync(AUTH_DIR, { recursive: true }); } catch(e) {}
    setTimeout(connectWA, 2000);
}

// ============ SMART SEND ============
function normNum(raw) {
    let d = String(raw || '').replace(/[^0-9]/g, '');
    if (d.startsWith('0098')) d = d.slice(2);
    else if (d.startsWith('98')) d = d;                    // 98912... (already intl)
    else if (d.startsWith('0')) d = '98' + d.slice(1);     // 0912... → 98912...
    return d;
}
function dispNum(intl) {
    return intl.startsWith('98') ? '0' + intl.slice(2) : intl;  // 98912... → 0912...
}
function toJid(raw) { return normNum(raw) + '@s.whatsapp.net'; }
function randomBetween(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function isAllowedTime() { return new Date().getHours() >= 8 && new Date().getHours() < 23; }
function getTomorrow8am() { const t = new Date(); t.setDate(t.getDate() + 1); t.setHours(8, 0, 0, 0); return t; }

async function sendOneMessage(contact, tpl) {
    let msg = tpl.replace(/{name}/g, contact.name || '')
                 .replace(/{lastname}/g, contact.lastname || '')
                 .replace(/{code}/g, contact.code || '')
                 .replace(/{کد اشتراک}/g, contact.code || '');
    const num = normNum(contact.number);
    try {
        const [r] = await sock.onWhatsApp(num + '@s.whatsapp.net');
        if (!r.exists) return { ok: false };
        await sock.sendMessage(num + '@s.whatsapp.net', { text: msg });
        return { ok: true };
    } catch { return { ok: false }; }
}

async function smartSend(template) {
    if (sending) return tell('⚠️ در حال ارسال!');
    if (!waReady || !sock) return tell('⚠️ واتساپ وصل نیست!');
    if (!sendQueue.length) return tell('⚠️ لیست خالیه!');
    sending = true;

    let startIdx = 0;
    const sv0 = loadProgress();
    if (sv0 && Array.isArray(sv0.queue) && sv0.queue.length === sendQueue.length &&
        sv0.queue.every((c, j) => c.number === sendQueue[j].number)) {
        startIdx = sv0.sent || 0;
        if (startIdx > 0) tell(`📊 ادامه از ${startIdx + 1}`);
    }

    let sent = 0, failed = 0;
    const total = sendQueue.length;
    tell(`🚀 شروع!\n📱 ${total} پیام\n⏰ ۸ صبح تا ۱۱ شب\n🔄 فاصله: ۹۰-۹۰۰ ثانیه رندوم`);

    for (let i = startIdx; i < sendQueue.length; i++) {
        if (!sending) { tell('🛑 متوقف شد.'); break; }
        if (!isAllowedTime()) {
            sending = false;
            const waitMs = getTomorrow8am() - new Date();
            tell(`⏸️ ۱۱ شب شد!\n📅 فردا ۸ صبح ادامه\n📊 ✅${sent} ❌${failed} | باقی: ${sendQueue.length - i}`);
            saveProgress(sendQueue, i, template);
            sendResumeTimer = setTimeout(() => { tell('☀️ صبح بخیر! ادامه...'); sendQueue = sendQueue.slice(i); smartSend(template); }, waitMs);
            return;
        }
        const num = normNum(sendQueue[i].number);
        const result = await sendOneMessage(sendQueue[i], template);
        result.ok ? sent++ : failed++;
        if ((sent + failed) % 10 === 0) tell(`📊 ${sent + failed}/${total} ✅${sent} ❌${failed}`);
        saveProgress(sendQueue, i + 1, template);
        if (i < sendQueue.length - 1) await new Promise(r => setTimeout(r, randomBetween(90, 900) * 1000));
    }

    sending = false; sendQueue = [];
    try { fs.unlinkSync('./send_progress.json'); } catch(e) {}
    tell(`✅ تمام شد!\n📊 ✅${sent} ❌${failed} از ${total}`);
}

function saveProgress(queue, sent, template) {
    try { fs.writeFileSync('./send_progress.json', JSON.stringify({ queue, sent, messageTemplate: template, ts: new Date().toISOString() })); } catch(e) {}
}
function loadProgress() {
    try { return JSON.parse(fs.readFileSync('./send_progress.json', 'utf8')); } catch(e) { return null; }
}

// ============ DOCUMENT HANDLER ============
tg.on('document', async (m) => {
    if (!isAdmin(m.from.id)) return;
    if (!m.document.file_name.match(/\.(xlsx|xls|csv)$/i)) return tg.sendMessage(m.from.id, '❌ فقط اکسل یا CSV');
    try {
        const file = await tg.getFile(m.document.file_id);
        const res = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${file.file_path}`);
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(Buffer.from(buf));
        const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
        contacts = data.map(r => {
            const first = String(r['نام'] || r['اسم'] || r['name'] || r['نام مشتری'] || Object.values(r)[1] || '').trim();
            const last = String(r['نام خانوادگی'] || r['نام‌خانوادگی'] || r['lastname'] || r['family'] || '').trim();
            return {
                number: normNum(String(r['شماره'] || r['phone'] || r['موبایل'] || Object.values(r)[0] || '').trim()),
                name: [first, last].filter(Boolean).join(' '),
                lastname: last,
                code: String(r['کد اشتراک'] || r['کد'] || r['code'] || r['اشتراک'] || '').trim()
            };
        }).filter(c => c.number && c.number.length >= 10);
        fs.writeFileSync('./contacts.json', JSON.stringify(contacts, null, 2));
        const sample = contacts.slice(0, 5).map((c, i) => `${i + 1}. ${dispNum(c.number)}${c.code ? ` (اشتراک: ${c.code})` : ''} - ${c.name || '—'}`).join('\n');
        tg.sendMessage(m.from.id,
            `✅ ${contacts.length} شماره ذخیره شد!\n\n${sample}${contacts.length > 5 ? `\n... +${contacts.length - 5}` : ''}\n\n/upload مجدد برای آپلود جدید`);
    } catch (e) { tg.sendMessage(m.from.id, `❌ ${e.message}`); }
});

// ============ CONVERSATION HANDLER ============
tg.on('message', (m) => {
    if (!isAdmin(m.from.id)) return;
    const st = convState[m.from.id];
    if (!st) return;
    const text = m.text;
    if (!text || text.startsWith('/')) return;

    // /send flow: template → range
    if (st.step === 'template') {
        st.template = text;
        st.step = 'range';
        tg.sendMessage(m.from.id, `📝 متن: ${text}\n\n📏 محدوده رو بفرست:\n• رنج سطر: ۱۰۰-۲۰۰\n• لیست سطر: ۱۱۱, ۲۵۰, ۳۴۵\n• کد اشتراک: 4521, 7830`);
        return;
    }
    if (st.step === 'range') {
        delete convState[m.from.id];
        sendQueue = parseRange(text);
        if (!sendQueue.length) return tg.sendMessage(m.from.id, '❌ هیچ شماره‌ای پیدا نشد.');
        const preview = st.template.replace(/{name}/g, 'نام‌مشتری').replace(/{code}/g, 'کد‌اشتراک');
        const sample = sendQueue.slice(0, 3).map((c, i) => `${i + 1}. ${dispNum(c.number)}${c.code ? ` (اشتراک: ${c.code})` : ''} - ${c.name || '—'}`).join('\n');
        tg.sendMessage(m.from.id,
            `📋 پیش‌نمایش:\n📝 ${preview}\n\n👥 ${sendQueue.length} نفر:\n${sample}${sendQueue.length > 3 ? `\n... +${sendQueue.length - 3}` : ''}\n\n✅ تأیید؟ (بله/خیر)`);
        st.pendingTemplate = st.template;
        st.pendingQueue = [...sendQueue];
        convState[m.from.id] = { step: 'confirm', pendingTemplate: st.pendingTemplate, pendingQueue: st.pendingQueue };
        return;
    }
    if (st.step === 'confirm') {
        delete convState[m.from.id];
        if (text === 'بله' || text === 'yes' || text === 'ok') {
            sendQueue = st.pendingQueue;
            smartSend(st.pendingTemplate);
        } else tg.sendMessage(m.from.id, '❌ لغو شد.');
        return;
    }

    // /test flow
    if (st.step === 'number') {
        const num = normNum(text);
        if (num.length < 12) return tg.sendMessage(m.from.id, '❌ شماره نامعتبر.');
        st.number = num; st.step = 'message';
        tg.sendMessage(m.from.id, `📞 ${dispNum(num)}\n\n📝 پیام رو بنویس:`);
        return;
    }
    if (st.step === 'message') {
        delete convState[m.from.id];
        if (!waReady || !sock) return tg.sendMessage(m.from.id, '⚠️ واتساپ وصل نیست!');
        const jid = st.number + '@s.whatsapp.net';
        sock.onWhatsApp(jid).then(([r]) => {
            if (!r.exists) return tg.sendMessage(m.from.id, `❌ ${st.number} واتساپ نداره`);
            return sock.sendMessage(jid, { text });
        }).then(() => tg.sendMessage(m.from.id, `✅ فرستاده شد! 📞 ${st.number}`))
          .catch(e => tg.sendMessage(m.from.id, `❌ ${e.message}`));
    }
});

function parseRange(text) {
    // رنج سطری: 100-200
    if (text.includes('-')) {
        const [a, b] = text.split('-').map(s => parseInt(s.trim()));
        if (!isNaN(a) && !isNaN(b) && a <= b) return contacts.slice(a - 1, b);
    }
    const parts = text.split(/[,،\s]+/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) return [];
    // اول: تطبیق با کد اشتراک
    const byCode = [];
    parts.forEach(p => {
        const hit = contacts.find(c => c.code && c.code === p);
        if (hit) byCode.push(hit);
    });
    if (byCode.length) return byCode;
    // بعد: شماره سطر (111, 250, 345)
    const nums = parts.map(s => parseInt(s)).filter(n => !isNaN(n));
    if (nums.length) {
        const found = [];
        nums.forEach(n => { if (contacts[n - 1]) found.push(contacts[n - 1]); });
        return found;
    }
    return [];
}

// ============ COMMANDS ============
tg.onText(/\/start/, (m) => {
    if (!isAdmin(m.from.id)) return;
    tg.sendMessage(m.from.id,
        '🤖 ربات واتساپ\n\n' +
        '/upload - آپلود اکسل\n' +
        '/clear - پاک کردن اکسل\n' +
        '/qr - QR کد\n' +
        '/pair - Pairing\n' +
        '/send - ارسال (مرحله‌ای)\n' +
        '/resume - ادامه\n' +
        '/new - شروع جدید\n' +
        '/test - تست تکی\n' +
        '/status - وضعیت\n' +
        '/stop - توقف\n' +
        '/contacts - لیست شماره‌ها\n' +
        '/accesslist - لیست ادمین‌ها\n' +
        '/limit - لیمیت‌ها');
});

// /upload → فقط آپلود اکسل
tg.onText(/\/upload/, (m) => {
    if (!isAdmin(m.from.id)) return;
    tg.sendMessage(m.from.id, '📎 فایل اکسل بفرست.\n\nستون‌ها: شماره (09...), نام, نام خانوادگی, کد اشتراک');
});

// /clear → پاک کردن اکسل از حافظه
tg.onText(/\/clear/, (m) => {
    if (!isAdmin(m.from.id)) return;
    contacts = [];
    try { fs.unlinkSync('./contacts.json'); } catch(e) {}
    tg.sendMessage(m.from.id, '🗑️ اکسل پاک شد.');
});

// /qr
tg.onText(/\/qr/, (m) => { if (isAdmin(m.from.id)) restartWA('🔄 ریستارت برای QR...'); });

// /pair — pairing code must be requested WHILE connecting, not after open
let pairTimer = null;
tg.onText(/\/pair/, (m) => {
    if (!isAdmin(m.from.id)) return;
    if (!MY_NUMBER) return tg.sendMessage(m.from.id, '⚠️ MY_NUMBER نیست! اول وریبل MY_NUMBER رو تنظیم کن.');
    restartWA('🔄 ریستارت برای Pairing...');
    if (pairTimer) { clearInterval(pairTimer); pairTimer = null; }
    let tries = 0;
    pairTimer = setInterval(async () => {
        tries++;
        if (waReady) { clearInterval(pairTimer); pairTimer = null; return; }
        if (sock && !waReady) {
            try {
                const code = await sock.requestPairingCode(MY_NUMBER);
                clearInterval(pairTimer); pairTimer = null;
                tell(`🔑 کد Pairing:\n\n*${code}*\n\n📞 واتساپ → Linked Devices → Link with Phone Number`, { parse_mode: 'Markdown' });
                return;
            } catch(e) { /* socket not ready yet, retry */ }
        }
        if (tries >= 30) { clearInterval(pairTimer); pairTimer = null; tell('❌ Pairing timeout شد. دوباره /pair بزن.'); }
    }, 1000);
});

// /send → مرحله‌ای: متن → محدوده → تأیید
tg.onText(/\/send/, (m) => {
    if (!isAdmin(m.from.id)) return;
    if (!contacts.length) return tg.sendMessage(m.from.id, '⚠️ اکسل آپلود نشده! /upload بزن.');
    if (!waReady) return tg.sendMessage(m.from.id, '⚠️ واتساپ وصل نیست!');
    convState[m.from.id] = { step: 'template' };
    tg.sendMessage(m.from.id,
        '📝 متن پیام رو بنویس.\n\n' +
        'برای اسم: `{name}`\n' +
        'برای کد اشتراک: `{code}`\n' +
        'مثال: سلام {name} عزیز، کد اشتراک شما {code} است!');
});

// /resume — restores the SAVED queue (same range), not the whole contacts list
tg.onText(/\/resume/, (m) => {
    if (!isAdmin(m.from.id)) return;
    const sv = loadProgress();
    if (!sv || !Array.isArray(sv.queue) || !sv.queue.length) return tg.sendMessage(m.from.id, '❌ ارسال قبلی نیست.');
    sendQueue = sv.queue;
    tell(`🔄 ادامه از ${sv.sent + 1}...`);
    smartSend(sv.messageTemplate);
});

// /new
tg.onText(/\/new/, (m) => {
    if (!isAdmin(m.from.id)) return;
    try { fs.unlinkSync('./send_progress.json'); } catch(e) {}
    tg.sendMessage(m.from.id, '✅ پاک شد.');
});

// /test → دو مرحله‌ای
tg.onText(/\/test/, (m) => {
    if (!isAdmin(m.from.id)) return;
    convState[m.from.id] = { step: 'number' };
    tg.sendMessage(m.from.id, '📞 شماره واتساپ:');
});

// /status
tg.onText(/\/status/, (m) => {
    if (!isAdmin(m.from.id)) return;
    let s = `📱 واتساپ: ${waReady ? '✅' : '❌'}\n📋 اکسل: ${contacts.length} شماره`;
    if (sending) s += `\n🔄 در حال ارسال...`;
    const sv = loadProgress();
    if (sv && sv.queue) {
        s += `\n⏸️ ناقص: از ${sv.sent + 1} (از ${sv.queue.length} نفر)`;
    }
    tg.sendMessage(m.from.id, s);
});

tg.onText(/\/stop/, (m) => {
    if (!isAdmin(m.from.id)) return;
    sending = false;
    if (sendResumeTimer) { clearTimeout(sendResumeTimer); sendResumeTimer = null; }
    tg.sendMessage(m.from.id, '🛑 متوقف شد.');
});

tg.onText(/\/contacts/, (m) => {
    if (!isAdmin(m.from.id)) return;
    if (!contacts.length) return tg.sendMessage(m.from.id, 'خالیه.');
    let l = contacts.slice(0, 20).map((c, i) => `${i + 1}. ${dispNum(c.number)}${c.code ? ` (اشتراک: ${c.code})` : ''} - ${c.name || '—'}`).join('\n');
    if (contacts.length > 20) l += `\n... +${contacts.length - 20}`;
    tg.sendMessage(m.from.id, `📋 (${contacts.length}):\n${l}`);
});

// /accesslist + /addaccess (persisted in access.json)
tg.onText(/\/accesslist/, (m) => {
    if (!isAdmin(m.from.id)) return;
    tg.sendMessage(m.from.id, `👥 ادمین‌ها:\n${ADMINS.map((a, i) => `${i + 1}. ${a}`).join('\n')}`);
});

tg.onText(/\/addaccess (.+)/, (m, match) => {
    if (!isAdmin(m.from.id)) return;
    const id = parseInt(match[1].trim());
    if (isNaN(id)) return tg.sendMessage(m.from.id, '❌ آیدی نامعتبر. مثال: /addaccess 123456789');
    if (ADMINS.includes(id)) return tg.sendMessage(m.from.id, 'ℹ️ این آیدی قبلاً ادمینه.');
    ADMINS.push(id);
    try {
        const base = (process.env.ADMIN_IDS || '6138410965').split(',').map(Number);
        fs.writeFileSync('./access.json', JSON.stringify(ADMINS.filter(a => !base.includes(a))));
    } catch(e) { return tg.sendMessage(m.from.id, '❌ ذخیره نشد: ' + e.message); }
    tg.sendMessage(m.from.id, `✅ ${id} ادمین شد.`);
});

tg.onText(/\/limit/, (m) => {
    if (!isAdmin(m.from.id)) return;
    tg.sendMessage(m.from.id, '⏰ ۸ صبح - ۱۱ شب\n🔄 ۹۰-۹۰۰ ثانیه رندوم\n📅 ناقص → فردا ۸ صبح');
});

// ============ START ============
console.log('🚀 Starting...');
if (fs.existsSync('./contacts.json')) contacts = JSON.parse(fs.readFileSync('./contacts.json', 'utf8'));
connectWA();
tell('🤖 ربات آماده!\n\n/upload - آپلود اکسل\n/send - ارسال\n/test - تست تکی');
