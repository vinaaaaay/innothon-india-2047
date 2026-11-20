"""Step 8 - data bundle for the interactive dashboard.

Solves the allocation optimiser over a grid of scenarios so that the dashboard's controls show
real optimiser results (the browser only interpolates between neighbouring need levels), then
writes everything the page needs to dashboard/data.js.

Grid:
  need            P10 / P50 / P90 of the forecast (exact paths), plus a one-parameter family of need paths
                  indexed by 2047 total generation (for custom growth / urbanisation / population scenarios)
  carbon price    0, 2,000, 4,000, 6,000 INR per tonne CO2
  solar land      2 %, 3 %, 5 % of open land
  wind ceiling    1x, 2x
  new coal        allowed / not allowed
  clean build     solar and wind added at India's demonstrated pace / at a faster pace (CLEAN_PACE_FAST)
  domestic gas    as today / after a major discovery (cheaper gas, more room to burn it; themes.GAS_DISCOVERY)

Also exports the theme cards (themes.py) and 1,000 thinned Monte Carlo futures used for signpost updating.
"""
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from dataclasses import asdict, replace
from datetime import date
from itertools import product
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd

import compliance
import optimise as O
import themes as T
from config import BASE_YEAR, MILESTONES, OUTPUTS, PROCESSED, RAW, ROOT, STATES, TARGET_YEAR, ZONES
from geo import GEO_NAME, GEOJSON

DASH = ROOT / "dashboard"

NEED_QUANTILES = ["p10", "p50", "p90"]
NEED_FAMILY_TWH = [3400, 3900, 4400, 4900, 5400, 5900, 6400, 6900, 7400, 8400, 9400, 10400]   # 2047 total generation
CARBON = [0, 2000, 4000, 6000]
SOLAR_LAND_PCT = [2, 3, 5]
SOLAR_LAND_DEFAULT = 3
WIND_SCALE = [1, 2]
NEW_COAL = [1, 0]
CLEAN_PACE = [0, 1]   # 1 = faster solar and wind build-out
CLEAN_PACE_FAST = {"build_acceleration": 0.12, "state_build_share": 0.40}   # demonstrated: 0.06 a year and 0.30
GAS = [0, 1]          # 1 = after a major domestic gas discovery

SRC6 = ["Coal", "Gas", "Nuclear", "Hydro", "Wind", "Solar"]
REASONS = ["at resource ceiling", "at fuel-infrastructure cap", "committed pipeline (policy floor)",
           "existing fleet at full output", "at state share of national build pace", "limited by national build pace",
           "expanding, cost-optimal", "held at existing level", "declining at just-transition limit",
           "not selected", "not available", "cost-optimal"]

# Map geometry
MAP_LON0, MAP_LAT1, MAP_SCALE, MAP_LAT_REF = 67.6, 37.4, 19.0, 22.5
SIMPLIFY_TOL_PX = 0.45
MIN_RING_PX2 = 1.2
_worker_inp = None


# --------------------------------------------------------------------------
# Scenario grid
# --------------------------------------------------------------------------
def family_need(inp: O.Inputs, total_2047: float) -> pd.DataFrame:
    """Need path whose 2047 value is `total_2047` (total-generation basis), shaped like the P50 path."""
    p50 = inp.need["p50_twh"]
    base = float(p50.loc[BASE_YEAR])
    lam = np.log(total_2047 * inp.utility_share / base) / np.log(float(p50.loc[TARGET_YEAR]) / base)
    return pd.DataFrame({"p50_twh": base * (p50 / base) ** lam})


def grid_cases() -> list[tuple]:
    needs = [("q", q) for q in NEED_QUANTILES] + [("f", v) for v in NEED_FAMILY_TWH]
    return list(product(needs, CARBON, SOLAR_LAND_PCT, WIND_SCALE, NEW_COAL, CLEAN_PACE, GAS))


