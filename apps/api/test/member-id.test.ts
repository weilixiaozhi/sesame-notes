import { describe, expect, it } from 'vitest';

import { registeredMemberId } from '../src/modules/accounting/index.js';
import { uuidV5 } from '../src/shared/uuid.js';

describe('uuidV5', () => {
  it('RFC 4122 已知向量：DNS 命名空间 + www.example.com', () => {
    const dnsNamespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(uuidV5(dnsNamespace, 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });

  it('不同账本/不同账号产出不同 id', () => {
    const l1 = '11111111-1111-4111-8111-111111111111';
    const l2 = '22222222-2222-4222-8222-222222222222';
    const ids = new Set([registeredMemberId(l1, 'u-1'), registeredMemberId(l2, 'u-1'), registeredMemberId(l1, 'u-2')]);
    expect(ids.size).toBe(3);
  });

  it('golden 值（与 Dart/PostgreSQL 对齐）：固定输入必须产出固定 id', () => {
    const ledgerId = '11111111-1111-4111-8111-111111111111';
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(registeredMemberId(ledgerId, userId)).toBe('056cf10d-2d59-599c-9d97-6749e866aa52');
    expect(uuidV5(ledgerId, 'self:device-1234')).toBe('9a65b5ae-b52e-5280-85af-99f0ffdf2a1b');
  });

  it('canonicalization：userId 大小写不敏感（大写输入产出同一 id）', () => {
    const ledgerId = '11111111-1111-4111-8111-111111111111';
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    expect(registeredMemberId(ledgerId, userId.toUpperCase())).toBe(registeredMemberId(ledgerId, userId));
  });
});
