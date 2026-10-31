import io
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import pytest

_test_database_dir = tempfile.TemporaryDirectory(prefix="project-brain-tests-")
os.environ["PROJECT_BRAIN_DB"] = str(
  Path(_test_database_dir.name) / "initial.db"
)
os.environ["APP_ENV"] = "development"
os.environ.pop("APP_ACCESS_PASSWORD", None)

import app as project


@pytest.fixture(autouse=True)
def isolated_workspace(tmp_path, monkeypatch):
  project.DB_PATH = tmp_path / "brain.db"
  project.app.config.update(
    TESTING=True,
    RATELIMIT_ENABLED=False
  )
  monkeypatch.delenv("APP_ACCESS_PASSWORD", raising=False)
  monkeypatch.delenv("OPENAI_API_KEY", raising=False)
  project.init_db()
  yield


def client_and_csrf():
  client = project.app.test_client()
  response = client.get("/")
  assert response.status_code == 200
  with client.session_transaction() as session:
    token = session["_csrf_token"]
  return client, {"X-CSRF-Token": token}


def activate_demo_workspace(client, headers):
  response = client.post("/api/reset-demo", headers=headers)
  assert response.status_code == 200
  return response.get_json()


def test_pages_and_overview_routes_work():
  client = project.app.test_client()

  for route in ("/", "/privacy", "/terms", "/favicon.svg", "/api/overview"):
    assert client.get(route).status_code == 200

  overview = client.get("/api/overview").get_json()
  assert overview["items"] == 0
  assert overview["files"] == 0
  assert overview["commits"] == 0
  assert overview["issues"] == 0
  assert overview["pull_requests"] == 0
  assert overview["contributors"] == 0
  assert overview["recent"] == []
  page = client.get("/").get_data(as_text=True)
  assert "No project activity yet. Import a GitHub repository or upload a ZIP to get started." in page
  assert client.get("/api/history").get_json() == []
  assert client.get("/api/files").get_json() == []


def test_legacy_demo_selection_migrates_to_empty_and_preserves_imports():
  project.seed_demo()
  project.replace_repo_items("acme/imported", [{
    "id": "commit-imported",
    "kind": "commit",
    "title": "Imported change",
    "body": "Real imported history.",
    "author": "Contributor",
    "metadata": {}
  }])
  project.replace_repo_files(
    "acme/imported", {"src/app.py": ("VALUE = 1", "py")}
  )
  conn = project.connect_db()
  conn.execute("UPDATE settings SET value='demo' WHERE key='active_repo'")
  conn.execute(
    "UPDATE settings SET value='0' WHERE key='demo_workspace_enabled'"
  )
  conn.commit()
  conn.close()

  project.init_db()

  assert project.active_repo() == ""
  overview = project.app.test_client().get("/api/overview").get_json()
  assert overview["items"] == 0
  assert overview["files"] == 0
  assert len(project.all_items("acme/imported")) == 1
  assert len(project.all_files("acme/imported")) == 1


def test_legacy_demo_only_database_does_not_activate_sample_data():
  project.seed_demo()
  conn = project.connect_db()
  conn.execute("UPDATE settings SET value='demo' WHERE key='active_repo'")
  conn.execute(
    "UPDATE settings SET value='0' WHERE key='demo_workspace_enabled'"
  )
  conn.commit()
  conn.close()

  project.init_db()

  assert project.active_repo() == ""
  overview = project.app.test_client().get("/api/overview").get_json()
  assert overview["items"] == 0
  assert overview["files"] == 0
  assert overview["recent"] == []


def test_reset_demo_is_explicit_and_does_not_mix_imported_data():
  client, headers = client_and_csrf()
  project.replace_repo_items("acme/real", [{
    "id": "commit-real",
    "kind": "commit",
    "title": "Real imported change",
    "body": "An actual repository commit.",
    "author": "Real Contributor",
    "metadata": {"files": ["src/real.py"]}
  }])
  project.replace_repo_files(
    "acme/real", {"src/real.py": ("VALUE = 1", "py")}
  )
  project.set_active_repo("acme/real")

  result = activate_demo_workspace(client, headers)
  assert result["message"] == "Sample workspace restored."
  overview = client.get("/api/overview").get_json()
  assert overview["repository"] == "demo"
  assert overview["items"] == 4
  assert overview["files"] == 4
  assert overview["pull_requests"] == 1
  assert len(project.all_items("acme/real")) == 1
  assert len(project.all_files("acme/real")) == 1
  project.init_db()
  assert project.active_repo() == "demo"

  project.set_active_repo("acme/real")
  imported_overview = client.get("/api/overview").get_json()
  assert imported_overview["items"] == 1
  assert imported_overview["files"] == 1
  assert imported_overview["contributors"] == 1


