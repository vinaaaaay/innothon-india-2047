"""Step 7 - allocate generation by state, source and milestone year.

A linear programme, entirely in energy terms (TWh). For each milestone it chooses
how much each state generates from each source so that

  * every month's national requirement is met (seasonal shapes from observed generation),
  * solar beyond what daytime need can absorb is shifted through storage or curtailed,
  * no state exceeds its solar / wind / hydro resource ceiling,
  * nothing is built faster than a stated multiple of India's demonstrated pace,
  * coal declines no faster than a just-transition limit and the existing fleet ages,

at the lowest total cost of generation + storage + inter-zone transfer + carbon.
"""
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd

from config import MILESTONES, OUTPUTS, PROCESSED, STATES, ZONES
from lp import LP, Solution

OPT_SOURCES = ["Coal_existing", "Coal_new", "Gas", "Hydro", "Nuclear", "Solar", "Wind"]
FIXED_SOURCES = ["Bioenergy", "Other"]            # held at today's level
BUILD_SOURCES = ["Coal_new", "Gas", "Hydro", "Nuclear", "Solar", "Wind"]
REPORT_SOURCES = ["Coal", "Gas", "Nuclear", "Hydro", "Wind", "Solar", "Bioenergy", "Other"]
MONTHS = list(range(1, 13))
BASE_YEAR = 2025

# States with coal mines: fuel does not travel far, so generation is cheaper (assumption from basic geography).
PITHEAD_STATES = ["Chhattisgarh", "Jharkhand", "Odisha", "Madhya Pradesh", "West Bengal", "Telangana", "Maharashtra"]
# New nuclear is allowed where reactors already run, plus states with publicly announced sites (assumption).
NUCLEAR_EXTRA_STATES = ["Haryana", "Madhya Pradesh", "Andhra Pradesh"]


@dataclass
class Params:
    name: str = "Balanced"
    need_case: str = "p50"                 # p10 / p50 / p90 of the national forecast
    carbon_price: float = 2000.0           # INR per tonne CO2
    # Cost of generation, INR per kWh in 2025 money: (level in 2025, change per year)
    cost: dict = field(default_factory=lambda: {
        "Solar": (2.6, -0.015), "Wind": (3.4, -0.005), "Hydro": (5.5, 0.0), "Nuclear": (6.0, 0.0),
        "Coal_existing": (3.6, 0.0), "Coal_new": (6.2, 0.0), "Gas": (7.5, 0.0)})
    pithead_discount: float = 0.7          # INR per kWh cheaper coal in coal-mining states
    cost_existing: dict = field(default_factory=lambda: {"Hydro": 2.5, "Nuclear": 3.5, "Solar": 2.8, "Wind": 3.4})
    cost_fixed_sources: float = 5.0
    storage_cost: tuple = (4.0, -0.03)     # INR per kWh shifted from day to night
    storage_efficiency: float = 0.85
    transfer_cost: float = 0.5             # INR per kWh moved between zones
    unserved_cost: float = 1000.0          # high enough that every month is met; shortfalls are never traded for cost
    # Demonstrated build pace (TWh of new annual generation added per year) is read from history;
    # these are the yearly growth rates allowed on that pace.
    build_acceleration: dict = field(default_factory=lambda: {
        "Solar": 0.06, "Wind": 0.06, "Nuclear": 0.08, "Hydro": 0.0, "Gas": 0.0, "Coal_new": 0.0})
    build_pace_basis: dict = field(default_factory=lambda: {
        "Solar": "best_1y_add_twh", "Wind": "best_1y_add_twh", "Nuclear": "best_5y_avg_add_twh",
        "Hydro": "best_5y_avg_add_twh", "Gas": "best_5y_avg_add_twh", "Coal_new": "best_5y_avg_add_twh"})
    state_build_share: float = 0.30        # no state takes more than this share of a period's national build
    coal_max_decline: float = 0.05         # per year, per state (just-transition limit)
    coal_fleet_retire_from: int = 2035
    coal_fleet_retire_rate: float = 0.02   # per year after that
    coal_new_min_existing_twh: float = 5.0  # new coal only where a sizeable fleet already exists
    gas_keep_share: float = 0.5            # existing gas output that must keep running
    gas_existing_discount: float = 0.2     # INR per kWh cheaper where gas plants and pipelines already exist
    gas_max_multiple: float = 2.0          # gas output per state capped at this multiple of its best year on record
    gas_new_state_twh: float = 5.0         # allowance for states with no gas fleet today
    ceiling_scale: dict = field(default_factory=lambda: {"Solar": 1.0, "Wind": 1.0, "Hydro": 1.0})
    # Policy floor: national output must grow at least this multiple of the demonstrated pace
    # (reactors already under construction are not an economic choice any more).
    policy_floor_pace: dict = field(default_factory=lambda: {"Nuclear": 1.0})
    built_stays: tuple = ("Hydro", "Nuclear", "Solar", "Wind")   # capital-heavy output does not shrink once built
    # Daytime absorption of solar: a half-sine solar day against flat need gives 0.318.
    solar_direct_share: float = 0.318
    coal_min_load: float = 0.6             # share of coal output that cannot back down at midday
    hydro_must_run: float = 0.3
    extra_ub: dict = field(default_factory=dict)   # optional {(state, source): TWh cap} overrides


