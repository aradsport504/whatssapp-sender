const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys');
const TelegramBot = require('node-telegram-bot-api');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');
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
let reconnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

// ============ TELEGRAM BOT ============
const tgBot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });

function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

function sendToAdmin(text, options = {}) {
    ADMIN_IDS.forEach(id => {
        tgBot.sendMessage(id, text, options).catch(() => {});
    });
}

// ============ WHATSAPP ============
let sock;

async function connectWhatsApp() {
    if (reconnecting) return;
    reconnecting = true;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
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

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            reconnecting = false;
            reconnectAttempts = 0;
            const qrImage = await QRCode.toBuffer(qr, { type: 'png', width: 400 });
            ADMIN_IDS.forEach(id => {
                tgBot.sendPhoto(id, qrImage, {
                    caption: '📱 QR Code واتساپ\n\nگوشیت رو باز کن و این کد رو اسکن کن:\nSettings → Linked Devices → Link a Device\n\n⏳ تا اسکن صبر کن.'
                }).catch(() => {});
            });
        }

        if (connection === 'close') {
            whatsappReady = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;

            console.log(`Connection closed. Status: ${statusCode}`);

            if (statusCode === DisconnectReason.loggedOut) {
                reconnecting = false;
                sendToAdmin('❌ واتساپ از اکانت خارج شد!\n/settings رو بزن تا QR جدید بیاد.');
                if (fs.existsSync(AUTH_DIR)) {
                    fs.rmSync(AUTH_DIR, { recursive: true });
                }
            } else if (statusCode === DisconnectReason.connectionClosed ||
                       statusCode === DisconnectReason.connectionLost ||
                       statusCode === DisconnectReason.connectionReplaced ||
                       statusCode === DisconnectReason.timedOut) {
                reconnectAttempts++;
                if (reconnectAttempts <= MAX_RECONNECT_ATTEMPTS) {
                    const delay = Math.min(reconnectAttempts * 5000, 30000);
                    console.log(`Reconnecting in ${delay/1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
                    setTimeout(() => {
                        reconnecting = false;
                        connectWhatsApp();
                    }, delay);
                } else {
                    reconnecting = false;
                    reconnectAttempts = 0;
                    sendToAdmin('⚠️ واتساپ قطع شد و پس از ۵ بار تلاش وصل نشد.\n/settings رو بزن تا QR جدید بیاد.');
                }
            } else {
                reconnecting = false;
                sendToAdmin(`⚠️ واتساپ قطع شد (کد: ${statusCode}). لطفاً دوباره اسکن کن.`);
                if (fs.existsSync(AUTH_DIR)) {
                    fs.rmSync(AUTH_DIR, { recursive: true });
                }
            }
        }

        if (connection === 'open') {
            whatsappReady = true;
            reconnecting = false;
            reconnectAttempts = 0;
            sendToAdmin('✅ واتساپ با موفقیت وصل شد! 🎉');
        }
    });
}

async function requestNewQR() {
    if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true });
    }
    reconnecting = false;
    reconnectAttempts = 0;
    whatsappReady = false;
    sendToAdmin('🔄 در حال اتصال مجدد به واتساپ...');
    await connectWhatsApp();
}

// ============ MESSAGE SENDING ============
function randomDelay() {
    return DELAY_MIN_MS + Math.random() * (DELAY_MAX_MS - DELAY_MIN_MS);
}

function isAllowedTime() {
    const now = new Date();
    const hour = now.getHours();
    return hour >= SEND_START_HOUR && hour < SEND_END_HOUR;
}

function resetDailyCounter() {
    const today = new Date().toDateString();
    if (lastResetDate !== today) {
        messagesSentToday = 0;
        lastResetDate = today;
        sentNumbers.clear();
        console.log(`🔄 Daily counter reset: ${today}`);
    }
}

async function sendMessageToContact(contact, messageTemplate) {
    if (!whatsappReady) {
        sendToAdmin('⚠️ واتساپ وصل نیست! ارسال متوقف شد.');
        return false;
    }

    let message = messageTemplate;
    if (contact.name) {
        message = message.replace(/{name}/g, contact.name);
    }
    if (contact.lastname) {
        message = message.replace(/{lastname}/g, contact.lastname);
    }

    const number = contact.number.replace(/[^0-9]/g, '');
    const jid = number + '@s.whatsapp.net';

    try {
        const [exists] = await sock.onWhatsApp(jid);
        if (!exists.exists) {
            console.log(`❌ Number not on WhatsApp: ${number}`);
            return false;
        }

        await sock.sendMessage(jid, { text: message });
        console.log(`✅ Sent to ${number} (${contact.name || 'Unknown'})`);
        return true;
    } catch (err) {
        console.error(`❌ Failed to send to ${number}:`, err.message);
        return false;
    }
}

async function startSending(messageTemplate) {
    if (sendingInProgress) {
        sendToAdmin('⚠️ ارسال در حال انجام است!');
        return;
    }

    if (!whatsappReady) {
        sendToAdmin('⚠️ واتساپ وصل نیست! اول QR کد رو اسکن کن.');
        return;
    }

    if (contacts.length === 0) {
        sendToAdmin('⚠️ لیست شماره‌ها خالیه! فایل اکسل رو بفرست.');
        return;
    }

    sendingInProgress = true;
    resetDailyCounter();
    let sentCount = 0;
    let failedCount = 0;

    sendToAdmin(`🚀 شروع ارسال!\n📱 تعداد کل: ${contacts.length}\n⏰ هر ${Math.round(DELAY_MIN_MS/60000)}-${Math.round(DELAY_MAX_MS/60000)} دقیقه یک پیام`);

    for (let i = 0; i < contacts.length; i++) {
        if (!sendingInProgress) {
            sendToAdmin('🛑 ارسال متوقف شد.');
            break;
        }

        resetDailyCounter();

        if (messagesSentToday >= MESSAGES_PER_DAY) {
            sendToAdmin(`⏸️ لیمیت روزانه رسید (${MESSAGES_PER_DAY} پیام). فردا ادامه میده.`);
            break;
        }

        if (!isAllowedTime()) {
            const now = new Date();
            sendToAdmin(`⏸️ خارج از ساعات ارسال (${now.getHours()}:00). تا ساعت ${SEND_START_HOUR} صبح صبر کن.`);
            break;
        }

        const contact = contacts[i];
        const numClean = contact.number.replace(/[^0-9]/g, '');
        if (sentNumbers.has(numClean)) {
            console.log(`⏭️ Already sent to ${numClean}, skipping`);
            continue;
        }

        const success = await sendMessageToContact(contact, messageTemplate);

        if (success) {
            sentCount++;
            messagesSentToday++;
            sentNumbers.add(numClean);

            fs.writeFileSync('./progress.json', JSON.stringify({
                sent: Array.from(sentNumbers),
                total: contacts.length,
                date: new Date().toISOString()
            }, null, 2));
        } else {
            failedCount++;
        }

        if (sentCount % 5 === 0 && sentCount > 0) {
            sendToAdmin(`📊 پیشرفت: ${sentCount}/${contacts.length} ✅ | ${failedCount} ❌ | 📅 امروز: ${messagesSentToday}/${MESSAGES_PER_DAY}`);
        }

        if (i < contacts.length - 1) {
            const delay = randomDelay();
            const delayMin = Math.round(delay / 60000);
            console.log(`⏳ Waiting ${delayMin} minutes...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    sendingInProgress = false;
    sendToAdmin(`✅ ارسال تمام شد!\n✅ موفق: ${sentCount}\n❌ ناموفق: ${failedCount}\n📅 ارسال شده امروز: ${messagesSentToday}`);
}

// ============ TELEGRAM COMMANDS ============

// /start
tgBot.onText(/\/start/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    tgBot.sendMessage(msg.from.id,
        `🤖 ربات کنترل واتساپ\n\n` +
        `دستورات:\n` +
        `/status - وضعیت واتساپ\n` +
        `/settings - تنظیمات + QR جدید\n` +
        `/send متن پیام - شروع ارسال\n` +
        `/stop - توقف ارسال\n` +
        `/contacts - نمایش لیست شماره‌ها\n` +
        `/limit - نمایش لیمیت ارسال\n` +
        `/addaccess [ID] - اضافه کردن دسترسی\n` +
        `/removeaccess [ID] - حذف دسترسی\n` +
        `/accesslist - لیست دسترسی‌ها\n` +
        `\n📎 فایل اکسل بفرست تا لیست شماره‌ها آپلود بشه`
    );
});

// /settings - get new QR
tgBot.onText(/\/settings/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    tgBot.sendMessage(msg.from.id, '🔄 در حال دریافت QR کد جدید...');
    requestNewQR();
});

// /status
tgBot.onText(/\/status/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const status = whatsappReady ? '✅ وصل' : '❌ قطع';
    const today = new Date().toDateString();
    if (lastResetDate !== today) messagesSentToday = 0;
    tgBot.sendMessage(msg.from.id,
        `📱 وضعیت واتساپ: ${status}\n` +
        `📋 تعداد شماره‌ها: ${contacts.length}\n` +
        `📨 ارسال شده امروز: ${messagesSentToday}/${MESSAGES_PER_DAY}\n` +
        `🔄 در حال ارسال: ${sendingInProgress ? 'بله' : 'خیر'}\n` +
        `⏰ ساعات ارسال: ${SEND_START_HOUR}:00 - ${SEND_END_HOUR}:00`
    );
});

