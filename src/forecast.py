"""Forecast lenses for India's generation requirement.

Everything is in generation terms (TWh, kWh per person). No capacity or
consumption figure enters any function here.

Three independent national lenses, all predicting generation per person
from income (and, for the panel lens, urbanisation):

  india   India's own 1990-2025 relationship (log-log, AR(1) errors).
  ladder  What other growing economies did at each income level
          (10-year elasticities, binned by income, India excluded).
  panel   Global fixed-effects panel: income, income squared, urban share
          (India excluded).

Plus a trend-only benchmark used to judge hindcast skill, and a
state-resolved version of the ladder that splits the national requirement
across states and zones.
"""
from dataclasses import dataclass

import numpy as np
import pandas as pd
import statsmodels.api as sm

LADDER_EDGES = [3000, 6000, 10000, 15000, 22000, 33000, 50000, 200000]
LADDER_HORIZON = 10        # years per long-difference window
LADDER_MIN_GROWTH = 0.2    # minimum log income growth over a window (~22 %)
LADDER_MIN_POP = 5e6
LADDER_MIN_COUNTRIES = 8   # per income band
PANEL_MIN_POP = 1e6
FIRST_YEAR = 1990          # World Bank PPP income series starts here


# --------------------------------------------------------------------------
# Driver paths
# --------------------------------------------------------------------------
@dataclass
class DriverPath:
    years: np.ndarray        # base year .. target year
    population: np.ndarray
    gdp_pc: np.ndarray       # PPP, constant international $
    urban: np.ndarray        # share 0-1

    @property
    def ln_y(self) -> np.ndarray:
        return np.log(self.gdp_pc)


def actual_path(nat: pd.DataFrame, start: int, end: int) -> DriverPath:
    d = nat.set_index("year").loc[start:end]
    return DriverPath(d.index.values, d["population"].values, d["gdp_pc_ppp"].values, d["urban_share"].values / 100)


def scenario_path(nat: pd.DataFrame, base_year: int, target_year: int, growth_start: float, growth_end: float,
                  pop_scale: float = 1.0, urban_target: float | None = None) -> DriverPath:
    """Future drivers.

    growth_start / growth_end: real GDP growth (%) in the first and last forecast year, linear in between.
    pop_scale: multiplier on the World Bank population projection reached at the target year.
    urban_target: urban share (%) at the target year; None keeps the World Bank projection.
    """
    d = nat.set_index("year").loc[base_year:target_year]
    years = d.index.values
    h = years - base_year
    span = target_year - base_year
    pop = d["population"].values * (1 + (pop_scale - 1) * h / span)
    urban = d["urban_share"].values / 100
    if urban_target is not None:
        urban = urban[0] + (urban_target / 100 - urban[0]) * h / span
    growth = np.interp(years[1:], [base_year + 1, target_year], [growth_start, growth_end]) / 100
    gdp_total = d["gdp_pc_ppp"].iloc[0] * pop[0] * np.concatenate([[1.0], np.cumprod(1 + growth)])
    return DriverPath(years, pop, gdp_total / pop, urban)


# --------------------------------------------------------------------------
# Lens 1 - India's own relationship
# --------------------------------------------------------------------------
@dataclass
class IndiaFit:
    params: np.ndarray   # intercept, elasticity
    cov: np.ndarray
    rho: float
    last_resid: float
    last_year: int

    def predict_ln(self, path: DriverPath, params: np.ndarray | None = None) -> np.ndarray:
        a, b = self.params if params is None else params
        h = path.years - self.last_year
        return a + b * path.ln_y + self.last_resid * self.rho ** h


def fit_india(nat: pd.DataFrame, last_year: int) -> IndiaFit:
    d = nat[(nat.year >= FIRST_YEAR) & (nat.year <= last_year)].dropna(subset=["generation_pc_kwh", "gdp_pc_ppp"])
    y = np.log(d["generation_pc_kwh"].values)
    X = sm.add_constant(np.log(d["gdp_pc_ppp"].values))
    res = sm.GLSAR(y, X, rho=1).iterative_fit(maxiter=20)
    rho = float(np.atleast_1d(res.model.rho)[0])
    resid = y - X @ res.params
    return IndiaFit(res.params, res.cov_params(), rho, float(resid[-1]), last_year)


# --------------------------------------------------------------------------
# Lens 2 - development ladder
# --------------------------------------------------------------------------
def ladder_windows(panel: pd.DataFrame, last_year: int) -> pd.DataFrame:
    """Ten-year elasticities of generation per person to income, for growing economies other than India."""
    p = panel[(panel.population > LADDER_MIN_POP) & (panel.year <= last_year) & (panel.iso != "IND")]
    lg = np.log(p.pivot(index="year", columns="iso", values="generation_pc_kwh"))
    lx = np.log(p.pivot(index="year", columns="iso", values="gdp_pc_ppp"))
    rows = []
    for y0 in range(FIRST_YEAR, last_year - LADDER_HORIZON + 1):
        y1 = y0 + LADDER_HORIZON
        if y0 not in lg.index or y1 not in lg.index:
            continue
        dg, dx, mid = lg.loc[y1] - lg.loc[y0], lx.loc[y1] - lx.loc[y0], (lx.loc[y1] + lx.loc[y0]) / 2
        ok = dg.notna() & dx.notna() & (dx >= LADDER_MIN_GROWTH)
        rows.append(pd.DataFrame({"iso": dg.index[ok], "y0": y0, "elasticity": (dg / dx)[ok].values,
                                  "income_mid": np.exp(mid[ok].values)}))
    w = pd.concat(rows, ignore_index=True)
    w["band"] = pd.cut(w["income_mid"], LADDER_EDGES)
    return w.dropna(subset=["band"])


