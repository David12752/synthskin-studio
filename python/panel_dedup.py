"""
panel_dedup.py — Deduplication of repeated controls on a panel.

Problem: the detector produces N identical knobs (same model, same size).
We want ONE canonical asset + an instances[] array of all positions so the
export bundle ships one crop instead of N identical files.

Algorithm:
  1. Group controls by type.
  2. Within each type group, cluster by bbox size (area within ±35%) and
     colour histogram similarity (Bhattacharyya distance < threshold).
  3. For each cluster with ≥2 members: pick highest-confidence as canonical.
  4. Template-match the canonical crop across the full image to locate any
     additional instances the detector may have missed.
  5. Return controls with duplicate singleton controls collapsed into their
     canonical, each carrying an instances[] list.

The caller (frontend) decides whether to apply the deduplication — this
endpoint is advisory, not destructive.
"""
from __future__ import annotations

import base64
import logging
import math
import uuid
from typing import Any, Dict, List, Optional, Tuple

import cv2
import numpy as np

logger = logging.getLogger(__name__)

Bbox = Tuple[float, float, float, float]  # x1, y1, x2, y2


# ─── Image helpers ────────────────────────────────────────────────────────────

def _decode_bgr(data_url: str) -> np.ndarray:
    if data_url.startswith("data:"):
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image")
    return img


def _crop(img: np.ndarray, bbox: Bbox) -> Optional[np.ndarray]:
    h, w = img.shape[:2]
    x1, y1, x2, y2 = (int(round(v)) for v in bbox)
    x1, y1 = max(0, x1), max(0, y1)
    x2, y2 = min(w, x2), min(h, y2)
    if x2 <= x1 or y2 <= y1:
        return None
    return img[y1:y2, x1:x2]


def _bbox_area(bbox: Bbox) -> float:
    return max(0.0, (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]))


def _bbox_center(bbox: Bbox) -> Tuple[float, float]:
    return ((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)


# ─── Similarity metrics ───────────────────────────────────────────────────────

def _hist_similarity(a: np.ndarray, b: np.ndarray, size: int = 32) -> float:
    """Bhattacharyya-based histogram similarity in [0, 1]; 1 = identical."""
    if a is None or b is None or a.size == 0 or b.size == 0:
        return 0.0
    # Resize both to same square to compare proportional colour distribution
    sq_a = cv2.resize(a, (size, size), interpolation=cv2.INTER_AREA)
    sq_b = cv2.resize(b, (size, size), interpolation=cv2.INTER_AREA)
    h_a = cv2.calcHist([sq_a], [0, 1, 2], None, [8, 8, 8], [0, 256, 0, 256, 0, 256])
    h_b = cv2.calcHist([sq_b], [0, 1, 2], None, [8, 8, 8], [0, 256, 0, 256, 0, 256])
    cv2.normalize(h_a, h_a)
    cv2.normalize(h_b, h_b)
    dist = cv2.compareHist(h_a, h_b, cv2.HISTCMP_BHATTACHARYYA)
    return max(0.0, 1.0 - dist)


def _size_similarity(a: Bbox, b: Bbox) -> float:
    """Ratio of smaller area to larger area; 1 = identical size."""
    area_a = _bbox_area(a)
    area_b = _bbox_area(b)
    if area_a <= 0 or area_b <= 0:
        return 0.0
    return min(area_a, area_b) / max(area_a, area_b)


# ─── Clustering ───────────────────────────────────────────────────────────────

def _cluster_controls(
    controls: List[Dict[str, Any]],
    img: np.ndarray,
    size_thr: float = 0.60,
    hist_thr: float = 0.60,
) -> List[List[int]]:
    """Return list of clusters (each is a list of indices into controls)."""
    n = len(controls)
    if n == 0:
        return []

    # Pre-compute crops + areas
    crops: List[Optional[np.ndarray]] = []
    for c in controls:
        crop = _crop(img, tuple(c["bbox"]))  # type: ignore[arg-type]
        crops.append(crop)

    # Union-Find
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int) -> None:
        parent[find(i)] = find(j)

    for i in range(n):
        for j in range(i + 1, n):
            if controls[i].get("type") != controls[j].get("type"):
                continue
            sz = _size_similarity(
                tuple(controls[i]["bbox"]),  # type: ignore[arg-type]
                tuple(controls[j]["bbox"]),  # type: ignore[arg-type]
            )
            if sz < size_thr:
                continue
            hist = _hist_similarity(crops[i], crops[j])
            if hist >= hist_thr:
                union(i, j)

    # Collect clusters
    from collections import defaultdict
    groups: Dict[int, List[int]] = defaultdict(list)
    for i in range(n):
        groups[find(i)].append(i)

    return [sorted(idxs) for idxs in groups.values()]


# ─── Template matching ────────────────────────────────────────────────────────