def test_mutations_require_csrf_token():
  client = project.app.test_client()
  response = client.post("/api/ask", json={"question": "auth"})
  assert response.status_code == 400
  assert response.get_json()["error"] == "Invalid CSRF token."


def test_json_endpoints_reject_non_text_inputs_without_500s():
  client, headers = client_and_csrf()
  ask_response = client.post("/api/ask", json={"question": 42}, headers=headers)
  impact_response = client.post("/api/impact", json={"change": ["auth"]}, headers=headers)
  github_response = client.post("/api/ingest/github", json=["owner/repo"], headers=headers)

  assert ask_response.status_code == 400
  assert impact_response.status_code == 400
  assert github_response.status_code == 400


def test_password_gate_and_login_flow(monkeypatch):
  monkeypatch.setenv("APP_ACCESS_PASSWORD", "demo-password")
  client = project.app.test_client()

  assert client.get("/api/overview").status_code == 401
  assert client.get("/").status_code == 302
  login_page = client.get("/login")
  assert login_page.status_code == 200

  with client.session_transaction() as session:
    token = session["_csrf_token"]

  response = client.post("/login", data={
    "csrf_token": token,
    "password": "demo-password",
    "next": "/"
  })
  assert response.status_code == 302
  assert client.get("/api/overview").status_code == 200


def test_ask_returns_cited_fallback_and_not_found():
  client, headers = client_and_csrf()
  activate_demo_workspace(client, headers)
  supported = client.post("/api/ask", json={
    "question": "Why was role-based access control added?"
  }, headers=headers)

  assert supported.status_code == 200
  answer = supported.get_json()
  assert answer["evidence_status"] == "retrieved"
  assert "Evidence-only response" in answer["answer"]
  assert answer["sources"]
  assert all(source["id"] and source["excerpt"] for source in answer["sources"])

  unsupported = client.post("/api/ask", json={
    "question": "orbital telemetry spacecraft"
  }, headers=headers)
  assert unsupported.get_json()["answer"] == (
    "Not found in the available project history."
  )
  assert unsupported.get_json()["sources"] == []


def test_hybrid_retrieval_caches_embeddings(monkeypatch):
  client, headers = client_and_csrf()
  activate_demo_workspace(client, headers)
  monkeypatch.setenv("OPENAI_API_KEY", "test-key")
  calls = []

  def fake_embeddings(texts):
    calls.append(list(texts))
    return [[1.0, 0.0] for _ in texts]

  monkeypatch.setattr(project, "openai_embeddings", fake_embeddings)
  sources, mode, warning, capped = project.retrieve_evidence(
    "why was access control added"
  )

  assert mode == "hybrid"
  assert warning is None
  assert capped is False
  assert sources
  assert calls
  calls_after_first_query = len(calls)
  project.retrieve_evidence("why was access control added")
  assert len(calls) == calls_after_first_query + 1

  conn = project.connect_db()
  embedded_count = conn.execute(
    "SELECT COUNT(*) FROM embeddings"
  ).fetchone()[0]
  conn.close()
  assert embedded_count > 0


def test_embedding_request_uses_configured_model_and_small_dimensions(monkeypatch):
  monkeypatch.setenv("OPENAI_API_KEY", "test-key")
  monkeypatch.setenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
  requests_seen = []

  class FakeResponse:
    def raise_for_status(self):
      return None

    def json(self):
      return {"data": [{"index": 0, "embedding": [0.1, 0.2]}]}

  def fake_post(url, **kwargs):
    requests_seen.append((url, kwargs))
    return FakeResponse()

  monkeypatch.setattr(project.requests, "post", fake_post)
  result = project.openai_embeddings(["short test input"])

  assert result == [[0.1, 0.2]]
  assert requests_seen[0][0] == "https://api.openai.com/v1/embeddings"
  payload = requests_seen[0][1]["json"]
  assert payload["model"] == "text-embedding-3-small"
  assert payload["dimensions"] == 512
  assert payload["input"] == ["short test input"]


