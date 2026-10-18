const words = (text: string): Set<string> => new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []);

export function topicRelevance(candidate: string, recentContext: string): number {
  const a = words(candidate);
  const b = words(recentContext);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / a.size;
}
