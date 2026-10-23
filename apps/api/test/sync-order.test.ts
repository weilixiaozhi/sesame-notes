import { describe, expect, it } from 'vitest';

import { compareSyncVersion, normalizeClientTimestamp } from '../src/shared/sync-timestamps.js';

describe('同步 LWW 顺序', () => {
  it('先比较更新时间，相同时以 device_id 稳定决胜', () => {
    expect(
      compareSyncVersion(
        { updatedAt: new Date('2026-01-01T00:00:00.000Z'), deviceId: 'device-b' },
        { updatedAt: new Date('2026-01-01T00:00:00.000Z'), deviceId: 'device-a' },
      ),
    ).toBeGreaterThan(0);

    expect(
      compareSyncVersion(
        { updatedAt: new Date('2025-12-31T23:59:59.000Z'), deviceId: 'device-z' },
        { updatedAt: new Date('2026-01-01T00:00:00.000Z'), deviceId: 'device-a' },
      ),
    ).toBeLessThan(0);
  });

  it('把客户端未来时间限制在服务端当前时间后五秒', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(normalizeClientTimestamp('2030-01-01T00:00:00.000Z', now).toISOString()).toBe('2026-01-01T00:00:05.000Z');
  });

  it('拒绝无法解析的客户端时间', () => {
    expect(() => normalizeClientTimestamp('not-a-date', new Date())).toThrow('INVALID_TIMESTAMP');
  });
});
