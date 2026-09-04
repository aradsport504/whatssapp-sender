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
function faToEn(s) {
    return String(s || '')
        .replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
        .replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
}
function normNum(raw) {
    let d = faToEn(raw).replace(/[^0-9]/g, '');
    if (d.startsWith('0098')) d = d.slice(2);
    else if (d.startsWith('98')) d = d;                    // 98912... (already intl)
    else if (d.startsWith('0')) d = '98' + d.slice(1);     // 0912... → 98912...
    else if (d.length === 10 && d.startsWith('9')) d = '98' + d;  // صفر اول تو اکسل افتاده
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
                 .replace(/{نام}/g, contact.name || '')
                 .replace(/{lastname}/g, contact.lastname || '')
                 .replace(/{نام خانوادگی}/g, contact.lastname || '')
                 .replace(/{نام‌خانوادگی}/g, contact.lastname || '');
    const num = normNum(contact.number);
    try {
        const [r] = await sock.onWhatsApp(num + '@s.whatsapp.net');
        if (!r || !r.exists) return { ok: false, reason: 'no-wa' };
        await sock.sendMessage(num + '@s.whatsapp.net', { text: msg });
        return { ok: true };
    } catch (e) {
        const msgErr = String(e?.message || e);
        if (/rate|limit|429|too many|flood|blocked|banned|ban/i.test(msgErr)) return { ok: false, reason: 'limited', error: msgErr };
        if (!waReady || !sock) return { ok: false, reason: 'down', error: msgErr };
        return { ok: false, reason: 'error', error: msgErr };
    }
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

    let sent = 0, skippedNoWa = 0, failed = 0;
    const total = sendQueue.length;
    tell(`🚀 شروع!\n📱 ${total} پیام\n⏰ ۸ صبح تا ۱۱ شب\n🔄 فاصله: ۹۰-۹۰۰ ثانیه رندوم`);

    for (let i = startIdx; i < sendQueue.length; i++) {
        if (!sending) { tell('🛑 متوقف شد.'); break; }
        if (!isAllowedTime()) {
            sending = false;
            const waitMs = getTomorrow8am() - new Date();
            tell(`⏸️ ۱۱ شب شد!\n📅 فردا ۸ صبح ادامه\n📊 ✅${sent} ⏭️${skippedNoWa} ❌${failed} | باقی: ${sendQueue.length - i}`);
            saveProgress(sendQueue, i, template);
            sendResumeTimer = setTimeout(() => { tell('☀️ صبح بخیر! ادامه...'); sendQueue = sendQueue.slice(i); smartSend(template); }, waitMs);
            return;
        }
        const result = await sendOneMessage(sendQueue[i], template);
        if (result.ok) sent++;
        else if (result.reason === 'no-wa') skippedNoWa++;   // واتساپ نداره → رد شو، ادامه بده
        else if (result.reason === 'limited' || result.reason === 'down') {
            // لیمیت واتساپ یا قطع اتصال → وایسا، پیشرفت ذخیره‌ست، با /resume ادامه بده
            sending = false;
            saveProgress(sendQueue, i, template);
            tell(`⛔ ${result.reason === 'limited' ? 'واتساپ لیمیت داد! فعلاً وایسادم.' : 'اتصال واتساپ قطع شد!'}\n📊 ✅${sent} ⏭️${skippedNoWa} ❌${failed} | باقی: ${sendQueue.length - i}\n🔄 بعداً با /resume ادامه بده.`);
            return;
        }
        else failed++;
        const done = sent + skippedNoWa + failed;
        if (done % 10 === 0) tell(`📊 ${done}/${total} ✅${sent} ⏭️${skippedNoWa} ❌${failed}`);
        saveProgress(sendQueue, i + 1, template);
        if (i < sendQueue.length - 1) await new Promise(r => setTimeout(r, randomBetween(90, 900) * 1000));
    }

    sending = false; sendQueue = [];
    try { fs.unlinkSync('./send_progress.json'); } catch(e) {}
    tell(`✅ تمام شد!\n📊 ✅${sent} ⏭️${skippedNoWa} (بدون واتساپ) ❌${failed} از ${total}`);
}

function saveProgress(queue, sent, template) {
    try { fs.writeFileSync('./send_progress.json', JSON.stringify({ queue, sent, messageTemplate: template, ts: new Date().toISOString() })); } catch(e) {}
}
function loadProgress() {
    try { return JSON.parse(fs.readFileSync('./send_progress.json', 'utf8')); } catch(e) { return null; }
}

