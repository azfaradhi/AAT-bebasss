import type { FastifyInstance } from 'fastify';
import { FieldReportStore, fieldReportsProvider } from '../../../../shared-types/src/field-reports';
import type { AuditProviders, StorageClient } from '../../../../shared-types/src/m2/types';
import type { MapperVersion } from '../mapping/volcanic-schema';
import { unprocessedProvider, registerUnprocessedRoutes } from './audit-unprocessed';
import { createIngestContext, type IngestContext } from './context';
import { storageClientWriter, type HazardWriter } from './hazard-writer';
import { registerReplayRoute } from './replay-route';

export interface IngestWiringOptions {
  storage: StorageClient;
  internalServiceKey: string;
  mapperVersion?: MapperVersion;
  fence?: () => number;
  env?: NodeJS.ProcessEnv;
  // Pass the same context the BMKG/PVMBG clients use so they park into the store the Audit route reads.
  ingest?: IngestContext;
}

export interface IngestWiring {
  ingest: IngestContext;
  writer: HazardWriter;
  fieldReports: FieldReportStore;
  // Pass to registerAudit({ providers }) so /internal/audit/unprocessed is served by the Audit router.
  providers: Pick<AuditProviders, 'unprocessed' | 'fieldReports'>;
}

// Mounts Member 1's internal routes on the aggregator app over whichever StorageClient it runs with.
export function mountIngest(app: FastifyInstance, opts: IngestWiringOptions): IngestWiring {
  const env = opts.env ?? process.env;
  const ingest = opts.ingest ?? createIngestContext({ storage: opts.storage, env, fence: opts.fence });
  const writer = storageClientWriter(opts.storage, ingest);
  const mapperVersion = opts.mapperVersion ?? (env.VOLCANIC_MAPPER_VERSION === 'v2' ? 'v2' : 'v1');
  registerReplayRoute(app, { ingest, writer, mapperVersion }, opts.internalServiceKey);
  registerUnprocessedRoutes(app, { parker: ingest.parker, auditToken: '', internalServiceKey: opts.internalServiceKey, auditRoute: false });
  const fieldReports = new FieldReportStore(opts.storage);
  return { ingest, writer, fieldReports, providers: { unprocessed: unprocessedProvider(ingest.parker), fieldReports: fieldReportsProvider(fieldReports) } };
}
