// api/r2-data.js
// GET /api/r2-data?type=chats              → chats.json
// GET /api/r2-data?type=msgs&chatId=...    → msgs/{chatId}.json
// GET /api/r2-data?type=msgs-list          → lista msgs/ com lastModified + última msg de cada chat
// POST /api/r2-data?type=upload            → upload via JSON base64 (arquivos < 4MB)
// POST /api/r2-data?type=upload-binary     → upload via FormData (arquivos grandes)

import { r2Get, r2Put, r2List, r2Delete } from "./_r2.js";
import { formidable } from "formidable";
import fs from "fs";

export const config = { api: { bodyParser: false } };

// Texto de preview para o chatlist — body/caption ou fallback descritivo por tipo de mídia
function msgPreview(msg) {
  if (msg.body || msg.text) return msg.body || msg.text;
  switch (msg.type) {
    case "image":    return "📷 Imagem";
    case "video":    return "🎥 Vídeo";
    case "audio":
    case "voice":    return "🎵 Áudio";
    case "document": return "📄 Documento";
    case "sticker":  return "⭐ Figurinha";
    case "location": return "📍 Localização";
    case "vcard":
    case "contact":  return "👤 Contato";
    default:         return "";
  }
}

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

const MAX_MSGS = 200;

// Lê JSON do R2 ou retorna default
async function r2Json(key, def) {
  try {
    const r = await r2Get(key);
    if (!r) return def;
    return JSON.parse(r.buf.toString("utf8"));
  } catch { return def; }
}

// Normaliza timestamp para ms (WAHA às vezes retorna segundos Unix)
function toMs(ts) {
  if (!ts) return 0;
  const n = typeof ts === "number" ? ts : new Date(ts).getTime();
  return n > 0 && n < 1e12 ? n * 1000 : n; // segundos → ms
}

// Chave de dedup por timestamp (segundo) + direção — cobre IDs em formatos diferentes
function tsDir(m) {
  return `${m.fromMe ? 1 : 0}_${Math.floor(toMs(m.ts) / 1000)}`;
}

// Merge genérico: copia mensagens de srcKey para dstKey e deleta srcKey
// Dedup por ID exato + ts+fromMe (mesmo segundo, mesma direção = mesmo evento)
async function mergeFiles(srcKey, dstKey, canonicalChatId) {
  const srcMsgs = await r2Json(srcKey, null);
  if (!Array.isArray(srcMsgs)) { await r2Delete(srcKey).catch(() => {}); return 0; }
  const dstMsgs = await r2Json(dstKey, []);
  const seenId  = new Set(dstMsgs.map(m => m.id));
  const seenTs  = new Set(dstMsgs.map(tsDir));
  for (const m of srcMsgs) {
    if (!m.id) continue;
    if (seenId.has(m.id)) continue;            // duplicata por ID
    const td = tsDir(m);
    if (seenTs.has(td)) continue;              // mesmo evento com ID diferente (cross-format)
    seenId.add(m.id);
    seenTs.add(td);
    dstMsgs.push({ ...m, chatId: canonicalChatId });
  }
  dstMsgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  if (dstMsgs.length > MAX_MSGS) dstMsgs.splice(0, dstMsgs.length - MAX_MSGS);
  await r2Put(dstKey, Buffer.from(JSON.stringify(dstMsgs), "utf8"), "application/json");
  await r2Delete(srcKey);
  return srcMsgs.length;
}

// Merge mensagens do arquivo @lid no arquivo @c.us e deleta @lid
async function mergeLidFiles(pairs) {
  for (const { lid, jid } of pairs) {
    try {
      const lidFileKey = "msgs/" + (lid + "@lid").replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
      const cusFileKey = chatKey(jid);
      const n = await mergeFiles(lidFileKey, cusFileKey, jid);
      console.log(`[merge-lids] ${lid}@lid → ${jid}: ${n} msgs merged, file deleted`);
    } catch (e) {
      console.warn(`[merge-lids] erro em ${lid}:`, e.message);
    }
  }
}

// Extrai chatId a partir do nome do arquivo R2 (inverte chatKey)
function chatIdFromKey(fileKey) {
  const m = fileKey.match(/^msgs\/(.+)\.json$/);
  if (!m) return null;
  // inverte replace: _ vira @ ou . (heurística: _c_us → @c.us, _g_us → @g.us, _lid → @lid)
  let id = m[1]
    .replace(/_c_us$/, "@c.us")
    .replace(/_g_us$/, "@g.us")
    .replace(/_lid$/, "@lid");
  return id;
}

