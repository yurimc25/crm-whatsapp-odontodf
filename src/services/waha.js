// src/services/waha.js
const WAHA_URL = import.meta.env.VITE_WAHA_URL || "https://n8n-waha8.vxjlst.easypanel.host";
const WAHA_KEY = import.meta.env.VITE_WAHA_API_KEY || "";
const SESSION  = import.meta.env.VITE_WAHA_SESSION || "default";

const headers = () => ({
  "Content-Type": "application/json",
  "X-Api-Key": WAHA_KEY,
});

// ── Cache de fotos de perfil ──────────────────────────────────────
const PHOTO_KEY = "waha_photos";
const PHOTO_TTL = 24 * 60 * 60 * 1000; // 24h

function getPhotoCache() {
  try {
    const raw = localStorage.getItem(PHOTO_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    if (Date.now() > p.expires) { localStorage.removeItem(PHOTO_KEY); return {}; }
    return p.value || {};
  } catch { return {}; }
}

function setPhotoCache(map) {
  try {
    localStorage.setItem(PHOTO_KEY, JSON.stringify({
      value: map, expires: Date.now() + PHOTO_TTL,
    }));
  } catch {}
}

// Busca foto de perfil de um contato (com cache 24h)
export async function getProfilePicture(chatId) {
  const cache = getPhotoCache();
  if (chatId in cache) return cache[chatId]; // null = sem foto (também cacheado)

  try {
    const id = encodeURIComponent(chatId);
    const r = await fetch(
      `${WAHA_URL}/api/contacts/profile-picture?contactId=${id}&session=${SESSION}`,
      { headers: headers() }
    );
    if (!r.ok) {
      const updated = { ...cache, [chatId]: null };
      setPhotoCache(updated);
      return null;
    }
    const data = await r.json();
    const url = data?.profilePictureURL || data?.pictureUrl || data?.url || null;
    const updated = { ...cache, [chatId]: url };
    setPhotoCache(updated);
    return url;
  } catch {
    const updated = { ...cache, [chatId]: null };
    setPhotoCache(updated);
    return null;
  }
}

// ── REST ──────────────────────────────────────────────────────────

// Carrega TODOS os chats paginando até não ter mais
export async function getChats() {
  const allChats = [];
  let limit = 100;
  let offset = 0;

  while (true) {
    const r = await fetch(
      `${WAHA_URL}/api/${SESSION}/chats?limit=${limit}&offset=${offset}`,
      { headers: headers() }
    );
    if (!r.ok) throw new Error(`WAHA getChats: ${r.status}`);
    const batch = await r.json();
    if (!Array.isArray(batch) || batch.length === 0) break;
    allChats.push(...batch);
    if (batch.length < limit) break; // última página
    offset += limit;
    if (allChats.length > 1000) break; // safety
  }

  return allChats;
}

export async function getMessages(chatId, limit = 20, offset = 0) {
  const id = encodeURIComponent(chatId);
  const r = await fetch(
    `${WAHA_URL}/api/${SESSION}/chats/${id}/messages?limit=${limit}&offset=${offset}&downloadMedia=false`,
    { headers: headers() }
  );
  if (!r.ok) throw new Error(`WAHA getMessages: ${r.status}`);
  return r.json();
}

// Busca todas as mensagens disponíveis via paginação (até maxTotal)
export async function getMessagesPaged(chatId, pageSize = 60, maxTotal = 300) {
  const all = [];
  let offset = 0;
  while (all.length < maxTotal) {
    const batch = await getMessages(chatId, pageSize, offset).catch(() => []);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < pageSize) break; // última página
    offset += pageSize;
  }
  return all.slice(0, maxTotal);
}

export async function sendText(chatId, text, replyToId = null) {
  const body = { chatId, text, session: SESSION };
  if (replyToId) body.reply_to = replyToId;
  const r = await fetch(`${WAHA_URL}/api/sendText`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`WAHA sendText: ${r.status}`);
  return r.json();
}

