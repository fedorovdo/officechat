import { expireAuthentication, onAuthenticationExpired } from "./session";

export type WebSocketConnectionStatus = "connected" | "disconnected" | "reconnecting";

type ResilientWebSocketOptions = {
  getUrl: () => string;
  onMessage: (event: MessageEvent<string>) => void;
  onStatusChange?: (status: WebSocketConnectionStatus) => void;
  onForbidden?: () => void;
};

const reconnectDelays = [1000, 2000, 5000, 10000, 20000, 30000];

export function connectResilientWebSocket(options: ResilientWebSocketOptions) {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let stopped = false;

  function cancelReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelReconnect();
    const currentSocket = socket;
    socket = null;
    currentSocket?.close(1000, "Session ended");
    options.onStatusChange?.("disconnected");
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    const baseDelay = reconnectDelays[Math.min(reconnectAttempt, reconnectDelays.length - 1)];
    reconnectAttempt += 1;
    const jitteredDelay = Math.min(30000, Math.round(baseDelay * (0.85 + Math.random() * 0.3)));
    options.onStatusChange?.("reconnecting");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, jitteredDelay);
  }

  function connect() {
    if (stopped || socket) return;
    options.onStatusChange?.("reconnecting");
    socket = new WebSocket(options.getUrl());
    socket.onopen = () => {
      reconnectAttempt = 0;
      options.onStatusChange?.("connected");
    };
    socket.onmessage = options.onMessage;
    socket.onerror = () => socket?.close();
    socket.onclose = (event) => {
      socket = null;
      if (stopped) return;
      if (event.code === 4401) {
        stop();
        expireAuthentication("expired");
        return;
      }
      if (event.code === 4403 || event.code === 1008) {
        stop();
        options.onForbidden?.();
        return;
      }
      scheduleReconnect();
    };
  }

  const unsubscribe = onAuthenticationExpired(() => stop());
  connect();

  return () => {
    unsubscribe();
    stop();
  };
}
