# Innothon — India's 2047 generation requirement

Generation-only pipeline (no installed capacity, no consumption). Data sources and
what is allowed from each are in [data/README.md](data/README.md).

**Live dashboard: <https://vinaaaaay.github.io/innothon-india-2047/>**

## Run

```bash
.venv/bin/python -I src/build_generation.py   # clean generation tables
.venv/bin/python -I src/build_drivers.py      # population, urbanisation, income
.venv/bin/python -I src/run_forecast.py       # hindcast, Monte Carlo forecast, regional requirement, figures 01-04
.venv/bin/python -I src/sensitivity.py        # robustness of the 2047 number to modelling choices
.venv/bin/python -I src/fetch_geo.py          # land cover and elevation downloads (skips files already on disk)
.venv/bin/python -I src/build_profiles.py     # base mix, seasonal shapes, emission factors, build pace
.venv/bin/python -I src/build_resources.py    # state solar / wind / hydro ceilings in TWh
.venv/bin/python -I src/run_optimiser.py      # strategies, need cases, sensitivities, figures 05-08
.venv/bin/python -I src/themes.py             # theme cards: definitions and default wedges (outputs/themes_reference.csv)
.venv/bin/python -I src/build_dashboard.py    # solves 2,880 optimiser cases and writes dashboard/data.js (about 4 min, 8 MB)
```

After changing only the themes or the dashboard text, `build_dashboard.py --reuse-grid` skips the optimiser and
reuses the runs cached in `outputs/grid_runs.json` (a few seconds).

## Dashboard

The dashboard is live at **<https://vinaaaaay.github.io/innothon-india-2047/>**. Pushing a change under
`dashboard/` redeploys it (`.github/workflows/pages.yml`); `gh workflow run pages.yml` forces a redeploy.

To run it locally instead, open `dashboard/index.html` in a browser (it works straight from disk), or serve the folder:

```bash
.venv/bin/python -m http.server 8765 --directory dashboard
```

The folder is a static site with no external dependencies, so it can be hosted on any static host. Keep the local
server in reserve for the live demo: the first page load pulls about 8 MB of `data.js`.

**Terminal (`index.html`, `term.css`, `term.js`, `provenance.js`)** is the main screen, built after the midpoint review:
one dark, minimal screen with an interactive map of India at the centre (six zones or 36 states; colour by growth,
requirement, generation, net flow, main source or clean share). Hover a region for its numbers; click it for its
requirement path and range, generation by source (2047 plan against 2025 actual), net flow and its states. Every
underlined number opens a **trace**: how it is calculated (with the actual inputs), the inputs (each traceable in
turn), the datasets behind it (raw file, cleaned table, publisher, URL), the code that computes it and the output
file to check it against. The dataset catalogue is `dashboard/provenance.js`.

The dashboard is the terminal only. It uses `lib.js` (helpers), `model.js` (forecast and optimiser-run lookup),
`themes.js` (theme wedges) and `data.js` (the bundle).

- **Settings** (top bar): NEED (P10 / P50 / P90), STRATEGY (carbon price), SUPPLY (share of open land usable for
  solar, wind ceiling, new coal, clean build pace) and THEMES (switch each theme on at its default size).
- The generation mix always comes from real optimiser runs: every setting is an exact run; with themes on, the
  requirement is interpolated between the two nearest solved requirement levels.

The earlier tabbed dashboard (forecast, themes and signposts with signpost entry and theme sliders, mix, evidence,
method) was retired on 2026-11-19 and is kept in `backups/analyst_view_2026-11-19/` (put `classic.html`, `app.js`,
`style.css` and `classic-term.css` back into `dashboard/` to use it).

### Themes and signposts

The history-based forecast cannot see new uses of electricity that no peer country had. Theme cards make the model
editable: each card is a direction India could take, with a physical driver, a conversion to TWh generated and the
share already captured by the baseline (`src/themes.py`, mirrored in `dashboard/themes.js`).

| Card | Driver set by the user | Generation per unit |
|---|---|---|
| AI and data-centre boom | TWh generated for data centres | 1 (15% already in baseline) |
| Clean-air push: EVs | share of road vehicle-km on electricity | 12.3 TWh per point at 2047 traffic (incl. network losses) |
| Green hydrogen hub | Mt of hydrogen a year | 55 TWh per Mt (served by dedicated solar and wind, outside the grid plan) |
| Hotter summers | extra cooling generation beyond the income trend | 1 |
| Manufacturing push | manufacturing share of GDP | 60 TWh per point at 2047 scale (50% already in baseline) |
| Efficiency drive | % of requirement saved | negative wedge |
| Oil and gas discovery | Moderate / Major | +0.15 / +0.3 points of GDP growth 2030–2040, and cheap domestic gas in the optimiser |

