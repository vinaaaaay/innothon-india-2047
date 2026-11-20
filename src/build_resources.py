"""Step 6 - state resource ceilings, expressed as energy (TWh per year).

No installed-capacity figure is used anywhere. Ceilings come from physical
indicators:

  solar  usable land (satellite land cover) x irradiance x conversion efficiency x packing
  wind   usable land in windy cells x wind-farm energy density scaled by wind speed cubed
  hydro  rainfall x relief (gross runoff energy), scaled by the share that well-developed
         states actually convert into generation today

Outputs: data/processed/resources_state.csv, data/processed/landcover_state.csv
"""
import glob
import gzip
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd
from scipy.spatial import cKDTree

import compliance
from config import PROCESSED, RAW, STATES
from geo import assign_state, load_states

# ---- Assumptions -----------------------------------------------------------
# IGBP land-cover classes (MODIS MCD12Q1 LC_Type1) grouped for this purpose.
CLASS_GROUP = {1: "forest", 2: "forest", 3: "forest", 4: "forest", 5: "forest", 8: "forest",
               6: "open", 7: "open", 9: "open", 10: "open", 16: "open",
               12: "cropland", 14: "cropland", 13: "urban", 11: "water_snow", 15: "water_snow", 17: "water_snow"}
# Share of each land group that could host solar. 3 % of open land follows the convention
# of India's official solar-potential assessment (3 % of wasteland); the rest are assumptions.
SOLAR_USABLE = {"open": 0.03, "cropland": 0.003, "urban": 0.05}
# Share of each land group in windy cells that could host wind farms (turbines share land with farming).
WIND_USABLE = {"open": 0.05, "cropland": 0.03}
ELEVATION_STEP_DEG = 0.1           # lattice used for terrain and relief (about 11 km)
MAX_ELEVATION_M = 4500            # land above this is excluded (access, construction, grid)
MAX_RUGGEDNESS_M = 250            # land is excluded where elevation changes by more than this to a neighbouring
                                  # lattice point about 11 km away (hills and mountains)
SOLAR_SYSTEM_EFFICIENCY = 0.16    # module efficiency 0.20 x performance ratio 0.80
SOLAR_GROUND_COVER = 0.35         # module area per unit of plant land
WIND_MIN_SPEED_50M = 5.0          # m/s, long-term mean at 50 m (MERRA-2); cells below are not developed
WIND_REF_SPEED_50M = 5.5
WIND_REF_DENSITY_W_M2 = 2.0       # delivered wind-farm output per m2 of land at the reference speed
WIND_DENSITY_CAP = 1.6            # cap on the cubic scaling
HYDRO_RUNOFF_COEFF = 0.5
HYDRO_EXPLOIT_QUANTILE = 0.75     # ceiling = this quantile of today's conversion ratio across hydro states
HYDRO_MIN_TWH_FOR_CALIBRATION = 2.0
SINU_R = 6371007.181
PIXEL_STEP = 2                    # use every 2nd MODIS pixel in each direction (~0.9 km sampling)


def load_power(param: str) -> pd.DataFrame:
    frames = []
    for f in glob.glob(str(RAW / "nasa_power" / f"{param}_*.csv")):
        t = open(f).read()
        frames.append(pd.read_csv(io.StringIO(t[t.index("-END HEADER-") + len("-END HEADER-"):].strip())))
    d = pd.concat(frames, ignore_index=True).drop_duplicates(["LAT", "LON"])
    return d[d["ANN"] > -900].reset_index(drop=True)


class Grid:
    """Nearest-neighbour lookup on a lat/lon grid."""

    def __init__(self, lat: np.ndarray, lon: np.ndarray, values: np.ndarray):
        self.tree = cKDTree(np.column_stack([lat, lon]))
        self.values = np.asarray(values, dtype=float)

    def at(self, lat: np.ndarray, lon: np.ndarray) -> np.ndarray:
        return self.values[self.tree.query(np.column_stack([lat, lon]))[1]]


def ruggedness(el: pd.DataFrame, step: float = ELEVATION_STEP_DEG) -> np.ndarray:
    """Largest elevation difference between each lattice point and its four neighbours (m)."""
    z = {(round(a, 2), round(b, 2)): c for a, b, c in zip(el.lat, el.lon, el.elevation_m)}
    out = []
    for (la, lo), c in z.items():
        nb = [z.get((round(la + da, 2), round(lo + do, 2))) for da, do in ((step, 0), (-step, 0), (0, step), (0, -step))]
        nb = [v for v in nb if v is not None]
        out.append(max(abs(c - v) for v in nb) if nb else 0.0)
    return np.array(out)


