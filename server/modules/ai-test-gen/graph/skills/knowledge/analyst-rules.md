---
name: analyst_rules
description: Load the complete condition derivation rules for the Test Analyst role (conditionType decision, technique coverage, F8 flow-step coverage, F30 cross-requirement consolidation, risk assessment, technique selection). Use when you are about to derive test conditions — MANDATORY: call before generating any conditions.
---

# Analyst Rules — Condition Derivation Guidelines

## Risk Assessment
Rate each requirement on two axes before assigning priority:
- **Likelihood**: complexity, novelty, change frequency, dependencies, defect history.
- **Impact**: business criticality, user/data exposure, regulatory/financial consequence, blast radius.
`critical` requires BOTH axes high. Routine CRUD/display items are usually `medium`/`low` — don't inflate everything.

## Technique Selection (decision rule)
| Technique | Use when... |
|---|---|
| Equivalence Partitioning (EP) | An input has distinct valid/invalid value classes (format, type, range-as-group). |
| Boundary Value Analysis (BVA) | A field has a numeric/length/date range, quota, or threshold. Pair with EP on the same field. |
| Decision Table | An outcome depends on 2+ independent conditions combining (pricing, eligibility, permissions, routing). |
| State Transition | An entity has a lifecycle/status, or behavior depends on prior actions (wizards, session state). |
| Use Case | An end-to-end goal spans multiple steps/screens/services and sequence/actor intent matters. |

Pick the strongest fit; don't force a weak match. Record `secondaryTechniques` only when genuinely applicable; justify each in `techniqueRationale` by naming the triggering characteristic.

## Sizing & Hygiene
- **Technique-Driven Count**: scale condition count to requirement complexity (2-4 typical, higher for complex logic). Let the technique dictate the count — never under-cover to hit a round number.
- **Smart Deduplication**: merge near-duplicate conditions differing only in data variants. Never merge valid into invalid partitions; never merge invalid conditions with distinct error paths.
- **Strict Traceability**: every condition traces to ≥1 source `requirementId` taken verbatim from the input.

## A. Condition Type: component vs flow
- **component** — verifies ONE requirement's atomic behavior in isolation (single-field validation, single business rule, internal state transition). Test stays inside one component.
- **flow** — verifies cross-component interaction from a business flow (data handoff, end-to-end sequence, state propagation). Test traverses 2+ components.

Assign `conditionType` per CONDITION (not per requirement), by what it VERIFIES (atomic vs cross-component), not just its origin:

| Source / characteristic | conditionType | flowStepRefs? |
|---|---|---|
| From a **flow step** — cross-component data flow / interface contract / end-to-end sequence | `flow` | YES (exact `{flowId, sequence, actionSummary}`) |
| **Use Case Testing** as primary technique (multi-step goal spanning services) | `flow` | YES |
| A **requirement AC** — single field's input validation/format/range (EP/BVA), single rule outcome, invalid/boundary input, or in-module state transition | `component` | no |
| **F22** From a flow step but only validates one field's atomic input/format (e.g. "password masked as typed" inside a login flow) | `component` (keep the flow requirementId) | no |

**`flowStepRefs` rule:** every `conditionType:"flow"` condition MUST list ≥1 `{flowId, sequence, actionSummary}` — the bridge for Designer/Quality tracing and "which flow steps are uncovered?".

**`flowId` source rule (CRITICAL):** the `flowId` MUST be the exact `id` from input `flowBlueprints` (typically an AC-level requirement id like `req-aut-auth-session-happy`). NEVER invent flow IDs — a hallucinated id makes the real flow step look uncovered and auto-generates a DUPLICATE flow condition. Copy the id verbatim from `flowBlueprints`.

**`dependencies` real-ID rule (CRITICAL):** every `dependencies` entry MUST be a real condition ID — same-batch output (`"C-001"`, mixed mode) or a previous-batch query result (flow mode). NEVER fabricate compound IDs like `"component:req-aut-auth-session-happy:F-001"`. The schema REJECTS unknown values; fake IDs break the Designer's `referencedComponentConditions` downstream.

**Non-overlap rule (ANTI-REDUNDANCY):** for the SAME requirement, a `component` and a `flow` condition MUST NOT verify the same behavior. The component condition verifies the atomic behavior; the flow condition verifies ONLY the cross-component interaction surface (handoff, propagation, downstream effect, sequence) and ASSUMES the atomic behavior works — its `condition` text must NOT re-state it.

**Per-requirement guidance:** every requirement needs ≥1 `component` condition. A `flow` condition exists ONLY IF the requirement has a genuine cross-component surface (in a flow, has dependencies, touches an external system) — then it must be non-overlapping with the component condition.

**F8 — flow-step coverage (MANDATORY):** EVERY step in flow stories (including exception/error steps like "invalid credentials show error and allow retry") MUST be referenced by ≥1 `conditionType:"flow"` condition's `flowStepRefs`. A step with zero references is a hard validation failure — no exceptions. Even if a flow step seems to add no new surface beyond a component condition, still create a minimal flow condition whose text focuses on the interaction aspect (e.g. "auth service rejects invalid credentials and the login page shows the error inline allowing retry").

## B. Technique Coverage (hard requirements)
| Technique | Mandatory coverage |
|---|---|
| EP | valid-partition condition AND ≥1 invalid-partition condition (separate, never merged) |
| BVA | `condition` names the actual boundary + position (e.g. "exactly at the 100-character limit") — never "test with large input" |
| Decision Table | cover every business-relevant rule combination, including the no-match/default case |
| State Transition | ≥1 invalid/disallowed transition per modeled entity |
| Every requirement | ≥1 condition in `error`/`boundary`/`validation` category — happy-path-only is under-testing |

## C. Final Self-Check
Per condition: `requirementId` exact; `category` present; `conditionType` is `"component"` or `"flow"`; if flow, `flowStepRefs` non-empty; every `dependencies` entry is a real condition ID.
**HARD RULE:** `primaryTechnique: "Use Case Testing"` ⇒ `conditionType: "flow"` (no exceptions). A component condition must use EP/BVA/Decision Table/State Transition instead.
Per requirement: ≥1 component condition; flow condition only if a cross-component surface exists and it doesn't re-state the component condition.
Per flow step: ≥1 `conditionType:"flow"` condition references it via `flowStepRefs` (exception/error steps NOT optional).
Per technique: section B coverage satisfied. `coverageDimensions` is free-form tags — do NOT use `testLevel:*` tags anymore (use `conditionType`).

## Cross-Requirement Consolidation (F30)
After deriving all conditions, consolidate: if two conditions from DIFFERENT requirements verify the same atomic behavior (e.g. "email format validation" in registration AND login), MERGE into one condition using the first requirement's id. Do NOT merge across different techniques (EP vs BVA). Log merges in `requirementAnalysis.overallApproach`.
