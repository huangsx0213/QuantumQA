# AUT Demo — Requirements Test Basis

Versioned requirements specifications (identical content across three formats
per version), used as the test basis for the demo AUT (`aut/`):
import → version diff → AI test generation → execution.

## Files

| File | Role |
|---|---|
| `AUT-Demo-Requirements-v1.0.md` | **Source of truth v1.0** — baseline |
| `AUT-Demo-Requirements-v1.0.xlsx` | 3-column sheet (`Epic` \| `Story` \| `Acceptance Criteria`) |
| `AUT-Demo-Requirements-v1.0.docx` | Word OOXML (Title / Heading1 / Heading2 / Heading4) |
| `AUT-Demo-Requirements-v1.1.md` | **Source of truth v1.1** — diff variant, see below |
| `AUT-Demo-Requirements-v1.1.xlsx` / `.docx` | Same content as v1.1.md in the other formats |
| `generate.mjs` | Derives .xlsx and .docx from every versioned .md and self-verifies them |

## v1.1 — diff variant (exercises version diff)

Same structure as v1.0 plus a deliberate delta so that committing it as
version 2 of the same document produces a meaningful diff:

- **Added**: story "Test data reset endpoint" with 2 ACs (response shape,
  deterministic 18/12/6 counts with inactive IDs 2, 4, 7, 10, 13, 16) — reflects
  the real `POST /aut-api/test/reset` endpoint in `aut/server/routes.ts`.
- **Modified**: 3 ACs tightened without changing titles ("Remember me checkbox
  toggles without side effects", "Wrong password rejected", "Toast auto-dismiss
  window") — all verified true in the AUT code.
- **Deprecated**: story "XML content type" + AC "XML response format" removed
  from scope (deferred).

Committed to QuantumQA as version 2 of the PRD document, the diff resolves to
106 unchanged / 3 modified / 3 added / 2 deprecated. md source anchors are
content-based (`Heading: <title>`), so inserting or deleting sections does not
misalign pairs across versions.

## Regenerate

After editing any versioned markdown:

```bash
node generate.mjs                # all AUT-Demo-Requirements-v*.md in this dir
node generate.mjs path/to/file.md  # just one
```

The script refuses unexpected heading depths (only `#`, `##`, `####` are part of
the contract) and warns about missing story/AC segments. It also prints the
mammoth round-trip heading counts and the AI-path chunk layout.

## Scope

v1.0: 7 epics · 33 stories · 71 acceptance criteria. v1.1: 7 epics · 34 stories
· 73 acceptance criteria (2 former ACs deprecated, net +2 rows).

1. Authentication and Session Management
2. Home Dashboard
3. User List and Filtering
4. User Creation and Editing
5. Batch Operations and User Actions
6. Reports and Analytics
7. API Robustness and Fault Tolerance

## Import notes (QuantumQA requirements module)

- **md / xlsx parse deterministically** — no AI call, exact content.
- **docx runs through AI structuring** in heading-aligned chunks; if AI is
  unavailable it falls back to the deterministic markdown parser with identical
  content. Expect LLM normalization (titles reworded, counts may vary slightly).
- **xlsx quirks**: story descriptions are template-generated ("Story: <title>")
  by the 3-column parser, and AC titles are the first 80 characters of the
  Gherkin cell (may contain line breaks).
- **Commit the md only** — importing all three formats of the same version as
  the same document would triple the requirement rows; the xlsx/docx files are
  deliverables for human review and were verified via parse-preview.
- Count-specific ACs assume a **freshly seeded** `aut/server/db.json` (18 users,
  12 active / 6 inactive; IDs 4–18 get randomized roles). Reset it via
  `POST /aut-api/test/reset` (unauthenticated, demo test infrastructure) instead
  of deleting the file and restarting the server. See the
  "Test Data and Preconditions" section in the markdown.