def country_band_medians(windows: pd.DataFrame) -> pd.DataFrame:
    """One elasticity per country per income band, so long panels do not dominate."""
    return windows.groupby(["band", "iso"], observed=True)["elasticity"].median().reset_index()


class LadderCurve:
    """Elasticity as a function of income: band medians, interpolated in log income."""

    GRID = np.linspace(np.log(800), np.log(250000), 600)

    def __init__(self, cb: pd.DataFrame):
        stats = cb.groupby("band", observed=True)["elasticity"].agg(["median", "count"])
        stats = stats[stats["count"] >= LADDER_MIN_COUNTRIES]
        self.table = stats
        self.nodes = np.array([np.log(np.sqrt(b.left * min(b.right, 85000))) for b in stats.index])
        self.values = stats["median"].values
        eps = self.elasticity(self.GRID)
        self._cum = np.concatenate([[0.0], np.cumsum((eps[1:] + eps[:-1]) / 2 * np.diff(self.GRID))])

    def elasticity(self, ln_y: np.ndarray) -> np.ndarray:
        return np.interp(ln_y, self.nodes, self.values)

    def ln_level(self, ln_y: np.ndarray) -> np.ndarray:
        """Log generation per person implied by the ladder, up to a constant."""
        return np.interp(ln_y, self.GRID, self._cum)

    def predict_ln(self, path: DriverPath, anchor_ln: float) -> np.ndarray:
        lv = self.ln_level(path.ln_y)
        return anchor_ln + lv - lv[0]


def bootstrap_ladders(cb: pd.DataFrame, n: int, rng: np.random.Generator) -> list[LadderCurve]:
    isos = cb["iso"].unique()
    by_iso = {k: g for k, g in cb.groupby("iso")}
    return [LadderCurve(pd.concat([by_iso[i] for i in rng.choice(isos, len(isos))])) for _ in range(n)]


# --------------------------------------------------------------------------
# Lens 3 - global fixed-effects panel with urbanisation
# --------------------------------------------------------------------------
@dataclass
class PanelFit:
    params: np.ndarray   # ln income, (ln income)^2, urban share
    cov: np.ndarray
    n_countries: int

    def predict_ln(self, path: DriverPath, anchor_ln: float, params: np.ndarray | None = None) -> np.ndarray:
        b = self.params if params is None else params
        x, u = path.ln_y, path.urban
        return anchor_ln + b[0] * (x - x[0]) + b[1] * (x ** 2 - x[0] ** 2) + b[2] * (u - u[0])

    def income_elasticity(self, income: float) -> float:
        return float(self.params[0] + 2 * self.params[1] * np.log(income))


def fit_panel(panel: pd.DataFrame, last_year: int) -> PanelFit:
    p = panel[(panel.population > PANEL_MIN_POP) & (panel.year <= last_year) & (panel.iso != "IND")].copy()
    p["le"] = np.log(p["generation_pc_kwh"])
    p["x"] = np.log(p["gdp_pc_ppp"])
    p["x2"] = p["x"] ** 2
    p["u"] = p["urban_share"] / 100
    cols = ["le", "x", "x2", "u"]
    within = p[cols] - p.groupby("iso")[cols].transform("mean")   # removes each country's own level
    res = sm.OLS(within["le"], within[["x", "x2", "u"]]).fit(cov_type="cluster", cov_kwds={"groups": p["iso"]})
    return PanelFit(res.params.values, res.cov_params().values, p["iso"].nunique())


# --------------------------------------------------------------------------
# Benchmark - trend only, no drivers
# --------------------------------------------------------------------------
def trend_benchmark(nat: pd.DataFrame, last_year: int, years: np.ndarray, window: int = 20) -> np.ndarray:
    d = nat[(nat.year > last_year - window) & (nat.year <= last_year)]
    slope, intercept = np.polyfit(d["year"], np.log(d["generation_twh"]), 1)
    return np.exp(intercept + slope * years)


# --------------------------------------------------------------------------
# Hindcast
# --------------------------------------------------------------------------
def to_twh(ln_pc: np.ndarray, population: np.ndarray) -> np.ndarray:
    return np.exp(ln_pc) * population / 1e9


