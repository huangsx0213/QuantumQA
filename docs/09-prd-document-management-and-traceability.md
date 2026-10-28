# PRD Document Management & Full Traceability Architecture

This specification documents the enterprise-grade PRD (Product Requirement Document) management, automated AI structuring, local disk archiving, version diff analysis, and end-to-end requirement traceability system implemented in QuantumQA.

---

## 1. Overview & Business Objectives

Prior requirement management in QuantumQA relied on copying and pasting raw text into web textareas, lacking:
1. **Original Document Retention**: PRD files (Word `.docx`, Excel 3-column `.xlsx`, Markdown `.md`, CSV `.csv`) were discarded once parsed.
2. **Version Tracking & Diff Analysis**: Inability to compare revisions (v1.0 vs. v1.1) or inspect added, modified, unchanged, or deprecated requirements.
3. **Traceability Anchors**: Requirements lacked explicit anchors linking back to specific document sections or spreadsheet rows.
4. **AI-First Structuring**: Reliance on rigid heuristic rules rather than adaptive AI model parsing.

The new system addresses these limitations with an AI-first workflow, local file persistence, version control, automated diff tracking, and seamless integration into downstream AI test generation.

---

## 2. Supported PRD File Formats & Parsing Strategies

The requirement ingestion engine is **100% AI-Driven** across all supported formats. Regardless of input format, when an AI provider is configured, the system executes an intelligent two-pass decomposition: extracting structured text with contextual anchors, passing it to the configured LLM for semantic restructuring into BDD Gherkin, and falling back to robust local heuristic parsers only if the AI gateway is unavailable.

### 2.1 Microsoft Excel (`.xlsx` / `.xls`)
- **Tabular Semantic Preprocessing**: Reads spreadsheet worksheets via `XLSX` and converts non-empty rows into semantic rows prefixed with exact physical row numbers (e.g. `[Row 14] Module | Feature | Criteria`).
- **AI Deep Structuring**: The LLM analyzes the entire table context, handles arbitrary column configurations, structures standard User Stories (`As a / I want / So that`), and transforms informal acceptance criteria into rigorous BDD Gherkin (`Given / When / Then`).
- **Exact Row Traceability**: AI preserves and maps the physical row number (`Row 14`) to `sourceAnchor`.
- **Heuristic Fallback (`parseXlsxHeuristic`)**: If no AI provider is configured or the AI request fails, automatically falls back to local 3-column header sniffing with merged cell downward propagation.

### 2.2 Microsoft Word (`.docx`)
- **Text Extraction**: Uses `mammoth` to extract structured markdown while preserving headings (H1, H2, H3), paragraphs, and bullet points. Falls back to `extractRawText` if markdown conversion fails.
- **Large Document Chunking (`splitForAI`)**: Documents exceeding 15,000 characters are partitioned along heading boundaries so the AI context window never truncates requirements.
- **AI Structuring**: Decomposes headings and paragraphs into hierarchical Epics, Stories, and Acceptance Criteria (ACs) with strict Gherkin syntax and section heading anchors (`Section 2.1 - Login UI`).
- **Heuristic Fallback**: Falls back to internal markdown heuristic parser if AI fails.

### 2.3 Markdown (`.md`)
- **Direct Semantic Extraction**: Extracted directly as UTF-8 text and streamed to the AI model.
- **AI Structuring**: Generates clean hierarchies with Markdown heading anchors (`## 1.1 SMS Login`) and BDD Gherkin criteria.
- **Heuristic Fallback**: Falls back to `parseMarkdownRequirements` if AI is unconfigured or fails.

### 2.4 CSV (`.csv`)
- **Row-Aware Preprocessing**: Pre-indexes all lines with physical row anchors (`[Row N]`).
- **AI Structuring**: AI transforms comma-separated records into standard Epics, Stories, and Gherkin ACs, locking `sourceAnchor` to the originating row (`Row 8`).
- **Heuristic Fallback**: Falls back to `parseCsvRequirements` if AI fails.

---

## 3. Data Architecture & Database Schema

The database layer is managed by migration `013_add_prd_documents_and_versioning.ts`.

### 3.1 `prd_documents` Table
Stores registered PRD document entities within a project:
```sql
CREATE TABLE IF NOT EXISTS prd_documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  file_type TEXT NOT NULL DEFAULT 'docx',
  current_version_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prd_documents_project ON prd_documents(project_id);
```

### 3.2 `prd_document_versions` Table
Tracks version snapshots, physical file storage, and parsed metrics:
```sql
CREATE TABLE IF NOT EXISTS prd_document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES prd_documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL DEFAULT 1,
  version_tag TEXT NOT NULL DEFAULT 'v1.0',
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL DEFAULT '',
  parsed_summary TEXT NOT NULL DEFAULT '',
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prd_doc_versions_doc ON prd_document_versions(document_id);
```

