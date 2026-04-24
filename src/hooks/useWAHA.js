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
  getChats, getMessages, getMessagesPaged, sendText, getSessionStatus,
  normalizeChat, normalizeMessage,
  deleteMessage as wahaDeleteMessage, editMessage as wahaEditMessage,
  sendReaction as wahaSendReaction,
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

const USE_MOCK    = import.meta.env.VITE_USE_MOCK === "true";
const SCAN_HOUR_KEY  = "waha_scan_hour_at";   // varredura 5 dias — 1x/hora
const SCAN_DAY_KEY   = "waha_scan_day_at";    // varredura 100 dias — 1x/dia
function shouldRun(key, intervalMs) {
  try { return Date.now() - parseInt(localStorage.getItem(key) || "0") > intervalMs; } catch { return true; }
}
function markRun(key) {
  try { localStorage.setItem(key, String(Date.now())); } catch {}
}
const CHATS_KEY      = "waha_chats";
const CHATS_TTL      = 30 * 24 * 60 * 60 * 1000; // 30 dias

// Cache de mensagens apenas em memória — não usar localStorage (muito grande, quota exceeded)
// Sobrevive re-renders mas NÃO sobrevive F5 (ok — carrega do WAHA ao abrir o chat)
const _sessionMsgs = new Map(); // chatId → Message[]

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
// Rejeita @s.whatsapp.net e >13 dígitos @c.us (phantom de resolução incorreta)
// @lid é aceito — servidor salva com @lid quando resolução LID falha
function _isValidNewChatId(id) {
  if (!id) return false;
  if (id.endsWith("@s.whatsapp.net")) return false;
  if (!id.endsWith("@g.us") && !id.endsWith("@lid")) {
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
    const digits  = _normalizeDigits(chat.id.replace(/\D/g, ""));
    // Usa os 8 últimos dígitos do número normalizado como chave de dedup
    // (cobre variações de prefixo país/DDD mas não confunde DDDs diferentes)
    const tail8   = digits.length >= 8 ? digits.slice(-8) : null;
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
      // Acumula todos os IDs conhecidos para este número — usado para persistir status em todos os aliases
      const prevAliases = ex.aliases || [];
      const newAliases  = chat.aliases || [];
      const aliases = [...new Set([...prevAliases, ex.id, chat.id, ...newAliases])].filter(a => a !== bestId);
      deduped[existIdx] = {
        ...base,
        id:            bestId,
        aliases,
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
// Normaliza dígitos para a chave canônica — mesma lógica do backend (toChatKey em api/db.js)
function _normalizeDigits(digits) {
  if (!digits) return digits;
  // BR sem o 9: 55 + DDD(2) + 8 digits = 12 → insere 9 após DDD
  if (digits.length === 12 && digits.startsWith("55")) {
    return digits.slice(0, 4) + "9" + digits.slice(4);
  }
  return digits;
}

function canonicalKey(chatId, lidPhoneCache) {
  if (!chatId) return chatId;
  if (chatId.endsWith("@g.us")) return chatId;
  if (chatId.endsWith("@lid")) {
    const lidOnly = chatId.replace(/@lid$/, "");
    const phone = lidPhoneCache?.[lidOnly]?.phone;
    if (phone) return _normalizeDigits(phone.replace(/\D/g, ""));
    return _normalizeDigits(chatId.replace(/\D/g, "")) || chatId;
  }
  return _normalizeDigits(chatId.replace(/\D/g, "")) || chatId;
}

// ── Overrides manuais de status/leitura — sobrevivem ao reload ──────────────
// Estrutura: { [phoneDigitsOrGroupId]: { resolvedAt?, readAt? } }
// resolvedAt: timestamp quando o operador resolveu manualmente
// readAt: timestamp quando o operador marcou como lido (R2 não sobrescreve se lastPatientTs <= readAt)
const OVERRIDE_KEY = "crm_status_overrides";
function readOverrides() {
  try {
    const raw = JSON.parse(localStorage.getItem(OVERRIDE_KEY) || "{}");
    // Migra chaves antigas (dígitos não-normalizados) para o formato canônico atual
    // Necessário após introdução do _normalizeDigits (inserção do 9 BR)
    const normalized = {};
    let changed = false;
    for (const [k, v] of Object.entries(raw)) {
      const nk = k.endsWith("@g.us") ? k : _normalizeDigits(k.replace(/\D/g, "")) || k;
      if (nk !== k) changed = true;
      // Se já existe entrada normalizada, mescla mantendo o mais recente
      if (normalized[nk]) {
        normalized[nk] = {
          resolvedAt: Math.max(normalized[nk].resolvedAt || 0, v.resolvedAt || 0) || undefined,
          readAt:     Math.max(normalized[nk].readAt     || 0, v.readAt     || 0) || undefined,
        };
      } else {
        normalized[nk] = v;
      }
    }
    if (changed) {
      try { localStorage.setItem(OVERRIDE_KEY, JSON.stringify(normalized)); } catch {}
    }
    return normalized;
  } catch { return {}; }
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
// Mensagem de boas-vindas automática enviada pelo WhatsApp móvel — não conta como resposta do operador
function isAutoWelcome(text) {
  if (!text) return false;
  return /^Bem-vindo[ao]? à Odonto On Face/i.test(text.trim());
}

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
      if (isAutoWelcome(m.text)) continue; // boas-vindas automáticas não contam como resposta
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

function detectAutoResolve(msgs) {
  if (!msgs?.length) return false;
  const last5 = msgs.slice(-5);
  // Verifica se última mensagem do operador é de encerramento
  const lastOp = [...last5].reverse().find(m => m.from === "operator");
  if (lastOp && isOperatorClosing(lastOp.text)) return true;
  // Verifica se última mensagem do paciente é despedida
  const lastPatient = [...last5].reverse().find(m => m.from === "patient");
  return lastPatient ? isFarewell(lastPatient.text) : false;
}

export function useWAHA(operator) {
  const [chats,    setChatsRaw]    = useState(() => {
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
  // Wrapper que garante dedup em TODA atualização de state — elimina duplicatas na origem
  const setChats = useCallback((updater) => {
    setChatsRaw(prev => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      if (next === prev) return prev;
      const deduped = _dedupeChats(next);
      // Só gera novo array se algo mudou (evita re-render desnecessário)
      return deduped.length === next.length ? next : deduped;
    });
  }, []);
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
  const { lookupPhone, lookupPhonePriority, searchByName, addLocalContact, resolveName, displayName, lidPhoneMap, resolveLidAsync, resolveGroupAsync: _resolveGroupAsync } = useContactsCtx();
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

  // Auto-resync leve a cada 2.5 minutos + sync R2 + resolução de LIDs
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(() => {
      _lightResync();
      _syncChatsToR2();
      _batchResolveLids();
    }, 2.5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [sessionOk]);

  // Dedup imediato + resync leve ao voltar para a aba (crítico no mobile)
  // No Android Chrome, quando o usuário troca de app e volta, os timers acumulados
  // disparam simultaneamente — dedup antecipado evita flicker de duplicatas visíveis
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    let lastHidden = 0;
    function onVisibility() {
      if (document.visibilityState === "hidden") {
        lastHidden = Date.now();
        return;
      }
      // Voltou para a aba
      const awayMs = Date.now() - lastHidden;
      // Dedup imediato do estado atual (pode ter ficado stale enquanto suspenso)
      setChats(prev => {
        const deduped = _dedupeChats(prev);
        if (deduped.length === prev.length) return prev;
        persistChats(deduped);
        return deduped;
      });
      // Se ficou fora por mais de 30 s, faz resync leve
      if (awayMs > 30_000) {
        _lightResync();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [sessionOk, setChats]);

  async function loadChats(forceFullSync = false) {
    setLoading(true);
    if (forceFullSync) {
      try { localStorage.removeItem(LAST_SYNC_KEY); } catch {}
      console.log("[waha] force full sync: buscando 100 dias de histórico");
    }
    try {
      // ── 1. localStorage — exibe imediatamente sem esperar rede ──
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

      // ── 2. R2 + MongoDB — fonte persistente, mostra "Carregando conversas..." ──
      const [dbRes, r2Res] = await Promise.all([
        fetch(`/api/db?action=chats`, { headers: { "X-Internal-Key": ikey() } })
          .then(r => r.json()).catch(() => ({ chats: {} })),
        fetch("/api/r2-data?type=chats", { headers: { "X-Internal-Key": ikey() } })
          .then(r => r.ok ? r.json() : []).catch(() => []),
      ]);

      const dbMeta  = dbRes?.chats || {};
      const r2Chats = Array.isArray(r2Res) ? r2Res : [];
      const lidPhoneCacheR2 = readLidPhoneMap();

      // Inicializa mutedChats a partir do DB (fonte de verdade multi-usuário)
      const dbMutedIds = Object.entries(dbMeta)
        .filter(([, m]) => m.muted === true)
        .map(([id]) => id);
      if (dbMutedIds.length > 0) {
        setMutedChats(prev => {
          const next = new Set([...prev, ...dbMutedIds]);
          try { localStorage.setItem("crm_muted", JSON.stringify([...next])); } catch {}
          return next;
        });
      }

      // Aplica chats do R2 ao state (mescla com localStorage se já tiver)
      if (r2Chats.length > 0) {
        setChats(prev => {
          const overrides    = readOverrides();
          const prevMap      = new Map(prev.map(c => [c.id, c]));
          const prevByPhone  = {};
          for (const c of prev) {
            const ck = canonicalKey(c.id, lidPhoneCacheR2);
            if (ck) prevByPhone[ck] = c;
          }
          const wahaPhones = new Set(prev.map(c => c.id.replace(/\D/g,"")).filter(d => d.length >= 8));
          const merged = [...prev];

          for (const r2 of r2Chats) {
            if (!_isValidNewChatId(r2.id)) continue;
            const ck      = canonicalKey(r2.id, lidPhoneCacheR2);
            const local   = prevMap.get(r2.id) || (ck ? prevByPhone[ck] : undefined);
            const ov      = ck ? overrides[ck] : (overrides[r2.id] || null);
            const r2LptMs = r2.lastPatientTs ? new Date(r2.lastPatientTs).getTime() : 0;
            const ovResolved = ov?.resolvedAt && r2LptMs <= ov.resolvedAt;
            const ovRead     = ov?.readAt     && r2LptMs <= ov.readAt;
            const isMuted    = mutedChatsRef.current.has(r2.id);
            const closing    = lastMsgIsClosing(r2.lastMsg);
            const lpt        = isMuted || closing || ovRead || ovResolved ? null
              : (r2.lastPatientTs ? new Date(r2.lastPatientTs).toISOString() : null);
            const unread = isMuted || closing || !lpt || ovRead || ovResolved ? 0 : r2.unread || 0;
            // Status: respeita local (pode estar "resolved" por ação do operador),
            // só força "resolved" se closing/ovResolved, nunca força "open" sobre um resolved local
            const localResolved = local?.status === "resolved";
            const status = closing || ovResolved || localResolved ? "resolved" : (local?.status || "open");

            if (local) {
              // Atualiza chat existente com dados mais recentes do R2
              const idx = merged.findIndex(c => c.id === local.id);
              if (idx >= 0) {
                const localTsMs = local.lastTs ? new Date(local.lastTs).getTime() : 0;
                const r2TsMs    = r2.lastTs || 0;
                const bestTsMs  = Math.max(localTsMs, r2TsMs);
                merged[idx] = {
                  ...merged[idx],
                  lastMsg:       r2TsMs >= localTsMs ? (r2.lastMsg || local.lastMsg) : local.lastMsg,
                  lastTs:        bestTsMs ? new Date(bestTsMs).toISOString() : local.lastTs,
                  lastPatientTs: lpt ?? local.lastPatientTs,
                  unread:        Math.max(unread, local.unread || 0),
                  pushname:      local.pushname || r2.pushname,
                  status,
                };
              }
            } else {
              // Chat novo que não estava no localStorage
              const rDigits = r2.id.replace(/\D/g,"");
              const dupByPhone = rDigits.length >= 8 && (wahaPhones.has(rDigits.slice(-8)) ||
                merged.some(c => c.id.replace(/\D/g,"").slice(-8) === rDigits.slice(-8)));
              if (dupByPhone) continue;
              const meta = dbMeta[r2.id] || {};
              merged.push({
                id:            r2.id,
                name:          r2.pushname || meta.pushname || "",
                pushname:      r2.pushname || meta.pushname || "",
                lastMsg:       r2.lastMsg  || "",
                lastTs:        r2.lastTs   ? new Date(r2.lastTs).toISOString() : null,
                lastPatientTs: lpt,
                unread,
                status:        meta.status || status,
                assignedTo:    meta.assignedTo || null,
                tags:          meta.tags       || [],
                photoUrl:      null,
              });
              if (rDigits.length >= 8) wahaPhones.add(rDigits.slice(-8));
            }
          }
          const deduped = _dedupeChats(merged);
          console.log(`[r2] chatlist aplicado: ${deduped.length} chats`);
          persistChats(deduped);
          return deduped;
        });
      }

      // R2 carregado — esconde "Carregando conversas..."
      setLoading(false);

      // ── 3. WAHA — enriquece em background após R2 já exibido ──
      let fromTs = null;
      const lastSync = getLastSyncTs();
      if (lastSync > 0) {
        const msSinceSync = Date.now() - lastSync;
        const msToFetch   = msSinceSync + 86400000;
        const daysToFetch = Math.min(Math.ceil(msToFetch / 86400000), 100);
        fromTs = Math.floor((Date.now() - daysToFetch * 86400000) / 1000);
        console.log(`[waha] última sync: ${new Date(lastSync).toLocaleString()} — buscando últimos ${daysToFetch} dias`);
      } else {
        fromTs = Math.floor((Date.now() - 100 * 86400000) / 1000);
        console.log("[waha] first load: buscando últimos 100 dias");
      }

      const raw = await getChats();

      if (!Array.isArray(raw)) return;
      console.log(`[waha] ${raw.length} chats recebidos do WAHA`);

      // forceFullSync: sem filtro de data — pega TUDO que o WAHA tem
      // Carga normal: filtra por fromTs para não reprocessar chats muito antigos
      const filtered = forceFullSync
        ? raw
        : (fromTs
          ? raw.filter(c => {
              const lm = c.lastMessage;
              const ts = lm?.timestamp || lm?.t || 0;
              return ts === 0 || ts >= fromTs;
            })
          : raw);
      console.log(`[waha] ${filtered.length} chats após filtro de data`);

      // R2: mapa indexado por id E por dígitos de telefone (webhook usa @lid, WAHA usa @c.us)
      const r2Map  = {};
      if (Array.isArray(r2Res)) {
        const lidCacheForR2 = readLidPhoneMap();
        for (const c of r2Res) {
          r2Map[c.id] = c;
          const ck = canonicalKey(c.id, lidCacheForR2);
          if (ck && ck !== c.id) r2Map[ck] = c;
        }
      }
      console.log(`[r2] ${Object.keys(r2Map).length} chats no R2`);

      const normalized = filtered.map(c => {
        const n    = normalizeChat(c);
        const meta = dbMeta[n.id] || dbMeta[n.id.replace(/\D/g, "")] || {};
        return { ...n, ...meta };
      });

      // Mescla com cache local — cache local TEM PRIORIDADE sobre WAHA
      // O WAHA não conhece status/resolved/lastPatientTs — só o local sabe
      // Auto-resolve 30 dias também feito aqui dentro para garantir estado correto
      const TRINTA_DIAS = 30 * 24 * 60 * 60 * 1000;
      const agora = Date.now();
      const toAutoResolveIds = new Set();

      setChats(prev => {
        const lidPhoneCache = readLidPhoneMap();
        const overrides = readOverrides();
        // prevMap indexado por id E por chave canônica (dígitos do telefone)
        // Garante que WAHA retornando @c.us encontre entrada salva como @lid (ou vice-versa)
        const prevMap = {};
        const prevByPhone = {};
        for (const c of prev) {
          prevMap[c.id] = c;
          const ck = canonicalKey(c.id, lidPhoneCache);
          if (ck) prevByPhone[ck] = c;
        }
        const merged  = normalized.map(n => {
          const ck = canonicalKey(n.id, lidPhoneCache);
          const local   = prevMap[n.id] || (ck ? prevByPhone[ck] : undefined);
          const r2      = r2Map[n.id] || (ck ? r2Map[ck] : undefined);
          const isMuted = mutedChatsRef.current.has(n.id);

          // Seleciona melhor lastTs / lastMsg entre WAHA, R2 e local
          const wahaTsMs  = n.lastTs     ? new Date(n.lastTs).getTime()     : 0;
          const r2TsMs    = r2?.lastTs   || 0;
          const localTsMs = local?.lastTs ? new Date(local.lastTs).getTime() : 0;
          const bestTsMs  = Math.max(wahaTsMs, r2TsMs, localTsMs);
          const bestLastTs = bestTsMs ? new Date(bestTsMs).toISOString() : (n.lastTs || local?.lastTs);
          const bestLastMsg = r2TsMs > wahaTsMs && r2TsMs > localTsMs && r2?.lastMsg ? r2.lastMsg
            : wahaTsMs >= r2TsMs && n.lastMsg ? n.lastMsg
            : local?.lastMsg || n.lastMsg || r2?.lastMsg || "";

          // Override manual do operador (markRead / resolveChat) — keyed por dígitos canônicos
          const ov = ck ? overrides[ck] : (overrides[n.id] || null);
          const r2LptMs = r2?.lastPatientTs ? new Date(r2.lastPatientTs).getTime() : 0;
          // resolvedAt: considerado válido se não há nova mensagem do paciente após o override
          const ovResolved = ov?.resolvedAt && r2LptMs <= ov.resolvedAt;
          // readAt: considerado válido se não há nova mensagem do paciente após o override
          const ovRead = ov?.readAt && r2LptMs <= ov.readAt;

          // Chat novo sem histórico local — usa WAHA + R2 (mas aplica overrides)
          if (!local) {
            const r2Lpt  = r2?.lastPatientTs ? new Date(r2.lastPatientTs).toISOString() : null;
            const lpt    = isMuted ? null : r2Lpt;
            const closing = lastMsgIsClosing(bestLastMsg);
            const unread  = isMuted || closing || !lpt || ovRead || ovResolved ? 0 : r2?.unread || 0;
            const entry   = { ...n, lastMsg: bestLastMsg, lastTs: bestLastTs, lastPatientTs: closing || ovRead || ovResolved ? null : lpt, unread };
            const should30 = lpt && agora - new Date(lpt).getTime() > TRINTA_DIAS;
            if (closing || should30 || ovResolved) {
              if (closing || should30) toAutoResolveIds.add(entry.id);
              return { ...entry, status: "resolved", unread: 0, lastPatientTs: null };
            }
            return entry;
          }

          // Chat existente — preserva estado local, atualiza com fontes mais recentes
          const resolvedLocally = local.status === "resolved" || ovResolved;
          const closing = lastMsgIsClosing(bestLastMsg);
          const r2Lpt   = r2?.lastPatientTs !== undefined
            ? (r2?.lastPatientTs ? new Date(r2.lastPatientTs).getTime() : null) : undefined;
          const localLpt = local.lastPatientTs ? new Date(local.lastPatientTs).getTime() : null;
          const lpt = isMuted || resolvedLocally || closing || ovRead ? null
            : r2Lpt !== undefined
              ? (r2Lpt ? new Date(Math.max(r2Lpt, localLpt || 0)).toISOString() : null)
              : (local.lastPatientTs ?? null);
          const should30 = !resolvedLocally && !closing && lpt &&
            agora - new Date(lpt).getTime() > TRINTA_DIAS;
          const shouldAutoResolve = closing || should30;
          if (shouldAutoResolve && !resolvedLocally) toAutoResolveIds.add(n.id);

          const unread = isMuted || shouldAutoResolve || resolvedLocally || !lpt || ovRead ? 0
            : r2?.unread !== undefined
              ? Math.max(r2.unread || 0, local.unread || 0)
              : (local.unread ?? n.unread ?? 0);

          return {
            ...n,
            lastMsg:       bestLastMsg,
            lastTs:        bestLastTs,
            lastPatientTs: (resolvedLocally || shouldAutoResolve || ovRead) ? null : lpt,
            unread,
            status:        (shouldAutoResolve || ovResolved) && !resolvedLocally ? "resolved"
                           : resolvedLocally ? "resolved"
                           : (local.status ?? n.status),
            assignedTo:    local.assignedTo  ?? n.assignedTo,
            photoUrl:      local.photoUrl    ?? null,
            tags:          local.tags        ?? n.tags,
            pushname:      n.pushname || local.pushname || r2?.pushname,
          };
        });

        // ── CRÍTICO: preserva chats locais que o WAHA não retornou (mais antigos que fromTs)
        const wahaIds = new Set(normalized.map(c => c.id));
        const wahaPhones = new Set(normalized.map(c => c.id.replace(/\D/g, "")).filter(d => d.length >= 8));
        for (const c of prev) {
          if (!wahaIds.has(c.id)) merged.push(c); // preserva sem modificar
        }

        // ── Sessão nova (prev vazio): adiciona chats do R2 que WAHA não retornou
        // Garante que num computador novo, chats históricos do webhook apareçam imediatamente
        if (prev.length === 0) {
          const r2Chats = Array.isArray(r2Res) ? r2Res : [];
          for (const r2 of r2Chats) {
            if (wahaIds.has(r2.id)) continue; // já processado pelo WAHA
            if (!_isValidNewChatId(r2.id)) continue;
            const rDigits = r2.id.replace(/\D/g, "");
            // Evita duplicata por telefone (tail-8)
            const dupByPhone = rDigits.length >= 8 && (wahaPhones.has(rDigits.slice(-8)) ||
              merged.some(c => {
                const cd = c.id.replace(/\D/g, "");
                return cd.length >= 8 && cd.slice(-8) === rDigits.slice(-8);
              }));
            if (dupByPhone) continue;
            const r2Ck = canonicalKey(r2.id, lidPhoneCache);
            const ov = r2Ck ? overrides[r2Ck] : null;
            const r2LptMs = r2.lastPatientTs ? new Date(r2.lastPatientTs).getTime() : 0;
            const ovResolved = ov?.resolvedAt && r2LptMs <= ov.resolvedAt;
            const ovRead = ov?.readAt && r2LptMs <= ov.readAt;
            const isMuted = mutedChatsRef.current.has(r2.id);
            const closing = lastMsgIsClosing(r2.lastMsg);
            const lpt = isMuted || closing || ovRead || ovResolved ? null
              : (r2.lastPatientTs ? new Date(r2.lastPatientTs).toISOString() : null);
            const unread = isMuted || closing || !lpt || ovRead || ovResolved ? 0 : r2.unread || 0;
            const status = closing || ovResolved ? "resolved" : "open";
            merged.push({
              id:            r2.id,
              name:          r2.pushname || "",
              pushname:      r2.pushname || "",
              lastMsg:       r2.lastMsg  || "",
              lastTs:        r2.lastTs   ? new Date(r2.lastTs).toISOString() : null,
              lastPatientTs: lpt,
              unread,
              status,
              assignedTo:    null,
              tags:          [],
              photoUrl:      null,
            });
            wahaPhones.add(rDigits.slice(-8));
          }
          // Também adiciona chats do MongoDB que têm metadados mas não estão no WAHA ou R2
          for (const [chatId, meta] of Object.entries(dbMeta)) {
            if (wahaIds.has(chatId)) continue;
            if (!_isValidNewChatId(chatId)) continue;
            const mDigits = chatId.replace(/\D/g, "");
            const dupByPhone = mDigits.length >= 8 && (wahaPhones.has(mDigits.slice(-8)) ||
              merged.some(c => c.id.replace(/\D/g,"").slice(-8) === mDigits.slice(-8)));
            if (dupByPhone) continue;
            merged.push({
              id:            chatId,
              name:          meta.pushname || "",
              pushname:      meta.pushname || "",
              lastMsg:       meta.lastMsg  || "",
              lastTs:        meta.lastTs   || null,
              lastPatientTs: null,
              unread:        0,
              status:        meta.status   || "open",
              assignedTo:    meta.assignedTo || null,
              tags:          meta.tags       || [],
              photoUrl:      null,
            });
            if (mDigits.length >= 8) wahaPhones.add(mDigits.slice(-8));
          }
        }

        // ── Deduplica por tail-8 de telefone (cobre @lid resolvido, formato antigo/novo BR)
        // e filtra chats apagados pelo operador + IDs inválidos (@lid, >13 dígitos)
        const deduped = _dedupeChats(merged);
        console.log(`[waha] loadChats setChats: prev=${prev.length} merged=${merged.length} deduped=${deduped.length}`);

        persistChats(deduped);
        // Persiste auto-resolves (30 dias + Consulta confirmada) no localStorage e MongoDB
        if (toAutoResolveIds.size > 0) {
          console.log(`[waha] auto-resolve: ${toAutoResolveIds.size} chats (30 dias ou mensagem de fechamento)`);
          const now = Date.now();
          // Salva override no localStorage para sobreviver ao reload
          for (const id of toAutoResolveIds) {
            saveOverride(id, { resolvedAt: now, readAt: now });
          }
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

      // Carrega fotos de perfil em background após renderização inicial
      setTimeout(() => loadProfilePictures(normalized.map(c => c.id)), 1000);

      // Carrega última mensagem dos chats sem lastMsg (resolve "Sem mensagens recentes")
      // Limita aos 15 mais recentes — em lotes de 3 com 500ms intervalo
      const semMsg = normalized
        .filter(c => !c.lastMsg && c.lastTs)
        .sort((a, b) => {
          const ta = new Date(a.lastTs).getTime();
          const tb = new Date(b.lastTs).getTime();
          return tb - ta;
        })
        .slice(0, 15)
        .map(c => c.id);

      if (semMsg.length > 0) {
        console.log(`[waha] loadLastMessages para ${semMsg.length} chats`);
        setTimeout(() => loadLastMessages(semMsg), 1000);
      }

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
            if (allNorm[j].from === "operator") {
              if (isAutoWelcome(allNorm[j].text)) continue; // boas-vindas automáticas não contam
              break;
            }
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

  // ── Auto-sync contatos: busca chatlist direto no WAHA e resolve nomes ──
  // Chats individuais (não grupos) sem contato mapeado são pesquisados por telefone/nome
  async function autoSyncContacts(dias) {
    if (USE_MOCK) return;
    const SESSION = import.meta.env.VITE_WAHA_SESSION || "default";
    const fromTs  = Math.floor((Date.now() - dias * 86400000) / 1000);

    console.log(`[auto-sync] buscando chats dos últimos ${dias} dias direto no WAHA`);
    let rawChats = [];
    try {
      const r = await fetch(
        `/api/waha?path=${encodeURIComponent(`/api/${SESSION}/chats`)}&limit=500`,
        { headers: { "X-Internal-Key": ikey() } }
      );
      if (!r.ok) return;
      const all = await r.json();
      if (!Array.isArray(all)) return;
      rawChats = all.filter(c => {
        const ts = c.lastMessage?.timestamp || c.lastMessage?.t || 0;
        return !c.isGroup && (ts === 0 || ts >= fromTs);
      });
    } catch (e) {
      console.error("[auto-sync] erro ao buscar chats:", e.message);
      return;
    }

    const chats = rawChats.map(c => normalizeChat(c));
    console.log(`[auto-sync] ${chats.length} chats para verificar (${dias} dias)`);

    let found = 0;
    for (let i = 0; i < chats.length; i += 3) {
      const batch = chats.slice(i, i + 3);
      await Promise.allSettled(batch.map(async (chat) => {
        if (resolveName(chat.id, null)) return; // já tem nome
        let ok = false;
        try { ok = !!(await lookupPhone(chat.id).catch(() => null)); } catch {}
        if (ok) { found++; return; }
        const nome = chat.pushname || chat.name || null;
        if (nome) {
          try { ok = !!(await searchByName(nome).catch(() => false)); } catch {}
          if (ok) { found++; }
        }
      }));
      if (i + 3 < chats.length) await new Promise(r => setTimeout(r, 200));
    }
    console.log(`[auto-sync] concluído: ${found} novos contatos encontrados (${dias} dias)`);
  }

  // Varredura horária: últimos 5 dias
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    function run() {
      if (!shouldRun(SCAN_HOUR_KEY, 60 * 60 * 1000)) return;
      markRun(SCAN_HOUR_KEY);
      autoSyncContacts(5).catch(e => console.error("[auto-sync 5d]", e?.message));
    }
    run(); // executa imediatamente ao iniciar
    const iv = setInterval(run, 60 * 60 * 1000); // a cada 1h
    return () => clearInterval(iv);
  }, [sessionOk]);

  // Varredura diária: últimos 100 dias
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    function run() {
      if (!shouldRun(SCAN_DAY_KEY, 24 * 60 * 60 * 1000)) return;
      markRun(SCAN_DAY_KEY);
      autoSyncContacts(100).catch(e => console.error("[auto-sync 100d]", e?.message));
    }
    run(); // executa imediatamente ao iniciar (se passou 1 dia)
    const iv = setInterval(run, 60 * 60 * 1000); // checa a cada hora se já passou 1 dia
    return () => clearInterval(iv);
  }, [sessionOk]);

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
          const deduped = _dedupeChats([newChat, ...prev]);
          persistChats(deduped);
          return deduped;
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
      const newChat = normalizeChat(payload);
      if (!newChat?.id) return;
      if (!_isValidChatId(newChat.id)) return;
      setChats(prev => {
        // Só ignora se o ID exato já existe — deixa _dedupeChats resolver telefones duplicados
        // (não usa tail-8 aqui para evitar falso-positivo com DDDs diferentes)
        if (prev.some(c => c.id === newChat.id)) return prev;
        const deduped = _dedupeChats([newChat, ...prev]);
        persistChats(deduped);
        return deduped;
      });
      loadLastMessages([newChat.id]);
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
        const msgId  = payload.before?.id || payload.id || payload._data?.id?.id;
        const chatId = (payload.before?.chatId || payload.chatId || payload.key?.remoteJid || payload.from || "")
          .replace(/:\d+(@\S+)?$/, "");
        if (msgId && chatId) {
          setMessages(prev => {
            const cur = prev[chatId];
            if (!cur) return prev;
            // Risca a mensagem em vez de removê-la
            const updated = cur.map(m => m.id === msgId ? { ...m, revoked: true } : m);
            _sessionMsgs.set(chatId, updated);
            return { ...prev, [chatId]: updated };
          });
        }
      } else if (event === "message.reaction") {
        const emoji    = payload.reaction?.emoji ?? payload.reactionMessage?.text ?? payload.body ?? null;
        const targetId = payload.reaction?.targetMessageId
          ?? payload.reactionMessage?.key?.id
          ?? payload.reactedMessageId ?? null;
        const rawChatId = (payload.chatId || payload.from || payload.reactionMessage?.key?.remoteJid || "")
          .replace(/:\d+(@\S+)?$/, "");
        const fromMe   = payload.fromMe ?? false;
        const reactorId = rawChatId || (fromMe ? "me" : "unknown");
        if (targetId && rawChatId) {
          setMessages(prev => {
            // Encontra a chave real no state pelo chatId ou por tail-8 de telefone
            const digits = rawChatId.replace(/\D/g, "");
            const tail8  = digits.slice(-8);
            const key = Object.keys(prev).find(k => k === rawChatId
              || (tail8.length >= 8 && k.replace(/\D/g, "").slice(-8) === tail8));
            if (!key) return prev;
            const cur = prev[key];
            const updated = cur.map(m => {
              if (m.id !== targetId) return m;
              const reactions = { ...(m.reactions || {}) };
              for (const e of Object.keys(reactions)) {
                reactions[e] = reactions[e].filter(u => u.id !== reactorId);
                if (reactions[e].length === 0) delete reactions[e];
              }
              if (emoji) {
                reactions[emoji] = [...(reactions[emoji] || []), { id: reactorId, fromMe }];
              }
              return { ...m, reactions };
            });
            _sessionMsgs.set(key, updated);
            return { ...prev, [key]: updated };
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

  // Converte mensagem do R2 (formato webhook) para formato do app
  function normalizeR2Msg(m) {
    const tsMs = typeof m.ts === "number" ? m.ts : (m.ts ? new Date(m.ts).getTime() : 0);
    const t    = (m.type || "").toLowerCase();
    const MEDIA_TYPES = ["image","video","audio","voice","document","sticker","ptt"];
    // Detecta mídia também por mediaUrl ou wahaShortId (quando type="text" mas tem mídia no NOWEB)
    const hasMedia = MEDIA_TYPES.includes(t) || !!(m.mediaUrl || m.wahaShortId);
    const shortMsgId = (() => {
      const raw = m.id;
      if (typeof raw !== "string" || !raw.includes("_")) return raw;
      const parts = raw.split("_");
      return [...parts].reverse().find(p => !p.includes("@")) || raw;
    })();
    // Prioriza wahaShortId (WAHA download-media) sobre shortMsgId (Baileys format)
    const msgId = m.wahaShortId || shortMsgId;
    // Restaura replyTo salvo pelo webhook
    const rt = m.replyTo || null;
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
      } : null,
    } : null;

    return {
      id:       m.id,
      chatId:   m.chatId,
      from:     m.fromMe ? "operator" : "patient",
      text:     m.body || "",
      type:     m.type || "chat",
      ts:       tsMs ? new Date(tsMs).toISOString() : null,
      time:     tsMs ? new Date(tsMs).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }) : "",
      hasMedia,
      pushname: m.pushname || "",
      replyTo,
      revoked:  m.revoked || false,
      reactions: m.reactions || null,
      media:    hasMedia ? {
        msgId,
        type:     MEDIA_TYPES.includes(t) ? t : "document", // fallback "document" — NOWEB armazena type="text" p/ arquivos
        mimetype: m.mimetype ||
                  (t === "audio" || t === "ptt" || t === "voice" ? "audio/ogg" :
                  t === "image"   ? "image/jpeg" :
                  t === "sticker" ? "image/webp" :
                  t === "video"   ? "video/mp4"  :
                  t === "document"? "application/octet-stream" :
                  m.mediaUrl?.includes("video") ? "video/mp4" :
                  m.mediaUrl?.includes("/api/r2-data") ? "application/octet-stream" :
                  "image/jpeg"),
        url:      m.mediaUrl || null,
        thumbUrl: null,
      } : null,
    };
  }

  // ── 4. loadMessages — abre ChatWindow: R2 primeiro, WAHA completa ──
  const loadMessages = useCallback(async (chatId) => {
    activeChatRef.current = chatId;
    // Token único por chamada — evita que chamadas concorrentes (mobile: crm:open-chat)
    // sobrescrevam o state com dados de uma execução anterior/paralela
    const token = Date.now() + Math.random();
    activeChatRef.token = token;
    console.log(`[load-msgs] OPEN chatId=${chatId}`);
    delete seenMsgIds.current[chatId];
    try {
      const existing = resolveName(chatId, null);
      if (!existing && typeof lookupPhonePriority === "function") {
        lookupPhonePriority(chatId).then(name => {
          if (name) console.log(`[contacts] on-demand ${chatId} → ${name}`);
        }).catch(() => {});
      }
    } catch {}

    const dbg = (step, info) => console.log(`[load-msgs] ${step} | chat=${chatId.replace(/@.*/,'')} | ${info}`);
    const lastTs = (msgs) => {
      if (!msgs?.length) return "vazio";
      const last = msgs[msgs.length - 1];
      return `${msgs.length} msgs | última: ${last?.time || last?.ts?.slice(11,16) || "?"} | id=...${String(last?.id||"").slice(-8)}`;
    };

    // ── 1. Memória: exibe imediatamente se já carregou antes ──
    const cached = _sessionMsgs.get(chatId);
    if (cached?.length) {
      dbg("1-MEM", `usando cache memória → ${lastTs(cached)}`);
      setMessages(prev => ({ ...prev, [chatId]: cached }));
    } else {
      dbg("1-MEM", "sem cache em memória");
    }

    if (USE_MOCK) {
      setMessages(prev => ({ ...prev, [chatId]: MOCK_MESSAGES[chatId] || [] }));
      return;
    }

    try {
      // ── 2. R2: fonte primária — horários e mídias confiáveis ──
      const r2Raw = await fetch(`/api/r2-data?type=msgs&chatId=${encodeURIComponent(chatId)}`, {
        headers: { "X-Internal-Key": ikey() }
      }).then(r => r.ok ? r.json() : []).catch(() => []);

      const r2Msgs = Array.isArray(r2Raw)
        ? sortMsgs(r2Raw.map(m => normalizeR2Msg(m.chatId ? m : { chatId, ...m })))
        : [];

      // Limpa flags de falha para mídias que o R2 confirmou terem wahaShortId
      // (evita que tentativas anteriores frustradas bloqueiem re-tentativas após sync)
      const _MEDIA_PFX = "crm_media_";
      for (const raw of (Array.isArray(r2Raw) ? r2Raw : [])) {
        if (raw.wahaShortId) {
          try { localStorage.removeItem(_MEDIA_PFX + raw.wahaShortId + "_fail"); } catch {}
        }
      }

      const r2Ids = new Set(r2Msgs.map(m => m.id));
      const r2Media = r2Msgs.filter(m => m.hasMedia || m.media).length;
      dbg("2-R2", `${lastTs(r2Msgs)} | com mídia=${r2Media} | token=${activeChatRef.token === token ? "ok" : "EXPIRADO"}`);

      if (r2Msgs.length > 0 && activeChatRef.token === token) {
        setMessages(prev => {
          if (activeChatRef.token !== token) return prev;
          const prevMsgs = prev[chatId] || [];
          const prevById = new Map(prevMsgs.map(m => [m.id, m]));
          const prevMedia = prevMsgs.filter(m => m.hasMedia || m.media).length;
          // R2 para horário/texto — preserva mídia do cache se R2 não tem
          const r2WithMedia = r2Msgs.map(m => {
            const cached = prevById.get(m.id);
            if (!cached) return m;
            return (cached.media || cached.hasMedia)
              ? { ...m, media: cached.media, hasMedia: cached.hasMedia, type: cached.type || m.type }
              : m;
          });
          const wsExtras = prevMsgs.filter(m => !r2Ids.has(m.id) && !m.id.startsWith("tmp-"));
          const merged = sortMsgs([...r2WithMedia, ...wsExtras]);
          const mergedMedia = merged.filter(m => m.hasMedia || m.media).length;
          console.log(`[load-msgs] 2-R2-SET | prev.mídia=${prevMedia} → merged.mídia=${mergedMedia} | wsExtras=${wsExtras.length}`);
          const r2MediaSample = merged.filter(m => m.hasMedia||m.media).slice(0,3).map(m=>`id=...${String(m.id||"").slice(-10)} type=${m.type} url=${m.media?.url?"sim":"não"}`);
          if (r2MediaSample.length) console.log(`[load-msgs] 2-R2-SET mídias:`, r2MediaSample);
          _sessionMsgs.set(chatId, merged);
          return { ...prev, [chatId]: merged };
        });
      }

      // ── 3. WAHA: completa com mensagens que R2 não tem ──
      if (activeChatRef.current !== chatId || activeChatRef.token !== token) {
        dbg("3-WAHA", "ABORTADO — token expirado ou chat trocado");
        return;
      }
      const raw      = await getMessages(chatId, 60);
      const wahaMsgs = sortMsgs(raw.map(normalizeMessage));
      const wahaById = new Map(wahaMsgs.map(m => [m.id, m]));
      const wahaMedia = wahaMsgs.filter(m => m.hasMedia || m.media).length;
      dbg("3-WAHA", `${lastTs(wahaMsgs)} | com mídia=${wahaMedia} | token=${activeChatRef.token === token ? "ok" : "EXPIRADO"}`);

      if (activeChatRef.token !== token) return;

      // Índice por ID exato
      // Fallback por timestamp+direção: R2 e WAHA usam hexes diferentes no mesmo campo "id"
      // (webhook salva IDs do formato @c.us/Baileys; getMessages retorna @lid/servidor)
      // então a única forma de correlacionar é pelo segundo do timestamp + fromMe
      const wahaByTs = new Map();
      for (const w of wahaMsgs) {
        if (!w.ts || !(w.hasMedia || w.media)) continue; // só indexa mensagens com mídia
        const tsS = Math.floor(new Date(w.ts).getTime() / 1000);
        const key = `${w.from}_${tsS}`;
        if (!wahaByTs.has(key)) wahaByTs.set(key, w);
      }
      const getWaha = (id, m) => {
        const byId = wahaById.get(id);
        if (byId) return byId;
        // Fallback: timestamp + direção (quando IDs têm formatos distintos)
        if (m?.ts) {
          const tsS = Math.floor(new Date(m.ts).getTime() / 1000);
          const byTs = wahaByTs.get(`${m.from}_${tsS}`);
          if (byTs) return byTs;
        }
        return undefined;
      };

      setMessages(prev => {
        if (activeChatRef.token !== token) return prev;
        const existing = prev[chatId] || [];
        const existIds = new Set(existing.map(m => m.id));
        const existMedia = existing.filter(m => m.hasMedia || m.media).length;

        // R2 é base para horário/texto — WAHA completa mídia ausente no R2
        const r2Merged = existing.filter(m => r2Ids.has(m.id)).map(m => {
          const waha = getWaha(m.id, m);
          if (!waha) return m;
          const media    = m.media || (waha.hasMedia ? waha.media : null);
          const hasMedia = m.hasMedia || waha.hasMedia || false;
          // WAHA type é autoritativo para mídia — corrige tipo errado salvo no R2 (ex: "image" em vez de "document")
          const wahaType = waha.type && waha.type !== "text" && waha.type !== "chat" ? waha.type : null;
          const type     = wahaType || m.type;
          // replyTo: preserva de qualquer fonte que tenha
          const replyTo  = m.replyTo || waha.replyTo || null;
          return { ...m, media, hasMedia, type, replyTo };
        });

        // Mensagens só no WAHA e não vistas antes
        const wahaExtras = wahaMsgs.filter(m => !r2Ids.has(m.id) && !existIds.has(m.id));
        // Mensagens que não estão no R2 mas estão no state (WS/cache) — usa versão WAHA se disponível (tem mídia)
        // Preserva replyTo da versão WS/cache se a WAHA não trouxer
        const wsExtras = existing
          .filter(m => !r2Ids.has(m.id) && !m.id.startsWith("tmp-"))
          .map(m => {
            const waha = getWaha(m.id, m);
            if (!waha) return m;
            return { ...waha, replyTo: m.replyTo || waha.replyTo || null };
          });

        const merged     = sortMsgs([...r2Merged, ...wahaExtras, ...wsExtras]);
        const mergedMedia = merged.filter(m => m.hasMedia || m.media).length;
        console.log(`[load-msgs] 3-WAHA-SET | exist=${existing.length}(mídia=${existMedia}) r2Merged=${r2Merged.length} wahaExtras=${wahaExtras.length} wsExtras=${wsExtras.length} → final=${merged.length}(mídia=${mergedMedia})`);
        const finalMediaSample = merged.filter(m => m.hasMedia||m.media).slice(0,3).map(m=>`id=...${String(m.id||"").slice(-10)} type=${m.type} url=${m.media?.url?"sim":"não"}`);
        if (finalMediaSample.length) console.log(`[load-msgs] 3-WAHA-SET mídias:`, finalMediaSample);
        _sessionMsgs.set(chatId, merged);
        return { ...prev, [chatId]: merged };
      });

      // Persiste mídia de volta ao R2 para sobreviver F5 (fire-and-forget)
      // O endpoint faz merge por ID exato e fallback por timestamp+fromMe — sem duplicatas
      {
        const toSave = wahaMsgs
          .filter(w => w.hasMedia || w.media)
          .map(w => ({
            id:          w.id,
            chatId:      chatId, // sempre @c.us — não usa w.chatId que pode ser @lid
            ts:          w.ts ? new Date(w.ts).getTime() : 0,
            fromMe:      w.from === "operator",
            body:        w.text || "",
            // Usa media.type quando type="text" (NOWEB engine retorna type errado para mídias)
            type:        (w.media?.type && w.media.type !== "text") ? w.media.type : (w.type !== "text" && w.type !== "chat" ? w.type : "image"),
            pushname:    w.pushname || "",
            wahaShortId: w.media?.msgId || null,
            // Salva media.url mesmo que seja proxied — é estável enquanto WAHA server está vivo
            mediaUrl:    w.media?.url && !w.media.url.startsWith("data:") ? w.media.url : null,
          }));
        if (toSave.length > 0) {
          fetch(`/api/r2-data?type=msgs&chatId=${encodeURIComponent(chatId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Internal-Key": ikey() },
            body: JSON.stringify(toSave),
          }).catch(() => {});
        }
      }

      // Atualiza metadata do chat usando lista final mesclada
      const allMsgs   = sortMsgs([...r2Msgs, ...wahaMsgs.filter(m => !r2Ids.has(m.id))]);
      const lastAny   = allMsgs[allMsgs.length - 1];
      const lastOpIdx = allMsgs.map(m => m.from).lastIndexOf("operator");
      const lastPIdx  = allMsgs.map(m => m.from).lastIndexOf("patient");
      const semResp   = lastOpIdx === -1
        ? allMsgs.filter(m => m.from === "patient")
        : allMsgs.slice(lastOpIdx + 1).filter(m => m.from === "patient");
      const ultimoFoiOp = lastOpIdx > lastPIdx || lastPIdx === -1;
      const autoResolve = detectAutoResolve(allMsgs);
      const novoLPTs    = (ultimoFoiOp || autoResolve) ? null : (semResp[0]?.ts || null);

      setChats(prev => {
        const ex      = prev.find(c => c.id === chatId);
        const updated = prev.map(c => c.id !== chatId ? c : {
          ...c,
          lastMsg:       lastAny?.text || c.lastMsg,
          lastTime:      lastAny?.time || c.lastTime,
          lastPatientTs: novoLPTs,
          unread:        ex?.unread ?? 0,
          status:        autoResolve && c.status !== "resolved" ? "resolved" : c.status,
        });
        persistChats(updated);
        return updated;
      });
      // Persiste status resolved detectado ao abrir o chat (MongoDB + R2)
      if (autoResolve) {
        const current = (_sessionChats.value || []).find(c => c.id === chatId);
        if (!current || current.status !== "resolved") {
          const now = Date.now();
          saveOverride(chatId, { resolvedAt: now, readAt: now });
          persistChat(chatId, { status: "resolved", unread: 0, lastPatientTs: null });
          setTimeout(_syncChatsToR2, 1500);
        }
      }
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

  // ── Polling lista de chats (10s) — busca 20 mais recentes direto no WAHA ──
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(async () => {
      try {
        const SESSION   = import.meta.env.VITE_WAHA_SESSION || "default";
        const cutoffSec = Math.floor((Date.now() - 60 * 60 * 1000) / 1000); // 1h atrás
        const r = await fetch(
          `/api/waha?path=${encodeURIComponent(`/api/${SESSION}/chats`)}&limit=30`,
          { headers: { "X-Internal-Key": ikey() } }
        );
        if (!r.ok) return;
        const all = await r.json();
        if (!Array.isArray(all)) return;
        // Filtra client-side: só chats com atividade na última hora
        const recent = all.filter(c => {
          const ts = c.lastMessage?.timestamp || c.lastMessage?.t || 0;
          return ts === 0 || ts >= cutoffSec;
        });
        if (!recent.length) return;
        const normalized = recent.map(c => normalizeChat(c));

        // Chats cujo lastTs avançou mas lastMsg ainda está vazio (mídia sem body)
        // → precisa buscar a mensagem real via loadLastMessages
        const precisamMsg = [];

        setChats(prev => {
          let changed = false;
          const updated = prev.map(c => {
            const n = normalized.find(x => x.id === c.id);
            if (!n) return c;
            // Nada mudou
            if (n.lastTs === c.lastTs && (n.lastMsg || c.lastMsg)) return c;
            changed = true;
            // lastTs mudou → busca a mensagem real para garantir lastMsg e unread corretos
            if (n.lastTs && n.lastTs !== c.lastTs) {
              precisamMsg.push(c.id);
            }
            const newUnread = Math.max(c.unread || 0, n.unread || 0);
            return {
              ...c,
              lastMsg:  n.lastMsg  || c.lastMsg,
              lastTime: n.lastTime || c.lastTime,
              lastTs:   n.lastTs   || c.lastTs,
              unread:   newUnread,
            };
          });
          // Chats novos — filtra IDs inválidos (@lid, >13 dígitos) e dedup por tail-8
          const ids = new Set(prev.map(c => c.id));
          for (const n of normalized) {
            if (ids.has(n.id)) continue;
            if (!_isValidNewChatId(n.id)) continue;
            const nDigits = n.id.replace(/\D/g, "");
            const nTail8  = nDigits.length >= 8 ? nDigits.slice(-8) : null;
            if (nTail8 && updated.some(c => {
              const t = c.id.replace(/\D/g, "").slice(-8);
              return t.length >= 8 && t === nTail8;
            })) continue;
            updated.push(n); changed = true; precisamMsg.push(n.id);
          }
          if (!changed) return prev;
          persistChats(updated);
          return updated;
        });

        // Busca individual para chats com lastTs novo mas msg vazia (máx 5)
        if (precisamMsg.length > 0) {
          loadLastMessages(precisamMsg.slice(0, 5));
        }
      } catch {}
    }, 10000); // 10s — PartyKit cuida do tempo real; polling cobre chats novos e reconexão
    return () => clearInterval(iv);
  }, [sessionOk]);

  // ── 6. Envia mensagem ─────────────────────────────────────────
  const send = useCallback(async (chatId, text, operatorName, replyToId = null) => {
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
    try { await sendText(chatId, formatted, replyToId); }
    catch (e) {
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).filter(m => m.id !== tmpMsg.id),
      }));
      throw e;
    }
  }, []);

  // ── Sincroniza mídias do WAHA para o R2 (forçado pelo operador) ──
  const syncMediaToR2 = useCallback(async (chatId) => {
    console.log(`[sync-media] chatId=${chatId}`);
    const wahaChatId = chatId.endsWith("@lid") ? (
      (() => {
        const lidOnly = chatId.replace(/@lid$/, "");
        const phone = (() => { try { return JSON.parse(localStorage.getItem("lid_phone_map") || "{}")[lidOnly]?.phone; } catch { return null; } })();
        return phone ? phone + "@c.us" : chatId;
      })()
    ) : chatId;

    const raw = await getMessagesPaged(wahaChatId, 60, 300).catch(() => []);
    const wahaMsgs = sortMsgs(raw.map(normalizeMessage));
    console.log(`[sync-media] WAHA paginado: ${wahaMsgs.length} mensagens (até 300)`);

    // Índice WAHA por timestamp+fromMe para enriquecer mensagens existentes
    const wahaById = new Map(wahaMsgs.map(w => [w.id, w]));
    const wahaByTs = new Map();
    for (const w of wahaMsgs) {
      if (!w.ts) continue;
      const key = `${w.from}_${Math.floor(new Date(w.ts).getTime() / 1000)}`;
      if (!wahaByTs.has(key)) wahaByTs.set(key, w);
    }
    const findWaha = (m) => wahaById.get(m.id) || (() => {
      if (!m.ts) return undefined;
      return wahaByTs.get(`${m.from}_${Math.floor(new Date(m.ts).getTime() / 1000)}`);
    })();

    // Enriquece mensagens existentes no state (preserva IDs do R2)
    const MEDIA_TYPES_SET = new Set(["image","video","audio","voice","document","sticker","ptt"]);
    const current = _sessionMsgs.get(chatId) || [];
    const enriched = current.map(m => {
      if (m.hasMedia && m.media?.url) return m;
      const waha = findWaha(m);
      if (!waha) return m;
      // WAHA type é autoritativo — corrige tipos errados do R2 (ex: PDF salvo como "image")
      const correctType = (waha.media?.type && waha.media.type !== "text") ? waha.media.type
                        : (waha.type && MEDIA_TYPES_SET.has(waha.type)) ? waha.type
                        : m.type;
      if (!waha.media) {
        // Corrige tipo mesmo sem media object — atualiza também media.type para ficar consistente
        return { ...m, type: correctType, media: m.media ? { ...m.media, type: correctType } : null };
      }
      return {
        ...m,
        hasMedia: true,
        type:  correctType,
        media: { ...(m.media || {}), ...waha.media, type: correctType, url: waha.media.url || m.media?.url || null },
      };
    });
    // Mensagens WAHA genuinamente novas (não estavam no state)
    const currentIds = new Set(current.map(m => m.id));
    const extras = wahaMsgs.filter(w => !currentIds.has(w.id));
    const merged = sortMsgs([...enriched, ...extras]);

    // Atualiza state imediatamente — usuário vê mídias sem reload
    _sessionMsgs.set(chatId, merged);
    setMessages(prev => ({ ...prev, [chatId]: merged }));

    // Persiste no R2: usa IDs das mensagens já enriquecidas (IDs do R2 → match exato no endpoint)
    const toSave = enriched
      .filter(m => m.hasMedia || m.media)
      .map(m => ({
        id:          m.id,            // ID original do R2 — match exato no endpoint
        chatId,
        ts:          m.ts ? new Date(m.ts).getTime() : 0,
        fromMe:      m.from === "operator",
        body:        m.text || "",
        // Usa media.type se mais específico que m.type (corrige "image" salvo errado para "document" etc)
        type:        (m.media?.type && MEDIA_TYPES_SET.has(m.media.type)) ? m.media.type : (m.type || "chat"),
        pushname:    m.pushname || "",
        wahaShortId: m.media?.msgId || null,
        mediaUrl:    m.media?.url && !m.media.url.startsWith("data:") ? m.media.url : null,
        mimetype:    m.media?.mimetype || null,
      }));
    // Adiciona também as mensagens novas do WAHA (IDs WAHA, sem duplicata no R2)
    for (const w of extras) {
      if (!(w.hasMedia || w.media)) continue;
      toSave.push({
        id:          w.id,
        chatId,
        ts:          w.ts ? new Date(w.ts).getTime() : 0,
        fromMe:      w.from === "operator",
        body:        w.text || "",
        type:        (w.media?.type && w.media.type !== "text") ? w.media.type : (w.type !== "text" && w.type !== "chat" ? w.type : "image"),
        pushname:    w.pushname || "",
        wahaShortId: w.media?.msgId || null,
        mediaUrl:    w.media?.url && !w.media.url.startsWith("data:") ? w.media.url : null,
        mimetype:    w.media?.mimetype || null,
      });
    }
    console.log(`[sync-media] waha=${wahaMsgs.length} enriquecidas=${enriched.filter(m=>m.hasMedia||m.media).length} extras=${extras.length} toSave=${toSave.length}`);

    // ── Download + upload permanente pro R2 (3 concurrent) ──────────
    const SESSION = import.meta.env.VITE_WAHA_SESSION || "default";
    const iKeyVal = ikey();
    const pending = toSave.filter(m => m.wahaShortId && !m.mediaUrl?.includes("/api/r2-data?type=media"));
    console.log(`[sync-media] iniciando upload R2: ${pending.length} mídias`);
    let uploadOk = 0, uploadFail = 0;

    async function uploadOne(m) {
      try {
        const dlUrl = `/api/waha?path=${encodeURIComponent(`/api/${SESSION}/chats/${encodeURIComponent(m.chatId || chatId)}/messages/${m.wahaShortId}`)}&downloadMedia=true`;
        const dlRes = await fetch(dlUrl, { headers: { "X-Internal-Key": iKeyVal } });
        if (!dlRes.ok) { uploadFail++; return; }
        let buf, ct;
        const contentType = dlRes.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const json = await dlRes.json().catch(() => null);
          const mediaUrlRaw = json?.media?.url;
          if (!mediaUrlRaw) { uploadFail++; return; }
          const proxied = `/api/waha?path=${encodeURIComponent(mediaUrlRaw)}`;
          const r2 = await fetch(proxied, { headers: { "X-Internal-Key": iKeyVal } });
          if (!r2.ok) { uploadFail++; return; }
          buf = await r2.arrayBuffer();
          ct = r2.headers.get("content-type") || contentType;
        } else {
          buf = await dlRes.arrayBuffer();
          ct = contentType;
        }
        if (!buf || buf.byteLength === 0) { uploadFail++; return; }
        const r2MediaUrl = `/api/r2-data?type=media&msgId=${encodeURIComponent(m.wahaShortId)}`;
        const upRes = await fetch(r2MediaUrl, {
          method: "PUT", body: buf,
          headers: { "Content-Type": ct, "X-Internal-Key": iKeyVal },
        });
        if (!upRes.ok) { uploadFail++; return; }
        m.mediaUrl = r2MediaUrl;
        m.mimetype = ct || m.mimetype || null;
        // Corrige tipo a partir do content-type real baixado do WAHA
        const resolvedType = ct.includes("pdf") || (ct.startsWith("application/") && !ct.includes("octet-stream")) ? "document"
                           : ct.startsWith("video/") ? "video"
                           : ct.startsWith("audio/") ? "audio"
                           : ct === "image/webp" ? "sticker"
                           : ct.startsWith("image/") ? "image"
                           : m.type;
        if (resolvedType !== m.type) {
          console.log(`[sync-media] tipo corrigido: ${m.type} → ${resolvedType} (${ct})`);
          m.type = resolvedType;
        }
        uploadOk++;
        console.log(`[sync-media] ✅ R2 upload ${uploadOk}: ${m.wahaShortId.slice(-8)} ${Math.round(buf.byteLength/1024)}KB ${ct}`);
      } catch (e) {
        uploadFail++;
        console.warn(`[sync-media] erro upload ${m.wahaShortId?.slice(-8)}:`, e.message);
      }
    }

    // Processa em lotes de 3
    for (let i = 0; i < pending.length; i += 3) {
      await Promise.all(pending.slice(i, i + 3).map(uploadOne));
    }
    console.log(`[sync-media] uploads R2: ${uploadOk} ok / ${uploadFail} falhas`);

    // Atualiza state com R2 URLs e tipos corrigidos pelos uploads
    if (uploadOk > 0) {
      // Reconstrói merged com toSave atualizado (mediaUrl + type corretos pós-upload)
      const toSaveById = new Map(toSave.map(m => [m.id, m]));
      const finalMerged = merged.map(m => {
        const saved = toSaveById.get(m.id);
        if (!saved) return m;
        const r2Url = saved.mediaUrl?.includes("/api/r2-data?type=media") ? saved.mediaUrl : null;
        return {
          ...m,
          type: saved.type || m.type,
          media: m.media
            ? { ...m.media, type: saved.type || m.media?.type, mimetype: saved.mimetype || m.media?.mimetype, url: r2Url || m.media?.url }
            : null,
        };
      });
      _sessionMsgs.set(chatId, finalMerged);
      setMessages(prev => ({ ...prev, [chatId]: finalMerged }));
      console.log(`[sync-media] state atualizado com ${uploadOk} R2 URLs`);
    }

    // Limpa flags de falha permanente para mídias que o WAHA confirmou existirem
    // (podem ter sido marcadas como falhas em tentativas anteriores com IDs diferentes)
    const MEDIA_CACHE_PREFIX = "crm_media_";
    for (const m of toSave) {
      if (m.wahaShortId) {
        try { localStorage.removeItem(MEDIA_CACHE_PREFIX + m.wahaShortId + "_fail"); } catch {}
      }
      // Limpa também pelo shortMsgId do R2 (Baileys hex) caso tenha sido marcado
      const r2Short = (() => {
        const raw = m.id;
        if (typeof raw !== "string" || !raw.includes("_")) return null;
        const parts = raw.split("_");
        return [...parts].reverse().find(p => !p.includes("@")) || null;
      })();
      if (r2Short) {
        try { localStorage.removeItem(MEDIA_CACHE_PREFIX + r2Short + "_fail"); } catch {}
      }
    }

    if (toSave.length > 0) {
      fetch(`/api/r2-data?type=msgs&chatId=${encodeURIComponent(chatId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": ikey() },
        body: JSON.stringify(toSave),
      })
        .then(r => r.json())
        .then(j => console.log(`[sync-media] R2 response:`, j))
        .catch(e => console.error(`[sync-media] R2 error:`, e));
    } else {
      console.log(`[sync-media] nada para salvar no R2`);
    }

    return toSave.length;
  }, []);

  // ── Apagar/editar mensagem ────────────────────────────────────
  const deleteMsg = useCallback(async (chatId, msgId, forEveryone = false) => {
    try { await wahaDeleteMessage(chatId, msgId, forEveryone); } catch {}
    setMessages(prev => {
      const cur = prev[chatId] || [];
      const updated = forEveryone
        // "Para todos": marca revoked (visualmente riscado, como o webhook faz)
        ? cur.map(m => m.id === msgId ? { ...m, revoked: true } : m)
        // "Para mim": remove apenas do estado local
        : cur.filter(m => m.id !== msgId);
      _sessionMsgs.set(chatId, updated);
      return { ...prev, [chatId]: updated };
    });
  }, []);

  // Aplica reação localmente (otimista) e envia ao WAHA
  // emoji="" = remover reação anterior
  const reactMsg = useCallback(async (chatId, msgId, emoji) => {
    const myId = myJid || "me";
    setMessages(prev => {
      // Encontra a chave correta (pode diferir por tail-8 de telefone)
      const digits = chatId.replace(/\D/g, "");
      const tail8  = digits.slice(-8);
      const key = Object.keys(prev).find(k => k === chatId
        || (tail8.length >= 8 && k.replace(/\D/g, "").slice(-8) === tail8))
        || chatId;
      const cur = prev[key] || [];
      const updated = cur.map(m => {
        if (m.id !== msgId) return m;
        const reactions = { ...(m.reactions || {}) };
        // Remove qualquer reação anterior deste usuário
        for (const e of Object.keys(reactions)) {
          reactions[e] = reactions[e].filter(u => u.id !== myId);
          if (reactions[e].length === 0) delete reactions[e];
        }
        if (emoji) {
          reactions[emoji] = [...(reactions[emoji] || []), { id: myId, fromMe: true }];
        }
        return { ...m, reactions };
      });
      _sessionMsgs.set(key, updated);
      return { ...prev, [key]: updated };
    });
    try { await wahaSendReaction(chatId, msgId, emoji); } catch {}
  }, [myJid]);

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
      const chat = prev.find(c => c.id === chatId);
      const updated = prev.map(c => c.id === chatId ? { ...c, assignedTo: toRole, status: "open" } : c);
      persistChats(updated);
      const data = { assignedTo: toRole, status: "open" };
      if (chat) persistChatAll(chat, data); else persistChat(chatId, data);
      return updated;
    });
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
      // Persiste no MongoDB para o ID visível E todos os aliases (evita duplicata ao recarregar)
      const data = {
        status:        newSt,
        lastPatientTs: newSt === "resolved" ? null : undefined,
        unread:        newSt === "resolved" ? 0    : undefined,
      };
      if (chat) persistChatAll(chat, data); else persistChat(chatId, data);
      return updated;
    });
  }, []);

  const markRead = useCallback((chatId) => {
    setChats(prev => {
      const chat = prev.find(c => c.id === chatId);
      const updated = prev.map(c =>
        c.id === chatId ? { ...c, unread: 0, lastPatientTs: null } : c
      );
      persistChats(updated);
      saveOverride(chatId, { readAt: Date.now() });
      const data = { unread: 0, lastPatientTs: null };
      if (chat) persistChatAll(chat, data); else persistChat(chatId, data);
      return updated;
    });
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
    persistChat(chatId, { muted: true });
  }, []);

  const unmuteChat = useCallback((chatId) => {
    setMutedChats(prev => {
      const next = new Set(prev);
      next.delete(chatId);
      try { localStorage.setItem("crm_muted", JSON.stringify([...next])); } catch {}
      return next;
    });
    persistChat(chatId, { muted: false });
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
    reactMsg,
    deleteChat,
    forwardChat,
    resolveChat,
    markRead,
    markUnread,
    searchMessages,
    resyncChats,
    syncChatsToR2: _syncChatsToR2,
    syncMediaToR2,
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
            // Normaliza para chave canônica (mesma lógica do backend) — evita duplicatas no R2
            resolvedId = _normalizeDigits(resolvedPhone || "") || resolvedId;
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

  // ── Resync leve (automático, a cada 5 min): limit=200 via proxy, sem reset de lastSync ──
  async function _lightResync() {
    if (USE_MOCK) return;
    const SESSION = import.meta.env.VITE_WAHA_SESSION || "default";
    try {
      const [wahaRes, r2Res] = await Promise.all([
        fetch(
          `/api/waha?path=${encodeURIComponent(`/api/${SESSION}/chats`)}&limit=200`,
          { headers: { "X-Internal-Key": ikey() } }
        ).then(r => r.ok ? r.json() : []).catch(() => []),
        fetch("/api/r2-data?type=chats", { headers: { "X-Internal-Key": ikey() } })
          .then(r => r.ok ? r.json() : []).catch(() => []),
      ]);
      if (!Array.isArray(wahaRes)) return;

      const lidCacheLight = readLidPhoneMap();
      const r2Map = {};
      for (const c of (Array.isArray(r2Res) ? r2Res : [])) {
        r2Map[c.id] = c;
        const ck = canonicalKey(c.id, lidCacheLight);
        if (ck && ck !== c.id) r2Map[ck] = c;
      }
      const normalized = wahaRes.map(c => normalizeChat(c));
      const overrides = readOverrides();

      setChats(prev => {
        const prevMap = {};
        const prevByPhone = {};
        for (const pc0 of prev) {
          prevMap[pc0.id] = pc0;
          const pc0k = canonicalKey(pc0.id, lidCacheLight);
          if (pc0k) prevByPhone[pc0k] = pc0;
        }
        const merged  = normalized.map(n => {
          const nck = canonicalKey(n.id, lidCacheLight);
          const local   = prevMap[n.id] || (nck ? prevByPhone[nck] : undefined);
          const r2      = r2Map[n.id] || (nck ? r2Map[nck] : undefined);
          const isMuted = mutedChatsRef.current.has(n.id);



          const wahaTsMs  = n.lastTs   ? new Date(n.lastTs).getTime()   : 0;
          const r2TsMs    = r2?.lastTs || 0;
          const localTsMs = local?.lastTs ? new Date(local.lastTs).getTime() : 0;
          const bestTsMs  = Math.max(wahaTsMs, r2TsMs, localTsMs);

          const lastMsg = r2TsMs > wahaTsMs && r2TsMs > localTsMs && r2?.lastMsg ? r2.lastMsg
            : wahaTsMs >= r2TsMs && wahaTsMs >= localTsMs && n.lastMsg           ? n.lastMsg
            : local?.lastMsg || n.lastMsg || r2?.lastMsg || "";

          const lastTs = bestTsMs ? new Date(bestTsMs).toISOString() : (n.lastTs || local?.lastTs);

          const ov = nck ? overrides[nck] : overrides[n.id];
          const r2LptMs = r2?.lastPatientTs ? new Date(r2.lastPatientTs).getTime() : 0;
          const ovResolved = ov?.resolvedAt && r2LptMs <= ov.resolvedAt;
          const ovRead = ov?.readAt && r2LptMs <= ov.readAt;

          const r2Lpt    = r2?.lastPatientTs ? new Date(r2.lastPatientTs).getTime() : null;
          const localLpt = local?.lastPatientTs ? new Date(local.lastPatientTs).getTime() : null;
          // Se local está "open" com lastPatientTs definido, R2 pode estar desatualizado —
          // preserva o estado local para não apagar o timer de espera prematuramente.
          const localIsOpen = local?.status === "open" && !!local?.lastPatientTs;
          const lpt = isMuted || ovRead || ovResolved ? null
            : localIsOpen
              ? local.lastPatientTs  // confia no estado local (WebSocket/handleMsg já atualizou)
              : r2?.lastPatientTs !== undefined
                ? (r2Lpt ? new Date(Math.max(r2Lpt, localLpt || 0)).toISOString() : null)
                : (local?.lastPatientTs ?? null);

          // Chat é resolvido se: override ativo, lastMsg de fechamento, ou foi resolvido
          // manualmente (status==="resolved") E não foi reaberto localmente pelo paciente.
          const localReopened = local?.status === "open" && localLpt && localLpt > (r2LptMs || 0);
          const isResolved = (!localReopened && local?.status === "resolved") || ovResolved || lastMsgIsClosing(lastMsg);
          const unread = isMuted || isResolved || !lpt || ovRead ? 0
            : r2?.unread !== undefined
              ? Math.max(r2.unread || 0, local?.unread || 0)
              : (local?.unread ?? n.unread ?? 0);

          return {
            ...(local || n),
            lastMsg, lastTs, unread,
            lastPatientTs: isResolved ? null : lpt,
            status:     isResolved ? "resolved" : (local?.status ?? n.status),
            assignedTo: local?.assignedTo ?? n.assignedTo,
            tags:       local?.tags       ?? n.tags,
            pushname:   n.pushname || local?.pushname || r2?.pushname,
          };
        });
        // Chats do prev que não estão no resultado do WAHA — mantém localmente.
        // Usa chave canônica para evitar duplicatas quando o mesmo contato aparece
        // em formatos diferentes (@lid vs @c.us).
        const mergedKeys = new Set();
        for (const mc of merged) {
          mergedKeys.add(mc.id);
          const mck = canonicalKey(mc.id, lidCacheLight);
          if (mck) mergedKeys.add(mck);
        }
        for (const pc of prev) {
          const pck = canonicalKey(pc.id, lidCacheLight);
          if (!mergedKeys.has(pc.id) && !(pck && mergedKeys.has(pck))) {
            merged.push(pc);
            mergedKeys.add(pc.id);
            if (pck) mergedKeys.add(pck);
          }
        }
        const deduped = _dedupeChats(merged);
        persistChats(deduped);
        return deduped;
      });

      // Dispara resolução em lote de todos os @lid do estado atual — throttled em useContacts
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

// Persiste metadata de chat no MongoDB para o chatId e todos os aliases conhecidos
function persistChatAll(chat, data) {
  const ids = [chat.id, ...(chat.aliases || [])].filter(Boolean);
  for (const id of ids) persistChat(id, data);
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