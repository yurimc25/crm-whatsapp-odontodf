// src/hooks/useContacts.js
// Hierarquia de resolução de contatos:
// 1. localStorage  — instantâneo, zero latência
// 2. MongoDB cache — sincronizado entre dispositivos, TTL 1h
// 3. Codental      — busca individual por número
// 4. Google        — último recurso, bulk ou individual
// Sincroniza MongoDB a cada 1h apenas se houver mudanças locais

import { useState, useEffect, useCallback, useRef } from "react";
import { cache } from "../utils/cache";

const LS_KEY           = "contacts_map";
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
function readLocalMap() {
  try { return cache.get(LS_KEY) || {}; } catch { return {}; }
}

function writeLocalMap(map) {
  try { cache.set(LS_KEY, map, LS_TTL); } catch {}
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

export function useContacts() {
  const [contactMap, setContactMap] = useState(() => readLocalMap());
  const [loading, setLoading]       = useState(false);
  const internalKey = import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";
  const codKey      = import.meta.env.VITE_INTERNAL_API_KEY || "@Deuse10";

  // Rastreia números já pesquisados nesta sessão
  const lookedUp    = useRef(new Set());
  // Mudanças pendentes para sync com MongoDB
  const pendingSync = useRef(false);

  // ── Merge seguro no estado + localStorage ─────────────────────
  const mergeMap = useCallback((incoming, source = "") => {
    setContactMap(prev => {
      const updated = { ...prev };
      let changed = false;
      for (const [k, v] of Object.entries(incoming)) {
        if (!prev[k] || prev[k] !== v) { updated[k] = v; changed = true; }
      }
      if (!changed) return prev;
      writeLocalMap(updated);
      if (source === "local") {
        pendingSync.current = true;
        // Tenta sincronizar imediatamente com o MongoDB para refletir a mudança
        (async () => {
          try {
            await fetch("/api/db?action=contacts_cache", {
              method: "POST",
              headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey },
              body: JSON.stringify({ contacts: updated }),
            });
            pendingSync.current = false;
            markMongoSync();
            console.log("[contacts] immediate sync to MongoDB completed");
          } catch (e) {
            console.warn("[contacts] immediate sync failed:", e?.message || e);
            // deixe pendingSync true para tentativa periódica
            pendingSync.current = true;
          }
        })();
      }
      console.log(`[contacts] merged ${Object.keys(incoming).length} entries from ${source}`);
      return updated;
    });
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

  // ── lookupPhone — hierarquia: Codental → Google ───────────────
  const lookupPhone = useCallback(async (wahaId) => {
    const phone = wahaIdToPhone(wahaId);
    if (!phone || phone.length < 7) return null;
    if (lookedUp.current.has(phone)) return null;

    // Já tem no mapa? Não busca
    const current = readLocalMap();
    const found = findInMap(phone, current);
    if (found) return found;

    lookedUp.current.add(phone);

    // ── 3. Codental searchByPhone ─────────────────────────────
    try {
      const r = await fetch(
        `/api/codental?action=search&phone=${phone}`,
        { headers: { "X-Internal-Key": codKey } }
      );
      if (r.ok) {
        const data = await r.json();
        const patients = data.patients || [];
        if (patients.length > 0) {
          const p = patients[0];
          const name = p.fullName || p.full_name || p.name;
          const pPhone = p.cellphone_formated || p.cellphone || phone;
          if (name) {
            const incoming = {};
            for (const v of phoneVariants(pPhone.replace(/\D/g,""))) incoming[v] = name;
            for (const v of phoneVariants(phone)) incoming[v] = name;
            mergeMap(incoming, "local");
            console.log(`[contacts] Codental ${phone} → ${name}`);
            return name;
          }
        }
      }
    } catch {}

    // ── 4. Google individual — UMA request com cache-bust ────────
    // _t evita 304 do CDN do Vercel
    try {
      const r = await fetch(
        `/api/contacts?action=search&phone=${phone}&_t=${Date.now()}`,
        { headers: { "X-Internal-Key": internalKey }, cache: "no-store" }
      );
      if (r.status === 304 || !r.ok) {
        console.warn(`[contacts] Google ${phone}: status ${r.status}`);
        return null;
      }
      const { found, name, variants: fv } = await r.json();
      if (!found || !name) return null;
      const incoming = {};
      for (const gv of (fv || phoneVariants(phone))) incoming[gv] = name;
      mergeMap(incoming, "local");
      console.log(`[contacts] Google ${phone} → ${name}`);
      return name;
    } catch (e) {
      console.warn(`[contacts] Google ${phone} error:`, e.message);
    }

    return null;
  }, [findInMap, mergeMap, internalKey, codKey]);

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

  // ── Resolvers ─────────────────────────────────────────────────
  const resolveName = useCallback((wahaId, pushname) => {
    const phone = wahaIdToPhone(wahaId);
    return findInMap(phone, contactMap) || pushname || null;
  }, [contactMap, findInMap]);

  const displayName = useCallback((wahaId, fallback, pushname) => {
    return resolveName(wahaId, pushname) || fallback || formatPhone(wahaIdToPhone(wahaId));
  }, [resolveName]);

  const displayInfo = useCallback((wahaId, fallbackName, pushname) => {
    const phone       = wahaIdToPhone(wahaId);
    const fmtPhone    = formatPhone(phone);
    const contactName = resolveName(wahaId, pushname);
    if (contactName) return { hasContact: true, name: contactName, phone: fmtPhone };
    const rawNumber = fmtPhone !== "—" ? fmtPhone : (fallbackName || wahaId || "Desconhecido");
    return { hasContact: false, line1: rawNumber, line2: rawNumber, phone: fmtPhone };
  }, [resolveName]);

  return {
    contactMap, resolveName, displayName, displayInfo,
    addLocalContact, lookupPhone, lookupPhonePriority, searchByName, loading,
    refresh: fetchGoogleBulk,
  };
}