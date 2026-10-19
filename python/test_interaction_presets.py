"""
test_interaction_presets.py — deterministic floors for the interaction layer.

Asserts each control type maps to a sane damped-oscillator preset, that aliases
resolve (fader->slider, vu->meter, display->screen, toggle->switch), that slider
axis is inferred from aspect ratio, and that static/unknown types yield None.
Pure stdlib.

Run:  .venv/Scripts/python.exe test_interaction_presets.py
"""
from __future__ import annotations

import sys

import interaction_presets as ip

_failures: list[str] = []
_passes = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global _passes
    if cond:
        _passes += 1
        print(f"  [PASS] {name}" + (f"  ({detail})" if detail else ""))
    else:
        _failures.append(name)
        print(f"  [FAIL] {name}" + (f"  ({detail})" if detail else ""))


def test_knob() -> None:
    print("\n[A] knob -> rotate spring")
    p = ip.preset_for("knob")
    check("A1 affordance rotate", p["affordance"] == "rotate", p["affordance"])
    check("A2 axis rotate", p["axis"] == "rotate")
    check("A3 spring keys", set(p["spring"]) == {"stiffness", "damping", "mass"})
    check("A4 has hover", p.get("hover", {}).get("scale", 0) > 1)
    check("A5 flagged type-default", p["source"] == "type-default")


def test_button() -> None:
    print("\n[B] button -> press")
    p = ip.preset_for("button")
    check("B1 affordance press", p["affordance"] == "press", p["affordance"])
    check("B2 tap scales down", p["tap"]["scale"] < 1, str(p["tap"]))


def test_slider_axis() -> None:
    print("\n[C] slider axis from aspect ratio")
    wide = ip.preset_for("slider", width=200, height=30)
    tall = ip.preset_for("slider", width=30, height=200)
    check("C1 wide -> x", wide["axis"] == "x", wide["axis"])
    check("C2 tall -> y", tall["axis"] == "y", tall["axis"])
    fader = ip.preset_for("fader", width=30, height=200)
    check("C3 fader alias -> slider/y", fader is not None and fader["axis"] == "y")


def test_aliases() -> None:
    print("\n[D] alias resolution")
    check("D1 vu -> meter", ip.preset_for("vu")["affordance"] == "value")
    check("D2 display -> screen", ip.preset_for("display")["affordance"] == "display")
    check("D3 toggle -> switch", ip.preset_for("toggle")["affordance"] == "toggle")
    check("D4 encoder -> knob", ip.preset_for("encoder")["affordance"] == "rotate")


def test_led_states() -> None:
    print("\n[E] led indicator states")
    p = ip.preset_for("led")
    check("E1 affordance indicate", p["affordance"] == "indicate")
    check("E2 on/off states", p["states"]["on"]["opacity"] > p["states"]["off"]["opacity"])


def test_static_and_unknown() -> None:
    print("\n[F] static + unknown -> None")
    check("F1 label -> None", ip.preset_for("label") is None)
    check("F2 decoration -> None", ip.preset_for("decoration") is None)
    check("F3 panel -> None", ip.preset_for("panel") is None)
    check("F4 unknown -> None", ip.preset_for("wormhole") is None)
    check("F5 None type -> None", ip.preset_for(None) is None)


def test_by_id() -> None:
    print("\n[G] presets_by_id")
    controls = [
        {"id": "k", "type": "knob", "rect": [0, 0, 40, 40]},
        {"id": "s", "type": "slider", "rect": [0, 0, 200, 20]},
        {"id": "lbl", "type": "label", "rect": [0, 0, 60, 12]},
    ]
    m = ip.presets_by_id(controls)
    check("G1 knob + slider keyed", set(m) == {"k", "s"}, str(set(m)))
    check("G2 slider axis x (wide)", m["s"]["axis"] == "x")


def main() -> int:
    print("=" * 60)
    print("INTERACTION PRESET GOLDEN FLOORS")
    print("=" * 60)
    for t in (test_knob, test_button, test_slider_axis, test_aliases,
              test_led_states, test_static_and_unknown, test_by_id):
        t()
    print("\n" + "=" * 60)
    total = _passes + len(_failures)
    print(f"{_passes}/{total} passed, {len(_failures)} failed")
    if _failures:
        print("FAILURES: " + ", ".join(_failures))
        print("SOME FLOORS BROKE")
        return 1
    print("ALL INTERACTION FLOORS HELD")
    return 0


if __name__ == "__main__":
    sys.exit(main())