// نرمالایز اسم ستون: فارسی→انگلیسی، حذف فاصله و نیم‌فاصله و حروف نامرئی
function normHeader(h) {
    return faToEn(String(h || '')).replace(/[\s\u200c\u200d\u200e\u200f\ufeff_\-\.]+/g, '').toLowerCase();
}
const COL_ALIASES = {
    code: ['کد اشتراک', 'کد', 'اشتراک', 'code', 'subscription', 'subscriptioncode', 'id'],
    first: ['نام', 'اسم', 'name', 'firstname', 'نام مشتری', 'ناممشتری'],
    last: ['نام خانوادگی', 'نامخانوادگی', 'lastname', 'family', 'فامیل'],
    phone: ['شماره', 'شماره تماس', 'شماره موبایل', 'شماره تلفن', 'تلفن', 'موبایل', 'phone', 'mobile', 'phonenumber', 'tel']
};
const COL_DEFAULT_POS = ['code', 'first', 'last', 'phone'];  // ترتیب پیش‌فرض ستون‌ها
function detectColumns(keys) {
    const norm = keys.map(normHeader);
    const aliasNorm = {};
    for (const role in COL_ALIASES) aliasNorm[role] = COL_ALIASES[role].map(normHeader);
    const assigned = {}, usedRoles = new Set();
    keys.forEach((k, i) => {
        for (const role in aliasNorm) {
            if (!usedRoles.has(role) && aliasNorm[role].includes(norm[i])) {
                assigned[i] = role; usedRoles.add(role); break;
            }
        }
    });
    // ستون‌های تشخیص‌داده‌نشده → بر اساس موقعیت پیش‌فرض
    keys.forEach((k, i) => {
        if (!assigned[i] && i < COL_DEFAULT_POS.length && !usedRoles.has(COL_DEFAULT_POS[i])) {
            assigned[i] = COL_DEFAULT_POS[i]; usedRoles.add(COL_DEFAULT_POS[i]);
        }
    });
    return assigned;  // {columnIndex: role}
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
        const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
        if (!data.length) return tg.sendMessage(m.from.id, '❌ اکسل خالیه یا شیت اول خونده نشد.');
        const keys = Object.keys(data[0]);
        const headers = keys.join(' | ');
        const colMap = detectColumns(keys);  // {index: role}
        let skipped = 0;
        contacts = data.map(r => {
            const vals = keys.map(k => String(r[k] ?? '').trim());
            const get = (role) => {
                const idx = Object.keys(colMap).find(i => colMap[i] === role);
                return idx !== undefined ? vals[Number(idx)] : '';
            };
            const first = get('first'), last = get('last');
            return {
                number: normNum(get('phone')),
                name: [first, last].filter(Boolean).join(' '),
                lastname: last,
                code: faToEn(get('code')).trim()
            };
        }).filter(c => {
            if (c.number && c.number.length >= 10) return true;
            skipped++;
            return false;
        });
        fs.writeFileSync('./contacts.json', JSON.stringify(contacts, null, 2));
        if (!contacts.length) {
            const firstRow = JSON.stringify(data[0], null, 0).slice(0, 500);
            return tg.sendMessage(m.from.id,
                `❌ ۰ شماره ذخیره شد!\n\n🔍 ستون‌های پیدا شده:\n${headers}\n\n📄 سطر اول:\n${firstRow}\n\nاسم دقیق ستون شماره رو بفرست تا اضافه‌ش کنم.`);
        }
        const sample = contacts.slice(0, 5).map((c, i) => `${i + 1}. ${dispNum(c.number)}${c.code ? ` (اشتراک: ${c.code})` : ''} - ${c.name || '—'}`).join('\n');
        tg.sendMessage(m.from.id,
            `✅ ${contacts.length} شماره ذخیره شد!${skipped ? `\n⚠️ ${skipped} سطر شماره نامعتبر داشت و رد شد.` : ''}\n\n${sample}${contacts.length > 5 ? `\n... +${contacts.length - 5}` : ''}\n\n/upload مجدد برای آپلود جدید`);
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
        tg.sendMessage(m.from.id, `📝 متن: ${text}\n\n🔢 کد اشتراک رو بفرست:\n• بازه: ۱-۶۰۰۰\n• لیست: 4521, 7830`);
        return;
    }
    if (st.step === 'range') {
        delete convState[m.from.id];
        sendQueue = parseRange(text);
        if (!sendQueue.length) return tg.sendMessage(m.from.id, '❌ هیچ کد اشتراکی پیدا نشد. فقط کد اشتراک بفرست.');
        const preview = st.template.replace(/{name}/g, 'نام‌مشتری');
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
        // اگه این شماره تو مخاطبین باشه، اسمش رو جایگذاری کن
        const known = contacts.find(c => normNum(c.number) === st.number);
        const finalText = text.replace(/{name}/g, known?.name || '').replace(/{نام}/g, known?.name || '')
            .replace(/{lastname}/g, known?.lastname || '').replace(/{نام خانوادگی}/g, known?.lastname || '')
            .replace(/{نام‌خانوادگی}/g, known?.lastname || '');
        sock.onWhatsApp(jid).then(([r]) => {
            if (!r.exists) return tg.sendMessage(m.from.id, `❌ ${st.number} واتساپ نداره`);
            return sock.sendMessage(jid, { text: finalText });
        }).then(() => tg.sendMessage(m.from.id, `✅ فرستاده شد! 📞 ${st.number}`))
          .catch(e => tg.sendMessage(m.from.id, `❌ ${e.message}`));
    }
});

function codeNum(c) {
    if (!c || !c.code) return NaN;
    const n = Number(faToEn(c.code).replace(/[^0-9]/g, ''));
    return isNaN(n) ? NaN : n;
}
function parseRange(text) {
    // محدوده فقط و فقط کد اشتراک — هیچ مقدار دیگه‌ای قبول نیست
    const t = faToEn(text);
    const toNum = (s) => Number(String(s || '').replace(/[^0-9]/g, ''));
    // بازه کد: مثلاً 1-6000
    if (t.includes('-')) {
        const [aStr, bStr] = t.split('-').map(s => s.trim());
        const a = toNum(aStr), b = toNum(bStr);
        if (!isNaN(a) && !isNaN(b)) {
            const lo = Math.min(a, b), hi = Math.max(a, b);
            return contacts.filter(c => {
                const n = codeNum(c);
                return !isNaN(n) && n >= lo && n <= hi;
            });
        }
        return [];
    }
    // لیست کد: مثلاً 4521, 7830
    const parts = t.split(/[,،\s]+/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) return [];
    const found = [];
    parts.forEach(p => {
        const pn = toNum(p);
        if (isNaN(pn)) return;
        const hit = contacts.find(c => codeNum(c) === pn);
        if (hit && !found.includes(hit)) found.push(hit);
    });
    return found;
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
        'مثال: سلام {name} عزیز، تخفیف ویژه داریم!');
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
