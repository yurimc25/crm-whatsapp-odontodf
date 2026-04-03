export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "GET, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "DELETE") {
    res.setHeader("Set-Cookie", "crm_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax; Secure");
    return res.status(200).json({ ok: true });
  }

  const cookies = Object.fromEntries(
    (req.headers.cookie || "").split(";")
      .map(c => c.trim().split("="))
      .filter(([k]) => k)
      .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join("=").trim())])
  );

  const raw = cookies["crm_session"];
  if (!raw) return res.status(200).json({ ok: false });

  try {
    const { login } = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    const normalized = (login || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toUpperCase();
    const exists = !!process.env[`OPERATOR_${normalized}_PASS`];
    return res.status(200).json({ ok: exists, login: exists ? login : null });
  } catch {
    return res.status(200).json({ ok: false });
  }
}