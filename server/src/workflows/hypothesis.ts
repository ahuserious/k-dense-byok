export interface HypothesisPair {
  index: number;
  h1: string;
  h0: string;
}

export function buildHypothesisPairs(question: string, count: number): HypothesisPair[] {
  const n = Math.min(8, Math.max(1, count));
  const topic = question.trim();
  return Array.from({ length: n }, (_, index) => ({
    index: index + 1,
    h1: `H1-${index + 1}: ${topic} holds under assumption ${index + 1}.`,
    h0: `H0-${index + 1}: ${topic} does not hold under assumption ${index + 1}.`,
  }));
}

export function hypothesisReportMarkdown(
  question: string,
  pairs: readonly HypothesisPair[],
  analyses: readonly string[],
  verdict: string,
): string {
  const sections = pairs.map((pair, index) => [
    `## Pair ${pair.index}`,
    "",
    `- ${pair.h1}`,
    `- ${pair.h0}`,
    "",
    analyses[index] ?? "No analysis.",
    "",
  ].join("\n"));
  return [
    "# Hypothesis analysis",
    "",
    `Question: ${question.trim()}`,
    "",
    ...sections,
    "## Terminal analysis",
    "",
    verdict.trim(),
    "",
  ].join("\n");
}
