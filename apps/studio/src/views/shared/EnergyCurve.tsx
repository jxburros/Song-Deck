/** Tiny sparkline of the song's energy curve (spec §11 "Energy: 30 → 45 → 70 → 92 …"). */
export function EnergyCurve({
  values,
  width = 200,
  height = 32,
}: {
  values: number[];
  width?: number;
  height?: number;
}) {
  if (values.length === 0) return null;
  const pad = 3;
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0;
  const y = (v: number) => height - pad - (Math.max(0, Math.min(100, v)) / 100) * (height - pad * 2);
  const pts = values.map((v, i) => `${pad + i * step},${y(v)}`).join(' ');
  return (
    <svg width={width} height={height} role="img" aria-label={`Energy curve ${values.join(' → ')}`}>
      <polyline
        points={`${pad},${height - pad} ${pts} ${pad + (values.length - 1) * step},${height - pad}`}
        fill="var(--accent-soft)"
        stroke="none"
      />
      <polyline points={pts} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
      {values.map((v, i) => (
        <circle key={i} cx={pad + i * step} cy={y(v)} r={2} fill="var(--accent)" />
      ))}
    </svg>
  );
}
