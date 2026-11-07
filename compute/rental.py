"""Bounded, deterministic advisor execution. Only Node supplies durable state."""
import dataclasses
import hashlib
import json
import re
from functools import lru_cache
from pathlib import Path

from .world_model.advisor import RentalAdvisor
from .world_model.fair_rent import FairRentModel
from .world_model.microburbs import listing_from_microburbs
from .world_model.value_ranker import ValueRanker
from .world_model.needs import extract_needs
from .world_model.types import UserState, StationWalkRequirement
from .world_model.questions import QuestionSpec, AnswerOption, Branch, MultiPlan, QuestionValue

VERSION = '1.0.0'
ARTIFACTS = Path(__file__).resolve().parent.parent / '.private' / 'rental'


@lru_cache(maxsize=1)
def load_artifacts():
    from .registry import ComputeError
    try:
        manifest = json.loads((ARTIFACTS / 'manifest.json').read_text())
        identity = {k: v for k, v in manifest.items() if k != 'version'}
        if manifest['schema'] != 1 or hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest() != manifest['version']:
            raise ValueError('manifest')
        data = {}
        for name in ['fair_rent_model.json', 'for_rent_snapshot.json']:
            raw = (ARTIFACTS / name).read_bytes()
            if hashlib.sha256(raw).hexdigest() != manifest['files'][name]:
                raise ValueError('hash')
            data[name] = json.loads(raw)
        snapshot = data['for_rent_snapshot.json']
        model = FairRentModel.from_json(json.dumps(data['fair_rent_model.json']))
        if model.version != manifest['modelVersion'] or snapshot['collected_at'] != manifest['collectedAt']:
            raise ValueError('metadata')
        listings = tuple(listing_from_microburbs(item['row'], item['enrichment'], model, snapshot['collected_at'])
                         for item in snapshot['listings'])
        ranker = ValueRanker('value-ranker-' + model.fingerprint()[:8], model_fingerprint=model.fingerprint())
        return manifest, listings, ranker
    except (OSError, ValueError, KeyError, TypeError):
        raise ComputeError('unavailable', 'Rental data is unavailable. Stage the private model and snapshot.') from None


def export_advisor(advisor):
    saved = {'schema': 1, 'state': advisor.state.to_dict(), 'version': advisor.version,
            'asked_keys': advisor.asked_keys, 'pending': dataclasses.asdict(advisor.pending['plan']) if advisor.pending else None,
            'pending_meta': {k: v for k, v in advisor.pending.items() if k not in ('spec', 'plan')} if advisor.pending else None,
            'last_shown': list(advisor.last_shown), 'question_seq': advisor._question_seq,
            'invalidated_counts': advisor._invalidated_counts, 'forced_question_key': advisor._forced_question_key, 'rejected_ids': getattr(advisor, '_rejected_ids', []), 'language': getattr(advisor, '_language', 'en')}
    return json.loads(json.dumps(saved, allow_nan=False))


def restore_advisor(saved, listings, ranker):
    advisor = RentalAdvisor(listings, ranker, suburbs=sorted({l.district for l in listings if l.district}))
    if saved is None:
        return advisor
    if saved['schema'] != 1:
        raise ValueError('state schema')
    state = dict(saved['state'])
    state['station_walk'] = StationWalkRequirement(**state['station_walk'])
    advisor.state = UserState(**state)
    advisor._language = saved.get('language', 'en')
    advisor._rejected_ids = list(saved.get('rejected_ids', []))
    advisor.listings = tuple(l for l in advisor.listings if l.listing_id not in advisor._rejected_ids)
    advisor.version = saved['version']
    advisor.asked_keys = list(saved['asked_keys'])
    advisor.last_shown = tuple(saved['last_shown'])
    advisor._question_seq = saved['question_seq']
    advisor._invalidated_counts = dict(saved['invalidated_counts'])
    advisor._forced_question_key = saved['forced_question_key']
    if saved['pending'] is not None:
        plan = dict(saved['pending'])
        spec = dict(plan['question'])
        spec['options'] = tuple(AnswerOption(**v) for v in spec['options'])
        spec['branches'] = tuple(Branch(**v) for v in spec['branches'])
        plan['question'] = QuestionSpec(**spec)
        plan['values'] = tuple(QuestionValue(**v) for v in plan['values'])
        advisor.pending = {**saved['pending_meta'], 'spec': plan['question'], 'plan': MultiPlan(**plan)}
    return advisor


