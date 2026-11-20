"""Steps 3-4 - hindcast, Monte Carlo 2047 forecast, regional requirement.

Reads data/processed/, writes outputs/*.csv, outputs/model_parameters.json
and outputs/figures/*.png.
"""
import json
import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd

import compliance
import forecast as F
from config import BASE_YEAR, FIGURES, MILESTONES, OUTPUTS, PROCESSED, STATES, TARGET_YEAR, ZONES

LENSES = ["india", "ladder", "panel"]
LENS_LABEL = {"india": "India's own history", "ladder": "Development ladder", "panel": "Global panel + urbanisation"}
HINDCAST_ORIGINS = [2005, 2010, 2015]
N_DRAWS = 4000
N_LADDER_BOOT = 300
N_REGIONAL_DRAWS = 600
N_SIGNPOST_DRAWS = 1000
SEED = 2047

# ---- Assumptions (all exposed so the dashboard can vary them) -------------
SCENARIOS = {            # real GDP growth %, first forecast year -> 2047
    "Slow": (5.5, 4.0),
    "Base": (6.5, 5.0),
    "Viksit Bharat": (8.0, 7.0),
}
GROWTH_SD = 0.8                    # pts, uncertainty on the average growth rate
GROWTH_CLIP = 2.0
POP_SD = 0.015                     # relative uncertainty on 2047 population
URBAN_TRIANGLE = (41.0, 42.2, 50.0)  # % urban in 2047: low, mode (World Bank projection), high
CYCLE_SD = 0.025                   # weather / business-cycle scatter around trend (log)
WEIGHT_CAP = 0.5                   # no single lens above this share of the ensemble
POP_TREND_DECAY = 0.97


def percentiles(a: np.ndarray, axis: int = 0) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    return tuple(np.percentile(a, q, axis=axis) for q in (10, 50, 90))


