const dimensions = [
  ['lifestyle', 'Lifestyle'], ['convenience', 'Convenience'], ['family', 'Family'],
  ['safety', 'Safety'], ['tranquility', 'Tranquility'],
] as const;

export function calculateWellbeing(input: unknown) {
  const data = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {};
  const rows = Array.isArray(data.scores) ? data.scores : [];
  const scores = dimensions.map(([key, label]) => {
    const matches = rows.filter(row => row && typeof row === 'object' && row.key === key);
    const value = matches.length === 1 ? matches[0].value : null;
    return { key, label, value: typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null };
  });
  const available = scores.filter((row): row is typeof row & { value: number } => row.value !== null);
  const area = typeof data.area_name === 'string' && data.area_name.trim() ? data.area_name : null;
  // Inputs are suburb averages. Missing values never silently become zero.
  const value = data.area_level === 'suburb' && area && available.length >= 3
    ? Math.round(available.reduce((sum, row) => sum + row.value, 0) / available.length) : null;
  return { value, area, scores, available: available.length, total: dimensions.length };
}
