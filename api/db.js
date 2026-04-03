// api/db.js
// Vercel Serverless Function — CRUD no MongoDB Atlas
// Persiste: status dos chats, tags, encaminhamentos, notas internas
//
// Variável no Vercel:
//   MONGODB_URI = mongodb+srv://usuario:senha@cluster.mongodb.net/clinica

import { MongoClient } from "mongodb";

let client;
async function getDb() {
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
  }
  return client.db("clinica");
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");

  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { action } = req.query;

  try {
    const db = await getDb();

    // ── GET /api/db?action=chats — carrega metadata de todos os chats
    if (req.method === "GET" && action === "chats") {
      const docs = await db.collection("chats").find({}).toArray();
      // Retorna um mapa { chatId: { status, assignedTo, tags } }
      const map = {};
      for (const d of docs) map[d._id] = { status: d.status, assignedTo: d.assignedTo, tags: d.tags || [] };
      return res.json({ chats: map });
    }

    // ── PATCH /api/db?action=chat — atualiza metadata de um chat
    if (req.method === "PATCH" && action === "chat") {
      const { chatId, status, assignedTo, tags } = req.body || {};
      if (!chatId) return res.status(400).json({ error: "chatId obrigatório" });

      const update = {};
      if (status     !== undefined) update.status     = status;
      if (assignedTo !== undefined) update.assignedTo = assignedTo;
      if (tags       !== undefined) update.tags        = tags;
      update.updatedAt = new Date();

      await db.collection("chats").updateOne(
        { _id: chatId },
        { $set: update },
        { upsert: true }
      );
      return res.json({ ok: true });
    }

    // ── GET /api/db?action=notes&chatId=xxx — notas de um chat
    if (req.method === "GET" && action === "notes") {
      const { chatId } = req.query;
      if (!chatId) return res.status(400).json({ error: "chatId obrigatório" });
      const notes = await db.collection("notes")
        .find({ chatId })
        .sort({ createdAt: 1 })
        .toArray();
      return res.json({ notes });
    }

    // ── POST /api/db?action=notes — salva nota interna
    if (req.method === "POST" && action === "notes") {
      const { chatId, text, author } = req.body || {};
      if (!chatId || !text) return res.status(400).json({ error: "chatId e text obrigatórios" });

      const result = await db.collection("notes").insertOne({
        chatId, text, author: author || "desconhecido",
        createdAt: new Date(),
      });
      return res.json({ ok: true, id: result.insertedId });
    }

    // ── GET /api/db?action=contacts_cache — cache de contatos no servidor
    if (req.method === "GET" && action === "contacts_cache") {
      const doc = await db.collection("cache").findOne({ _id: "google_contacts" });
      if (!doc || new Date() > new Date(doc.expiresAt)) {
        return res.json({ contacts: null, expired: true });
      }
      return res.json({ contacts: doc.contacts, cachedAt: doc.cachedAt });
    }

    // ── POST /api/db?action=contacts_cache — salva contatos no MongoDB (TTL 1h)
    if (req.method === "POST" && action === "contacts_cache") {
      const { contacts } = req.body || {};
      if (!contacts) return res.status(400).json({ error: "contacts obrigatório" });

      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
      await db.collection("cache").updateOne(
        { _id: "google_contacts" },
        { $set: { contacts, cachedAt: new Date(), expiresAt } },
        { upsert: true }
      );
      return res.json({ ok: true });
    }

    return res.status(404).json({ error: `Ação desconhecida: ${action}` });

  } catch (e) {
    console.error("[db]", e);
    return res.status(500).json({ error: "Erro interno", detail: e.message });
  }
}
