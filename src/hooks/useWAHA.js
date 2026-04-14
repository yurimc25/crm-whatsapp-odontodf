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
  getChats, getMessages, sendText, getSessionStatus,
  normalizeChat, normalizeMessage, getProfilePicture,
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
      deduped[existIdx] = {
        ...(newTs > exTs ? chat : ex),
        id:            ex.id.endsWith("@c.us") ? ex.id : (chat.id.endsWith("@c.us") ? chat.id : ex.id),
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
    .filter(k => k.startsWith("crm_waha_msgs_") || k.startsWith("crm_img_"))
    .forEach(k => localStorage.removeItem(k));
} catch {}

const LAST_SYNC_KEY  = "waha_last_sync_ts";       // timestamp da última sync bem-sucedida
const ikey           = () => import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";

// Resolve um @lid para o JID @c.us real.
// Estratégia (em ordem):
//   1. Cache (_lidToJid) — resultado anterior
//   2. API de contatos do WAHA
//   3. Busca por pushname no chatlist atual (_sessionChats)
// Falhas ficam em _lidFailed para evitar chamadas repetidas.
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
        if (jid && !jid.endsWith("@lid") && !jid.endsWith("@s.whatsapp.net")) {
          _lidToJid.set(lid, jid);
          console.log(`[lid] resolvido via API: ${lid} → ${jid}`);
          return jid;
        }
      }
    } catch {}
  }

  // Fallback 1: busca pelo pushname no chatlist atual
  if (pushname && _sessionChats.value?.length) {
    const pn = pushname.trim().toLowerCase();
    const match = _sessionChats.value.find(c =>
      c.pushname && c.pushname.trim().toLowerCase() === pn
    );
    if (match) {
      console.log(`[lid] resolvido por pushname "${pushname}": ${lid} → ${match.id}`);
      _lidToJid.set(lid, match.id);
      _lidFailed.delete(lid);
      return match.id;
    }
  }

  // Fallback 2: LID pode ter sido armazenado como @c.us com os mesmos dígitos (phantom antigo)
  // Ex: 267769870340186@lid → 267769870340186@c.us já existente no chatlist
  if (_sessionChats.value?.length) {
    const lidDigits = lid.replace(/\D/g, "");
    const phantom = _sessionChats.value.find(c => c.id.replace(/\D/g, "") === lidDigits);
    if (phantom) {
      console.log(`[lid] resolvido por phantom ID: ${lid} → ${phantom.id}`);
      _lidToJid.set(lid, phantom.id);
      _lidFailed.delete(lid);
      return phantom.id;
    }
  }

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
  const slim = chats.map(c => ({
    id:            c.id,
    pushname:      c.pushname      || "",
    lastMsg:       c.lastMsg       || "",
    lastTs:        c.lastTs        || null,
    lastPatientTs: c.lastPatientTs || null,
    unread:        c.unread        || 0,
    status:        c.status        || "open",
    assignedTo:    c.assignedTo    || null,
    tags:          c.tags          || [],
    photoUrl:      c.photoUrl      || null,
  }));
  try {
    localStorage.setItem("crm_" + CHATS_KEY, JSON.stringify({
      value: slim, expires: Date.now() + CHATS_TTL,
    }));
  } catch {
    // Quota exceeded mesmo com slim — libera mensagens antigas e tenta novamente
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith("crm_waha_msgs_") || k.startsWith("crm_img_"))
        .forEach(k => { try { localStorage.removeItem(k); } catch {} });
      localStorage.setItem("crm_" + CHATS_KEY, JSON.stringify({
        value: slim, expires: Date.now() + CHATS_TTL,
      }));
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
  /^(boa noite|boa tarde|bom dia)[!.\s🌙☀️🙏😊]*$/i,
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

