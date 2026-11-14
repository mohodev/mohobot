import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAsync, useToggle, useDebouncedValue, useFiltered, useHashParam } from './hooks';

describe('shared hooks', () => {
  it('loads data and exposes an error path', async () => {
    const ok = renderHook(() => useAsync(async () => ({ value: 1 }), []));
    await act(async () => { await Promise.resolve(); });
    expect(ok.result.current.loading).toBe(false);
    expect(ok.result.current.data).toEqual({ value: 1 });

    const bad = renderHook(() => useAsync(async () => { throw new Error('boom'); }, []));
    await act(async () => { await Promise.resolve(); });
    expect(bad.result.current.error).toBe('boom');
  });

  it('toggles booleans with an optional explicit value', () => {
    const { result } = renderHook(() => useToggle());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
  });

  it('debounces values', async () => {
    const { result, rerender } = renderHook(({ value }) => useDebouncedValue(value, 10), { initialProps: { value: 'a' } });
    expect(result.current).toBe('a');
    rerender({ value: 'b' });
    expect(result.current).toBe('a');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(result.current).toBe('b');
  });

  it('filters a list by query', () => {
    const items = [{ id: '1', name: 'Alpha' }, { id: '2', name: 'Beta' }];
    const { result } = renderHook(() => useFiltered(items, 'alp', (item) => [item.name]));
    expect(result.current.map((item) => item.id)).toEqual(['1']);
  });

  it('tracks a hash parameter', () => {
    window.location.hash = '#/logs?level=warn';
    const { result } = renderHook(() => useHashParam('level', 'all'));
    expect(result.current[0]).toBe('warn');
    act(() => result.current[1]('error'));
    expect(window.location.hash).toContain('level=error');
  });
});
