// api/doctoralia.js — Integração com Doctoralia/DocPlanner API
// Token Bearer de longa duração — salvo como DOCTORALIA_TOKEN no Vercel
// Se expirar, retorna 401 com mensagem clara para renovar

const BASE_URL    = "https://docplanner.doctoralia.com.br";
const FACILITY_ID = 311940;

// Cache em memória dos IDs de convênio (dura enquanto a lambda está quente)
let _insuranceCache = null;

function docHeaders() {
  return {
    "accept":          "application/json, text/plain, */*",
    "accept-language": "pt-BR,pt;q=0.9",
    "authorization":   `bearer ${process.env.DOCTORALIA_TOKEN || ""}`,
    "content-type":    "application/json",
    "origin":          BASE_URL,
    "referer":         `${BASE_URL}/`,
    "x-clinic-size":   "0-10",
    "x-country-id":    "BR",
    "x-user-type":     "medicalcenter",
    "user-agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  };
}

// Normaliza string para comparação fuzzy
function norm(s) {
  return (s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Busca todos os convênios da clínica no Doctoralia
async function fetchInsurances() {
  if (_insuranceCache) return _insuranceCache;
  try {
    const r = await fetch(`${BASE_URL}/api/insurances?facilityId=${FACILITY_ID}`, {
      headers: docHeaders(),
    });
    if (!r.ok) return [];
    const data = await r.json();
    const list = Array.isArray(data) ? data : (data.data || data.items || []);
    _insuranceCache = list;
    console.log(`[doctoralia] ${list.length} convênios carregados`);
    return list;
  } catch (e) {
    console.warn("[doctoralia] Erro ao buscar convênios:", e.message);
    return [];
  }
}

// Resolve o insuranceId pelo nome do convênio (fuzzy match)
async function resolveInsuranceId(convenioText) {
  if (!convenioText) return null;
  const convenioNorm = norm(convenioText);

  const list = await fetchInsurances();

  if (list.length > 0) {
    // Match exato
    let m = list.find(i => norm(i.name) === convenioNorm);
    // Match parcial
    if (!m) m = list.find(i => norm(i.name).includes(convenioNorm) || convenioNorm.includes(norm(i.name)));
    // Match por palavras-chave
    if (!m) {
      const words = convenioNorm.split(/\s+/).filter(w => w.length > 3);
      m = list.find(i => words.some(w => norm(i.name).includes(w)));
    }
    if (m) {
      console.log(`[doctoralia] convênio "${convenioText}" → id=${m.id} (${m.name})`);
      return m.id;
    }
  }

  // Mapa completo com IDs reais confirmados via API (abril/2026)
  const INSURANCE_MAP = {
    "particular":                    -1,
    "amil":                        1466,
    "ampara":                      2305,
    "anafesaude":                 21275,
    "bbdental":                    3651,
    "bioral":                      6927,
    "bradescodental":              2942,
    "bradescosaude":               1471,
    "brasildental":                1549,
    "brazildental":               17288,
    "brbsaude":                    3081,
    "c6odonto":                   21293,
    "careplus":                    1504,
    "cartaoamigospass":           21090,
    "cartaobemestar":             21296,
    "cartaobeneficiar":           19859,
    "cartaodafamilia":            21081,
    "cartaodetodos":               1668,
    "dentaluni":                   1554,
    "geap":                        1482,
    "geapsaude":                   2949,
    "hapvida":                     1484,
    "inasdf":                     20723,
    "inpao":                       5421,
    "inpaodental":                 5647,
    "interodonto":                 2809,
    "ipresb":                     21117,
    "lisdental":                  11295,
    "medsenior":                   2678,
    "metlife":                     5333,
    "nossasaude":                  1643,
    "notredameintermedica":        1491,
    "notredameseguradora":         2582,
    "odont":                      21076,
    "odontolife":                  5635,
    "odontoseg":                   6946,
    "odontogroup":                10119,
    "odontolifealt":               4625, // "Odontolife" (variante)
    "odontoprev":                  1550,
    "outroreembolso":              6236,
    "reembolso":                   6236,
    "ouze":                       21306,
    "pefisaodonto":               21307,
    "pernambucanasden":           20803,
    "planassiste":                 1534,
    "planassistempf":              5410,
    "planassistempo":              5412, // MPM
    "planassistempt":              5413,
    "portoseguro":                 1495,
    "portosegurodental":           8096,
    "prevident":                   1551,
    "privianodonto":               5039,
    "quallity":                   16014,
    "quality":                    16014,
    "redebrazildental":           10969,
    "redeunna":                    5087,
    "riachueloodonto":            20804,
    "select":                     21263,
    "servir":                      8264,
    "sevvirodonto":               20805,
    "servirodonto":               20805,
    "sesi":                        5157,
    "sesisaude":                   5839,
    "simpliodonto":               21305,
    "sulamericaodonto":           12746,
    "sulamericasaude":             1500,
    "unimed":                      1502,
    "unimedodonto":                1508,
    "uniodonto":                   1553,
    "unitysaude":                 21379,
    "wdental":                    21221,
  };

  for (const [key, id] of Object.entries(INSURANCE_MAP)) {
    if (convenioNorm === key || convenioNorm.includes(key) || key.includes(convenioNorm)) {
      console.log(`[doctoralia] convênio "${convenioText}" → id=${id}`);
      return id;
    }
  }

  console.log(`[doctoralia] convênio "${convenioText}" não encontrado, usando null`);
  return null;
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

  if (!process.env.DOCTORALIA_TOKEN) {
    return res.status(503).json({
      error: "Token Doctoralia não configurado",
      hint: "Adicione DOCTORALIA_TOKEN nas variáveis de ambiente do Vercel"
    });
  }

  const { action } = req.query;

  // ── Verificar token ──────────────────────────────────────────────
  if (action === "check") {
    try {
      const r = await fetch(`${BASE_URL}/api/insurances?facilityId=${FACILITY_ID}&limit=1`, {
        headers: docHeaders(),
      });
      if (r.status === 401 || r.status === 403) {
        return res.json({ valid: false, status: r.status,
          message: "Token Doctoralia expirado. Renove o token e atualize DOCTORALIA_TOKEN no Vercel." });
      }
      return res.json({ valid: true, status: r.status });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Listar convênios disponíveis ─────────────────────────────────
  if (action === "insurances") {
    const list = await fetchInsurances();
    return res.json({ insurances: list });
  }

  // ── Criar paciente ───────────────────────────────────────────────
  if (action === "create" && req.method === "POST") {
    const body = req.body || {};
    const nome = (body.nome || body.name || "").trim();
    if (!nome) return res.status(400).json({ error: "Nome obrigatório" });

    const parts     = nome.split(" ");
    const firstName = parts[0];
    const lastName  = parts.slice(1).join(" ") || "-";

    let phone = (body.telefone || body.phone || "").replace(/\D/g, "");
    if (phone.startsWith("55") && phone.length >= 12) phone = phone.slice(2);

    // Resolve insurance ID pelo nome do convênio
    const insuranceId = await resolveInsuranceId(body.convenio || null);

    const payload = {
      firstName,
      lastName,
      phone:               phone || null,
      email:               body.email || null,
      alternatePhone:      null,
      notifyAlternatePhone: false,
      insuranceId,
      subscribedCampaigns: true,
      facilityId:          FACILITY_ID,
      scheduleId:          null,
      isPublic:            false,
      createdFrom:         1,
    };

    console.log("[doctoralia/create]", JSON.stringify({ firstName, lastName, phone, insuranceId }));

    try {
      const r = await fetch(`${BASE_URL}/api/patients`, {
        method:  "POST",
        headers: docHeaders(),
        body:    JSON.stringify(payload),
      });

      if (r.status === 401 || r.status === 403) {
        return res.status(401).json({
          error: "Token Doctoralia expirado",
          message: "Renove o token Bearer e atualize DOCTORALIA_TOKEN no Vercel.",
          tokenExpired: true,
        });
      }

      if (r.status === 201 || r.status === 200) {
        const location  = r.headers.get("location") || "";
        const patientId = location.replace(/.*\//, "");
        const url       = `${BASE_URL}/clinic/patients/${patientId}`;
        console.log(`[doctoralia/create] ✓ paciente id=${patientId} insuranceId=${insuranceId}`);
        return res.json({ ok: true, patient_id: patientId, url, location });
      }

      const errText = await r.text().catch(() => "");
      console.error(`[doctoralia/create] erro ${r.status}: ${errText.slice(0,200)}`);
      return res.status(r.status).json({
        error: `Doctoralia retornou ${r.status}`,
        detail: errText.slice(0, 300),
      });
    } catch (e) {
      console.error("[doctoralia/create]", e.message);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: `Ação desconhecida: ${action}` });
}
