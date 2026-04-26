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
  sendLocation as wahaSendLocation,
} from "../services/waha";
import { MOCK_CHATS, MOCK_MESSAGES } from "../data/mock";

// Ordena mensagens — estável por timestamp real, nunca usa índice de array como critério primário
// Preview de mensagem para o chatlist — body/text ou fallback descritivo por tipo
function msgPreview(msg) {
  if (msg.text) return msg.text;
  if (msg.location) return "📍 Localização";
  switch (msg.type) {
    case "image":    return "📷 Imagem";
    case "video":    return "🎥 Vídeo";
    case "audio":
    case "voice":    return "🎵 Áudio";
    case "document": return "📄 Documento";
    case "sticker":  return "⭐ Figurinha";
    case "vcard":
    case "contact":  return "👤 Contato";
    default:         return msg.media ? "📎 Mídia" : "";
  }
}

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
  const hasRealLocation  = incoming.some(m => m.from === "operator" && m.location);
  return current.filter(m => {
    if (!m.id.startsWith("tmp-")) return true;
    if (realIds.has(m.id)) return false;
    if (realFromMeTexts.has(m.text?.trim())) return false;
    // Remove tmp de localização quando a mensagem real de localização chega
    if (hasRealLocation && m.id.startsWith("tmp-loc-")) return false;
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

// Constrói mapa @lid → @c.us a partir do cache em memória + localStorage
// Usado pelo dedup para reconhecer que um @lid e um @c.us são o mesmo contato
function _buildLidResolver() {
  const resolver = new Map(_lidToJid); // in-memory: lid@lid → jid@c.us
  try {
    const stored = readLidPhoneMap(); // localStorage: lidOnly → { phone }
    for (const [lid, val] of Object.entries(stored)) {
      const phone = val?.phone;
      if (phone) {
        const jid = phone.replace(/\D/g, "") + "@c.us";
        const full = lid.endsWith("@lid") ? lid : lid + "@lid";
        if (!resolver.has(full)) resolver.set(full, jid);
      }
    }
  } catch {}
  return resolver;
}

// Retorna os dígitos canônicos a usar no tail-8 para dedup
// Para @lid com JID resolvido, usa os dígitos do JID; senão usa os próprios dígitos do ID
function _resolvedDigits(id, lidResolver) {
  if (id.endsWith("@lid")) {
    const jid = lidResolver.get(id);
    if (jid) return _normalizeDigits(jid.replace(/\D/g, ""));
  }
  return _normalizeDigits(id.replace(/\D/g, ""));
}

// Deduplica lista de chats por tail-8 de telefone, filtrando apagados e IDs inválidos
// Usa lid_map (memória + localStorage) para reconhecer @lid e @c.us do mesmo contato
function _dedupeChats(chats) {
  const lidResolver = _buildLidResolver();
  const deduped = [];
  const seen8   = new Map(); // tail-8 → índice em deduped
  let _skipDel = 0, _skipInv = 0, _skipMerge = 0;
  for (const chat of chats) {
    if (_deletedChats.has(chat.id)) { _skipDel++; continue; }
    if (!_isValidChatId(chat.id))   { _skipInv++; continue; }
    const digits = _resolvedDigits(chat.id, lidResolver);
    // Usa os 8 últimos dígitos do número normalizado como chave de dedup
    // (cobre variações de prefixo país/DDD, @lid vs @c.us, com/sem dígito 9)
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
      // Prefer @c.us over @lid; se ambos forem @lid, prefer o que tem JID resolvido
      const lidId  = ex.id.endsWith("@lid") ? ex.id : (chat.id.endsWith("@lid") ? chat.id : null);
      const cusId  = ex.id.endsWith("@c.us") ? ex.id : (chat.id.endsWith("@c.us") ? chat.id : null);
      // Se o @lid tem resolução conhecida, usa o JID como ID canônico
      const resolvedFromLid = lidId ? lidResolver.get(lidId) : null;
      const bestId = cusId || resolvedFromLid || lidId || ex.id;
      // Para dados do chat, usa o mais recente (timestamp maior)
      const base = newTs > exTs ? chat : ex;
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
        status:        ex.status === "resolved" || chat.status === "resolved" ? "resolved" : (ex.status || chat.status),
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
          fetch("/api/r2-data?type=lid-map", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Internal-Key": ikey() },
            body: JSON.stringify({ [lid.replace(/@lid$/, "")]: jid }),
          }).catch(() => {});
          return jid;
        }
        // API retornou mas só tem nome (sem JID @c.us) — salva o nome mesmo assim
        if (name) _saveLidResolution(lid, null, name);
      } else {
        // 404 ou outro erro HTTP — WAHA não conhece este LID; não tenta de novo
        _lidFailed.add(lid);
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
      // Guard: lastMsg/lastTs do state atual prevalecem sobre dados mais antigos da base
      // Lookup por: ID exato → alias @lid/@c.us via lidResolver → tail-8 de telefone
      const lidResolver = _buildLidResolver(); // @lid → @c.us (memória + localStorage)
      const guardById  = new Map(prev.map(c => [c.id, c]));
      // Indexa também por JID resolvido para que @lid no next encontre @c.us no prev (e vice-versa)
      const guardByJid = new Map();
      for (const c of prev) {
        if (c.id?.endsWith("@lid")) {
          const jid = lidResolver.get(c.id);
          if (jid) guardByJid.set(jid, c);
        } else if (c.id?.endsWith("@c.us")) {
          guardByJid.set(c.id, c);
        }
      }
      const guardByT8 = new Map();
      for (const c of prev) {
        if (c.id?.endsWith("@g.us")) continue;
        const digits = _resolvedDigits(c.id, lidResolver);
        const t8 = digits.length >= 8 ? digits.slice(-8) : null;
        if (t8 && !guardByT8.has(t8)) guardByT8.set(t8, c);
      }
      const guardFind = (id) => {
        const ex = guardById.get(id);
        if (ex) return ex;
        if (id?.endsWith("@g.us")) return undefined;
        // @lid no next → encontra @c.us no prev (ou outro @lid resolvido)
        if (id?.endsWith("@lid")) {
          const jid = lidResolver.get(id);
          if (jid) { const r = guardById.get(jid) || guardByJid.get(jid); if (r) return r; }
        }
        // @c.us no next → encontra @lid no prev cujo JID resolvido é este @c.us
        if (id?.endsWith("@c.us")) {
          const r = guardByJid.get(id);
          if (r) return r;
        }
        // Fallback: tail-8 de dígitos normalizados (cobre variações de prefixo/dígito 9)
        const digits = _resolvedDigits(id, lidResolver);
        const t8 = digits.length >= 8 ? digits.slice(-8) : null;
        return t8 ? guardByT8.get(t8) : undefined;
      };
      const guarded = next.map(c => {
        const p = guardFind(c.id);
        if (!p) return c;
        const pTs = p.lastTs  ? new Date(p.lastTs).getTime()  : 0;
        const cTs = c.lastTs  ? new Date(c.lastTs).getTime()  : 0;
        if (pTs > cTs) return { ...c, lastMsg: p.lastMsg, lastTs: p.lastTs, lastPatientTs: p.lastPatientTs || c.lastPatientTs };
        return c;
      });
      const deduped = _dedupeChats(guarded);
      const final = deduped.length === guarded.length ? guarded : deduped;
      persistChats(final);
      return final;
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

  // ── 2. Carrega lista de chats — localStorage → R2 (fonte única via webhook) ──
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    initChats().then(() => {
      setTimeout(_syncChatsToR2, 5000);
      setTimeout(_batchResolveLids, 8000);
      // Varredura única de duplicatas @lid/@c.us no R2 — após merge, reaplica chatlist
      setTimeout(() => {
        fetch("/api/r2-data?type=merge-lids", {
          method: "POST",
          headers: { "X-Internal-Key": ikey() },
        }).then(() => applyR2Chats()).catch(() => {});
      }, 15000);
    });
  }, [sessionOk]);

  // Constrói chatlist a partir dos arquivos msgs/ no R2 (fonte única via webhook)
  // Sem dedup nem merge — cada arquivo = um chat, ordem por lastModified/lastTs
  async function applyR2Chats() {
    try {
      const res = await fetch("/api/r2-data?type=msgs-list", {
        headers: { "X-Internal-Key": ikey() }
      });
      if (!res.ok) return;
      const r2Chats = await res.json();
      if (!Array.isArray(r2Chats) || r2Chats.length === 0) return;

      const overrides = readOverrides();

      setChats(prev => {
        // Lookup por ID exato → alias @lid/@c.us via lidResolver → tail-8
        const lidResolver = _buildLidResolver();
        const prevById  = new Map(prev.map(c => [c.id, c]));
        const prevByJid = new Map(); // jid@c.us → chat (para achar @c.us quando prev tem @lid)
        for (const c of prev) {
          if (c.id?.endsWith("@lid")) {
            const jid = lidResolver.get(c.id);
            if (jid) prevByJid.set(jid, c);
          } else if (c.id?.endsWith("@c.us")) {
            prevByJid.set(c.id, c);
          }
        }
        const prevByT8 = new Map();
        for (const c of prev) {
          if (c.id?.endsWith("@g.us")) continue;
          const digits = _resolvedDigits(c.id, lidResolver);
          const t8 = digits.length >= 8 ? digits.slice(-8) : null;
          if (t8 && !prevByT8.has(t8)) prevByT8.set(t8, c);
        }
        const findLocal = (id) => {
          const ex = prevById.get(id);
          if (ex) return ex;
          if (id?.endsWith("@g.us")) return undefined;
          if (id?.endsWith("@lid")) {
            const jid = lidResolver.get(id);
            if (jid) { const r = prevById.get(jid) || prevByJid.get(jid); if (r) return r; }
          }
          if (id?.endsWith("@c.us")) {
            const r = prevByJid.get(id);
            if (r) return r;
          }
          const digits = _resolvedDigits(id, lidResolver);
          const t8 = digits.length >= 8 ? digits.slice(-8) : null;
          return t8 ? prevByT8.get(t8) : undefined;
        };

        // IDs presentes no R2 — chats não encontrados em R2 são mantidos do prev (WebSocket-only)
        const r2Ids = new Set(r2Chats.map(c => c.id));
        const prevOnly = prev.filter(c => {
          if (r2Ids.has(c.id)) return false;
          if (c.id?.endsWith("@g.us")) return false;
          const digits = _resolvedDigits(c.id, lidResolver);
          const t8 = digits.length >= 8 ? digits.slice(-8) : null;
          return !t8 || ![...r2Ids].some(id => {
            const d = _resolvedDigits(id, lidResolver);
            return d.length >= 8 && d.slice(-8) === t8;
          });
        });

        const updated = r2Chats
          .filter(c => c.id && !c.id.endsWith("@s.whatsapp.net"))
          .map(c => {
            const local   = findLocal(c.id);
            const isMuted = mutedChatsRef.current.has(c.id);
            const ck      = canonicalKey(c.id, readLidPhoneMap());
            const ov      = ck ? overrides[ck] : overrides[c.id];
            const lptMs   = c.lastPatientTs || 0;
            const ovResolved = ov?.resolvedAt && lptMs <= ov.resolvedAt;
            const ovRead     = ov?.readAt     && lptMs <= ov.readAt;
            // autoResolved vem do servidor (calculado com fromMe e texto limpo de prefixo)
            // fallback: lastMsgIsClosing ainda verifica o texto raw p/ retrocompatibilidade
            const r2AutoRes  = c.autoResolved || lastMsgIsClosing(c.lastMsg);
            const isResolved = (local?.status === "resolved") || ovResolved || r2AutoRes;
            // lastPatientTs: R2 já calcula null quando operador respondeu por último
            // se local tem null (operador respondeu) prevalece sobre R2 que possa ter valor stale
            const localLpt = local?.lastPatientTs;
            const r2Lpt    = c.lastPatientTs ? new Date(c.lastPatientTs).toISOString() : null;
            const lpt = isMuted || isResolved || ovRead ? null
              : (localLpt === null && local ? null : (localLpt || r2Lpt));
            // Preserva lastMsg/lastTs local quando:
            //   1. local é igual ou mais recente que R2 (>= cobre mesmo evento via WS+webhook), OU
            //   2. R2 não tem lastMsg mas local tem (webhook ainda não chegou)
            // tsToNum normaliza ISO string, ms e Unix segundos para ms comparável
            const _toMs = (v) => {
              if (!v) return 0;
              const n = typeof v === "number" ? v : new Date(v).getTime();
              // Unix em segundos (< ano 2001 em ms = < 1e12) → converte para ms
              return n > 0 && n < 1e12 ? n * 1000 : n;
            };
            const localTs  = _toMs(local?.lastTs);
            const r2Ts     = _toMs(c.lastTs);
            const useLocal = local && (localTs >= r2Ts || (local.lastMsg && !c.lastMsg));
            return {
              id:            c.id,
              pushname:      local?.pushname  || c.pushname || "",
              lastMsg:       useLocal ? local.lastMsg : (c.lastMsg || ""),
              lastTs:        useLocal ? local.lastTs  : (c.lastTs ? new Date(c.lastTs).toISOString() : null),
              lastPatientTs: useLocal ? (local.lastPatientTs || lpt) : lpt,
              unread:        isMuted || isResolved || !lpt || ovRead ? 0 : c.unread || 0,
              status:        isResolved ? "resolved" : (local?.status || "open"),
              assignedTo:    local?.assignedTo || null,
              tags:          local?.tags       || [],
              photoUrl:      local?.photoUrl   || null,
            };
          });

        // Mantém chats que só existem no state local (WebSocket-only nesta sessão)
        return [...updated, ...prevOnly];
      });
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

  // Sync R2 + resolução de LIDs a cada 5 minutos
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(() => {
      _syncChatsToR2();
      _batchResolveLids();
    }, 5 * 60 * 1000);
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
      // Se ficou fora por mais de 30 s, aplica R2 para capturar msgs chegadas via webhook
      if (awayMs > 30_000) {
        applyR2Chats();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [sessionOk, setChats]);

  // ── Inicialização: localStorage → R2 (fonte única, populada pelo webhook) ──
  async function initChats() {
    setLoading(true);
    try {
      // 1. localStorage — exibe imediatamente sem esperar rede
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

      // 2. R2 — fonte de verdade, populada pelo webhook
      await applyR2Chats(cachedChats);

      // 3. Fotos de perfil via WAHA em background
      const chatsNow = _sessionChats.value || [];
      if (chatsNow.length) {
        setTimeout(() => loadProfilePictures(chatsNow.map(c => c.id)), 1000);
      }
    } catch (e) {
      console.error("[init] loadChats:", e.message);
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
  // ── [REMOVIDO] loadLastMessages — WAHA não é mais fonte de lastMsg ──
  // Mensagens chegam via webhook → R2. Ver applyR2Chats e handleMsg.
  async function loadLastMessages(_chatIds) { return; }

  // [código legado preservado temporariamente para evitar referências quebradas]
  async function _loadLastMessagesLegacy(chatIds) {
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
        // Antes de remover tmps de localização, preserva address/thumbnail que a API WAHA não devolve
        let enrichedMsg = msg;
        if (msg.location) {
          const tmpLoc = existing.find(m => m.id.startsWith("tmp-loc-"));
          if (tmpLoc?.location) {
            enrichedMsg = {
              ...msg,
              location: {
                ...msg.location,
                address:   msg.location.address   || tmpLoc.location.address   || null,
                thumbnail: msg.location.thumbnail || tmpLoc.location.thumbnail || null,
              },
            };
          }
        }
        const semTmp  = removeTmp(existing, [enrichedMsg]);
        const updated = sortMsgs([...semTmp, enrichedMsg]);
        _sessionMsgs.set(effectiveId, updated);
        return { ...prev, [effectiveId]: updated };
      });

      setChats(prev => {
        const isPatient = msg.from === "patient";
        const autoRes   = (isPatient && isFarewell(msg.text)) || (!isPatient && isOperatorClosing(msg.text));
        const lastMsg   = msgPreview(msg);

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
        const afterUpdate = updated.find(c => c.id === target.id);
        if (autoRes && target.status !== "resolved") {
          const now = Date.now();
          saveOverride(target.id, { resolvedAt: now, readAt: now });
        } else if (afterUpdate?.status === "open" && target.status === "resolved") {
          clearOverride(target.id);
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
      from:     m.from || (m.fromMe ? "operator" : "patient"),
      operator: m.operator || null,
      text:     m.body || m.text || "",
      type:     m.type || "chat",
      ts:       tsMs ? new Date(tsMs).toISOString() : null,
      time:     tsMs ? new Date(tsMs).toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }) : "",
      hasMedia,
      pushname: m.pushname || "",
      replyTo,
      revoked:  m.revoked || false,
      reactions: m.reactions || null,
      location: m.location || null,
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

      // Índice por ID exato + fallback ts+direção para TODOS os tipos
      // R2 e WAHA usam hexes diferentes (formato @c.us/Baileys vs @lid/servidor)
      const wahaByTs = new Map();
      for (const w of wahaMsgs) {
        if (!w.ts) continue;
        const tsS = Math.floor(new Date(w.ts).getTime() / 1000);
        const key = `${w.from}_${tsS}`;
        if (!wahaByTs.has(key)) wahaByTs.set(key, w);
      }
      const getWaha = (id, m) => {
        const byId = wahaById.get(id);
        if (byId) return byId;
        if (m?.ts) {
          const tsS = Math.floor(new Date(m.ts).getTime() / 1000);
          const byTs = wahaByTs.get(`${m.from}_${tsS}`);
          if (byTs) return byTs;
        }
        return undefined;
      };

      // Calcula gaps fora do setMessages para poder usar no toSave depois
      let detectedGaps = [];

      setMessages(prev => {
        if (activeChatRef.token !== token) return prev;
        const existing = prev[chatId] || [];
        const existMedia = existing.filter(m => m.hasMedia || m.media).length;

        // Enriquece um msg canônico (R2 ou WS) com mídia/replyTo do WAHA sem tocar em ts/id/texto
        const enrichFromWaha = (m) => {
          const waha = getWaha(m.id, m);
          if (!waha) return m;
          const media    = m.media || (waha.hasMedia ? waha.media : null);
          const hasMedia = m.hasMedia || waha.hasMedia || false;
          const wahaType = waha.type && waha.type !== "text" && waha.type !== "chat" ? waha.type : null;
          return { ...m, media, hasMedia, type: wahaType || m.type, replyTo: m.replyTo || waha.replyTo || null };
        };

        // Fontes canônicas: R2 (webhook) + WebSocket desta sessão — ts/id/texto preservados
        const r2Merged  = existing.filter(m => r2Ids.has(m.id)).map(enrichFromWaha);
        const wsExtras  = existing.filter(m => !r2Ids.has(m.id) && !m.id.startsWith("tmp-")).map(enrichFromWaha);

        // IDs e chaves ts+direção das fontes canônicas — deduplicam WAHA com ID em formato diferente
        const canonicalIds   = new Set([...r2Merged, ...wsExtras].map(m => m.id));
        const canonicalTsKey = new Set([...r2Merged, ...wsExtras].map(m => {
          const tsS = Math.floor(tsToNum(m.ts) / 1000);
          return `${m.from}_${tsS}`;
        }));

        // WAHA: descarta apenas duplicatas reais (ID exato ou mesmo segundo+direção)
        // NÃO descarta por intervalo de tempo — mensagens que não chegaram via webhook
        // podem estar no meio do intervalo do R2 e precisam ser inseridas como gaps
        const canonicalTsList = [...r2Merged, ...wsExtras]
          .map(m => tsToNum(m.ts)).filter(t => t > 0);
        const oldestCanonicalTs = canonicalTsList.length ? Math.min(...canonicalTsList) : 0;

        const wahaNotDupe = wahaMsgs.filter(m => {
          if (canonicalIds.has(m.id)) return false;
          const tsS = Math.floor(tsToNum(m.ts) / 1000);
          return !canonicalTsKey.has(`${m.from}_${tsS}`);
        });

        // Divide em: histórico antigo (antes do R2) e gaps (dentro do intervalo)
        // Histórico antigo: vai antes do bloco canônico, ordenado por ts
        // Gaps: intercalados na sequência canônica por ts (mensagens que faltaram no webhook)
        const wahaOld  = wahaNotDupe.filter(m => oldestCanonicalTs > 0 && tsToNum(m.ts) < oldestCanonicalTs);
        const wahaGaps = wahaNotDupe.filter(m => !oldestCanonicalTs || tsToNum(m.ts) >= oldestCanonicalTs);

        if (wahaGaps.length > 0) {
          console.log(`[load-msgs] 3-WAHA gaps detectados=${wahaGaps.length}:`, wahaGaps.map(m => `ts=${m.ts} from=${m.from} text=${String(m.text||"").slice(0,30)}`));
          detectedGaps = wahaGaps; // expõe para o bloco toSave fora do callback
        }

        // Sequência canônica com gaps intercalados por timestamp
        // r2Merged e wsExtras mantêm ordem relativa via sortMsgs (ts é canônico para R2)
        const canonicalWithGaps = sortMsgs([...r2Merged, ...wsExtras, ...wahaGaps]);
        const sortedWahaOld     = [...wahaOld].sort((a, b) => tsToNum(a.ts) - tsToNum(b.ts));
        const merged            = [...sortedWahaOld, ...canonicalWithGaps];
        const mergedMedia = merged.filter(m => m.hasMedia || m.media).length;
        console.log(`[load-msgs] 3-WAHA-SET | exist=${existing.length}(mídia=${existMedia}) r2Merged=${r2Merged.length} wahaOld=${wahaOld.length} wahaGaps=${wahaGaps.length} wsExtras=${wsExtras.length} → final=${merged.length}(mídia=${mergedMedia})`);
        const finalMediaSample = merged.filter(m => m.hasMedia||m.media).slice(0,3).map(m=>`id=...${String(m.id||"").slice(-10)} type=${m.type} url=${m.media?.url?"sim":"não"}`);
        if (finalMediaSample.length) console.log(`[load-msgs] 3-WAHA-SET mídias:`, finalMediaSample);
        _sessionMsgs.set(chatId, merged);
        return { ...prev, [chatId]: merged };
      });

      // Persiste mídia de volta ao R2 para sobreviver F5 (fire-and-forget)
      // O endpoint faz merge por ID exato e fallback por timestamp+fromMe — sem duplicatas
      {
        // Enriquece mídias existentes no R2 + persiste gaps (msgs que não chegaram via webhook)
        // gaps são marcados com isGap:true para o servidor inserir sem deduplicar com IDs existentes
        const toSave = wahaMsgs.map(w => {
          const isGap = detectedGaps.some(g => g.id === w.id);
          return {
            id:          w.id,
            chatId,
            ts:          w.ts ? new Date(w.ts).getTime() : 0,
            fromMe:      w.from === "operator",
            body:        w.text || "",
            type:        (w.media?.type && w.media.type !== "text") ? w.media.type : (w.type !== "text" && w.type !== "chat" ? w.type : undefined),
            pushname:    w.pushname || "",
            wahaShortId: w.media?.msgId || null,
            mediaUrl:    w.media?.url && !w.media.url.startsWith("data:") ? w.media.url : null,
            mimetype:    w.media?.mimetype || null,
            ...(isGap ? { isGap: true } : {}),
          };
        }).filter(w => w.hasMedia || w.media || detectedGaps.some(g => g.id === w.id) || w.wahaShortId);
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
          lastMsg:       (lastAny ? msgPreview(lastAny) : null) || c.lastMsg,
          lastTime:      lastAny?.time || c.lastTime,
          lastPatientTs: novoLPTs,
          unread:        ex?.unread ?? 0,
          status:        autoResolve && c.status !== "resolved" ? "resolved" : c.status,
        });
        persistChats(updated);
        return updated;
      });
      if (autoResolve) {
        const current = (_sessionChats.value || []).find(c => c.id === chatId);
        if (!current || current.status !== "resolved") {
          const now = Date.now();
          saveOverride(chatId, { resolvedAt: now, readAt: now });
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


  // ── 6. Envia mensagem ─────────────────────────────────────────
  const send = useCallback(async (chatId, text, operatorName, replyToId = null, keepWaiting = false) => {
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
        ...c, lastMsg: formatted, lastTs: tmpMsg.ts, lastTime: tmpMsg.time,
        // keepWaiting: mantém chat na fila de espera após envio (ex: mensagem de boas-vindas)
        lastPatientTs: keepWaiting ? tmpMsg.ts : null,
        unread: keepWaiting ? (c.unread || 0) : 0,
      });
      persistChats(updated);
      return updated;
    });
    if (USE_MOCK) return;
    try {
      await sendText(chatId, formatted, replyToId);
      // Persiste mensagem enviada no R2 para que o polling não sobrescreva o lastMsg
      fetch(`/api/r2-data?type=send-msg&chatId=${encodeURIComponent(chatId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": ikey() },
        body: JSON.stringify({ ...tmpMsg, fromMe: true }),
      }).catch(() => {});
    } catch (e) {
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).filter(m => m.id !== tmpMsg.id),
      }));
      throw e;
    }
  }, []);

  // ── Envia mensagem de localização ─────────────────────────────
  const sendLocationMsg = useCallback(async (chatId, operatorName, lat, lng, name, address) => {
    const now    = new Date();
    const tmpMsg = {
      id: `tmp-loc-${Date.now()}`, from: "operator",
      text: null, type: "location",
      time: now.toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }),
      ts: now.toISOString(), chatId, operator: operatorName,
      location: { latitude: lat, longitude: lng, name, address, thumbnail: null },
    };
    setMessages(prev => {
      const updated = sortMsgs([...(prev[chatId] || []), tmpMsg]);
      _sessionMsgs.set(chatId, updated);
      return { ...prev, [chatId]: updated };
    });
    setChats(prev => {
      const updated = prev.map(c => c.id !== chatId ? c : {
        ...c, lastMsg: `📍 ${name}`, lastTs: tmpMsg.ts, lastTime: tmpMsg.time,
        lastPatientTs: null, unread: 0,
      });
      persistChats(updated);
      return updated;
    });
    if (USE_MOCK) return;
    try {
      await wahaSendLocation(chatId, lat, lng, name, address);
      fetch(`/api/r2-data?type=send-msg&chatId=${encodeURIComponent(chatId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": ikey() },
        body: JSON.stringify({ ...tmpMsg, fromMe: true }),
      }).catch(() => {});
      // A API WAHA não envia o campo address na mensagem de localização.
      // Enviamos uma mensagem de texto logo após com o endereço para o destinatário ver.
      if (address) {
        await new Promise(r => setTimeout(r, 800)); // pequeno delay para chegar depois da localização
        const formatted = `${operatorName}: 📍 ${address}`;
        await sendText(chatId, formatted);
        const addrMsg = {
          id: `tmp-addr-${Date.now()}`, from: "operator", text: formatted,
          time: new Date().toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }),
          ts: new Date().toISOString(), chatId, type: "text", operator: operatorName,
        };
        setMessages(prev => {
          const updated = sortMsgs([...(prev[chatId] || []), addrMsg]);
          _sessionMsgs.set(chatId, updated);
          return { ...prev, [chatId]: updated };
        });
        fetch(`/api/r2-data?type=send-msg&chatId=${encodeURIComponent(chatId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Key": ikey() },
          body: JSON.stringify({ ...addrMsg, fromMe: true }),
        }).catch(() => {});
      }
    } catch (e) {
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
      if (newSt === "resolved") {
        saveOverride(chatId, { resolvedAt: Date.now(), readAt: Date.now() });
      } else {
        clearOverride(chatId);
      }
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
    sendLocationMsg,
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
  // _syncChatsToR2 removido — R2 é populado exclusivamente pelo webhook (api/webhook.js)
  // O cliente não deve sobrescrever o R2 com dados do localStorage
  function _syncChatsToR2() {}

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

  // ── Resync manual: reaplica R2 e sincroniza ──────────────────────────────────
  async function resyncChats() {
    if (USE_MOCK) return;
    // Merge @lid/@c.us duplicados no R2 antes de recarregar o chatlist
    await fetch("/api/r2-data?type=merge-lids", {
      method: "POST",
      headers: { "X-Internal-Key": ikey() },
    }).catch(() => {});
    await applyR2Chats();
    setTimeout(_syncChatsToR2, 3000);
    _batchResolveLids();
  }
}

