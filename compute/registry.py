"""Explicit compute operation registry; no dynamic imports or caller-supplied code."""
import json
import math
import time
from pathlib import Path

CATALOG = json.loads(Path(__file__).with_name('catalog.json').read_text())


class ComputeError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


class Context:
    def __init__(self, deadline_ms):
        self.deadline_ms = deadline_ms

    def check_deadline(self):
        if time.time() * 1000 >= self.deadline_ms:
            raise ComputeError('timeout', 'Calculation exceeded its deadline.')


def run(payload):
    from .rental import execute, VERSION
    if not isinstance(payload, dict) or set(payload) != {'calculator', 'version', 'command', 'state', 'artifactVersion', 'deadlineMs'}:
        raise ComputeError('validation', 'Invalid rental computation request.')
    if payload['calculator'] != 'rental_advisor':
        raise ComputeError('validation', 'Unknown calculator.')
    if payload['version'] != VERSION:
        raise ComputeError('version', 'Compute versions do not match. Redeploy both functions together.')
    deadline = payload['deadlineMs']
    if type(deadline) not in (int, float) or not math.isfinite(deadline) or deadline > time.time() * 1000 + 10000:
        raise ComputeError('validation', 'Invalid computation deadline.')
    if not isinstance(payload['command'], dict) or not (payload['state'] is None or isinstance(payload['state'], dict)):
        raise ComputeError('validation', 'Invalid rental command or state.')
    result = execute(payload['command'], payload['state'], payload['artifactVersion'], Context(deadline))
    json.dumps(result, allow_nan=False)
    return result
