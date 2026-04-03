// scripts/sync-contacts.js
// Roda no GitHub Actions — busca TODOS os contatos do Google e salva no MongoDB
// Sem limite de tempo, suporta 30k+ contatos

import { MongoClient } from "mongodb";

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();
const db = client.db("clinica");

// Obtém access token
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
const { access_token } = await tokenRes.json();

// Busca todos com paginação
let allConnections = [];
let nextPageToken;
let page = 0;

do {
  page++;
  const url = new URL("https://people.googleapis.com/v1/people/me/connections");
  url.searchParams.set("personFields", "names,phoneNumbers");
  url.searchParams.set("pageSize", "1000");
  if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);

  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${access_token}` }
  });
  const data = await r.json();
  allConnections = allConnections.concat(data.connections || []);
  nextPageToken = data.nextPageToken;
  console.log(`Página ${page}: ${allConnections.length} contatos até agora`);
} while (nextPageToken);

// Monta mapa de variantes (mesma lógica do api/contacts.js)
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

const map = {};
for (const person of allConnections) {
  const name = person.names?.[0]?.displayName;
  if (!name) continue;
  for (const ph of (person.phoneNumbers || [])) {
    const digits = ph.value.replace(/\D/g, "");
    for (const v of makeVariants(digits)) map[v] = name;
  }
}

// Salva no MongoDB
await db.collection("cache").updateOne(
  { _id: "google_contacts" },
  { $set: {
    contacts: map,
    cachedAt: new Date(),
    expiresAt: new Date(Date.now() + 25 * 60 * 60 * 1000), // 25h
    total: Object.keys(map).length,
  }},
  { upsert: true }
);

console.log(`✅ ${Object.keys(map).length} variantes de ${allConnections.length} contatos salvos no MongoDB`);
await client.close();