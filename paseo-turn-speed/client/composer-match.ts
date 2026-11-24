export interface ComposerCandidate {
  context: string;
  prompt: string;
  agent: string;
}

export function matchComposer(
  composer: ComposerCandidate,
  ids: readonly string[],
  candidates: Readonly<Record<string, readonly ComposerCandidate[]>>,
  sent: ReadonlyMap<string, string | null>,
  retained: string | null,
): string | null {
  if (!ids.every((id) => id in candidates)) return null;
  const sameAgent = (candidate: ComposerCandidate) =>
    candidate.context === composer.context && candidate.agent === composer.agent;
  if (composer.prompt === "" && retained && ids.includes(retained) &&
    candidates[retained].some(sameAgent)) return retained;
  const matches = ids.filter((id) => candidates[id].some((candidate) =>
    sameAgent(candidate) && candidate.prompt === composer.prompt,
  ));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    const bridged = ids.filter((id) => sent.get(id) === composer.prompt && composer.prompt !== "" &&
      candidates[id].some((candidate) => sameAgent(candidate) && candidate.prompt === ""));
    if (bridged.length === 1) return bridged[0];
  }
  if (retained && ids.includes(retained) &&
    (composer.prompt === "" || sent.get(retained) === composer.prompt) &&
    candidates[retained].some(sameAgent)) return retained;
  return null;
}
