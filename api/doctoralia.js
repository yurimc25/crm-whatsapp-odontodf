// api/doctoralia.js — Integração com Doctoralia/DocPlanner API
// Token Bearer com auto-refresh via credenciais quando expira.
// Env vars necessárias:
//   DOCTORALIA_TOKEN   — token inicial (fallback caso R2 ainda não tenha)
//   DOCTORALIA_EMAIL   — email de login da clínica no Doctoralia
//   DOCTORALIA_PASSWORD— senha de login

import { MongoClient } from "mongodb";

const BASE_URL    = "https://docplanner.doctoralia.com.br";
const FACILITY_ID = 311940;

// Cache em memória (dura enquanto a lambda está quente)
let _insuranceCache = null;
let _tokenCache     = null;
let _mongoClient    = null;

async function getDb() {
  if (!_mongoClient) {
    _mongoClient = new MongoClient(process.env.MONGODB_URI);
    await _mongoClient.connect();
  }
  return _mongoClient.db("clinica");
}

// ── Gerenciamento de token ────────────────────────────────────────

async function getToken() {
  // 1. Cache em memória
  if (_tokenCache) return _tokenCache;

  // 2. MongoDB
  try {
    const db  = await getDb();
    const doc = await db.collection("config").findOne({ _id: "doctoralia_token" });
    if (doc?.token) {
      _tokenCache = doc.token;
      return doc.token;
    }
  } catch (e) {
    console.warn("[doctoralia] Erro ao ler token do MongoDB:", e.message);
  }

  // 3. Fallback: env var do Vercel
  return process.env.DOCTORALIA_TOKEN || "";
}

async function saveToken(token) {
  _tokenCache = token;
  try {
    const db = await getDb();
    await db.collection("config").updateOne(
      { _id: "doctoralia_token" },
      { $set: { token, savedAt: new Date() } },
      { upsert: true }
    );
    console.log("[doctoralia] Token salvo no MongoDB.");
  } catch (e) {
    console.warn("[doctoralia] Erro ao salvar token no MongoDB:", e.message);
  }
}

