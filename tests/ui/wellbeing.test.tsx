import { expect, it } from 'vitest';
import { calculateWellbeing } from '../../src/lib/wellbeing';

const data = (values: unknown[]) => ({ area_name: 'Surry Hills (NSW)', area_level: 'suburb', scores: ['lifestyle', 'convenience', 'family', 'safety', 'tranquility'].map((key, index) => ({ key, value: values[index] })) });
it('equally weights the five specified dimensions and ignores unrelated scores', () => {
  const input = data([70, 80, 60, 90, 60]);
  input.scores.push({ key: 'affluence', value: 100 });
  expect(calculateWellbeing(input)).toMatchObject({ value: 72, available: 5, total: 5, area: 'Surry Hills (NSW)' });
});
it('keeps zeros, excludes missing/invalid inputs and requires three valid dimensions', () => {
  expect(calculateWellbeing(data([0, 100, 50, null, undefined]))).toMatchObject({ value: 50, available: 3 });
  expect(calculateWellbeing(data([0, 100, -1, NaN, 101]))).toMatchObject({ value: null, available: 2 });
  expect(calculateWellbeing(data([0, '100', Infinity, null, undefined]))).toMatchObject({ value: null, available: 1 });
});
it('rejects unscoped or address-level scores and treats duplicate dimensions as ambiguous', () => {
  expect(calculateWellbeing({ ...data([80, 80, 80, 80, 80]), area_level: 'property' }).value).toBeNull();
  expect(calculateWellbeing({ ...data([80, 80, 80, 80, 80]), area_name: '' }).value).toBeNull();
  const input = data([70, 80, 60]); input.scores.push({ key: 'lifestyle', value: 100 });
  expect(calculateWellbeing(input)).toMatchObject({ value: null, available: 2 });
});
it('rounds only the final average and handles malformed input', () => {
  expect(calculateWellbeing(data([0.4, 0.4, 1.4])).value).toBe(1);
  for (const input of [null, undefined, [], {}, { scores: [null, 4, 'invalid'] }]) expect(calculateWellbeing(input).value).toBeNull();
});
