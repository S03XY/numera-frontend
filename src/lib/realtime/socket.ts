import { io, type Socket } from 'socket.io-client';
import { API_BASE } from '@/lib/api/client';

/** Realtime event names, mirroring the backend's channel registry. */
export const RealtimeEvent = {
  Trade: 'trade',
  Price: 'price',
  MarketStatus: 'market_status',
  MarketCreated: 'market_created',
} as const;

export interface RealtimeMessage<T = unknown> {
  event: string;
  marketRef?: string;
  data: T;
  ts: number;
}

export interface PricePayload {
  prices: string[];
}

export interface TradePayload {
  side: 'BUY' | 'SELL' | 'BET';
  account: string;
  outcomeIndex: number;
  shares?: string;
  amount: string;
  fee?: string;
  priceWad: string;
  txHash: string;
  timestamp: string;
}

export interface MarketStatusPayload {
  status: 'RESOLVED' | 'INVALID';
  winningOutcomeId?: number;
}

let socket: Socket | null = null;

/**
 * Lazily-created shared socket.
 *
 * One connection serves the whole app; rooms scope what each component receives.
 * Socket.IO handles reconnection, but rooms are per-connection server-side, so
 * subscriptions MUST be re-sent after every reconnect — see `useMarketChannel`.
 */
export function getSocket(): Socket {
  if (!socket) {
    socket = io(API_BASE, {
      transports: ['websocket'],
      autoConnect: true,
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
    });
  }
  return socket;
}

/** Test seam: inject a fake socket, or reset between tests. */
export function __setSocket(next: Socket | null): void {
  socket = next;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
