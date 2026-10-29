import { describe, it, expect, vi } from 'vitest';
import { SSEGateway } from '../sse-gateway';

function mockRes(): any {
  const handlers: Record<string, Function> = {};
  return {
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
    on: (ev: string, fn: Function) => { handlers[ev] = fn; },
    emit: (ev: string) => handlers[ev]?.(),
  };
}

describe('SSEGateway', () => {
  it('uses default cleanup events (pipeline:complete, pipeline:error)', () => {
    const gw = new SSEGateway();
    const res = mockRes();
    gw.attachStream('run-1', res);
    gw.emit('run-1', 'pipeline:complete', {});
    expect(res.end).toHaveBeenCalled();
  });

  it('uses default cleanup events (pipeline:error)', () => {
    const gw = new SSEGateway();
    const res = mockRes();
    gw.attachStream('run-1b', res);
    gw.emit('run-1b', 'pipeline:error', { err: 'x' });
    expect(res.end).toHaveBeenCalled();
  });

  it('uses custom cleanup events when provided', () => {
    const gw = new SSEGateway({ cleanupEvents: ['run:complete', 'run:error'] });
    const res = mockRes();
    gw.attachStream('run-2', res);
    // pipeline:complete should NOT cleanup with custom config
    gw.emit('run-2', 'pipeline:complete', {});
    expect(res.end).not.toHaveBeenCalled();
    // run:complete SHOULD cleanup
    gw.emit('run-2', 'run:complete', {});
    expect(res.end).toHaveBeenCalled();
  });

  it('buffers events when no stream attached, replays on attach', () => {
    const gw = new SSEGateway();
    gw.emit('run-3', 'step:start', { i: 1 });
    const res = mockRes();
    gw.attachStream('run-3', res);
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('step:start'));
  });

  it('does not cleanup on non-cleanup event', () => {
    const gw = new SSEGateway();
    const res = mockRes();
    gw.attachStream('run-4', res);
    gw.emit('run-4', 'step:complete', {});
    expect(res.end).not.toHaveBeenCalled();
  });

  it('custom checkpoint event for lastEvents tracking', () => {
    const gw = new SSEGateway({
      cleanupEvents: ['run:complete', 'run:error'],
      checkpointEvent: 'step:takeover',
    });
    // Emit checkpoint event with no stream — should be stored as lastEvent
    gw.emit('run-5', 'step:takeover', { step: 3 });
    const res = mockRes();
    gw.attachStream('run-5', res);
    // lastEvent should be replayed on attach
    expect(res.write).toHaveBeenCalledWith(expect.stringContaining('step:takeover'));
  });

  it('clears checkpoint lastEvent on checkpoint:resolved', () => {
    const gw = new SSEGateway();
    gw.emit('run-6', 'checkpoint:waiting', { checkpointNumber: 1 });
    gw.emit('run-6', 'checkpoint:resolved', { checkpointNumber: 1, action: 'approve' });
    const res = mockRes();
    gw.attachStream('run-6', res);
    expect(res.write).not.toHaveBeenCalledWith(expect.stringContaining('checkpoint:waiting'));
  });
});
