import { storageConformance } from '../test-support/contract-fakes/conformance/storage.conformance';
import { makeCluster } from './cluster-harness';

storageConformance('HttpStorageClient over three in-process storage units', () => {
  const { client, controls } = makeCluster();
  return { client, controls };
});
