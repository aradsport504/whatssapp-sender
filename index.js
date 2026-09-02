const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const XLSX = require('xlsx');
const fs = require('fs');
const http = require('http');
const pino = require('pino');
const QR = require('qrcode');

const TG_TOKEN = process.env.TELEGRAM_TOKEN || '8902204232:AAEw0N7UR1amMKO9xuGV8KkHyS-kym7sCmk';
const ADMINS = (process.env.ADMIN_IDS || '6138410965').split(',').map(Number);
const MY_NUMBER = process.env.MY_NUMBER || '';
const AUTH_DIR = './auth_info';

http.createServer((_, res) => { res.writeHead(200); res.end('OK'); }).listen(process.env.PORT || 3000);

// ============ STATE ============
let waReady = false;
let contacts = [];
let sentNums = new Set();
let sending = false;
let sock = null;
let connecting = false;
let reconnectTimer = null;
let qrSent = false;

// Smart send state
let sendQueue = [];
let sendProgress = { sent: 0, failed: 0, total: 0, range: '' };
let sendResumeTimer = null;

// Conversation states for each chat
let convState = {};

const tg = new TelegramBot(TG_TOKEN, { polling: true });
const isAdmin = (id) => ADMINS.includes(id);
const tell = (t, opts) => ADMINS.forEach(id => tg.sendMessage(id, t, opts).catch(() => {}));

// ============ CONNECT ============
async function connectWA() {
    if (connecting) return;
    connecting = true;
    console.log('🔄 connectWA');

    try {
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        const { version } = await fetchLatestBaileysVersion();

        const s = makeWASocket({
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })) },
            version,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            browser: ['WhatsApp Sender', 'Chrome', '1.0.0'],
            connectTimeout: 60000,
            defaultQueryTimeoutMs: undefined,
        });

        sock = s;
        s.ev.on('creds.update', saveCreds);

        s.ev.on('connection.update', async (u) => {
            const { connection, lastDisconnect, qr } = u;

            if (qr && !qrSent) {
                qrSent = true;
                const buf = await QR.toBuffer(qr, { type: 'png', width: 400, margin: 2 });
                for (const id of ADMINS) {
                    await tg.sendPhoto(id, buf, { caption: '📱 اسکن کن:\nSettings → Linked Devices → Link a Device' }).catch(() => {});
                }
            }

            if (connection === 'open') {
                waReady = true;
                connecting = false;
                qrSent = false;
                console.log('✅ CONNECTED');
                tell('✅ واتساپ وصل شد! 🎉');
            }

            if (connection === 'close') {
                waReady = false;
                connecting = false;
                const code = lastDisconnect?.error?.output?.statusCode;
                console.log('❌ Close:', code);

                if (code === 401) {
                    try { fs.rmSync(AUTH_DIR, { recursive: true }); } catch(e) {}
                    tell('❌ خارج شد. /qr یا /pair بزن.');
                } else if (code === 405 || code === 440) {
                    tell('⚠️ اتصال بلاک شد. /qr یا /pair بزن.');
                } else {
                    reconnectTimer = setTimeout(connectWA, 5000);
                }
            }
        });
    } catch (err) {
        console.error('❌', err.message);
        connecting = false;
        reconnectTimer = setTimeout(connectWA, 5000);
    }
}

function restartWA(msg) {
    tell(msg || '🔄 ریستارت...');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (sock) { try { sock.end(undefined); } catch(e) {} sock = null; }
    waReady = false;
    connecting = false;
    qrSent = false;
    try { fs.rmSync(AUTH_DIR, { recursive: true }); } catch(e) {}
    setTimeout(connectWA, 2000);
}

// ============ SMART SEND ALGORITHM ============
function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function isAllowedTime() {
    const h = new Date().getHours();
    return h >= 8 && h < 23; // 8am to 11pm
}

function getTomorrow8am() {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(8, 0, 0, 0);
    return tomorrow;
}

function delayUntilMorning() {
    const now = new Date();
    const tomorrow8am = getTomorrow8am();
    const ms = tomorrow8am - now;
    console.log(`⏸️ Scheduling resume at ${tomorrow8am.toISOString()} (${Math.round(ms/60000)} min)`);
    return ms;
}

async function sendOneMessage(contact, messageTemplate) {
    let msg = messageTemplate;
    if (contact.name) msg = msg.replace(/{name}/g, contact.name);
    if (contact.lastname) msg = msg.replace(/{lastname}/g, contact.lastname);
    const num = contact.number.replace(/[^0-9]/g, '');
    const jid = num + '@s.whatsapp.net';
    try {
        const [r] = await sock.onWhatsApp(jid);
        if (!r.exists) return { ok: false, reason: 'not_found' };
        await sock.sendMessage(jid, { text: msg });
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e.message };
    }
}

