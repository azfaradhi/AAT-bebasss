import { describe, expect, it } from 'vitest';
import { DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT, clampLimit, staleSourcesFor } from './canonical-store';

// These helpers are pure. The SQL itself needs a running PostgreSQL and is covered by the compose validation.
describe('staleSourcesFor', () => {
  it('limits SEISMIC responses to the BMKG source', () => {
    expect(staleSourcesFor('SEISMIC')).toEqual(['BMKG']);
  });

  it('limits VOLCANIC responses to the PVMBG source', () => {
    expect(staleSourcesFor('VOLCANIC')).toEqual(['PVMBG']);
  });

  it('considers every source when no hazard type is requested', () => {
    expect(staleSourcesFor()).toEqual(['BMKG', 'PVMBG']);
  });
});

describe('clampLimit', () => {
  it('uses the default when no limit is given', () => {
    expect(clampLimit()).toBe(DEFAULT_LIST_LIMIT);
  });

  it('caps the limit at the maximum', () => {
    expect(clampLimit(MAX_LIST_LIMIT * 10)).toBe(MAX_LIST_LIMIT);
  });

  it('never returns less than 1', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(-5)).toBe(1);
  });
});