def read_landcover(states, ghi: Grid, wind: Grid, elev: Grid, rugged: Grid) -> pd.DataFrame:
    """Per state: pixel counts by land group, plus irradiance- and wind-weighted usable land."""
    acc: dict[str, dict] = {}
    files = sorted(glob.glob(str(RAW / "modis_landcover" / "lc_*.json.gz")))
    for f in files:
        d = json.load(gzip.open(f, "rt"))
        nr, nc, cs = int(d["nrows"]), int(d["ncols"]), float(d["cellsize"])
        cls = np.array(d["data"], dtype=np.int16).reshape(nr, nc)[::PIXEL_STEP, ::PIXEL_STEP]
        rows = np.arange(nr)[::PIXEL_STEP]
        cols = np.arange(nc)[::PIXEL_STEP]
        y = float(d["yllcorner"]) + (nr - rows - 0.5) * cs          # first data row is the northernmost
        x = float(d["xllcorner"]) + (cols + 0.5) * cs
        lat = np.degrees(y / SINU_R)
        xx, la = np.meshgrid(x, lat)
        lo = np.degrees(xx / (SINU_R * np.cos(np.radians(la))))
        lat_c, lon_c = float(d["latitude"]), float(d["longitude"])
        own = (np.abs(la - lat_c) <= 0.5) & (np.abs(lo - lon_c) <= 0.5)   # exact 1-degree tiling, no double counting
        la, lo, cl = la[own], lo[own], cls[own]
        st = assign_state(states, lo, la)
        keep = st != ""
        if not keep.any():
            continue
        la, lo, cl, st = la[keep], lo[keep], cl[keep], st[keep]
        grp = np.array([CLASS_GROUP.get(int(c), "other") for c in cl], dtype=object)
        ok_elev = (elev.at(la, lo) <= MAX_ELEVATION_M) & (rugged.at(la, lo) <= MAX_RUGGEDNESS_M)
        g = ghi.at(la, lo)
        w = wind.at(la, lo)
        sol_frac = np.array([SOLAR_USABLE.get(k, 0.0) for k in grp]) * ok_elev
        win_frac = np.array([WIND_USABLE.get(k, 0.0) for k in grp]) * ok_elev * (w >= WIND_MIN_SPEED_50M)
        dens = WIND_REF_DENSITY_W_M2 * np.minimum(WIND_DENSITY_CAP, (w / WIND_REF_SPEED_50M) ** 3)
        df = pd.DataFrame({"state": st, "grp": grp, "n": 1.0, "sol_w": sol_frac, "sol_ghi": sol_frac * g,
                           "win_w": win_frac, "win_dens": win_frac * dens, "win_speed": win_frac * w,
                           "high": (~ok_elev).astype(float)})
        for s, part in df.groupby("state"):
            a = acc.setdefault(s, {"n": 0.0, "sol_w": 0.0, "sol_ghi": 0.0, "win_w": 0.0, "win_dens": 0.0,
                                   "win_speed": 0.0, "high": 0.0, "groups": {}})
            for k in ("n", "sol_w", "sol_ghi", "win_w", "win_dens", "win_speed", "high"):
                a[k] += float(part[k].sum())
            for gname, cnt in part.groupby("grp")["n"].sum().items():
                a["groups"][gname] = a["groups"].get(gname, 0.0) + float(cnt)
    rows = []
    for s, a in acc.items():
        r = {"state": s, "pixels": a["n"], "solar_land_share": a["sol_w"] / a["n"], "wind_land_share": a["win_w"] / a["n"],
             "ghi_on_solar_land": a["sol_ghi"] / a["sol_w"] if a["sol_w"] else np.nan,
             "wind_density_w_m2": a["win_dens"] / a["win_w"] if a["win_w"] else 0.0,
             "wind_speed_on_wind_land": a["win_speed"] / a["win_w"] if a["win_w"] else np.nan,
             "share_excluded_terrain": a["high"] / a["n"]}
        for gname in ("forest", "open", "cropland", "urban", "water_snow"):
            r[f"share_{gname}"] = a["groups"].get(gname, 0.0) / a["n"]
        rows.append(r)
    print(f"land cover: {len(files)} tiles, {sum(a['n'] for a in acc.values()):,.0f} sampled pixels inside India")
    return pd.DataFrame(rows)


