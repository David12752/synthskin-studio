import sys, json, urllib.request
sys.path.insert(0, '.')
import panel_pipeline as pp
key = pp._GEMINI_API_KEY
print('KEY prefix:', key[:12] if key else 'EMPTY')
if not key:
    print('No key found')
    sys.exit(1)
url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + key
req = urllib.request.Request(url)
try:
    with urllib.request.urlopen(req, timeout=10) as r:
        data = json.loads(r.read())
    gmodels = [m['name'] for m in data.get('models', []) if 'generateContent' in m.get('supportedGenerationMethods', [])]
    print('Available models with generateContent:')
    for m in gmodels:
        print(' ', m)
except Exception as e:
    print('Error:', e)
