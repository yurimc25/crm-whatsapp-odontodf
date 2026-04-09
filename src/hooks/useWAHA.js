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
import { cache } from "../utils/cache";

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
const CONTACTS_SCAN_KEY = "waha_contacts_scan_at";
const CONTACTS_SCAN_INTERVAL = 12 * 60 * 60 * 1000; // 2x/dia
function shouldScanContacts() {
  try {
    const last = parseInt(localStorage.getItem(CONTACTS_SCAN_KEY) || "0");
    return Date.now() - last > CONTACTS_SCAN_INTERVAL;
  } catch { return true; }
}
function markContactsScan() {
  try { localStorage.setItem(CONTACTS_SCAN_KEY, String(Date.now())); } catch {}
}
const CHATS_KEY      = "waha_chats";
const MSGS_PREFIX    = "waha_msgs_";
const CHATS_TTL      = 7  * 24 * 60 * 60 * 1000; // 7 dias
const MSGS_TTL       = 30 * 24 * 60 * 60 * 1000; // 30 dias
const LAST_SYNC_KEY  = "waha_last_sync_ts";       // timestamp da última sync bem-sucedida
const ikey           = () => import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";

function getLastSyncTs() {
  try { return parseInt(localStorage.getItem(LAST_SYNC_KEY) || "0"); } catch { return 0; }
}
function markLastSync() {
  try { localStorage.setItem(LAST_SYNC_KEY, String(Date.now())); } catch {}
}

// Persiste chats no cache utility E no localStorage diretamente
// Garante que F5 sempre lê o estado correto
function persistChats(chats) {
  cache.set(CHATS_KEY, chats, CHATS_TTL);
  try {
    localStorage.setItem("crm_" + CHATS_KEY, JSON.stringify({
      value:   chats,
      expires: Date.now() + CHATS_TTL,
    }));
  } catch {}
}

// Palavras de despedida para auto-resolver
const FAREWELL_PATTERNS = [
  /^(ok|okay|oks|okey)[\s!.]*$/i,
  /obrigad/i, /agradeç/i, /igualmente/i,
  /disponha/i, /excelente dia/i, /boa noite/i, /boa tarde/i, /bom dia/i,
  /até logo/i, /tchau/i, /flw/i, /vlw/i, /falou/i,
];
function isFarewell(text) {
  if (!text) return false;
  return FAREWELL_PATTERNS.some(p => p.test(text.trim()));
}

function detectAutoResolve(msgs) {
  if (!msgs?.length) return false;
  const last5 = msgs.slice(-5);
  const lastPatient = [...last5].reverse().find(m => m.from === "patient");
  return lastPatient ? isFarewell(lastPatient.text) : false;
}

