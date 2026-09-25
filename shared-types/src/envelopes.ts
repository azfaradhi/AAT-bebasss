import { HazardEvent } from './hazard-event';

export interface ErrorEnvelope {
  error: { code: string; message: string };
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'down';
  service: string;
  timestamp: string;
}

export interface HazardEventMessage {
  message_id: string;
  event_type: 'HazardEventCreated';
  version: 1;
  published_at: string; // ISO 8601
  correlation_id: string;
  payload: HazardEvent;
}
