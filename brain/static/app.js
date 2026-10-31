"use strict";

/* =========================================================
   PROJECT BRAIN - FRONTEND APPLICATION
   ========================================================= */


/* -------------------------
   GLOBAL HELPERS
-------------------------- */

const $ = (id) => document.getElementById(id);

const API_BASE = "";

let currentHistory = [];
let currentGraph = null;
let graphState = null;
let graphAnimationFrame = 0;
let graphFilterTimer = null;
let graphControlsInitialized = false;
let graphPositionCache = new Map();
let graphView = { x: 0, y: 0, scale: 1 };
let toastTimer = null;


function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[char]);
}


function number(value) {
    const result = Number(value || 0);
    return Number.isFinite(result) ? result.toLocaleString() : "0";
}


function formatDate(value) {
    if (!value) return "Date unavailable";

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleString();
}


function toast(message, type = "success") {
    const element = $("toast");

    if (!element) return;

    element.textContent = message;
    element.className = `toast show ${type}`;

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
        element.className = "toast";
    }, 3500);
}


async function api(path, options = {}) {
    const config = {
        method: options.method || "GET",
        cache: "no-store",
        headers: {
            ...(options.headers || {})
        }
    };

    if (["POST", "PUT", "PATCH", "DELETE"].includes(config.method)) {
        const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
        if (csrf) config.headers["X-CSRF-Token"] = csrf;
    }

    if (options.body !== undefined) {
        if (options.body instanceof FormData) {
            config.body = options.body;
        } else {
            config.headers["Content-Type"] = "application/json";
            config.body = JSON.stringify(options.body);
        }
    }

    let response;

    try {
        response = await fetch(`${API_BASE}${path}`, config);
    } catch (error) {
        throw new Error(
            "Unable to connect to Project Brain. Check that the Flask server is running."
        );
    }

    const text = await response.text();

    let data = {};

    try {
        data = text ? JSON.parse(text) : {};
    } catch {
        throw new Error("The server returned an invalid response.");
    }

    if (!response.ok) {
        throw new Error(
            data.error ||
            data.message ||
            `Request failed (${response.status}).`
        );
    }

    return data;
}


function setLoading(button, loading, originalText = "") {
    if (!button) return;

    if (loading) {
        button.dataset.originalText = button.textContent;
        button.disabled = true;
        button.textContent = "Working...";
    } else {
        button.disabled = false;
        button.textContent =
            button.dataset.originalText || originalText || "Submit";
    }
}


function kindIcon(kind) {
    const value = String(kind || "").toLowerCase();

    if (value.includes("commit")) return "C";
    if (value.includes("issue")) return "I";
    if (value.includes("pull")) return "PR";
    if (value.includes("document")) return "D";
    if (value.includes("file")) return "F";

    return "R";
}


function itemTitle(item) {
    return (
        item.title ||
        item.message ||
        item.path ||
        item.name ||
        "Untitled record"
    );
}


function itemDescription(item) {
    return (
        item.body ||
        item.description ||
        item.summary ||
        item.content ||
        item.reason ||
        ""
    );
}


function itemKind(item) {
    return item.kind || item.type || item.source_kind || "Record";
}


function itemDate(item) {
    return (
        item.created_at ||
        item.date ||
        item.timestamp ||
        item.committed_at ||
        ""
    );
}


function emptyState(message) {
    return `
        <div class="empty-state">
            ${esc(message)}
        </div>
    `;
}


function errorHTML(message) {
    return `
        <div class="error-state">
            <strong>Something went wrong</strong>
            <p>${esc(message)}</p>
        </div>
    `;
}


/* -------------------------
   NAVIGATION
-------------------------- */

const viewTitles = {
    overview: "Overview",
    history: "Project History",
    memory: "Knowledge Graph",
    decisions: "Decision Memory",
    ask: "Engineering Q&A",
    impact: "Change Impact",
    risk: "Knowledge Risk"
};


function showView(name) {
    const validViews = Object.keys(viewTitles);

    if (!validViews.includes(name)) return;
    if (name !== "memory") {
        cancelAnimationFrame(graphAnimationFrame);
        graphAnimationFrame = 0;
        clearTimeout(graphFilterTimer);
        graphFilterTimer = null;
    }

    document.querySelectorAll(".view").forEach((view) => {
        view.classList.remove("active");
    });

    const selected = $(`view-${name}`);

    if (selected) {
        selected.classList.add("active");
    }

    document.querySelectorAll(".nav-item").forEach((button) => {
        button.classList.toggle(
            "active",
            button.dataset.view === name
        );
    });

    const title = $("page-title");

    if (title) {
        title.textContent = viewTitles[name];
    }

    if (name === "overview") loadOverview();
    if (name === "history") loadHistory();
    if (name === "memory") loadGraph();
    if (name === "decisions") loadDecisions();
    if (name === "risk") loadRisk();
}


/* -------------------------
   THEME MANAGEMENT
-------------------------- */

const availableThemes = [
    "midnight",
    "light",
    "purple",
    "forest",
    "rose"
];


function applyTheme(theme) {
    const selectedTheme = availableThemes.includes(theme)
        ? theme
        : "midnight";

    document.documentElement.setAttribute(
        "data-theme",
        selectedTheme
    );

    const selector = $("themeSelect");

    if (selector) {
        selector.value = selectedTheme;
    }

    try {
        localStorage.setItem("projectBrainTheme", selectedTheme);
    } catch {
        // The theme still works if browser storage is unavailable.
    }
}


function initializeTheme() {
    let savedTheme = "midnight";

    try {
        savedTheme =
            localStorage.getItem("projectBrainTheme") || "midnight";
    } catch {
        savedTheme = "midnight";
    }

    applyTheme(savedTheme);

    const selector = $("themeSelect");

    if (selector) {
        selector.addEventListener("change", (event) => {
            applyTheme(event.target.value);
        });
    }
}


/* -------------------------
   OVERVIEW
-------------------------- */

async function loadOverview() {
    try {
        const data = await api("/api/overview");

        $("stat-items").textContent = number(data.items);
        $("stat-files").textContent = number(data.files);
        $("stat-contributors").textContent =
            number(data.contributors);
        $("stat-prs").textContent =
            number(data.pull_requests);

        $("count-commits").textContent =
            number(data.commits);

        $("count-issues").textContent =
            number(data.issues);

        $("count-documents").textContent =
            number(data.documents);

        $("count-files").textContent =
            number(data.files);

        const coverage = [
            data.commits,
            data.issues,
            data.documents,
            data.files
        ].map((value) => Number(value || 0));

        const maxValue = Math.max(...coverage, 1);

        const barIds = [
            "bar-commits",
            "bar-issues",
            "bar-documents",
            "bar-files"
        ];

        barIds.forEach((id, index) => {
            const bar = $(id);

            if (bar) {
                const percentage =
                    (coverage[index] / maxValue) * 100;

                bar.style.width = `${percentage}%`;
            }
        });

        const recent = Array.isArray(data.recent)
            ? data.recent
            : [];

        renderHistoryItems(
            recent,
            "recent-list",
            6,
            "No project activity yet. Import a GitHub repository or upload a ZIP to get started."
        );

        const repo = data.repository;
        const githubRepository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

        if ($("github-repo") && typeof repo === "string") {
            $("github-repo").value = githubRepository.test(repo)
                ? repo
                : "";
        }

    } catch (error) {
        console.error("Overview error:", error);
        toast(error.message, "error");
    }
}


