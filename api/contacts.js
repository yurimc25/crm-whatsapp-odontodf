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
  // CORS — permite apenas sua origem Vercel
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // Verifica chave interna (mesma INTERNAL_API_KEY do projeto anterior)
  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    // 1. Obtém access token usando refresh token
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

    const { access_token } = await tokenRes.json();

    // 2. Busca contatos (até 1000 — suficiente para uma clínica)
    const contactsRes = await fetch(
      "https://people.googleapis.com/v1/people/me/connections" +
      "?personFields=names,phoneNumbers&pageSize=1000&sortOrder=LAST_NAME_ASCENDING",
      { headers: { Authorization: `Bearer ${access_token}` } }
    );

    if (!contactsRes.ok) {
      const err = await contactsRes.text();
      console.error("[contacts] people API error:", err);
      return res.status(502).json({ error: "Failed to fetch contacts", detail: err });
    }

    const data = await contactsRes.json();

    // 3. Normaliza: { "5561999611055": "João Silva", ... }
    const map = {};
    for (const person of (data.connections || [])) {
      const name = person.names?.[0]?.displayName;
      if (!name) continue;
      for (const ph of (person.phoneNumbers || [])) {
        // Remove tudo que não é número
        const digits = ph.value.replace(/\D/g, "");
        // Variações: com/sem 55 (DDI Brasil), com/sem 9 extra
        const variants = makeVariants(digits);
        for (const v of variants) map[v] = name;
      }
    }

    // Cache 5 minutos via Vercel edge cache
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60");
    return res.json({ contacts: map, total: Object.keys(map).length });

  } catch (err) {
    console.error("[contacts] unexpected error:", err);
    return res.status(500).json({ error: "Internal error", detail: err.message });
  }
}

// Gera variações do número para cobrir diferentes formatos do WhatsApp
function makeVariants(digits) {
  const variants = new Set();
  const d = digits.replace(/\D/g, "");
  variants.add(d);

  // Remove DDI 55
  const local = d.startsWith("55") && d.length > 10 ? d.slice(2) : d;
  variants.add(local);
  variants.add("55" + local);

  // Remove DDD (2 dígitos) → número sem DDD
  if (local.length >= 10) {
    const semDDD = local.slice(2);
    variants.add(semDDD);

    // Com/sem 9 no celular
    if (semDDD.length === 9 && semDDD.startsWith("9")) {
      variants.add(semDDD.slice(1)); // 8 dígitos
    }
    if (semDDD.length === 8) {
      variants.add("9" + semDDD); // 9 dígitos
    }
  }

  // Com/sem 9 no local com DDD
  if (local.length === 11 && local[2] === "9") {
    const sem9 = local.slice(0, 2) + local.slice(3);
    variants.add(sem9);
    variants.add("55" + sem9);
    variants.add(sem9.slice(2));
  }
  if (local.length === 10) {
    const com9 = local.slice(0, 2) + "9" + local.slice(2);
    variants.add(com9);
    variants.add("55" + com9);
    variants.add(com9.slice(2));
  }

  // Remove 0 extra no final (bug WAHA)
  if (d.endsWith("0") && d.length > 12) {
    const sem0 = d.slice(0, -1);
    variants.add(sem0);
    const localSem0 = sem0.startsWith("55") ? sem0.slice(2) : sem0;
    variants.add(localSem0);
    variants.add(localSem0.slice(2));
  }

  return [...variants];
}