def run_case(case: tuple) -> dict:
    global _worker_inp
    if _worker_inp is None:
        _worker_inp = O.load_inputs()
    inp = _worker_inp
    (kind, need), carbon, land, wind, new_coal, pace, gas = case
    p = O.Params(name="grid", carbon_price=float(carbon))
    p.ceiling_scale = {"Solar": land / SOLAR_LAND_DEFAULT, "Wind": float(wind), "Hydro": 1.0}
    if not new_coal:
        p.coal_new_min_existing_twh = 1e12
    if pace:
        a = CLEAN_PACE_FAST["build_acceleration"]
        p.build_acceleration = {**p.build_acceleration, "Solar": a, "Wind": a}
        p.state_build_share = CLEAN_PACE_FAST["state_build_share"]
    if gas:
        g = T.GAS_DISCOVERY
        p.cost = {**p.cost, "Gas": (g["Gas cost, INR per kWh"][1], 0.0)}
        p.gas_max_multiple = g["Gas output cap, multiple of each state's best year"][1]
        p.gas_new_state_twh = g["Allowance for states with no gas plants, TWh"][1]
        p.build_acceleration = {**p.build_acceleration, "Gas": g["Annual growth allowed on gas build pace"][1]}
    if kind == "q":
        p.need_case = need
        use = inp
    else:
        use = replace(inp, need=family_need(inp, need))
    sol, meta = O.solve(use, p)
    if sol.status != "optimal":
        raise RuntimeError(f"{case}: {sol.status}")
    t = O.tidy(sol, meta, use)
    meta["_unserved"] = {(y, m): sol.x[f"unserved|{m}|{y}"] for y in MILESTONES for m in O.MONTHS}
    return pack(t, meta)


def pack(t: dict, meta: dict) -> dict:
    """Compact arrays in a fixed order (documented in the bundle's `layout`)."""
    states = meta["states"]
    mix = t["mix"]
    z = mix[mix.year.isin(MILESTONES)].groupby(["year", "zone", "source"])["twh"].sum()
    zone = [int(round(z.get((y, zn, s), 0.0) * 10)) for y in MILESTONES for zn in ZONES for s in SRC6]
    s47 = mix[mix.year == TARGET_YEAR].set_index(["state", "source"])["twh"]
    state = [int(round(s47.get((st, s), 0.0) * 10)) for st in states for s in SRC6]
    mo = t["monthly"].set_index(["year", "month"])
    sol_x = meta["_unserved"]
    monthly = []
    for y in MILESTONES:
        for m in O.MONTHS:
            r = mo.loc[(y, m)]
            monthly += [int(round(r["coal_twh"] * 10)), int(round(r["gas_twh"] * 10)), int(round(r["storage_shift_twh"] * 10)),
                        int(round(r["curtailed_twh"] * 10)), int(round(sol_x[(y, m)] * 10)), int(round(r["marginal_cost_inr_kwh"] * 100))]
    sm = t["summary"].set_index("year")
    summary = []
    for y in MILESTONES:
        r = sm.loc[y]
        summary += [round(r["need_twh"], 1), round(r["generation_twh"], 1), round(r["emissions_mtco2"], 1), round(r["storage_shift_twh"], 1),
                    round(r["curtailed_twh"], 1), round(r["unserved_twh"], 1), round(r["transfer_twh"], 1), round(r["avg_cost_inr_kwh"], 3)]
    why = t["why"]
    w47 = why[why.year == TARGET_YEAR].set_index(["state", "source"])["reason"].to_dict()
    reasons = "".join(chr(97 + REASONS.index(w47[(st, k)])) if (st, k) in w47 else "-" for st in states for k in O.OPT_SOURCES)
    bd = t["build"].set_index(["year", "source"])["used_twh"]
    build = [int(round(bd[(y, k)] * 10)) for y in MILESTONES for k in O.BUILD_SOURCES]
    return {"z": zone, "s": state, "m": monthly, "k": summary, "r": reasons, "b": build}


# --------------------------------------------------------------------------
# Map geometry
# --------------------------------------------------------------------------
def _project(ring: np.ndarray) -> np.ndarray:
    x = (ring[:, 0] - MAP_LON0) * np.cos(np.radians(MAP_LAT_REF)) * MAP_SCALE
    y = (MAP_LAT1 - ring[:, 1]) * MAP_SCALE
    return np.column_stack([x, y])


