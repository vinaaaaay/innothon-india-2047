"""Step 1 - clean generation tables (generation only, no capacity).

Outputs in data/processed/:
  generation_state_source_month.csv   state x source x month, GWh (Ember/CEA, utility)
  generation_state_source_year.csv    same, complete calendar years
  generation_zone_source_year.csv     six official zones x source x year, TWh
  generation_national_history.csv     India 1985-2025 by source, TWh (OWID, incl. captive)
  check_ember_vs_npp.csv              cross-check against official NPP fiscal-year totals
  utility_bridge.csv                  utility-only / total generation ratio by year
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import warnings

import pandas as pd

import compliance
from config import PROCESSED, RAW, STATES, canonical_state

EMBER_FUEL_MAP = {
    "Coal": "Coal", "Gas": "Gas", "Hydro": "Hydro", "Nuclear": "Nuclear",
    "Solar": "Solar", "Wind": "Wind", "Bioenergy": "Bioenergy",
    "Other Fossil": "Other", "Other Renewables": "Other",
}
OWID_SOURCE_MAP = {
    "coal_electricity": "Coal", "gas_electricity": "Gas", "hydro_electricity": "Hydro",
    "nuclear_electricity": "Nuclear", "solar_electricity": "Solar", "wind_electricity": "Wind",
    "biofuel_electricity": "Bioenergy", "oil_electricity": "Other",
    "other_renewable_exc_biofuel_electricity": "Other",
}


def load_ember_monthly() -> pd.DataFrame:
    """State x fuel x month generation in GWh. Capacity and emissions rows are never read into the result."""
    raw = pd.read_csv(RAW / "ember" / "india_monthly_full_release_long_format.csv", low_memory=False)
    gen = raw[(raw["Category"] == "Electricity generation") & (raw["Subcategory"] == "Fuel") & (raw["Unit"] == "GWh")]
    compliance.record_source(
        "ember_monthly", "Ember India monthly (CEA)",
        kept="Category == 'Electricity generation', Subcategory == 'Fuel', Unit == 'GWh'",
        dropped="Category == 'Capacity' (MW), aggregates, emissions",
    )
    df = gen[["State", "Date", "Variable", "Value"]].rename(
        columns={"State": "state", "Date": "date", "Variable": "fuel", "Value": "gwh"})
    df["date"] = pd.to_datetime(df["date"])
    df["source"] = df["fuel"].map(EMBER_FUEL_MAP)
    if df["source"].isna().any():
        raise ValueError(f"unmapped Ember fuels: {df.loc[df.source.isna(), 'fuel'].unique()}")
    return df


def build_state_tables(ember: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    national = ember[ember["state"] == "India Total"].groupby("date")["gwh"].sum()
    st = ember[~ember["state"].isin(["India Total", "Others"])].copy()
    st["state"] = st["state"].map(canonical_state)
    unknown = set(st["state"]) - set(STATES)
    if unknown:
        raise ValueError(f"states without a zone: {unknown}")
    st["zone"] = st["state"].map(lambda s: STATES[s][0])
    st["cea_region"] = st["state"].map(lambda s: STATES[s][1])
    month = (st.groupby(["state", "zone", "cea_region", "date", "source"], as_index=False)["gwh"].sum()
             .sort_values(["state", "date", "source"]))

    # States must add up to the published national total.
    gap = (month.groupby("date")["gwh"].sum() - national).abs().max()
    if gap > 1.0:
        raise ValueError(f"state sum differs from India Total by {gap:.1f} GWh")

    month["year"] = month["date"].dt.year
    months_per_year = month.groupby("year")["date"].nunique()
    full_years = months_per_year[months_per_year == 12].index
    year = (month[month["year"].isin(full_years)]
            .groupby(["state", "zone", "cea_region", "year", "source"], as_index=False)["gwh"].sum())
    zone = year.groupby(["zone", "year", "source"], as_index=False)["gwh"].sum()
    zone["twh"] = zone["gwh"] / 1000
    zone = zone.drop(columns="gwh")
    month = month.drop(columns="year")
    return month, year, zone


def build_national_history() -> pd.DataFrame:
    cols = ["country", "year", "electricity_generation"] + list(OWID_SOURCE_MAP)
    raw = pd.read_csv(RAW / "owid" / "owid-energy-data.csv", usecols=cols)
    compliance.record_source(
        "owid_india", "Our World in Data energy dataset",
        kept="electricity_generation and *_electricity (generation by source, TWh)",
        dropped="all *_consumption, electricity_demand, primary energy and share columns",
    )
    ind = raw[(raw["country"] == "India") & raw["electricity_generation"].notna()].copy()
    long = ind.melt(id_vars=["year"], value_vars=list(OWID_SOURCE_MAP), var_name="col", value_name="twh").fillna({"twh": 0.0})
    long["source"] = long["col"].map(OWID_SOURCE_MAP)
    wide = long.pivot_table(index="year", columns="source", values="twh", aggfunc="sum")
    wide["Total"] = ind.set_index("year")["electricity_generation"]
    # 1991-1999 carry a small unallocated remainder (early renewables without a
    # source split, at most 0.3 % of the total). It goes to "Other" so sources add up.
    residual = wide["Total"] - wide.drop(columns="Total").sum(axis=1)
    if (residual.abs() / wide["Total"]).max() > 0.005:
        raise ValueError(f"OWID sources miss the total by more than 0.5 % (max {residual.abs().max():.2f} TWh)")
    wide["Other"] = wide["Other"] + residual
    return wide.reset_index()


def npp_fiscal_totals() -> pd.DataFrame:
    """All-India ACTUAL generation by category for each fiscal year, from NPP sub-report 1.

    Layout of each category row after dropping blanks:
      [name, monitored capacity, annual target, month programme, month actual, same month last year,
       %, %, FY programme, FY ACTUAL, same period last year, ...]
    Only FY ACTUAL (index 9) is kept; capacity and PLF columns are discarded here.
    """
    rows = []
    for folder in sorted((RAW / "npp" / "monthly_gen").glob("*-MAR")):
        fy_end = int(folder.name[:4])
        f = folder / f"18_col_act-1_{fy_end}-MAR.xls"
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")  # xlrd notes about the legacy .xls container
            x = pd.read_excel(f, header=None).dropna(how="all", axis=1).dropna(how="all")
        for _, r in x.iterrows():
            name = str(r.iloc[0]).strip()
            if name in ("THERMAL", "NUCLEAR", "HYDRO"):
                vals = pd.to_numeric(r.iloc[1:], errors="coerce").dropna().values
                rows.append({"fy": f"{fy_end - 1}-{str(fy_end)[2:]}", "fy_end": fy_end,
                             "category": name.title(), "npp_gwh": float(vals[8])})
    compliance.record_source(
        "npp_subreport_1", "National Power Portal monthly generation report (CEA)",
        kept="April-March ACTUAL generation (GWh) for thermal, nuclear, hydro",
        dropped="Monitored Capacity (MW), programme/target, PLF (%)",
    )
    return pd.DataFrame(rows)


def cross_check(month: pd.DataFrame, npp: pd.DataFrame) -> pd.DataFrame:
    m = month.copy()
    m["fy_end"] = m["date"].dt.year + (m["date"].dt.month >= 4).astype(int)
    cat = {"Coal": "Thermal", "Gas": "Thermal", "Nuclear": "Nuclear", "Hydro": "Hydro"}
    m["category"] = m["source"].map(cat)
    n_months = m.groupby("fy_end")["date"].nunique()
    full = n_months[n_months == 12].index
    emb = (m[m["fy_end"].isin(full) & m["category"].notna()]
           .groupby(["fy_end", "category"], as_index=False)["gwh"].sum().rename(columns={"gwh": "ember_gwh"}))
    out = npp.merge(emb, on=["fy_end", "category"], how="inner")
    out["diff_pct"] = (out["ember_gwh"] / out["npp_gwh"] - 1) * 100
    return out.sort_values(["category", "fy_end"])


def main() -> None:
    PROCESSED.mkdir(parents=True, exist_ok=True)
    ember = load_ember_monthly()
    month, year, zone = build_state_tables(ember)
    hist = build_national_history()
    npp = npp_fiscal_totals()
    check = cross_check(month, npp)

    util = year.groupby("year")["gwh"].sum().div(1000).rename("utility_twh").reset_index()
    bridge = util.merge(hist[["year", "Total"]].rename(columns={"Total": "total_twh"}), on="year")
    bridge["utility_share"] = bridge["utility_twh"] / bridge["total_twh"]

    month = month.assign(unit="GWh")
    compliance.assert_clean(month, "generation_state_source_month").to_csv(PROCESSED / "generation_state_source_month.csv", index=False)
    compliance.assert_clean(year, "generation_state_source_year").to_csv(PROCESSED / "generation_state_source_year.csv", index=False)
    compliance.assert_clean(zone, "generation_zone_source_year").to_csv(PROCESSED / "generation_zone_source_year.csv", index=False)
    compliance.assert_clean(hist, "generation_national_history").to_csv(PROCESSED / "generation_national_history.csv", index=False)
    compliance.assert_clean(check, "check_ember_vs_npp").to_csv(PROCESSED / "check_ember_vs_npp.csv", index=False)
    compliance.assert_clean(bridge, "utility_bridge").to_csv(PROCESSED / "utility_bridge.csv", index=False)
    compliance.audit_frame().to_csv(PROCESSED / "compliance_audit_generation.csv", index=False)

    pd.set_option("display.width", 200)
    print(f"state-month rows: {len(month):,}  ({month.date.min():%Y-%m} to {month.date.max():%Y-%m}, {month.state.nunique()} states)")
    print(f"complete calendar years: {sorted(year.year.unique())}")
    print("\nZone x source, latest full year (TWh):")
    last = zone[zone.year == zone.year.max()].pivot(index="zone", columns="source", values="twh")
    last["Total"] = last.sum(axis=1)
    print(last.round(1))
    print("\nNational history (TWh), selected years:")
    print(hist[hist.year.isin([1985, 2000, 2010, 2020, 2025])].round(1).to_string(index=False))
    print("\nEmber vs NPP official fiscal-year totals:")
    print(check.round({"npp_gwh": 0, "ember_gwh": 0, "diff_pct": 2}).to_string(index=False))
    print("\nUtility-only vs total generation:")
    print(bridge.round(3).to_string(index=False))


if __name__ == "__main__":
    main()
