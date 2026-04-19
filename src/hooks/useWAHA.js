// src/hooks/useWAHA.js
// Estratégia de carregamento otimista:
// 1. ChatList: carrega lista de chats (sem mensagens) → exibe imediatamente
// 2. Por chat: busca só última mensagem (1 req/chat em lotes de 5) → atualiza preview
// 3. ChatWindow: só carrega 60 msgs ao clicar → pagina 10 dias ao subir
// 4. WebSocket: recebe msgs novas em tempo real independente
// 5. Base local (cache) sempre consultada primeiro — MongoDB como fallback entre sessões

import { useState, useEffect, useCallback, useRef } from "react";
import { useContactsCtx } from "../App";
import {
  sendText, getSessionStatus,
  normalizeMessage, extractPhone, stringToColor,
  deleteMessage as wahaDeleteMessage, editMessage as wahaEditMessage,
} from "../services/waha";
import { MOCK_CHATS, MOCK_MESSAGES } from "../data/mock";

// Ordena mensagens — estável por timestamp real, nunca usa índice de array como critério primário
function tsToNum(ts) {
  if (!ts) return 0;
  const n = new Date(ts).getTime();
  return isNaN(n) ? 0 : n;
}
function sortMsgs(msgs) {
  return msgs.map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ta = tsToNum(a.m.ts);
      const tb = tsToNum(b.m.ts);
      if (ta !== tb) return ta - tb;
      // Mesmo segundo: usa o ID como desempate (IDs do WAHA têm sufixo hex cronológico)
      if (a.m.id && b.m.id && !a.m.id.startsWith("tmp-") && !b.m.id.startsWith("tmp-")) {
        return a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0;
      }
      return a.i - b.i;
    })
    .map(({ m }) => m);
}

// Remove tmp duplicados ao confirmar mensagem real
function removeTmp(current, incoming) {
  const realIds          = new Set(incoming.map(m => m.id));
  const realFromMeTexts  = new Set(incoming.filter(m => m.from === "operator").map(m => m.text?.trim()));
  return current.filter(m => {
    if (!m.id.startsWith("tmp-")) return true;
    if (realIds.has(m.id)) return false;
    if (realFromMeTexts.has(m.text?.trim())) return false;
    return true;
  });
}

// Converte mensagem do R2 (formato webhook) para formato do app

function normalizeR2Message(m) {
  const tsMs = typeof m.ts === "number" ? m.ts : (m.ts ? new Date(m.ts).getTime() : 0);
  const t = (m.type || "").toLowerCase();
  const hasMedia = ["image","video","audio","voice","document","sticker","ptt"].includes(t);
  // Extrai short hex msgId do ID serializado (ex: "false_556@c.us_3EB0ABC" → "3EB0ABC")
  const shortMsgId = (() => {
    const raw = m.id;
    if (typeof raw !== "string" || !raw.includes("_")) return raw;
    const parts = raw.split("_");
    return [...parts].reverse().find(p => !p.includes("@")) || raw;
  })();
  // Reconstrói objeto media mínimo para que MediaContent consiga buscar do WAHA via msgId
  const media = hasMedia ? {
    msgId:    shortMsgId,
    type:     t,
    mimetype: t === "ptt" || t === "voice" ? "audio/ogg" :
              t === "image"  ? "image/jpeg" :
              t === "sticker"? "image/webp" :
              t === "video"  ? "video/mp4"  :
              t === "document" ? "application/octet-stream" : null,
    url:      m.mediaUrl || null,
    thumbUrl: null,
  } : null;
  return {
    id:       m.id,
    chatId:   m.chatId,
    from:     m.fromMe ? "operator" : "patient",
    text:     m.body || "",  // sem label duplicado — MediaContent já exibe o player
    type:     m.type  || "chat",
    ts:       tsMs ? new Date(tsMs).toISOString() : null,
    time:     tsMs ? new Date(tsMs).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }) : "",
    hasMedia,
    media,
  };
}

const USE_MOCK    = import.meta.env.VITE_USE_MOCK === "true";
const CHATS_KEY      = "waha_chats";
const CHATS_TTL      = 30 * 24 * 60 * 60 * 1000; // 30 dias

const _sessionMsgs = new Map(); // chatId → Message[] (in-memory, perde no F5)

// Cache de mensagens no localStorage — persiste no F5, máx 15 chats × 60 msgs
const MSGS_CACHE_KEY    = "crm_msgs_cache_v1";   // { order: string[], data: {[chatId]: msg[]} }
const MSGS_CACHE_MAX    = 15;  // chats armazenados
const MSGS_CACHE_LIMIT  = 60;  // msgs por chat
function _readMsgsCache() {
  try { return JSON.parse(localStorage.getItem(MSGS_CACHE_KEY) || "null") || { order: [], data: {} }; } catch { return { order: [], data: {} }; }
}
function _writeMsgsCache(cache) {
  try { localStorage.setItem(MSGS_CACHE_KEY, JSON.stringify(cache)); } catch {}
}
function _cacheMsgs(chatId, msgs) {
  try {
    const cache = _readMsgsCache();
    // Guarda campos leves — media só com metadados (sem blob/base64)
    cache.data[chatId] = msgs.slice(-MSGS_CACHE_LIMIT).map(m => {
      const slim = {
        id: m.id, chatId: m.chatId, from: m.from, text: m.text,
        type: m.type, ts: m.ts, time: m.time, hasMedia: m.hasMedia,
        fromMe: m.fromMe, pushname: m.pushname,
      };
      if (m.media && m.hasMedia) {
        slim.media = { msgId: m.media.msgId, type: m.media.type, mimetype: m.media.mimetype, thumbUrl: null, url: null };
      }
      return slim;
    });
    cache.order = [chatId, ...(cache.order || []).filter(id => id !== chatId)].slice(0, MSGS_CACHE_MAX);
    // Evicta chats antigos
    for (const id of Object.keys(cache.data)) {
      if (!cache.order.includes(id)) delete cache.data[id];
    }
    _writeMsgsCache(cache);
  } catch {}
}
function _getCachedMsgs(chatId) {
  try { return _readMsgsCache().data[chatId] || null; } catch { return null; }
}

// Dedup global de handleMsg — evita duplo incremento de unread quando
// PartyKit + polling processam a mesma mensagem
const _handledMsgIds = new Set();

// Cache de resolução LID → JID (@c.us) — sobrevive re-renders, não sobrevive F5
// Quando WhatsApp usa @lid (Linked ID), precisamos mapear para o número real
const _lidToJid  = new Map(); // lid@lid → 55...@c.us
const _lidFailed = new Set(); // LIDs onde resolução falhou esta sessão (não tenta de novo)

// Chats apagados pelo operador — persiste em localStorage
// Só volta a aparecer se chegar nova mensagem
const _deletedChats = new Set();
try {
  const raw = localStorage.getItem("crm_deleted");
  if (raw) JSON.parse(raw).forEach(id => _deletedChats.add(id));
  console.log(`[init] _deletedChats: ${_deletedChats.size} IDs apagados`);
} catch {}
function persistDeletedChats() {
  try { localStorage.setItem("crm_deleted", JSON.stringify([..._deletedChats])); } catch {}
}

// Valida se um chatId pode aparecer no chatlist
// @s.whatsapp.net = servidor WhatsApp, nunca um contato real
// @lid = Linked ID — pode ser o ÚNICO identificador válido para contatos migrados → aceitar
function _isValidChatId(id) {
  if (!id) return false;
  if (id.endsWith("@s.whatsapp.net")) return false;
  return true;
}

// Versão mais estrita para NOVOS chats adicionados por fontes externas (R2, polling)
// Ainda rejeita @lid e >13 dígitos @c.us (phantom de resolução incorreta)
function _isValidNewChatId(id) {
  if (!id) return false;
  if (id.endsWith("@s.whatsapp.net")) return false;
  if (id.endsWith("@lid")) return false;
  if (!id.endsWith("@g.us")) {
    const digits = id.replace(/\D/g, "");
    if (digits.length > 13) return false;
  }
  return true;
}

// Deduplica lista de chats por tail-8 de telefone, filtrando apagados e IDs inválidos
// Mesma lógica usada em loadChats — centralizada aqui para reutilização
function _dedupeChats(chats) {
  const deduped = [];
  const seen8   = new Map(); // tail-8 → índice em deduped
  let _skipDel = 0, _skipInv = 0, _skipMerge = 0;
  for (const chat of chats) {
    if (_deletedChats.has(chat.id)) { _skipDel++; continue; }
    if (!_isValidChatId(chat.id))   { _skipInv++; continue; }
    const digits = chat.id.replace(/\D/g, "");
    const tail8  = digits.length >= 8 ? digits.slice(-8) : null;
    if (!tail8) { deduped.push(chat); continue; }
    const existIdx = seen8.get(tail8);
    if (existIdx === undefined) {
      seen8.set(tail8, deduped.length);
      deduped.push(chat);
    } else {
      _skipMerge++;
      const ex    = deduped[existIdx];
      const exTs  = ex.lastTs  ? new Date(ex.lastTs).getTime()   : 0;
      const newTs = chat.lastTs ? new Date(chat.lastTs).getTime() : 0;
      // Prefere @lid (alimentado pelo webhook/R2 em tempo real) sobre @c.us (lista WAHA)
      const lidId  = ex.id.endsWith("@lid") ? ex.id : (chat.id.endsWith("@lid") ? chat.id : null);
      const cusId  = ex.id.endsWith("@c.us") ? ex.id : (chat.id.endsWith("@c.us") ? chat.id : null);
      const bestId = lidId || cusId || ex.id;
      // Para dados do chat, prioriza o @lid (tem lastMsg/lastTs mais recentes via webhook)
      const lidChat = ex.id.endsWith("@lid") ? ex : (chat.id.endsWith("@lid") ? chat : null);
      const base    = lidChat || (newTs > exTs ? chat : ex);
      deduped[existIdx] = {
        ...base,
        id:            bestId,
        photoUrl:      ex.photoUrl   || chat.photoUrl,
        unread:        Math.max(ex.unread || 0, chat.unread || 0),
        lastPatientTs: ex.lastPatientTs || chat.lastPatientTs,
        pushname:      ex.pushname   || chat.pushname,
        status:        ex.status !== "resolved" ? ex.status : chat.status,
      };
    }
  }
  console.log(`[dedup] entrada=${chats.length} saída=${deduped.length} apagados=${_skipDel} inválidos=${_skipInv} mesclados=${_skipMerge}`);
  return deduped;
}