def test_openai_error_message_distinguishes_exhausted_credits():
  class QuotaResponse:
    status_code = 429

    def json(self):
      return {"error": {
        "type": "insufficient_quota",
        "code": "credit_balance_exhausted"
      }}

  error = project.requests.HTTPError("quota exhausted")
  error.response = QuotaResponse()
  message = project.openai_error_message(error, "embedding")
  assert "credits are exhausted" in message


def test_llm_citations_must_reference_retrieved_sources(monkeypatch):
  monkeypatch.setenv("OPENAI_API_KEY", "test-key")

  class FakeResponse:
    def __init__(self, answer):
      self.answer = answer

    def raise_for_status(self):
      return None

    def json(self):
      return {"choices": [{"message": {"content": self.answer}}]}

  source = {
    "id": "issue-12", "kind": "issue", "title": "Permissions",
    "excerpt": "Viewers must be read-only."
  }
  monkeypatch.setattr(
    project.requests, "post",
    lambda *args, **kwargs: FakeResponse("Read-only access was required. [issue-12]")
  )
  assert project.llm_answer("Why?", [source]).endswith("[issue-12]")

  monkeypatch.setattr(
    project.requests, "post",
    lambda *args, **kwargs: FakeResponse("This is unsupported [made-up-id].")
  )
  assert project.llm_answer("Why?", [source]) is None


def test_ask_returns_generated_answer_with_valid_citation(monkeypatch):
  monkeypatch.setenv("OPENAI_API_KEY", "test-key")
  monkeypatch.setenv("OPENAI_MODEL", "gpt-6-luna")
  source = {
    "id": "issue-12",
    "kind": "issue",
    "title": "Read-only viewers",
    "excerpt": "Viewers must not edit workspace settings.",
    "url": "https://github.com/acme/repo/issues/12"
  }
  monkeypatch.setattr(
    project, "retrieve_evidence",
    lambda _question: ([source], "hybrid", None, False)
  )
  requests_seen = []

  class FakeResponse:
    def raise_for_status(self):
      return None

    def json(self):
      return {"choices": [{"message": {
        "content": "Viewers were restricted to prevent unauthorized settings changes. [issue-12]"
      }}]}

  def fake_post(url, **kwargs):
    requests_seen.append((url, kwargs))
    return FakeResponse()

  monkeypatch.setattr(project.requests, "post", fake_post)
  client, headers = client_and_csrf()
  response = client.post("/api/ask", json={"question": "Why read-only?"}, headers=headers)

  assert response.status_code == 200
  result = response.get_json()
  assert result["evidence_status"] == "generated"
  assert result["retrieval_mode"] == "hybrid"
  assert result["answer"].endswith("[issue-12]")
  assert result["sources"][0]["url"] == source["url"]
  assert requests_seen[0][0] == "https://api.openai.com/v1/chat/completions"
  assert requests_seen[0][1]["headers"]["Authorization"] == "Bearer test-key"
  assert requests_seen[0][1]["json"]["model"] == "gpt-6-luna"


def test_ask_missing_key_returns_clear_evidence_only_fallback(monkeypatch):
  monkeypatch.delenv("OPENAI_API_KEY", raising=False)
  source = {
    "id": "issue-12", "kind": "issue", "title": "Read-only viewers",
    "excerpt": "Viewers must not edit settings.", "url": None
  }
  monkeypatch.setattr(
    project, "retrieve_evidence",
    lambda _question: ([source], "keyword_fallback", None, False)
  )
  monkeypatch.setattr(
    project.requests, "post",
    lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("unexpected API request"))
  )
  client, headers = client_and_csrf()
  response = client.post("/api/ask", json={"question": "Why read-only?"}, headers=headers)

  assert response.status_code == 200
  result = response.get_json()
  assert result["evidence_status"] == "retrieved"
  assert "Evidence-only response" in result["answer"]
  assert "OPENAI_API_KEY is not configured" in result["warning"]


