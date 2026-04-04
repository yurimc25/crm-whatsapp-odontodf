import { useState, useEffect, useCallback, useRef } from "react";
import {
  getChats, getMessages, sendText, getSessionStatus,
  normalizeChat, normalizeMessage, createWAHASocket, getProfilePicture,
} from "../services/waha";
import { MOCK_CHATS, MOCK_MESSAGES } from "../data/mock";
import { cache } from "../utils/cache";

const USE_MOCK    = import.meta.env.VITE_USE_MOCK === "true";
const CHATS_KEY   = "waha_chats";
const MSGS_PREFIX = "waha_msgs_";
const CHATS_TTL   = 30 * 24 * 60 * 60 * 1000;
const MSGS_TTL    = 30 * 24 * 60 * 60 * 1000;
const ikey        = () => import.meta.env.VITE_INTERNAL_API_KEY || "";

// ── Palavras/frases de despedida ─────────────────────────────────
const FAREWELL_PATTERNS = [
  /^(ok|okay|oks|okey)[\s!.]*$/i,
  /obrigad/i, /agradeç/i, /igualmente/i,
  /disponha/i, /excelente dia/i, /boa noite/i, /boa tarde/i, /bom dia/i,
  /até mais/i, /até logo/i, /tchau/i, /flw/i, /abraço/i,
  /por nada/i,            // adicionado
  /fenelon informa/i,     // adicionado
  /👍/, /🤗/, /😊/, /🆗/, /✅/, /🙏/,
];

function isFarewell(text) {
  if (!text) return true; // mensagem vazia = despedida
  const t = text.trim();
  if (t.length === 0) return true;
  // Mensagem curta (≤30 chars) que bate com padrão
  if (t.length <= 60 && FAREWELL_PATTERNS.some(p => p.test(t))) return true;
  return false;
}

function detectAutoResolve(msgs) {
  if (!msgs?.length) return false;
  const last3 = msgs.slice(-3);
  // Se a última mensagem for despedida
  if (isFarewell(last3[last3.length - 1]?.text)) return true;
  // Se "Disponha, tenha um excelente dia!" estiver nas últimas 3
  if (last3.some(m => m.text?.includes("Disponha") && m.text?.includes("excelente"))) return true;
  return false;
}

// ── Persistência no MongoDB ──────────────────────────────────────
function persistChat(chatId, fields) {
  fetch(`/api/db?action=chat`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Internal-Key": ikey() },
    body: JSON.stringify({ chatId, ...fields }),
  }).catch(() => {});
}

