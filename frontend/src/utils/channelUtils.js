export function getChannelDisplayName(mapping) {
  if (!mapping) return 'Unknown Channel';
  return (mapping.label?.trim()) || mapping.name || 'Unknown Channel';
}
