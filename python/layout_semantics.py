"""
layout_semantics.py — turn a flat list of control rects into a *logical layout*.

The export manifest (layout_manifest.py, layout.json v1) tells a consumer WHERE
every control is in absolute pixels. That is enough to place sprites, but it is
NOT enough for an LLM to write good responsive React: absolute (x, y) says
nothing about *intent* — which controls form a row, which are aligned, what is
nested inside what, whether a block is a 4x2 grid of knobs or eight unrelated
dots.

This module recovers that intent with pure, deterministic computational geometry
(no solver library, no numpy — just boxes and tolerances):

  1. CONTAINMENT  -> a nesting tree (a knob group panel that *contains* eight
                    knobs becomes their parent). This is the "logical DOM".
  2. ALIGNMENT    -> shared left / right / centre / top / bottom / middle edges,
                    clustered within tolerance -> alignment guides.
  3. ARRANGEMENT  -> for each container, are its direct children one row, one
                    column, or an R x C grid? With the median gap between them.
  4. FLEX/GRID    -> a CSS-flavoured hint per container (display / direction /
                    gap / align-items / justify-content) so the LLM receives
                    ready-made layout rules instead of guessing from pixels.

The output is a ``semantics`` block (schema ``synthskin.semantics/v1``) that
attaches to the layout manifest. It is advisory: every node still carries its
absolute rect, so a consumer that ignores the semantics loses nothing.

This is the deterministic reframe of a Cassowary/Auto-Layout step: a real
constraint *solver* satisfies constraints you already have; here we first have
to *infer* them from geometry. A solver (kiwi/Cassowary) can consume this block
later to drive a live responsive preview.
"""
from __future__ import annotations

from statistics import median
from typing import Any, Dict, List, Optional, Sequence, Tuple

SEMANTICS_SCHEMA = "synthskin.semantics/v1"

# A synthetic root so the tree always has a single top node (the panel itself).
ROOT_ID = "__panel__"


# ── box model ─────────────────────────────────────────────────────────────────

class Box:
    """A control reduced to axis-aligned geometry + identity."""

    __slots__ = ("id", "type", "x1", "y1", "x2", "y2")

    def __init__(self, cid: str, ctype: Optional[str], x: float, y: float, w: float, h: float):
        self.id = cid
        self.type = ctype
        self.x1 = float(x)
        self.y1 = float(y)
        self.x2 = float(x) + max(0.0, float(w))
        self.y2 = float(y) + max(0.0, float(h))

    @property
    def w(self) -> float:
        return self.x2 - self.x1

    @property
    def h(self) -> float:
        return self.y2 - self.y1

    @property
    def cx(self) -> float:
        return (self.x1 + self.x2) / 2.0

    @property
    def cy(self) -> float:
        return (self.y1 + self.y2) / 2.0

    @property
    def area(self) -> float:
        return max(0.0, self.w) * max(0.0, self.h)

    def rect(self) -> List[int]:
        return [int(round(self.x1)), int(round(self.y1)), int(round(self.w)), int(round(self.h))]

    def contains(self, other: "Box", tol: float) -> bool:
        """True if this box encloses ``other`` (with a small slop) AND is larger."""
        if self is other:
            return False
        if self.area <= other.area:
            return False
        return (
            self.x1 <= other.x1 + tol
            and self.y1 <= other.y1 + tol
            and self.x2 >= other.x2 - tol
            and self.y2 >= other.y2 - tol
        )


def _rect_of(control: Dict[str, Any]) -> Optional[Tuple[float, float, float, float]]:
    """Extract [x, y, w, h] from either a manifest asset (``rect``) or a raw
    analyzed control (``refined_bbox`` / ``mask_bbox`` / ``bbox`` as x1y1x2y2)."""
    if "rect" in control and control["rect"]:
        r = control["rect"]
        if len(r) == 4:
            return float(r[0]), float(r[1]), float(r[2]), float(r[3])
    bb = control.get("refined_bbox") or control.get("mask_bbox") or control.get("bbox")
    if bb and len(bb) == 4:
        x1, y1, x2, y2 = [float(v) for v in bb]
        return x1, y1, x2 - x1, y2 - y1
    return None


