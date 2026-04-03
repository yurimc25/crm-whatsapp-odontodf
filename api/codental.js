// api/codental.js
// Usa a lógica de busca já existente em lib/patientSearch.js

import { MongoClient } from "mongodb";
import { searchPatientsWithFallback, getCacheStatus } from "../lib/patientSearch.js";

let client;
async function getDb() {
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
  }
  return _client.db(process.env.MONGODB_DB || "codental_monitor");
}

const APP_BASE = "https://app.codental.com.br";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

async function getSession(db) {
  const doc = await db.collection("settings").findOne({ _id: "codental_session" });
  if (!doc?.cookie || !doc?.csrf) throw new Error("Sem sessão Codental no banco");
  return { cookie: doc.cookie, csrf: doc.csrf };
}

function authHeaders(session) {
  return {
    "Accept": "application/json",
    "Cookie": session.cookie,
    "X-CSRF-Token": session.csrf,
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": UA,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) return res.status(401).json({ error: "Unauthorized" });

  const { action, q, id, phone } = req.query;

  try {
    const db = await getDb();

    // ── Busca fuzzy: nome ou telefone ──────────────────────────────────────
    // Usa patientSearch.js: base local (patients_cache) → API Codental com fallback
    if (action === "search") {
      if (!q && !phone) return res.status(400).json({ error: "q ou phone obrigatório" });

      // Se vier telefone, busca direto na API por telefone
      if (phone) {
        const session = await getSession(db);
        const digits = phone.replace(/\D/g, "");
        // Tenta variações: com e sem DDI 55
        const queries = [digits, digits.startsWith("55") ? digits.slice(2) : "55" + digits];
        let found = [];
        for (const tq of queries) {
          const r = await fetch(
            `${APP_BASE}/patients/search.json?query=${encodeURIComponent(tq)}`,
            { headers: authHeaders(session) }
          );
          if (!r.ok) continue;
          const data = await r.json();
          const list = Array.isArray(data) ? data : (data.patients || data.data || []);
          if (list.length > 0) { found = list; break; }
        }
        return res.json({ patients: found, source: "phone" });
      }

      // Busca por nome com fuzzy (local + API)
      const result = await searchPatientsWithFallback(q);
      return res.json(result);
    }

    // ── Dados completos de um paciente ─────────────────────────────────────
    if (action === "patient") {
      if (!id) return res.status(400).json({ error: "id obrigatório" });
      const session = await getSession(db);
      const r = await fetch(`${APP_BASE}/patients/${id}.json`, { headers: authHeaders(session) });
      if (!r.ok) return res.status(r.status).json({ error: `Codental: ${r.status}` });
      return res.json(await r.json());
    }

    // ── Uploads/exames do paciente ─────────────────────────────────────────
    if (action === "uploads") {
      if (!id) return res.status(400).json({ error: "id obrigatório" });
      const session = await getSession(db);
      const r = await fetch(`${APP_BASE}/patients/${id}/uploads.json`, { headers: authHeaders(session) });
      if (!r.ok) return res.status(r.status).json({ error: `Codental: ${r.status}` });
      const data = await r.json();
      return res.json({ uploads: Array.isArray(data) ? data : (data.uploads || []) });
    }

    // ── Status do cache local ──────────────────────────────────────────────
    if (action === "cache_status") {
      const status = await getCacheStatus();
      return res.json(status);
    }

    // ── Evoluções do paciente ──────────────────────────────────────────────
    if (action === "evolutions") {
    if (!id) return res.status(400).json({ error: "id obrigatório" });
    const r = await codentalFetch(`/patients/${id}/evolutions.json`, session);
    if (!r.ok) return res.status(r.status).json({ error: `Codental: ${r.status}` });
    const data = await r.json();
    const list = Array.isArray(data) ? data : (data.evolutions || data.data || []);
    return res.json({ evolutions: list });
    }

    // ── URL de preview de upload (proxy para evitar CORS) ──────────────────
    if (action === "upload_url") {
    if (!id) return res.status(400).json({ error: "id obrigatório" });
    // Busca a URL do arquivo específico com autenticação
    const { upload_id } = req.query;
    if (!upload_id) return res.status(400).json({ error: "upload_id obrigatório" });
    const r = await codentalFetch(`/patients/${id}/uploads/${upload_id}.json`, session);
    if (!r.ok) return res.status(r.status).json({ error: `Codental: ${r.status}` });
    return res.json(await r.json());
    }

    return res.status(400).json({ error: `Ação desconhecida: ${action}` });

  } catch (e) {
    console.error("[codental]", e.message);
    return res.status(500).json({ error: e.message });
  }
}