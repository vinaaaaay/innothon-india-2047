"""State polygons: loading, point-in-state tests, areas."""
import json
from dataclasses import dataclass

import numpy as np
from matplotlib.path import Path as MplPath

from config import RAW, STATES

GEOJSON = RAW / "geo" / "india_states_datta07.geojson"

# Boundary-file names -> canonical names used everywhere else.
GEO_NAME = {
    "Andaman & Nicobar": "Andaman and Nicobar",
    "Jammu & Kashmir": "Jammu and Kashmir",
    "Daman & Diu": "Dadra and Nagar Haveli and Daman and Diu",
    "Dadra & Nagar Haveli": "Dadra and Nagar Haveli and Daman and Diu",
}
EARTH_R_KM = 6371.0088


@dataclass
class StateShape:
    name: str
    polygons: list          # list of (outer MplPath, [hole MplPaths])
    bbox: tuple             # lon_min, lon_max, lat_min, lat_max
    area_km2: float

    def contains(self, lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
        out = np.zeros(len(lon), dtype=bool)
        cand = (lon >= self.bbox[0]) & (lon <= self.bbox[1]) & (lat >= self.bbox[2]) & (lat <= self.bbox[3])
        if not cand.any():
            return out
        pts = np.column_stack([lon[cand], lat[cand]])
        hit = np.zeros(len(pts), dtype=bool)
        for outer, holes in self.polygons:
            inside = outer.contains_points(pts)
            for h in holes:
                inside &= ~h.contains_points(pts)
            hit |= inside
        out[cand] = hit
        return out


def _ring_area_km2(ring: np.ndarray) -> float:
    lon, lat = np.radians(ring[:, 0]), np.radians(ring[:, 1])
    return abs(np.sum((lon[1:] - lon[:-1]) * (2 + np.sin(lat[1:]) + np.sin(lat[:-1])))) * EARTH_R_KM ** 2 / 2


def load_states() -> dict[str, StateShape]:
    raw = json.load(open(GEOJSON))
    parts: dict[str, dict] = {}
    for ft in raw["features"]:
        name = ft["properties"]["STNAME_SH"]
        name = GEO_NAME.get(name, name)
        if name not in STATES:
            raise ValueError(f"boundary file state not in config: {name}")
        geom = ft["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        p = parts.setdefault(name, {"polygons": [], "area": 0.0, "pts": []})
        for poly in polys:
            outer = np.asarray(poly[0], dtype=float)
            holes = [np.asarray(h, dtype=float) for h in poly[1:]]
            p["polygons"].append((MplPath(outer), [MplPath(h) for h in holes]))
            p["area"] += _ring_area_km2(outer) - sum(_ring_area_km2(h) for h in holes)
            p["pts"].append(outer)
    out = {}
    for name, p in parts.items():
        allpts = np.vstack(p["pts"])
        bbox = (allpts[:, 0].min(), allpts[:, 0].max(), allpts[:, 1].min(), allpts[:, 1].max())
        out[name] = StateShape(name, p["polygons"], bbox, p["area"])
    return out


def assign_state(states: dict[str, StateShape], lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """State name for each point ('' when outside India)."""
    lon, lat = np.asarray(lon, dtype=float), np.asarray(lat, dtype=float)
    out = np.full(len(lon), "", dtype=object)
    for name, s in states.items():
        m = s.contains(lon, lat)
        out[m & (out == "")] = name
    return out


def points_in_any_state(states: dict[str, StateShape], lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    return assign_state(states, lon, lat) != ""