def boxes_from_controls(controls: Sequence[Dict[str, Any]]) -> List[Box]:
    out: List[Box] = []
    for c in controls:
        r = _rect_of(c)
        if r is None:
            continue
        x, y, w, h = r
        if w <= 0 or h <= 0:
            continue
        out.append(Box(str(c.get("id")), c.get("type"), x, y, w, h))
    return out


# ── 1-D clustering (single-linkage sweep) ─────────────────────────────────────

def cluster_1d(values: Sequence[float], tol: float) -> List[List[int]]:
    """Group indices whose values chain together within ``tol`` (sorted sweep).

    Returns a list of clusters, each a list of original indices, order-stable by
    value. Used both for edge-snapping (alignment) and row/column banding.
    """
    if not values:
        return []
    order = sorted(range(len(values)), key=lambda i: values[i])
    clusters: List[List[int]] = [[order[0]]]
    for idx in order[1:]:
        if abs(values[idx] - values[clusters[-1][-1]]) <= tol:
            clusters[-1].append(idx)
        else:
            clusters.append([idx])
    return clusters


# ── 2. alignment guides ───────────────────────────────────────────────────────

_EDGE_ACCESSORS = {
    "left": ("x", lambda b: b.x1),
    "right": ("x", lambda b: b.x2),
    "center_x": ("x", lambda b: b.cx),
    "top": ("y", lambda b: b.y1),
    "bottom": ("y", lambda b: b.y2),
    "middle_y": ("y", lambda b: b.cy),
}


def alignment_guides(boxes: Sequence[Box], tol: float) -> List[Dict[str, Any]]:
    """Find edges/centres shared by >=2 boxes -> a list of alignment guides."""
    guides: List[Dict[str, Any]] = []
    for kind, (axis, acc) in _EDGE_ACCESSORS.items():
        vals = [acc(b) for b in boxes]
        for cl in cluster_1d(vals, tol):
            if len(cl) < 2:
                continue
            pos = sum(vals[i] for i in cl) / len(cl)
            guides.append({
                "axis": axis,
                "kind": kind,
                "position": round(pos, 1),
                "members": [boxes[i].id for i in cl],
            })
    # Strongest guides first (most members).
    guides.sort(key=lambda g: len(g["members"]), reverse=True)
    return guides


# ── 3. arrangement of a set of siblings ───────────────────────────────────────

def _band(boxes: Sequence[Box], key, tol: float) -> List[List[int]]:
    """Cluster siblings into bands (rows or columns) by a centre accessor."""
    return cluster_1d([key(b) for b in boxes], tol)


def _even_gap(sorted_boxes: Sequence[Box], axis: str) -> Tuple[Optional[float], bool]:
    """Median inter-element gap along ``axis`` and whether gaps are ~uniform."""
    if len(sorted_boxes) < 2:
        return None, True
    gaps: List[float] = []
    for a, b in zip(sorted_boxes, sorted_boxes[1:]):
        if axis == "x":
            gaps.append(b.x1 - a.x2)
        else:
            gaps.append(b.y1 - a.y2)
    med = median(gaps)
    if len(gaps) == 1:
        return round(med, 1), True
    spread = max(gaps) - min(gaps)
    # uniform if the spread is small relative to element size (or near-zero abs).
    ref = median([b.w if axis == "x" else b.h for b in sorted_boxes]) or 1.0
    uniform = spread <= max(4.0, 0.35 * ref)
    return round(med, 1), uniform


