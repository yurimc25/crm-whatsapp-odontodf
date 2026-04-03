// api/session.js
// Verifica se o cookie crm_session é válido
// GET  /api/session → { ok: true, login: "yuri" } ou { ok: false }
// DELETE /api/session → faz logout limpando o cookie

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();

  // Logout
  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", "crm_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure");
    return res.status(200).json({ ok: true });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  // Lê o cookie
  const cookies = parseCookies(req.headers.cookie || "");
  const raw = cookies["crm_session"];

  if (!raw) return res.status(200).json({ ok: false });

  try {
    const { login } = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (!login) return res.status(200).json({ ok: false });

    // Valida que o operador ainda existe (variável de ambiente)
    const normalized = login
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "")
      .toUpperCase();

    const envKey = `OPERATOR_${normalized}_PASS`;
    const exists = !!process.env[envKey];

    if (!exists) return res.status(200).json({ ok: false });

    return res.status(200).json({ ok: true, login });
  } catch {
    return res.status(200).json({ ok: false });
  }
}

function parseCookies(cookieHeader) {
  const result = {};
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) result[key.trim()] = decodeURIComponent(rest.join("=").trim());
  }
  return result;
}