def _dp(pts: np.ndarray, tol: float) -> np.ndarray:
    """Douglas-Peucker on an open polyline (iterative)."""
    keep = np.zeros(len(pts), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        seg = pts[b] - pts[a]
        rel = pts[a + 1:b] - pts[a]
        n = np.hypot(*seg)
        d = np.abs(seg[0] * rel[:, 1] - seg[1] * rel[:, 0]) / n if n > 0 else np.hypot(rel[:, 0], rel[:, 1])
        i = int(np.argmax(d))
        if d[i] > tol:
            k = a + 1 + i
            keep[k] = True
            stack += [(a, k), (k, b)]
    return pts[keep]


def _simplify_ring(pts: np.ndarray, tol: float) -> np.ndarray:
    far = int(np.argmax(np.hypot(*(pts - pts[0]).T)))
    if far == 0:
        return pts
    return np.vstack([_dp(pts[:far + 1], tol), _dp(pts[far:], tol)[1:]])


def _ring_area(pts: np.ndarray) -> float:
    return 0.5 * abs(np.sum(pts[:-1, 0] * pts[1:, 1] - pts[1:, 0] * pts[:-1, 1]))


def _centroid(pts: np.ndarray) -> tuple[float, float]:
    cr = pts[:-1, 0] * pts[1:, 1] - pts[1:, 0] * pts[:-1, 1]
    a = cr.sum() / 2
    if abs(a) < 1e-9:
        return float(pts[:, 0].mean()), float(pts[:, 1].mean())
    return (float(((pts[:-1, 0] + pts[1:, 0]) * cr).sum() / (6 * a)), float(((pts[:-1, 1] + pts[1:, 1]) * cr).sum() / (6 * a)))


def build_map() -> dict:
    raw = json.load(open(GEOJSON))
    rings: dict[str, list] = {}
    for ft in raw["features"]:
        name = GEO_NAME.get(ft["properties"]["STNAME_SH"], ft["properties"]["STNAME_SH"])
        geom = ft["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        for poly in polys:
            rings.setdefault(name, []).append(_project(np.asarray(poly[0], dtype=float)))     # outer rings only
    out, xmax, ymax = {}, 0.0, 0.0
    for name, rs in rings.items():
        rs = sorted(rs, key=_ring_area, reverse=True)
        total = sum(_ring_area(r) for r in rs)
        parts = []
        for i, r in enumerate(rs):
            if i > 0 and _ring_area(r) < MIN_RING_PX2:
                continue
            s = _simplify_ring(r, SIMPLIFY_TOL_PX)
            if len(s) < 4:
                continue
            parts.append("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in s[:-1]) + "Z")
            xmax, ymax = max(xmax, s[:, 0].max()), max(ymax, s[:, 1].max())
        cx, cy = _centroid(rs[0])
        out[name] = {"d": "".join(parts), "cx": round(cx, 1), "cy": round(cy, 1), "px2": round(total, 1)}
    return {"states": out, "width": int(np.ceil(xmax + 6)), "height": int(np.ceil(ymax + 6))}


# --------------------------------------------------------------------------
# Forecast pieces the page recomputes live
# --------------------------------------------------------------------------
def lens_parameters(nat: pd.DataFrame, params: dict, curve: pd.DataFrame) -> dict:
    base = nat.set_index("year").loc[BASE_YEAR]
    anchor = float(np.log(base["generation_pc_kwh"]))
    il = params["india_lens"]
    intercept = anchor - il["elasticity"] * float(np.log(base["gdp_pc_ppp"])) - il["base_year_residual"]
    pl = params["panel_lens"]
    return {"anchor_ln": anchor, "weights": params["weights"],
            "india": {"intercept": intercept, "elasticity": il["elasticity"], "rho": il["rho"], "resid": il["base_year_residual"]},
            "ladder": {"nodes_ln": np.log(curve["income_node"]).round(6).tolist(), "elasticity": curve["elasticity_median"].round(6).tolist(),
                       "grid": [float(np.log(800)), float(np.log(250000)), 600]},
            "panel": {"b": [pl["ln_income"], pl["ln_income_sq"], pl["urban_share"]]}}


def check_port(nat: pd.DataFrame, lens: dict, scen: pd.DataFrame) -> None:
    """Re-implement the three lenses from the exported parameters only and compare with run_forecast's scenarios."""
    d = nat.set_index("year").loc[BASE_YEAR:TARGET_YEAR]
    years = d.index.values
    pop = d["population"].values
    for name, g in scen.groupby("scenario"):
        g0, g1 = g["gdp_growth_start"].iloc[0], g["gdp_growth_end"].iloc[0]
        growth = np.interp(years[1:], [BASE_YEAR + 1, TARGET_YEAR], [g0, g1]) / 100
        gdp_pc = d["gdp_pc_ppp"].iloc[0] * pop[0] * np.concatenate([[1.0], np.cumprod(1 + growth)]) / pop
        x, u = np.log(gdp_pc), d["urban_share"].values / 100
        il = lens["india"]
        india = il["intercept"] + il["elasticity"] * x + il["resid"] * il["rho"] ** (years - BASE_YEAR)
        lo, hi, n = lens["ladder"]["grid"]
        grid = np.linspace(lo, hi, int(n))
        eps = np.interp(grid, lens["ladder"]["nodes_ln"], lens["ladder"]["elasticity"])
        cum = np.concatenate([[0.0], np.cumsum((eps[1:] + eps[:-1]) / 2 * np.diff(grid))])
        lv = np.interp(x, grid, cum)
        ladder = lens["anchor_ln"] + lv - lv[0]
        b = lens["panel"]["b"]
        panel = lens["anchor_ln"] + b[0] * (x - x[0]) + b[1] * (x ** 2 - x[0] ** 2) + b[2] * (u - u[0])
        for key, ln_pc in (("india", india), ("ladder", ladder), ("panel", panel)):
            mine = np.exp(ln_pc[-1]) * pop[-1] / 1e9
            ref = float(g[g.year == TARGET_YEAR][f"{key}_twh"].iloc[0])
            if abs(mine / ref - 1) > 2e-3:
                raise AssertionError(f"lens port mismatch {name}/{key}: {mine:.1f} vs {ref:.1f}")


def clean(obj):
    """NaN and infinity become null so the bundle is strict JSON."""
    if isinstance(obj, dict):
        return {str(k): clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, (float, np.floating)):
        return None if not np.isfinite(obj) else float(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    return obj


def records(df: pd.DataFrame, digits: int = 3) -> list[dict]:
    out = df.copy()
    for c in out.select_dtypes("float").columns:
        out[c] = out[c].round(digits)
    return json.loads(out.to_json(orient="records"))


def main() -> None:
    DASH.mkdir(exist_ok=True)
    inp = O.load_inputs()
    states = sorted(inp.base["state"].unique())

    # ---- scenario grid -------------------------------------------------------
    cases = grid_cases()
    cache = OUTPUTS / "grid_runs.json"
    key = json.dumps([list(map(str, c)) for c in cases])
    if "--reuse-grid" in sys.argv and cache.exists() and json.load(open(cache)).get("key") == key:
        runs = json.load(open(cache))["runs"]
        print(f"reused {len(runs)} cached optimiser cases (outputs/grid_runs.json)")
    else:
        with ProcessPoolExecutor(max_workers=6) as ex:
            runs = list(ex.map(run_case, cases, chunksize=8))
        json.dump({"key": key, "runs": runs}, open(cache, "w"), separators=(",", ":"))
        print(f"solved {len(runs)} optimiser cases")

    # ---- forecast ------------------------------------------------------------
    nat = pd.read_csv(PROCESSED / "drivers_national.csv")
    params = json.load(open(OUTPUTS / "model_parameters.json"))
    curve = pd.read_csv(OUTPUTS / "ladder_curve.csv")
    scen = pd.read_csv(OUTPUTS / "forecast_scenarios.csv")
    fc = pd.read_csv(OUTPUTS / "forecast_national.csv")
    hc = pd.read_csv(OUTPUTS / "hindcast.csv")
    hist = pd.read_csv(PROCESSED / "generation_national_history.csv")
    lens = lens_parameters(nat, params, curve)
    check_port(nat, lens, scen)

    fut = nat.set_index("year").loc[BASE_YEAR:TARGET_YEAR]
    past = nat[(nat.year >= 1990) & (nat.year <= BASE_YEAR)]
    fan = {s: {"p10": g["p10_twh"].round(1).tolist(), "p50": g["p50_twh"].round(1).tolist(), "p90": g["p90_twh"].round(1).tolist()}
           for s, g in fc.sort_values("year").groupby("series")}
    hind = {}
    for (origin, ln), g in hc.sort_values("year").groupby(["origin", "lens"]):
        hind.setdefault(int(origin), {})[ln] = g["predicted_twh"].round(1).tolist()
    hind_years = {int(o): g["year"].drop_duplicates().sort_values().tolist() for o, g in hc.groupby("origin")}

    forecast = {
        "years": fut.index.tolist(), "population": fut["population"].round(0).tolist(), "urban": fut["urban_share"].round(3).tolist(),
        "gdp_pc_base": float(fut["gdp_pc_ppp"].iloc[0]), "lens": lens, "fan": fan,
        "result": params["result_2047_twh"], "base_twh": params["base_generation_twh"], "utility_share": params["utility_share_last3y"],
        "scenarios": params["assumptions"]["scenarios_gdp_growth_pct"], "assumptions": params["assumptions"],
        "weight_sensitivity": params["weight_sensitivity_2047_twh"], "drivers_2047_median": params["drivers_2047_median"],
        "history": {"years": hist["year"].tolist(), "total": hist["Total"].round(1).tolist(),
                    **{s: hist[s].round(1).tolist() for s in ["Coal", "Gas", "Nuclear", "Hydro", "Wind", "Solar", "Bioenergy", "Other"]}},
        "drivers_history": {"years": past["year"].tolist(), "gdp_pc": past["gdp_pc_ppp"].round(0).tolist(),
                            "urban": past["urban_share"].round(2).tolist(), "gen_pc": past["generation_pc_kwh"].round(1).tolist()},
        "hindcast": {"years": hind_years, "pred": hind,
                     "actual": {int(y): round(float(v), 1) for y, v in hc.drop_duplicates("year").set_index("year")["actual_twh"].items()}},
        "ladder_curve": records(curve), "ladder_countries": records(pd.read_csv(OUTPUTS / "ladder_country_bands.csv")),
        "sensitivity": records(pd.read_csv(OUTPUTS / "sensitivity.csv"), 1),
        "india_lens": params["india_lens"], "panel_lens": params["panel_lens"], "ladder_lens": params["ladder_lens"],
        "state_convergence": params["state_convergence"], "weight_rule": params["weight_rule"],
    }

    # ---- regions ---------------------------------------------------------------
    sr = pd.read_csv(OUTPUTS / "requirement_by_state.csv")
    zr = pd.read_csv(OUTPUTS / "requirement_by_zone.csv")
    years5 = [BASE_YEAR] + MILESTONES
    zshare = inp.zone_share
    state_share = sr.pivot(index="state", columns="year", values="share_p50")
    state_share = state_share / state_share.sum()
    res = inp.res
    b = inp.base.set_index(["state", "source"])["base_twh"]
    state_info = {}
    for st in states:
        r = res.loc[st]
        row = sr[sr.state == st].set_index("year")
        state_info[st] = {
            "zone": STATES[st][0],
            "base": [round(float(b.get((st, s), 0.0)), 2) for s in SRC6],
            "fixed": round(float(b.get((st, "Bioenergy", ), 0.0) + b.get((st, "Other"), 0.0)), 2),
            "need_share": [round(float(state_share.loc[st, y]), 5) if st in state_share.index else 0.0 for y in years5],
            "population_m": [round(float(row.loc[y, "population"]) / 1e6, 2) if y in row.index else None for y in (BASE_YEAR, TARGET_YEAR)],
            "income_relative": round(float(row.loc[BASE_YEAR, "income_relative"]), 2) if BASE_YEAR in row.index else None,
            "ceiling": {"Solar": round(float(r["solar_ceiling_twh"]), 1), "Wind": round(float(r["wind_ceiling_twh"]), 1),
                        "Hydro": round(float(r["hydro_ceiling_twh"]), 1)},
            "ghi": round(float(r["ghi_kwh_m2_day"]), 2), "wind50": round(float(r["wind50_m_s"]), 2),
            "precip": round(float(r["precip_mm_yr"])), "area_km2": round(float(r["area_km2"])),
            "open_pct": round(float(r["share_open"]) * 100, 1), "crop_pct": round(float(r["share_cropland"]) * 100, 1),
            "forest_pct": round(float(r["share_forest"]) * 100, 1), "terrain_excl_pct": round(float(r["share_excluded_terrain"]) * 100, 1),
        }
    zb = inp.base.groupby(["zone", "source"])["base_twh"].sum()
    regions = {
        "zones": ZONES, "states": states, "state": state_info,
        "zone_need_share": {z: [round(float(zshare.loc[y, z]), 5) for y in years5] for z in ZONES},
        "zone_base": {z: [round(float(zb.get((z, s), 0.0)), 1) for s in SRC6] for z in ZONES},
        "zone_fixed": {z: round(float(zb.get((z, "Bioenergy"), 0.0) + zb.get((z, "Other"), 0.0)), 1) for z in ZONES},
        "production_share_latest": {r.zone: round(float(r.production_share_latest), 4) for r in zr[zr.year == BASE_YEAR].itertuples()},
        "map": build_map(),
        # requirement ranges from the Monte Carlo (all generation incl. captive), per milestone: used by the terminal view
        "zone_req": {z: {q: [round(float(zr[(zr.zone == z) & (zr.year == y)][f"{q}_twh"].iloc[0]), 1) for y in years5]
                         for q in ("p10", "p50", "p90")} for z in ZONES},
        "state_req": {st: {q: [round(float(sr[(sr.state == st) & (sr.year == y)][f"{q}_twh"].iloc[0]), 2)
                               if ((sr.state == st) & (sr.year == y)).any() else None for y in years5]
                           for q in ("p10", "p50", "p90")} for st in states},
        "fixed_national": {f: round(float(inp.base[inp.base.source == f]["base_twh"].sum()), 2) for f in O.FIXED_SOURCES},
    }

    # ---- optimiser context -------------------------------------------------------
    p0 = O.Params()
    sol0, meta0 = O.solve(inp, p0)
    base_row = O.tidy(sol0, meta0, inp)["summary"].set_index("year").loc[BASE_YEAR]
    sh = pd.read_csv(PROCESSED / "monthly_shapes.csv")
    shapes = {z: {s: sh[(sh.zone == z) & (sh.source == s)].sort_values("month")["factor"].round(4).tolist()
                  for s in ["Solar", "Wind", "Hydro", "Nuclear", "Bioenergy", "Other"]} for z in ZONES}
    need_shape = pd.read_csv(PROCESSED / "need_shape.csv").sort_values("month")["factor"].round(4).tolist()
    build_limits = [round(O.build_limit(inp, p0, k, prev, y), 1)
                    for prev, y in zip([BASE_YEAR] + MILESTONES[:-1], MILESTONES) for k in O.BUILD_SOURCES]
    assumptions = {k: v for k, v in asdict(p0).items() if k not in ("name", "need_case", "extra_ub")}
    need_paths = {q: [round(float(inp.need.loc[y, f"{q}_twh"]), 1) for y in years5] for q in NEED_QUANTILES}
    optimiser = {
        "milestones": MILESTONES, "sources": SRC6, "opt_sources": O.OPT_SOURCES, "build_sources": O.BUILD_SOURCES, "reasons": REASONS,
        "axes": {"need_quantiles": NEED_QUANTILES, "need_family_twh": NEED_FAMILY_TWH, "carbon": CARBON,
                 "solar_land_pct": SOLAR_LAND_PCT, "wind_scale": WIND_SCALE, "new_coal": NEW_COAL, "clean_pace": CLEAN_PACE, "gas": GAS},
        "clean_pace_fast": CLEAN_PACE_FAST,
        "layout": {"z": "milestone x zone x source, TWh x10", "s": "2047: state x source, TWh x10",
                   "m": "milestone x month x [coal, gas, storage shift, curtailed, unserved (TWh x10), marginal cost (INR/kWh x100)]",
                   "k": "milestone x [need, generation, emissions MtCO2, storage shift, curtailed, unserved, transfer, avg cost INR/kWh]",
                   "r": "2047: state x opt_source, letter index into reasons ('-' = no entry)", "b": "milestone x build_source, TWh x10"},
        "base_summary": {"generation": round(float(base_row["generation_twh"]), 1), "emissions": round(float(base_row["emissions_mtco2"]), 1),
                         "clean_share": round(float(base_row["clean_share"]), 4), "transfer": round(float(base_row["transfer_twh"]), 1)},
        "runs": runs, "need_paths": need_paths, "shapes": shapes, "need_shape": need_shape, "build_limits": build_limits,
        "emission_factors": {k: round(v, 4) for k, v in inp.ef.items()}, "assumptions": assumptions,
        "pithead_states": O.PITHEAD_STATES, "nuclear_extra_states": O.NUCLEAR_EXTRA_STATES,
        "dispatch_bands": inp.bands, "build_rates": records(inp.build.reset_index(), 1),
        "resource_assumptions": json.load(open(PROCESSED / "resource_assumptions.json")),
        "gas_breakeven": records(pd.read_csv(OUTPUTS / "gas_breakeven.csv")),
        "ceiling_sensitivity": records(pd.read_csv(OUTPUTS / "ceiling_sensitivity.csv")),
    }

    # ---- compliance ----------------------------------------------------------------
    audits = pd.concat([pd.read_csv(PROCESSED / "compliance_audit_generation.csv"), pd.read_csv(PROCESSED / "compliance_audit_drivers.csv")])
    sources = audits[audits["source"].notna()][["table", "source", "kept", "dropped"]]
    tables = pd.concat([audits[audits["rows"].notna()][["table", "rows", "columns"]], pd.read_csv(OUTPUTS / "compliance_audit_forecast.csv")])
    tables = tables.drop_duplicates("table")
    chk = pd.read_csv(PROCESSED / "check_ember_vs_npp.csv")
    comp = {"sources": records(sources), "tables": records(tables), "banned_patterns": list(compliance.BANNED_COLUMN_PATTERNS),
            "ember_vs_npp": records(chk, 2), "utility_bridge": records(pd.read_csv(PROCESSED / "utility_bridge.csv"), 4)}

    bundle = {"generated": date.today().isoformat(), "base_year": BASE_YEAR, "target_year": TARGET_YEAR,
              "forecast": forecast, "regions": regions, "optimiser": optimiser, "compliance": comp,
              "themes": {**T.export(), "draws": pd.read_csv(OUTPUTS / "ensemble_draws.csv").values.round(0).astype(int).tolist()}}
    text = json.dumps(clean(bundle), separators=(",", ":"), allow_nan=False)
    (DASH / "data.js").write_text("window.DATA=" + text + ";\n")
    print(f"dashboard/data.js written: {len(text) / 1e6:.2f} MB; map {regions['map']['width']}x{regions['map']['height']}, "
          f"{sum(len(v['d']) for v in regions['map']['states'].values()) / 1e3:.0f} kB of paths")

    # ---- consistency: grid reproduces the published headline -----------------------
    idx = cases.index((("q", "p50"), 2000, SOLAR_LAND_DEFAULT, 1, 1, 0, 0))
    z = np.array(runs[idx]["z"]).reshape(len(MILESTONES), len(ZONES), len(SRC6))[-1].sum(axis=0) / 10
    ref = pd.read_csv(OUTPUTS / "mix_national.csv")
    ref = ref[(ref.strategy == "Balanced") & (ref.year == TARGET_YEAR)].set_index("source")["twh"]
    for s, v in zip(SRC6, z):
        if abs(v - ref[s]) > 1.0:
            raise AssertionError(f"grid headline differs from outputs/mix_national.csv for {s}: {v:.1f} vs {ref[s]:.1f}")
    uns = [(c, r["k"][-3]) for c, r in zip(cases, runs) if r["k"][-3] > 0.05]
    print(f"headline check passed; {len(uns)} of {len(runs)} cases leave some 2047 need unmet")
    for c, u in uns[:12]:
        print("  ", c, f"unserved {u:.0f} TWh")


if __name__ == "__main__":
    main()
