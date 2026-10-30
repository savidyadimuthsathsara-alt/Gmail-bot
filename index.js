"use strict";

const express = require("express");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require("@whiskeysockets/baileys");

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "auth");
const DB_FILE = path.join(DATA_DIR, "balances.json");
const LOGO_URL = "https://files.catbox.moe/eic9dy.png";
const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || "").split(",").map(x => x.replace(/\D/g, "")).filter(Boolean);
const PAIR_TOKEN = process.env.PAIR_TOKEN || "";
const STATUS_AUTO_READ = process.env.STATUS_AUTO_READ !== "false";

fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });

function readBalances() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); }
  catch { return {}; }
}
let balances = readBalances();
function saveBalances() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(balances, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function phoneFromJid(jid) { return String(jid || "").split("@")[0].replace(/\D/g, ""); }
function isAdmin(jid) { return ADMIN_NUMBERS.includes(phoneFromJid(jid)); }
function menuText() {
  return `🌱 *GMAIL FARMER WHATSAPP BOT*\n\n📩 1. Register New Gmail\n💰 2. Balance\n\nReply with *1* or *2*.`;
}
function getBalance(jid) {
  const key = phoneFromJid(jid);
  return Number(balances[key]?.balance || 0);
}
async function sendMenu(sock, jid) {
  const welcome = "👋 *Welcome to GMAIL FARMER WHATSAPP BOT*\\n\\nChoose an option below:";
  try {
    await sock.sendMessage(jid, { image: { url: LOGO_URL }, caption: welcome });
  } catch {
    await sock.sendMessage(jid, { text: welcome });
  }

  // Two selectable WhatsApp reply buttons, as requested.
  try {
    await sock.sendMessage(jid, {
      text: "🌱 *GMAIL FARMER MENU*",
      footer: "Select one option",
      buttons: [
        { buttonId: "register_new_gmail", buttonText: { displayText: "📩 Register New Gmail" }, type: 1 },
        { buttonId: "balance", buttonText: { displayText: "💰 Balance" }, type: 1 }
      ],
      headerType: 1
    });
  } catch (err) {
    // Compatibility fallback for WhatsApp clients that do not render legacy buttons.
    await sock.sendMessage(jid, {
      text: "🌱 *GMAIL FARMER MENU*\\n\\n1️⃣ 📩 Register New Gmail\\n2️⃣ 💰 Balance\\n\\nReply with *1* or *2*."
    });
  }
}

let sock;
let startPromise;
let pendingPhone = null;
let pairingResult = null;
let pairingError = null;
let pairingPromise = null;

async function startBot() {
  if (startPromise) return startPromise;
  startPromise = (async () => {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const wa = makeWASocket({
      auth: state,
      logger: pino({ level: process.env.LOG_LEVEL || "info" }),
      browser: Browsers.ubuntu("Chrome"),
      printQRInTerminal: false,
      markOnlineOnConnect: false
    });
    wa.ev.on("creds.update", saveCreds);
    wa.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      if (qr && pendingPhone && !pairingResult && !pairingError) {
        try {
          const raw = await wa.requestPairingCode(pendingPhone);
          pairingResult = String(raw).match(/.{1,4}/g)?.join("-") || String(raw);
        } catch (e) {
          pairingError = e.message || "Pairing code request failed";
        } finally {
          pendingPhone = null;
        }
      }
      if (connection === "open") console.log("WhatsApp connected:", wa.user?.id || "connected");
      if (connection === "close") {
        sock = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        if (code !== DisconnectReason.loggedOut) {
          setTimeout(() => startBot().catch(console.error), 5000);
        }
      }
    });
    wa.ev.on("messages.upsert", async ({ type, messages }) => {
      for (const m of messages || []) {
        // Automatically mark incoming WhatsApp Status updates as viewed.
        // Status events must never be handled as ordinary chat messages.
        if (STATUS_AUTO_READ && m.key?.remoteJid === "status@broadcast" && m.key?.id) {
          try {
            await wa.readMessages([{
              remoteJid: "status@broadcast",
              id: m.key.id,
              participant: m.key.participant
            }]);
          } catch (err) {
            console.error("Status auto-read failed:", err.message || err);
          }
          continue;
        }
        if (type !== "notify") continue;
        if (!m.message || m.key.fromMe || m.key.remoteJid?.endsWith("@g.us")) continue;
        const jid = m.key.remoteJid;
        const body = m.message.conversation ||
          m.message.extendedTextMessage?.text ||
          m.message.buttonsResponseMessage?.selectedButtonId ||
          m.message.listResponseMessage?.singleSelectReply?.selectedRowId || "";
        const choice = body.trim().toLowerCase();

        // Basic utility commands
        if ([".ping", "ping"].includes(choice)) {
          await wa.sendMessage(jid, { text: "🏓 *PONG!\\n\\n✅ GMAIL FARMER BOT is online.*" });
          continue;
        }
        if ([".menu", "menu", "/start", "start", "hi", "hello", "0"].includes(choice)) {
          await wa.sendMessage(jid, {
            text: "👋 *Welcome to GMAIL FARMER WHATSAPP BOT*\n\nChoose an option below to continue. You can send /start or .menu anytime to reopen this menu."
          });
          await sendMenu(wa, jid);
          continue;
        }
        if (["2", "balance", "💰 balance", "balance"].includes(choice)) {
          await wa.sendMessage(jid, {
            text: `💰 *Your Balance*\n\nGmail completed: ${Number(balances[phoneFromJid(jid)]?.completed || 0)}\nBalance: *LKR ${getBalance(jid).toFixed(2)}*`
          });
          continue;
        }
        if (["1", "register_new_gmail", "register new gmail", "📩 register new gmail"].includes(choice)) {
          await wa.sendMessage(jid, {
            text: "📩 *Register New Gmail*\n\nRegistration is not connected yet. This starter version does not create Google accounts or bypass Google verification. The Telegram message-relay connection must be configured and tested separately."
          });
          continue;
        }
        if (isAdmin(jid) && choice.startsWith("!credit ")) {
          const parts = choice.split(/\\s+/);
          const target = (parts[1] || "").replace(/\D/g, "");
          const count = Math.max(0, Math.floor(Number(parts[2] || 0)));
          if (!target || !count) {
            await wa.sendMessage(jid, { text: "Use: !credit 947XXXXXXXX 1" });
            continue;
          }
          const entry = balances[target] || { completed: 0, balance: 0 };
          entry.completed += count;
          entry.balance += count * 30;
          balances[target] = entry;
          saveBalances();
          await wa.sendMessage(jid, { text: `Added LKR ${(count * 30).toFixed(2)} to ${target}.` });
          continue;
        }
        await sendMenu(wa, jid);
      }
    });
    return wa;
  })();
  try { sock = await startPromise; return sock; }
  finally { startPromise = null; }
}

