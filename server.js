const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const fetch = globalThis.fetch || ((...args) =>
    import("node-fetch").then(({ default: fetch }) => fetch(...args)));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const db = new sqlite3.Database("./database.db");
const SECRET = "geheim123";
const STATE_FILE = process.env.STATE_FILE || "./state.json";

// Discord Webhooks
const WEBHOOK_LIVE = "https://discord.com/api/webhooks/1448465091199635518/bKMPlZhx32ffSTG3SuXspC8h7N3_R3fsxXEjztUiLrn_RtmgCgFCLne53tSZ2LnfZ0Nl"; // Live Embed
const WEBHOOK_LOG = "https://discord.com/api/webhooks/1448464870335971433/9U5N7iieNwJRjzGWEl_A9DKzPj4ruWk2eV0naFhsosTKwJs8re33ADjd8I9vjzJLqPrF";  // Log

// Live Message ID speichern
const LIVE_MSG_FILE = "liveMessageId.txt";
let liveMessageId = fs.existsSync(LIVE_MSG_FILE) ? fs.readFileSync(LIVE_MSG_FILE,"utf8") : null;

app.use(express.json({ limit: "2mb" }));
app.use(express.static("public"));

function readStateFile() {
    try {
        if (!fs.existsSync(STATE_FILE)) return {};
        const raw = fs.readFileSync(STATE_FILE, "utf8");
        if (!raw.trim()) return {};
        const data = JSON.parse(raw);
        return data && typeof data === "object" ? data : {};
    } catch (err) {
        console.log("State read failed:", err);
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
    const payload = req.body;
    if (!payload || typeof payload !== "object") {
        return res.status(400).send("Invalid state");
    }
    writeStateFile(payload);
    res.json({ ok: true });
});

// Tabellen erstellen
db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    password TEXT,
    role TEXT DEFAULT 'user'
)`);

db.run(`CREATE TABLE IF NOT EXISTS inventory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    product_name TEXT,
    quantity INTEGER
)`);

// Auth Middleware
function auth(req,res,next){
    const token = req.headers.authorization;
    if(!token) return res.sendStatus(401);
    try{
        const decoded = jwt.verify(token, SECRET);
        req.userId = decoded.id;
        req.role = decoded.role;
        req.username = decoded.username;
        next();
    } catch {
        res.sendStatus(403);
    }
}

// --------------------------------------
// Discord Embed: Löschen + neue Nachricht
// --------------------------------------
async function updateLiveWebhookEmbed(rows){
    try{
        const webhookParts = WEBHOOK_LIVE.split('/');
        const webhookId = webhookParts[webhookParts.length-2];
        const webhookToken = webhookParts[webhookParts.length-1];

        // Alte Nachricht löschen, falls vorhanden
        if(liveMessageId){
            const deleteUrl = `https://discord.com/api/webhooks/${webhookId}/${webhookToken}/messages/${liveMessageId}`;
            await fetch(deleteUrl, { method: "DELETE" }).catch(()=>{});
            liveMessageId = null;
            fs.writeFileSync(LIVE_MSG_FILE,"");
        }

        // Embed erstellen
        const embed = {
            title: "📦 Lagerbestand",
            color: 0x00ff00,
            fields: rows.map(r=>({
                name: r.product_name,
                value: `Menge: ${r.quantity}`,
                inline: true
            })),
            timestamp: new Date()
        };

        // Neue Nachricht posten
        const url = `https://discord.com/api/webhooks/${webhookId}/${webhookToken}`;
        const res = await fetch(url,{
            method:"POST",
            headers:{"Content-Type":"application/json"},
            body: JSON.stringify({ embeds: [embed] })
        });
        const data = await res.json();
        liveMessageId = data.id;
        fs.writeFileSync(LIVE_MSG_FILE, liveMessageId);

    } catch(e){
        console.log("Fehler Live Webhook:", e);
    }
}

// ----------------
// Auth Routen
// ----------------
app.post("/register", async (req,res)=>{
    const {username,password,role} = req.body;
    const hashed = await bcrypt.hash(password,10);
    db.run("INSERT INTO users (username,password,role) VALUES (?,?,?)",[username,hashed,role||"user"],function(err){
        if(err) return res.status(400).send("User existiert");
        res.sendStatus(200);
    });
});

app.post("/login",(req,res)=>{
    const {username,password} = req.body;
    db.get("SELECT * FROM users WHERE username=?",[username], async (err,user)=>{
        if(!user) return res.status(400).send("Falsch");
        const valid = await bcrypt.compare(password,user.password);
        if(!valid) return res.status(400).send("Falsch");
        const token = jwt.sign({id:user.id,role:user.role,username:user.username},SECRET);
        res.json({token});
    });
});

// ----------------
// CRUD Lager
// ----------------

// HINZUFÜGEN
app.post("/inventory",auth, async (req,res)=>{
    const {product_name,quantity} = req.body;
    db.run("INSERT INTO inventory (user_id,product_name,quantity) VALUES (?,?,?)",[req.userId,product_name,quantity], async function(){
        // Log Webhook
        await fetch(WEBHOOK_LOG, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ content: `📝 ${req.username} hat ${product_name} (${quantity}) hinzugefügt`}) });

        // Warnung bei niedrigem Bestand
        if(quantity < 5) await fetch(WEBHOOK_LOG, { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ content: `⚠ Warnung: ${product_name} nur noch ${quantity} im Lager`}) });

        // Live Embed aktualisieren
        db.all("SELECT * FROM inventory", [], async (err, rows)=>{ await updateLiveWebhookEmbed(rows); });

        io.emit("update");
        res.sendStatus(200);
    });
});

// GET INVENTORY
app.get("/inventory",auth,(req,res)=>{
    db.all("SELECT * FROM inventory",[],(err,rows)=>res.json(rows));
});

// UPDATE
app.put("/inventory/:id",auth, async (req,res)=>{
    const {product_name,quantity} = req.body;
    db.run("UPDATE inventory SET product_name=?,quantity=? WHERE id=?",[product_name,quantity,req.params.id], async ()=>{
        await fetch(WEBHOOK_LOG,{ method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ content: `✏️ ${req.username} hat ${product_name} (${quantity}) bearbeitet`}) });
        db.all("SELECT * FROM inventory", [], async (err, rows)=>{ await updateLiveWebhookEmbed(rows); });
        io.emit("update");
        res.sendStatus(200);
    });
});

// DELETE
app.delete("/inventory/:id",auth, async (req,res)=>{
    db.get("SELECT * FROM inventory WHERE id=?",[req.params.id], async (err,item)=>{
        if(!item) return res.sendStatus(404);
        db.run("DELETE FROM inventory WHERE id=?",[req.params.id], async ()=>{
            await fetch(WEBHOOK_LOG,{ method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ content: `❌ ${req.username} hat ${item.product_name} (${item.quantity}) gelöscht`}) });
            db.all("SELECT * FROM inventory", [], async (err, rows)=>{ await updateLiveWebhookEmbed(rows); });
            io.emit("update");
            res.sendStatus(200);
        });
    });
});

// CSV EXPORT
app.get("/export",auth,(req,res)=>{
    db.all("SELECT * FROM inventory",[],(err,rows)=>{
        const csv=["ID,Produkt,Menge"];
        rows.forEach(r=>csv.push(`${r.id},${r.product_name},${r.quantity}`));
        fs.writeFileSync("export.csv", csv.join("\n"));
        res.download("export.csv");
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});

