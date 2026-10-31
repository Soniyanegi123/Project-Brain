# Project Brain: AI Engineering Memory & Change Intelligence

**INNOVISTA | 36-Hour Hackathon | Problem Statement 06**

> Understand why code exists. Discover what could break when it changes.

Project Brain combines repository history and source files in a local Flask/SQLite workspace. It supports evidence retrieval, decision discovery, relationship exploration, heuristic change-impact analysis, and contributor-risk signals.

## Problem Statement Coverage

| Requirement | Implementation |
|---|---|
| Project history | Bounded, paginated GitHub import for commits, issues and pull requests; ZIP source/document indexing |
| Decision memory | SQLite decision records extracted from ADR-style documentation and decision-signalling commit messages, with rationale fields, affected files, source status, preserved versions and conflict evidence |
| Connected memory | Interactive, force-laid-out SVG graph with provenance-labelled issue, file, decision, directory-component and dependency relationships; search, type filters, node details, drag, pan, zoom, fit and reset |
| Question answering | Persistent embedding cache and hybrid semantic/lexical retrieval when an OpenAI key is configured; keyword evidence fallback otherwise |
| Change impact | Python AST import resolution, lightweight JS/TS import matching, co-change history and test-file signals |
| Knowledge at risk | Contributor concentration and activity-recency estimates with evidence fields |

## Important Limits

Impact and risk results are estimates, not proof. Python imports are parsed with `ast`; JS/TS imports are resolved with lightweight local-path matching. Dynamic imports, reflection, generated code, runtime behavior and external services are not modeled.

GitHub import is intentionally bounded. A response reports complete or partial coverage and explains missing details. ZIP import indexes files only; it does not import Git history. The graph prioritizes connected records and caps the response at 250 nodes and 600 relationships without deleting stored project data. It hides isolated nodes by default, shows at most 20 recent commits unless older commits are enabled, and derives directory components from indexed file paths. Decision Memory extracts explicit ADR/document fields and candidates from decision-signalling commit messages. Only explicit accepted/approved/implemented statuses are marked verified; other candidates are uncertain. Missing context, rationale and rejected alternatives remain blank or are shown as not documented. Updated records are versioned, and superseding/conflict links retain their source evidence. Conflict detection uses local keyword and opposing-term heuristics and is advisory, not proof of contradiction.

## Run Locally

1. Install Python 3.10 or newer.
2. Open the `project_brain` directory in VS Code.
3. Create and activate a virtual environment:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

   If PowerShell blocks activation, run:

   ```powershell
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
   .\.venv\Scripts\Activate.ps1
   ```

4. Install dependencies:

   ```powershell
   python -m pip install -r requirements.txt
   ```

5. Start the server:

   ```powershell
   python app.py
   ```

6. Open <http://127.0.0.1:5000>.

Every application startup selects an empty active workspace. Previously imported repository rows remain stored but are not automatically selected. Select **Reset Demo** to intentionally activate the separate sample workspace; it does not overwrite imported repository data. Install test tools and run the automated suite with `python -m pip install -r requirements-dev.txt` followed by `python -m pytest -q`. Tests use isolated temporary databases and mocked external APIs.

Copy `.env.example` to `.env` to configure local variables; the app loads `.env` at startup, and variables already set in the process environment take precedence. Keep `.env` private and untracked.

## GitHub Import

Enter a public repository as `owner/repository` or a GitHub URL. Default bounds are:

- Up to 3 pages each of commits and issues/PRs, up to 300 records per collection.
- Changed-file details for up to 10 commits and 5 pull requests.
- Up to 250 indexed source files, each no larger than 50 KB.

These defaults keep unauthenticated API usage bounded. Set `GITHUB_TOKEN` for a higher GitHub API allowance. `GITHUB_MAX_PAGES`, `GITHUB_COMMIT_DETAIL_LIMIT`, `GITHUB_PR_DETAIL_LIMIT`, and `GITHUB_FILE_LIMIT` can be adjusted; larger values increase request count and latency. Import status includes page and changed-file coverage. Re-imports upsert records and prune records outside the imported history snapshot; incomplete file scans do not delete existing indexed files.

## ZIP Import

