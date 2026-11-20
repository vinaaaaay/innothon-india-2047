"""Theme cards: directions India could take that the history-based forecast cannot see.

The baseline forecast (run_forecast.py) learns how generation per person rises with income,
population and urbanisation. It cannot know about an AI data-centre boom, a pollution-driven
switch to electric vehicles or a domestic gas find. Each card adds (or removes) a wedge of
*generation requirement* on top of that baseline, so the model stays editable: switch a card
on, set how far the theme goes by 2047 and how early it arrives.

Everything is expressed as energy generated (TWh). A card has a physical driver that people can
watch (share of road vehicle-km on electricity, Mt of green hydrogen, manufacturing share of GDP ...),
an assumed amount of generation per unit of driver at 2047 scale, and an "already in the baseline"
share that removes the part of the theme the history-based lenses already capture (peer countries
also built factories as they got richer, but none had an EV fleet or electrolysers).

Card sizes are scenario assumptions in generation terms. Published studies are listed on each card
for scale only; several of them report electricity *used*, so they are never model inputs.

Signposts: when a driver is observed (in 2030, 2035 ...), the dashboard re-weights the Monte Carlo
futures by how well each one matches what was seen (Bayesian importance weighting). The same
functions are implemented in dashboard/themes.js; the build compares them (check_themes_port).
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np
import pandas as pd

from config import BASE_YEAR, OUTPUTS, PROCESSED, TARGET_YEAR

STEEPNESS = 0.32          # logistic slope (per year) of every adoption curve
TIMING = {"early": -5, "central": 0, "late": 5}   # shift of the curve's midpoint, years
SIZE_SD = 0.30            # log-sd of each card's 2047 size across Monte Carlo futures
TIMING_SD = 2.5           # sd of each card's midpoint across futures, years
OBS_SD_DRIVER = 0.10      # relative sd of an observed driver (definitions differ between sources)
REVISION_SD = 0.01        # relative sd of data revisions to a national generation figure
H2_KWH_PER_KG = 55        # electrolyser (about 50 kWh/kg) plus compression and balance of plant

# Gas lever used by the oil & gas card in the optimiser grid (see build_dashboard.py).
GAS_DISCOVERY = {
    "Gas cost, INR per kWh": (7.5, 4.5),
    "Gas output cap, multiple of each state's best year": (2.0, 5.0),
    "Allowance for states with no gas plants, TWh": (5.0, 20.0),
    "Annual growth allowed on gas build pace": (0.0, 0.06),
}

CARDS = [
    {
        "id": "datacentres", "name": "AI and data-centre boom", "short": "Data centres",
        "story": "India becomes a hub for cloud and AI computing. Data centres cluster around Mumbai, Chennai, Hyderabad, Bengaluru and Noida.",
        "driver": "Generation for data centres", "unit": "TWh", "today": 15.0, "today_year": 2025,
        "today_note": "about 15 TWh of generation in 2025 (our estimate)",
        "range": [15, 500], "step": 1, "default": 250, "conversion": 1.0, "conversion_note": "the driver is already in TWh generated",
        "in_baseline": 0.15, "midpoint": 2034, "scales_with_economy": False,
        "states": {"Maharashtra": 0.34, "Tamil Nadu": 0.20, "Telangana": 0.16, "Karnataka": 0.12, "Uttar Pradesh": 0.10,
                   "Delhi": 0.04, "Haryana": 0.04},
        "signpost": True,
        "refs": [["IEA, Energy and AI (2025)", "about 9 TWh in 2024"],
                 ["S&P Global (2025)", "13 TWh in 2024 rising to 57 TWh by 2030"],
                 ["Deloitte India (2025)", "40 to 50 TWh more for AI data centres by 2030"]],
        "why_baseline": "Peer countries' history includes some growth in IT and services load, so a small part is already counted.",
    },
    {
        "id": "ev", "name": "Clean-air push: electric vehicles", "short": "EVs",
        "story": "Pollution leads to curbs on petrol and diesel vehicles and strong support for electric two-wheelers, buses, cars and trucks.",
        "driver": "Share of road vehicle-km driven on electricity", "unit": "%", "today": 1.0, "today_year": 2025,
        "today_note": "about 1% of road vehicle-km in 2025 (our estimate; sales shares are much higher than fleet shares)",
        "range": [1, 100], "step": 1, "default": 60, "conversion": 12.3,
        "conversion_note": "our assumption of generation per percentage point of road vehicle-km at 2047 traffic: about 10.7 TWh at the charger (the order of magnitude of published full-electrification estimates) plus about 15% network losses. Smaller in earlier years because there is less traffic",
        "in_baseline": 0.0, "midpoint": 2038, "scales_with_economy": True,
        "states": "population",
        "signpost": True,
        "refs": [["Climate Policy Initiative (2026)", "about 1,070 TWh a year by 2047 if road transport is fully electric"],
                 ["IEA via Ember", "about 25 TWh of charging in 2030"],
                 ["Journal study (2023)", "about 295 TWh by 2050 with ambitious policy"]],
        "why_baseline": "None of the countries the baseline learns from electrified road transport while getting richer, so nothing is already counted.",
    },
    {
        "id": "hydrogen", "name": "Green hydrogen hub", "short": "Hydrogen",
        "story": "India makes hydrogen with electrolysers as a feedstock for fertiliser, refining and steel-making, and for export, as the National Green Hydrogen Mission intends.",
        "driver": "Green hydrogen produced per year", "unit": "Mt", "today": 0.0, "today_year": 2025,
        "today_note": "close to zero in 2025",
        "range": [0, 30], "step": 0.5, "default": 10, "conversion": H2_KWH_PER_KG,
        "conversion_note": f"{H2_KWH_PER_KG} kWh per kg: electrolyser efficiency (about 50 kWh/kg) plus compression, an engineering figure",
        "in_baseline": 0.0, "midpoint": 2036, "scales_with_economy": False, "dedicated": True,
        "states": {"Gujarat": 0.30, "Rajasthan": 0.20, "Tamil Nadu": 0.15, "Odisha": 0.12, "Andhra Pradesh": 0.10, "Karnataka": 0.08,
                   "Maharashtra": 0.05},
        "signpost": True,
        "refs": [["IRADe roadmap", "about 257 TWh for 5 Mt in 2030 (51 TWh per Mt)"],
                 ["CEEW (2022)", "about 310 TWh for 5 Mt (62 TWh per Mt)"],
                 ["National Green Hydrogen Mission", "target of 5 Mt a year by 2030"]],
        "why_baseline": "No peer country produced electrolytic hydrogen at scale, so nothing is already counted.",
        "note": "Green hydrogen only counts as green if it runs on its own solar and wind, so this wedge is served by dedicated plants, not the grid plan. The supply panel shows the extra land it needs.",
    },
    {
        "id": "cooling", "name": "Hotter summers", "short": "Cooling",
        "story": "Heatwaves become longer and more frequent than in the historical record, pushing air-conditioning and fan use beyond what rising incomes alone would bring.",
        "driver": "Extra generation for cooling beyond the income trend", "unit": "TWh", "today": 0.0, "today_year": 2025,
        "today_note": "zero by definition: this card is only the extra heat",
        "range": [0, 400], "step": 5, "default": 150, "conversion": 1.0, "conversion_note": "the driver is already in TWh generated",
        "in_baseline": 0.0, "midpoint": 2038, "scales_with_economy": False,
        "states": "population",
        "signpost": False,
        "refs": [["Our assumption", "a stress test; no study isolates warming from income growth"]],
        "why_baseline": "Cooling that comes with higher incomes is already in the baseline; this card is only the extra heat.",
    },
    {
        "id": "manufacturing", "name": "Manufacturing push", "short": "Manufacturing",
        "story": "Make in India succeeds: factories for electronics, machinery, batteries, textiles and chemicals raise manufacturing's share of the economy. (Hydrogen for steel is counted on the hydrogen card.)",
        "driver": "Manufacturing share of GDP", "unit": "%", "today": 17.0, "today_year": 2025,
        "today_note": "about 17% of GDP in 2025",
        "range": [17, 30], "step": 0.5, "default": 25, "conversion": 60.0,
        "conversion_note": "assumed generation per percentage point of GDP at the 2047 economy's size; smaller in earlier years",
        "in_baseline": 0.5, "midpoint": 2037, "scales_with_economy": True,
        "states": {"Gujarat": 0.20, "Maharashtra": 0.18, "Tamil Nadu": 0.16, "Karnataka": 0.10, "Uttar Pradesh": 0.10, "Odisha": 0.08,
                   "Andhra Pradesh": 0.06, "Telangana": 0.06, "Haryana": 0.06},
        "signpost": True,
        "refs": [["Government target", "manufacturing at 25% of GDP"],
                 ["Our assumption", "about 60 TWh of generation per percentage point by 2047"]],
        "why_baseline": "The development ladder learns from China, Korea and others who industrialised, so about half of a push is already counted.",
    },
    {
        "id": "efficiency", "name": "Efficiency drive", "short": "Efficiency",
        "story": "Tighter appliance, building and motor standards mean the same comfort and output need less generation.",
        "driver": "Requirement saved", "unit": "%", "today": 0.0, "today_year": 2025,
        "range": [0, 20], "step": 0.5, "default": 10, "conversion": None, "in_baseline": 0.0, "midpoint": 2036,
        "states": "population",
        "signpost": False,
        "refs": [["NITI Aayog IESS 2047", "names efficiency among the cheapest levers"]],
        "why_baseline": "The baseline already includes normal efficiency gains; this card is savings beyond them.",
        "negative": True,
    },
    {
        "id": "oilgas", "name": "Domestic oil and gas discovery", "short": "Oil and gas",
        "story": "A large offshore find, like Brazil's pre-salt fields, gives India its own oil and cheap gas.",
        "driver": "Size of the find", "unit": "", "today": None, "today_year": None,
        "levels": ["Moderate", "Major"], "default": "Major",
        "gdp_boost_pts": {"Moderate": 0.15, "Major": 0.3}, "gdp_boost_years": [2030, 2040],
        "states": None, "signpost": False,
        "refs": [["Our reasoning", "India makes almost no electricity from oil, so a find changes the mix more than the requirement"]],
        "why_baseline": "Not a requirement wedge: it raises GDP growth a little (which the lenses turn into requirement) and makes gas cheaper for the optimiser. The manufacturing card is a structural shift beyond what GDP growth alone brings, so the two do not overlap.",
    },
]

PRESETS = {
    "Baseline only": {},
    "Digital India": {"datacentres": {"value": 350, "timing": "early"}, "manufacturing": {"value": 24, "timing": "central"}},
    "Clean-air India": {"ev": {"value": 80, "timing": "early"}, "efficiency": {"value": 12, "timing": "central"},
                        "cooling": {"value": 150, "timing": "central"}},
    "Energy-rich India": {"oilgas": {"value": "Major", "timing": "central"}, "manufacturing": {"value": 25, "timing": "central"},
                          "hydrogen": {"value": 5, "timing": "late"}},
    "Everything at once": {"datacentres": {"value": 250, "timing": "central"}, "ev": {"value": 60, "timing": "central"},
                           "hydrogen": {"value": 10, "timing": "central"}, "cooling": {"value": 150, "timing": "central"},
                           "manufacturing": {"value": 25, "timing": "central"}},
}


def observation_sd() -> float:
    """How far one year's national generation strays from a smooth path: year-on-year growth around its
    7-year centred mean (weather, monsoon, business cycle), combined with data revisions."""
    h = pd.read_csv(PROCESSED / "generation_national_history.csv")
    g = np.log(h[h.year >= 1995].set_index("year")["Total"]).diff().dropna()
    noise = float((g - g.rolling(7, center=True).mean()).dropna().std())
    return round(float(np.hypot(noise, REVISION_SD)), 4)


def logistic(year, mid: float):
    return 1.0 / (1.0 + np.exp(-STEEPNESS * (np.asarray(year, dtype=float) - mid)))


def adoption(year, mid: float):
    """0 in the base year, 1 in 2047, S-shaped in between."""
    a0, a1 = logistic(BASE_YEAR, mid), logistic(TARGET_YEAR, mid)
    return (logistic(year, mid) - a0) / (a1 - a0)


def card_driver(card: dict, value: float, timing: str, years, size_mult: float = 1.0, mid_shift: float = 0.0):
    """Driver path (physical units). Size uncertainty scales the change from today's level; a share cannot pass its range."""
    mid = card["midpoint"] + TIMING[timing] + mid_shift
    return np.minimum(card["range"][1], card["today"] + (value - card["today"]) * size_mult * adoption(years, mid))


