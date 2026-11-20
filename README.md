# India's 2047 generation requirement

ExxonMobil Innothon entry: how much electricity India must generate by 2047, where it comes from
in each region, and a dashboard where every number can be traced to its source.

**Live dashboard: <https://vinaaaaay.github.io/innothon-india-2047/>**

Everything is in **energy generated** (MU / GWh / TWh); installed capacity and consumption are never
used, and `src/compliance.py` raises if such a field reaches a processed table (per-source rules:
[data/README.md](data/README.md)). Headline basis: total generation including captive plants,
calendar year — utility-only is ~89 % of that, and state data exists only on the utility basis.

## Forecast

Generation per person is projected from income and urbanisation through three independent lenses,
each anchored on 2025 actual generation:

1. **India's own history** — log-log fit, 1990–2025, AR(1) errors.
2. **Development ladder** — ten-year elasticities of other growing economies, binned by income.
3. **Global panel** — country fixed effects, income, income², urban share.

Each lens is refitted at 2005, 2010 and 2015 and scored on its 2025 prediction; ensemble weights are
the inverse of those hindcast errors, capped at 0.5 per lens. A 4,000-draw Monte Carlo varies GDP
growth, population, urbanisation, model parameters and the choice of lens. The national figure is
split across states by placing each on the ladder at its own income (population × ladder level).

**Result: 4,847 TWh in 2047 (P50), likely range 4,076–6,548, against 2,082 TWh in 2025.**

## Regional generation mix

A linear programme (`src/optimise.py`, HiGHS via `src/lp.py`) chooses, for 2030/2035/2040/2047, how
much each state generates from coal (existing and new), gas, hydro, nuclear, solar and wind — in TWh
only, subject to:

- **Requirement** — national forecast on the utility basis, shaped by observed seasonality; every month must be met.
- **Ceilings** — solar and wind from satellite land cover × irradiance or wind speed, mountains excluded;
  hydro from rainfall × relief, scaled by what well-developed states convert today.
- **Seasons** — monthly solar, wind and hydro shapes by zone; coal and gas swing only as far as regional fleets have demonstrated.
- **Day and night** — solar beyond what daytime need absorbs is stored (with loss and cost) or curtailed.
- **Pace** — additions capped at India's demonstrated build rate × an allowed acceleration; what is built stays.
- **Coal** — the existing fleet ages after 2035; no state winds coal down faster than 5 % a year.
- **Zones** — generation beyond a zone's own need pays a transfer cost.

Strategies differ by carbon price (0 / 2,000 / 6,000 INR per tonne CO₂). `outputs/allocation_reasons.csv`
records which constraint set every state-and-source level.

## Themes and signposts

A history-based forecast cannot see uses of electricity no peer country had. Theme cards make the
model editable: each is a direction India could take, with a physical driver and a conversion to TWh
generated (`src/themes.py`, mirrored in `dashboard/themes.js`).

| Card | Driver you set | Generation per unit |
|---|---|---|
| AI and data-centre boom | TWh for data centres | 1 (15 % already in baseline) |
| Clean-air push: EVs | % of road vehicle-km electric | 12.3 TWh per point at 2047 traffic, incl. losses |
| Green hydrogen hub | Mt of hydrogen a year | 55 TWh per Mt (dedicated solar and wind, outside the grid plan) |
| Hotter summers | extra cooling generation beyond the income trend | 1 |
| Manufacturing push | manufacturing % of GDP | 60 TWh per point at 2047 scale (50 % already in baseline) |
| Efficiency drive | % of requirement saved | negative wedge |
| Oil and gas discovery | Moderate / Major | +0.15 / +0.3 pts GDP growth 2030–2040, plus cheap domestic gas |

Each wedge follows an S-curve to its 2047 setting; across 1,000 simulated futures every card draws a
random size (±30 %) and timing (±2.5 years). **Signposts** are post-2025 observations — national
generation, or a card's driver — and each future is weighted by how closely it matches them
(Bayesian importance weighting), narrowing the 2047 range; a preposterior panel ranks which signpost
would narrow it most. Card sizes are our stated assumptions: published studies appear inside each
card for scale only and are never model inputs.

