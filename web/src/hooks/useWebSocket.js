import { useEffect, useRef } from 'react';

// WebSocket 自动重连 hook。onMessage 用 ref 包裹,避免重连副作用反复触发。
export function useWebSocket(onMessage) {
  const handlerRef = useRef(onMessage);
  handlerRef.current = onMessage;

  useEffect(() => {
    let ws = null;
    let closed = false;
    let retry = null;

    function connect() {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      ws = new WebSocket(`${protocol}//${location.host}/ws`);
      ws.onmessage = (ev) => {
        try { handlerRef.current(JSON.parse(ev.data)); } catch (e) {}
      };
      ws.onclose = () => { if (!closed) retry = setTimeout(connect, 3000); };
      ws.onerror = () => ws.close();
    }
    connect();

    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      if (ws) { ws.onclose = null; ws.close(); }
    };
  }, []);
}
