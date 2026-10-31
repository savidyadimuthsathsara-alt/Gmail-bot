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
    getContentType,
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

// දැනට ටෙලිග්‍රෑම් එකේ වැඩ කරන කෙනා
let activeTelegramUser = null; 

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
            const message = event.message;
            if (!message) return;
            
            // අපේ යූසර් කෙනෙක් වැඩ කරනවා නම් විතරක් ඩේටා ගන්නවා
            if (!activeTelegramUser) return;

            let text = message.message || message.text || '';
            if (!text && !message.media) return;

            // අදාළ වචන තියෙනවද බලනවා (අනවශ්‍ය මැසේජ් අයින් කරන්න)
            const hasData = /First name:|Email:|Password:|Success|created|Enable 2FA|CLICK AGAIN/i.test(text) || message.media;
            if (!hasData) return; 

            // ඩොලර් අගය LKR 30 ලෙස වෙනස් කිරීම
            text = text.replace(/from\s*[\d.]+\$\s*to\s*[\d.]+\$/gi, "LKR 30.00");

            if (text.includes('First name:') || text.includes('Email:')) {
                await sendButtons(sockInstance, activeTelegramUser, { 
                    text: text, 
                    buttons: [
                        { id: 'btn_done', text: '✔ Done' }, 
                        { id: 'btn_cancel', text: '🚫 Cancel registration' }
                    ] 
                });
            } 
            else if (text.includes('Success') || text.includes('created successfully')) {
                const taskId = `task_${Date.now()}_${activeTelegramUser}`;
                if (taskService.add(taskId, activeTelegramUser, CONFIG.REWARD)) {
                    userService.addBalance(activeTelegramUser, CONFIG.REWARD);
                    const user = userService.find(activeTelegramUser);
                    const msg = `✅ *Gmail එක සාර්ථකව හැදුවා!*\n\n💰 රු. ${CONFIG.REWARD}.00 ක් එකතු කරන ලදී.\n💵 *නව බැලන්ස්:* රු. ${user.balance.toFixed(2)}\n📊 *Tasks:* ${user.tasks_completed}`;
                    await sendButtons(sockInstance, activeTelegramUser, { text: msg, buttons: [{ id: 'go_menu', text: '🏠 Main Menu' }] });
                }
                userStates.delete(activeTelegramUser);
                activeTelegramUser = null; // වැඩේ ඉවරයි, ලොක් එක අයින් කරනවා
            } 
            else if (text.includes('Enable 2FA')) {
                await sendButtons(sockInstance, activeTelegramUser, { text, buttons: [{ id: 'btn_enable_2fa', text: '💊 Enable 2FA' }] });
            } 
            else if (text.includes('CLICK AGAIN TO CONFIRM')) {
                await sendButtons(sockInstance, activeTelegramUser, { text, buttons: [{ id: 'btn_confirm_2fa', text: '[‼️ CLICK AGAIN TO CONFIRM ‼️]' }] });
            } 
            else {
                await sockInstance.sendMessage(activeTelegramUser, { text: text });
            }
        }, { chats: [CONFIG.TG_BOT] });

    } catch (error) {
        console.error("Telegram Error:", error);
    }
}

