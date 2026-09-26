import { describe, expect, it } from 'vitest';
import { SeenSet } from './dedup';

describe('SeenSet', () => {
  it('remembers ids', () => {
    const seen = new SeenSet();
    expect(seen.has('a')).toBe(false);
    seen.add('a');
    expect(seen.has('a')).toBe(true);
  });

  it('evicts the oldest id past its bound', () => {
    const seen = new SeenSet(2);
    seen.add('a');
    seen.add('b');
    seen.add('c');
    expect(seen.has('a')).toBe(false);
    expect(seen.has('b')).toBe(true);
    expect(seen.has('c')).toBe(true);
  });
});
