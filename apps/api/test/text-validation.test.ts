import { describe, expect, it } from 'vitest';
import { MAX_NAME_LENGTH, normalizeName } from '../src/shared/text-validation.js';
import { normalizeDayName } from '../src/modules/days/testing.js';
import { validateFitnessPayload } from '../src/modules/fitness/testing.js';
import { fitnessTemplate } from './fitness-fixtures.js';

describe('普通名称统一规则', () => {
  it('统一空白、可见性和 Unicode 码点上限，不按 UTF-16 截断表情', () => {
    expect(normalizeName('\u0085 \uFEFF家庭 🏠\u3000')).toBe('家庭 🏠');
    expect(normalizeName('🏠'.repeat(MAX_NAME_LENGTH))).toBe('🏠'.repeat(MAX_NAME_LENGTH));
    expect(() =>
      validateFitnessPayload('fitness_template', { ...fitnessTemplate(), name: '🏠'.repeat(MAX_NAME_LENGTH) }),
    ).not.toThrow();
    expect(normalizeDayName('  家庭  ')).toBe('家庭');
    for (const name of ['', ' \u0085', '\u200B', '\uFE0F', '\uD800', 'a\u0000b', '🏠'.repeat(MAX_NAME_LENGTH + 1)]) {
      expect(() => normalizeName(name)).toThrow();
      expect(() => normalizeDayName(name)).toThrow();
      expect(() => validateFitnessPayload('fitness_template', { ...fitnessTemplate(), name })).toThrow();
    }
  });
});
