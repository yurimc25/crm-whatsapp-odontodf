// api/auth.js
// Valida login + senha dos operadores
// Senhas ficam APENAS nas variáveis de ambiente do Vercel — nunca no código
//
// Variáveis no Vercel (uma por operador):
//   OPERATOR_YURI_PASS=senha123
//   OPERATOR_ANA_PASS=senha456
//   OPERATOR_PATRICIA_PASS=senha789
//   OPERATOR_BOT_PASS=  (deixe vazio — bot não faz login)
//
// Formato: OPERATOR_{LOGIN_UPPERCASE}_PASS

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { login, password } = req.body || {};

  if (!login || !password) {
    return res.status(400).json({ error: "Login e senha obrigatórios" });
  }

  const envKey = `OPERATOR_${login.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_PASS`;
  const expectedPass = process.env[envKey];

  if (!expectedPass) {
    // Operador não existe
    return res.status(401).json({ error: "Operador não encontrado" });
  }

  if (password !== expectedPass) {
    return res.status(401).json({ error: "Senha incorreta" });
  }

  // Retorna dados do operador (sem a senha)
  // Os dados de display ficam no frontend — aqui só validamos a credencial
  return res.status(200).json({ ok: true, login: login.toLowerCase() });
}
