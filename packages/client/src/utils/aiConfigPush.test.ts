import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAiConfigPusher } from './aiConfigPush';

afterEach(() => { vi.useRealTimers(); });

const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe('createAiConfigPusher', () => {
  it('retries with growing delays until it succeeds', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down')).mockResolvedValue(undefined);
    createAiConfigPusher().push(send, [1000, 3000]);
    await tick();
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('gives up after the last delay', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(new Error('down'));
    createAiConfigPusher().push(send, [100]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a newer push supersedes pending retries of the older one', async () => {
    vi.useFakeTimers();
    const p = createAiConfigPusher();
    const oldSend = vi.fn().mockRejectedValue(new Error('down'));
    const newSend = vi.fn().mockResolvedValue(undefined);
    p.push(oldSend, [1000]);
    await tick();
    p.push(newSend, [1000]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(oldSend).toHaveBeenCalledTimes(1);
    expect(newSend).toHaveBeenCalledTimes(1);
  });

  it('serializes calls: a queued older push is dropped and the order is preserved', async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const p = createAiConfigPusher();
    p.push(async () => { order.push('put:start'); await gate; order.push('put:end'); });
    await tick();
    p.push(async () => { order.push('stale'); });
    p.push(async () => { order.push('delete'); });
    release();
    await new Promise(r => setTimeout(r, 0));
    expect(order).toEqual(['put:start', 'put:end', 'delete']);
  });

  it('cancel stops retries', async () => {
    vi.useFakeTimers();
    const send = vi.fn().mockRejectedValue(new Error('down'));
    const cancel = createAiConfigPusher().push(send, [1000]);
    await tick();
    cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('flush pushes once, supersedes retries and propagates errors', async () => {
    vi.useFakeTimers();
    const p = createAiConfigPusher();
    const failing = vi.fn().mockRejectedValue(new Error('down'));
    p.push(failing, [1000]);
    await tick();
    const ok = vi.fn().mockResolvedValue(undefined);
    await p.flush(ok);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(failing).toHaveBeenCalledTimes(1);
    await expect(p.flush(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
  });
});
