import { describe, expect, it } from 'vitest';

import { registeredMemberId } from '../src/modules/accounting/index.js';
import { uuidV5 } from '../src/shared/uuid.js';

describe('uuidV5', () => {
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
