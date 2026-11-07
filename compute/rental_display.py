"""English display adapter; numerical planning and question identities stay unchanged."""
import re


def english_result(result, advisor):
    if result.get('action') == 'ask':
        key = result['question_key']
        result['question_text'] = {
            'needs.pets': 'Do you need a home that accepts pets?',
            'needs.furnished': 'Do you need a furnished home?',
            'needs.parking': 'Do you need a parking space?',
            'commute_to': 'Where do you usually travel for work or study?',
            'budget_stretch': 'Would you consider up to 10% above your budget for a better match?',
            'station_walk_max_m': 'What is your maximum estimated walking distance to a station?',
        }.get(key, result['question_text'])
        labels = {'yes': 'Yes', 'no': 'No', 'skip': 'Skip for now', 'none': 'No fixed destination',
                  'no_limit': 'No distance limit', 'strict': 'Keep my budget', 'stretch': 'Allow up to 10% more',
                  'CBD': 'CBD / Town Hall', 'UTS': 'UTS / Broadway', 'USYD': 'University of Sydney / Camperdown',
                  'UNSW': 'UNSW / Kensington'}
        for option in result['options']:
            if option['id'] in labels:
                option['label'] = labels[option['id']]
            elif re.search(r'\d+', option['id']):
                option['label'] = 'Up to ' + re.search(r'\d+', option['id']).group() + ' m'
    for item in result.get('recommendations', []):
        item['label'] = {'best': 'Best overall', 'cheapest': 'Lower rent', 'closest_station': 'Closer to a station',
                         'closest_commute': 'Closer to your destination', 'alternative': 'Alternative'}.get(item['role'], 'Alternative')
        parts = advisor.ranker.score_breakdown(advisor.state, advisor.by_id[item['listing_id']])
        reason = [f"Advertised ${item['weeklyRent']:.0f}/week"]
        gap = parts.get('gap_pct')
        if gap is not None and gap == gap:
            reason.append(f"{abs(gap):.0f}% {'below' if gap < 0 else 'above'} the model's asking-rent benchmark")
        unknown = parts.get('unknown_need_keys') or []
        if unknown:
            reason.append('Confirm with the agent: ' + ', '.join(unknown))
        item['reason'] = '. '.join(reason) + '.'
    if result.get('followup'):
        result['followup'] = ('No rentals in this snapshot match all confirmed requirements. You can change your requirements.'
                              if result['action'] == 'no_match' else 'Tell me any other requirements and I will update the search.')
