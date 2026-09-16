---
name: quality_rules
description: Load the complete review rules for the Quality Manager role (9 review dimensions, review discipline, coverage matrix F27, F17 component-vs-flow redundancy, D2 cross-batch redundancy). Use when you are about to review draft test cases — MANDATORY: call before reviewing any cases.
---

# Quality Rules — Review Dimensions & Coverage Matrix Guidelines

## Review Dimensions (checklist, not a vibe check)

1. **Clarity (Step Atomicity — hard constraint)** — Each step: one verb, one target, input values inside the step's own `action` (NOT deferred as a "with X/Y" suffix), `expected` is a single machine-detectable observation. If any check fails, split the step, set `status: approved_with_changes`, log the split reason in `changeLog`. Typical error patterns: `"Submit the login form with admin/admin123"`, `"Enter username and password"`, `"Click login and verify dashboard appears"`, `"Set username to admin and password to p@ss then click submit"`.

2. **Completeness** — Does the technique application satisfy what it requires (BVA names the real boundary; Decision Table states every condition input; EP is paired with its complement)? Are the condition's explicit data variants tested? Does the requirement's case set include both happy-path AND negative/error/boundary coverage?

3. **Correctness** — Do expected results match what the requirement/AC actually specify — not just what "sounds plausible"? Flag results that contradict or extrapolate beyond the requirement text.

4. **Traceability** — Every case lists its primary condition in `coveredConditions` (a `conditionId` not in `coveredConditions` is a defect). For flow conditions with `flowStepRefs`, steps mirror the flow's `sequence` order.

5. **Data Validity** — Is test data concrete, realistic, and technique-correct (partition/boundary explicitly named)? Flag placeholder data ("test123", "foo") that isn't a real partition/boundary.

6. **Maintainability** — Preconditions self-contained with no hidden dependency on another case's side effects; steps concrete enough to execute without brittle over-specific selectors.

7. **Test Level Fidelity** — `testLevel` is set by the Designer and MUST be preserved (never flip component↔integration). Check whether steps actually honor the level: `integration` MUST traverse 2+ components and assert the downstream state change; `component` MUST stay within one component. If steps don't match the level, fix the steps (add/remove cross-component assertions) and set `approved_with_changes` — never change `testLevel`. Integration cases MUST have non-empty `referencedComponentConditions`; empty is a defect.

8. **Redundancy (F17 — component vs flow anti-overlap, hard check)** — For a requirement with BOTH a component and an integration case, compare the integration case's `steps[].expected` against every component case's (token overlap, not gut). If the integration case re-asserts atomic behavior the component case covers: fix it by moving the duplicate assertion into the integration case's `preconditions` (as an assumed given) and keeping ONLY the cross-component assertion in `steps`. Set `approved_with_changes` and log the de-duplication in `changeLog` with reason starting with keyword `"redundancy"` (so the TS validator knows you handled it). Do NOT delete the integration case.

9. **Cross-Batch Redundancy (D2)** — `previousBatchCoverage` shows prior-batch coverage. If a draft case duplicates a previous-batch case (same requirement, technique, behavioral assertion), note it in `reviewSummary`, set `approved_with_changes` with a `changeLog` reason starting with `"cross-batch-redundancy"`. You can't delete the case, but flag it for the final reviewer.

## Review Discipline
- Every returned case needs `status`: `approved` or `approved_with_changes`. Never silently pass a flawed case — if you alter any field, set `approved_with_changes`, apply the fix, and log it.
- `changeLog` is non-empty IFF you changed the case: every altered case needs a field-level entry (what changed, why); untouched cases keep `changeLog: []`. No invented entries for cosmetic non-changes.
- Judge substance, not polish — a well-formatted case can still fail Completeness or Correctness.
- Per-requirement pass: confirm each requirement's cases collectively include both a positive and a negative/boundary/error condition. If a requirement is all happy-path, you can't add a case yourself — say so in that requirement's `reviewSummary`.
- Batch-level pass: confirm each flow step exposed in the user message has ≥1 flow condition (and flow case) referencing it. If uncovered, flag it in the coverage matrix row whose `flowStepRef` points at it.

## Coverage Matrix (MANDATORY — F27)
After the per-case and set-level passes, emit a `coverageMatrix`. You contribute **only the semantic assessment** per condition via `emit_coverage_row` — the system deterministically computes `coveredByCaseIds`, `coverageStatus`, `testLevel`, `primaryTechnique`, `category`, and the `summary` (so you do NOT emit those fields).

For each `conditionId` from the Analyst's output (one `emit_coverage_row` per condition, no more, no less):
- `conditionSummary` — short phrase (≤120 chars) derived from the Analyst's condition text.
- `notes` — any gap or concern (e.g. "only valid partition covered, invalid missing", "integration re-asserts component behavior — moved to preconditions"). Empty if none.

The matrix is the single most useful artifact for the reviewer — invest in it. Do NOT omit any condition's row.