export async function getSessionStatus() {
  const r = await fetch(`${WAHA_URL}/api/sessions/${SESSION}`, { headers: headers() });
  if (!r.ok) throw new Error(`WAHA status: ${r.status}`);
  return r.json();
}

// ── Normalização ──────────────────────────────────────────────────

// Detecta se um ID é um número de telefone válido BR ou internacional
// IDs longos sem padrão de telefone são grupos/broadcasts/status
function isValidPhoneId(id) {
  const digits = id.replace(/@.*$/, "").replace(/\D/g, "");
  // Telefone BR: 12-13 dígitos (55 + DDD + número)
  // Internacional: 7-15 dígitos (E.164)
  // IDs inválidos: >15 dígitos ou padrões estranhos
  if (digits.length > 15) return false;
  if (digits.length < 7)  return false;
  return true;
}

// Tenta extrair número BR válido de IDs malformados
// Ex: "5561999611055@c.us" → "5561999611055" (ok)
// Ex: "276016157200564@c.us" → provavelmente grupo, retorna null
function extractPhone(rawId) {
  const cleanId = rawId.replace(/@.*$/, "").replace(/\D/g, "");
  if (!isValidPhoneId(cleanId)) return null;
  return cleanId;
}

export function normalizeChat(wahaChat) {
  const lm = wahaChat.lastMessage
    || wahaChat.messages?.[0]
    || wahaChat.msgs?.[0]
    || null;

  const lmType   = (lm?.type || lm?._data?.type || "").toLowerCase();
  const hasMedia = lm?.hasMedia || lm?._data?.hasMedia || false;
  const mediaLabel = hasMedia
    ? (lmType.includes("image") || lmType.includes("sticker") ? "📷 Imagem"
      : lmType.includes("video") ? "🎥 Vídeo"
      : lmType.includes("audio") || lmType.includes("ptt") || lmType.includes("voice") ? "🎵 Áudio"
      : "📎 Arquivo")
    : "";
  const lastBody = lm?.body || lm?.text || lm?.content || lm?._data?.body || mediaLabel;
  const lastTs   = lm?.timestamp || lm?.t || lm?._data?.t || null;
  const cleanId  = wahaChat.id.replace(/@.*$/, "");
  const phone    = extractPhone(wahaChat.id);

  // pushname = nome público que o contato definiu no WhatsApp
  const pushname = wahaChat.name || wahaChat.pushname || wahaChat._data?.pushname || null;

  return {
    id:          wahaChat.id,
    name:        pushname || cleanId,
    pushname:    pushname,
    phone:       phone ? ("+" + phone) : (pushname || cleanId),
    isValidPhone: !!phone,
    lastMsg:     lastBody,
    lastTime:    lastTs
      ? new Date(lastTs * 1000).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" })
      : "",
    lastTs:      lastTs ? new Date(lastTs * 1000).toISOString() : null,
    unread:      wahaChat.unreadCount ?? wahaChat.unread ?? 0,
    status:      "open",
    assignedTo:  null,
    tags:        [],
    avatar:      (pushname || cleanId || "??").slice(0, 2).toUpperCase(),
    avatarColor: stringToColor(wahaChat.id),
    photoUrl:    null,
  };
}

// Normaliza ID do WAHA NOWEB para uso no /download-media
// O WAHA espera: "false_556194530566@c.us_3EB0ABC123" (sem sufixo @lid)
// Mensagens de grupo via LID chegam como: "false_120363...@g.us_3EB0..._186208...@lid"
function normalizeWahaId(raw) {
  if (!raw) return null;

  let serialized = null;

  if (typeof raw === "object") {
    // Objeto com _serialized
    if (raw._serialized) serialized = raw._serialized;
    // Objeto com key separada (ex: _data.key)
    else if (raw.remoteJid && raw.id) {
      const fromMe = raw.fromMe ? "true" : "false";
      serialized = `${fromMe}_${raw.remoteJid}_${raw.id}`;
    }
    else serialized = raw.id || null;
  } else if (typeof raw === "string") {
    serialized = raw;
  }

  if (!serialized) return null;
  if (!serialized) return null;

  // Remove segmentos do tipo `_participant@lid` que aparecem em alguns IDs.
  // Ex: "false_120363@g.us_3EB0ABC_186208@lid" -> "false_120363@g.us_3EB0ABC"
  serialized = serialized.replace(/_[^_@]+@lid\b/g, "");

  return serialized;
}