/* -------------------------
   HISTORY
-------------------------- */

function itemHTML(item) {
    const kind = itemKind(item);
    const title = itemTitle(item);
    const description = itemDescription(item);
    const date = itemDate(item);

    const url = item.url || item.html_url || item.source_url;

    return `
        <article class="activity-item">

            <div class="activity-icon">
                ${esc(kindIcon(kind))}
            </div>

            <div class="activity-content">

                <div class="activity-title-row">
                    <h3>${esc(title)}</h3>

                    <span class="record-type">
                        ${esc(kind)}
                    </span>
                </div>

                ${
                    description
                        ? `<p>${esc(description)}</p>`
                        : ""
                }

                <div class="activity-meta">
                    ${
                        date
                            ? `<span>${esc(formatDate(date))}</span>`
                            : ""
                    }

                    ${
                        item.author
                            ? `<span>By ${esc(item.author)}</span>`
                            : ""
                    }

                    ${
                        url && /^https?:\/\//i.test(url)
                            ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>`
                            : ""
                    }
                </div>

            </div>

        </article>
    `;
}


function renderHistoryItems(
    items,
    targetId,
    limit = 0,
    emptyMessage = "No project records found. Connect a repository to get started."
) {
    const container = $(targetId);

    if (!container) return;

    if (!Array.isArray(items) || items.length === 0) {
        container.innerHTML = emptyState(emptyMessage);
        return;
    }

    const visibleItems = limit
        ? items.slice(0, limit)
        : items;

    container.innerHTML = visibleItems
        .map(itemHTML)
        .join("");
}


async function loadHistory() {
    const container = $("history-list");

    if (!container) return;

    container.innerHTML = emptyState("Loading project history...");

    try {
        const data = await api("/api/history");

        currentHistory = Array.isArray(data)
            ? data
            : data.results || data.items || [];

        renderHistoryItems(
            currentHistory,
            "history-list"
        );

    } catch (error) {
        container.innerHTML = errorHTML(error.message);
    }
}


async function searchHistory() {
    const query = $("history-search")?.value.trim();

    if (!query) {
        loadHistory();
        return;
    }

    const container = $("history-list");

    container.innerHTML = emptyState("Searching project history...");

    try {
        const data = await api(
            `/api/search?q=${encodeURIComponent(query)}`
        );

        const results = Array.isArray(data.results)
            ? data.results
            : [];

        renderHistoryItems(results, "history-list");

        if (results.length === 0) {
            container.innerHTML = emptyState(
                "No matching project records were found."
            );
        }

    } catch (error) {
        container.innerHTML = errorHTML(error.message);
    }
}


/* -------------------------
   GITHUB IMPORT
-------------------------- */

    

async function ingestGithub() {
    const input = $("github-repo");
    const box = $("ingest-message");
    const button = document.querySelector(
        'button[onclick="ingestGithub()"]'
    );

    if (!input || !box) {
        console.error("GitHub import elements not found.");
        return;
    }

    const repo = input.value.trim();

    if (!repo) {
        box.className = "message error";
        box.textContent = "Enter a GitHub repository URL or owner/repository.";
        return;
    }

    box.className = "message";
    box.textContent = "Connecting to GitHub...";

    setLoading(button, true);

    try {
        const data = await api("/api/ingest/github", {
            method: "POST",
            body: { repo: repo }
        });

        box.className = data.status === "partial" ? "message warning" : "message";
        box.textContent = [
            data.message || "Repository imported successfully.",
            ...(Array.isArray(data.warnings) ? data.warnings : [])
        ].join(" ");

        toast(data.message || "GitHub import completed.");

        await loadOverview();

    } catch (error) {
        box.className = "message error";
        box.textContent = error.message || "GitHub import failed.";
        toast(error.message, "error");

    } finally {
        setLoading(button, false);
    }
}




/* -------------------------
   ZIP UPLOAD
-------------------------- */

async function uploadRepo() {
    const input = $("repo-zip");
    const button = document.querySelector(
        'button[onclick="uploadRepo()"]'
    );

    const file = input?.files?.[0];

    if (!file) {
        toast("Select a ZIP file first.", "error");
        return;
    }

    if (!file.name.toLowerCase().endsWith(".zip")) {
        toast("Please select a ZIP file.", "error");
        return;
    }

    const formData = new FormData();

    formData.append("file", file);

    setLoading(button, true);

    $("ingest-message").textContent =
        "Uploading and indexing project files...";

    try {
        const data = await api("/api/ingest/upload", {
            method: "POST",
            body: formData
        });

        $("ingest-message").className =
            data.status === "partial" ? "message warning" : "message";
        $("ingest-message").textContent = [
            data.message || "Project upload completed.",
            ...(Array.isArray(data.warnings) ? data.warnings : [])
        ].join(" ");

        toast(
            data.message || "Project indexed successfully."
        );

        input.value = "";

        await loadOverview();

    } catch (error) {
        $("ingest-message").className = "message error";
        $("ingest-message").textContent = error.message;
        toast(error.message, "error");

    } finally {
        setLoading(button, false);
    }
}


/* -------------------------
   DECISION MEMORY
-------------------------- */

async function loadDecisions() {
    const container = $("decision-list");

    if (!container) return;

    container.innerHTML = emptyState("Loading decisions...");

    try {
        const data = await api("/api/decisions");

        const decisions = Array.isArray(data.decisions)
            ? data.decisions
            : [];
        const conflicts = Array.isArray(data.conflicts)
            ? data.conflicts
            : [];

        $("decision-count").textContent =
            number(data.active_count ?? decisions.filter((item) => item.current).length);

        if (decisions.length === 0) {
            $("decision-conflicts").innerHTML = "";
            container.innerHTML = emptyState(
                data.message ||
                "No documented engineering decisions were identified. Add architecture or decision documentation to your repository and import it."
            );
            return;
        }

        $("decision-conflicts").innerHTML = renderDecisionConflicts(conflicts);

        container.innerHTML = decisions.map((decision) => {
            const confidence = decision.confidence;
            const confidenceText =
                confidence === undefined || confidence === null
                    ? "Not provided"
                    : `${Math.round(Number(confidence) * 100)}%`;
            const sourceUrl = decision.source_url ||
                (String(decision.source_id || "").startsWith("file:")
                    ? `/api/files/content?path=${encodeURIComponent(decision.source_id.slice(5))}`
                    : "");
            const files = Array.isArray(decision.affected_files)
                ? decision.affected_files
                : [];
            const displayField = (label, value) => `
                <div class="decision-detail">
                    <strong>${esc(label)}</strong>
                    <p>${esc(value || "Not documented")}</p>
                </div>
            `;

            return `
                <article class="decision-card ${decision.current ? "" : "decision-superseded"}">

                    <div class="decision-card-header">

                        <div>
                            <span class="record-type">
                                ${esc(decision.evidence_level || "uncertain")}
                            </span>

                            <h3>${esc(decision.title || "Engineering decision")}</h3>
                        </div>

                        <span class="confidence-label">
                            ${decision.current ? "Current" : "Superseded"} · ${esc(confidenceText)} confidence
                        </span>

                    </div>

                    ${displayField("Decision", decision.decision)}
                    ${displayField("Context", decision.context)}
                    ${displayField("Rationale", decision.rationale)}
                    ${displayField("Rejected alternatives", decision.rejected_alternatives)}

                    <div class="decision-meta">

                        <span>Status: ${esc(decision.status || "Unspecified")}</span>
                        <span>Source: ${esc(decision.source_kind || "project evidence")}</span>

                        ${
                            decision.superseded_by
                                ? `<span>Superseded by: ${esc(decision.superseded_by)}</span>`
                                : ""
                        }

                    </div>

                    ${files.length ? displayField("Affected files", files.join(", ")) : ""}

                    ${
                        sourceUrl && (/^https?:\/\//i.test(sourceUrl) || sourceUrl.startsWith("/api/files/content?"))
                            ? `<a href="${esc(sourceUrl)}" target="_blank" rel="noopener noreferrer">View supporting source ↗</a>`
                            : ""
                    }

                </article>
            `;
        }).join("");

    } catch (error) {
        container.innerHTML = errorHTML(error.message);
    }
}


function renderDecisionConflicts(conflicts) {
    if (!conflicts.length) return "";
    return `
        <div class="decision-conflict-list" role="status">
            <h3>Potential decision conflicts</h3>
            ${conflicts.map((conflict) => `
                <article class="decision-conflict">
                    <strong>${esc(conflict.titles?.join(" ↔ ") || "Conflicting records")}</strong>
                    <p>${esc(conflict.reason || "Review both records for possible conflict.")}</p>
                    <div class="decision-meta">
                        <span>Shared topics: ${esc((conflict.shared_topics || []).join(", "))}</span>
                        <span>Opposing terms: ${esc((conflict.opposing_terms || []).flat().join(" / "))}</span>
                        <span>Evidence: ${esc((conflict.evidence_ids || []).join(", "))}</span>
                    </div>
                </article>
            `).join("")}
        </div>
    `;
}


function renderDecisionInsights(data) {
    const decisions = Array.isArray(data.decision_results)
        ? data.decision_results
        : [];
    const conflicts = Array.isArray(data.decision_conflicts)
        ? data.decision_conflicts
        : [];
    if (!decisions.length && !conflicts.length) return "";

    return `
        <section class="decision-insights">
            <h3>Decision evidence</h3>
            ${decisions.map((decision) => `
                <article class="decision-evidence-card">
                    <div class="decision-meta">
                        <span>${decision.current ? "Current" : "Superseded"}</span>
                        <span>${esc(decision.evidence_level || "uncertain")}</span>
                        <span>Status: ${esc(decision.status || "Unspecified")}</span>
                    </div>
                    <strong>${esc(decision.title)}</strong>
                    <p><b>Decision:</b> ${esc(decision.decision || "Not documented")}</p>
                    <p><b>Context:</b> ${esc(decision.context || "Not documented")}</p>
                    <p><b>Rationale:</b> ${esc(decision.rationale || "Not documented")}</p>
                    <p><b>Rejected alternatives:</b> ${esc(decision.rejected_alternatives || "Not documented")}</p>
                    <p class="small-note">Source: ${esc(decision.source_id)}</p>
                </article>
            `).join("")}
            ${renderDecisionConflicts(conflicts)}
        </section>
    `;
}


/* -------------------------
   ENGINEERING Q&A
-------------------------- */

function setQuestion(question) {
    const input = $("question");

    if (input) {
        input.value = question;
        input.focus();
    }
}


function renderAnswer(data) {
    const container = $("answer-content");

    const answer = data.answer || "No answer was returned.";

    const sources = Array.isArray(data.sources)
        ? data.sources
        : [];

    const evidenceStatus =
        data.evidence_status || "Not specified";

    let sourceHTML = "";

    if (sources.length > 0) {
        sourceHTML = `
            <div class="evidence-section">

                <h3>Supporting Evidence</h3>

                <div class="evidence-list">

                    ${sources.map((source, index) => {
                        const title =
                            source.title ||
                            source.path ||
                            source.name ||
                            `Source ${index + 1}`;

                        const content =
                            source.excerpt ||
                            source.content ||
                            source.text ||
                            source.reason ||
                            "";

                        const url =
                            source.url ||
                            source.source_url;
                        const clickableSource =
                            typeof url === "string" && (
                                /^https?:\/\//i.test(url) ||
                                url.startsWith("/api/files/content?path=")
                            );

                        return `
                            <article class="evidence-card">

                                <div class="evidence-heading">
                                    <span class="evidence-number">
                                        ${index + 1}
                                    </span>

                                    <strong>${esc(title)}</strong>
                                    <code>${esc(source.id || "")}</code>
                                </div>

                                ${
                                    content
                                        ? `<p>${esc(content)}</p>`
                                        : ""
                                }

                                ${
                                    source.kind || source.type
                                        ? `<span class="record-type">${esc(source.kind || source.type)}</span>`
                                        : ""
                                }

                                ${
                                    clickableSource
                                        ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>`
                                        : ""
                                }

                            </article>
                        `;
                    }).join("")}

                </div>

            </div>
        `;
    } else {
        sourceHTML = `
            <div class="small-note">
                No supporting source records were returned for this answer.
            </div>
        `;
    }

    container.innerHTML = `
        <div class="answer-result">

            <div class="answer-status">
                <span class="status-dot"></span>
                Evidence status:
                <strong>${esc(evidenceStatus)}</strong>
                ${data.retrieval_mode ? ` · ${esc(data.retrieval_mode)} retrieval` : ""}
            </div>

            ${data.warning ? `<div class="small-note">${esc(data.warning)}</div>` : ""}
            ${data.index_capped ? `<div class="small-note">Repository indexing reached its configured chunk limit.</div>` : ""}

            <div class="answer-text">
                ${esc(answer).replace(/\n/g, "<br>")}
            </div>

            ${renderDecisionInsights(data)}

            ${sourceHTML}

            <div class="small-note">
                Answers depend on the available indexed project evidence.
                Verify important engineering decisions against the original source.
            </div>

        </div>
    `;
}


async function askBrain() {
    const question = $("question")?.value.trim();

    const button = document.querySelector(
        'button[onclick="askBrain()"]'
    );

    if (!question) {
        toast("Enter a question first.", "error");
        return;
    }

    setLoading(button, true);

    $("answer-content").innerHTML =
        emptyState("Searching project knowledge and preparing an answer...");

    try {
        const data = await api("/api/ask", {
            method: "POST",
            body: { question }
        });

        renderAnswer(data);

    } catch (error) {
        $("answer-content").innerHTML =
            errorHTML(error.message);

    } finally {
        setLoading(button, false);
    }
}


/* -------------------------
   CHANGE IMPACT ANALYSIS
-------------------------- */

function renderImpact(data) {
    const container = $("impact-results");

    const affected = Array.isArray(data.affected)
        ? data.affected
        : [];

    const tests = Array.isArray(data.test_suggestions)
        ? data.test_suggestions
        : [];

    const history = Array.isArray(data.history)
        ? data.history
        : [];

    const summary = data.summary || {};

    let affectedHTML = "";

    if (affected.length > 0) {
        affectedHTML = affected.map((item) => {
            const path =
                typeof item === "string"
                    ? item
                    : item.path || item.file || item.name || "Unknown file";

            const reason =
                typeof item === "string"
                    ? ""
                    : item.reason || item.relationship || item.signal || "";

            const level =
                typeof item === "string"
                    ? ""
                    : item.confidence || item.level || item.impact || "";

            const category =
                typeof item === "string" ? "" : item.category || "";

            return `
                <article class="impact-item">

                    <div class="impact-item-heading">
                        <strong>${esc(path)}</strong>

                        ${category ? `<span class="record-type">${esc(category)}</span>` : ""}

                        ${
                            level
                                ? `<span class="record-type">${esc(level)}</span>`
                                : ""
                        }
                    </div>

                    ${
                        reason
                            ? `<p>${esc(reason)}</p>`
                            : ""
                    }

                </article>
            `;
        }).join("");
    } else {
        affectedHTML = emptyState(
            "No potentially affected files were identified from the available evidence."
        );
    }


    let testsHTML = "";

    if (tests.length > 0) {
        testsHTML = `
            <ul class="recommendation-list">
                ${tests.map((test) => {
                    const value =
                        typeof test === "string"
                            ? test
                            : test.path || test.name || test.recommendation || JSON.stringify(test);

                    return `<li>${esc(value)}</li>`;
                }).join("")}
            </ul>
        `;
    } else {
        testsHTML = emptyState(
            "No specific test recommendations were generated."
        );
    }


    let historyHTML = "";

    if (history.length > 0) {
        historyHTML = history.map((item) => {
            if (typeof item === "string") {
                return `<div class="impact-history-item">${esc(item)}</div>`;
            }

            return `
                <div class="impact-history-item">

                    <strong>
                        ${esc(item.title || item.message || item.path || "Historical relationship")}
                    </strong>

                    ${
                        item.reason || item.description
                            ? `<p>${esc(item.reason || item.description)}</p>`
                            : ""
                    }

                </div>
            `;
        }).join("");
    } else {
        historyHTML = emptyState(
            "No historical co-change relationships were found."
        );
    }


    const limitations = Array.isArray(data.limitations)
        ? data.limitations
        : [];


    container.innerHTML = `

        <div class="impact-summary-grid">

            <article class="impact-summary-card">
                <span>Potentially affected files</span>
                <strong>${number(affected.length)}</strong>
            </article>

            <article class="impact-summary-card">
                <span>Dependency count</span>
                <strong>${number(data.dependency_count)}</strong>
            </article>

            <article class="impact-summary-card">
                <span>Test suggestions</span>
                <strong>${number(tests.length)}</strong>
            </article>

        </div>


        <div class="impact-section">

            <h3>Analysis Summary</h3>

            <p>
                ${
                    typeof summary === "string"
                        ? esc(summary)
                        : esc(
                            summary.message ||
                            summary.description ||
                            "The analysis identified potential relationships using available source and history evidence."
                        )
                }
            </p>

        </div>


        <div class="impact-section">

            <h3>Potentially Affected Files</h3>

            <div class="impact-list">
                ${affectedHTML}
            </div>

        </div>


        <div class="impact-section">

            <h3>Recommended Tests and Checks</h3>

            ${testsHTML}

        </div>


        <div class="impact-section">

            <h3>Historical Relationships</h3>

            <div class="impact-list">
                ${historyHTML}
            </div>

        </div>


        ${
            limitations.length > 0
                ? `
                    <div class="impact-section limitation-section">

                        <h3>Limitations</h3>

                        <ul class="recommendation-list">
                            ${limitations.map((item) =>
                                `<li>${esc(item)}</li>`
                            ).join("")}
                        </ul>

                    </div>
                `
                : ""
        }

        <div class="small-note">
            This is a heuristic analysis, not a guarantee that every
            affected component or runtime consequence has been identified.
        </div>

    `;
}


async function analyzeImpact() {
    const description =
        $("change-description")?.value.trim();

    const button = document.querySelector(
        'button[onclick="analyzeImpact()"]'
    );

    if (!description) {
        toast("Describe the proposed code change first.", "error");
        return;
    }

    setLoading(button, true);

    $("impact-results").innerHTML =
        emptyState("Analyzing dependencies and historical relationships...");

    try {
        const data = await api("/api/impact", {
            method: "POST",
            body: { description }
        });

        renderImpact(data);

    } catch (error) {
        $("impact-results").innerHTML =
            errorHTML(error.message);

    } finally {
        setLoading(button, false);
    }
}


/* -------------------------
   KNOWLEDGE RISK
-------------------------- */

async function loadRisk() {
    const container = $("risk-list");

    if (!container) return;

    container.innerHTML =
        emptyState("Analyzing contributor and file history...");

    try {
        const data = await api("/api/risk");

        const risks = Array.isArray(data.risks)
            ? data.risks
            : [];

        if (risks.length === 0) {
            container.innerHTML = emptyState(
                "No knowledge risk signals were identified. Import project history with contributor information to perform this analysis."
            );
            return;
        }

        container.innerHTML = `

            ${
                data.note
                    ? `<div class="small-note">${esc(data.note)}</div>`
                    : ""
            }

            <div class="risk-list">

                ${risks.map((risk) => {

                    const owners = Array.isArray(risk.owners)
                        ? risk.owners
                        : [];

                    const contributors =
                        Array.isArray(risk.contributors)
                            ? risk.contributors
                            : [];

                    const signals = Array.isArray(risk.signals)
                        ? risk.signals
                        : [];

                    const riskLevel =
                        String(risk.risk || "Unknown");

                    return `
                        <article class="risk-card">

                            <div class="risk-card-header">

                                <div>
                                    <span class="record-type">
                                        Knowledge concentration
                                    </span>

                                    <h3>${esc(risk.path || "Unknown file")}</h3>
                                </div>

                                <span class="risk-label ${esc(riskLevel.toLowerCase())}">
                                    ${esc(riskLevel)}
                                </span>

                            </div>


                            <div class="risk-metrics">

                                <div>
                                    <span>Contributors</span>
                                    <strong>${number(contributors.length)}</strong>
                                </div>

                                <div>
                                    <span>Commits</span>
                                    <strong>${number(risk.commit_count)}</strong>
                                </div>

                                <div>
                                    <span>Identified owners</span>
                                    <strong>${number(owners.length)}</strong>
                                </div>

                                <div>
                                    <span>Top owner share</span>
                                    <strong>${Math.round(Number(risk.ownership_concentration || 0) * 100)}%</strong>
                                </div>

                                <div>
                                    <span>Inactive days</span>
                                    <strong>${risk.inactive_days === null || risk.inactive_days === undefined ? "Unknown" : number(risk.inactive_days)}</strong>
                                </div>

                            </div>


                            ${
                                owners.length
                                    ? `
                                        <div class="risk-detail">
                                            <strong>Owners</strong>
                                            <p>${esc(owners.join(", "))}</p>
                                        </div>
                                    `
                                    : ""
                            }


                            ${
                                signals.length
                                    ? `
                                        <div class="risk-detail">
                                            <strong>Risk signals</strong>

                                            <ul class="recommendation-list">
                                                ${signals.map((signal) =>
                                                    `<li>${esc(signal)}</li>`
                                                ).join("")}
                                            </ul>
                                        </div>
                                    `
                                    : ""
                            }

                        </article>
                    `;
                }).join("")}

            </div>

            <div class="small-note">
                These signals describe contributor concentration in
                available history. They do not predict actual availability.
            </div>
        `;

    } catch (error) {
        container.innerHTML = errorHTML(error.message);
    }
}


/* -------------------------
   KNOWLEDGE GRAPH
-------------------------- */

const GRAPH_VIEWBOX = { width: 1200, height: 800 };
const GRAPH_NODE_LIMIT = 160;
const GRAPH_RECENT_COMMIT_LIMIT = 20;
const GRAPH_SVG_NS = "http://www.w3.org/2000/svg";


function graphNodeLabel(node) {
    return (
        node.title ||
        node.label ||
        node.name ||
        node.path ||
        node.id ||
        "Node"
    );
}


function graphNodeType(node) {
    return String(
        node.kind ||
        node.type ||
        node.category ||
        "file"
    ).toLowerCase();
}


function graphColor(type) {
    if (type.includes("decision")) return "#b69af4";
    if (type.includes("component")) return "#79c69c";
    if (type.includes("commit")) return "#6b9bdb";
    if (type.includes("document")) return "#a78bfa";
    if (type.includes("issue") || type.includes("pull")) return "#e6a45c";
    if (type.includes("file")) return "#4bb89a";

    return "#8b9bb1";
}


function graphNodeDetails(node) {
    const title = graphNodeLabel(node);
    const type = graphNodeType(node);
    const details = $("graph-detail");

    if (!details) return;

    const metadata = node.metadata && typeof node.metadata === "object"
        ? node.metadata
        : {};
    const detailRows = [
        ["Type", type.replaceAll("_", " ")],
        ["Decision candidate", node.is_decision_candidate ? "Yes" : ""],
        ["ID", node.id],
        ["Author", node.author],
        ["Date", node.created_at ? formatDate(node.created_at) : ""],
        ["Status", node.status],
        ["Evidence", node.evidence_level],
        ["Rationale", node.rationale],
        ["Path", node.path],
        ["Affected files", Array.isArray(node.affected_files)
            ? node.affected_files.join(", ")
            : ""],
        ["Contained files", node.member_count],
        ["Related issue references", Array.isArray(metadata.issue_refs)
            ? metadata.issue_refs.join(", ")
            : ""]
    ].filter(([, value]) => value !== null && value !== undefined && value !== "");

    details.innerHTML = `
        <div class="graph-detail-content">

            <span class="record-type">${esc(type.replaceAll("_", " "))}</span>

            <h3>${esc(title)}</h3>

            <p>${esc(node.detail || "No additional details available.")}</p>

            <dl class="graph-metadata">
                ${detailRows.map(([label, value]) => `
                    <div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>
                `).join("")}
            </dl>

            ${node.url && /^https?:\/\//i.test(node.url)
                ? `<a href="${esc(node.url)}" target="_blank" rel="noopener noreferrer">Open source ↗</a>`
                : ""}
        </div>
    `;
}


function graphTypeGroup(node) {
    const type = graphNodeType(node);
    if (type.includes("component")) return "component";
    if (type.includes("file")) return "file";
    if (type.includes("issue") || type.includes("pull")) return "issue";
    if (type.includes("document")) return "document";
    if (type.includes("commit")) return "commit";
    return "document";
}


function graphNodeFilterGroups(node) {
    const groups = new Set([graphTypeGroup(node)]);
    if (node.is_decision_candidate) groups.add("decision");
    if (node.is_document) groups.add("document");
    return groups;
}


function graphNodeRadius(node) {
    const type = graphTypeGroup(node);
    if (type === "decision" || type === "component") return 17;
    if (type === "issue") return 15;
    return 13;
}


function graphHash(value) {
    let hash = 2166136261;
    for (const char of String(value)) {
        hash ^= char.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}


function graphSvgElement(name, attributes = {}) {
    const element = document.createElementNS(GRAPH_SVG_NS, name);
    Object.entries(attributes).forEach(([key, value]) => {
        element.setAttribute(key, value);
    });
    return element;
}


function graphFilterValues() {
    return new Set(
        [...document.querySelectorAll(".graph-filter.active")]
            .map((filter) => filter.dataset.graphFilter)
    );
}


function filteredGraphData() {
    if (!currentGraph) return { nodes: [], edges: [], total: 0 };
    const selectedTypes = graphFilterValues();
    const query = $("graph-search")?.value.trim().toLowerCase() || "";
    const showOlder = Boolean($("graph-show-older")?.checked);
    const allNodes = currentGraph.nodes || [];
    const edges = currentGraph.edges || [];
    const degree = new Map();
    const uniqueEdges = new Map();

    for (const edge of edges) {
        const key = `${edge.from}\0${edge.to}\0${edge.label}`;
        uniqueEdges.set(key, edge);
        degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
        degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
    }

    const uniqueNodes = new Map(
        allNodes.filter((node) => node && node.id)
            .map((node) => [String(node.id), node])
    );
    let candidates = [...uniqueNodes.values()].filter((node) => {
        if (![...graphNodeFilterGroups(node)].some((group) =>
            selectedTypes.has(group)
        )) return false;
        if (query) {
            const text = [
                node.title, node.label, node.id, node.detail, node.author,
                node.path, node.status, node.rationale
            ].join(" ").toLowerCase();
            if (!text.includes(query)) return false;
        } else if ((degree.get(node.id) || 0) === 0) {
            return false;
        }
        return true;
    });

    const recentCommits = candidates
        .filter((node) => graphTypeGroup(node) === "commit")
        .sort((left, right) =>
            String(right.created_at || "").localeCompare(
                String(left.created_at || "")
            )
        );
    const recentCommitIds = new Set(
        (showOlder ? recentCommits : recentCommits.slice(0, GRAPH_RECENT_COMMIT_LIMIT))
            .map((node) => String(node.id))
    );
    if (!showOlder) {
        candidates = candidates.filter((node) =>
            graphTypeGroup(node) !== "commit" || recentCommitIds.has(String(node.id))
        );
    }

    candidates.sort((left, right) => {
        const leftDegree = degree.get(left.id) || 0;
        const rightDegree = degree.get(right.id) || 0;
        return rightDegree - leftDegree
            || String(left.title || left.id).localeCompare(
                String(right.title || right.id)
            );
    });
    const filteredNodes = candidates.slice(0, GRAPH_NODE_LIMIT);
    const visibleIds = new Set(filteredNodes.map((node) => String(node.id)));
    const filteredEdges = [...uniqueEdges.values()].filter((edge) =>
        visibleIds.has(String(edge.from))
        && visibleIds.has(String(edge.to))
    );

    return {
        nodes: filteredNodes,
        edges: filteredEdges,
        total: candidates.length,
        degree,
        query
    };
}


function graphSetView() {
    if (!graphState?.viewport) return;
    const { x, y, scale } = graphView;
    graphState.viewport.setAttribute(
        "transform", `translate(${x} ${y}) scale(${scale})`
    );
    const dense = graphState.nodes.length > 70;
    graphState.nodes.forEach((node) => {
        const label = node.element.querySelector(".graph-label");
        const keepLabel = graphView.scale >= 0.72
            && (!dense || (graphState.degree.get(node.id) || 0) >= 2
                || node.id === graphState.selectedId);
        if (label) label.classList.toggle("graph-label-hidden", !keepLabel);
    });
}


function graphToSvgPoint(event) {
    const point = graphState.svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(graphState.svg.getScreenCTM().inverse());
}


function graphToWorldPoint(event) {
    const point = graphState.svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    return point.matrixTransform(
        graphState.viewport.getScreenCTM().inverse()
    );
}


function initializeGraphInteractions() {
    if (graphControlsInitialized) return;
    graphControlsInitialized = true;

    document.querySelectorAll(".graph-filter").forEach((button) => {
        button.addEventListener("click", () => {
            button.classList.toggle("active");
            button.setAttribute(
                "aria-pressed", String(button.classList.contains("active"))
            );
            renderFilteredGraph();
        });
    });

    $("graph-search")?.addEventListener("input", () => {
        clearTimeout(graphFilterTimer);
        graphFilterTimer = setTimeout(renderFilteredGraph, 140);
    });
    $("graph-show-older")?.addEventListener(
        "change", renderFilteredGraph
    );

    const svg = $("graph-svg");
    if (!svg) return;

    svg.addEventListener("wheel", (event) => {
        if (!graphState) return;
        event.preventDefault();
        const point = graphToSvgPoint(event);
        const oldScale = graphView.scale;
        const newScale = Math.min(
            3.2,
            Math.max(0.25, oldScale * Math.exp(-event.deltaY * 0.0012))
        );
        graphView.x = point.x - (point.x - graphView.x) * newScale / oldScale;
        graphView.y = point.y - (point.y - graphView.y) * newScale / oldScale;
        graphView.scale = newScale;
        graphSetView();
    }, { passive: false });

    svg.addEventListener("pointerdown", (event) => {
        if (!graphState || event.button !== 0) return;
        const nodeElement = event.target.closest?.(".graph-node");
        if (nodeElement) {
            const node = graphState.nodeById.get(nodeElement.dataset.nodeId);
            if (!node) return;
            graphState.selectedId = node.id;
            graphState.drag = {
                type: "node",
                id: node.id,
                pointerId: event.pointerId,
                moved: false
            };
            const world = graphToWorldPoint(event);
            node.fx = world.x;
            node.fy = world.y;
            svg.setPointerCapture(event.pointerId);
            graphNodeDetails(node);
            graphSetView();
            event.preventDefault();
            return;
        }
        const point = graphToSvgPoint(event);
        graphState.drag = {
            type: "pan",
            pointerId: event.pointerId,
            point,
            x: graphView.x,
            y: graphView.y
        };
        svg.setPointerCapture(event.pointerId);
    });

    svg.addEventListener("pointermove", (event) => {
        if (!graphState?.drag || graphState.drag.pointerId !== event.pointerId) {
            return;
        }
        const drag = graphState.drag;
        if (drag.type === "node") {
            const node = graphState.nodeById.get(drag.id);
            const world = graphToWorldPoint(event);
            node.fx = world.x;
            node.fy = world.y;
            node.x = world.x;
            node.y = world.y;
            node.vx = 0;
            node.vy = 0;
            drag.moved = true;
            updateGraphPositions();
        } else {
            const point = graphToSvgPoint(event);
            graphView.x = drag.x + point.x - drag.point.x;
            graphView.y = drag.y + point.y - drag.point.y;
            graphSetView();
        }
    });

    const finishDrag = (event) => {
        if (!graphState?.drag || graphState.drag.pointerId !== event.pointerId) {
            return;
        }
        const drag = graphState.drag;
        if (drag.type === "node") {
            const node = graphState.nodeById.get(drag.id);
            if (node) {
                if (!drag.moved) {
                    node.fx = null;
                    node.fy = null;
                }
                graphPositionCache.set(node.id, { x: node.x, y: node.y });
            }
            graphState.ignoreClick = drag.moved;
        }
        graphState.drag = null;
        if (svg.hasPointerCapture(event.pointerId)) {
            svg.releasePointerCapture(event.pointerId);
        }
    };
    svg.addEventListener("pointerup", finishDrag);
    svg.addEventListener("pointercancel", finishDrag);

    svg.addEventListener("click", (event) => {
        if (graphState?.ignoreClick) {
            graphState.ignoreClick = false;
            return;
        }
        const nodeElement = event.target.closest?.(".graph-node");
        if (!nodeElement || !graphState) return;
        const node = graphState.nodeById.get(nodeElement.dataset.nodeId);
        if (node) {
            graphState.selectedId = node.id;
            graphState.nodes.forEach((item) =>
                item.element.classList.toggle(
                    "graph-node-selected", item.id === node.id
                )
            );
            graphNodeDetails(node);
            graphSetView();
        }
    });

    svg.addEventListener("keydown", (event) => {
        const nodeElement = event.target.closest?.(".graph-node");
        if (!nodeElement || !["Enter", " "].includes(event.key)) return;
        event.preventDefault();
        const node = graphState?.nodeById.get(nodeElement.dataset.nodeId);
        if (node) {
            graphState.selectedId = node.id;
            graphState.nodes.forEach((item) =>
                item.element.classList.toggle(
                    "graph-node-selected", item.id === node.id
                )
            );
            graphNodeDetails(node);
            graphSetView();
        }
    });
}


function updateGraphPositions() {
    if (!graphState) return;
    graphState.edges.forEach((edge) => {
        const source = graphState.nodeById.get(String(edge.from));
        const target = graphState.nodeById.get(String(edge.to));
        const element = edge.element;
        if (!source || !target || !element) return;
        element.setAttribute("x1", source.x);
        element.setAttribute("y1", source.y);
        element.setAttribute("x2", target.x);
        element.setAttribute("y2", target.y);
    });
    graphState.nodes.forEach((node) => {
        node.element.setAttribute("transform", `translate(${node.x} ${node.y})`);
        graphPositionCache.set(node.id, { x: node.x, y: node.y });
    });
}


function graphSimulationStep() {
    const nodes = graphState.nodes;
    const centerX = GRAPH_VIEWBOX.width / 2;
    const centerY = GRAPH_VIEWBOX.height / 2;
    const linkDistance = Math.max(95, 155 - nodes.length * 0.25);
    let movement = 0;

    for (let i = 0; i < nodes.length; i += 1) {
        const left = nodes[i];
        for (let j = i + 1; j < nodes.length; j += 1) {
            const right = nodes[j];
            let dx = left.x - right.x;
            let dy = left.y - right.y;
            let distanceSquared = dx * dx + dy * dy;
            if (distanceSquared < 1) {
                const seed = graphHash(`${left.id}:${right.id}`);
                dx = (seed % 11) - 5;
                dy = ((seed >>> 4) % 11) - 5;
                distanceSquared = Math.max(1, dx * dx + dy * dy);
            }
            const distance = Math.sqrt(distanceSquared);
            const minDistance = graphNodeRadius(left) + graphNodeRadius(right) + 33;
            const repulsion = 11000 / distanceSquared;
            const collision = Math.max(0, minDistance - distance) * 0.12;
            const force = repulsion + collision;
            const fx = dx / distance * force;
            const fy = dy / distance * force;
            if (left.fx === null) {
                left.vx += fx;
                left.vy += fy;
            }
            if (right.fx === null) {
                right.vx -= fx;
                right.vy -= fy;
            }
        }
    }

    graphState.edges.forEach((edge) => {
        const source = graphState.nodeById.get(String(edge.from));
        const target = graphState.nodeById.get(String(edge.to));
        if (!source || !target) return;
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const force = (distance - linkDistance) * 0.012;
        const fx = dx / distance * force;
        const fy = dy / distance * force;
        if (source.fx === null) {
            source.vx += fx;
            source.vy += fy;
        }
        if (target.fx === null) {
            target.vx -= fx;
            target.vy -= fy;
        }
    });

    nodes.forEach((node) => {
        if (node.fx !== null) {
            node.x = node.fx;
            node.y = node.fy;
            node.vx = 0;
            node.vy = 0;
            return;
        }
        node.vx += (centerX - node.x) * 0.0007;
        node.vy += (centerY - node.y) * 0.0007;
        node.vx *= 0.82;
        node.vy *= 0.82;
        node.x += node.vx;
        node.y += node.vy;
        node.x = Math.min(GRAPH_VIEWBOX.width - 55, Math.max(55, node.x));
        node.y = Math.min(GRAPH_VIEWBOX.height - 55, Math.max(55, node.y));
        movement = Math.max(movement, Math.abs(node.vx) + Math.abs(node.vy));
    });

    updateGraphPositions();
    return movement;
}


function startGraphSimulation(autoFit = false) {
    cancelAnimationFrame(graphAnimationFrame);
    let iteration = graphState?.simulationIteration || 0;
    const maxIterations = 180;
    const runFrame = () => {
        if (!graphState) return;
        let movement = 0;
        for (let step = 0; step < 2; step += 1) {
            movement = graphSimulationStep();
            iteration += 1;
            graphState.simulationIteration = iteration;
            if (iteration >= maxIterations || movement < 0.08) break;
        }
        if (iteration < maxIterations && movement >= 0.08) {
            graphAnimationFrame = requestAnimationFrame(runFrame);
        } else {
            graphState.simulationComplete = true;
            if (autoFit) fitGraphView();
        }
    };
    graphAnimationFrame = requestAnimationFrame(runFrame);
}


function renderFilteredGraph() {
    if (!currentGraph) return;
    renderGraph(currentGraph, false);
}


function renderGraph(data, initial = true) {
    const svg = $("graph-svg");
    if (!svg) return;
    cancelAnimationFrame(graphAnimationFrame);
    const continueLayout = Boolean(
        graphState && !graphState.simulationComplete
    );
    const previousIteration = continueLayout
        ? graphState.simulationIteration
        : 0;
    currentGraph = data;
    const shouldAutoFit = initial && graphPositionCache.size === 0;
    const filtered = filteredGraphData();
    const edges = filtered.edges;
    const nodes = filtered.nodes;
    const needsLayout = continueLayout || nodes.some(
        (node) => !graphPositionCache.has(String(node.id))
    );
    const count = $("graph-count");
    const detail = $("graph-detail");
    if (count) {
        count.textContent = nodes.length
            ? `Showing ${nodes.length} of ${filtered.total} matching nodes · ${edges.length} relationships`
                + (data.truncated
                    ? ` · API capped at ${data.nodes.length} of ${data.total_nodes} total nodes`
                    : "")
            : "No matching nodes";
    }
    if (!nodes.length) {
        svg.replaceChildren();
        graphState = null;
        if (detail) {
            detail.textContent = currentGraph.nodes?.length
                ? "No nodes match these search and filter settings. Clear the search or enable a node type."
                : "No project relationships yet. Import repository history or source files to build the graph.";
        }
        return;
    }

    const nodeById = new Map();
    const selectedId = nodes.some(
        (node) => String(node.id) === graphState?.selectedId
    ) ? graphState.selectedId : null;
    nodes.forEach((node, index) => {
        const id = String(node.id);
        const saved = graphPositionCache.get(id);
        const hash = graphHash(id);
        const x = 170 + (hash % 850);
        const y = 110 + ((hash >>> 10) % 560);
        const position = saved || { x, y };
        nodeById.set(id, {
            ...node,
            id,
            x: position.x,
            y: position.y,
            vx: 0,
            vy: 0,
            fx: null,
            fy: null,
            index
        });
    });

    const degree = filtered.degree || new Map();
    const defs = graphSvgElement("defs");
    const marker = graphSvgElement("marker", {
        id: "graph-arrow",
        viewBox: "0 -5 10 10",
        refX: "16",
        refY: "0",
        markerWidth: "5",
        markerHeight: "5",
        orient: "auto"
    });
    marker.append(graphSvgElement("path", {
        d: "M0,-5L10,0L0,5",
        class: "graph-arrowhead"
    }));
    defs.append(marker);
    const viewport = graphSvgElement("g", { class: "graph-viewport" });
    const linkLayer = graphSvgElement("g", { class: "graph-links" });
    const nodeLayer = graphSvgElement("g", { class: "graph-nodes" });
    viewport.append(linkLayer, nodeLayer);
    svg.replaceChildren(defs, viewport);

    const renderedEdges = [];
    edges.forEach((edge) => {
        const source = nodeById.get(String(edge.from));
        const target = nodeById.get(String(edge.to));
        if (!source || !target) return;
        const line = graphSvgElement("line", {
            class: `graph-link graph-link-${String(edge.label || "related").replace(/[^a-z0-9_-]/gi, "-")}`,
            "marker-end": "url(#graph-arrow)"
        });
        const title = graphSvgElement("title");
        title.textContent = `${edge.label || "related"} · ${edge.provenance || "project evidence"}`;
        line.append(title);
        linkLayer.append(line);
        renderedEdges.push({ ...edge, element: line });
    });

    const renderedNodes = [];
    nodes.forEach((sourceNode) => {
        const node = nodeById.get(String(sourceNode.id));
        const type = graphTypeGroup(node);
        const group = graphSvgElement("g", {
            class: `graph-node graph-node-${type}`,
            "data-node-id": node.id,
            tabindex: "0",
            role: "button",
            "aria-label": graphNodeLabel(node)
        });
        const title = graphSvgElement("title");
        title.textContent = graphNodeLabel(node);
        group.append(title);
        let shape;
        const radius = graphNodeRadius(node);
        if (type === "decision") {
            shape = graphSvgElement("rect", {
                x: -radius * 0.72,
                y: -radius * 0.72,
                width: radius * 1.44,
                height: radius * 1.44,
                rx: "2",
                transform: "rotate(45)"
            });
        } else if (type === "component") {
            shape = graphSvgElement("rect", {
                x: -radius,
                y: -radius * 0.72,
                width: radius * 2,
                height: radius * 1.44,
                rx: "5"
            });
        } else if (type === "issue") {
            shape = graphSvgElement("path", {
                d: `M${-radius} 0 L${-radius / 2} ${-radius * 0.86} L${radius / 2} ${-radius * 0.86} L${radius} 0 L${radius / 2} ${radius * 0.86} L${-radius / 2} ${radius * 0.86} Z`
            });
        } else if (type === "file") {
            shape = graphSvgElement("rect", {
                x: -radius * 0.76,
                y: -radius,
                width: radius * 1.52,
                height: radius * 2,
                rx: "3"
            });
        } else {
            shape = graphSvgElement("circle", { r: radius });
        }
        shape.setAttribute("class", "graph-node-shape");
        shape.setAttribute("fill", graphColor(type));
        group.append(shape);
        if (node.is_decision_candidate) {
            const badge = graphSvgElement("path", {
                d: `M${radius * 0.55} ${-radius * 0.9} l5 -5 l5 5 l-5 5 z`,
                class: "graph-decision-badge"
            });
            group.append(badge);
        }
        const label = graphSvgElement("text", {
            class: "graph-label",
            x: "0",
            y: String(radius + 19),
            "text-anchor": "middle"
        });
        const fullLabel = node.label || node.title || node.id;
        const shortLabel = fullLabel.length > 25
            ? `${fullLabel.slice(0, 22)}...`
            : fullLabel;
        label.textContent = shortLabel;
        group.append(label);
        nodeLayer.append(group);
        node.element = group;
        if (node.id === selectedId) {
            group.classList.add("graph-node-selected");
        }
        renderedNodes.push(node);
    });

    graphState = {
        svg,
        viewport,
        nodes: renderedNodes,
        edges: renderedEdges,
        nodeById,
        degree,
        selectedId,
        drag: null,
        ignoreClick: false,
        simulationIteration: previousIteration,
        simulationComplete: !needsLayout
    };
    initializeGraphInteractions();
    graphSetView();
    updateGraphPositions();
    if (detail && !graphState.selectedId) {
        detail.textContent = "Select a node for details. Drag nodes to rearrange; drag the background to pan and use the wheel to zoom.";
    }
    if (needsLayout) {
        startGraphSimulation(shouldAutoFit);
    } else {
        graphState.simulationComplete = true;
        if (shouldAutoFit) fitGraphView();
    }
}


function fitGraphView() {
    if (!graphState?.nodes.length) return;
    const xs = graphState.nodes.map((node) => node.x);
    const ys = graphState.nodes.map((node) => node.y);
    const minX = Math.min(...xs) - 50;
    const maxX = Math.max(...xs) + 50;
    const minY = Math.min(...ys) - 70;
    const maxY = Math.max(...ys) + 70;
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const scale = Math.min(
        2.2,
        Math.max(0.25, Math.min(
            (GRAPH_VIEWBOX.width - 80) / width,
            (GRAPH_VIEWBOX.height - 80) / height
        ))
    );
    graphView = {
        x: GRAPH_VIEWBOX.width / 2 - (minX + maxX) / 2 * scale,
        y: GRAPH_VIEWBOX.height / 2 - (minY + maxY) / 2 * scale,
        scale
    };
    graphSetView();
}


function resetGraphView() {
    graphView = { x: 0, y: 0, scale: 1 };
    graphSetView();
}


async function loadGraph() {
    const svg = $("graph-svg");

    if (!svg) return;

    initializeGraphInteractions();
    if ($("graph-count")) {
        $("graph-count").textContent = "Loading project relationships...";
    }

    try {
        const data = await api("/api/graph");
        if (
            graphState
            && currentGraph
            && JSON.stringify(currentGraph) === JSON.stringify(data)
        ) {
            if (!graphState.simulationComplete) {
                startGraphSimulation(false);
            }
            return;
        }
        graphPositionCache = new Map(
            [...graphPositionCache.entries()].filter(([id]) =>
                data.nodes.some((node) => String(node.id) === id)
            )
        );
        renderGraph(data);

    } catch (error) {
        cancelAnimationFrame(graphAnimationFrame);
        svg.replaceChildren();
        graphState = null;

        $("graph-detail").innerHTML =
            errorHTML(error.message);
    }
}


/* -------------------------
   RESET DEMO
-------------------------- */

async function resetDemo() {
    const confirmed = window.confirm(
        "Load the sample demo workspace? Imported repository data will remain separate and unchanged."
    );

    if (!confirmed) return;

    try {
        const data = await api("/api/reset-demo", {
            method: "POST"
        });

        toast(data.message || "Demo data reset.");

        await loadOverview();

        showView("overview");

    } catch (error) {
        toast(error.message, "error");
    }
}


/* -------------------------
   KEYBOARD SHORTCUTS
-------------------------- */

function initializeKeyboard() {
    const question = $("question");

    if (question) {
        question.addEventListener("keydown", (event) => {
            if (
                event.key === "Enter" &&
                (event.ctrlKey || event.metaKey)
            ) {
                askBrain();
            }
        });
    }

    const search = $("history-search");

    if (search) {
        search.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                searchHistory();
            }
        });
    }
}


/* -------------------------
   INITIALIZATION
-------------------------- */

document.addEventListener("DOMContentLoaded", () => {
    initializeTheme();
    initializeKeyboard();
    loadOverview();
});