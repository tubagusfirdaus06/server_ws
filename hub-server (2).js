/* ===============================
   HUB SERVER (FULL PERSISTENT DEDUP)
   - Heartbeat
   - ACK handshake
   - Persistent trx journal (ANTI REPLAY)
================================ */

const fs = require("fs");
const path = require("path");
const express = require("express");
const WebSocket = require("ws");

const app = express();
app.use(express.json());

// ===============================
// CONFIG
// ===============================
const HTTP_PORT = process.env.PORT || 8080;
const WS_PATH = "/ws";
const AUTH_TOKEN = process.env.HUB_TOKEN || "";

// ===============================
// DATA DIR
// ===============================
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ===============================
// TRX JOURNAL (PERSISTENT)
// ===============================
const TRX_JOURNAL_FILE = path.join(DATA_DIR, "trx_journal.json");
let trxJournal = new Set();

try {
  if (fs.existsSync(TRX_JOURNAL_FILE)) {
    const arr = JSON.parse(fs.readFileSync(TRX_JOURNAL_FILE, "utf8"));
    if (Array.isArray(arr)) trxJournal = new Set(arr);
  }
} catch (e) {
  console.log("[HUB] journal load failed:", e.message);
}

function saveJournal() {
  try {
    fs.writeFileSync(
      TRX_JOURNAL_FILE,
      JSON.stringify([...trxJournal], null, 2),
      "utf8"
    );
  } catch (e) {
    console.log("[HUB] journal save failed:", e.message);
  }
}

// ===============================
// WEBSOCKET SERVER
// ===============================
const wss = new WebSocket.Server({ noServer: true });
const clients = new Set();

// ===============================
// HEARTBEAT
// ===============================
function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", (ws, req) => {
  console.log("[HUB] WS client connected:", req.socket.remoteAddress);

  ws.isAlive = true;
  ws.on("pong", heartbeat);

  clients.add(ws);

  // 🔐 handshake only (NO replay)
  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "hello") {
        ws.lastTrx = msg.lastTrx || null;
        console.log("[HUB] hello lastTrx =", ws.lastTrx);
      }
    } catch {}
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log("[HUB] WS client disconnected");
  });

  ws.on("error", () => {
    clients.delete(ws);
  });
});

// 🔄 HEARTBEAT LOOP
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log("[HUB] terminate dead socket");
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

// ===============================
// HTTP -> WS NOTIFY (HARD DEDUP)
// ===============================
app.post("/api/notify", (req, res) => {
  try {
    if (AUTH_TOKEN) {
      const token = req.headers["x-hub-token"];
      if (token !== AUTH_TOKEN) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }

    const { trx, user, title, pesan, amount, time } = req.body || {};
    if (!trx) {
      return res.status(400).json({ error: "missing trx" });
    }

    // 🚫 PERSISTENT DEDUP
    if (trxJournal.has(trx)) {
      console.log("[HUB] trx ignored (already processed):", trx);
      return res.json({ ok: true, ignored: true });
    }

    trxJournal.add(trx);
    saveJournal();

    const payload = JSON.stringify({
      type: "notification",
      trx,
      user,
      title,
      pesan,
      amount,
      time
    });

    let sent = 0;
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
        sent++;
      }
    }

    console.log("[HUB] notify broadcast:", trx, "to", sent, "client(s)");
    res.json({ ok: true, sent });

  } catch (err) {
    console.log("[HUB ERR]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===============================
// HTTP SERVER + WS UPGRADE
// ===============================
const server = app.listen(HTTP_PORT, () => {
  console.log("[HUB] HTTP listening on", HTTP_PORT);
});

server.on("upgrade", (req, socket, head) => {
  if (req.url !== WS_PATH) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

// ===============================
// CLEANUP
// ===============================
process.on("SIGTERM", () => {
  clearInterval(heartbeatInterval);
  saveJournal();
  server.close();
});
