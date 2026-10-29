import { EventEmitter } from 'events';
import type { Response } from 'express';

const HEARTBEAT_INTERVAL = 15_000;

interface SseStream {
  res: Response;
  heartbeat: ReturnType<typeof setInterval>;
}

export interface SSEGatewayOptions {
  /** Events that trigger stream cleanup (close SSE connection). Defaults to ai-test-gen's pipeline events. */
  cleanupEvents?: string[];
  /** Event whose latest payload is cached for late-attaching clients (e.g. checkpoint:waiting). Defaults to 'checkpoint:waiting'. */
  checkpointEvent?: string;
}

export class SSEGateway {
  private readonly emitters = new Map<string, EventEmitter>();
  private readonly streams = new Map<string, Set<SseStream>>();
  private readonly eventBuffers = new Map<string, Array<{ event: string; data: unknown }>>();
  private readonly bufferTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastEvents = new Map<string, { event: string; data: unknown }>();

  private readonly cleanupEvents: Set<string>;
  private readonly checkpointEvent: string | null;

  constructor(options: SSEGatewayOptions = {}) {
    this.cleanupEvents = new Set(options.cleanupEvents ?? ['pipeline:complete', 'pipeline:error']);
    this.checkpointEvent = options.checkpointEvent !== undefined ? options.checkpointEvent : 'checkpoint:waiting';
  }

  private isCleanupEvent(event: string): boolean {
    return this.cleanupEvents.has(event);
  }

  getEmitter(runId: string): EventEmitter {
    let ee = this.emitters.get(runId);
    if (!ee) {
      ee = new EventEmitter();
      ee.setMaxListeners(100);
      this.emitters.set(runId, ee);
    }
    return ee;
  }

  emit(runId: string, event: string, data: unknown): void {
    if (this.checkpointEvent && event === this.checkpointEvent) {
      this.lastEvents.set(runId, { event, data });
    }
    if (this.isCleanupEvent(event) || event === 'checkpoint:resolved') {
      this.lastEvents.delete(runId);
      const buf = this.eventBuffers.get(runId);
      if (buf) {
        this.eventBuffers.set(runId, buf.filter(e => e.event !== 'checkpoint:waiting'));
      }
    }

    const emitter = this.getEmitter(runId);
    if (emitter.listenerCount('sse') === 0) {
      let buf = this.eventBuffers.get(runId);
      if (!buf) {
        buf = [];
        this.eventBuffers.set(runId, buf);
      }
      if (buf.length >= 100) buf.shift();
      buf.push({ event, data });
    } else {
      emitter.emit('sse', event, data);
    }
  }

  attachStream(runId: string, res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const emitter = this.getEmitter(runId);

    let cleaned = false;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const streamObj: SseStream = { res, heartbeat: null as any };

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      emitter.off('sse', onSse);
      if (heartbeat) clearInterval(heartbeat);
      res.end();
      const streamSet = this.streams.get(runId);
      if (streamSet) {
        streamSet.delete(streamObj);
        if (streamSet.size === 0) this.streams.delete(runId);
      }
    };

    const onSse = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      if (this.isCleanupEvent(event)) {
        cleanup();
      }
    };

    emitter.on('sse', onSse);

    const buffer = this.eventBuffers.get(runId);
    if (buffer) {
      this.eventBuffers.delete(runId);
      const timer = this.bufferTimers.get(runId);
      if (timer) {
        clearTimeout(timer);
        this.bufferTimers.delete(runId);
      }
      for (const { event, data } of buffer) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        if (this.isCleanupEvent(event)) {
          cleanup();
          return;
        }
      }
    } else {
      const last = this.lastEvents.get(runId);
      if (last) {
        res.write(`event: ${last.event}\ndata: ${JSON.stringify(last.data)}\n\n`);
      }
    }

    heartbeat = setInterval(() => {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ ts: Date.now() })}\n\n`);
    }, HEARTBEAT_INTERVAL);
    streamObj.heartbeat = heartbeat;

    let streamSet = this.streams.get(runId);
    if (!streamSet) {
      streamSet = new Set();
      this.streams.set(runId, streamSet);
    }
    streamSet.add(streamObj);

    reqOnClose(res, cleanup);
  }

  cleanup(runId: string): void {
    const streamSet = this.streams.get(runId);
    if (streamSet) {
      for (const stream of streamSet) {
        stream.res.end();
        if (stream.heartbeat) clearInterval(stream.heartbeat);
      }
      this.streams.delete(runId);
    }
    this.emitters.delete(runId);
    if (this.eventBuffers.has(runId) && !this.bufferTimers.has(runId)) {
      const timer = setTimeout(() => {
        this.eventBuffers.delete(runId);
        this.bufferTimers.delete(runId);
      }, 300_000).unref();
      this.bufferTimers.set(runId, timer);
    }
  }
}

function reqOnClose(res: Response, fn: () => void): void {
  res.on('close', fn);
}
