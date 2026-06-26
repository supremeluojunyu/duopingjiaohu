import { LATENCY_PING_INTERVAL_MS, MAX_RECONNECT_ATTEMPTS, PING_INTERVAL_MS, RECONNECT_INTERVAL_MS } from '../config';
import { SignalingMessage } from '../types';

type MessageHandler = (msg: SignalingMessage) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private latencyPingInterval: ReturnType<typeof setInterval> | null = null;
  private onLatency?: (ms: number) => void;
  private onConnectionChange?: (connected: boolean) => void;
  private onReconnectExhausted?: () => void;
  private reconnectAttempts = 0;
  private shouldReconnect = false;
  private lastJoinPayload: Record<string, unknown> | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  constructor(private serverUrl: string) {}

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.shouldReconnect = true;
      this.openSocket();
    });

    return this.connectPromise;
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.connectPromise = null;
    this.connectResolve = null;
    this.connectReject = null;
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  setJoinPayload(payload: Record<string, unknown>): void {
    this.lastJoinPayload = payload;
  }

  send(msg: Omit<SignalingMessage, 'timestamp'>): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[Signaling] send 失败，WebSocket 未连接:', msg.type);
      return false;
    }
    this.ws.send(JSON.stringify({ ...msg, timestamp: Date.now() }));
    return true;
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  setLatencyCallback(cb: (ms: number) => void): void {
    this.onLatency = cb;
  }

  setConnectionCallback(cb: (connected: boolean) => void): void {
    this.onConnectionChange = cb;
  }

  setReconnectExhaustedCallback(cb: () => void): void {
    this.onReconnectExhausted = cb;
  }

  private openSocket(): void {
    const url = this.serverUrl.replace(/^http/, 'ws') + '/ws';
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.startPing();
      this.onConnectionChange?.(true);
      if (this.lastJoinPayload) {
        this.send({ type: 'join', payload: this.lastJoinPayload });
      }
      this.connectResolve?.();
      this.connectResolve = null;
      this.connectReject = null;
    };

    this.ws.onerror = () => {
      if (this.connectReject) {
        this.connectReject(new Error('WebSocket 连接失败'));
        this.connectReject = null;
        this.connectResolve = null;
        this.connectPromise = null;
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as SignalingMessage;
        if (msg.type === 'pong') {
          const sentAt = msg.payload.sentAt as number;
          this.onLatency?.(Date.now() - sentAt);
        }
        this.handlers.forEach((h) => h(msg));
      } catch {
        /* ignore */
      }
    };

    this.ws.onclose = () => {
      this.stopPing();
      this.onConnectionChange?.(false);
      if (this.shouldReconnect) {
        // 异常断开后重置，便于下次 connect() 获得新的 Promise
        this.connectPromise = null;
        this.connectResolve = null;
        this.connectReject = null;
        if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          const delay = RECONNECT_INTERVAL_MS * 2 ** this.reconnectAttempts;
          this.reconnectAttempts++;
          setTimeout(() => this.openSocket(), delay);
        } else {
          this.onReconnectExhausted?.();
        }
      }
    };
  }

  private startPing(): void {
    this.send({ type: 'ping', payload: {} });
    this.latencyPingInterval = setInterval(() => {
      this.send({ type: 'ping', payload: {} });
    }, LATENCY_PING_INTERVAL_MS);
    this.pingInterval = setInterval(() => {
      this.send({ type: 'ping', payload: {} });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.latencyPingInterval) clearInterval(this.latencyPingInterval);
    this.latencyPingInterval = null;
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = null;
  }
}