def card_wedge(card: dict, value: float, timing: str, years, baseline, size_mult: float = 1.0, mid_shift: float = 0.0):
    """Net generation wedge (TWh) added to the baseline. Conversions are at 2047 scale; cards whose driver is a share
    of the economy scale with the baseline path (less traffic and a smaller economy in earlier years)."""
    baseline = np.asarray(baseline, dtype=float)
    if card.get("negative"):
        mid = card["midpoint"] + TIMING[timing] + mid_shift
        return -baseline * value / 100 * size_mult * adoption(years, mid)
    d = card_driver(card, value, timing, years, size_mult, mid_shift)
    scale = baseline / baseline[-1] if card.get("scales_with_economy") else 1.0
    return (d - card["today"]) * card["conversion"] * (1 - card["in_baseline"]) * scale


def reference_table(baseline: pd.Series) -> pd.DataFrame:
    """Every wedge card at its default setting, central timing, by year (deterministic)."""
    years = baseline.index.values
    rows = []
    for c in CARDS:
        if "conversion" not in c:
            continue
        w = card_wedge(c, c["default"], "central", years, baseline.values)
        for y, v in zip(years, w):
            rows.append({"card": c["name"], "year": int(y), "default_setting": f"{c['default']} {c['unit']}".strip(),
                         "net_wedge_twh": round(float(v), 2)})
    return pd.DataFrame(rows)


