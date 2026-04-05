const { MongoClient } = require("mongodb");

let _client;
async function getDb() {
  if (!_client || !_client.topology?.isConnected?.()) {
    _client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await _client.connect();
  }
  return _client.db(process.env.MONGODB_DB || "codental_monitor");
}

const APP_BASE = process.env.CODENTAL_BASE_URL || "https://app.codental.com.br";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

// Cache de sessão em memória — evita hit no MongoDB a cada request
let _sessionCache = null;
let _sessionCacheTs = 0;
const SESSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function getSession() {
  const now = Date.now();
  if (_sessionCache && (now - _sessionCacheTs) < SESSION_CACHE_TTL) {
    return _sessionCache;
  }
  const db = await getDb();
  const doc = await db.collection("settings").findOne({ _id: "codental_session" });
  if (!doc?.cookie || !doc?.csrf) {
    throw new Error("Sem sessão Codental no MongoDB. GitHub Actions não rodou?");
  }
  _sessionCache = { cookie: doc.cookie, csrf: doc.csrf };
  _sessionCacheTs = now;
  return _sessionCache;
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
  // Nunca cachear — evita 304 sem body quebrando o frontend
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Surrogate-Control", "no-store");
  res.setHeader("Vary", "*");
  // Remove ETag para o Vercel não gerar 304
  res.removeHeader("ETag");
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

      // Busca APENAS a página HTML — ela contém todos os campos necessários
      // O /patients/ID.json foi removido pois não tem email/nascimento/convênio
      // e adiciona latência desnecessária
      const rHtml = await codentalFetchHtml(`/patients/${id}`, session);
      if (!rHtml.ok) return res.status(rHtml.status).json({ error: `Codental: ${rHtml.status}` });

      const html = await rHtml.text();
      if (html.includes("sign_in") || html.length < 1000) {
        return res.status(401).json({ error: "Sessão Codental expirada" });
      }

      const data = { id };

      // Nome completo
      const nameM = html.match(/<h2[^>]*tw-text-ugray-900[^>]*>([^<]{3,100})<\/h2>/i);
      if (nameM) data.full_name = nameM[1].trim();

      // Telefone — dentro de <span class="phone">
      const phoneM = html.match(/class="phone[^"]*"[^>]*>\s*([^<]+?)\s*<\/span>/i);
      if (phoneM) data.cellphone_formated = phoneM[1].trim();

      // CPF
      const cpfM = html.match(/CPF\s+([\d]{3}\.[\d]{3}\.[\d]{3}-[\d]{2})/i) ||
                   html.match(/patient-base-subtitle[^>]*>CPF<\/h4>[\s\S]{0,200}patient-base-info[^>]*>\s*([\d]{3}\.[\d]{3}\.[\d]{3}-[\d]{2})\s*</i);
      if (cpfM) data.cpf = cpfM[1].trim();

      // Email do paciente (não da clínica)
      const emailM = html.match(/patient-base-subtitle[^>]*>E-?mail<\/h4>[\s\S]{0,150}patient-base-info[^>]*>\s*([^\s<@]{2,}@[^\s<]{2,})\s*</i);
      if (emailM) data.email = emailM[1].trim();

      // Data de nascimento
      const birthdayM = html.match(/nascimento[\s\S]{0,300}patient-base-info[^>]*>[\s\S]*?(\d{2}\/\d{2}\/\d{4})/i);
      if (birthdayM) data.birthday = birthdayM[1].trim();

      // Convênio — via aria-label ou title
      const convenioM = html.match(/aria-label="Conv[^"]*"[\s\S]{0,400}title="([^"]{2,80})"/i) ||
                        html.match(/patient-base-subtitle[^>]*>Conv[^<]*<\/h4>[\s\S]{0,200}patient-base-info[^>]*>\s*([^<]{2,80}?)\s*</i);
      if (convenioM) data.health_insurance_name = convenioM[1].trim();

      // Carteirinha
      const cardM = html.match(/carteirinha[\s\S]{0,300}patient-base-info[^>]*>\s*([^<]{3,80}?)\s*</i);
      if (cardM) data.dental_plan_card_number = cardM[1].trim();

      console.log(`[patient] id=${id} fields: ${Object.keys(data).join(",")}`);
      return res.json(data);
    }

    if (action === "uploads") {
      if (!id) return res.status(400).json({ error: "id obrigatório" });

      // Tenta JSON direto primeiro
      const rJson = await codentalFetch(`/patients/${id}/uploads.json`, session);
      if (rJson.ok) {
        const ct = rJson.headers.get("content-type") || "";
        if (ct.includes("json")) {
          try {
            const data = await rJson.json();
            const list = Array.isArray(data) ? data : (data.uploads || []);
            console.log(`[uploads] id=${id} via JSON: ${list.length} items`);
            return res.json({ uploads: list });
          } catch (e) {
            console.warn(`[uploads] id=${id} JSON parse falhou:`, e.message);
          }
        }
        // Se não for JSON real, segue para parse HTML
      }

      // Sempre tenta HTML como fallback
      const r = await codentalFetchHtml(`/patients/${id}/uploads`, session);
      if (!r.ok) {
        console.warn(`[uploads] id=${id} HTML status=${r.status}`);
        return res.json({ uploads: [] });
      }

      const ct = r.headers.get("content-type") || "";
      if (ct.includes("json")) {
        try {
          const data = await r.json();
          const list = Array.isArray(data) ? data : (data.uploads || []);
          console.log(`[uploads] id=${id} via HTML-JSON: ${list.length} items`);
          return res.json({ uploads: list });
        } catch {}
      }

      // Parse HTML para extrair os uploads
      const html = await r.text();
      const uploads = [];

      console.log(`[uploads] id=${id} HTML length=${html.length} uploads-list=${html.includes('uploads-list')}`);

      // Estrutura CONFIRMADA pelo HAR:
      // <li data-upload-id="4591194" ...>
      //   <input value="4591194"
      //          data-url="{&quot;filename&quot;:&quot;foto.jpg&quot;,&quot;download&quot;:&quot;https://app.codental.com.br/rails/...&quot;}">
      //   <img src="https://codental-static.com/?fit=crop&amp;h=280&amp;url=...&amp;w=280">
      // </li>
      //
      // CHAVE: data-url usa aspas DUPLAS e o JSON dentro está escapado com &quot;

      // Passo 1: mapeia upload-id → posição no HTML
      const idMatches = [...html.matchAll(/data-upload-id="(\d+)"/g)];
      console.log(`[uploads] found ${idMatches.length} upload IDs`);

      // Passo 2: para cada ID, pega o bloco até o próximo ID e extrai filename, download, preview
      for (let i = 0; i < idMatches.length; i++) {
        try {
          const uploadId = idMatches[i][1];
          const start    = idMatches[i].index;
          const end      = i + 1 < idMatches.length ? idMatches[i+1].index : start + 4000;
          const block    = html.slice(start, end);

          // data-url="{&quot;filename&quot;:...&quot;}" — aspas duplas, JSON com &quot;
          const dataUrlM = block.match(/data-url="(\{&quot;[^"]+\})"/);
          if (!dataUrlM) {
            console.log(`[uploads] id=${uploadId}: no data-url found`);
            continue;
          }

          const raw = dataUrlM[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, '&')
            .replace(/&#39;/g, "'");

          let parsed = {};
          try { parsed = JSON.parse(raw); } catch(e) {
            console.log(`[uploads] id=${uploadId}: JSON parse failed: ${e.message}`);
            continue;
          }

          const filename    = parsed.filename || `arquivo_${uploadId}`;
          const downloadUrl = parsed.download  || null;

          // preview: src="https://codental-static.com/?..."
          const imgM      = block.match(/src="(https:\/\/codental-static\.com[^"]+)"/);
          const previewUrl = imgM ? imgM[1].replace(/&amp;/g, '&') : null;

          const ext = (filename.split('.').pop() || '').toLowerCase();
          const mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', pdf:'application/pdf', mp4:'video/mp4', mov:'video/quicktime' };

          uploads.push({
            id:           uploadId,
            name:         filename,
            url:          downloadUrl || previewUrl,
            preview_url:  previewUrl,
            download_url: downloadUrl,
            content_type: mimeMap[ext] || null,
          });
          console.log(`[uploads] OK: ${filename} preview=${!!previewUrl} dl=${!!downloadUrl}`);
        } catch(err) {
          console.error(`[uploads] error at ${i}:`, err.message);
        }
      }

      console.log(`[uploads] id=${id} TOTAL=${uploads.length}`);
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

    // ── Proxy para download de arquivo do Codental ───────────────────
    if (action === "file") {
      const fileUrl = req.query.url;
      if (!fileUrl) return res.status(400).json({ error: "url obrigatório" });
      try {
        const r = await fetch(decodeURIComponent(fileUrl), {
          headers: {
            "Cookie": session.cookie,
            "User-Agent": UA,
            "Referer": `${APP_BASE}/patients`,
          },
        });
        if (!r.ok) return res.status(r.status).json({ error: `Codental file: ${r.status}` });
        const ct  = r.headers.get("content-type") || "application/octet-stream";
        const buf = await r.arrayBuffer();
        res.setHeader("Content-Type", ct);
        res.setHeader("Cache-Control", "public, max-age=300"); // cache 5 min
        return res.status(200).end(Buffer.from(buf));
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    // ── Upload de novo arquivo para o paciente ───────────────────────
    if (action === "upload_file") {
      if (!id) return res.status(400).json({ error: "id obrigatório" });

      // Lê o arquivo do body multipart
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const fileBuffer = Buffer.concat(chunks);
      const contentType = req.headers["content-type-file"] || "application/octet-stream";
      const filename    = req.headers["x-filename"] ? decodeURIComponent(req.headers["x-filename"]) : "arquivo.jpg";
      const fileSize    = fileBuffer.length;

      // 1. Obtém CSRF token
      const pageR = await codentalFetchHtml(`/patients/${id}/uploads`, session);
      if (!pageR.ok) return res.status(pageR.status).json({ error: "Falha ao acessar página" });
      const pageHtml = await pageR.text();
      const csrfM    = pageHtml.match(/name="csrf-token"\s+content="([^"]+)"/);
      const csrfToken = csrfM ? csrfM[1] : "";
      if (!csrfToken) return res.status(500).json({ error: "CSRF token não encontrado" });

      // 2. Solicita Direct Upload URL ao Codental (Active Storage)
      const crypto = await import("crypto");
      const checksum = crypto.createHash("md5").update(fileBuffer).digest("base64");

      const directUploadR = await fetch(`${APP_BASE}/rails/active_storage/direct_uploads`, {
        method: "POST",
        headers: {
          "Cookie": session.cookie,
          "User-Agent": UA,
          "Content-Type": "application/json",
          "X-CSRF-Token": csrfToken,
          "Accept": "application/json",
          "X-Requested-With": "XMLHttpRequest",
        },
        body: JSON.stringify({
          blob: {
            filename,
            content_type: contentType,
            byte_size: fileSize,
            checksum,
          }
        }),
      });

      if (!directUploadR.ok) {
        const t = await directUploadR.text();
        console.error(`[upload_file] direct_upload failed ${directUploadR.status}:`, t.slice(0,200));
        return res.status(directUploadR.status).json({ error: `Direct upload falhou: ${directUploadR.status}` });
      }

      const { signed_id, direct_upload } = await directUploadR.json();
      const { url: s3Url, headers: s3Headers } = direct_upload;

      // 3. Faz PUT direto no S3
      const s3R = await fetch(s3Url, {
        method: "PUT",
        headers: { ...s3Headers, "Content-Length": String(fileSize) },
        body: fileBuffer,
      });
      if (!s3R.ok) {
        console.error(`[upload_file] S3 PUT failed ${s3R.status}`);
        return res.status(500).json({ error: `S3 upload falhou: ${s3R.status}` });
      }

      // 4. Cria o registro de upload no Codental com o signed_id do blob
      const createR = await fetch(`${APP_BASE}/patients/${id}/uploads`, {
        method: "POST",
        headers: {
          "Cookie": session.cookie,
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRF-Token": csrfToken,
          "Accept": "text/vnd.turbo-stream.html, text/html, */*",
          "X-Requested-With": "XMLHttpRequest",
          "Origin": APP_BASE,
          "Referer": `${APP_BASE}/patients/${id}/uploads`,
        },
        body: new URLSearchParams({
          "upload[name]": filename,
          "upload[file]": signed_id,
        }).toString(),
        redirect: "follow",
      });

      const createText = await createR.text().catch(() => "");
      if ([200, 201, 302].includes(createR.status)) {
        console.log(`[upload_file] success: ${filename} for patient ${id}`);
        return res.status(200).json({ success: true, filename });
      }
      console.error(`[upload_file] create failed ${createR.status}:`, createText.slice(0, 300));
      return res.status(createR.status).json({ error: `Criação do upload falhou: ${createR.status}` });
    }

    // ── Atualizar paciente ────────────────────────────────────────────
    if (action === "update") {
      if (!id) return res.status(400).json({ error: "id obrigatório" });
      const body = req.body || {};

      const f = new URLSearchParams();
      f.append("authenticity_token",   session.csrf);
      f.append("_method",              "PATCH");
      if (body.nome        !== undefined) f.append("patient[full_name]",              body.nome);
      if (body.email       !== undefined) f.append("patient[email]",                  body.email);
      if (body.cpf         !== undefined) f.append("patient[cpf]",                    body.cpf.replace(/\D/g,"").replace(/(\d{3})(\d{3})(\d{3})(\d{2})/,"$1.$2.$3-$4"));
      if (body.telefone    !== undefined) {
        const tel = body.telefone.replace(/\D/g,"").replace(/^55/,"");
        f.append("patient[cellphone_formated]",     tel);
        f.append("patient[cellphone_country_code]", "+55");
      }
      if (body.nascimento  !== undefined) {
        // Aceita DD/MM/YYYY ou YYYY-MM-DD
        let bday = body.nascimento;
        const iso = bday.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (iso) bday = `${iso[3]}/${iso[2]}/${iso[1]}`;
        f.append("patient[birthday]", bday);
      }
      if (body.carteirinha !== undefined) f.append("patient[dental_plan_card_number]", body.carteirinha);

      // Convênio — resolve dental_plan_id se vier nome
      if (body.convenio !== undefined) {
        const pr = await codentalFetchHtml("/patients/new", session);
        if (pr.ok) {
          const html = await pr.text();
          const selectM = html.match(/id="patient_dental_plan_id"[^>]*>([\s\S]*?)<\/select>/);
          if (selectM) {
            const plans = [];
            const optReg = /<option[^>]*value="(\d+)"[^>]*>([^<]+)<\/option>/g;
            let m;
            while ((m = optReg.exec(selectM[1])) !== null) plans.push({ id: m[1], name: m[2].trim() });
            const norm = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
            const cn = norm(body.convenio);
            const match = plans.find(p => norm(p.name) === cn)
                       || plans.find(p => norm(p.name).includes(cn) || cn.includes(norm(p.name)))
                       || plans.find(p => cn.split(/\s+/).filter(w=>w.length>3).some(w=>norm(p.name).includes(w)));
            if (match) f.append("patient[dental_plan_id]", match.id);
          }
        }
      }

      const r = await fetch(`${APP_BASE}/patients/${id}`, {
        method:  "POST",
        redirect: "follow",
        headers: {
          "Content-Type":     "application/x-www-form-urlencoded",
          "X-CSRF-Token":     session.csrf,
          "X-Requested-With": "XMLHttpRequest",
          "Accept":           "text/html,application/xhtml+xml,application/json",
          "Cookie":           session.cookie,
          "Origin":           APP_BASE,
          "Referer":          `${APP_BASE}/patients/${id}/edit`,
          "User-Agent":       UA,
        },
        body: f.toString(),
      });

      const text = await r.text().catch(() => "");
      console.log(`[codental/update] id=${id} status=${r.status} url=${r.url?.slice(0,80)}`);

      if ([200, 201, 302].includes(r.status) || r.url?.includes(`/patients/${id}`)) {
        return res.json({ success: true });
      }
      return res.status(r.status).json({ error: `Update falhou: ${r.status}` });
    }

    // ── Buscar planos do convênio ────────────────────────────────────
    if (action === "dental_plans") {
      const session = await getSession();
      // Busca a página de novo paciente para extrair os planos disponíveis
      const r = await codentalFetchHtml("/patients/new", session);
      if (!r.ok) return res.status(r.status).json({ error: "Falha ao buscar planos" });
      const html = await r.text();
      const plans = [];
      // Extrai <option value="ID">Nome</option> dentro do select de dental_plan_id
      const selectM = html.match(/id="patient_dental_plan_id"[^>]*>([\s\S]*?)<\/select>/);
      if (selectM) {
        const optReg = /<option[^>]*value="(\d+)"[^>]*>([^<]+)<\/option>/g;
        let m;
        while ((m = optReg.exec(selectM[1])) !== null) {
          plans.push({ id: m[1], name: m[2].trim() });
        }
      }
      return res.json({ plans });
    }

    // ── Criar paciente ───────────────────────────────────────────────
    if (action === "create") {
      const session = await getSession();
      const body    = req.body || {};

      const nome      = (body.nome || body.name || "").trim();
      const cpfRaw    = (body.cpf  || "").replace(/\D/g, "");
      const phoneRaw  = (body.telefone || body.phone || "").replace(/\D/g, "");
      const email     = (body.email || "").trim();
      const convenio  = (body.convenio || "").trim();
      const nascimento = (body.nascimento || "").trim();

      // Formata CPF: 000.000.000-00
      const cpfFmt = cpfRaw.length === 11
        ? `${cpfRaw.slice(0,3)}.${cpfRaw.slice(3,6)}.${cpfRaw.slice(6,9)}-${cpfRaw.slice(9)}`
        : cpfRaw;

      // Telefone: remove DDI 55 se vier
      let phoneFmt = phoneRaw;
      if (phoneFmt.startsWith("55") && phoneFmt.length >= 12) phoneFmt = phoneFmt.slice(2);

      // Normaliza data para DD/MM/YYYY
      let birthdayFmt = "";
      if (nascimento) {
        // Aceita DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD
        const parts = nascimento.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/) ||
                      nascimento.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
        if (parts) {
          const [, a, b, c] = parts;
          if (a.length === 4) birthdayFmt = `${b.padStart(2,"0")}/${c.padStart(2,"0")}/${a}`;
          else birthdayFmt = `${a.padStart(2,"0")}/${b.padStart(2,"0")}/${c.length===2?"20"+c:c}`;
        }
      }

      // ── Resolve dental_plan_id a partir do nome do convênio ──────
      let dentalPlanId = "";
      if (convenio) {
        // Busca os planos da página de novo paciente
        try {
          const pr = await codentalFetchHtml("/patients/new", session);
          if (pr.ok) {
            const html = await pr.text();
            const plans = [];
            const selectM = html.match(/id="patient_dental_plan_id"[^>]*>([\s\S]*?)<\/select>/);
            if (selectM) {
              const optReg = /<option[^>]*value="(\d+)"[^>]*>([^<]+)<\/option>/g;
              let m;
              while ((m = optReg.exec(selectM[1])) !== null) {
                plans.push({ id: m[1], name: m[2].trim() });
              }
            }
            // Match fuzzy: normaliza e compara
            const norm = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]/g,"");
            const convNorm = norm(convenio);
            // Match exato primeiro
            let match = plans.find(p => norm(p.name) === convNorm);
            // Match parcial: convenio contém parte do nome do plano ou vice-versa
            if (!match) match = plans.find(p => norm(p.name).includes(convNorm) || convNorm.includes(norm(p.name)));
            // Match por palavras-chave (ex: "quality" → "Quallity Pró Saúde")
            if (!match) {
              const words = convNorm.split(/\s+/).filter(w => w.length > 3);
              match = plans.find(p => words.some(w => norm(p.name).includes(w)));
            }
            if (match) {
              dentalPlanId = match.id;
              console.log(`[codental/create] convênio "${convenio}" → id=${match.id} (${match.name})`);
            } else {
              // Default: Particular (19304)
              const particular = plans.find(p => norm(p.name).includes("particular"));
              dentalPlanId = particular?.id || "19304";
              console.log(`[codental/create] convênio "${convenio}" não encontrado, usando Particular`);
            }
          }
        } catch (e) {
          console.warn("[codental/create] Erro ao buscar planos:", e.message);
        }
      }

      console.log("[codental/create]", JSON.stringify({ nome, cpfFmt, phoneFmt, email, birthdayFmt, dentalPlanId }));

      // Monta o form como URLSearchParams
      function buildForm({ nome, cpf, phone, email, birthday, planId, carteirinha }) {
        const f = new URLSearchParams();
        f.append("authenticity_token",              session.csrf);
        f.append("patient[full_name]",              nome);
        if (phone) {
          f.append("patient[cellphone_formated]",    phone);
          f.append("patient[cellphone_country_code]", "+55");
        }
        if (cpf)          f.append("patient[cpf]",                    cpf);
        if (email)        f.append("patient[email]",                  email);
        if (birthday)     f.append("patient[birthday]",               birthday);
        if (planId)       f.append("patient[dental_plan_id]",         planId);
        if (carteirinha)  f.append("patient[dental_plan_card_number]", carteirinha);
        f.append("patient[reminder_preference]", "whatsapp");
        return f;
      }

      async function tryCreate(params) {
        const r = await fetch(`${APP_BASE}/patients`, {
          method:      "POST",
          redirect:    "follow",
          headers: {
            "Content-Type":    "application/x-www-form-urlencoded",
            "X-CSRF-Token":    session.csrf,
            "X-Requested-With": "XMLHttpRequest",
            "Accept":          "text/html,application/xhtml+xml,application/json",
            "Cookie":          session.cookie,
            "Origin":          APP_BASE,
            "Referer":         `${APP_BASE}/patients/new`,
            "User-Agent":      UA,
          },
          body: buildForm(params).toString(),
        });
        const finalUrl = r.url || "";
        const status   = r.status;
        const bodyText = await r.text().catch(() => "");
        console.log(`[codental/create] status=${status} url=${finalUrl.slice(0,80)}`);
        return { status, finalUrl, bodyText };
      }

      function extractId(url) {
        const m = url?.match(/\/patients\/(\d+)/);
        return m && !url.includes("/new") && !url.includes("/edit") ? m[1] : null;
      }

      const carteirinha = (body.carteirinha || "").trim();

      // Tentativas em cascata
      let r, patientId;

      // 1. Tentativa completa
      r = await tryCreate({ nome, cpf: cpfFmt, phone: phoneFmt, email, birthday: birthdayFmt, planId: dentalPlanId, carteirinha });
      patientId = extractId(r.finalUrl);

      // 2. Sem CPF (CPF duplicado ou inválido)
      if (!patientId && cpfFmt) {
        r = await tryCreate({ nome, cpf: "", phone: phoneFmt, email, birthday: birthdayFmt, planId: dentalPlanId, carteirinha });
        patientId = extractId(r.finalUrl);
      }

      // 3. Só nome e telefone (sem dados opcionais)
      if (!patientId) {
        r = await tryCreate({ nome, cpf: "", phone: phoneFmt, email: "", birthday: "", planId: "", carteirinha: "" });
        patientId = extractId(r.finalUrl);
      }

      // 4. Só nome
      if (!patientId) {
        r = await tryCreate({ nome, cpf: "", phone: "", email: "", birthday: "", planId: "", carteirinha: "" });
        patientId = extractId(r.finalUrl);
      }

      // 5. Fallback: busca por nome (pode ter sido criado com 422 falso)
      if (!patientId && nome) {
        const sr = await codentalFetch(
          `/patients/search.json?query=${encodeURIComponent(nome.split(" ")[0])}`, session
        );
        if (sr.ok) {
          const data = await sr.json().catch(() => ({}));
          const list = Array.isArray(data) ? data : (data.patients || data.data || []);
          const sorted = list.sort((a, b) => Number(b.id) - Number(a.id));
          const firstName = nome.split(" ")[0].toLowerCase();
          const match = sorted.find(p => (p.name || p.fullName || "").toLowerCase().includes(firstName));
          if (match?.id) patientId = String(match.id);
        }
      }

      if (patientId) {
        const url = `${APP_BASE}/patients/${patientId}`;
        console.log(`[codental/create] ✓ paciente criado/encontrado id=${patientId}`);
        return res.json({ ok: true, patient_id: patientId, url });
      }

      console.error(`[codental/create] ✗ falhou após todas as tentativas. last status=${r.status}`);
      return res.status(422).json({
        error: "Não foi possível criar o paciente no Codental. Verifique se os dados são válidos.",
        debug: r.bodyText?.slice(0, 300),
      });
    }

    return res.status(400).json({ error: `Ação desconhecida: ${action}` });

  } catch (e) {
    console.error("[codental]", e.message);
    return res.status(500).json({ error: e.message });
  }
};