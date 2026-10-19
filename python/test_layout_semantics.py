"""
test_layout_semantics.py — deterministic floors for the semantic layout layer.

Synthetic panels with a KNOWN logical structure (a 4x2 knob grid, a single row,
a single column, a nested group panel, shared-edge alignment). If the geometry
inference drifts, the wrong tree/arrangement fails loudly. Pure + free (no brain,
no OpenCV), so it runs in the fast core suite.

Run:  .venv/Scripts/python.exe test_layout_semantics.py
"""
from __future__ import annotations

import sys

import layout_semantics as ls

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


def ctl(cid: str, x: int, y: int, w: int, h: int, t: str = "knob") -> dict:
    return {"id": cid, "type": t, "rect": [x, y, w, h]}


def _find(node: dict, cid: str):
    if node.get("id") == cid:
        return node
    for ch in node.get("children", []):
        hit = _find(ch, cid)
        if hit:
            return hit
    return None


# ── A. a 4x2 evenly-spaced grid of knobs ──────────────────────────────────────
def test_grid() -> None:
    print("\n[A] 4x2 knob grid")
    controls = []
    # 4 columns x 2 rows, 40px knobs, 30px gaps -> pitch 70.
    for r in range(2):
        for c in range(4):
            controls.append(ctl(f"k{r}{c}", 20 + c * 70, 20 + r * 70, 40, 40))
    sem = ls.analyze_layout(controls, 320, 180)
    root = sem["tree"]
    hint = root.get("layout", {})
    check("A1 grid detected", hint.get("display") == "grid", f"display={hint.get('display')}")
    check("A2 rows=2", hint.get("rows") == 2, f"rows={hint.get('rows')}")
    check("A3 cols=4", hint.get("cols") == 4, f"cols={hint.get('cols')}")
    check("A4 col_gap ~30", hint.get("col_gap") is not None and abs(hint["col_gap"] - 30) <= 2,
          f"col_gap={hint.get('col_gap')}")
    check("A5 all 8 are roots", len(root.get("children", [])) == 8,
          f"children={len(root.get('children', []))}")


# ── B. a single horizontal row ────────────────────────────────────────────────
def test_row() -> None:
    print("\n[B] single row of 3 sliders")
    controls = [ctl("s0", 10, 100, 30, 30, "slider"),
                ctl("s1", 60, 100, 30, 30, "slider"),
                ctl("s2", 110, 100, 30, 30, "slider")]
    sem = ls.analyze_layout(controls, 200, 200)
    hint = sem["tree"].get("layout", {})
    check("B1 flex row", hint.get("display") == "flex" and hint.get("direction") == "row",
          f"{hint.get('display')}/{hint.get('direction')}")
    check("B2 gap ~20", hint.get("gap") is not None and abs(hint["gap"] - 20) <= 2,
          f"gap={hint.get('gap')}")
    check("B3 align center (shared middle_y)", hint.get("align_items") in ("center", "flex-start"),
          f"align={hint.get('align_items')}")


# ── C. a single vertical column ───────────────────────────────────────────────
def test_column() -> None:
    print("\n[C] single column of 3 buttons")
    controls = [ctl("b0", 50, 10, 40, 20, "button"),
                ctl("b1", 50, 50, 40, 20, "button"),
                ctl("b2", 50, 90, 40, 20, "button")]
    sem = ls.analyze_layout(controls, 200, 200)
    hint = sem["tree"].get("layout", {})
    check("C1 flex column", hint.get("display") == "flex" and hint.get("direction") == "column",
          f"{hint.get('display')}/{hint.get('direction')}")
    check("C2 gap ~20", hint.get("gap") is not None and abs(hint["gap"] - 20) <= 2,
          f"gap={hint.get('gap')}")


# ── D. containment: a group panel nesting 3 knobs ─────────────────────────────
def test_nesting() -> None:
    print("\n[D] group panel containing 3 knobs")
    controls = [
        ctl("group", 10, 10, 200, 80, "panel"),
        ctl("g0", 20, 30, 30, 30),
        ctl("g1", 90, 30, 30, 30),
        ctl("g2", 160, 30, 30, 30),
        ctl("loose", 10, 150, 40, 40),  # outside the group
    ]
    sem = ls.analyze_layout(controls, 260, 220)
    root = sem["tree"]
    # root's direct children: the group + the loose knob = 2
    check("D1 root has 2 children", len(root.get("children", [])) == 2,
          f"children={len(root.get('children', []))}")
    grp = _find(root, "group")
    check("D2 group found in tree", grp is not None)
    check("D3 group nests 3 knobs", grp is not None and len(grp.get("children", [])) == 3,
          f"kids={len(grp.get('children', [])) if grp else 'n/a'}")
    check("D4 parent_of g1 == group", sem["parent_of"].get("g1") == "group",
          f"parent={sem['parent_of'].get('g1')}")
    check("D5 group is a row inside", grp is not None and grp.get("layout", {}).get("direction") == "row",
          f"dir={grp.get('layout', {}).get('direction') if grp else 'n/a'}")


# ── E. alignment guides: shared left edge ─────────────────────────────────────
def test_alignment() -> None:
    print("\n[E] shared-left-edge alignment guide")
    controls = [ctl("a0", 40, 10, 60, 20), ctl("a1", 40, 40, 80, 20), ctl("a2", 40, 70, 50, 20)]
    sem = ls.analyze_layout(controls, 200, 200)
    lefts = [g for g in sem["alignment_guides"] if g["kind"] == "left" and len(g["members"]) == 3]
    check("E1 left guide with all 3", len(lefts) == 1, f"guides={len(lefts)}")
    check("E2 guide position ~40", lefts and abs(lefts[0]["position"] - 40) <= 1,
          f"pos={lefts[0]['position'] if lefts else 'n/a'}")


# ── F. degenerate inputs never crash ──────────────────────────────────────────
def test_degenerate() -> None:
    print("\n[F] degenerate inputs")
    check("F1 empty controls", ls.analyze_layout([], 100, 100)["node_count"] == 0)
    one = ls.analyze_layout([ctl("x", 5, 5, 10, 10)], 100, 100)
    check("F2 single control -> no layout hint", "layout" not in one["tree"])
    zero = ls.analyze_layout([ctl("z", 5, 5, 0, 0)], 100, 100)
    check("F3 zero-size dropped", zero["node_count"] == 0)


def main() -> int:
    print("=" * 60)
    print("LAYOUT SEMANTICS GOLDEN FLOORS")
    print("=" * 60)
    for t in (test_grid, test_row, test_column, test_nesting, test_alignment, test_degenerate):
        t()
    print("\n" + "=" * 60)
    total = _passes + len(_failures)
    print(f"{_passes}/{total} passed, {len(_failures)} failed")
    if _failures:
        print("FAILURES: " + ", ".join(_failures))
        print("SOME FLOORS BROKE")
        return 1
    print("ALL SEMANTIC FLOORS HELD")
    return 0


if __name__ == "__main__":
    sys.exit(main())
