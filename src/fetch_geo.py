"""Download geographic layers used for the resource ceilings.

  data/raw/modis_landcover/   MODIS MCD12Q1 land cover (IGBP classes, ~463 m pixels),
                              one ~120 km window per 1-degree cell that touches India.
                              Source: ORNL DAAC MODIS web service.
  data/raw/elevation/         Elevation on 0.5- and 0.1-degree grids inside India (Open-Meteo elevation API,
                              Open Topo Data SRTM as fallback).

Re-runnable: files already on disk are skipped.
"""
import gzip
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np

from config import RAW
from geo import load_states, points_in_any_state

MODIS_DIR = RAW / "modis_landcover"
ELEV_DIR = RAW / "elevation"
MODIS_YEAR = "A2023001"
MODIS_HALF_WINDOW_KM = 60
LON_RANGE, LAT_RANGE = (68, 98), (6, 38)


def _get(url: str, tries: int = 4) -> bytes:
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "python-urllib"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001 - retry any transient network error
            if k == tries - 1:
                raise
            time.sleep(3 * (k + 1))
    raise RuntimeError("unreachable")


def cells_touching_india(states) -> list[tuple[float, float]]:
    cells = []
    offs = np.linspace(-0.45, 0.45, 7)
    for lat in np.arange(LAT_RANGE[0] + 0.5, LAT_RANGE[1], 1.0):
        for lon in np.arange(LON_RANGE[0] + 0.5, LON_RANGE[1], 1.0):
            gx, gy = np.meshgrid(lon + offs, lat + offs)
            if points_in_any_state(states, gx.ravel(), gy.ravel()).any():
                cells.append((float(lat), float(lon)))
    return cells


def fetch_modis(cell: tuple[float, float]) -> str:
    lat, lon = cell
    out = MODIS_DIR / f"lc_{lat:.1f}_{lon:.1f}.json.gz"
    if out.exists():
        return "skip"
    url = ("https://modis.ornl.gov/rst/api/v1/MCD12Q1/subset?"
           f"latitude={lat}&longitude={lon}&band=LC_Type1&startDate={MODIS_YEAR}&endDate={MODIS_YEAR}"
           f"&kmAboveBelow={MODIS_HALF_WINDOW_KM}&kmLeftRight={MODIS_HALF_WINDOW_KM}")
    try:
        d = json.loads(_get(url))
    except Exception as e:  # noqa: BLE001
        return f"fail {lat},{lon}: {e}"
    keep = {k: d[k] for k in ("xllcorner", "yllcorner", "cellsize", "nrows", "ncols", "latitude", "longitude")}
    keep["modis_date"] = d["subset"][0]["modis_date"]
    keep["data"] = d["subset"][0]["data"]
    with gzip.open(out, "wt") as f:
        json.dump(keep, f)
    return "ok"


_primary_down = False


def _elevation_batch(lat: np.ndarray, lon: np.ndarray) -> list[float]:
    """Elevation for up to 100 points: Open-Meteo first, Open Topo Data (SRTM 90 m) once that rate-limits."""
    global _primary_down
    if not _primary_down:
        la = ",".join(f"{v:.3f}" for v in lat)
        lo = ",".join(f"{v:.3f}" for v in lon)
        try:
            return json.loads(_get(f"https://api.open-meteo.com/v1/elevation?latitude={la}&longitude={lo}", tries=1))["elevation"]
        except Exception:  # noqa: BLE001 - rate limit or outage: stay on the other service for the rest of the run
            _primary_down = True
    locs = "|".join(f"{a:.3f},{b:.3f}" for a, b in zip(lat, lon))
    res = json.loads(_get(f"https://api.opentopodata.org/v1/srtm90m?locations={locs}"))["results"]
    return [r["elevation"] if r["elevation"] is not None else 0.0 for r in res]


def fetch_elevation(states, step: float, name: str) -> None:
    out = ELEV_DIR / name
    lons = np.arange(LON_RANGE[0] + step / 2, LON_RANGE[1], step)
    lats = np.arange(LAT_RANGE[0] + step / 2, LAT_RANGE[1], step)
    gx, gy = np.meshgrid(lons, lats)
    inside = points_in_any_state(states, gx.ravel(), gy.ravel())
    px, py = gx.ravel()[inside], gy.ravel()[inside]
    done = out.read_text().strip().split("\n")[1:] if out.exists() else []
    if len(done) >= len(px):
        print(f"elevation {name}: already on disk")
        return
    with open(out, "a") as f:
        if not done:
            f.write("lat,lon,elevation_m\n")
        for i in range(len(done), len(px), 100):          # resumes after the rows already saved
            el = _elevation_batch(py[i:i + 100], px[i:i + 100])
            f.writelines(f"{a:.3f},{b:.3f},{c}\n" for a, b, c in zip(py[i:i + 100], px[i:i + 100], el))
            f.flush()
            time.sleep(1.3)
    print(f"elevation {name}: {len(px)} grid points")


def main() -> None:
    MODIS_DIR.mkdir(parents=True, exist_ok=True)
    ELEV_DIR.mkdir(parents=True, exist_ok=True)
    states = load_states()
    cells = cells_touching_india(states)
    print(f"MODIS: {len(cells)} one-degree cells touch India")
    with ThreadPoolExecutor(max_workers=6) as ex:
        results = list(ex.map(fetch_modis, cells))
    fails = [r for r in results if r.startswith("fail")]
    print(f"MODIS: ok={results.count('ok')} skipped={results.count('skip')} failed={len(fails)}")
    for f in fails[:10]:
        print("  ", f)
    fetch_elevation(states, 0.5, "elevation_grid_0p5.csv")      # relief for the hydro index
    fetch_elevation(states, 0.1, "elevation_grid_0p1.csv")      # terrain filter for usable land


if __name__ == "__main__":
    main()