export function useWAHA(operator) {
  const [chats, setChats]         = useState(() => cache.get(CHATS_KEY) || []);
  const [messages, setMessages]   = useState({});
  const [loading, setLoading]     = useState(!cache.get(CHATS_KEY));
  const [wsStatus, setWsStatus]   = useState("disconnected");
  const [sessionOk, setSessionOk] = useState(null);
  const [error, setError]         = useState(null);

  const activeChatRef = useRef(null);
  const socketRef     = useRef(null);
  const bgScanDone    = useRef(false);

  // ── 1. Status da sessão ─────────────────────────────────────────
  useEffect(() => {
    if (USE_MOCK) { setSessionOk(true); setLoading(false); return; }
    getSessionStatus()
      .then(s => { const ok = s.status === "WORKING"; setSessionOk(ok); if (!ok) setError(`Sessão WAHA: ${s.status}`); })
      .catch(e => { setSessionOk(false); setError(e.message); });
  }, []);

  // ── 2. Carrega todos os chats ───────────────────────────────────
  useEffect(() => {
    if (!sessionOk) return;
    async function load() {
      if (!cache.get(CHATS_KEY)) setLoading(true);
      try {
        const raw = await getChats();
        const normalized = raw
          .filter(c => !c.id.endsWith("@g.us")) // sem grupos
          .filter(c => {                          // sem IDs malformados (>15 dígitos)
            const digits = c.id.replace(/@.*$/, "").replace(/\D/g, "");
            return digits.length >= 7 && digits.length <= 15;
          })
          .map(normalizeChat);

        // Cache local vence tudo — preserva estados manuais (lido, lastPatientTs)
        const prev = cache.get(CHATS_KEY) || [];
        const merged = normalized.map(c => {
          const old = prev.find(p => p.id === c.id);
          if (!old) return c;
          return {
            ...c,
            status:        old.status     || c.status,
            assignedTo:    old.assignedTo || c.assignedTo,
            tags:          old.tags       || c.tags,
            unread:        old.unread     ?? c.unread,
            // "in" preserva null intencional (marcado como respondido)
            lastPatientTs: "lastPatientTs" in old ? old.lastPatientTs : c.lastPatientTs,
            lastMsg:       old.lastMsg    || c.lastMsg,
            lastTime:      old.lastTime   || c.lastTime,
            photoUrl:      old.photoUrl   || c.photoUrl,
          };
        });

        // MongoDB só fornece assignedTo/tags — NÃO sobrescreve unread/lastPatientTs
        let finalList = merged;
        try {
          const dbRes = await fetch(`/api/db?action=chats`, {
            headers: { "X-Internal-Key": ikey() },
          });
          if (dbRes.ok) {
            const { chats: dbMeta } = await dbRes.json();
            finalList = merged.map(c => {
              const meta = dbMeta?.[c.id];
              if (!meta) return c;
              return {
                ...c,
                // DB fornece status e encaminhamento
                status:     c.status     || meta.status,
                assignedTo: c.assignedTo || meta.assignedTo,
                tags:       c.tags?.length ? c.tags : (meta.tags || []),
                photoUrl:   c.photoUrl   || meta.photoUrl,
                // unread e lastPatientTs: SEMPRE do cache local (usuário pode ter zerado)
                unread:        c.unread,
                lastPatientTs: "lastPatientTs" in c ? c.lastPatientTs : meta.lastPatientTs,
              };
            });
          }
        } catch {}

        setChats(finalList);
        cache.set(CHATS_KEY, finalList, CHATS_TTL);

        if (!bgScanDone.current) {
          bgScanDone.current = true;
          bgScan(finalList);
        }
      } catch (e) { setError(`Erro ao carregar chats: ${e.message}`); }
      finally { setLoading(false); }
    }
    load();
    const iv = setInterval(load, 5 * 60 * 1000); // recarga completa a cada 5min
    return () => clearInterval(iv);
  }, [sessionOk]);

  // ── Timer 1: ChatList — top 10 chats a cada 5s ─────────────────
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const WAHA_URL = import.meta.env.VITE_WAHA_URL || "";
    const WAHA_KEY = import.meta.env.VITE_WAHA_API_KEY || "";
    const SESSION  = import.meta.env.VITE_WAHA_SESSION || "default";

    const iv = setInterval(async () => {
      try {
        const r = await fetch(
          `${WAHA_URL}/api/${SESSION}/chats?limit=10&offset=0`,
          { headers: { "Content-Type":"application/json", "X-Api-Key": WAHA_KEY } }
        );
        if (!r.ok) return;
        const raw = await r.json();

        const freshChats = (Array.isArray(raw) ? raw : [])
          .filter(c => !c.id.endsWith("@g.us"))
          .filter(c => {
            const d = c.id.replace(/@.*$/, "").replace(/\D/g, "");
            return d.length >= 7 && d.length <= 15;
          })
          .map(normalizeChat);

        if (!freshChats.length) return;

        setChats(prev => {
          let changed = false;
          const prevIds = new Set(prev.map(c => c.id));

          // Atualiza chats existentes
          const updated = prev.map(c => {
            const fresh = freshChats.find(f => f.id === c.id);
            if (!fresh) return c;

            // Só atualiza lastMsg se o fresh tem conteúdo real
            // (evita sobrescrever com vazio quando WAHA não embute lastMessage)
            const freshMsg   = fresh.lastMsg || ""; // garante string
            const msgNova    = freshMsg !== "" && freshMsg !== c.lastMsg;
            const unreadNovo = (fresh.unread ?? 0) > (c.unread || 0);
            const temLastTs  = fresh.lastTs && fresh.lastTs !== c.lastTs;
            if (!msgNova && !unreadNovo && !temLastTs) return c;

            changed = true;
            const jaRespondido = "lastPatientTs" in c && c.lastPatientTs === null && c.unread === 0;
            const wahaUnread   = fresh.unread ?? 0;
            const isPatient    = wahaUnread > (c.unread || 0) || wahaUnread > 0;
            const autoRes      = isFarewell(freshMsg);
            return {
              ...c,
              // NUNCA substitui por vazio — mantém o valor anterior se fresh está vazio
              lastMsg:       freshMsg || c.lastMsg,
              lastTime:      fresh.lastTime || c.lastTime,
              lastTs:        fresh.lastTs   || c.lastTs,
              lastPatientTs: jaRespondido ? null
                : isPatient && !autoRes ? (fresh.lastTs || c.lastPatientTs)
                : c.lastPatientTs,
              unread: c.id === activeChatRef.current ? 0
                : jaRespondido ? 0
                : Math.max(c.unread || 0, wahaUnread),
            };
          });

          // Adiciona chats novos — mescla com cache do localStorage para não perder lastMsg
          const cachedAll = cache.get(CHATS_KEY) || [];
          const novos = freshChats.filter(f => !prevIds.has(f.id)).map(fresh => {
            const cached = cachedAll.find(c => c.id === fresh.id);
            if (!cached) return fresh;
            // Preserva lastMsg/lastTime do cache se o fresh veio sem lastMessage
            return {
              ...fresh,
              lastMsg:       fresh.lastMsg  || cached.lastMsg  || "",
              lastTime:      fresh.lastTime || cached.lastTime || "",
              lastTs:        fresh.lastTs   || cached.lastTs   || null,
              unread:        cached.unread  ?? fresh.unread,
              lastPatientTs: "lastPatientTs" in cached ? cached.lastPatientTs : fresh.lastPatientTs,
              status:        cached.status  || fresh.status,
              assignedTo:    cached.assignedTo || fresh.assignedTo,
              tags:          cached.tags    || fresh.tags,
              photoUrl:      cached.photoUrl || fresh.photoUrl,
            };
          });
          if (novos.length > 0) {
            changed = true;
            updated.push(...novos);
          }

          if (!changed) return prev;
          cache.set(CHATS_KEY, updated, CHATS_TTL);
          return updated;
        });
      } catch {}
    }, 5000);
    return () => clearInterval(iv);
  }, [sessionOk]);

  // ── Timer 2: ChatWindow — chat ativo a cada 3s ──────────────────
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iv = setInterval(async () => {
      const chatId = activeChatRef.current;
      if (!chatId) return;
      try {
        const raw = await getMessages(chatId, 20);
        const normalized = raw
          .map(normalizeMessage)
          .sort((a,b) => new Date(a.ts)-new Date(b.ts));

        setMessages(prev => {
          const current = prev[chatId] || [];
          const ids = new Set(current.map(m => m.id));
          const novos = normalized.filter(m => !ids.has(m.id));
          if (novos.length === 0) return prev;
          const updated = [...current, ...novos].sort((a,b) => new Date(a.ts)-new Date(b.ts));
          cache.set(MSGS_PREFIX + chatId, updated, MSGS_TTL);
          return { ...prev, [chatId]: updated };
        });
      } catch {}
    }, 3000);
    return () => clearInterval(iv);
  }, [sessionOk]);

  // ── Varredura em background ─────────────────────────────────────
  async function bgScan(chatList) {
    for (const c of chatList) {
      try {
        const cachedMsgs = cache.get(MSGS_PREFIX + c.id);
        let msgs = cachedMsgs;

        if (!msgs || msgs.length === 0) {
          const raw = await getMessages(c.id, 5);
          if (raw?.length) {
            msgs = raw.map(normalizeMessage).sort((a,b) => new Date(a.ts)-new Date(b.ts));
            cache.set(MSGS_PREFIX + c.id, msgs, MSGS_TTL);
            setMessages(prev => ({ ...prev, [c.id]: msgs }));
          }
        }

        if (msgs?.length) {
          const lastAny     = msgs[msgs.length - 1];
          const lastPatient = [...msgs].reverse().find(m => m.from === "patient");
          const lastOpIdx   = msgs.map(m => m.from).lastIndexOf("operator");
          const unreadCount = lastOpIdx === -1
            ? msgs.filter(m => m.from === "patient").length
            : msgs.slice(lastOpIdx + 1).filter(m => m.from === "patient").length;

          // Auto-resolve por despedida
          const autoResolve = detectAutoResolve(msgs);

          setChats(prev => {
            const updated = prev.map(x => {
              if (x.id !== c.id) return x;

              // Se já foi marcado como lido/respondido (lastPatientTs===null ou unread===0),
              // NÃO sobrescreve — respeita a ação do usuário
              const jaRespondido = "lastPatientTs" in x && x.lastPatientTs === null
                && x.unread === 0;
              if (jaRespondido) return { ...x, lastMsg: lastAny?.text || x.lastMsg, lastTime: lastAny?.time || x.lastTime };

              const novoLastPatientTs = (autoResolve || lastAny?.from !== "patient")
                ? null
                : (lastPatient?.ts || null);

              const novoUnread = x.id === activeChatRef.current
                ? 0
                : (autoResolve ? 0 : Math.max(x.unread || 0, unreadCount));

              return {
                ...x,
                lastMsg:       lastAny?.text || x.lastMsg,
                lastTime:      lastAny?.time || x.lastTime,
                lastPatientTs: novoLastPatientTs,
                unread:        novoUnread,
              };
            });
            cache.set(CHATS_KEY, updated, CHATS_TTL);
            return updated;
          });
        }

        // Foto de perfil
        if (!c.photoUrl) {
          const url = await getProfilePicture(c.id);
          if (url) {
            setChats(prev => {
              const updated = prev.map(x => x.id !== c.id ? x : { ...x, photoUrl: url });
              cache.set(CHATS_KEY, updated, CHATS_TTL);
              return updated;
            });
          }
        }

        await new Promise(r => setTimeout(r, 200));
      } catch {}
    }
  }

  // ── 3. WebSocket ────────────────────────────────────────────────
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    socketRef.current = createWAHASocket({
      onMessage: (msg) => {
        const msgChatId = msg.chatId;
        if (!msgChatId) return;
        setMessages(prev => {
          const existing = prev[msgChatId] || [];
          if (existing.find(m => m.id === msg.id)) return prev;
          const updated = [...existing, msg].sort((a,b) => new Date(a.ts)-new Date(b.ts));
          cache.set(MSGS_PREFIX + msgChatId, updated, MSGS_TTL);
          return { ...prev, [msgChatId]: updated };
        });
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
              lastPatientTs: isPatient && !autoRes ? msg.ts : null,
              unread: isPatient && !isActive && !autoRes ? (c.unread || 0) + 1 : c.unread,
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
    setChats(prev => {
      const updated = prev.map(c => c.id === chatId ? { ...c, unread: 0 } : c);
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });
    const cached = cache.get(MSGS_PREFIX + chatId);
    if (cached) setMessages(prev => ({ ...prev, [chatId]: cached }));
    if (USE_MOCK) { setMessages(prev => ({ ...prev, [chatId]: MOCK_MESSAGES[chatId] || [] })); return; }
    try {
      const raw = await getMessages(chatId, 20);
      const normalized = raw.map(normalizeMessage).sort((a,b) => new Date(a.ts)-new Date(b.ts));
      setMessages(prev => ({ ...prev, [chatId]: normalized }));
      cache.set(MSGS_PREFIX + chatId, normalized, MSGS_TTL);

      const lastAny     = normalized[normalized.length - 1];
      const lastPatient = [...normalized].reverse().find(m => m.from === "patient");
      const autoResolve = detectAutoResolve(normalized);

      setChats(prev => {
        const updated = prev.map(c => c.id !== chatId ? c : {
          ...c,
          lastMsg:       lastAny?.text || c.lastMsg,
          lastTime:      lastAny?.time || c.lastTime,
          lastPatientTs: (autoResolve || lastAny?.from !== "patient") ? null : (lastPatient?.ts || null),
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
      const qs = new URLSearchParams({ action:"messages", chatId, limit:"100",
        ...(beforeDate ? { before: beforeDate } : {}) }).toString();
      const r = await fetch(`/api/db?${qs}`, { headers: { "X-Internal-Key": ikey() } });
      if (!r.ok) return { hasMore: false };
      const { messages: msgs, oldest, hasMore } = await r.json();
      const normalized = (msgs || []).map(m => ({
        id:       m.id || m.ts || String(Math.random()),
        from:     m.role === "user" ? "patient" : "operator",
        text:     m.content || m.text || "",
        time:     m.ts ? new Date(m.ts).toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}) : "",
        ts:       m.ts, type:"text",
        operator: m.role !== "user" ? (m.author||"Operador") : null,
      })).sort((a,b) => new Date(a.ts)-new Date(b.ts));
      setMessages(prev => {
        const current = prev[chatId] || [];
        const ids = new Set(current.map(m => m.id));
        const novos = normalized.filter(m => !ids.has(m.id));
        return { ...prev, [chatId]: [...novos, ...current] };
      });
      return { hasMore, oldest };
    } catch { return { hasMore: false }; }
  }, []);

  // ── 6. Envia mensagem ───────────────────────────────────────────
  const send = useCallback(async (chatId, text, operatorName) => {
    const now = new Date();
    const formatted = `${operatorName}: ${text}`;
    const tmpMsg = {
      id:`tmp-${Date.now()}`, from:"operator", text:formatted,
      time:now.toLocaleTimeString("pt-BR",{hour:"2-digit",minute:"2-digit"}),
      ts:now.toISOString(), chatId, type:"text", operator:operatorName,
    };
    setMessages(prev => {
      const updated = [...(prev[chatId]||[]),tmpMsg].sort((a,b)=>new Date(a.ts)-new Date(b.ts));
      cache.set(MSGS_PREFIX+chatId, updated, MSGS_TTL);
      return { ...prev, [chatId]: updated };
    });
    // Operador respondeu → zera contagem e persiste no DB
    setChats(prev => {
      const updated = prev.map(c => c.id!==chatId ? c : {
        ...c, lastMsg:formatted, lastTime:tmpMsg.time, lastPatientTs:null,
      });
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });
    persistChat(chatId, { lastPatientTs: null, unread: 0 });
    if (USE_MOCK) return;
    try { await sendText(chatId, formatted); }
    catch (e) {
      setMessages(prev => ({ ...prev, [chatId]:(prev[chatId]||[]).filter(m=>m.id!==tmpMsg.id) }));
      throw e;
    }
  }, []);

  // ── 7. Ações ────────────────────────────────────────────────────
  const forwardChat = useCallback((chatId, toRole) => {
    setChats(prev => {
      const updated = prev.map(c => c.id===chatId ? {...c,assignedTo:toRole,status:"open"} : c);
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });
    persistChat(chatId, { assignedTo: toRole, status: "open" });
  }, []);

  // Resolver: zera contagem e unread, persiste no MongoDB
  const resolveChat = useCallback((chatId) => {
    setChats(prev => {
      const updated = prev.map(c => c.id!==chatId ? c : {
        ...c, unread:0, lastPatientTs:null,
      });
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });
    // Persiste no MongoDB para sobreviver a recarregamentos
    persistChat(chatId, { lastPatientTs: null, unread: 0 });
  }, []);

  // Marcar como lido — persiste no MongoDB
  const markRead = useCallback((chatId) => {
    setChats(prev => {
      const updated = prev.map(c => c.id!==chatId ? c : { ...c, unread:0, lastPatientTs:null });
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });
    persistChat(chatId, { unread: 0, lastPatientTs: null });
  }, []);

  // Marcar como não lido
  const markUnread = useCallback((chatId) => {
    setChats(prev => {
      const updated = prev.map(c => c.id!==chatId ? c : { ...c, unread:1 });
      cache.set(CHATS_KEY, updated, CHATS_TTL);
      return updated;
    });
    persistChat(chatId, { unread: 1 });
  }, []);

  const addTag = useCallback((chatId, tag) => {
    setChats(prev => {
      const updated = prev.map(c => {
        if (c.id!==chatId || c.tags?.includes(tag)) return c;
        const tags = [...(c.tags||[]),tag];
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
    forwardChat, resolveChat, markRead, markUnread, addTag,
    loading, error, wsStatus, sessionOk,
  };
}