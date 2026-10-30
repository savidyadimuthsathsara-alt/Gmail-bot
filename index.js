import makeWASocket, { useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import express from 'express';
import pino from 'pino';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import giftedBtns from 'gifted-btns';
const { sendButtons } = giftedBtns;

import telegramPkg from "telegram";
const { TelegramClient } = telegramPkg;

import sessionsPkg from "telegram/sessions/index.js";
const { StringSession } = sessionsPkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// 1. Configuration (Railway Environment Variables)
// ==========================================
const CONFIG = {
    PORT: process.env.PORT || 3000,
    DASHBOARD_PASSWORD: process.env.DASHBOARD_PASSWORD || "admin123", 
    BOT_PHONE_NUMBER: process.env.BOT_PHONE_NUMBER || "94771234567", 
    REWARD: 30, // රු. 30
    
    TG_API_ID: parseInt(process.env.TG_API_ID || "0"),
    TG_API_HASH: process.env.TG_API_HASH || "",
    TG_SESSION: process.env.TG_SESSION || "", 
    TG_BOT: process.env.TG_BOT || "@GmailFarmerBot" 
};

const LOGO_URL = 'https://files.catbox.moe/eic9dy.png';

// ==========================================
// 2. Database Setup (SQLite)
// ==========================================
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
        } catch (e) { 
            return false; // Duplicate task
        }
    }
};

// ==========================================
// 3. State Management
// ==========================================
let currentPairingCode = null;
let waStatus = 'offline';
let sockInstance = null;
let tgClient = null;
const userStates = new Map(); // WhatsApp user step (WAIT_QR, WAIT_CODE)
const waToTgMap = new Map();  // Map WhatsApp User to Telegram

// ==========================================
// 4. Express Server (Admin Dashboard)
// ==========================================
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/api/dashboard', (req, res) => {
    res.json({
        status: waStatus,
        pairingCode: currentPairingCode,
        users: userService.getAll()
    });
});
app.listen(CONFIG.PORT, () => console.log(`🌐 Dashboard: http://localhost:${CONFIG.PORT}`));