def test_ask_openai_timeout_returns_clear_fallback_warning(monkeypatch):
  monkeypatch.setenv("OPENAI_API_KEY", "test-key")
  source = {
    "id": "issue-12", "kind": "issue", "title": "Read-only viewers",
    "excerpt": "Viewers must not edit settings.", "url": None
  }
  monkeypatch.setattr(
    project, "retrieve_evidence",
    lambda _question: ([source], "hybrid", None, False)
  )
  monkeypatch.setattr(
    project.requests, "post",
    lambda *_args, **_kwargs: (_ for _ in ()).throw(project.requests.Timeout())
  )
  client, headers = client_and_csrf()
  response = client.post("/api/ask", json={"question": "Why read-only?"}, headers=headers)

  assert response.status_code == 200
  result = response.get_json()
  assert result["evidence_status"] == "retrieved"
  assert "Evidence-only response" in result["answer"]
  assert "timed out" in result["warning"]


def test_ask_openai_auth_failure_returns_clear_fallback_warning(monkeypatch):
  monkeypatch.setenv("OPENAI_API_KEY", "test-key")
  source = {
    "id": "issue-12", "kind": "issue", "title": "Read-only viewers",
    "excerpt": "Viewers must not edit settings.", "url": None
  }
  monkeypatch.setattr(
    project, "retrieve_evidence",
    lambda _question: ([source], "hybrid", None, False)
  )

  class UnauthorizedResponse:
    status_code = 401

    def raise_for_status(self):
      error = project.requests.HTTPError("unauthorized")
      error.response = self
      raise error

  monkeypatch.setattr(
    project.requests, "post", lambda *_args, **_kwargs: UnauthorizedResponse()
  )
  client, headers = client_and_csrf()
  response = client.post("/api/ask", json={"question": "Why read-only?"}, headers=headers)

  assert response.status_code == 200
  result = response.get_json()
  assert result["evidence_status"] == "retrieved"
  assert "authentication or model access failed (HTTP 401)" in result["warning"]
  assert "Evidence-only response" in result["answer"]


def test_ask_rejects_unretrieved_citations_and_falls_back(monkeypatch):
  monkeypatch.setenv("OPENAI_API_KEY", "test-key")
  source = {
    "id": "issue-12", "kind": "issue", "title": "Read-only viewers",
    "excerpt": "Viewers must not edit settings.", "url": None
  }
  monkeypatch.setattr(
    project, "retrieve_evidence",
    lambda _question: ([source], "hybrid", None, False)
  )

  class FakeResponse:
    def raise_for_status(self):
      return None

    def json(self):
      return {"choices": [{"message": {
        "content": "Access controls were added [invented-source]."
      }}]}

  monkeypatch.setattr(project.requests, "post", lambda *_args, **_kwargs: FakeResponse())
  client, headers = client_and_csrf()
  response = client.post("/api/ask", json={"question": "Why read-only?"}, headers=headers)

  assert response.status_code == 200
  result = response.get_json()
  assert result["evidence_status"] == "retrieved"
  assert "Evidence-only response" in result["answer"]
  assert "citations were missing or did not match" in result["warning"]


def test_local_source_citations_open_only_files_in_active_workspace():
  repo_id = "citation-test"
  path = "docs/architecture notes.md"
  project.save_file(path, "# Decision\nKeep evidence linked.\n", "md", repo_id)
  project.set_active_repo(repo_id)
  client = project.app.test_client()
  citation = project.source_record({
    "id": "file:" + path,
    "kind": "source_file",
    "title": path,
    "body": "# Decision\nKeep evidence linked.\n"
  })

  response = client.get(citation["url"])
  assert response.status_code == 200
  assert "Keep evidence linked." in response.get_data(as_text=True)
  project.set_active_repo("another-workspace")
  assert client.get(citation["url"]).status_code == 404


