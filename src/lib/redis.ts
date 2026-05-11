// src/lib/redis.ts
//
// Centralised ioredis connection factory for Upstash + BullMQ.
//
// Why this exists:
//   Before this helper, four files (producer, queue worker, scheduler index,
//   scheduler worker) each constructed their own ioredis connection with
//   different options. None of them had TLS enabled explicitly. The
//   scheduler's two connections used HOST/PORT/PASSWORD without any TLS
//   option, which fails with Upstash (Upstash requires TLS for all clients).
//   The producer and queue worker used the REDIS_URL pattern, which only
//   enables TLS if the URL starts with `rediss://` — and silently doesn't
//   enable TLS otherwise.
//
//   This helper applies the Upstash-recommended ioredis configuration in
//   one place. All connection sites should use it.
//
// Upstash-specific options applied:
//   - `tls: {}`                — forces TLS regardless of URL scheme. Upstash
//                                requires TLS; without this, connections drop
//                                with ECONNRESET / EPIPE within seconds.
//   - `maxRetriesPerRequest: null` — required by BullMQ. Without it, idle
//                                workers time out their commands when the
//                                connection has been pooled.
//   - `enableReadyCheck: false`— Upstash's pseudo-Redis doesn't fully
//                                implement the READY check command; waiting
//                                for it adds ~5s to connection start.
//   - `family: 0`              — auto-detect IPv4/IPv6. Upstash uses IPv6 in
//                                some regions and IPv4 in others.
//   - `retryStrategy`          — exponential backoff capped at 3s, retries
//                                indefinitely (combined with reconnectOnError
//                                this gives us resilient reconnects).
//   - `reconnectOnError`       — return true on ECONNRESET/EPIPE/READONLY so
//                                ioredis automatically reconnects rather than
//                                leaving the connection dead.

import IORedis, { type Redis, type RedisOptions } from 'ioredis';
import { logger } from '../logger';

export interface RedisConnectionOpts {
  /** Pass either url, or host/port/password — not both. */
  url?:      string;
  host?:     string;
  port?:     number;
  password?: string;
  /** Optional label used in logs (e.g. "scheduler", "agent-jobs-worker"). */
  label?:    string;
  /** Per-call overrides on top of the Upstash defaults. */
  override?: Partial<RedisOptions>;
}

export function createRedisConnection(opts: RedisConnectionOpts = {}): Redis {
  const label = opts.label ?? 'redis';

  const base: RedisOptions = {
    // BullMQ requirement
    maxRetriesPerRequest: null,
    // Upstash recommendation
    enableReadyCheck: false,
    // IPv4/IPv6 auto-detect
    family: 0,
    // Upstash requires TLS. {} = use default Node TLS settings (sufficient
    // for Upstash; the server cert is signed by a well-known CA).
    tls: {},
    // Exponential backoff with 3s cap; retries indefinitely.
    retryStrategy: (attempt: number) => {
      const delay = Math.min(attempt * 100, 3000);
      if (attempt === 1 || attempt % 10 === 0) {
        logger.warn('redis_reconnecting', { label, attempt, delayMs: delay });
      }
      return delay;
    },
    // Auto-reconnect on the specific errors we see with Upstash.
    reconnectOnError: (err: Error) => {
      const msg = err.message.toLowerCase();
      const isTransient =
        msg.includes('readonly')   ||  // failover scenario
        msg.includes('econnreset') ||  // server-side close
        msg.includes('epipe')      ||  // local socket already dead
        msg.includes('etimedout');     // command timeout
      return isTransient;
    },
    ...opts.override,
  };

  const client = opts.url
    ? new IORedis(opts.url, base)
    : new IORedis({
        host:     opts.host,
        port:     opts.port,
        password: opts.password,
        ...base,
      });

  client.on('connect',      () => logger.info('redis_connect', { label }));
  client.on('ready',        () => logger.info('redis_ready', { label }));
  client.on('error',        (err) => logger.warn('redis_error', { label, err: err.message }));
  client.on('close',        () => logger.info('redis_close', { label }));
  client.on('reconnecting', () => logger.info('redis_reconnecting_event', { label }));
  client.on('end',          () => logger.info('redis_end', { label }));

  return client;
}
