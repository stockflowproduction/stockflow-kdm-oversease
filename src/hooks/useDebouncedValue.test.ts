import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleSearchUpdate } from './useDebouncedValue';

afterEach(() => vi.useRealTimers());

describe('search scheduling', () => {
  it('waits a full second after the last keystroke and cancels superseded queries', () => {
    vi.useFakeTimers();
    const request = vi.fn();
    const cancelFirst = scheduleSearchUpdate(() => request('ki'));
    vi.advanceTimersByTime(700);
    expect(request).not.toHaveBeenCalled();
    cancelFirst();
    scheduleSearchUpdate(() => request('kit'));
    vi.advanceTimersByTime(999);
    expect(request).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(request.mock.calls).toEqual([['kit']]);
  });

  it('cancels pending work when the input or page unmounts', () => {
    vi.useFakeTimers();
    const request = vi.fn();
    const cancel = scheduleSearchUpdate(request);
    cancel();
    vi.runAllTimers();
    expect(request).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