// Limpeza única na inicialização: remove chaves antigas de mensagens/imagens do localStorage
// (versões anteriores gravavam msgs lá; agora só usamos memória → libera espaço para os chats)
try {
  Object.keys(localStorage)
    .filter(k =>
      k.startsWith("crm_waha_msgs_") ||
      k.startsWith("crm_img_") ||
      // versões antigas do cache de fotos (v1/v2/v3)
      /^waha_photos_v[123]$/.test(k)
    )
    .forEach(k => localStorage.removeItem(k));
} catch {}

const LAST_SYNC_KEY  = "waha_last_sync_ts";       // timestamp da última sync bem-sucedida
const ikey           = () => import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";

// ── Chave canônica por dígitos de telefone ──────────────────────────────────
// Grupos (@g.us) mantêm o chatId como chave — não têm número de telefone
// Contatos (@c.us, @lid, etc.) usam apenas os dígitos do número
function canonicalKey(chatId, lidPhoneCache) {
  if (!chatId) return chatId;
  if (chatId.endsWith("@g.us")) return chatId;
  if (chatId.endsWith("@lid")) {
    const lidOnly = chatId.replace(/@lid$/, "");
    const phone = lidPhoneCache?.[lidOnly]?.phone;
    if (phone) return phone.replace(/\D/g, "");
    // Sem resolução ainda: usa os dígitos do próprio LID como fallback
    return chatId.replace(/\D/g, "") || chatId;
  }
  return chatId.replace(/\D/g, "") || chatId;
}

// ── Overrides manuais de status/leitura — sobrevivem ao reload ──────────────
// Estrutura: { [phoneDigitsOrGroupId]: { resolvedAt?, readAt? } }
// resolvedAt: timestamp quando o operador resolveu manualmente
// readAt: timestamp quando o operador marcou como lido (R2 não sobrescreve se lastPatientTs <= readAt)
const OVERRIDE_KEY = "crm_status_overrides";
function readOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDE_KEY) || "{}"); } catch { return {}; }
}
function saveOverride(chatId, patch) {
  try {
    const key = canonicalKey(chatId, readLidPhoneMap());
    const cur = readOverrides();
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ ...cur, [key]: { ...(cur[key] || {}), ...patch } }));
  } catch {}
}
function clearOverride(chatId) {
  try {
    const key = canonicalKey(chatId, readLidPhoneMap());
    const cur = readOverrides();
    delete cur[key];
    localStorage.setItem(OVERRIDE_KEY, JSON.stringify(cur));
  } catch {}
}

// Lê lid_phone_map do localStorage para bridge LID→phone em loadChats
function readLidPhoneMap() {
  try { return JSON.parse(localStorage.getItem("lid_phone_map") || "{}"); } catch { return {}; }
}

// Grava resolução LID→phone no localStorage (lid_phone_map) para compartilhar com useContacts
function _saveLidResolution(lidFull, jid, pushName) {
  const lidOnly = lidFull.replace(/@lid$/, "");
  if (!lidOnly) return;
  const phone = jid ? jid.replace(/@.*$/, "").replace(/\D/g, "") : null;
  if (!phone && !pushName) return;
  try {
    const map = readLidPhoneMap();
    if (map[lidOnly]?.phone && map[lidOnly].phone === phone) return; // já salvo
    map[lidOnly] = { phone: phone || null, pushName: pushName || map[lidOnly]?.pushName || null };
    localStorage.setItem("lid_phone_map", JSON.stringify(map));
    console.log(`[lid] cache gravado: ${lidOnly} → ${phone || "?"} (${pushName || "sem nome"})`);
  } catch {}
}

// Resolve um @lid para o JID @c.us real.
// Estratégia (em ordem):
//   1. Cache (_lidToJid) — resultado anterior
//   2. API de contatos do WAHA (tenta obter JID e nome)
//   3. Busca por pushname no chatlist atual (_sessionChats)
// Falhas ficam em _lidFailed para evitar chamadas repetidas.
// Quando resolve, também grava em lid_phone_map (localStorage) para useContacts.
async function resolveLid(lid, pushname) {
  if (_lidToJid.has(lid)) return _lidToJid.get(lid);
  if (_lidFailed.has(lid)) {
    // Se agora temos pushname, tenta match mesmo assim
    if (!pushname) return null;
  } else {
    // Tenta API de contatos do WAHA
    try {
      const SESSION = import.meta.env.VITE_WAHA_SESSION || "default";
      const encodedLid = encodeURIComponent(lid);
      const r = await fetch(
        `/api/waha?path=${encodeURIComponent(`/api/${SESSION}/contacts?contactId=${encodedLid}`)}`,
        { headers: { "X-Internal-Key": ikey() } }
      );
      if (r.ok) {
        const data = await r.json();
        const contact = Array.isArray(data) ? data[0] : data;
        const jid = contact?.id || contact?.phone || null;
        const name = contact?.name || contact?.pushname || contact?.pushName || null;
        if (jid && !jid.endsWith("@lid") && !jid.endsWith("@s.whatsapp.net")) {
          _lidToJid.set(lid, jid);
          _saveLidResolution(lid, jid, pushname || name);
          console.log(`[lid] resolvido via API: ${lid} → ${jid}`);
          return jid;
        }
        // API retornou mas só tem nome (sem JID @c.us) — salva o nome mesmo assim
        if (name) _saveLidResolution(lid, null, name);
      }
    } catch {}
  }

  // Fallback 1: busca pelo pushname no chatlist atual
  if (pushname && _sessionChats.value?.length) {
    const pn = pushname.trim().toLowerCase();
    const match = _sessionChats.value.find(c =>
      c.pushname && c.pushname.trim().toLowerCase() === pn
    );
    if (match && !match.id.endsWith("@lid")) {
      console.log(`[lid] resolvido por pushname "${pushname}": ${lid} → ${match.id}`);
      _lidToJid.set(lid, match.id);
      _lidFailed.delete(lid);
      _saveLidResolution(lid, match.id, pushname);
      return match.id;
    }
  }

  // Fallback 2: LID pode ter sido armazenado como @c.us com os mesmos dígitos (phantom antigo)
  if (_sessionChats.value?.length) {
    const lidDigits = lid.replace(/\D/g, "");
    const phantom = _sessionChats.value.find(c =>
      !c.id.endsWith("@lid") && c.id.replace(/\D/g, "") === lidDigits
    );
    if (phantom) {
      console.log(`[lid] resolvido por phantom ID: ${lid} → ${phantom.id}`);
      _lidToJid.set(lid, phantom.id);
      _lidFailed.delete(lid);
      _saveLidResolution(lid, phantom.id, pushname || phantom.pushname);
      return phantom.id;
    }
  }

  // Salva o pushname mesmo sem JID, para exibir nome enquanto aguarda resolução real
  if (pushname) _saveLidResolution(lid, null, pushname);

  // Marca como falha para não repetir chamada API (mas permite nova tentativa com pushname)
  _lidFailed.add(lid);
  if (_lidFailed.size > 200) _lidFailed.delete([..._lidFailed][0]);
  return null;
}

function getLastSyncTs() {
  try { return parseInt(localStorage.getItem(LAST_SYNC_KEY) || "0"); } catch { return 0; }
}
function markLastSync() {
  try { localStorage.setItem(LAST_SYNC_KEY, String(Date.now())); } catch {}
}

// Cache em memória para a sessão atual (sobrevive re-renders, não sobrevive F5)
const _sessionChats = { value: null, expires: 0 };

// Persiste chats no localStorage usando apenas campos essenciais (slim)
// Evita quota exceeded — mensagens ficam só na memória (React state)
function persistChats(chats) {
  // 1. Sessão: guarda objetos completos para acesso rápido sem F5
  _sessionChats.value = chats;
  _sessionChats.expires = Date.now() + CHATS_TTL;

  // 2. localStorage: slim — só o necessário para remontar o chatlist após F5
  // Normaliza @lid → phone@c.us para que após F5 o ID seja estável e prevMap funcione
  const lidCache = readLidPhoneMap();
  const slim = chats.map(c => {
    let id = c.id;
    if (id.endsWith("@lid")) {
      const lidOnly = id.replace(/@lid$/, "");
      const phone = lidCache[lidOnly]?.phone;
      if (phone) id = phone.replace(/\D/g, "") + "@c.us";
    }
    return {
      id,
      name:          c.name          || c.pushname || "",
      pushname:      c.pushname      || "",
      lastMsg:       c.lastMsg       || "",
      lastTs:        c.lastTs        || null,
      lastPatientTs: c.lastPatientTs || null,
      unread:        c.unread        || 0,
      status:        c.status        || "open",
      assignedTo:    c.assignedTo    || null,
      tags:          c.tags          || [],
      // photoUrl omitido do slim — já está no waha_photos_v4; reduz ~100KB com 300 chats
    };
  });
  const payload = JSON.stringify({ value: slim, expires: Date.now() + CHATS_TTL });
  try {
    localStorage.setItem("crm_" + CHATS_KEY, payload);
  } catch {
    // Quota exceeded — libera caches reconstruíveis e tenta de novo
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith("waha_photos") || k.startsWith("crm_waha_msgs_") || k.startsWith("crm_img_"))
        .forEach(k => { try { localStorage.removeItem(k); } catch {} });
      localStorage.setItem("crm_" + CHATS_KEY, payload);
    } catch {}
  }
}

// Padrões de despedida: correspondem somente a mensagens curtas sem pedidos
const FAREWELL_PATTERNS = [
  /^(ok|okay|oks|okey)[\s!.,]*$/i,
  /^obrigad/i,
  /^agradeç/i,
  /^igualmente[\s!.]*$/i,
  /^disponha/i,
  /^excelente dia/i,
  /^(até logo|até mais|até amanhã|até breve)[\s!.]*$/i,
  /^(tchau|xau|xao|bi|bye)[\s!]*$/i,
  /^(flw|vlw|falou)[\s!]*$/i,
  /^(disponha|confirm|agendada)[!.\s🌙☀️🙏😊]*$/i,
];
// Palavras que indicam pedido/pergunta — impede classificação como despedida
const REQUEST_WORDS = /avise|avisa|lembre|confirme|gostaria|quero|preciso|pode(ria)?|consegue|horário|agenda|consulta|compromisso|tenho |posso |não (posso|consigo|vou)\b/i;

function isFarewell(text) {
  if (!text) return false;
  const t = text.trim();
  if (t.length > 80) return false;             // mensagens longas não são despedidas
  if (/\?/.test(t)) return false;              // perguntas não são despedidas
  if (REQUEST_WORDS.test(t)) return false;     // pedidos/informações não são despedidas
  return FAREWELL_PATTERNS.some(p => p.test(t));
}