def arrangement(children: Sequence[Box]) -> Dict[str, Any]:
    """Classify how a container's direct children are arranged.

    Returns a dict: ``kind`` in {'single','row','column','grid','free'} plus the
    supporting numbers (rows, cols, gaps). Tolerances scale to child size, so it
    is resolution-independent.
    """
    n = len(children)
    if n == 0:
        return {"kind": "empty", "count": 0}
    if n == 1:
        return {"kind": "single", "count": 1}

    med_h = median([b.h for b in children]) or 1.0
    med_w = median([b.w for b in children]) or 1.0
    row_tol = max(4.0, 0.5 * med_h)
    col_tol = max(4.0, 0.5 * med_w)

    rows = _band(children, lambda b: b.cy, row_tol)
    cols = _band(children, lambda b: b.cx, col_tol)
    n_rows, n_cols = len(rows), len(cols)

    # Single band -> flex row/column.
    if n_rows == 1 and n_cols >= 1:
        ordered = sorted(children, key=lambda b: b.x1)
        gap, uniform = _even_gap(ordered, "x")
        return {"kind": "row", "count": n, "cols": n, "rows": 1,
                "gap": gap, "uniform_gap": uniform}
    if n_cols == 1 and n_rows >= 1:
        ordered = sorted(children, key=lambda b: b.y1)
        gap, uniform = _even_gap(ordered, "y")
        return {"kind": "column", "count": n, "cols": 1, "rows": n_rows,
                "gap": gap, "uniform_gap": uniform}

    # Multiple bands both ways: a grid IF the counts are consistent (allow a
    # ragged final row, e.g. 7 items in a 4-col grid -> 2 rows).
    if n_rows >= 2 and n_cols >= 2 and n_rows * n_cols >= n and n <= n_rows * n_cols:
        # Column-gap from the first full row, row-gap from column centres.
        first_row = sorted((children[i] for i in max(rows, key=len)), key=lambda b: b.x1)
        col_gap, col_uniform = _even_gap(first_row, "x")
        row_centres = sorted(
            (sum(children[i].cy for i in r) / len(r) for r in rows)
        )
        row_gaps = [b - a for a, b in zip(row_centres, row_centres[1:])]
        row_gap = round(median(row_gaps), 1) if row_gaps else None
        return {
            "kind": "grid", "count": n, "rows": n_rows, "cols": n_cols,
            "col_gap": col_gap, "row_gap": row_gap, "uniform_gap": col_uniform,
        }

    return {"kind": "free", "count": n, "rows": n_rows, "cols": n_cols}


# ── 4. CSS-flavoured flex/grid hint for a container ───────────────────────────

def _cross_align(children: Sequence[Box], axis: str, tol: float) -> str:
    """align-items for a flex container. ``axis`` is the MAIN axis ('x' or 'y');
    alignment is measured on the cross axis."""
    if axis == "x":  # row -> cross axis is vertical
        starts = [b.y1 for b in children]
        centres = [b.cy for b in children]
        ends = [b.y2 for b in children]
    else:            # column -> cross axis is horizontal
        starts = [b.x1 for b in children]
        centres = [b.cx for b in children]
        ends = [b.x2 for b in children]

    def uniform(vals: Sequence[float]) -> bool:
        return (max(vals) - min(vals)) <= tol

    if uniform(centres):
        return "center"
    if uniform(starts):
        return "flex-start"
    if uniform(ends):
        return "flex-end"
    return "stretch"


def _justify(children: Sequence[Box], container: Box, axis: str, uniform_gap: bool) -> str:
    """justify-content along the main axis, from the outer margins + gap regularity."""
    if axis == "x":
        ordered = sorted(children, key=lambda b: b.x1)
        lead = ordered[0].x1 - container.x1
        trail = container.x2 - ordered[-1].x2
    else:
        ordered = sorted(children, key=lambda b: b.y1)
        lead = ordered[0].y1 - container.y1
        trail = container.y2 - ordered[-1].y2
    span = container.w if axis == "x" else container.h
    edge_tol = max(6.0, 0.04 * span)
    if uniform_gap and lead <= edge_tol and trail <= edge_tol:
        return "space-between"
    if abs(lead - trail) <= edge_tol:
        return "center"
    return "flex-start"