**Finding:** at 3 % of open land, solar is already at its ceiling in most states, so every themed TWh
falls to coal. Under "Everything at once", 2047 coal is ~2,180 TWh at 3 % land, 1,770 at 5 %, and
1,120 — below 2025's 1,280 — at 5 % land with a faster clean build pace.

## Dashboard

One dark screen with an interactive map of India at the centre (six zones or 36 states; coloured by
growth, requirement, generation, net flow, main source or clean share). Hover a region for its
numbers; click for its requirement path and range, generation by source (2047 plan vs 2025 actual),
net flow and its states.

Every underlined number opens a **trace**: the formula with its actual inputs, each input traceable
in turn, the datasets behind it (raw file, cleaned table, publisher, URL), the code that computes it
and the output file to check it against (catalogue: `dashboard/provenance.js`).

Top-bar settings: NEED (P10 / P50 / P90), STRATEGY (carbon price), SUPPLY (usable open land, wind
ceiling, new coal, build pace), THEMES. The mix always comes from real optimiser runs — every
setting is an exact solved run; with themes on, the requirement is interpolated between the two
nearest solved levels.

Static site, no dependencies; anything pushed under `dashboard/` redeploys via
`.github/workflows/pages.yml`. To serve it locally — worth having ready for a live demo, since first
load pulls ~8 MB of `data.js`:

```bash
.venv/bin/python -m http.server 8765 --directory dashboard
```

## Run the pipeline

```bash
.venv/bin/python -I src/build_generation.py   # clean generation tables
.venv/bin/python -I src/build_drivers.py      # population, urbanisation, income
.venv/bin/python -I src/run_forecast.py       # hindcast, Monte Carlo, regional requirement, figures 01-04
.venv/bin/python -I src/sensitivity.py        # robustness of the 2047 number to modelling choices
.venv/bin/python -I src/fetch_geo.py          # land cover and elevation (skips files already on disk)
.venv/bin/python -I src/build_profiles.py     # base mix, seasonal shapes, emission factors, build pace
.venv/bin/python -I src/build_resources.py    # state solar / wind / hydro ceilings in TWh
.venv/bin/python -I src/run_optimiser.py      # strategies, need cases, sensitivities, figures 05-08
.venv/bin/python -I src/themes.py             # theme cards and default wedges
.venv/bin/python -I src/build_dashboard.py    # solves 2,880 optimiser cases -> dashboard/data.js (~4 min, 8 MB)
```

`build_dashboard.py --reuse-grid` skips the optimiser and reuses `outputs/grid_runs.json` (seconds)
when only themes or dashboard text changed.

## Layout

| Path | What it is |
|---|---|
| `src/config.py` | Paths, years, state → zone map (six official zones, CEA's five regions) |
| `src/compliance.py` | Guard against capacity or consumption fields |
| `src/forecast.py` | The three lenses, hindcast, weighting, state split |
| `src/run_forecast.py` | Forecast assumptions (top of file), Monte Carlo, outputs, figures |
| `src/build_resources.py` | Resource-ceiling assumptions: usable land, terrain limits, yields |
| `src/optimise.py` | Allocation model; every cost and policy assumption is a field of `Params` |
| `src/lp.py` | Linear-programming layer over SciPy's HiGHS |
| `src/run_optimiser.py` | Named strategies, need cases, gas and ceiling sensitivities, figures |
| `src/themes.py` | Theme cards, presets, signpost settings |
| `src/build_dashboard.py` | Scenario grid, map geometry, data bundle |
| `dashboard/` | The dashboard (static site) |
| `data/processed/` | Clean tables; `data/raw/` the sources as downloaded |
| `outputs/` | Forecast and mix CSVs, `model_parameters.json`, sensitivities, `figures/` |

The retired tabbed dashboard was removed on 2026-11-20; `git checkout 1b067a2 -- backups/` restores it.