// Constrói msgId correto para /download-media a partir dos dados da mensagem
function buildMsgId(wahaMsg) {
  // Prioridade 1: _data.key tem o ID mais preciso
  const key = wahaMsg._data?.key;
  if (key?.remoteJid && key?.id) {
    const fromMe = key.fromMe ? "true" : "false";
    return `${fromMe}_${key.remoteJid}_${key.id}`;
  }
  // Prioridade 2: wahaMsg.id normalizado
  return normalizeWahaId(wahaMsg.id);
}

export function normalizeMessage(wahaMsg) {
  const body = wahaMsg.body
    || wahaMsg.text
    || wahaMsg.content
    || wahaMsg._data?.body
    || "";

  const tsRaw = wahaMsg.timestamp || wahaMsg._data?.messageTimestamp || wahaMsg.t || null;
  // Se não há timestamp real, não fabricar Date.now() — causaria mensagens antigas
  // sem data aparecendo no topo. Usa epoch 0 e será ordenada no final.
  // WAHA sempre retorna timestamp em segundos Unix; ms seria > 1e12
  const tsMs  = tsRaw ? (tsRaw > 1e12 ? tsRaw : tsRaw * 1000) : 0;
  const ts    = tsMs ? new Date(tsMs).toISOString() : null;

  // chatId = ID da conversa (sempre o contato, independente de direção)
  // Nunca usar @lid (Linked ID interno do WhatsApp — não é número de telefone real)
  // nem @s.whatsapp.net (servidor). Preferir sempre @c.us.
  const _rawJid = wahaMsg.chatId
    || (wahaMsg.key?.remoteJid?.includes("@lid") ? null : wahaMsg.key?.remoteJid)
    || (wahaMsg.fromMe ? wahaMsg.to : wahaMsg.from)
    || wahaMsg.from
    || null;
  const chatId = _rawJid?.replace(/:\d+(@\S+)?$/, ""); // remove device suffix ":3"

  // ── Detecção de mídia (NOWEB engine) ────────────────────────────
  // NOWEB: hasMedia=true, media=null, type="image", _data.message.imageMessage={...}
  const type     = wahaMsg.type || "text";
  const hasMedia = wahaMsg.hasMedia === true ||
                   ["image","video","audio","voice","document","sticker"].includes(type);

  let media = null;
  if (hasMedia) {
    // Tenta extrair de _data.message.* (NOWEB)
    const msgData = wahaMsg._data?.message || {};
    const imgMsg  = msgData.imageMessage  || {};
    const vidMsg  = msgData.videoMessage  || {};
    const audMsg  = msgData.audioMessage  || {};
    const docMsg  = msgData.documentMessage || {};
    const sticMsg = msgData.stickerMessage || {};

    // Pega o objeto certo dependendo do tipo
    const mediaData = imgMsg.mimetype  ? imgMsg
                    : vidMsg.mimetype  ? vidMsg
                    : audMsg.mimetype  ? audMsg
                    : docMsg.mimetype  ? docMsg
                    : sticMsg.mimetype ? sticMsg
                    : {};

    // Mimetype real
    const mimetype = wahaMsg.media?.mimetype
                  || mediaData.mimetype
                  || wahaMsg._data?.mimetype
                  || null;

    // Thumbnail em base64 (NOWEB retorna jpegThumbnail como Buffer)
    const thumbBuf  = mediaData.jpegThumbnail?.data || mediaData.jpegThumbnail || null;
    const thumbB64  = thumbBuf
      ? (typeof thumbBuf === "string" ? thumbBuf : btoa(String.fromCharCode(...new Uint8Array(thumbBuf))))
      : null;
    const thumbUrl  = thumbB64 ? `data:image/jpeg;base64,${thumbB64}` : null;

    // Detecta o tipo real a partir do mimetype
    const realType = mimetype?.startsWith("image/") ? "image"
                   : mimetype?.startsWith("video/") ? "video"
                   : mimetype?.startsWith("audio/") ? "audio"
                   : type;

    // Extrai URL da mídia — tenta múltiplas localizações (NOWEB pode variar)
    // Prioridade: 1) mediaData.url (imageMessage.url direto)
    //             2) mediaData.directPath (Baileys raw path)
    //             3) wahaMsg.media.url (passthrough do WAHA)
    //             4) null (usar /download-media pelo msgId como fallback)
    const directUrl = mediaData.url 
      || mediaData.directPath
      || wahaMsg.media?.url 
      || null;
    
    // Log para debug — sem URL significa que vai tentar download-media
    if (!directUrl && hasMedia) {
      console.debug(`[waha] media extracted but NO URL found for ${type} message (will retry via download-media)`, {
        msgId: normalizeWahaId(wahaMsg.id),
        mediaDataKeys: Object.keys(mediaData),
        wahaMediaKeys: Object.keys(wahaMsg.media || {}),
      });
    }
    
    const isWAUrl = directUrl?.includes("mmg.whatsapp.net") || directUrl?.includes("whatsapp.net");
    const mediaUrl = (directUrl && !isWAUrl)
      ? `/api/waha?path=${encodeURIComponent(directUrl)}`
      : null;  // null → ChatWindow vai usar /download-media pelo msgId como last resort

    // Extrai o hex curto do msgId serializado.
    // Formato grupo: "false_120363@g.us_3A1C485_186208@lid" → "3A1C485"
    // Formato direto: "false_556194@c.us_3EB0ABC" → "3EB0ABC"
    // O hex da mensagem é sempre o último segmento sem "@".
    const rawMsgId = wahaMsg.id || null;
    const shortMsgId = (() => {
      if (typeof rawMsgId !== "string" || !rawMsgId.includes("_")) return rawMsgId;
      const parts = rawMsgId.split("_");
      return [...parts].reverse().find(p => !p.includes("@")) || rawMsgId;
    })();

    media = {
      type:      realType,
      mimetype:  mimetype,
      filename:  wahaMsg.media?.filename || mediaData.fileName || mediaData.title || null,
      thumbUrl,              // miniatura base64 para exibir antes do download
      url:       mediaUrl,   // URL via proxy (com auth)
      msgId:     shortMsgId,
      hasMedia:  true,
    };
  }

  // ── Localização ─────────────────────────────────────────────────
  const locRaw = wahaMsg.location || wahaMsg._data?.message?.locationMessage || null;
  const location = locRaw ? {
    latitude:  parseFloat(locRaw.latitude  ?? locRaw.degreesLatitude  ?? 0),
    longitude: parseFloat(locRaw.longitude ?? locRaw.degreesLongitude ?? 0),
    name:    locRaw.name    || null,
    address: locRaw.address || null,
    thumbnail: locRaw.thumbnail || (locRaw.jpegThumbnail
      ? (typeof locRaw.jpegThumbnail === "string"
          ? `data:image/jpeg;base64,${locRaw.jpegThumbnail}`
          : locRaw.jpegThumbnail?.data
            ? `data:image/jpeg;base64,${btoa(String.fromCharCode(...new Uint8Array(locRaw.jpegThumbnail.data)))}`
            : null)
      : null),
  } : null;

  // Reações: { [emoji]: [{ id, fromMe }] }
  const reactionsRaw = wahaMsg.reactions || wahaMsg._data?.reactions || null;
  const reactions = reactionsRaw && typeof reactionsRaw === "object" && !Array.isArray(reactionsRaw)
    ? reactionsRaw
    : null;

  // ── Mensagem citada (reply) ──────────────────────────────────────
  const rt = wahaMsg.replyTo || null;
  const replyTo = rt ? {
    id:       rt.id || null,
    body:     rt.body || "",
    hasMedia: rt.hasMedia || false,
    media:    rt.media ? {
      type:     rt.media.mimetype?.startsWith("image/") ? "image"
               : rt.media.mimetype?.startsWith("video/") ? "video"
               : rt.media.mimetype?.startsWith("audio/") ? "audio"
               : "document",
      mimetype: rt.media.mimetype || null,
      url:      rt.media.url || null,
      filename: rt.media.filename || null,
    } : null,
    participant: rt.participant || null,
  } : null;

  return {
    id:       wahaMsg.id || `tmp-${tsMs}`,
    from:     wahaMsg.fromMe ? "operator" : "patient",
    text:     body,
    time:     tsMs ? new Date(tsMs).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }) : "",
    ts,
    chatId,
    type,
    media,
    location,
    reactions,
    replyTo,
    pushname: wahaMsg.notifyName || wahaMsg._data?.notifyName || "",
    // JID de quem enviou dentro do grupo (ex: "5561999@c.us"), só existe em grupos
    senderJid: (wahaMsg.author || wahaMsg.participant || wahaMsg._data?.author || wahaMsg._data?.participant || "").replace(/:\d+@/, "@") || null,
    operator: wahaMsg.fromMe ? (wahaMsg.senderName || wahaMsg._data?.pushName || "Você") : null,
    hasPatientCard: !hasMedia && !location && detectPatientCard(body),
  };
}

