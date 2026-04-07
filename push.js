// api/push.js — Web Push usando a biblioteca web-push
const webpush    = require("web-push");
const { MongoClient } = require("mongodb");

let _client;
async function getDb() {
  if (!_client || !_client.topology?.isConnected?.()) {
    _client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 3 });
    await _client.connect();
  }
  return _client.db(process.env.MONGODB_DB || "codental_monitor");
}

// Configura VAPID uma vez
webpush.setVapidDetails(
  process.env.VAPID_SUBJECT || "mailto:admin@odontodf.com.br",
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const INTERNAL_KEY = process.env.INTERNAL_API_KEY;

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== INTERNAL_KEY) return res.status(401).json({ error: "Unauthorized" });

  const { action } = req.query;
  const db  = await getDb();
  const col = db.collection("push_subscriptions");

  // ── Salva subscription ──────────────────────────────────────────
  if (req.method === "POST" && action === "subscribe") {
    const { subscription, operatorLogin } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: "subscription required" });
    await col.updateOne(
      { endpoint: subscription.endpoint },
      { $set: { subscription, operatorLogin: operatorLogin || "unknown", updatedAt: new Date() } },
      { upsert: true }
    );
    console.log(`[push] subscribed: ${operatorLogin} → ${subscription.endpoint.slice(0, 50)}`);
    return res.json({ ok: true });
  }

  // ── Remove subscription ─────────────────────────────────────────
  if (req.method === "POST" && action === "unsubscribe") {
    await col.deleteOne({ endpoint: req.body?.endpoint });
    return res.json({ ok: true });
  }

  // ── Envia notificação ───────────────────────────────────────────
  if (req.method === "POST" && action === "notify") {
    const { chatId, title, body, url } = req.body;
    const subs = await col.find({}).toArray();

    if (subs.length === 0) {
      console.log("[push] no subscribers");
      return res.json({ ok: true, sent: 0 });
    }

    const payload = JSON.stringify({ chatId, title, body, url: url || "/" });

    const results = await Promise.allSettled(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification(s.subscription, payload);
          return "ok";
        } catch (e) {
          console.error(`[push] error for ${s.operatorLogin}:`, e.statusCode, e.message);
          if (e.statusCode === 410 || e.statusCode === 404) {
            await col.deleteOne({ _id: s._id });
            console.log(`[push] removed expired subscription: ${s.operatorLogin}`);
          }
          return "error";
        }
      })
    );

    const sent = results.filter(r => r.value === "ok").length;
    console.log(`[push] notified ${sent}/${subs.length} for chat ${chatId}`);
    return res.json({ ok: true, sent, total: subs.length });
  }

  // ── Lista subscriptions ─────────────────────────────────────────
  if (req.method === "GET" && action === "list") {
    const subs = await col.find({}, {
      projection: { operatorLogin: 1, updatedAt: 1, "subscription.endpoint": 1 }
    }).toArray();
    return res.json({ subscriptions: subs });
  }

  return res.status(404).json({ error: "Unknown action" });
};