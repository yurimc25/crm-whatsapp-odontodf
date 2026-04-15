// src/hooks/useContacts.js
// Hierarquia de resolução de contatos:
// 1. localStorage  — instantâneo, zero latência
// 2. MongoDB cache — sincronizado entre dispositivos, TTL 1h
// 3. Codental      — busca individual por número
// 4. Google        — último recurso, bulk ou individual
// Sincroniza MongoDB a cada 1h apenas se houver mudanças locais

import { useState, useEffect, useCallback, useRef } from "react";
import { cache } from "../utils/cache";
import { resolveLidToPhone, getContactInfo } from "../services/waha";

const LS_KEY           = "contacts_map";
const LID_CACHE_KEY    = "lid_phone_map";   // localStorage: { [lid]: realPhone }
const LS_TTL           = 24 * 60 * 60 * 1000;  // 24h local
const MONGO_SYNC_INTERVAL = 60 * 60 * 1000;    // 1h entre syncs com MongoDB
const MONGO_SYNC_KEY   = "contacts_last_sync";
const BULK_FETCH_KEY   = "contacts_bulk_fetched_at";
const BULK_TTL         = 6 * 60 * 60 * 1000;   // re-busca bulk a cada 6h

function shouldFetchBulk() {
  try {
    const last = parseInt(localStorage.getItem(BULK_FETCH_KEY) || "0");
    return Date.now() - last > BULK_TTL;
  } catch { return true; }
}
function markBulkFetched() {
  try { localStorage.setItem(BULK_FETCH_KEY, String(Date.now())); } catch {}
}

export function wahaIdToPhone(wahaId) {
  return (wahaId || "").replace(/@.*$/, "").replace(/\D/g, "");
}

export function formatPhone(digits) {
  const d = (digits || "").replace(/\D/g, "");
  if (d.startsWith("55") && d.length === 13) return `(${d.slice(2,4)}) ${d.slice(4,9)}-${d.slice(9)}`;
  if (d.startsWith("55") && d.length === 12) return `(${d.slice(2,4)}) ${d.slice(4,8)}-${d.slice(8)}`;
  if (d.length === 11) return `(${d.slice(0,2)}) ${d.slice(2,7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0,2)}) ${d.slice(2,6)}-${d.slice(6)}`;
  return d || "—";
}

// Gera variantes de um número — IDÊNTICA ao backend
export function phoneVariants(digits) {
  const variants = new Set();
  const d = (digits || "").replace(/\D/g, "");
  if (!d) return [];
  variants.add(d);
  const isBR  = d.startsWith("55") && d.length >= 12;
  const local = isBR ? d.slice(2) : d;
  if (local.length >= 8) {
    variants.add(local);
    variants.add("55" + local);
    const ddd = local.slice(0, 2);
    const num = local.slice(2);
    variants.add(num);
    if (num.length === 9 && num.startsWith("9")) {
      const sem9 = num.slice(1);
      variants.add(sem9); variants.add(ddd + sem9); variants.add("55" + ddd + sem9);
    }
    if (num.length === 8) {
      const com9 = "9" + num;
      variants.add(com9); variants.add(ddd + com9); variants.add("55" + ddd + com9);
    }
    if (local.length === 11 && local[2] === "9") {
      const sem9 = local.slice(0,2) + local.slice(3);
      variants.add(sem9); variants.add("55" + sem9);
    }
    if (local.length === 10) {
      const com9 = local.slice(0,2) + "9" + local.slice(2);
      variants.add(com9); variants.add("55" + com9);
    }
  }
  return [...variants];
}

// Lê/escreve o mapa no localStorage
// Usa formato raw (sem TTL de expiração) para não perder contatos adicionados manualmente.
// Fallback: tenta ler o formato antigo com TTL do cache utility.
const RAW_LS_KEY = "crm_contacts_raw";
function readLocalMap() {
  try {
    const raw = localStorage.getItem(RAW_LS_KEY);
    if (raw) return JSON.parse(raw) || {};
  } catch {}
  // Fallback: formato antigo com TTL
  try { return cache.get(LS_KEY) || {}; } catch {}
  return {};
}

