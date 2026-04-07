// src/hooks/useContacts.js
// Hierarquia de contatos:
// 1. localStorage (mapa acumulado — instantâneo, zero latência)
// 2. Google Contacts bulk (carrega em background, ~2s)
// 3. Codental searchByPhone (fallback individual por número desconhecido)
// 4. Google Contacts individual lookup (último recurso)
// Se nenhum encontrar → paciente novo

import { useState, useEffect, useCallback, useRef } from "react";
import { cache } from "../utils/cache";

const LS_KEY  = "contacts_map";
const LS_TTL  = 4 * 60 * 60 * 1000; // 4 horas
const API_TTL = 4 * 60 * 60 * 1000;

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

// Gera variantes de um número — IDÊNTICA ao backend (contacts.js e sync-contacts.js)
function phoneVariants(digits) {
  const variants = new Set();
  const d = (digits || "").replace(/\D/g, "");
  if (!d) return [];

  variants.add(d);

  const isBR = d.startsWith("55") && d.length >= 12;
  const local = isBR ? d.slice(2) : d;

  if (local.length >= 8) {
    variants.add(local);
    variants.add("55" + local);

    const ddd = local.slice(0, 2);
    const num = local.slice(2);

    // Sem DDD
    variants.add(num);

    if (num.length === 9 && num.startsWith("9")) {
      const sem9 = num.slice(1);
      variants.add(sem9);
      variants.add(ddd + sem9);
      variants.add("55" + ddd + sem9);
    }

    if (num.length === 8) {
      const com9 = "9" + num;
      variants.add(com9);
      variants.add(ddd + com9);
      variants.add("55" + ddd + com9);
    }

    if (local.length === 11 && local[2] === "9") {
      const sem9 = local.slice(0, 2) + local.slice(3);
      variants.add(sem9);
      variants.add("55" + sem9);
    }

    if (local.length === 10) {
      const com9 = local.slice(0, 2) + "9" + local.slice(2);
      variants.add(com9);
      variants.add("55" + com9);
    }
  }

  return [...variants];
}

// Salva no localStorage renovando TTL
function persistMap(map) {
  try {
    const raw = localStorage.getItem("crm_" + LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      parsed.value   = { ...parsed.value, ...map };
      parsed.expires = Date.now() + LS_TTL;
      localStorage.setItem("crm_" + LS_KEY, JSON.stringify(parsed));
    } else {
      cache.set(LS_KEY, map, LS_TTL);
    }
  } catch {}
}

export function useContacts() {
  // 1. Carrega do localStorage imediatamente
  const [contactMap, setContactMap] = useState(() => cache.get(LS_KEY) || {});
  const [loading, setLoading]       = useState(false);
  const [source, setSource]         = useState("cache");
  const internalKey = import.meta.env.VITE_INTERNAL_API_KEY || "";
  // Rastreia números já pesquisados individualmente para não repetir
  const lookedUp = useRef(new Set());

  // 2. Carrega Google Contacts em background (bulk, uma vez)
  const fetchGoogle = useCallback(async (force = false) => {
    if (!force && cache.get(LS_KEY)) return;
    setLoading(true);
    try {
      // Tenta MongoDB cache primeiro
      const mongoRes = await fetch(`/api/db?action=contacts_cache`, {
        headers: { "X-Internal-Key": internalKey },
      });
      if (mongoRes.ok) {
        const { contacts, expired } = await mongoRes.json();
        if (contacts && !expired) {
          setContactMap(prev => {
            const merged = { ...contacts, ...prev }; // mapa local tem prioridade
            cache.set(LS_KEY, merged, LS_TTL);
            return merged;
          });
          setSource("mongo");
          setLoading(false);
          return;
        }
      }
    } catch {}

    // Google API bulk
    try {
      const r = await fetch("/api/contacts", {
        headers: { "X-Internal-Key": internalKey },
      });
      if (r.ok) {
        const { contacts } = await r.json();
        setContactMap(prev => {
          const merged = { ...contacts, ...prev }; // mapa local tem prioridade
          cache.set(LS_KEY, merged, LS_TTL);
          // Salva no MongoDB
          fetch(`/api/db?action=contacts_cache`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Internal-Key": internalKey },
            body: JSON.stringify({ contacts: merged }),
          }).catch(() => {});
          return merged;
        });
        setSource("google");
      }
    } catch (e) {
      console.warn("[contacts] Google bulk falhou:", e.message);
    } finally {
      setLoading(false);
    }
  }, [internalKey]);

  useEffect(() => {
    fetchGoogle();
    const iv = setInterval(() => fetchGoogle(true), API_TTL);
    return () => clearInterval(iv);
  }, [fetchGoogle]);

  // Busca no mapa — variantes exatas primeiro, depois match parcial por sufixo
  const findInMap = useCallback((phone, map) => {
    const variants = phoneVariants(phone);
    // Match exato
    for (const v of variants) {
      if (map[v]) return map[v];
    }
    // Match parcial: chave do mapa termina com variante ou vice-versa
    for (const key of Object.keys(map)) {
      if (variants.some(v => v.length >= 8 && (key.endsWith(v) || v.endsWith(key)))) {
        return map[key];
      }
    }
    return null;
  }, []);

  // 3. Adiciona contatos do Codental/outros ao mapa — sempre persiste
  const addLocalContact = useCallback((entries) => {
    const list = Array.isArray(entries) ? entries : [entries];
    setContactMap(prev => {
      let changed = false;
      const updated = { ...prev };
      for (const { phone, name } of list) {
        if (!phone || !name) continue;
        const digits = phone.replace(/\D/g, "");
        for (const v of phoneVariants(digits)) {
          if (!prev[v] || prev[v] !== name) {
            updated[v] = name;
            changed = true;
          }
        }
      }
      if (!changed) return prev;
      persistMap(updated);
      return updated;
    });
  }, []);

  // 4. Lookup individual — tenta todas as variantes do número
  const lookupPhone = useCallback(async (wahaId) => {
    const phone = wahaIdToPhone(wahaId);
    if (!phone || phone.length < 7) return;
    if (lookedUp.current.has(phone)) return;
    if (findInMap(phone, contactMap)) return;
    lookedUp.current.add(phone);

    // Tenta cada variante até achar
    const variants = phoneVariants(phone);
    for (const v of variants) {
      try {
        const r = await fetch(
          `/api/contacts?action=search&phone=${v}`,
          { headers: { "X-Internal-Key": internalKey } }
        );
        if (!r.ok) continue;
        const { found, name, variants: foundVariants } = await r.json();
        if (!found || !name) continue;

        setContactMap(prev => {
          const updated = { ...prev };
          let changed = false;
          for (const fv of (foundVariants || phoneVariants(phone))) {
            if (!prev[fv] || prev[fv] !== name) {
              updated[fv] = name;
              changed = true;
            }
          }
          if (!changed) return prev;
          persistMap(updated);
          console.log(`[contacts] Google individual ${phone} → ${name}`);
          return updated;
        });
        break; // achou, para
      } catch {}
    }
  }, [contactMap, internalKey, findInMap]);

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
    if (contactName) {
      return { hasContact: true, name: contactName, phone: fmtPhone };
    }
    const rawNumber = fmtPhone !== "—" ? fmtPhone : (fallbackName || wahaId || "Desconhecido");
    return { hasContact: false, line1: rawNumber, line2: rawNumber, phone: fmtPhone };
  }, [resolveName]);

  return {
    contactMap, resolveName, displayName, displayInfo,
    addLocalContact, lookupPhone,
    loading, source,
    refresh: () => fetchGoogle(true),
  };
}