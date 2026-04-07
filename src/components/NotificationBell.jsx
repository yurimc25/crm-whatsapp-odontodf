// src/components/NotificationBell.jsx
import { usePushNotifications } from '../hooks/usePushNotifications';

const T = {
  sub: '#8e8e8e', text: '#ececec', green: '#4caf87',
  border: '#2d2d2d', yellow: '#c9a84c',
};

export function NotificationBell({ operator }) {
  const { supported, permission, subscribed, loading, subscribe, unsubscribe } = usePushNotifications(operator);

  if (!supported) return null;

  const title = subscribed
    ? 'Notificações ativas — clique para desativar'
    : permission === 'denied'
      ? 'Notificações bloqueadas no navegador'
      : 'Ativar notificações de mensagens';

  const color = subscribed ? T.green : permission === 'denied' ? '#e57373' : T.sub;

  return (
    <button
      onClick={subscribed ? unsubscribe : subscribe}
      disabled={loading || permission === 'denied'}
      title={title}
      style={{
        background: 'transparent', border: 'none', cursor: permission === 'denied' ? 'not-allowed' : 'pointer',
        color, padding: '4px 6px', borderRadius: 6, display: 'flex', alignItems: 'center',
        opacity: loading ? 0.5 : 1, transition: 'color .2s',
        position: 'relative',
      }}
      onMouseEnter={e => { if (!subscribed && permission !== 'denied') e.currentTarget.style.color = T.text; }}
      onMouseLeave={e => { e.currentTarget.style.color = color; }}
    >
      {subscribed ? (
        // Sino cheio = ativo
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
        </svg>
      ) : (
        // Sino vazio = inativo
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
          {permission === 'denied' && <line x1="1" y1="1" x2="23" y2="23"/>}
        </svg>
      )}
      {/* Indicador de status */}
      {subscribed && (
        <span style={{
          position: 'absolute', top: 2, right: 2,
          width: 6, height: 6, borderRadius: '50%',
          background: T.green, border: '1px solid #1a1a1a',
        }} />
      )}
    </button>
  );
}
