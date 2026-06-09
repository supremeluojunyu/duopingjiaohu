import { MAX_RECONNECT_ATTEMPTS, RECONNECT_INTERVAL_MS } from '../config';
import { SignalingMessage } from '../types';

type MessageHandler = (msg: SignalingMessage) => void;

export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private onLatency?: (ms: number) => void;
  private onConnectionChange?: (connected: boolean) => void;
  private reconnectAttempts = 0;
  private shouldReconnect = false;
  private lastJoinPayload: Record<string, unknown> | null = null;

  constructor(private serverUrl: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = this.serverUrl.replace(/^http/, 'ws') + '/ws';
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.shouldReconnect = true;
        this.startPing();
        this.onConnectionChange?.(true);
        if (this.lastJoinPayload) {
          this.send({ type: 'join', payload: this.lastJoinPayload });
        }
        resolve();
      };

      this.ws.onerror = () => reject(new Error('WebSocket 连接失败'));

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
        if (this.shouldReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          this.reconnectAttempts++;
          setTimeout(() => this.connect().catch(() => {}), RECONNECT_INTERVAL_MS);
        }
      };
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.stopPing();
    this.ws?.close();
    this.ws = null;
  }

  setJoinPayload(payload: Record<string, unknown>): void {
    this.lastJoinPayload = payload;
  }

  send(msg: Omit<SignalingMessage, 'timestamp'>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ ...msg, timestamp: Date.now() }));
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

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      this.send({ type: 'ping', payload: {} });
    }, 3000);
  }

  private stopPing(): void {
    if (this.pingInterval) clearInterval(this.pingInterval);
    this.pingInterval = null;
  }
}