function detectAutoResolve(msgs) {
  if (!msgs?.length) return false;
  const last5 = msgs.slice(-5);
  const lastPatient = [...last5].reverse().find(m => m.from === "patient");
  return lastPatient ? isFarewell(lastPatient.text) : false;
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
  const { lookupPhone, lookupPhonePriority, searchByName, addLocalContact, resolveName } = useContactsCtx();

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
    loadChats();
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
      const r2Map = Object.fromEntries(r2Chats.map(c => [c.id, c]));
      setChats(prev => {
        const base = prev.length ? prev : fallbackChats;
        if (!base.length) { console.log("[r2] applyR2Chats: sem base, aguardando WAHA"); return prev; }
        console.log(`[r2] applyR2Chats: prev=${prev.length} base=${base.length}`);
        const localIds = new Set(base.map(c => c.id));
        let changed = false;
        const updated = base.map(c => {
          const r2 = r2Map[c.id];
          if (!r2) return c;
          const r2TsMs  = r2.lastTs || 0;
          const localTs = c.lastTs ? new Date(c.lastTs).getTime() : 0;
          if (r2TsMs <= localTs) return c;
          changed = true;
          const isMuted = mutedChatsRef.current.has(c.id);
          const lpt = isMuted ? null
            : (r2.lastPatientTs ? new Date(r2.lastPatientTs).toISOString() : null);
          const unread = isMuted || !lpt ? 0
            : Math.max(r2.unread || 0, c.unread || 0);
          return {
            ...c,
            lastMsg:       r2.lastMsg || c.lastMsg,
            lastTs:        new Date(r2TsMs).toISOString(),
            lastPatientTs: lpt,
            unread,
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
          const isMuted = mutedChatsRef.current.has(r2.id);
          const lpt = isMuted ? null
            : (r2.lastPatientTs ? new Date(r2.lastPatientTs).toISOString() : null);
          updated.push({
            id:            r2.id,
            pushname:      r2.pushname || "",
            lastMsg:       r2.lastMsg  || "",
            lastTs:        r2.lastTs   ? new Date(r2.lastTs).toISOString() : null,
            lastPatientTs: lpt,
            unread:        isMuted || !lpt ? 0 : r2.unread || 0,
            status:        "open",
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

  // Auto-resync leve a cada 5 minutos (sem reset de lastSync)
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(_lightResync, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [sessionOk]);

  async function loadChats(forceFullSync = false) {
    setLoading(true);
    // Força sincronização completa: ignora lastSync, busca 100 dias
    if (forceFullSync) {
      try { localStorage.removeItem(LAST_SYNC_KEY); } catch {}
      console.log("[waha] force full sync: buscando 100 dias de histórico");
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

      // ── 2. R2: atualiza lastMsg/lastTs com dados persistidos pelo webhook ──
      // Calcula fromTs baseado na última sync salva (+ 1 dia de buffer)
      let fromTs = null;
      const lastSync = getLastSyncTs();
      if (lastSync > 0) {
        const msSinceSync = Date.now() - lastSync;
        const msToFetch   = msSinceSync + 86400000; // + 1 dia de buffer
        const daysToFetch = Math.min(Math.ceil(msToFetch / 86400000), 100);
        fromTs = Math.floor((Date.now() - daysToFetch * 86400000) / 1000);
        console.log(`[waha] última sync: ${new Date(lastSync).toLocaleString()} — buscando últimos ${daysToFetch} dias`);
      } else {
        fromTs = Math.floor((Date.now() - 100 * 86400000) / 1000);
        console.log("[waha] first load: buscando últimos 100 dias");
      }

      // Busca WAHA + MongoDB + R2 em paralelo
      const [raw, dbRes, r2Res] = await Promise.all([
        getChats(),
        fetch(`/api/db?action=chats`, { headers: { "X-Internal-Key": ikey() } })
          .then(r => r.json()).catch(() => ({ chats: {} })),
        fetch("/api/r2-data?type=chats", { headers: { "X-Internal-Key": ikey() } })
          .then(r => r.ok ? r.json() : []).catch(() => []),
      ]);

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

      const dbMeta = dbRes?.chats || {};
      // R2: mapa de id → { lastMsg, lastTs, lastPatientTs, unread } — webhook pré-computa
      const r2Map  = Array.isArray(r2Res)
        ? Object.fromEntries(r2Res.map(c => [c.id, c]))
        : {};
      console.log(`[r2] ${Object.keys(r2Map).length} chats no R2`);

      const normalized = filtered.map(c => {
        const n    = normalizeChat(c);
        const meta = dbMeta[n.id] || {};
        return { ...n, ...meta };
      });

      // Mescla com cache local — cache local TEM PRIORIDADE sobre WAHA
      // O WAHA não conhece status/resolved/lastPatientTs — só o local sabe
      // Auto-resolve 30 dias também feito aqui dentro para garantir estado correto
      const TRINTA_DIAS = 30 * 24 * 60 * 60 * 1000;
      const agora = Date.now();
      const toAutoResolveIds = new Set();

      setChats(prev => {
        const prevMap = Object.fromEntries(prev.map(c => [c.id, c]));
        const merged  = normalized.map(n => {
          const local   = prevMap[n.id];
          const r2      = r2Map[n.id];
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

          // Chat novo sem histórico local — usa WAHA + R2 (inclui unread/lastPatientTs do R2)
          if (!local) {
            const r2Lpt = r2?.lastPatientTs ? new Date(r2.lastPatientTs).toISOString() : null;
            const lpt   = isMuted ? null : r2Lpt;
            const unread = isMuted || !lpt ? 0 : r2?.unread || 0;
            const entry = { ...n, lastMsg: bestLastMsg, lastTs: bestLastTs, lastPatientTs: lpt, unread };
            if (lpt && agora - new Date(lpt).getTime() > TRINTA_DIAS && entry.status !== "resolved") {
              toAutoResolveIds.add(entry.id);
              return { ...entry, status: "resolved", unread: 0, lastPatientTs: null };
            }
            return entry;
          }

          // Chat existente — preserva estado local, atualiza lastMsg/lastTs/lpt com fontes mais recentes
          const resolvedLocally = local.status === "resolved";
          const r2Lpt    = r2?.lastPatientTs !== undefined
            ? (r2?.lastPatientTs ? new Date(r2.lastPatientTs).getTime() : null) : undefined;
          const localLpt = local.lastPatientTs ? new Date(local.lastPatientTs).getTime() : null;
          // null explícito no R2 significa "operador respondeu" — respeita isso
          const lpt = isMuted || resolvedLocally ? null
            : r2Lpt !== undefined
              ? (r2Lpt ? new Date(Math.max(r2Lpt, localLpt || 0)).toISOString() : null)
              : (local.lastPatientTs ?? null);
          const shouldAutoResolve = !resolvedLocally && lpt &&
            agora - new Date(lpt).getTime() > TRINTA_DIAS;
          if (shouldAutoResolve) toAutoResolveIds.add(n.id);

          const unread = isMuted || shouldAutoResolve || !lpt ? 0
            : r2?.unread !== undefined
              ? Math.max(r2.unread || 0, local.unread || 0)
              : (local.unread ?? n.unread ?? 0);

          return {
            ...n,
            lastMsg:       bestLastMsg,
            lastTs:        bestLastTs,
            lastPatientTs: (resolvedLocally || shouldAutoResolve) ? null : lpt,
            unread,
            status:        shouldAutoResolve ? "resolved" : (local.status ?? n.status),
            assignedTo:    local.assignedTo  ?? n.assignedTo,
            photoUrl:      local.photoUrl    ?? null,
            tags:          local.tags        ?? n.tags,
            pushname:      n.pushname || local.pushname || r2?.pushname,
          };
        });

        // ── CRÍTICO: preserva chats locais que o WAHA não retornou (mais antigos que fromTs)
        const wahaIds = new Set(normalized.map(c => c.id));
        for (const c of prev) {
          if (!wahaIds.has(c.id)) merged.push(c); // preserva sem modificar
        }

        // ── Deduplica por tail-8 de telefone (cobre @lid resolvido, formato antigo/novo BR)
        // e filtra chats apagados pelo operador + IDs inválidos (@lid, >13 dígitos)
        const deduped = _dedupeChats(merged);
        console.log(`[waha] loadChats setChats: prev=${prev.length} merged=${merged.length} deduped=${deduped.length}`);

        persistChats(deduped);
        // Persiste auto-resolves no MongoDB em background
        if (toAutoResolveIds.size > 0) {
          console.log(`[waha] auto-resolve: ${toAutoResolveIds.size} chats com >30 dias`);
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

      // Enriquece todos os chats via overview (nome, foto, última mensagem, @lid→@c.us)
      // Roda em background após 500ms para não bloquear a renderização inicial
      setTimeout(() => enrichViaOverview(normalized), 500);

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

  // ── Fotos de perfil — lotes de 10, cache 24h no localStorage ──
  async function loadProfilePictures(chatIds) {
    const PHOTO_KEY = "waha_photos_v2";
    const PHOTO_TTL = 24 * 60 * 60 * 1000;
    let photoCache  = {};
    try {
      const raw = localStorage.getItem(PHOTO_KEY);
      if (raw) {
        const p = JSON.parse(raw);
        if (Date.now() < p.expires) photoCache = p.value || {};
      }
    } catch {}

    // Filtra só quem não tem foto em cache
    const semFoto = chatIds.filter(id => !(id in photoCache));

    const BATCH = 10;
    for (let i = 0; i < semFoto.length; i += BATCH) {
      const batch = semFoto.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(async (chatId) => {
          const url = await getProfilePicture(chatId).catch(() => null);
          return { chatId, url };
        })
      );
      const updates = {};
      for (const r of results) {
        if (r.status === "fulfilled") {
          const { chatId, url } = r.value;
          photoCache[chatId] = url;
          updates[chatId]    = url;
        }
      }
      // Atualiza cache localStorage
      try {
        localStorage.setItem(PHOTO_KEY, JSON.stringify({
          value: photoCache, expires: Date.now() + PHOTO_TTL,
        }));
      } catch {}
      // Atualiza chats com fotos
      if (Object.keys(updates).length) {
        setChats(prev => {
          const updated = prev.map(c =>
            c.id in updates ? { ...c, photoUrl: updates[c.id] } : c
          );
          persistChats(updated);
          return updated;
        });
      }
      if (i + BATCH < semFoto.length) await new Promise(r => setTimeout(r, 500));
    }

    // Aplica fotos já em cache imediatamente
    const comFoto = Object.entries(photoCache).filter(([, v]) => v);
    if (comFoto.length) {
      setChats(prev => {
        const updated = prev.map(c => {
          const url = photoCache[c.id];
          return url !== undefined ? { ...c, photoUrl: url } : c;
        });
        persistChats(updated);
        return updated;
      });
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
        const autoRes   = isPatient && isFarewell(msg.text);
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
          // patient normal → +1 unread; despedida ou operador → zera unread
          unread:        isPatient && !autoRes && !isMuted ? (c.unread || 0) + 1
                       : !isPatient || autoRes            ? 0
                       : c.unread,
          status:        isPatient && !autoRes && !isMuted && c.status === "resolved" ? "open" : c.status,
        });
        // Persiste reabertura no MongoDB em background
        const reopened = updated.find(c => c.id === target.id);
        if (reopened?.status === "open" && target.status === "resolved") {
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
      setChats(prev => {
        if (prev.find(c => c.id === newChat.id)) return prev;
        const updated = [newChat, ...prev];
        persistChats(updated);
        return updated;
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
            // payload.from já tem o @c.us — resolve imediatamente
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
    delete seenMsgIds.current[chatId]; // reseta dedup para nova poll começar do zero
    // Busca contato on-demand com prioridade (ignora cache de sessão)
    try {
      const existing = resolveName(chatId, null);
      if (!existing && typeof lookupPhonePriority === "function") {
        lookupPhonePriority(chatId).then(name => {
          if (name) console.log(`[contacts] on-demand ${chatId} → ${name}`);
        }).catch(() => {});
      }
    } catch {}
    // Não zera unread ao abrir — só zera quando o operador enviar uma resposta

    // ── Cache em memória: exibe imediatamente se já carregou antes ──
    const cached = _sessionMsgs.get(chatId);
    if (cached?.length) {
      setMessages(prev => ({ ...prev, [chatId]: cached }));
    }

    if (USE_MOCK) {
      setMessages(prev => ({ ...prev, [chatId]: MOCK_MESSAGES[chatId] || [] }));
      return;
    }

    // ── R2: mescla mensagens persistidas pelo webhook ────────────
    // Roda em paralelo com o WAHA para não atrasar, aplica ao finalizar
    const r2MsgsPromise = fetch(`/api/r2-data?type=msgs&chatId=${encodeURIComponent(chatId)}`, {
      headers: { "X-Internal-Key": ikey() }
    }).then(r => r.ok ? r.json() : []).catch(() => []);

    try {
      const [raw, r2Raw] = await Promise.all([getMessages(chatId, 60), r2MsgsPromise]);
      const normalized = sortMsgs(raw.map(normalizeMessage));

      setMessages(prev => {
        const existing = prev[chatId] || [];
        const ids      = new Set(normalized.map(m => m.id));

        // Mescla mensagens do R2 (persistidas pelo webhook) que o WAHA não retornou
        const r2Extras = Array.isArray(r2Raw)
          ? r2Raw
              .filter(m => !ids.has(m.id) && m.chatId === chatId)
              .map(m => ({
                id:     m.id,
                chatId: m.chatId,
                from:   m.fromMe ? "operator" : "patient",
                text:   m.body || "",
                type:   m.type || "chat",
                ts:     m.ts ? new Date(m.ts).toISOString() : null,
                time:   m.ts ? new Date(m.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "",
              }))
          : [];

        const wsExtras = existing.filter(m => !ids.has(m.id) && !m.id.startsWith("tmp-"));
        const merged   = sortMsgs([...normalized, ...r2Extras, ...wsExtras]);
        _sessionMsgs.set(chatId, merged);
        return { ...prev, [chatId]: merged };
      });

      // Atualiza metadata do chat
      const lastAny   = normalized[normalized.length - 1];
      const lastOpIdx = normalized.map(m => m.from).lastIndexOf("operator");
      const lastPIdx  = normalized.map(m => m.from).lastIndexOf("patient");
      const semResp   = lastOpIdx === -1
        ? normalized.filter(m => m.from === "patient")
        : normalized.slice(lastOpIdx + 1).filter(m => m.from === "patient");
      const ultimoFoiOp = lastOpIdx > lastPIdx || lastPIdx === -1;
      const autoResolve = detectAutoResolve(normalized);
      const novoLPTs    = (ultimoFoiOp || autoResolve) ? null : (semResp[0]?.ts || null);

      setChats(prev => {
        const existing = prev.find(c => c.id === chatId);
        const updated = prev.map(c => c.id !== chatId ? c : {
          ...c,
          lastMsg:       lastAny?.text || c.lastMsg,
          lastTime:      lastAny?.time || c.lastTime,
          lastPatientTs: novoLPTs,
          // Unread só é zerado ao enviar resposta (send/markRead) — abrir o chat não zera
          unread:        existing?.unread ?? 0,
        });
        persistChats(updated);
        return updated;
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
    try { await sendText(chatId, formatted); }
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
    mutedChats,
    muteChat,
    unmuteChat,
    loading,
    error,
    wsStatus,
    myJid,
  };

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

      const r2Map    = Object.fromEntries((Array.isArray(r2Res) ? r2Res : []).map(c => [c.id, c]));
      const normalized = wahaRes.map(c => normalizeChat(c));

      setChats(prev => {
        const prevMap = Object.fromEntries(prev.map(c => [c.id, c]));
        const merged  = normalized.map(n => {
          const local   = prevMap[n.id];
          const r2      = r2Map[n.id];
          const isMuted = mutedChatsRef.current.has(n.id);

          const wahaTsMs  = n.lastTs   ? new Date(n.lastTs).getTime()   : 0;
          const r2TsMs    = r2?.lastTs || 0;
          const localTsMs = local?.lastTs ? new Date(local.lastTs).getTime() : 0;
          const bestTsMs  = Math.max(wahaTsMs, r2TsMs, localTsMs);

          const lastMsg = r2TsMs > wahaTsMs && r2TsMs > localTsMs && r2?.lastMsg ? r2.lastMsg
            : wahaTsMs >= r2TsMs && wahaTsMs >= localTsMs && n.lastMsg           ? n.lastMsg
            : local?.lastMsg || n.lastMsg || r2?.lastMsg || "";

          const lastTs = bestTsMs ? new Date(bestTsMs).toISOString() : (n.lastTs || local?.lastTs);

          const r2Lpt   = r2?.lastPatientTs ? new Date(r2.lastPatientTs).getTime() : null;
          const localLpt = local?.lastPatientTs ? new Date(local.lastPatientTs).getTime() : null;
          const lpt = isMuted ? null
            : r2?.lastPatientTs !== undefined
              ? (r2Lpt ? new Date(Math.max(r2Lpt, localLpt || 0)).toISOString() : null)
              : (local?.lastPatientTs ?? null);

          const unread = isMuted || !lpt ? 0
            : r2?.unread !== undefined
              ? Math.max(r2.unread || 0, local?.unread || 0)
              : (local?.unread ?? n.unread ?? 0);

          return {
            ...(local || n),
            lastMsg, lastTs, unread, lastPatientTs: lpt,
            status:     local?.status     ?? n.status,
            assignedTo: local?.assignedTo ?? n.assignedTo,
            tags:       local?.tags       ?? n.tags,
            pushname:   n.pushname || local?.pushname || r2?.pushname,
          };
        });
        const wahaIds = new Set(normalized.map(c => c.id));
        for (const c of prev) if (!wahaIds.has(c.id)) merged.push(c);
        persistChats(merged);
        return merged;
      });
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