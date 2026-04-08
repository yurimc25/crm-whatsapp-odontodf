// api/backup.js — Backup de conversas para o Google Drive
// Usa a conta de serviço Google (GOOGLE_SERVICE_ACCOUNT_JSON) para fazer upload.
// POST /api/backup?action=drive — gera JSON das conversas e faz upload no Drive
// GET  /api/backup?action=status — retorna info do último backup

import { google } from "googleapis";
import { MongoClient } from "mongodb";

const MONGO_URI   = process.env.MONGODB_URI || "";
const FOLDER_ID   = process.env.GOOGLE_DRIVE_BACKUP_FOLDER_ID || ""; // pasta no Drive

async function getGoogleAuth() {
  const creds = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!creds) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON não configurado");
  const key = JSON.parse(creds);
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/drive.file"],
  });
  return auth;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) return res.status(401).json({ error: "Unauthorized" });

  const { action } = req.query;

  if (action === "drive" && req.method === "POST") {
    try {
      // Lê conversas do MongoDB
      const client = new MongoClient(MONGO_URI);
      await client.connect();
      const db = client.db();
      const chats = await db.collection("chats").find({}).toArray();
      await client.close();

      const now = new Date().toISOString().slice(0, 10);
      const filename = `crm_backup_${now}.json`;
      const content  = JSON.stringify({ exportedAt: new Date().toISOString(), chats }, null, 2);

      const auth  = await getGoogleAuth();
      const drive = google.drive({ version: "v3", auth });

      const { Readable } = await import("stream");
      const stream = Readable.from([content]);

      const file = await drive.files.create({
        requestBody: {
          name: filename,
          mimeType: "application/json",
          parents: FOLDER_ID ? [FOLDER_ID] : [],
        },
        media: { mimeType: "application/json", body: stream },
        fields: "id, name, webViewLink",
      });

      return res.status(200).json({
        ok: true,
        fileId:   file.data.id,
        filename: file.data.name,
        url:      file.data.webViewLink,
        chats:    chats.length,
      });
    } catch (e) {
      console.error("[backup]", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  if (action === "status" && req.method === "GET") {
    try {
      const auth  = await getGoogleAuth();
      const drive = google.drive({ version: "v3", auth });
      const q = FOLDER_ID
        ? `'${FOLDER_ID}' in parents and name contains 'crm_backup_' and trashed=false`
        : `name contains 'crm_backup_' and trashed=false`;
      const list = await drive.files.list({
        q,
        orderBy: "createdTime desc",
        pageSize: 5,
        fields: "files(id,name,createdTime,webViewLink,size)",
      });
      return res.status(200).json({ ok: true, files: list.data.files });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: "action inválida" });
}
