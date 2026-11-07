import type { RentalReply } from '../../shared/rental';
// Entirely invented data for boundary and interface tests.
const provenance = { snapshotDate: '2026-11-07T01:10:58Z', artifactVersion: 'a'.repeat(64), modelVersion: 'fixture-v1', advisorVersion: '1.0.0' };
export const rentalQuestion: RentalReply = { revision: 1, result: { action: 'ask', reason_code: 'highest_expected_regret',
  question_id: 'q-001', question_key: 'needs.pets', question_text: 'Do you need a pet-friendly home?',
  options: [{id:'yes',label:'Yes, I have pets'},{id:'no',label:'No pets'},{id:'skip',label:'Skip for now'}],
  provenance, warnings: ['Invented listing snapshot; check availability.'] } };
export const rentalRecommendation: RentalReply = { revision: 2, result: { action:'recommend', reason_code:'no_question_worth_asking',
  recommendations:[{ listing_id:'GANSWFIXTURE',role:'best',label:'Best overall',score:1,score_gap:0,reason:'Example tradeoff. Pet policy needs confirmation.',price_check:true,
    address:'1 Example Street',district:'Example suburb',weeklyRent:700,fairRent:750,stationWalkM:400,stationWalkBand:[350,500],supermarketWalkMin:4,unknownFeatures:['pets'] }],
  followup:'Tell me any other requirements.',provenance,warnings:['Fair rent estimates asking rent, not lease prices.','Walking distances are estimates.'] } };
