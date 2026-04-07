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
  // NUNCA cacheia — cada número precisa de resposta fresca
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");

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
    return res.status(502).json({ error: "Failed to get Google token", detail: err });
  }
  const tokenData = await tokenRes.json();
  const access_token = tokenData.access_token;
  
  if (!access_token) {
    console.error("[contacts] no access_token in response:", tokenData);
    return res.status(502).json({ error: "No access token returned", detail: tokenData });
  }
  
  console.debug(`[contacts] token obtained successfully`);

// ── Busca individual por número ou nome ──────────────────────────
  if (req.query.action === "search") {
    const phone = (req.query.phone || "").replace(/\D/g, "");
    const name  = (req.query.q || "").trim();

    // Busca por número
    if (phone && phone.length >= 8) {
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
          const url = `https://people.googleapis.com/v1/people:searchContacts` +
            `?query=${encodeURIComponent(query)}&readMask=names,phoneNumbers&pageSize=5`;
          console.debug(`[contacts] searching by phone with query: ${query}`);
          const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
          if (!r.ok) {
            const errBody = await r.text();
            console.warn(`[contacts] search by phone query '${query}' returned ${r.status}: ${errBody.slice(0, 200)}`);
            continue;
          }
          const data = await r.json();
          console.debug(`[contacts] search by phone query '${query}' returned ${data.results?.length || 0} results`);
          for (const result of (data.results || [])) {
            const person = result.person;
            const nm   = person?.names?.[0]?.displayName;
            if (!nm) continue;
            // Verifica se algum telefone do contato bate com alguma variante
            for (const ph of (person.phoneNumbers || [])) {
              const d = ph.value.replace(/\D/g, "");
              if (variants.includes(d) || makeVariants(d).some(v => variants.includes(v))) {
                results.set(nm, makeVariants(d));
                break;
              }
            }
          }
          if (results.size > 0) break; // achou, para
        } catch (e) {
          console.error(`[contacts] search by phone error on query '${query}':`, e.message);
        }
      }

      if (results.size === 0) {
        return res.json({ found: false, name: null, variants: [] });
      }

      const [[nm, foundVariants]] = results.entries();
      console.log(`[contacts/search] phone ${phone} → ${nm}`);
      return res.json({ found: true, name: nm, variants: foundVariants });
    }

    // Busca por nome
    if (name && name.length >= 2) {
      try {
        const url = `https://people.googleapis.com/v1/people:searchContacts` +
          `?query=${encodeURIComponent(name)}&readMask=names,phoneNumbers&pageSize=10`;
        console.debug(`[contacts] searching by name: '${name}'`);
        const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
        if (!r.ok) {
          const errBody = await r.text();
          console.warn(`[contacts] search by name '${name}' returned ${r.status}: ${errBody.slice(0, 200)}`);
          return res.json({ found: false, contacts: [] });
        }
        const data = await r.json();
        console.debug(`[contacts] search by name '${name}' returned ${data.results?.length || 0} results`);
        const contacts = [];
        for (const result of (data.results || [])) {
          const person = result.person;
          const nm     = person?.names?.[0]?.displayName;
          const phones = person?.phoneNumbers || [];
          if (!nm || phones.length === 0) {
            console.debug(`[contacts] skipping result: name=${nm}, phones=${phones.length}`);
            continue;
          }
          // Retorna todos os contatos com seus telefones
          for (const ph of phones) {
            const digits = ph.value.replace(/\D/g, "");
            contacts.push({ name: nm, phone: digits });
            console.debug(`[contacts] found contact: ${nm} → ${digits}`);
          }
        }
        console.log(`[contacts/search] name "${name}" → ${contacts.length} contatos`);
        return res.json({ found: contacts.length > 0, contacts });
      } catch (e) {
        console.error("[contacts/search] error:", e.message);
        return res.json({ found: false, contacts: [] });
      }
    }

    return res.status(400).json({ error: "phone ou q obrigatório" });
  }

  // ── Busca em bulk (comportamento original) ───────────────────────
  try {
    console.debug(`[contacts] fetching all connections from Google Contacts`);
    let allConnections = [];
    let pageToken = null;

    // Pagina até 2000 contatos (2 páginas de 1000)
    do {
      const url = "https://people.googleapis.com/v1/people/me/connections" +
        `?personFields=names,phoneNumbers&pageSize=1000&sortOrder=LAST_NAME_ASCENDING` +
        (pageToken ? `&pageToken=${pageToken}` : "");
      const r = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
      if (!r.ok) {
        const errBody = await r.text();
        console.warn(`[contacts] bulk fetch page token=${pageToken || 'first'} returned ${r.status}: ${errBody.slice(0, 200)}`);
        break;
      }
      const data = await r.json();
      const connections = data.connections || [];
      console.debug(`[contacts] bulk fetch page token=${pageToken || 'first'} returned ${connections.length} connections`);
      allConnections = allConnections.concat(connections);
      pageToken = data.nextPageToken || null;
    } while (pageToken && allConnections.length < 2000);

    console.log(`[contacts] fetched ${allConnections.length} total connections`);

    const map = {};
    for (const person of allConnections) {
      const name = person.names?.[0]?.displayName;
      if (!name) continue;
      for (const ph of (person.phoneNumbers || [])) {
        const digits = ph.value.replace(/\D/g, "");
        for (const v of makeVariants(digits)) map[v] = name;
      }
    }

    // Cache no cliente por 5min, mas nunca no CDN — dados de contato mudam
    res.setHeader("Cache-Control", "private, max-age=300");
    console.log(`[contacts] bulk returning ${Object.keys(map).length} number variants mapped`);
    return res.json({ contacts: map, total: Object.keys(map).length });

  } catch (err) {
    console.error("[contacts] unexpected error:", err.message || err);
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