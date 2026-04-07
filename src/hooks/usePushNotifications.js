// src/hooks/usePushNotifications.js
import { useState, useEffect, useCallback } from 'react';

const VAPID_PUBLIC = import.meta.env.VITE_VAPID_PUBLIC_KEY;
const iKey = () => import.meta.env.VITE_INTERNAL_API_KEY || '';

export function usePushNotifications(operator) {
  const [supported,   setSupported]   = useState(false);
  const [permission,  setPermission]  = useState('default');
  const [subscribed,  setSubscribed]  = useState(false);
  const [loading,     setLoading]     = useState(false);

  useEffect(() => {
    const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    setSupported(ok);
    if (ok) setPermission(Notification.permission);
  }, []);

  // Registra o Service Worker
  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => {
        console.log('[push] SW registrado:', reg.scope);
        // Verifica se já tem subscription ativa
        return reg.pushManager.getSubscription();
      })
      .then(sub => {
        if (sub) setSubscribed(true);
      })
      .catch(e => console.error('[push] SW error:', e));

    // Ouve mensagens do SW (ex: OPEN_CHAT)
    const handler = (e) => {
      if (e.data?.type === 'OPEN_CHAT') {
        window.dispatchEvent(new CustomEvent('crm:open-chat', { detail: { chatId: e.data.chatId } }));
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, [supported]);

  const subscribe = useCallback(async () => {
    if (!supported || !VAPID_PUBLIC) return;
    setLoading(true);
    try {
      // Pede permissão
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') { setLoading(false); return; }

      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC),
      });

      // Salva no servidor
      await fetch('/api/push?action=subscribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Key': iKey() },
        body:    JSON.stringify({ subscription: sub.toJSON(), operatorLogin: operator?.login || 'unknown' }),
      });

      setSubscribed(true);
      console.log('[push] subscribed!');
    } catch(e) {
      console.error('[push] subscribe error:', e);
    }
    setLoading(false);
  }, [supported, operator]);

  const unsubscribe = useCallback(async () => {
    setLoading(true);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await fetch('/api/push?action=unsubscribe', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Key': iKey() },
          body:    JSON.stringify({ endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
      setSubscribed(false);
    } catch(e) {
      console.error('[push] unsubscribe error:', e);
    }
    setLoading(false);
  }, []);

  return { supported, permission, subscribed, loading, subscribe, unsubscribe };
}

// Converte VAPID public key de base64url para Uint8Array
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64  = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw     = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