async function smartSend(messageTemplate) {
    if (sending) return tell('⚠️ در حال ارسال!');
    if (!waReady || !sock) return tell('⚠️ واتساپ وصل نیست!');
    if (!sendQueue.length) return tell('⚠️ لیست خالیه!');
    sending = true;

    // Progress tracking
    const progressFile = './send_progress.json';
    let startIdx = 0;
    if (fs.existsSync(progressFile)) {
        try {
            const saved = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
            if (saved.range === sendProgress.range) {
                startIdx = saved.sent;
                sentNums = new Set(saved.sentNums || []);
                tell(`📊 ادامه از پیام ${startIdx + 1} (دیروز ناقص مونده بود)`);
            }
        } catch(e) {}
    }

    let sent = 0, failed = 0;
    const total = sendQueue.length;

    tell(`🚀 شروع هوشمند!\n📱 ${total} پیام\n⏰ ۸ صبح تا ۱۱ شب\n🔄 فاصله: ۹۰ تا ۹۰۰ ثانیه رندوم`);

    for (let i = startIdx; i < sendQueue.length; i++) {
        if (!sending) {
            tell('🛑 متوقف شد.');
            break;
        }

        // Check time window
        if (!isAllowedTime()) {
            sending = false;
            const waitMs = delayUntilMorning();
            const hoursUntil = Math.round(waitMs / 3600000);
            tell(`⏸️ ساعت ۱۱ شب شد!\n📅 فردا ۸ صبح ادامه میده (${hoursUntil} ساعت دیگه)\n📊 تا الان: ✅${sent} ❌${failed} | باقیمانده: ${sendQueue.length - i}`);

            // Save progress
            fs.writeFileSync(progressFile, JSON.stringify({
                range: sendProgress.range,
                sent: i,
                sentNums: Array.from(sentNums),
                messageTemplate,
                timestamp: new Date().toISOString()
            }));

            // Schedule resume
            sendResumeTimer = setTimeout(() => {
                tell('☀️ صبح بخیر! ادامه ارسال...');
                sendQueue = sendQueue.slice(i);
                smartSend(messageTemplate);
            }, waitMs);

            return;
        }

        // Skip already sent
        const num = sendQueue[i].number.replace(/[^0-9]/g, '');
        if (sentNums.has(num)) { sent++; continue; }

        const result = await sendOneMessage(sendQueue[i], messageTemplate);
        if (result.ok) {
            sent++;
            sentNums.add(num);
        } else {
            failed++;
        }

        // Progress update every 10 messages
        if ((sent + failed) % 10 === 0) {
            tell(`📊 ${sent + failed}/${total} ✅${sent} ❌${failed}`);
        }

        // Save progress
        fs.writeFileSync(progressFile, JSON.stringify({
            range: sendProgress.range,
            sent: i + 1,
            sentNums: Array.from(sentNums),
            messageTemplate,
            timestamp: new Date().toISOString()
        }));

        // Random delay: 90-900 seconds (1.5-15 minutes)
        if (i < sendQueue.length - 1) {
            const waitSec = randomBetween(90, 900);
            const waitMin = (waitSec / 60).toFixed(1);
            console.log(`⏳ Next message in ${waitSec}s (${waitMin}min)`);
            await new Promise(r => setTimeout(r, waitSec * 1000));
        }
    }

    sending = false;
    sendQueue = [];
    sentNums.clear();
    try { fs.unlinkSync(progressFile); } catch(e) {}

    tell(`✅ ارسال تمام شد!\n📊 ✅${sent} ❌${failed} از ${total} پیام\n📱 هیچ لیمیتی نخورد!`);
}

// ============ CONVERSATION FLOW ============
// /send → شروع flow جدید
tg.onText(/\/send/, (m) => {
    if (!isAdmin(m.from.id)) return;
    if (!waReady) return tg.sendMessage(m.from.id, '⚠️ واتساپ وصل نیست!');

    // Check for resume progress
    if (fs.existsSync('./send_progress.json')) {
        const saved = JSON.parse(fs.readFileSync('./send_progress.json', 'utf8'));
        tg.sendMessage(m.from.id,
            `⚠️ ارسال قبلی ناقص مونده:\n📊 از پیام ${saved.sent + 1}\n📅 ${saved.timestamp}\n\n/resume برای ادامه\n/new برای شروع جدید`);
        return;
    }

    convState[m.from.id] = { step: 'template' };
    tg.sendMessage(m.from.id,
        '📝 متن پیام رو بنویس.\n\n' +
        'برای اسم شخص از `{name}` استفاده کن.\n' +
        'مثال: سلام {name} عزیز، تخفیف ویژه داریم!');
});

