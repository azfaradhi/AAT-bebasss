import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AuditProviders, StorageClient } from '../../../../shared-types/src/m2/types';
import type { HazardSource } from '../../../../shared-types/src/m2/types';

export interface RegisterAuditOptions {
  storage: StorageClient;
  providers?: Partial<AuditProviders>;
  auditToken?: string;
}

const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
};

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({
    error: {
      code,
      message,
    },
  });
}

export function registerAudit(app: FastifyInstance, options: RegisterAuditOptions): void {
  const { storage, providers = {}, auditToken = process.env.AUDIT_TOKEN || 'changeme-audit-token' } = options;

  // Bearer token verification hook for /internal/audit/*
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/internal/audit')) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return sendError(reply, 401, ERROR_CODES.UNAUTHORIZED, 'Missing Authorization header');
    }

    const [scheme, token] = authHeader.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token) {
      return sendError(reply, 401, ERROR_CODES.UNAUTHORIZED, 'Invalid Authorization header format. Expected Bearer <token>');
    }

    if (token !== auditToken) {
      return sendError(reply, 403, ERROR_CODES.FORBIDDEN, 'Invalid audit token');
    }
  });

  // GET /internal/audit/events
  app.get('/internal/audit/events', async (request: FastifyRequest<{
    Querystring: {
      source?: HazardSource;
      since?: string;
      limit?: string;
      cursor?: string;
    };
  }>, reply: FastifyReply) => {
    try {
      const { source, since, limit: rawLimit, cursor } = request.query;
      const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 100;
      if (isNaN(limit) || limit < 1) {
        return sendError(reply, 400, ERROR_CODES.BAD_REQUEST, 'Invalid limit parameter');
      }

      const res = await storage.listEvents({
        source,
        since,
        limit,
        cursor,
      });

      return reply.send(res);
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error?.name === 'StorageUnavailableError') {
        return sendError(reply, 503, ERROR_CODES.SERVICE_UNAVAILABLE, error.message || 'Storage unavailable');
      }
      return sendError(reply, 500, 'INTERNAL_SERVER_ERROR', (err as Error)?.message || 'Internal server error');
    }
  });

  // GET /internal/audit/checksum
  app.get('/internal/audit/checksum', async (request: FastifyRequest<{
    Querystring: {
      source: HazardSource;
    };
  }>, reply: FastifyReply) => {
    const { source } = request.query;
    if (!source) {
      return sendError(reply, 400, ERROR_CODES.BAD_REQUEST, 'Missing required query parameter: source');
    }

    const validSources: HazardSource[] = ['BMKG', 'PVMBG', 'SATELIT', 'SENSOR_PANTAI'];
    if (!validSources.includes(source)) {
      return sendError(reply, 400, ERROR_CODES.BAD_REQUEST, `Invalid source parameter. Must be one of: ${validSources.join(', ')}`);
    }

    try {
      const res = await storage.checksum(source);
      return reply.send({
        source,
        algorithm: 'sha256',
        ...res,
      });
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error?.name === 'StorageUnavailableError') {
        return sendError(reply, 503, ERROR_CODES.SERVICE_UNAVAILABLE, error.message || 'Storage unavailable');
      }
      return sendError(reply, 500, 'INTERNAL_SERVER_ERROR', (err as Error)?.message || 'Internal server error');
    }
  });

  // GET /internal/audit/location
  app.get('/internal/audit/location', async (request: FastifyRequest<{
    Querystring: {
      hazard_id: string;
    };
  }>, reply: FastifyReply) => {
    const { hazard_id } = request.query;
    if (!hazard_id) {
      return sendError(reply, 400, ERROR_CODES.BAD_REQUEST, 'Missing required query parameter: hazard_id');
    }

    try {
      const res = await storage.locate(hazard_id);
      if (!res || !res.locations || res.locations.length === 0) {
        return sendError(reply, 404, ERROR_CODES.NOT_FOUND, `Hazard event not found: ${hazard_id}`);
      }

      return reply.send({
        hazard_id,
        ...res,
      });
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error?.name === 'StorageUnavailableError') {
        return sendError(reply, 503, ERROR_CODES.SERVICE_UNAVAILABLE, error.message || 'Storage unavailable');
      }
      return sendError(reply, 500, 'INTERNAL_SERVER_ERROR', (err as Error)?.message || 'Internal server error');
    }
  });

  // GET /internal/audit/ring
  app.get('/internal/audit/ring', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const ring = await storage.ringStatus();
      return reply.send(ring);
    } catch (err: unknown) {
      const error = err as { name?: string; message?: string };
      if (error?.name === 'StorageUnavailableError') {
        return sendError(reply, 503, ERROR_CODES.SERVICE_UNAVAILABLE, error.message || 'Storage unavailable');
      }
      return sendError(reply, 500, 'INTERNAL_SERVER_ERROR', (err as Error)?.message || 'Internal server error');
    }
  });

  // GET /internal/audit/unprocessed (Provided by Member 1)
  app.get('/internal/audit/unprocessed', async (request: FastifyRequest<{
    Querystring: {
      source?: HazardSource;
      limit?: string;
      cursor?: string;
    };
  }>, reply: FastifyReply) => {
    if (!providers.unprocessed) {
      return reply.send({ items: [], next_cursor: null });
    }
    try {
      const { source, limit: rawLimit, cursor } = request.query;
      const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 100;
      if (isNaN(limit) || limit < 1) {
        return sendError(reply, 400, ERROR_CODES.BAD_REQUEST, 'Invalid limit parameter');
      }
      const res = await providers.unprocessed({
        source,
        limit,
        cursor,
      });
      return reply.send(res);
    } catch (err: unknown) {
      return sendError(reply, 500, 'INTERNAL_SERVER_ERROR', (err as Error)?.message || 'Failed to list unprocessed messages');
    }
  });

  // GET /internal/audit/field-reports (Provided by Member 1)
  app.get('/internal/audit/field-reports', async (request: FastifyRequest<{
    Querystring: {
      limit?: string;
      cursor?: string;
    };
  }>, reply: FastifyReply) => {
    if (!providers.fieldReports) {
      return reply.send({
        accepted_total: 0,
        processed_total: 0,
        duplicates_dropped_total: 0,
        unprocessed_keys: [],
        next_cursor: null,
      });
    }
    try {
      const { limit: rawLimit, cursor } = request.query;
      const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 100;
      if (isNaN(limit) || limit < 1) {
        return sendError(reply, 400, ERROR_CODES.BAD_REQUEST, 'Invalid limit parameter');
      }
      const res = await providers.fieldReports({ limit, cursor });
      return reply.send(res);
    } catch (err: unknown) {
      return sendError(reply, 500, 'INTERNAL_SERVER_ERROR', (err as Error)?.message || 'Failed to list field reports audit');
    }
  });

  // GET /internal/audit/critical-deliveries (Provided by Member 3)
  app.get('/internal/audit/critical-deliveries', async (request: FastifyRequest<{
    Querystring: {
      limit?: string;
      cursor?: string;
    };
  }>, reply: FastifyReply) => {
    if (!providers.criticalDeliveries) {
      return reply.send({
        items: [],
        total: 0,
        p95_seconds: 0,
        next_cursor: null,
      });
    }
    try {
      const { limit: rawLimit, cursor } = request.query;
      const limit = rawLimit !== undefined ? parseInt(rawLimit, 10) : 100;
      if (isNaN(limit) || limit < 1) {
        return sendError(reply, 400, ERROR_CODES.BAD_REQUEST, 'Invalid limit parameter');
      }
      const res = await providers.criticalDeliveries({ limit, cursor });
      return reply.send(res);
    } catch (err: unknown) {
      return sendError(reply, 500, 'INTERNAL_SERVER_ERROR', (err as Error)?.message || 'Failed to list critical deliveries');
    }
  });
}
