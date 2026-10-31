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
    DisconnectReason, // මේක දැන් හරියට import වෙනවා
    Browsers,
    downloadMediaMessage,
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

let requestQueue = []; 
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
            if (!activeTelegramUser) return;

            let text = message.message || message.text || '';
            if (!text && !message.media) return;

            const isRelevant = /Register Gmail|Email|Password|Success|created|Enable 2FA|CLICK AGAIN|QR|Confirm|Done|Cancel/i.test(text) || message.media;
            if (!isRelevant) return; 

            text = text.replace(/from\s*[\d.]+\$\s*to\s*[\d.]+\$/gi, "LKR 30.00");
            text = text.replace(/[\d.]+(\$| USD)/gi, "LKR 30.00");

            if (text.includes('too often')) {
                await sockInstance.sendMessage(activeTelegramUser, { text: "⚠️ කරුණාකර තත්පර 30ක් රැඳී සිට නැවත උත්සාහ කරන්න. (Telegram Rate Limit)" });
                processNextInQueue();
                return;
            }

            if (text.includes('Register Gmail accounts') || text.includes('Email:') || text.includes('Password:')) {
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
                processNextInQueue();
            } 
            else if (text.includes('Enable 2FA')) {
                await sendButtons(sockInstance, activeTelegramUser, { text, buttons: [{ id: 'btn_enable_2fa', text: '💊 Enable 2FA' }] });
            } 
            else if (text.includes('CLICK AGAIN TO CONFIRM')) {
                await sendButtons(sockInstance, activeTelegramUser, { text, buttons: [{ id: 'btn_confirm_2fa', text: '[‼️ CLICK AGAIN TO CONFIRM ‼️]' }] });
            } 
            else if (text.trim() !== '') {
                await sockInstance.sendMessage(activeTelegramUser, { text: text });
            }
        }, { chats: [CONFIG.TG_BOT] });

    } catch (error) {
        console.error("Telegram Error:", error);
    }
}

async function processNextInQueue() {
    activeTelegramUser = null;
    if (requestQueue.length > 0) {
        const nextUser = requestQueue.shift();
        activeTelegramUser = nextUser;
        
        await sockInstance.sendMessage(nextUser, { text: "🔄 ඔබගේ වාරය දැන් එලඹ ඇත. Telegram බොට් සම්බන්ධ වෙමින් පවතී..." });
        
        const clicked = await clickTelegramButton('Register a new Gmail');
        if (!clicked) {
            await sockInstance.sendMessage(nextUser, { text: "❌ Telegram බොට් එක සම්බන්ධ කරගැනීමේ දෝෂයක්. කරුණාකර නැවත උත්සාහ කරන්න." });
            processNextInQueue();
        }
    }
}

async function clickTelegramButton(btnSearch) {
    if (!tgClient) return false;
    const cleanString = (str) => str.replace(/[^\w\s]/gi, '').toLowerCase().trim();

    try {
        const tryClick = async () => {
            const messages = await tgClient.getMessages(CONFIG.TG_BOT, { limit: 15 });
            for (const msg of messages) {
                if (!msg.replyMarkup) continue;
                const rows = msg.replyMarkup.rows || [];
                for (const row of rows) {
                    for (const btn of row.buttons) {
                        if (btn.text) {
                            const cleanBtn = cleanString(btn.text);
                            const cleanSearch = cleanString(btnSearch);
                            if (cleanBtn.includes(cleanSearch) || cleanSearch.includes(cleanBtn)) {
                                console.log(`🎯 Found & Clicking TG Button: "${btn.text}"`);
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

        console.log(`⚠️ Button not found. Sending /start to TG...`);
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
                
                // 🚨 මෙතන තමයි එරර් එක ආවේ. දැන් ඒක හදලා තියෙනවා.
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                
                if (shouldReconnect) {
                    console.log('Reconnecting...');
                    connectWhatsApp();
                } else {
                    console.log('Logged out. Not reconnecting.');
                }
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
            
            const type = getContentType(msg.message);
            const state = userStates.get(sender) || 'IDLE';

            if (from === 'status@broadcast') {
                await sockInstance.readMessages([msg.key]);
                return;
            }

            const rawMsgString = JSON.stringify(msg.message).toLowerCase();
            let btnId = null;
            let text = "";

            if (rawMsgString.includes('register gmail')) {
                btnId = 'btn_register';
            } else if (rawMsgString.includes('"balance"')) {
                btnId = 'btn_balance';
            } else if (rawMsgString.includes('main menu')) {
                btnId = 'go_menu';
            } else if (rawMsgString.includes('done')) {
                btnId = 'btn_done';
            } else if (rawMsgString.includes('cancel')) {
                btnId = 'btn_cancel';
            } else if (rawMsgString.includes('enable 2fa')) {
                btnId = 'btn_enable_2fa';
            } else if (rawMsgString.includes('confirm')) {
                btnId = 'btn_confirm_2fa';
            } else {
                text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
            }

            const processButton = async (id) => {
                if (id === 'btn_register') {
                    if (activeTelegramUser === sender) {
                        return sockInstance.sendMessage(from, { text: "⏳ ඔබ දැනටමත් වැඩ කරමින් සිටී." });
                    }
                    if (!requestQueue.includes(sender) && activeTelegramUser !== sender) {
                        requestQueue.push(sender);
                        await sockInstance.sendMessage(from, { text: `⏳ ඔබව පෝලිමට එකතු කරගත්තා. ඉදිරියෙන් ඉන්නේ ${requestQueue.length - 1} දෙනෙක්.` });
                    }
                    if (!activeTelegramUser) {
                        processNextInQueue();
                    }
                } 
                else if (id === 'btn_balance') {
                    let u = userService.find(sender) || { balance: 0, tasks_completed: 0 };
                    await sendButtons(sockInstance, from, { text: `💰 *බැලන්ස්:* රු. ${u.balance.toFixed(2)}\n📊 *Tasks:* ${u.tasks_completed}`, buttons: [{ id: 'go_menu', text: '🏠 Main Menu' }] });
                } 
                else if (id === 'go_menu') {
                    await sendButtons(sockInstance, from, { image: { url: LOGO_URL }, title: 'Gmail Farmer', text: 'ආයුබෝවන්! ඔබට අවශ්‍ය සේවාව තෝරන්න:', buttons: [{ id: 'btn_register', text: '➕ Register Gmail' }, { id: 'btn_balance', text: '💰 Balance' }] });
                } 
                else if (id === 'btn_cancel') {
                    await clickTelegramButton('Cancel');
                    processNextInQueue(); 
                } 
                else if (id === 'btn_done') {
                    await clickTelegramButton('Done');
                } 
                else if (id === 'btn_enable_2fa') {
                    await clickTelegramButton('Enable 2FA');
                } 
                else if (id === 'btn_confirm_2fa') {
                    userStates.set(sender, 'WAIT_QR');
                    await clickTelegramButton('CLICK AGAIN TO CONFIRM');
                }
            };

            if (btnId) {
                console.log(`👉 Button Detected: ${btnId}`);
                await processButton(btnId);
                return;
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
