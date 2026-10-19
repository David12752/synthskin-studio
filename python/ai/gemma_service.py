"""Gemma 4 local model service via Ollama.

Provides multimodal AI capabilities using Google's Gemma 4 model
running locally through Ollama. Supports:
- Image analysis and component description
- Design style suggestions based on detected components
- Smart naming for extracted assets
- Layout analysis and recommendations
"""
import base64
import json
import logging
from typing import Optional

import requests

logger = logging.getLogger(__name__)

# Ollama defaults
DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434"
# Gemma model names to look for (ordered by preference: newest/best first)
GEMMA_MODEL = "gemma4:latest"
GEMMA_FALLBACK_MODELS = [
    "gemma4:latest", "gemma4",
    "gemma3:4b", "gemma3:12b", "gemma3:27b",
    "gemma2:9b", "gemma2:2b",
]


def _strip_data_url(image_b64: str) -> str:
    """Strip data:image/... prefix if present, return raw base64."""
    if image_b64.startswith("data:"):
        return image_b64.split(",", 1)[1]
    return image_b64


class GemmaService:
    """Bridge to local Gemma model via Ollama REST API."""

    def __init__(self, ollama_url: str = DEFAULT_OLLAMA_URL):
        self.ollama_url = ollama_url.rstrip("/")
        self.model: Optional[str] = None
        self._available: Optional[bool] = None

    # ─── Availability ───

    def check_available(self) -> dict:
        """Check if Ollama is running and a Gemma model is available.

        Returns dict with: available, model, ollama_running, models_found
        """
        result = {
            "available": False,
            "model": None,
            "ollama_running": False,
            "models_found": [],
            "install_hint": (
                "Install Ollama from https://ollama.com then run: ollama pull gemma3:4b"
            ),
        }

        try:
            resp = requests.get(f"{self.ollama_url}/api/tags", timeout=3)
            if resp.status_code != 200:
                return result
            result["ollama_running"] = True

            data = resp.json()
            model_names = [m["name"] for m in data.get("models", [])]
            result["models_found"] = model_names

            # Find best available Gemma model
            for candidate in GEMMA_FALLBACK_MODELS:
                for name in model_names:
                    # Match by exact name or prefix (e.g. "gemma4:latest" matches "gemma4")
                    if name == candidate or name.startswith(candidate + ":") or candidate.startswith(name.split(":")[0]):
                        if name.startswith("gemma"):
                            self.model = name
                            self._available = True
                            result["available"] = True
                            result["model"] = name
                            return result

            # Exact match fallback
            for candidate in GEMMA_FALLBACK_MODELS:
                if candidate in model_names:
                    self.model = candidate
                    self._available = True
                    result["available"] = True
                    result["model"] = candidate
                    return result

            # Last resort: any gemma model at all
            for name in model_names:
                if "gemma" in name.lower():
                    self.model = name
                    self._available = True
                    result["available"] = True
                    result["model"] = name
                    return result

        except requests.ConnectionError:
            result["install_hint"] = (
                "Ollama is not running. Start it with: ollama serve"
            )
        except Exception as e:
            logger.warning(f"Gemma availability check failed: {e}")

        self._available = False
        return result

    @property
    def available(self) -> bool:
        if self._available is None:
            self.check_available()
        return self._available or False

    # ─── Core Generation ───

    def generate(self, prompt: str, image_b64: Optional[str] = None,
                 temperature: float = 0.7, max_tokens: int = 1024) -> str:
        """Send a prompt (optionally with image) to Gemma via Ollama.

        Args:
            prompt: Text prompt
            image_b64: Optional base64-encoded image (data URL or raw)
            temperature: Sampling temperature (0.0-2.0)
            max_tokens: Maximum response tokens

        Returns:
            Model response text
        """
        if not self.available:
            raise RuntimeError("Gemma model not available. Install Ollama and pull gemma3:4b")

        payload = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
        }

        if image_b64:
            payload["images"] = [_strip_data_url(image_b64)]

        try:
            resp = requests.post(
                f"{self.ollama_url}/api/generate",
                json=payload,
                timeout=120,
            )
            resp.raise_for_status()
            return resp.json().get("response", "")
        except requests.Timeout:
            raise RuntimeError("Gemma request timed out (120s). Try a smaller model or reduce max_tokens.")
        except requests.ConnectionError:
            self._available = False
            raise RuntimeError("Lost connection to Ollama. Is it still running?")
        except Exception as e:
            raise RuntimeError(f"Gemma generation failed: {e}")

    # ─── High-Level Features ───

    def analyze_panel(self, image_b64: str) -> dict:
        """Analyze a synth/plugin panel image and describe its components.

        Returns dict with: description, components[], style, layout, suggestions
        """
        prompt = """Analyze this audio plugin / synthesizer panel image. Respond ONLY with valid JSON (no markdown, no code fences).

{
  "description": "Brief description of the panel",
  "components": [
    {"type": "knob|slider|button|led|screen|meter|jack|label", "description": "what it controls", "position": "top-left|top-center|..."}
  ],
  "style": "modern|vintage|eurorack|minimal|other",
  "color_scheme": "dark|light|colorful|monochrome",
  "layout": "grid|freeform|sections|symmetric",
  "suggestions": ["improvement suggestion 1", "suggestion 2"]
}"""
        raw = self.generate(prompt, image_b64, temperature=0.3, max_tokens=2048)
        return _parse_json_response(raw, fallback={
            "description": raw[:200],
            "components": [],
            "style": "unknown",
            "color_scheme": "unknown",
            "layout": "unknown",
            "suggestions": [],
        })

    def suggest_style(self, image_b64: str, detections: list) -> dict:
        """Given detected components, suggest a cohesive design style.

        Returns dict with: style, palette, fonts, materials, reasoning
        """
        det_summary = ", ".join(
            f"{d.get('type', '?')} ({d.get('confidence', 0):.0%})"
            for d in detections[:15]
        )
        prompt = f"""I have a synthesizer panel with these detected components: {det_summary}

Look at the image and suggest a cohesive design style. Respond ONLY with valid JSON (no markdown, no code fences).

{{
  "style": "style name",
  "palette": {{"bg": "#hex", "accent": "#hex", "text": "#hex", "knob": "#hex"}},
  "fonts": ["font name 1", "font name 2"],
  "materials": {{"panel": "brushed-metal|painted|wood|plastic", "knobs": "aluminum|bakelite|rubber|plastic"}},
  "reasoning": "why this style fits"
}}"""
        raw = self.generate(prompt, image_b64, temperature=0.5, max_tokens=1024)
        return _parse_json_response(raw, fallback={
            "style": "modern",
            "palette": {"bg": "#1a1a2e", "accent": "#e94560", "text": "#eaeaea", "knob": "#333"},
            "fonts": ["Inter", "JetBrains Mono"],
            "materials": {"panel": "brushed-metal", "knobs": "aluminum"},
            "reasoning": raw[:200],
        })

    def name_component(self, image_b64: str, component_type: str) -> dict:
        """Suggest a meaningful name and description for an extracted component.

        Returns dict with: name, description, suggested_type, parameter_hint
        """
        prompt = f"""This is an extracted {component_type} from a synthesizer/audio plugin. 
Look at it and suggest what it controls. Respond ONLY with valid JSON (no markdown, no code fences).

{{
  "name": "short_snake_case_name",
  "description": "What this {component_type} likely controls",
  "suggested_type": "knob|slider|button|switch|led|screen|meter",
  "parameter_hint": "e.g. cutoff_freq, resonance, volume, attack"
}}"""
        raw = self.generate(prompt, image_b64, temperature=0.4, max_tokens=256)
        return _parse_json_response(raw, fallback={
            "name": f"{component_type}_{id(image_b64) % 1000:03d}",
            "description": f"Extracted {component_type}",
            "suggested_type": component_type,
            "parameter_hint": "",
        })

    def describe_layout(self, image_b64: str) -> dict:
        """Analyze the overall layout and grid structure of a panel.

        Returns dict with: grid, sections[], alignment, spacing
        """
        prompt = """Analyze the layout of this synthesizer/audio plugin panel.
Identify grid structure, sections, alignment patterns, and spacing. Respond ONLY with valid JSON (no markdown, no code fences).

{
  "grid": {"rows": 0, "cols": 0, "regular": true},
  "sections": [
    {"name": "section name", "position": "top|middle|bottom", "components": "what's in it"}
  ],
  "alignment": "grid-aligned|freeform|mixed",
  "spacing": "tight|regular|loose",
  "symmetry": "horizontal|vertical|none|approximate",
  "recommendations": ["layout improvement 1"]
}"""
        raw = self.generate(prompt, image_b64, temperature=0.3, max_tokens=1024)
        return _parse_json_response(raw, fallback={
            "grid": {"rows": 0, "cols": 0, "regular": False},
            "sections": [],
            "alignment": "unknown",
            "spacing": "unknown",
            "symmetry": "unknown",
            "recommendations": [],
        })

    def enhance_detections(self, image_b64: str, detections: list) -> list:
        """Use Gemma's vision to refine/correct detection results.

        Takes raw CV detections and returns improved classifications.
        """
        det_json = json.dumps([{
            "id": d["id"],
            "type": d["type"],
            "confidence": d["confidence"],
            "bounds": d["bounds"],
        } for d in detections[:20]], indent=None)

        prompt = f"""These components were auto-detected in this synthesizer panel image using computer vision.
Some classifications may be wrong. Look at the image and correct them.

Current detections:
{det_json}

Respond ONLY with valid JSON array (no markdown, no code fences). Keep the same IDs.
For each detection, provide corrected type and a name:
[
  {{"id": "det_xxx", "type": "corrected_type", "name": "descriptive_name", "confidence": 0.9}}
]"""
        raw = self.generate(prompt, image_b64, temperature=0.3, max_tokens=2048)
        corrections = _parse_json_response(raw, fallback=[])
        if not isinstance(corrections, list):
            return detections

        # Merge corrections back into detections
        corrections_map = {c["id"]: c for c in corrections if isinstance(c, dict) and "id" in c}
        enhanced = []
        for det in detections:
            d = dict(det)
            if d["id"] in corrections_map:
                corr = corrections_map[d["id"]]
                if "type" in corr:
                    d["type"] = corr["type"]
                if "name" in corr:
                    d["ai_name"] = corr["name"]
                if "confidence" in corr:
                    d["ai_confidence"] = corr["confidence"]
            enhanced.append(d)
        return enhanced


# ─── Utilities ───

def _parse_json_response(raw: str, fallback):
    """Try to parse JSON from model output, with fallback."""
    # Strip markdown code fences if present
    text = raw.strip()
    if text.startswith("```"):
        # Remove first and last lines (fences)
        lines = text.split("\n")
        text = "\n".join(lines[1:-1] if lines[-1].strip() == "```" else lines[1:])
        text = text.strip()

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Try to extract JSON from the response
        for start_char, end_char in [("{", "}"), ("[", "]")]:
            start = text.find(start_char)
            end = text.rfind(end_char)
            if start != -1 and end > start:
                try:
                    return json.loads(text[start:end + 1])
                except json.JSONDecodeError:
                    continue
        logger.warning(f"Failed to parse Gemma JSON response: {text[:200]}")
        return fallback


# Singleton instance
_gemma_service = GemmaService()


def get_gemma_service() -> GemmaService:
    return _gemma_service


def check_gemma_available() -> dict:
    return _gemma_service.check_available()