// Detecta e mescla arquivos duplicados de @c.us para o mesmo número
// (ex: com/sem dígito 9 brasileiro) — mantém o canônico, deleta o outro
async function mergePhoneDuplicates(files) {
  // Agrupa por chave normalizada (só dígitos, com 9 para BR)
  const groups = new Map(); // normalizedKey → [{ fileKey, chatId }]
  for (const { key } of files) {
    if (!key.startsWith("msgs/") || !key.endsWith(".json")) continue;
    const chatId = chatIdFromKey(key);
    if (!chatId || chatId.endsWith("@lid") || chatId.endsWith("@g.us")) continue;
    const norm = toChatKey(chatId); // normaliza número
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push({ fileKey: key, chatId });
  }

  let merged = 0;
  for (const [norm, entries] of groups) {
    if (entries.length < 2) continue;
    // Canônico é o que já tem o chatId igual ao toCanonicalId
    const canonical = entries.find(e => e.chatId === toCanonicalId(e.chatId))
      || entries.reduce((a, b) => a.chatId.length >= b.chatId.length ? a : b); // maior comprimento = mais dígitos
    const others = entries.filter(e => e.fileKey !== canonical.fileKey);
    for (const src of others) {
      try {
        const n = await mergeFiles(src.fileKey, canonical.fileKey, canonical.chatId);
        console.log(`[merge-dupes] ${src.chatId} → ${canonical.chatId}: ${n} msgs merged, ${src.fileKey} deleted`);
        merged++;
      } catch (e) {
        console.warn(`[merge-dupes] erro em ${src.chatId}:`, e.message);
      }
    }
  }
  return merged;
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

  // ── GET: lê lid_map.json ──────────────────────────────────────────────────
  if (req.method === "GET" && type === "lid-map") {
    const r = await r2Get("lid_map.json");
    const map = r ? JSON.parse(r.buf.toString("utf8")) : {};
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(map);
  }

  // ── POST: cliente envia mapeamentos LID→JID conhecidos ───────────────────
  // Após salvar, dispara merge @lid → @c.us para novos mapeamentos resolvidos
  if (req.method === "POST" && type === "lid-map") {
    let incoming;
    try {
      const raw = await new Promise((resolve, reject) => {
        let d = ""; req.on("data", c => d += c); req.on("end", () => resolve(d)); req.on("error", reject);
      });
      incoming = JSON.parse(raw);
    } catch { return res.status(400).json({ error: "JSON inválido" }); }
    if (typeof incoming !== "object" || Array.isArray(incoming)) {
      return res.status(400).json({ error: "Esperado objeto { lid: jid }" });
    }
    const existing = await r2Get("lid_map.json").then(r =>
      r ? JSON.parse(r.buf.toString("utf8")) : {}
    ).catch(() => ({}));
    const newlyResolved = [];
    for (const [lid, jid] of Object.entries(incoming)) {
      if (jid && (!existing[lid] || existing[lid] === null)) {
        existing[lid] = jid;
        newlyResolved.push({ lid, jid });
      }
    }
    await r2Put("lid_map.json", Buffer.from(JSON.stringify(existing), "utf8"), "application/json");
    // Merge @lid files into @c.us in background para novos mapeamentos
    if (newlyResolved.length > 0) {
      mergeLidFiles(newlyResolved).catch(() => {});
    }
    return res.status(200).json({ ok: true, merged: newlyResolved.length });
  }

  // ── POST: limpa arquivos @lid já resolvidos no R2 (chamado pelo Resync) ────
  if (req.method === "POST" && type === "merge-lids") {
    try {
      const [files, lidMap] = await Promise.all([
        r2List("msgs/"),
        r2Get("lid_map.json").then(r => r ? JSON.parse(r.buf.toString("utf8")) : {}).catch(() => ({})),
      ]);
      // 1) Merge @lid → @c.us para mapeamentos resolvidos
      const toMerge = [];
      for (const [lid, jid] of Object.entries(lidMap)) {
        if (!jid) continue;
        const lidFileKey = "msgs/" + (lid + "@lid").replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
        if (files.some(f => f.key === lidFileKey)) toMerge.push({ lid, jid });
      }
      await mergeLidFiles(toMerge);
      // 2) Merge arquivos @c.us duplicados para o mesmo número (ex: com/sem dígito 9)
      const dupsMerged = await mergePhoneDuplicates(files);
      return res.status(200).json({ ok: true, merged: toMerge.length, dupesMerged: dupsMerged });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

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

  // ── POST: insere mensagem enviada pelo operador no R2 ──────────────
  // Garante que o polling (applyR2Chats) já leia o lastMsg correto sem depender do webhook
  if (req.method === "POST" && type === "send-msg") {
    if (!chatId) return res.status(400).json({ error: "chatId obrigatório" });
    let msg;
    try {
      const raw = await new Promise((resolve, reject) => {
        let d = ""; req.on("data", c => d += c); req.on("end", () => resolve(d)); req.on("error", reject);
      });
      msg = JSON.parse(raw);
    } catch { return res.status(400).json({ error: "JSON inválido" }); }
    if (!msg || typeof msg !== "object" || !msg.id) {
      return res.status(400).json({ error: "msg inválida" });
    }
    try {
      const existing = await r2Json(chatKey(chatId), []);
      // Dedup por ID e por timestamp+fromMe (evita duplicar se webhook já chegou)
      const seen = new Set(existing.map(m => m.id));
      const tsKey = `${msg.fromMe ? 1 : 0}_${Math.floor((msg.ts || 0) / 1000)}`;
      const dupByTs = existing.some(m =>
        `${m.fromMe ? 1 : 0}_${Math.floor((m.ts || 0) / 1000)}` === tsKey
      );
      if (!seen.has(msg.id) && !dupByTs) {
        existing.push({ ...msg, chatId });
        existing.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        if (existing.length > MAX_MSGS) existing.splice(0, existing.length - MAX_MSGS);
        await r2Put(chatKey(chatId), Buffer.from(JSON.stringify(existing), "utf8"), "application/json");
      }
      return res.status(200).json({ ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
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

      // Índice por ts+fromMe normalizado (ms) — cobre IDs em formatos diferentes
      const existByTs = new Map();
      for (const m of existing) {
        const k = tsDir(m);
        if (!existByTs.has(k)) existByTs.set(k, m);
      }

      for (const m of incoming) {
        if (!m.id) continue;
        const mediaFields = {
          type:        m.type && m.type !== "chat" && m.type !== "text" ? m.type : undefined,
          wahaShortId: m.wahaShortId || undefined,
          mediaUrl:    m.mediaUrl || undefined,
          mimetype:    m.mimetype || undefined,
          body:        m.body || undefined,
        };

        const ex = existMap[m.id];
        if (ex) {
          // ID exato — atualiza campos de mídia preservando o registro canônico
          existMap[m.id] = {
            ...ex,
            chatId:      ex.chatId || chatId,
            type:        mediaFields.type        || ex.type,
            wahaShortId: mediaFields.wahaShortId || ex.wahaShortId || null,
            mediaUrl:    mediaFields.mediaUrl    || ex.mediaUrl    || null,
            mimetype:    mediaFields.mimetype    || ex.mimetype    || null,
          };
        } else {
          const td  = tsDir(m);
          const byTs = existByTs.get(td);
          if (byTs) {
            // Mesmo evento com ID diferente — atualiza mídia no registro canônico
            existMap[byTs.id] = {
              ...byTs,
              chatId:      byTs.chatId || chatId,
              type:        mediaFields.type        || byTs.type,
              wahaShortId: mediaFields.wahaShortId || byTs.wahaShortId || null,
              mediaUrl:    mediaFields.mediaUrl    || byTs.mediaUrl    || null,
              mimetype:    mediaFields.mimetype    || byTs.mimetype    || null,
            };
          } else if (m.isGap) {
            // Mensagem que não chegou via webhook (gap detectado pelo cliente) — insere
            existMap[m.id] = {
              id:     m.id,
              chatId,
              ts:     toMs(m.ts),
              fromMe: !!m.fromMe,
              body:   m.body || m.text || "",
              type:   m.type || "text",
              pushname: m.pushname || "",
              ...(m.mimetype ? { mimetype: m.mimetype } : {}),
            };
            existByTs.set(td, existMap[m.id]);
          }
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
    // Usa lid_map.json para dedup server-side: @lid canônico absorve @c.us duplicado
    if (type === "msgs-list") {
      const [files, lidMap] = await Promise.all([
        r2List("msgs/"),
        r2Get("lid_map.json").then(r => r ? JSON.parse(r.buf.toString("utf8")) : {}).catch(() => ({})),
      ]);

      // Converte filename → chatId
      function filenameToChatId(key) {
        const filename = key.replace("msgs/", "").replace(".json", "");
        return filename
          .replace(/_c_us$/, "@c.us")
          .replace(/_g_us$/, "@g.us")
          .replace(/_lid$/, "@lid");
      }

      // lidMap = { "267769870340186": "556198431643@c.us" }
      // lidResolved: Set de arquivos @c.us que já têm um @lid correspondente
      // (serão absorvidos pelo @lid no readFile — o @lid retorna com id=@c.us)
      const lidResolved = new Set();
      for (const [lidKey, jid] of Object.entries(lidMap)) {
        if (!jid) continue;
        const cusFile = chatKey(jid); // "msgs/556198431643_c_us.json"
        if (files.some(f => f.key === cusFile)) lidResolved.add(cusFile);
      }

      // Lê conteúdo de cada arquivo, pulando @c.us que já estão cobertos por um @lid resolvido
      const readFile = async (f) => {
        const chatId = filenameToChatId(f.key);
        let msgs = [];
        try {
          const r = await r2Get(f.key);
          if (r) msgs = JSON.parse(r.buf.toString("utf8"));
          if (!Array.isArray(msgs)) msgs = [];
        } catch {}

        // @lid com JID resolvido → mescla msgs do @c.us e usa @c.us como ID canônico
        let canonicalId = chatId;
        if (chatId.endsWith("@lid")) {
          const lidKey = chatId.replace(/@lid$/, "");
          const jid    = lidMap[lidKey];
          if (jid) {
            canonicalId = jid; // retorna com ID @c.us
            try {
              const cr = await r2Get(chatKey(jid));
              if (cr) {
                const cusMsgs = JSON.parse(cr.buf.toString("utf8"));
                if (Array.isArray(cusMsgs) && cusMsgs.length > 0) {
                  const seen = new Set(msgs.map(m => m.id));
                  for (const m of cusMsgs) if (m.id && !seen.has(m.id)) msgs.push(m);
                  msgs.sort((a, b) => (a.ts || 0) - (b.ts || 0));
                }
              }
            } catch {}
          }
        }

        let lastMsg = "", lastTs = 0, pushname = "", unread = 0, lastPatientTs = null;
        let lastMsgFromMe = false;
        if (msgs.length > 0) {
          const last = msgs[msgs.length - 1];
          lastMsg       = msgPreview(last);
          lastTs        = last.ts   || 0;
          lastMsgFromMe = !!last.fromMe;
          pushname      = last.pushname || last.notifyName || "";
          // unread = mensagens do paciente sem resposta do operador (da última msg do op em diante)
          let u = 0;
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].fromMe) break;
            u++;
          }
          unread = u;
          // lastPatientTs = ts da última msg do paciente APÓS a última msg do operador
          // null se o operador respondeu por último (fromMe=true no final)
          for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].fromMe) { lastPatientTs = null; break; } // operador respondeu depois
            if (!msgs[i].fromMe) lastPatientTs = msgs[i].ts || null;
          }
        }

        // Texto limpo da última msg (sem prefixo "Operador: ") para checagem de autoresolve
        const lastMsgClean = lastMsg.includes(": ") ? lastMsg.replace(/^[^:]+:\s*/, "") : lastMsg;
        // Autoresolve: operador enviou "Consulta confirmada" ou paciente enviou despedida
        const isOperatorClosing = lastMsgFromMe && /^Consulta confirmada[!.]?/i.test(lastMsgClean);
        const isFarewell = !lastMsgFromMe && /^(ok|obg|obrigad|valeu|tchau|flw|até|ata |bjss?|bjo|boa noite|boa tarde|bom dia|perfeito|certo|entendido|anotado|combinado)/i.test(lastMsgClean.trim());

        return {
          id:           canonicalId,
          lastMsg,
          lastMsgFromMe,
          lastTs:       lastTs || new Date(f.lastModified).getTime(),
          lastModified: f.lastModified,
          pushname,
          unread,
          lastPatientTs,
          autoResolved: isOperatorClosing || isFarewell,
          status:       "open",
        };
      };

      const chats = await Promise.all(
        files
          .filter(f => f.key.endsWith(".json") && !lidResolved.has(f.key))
          .map(readFile)
      );

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
