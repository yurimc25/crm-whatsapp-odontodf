// api/r2-data.js
// GET /api/r2-data?type=chats              → chats.json
// GET /api/r2-data?type=msgs&chatId=...    → msgs/{chatId}.json
// GET /api/r2-data?type=msgs-list          → lista msgs/ com lastModified + última msg de cada chat
// POST /api/r2-data?type=upload            → upload via JSON base64 (arquivos < 4MB)
// POST /api/r2-data?type=upload-binary     → upload via FormData (arquivos grandes)

import { r2Get, r2Put, r2List } from "./_r2.js";
import { formidable } from "formidable";
import fs from "fs";

export const config = { api: { bodyParser: false } };

function chatKey(chatId) {
  return "msgs/" + chatId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
}
function mediaKey(msgId) {
  return "media/" + String(msgId).replace(/[^a-zA-Z0-9_-]/g, "_");
}

// Normaliza para chave canônica de mapa (merge) — só dígitos para indivíduos
function toChatKey(chatId) {
  if (!chatId) return chatId;
  if (chatId.endsWith("@g.us")) return chatId;
  const digits = chatId.replace(/\D/g, "");
  if (!digits) return chatId;
  if (digits.length === 12 && digits.startsWith("55")) {
    return digits.slice(0, 4) + "9" + digits.slice(4);
  }
  return digits;
}

