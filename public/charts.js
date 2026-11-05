// Tiny hand-rolled SVG charts (no dependencies) with built-in motion:
// lines draw themselves in, donuts sweep around, bars grow — all staggered,
// with gradient strokes and a living pulse on the latest data point.
// `prefers-reduced-motion` is honoured by the stylesheet.
export const PALETTE = ['#14919b', '#1d3f5f', '#e0a437', '#b3372e', '#5b8c5a', '#7b6d8d', '#3e7cb1', '#c96f4a', '#4fb3a5', '#8a9ba8', '#d8a23a', '#708090'];

let chartSeq = 0;
function defs(id) {
  return `<defs>
    <linearGradient id="${id}-line" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#2b6cb0"/><stop offset="1" stop-color="#14919b"/>
    </linearGradient>
    <linearGradient id="${id}-bar" x1="0" y1="1" x2="0" y2="0">
      <stop offset="0" stop-color="#1d3f5f"/><stop offset="1" stop-color="#14919b"/>
    </linearGradient>
    <filter id="${id}-glow" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="2.6" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;
}

export function lineChart({ width = 560, height = 200, series, labels }) {
  const id = `ch${++chartSeq}`;
  const pad = { l: 34, r: 10, t: 12, b: 26 };
  const maxY = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.y)));
  const n = Math.max(1, labels.length - 1);
  const X = (i) => pad.l + (i / n) * (width - pad.l - pad.r);
  const Y = (v) => height - pad.b - (v / maxY) * (height - pad.t - pad.b);
  const ticks = [0, maxY].map((v) => `<text class="chart-tip" x="${pad.l - 6}" y="${Y(v) + 4}" text-anchor="end">${v}</text><line x1="${pad.l}" y1="${Y(v)}" x2="${width - pad.r}" y2="${Y(v)}" stroke="#e3e9ef"/>`);
  const lines = series.map((s, i) => {
    const d = s.points.map((p, j) => `${j ? 'L' : 'M'}${X(j).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    const last = s.points[s.points.length - 1];
    return `<path class="draw" pathLength="1" style="--dl:${(1.3 + i * 0.28).toFixed(2)}s" d="${d}" fill="none" stroke="${s.color}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle class="pulse-node" style="--dl:${(1.4 + i * 0.28).toFixed(2)}s" cx="${X(s.points.length - 1)}" cy="${Y(last.y)}" r="3.2" fill="${s.color}"/>
      <circle cx="${X(s.points.length - 1)}" cy="${Y(last.y)}" r="2.6" fill="${s.color}" filter="url(#${id}-glow)"/>`;
  }).join('');
  const step = Math.ceil(labels.length / 8);
  const xlabels = labels.map((l, i) => (i % step === 0 ? `<text class="chart-tip" x="${X(i)}" y="${height - 8}" text-anchor="middle">${l.slice(5)}</text>` : '')).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" style="width:100%;height:auto">${defs(id)}${ticks.join('')}${lines}${xlabels}</svg>`;
}

export function barChart({ width = 560, height = 200, data, color = 'grad' }) {
  const id = `ch${++chartSeq}`;
  const pad = { l: 10, r: 10, t: 14, b: 40 };
  const maxV = Math.max(1, ...data.map((d) => d.value));
  const bw = (width - pad.l - pad.r) / Math.max(1, data.length);
  const fill = color === 'grad' ? `url(#${id}-bar)` : color;
  const bars = data.map((d, i) => {
    const h = (d.value / maxV) * (height - pad.t - pad.b);
    const x = pad.l + i * bw + bw * 0.15;
    const y = height - pad.b - h;
    return `<rect class="grow" style="--dl:${(i * 0.06).toFixed(2)}s" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" rx="3" fill="${fill}"><title>${d.label}: ${d.value}</title></rect>
      <text class="chart-tip" x="${(x + bw * 0.35).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${d.value || ''}</text>
      <text class="chart-tip" x="${(x + bw * 0.35).toFixed(1)}" y="${height - 22}" text-anchor="middle">${d.label.length > 11 ? d.label.slice(0, 10) + '…' : d.label}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" style="width:100%;height:auto">${defs(id)}${bars}</svg>`;
}

export function donutChart({ width = 190, height = 190, data, thickness = 26 }) {
  const total = data.reduce((a, d) => a + d.value, 0);
  const cx = width / 2, cy = height / 2, r = Math.min(cx, cy) - 4;
  if (!total) return `<svg viewBox="0 0 ${width} ${height}" style="width:${width}px"><circle cx="${cx}" cy="${cy}" r="${r - thickness / 2}" fill="none" stroke="#e3e9ef" stroke-width="${thickness}"/></svg>`;
  let angle = -Math.PI / 2;
  let seq = 0;
  const arcs = data.filter((d) => d.value > 0).map((d) => {
    const frac = d.value / total;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(angle), y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
    const xi1 = cx + (r - thickness) * Math.cos(angle), yi1 = cy + (r - thickness) * Math.sin(angle);
    const xi2 = cx + (r - thickness) * Math.cos(a2), yi2 = cy + (r - thickness) * Math.sin(a2);
    const path = `M${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} L${xi2.toFixed(2)},${yi2.toFixed(2)} A${r - thickness},${r - thickness} 0 ${large} 0 ${xi1.toFixed(2)},${yi1.toFixed(2)} Z`;
    const delay = (seq++ * 0.16).toFixed(2);
    angle = a2;
    return `<path class="sweep" style="--dl:${delay}s" pathLength="1" d="${path}" fill="${d.color}"><title>${d.label}: ${d.value} (${Math.round(frac * 100)}%)</title></path>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" style="width:${width}px;height:auto">${arcs}<text x="${cx}" y="${cy + 5}" text-anchor="middle" style="font-size:20px;font-weight:700;fill:var(--ink)">${total}</text></svg>`;
}

export function legend(data) {
  return `<div class="legend">${data.filter((d) => d.value > 0).map((d) => `<span><span class="sw" style="background:${d.color}"></span>${d.label} (${d.value})</span>`).join('')}</div>`;
}
