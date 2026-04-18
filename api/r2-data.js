// api/r2-data.js
// GET /api/r2-data?type=chats              → chats.json
// GET /api/r2-data?type=msgs&chatId=...    → msgs/{chatId}.json
// GET /api/r2-data?type=migrate-list       → lista chatIds do WAHA para migração
// POST /api/r2-data?type=upload            → upload via JSON base64 (arquivos < 4MB)
// POST /api/r2-data?type=upload-binary     → upload via FormData (arquivos grandes)
// POST /api/r2-data?type=migrate-batch     → migra batch { chatIds: [...] } do WAHA → R2

import { r2Get, r2Put } from "./_r2.js";
import { formidable } from "formidable";
import fs from "fs";

function chatKey(chatId) {
  return "msgs/" + chatId.replace(/[^a-zA-Z0-9_-]/g, "_") + ".json";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { type, chatId } = req.query;

  // ── POST: salva array de mensagens para um chat (migração do frontend) ──
  if (req.method === "POST" && type === "msgs-save" && chatId) {
    let body;
    try {
      if (req.body && typeof req.body === "object") {
        body = req.body;
      } else {
        const raw = await new Promise((resolve, reject) => {
          let data = "";
          req.on("data", chunk => data += chunk);
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        body = JSON.parse(raw);
      }
    } catch { return res.status(400).json({ error: "JSON inválido" }); }

    if (!Array.isArray(body)) return res.status(400).json({ error: "Esperado array de mensagens" });
    try {
      await r2Put(chatKey(chatId), Buffer.from(JSON.stringify(body), "utf8"), "application/json");
      return res.status(200).json({ ok: true, count: body.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── POST: sync de chats (lista enriquecida para multi-usuário) ──
  if (req.method === "POST" && type === "chats") {
    let body;
    try {
      if (req.body && typeof req.body === "object") {
        body = req.body;
      } else {
        const raw = await new Promise((resolve, reject) => {
          let data = "";
          req.on("data", chunk => data += chunk);
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        body = JSON.parse(raw);
      }
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

      // Indexa existentes por id
      const existMap = {};
      for (const c of existing) if (c.id) existMap[c.id] = c;

      // Merge: local vence se mais recente
      for (const c of body) {
        if (!c.id) continue;
        const ex = existMap[c.id];
        const localTs  = c.lastTs  || 0;
        const remoteTs = ex?.lastTs || 0;
        if (!ex || localTs >= remoteTs) {
          existMap[c.id] = c;
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
      if (req.body && typeof req.body === "object") {
        body = req.body;
      } else {
        const raw = await new Promise((resolve, reject) => {
          let data = "";
          req.on("data", chunk => data += chunk);
          req.on("end", () => resolve(data));
          req.on("error", reject);
        });
        body = JSON.parse(raw);
      }
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

  // ── POST: migrate-batch ─────────────────────────────────────────
  if (req.method === "POST" && type === "migrate-batch") {
    const wahaUrl = process.env.WAHA_URL;
    const wahaKey = process.env.WAHA_API_KEY;
    const session = process.env.WAHA_SESSION || "default";
    if (!wahaUrl) return res.status(500).json({ error: "WAHA_URL não configurado" });
    const wahaHeaders = { "Content-Type": "application/json", ...(wahaKey ? { "X-Api-Key": wahaKey } : {}) };

    let body;
    try {
      if (req.body && typeof req.body === "object") {
        body = req.body;
      } else {
        const raw = await new Promise((resolve, reject) => {
          let d = ""; req.on("data", c => d += c); req.on("end", () => resolve(d)); req.on("error", reject);
        });
        body = JSON.parse(raw);
      }
    } catch { return res.status(400).json({ error: "JSON inválido" }); }

    const MAX_MSGS = 200;
    const BATCH_SIZE = 10;
    const chatIds = Array.isArray(body?.chatIds) ? body.chatIds.slice(0, BATCH_SIZE) : [];
    if (!chatIds.length) return res.status(200).json({ ok: true, processed: 0, saved: 0 });

    const r2Json = async (k, def) => { try { const r = await r2Get(k); return r ? JSON.parse(r.buf.toString("utf8")) : def; } catch { return def; } };
    const r2WriteJson = async (k, data) => r2Put(k, Buffer.from(JSON.stringify(data), "utf8"), "application/json");

    try {
      let processed = 0, saved = 0;
      const errors = [];
      const chatsIndex = await r2Json("chats.json", []);
      const chatsMap = {};
      for (const c of chatsIndex) if (c.id) chatsMap[c.id] = c;
      let chatsChanged = false;

      for (const cid of chatIds) {
        try {
          const r = await fetch(`${wahaUrl}/api/${session}/chats/${encodeURIComponent(cid)}/messages?limit=200&downloadMedia=false`,
            { headers: wahaHeaders, signal: AbortSignal.timeout(8000) });
          if (!r.ok) { errors.push(`${cid}:waha${r.status}`); processed++; continue; }
          const raw = await r.json();
          if (!Array.isArray(raw) || !raw.length) { processed++; continue; }

          const msgs = raw.map(m => {
            const tsRaw = m.timestamp || m._data?.t || 0;
            const tsMs  = tsRaw ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : 0;
            const id    = m.id?._serialized || (typeof m.id === "string" ? m.id : null) || `msg-${tsMs}`;
            return { id, chatId: cid, ts: tsMs, fromMe: m.fromMe ?? m._data?.fromMe ?? false,
              body: m.body || m._data?.body || m.caption || m._data?.caption || "",
              type: m.type || m._data?.type || "chat",
              pushname: m.notifyName || m._data?.notifyName || "" };
          }).filter(m => m.id && m.ts > 0);
          if (!msgs.length) { processed++; continue; }
          msgs.sort((a, b) => a.ts - b.ts);

          const rKey = chatKey(cid);
          const exist = await r2Json(rKey, []);
          const existIds = new Set(exist.map(m => m.id));
          const novas = msgs.filter(m => !existIds.has(m.id));
          if (novas.length > 0) {
            const merged = [...exist, ...novas].sort((a, b) => (a.ts||0) - (b.ts||0));
            if (merged.length > MAX_MSGS) merged.splice(0, merged.length - MAX_MSGS);
            await r2WriteJson(rKey, merged);
            saved += novas.length;
          }

          const lastMsg = msgs[msgs.length - 1];
          const entry = { id: cid, lastMsg: lastMsg.body || "", lastTs: lastMsg.ts, fromMe: lastMsg.fromMe,
            pushname: lastMsg.pushname || chatsMap[cid]?.pushname || "",
            lastPatientTs: chatsMap[cid]?.lastPatientTs ?? null, unread: chatsMap[cid]?.unread ?? 0 };
          if (chatsMap[cid]) {
            if (!chatsMap[cid].lastTs || lastMsg.ts > chatsMap[cid].lastTs) { chatsMap[cid] = { ...chatsMap[cid], ...entry }; chatsChanged = true; }
          } else { chatsMap[cid] = entry; chatsChanged = true; }
          processed++;
        } catch (e) { errors.push(`${cid}:${e.message}`); processed++; }
      }

      if (chatsChanged) {
        const updated = Object.values(chatsMap);
        if (updated.length > 1000) updated.splice(1000);
        await r2WriteJson("chats.json", updated);
      }
      return res.status(200).json({ ok: true, processed, saved, errors });
    } catch (e) {
      return res.status(500).json({ error: e.message, stack: e.stack?.split("\n")[0] });
    }
  }

  // ── GET ──────────────────────────────────────────────────────────
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // GET migrate-list
  if (type === "migrate-list") {
    const wahaUrl = process.env.WAHA_URL;
    const wahaKey = process.env.WAHA_API_KEY;
    const session = process.env.WAHA_SESSION || "default";
    if (!wahaUrl) return res.status(500).json({ error: "WAHA_URL não configurado" });
    try {
      const r = await fetch(`${wahaUrl}/api/${session}/chats?limit=500`, {
        headers: { "Content-Type": "application/json", ...(wahaKey ? { "X-Api-Key": wahaKey } : {}) },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return res.status(r.status).json({ error: `WAHA ${r.status}` });
      const chats = await r.json();
      if (!Array.isArray(chats)) return res.status(200).json({ chatIds: [], total: 0 });
      const chatIds = chats
        .map(c => (c.id || "").replace(/:\d+(@\S+)?$/, ""))
        .filter(id => id && !id.endsWith("@s.whatsapp.net") && !id.endsWith("@lid"));
      return res.status(200).json({ chatIds, total: chatIds.length });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

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

    return res.status(400).json({ error: "type inválido" });
  } catch (e) {
    console.error("[r2-data]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
