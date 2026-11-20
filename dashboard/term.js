/* India 2047 terminal: one screen, map at the centre, every number traceable to its data. */
(function () {
  "use strict";
  const { el, sv, f0, f1, f2, pct, signed, Tip, hoverable } = window.UI;
  const D = window.DATA, F = D.forecast, O = D.optimiser, R = D.regions, M = window.MODEL, TH = window.THEMES, P = window.PROV;
  const { YEARS5, ZONES, STATES, SRC } = M;
  const SI = Object.fromEntries(SRC.map((s, i) => [s, i]));
  const LAST = F.years.length - 1, Y47 = YEARS5.length - 1;
  const COL = { Coal: "var(--s-coal)", Gas: "var(--s-gas)", Nuclear: "var(--s-nuclear)", Hydro: "var(--s-hydro)", Wind: "var(--s-wind)", Solar: "var(--s-solar)", Other: "var(--s-other)" };
  const ORDER = ["Solar", "Wind", "Hydro", "Nuclear", "Gas", "Coal"];          // display order, clean first
  const CLEAN = ["Nuclear", "Hydro", "Wind", "Solar"];
  const NEED = { p10: ["Low", "P10"], p50: ["Central", "P50"], p90: ["High", "P90"] };
  const STRAT = { 0: "Least cost", 2000: "Balanced", 4000: "Stronger carbon signal", 6000: "Deep decarbonisation" };
  const LENS = { india: ["India's own past", "time-series regression"], ladder: ["Peer countries", "development ladder"], panel: ["Global snapshot", "152-country panel"] };
  const DEFAULTS = { need: "p50", carbon: 2000, land: 3, wind: 1, coal: 1, pace: 0, g0: F.scenarios.Base[0], g1: F.scenarios.Base[1], urban: F.urban[LAST], pop: 0 };
  const S = Object.assign({ themes: TH.initial(), signposts: [], level: "zone", metric: "growth", sel: { level: "zone", name: "West" } }, DEFAULTS);
  let plan = null, themed = null;

  // =====================================================================================
  // Model state
  // =====================================================================================
  function computeThemed() {
    const sp = S.signposts.length > 0, active = TH.anyOn(S.themes) || sp;
    const ratio = TH.baselineRatio(S);
    const basePlain = F.fan.ensemble[S.need];
    const base = basePlain.map((v, i) => v * ratio[i]);
    const wedges = TH.wedges(S, base);
    const dist = active ? TH.distribution(S) : null;
    const band = dist ? (sp ? dist.post : dist.prior) : F.fan.ensemble;
    return { active, dist, band, basePlain, base, wedges,
             path: active ? band[S.need] : basePlain,
             full: active ? band[S.need][LAST] : basePlain[LAST],
             target: active ? (sp ? dist.gridPost : dist.gridPrior)[S.need] : null,
             dedicated: wedges.by.hydrogen ? wedges.by.hydrogen[LAST] : 0 };
  }
  function update() {
    themed = computeThemed();
    plan = M.getPlan(Object.assign({}, S, { gas: TH.gasOn(S.themes) ? 1 : 0 }), themed.target);
    render();
  }
  const natReq = (yi = Y47) => themed.path[F.years.indexOf(YEARS5[yi])];
  const shareOf = (z, yi) => R.zone_req[z][S.need][yi] / ZONES.reduce((a, k) => a + R.zone_req[k][S.need][yi], 0);
  /** Theme TWh landing in each zone by 2047 (cards with a location go there; the rest follows each zone's share). */
  function themeZoneDelta(z, q = S.need) {
    if (!themed.active) return 0;
    const w47 = {}; Object.keys(themed.wedges.by).forEach(id => { w47[id] = themed.wedges.by[id][LAST]; });
    const split = TH.zoneSplit(S, w47), wsum = Object.values(w47).reduce((a, v) => a + v, 0);
    const delta = themed.band[q][LAST] - F.fan.ensemble[q][LAST], k = Math.abs(wsum) > 1e-9 ? Math.min(1, Math.abs(delta / wsum)) : 0;
    // located wedges go to their zones (scaled if this quantile moved less than the central wedges); the rest follows each zone's share
    const located = Object.values(split).reduce((a, o) => a + o[z], 0) * k;
    return located + (delta - wsum * k) * shareOf(z, Y47);
  }
  /** Requirement (all generation, incl. captive), TWh. With themes, the whole range moves with the national one. */
  function zoneReq(z, yi = Y47, q = S.need) {
    const base = R.zone_req[z][q][yi];
    if (!themed.active) return base;
    if (yi === Y47) return base + themeZoneDelta(z, q);
    const fi = F.years.indexOf(YEARS5[yi]);
    return base * themed.band[q][fi] / F.fan.ensemble[q][fi];
  }
  function stateReq(st, yi = Y47, q = S.need) {
    const r = R.state_req[st] && R.state_req[st][q][yi];
    if (r == null) return null;
    if (!themed.active) return r;
    const z = R.state[st].zone;
    return r * zoneReq(z, yi) / R.zone_req[z][q][yi];
  }
  const reqOf = (u, yi, q) => u.level === "zone" ? zoneReq(u.name, yi, q) : stateReq(u.name, yi, q);
  const zoneStates = z => STATES.filter(s => R.state[s] && R.state[s].zone === z);
  /** Grid plan for a zone or state: 2025 and 2047 mix, what it makes, its grid need and net position. */
  function supply(u) {
    if (u.level === "zone") {
      const b0 = plan.zoneBal[0][u.name], b1 = plan.zoneBal[Y47][u.name];
      return { mix0: plan.zone[0][u.name], mix1: plan.zone[Y47][u.name], fixed: R.zone_fixed[u.name], made0: b0.made, made1: b1.made, need1: b1.need, net: b1.net, hasNeed: true };
    }
    const s = plan.state[u.name];
    return { mix0: s.base, mix1: s.y47, fixed: R.state[u.name].fixed, made0: s.made0, made1: s.made1, need1: s.need1, net: s.made1 - s.need1, hasNeed: s.hasNeed };
  }
  const lead = mix => SRC.reduce((a, s, i) => (mix[i] > mix[SI[a]] ? s : a), SRC[0]);
  const cleanOf = mix => { const t = mix.reduce((a, v) => a + v, 0); return t > 0 ? CLEAN.reduce((a, k) => a + mix[SI[k]], 0) / t : 0; };
  const role = sp => { if (!sp.hasNeed) return null; const r = sp.net / Math.max(sp.need1, 1e-9); return r > 0.1 ? "Exporter" : r < -0.1 ? "Importer" : "Self-sufficient"; };
  const uname = u => u.level === "zone" ? `${u.name} zone` : u.name;

  // =====================================================================================
  // Traceable numbers
  // =====================================================================================
  /** A number that opens its trace when clicked. */
  function N(text, id, args, cls) {
    const b = el("button", { type: "button", class: "n" + (cls ? " " + cls : ""), text, title: "Trace this number" });
    b.addEventListener("click", e => { e.stopPropagation(); Trace.open(id, args || {}, drawerOpen()); });
    return b;
  }

  // =====================================================================================
  // Top bar and menus
  // =====================================================================================
  let menuEl = null, menuBtn = null;
  function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } if (menuBtn) { menuBtn.setAttribute("aria-expanded", "false"); menuBtn = null; } }
  function openMenu(btn, build) {
    const same = menuBtn === btn; closeMenu(); if (same) return;
    menuEl = el("div", { class: "menu", role: "menu" }); build(menuEl);
    document.body.appendChild(menuEl);
    const r = btn.getBoundingClientRect(), w = menuEl.offsetWidth;
    menuEl.style.left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8)) + "px"; menuEl.style.top = (r.bottom + 4) + "px";
    menuBtn = btn; btn.setAttribute("aria-expanded", "true");
  }
  document.addEventListener("click", e => { if (menuEl && !menuEl.contains(e.target) && !(menuBtn && menuBtn.contains(e.target))) closeMenu(); });

  const CHIPS = [
    { k: "NEED", get: () => NEED[S.need].join(" "), opts: () => Object.keys(NEED).map(v => ({ v, label: NEED[v][0] + " requirement", small: NEED[v][1] })), key: "need",
      note: "Which point of the forecast range the supply plan is built for." },
    { k: "STRATEGY", get: () => STRAT[S.carbon], opts: () => O.axes.carbon.map(v => ({ v, label: STRAT[v], small: "₹" + f0(v) + "/t CO₂" })), key: "carbon",
      note: "Carbon price the optimiser adds to each source's cost." },
    { k: "SOLAR LAND", get: () => S.land + "%", opts: () => O.axes.solar_land_pct.map(v => ({ v, label: v + "% of open land", small: v === 3 ? "official convention" : "" })), key: "land",
      note: "Share of open land (satellite land cover) usable for solar." },
    { k: "WIND", get: () => S.wind === 1 ? "As measured" : "Doubled", opts: () => [{ v: 1, label: "As measured", small: "NASA wind" }, { v: 2, label: "Doubled", small: "finer data" }], key: "wind",
      note: "Wind ceilings from 50 km satellite wind; finer data would find more." },
    { k: "NEW COAL", get: () => S.coal ? "Allowed" : "None", opts: () => [{ v: 1, label: "Allowed" }, { v: 0, label: "None" }], key: "coal" },
    { k: "BUILD PACE", get: () => S.pace ? "Faster" : "Demonstrated", opts: () => [{ v: 0, label: "As demonstrated", small: "India's best years" }, { v: 1, label: "Faster", small: "pace grows" }], key: "pace" },
  ];
  const SUPPLY = ["land", "wind", "coal", "pace"];
  function supplyMenu(m) {
    m.appendChild(el("p", { text: "Limits the optimiser works within. Each combination is a real optimiser run." }));
    CHIPS.filter(c => SUPPLY.includes(c.key)).forEach(c => {
      m.appendChild(el("div", { class: "mh", text: c.k + (c.note ? "" : "") }));
      c.opts().forEach(o => {
        const it = el("button", { class: "opt", type: "button", role: "menuitemradio", "aria-checked": String(S[c.key] === o.v) }, el("span", { text: o.label }), o.small ? el("small", { text: o.small }) : null);
        it.addEventListener("click", e => { e.stopPropagation(); S[c.key] = o.v; update(); m.textContent = ""; supplyMenu(m); });
        m.appendChild(it);
      });
    });
  }
  function buildBar() {
    const host = document.getElementById("chips");
    host.textContent = "";
    CHIPS.filter(c => !SUPPLY.includes(c.key)).forEach(c => {
      const b = el("button", { class: "chip", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" }, el("span", { class: "k", text: c.k }), el("b", { text: c.get() }), "▾");
      if (S[c.key] !== DEFAULTS[c.key]) b.classList.add("on");
      b.addEventListener("click", () => openMenu(b, m => {
        if (c.note) m.appendChild(el("p", { text: c.note }));
        c.opts().forEach(o => {
          const it = el("button", { class: "opt", type: "button", role: "menuitemradio", "aria-checked": String(S[c.key] === o.v) }, el("span", { text: o.label }), o.small ? el("small", { text: o.small }) : null);
          it.addEventListener("click", () => { S[c.key] = o.v; closeMenu(); update(); });
          m.appendChild(it);
        });
      }));
      host.appendChild(b);
    });
    const changed = SUPPLY.filter(k => S[k] !== DEFAULTS[k]).length;
    const sb = el("button", { class: "chip" + (changed ? " on" : ""), type: "button", "aria-haspopup": "menu", "aria-expanded": "false" }, el("span", { class: "k", text: "SUPPLY" }),
      el("b", { text: changed ? `${changed} changed` : "default" }), "▾");
    sb.addEventListener("click", () => openMenu(sb, supplyMenu));
    host.appendChild(sb);
    const n = TH.CARDS.filter(c => S.themes[c.id].on).length;
    const tb = el("button", { class: "chip" + (n ? " on" : ""), type: "button", "aria-haspopup": "menu", "aria-expanded": "false" }, el("span", { class: "k", text: "THEMES" }), el("b", { text: n ? n + " on" : "off" }), "▾");
    tb.addEventListener("click", () => openMenu(tb, themeMenu));
    host.appendChild(tb);
    const dirty = Object.keys(DEFAULTS).some(k => S[k] !== DEFAULTS[k]) || n;
    if (dirty) {
      const rs = el("button", { class: "chip", type: "button", text: "RESET" });
      rs.addEventListener("click", () => { Object.assign(S, DEFAULTS, { themes: TH.initial(), signposts: [] }); update(); });
      host.appendChild(rs);
    }
  }
  function themeMenu(m) {
    m.appendChild(el("div", { class: "mh", text: "What-if themes (at default size)" }));
    TH.CARDS.forEach(c => {
      const t = S.themes[c.id];
      const w = c.id === "oilgas" ? "GDP +" + f2(c.gdp_boost_pts[t.value]) + " pts" : themed.wedges.by[c.id] ? signed(themed.wedges.by[c.id][LAST]) + " TWh" : "";
      const it = el("button", { class: "tg", type: "button", role: "menuitemcheckbox", "aria-checked": String(t.on) }, el("i"), el("span", { text: c.name }), el("small", { text: w }));
      it.addEventListener("click", e => { e.stopPropagation(); S.themes[c.id].on = !t.on; update(); m.textContent = ""; themeMenu(m); });
      m.appendChild(it);
    });
    m.appendChild(el("div", { class: "sep" }));
    m.appendChild(el("p", { text: "Theme sizes are our stated assumptions in TWh generated. Click the requirement number to trace what each theme adds." }));
  }

  // =====================================================================================
  // Ticker
  // =====================================================================================
  function renderTicker() {
    const host = document.getElementById("ticker"), s47 = plan.summary[Y47], s25 = plan.summary[0];
    const req = themed.full, coal0 = plan.nat[0][SI.Coal], coal1 = plan.nat[Y47][SI.Coal], cagr = Math.pow(req / F.base_twh, 1 / (D.target_year - D.base_year)) - 1;
    const short = plan.summary.find(s => s.uns >= 0.5);
    const tk = (label, value, unit, sub, cls) => el("div", { class: "tk" }, el("div", { class: "l", text: label }), el("div", { class: "v" + (cls ? " " + cls : "") }, value, unit ? el("small", { text: unit }) : null), el("div", { class: "s" }, sub));
    host.textContent = "";
    host.append(
      tk("Requirement 2047", N(f0(req), "req.nat"), "TWh", [`range `, N(`${f0(themed.band.p10[LAST])}–${f0(themed.band.p90[LAST])}`, "req.range"), themed.active ? " · with themes" : ""]),
      tk("Growth vs 2025", N(f1(req / F.base_twh) + "×", "kpi.growth"), "", [N(f0(F.base_twh), "base.nat"), ` TWh in 2025 · ${pct(cagr, 1)} a year`]),
      tk("Clean share 2047", N(pct(s47.clean), "kpi.clean"), "", [`${pct(s25.clean)} in 2025`]),
      tk("Coal 2047", N(f0(coal1), "kpi.coal"), "TWh", [`${f0(coal0)} in 2025 · `, el("span", { class: coal1 > coal0 ? "down" : "up", text: (coal1 >= coal0 ? "+" : "−") + pct(Math.abs(coal1 / coal0 - 1)) })]),
      tk("CO₂ 2047", N(f0(s47.em), "kpi.em"), "Mt", [`${f0(s25.em)} in 2025 · ${f0(s47.intensity)} g/kWh`]),
      tk("Cost 2047", N("₹" + f2(s47.cost), "kpi.cost"), "/kWh", short ? [el("span", { class: "down", text: `SHORT ${f0(short.uns)} TWh in ${YEARS5[plan.summary.indexOf(short)]}` })] : [el("span", { class: "up", text: "every month met" })]),
    );
  }

  // =====================================================================================
  // Left column: zone watchlist and national view
  // =====================================================================================
  function mixBar(mix, width) {
    const t = mix.reduce((a, v) => a + v, 0) || 1;
    return el("span", { class: "mb", style: width ? { width: width + "px" } : null }, ORDER.filter(k => mix[SI[k]] > 0.5).map(k => el("i", { style: { background: COL[k], width: (mix[SI[k]] / t * 100) + "%" } })));
  }
  function renderLeft() {
    const host = document.getElementById("left");
    host.textContent = "";
    host.appendChild(el("div", { class: "ph" }, el("span", { text: "Zones · 2047" }), el("span", { class: "r", text: "click a row" })));
    const tb = el("tbody");
    ZONES.forEach(z => {
      const r0 = zoneReq(z, 0), r1 = zoneReq(z), sp = supply({ level: "zone", name: z });
      const sel = S.sel.level === "zone" && S.sel.name === z || (S.sel.level === "state" && R.state[S.sel.name].zone === z);
      const tr = el("tr", { class: "row" + (sel ? " sel" : ""), tabindex: "0" },
        el("td", { text: z }), el("td", { text: f0(r1) }), el("td", { text: f1(r1 / r0) + "×" }),
        el("td", { class: sp.net >= 0 ? "up" : "down", text: signed(sp.net) }), el("td", null, mixBar(sp.mix1)));
      const go = () => select({ level: "zone", name: z });
      tr.addEventListener("click", go);
      tr.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
      tb.appendChild(tr);
    });
    host.appendChild(el("table", { class: "wl" }, el("thead", null, el("tr", null, el("th", { text: "ZONE" }), el("th", { text: "NEED TWh" }), el("th", { text: "×2025" }), el("th", { text: "NET" }), el("th", { text: "MIX" }))), tb));

    // national requirement chart
    const sec = el("div", { class: "sec" }, el("p", { class: "cap", text: "India · requirement, TWh" }));
    sec.appendChild(nationalSpark());
    sec.appendChild(el("div", { class: "kv" },
      el("span", { text: "2025 actual" }), el("b", null, N(f0(F.base_twh), "base.nat")),
      el("span", { text: `2047 ${NEED[S.need][1]}` }), el("b", null, N(f0(themed.full), "req.nat")),
      el("span", { text: "Likely range" }), el("b", null, N(`${f0(themed.band.p10[LAST])}–${f0(themed.band.p90[LAST])}`, "req.range"))));
    host.appendChild(sec);

    // three views
    const lv = el("div", { class: "sec" }, el("p", { class: "cap", text: "Three forecast views, 2047" }));
    const g = el("div", { class: "kv" });
    ["india", "ladder", "panel"].forEach(k => {
      g.append(el("span", null, `${LENS[k][0]} `, N(pct(F.lens.weights[k]), "weights")), el("b", null, N(f0(F.fan[k].p50[LAST]), "lens", { k })));
    });
    lv.appendChild(g);
    lv.appendChild(el("p", { class: "hint", text: "Each future picks one view, with probability = its weight (from back-testing)." }));
    host.appendChild(lv);

    // national mix
    const mx = el("div", { class: "sec" }, el("p", { class: "cap", text: "India · grid generation by source" }));
    [0, Y47].forEach(yi => {
      const nat = plan.nat[yi], t = nat.reduce((a, v) => a + v, 0);
      mx.appendChild(el("div", { class: "mixh" }, el("span", { text: YEARS5[yi] }),
        el("div", { class: "bar2" }, ORDER.filter(k => nat[SI[k]] > 0.5).map(k => hoverable(el("i", { style: { background: COL[k], width: (nat[SI[k]] / t * 100) + "%" } }),
          () => ({ title: `${k} · ${YEARS5[yi]}`, rows: [{ label: "Generation", value: f0(nat[SI[k]]) + " TWh" }, { label: "Share", value: pct(nat[SI[k]] / t) }] }))))));
    });
    mx.appendChild(el("div", { class: "lgrow" }, ORDER.map(k => el("span", { class: "lg" }, el("i", { style: { background: COL[k] } }), k))));
    host.appendChild(mx);
  }
  function nationalSpark() {
    const W = 276, H = 120, x0 = 2000, x1 = D.target_year, m = { l: 4, r: 34, t: 8, b: 16 };
    const hy = F.history.years, ht = F.history.total, ymax = Math.max(themed.band.p90[LAST], 6600) * 1.04;
    const X = y => m.l + (y - x0) / (x1 - x0) * (W - m.l - m.r), Y = v => H - m.b - v / ymax * (H - m.t - m.b);
    const pts = (xs, ys) => xs.map((x, i) => `${X(x).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(" ");
    const hi = hy.map((y, i) => [y, ht[i]]).filter(p => p[0] >= x0);
    const svg = sv("svg", { class: "spark", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "India's generation 2000–2025 and forecast range to 2047" });
    [2000, 4000, 6000].forEach(v => { svg.appendChild(sv("line", { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), stroke: "#1e2630", "stroke-width": 1 })); svg.appendChild(sv("text", { x: W - m.r + 3, y: Y(v) + 3, text: f0(v) })); });
    const fy = F.years;
    svg.appendChild(sv("polygon", { points: pts(fy, themed.band.p90) + " " + pts(fy.slice().reverse(), themed.band.p10.slice().reverse()), fill: "#ffb000", opacity: 0.16 }));
    svg.appendChild(sv("polyline", { points: pts(hi.map(p => p[0]), hi.map(p => p[1])), fill: "none", stroke: "#e8edf3", "stroke-width": 1.6 }));
    svg.appendChild(sv("polyline", { points: pts(fy, themed.path), fill: "none", stroke: "#ffb000", "stroke-width": 1.8 }));
    svg.appendChild(sv("circle", { cx: X(x1), cy: Y(themed.full), r: 2.6, fill: "#ffb000" }));
    [x0, 2025, x1].forEach(y => svg.appendChild(sv("text", { x: X(y), y: H - 3, "text-anchor": y === x0 ? "start" : y === x1 ? "end" : "middle", text: y })));
    return svg;
  }

  // =====================================================================================
  // Centre: the map
  // =====================================================================================
  const METRICS = [
    { v: "growth", label: "Growth ×", desc: "Requirement 2047 ÷ 2025" },
    { v: "need", label: "Requirement", desc: "Requirement 2047, TWh" },
    { v: "gen", label: "Generation", desc: "Grid generation 2047, TWh" },
    { v: "net", label: "Net flow", desc: "Generation − grid need, 2047" },
    { v: "lead", label: "Main source", desc: "Largest source in 2047" },
    { v: "clean", label: "Clean %", desc: "Clean share of 2047 generation" },
  ];
  function unitStats(u) {
    const r0 = reqOf(u, 0), r1 = reqOf(u, Y47), sp = supply(u);
    return { r0, r1, growth: r0 && r1 ? r1 / r0 : null, sp, lead: lead(sp.mix1), clean: cleanOf(sp.mix1) };
  }
  function metricVal(st, metric) {
    return metric === "growth" ? st.growth : metric === "need" ? st.r1 : metric === "gen" ? st.sp.made1 : metric === "net" ? (st.sp.hasNeed ? st.sp.net : null) : metric === "clean" ? st.clean : null;
  }
  const metricText = (st, metric) => {
    const v = metricVal(st, metric);
    if (metric === "lead") return st.lead;
    if (v == null) return "n/a";
    return metric === "growth" ? f1(v) + "×" : metric === "clean" ? pct(v) : metric === "net" ? signed(v) : f0(v);
  };
  function renderMap() {
    const host = document.getElementById("center");
    host.textContent = "";
    const segp = (opts, key, after) => el("div", { class: "seg", role: "group" }, opts.map(o => {
      const b = el("button", { type: "button", text: o.label, "aria-pressed": String(S[key] === o.v), title: o.desc || "" });
      b.addEventListener("click", () => { S[key] = o.v; if (after) after(o.v); render(); });
      return b;
    }));
    host.appendChild(el("div", { class: "mapbar" },
      segp([{ v: "zone", label: "6 Zones" }, { v: "state", label: "States" }], "level", v => {
        if (v === "zone" && S.sel.level === "state") S.sel = { level: "zone", name: R.state[S.sel.name].zone };
      }),
      segp(METRICS, "metric")));
    const wrap = el("div", { class: "mapwrap" });
    host.appendChild(wrap);
    wrap.appendChild(el("div", { class: "maptitle" }, el("b", { text: METRICS.find(m => m.v === S.metric).desc }),
      el("span", { text: `${NEED[S.need][0]} need · ${STRAT[S.carbon]} · hover or click a ${S.level === "zone" ? "zone" : "state"}` })));
    const scale = el("div", { class: "scale" });
    wrap.appendChild(scale);

    const mp = R.map, level = S.level, metric = S.metric;
    const unitOf = st => level === "zone" ? R.state[st].zone : st;
    const names = level === "zone" ? ZONES : STATES;
    const stats = {}; names.forEach(n => { stats[n] = unitStats({ level, name: n }); });
    const vals = names.map(n => metricVal(stats[n], metric)).filter(v => v != null && isFinite(v));
    const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), amax = Math.max.apply(null, vals.map(Math.abs).concat([1]));
    const fill = n => {
      const st = stats[n]; if (!st) return "#10151c";
      if (metric === "lead") return COL[st.lead];
      const v = metricVal(st, metric); if (v == null || !isFinite(v)) return "#10151c";
      if (metric === "net") {
        const k = Math.abs(v) < amax * 0.04 ? 0 : Math.ceil(Math.sqrt(Math.abs(v) / amax) * 3);
        return k === 0 ? "var(--div-mid)" : `color-mix(in oklab, var(${v > 0 ? "--div-pos" : "--div-neg"}) ${[0, 40, 70, 100][k]}%, var(--div-mid))`;
      }
      const t = metric === "growth" || metric === "clean" ? (hi > lo ? (v - lo) / (hi - lo) : 1) : Math.sqrt(Math.max(v, 0) / Math.max(hi, 1e-9));
      return `var(--seq-${Math.max(1, Math.min(7, Math.ceil(t * 7)))})`;
    };
    const svg = sv("svg", { viewBox: `0 0 ${mp.width} ${mp.height}`, role: "img", "aria-label": "Map of India: click a region" });
    const shapes = [];
    const selUnit = S.sel.level === level ? S.sel.name : level === "zone" ? R.state[S.sel.name].zone : null;
    const tip = st => () => {
      const n = unitOf(st), s = stats[n];
      if (!s) return { title: st, note: "No data" };
      const rows = [{ label: "Requirement 2025", value: s.r0 != null ? f0(s.r0) + " TWh" : "n/a" }, { label: "Requirement 2047", value: s.r1 != null ? f0(s.r1) + " TWh" : "n/a", on: true },
        { label: "Growth", value: s.growth ? f1(s.growth) + "×" : "n/a" }, { label: "Generation 2047", value: f0(s.sp.made1) + " TWh" }];
      SRC.map((k, i) => ({ k, v: s.sp.mix1[i] })).filter(r => r.v > 0.5).sort((a, b) => b.v - a.v).slice(0, 3)
        .forEach(r => rows.push({ color: COL[r.k], label: "  " + r.k, value: f0(r.v) + " TWh" }));
      if (s.sp.hasNeed) rows.push({ label: "Net flow", value: signed(s.sp.net) + " TWh" });
      return { title: level === "zone" ? `${n} zone` : `${st} · ${R.state[st].zone}`, rows, note: "Click for detail and sources" };
    };
    const hoverOn = st => () => shapes.forEach(sh => sh.node.classList.toggle("fade", sh.known && unitOf(sh.st) !== unitOf(st)));
    const hoverOff = () => shapes.forEach(sh => sh.node.classList.remove("fade"));
    Object.keys(mp.states).forEach(st => {
      const g = mp.states[st], known = !!R.state[st] && !!stats[unitOf(st)];
      const isSel = known && unitOf(st) === selUnit;
      const mk = node => {
        node.setAttribute("class", "st" + (known ? "" : " nodata") + (isSel ? " selected" : ""));
        if (known) {
          node.style.fill = fill(unitOf(st));
          hoverable(node, tip(st), hoverOn(st), hoverOff);
          node.addEventListener("click", () => select({ level, name: unitOf(st) }));
          node.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select({ level, name: unitOf(st) }); } });
          node.setAttribute("aria-label", level === "zone" ? `${unitOf(st)} zone (${st})` : st);
        }
        shapes.push({ node, st, known });
        return node;
      };
      svg.appendChild(mk(sv("path", { d: g.d })));
      if (g.px2 < 8) svg.appendChild(mk(sv("circle", { cx: g.cx, cy: g.cy, r: 3.2 })));
    });
    shapes.filter(s => s.node.classList.contains("selected")).forEach(s => svg.appendChild(s.node));
    const label = (x, y, a, b) => { svg.appendChild(sv("text", { class: "zl", x, y: y - 2, "text-anchor": "middle", text: a })); if (b) svg.appendChild(sv("text", { class: "zv", x, y: y + 11, "text-anchor": "middle", text: b })); };
    if (level === "zone") ZONES.forEach(z => {
      let a = 0, cx = 0, cy = 0;
      zoneStates(z).filter(st => st !== "Ladakh" && st !== "Andaman and Nicobar" && st !== "Lakshadweep").forEach(st => { const g = mp.states[st]; if (g) { a += g.px2; cx += g.cx * g.px2; cy += g.cy * g.px2; } });
      if (a) label(cx / a, cy / a, z.toUpperCase(), metricText(stats[z], metric));
    });
    else if (S.sel.level === "state" && mp.states[S.sel.name]) { const g = mp.states[S.sel.name]; label(g.cx, g.cy, S.sel.name, metricText(stats[S.sel.name], metric)); }
    wrap.appendChild(svg);
    // keep labels a readable size on screen whatever the map's rendered size
    requestAnimationFrame(() => {
      const h = svg.getBoundingClientRect().height, w = svg.getBoundingClientRect().width;
      if (!h) return;
      const k = Math.max(mp.height / h, mp.width / w);
      svg.querySelectorAll(".zl").forEach(t => { t.style.fontSize = (12.5 * k) + "px"; t.style.strokeWidth = (3 * k) + "px"; t.setAttribute("dy", (-2 * k + 2)); });
      svg.querySelectorAll(".zv").forEach(t => { t.style.fontSize = (11.5 * k) + "px"; t.style.strokeWidth = (3 * k) + "px"; t.setAttribute("dy", (3 * k)); });
    });

    // scale
    if (metric === "lead") ORDER.forEach(k => scale.appendChild(el("span", { class: "lg" }, el("i", { style: { background: COL[k] } }), k)));
    else if (metric === "net") {
      scale.append(el("span", { text: `imports ${f0(amax)}` }), el("span", { class: "steps" }, [-3, -2, -1, 0, 1, 2, 3].map(k => el("i", { style: { background: k === 0 ? "var(--div-mid)" : `color-mix(in oklab, var(${k > 0 ? "--div-pos" : "--div-neg"}) ${[0, 40, 70, 100][Math.abs(k)]}%, var(--div-mid))` } }))),
        el("span", { text: `exports ${f0(amax)} TWh` }));
    } else {
      const fmt = v => metric === "growth" ? f1(v) + "×" : metric === "clean" ? pct(v) : f0(v);
      scale.append(el("span", { text: metric === "growth" || metric === "clean" ? fmt(lo) : "0" }), el("span", { class: "steps" }, [1, 2, 3, 4, 5, 6, 7].map(k => el("i", { style: { background: `var(--seq-${k})` } }))),
        el("span", { text: fmt(hi) + (metric === "need" || metric === "gen" ? " TWh" : "") }));
    }
  }

  // =====================================================================================
  // Right: region detail
  // =====================================================================================
  function select(u) {
    S.sel = u;
    if (u.level === "state" && S.level === "zone") S.level = "state";
    render();
  }
  function regionSpark(u) {
    const W = 340, H = 70, m = { l: 2, r: 2, t: 6, b: 14 };
    const p10 = YEARS5.map((_, i) => reqOf(u, i, "p10")), p90 = YEARS5.map((_, i) => reqOf(u, i, "p90")), mid = YEARS5.map((_, i) => reqOf(u, i));
    if (mid.some(v => v == null)) return null;
    const ymax = Math.max.apply(null, p90.concat(mid)) * 1.05, x0 = YEARS5[0], x1 = YEARS5[Y47];
    const X = y => m.l + (y - x0) / (x1 - x0) * (W - m.l - m.r), Y = v => H - m.b - v / ymax * (H - m.t - m.b);
    const pts = (ys, xs) => (xs || YEARS5).map((x, i) => `${X(x).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(" ");
    const svg = sv("svg", { class: "spark", viewBox: `0 0 ${W} ${H}`, style: { height: "70px" }, role: "img", "aria-label": "Requirement path with likely range" });
    svg.appendChild(sv("polygon", { points: pts(p90) + " " + pts(p10.slice().reverse(), YEARS5.slice().reverse()), fill: "#ffb000", opacity: 0.16 }));
    svg.appendChild(sv("polyline", { points: pts(mid), fill: "none", stroke: "#ffb000", "stroke-width": 1.8 }));
    YEARS5.forEach((y, i) => { svg.appendChild(sv("circle", { cx: X(y), cy: Y(mid[i]), r: 2.2, fill: "#ffb000" })); svg.appendChild(sv("text", { x: X(y), y: H - 2, "text-anchor": i === 0 ? "start" : i === Y47 ? "end" : "middle", text: y })); });
    return svg;
  }
  function renderRight() {
    const host = document.getElementById("right"), u = S.sel;
    host.textContent = "";
    const st = unitStats(u), sp = st.sp, info = u.level === "state" ? R.state[u.name] : null;
    const crumb = el("div", { class: "crumb" }, "INDIA › ");
    if (u.level === "state") { const zb = el("button", { type: "button", text: info.zone.toUpperCase() }); zb.addEventListener("click", () => { S.level = "zone"; select({ level: "zone", name: info.zone }); }); crumb.append(zb, " › ", u.name.toUpperCase()); }
    else crumb.append(u.name.toUpperCase());
    host.appendChild(el("div", { class: "dh" }, crumb, el("h2", { text: uname(u) }),
      el("p", { text: u.level === "zone" ? `${zoneStates(u.name).length} states and UTs · organisers' zone definition` : `${info.zone} zone · ${f0(info.area_km2)} km²${info.population_m[1] ? ` · ${f0(info.population_m[1])} m people in 2047` : ""}` })));

    // requirement
    const rq = el("div", { class: "sec" }, el("p", { class: "cap", text: "Requirement · all generation, TWh" }));
    if (st.r1 == null) rq.appendChild(el("p", { class: "hint", text: "No requirement estimate: this territory is not in the organisers' state file (no population or GSDP)." }));
    else {
      rq.appendChild(el("div", { class: "big" }, el("span", { class: "v" }, N(f0(st.r1), u.level === "zone" ? "req.zone" : "req.state", u)), el("span", { class: "u", text: "TWh in 2047" }),
        el("span", { class: "pill up", text: f1(st.growth) + "× 2025" })));
      const sk = regionSpark(u); if (sk) rq.appendChild(sk);
      rq.appendChild(el("div", { class: "kv" },
        el("span", { text: "2025" }), el("b", null, N(f0(st.r0), u.level === "zone" ? "req.zone" : "req.state", Object.assign({ yi: 0 }, u))),
        el("span", { text: "Likely range 2047 (P10–P90)" }), el("b", { text: `${f0(reqOf(u, Y47, "p10"))}–${f0(reqOf(u, Y47, "p90"))}` }),
        el("span", { text: "Share of India 2047" }), el("b", { text: pct(st.r1 / (u.level === "zone" ? ZONES.reduce((a, z) => a + zoneReq(z), 0) : themed.full), 1) })));
      const how = el("p", { class: "how" }, "How: India's national forecast is shared among states by population and income on the development ladder. ");
      const tl = el("button", { class: "n", type: "button", text: "Trace →" }); tl.addEventListener("click", () => Trace.open(u.level === "zone" ? "req.zone" : "req.state", u, false));
      how.appendChild(tl); rq.appendChild(how);
    }
    host.appendChild(rq);

    // generation by source
    const gs = el("div", { class: "sec" }, el("p", { class: "cap", text: "Generation by source · grid plan, TWh" }));
    const mx = Math.max.apply(null, sp.mix0.concat(sp.mix1).concat([1]));
    ORDER.forEach(k => {
      const v1 = sp.mix1[SI[k]], v0 = sp.mix0[SI[k]];
      if (v1 < 0.05 && v0 < 0.05) return;
      gs.appendChild(el("div", { class: "srcrow" }, el("span", { class: "nm" }, el("i", { style: { background: COL[k] } }), k),
        el("span", { class: "track" }, el("i", { style: { width: (v1 / mx * 100) + "%", background: COL[k] } }), el("u", { style: { left: `calc(${v0 / mx * 100}% - 1px)` } })),
        N(f0(v1), "gen.src", { level: u.level, name: u.name, src: k }), el("span", { class: "pc", text: pct(v1 / Math.max(sp.made1, 1e-9)) })));
    });
    gs.appendChild(el("div", { class: "legend2" }, el("span", null, el("i", { style: { background: "#8a94a3" } }), "2047 plan"), el("span", null, el("u"), "2025 actual"), el("span", { text: "click a number for why" })));
    const r = role(sp);
    gs.appendChild(el("div", { class: "kv", style: { marginTop: "12px" } },
      el("span", { text: "Generates 2047" }), el("b", null, N(f0(sp.made1), "made", u)),
      el("span", { text: "Grid need 2047" }), el("b", null, sp.hasNeed ? N(f0(sp.need1), "gridneed", u) : "n/a"),
      el("span", null, "Net flow ", r ? el("span", { class: "pill " + (sp.net >= 0 ? "up" : "down"), text: r }) : null), el("b", { class: sp.net >= 0 ? "up" : "down" }, sp.hasNeed ? N(signed(sp.net), "net", u) : "n/a")));
    host.appendChild(gs);

    // states in zone
    if (u.level === "zone") {
      const ss = el("div", { class: "sec" }, el("p", { class: "cap", text: "States · requirement 2047 · generation 2047" }));
      const g = el("div", { class: "states" });
      zoneStates(u.name).map(s => ({ s, r: stateReq(s), m: plan.state[s] ? plan.state[s].made1 : 0 })).sort((a, b) => (b.r || 0) - (a.r || 0)).forEach(o => {
        const b = el("button", { type: "button", text: o.s }); b.addEventListener("click", () => select({ level: "state", name: o.s }));
        g.append(b, el("span", { text: o.r != null ? f0(o.r) : "n/a" }), el("span", { text: f0(o.m) }));
      });
      ss.appendChild(g); host.appendChild(ss);
    } else {
      const lr = el("div", { class: "sec" }, el("p", { class: "cap", text: "Local resources (satellite)" }));
      lr.appendChild(el("div", { class: "kv" },
        el("span", { text: "Sunshine" }), el("b", { text: f2(info.ghi) + " kWh/m²·day" }),
        el("span", { text: "Wind at 50 m" }), el("b", { text: f1(info.wind50) + " m/s" }),
        el("span", { text: "Rainfall" }), el("b", { text: f0(info.precip) + " mm/yr" }),
        el("span", { text: "Open land · cropland · forest" }), el("b", { text: `${f0(info.open_pct)} · ${f0(info.crop_pct)} · ${f0(info.forest_pct)}%` })));
      host.appendChild(lr);
    }
  }

  // =====================================================================================
  // Trace drawer
  // =====================================================================================
  const stack = [];
  const drawer = document.getElementById("drawer"), scrim = document.getElementById("scrim");
  const drawerOpen = () => drawer.classList.contains("on");
  const Trace = {
    open(id, args, push) { if (!push) stack.length = 0; stack.push({ id, args }); this.render(); drawer.classList.add("on"); scrim.classList.add("on"); drawer.querySelector(".body").scrollTop = 0; Tip.hide(); },
    back() { if (stack.length > 1) { stack.pop(); this.render(); } },
    close() { drawer.classList.remove("on"); scrim.classList.remove("on"); stack.length = 0; },
    render() {
      const body = drawer.querySelector(".body"), top = stack[stack.length - 1], t = TR[top.id](top.args);
      drawer.querySelector("[data-back]").disabled = stack.length < 2;
      body.textContent = "";
      if (stack.length > 1) {
        const trail = el("div", { class: "trail" });
        stack.forEach((s, i) => {
          const name = TR[s.id](s.args).title;
          if (i < stack.length - 1) { const b = el("button", { type: "button", text: name }); b.addEventListener("click", () => { stack.length = i + 1; this.render(); }); trail.append(b, " › "); }
          else trail.append(el("span", { text: name }));
        });
        body.appendChild(trail);
      }
      body.appendChild(el("div", { class: "tv" }, el("h3", { text: t.title }),
        el("div", { class: "big" }, el("span", { class: "v", text: t.value }), el("span", { class: "u", text: t.unit || "" })),
        t.what ? el("p", { class: "what", text: t.what }) : null));
      if (t.formula) body.appendChild(el("div", { class: "tsec" }, el("p", { class: "cap", text: "How it is calculated" }), el("div", { class: "formula", text: t.formula })));
      if (t.inputs && t.inputs.length) {
        const g = el("div", { class: "inputs" });
        t.inputs.forEach(i => {
          if (i[4] && i[4].expand) {
            const b = el("button", { type: "button", class: "n more", text: i[0].trim(), title: "Show the rest" });
            b.addEventListener("click", e => { e.stopPropagation(); top.args.all = true; this.render(); });
            g.append(el("span", null, b), el("b", null, i[1]));
          } else {
            g.append(el("span", { text: i[0] }), el("b", null, i[2] ? N(i[1], i[2], i[3]) : i[1]));
          }
        });
        body.appendChild(el("div", { class: "tsec" }, el("p", { class: "cap", text: "Inputs · click to trace further" }), g));
      }
      if (t.data && t.data.length) {
        const sec = el("div", { class: "tsec" }, el("p", { class: "cap", text: "Data behind it" }));
        t.data.forEach(k => {
          const d = P.DS[k];
          sec.appendChild(el("div", { class: "ds" }, el("div", { class: "t", text: d.name }), el("div", { class: "m", text: d.who }),
            el("div", null, el("b", { text: "Used: " }), d.used), d.dropped && d.dropped !== "–" ? el("div", { class: "m" }, el("b", { text: "Dropped: " }), d.dropped) : null,
            el("div", null, "Raw file: ", el("code", { text: d.raw })),
            d.processed.length ? el("div", null, "Cleaned table: ", d.processed.map((p, i) => [i ? ", " : "", el("code", { text: p })])) : null,
            d.url ? el("div", null, el("a", { href: d.url, target: "_blank", rel: "noopener", text: d.url })) : null));
        });
        body.appendChild(sec);
      }
      if (t.code && t.code.length) body.appendChild(el("div", { class: "tsec" }, el("p", { class: "cap", text: "Code" }), el("div", { class: "code" }, t.code.map(c => el("div", null, el("code", { text: P.CODE[c].split(" – ")[0] }), " – " + (P.CODE[c].split(" – ")[1] || ""))))));
      if (t.check) body.appendChild(el("div", { class: "tsec" }, el("p", { class: "cap", text: "Check it yourself" }), el("div", { class: "code" }, el("code", { text: t.check[0] }), " → " + t.check[1])));
      if (t.note) body.appendChild(el("div", { class: "tsec" }, el("p", { class: "tnote", text: t.note })));
    },
  };
  drawer.querySelector("[data-back]").addEventListener("click", () => Trace.back());
  drawer.querySelector("[data-close]").addEventListener("click", () => Trace.close());
  scrim.addEventListener("click", () => Trace.close());
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { if (menuEl) closeMenu(); else if (drawerOpen()) Trace.close(); }
    if (e.key === "Backspace" && drawerOpen() && !/input|textarea/i.test(e.target.tagName)) { e.preventDefault(); Trace.back(); }
  });

  const settingsText = () => `${NEED[S.need][0]} need (${NEED[S.need][1]}) · ${STRAT[S.carbon]} (₹${f0(S.carbon)}/t CO₂) · solar on ${S.land}% of open land · wind ${S.wind === 1 ? "as measured" : "doubled"} · new coal ${S.coal ? "allowed" : "none"} · build pace ${S.pace ? "faster" : "as demonstrated"}`;
  const yname = yi => YEARS5[yi];
  function hindcastErrors() {
    const hc = F.hindcast, err = { india: [], ladder: [], panel: [] };
    Object.keys(hc.pred).forEach(o => ["india", "ladder", "panel"].forEach(l => {
      const p = hc.pred[o][l]; if (!p) return;
      hc.years[o].forEach((y, i) => { if (y > +o && hc.actual[y]) err[l].push(Math.log(p[i] / hc.actual[y])); });
    }));
    const rmse = {}; Object.keys(err).forEach(l => { rmse[l] = Math.sqrt(err[l].reduce((a, v) => a + v * v, 0) / Math.max(err[l].length, 1)); });
    return rmse;
  }

  const TR = {
    "req.nat"() {
      if (!themed.active) return TR["req.base"]();
      const ins = [["Baseline forecast (no themes)", f0(themed.basePlain[LAST]) + " TWh", "req.base"]];
      Object.keys(themed.wedges.by).forEach(id => ins.push([TH.BY[id].name, signed(themed.wedges.by[id][LAST]) + " TWh", "theme", { id }]));
      if (TH.gasOn(S.themes)) ins.push(["Oil and gas find (faster GDP growth)", signed(themed.base[LAST] - themed.basePlain[LAST]) + " TWh", "theme", { id: "oilgas" }]);
      if (themed.dedicated > 0.5) ins.push(["of which dedicated hydrogen plants (off-grid)", f0(themed.dedicated) + " TWh"]);
      return { title: "India's requirement in 2047, with themes", value: f0(themed.full), unit: "TWh",
        what: "The baseline forecast plus each theme you switched on. Each of 1,000 simulated futures also gets a random theme size (±30%) and timing (±2.5 years); this is the " + NEED[S.need][1] + " of those futures.",
        formula: `requirement = ${NEED[S.need][1]} over 1,000 futures of\n  (baseline future + Σ theme wedges)\n= ${f0(themed.full)} TWh`,
        inputs: ins, data: ["owid", "wb", "assume"], code: ["montecarlo", "themes"] };
    },
    "req.base"() {
      const q = S.need, v = F.fan.ensemble[q][LAST], W = F.lens.weights;
      return { title: "India's requirement in 2047", value: f0(v), unit: "TWh",
        what: `All electricity India must generate in 2047, including industry's own (captive) plants. This is the ${NEED[q][1]} of 4,000 simulated futures.`,
        formula: `requirement 2047 = ${NEED[q][1]} of 4,000 simulated futures\n\neach future:\n  1. draw GDP growth, population, urban share\n  2. pick ONE view, with probability = its weight\n       India's own past  ${pct(W.india)}  → ${f0(F.fan.india[q][LAST])} TWh (its ${NEED[q][1]})\n       Peer countries    ${pct(W.ladder)}  → ${f0(F.fan.ladder[q][LAST])} TWh\n       Global snapshot   ${pct(W.panel)}  → ${f0(F.fan.panel[q][LAST])} TWh\n  3. kWh per person × population → TWh\n\n= ${f0(v)} TWh  (${f1(v / F.base_twh)}× 2025)`,
        inputs: [["Generation in 2025", f0(F.base_twh) + " TWh", "base.nat"],
          ["View 1 · India's own past", f0(F.fan.india[q][LAST]) + " TWh", "lens", { k: "india" }],
          ["View 2 · Peer countries", f0(F.fan.ladder[q][LAST]) + " TWh", "lens", { k: "ladder" }],
          ["View 3 · Global snapshot", f0(F.fan.panel[q][LAST]) + " TWh", "lens", { k: "panel" }],
          ["Weights 16 / 34 / 50%", "back-tested", "weights"],
          ["GDP per person 2047 (median)", "$" + f0(F.drivers_2047_median.gdp_pc_ppp), "drv.gdp"],
          ["Population 2047 (median)", f2(F.drivers_2047_median.population / 1e9) + " bn", "drv.pop"],
          ["Urban share 2047 (median)", f1(F.drivers_2047_median.urban_share_pct) + "%", "drv.urban"]],
        data: ["owid", "wb", "assume"], code: ["lenses", "weights", "montecarlo"],
        check: ["outputs/forecast_national.csv", `series = ensemble, year = 2047, ${q}_twh = ${f1(v)}`],
        note: "Generation only: installed capacity and consumption are never used. The views disagree (4,448 to 6,102 TWh at the median), which is why we blend them and report a range." };
    },
    "req.range"() {
      return { title: "Likely range for 2047", value: `${f0(themed.band.p10[LAST])}–${f0(themed.band.p90[LAST])}`, unit: "TWh",
        what: "80% of simulated futures land in this range (10th to 90th percentile).",
        formula: `P10 = 10th percentile of the futures = ${f0(themed.band.p10[LAST])} TWh\nP90 = 90th percentile of the futures = ${f0(themed.band.p90[LAST])} TWh\n\nwidth comes from: GDP growth ±${f1(F.assumptions.growth_sd_pts)} pts a year,\npopulation ±${pct(F.assumptions.population_sd, 1)}, urban share ${F.assumptions.urban_2047_triangle_pct[0]}–${F.assumptions.urban_2047_triangle_pct[2]}%,\nmodel parameter uncertainty and disagreement between the three views`,
        inputs: [["Median", f0(themed.full) + " TWh", "req.nat"], ["GDP growth path", "6.5% → 5%", "drv.gdp"], ["Population", "±1.5%", "drv.pop"], ["Urban share", "41–50%", "drv.urban"]],
        data: ["wb", "owid", "assume"], code: ["montecarlo"], check: ["outputs/forecast_national.csv", "series = ensemble, year = 2047, p10_twh / p90_twh"] };
    },
    "base.nat"() {
      const b = D.compliance.utility_bridge, last = b[b.length - 1];
      return { title: "India's generation in 2025", value: f1(F.base_twh), unit: "TWh",
        what: "Measured, not modelled: all electricity generated in India in 2025, including captive plants. This is where every forecast path starts.",
        formula: `2025 total = Σ sources (coal, gas, nuclear, hydro, wind, solar, bioenergy, other)\n= ${f1(F.base_twh)} TWh\n\ngrid (utility) part ≈ ${pct(F.utility_share, 1)} of total (average of the last 3 years)`,
        inputs: ["Coal", "Hydro", "Solar", "Wind", "Nuclear", "Gas"].map(k => [k + " 2025", f0(F.history[k][F.history.years.length - 1]) + " TWh"]).concat([["Utility share " + last.year, pct(last.utility_share, 1)]]),
        data: ["owid", "ember", "npp"], code: ["profiles", "compliance"], check: ["data/processed/generation_national_history.csv", "year = 2025, Total"],
        note: "Ember/CEA cover only the grid; Our World in Data includes captive plants. We forecast the total and plan supply for the grid share." };
    },
    lens(a) {
      const k = a.k, q = S.need, v = F.fan[k][q][LAST];
      if (k === "india") return { title: "View 1 · India's own past", value: f0(v), unit: "TWh in 2047",
        what: "How India's generation per person has tracked its income since 1990, carried forward along the projected income path.",
        formula: `time-series regression (GLS with AR(1) errors), India 1990–2025\n\nln(kWh per person) = a + ${f2(F.india_lens.elasticity)} × ln(GDP per person)\nerrors: ρ = ${f2(F.india_lens.rho)} (each year's miss carries into the next)\n\n→ 1% more income ≈ ${f2(F.india_lens.elasticity)}% more generation per person`,
        inputs: [["Income elasticity", f2(F.india_lens.elasticity) + " ± " + f2(F.india_lens.se)], ["AR(1) ρ", f2(F.india_lens.rho)], ["Weight in the blend", pct(F.lens.weights.india), "weights"], ["GDP per person 2047", "$" + f0(F.drivers_2047_median.gdp_pc_ppp), "drv.gdp"]],
        data: ["owid", "wb"], code: ["lenses"], check: ["outputs/model_parameters.json", "india_lens"] };
      if (k === "ladder") return { title: "View 2 · Peer countries (development ladder)", value: f0(v), unit: "TWh in 2047",
        what: `What happened to generation in ${F.ladder_lens.n_countries} countries over 10-year windows once they reached each income level. India climbs the same ladder as its income rises.`,
        formula: `for ${f0(F.ladder_lens.n_windows)} ten-year windows (income grew ≥ 22%):\n  elasticity = Δ ln(kWh per person) ÷ Δ ln(GDP per person)\nmedian per income band → smooth curve\nbootstrapped 300× for uncertainty\n\n` + F.ladder_curve.map(r => `  $${r.band.replace(/[()\]]/g, "").replace(", ", "–")}  ${f2(r.elasticity_median)}  (${r.n_countries} countries)`).join("\n"),
        inputs: [["Countries", f0(F.ladder_lens.n_countries)], ["Ten-year windows", f0(F.ladder_lens.n_windows)], ["Weight in the blend", pct(F.lens.weights.ladder), "weights"]],
        data: ["owid", "wb"], code: ["lenses"], check: ["outputs/ladder_curve.csv", "elasticity_median by income band"],
        note: "Elasticity falls from about 1.1 to 0.5 as countries pass $15,000 per person: growth in electricity slows as economies mature." };
      const b = F.panel_lens;
      return { title: "View 3 · Global snapshot (152-country panel)", value: f0(v), unit: "TWh in 2047",
        what: "How much more electricity richer and more urban countries generate per person, comparing 152 countries over time. The only view that reads urbanisation directly.",
        formula: `panel regression with country fixed effects (OLS, clustered errors)\n\nln(kWh per person) = ${f2(b.ln_income)}·ln y ${b.ln_income_sq < 0 ? "−" : "+"} ${f2(Math.abs(b.ln_income_sq))}·(ln y)² + ${f2(b.urban_share)}·urban + country effect\n\nincome elasticity: ${f2(b.income_elasticity_at_10k)} at $10k, ${f2(b.income_elasticity_at_30k)} at $30k`,
        inputs: [["ln income", f2(b.ln_income) + " ± " + f2(b.se[0])], ["(ln income)²", f2(b.ln_income_sq) + " ± " + f2(b.se[1])], ["Urban share", f2(b.urban_share) + " ± " + f2(b.se[2])], ["Countries", f0(b.n_countries)],
          ["Weight in the blend", pct(F.lens.weights.panel), "weights"], ["Urban share 2047", f1(F.drivers_2047_median.urban_share_pct) + "%", "drv.urban"]],
        data: ["owid", "wb"], code: ["lenses"], check: ["outputs/model_parameters.json", "panel_lens"] };
    },
    weights() {
      const r = hindcastErrors(), W = F.lens.weights;
      return { title: "How the three views are weighted", value: `${pct(W.india)} / ${pct(W.ladder)} / ${pct(W.panel)}`, unit: "",
        what: "Back-test: we refit each view as if standing in 2005, 2010 and 2015, forecast up to 2025, and compare with what actually happened. Views that missed less get more weight.",
        formula: `weight ∝ 1 / (mean squared log error)\ncapped at 50% for any single view\n\nback-test error (root mean square):\n  India's own past  ${pct(r.india, 1)}  → ${pct(W.india)}\n  Peer countries    ${pct(r.ladder, 1)}  → ${pct(W.ladder)}\n  Global snapshot   ${pct(r.panel, 1)}  → ${pct(W.panel)} (cap)`,
        inputs: [["View 1", pct(W.india), "lens", { k: "india" }], ["View 2", pct(W.ladder), "lens", { k: "ladder" }], ["View 3", pct(W.panel), "lens", { k: "panel" }]],
        data: ["owid", "wb"], code: ["weights"], check: ["outputs/hindcast.csv", "predicted_twh vs actual_twh by origin and view"] };
    },
    "drv.gdp"() {
      return { title: "GDP growth assumption", value: "6.5% → 5%", unit: "a year",
        what: "Real GDP growth starts near India's recent trend and eases as the economy gets richer. Each simulated future shifts the whole path up or down.",
        formula: `base path: ${F.scenarios.Base[0]}% in 2026 → ${F.scenarios.Base[1]}% in 2047\nper future: + N(0, ${f1(F.assumptions.growth_sd_pts)} pts), clipped at ±2 pts\ntested: Slow ${F.scenarios.Slow.join("→")}%, Viksit Bharat ${F.scenarios["Viksit Bharat"].join("→")}%\n\nmedian GDP per person 2047 = $${f0(F.drivers_2047_median.gdp_pc_ppp)} (PPP)\n2025: $${f0(F.gdp_pc_base)}`,
        data: ["wb", "assume"], code: ["montecarlo"], note: "GDP growth is the biggest single source of uncertainty in the forecast." };
    },
    "drv.pop"() {
      return { title: "Population assumption", value: f2(F.drivers_2047_median.population / 1e9), unit: "billion in 2047",
        what: "World Bank projection for India, with a small uncertainty in each simulated future.",
        formula: `population path = World Bank projection\nper future: × N(1, ${pct(F.assumptions.population_sd, 1)})\n2025: ${f2(F.population[0] / 1e9)} bn → 2047: ${f2(F.population[LAST] / 1e9)} bn`, data: ["wb"], code: ["montecarlo"] };
    },
    "drv.urban"() {
      const t = F.assumptions.urban_2047_triangle_pct;
      return { title: "Urbanisation assumption", value: f1(F.drivers_2047_median.urban_share_pct), unit: "% urban in 2047 (median)",
        what: "Share of people living in cities. Estimates disagree, partly over the definition of 'urban', so each future draws a value.",
        formula: `2047 urban share ~ triangular(low ${t[0]}%, mode ${t[1]}% (World Bank), high ${t[2]}%)\n2025: ${f1(F.urban[0])}%`, data: ["wb", "assume"], code: ["montecarlo"],
        note: "Used directly by View 3 (Global snapshot): more urban → more generation per person at the same income." };
    },
    "kpi.growth"() {
      const cagr = Math.pow(themed.full / F.base_twh, 1 / 22) - 1;
      return { title: "Growth to 2047", value: f2(themed.full / F.base_twh) + "×", unit: "",
        formula: `${f0(themed.full)} ÷ ${f0(F.base_twh)} = ${f2(themed.full / F.base_twh)}×\nper year: (${f2(themed.full / F.base_twh)})^(1/22) − 1 = ${pct(cagr, 1)}`,
        inputs: [["Requirement 2047", f0(themed.full) + " TWh", "req.nat"], ["Generation 2025", f0(F.base_twh) + " TWh", "base.nat"]] };
    },
    "req.zone"(a) {
      const z = a.name, yi = a.yi == null ? Y47 : a.yi, v = zoneReq(z, yi), st = zoneStates(z).filter(s => stateReq(s, yi) != null).sort((x, y) => stateReq(y, yi) - stateReq(x, yi));
      const ins = [["India's requirement " + yname(yi), f0(natReq(yi)) + " TWh", "req.nat"], [`${z} share of India ${yname(yi)}`, pct(shareOf(z, yi), 1)], [`${z} share in 2025`, pct(shareOf(z, 0), 1)]];
      const shown = a.all ? st.length : 4;
      st.slice(0, shown).forEach(s => ins.push([`  ${s}`, f0(stateReq(s, yi)) + " TWh", "req.state", { level: "state", name: s, yi }]));
      if (st.length > shown) ins.push([`  + ${st.length - shown} more states`, f0(st.slice(shown).reduce((a2, s) => a2 + stateReq(s, yi), 0)) + " TWh", null, null, { expand: true }]);
      if (themed.active && yi === Y47) ins.push(["Theme effect landing in this zone", signed(themeZoneDelta(z)) + " TWh", "req.nat"]);
      return { title: `${z} zone · requirement ${yname(yi)}`, value: f0(v), unit: "TWh",
        what: "The national forecast shared among states, then added up for the zone. Poorer, faster-growing states climb the development ladder faster, so their share rises.",
        formula: `for each state s in the zone:\n  weight_s = population_s × kWh-per-person at state's own income\n             (same development ladder as View 2;\n              state income converges at β = ${f2(F.state_convergence.beta * 100)}% a year)\n  share_s  = weight_s ÷ Σ all states\n  need_s   = India requirement × share_s\nzone = Σ need_s, median over 600 simulated futures\n\n${z} ${yname(yi)}: ${f0(v)} TWh (${pct(shareOf(z, yi), 1)} of India)` + (yi === Y47 ? `\nlikely range ${f0(zoneReq(z, Y47, "p10"))}–${f0(zoneReq(z, Y47, "p90"))} TWh` : ""),
        inputs: ins, data: ["org", "wb", "owid"], code: ["split"], check: ["outputs/requirement_by_zone.csv", `zone = ${z}, year = ${yname(yi)}, ${S.need}_twh`],
        note: "Each zone's median is computed on its own, so the six zone medians add to slightly more than India's median (medians do not add exactly). Next: add industry share, state urbanisation, cooling need and where each theme lands." };
    },
    "req.state"(a) {
      const s = a.name, yi = a.yi == null ? Y47 : a.yi, v = stateReq(s, yi), info = R.state[s];
      if (v == null) return { title: s, value: "n/a", unit: "", what: "Not in the organisers' state file (no population or GSDP), so it has no requirement estimate. Its generation is still in the supply plan." };
      return { title: `${s} · requirement ${yname(yi)}`, value: f0(v), unit: "TWh",
        what: "This state's slice of the national forecast, from its population and its own position on the development ladder.",
        formula: `need = India requirement × state share\nshare ∝ population × kWh-per-person at state income\n\npopulation ${f0(info.population_m[0])} m (2025) → ${info.population_m[1] ? f0(info.population_m[1]) : "–"} m (2047)\nincome = ${f2(info.income_relative)}× the India average in 2025\n= ${f0(v)} TWh (${pct(v / natReq(yi), 2)} of India)`,
        inputs: [["India's requirement " + yname(yi), f0(natReq(yi)) + " TWh", "req.nat"], ["Population 2047", info.population_m[1] ? f0(info.population_m[1]) + " m" : "–"], ["Income vs India avg", f2(info.income_relative) + "×"],
          ["Zone total", f0(zoneReq(info.zone, yi)) + " TWh", "req.zone", { level: "zone", name: info.zone, yi }]],
        data: ["org", "wb", "owid"], code: ["split"], check: ["outputs/requirement_by_state.csv", `state = ${s}, year = ${yname(yi)}, ${S.need}_twh`] };
    },
    "gen.src"(a) {
      const u = { level: a.level, name: a.name }, k = a.src, sp = supply(u), v = sp.mix1[SI[k]], v0 = sp.mix0[SI[k]];
      const members = u.level === "zone" ? zoneStates(u.name) : [u.name];
      const keys = k === "Coal" ? ["Coal_existing", "Coal_new"] : [k], tally = {};
      members.forEach(m => { const mv = plan.state[m] ? plan.state[m].y47[SI[k]] : 0; keys.forEach(kk => { const r = plan.reasons[m] && plan.reasons[m][kk]; if (r) tally[r] = (tally[r] || 0) + Math.max(mv, 0.01); }); });
      const reasons = Object.keys(tally).sort((x, y) => tally[y] - tally[x]);
      const ren = ["Solar", "Wind", "Hydro"].includes(k);
      const ceil = ren ? members.reduce((acc, m) => acc + Math.max(R.state[m].ceiling[k] * plan.ceilingScale[k], plan.state[m] ? plan.state[m].y47[SI[k]] : 0), 0) : null;
      const ins = [["2025 actual", f0(v0) + " TWh", "gen.base", a]];
      if (ren) ins.push(["Resource ceiling (satellite)", f0(ceil) + " TWh", "ceiling", a]);
      ins.push(["Why (optimiser)", reasons[0] || "–"]);
      if (u.level === "zone") members.map(m => ({ m, v: plan.state[m] ? plan.state[m].y47[SI[k]] : 0 })).filter(o => o.v > 0.5).sort((x, y) => y.v - x.v).slice(0, 4)
        .forEach(o => ins.push(["  " + o.m, f0(o.v) + " TWh", "gen.src", { level: "state", name: o.m, src: k }]));
      ins.push(["Carbon price", "₹" + f0(S.carbon) + "/t"], ["Emission factor", f2(O.emission_factors[k]) + " t/MWh", "kpi.em"]);
      return { title: `${uname(u)} · ${k} 2047`, value: f0(v), unit: "TWh",
        what: `Chosen by the least-cost optimiser for the ${u.level}, under: ${settingsText()}.`,
        formula: `optimiser (linear programme, every state × month × milestone):\n  minimise  generation cost + storage + transfers\n            + carbon price × CO₂\n  subject to  monthly need met in every zone\n              solar, wind, hydro ≤ satellite ceiling\n              new build ≤ India's demonstrated pace\n              coal fleet ages from 2035\n\n${k} in ${u.name}: ${f0(v0)} (2025) → ${f0(v)} TWh (2047)\nmain reason: ${reasons[0] || "–"}`,
        inputs: ins, data: ren ? ["ember", "nasa", "modis", "srtm", "assume"] : ["ember", "npp", "assume"], code: ren ? ["optimiser", "ceilings"] : ["optimiser", "profiles"],
        check: [u.level === "zone" ? "outputs/mix_zone_source.csv" : "outputs/mix_state_source.csv", "default settings only (Balanced, central need, 3% land)"],
        note: reasons.length > 1 ? "Reasons across states: " + reasons.join("; ") + "." : null };
    },
    "gen.base"(a) {
      const u = { level: a.level, name: a.name }, v = supply(u).mix0[SI[a.src]];
      return { title: `${uname(u)} · ${a.src} 2025`, value: f1(v), unit: "TWh",
        what: "Measured generation in 2025 from the state-by-fuel records. The supply plan starts from here.",
        formula: `Σ over months and states in ${u.name} of ${a.src} generation (GWh) ÷ 1,000`, data: ["ember", "npp"], code: ["profiles"], check: ["data/processed/base_mix_state.csv", `source = ${a.src}`] };
    },
    ceiling(a) {
      const members = a.level === "zone" ? zoneStates(a.name) : [a.name], k = a.src;
      const v = members.reduce((acc, m) => acc + R.state[m].ceiling[k] * plan.ceilingScale[k], 0);
      const area = members.reduce((acc, m) => acc + R.state[m].area_km2, 0), w = f => members.reduce((acc, m) => acc + R.state[m][f] * R.state[m].area_km2, 0) / area;
      const how = k === "Solar" ? `usable land × sunshine × panel efficiency × packing\nusable land = ${S.land}% of open land + 0.3% of cropland + 5% of urban\nsunshine ≈ ${f2(w("ghi"))} kWh/m² a day (NASA POWER)\nopen land ≈ ${f1(w("open_pct"))}% of area (MODIS)`
        : k === "Wind" ? `usable land in windy cells × wind-farm energy density × (wind speed)³\n5% of open land + 3% of cropland in windy cells\nwind ≈ ${f1(w("wind50"))} m/s at 50 m (NASA POWER)` + (S.wind === 2 ? "\n× 2 (setting: doubled)" : "")
        : `rainfall × relief (gross runoff energy)\n× share that developed states convert today\nrain ≈ ${f0(w("precip"))} mm a year (NASA POWER), terrain from SRTM`;
      return { title: `${a.level === "zone" ? a.name + " zone" : a.name} · ${k} ceiling`, value: f0(v), unit: "TWh a year",
        what: "The most this region could physically generate from this resource, from satellite land, sun, wind and rain. Not installed capacity.",
        formula: how + `\n\nterrain: steep or very high land excluded\n= ${f0(v)} TWh a year`, data: ["nasa", "modis", "srtm", "geo", "assume"], code: ["ceilings"], check: ["data/processed/resources_state.csv", `${k.toLowerCase()}_ceiling_twh`] };
    },
    made(a) {
      const u = { level: a.level, name: a.name }, sp = supply(u);
      return { title: `${uname(u)} · generation 2047`, value: f0(sp.made1), unit: "TWh",
        formula: `Σ sources chosen by the optimiser + bioenergy and other (held at 2025)\n= ${ORDER.map(k => f0(sp.mix1[SI[k]])).join(" + ")} + ${f0(sp.fixed)}\n= ${f0(sp.made1)} TWh`,
        inputs: ORDER.filter(k => sp.mix1[SI[k]] > 0.05).map(k => [k, f0(sp.mix1[SI[k]]) + " TWh", "gen.src", { level: u.level, name: u.name, src: k }]).concat([["Bioenergy and other", f0(sp.fixed) + " TWh"]]),
        data: ["ember", "nasa", "modis", "assume"], code: ["optimiser"] };
    },
    gridneed(a) {
      const u = { level: a.level, name: a.name }, sp = supply(u), tot = plan.total[Y47];
      const share = a.level === "zone" ? R.zone_need_share[a.name][Y47] : R.state[a.name].need_share[Y47];
      return { title: `${uname(u)} · grid need 2047`, value: f0(sp.need1), unit: "TWh",
        what: "The part of this region's need the grid plan must serve: its share of India's grid generation.",
        formula: `grid need = region share × India grid generation 2047\n= ${pct(share, 2)} × ${f0(tot)} TWh = ${f0(sp.need1)} TWh\n\nIndia grid generation = grid share (≈ ${pct(F.utility_share)}) of the requirement,\nplus storage losses the plan has to cover`,
        inputs: [["Region share 2047", pct(share, 2), a.level === "zone" ? "req.zone" : "req.state", u], ["India grid generation 2047", f0(tot) + " TWh"], ["India requirement 2047", f0(themed.full) + " TWh", "req.nat"]],
        data: ["org", "wb", "ember"], code: ["split", "optimiser"] };
    },
    net(a) {
      const u = { level: a.level, name: a.name }, sp = supply(u);
      return { title: `${uname(u)} · net flow 2047`, value: signed(sp.net), unit: "TWh",
        what: sp.net >= 0 ? "Generates more than its own grid need and sends the rest to other regions." : "Generates less than its own grid need and brings in the rest from other regions.",
        formula: `net = generation − grid need\n= ${f0(sp.made1)} − ${f0(sp.need1)} = ${signed(sp.net)} TWh`,
        inputs: [["Generation 2047", f0(sp.made1) + " TWh", "made", u], ["Grid need 2047", f0(sp.need1) + " TWh", "gridneed", u]], code: ["optimiser"],
        note: "Transfers between zones carry a cost of ₹" + f2(O.assumptions.transfer_cost) + "/kWh in the optimiser, so it only moves power when the sending region is clearly cheaper." };
    },
    "kpi.clean"() {
      const s = plan.summary[Y47], n = plan.nat[Y47];
      return { title: "Clean share of generation, 2047", value: pct(s.clean, 1), unit: "",
        formula: `clean = 1 − (coal + gas + other) ÷ total grid generation\n= 1 − (${f0(n[SI.Coal])} + ${f0(n[SI.Gas])} + ${f1(R.fixed_national.Other)}) ÷ ${f0(s.gen)}\n= ${pct(s.clean, 1)}\n\n2025: ${pct(plan.summary[0].clean, 1)}`,
        inputs: ORDER.map(k => [k + " 2047", f0(n[SI[k]]) + " TWh"]), data: ["ember", "assume"], code: ["optimiser"], note: "Settings: " + settingsText() + "." };
    },
    "kpi.coal"() {
      const c0 = plan.nat[0][SI.Coal], c1 = plan.nat[Y47][SI.Coal];
      return { title: "Coal generation, 2047", value: f0(c1), unit: "TWh",
        formula: `Σ zones of coal chosen by the optimiser\n2025: ${f0(c0)} TWh → 2047: ${f0(c1)} TWh (${signed(c1 - c0)})`,
        inputs: ZONES.map(z => [z, f0(plan.zone[Y47][z][SI.Coal]) + " TWh", "gen.src", { level: "zone", name: z, src: "Coal" }]),
        data: ["ember", "assume"], code: ["optimiser"], note: "Coal falls only as fast as solar land, wind ceilings and build pace allow clean sources to replace it. Try SOLAR LAND 5% and BUILD PACE Faster." };
    },
    "kpi.em"() {
      const n = plan.nat[Y47], s = plan.summary[Y47], ef = O.emission_factors;
      return { title: "CO₂ from power generation, 2047", value: f0(s.em), unit: "Mt CO₂",
        formula: `CO₂ = Σ generation × emission factor\n` + ORDER.map(k => `  ${k.padEnd(8)} ${f0(n[SI[k]]).padStart(6)} TWh × ${f2(ef[k])} t/MWh`).join("\n") + `\n  + bioenergy and other\n= ${f0(s.em)} Mt  (${f0(s.intensity)} g per kWh)`,
        inputs: ORDER.map(k => [k + " factor", f2(ef[k]) + " t/MWh"]), data: ["ember"], code: ["profiles"], check: ["data/processed/emission_factors.csv", "tco2_per_mwh = Ember power-sector emissions ÷ generation"] };
    },
    "kpi.cost"() {
      const s = plan.summary[Y47], a = O.assumptions;
      return { title: "Average cost of supply, 2047", value: "₹" + f2(s.cost), unit: "per kWh",
        what: "Resource cost of the plan. The carbon price steers the choice of sources but is not included in this cost.",
        formula: `average cost = (generation cost + storage cost + transfer cost) ÷ need\ntransfer cost = ₹${f2(a.transfer_cost)}/kWh moved between zones\nstorage shifts ${f0(s.shift)} TWh a year in 2047\nunmet need: ${f0(s.uns)} TWh`,
        data: ["assume"], code: ["optimiser"], note: "Costs are our stated estimates (src/optimise.py, Params) and are varied in the sensitivity runs." };
    },
    theme(a) {
      const c = TH.BY[a.id], t = S.themes[a.id];
      if (a.id === "oilgas") return { title: c.name, value: signed(themed.base[LAST] - themed.basePlain[LAST]), unit: "TWh by 2047",
        what: c.story, formula: `adds ${f2(c.gdp_boost_pts[t.value])} pts to GDP growth each year ${c.gdp_boost_years[0]}–${c.gdp_boost_years[1]}\n→ more income → more generation through the three views\nalso lets the optimiser use cheap domestic gas`, data: ["assume"], code: ["themes"] };
      const v = themed.wedges.by[a.id] ? themed.wedges.by[a.id][LAST] : 0;
      return { title: c.name, value: signed(v), unit: "TWh by 2047", what: c.story,
        formula: c.negative ? `saves ${t.value}% of the requirement by 2047 (S-curve from 2025)` :
          `driver: ${c.driver}\n${c.today} ${c.unit} (${c.today_year}) → ${t.value} ${c.unit} (2047), S-curve, ${t.timing} timing\n× ${c.conversion} TWh per ${c.unit === "TWh" ? "TWh" : "unit"}${c.in_baseline ? `\n− ${pct(c.in_baseline)} already in the baseline trend` : ""}\n= ${signed(v)} TWh`,
        inputs: [["Setting", `${t.value} ${c.unit}`], ["Timing", t.timing]], data: ["assume"], code: ["themes"],
        note: c.conversion_note || "Theme sizes are our assumptions; published studies were used only to choose a sensible scale and are never model inputs." };
    },
  };

  // =====================================================================================
  // Shell
  // =====================================================================================
  function render() {
    Tip.hide();
    buildBar();
    renderTicker();
    renderLeft();
    renderMap();
    renderRight();
  }
  // keyboard: arrows move through zones when nothing else has focus
  document.addEventListener("keydown", e => {
    if (drawerOpen() || menuEl || /input|textarea|select/i.test(e.target.tagName)) return;
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && S.sel.level === "zone") {
      e.preventDefault();
      const i = ZONES.indexOf(S.sel.name), j = (i + (e.key === "ArrowDown" ? 1 : -1) + ZONES.length) % ZONES.length;
      select({ level: "zone", name: ZONES[j] });
    }
  });
  let rt = 0;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { closeMenu(); }, 100); });
  update();
})();