// ==========================================
// 5. Telegram Relay Logic
// ==========================================
async function initTelegram() {
    if (!CONFIG.TG_SESSION || CONFIG.TG_API_ID === 0) {
        console.log("⚠️ Telegram Config missing. Bot will run without Telegram.");
        return;
    }
    
    try {
        const session = new StringSession(CONFIG.TG_SESSION);
        tgClient = new TelegramClient(session, CONFIG.TG_API_ID, CONFIG.TG_API_HASH, { connectionRetries: 5 });
        await tgClient.connect();
        console.log("✅ Telegram Connected!");

        tgClient.addEventHandler(async (event) => {
            const message = event.message;
            if (!message.message && !message.media) return;

            const waChatId = waToTgMap.get(CONFIG.TG_BOT);
            if (!waChatId) return;

            const text = message.message || '';

            // සාර්ථක මැසේජ් එකක් ආවොත් බැලන්ස් එක එකතු කිරීම
            if (text.includes('Success') || text.includes('created successfully')) {
                const taskId = `task_${Date.now()}_${waChatId}`;
                if (taskService.add(taskId, waChatId, CONFIG.REWARD)) {
                    userService.addBalance(waChatId, CONFIG.REWARD);
                    const user = userService.find(waChatId);
                    const msg = `✅ *Gmail එක සාර්ථකව හැදුවා!*\n\n💰 රු. ${CONFIG.REWARD}.00 ක් එකතු කරන ලදී.\n💵 *නව බැලන්ස්:* රු. ${user.balance.toFixed(2)}\n📊 *Tasks:* ${user.tasks_completed}`;
                    await sendButtons(sockInstance, waChatId, { text: msg, buttons: [{ id: 'go_menu', text: '🏠 Main Menu' }] });
                }
                userStates.delete(waChatId);
            } 
            else if (text.includes('Done') || text.includes('Cancel') || text.includes('registration')) {
                await sendButtons(sockInstance, waChatId, { text, buttons: [{ id: 'btn_done', text: '✔ Done' }, { id: 'btn_cancel', text: '🚫 Cancel registration' }] });
            } 
            else if (text.includes('Enable 2FA')) {
                await sendButtons(sockInstance, waChatId, { text, buttons: [{ id: 'btn_enable_2fa', text: '💊 Enable 2FA (0.23$)' }] });
            } 
            else if (text.includes('CLICK AGAIN TO CONFIRM')) {
                await sendButtons(sockInstance, waChatId, { text, buttons: [{ id: 'btn_confirm_2fa', text: '[‼️ CLICK AGAIN TO CONFIRM ‼️]' }] });
            } 
            else if (text.toLowerCase().includes('qr')) {
                await sockInstance.sendMessage(waChatId, { text: text });
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
    if (!tgClient) return;
    waToTgMap.set(CONFIG.TG_BOT, waUserId);
    try {
        if (mediaBuffer) {
            await tgClient.sendFile(CONFIG.TG_BOT, { file: mediaBuffer, caption: text });
        } else {
            await tgClient.sendMessage(CONFIG.TG_BOT, { message: text });
        }
    } catch (error) {
        console.log("Error sending to TG:", error.message);
    }
}

// ==========================================
// 6. WhatsApp Bot Logic (Baileys)
// ==========================================
async function connectWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState(path.join(dataDir, 'auth_info'));
    
    sockInstance = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['Gmail Farmer', 'Chrome', '1.0.0']
    });

    if (!sockInstance.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const code = await sockInstance.requestPairingCode(CONFIG.BOT_PHONE_NUMBER.replace(/[^0-9]/g, ''));
                currentPairingCode = code;
                console.log(`🔑 Pairing Code: ${code}`);
            } catch (err) { console.log("Pairing Code Error:", err.message); }
        }, 5000);
    }

    sockInstance.ev.on('creds.update', saveCreds);

    sockInstance.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            waStatus = 'offline';
            currentPairingCode = null;
            const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) connectWhatsApp();
        } else if (connection === 'open') {
            waStatus = 'connected';
            currentPairingCode = null;
            console.log('✅ WhatsApp Connected!');
            initTelegram();
        }
    });

    sockInstance.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const sender = msg.key.participant || from;
        const type = Object.keys(msg.message)[0];
        const state = userStates.get(sender) || 'IDLE';

        // Auto Read Status
        if (from === 'status@broadcast') {
            await sockInstance.readMessages([msg.key]);
            return;
        }

        // --- Handle Buttons ---
        if (type === 'buttonsResponseMessage' || type === 'interactiveResponseMessage') {
            const btnId = msg.message.buttonsResponseMessage?.selectedButtonId 
                       || JSON.parse(msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson || '{}').id;

            if (btnId === 'btn_register') await sendToTg(sender, '/start');
            else if (btnId === 'btn_balance') {
                let u = userService.find(sender) || { balance: 0, tasks_completed: 0 };
                await sendButtons(sockInstance, from, { text: `💰 *බැලන්ස්:* රු. ${u.balance.toFixed(2)}\n📊 *Tasks:* ${u.tasks_completed}`, buttons: [{ id: 'go_menu', text: '🏠 Main Menu' }] });
            }
            else if (btnId === 'go_menu') {
                await sendButtons(sockInstance, from, { image: { url: LOGO_URL }, title: 'Gmail Farmer', text: 'ආයුබෝවන්! ඔබට අවශ්‍ය සේවාව තෝරන්න:', buttons: [{ id: 'btn_register', text: '➕ Register Gmail' }, { id: 'btn_balance', text: '💰 Balance' }] });
            }
            else if (btnId === 'btn_cancel') await sendToTg(sender, 'Cancel');
            else if (btnId === 'btn_done') await sendToTg(sender, 'Done');
            else if (btnId === 'btn_enable_2fa') await sendToTg(sender, 'Enable 2FA');
            else if (btnId === 'btn_confirm_2fa') {
                userStates.set(sender, 'WAIT_QR');
                await sendToTg(sender, 'Confirm');
            }
            return;
        }

        // --- Handle QR Image ---
        if (type === 'imageMessage' && state === 'WAIT_QR') {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            await sendToTg(sender, 'QR Code එක ලැබුණා', buffer);
            userStates.set(sender, 'WAIT_CODE');
            await sockInstance.sendMessage(from, { text: '✅ QR Code එක ලැබුණා. දැන් ඔබට ලැබුණු අකුරු 16ේ කෝඩ් එක එවන්න.' });
            return;
        }

        // --- Handle Text (Commands & 16-Char Code) ---
        if (type === 'conversation' || type === 'extendedTextMessage') {
            const text = msg.message.conversation || msg.message.extendedTextMessage.text;
            const cmd = text.trim().toLowerCase();

            if (state === 'WAIT_CODE') {
                await sendToTg(sender, text);
                return;
            }

            if (cmd === '/start' || cmd === '.menu') {
                userService.create(sender);
                await sendButtons(sockInstance, from, { image: { url: LOGO_URL }, title: 'Gmail Farmer', text: 'ආයුබෝවන්! ඔබට අවශ්‍ය සේවාව තෝරන්න:', buttons: [{ id: 'btn_register', text: '➕ Register Gmail' }, { id: 'btn_balance', text: '💰 Balance' }] });
            } 
            else if (cmd === '.ping') await sockInstance.sendMessage(from, { text: '🏓 Pong! Bot is online.' });
            else if (cmd === 'balance') {
                let u = userService.find(sender) || { balance: 0, tasks_completed: 0 };
                await sendButtons(sockInstance, from, { text: `💰 *බැලන්ස්:* රු. ${u.balance.toFixed(2)}\n📊 *Tasks:* ${u.tasks_completed}`, buttons: [{ id: 'go_menu', text: '🏠 Main Menu' }] });
            }
        }
    });
}

// Start the bot
connectWhatsApp();