def main() -> None:
    warnings.filterwarnings("ignore", category=FutureWarning)
    OUTPUTS.mkdir(exist_ok=True)
    FIGURES.mkdir(exist_ok=True)
    rng = np.random.default_rng(SEED)

    nat = pd.read_csv(PROCESSED / "drivers_national.csv")
    panel = pd.read_csv(PROCESSED / "panel_countries.csv")
    state = pd.read_csv(PROCESSED / "drivers_state.csv")
    bridge = pd.read_csv(PROCESSED / "utility_bridge.csv")
    zone_gen = pd.read_csv(PROCESSED / "generation_zone_source_year.csv")
    for name, df in [("drivers_national", nat), ("panel_countries", panel), ("drivers_state", state),
                     ("generation_zone_source_year", zone_gen)]:
        compliance.assert_clean(df, name)

    base = nat.set_index("year").loc[BASE_YEAR]
    anchor = float(np.log(base["generation_pc_kwh"]))
    utility_share = float(bridge["utility_share"].tail(3).mean())

    # ---- Hindcast and weights --------------------------------------------
    hc = F.hindcast(nat, panel, HINDCAST_ORIGINS, BASE_YEAR)
    weights = F.lens_weights(hc, LENSES, WEIGHT_CAP)
    hc_summary = (hc[hc.year == BASE_YEAR].pivot(index="origin", columns="lens", values="predicted_twh")
                  .assign(actual=base["generation_twh"]))
    hc_err = hc[hc.year == BASE_YEAR].pivot(index="origin", columns="lens", values="log_error").mul(100)

    # ---- Fit every lens on the full history -------------------------------
    india = F.fit_india(nat, BASE_YEAR)
    cb = F.country_band_medians(F.ladder_windows(panel, BASE_YEAR))
    ladder = F.LadderCurve(cb)
    ladders = F.bootstrap_ladders(cb, N_LADDER_BOOT, rng)
    pfit = F.fit_panel(panel, BASE_YEAR)
    conv = F.estimate_convergence(state)

    years = np.arange(BASE_YEAR, TARGET_YEAR + 1)
    wv = weights.values

    # ---- Deterministic scenarios ------------------------------------------
    scen_rows = []
    for name, (g0, g1) in SCENARIOS.items():
        path = F.scenario_path(nat, BASE_YEAR, TARGET_YEAR, g0, g1)
        preds = {
            "india": F.to_twh(india.predict_ln(path), path.population),
            "ladder": F.to_twh(ladder.predict_ln(path, anchor), path.population),
            "panel": F.to_twh(pfit.predict_ln(path, anchor), path.population),
        }
        ens = sum(wv[i] * preds[l] for i, l in enumerate(LENSES))
        for k, yr in enumerate(years):
            scen_rows.append({"scenario": name, "year": int(yr), "gdp_growth_start": g0, "gdp_growth_end": g1,
                              "population": path.population[k], "gdp_pc_ppp": path.gdp_pc[k], "urban_share": path.urban[k] * 100,
                              **{f"{l}_twh": preds[l][k] for l in LENSES}, "ensemble_twh": ens[k]})
    scen = pd.DataFrame(scen_rows)

    # ---- Monte Carlo -------------------------------------------------------
    n_y = len(years)
    draws = np.empty((N_DRAWS, len(LENSES), n_y))
    drivers_2047 = np.empty((N_DRAWS, 3))
    ramp = np.minimum(1.0, (years - BASE_YEAR) / 3.0)
    reg_rows = []
    milestone_years = np.array([BASE_YEAR] + MILESTONES)
    m_idx = milestone_years - BASE_YEAR
    for d in range(N_DRAWS):
        shift = float(np.clip(rng.normal(0, GROWTH_SD), -GROWTH_CLIP, GROWTH_CLIP))
        g0, g1 = SCENARIOS["Base"]
        path = F.scenario_path(nat, BASE_YEAR, TARGET_YEAR, g0 + shift, g1 + shift,
                               pop_scale=rng.normal(1, POP_SD), urban_target=rng.triangular(*URBAN_TRIANGLE))
        curve = ladders[rng.integers(N_LADDER_BOOT)]
        cyc = rng.normal(0, CYCLE_SD, size=3)
        draws[d, 0] = F.to_twh(india.predict_ln(path, rng.multivariate_normal(india.params, india.cov)) + cyc[0] * ramp, path.population)
        draws[d, 1] = F.to_twh(curve.predict_ln(path, anchor) + cyc[1] * ramp, path.population)
        draws[d, 2] = F.to_twh(pfit.predict_ln(path, anchor, rng.multivariate_normal(pfit.params, pfit.cov)) + cyc[2] * ramp, path.population)
        drivers_2047[d] = [path.population[-1], path.gdp_pc[-1], path.urban[-1] * 100]

        if d < N_REGIONAL_DRAWS:
            sub = F.DriverPath(milestone_years, path.population[m_idx], path.gdp_pc[m_idx], path.urban[m_idx])
            sr = F.state_requirement(state, sub, curve, rng.normal(conv["beta"], conv["se"]), POP_TREND_DECAY)
            sr["draw"] = d
            reg_rows.append(sr[["draw", "state", "year", "requirement_share"]])

    pick = rng.choice(len(LENSES), size=N_DRAWS, p=wv / wv.sum())
    ensemble = draws[np.arange(N_DRAWS), pick, :]

    # How much does the headline depend on the weighting rule?
    weight_sens = {}
    alt_rules = {"hindcast_capped (headline)": wv, "equal": np.ones(len(LENSES)) / len(LENSES),
                 "hindcast_uncapped": F.lens_weights(hc, LENSES, cap=None).values}
    for rule, w_alt in alt_rules.items():
        alt = draws[np.arange(N_DRAWS), np.random.default_rng(SEED + 1).choice(len(LENSES), size=N_DRAWS, p=w_alt / w_alt.sum()), -1]
        weight_sens[rule] = {"weights": dict(zip(LENSES, np.round(w_alt, 3).tolist())),
                             "p10": float(np.percentile(alt, 10)), "p50": float(np.median(alt)), "p90": float(np.percentile(alt, 90))}

    fc_rows = []
    for label, arr in [("ensemble", ensemble)] + [(l, draws[:, i, :]) for i, l in enumerate(LENSES)]:
        p10, p50, p90 = percentiles(arr)
        for k, yr in enumerate(years):
            fc_rows.append({"series": label, "year": int(yr), "p10_twh": p10[k], "p50_twh": p50[k], "p90_twh": p90[k],
                            "mean_twh": arr[:, k].mean(), "p50_utility_twh": p50[k] * utility_share})
    fc = pd.DataFrame(fc_rows)

    # ---- Regional requirement ----------------------------------------------
    base_path = F.scenario_path(nat, BASE_YEAR, TARGET_YEAR, *SCENARIOS["Base"])
    sub = F.DriverPath(milestone_years, base_path.population[m_idx], base_path.gdp_pc[m_idx], base_path.urban[m_idx])
    st_base = F.state_requirement(state, sub, ladder, conv["beta"], POP_TREND_DECAY)
    st_base["zone"] = st_base["state"].map(lambda s: STATES[s][0])

    reg = pd.concat(reg_rows, ignore_index=True)
    reg["zone"] = reg["state"].map(lambda s: STATES[s][0])
    ens_by_draw = pd.DataFrame(ensemble[:N_REGIONAL_DRAWS][:, m_idx], columns=milestone_years).rename_axis("draw").reset_index().melt(
        id_vars="draw", var_name="year", value_name="national_twh")
    ens_by_draw["year"] = ens_by_draw["year"].astype(int)

    def summarise(level: str) -> pd.DataFrame:
        g = reg.groupby(["draw", "year", level], as_index=False)["requirement_share"].sum().merge(ens_by_draw, on=["draw", "year"])
        g["twh"] = g["requirement_share"] * g["national_twh"]
        out = g.groupby([level, "year"]).agg(
            share_p50=("requirement_share", "median"),
            p10_twh=("twh", lambda s: np.percentile(s, 10)), p50_twh=("twh", "median"),
            p90_twh=("twh", lambda s: np.percentile(s, 90))).reset_index()
        return out

    zone_req = summarise("zone")
    state_req = summarise("state").merge(
        st_base[["state", "zone", "year", "population", "income_relative", "gdp_pc_ppp"]], on=["state", "year"])
    # Present-day comparison: where generation is actually produced (utility basis, latest full year).
    gy = zone_gen["year"].max()
    made = zone_gen[zone_gen.year == gy].groupby("zone")["twh"].sum()
    zone_req["production_share_latest"] = zone_req["zone"].map(made / made.sum())
    zone_req["production_twh_latest"] = zone_req["zone"].map(made)
    zone_req["production_year"] = gy

    # ---- Save ----------------------------------------------------------------
    hc.to_csv(OUTPUTS / "hindcast.csv", index=False)
    scen.to_csv(OUTPUTS / "forecast_scenarios.csv", index=False)
    fc.to_csv(OUTPUTS / "forecast_national.csv", index=False)
    zone_req.to_csv(OUTPUTS / "requirement_by_zone.csv", index=False)
    state_req.to_csv(OUTPUTS / "requirement_by_state.csv", index=False)
    boot_eps = np.array([c.elasticity(ladder.nodes) for c in ladders])
    curve_tbl = ladder.table.reset_index().assign(
        band=lambda t: t["band"].astype(str), income_node=np.exp(ladder.nodes),
        p10=np.percentile(boot_eps, 10, axis=0), p90=np.percentile(boot_eps, 90, axis=0)).rename(
        columns={"median": "elasticity_median", "count": "n_countries"})
    curve_tbl.to_csv(OUTPUTS / "ladder_curve.csv", index=False)
    cb.assign(band=cb["band"].astype(str)).to_csv(OUTPUTS / "ladder_country_bands.csv", index=False)

    # Thinned draws for the dashboard's signpost updating (Bayesian re-weighting of futures).
    pd.DataFrame(ensemble[:N_SIGNPOST_DRAWS].round(1), columns=years).to_csv(OUTPUTS / "ensemble_draws.csv", index=False)

    e47 = ensemble[:, -1]
    params = {
        "base_year": BASE_YEAR, "target_year": TARGET_YEAR,
        "base_generation_twh": float(base["generation_twh"]), "base_generation_pc_kwh": float(base["generation_pc_kwh"]),
        "definition": "total electricity generation incl. captive (OWID/Ember/Energy Institute), calendar year",
        "utility_share_last3y": utility_share,
        "weights": weights.round(4).to_dict(), "weight_rule": f"inverse hindcast MSE over all years, capped at {WEIGHT_CAP}",
        "india_lens": {"elasticity": float(india.params[1]), "se": float(np.sqrt(india.cov[1, 1])), "rho": india.rho,
                       "base_year_residual": india.last_resid},
        "panel_lens": {"ln_income": float(pfit.params[0]), "ln_income_sq": float(pfit.params[1]), "urban_share": float(pfit.params[2]),
                       "se": np.sqrt(np.diag(pfit.cov)).round(4).tolist(), "n_countries": pfit.n_countries,
                       "income_elasticity_at_10k": pfit.income_elasticity(10000), "income_elasticity_at_30k": pfit.income_elasticity(30000)},
        "ladder_lens": {"n_countries": int(cb["iso"].nunique()), "n_windows": int(len(F.ladder_windows(panel, BASE_YEAR)))},
        "state_convergence": conv,
        "assumptions": {"scenarios_gdp_growth_pct": SCENARIOS, "growth_sd_pts": GROWTH_SD, "population_sd": POP_SD,
                        "urban_2047_triangle_pct": URBAN_TRIANGLE, "cycle_sd_log": CYCLE_SD,
                        "population_share_trend_decay": POP_TREND_DECAY, "n_draws": N_DRAWS, "seed": SEED},
        "weight_sensitivity_2047_twh": weight_sens,
        "result_2047_twh": {"p10": float(np.percentile(e47, 10)), "p50": float(np.median(e47)), "p90": float(np.percentile(e47, 90)),
                            "mean": float(e47.mean())},
        "drivers_2047_median": {"population": float(np.median(drivers_2047[:, 0])), "gdp_pc_ppp": float(np.median(drivers_2047[:, 1])),
                                "urban_share_pct": float(np.median(drivers_2047[:, 2]))},
    }
    json.dump(params, open(OUTPUTS / "model_parameters.json", "w"), indent=2)
    compliance.audit_frame().to_csv(OUTPUTS / "compliance_audit_forecast.csv", index=False)

    # ---- Report --------------------------------------------------------------
    pd.set_option("display.width", 220)
    print("HINDCAST - predicted 2025 generation (TWh) from each origin, using drivers that actually occurred")
    print(hc_summary.round(0).to_string())
    print("log error at 2025 (%):")
    print(hc_err.round(1).to_string())
    print("\nensemble weights:", weights.round(3).to_dict())
    print(f"\nLENS PARAMETERS  india elasticity {india.params[1]:.3f} (se {np.sqrt(india.cov[1, 1]):.3f}), rho {india.rho:.2f}")
    print(f"  panel: income elasticity {pfit.income_elasticity(10000):.2f} at $10k -> {pfit.income_elasticity(30000):.2f} at $30k;"
          f" urban coefficient {pfit.params[2]:.2f} (se {np.sqrt(pfit.cov[2, 2]):.2f}); {pfit.n_countries} countries")
    print("  ladder (median elasticity by income band, 10-90 % bootstrap):")
    print(curve_tbl.round(2).to_string(index=False))
    print(f"  state convergence beta {conv['beta']:.4f}/yr (se {conv['se']:.4f}, p={conv['p_value']:.2f}, {conv['n_states']} states)")

    print("\nSCENARIOS - 2047 generation requirement (TWh)")
    s47 = scen[scen.year == TARGET_YEAR].set_index("scenario")
    print(s47[["gdp_pc_ppp", "urban_share", "india_twh", "ladder_twh", "panel_twh", "ensemble_twh"]].round(0).to_string())

    print("\nMONTE CARLO - national requirement (TWh, total generation)")
    print(fc[(fc.series == "ensemble") & fc.year.isin(MILESTONES)].round(0).to_string(index=False))
    print("2047 by lens:")
    print(fc[(fc.year == TARGET_YEAR)].round(0)[["series", "p10_twh", "p50_twh", "p90_twh"]].to_string(index=False))
    print(f"2047 P50 = {np.median(e47) / base['generation_twh']:.2f}x the 2025 level; "
          f"CAGR {((np.median(e47) / base['generation_twh']) ** (1 / (TARGET_YEAR - BASE_YEAR)) - 1) * 100:.2f} %")

    print("weighting-rule sensitivity (2047 TWh):")
    for rule, v in weight_sens.items():
        print(f"  {rule:28s} weights {v['weights']}  P10 {v['p10']:,.0f}  P50 {v['p50']:,.0f}  P90 {v['p90']:,.0f}")

    print(f"\nREQUIREMENT BY ZONE (TWh, total-generation basis) and where generation is made today ({gy}, utility basis)")
    z = zone_req[zone_req.year.isin([BASE_YEAR, TARGET_YEAR])].pivot(index="zone", columns="year", values=["share_p50", "p50_twh"]).reindex(ZONES)
    z[("production_share", gy)] = (made / made.sum()).reindex(ZONES)
    print(z.round(3).to_string())
    bu = st_base.groupby("year")["bottom_up_multiple"].first()
    nat_ladder = scen[(scen.scenario == "Base") & scen.year.isin(MILESTONES)].set_index("year")["ladder_twh"] / base["generation_twh"]
    pop_mult = pd.Series(sub.population / sub.population[0], index=milestone_years)
    print("\nstate-resolved ladder vs national ladder (multiple of 2025, Base scenario):")
    print(pd.DataFrame({"state_resolved": bu, "national": nat_ladder}).dropna().round(3).to_string())

    make_figures(nat, hc, fc, cb, ladder, curve_tbl, zone_req, made, base_path)