### 3.3 `requirements` Table Extension
Extended with provenance and anchor metadata:
- `document_id TEXT`: References parent PRD document (`idx_requirements_document`).
- `document_version_id TEXT`: References the specific document version snapshot (`idx_requirements_doc_version`).
- `source_anchor TEXT`: Section heading or spreadsheet row anchor (e.g., `Section 2.1 - Login UI` or `Row 14`).

---

## 4. Local File Archiving & Storage

- Original binary files (`.docx`, `.xlsx`, `.md`, `.csv`) are stored locally on the server filesystem at:
  ```
  server/storage/prd-files/{projectId}/{versionId}_{sanitizedFileName}
  ```
- File persistence is atomic: if the database transaction fails during commit, uploaded physical files are immediately unlinked/cleaned up.
- **Download Endpoint**:
  ```http
  GET /api/requirements/:projectId/documents/:docId/versions/:versionId/download
  ```
  Streams the original file back to the browser via Express `res.download(filePath, version.fileName)` with correct `Content-Disposition`.

---

## 5. Compile Gate & Smart Diff Engine

### 5.1 Compile Gate (`compilePrdGate`)
Validates and sanitizes parsed items before database admission:
- **Level Validation**: Enforces valid requirement levels (`epic`, `story`, `ac`).
- **Two-Pass ID Resolution**: Assigns permanent IDs and resolves `parentTempId` to actual parent IDs even if children precede parents in the parse output.
- **Orphan Auto-Correction**: Unattached Stories attach to the active Epic; unattached ACs attach to the active Story.
- **Gherkin Syntax Enforcement**: Verifies AC descriptions contain `Given`, `When`, and `Then` steps, emitting non-blocking warnings if heuristic padding was used.

### 5.2 Hierarchical, Level-Isolated Smart Diff Engine (`computePrdDiff`)
When parsing a new version against an existing PRD across all supported formats (`.xlsx`, `.docx`, `.md`, `.csv`):
1. **Strict Level Isolation**: Epics, Stories, and Acceptance Criteria (ACs) are partitioned into isolated tiers. Matching is strictly enforced within each requirement level, preventing cross-level collision where tabular PRDs share the same row anchor (e.g., `Row 2` containing Epic, Story, and AC simultaneously).
2. **Global Multi-Pass Phase Matching**:
   - **Phase A (Hierarchical Semantic Match)**: Matches by exact normalized title under the same parent context (stripping markdown `#` prefixes, section numbering like `1.2 - `, punctuation, and case). Running title matching across all items before anchor matching guarantees that row/section shifts (such as inserting a new row at the top of an Excel sheet) never cause anchor theft.
   - **Phase B (Global Title Match)**: Matches by normalized title globally if a story or AC moved to a different parent.
   - **Phase C (Physical Anchor Match for Renames)**: Only items that were NOT matched by title attempt to match by `sourceAnchor` (e.g. `Row 14` or `Heading: Payment`). If a requirement was renamed in place without moving rows, its stable ID is preserved as `modified`.
   - **Phase D (Substantial / Fuzzy Title Match)**: Strips renumbered prefixes and matches substantial substrings (e.g., `1.0 Overview` matching `2.0 Overview`).
   - **Phase E (Ordinal Match for Structured ACs)**: For structured spreadsheet rows under the same Story with identical sibling counts, preserves positional identity.
3. **Parent Rewriting**: After ID binding, all child `parentId` references in the new tree are automatically rewritten to existing stable database IDs through `stableIdMap`, preserving traceability to historical test cases and executions.
4. **Diff Status Tagging & Version Provenance**:
   - `added`: Brand new requirement introduced in this version (assigned to new version ID).
   - `modified`: Existing requirement whose title or description changed (updates to new version ID, preserves stable ID).
   - `unchanged`: Matches existing title and description (preserves human approval status and updates active `documentVersionId` to current version).
   - `deprecated`: Requirement existed in earlier versions but is absent from the new PRD. Only truly unmatched existing items are tagged deprecated. They retain their historical version ID provenance and transition to `status = 'DEPRECATED'`.
5. **Accurate Version Metrics**: `itemCount` on `prd_document_versions` accurately records active requirements in that version snapshot, excluding deprecated items from earlier versions.

---

