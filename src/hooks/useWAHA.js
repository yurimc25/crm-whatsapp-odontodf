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
const CHATS_TTL   = 30 * 24 * 60 * 60 * 1000;
const MSGS_TTL    = 30 * 24 * 60 * 60 * 1000;

export function useWAHA(operator) {
  const [chats, setChats]         = useState(() => cache.get(CHATS_KEY) || []);
  const [messages, setMessages]   = useState({});
  const [loading, setLoading]     = useState(!cache.get(CHATS_KEY));
  const [wsStatus, setWsStatus]   = useState("disconnected");
  const [sessionOk, setSessionOk] = useState(null);
  const [error, setError]         = useState(null);

  const activeChatRef = useRef(null);
  const socketRef     = useRef(null);
  const bgScanRef     = useRef(false); // evita varredura dupla

  // ── 1. Status da sessão ─────────────────────────────────────────
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

  // ── 2. Carrega chats ────────────────────────────────────────────
  useEffect(() => {
    if (!sessionOk) return;
    async function load() {
      if (!cache.get(CHATS_KEY)) setLoading(true);
      try {
        const raw = await getChats();
        const normalized = raw
          .filter(c => !c.id.endsWith("@g.us"))
          .map(normalizeChat);

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

        let finalList = merged;
        try {
          const ikey = import.meta.env.VITE_INTERNAL_API_KEY || "";
          const dbRes = await fetch(`/api/db?action=chats`, {
            headers: { "X-Internal-Key": ikey },
          });
          if (dbRes.ok) {
            const { chats: dbMeta } = await dbRes.json();
            finalList = merged.map(c => {
              const meta = dbMeta?.[c.id];
              return meta ? { ...c, ...meta,
                unread:        c.unread        ?? meta.unread,
                lastPatientTs: c.lastPatientTs || meta.lastPatientTs,
              } : c;
            });
          }
        } catch {}

        setChats(finalList);
        cache.set(CHATS_KEY, finalList, CHATS_TTL);

        // Inicia varredura em background (1 vez por sessão)
        if (!bgScanRef.current) {
          bgScanRef.current = true;
          bgScan(finalList);
        }
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

  // ── Varredura sequencial de todos os chats ──────────────────────
  // Percorre a lista do primeiro ao último, buscando 5 mensagens por chat
  // para calcular lastMsg e lastPatientTs corretamente
  async function bgScan(chatList) {
    for (const c of chatList) {
      try {
        // Usa cache se já tiver mensagens
        const cached = cache.get(MSGS_PREFIX + c.id);
        let msgs = cached;

        if (!msgs || msgs.length === 0) {
          const raw = await getMessages(c.id, 5);
          if (!raw?.length) continue;
          msgs = raw.map(normalizeMessage).reverse();
          cache.set(MSGS_PREFIX + c.id, msgs, MSGS_TTL);
          setMessages(prev => ({ ...prev, [c.id]: msgs }));
        }

        const lastAny     = msgs[msgs.length - 1];
        const lastPatient = [...msgs].reverse().find(m => m.from === "patient");

        // Calcula unread real: mensagens do paciente depois da última do operador
        const lastOpIdx = msgs.map(m => m.from).lastIndexOf("operator");
        const unreadCount = lastOpIdx === -1
          ? msgs.filter(m => m.from === "patient").length
          : msgs.slice(lastOpIdx + 1).filter(m => m.from === "patient").length;

        setChats(prev => {
          const updated = prev.map(x => x.id !== c.id ? x : {
            ...x,
            lastMsg:       lastAny?.text        || x.lastMsg,
            lastTime:      lastAny?.time        || x.lastTime,
            // lastPatientTs só seta se o PACIENTE foi o último a falar
            lastPatientTs: lastPatient && lastAny?.from === "patient"
              ? lastPatient.ts : null,
            // unread: mantém o do cache se o chat está ativo
            unread: c.id === activeChatRef.current ? 0 : (x.unread || unreadCount),
          });
          cache.set(CHATS_KEY, updated, CHATS_TTL);
          return updated;
        });

        // Pequeno delay para não sobrecarregar o WAHA
        await new Promise(r => setTimeout(r, 150));
      } catch {}
    }
  }

  // ── 3. WebSocket — atualiza só o chat correto ──────────────────
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    socketRef.current = createWAHASocket({
      onMessage: (msg) => {
        const msgChatId = msg.chatId;
        if (!msgChatId) return;

        // Adiciona mensagem só no chat correto
        setMessages(prev => {
          const existing = prev[msgChatId] || [];
          if (existing.find(m => m.id === msg.id)) return prev;
          const updated = [...existing, msg];
          cache.set(MSGS_PREFIX + msgChatId, updated, MSGS_TTL);
          return { ...prev, [msgChatId]: updated };
        });

        // Atualiza SOMENTE o chat que recebeu a mensagem
        setChats(prev => {
          const updated = prev.map(c => {
            if (c.id !== msgChatId) return c;
            const isPatient = msg.from === "patient";
            const isActive  = msgChatId === activeChatRef.current;
            return {
              ...c,
              lastMsg:       msg.text,
              lastTime:      msg.time,
              // Só atualiza lastPatientTs se foi o paciente
              lastPatientTs: isPatient ? msg.ts : c.lastPatientTs,
              // Badge: incrementa só se não está ativo e é do paciente
              unread: isPatient && !isActive ? (c.unread || 0) + 1 : c.unread,
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

  // ── 4. Carrega mensagens de um chat ─────────────────────────────
  const loadMessages = useCallback(async (chatId) => {
    activeChatRef.current = chatId;

    // Zera unread ao abrir
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
          lastMsg:       lastAny?.text || c.lastMsg,
          lastTime:      lastAny?.time || c.lastTime,
          // Só conta tempo se paciente foi o último
          lastPatientTs: lastAny?.from === "patient" ? lastPatient?.ts : null,
          unread:        0,
        });
        cache.set(CHATS_KEY, updated, CHATS_TTL);
        return updated;
      });
    } catch (e) { console.error("loadMessages", e); }
  }, []);

  // ── 5. loadMoreMessages ─────────────────────────────────────────
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
    } catch { return { hasMore: false }; }
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
      chatId,
      type:     "text",
      operator: operatorName,
    };
    setMessages(prev => {
      const updated = [...(prev[chatId] || []), tmpMsg];
      cache.set(MSGS_PREFIX + chatId, updated, MSGS_TTL);
      return { ...prev, [chatId]: updated };
    });
    // Operador enviou: zera lastPatientTs (não precisa mais de resposta)
    setChats(prev => {
      const updated = prev.map(c => c.id !== chatId ? c : {
        ...c,
        lastMsg:       formatted,
        lastTime:      tmpMsg.time,
        lastPatientTs: null, // operador respondeu, zera contagem
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
        lastPatientTs: null, // zera contagem ao resolver
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