@dataclass
class Inputs:
    base: pd.DataFrame
    shapes: dict
    need_factor: dict
    bands: dict
    ef: dict
    build: pd.DataFrame
    res: pd.DataFrame
    need: pd.DataFrame
    zone_share: pd.DataFrame
    utility_share: float


def load_inputs() -> Inputs:
    import json
    base = pd.read_csv(PROCESSED / "base_mix_state.csv")
    sh = pd.read_csv(PROCESSED / "monthly_shapes.csv")
    shapes = {(r.zone, r.source, int(r.month)): r.factor for r in sh.itertuples()}
    nf = pd.read_csv(PROCESSED / "need_shape.csv")
    bands = pd.read_csv(PROCESSED / "dispatch_bands.csv").set_index("source")
    ef = pd.read_csv(PROCESSED / "emission_factors.csv").set_index("source")["tco2_per_mwh"].to_dict()
    build = pd.read_csv(PROCESSED / "build_rates.csv").set_index("source")
    res = pd.read_csv(PROCESSED / "resources_state.csv").set_index("state")
    fc = pd.read_csv(OUTPUTS / "forecast_national.csv")
    util = json.load(open(OUTPUTS / "model_parameters.json"))["utility_share_last3y"]
    need = fc[fc.series == "ensemble"].set_index("year")[["p10_twh", "p50_twh", "p90_twh"]] * util
    zr = pd.read_csv(OUTPUTS / "requirement_by_zone.csv").pivot(index="year", columns="zone", values="share_p50")
    zr = zr.div(zr.sum(axis=1), axis=0)
    return Inputs(base, shapes, dict(zip(nf.month, nf.factor)), bands.to_dict("index"), ef, build, res, need, zr, util)


def cost_at(level_change: tuple, year: int) -> float:
    return level_change[0] * (1 + level_change[1]) ** (year - BASE_YEAR)


def build_limit(inp: Inputs, p: Params, source: str, prev: int, year: int) -> float:
    key = "Coal" if source == "Coal_new" else source
    pace = float(inp.build.loc[key, p.build_pace_basis[source]])
    acc = p.build_acceleration[source]
    return sum(pace * (1 + acc) ** (y - BASE_YEAR) for y in range(prev + 1, year + 1))


