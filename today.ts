import { graphql } from "@octokit/graphql";
import { readFileSync, writeFileSync } from "node:fs";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import xpath from "xpath";

const TOKEN = (process.env.ACCESS_TOKEN || process.env.GITHUB_TOKEN || "").trim();
const USER = (process.env.USER_NAME || process.env.GITHUB_ACTOR || "").trim();
const BIRTHDATE = (process.env.BIRTHDATE || "1990-11-25").trim(); // <-- mets la tienne YYYY-MM-DD
if (!TOKEN || !USER) {
  console.warn("WARNING: Missing ACCESS_TOKEN/GITHUB_TOKEN or USER_NAME — running in preview mode (ASCII will be injected, stats will be placeholders).");
}

const client = graphql.defaults({
  headers: { authorization: `token ${TOKEN}` },
});

const fmt = (n: number) => new Intl.NumberFormat("en-US").format(n);
function ageString(fromISO: string) {
  const from = new Date(fromISO),
    now = new Date();
  const days = Math.floor((+now - +from) / 86400000);
  const y = Math.floor(days / 365),
    m = Math.floor((days % 365) / 30),
    d = (days % 365) % 30;
  const parts = [];
  if (y) parts.push(`${y} year${y > 1 ? "s" : ""}`);
  if (m) parts.push(`${m} month${m > 1 ? "s" : ""}`);
  if (d) parts.push(`${d} day${d > 1 ? "s" : ""}`);
  return parts.join(", ");
}
function nodeById(doc: Document, id: string) {
  return xpath.select1(`//*[@id='${id}']`, doc) as Node | null;
}
function put(doc: Document, id: string, text: string) {
  const n = nodeById(doc, id);
  if (!n) return;
  if ((n as any).firstChild) (n.firstChild as any).data = text;
  else n.appendChild(doc.createTextNode(text));
}
function padDots(doc: Document, id: string, text: string, width: number) {
  const len = Math.max(0, width - text.length);
  const dots =
    len <= 2
      ? len === 0
        ? ""
        : len === 1
        ? " "
        : ". "
      : " " + ".".repeat(len) + " ";
  put(doc, `${id}_dots`, dots);
}

async function getOwnerStarsRepos() {
  let cursor: string | null = null,
    stars = 0,
    total = 0,
    first = true;
  
  const query = `query($login:String!,$cursor:String){
      user(login:$login){ repositories(first:100, after:$cursor, ownerAffiliations:[OWNER]){
        totalCount pageInfo{endCursor hasNextPage} edges{ node{ stargazers{ totalCount } } } } } }`;
  
  type RepositoriesResponse = {
    user: {
      repositories: {
        totalCount: number;
        pageInfo: { endCursor: string; hasNextPage: boolean };
        edges: { node: { stargazers: { totalCount: number } } }[];
      };
    };
  };
  
  while (true) {
    const res: RepositoriesResponse = await client(query, { login: USER, cursor });
    const r = res.user.repositories;
    if (first) {
      total = r.totalCount;
      first = false;
    }
    stars += r.edges.reduce((s: number, e: { node: { stargazers: { totalCount: number } } }) => s + e.node.stargazers.totalCount, 0);
    if (!r.pageInfo.hasNextPage) break;
    cursor = r.pageInfo.endCursor;
  }
  return { total, stars };
}
async function getContributedRepos() {
  const res = await client<{ user: { repositories: { totalCount: number } } }>(
    `
    query($login:String!){
      user(login:$login){ repositories(first:1, ownerAffiliations:[OWNER, COLLABORATOR, ORGANIZATION_MEMBER]){ totalCount } }
    }`,
    { login: USER }
  );
  return res.user.repositories.totalCount;
}
async function getFollowers() {
  const res = await client<{ user: { followers: { totalCount: number } } }>(
    `
    query($login:String!){ user(login:$login){ followers{ totalCount } } }`,
    { login: USER }
  );
  return res.user.followers.totalCount;
}

async function getCommitContributions() {
  // Returns the user's total commit contributions (GitHub contributions collection)
  const q = `query($login:String!){ user(login:$login){ contributionsCollection{ totalCommitContributions } } }`;
  const res = await client<{ user: { contributionsCollection: { totalCommitContributions: number } } }>(
    q,
    { login: USER }
  );
  return res.user.contributionsCollection.totalCommitContributions;
}

async function getLocEstimate() {
  // Sum language size across owned repositories (first 100 per page). This is an estimate.
  let cursor: string | null = null;
  let totalBytes = 0;
  const query = `query($login:String!,$cursor:String){ user(login:$login){ repositories(first:100, after:$cursor, ownerAffiliations:[OWNER]){ pageInfo{endCursor hasNextPage} edges{ node{ languages(first:100){ edges{ size } } } } } } }`;

  type RepoLangsResp = {
    user: {
      repositories: {
        pageInfo: { endCursor: string; hasNextPage: boolean };
        edges: { node: { languages: { edges: { size: number }[] } } }[];
      };
    };
  };

  while (true) {
    const res: RepoLangsResp = await client(query, { login: USER, cursor });
    const repos = res.user.repositories;
    for (const e of repos.edges) {
      const langs = e.node.languages.edges;
      for (const le of langs) totalBytes += le.size || 0;
    }
    if (!repos.pageInfo.hasNextPage) break;
    cursor = repos.pageInfo.endCursor;
  }

  // Heuristic: assume average bytes per source line ~ 50 bytes
  const lines = Math.round(totalBytes / 50);
  return { bytes: totalBytes, lines };
}

