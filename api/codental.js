// api/codental.js
// Vercel Serverless Function — proxy para Codental
// Autenticação via sessão salva no MongoDB (renovada pelo GitHub Actions)
// GET /api/codental?action=search&q=nome_ou_telefone
// GET /api/codental?action=patient&id=123
// GET /api/codental?action=uploads&id=123

import { MongoClient } from "mongodb";

const APP_BASE = "https://app.codental.com.br";
const LOGIN_URL = `${APP_BASE}/login`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// ── MongoDB ──────────────────────────────────────────────────────────────────
let _client;
async function getDb() {
  if (!_client) {
    _client = new MongoClient(process.env.MONGODB_URI);
    await _client.connect();
  }
  return _client.db("clinica");
}

// ── Sessão — lê do MongoDB (GitHub Actions renova a cada 30min) ───────────────
async function getSession() {
  const db = await getDb();
  const doc = await db.collection("settings").findOne({ _id: "codental_session" });
  if (doc?.cookie && doc?.csrf) return { cookie: doc.cookie, csrf: doc.csrf };

  // Fallback: faz login direto se não tiver sessão no banco
  return await authenticate();
}

// ── Autenticação direta (fallback) ────────────────────────────────────────────
function mergeCookies(...cookieStrings) {
  const map = new Map();
  for (const str of cookieStrings) {
    if (!str) continue;
    for (const part of str.split("; ")) {
      const eq = part.indexOf("=");
      if (eq > 0) map.set(part.slice(0, eq).trim(), part);
    }
  }
  return [...map.values()].join("; ");
}

function getCookies(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  }
  return (headers.get("set-cookie") || "").split(";")[0];
}

async function authenticate() {
  // 1. Página de login → CSRF
  const loginPageRes = await fetch(LOGIN_URL, {
    headers: { "User-Agent": UA, "Accept": "text/html", "Accept-Language": "pt-BR,pt;q=0.9" },
  });
  const html = await loginPageRes.text();
  const csrfMatch = html.match(/name="authenticity_token"[^>]+value="([^"]+)"/i)
    || html.match(/value="([^"]+)"[^>]+name="authenticity_token"/i);
  if (!csrfMatch) throw new Error("CSRF não encontrado na página de login do Codental");
  const csrf = csrfMatch[1];
  let cookies = getCookies(loginPageRes.headers);

  // 2. POST login
  const loginRes = await fetch(LOGIN_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookies, "User-Agent": UA,
      "Referer": LOGIN_URL, "Origin": APP_BASE,
    },
    body: new URLSearchParams({
      "authenticity_token": csrf,
      "professional[email]": process.env.CODENTAL_EMAIL,
      "professional[password]": process.env.CODENTAL_PASSWORD,
      "professional[remember_me]": "1",
      "commit": "Entrar",
    }).toString(),
  });

  const loginCookies = getCookies(loginRes.headers);
  const location = loginRes.headers.get("location") || "";
  if (loginRes.status === 200) throw new Error("Login Codental falhou — credenciais incorretas");
  if (loginRes.status === 302 && location.includes("/login")) throw new Error("Login Codental recusado");

  cookies = mergeCookies(cookies, loginCookies, "logged_in=1", "selected_establishment=13226");
  return { cookie: cookies, csrf };
}

// ── Headers autenticados ──────────────────────────────────────────────────────
async function authHeaders() {
  const s = await getSession();
  return {
    "Accept": "application/json",
    "Cookie": s.cookie,
    "X-CSRF-Token": s.csrf,
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": UA,
  };
}

// ── Handler principal ─────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) return res.status(401).json({ error: "Unauthorized" });

  const { action, q, id } = req.query;

  try {
    const hdrs = await authHeaders();

    // ── Busca paciente por nome ou telefone ──────────────────────────────────
    if (action === "search") {
      if (!q) return res.status(400).json({ error: "q obrigatório" });

      // Tenta endpoint de busca; fallback para listagem filtrada
      const urls = [
        `${APP_BASE}/patients/search.json?query=${encodeURIComponent(q)}`,
        `${APP_BASE}/patients.json?search=${encodeURIComponent(q)}&per_page=20`,
      ];

      for (const url of urls) {
        const r = await fetch(url, { headers: hdrs });
        if (!r.ok) continue;
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.patients || data.data || []);
        if (list.length >= 0) {
          list.forEach(p => { if (!p.name && p.fullName) p.name = p.fullName; });
          return res.json({ patients: list, total: list.length });
        }
      }
      return res.json({ patients: [], total: 0 });
    }

    // ── Dados completos de um paciente ───────────────────────────────────────
    if (action === "patient") {
      if (!id) return res.status(400).json({ error: "id obrigatório" });
      const r = await fetch(`${APP_BASE}/patients/${id}.json`, { headers: hdrs });
      if (!r.ok) return res.status(r.status).json({ error: `Codental: ${r.status}` });
      return res.json(await r.json());
    }

    // ── Uploads/exames do paciente ───────────────────────────────────────────
    if (action === "uploads") {
      if (!id) return res.status(400).json({ error: "id obrigatório" });
      const r = await fetch(`${APP_BASE}/patients/${id}/uploads.json`, { headers: hdrs });
      if (!r.ok) return res.status(r.status).json({ error: `Codental: ${r.status}` });
      const data = await r.json();
      return res.json({ uploads: Array.isArray(data) ? data : (data.uploads || []) });
    }

    // ── Evoluções do paciente ────────────────────────────────────────────────
    if (action === "evolutions") {
      if (!id) return res.status(400).json({ error: "id obrigatório" });
      const r = await fetch(`${APP_BASE}/patients/${id}/evolutions.json`, { headers: hdrs });
      if (!r.ok) return res.status(r.status).json({ error: `Codental: ${r.status}` });
      const data = await r.json();
      return res.json({ evolutions: Array.isArray(data) ? data : (data.evolutions || []) });
    }

    return res.status(400).json({ error: `Ação desconhecida: ${action}` });

  } catch (e) {
    console.error("[codental]", e.message);
    return res.status(500).json({ error: e.message });
  }
}