function writeLocalMap(map) {
  // Escreve sem TTL — contatos não expiram
  try {
    localStorage.setItem(RAW_LS_KEY, JSON.stringify(map));
    return;
  } catch {
    // Quota exceeded — libera espaço de chaves antigas e tenta de novo
    try {
      Object.keys(localStorage)
        .filter(k => k.startsWith("crm_waha_msgs_") || k.startsWith("crm_img_") || k === "crm_" + LS_KEY)
        .forEach(k => { try { localStorage.removeItem(k); } catch {} });
      localStorage.setItem(RAW_LS_KEY, JSON.stringify(map));
    } catch {}
  }
}

// Verifica se deve sincronizar com MongoDB (a cada 1h)
function shouldSyncMongo() {
  try {
    const last = parseInt(localStorage.getItem(MONGO_SYNC_KEY) || "0");
    return Date.now() - last > MONGO_SYNC_INTERVAL;
  } catch { return true; }
}

function markMongoSync() {
  try { localStorage.setItem(MONGO_SYNC_KEY, String(Date.now())); } catch {}
}

// ── Cache de LID → { phone, pushName } (localStorage, sem TTL — raramente muda) ──
function readLidCache() {
  try { return JSON.parse(localStorage.getItem(LID_CACHE_KEY) || "{}"); } catch { return {}; }
}
function writeLidCache(map) {
  try { localStorage.setItem(LID_CACHE_KEY, JSON.stringify(map)); } catch {}
}

