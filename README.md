# GitHub to Topcoder Skills Recommender CLI App

## Overview
This is a proof-of-concept command-line application written in TypeScript that authenticates a user with GitHub using the device authorization flow, analyzes their GitHub activity (including private repositories), and recommends verified skills from the Topcoder standardized skills API. Recommendations are generated using an AI model via Hugging Face router or Ollama (local or cloud), with confidence scores and detailed, evidence-based reasoning.

The app performs a deep analysis by:
- Discovering all contributed repositories (owned, member, commits, PRs)
- Aggregating languages, dependencies, file types, and **all** evidence links
- Caching results for fast subsequent runs
- Generating a **fresh, diverse evidence sample** for each LLM query → different results possible
- Exporting full report to text file

## Technology Stack
- TypeScript (Node.js)
- Axios for HTTP requests
- OpenAI SDK (for Hugging Face router + local Ollama)
- ollama library (for Ollama Cloud)
- fs/promises for caching & export
- Dotenv for configuration

## Installation

1. Clone the repository:
```
git clone https://github.com/mirzailhami/topcoder-skills-github-skills-import
cd topcoder-skills-github-skills-import
```
2. Install dependencies:
```
npm install typescript axios dotenv openai @types/node ts-node ollama
```
3. Create a `.env` file in the root directory (copy from `.env.example`) with the following:
```
# Analysis limits
MAX_REPOS_TO_ANALYZE=30
EVIDENCE_SAMPLE_SIZE=10           # links shown in prompt (fresh sample each run)

# GitHub OAuth App Client ID (required)
GITHUB_CLIENT_ID=your_github_oauth_client_id

# Reuse token after first run (skip browser auth)
GITHUB_ACCESS_TOKEN=ghu_...

# LLM provider: huggingface_router | ollama | ollama_cloud
LLM_PROVIDER=huggingface_router

# Hugging Face router (recommended for quality + evidence links)
HUGGINGFACE_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
HF_MODEL=openai/gpt-oss-120b:groq

# Local Ollama (when available)
# LLM_PROVIDER=ollama
# OLLAMA_URL=http://localhost:11434/v1/   # optional
# OLLAMA_MODEL=gpt-oss:120b

# Ollama Cloud (fallback for cloud inference)
# LLM_PROVIDER=ollama_cloud
# OLLAMA_API_KEY=ollama_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
# OLLAMA_MODEL=gpt-oss:120b
```

- To obtain `GITHUB_CLIENT_ID`:
  - Go to GitHub Settings → Developer settings → OAuth Apps → New OAuth App.
  - Set Homepage URL to any valid URL (e.g., http://localhost).
  - Set Authorization callback URL to http://localhost
  - Check the **Enable Device Flow**
  - Register the app and copy the Client ID.

4. If using Ollama:
- Local Ollama: Install from [](https://ollama.com) → `ollama pull gpt-oss:120b`
- Ollama Cloud: Sign up at [](https://ollama.com/cloud) → generate API key

## Running the App

Basic run (uses cache after first execution):
```
npm run dev
```

Force full re-analysis (ignore cache):
- Delete .cache/github-yourusername.json

## Features & How It Meets Requirements

### Authentication & GitHub API
- Device flow (CLI-friendly)
- Scope: `user repo` → private repos & activity
- Handles rate limits:
  - Core API: checks `x-ratelimit-remaining` per response
  - Search API: checks `/rate_limit` endpoint before searches
- Automatically waits and resumes when limits are hit
- Caches token in `.env` for future runs

### Topcoder Skills API
- Fetches all skills from: [https://api.topcoder-dev.com/v5/standardized-skills/skills](https://api.topcoder-dev.com/v5/standardized-skills/skills)
- Fetched once and cached forever (`topcoder-skills.json`)
- All recommendations use exact `id` & `name` from API

### Analysis Depth
- Discovers repos via owned/member + commits/PRs search
- Per-repo: languages, user commits/PRs, common deps files
- Aggregates: language %, top deps, file types, all evidence links
- Caches full analysis per user (`github-username.json`)

### LLM & Recommendations
- Providers: Hugging Face router, local Ollama, Ollama Cloud — switch via `.env`
- Collects **all** repositories user contributed to (not just owned):
  - `/user/repos` (owned + member/org)
  - `/search/commits` author:username
  - `/search/issues` author:username type:pr
- For each repo:
  - Language breakdown (`/repos/:repo/languages`)
  - User-specific commits + changed file extensions
  - User-specific pull requests
  - Common dependency files: package.json, requirements.txt, pom.xml
- Aggregates:
  - Language percentages
  - All dependencies used
  - File types touched
  - Evidence links (commit/PR URLs)
- Uses LLM (Hugging Face OpenAI or Ollama) to match activity → Topcoder skills
  - Sends aggregated stats + sample evidence links
  - Asks for up to 20 recommendations with score + detailed reasoning
- Prompt forces exact skill names + evidence-based reasons
- Fresh diverse evidence sample (10–12 links) generated every run → different results possible
- Parsing + cleaning handles model quirks (truncation, trailing commas, wrong keys)
- Output: Skill ID, name, score, detailed why (deps, files, links, confidence reason)

### Output & Export
- Console: recommendations + run summary
- File export: `skills-report-username-YYYY-MM-DD.txt`
- Includes full report: header, recommendations, summary

## LLM & Model Notes / Limitations
- Hugging Face router (OpenAI-compatible): best for quality + link inclusion
  - Recommended: `openai/gpt-oss-120b:groq`
- Local Ollama: fast & free when hardware allows
- Ollama Cloud: reliable cloud fallback
  - Recommended: `gpt-oss:120b` or `llama3.1:8b`
- Large models may truncate or hallucinate → aggressive parsing recovers most results
- If empty/inaccurate: reduce `MAX_REPOS_TO_ANALYZE=5–10` or `EVIDENCE_SAMPLE_SIZE=8`
- Evidence links: fresh random/diverse sample each run (size via `.env`)

## Troubleshooting
- No recommendations → try different model or smaller `MAX_REPOS_TO_ANALYZE`
- Parsing failed → check console for "Rejected hallucinated skill" or cleaned JSON
- Rate limit hit → wait or reduce repos
- Want fresh results → delete `.cache/github-yourusername.json`
- Ollama Cloud error → verify `OLLAMA_API_KEY`
- Local Ollama not working → ensure `ollama serve` is running