const app = express();
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/pair", async (req, res) => {
  if (!PAIR_TOKEN || req.query.token !== PAIR_TOKEN) return res.status(401).json({ ok: false, error: "Unauthorized" });
  const phone = String(req.query.phone || "").replace(/\D/g, "");
  if (!/^[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ ok: false, error: "Enter phone number with country code, digits only." });
  try {
    const wa = sock || await startBot();
    if (wa.user) return res.json({ ok: true, connected: true });
    if (pairingPromise) return res.status(409).json({ ok: false, error: "Pairing request already running." });
    pairingPromise = (async () => {
      pendingPhone = phone;
      pairingResult = null;
      pairingError = null;
      for (let i = 0; i < 40; i++) {
        if (pairingResult) return pairingResult;
        if (pairingError) throw new Error(pairingError);
        await new Promise(r => setTimeout(r, 500));
      }
      throw new Error("Pairing timed out. Try again.");
    })();
    const code = await pairingPromise;
    return res.json({ ok: true, code });
  } catch (e) {
    return res.status(503).json({ ok: false, error: e.message });
  } finally {
    pairingPromise = null;
  }
});

app.listen(PORT, "0.0.0.0", () => console.log(`HTTP server listening on ${PORT}`));
startBot().catch(err => console.error("WhatsApp startup error:", err));