def test_github_pagination_stops_after_short_page(monkeypatch):
  calls = []

  def fake_get(url, headers, params=None):
    page = params["page"]
    calls.append(page)
    if page == 1:
      return [{"n": index} for index in range(100)]
    return [{"n": 100}]

  monkeypatch.setattr(project, "github_get", fake_get)
  records, coverage = project.github_pages(
    "https://api.github.com/test", {}, max_pages=5
  )

  assert len(records) == 101
  assert calls == [1, 2]
  assert coverage == {"pages": 2, "complete": True}


def test_github_import_upserts_duplicate_records(monkeypatch):
  client, headers = client_and_csrf()
  commit = {
    "sha": "a" * 40,
    "commit": {
      "message": "Fix permissions #12",
      "author": {"name": "Dev", "date": "2026-10-01T10:00:00Z"}
    },
    "author": {"login": "dev"}
  }

  def fake_pages(url, request_headers, params=None, max_pages=5):
    if url.endswith("/commits"):
      records = [commit]
    else:
      records = [{
        "number": 12,
        "title": "Read-only viewers",
        "body": "Prevent edits.",
        "created_at": "2026-10-01T09:00:00Z",
        "user": {"login": "reviewer"},
        "html_url": "https://github.com/acme/demo/issues/12"
      }]
    return records, {"pages": 1, "complete": True}

  monkeypatch.setattr(project, "github_pages", fake_pages)
  monkeypatch.setattr(project, "github_get", lambda url, *_args, **_kwargs: {
    "files": [{"filename": "src/auth.py"}],
    "default_branch": "main"
  })
  monkeypatch.setattr(project, "fetch_github_files", lambda *args, **kwargs: {
    "files": {"src/auth.py": ("def require_role(): pass", "py")},
    "complete": True,
    "tree_truncated": False,
    "failed": 0,
    "capped": False,
    "oversized": 0
  })

  first = client.post("/api/ingest/github", json={"repo": "acme/demo"}, headers=headers)
  second = client.post("/api/ingest/github", json={"repo": "acme/demo"}, headers=headers)
  assert first.status_code == second.status_code == 200
  assert first.get_json()["status"] == "complete"
  assert second.get_json()["commits"] == 1
  assert len(client.get("/api/history").get_json()) == 2
  assert client.get("/api/files").get_json()[0]["path"] == "src/auth.py"
  overview = client.get("/api/overview").get_json()
  assert overview["items"] == 2
  assert overview["commits"] == 1
  assert overview["issues"] == 1
  assert overview["files"] == 1
  assert overview["contributors"] == 2


def test_zip_import_rejects_traversal_and_reports_missing_history():
  client, headers = client_and_csrf()
  archive_buffer = io.BytesIO()
  with zipfile.ZipFile(archive_buffer, "w") as archive:
    archive.writestr("repo/src/module.py", "VALUE = 1\n")
    archive.writestr("README.md", "Root-level project documentation.\n")
    archive.writestr("../outside.py", "SHOULD_NOT_WRITE = True")

  archive_buffer.seek(0)
  response = client.post("/api/ingest/upload", data={
    "file": (archive_buffer, "repo.zip")
  }, headers=headers, content_type="multipart/form-data")

  assert response.status_code == 200
  result = response.get_json()
  assert result["files"] == 2
  assert result["history_available"] is False
  assert result["status"] == "complete"
  indexed_paths = {item["path"] for item in client.get("/api/files").get_json()}
  assert indexed_paths == {"README.md", "repo/src/module.py"}
  overview = client.get("/api/overview").get_json()
  assert overview["items"] == 0
  assert overview["files"] == 2
  assert overview["documents"] == 1
  assert overview["contributors"] == 0

def test_fresh_database_initialization_does_not_seed_demo(tmp_path):
  previous_path = project.DB_PATH
  project.DB_PATH = tmp_path / "fresh.db"
  try:
    project.init_db()
    assert project.active_repo() == ""
    assert project.all_items() == []
    assert project.all_files() == []
    conn = project.connect_db()
    assert conn.execute("SELECT COUNT(*) FROM embeddings").fetchone()[0] == 0
    conn.close()
  finally:
    project.DB_PATH = previous_path