Each wedge follows an S-curve from 2025 to the 2047 setting (early / central / late timing). In each of 1,000
simulated futures every card also gets a random size (±30%) and timing (±2.5 years). **Signposts** are values
observed after 2025 (national generation, or a card's driver); each future is weighted by how close it comes to them
(Bayesian importance weighting), which narrows and shifts the 2047 range. The themed requirement then selects the
optimiser runs, so the mix, KPIs and other tabs follow: with themes or signposts on, the requirement is the chosen
quantile (P10 / P50 / P90) of the simulated futures. A "which signpost to watch" panel ranks candidate observations by
how much they would narrow the 2047 range (preposterior analysis). Card sizes are our assumptions in generation terms;
published studies appear inside each card for scale only and are never model inputs.

Finding: at 3% of open land, solar is at its resource ceiling in most states even at central need, so every themed TWh
is met by coal. With "Everything at once", coal in 2047 is about 2,180 TWh at 3% land, 1,770 at 5% land, and 1,120
(below 2025's 1,280) at 5% land with the faster clean build pace.

## Layout

| Path | What it is |
|---|---|
| `src/config.py` | Paths, years, state → zone map (six official zones and CEA's five regions) |
| `src/compliance.py` | Guard that raises if a capacity or consumption field reaches a processed table |
| `src/forecast.py` | The three national lenses, hindcast, weighting rule, state-resolved split |
| `src/run_forecast.py` | Forecast assumptions (top of file), Monte Carlo, outputs, figures |
| `src/build_resources.py` | Resource-ceiling assumptions (top of file): usable land shares, terrain limits, yields |
| `src/optimise.py` | The allocation model; every cost and policy assumption is a field of `Params` |
| `src/lp.py` | Small linear-programming layer over SciPy's HiGHS solver |
| `src/run_optimiser.py` | Named strategies, need cases, gas and ceiling sensitivities, figures |
| `src/themes.py` | Theme cards (sizes, conversions, sources), presets, signpost settings |
| `src/build_dashboard.py` | Scenario grid for the dashboard, map geometry, data bundle |
| `dashboard/` | The interactive dashboard (static site) |
| `data/processed/` | Clean tables (generation, drivers, seasonal shapes, resources) |
| `outputs/` | Forecast and mix CSVs, `model_parameters.json`, sensitivities, `figures/` |
| `.github/workflows/pages.yml` | Publishes `dashboard/` to GitHub Pages on every push that touches it |

## Method in brief

Generation per person is forecast from income and urbanisation through three independent lenses,
each anchored on 2025 actual generation:

1. **India's own history** — log-log fit on 1990–2025 with AR(1) errors.
2. **Development ladder** — ten-year elasticities of other growing economies, binned by income.
3. **Global panel** — country fixed effects, income, income squared, urban share.

Each lens is fitted on data up to 2005, 2010 and 2015 and asked to predict 2025; the ensemble
weights are the inverse of those errors, capped at 0.5 per lens. A 4,000-draw Monte Carlo varies
GDP growth, population, urbanisation, model parameters and the choice of lens.

The national figure is split across states by placing each state on the ladder at its own income
(population × ladder level), with state population shares and income convergence projected from
the organisers' CSV.

Headline definition: total electricity generation including captive plants, calendar year.
Utility-only generation is about 89 % of that (`data/processed/utility_bridge.csv`).

## Regional generation mix

A linear programme chooses, for 2030, 2035, 2040 and 2047, how much each state generates from coal
(existing and new), gas, hydro, nuclear, solar and wind. It works only in energy (TWh):

- **Requirement**: the national forecast (utility basis) with the seasonal shape of observed generation; every month must be met.
- **Resource ceilings**: solar and wind from satellite land cover × irradiance or wind speed, with mountains excluded;
  hydro from rainfall × relief, scaled by what well-developed states convert today.
- **Seasons**: monthly solar, wind and hydro shapes by zone from observed generation; coal and gas may swing
  within the range regional fleets have demonstrated.
- **Day and night**: solar beyond what daytime need can absorb is shifted through storage (with a loss and a cost) or curtailed.
- **Pace**: additions are limited to India's demonstrated build pace times an allowed acceleration; what is built stays.
- **Coal**: the existing fleet ages after 2035 and no state winds coal down faster than 5 % a year.
- **Zones**: generation made beyond a zone's own need pays a transfer cost, which pulls generation towards need.

Strategies differ by carbon price (0, 2,000 and 6,000 INR per tonne CO2). `outputs/allocation_reasons.csv`
records, for every state and source, which constraint decided its level.
