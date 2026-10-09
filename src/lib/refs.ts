/** A pull request named in a message: "owner/repo" plus its number. */
export interface PrRef {
  repo: string;
  number: number;
}

/**
 * Short names people use for repos ("WEB#1408"), from TSUKUMO_REPO_ALIASES:
 * `web=webapp,api=acme/api-server` (a bare repo name gets the default owner).
 */
export function repoAliases(raw = process.env.TSUKUMO_REPO_ALIASES): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? "").split(",")) {
    const [alias, repo] = pair.split("=").map((x) => x.trim());
    if (alias && repo) out[alias.toLowerCase()] = repo;
  }
  return out;
}

export function prKey(ref: PrRef): string {
  return `pr:${ref.repo.toLowerCase()}#${ref.number}`;
}

/** "acme/webapp" from a GitHub URL in a channel topic, if there is one. */
export function repoFromTopic(topic: string | null | undefined): string | undefined {
  const m = topic?.match(/github\.com\/([\w.-]+)\/([\w.-]+)/i);
  return m ? `${m[1]}/${m[2]!.replace(/\.+$/, "").replace(/\.git$/, "")}` : undefined;
}

/**
 * Every PR a message names, in order, without repeats: GitHub PR URLs,
 * `repo#N` (including aliases), and bare `#N`, which means the channel's own
 * repo (from its topic). A repo named without an owner gets `owner`, else
 * TSUKUMO_GITHUB_OWNER, else the owner of the channel's repo; with none of
 * those it is skipped. Discord's `<#channel>` mentions are not PRs.
 */
export function extractPrRefs(
  text: string,
  opts: { defaultRepo?: string; owner?: string; aliases?: Record<string, string> } = {},
): PrRef[] {
  const owner = opts.owner || process.env.TSUKUMO_GITHUB_OWNER || opts.defaultRepo?.split("/")[0];
  const aliases = opts.aliases ?? repoAliases();
  const out: PrRef[] = [];
  const seen = new Set<string>();
  const add = (repo: string, n: string) => {
    const ref = { repo, number: Number(n) };
    const key = prKey(ref);
    if (!seen.has(key) && Number.isFinite(ref.number)) {
      seen.add(key);
      out.push(ref);
    }
  };
  // Code spans and blocks quote things; they don't name the subject.
  const prose = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
  const pattern =
    /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)|(?<![\w/<#-])([A-Za-z][\w.-]*(?:\/[\w.-]+)?)#(\d{1,6})\b|(?<![\w/<#&@])#(\d{2,5})\b/g;
  for (const m of prose.matchAll(pattern)) {
    if (m[3]) add(`${m[1]}/${m[2]}`, m[3]);
    else if (m[5]) {
      const lower = m[4]!.toLowerCase();
      // "PR#1407" / "pull#1407" mean the channel's own repo.
      if (lower === "pr" || lower === "pull") {
        if (opts.defaultRepo) add(opts.defaultRepo, m[5]);
        continue;
      }
      const name = aliases[lower] ?? m[4]!;
      if (name.includes("/")) add(name, m[5]);
      else if (owner) add(`${owner}/${name}`, m[5]);
    } else if (m[6] && opts.defaultRepo) add(opts.defaultRepo, m[6]);
  }
  return out;
}