## 6. API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/requirements/:projectId/documents` | List all PRD documents with version tag, item count, and timestamps |
| `GET` | `/api/requirements/:projectId/documents/:docId/versions` | List version snapshot history for a PRD document |
| `GET` | `/api/requirements/:projectId/documents/:docId/diff` | On-demand diff comparison between any two versions (`?baseVersionId=...&targetVersionId=...`) |
| `POST` | `/api/requirements/:projectId/documents/parse-preview` | Upload file (`multipart/form-data`) with AI config; returns parsed tree and diff stats |
| `POST` | `/api/requirements/:projectId/documents/commit` | Commits staged requirements, saves original file, and registers version snapshot |
| `DELETE` | `/api/requirements/:projectId/documents/:docId` | Deletes PRD document (`?deleteRequirements=true` cascades requirement deletion, default unlinks) |
| `DELETE` | `/api/requirements/:projectId/documents/:docId/versions/:versionId` | Deletes a specific PRD version snapshot (`?deleteRequirements=false` preserves requirements) |
| `GET` | `/api/requirements/:projectId/documents/:docId/versions/:versionId/download` | Download original PRD source file with original file name |

---

## 7. Frontend UI Architecture & Workflows

### 7.1 PRD Import Modal (`PrdImportModal.tsx`)
- **Mode Switching**: "Create New PRD Document" vs. "Update Existing PRD (New Version)".
- **AI Configuration**: Dropdown selection of active AI Providers and Models configured in the project.
- **Drag-and-Drop Dropzone**: Supports `.docx`, `.xlsx`, `.md`, `.csv` with client-side file type and size validation.
- **Title & Version Tagging**: Automatically sniffs and strips version suffixes (e.g., `v1.0`) from document title while populating the version tag field.
- **Real-Time Diff Preview**: Shows summary statistics chips (`Total`, `Epics`, `Stories`, `ACs`, `+ Added`, `~ Modified`, `- Deprecated`, `Unchanged`).
- **Gherkin Formatting & Compile Gate Warnings**: Color-coded badges and collapsible warning banners for non-fatal anomalies.

### 7.2 PRD Document Library Modal (`PrdDocumentsModal.tsx`)
- **Document Catalog**: View all project PRDs with file type icons, current version tags, requirement counts, and modification dates.
- **Version History Drawer**: Inspect all historical versions with download buttons and item count metrics.
- **Version Comparison Trigger**: Prominent "Compare" button on document card and version items to launch the diff viewer.
- **Action Triggers**: Quick "Upload New Version" button that opens `PrdImportModal` pre-bound to the target document.
- **Safe Deletion**: Deletion dialogs with explicit toggle to either unlink requirements or cascade delete them.

### 7.3 PRD Version Diff Viewer (`PrdVersionDiffModal.tsx`)
- **Arbitrary Version Pairing**: Compare any historical version against another (e.g., `v1.0` vs. `v1.1`), with one-click version swapping.
- **Summary Metrics**: Real-time counters and filter tabs for `+ Added`, `~ Modified`, `- Deprecated`, and `Unchanged`.
- **Hierarchical Difference Tree**: Color-coded badges with ancestor retention to preserve full context.
- **Before & After Visual Inspector**:
  - Highlights modified requirements with side-by-side or stacked "Previous Specification" vs. "Updated Specification".
  - Shows precise Gherkin criteria changes and agile story evolution.

### 7.4 Traceability & Workbench Views
- **Requirements Tree (`RequirementTree.tsx`)**: Displays a `FileText` icon with interactive tooltip showing document title, version tag, and source anchor for all linked requirements.
- **Epic & Story Detail Views (`EpicDetailView.tsx`, `StoryDetailView.tsx`)**: Render a dedicated provenance pill badge in the header:
  ```
  PRD: [Document Title] ([VersionTag]) · [sourceAnchor]
  ```
- **AC Card (`ACCard.tsx`)**: Displays a subtle source anchor chip (e.g., `Row 14` or `Section 2.1`) linking specific acceptance criteria to physical PRD rows/sections.
- **PRD Filter**: Dropdown on the requirements page to filter the entire hierarchy by a specific PRD document.

---

## 8. Downstream AI Test Generation Integration

### 8.1 Current Status (Implemented)
- Requirements loaded into `TestGenConfigPanel.tsx` retain and display their `documentId` and `sourceAnchor`, allowing test engineers to verify requirement provenance before kicking off test generation.
- Requirements maintain their PRD version snapshot lineage and source anchors in the requirement tree and detail views.

### 8.2 Roadmap (Planned)
- Propagate `documentId`, `documentVersionId`, and `sourceAnchor` directly into generated test suite and test step metadata (`step.metadata.sourceAnchor`), enabling execution reports and defect telemetry to trace directly back to the physical PRD document paragraph/row.

---

## 9. Localization Standard

All components, error messages, user dialogs, table headers, tooltips, and documentation in this module are strictly maintained in **English**.
