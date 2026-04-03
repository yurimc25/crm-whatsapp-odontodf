// src/hooks/useWAHA.js
// Cache em localStorage:
//   - Lista de chats: 5 minutos
//   - Mensagens por chat: 10 minutos (atualiza em background ao abrir)

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getChats, getMessages, sendText, getSessionStatus,
  normalizeChat, normalizeMessage, createWAHASocket,
} from "../services/waha";
import { MOCK_CHATS, MOCK_MESSAGES } from "../data/mock";
import { cache } from "../utils/cache";

const USE_MOCK    = import.meta.env.VITE_USE_MOCK === "true";
const CHATS_KEY   = "waha_chats";
const MSGS_PREFIX = "waha_msgs_";
const CHATS_TTL = 30 * 60 * 1000;      // 30min
const MSGS_TTL  = 24 * 60 * 60 * 1000; // 24h

export function useWAHA(operator) {
  // Carrega lista de chats do cache imediatamente
  const [chats, setChats]         = useState(() => cache.get(CHATS_KEY) || []);
  const [messages, setMessages]   = useState({});
  const [loading, setLoading]     = useState(!cache.get(CHATS_KEY)); // só mostra loading se não tem cache
  const [wsStatus, setWsStatus]   = useState("disconnected");
  const [sessionOk, setSessionOk] = useState(null);
  const [error, setError]         = useState(null);

  const activeChatRef = useRef(null);
  const socketRef     = useRef(null);

  // ── 1. Status da sessão ─────────────────────────────────────
  useEffect(() => {
    if (USE_MOCK) {
      setSessionOk(true);
      if (!cache.get(CHATS_KEY)) setChats(MOCK_CHATS);
      setLoading(false);
      return;
    }

    getSessionStatus()
      .then(s => {
        const ok = s.status === "WORKING";
        setSessionOk(ok);
        if (!ok) setError(`Sessão WAHA: ${s.status}. Escaneie o QR Code no dashboard.`);
      })
      .catch(e => {
        setSessionOk(false);
        setError(`Não foi possível conectar ao WAHA: ${e.message}`);
      });
  }, []);

  // ── 2. Carrega lista de chats ────────────────────────────────
  useEffect(() => {
    if (!sessionOk) return;

    async function load() {
      // Só mostra loading se não tem nada em cache
      if (!cache.get(CHATS_KEY)) setLoading(true);

      try {
        const raw = await getChats();
        const normalized = raw
          .filter(c => !c.id.endsWith("@g.us"))
          .map(normalizeChat);

        // Preserva campos locais (status, assignedTo, tags) do cache anterior
        const prev = cache.get(CHATS_KEY) || [];
        const merged = normalized.map(c => {
          const old = prev.find(p => p.id === c.id);
          return old
            ? { ...c, status: old.status, assignedTo: old.assignedTo, tags: old.tags }
            : c;
        });

        // Cruza com metadata do MongoDB (status, tags, assignedTo)
        try {
          const ikey = import.meta.env.VITE_INTERNAL_API_KEY || "";
          const dbRes = await fetch(`/api/db?action=chats`, {
            headers: { "X-Internal-Key": ikey },
          });
          if (dbRes.ok) {
            const { chats: dbMeta } = await dbRes.json();
            const withMeta = merged.map(c => {
              const meta = dbMeta[c.id];
              return meta ? { ...c, ...meta } : c;
            });
            setChats(withMeta);
            cache.set(CHATS_KEY, withMeta, CHATS_TTL);
            // Carrega última mensagem de cada chat em background (sem bloquear a UI)
            Promise.allSettled(
              withMeta
                .filter(c => !c.lastMsg) // só os que ainda não têm mensagem
                .slice(0, 20)            // máximo 20 para não sobrecarregar
                .map(async c => {
                  try {
                    const raw = await getMessages(c.id, 5);
                    if (!raw?.length) return;
                    const msgs = raw.map(normalizeMessage).reverse();
                    const lastAny = msgs[msgs.length - 1];
                    const lastPatient = [...msgs].reverse().find(m => m.from === "patient");

                    // Salva mensagens no cache
                    const cachedMsgs = cache.get(MSGS_PREFIX + c.id) || [];
                    if (!cachedMsgs.length) {
                      cache.set(MSGS_PREFIX + c.id, msgs, MSGS_TTL);
                      setMessages(prev => ({ ...prev, [c.id]: msgs }));
                    }

                    setChats(prev => {
                      const updated = prev.map(x => x.id !== c.id ? x : {
                        ...x,
                        lastMsg:       lastAny?.text || x.lastMsg,
                        lastTime:      lastAny?.time || x.lastTime,
                        lastPatientTs: lastPatient?.ts || x.lastPatientTs,
                      });
                      cache.set(CHATS_KEY, updated, CHATS_TTL);
                      return updated;
                    });
                  } catch (_) {}
                })
            );
          } else {
            setChats(merged);
            cache.set(CHATS_KEY, merged, CHATS_TTL);
          }
        } catch {
          setChats(merged);
          cache.set(CHATS_KEY, merged, CHATS_TTL);
        }
      } catch (e) {
        setError(`Erro ao carregar chats: ${e.message}`);
        // Mantém cache antigo
      } finally {
        setLoading(false);
      }
    }

    load();
    const interval = setInterval(load, CHATS_TTL);
    return () => clearInterval(interval);
  }, [sessionOk]);

  // ── 3. WebSocket ─────────────────────────────────────────────
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;

    socketRef.current = createWAHASocket({
      onMessage: (msg) => {
        const chatId = activeChatRef.current;
        if (!chatId) return;

        setMessages(prev => {
          const existing = prev[chatId] || [];
          if (existing.find(m => m.id === msg.id)) return prev;
          const updated = [...existing, msg];
          cache.set(MSGS_PREFIX + chatId, updated, MSGS_TTL);
          return { ...prev, [chatId]: updated };
        });

        if (msg.from === "patient" && msg.ts) {
          setChats(prev => {
            const updated = prev.map(c =>
              c.id !== activeChatRef.current ? c
              : { ...c, lastMsg: msg.text, lastTime: msg.time, lastPatientTs: msg.ts }
            );
            cache.set(CHATS_KEY, updated, CHATS_TTL);
            return updated;
          });
        }

        setChats(prev => {
          const updated = prev.map(c =>
            c.id !== activeChatRef.current && msg.from === "patient"
              ? { ...c, unread: (c.unread || 0) + 1, lastMsg: msg.text, lastTime: msg.time }
              : c
          );
          cache.set(CHATS_KEY, updated, CHATS_TTL);
          return updated;
        });
      },
      onStatus: setWsStatus,
      onError:  (e) => console.warn("[WS]", e),
    });

    return () => socketRef.current?.close();
  }, [sessionOk]);

  // ── 4. Carrega mensagens de um chat ──────────────────────────
  const loadMessages = useCallback(async (chatId) => {
    activeChatRef.current = chatId;

    // Zera badge
    setChats(prev => {
      const updated = prev.map(c => c.id === chatId ? { ...c, unread: 0 } : c);
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });

    // Exibe cache instantaneamente
    const cached = cache.get(MSGS_PREFIX + chatId);
    if (cached) setMessages(prev => ({ ...prev, [chatId]: cached }));

    if (USE_MOCK) {
      setMessages(prev => ({ ...prev, [chatId]: MOCK_MESSAGES[chatId] || [] }));
      return;
    }

    try {
      // Busca as últimas 100 mensagens (máximo que cabe no localStorage)
      const raw = await getMessages(chatId, 100);
      const normalized = raw.map(normalizeMessage).reverse();
      setMessages(prev => ({ ...prev, [chatId]: normalized }));
      cache.set(MSGS_PREFIX + chatId, normalized, MSGS_TTL);



      // Atualiza lastMsg e lastPatientTs no chat
      const lastPatient = [...normalized].reverse().find(m => m.from === "patient");
      const lastAny = normalized[normalized.length - 1];
      setChats(prev => {
        const updated = prev.map(c => c.id === chatId ? {
          ...c,
          lastMsg: lastAny?.text || c.lastMsg,
          lastTime: lastAny?.time || c.lastTime,
          lastPatientTs: lastPatient?.ts || c.lastPatientTs,
        } : c);
        cache.set(CHATS_KEY, updated, CHATS_TTL);
        return updated;
      });
    } catch (e) {
      console.error("loadMessages", e);
    }
  }, []);

  // Adiciona após o loadMessages existente:
  const loadMoreMessages = useCallback(async (chatId, beforeDate) => {
    try {
      const ikey = import.meta.env.VITE_INTERNAL_API_KEY || "";
      const qs = new URLSearchParams({ action: "messages", chatId, limit: "100",
        ...(beforeDate ? { before: beforeDate } : {}) }).toString();
      const r = await fetch(`/api/db?${qs}`, {
        headers: { "X-Internal-Key": ikey },
      });
      if (!r.ok) return { messages: [], hasMore: false };
      const { messages, oldest, hasMore } = await r.json();

      // Normaliza formato (MongoDB salva diferente do WAHA)
      const normalized = messages.map(m => ({
        id:       m.id || m.ts || String(Math.random()),
        from:     m.role === "user" ? "patient" : "operator",
        text:     m.content || m.text || "",
        time:     m.ts ? new Date(m.ts).toLocaleTimeString("pt-BR",
                    { hour:"2-digit", minute:"2-digit" }) : "",
        ts:       m.ts,
        type:     "text",
        operator: m.role !== "user" ? (m.author || "Operador") : null,
      }));

      // Prepend no início do array atual
      setMessages(prev => {
        const current = prev[chatId] || [];
        const ids = new Set(current.map(m => m.id));
        const novos = normalized.filter(m => !ids.has(m.id));
        return { ...prev, [chatId]: [...novos, ...current] };
      });

      return { hasMore, oldest };
    } catch (e) {
      console.error("loadMoreMessages", e);
      return { messages: [], hasMore: false };
    }
  }, []);



  // ── 5. Envia mensagem ────────────────────────────────────────
  const send = useCallback(async (chatId, text, operatorName) => {
    const formatted = `${operatorName}: ${text}`;
    const tmpMsg = {
      id:       `tmp-${Date.now()}`,
      from:     "operator",
      text:     formatted,
      time:     new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      type:     "text",
      operator: operatorName,
    };

    setMessages(prev => {
      const updated = [...(prev[chatId] || []), tmpMsg];
      cache.set(MSGS_PREFIX + chatId, updated, MSGS_TTL);
      return { ...prev, [chatId]: updated };
    });

    if (USE_MOCK) return;

    try {
      await sendText(chatId, formatted);
    } catch (e) {
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).filter(m => m.id !== tmpMsg.id),
      }));
      throw e;
    }
  }, []);

  const ikey = import.meta.env.VITE_INTERNAL_API_KEY || "";

  function persistChat(chatId, fields) {
    fetch(`/api/db?action=chat`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Internal-Key": ikey },
      body: JSON.stringify({ chatId, ...fields }),
    }).catch(e => console.warn("[db] persist failed:", e.message));
  }

  // ── 6. Ações persistidas no MongoDB ──────────────────────────
  const forwardChat = useCallback((chatId, toRole) => {
    setChats(prev => {
      const updated = prev.map(c =>
        c.id === chatId ? { ...c, assignedTo: toRole, status: "open" } : c
      );
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });
    persistChat(chatId, { assignedTo: toRole, status: "open" });
  }, []);

  const resolveChat = useCallback((chatId) => {
    setChats(prev => {
      const updated = prev.map(c =>
        c.id === chatId ? { ...c, status: "resolved", unread: 0 } : c
      );
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });
    persistChat(chatId, { status: "resolved" });
  }, []);

  const addTag = useCallback((chatId, tag) => {
    setChats(prev => {
      const updated = prev.map(c => {
        if (c.id !== chatId || c.tags.includes(tag)) return c;
        const tags = [...c.tags, tag];
        persistChat(chatId, { tags });
        return { ...c, tags };
      });
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });
  }, []);

  return {
    chats, setChats,
    messages, loadMessages,
    send,
    forwardChat, resolveChat, addTag,
    loading, error, wsStatus, sessionOk,
  };
}