// Calcula lastPatientTs a partir do histórico de mensagens (ordem cronológica)
// null = operador respondeu por último, ou despedida nas últimas 2 msgs do paciente
// ts   = último paciente que precisa de resposta
function computeLastPatientTs(msgs) {
  const patientMsgs = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.from === "operator") {
      if (patientMsgs.length === 0) return null; // operador respondeu por último
      break;
    }
    if (m.from === "patient") {
      patientMsgs.push(m);
      if (patientMsgs.length >= 2) break;
    }
  }
  if (patientMsgs.length === 0) return null;
  // Se qualquer uma das últimas 2 mensagens do paciente for despedida → sem timer
  if (patientMsgs.some(m => isFarewell(m.text))) return null;
  return patientMsgs[0].ts; // ts da msg mais recente do paciente
}

// Mensagens de operador que indicam encerramento da conversa
function isOperatorClosing(text) {
  if (!text) return false;
  const t = text.trim();
  // Detecta mensagem de confirmação de consulta (com ou sem endereço/link)
  return /^Consulta confirmada[!.]?/i.test(t);
}

// Verifica se o lastMsg do chat indica encerramento (operador ou despedida do paciente)
function lastMsgIsClosing(lastMsg) {
  if (!lastMsg) return false;
  const t = lastMsg.trim();
  return isOperatorClosing(t) || isFarewell(t);
}


