import { describe } from 'vitest';
import { coordinatorConformance, CoordHarness } from '../../test-support/contract-fakes/conformance/coordinator.conformance';
import { InMemoryCoordinator } from './in-memory-coordinator';
import { InMemoryStorage } from '../../test-support/contract-fakes/fakes/in-memory-storage';

describe('Aggregator InMemoryCoordinator', () => {
  const makeHarness = (): CoordHarness => {
    const storage = new InMemoryStorage();
    const coordinator = new InMemoryCoordinator(storage);
    return {
      coordinator,
      storage,
      failover: (name: string) => coordinator.failover(name),
    };
  };

  coordinatorConformance('InMemoryCoordinator', makeHarness);
});