// /resume → ادامه ارسال قبلی
tg.onText(/\/resume/, (m) => {
    if (!isAdmin(m.from.id)) return;
    if (!fs.existsSync('./send_progress.json'))
        return tg.sendMessage(m.from.id, '❌ ارسال قبلی نیست.');
    const saved = JSON.parse(fs.readFileSync('./send_progress.json', 'utf8'));
    sendQueue = contacts.slice(); // reload from contacts.json
    sendProgress.range = saved.range;
    tell(`🔄 ادامه ارسال از پیام ${saved.sent + 1}...`);
    smartSend(saved.messageTemplate);
});

// /new → پاک کردن progress
tg.onText(/\/new/, (m) => {
    if (!isAdmin(m.from.id)) return;
    try { fs.unlinkSync('./send_progress.json'); } catch(e) {}
    sentNums.clear();
    tg.sendMessage(m.from.id, '✅ پاک شد. /send بزن.');
});

// Handler پیام‌های مکالمه‌ای
tg.on('message', (m) => {
    if (!isAdmin(m.from.id)) return;
    const st = convState[m.from.id];
    if (!st) return;
    const text = m.text;
    if (!text || text.startsWith('/')) return;

    // Step 1: متن پیام
    if (st.step === 'template') {
        if (!text.includes('{name}')) {
            return tg.sendMessage(m.from.id, '⚠️ متن باید `{name}` داشته باشه.\nمثال: سلام {name} 👋');
        }
        st.template = text;
        st.step = 'range_start';
        tg.sendMessage(m.from.id, `📝 متن: ${text}\n\n📞 کد نفر اول رو بفرست (شماره ردیف از اکسل):`);
        return;
    }

    // Step 2: شماره شروع
    if (st.step === 'range_start') {
        const n = parseInt(text);
        if (isNaN(n) || n < 1) return tg.sendMessage(m.from.id, '❌ عدد معتبر بفرست.');
        st.rangeStart = n;
        st.step = 'range_end';
        tg.sendMessage(m.from.id, `✅ شروع: ${n}\n\n📞 کد نفر آخر رو بفرست:`);
        return;
    }

    // Step 3: شماره پایان
    if (st.step === 'range_end') {
        const n = parseInt(text);
        if (isNaN(n) || n < st.rangeStart) return tg.sendMessage(m.from.id, '❌ باید بزرگتر از شروع باشه.');
        st.rangeEnd = n;

        // فیلتر کردن اکسل
        sendQueue = contacts.slice(st.rangeStart - 1, st.rangeEnd);
        sendProgress.range = `${st.rangeStart}-${st.rangeEnd}`;

        if (sendQueue.length === 0) {
            delete convState[m.from.id];
            return tg.sendMessage(m.from.id, '❌ هیچ شماره‌ای توی این محدوده نیست.');
        }

        st.step = 'confirm';
        const sample = sendQueue.slice(0, 3).map((c, i) =>
            `${i+1}. ${c.number} - ${c.name || '(بدون اسم)'}`
        ).join('\n');

        // Show preview with template
        const preview = st.template.replace(/{name}/g, 'نام‌مشتری');

        tg.sendMessage(m.from.id,
            `📋 پیش‌نمایش:\n\n` +
            `📝 متن:\n${preview}\n\n` +
            `👥 ${sendQueue.length} نفر (${st.rangeStart} تا ${st.rangeEnd}):\n${sample}${sendQueue.length > 3 ? `\n... +${sendQueue.length - 3}` : ''}\n\n` +
            `🔄 فاصله: ۹۰-۹۰۰ ثانیه رندوم\n⏰ ۸ صبح تا ۱۱ شب\n\n` +
            `✅ تأیید میکنی؟ (بله/خیر)`);
        return;
    }

    // Step 4: تأیید
    if (st.step === 'confirm') {
        delete convState[m.from.id];
        if (text === 'بله' || text === 'yes' || text === 'ok') {
            smartSend(st.template);
        } else {
            tg.sendMessage(m.from.id, '❌ لغو شد.');
            sendQueue = [];
        }
        return;
    }

    // Test flow (older)
    if (st.step === 'number') {
        const num = text.replace(/[^0-9]/g, '');
        if (num.length < 8) return tg.sendMessage(m.from.id, '❌ شماره نامعتبر.');
        st.number = num;
        st.step = 'message';
        tg.sendMessage(m.from.id, `📞 شماره: ${num}\n\n📝 پیام رو بنویس:`);
        return;
    }

    if (st.step === 'message') {
        const num = st.number;
        const msg = text;
        delete convState[m.from.id];
        if (!waReady || !sock) return tg.sendMessage(m.from.id, '⚠️ واتساپ وصل نیست!');
        const jid = num + '@s.whatsapp.net';
        sock.onWhatsApp(jid).then(([r]) => {
            if (!r.exists) return tg.sendMessage(m.from.id, `❌ شماره ${num} واتساپ نداره`);
            return sock.sendMessage(jid, { text: msg });
        }).then(() => {
            tg.sendMessage(m.from.id, `✅ پیام فرستاده شد!\n📞 ${num}\n📝 ${msg}`);
        }).catch(e => {
            tg.sendMessage(m.from.id, `❌ خطا: ${e.message}`);
        });
    }
});

