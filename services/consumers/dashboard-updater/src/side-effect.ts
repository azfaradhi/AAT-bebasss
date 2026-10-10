import type { HazardEvent } from '../../../../shared-types/src/hazard-event';
import type { Logger } from './logger';

export type SideEffect = (event: HazardEvent) => Promise<void>;

export function createDashboardSideEffect(logger: Logger): SideEffect {
  return async (event) => {
    logger.info(
      { hazard_id: event.hazard_id, severity: event.severity, area_name: event.area_name },
      'dashboard updated with hazard event',
    );
  };
}
