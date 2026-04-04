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

      // Tenta JSON primeiro
      const rJson = await codentalFetch(`/patients/${id}.json`, session);
      let jsonData = {};
      if (rJson.ok) {
        try { jsonData = await rJson.json(); } catch {}
      }

      // Busca página HTML para extrair campos que o JSON pode não ter
      const rHtml = await codentalFetchHtml(`/patients/${id}`, session);
      let htmlData = {};
      if (rHtml.ok) {
        const html = await rHtml.text();

        // Extrai campos do HTML usando os padrões da página de detalhes do paciente
        function extractField(label, html) {
          const patterns = [
            // <h4 class="patient-base-subtitle">LABEL</h4>\n<...>VALUE<...>
            new RegExp(`patient-base-subtitle">[^<]*${label}[^<]*<\/h4>[\\s\\S]*?<[^>]+>([^<]{2,200})<`, 'i'),
            // Padrão de span com classe patient-base-info
            new RegExp(`${label}[^<]{0,50}<\/h4>[\\s\\S]{0,200}patient-base-info[^>]*>([^<]{2,200})<`, 'i'),
          ];
          for (const re of patterns) {
            const m = html.match(re);
            if (m) return m[1].trim();
          }
          return null;
        }

        // Celular — extrai do elemento com class "phone"
        const phoneM = html.match(/class="phone[^"]*"[^>]*>\s*([^<]+?)\s*<\/span>/i) ||
                       html.match(/wa\.me\/[^"]*"[^>]*>[^<]*<\/a>\s*([^<]{7,20})/i);
        if (phoneM) htmlData.cellphone_formated = phoneM[1].trim();

        // Email
        const emailM = html.match(/patient-base-subtitle[^>]*>Email<\/h4>[\s\S]{0,100}patient-base-info[^>]*>\s*([^\s<@]{2,}@[^\s<]{2,})\s*</i);
        if (emailM) htmlData.email = emailM[1].trim();

        // Data de nascimento — padrão DD/MM/YYYY
        const birthdayM = html.match(/nascimento[\s\S]{0,200}patient-base-info[^>]*>[\s\S]*?(\d{2}\/\d{2}\/\d{4})/i);
        if (birthdayM) htmlData.birthday = birthdayM[1].trim();

        // CPF — padrão 000.000.000-00
        const cpfM = html.match(/patient-base-subtitle[^>]*>CPF<\/h4>[\s\S]{0,200}patient-base-info[^>]*>\s*([\d]{3}\.[\d]{3}\.[\d]{3}-[\d]{2})\s*</i);
        if (cpfM) htmlData.cpf = cpfM[1].trim();

        // Convênio — extrai do aria-label="Convênio"
        const convenioM = html.match(/aria-label="Conv[^"]*"[\s\S]{0,300}patient-base-info[^>]*>\s*([^<]{2,80}?)\s*</i) ||
                          html.match(/patient-base-subtitle[^>]*>Conv[^<]*<\/h4>[\s\S]{0,200}patient-base-info[^>]*[^>]*>([^<]{2,80})</i);
        if (convenioM) htmlData.health_insurance_name = convenioM[1].trim();

        // Carteirinha do convênio
        const cardM = html.match(/carteirinha[\s\S]{0,200}patient-base-info[^>]*>([^<]{3,80})</i);
        if (cardM) htmlData.dental_plan_card_number = cardM[1].trim();

        // Nome completo — do <h2> na página
        const nameM = html.match(/<h2[^>]*tw-text-ugray-900[^>]*>([^<]{3,100})<\/h2>/i);
        if (nameM) htmlData.full_name = nameM[1].trim();

        // ID do paciente
        htmlData.id = id;

        console.log(`[patient] id=${id} html fields:`, Object.keys(htmlData).join(","));
      }

      // Mescla: JSON tem prioridade, HTML preenche o que faltou
      const merged = { ...htmlData, ...jsonData };
      // Garante que campos HTML importantes não sejam sobrescritos por valores vazios do JSON
      if (!merged.email && htmlData.email)                           merged.email = htmlData.email;
      if (!merged.birthday && htmlData.birthday)                     merged.birthday = htmlData.birthday;
      if (!merged.cellphone_formated && htmlData.cellphone_formated) merged.cellphone_formated = htmlData.cellphone_formated;
      if (!merged.health_insurance_name && htmlData.health_insurance_name) merged.health_insurance_name = htmlData.health_insurance_name;
      if (!merged.cpf && htmlData.cpf)                               merged.cpf = htmlData.cpf;
      if (!merged.full_name && htmlData.full_name)                   merged.full_name = htmlData.full_name;

      return res.json(merged);
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