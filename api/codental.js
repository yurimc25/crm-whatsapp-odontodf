// api/codental.js
// Vercel Serverless Function — proxy para a API do Codental
// Lê a sessão do MongoDB (renovada pelo GitHub Actions a cada 30min)
//
// GET /api/codental?action=search&q=nome_ou_telefone
// GET /api/codental?action=patient&id=123
// GET /api/codental?action=uploads&id=123

import { MongoClient } from "mongodb";

let client;
async function getDb() {
  if (!client) {
    client = new MongoClient(process.env.MONGODB_URI);
    await client.connect();
  }
  return client.db("clinica");
}

const APP_BASE = process.env.CODENTAL_BASE_URL || "https://app.codental.com.br";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function getSession(db) {
  const doc = await db.collection("settings").findOne({ _id: "codental_session" });
  if (!doc?.cookie || !doc?.csrf) throw new Error("Sem sessão Codental no banco — GitHub Actions não rodou?");
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
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { action, q, id } = req.query;

  try {
    const db = await getDb();
    const session = await getSession(db);
    const hdrs = authHeaders(session);

    // ── Busca paciente por nome ou telefone ──────────────────────────────────
    if (action === "search") {
      if (!q) return res.status(400).json({ error: "Parâmetro q obrigatório" });

      const r = await fetch(
        `${APP_BASE}/patients/search.json?query=${encodeURIComponent(q)}`,
        { headers: hdrs }
      );

      if (!r.ok) {
        console.error(`[codental search] ${r.status} para query "${q}"`);
        return res.status(r.status).json({ error: `Codental retornou ${r.status}` });
      }

      const data = await r.json();
      const list = Array.isArray(data) ? data : (data.patients || data.data || []);
      return res.json({ patients: list, total: list.length });
    }

    // ── Dados completos de um paciente ───────────────────────────────────────
    if (action === "patient") {
      if (!id) return res.status(400).json({ error: "Parâmetro id obrigatório" });

      const r = await fetch(`${APP_BASE}/patients/${id}.json`, { headers: hdrs });

      if (!r.ok) {
        console.error(`[codental patient] ${r.status} para id ${id}`);
        return res.status(r.status).json({ error: `Codental retornou ${r.status}` });
      }

      return res.json(await r.json());
    }

    // ── Uploads e exames do paciente ─────────────────────────────────────────
    if (action === "uploads") {
      if (!id) return res.status(400).json({ error: "Parâmetro id obrigatório" });

      const r = await fetch(`${APP_BASE}/patients/${id}/uploads.json`, { headers: hdrs });

      if (!r.ok) {
        console.error(`[codental uploads] ${r.status} para id ${id}`);
        return res.status(r.status).json({ error: `Codental retornou ${r.status}` });
      }

      const data = await r.json();
      const uploads = Array.isArray(data) ? data : (data.uploads || data.data || []);
      return res.json({ uploads, total: uploads.length });
    }

    // ── Evoluções do paciente ────────────────────────────────────────────────
    if (action === "evolutions") {
      if (!id) return res.status(400).json({ error: "Parâmetro id obrigatório" });

      // Tenta JSON primeiro
      const rJson = await fetch(`${APP_BASE}/patients/${id}/evolutions.json`, { headers: hdrs });
      if (rJson.ok) {
        const ct = rJson.headers.get("content-type") || "";
        if (ct.includes("application/json")) {
          const data = await rJson.json();
          const evols = Array.isArray(data) ? data : (data.evolutions || data.data || []);
          return res.json({ evolutions: evols, total: evols.length });
        }
      }

      // Codental retorna HTML — faz parse manual dos <tr id="evolution_XXX">
      const rHtml = await fetch(`${APP_BASE}/patients/${id}/evolutions`, { headers: hdrs });
      if (!rHtml.ok) {
        console.error(`[codental evolutions] ${rHtml.status} para id ${id}`);
        return res.status(rHtml.status).json({ error: `Codental retornou ${rHtml.status}` });
      }

      const html = await rHtml.text();

      // Extrai cada <tr id="evolution_XXXXX">
      const evolutions = [];
      const trRegex = /<tr[^>]+id="evolution_(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
      let m;
      while ((m = trRegex.exec(html)) !== null) {
        const evolId = m[1];
        const inner  = m[2];

        // Texto da evolução (div principal)
        const textMatch = inner.match(/<div[^>]*tw-text-ugray-900[^>]*><div>([\s\S]*?)<\/div><\/div>/);
        const texto = textMatch ? textMatch[1].replace(/<[^>]+>/g, "").trim() : "";

        // Data/hora e dentista
        const dentistBlock = inner.match(/<div[^>]*evolution-dentist[^>]*>([\s\S]*?)<\/div>/);
        const dentistRaw   = dentistBlock ? dentistBlock[1].replace(/<[^>]+>/g, " ").trim() : "";
        // Separa data, hora e nome do dentista
        const dateMatch    = dentistRaw.match(/(\d{2}\/\d{2}\/\d{4})/);
        const timeMatch    = dentistRaw.match(/(\d{2}:\d{2}:\d{2})/);
        const dentistName  = dentistRaw
          .replace(/\d{2}\/\d{2}\/\d{4}/, "")
          .replace(/\d{2}:\d{2}:\d{2}/, "")
          .replace(/Assinado/gi, "")
          .replace(/\s+/g, " ")
          .trim();

        // Assinado?
        const assinado = /Assinado/i.test(inner);

        evolutions.push({
          id:       evolId,
          texto,
          data:     dateMatch ? dateMatch[1] : "",
          hora:     timeMatch ? timeMatch[1] : "",
          dentista: dentistName,
          assinado,
        });
      }

      return res.json({ evolutions, total: evolutions.length });
    }

    return res.status(400).json({ error: `Ação desconhecida: ${action}` });

  } catch (e) {
    console.error("[codental]", e.message);
    return res.status(500).json({ error: e.message });
  }
}