Upload a repository ZIP from Overview. The importer bounds upload size, entry count and extracted bytes; skips path traversal and symlink entries; and ignores generated directories. It indexes supported source/document files. Files above the indexing size limit are skipped and counted in the response. ZIP history is file-only; connect GitHub to ingest commits, issues and pull requests.

## Semantic RAG and LLM

The default generation model is `gpt-6-luna`; the default embedding model is `text-embedding-3-small`. As checked against OpenAI's official catalog on October 31, 2026, GPT-6 Luna is listed as an efficient high-volume model and supports Chat Completions. Its listed standard rates are $0.10 input and $0.50 output per million tokens. `text-embedding-3-small` is listed at $0.02 per million input tokens. GPT-4.1 mini is marked deprecated in the current catalog, so it is not the default. Access and pricing can vary and change.

Enable semantic retrieval and answer synthesis in PowerShell before starting the server:

```powershell
$env:OPENAI_API_KEY="your-key"
$env:OPENAI_MODEL="gpt-6-luna"
$env:OPENAI_EMBEDDING_MODEL="text-embedding-3-small"
python app.py
```

The key stays on the backend. When enabled, repository chunks and the question are sent to OpenAI. Only import data you are authorized to share with that service. Usage can incur charges. Embeddings are stored in SQLite and cached by source content; indexing is capped at 3,000 chunks per repository.

Retrieval combines cosine similarity with lexical overlap. The answer prompt includes exact source IDs, generated citations are checked against retrieved IDs, and uncited/invalid output falls back to evidence excerpts. If relevance is insufficient, the endpoint returns `Not found in the available project history.` Without a key, the app provides keyword-matched excerpts and labels the result as evidence-only; it does not pretend an LLM ran.

Decision retrieval is always local and keyword-based, including when an OpenAI key is configured; matching decision questions do not call paid embedding or answer APIs. The Decision Memory view and Ask Project Brain show verification status, documented fields, affected files, superseded versions and potential conflicts with both source IDs.

## Security and Hosting

Local mode binds to `127.0.0.1`, uses a local development secret, and uses in-process rate-limit storage. Do not expose that configuration to a network.

To bind to a non-local host or set `APP_ENV=production`, configure all of the following before startup:

- `APP_ENV=production`
- `APP_ACCESS_PASSWORD` with at least 16 characters
- `SECRET_KEY` with at least 32 random characters
- `RATELIMIT_STORAGE_URI` pointing to shared Redis storage, for example `redis://localhost:6379/0`
- HTTPS termination at a trusted reverse proxy

Production startup rejects weak/missing secrets and process-local rate-limit storage. Mutating routes require a session CSRF token; login uses constant-time password comparison, secure production cookies, and endpoint rate limits. Configure network access, Redis credentials, secret rotation, backups and data retention at deployment time. This prototype provides a single shared password, not user accounts or per-repository authorization.

## Demo Flow

1. Select **Reset Demo** to intentionally load the sample workspace, or import a repository to show real project data.
2. Open Project History and inspect the indexed records.
3. Open Knowledge Graph; select nodes and explain the provenance labels on edges.
4. Ask: **“Why was role-based access control added?”** Inspect the cited evidence.
5. Ask an unsupported question and show the not-found response.
6. Run a change-impact query that names a file or component; review affected files and test suggestions.
7. Open Knowledge Risk and explain contributor concentration and recency signals.
8. Optionally connect a public GitHub repository and show its import coverage report.

## Project Structure

```text
project_brain/
├── app.py
├── requirements.txt
├── .env.example
├── README.md
├── brain/
│   ├── templates/
│   │   ├── index.html
│   │   ├── login.html
│   │   └── legal.html
│   └── static/
│       ├── app.js
│       ├── favicon.svg
│       └── style.css
├── sample_data/
└── tests/
    └── test_smoke.py
```

## Next Steps

- Add GitHub review comments and webhook-triggered incremental import.
- Add language-aware parsers beyond Python and local JS/TS import paths.
- Evaluate retrieval against a curated question/evidence benchmark.
- Add per-user roles, audit trails and data deletion controls for a multi-user deployment.
- Improve ownership signals using code churn, line-level blame and documentation coverage.