export function useContacts() {
  const [contactMap, setContactMap] = useState(() => readLocalMap());
  const [lidPhoneMap, setLidPhoneMap] = useState(() => readLidCache());
  const [loading, setLoading]       = useState(false);
  const internalKey = import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";
  const codKey      = import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";

  // Rastreia números já pesquisados nesta sessão
  const lookedUp    = useRef(new Set());
  // Mudanças pendentes para sync com MongoDB
  const pendingSync = useRef(false);
  // LIDs em processo de resolução (evita chamadas duplicadas)
  const resolvingLids = useRef(new Set());
  // LIDs que já tentamos resolver e falharam (404/sem phone/sem pushName) — não retenta
  const failedLids = useRef(new Set());
  // Ref ao lidPhoneMap atual para uso em callbacks sem criar nova referência a cada mudança
  const lidPhoneMapRef = useRef(lidPhoneMap);
  useEffect(() => { lidPhoneMapRef.current = lidPhoneMap; }, [lidPhoneMap]);
  // Fila para throttle de resolução de LIDs — evita saturar conexões do Chrome
  const lidQueue = useRef([]);
  const lidQueueRunning = useRef(false);
  const MAX_CONCURRENT_LIDS = 3;
  const activeLidFetches = useRef(0);

  function _drainLidQueue() {
    while (lidQueue.current.length > 0 && activeLidFetches.current < MAX_CONCURRENT_LIDS) {
      const task = lidQueue.current.shift();
      activeLidFetches.current++;
      task().finally(() => {
        activeLidFetches.current--;
        _drainLidQueue();
      });
    }
  }

  function _enqueueLidTask(task) {
    lidQueue.current.push(task);
    _drainLidQueue();
  }

  // ── Merge seguro no estado + localStorage ─────────────────────
  const mergeMap = useCallback((incoming, source = "") => {
    // Calcula o mapa atualizado fora do updater para evitar side effects dentro do React
    // (React pode chamar updaters múltiplas vezes no Strict Mode)
    setContactMap(prev => {
      const updated = { ...prev };
      let changed = false;
      for (const [k, v] of Object.entries(incoming)) {
        if (!prev[k] || prev[k] !== v) { updated[k] = v; changed = true; }
      }
      if (!changed) return prev;
      // Persiste no localStorage imediatamente (síncrono, antes do próximo render)
      writeLocalMap(updated);
      console.log(`[contacts] merged ${Object.keys(incoming).length} entries from ${source}`);
      return updated;
    });
    // Side effects fora do updater: sync com MongoDB
    if (source === "local") {
      pendingSync.current = true;
      // Lê mapa atualizado do localStorage (já escrito pelo updater acima)
      // e sincroniza com MongoDB para garantir persistência cross-device
      setTimeout(() => {
        const map = readLocalMap();
        if (!Object.keys(map).length) return;
        fetch("/api/db?action=contacts_cache", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey },
          body: JSON.stringify({ contacts: map }),
        }).then(() => {
          pendingSync.current = false;
          markMongoSync();
          console.log("[contacts] sync to MongoDB completed");
        }).catch(e => {
          console.warn("[contacts] sync failed:", e?.message || e);
        });
      }, 100); // pequeno delay para o updater do setContactMap terminar primeiro
    }
  }, [internalKey]);

  // ── 1. Inicialização: localStorage → MongoDB ──────────────────
  useEffect(() => {
    async function init() {
      const local = readLocalMap();
      const hasLocal = Object.keys(local).length > 0;

      // Sempre carrega MongoDB se passou 1h — pode ter novos contatos de outros dispositivos
      if (shouldSyncMongo()) {
        setLoading(true);
        try {
          const r = await fetch("/api/db?action=contacts_cache", {
            headers: { "X-Internal-Key": internalKey },
          });
          if (r.ok) {
            const { contacts, expired } = await r.json();
            if (contacts && !expired) {
              // MongoDB tem prioridade sobre local apenas para chaves que local não tem
              const merged = { ...contacts, ...local };
              writeLocalMap(merged);
              setContactMap(merged);
              markMongoSync();
              console.log(`[contacts] MongoDB: ${Object.keys(contacts).length} entries`);
            }
          }
        } catch {}
        setLoading(false);
      }

      // Busca bulk do Google a cada 6h para manter o mapa atualizado
      if (shouldFetchBulk()) {
        fetchGoogleBulk();
      }
    }
    init();
  }, []); // só na montagem

  // ── Sync periódico com MongoDB (1h) se houver mudanças ────────
  useEffect(() => {
    const iv = setInterval(() => {
      if (!pendingSync.current) return;
      const map = readLocalMap();
      if (!Object.keys(map).length) return;
      fetch("/api/db?action=contacts_cache", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey },
        body: JSON.stringify({ contacts: map }),
      }).then(() => {
        pendingSync.current = false;
        markMongoSync();
        console.log("[contacts] synced to MongoDB");
      }).catch(() => {});
    }, MONGO_SYNC_INTERVAL);
    return () => clearInterval(iv);
  }, [internalKey]);

  // ── Google bulk (background, só se necessário) ────────────────
  async function fetchGoogleBulk() {
    try {
      const r = await fetch("/api/contacts", {
        headers: { "X-Internal-Key": internalKey },
      });
      if (!r.ok) return;
      const { contacts } = await r.json();
      if (!contacts) return;
      mergeMap(contacts, "google-bulk");
      pendingSync.current = true;
      markBulkFetched();
    } catch (e) {
      console.warn("[contacts] Google bulk falhou:", e.message);
    }
  }

  // ── findInMap — exato + parcial por sufixo ───────────────────
  const findInMap = useCallback((phone, map) => {
    const variants = phoneVariants(phone);
    for (const v of variants) { if (map[v]) return map[v]; }
    // Fallback parcial por sufixo (mínimo 8 dígitos)
    for (const key of Object.keys(map)) {
      if (variants.some(v => v.length >= 8 && (key.endsWith(v) || v.endsWith(key)))) {
        return map[key];
      }
    }
    return null;
  }, []);

  // ── addLocalContact — Codental/PatientPanel alimenta o mapa ──
  const addLocalContact = useCallback((entries) => {
    const list = Array.isArray(entries) ? entries : [entries];
    const incoming = {};
    for (const { phone, name } of list) {
      if (!phone || !name) continue;
      const digits = phone.replace(/\D/g, "");
      for (const v of phoneVariants(digits)) incoming[v] = name;
    }
    if (Object.keys(incoming).length) mergeMap(incoming, "local");
  }, [mergeMap]);

  // ── removeContact — remove todas as variantes de um número do mapa ──
  const removeContact = useCallback((phone) => {
    const digits = (phone || "").replace(/\D/g, "");
    if (!digits) return;
    const toRemove = new Set(phoneVariants(digits));
    setContactMap(prev => {
      const updated = { ...prev };
      let changed = false;
      for (const k of toRemove) {
        if (k in updated) { delete updated[k]; changed = true; }
      }
      if (!changed) return prev;
      writeLocalMap(updated);
      pendingSync.current = true;
      return updated;
    });
  }, []);

  // ── lookupPhone — hierarquia: Codental → Google ───────────────
  const lookupPhone = useCallback(async (wahaId) => {
    const phone = wahaIdToPhone(wahaId);
    if (!phone || phone.length < 7) return null;

    // Já tem no mapa de estado React? Retorna direto
    const inState = findInMap(phone, contactMap);
    if (inState) return inState;

    // Já tem no localStorage mas não no estado? Sincroniza estado e retorna
    const current = readLocalMap();
    const found = findInMap(phone, current);
    if (found) {
      // Sincroniza entrada faltante no estado React sem fazer nova busca
      const incoming = {};
      for (const v of phoneVariants(phone)) incoming[v] = found;
      mergeMap(incoming, "local-sync");
      return found;
    }

    // Já foi tentado e não encontrado nesta sessão? Não repete
    if (lookedUp.current.has(phone)) return null;

    // Marca como "em progresso" para evitar requisições paralelas duplicadas
    lookedUp.current.add(phone);

    const digits = phone.replace(/\D/g, "");
    const myVariants = new Set(phoneVariants(digits));

    // Verifica se um número (string de dígitos) corresponde ao nosso contato
    // Exige >= 8 dígitos finais coincidentes (cobre com/sem DDI 55, com/sem 9)
    function phoneMatches(cPhone) {
      const cp = (cPhone || "").replace(/\D/g, "");
      if (!cp || cp.length < 8) return false;
      if (myVariants.has(cp)) return true;
      // Compara os últimos 8 dígitos dos dois números
      const tail8cp  = cp.slice(-8);
      const tail8me  = digits.slice(-8);
      return tail8cp.length === 8 && tail8cp === tail8me;
    }

    function saveContact(name, cPhone) {
      const incoming = {};
      const cp = (cPhone || "").replace(/\D/g, "");
      if (cp) for (const v of phoneVariants(cp)) incoming[v] = name;
      for (const v of myVariants) incoming[v] = name;
      mergeMap(incoming, "local");
    }

    // ── 3. Codental — busca com número completo, filtra por >= 8 dígitos ──
    // A API faz busca textual (contains), então filtramos localmente
    try {
      // Tenta com as variantes mais prováveis do número completo
      const codVariants = [...new Set([phone, ...phoneVariants(phone)])];
      let allPatients = [];
      for (const variant of codVariants) {
        if (allPatients.length > 0) break;
        try {
          const r = await fetch(
            `/api/codental?action=search&phone=${variant}`,
            { headers: { "X-Internal-Key": codKey } }
          );
          if (!r.ok) continue;
          const data = await r.json();
          allPatients = data.patients || [];
        } catch {}
      }
      // Filtra: só aceita paciente cujo número compartilha >= 8 dígitos com o original
      const match = allPatients.find(p => {
        const pPhone = (p.cellphone_formated || p.cellphone || "").replace(/\D/g, "");
        return phoneMatches(pPhone);
      });
      if (match) {
        const name = match.fullName || match.full_name || match.name;
        const pPhone = match.cellphone_formated || match.cellphone || phone;
        if (name) {
          saveContact(name, pPhone);
          console.log(`[contacts] Codental ${phone} → ${name}`);
          return name;
        }
      }
    } catch {}

    // ── 4. Google — fase A: busca por phone (exato) com todas as variantes ──
    for (const variant of [...new Set([digits, ...phoneVariants(digits)])]) {
      try {
        const r = await fetch(
          `/api/contacts?action=search&phone=${variant}&_t=${Date.now()}`,
          { headers: { "X-Internal-Key": internalKey }, cache: "no-store" }
        );
        if (!r.ok) continue;
        const data = await r.json();
        if (!data.found || !data.name) continue;
        const fv = data.variants || [];
        const cPhone = Array.isArray(fv)
          ? (fv.find(v => String(v).replace(/\D/g,"").length >= 8) || variant)
          : String(fv);
        saveContact(data.name, cPhone);
        console.log(`[contacts] Google phone=${variant} → ${data.name}`);
        return data.name;
      } catch {}
    }

    // ── 4b. Google — fase B: q= com últimos 4 dígitos, filtra localmente ──
    async function googleSearchQ(q) {
      const r = await fetch(
        `/api/contacts?action=search&q=${encodeURIComponent(q)}&_t=${Date.now()}`,
        { headers: { "X-Internal-Key": internalKey }, cache: "no-store" }
      );
      if (!r.ok) return [];
      const data = await r.json();
      if (!data.found) return [];
      if (data.name) {
        const fv = data.variants || [];
        const cPhone = Array.isArray(fv)
          ? (fv.find(v => String(v).replace(/\D/g,"").length >= 8) || "")
          : fv;
        return [{ name: data.name, phone: String(cPhone).replace(/\D/g,"") }];
      }
      if (Array.isArray(data.contacts)) {
        return data.contacts.map(c => ({
          name: c.name || c.fullName || c.title || "",
          phone: (c.phone || "").replace(/\D/g, ""),
        })).filter(c => c.name);
      }
      return [];
    }

    // Busca com últimos 4 dígitos (amplo), filtra localmente por >= 8 dígitos coincidentes
    const suffix4 = digits.slice(-4);
    if (suffix4.length >= 4) {
      try {
        const candidates = await googleSearchQ(suffix4);
        const hit = candidates.find(c => phoneMatches(c.phone));
        if (hit) {
          saveContact(hit.name, hit.phone);
          console.log(`[contacts] Google q=${suffix4} → ${hit.name} (${hit.phone})`);
          return hit.name;
        }
      } catch {}
    }

    return null;
  }, [contactMap, findInMap, mergeMap, internalKey, codKey]);

  // ── lookupPhonePriority — força nova tentativa ignorando o cache de sessão ──
  const lookupPhonePriority = useCallback(async (wahaId) => {
    const phone = wahaIdToPhone(wahaId);
    if (!phone || phone.length < 7) return null;
    lookedUp.current.delete(phone);
    const current = readLocalMap();
    const found = findInMap(phone, current);
    if (found) return found;
    return lookupPhone(wahaId);
  }, [findInMap, lookupPhone]);

  // ── searchByName — busca no Google por nome e mescla resultados no mapa
  const searchByName = useCallback(async (name) => {
    if (!name || name.trim().length < 2) return false;
    try {
      const r = await fetch(`/api/contacts?action=search&q=${encodeURIComponent(name.trim())}&_t=${Date.now()}`, {
        headers: { "X-Internal-Key": internalKey }, cache: "no-store"
      });
      if (!r.ok) {
        console.warn(`[contacts] searchByName ${name}: status ${r.status}`);
        return false;
      }
      const data = await r.json();
      if (!data.found || !Array.isArray(data.contacts) || data.contacts.length === 0) return false;
      const incoming = {};
      for (const c of data.contacts) {
        const nm = c.name;
        const ph = (c.phone || "").replace(/\D/g, "");
        if (!nm || !ph) continue;
        for (const v of phoneVariants(ph)) incoming[v] = nm;
      }
      if (Object.keys(incoming).length) {
        mergeMap(incoming, "google-name");
        pendingSync.current = true;
        return true;
      }
    } catch (e) {
      console.warn(`[contacts] searchByName error for '${name}':`, e?.message || e);
    }
    return false;
  }, [internalKey, mergeMap]);

  // ── Resolução assíncrona de @lid → { phone, pushName } via WAHA ──
  // Usa GET /api/{session}/lids/{lid} para obter o telefone real,
  // depois GET /api/contacts?contactId= para obter o nome.
  // Chamado via useEffect nos componentes, nunca durante render.
  const resolveLidAsync = useCallback((lid) => {
    const lidOnly = lid.replace(/@lid$/, "");
    if (resolvingLids.current.has(lidOnly)) return;
    // Já tentou e falhou (WAHA não conhece este LID) — não repete a request
    if (failedLids.current.has(lidOnly)) return;
    const cached = lidPhoneMapRef.current[lidOnly];
    // Já tem phone: garante lookup de nome pelo telefone resolvido
    if (cached?.phone) {
      const cur = readLocalMap();
      const found = findInMap(cached.phone, cur);
      if (!found) lookupPhone(cached.phone + "@c.us");
      return;
    }
    resolvingLids.current.add(lidOnly);

    _enqueueLidTask(async () => {
      try {
        // 1. Resolve LID → JID real
        const pnJid = await resolveLidToPhone(lid);
        const phone = pnJid
          ? pnJid.replace(/@.*$/, "").replace(/\D/g, "")
          : null;

        // 2. Busca nome do contato (usando JID real se disponível, senão LID)
        const contactId = pnJid || lid;
        const contact   = await getContactInfo(contactId);
        const pushName  = contact?.name || contact?.pushname || contact?.pushName || null;

        if (phone && phone.length >= 8) {
          setLidPhoneMap(prev => {
            const updated = { ...prev, [lidOnly]: { phone, pushName } };
            writeLidCache(updated);
            console.log(`[contacts/lid] resolvido: ${lid} → ${phone}${pushName ? ` (${pushName})` : ""}`);
            return updated;
          });
          // 3. Busca nome via Codental/Google pelo telefone resolvido
          lookupPhone(phone + "@c.us");
        } else if (pushName) {
          setLidPhoneMap(prev => {
            if (prev[lidOnly]?.phone) return prev;
            const updated = { ...prev, [lidOnly]: { phone: null, pushName } };
            writeLidCache(updated);
            return updated;
          });
        } else {
          // WAHA respondeu mas não tem dados (LID inválido/desconhecido) — não retenta
          failedLids.current.add(lidOnly);
        }
      } catch {
        // Erro de rede (ERR_INSUFFICIENT_RESOURCES, timeout, etc.) — NÃO marca como falha
        // permanente; permite nova tentativa quando o efeito rodar novamente
      }
      resolvingLids.current.delete(lidOnly);
    });
  }, [findInMap, lookupPhone]);

  // ── Resolvers ─────────────────────────────────────────────────
  const resolveName = useCallback((wahaId, pushname) => {
    const isLid = wahaId?.endsWith("@lid");
    let phone;
    if (isLid) {
      const lidOnly  = wahaId.replace(/@lid$/, "");
      const cached   = lidPhoneMap[lidOnly];
      phone          = cached?.phone || null;
      // usa pushName do cache WAHA se não tiver pushname do chat
      const wahaName = cached?.pushName || null;
      if (!phone) return pushname || wahaName || null;
      return findInMap(phone, contactMap) || pushname || wahaName || null;
    }
    phone = wahaIdToPhone(wahaId);
    return findInMap(phone, contactMap) || pushname || null;
  }, [contactMap, findInMap, lidPhoneMap]);

  const displayName = useCallback((wahaId, fallback, pushname) => {
    const resolved = resolveName(wahaId, pushname);
    if (resolved) return resolved;
    if (wahaId?.endsWith("@lid")) {
      const lidOnly  = wahaId.replace(/@lid$/, "");
      const cached   = lidPhoneMap[lidOnly];
      if (cached?.phone) return formatPhone(cached.phone);
      if (cached?.pushName) return cached.pushName;
      return pushname || fallback || null;
    }
    if (fallback) {
      const isRawNumber = /^\+?[\d\s\-().]+$/.test(fallback) && fallback.replace(/\D/g,"").length >= 8;
      return isRawNumber ? formatPhone(fallback.replace(/\D/g,"")) : fallback;
    }
    return formatPhone(wahaIdToPhone(wahaId));
  }, [resolveName, lidPhoneMap]);

  const displayInfo = useCallback((wahaId, fallbackName, pushname) => {
    const isLid = wahaId?.endsWith("@lid");
    let phone;
    if (isLid) {
      const lidOnly = wahaId.replace(/@lid$/, "");
      const cached  = lidPhoneMap[lidOnly];
      phone         = cached?.phone || null;
      // Usa pushName do cache WAHA como pushname adicional
      const wahaPush = cached?.pushName || null;
      const effectivePush = pushname || wahaPush || null;
      // Se o telefone foi resolvido, usa ele formatado; senão, mostra o que temos
      const fmtPhone = phone ? formatPhone(phone) : null;
      const contactName = resolveName(wahaId, effectivePush);
      // Nome a exibir: contato salvo > pushname do chat > pushName do WAHA > fallback > telefone formatado
      const displayLabel = contactName || effectivePush || fallbackName || fmtPhone || null;
      return {
        hasContact: !!contactName,
        name:       displayLabel || "—",
        line1:      displayLabel || "—",
        phone:      fmtPhone || null,
      };
    }
    phone = wahaIdToPhone(wahaId);
    const fmtPhone    = formatPhone(phone);
    const contactName = resolveName(wahaId, pushname);
    if (contactName) return { hasContact: true, name: contactName, phone: fmtPhone };
    // Fallback: pushname do chat > telefone formatado > fallbackName
    const displayLabel = pushname || (fmtPhone !== "—" ? fmtPhone : null) || fallbackName || wahaId || "Desconhecido";
    return { hasContact: false, name: displayLabel, line1: displayLabel, phone: fmtPhone };
  }, [resolveName, lidPhoneMap]);

  return {
    contactMap, lidPhoneMap, resolveName, displayName, displayInfo, resolveLidAsync,
    addLocalContact, removeContact, lookupPhone, lookupPhonePriority, searchByName, loading,
    refresh: fetchGoogleBulk,
  };
}