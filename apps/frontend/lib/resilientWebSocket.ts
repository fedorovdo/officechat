import { expireAuthentication, onAuthenticationExpired } from "./session";

export type WebSocketConnectionStatus = "connected" | "disconnected" | "reconnecting";

type ResilientWebSocketOptions = {
  getUrl: () => string;
  onMessage: (event: MessageEvent<string>) => void;
  onStatusChange?: (status: WebSocketConnectionStatus) => void;
  onForbidden?: () => void;
  heartbeatIntervalMs?: number;
};

export type ResilientWebSocketConnection = (() => void) & {
  send: (payload: object) => boolean;
};

const reconnectDelays = [1000, 2000, 5000, 10000, 20000, 30000];

export function connectResilientWebSocket(options: ResilientWebSocketOptions) {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function cancelReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    cancelReconnect();
    stopHeartbeat();
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
      if (options.heartbeatIntervalMs) {
        stopHeartbeat();
        heartbeatTimer = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "heartbeat" }));
          }
        }, options.heartbeatIntervalMs);
      }
    };
    socket.onmessage = options.onMessage;
    socket.onerror = () => socket?.close();
    socket.onclose = (event) => {
      stopHeartbeat();
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

  const cleanup = (() => {
    unsubscribe();
    stop();
  }) as ResilientWebSocketConnection;
  cleanup.send = (payload: object) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  };
  return cleanup;
}
