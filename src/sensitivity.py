"""Robustness of the 2047 Base-scenario number to modelling choices.

Each row changes one choice and reports the affected lens's 2047 value
(TWh, total generation, Base growth path, point estimates).
Writes outputs/sensitivity.csv.
"""
import sys
import warnings
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd

import forecast as F
from config import BASE_YEAR, OUTPUTS, PROCESSED, TARGET_YEAR
from run_forecast import SCENARIOS


def main() -> None:
    warnings.filterwarnings("ignore", category=FutureWarning)
    nat = pd.read_csv(PROCESSED / "drivers_national.csv")
    panel = pd.read_csv(PROCESSED / "panel_countries.csv")
    base = nat.set_index("year").loc[BASE_YEAR]
    anchor = float(np.log(base["generation_pc_kwh"]))
    path = F.scenario_path(nat, BASE_YEAR, TARGET_YEAR, *SCENARIOS["Base"])
    rows = []

    def add(lens: str, choice: str, ln_pc: np.ndarray, note: str = "") -> None:
        rows.append({"lens": lens, "choice": choice, "twh_2047": F.to_twh(ln_pc, path.population)[-1], "note": note})

    # Ladder: window length, minimum growth filter, minimum population, band-size threshold
    defaults = (F.LADDER_HORIZON, F.LADDER_MIN_GROWTH, F.LADDER_MIN_POP)

    def ladder_value() -> tuple[float, int]:
        cb = F.country_band_medians(F.ladder_windows(panel, BASE_YEAR))
        return F.LadderCurve(cb).predict_ln(path, anchor), cb["iso"].nunique()

    v, n = ladder_value()
    add("ladder", "default (10-year windows, growth >= 22 %, pop > 5m)", v, f"{n} countries")
    for h in (5, 15):
        F.LADDER_HORIZON = h
        v, n = ladder_value()
        add("ladder", f"{h}-year windows", v, f"{n} countries")
    F.LADDER_HORIZON = defaults[0]
    for g in (0.1, 0.3):
        F.LADDER_MIN_GROWTH = g
        v, n = ladder_value()
        add("ladder", f"income growth >= {np.expm1(g) * 100:.0f} % per window", v, f"{n} countries")
    F.LADDER_MIN_GROWTH = defaults[1]
    for mp in (1e6, 20e6):
        F.LADDER_MIN_POP = mp
        v, n = ladder_value()
        add("ladder", f"population > {mp / 1e6:.0f}m", v, f"{n} countries")
    F.LADDER_MIN_POP = defaults[2]
    asia = ["CHN", "IDN", "VNM", "THA", "MYS", "KOR", "PHL", "BGD", "PAK", "LKA", "TUR", "IRN", "EGY", "MEX", "BRA"]
    cb = F.country_band_medians(F.ladder_windows(panel[panel.iso.isin(asia)], BASE_YEAR))
    old = F.LADDER_MIN_COUNTRIES
    F.LADDER_MIN_COUNTRIES = 3
    add("ladder", "15 large emerging economies only", F.LadderCurve(cb).predict_ln(path, anchor), f"{cb['iso'].nunique()} countries")
    F.LADDER_MIN_COUNTRIES = old

    # Panel: sample and urbanisation path
    pf = F.fit_panel(panel, BASE_YEAR)
    add("panel", "default (pop > 1m, World Bank urban path: 42 % in 2047)", pf.predict_ln(path, anchor), f"{pf.n_countries} countries")
    hi_urban = F.scenario_path(nat, BASE_YEAR, TARGET_YEAR, *SCENARIOS["Base"], urban_target=50.0)
    add("panel", "urban share reaches 50 % in 2047", pf.predict_ln(hi_urban, anchor))
    flat_urban = F.scenario_path(nat, BASE_YEAR, TARGET_YEAR, *SCENARIOS["Base"], urban_target=float(base["urban_share"]))
    add("panel", "no further urbanisation (isolates the urban effect)", pf.predict_ln(flat_urban, anchor))
    old = F.PANEL_MIN_POP
    F.PANEL_MIN_POP = 5e6
    pf5 = F.fit_panel(panel, BASE_YEAR)
    add("panel", "population > 5m", pf5.predict_ln(path, anchor), f"{pf5.n_countries} countries")
    F.PANEL_MIN_POP = old
    mid = panel[(panel.gdp_pc_ppp > 3000) & (panel.gdp_pc_ppp < 60000)]
    pfm = F.fit_panel(mid, BASE_YEAR)
    add("panel", "country-years between $3k and $60k only", pfm.predict_ln(path, anchor), f"{pfm.n_countries} countries")

    # India: estimation window
    fi = F.fit_india(nat, BASE_YEAR)
    add("india", "default (1990-2025)", fi.predict_ln(path), f"elasticity {fi.params[1]:.2f}")
    for start in (2000, 2010):
        old = F.FIRST_YEAR
        F.FIRST_YEAR = start
        f2 = F.fit_india(nat, BASE_YEAR)
        add("india", f"fitted on {start}-2025 only", f2.predict_ln(path), f"elasticity {f2.params[1]:.2f}")
        F.FIRST_YEAR = old

    out = pd.DataFrame(rows)
    out["vs_default_pct"] = out.groupby("lens")["twh_2047"].transform(lambda s: (s / s.iloc[0] - 1) * 100)
    out.to_csv(OUTPUTS / "sensitivity.csv", index=False)
    pd.set_option("display.width", 220)
    pd.set_option("display.max_colwidth", 70)
    print(out.round({"twh_2047": 0, "vs_default_pct": 1}).to_string(index=False))


if __name__ == "__main__":
    main()