function detectPatientCard(text) {
  if (!text) return false;

  // NUNCA detecta mensagens de operador/bot
  // Operador começa com "Nome do operador: mensagem longa"
  // Mas NÃO bloqueia quando a primeira linha é um label de formulário (ex: "Nome completo: João")
  const firstLine = text.split("\n")[0] || "";
  const firstColon = firstLine.indexOf(":");
  if (firstColon > 0 && firstColon < 30) {
    const beforeColon = firstLine.slice(0, firstColon).toLowerCase().trim();
    const afterColon  = firstLine.slice(firstColon + 1).trim();
    // Só bloqueia se a parte antes dos ":" NÃO for um label de formulário
    const isFormLabel = /^(nome|cpf|e-?mail|telefone|convên|convenio|nasc|data|carteirinha|whatsapp)/i.test(beforeColon);
    if (!isFormLabel && afterColon.length > 20 &&
        !RE_CPF_SIMPLE.test(afterColon) && !RE_EMAIL.test(afterColon)) {
      // Verifica se o restante da mensagem (abaixo da primeira linha) tem dados de paciente
      const restOfText = text.split("\n").slice(1).join("\n");
      if (!RE_CPF_SIMPLE.test(restOfText) && !RE_EMAIL.test(restOfText)) {
        return false; // ex: "Recepcionista: Para agendamento..."
      }
    }
  }

  const t = text.toLowerCase();

  // Formato estruturado: tem labels de formulário
  const temLabels = (t.includes("nome") || t.includes("cpf")) &&
    (t.includes("email") || t.includes("e-mail") || t.includes("telefone") ||
     t.includes("whatsapp") || t.includes("nascimento") ||
     t.includes("convênio") || t.includes("convenio") || t.includes("carteirinha"));

  if (temLabels) {
    if (isTemplateVazio(text)) return false;
    return true;
  }

  // Formato livre: dados sem labels
  const temEmail    = RE_EMAIL.test(text);
  const temCpf      = RE_CPF_FLEX.test(text);   // aceita espaços entre grupos
  const temData     = RE_DATA_FLEX.test(text);   // aceita espaços entre dia/mês/ano
  const temTelefone = RE_TELEFONE.test(text);
  const temNome     = /[A-ZÀ-Ú][a-zà-ú]+ [A-ZÀ-Ú][a-zà-ú]+/.test(text) ||
                      (text.match(/\b[A-ZÀ-Ú][a-zà-ú]{2,}\b/g) || []).length >= 2;

  const score = [temEmail, temCpf, temData, temTelefone].filter(Boolean).length;
  return temNome && score >= 2;
}