def _template_match(
    img: np.ndarray,
    template_crop: np.ndarray,
    canonical_bbox: Bbox,
    score_threshold: float = 0.72,
    max_instances: int = 64,
) -> List[Bbox]:
    """Find all occurrences of template_crop in img via multi-scale NCC.

    Returns bboxes (in image coordinates) for all high-scoring matches,
    excluding the canonical location itself.
    """
    if template_crop is None or template_crop.size == 0:
        return []

    th, tw = template_crop.shape[:2]
    ih, iw = img.shape[:2]

    if th < 4 or tw < 4 or th > ih or tw > iw:
        return []

    # Convert to grayscale for matching (faster + colour-invariant)
    templ_gray = cv2.cvtColor(template_crop, cv2.COLOR_BGR2GRAY)
    img_gray   = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    result = cv2.matchTemplate(img_gray, templ_gray, cv2.TM_CCOEFF_NORMED)
    locs = np.argwhere(result >= score_threshold)

    # NMS over matches
    matched: List[Bbox] = []
    for pt in locs:
        my, mx = pt
        x1, y1, x2, y2 = float(mx), float(my), float(mx + tw), float(my + th)

        # Skip if this match significantly overlaps the canonical location
        cx1, cy1, cx2, cy2 = canonical_bbox
        ix1 = max(x1, cx1); iy1 = max(y1, cy1)
        ix2 = min(x2, cx2); iy2 = min(y2, cy2)
        inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
        area = (x2 - x1) * (y2 - y1)
        if area > 0 and inter / area > 0.5:
            continue

        # Suppress overlaps with already-accepted matches
        duplicate = False
        for mb in matched:
            mx1, my1, mx2, my2 = mb
            jx1 = max(x1, mx1); jy1 = max(y1, my1)
            jx2 = min(x2, mx2); jy2 = min(y2, my2)
            jinter = max(0.0, jx2 - jx1) * max(0.0, jy2 - jy1)
            if area > 0 and jinter / area > 0.4:
                duplicate = True
                break
        if not duplicate:
            matched.append((x1, y1, x2, y2))
        if len(matched) >= max_instances:
            break

    return matched


# ─── Public API ───────────────────────────────────────────────────────────────

def deduplicate_controls(
    controls: List[Dict[str, Any]],
    image_b64: str,
    size_thr: float = 0.60,
    hist_thr: float = 0.60,
    match_score_thr: float = 0.72,
    min_cluster_size: int = 2,
    run_template_match: bool = True,
) -> Dict[str, Any]:
    """Cluster controls into canonical + instance groups.

    Returns:
      {
        "groups": [
          {
            "canonical_id": str,          # the one asset to keep
            "canonical_bbox": [x1,y1,x2,y2],
            "instances": [                # all positions (excl. canonical)
              {"id": str, "bbox": [x1,y1,x2,y2], "source": "detector"|"template"}
            ],
            "member_ids": [str],          # original control IDs in the cluster
            "type": str,
            "template_match_count": int,  # additional instances found by NCC
          }
        ],
        "canonical_ids": [str],           # IDs of controls to keep
        "removed_ids": [str],             # IDs subsumed into a canonical
        "total_saved": int                # how many fewer exports needed
      }
    """
    if not controls:
        return {
            "groups": [],
            "canonical_ids": [],
            "removed_ids": [],
            "total_saved": 0,
        }

    img = _decode_bgr(image_b64)
    clusters = _cluster_controls(controls, img, size_thr=size_thr, hist_thr=hist_thr)

    groups: List[Dict[str, Any]] = []
    canonical_ids: List[str] = []
    removed_ids: List[str] = []

    for cluster in clusters:
        members = [controls[i] for i in cluster]

        # Singleton clusters — no deduplication needed
        if len(members) < min_cluster_size:
            for m in members:
                canonical_ids.append(m["id"])
            continue

        # Pick canonical = highest confidence
        canonical = max(members, key=lambda c: float(c.get("confidence", 0)))
        can_bbox: Bbox = tuple(canonical["bbox"])  # type: ignore[assignment]

        # Other members become instances
        instance_records: List[Dict[str, Any]] = []
        for m in members:
            if m["id"] == canonical["id"]:
                continue
            instance_records.append({
                "id": m["id"],
                "bbox": list(m["bbox"]),
                "source": "detector",
            })
            removed_ids.append(m["id"])

        # Template-match to find additional positions
        tm_count = 0
        if run_template_match:
            template_crop = _crop(img, can_bbox)
            if template_crop is not None:
                extra = _template_match(img, template_crop, can_bbox, score_threshold=match_score_thr)
                for ebbox in extra:
                    # Skip if it overlaps an already-known member
                    known_bboxes = [can_bbox] + [tuple(m["bbox"]) for m in members]  # type: ignore[misc]
                    skip = False
                    ea = _bbox_area(ebbox)
                    for kb in known_bboxes:
                        kx1, ky1, kx2, ky2 = kb
                        ex1, ey1, ex2, ey2 = ebbox
                        ix1 = max(ex1, kx1); iy1 = max(ey1, ky1)
                        ix2 = min(ex2, kx2); iy2 = min(ey2, ky2)
                        inter = max(0.0, ix2 - ix1) * max(0.0, iy2 - iy1)
                        if ea > 0 and inter / ea > 0.4:
                            skip = True
                            break
                    if not skip:
                        instance_records.append({
                            "id": f"tm_{uuid.uuid4().hex[:8]}",
                            "bbox": list(ebbox),
                            "source": "template_match",
                        })
                        tm_count += 1

        groups.append({
            "canonical_id": canonical["id"],
            "canonical_bbox": list(can_bbox),
            "instances": instance_records,
            "member_ids": [m["id"] for m in members],
            "type": canonical.get("type", "unknown"),
            "template_match_count": tm_count,
        })
        canonical_ids.append(canonical["id"])

    # Add singletons to canonical list if missed above
    all_ids = {c["id"] for c in controls}
    accounted = set(canonical_ids) | set(removed_ids)
    for cid in all_ids - accounted:
        canonical_ids.append(cid)

    total_saved = len(removed_ids) + sum(g["template_match_count"] for g in groups)

    logger.info(
        "[DEDUP] %d controls → %d canonicals, %d removed, %d groups, %d tm-extra",
        len(controls), len(canonical_ids), len(removed_ids), len(groups),
        sum(g["template_match_count"] for g in groups),
    )

    return {
        "groups": groups,
        "canonical_ids": canonical_ids,
        "removed_ids": removed_ids,
        "total_saved": total_saved,
    }
