/* Theme cards and signposts (mirrors src/themes.py).
   A theme adds a wedge of generation requirement on top of the history-based baseline.
   A signpost is something observed later (generation in 2030, EV share in 2032 ...); it re-weights
   the simulated futures by how well each matches the observation (Bayesian importance weighting). */
(function () {
  "use strict";
  const D = window.DATA, T = D.themes, F = D.forecast, M = window.MODEL;
  const YRS = F.years, NY = YRS.length, LAST = NY - 1, B = D.base_year, TY = D.target_year;
  const CARDS = T.cards, BY = Object.fromEntries(CARDS.map(c => [c.id, c]));
  const ND = T.draws.length;

  // ---- fixed random numbers (seeded, so moving a slider never reshuffles the futures) ----
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  const rnd = mulberry32(2047);
  const normal = () => { let u = 0; while (u === 0) u = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd()); };
  const Z = {};
  CARDS.forEach(c => { Z[c.id] = { size: Float64Array.from({ length: ND }, normal), time: Float64Array.from({ length: ND }, normal) }; });
  const VOI_TRIALS = 250;
  const NOISE = Float64Array.from({ length: VOI_TRIALS }, normal);   // observation noise for the value-of-information check

  // The 1,000 exported futures are a thinned sample of the 4,000-draw forecast. Map them, year by year and keeping their
  // order, so that their P10 / P50 / P90 equal the published fan exactly: switching on a tiny theme then moves nothing.
  const DRAWS = (() => {
    const out = T.draws.map(r => r.slice()), one = new Array(ND).fill(1), fan = F.fan.ensemble;
    for (let i = 0; i < F.years.length; i++) {
      const col = T.draws.map(r => r[i]), q = wq(col, one, [0.1, 0.5, 0.9]), f = [fan.p10[i], fan.p50[i], fan.p90[i]];
      for (let d = 0; d < ND; d++) {
        const v = col[d];
        out[d][i] = v <= q[1] ? f[1] + (v - q[1]) * (q[1] > q[0] ? (f[1] - f[0]) / (q[1] - q[0]) : 1)
                              : f[1] + (v - q[1]) * (q[2] > q[1] ? (f[2] - f[1]) / (q[2] - q[1]) : 1);
      }
    }
    return out;
  })();
  function wq(vals, w, qs) {
    const idx = Array.from(vals.keys()).sort((a, b) => vals[a] - vals[b]);
    let tot = 0; for (let i = 0; i < w.length; i++) tot += w[i];
    const out = [];
    let acc = 0, k = 0;
    for (const q of qs) {
      while (k < idx.length - 1 && acc + w[idx[k]] < q * tot) { acc += w[idx[k]]; k++; }
      out.push(vals[idx[k]]);
    }
    return out;
  }

  // ---- adoption curves ----
  const logistic = (y, mid) => 1 / (1 + Math.exp(-T.steepness * (y - mid)));
  const adoption = (y, mid) => (logistic(y, mid) - logistic(B, mid)) / (logistic(TY, mid) - logistic(B, mid));
  const midOf = (c, timing, shift) => c.midpoint + T.timing[timing] + (shift || 0);

  function driverPath(c, value, timing, sm, ms) {
    const mid = midOf(c, timing, ms), k = sm == null ? 1 : sm;
    return YRS.map(y => Math.min(c.range[1], c.today + (value - c.today) * k * adoption(y, mid)));   // a share cannot pass 100%
  }
  /** Net wedge, TWh generated. Conversions are at 2047 scale; shares of the economy scale with the baseline path. */
  function wedgePath(c, value, timing, baseline, sm, ms) {
    if (c.negative) { const mid = midOf(c, timing, ms), k = sm == null ? 1 : sm; return YRS.map((y, i) => -baseline[i] * value / 100 * k * adoption(y, mid)); }
    const end = baseline[LAST];
    return driverPath(c, value, timing, sm, ms).map((d, i) => (d - c.today) * c.conversion * (1 - c.in_baseline) * (c.scales_with_economy ? baseline[i] / end : 1));
  }

  /** Default theme state: every card off, at its default setting and central timing. */
  function initial() {
    const o = {};
    CARDS.forEach(c => { o[c.id] = { on: false, value: c.default, timing: "central" }; });
    return o;
  }
  const wedgeCards = th => CARDS.filter(c => th[c.id] && th[c.id].on && c.conversion !== undefined);
  const gasOn = th => !!(th.oilgas && th.oilgas.on);
  /** GDP boost from an oil and gas find, as extra percentage points of growth in a window of years. */
  function boost(th) {
    if (!gasOn(th)) return null;
    const c = BY.oilgas;
    return { pts: c.gdp_boost_pts[th.oilgas.value], years: c.gdp_boost_years };
  }
  const anyOn = th => CARDS.some(c => th[c.id] && th[c.id].on);

  /** Ratio applied to every simulated baseline future: custom growth / urbanisation / population, plus any GDP boost. */
  function baselineRatio(S) {
    const b = boost(S.themes);
    if (S.need !== "custom" && !b) return YRS.map(() => 1);
    const baseDrivers = { g0: F.scenarios.Base[0], g1: F.scenarios.Base[1], urban: F.urban[LAST], pop: 0 };
    const ref = M.scenario(Object.assign({}, S, baseDrivers, { boost: null }));
    const use = M.scenario(Object.assign({}, S, S.need === "custom" ? {} : baseDrivers, { boost: b }));
    return use.ensemble.map((v, i) => v / ref.ensemble[i]);
  }

  /** Central wedges for a baseline path (each card at its setting, central size). */
  function wedges(S, baseline) {
    const by = {}, total = YRS.map(() => 0);
    wedgeCards(S.themes).forEach(c => {
      const t = S.themes[c.id], w = wedgePath(c, t.value, t.timing, baseline);
      by[c.id] = w; w.forEach((v, i) => { total[i] += v; });
    });
    return { by, total };
  }

  const wquantiles = wq;
  const essOf = w => { let s = 0, s2 = 0; for (const v of w) { s += v; s2 += v * v; } return s * s / s2; };

  /** Every simulated future with the active themes: total generation, the part the grid must serve, and card drivers. */
  function simulate(S) {
    const ratio = baselineRatio(S), cards = wedgeCards(S.themes);
    const totals = new Array(ND), grid = new Float64Array(ND), ded = new Array(ND), drv = {};
    cards.forEach(c => { drv[c.id] = new Array(ND); });
    for (let d = 0; d < ND; d++) {
      const base = DRAWS[d].map((v, i) => v * ratio[i]), tot = base.slice(), dd = new Float64Array(NY);
      cards.forEach(c => {
        const t = S.themes[c.id], sm = Math.exp(T.size_sd * Z[c.id].size[d]), ms = T.timing_sd * Z[c.id].time[d];
        const w = wedgePath(c, t.value, t.timing, base, sm, ms);
        w.forEach((v, i) => { tot[i] += v; });
        if (c.dedicated) w.forEach((v, i) => { dd[i] += v; });
        if (!c.negative) drv[c.id][d] = driverPath(c, t.value, t.timing, sm, ms);
      });
      totals[d] = tot;
      ded[d] = dd;
      grid[d] = tot[LAST] - dd[LAST];
    }
    return { totals, grid, ded, drv, cards };
  }

  /** Log-likelihood of one observation for every future. National figures may be utility-only (scaled to total). */
  function obsLogLik(sim, sp, out) {
    const yi = sp.year - B;
    if (yi < 1 || yi >= NY || !(sp.value >= 0)) return false;
    if (sp.kind === "national") {
      if (!(sp.value > 0)) return false;
      // Utility figures (CEA) exclude captive plants and the dedicated hydrogen plants: compare like with like.
      const util = sp.basis === "utility", lv = Math.log(sp.value);
      for (let d = 0; d < ND; d++) {
        const m = util ? (sim.totals[d][yi] - sim.ded[d][yi]) * F.utility_share : sim.totals[d][yi];
        const r = (lv - Math.log(m)) / T.obs_sd_national; out[d] -= 0.5 * r * r;
      }
      return true;
    }
    if (!sim.drv[sp.kind]) return false;
    const c = BY[sp.kind], floor = 0.05 * (c.range[1] - c.range[0]);
    for (let d = 0; d < ND; d++) {
      const v = sim.drv[sp.kind][d][yi], r = (sp.value - v) / (T.obs_sd_driver * Math.max(Math.abs(sp.value), Math.abs(v), floor));
      out[d] -= 0.5 * r * r;
    }
    return true;
  }
  const weightsFrom = ll => { let mx = -Infinity; for (const v of ll) if (v > mx) mx = v; return Array.from(ll, v => Math.exp(v - mx)); };

  /**
   * Simulated futures with the active themes, before and after the signposts.
   * Each future = a baseline simulation (scaled for custom drivers / GDP boost) + every active card at a
   * randomly drawn size (log-normal) and timing (normal), so the cards carry their own uncertainty.
   */
  function distribution(S) {
    const sim = simulate(S);
    const ll = new Float64Array(ND), used = (S.signposts || []).filter(sp => obsLogLik(sim, sp, ll));
    const w = weightsFrom(ll), one = w.map(() => 1), ess = essOf(w);
    const band = ww => {
      const o = { p10: [], p50: [], p90: [] };
      for (let i = 0; i < NY; i++) { const q = wquantiles(sim.totals.map(t => t[i]), ww, [0.1, 0.5, 0.9]); o.p10.push(q[0]); o.p50.push(q[1]); o.p90.push(q[2]); }
      return o;
    };
    const prior = band(one), post = used.length ? band(w) : prior;
    const gq = ww => { const q = wquantiles(Array.from(sim.grid), ww, [0.1, 0.5, 0.9]); return { p10: q[0], p50: q[1], p90: q[2] }; };
    const gridPrior = gq(one), gridPost = used.length ? gq(w) : gridPrior;
    const cardSummary = {};
    sim.cards.filter(c => !c.negative).forEach(c => {
      const end = sim.drv[c.id].map(p => p[LAST]);
      const q0 = wquantiles(end, one, [0.1, 0.5, 0.9]), q1 = used.length ? wquantiles(end, w, [0.1, 0.5, 0.9]) : q0;
      cardSummary[c.id] = { prior: q0, post: q1 };
    });
    return { prior, post, gridPrior, gridPost, ess, n: ND, used, cardSummary, sim, weights: w };
  }

  /**
   * Which signpost to watch: for each candidate observation, pretend each of a sample of futures is the truth,
   * observe it with noise, and measure how much the 2047 P10-P90 range shrinks on average (preposterior analysis).
   */
  function valueOfInformation(S, dist, candidates) {
    const sim = dist.sim, base = dist.weights, end = sim.totals.map(t => t[LAST]);
    const w0 = wquantiles(end, base, [0.1, 0.9]), width0 = w0[1] - w0[0];
    // truths drawn in proportion to the current (posterior) weights: systematic resampling
    let tot = 0; for (const v of base) tot += v;
    const truths = [];
    let acc = 0, k = 0;
    for (let j = 0; j < VOI_TRIALS; j++) {
      const u = (j + 0.5) / VOI_TRIALS * tot;
      while (k < ND - 1 && acc + base[k] < u) { acc += base[k]; k++; }
      truths.push(k);
    }
    return candidates.map(cand => {
      const yi = cand.year - B;
      let shrink = 0;
      truths.forEach((t, j) => {
        const truth = cand.kind === "national" ? sim.totals[t][yi] * Math.exp(T.obs_sd_national * NOISE[j])
          : Math.max(0, sim.drv[cand.kind][t][yi] * (1 + T.obs_sd_driver * NOISE[j]));
        const ll = new Float64Array(ND);
        obsLogLik(sim, { kind: cand.kind, year: cand.year, value: truth }, ll);
        const w = weightsFrom(ll).map((v, i) => (i === t ? 0 : v * base[i]));      // the truth is not evidence about itself
        const q = wquantiles(end, w, [0.1, 0.9]);
        shrink += 1 - (q[1] - q[0]) / width0;
      });
      return Object.assign({}, cand, { shrink: shrink / truths.length });
    }).sort((a, b) => b.shrink - a.shrink);
  }

  /** Where each card's 2047 wedge lands, by zone (TWh). Cards without a state list follow the requirement split. */
  function zoneSplit(S, wedge47) {
    const R = D.regions, last = M.YEARS5.length - 1, out = {};
    wedgeCards(S.themes).forEach(c => {
      const z = Object.fromEntries(M.ZONES.map(k => [k, 0]));
      if (c.states && typeof c.states === "object") Object.keys(c.states).forEach(st => { z[R.state[st].zone] += c.states[st]; });
      else M.ZONES.forEach(k => { z[k] = R.zone_need_share[k][last]; });
      const tot = Object.values(z).reduce((a, v) => a + v, 0);
      out[c.id] = Object.fromEntries(M.ZONES.map(k => [k, wedge47[c.id] * z[k] / tot]));
    });
    return out;
  }

  window.THEMES = { CARDS, BY, initial, anyOn, gasOn, boost, wedges, wedgePath, driverPath, adoption, distribution, valueOfInformation,
                    zoneSplit, baselineRatio, ND };
})();
