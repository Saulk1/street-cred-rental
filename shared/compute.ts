export type CalculationMetric = { key: string; label: string; value: number; unit: string };
export type CalculationInput = { key: string; label: string; value: number | string; unit: string; quote: string; messageIndex: number };
export type CalculationDataset = {
  key: string; sourceId: string; retrievedAt: string; coverage: string;
  data: Record<string, string | number | boolean | null>;
};
export type Calculation = {
  id: string; calculator: string; version: string; title: string; propertyId: string; computedAt: string;
  userInputs: CalculationInput[]; apiInputs: CalculationDataset[];
  metrics: CalculationMetric[]; assumptions: string[]; warnings: string[];
};
export const object = (v: unknown): v is Record<string, any> => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 300): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const date = (v: unknown): v is string => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const metric = (v: unknown): v is CalculationMetric => object(v) && text(v.key, 80) && text(v.label) && finite(v.value) && text(v.unit, 40);
const userInput = (v: unknown): v is CalculationInput => object(v) && text(v.quote, 400)
  && Number.isInteger(v.messageIndex) && v.messageIndex >= 0 && v.messageIndex < 40
  && text(v.key, 80) && text(v.label) && text(v.unit, 40) && (finite(v.value) || text(v.value, 80));
export const textList = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 20 && v.every(s => text(s, 1000));

export function validCalculation(v: unknown): v is Calculation {
  return object(v) && /^C[1-6]$/.test(v.id) && text(v.calculator, 80) && /^[a-z][a-z0-9_]*$/.test(v.calculator)
    && text(v.version, 40) && text(v.title) && typeof v.propertyId === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(v.propertyId) && date(v.computedAt)
    && Array.isArray(v.metrics) && v.metrics.length > 0 && v.metrics.length <= 20 && v.metrics.every(metric)
    && Array.isArray(v.userInputs) && v.userInputs.length <= 20 && v.userInputs.every(userInput)
    && Array.isArray(v.apiInputs) && v.apiInputs.length <= 10 && v.apiInputs.every((d: unknown) => object(d)
      && text(d.key, 80) && typeof d.sourceId === 'string' && /^S\d{1,3}$/.test(d.sourceId) && date(d.retrievedAt) && text(d.coverage, 1000)
      && object(d.data) && Object.keys(d.data).length <= 30 && Object.values(d.data).every(x => x === null || typeof x === 'boolean' || finite(x) || (typeof x === 'string' && x.length <= 1000)))
    && textList(v.assumptions) && textList(v.warnings) && JSON.stringify(v).length <= 24000;
}
