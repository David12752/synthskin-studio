"""Diagnose the Gemini detection response: finishReason + token usage (proves
whether 'thinking' is eating the output budget) + raw text length/tail."""
import sys
import json
import base64
import urllib.request
import warnings

warnings.filterwarnings("ignore")

import cv2

import panel_pipeline as pp

path = sys.argv[1]
img = cv2.imread(path, cv2.IMREAD_COLOR)
h, w = img.shape[:2]
scale = min(1.0, 1536.0 / max(h, w, 1))
send = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else img
ok, buf = cv2.imencode(".jpeg", send, [cv2.IMWRITE_JPEG_QUALITY, 90])
img_b64 = base64.b64encode(buf.tobytes()).decode()

model = pp._probe_gemini_model()
print("model:", model)

prompt = (
    "Synthesizer/audio hardware panel. Detect controls and displays only. "
    "Allowed types: knob, slider, button, switch, led, screen. "
    'Return JSON array only: [{"box":[y_min,x_min,y_max,x_max],"type":"knob"}]. '
    "Coords 0-1000 with y_min first. Skip text labels, numeric scales, logos, screws, jack holes."
)

for label, gen_cfg in [
    ("thinkingBudget=0", {"temperature": 0, "maxOutputTokens": 32768, "thinkingConfig": {"thinkingBudget": 0}}),
    ("thinkingLevel=low", {"temperature": 0, "maxOutputTokens": 32768, "thinkingConfig": {"thinkingLevel": "low"}}),
]:
    payload = json.dumps({
        "contents": [{"parts": [
            {"inline_data": {"mime_type": "image/jpeg", "data": img_b64}},
            {"text": prompt},
        ]}],
        "generationConfig": gen_cfg,
    }).encode()
    url = f"{pp._GEMINI_URL}/{model}:generateContent?key={pp._GEMINI_API_KEY}"
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    print(f"\n=== {label} ===")
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            res = json.loads(r.read())
        cand = res.get("candidates", [{}])[0]
        finish = cand.get("finishReason")
        usage = res.get("usageMetadata", {})
        parts = cand.get("content", {}).get("parts", [{}])
        text = parts[0].get("text", "") if parts else ""
        print("finishReason:", finish)
        print("usage:", {k: usage.get(k) for k in (
            "promptTokenCount", "candidatesTokenCount", "thoughtsTokenCount", "totalTokenCount")})
        print("text len:", len(text), "| ends with ']':", text.rstrip().endswith("]"))
        print("tail:", repr(text[-160:]))
    except Exception as e:
        print("ERROR:", repr(e))
