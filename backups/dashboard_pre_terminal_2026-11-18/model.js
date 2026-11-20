/* Forecast lenses (recomputed live) and optimiser results (pre-solved grid, interpolated on need only).
   Everything is in generation terms: TWh, kWh per person. */
(function () {
  "use strict";
  const D = window.DATA, F = D.forecast, O = D.optimiser, R = D.regions;
  const MS = O.milestones, YEARS5 = [D.base_year].concat(MS), ZONES = R.zones, STATES = R.states, SRC = O.sources;
  const AX = O.axes, NZ = ZONES.length, NS = SRC.length, NM = MS.length;
  const FIXED_TOTAL = ZONES.reduce((a, z) => a + R.zone_fixed[z], 0);
  const SHAPE_SRC = { Hydro: 3, Nuclear: 2, Wind: 4, Solar: 5 };   // index into SRC

  function interp(x, xs, ys) {
    if (x <= xs[0]) return ys[0];
    const n = xs.length;
    if (x >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= x) lo = mid; else hi = mid; }
    return ys[lo] + (ys[hi] - ys[lo]) * (x - xs[lo]) / (xs[hi] - xs[lo]);
  }

  // ---- development ladder: cumulative elasticity over log income --------------
  const LG = F.lens.ladder.grid, GRID = [], CUM = [0];
  for (let i = 0; i < LG[2]; i++) GRID.push(LG[0] + (LG[1] - LG[0]) * i / (LG[2] - 1));
  const EPS = GRID.map(g => interp(g, F.lens.ladder.nodes_ln, F.lens.ladder.elasticity));
  for (let i = 1; i < GRID.length; i++) CUM.push(CUM[i - 1] + (EPS[i] + EPS[i - 1]) / 2 * (GRID[i] - GRID[i - 1]));
  const ladderLevel = lnY => interp(lnY, GRID, CUM);

  const boostAt = (s, y) => s.boost && y >= s.boost.years[0] && y <= s.boost.years[1] ? s.boost.pts : 0;

  /** Deterministic scenario: the three lenses and their weighted combination, 2025-2047 (TWh, total generation). */
  function scenario(s) {
    const years = F.years, n = years.length, span = n - 1;
    const u0 = F.urban[0] / 100, W = F.lens.weights, il = F.lens.india, b = F.lens.panel.b, anchor = F.lens.anchor_ln;
    const out = { years, pop: [], urban: [], gdpPc: [], india: [], ladder: [], panel: [], ensemble: [] };
    let gdpTotal = F.gdp_pc_base * F.population[0], x0 = 0, lv0 = 0;
    for (let i = 0; i < n; i++) {
      const pop = F.population[i] * (1 + (s.pop / 100) * i / span);
      const urban = u0 + (s.urban / 100 - u0) * i / span;
      if (i > 0) gdpTotal *= 1 + (s.g0 + (s.g1 - s.g0) * (i - 1) / (span - 1) + boostAt(s, years[i])) / 100;
      const gdpPc = gdpTotal / pop, x = Math.log(gdpPc), lv = ladderLevel(x);
      if (i === 0) { x0 = x; lv0 = lv; }
      const india = Math.exp(il.intercept + il.elasticity * x + il.resid * Math.pow(il.rho, i)) * pop / 1e9;
      const ladder = Math.exp(anchor + lv - lv0) * pop / 1e9;
      const panel = Math.exp(anchor + b[0] * (x - x0) + b[1] * (x * x - x0 * x0) + b[2] * (urban - u0)) * pop / 1e9;
      out.pop.push(pop); out.urban.push(urban * 100); out.gdpPc.push(gdpPc);
      out.india.push(india); out.ladder.push(ladder); out.panel.push(panel);
      out.ensemble.push(W.india * india + W.ladder * ladder + W.panel * panel);
    }
    return out;
  }

  function runIndex(needIdx, s) {
    const c = AX.carbon.indexOf(s.carbon), l = AX.solar_land_pct.indexOf(s.land), w = AX.wind_scale.indexOf(s.wind), k = AX.new_coal.indexOf(s.coal);
    const p = AX.clean_pace.indexOf(s.pace ? 1 : 0), g = AX.gas.indexOf(s.gas ? 1 : 0);
    return (((((needIdx * AX.carbon.length + c) * AX.solar_land_pct.length + l) * AX.wind_scale.length + w) * AX.new_coal.length + k) * AX.clean_pace.length + p) * AX.gas.length + g;
  }
  const blend = (a, b, t) => a.map((v, i) => v * (1 - t) + b[i] * t);

  /** Optimiser plan for the current controls. Custom need, or a need set by themes and signposts (`target2047`),
      is interpolated between the two nearest solved need levels. `s.gas` selects the gas-discovery runs. */
  function getPlan(s, target2047) {
    let raw, info = { interpolated: false, clamped: false, between: null, custom2047: null };
    if (s.need !== "custom" && target2047 == null) {
      raw = O.runs[runIndex(AX.need_quantiles.indexOf(s.need), s)];
    } else {
      const fam = AX.need_family_twh, target = target2047 != null ? target2047 : (() => { const sc = scenario(s); return sc.ensemble[sc.ensemble.length - 1]; })();
      const v = Math.min(Math.max(target, fam[0]), fam[fam.length - 1]);
      let i = 0;
      while (i < fam.length - 2 && fam[i + 1] <= v) i++;
      const t = (v - fam[i]) / (fam[i + 1] - fam[i]);
      const A = O.runs[runIndex(AX.need_quantiles.length + i, s)], B = O.runs[runIndex(AX.need_quantiles.length + i + 1, s)];
      raw = { z: blend(A.z, B.z, t), s: blend(A.s, B.s, t), m: blend(A.m, B.m, t), k: blend(A.k, B.k, t), b: blend(A.b, B.b, t), r: t < 0.5 ? A.r : B.r };
      info = { interpolated: true, clamped: Math.abs(v - target) > 0.5, between: [fam[i], fam[i + 1]], custom2047: target, used2047: v };
    }
    return decode(raw, info, s);
  }

  function decode(raw, info, s) {
    const plan = { info, years: YEARS5, zone: [], nat: [], total: [], summary: [], monthly: [], build: [], zoneBal: [], state: {}, reasons: {} };
    // zone mix: year 0 is the observed base
    plan.zone.push(Object.fromEntries(ZONES.map(z => [z, R.zone_base[z].slice()])));
    for (let y = 0; y < NM; y++) {
      const o = {};
      ZONES.forEach((z, zi) => { o[z] = SRC.map((_, si) => raw.z[(y * NZ + zi) * NS + si] / 10); });
      plan.zone.push(o);
    }
    plan.zone.forEach(o => {
      const nat = SRC.map((_, si) => ZONES.reduce((a, z) => a + o[z][si], 0));
      plan.nat.push(nat);
      plan.total.push(nat.reduce((a, v) => a + v, 0) + FIXED_TOTAL);
    });
    // summary
    const other = R.fixed_national.Other, bs = O.base_summary;
    plan.summary.push({ need: plan.total[0], gen: plan.total[0], em: bs.emissions, shift: 0, curt: 0, uns: 0, transfer: bs.transfer, cost: null,
                        clean: 1 - (plan.nat[0][0] + plan.nat[0][1] + other) / plan.total[0], intensity: bs.emissions / plan.total[0] * 1000 });
    for (let y = 0; y < NM; y++) {
      const k = raw.k.slice(y * 8, y * 8 + 8), gen = plan.total[y + 1], nat = plan.nat[y + 1];
      plan.summary.push({ need: k[0], gen, em: k[2], shift: k[3], curt: k[4], uns: k[5], transfer: k[6], cost: k[7],
                          clean: 1 - (nat[0] + nat[1] + other) / gen, intensity: k[2] / gen * 1000 });
    }
    // monthly balance (source shapes are the observed seasonal factors by zone)
    for (let y = 0; y < NM; y++) {
      const rows = [];
      for (let m = 0; m < 12; m++) {
        const v = raw.m.slice((y * 12 + m) * 6, (y * 12 + m) * 6 + 6);
        const row = { coal: v[0] / 10, gas: v[1] / 10, shift: v[2] / 10, curt: v[3] / 10, uns: v[4] / 10, price: v[5] / 100,
                      hydro: 0, nuclear: 0, wind: 0, solar: 0, fixed: 0, need: plan.summary[y + 1].need * O.need_shape[m] / 12 };
        ZONES.forEach(z => {
          const zm = plan.zone[y + 1][z], sh = O.shapes[z];
          row.hydro += zm[SHAPE_SRC.Hydro] * sh.Hydro[m] / 12;
          row.nuclear += zm[SHAPE_SRC.Nuclear] * sh.Nuclear[m] / 12;
          row.wind += zm[SHAPE_SRC.Wind] * sh.Wind[m] / 12;
          row.solar += zm[SHAPE_SRC.Solar] * sh.Solar[m] / 12;
          row.fixed += R.zone_fixed[z] * (sh.Bioenergy[m] + sh.Other[m]) / 2 / 12;
        });
        rows.push(row);
      }
      plan.monthly.push(rows);
      plan.build.push(O.build_sources.map((_, ki) => raw.b[y * O.build_sources.length + ki] / 10));
    }
    // zone balance: what a zone makes against its share of the national requirement
    YEARS5.forEach((_, yi) => {
      const o = {};
      ZONES.forEach(z => {
        const made = plan.zone[yi][z].reduce((a, v) => a + v, 0) + R.zone_fixed[z], need = R.zone_need_share[z][yi] * plan.total[yi];
        o[z] = { made, need, net: made - need };
      });
      plan.zoneBal.push(o);
    });
    // states (base year and 2047)
    const last = YEARS5.length - 1, NO = O.opt_sources.length;
    STATES.forEach((st, i) => {
      const info2 = R.state[st], y47 = SRC.map((_, si) => raw.s[i * NS + si] / 10);
      const made0 = info2.base.reduce((a, v) => a + v, 0) + info2.fixed, made1 = y47.reduce((a, v) => a + v, 0) + info2.fixed;
      const need0 = info2.need_share[0] * plan.total[0], need1 = info2.need_share[last] * plan.total[last];
      plan.state[st] = { base: info2.base, y47, made0, made1, need0, need1, hasNeed: info2.need_share[last] > 0 };
      const rs = {};
      O.opt_sources.forEach((k, ki) => { const c = raw.r[i * NO + ki]; if (c !== "-") rs[k] = O.reasons[c.charCodeAt(0) - 97]; });
      plan.reasons[st] = rs;
    });
    plan.ceilingScale = { Solar: s.land / 3, Wind: s.wind, Hydro: 1 };
    return plan;
  }

  window.MODEL = { scenario, getPlan, YEARS5, MS, ZONES, STATES, SRC, FIXED_TOTAL };
})();
