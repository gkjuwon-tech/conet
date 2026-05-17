import json, sys
d = json.load(open(sys.argv[1]))
for x in d['devices']:
    if x['ip'].startswith(('224.', '239.')):
        continue
    print(f"  {x['ip']:18} {x['inferred_type']:12} {x['vendor']:25} ports={x['open_ports']} vec={x['suggested_vector']} status={x.get('claim_status','?')}")