def test_app_startup_does_not_seed_demo(tmp_path):
  env = os.environ.copy()
  env.update({
    "PROJECT_BRAIN_DB": str(tmp_path / "startup.db"),
    "APP_ENV": "development",
    "PYTHONDONTWRITEBYTECODE": "1"
  })
  env.pop("APP_ACCESS_PASSWORD", None)
  result = subprocess.run(
    [
      sys.executable,
      "-c",
      "import app; assert app.active_repo() == ''; "
      "assert app.all_items() == []; assert app.all_files() == []"
    ],
    cwd=project.BASE,
    env=env,
    capture_output=True,
    text=True
  )
  assert result.returncode == 0, result.stderr


def test_app_startup_clears_previous_selection_without_deleting_imports(tmp_path):
  db_path = tmp_path / "previous-import.db"
  previous_path = project.DB_PATH
  project.DB_PATH = db_path
  try:
    project.init_db()
    project.replace_repo_items("acme/repo", [{
      "id": "commit-kept",
      "kind": "commit",
      "title": "Keep this imported record",
      "body": "It must survive startup selection reset.",
      "author": "Contributor",
      "metadata": {}
    }])
    project.replace_repo_files(
      "acme/repo", {"src/kept.py": ("VALUE = 1", "py")}
    )
    project.set_active_repo("acme/repo")
  finally:
    project.DB_PATH = previous_path

  env = os.environ.copy()
  env.update({
    "PROJECT_BRAIN_DB": str(db_path),
    "APP_ENV": "development",
    "HOST": "127.0.0.1",
    "PYTHONDONTWRITEBYTECODE": "1"
  })
  env.pop("APP_ACCESS_PASSWORD", None)
  result = subprocess.run(
    [
      sys.executable,
      "-c",
      "import app; print(app.active_repo()); "
      "print(len(app.all_items('acme/repo'))); "
      "print(len(app.all_files('acme/repo')))"
    ],
    cwd=project.BASE,
    env=env,
    capture_output=True,
    text=True
  )
  assert result.returncode == 0, result.stderr
  assert result.stdout.splitlines() == ["", "1", "1"]


def test_api_dashboard_response_disables_caching():
  response = project.app.test_client().get("/api/overview")
  assert response.headers["Cache-Control"] == "no-store"


def test_decisions_and_graph_have_traceable_edges():
  client, headers = client_and_csrf()
  activate_demo_workspace(client, headers)
  decisions = project.decision_evidence(
    project.all_items(), project.all_files()
  )
  adr = next(record for record in decisions if "ADR" in record["title"])
  assert "Decision:" in adr["reason"]
  assert adr["status"] == "Unspecified"

  graph = project.app.test_client().get("/api/graph").get_json()
  edge_types = {edge["label"] for edge in graph["edges"]}
  nodes_by_id = {node["id"]: node for node in graph["nodes"]}
  assert "references_issue" in edge_types
  assert "changed_file" in edge_types
  assert "imports" in edge_types
  assert all(edge["provenance"] for edge in graph["edges"])
  assert nodes_by_id["commit-a12f"]["kind"] == "commit"
  assert nodes_by_id["commit-a12f"]["is_decision_candidate"] is True
  assert nodes_by_id["doc-architecture"]["kind"] == "document"


def test_graph_deduplicates_records_and_exposes_repository_components():
  repo_id = "graph-quality-test"
  project.replace_repo_items(repo_id, [{
    "id": "commit-shared-files",
    "kind": "commit",
    "title": "Refactor shared source modules for maintainability",
    "body": "Update shared source modules.",
    "created_at": "2026-10-28T12:00:00Z",
    "metadata": {
      "files": ["src/auth.py", "src/auth.py", "src/routes.py"],
      "issue_refs": ["42", "42"]
    }
  }, {
    "id": "issue-42",
    "kind": "issue",
    "title": "Improve module organization",
    "body": "Group related source files.",
    "metadata": {"number": 42}
  }])
  project.replace_repo_files(repo_id, {
    "src/auth.py": ("def authorize(): return True\n", "py"),
    "src/routes.py": ("def route(): return None\n", "py")
  })
  project.set_active_repo(repo_id)

  graph = project.app.test_client().get("/api/graph").get_json()
  node_ids = [node["id"] for node in graph["nodes"]]
  edge_keys = [
    (edge["from"], edge["to"], edge["label"])
    for edge in graph["edges"]
  ]
  assert len(node_ids) == len(set(node_ids))
  assert len(edge_keys) == len(set(edge_keys))
  assert "component:src" in node_ids
  assert any(edge["label"] == "contains_file" for edge in graph["edges"])
  assert any(edge["label"] == "changed_file" for edge in graph["edges"])
  assert any(edge["label"] == "references_issue" for edge in graph["edges"])
  commit = next(node for node in graph["nodes"] if node["id"] == "commit-shared-files")
  assert commit["title"] == "Refactor shared source modules for maintainability"


