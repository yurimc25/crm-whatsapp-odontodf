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
  normalizeChat, normalizeMessage, createWAHASocket, getProfilePicture,
} from "../services/waha";
import { MOCK_CHATS, MOCK_MESSAGES } from "../data/mock";
import { cache } from "../utils/cache";

// Ordena mensagens — estável por timestamp + índice original
function sortMsgs(msgs) {
  return msgs.map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const diff = new Date(a.m.ts) - new Date(b.m.ts);
      return diff !== 0 ? diff : a.i - b.i;
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
const CHATS_KEY   = "waha_chats";
const MSGS_PREFIX = "waha_msgs_";
const CHATS_TTL   = 7  * 24 * 60 * 60 * 1000; // 7 dias
const MSGS_TTL    = 30 * 24 * 60 * 60 * 1000; // 30 dias
const ikey        = () => import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";

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
  const { lookupPhone, searchByName, addLocalContact, resolveName } = useContactsCtx();

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

      let fromTs = null;
      if (cachedChats.length > 0) {
        const lastTs = Math.max(...cachedChats.map(c => {
          const ts = c.lastTs || c.lastTime;
          return ts ? new Date(ts).getTime() : 0;
        }).filter(Boolean));
        if (lastTs > 0) {
          const daysSince = Math.ceil((Date.now() - lastTs) / 86400000) + 1;
          const daysToFetch = Math.min(daysSince, 100);
          fromTs = Math.floor((Date.now() - daysToFetch * 86400000) / 1000);
          console.log(`[waha] cache hit: buscando últimos ${daysToFetch} dias`);
        }
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
            
            // 3. Fallback: bulk Google search e procura o número nele
            try {
              const r = await fetch("/api/contacts", {
                headers: { "X-Internal-Key": internalKey }
              });
              if (r.ok) {
                const { contacts: googleMap } = await r.json();
                if (googleMap && typeof googleMap === "object") {
                  // Extrai telefone do chat
                  const phone = chatId.replace(/@.*$/, "").replace(/\D/g, "");
                  // Procura o número no mapa do Google
                  for (const [key, name] of Object.entries(googleMap)) {
                    if (key.includes(phone.slice(-8))) {
                      // Encontrou um match parcial
                      if (addLocalContact && typeof addLocalContact === "function") {
                        addLocalContact({ phone, name });
                        syncedContacts[phone] = name;
                        console.log(`[auto-sync] ${chatId} → ${name} (via bulk Google)`);
                      }
                      return;
                    }
                  }
                }
              }
            } catch (e) {
              console.warn(`[auto-sync] bulk Google failed:`, e?.message);
            }
            
            console.debug(`[auto-sync] ${chatId} not found (phone/name/bulk all failed)`);
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

      // Dispara auto-sync em background (não bloqueia renderização)
      try {
        if (typeof lookupPhone === "function" && typeof searchByName === "function") {
          setTimeout(() => {
            autoSyncContacts(normalized).catch((e) => {
              console.error("[auto-sync] error:", e?.message || e);
            });
          }, 500);
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
    const BATCH = 5;
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

          setChats(prev => {
            const updated = prev.map(c => {
              if (c.id !== chatId) return c;
              const lastAny = msg;
              const isPatient = msg.from === "patient";
              const autoRes   = isPatient && isFarewell(msg.text);
              return {
                ...c,
                lastMsg:  msg.text || c.lastMsg,
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
      // Pausa entre lotes para não travar
      if (i + BATCH < chatIds.length) await new Promise(r => setTimeout(r, 300));
    }
  }

  // ── 3. WebSocket — tempo real ─────────────────────────────────
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    socketRef.current = createWAHASocket({
      onMessage: (msg) => {
        const msgChatId = msg.chatId;
        if (!msgChatId) return;

        // Atualiza ChatWindow só se estiver aberto
        setMessages(prev => {
          const existing = prev[msgChatId] || [];
          if (existing.find(m => m.id === msg.id)) return prev;
          const semTmp  = removeTmp(existing, [msg]);
          const updated = sortMsgs([...semTmp, msg]);
          cache.set(MSGS_PREFIX + msgChatId, updated, MSGS_TTL);
          return { ...prev, [msgChatId]: updated };
        });

        // Sempre atualiza preview na ChatList
        setChats(prev => {
          const updated = prev.map(c => {
            if (c.id !== msgChatId) return c;
            const isPatient = msg.from === "patient";
            const isActive  = msgChatId === activeChatRef.current;
            const autoRes   = isPatient && isFarewell(msg.text);
            return {
              ...c,
              lastMsg:       msg.text,
              lastTime:      msg.time,
              lastTs:        msg.ts,
              lastPatientTs: isPatient && !autoRes ? msg.ts : c.lastPatientTs,
              unread: isPatient && !isActive && !autoRes ? (c.unread || 0) + 1 : c.unread,
            };
          });
          persistChats(updated);
          return updated;
        });
      },
      onStatus: setWsStatus,
      onError:  () => setWsStatus("reconnecting"),
    });
    return () => socketRef.current?.close();
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
    // Zera unread
    setChats(prev => {
      const updated = prev.map(c => c.id === chatId ? { ...c, unread: 0 } : c);
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
        const updated = prev.map(c => c.id !== chatId ? c : {
          ...c,
          lastMsg:       lastAny?.text || c.lastMsg,
          lastTime:      lastAny?.time || c.lastTime,
          lastPatientTs: novoLPTs,
          unread:        0,
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

  // ── Polling leve para chats ativos (30s) ──────────────────────
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(async () => {
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
    }, 30000);
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

  return {
    chats, setChats,
    messages,
    loadMessages,
    loadOlderMessages,
    send,
    forwardChat,
    resolveChat,
    markRead,
    markUnread,
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