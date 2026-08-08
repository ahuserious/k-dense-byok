function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function botIdentities(canonical: string, legacy?: string): string[] {
  const identities = [canonical, legacy]
    .map(value => value?.trim())
    .filter((value): value is string => Boolean(value));
  return identities.filter(
    (identity, index) =>
      identities.findIndex(candidate => candidate.toLowerCase() === identity.toLowerCase()) === index
  );
}

export function findMentionIdentity(text: string, identities: readonly string[]): string | undefined {
  return identities.find(identity => {
    const pattern = new RegExp(`@${escapeRegex(identity)}(?:[\\s,:;]|$)`, 'i');
    return pattern.test(text);
  });
}

export function stripMentionIdentities(text: string, identities: readonly string[]): string {
  let stripped = text;
  for (const identity of [...identities].sort((left, right) => right.length - left.length)) {
    const pattern = new RegExp(`@${escapeRegex(identity)}(?:[\\s,:;]+|$)`, 'gi');
    stripped = stripped.replace(pattern, '');
  }
  return stripped.trim();
}

export function findBotAuthorIdentity(
  author: string | undefined,
  identities: readonly string[]
): string | undefined {
  const normalizedAuthor = author?.trim().toLowerCase();
  if (!normalizedAuthor) return undefined;
  return identities.find(identity => {
    const normalizedIdentity = identity.toLowerCase();
    return (
      normalizedAuthor === normalizedIdentity || normalizedAuthor === `${normalizedIdentity}[bot]`
    );
  });
}