async function loginAndRefreshToken() {
  const email    = process.env.DOCTORALIA_EMAIL;
  const password = process.env.DOCTORALIA_PASSWORD;
  if (!email || !password) {
    throw new Error("DOCTORALIA_EMAIL e DOCTORALIA_PASSWORD não configurados no Vercel");
  }

  console.log("[doctoralia] Token expirado — fazendo login para renovar...");

  const r = await fetch(`${BASE_URL}/api/auth`, {
    method:  "POST",
    headers: {
      "accept":          "application/json, text/plain, */*",
      "accept-language": "pt-BR,pt;q=0.9",
      "content-type":    "application/json",
      "origin":          BASE_URL,
      "referer":         `${BASE_URL}/`,
      "x-country-id":    "BR",
      "x-user-type":     "medicalcenter",
      "user-agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    },
    body: JSON.stringify({ login: email, password }),
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Login Doctoralia falhou (${r.status}): ${txt.slice(0, 200)}`);
  }

  const data = await r.json();
  // O token pode vir em data.token, data.access_token ou header Authorization
  const newToken = data.token || data.access_token || data.authToken || data.bearer;
  if (!newToken) {
    console.warn("[doctoralia] Resposta do login:", JSON.stringify(data).slice(0, 300));
    throw new Error("Login OK mas token não encontrado na resposta — verifique o campo retornado");
  }

  await saveToken(newToken);
  console.log("[doctoralia] Token renovado com sucesso.");
  return newToken;
}

// ── Headers com token atual ───────────────────────────────────────

async function docHeaders() {
  const token = await getToken();
  return {
    "accept":          "application/json, text/plain, */*",
    "accept-language": "pt-BR,pt;q=0.9",
    "authorization":   `bearer ${token}`,
    "content-type":    "application/json",
    "origin":          BASE_URL,
    "referer":         `${BASE_URL}/`,
    "x-clinic-size":   "0-10",
    "x-country-id":    "BR",
    "x-user-type":     "medicalcenter",
    "user-agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
  };
}

// ── Fetch com auto-retry após refresh de token ────────────────────

async function docFetch(url, options = {}, retried = false) {
  const headers = await docHeaders();
  const r = await fetch(url, { ...options, headers: { ...headers, ...(options.headers || {}) } });

  if ((r.status === 401 || r.status === 403) && !retried) {
    // Limpa cache e tenta renovar token
    _tokenCache = null;
    const newToken = await loginAndRefreshToken();
    // Retry com novo token
    return docFetch(url, options, true);
  }

  return r;
}

// Normaliza string para comparação fuzzy
function norm(s) {
  return (s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

// Mapa de status de agendamento
const APPOINTMENT_STATUS = {
  0: "Agendado",
  1: "Canc. clínica",
  2: "Canc. paciente",
  3: "Não confirmado",
  4: "Confirmado",
  6: "Conf. Doctoralia",
};

// Mapa de tipo de evento
const EVENT_TYPE = {
  1: "Bloqueio",
  2: "Consulta",
};

// Faz POST /api/calendarevents para um intervalo de datas
// schedules: [] = todos os dentistas
async function fetchCalendarEvents(dateFrom, dateTo, schedules = []) {
  const r = await docFetch(`${BASE_URL}/api/calendarevents`, {
    method: "POST",
    body:   JSON.stringify({ from: dateFrom, to: `${dateTo}T23:59:59`, schedules }),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    const err = new Error(`Doctoralia retornou ${r.status}: ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }

  return r.json();
}

// Busca todos os convênios da clínica no Doctoralia
async function fetchInsurances() {
  if (_insuranceCache) return _insuranceCache;
  try {
    const r = await docFetch(`${BASE_URL}/api/insurances?facilityId=${FACILITY_ID}`);
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
    "odontolifealt":               4625,
    "odontoprev":                  1550,
    "outroreembolso":              6236,
    "reembolso":                   6236,
    "ouze":                       21306,
    "pefisaodonto":               21307,
    "pernambucanasden":           20803,
    "planassiste":                 1534,
    "planassistempf":              5410,
    "planassistempo":              5412,
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

  const { action } = req.query;

  // ── Salvar token (chamado pela extensão Chrome) ──────────────────
  // POST /api/doctoralia?action=token
  // Header: X-Internal-Key
  // Body: { token: "bearer xxx..." }
  if (action === "token" && req.method === "POST") {
    const { token } = req.body || {};
    if (!token || typeof token !== "string" || token.length < 20) {
      return res.status(400).json({ error: "token inválido" });
    }
    _tokenCache = null; // limpa cache para usar o novo
    await saveToken(token.replace(/^bearer\s+/i, "").trim());
    return res.status(200).json({ ok: true });
  }

  // ── Verificar/renovar token ──────────────────────────────────────
  if (action === "check") {
    try {
      const r = await docFetch(`${BASE_URL}/api/insurances?facilityId=${FACILITY_ID}&limit=1`);
      return res.json({ valid: r.ok, status: r.status });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Listar convênios disponíveis ─────────────────────────────────
  if (action === "insurances") {
    const list = await fetchInsurances();
    return res.json({ insurances: list });
  }

  // ── Dentistas que trabalham em uma data ──────────────────────────
  // GET /api/doctoralia?action=doctors_by_date&date=2026-04-08
  // Retorna: [{ scheduleId, doctorId, name, color, workPeriods }]
  if (action === "doctors_by_date") {
    const date = req.query.date; // YYYY-MM-DD
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Parâmetro 'date' obrigatório no formato YYYY-MM-DD" });
    }

    try {
      const data = await fetchCalendarEvents(date, date);

      // workperiods: [{ scheduleId, start, end, isPrivate }]
      // Filtra apenas os períodos que começam no date informado
      const workperiods = (data.workperiods || []).filter(wp => wp.start.startsWith(date));

      // scheduleIds únicos que trabalham nesse dia
      const activeScheduleIds = [...new Set(workperiods.map(wp => wp.scheduleId))];

      const schedules = data.schedules || {};

      const doctors = activeScheduleIds.map(scheduleId => {
        const sched = schedules[scheduleId] || {};
        // Períodos de trabalho do dentista nesse dia
        const periods = workperiods
          .filter(wp => wp.scheduleId === scheduleId)
          .map(wp => ({
            start: wp.start.slice(11, 16), // "08:00"
            end:   wp.end.slice(11, 16),   // "12:00"
          }));

        return {
          scheduleId,
          doctorId:   sched.doctorId || null,
          name:       sched.name     || sched.displayName || `Agenda ${scheduleId}`,
          color:      (data.colorSchemas?.[sched.colorSchemaId]?.baseColor) || null,
          workPeriods: periods,
        };
      });

      doctors.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

      console.log(`[doctoralia/doctors_by_date] date=${date} → ${doctors.length} dentistas`);
      return res.json({ date, doctors });
    } catch (e) {
      if (false) { /* TOKEN_EXPIRED handled automatically via docFetch retry */ }
      console.error("[doctoralia/doctors_by_date]", e.message);
      return res.status(e.status || 500).json({ error: e.message });
    }
  }

  // ── Agenda de um dentista em uma data ────────────────────────────
  // GET /api/doctoralia?action=agenda&date=2026-04-08&scheduleId=301217
  // Retorna: { doctor, date, appointments: [{ id, start, end, patientName, patientPhone, service, insurance, status, statusLabel, comments }] }
  if (action === "agenda") {
    const date       = req.query.date;       // YYYY-MM-DD
    const scheduleId = req.query.scheduleId; // número

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: "Parâmetro 'date' obrigatório no formato YYYY-MM-DD" });
    }
    if (!scheduleId) {
      return res.status(400).json({ error: "Parâmetro 'scheduleId' obrigatório" });
    }

    const schedIdNum = parseInt(scheduleId, 10);

    try {
      const data = await fetchCalendarEvents(date, date);

      const schedules = data.schedules || {};
      const sched     = schedules[schedIdNum] || {};

      // Filtra agendamentos do dentista nesse dia (exclui bloqueios eventType=1)
      const appointments = (data.appointments || [])
        .filter(a =>
          a.scheduleId === schedIdNum &&
          a.start.startsWith(date) &&
          a.isBlock === false
        )
        .map(a => {
          // O título vem como "Nome Completo CPF" — separa o nome do CPF
          const titleParts   = (a.title || "").trim().split(/\s+/);
          const cpfIndex     = titleParts.findIndex(p => /^\d{3}\./.test(p) || /^\d{9,11}$/.test(p.replace(/\D/,"")));
          const patientName  = cpfIndex > 0
            ? titleParts.slice(0, cpfIndex).join(" ")
            : (a.title || "").trim();

          return {
            id:           a.id,
            start:        a.start.slice(11, 16), // "09:45"
            end:          a.end.slice(11, 16),
            patientName,
            patientPhone: a.patientPhone || null,
            patientId:    a.patientId    || null,
            service:      a.serviceName  || null,
            insurance:    a.insuranceName || null,
            status:       a.status,
            statusLabel:  APPOINTMENT_STATUS[a.status] ?? `Status ${a.status}`,
            eventType:    a.eventType,
            comments:     a.comments     || null,
          };
        });

      // Ordena por horário
      appointments.sort((a, b) => a.start.localeCompare(b.start));

      console.log(`[doctoralia/agenda] date=${date} scheduleId=${schedIdNum} → ${appointments.length} consultas`);
      return res.json({
        date,
        scheduleId: schedIdNum,
        doctor:     sched.name || sched.displayName || `Agenda ${schedIdNum}`,
        appointments,
      });
    } catch (e) {
      if (false) { /* TOKEN_EXPIRED handled automatically via docFetch retry */ }
      console.error("[doctoralia/agenda]", e.message);
      return res.status(e.status || 500).json({ error: e.message });
    }
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
      const r = await docFetch(`${BASE_URL}/api/patients`, {
        method: "POST",
        body:   JSON.stringify(payload),
      });

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