// /stop
tgBot.onText(/\/stop/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    sendingInProgress = false;
    tgBot.sendMessage(msg.from.id, '🛑 ارسال متوقف شد.');
});

// /send
tgBot.onText(/\/send (.+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const messageTemplate = match[1];
    if (!messageTemplate.includes('{name}')) {
        tgBot.sendMessage(msg.from.id,
            '⚠️ متن پیام باید شامل `{name}` باشه.\n\nمثال:\nسلام {name} 👋 مجموعه ما برای شما تخفیف ویژه دارد.'
        );
        return;
    }
    tgBot.sendMessage(msg.from.id, `✅ متن پیام ثبت شد.\n\n📝 متن:\n${messageTemplate}\n\n🚀 در حال شروع ارسال...`);
    startSending(messageTemplate);
});

// /contacts
tgBot.onText(/\/contacts/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    if (contacts.length === 0) {
        tgBot.sendMessage(msg.from.id, '📋 لیست شماره‌ها خالیه. فایل اکسل بفرست.');
        return;
    }
    let list = '📋 لیست شماره‌ها:\n\n';
    contacts.slice(0, 20).forEach((c, i) => {
        list += `${i+1}. ${c.number} - ${c.name || 'بدون اسم'}\n`;
    });
    if (contacts.length > 20) {
        list += `\n... و ${contacts.length - 20} شماره دیگر`;
    }
    tgBot.sendMessage(msg.from.id, list);
});

