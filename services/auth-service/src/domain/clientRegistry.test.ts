import { describe, expect, it } from 'vitest';
import { TEST_CLIENTS } from '../test-helpers';
import { ClientRegistry } from './clientRegistry';

const registry = new ClientRegistry(TEST_CLIENTS);

describe('ClientRegistry', () => {
  it('authenticates a valid pair and returns its scope', () => {
    expect(registry.authenticate('media-client', 'media-secret')?.scope).toBe('media');
  });
  it('rejects wrong secret, unknown id and empty-length mismatches', () => {
    expect(registry.authenticate('media-client', 'nope')).toBeUndefined();
    expect(registry.authenticate('ghost', 'media-secret')).toBeUndefined();
    expect(registry.authenticate('media-client', '')).toBeUndefined();
  });
});
