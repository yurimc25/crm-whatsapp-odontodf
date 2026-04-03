// src/hooks/useWAHA.js
// Hook central que gerencia toda a comunicação com o WAHA.
// Usado pelo CRMLayout — passa dados já normalizados para os componentes.

import { useState, useEffect, useCallback, useRef } from "react";
import {
  getChats, getMessages, sendText,
  getSessionStatus, normalizeChat, normalizeMessage,
  createWAHASocket,
} from "../services/waha";
import { MOCK_CHATS, MOCK_MESSAGES } from "../data/mock";

const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";

export function useWAHA(operator) {
  const [chats, setChats]           = useState([]);
  const [messages, setMessages]     = useState({});   // { chatId: [...] }
  const [loading, setLoading]       = useState(true);
  const [wsStatus, setWsStatus]     = useState("disconnected"); // connected | reconnecting | disconnected
  const [sessionOk, setSessionOk]   = useState(null); // true | false | null (checking)
  const [error, setError]           = useState(null);

  const activeChatRef = useRef(null);
  const socketRef     = useRef(null);

  // ── 1. Checa status da sessão ──────────────────────────────
  useEffect(() => {
    if (USE_MOCK) {
      setSessionOk(true);
      setChats(MOCK_CHATS);
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

  // ── 2. Carrega lista de chats ──────────────────────────────
  useEffect(() => {
    if (!sessionOk) return;

    async function load() {
      setLoading(true);
      try {
        const raw = await getChats();
        // Filtra grupos (termina em @g.us)
        const normalized = raw
          .filter(c => !c.id.endsWith("@g.us"))
          .map(normalizeChat);
        setChats(normalized);
      } catch (e) {
        setError(`Erro ao carregar chats: ${e.message}`);
      } finally {
        setLoading(false);
      }
    }

    load();
    // Polling a cada 30s para novos chats
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [sessionOk]);

  // ── 3. WebSocket para mensagens em tempo real ──────────────
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;

    socketRef.current = createWAHASocket({
      onMessage: (msg) => {
        // Adiciona mensagem ao chat correspondente
        setMessages(prev => {
          const chatId = msg.from === "patient"
            ? (msg.chatId || activeChatRef.current)
            : activeChatRef.current;
          if (!chatId) return prev;
          const existing = prev[chatId] || [];
          // Evita duplicata
          if (existing.find(m => m.id === msg.id)) return prev;
          return { ...prev, [chatId]: [...existing, msg] };
        });

        // Incrementa badge de não lido se não for o chat ativo
        setChats(prev => prev.map(c => {
          if (c.id !== activeChatRef.current && msg.from === "patient") {
            return { ...c, unread: (c.unread || 0) + 1, lastMsg: msg.text, lastTime: msg.time };
          }
          return c;
        }));
      },
      onStatus: setWsStatus,
      onError:  (e) => console.warn("[WS]", e),
    });

    return () => socketRef.current?.close();
  }, [sessionOk]);

  // ── 4. Carrega mensagens de um chat ───────────────────────
  const loadMessages = useCallback(async (chatId) => {
    activeChatRef.current = chatId;

    // Zera badge de não lido
    setChats(prev => prev.map(c => c.id === chatId ? { ...c, unread: 0 } : c));

    if (USE_MOCK) {
      setMessages(prev => ({ ...prev, [chatId]: MOCK_MESSAGES[chatId] || [] }));
      return;
    }

    // Já tem mensagens carregadas? Usa o cache e atualiza em background
    if (!messages[chatId]) {
      try {
        const raw = await getMessages(chatId);
        const normalized = raw.map(normalizeMessage).reverse(); // WAHA retorna do mais novo
        setMessages(prev => ({ ...prev, [chatId]: normalized }));
      } catch (e) {
        console.error("loadMessages", e);
      }
    }
  }, [messages]);

  // ── 5. Envia mensagem ──────────────────────────────────────
  const send = useCallback(async (chatId, text, operatorName) => {
    const formatted = `${operatorName}: ${text}`;

    // Otimistic update
    const tmpMsg = {
      id:       `tmp-${Date.now()}`,
      from:     "operator",
      text:     formatted,
      time:     new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
      type:     "text",
      operator: operatorName,
    };
    setMessages(prev => ({ ...prev, [chatId]: [...(prev[chatId] || []), tmpMsg] }));

    if (USE_MOCK) return;

    try {
      await sendText(chatId, formatted);
    } catch (e) {
      console.error("send", e);
      // Remove a mensagem otimista em caso de erro
      setMessages(prev => ({
        ...prev,
        [chatId]: (prev[chatId] || []).filter(m => m.id !== tmpMsg.id),
      }));
      throw e;
    }
  }, []);

  // ── 6. Ações locais (encaminhar, resolver) ─────────────────
  // Essas ações são locais por enquanto — em produção salvariam no MongoDB
  const forwardChat = useCallback((chatId, toRole) => {
    setChats(prev => prev.map(c =>
      c.id === chatId ? { ...c, assignedTo: toRole, status: "open" } : c
    ));
    // MODULE: MongoDB → db.chats.updateOne({ id: chatId }, { assignedTo, status })
  }, []);

  const resolveChat = useCallback((chatId) => {
    setChats(prev => prev.map(c =>
      c.id === chatId ? { ...c, status: "resolved", unread: 0 } : c
    ));
    // MODULE: MongoDB → db.chats.updateOne({ id: chatId }, { status: "resolved" })
  }, []);

  const addTag = useCallback((chatId, tag) => {
    setChats(prev => prev.map(c =>
      c.id === chatId && !c.tags.includes(tag)
        ? { ...c, tags: [...c.tags, tag] }
        : c
    ));
  }, []);

  return {
    chats, setChats,
    messages, loadMessages,
    send,
    forwardChat, resolveChat, addTag,
    loading, error, wsStatus, sessionOk,
  };
}
