import { describe, it, expect } from 'vitest';
import { PriorityAdmissionController } from './admission';

describe('PriorityAdmissionController (P5-K5)', () => {
  it('sheds media first and preserves reserved capacity for lapangan', () => {
    const ctrl = new PriorityAdmissionController({
      maxInflight: 4,
      lapanganReserved: 2,
      mediaMaxInflight: 1,
      retryAfterSeconds: 3,
    });

    expect(ctrl.admit('media').admitted).toBe(true);
    expect(ctrl.admit('media').admitted).toBe(false);

    expect(ctrl.admit('internal').admitted).toBe(true);
    expect(ctrl.admit('internal').admitted).toBe(false);

    expect(ctrl.admit('lapangan').admitted).toBe(true);
    expect(ctrl.admit('lapangan').admitted).toBe(true);
  });
});
