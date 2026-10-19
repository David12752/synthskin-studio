"""
interaction_presets.py — attach default *interaction physics* per control type.

The static image tells us WHAT a control is and WHERE it sits, but not how it
should FEEL when a user grabs it. A knob should spin under the pointer with a bit
of inertia; a button should press in and spring back; a toggle should snap; a VU
meter's needle should swing with heavier, slower physics. None of that is visible
in a PNG — but it IS strongly implied by the control's *type*.

So this module maps control type -> a sensible interaction preset expressed as a
damped harmonic oscillator (Framer-Motion `spring`: stiffness k, damping c, mass
m), plus a hover/tap affordance and a rough CSS-transition fallback. A downstream
LLM can drop these straight into `whileHover` / `whileTap` / `transition` and get
motion that feels alive instead of guessing constants.

HONEST SCOPE: these are type-based DEFAULTS, not measurements. You cannot read a
spring constant off a static image. They are advisory and clearly flagged as
such (``source: "type-default"``). Pure stdlib.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

# Canonical types (src/types Asset) + detector aliases -> a normalized key.
_ALIASES = {
    "encoder": "knob",
    "fader": "slider",
    "vu": "meter", "vu_meter": "meter",
    "display": "screen",
    "toggle": "switch",
    "lamp": "led", "indicator": "led",
    "decoration": "static", "panel": "static", "label": "static", "jack": "static",
}

# Damped-harmonic-oscillator presets. stiffness=k, damping=c, mass=m.
# Higher k -> snappier; higher c -> less oscillation; higher m -> heavier/slower.
_PRESETS: Dict[str, Dict[str, Any]] = {
    "knob": {
        "affordance": "rotate", "axis": "rotate",
        "spring": {"stiffness": 400, "damping": 30, "mass": 0.8},
        "hover": {"scale": 1.03}, "tap": {"scale": 0.98},
        "css": "transform 140ms cubic-bezier(0.2,0.8,0.2,1)",
    },
    "slider": {
        "affordance": "drag", "axis": "y",  # refined by aspect ratio
        "spring": {"stiffness": 500, "damping": 34, "mass": 0.7},
        "hover": {"scale": 1.02}, "tap": None,
        "css": "transform 120ms cubic-bezier(0.2,0.8,0.2,1)",
    },
    "button": {
        "affordance": "press", "axis": None,
        "spring": {"stiffness": 600, "damping": 26, "mass": 0.5},
        "hover": {"scale": 1.04}, "tap": {"scale": 0.95},
        "css": "transform 90ms cubic-bezier(0.2,0.8,0.2,1)",
    },
    "switch": {
        "affordance": "toggle", "axis": None,
        "spring": {"stiffness": 700, "damping": 36, "mass": 0.5},
        "hover": {"scale": 1.03}, "tap": {"scale": 0.97},
        "css": "transform 110ms cubic-bezier(0.2,0.9,0.2,1)",
    },
    "led": {
        "affordance": "indicate", "axis": None,
        "spring": {"stiffness": 200, "damping": 20, "mass": 1.0},
        "hover": None, "tap": None,
        "states": {"on": {"opacity": 1.0}, "off": {"opacity": 0.25}},
        "css": "opacity 160ms ease-out",
    },
    "meter": {
        "affordance": "value", "axis": None,
        # Heavier + softer: a physical needle/bar swinging to a new value.
        "spring": {"stiffness": 120, "damping": 14, "mass": 1.2},
        "hover": None, "tap": None,
        "css": "transform 240ms cubic-bezier(0.33,1,0.68,1)",
    },
    "screen": {
        "affordance": "display", "axis": None,
        "spring": {"stiffness": 210, "damping": 24, "mass": 1.0},
        "hover": None, "tap": None,
        "css": "opacity 200ms ease-out",
    },
    "static": {
        "affordance": "none", "axis": None,
        "spring": None, "hover": None, "tap": None, "css": None,
    },
}


def _normalize(ctype: Optional[str]) -> Optional[str]:
    if not ctype:
        return None
    t = str(ctype).strip().lower()
    t = _ALIASES.get(t, t)
    return t if t in _PRESETS else None


def preset_for(
    ctype: Optional[str],
    *,
    width: Optional[float] = None,
    height: Optional[float] = None,
) -> Optional[Dict[str, Any]]:
    """Interaction preset for a control type, or None for unknown/static-none.

    For sliders the drag axis is refined from the rect aspect ratio (wider ->
    horizontal 'x', taller -> vertical 'y') since the type alone is ambiguous.
    """
    key = _normalize(ctype)
    if key is None:
        return None
    base = _PRESETS[key]
    if base["affordance"] == "none":
        return None
    out: Dict[str, Any] = {
        "model": "spring",  # damped harmonic oscillator
        "source": "type-default",
        "affordance": base["affordance"],
    }
    for k in ("axis", "spring", "hover", "tap", "css", "states"):
        if k in base and base[k] is not None:
            out[k] = base[k]
    if key == "slider" and width is not None and height is not None:
        out["axis"] = "x" if float(width) >= float(height) else "y"
    return out


def presets_by_id(controls: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Fit a preset to every control that has an interactive type -> {id: preset}."""
    out: Dict[str, Dict[str, Any]] = {}
    for c in controls:
        rect = c.get("rect")
        w = h = None
        if rect and len(rect) == 4:
            w, h = rect[2], rect[3]
        p = preset_for(c.get("type"), width=w, height=h)
        if p is not None:
            out[str(c.get("id"))] = p
    return out
