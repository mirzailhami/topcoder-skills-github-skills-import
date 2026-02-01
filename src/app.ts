import axios, { AxiosInstance, AxiosResponse } from "axios";
import * as dotenv from "dotenv";
import crypto from "crypto";
import OpenAI from "openai";
import { Ollama } from "ollama";
import * as path from "path";
import * as fs from "fs/promises";
import { promisify } from "util";

const sleep = promisify(setTimeout);
dotenv.config();

// ── Configuration & Constants ───────────────────────────────────────────────
const CACHE_DIR = path.join(process.cwd(), ".cache");
const SKILLS_CACHE_FILE = path.join(CACHE_DIR, "topcoder-skills.json");
const getUserCacheFile = (username: string | undefined) => {
    const safe = (username || "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
    return path.join(CACHE_DIR, `github-${safe.toLowerCase()}.json`);
  };

const MAX_REPOS_TO_ANALYZE = (() => {
  const val = process.env.MAX_REPOS_TO_ANALYZE;
  return val ? Math.max(1, Math.min(100, parseInt(val, 10))) : 10;
})();

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const LLM_PROVIDER = process.env.LLM_PROVIDER;
const HUGGINGFACE_TOKEN = process.env.HUGGINGFACE_TOKEN;
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;

if (!GITHUB_CLIENT_ID) throw new Error("GITHUB_CLIENT_ID is required in .env");
if (LLM_PROVIDER === "huggingface_router" && !HUGGINGFACE_TOKEN) {
  throw new Error("HUGGINGFACE_TOKEN is required for huggingface_router");
}
if (LLM_PROVIDER === "ollama_cloud" && !OLLAMA_API_KEY) {
  throw new Error("OLLAMA API KEY is required for ollama_cloud");
}

// ── Types ────────────────────────────────────────────────────────────────────
interface Skill {
  id: string;
  name: string;
}
interface Recommendation {
  id: string;
  name: string;
  score: number;
  info: string;
}
interface RepoAnalysis {
  languages: Record<string, number>;
  dependencies: Set<string>;
  fileTypes: Set<string>;
  commitCount: number;
  prCount: number;
  evidence: string[];
}
interface CachedUserAnalysis {
  timestamp: string;
  username: string;
  reposCount: number;
  analyzedRepos: number;
  totalCommits: number;
  totalPRs: number;
  langPercentages: string[];
  topDependencies: string[];
  topFileTypes: string[];
  allEvidenceLinks: string[];
  reposToAnalyze: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function ensureCacheDir() {
  await fs.mkdir(CACHE_DIR, { recursive: true }).catch(() => {});
}

function getApiCallsCounter() {
  let count = 0;
  return {
    increment: () => count++,
    get: () => count,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const startTime = Date.now();
  const apiCalls = getApiCallsCounter();
  const searchCalls = getApiCallsCounter();

  await ensureCacheDir();

  // 1. Authenticate
  const accessToken = await authenticateGitHub(apiCalls);
  const github = createGitHubClient(accessToken, apiCalls);

  // 2. Get username
  const username = await getUsername(github, apiCalls);
  console.log(`Analyzing @${username}\n`);

  // 3. Load or fetch Topcoder skills (cached)
  const allSkills = await loadOrFetchSkills(apiCalls);

  // 4. Load or compute GitHub analysis (cached)
  const analysis = await loadOrComputeAnalysis(
    github,
    username,
    apiCalls,
    searchCalls
  );

  // 5. Build prompt
  const sampleSize = parseInt(process.env.EVIDENCE_SAMPLE_SIZE || "12", 10);
  const evidenceSample = getFreshEvidenceSample(
    analysis.allEvidenceLinks,
    sampleSize
  );
  const prompt = buildPrompt({ ...analysis, evidenceSample }, allSkills);

  // 6. Call LLM
  console.log(`Querying LLM using ${process.env.HF_MODEL}...`);
  console.log(`Prompt: ${prompt}`);
  console.log(
    `Prompt length: ${prompt.length} chars (~${Math.round(
      prompt.length / 4
    )} tokens)`
  );
  const llmResponse = await callLLM(prompt);

  // 7. Parse & display results
  const recommendations = parseAndMapRecommendations(llmResponse, allSkills);
  displayResults(
    recommendations,
    analysis,
    apiCalls.get() + searchCalls.get(),
    startTime
  );
}

// ── Authenticate ─────────────────────────────────────────────────────────────
async function authenticateGitHub(
  apiCalls: ReturnType<typeof getApiCallsCounter>
): Promise<string> {
  let token = process.env.GITHUB_ACCESS_TOKEN?.trim();

  if (token) {
    console.log("Using cached GitHub token from .env");
    return token;
  }

  console.log("Initiating GitHub device flow authentication...");
  const codeRes = await axios.post(
    "https://github.com/login/device/code",
    { client_id: GITHUB_CLIENT_ID, scope: "user repo" },
    { headers: { Accept: "application/json" } }
  );
  apiCalls.increment();

  const { device_code, user_code, verification_uri, interval, expires_in } =
    codeRes.data;

  console.log(`\n→ Go to: ${verification_uri}`);
  console.log(`→ Code: ${user_code}\n`);

  const start = Date.now();
  while (Date.now() - start < expires_in * 1000) {
    await sleep(interval * 1000);
    try {
      const tokenRes = await axios.post(
        "https://github.com/login/oauth/access_token",
        {
          client_id: GITHUB_CLIENT_ID,
          device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        { headers: { Accept: "application/json" } }
      );
      apiCalls.increment();

      const data = tokenRes.data;
      if (data.access_token) {
        console.log("\nAuthentication successful!");
        console.log(`Token (add to .env): ${data.access_token}`);
        return data.access_token;
      }
    } catch (err: any) {
      console.error("Polling error:", err.message);
    }
  }

  throw new Error("Authentication timed out or failed");
}

// ── Create GitHub client with rate limiting ─────────────────────────────────
function createGitHubClient(
  token: string,
  apiCalls: ReturnType<typeof getApiCallsCounter>
) {
  const client = axios.create({
    baseURL: "https://api.github.com",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  client.interceptors.response.use(async (res) => {
    apiCalls.increment();
    const remaining = parseInt(res.headers["x-ratelimit-remaining"] || "0", 10);
    const reset = parseInt(res.headers["x-ratelimit-reset"] || "0", 10);
    if (remaining < 10 && reset > 0) {
      const wait = reset * 1000 - Date.now() + 2000;
      if (wait > 0) {
        console.log(`Rate limit low. Waiting ${Math.round(wait / 1000)}s...`);
        await sleep(wait);
      }
    }
    return res;
  });

  return client;
}

// ── Get username ─────────────────────────────────────────────────────────────
async function getUsername(
  github: AxiosInstance,
  apiCalls: ReturnType<typeof getApiCallsCounter>
) {
  const res = await github.get("/user");
  apiCalls.increment();
  return res.data.login;
}

// ── Load or fetch Topcoder skills (cached forever) ───────────────────────────
async function loadOrFetchSkills(
  apiCalls: ReturnType<typeof getApiCallsCounter>
) {
  try {
    const data = await fs.readFile(SKILLS_CACHE_FILE, "utf-8");
    const skills = JSON.parse(data);
    console.log(`Loaded ${skills.length} Topcoder skills from cache`);
    return skills;
  } catch {
    console.log("Fetching Topcoder skills...");
    const skills: Skill[] = [];
    let page = 1;
    while (true) {
      const res = await axios.get(
        `https://api.topcoder-dev.com/v5/standardized-skills/skills?page=${page}&perPage=100`
      );
      apiCalls.increment();
      skills.push(...res.data.map((s: any) => ({ id: s.id, name: s.name })));

      const next = res.headers["x-next-page"];
      if (!next) break;
      page = parseInt(next, 10);
    }

    await fs.writeFile(SKILLS_CACHE_FILE, JSON.stringify(skills, null, 2));
    console.log(`Cached ${skills.length} skills`);
    return skills;
  }
}

// ── Load or compute GitHub analysis (cached per user) ────────────────────────
async function loadOrComputeAnalysis(
  github: AxiosInstance,
  username: string,
  apiCalls: ReturnType<typeof getApiCallsCounter>,
  searchCalls: ReturnType<typeof getApiCallsCounter>
): Promise<CachedUserAnalysis> {
  const cacheFile = getUserCacheFile(username);

  // Try cache first
  try {
    const raw = await fs.readFile(cacheFile, "utf-8");
    const cached = JSON.parse(raw) as CachedUserAnalysis;
    console.log(`Using cached analysis for @${username} (${cached.timestamp})`);
    return cached;
  } catch {
    console.log(`No cache for @${username} — full analysis required`);
  }

  // ── Full analysis (only runs once or on cache miss) ───────────────────────
  const reposSet = await discoverRepos(github, username, apiCalls, searchCalls);
  const reposToAnalyze = Array.from(reposSet).slice(0, MAX_REPOS_TO_ANALYZE);

  console.log(`Total unique repositories discovered: ${reposSet.size}`);
  console.log(`Analyzing up to ${MAX_REPOS_TO_ANALYZE} repositories`);

  const { repoAnalyses, totalCommits, totalPRs } = await analyzeRepos(
    github,
    username,
    reposToAnalyze,
    apiCalls
  );

  // Aggregate ALL evidence links
  const allEvidenceLinks: string[] = [];
  Object.values(repoAnalyses).forEach((a) => {
    allEvidenceLinks.push(...a.evidence);
  });

  const aggregated = aggregateAnalysis(repoAnalyses);

  const cacheData: CachedUserAnalysis = {
    timestamp: new Date().toISOString(),
    username,
    reposCount: reposSet.size,
    analyzedRepos: reposToAnalyze.length,
    totalCommits,
    totalPRs,
    langPercentages: aggregated.langPercentages.split("\n"),
    topDependencies: aggregated.topDeps,
    topFileTypes: aggregated.topFileTypes,
    allEvidenceLinks,
    reposToAnalyze,
  };

  await fs.writeFile(cacheFile, JSON.stringify(cacheData, null, 2));
  console.log(
    `Saved full analysis cache for @${username} (${allEvidenceLinks.length} evidence links)`
  );

  return cacheData;
}

// ── Discover repos ───────────────────────────────────────────────────────────
async function discoverRepos(
  github: AxiosInstance,
  username: string,
  apiCalls: ReturnType<typeof getApiCallsCounter>,
  searchCalls: ReturnType<typeof getApiCallsCounter>
) {
  const repos = new Set<string>();

  // Owned/member repos
  let page = 1;
  while (true) {
    const res = await github.get(
      `/user/repos?type=all&per_page=100&page=${page}`
    );
    apiCalls.increment();
    const data = res.data;
    if (data.length === 0) break;
    data.forEach((r: any) => repos.add(r.full_name));
    page++;
  }

  // Commits search
  page = 1;
  while (true) {
    try {
      if (page * 100 > 1000) break;
      const res = await github.get(
        `/search/commits?q=author:${username}&per_page=100&page=${page}`
      );
      searchCalls.increment();
      const data = res.data;
      if (data.items?.length === 0) break;
      data.items.forEach((item: any) => repos.add(item.repository.full_name));
      page++;
    } catch (err: any) {
      if (err.response?.status === 422) break;
      throw err;
    }
  }

  // PRs search
  page = 1;
  while (true) {
    try {
      if (page * 100 > 1000) break;
      const res = await github.get(
        `/search/issues?q=author:${username}+type:pr&per_page=100&page=${page}`
      );
      searchCalls.increment();
      const data = res.data;
      if (data.items?.length === 0) break;
      data.items.forEach((item: any) => {
        const repo = item.repository_url.replace(
          "https://api.github.com/repos/",
          ""
        );
        repos.add(repo);
      });
      page++;
    } catch (err: any) {
      if (err.response?.status === 422) break;
      throw err;
    }
  }

  return repos;
}

// ── Analyze repos ────────────────────────────────────────────────────────────
async function analyzeRepos(
  github: AxiosInstance,
  username: string,
  repos: string[],
  apiCalls: ReturnType<typeof getApiCallsCounter>
) {
  const repoAnalyses: Record<string, RepoAnalysis> = {};
  let totalCommits = 0;
  let totalPRs = 0;

  for (const repo of repos) {
    console.log(`Analyzing: ${repo}`);
    const analysis: RepoAnalysis = {
      languages: {},
      dependencies: new Set(),
      fileTypes: new Set(),
      commitCount: 0,
      prCount: 0,
      evidence: [],
    };

    // Languages
    try {
      const res = await github.get(`/repos/${repo}/languages`);
      analysis.languages = res.data;
    } catch {}

    // Commits
    try {
      let page = 1;
      while (true) {
        const res = await github.get(
          `/repos/${repo}/commits?author=${username}&per_page=100&page=${page}`
        );
        apiCalls.increment();
        const data = res.data;
        if (data.length === 0) break;
        analysis.commitCount += data.length;

        for (const commit of data) {
          try {
            const detail = await github.get(
              `/repos/${repo}/commits/${commit.sha}`
            );
            apiCalls.increment();
            for (const file of detail.data.files || []) {
              const ext = path.extname(file.filename).slice(1);
              if (ext) analysis.fileTypes.add(ext);
            }
            analysis.evidence.push(commit.html_url);
          } catch {}
        }
        page++;
      }
    } catch (err: any) {
      if (err.response?.status === 409) {
        console.log(`  ${repo} is empty — skipping commits`);
      } else {
        console.warn(`Commits fetch error: ${err.message}`);
      }
    }

    // PRs
    try {
      let page = 1;
      while (true) {
        const res = await github.get(
          `/repos/${repo}/pulls?creator=${username}&state=all&per_page=100&page=${page}`
        );
        apiCalls.increment();
        const data = res.data;
        if (data.length === 0) break;
        analysis.prCount += data.length;
        data.forEach((pr: any) => analysis.evidence.push(pr.html_url));
        page++;
      }
    } catch {}

    // Dependencies
    for (const file of ["package.json", "requirements.txt", "pom.xml"]) {
      try {
        const res = await github.get(`/repos/${repo}/contents/${file}`);
        apiCalls.increment();
        const content = Buffer.from(res.data.content, "base64").toString(
          "utf-8"
        );
        let deps: string[] = [];
        if (file === "package.json") {
          const json = JSON.parse(content);
          deps = [
            ...Object.keys(json.dependencies || {}),
            ...Object.keys(json.devDependencies || {}),
          ];
        } else if (file === "requirements.txt") {
          deps = content
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"));
        } else if (file === "pom.xml") {
          const matches =
            content.match(/<artifactId>(.*?)<\/artifactId>/g) || [];
          deps = matches.map((m) =>
            m.replace(/<artifactId>|<\/artifactId>/g, "")
          );
        }
        deps.forEach((d) => analysis.dependencies.add(d));
      } catch {}
    }

    repoAnalyses[repo] = analysis;
    totalCommits += analysis.commitCount;
    totalPRs += analysis.prCount;
  }

  return { repoAnalyses, totalCommits, totalPRs };
}

// ── Aggregate analysis data ─────────────────────────────────────────────────
function aggregateAnalysis(repoAnalyses: Record<string, RepoAnalysis>) {
  const allLanguages = new Map<string, number>();
  const allDependencies = new Set<string>();
  const allFileTypes = new Set<string>();
  const allEvidence: string[] = [];

  Object.values(repoAnalyses).forEach((a) => {
    Object.entries(a.languages).forEach(([lang, bytes]) => {
      allLanguages.set(lang, (allLanguages.get(lang) || 0) + bytes);
    });
    a.dependencies.forEach((dep) => allDependencies.add(dep));
    a.fileTypes.forEach((ft) => allFileTypes.add(ft));
    allEvidence.push(...a.evidence);
  });

  const totalBytes =
    Array.from(allLanguages.values()).reduce((s, b) => s + b, 0) || 1;
  const langPercentages = Array.from(allLanguages.entries())
    .map(([l, b]) => `${l}: ${((b / totalBytes) * 100).toFixed(2)}%`)
    .join("\n");

  const topDeps = Array.from(allDependencies).slice(0, 80);
  const topFileTypes = Array.from(allFileTypes).slice(0, 20);

  // Diverse evidence
  const diverse: string[] = [];
  const prLinks = allEvidence.filter((l) => l.includes("/pull/"));
  const commitLinks = allEvidence.filter((l) => l.includes("/commit/"));
  diverse.push(...prLinks.slice(0, 8));
  diverse.push(...commitLinks.slice(0, 10));
  if (diverse.length < 15) {
    const rest = allEvidence.filter((l) => !diverse.includes(l));
    diverse.push(...rest.slice(0, 15 - diverse.length));
  }
  diverse.sort(() => Math.random() - 0.5);
  const evidenceSample = diverse.slice(0, 20);

  return {
    langPercentages,
    topDeps,
    topFileTypes,
    evidenceSample,
  };
}

// ── Random Diverse Evidence Links ─────────────────────────────────────────────────
function getFreshEvidenceSample(
  allLinks: string[],
  maxLinks: number = 12
): string {
  if (allLinks.length <= maxLinks) {
    return allLinks.join("\n");
  }

  // Group by repo
  const byRepo = new Map<string, string[]>();

  allLinks.forEach((link) => {
    const repoMatch = link.match(
      /github\.com\/([^/]+\/[^/]+)(?:\/commit|\/pull)/
    );
    const repo = repoMatch ? repoMatch[1] : "unknown";
    if (!byRepo.has(repo)) byRepo.set(repo, []);
    byRepo.get(repo)!.push(link);
  });

  const selected: string[] = [];

  // Priority 1: PRs (richer context)
  for (const links of byRepo.values()) {
    const prLink = links.find((l) => l.includes("/pull/"));
    if (prLink && selected.length < maxLinks) selected.push(prLink);
  }

  // Priority 2: Commits
  for (const links of byRepo.values()) {
    const commitLink = links.find(
      (l) => l.includes("/commit/") && !selected.includes(l)
    );
    if (commitLink && selected.length < maxLinks) selected.push(commitLink);
  }

  // Fill remaining randomly from leftover
  const remaining = allLinks.filter((l) => !selected.includes(l));
  while (selected.length < maxLinks && remaining.length > 0) {
    const idx = Math.floor(Math.random() * remaining.length);
    selected.push(remaining.splice(idx, 1)[0]);
  }

  // Shuffle final selection
  for (let i = selected.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [selected[i], selected[j]] = [selected[j], selected[i]];
  }

  return selected.slice(0, maxLinks).join("\n");
}

// ── Build prompt ─────────────────────────────────────────────────────────────
function buildPrompt(
  analysis: CachedUserAnalysis & { evidenceSample: string },
  allSkills: Skill[]
) {
  const langPercentages = analysis.langPercentages.join("\n");
  const depsList = analysis.topDependencies.slice(0, 40).join(", ");
  const fileTypesList = analysis.topFileTypes.join(", ");
  const skillNames = allSkills
    .slice(0, 60) // reduce list size dramatically
    .map((s) => s.name)
    .join(", ");

  return `
  GitHub summary:
  Languages: ${langPercentages}
  Key deps: ${depsList}
  File types: ${fileTypesList}
  Commits: ${analysis.totalCommits} | PRs: ${analysis.totalPRs}
  Fresh sample links (use 1–2 in reasons when relevant): ${analysis.evidenceSample}
  
  Recommend **exactly 5–10** skills **ONLY** from this list — use as many strong matches as possible:
  ${skillNames}
  
  Rules (must obey):
    - name: EXACT match (case-sensitive) from the list — NO other names.
    - score: 0–100 based on how strongly evidence matches.
    - reason: 1–2 sentences with **specific evidence**:
        - ALWAYS include 1–2 deps/file types (e.g. tailwindcss, .tsx/.ts files)
        - ALWAYS include 1 relevant link from sample links when it supports the reason
        - Explain why this leads to the score (e.g. "multiple packages + high usage → 92")
  
  Output ONLY JSON array — nothing else.`;
}

// ── Call LLM ─────────────────────────────────────────────────────────────────
async function callLLM(prompt: string): Promise<string> {
  const provider = LLM_PROVIDER;
  // ── Unified OpenAI-compatible providers ──────────────────────────────────
  if (provider === "huggingface_router" || provider === "ollama") {
    let baseURL: string;
    let apiKey: string;
    let model: string;

    if (provider === "huggingface_router") {
      baseURL = "https://router.huggingface.co/v1";
      apiKey = HUGGINGFACE_TOKEN!;
      model = process.env.HF_MODEL || "openai/gpt-oss-120b:groq";
      console.log(`Querying Hugging Face router: ${model}`);
    } else {
      // ollama (local)
      baseURL = "http://localhost:11434/v1/";
      apiKey = "ollama"; // dummy — ignored locally
      model = process.env.OLLAMA_MODEL || "gpt-oss:120b";
      console.log(`Querying local Ollama: ${model} @ ${baseURL}`);
    }

    const client = new OpenAI({apiKey, baseURL});

    const completion = await client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      max_tokens: 1600,
      stream: false,
    });

    return completion.choices[0]?.message?.content || "";
  }

  // ── Ollama Cloud ───────────────────────────────────────────────
  else if (provider === "ollama_cloud") {
    const apiKey = OLLAMA_API_KEY;
    const model = process.env.OLLAMA_MODEL || "gpt-oss:120b";

    console.log(`Querying Ollama Cloud: ${model}`);

    const ollama = new Ollama({
      host: "https://api.ollama.com",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    const response = await ollama.chat({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    });

    return response.message.content || "";
  }

  throw new Error(`Unsupported LLM provider: ${provider}`);
}

// ── Parse & map recommendations ──────────────────────────────────────────────
function parseAndMapRecommendations(
  raw: string,
  allSkills: Skill[]
): Recommendation[] {
  let cleaned = raw.trim();

  // Step 1: Remove common markdown/code fences
  cleaned = cleaned.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "");

  // Step 2: Extract the array part only (between first [ and last ])
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    cleaned = cleaned.substring(firstBracket, lastBracket + 1);
  }

  // Step 3: Remove trailing commas before closing ]
  cleaned = cleaned.replace(/,\s*]/g, "]");

  // Step 4: If array is unclosed, find the last complete object and force-close
  if (!cleaned.endsWith("]")) {
    // Find last complete object (last '}' before potential garbage)
    const lastCloseBrace = cleaned.lastIndexOf("}");
    if (lastCloseBrace !== -1) {
      // Cut after last complete object and close array
      cleaned = cleaned.substring(0, lastCloseBrace + 1) + "]";
    } else {
      // Desperate recovery: just close it
      cleaned += "]";
    }
  }

  // Step 5: Remove any trailing garbage after final ]
  const finalClose = cleaned.lastIndexOf("]");
  if (finalClose !== -1) {
    cleaned = cleaned.substring(0, finalClose + 1);
  }

  // Debug: show what we ended up with
  console.log("\n=== FINAL CLEANED JSON FOR PARSING ===");
  console.log(cleaned);
  console.log("=======================================\n");

  try {
    const parsed = JSON.parse(cleaned);

    if (!Array.isArray(parsed)) {
      throw new Error("Parsed result is not an array");
    }

    const validRecs = parsed
      .filter(
        (item: any) =>
          item &&
          (typeof item.name === "string" || typeof item.skill === "string") &&
          typeof item.score === "number" &&
          typeof item.reason === "string"
      )
      .map((item: any) => {
        const cleanName = (item.name ?? item.skill)?.trim();
        const skill = allSkills.find(
          (s) => s.name.trim().toLowerCase() === cleanName?.toLowerCase()
        );

        if (!skill && cleanName) {
          console.warn(
            `Rejected hallucinated skill: "${cleanName}" (not in Topcoder list)`
          );
        }

        return skill
          ? {
              id: skill.id,
              name: skill.name,
              score: Math.max(0, Math.min(100, Math.round(item.score))),
              info: item.reason?.trim() || "No reason provided",
            }
          : null;
      })
      .filter((r): r is Recommendation => r !== null && r.score >= 40);

    console.log(
      `Parsed ${validRecs.length} valid / ${parsed.length} total recommendations (filtered non-matches)`
    );

    return validRecs;
  } catch (err: any) {
    console.error(
      "JSON parsing failed even after aggressive cleaning:",
      err.message
    );
    console.error("Final cleaned string:", cleaned);
    return [];
  }
}

// ── Display results ──────────────────────────────────────────────────────────
function displayResults(
  recommendations: Recommendation[],
  analysis: CachedUserAnalysis,
  totalApiCalls: number,
  startTime: number
) {
  console.log("\nRecommended Verified Skills:");
  recommendations.sort((a, b) => b.score - a.score);
  for (const r of recommendations) {
    console.log(`Skill ID: ${r.id}`);
    console.log(`Skill Name: ${r.name}`);
    console.log(`Score: ${r.score}`);
    console.log(`Why: ${r.info}`);
    console.log("---");
  }

  console.log("\nRun Summary:");
  console.log(`Repos discovered: ${analysis.reposCount}`);
  console.log(`Repos analyzed: ${analysis.analyzedRepos}`);
  console.log(`Commits: ${analysis.totalCommits} | PRs: ${analysis.totalPRs}`);
  console.log(`Total API calls: ${totalApiCalls}`);
  const elapsed = (Date.now() - startTime) / 1000;
  console.log(`Elapsed: ${elapsed.toFixed(2)} seconds`);

  exportResultsToFile(
    analysis.username,
    recommendations,
    analysis,
    totalApiCalls,
    elapsed
  );
}

// ── Export the results ──────────────────────────────────────────────────────────
async function exportResultsToFile(
  username: string,
  recommendations: Recommendation[],
  analysis: CachedUserAnalysis,
  totalApiCalls: number,
  elapsedSeconds: number
) {
  const dateStr = new Date().toISOString().split("T")[0];
  const outputFile = `skills-report-${username.toLowerCase()}-${dateStr}.txt`;

  const content = `
  GitHub Skills Recommendation Report
  Generated: ${new Date().toISOString()}
  User: @${username}
  
  Repos discovered: ${analysis.reposCount}
  Repos analyzed: ${analysis.analyzedRepos}
  Commits: ${analysis.totalCommits} | PRs: ${analysis.totalPRs}
  Total API calls: ${totalApiCalls}
  Elapsed time: ${elapsedSeconds.toFixed(2)} seconds
  
  Recommended Verified Skills:
  ${recommendations
    .sort((a, b) => b.score - a.score)
    .map(
      (r) =>
        `Skill ID: ${r.id}
  Skill Name: ${r.name}
  Score: ${r.score}
  Why: ${r.info}
  ---`
    )
    .join("\n\n")}
  
  Run Summary:
  Repos discovered: ${analysis.reposCount}
  Repos analyzed: ${analysis.analyzedRepos}
  Commits: ${analysis.totalCommits} | PRs: ${analysis.totalPRs}
  Total API calls: ${totalApiCalls}
  Elapsed: ${elapsedSeconds.toFixed(2)} seconds
  `;

  try {
    await fs.writeFile(outputFile, content.trim());
    console.log(`\nResults exported to: ${outputFile}`);
  } catch (err) {
    console.error(`Failed to export results to file: ${err}`);
  }
}

// ── Run ──────────────────────────────────────────────────────────────────────
main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
