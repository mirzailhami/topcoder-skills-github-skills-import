import axios, { AxiosInstance, AxiosResponse } from "axios";
import * as dotenv from "dotenv";
import OpenAI from "openai";
import * as path from "path";
import { promisify } from "util";
const sleep = promisify(setTimeout);

dotenv.config();

const max_repos = process.env.MAX_REPOS_TO_ANALYZE;
const MAX_REPOS_TO_ANALYZE = max_repos
  ? Math.max(1, Math.min(100, parseInt(max_repos, 10)))
  : 10;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const LLM_PROVIDER = process.env.LLM_PROVIDER;
const HUGGINGFACE_TOKEN = process.env.HUGGINGFACE_TOKEN;
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

if (!GITHUB_CLIENT_ID) {
  throw new Error("GITHUB_CLIENT_ID is required in .env");
}

if (LLM_PROVIDER === "huggingface_router" && !HUGGINGFACE_TOKEN) {
  throw new Error("HUGGINGFACE_TOKEN is required for huggingface provider");
}

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

async function main() {
  const startTime = Date.now();
  let apiCalls = 0;
  let searchCalls = 0;

  // ── Try to use existing token from .env first ───────────────────────────────
  let accessToken = process.env.GITHUB_ACCESS_TOKEN?.trim();

  if (accessToken) {
    console.log(
      "Using existing GitHub access token from .env (skipping browser authentication)"
    );
  } else {
    // ── Full Device Flow Authentication ───────────────────────────────────────
    console.log("Initiating GitHub authentication...");
    const codeResponse = await axios.post(
      "https://github.com/login/device/code",
      { client_id: GITHUB_CLIENT_ID, scope: "user repo" },
      { headers: { Accept: "application/json" } }
    );
    apiCalls++;

    const { device_code, user_code, verification_uri, interval, expires_in } =
      codeResponse.data;

    console.log(`\nPlease go to: ${verification_uri}`);
    console.log(`Enter this code: ${user_code}\n`);

    let authSuccess = false;
    const authStart = Date.now();

    while (!authSuccess && Date.now() - authStart < expires_in * 1000) {
      await sleep(interval * 1000);
      try {
        const tokenResponse = await axios.post(
          "https://github.com/login/oauth/access_token",
          {
            client_id: GITHUB_CLIENT_ID,
            device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          },
          { headers: { Accept: "application/json" } }
        );
        apiCalls++;

        const data = tokenResponse.data;
        if (data.access_token) {
          accessToken = data.access_token;
          authSuccess = true;

          // Print the token so user can copy-paste it into .env
          console.log(
            "\n╔════════════════════════════════════════════════════════════╗"
          );
          console.log(
            "║               AUTHENTICATION SUCCESSFUL                    ║"
          );
          console.log(
            "║                                                            ║"
          );
          console.log(
            `║  Your GitHub Access Token:                                 ║`
          );
          console.log(`║  ${accessToken}  ║`);
          console.log(
            "║                                                            ║"
          );
          console.log(
            "║  Copy the token above and add it to your .env file like:   ║"
          );
          console.log(
            "║  GITHUB_ACCESS_TOKEN=ghu_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx    ║"
          );
          console.log(
            "║  Future runs will skip this step until the token expires.  ║"
          );
          console.log(
            "╚════════════════════════════════════════════════════════════╝\n"
          );
        } else if (data.error !== "authorization_pending") {
          throw new Error(data.error_description || "Authentication failed");
        }
      } catch (err: any) {
        console.error("Polling error:", err.message);
      }
    }

    if (!accessToken) {
      throw new Error("Authentication timed out or failed");
    }
  }

  // ── Create GitHub client with the token ─────────────────────────────────────
  const github: AxiosInstance = axios.create({
    baseURL: "https://api.github.com",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  github.interceptors.response.use(async (res: AxiosResponse) => {
    apiCalls++;
    const remaining = parseInt(res.headers["x-ratelimit-remaining"] || "0", 10);
    const reset = parseInt(res.headers["x-ratelimit-reset"] || "0", 10);
    if (remaining < 10 && reset > 0) {
      const waitMs = reset * 1000 - Date.now() + 2000;
      if (waitMs > 0) {
        console.log(
          `Core API rate limit low (${remaining} left). Waiting ~${Math.round(
            waitMs / 1000
          )}s...`
        );
        await sleep(waitMs);
      }
    }
    return res;
  });

  async function checkSearchRateLimit() {
    const rate = await github.get("/rate_limit");
    apiCalls++;
    const search = rate.data.resources.search;
    if (search.remaining < 5 && search.reset) {
      const waitMs = search.reset * 1000 - Date.now() + 2000;
      if (waitMs > 0) {
        console.log(
          `Search API rate limit low (${
            search.remaining
          } left). Waiting ~${Math.round(waitMs / 1000)}s...`
        );
        await sleep(waitMs);
      }
    }
  }

  // ── Get authenticated user ──────────────────────────────────────────────────
  const user = await github.get("/user");
  const username = user.data.login;
  console.log(`Analyzing GitHub user: @${username}\n`);

  // ── Fetch Topcoder standardized skills ──────────────────────────────────────
  console.log("Fetching Topcoder skills list...");
  const allSkills: Skill[] = [];
  let page = 1;
  while (true) {
    const resp = await axios.get(
      `https://api.topcoder-dev.com/v5/standardized-skills/skills?page=${page}&perPage=100`
    );
    apiCalls++;
    allSkills.push(...resp.data.map((s: any) => ({ id: s.id, name: s.name })));

    const nextPage = resp.headers["x-next-page"];
    if (!nextPage) break;
    page = parseInt(nextPage, 10);
    console.log(
      `  Fetched page ${page - 1} (${allSkills.length} skills so far)`
    );
  }
  console.log(`Total skills loaded: ${allSkills.length}\n`);

  // ── Collect all contributed repositories ────────────────────────────────────
  const reposSet = new Set<string>();

  // 1. Repos user owns / is member of (no 1000 limit)
  console.log("Fetching owned & member repositories...");
  page = 1;
  while (true) {
    const resp = await github.get(
      `/user/repos?type=all&per_page=100&page=${page}`
    );
    const data = resp.data;
    if (data.length === 0) break;
    data.forEach((r: any) => reposSet.add(r.full_name));
    page++;
  }

  // 2. Repos from commits (capped at ~1000 results total)
  console.log("Fetching additional repos from commit history...");
  await checkSearchRateLimit();
  page = 1;
  let commitSearchLimited = false;
  while (true) {
    try {
      if (page * 100 > 1000) {
        console.warn(
          "GitHub commit search reached hard limit (~1000 results). Some older contributions may be missed."
        );
        commitSearchLimited = true;
        break;
      }

      const resp = await github.get(
        `/search/commits?q=author:${username}&per_page=100&page=${page}`
      );
      searchCalls++;
      const data = resp.data;

      if (data.items?.length === 0) break;

      data.items.forEach((item: any) =>
        reposSet.add(item.repository.full_name)
      );
      page++;

      await checkSearchRateLimit();
    } catch (err: any) {
      if (
        err.response?.status === 422 &&
        err.response?.data?.message?.includes("Only the first 1000")
      ) {
        console.warn(
          "GitHub commit search hit 1000-result limit. Stopping commit search."
        );
        commitSearchLimited = true;
        break;
      }
      throw err;
    }
  }

  // 3. Repos from pull requests (also capped at ~1000)
  console.log("Fetching additional repos from pull requests...");
  await checkSearchRateLimit();
  page = 1;
  let prSearchLimited = false;
  while (true) {
    try {
      if (page * 100 > 1000) {
        console.warn(
          "GitHub PR search reached hard limit (~1000 results). Some older PRs may be missed."
        );
        prSearchLimited = true;
        break;
      }

      const resp = await github.get(
        `/search/issues?q=author:${username}+type:pr&per_page=100&page=${page}`
      );
      searchCalls++;
      const data = resp.data;

      if (data.items?.length === 0) break;

      data.items.forEach((item: any) => {
        const repo = item.repository_url.replace(
          "https://api.github.com/repos/",
          ""
        );
        reposSet.add(repo);
      });

      page++;

      await checkSearchRateLimit();
    } catch (err: any) {
      if (
        err.response?.status === 422 &&
        err.response?.data?.message?.includes("Only the first 1000")
      ) {
        console.warn(
          "GitHub PR search hit 1000-result limit. Stopping PR search."
        );
        prSearchLimited = true;
        break;
      }
      throw err;
    }
  }

  const repos = Array.from(reposSet);
  const reposToAnalyze = repos.slice(0, MAX_REPOS_TO_ANALYZE);

  console.log(`Total unique repositories discovered: ${repos.length}`);
  console.log(
    `Analyzing up to ${MAX_REPOS_TO_ANALYZE} repositories (MAX_REPOS_TO_ANALYZE=${MAX_REPOS_TO_ANALYZE})`
  );
  if (commitSearchLimited || prSearchLimited) {
    console.log(
      "  Note: Some repos may be missing due to GitHub Search API 1000-result limit"
    );
  }

  // Analyze each repository
  interface RepoAnalysis {
    languages: Record<string, number>;
    dependencies: Set<string>;
    fileTypes: Set<string>;
    commitCount: number;
    prCount: number;
    evidence: string[]; // Links to commits, PRs, etc.
  }

  const repoAnalyses: Record<string, RepoAnalysis> = {};
  let totalCommits = 0;
  let totalPRs = 0;

  for (const repo of reposToAnalyze) {
    console.log(`Analyzing repository: ${repo}`);
    const analysis: RepoAnalysis = {
      languages: {},
      dependencies: new Set(),
      fileTypes: new Set(),
      commitCount: 0,
      prCount: 0,
      evidence: [],
    };

    // Get languages
    try {
      const langsResponse = await github.get(`/repos/${repo}/languages`);
      analysis.languages = langsResponse.data;
    } catch (error) {
      console.warn(`Failed to get languages for ${repo}`);
    }

    // Get commits by user
    console.log(`  Fetching commits for ${repo}...`);
    try {
      let commitPage = 1;
      while (true) {
        const commitsResponse = await github.get(
          `/repos/${repo}/commits?author=${username}&per_page=100&page=${commitPage}`
        );
        const commitsData = commitsResponse.data;
        if (commitsData.length === 0) break;

        analysis.commitCount += commitsData.length;

        for (const commit of commitsData) {
          try {
            const commitDetail = await github.get(
              `/repos/${repo}/commits/${commit.sha}`
            );
            for (const file of commitDetail.data.files || []) {
              const ext = path.extname(file.filename).slice(1);
              if (ext) analysis.fileTypes.add(ext);
            }
            analysis.evidence.push(commit.html_url);
          } catch (detailErr: any) {
            console.warn(
              `  Failed commit detail in ${repo}: ${detailErr.message}`
            );
          }
        }
        commitPage++;
      }
    } catch (err: any) {
      if (
        err.response?.status === 409 &&
        err.response?.data?.message?.includes("Git Repository is empty")
      ) {
        console.log(
          `  Skipping commits for ${repo} — repository is empty (no commits).`
        );
        // We can still try to fetch PRs / languages / deps below if useful
      } else {
        console.warn(`  Error fetching commits from ${repo}: ${err.message}`);
      }
    }

    // Get PRs by user
    console.log(`  Fetching PRs for ${repo}...`);
    let prPage = 1;
    while (true) {
      const prsResponse = await github.get(
        `/repos/${repo}/pulls?creator=${username}&state=all&per_page=100&page=${prPage}`
      );
      const prsData = prsResponse.data;
      if (prsData.length === 0) break;
      analysis.prCount += prsData.length;
      prsData.forEach((pr: any) => analysis.evidence.push(pr.html_url));
      prPage++;
    }

    // Get dependencies from common files
    const depFiles = ["package.json", "requirements.txt", "pom.xml"]; // Add more as needed
    for (const file of depFiles) {
      try {
        const contentResponse = await github.get(
          `/repos/${repo}/contents/${file}`
        );
        const content = Buffer.from(
          contentResponse.data.content,
          "base64"
        ).toString("utf-8");
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
          // Simple parse for dependencies
          const matches =
            content.match(/<artifactId>(.*?)<\/artifactId>/g) || [];
          deps = matches.map((m) =>
            m.replace(/<artifactId>|<\/artifactId>/g, "")
          );
        }
        deps.forEach((d) => analysis.dependencies.add(d));
      } catch (error) {
        // File not found, skip
      }
    }

    repoAnalyses[repo] = analysis;
    totalCommits += analysis.commitCount;
    totalPRs += analysis.prCount;
  }

  // Aggregate data for AI prompt
  const allLanguages = new Map<string, number>();
  const allDependencies = new Set<string>();
  const allFileTypes = new Set<string>();
  const allEvidence: string[] = [];

  for (const analysis of Object.values(repoAnalyses)) {
    for (const [lang, bytes] of Object.entries(analysis.languages)) {
      allLanguages.set(lang, (allLanguages.get(lang) || 0) + bytes);
    }
    analysis.dependencies.forEach((dep) => allDependencies.add(dep));
    analysis.fileTypes.forEach((ft) => allFileTypes.add(ft));
    allEvidence.push(...analysis.evidence);
  }

  const totalBytes =
    Array.from(allLanguages.values()).reduce((sum, b) => sum + b, 0) || 1;
  const langPercentages = Array.from(allLanguages.entries())
    .map(
      ([lang, bytes]) => `${lang}: ${((bytes / totalBytes) * 100).toFixed(2)}%`
    )
    .join("\n");

  const depsList = Array.from(allDependencies).slice(0, 80).join(", ");
  const fileTypesList = Array.from(allFileTypes).join(", ");

  // collect diverse links, max 15–20 total
  const diverseEvidence: string[] = [];

  // Prefer PRs first
  const allPRLinks = allEvidence.filter((link) => link.includes("/pull/"));
  const allCommitLinks = allEvidence.filter((link) =>
    link.includes("/commit/")
  );

  // Take up to 8 PRs + up to 10 commits, from different repos if possible
  diverseEvidence.push(...allPRLinks.slice(0, 8));
  diverseEvidence.push(...allCommitLinks.slice(0, 10));

  // If still short, add any remaining
  if (diverseEvidence.length < 15) {
    const remaining = allEvidence.filter(
      (link) => !diverseEvidence.includes(link)
    );
    diverseEvidence.push(...remaining.slice(0, 15 - diverseEvidence.length));
  }

  // Shuffle lightly to avoid bias toward one repo
  diverseEvidence.sort(() => Math.random() - 0.5);

  const evidenceSample = diverseEvidence.slice(0, 20).join("\n");

  // Prepare prompt for LLM
  const skillNames = allSkills.slice(0, 50).map(s => s.name).join(", ");
  const prompt = `
Given GitHub activity summary:

Languages & %:
${langPercentages}

Key dependencies:
${depsList}

File types:
${fileTypesList}

Commits: ${totalCommits} | PRs: ${totalPRs}

Sample repos & links:
${reposToAnalyze.slice(0, 20).map(r => `https://github.com/${r}`).join("\n")}
${evidenceSample}

Recommend 8–12 most relevant skills from this exact list: ${skillNames}

For each recommended skill, provide:
- name: **exact** skill name from the list (case-sensitive match required)
- score: confidence score (0-100)
- reason: concise explanation why this skill matches, referencing languages, dependencies, file types, commits/PRs or links when relevant

Only include links if they directly support the reason — do not list them randomly.
You MUST respond with **ONLY** a valid JSON array — nothing before it, nothing after it, no explanations, no markdown, no code blocks, no introductory text, no trailing commas.

Example (do NOT copy):
[{"name":"Angular Components","score":92,"reason":"Many @angular/* packages and .ts files"},{"name":"UI/UX Research","score":78,"reason":"Tailwind + Radix UI usage across repos"}]

Your response begins and ends with the JSON array
`;

  console.log("Querying LLM for skill recommendations...");

  let llmResponse: string;
  if (LLM_PROVIDER === "huggingface_router") {
    const HF_MODEL = process.env.HF_MODEL || "openai/gpt-oss-120b:novita";

    const openaiCompatible = new OpenAI({
      apiKey: HUGGINGFACE_TOKEN,
      baseURL: "https://router.huggingface.co/v1",
    });

    console.log(`Querying Hugging Face router with model: ${HF_MODEL} ...`);

    console.log(`Prompt payload: ${prompt}`);
    console.log(`Prompt length: ${prompt.length} chars (~${Math.round(prompt.length / 4)} tokens)`);

    const completion = await openaiCompatible.chat.completions.create({
      model: HF_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 2000, // adjust based on needs (gpt-oss-120b supports long context)
      stream: false,
    });

    llmResponse = completion.choices[0].message.content || "";
  } else if (LLM_PROVIDER === "ollama") {
    const ollamaResponse = await axios.post(`${OLLAMA_URL}/api/chat`, {
      model: "llama2", // or your preferred model
      messages: [{ role: "user", content: prompt }],
      stream: false,
    });
    llmResponse = ollamaResponse.data.message.content || "";
  } else {
    throw new Error(`Unsupported LLM provider: ${LLM_PROVIDER}`);
  }

  // Parse LLM response with robust cleaning
  let aiRecs: { name: string; score: number; reason: string }[] = [];
  let cleaned = llmResponse.trim();

  console.log("\n=== RAW LLM RESPONSE ===");
  console.log(llmResponse);
  console.log("=========================\n");

  // Remove markdown fences
  cleaned = cleaned.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "");

  // Remove any non-JSON prefix/suffix
  const arrayStart = cleaned.indexOf("[");
  const arrayEnd = cleaned.lastIndexOf("]");
  if (arrayStart !== -1 && arrayEnd !== -1 && arrayEnd > arrayStart) {
    cleaned = cleaned.substring(arrayStart, arrayEnd + 1);
  }

  // Fix trailing comma before ]
  cleaned = cleaned.replace(/,\s*]$/, "]");

  // Try to close incomplete last object
  if (!cleaned.endsWith("]")) {
    const lastObjStart = cleaned.lastIndexOf("{");
    if (lastObjStart !== -1) {
      // Cut off after last complete object if possible
      const prevClose = cleaned.lastIndexOf("}", lastObjStart);
      if (prevClose !== -1) {
        cleaned = cleaned.substring(0, prevClose + 1) + "}]";
      } else {
        cleaned += '"}]';
      }
    }
  }

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) {
      aiRecs = parsed.filter(
        (item) => item?.name && typeof item.score === "number" && item?.reason
      );
      console.log(
        `Parsed ${aiRecs.length} valid recommendations after aggressive cleaning`
      );
    }
  } catch (err: any) {
    console.error("Parsing still failed:", err.message);
    console.error("Final cleaned string:", cleaned);
    aiRecs = [];
  }

  // Map to recommendations with IDs
  const recommendations: Recommendation[] = [];
  for (const rec of aiRecs) {
    const skill = allSkills.find(
      (s) => s.name.toLowerCase() === rec.name.toLowerCase()
    );
    if (skill) {
      recommendations.push({
        id: skill.id,
        name: skill.name,
        score: rec.score,
        info: rec.reason,
      });
    }
  }

  // Sort by score descending
  recommendations.sort((a, b) => b.score - a.score);

  // Output recommendations
  console.log("\nRecommended Verified Skills:");
  for (const rec of recommendations) {
    console.log(`Skill ID: ${rec.id}`);
    console.log(`Skill Name: ${rec.name}`);
    console.log(`Confidence Score: ${rec.score}`);
    console.log(`Why: ${rec.info}`);
    console.log("---");
  }

  // Run summary
  console.log("\nRun Summary:");
  console.log(`Repos scanned: ${Object.keys(repoAnalyses).length}`);
  console.log(
    `Contributions inspected: ${totalCommits} commits, ${totalPRs} PRs`
  );
  console.log(`Total API calls: ${apiCalls + searchCalls}`);
  console.log(
    `Elapsed time: ${((Date.now() - startTime) / 1000).toFixed(2)} seconds`
  );
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
