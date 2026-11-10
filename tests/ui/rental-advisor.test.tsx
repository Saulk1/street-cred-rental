import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { RentalAdvisorPanel } from '@/components/rental-advisor';
import type { RentalRecommendation, RentalReply } from '../../shared/rental';
import { rentalRecommendation } from '../fixtures/rental';

// Entirely invented homes.
const home = (extra: Partial<RentalRecommendation>): RentalRecommendation => ({ listing_id: 'A', role: 'best', label: 'Best overall', score: 1, score_gap: 0,
  reason: 'Invented reason.', price_check: false, address: '1 Example Street', district: 'Example suburb', weeklyRent: 700, fairRent: 750,
  stationWalkM: 400, stationWalkBand: [350, 500], supermarketWalkMin: 4, unknownFeatures: [], ...extra });
const reply = (recommendations: RentalRecommendation[]): RentalReply => ({ revision: 2, result: { ...rentalRecommendation.result, recommendations } });
const show = (recommendations: RentalRecommendation[], busy = false) => {
  const act = vi.fn();
  render(<RentalAdvisorPanel reply={reply(recommendations)} busy={busy} act={act} />);
  return act;
};

it('states how each home compares with its fair asking rent', () => {
  show([home({}), home({ listing_id: 'B', address: '2 Example Street', weeklyRent: 760, fairRent: 730 }),
    home({ listing_id: 'C', address: '3 Example Street', weeklyRent: 752, fairRent: 750 })]);
  expect(screen.getByRole('img', { name: '$50 below the estimated fair asking rent of $750' })).toBeVisible();
  expect(screen.getByRole('img', { name: '$30 above the estimated fair asking rent of $730' })).toBeVisible();
  expect(screen.getByRole('img', { name: 'In line with the estimated fair asking rent of $750' })).toBeVisible();
});

it('keeps an extreme discount on the scale and flags the price', () => {
  show([home({ weeklyRent: 300, fairRent: 900, price_check: true })]);
  const gauge = screen.getByRole('img', { name: '$600 below the estimated fair asking rent of $900' });
  expect((gauge.lastElementChild as HTMLElement).style.insetInlineStart).toBe('0%');
  expect(screen.getByText('Check this price')).toBeVisible();
});

it('shows missing values as unavailable rather than zero', () => {
  show([home({ fairRent: null, stationWalkM: null, stationWalkBand: [null, null], supermarketWalkMin: null })]);
  expect(screen.getByText('No fair asking rent estimate for this home.')).toBeVisible();
  expect(screen.getAllByText('Unavailable')).toHaveLength(2);
  expect(screen.queryByRole('img')).toBeNull();
});

it('draws the station walk with its range', () => {
  show([home({})]);
  expect(screen.getByRole('img', { name: 'Estimated station walk: About 400 m, likely 350–500 m' })).toBeVisible();
});

it('says what each alternative trades against the first home', () => {
  show([home({}), home({ listing_id: 'B', role: 'cheapest', label: 'Lower rent', address: '2 Example Street', weeklyRent: 560, stationWalkM: 1100, stationWalkBand: [950, 1340] })]);
  const first = screen.getByRole('group', { name: '1 Example Street' });
  const second = screen.getByRole('group', { name: '2 Example Street' });
  expect(within(second).getByText('$140 less per week than the first home')).toBeVisible();
  expect(within(second).getByText('700 m further from a station')).toBeVisible();
  expect(within(first).queryByText(/than the first home/)).toBeNull();
});

it('lists only requirements a renter may need to confirm', () => {
  show([home({ unknownFeatures: ['pets', 'gym', 'parking', 'dishwasher'] })]);
  expect(screen.getByText('Pet policy')).toBeVisible();
  expect(screen.getByText('Parking')).toBeVisible();
  expect(screen.queryByText(/gym|dishwasher/i)).toBeNull();
});

it('sends preference, rejection and written feedback', async () => {
  const user = userEvent.setup();
  const act = show([home({}), home({ listing_id: 'B', address: '2 Example Street' })]);
  await user.click(screen.getByRole('button', { name: 'Prefer this home: 2 Example Street' }));
  await user.click(screen.getByRole('button', { name: 'Reject this home: 1 Example Street' }));
  await user.type(screen.getByRole('textbox', { name: 'What should we change?' }), 'Too far from the station{Enter}');
  expect(act.mock.calls.map(([command]) => command)).toEqual([
    { operation: 'feedback', chosenId: 'B' }, { operation: 'feedback', rejectedIds: ['A'] },
    { operation: 'feedback', reasons: ['Too far from the station'] }]);
});

it('disables every action while busy', () => {
  show([home({})], true);
  for (const button of screen.getAllByRole('button').filter(item => item.textContent !== 'Model, sources and limitations')) expect(button).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'What should we change?' })).toBeDisabled();
});