def export() -> dict:
    return {"cards": CARDS, "presets": PRESETS, "steepness": STEEPNESS, "timing": TIMING, "size_sd": SIZE_SD,
            "timing_sd": TIMING_SD, "obs_sd_national": observation_sd(), "obs_sd_driver": OBS_SD_DRIVER,
            "gas_discovery": {k: list(v) for k, v in GAS_DISCOVERY.items()}}


def main() -> None:
    fc = pd.read_csv(OUTPUTS / "forecast_national.csv")
    base = fc[fc.series == "ensemble"].set_index("year")["p50_twh"]
    ref = reference_table(base)
    ref.to_csv(OUTPUTS / "themes_reference.csv", index=False)
    w47 = ref[ref.year == TARGET_YEAR].set_index("card")["net_wedge_twh"]
    print(f"baseline P50 2047: {base.loc[TARGET_YEAR]:,.0f} TWh; observation sd for national generation {observation_sd():.3f}")
    print("net wedge in 2047 at each card's default setting (TWh):")
    print(w47.round(0).to_string())
    print(f"all wedge cards together: {w47.sum():+,.0f} TWh -> {base.loc[TARGET_YEAR] + w47.sum():,.0f} TWh")
    json.dump(export(), open(OUTPUTS / "themes.json", "w"), indent=1)


if __name__ == "__main__":
    main()
