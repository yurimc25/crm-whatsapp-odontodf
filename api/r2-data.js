// api/r2-data.js
// GET /api/r2-data?type=chats              → chats.json
// GET /api/r2-data?type=msgs&chatId=...    → msgs/{chatId}.json
// POST /api/r2-data?type=upload            → upload via JSON base64 (arquivos < 4MB)
// POST /api/r2-data?type=upload-binary     → upload via FormData (arquivos grandes)

import { r2Get, r2Put } from "./_r2.js";
import { formidable } from "formidable";
import fs from "fs";

export const config = { api: { bodyParser: false } };

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

      // Índice por ID para merge: incoming vence em type/wahaShortId/mediaUrl se tiver mídia
      const existMap = {};
      for (const m of existing) if (m.id) existMap[m.id] = m;

      for (const m of incoming) {
        if (!m.id) continue;
        const ex = existMap[m.id];
        if (!ex) {
          existMap[m.id] = m;
        } else {
          // Atualiza apenas campos de mídia — não sobrescreve texto/ts do existente
          existMap[m.id] = {
            ...ex,
            type:         m.type && m.type !== "chat" ? m.type : ex.type,
            wahaShortId:  m.wahaShortId || ex.wahaShortId || null,
            mediaUrl:     m.mediaUrl || ex.mediaUrl || null,
          };
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

    return res.status(400).json({ error: "type inválido" });
  } catch (e) {
    console.error("[r2-data]", e.message);
    return res.status(500).json({ error: e.message });
  }
}
