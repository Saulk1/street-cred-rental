export type RentalContext = { token: string; revision: number };
export type RentalCommand = { operation: 'start' | 'resume' | 'message' | 'answer' | 'feedback' | 'end';
  text?: string; questionId?: string; optionId?: string; chosenId?: string; rejectedIds?: string[]; reasons?: string[] };
export type RentalRecommendation = { listing_id: string; role: string; label: string; score: number; score_gap: number;
  reason: string; price_check: boolean; address: string | null; district: string | null;
  weeklyRent: number; fairRent: number | null; stationWalkM: number | null; stationWalkBand: (number | null)[];
  supermarketWalkMin: number | null; unknownFeatures: string[] };
export type RentalResult = { action: 'ask' | 'recommend' | 'no_match' | 'needs_data' | 'fallback'; reason_code: string;
  question_id?: string; question_key?: string; question_text?: string; options?: { id: string; label: string }[];
  recommendations?: RentalRecommendation[]; followup?: string | null; message?: string;
  provenance: { snapshotDate: string; artifactVersion: string; modelVersion: string; advisorVersion: string }; warnings: string[] };
export type RentalReply = { revision: number; result: RentalResult };
export type RentalComputeReply = { status: 'ok'; calculator: 'rental_advisor'; version: '1.0.0';
  artifactVersion: string; state: Record<string, unknown>; result: RentalResult };
const record = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
const text = (v: any, max = 1000) => typeof v === 'string' && v.length > 0 && v.length <= max;
const number = (v: any) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const optionalNumber = (v: any) => v === null || number(v);
export function validRentalContext(v: any): v is RentalContext {
  return record(v) && /^[a-f0-9]{64}$/.test(v.token) && Number.isInteger(v.revision) && v.revision >= 0;
}
export function validRentalResult(v: any): v is RentalResult {
  return !!(record(v) && ['ask', 'recommend', 'no_match', 'needs_data', 'fallback'].includes(v.action)
    && text(v.reason_code, 100) && record(v.provenance) && text(v.provenance.snapshotDate, 40)
    && Number.isFinite(Date.parse(v.provenance.snapshotDate)) && /^[a-f0-9]{64}$/.test(v.provenance.artifactVersion)
    && text(v.provenance.modelVersion, 80) && text(v.provenance.advisorVersion, 80)
    && Array.isArray(v.warnings) && v.warnings.length <= 10 && v.warnings.every((s: any) => text(s))
    && (v.followup == null || text(v.followup)) && (v.message === undefined || text(v.message))
    && (v.action !== 'ask' || (text(v.question_id, 100) && text(v.question_key, 100) && text(v.question_text)
      && Array.isArray(v.options) && v.options.length > 0 && v.options.length <= 7
      && v.options.every((o: any) => record(o) && text(o.id, 80) && text(o.label, 300))
      && new Set(v.options.map((o: any) => o.id)).size === v.options.length))
    && (v.action !== 'recommend' || (Array.isArray(v.recommendations) && v.recommendations.length > 0))
    && (v.recommendations === undefined || (Array.isArray(v.recommendations) && v.recommendations.length <= 3
      && new Set(v.recommendations.map((r: any) => r.listing_id)).size === v.recommendations.length
      && v.recommendations.every((r: any) => record(r) && text(r.listing_id, 80) && /^[A-Za-z0-9_-]+$/.test(r.listing_id)
        && text(r.role, 80) && text(r.label, 100) && text(r.reason, 2000) && Number.isFinite(r.score) && number(r.score_gap)
        && typeof r.price_check === 'boolean' && (r.address === null || text(r.address)) && (r.district === null || text(r.district))
        && number(r.weeklyRent) && optionalNumber(r.fairRent) && optionalNumber(r.stationWalkM)
        && optionalNumber(r.supermarketWalkMin) && Array.isArray(r.stationWalkBand) && r.stationWalkBand.length === 2
        && r.stationWalkBand.every(optionalNumber) && Array.isArray(r.unknownFeatures) && r.unknownFeatures.length <= 20
        && r.unknownFeatures.every((s: any) => text(s, 80)))))
    && JSON.stringify(v).length <= 20000);
}
export function validRentalReply(v: any): v is RentalReply {
  return record(v) && Number.isInteger(v.revision) && v.revision > 0 && validRentalResult(v.result);
}
export function validRentalCommand(v: any): v is RentalCommand {
  if (!record(v)) return false;
  const fields: Record<string, string[]> = { start: ['operation', 'text'], message: ['operation', 'text'], resume: ['operation'],
    end: ['operation'], answer: ['operation', 'questionId', 'optionId', 'text'], feedback: ['operation', 'chosenId', 'rejectedIds', 'reasons'] };
  if (!fields[v.operation] || Object.keys(v).some(k => !fields[v.operation].includes(k))) return false;
  if (['start', 'message'].includes(v.operation)) return text(v.text, 4000);
  if (v.operation === 'answer') return text(v.questionId, 100) && (text(v.optionId, 80) !== text(v.text, 4000))
    && (v.optionId === undefined || text(v.optionId, 80)) && (v.text === undefined || text(v.text, 4000));
  if (v.operation === 'feedback') return (v.chosenId === undefined || text(v.chosenId, 80))
    && (v.rejectedIds === undefined || (Array.isArray(v.rejectedIds) && v.rejectedIds.length <= 3 && v.rejectedIds.every((s: any) => text(s, 80))))
    && (v.reasons === undefined || (Array.isArray(v.reasons) && v.reasons.length <= 5 && v.reasons.every((s: any) => text(s, 300))))
    && !!(v.chosenId || v.rejectedIds?.length || v.reasons?.length);
  return true;
}
