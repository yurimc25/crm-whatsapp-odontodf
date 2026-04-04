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
  // Passo 1: pega os 10 chats mais recentes para ter os IDs
  // Passo 2: para cada chat, busca a última mensagem individualmente
  // Isso garante lastMsg, unread e lastPatientTs sempre atualizados
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iKey    = import.meta.env.VITE_INTERNAL_API_KEY || "";
    const SESSION = import.meta.env.VITE_WAHA_SESSION || "default";

    const iv = setInterval(async () => {
      try {
        // ── Passo 1: lista dos 10 chats mais recentes ──────────────
        const r = await fetch(
          `/api/waha?path=/api/${SESSION}/chats&limit=10&offset=0`,
          { headers: { "X-Internal-Key": iKey } }
        );
        if (!r.ok) return;
        const raw = await r.json();
        if (!raw || !Array.isArray(raw)) return;

        const top10 = raw
          .filter(c => !c.id.endsWith("@g.us"))
          .filter(c => {
            const d = c.id.replace(/@.*$/, "").replace(/\D/g, "");
            return d.length >= 7 && d.length <= 15;
          })
          .slice(0, 10);

        if (!top10.length) return;

        // ── Passo 2: busca mensagens de cada chat individualmente ──
        for (const chat of top10) {
          try {
            const chatId = chat.id;
            const id     = encodeURIComponent(chatId);
            const rm     = await fetch(
              `/api/waha?path=/api/${SESSION}/chats/${id}/messages&limit=20&downloadMedia=false`,
              { headers: { "X-Internal-Key": iKey } }
            );
            if (!rm.ok) continue;
            const msgs = await rm.json();
            if (!msgs || !Array.isArray(msgs) || msgs.length === 0) continue;

            // Ordena por timestamp real do WhatsApp (mais antiga → mais nova)
            const normalized = msgs
              .map(normalizeMessage)
              .sort((a, b) => new Date(a.ts) - new Date(b.ts));

            // Última mensagem (qualquer remetente) — para exibir no ChatList
            const lastAny = normalized[normalized.length - 1];

            // Último operador e último paciente
            const lastOpIdx      = normalized.map(m => m.from).lastIndexOf("operator");
            const lastPatientIdx = normalized.map(m => m.from).lastIndexOf("patient");

            // Mensagens do paciente sem resposta (após o último operador)
            const semResposta = lastOpIdx === -1
              ? normalized.filter(m => m.from === "patient")
              : normalized.slice(lastOpIdx + 1).filter(m => m.from === "patient");

            // unread = quantas msgs do paciente ficaram sem resposta
            const unreadCount = semResposta.length;

            // lastPatientTs = timestamp da PRIMEIRA msg sem resposta (início da espera)
            // Se operador foi o último a falar → null (não tem espera)
            const primeiroSemResposta = semResposta[0] || null;
            const ultimoFoiOperador   = lastOpIdx > lastPatientIdx || lastPatientIdx === -1;

            const autoRes = detectAutoResolve(normalized);

            // novoLastPatientTs: null se operador respondeu, null se despedida,
            // senão = timestamp da primeira mensagem sem resposta
            const novoLastPatientTs = (ultimoFoiOperador || autoRes)
              ? null
              : (primeiroSemResposta?.ts || null);

            setChats(prev => {
              const existing = prev.find(c => c.id === chatId);
              const cachedAll = cache.get(CHATS_KEY) || [];

              let updated;
              if (existing) {
                const jaRespondido = "lastPatientTs" in existing
                  && existing.lastPatientTs === null && existing.unread === 0;

                updated = prev.map(c => {
                  if (c.id !== chatId) return c;
                  return {
                    ...c,
                    // lastMsg sempre a última mensagem, seja do paciente ou operador
                    lastMsg:  lastAny?.text || c.lastMsg,
                    lastTime: lastAny?.time || c.lastTime,
                    lastTs:   lastAny?.ts   || c.lastTs,
                    // lastPatientTs: preserva null se usuário marcou como respondido
                    // e não chegou mensagem nova do paciente depois
                    lastPatientTs: jaRespondido && novoLastPatientTs === null
                      ? null
                      : novoLastPatientTs,
                    // unread: 0 se chat ativo ou operador respondeu
                    // senão usa o maior entre o acumulado e o novo count
                    unread: c.id === activeChatRef.current
                      ? 0
                      : ultimoFoiOperador || autoRes
                        ? 0
                        : Math.max(c.unread || 0, unreadCount),
                  };
                });
              } else {
                const cached   = cachedAll.find(c => c.id === chatId);
                const baseChat = cached || normalizeChat(chat);
                const newChat  = {
                  ...baseChat,
                  lastMsg:       lastAny?.text  || baseChat.lastMsg  || "",
                  lastTime:      lastAny?.time  || baseChat.lastTime || "",
                  lastTs:        lastAny?.ts    || baseChat.lastTs   || null,
                  lastPatientTs: novoLastPatientTs,
                  unread:        unreadCount,
                };
                updated = [...prev, newChat];
              }

              cache.set(CHATS_KEY, updated, CHATS_TTL);
              return updated;
            });

            // Também atualiza cache de mensagens
            setMessages(prev => {
              const current = prev[chatId] || [];
              const ids     = new Set(current.map(m => m.id));
              const novos   = normalized.filter(m => !ids.has(m.id));
              if (novos.length === 0) return prev;
              const updated = [...current, ...novos].sort((a,b) => new Date(a.ts)-new Date(b.ts));
              cache.set(MSGS_PREFIX + chatId, updated, MSGS_TTL);
              return { ...prev, [chatId]: updated };
            });

            // Pequeno delay entre chats para não sobrecarregar
            await new Promise(res => setTimeout(res, 100));
          } catch {}
        }
      } catch {}
    }, 5000);
    return () => clearInterval(iv);
  }, [sessionOk]);

  // ── Timer 2: ChatWindow — chat ativo a cada 3s ──────────────────
  // Usa proxy /api/waha para evitar CORS
  useEffect(() => {
    if (!sessionOk || USE_MOCK) return;
    const iKey    = import.meta.env.VITE_INTERNAL_API_KEY || "";
    const SESSION = import.meta.env.VITE_WAHA_SESSION || "default";

    const iv = setInterval(async () => {
      const chatId = activeChatRef.current;
      if (!chatId) return;
      try {
        const id  = encodeURIComponent(chatId);
        const r   = await fetch(
          `/api/waha?path=/api/${SESSION}/chats/${id}/messages&limit=20&downloadMedia=false`,
          { headers: { "X-Internal-Key": iKey } }
        );
        if (!r.ok) return;
        const raw = await r.json();
        if (!Array.isArray(raw)) return;
        const normalized = raw
          .map(normalizeMessage)
          .sort((a,b) => new Date(a.ts)-new Date(b.ts));

        setMessages(prev => {
          const current = prev[chatId] || [];
          const ids     = new Set(current.filter(m => !m.id.startsWith("tmp-")).map(m => m.id));
          const novos   = normalized.filter(m => !ids.has(m.id));
          if (novos.length === 0) return prev;

          // Remove mensagens tmp que têm o mesmo texto que uma mensagem real que chegou
          const textosDasNovas = new Set(novos.map(m => m.text));
          const semDuplicados  = current.filter(m =>
            !m.id.startsWith("tmp-") || !textosDasNovas.has(m.text)
          );

          const updated = [...semDuplicados, ...novos].sort((a,b) => new Date(a.ts)-new Date(b.ts));
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
        // bgScan sempre busca mensagens frescas do WAHA — não usa cache
        // para garantir que lastMsg e lastPatientTs estejam corretos
        const raw = await getMessages(c.id, 20);
        let msgs = [];
        if (raw?.length) {
          msgs = raw.map(normalizeMessage).sort((a,b) => new Date(a.ts)-new Date(b.ts));
          cache.set(MSGS_PREFIX + c.id, msgs, MSGS_TTL);
          setMessages(prev => ({ ...prev, [c.id]: msgs }));
        } else {
          // Se não veio nada do WAHA, usa o cache como fallback
          const cachedMsgs = cache.get(MSGS_PREFIX + c.id);
          if (cachedMsgs?.length) msgs = cachedMsgs;
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

          // Mesma lógica do Timer 1:
          // lastMsg = última mensagem (qualquer remetente)
          // lastPatientTs = primeira msg sem resposta (ou null se operador respondeu)
          const lastOpIdx2      = msgs.map(m => m.from).lastIndexOf("operator");
          const lastPatientIdx2 = msgs.map(m => m.from).lastIndexOf("patient");
          const semResposta2    = lastOpIdx2 === -1
            ? msgs.filter(m => m.from === "patient")
            : msgs.slice(lastOpIdx2 + 1).filter(m => m.from === "patient");
          const ultimoFoiOp2    = lastOpIdx2 > lastPatientIdx2 || lastPatientIdx2 === -1;
          const novoLPTs2       = (ultimoFoiOp2 || autoResolve) ? null : (semResposta2[0]?.ts || null);
          const novoUnread2     = semResposta2.length;

          setChats(prev => {
            const updated = prev.map(x => {
              if (x.id !== c.id) return x;
              const jaRespondido = "lastPatientTs" in x && x.lastPatientTs === null && x.unread === 0;
              if (jaRespondido) return { ...x, lastMsg: lastAny?.text || x.lastMsg, lastTime: lastAny?.time || x.lastTime };
              return {
                ...x,
                lastMsg:       lastAny?.text || x.lastMsg,
                lastTime:      lastAny?.time || x.lastTime,
                lastPatientTs: novoLPTs2,
                unread: x.id === activeChatRef.current ? 0
                  : (ultimoFoiOp2 || autoResolve) ? 0
                  : Math.max(x.unread || 0, novoUnread2),
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

      const lastAny      = normalized[normalized.length - 1];
      const lastOpIdx    = normalized.map(m => m.from).lastIndexOf("operator");
      const lastPIdx     = normalized.map(m => m.from).lastIndexOf("patient");
      const semResp      = lastOpIdx === -1
        ? normalized.filter(m => m.from === "patient")
        : normalized.slice(lastOpIdx + 1).filter(m => m.from === "patient");
      const ultimoFoiOp  = lastOpIdx > lastPIdx || lastPIdx === -1;
      const autoResolve  = detectAutoResolve(normalized);
      const novoLPTs     = (ultimoFoiOp || autoResolve) ? null : (semResp[0]?.ts || null);

      setChats(prev => {
        const updated = prev.map(c => c.id !== chatId ? c : {
          ...c,
          lastMsg:       lastAny?.text || c.lastMsg,
          lastTime:      lastAny?.time || c.lastTime,
          lastPatientTs: novoLPTs,
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

  // Carrega mensagens mais antigas (scroll infinito) — busca do WAHA via proxy
  const loadOlderMessages = useCallback(async (chatId, currentMsgs) => {
    const iKey    = ikey();
    const SESSION = import.meta.env.VITE_WAHA_SESSION || "default";
    const id      = encodeURIComponent(chatId);

    const oldestMsg = (currentMsgs || [])[0];
    const oldestTs  = oldestMsg?.ts
      ? Math.floor(new Date(oldestMsg.ts).getTime() / 1000)
      : null;

    try {
      // Tenta com fromTimestamp (suportado em alguns engines WAHA)
      const tsParam = oldestTs ? `&fromTimestamp=${oldestTs - 1}` : "";
      const r = await fetch(
        `/api/waha?path=/api/${SESSION}/chats/${id}/messages&limit=30&downloadMedia=false${tsParam}`,
        { headers: { "X-Internal-Key": iKey } }
      );
      if (!r.ok) return { hasMore: false };
      const raw = await r.json();
      if (!raw || !Array.isArray(raw)) return { hasMore: false };

      const normalized = raw
        .map(normalizeMessage)
        .sort((a, b) => new Date(a.ts) - new Date(b.ts));

      // Filtra mensagens que já temos
      const existingIds = new Set((currentMsgs || []).map(m => m.id));
      // Se fromTimestamp funcionou, filtra por ID; senão filtra por timestamp anterior
      const novas = normalized.filter(m =>
        !existingIds.has(m.id) &&
        (!oldestTs || new Date(m.ts).getTime() / 1000 < oldestTs)
      );

      if (novas.length === 0) return { hasMore: false };

      setMessages(prev => {
        const current = prev[chatId] || [];
        const ids     = new Set(current.map(m => m.id));
        const toAdd   = novas.filter(m => !ids.has(m.id));
        if (toAdd.length === 0) return prev;
        const updated = [...toAdd, ...current].sort((a,b) => new Date(a.ts)-new Date(b.ts));
        cache.set(MSGS_PREFIX + chatId, updated, MSGS_TTL);
        return { ...prev, [chatId]: updated };
      });

      return { hasMore: novas.length >= 20 };
    } catch { return { hasMore: false }; }
  }, []);

  return {
    chats, setChats,
    messages, loadMessages, loadOlderMessages,
    send,
    forwardChat, resolveChat, markRead, markUnread, addTag,
    loading, error, wsStatus, sessionOk,
  };
}