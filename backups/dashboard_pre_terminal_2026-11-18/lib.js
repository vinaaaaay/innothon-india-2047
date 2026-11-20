/* Small DOM + SVG chart helpers. No dependencies. Labels always go in through textContent. */
(function () {
  "use strict";
  const SVGNS = "http://www.w3.org/2000/svg";

  function setAttrs(e, attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "text") e.textContent = v;
      else if (k === "style" && typeof v === "object") Object.assign(e.style, v);
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
  }
  function add(e, kids) {
    kids.forEach(k => {
      if (k == null || k === false) return;
      if (Array.isArray(k)) add(e, k);
      else e.appendChild(typeof k === "object" ? k : document.createTextNode(String(k)));
    });
    return e;
  }
  const el = (tag, attrs, ...kids) => { const e = document.createElement(tag); setAttrs(e, attrs || {}); return add(e, kids); };
  const sv = (tag, attrs, ...kids) => { const e = document.createElementNS(SVGNS, tag); setAttrs(e, attrs || {}); return add(e, kids); };

  // ---- numbers ----------------------------------------------------------------
  const nf = d => new Intl.NumberFormat("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
  const NF = [nf(0), nf(1), nf(2)];
  const f0 = v => (v == null || !isFinite(v)) ? "–" : NF[0].format(Math.abs(v) < 0.5 ? 0 : v);
  const f1 = v => (v == null || !isFinite(v)) ? "–" : NF[1].format(v);
  const f2 = v => (v == null || !isFinite(v)) ? "–" : NF[2].format(v);
  const pct = (v, d) => (v == null || !isFinite(v)) ? "–" : (d ? NF[d].format(v * 100) : NF[0].format(v * 100)) + "%";
  const signed = v => (Math.abs(v) < 0.5 ? "" : v > 0 ? "+" : "−") + f0(Math.abs(v));

  function ticks(lo, hi, count) {
    const span = hi - lo || 1, raw = span / Math.max(1, count), mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) || 10 * mag;
    const out = [];
    for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-6; v += step) out.push(Math.round(v / step) * step + 0);
    return out;
  }
  const niceMax = (v, count) => { const t = ticks(0, v, count || 5), s = t[1] - t[0]; return Math.ceil(v / s - 1e-9) * s; };

  // ---- tooltip ------------------------------------------------------------------
  const tipEl = () => document.getElementById("tip");
  const Tip = {
    show(x, y, c) {
      const t = tipEl();
      t.textContent = "";
      if (c.title) t.appendChild(el("div", { class: "t-title", text: c.title }));
      (c.rows || []).forEach(r => {
        const key = el("span", { class: "t-key" }, r.color ? el("i", { style: { borderColor: r.color, borderTopStyle: r.dash ? "dashed" : "solid" } }) : null, r.label);
        t.appendChild(el("div", { class: "t-row" + (r.on ? " on" : "") }, key, el("b", { text: r.value })));
      });
      if (c.note) t.appendChild(el("div", { class: "t-note", text: c.note }));
      t.style.display = "block";
      const w = t.offsetWidth, h = t.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
      let left = x + 14, top = y + 14;
      if (left + w > vw - 8) left = x - w - 14;
      if (left < 8) left = 8;
      if (top + h > vh - 8) top = Math.max(8, y - h - 14);
      t.style.left = left + "px";
      t.style.top = top + "px";
    },
    hide() { const t = tipEl(); if (t) t.style.display = "none"; }
  };
  /** Same tooltip on hover and on keyboard focus. */
  function hoverable(node, content, onEnter, onLeave) {
    node.setAttribute("tabindex", "0");
    node.addEventListener("pointermove", e => { Tip.show(e.clientX, e.clientY, content()); if (onEnter) onEnter(); });
    node.addEventListener("pointerleave", () => { Tip.hide(); if (onLeave) onLeave(); });
    node.addEventListener("focus", () => { const r = node.getBoundingClientRect(); Tip.show(r.left + r.width / 2, r.top + r.height / 2, content()); if (onEnter) onEnter(); });
    node.addEventListener("blur", () => { Tip.hide(); if (onLeave) onLeave(); });
    return node;
  }

  function legend(items) {
    return el("div", { class: "legend" }, items.map(it =>
      el("span", null, el("i", { class: it.kind && it.kind !== "rect" ? it.kind : null,
        style: it.kind === "line" || it.kind === "dash" || it.kind === "ring" ? { borderColor: it.color } : it.kind === "band" ? null : { background: it.color } }), it.label)));
  }

  function frame(host, height, m) {
    const W = Math.max(280, host.clientWidth || 600), H = height;
    host.textContent = "";
    const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
    const g = sv("g", { transform: `translate(${m.l},${m.t})` });
    svg.appendChild(g);
    host.appendChild(svg);
    return { svg, g, W, H, iw: W - m.l - m.r, ih: H - m.t - m.b, m };
  }
  function yAxis(fr, y, tks, fmt, title) {
    tks.forEach(t => {
      fr.g.appendChild(sv("line", { class: t === 0 ? "baseline" : "gridline", x1: 0, x2: fr.iw, y1: y(t), y2: y(t) }));
      fr.g.appendChild(sv("text", { x: -8, y: y(t) + 3.5, "text-anchor": "end", text: fmt(t) }));
    });
    if (title) fr.g.appendChild(sv("text", { x: -fr.m.l + 2, y: -6, text: title }));
  }
  const topRound = (x, y, w, h, r) => {
    r = Math.min(r, h, w / 2);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  };

  /** Stacked bars. series are bottom-to-top. opt.overlay draws a marker line per category (e.g. the requirement). */
  function stackedBars(host, opt) {
    const n = opt.cats.length, unit = opt.unit || "TWh", fmt = opt.fmt || f0;
    const showTotal = i => typeof opt.totals === "function" ? opt.totals(i) : opt.totals !== false;
    const fr = frame(host, opt.height || 300, { t: 22, r: 8, b: 26, l: 46 });
    const totals = opt.cats.map((_, i) => opt.series.reduce((a, s) => a + (s.values[i] || 0), 0));
    const top = Math.max.apply(null, totals.concat(opt.overlay ? opt.overlay.values : []).concat([1]));
    const yMax = opt.yMax || niceMax(top * 1.06, 5);
    const y = v => fr.ih - v / yMax * fr.ih;
    yAxis(fr, y, ticks(0, yMax, 5), fmt, unit);
    const band = fr.iw / n, bw = Math.min(opt.maxBar || 72, band * 0.64);
    const groups = [];
    opt.cats.forEach((cat, i) => {
      const cx = band * (i + 0.5), x = cx - bw / 2, g = sv("g");
      let acc = 0;
      const lastIdx = opt.series.reduce((a, s, si) => (s.values[i] > yMax * 0.002 ? si : a), -1);
      opt.series.forEach((s, si) => {
        const v = s.values[i] || 0;
        if (v <= yMax * 0.002) return;
        const y1 = y(acc + v), hgt = y(acc) - y1;
        g.appendChild(si === lastIdx
          ? sv("path", { class: "seg-rect", d: topRound(x, y1, bw, hgt, 4), style: { fill: s.color } })
          : sv("rect", { class: "seg-rect", x, y: y1, width: bw, height: hgt, style: { fill: s.color } }));
        acc += v;
      });
      if (showTotal(i)) g.appendChild(sv("text", { class: "ink b", x: cx, y: y(Math.max(totals[i], opt.overlay ? opt.overlay.values[i] || 0 : 0)) - 6, "text-anchor": "middle", text: fmt(totals[i]) }));
      if (opt.overlay && opt.overlay.values[i] != null) {
        const oy = y(opt.overlay.values[i]);
        g.appendChild(sv("line", { x1: x - 6, x2: x + bw + 6, y1: oy, y2: oy, style: { stroke: "var(--ink)", strokeWidth: 2 } }));
      }
      fr.g.appendChild(g);
      groups.push(g);
      fr.g.appendChild(sv("text", { class: opt.selected === i ? "ink b" : "ink2", x: cx, y: fr.ih + 16, "text-anchor": "middle", text: cat }));
      const hit = sv("rect", { class: "hit", x: band * i, y: 0, width: band, height: fr.ih + 22 });
      if (opt.onClick) { hit.style.cursor = "pointer"; hit.addEventListener("click", () => opt.onClick(i)); }
      hoverable(hit, () => {
        const rows = opt.series.slice().reverse().filter(s => (s.values[i] || 0) > 0.05)
          .map(s => ({ color: s.color, label: s.label, value: fmt(s.values[i]) + (opt.shares === false ? "" : "  " + pct(s.values[i] / totals[i])) }));
        if (opt.series.length > 1) rows.push({ label: opt.totalLabel || "Total", value: fmt(totals[i]) + " " + unit, on: true });
        else rows[0].value += " " + unit;
        if (opt.overlay && opt.overlay.values[i] != null) rows.push({ color: "var(--ink)", label: opt.overlay.label, value: fmt(opt.overlay.values[i]) + " " + unit });
        return { title: opt.title ? opt.title(i) : String(cat), rows, note: opt.note ? opt.note(i) : null };
      }, () => groups.forEach((gg, j) => gg.setAttribute("class", j === i ? "hl" : "dim")), () => groups.forEach(gg => gg.removeAttribute("class")));
      fr.g.appendChild(hit);
    });
    return fr;
  }

  /** Lines over a numeric x with a crosshair that snaps to the nearest x. series values may contain null. */
  function lineChart(host, opt) {
    const X = opt.x, ends = (host.clientWidth || 600) >= 520 && opt.series.some(s => s.end);
    const fr = frame(host, opt.height || 300, { t: 16, r: ends ? (opt.endWidth || 120) : 12, b: 24, l: 46 });
    let top = 0;
    opt.series.forEach(s => s.values.forEach(v => { if (v != null && v > top) top = v; }));
    if (opt.band) opt.band.hi.forEach(v => { if (v != null && v > top) top = v; });
    const yMin = opt.yMin || 0, yMax = opt.yMax || niceMax(top * 1.04, 5);
    const x0 = X[0], x1 = X[X.length - 1];
    const x = v => (v - x0) / (x1 - x0) * fr.iw, y = v => fr.ih - (v - yMin) / (yMax - yMin) * fr.ih;
    const yf = opt.yFmt || f0;
    yAxis(fr, y, ticks(yMin, yMax, 5), yf, opt.unit);
    let xt = opt.xTicks || ticks(x0, x1, 6);
    xt = xt.filter((t, i) => i === xt.length - 1 || x(xt[xt.length - 1]) - x(t) >= 34);      // keep the last tick, drop any that would collide with it
    xt.forEach(t => fr.g.appendChild(sv("text", { x: x(t), y: fr.ih + 16, "text-anchor": "middle", text: opt.xFmt ? opt.xFmt(t) : String(t) })));
    if (opt.vline != null) {
      fr.g.appendChild(sv("line", { class: "baseline", x1: x(opt.vline.x), x2: x(opt.vline.x), y1: 0, y2: fr.ih, "stroke-dasharray": "3 3" }));
      if (opt.vline.label) fr.g.appendChild(sv("text", { x: x(opt.vline.x) + 5, y: 9, text: opt.vline.label }));
    }
    if (opt.band) {
      const pts = [];
      X.forEach((xv, i) => { if (opt.band.hi[i] != null) pts.push([x(xv), y(opt.band.hi[i])]); });
      for (let i = X.length - 1; i >= 0; i--) if (opt.band.lo[i] != null) pts.push([x(X[i]), y(opt.band.lo[i])]);
      fr.g.appendChild(sv("path", { d: "M" + pts.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L") + "Z", style: { fill: "var(--band)" } }));
    }
    const labels = [];
    opt.series.forEach(s => {
      let d = "", pen = false, last = null;
      s.values.forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += (pen ? "L" : "M") + x(X[i]).toFixed(1) + "," + y(v).toFixed(1);
        pen = true; last = i;
      });
      fr.g.appendChild(sv("path", { d, fill: "none", "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": s.dash ? "5 4" : null,
        style: { stroke: s.color, strokeWidth: s.width || 2 } }));
      if (ends && s.end && last != null) labels.push({ y: y(s.values[last]), x: x(X[last]), text: s.endText || s.label, value: yf(s.values[last]), color: s.color });
    });
    (opt.markers || []).forEach(mk => {
      fr.g.appendChild(sv("circle", { cx: x(mk.x), cy: y(mk.y), r: 4, style: { fill: mk.hollow ? "var(--surface)" : (mk.color || "var(--ink)"), stroke: mk.hollow ? (mk.color || "var(--ink)") : "var(--surface)", strokeWidth: 2 } }));
      if (mk.text) fr.g.appendChild(sv("text", { class: "ink b halo", x: x(mk.x) + (mk.dx || 0), y: y(mk.y) + (mk.dy == null ? -9 : mk.dy), "text-anchor": mk.anchor || "middle", text: mk.text }));
    });
    // direct end labels, nudged apart
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
    for (let i = labels.length - 1; i >= 0; i--) {
      const lim = fr.ih - (labels.length - 1 - i) * 13;
      if (labels[i].y > lim) labels[i].y = lim;
    }
    labels.forEach(l => {
      fr.g.appendChild(sv("line", { x1: l.x + 3, x2: l.x + 9, y1: l.y, y2: l.y, style: { stroke: l.color, strokeWidth: 2 } }));
      const t = sv("text", { class: "ink2", x: l.x + 13, y: l.y + 3.5 });
      t.appendChild(sv("tspan", { class: "ink b", text: l.value }));
      t.appendChild(sv("tspan", { dx: 5, text: l.text }));
      fr.g.appendChild(t);
    });
    // crosshair
    const cross = sv("line", { class: "cross", y1: 0, y2: fr.ih, style: { display: "none" } });
    const dots = sv("g", { style: { pointerEvents: "none" } });
    fr.g.appendChild(cross); fr.g.appendChild(dots);
    const hit = sv("rect", { class: "hit", x: 0, y: 0, width: fr.iw, height: fr.ih });
    const at = i => {
      const px = x(X[i]);
      cross.setAttribute("x1", px); cross.setAttribute("x2", px); cross.style.display = "";
      dots.textContent = "";
      const rows = [];
      opt.series.forEach(s => {
        const v = s.values[i];
        if (v == null) return;
        dots.appendChild(sv("circle", { cx: px, cy: y(v), r: 3.5, style: { fill: s.color, stroke: "var(--surface)", strokeWidth: 2 } }));
        rows.push({ color: s.color, dash: s.dash, label: s.label, value: yf(v), v });
      });
      rows.sort((a, b) => b.v - a.v);
      if (opt.band && opt.band.hi[i] != null) rows.push({ label: opt.band.label, value: yf(opt.band.lo[i]) + " – " + yf(opt.band.hi[i]) });
      return { title: (opt.xTitle ? opt.xTitle(X[i]) : String(X[i])), rows, note: opt.unit };
    };
    const nearest = e => {
      const r = hit.getBoundingClientRect(), px = (e.clientX - r.left) / r.width * fr.iw;
      let best = 0, bd = Infinity;
      X.forEach((xv, i) => { const dd = Math.abs(x(xv) - px); if (dd < bd) { bd = dd; best = i; } });
      return best;
    };
    hit.addEventListener("pointermove", e => Tip.show(e.clientX, e.clientY, at(nearest(e))));
    hit.addEventListener("pointerleave", () => { Tip.hide(); cross.style.display = "none"; dots.textContent = ""; });
    fr.g.appendChild(hit);
    return { fr, x, y };
  }

  function table(headers, rows, opt) {
    opt = opt || {};
    const cell = (tag, c, i) => {
      const e = el(tag, { class: opt.wrap && opt.wrap.indexOf(i) >= 0 ? "wrapcell" : null });
      if (c != null && typeof c === "object") e.appendChild(c); else e.textContent = c == null ? "" : String(c);
      return e;
    };
    return el("div", { class: "tbl-wrap" }, el("table", null,
      el("thead", null, el("tr", null, headers.map((h, i) => cell("th", h, i)))),
      el("tbody", null, rows.map((r, ri) => el("tr", { class: opt.sel === ri ? "sel" : null }, r.map((c, i) => cell("td", c, i)))))));
  }

  window.UI = { el, sv, f0, f1, f2, pct, signed, ticks, niceMax, Tip, hoverable, legend, frame, yAxis, stackedBars, lineChart, table, topRound };
})();