def execute(command, saved, artifact_version, context):
    from .registry import ComputeError
    context.check_deadline()
    manifest, listings, ranker = load_artifacts()
    if artifact_version and artifact_version != manifest['version']:
        raise ComputeError('stale_snapshot', 'Rental data changed. Start a new rental search.')
    advisor = restore_advisor(saved, listings, ranker)
    if isinstance(command.get('text'), str):
        advisor._language = 'zh' if re.search(r'[\u4e00-\u9fff]', command['text']) else 'en'
    operation = command.get('operation')
    if operation in ('start', 'message'):
        text = command.get('text')
        if not isinstance(text, str) or not text.strip() or len(text) > 4000:
            raise ComputeError('validation', 'Supply a rental request of up to 4000 characters.')
        if operation == 'start':
            advisor.intake(text)
            result = advisor.next()
        elif advisor.pending:
            reply = advisor.answer(advisor.pending['question_id'], text=text)
            if reply['status'] in ('invalid_answer', 'stale_state'):
                if extract_needs(text, suburbs=advisor.suburbs).patch:
                    result = advisor.tell(text)['next']
                else:
                    result = {**advisor.next(), 'message': reply.get('message', 'Please answer the pending question or choose an option.')}
            else:
                result = reply['next']
        else:
            result = advisor.tell(text)['next']
    elif operation == 'answer':
        if not advisor.pending or command.get('questionId') != advisor.pending['question_id']:
            raise ComputeError('conflict', 'This rental question is no longer current.')
        reply = advisor.answer(command['questionId'], option_id=command.get('optionId'), text=command.get('text'))
        result = reply.get('next') or {**advisor.next(), 'message': reply.get('message', 'Choose a valid option or give a more specific answer.')}
    elif operation == 'feedback':
        shown = {v['listing_id'] for v in advisor.last_shown}
        chosen = command.get('chosenId')
        rejected = command.get('rejectedIds', [])
        if not shown or (chosen and chosen not in shown) or any(i not in shown for i in rejected):
            raise ComputeError('validation', 'Feedback must refer to the displayed recommendations.')
        advisor._rejected_ids = list(dict.fromkeys(getattr(advisor, '_rejected_ids', []) + rejected))
        advisor.listings = tuple(l for l in advisor.listings if l.listing_id not in advisor._rejected_ids)
        reply = advisor.feedback(chosen_id=chosen, rejected_ids=rejected, reasons=command.get('reasons', []))
        result = reply['next']
    elif operation == 'resume':
        result = advisor.next()
    else:
        raise ComputeError('validation', 'Unsupported rental operation.')
    # Send only display data, never the full listing collection or source descriptions.
    result = {k: v for k, v in result.items() if k != 'diagnostics'}
    for item in result.get('recommendations', []):
        listing = advisor.by_id[item['listing_id']]
        item.update(weeklyRent=listing.weekly_rent, fairRent=listing.extra.get('fair_rent'),
                    stationWalkM=listing.station_walk_m, stationWalkBand=list(listing.walk_band()),
                    supermarketWalkMin=listing.supermarket_walk_min,
                    unknownFeatures=[k for k, v in listing.extra.get('features', {}).items() if v is None])
    if getattr(advisor, '_language', 'en') == 'en':
        from .rental_display import english_result
        english_result(result, advisor)
    result['provenance'] = {'snapshotDate': manifest['collectedAt'], 'artifactVersion': manifest['version'],
                            'modelVersion': manifest['modelVersion'], 'advisorVersion': VERSION}
    result['warnings'] = ['Dated listing snapshot; availability must be checked.',
                          'Fair rent estimates asking rent, not an agreed lease price.',
                          'Walking distances are estimated from straight-line distances; commute distance is not travel time.',
                          'Unspecified features and pet policies require confirmation with the agent.']
    context.check_deadline()
    return {'status': 'ok', 'calculator': 'rental_advisor', 'version': VERSION, 'artifactVersion': manifest['version'],
            'state': export_advisor(advisor), 'result': result}