export function useWAHA(operator) {
  const [chats,    setChats]    = useState(() => {
    // Tenta cache utility primeiro, depois localStorage direto como fallback
    const fromCache = cache.get(CHATS_KEY);
    if (fromCache?.length) return fromCache;
    try {
      const raw = localStorage.getItem("crm_" + CHATS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.value?.length && Date.now() < parsed.expires) return parsed.value;
      }
    } catch {}
    return [];
  });
  const [messages, setMessages] = useState({});
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState(null);
  const [wsStatus, setWsStatus] = useState("disconnected");
  const [sessionOk, setSessionOk] = useState(false);

  const activeChatRef = useRef(null);
  const socketRef     = useRef(null);
  const wsConnected   = useRef(false);
  const { lookupPhone, lookupPhonePriority, searchByName, addLocalContact, resolveName } = useContactsCtx();

  const perms = { verTodos: operator?.role === "gerente" || operator?.role === "admin" };

  // ── 1. Sessão ────────────────────────────────────────────────
  useEffect(() => {
    if (USE_MOCK) { setSessionOk(true); return; }
    async function checkSession() {
      try {
        const s = await getSessionStatus();
        setSessionOk(s.status === "WORKING" || s.status === "CONNECTED");
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
  // Estratégia: cache local primeiro → depois WAHA para período desde última atualização
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    loadChats();
  }, [sessionOk]);

  async function loadChats() {
    setLoading(true);
    try {
      // Lê cache do localStorage diretamente (mais confiável que cache utility após F5)
      let cachedChats = cache.get(CHATS_KEY) || [];
      if (!cachedChats.length) {
        try {
          const raw = localStorage.getItem("crm_" + CHATS_KEY);
          if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed?.value?.length && Date.now() < parsed.expires) {
              cachedChats = parsed.value;
              // Restaura estado imediatamente do localStorage
              setChats(cachedChats);
            }
          }
        } catch {}
      }

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

      const raw = await getChats();
      if (!Array.isArray(raw)) return;

      const filtered = fromTs
        ? raw.filter(c => {
            const lm = c.lastMessage;
            const ts = lm?.timestamp || lm?.t || 0;
            return ts === 0 || ts >= fromTs;
          })
        : raw;

      // Metadata do MongoDB
      const dbRes = await fetch(`/api/db?action=chats`, {
        headers: { "X-Internal-Key": ikey() }
      }).then(r => r.json()).catch(() => ({ chats: {} }));
      const dbMeta = dbRes.chats || {};

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
          const local = prevMap[n.id];
          // Chat novo sem histórico local — usa dados do WAHA
          if (!local) {
            // Verifica se já deveria ser auto-resolvido
            const lpt = n.lastPatientTs ? new Date(n.lastPatientTs).getTime() : 0;
            if (lpt && agora - lpt > TRINTA_DIAS && n.status !== "resolved") {
              toAutoResolveIds.add(n.id);
              return { ...n, status: "resolved", unread: 0, lastPatientTs: null };
            }
            return n;
          }
          // Chat existente — preserva estado local
          const resolvedLocally = local.status === "resolved";
          const lpt = resolvedLocally ? null
            : (local.lastPatientTs ?? n.lastPatientTs);
          // Auto-resolve: aberto + lastPatientTs > 30 dias
          const shouldAutoResolve = !resolvedLocally && lpt &&
            agora - new Date(lpt).getTime() > TRINTA_DIAS;
          if (shouldAutoResolve) toAutoResolveIds.add(n.id);
          return {
            ...n,
            status:        shouldAutoResolve ? "resolved" : (local.status ?? n.status),
            assignedTo:    local.assignedTo  ?? n.assignedTo,
            unread:        shouldAutoResolve ? 0 : (local.unread ?? n.unread),
            lastPatientTs: (resolvedLocally || shouldAutoResolve) ? null : lpt,
            lastMsg:       n.lastMsg   || local.lastMsg || "",
            photoUrl:      local.photoUrl ?? null,
            tags:          local.tags    ?? n.tags,
          };
        });
        persistChats(merged);
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
        return merged;
      });

      markLastSync();

      const chatIds = normalized.map(c => c.id);

      // ── Auto-sincroniza contatos: phone → name → bulk Google, depois MongoDB ──
      async function autoSyncContacts(chatsToSync) {
        console.log(`[waha] starting auto-sync for ${chatsToSync.length} chats`);
        const internalKey = import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";
        const syncedContacts = {};
        
        // Batches de 3 para não travar a renderização
        for (let i = 0; i < chatsToSync.length; i += 3) {
          const batch = chatsToSync.slice(i, Math.min(i + 3, chatsToSync.length));
          
          await Promise.allSettled(batch.map(async (chat) => {
            const chatId = chat.id;
            // Verifica se já tem contato mapeado
            const alreadyHas = resolveName(chatId, null);
            if (alreadyHas) {
              console.debug(`[auto-sync] ${chatId} já tem contato: ${alreadyHas}`);
              return;
            }
            
            // 1. Tenta por telefone
            let found = null;
            try { found = await lookupPhone(chatId).catch(() => null); } catch (e) {}
            if (found) {
              console.log(`[auto-sync] ${chatId} → ${found} (via phone)`);
              return;
            }
            
            // 2. Tenta por nome (pushname)
            const nameToTry = chat.pushname || chat.name || null;
            if (nameToTry) {
              try { 
                const result = await searchByName(nameToTry).catch(() => false);
                if (result) {
                  console.log(`[auto-sync] ${chatId} → (via name "${nameToTry}")`);
                  return;
                }
              } catch (e) {}
            }
            
            console.debug(`[auto-sync] ${chatId} not found via phone/name`);
          }));
          
          // Pausa entre batches
          if (i + 3 < chatsToSync.length) await new Promise(r => setTimeout(r, 200));
        }
        
        // Força sync com MongoDB ao final
        if (Object.keys(syncedContacts).length > 0) {
          console.log(`[auto-sync] completed: ${Object.keys(syncedContacts).length} contacts synced`);
          try {
            // Tenta ler o mapa local atualizado e sincronizar com MongoDB
            await fetch("/api/db?action=contacts_cache", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey },
              body: JSON.stringify({ contacts: syncedContacts }),
            }).catch(() => {});
          } catch (e) {
            console.warn("[auto-sync] MongoDB sync failed:", e?.message);
          }
        }
      }

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

      // Dispara auto-sync em background apenas 2x/dia
      try {
        if (typeof lookupPhone === "function" && typeof searchByName === "function") {
          if (shouldScanContacts()) {
            markContactsScan();
            setTimeout(() => {
              autoSyncContacts(normalized).catch((e) => {
                console.error("[auto-sync] error:", e?.message || e);
              });
            }, 500);
          } else {
            console.log("[auto-sync] skip — última varredura < 12h atrás");
          }
        }
      } catch (e) {}

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
    const BATCH = 3; // Reduzido: menos concorrência para não travar o WAHA
    for (let i = 0; i < chatIds.length; i += BATCH) {
      const batch = chatIds.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async (chatId) => {
        try {
          const SESSION = import.meta.env.VITE_WAHA_SESSION || "default";
          const id = encodeURIComponent(chatId);
          const r  = await fetch(
            `/api/waha?path=/api/${SESSION}/chats/${id}/messages&limit=1&downloadMedia=false`,
            { headers: { "X-Internal-Key": ikey() } }
          );
          if (!r.ok) return;
          const raw = await r.json();
          if (!Array.isArray(raw) || raw.length === 0) return;
          const msg = normalizeMessage(raw[raw.length - 1]);
          const lastMsg = msg.text || (msg.location ? "📍 Localização" : msg.media ? "📎 Mídia" : "");

          setChats(prev => {
            const updated = prev.map(c => {
              if (c.id !== chatId) return c;
              const isPatient = msg.from === "patient";
              const autoRes   = isPatient && isFarewell(msg.text);
              return {
                ...c,
                lastMsg:  lastMsg || c.lastMsg,
                lastTime: msg.time || c.lastTime,
                lastTs:   msg.ts   || c.lastTs,
                lastPatientTs: isPatient && !autoRes ? msg.ts : c.lastPatientTs,
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

      if (msg.from === "patient" && document.hidden) {
        try {
          navigator.serviceWorker?.controller?.postMessage({
            type: "SHOW_NOTIFICATION",
            title: msg.chatId?.replace(/@.*$/, "") || "Paciente",
            body: msg.text?.slice(0, 100) || "Nova mensagem",
            chatId: msgChatId,
          });
        } catch {}
      }

      setMessages(prev => {
        const existing = prev[msgChatId] || [];
        if (existing.find(m => m.id === msg.id)) return prev;
        const semTmp  = removeTmp(existing, [msg]);
        const updated = sortMsgs([...semTmp, msg]);
        cache.set(MSGS_PREFIX + msgChatId, updated, MSGS_TTL);
        return { ...prev, [msgChatId]: updated };
      });

      setChats(prev => {
        const exists    = prev.find(c => c.id === msgChatId);
        const isPatient = msg.from === "patient";
        const isActive  = msgChatId === activeChatRef.current;
        const autoRes   = isPatient && isFarewell(msg.text);
        const lastMsg   = msg.text || (msg.location ? "📍 Localização" : msg.media ? "📎 Mídia" : "");
        if (!exists) return prev;
        const updated = prev.map(c => c.id !== msgChatId ? c : {
          ...c,
          lastMsg,
          lastTime:      msg.time,
          lastTs:        msg.ts,
          lastPatientTs: isPatient && !autoRes ? msg.ts : c.lastPatientTs,
          unread: isPatient && !isActive && !autoRes ? (c.unread || 0) + 1 : c.unread,
        });
        persistChats(updated);
        return updated;
      });
    }

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
        if (!msg.chatId && payload.from) msg.chatId = payload.from.replace(/:.*@/, "@");
        handleMsg(msg);
      } else if (event === "chat.new") {
        handleChatNew(payload);
      } else if (event === "message.revoked") {
        const msgId = payload.id || payload._data?.id?.id;
        const chatId = payload.from || payload.chatId;
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

        socketRef.current = { close: () => ps.close() };
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
    // Busca contato on-demand com prioridade (ignora cache de sessão)
    try {
      const existing = resolveName(chatId, null);
      if (!existing && typeof lookupPhonePriority === "function") {
        lookupPhonePriority(chatId).then(name => {
          if (name) console.log(`[contacts] on-demand ${chatId} → ${name}`);
        }).catch(() => {});
      }
    } catch {}
    // Zera unread apenas ao abrir (se já respondido o unread será zerado ao enviar)
    setChats(prev => {
      const chat = prev.find(c => c.id === chatId);
      // Mantém unread se paciente está aguardando resposta
      const keepUnread = chat?.lastPatientTs && chat?.unread > 0;
      const updated = prev.map(c => c.id === chatId ? { ...c, unread: keepUnread ? c.unread : 0 } : c);
      persistChats(updated);
      return updated;
    });

    // Exibe cache local imediatamente se tiver
    const cached = cache.get(MSGS_PREFIX + chatId);
    if (cached?.length) {
      setMessages(prev => ({ ...prev, [chatId]: cached }));
    }

    if (USE_MOCK) {
      setMessages(prev => ({ ...prev, [chatId]: MOCK_MESSAGES[chatId] || [] }));
      return;
    }

    try {
      const raw        = await getMessages(chatId, 60);
      const normalized = sortMsgs(raw.map(normalizeMessage));

      setMessages(prev => {
        // Mescla com cache para não perder msgs do WS que chegaram enquanto carregava
        const existing = prev[chatId] || [];
        const ids      = new Set(normalized.map(m => m.id));
        const extras   = existing.filter(m => !ids.has(m.id) && !m.id.startsWith("tmp-"));
        const merged   = sortMsgs([...normalized, ...extras]);
        cache.set(MSGS_PREFIX + chatId, merged, MSGS_TTL);
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
        // Mantém unread se paciente ainda aguarda resposta (não zeramos ao só "ler")
        const keepUnread = !ultimoFoiOp && !autoResolve && (existing?.unread || 0) > 0;
        const updated = prev.map(c => c.id !== chatId ? c : {
          ...c,
          lastMsg:       lastAny?.text || c.lastMsg,
          lastTime:      lastAny?.time || c.lastTime,
          lastPatientTs: novoLPTs,
          unread:        keepUnread ? (existing?.unread || 0) : 0,
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
        cache.set(MSGS_PREFIX + chatId, updated, MSGS_TTL);
        return { ...prev, [chatId]: updated };
      });

      const diasAtras = Math.floor((Date.now() / 1000 - windowStart) / 86400);
      return { hasMore: diasAtras < 100, loaded: novas.length };
    } catch { return { hasMore: false }; }
  }, []);

  // ── Polling mensagens do chat ativo ──────────────────────────
  // Só roda quando PartyKit está desconectado (fallback direto ao WAHA)
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(async () => {
      // Pula se WS está conectado — ele já entrega as mensagens em tempo real
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
        setMessages(prev => {
          const current = prev[chatId] || [];
          const ids     = new Set(current.filter(m => !m.id.startsWith("tmp-")).map(m => m.id));
          const novos   = normalized.filter(m => !ids.has(m.id));
          if (!novos.length) return prev;
          const semTmp  = removeTmp(current, novos);
          const updated = sortMsgs([...semTmp, ...novos]);
          cache.set(MSGS_PREFIX + chatId, updated, MSGS_TTL);
          return { ...prev, [chatId]: updated };
        });
      } catch {}
    }, 5000); // 5s no fallback (WS desconectado)
    return () => clearInterval(iv);
  }, [sessionOk]);

  // ── Polling lista de chats (10s quando WS conectado, 5s no fallback) ──
  // Busca apenas chats com atividade nos últimos 5 minutos para reduzir carga
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(async () => {
      try {
        const SESSION = import.meta.env.VITE_WAHA_SESSION || "default";
        // Cutoff: 5 minutos atrás (em segundos) — só chats recentes
        const cutoffSec = Math.floor((Date.now() - 5 * 60 * 1000) / 1000);
        const r = await fetch(
          `/api/waha?path=/api/${SESSION}/chats?limit=20&updatedAt.gte=${cutoffSec}`,
          { headers: { "X-Internal-Key": ikey() } }
        );
        const raw = r.ok ? await r.json() : null;
        // Fallback: se a API não suporta updatedAt.gte, retorna lista maior — filtra client-side
        const all = Array.isArray(raw) ? raw : [];
        const recent = all.filter(c => {
          const ts = c.lastMessage?.timestamp || c.lastMessage?.t || 0;
          return ts >= cutoffSec;
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
            // Se WAHA devolveu msg vazia mas lastTs mudou → enfileira busca individual
            if (!n.lastMsg && n.lastTs && n.lastTs !== c.lastTs) {
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
          // Chats novos
          const ids = new Set(prev.map(c => c.id));
          for (const n of normalized) {
            if (!ids.has(n.id)) { updated.push(n); changed = true; precisamMsg.push(n.id); }
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
      cache.set(MSGS_PREFIX + chatId, updated, MSGS_TTL);
      return { ...prev, [chatId]: updated };
    });
    setChats(prev => {
      const updated = prev.map(c => c.id !== chatId ? c : {
        ...c, lastMsg: formatted, lastTime: tmpMsg.time, lastPatientTs: null,
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
      cache.set(MSGS_PREFIX + chatId, updated, MSGS_TTL);
      return { ...prev, [chatId]: updated };
    });
  }, []);

  const editMsg = useCallback(async (chatId, msgId, newText) => {
    try { await wahaEditMessage(chatId, msgId, newText); } catch {}
    setMessages(prev => {
      const updated = (prev[chatId] || []).map(m =>
        m.id === msgId ? { ...m, text: newText, edited: true } : m
      );
      cache.set(MSGS_PREFIX + chatId, updated, MSGS_TTL);
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

  return {
    chats, setChats,
    messages,
    loadMessages,
    loadOlderMessages,
    send,
    deleteMsg,
    editMsg,
    forwardChat,
    resolveChat,
    markRead,
    markUnread,
    searchMessages,
    loading,
    error,
    wsStatus,
  };
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