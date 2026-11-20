/* India 2047 dashboard: state, controls and the five tabs. */
(function () {
  "use strict";
  const { el, sv, f0, f1, f2, pct, signed, ticks, Tip, hoverable, legend, frame, yAxis, stackedBars, lineChart, table } = window.UI;
  const D = window.DATA, F = D.forecast, O = D.optimiser, R = D.regions, M = window.MODEL, TH = window.THEMES, TD = D.themes;
  const { YEARS5, MS, ZONES, STATES, SRC } = M;
  const SI = Object.fromEntries(SRC.map((s, i) => [s, i]));
  const COL = { Coal: "var(--s-coal)", Hydro: "var(--s-hydro)", Gas: "var(--s-gas)", Wind: "var(--s-wind)", Solar: "var(--s-solar)", Nuclear: "var(--s-nuclear)", Other: "var(--s-other)" };
  const STACK = ["Coal", "Hydro", "Gas", "Wind", "Solar", "Nuclear"];          // bottom to top
  const OTHER = "Bioenergy & other";
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const LAST = F.years.length - 1, Y47 = YEARS5.length - 1;
  const LENS = {
    india: { label: "India's own history", short: "India's history", color: "var(--l-india)",
             text: `Generation per person against income, 1990–2025, with autocorrelated errors. Elasticity ${f2(F.india_lens.elasticity)}.` },
    ladder: { label: "Development ladder", short: "Ladder", color: "var(--l-ladder)",
              text: `What ${F.ladder_lens.n_countries} other growing economies did at each income level. Growth slows as countries get richer.` },
    panel: { label: "Global panel + urbanisation", short: "Panel", color: "var(--l-panel)",
             text: `${F.panel_lens.n_countries} countries with their own baselines: income, income squared and urban share. The only lens that reads urbanisation directly.` },
  };
  const STRATEGY = { 0: "Least cost", 2000: "Balanced", 4000: "Stronger carbon signal", 6000: "Deep decarbonisation" };
  const NEED = { p10: "Low need (P10)", p50: "Central need (P50)", p90: "High need (P90)", custom: "Your scenario" };
  const NEED_LC = { p10: "low requirement (P10)", p50: "central requirement (P50)", p90: "high requirement (P90)", custom: "your scenario" };
  const STRATEGY_SHORT = { 0: "Least cost", 2000: "Balanced", 4000: "Stronger signal", 6000: "Deep decarb." };
  const BUILD_LABEL = { Coal_new: "New coal", Gas: "Gas", Hydro: "Hydro", Nuclear: "Nuclear", Solar: "Solar", Wind: "Wind" };
  const DEFAULTS = { need: "p50", carbon: 2000, land: 3, wind: 1, coal: 1, pace: 0, g0: F.scenarios.Base[0], g1: F.scenarios.Base[1],
                     urban: Math.round(F.urban[LAST] * 2) / 2, pop: 0 };
  const S = Object.assign({ tab: "forecast", monthYear: 2047, mapMetric: "net", mapLevel: "zone", sel: { level: "zone", name: "West" }, views: {},
                            themes: TH.initial(), signposts: [], spDraft: { kind: "national", year: 2030, value: "" } }, DEFAULTS);
  let plan = null, scen = null, themed = null;

  // ---- deferred chart drawing (hosts need to be in the document to be measured) ----
  const pending = [];
  const chartHost = (draw, cls) => { const h = el("div", { class: "chart" + (cls ? " " + cls : "") }); pending.push(() => draw(h)); return h; };
  const flush = () => { while (pending.length) pending.shift()(); };

  function card(o) {
    const body = el("div", null, o.body);
    const head = el("div", { class: "card-head" }, el("div", null, el("h2", { text: o.title }), o.sub ? el("p", { class: "sub", text: o.sub }) : null));
    const c = el("section", { class: "card" + (o.cls ? " " + o.cls : "") }, head, body);
    if (o.table) {
      const tb = el("div", { style: { display: "none" } });
      const bC = el("button", { type: "button", text: "Chart" }), bT = el("button", { type: "button", text: "Table" });
      const set = (t, redraw) => {
        S.views[o.title] = t;
        body.style.display = t ? "none" : ""; tb.style.display = t ? "" : "none";
        bC.setAttribute("aria-pressed", String(!t)); bT.setAttribute("aria-pressed", String(t));
        if (t && !tb.firstChild) tb.appendChild(o.table());
        if (!t && redraw) renderTab();
      };
      bC.addEventListener("click", () => set(false, true));
      bT.addEventListener("click", () => set(true));
      head.appendChild(el("div", { class: "mini-toggle", role: "group", "aria-label": "View as" }, bC, bT));
      c.appendChild(tb);
      set(!!S.views[o.title]);
    }
    if (o.foot) c.appendChild(el("p", { class: "foot", text: o.foot }));
    return c;
  }

  const sourceSeries = (rows, fixed) => STACK.map(s => ({ label: s, color: COL[s], values: rows.map(r => r[SI[s]]) }))
    .concat([{ label: OTHER, color: COL.Other, values: rows.map((_, i) => Array.isArray(fixed) ? fixed[i] : fixed) }]);
  const sourceLegend = extra => legend(STACK.map(s => ({ label: s, color: COL[s] })).concat([{ label: OTHER, color: COL.Other }]).concat(extra || []));
  const needTotal2047 = () => themed.full != null ? themed.full : S.need === "custom" ? scen.ensemble[LAST] : F.fan.ensemble[S.need][LAST];
  const gasFlag = () => (TH.gasOn(S.themes) ? 1 : 0);
  /** Optimiser plan for the current settings with some controls overridden (themes and signposts included). */
  const planWith = over => M.getPlan(Object.assign({}, S, { gas: gasFlag() }, over), themed.target);
  const icon = ok => sv("svg", { width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true" }, ok
    ? sv("path", { d: "M2.5 7.4l3 3 6-6.3", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" })
    : sv("path", { d: "M7 1.5l6 10.8H1L7 1.5zM7 5.6v3.2M7 10.4v.2", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));

  // =====================================================================================
  // Controls
  // =====================================================================================
  const refreshers = [];
  function seg(label, options, get, set) {
    const buttons = options.map(o => {
      const b = el("button", { type: "button" }, o.label, o.small ? el("small", { text: o.small }) : null);
      b.addEventListener("click", () => { set(o.v); update(); });
      return b;
    });
    refreshers.push(() => buttons.forEach((b, i) => b.setAttribute("aria-pressed", String(get() === options[i].v))));
    return el("div", { class: "ctl" }, el("span", { class: "lab", text: label }), el("div", { class: "seg", role: "group", "aria-label": label }, buttons));
  }
  let raf = 0;
  function slider(label, key, min, max, step, fmt) {
    const val = el("b"), input = el("input", { type: "range", min, max, step, "aria-label": label });
    input.addEventListener("input", () => {
      S[key] = +input.value; S.need = "custom";
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; update(); });
    });
    refreshers.push(() => { input.value = S[key]; val.textContent = fmt(S[key]); });
    return el("div", { class: "slider" }, el("label", null, el("span", { text: label }), val), input);
  }
  function buildControls() {
    const host = document.getElementById("controls");
    const customFoot = el("span");
    const preset = (name, g) => { const b = el("button", { class: "ghost", type: "button", text: name });
      b.addEventListener("click", () => { S.g0 = g[0]; S.g1 = g[1]; S.need = "custom"; update(); }); return b; };
    const customBox = el("div", { class: "custom" },
      el("div", { class: "sliders" },
        slider("GDP growth in 2026", "g0", 3, 10, 0.1, v => f1(v) + "% a year"),
        slider("GDP growth in 2047", "g1", 2, 9, 0.1, v => f1(v) + "% a year"),
        slider("Urban share in 2047", "urban", 36, 60, 0.5, v => f1(v) + "%"),
        slider("Population in 2047 vs projection", "pop", -8, 8, 0.5, v => (v > 0 ? "+" : "") + f1(v) + "%")),
      el("div", { class: "custom-foot" }, el("span", { text: "Presets:" }),
        Object.keys(F.scenarios).map(k => preset(k, F.scenarios[k])), customFoot));
    refreshers.push(() => {
      customBox.classList.toggle("open", S.need === "custom");
      if (S.need !== "custom") return;
      const i = plan.info;
      customFoot.textContent = `Income reaches $${f0(scen.gdpPc[LAST])} per person in 2047 (PPP). The generation mix is interpolated between optimiser runs solved at ${f0(i.between[0])} and ${f0(i.between[1])} TWh.`;
    });
    const themeBtn = el("button", { class: "ghost", type: "button" });
    themeBtn.addEventListener("click", () => { S.tab = "themes"; renderTabs(); renderTab(); });
    refreshers.push(() => {
      const n = TH.CARDS.filter(c => S.themes[c.id].on).length, k = S.signposts.length;
      themeBtn.textContent = (n ? `${n} theme${n > 1 ? "s" : ""} on` : "No themes") + (k ? ` · ${k} signpost${k > 1 ? "s" : ""}` : "") + " · edit";
    });
    const reset = el("button", { class: "ghost", type: "button", text: "Reset" });
    reset.addEventListener("click", () => { Object.assign(S, DEFAULTS, { themes: TH.initial(), signposts: [] }); update(); });
    host.appendChild(el("div", { class: "controls-row" },
      seg("2047 requirement", [{ v: "p10", label: "Low", small: "P10" }, { v: "p50", label: "Central", small: "P50" }, { v: "p90", label: "High", small: "P90" }, { v: "custom", label: "Custom…" }],
        () => S.need, v => { S.need = v; }),
      seg("Strategy (carbon price, ₹ per tonne CO₂)", O.axes.carbon.map(c => ({ v: c, label: c === 4000 ? "₹4,000" : STRATEGY[c], small: c === 4000 ? "" : "₹" + f0(c) })),
        () => S.carbon, v => { S.carbon = v; }),
      seg("Open land usable for solar", O.axes.solar_land_pct.map(v => ({ v, label: v + "%" })), () => S.land, v => { S.land = v; }),
      seg("Wind ceiling", [{ v: 1, label: "As measured" }, { v: 2, label: "Doubled" }], () => S.wind, v => { S.wind = v; }),
      seg("New coal plants", [{ v: 1, label: "Allowed" }, { v: 0, label: "None" }], () => S.coal, v => { S.coal = v; }),
      seg("Clean build pace", [{ v: 0, label: "As demonstrated" }, { v: 1, label: "Faster" }], () => S.pace, v => { S.pace = v; }),
      el("div", { class: "ctl" }, el("span", { class: "lab", text: "Themes and signposts" }), themeBtn),
      el("div", { class: "ctl" }, el("span", { class: "lab", text: " " }), reset)));
    host.appendChild(customBox);
  }

  // =====================================================================================
  // KPI tiles
  // =====================================================================================
  function renderKpis() {
    const host = document.getElementById("kpis"), s47 = plan.summary[Y47], s25 = plan.summary[0];
    const need = needTotal2047(), coal0 = plan.nat[0][SI.Coal], coal1 = plan.nat[Y47][SI.Coal];
    const worst = plan.summary.reduce((a, s, i) => (s.uns > a.uns ? { uns: s.uns, year: YEARS5[i] } : a), { uns: 0, year: null });
    const tile = (label, value, unit, sub) => el("div", { class: "kpi" }, el("div", { class: "k-label", text: label }),
      el("div", { class: "k-value" }, value, unit ? el("small", { text: unit }) : null), el("div", { class: "k-sub", text: sub }));
    host.textContent = "";
    host.appendChild(tile("2047 requirement", f0(need), "TWh", themed.full != null
      ? `${S.signposts.length ? "after signposts" : "with themes"} · range ${f0(themed.band.p10[LAST])}–${f0(themed.band.p90[LAST])}`
      : S.need === "custom"
      ? `your scenario · ${f1(need / F.base_twh)}× 2025`
      : `${f1(need / F.base_twh)}× 2025 · range ${f0(F.fan.ensemble.p10[LAST])}–${f0(F.fan.ensemble.p90[LAST])}`));
    const ded = themed.dedicated > 0.5 ? themed.dedicated : 0;
    host.appendChild(tile("Clean share 2047", pct(s47.clean), "", ded ? `${pct((s47.clean * s47.gen + ded) / (s47.gen + ded))} with hydrogen plants · ${pct(s25.clean)} in 2025` : `${pct(s25.clean)} in 2025`));
    host.appendChild(tile("Coal 2047", f0(coal1), "TWh", `${f0(coal0)} in 2025 (${coal1 >= coal0 ? "+" : "−"}${pct(Math.abs(coal1 / coal0 - 1))})`));
    host.appendChild(tile("Emissions 2047", f0(s47.em), "Mt CO₂", `${f0(s25.em)} in 2025 · ${f0(s47.intensity)} g/kWh`));
    const ok = worst.uns < 0.5;
    host.appendChild(tile("Average cost 2047", "₹" + f2(s47.cost), "/kWh", ok ? "generation + storage + transfer" : "excludes the cost of unmet need"));
    host.appendChild(el("div", { class: "kpi" }, el("div", { class: "k-label", text: "Supply adequacy" }),
      el("div", { class: "k-value k-status" }, el("span", { class: "status " + (ok ? "good" : "critical") }, icon(ok), ok ? "Every month met" : `Short ${f0(plan.summary[Y47].uns)} TWh`)),
      el("div", { class: "k-sub", text: ok ? `storage shifts ${f0(s47.shift)} TWh a year by 2047` : `unmet need in 2047; first shortfall ${plan.summary.findIndex(s => s.uns >= 0.5) >= 0 ? YEARS5[plan.summary.findIndex(s => s.uns >= 0.5)] : ""}` })));

    const notes = document.getElementById("notes");
    notes.textContent = "";
    if (plan.info.clamped) notes.appendChild(el("p", { class: "note warn",
      text: `This requirement is ${f0(plan.info.custom2047)} TWh in 2047, outside the range the optimiser was solved for (${f0(O.axes.need_family_twh[0])}–${f0(O.axes.need_family_twh[O.axes.need_family_twh.length - 1])} TWh). The generation mix shown is for ${f0(plan.info.used2047)} TWh.` }));
    if (themed.sp) { const d = themed.dist; notes.appendChild(el("p", { class: "note",
      text: `Signposts moved the 2047 ${QLABEL[themed.q]} from ${f0(d.prior[themed.q][LAST])} to ${f0(d.post[themed.q][LAST])} TWh and the P10–P90 range from ${f0(d.prior.p10[LAST])}–${f0(d.prior.p90[LAST])} to ${f0(d.post.p10[LAST])}–${f0(d.post.p90[LAST])} TWh.` })); }
    if (themed.dedicated > 0.5) notes.appendChild(el("p", { class: "note",
      text: `The requirement includes about ${f0(themed.dedicated)} TWh generated by dedicated solar and wind for green hydrogen. The supply plan and these tiles cover the grid; see Themes and signposts.` }));
    if (!ok) notes.appendChild(el("p", { class: "note warn",
      text: "With these settings the plan cannot meet every month: build pace and resource ceilings leave a winter shortfall. Allow new coal, raise the land share, or lower the requirement." }));
  }

  // =====================================================================================
  // Tab 1 - Forecast
  // =====================================================================================
  function tabForecast() {
    const X = [];
    for (let yr = F.history.years[0]; yr <= D.target_year; yr++) X.push(yr);
    const pad = (arr, start) => X.map(yr => { const i = yr - start; return i >= 0 && i < arr.length ? arr[i] : null; });
    const fan = F.fan, med = fan.ensemble.p50;

    const drawFan = host => {
      const series = [{ label: "Actual generation", color: "var(--ink2)", values: pad(F.history.total, F.history.years[0]), width: 2 }];
      Object.keys(LENS).forEach(k => series.push({ label: LENS[k].label, endText: LENS[k].short, color: LENS[k].color, values: pad(fan[k].p50, D.base_year), width: 1.5, end: true }));
      series.push({ label: "Forecast median (P50)", endText: "Median", color: "var(--ink)", values: pad(med, D.base_year), width: 2.6, end: true });
      if (scen) series.push({ label: "Your scenario", endText: "Your scenario", color: "var(--l-custom)", dash: true, values: pad(scen.ensemble, D.base_year), width: 2.6, end: true });
      const markers = MS.slice(0, -1).map(y => ({ x: y, y: med[y - D.base_year], text: f0(med[y - D.base_year]), dy: 17 }));
      if (S.need === "p10" || S.need === "p90") markers.push({ x: D.target_year, y: fan.ensemble[S.need][LAST], hollow: true,
        text: `${S.need.toUpperCase()} ${f0(fan.ensemble[S.need][LAST])}`, anchor: "end", dx: -8, dy: S.need === "p90" ? -8 : 15 });
      lineChart(host, { x: X, series, height: 380, unit: "TWh a year", endWidth: 132, markers,
        band: { lo: pad(fan.ensemble.p10, D.base_year), hi: pad(fan.ensemble.p90, D.base_year), label: "P10–P90" },
        xTicks: [1990, 2000, 2010, 2020, 2030, 2040, 2047], vline: { x: D.base_year, label: "forecast" } });
    };
    const fanTable = () => table(["Year", "P10", "Median", "P90"].concat(Object.keys(LENS).map(k => LENS[k].short)).concat(scen ? ["Your scenario"] : []),
      F.years.filter(y => y === D.base_year || MS.indexOf(y) >= 0 || y % 5 === 0).map(y => {
        const i = y - D.base_year;
        return [y, f0(fan.ensemble.p10[i]), f0(med[i]), f0(fan.ensemble.p90[i])].concat(Object.keys(LENS).map(k => f0(fan[k].p50[i]))).concat(scen ? [f0(scen.ensemble[i])] : []);
      }));
    const fanLegend = legend([{ label: "Actual generation", color: "var(--ink2)", kind: "line" }, { label: "Forecast median", color: "var(--ink)", kind: "line" },
      { label: "P10–P90 range", kind: "band" }].concat(Object.keys(LENS).map(k => ({ label: LENS[k].label, color: LENS[k].color, kind: "line" })))
      .concat(scen ? [{ label: "Your scenario", color: "var(--l-custom)", kind: "dash" }] : []));

    const lensCard = card({
      title: "Three independent lenses", sub: "Each one predicts generation per person from income; they disagree, and the spread is the honest uncertainty.",
      body: Object.keys(LENS).map(k => el("div", { class: "lens", style: { borderColor: LENS[k].color } },
        el("div", { class: "l-name", text: LENS[k].label }),
        el("div", { class: "l-num" }, f0(fan[k].p50[LAST]) + " TWh ", el("small", { text: `in 2047 · weight ${pct(F.lens.weights[k])}` + (scen ? ` · your scenario ${f0(scen[k][LAST])}` : "") })),
        el("p", { text: LENS[k].text }))),
      foot: `Weights are the inverse of each lens's hindcast error, capped at 50%. Median drivers in 2047: ${f2(F.drivers_2047_median.population / 1e9)} bn people, ${f0(F.drivers_2047_median.urban_share_pct)}% urban, $${f0(F.drivers_2047_median.gdp_pc_ppp)} income per person (PPP).`,
    });

    // hindcast small multiples
    const origins = Object.keys(F.hindcast.years).map(Number).sort();
    const hind = el("div", { class: "grid g-3" }, origins.map(o => {
      const yrs = F.hindcast.years[o], actual = yrs.map(y => F.hindcast.actual[y]), p = F.hindcast.pred[o], n = yrs.length - 1;
      const err = Object.keys(LENS).map(k => `${LENS[k].short} ${(p[k][n] / actual[n] - 1) >= 0 ? "+" : "−"}${pct(Math.abs(p[k][n] / actual[n] - 1))}`).join(" · ");
      return el("div", null, el("p", { class: "sub", style: { fontWeight: 600, color: "var(--ink)" }, text: `Forecast made with data to ${o}` }),
        chartHost(h => lineChart(h, { x: yrs, height: 190, unit: "TWh", xTicks: [o, 2015, 2025].filter((v, i, a) => a.indexOf(v) === i && v >= o),
          series: [{ label: "Trend only (benchmark)", color: "var(--muted)", values: p.trend_benchmark, dash: true, width: 1.5 }]
            .concat(Object.keys(LENS).map(k => ({ label: LENS[k].label, color: LENS[k].color, values: p[k], width: 1.8 })))
            .concat([{ label: "Actual", color: "var(--ink)", values: actual, width: 2.4 }]) })),
        el("p", { class: "foot", text: `Error in 2025: ${err}` }));
    }));

    const root = el("div", { class: "stack" },
      el("div", { class: "grid g-73" },
        card({ title: `India needs about ${f0(med[LAST])} TWh of generation in 2047`,
          sub: `${f1(med[LAST] / F.base_twh)} times the ${f0(F.base_twh)} TWh generated in 2025. Total generation including captive plants, calendar years.`,
          body: [fanLegend, chartHost(drawFan)], table: fanTable,
          foot: `Band: 10th to 90th percentile of ${f0(F.assumptions.n_draws)} simulations varying GDP growth, population, urbanisation, model parameters and the choice of lens.` }),
        lensCard),
      card({ title: "Tested against the past: each lens forecasts 2025 from 2005, 2010 and 2015",
        sub: "Fitted only on data available at the time, then given the growth and urbanisation that actually happened.",
        body: [legend([{ label: "Actual", color: "var(--ink)", kind: "line" }].concat(Object.keys(LENS).map(k => ({ label: LENS[k].label, color: LENS[k].color, kind: "line" })))
          .concat([{ label: "Trend only (benchmark)", color: "var(--muted)", kind: "dash" }])), hind] }),
      el("div", { class: "grid g-2" },
        card({ title: "The development ladder: growth in generation slows as income rises",
          sub: "Percentage growth in generation per person for each 1% growth in income, by income level.",
          body: [legend([{ label: "One country", color: "var(--muted)", kind: "dot" }, { label: "Median, with 10–90% range", color: "var(--l-ladder)", kind: "line" }]), chartHost(drawLadder)],
          foot: "Ten-year windows, economies above 5 million people that grew at least 22% in the window; India excluded. Countries outside −0.5 to 2.5 are not drawn." }),
        card({ title: "What moves the 2047 number", sub: "Each lens re-run with one modelling choice changed. Change against that lens's default.", body: sensitivityBody() })));
    return root;
  }

  function bandLabel(b) {
    const m = b.match(/\((\d+), (\d+)\]/), lo = +m[1] / 1000, hi = +m[2] / 1000;
    return hi > 100 ? `$${lo}k+` : `$${lo}–${hi}k`;
  }
  function drawLadder(host) {
    const bands = F.ladder_curve, n = bands.length, fr = frame(host, 280, { t: 16, r: 10, b: 44, l: 46 });
    const yMin = -0.5, yMax = 2.5, y = v => fr.ih - (v - yMin) / (yMax - yMin) * fr.ih, bw = fr.iw / n;
    yAxis(fr, y, [0, 0.5, 1, 1.5, 2, 2.5], f1, "elasticity");
    const hash = s => { let h = 7; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997; return h / 997; };
    const income = [F.gdp_pc_base, scen ? scen.gdpPc[LAST] : F.drivers_2047_median.gdp_pc_ppp];
    const inBand = v => bands.findIndex(b => { const m = b.band.match(/\((\d+), (\d+)\]/); return v > +m[1] && v <= +m[2]; });
    let prev = null;
    bands.forEach((b, i) => {
      const cx = bw * (i + 0.5);
      F.ladder_countries.filter(c => c.band === b.band && c.elasticity >= yMin && c.elasticity <= yMax).forEach(c =>
        fr.g.appendChild(sv("circle", { cx: cx + (hash(c.iso) - 0.5) * bw * 0.6, cy: y(c.elasticity), r: 2.6, style: { fill: "var(--muted)", opacity: 0.45 } })));
      if (prev) fr.g.appendChild(sv("line", { x1: prev[0], y1: prev[1], x2: cx, y2: y(b.elasticity_median), style: { stroke: "var(--l-ladder)", strokeWidth: 2 } }));
      prev = [cx, y(b.elasticity_median)];
    });
    bands.forEach((b, i) => {
      const cx = bw * (i + 0.5);
      fr.g.appendChild(sv("line", { x1: cx, x2: cx, y1: y(Math.min(b.p90, yMax)), y2: y(b.p10), style: { stroke: "var(--l-ladder)", strokeWidth: 2 } }));
      fr.g.appendChild(sv("circle", { cx, cy: y(b.elasticity_median), r: 5, style: { fill: "var(--l-ladder)", stroke: "var(--surface)", strokeWidth: 2 } }));
      fr.g.appendChild(sv("text", { class: "ink b halo", x: cx + 9, y: y(b.elasticity_median) - 7, text: f2(b.elasticity_median) }));
      fr.g.appendChild(sv("text", { class: "ink2", x: cx, y: fr.ih + 16, "text-anchor": "middle", text: bandLabel(b.band) }));
      const tags = [income[0], income[1]].map((v, k) => inBand(v) === i ? (k === 0 ? "India 2025" : "India 2047") : null).filter(Boolean);
      if (tags.length) fr.g.appendChild(sv("text", { class: "ink b", x: cx, y: fr.ih + 32, "text-anchor": "middle", text: "▲ " + tags.join(" / ") }));
      fr.g.appendChild(hoverable(sv("rect", { class: "hit", x: bw * i, y: 0, width: bw, height: fr.ih + 36 }), () => ({
        title: `Income ${bandLabel(b.band)} per person`,
        rows: [{ color: "var(--l-ladder)", label: "Median elasticity", value: f2(b.elasticity_median) }, { label: "10–90% range", value: `${f2(b.p10)} – ${f2(b.p90)}` }, { label: "Countries", value: String(b.n_countries) }] })));
    });
  }
  function sensitivityBody() {
    const out = [];
    Object.keys(LENS).forEach(k => {
      const rows = F.sensitivity.filter(r => r.lens === k), def = rows.find(r => r.vs_default_pct === 0);
      out.push(el("div", { class: "hbar-head" }, el("i", { style: { background: LENS[k].color } }), `${LENS[k].label}: ${f0(def.twh_2047)} TWh by default`));
      rows.filter(r => r !== def).forEach(r => {
        const w = Math.min(Math.abs(r.vs_default_pct), 60) / 60 * 50;
        out.push(el("div", { class: "hbar-row" }, el("span", { class: "name", title: r.choice, text: r.choice }),
          el("div", { class: "hbar-track" }, el("i", { style: { background: LENS[k].color, width: w + "%", left: r.vs_default_pct >= 0 ? "50%" : (50 - w) + "%" } })),
          el("span", { class: "val" }, (r.vs_default_pct >= 0 ? "+" : "−") + f0(Math.abs(r.vs_default_pct)) + "% ", el("small", { text: f0(r.twh_2047) }))));
      });
    });
    const ws = F.weight_sensitivity;
    out.push(el("div", { class: "hbar-head", text: "Weighting rule" }));
    out.push(table(["Rule", "India", "Ladder", "Panel", "2047 median"], Object.keys(ws).map(k =>
      [k.replace(/_/g, " "), pct(ws[k].weights.india), pct(ws[k].weights.ladder), pct(ws[k].weights.panel), f0(ws[k].p50) + " TWh"])));
    out.push(el("p", { class: "foot", text: "The rules are compared on a separate random draw, so the headline rule reads slightly differently from the headline median." }));
    return out;
  }

  // =====================================================================================
  // Themes: requirement = history-based baseline + theme wedges, updated by signposts
  // =====================================================================================
  const QLABEL = { p10: "P10", p50: "median", p90: "P90", custom: "median" };
  const THEME_COL = { oilgas: "var(--s-coal)", datacentres: "var(--s-hydro)", cooling: "var(--s-gas)", ev: "var(--s-wind)", manufacturing: "var(--s-solar)",
                      hydrogen: "var(--s-nuclear)", efficiency: "var(--div-neg)" };
  const THEME_STACK = ["oilgas", "datacentres", "cooling", "ev", "manufacturing", "hydrogen"];     // fixed order, bottom to top

  /** The requirement the rest of the dashboard uses. With themes or signposts it is a quantile of the simulated futures. */
  function computeThemed() {
    const th = S.themes, sp = S.signposts.length > 0, active = TH.anyOn(th) || sp;
    const ratio = TH.baselineRatio(S);
    const basePlain = S.need === "custom" ? M.scenario(Object.assign({}, S, { boost: null })).ensemble : F.fan.ensemble[S.need];
    const base = S.need === "custom" ? scen.ensemble : basePlain.map((v, i) => v * ratio[i]);     // includes any GDP boost
    const wedges = TH.wedges(S, base);
    const dist = TH.distribution(S);
    const q = S.need === "custom" ? "p50" : S.need;
    const band = sp ? dist.post : dist.prior;
    const collapsed = sp && dist.ess < 20;
    const dedicated = wedges.by.hydrogen ? wedges.by.hydrogen[LAST] : 0;
    return { active, sp, dist, q, band, collapsed, basePlain, base, wedges, dedicated,
             path: active ? band[q] : basePlain,
             full: active ? band[q][LAST] : null,
             target: active ? (sp ? dist.gridPost : dist.gridPrior)[q] : null,      // what the grid plan serves (dedicated hydrogen excluded)
             boostTwh: base[LAST] - basePlain[LAST] };
  }

  const TIMING_LABEL = { early: "Early", central: "Central", late: "Late" };
  const fnum = v => Math.abs(v - Math.round(v)) < 1e-9 ? f0(v) : f1(v);
  const unitText = (c, v) => c.unit === "%" ? fnum(Math.round(v * 10) / 10) + "%" : c.unit === "Mt" ? fnum(Math.round(v * 10) / 10) + " Mt" : f0(v) + " TWh";
  const dropStaleSignposts = () => { S.signposts = S.signposts.filter(sp => sp.kind === "national" || (S.themes[sp.kind] && S.themes[sp.kind].on)); };
  function segLocal(label, options, get, set) {
    return el("div", { class: "ctl inline" }, el("span", { class: "lab", text: label }),
      el("div", { class: "seg", role: "group", "aria-label": label }, options.map(o => {
        const b = el("button", { type: "button", "aria-pressed": String(get() === o.v) }, o.label, o.small ? el("small", { text: o.small }) : null);
        b.addEventListener("click", () => { set(o.v); update(); });
        return b;
      })));
  }
  function boostTwhFor(level) {
    const c = TH.BY.oilgas, b = { pts: c.gdp_boost_pts[level], years: c.gdp_boost_years };
    const s0 = S.need === "custom" ? S : Object.assign({}, S, { g0: F.scenarios.Base[0], g1: F.scenarios.Base[1], urban: F.urban[LAST], pop: 0 });
    const a = M.scenario(Object.assign({}, s0, { boost: null })).ensemble[LAST], z = M.scenario(Object.assign({}, s0, { boost: b })).ensemble[LAST];
    return themed.basePlain[LAST] * (z / a - 1);
  }
  function convText(c, t) {
    if (c.levels) return `Adds ${f2(c.gdp_boost_pts[t.value])} points to GDP growth each year from ${c.gdp_boost_years[0]} to ${c.gdp_boost_years[1]}, about ${signed(boostTwhFor(t.value))} TWh of requirement by 2047 through the forecast lenses. It also lets the supply plan use cheap domestic gas.`;
    const net = TH.wedgePath(c, t.value, t.timing, themed.base)[LAST];
    if (c.negative) return `Saves ${fnum(t.value)}% of the requirement by 2047, about ${f0(-net)} TWh.`;
    const gross = (t.value - c.today) * c.conversion;
    return `From ${unitText(c, c.today)} in ${c.today_year} to ${unitText(c, t.value)} in 2047: ${f0(gross)} TWh of generation.` +
      (c.in_baseline ? ` ${pct(c.in_baseline)} of that is already in the baseline, so the card adds ${f0(net)} TWh.` : "");
  }
  function themeCard(c) {
    const t = S.themes[c.id];
    const cb = el("input", { type: "checkbox" });
    cb.checked = t.on;
    cb.addEventListener("change", () => { t.on = cb.checked; dropStaleSignposts(); update(); });
    let delta = "off";
    if (t.on) delta = c.levels ? signed(themed.boostTwh) + " TWh" : signed(themed.wedges.by[c.id][LAST]) + " TWh";
    const kids = [el("label", { class: "t-head" }, cb, el("i", { class: "t-key", style: { background: THEME_COL[c.id] } }),
      el("span", { class: "t-name", text: c.name }), el("span", { class: "t-delta", text: delta })),
      el("p", { class: "t-story", text: c.story })];
    if (c.levels) {
      kids.push(segLocal(c.driver, c.levels.map(v => ({ v, label: v })), () => t.value, v => { t.value = v; t.on = true; }));
    } else {
      const val = el("b", { text: unitText(c, t.value) });
      const input = el("input", { type: "range", min: c.range[0], max: c.range[1], step: c.step, "aria-label": c.driver + " in 2047" });
      input.value = t.value;
      input.addEventListener("input", () => { val.textContent = unitText(c, +input.value); });
      input.addEventListener("change", () => { t.value = +input.value; t.on = true; update(); });
      kids.push(el("div", { class: "slider" }, el("label", null, el("span", { text: c.driver + " in 2047" }), val), input));
      kids.push(segLocal("Arrives", ["early", "central", "late"].map(k => ({ v: k, label: TIMING_LABEL[k], small: String(c.midpoint + TD.timing[k]) })),
        () => t.timing, v => { t.timing = v; t.on = true; }));
    }
    kids.push(el("p", { class: "t-conv", text: convText(c, t) }));
    const how = [];
    if (c.today_note) how.push(el("li", null, el("b", { text: "Today: " }), c.today_note + "."));
    if (c.conversion_note) how.push(el("li", null, el("b", { text: "Per unit: " }), c.conversion_note + "."));
    how.push(el("li", null, el("b", { text: "Already in the baseline: " }), c.why_baseline));
    if (c.note) how.push(el("li", null, c.note));
    kids.push(el("details", null, el("summary", { text: "Assumptions and published figures for scale" }), el("ul", null, how),
      el("p", { class: "refs-head", text: "Published figures consulted to choose the default scale. Several measure electricity used rather than generated; they are not compared with any result:" }),
      el("ul", null, c.refs.map(r => el("li", null, el("b", { text: r[0] + ": " }), r[1])))));
    return el("div", { class: "theme" + (t.on ? " on" : "") }, kids);
  }

  function themesAddedBody() {
    const ids = THEME_STACK.filter(id => S.themes[id].on);
    const yrs = MS, idx = yrs.map(y => y - D.base_year);
    const series = ids.map(id => ({ label: TH.BY[id].short, color: THEME_COL[id],
      values: idx.map(i => id === "oilgas" ? themed.base[i] - themed.basePlain[i] : Math.max(0, themed.wedges.by[id][i])) }));
    const eff = themed.wedges.by.efficiency;
    const body = [];
    if (!series.length && !eff) return el("p", { class: "note", text: "Switch on a theme to see what it adds, year by year." });
    if (series.length) {
      body.push(legend(series.map(s => ({ label: s.label, color: s.color }))));
      body.push(chartHost(h => stackedBars(h, { cats: yrs.map(String), series, height: 220, unit: "TWh added", totals: true })));
    }
    if (eff) body.push(el("p", { class: "note" }, el("b", { text: "Efficiency drive: " }), `saves ${idx.map((i, k) => `${f0(-eff[i])} in ${yrs[k]}`).join(", ")} TWh.`));
    body.push(el("div", { class: "wf-total" }, el("span", { text: `Baseline 2047, ${NEED_LC[S.need]}` }), el("b", { text: f0(themed.basePlain[LAST]) + " TWh" })));
    body.push(el("div", { class: "wf-total" }, el("span", { text: `Requirement 2047, ${QLABEL[themed.q]} of ${f0(themed.dist.n)} futures${themed.sp ? " after signposts" : ""}` }),
      el("b", { text: f0(themed.full) + " TWh" })));
    if (themed.dedicated > 0.5) body.push(el("div", { class: "wf-total sub" }, el("span", { text: "of which dedicated solar and wind for hydrogen (outside the grid plan)" }),
      el("span", { text: "about " + f0(themed.dedicated) + " TWh" })));
    return body;
  }

  function signpostCard() {
    const d = themed.dist;
    const opts = [{ v: "national", label: "National generation, TWh" }].concat(
      TH.CARDS.filter(c => c.signpost && S.themes[c.id].on).map(c => ({ v: c.id, label: `${c.driver}, ${c.unit}` })));
    if (!opts.some(o => o.v === S.spDraft.kind)) S.spDraft.kind = "national";
    const sel = el("select", { "aria-label": "What was observed" }, opts.map(o => el("option", { value: o.v, text: o.label })));
    sel.value = S.spDraft.kind;
    const basis = el("select", { "aria-label": "Basis of the generation figure" },
      el("option", { value: "total", text: "All generation incl. captive" }), el("option", { value: "utility", text: "Utility only (CEA reports)" }));
    basis.value = S.spDraft.basis || "total";
    const basisWrap = el("label", null, el("span", { text: "Basis" }), basis);
    const yr = el("input", { type: "number", min: 2026, max: 2046, step: 1, value: S.spDraft.year, "aria-label": "Year observed" });
    const val = el("input", { type: "number", min: 0, step: "any", "aria-label": "Value observed" });
    const hint = el("p", { class: "note" });
    const expected = () => {
      const i = Math.round(+yr.value) - D.base_year;
      if (!(i >= 1 && i < F.years.length - 1)) return null;
      if (sel.value === "national") return basis.value === "utility"
        ? (themed.band.p50[i] - (themed.wedges.by.hydrogen ? themed.wedges.by.hydrogen[i] : 0)) * F.utility_share : themed.band.p50[i];
      const c = TH.BY[sel.value], t = S.themes[c.id];
      return TH.driverPath(c, t.value, t.timing)[i];
    };
    const refreshHint = () => {
      basisWrap.style.display = sel.value === "national" ? "" : "none";
      const e = expected();
      val.placeholder = e == null ? "" : "model: " + (sel.value === "national" ? f0(e) : fnum(Math.round(e * 10) / 10));
      hint.textContent = e == null ? "Pick a year from 2026 to 2046." : "";
    };
    sel.addEventListener("change", () => { S.spDraft.kind = sel.value; refreshHint(); });
    basis.addEventListener("change", () => { S.spDraft.basis = basis.value; refreshHint(); });
    yr.addEventListener("input", () => { S.spDraft.year = +yr.value; refreshHint(); });
    refreshHint();
    const addSp = sp => {      // one signpost per indicator and year: a new value replaces the old one
      S.signposts = S.signposts.filter(o => !(o.kind === sp.kind && o.year === sp.year));
      S.signposts.push(sp);
      update();
    };
    const add = el("button", { class: "ghost", type: "button", text: "Add signpost" });
    add.addEventListener("click", () => {
      const v = parseFloat(val.value), y = Math.round(+yr.value);
      if (!(v >= 0) || !(y >= 2026 && y <= 2046)) { hint.textContent = "Enter a year from 2026 to 2046 and the value observed."; return; }
      addSp({ kind: sel.value, year: y, value: v, basis: sel.value === "national" ? basis.value : undefined });
    });
    const exV = Math.round(d.prior.p50[2030 - D.base_year] * 1.05 / 50) * 50;
    const ex = el("button", { class: "ghost", type: "button", text: `Try: generation reaches ${f0(exV)} TWh in 2030` });
    ex.addEventListener("click", () => addSp({ kind: "national", year: 2030, value: exV, basis: "total" }));
    const list = el("ul", { class: "sp-list" }, S.signposts.map((sp, i) => {
      const rm = el("button", { class: "ghost", type: "button", text: "Remove" });
      rm.addEventListener("click", () => { S.signposts.splice(i, 1); update(); });
      const c = TH.BY[sp.kind];
      return el("li", null, el("span", { text: sp.kind === "national"
        ? `${sp.year}: national generation ${f0(sp.value)} TWh${sp.basis === "utility" ? " (utility only)" : ""}`
        : `${sp.year}: ${c.driver.toLowerCase()} ${unitText(c, sp.value)}` }), rm);
    }));
    const res = [];
    if (S.signposts.length) {
      res.push(el("p", { class: "sp-result" }, `2047 median moves from ${f0(d.prior.p50[LAST])} to `, el("b", { text: f0(d.post.p50[LAST]) + " TWh" }),
        `; the P10–P90 range from ${f0(d.prior.p10[LAST])}–${f0(d.prior.p90[LAST])} to ${f0(d.post.p10[LAST])}–${f0(d.post.p90[LAST])} TWh.`));
      res.push(el("p", { class: themed.collapsed ? "note warn" : "note", text: themed.collapsed
        ? `Only about ${f0(d.ess)} of ${f0(d.n)} simulated futures come close to what was observed, too few for a reliable range, so the band is hidden. The observation is outside what the model expected: revisit the theme settings or the basis of the figure.`
        : `About ${f0(d.ess)} of ${f0(d.n)} simulated futures still fit what was observed (effective sample size).` }));
      const rows = Object.keys(d.cardSummary).map(id => { const c = TH.BY[id], cs = d.cardSummary[id];
        return [c.short, unitText(c, cs.prior[1]), unitText(c, cs.post[1]), `${unitText(c, cs.post[0])} – ${unitText(c, cs.post[2])}`]; });
      if (rows.length) res.push(table(["Theme in 2047", "Before", "After", "Range after"], rows));
    } else {
      res.push(el("p", { class: "note", text: "No signposts yet. Add an observation, or try the example." }));
    }
    return card({ title: "Signposts: update the forecast as the future arrives",
      sub: "Enter something observed after 2025, such as national generation in 2030 or the EV share of road vehicle-km in 2032. The model keeps the simulated futures that match it.",
      body: [el("div", { class: "sp-form" },
        el("label", null, el("span", { text: "Observed" }), sel), basisWrap, el("label", null, el("span", { text: "Year" }), yr),
        el("label", null, el("span", { text: "Value" }), val), add), hint,
        el("div", { class: "sp-ex" }, ex), list].concat(res),
      foot: `Each of ${f0(d.n)} simulated futures (baseline uncertainty plus every active theme at a random size and timing) is weighted by how close it comes to the observations: Bayesian importance weighting. A national figure is taken as accurate to ±${pct(TD.obs_sd_national, 1)}, the year-to-year scatter of India's generation around its trend since 1995 plus data revisions; theme drivers to ±${pct(TD.obs_sd_driver)}. A utility-only figure is compared with each future's generation excluding dedicated hydrogen plants, times ${f2(F.utility_share)} (the utility share of the last three years).` });
  }

  function watchCard() {
    const cands = [{ kind: "national", year: 2030, label: "National generation" }, { kind: "national", year: 2035, label: "National generation" }]
      .concat(...TH.CARDS.filter(c => c.signpost && S.themes[c.id].on).map(c => [2030, 2035].map(y => ({ kind: c.id, year: y, label: c.driver }))));
    const ranked = TH.valueOfInformation(S, themed.dist, cands), top = Math.max(0.01, ...ranked.map(r => r.shrink));
    const shown = ranked.filter(r => r.shrink >= 0.01), small = ranked.filter(r => r.shrink < 0.01);
    return card({ title: "Which signpost to watch first",
      sub: "How much each observation would narrow the 2047 range on average, given the themes switched on now. National generation tells you how big the requirement is; a theme's own signpost tells you which world you are in.",
      body: shown.map(r => el("div", { class: "hbar-row" }, el("span", { class: "name", text: `${r.label}, ${r.year}`, title: `${r.label}, ${r.year}` }),
        el("span", { class: "hbar-track solo" }, el("i", { style: { left: "0%", width: Math.max(0, r.shrink) / top * 100 + "%", background: "var(--seq-5)" } })),
        el("span", { class: "val", text: pct(Math.max(0, r.shrink)) + " narrower" }))).concat(small.length ? [el("p", { class: "note",
          text: `Narrows the 2047 range by less than 1%: ${small.map(r => `${r.label.toLowerCase()} (${r.year})`).join("; ")}. These themes are small next to the baseline's own uncertainty, so their signposts mainly confirm which world you are in.` })] : []),
      foot: `For each candidate, ${f0(250)} futures drawn in proportion to the current weights play the role of the truth in turn; the observation is taken from that future with measurement noise, and the narrowing of the 2047 P10–P90 range is averaged (preposterior analysis).` });
  }

  function supplyEffectCard() {
    const base = M.getPlan(Object.assign({}, S, { gas: 0 }), themed.active ? themed.basePlain[LAST] : null), b = base.summary[Y47], t = plan.summary[Y47];
    const nb = base.nat[Y47], nt = plan.nat[Y47];
    const rows = [["Requirement on the grid, TWh", b.need, t.need, 0], ["Solar, TWh", nb[SI.Solar], nt[SI.Solar], 0], ["Wind, TWh", nb[SI.Wind], nt[SI.Wind], 0],
      ["Coal, TWh", nb[SI.Coal], nt[SI.Coal], 0], ["Gas, TWh", nb[SI.Gas], nt[SI.Gas], 0], ["Nuclear, TWh", nb[SI.Nuclear], nt[SI.Nuclear], 0],
      ["Hydro, TWh", nb[SI.Hydro], nt[SI.Hydro], 0], ["Emissions, Mt CO₂", b.em, t.em, 0], ["Average cost, ₹ per kWh", b.cost, t.cost, 2], ["Unmet need, TWh", b.uns, t.uns, 0]];
    const fmt = (v, dgt) => dgt ? f2(v) : f0(v);
    const notes = [];
    const coalUp = nt[SI.Coal] - nb[SI.Coal], cleanUp = (nt[SI.Solar] + nt[SI.Wind]) - (nb[SI.Solar] + nb[SI.Wind]);
    const atCeil = STATES.filter(st => plan.reasons[st].Solar === "at resource ceiling").length;
    const cleanBtn = el("button", { class: "ghost", type: "button", text: "Try 5% land and faster clean build" });
    cleanBtn.addEventListener("click", () => { S.land = 5; S.pace = 1; update(); });
    if (coalUp > 50 && (S.land < 5 || !S.pace)) notes.push(el("div", { class: "clean-cta" }, cleanBtn));
    if (coalUp > 50) notes.push(el("p", { class: "note warn", text: `Coal covers ${pct(coalUp / Math.max(1, t.need - b.need))} of the extra requirement because solar is at its resource ceiling in ${atCeil} states` +
      (cleanUp < 50 ? " and wind is at its ceiling too" : "") + `. ${S.land < 5 ? "Raise the open land usable for solar" : ""}${S.land < 5 && !S.pace ? " and " : ""}${!S.pace ? "switch Clean build pace to Faster" : ""}${S.land < 5 || !S.pace ? " in the top bar to see how much of it clean sources could take." : "Even with 5% land and faster build, the themes outrun clean supply."}` }));
    if (themed.dedicated > 0.5) {
      const perPct = STATES.reduce((a, st) => a + R.state[st].ceiling.Solar, 0) / 3;
      notes.push(el("p", { class: "note" }, el("b", { text: "Hydrogen: " }), `about ${f0(themed.dedicated)} TWh comes from dedicated solar and wind outside this table. As solar alone it would need roughly ${f1(themed.dedicated / perPct)}% more of India's open land, on top of the ${S.land}% the grid plan uses.`));
    }
    notes.push(el("p", { class: "note warn", text: "The supply plan matches the themed 2047 requirement, but between milestones it follows the standard growth path and it keeps the baseline regional split. Where themes concentrate (see the next panel) is not yet reflected in the regional mix." }));
    return card({ title: "What the themes do to the supply plan", sub: `2047, ${STRATEGY[S.carbon]} strategy, with the levers in the top bar.`,
      body: [table(["", "Without themes", "With themes", "Change"], rows.map(r => [r[0], fmt(r[1], r[3]), fmt(r[2], r[3]),
        r[3] ? (r[2] - r[1] >= 0 ? "+" : "−") + f2(Math.abs(r[2] - r[1])) : signed(r[2] - r[1])]), { wrap: [0] })].concat(notes) });
  }

  function zoneEffectCard() {
    const ids = Object.keys(themed.wedges.by);
    if (!ids.length) return card({ title: "Where the themes land", body: el("p", { class: "note", text: "Switch on a theme to see which zones it affects." }) });
    const w47 = Object.fromEntries(ids.map(id => [id, themed.wedges.by[id][LAST]]));
    const zs = TH.zoneSplit(S, w47);
    const rows = ZONES.map(z => {
      const tot = ids.reduce((a, id) => a + zs[id][z], 0), need = R.zone_need_share[z][Y47] * themed.basePlain[LAST];
      return [z].concat(ids.map(id => signed(zs[id][z]))).concat([signed(tot), (tot >= 0 ? "+" : "−") + pct(Math.abs(tot / need))]);
    });
    return card({ title: "Where the themes land", sub: "2047 requirement added by zone, TWh, and the change against each zone's baseline requirement.",
      body: table(["Zone"].concat(ids.map(id => TH.BY[id].short)).concat(["Total", "vs baseline"]), rows),
      foot: "Data centres, hydrogen and manufacturing follow the states listed on each card; vehicles, cooling and efficiency follow each zone's share of the requirement. Hydrogen is served by its own plants near these sites." });
  }

  function themesMethodCard() {
    const g = TD.gas_discovery, gk = Object.keys(g);
    return card({ title: "How themes and signposts work", body: el("div", { class: "prose" }, el("ul", null, [
      ["Baseline.", "The history-based forecast (tab 1): income, population and urbanisation through three lenses. It cannot see new uses of electricity that no peer country had."],
      ["Wedge.", "Each card adds (driver in a year − today's level) × generation per unit of driver × (1 − share already in the baseline). Generation per unit is set at 2047 scale; for shares of the economy (EVs, manufacturing) it shrinks in earlier years in proportion to the baseline."],
      ["Timing.", "Adoption follows an S-curve from 2025 to the 2047 setting. The year on each Arrives button is roughly when the theme is half-way."],
      ["Uncertainty.", `In each of ${f0(TH.ND)} simulated futures a card's size varies by about ±${pct(TD.size_sd)} and its timing by ±${f1(TD.timing_sd)} years. The requirement used everywhere is a quantile of these futures, so it is not exactly the sum of the central wedges.`],
      ["Hydrogen.", "Served by dedicated solar and wind (it is only green if it is), so it adds to India's generation but not to the grid plan."],
      ["Oil and gas.", `India makes almost no electricity from oil, so a find changes the mix more than the requirement. It works through GDP and through cheaper gas in the supply plan: ${gk.map(k => `${k.toLowerCase()} ${g[k][0]} → ${g[k][1]}`).join("; ")}.`],
      ["Rule.", "Every card is set in energy generated. Defaults are our assumptions: hydrogen's 55 kWh per kg is an engineering figure; for vehicles we took the order of magnitude of published full-electrification estimates and added network losses. The user sets each card; no result is compared with consumption data."],
    ].map(r => el("li", null, el("b", { text: r[0] + " " }), r[1])))) });
  }

  function tabThemes() {
    const presets = Object.keys(TD.presets).map(name => {
      const b = el("button", { class: "ghost", type: "button", text: name });
      b.addEventListener("click", () => {
        S.themes = TH.initial();
        const p = TD.presets[name];
        Object.keys(p).forEach(id => Object.assign(S.themes[id], p[id], { on: true }));
        dropStaleSignposts();
        update();
      });
      return b;
    });
    const X = [];
    for (let yr = 2010; yr <= D.target_year; yr++) X.push(yr);
    const pad = (arr, start) => X.map(yr => { const i = yr - start; return i >= 0 && i < arr.length ? arr[i] : null; });
    const d = themed.dist, hasSp = themed.sp, q = themed.q;
    const baseLabel = "Baseline, " + NEED_LC[S.need];
    const qName = QLABEL[q];
    const drawPath = host => {
      const series = [{ label: "Actual generation", color: "var(--ink2)", values: pad(F.history.total, F.history.years[0]), width: 2 },
        { label: baseLabel, endText: "Baseline", color: "var(--muted)", dash: true, values: pad(themed.basePlain, D.base_year), width: 1.6, end: true }];
      if (TH.anyOn(S.themes)) series.push({ label: `With themes, ${qName}`, endText: "With themes", color: "var(--l-custom)", values: pad(d.prior[q], D.base_year), width: 2.4, end: true });
      if (hasSp) series.push({ label: `After signposts, ${qName}`, endText: "After signposts", color: "var(--ink)", values: pad(d.post[q], D.base_year), width: 2.6, end: true });
      const markers = S.signposts.filter(sp => sp.kind === "national").map(sp => {
        const i = sp.year - D.base_year, ded = themed.wedges.by.hydrogen ? themed.wedges.by.hydrogen[i] : 0;
        const v = sp.basis === "utility" ? sp.value / F.utility_share + ded : sp.value;
        return { x: sp.year, y: v, hollow: true, text: f0(v), dy: -10 };
      });
      const bd = hasSp ? d.post : d.prior;
      lineChart(host, { x: X, series, height: 300, unit: "TWh a year", endWidth: 150, markers,
        band: themed.collapsed ? null : { lo: pad(bd.p10, D.base_year), hi: pad(bd.p90, D.base_year), label: hasSp ? "P10–P90 after signposts" : "P10–P90 of simulated futures" },
        xTicks: [2010, 2020, 2030, 2040, 2047], vline: { x: D.base_year, label: "forecast" } });
    };
    const pathLegend = legend([{ label: "Actual generation", color: "var(--ink2)", kind: "line" }, { label: baseLabel, color: "var(--muted)", kind: "dash" }]
      .concat(TH.anyOn(S.themes) ? [{ label: `With themes, ${qName}`, color: "var(--l-custom)", kind: "line" }] : [])
      .concat(hasSp ? [{ label: `After signposts, ${qName}`, color: "var(--ink)", kind: "line" }, { label: "Signpost (shown as all generation)", color: "var(--ink)", kind: "ring" }] : [])
      .concat(themed.collapsed ? [] : [{ label: hasSp ? "P10–P90 after signposts" : "P10–P90 of simulated futures", kind: "band" }]));
    const bd = hasSp ? d.post : d.prior;
    const pathTable = () => table(["Year", "Baseline", "With themes", "P10", "Median", "P90"],
      YEARS5.map(y => { const i = y - D.base_year; return [y, f0(themed.basePlain[i]), f0(d.prior[q][i]), f0(bd.p10[i]), f0(bd.p50[i]), f0(bd.p90[i])]; }));
    const n = TH.CARDS.filter(c => S.themes[c.id].on).length;
    const clear = el("button", { class: "ghost", type: "button", text: "Clear themes" });
    clear.addEventListener("click", () => { S.themes = TH.initial(); dropStaleSignposts(); update(); });
    return el("div", { class: "stack" },
      el("div", { class: "intro" },
        el("p", null, el("b", { text: "The baseline only knows history. " }),
          "Switch on the directions you think India will take; each adds the generation it would need. As the years pass, add signposts (what was actually observed) and the forecast updates itself. The 2047 requirement, the mix, the KPIs and the other tabs all follow these settings."),
        el("div", { class: "local-row" }, el("span", { class: "lab-inline", text: "Start from a world:" }), presets, n ? clear : null)),
      el("div", { class: "grid g-64" },
        card({ title: "Requirement with your themes", sub: `Total generation, TWh a year. The band is the spread of ${f0(d.n)} simulated futures.`,
          body: [chartHost(drawPath), pathLegend], table: pathTable }),
        card({ title: "What the themes add", sub: "Central setting of each theme, TWh of generation added in each milestone year.", body: themesAddedBody() })),
      el("div", { class: "theme-grid" }, TH.CARDS.map(themeCard)),
      el("div", { class: "grid g-2" }, signpostCard(), el("div", { class: "stack" }, watchCard(), supplyEffectCard())),
      el("div", { class: "grid g-2" }, zoneEffectCard(), themesMethodCard()));
  }

  // =====================================================================================
  // Tab 3 - Generation mix
  // =====================================================================================
  function tabMix() {
    const cats = YEARS5.map(String), s = plan.summary, mi = MS.indexOf(S.monthYear), mon = plan.monthly[mi];
    const title = `${STRATEGY[S.carbon]} strategy, ${NEED_LC[S.need]}`;
    const natCard = card({
      title: `Solar grows from ${pct(plan.nat[0][SI.Solar] / plan.total[0])} to ${pct(plan.nat[Y47][SI.Solar] / plan.total[Y47])} of generation; coal falls from ${pct(plan.nat[0][SI.Coal] / plan.total[0])} to ${pct(plan.nat[Y47][SI.Coal] / plan.total[Y47])}`,
      sub: `${title}. Utility generation, TWh a year. 2025 is observed; later years are the optimiser's plan.`,
      body: [sourceLegend([{ label: "Requirement", color: "var(--ink)", kind: "line" }]),
        chartHost(h => stackedBars(h, { cats, series: sourceSeries(plan.nat, M.FIXED_TOTAL), height: 360, overlay: { values: s.map(r => r.need), label: "Requirement" },
          title: i => `${cats[i]} · ${i === 0 ? "observed" : "plan"}`, note: i => `Clean share ${pct(s[i].clean)} · ${f0(s[i].em)} Mt CO₂` }))],
      table: () => table(["Year"].concat(STACK).concat([OTHER, "Total", "Requirement"]), YEARS5.map((y, i) =>
        [y].concat(STACK.map(k => f0(plan.nat[i][SI[k]]))).concat([f0(M.FIXED_TOTAL), f0(plan.total[i]), f0(s[i].need)]))),
      foot: "Generation exceeds the requirement by storage losses and any curtailed solar.",
    });
    const indCard = card({ title: "System indicators", sub: "How the plan performs at each milestone.",
      body: table(["", ...cats], [
        ["Requirement"].concat(s.map(r => f0(r.need))),
        ["Clean share"].concat(s.map(r => pct(r.clean))),
        ["Emissions (Mt CO₂)"].concat(s.map(r => f0(r.em))),
        ["g CO₂ per kWh"].concat(s.map(r => f0(r.intensity))),
        ["Storage shift"].concat(s.map(r => f0(r.shift))),
        ["Solar curtailed"].concat(s.map(r => f0(r.curt))),
        ["Zone transfers"].concat(s.map(r => f0(r.transfer))),
        ["Unmet need"].concat(s.map(r => f0(r.uns))),
        ["Cost (₹/kWh)"].concat(s.map(r => r.cost == null ? "–" : f2(r.cost))),
      ]),
      foot: "TWh a year unless stated. Storage shift is solar moved from day to night. Cost covers generation, storage and inter-zone transfer; the carbon price steers the choice but is not counted as a cost." });

    const peak = mon.reduce((a, r, i) => (r.price > mon[a].price ? i : a), 0);
    const sorted = mon.map(r => r.price).sort((a, b) => a - b), median = (sorted[5] + sorted[6]) / 2;
    const monthCard = card({
      title: `${S.monthYear}: every month has to balance, and ${MONTHS[peak]} is the hardest`,
      sub: "Generation by source in each month against that month's requirement. Solar, wind and hydro follow their observed seasonal shapes.",
      body: [sourceLegend([{ label: "Requirement", color: "var(--ink)", kind: "line" }]),
        chartHost(h => stackedBars(h, { cats: MONTHS, height: 300, totals: false, maxBar: 44,
          series: [{ label: "Coal", color: COL.Coal, values: mon.map(r => r.coal) }, { label: "Hydro", color: COL.Hydro, values: mon.map(r => r.hydro) },
            { label: "Gas", color: COL.Gas, values: mon.map(r => r.gas) }, { label: "Wind", color: COL.Wind, values: mon.map(r => r.wind) },
            { label: "Solar", color: COL.Solar, values: mon.map(r => r.solar) }, { label: "Nuclear", color: COL.Nuclear, values: mon.map(r => r.nuclear) },
            { label: OTHER, color: COL.Other, values: mon.map(r => r.fixed) }],
          overlay: { values: mon.map(r => r.need), label: "Requirement" }, title: i => `${MONTHS[i]} ${S.monthYear}`,
          note: i => `Storage shifts ${f0(mon[i].shift)} TWh from day to night` + (mon[i].curt > 0.5 ? ` · ${f0(mon[i].curt)} TWh curtailed` : "") + (mon[i].uns > 0.5 ? ` · ${f0(mon[i].uns)} TWh unmet` : "") }))],
      table: () => table(["Month", "Requirement", "Coal", "Hydro", "Gas", "Wind", "Solar", "Nuclear", "Storage shift", "Unmet", "Marginal ₹/kWh"],
        mon.map((r, i) => [MONTHS[i], f0(r.need), f0(r.coal), f0(r.hydro), f0(r.gas), f0(r.wind), f0(r.solar), f0(r.nuclear), f0(r.shift), f0(r.uns), f1(r.price)])),
    });
    const priceCard = card({
      title: `One more unit in ${MONTHS[peak]} costs ₹${f1(mon[peak].price)}/kWh; the median month costs ₹${f1(median)}`,
      sub: "Marginal cost of meeting the requirement in each month (the optimiser's shadow price). A spike marks the month that sizes the system.",
      body: chartHost(h => stackedBars(h, { cats: MONTHS, height: 300, unit: "₹/kWh", fmt: f1, shares: false, totalLabel: "Marginal cost", maxBar: 44,
        totals: i => i === peak, series: [{ label: "Marginal cost", color: "var(--ink2)", values: mon.map(r => r.price) }], title: i => `${MONTHS[i]} ${S.monthYear}` })),
    });

    const periods = ["2026–30", "2031–35", "2036–40", "2041–47"];
    const meters = [el("span", { class: "mh" })].concat(periods.map(p => el("span", { class: "mh", text: p })));
    O.build_sources.forEach((k, ki) => {
      meters.push(el("span", { text: BUILD_LABEL[k] }));
      MS.forEach((_, y) => {
        const used = plan.build[y][ki], limit = O.build_limits[y * O.build_sources.length + ki], share = limit > 0 ? Math.min(1, used / limit) : 0;
        meters.push(hoverable(el("div", { class: "meter" }, el("i", { style: { width: share * 100 + "%", background: COL[k === "Coal_new" ? "Coal" : k] } }), el("span", { text: pct(share) })),
          () => ({ title: `${BUILD_LABEL[k]}, ${periods[y]}`, rows: [{ label: "Added", value: f0(used) + " TWh/yr" }, { label: "Allowed by build pace", value: f0(limit) + " TWh/yr" }] })));
      });
    });
    const buildCard = card({ title: "How hard each source is being built", sub: "Share of the allowed build pace used in each period. The pace is India's best demonstrated rate, with solar, wind and nuclear allowed to accelerate.",
      body: el("div", { class: "meter-grid" }, meters) });

    const cmp = O.axes.carbon.map(c => ({ c, p: c === S.carbon ? plan : planWith({ carbon: c }) }));
    const cmpCard = card({ title: "The same requirement under each strategy, 2047", sub: "Only the carbon price changes. TWh unless stated.",
      body: table(["Strategy", "Coal", "Gas", "Nuclear", "Hydro", "Wind", "Solar", "Clean", "Mt CO₂", "₹/kWh", "Unmet"], cmp.map(r => {
        const n = r.p.nat[Y47], q = r.p.summary[Y47];
        return [`${STRATEGY_SHORT[r.c]} · ₹${f0(r.c)}`, f0(n[SI.Coal]), f0(n[SI.Gas]), f0(n[SI.Nuclear]), f0(n[SI.Hydro]), f0(n[SI.Wind]), f0(n[SI.Solar]), pct(q.clean), f0(q.em), f2(q.cost), f0(q.uns)];
      }), { sel: O.axes.carbon.indexOf(S.carbon) }) });

    const yearSeg = el("div", { class: "ctl" }, el("span", { class: "lab", text: "Year for the monthly view" }),
      el("div", { class: "seg", role: "group" }, MS.map(y => { const b = el("button", { type: "button", text: String(y), "aria-pressed": String(S.monthYear === y) });
        b.addEventListener("click", () => { S.monthYear = y; renderTab(); }); return b; })));
    return el("div", { class: "stack" }, el("div", { class: "grid g-64" }, natCard, indCard), el("div", { class: "local-row", style: { marginBottom: 0 } }, yearSeg),
      el("div", { class: "grid g-2" }, monthCard, priceCard), el("div", { class: "grid g-46" }, buildCard, cmpCard));
  }

  // =====================================================================================
  // Tab 4 - Regions
  // =====================================================================================
  const zoneStates = z => STATES.filter(s => R.state[s].zone === z);
  function regionStats(level, name) {
    if (level === "zone") {
      const b = plan.zoneBal[Y47][name], mix = plan.zone[Y47][name];
      return { made: b.made, need: b.need, net: b.net, mix, hasNeed: true, made0: plan.zoneBal[0][name].made, need0: plan.zoneBal[0][name].need };
    }
    const s = plan.state[name];
    return { made: s.made1, need: s.need1, net: s.made1 - s.need1, mix: s.y47, hasNeed: s.hasNeed, made0: s.made0, need0: s.need0 };
  }
  const leadSource = mix => SRC.reduce((a, s, i) => (mix[i] > mix[SI[a]] ? s : a), SRC[0]);
  function role(st) {
    if (!st.hasNeed) return "No requirement estimate";
    const r = st.net / Math.max(st.need, 1e-9);
    return r > 0.1 ? "Exporter" : r < -0.1 ? "Importer" : "Self-sufficient";
  }

  function drawMap(host) {
    const mp = R.map, level = S.mapLevel, metric = S.mapMetric;
    const unitOf = st => level === "zone" ? R.state[st].zone : st;
    const stats = {};
    (level === "zone" ? ZONES : STATES).forEach(n => { stats[n] = regionStats(level, n); });
    const val = n => { const s = stats[n]; return metric === "net" ? (s.hasNeed ? s.net : null) : metric === "gen" ? s.made : metric === "need" ? (s.hasNeed ? s.need : null) : null; };
    const vals = Object.keys(stats).map(val).filter(v => v != null), vmax = Math.max.apply(null, vals.map(Math.abs).concat([1]));
    const color = n => {
      const s = stats[n];
      if (!s) return "var(--wash)";
      if (metric === "lead") return COL[leadSource(s.mix)];
      const v = val(n);
      if (v == null) return "var(--wash)";
      if (metric === "net") {
        const step = Math.abs(v) < vmax * 0.03 ? 0 : Math.ceil(Math.sqrt(Math.abs(v) / vmax) * 3);
        return step === 0 ? "var(--div-mid)" : `color-mix(in oklab, var(${v > 0 ? "--div-pos" : "--div-neg"}) ${[0, 38, 68, 100][step]}%, var(--div-mid))`;
      }
      return `var(--seq-${v <= 0.05 ? 0 : Math.max(1, Math.ceil(Math.sqrt(v / vmax) * 7))})`;
    };
    host.textContent = "";
    const svg = sv("svg", { viewBox: `0 0 ${mp.width} ${mp.height}`, role: "img", "aria-label": "Map of India by state", style: { maxHeight: "560px" } });
    const shapes = [];
    const tipFor = st => () => {
      const n = unitOf(st), s = stats[n];
      if (!s) return { title: st, note: "No generation data" };
      const rows = SRC.map((k, i) => ({ k, v: s.mix[i] })).filter(r => r.v > 0.5).sort((a, b) => b.v - a.v).slice(0, 4).map(r => ({ color: COL[r.k], label: r.k, value: f0(r.v) + " TWh" }));
      rows.push({ label: "Makes in 2047", value: f0(s.made) + " TWh", on: true });
      if (s.hasNeed) { rows.push({ label: "Needs in 2047", value: f0(s.need) + " TWh" }); rows.push({ label: "Net position", value: signed(s.net) + " TWh" }); }
      return { title: level === "zone" ? `${n} zone` : `${st} (${R.state[st] ? R.state[st].zone : ""})`, rows, note: level === "zone" ? `Hovering ${st}` : null };
    };
    const enter = st => () => shapes.forEach(sh => sh.node.classList.toggle("fade", unitOf(sh.st) !== unitOf(st)));
    const leave = () => shapes.forEach(sh => sh.node.classList.remove("fade"));
    Object.keys(mp.states).forEach(st => {
      const g = mp.states[st], known = !!R.state[st];
      const sel = known && S.sel.level === level && unitOf(st) === S.sel.name;
      const mk = node => {
        node.setAttribute("class", "st" + (sel ? " selected" : ""));
        node.style.fill = known ? color(unitOf(st)) : "var(--wash)";
        if (known) {
          hoverable(node, tipFor(st), enter(st), leave);
          node.addEventListener("click", () => { S.sel = { level, name: unitOf(st) }; renderTab(); });
          node.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); S.sel = { level, name: unitOf(st) }; renderTab(); } });
          node.setAttribute("aria-label", st);
        }
        shapes.push({ node, st });
        return node;
      };
      svg.appendChild(mk(sv("path", { d: g.d })));
      if (g.px2 < 8) svg.appendChild(mk(sv("circle", { cx: g.cx, cy: g.cy, r: 3.2 })));
    });
    shapes.filter(s => s.node.classList.contains("selected")).forEach(s => svg.appendChild(s.node));     // selected outline on top
    if (level === "zone") ZONES.forEach(z => {
      let a = 0, cx = 0, cy = 0;
      zoneStates(z).forEach(st => { const g = mp.states[st]; if (g) { a += g.px2; cx += g.cx * g.px2; cy += g.cy * g.px2; } });
      const s = stats[z];
      svg.appendChild(sv("text", { class: "zl", x: cx / a, y: cy / a - 2, "text-anchor": "middle", text: z }));
      svg.appendChild(sv("text", { class: "zv", x: cx / a, y: cy / a + 11, "text-anchor": "middle",
        text: metric === "net" ? signed(s.net) + " TWh" : metric === "gen" ? f0(s.made) + " TWh" : metric === "need" ? f0(s.need) + " TWh" : leadSource(s.mix) }));
    });
    host.appendChild(svg);
    // scale
    const scale = el("div", { class: "scale" });
    if (metric === "lead") scale.appendChild(sourceLegend());
    else if (metric === "net") {
      scale.appendChild(el("span", { text: `Imports ${f0(vmax)} TWh` }));
      scale.appendChild(el("span", { class: "steps" }, [-3, -2, -1, 0, 1, 2, 3].map(k => el("i", { style: { background: k === 0 ? "var(--div-mid)" : `color-mix(in oklab, var(${k > 0 ? "--div-pos" : "--div-neg"}) ${[0, 38, 68, 100][Math.abs(k)]}%, var(--div-mid))` } }))));
      scale.appendChild(el("span", { text: `Exports ${f0(vmax)} TWh` }));
    } else {
      scale.appendChild(el("span", { text: "0" }));
      scale.appendChild(el("span", { class: "steps" }, [1, 2, 3, 4, 5, 6, 7].map(k => el("i", { style: { background: `var(--seq-${k})` } }))));
      scale.appendChild(el("span", { text: `${f0(vmax)} TWh (square-root scale)` }));
    }
    host.appendChild(scale);
  }

  function detailPanel() {
    const { level, name } = S.sel, st = regionStats(level, name), members = level === "zone" ? zoneStates(name) : [name];
    const cats = level === "zone" ? YEARS5.map(String) : [String(D.base_year), String(D.target_year)];
    const rows = level === "zone" ? YEARS5.map((_, i) => plan.zone[i][name]) : [plan.state[name].base, plan.state[name].y47];
    const fixed = level === "zone" ? R.zone_fixed[name] : R.state[name].fixed;
    const needs = level === "zone" ? YEARS5.map((_, i) => plan.zoneBal[i][name].need) : (st.hasNeed ? [st.need0, st.need] : null);
    // local strengths
    const res = ["Solar", "Wind", "Hydro"].map(k => {
      const used = st.mix[SI[k]], ceil = members.reduce((a, m) => a + Math.max(R.state[m].ceiling[k] * plan.ceilingScale[k], plan.state[m].y47[SI[k]]), 0);
      const w = members.reduce((a, m) => a + R.state[m].area_km2, 0);
      const ind = k === "Solar" ? f1(members.reduce((a, m) => a + R.state[m].ghi * R.state[m].area_km2, 0) / w) + " kWh/m² a day"
        : k === "Wind" ? f1(members.reduce((a, m) => a + R.state[m].wind50 * R.state[m].area_km2, 0) / w) + " m/s at 50 m"
        : f0(members.reduce((a, m) => a + R.state[m].precip * R.state[m].area_km2, 0) / w) + " mm rain a year";
      return el("div", { class: "res-row" }, el("span", { text: k }),
        hoverable(el("div", { class: "meter" }, el("i", { style: { width: (ceil > 0 ? Math.min(1, used / ceil) : 0) * 100 + "%", background: COL[k] } })),
          () => ({ title: `${k} in ${name}`, rows: [{ label: "Planned for 2047", value: f0(used) + " TWh" }, { label: "Resource ceiling", value: f0(ceil) + " TWh" }, { label: "Indicator", value: ind }] })),
        el("span", { class: "rv", text: `${f0(used)} of ${f0(ceil)} TWh` }));
    });
    // why
    const why = [];
    SRC.forEach((k, si) => {
      const twh = st.mix[si];
      const keys = k === "Coal" ? ["Coal_existing", "Coal_new"] : [k], tally = {};
      let best = null;
      members.forEach(m => {
        const v = plan.state[m].y47[si];
        keys.forEach(kk => { const r = plan.reasons[m][kk]; if (r && (v > 0.05 || level === "state")) tally[r] = (tally[r] || 0) + Math.max(v, 0.01); });
        if (v > 0.5 && (!best || v > best.v)) best = { m, v };
      });
      const top = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
      if (twh < 0.5 && !(level === "state" && top && top !== "not available" && top !== "not selected")) return;
      why.push(el("li", null, el("i", { style: { background: COL[k] } }), el("b", { text: k }), el("span", { text: f0(twh) + " TWh" }),
        el("span", { class: "r", text: (top || "–") + (level === "zone" && best ? ` · led by ${best.m}` : "") })));
    });
    const info = level === "state" ? R.state[name] : null;
    return card({ cls: "detail", title: level === "zone" ? `${name} zone` : name,
      sub: level === "zone" ? members.join(", ") : `${info.zone} zone · ${f0(info.area_km2)} km² · ${info.population_m[1] != null ? f0(info.population_m[1]) + " million people in 2047" : "population not in the organisers' file"}`,
      body: [
        el("div", { class: "pillrow" }, el("span", { class: "pill", text: role(st) }), el("span", { class: "pill", text: `Leading source: ${leadSource(st.mix)}` })),
        el("div", { class: "statline" },
          el("div", null, el("div", { class: "sl", text: "Makes in 2047" }), el("div", { class: "sv", text: f0(st.made) + " TWh" }), el("div", { class: "ss", text: `${f0(st.made0)} in 2025` })),
          el("div", null, el("div", { class: "sl", text: "Needs in 2047" }), el("div", { class: "sv", text: st.hasNeed ? f0(st.need) + " TWh" : "n/a" }), el("div", { class: "ss", text: st.hasNeed ? `${f0(st.need0)} in 2025` : "" })),
          el("div", null, el("div", { class: "sl", text: "Net position" }), el("div", { class: "sv", text: st.hasNeed ? signed(st.net) + " TWh" : "n/a" }), el("div", { class: "ss", text: st.hasNeed ? (st.net >= 0 ? "sent to other regions" : "brought in from other regions") : "" }))),
        sourceLegend(needs ? [{ label: "Requirement", color: "var(--ink)", kind: "line" }] : null),
        chartHost(h => stackedBars(h, { cats, series: sourceSeries(rows, fixed), height: 230, overlay: needs ? { values: needs, label: "Requirement" } : null })),
        el("p", { class: "section-title", style: { marginTop: "10px" }, text: "Local strengths: planned output against the resource ceiling" }), res,
        el("p", { class: "section-title", text: "What decided each source in 2047" }), el("ul", { class: "why-list" }, why),
      ] });
  }

  function zoneSentence(z) {
    const st = regionStats("zone", z), order = SRC.map((k, i) => ({ k, v: st.mix[i] })).sort((a, b) => b.v - a.v);
    const c0 = plan.zone[0][z][SI.Coal], c1 = st.mix[SI.Coal];
    const pos = st.net > 0.1 * st.need ? `Sends ${f0(st.net)} TWh to other zones.` : st.net < -0.1 * st.need ? `Brings in ${f0(-st.net)} TWh (${pct(-st.net / st.need)} of its need).` : "Roughly meets its own need.";
    return `${order[0].k} ${f0(order[0].v)} TWh (${pct(order[0].v / st.made)}) and ${order[1].k.toLowerCase()} ${f0(order[1].v)} TWh lead. ${pos} Coal ${f0(c0)} → ${f0(c1)} TWh.`;
  }

  function tabRegions() {
    const pick = (label, opts, key) => el("div", { class: "ctl" }, el("span", { class: "lab", text: label }),
      el("div", { class: "seg", role: "group", "aria-label": label }, opts.map(o => { const b = el("button", { type: "button", text: o.label, "aria-pressed": String(S[key] === o.v) });
        b.addEventListener("click", () => { S[key] = o.v; if (key === "mapLevel" && S.sel.level !== o.v) S.sel = o.v === "zone" ? { level: "zone", name: S.sel.level === "state" ? R.state[S.sel.name].zone : "West" } : { level: "state", name: zoneStates(S.sel.name).sort((a, b2) => plan.state[b2].made1 - plan.state[a].made1)[0] }; renderTab(); }); return b; })));
    const names = S.mapLevel === "zone" ? ZONES : STATES.slice().sort((a, b) => plan.state[b].made1 - plan.state[a].made1);
    const exporters = ZONES.filter(z => plan.zoneBal[Y47][z].net > 0.1 * plan.zoneBal[Y47][z].need), importers = ZONES.filter(z => plan.zoneBal[Y47][z].net < -0.1 * plan.zoneBal[Y47][z].need);
    const mapCard = card({
      title: exporters.length ? `${exporters.join(" and ")} generate for the rest of India; ${importers.join(", ")} import` : "Every zone is close to meeting its own need",
      sub: "2047 plan. Click a zone or state for its mix, strengths and the reason behind each source.",
      body: chartHost(drawMap, "map"),
      table: () => table([S.mapLevel === "zone" ? "Zone" : "State", "Makes 2047", "Needs 2047", "Net", "Leading source", "Role"], names.map(n => {
        const s = regionStats(S.mapLevel, n);
        return [n, f0(s.made), s.hasNeed ? f0(s.need) : "n/a", s.hasNeed ? signed(s.net) : "n/a", leadSource(s.mix), role(s)];
      })),
      foot: "A region's need is its share of the national requirement, from each state's population and position on the development ladder.",
    });
    const cards = el("div", { class: "zone-cards" }, ZONES.map(z => {
      const st = regionStats("zone", z);
      const b = el("button", { class: "zcard", type: "button", "aria-pressed": String(S.sel.level === "zone" && S.sel.name === z) },
        el("h3", null, z, el("span", { text: role(st) })),
        el("div", { class: "mixbar" }, STACK.filter(k => st.mix[SI[k]] > 0.5).map(k => el("i", { style: { background: COL[k], flex: st.mix[SI[k]] + " 0 0" } }))),
        el("p", { text: zoneSentence(z) }));
      b.addEventListener("click", () => { S.sel = { level: "zone", name: z }; S.mapLevel = "zone"; renderTab(); });
      return b;
    }));
    return el("div", { class: "stack" },
      el("div", { class: "local-row", style: { marginBottom: 0 } },
        pick("Show", [{ v: "zone", label: "Six zones" }, { v: "state", label: "States" }], "mapLevel"),
        pick("Colour by (2047)", [{ v: "net", label: "Net position" }, { v: "gen", label: "Generation" }, { v: "need", label: "Requirement" }, { v: "lead", label: "Leading source" }], "mapMetric")),
      el("div", { class: "grid g-55" }, mapCard, detailPanel()),
      el("p", { class: "section-title", style: { margin: "8px 0 0" }, text: "Strategy by zone, 2047" }), cards);
  }

  // =====================================================================================
  // Tab 5 - Evidence
  // =====================================================================================
  function tabEvidence() {
    const base = M.getPlan(Object.assign({}, DEFAULTS)), b47 = base.summary[Y47], fan = F.fan.ensemble;
    const mon = base.monthly[MS.length - 1], peak = mon.reduce((a, r, i) => (r.price > mon[a].price ? i : a), 0);
    const med = mon.map(r => r.price).sort((a, b) => a - b), cs = Object.fromEntries(O.ceiling_sensitivity.map(r => [r.case, r]));
    const share = (z, i) => pct(R.zone_need_share[z][i]);
    const noCoal = M.getPlan(Object.assign({}, DEFAULTS, { coal: 0 })), noCoal2 = M.getPlan(Object.assign({}, DEFAULTS, { coal: 0, land: 2 }));
    const gb = O.gas_breakeven, finding = (head, text) => el("li", null, el("b", { text: head + " " }), text);
    const findings = el("ol", { class: "findings" },
      finding("The requirement more than doubles.", `Median ${f0(fan.p50[LAST])} TWh in 2047 (${f0(fan.p10[LAST])}–${f0(fan.p90[LAST])}), ${f1(fan.p50[LAST] / F.base_twh)} times 2025, growing ${f1((Math.pow(fan.p50[LAST] / F.base_twh, 1 / (D.target_year - D.base_year)) - 1) * 100)}% a year.`),
      finding("Need moves east and north.", `The East's share of the requirement rises from ${share("East", 0)} to ${share("East", Y47)} and the North's from ${share("North", 0)} to ${share("North", Y47)}, while the South's falls from ${share("South", 0)} to ${share("South", Y47)}, as poorer, more populous states climb the ladder.`),
      finding("Solar and wind run into their land ceilings.", `Solar reaches ${f0(base.nat[Y47][SI.Solar])} TWh (${pct(base.nat[Y47][SI.Solar] / base.total[Y47])} of generation) and wind ${f0(base.nat[Y47][SI.Wind])} TWh, the most the measured land and wind resource allows under every strategy.`),
      finding("Winter sizes the system.", `In 2047 one more unit in ${MONTHS[peak]} costs ₹${f1(mon[peak].price)}/kWh against ₹${f1((med[5] + med[6]) / 2)} in the median month: solar, wind and hydro are all seasonally low.`),
      finding("Coal's share collapses while its output holds.", `Coal goes from ${pct(base.nat[0][SI.Coal] / base.total[0])} to ${pct(base.nat[Y47][SI.Coal] / base.total[Y47])} of generation (${f0(base.nat[0][SI.Coal])} → ${f0(base.nat[Y47][SI.Coal])} TWh). Emissions stay near ${f0(b47.em)} Mt CO₂ while generation grows ${f1(base.total[Y47] / base.total[0])} times.`),
      finding("If need comes in high, coal fills the gap.", `At the P90 requirement coal reaches ${f0(cs["P90"].coal_twh)} TWh and emissions ${f0(cs["P90"].emissions_mtco2)} Mt. Using 5% of open land for solar and doubling the wind ceiling brings that down to ${f0(cs["P90, both"].coal_twh)} TWh.`),
      finding("No new coal is feasible, with enough land.", noCoal.summary[Y47].uns < 0.5
        ? `Without any new coal plant the central requirement is still met in every month (coal ${f0(noCoal.nat[Y47][SI.Coal])} TWh in 2047). If solar is limited to 2% of open land, ${f0(noCoal2.summary[Y47].uns)} TWh goes unmet.`
        : `Without any new coal plant ${f0(noCoal.summary[Y47].uns)} TWh of the central requirement goes unmet in 2047.`),
      finding("Gas is a winter reserve unless it gets cheaper.", `At ₹${f1(gb[0].gas_cost_inr_kwh)}/kWh gas supplies ${f0(gb[0].gas_twh_2047)} TWh in 2047; at ₹${f1(gb[2].gas_cost_inr_kwh)} it supplies ${f0(gb[2].gas_twh_2047)} TWh.`));

    const drawDumbbell = host => {
      const fr = frame(host, 250, { t: 10, r: 16, b: 26, l: 82 }), rowH = fr.ih / ZONES.length, xMax = 0.35, x = v => v / xMax * fr.iw;
      [0, 0.1, 0.2, 0.3].forEach(t => {
        fr.g.appendChild(sv("line", { class: t === 0 ? "baseline" : "gridline", x1: x(t), x2: x(t), y1: 0, y2: fr.ih }));
        fr.g.appendChild(sv("text", { x: x(t), y: fr.ih + 16, "text-anchor": "middle", text: pct(t) }));
      });
      ZONES.forEach((z, i) => {
        const cy = rowH * (i + 0.5), a = R.zone_need_share[z][0], b = R.zone_need_share[z][Y47], p = R.production_share_latest[z];
        fr.g.appendChild(sv("text", { class: "ink2", x: -10, y: cy + 4, "text-anchor": "end", text: z }));
        fr.g.appendChild(sv("line", { x1: x(a), x2: x(b), y1: cy, y2: cy, style: { stroke: "var(--ink2)", strokeWidth: 2 } }));
        fr.g.appendChild(sv("rect", { x: x(p) - 1.5, y: cy - 9, width: 3, height: 18, style: { fill: "var(--muted)" } }));
        fr.g.appendChild(sv("circle", { cx: x(a), cy, r: 4.5, style: { fill: "var(--surface)", stroke: "var(--ink)", strokeWidth: 2 } }));
        fr.g.appendChild(sv("circle", { cx: x(b), cy, r: 5, style: { fill: "var(--ink)", stroke: "var(--surface)", strokeWidth: 2 } }));
        fr.g.appendChild(sv("text", { class: "ink b halo", x: x(b) + (b >= a ? 9 : -9), y: cy + 4, "text-anchor": b >= a ? "start" : "end", text: pct(b) }));
        fr.g.appendChild(hoverable(sv("rect", { class: "hit", x: -fr.m.l, y: rowH * i, width: fr.iw + fr.m.l, height: rowH }), () => ({ title: `${z} zone`,
          rows: [{ label: "Share of need, 2025", value: pct(a, 1) }, { label: "Share of need, 2047", value: pct(b, 1) }, { label: "Share of generation made today", value: pct(p, 1) }] })));
      });
    };
    const gx = gb.slice().sort((a, b) => a.gas_cost_inr_kwh - b.gas_cost_inr_kwh);
    const ceilRows = O.ceiling_sensitivity, cmax = Math.max.apply(null, ceilRows.map(r => r.coal_twh));
    const bar = (v, max, color) => el("span", null, el("span", { class: "bar", style: { width: Math.round(v / max * 60) + "px", background: color } }), f0(v));
    const fys = Array.from(new Set(D.compliance.ember_vs_npp.map(r => r.fy))), cats = Array.from(new Set(D.compliance.ember_vs_npp.map(r => r.category)));

    return el("div", { class: "stack" },
      card({ title: "What the analysis shows", sub: "Central requirement, Balanced strategy, unless stated. Every figure is read from the model outputs behind this page.", body: findings }),
      el("div", { class: "grid g-2" },
        card({ title: "Need is shifting towards zones that make less than they use",
          sub: "Each zone's share of the national requirement in 2025 and 2047, against its share of generation made today.",
          body: [legend([{ label: "Share of need, 2025", color: "var(--ink)", kind: "ring" }, { label: "Share of need, 2047", color: "var(--ink)", kind: "dot" }, { label: "Share of generation today", color: "var(--muted)", kind: "tick" }]), chartHost(drawDumbbell)],
          table: () => table(["Zone", "Need 2025", "Need 2047", "Generation today"], ZONES.map(z => [z, pct(R.zone_need_share[z][0], 1), pct(R.zone_need_share[z][Y47], 1), pct(R.production_share_latest[z], 1)])) }),
        card({ title: "Gas only earns a bigger role below about ₹5.5 per kWh",
          sub: "Gas-fired generation chosen for 2047 as its assumed cost falls (Balanced strategy, central requirement).",
          body: chartHost(h => lineChart(h, { x: gx.map(r => r.gas_cost_inr_kwh), height: 250, unit: "TWh in 2047", xFmt: v => "₹" + f1(v), xTicks: gx.map(r => r.gas_cost_inr_kwh), xTitle: v => `Gas at ₹${f1(v)}/kWh`,
            series: [{ label: "Gas generation", color: COL.Gas, values: gx.map(r => r.gas_twh_2047), width: 2 }],
            markers: gx.map(r => ({ x: r.gas_cost_inr_kwh, y: r.gas_twh_2047, color: COL.Gas, text: f0(r.gas_twh_2047) })) })),
          table: () => table(["Gas cost, ₹/kWh"].concat(MS.map(String)).concat(["Share 2047"]), gb.map(r => [f1(r.gas_cost_inr_kwh)].concat(MS.map(y => f0(r["gas_twh_" + y]))).concat([pct(r.gas_share_2047, 1)]))) })),
      el("div", { class: "grid g-2" },
        card({ title: "The resource ceilings decide how much coal remains", sub: "2047, Balanced strategy. Relaxing the land and wind ceilings is the main lever on coal and emissions.",
          body: table(["Case", "Solar", "Wind", "Coal", "Mt CO₂", "Clean", "₹/kWh"], ceilRows.map(r =>
            [r.case, f0(r.solar_twh), f0(r.wind_twh), bar(r.coal_twh, cmax, COL.Coal), f0(r.emissions_mtco2), pct(r.clean_share), f2(r.avg_cost_inr_kwh)]), { wrap: [0] }) }),
        card({ title: "The generation data agrees with the official record", sub: "Difference between the Ember state-level series used here and the National Power Portal's fiscal-year totals.",
          body: table(["Fiscal year"].concat(cats), fys.map(fy => [fy].concat(cats.map(c => { const r = D.compliance.ember_vs_npp.find(q => q.fy === fy && q.category === c); return r ? (Math.abs(r.diff_pct) < 0.05 ? "" : r.diff_pct > 0 ? "+" : "−") + f1(Math.abs(r.diff_pct)) + "%" : "–"; })))),
          foot: "Hydro differs because the state-level series includes small hydro, which the Portal's conventional-generation report leaves out." })));
  }

  // =====================================================================================
  // Tab 6 - Method and compliance
  // =====================================================================================
  function tabMethod() {
    const C = D.compliance, A = O.assumptions, RA = O.resource_assumptions, FA = F.assumptions;
    const ul = items => el("ul", null, items.map(t => { const li = el("li"); if (Array.isArray(t)) { li.appendChild(el("b", { text: t[0] + " " })); li.appendChild(document.createTextNode(t[1])); } else li.textContent = t; return li; }));
    const costRows = Object.keys(A.cost).map(k => [k.replace("_", " ").replace("Coal existing", "Coal, existing plants").replace("Coal new", "Coal, new plants"), "₹" + f2(A.cost[k][0]),
      A.cost[k][1] === 0 ? "flat" : (A.cost[k][1] * 100).toFixed(1) + "% a year", f2(O.emission_factors[k.indexOf("Coal") === 0 ? "Coal" : k] || 0)]);
    costRows.push(["Storage (per kWh shifted from day to night)", "₹" + f2(A.storage_cost[0]), (A.storage_cost[1] * 100).toFixed(1) + "% a year", "–"]);
    costRows.push(["Transfer between zones", "₹" + f2(A.transfer_cost), "flat", "–"]);
    return el("div", { class: "stack" },
      card({ title: "Rule followed: energy generated is the only basis for analysis",
        sub: "Installed capacity and energy consumption are not used for forecasting or comparison anywhere. A guard in the pipeline stops the run if a banned field reaches a processed table.",
        body: [table(["Source", "Kept", "Dropped"], C.sources.map(r => [r.source, r.kept, r.dropped]), { wrap: [0, 1, 2] }),
          el("div", { class: "prose", style: { marginTop: "10px" } }, el("p", null, el("b", { text: "Column patterns the guard rejects: " }), C.banned_patterns.map(p => p.replace(/\\b/g, "").replace(/\\/g, "")).join(", ") + "."),
            el("p", { style: { marginTop: "6px" } }, `${C.tables.length} processed tables passed the guard. Resource potential is expressed as energy (TWh a year) from land area, sunshine, wind speed and rainfall, never as megawatts. Build limits are annual additions to generation observed in India's own history.`))] }),
      el("div", { class: "grid g-2" },
        card({ title: "Forecast method", body: el("div", { class: "prose" }, ul([
          ["Target.", "Total electricity generation including captive plants, calendar year. Utility generation is about " + pct(F.utility_share) + " of that."],
          ["Drivers.", "Population (World Bank projection), urban share, and income per person. These are the population-growth and urbanisation effects the problem asks for."],
          ["Three lenses.", "India's own history; a development ladder built from other growing economies; a global fixed-effects panel with urbanisation. All anchored on 2025 actual generation."],
          ["Weights.", "Each lens is fitted on data to 2005, 2010 and 2015 and asked to predict through 2025. A lens's weight is the inverse of its mean squared error, capped at 50%."],
          ["Uncertainty.", `${f0(FA.n_draws)} simulations: GDP growth ±${f1(FA.growth_sd_pts)} points around ${f1(FA.scenarios_gdp_growth_pct.Base[0])}% falling to ${f1(FA.scenarios_gdp_growth_pct.Base[1])}%, population ±${f1(FA.population_sd * 100)}%, urban share in 2047 between ${f0(FA.urban_2047_triangle_pct[0])}% and ${f0(FA.urban_2047_triangle_pct[2])}%, parameter uncertainty in every lens, and the choice of lens.`],
          ["Regions.", `Each state sits on the ladder at its own income; its need is population times the ladder level. State incomes converge slowly (${(F.state_convergence.beta * 100).toFixed(2)}% a year, not statistically significant).`]])) }),
        card({ title: "Generation-mix method", body: el("div", { class: "prose" }, ul([
          ["What is chosen.", "Generation by state and source in 2030, 2035, 2040 and 2047, at the lowest cost of generation, storage, transfer and carbon."],
          ["Every month must balance.", "Requirement and solar, wind and hydro output follow the seasonal shapes of observed generation; coal and gas may swing within the range regional fleets have shown."],
          ["Day and night.", `Solar beyond what daytime need can absorb is shifted through storage at ${pct(A.storage_efficiency)} efficiency, or curtailed.`],
          ["Resource ceilings.", `Solar: ${f0(RA.SOLAR_USABLE.open * 100)}% of open land (satellite land cover) at local sunshine. Wind: land where the 50 m wind exceeds ${f1(RA.WIND_MIN_SPEED_50M)} m/s. Hydro: rainfall times relief, scaled by what well-developed states convert today. Land above ${f0(RA.MAX_ELEVATION_M)} m or steeper than ${f0(RA.MAX_RUGGEDNESS_M)} m relief is excluded.`],
          ["Build pace.", `Additions are limited to India's best demonstrated pace, growing ${pct(A.build_acceleration.Solar)} a year for solar and wind and ${pct(A.build_acceleration.Nuclear)} for nuclear; no state takes more than ${pct(A.state_build_share)} of a period's build.`],
          ["Coal.", `No state winds coal down faster than ${pct(A.coal_max_decline)} a year; the existing fleet ages ${pct(A.coal_fleet_retire_rate)} a year after ${A.coal_fleet_retire_from}.`],
          ["Dashboard controls.", `${O.runs.length} optimiser runs were solved in advance. The three requirement cases and all strategy and lever settings are exact runs; a custom requirement is interpolated between the two nearest solved levels.`]])) })),
      el("div", { class: "grid g-2" },
        card({ title: "Cost and emission assumptions", sub: "2025 rupees per kWh generated. These are working assumptions, to be replaced with published benchmarks.",
          body: table(["Source", "Cost in 2025", "Change", "t CO₂/MWh"], costRows, { wrap: [0] }),
          foot: `Coal is ₹${f2(A.pithead_discount)} cheaper in coal-mining states (${O.pithead_states.join(", ")}). Emission factors are computed from reported emissions and generation.` }),
        card({ title: "Limits of this analysis", body: el("div", { class: "prose" }, ul([
          "The regional split of need cannot be checked against consumption data, which is excluded by the rules.",
          "In the baseline, new uses of electricity (vehicles, hydrogen, data centres) enter only through income and urbanisation; the Themes tab adds them explicitly as assumptions.",
          "The wind ceiling is likely too low: the wind data is on a 50 km grid that smooths out narrow wind corridors. The Wind ceiling control shows the effect.",
          "Hydro ceilings ignore rivers flowing in from upstream, so Himalayan and north-eastern states are understated.",
          "State-level GDP in the organisers' file is only reliable for 2011–2019; later years are not used.",
          "The day–night balance is stylised (a half-sine solar day against flat need) because hourly data would be consumption data.",
          "Siting of gas and nuclear within a zone is indicative."])) })));
  }

  // =====================================================================================
  // Shell
  // =====================================================================================
  const TABS = [["forecast", "1 · Requirement forecast", tabForecast], ["themes", "2 · Themes and signposts", tabThemes], ["mix", "3 · Generation mix", tabMix],
    ["regions", "4 · Regions", tabRegions], ["evidence", "5 · Evidence", tabEvidence], ["method", "6 · Method and compliance", tabMethod]];
  function renderTabs() {
    const host = document.getElementById("tabs");
    host.textContent = "";
    TABS.forEach(t => {
      const b = el("button", { type: "button", role: "tab", "aria-selected": String(S.tab === t[0]), text: t[1] });
      b.addEventListener("click", () => { S.tab = t[0]; renderTabs(); renderTab(); });
      host.appendChild(b);
    });
  }
  function renderTab() {
    Tip.hide();
    pending.length = 0;
    const p = document.getElementById("panel"), keep = window.scrollY;
    p.textContent = "";
    p.appendChild(TABS.find(t => t[0] === S.tab)[2]());
    flush();
    window.scrollTo(0, keep);
  }
  function update() {
    scen = S.need === "custom" ? M.scenario(Object.assign({}, S, { boost: TH.boost(S.themes) })) : null;
    themed = computeThemed();
    plan = M.getPlan(Object.assign({}, S, { gas: gasFlag() }), themed.target);
    refreshers.forEach(f => f());
    renderKpis();
    const ctl = document.querySelector(".controls");
    if (ctl) document.documentElement.style.setProperty("--ctl-h", (ctl.offsetHeight + 12) + "px");
    renderTab();
  }

  document.getElementById("theme").addEventListener("click", () => {
    const root = document.documentElement, dark = root.dataset.theme ? root.dataset.theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("india2047-theme", root.dataset.theme); } catch (e) { /* storage unavailable */ }
  });
  try { const t = localStorage.getItem("india2047-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch (e) { /* storage unavailable */ }
  document.getElementById("footer").textContent = `Sources: Ember and Central Electricity Authority (generation by state and source), National Power Portal (official cross-check), Our World in Data and Energy Institute (national and international generation), World Bank (population, urbanisation, income), NASA POWER and MODIS (sunshine, wind, rainfall, land cover), organisers' state file (population, GSDP, zones). Built ${D.generated}.`;

  buildControls();
  renderTabs();
  update();
  let rt = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(renderTab, 150); });
})();
