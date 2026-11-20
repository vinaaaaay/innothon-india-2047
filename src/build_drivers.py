"""Step 2 - driver tables: population, urbanisation, income.

Outputs in data/processed/:
  drivers_national.csv   India 1985-2050: population, urban share, GDP per capita (PPP), generation
  panel_countries.csv    country x year: generation per capita, GDP per capita, urban share
  drivers_state.csv      state x year: population, real GSDP, reliability flag (official CSV)
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd

import compliance
from config import PROCESSED, RAW, STATES, canonical_state

# The official CSV's GSDP is on a different basis before 2011 (28 states jump
# >60 % in that year) and its state sum stops tracking national accounts after
# 2019 (see check printed by main). Only this window is used.
GSDP_RELIABLE = (2011, 2019)


def wb_series(indicator: str, suffix: str = "all_countries") -> pd.DataFrame:
    data = json.load(open(RAW / "worldbank" / f"{indicator}_{suffix}.json"))[1]
    rows = [(r["countryiso3code"], int(r["date"]), r["value"]) for r in data
            if r["value"] is not None and r["countryiso3code"]]
    return pd.DataFrame(rows, columns=["iso", "year", "value"])


def build_national() -> pd.DataFrame:
    pop = wb_series("SP.POP.TOTL", "IND_projection_to_2050").set_index("year")["value"].rename("population")
    urb = wb_series("SP.URB.TOTL.IN.ZS", "IND_projection_to_2050").set_index("year")["value"].rename("urban_share")
    pop_hist = wb_series("SP.POP.TOTL").query("iso == 'IND'").set_index("year")["value"]
    urb_hist = wb_series("SP.URB.TOTL.IN.ZS").query("iso == 'IND'").set_index("year")["value"]
    gdp = wb_series("NY.GDP.PCAP.PP.KD").query("iso == 'IND'").set_index("year")["value"].rename("gdp_pc_ppp")
    growth = wb_series("NY.GDP.MKTP.KD.ZG").query("iso == 'IND'").set_index("year")["value"].rename("gdp_growth_pct")

    idx = pd.Index(range(1985, 2051), name="year")
    df = pd.DataFrame(index=idx)
    df["population"] = pop.reindex(idx).fillna(pop_hist.reindex(idx))
    df["urban_share"] = urb.reindex(idx).fillna(urb_hist.reindex(idx))
    df["gdp_pc_ppp"] = gdp.reindex(idx)
    df["gdp_growth_pct"] = growth.reindex(idx)
    hist = pd.read_csv(PROCESSED / "generation_national_history.csv").set_index("year")["Total"]
    df["generation_twh"] = hist.reindex(idx)
    df["generation_pc_kwh"] = df["generation_twh"] * 1e9 / df["population"]
    df["is_projection"] = df.index > hist.index.max()
    return df.reset_index()


def build_panel() -> pd.DataFrame:
    owid = pd.read_csv(RAW / "owid" / "owid-energy-data.csv",
                       usecols=["country", "iso_code", "year", "population", "electricity_generation"])
    compliance.record_source(
        "owid_panel", "Our World in Data energy dataset",
        kept="electricity_generation (TWh), population",
        dropped="all consumption / demand / primary-energy columns",
    )
    owid = owid.dropna(subset=["iso_code", "electricity_generation", "population"])
    owid = owid[~owid["iso_code"].str.startswith("OWID")]
    owid = owid.rename(columns={"iso_code": "iso", "electricity_generation": "generation_twh"})
    owid["generation_pc_kwh"] = owid["generation_twh"] * 1e9 / owid["population"]

    gdp = wb_series("NY.GDP.PCAP.PP.KD").rename(columns={"value": "gdp_pc_ppp"})
    urb = wb_series("SP.URB.TOTL.IN.ZS").rename(columns={"value": "urban_share"})
    panel = owid.merge(gdp, on=["iso", "year"]).merge(urb, on=["iso", "year"])
    panel = panel[(panel["generation_pc_kwh"] > 0) & (panel["gdp_pc_ppp"] > 0)]
    return panel.sort_values(["iso", "year"]).reset_index(drop=True)


def build_state() -> pd.DataFrame:
    # usecols keeps the five "Installed - ..." capacity columns out of memory entirely.
    raw = pd.read_csv(RAW / "renewable-india-dataset" / "renewable_energy_dataset.csv",
                      usecols=["State", "Year", "Population", "GSDP (crore INR)"])
    compliance.record_source(
        "official_csv", "renewable-india-dataset (organisers' pointer)",
        kept="State, Year, Population, GSDP",
        dropped="Installed - Solar / Wind / Small Hydro / Bio-Mass / Waste to Energy (MW)",
    )
    df = raw.rename(columns={"State": "state", "Year": "year", "Population": "population",
                             "GSDP (crore INR)": "gsdp_crore"})
    df["state"] = df["state"].map(canonical_state)
    unknown = set(df["state"]) - set(STATES)
    if unknown:
        raise ValueError(f"states without a zone: {unknown}")
    df["zone"] = df["state"].map(lambda s: STATES[s][0])
    df["gsdp_reliable"] = df["year"].between(*GSDP_RELIABLE)
    return df.sort_values(["state", "year"]).reset_index(drop=True)


def main() -> None:
    nat = build_national()
    panel = build_panel()
    state = build_state()

    compliance.assert_clean(nat, "drivers_national").to_csv(PROCESSED / "drivers_national.csv", index=False)
    compliance.assert_clean(panel, "panel_countries").to_csv(PROCESSED / "panel_countries.csv", index=False)
    compliance.assert_clean(state, "drivers_state").to_csv(PROCESSED / "drivers_state.csv", index=False)
    compliance.audit_frame().to_csv(PROCESSED / "compliance_audit_drivers.csv", index=False)

    pd.set_option("display.width", 200)
    print("India drivers, selected years:")
    print(nat[nat.year.isin([1990, 2000, 2010, 2020, 2025, 2030, 2040, 2047])]
          .round({"population": 0, "urban_share": 1, "gdp_pc_ppp": 0, "generation_twh": 0, "generation_pc_kwh": 0})
          .to_string(index=False))
    print(f"\npanel: {panel.iso.nunique()} countries, {len(panel):,} rows, {panel.year.min()}-{panel.year.max()}")

    # Does the official CSV's state GSDP track national real growth?
    g = state.groupby("year")["gsdp_crore"].sum().pct_change().mul(100).rename("state_sum_growth_pct")
    chk = pd.concat([g, nat.set_index("year")["gdp_growth_pct"].rename("national_growth_pct")], axis=1).loc[2012:2024]
    chk["gap"] = chk["state_sum_growth_pct"] - chk["national_growth_pct"]
    print("\nState-sum GSDP growth vs World Bank national real growth (%):")
    print(chk.round(1).T.to_string())
    w = chk.loc[GSDP_RELIABLE[0] + 1:GSDP_RELIABLE[1], "gap"]
    print(f"mean |gap| inside reliable window {GSDP_RELIABLE}: {w.abs().mean():.1f} pts;"
          f" after it: {chk.loc[GSDP_RELIABLE[1] + 1:, 'gap'].abs().mean():.1f} pts")


if __name__ == "__main__":
    main()
