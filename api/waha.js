// api/waha.js — Proxy para o WAHA rodando no EasyPanel
// O browser não pode chamar o WAHA diretamente por causa de CORS.
// Este endpoint recebe as requisições do frontend e repassa ao WAHA.
// Mídia é cacheada no Cloudflare R2 para reduzir carga no WAHA.

import { r2Get, r2Put, r2KeyFromPath } from "./_r2.js";

const WAHA_URL = process.env.VITE_WAHA_URL || "";
const WAHA_KEY = process.env.VITE_WAHA_API_KEY || "";
const R2_ENABLED = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_BUCKET_NAME);

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Internal-Key");
  if (req.method === "OPTIONS") return res.status(200).end();

  const key = req.headers["x-internal-key"];
  if (key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { path: qpath, ...rest } = req.query;
  if (!qpath) return res.status(400).json({ error: "path obrigatório" });

  const params = new URLSearchParams(rest);
  // Adiciona timestamp para garantir que o WAHA nunca use cache/ETag
  params.set("_t", Date.now().toString());
  const qs = params.toString() ? `?${params.toString()}` : "";

  // Aceita que `path` seja uma URL absoluta (já retornada pelo WAHA) ou um path relativo.
  // Se for absoluta, usa diretamente; caso contrário concatena com WAHA_URL assegurando barras.
  let url;
  try {
    const raw = String(qpath);
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      url = raw + qs;
    } else {
      const base = (WAHA_URL || "").replace(/\/$/, "");
      const p = raw.startsWith("/") ? raw : ("/" + raw);
      url = `${base}${p}${qs}`;
    }
  } catch (e) {
    return res.status(400).json({ error: "path inválido" });
  }
  console.debug(`[waha-proxy] proxying to ${url}`);

  // ── R2 cache check para mídia ────────────────────────────────────
  const isMediaPath = qpath.includes("download-media") || qpath.includes("/api/files/");
  if (R2_ENABLED && req.method === "GET" && isMediaPath) {
    const r2key = r2KeyFromPath(qpath);
    const cached = await r2Get(r2key).catch(() => null);
    if (cached) {
      console.debug(`[r2] cache hit: ${r2key}`);
      res.setHeader("Content-Type", cached.contentType);
      res.setHeader("Cache-Control", "public, max-age=86400, stale-while-revalidate=3600");
      res.setHeader("X-Cache", "HIT");
      return res.status(200).end(cached.buf);
    }
    console.debug(`[r2] cache miss: ${r2key}`);
  }

  try {
    // Não força Content-Type para GET (pode ser binário). Só adiciona quando houver corpo.
    const forwardHeaders = {
      "X-Api-Key": WAHA_KEY,
      "Cache-Control": "no-cache",
      "Pragma": "no-cache",
    };
    if (!["GET", "DELETE"].includes(req.method)) forwardHeaders["Content-Type"] = "application/json";

    const wahaRes = await fetch(url, {
      method: req.method,
      headers: forwardHeaders,
      ...(req.method !== "GET" && req.method !== "DELETE" && req.body ? { body: JSON.stringify(req.body) } : {}),
    });

        // 304 = sem mudança — retorna null para o frontend manter estado anterior
    if (wahaRes.status === 304) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json(null);
    }

    const ct = wahaRes.headers.get("content-type") || "";
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

    // Sempre tenta JSON primeiro (chats, mensagens, contatos)
    if (ct.includes("application/json") || ct === "") {
      try {
        const data = await wahaRes.json();
        if (wahaRes.status >= 200 && wahaRes.status < 300) {
          return res.status(wahaRes.status).json(data);
        }
        // Encaminha erros do WAHA com o mesmo código
        if (qpath.includes("download-media") && wahaRes.status === 404) {
          console.warn(`[waha-proxy] upstream 404 on /download-media for path=${qpath} — expected for group messages, fallback to thumbnail`);
        } else {
          console.error("[waha-proxy] upstream error JSON:", wahaRes.status, data);
        }
        return res.status(wahaRes.status).json(data);
      } catch (e) {
        // Se falhou o parse de JSON, cai no texto
      }
    }

    // Mídia binária — aceita qualquer content-type não-JSON quando é download de mídia
    const isMediaDownload = qpath.includes("download-media") || qpath.includes("/api/files/");
    if (isMediaDownload ||
        ct.startsWith("image/") || ct.startsWith("video/") ||
        ct.startsWith("audio/") || ct.includes("octet-stream") ||
        ct.includes("pdf")) {
      try {
        // Se o WAHA retornou 404 para /messages/.../download-media, tentamos um fallback
        if (wahaRes.status === 404 && qpath.includes("download-media")) {
          console.warn(`[waha-proxy] upstream 404 for download-media, attempting /api/files fallback for path=${qpath}`);
          try {
            // Extrai o messageId do path: /api/{session}/messages/{msgId}/download-media
            const m = qpath.match(/messages\/(.*?)\/download-media/);
            if (m) {
              const rawId = decodeURIComponent(m[1]);
              const lastSeg = rawId.split("_").pop();
              const fileId = String(lastSeg || "").replace(/@lid\b/g, "");
              const waBase = WAHA_URL.replace(/\/$/, "");
              const candidates = [
                `${waBase}/api/files/default/${fileId}.jpeg`,
                `${waBase}/api/files/default/${fileId}.jpg`,
                `${waBase}/api/files/default/${fileId}`,
                `${waBase}/api/files/${SESSION}/${fileId}.jpeg`,
                `${waBase}/api/files/${SESSION}/${fileId}`,
              ];
              for (const c of candidates) {
                try {
                  console.debug(`[waha-proxy] trying fallback URL ${c}`);
                  const fr = await fetch(c, { headers: forwardHeaders });
                  if (fr.ok) {
                    const buf = await fr.arrayBuffer();
                    const ctype = fr.headers.get("content-type") || "application/octet-stream";
                    const fbBuf = Buffer.from(buf);
                    if (R2_ENABLED) {
                      const r2key = r2KeyFromPath(qpath);
                      r2Put(r2key, fbBuf, ctype).catch(() => {});
                    }
                    res.setHeader("Content-Type", ctype);
                    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
                    return res.status(200).end(fbBuf);
                  } else {
                    const txt = await fr.text().catch(() => "");
                    console.debug(`[waha-proxy] fallback ${c} returned ${fr.status}: ${txt.slice ? txt.slice(0,200) : txt}`);
                  }
                } catch (e) {
                  console.debug(`[waha-proxy] fallback ${c} error:`, e.message || e);
                }
              }
            }
          } catch (e) {
            console.error('[waha-proxy] fallback error', e.message || e);
          }
        }

        const buf = await wahaRes.arrayBuffer();
        if (buf.byteLength === 0) {
          return res.status(404).json({ error: "Mídia vazia ou não encontrada" });
        }
        const finalCt = ct || "application/octet-stream";
        const finalBuf = Buffer.from(buf);
        // Armazena no R2 em background (fire-and-forget)
        if (R2_ENABLED && req.method === "GET") {
          const r2key = r2KeyFromPath(qpath);
          r2Put(r2key, finalBuf, finalCt).catch(() => {});
        }
        res.setHeader("Content-Type", finalCt);
        res.setHeader("X-Cache", "MISS");
        return res.status(wahaRes.status || 200).end(finalBuf);
      } catch (e) {
        console.error("[waha-proxy] binary error:", e.message || e);
        return res.status(502).json({ error: "Erro ao baixar mídia" });
      }
    }

    // Texto genérico
    const text = await wahaRes.text();
    if (wahaRes.status >= 200 && wahaRes.status < 300) return res.status(wahaRes.status).send(text);
    console.error("[waha-proxy] upstream text error:", wahaRes.status, text.slice ? text.slice(0,300) : text);
    return res.status(wahaRes.status).send(text);
  } catch (e) {
    console.error("[waha-proxy]", e.message);
    return res.status(500).json({ error: e.message });
  }
}