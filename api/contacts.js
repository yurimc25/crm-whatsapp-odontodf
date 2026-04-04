// api/contacts.js
// Vercel Serverless Function — proxy para Google People API
// Mantém o refresh_token seguro no servidor, nunca exposto ao browser
//
// Variáveis necessárias no Vercel:
//   GOOGLE_CLIENT_ID
//   GOOGLE_CLIENT_SECRET
//   GOOGLE_REFRESH_TOKEN
//
// Como obter o refresh token: veja /scripts/google-auth.md

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

  // Obtém access token (comum a todas as ações)
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type:    "refresh_token",
    }),
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    console.error("[contacts] token error:", err);
    return res.status(502).json({ error: "Failed to get Google token" });
  }
  const { access_token } = await tokenRes.json();

// ── Busca individual por número ──────────────────────────────────
  if (req.query.action === "search") {
    const phone = (req.query.phone || "").replace(/\D/g, "");
    if (!phone) return res.status(400).json({ error: "phone obrigatório" });

    const variants = makeVariants(phone);

    // Cria um Set de queries para buscar na API do Google
    // Isso garante que ele tente achar tanto (61) 98141-1141 quanto (61) 8141-1141
    const searchQueries = new Set();
    variants.forEach(v => {
      searchQueries.add(v);
      searchQueries.add(formatForSearch(v));
    });

    const results = new Map();

    for (const query of searchQueries) {
      try {
        const r = await fetch(
          `https://people.googleapis.com/v1/people:searchContacts` +
          `?query=${encodeURIComponent(query)}&readMask=names,phoneNumbers&pageSize=5`,
          { headers: { Authorization: `Bearer ${access_token}` } }
        );
        if (!r.ok) continue;
        const data = await r.json();
        for (const result of (data.results || [])) {
          const person = result.person;
          const name   = person?.names?.[0]?.displayName;
          if (!name) continue;
          // Verifica se algum telefone do contato bate com alguma variante
          for (const ph of (person.phoneNumbers || [])) {
            const d = ph.value.replace(/\D/g, "");
            if (variants.includes(d) || makeVariants(d).some(v => variants.includes(v))) {
              results.set(name, makeVariants(d));
              break;
            }
          }
        }
        if (results.size > 0) break; // achou, para
      } catch {}
    }

    if (results.size === 0) {
      return res.json({ found: false, name: null, variants: [] });
    }

    const [[name, foundVariants]] = results.entries();
    console.log(`[contacts/search] ${phone} → ${name}`);
    return res.json({ found: true, name, variants: foundVariants });
  }

  // ── Busca em bulk (comportamento original) ───────────────────────
  try {
    let allConnections = [];
    let pageToken = null;

    // Pagina até 2000 contatos (2 páginas de 1000)
    do {
      const url = "https://people.googleapis.com/v1/people/me/connections" +
        `?personFields=names,phoneNumbers&pageSize=1000&sortOrder=LAST_NAME_ASCENDING` +
        (pageToken ? `&pageToken=${pageToken}` : "");
      const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
      if (!r.ok) break;
      const data = await r.json();
      allConnections = allConnections.concat(data.connections || []);
      pageToken = data.nextPageToken || null;
    } while (pageToken && allConnections.length < 2000);

    const map = {};
    for (const person of allConnections) {
      const name = person.names?.[0]?.displayName;
      if (!name) continue;
      for (const ph of (person.phoneNumbers || [])) {
        const digits = ph.value.replace(/\D/g, "");
        for (const v of makeVariants(digits)) map[v] = name;
      }
    }

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    return res.json({ contacts: map, total: Object.keys(map).length });

  } catch (err) {
    console.error("[contacts] unexpected error:", err);
    return res.status(500).json({ error: "Internal error", detail: err.message });
  }
}

// Formata número para busca legível (ex: "(61) 98141-1141")
function formatForSearch(digits) {
  const d = digits.startsWith("55") ? digits.slice(2) : digits;
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return digits;
}

// Gera variações do número para cobrir todos os formatos do WhatsApp
function makeVariants(digits) {
  const variants = new Set();
  const d = digits.replace(/\D/g, "");
  variants.add(d);

  // Isola o número local (sem 55)
  const isBR = d.startsWith("55") && d.length >= 12;
  const local = isBR ? d.slice(2) : d;

  if (local.length >= 10) {
    variants.add(local);
    variants.add("55" + local);

    // Lida com o 9º dígito
    if (local.length === 11 && local[2] === "9") {
      // Tem o 9: gera a versão sem o 9
      const sem9 = local.slice(0, 2) + local.slice(3);
      variants.add(sem9);
      variants.add("55" + sem9); // O bug estava aqui: faltava essa linha
    } else if (local.length === 10) {
      // Não tem o 9: gera a versão com o 9
      const com9 = local.slice(0, 2) + "9" + local.slice(2);
      variants.add(com9);
      variants.add("55" + com9);
    }
  }

  return [...variants];
}