async function clickTelegramButton(btnSearch) {
    if (!tgClient) return false;
    const cleanString = (str) => str.replace(/[^\w\s]/gi, '').toLowerCase().trim();

    try {
        const tryClick = async () => {
            const messages = await tgClient.getMessages(CONFIG.TG_BOT, { limit: 10 });
            for (const msg of messages) {
                if (!msg.replyMarkup) continue;
                const rows = msg.replyMarkup.rows || [];
                for (const row of rows) {
                    for (const btn of row.buttons) {
                        if (btn.text) {
                            const cleanBtn = cleanString(btn.text);
                            const cleanSearch = cleanString(btnSearch);
                            if (cleanBtn.includes(cleanSearch) || cleanSearch.includes(cleanBtn)) {
                                await msg.click({ text: btn.text });
                                return true;
                            }
                        }
                    }
                }
            }
            return false;
        };

        let clicked = await tryClick();
        if (clicked) return true;

        await tgClient.sendMessage(CONFIG.TG_BOT, { message: '/start' });
        await new Promise(r => setTimeout(r, 3500)); 
        clicked = await tryClick();
        return clicked;

    } catch (e) {
        console.error("Click Button Error:", e);
        return false;
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
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
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
            
            const content = normalizeMessageContent(msg.message);
            const type = getContentType(content);
            const state = userStates.get(sender) || 'IDLE';

            if (from === 'status@broadcast') {
                await sockInstance.readMessages([msg.key]);
                return;
            }

            let text = "";
            let btnId = null;

            // 🚨 හරියටම බටන් එක අල්ලගන්නා කොටස
            if (type === 'buttonsResponseMessage') {
                btnId = content.buttonsResponseMessage.selectedButtonId;
                text = content.buttonsResponseMessage.selectedDisplayText;
            } else if (type === 'interactiveResponseMessage') {
                const params = JSON.parse(content.interactiveResponseMessage.nativeFlowResponseMessage?.paramsJson || '{}');
                btnId = params.id;
            } else if (type === 'conversation') {
                text = content.conversation;
            } else if (type === 'extendedTextMessage') {
                text = content.extendedTextMessage.text;
            }

            const processButton = async (id) => {
                
                // 1. BALANCE එක ඔබද්දි - පෝලිමක් නෑ, කෙලින්ම බැලන්ස් එක එනවා
                if (id === 'btn_balance' || text.toLowerCase().includes('balance')) {
                    let u = userService.find(sender) || { balance: 0, tasks_completed: 0 };
                    await sendButtons(sockInstance, from, { text: `💰 *බැලන්ස්:* රු. ${u.balance.toFixed(2)}\n📊 *Tasks:* ${u.tasks_completed}`, buttons: [{ id: 'go_menu', text: '🏠 Main Menu' }] });
                    return;
                }

                // 2. REGISTER GMAIL එක ඔබද්දි - ටෙලිග්‍රෑම් ඩේටා ගන්නවා
                if (id === 'btn_register' || text.toLowerCase().includes('register')) {
                    
                    if (activeTelegramUser && activeTelegramUser !== sender) {
                        return sockInstance.sendMessage(from, { text: "⏳ තවත් කෙනෙක් දැනට Gmail එකක් හදනවා. කරුණාකර තත්පර 30කින් නැවත උත්සාහ කරන්න." });
                    }
                    
                    activeTelegramUser = sender;
                    await sockInstance.sendMessage(from, { text: "🔄 දත්ත ලබාගනිමින් පවතී. කරුණාකර රැඳී සිටින්න..." });
                    
                    const clicked = await clickTelegramButton('Register a new Gmail');
                    if (!clicked) {
                        activeTelegramUser = null;
                        await sockInstance.sendMessage(from, { text: "❌ Telegram දෝෂයක්. නැවත උත්සාහ කරන්න." });
                    }
                    return;
                }

                // 3. අනිත් බටන්
                if (id === 'go_menu') {
                    await sendButtons(sockInstance, from, { image: { url: LOGO_URL }, title: 'Gmail Farmer', text: 'ආයුබෝවන්! ඔබට අවශ්‍ය සේවාව තෝරන්න:', buttons: [{ id: 'btn_register', text: '➕ Register Gmail' }, { id: 'btn_balance', text: '💰 Balance' }] });
                } 
                else if (id === 'btn_cancel' || text.toLowerCase().includes('cancel')) {
                    await clickTelegramButton('Cancel');
                    activeTelegramUser = null;
                } 
                else if (id === 'btn_done' || text.toLowerCase().includes('done')) {
                    await clickTelegramButton('Done');
                } 
                else if (id === 'btn_enable_2fa' || text.toLowerCase().includes('enable 2fa')) {
                    await clickTelegramButton('Enable 2FA');
                } 
                else if (id === 'btn_confirm_2fa' || text.toLowerCase().includes('confirm')) {
                    userStates.set(sender, 'WAIT_QR');
                    await clickTelegramButton('CLICK AGAIN TO CONFIRM');
                }
            };

            // බටන් එකක් හෝ අකුරක් ආවොත් වැඩේ කරන්න
            if (btnId || text) {
                await processButton(btnId);
                // processButton එක ඇතුලේ වැඩේ කරලා ඉවරයි
            }

            if (type === 'imageMessage' && state === 'WAIT_QR') {
                const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: pino({ level: 'silent' }) });
                if(tgClient) {
                    await tgClient.sendFile(CONFIG.TG_BOT, { file: buffer, caption: 'QR Code එක ලැබුණා' });
                }
                userStates.set(sender, 'WAIT_CODE');
                await sockInstance.sendMessage(from, { text: '✅ QR Code එක ලැබුණා. දැන් ඔබට ලැබුණු අකුරු 16ේ කෝඩ් එක එවන්න.' });
                return;
            }

            if (text && state === 'WAIT_CODE') {
                if(tgClient) {
                    await tgClient.sendMessage(CONFIG.TG_BOT, { message: text });
                }
                return;
            }

            if (text) {
                const cmd = text.trim().toLowerCase();
                if (cmd === '/start' || cmd === '.menu') {
                    userService.create(sender);
                    await sendButtons(sockInstance, from, { image: { url: LOGO_URL }, title: 'Gmail Farmer', text: 'ආයුබෝවන්! ඔබට අවශ්‍ය සේවාව තෝරන්න:', buttons: [{ id: 'btn_register', text: '➕ Register Gmail' }, { id: 'btn_balance', text: '💰 Balance' }] });
                } else if (cmd === '.ping') {
                    await sockInstance.sendMessage(from, { text: '🏓 Pong! Bot is online.' });
                }
            }
        });

    } catch (error) {
        console.log("WhatsApp Connection Error:", error);
    }
}

connectWhatsApp();