// ============ COMMANDS ============
tg.onText(/\/start/, (m) => {
    if (!isAdmin(m.from.id)) return;
    tg.sendMessage(m.from.id,
        '🤖 ربات واتساپ\n\n' +
        '/qr - QR کد\n' +
        '/pair - کد Pairing\n' +
        '/send - ارسال هوشمند (مرحله‌ای)\n' +
        '/resume - ادامه ارسال قبلی\n' +
        '/new - شروع جدید\n' +
        '/test - تست ارسال تکی\n' +
        '/status - وضعیت\n' +
        '/stop - توقف\n' +
        '/contacts - شماره‌ها\n' +
        '/limit - لیمیت\n\n' +
        '📎 فایل اکسل بفرست');
});

tg.onText(/\/qr/, (m) => { if (isAdmin(m.from.id)) restartWA('🔄 ریستارت برای QR...'); });

tg.onText(/\/pair/, (m) => {
    if (!isAdmin(m.from.id)) return;
    restartWA('🔄 ریستارت برای Pairing...');
    const waitConnect = setInterval(() => {
        if (waReady && sock) {
            clearInterval(waitConnect);
            if (!MY_NUMBER) return tell('⚠️ MY_NUMBER تنظیم نیست!');
            sock.requestPairingCode(MY_NUMBER).then(code => {
                tell(`🔑 کد Pairing:\n\n*${code}*\n\n📞 واتساپ → Linked Devices → Link with Phone Number`, { parse_mode: 'Markdown' });
            }).catch(e => tell('❌ ' + e.message));
        }
    }, 1000);
    setTimeout(() => clearInterval(waitConnect), 30000);
});

tg.onText(/\/test/, (m) => {
    if (!isAdmin(m.from.id)) return;
    convState[m.from.id] = { step: 'number' };
    tg.sendMessage(m.from.id, '📞 شماره واتساپ رو بفرست:');
});

tg.onText(/\/status/, (m) => {
    if (!isAdmin(m.from.id)) return;
    let status = `📱 واتساپ: ${waReady ? '✅ وصل' : '❌ قطع'}\n📋 شماره‌ها: ${contacts.length}`;
    if (sending) {
        status += `\n🔄 در حال ارسال: ✅${sendProgress.sent} ❌${sendProgress.failed} از ${sendProgress.total}`;
    }
    if (fs.existsSync('./send_progress.json')) {
        const saved = JSON.parse(fs.readFileSync('./send_progress.json', 'utf8'));
        status += `\n⏸️ ارسال ناقص: پیام ${saved.sent + 1} از محدوده ${saved.range}`;
    }
    tg.sendMessage(m.from.id, status);
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
    let l = contacts.slice(0, 20).map((c, i) => `${i+1}. ${c.number} - ${c.name || '-'}`).join('\n');
    if (contacts.length > 20) l += `\n... +${contacts.length - 20}`;
    tg.sendMessage(m.from.id, `📋 (${contacts.length}):\n${l}`);
});

tg.onText(/\/limit/, (m) => {
    if (!isAdmin(m.from.id)) return;
    tg.sendMessage(m.from.id, `⏰ ۸ صبح تا ۱۱ شب\n🔄 فاصله: ۹۰-۹۰۰ ثانیه رندوم\n📅 اگه تموم نشد، فردا ۸ صبح ادامه`);
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
        tg.sendMessage(m.from.id,
            `✅ ${contacts.length} شماره آپلود شد!\n\n` +
            `例:\n` +
            `1. 98912... - علی\n` +
            `2. 98935... - سارا\n\n` +
            `/send بزن تا شروع کنی`);
    } catch (e) { tg.sendMessage(m.from.id, `❌ ${e.message}`); }
});

// ============ START ============
console.log('🚀 Starting...');
if (fs.existsSync('./contacts.json')) {
    contacts = JSON.parse(fs.readFileSync('./contacts.json', 'utf8'));
}
mode = 'qr';
connectWA();
tell('🤖 ربات آماده!\n\n📎 فایل اکسل بفرست\n/send بزن تا شروع کنی');
