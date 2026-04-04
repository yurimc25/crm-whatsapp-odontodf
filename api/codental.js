const { MongoClient } = require("mongodb");

let _client;
async function getDb() {
  if (!_client) {
    _client = new MongoClient(process.env.MONGODB_URI);
    await _client.connect();
  }
  return _client.db(process.env.MONGODB_DB || "codental_monitor");
}

const APP_BASE = process.env.CODENTAL_BASE_URL || "https://app.codental.com.br";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

async function getSession() {
  const db = await getDb();
  const doc = await db.collection("settings").findOne({ _id: "codental_session" });
  if (!doc?.cookie || !doc?.csrf) {
    throw new Error("Sem sessão Codental no MongoDB. GitHub Actions não rodou?");
  }
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

async function codentalFetch(path, session) {
  const r = await fetch(`${APP_BASE}${path}`, { headers: authHeaders(session) });
  if (r.status === 401 || r.status === 403) {
    throw new Error("Sessão Codental expirada");
  }
  return r;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) return res.status(401).json({ error: "Unauthorized" });

  const { action, q, id, phone } = req.query;

  try {
    const session = await getSession();

    if (action === "search" && phone) {
      const digits = phone.replace(/\D/g, "");
      const local = digits.startsWith("55") && digits.length > 10 ? digits.slice(2) : digits;
      const variants = new Set([digits, local, "55" + local]);

      if (local.length === 11 && local[2] === "9") {
        const sem9 = local.slice(0, 2) + local.slice(3);
        variants.add(sem9);
        variants.add("55" + sem9);
      }
      if (local.length === 10) {
        const com9 = local.slice(0, 2) + "9" + local.slice(2);
        variants.add(com9);
        variants.add("55" + com9);
      }

      let found = [];
      for (const v of variants) {
        if (found.length > 0) break;
        try {
          const r = await codentalFetch(`/patients/search.json?query=${encodeURIComponent(v)}`, session);
          if (!r.ok) continue;
          const data = await r.json();
          const list = Array.isArray(data) ? data : (data.patients || data.data || []);
          if (list.length > 0) found = list;
        } catch (_) {}
      }
      return res.json({ patients: found, source: "phone" });
    }

    if (action === "search" && q) {
      const tokens = q.trim().split(/\s+/).filter(t => t.length > 1);
      const variants = new Set([q]);
      if (tokens.length >= 2) variants.add(`${tokens[0]} ${tokens[tokens.length - 1]}`);
      if (tokens.length >= 3) variants.add(`${tokens[0]} ${tokens[1]}`);
      variants.add(tokens[0]);

      let best = [];
      for (const v of variants) {
        if (best.length > 0) break;
        try {
          const r = await codentalFetch(`/patients/search.json?query=${encodeURIComponent(v)}`, session);
          if (!r.ok) continue;
          const data = await r.json();
          const list = Array.isArray(data) ? data : (data.patients || data.data || []);
          if (list.length > 0) best = list;
        } catch (_) {}
      }
      return res.json({ patients: best, source: "name" });
    }

    if (action === "patient") {
      if (!id) return res.status(400).json({ error: "id obrigatório" });
      const r = await codentalFetch(`/patients/${id}.json`, session);
      if (!r.ok) return res.status(r.status).json({ error: `Codental: ${r.status}` });
      return res.json(await r.json());
    }

    if (action === "uploads") {
      if (!id) return res.status(400).json({ error: "id obrigatório" });
      const r = await codentalFetch(`/patients/${id}/uploads.json`, session);
      if (!r.ok) return res.status(r.status).json({ error: `Codental: ${r.status}` });
      const data = await r.json();
      return res.json({ uploads: Array.isArray(data) ? data : (data.uploads || []) });
    }

    if (action === "evolutions") {
    if (!id) return res.status(400).json({ error: "id obrigatório" });

    // Tenta JSON primeiro
    const r = await codentalFetch(`/patients/${id}/evolutions.json`, session);

    const ct = r.headers.get("content-type") || "";

    // Se retornou JSON real
    if (ct.includes("json") && r.ok) {
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.evolutions || data.data || []);
        return res.json({ evolutions: list });
    }

    // Se retornou HTML, faz parse manual
    if (r.ok) {
        const html = await r.text();
        const evolutions = [];

        // Extrai cada evolution-row
        const rowReg = /id="evolution_(\d+)"[\s\S]*?class="evolutions-table-cell-text[\s\S]*?<\/tr>/g;
        let match;
        while ((match = rowReg.exec(html)) !== null) {
        const block = match[0];
        const eid   = match[1];

        // Descrição: primeiro div dentro de evolutions-table-cell-text
        const descM = block.match(/<div[^>]*tw-text-ugray-900[^>]*>([\s\S]*?)<\/div>/);
        const desc  = descM ? descM[1].replace(/<[^>]+>/g,"").trim() : "";

        // Data e dentista: evolution-dentist div
        const dentM = block.match(/class="evolution-dentist[^"]*"[^>]*>([\s\S]*?)<\/div>/);
        let date = "", dentist = "", signed = false;
        if (dentM) {
            const inner = dentM[1];
            const dateM = inner.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})/);
            if (dateM) date = `${dateM[1]} ${dateM[2]}`;
            const dentistM = inner.match(/<span[^>]*tw-truncate[^>]*>([\s\S]*?)<\/span>/);
            if (dentistM) dentist = dentistM[1].replace(/<[^>]+>/g,"").trim();
            signed = inner.includes("Assinado");
        }

        evolutions.push({ id: eid, description: desc, date, dentist, signed });
        }

        return res.json({ evolutions });
    }

    return res.status(r.status).json({ error: `Codental: ${r.status}` });
    }

  } catch (e) {
    console.error("[codental]", e.message);
    return res.status(500).json({ error: e.message });
  }
};