def hindcast(nat: pd.DataFrame, panel: pd.DataFrame, origins: list[int], end: int) -> pd.DataFrame:
    """Fit every lens on data up to each origin, then predict to `end` using the drivers that actually occurred."""
    actual = nat.set_index("year")["generation_twh"]
    rows = []
    for T in origins:
        path = actual_path(nat, T, end)
        anchor = float(np.log(nat.set_index("year").loc[T, "generation_pc_kwh"]))
        preds = {
            "india": to_twh(fit_india(nat, T).predict_ln(path), path.population),
            "ladder": to_twh(LadderCurve(country_band_medians(ladder_windows(panel, T))).predict_ln(path, anchor), path.population),
            "panel": to_twh(fit_panel(panel, T).predict_ln(path, anchor), path.population),
            "trend_benchmark": trend_benchmark(nat, T, path.years),
        }
        for lens, values in preds.items():
            for yr, v in zip(path.years, values):
                rows.append({"origin": T, "lens": lens, "year": int(yr), "predicted_twh": v,
                             "actual_twh": actual[yr], "log_error": float(np.log(v / actual[yr]))})
    return pd.DataFrame(rows)


def lens_weights(hc: pd.DataFrame, lenses: list[str], cap: float | None = 0.5) -> pd.Series:
    """Inverse mean-squared log error over every hindcast year and origin.

    cap limits any single lens's share (the hindcast has only a few overlapping
    paths, so it should inform the weights without letting one lens take over).
    """
    e = hc[hc.lens.isin(lenses) & (hc.year > hc.origin)].groupby("lens")["log_error"].apply(lambda s: np.mean(s ** 2))
    w = (1 / e) / (1 / e).sum()
    if cap is not None:
        for _ in range(10):
            over = w > cap + 1e-12
            if not over.any():
                break
            excess = (w[over] - cap).sum()
            w[over] = cap
            w[~over] += excess * w[~over] / w[~over].sum()
    return w.reindex(lenses)


# --------------------------------------------------------------------------
# State-resolved ladder (regional requirement)
# --------------------------------------------------------------------------
def estimate_convergence(state: pd.DataFrame, min_pop: float = 1e6) -> dict:
    """Annual beta-convergence of state income relative to the national mean, over the reliable GSDP window."""
    s = state[state.gsdp_reliable]
    y0, y1 = s.year.min(), s.year.max()
    w = s.pivot(index="state", columns="year", values="gsdp_crore").div(
        s.pivot(index="state", columns="year", values="population"))
    tot = s.groupby("year")[["gsdp_crore", "population"]].sum()
    rel = np.log(w.div(tot["gsdp_crore"] / tot["population"], axis=1))
    pop0 = s[s.year == y0].set_index("state")["population"]
    keep = rel[[y0, y1]].dropna().index.intersection(pop0[pop0 > min_pop].index)
    growth = (rel.loc[keep, y1] - rel.loc[keep, y0]) / (y1 - y0)
    res = sm.OLS(growth.values, sm.add_constant(rel.loc[keep, y0].values)).fit()
    return {"beta": float(res.params[1]), "se": float(res.bse[1]), "n_states": int(len(keep)),
            "window": (int(y0), int(y1)), "p_value": float(res.pvalues[1])}


def state_requirement(state: pd.DataFrame, path: DriverPath, curve: LadderCurve, beta: float,
                      pop_trend_decay: float = 0.97) -> pd.DataFrame:
    """Each state sits on the ladder at its own income; requirement = population x ladder level.

    Returns state x year shares of the national requirement plus the implied bottom-up
    national multiple relative to the base year.
    """
    last = state.year.max()
    recent = state[state.year >= last - 10]
    shares = recent.pivot(index="year", columns="state", values="population")
    shares = shares.div(shares.sum(axis=1), axis=0)
    drift = np.polyfit(shares.index.values, np.log(shares.values), 1)[0]      # annual log drift in population share
    share0 = shares.loc[last].values
    states = shares.columns

    s = state[state.gsdp_reliable]
    ry = s.year.max()
    rs = s[s.year == ry].set_index("state")
    rel0 = np.log((rs["gsdp_crore"] / rs["population"]) / (rs["gsdp_crore"].sum() / rs["population"].sum()))
    rel0 = rel0.reindex(states).values

    rows = []
    for k, year in enumerate(path.years):
        h_pop = max(int(year) - int(last), 0)
        cum = sum(pop_trend_decay ** j for j in range(1, h_pop + 1))
        sh = share0 * np.exp(drift * cum)
        sh = sh / sh.sum()
        rel = rel0 * (1 + beta) ** (int(year) - int(ry))
        rel = rel - np.log(np.sum(sh * np.exp(rel)))          # population-weighted mean income stays at the national figure
        ln_y = np.log(path.gdp_pc[k]) + rel
        need = sh * path.population[k] * np.exp(curve.ln_level(ln_y))
        for st, a, b, c, d in zip(states, sh, np.exp(rel), np.exp(ln_y), need):
            rows.append({"state": st, "year": int(year), "population": a * path.population[k],
                         "income_relative": b, "gdp_pc_ppp": c, "need_raw": d})
    out = pd.DataFrame(rows)
    tot = out.groupby("year")["need_raw"].transform("sum")
    out["requirement_share"] = out["need_raw"] / tot
    base_tot = out.loc[out.year == path.years[0], "need_raw"].sum()
    out["bottom_up_multiple"] = tot / base_tot
    return out.drop(columns="need_raw")