# --------------------------------------------------------------------------
# Figures (static checks; the interactive dashboard is built separately)
# --------------------------------------------------------------------------
INK, INK2, GRID, SURFACE = "#0b0b0b", "#52514e", "#e4e3df", "#fcfcfb"
C = {"india": "#2a78d6", "ladder": "#eb6834", "panel": "#1baf7a", "ensemble": "#0b0b0b", "actual": "#52514e"}


def _style(ax, title: str, ylabel: str) -> None:
    ax.set_facecolor(SURFACE)
    ax.set_title(title, loc="left", fontsize=12, color=INK, pad=12)
    ax.set_ylabel(ylabel, color=INK2, fontsize=9)
    ax.grid(axis="y", color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    for s in ("top", "right", "left"):
        ax.spines[s].set_visible(False)
    ax.spines["bottom"].set_color(GRID)
    ax.tick_params(colors=INK2, labelsize=9, length=0)


def make_figures(nat, hc, fc, cb, ladder, curve_tbl, zone_req, made, base_path) -> None:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    hist = nat.dropna(subset=["generation_twh"])

    # 1. Fan chart
    fig, ax = plt.subplots(figsize=(9, 5), facecolor=SURFACE)
    e = fc[fc.series == "ensemble"]
    ax.fill_between(e.year, e.p10_twh, e.p90_twh, color="#b7d3f6", linewidth=0, label="Ensemble P10-P90")
    ax.plot(hist.year, hist.generation_twh, color=C["actual"], linewidth=2, label="Actual")
    ax.plot(e.year, e.p50_twh, color=INK, linewidth=2, label="Ensemble P50")
    for l in LENSES:
        d = fc[fc.series == l]
        ax.plot(d.year, d.p50_twh, color=C[l], linewidth=1.5, linestyle="--", label=f"{LENS_LABEL[l]} (P50)")
        ax.annotate(f"{d.p50_twh.iloc[-1]:,.0f}", (TARGET_YEAR, d.p50_twh.iloc[-1]), xytext=(6, 0), textcoords="offset points",
                    va="center", fontsize=8, color=INK2)
    ax.annotate(f"{e.p50_twh.iloc[-1]:,.0f} P50", (TARGET_YEAR, e.p50_twh.iloc[-1]), xytext=(6, 0), textcoords="offset points",
                va="center", fontsize=9, color=INK, fontweight="bold")
    _style(ax, "India's generation requirement to 2047", "TWh per year (total generation)")
    ax.set_xlim(1985, TARGET_YEAR + 5)
    ax.set_ylim(0)
    ax.legend(frameon=False, fontsize=8, loc="upper left", labelcolor=INK2)
    fig.tight_layout()
    fig.savefig(FIGURES / "01_fan_chart.png", dpi=160)
    plt.close(fig)

    # 2. Hindcast (small multiples by origin, one y-scale)
    fig, axes = plt.subplots(1, 3, figsize=(12, 4), sharey=True, facecolor=SURFACE)
    for ax, T in zip(axes, HINDCAST_ORIGINS):
        h = hist[hist.year >= 1995]
        ax.plot(h.year, h.generation_twh, color=C["actual"], linewidth=2, label="Actual")
        for l in LENSES:
            d = hc[(hc.origin == T) & (hc.lens == l)]
            ax.plot(d.year, d.predicted_twh, color=C[l], linewidth=1.8, label=LENS_LABEL[l])
        d = hc[(hc.origin == T) & (hc.lens == "trend_benchmark")]
        ax.plot(d.year, d.predicted_twh, color="#a8a7a0", linewidth=1.2, linestyle=":", label="Trend only (benchmark)")
        ax.axvline(T, color=GRID, linewidth=1)
        _style(ax, f"Model fitted on data to {T}", "TWh per year" if T == HINDCAST_ORIGINS[0] else "")
    axes[0].legend(frameon=False, fontsize=8, loc="upper left", labelcolor=INK2)
    fig.suptitle("Hindcast: would each lens have predicted 2025?", x=0.01, ha="left", fontsize=13, color=INK)
    fig.tight_layout()
    fig.savefig(FIGURES / "02_hindcast.png", dpi=160)
    plt.close(fig)

    # 3. Ladder curve
    fig, ax = plt.subplots(figsize=(9, 5), facecolor=SURFACE)
    mids = cb["band"].map(lambda b: np.sqrt(b.left * min(b.right, 85000))).astype(float)
    jit = np.exp(np.random.default_rng(1).normal(0, 0.05, len(cb)))
    ax.scatter(mids * jit, cb["elasticity"].clip(-1, 3), s=14, color="#9ec5f4", linewidths=0, label="One country in one income band")
    ax.fill_between(curve_tbl.income_node, curve_tbl.p10, curve_tbl.p90, color="#fbd5c5", linewidth=0, label="Median, 10-90 % bootstrap")
    ax.plot(curve_tbl.income_node, curve_tbl.elasticity_median, color=C["ladder"], linewidth=2, marker="o", markersize=6, label="Band median")
    y0, y1 = base_path.gdp_pc[0], base_path.gdp_pc[-1]
    ax.axvspan(y0, y1, color="#f0efec", zorder=0)
    ax.text(np.sqrt(y0 * y1), 2.85, "India 2025 to 2047 (Base)", ha="center", va="top", fontsize=9, color=INK2)
    ax.set_xscale("log")
    ax.set_xticks([3000, 6000, 10000, 15000, 22000, 33000, 50000, 85000])
    ax.set_xticklabels(["3k", "6k", "10k", "15k", "22k", "33k", "50k", "85k"])
    ax.minorticks_off()
    ax.set_ylim(-1, 3)
    ax.set_xlabel("GDP per person (PPP, constant international $)", color=INK2, fontsize=9)
    _style(ax, "The development ladder: generation-to-income elasticity falls as countries get richer",
           "Elasticity over 10 years (clipped to -1..3)")
    ax.legend(frameon=False, fontsize=8, loc="lower left", labelcolor=INK2)
    fig.tight_layout()
    fig.savefig(FIGURES / "03_ladder_curve.png", dpi=160)
    plt.close(fig)

    # 4. Need vs production share by zone
    fig, ax = plt.subplots(figsize=(9, 5), facecolor=SURFACE)
    z25 = zone_req[zone_req.year == BASE_YEAR].set_index("zone")["share_p50"].reindex(ZONES) * 100
    z47 = zone_req[zone_req.year == TARGET_YEAR].set_index("zone")["share_p50"].reindex(ZONES) * 100
    prod = (made / made.sum()).reindex(ZONES) * 100
    x = np.arange(len(ZONES))
    w = 0.26
    series = [(prod, f"Share of generation made, {int(zone_req.production_year.iloc[0])}", C["india"]),
              (z25, "Share of requirement, 2025 (modelled)", C["ladder"]),
              (z47, "Share of requirement, 2047 (modelled)", C["panel"])]
    for i, (vals, label, color) in enumerate(series):
        bars = ax.bar(x + (i - 1) * w, vals.values, width=w - 0.03, color=color, label=label)
        for b, v in zip(bars, vals.values):
            ax.text(b.get_x() + b.get_width() / 2, v + 0.4, f"{v:.0f}", ha="center", va="bottom", fontsize=8, color=INK2)
    ax.set_xticks(x)
    ax.set_xticklabels(ZONES)
    _style(ax, "Where energy is made vs where it will be needed", "% of national total")
    ax.legend(frameon=False, fontsize=8, loc="upper right", labelcolor=INK2)
    fig.tight_layout()
    fig.savefig(FIGURES / "04_need_vs_production_by_zone.png", dpi=160)
    plt.close(fig)


if __name__ == "__main__":
    main()