export function useWAHA(operator) {
  const [chats,    setChats]    = useState(() => {
    // 1. Sessão atual (re-render sem F5) — objetos completos
    if (_sessionChats.value?.length && Date.now() < _sessionChats.expires) {
      return _sessionChats.value;
    }
    // 2. localStorage — versão slim (suficiente para exibir o chatlist imediatamente)
    try {
      const raw = localStorage.getItem("crm_" + CHATS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.value?.length && Date.now() < parsed.expires) return parsed.value;
      }
    } catch {}
    return [];
  });
  const [messages,    setMessages]    = useState({});
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState(null);
  const [wsStatus,    setWsStatus]    = useState("disconnected");
  const [sessionOk,   setSessionOk]   = useState(false);
  const [mutedChats,  setMutedChats]  = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("crm_muted") || "[]")); }
    catch { return new Set(); }
  });
  const [myJid, setMyJid] = useState(() => {
    try { return localStorage.getItem("crm_my_jid") || null; } catch { return null; }
  });

  const activeChatRef   = useRef(null);
  const socketRef       = useRef(null);
  const wsConnected     = useRef(false);
  const handleMsgRef    = useRef(null);   // compartilhado entre PartyKit e polling
  const seenMsgIds      = useRef({});     // chatId → Set<id> — dedup fora de state updater
  const mutedChatsRef   = useRef(mutedChats);
  useEffect(() => { mutedChatsRef.current = mutedChats; }, [mutedChats]);
  const { lookupPhone, lookupPhonePriority, resolveName, displayName, lidPhoneMap, resolveLidAsync, resolveGroupAsync: _resolveGroupAsync } = useContactsCtx();
  const lidPhoneMapRef2 = useRef(lidPhoneMap);
  useEffect(() => { lidPhoneMapRef2.current = lidPhoneMap; }, [lidPhoneMap]);
  const displayNameRef = useRef(displayName);
  useEffect(() => { displayNameRef.current = displayName; }, [displayName]);
  const resolveLidAsyncRef = useRef(resolveLidAsync);
  useEffect(() => { resolveLidAsyncRef.current = resolveLidAsync; }, [resolveLidAsync]);
  const lookupPhoneRef = useRef(lookupPhone);
  useEffect(() => { lookupPhoneRef.current = lookupPhone; }, [lookupPhone]);
  const resolveGroupAsyncRef = useRef(_resolveGroupAsync);
  useEffect(() => { resolveGroupAsyncRef.current = _resolveGroupAsync; }, [_resolveGroupAsync]);

  const perms = { verTodos: operator?.role === "gerente" || operator?.role === "admin" };

  // ── 1. Sessão ────────────────────────────────────────────────
  useEffect(() => {
    if (USE_MOCK) { setSessionOk(true); return; }
    async function checkSession() {
      try {
        const s = await getSessionStatus();
        setSessionOk(s.status === "WORKING" || s.status === "CONNECTED");
        if (s.me?.id) {
          setMyJid(s.me.id);
          try { localStorage.setItem("crm_my_jid", s.me.id); } catch {}
        }
        setError(null);
      } catch {
        setSessionOk(false);
        setError("WAHA offline — verifique a sessão");
      }
    }
    checkSession();
    const iv = setInterval(checkSession, 30000);
    return () => clearInterval(iv);
  }, []);

  // ── 2. Carrega lista de chats ─────────────────────────────────
  // Estratégia: cache local → R2 (webhook data) → WAHA completo
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    loadChats().then(() => {
      // Após carregar, envia estado local para R2 para manter base multi-usuário atualizada
      setTimeout(_syncChatsToR2, 5000);
      // Inicia resolução em lote de todos os @lid pendentes
      setTimeout(_batchResolveLids, 8000);
    });
  }, [sessionOk]);

  // Aplica dados do R2 sobre o estado atual de chats
  // fallback: lista de chats local caso prev ainda esteja vazia (race no primeiro render)
  async function applyR2Chats(fallbackChats = []) {
    try {
      const r2Res = await fetch("/api/r2-data?type=chats", {
        headers: { "X-Internal-Key": ikey() }
      });
      if (!r2Res.ok) return;
      const r2Chats = await r2Res.json();
      if (!Array.isArray(r2Chats) || r2Chats.length === 0) return;
      const lidCacheApply = readLidPhoneMap();
      const r2Map = {};
      for (const c of r2Chats) {
        r2Map[c.id] = c;
        const ck = canonicalKey(c.id, lidCacheApply);
        if (ck && ck !== c.id) r2Map[ck] = c;
      }
      setChats(prev => {
        const base = prev.length ? prev : fallbackChats;
        if (!base.length) { console.log("[r2] applyR2Chats: sem base, aguardando WAHA"); return prev; }
        console.log(`[r2] applyR2Chats: prev=${prev.length} base=${base.length}`);
        const localIds = new Set(base.map(c => c.id));
        const overrides = readOverrides();
        let changed = false;
        const updated = base.map(c => {
          const ck = canonicalKey(c.id, lidCacheApply);
          const r2 = r2Map[c.id] || (ck ? r2Map[ck] : undefined);
          if (!r2) return c;
          const r2TsMs  = r2.lastTs || 0;
          const localTs = c.lastTs ? new Date(c.lastTs).getTime() : 0;
          if (r2TsMs <= localTs) return c;
          changed = true;
          const isMuted  = mutedChatsRef.current.has(c.id);
          // Usa APENAS r2.lastMsg para detectar closing — não usa c.lastMsg como fallback.
          // Se R2 ainda tem mensagem antiga (ex: "Consulta confirmada!") mas o chat foi
          // reaberto localmente por nova mensagem do paciente, não re-resolve.
          const r2LastMsg = r2.lastMsg || "";
          const closing  = lastMsgIsClosing(r2LastMsg);
          // Se chat foi reaberto localmente (status=open) e nova msg é mais recente que R2,
          // não deixa o R2 antigo re-resolver o chat
          const localReopened = c.status === "open" && c.lastTs && localTs > r2TsMs - 1000;
          const effectiveClosing = closing && !localReopened;
          // Verifica overrides manuais do operador (keyed por dígitos canônicos)
          const ov = ck ? overrides[ck] : overrides[c.id];
          const r2LptMs = r2.lastPatientTs ? new Date(r2.lastPatientTs).getTime() : 0;
          const ovResolved = ov?.resolvedAt && r2LptMs <= ov.resolvedAt;
          const ovRead = ov?.readAt && r2LptMs <= ov.readAt;
          const lpt = isMuted || effectiveClosing || ovRead || ovResolved ? null
            : (r2.lastPatientTs ? new Date(r2.lastPatientTs).toISOString() : null);
          // Não sobrescreve unread=0 local com valor maior do R2 se o chat já foi lido
          // (c.unread===0 e c.lastPatientTs===null = operador marcou como lido)
          const alreadyRead = c.unread === 0 && !c.lastPatientTs;
          const unread = isMuted || effectiveClosing || !lpt || ovRead || ovResolved ? 0
            : alreadyRead ? 0
            : Math.max(r2.unread || 0, c.unread || 0);
          const isResolved = (c.status === "resolved" && !localReopened) || effectiveClosing || ovResolved;
          return {
            ...c,
            lastMsg:       r2LastMsg || c.lastMsg,
            lastTs:        new Date(r2TsMs).toISOString(),
            lastPatientTs: isResolved ? null : lpt,
            unread:        isResolved ? 0 : unread,
            status:        effectiveClosing && c.status !== "resolved" ? "resolved" : c.status,
            pushname:      r2.pushname || c.pushname,
          };
        });
        // Adiciona chats novos do R2 que não estão na lista local
        // Filtra IDs inválidos (@lid, @s.whatsapp.net, >13 dígitos) e verifica dedup por tail-8
        for (const r2 of r2Chats) {
          if (localIds.has(r2.id)) continue;
          if (!_isValidNewChatId(r2.id)) continue;
          const rDigits = r2.id.replace(/\D/g, "");
          const rTail8  = rDigits.length >= 8 ? rDigits.slice(-8) : null;
          if (rTail8 && updated.some(c => {
            const t = c.id.replace(/\D/g, "").slice(-8);
            return t.length >= 8 && t === rTail8;
          })) continue;
          const isMuted  = mutedChatsRef.current.has(r2.id);
          const closing  = lastMsgIsClosing(r2.lastMsg);
          const lpt = isMuted || closing ? null
            : (r2.lastPatientTs ? new Date(r2.lastPatientTs).toISOString() : null);
          updated.push({
            id:            r2.id,
            pushname:      r2.pushname || "",
            lastMsg:       r2.lastMsg  || "",
            lastTs:        r2.lastTs   ? new Date(r2.lastTs).toISOString() : null,
            lastPatientTs: lpt,
            unread:        isMuted || closing || !lpt ? 0 : r2.unread || 0,
            status:        closing ? "resolved" : "open",
            assignedTo:    null,
            tags:          [],
            photoUrl:      null,
          });
          changed = true;
        }
        if (!changed) return prev;
        persistChats(updated);
        return updated;
      });
      console.log(`[r2] chatlist aplicado: ${r2Chats.length} chats`);
    } catch (e) {
      console.warn("[r2] applyR2Chats:", e.message);
    }
  }

  // Polling R2 a cada 10s para capturar mensagens que chegaram via webhook
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(() => applyR2Chats(), 10000);
    return () => clearInterval(iv);
  }, [sessionOk]);

  // Persiste chatlist no localStorage a cada 1 minuto para manter cache local atualizado
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(() => {
      const current = _sessionChats.value;
      if (current?.length) persistChats(current);
    }, 60 * 1000);
    return () => clearInterval(iv);
  }, [sessionOk]);

  // Auto-resync leve a cada 2.5 minutos (era 5 min) + sync R2 + resolução de LIDs
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(() => {
      _lightResync();
      _syncChatsToR2();
      _batchResolveLids();
    }, 2.5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [sessionOk]);

  async function loadChats(forceFullSync = false) {
    setLoading(true);
    if (forceFullSync) {
      try { localStorage.removeItem(LAST_SYNC_KEY); } catch {}
      console.log("[waha] force full sync via R2");
    }
    try {
      // ── 1. Exibe imediatamente enquanto carrega (sessão → localStorage slim) ──
      let cachedChats = (_sessionChats.value?.length && Date.now() < _sessionChats.expires)
        ? _sessionChats.value : [];
      if (!cachedChats.length) {
        try {
          const raw = localStorage.getItem("crm_" + CHATS_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed?.value?.length && Date.now() < parsed.expires) {
              cachedChats = parsed.value;
              setChats(cachedChats);
            }
          }
        } catch {}
      }

      // ── 2. Busca R2 + MongoDB em paralelo (fonte primária: webhook → R2) ──
      const [r2Res, dbRes] = await Promise.all([
        fetch("/api/r2-data?type=chats", { headers: { "X-Internal-Key": ikey() } })
          .then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`/api/db?action=chats`, { headers: { "X-Internal-Key": ikey() } })
          .then(r => r.json()).catch(() => ({ chats: {} })),
      ]);

      const dbMeta  = dbRes?.chats || {};
      const r2Valid = (Array.isArray(r2Res) ? r2Res : []).filter(c => c.id && _isValidNewChatId(c.id));
      console.log(`[r2] ${r2Valid.length} chats carregados do R2`);

      // ── 3. Normaliza chats do R2 para formato do app ──
      const normalized = r2Valid.map(c => {
        const meta    = dbMeta[c.id] || dbMeta[c.id.replace(/\D/g,"")] || {};
        const cleanId = c.id.replace(/@.*$/, "");
        const phone   = extractPhone(c.id);
        const pn      = c.pushname || "";
        return {
          id:           c.id,
          name:         pn || cleanId,
          pushname:     pn,
          phone:        phone ? ("+" + phone) : (pn || cleanId),
          isValidPhone: !!phone,
          lastMsg:      c.lastMsg || "",
          lastTime:     c.lastTs ? new Date(c.lastTs).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) : "",
          lastTs:       c.lastTs ? new Date(c.lastTs).toISOString() : null,
          lastPatientTs: c.lastPatientTs || null,
          unread:       c.unread || 0,
          status:       meta.status     || "open",
          assignedTo:   meta.assignedTo || null,
          tags:         meta.tags       || [],
          avatar:       (pn || cleanId || "??").slice(0, 2).toUpperCase(),
          avatarColor:  stringToColor(c.id),
          photoUrl:     null,
        };
      });

      // ── 4. Mescla com estado local e aplica overrides ──
      const TRINTA_DIAS = 30 * 24 * 60 * 60 * 1000;
      const agora = Date.now();
      const toAutoResolveIds = new Set();

      setChats(prev => {
        const lidPhoneCache = readLidPhoneMap();
        const overrides     = readOverrides();
        const prevMap = {};
        const prevByPhone = {};
        for (const c of prev) {
          prevMap[c.id] = c;
          const ck = canonicalKey(c.id, lidPhoneCache);
          if (ck) prevByPhone[ck] = c;
        }

        const r2Ids    = new Set(normalized.map(c => c.id));
        const r2Phones = new Set(normalized.map(c => c.id.replace(/\D/g,"")).filter(d => d.length >= 8));

        const merged = normalized.map(n => {
          const ck      = canonicalKey(n.id, lidPhoneCache);
          const local   = prevMap[n.id] || (ck ? prevByPhone[ck] : undefined);
          const isMuted = mutedChatsRef.current.has(n.id);

          const r2LptMs    = n.lastPatientTs ? new Date(n.lastPatientTs).getTime() : 0;
          const localLptMs = local?.lastPatientTs ? new Date(local.lastPatientTs).getTime() : 0;
          const ov         = ck ? overrides[ck] : (overrides[n.id] || null);
          const ovResolved = ov?.resolvedAt && r2LptMs <= ov.resolvedAt;
          const ovRead     = ov?.readAt     && r2LptMs <= ov.readAt;

          const closing = lastMsgIsClosing(n.lastMsg);
          // Para chats abertos localmente pelo WebSocket, preserva o LPT local mais recente
          const localIsOpen = local?.status === "open" && !!local?.lastPatientTs;
          const lpt = isMuted || closing || ovRead || ovResolved ? null
            : localIsOpen
              ? local.lastPatientTs
              : (r2LptMs ? new Date(Math.max(r2LptMs, localLptMs)).toISOString() : null);
          const should30 = lpt && agora - new Date(lpt).getTime() > TRINTA_DIAS;
          if ((closing || should30) && (local?.status !== "resolved")) toAutoResolveIds.add(n.id);

          const unread = isMuted || closing || should30 || ovResolved || ovRead || !lpt ? 0 : n.unread || 0;
          const status = closing || should30 || ovResolved ? "resolved" : (local?.status ?? n.status);

          return {
            ...n,
            photoUrl:      local?.photoUrl   ?? null,
            name:          local?.name       || n.name,
            pushname:      n.pushname        || local?.pushname || "",
            lastPatientTs: (closing || should30 || ovResolved || ovRead) ? null : lpt,
            unread,
            status,
            assignedTo:    local?.assignedTo ?? n.assignedTo,
            tags:          local?.tags       ?? n.tags,
          };
        });

        // Preserva chats locais que ainda não chegaram via webhook (pré-webhook ou edge cases)
        for (const c of prev) {
          if (r2Ids.has(c.id)) continue;
          const ck = canonicalKey(c.id, lidPhoneCache);
          if (ck && r2Phones.has(ck)) continue;
          merged.push(c);
        }

        // Adiciona chats do MongoDB sem entrada no R2
        for (const [chatId, meta] of Object.entries(dbMeta)) {
          if (r2Ids.has(chatId)) continue;
          if (!_isValidNewChatId(chatId)) continue;
          const mDigits = chatId.replace(/\D/g,"");
          if (mDigits.length >= 8 && r2Phones.has(mDigits.slice(-8))) continue;
          if (merged.some(c => c.id === chatId)) continue;
          const pn = meta.pushname || "";
          merged.push({
            id: chatId, name: pn, pushname: pn,
            lastMsg: meta.lastMsg || "", lastTs: meta.lastTs || null,
            lastPatientTs: null, unread: 0,
            status: meta.status || "open", assignedTo: meta.assignedTo || null,
            tags: meta.tags || [], photoUrl: null,
            avatar: (pn||"??").slice(0,2).toUpperCase(), avatarColor: stringToColor(chatId),
          });
        }

        const deduped = _dedupeChats(merged);
        console.log(`[waha] loadChats: r2=${normalized.length} merged=${merged.length} deduped=${deduped.length}`);
        persistChats(deduped);

        if (toAutoResolveIds.size > 0) {
          console.log(`[waha] auto-resolve: ${toAutoResolveIds.size} chats`);
          const now = Date.now();
          for (const id of toAutoResolveIds) saveOverride(id, { resolvedAt: now, readAt: now });
          Promise.allSettled([...toAutoResolveIds].map(id =>
            fetch("/api/db?action=chat", {
              method: "PATCH",
              headers: { "Content-Type": "application/json", "X-Internal-Key": ikey() },
              body: JSON.stringify({
                chatId: id, status: "resolved", unread: 0,
                lastPatientTs: null, autoResolved: true,
                autoResolvedAt: new Date().toISOString(),
              }),
            }).catch(() => {})
          ));
        }
        return deduped;
      });

      markLastSync();
      setTimeout(() => loadProfilePictures(r2Valid.map(c => c.id)), 1000);

    } catch (e) {
      console.error("[waha] loadChats:", e.message);
      setError("Erro ao carregar conversas");
    } finally {
      setLoading(false);
    }
  }

  // ── Fotos de perfil — via proxy /api/waha, cache 24h ──
  async function loadProfilePictures(chatIds) {
    const PHOTO_KEY = "waha_photos_v3";
    const PHOTO_TTL = 24 * 60 * 60 * 1000;
    const SESSION   = import.meta.env.VITE_WAHA_SESSION || "default";
    let photoCache  = {};
    try {
      const raw = localStorage.getItem(PHOTO_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (Date.now() < p.expires) photoCache = p.value || {};
      }
    } catch {}

    // Aplica fotos já em cache imediatamente
    const cachedUrls = Object.fromEntries(Object.entries(photoCache).filter(([, v]) => v));
    if (Object.keys(cachedUrls).length) {
      setChats(prev => prev.map(c => cachedUrls[c.id] ? { ...c, photoUrl: cachedUrls[c.id] } : c));
    }

    // Busca fotos ausentes do cache (inclui quem tem null — pode ter sido erro anterior)
    // Só pula se já tem URL válida
    const semFoto = chatIds.filter(id => !photoCache[id]);
    if (!semFoto.length) return;

    async function fetchPhoto(chatId) {
      const id = encodeURIComponent(chatId);
      try {
        const r = await fetch(
          `/api/waha?path=/api/contacts/profile-picture&contactId=${id}&session=${SESSION}`,
          { headers: { "X-Internal-Key": ikey() } }
        );
        if (!r.ok) return null;
        const data = await r.json();
        return data?.profilePictureURL || data?.pictureUrl || data?.url || null;
      } catch { return null; }
    }

    const BATCH = 5;
    for (let i = 0; i < semFoto.length; i += BATCH) {
      const batch = semFoto.slice(i, i + BATCH);
      const results = await Promise.allSettled(batch.map(async (chatId) => ({
        chatId, url: await fetchPhoto(chatId),
      })));

      const updates = {};
      for (const r of results) {
        if (r.status === "fulfilled") {
          const { chatId, url } = r.value;
          photoCache[chatId] = url || null;
          if (url) updates[chatId] = url;
        }
      }
      try {
        localStorage.setItem(PHOTO_KEY, JSON.stringify({
          value: photoCache, expires: Date.now() + PHOTO_TTL,
        }));
      } catch {}
      if (Object.keys(updates).length) {
        setChats(prev => {
          const next = prev.map(c => c.id in updates ? { ...c, photoUrl: updates[c.id] } : c);
          persistChats(next);
          return next;
        });
      }
      if (i + BATCH < semFoto.length) await new Promise(r => setTimeout(r, 300));
    }
  }

  // ── Auto-resolve chats com >30 dias sem resposta do paciente ──
  // Usa estado atual do React (já mesclado com local) — não dados crus do WAHA
  // ── Carrega APENAS última mensagem de cada chat (lotes de 5) ──
  async function loadLastMessages(chatIds) {
    const BATCH = 3;
    for (let i = 0; i < chatIds.length; i += BATCH) {
      const batch = chatIds.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async (chatId) => {
        try {
          const SESSION = import.meta.env.VITE_WAHA_SESSION || "default";
          const id = encodeURIComponent(chatId);
          const r  = await fetch(
            `/api/waha?path=/api/${SESSION}/chats/${id}/messages&limit=10&downloadMedia=false`,
            { headers: { "X-Internal-Key": ikey() } }
          );
          if (!r.ok) return;
          const raw = await r.json();
          if (!Array.isArray(raw) || raw.length === 0) return;

          const allNorm = raw.map(normalizeMessage).filter(Boolean)
            .sort((a, b) => tsToNum(a.ts) - tsToNum(b.ts));
          const msg = allNorm[allNorm.length - 1];
          if (!msg) return;

          const lastMsg = msg.text || (msg.location ? "📍 Localização" : msg.media ? "📎 Mídia" : "");

          // Unread: msgs do paciente após a última resposta do operador
          let unread = 0;
          for (let j = allNorm.length - 1; j >= 0; j--) {
            if (allNorm[j].from === "operator") break;
            if (allNorm[j].from === "patient") unread++;
          }

          const newLastPatientTs = computeLastPatientTs(allNorm);

          setChats(prev => {
            const updated = prev.map(c => {
              if (c.id !== chatId) return c;
              // Não sobrescreve lastPatientTs de chats silenciados
              const lpt = mutedChatsRef.current.has(chatId) ? null : newLastPatientTs;
              return {
                ...c,
                lastMsg:       lastMsg || c.lastMsg,
                lastTime:      msg.time || c.lastTime,
                lastTs:        msg.ts   || c.lastTs,
                lastPatientTs: lpt,
                unread:        mutedChatsRef.current.has(chatId) ? 0 : unread,
              };
            });
            persistChats(updated);
            return updated;
          });
        } catch {}
      }));
      if (i + BATCH < chatIds.length) await new Promise(r => setTimeout(r, 500));
    }
  }


  // ── 3. Tempo real: PartyKit → fallback polling WAHA ─────────────
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;

    const PARTY_HOST = import.meta.env.VITE_PARTYKIT_HOST;

    // Handlers compartilhados
    function handleMsg(msg) {
      const msgChatId = msg.chatId;
      if (!msgChatId) return;

      // Rejeita apenas @s.whatsapp.net — é o servidor, nunca um contato real.
      // @lid é válido: a maioria dos contatos desta clínica usa @lid como único identificador.
      if (msgChatId.endsWith("@s.whatsapp.net")) return;

      // Chat apagado pelo operador → restaura ao receber nova mensagem, limpando histórico antigo
      if (_deletedChats.has(msgChatId)) {
        _deletedChats.delete(msgChatId);
        persistDeletedChats();
        _sessionMsgs.delete(msgChatId);
        setMessages(prev => {
          if (!(msgChatId in prev)) return prev;
          const next = { ...prev };
          delete next[msgChatId];
          return next;
        });
      }

      // Dedup global: evita duplo incremento de unread se PartyKit + polling
      // processam a mesma mensagem simultaneamente
      if (msg.id && _handledMsgIds.has(msg.id)) return;
      if (msg.id) {
        _handledMsgIds.add(msg.id);
        if (_handledMsgIds.size > 500) {
          const oldest = [..._handledMsgIds].slice(0, 250);
          oldest.forEach(id => _handledMsgIds.delete(id));
        }
      }

      const isMuted = mutedChatsRef.current.has(msgChatId);

      if (msg.from === "patient" && document.hidden && !isMuted) {
        try {
          navigator.serviceWorker?.ready.then(reg => {
            reg.active?.postMessage({
              type: "SHOW_NOTIFICATION",
              title: msgChatId.replace(/@.*$/, "") || "Paciente",
              body: msg.text?.slice(0, 100) || "Nova mensagem",
              chatId: msgChatId,
            });
          }).catch(() => {});
        } catch {}
      }

      // Resolve efetivo chatId via _sessionChats (não requer state) para garantir que
      // setMessages e setChats usem o mesmo ID — cobre variações de formato (com/sem 9 BR)
      const msgDigits = msgChatId.replace(/\D/g, "");
      const msgTail10 = msgDigits.slice(-10);
      const msgTail8  = msgDigits.slice(-8);
      const _findTarget = (list) => list.find(c => c.id === msgChatId)
        || list.find(c => { const t = c.id.replace(/\D/g, "").slice(-10); return t.length >= 8 && t === msgTail10; })
        || (msgTail8.length >= 8 ? list.find(c => { const t = c.id.replace(/\D/g, "").slice(-8); return t.length >= 8 && t === msgTail8; }) : null);
      const preTarget = _findTarget(_sessionChats.value || []);
      const effectiveId = preTarget?.id || msgChatId;

      setMessages(prev => {
        const existing = prev[effectiveId] || [];
        if (existing.find(m => m.id === msg.id)) return prev;
        const semTmp  = removeTmp(existing, [msg]);
        const updated = sortMsgs([...semTmp, msg]);
        _sessionMsgs.set(effectiveId, updated);
        _cacheMsgs(effectiveId, updated);
        return { ...prev, [effectiveId]: updated };
      });

      setChats(prev => {
        const isPatient = msg.from === "patient";
        const autoRes   = (isPatient && isFarewell(msg.text)) || (!isPatient && isOperatorClosing(msg.text));
        const lastMsg   = msg.text || (msg.location ? "📍 Localização" : msg.media ? "📎 Mídia" : "");

        // Encontra o chat por ID exato, depois por tail-10 e tail-8
        const target = _findTarget(prev);

        // Chat ainda não na lista (número novo) — adiciona ao topo
        // Nunca criar chats para @s.whatsapp.net; @lid é permitido (contato migrado)
        if (!target && msgChatId.endsWith("@s.whatsapp.net")) return prev;
        if (!target) {
          const lpt = isPatient && !autoRes && !isMuted ? msg.ts : null;
          const newChat = {
            id:            msgChatId,
            pushname:      msg.pushname || "",
            lastMsg,
            lastTime:      msg.time,
            lastTs:        msg.ts,
            lastPatientTs: lpt,
            unread:        lpt ? 1 : 0,
            status:        "open",
            assignedTo:    null,
            tags:          [],
            photoUrl:      null,
          };
          const updated = [newChat, ...prev];
          persistChats(updated);
          return updated;
        }

        const updated = prev.map(c => c.id !== target.id ? c : {
          ...c,
          lastMsg,
          lastTime:      msg.time,
          lastTs:        msg.ts,
          // patient normal → define timer; despedida ou operador → limpa timer
          lastPatientTs: isPatient && !autoRes && !isMuted ? msg.ts
                       : !isPatient || autoRes           ? null
                       : c.lastPatientTs,
          // patient normal → +1 unread; despedida ou operador fechando → zera unread
          unread:        isPatient && !autoRes && !isMuted ? (c.unread || 0) + 1
                       : !isPatient || autoRes            ? 0
                       : c.unread,
          // autoRes → resolve; patient normal reabre se estava resolvido
          status:        autoRes ? "resolved"
                       : isPatient && !isMuted && c.status === "resolved" ? "open"
                       : c.status,
        });
        // Persiste mudanças de status no MongoDB e localStorage (override)
        const afterUpdate = updated.find(c => c.id === target.id);
        if (autoRes && target.status !== "resolved") {
          const now = Date.now();
          saveOverride(target.id, { resolvedAt: now, readAt: now });
          persistChat(target.id, { status: "resolved", unread: 0, lastPatientTs: null });
        } else if (afterUpdate?.status === "open" && target.status === "resolved") {
          clearOverride(target.id);
          persistChat(target.id, { status: "open", lastPatientTs: msg.ts });
        }
        persistChats(updated);
        return updated;
      });
    }

    handleMsgRef.current = handleMsg;

    function handleChatNew(payload) {
      const rawId = payload?.id || payload?.chatId || "";
      const chatId = rawId.replace(/:\d+(@\S+)?$/, "");
      if (!chatId) return;
      const phone = extractPhone(chatId);
      const color = stringToColor(phone || chatId);
      const newChat = {
        id: chatId, name: payload.name || payload.pushname || phone || chatId,
        pushname: payload.pushname || "", phone, color,
        lastMsg: "", lastTs: 0, unread: 0, lastPatientTs: null,
        status: "open", assignedTo: null, tags: [],
      };
      setChats(prev => {
        if (prev.find(c => c.id === chatId)) return prev;
        const updated = [newChat, ...prev];
        persistChats(updated);
        return updated;
      });
      loadLastMessages([chatId]);
    }

    function dispatch(event, payload) {
      if (!payload) return;
      if (event === "message" || event === "message.any") {
        const msg = normalizeMessage(payload);

        // Enriquece pushname com notifyName do WAHA
        if (!msg.pushname) {
          msg.pushname = payload.notifyName || payload._data?.notifyName || "";
        }

        // Se chatId ainda está em @lid, tenta recuperar de payload.from (costuma ser @c.us)
        if (!msg.chatId || msg.chatId.endsWith("@lid")) {
          const rawFallback = (payload.from || payload.chatId || "")
            .replace(/:\d+(@\S+)?$/, "");
          if (rawFallback && !rawFallback.endsWith("@lid") && !rawFallback.endsWith("@s.whatsapp.net")) {
            // payload.from já tem o @c.us — resolve imediatamente e grava o mapeamento
            const originalLid = msg.chatId;
            if (originalLid?.endsWith("@lid")) {
              _lidToJid.set(originalLid, rawFallback);
              _saveLidResolution(originalLid, rawFallback, msg.pushname);
            }
            msg.chatId = rawFallback;
            handleMsg(msg);
          } else {
            // Conta totalmente migrada para LID — chama API do WAHA para resolver
            const lid = msg.chatId || rawFallback;
            if (!lid) return;
            resolveLid(lid, msg.pushname).then(jid => {
              if (jid) msg.chatId = jid;
              // Resolvido → rota para @c.us; não resolvido → rota para o próprio @lid (válido agora)
              else console.log(`[lid] não resolvido, roteando para @lid: ${lid}`, msg.pushname ? `(pushname: ${msg.pushname})` : "");
              handleMsg(msg);
            }).catch(() => { handleMsg(msg); });
          }
          return;
        }

        handleMsg(msg);
      } else if (event === "chat.new") {
        handleChatNew(payload);
      } else if (event === "message.revoked") {
        const msgId = payload.id || payload._data?.id?.id;
        const chatId = (payload.chatId || payload.key?.remoteJid || payload.from || "")
          .replace(/:\d+(@\S+)?$/, "");
        if (msgId && chatId) {
          setMessages(prev => {
            const cur = prev[chatId];
            if (!cur) return prev;
            const updated = cur.filter(m => m.id !== msgId);
            return { ...prev, [chatId]: updated };
          });
        }
      }
    }

    // ── PartyKit (preferido) ──────────────────────────────────────
    if (PARTY_HOST) {
      import("partysocket").then(({ default: PartySocket }) => {
        const ps = new PartySocket({
          host: PARTY_HOST,
          room: "clinic",
        });

        ps.onopen = () => {
          wsConnected.current = true;
          setWsStatus("connected");
          console.log("[party] connected");
        };

        ps.onmessage = (e) => {
          try {
            const data = JSON.parse(e.data);
            const { event, payload } = data;

            if (event === "connected") return;

            // Histórico de reconexão — processa cada evento
            if (event === "history" && Array.isArray(payload)) {
              for (const item of payload) {
                dispatch(item.event, item.payload);
              }
              return;
            }

            dispatch(event, payload);
          } catch {}
        };

        ps.onclose = () => {
          wsConnected.current = false;
          setWsStatus("reconnecting");
        };

        ps.onerror = () => {
          wsConnected.current = false;
          setWsStatus("reconnecting");
        };

        // Heartbeat a cada 25s — mantém WS vivo em browsers que suspendem conexões ociosas
        const heartbeat = setInterval(() => {
          try { if (ps.readyState === 1) ps.send(JSON.stringify({ type: "ping" })); } catch {}
        }, 25000);

        socketRef.current = { close: () => { clearInterval(heartbeat); ps.close(); } };
      });

      return () => {
        wsConnected.current = false;
        socketRef.current?.close();
      };
    }

    // Sem PartyKit configurado: polling é o único mecanismo (ver abaixo)
    setWsStatus("disconnected");
  }, [sessionOk]);

  // ── Mock ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!USE_MOCK) return;
    setChats(MOCK_CHATS);
    setWsStatus("connected");
  }, []);

  // ── 4. loadMessages — abre ChatWindow: últimas 60 msgs ────────
  const loadMessages = useCallback(async (chatId) => {
    activeChatRef.current = chatId;
    delete seenMsgIds.current[chatId];
    try {
      const existing = resolveName(chatId, null);
      if (!existing && typeof lookupPhonePriority === "function") {
        lookupPhonePriority(chatId).then(name => {
          if (name) console.log(`[contacts] on-demand ${chatId} → ${name}`);
        }).catch(() => {});
      }
    } catch {}

    // 1. In-memory (sobrevive re-renders)
    const cached = _sessionMsgs.get(chatId);
    if (cached?.length) {
      setMessages(prev => ({ ...prev, [chatId]: cached }));
    } else {
      // 2. localStorage (sobrevive F5) — exibe imediatamente enquanto R2 carrega
      const lsCached = _getCachedMsgs(chatId);
      if (lsCached?.length) {
        setMessages(prev => ({ ...prev, [chatId]: lsCached }));
        _sessionMsgs.set(chatId, lsCached);
      }
    }

    if (USE_MOCK) {
      setMessages(prev => ({ ...prev, [chatId]: MOCK_MESSAGES[chatId] || [] }));
      return;
    }

    try {
      // 3. R2 (fonte primária — atualizado mesmo com CRM fechado)
      const r2Raw = await fetch(`/api/r2-data?type=msgs&chatId=${encodeURIComponent(chatId)}`, {
        headers: { "X-Internal-Key": ikey() }
      }).then(r => r.ok ? r.json() : []).catch(() => []);

      // Ignora se o usuário já trocou de chat enquanto aguardava o fetch
      if (activeChatRef.current !== chatId) return;

      const r2Msgs = Array.isArray(r2Raw)
        ? sortMsgs(r2Raw.map(normalizeR2Message))
        : [];

      setMessages(prev => {
        const existing    = prev[chatId] || [];
        const existingMap = new Map(existing.map(m => [m.id, m]));
        const ids         = new Set(r2Msgs.map(m => m.id));
        // Preserva msgs recebidas via WebSocket ainda não persistidas no R2
        const wsExtras = existing.filter(m => !ids.has(m.id) && !m.id.startsWith("tmp-"));
        // Para cada msg do R2, preserva o media carregado localmente (blob URL) se R2 não tem URL
        const r2WithMedia = r2Msgs.map(m => {
          const local = existingMap.get(m.id);
          if (local?.media && !m.media?.url) return { ...m, media: local.media };
          return m;
        });
        const merged = sortMsgs([...r2WithMedia, ...wsExtras]);
        _sessionMsgs.set(chatId, merged);
        _cacheMsgs(chatId, merged);
        return { ...prev, [chatId]: merged };
      });

    } catch (e) { console.error("loadMessages", e); }
  }, []);

  // ── 5. loadOlderMessages — paginação por janelas de 10 dias ───
  const loadOlderMessages = useCallback(async (chatId, currentMsgs) => {
    const SESSION = import.meta.env.VITE_WAHA_SESSION || "default";
    const id      = encodeURIComponent(chatId);

    const oldestMsg = (currentMsgs || [])[0];
    const oldestTs  = oldestMsg?.ts
      ? Math.floor(new Date(oldestMsg.ts).getTime() / 1000)
      : Math.floor(Date.now() / 1000);

    const WINDOW_DAYS = 10;
    const windowEnd   = oldestTs;
    const windowStart = windowEnd - (WINDOW_DAYS * 86400);

    try {
      const params = new URLSearchParams({
        limit:         "100",
        downloadMedia: "false",
        fromTimestamp:  String(windowStart),
        toTimestamp:    String(windowEnd),
      });
      const r = await fetch(
        `/api/waha?path=/api/${SESSION}/chats/${id}/messages&${params}`,
        { headers: { "X-Internal-Key": ikey() } }
      );
      if (!r.ok) return { hasMore: false };
      const raw = await r.json();
      if (!Array.isArray(raw)) return { hasMore: false };

      const normalized    = sortMsgs(raw.map(normalizeMessage));
      const existingIds   = new Set((currentMsgs || []).map(m => m.id));
      const novas         = normalized.filter(m =>
        !existingIds.has(m.id) &&
        Math.floor(new Date(m.ts).getTime() / 1000) < windowEnd
      );

      if (novas.length === 0) {
        const diasAtras = Math.floor((Date.now() / 1000 - windowStart) / 86400);
        return { hasMore: diasAtras < 100 };
      }

      setMessages(prev => {
        const current = prev[chatId] || [];
        const ids     = new Set(current.map(m => m.id));
        const toAdd   = novas.filter(m => !ids.has(m.id));
        if (!toAdd.length) return prev;
        const updated = sortMsgs([...toAdd, ...current]);
        _sessionMsgs.set(chatId, updated);
        return { ...prev, [chatId]: updated };
      });

      const diasAtras = Math.floor((Date.now() / 1000 - windowStart) / 86400);
      return { hasMore: diasAtras < 100, loaded: novas.length };
    } catch { return { hasMore: false }; }
  }, []);

  // ── Polling mensagens do chat ativo — APENAS como fallback quando WS offline ──
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(async () => {
      // Só faz polling quando PartyKit está desconectado
      if (wsConnected.current) return;
      const chatId = activeChatRef.current;
      if (!chatId) return;
      try {
        const SESSION = import.meta.env.VITE_WAHA_SESSION || "default";
        const id  = encodeURIComponent(chatId);
        const r   = await fetch(
          `/api/waha?path=/api/${SESSION}/chats/${id}/messages&limit=10&downloadMedia=false`,
          { headers: { "X-Internal-Key": ikey() } }
        );
        if (!r.ok) return;
        const raw = await r.json();
        if (!Array.isArray(raw)) return;
        const normalized = sortMsgs(raw.map(normalizeMessage));

        // Dedup fora do state updater (que é assíncrono) — usa ref para saber quais IDs já foram vistos
        const prevSeen = seenMsgIds.current[chatId]; // undefined na primeira poll
        const allIds   = normalized.map(m => m.id).filter(Boolean);
        seenMsgIds.current[chatId] = new Set(allIds);

        // Na primeira poll apenas inicializa; não trata mensagens existentes como novas
        const novos = prevSeen
          ? normalized.filter(m => m.id && !prevSeen.has(m.id))
          : [];

        setMessages(prev => {
          const current = prev[chatId] || [];
          const ids     = new Set(current.filter(m => !m.id.startsWith("tmp-")).map(m => m.id));
          const toAdd   = normalized.filter(m => !ids.has(m.id));
          if (!toAdd.length) return prev;
          const semTmp  = removeTmp(current, toAdd);
          const updated = sortMsgs([...semTmp, ...toAdd]);
          _sessionMsgs.set(chatId, updated);
          return { ...prev, [chatId]: updated };
        });

        // Propaga mensagens realmente novas → chatlist + notificações (igual ao PartyKit)
        if (novos.length && handleMsgRef.current) {
          for (const m of novos) {
            if (!m.chatId) m.chatId = chatId;
            handleMsgRef.current(m);
          }
        }
      } catch {}
    }, 5000); // 5s no fallback (WS desconectado)
    return () => clearInterval(iv);
  }, [sessionOk]);

  // ── Polling lista de chats (30s) — R2 como fonte, cobre reconexão e multi-aba ──
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(async () => {
      try {
        const r2Res = await fetch("/api/r2-data?type=chats", { headers: { "X-Internal-Key": ikey() } })
          .then(r => r.ok ? r.json() : []).catch(() => []);
        if (!Array.isArray(r2Res) || !r2Res.length) return;

        const lidCache  = readLidPhoneMap();
        const overrides = readOverrides();

        setChats(prev => {
          let changed = false;
          const prevById = {};
          for (const c of prev) prevById[c.id] = c;

          const r2Map = {};
          for (const c of r2Res) if (c.id) r2Map[c.id] = c;

          const updated = prev.map(c => {
            const r2 = r2Map[c.id];
            if (!r2) return c;
            const r2TsMs = r2.lastTs || 0;
            const cTsMs  = c.lastTs ? new Date(c.lastTs).getTime() : 0;
            if (r2TsMs <= cTsMs) return c;
            changed = true;
            const ck = canonicalKey(c.id, lidCache);
            const ov = ck ? overrides[ck] : (overrides[c.id] || null);
            const r2LptMs  = r2.lastPatientTs ? new Date(r2.lastPatientTs).getTime() : 0;
            const ovRead     = ov?.readAt     && r2LptMs <= ov.readAt;
            const ovResolved = ov?.resolvedAt && r2LptMs <= ov.resolvedAt;
            const closing    = lastMsgIsClosing(r2.lastMsg);
            const lpt = closing || ovRead || ovResolved ? null
              : (r2.lastPatientTs ? new Date(r2.lastPatientTs).toISOString() : null);
            return {
              ...c,
              lastMsg:       r2.lastMsg || c.lastMsg,
              lastTime:      new Date(r2TsMs).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}),
              lastTs:        new Date(r2TsMs).toISOString(),
              lastPatientTs: lpt,
              unread:        closing || ovResolved || ovRead || !lpt ? 0 : Math.max(r2.unread||0, c.unread||0),
              status:        closing || ovResolved ? "resolved" : c.status,
            };
          });

          // Adiciona novos chats do R2 ainda não vistos
          const prevIds    = new Set(prev.map(c => c.id));
          const allPhones  = new Set(updated.map(c => c.id.replace(/\D/g,"")).filter(d => d.length >= 8));
          for (const r2 of r2Res) {
            if (!r2.id || prevIds.has(r2.id) || !_isValidNewChatId(r2.id)) continue;
            const rDigits = r2.id.replace(/\D/g,"");
            if (rDigits.length >= 8 && allPhones.has(rDigits.slice(-8))) continue;
            const pn = r2.pushname || "";
            const cleanId = r2.id.replace(/@.*$/, "");
            changed = true;
            updated.push({
              id: r2.id, name: pn || cleanId, pushname: pn,
              lastMsg: r2.lastMsg || "", lastTs: r2.lastTs ? new Date(r2.lastTs).toISOString() : null,
              lastPatientTs: r2.lastPatientTs || null, unread: r2.unread || 0,
              status: "open", assignedTo: null, tags: [], photoUrl: null,
              avatar: (pn||cleanId||"??").slice(0,2).toUpperCase(), avatarColor: stringToColor(r2.id),
            });
            if (rDigits.length >= 8) allPhones.add(rDigits.slice(-8));
          }

          if (!changed) return prev;
          const deduped = _dedupeChats(updated);
          persistChats(deduped);
          return deduped;
        });
      } catch {}
    }, 30000); // 30s — PartyKit cobre tempo real; polling cobre reconexão e multi-aba
    return () => clearInterval(iv);
  }, [sessionOk]);

  // ── 6. Envia mensagem ─────────────────────────────────────────
  const send = useCallback(async (chatId, text, operatorName) => {
    const now       = new Date();
    const formatted = `${operatorName}: ${text}`;
    const tmpMsg    = {
      id: `tmp-${Date.now()}`, from: "operator", text: formatted,
      time: now.toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }),
      ts: now.toISOString(), chatId, type: "text", operator: operatorName,
    };
    setMessages(prev => {
      const updated = sortMsgs([...(prev[chatId] || []), tmpMsg]);
      _sessionMsgs.set(chatId, updated);
      return { ...prev, [chatId]: updated };
    });
    setChats(prev => {
      const updated = prev.map(c => c.id !== chatId ? c : {
        ...c, lastMsg: formatted, lastTime: tmpMsg.time, lastPatientTs: null, unread: 0,
      });
      persistChats(updated);
      return updated;
    });
    persistChat(chatId, { lastPatientTs: null, unread: 0 });
    if (USE_MOCK) return;
    try {
      await sendText(chatId, formatted);
      // Sincroniza lastMsg do operador para R2 (webhook pode não receber message.any)
      const nowTs = now.getTime();
      fetch("/api/r2-data?type=chats", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": ikey() },
        body: JSON.stringify([{ id: chatId, lastMsg: formatted, lastTs: nowTs, fromMe: true, lastPatientTs: null, unread: 0 }]),
      }).catch(() => {});
    }
    catch (e) {
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).filter(m => m.id !== tmpMsg.id),
      }));
      throw e;
    }
  }, []);

  // ── Apagar/editar mensagem ────────────────────────────────────
  const deleteMsg = useCallback(async (chatId, msgId) => {
    try { await wahaDeleteMessage(chatId, msgId); } catch {}
    setMessages(prev => {
      const updated = (prev[chatId] || []).filter(m => m.id !== msgId);
      _sessionMsgs.set(chatId, updated);
      return { ...prev, [chatId]: updated };
    });
  }, []);

  const editMsg = useCallback(async (chatId, msgId, newText) => {
    try { await wahaEditMessage(chatId, msgId, newText); } catch {}
    setMessages(prev => {
      const updated = (prev[chatId] || []).map(m =>
        m.id === msgId ? { ...m, text: newText, edited: true } : m
      );
      _sessionMsgs.set(chatId, updated);
      return { ...prev, [chatId]: updated };
    });
  }, []);

  // ── 7. Ações ──────────────────────────────────────────────────
  const forwardChat = useCallback((chatId, toRole) => {
    setChats(prev => {
      const updated = prev.map(c => c.id === chatId ? { ...c, assignedTo: toRole, status: "open" } : c);
      persistChats(updated);
      return updated;
    });
    persistChat(chatId, { assignedTo: toRole, status: "open" });
  }, []);

  const resolveChat = useCallback((chatId) => {
    setChats(prev => {
      const chat  = prev.find(c => c.id === chatId);
      const newSt = chat?.status === "resolved" ? "open" : "resolved";
      const updated = prev.map(c => {
        if (c.id !== chatId) return c;
        return {
          ...c,
          status:        newSt,
          // Ao resolver: zera contagem e unread; ao reabrir: mantém zerado
          lastPatientTs: newSt === "resolved" ? null : c.lastPatientTs,
          unread:        newSt === "resolved" ? 0    : c.unread,
        };
      });
      persistChats(updated);
      // Persiste override manual para sobreviver ao reload
      if (newSt === "resolved") {
        saveOverride(chatId, { resolvedAt: Date.now(), readAt: Date.now() });
      } else {
        clearOverride(chatId);
      }
      // Persiste no MongoDB
      persistChat(chatId, {
        status:        newSt,
        lastPatientTs: newSt === "resolved" ? null : undefined,
        unread:        newSt === "resolved" ? 0    : undefined,
      });
      return updated;
    });
  }, []);

  const markRead = useCallback((chatId) => {
    setChats(prev => {
      const updated = prev.map(c =>
        c.id === chatId ? { ...c, unread: 0, lastPatientTs: null } : c
      );
      persistChats(updated);
      return updated;
    });
    // Persiste override manual para sobreviver ao reload
    saveOverride(chatId, { readAt: Date.now() });
    persistChat(chatId, { unread: 0, lastPatientTs: null });
  }, []);

  const markUnread = useCallback((chatId) => {
    setChats(prev => {
      const updated = prev.map(c => c.id === chatId ? { ...c, unread: 1 } : c);
      persistChats(updated);
      return updated;
    });
  }, []);

  const muteChat = useCallback((chatId) => {
    setMutedChats(prev => {
      const next = new Set(prev);
      next.add(chatId);
      try { localStorage.setItem("crm_muted", JSON.stringify([...next])); } catch {}
      return next;
    });
    // Zera unread e lastPatientTs do chat silenciado
    setChats(prev => {
      const updated = prev.map(c => c.id === chatId ? { ...c, unread: 0, lastPatientTs: null } : c);
      persistChats(updated);
      return updated;
    });
  }, []);

  const unmuteChat = useCallback((chatId) => {
    setMutedChats(prev => {
      const next = new Set(prev);
      next.delete(chatId);
      try { localStorage.setItem("crm_muted", JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  // ── Pesquisa em conteúdo de mensagens (cache local) ─────────────
  const searchMessages = useCallback((query) => {
    if (!query || query.length < 3) return [];
    const q = query.toLowerCase();
    const results = [];
    for (const [chatId, msgs] of Object.entries(messages)) {
      const hits = (msgs || []).filter(m => m.text?.toLowerCase().includes(q));
      if (hits.length > 0) {
        const chat = chats.find(c => c.id === chatId);
        results.push({ chatId, chatName: chat?.name || chatId, hits: hits.slice(-3) });
      }
    }
    // Também busca no cache localStorage para chats não carregados
    try {
      for (const [k, v] of Object.entries(localStorage)) {
        if (!k.startsWith(MSGS_PREFIX)) continue;
        const chatId = k.slice(MSGS_PREFIX.length);
        if (results.find(r => r.chatId === chatId)) continue;
        const data = JSON.parse(v);
        const msgs = data?.value || data || [];
        if (!Array.isArray(msgs)) continue;
        const hits = msgs.filter(m => m.text?.toLowerCase().includes(q));
        if (hits.length > 0) {
          const chat = chats.find(c => c.id === chatId);
          results.push({ chatId, chatName: chat?.name || chatId, hits: hits.slice(-3) });
        }
      }
    } catch {}
    return results.slice(0, 20);
  }, [messages, chats]);

  // ── Apagar conversa ──────────────────────────────────────────
  // Remove da lista local e do histórico. Só volta se chegar nova mensagem.
  const deleteChat = useCallback((chatId) => {
    _deletedChats.add(chatId);
    persistDeletedChats();
    _sessionMsgs.delete(chatId);
    setMessages(prev => {
      if (!(chatId in prev)) return prev;
      const next = { ...prev };
      delete next[chatId];
      return next;
    });
    setChats(prev => {
      const updated = prev.filter(c => c.id !== chatId);
      persistChats(updated);
      return updated;
    });
  }, []);

  return {
    chats, setChats,
    messages,
    loadMessages,
    loadOlderMessages,
    send,
    deleteMsg,
    editMsg,
    deleteChat,
    forwardChat,
    resolveChat,
    markRead,
    markUnread,
    searchMessages,
    resyncChats,
    syncChatsToR2: _syncChatsToR2,
    mutedChats,
    muteChat,
    unmuteChat,
    loading,
    error,
    wsStatus,
    myJid,
  };

  // ── Sync de chats para R2 (multi-usuário) — a cada 5 min ────────────────────────────────
  // Envia a lista local enriquecida (nome resolvido, LID→phone, última mensagem) para R2.
  // O servidor faz merge: chats mais recentes vencem, sem apagar dados de outros clientes.
  async function _syncChatsToR2() {
    if (USE_MOCK) return;
    const chats = _sessionChats.value || [];
    if (!chats.length) return;
    const lidCache = lidPhoneMapRef2.current;
    try {
      const payload = chats
        .filter(c => c.id && !c.id.endsWith("@s.whatsapp.net"))
        .map(c => {
          // Resolve ID canônico: @lid → phone@c.us se possível
          let resolvedId = c.id;
          let resolvedPhone = null;
          if (c.id.endsWith("@lid")) {
            const lidOnly = c.id.replace(/@lid$/, "");
            const cached  = lidCache[lidOnly];
            if (cached?.phone) {
              resolvedPhone = cached.phone;
              resolvedId = cached.phone.replace(/\D/g, "") + "@c.us";
            }
          } else if (!c.id.endsWith("@g.us")) {
            resolvedPhone = c.id.replace(/@.*$/, "").replace(/\D/g, "") || null;
          }

          // Nome: usa displayName (via ref para evitar closure stale)
          const name = displayNameRef.current(c.id, c.name || c.pushname, c.pushname) || c.name || c.pushname || null;

          return {
            id:            resolvedId,
            originalId:    resolvedId !== c.id ? c.id : undefined,
            phone:         resolvedPhone,
            pushname:      name || c.pushname || "",
            lastMsg:       c.lastMsg  || "",
            lastTs:        c.lastTs   ? new Date(c.lastTs).getTime() : 0,
            lastPatientTs: c.lastPatientTs ? new Date(c.lastPatientTs).getTime() : null,
            unread:        c.unread   || 0,
            status:        c.status   || "open",
            assignedTo:    c.assignedTo || null,
            tags:          c.tags     || [],
          };
        });

      await fetch("/api/r2-data?type=chats", {
        method:  "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": ikey() },
        body:    JSON.stringify(payload),
      });
      console.log(`[r2-sync] ${payload.length} chats enviados para R2`);
    } catch (e) {
      console.warn("[r2-sync] falha:", e.message);
    }
  }

  // ── Resolução em lote de LIDs — processa TODOS os chats @lid ainda sem phone/nome ──
  // Delega para resolveLidAsync (useContacts) que já tem throttle (MAX_CONCURRENT_LIDS=6)
  // e faz a sequência: LID → phone (@c.us) → nome (Codental/Google)
  function _batchResolveLids() {
    if (USE_MOCK) return;
    const resolve = resolveLidAsyncRef.current;
    const resolveGroup = resolveGroupAsyncRef.current;
    if (typeof resolve !== "function") return;
    const chats = _sessionChats.value || [];
    const lidCache = readLidPhoneMap();
    let queued = 0;
    for (const c of chats) {
      // Grupos: busca nome via WAHA se não tem pushname
      if (c.id?.endsWith("@g.us")) {
        if (!c.name && !c.pushname && typeof resolveGroup === "function") {
          resolveGroup(c.id);
        }
        continue;
      }
      if (!c.id?.endsWith("@lid")) continue;
      const lidOnly = c.id.replace(/@lid$/, "");
      const cached = lidCache[lidOnly];
      // Já tem phone e nome — pula
      if (cached?.phone && cached?.pushName) continue;
      // Tem nome no próprio chat mas sem phone — salva nome e ainda enfileira para resolver phone
      const wahaName = c.name || c.pushname || null;
      if (wahaName && !cached?.pushName) {
        _saveLidResolution(c.id, cached?.phone ? (cached.phone + "@c.us") : null, wahaName);
      }
      // Se já tem phone mas não tem nome, tenta lookup pelo phone
      if (cached?.phone && !cached?.pushName) {
        lookupPhoneRef.current(cached.phone + "@c.us").catch(() => {});
        continue;
      }
      // Sem phone — enfileira para resolução completa (LID → phone → nome)
      resolve(c.id);
      queued++;
    }
    if (queued > 0) console.log(`[lid-batch] ${queued} LIDs enfileirados para resolução`);
  }

  // ── Resync leve (automático, a cada 5 min): R2 + MongoDB, sem WAHA ──
  async function _lightResync() {
    if (USE_MOCK) return;
    try {
      const [r2Res, dbRes] = await Promise.all([
        fetch("/api/r2-data?type=chats", { headers: { "X-Internal-Key": ikey() } })
          .then(r => r.ok ? r.json() : []).catch(() => []),
        fetch(`/api/db?action=chats`, { headers: { "X-Internal-Key": ikey() } })
          .then(r => r.json()).catch(() => ({ chats: {} })),
      ]);
      if (!Array.isArray(r2Res)) return;

      const dbMeta       = dbRes?.chats || {};
      const lidCacheLight = readLidPhoneMap();
      const overrides    = readOverrides();

      setChats(prev => {
        const prevMap = {};
        const prevByPhone = {};
        for (const pc of prev) {
          prevMap[pc.id] = pc;
          const ck = canonicalKey(pc.id, lidCacheLight);
          if (ck) prevByPhone[ck] = pc;
        }
        const r2Map = {};
        for (const c of r2Res) {
          if (!c.id) continue;
          r2Map[c.id] = c;
          const ck = canonicalKey(c.id, lidCacheLight);
          if (ck && ck !== c.id) r2Map[ck] = c;
        }

        const merged = prev.map(c => {
          const ck   = canonicalKey(c.id, lidCacheLight);
          const r2   = r2Map[c.id] || (ck ? r2Map[ck] : undefined);
          const meta = dbMeta[c.id] || dbMeta[c.id.replace(/\D/g,"")] || {};
          if (!r2 && !meta.status) return c;

          const r2TsMs    = r2?.lastTs || 0;
          const localTsMs = c.lastTs ? new Date(c.lastTs).getTime() : 0;
          const isMuted   = mutedChatsRef.current.has(c.id);
          const ov        = ck ? overrides[ck] : (overrides[c.id] || null);
          const r2LptMs   = r2?.lastPatientTs ? new Date(r2.lastPatientTs).getTime() : 0;
          const ovResolved = ov?.resolvedAt && r2LptMs <= ov.resolvedAt;
          const ovRead     = ov?.readAt     && r2LptMs <= ov.readAt;
          const closing    = lastMsgIsClosing(r2?.lastMsg || c.lastMsg);
          const localIsOpen = c.status === "open" && !!c.lastPatientTs;
          const lpt = isMuted || closing || ovRead || ovResolved ? null
            : localIsOpen
              ? c.lastPatientTs
              : (r2LptMs ? new Date(r2LptMs).toISOString() : null);
          const isResolved = closing || ovResolved || (!localIsOpen && c.status === "resolved");
          const unread = isMuted || isResolved || !lpt || ovRead ? 0
            : (r2?.unread !== undefined ? Math.max(r2.unread||0, c.unread||0) : c.unread);

          return {
            ...c,
            lastMsg:       r2TsMs > localTsMs ? (r2.lastMsg || c.lastMsg) : c.lastMsg,
            lastTime:      r2TsMs > localTsMs ? new Date(r2TsMs).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) : c.lastTime,
            lastTs:        r2TsMs > localTsMs ? new Date(r2TsMs).toISOString() : c.lastTs,
            lastPatientTs: isResolved ? null : lpt,
            unread,
            status:        isResolved ? "resolved" : (meta.status || c.status),
            assignedTo:    meta.assignedTo ?? c.assignedTo,
            tags:          meta.tags       ?? c.tags,
            pushname:      r2?.pushname || c.pushname,
          };
        });

        // Adiciona novos chats do R2 não presentes em prev
        const mergedIds    = new Set(merged.map(c => c.id));
        const mergedPhones = new Set(merged.map(c => c.id.replace(/\D/g,"")).filter(d => d.length >= 8));
        for (const r2 of r2Res) {
          if (!r2.id || mergedIds.has(r2.id) || !_isValidNewChatId(r2.id)) continue;
          const rDigits = r2.id.replace(/\D/g,"");
          if (rDigits.length >= 8 && mergedPhones.has(rDigits.slice(-8))) continue;
          const pn = r2.pushname || "";
          const cleanId = r2.id.replace(/@.*$/, "");
          merged.push({
            id: r2.id, name: pn || cleanId, pushname: pn,
            lastMsg: r2.lastMsg || "", lastTs: r2.lastTs ? new Date(r2.lastTs).toISOString() : null,
            lastPatientTs: r2.lastPatientTs || null, unread: r2.unread || 0,
            status: "open", assignedTo: null, tags: [], photoUrl: null,
            avatar: (pn||cleanId||"??").slice(0,2).toUpperCase(), avatarColor: stringToColor(r2.id),
          });
        }

        const deduped = _dedupeChats(merged);
        persistChats(deduped);
        return deduped;
      });

      _batchResolveLids();
    } catch (e) {
      console.error("[light-resync]", e.message);
    }
  }

  // ── Resync completo (botão manual) ──────────────────────────────────────────
  // Busca TODOS os chats do WAHA (sem filtro de data), sem depender do R2 para quantidade
  // R2 só enriquece com unread/lastPatientTs — não limita o resultado
  async function resyncChats() {
    if (USE_MOCK) return;
    console.log("[resync] sincronização completa iniciando...");
    // loadChats(true): reset lastSync + forceFullSync=true → sem filtro de data
    // R2 já é aplicado internamente — não precisa de applyR2Chats() extra
    await loadChats(true);
    console.log("[resync] concluído");
    setTimeout(_syncChatsToR2, 3000);
  }
}

// Persiste metadata de chat no MongoDB (fire-and-forget)
function persistChat(chatId, data) {
  fetch("/api/db?action=chat", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Key": import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10",
    },
    body: JSON.stringify({ chatId, ...data }),
  }).catch(() => {});
}