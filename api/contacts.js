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

  try {
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
      return res.status(502).json({ error: "Failed to get Google token", detail: err });
    }

    const { access_token } = await tokenRes.json();

    // Busca todos os contatos com paginação
    let allConnections = [];
    let nextPageToken = undefined;

    do {
      const url = new URL("https://people.googleapis.com/v1/people/me/connections");
      url.searchParams.set("personFields", "names,phoneNumbers");
      url.searchParams.set("pageSize", "1000");
      if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);

      const r = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${access_token}` }
      });

      if (!r.ok) {
        const err = await r.text();
        return res.status(502).json({ error: "Failed to fetch contacts", detail: err });
      }

      const data = await r.json();
      allConnections = allConnections.concat(data.connections || []);
      nextPageToken = data.nextPageToken;

    } while (nextPageToken);

    // Monta mapa de variantes
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
    return res.status(500).json({ error: "Internal error", detail: err.message });
  }
}

function makeVariants(digits) {
  const variants = new Set();
  const d = digits.replace(/\D/g, "");
  variants.add(d);

  const local = d.startsWith("55") && d.length > 10 ? d.slice(2) : d;
  variants.add(local);
  variants.add("55" + local);

  if (local.length >= 10) {
    const ddd = local.slice(0, 2);
    const num = local.slice(2);
    variants.add(num);

    if (num.length === 9 && num.startsWith("9")) {
      const sem9 = num.slice(1);
      variants.add(sem9);
      variants.add(ddd + sem9);
      variants.add("55" + ddd + sem9);
    }

    if (num.length === 8) {
      const com9 = "9" + num;
      variants.add(com9);
      variants.add(ddd + com9);
      variants.add("55" + ddd + com9);
      variants.add(ddd + num);
      variants.add("55" + ddd + num);
    }
  }

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

  return [...variants];
}