function isTemplateVazio(text) {
  const labels = ["Nome completo:","CPF:","E-mail:","Convênio","Número da carteirinha:","Telefone:","Data de nascimento:"];
  const temLabels = labels.filter(l => text.includes(l)).length >= 3;
  if (!temLabels) return false;
  const linhas = text.split("\n").map(l => l.trim()).filter(Boolean);
  const labelsFormulario = linhas.filter(l => {
    const k = (l.split(":")[0] || "").toLowerCase();
    return k.includes("nome") || k.includes("cpf") || k.includes("e-mail") ||
           k.includes("email") || k.includes("telefone") || k.includes("convênio") ||
           k.includes("nascimento") || k.includes("cartão") || k.includes("carteirinha");
  });
  if (labelsFormulario.length < 3) return false;
  const comValor = labelsFormulario.filter(l => {
    const idx = l.indexOf(":");
    if (idx === -1) return false;
    return l.slice(idx+1).trim().length > 0;
  });
  return comValor.length === 0;
}

const RE_CPF_SIMPLE = /\b\d{3}[\s.]?\d{3}[\s.]?\d{3}[-\s.]?\d{2}\b/;
// CPF com espaços entre todos os grupos: "786 054 401 63"
const RE_CPF_FLEX   = /\b\d{3}[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{2}\b/;
// Data com /, - ou espaço: "28/06/1998", "09 09 76", "09-09-1976"
const RE_DATA_FLEX  = /\b\d{1,2}[\s\/\-]\d{1,2}[\s\/\-]\d{2,4}\b/;
// Telefone BR flexível
const RE_TELEFONE   = /(?:\(?\d{2}\)?\s?)(?:9\s?\d{4}|\d{4})[\s\-]?\d{4}/;
const RE_EMAIL      = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/;

function stringToColor(str) {
  const colors = ["#0d7d62","#1a5fa8","#b56a00","#c0412c","#5b3db8","#2d7d8c"];
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

// ── Mensagens: editar / apagar / reagir ──────────────────────────

export async function deleteMessage(chatId, msgId, forEveryone = false) {
  const id  = encodeURIComponent(chatId);
  const mid = encodeURIComponent(msgId);
  const r = await fetch(`${WAHA_URL}/api/${SESSION}/chats/${id}/messages/${mid}`, {
    method: "DELETE",
    headers: headers(),
    body: JSON.stringify({ deleteMedia: true, forEveryone }),
  });
  if (!r.ok) throw new Error(`WAHA deleteMessage: ${r.status}`);
  return r.json().catch(() => ({}));
}

export async function editMessage(chatId, msgId, newText) {
  const id  = encodeURIComponent(chatId);
  const mid = encodeURIComponent(msgId);
  const r = await fetch(`${WAHA_URL}/api/${SESSION}/chats/${id}/messages/${mid}`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({ text: newText }),
  });
  if (!r.ok) throw new Error(`WAHA editMessage: ${r.status}`);
  return r.json().catch(() => ({}));
}

export async function sendReaction(chatId, msgId, reaction) {
  // WAHA precisa do ID serializado: "{fromMe}_{chatId}_{hexId}"
  // Se msgId já tem esse formato (contém "@" ou "_"), usa direto.
  // Se é só o hex (vindo do R2/webhook), constrói como mensagem recebida (fromMe=false).
  const isFullId = msgId && (msgId.includes("@") || /^(true|false)_/.test(msgId));
  const messageId = isFullId ? msgId : `false_${chatId}_${msgId}`;
  console.log("[sendReaction] chatId=", chatId, "msgId=", msgId, "→", messageId, "reaction=", reaction);
  const r = await fetch(`${WAHA_URL}/api/reaction`, {
    method: "PUT",
    headers: headers(),
    body: JSON.stringify({
      session: SESSION,
      reaction: { messageId, reaction },
    }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`WAHA sendReaction: ${r.status} ${body}`);
  }
  return r.json().catch(() => ({}));
}

// ── Envio de mídia ────────────────────────────────────────────────

// Converte File/Blob para base64 data URI
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result); // "data:image/jpeg;base64,..."
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Faz upload de um File/Blob para o R2 e retorna a URL pública
export async function uploadToR2(file, ikey) {
  const form = new FormData();
  form.append("file", file, file.name || "file");
  const res = await fetch("/api/r2-data?type=upload-binary", {
    method: "POST",
    headers: { "X-Internal-Key": ikey },
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Upload R2 falhou: ${res.status}`);
  }
  const { url } = await res.json();
  return url;
}

export async function sendImage(chatId, url, caption = "", mimetype = "image/jpeg", filename = "image.jpg") {
  const r = await fetch(`${WAHA_URL}/api/sendImage`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      session: SESSION, chatId,
      file: { url, mimetype, filename },
      caption,
    }),
  });
  if (!r.ok) throw new Error(`WAHA sendImage: ${r.status}`);
  return r.json();
}

export async function sendFile(chatId, url, filename, mimetype, caption = "") {
  const r = await fetch(`${WAHA_URL}/api/sendFile`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      session: SESSION, chatId,
      file: { url, filename, mimetype },
      caption,
    }),
  });
  if (!r.ok) {
    const errBody = await r.text().catch(() => "");
    throw new Error(`WAHA sendFile: ${r.status} — ${errBody}`);
  }
  return r.json();
}

export async function sendVideo(chatId, url, filename, caption = "") {
  const r = await fetch(`${WAHA_URL}/api/sendVideo`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      session: SESSION, chatId,
      caption,
      file: { url, mimetype: "video/mp4", filename },
      convert: false,
    }),
  });
  if (!r.ok) throw new Error(`WAHA sendVideo: ${r.status}`);
  return r.json();
}

export async function sendVoice(chatId, url) {
  const r = await fetch(`${WAHA_URL}/api/sendVoice`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      session: SESSION, chatId,
      file: { url, mimetype: "audio/ogg; codecs=opus" },
      convert: false,
    }),
  });
  if (!r.ok) throw new Error(`WAHA sendVoice: ${r.status}`);
  return r.json();
}

export async function sendSticker(chatId, base64DataUri) {
  const r = await fetch(`${WAHA_URL}/api/sendSticker`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      session: SESSION, chatId,
      file: { data: base64DataUri },
    }),
  });
  if (!r.ok) throw new Error(`WAHA sendSticker: ${r.status}`);
  return r.json();
}

export async function sendLocation(chatId, lat, lng, title = "") {
  const r = await fetch(`${WAHA_URL}/api/sendLocation`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ session: SESSION, chatId, latitude: lat, longitude: lng, title }),
  });
  if (!r.ok) throw new Error(`WAHA sendLocation: ${r.status}`);
  return r.json();
}

export async function sendContactVcard(chatId, contactName, vcard) {
  const r = await fetch(`${WAHA_URL}/api/sendContactVcard`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ session: SESSION, chatId, name: contactName, vcard }),
  });
  if (!r.ok) throw new Error(`WAHA sendContactVcard: ${r.status}`);
  return r.json();
}

// ── Contatos / LID ────────────────────────────────────────────────

export async function checkPhoneExists(phone) {
  const digits = phone.replace(/\D/g, "");
  const r = await fetch(
    `${WAHA_URL}/api/contacts/check-exists?phone=${digits}&session=${SESSION}`,
    { headers: headers() }
  );
  if (!r.ok) return { numberExists: false, chatId: null };
  return r.json().catch(() => ({ numberExists: false }));
}

export async function getAllLIDs() {
  const r = await fetch(`${WAHA_URL}/api/${SESSION}/contacts?limit=1000`, { headers: headers() });
  if (!r.ok) throw new Error(`WAHA getAllLIDs: ${r.status}`);
  return r.json();
}

export async function getContactByLID(lid) {
  const id = encodeURIComponent(lid);
  const r = await fetch(`${WAHA_URL}/api/${SESSION}/contacts/${id}`, { headers: headers() });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

// Resolve LID → telefone real via endpoint dedicado: GET /api/{session}/lids/{lid}
// Retorna { lid, pn } onde pn é o JID real (ex: "5561...@c.us")
export async function resolveLidToPhone(lid) {
  const lidOnly = lid.replace(/@lid$/, "");
  const encoded = encodeURIComponent(lidOnly);
  // Deixa erros de rede propagarem (para distinção no chamador)
  // Retorna null apenas quando o servidor responde "não encontrado" (4xx)
  const r = await fetch(`${WAHA_URL}/api/${SESSION}/lids/${encoded}`, { headers: headers() });
  if (!r.ok) return null; // 404/401/etc = LID não encontrado — sem throw
  const data = await r.json().catch(() => null);
  const pn = data?.pn || null;
  if (pn && !pn.endsWith("@lid")) return pn; // ex: "5561...@c.us"
  return null;
}

// Busca dados do contato (nome, pushname) via /api/contacts?contactId=
export async function getContactInfo(contactId) {
  const id = encodeURIComponent(contactId);
  try {
    const r = await fetch(
      `${WAHA_URL}/api/contacts?contactId=${id}&session=${SESSION}`,
      { headers: headers() }
    );
    if (!r.ok) return null;
    return r.json().catch(() => null);
  } catch { return null; }
}

// Busca nome de grupo via /api/{session}/groups/{groupId} (retorna campo "subject")
export async function getGroupInfo(groupId) {
  const id = encodeURIComponent(groupId);
  try {
    const r = await fetch(
      `${WAHA_URL}/api/${SESSION}/groups/${id}`,
      { headers: headers() }
    );
    if (!r.ok) return null;
    return r.json().catch(() => null);
  } catch { return null; }
}

// ── Chamadas ──────────────────────────────────────────────────────

export async function rejectCall(callId) {
  const r = await fetch(`${WAHA_URL}/api/${SESSION}/calls/${callId}/reject`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ reason: "reject" }),
  });
  return r.ok;
}

// ── WebSocket ─────────────────────────────────────────────────────

export function createWAHASocket({ onMessage, onChatUpdate, onStatus, onError }) {
  const wsUrl = WAHA_URL.replace(/^http/, "ws");
  // message.any = enviadas e recebidas; chat.new = chats novos em tempo real
  const url = `${wsUrl}/ws?session=${SESSION}&events=message,message.any,chat.new&x-api-key=${WAHA_KEY}`;

  let ws, reconnectTimer;
  let dead = false;

  function connect() {
    if (dead) return;
    ws = new WebSocket(url);
    ws.onopen  = () => { onStatus?.("connected"); };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const { event: ev, payload } = data;

        if ((ev === "message" || ev === "message.any") && payload) {
          const msg = normalizeMessage(payload);
          if (!msg.chatId && payload.from) {
            msg.chatId = payload.from.replace(/:.*@/, "@");
          }
          onMessage?.(msg);
          return;
        }

        if (ev === "chat.new" && payload) {
          onChatUpdate?.(payload);
        }
      } catch (e) {
        console.warn("[WAHA WS] parse error", e);
      }
    };
    ws.onerror  = (e) => { onError?.(e); };
    ws.onclose  = () => {
      if (dead) return;
      onStatus?.("reconnecting");
      reconnectTimer = setTimeout(connect, 3000);
    };
  }

  connect();

  return {
    send:  (data) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(data)),
    close: () => { dead = true; clearTimeout(reconnectTimer); ws?.close(); },
    isOpen: () => ws?.readyState === WebSocket.OPEN,
  };
}