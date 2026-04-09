// api/_r2.js — Cloudflare R2 helper (S3-compatible, sem SDK)
// Env vars necessárias:
//   R2_ACCOUNT_ID       – ID da conta Cloudflare (32 chars hex)
//   R2_ACCESS_KEY_ID    – Access Key ID do token R2
//   R2_SECRET_ACCESS_KEY– Secret do token R2
//   R2_BUCKET_NAME      – Nome do bucket (ex: "crm-media")

import { createHmac, createHash } from "node:crypto";

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}
function sha256hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function getSigningKey(secret, dateStamp, region, service) {
  return hmac(
    hmac(hmac(hmac("AWS4" + secret, dateStamp), region), service),
    "aws4_request"
  );
}

async function r2Request(method, key, body = null, extraHeaders = {}) {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secretKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket    = process.env.R2_BUCKET_NAME;

  if (!accountId || !accessKey || !secretKey || !bucket) return null;

  const region  = "auto";
  const service = "s3";
  const host    = `${accountId}.r2.cloudflarestorage.com`;

  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[-:]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);

  const bodyBuf  = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body)) : Buffer.alloc(0);
  const bodyHash = sha256hex(bodyBuf);

  // Canonical headers (must be sorted lowercase)
  const rawHeaders = {
    "content-type":          extraHeaders["content-type"] || "application/octet-stream",
    "host":                  host,
    "x-amz-content-sha256":  bodyHash,
    "x-amz-date":            amzDate,
  };
  if (body) rawHeaders["content-length"] = String(bodyBuf.byteLength);

  const sortedKeys      = Object.keys(rawHeaders).sort();
  const canonicalHdr    = sortedKeys.map(k => `${k}:${rawHeaders[k]}`).join("\n") + "\n";
  const signedHeaderStr = sortedKeys.join(";");

  const canonicalReq = [
    method,
    `/${bucket}/${key}`,
    "", // no query string
    canonicalHdr,
    signedHeaderStr,
    bodyHash,
  ].join("\n");

  const credScope    = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credScope, sha256hex(canonicalReq)].join("\n");
  const signingKey   = getSigningKey(secretKey, dateStamp, region, service);
  const signature    = hmac(signingKey, stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeaderStr}, Signature=${signature}`;

  // Build fetch headers (remove "host" — browser/Node adds it automatically)
  const fetchHeaders = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (k !== "host") fetchHeaders[k] = v;
  }
  fetchHeaders["Authorization"] = authorization;

  return fetch(`https://${host}/${bucket}/${key}`, {
    method,
    headers: fetchHeaders,
    ...(body ? { body: bodyBuf } : {}),
  });
}

/**
 * Tenta buscar objeto do R2.
 * @returns {{ buf: Buffer, contentType: string } | null}
 */
export async function r2Get(key) {
  try {
    const res = await r2Request("GET", key);
    if (!res || !res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    return { buf, contentType };
  } catch (e) {
    console.warn("[r2] get error:", e.message);
    return null;
  }
}

/**
 * Armazena objeto no R2.  Fire-and-forget — erros são apenas logados.
 */
export async function r2Put(key, buf, contentType) {
  try {
    const res = await r2Request("PUT", key, buf, { "content-type": contentType });
    if (res && !res.ok) {
      const txt = await res.text().catch(() => "");
      console.warn(`[r2] put ${key} returned ${res.status}: ${txt.slice(0, 200)}`);
    }
  } catch (e) {
    console.warn("[r2] put error:", e.message);
  }
}

/**
 * Gera uma chave de cache a partir do path da requisição.
 * Ex: "/api/default/messages/true_5561...@c.us_ABCdef123/download-media" → "media/ABCdef123"
 *     "/api/files/default/ABCdef123.jpeg"                                 → "media/ABCdef123.jpeg"
 */
export function r2KeyFromPath(rawPath) {
  const p = String(rawPath || "");

  // download-media: extrai o msgId (último segmento antes de /download-media)
  const m = p.match(/messages\/(.*?)\/download-media/);
  if (m) {
    const msgId   = decodeURIComponent(m[1]);
    const lastSeg = msgId.split("_").pop().replace(/@lid\b/g, "");
    return `media/${lastSeg}`;
  }

  // /api/files/{session}/{fileId[.ext]}
  const f = p.match(/\/api\/files\/[^/]+\/([^?#]+)/);
  if (f) return `media/${f[1]}`;

  // Fallback: hash do path completo
  return `media/${sha256hex(p).slice(0, 32)}`;
}
