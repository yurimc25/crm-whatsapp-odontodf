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
const CHATS_TTL   = 30 * 24 * 60 * 60 * 1000; // 30 dias
const MSGS_TTL    = 30 * 24 * 60 * 60 * 1000; // 30 dias

export function useWAHA(operator) {
  const [chats, setChats]         = useState(() => cache.get(CHATS_KEY) || []);
  const [messages, setMessages]   = useState({});
  const [loading, setLoading]     = useState(!cache.get(CHATS_KEY));
  const [wsStatus, setWsStatus]   = useState("disconnected");
  const [sessionOk, setSessionOk] = useState(null);
  const [error, setError]         = useState(null);

  const activeChatRef = useRef(null);
  const socketRef     = useRef(null);

  // ── 1. Status da sessão ────────────────────────────────────────
  useEffect(() => {
    if (USE_MOCK) { setSessionOk(true); setLoading(false); return; }
    getSessionStatus()
      .then(s => {
        const ok = s.status === "WORKING";
        setSessionOk(ok);
        if (!ok) setError(`Sessão WAHA: ${s.status}`);
      })
      .catch(e => { setSessionOk(false); setError(e.message); });
  }, []);

  // ── 2. Carrega chats ───────────────────────────────────────────
  useEffect(() => {
    if (!sessionOk) return;
    async function load() {
      if (!cache.get(CHATS_KEY)) setLoading(true);
      try {
        const raw = await getChats();
        const normalized = raw
          .filter(c => !c.id.endsWith("@g.us"))
          .map(normalizeChat);

        // Preserva campos locais do cache (unread, lastPatientTs, status, etc.)
        const prev = cache.get(CHATS_KEY) || [];
        const merged = normalized.map(c => {
          const old = prev.find(p => p.id === c.id);
          return old ? {
            ...c,
            status:        old.status        || c.status,
            assignedTo:    old.assignedTo    || c.assignedTo,
            tags:          old.tags          || c.tags,
            unread:        old.unread        ?? c.unread,
            lastPatientTs: old.lastPatientTs || c.lastPatientTs,
            lastMsg:       old.lastMsg       || c.lastMsg,
            lastTime:      old.lastTime      || c.lastTime,
          } : c;
        });

        // Metadata do MongoDB
        try {
          const ikey = import.meta.env.VITE_INTERNAL_API_KEY || "";
          const dbRes = await fetch(`/api/db?action=chats`, {
            headers: { "X-Internal-Key": ikey },
          });
          if (dbRes.ok) {
            const { chats: dbMeta } = await dbRes.json();
            const withMeta = merged.map(c => {
              const meta = dbMeta?.[c.id];
              return meta ? { ...c, ...meta,
                // Não sobrescreve campos locais com dados velhos do DB
                unread:        c.unread        ?? meta.unread,
                lastPatientTs: c.lastPatientTs || meta.lastPatientTs,
              } : c;
            });
            setChats(withMeta);
            cache.set(CHATS_KEY, withMeta, CHATS_TTL);

            // Carga de última mensagem em background
            bgLoadLastMessages(withMeta);
            return;
          }
        } catch {}

        setChats(merged);
        cache.set(CHATS_KEY, merged, CHATS_TTL);
        bgLoadLastMessages(merged);
      } catch (e) {
        setError(`Erro ao carregar chats: ${e.message}`);
      } finally {
        setLoading(false);
      }
    }
    load();
    const iv = setInterval(load, 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [sessionOk]);

  // Carrega últimas mensagens em background para chats sem lastMsg
  async function bgLoadLastMessages(chatList) {
    const semMsg = chatList.filter(c => !c.lastMsg).slice(0, 20);
    for (const c of semMsg) {
      try {
        const cachedMsgs = cache.get(MSGS_PREFIX + c.id);
        let normalized = cachedMsgs;
        if (!normalized) {
          const raw = await getMessages(c.id, 5);
          if (!raw?.length) continue;
          normalized = raw.map(normalizeMessage).reverse();
          cache.set(MSGS_PREFIX + c.id, normalized, MSGS_TTL);
        }
        const lastAny     = normalized[normalized.length - 1];
        const lastPatient = [...normalized].reverse().find(m => m.from === "patient");

        setChats(prev => {
          const updated = prev.map(x => x.id !== c.id ? x : {
            ...x,
            lastMsg:       lastAny?.text        || x.lastMsg,
            lastTime:      lastAny?.time        || x.lastTime,
            lastPatientTs: lastPatient?.ts      || x.lastPatientTs,
          });
          cache.set(CHATS_KEY, updated, CHATS_TTL);
          return updated;
        });
      } catch {}
    }
  }

  // ── 3. WebSocket ───────────────────────────────────────────────
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    socketRef.current = createWAHASocket({
      onMessage: (msg) => {
        const msgChatId = msg.chatId;
        if (!msgChatId) return;

        // Atualiza mensagens só do chat correto
        setMessages(prev => {
          const existing = prev[msgChatId] || [];
          if (existing.find(m => m.id === msg.id)) return prev;
          const updated = [...existing, msg];
          cache.set(MSGS_PREFIX + msgChatId, updated, MSGS_TTL);
          return { ...prev, [msgChatId]: updated };
        });

        // Atualiza APENAS o chat que recebeu a mensagem
        setChats(prev => {
          const updated = prev.map(c => {
            if (c.id !== msgChatId) return c; // ← FIX: só atualiza o chat certo
            const isPatient = msg.from === "patient";
            const isActive  = msgChatId === activeChatRef.current;
            return {
              ...c,
              lastMsg:       msg.text,
              lastTime:      msg.time,
              lastPatientTs: isPatient ? msg.ts : c.lastPatientTs,
              unread:        isPatient && !isActive ? (c.unread || 0) + 1 : c.unread,
            };
          });
          cache.set(CHATS_KEY, updated, CHATS_TTL);
          return updated;
        });
      },
      onStatus: setWsStatus,
      onError:  (e) => console.warn("[WS]", e),
    });
    return () => socketRef.current?.close();
  }, [sessionOk]);

  // ── 4. Carrega mensagens ────────────────────────────────────────
  const loadMessages = useCallback(async (chatId) => {
    activeChatRef.current = chatId;

    // Zera unread e persiste no cache
    setChats(prev => {
      const updated = prev.map(c => c.id === chatId ? { ...c, unread: 0 } : c);
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });

    const cached = cache.get(MSGS_PREFIX + chatId);
    if (cached) setMessages(prev => ({ ...prev, [chatId]: cached }));

    if (USE_MOCK) {
      setMessages(prev => ({ ...prev, [chatId]: MOCK_MESSAGES[chatId] || [] }));
      return;
    }

    try {
      const raw = await getMessages(chatId, 20);
      const normalized = raw.map(normalizeMessage).reverse();
      setMessages(prev => ({ ...prev, [chatId]: normalized }));
      cache.set(MSGS_PREFIX + chatId, normalized, MSGS_TTL);

      const lastAny     = normalized[normalized.length - 1];
      const lastPatient = [...normalized].reverse().find(m => m.from === "patient");

      setChats(prev => {
        const updated = prev.map(c => c.id !== chatId ? c : {
          ...c,
          lastMsg:       lastAny?.text   || c.lastMsg,
          lastTime:      lastAny?.time   || c.lastTime,
          lastPatientTs: lastPatient?.ts || c.lastPatientTs,
        });
        cache.set(CHATS_KEY, updated, CHATS_TTL);
        return updated;
      });
    } catch (e) { console.error("loadMessages", e); }
  }, []);

  // ── 5. loadMoreMessages (scroll infinito) ──────────────────────
  const loadMoreMessages = useCallback(async (chatId, beforeDate) => {
    try {
      const ikey = import.meta.env.VITE_INTERNAL_API_KEY || "";
      const qs = new URLSearchParams({
        action: "messages", chatId, limit: "100",
        ...(beforeDate ? { before: beforeDate } : {}),
      }).toString();
      const r = await fetch(`/api/db?${qs}`, { headers: { "X-Internal-Key": ikey } });
      if (!r.ok) return { hasMore: false };
      const { messages: msgs, oldest, hasMore } = await r.json();
      const normalized = (msgs || []).map(m => ({
        id:       m.id || m.ts || String(Math.random()),
        from:     m.role === "user" ? "patient" : "operator",
        text:     m.content || m.text || "",
        time:     m.ts ? new Date(m.ts).toLocaleTimeString("pt-BR",
                    { hour:"2-digit", minute:"2-digit" }) : "",
        ts:       m.ts,
        type:     "text",
        operator: m.role !== "user" ? (m.author || "Operador") : null,
      }));
      setMessages(prev => {
        const current = prev[chatId] || [];
        const ids = new Set(current.map(m => m.id));
        const novos = normalized.filter(m => !ids.has(m.id));
        return { ...prev, [chatId]: [...novos, ...current] };
      });
      return { hasMore, oldest };
    } catch (e) { return { hasMore: false }; }
  }, []);

  // ── 6. Envia mensagem ──────────────────────────────────────────
  const send = useCallback(async (chatId, text, operatorName) => {
    const now = new Date();
    const formatted = `${operatorName}: ${text}`;
    const tmpMsg = {
      id:       `tmp-${Date.now()}`,
      from:     "operator",
      text:     formatted,
      time:     now.toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" }),
      ts:       now.toISOString(),
      type:     "text",
      operator: operatorName,
    };
    setMessages(prev => {
      const updated = [...(prev[chatId] || []), tmpMsg];
      cache.set(MSGS_PREFIX + chatId, updated, MSGS_TTL);
      return { ...prev, [chatId]: updated };
    });
    // Atualiza lastMsg mas NÃO atualiza lastPatientTs (foi o operador que enviou)
    setChats(prev => {
      const updated = prev.map(c => c.id !== chatId ? c : {
        ...c, lastMsg: formatted, lastTime: tmpMsg.time,
        // lastPatientTs fica como está — operador enviou, não paciente
      });
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });
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

  const ikey = import.meta.env.VITE_INTERNAL_API_KEY || "";
  function persistChat(chatId, fields) {
    fetch(`/api/db?action=chat`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Internal-Key": ikey },
      body: JSON.stringify({ chatId, ...fields }),
    }).catch(() => {});
  }

  // ── 7. Ações ───────────────────────────────────────────────────
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
      const updated = prev.map(c => c.id !== chatId ? c : {
        ...c,
        status:        "resolved",
        unread:        0,
        lastPatientTs: null, // zera contagem de espera
      });
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });
    persistChat(chatId, { status: "resolved" });
  }, []);

  const addTag = useCallback((chatId, tag) => {
    setChats(prev => {
      const updated = prev.map(c => {
        if (c.id !== chatId || c.tags?.includes(tag)) return c;
        const tags = [...(c.tags || []), tag];
        persistChat(chatId, { tags });
        return { ...c, tags };
      });
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });
  }, []);

  return {
    chats, setChats,
    messages, loadMessages, loadMoreMessages,
    send,
    forwardChat, resolveChat, addTag,
    loading, error, wsStatus, sessionOk,
  };
}