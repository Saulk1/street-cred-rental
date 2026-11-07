import type { Calculation } from '../../shared/compute';

export const calculation: Calculation = {
  id: 'C1', calculator: 'rent_comparison', version: '1.0.0', title: 'Rent comparison', propertyId: 'GANSW1', computedAt: '2026-11-07T00:00:00.000Z',
  userInputs: [{ key: 'weekly_rent_aud', label: 'Proposed weekly rent', value: 750, unit: 'AUD/week', quote: '$750 per week', messageIndex: 0 },
    { key: 'reference_period', label: 'Historical listing rent period', value: 'week', unit: 'period', quote: 'The historical listing was weekly.', messageIndex: 0 }],
  apiInputs: [{ key: 'latest_rent', sourceId: 'S1', retrievedAt: '2026-11-07T00:00:00.000Z', coverage: 'Single latest historical rental observation.', data: { price: 720, type: 'For Rent', date: '2025-07-24' } }],
  metrics: [{ key: 'weekly_difference', label: 'Weekly difference', value: 30, unit: 'AUD/week' }],
  assumptions: ['The user confirmed the historical rent period as weekly.'], warnings: ['Historical asking rent; not a current rental valuation.'],
};