def solve(inp: Inputs, p: Params) -> tuple[Solution, dict]:
    lp = LP()
    states = sorted(inp.base["state"].unique())
    zone_of = {s: STATES[s][0] for s in states}
    b = inp.base.set_index(["state", "source"])

    def base_val(s: str, src: str, col: str = "base_twh") -> float:
        return float(b[col].get((s, src), 0.0))

    solar_ref = float(inp.res["solar_yield_gwh_km2"].quantile(0.9))
    wind_ref = float(inp.res.loc[inp.res["wind_ceiling_twh"] > 1, "wind_yield_gwh_km2"].max())
    nuclear_ok = {s for s in states if base_val(s, "Nuclear") > 0} | set(NUCLEAR_EXTRA_STATES)
    meta = {"states": states, "zone_of": zone_of, "lb": {}, "ub": {}, "unit_cost": {}, "build_limit": {}, "need": {}}

    def unit_cost(s: str, k: str, year: int) -> float:
        c = cost_at(p.cost[k], year)
        if k == "Solar":
            c *= float(np.clip(solar_ref / inp.res.loc[s, "solar_yield_gwh_km2"], 0.9, 1.5))
        elif k == "Wind":
            y = inp.res.loc[s, "wind_yield_gwh_km2"]
            c *= float(np.clip(wind_ref / y, 1.0, 1.5)) if y > 0 else 1.5
        elif k in ("Coal_existing", "Coal_new") and s in PITHEAD_STATES:
            c -= p.pithead_discount
        elif k == "Gas" and base_val(s, "Gas") > 0.5:
            c -= p.gas_existing_discount
        ef = inp.ef["Coal"] if k.startswith("Coal") else inp.ef[k]
        return c + p.carbon_price * ef / 1000

    prev_year = BASE_YEAR
    weights = {}
    for year in MILESTONES:
        w = year - prev_year
        weights[year] = w
        need_total = float(inp.need.loc[year, f"{p.need_case}_twh"])
        meta["need"][year] = need_total
        fleet = (1 - p.coal_fleet_retire_rate) ** max(0, year - p.coal_fleet_retire_from)

        # ---- generation variables --------------------------------------------
        for s in states:
            coal_best = base_val(s, "Coal", "best_12m_twh")
            lo_hi = {
                "Coal_existing": (0.0, coal_best * fleet),
                "Coal_new": (0.0, None if coal_best >= p.coal_new_min_existing_twh else 0.0),
                "Gas": (p.gas_keep_share * base_val(s, "Gas"),
                        max(p.gas_max_multiple * base_val(s, "Gas", "best_12m_twh"), p.gas_new_state_twh)),
                "Hydro": (base_val(s, "Hydro", "avg_3y_twh"), max(p.ceiling_scale["Hydro"] * inp.res.loc[s, "hydro_ceiling_twh"], base_val(s, "Hydro", "avg_3y_twh"))),
                "Nuclear": (base_val(s, "Nuclear"), None if s in nuclear_ok else base_val(s, "Nuclear")),
                "Solar": (base_val(s, "Solar"), max(p.ceiling_scale["Solar"] * inp.res.loc[s, "solar_ceiling_twh"], base_val(s, "Solar"))),
                "Wind": (base_val(s, "Wind"), max(p.ceiling_scale["Wind"] * inp.res.loc[s, "wind_ceiling_twh"], base_val(s, "Wind"))),
            }
            for k, (lo, hi) in lo_hi.items():
                if (s, k) in p.extra_ub:
                    hi = max(lo, p.extra_ub[(s, k)])
                uc = unit_cost(s, k, year)
                lp.var(f"g|{s}|{k}|{year}", lb=lo, ub=hi, cost=w * uc)
                meta["lb"][(s, k, year)], meta["ub"][(s, k, year)], meta["unit_cost"][(s, k, year)] = lo, hi, uc

            # coal cannot be wound down faster than the just-transition limit
            floor = (1 - p.coal_max_decline) ** w
            coefs = {f"g|{s}|Coal_existing|{year}": 1.0, f"g|{s}|Coal_new|{year}": 1.0}
            if prev_year == BASE_YEAR:
                lp.ge(coefs, floor * base_val(s, "Coal"), f"coal_floor|{s}|{year}")
            else:
                coefs[f"g|{s}|Coal_existing|{prev_year}"] = -floor
                coefs[f"g|{s}|Coal_new|{prev_year}"] = -floor
                lp.ge(coefs, 0.0, f"coal_floor|{s}|{year}")

        # ---- what is built stays; committed pipelines ---------------------------
        if prev_year != BASE_YEAR:
            for s in states:
                for k in p.built_stays:
                    lp.ge({f"g|{s}|{k}|{year}": 1.0, f"g|{s}|{k}|{prev_year}": -1.0}, 0.0, f"stays|{s}|{k}|{year}")
        for k, mult in p.policy_floor_pace.items():
            pace = float(inp.build.loc[k, p.build_pace_basis[k]])
            start_total = sum(meta["lb"][(s, k, year)] for s in states)
            lp.ge({f"g|{s}|{k}|{year}": 1.0 for s in states}, start_total + mult * pace * (year - BASE_YEAR), f"policy_floor|{k}|{year}")

        # ---- build-pace limits ---------------------------------------------------
        for k in BUILD_SOURCES:
            limit = build_limit(inp, p, k, prev_year, year)
            meta["build_limit"][(k, year)] = limit
            adds = {}
            for s in states:
                a = lp.var(f"a|{s}|{k}|{year}", lb=0.0, ub=p.state_build_share * limit)
                adds[a] = 1.0
                coefs = {a: 1.0, f"g|{s}|{k}|{year}": -1.0}
                if prev_year == BASE_YEAR:
                    start = 0.0 if k == "Coal_new" else meta["lb"][(s, k, year)] if k in ("Hydro", "Nuclear") else base_val(s, k)
                    lp.ge(coefs, -start, f"add_def|{s}|{k}|{year}")
                else:
                    coefs[f"g|{s}|{k}|{prev_year}"] = 1.0
                    lp.ge(coefs, 0.0, f"add_def|{s}|{k}|{year}")
            lp.le(adds, limit, f"build|{k}|{year}")

        # ---- monthly balance, dispatch bands, daytime absorption of solar -------
        fixed_by_zone = {z: sum(base_val(s, f) for s in states if zone_of[s] == z for f in FIXED_SOURCES) for z in ZONES}
        for name, src in (("c", "Coal"), ("q", "Gas")):
            total = {f"g|{s}|{k}|{year}": -1.0 for s in states for k in (["Coal_existing", "Coal_new"] if src == "Coal" else ["Gas"])}
            month_vars = {}
            for m in MONTHS:
                v = lp.var(f"{name}|{m}|{year}")
                month_vars[v] = 1.0
                lo, hi = inp.bands[src]["min_factor"], inp.bands[src]["max_factor"]
                lp.ge({v: 1.0, **{kk: vv * lo / 12 for kk, vv in total.items()}}, 0.0, f"{name}_min|{m}|{year}")
                lp.le({v: 1.0, **{kk: vv * hi / 12 for kk, vv in total.items()}}, 0.0, f"{name}_max|{m}|{year}")
            lp.eq({**month_vars, **total}, 0.0, f"{name}_sum|{year}")

        storage_c = cost_at(p.storage_cost, year)
        cuts = [(np.sqrt(1 - r * r), np.arccos(r)) for r in (0.97, 0.9, 0.8, 0.65, 0.5, 0.35, 0.2, 0.05)]
        for m in MONTHS:
            need_m = need_total * inp.need_factor[m] / 12
            sh = lp.var(f"shift|{m}|{year}", cost=w * storage_c)
            cu = lp.var(f"curtail|{m}|{year}")
            un = lp.var(f"unserved|{m}|{year}", cost=w * p.unserved_cost)
            bal = {f"c|{m}|{year}": 1.0, f"q|{m}|{year}": 1.0, cu: -1.0, sh: -(1 - p.storage_efficiency), un: 1.0}
            solar, mustrun = {}, {f"c|{m}|{year}": p.coal_min_load}
            fixed_m = 0.0
            for s in states:
                z = zone_of[s]
                for k in ("Hydro", "Nuclear", "Solar", "Wind"):
                    f = inp.shapes[(z, k, m)] / 12
                    bal[f"g|{s}|{k}|{year}"] = f
                    if k == "Solar":
                        solar[f"g|{s}|{k}|{year}"] = f
                    else:
                        mustrun[f"g|{s}|{k}|{year}"] = f * (p.hydro_must_run if k == "Hydro" else 1.0)
            for z in ZONES:
                fixed_m += fixed_by_zone[z] * np.mean([inp.shapes[(z, f, m)] for f in FIXED_SOURCES]) / 12
            lp.eq(bal, need_m - fixed_m, f"balance|{m}|{year}")
            # overflow of a half-sine solar day above the room left by must-run output (piecewise-linear, convex)
            for j, (alpha, beta) in enumerate(cuts):
                coefs = {sh: 1.0, cu: 1.0}
                for kk, vv in solar.items():
                    coefs[kk] = coefs.get(kk, 0.0) - alpha * vv
                for kk, vv in mustrun.items():
                    coefs[kk] = coefs.get(kk, 0.0) - beta * p.solar_direct_share * vv
                lp.ge(coefs, -beta * p.solar_direct_share * (need_m - fixed_m), f"solar_room|{m}|{j}|{year}")

        # ---- inter-zone transfers ---------------------------------------------------
        shares = inp.zone_share.loc[year]
        all_g = {f"g|{s}|{k}|{year}": 1.0 for s in states for k in OPT_SOURCES}
        fixed_total = sum(fixed_by_zone.values())
        for z in ZONES:
            x = lp.var(f"export|{z}|{year}", cost=w * p.transfer_cost)
            coefs = {x: 1.0}
            for kk in all_g:
                s = kk.split("|")[1]
                coefs[kk] = (-1.0 if zone_of[s] == z else 0.0) + float(shares[z])
            lp.ge(coefs, fixed_by_zone[z] - float(shares[z]) * fixed_total, f"export_def|{z}|{year}")
        prev_year = year

    meta["weights"] = weights
    meta["params"] = p
    return lp.solve(), meta


