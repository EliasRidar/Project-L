const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");

// fetch fix für Node
const fetch = globalThis.fetch || ((...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args))
);

const app = express();
const server = http.createServer(app);

// Socket.IO korrekt für Render
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ======================
// CONFIG
// ======================

const PORT = process.env.PORT || 3000;
const SECRET = process.env.JWT_SECRET || "super_secret_key";
const STATE_FILE = process.env.STATE_FILE || "./state.json";

// SQLite (Render kompatibel)
const db = new sqlite3.Database("./database.db", (err) => {
  if (err) console.error("SQLite Fehler:", err);
  else console.log("SQLite verbunden");
});

// Discord Webhooks
const WEBHOOK_LIVE = process.env.WEBHOOK_LIVE || "";
const WEBHOOK_LOG = process.env.WEBHOOK_LOG || "";

// Live Message speichern
const LIVE_MSG_FILE = "liveMessageId.txt";
let liveMessageId = fs.existsSync(LIVE_MSG_FILE)
  ? fs.readFileSync(LIVE_MSG_FILE, "utf8")
  : null;

// ======================
// MIDDLEWARE
// ======================

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

// ======================
// STATE FILE
// ======================

function readStateFile() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    if (!raw.trim()) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeStateFile(data) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.log("State write failed:", err);
  }
}

app.get("/api/state", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(readStateFile());
});

app.post("/api/state", (req, res) => {
  if (!req.body || typeof req.body !== "object") {
    return res.status(400).send("Invalid state");
  }

  writeStateFile(req.body);
  res.json({ ok: true });
});

// ======================
// DATABASE TABLES
// ======================

db.run(`
CREATE TABLE IF NOT EXISTS users (
id INTEGER PRIMARY KEY AUTOINCREMENT,
username TEXT UNIQUE,
password TEXT,
role TEXT DEFAULT 'user'
)`);

db.run(`
CREATE TABLE IF NOT EXISTS inventory (
id INTEGER PRIMARY KEY AUTOINCREMENT,
user_id INTEGER,
product_name TEXT,
quantity INTEGER
)`);

// ======================
// AUTH MIDDLEWARE
// ======================

function auth(req, res, next) {
  const token = req.headers.authorization;

  if (!token) return res.sendStatus(401);

  try {
    const decoded = jwt.verify(token, SECRET);

    req.userId = decoded.id;
    req.username = decoded.username;
    req.role = decoded.role;

    next();
  } catch {
    res.sendStatus(403);
  }
}

// ======================
// DISCORD WEBHOOK LIVE
// ======================

async function updateLiveWebhookEmbed(rows) {
  if (!WEBHOOK_LIVE) return;

  try {
    const parts = WEBHOOK_LIVE.split("/");
    const webhookId = parts[parts.length - 2];
    const webhookToken = parts[parts.length - 1];

    // alte löschen
    if (liveMessageId) {
      await fetch(
        `https://discord.com/api/webhooks/${webhookId}/${webhookToken}/messages/${liveMessageId}`,
        { method: "DELETE" }
      ).catch(() => {});
    }

    const embed = {
      title: "📦 Lagerbestand",
      color: 0x00ff00,
      fields: rows.map((r) => ({
        name: r.product_name,
        value: `Menge: ${r.quantity}`,
        inline: true
      })),
      timestamp: new Date()
    };

    const res = await fetch(WEBHOOK_LIVE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ embeds: [embed] })
    });

    const data = await res.json();

    liveMessageId = data.id;

    fs.writeFileSync(LIVE_MSG_FILE, liveMessageId);

  } catch (err) {
    console.log("Webhook Fehler:", err);
  }
}

// ======================
// AUTH ROUTES
// ======================

app.post("/register", async (req, res) => {

  const { username, password, role } = req.body;

  if (!username || !password)
    return res.status(400).send("Missing data");

  const hash = await bcrypt.hash(password, 10);

  db.run(
    "INSERT INTO users (username,password,role) VALUES (?,?,?)",
    [username, hash, role || "user"],
    (err) => {

      if (err)
        return res.status(400).send("User existiert");

      res.sendStatus(200);
    }
  );
});

app.post("/login", (req, res) => {

  const { username, password } = req.body;

  db.get(
    "SELECT * FROM users WHERE username=?",
    [username],
    async (err, user) => {

      if (!user)
        return res.status(400).send("Falsch");

      const valid = await bcrypt.compare(password, user.password);

      if (!valid)
        return res.status(400).send("Falsch");

      const token = jwt.sign(
        {
          id: user.id,
          username: user.username,
          role: user.role
        },
        SECRET
      );

      res.json({ token });
    }
  );
});

// ======================
// INVENTORY CRUD
// ======================

// ADD
app.post("/inventory", auth, (req, res) => {

  const { product_name, quantity } = req.body;

  db.run(
    "INSERT INTO inventory (user_id,product_name,quantity) VALUES (?,?,?)",
    [req.userId, product_name, quantity],
    async () => {

      if (WEBHOOK_LOG) {
        await fetch(WEBHOOK_LOG, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `📝 ${req.username} hat ${product_name} (${quantity}) hinzugefügt`
          })
        });
      }

      db.all("SELECT * FROM inventory", [], async (err, rows) => {

        await updateLiveWebhookEmbed(rows);

        io.emit("update");

        res.sendStatus(200);
      });
    }
  );
});

// GET
app.get("/inventory", auth, (req, res) => {

  db.all("SELECT * FROM inventory", [], (err, rows) => {

    res.json(rows);
  });
});

// DELETE
app.delete("/inventory/:id", auth, (req, res) => {

  db.run(
    "DELETE FROM inventory WHERE id=?",
    [req.params.id],
    () => {

      db.all("SELECT * FROM inventory", [], async (err, rows) => {

        await updateLiveWebhookEmbed(rows);

        io.emit("update");

        res.sendStatus(200);
      });
    }
  );
});

// ======================
// SOCKET.IO
// ======================

io.on("connection", (socket) => {

  console.log("Client verbunden:", socket.id);

  socket.on("disconnect", () => {

    console.log("Client getrennt:", socket.id);
  });
});

// ======================
// START SERVER (RENDER FIX)
// ======================

server.listen(PORT, "0.0.0.0", () => {

  console.log("=================================");
  console.log("Server läuft");
  console.log("Port:", PORT);
  console.log("=================================");

});
