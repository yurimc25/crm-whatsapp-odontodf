// api/push.js — Gerencia subscriptions Web Push e envia notificações
const { MongoClient } = require('mongodb');

let _client;
async function getDb() {
  if (!_client || !_client.topology?.isConnected?.()) {
    _client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 3 });
    await _client.connect();
  }
  return _client.db(process.env.MONGODB_DB || 'codental_monitor');
}

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@odontodf.com.br';
const INTERNAL_KEY  = process.env.INTERNAL_API_KEY;

// ── Web Push manual (sem dependência externa) ────────────────────
// Usa crypto nativo do Node.js para assinar JWT VAPID e cifrar payload
async function sendWebPush(subscription, payload) {
  const { endpoint, keys } = subscription;
  const { p256dh, auth } = keys;

  // Import das chaves
  const crypto = require('crypto');
  const { webcrypto } = crypto;
  const subtle = webcrypto.subtle;

  // ── 1. Monta JWT VAPID ──────────────────────────────────────────
  const audience = new URL(endpoint).origin;
  const header  = Buffer.from(JSON.stringify({ typ:'JWT', alg:'ES256' })).toString('base64url');
  const claim   = Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now()/1000) + 12*3600,
    sub: VAPID_SUBJECT,
  })).toString('base64url');

  // Importa chave privada VAPID
  const privDer = Buffer.from(VAPID_PRIVATE, 'base64url');
  const privKey = await subtle.importKey('pkcs8', privDer,
    { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']);

  const sigInput = Buffer.from(`${header}.${claim}`);
  const sigBuf   = await subtle.sign({ name:'ECDSA', hash:'SHA-256' }, privKey, sigInput);
  const jwt      = `${header}.${claim}.${Buffer.from(sigBuf).toString('base64url')}`;

  // ── 2. Cifra payload com ECDH-ES + AES-128-GCM ─────────────────
  const serverKeyPair = await subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveKey']);
  const serverPubRaw  = Buffer.from(await subtle.exportKey('raw', serverKeyPair.publicKey));

  const clientPubRaw  = Buffer.from(p256dh, 'base64url');
  const clientPubKey  = await subtle.importKey('raw', clientPubRaw, { name:'ECDH', namedCurve:'P-256' }, false, []);

  const authSecret = Buffer.from(auth, 'base64url');
  const salt       = crypto.randomBytes(16);

  // PRK via HKDF
  const ikm = await subtle.deriveKey(
    { name:'ECDH', public: clientPubKey },
    serverKeyPair.privateKey,
    { name:'HKDF', hash:'SHA-256', salt: authSecret, info: Buffer.from('Content-Encoding: auth\0') },
    false, ['deriveKey']
  );

  // Cifra
  const payloadBuf = Buffer.from(JSON.stringify(payload));
  const paddedLen  = payloadBuf.length + 2;
  const padded     = Buffer.alloc(paddedLen);
  padded.writeUInt16BE(0, 0);
  payloadBuf.copy(padded, 2);

  const cekInfo   = Buffer.from('Content-Encoding: aesgcm\0');
  const nonceInfo = Buffer.from('Content-Encoding: nonce\0');

  async function hkdfExpand(prk, info, len) {
    const key = await subtle.importKey('raw', prk, { name:'HKDF' }, false, ['deriveBits']);
    const bits = await subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt: new Uint8Array(32), info }, key, len*8);
    return Buffer.from(bits);
  }

  const context = Buffer.concat([
    Buffer.from('P-256\0'),
    Buffer.alloc(2), Buffer.from([clientPubRaw.length]), clientPubRaw,
    Buffer.alloc(2), Buffer.from([serverPubRaw.length]), serverPubRaw,
  ]);

  const prkKey  = await subtle.exportKey('raw', ikm);
  const prk2    = await hkdfExpand(Buffer.from(prkKey), Buffer.concat([cekInfo, context]), 16);
  const nonce   = await hkdfExpand(Buffer.from(prkKey), Buffer.concat([nonceInfo, context]), 12);
  const encKey  = await subtle.importKey('raw', prk2, { name:'AES-GCM' }, false, ['encrypt']);
  const encBuf  = Buffer.from(await subtle.encrypt({ name:'AES-GCM', iv: nonce }, encKey, padded));

  // ── 3. HTTP request para o push service ────────────────────────
  const body = Buffer.concat([salt, Buffer.from([0,0,16,0]), Buffer.from([serverPubRaw.length]), serverPubRaw, encBuf]);
  const pubB64 = Buffer.from(await subtle.exportKey('raw', serverKeyPair.publicKey)).toString('base64url');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization':  `vapid t=${jwt},k=${VAPID_PUBLIC}`,
      'Content-Type':   'application/octet-stream',
      'Content-Encoding': 'aesgcm',
      'Encryption':     `salt=${salt.toString('base64url')}`,
      'Crypto-Key':     `dh=${pubB64};p256ecdsa=${VAPID_PUBLIC}`,
      'TTL':            '86400',
    },
    body,
  });
  return res.status;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Internal-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = req.headers['x-internal-key'] || req.body?.key;
  if (key !== INTERNAL_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const db  = await getDb();
  const col = db.collection('push_subscriptions');
  const { action } = req.query;

  // ── Salva subscription ──────────────────────────────────────────
  if (req.method === 'POST' && action === 'subscribe') {
    const { subscription, operatorLogin } = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'subscription required' });
    await col.updateOne(
      { endpoint: subscription.endpoint },
      { $set: { subscription, operatorLogin: operatorLogin || 'unknown', updatedAt: new Date() } },
      { upsert: true }
    );
    console.log(`[push] subscribed: ${operatorLogin} → ${subscription.endpoint.slice(0,60)}`);
    return res.json({ ok: true });
  }

  // ── Remove subscription ─────────────────────────────────────────
  if (req.method === 'POST' && action === 'unsubscribe') {
    const { endpoint } = req.body;
    await col.deleteOne({ endpoint });
    return res.json({ ok: true });
  }

  // ── Envia notificação (chamado pelo webhook do WAHA) ────────────
  if (req.method === 'POST' && action === 'notify') {
    const { chatId, title, body: msgBody, url } = req.body;
    const subs = await col.find({}).toArray();
    const payload = { chatId, title, body: msgBody, url: url || '/' };
    const results = await Promise.allSettled(
      subs.map(async s => {
        try {
          const status = await sendWebPush(s.subscription, payload);
          if (status === 410 || status === 404) {
            // Subscription expirada — remove
            await col.deleteOne({ _id: s._id });
            console.log(`[push] removed expired subscription for ${s.operatorLogin}`);
          }
          return status;
        } catch(e) {
          console.error(`[push] error sending to ${s.operatorLogin}:`, e.message);
        }
      })
    );
    console.log(`[push] notified ${subs.length} subscribers for chat ${chatId}`);
    return res.json({ ok: true, sent: subs.length });
  }

  // ── Lista subscriptions ─────────────────────────────────────────
  if (req.method === 'GET' && action === 'list') {
    const subs = await col.find({}, { projection: { operatorLogin:1, updatedAt:1, 'subscription.endpoint':1 } }).toArray();
    return res.json({ subscriptions: subs });
  }

  return res.status(404).json({ error: 'Unknown action' });
};