// /limit
tgBot.onText(/\/limit/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    const remaining = MESSAGES_PER_DAY - messagesSentToday;
    tgBot.sendMessage(msg.from.id,
        `📊 لیمیت ارسال:\n\n` +
        `📅 حداکثر روزانه: ${MESSAGES_PER_DAY} پیام\n` +
        `📨 ارسال شده امروز: ${messagesSentToday}\n` +
        `剩 باقی‌مانده: ${Math.max(0, remaining)}\n\n` +
        `⏰ فاصله ارسال: ${Math.round(DELAY_MIN_MS/60000)}-${Math.round(DELAY_MAX_MS/60000)} دقیقه\n` +
        `🕐 ساعات ارسال: ${SEND_START_HOUR}:00 تا ${SEND_END_HOUR}:00`
    );
});

// /addaccess
tgBot.onText(/\/addaccess (.+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const newId = parseInt(match[1]);
    if (isNaN(newId)) {
        tgBot.sendMessage(msg.from.id, '❌ آی‌دی نامعتبره.');
        return;
    }
    if (ADMIN_IDS.includes(newId)) {
        tgBot.sendMessage(msg.from.id, '⚠️ این آی‌دی از قبل دسترسی داره.');
        return;
    }
    ADMIN_IDS.push(newId);
    tgBot.sendMessage(msg.from.id, `✅ دسترسی اضافه شد!\nآی‌دی: ${newId}\n\nتعداد کل ادمین‌ها: ${ADMIN_IDS.length}`);
});