def main() -> None:
    states = load_states()
    ghi_t, wind_t, pre_t, tmp_t = (load_power(p) for p in ("ALLSKY_SFC_SW_DWN", "WS50M", "PRECTOTCORR", "T2M"))
    ghi = Grid(ghi_t.LAT, ghi_t.LON, ghi_t.ANN)
    wind = Grid(wind_t.LAT, wind_t.LON, wind_t.ANN)
    pre = Grid(pre_t.LAT, pre_t.LON, pre_t.ANN)
    tmp = Grid(tmp_t.LAT, tmp_t.LON, tmp_t.ANN)
    el = pd.read_csv(RAW / "elevation" / "elevation_grid_0p1.csv")
    elev = Grid(el.lat, el.lon, el.elevation_m)

    rugged = Grid(el.lat, el.lon, ruggedness(el))
    lc = read_landcover(states, ghi, wind, elev, rugged)

    # ---- climate and relief per state, on the elevation lattice -----------------
    el["state"] = assign_state(states, el.lon.values, el.lat.values)
    el = el[el.state != ""].copy()
    el["precip_m_yr"] = pre.at(el.lat.values, el.lon.values) * 365 / 1000
    el["ghi"] = ghi.at(el.lat.values, el.lon.values)
    el["wind50"] = wind.at(el.lat.values, el.lon.values)
    el["t2m"] = tmp.at(el.lat.values, el.lon.values)
    el["cell_km2"] = (ELEVATION_STEP_DEG * 111.195) * (ELEVATION_STEP_DEG * 111.195 * np.cos(np.radians(el.lat)))
    rows = []
    for s, shape in states.items():
        d = el[el.state == s]
        if d.empty:      # territory smaller than the lattice: use the nearest lattice point
            cx, cy = (shape.bbox[0] + shape.bbox[1]) / 2, (shape.bbox[2] + shape.bbox[3]) / 2
            rows.append({"state": s, "area_km2": shape.area_km2, "ghi_kwh_m2_day": float(ghi.at([cy], [cx])[0]),
                         "wind50_m_s": float(wind.at([cy], [cx])[0]), "precip_mm_yr": float(pre.at([cy], [cx])[0]) * 365,
                         "temp_c": float(tmp.at([cy], [cx])[0]), "elevation_mean_m": float(elev.at([cy], [cx])[0]),
                         "hydro_gross_twh": 0.0, "lattice_points": 0})
            continue
        z_ref = np.percentile(d.elevation_m, 5)
        head = np.clip(d.elevation_m - z_ref, 0, None)
        scale = shape.area_km2 / d.cell_km2.sum()                      # lattice cells -> true state area
        joules = (d.precip_m_yr * d.cell_km2 * 1e6 * HYDRO_RUNOFF_COEFF * 1000 * 9.81 * head).sum() * scale
        rows.append({"state": s, "area_km2": shape.area_km2, "ghi_kwh_m2_day": d.ghi.mean(), "wind50_m_s": d.wind50.mean(),
                     "precip_mm_yr": d.precip_m_yr.mean() * 1000, "temp_c": d.t2m.mean(), "elevation_mean_m": d.elevation_m.mean(),
                     "hydro_gross_twh": joules / 3.6e15, "lattice_points": len(d)})
    res = pd.DataFrame(rows).merge(lc, on="state", how="left")
    res["zone"] = res["state"].map(lambda s: STATES[s][0])

    # ---- ceilings ---------------------------------------------------------------
    res["ghi_on_solar_land"] = res["ghi_on_solar_land"].fillna(res["ghi_kwh_m2_day"])
    res["solar_yield_gwh_km2"] = res["ghi_on_solar_land"] * 365 * SOLAR_SYSTEM_EFFICIENCY * SOLAR_GROUND_COVER
    res["solar_land_km2"] = res["solar_land_share"].fillna(0) * res["area_km2"]
    res["solar_ceiling_twh"] = res["solar_land_km2"] * res["solar_yield_gwh_km2"] / 1000
    res["wind_land_km2"] = res["wind_land_share"].fillna(0) * res["area_km2"]
    res["wind_yield_gwh_km2"] = res["wind_density_w_m2"].fillna(0) * 8.76
    res["wind_ceiling_twh"] = res["wind_land_km2"] * res["wind_yield_gwh_km2"] / 1000

    base = pd.read_csv(PROCESSED / "base_mix_state.csv")
    compliance.assert_clean(base, "base_mix_state")
    hyd = base[base.source == "Hydro"].set_index("state")
    res["hydro_avg_3y_twh"] = res["state"].map(hyd["avg_3y_twh"]).fillna(0.0)
    res["hydro_best_twh"] = res["state"].map(hyd["best_12m_twh"]).fillna(0.0)
    res["hydro_conversion"] = res["hydro_avg_3y_twh"] / res["hydro_gross_twh"].replace(0, np.nan)
    cal = res[(res.hydro_avg_3y_twh >= HYDRO_MIN_TWH_FOR_CALIBRATION) & res.hydro_conversion.notna()]
    phi = float(cal["hydro_conversion"].quantile(HYDRO_EXPLOIT_QUANTILE))
    res["hydro_ceiling_twh"] = np.maximum(res["hydro_best_twh"], phi * res["hydro_gross_twh"])

    cols = ["state", "zone", "area_km2", "share_forest", "share_open", "share_cropland", "share_urban", "share_water_snow",
            "share_excluded_terrain", "ghi_kwh_m2_day", "wind50_m_s", "precip_mm_yr", "temp_c", "elevation_mean_m",
            "solar_land_km2", "solar_yield_gwh_km2", "solar_ceiling_twh", "wind_land_km2", "wind_speed_on_wind_land",
            "wind_yield_gwh_km2", "wind_ceiling_twh", "hydro_gross_twh", "hydro_avg_3y_twh", "hydro_conversion", "hydro_ceiling_twh"]
    out = res[cols].sort_values("state").reset_index(drop=True)
    compliance.assert_clean(out, "resources_state").to_csv(PROCESSED / "resources_state.csv", index=False)
    json.dump({"SOLAR_USABLE": SOLAR_USABLE, "WIND_USABLE": WIND_USABLE, "MAX_ELEVATION_M": MAX_ELEVATION_M, "MAX_RUGGEDNESS_M": MAX_RUGGEDNESS_M,
               "SOLAR_SYSTEM_EFFICIENCY": SOLAR_SYSTEM_EFFICIENCY, "SOLAR_GROUND_COVER": SOLAR_GROUND_COVER,
               "WIND_MIN_SPEED_50M": WIND_MIN_SPEED_50M, "WIND_REF_SPEED_50M": WIND_REF_SPEED_50M,
               "WIND_REF_DENSITY_W_M2": WIND_REF_DENSITY_W_M2, "WIND_DENSITY_CAP": WIND_DENSITY_CAP,
               "HYDRO_RUNOFF_COEFF": HYDRO_RUNOFF_COEFF, "HYDRO_EXPLOIT_QUANTILE": HYDRO_EXPLOIT_QUANTILE,
               "hydro_conversion_ratio_used": phi, "hydro_calibration_states": cal["state"].tolist()},
              open(PROCESSED / "resource_assumptions.json", "w"), indent=2)

    pd.set_option("display.width", 250)
    pd.set_option("display.max_rows", 60)
    show = out[["state", "zone", "area_km2", "share_open", "share_cropland", "share_forest", "ghi_kwh_m2_day", "wind50_m_s",
                "precip_mm_yr", "solar_ceiling_twh", "wind_ceiling_twh", "hydro_gross_twh", "hydro_avg_3y_twh", "hydro_ceiling_twh"]]
    print(show.round({"area_km2": 0, "share_open": 2, "share_cropland": 2, "share_forest": 2, "ghi_kwh_m2_day": 2, "wind50_m_s": 2,
                      "precip_mm_yr": 0, "solar_ceiling_twh": 0, "wind_ceiling_twh": 0, "hydro_gross_twh": 0,
                      "hydro_avg_3y_twh": 1, "hydro_ceiling_twh": 1}).to_string(index=False))
    print(f"\nIndia: area {out.area_km2.sum():,.0f} km2 | open {np.average(out.share_open.fillna(0), weights=out.area_km2):.1%}"
          f" | cropland {np.average(out.share_cropland.fillna(0), weights=out.area_km2):.1%}"
          f" | forest {np.average(out.share_forest.fillna(0), weights=out.area_km2):.1%}")
    print(f"ceilings (TWh/yr): solar {out.solar_ceiling_twh.sum():,.0f} | wind {out.wind_ceiling_twh.sum():,.0f}"
          f" | hydro {out.hydro_ceiling_twh.sum():,.0f} (today {out.hydro_avg_3y_twh.sum():,.0f}; conversion ratio {phi:.3f})")
    zc = out.groupby("zone")[["solar_ceiling_twh", "wind_ceiling_twh", "hydro_ceiling_twh"]].sum()
    print(zc.round(0).to_string())


if __name__ == "__main__":
    main()