def test_decisions_are_persisted_searchable_and_never_fill_missing_rationale(
  monkeypatch
):
  repo_id = "decision-memory-test"
  project.set_active_repo(repo_id)
  project.save_file(
    "docs/ADR-001-authorization.md",
    "# Authorization\n"
    "## Status\nAccepted\n"
    "## Context\nThe API serves multiple user roles.\n"
    "## Decision\nUse server-side authorization.\n"
    "## Rationale\nFrontend checks can be bypassed.\n"
    "## Rejected alternatives\nClient-side authorization.\n"
    "## Affected files\n- brain/auth.py\n",
    "md",
    repo_id
  )
  project.save_item({
    "id": "commit-redis",
    "kind": "commit",
    "title": "Switch to Redis",
    "body": "Switch to Redis for shared rate-limit storage.",
    "metadata": {"files": ["brain/limits.py"]}
  }, repo_id)

  records = project.stored_decisions()
  verified = next(
    item for item in records
    if item["source_id"] == "file:docs/ADR-001-authorization.md"
  )
  inferred = next(
    item for item in records if item["source_id"] == "commit-redis"
  )
  assert verified["evidence_level"] == "verified"
  assert verified["status"] == "Accepted"
  assert verified["context"] == "The API serves multiple user roles."
  assert verified["rationale"] == "Frontend checks can be bypassed."
  assert verified["rejected_alternatives"] == "Client-side authorization."
  assert verified["affected_files"] == ["brain/auth.py"]
  assert inferred["evidence_level"] == "uncertain"
  assert inferred["rationale"] == ""
  assert inferred["affected_files"] == ["brain/limits.py"]

  monkeypatch.setenv("OPENAI_API_KEY", "must-not-be-used")
  monkeypatch.setattr(
    project, "retrieve_evidence",
    lambda *_args, **_kwargs: pytest.fail("Decision retrieval used external embeddings")
  )
  monkeypatch.setattr(
    project, "llm_answer_with_status",
    lambda *_args, **_kwargs: pytest.fail("Decision retrieval used LLM synthesis")
  )
  client, headers = client_and_csrf()
  response = client.post("/api/ask", json={
    "question": "Why use server-side authorization?"
  }, headers=headers)
  assert response.status_code == 200
  result = response.get_json()
  assert result["retrieval_mode"] == "keyword_fallback"
  assert result["decision_results"]
  assert result["decision_results"][0]["evidence_level"] == "verified"
  assert "Frontend checks can be bypassed." in result["answer"]
  missing_rationale = client.post("/api/ask", json={
    "question": "Why switch to Redis?"
  }, headers=headers).get_json()
  assert missing_rationale["decision_results"][0]["rationale"] == ""
  assert "Rationale: Not documented" in missing_rationale["answer"]


