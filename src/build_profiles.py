"""Step 5 - generation-derived inputs for the optimiser.

Everything here is computed from generation (GWh) and emissions data only.

Outputs in data/processed/:
  base_mix_state.csv      state x source: latest 12 months and best 12 months on record (TWh)
  monthly_shapes.csv      zone x source x month seasonal factor (mean 1.0), ratio-to-moving-average
  need_shape.csv          month share of annual national generation (the requirement's seasonal shape)
  dispatch_bands.csv      coal and gas: observed min / max of monthly output relative to the annual mean
  emission_factors.csv    tCO2 per MWh by source (Ember lifecycle figures / generation)
  build_rates.csv         best sustained annual increase in generation by source (TWh per year)
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd

import compliance
from config import PROCESSED, RAW, SOURCES, ZONES

SHAPE_SOURCES = ["Solar", "Wind", "Hydro", "Nuclear", "Bioenergy", "Other"]
MIN_TWH_FOR_OWN_SHAPE = 1.0     # zones below this annual output borrow the national shape


def seasonal_factors(series: pd.Series) -> pd.Series:
    """Month-of-year factors (mean 1) by ratio to a centred 12-month moving average.

    Removes the growth trend, which would otherwise make later months look stronger
    for fast-growing sources such as solar.
    """
    s = series.asfreq("MS")
    ma = s.rolling(12, center=True).mean().rolling(2).mean().shift(-1)   # 2x12 centred moving average
    ratio = (s / ma).replace([np.inf, -np.inf], np.nan).dropna()
    f = ratio.groupby(ratio.index.month).median().reindex(range(1, 13))
    return f / f.mean()


def main() -> None:
    m = pd.read_csv(PROCESSED / "generation_state_source_month.csv", parse_dates=["date"])
    compliance.assert_clean(m, "generation_state_source_month")
    last = m["date"].max()
    start = last - pd.DateOffset(months=11)

    # ---- base mix: latest 12 months and best 12 months on record -------------
    wide = m.pivot_table(index="date", columns=["state", "source"], values="gwh", aggfunc="sum").fillna(0.0)
    roll = wide.rolling(12).sum().dropna()
    base = (roll.iloc[-1] / 1000).rename("base_twh").reset_index()
    best = (roll.max() / 1000).rename("best_12m_twh").reset_index()
    avg3 = (roll.iloc[[-1, -13, -25]].mean() / 1000).rename("avg_3y_twh").reset_index()
    base = base.merge(best, on=["state", "source"]).merge(avg3, on=["state", "source"])
    zmap = m.drop_duplicates("state").set_index("state")[["zone", "cea_region"]]
    base = base.join(zmap, on="state")
    base["base_period"] = f"{start:%Y-%m} to {last:%Y-%m}"

    # ---- seasonal shapes -----------------------------------------------------
    nat = m.groupby(["source", "date"])["gwh"].sum().unstack(0)
    zone = m.groupby(["zone", "source", "date"])["gwh"].sum()
    zone_base = base.groupby(["zone", "source"])["base_twh"].sum()
    rows = []
    for src in SHAPE_SOURCES:
        nat_f = seasonal_factors(nat[src]) if nat[src].sum() > 0 else pd.Series(1.0, index=range(1, 13))
        for z in ZONES:
            own = zone_base.get((z, src), 0.0) >= MIN_TWH_FOR_OWN_SHAPE
            f = seasonal_factors(zone.loc[(z, src)]) if own else nat_f
            if f.isna().any():
                f, own = nat_f, False
            rows += [{"zone": z, "source": src, "month": mo, "factor": float(f[mo]), "own_shape": own} for mo in range(1, 13)]
    shapes = pd.DataFrame(rows)

    total = m.groupby("date")["gwh"].sum()
    need = seasonal_factors(total)
    need_shape = pd.DataFrame({"month": need.index, "factor": need.values, "share": need.values / 12})

    # ---- dispatch bands for coal and gas ---------------------------------------
    # How far monthly output has swung around its 12-month average. The national fleet as a whole
    # has moved little because coal runs as baseload today; individual regional fleets have swung
    # much more, which is the demonstrated seasonal flexibility the optimiser may use.
    bands = []
    for src in ["Coal", "Gas"]:
        nat_s = nat[src].asfreq("MS")
        f_nat = (nat_s / nat_s.rolling(12, center=True).mean()).dropna()
        ratios = []
        for z in ZONES:
            if zone_base.get((z, src), 0.0) < 10.0:        # ignore fleets too small to be representative
                continue
            zs = zone.loc[(z, src)].asfreq("MS")
            ratios.append((zs / zs.rolling(12, center=True).mean()).dropna())
        f_zone = pd.concat(ratios) if ratios else f_nat
        bands.append({"source": src, "min_factor": float(f_zone.quantile(0.02)), "max_factor": float(f_zone.quantile(0.98)),
                      "national_min": float(f_nat.quantile(0.02)), "national_max": float(f_nat.quantile(0.98)),
                      "fleets_pooled": len(ratios)})
    bands = pd.DataFrame(bands)

    # ---- emission factors -----------------------------------------------------
    y = pd.read_csv(RAW / "ember" / "india_yearly_full_release_long_format.csv")
    y = y[(y["State"] == "India Total") & (y["Subcategory"] == "Fuel")]
    em = y[(y["Category"] == "Power sector emissions") & (y["Unit"] == "ktCO2")].pivot(index="Year", columns="Variable", values="Value")
    gen = y[(y["Category"] == "Electricity generation") & (y["Unit"] == "GWh")].pivot(index="Year", columns="Variable", values="Value")
    compliance.record_source("ember_emissions", "Ember India yearly (CEA)",
                             kept="power-sector emissions (ktCO2) and generation (GWh) by fuel", dropped="Capacity rows")
    yrs = em.index[-3:]
    ef = (em.loc[yrs].sum() / gen.loc[yrs].sum()).rename("tco2_per_mwh")       # ktCO2 / GWh = tCO2 / MWh
    fold = {"Other Fossil": "Other", "Other Renewables": "Other"}
    efs = ef.rename(index=fold).groupby(level=0).mean().reindex(SOURCES).fillna(0.0).reset_index()
    efs.columns = ["source", "tco2_per_mwh"]

    # ---- sustained build rates from national history --------------------------
    hist = pd.read_csv(PROCESSED / "generation_national_history.csv").set_index("year")
    br = []
    for src in SOURCES:
        s = hist[src]
        br.append({"source": src, "best_5y_avg_add_twh": float((s.diff(5) / 5).max()),
                   "best_1y_add_twh": float(s.diff().max()), "last_5y_avg_add_twh": float((s.iloc[-1] - s.iloc[-6]) / 5),
                   "latest_twh": float(s.iloc[-1])})
    br = pd.DataFrame(br)

    for name, df in [("base_mix_state", base), ("monthly_shapes", shapes), ("need_shape", need_shape),
                     ("dispatch_bands", bands), ("emission_factors", efs), ("build_rates", br)]:
        compliance.assert_clean(df, name).to_csv(PROCESSED / f"{name}.csv", index=False)

    pd.set_option("display.width", 220)
    print(f"base period: {start:%Y-%m} to {last:%Y-%m}")
    zb = base.pivot_table(index="zone", columns="source", values="base_twh", aggfunc="sum").reindex(ZONES)[SOURCES]
    zb["Total"] = zb.sum(axis=1)
    print("\nBase mix by zone (TWh, latest 12 months):")
    print(zb.round(1).to_string())
    print("national total:", round(zb["Total"].sum(), 1))
    print("\nSeasonal factors (mean 1.0):")
    print(shapes[shapes.source.isin(["Solar", "Wind", "Hydro"])].pivot_table(index=["source", "zone"], columns="month", values="factor").round(2).to_string())
    print("\nNeed shape:", need_shape["factor"].round(3).tolist())
    print("\nDispatch bands:\n", bands.round(2).to_string(index=False))
    print("\nEmission factors (tCO2/MWh):", efs.set_index("source")["tco2_per_mwh"].round(3).to_dict())
    print("\nBuild rates (TWh/yr):\n", br.round(1).to_string(index=False))


if __name__ == "__main__":
    main()
