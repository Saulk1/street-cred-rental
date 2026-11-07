import io
import json
import os
import time
import unittest
from unittest.mock import patch
from api.compute import process, handler
from compute.registry import ComputeError, Context, run
from compute.rental import export_advisor, restore_advisor, load_artifacts
from compute.world_model.advisor import RentalAdvisor
from compute.world_model.types import Listing
from compute.world_model.value_ranker import ValueRanker

TOKEN = 'dummy-compute-token-32-characters-long'

def payload(command=None, state=None, version=None):
    return {'calculator': 'rental_advisor', 'version': '1.0.0', 'command': command or {'operation':'start','text':'one bedroom budget $800 per week near UTS'},
            'state': state, 'artifactVersion': version, 'deadlineMs': time.time()*1000+8000}

class ComputeTests(unittest.TestCase):
    def test_real_planner_questions_survive_the_compute_boundary(self):
        listings = [Listing(listing_id='A', station_walk_m=300, weekly_rent=550, bedrooms=1,
                            supermarket_walk_min=5, extra={'fair_rent':700, 'features':{'pets':False, 'furnished':False}}),
                    Listing(listing_id='B', station_walk_m=300, weekly_rent=650, bedrooms=1,
                            supermarket_walk_min=5, extra={'fair_rent':700, 'features':{'pets':True, 'furnished':True}})]
        manifest = {'version':'a'*64, 'modelVersion':'fixture', 'collectedAt':'2026-11-07T00:00:00Z'}
        with patch('compute.rental.load_artifacts', return_value=(manifest, listings, ValueRanker('fixture'))):
            first = run(payload({'operation':'start', 'text':'Find a one-bedroom rental under $800 near UTS'}))
            self.assertEqual(first['state']['state']['bedrooms'], 1)
            self.assertEqual(first['result']['action'], 'ask')
            self.assertEqual(first['result']['question_key'], 'needs.furnished')
            self.assertEqual(first['result']['question_text'], 'Do you need a furnished home?')
            self.assertEqual(first['state']['pending']['diagnostics']['ask_threshold'], 3.0)
            resumed = run(payload({'operation':'resume'}, first['state'], first['artifactVersion']))
            self.assertEqual(resumed['result']['question_id'], first['result']['question_id'])
            second = run(payload({'operation':'answer', 'questionId':first['result']['question_id'], 'optionId':'skip'}, resumed['state'], first['artifactVersion']))
            self.assertEqual(second['result']['action'], 'ask')
            self.assertEqual(second['result']['question_key'], 'needs.pets')
            self.assertNotEqual(second['result']['question_id'], first['result']['question_id'])
            last = run(payload({'operation':'message', 'text':'skip'}, second['state'], first['artifactVersion']))
            self.assertEqual(last['result']['action'], 'recommend')
            self.assertEqual(len(last['state']['asked_keys']), 2)

    def test_real_planner_recommends_without_unnecessary_questions(self):
        listings = [Listing(listing_id='A', station_walk_m=100, weekly_rent=600, bedrooms=1,
                            supermarket_walk_min=5, extra={'fair_rent':700, 'features':{'pets':True, 'furnished':True, 'parking':True}})]
        manifest = {'version':'a'*64, 'modelVersion':'fixture', 'collectedAt':'2026-11-07T00:00:00Z'}
        with patch('compute.rental.load_artifacts', return_value=(manifest, listings, ValueRanker('fixture'))):
            result = run(payload())
            self.assertEqual(result['result']['action'], 'recommend')
            self.assertEqual(result['result']['reason_code'], 'no_question_worth_asking')
            self.assertEqual(result['state']['asked_keys'], [])

    def test_state_roundtrip_with_pending_question(self):
        listings = [Listing(listing_id='A',station_walk_m=300,weekly_rent=600,bedrooms=1,extra={'fair_rent':700,'features':{'pets':False}}),
                    Listing(listing_id='B',station_walk_m=1000,weekly_rent=650,bedrooms=1,extra={'fair_rent':700,'features':{'pets':True}})]
        ranker=ValueRanker('test')
        advisor=RentalAdvisor(listings,ranker)
        advisor.intake('budget 800')
        result=advisor.next()
        saved=json.loads(json.dumps(export_advisor(advisor)))
        restored=restore_advisor(saved,listings,ranker)
        self.assertEqual(export_advisor(restored),saved)
        self.assertEqual(restored.next(),advisor.next())
        if result['action']=='ask':
            q=result['question_id']; opt=result['options'][0]['id']
            self.assertEqual(advisor.answer(q,option_id=opt),restored.answer(q,option_id=opt))

    def test_private_artifacts_recommendations_and_followup(self):
        try: load_artifacts()
        except ComputeError: self.skipTest('Private artifacts not staged')
        result=run(payload())
        for home in result['result'].get('recommendations',[]):
            self.assertNotRegex(home['reason'], r'[\u4e00-\u9fff]')
        self.assertEqual(result['status'],'ok')
        self.assertIn(result['result']['action'],['ask','recommend'])
        next_result=run(payload({'operation':'resume'},result['state'],result['artifactVersion']))
        self.assertEqual(next_result['result']['provenance'],result['result']['provenance'])
        for home in result['result'].get('recommendations',[]):
            self.assertGreater(home['weeklyRent'],0)
            self.assertIn('stationWalkBand',home)
        with self.assertRaises(ComputeError): run(payload({'operation':'resume'},result['state'],'0'*64))

    def test_request_guards_and_removed_calculator(self):
        for change in [{'calculator':'rent_comparison'}, {'version':'bad'}, {'deadlineMs':1}, {'deadlineMs':float('nan')}, {'deadlineMs':True}, {'command':[]}, {'extra':1}]:
            with self.subTest(change=change),self.assertRaises(ComputeError): run({**payload(),**change})

    def test_auth_limits_and_safe_errors(self):
        with patch.dict(os.environ,{'COMPUTE_SERVICE_TOKEN':TOKEN}):
            self.assertEqual(process('GET','','application/json',b'{}')[0],405)
            self.assertEqual(process('POST','wrong','application/json',b'{}')[0],401)
            self.assertEqual(process('POST','Bearer '+TOKEN,'text/plain',b'{}')[0],400)
            self.assertEqual(process('POST','Bearer '+TOKEN,'application/json',b'x'*64001)[0],400)
            self.assertEqual(process('POST','Bearer '+TOKEN,'application/json',b'invalid')[0],400)
        with patch.dict(os.environ,{'COMPUTE_SERVICE_TOKEN':''}):
            self.assertEqual(process('POST','','application/json',b'{}')[0],503)

    def test_missing_artifacts_are_explicit(self):
        from pathlib import Path
        load_artifacts.cache_clear()
        with patch('compute.rental.ARTIFACTS',Path('/nonexistent/rental-test')):
            with self.assertRaises(ComputeError) as caught: load_artifacts()
            self.assertEqual(caught.exception.code,'unavailable')
        load_artifacts.cache_clear()

    def test_artifact_corruption_is_unavailable(self):
        import tempfile
        from pathlib import Path
        import hashlib
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)
            manifest={'schema':1,'collectedAt':'2026-11-07T00:00:00Z','modelVersion':'test',
                      'files':{'fair_rent_model.json':'0'*64,'for_rent_snapshot.json':'0'*64}}
            manifest['version']=hashlib.sha256(json.dumps(manifest,sort_keys=True).encode()).hexdigest()
            (path/'manifest.json').write_text(json.dumps(manifest))
            (path/'fair_rent_model.json').write_text('{}')
            load_artifacts.cache_clear()
            with patch('compute.rental.ARTIFACTS',path),self.assertRaises(ComputeError) as caught:
                load_artifacts()
            self.assertEqual(caught.exception.code,'unavailable')
        load_artifacts.cache_clear()
