import { describe, expect, it } from 'vitest';
import { normalizeDigits, parseAmount } from '../src/utils/digits.util';

describe('digits util', () => {
  it('converts Bangla and other native digits to ASCII', () => {
    expect(normalizeDigits('চা ৫০')).toBe('চা 50');
    expect(normalizeDigits('রিকশা ১২০.৫০')).toBe('রিকশা 120.50');
    expect(normalizeDigits('चाय ४५')).toBe('चाय 45');
    expect(normalizeDigits('coffee 120')).toBe('coffee 120');
  });

  it('parses AI amounts in any digit script', () => {
    expect(parseAmount(50)).toBe(50);
    expect(parseAmount('৫০')).toBe(50);
    expect(parseAmount('৳১,২০০')).toBe(1200);
    expect(parseAmount('abc')).toBe(0);
    expect(parseAmount(undefined)).toBe(0);
  });
});
