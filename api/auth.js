// api/auth.js
// Valida login + senha e seta cookie HttpOnly de 30 dias
// Senhas: OPERATOR_{LOGIN_MAIUSCULO}_PASS no Vercel

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { login, password } = req.body || {};

  if (!login || !password) {
    return res.status(400).json({ error: "Login e senha obrigatórios" });
  }

  const normalized = login
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toUpperCase();

  const envKey = `OPERATOR_${normalized}_PASS`;
  const expectedPass = process.env[envKey];

  // Debug: loga qual variável está tentando encontrar (remover em produção)
  console.log(`[auth] login="${login}" normalized="${normalized}" key="${envKey}" found=${!!expectedPass}`);

  if (!expectedPass) {
    return res.status(401).json({ error: "Operador não encontrado" });
  }

  if (password !== expectedPass) {
    return res.status(401).json({ error: "Senha incorreta" });
  }

  // Seta cookie HttpOnly de 30 dias
  // HttpOnly = JavaScript não consegue ler (mais seguro)
  // SameSite=Lax = funciona em navegação normal
  const TRINTA_DIAS = 60 * 60 * 24 * 30;
  const cookieValue = Buffer.from(JSON.stringify({ login: login.trim() })).toString("base64");

  res.setHeader("Set-Cookie", [
    `crm_session=${cookieValue}; Max-Age=${TRINTA_DIAS}; Path=/; HttpOnly; SameSite=Lax; Secure`,
  ]);

  return res.status(200).json({ ok: true, login: login.trim() });
}
