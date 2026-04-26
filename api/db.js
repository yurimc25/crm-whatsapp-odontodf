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

// Normaliza qualquer chatId para uma chave canônica estável usada como _id no MongoDB.
// Grupos (@g.us) mantêm o ID completo. Individuais viram só dígitos com 9 BR inserido.
// Garante que 5511987654321@c.us e 551187654321@c.us → mesma chave "5511987654321".
function toChatKey(chatId) {
  if (!chatId) return chatId;
  if (chatId.endsWith("@g.us")) return chatId;
  const digits = chatId.replace(/\D/g, "");
  if (!digits) return chatId;
  // Número BR sem o dígito 9: 55 + DDD(2) + 8 digits = 12 → insere 9 após DDD
  if (digits.length === 12 && digits.startsWith("55")) {
    return digits.slice(0, 4) + "9" + digits.slice(4);
  }
  return digits;
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
      // Retorna mapa keyed pela chave canônica E por cada alias conhecido
      // Assim o cliente encontra o status independente do formato de ID que usar
      const map = {};
      for (const d of docs) {
        const entry = { status: d.status, assignedTo: d.assignedTo, tags: d.tags || [], muted: d.muted || false };
        map[d._id] = entry;
        // Expõe também com sufixo @c.us para que o cliente encontre por ID completo do WAHA
        if (!d._id.includes("@")) map[d._id + "@c.us"] = entry;
        for (const alias of (d.aliases || [])) map[alias] = entry;
      }
      return res.json({ chats: map });
    }

    // ── PATCH /api/db?action=chat — atualiza metadata de um chat
    if (req.method === "PATCH" && action === "chat") {
      const { chatId, status, assignedTo, tags, muted } = req.body || {};
      if (!chatId) return res.status(400).json({ error: "chatId obrigatório" });

      // Usa chave canônica como _id — qualquer alias do mesmo número atualiza o mesmo doc
      const canonicalId = toChatKey(chatId);

      const update = {};
      if (status     !== undefined) update.status     = status;
      if (assignedTo !== undefined) update.assignedTo = assignedTo;
      if (tags       !== undefined) update.tags        = tags;
      if (muted      !== undefined) update.muted       = muted;
      update.updatedAt = new Date();

      // $addToSet garante que o alias original fique registrado sem duplicar
      await db.collection("chats").updateOne(
        { _id: canonicalId },
        { $set: update, $addToSet: { aliases: chatId } },
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

    // ── Histórico de mensagens de um chat (scroll infinito) ──
    if (req.method === "GET" && action === "messages") {
      const { chatId, before, limit = "100" } = req.query;
      if (!chatId) return res.status(400).json({ error: "chatId obrigatório" });

      const query = { numero: chatId };
      if (before) query.data = { $lte: before }; // paginação por data

      const docs = await db.collection("conversas")
        .find(query)
        .sort({ data: -1 })
        .limit(parseInt(limit))
        .toArray();

      // Achata todas as mensagens de todos os docs, ordena por ts
      const msgs = docs
        .flatMap(d => d.mensagens || [])
        .sort((a, b) => new Date(a.ts) - new Date(b.ts));

      const oldest = docs[docs.length - 1]?.data || null;
      const hasMore = docs.length === parseInt(limit);

      return res.json({ messages: msgs, oldest, hasMore });
    }

    // ── POST /api/db?action=migrate_chat_keys — unifica docs com IDs não-canônicos (one-shot)
    if (req.method === "POST" && action === "migrate_chat_keys") {
      const docs = await db.collection("chats").find({}).toArray();
      let merged = 0, renamed = 0;
      for (const doc of docs) {
        const canonical = toChatKey(doc._id);
        if (canonical === doc._id) continue; // já é canônico, pula
        const existing = await db.collection("chats").findOne({ _id: canonical });
        if (existing) {
          // Mescla: mantém status mais restrito (resolved > open), acumula aliases
          const aliases = [...new Set([...(existing.aliases || []), ...(doc.aliases || []), doc._id])];
          const status = (existing.status === "resolved" || doc.status === "resolved") ? "resolved" : (existing.status || doc.status);
          await db.collection("chats").updateOne(
            { _id: canonical },
            { $set: { status, aliases, updatedAt: new Date() },
              $max: { updatedAt: existing.updatedAt || new Date(0) } }
          );
          await db.collection("chats").deleteOne({ _id: doc._id });
          merged++;
        } else {
          // Renomeia: cria com chave canônica e remove o antigo
          const { _id, ...rest } = doc;
          const aliases = [...new Set([...(rest.aliases || []), _id])];
          await db.collection("chats").insertOne({ _id: canonical, ...rest, aliases });
          await db.collection("chats").deleteOne({ _id: doc._id });
          renamed++;
        }
      }
      return res.json({ ok: true, merged, renamed, total: docs.length });
    }

    // ── GET /api/db?action=quick-messages — lista mensagens rápidas da clínica
    if (req.method === "GET" && action === "quick-messages") {
      const doc = await db.collection("quick_messages").findOne({ _id: "global" });
      return res.json({ messages: doc?.messages || [] });
    }

    // ── POST /api/db?action=quick-messages — salva lista completa (substitui)
    if (req.method === "POST" && action === "quick-messages") {
      const { messages } = req.body || {};
      if (!Array.isArray(messages)) return res.status(400).json({ error: "messages deve ser array" });
      await db.collection("quick_messages").updateOne(
        { _id: "global" },
        { $set: { messages, updatedAt: new Date() } },
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