// /removeaccess
tgBot.onText(/\/removeaccess (.+)/, (msg, match) => {
    if (!isAdmin(msg.from.id)) return;
    const removeId = parseInt(match[1]);
    if (removeId === 6138410965) {
        tgBot.sendMessage(msg.from.id, '❌ نمی‌تونی آی‌دی اصلی رو حذف کنی.');
        return;
    }
    const idx = ADMIN_IDS.indexOf(removeId);
    if (idx === -1) {
        tgBot.sendMessage(msg.from.id, '❌ این آی‌دی دسترسی نداره.');
        return;
    }
    ADMIN_IDS.splice(idx, 1);
    tgBot.sendMessage(msg.from.id, `✅ دسترسی حذف شد!\nآی‌دی: ${removeId}`);
});

// /accesslist
tgBot.onText(/\/accesslist/, (msg) => {
    if (!isAdmin(msg.from.id)) return;
    let list = '👥 لیست دسترسی‌ها:\n\n';
    ADMIN_IDS.forEach((id, i) => {
        list += `${i+1}. ${id}${id === 6138410965 ? ' (مالک اصلی)' : ''}\n`;
    });
    tgBot.sendMessage(msg.from.id, list);
});

// Handle Excel file upload
tgBot.on('document', async (msg) => {
    if (!isAdmin(msg.from.id)) return;

    const fileId = msg.document.file_id;
    const fileName = msg.document.file_name;

    if (!fileName.endsWith('.xlsx') && !fileName.endsWith('.xls') && !fileName.endsWith('.csv')) {
        tgBot.sendMessage(msg.from.id, '❌ فقط فایل اکسل (xlsx) یا CSV بفرست.');
        return;
    }

    try {
        const file = await tgBot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${file.file_path}`;
        const response = await fetch(fileUrl);
        const buffer = await response.arrayBuffer();

        const workbook = XLSX.read(Buffer.from(buffer));
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet);

        contacts = [];
        data.forEach(row => {
            const phone = row['شماره'] || row['phone'] || row['Phone'] || row['شماره تلفن'] || row['شماره_تلفن'] || Object.values(row)[0];
            const name = row['اسم'] || row['name'] || row['Name'] || row['نام'] || row['نام_خانوادگی'] || Object.values(row)[1] || '';

            if (phone) {
                contacts.push({
                    number: String(phone).trim(),
                    name: String(name).trim()
                });
            }
        });

        fs.writeFileSync('./contacts.json', JSON.stringify(contacts, null, 2));

        let list = `✅ فایل آپلود شد!\n📋 تعداد شماره‌ها: ${contacts.length}\n\n`;
        contacts.slice(0, 10).forEach((c, i) => {
            list += `${i+1}. ${c.number} - ${c.name || 'بدون اسم'}\n`;
        });
        if (contacts.length > 10) {
            list += `\n... و ${contacts.length - 10} شماره دیگر`;
        }

        tgBot.sendMessage(msg.from.id, list);
    } catch (err) {
        tgBot.sendMessage(msg.from.id, `❌ خطا در خواندن فایل:\n${err.message}`);
    }
});

// ============ STARTUP ============
async function main() {
    console.log('🚀 Starting WhatsApp Sender Bot...');

    if (fs.existsSync('./contacts.json')) {
        contacts = JSON.parse(fs.readFileSync('./contacts.json', 'utf8'));
        console.log(`📋 Loaded ${contacts.length} contacts`);
    }

    await connectWhatsApp();

    console.log('✅ Bot is ready!');
    sendToAdmin('🤖 ربات واتساپ آماده شد!\n\nبرای شروع:\n1. /settings بزن تا QR کد بیاد\n2. اسکن کن\n3. فایل اکسل بفرست\n4. /send متن پیام بزن');
}

main().catch(console.error);