// ID canônico para armazenar no campo `id` do objeto — preserva sufixo @c.us/@g.us
// para que o cliente consiga fazer match com IDs do WAHA
function toCanonicalId(chatId) {
  if (!chatId) return chatId;
  if (chatId.endsWith("@g.us")) return chatId;
  const ck = toChatKey(chatId);
  return ck.includes("@") ? ck : ck + "@c.us";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { type, chatId } = req.query;

  // ── POST: sync de chats (lista enriquecida para multi-usuário) ──
  if (req.method === "POST" && type === "chats") {
    let body;
    try {
      const raw = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => data += chunk);
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: "JSON inválido" });
    }

    if (!Array.isArray(body)) {
      return res.status(400).json({ error: "Esperado array de chats" });
    }

    try {
      // Lê chats.json atual para merge (não sobrescreve dados de outros clientes)
      const existing = await r2Get("chats.json").then(r =>
        r ? JSON.parse(r.buf.toString("utf8")) : []
      ).catch(() => []);

      // Indexa por chave canônica (mapa interno) mas armazena id com @c.us/@g.us
      // para que o cliente consiga fazer match com IDs do WAHA (wahaIds.has(r2.id))
      const existMap = {};
      for (const c of existing) {
        if (!c.id) continue;
        const ck  = toChatKey(c.id);
        const cid = toCanonicalId(c.id);
        const prev = existMap[ck];
        if (!prev || (c.lastTs || 0) >= (prev.lastTs || 0)) {
          existMap[ck] = { ...c, id: cid };
        }
      }

      // Merge: local vence se mais recente
      for (const c of body) {
        if (!c.id) continue;
        const ck  = toChatKey(c.id);
        const cid = toCanonicalId(c.id);
        const ex  = existMap[ck];
        const localTs  = c.lastTs  || 0;
        const remoteTs = ex?.lastTs || 0;
        if (!ex || localTs >= remoteTs) {
          existMap[ck] = { ...c, id: cid };
        }
      }

      const merged = Object.values(existMap);
      await r2Put("chats.json", Buffer.from(JSON.stringify(merged), "utf8"), "application/json");
      return res.status(200).json({ ok: true, count: merged.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: upload de arquivo para R2 ─────────────────────────────
  if (req.method === "POST" && type === "upload") {
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!publicUrl) return res.status(500).json({ error: "R2_PUBLIC_URL não configurado" });

    let body;
    try {
      // bodyParser desabilitado — lê raw body manualmente
      const raw = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => data += chunk);
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      body = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: "JSON inválido" });
    }

    const { filename, mimetype, data } = body || {};
    if (!filename || !mimetype || !data) {
      return res.status(400).json({ error: "filename, mimetype e data são obrigatórios" });
    }

    try {
      const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const r2Key = `uploads/${Date.now()}-${safeFilename}`;
      const buf = Buffer.from(data, "base64");
      await r2Put(r2Key, buf, mimetype);
      const url = `${publicUrl.replace(/\/$/, "")}/${r2Key}`;
      return res.status(200).json({ ok: true, url });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: upload binário via FormData (arquivos grandes, sem limite base64) ──
  if (req.method === "POST" && type === "upload-binary") {
    const publicUrl = process.env.R2_PUBLIC_URL;
    if (!publicUrl) return res.status(500).json({ error: "R2_PUBLIC_URL não configurado" });

    let filepath, mimetype, filename;
    try {
      const form = formidable({ maxFileSize: 100 * 1024 * 1024 }); // 100MB
      const [fields, files] = await form.parse(req);
      const file = Array.isArray(files.file) ? files.file[0] : files.file;
      if (!file) return res.status(400).json({ error: "Arquivo não enviado" });
      filepath = file.filepath;
      mimetype = file.mimetype || "application/octet-stream";
      filename = file.originalFilename || "file";
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    try {
      const safeFilename = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
      const r2Key = `uploads/${Date.now()}-${safeFilename}`;
      const buf = fs.readFileSync(filepath);
      await r2Put(r2Key, buf, mimetype);
      const url = `${publicUrl.replace(/\/$/, "")}/${r2Key}`;
      return res.status(200).json({ ok: true, url });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    } finally {
      if (filepath) try { fs.unlinkSync(filepath); } catch {}
    }
  }

  // ── POST: salvar/enriquecer mensagens de um chat no R2 ─────────────
  // Usado pelo frontend após merge WAHA para persistir type e wahaShortId de mídias
  if (req.method === "POST" && type === "msgs") {
    if (!chatId) return res.status(400).json({ error: "chatId obrigatório" });

    let incoming;
    try {
      const raw = await new Promise((resolve, reject) => {
        let data = "";
        req.on("data", chunk => data += chunk);
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });
      incoming = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: "JSON inválido" });
    }

    if (!Array.isArray(incoming)) return res.status(400).json({ error: "Esperado array de mensagens" });

    try {
      const existing = await r2Get(chatKey(chatId)).then(r =>
        r ? JSON.parse(r.buf.toString("utf8")) : []
      ).catch(() => []);

      const existMap = {};
      for (const m of existing) if (m.id) existMap[m.id] = m;

      // Índice por timestamp+fromMe para match quando IDs têm formatos diferentes
      // (webhook usa @c.us/Baileys hex; WAHA getMessages usa @lid/servidor hex)
      const existByTs = new Map();
      for (const m of existing) {
        const tsS = Math.floor((m.ts || 0) / 1000);
        const key = `${m.fromMe ? 1 : 0}_${tsS}`;
        if (!existByTs.has(key)) existByTs.set(key, m);
      }

      for (const m of incoming) {
        if (!m.id) continue;
        const mediaFields = {
          type:        m.type && m.type !== "chat" ? m.type : undefined,
          wahaShortId: m.wahaShortId || undefined,
          mediaUrl:    m.mediaUrl || undefined,
          mimetype:    m.mimetype || undefined,
        };

        const ex = existMap[m.id];
        if (ex) {
          // ID exato encontrado — atualiza campos de mídia sem criar duplicata
          existMap[m.id] = {
            ...ex,
            chatId:      ex.chatId      || chatId,
            type:        mediaFields.type        || ex.type,
            wahaShortId: mediaFields.wahaShortId || ex.wahaShortId || null,
            mediaUrl:    mediaFields.mediaUrl    || ex.mediaUrl    || null,
            mimetype:    mediaFields.mimetype    || ex.mimetype    || null,
          };
        } else {
          // Sem match por ID — tenta por timestamp+fromMe para evitar duplicata
          const tsS = Math.floor((m.ts || 0) / 1000);
          const byTs = existByTs.get(`${m.fromMe ? 1 : 0}_${tsS}`);
          if (byTs) {
            // Atualiza o registro R2 existente com type/wahaShortId do WAHA
            existMap[byTs.id] = {
              ...byTs,
              chatId:      byTs.chatId    || chatId,
              type:        mediaFields.type        || byTs.type,
              wahaShortId: mediaFields.wahaShortId || byTs.wahaShortId || null,
              mediaUrl:    mediaFields.mediaUrl    || byTs.mediaUrl    || null,
              mimetype:    mediaFields.mimetype    || byTs.mimetype    || null,
            };
          }
          // Sem match algum: não adiciona (evita duplicatas de sistema de IDs diferente)
        }
      }

      const merged = Object.values(existMap).sort((a, b) => (a.ts || 0) - (b.ts || 0));
      const MAX = 200;
      const trimmed = merged.length > MAX ? merged.slice(merged.length - MAX) : merged;
      await r2Put(chatKey(chatId), Buffer.from(JSON.stringify(trimmed), "utf8"), "application/json");
      return res.status(200).json({ ok: true, count: trimmed.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── PUT: upload permanente de binário de mídia ───────────────────
  // PUT /api/r2-data?type=media&msgId=xxx  (body = ArrayBuffer, Content-Type = mimetype)
  if (req.method === "PUT" && type === "media") {
    const { msgId } = req.query;
    if (!msgId) return res.status(400).json({ error: "msgId obrigatório" });
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length === 0) return res.status(400).json({ error: "body vazio" });
      const ct = req.headers["content-type"] || "application/octet-stream";
      await r2Put(mediaKey(msgId), buf, ct);
      return res.status(200).json({ ok: true, size: buf.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET ──────────────────────────────────────────────────────────
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    if (type === "chats") {
      const r = await r2Get("chats.json");
      if (!r) return res.status(200).json([]);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(JSON.parse(r.buf.toString("utf8")));
    }

    if (type === "msgs" && chatId) {
      const r = await r2Get(chatKey(chatId));
      if (!r) return res.status(200).json([]);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(JSON.parse(r.buf.toString("utf8")));
    }

    // Lista todos os arquivos msgs/ com lastModified + última mensagem de cada chat
    // Usado pelo cliente para montar o chatlist sem depender de chats.json
    if (type === "msgs-list") {
      const files = await r2List("msgs/");
      const chats = await Promise.all(
        files
          .filter(f => f.key.endsWith(".json"))
          .map(async (f) => {
            // msgs/556199611055_c_us.json → 556199611055@c.us
            const filename = f.key.replace("msgs/", "").replace(".json", "");
            const chatId   = filename
              .replace(/_c_us$/, "@c.us")
              .replace(/_g_us$/, "@g.us")
              .replace(/_lid$/, "@lid")
              .replace(/_/g, "");

            // Lê última mensagem do arquivo
            let lastMsg = "", lastTs = 0, pushname = "", unread = 0, lastPatientTs = null;
            try {
              const r = await r2Get(f.key);
              if (r) {
                const msgs = JSON.parse(r.buf.toString("utf8"));
                if (Array.isArray(msgs) && msgs.length > 0) {
                  const last = msgs[msgs.length - 1];
                  lastMsg  = last.body || last.text || "";
                  lastTs   = last.ts   || 0;
                  pushname = last.pushname || last.notifyName || "";
                  // unread: msgs do paciente após última resposta do operador
                  let u = 0;
                  for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].fromMe) break;
                    u++;
                  }
                  unread = u;
                  // lastPatientTs: última msg não-fromMe
                  for (let i = msgs.length - 1; i >= 0; i--) {
                    if (!msgs[i].fromMe) { lastPatientTs = msgs[i].ts || null; break; }
                  }
                }
              }
            } catch {}

            return {
              id:            chatId,
              lastMsg,
              lastTs:        lastTs || new Date(f.lastModified).getTime(),
              lastModified:  f.lastModified,
              pushname,
              unread,
              lastPatientTs,
              status:        "open",
            };
          })
      );

      // Ordena por lastTs decrescente (mais recente primeiro)
      chats.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(chats);
    }

    if (type === "media") {
      const { msgId } = req.query;
      if (!msgId) return res.status(400).json({ error: "msgId obrigatório" });
      const r = await r2Get(mediaKey(msgId));
      if (!r) return res.status(404).json({ error: "não encontrado" });
      res.setHeader("Content-Type", r.contentType || "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      return res.status(200).send(r.buf);
    }

    return res.status(400).json({ error: "type inválido" });
  } catch (e) {
    console.error("[r2-data]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
