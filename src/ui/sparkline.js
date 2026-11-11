let gid = 0;

/** Tiny dependency-free SVG sparkline with a soft area fill. */
export function sparkline(values, up = true, { width = 300, height = 64 } = {}) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return '';
  const min = Math.min(...v);
  const max = Math.max(...v);
  const span = max - min || 1;
  const pad = 4;
  const x = (i) => (i / (v.length - 1)) * width;
  const y = (n) => pad + (1 - (n - min) / span) * (height - pad * 2);
  const line = v.map((n, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(n).toFixed(1)}`).join('');
  const id = `spark${++gid}`;
  const cls = up ? 'up' : 'down';
  return `<svg class="spark ${cls}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="Price trend">
    <defs><linearGradient id="${id}" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="currentColor" stop-opacity=".22"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${line}L${width},${height}L0,${height}Z" fill="url(#${id})"/>
    <path d="${line}" fill="none" stroke="currentColor" stroke-width="1.8" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
  </svg>`;
}