# --------------------------------------------------------------------------
# Reading the solution
# --------------------------------------------------------------------------
def tidy(sol: Solution, meta: dict, inp: Inputs) -> dict[str, pd.DataFrame]:
    p: Params = meta["params"]
    states, zone_of = meta["states"], meta["zone_of"]
    b = inp.base.set_index(["state", "source"])
    tol = 1e-4
    rows, why = [], []
    for s in states:                      # base year, as observed
        for src in REPORT_SOURCES:
            rows.append({"year": BASE_YEAR, "state": s, "zone": zone_of[s], "source": src,
                         "twh": float(b["base_twh"].get((s, src), 0.0))})
    prev = BASE_YEAR
    for year in MILESTONES:
        for s in states:
            vals = {k: sol.x[f"g|{s}|{k}|{year}"] for k in OPT_SOURCES}
            out = {"Coal": vals["Coal_existing"] + vals["Coal_new"], **{k: vals[k] for k in ("Gas", "Hydro", "Nuclear", "Solar", "Wind")}}
            for f in FIXED_SOURCES:
                out[f] = float(b["base_twh"].get((s, f), 0.0))
            for src in REPORT_SOURCES:
                rows.append({"year": year, "state": s, "zone": zone_of[s], "source": src, "twh": out[src]})
            for k in OPT_SOURCES:
                g, lo, hi = vals[k], meta["lb"][(s, k, year)], meta["ub"][(s, k, year)]
                if g < 0.05 and (hi is None or hi > 0.05) and k not in ("Coal_new",):
                    continue
                if k in BUILD_SOURCES:
                    a = sol.x[f"a|{s}|{k}|{year}"]
                    limit = meta["build_limit"][(k, year)]
                    nat_dual = sol.dual.get(f"build|{k}|{year}", 0.0)
                else:
                    a, limit, nat_dual = 0.0, 0.0, 0.0
                if hi is not None and hi > 0 and g >= hi - tol and k in ("Solar", "Wind", "Hydro"):
                    reason = "at resource ceiling"
                elif k == "Gas" and hi is not None and g >= hi - tol and g > tol:
                    reason = "at fuel-infrastructure cap"
                elif k in p.policy_floor_pace and g > lo + tol and sol.slack.get(f"policy_floor|{k}|{year}", 1.0) < tol:
                    reason = "committed pipeline (policy floor)"
                elif k == "Coal_existing" and hi is not None and g >= hi - tol and hi > 0:
                    reason = "existing fleet at full output"
                elif k in BUILD_SOURCES and a >= p.state_build_share * limit - tol and a > tol:
                    reason = "at state share of national build pace"
                elif k in BUILD_SOURCES and a > tol and abs(nat_dual) > 1e-7:
                    reason = "limited by national build pace"
                elif k in BUILD_SOURCES and a > tol:
                    reason = "expanding, cost-optimal"
                elif g <= lo + tol and lo > 0:
                    reason = "held at existing level"
                elif k.startswith("Coal") and sol.slack.get(f"coal_floor|{s}|{year}", 1.0) < tol and g > tol:
                    reason = "declining at just-transition limit"
                elif g <= tol:
                    reason = "not selected" if (hi is None or hi > 0) else "not available"
                else:
                    reason = "cost-optimal"
                why.append({"year": year, "state": s, "zone": zone_of[s], "source": k, "twh": g, "added_twh": a,
                            "lower_bound": lo, "upper_bound": hi, "unit_cost_inr_kwh": meta["unit_cost"][(s, k, year)],
                            "reduced_cost_inr_kwh": sol.reduced_cost[f"g|{s}|{k}|{year}"] / meta["weights"][year], "reason": reason})
        prev = year
    mix = pd.DataFrame(rows)

    # system summary per year
    summ, zrows, months = [], [], []
    for year in [BASE_YEAR] + MILESTONES:
        d = mix[mix.year == year]
        by_src = d.groupby("source")["twh"].sum()
        gen = by_src.sum()
        em = sum(by_src.get(s, 0.0) * inp.ef.get(s, 0.0) for s in REPORT_SOURCES)        # TWh x tCO2/MWh = MtCO2
        row = {"year": year, "generation_twh": gen, "emissions_mtco2": em, "intensity_gco2_kwh": em / gen * 1000,
               "clean_share": 1 - (by_src.get("Coal", 0) + by_src.get("Gas", 0) + by_src.get("Other", 0)) / gen}
        make = d.groupby("zone")["twh"].sum()
        if year == BASE_YEAR:
            shares = inp.zone_share.loc[BASE_YEAR] if BASE_YEAR in inp.zone_share.index else inp.zone_share.iloc[0]
            row.update({"need_twh": gen, "storage_shift_twh": 0.0, "curtailed_twh": 0.0, "unserved_twh": 0.0,
                        "transfer_twh": float(np.clip(make - shares * gen, 0, None).sum())})
        else:
            w = meta["weights"][year]
            shares = inp.zone_share.loc[year]
            shift = sum(sol.x[f"shift|{m}|{year}"] for m in MONTHS)
            curt = sum(sol.x[f"curtail|{m}|{year}"] for m in MONTHS)
            uns = sum(sol.x[f"unserved|{m}|{year}"] for m in MONTHS)
            gen_cost = 0.0
            for s in states:
                for k in OPT_SOURCES:
                    g, lo = sol.x[f"g|{s}|{k}|{year}"], meta["lb"][(s, k, year)]
                    carbon = p.carbon_price * (inp.ef["Coal"] if k.startswith("Coal") else inp.ef[k]) / 1000
                    new_c = meta["unit_cost"][(s, k, year)] - carbon
                    old_c = p.cost_existing.get(k, new_c)
                    gen_cost += old_c * min(g, lo) + new_c * max(g - lo, 0.0)
                gen_cost += p.cost_fixed_sources * sum(float(b["base_twh"].get((s, f), 0.0)) for f in FIXED_SOURCES)
            stor_cost = cost_at(p.storage_cost, year) * shift
            xfer = sum(sol.x[f"export|{z}|{year}"] for z in ZONES)
            row.update({"need_twh": meta["need"][year], "storage_shift_twh": shift, "curtailed_twh": curt, "unserved_twh": uns,
                        "transfer_twh": xfer, "generation_cost_inr_bn": gen_cost, "storage_cost_inr_bn": stor_cost,
                        "transfer_cost_inr_bn": p.transfer_cost * xfer, "carbon_cost_inr_bn": p.carbon_price * em / 1000,
                        "avg_cost_inr_kwh": (gen_cost + stor_cost + p.transfer_cost * xfer) / meta["need"][year]})
            for m in MONTHS:
                months.append({"year": year, "month": m, "need_twh": meta["need"][year] * inp.need_factor[m] / 12,
                               "coal_twh": sol.x[f"c|{m}|{year}"], "gas_twh": sol.x[f"q|{m}|{year}"],
                               "storage_shift_twh": sol.x[f"shift|{m}|{year}"], "curtailed_twh": sol.x[f"curtail|{m}|{year}"],
                               "marginal_cost_inr_kwh": sol.dual[f"balance|{m}|{year}"] / w})
        summ.append(row)
        for z in ZONES:
            zrows.append({"year": year, "zone": z, "made_twh": float(make.get(z, 0.0)), "need_share": float(shares[z]),
                          "need_twh": float(shares[z]) * gen, "net_export_twh": float(make.get(z, 0.0)) - float(shares[z]) * gen})

    builds = [{"year": y, "source": k, "limit_twh": lim,
               "used_twh": sum(sol.x[f"a|{s}|{k}|{y}"] for s in states), "shadow_price_inr_kwh": -sol.dual[f"build|{k}|{y}"] / meta["weights"][y]}
              for (k, y), lim in meta["build_limit"].items()]
    return {"mix": mix, "why": pd.DataFrame(why), "summary": pd.DataFrame(summ), "zone_balance": pd.DataFrame(zrows),
            "monthly": pd.DataFrame(months), "build": pd.DataFrame(builds)}