def layout_hint(container: Box, children: Sequence[Box]) -> Optional[Dict[str, Any]]:
    """A CSS-flavoured layout rule for one container, or None if it has <2 kids."""
    arr = arrangement(children)
    kind = arr["kind"]
    if kind in ("empty", "single"):
        return None

    med_h = median([b.h for b in children]) or 1.0
    med_w = median([b.w for b in children]) or 1.0

    if kind == "row":
        return {
            "display": "flex", "direction": "row",
            "gap": arr.get("gap"),
            "align_items": _cross_align(children, "x", max(4.0, 0.4 * med_h)),
            "justify_content": _justify(children, container, "x", arr.get("uniform_gap", False)),
        }
    if kind == "column":
        return {
            "display": "flex", "direction": "column",
            "gap": arr.get("gap"),
            "align_items": _cross_align(children, "y", max(4.0, 0.4 * med_w)),
            "justify_content": _justify(children, container, "y", arr.get("uniform_gap", False)),
        }
    if kind == "grid":
        return {
            "display": "grid",
            "rows": arr["rows"], "cols": arr["cols"],
            "row_gap": arr.get("row_gap"), "col_gap": arr.get("col_gap"),
        }
    return {"display": "block", "arrangement": "free"}


# ── 1. containment tree ───────────────────────────────────────────────────────

def _best_parent(box: Box, boxes: Sequence[Box], tol: float) -> Optional[Box]:
    """The smallest-area box that contains ``box`` (its immediate parent)."""
    best: Optional[Box] = None
    for cand in boxes:
        if cand.contains(box, tol):
            if best is None or cand.area < best.area:
                best = cand
    return best


def build_tree(boxes: Sequence[Box], width: int, height: int, tol: float) -> Dict[str, Any]:
    """Build the containment nesting tree with per-container layout hints."""
    parent_of: Dict[str, Optional[str]] = {}
    id_to_box: Dict[str, Box] = {b.id: b for b in boxes}
    for b in boxes:
        p = _best_parent(b, boxes, tol)
        parent_of[b.id] = p.id if p else None

    children_of: Dict[Optional[str], List[str]] = {}
    for cid, pid in parent_of.items():
        children_of.setdefault(pid, []).append(cid)

    root_box = Box(ROOT_ID, "panel", 0, 0, width, height)

    def node_for(b: Box, container: Box) -> Dict[str, Any]:
        kids = [id_to_box[c] for c in children_of.get(b.id, [])]
        kids.sort(key=lambda k: (k.y1, k.x1))
        node: Dict[str, Any] = {"id": b.id, "type": b.type, "rect": b.rect()}
        if kids:
            hint = layout_hint(b, kids)
            if hint:
                node["layout"] = hint
            node["children"] = [node_for(k, b) for k in kids]
        return node

    roots = [id_to_box[c] for c in children_of.get(None, [])]
    roots.sort(key=lambda k: (k.y1, k.x1))
    root_node: Dict[str, Any] = {"id": ROOT_ID, "type": "panel",
                                 "rect": [0, 0, int(width), int(height)]}
    hint = layout_hint(root_box, roots)
    if hint:
        root_node["layout"] = hint
    root_node["children"] = [node_for(k, root_box) for k in roots]

    depth_of: Dict[str, int] = {}

    def _depth(cid: str) -> int:
        if cid in depth_of:
            return depth_of[cid]
        pid = parent_of.get(cid)
        d = 0 if pid is None else _depth(pid) + 1
        depth_of[cid] = d
        return d

    flat = {b.id: {"parent": parent_of[b.id], "depth": _depth(b.id)} for b in boxes}
    return {"root": root_node, "parent_of": parent_of, "depth": flat}


# ── public entrypoint ─────────────────────────────────────────────────────────

def analyze_layout(
    controls: Sequence[Dict[str, Any]],
    image_width: int,
    image_height: int,
    *,
    tol: Optional[float] = None,
) -> Dict[str, Any]:
    """Infer the semantic layout for a set of controls -> a ``semantics`` block.

    ``tol`` (alignment/containment slop in px) defaults to ~0.4% of the larger
    image dimension, clamped to [3, 12] px, so it scales across resolutions.
    """
    boxes = boxes_from_controls(controls)
    if tol is None:
        tol = min(12.0, max(3.0, 0.004 * max(image_width, image_height)))

    tree = build_tree(boxes, image_width, image_height, tol)
    guides = alignment_guides(boxes, tol)

    return {
        "schema": SEMANTICS_SCHEMA,
        "tolerance_px": round(tol, 1),
        "node_count": len(boxes),
        "tree": tree["root"],
        "parent_of": tree["parent_of"],
        "depth": tree["depth"],
        "alignment_guides": guides,
    }
