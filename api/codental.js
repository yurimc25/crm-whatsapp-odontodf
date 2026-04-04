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
  if (r.status === 401 || r.status === 403) throw new Error("Sessão Codental expirada");
  return r;
}

// Para endpoints que retornam HTML (evolutions, uploads) — Accept: text/html
async function codentalFetchHtml(path, session) {
  const r = await fetch(`${APP_BASE}${path}`, {
    headers: {
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cookie": session.cookie,
      "User-Agent": UA,
      "Referer": `${APP_BASE}/patients`,
    },
  });
  if (r.status === 401 || r.status === 403) throw new Error("Sessão Codental expirada");
  return r;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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

      // Tenta JSON direto primeiro
      const rJson = await codentalFetch(`/patients/${id}/uploads.json`, session);
      if (rJson.ok) {
        const ct = rJson.headers.get("content-type") || "";
        if (ct.includes("json")) {
          const data = await rJson.json();
          return res.json({ uploads: Array.isArray(data) ? data : (data.uploads || []) });
        }
      }

      // Fallback: busca página HTML e extrai uploads do JSON embutido
      const r = await codentalFetchHtml(`/patients/${id}/uploads`, session);
      if (!r.ok) return res.status(r.status).json({ error: `Codental: ${r.status}` });

      const ct = r.headers.get("content-type") || "";
      if (ct.includes("json")) {
        const data = await r.json();
        return res.json({ uploads: Array.isArray(data) ? data : (data.uploads || []) });
      }

      // Parse HTML para extrair os uploads
      const html = await r.text();
      const uploads = [];

      // Estrutura real do Codental:
      // <li ... data-upload-id="4591194" ...>
      //   <input ... value="4591194" data-url='{"filename":"254_...jpg","download":"https://..."}'>
      //   <img src="https://codental-static.com/?...&url=https%3A%2F%2F...s3...&...">
      // </li>
      //
      // Extrai cada <li> que tem data-upload-id (específico de uploads, não confunde com outros elements)
      const liReg = /<li[^>]*\bdata-upload-id="(\d+)"[^>]*>([\s\S]*?)<\/li>/g;
      let m;
      while ((m = liReg.exec(html)) !== null) {
        try {
          const uploadId  = m[1];
          const liContent = m[2];

          // data-url usa aspas simples: data-url='{"filename":"...","download":"..."}'
          const dataUrlM = liContent.match(/data-url='([^']+)'/);
          if (!dataUrlM) continue;

          const dataUrlRaw = dataUrlM[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, "&")
            .replace(/&#39;/g, "'");

          let parsed = {};
          try { parsed = JSON.parse(dataUrlRaw); } catch { continue; }

          const filename    = parsed.filename || `arquivo_${uploadId}`;
          const downloadUrl = parsed.download || null;

          // Miniatura: <img src="https://codental-static.com/?...url=ENCODED_S3_URL...">
          const imgM = liContent.match(/\bsrc="(https:\/\/codental-static\.com[^"]+)"/);
          let previewUrl = null;
          if (imgM) {
            const urlMatch = imgM[1].match(/[?&]url=([^&"]+)/);
            if (urlMatch) {
              previewUrl = decodeURIComponent(urlMatch[1]);
            } else {
              previewUrl = imgM[1].replace(/&amp;/g, "&");
            }
          }

          // Determina content_type pelo nome do arquivo
          const ext = filename.split(".").pop().toLowerCase();
          const mimeMap = {
            jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png",
            gif:"image/gif", webp:"image/webp", pdf:"application/pdf",
            mp4:"video/mp4", mov:"video/quicktime",
          };

          uploads.push({
            id:           uploadId,
            name:         filename,
            url:          downloadUrl || previewUrl,
            preview_url:  previewUrl,
            download_url: downloadUrl,
            content_type: mimeMap[ext] || null,
          });
        } catch {}
      }

      console.log(`[uploads] id=${id} parsed ${uploads.length} items`);
      return res.json({ uploads });
    }

    if (action === "evolutions") {
      if (!id) return res.status(400).json({ error: "id obrigatório" });

      // Usa headers de HTML — o Codental rejeita com Accept: application/json
      const r = await codentalFetchHtml(`/patients/${id}/evolutions`, session);
      const status = r.status;
      const ct = r.headers.get("content-type") || "";
      console.log(`[evolutions] id=${id} status=${status} ct=${ct.slice(0,50)}`);

      // Se retornou JSON real
      if (r.ok && ct.includes("json")) {
        const data = await r.json();
        const list = Array.isArray(data) ? data : (data.evolutions || data.data || []);
        return res.json({ evolutions: list });
      }

      // HTML normal do Codental
      if (r.ok) {
        const html = await r.text();

        if (html.includes("sign_in") || html.length < 500) {
          return res.status(401).json({ error: "Sessão Codental expirada" });
        }

        const evolutions = [];
        const rowReg = /<tr[^>]+id="evolution_(\d+)"[^>]*>([\s\S]*?)<\/tr>/g;
        let match;
        while ((match = rowReg.exec(html)) !== null) {
          const eid   = match[1];
          const block = match[2];

          const descM = block.match(/<div[^>]*tw-text-ugray-900[^>]*>([\s\S]*?)<\/div>/);
          const desc  = descM ? descM[1].replace(/<[^>]+>/g, "").trim() : "";

          const dentM = block.match(/<div[^>]*evolution-dentist[^>]*>([\s\S]*?)<\/div>/);
          let date = "", dentist = "", signed = false;
          if (dentM) {
            const inner = dentM[1];
            const dateM = inner.match(/(\d{2}\/\d{2}\/\d{4})\s*(\d{2}:\d{2}:\d{2})/);
            if (dateM) date = `${dateM[1]} ${dateM[2]}`;
            const spanM = inner.match(/<span[^>]*tw-truncate[^>]*>([\s\S]*?)<\/span>/);
            if (spanM) dentist = spanM[1].replace(/<[^>]+>/g, "").trim();
            signed = /Assinado/i.test(inner);
          }

          evolutions.push({ id: eid, description: desc, date, dentist, signed });
        }

        console.log(`[evolutions] parse: ${evolutions.length} itens`);
        return res.json({ evolutions });
      }

      return res.status(status).json({ error: `Codental: ${status}` });
    }

    // ── Criar paciente ───────────────────────────────────────────────
    if (action === "create") {
      const session = await getSession();
      const body    = req.body || {};

      // Formata CPF: remove não-dígitos
      const cpf = (body.cpf || "").replace(/\D/g, "");
      // Formata telefone: remove não-dígitos
      const phone = (body.telefone || body.phone || "").replace(/\D/g, "");

      // Payload no formato que o Codental espera
      const payload = {
        patient: {
          name:       body.nome || body.name || "",
          cpf:        cpf || null,
          email:      body.email || null,
          phone:      phone || null,
          birthdate:  body.nascimento || body.birthdate || null,
          health_insurance_name: body.convenio || body.health_insurance || null,
        }
      };

      console.log("[codental/create]", JSON.stringify(payload.patient));

      const r = await fetch(`${APP_BASE}/patients.json`, {
        method: "POST",
        headers: {
          ...authHeaders(session),
          "Content-Type": "application/json",
          "Accept": "application/json",
          "Referer": `${APP_BASE}/patients/new`,
        },
        body: JSON.stringify(payload),
      });

      const ct = r.headers.get("content-type") || "";
      let data = {};
      if (ct.includes("json")) {
        data = await r.json().catch(() => ({}));
      } else {
        const text = await r.text();
        console.log(`[codental/create] status=${r.status} resp=${text.slice(0, 200)}`);
        // Codental pode redirecionar para o paciente criado (302 → /patients/ID)
        if (r.status === 302 || r.redirected) {
          const location = r.headers.get("location") || r.url || "";
          const idMatch  = location.match(/\/patients\/(\d+)/);
          if (idMatch) {
            return res.json({ ok: true, patient_id: idMatch[1], url: location });
          }
        }
      }

      if (!r.ok && r.status !== 302) {
        console.error(`[codental/create] erro ${r.status}:`, JSON.stringify(data));
        return res.status(r.status).json({ error: data.error || `Codental: ${r.status}`, details: data });
      }

      // Extrai ID do paciente criado
      const patientId = data.id || data.patient?.id || null;
      const patientUrl = patientId ? `${APP_BASE}/patients/${patientId}` : null;
      console.log(`[codental/create] paciente criado id=${patientId}`);

      return res.json({ ok: true, patient_id: patientId, url: patientUrl, data });
    }

    return res.status(400).json({ error: `Ação desconhecida: ${action}` });

  } catch (e) {
    console.error("[codental]", e.message);
    return res.status(500).json({ error: e.message });
  }
};