function updateSvg(
  path: string,
  ascii: string,
  p: {
    age: string;
    repos: number;
    stars: number;
    followers: number;
    contributed: number;
    commits?: number;
    locLines?: number;
    locBytes?: number;
  }
) {
  const xml = readFileSync(path, "utf8");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  // ASCII
  const asciiNode = nodeById(doc, "ascii_payload");
  if (asciiNode) {
    // Trim leading/trailing blank lines from ascii
    const lines = ascii.replace(/\r/g, "").split("\n").map(l => l.replace(/\s+$/g, ""));
    // remove leading/trailing empty lines
    while (lines.length && lines[0].trim() === "") lines.shift();
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();

    const maxChars = lines.reduce((m, l) => Math.max(m, l.length), 0);
    // Determine target pixel width: prefer reading the parent <foreignObject width="..."> if available
    let targetPx = 360;
    try {
      const parent = (asciiNode as any).parentNode;
      if (parent && parent.getAttribute) {
        const w = parent.getAttribute("width");
        if (w) {
          const parsed = parseInt(w, 10);
          if (!Number.isNaN(parsed) && parsed > 0) targetPx = parsed - 10; // small padding
        }
      }
    } catch (e) {
      // fall back to default targetPx
    }

    // Estimate width per character in monospace at font-size 16px: approx 9px.
    // Compute a font-size that fits within targetPx, but clamp to reasonable bounds.
    const approxCharWidthAt16 = 9; // px per char at font-size 16
    const rawFontSize = Math.floor((targetPx / Math.max(1, maxChars)) * (16 / approxCharWidthAt16));
    const fontSize = Math.max(6, Math.min(20, rawFontSize || 8));

    // Clear existing content
    while ((asciiNode as any).firstChild)
      (asciiNode as any).removeChild((asciiNode as any).firstChild);

    // Ensure the ascii_node (likely a <pre> inside a foreignObject) has an inline style for font-size and preserve whitespace
    if ((asciiNode as any).setAttribute) {
      // If updating the dark SVG, force ASCII color to white for visibility
      const isDark = /dark/i.test(path);
      const colorStyle = isDark ? 'color: #ffffff;' : '';
      (asciiNode as any).setAttribute('style', `font-family: monospace; font-size: ${fontSize}px; white-space: pre; ${colorStyle}`);
    }

    // Rebuild ascii text with trimmed lines
    const finalAscii = lines.join("\n");
    asciiNode.appendChild(doc.createTextNode(finalAscii));
  }

  // Stats
  put(doc, "age_data", p.age);
  padDots(doc, "age_data", p.age, 22);
  const rs = fmt(p.repos);
  put(doc, "repo_data", rs);
  padDots(doc, "repo_data", rs, 6);
  const st = fmt(p.stars);
  put(doc, "star_data", st);
  padDots(doc, "star_data", st, 11);
  const fl = fmt(p.followers);
  put(doc, "follower_data", fl);
  padDots(doc, "follower_data", fl, 7);
  put(doc, "contrib_data", fmt(p.contributed));
  if (typeof p.commits === "number") {
    put(doc, "commit_data", fmt(p.commits));
    padDots(doc, "commit_data", String(p.commits), 15);
  }
  if (typeof p.locLines === "number") {
    put(doc, "loc_data", fmt(p.locLines));
  }
  if (typeof p.locBytes === "number") {
    put(doc, "loc_add", fmt(p.locBytes));
  }

  writeFileSync(path, new XMLSerializer().serializeToString(doc), "utf8");
  console.log(`updated ${path}`);
}

(async () => {
  const ascii = readFileSync("ascii.txt", "utf8");
  let total = 0,
    stars = 0,
    contributed = 0,
    followers = 0;
  let commits: number | undefined = undefined;
  let locLines: number | undefined = undefined;
  let locBytes: number | undefined = undefined;
  if (TOKEN && USER) {
    const [ownerRes, contributedRes, followersRes, commitsRes, locRes] = await Promise.all([
      getOwnerStarsRepos(),
      getContributedRepos(),
      getFollowers(),
      getCommitContributions(),
      getLocEstimate(),
    ]);
    ({ total, stars } = ownerRes as any);
    contributed = contributedRes as any;
    followers = followersRes as any;
  commits = commitsRes as number;
  locLines = (locRes as any).lines as number;
  locBytes = (locRes as any).bytes as number;
  } else {
    // local preview placeholders
    total = 12;
    stars = 34;
    contributed = 5;
    followers = 7;
    commits = 2116;
    locLines = 446276;
    locBytes = 523178;
  }
  const age = ageString(BIRTHDATE);
  updateSvg("light_mode.svg", ascii, {
    age,
    repos: total,
    stars,
    followers,
    contributed,
    commits: typeof commits === "number" ? commits : undefined,
    locLines: typeof locLines === "number" ? locLines : undefined,
    locBytes: typeof locBytes === "number" ? locBytes : undefined,
  });
  updateSvg("dark_mode.svg", ascii, {
    age,
    repos: total,
    stars,
    followers,
    contributed,
    commits: typeof commits === "number" ? commits : undefined,
    locLines: typeof locLines === "number" ? locLines : undefined,
    locBytes: typeof locBytes === "number" ? locBytes : undefined,
  });
})();
