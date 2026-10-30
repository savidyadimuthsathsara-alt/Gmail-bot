const express = require("express");
const pino = require("pino");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const { sendButtons } = require('gifted-btns');
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    downloadMediaMessage,
    normalizeMessageContent,
    fetchLatestWaWebVersion
} = require("@whiskeysockets/baileys");

const CONFIG = {
    PORT: process.env.PORT || 8080,
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || "admin123", 
    BOT_PHONE_NUMBER: process.env.BOT_PHONE_NUMBER || "94771234567", 
    REWARD: 30, 
    TG_API_ID: parseInt(process.env.TG_API_ID || "0"),
    TG_API_HASH: process.env.TG_API_HASH || "",
    TG_SESSION: process.env.TG_SESSION || "", 
    TG_BOT: process.env.TG_BOT || "@GmailFarmerBot" 
};

const LOGO_URL = 'https://files.catbox.moe/eic9dy.png';

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'bot.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, balance REAL DEFAULT 0, tasks_completed INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY, user_id TEXT, amount REAL
  );
`);

const userService = {
    find: (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id),
    create: (id) => db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').run(id),
    addBalance: (id, amt) => db.prepare('UPDATE users SET balance = balance + ?, tasks_completed = tasks_completed + 1 WHERE id = ?').run(amt, id),
    getAll: () => db.prepare('SELECT * FROM users').all(),
};

const taskService = {
    add: (taskId, userId, amount) => {
        try { 
            db.prepare('INSERT INTO tasks (task_id, user_id, amount) VALUES (?, ?, ?)').run(taskId, userId, amount); 
            return true; 
        } catch (e) { return false; }
    }
};

let currentPairingCode = null;
let waStatus = 'offline';
let sockInstance = null;
let tgClient = null;
const userStates = new Map(); 
const waToTgMap = new Map();  

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/dashboard', (req, res) => {
    res.json({ status: waStatus, pairingCode: currentPairingCode, users: userService.getAll() });
});
app.listen(CONFIG.PORT, () => console.log(`🌐 Dashboard running on port ${CONFIG.PORT}`));

// ==========================================
// Telegram Relay Logic
// ==========================================
async function initTelegram() {
    if (!CONFIG.TG_SESSION || CONFIG.TG_API_ID === 0) return;
    
    try {
        const session = new StringSession(CONFIG.TG_SESSION);
        tgClient = new TelegramClient(session, CONFIG.TG_API_ID, CONFIG.TG_API_HASH, { connectionRetries: 5 });
        await tgClient.connect();
        console.log("✅ Telegram Connected!");

        tgClient.addEventHandler(async (event) => {
            if (!event.message) return; 

            const message = event.message;
            if (!message.message && !message.media) return;

            const waChatId = waToTgMap.get(CONFIG.TG_BOT);
            if (!waChatId) return;

            let text = message.message || '';

            // ඩොලර් අගය LKR 30 ලෙස වෙනස් කිරීම
            text = text.replace(/from\s*[\d.]+\$\s*to\s*[\d.]+\$/gi, "LKR 30.00");
            text = text.replace(/[\d.]+(\$| USD)/gi, "LKR 30.00");

            if (text.includes('Register Gmail accounts') || text.includes('Email:') || text.includes('Password:')) {
                await sendButtons(sockInstance, waChatId, { 
                    text: text, 
                    buttons: [
                        { id: 'btn_done', text: '✔ Done' }, 
                        { id: 'btn_cancel', text: '🚫 Cancel registration' }
                    ] 
                });
            } 
            else if (text.includes('Success') || text.includes('created successfully')) {
                const taskId = `task_${Date.now()}_${waChatId}`;
                if (taskService.add(taskId, waChatId, CONFIG.REWARD)) {
                    userService.addBalance(waChatId, CONFIG.REWARD);
                    const user = userService.find(waChatId);
                    const msg = `✅ *Gmail එක සාර්ථකව හැදුවා!*\n\n💰 රු. ${CONFIG.REWARD}.00 ක් එකතු කරන ලදී.\n💵 *නව බැලන්ස්:* රු. ${user.balance.toFixed(2)}\n📊 *Tasks:* ${user.tasks_completed}`;
                    await sendButtons(sockInstance, waChatId, { text: msg, buttons: [{ id: 'go_menu', text: '🏠 Main Menu' }] });
                }
                userStates.delete(waChatId);
            } 
            else if (text.includes('Enable 2FA')) {
                await sendButtons(sockInstance, waChatId, { text, buttons: [{ id: 'btn_enable_2fa', text: '💊 Enable 2FA' }] });
            } 
            else if (text.includes('CLICK AGAIN TO CONFIRM')) {
                await sendButtons(sockInstance, waChatId, { text, buttons: [{ id: 'btn_confirm_2fa', text: '[‼️ CLICK AGAIN TO CONFIRM ‼️]' }] });
            } 
            else {
                await sockInstance.sendMessage(waChatId, { text: text });
            }
        });
    } catch (error) {
        console.error("Telegram Error:", error);
    }
}

async function sendToTg(waUserId, text, mediaBuffer = null) {
    if (!tgClient) {
        console.log("❌ Telegram not connected, cannot send!");
        return;
    }
    waToTgMap.set(CONFIG.TG_BOT, waUserId);
    try {
        if (mediaBuffer) {
            await tgClient.sendFile(CONFIG.TG_BOT, { file: mediaBuffer, caption: text });
        } else {
            await tgClient.sendMessage(CONFIG.TG_BOT, { message: text });
        }
        console.log(`✅ Sent to Telegram: ${text}`);
    } catch (error) {
        console.log("Error sending to TG:", error.message);
    }
}

// ==========================================
// WhatsApp Bot Logic
// ==========================================
async function connectWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(path.join(dataDir, 'auth_info'));
        const { version } = await fetchLatestWaWebVersion().catch(() => ({ version: [2, 3000, 1038544855] }));

        sockInstance = makeWASocket({
            version,
            auth: state,
            browser: Browsers.ubuntu("Chrome"),
            printQRInTerminal: false,
            logger: pino({ level: 'silent' }),
            markOnlineOnConnect: false
        });

        if (!sockInstance.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const cleanNumber = CONFIG.BOT_PHONE_NUMBER.replace(/[^0-9]/g, '');
                    const code = await sockInstance.requestPairingCode(cleanNumber);
                    currentPairingCode = code;
                    console.log(`\n🔑 YOUR PAIRING CODE IS: ${code}\n`);
                } catch (err) { console.log("Pairing Code Error:", err.message); }
            }, 3000);
        }

        sockInstance.ev.on('creds.update', saveCreds);

        sockInstance.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                waStatus = 'offline';
                currentPairingCode = null;
                const shouldReconnect = (lastDisconnect?.error instanceof DisconnectReason || lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut);
                if (shouldReconnect) connectWhatsApp();
            } else if (connection === 'open') {
                waStatus = 'connected';
                currentPairingCode = null;
                console.log('✅ WhatsApp Connected Successfully!');
                initTelegram();
            }
        });

        sockInstance.ev.on('messages.upsert', async (m) => {
            const msg = m.messages[0];
            if (!msg.message || msg.key.fromMe) return;

            const from = msg.key.remoteJid;
            const sender = msg.key.participant || from;
            
            const msgContent = normalizeMessageContent(msg.message) || msg.message;
            const type = Object.keys(msgContent)[0];
            const state = userStates.get(sender) || 'IDLE';

            if (from === 'status@broadcast') {
                await sockInstance.readMessages([msg.key]);
                return;
            }

            // Debugging: පණිවිඩය එන වර්ගය පෙන්නන්න
            console.log(`[NEW MESSAGE] Type: ${type}`);

            let text = "";
            let btnId = null;

            if (type === 'conversation') {
                text = msgContent.conversation;
            } else if (type === 'extendedTextMessage') {
                text = msgContent.extendedTextMessage.text;
            } else if (type === 'buttonsResponseMessage') {
                btnId = msgContent.buttonsResponseMessage.selectedButtonId;
                text = msgContent.buttonsResponseMessage.selectedDisplayText;
            } else if (type === 'interactiveResponseMessage') {
                const params = JSON.parse(msgContent.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson || '{}');
                btnId = params.id;
                text = params.display_text || btnId;
            } else if (type === 'templateButtonReplyMessage') {
                btnId = msgContent.templateButtonReplyMessage.selectedId;
                text = msgContent.templateButtonReplyMessage.selectedDisplayText;
            } else if (type === 'listResponseMessage') {
                btnId = msgContent.listResponseMessage.singleSelectReply.selectedRowId;
                text = msgContent.listResponseMessage.title;
            }

            // ==========================================
            // 1. බටන් ඔබද්දි වැඩ කරන කොටස
            // ==========================================
            const processButton = async (id) => {
                console.log(`👉 Button Action Triggered: ${id}`);
                if (id === 'btn_register') {
                    await sendToTg(sender, '+ Register a new Gmail');
                } else if (id === 'btn_balance') {
                    let u = userService.find(sender) || { balance: 0, tasks_completed: 0 };
                    await sendButtons(sockInstance, from, { text: `💰 *බැලන්ස්:* රු. ${u.balance.toFixed(2)}\n📊 *Tasks:* ${u.tasks_completed}`, buttons: [{ id: 'go_menu', text: '🏠 Main Menu' }] });
                } else if (id === 'go_menu') {
                    await sendButtons(sockInstance, from, { image: { url: LOGO_URL }, title: 'Gmail Farmer', text: 'ආයුබෝවන්! ඔබට අවශ්‍ය සේවාව තෝරන්න:', buttons: [{ id: 'btn_register', text: '➕ Register Gmail' }, { id: 'btn_balance', text: '💰 Balance' }] });
                } else if (id === 'btn_cancel') {
                    await sendToTg(sender, '/cancel');
                } else if (id === 'btn_done') {
                    await sendToTg(sender, '/done');
                } else if (id === 'btn_enable_2fa') {
                    await sendToTg(sender, 'Enable 2FA');
                } else if (id === 'btn_confirm_2fa') {
                    userStates.set(sender, 'WAIT_QR');
                    await sendToTg(sender, '/confirm');
                }
            };

            // Native Button එකක් නම්
            if (btnId) {
                await processButton(btnId);
                return;
            }

            // ෆෝන් එකෙන් බටන් එක Text විදියට එව්වොත් (Fallback)
            if (text) {
                const cleanText = text.trim().toLowerCase();
                if (cleanText.includes('register gmail') || cleanText.includes('register a new gmail')) {
                    await processButton('btn_register');
                    return;
                }
                if (cleanText === '💰 balance' || cleanText === 'balance') {
                    await processButton('btn_balance');
                    return;
                }
                if (cleanText === '✔ done' || cleanText === 'done') {
                    await processButton('btn_done');
                    return;
                }
                if (cleanText.includes('cancel registration') || cleanText === 'cancel') {
                    await processButton('btn_cancel');
                    return;
                }
                if (cleanText.includes('enable 2fa')) {
                    await processButton('btn_enable_2fa');
                    return;
                }
                if (cleanText.includes('click again to confirm')) {
                    await processButton('btn_confirm_2fa');
                    return;
                }
                if (cleanText.includes('main menu') || cleanText === 'menu') {
                    await processButton('go_menu');
                    return;
                }
            }

            // ==========================================
            // 2. QR එක සහ 16 කෝඩ් එක අල්ලගන්නා කොටස
            // ==========================================
            if (type === 'imageMessage' && state === 'WAIT_QR') {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                await sendToTg(sender, 'QR Code එක ලැබුණා', buffer);
                userStates.set(sender, 'WAIT_CODE');
                await sockInstance.sendMessage(from, { text: '✅ QR Code එක ලැබුණා. දැන් ඔබට ලැබුණු අකුරු 16ේ කෝඩ් එක එවන්න.' });
                return;
            }

            if (text && state === 'WAIT_CODE') {
                await sendToTg(sender, text);
                return;
            }

            // ==========================================
            // 3. සාමාන්‍ය කමාන්ඩ්
            // ==========================================
            if (text) {
                const cmd = text.trim().toLowerCase();
                if (cmd === '/start' || cmd === '.menu') {
                    userService.create(sender);
                    await sendButtons(sockInstance, from, { image: { url: LOGO_URL }, title: 'Gmail Farmer', text: 'ආයුබෝවන්! ඔබට අවශ්‍ය සේවාව තෝරන්න:', buttons: [{ id: 'btn_register', text: '➕ Register Gmail' }, { id: 'btn_balance', text: '💰 Balance' }] });
                } 
                else if (cmd === '.ping') {
                    await sockInstance.sendMessage(from, { text: '🏓 Pong! Bot is online.' });
                }
            }
        });

    } catch (error) {
        console.log("WhatsApp Connection Error:", error);
    }
}

connectWhatsApp();
