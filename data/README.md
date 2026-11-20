# Data manifest — ExxonMobil Innothon

All files downloaded 2026-11-14 into `data/raw/`. Nothing here has been cleaned yet.

**Hard rule from the problem statement:** only *energy generated* (MU / GWh / TWh) may be used for
forecasting or comparison. Installed capacity and energy consumption must not be used.
The "Use" column below says which fields are allowed.

| Folder | Source | What it contains | Coverage | Use |
|---|---|---|---|---|
| `renewable-india-dataset/` | Official pointer: github.com/chrisjaimyantony/renewable-india-dataset (MIT) | State × year: installed MW of solar, wind, small hydro, biomass, waste-to-energy; `Zone`; `Population`; `GSDP (crore INR)` | 34 states/UTs, 2006–2024, 635 rows | **Only `State`, `Zone`, `Population`, `GSDP`.** The five `Installed - …` columns are capacity → banned. |
| `ember/` | Ember India electricity data (sourced from CEA) | State × fuel generation (GWh): coal, gas, hydro, nuclear, solar, wind, bioenergy, other | Monthly Jan 2019 – Nov 2025; yearly 2019–2024; 36 states/UTs + India total | Rows with `Category == "Electricity generation"`. **Drop `Category == "Capacity"`.** Emissions rows are fine as an outcome metric. |
| `npp/monthly_gen/<YYYY>-MAR/` | National Power Portal / CEA monthly generation reports (`18_col_act`, sub-reports 1–20) | Official generation in MU: all-India, region, state, sector, fuel, and station-wise (sub-report 16). March files carry the April–March fiscal-year cumulative for that year and the previous one | FY2018-19 to FY2025-26 (7 × 20 files). Archive starts March 2020. Conventional sources only (thermal, nuclear, large hydro) — no solar/wind | Only the `ACTUAL` generation columns. **Drop `Monitored Capacity (MW)` and `PLF` columns.** |
| `npp/publishedReports.html` | NPP reports index | URL pattern for other months: `/public-reports/cea/monthly/generation/18_col_act/<YYYY>/<MON>/18_col_act-<n>_<YYYY>-<MON>.xls` | — | Reference |
| `owid/owid-energy-data.csv` | Our World in Data energy dataset (Ember + Energy Institute) | Country × year generation by source (TWh), generation per capita, population, GDP | 252 entities; India 1985–2025 | `*_electricity` and `electricity_generation` columns. **Avoid `*_consumption`, `electricity_demand`, `primary_energy_consumption` columns.** |
| `worldbank/` | World Bank API | Urban population %, GDP per capita (PPP, constant), population, GDP growth — all countries 1985–2025; India population and urban-share projections to 2050 | — | All allowed (demographic / economic drivers) |
| `nasa_power/` | NASA POWER climatology API (2001–2025 means) | Gridded 0.5°–1° monthly + annual: solar irradiance `ALLSKY_SFC_SW_DWN` (kWh/m²/day), 50 m wind speed `WS50M`, temperature `T2M`, precipitation `PRECTOTCORR`. 9 tiles per parameter covering lon 68–98, lat 6–37 | — | All allowed (climatic indicators) |

| `geo/` | State boundary polygons (github.com/datta07/INDIAN-SHAPEFILES) | 37 state / UT polygons on 2020 boundaries (Ladakh and Telangana separate) | — | Allowed (geography). Areas are computed from the polygons. |
| `modis_landcover/` | NASA MODIS MCD12Q1 land cover (IGBP classes, ~463 m pixels) via the ORNL DAAC web service; fetched by `src/fetch_geo.py` | One ~120 km window for each of the 372 one-degree cells that touch India | 2023 | Allowed (land availability) |
| `elevation/` | Open-Meteo elevation API, with Open Topo Data SRTM as fallback; fetched by `src/fetch_geo.py` | Elevation on 0.5° and 0.1° lattices inside India | — | Allowed (terrain, relief) |

Downloaded on 2026-11-14 in a second pass, for the resource ceilings used by the optimiser.

## Things found while checking the data

1. **Both official pointers are capacity-based.** The GitHub CSV is installed MW; the "National Power Portal"
   link in the PDF goes to `npp.gov.in/dashBoard/cp-map-dashboard`, the capacity map. Generation has to come
   from the NPP published reports and Ember instead.
2. **Two definitions of "India's generation".** Ember/CEA utility generation is 1,804 TWh for 2024; OWID
   (which includes captive / non-utility plants) is 2,036 TWh. State-level data only exists for the utility
   definition. Pick one for the headline and state it.
3. **Calendar vs fiscal year.** Ember and OWID are calendar-year; NPP is April–March.
4. **Official CSV zones are six, not CEA's five grid regions**: North, South, East, West, Central
   (Chhattisgarh, Madhya Pradesh), North-East. Rajasthan is in West. Ladakh and Dadra & Nagar Haveli / Daman & Diu
   are absent from the CSV but present in Ember.
5. **Official CSV `GSDP` has a break in 2011**: 28 states jump more than 60 % in one year (e.g. Karnataka
   203,281 → 606,010), and 19 state-years are flat copies. Pre-2011 values are not comparable to later ones;
   needs splicing or replacing with RBI / MoSPI constant-price GSDP.
6. **State-level generation history is short** (2019 onward from Ember, FY2018-19 onward from NPP). National
   history goes back to 1985.

## Still to add (not downloaded)

- State population projections (National Commission on Population 2011–2036) and state urban shares (Census 2011).
- Wasteland Atlas of India 2019 state table: no machine-readable copy could be found, so land availability
  comes from MODIS satellite land cover instead. If the atlas table is obtained, it can replace the
  "open land" share in `src/build_resources.py`.
- Constant-price GSDP by state (RBI Handbook of Statistics on Indian States).
- Finer wind data (the MERRA-2 grid is ~50 km and smooths out wind corridors such as Palghat and Aralvaimozhi).
- Published cost benchmarks to replace the cost assumptions in `src/optimise.py`.
- CEA all-India generation by source before 1985, if a longer backtest is wanted.
