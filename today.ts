import { graphql } from "@octokit/graphql";
import { readFileSync, writeFileSync } from "node:fs";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import xpath from "xpath";

const TOKEN = process.env.ACCESS_TOKEN || process.env.GITHUB_TOKEN || "";
const USER = process.env.USER_NAME || process.env.GITHUB_ACTOR || "";
const BIRTHDATE = process.env.BIRTHDATE || "2000-01-01"; // <-- mets la tienne YYYY-MM-DD
if (!TOKEN || !USER)
  throw new Error("Missing ACCESS_TOKEN/GITHUB_TOKEN or USER_NAME");

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
  while (true) {
    const res = await client<{
      user: {
        repositories: {
          totalCount: number;
          pageInfo: { endCursor: string; hasNextPage: boolean };
          edges: { node: { stargazers: { totalCount: number } } }[];
        };
      };
    }>(
      `query($login:String!,$cursor:String){
      user(login:$login){ repositories(first:100, after:$cursor, ownerAffiliations:[OWNER]){
        totalCount pageInfo{endCursor hasNextPage} edges{ node{ stargazers{ totalCount } } } } } }`,
      { login: USER, cursor }
    );
    const r = res.user.repositories;
    if (first) {
      total = r.totalCount;
      first = false;
    }
    stars += r.edges.reduce((s, e) => s + e.node.stargazers.totalCount, 0);
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

function updateSvg(
  path: string,
  ascii: string,
  p: {
    age: string;
    repos: number;
    stars: number;
    followers: number;
    contributed: number;
  }
) {
  const xml = readFileSync(path, "utf8");
  const doc = new DOMParser().parseFromString(xml, "text/xml");
  // ASCII
  const asciiNode = nodeById(doc, "ascii_payload");
  if (asciiNode) {
    while ((asciiNode as any).firstChild)
      (asciiNode as any).removeChild((asciiNode as any).firstChild);
    asciiNode.appendChild(doc.createTextNode(ascii));
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

  writeFileSync(path, new XMLSerializer().serializeToString(doc), "utf8");
  console.log(`updated ${path}`);
}

(async () => {
  const ascii = readFileSync("ascii.txt", "utf8");
  const [{ total, stars }, contributed, followers] = await Promise.all([
    getOwnerStarsRepos(),
    getContributedRepos(),
    getFollowers(),
  ]);
  const age = ageString(BIRTHDATE);
  updateSvg("light_mode.svg", ascii, {
    age,
    repos: total,
    stars,
    followers,
    contributed,
  });
  updateSvg("dark_mode.svg", ascii, {
    age,
    repos: total,
    stars,
    followers,
    contributed,
  });
})();
