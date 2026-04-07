// api/webhook.js — Recebe eventos do WAHA e dispara push notifications
const { MongoClient } = require('mongodb');

let _client;
async function getDb() {
  if (!_client || !_client.topology?.isConnected?.()) {
    _client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 3 });
    await _client.connect();
  }
  return _client.db(process.env.MONGODB_DB || 'codental_monitor');
}

const INTERNAL_KEY = process.env.INTERNAL_API_KEY;
const BASE_URL     = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : process.env.NEXT_PUBLIC_BASE_URL || 'https://crm-whatsapp-odontodf.vercel.app';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Verifica autenticação — WAHA deve enviar X-Api-Key ou um token
  const wahaKey = req.headers['x-api-key'] || req.headers['authorization'];
  // Aceita qualquer request do WAHA (o endpoint não é público)
  // Para segurança adicional, configure o WAHA com o mesmo INTERNAL_KEY

  const event = req.body;
  if (!event) return res.status(400).end();

  const eventType = event.event || event.type;
  console.log(`[webhook] event=${eventType} session=${event.session}`);

  // Só processa mensagens novas recebidas (não enviadas por nós)
  if (eventType !== 'message' && eventType !== 'message.any') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  const payload = event.payload || event;
  // Ignora mensagens enviadas por nós
  if (payload.fromMe === true || payload.from_me === true) {
    return res.status(200).json({ ok: true, skipped: 'fromMe' });
  }

  const chatId   = payload.chatId || payload.from || payload.chat_id;
  const body     = payload.body || payload.text || payload.content || '';
  const pushName = payload.notifyName || payload.pushName || payload._data?.pushName || 'Cliente';

  if (!chatId || !body) return res.status(200).json({ ok: true, skipped: 'no body' });

  // Busca contato salvo no MongoDB para exibir nome correto
  let displayName = pushName;
  try {
    const db = await getDb();
    const contact = await db.collection('contacts').findOne({
      $or: [{ chatId }, { phone: chatId.replace('@c.us','').replace('@s.whatsapp.net','') }]
    });
    if (contact?.name) displayName = contact.name;
  } catch {}

  // Dispara push para todos os subscribers
  try {
    const notifyRes = await fetch(`${BASE_URL}/api/push?action=notify`, {
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'X-Internal-Key': INTERNAL_KEY,
      },
      body: JSON.stringify({
        chatId,
        title: `📩 ${displayName}`,
        body:  body.length > 100 ? body.slice(0, 97) + '...' : body,
        url:   '/',
      }),
    });
    const result = await notifyRes.json();
    console.log(`[webhook] push sent: ${result.sent} subscribers`);
  } catch(e) {
    console.error('[webhook] push error:', e.message);
  }

  return res.status(200).json({ ok: true });
};
