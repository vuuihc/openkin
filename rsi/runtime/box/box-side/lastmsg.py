import json,sys
last=""
for l in open(sys.argv[1]):
    try: o=json.loads(l)
    except Exception: continue
    if o.get("type")=="result": last=o.get("result","")
print(last)