def test_decision_versions_are_preserved_and_conflicts_include_both_sources():
  repo_id = "decision-history-test"
  project.set_active_repo(repo_id)
  project.save_file(
    "docs/ADR-001.md",
    "## Status\nAccepted\n"
    "## Decision\nUse server-side authorization.\n",
    "md",
    repo_id
  )
  old_record = project.stored_decisions()[0]
  project.save_file(
    "docs/ADR-001.md",
    "## Status\nAccepted\n"
    "## Decision\nUse server-side authorization for all API routes.\n",
    "md",
    repo_id
  )
  history = project.stored_decisions()
  old_version = next(
    item for item in history if item["decision_id"] == old_record["decision_id"]
  )
  new_version = next(item for item in history if item["current"])
  assert old_version["current"] is False
  assert old_version["superseded_by"] == new_version["decision_id"]

  project.save_file(
    "docs/ADR-002.md",
    "## Status\nAccepted\n"
    "## Decision\nUse client-side authorization for all API routes.\n",
    "md",
    repo_id
  )
  client, headers = client_and_csrf()
  decisions = client.get("/api/decisions").get_json()
  conflict = next(
    item for item in decisions["conflicts"]
    if set(item["titles"]) == {
      "docs/ADR-001.md", "docs/ADR-002.md"
    }
  )
  assert len(conflict["evidence_ids"]) == 2
  ask = client.post("/api/ask", json={
    "question": "What is the authorization approach?"
  }, headers=headers).get_json()
  assert ask["decision_conflicts"]
  assert len(ask["decision_results"]) == 2
  historical = client.post("/api/ask", json={
    "question": "What did we previously decide about server authorization?"
  }, headers=headers).get_json()
  assert any(not item["current"] for item in historical["decision_results"])

  project.save_file(
    "docs/ADR-003.md",
    "## Status\nAccepted\n"
    "## Decision\nCentralize permission checks in the API gateway.\n"
    "## Supersedes\nADR-002\n",
    "md",
    repo_id
  )
  superseded = next(
    item for item in project.stored_decisions()
    if item["source_id"] == "file:docs/ADR-002.md"
  )
  replacement = next(
    item for item in project.stored_decisions()
    if item["source_id"] == "file:docs/ADR-003.md"
  )
  assert not superseded["current"]
  assert superseded["superseded_by"] == replacement["decision_id"]


def test_python_ast_impact_includes_dependents_and_tests():
  repo_id = "impact-test"
  project.save_file("src/auth.py", "def check_role(): return True\n", "py", repo_id)
  project.save_file(
    "src/routes.py", "from src.auth import check_role\n", "py", repo_id
  )
  project.save_file(
    "tests/test_auth.py",
    "from src.auth import check_role\ndef test_check_role(): assert check_role()\n",
    "py", repo_id
  )
  project.set_active_repo(repo_id)
  dependencies = project.build_dependency_graph(project.all_files())
  assert "src/auth.py" in dependencies["src/routes.py"]

  client, headers = client_and_csrf()
  response = client.post("/api/impact", json={
    "change": "Modify src/auth.py role permission behavior"
  }, headers=headers)
  assert response.status_code == 200
  result = response.get_json()
  affected_paths = {item["path"] for item in result["affected"]}
  assert "src/routes.py" in affected_paths
  assert any(item["path"] == "tests/test_auth.py" for item in result["test_suggestions"])


def test_risk_reports_recency_and_ownership_concentration():
  repo_id = "risk-test"
  for index in range(4):
    project.save_item({
      "id": f"old-commit-{index}",
      "kind": "commit",
      "title": "Update auth",
      "body": "Maintained auth module.",
      "author": "Solo Maintainer",
      "created_at": "2024-01-01T00:00:00Z",
      "metadata": {"files": ["src/critical.py"]}
    }, repo_id)

  project.set_active_repo(repo_id)
  result = project.app.test_client().get("/api/risk").get_json()
  risk = next(item for item in result["risks"] if item["path"] == "src/critical.py")
  assert risk["risk"] == "High"
  assert risk["ownership_concentration"] == 1.0
  assert risk["inactive_days"] > 365
  assert risk["author_commit_counts"] == {"Solo Maintainer": 4}


def test_production_configuration_rejects_in_memory_rate_limits():
  env = os.environ.copy()
  env.update({
    "APP_ENV": "production",
    "APP_ACCESS_PASSWORD": "a" * 20,
    "SECRET_KEY": "s" * 40,
    "RATELIMIT_STORAGE_URI": "memory://",
    "PROJECT_BRAIN_DB": str(Path(tempfile.gettempdir()) / "unused-brain.db"),
    "PYTHONDONTWRITEBYTECODE": "1"
  })
  result = subprocess.run(
    [sys.executable, "-c", "import app"],
    cwd=project.BASE,
    env=env,
    capture_output=True,
    text=True
  )
  assert result.returncode != 0
  assert "RATELIMIT_STORAGE_URI" in result.stderr
