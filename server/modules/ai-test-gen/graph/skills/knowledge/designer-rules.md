---
name: designer_rules
description: Load the complete test case design rules for the Test Designer role (step atomicity, technique fidelity, test level decision, F12 anti-redundancy, F18 step self-check, F31 case budget, F32 test data format, self-review scoring). Use when you are about to design test cases — MANDATORY: call before designing any test cases.
---

# Designer Rules — Test Case Design Guidelines

## Output Format — see system prompt
Choose ONE mode (all `emit_case` calls OR one JSON block) — never mix. The verb enum, `data`/`expectation` coupling rules, and the Mode A workflow are fully specified in your system prompt; do not reload them here. In Mode A, exit ReAct only after the LAST case is emitted via `emit_case`.

## Step Atomicity (one step = one action = one observable result)
Each step must contain exactly ONE action; its result must be independently verifiable. Input entry, click/trigger, wait, and assert are each their own step. Input values live inside the step's own `action` — never deferred to a later "submit" step as a "with X/Y" suffix.

**Split these compound actions into separate steps:**
- `"Submit the login form with admin/admin123"` → 3 steps: `fill 'admin' into the username field` · `fill 'admin123' into the password field` · `click the Sign in button`
- `"Enter username and password"` → one `fill` step per field
- `"Click login and verify dashboard appears"` → click → wait → verify (three steps)
- `"Enter 'test123' into the password field while leaving username empty"` → step 1 `verify the username field is empty` → step 2 `fill 'test123' into the password field`
- `"verify both username and password fields are empty"` → one `verify` step per field

**Compound-action signal words** (schema rejects any `action` containing them — split first):
| Signal | How to split |
|---|---|
| `while` + action gerund | Extract the concurrent state as its own step, then the action |
| `, then` | One step per action, in order |
| `but leave` / `but don't` / `without` | Extract the contrast state as its own step |
| `both` | One step per target |

**`expected` — one assertion per step.** Never join two outcomes with `;` / `；` / ` and ` / `→`. A semicolon means two assertions → split into two steps (this is the #1 schema-rejection cause for negative cases). `expected` must be a machine-detectable observation (DOM state, HTTP status, stored value) — NOT "works correctly", and NOT a traceability map ("TC-009 Steps 1-2"). ≤ 200 chars. Standard ordering: input → trigger → wait → assert.

Negative cases produce two outcomes — the "did NOT happen" and the "instead state" — as two separate steps.

## Technique Fidelity (honor the condition's `primaryTechnique`)
| Technique | The test case must |
|---|---|
| Equivalence Partitioning | `testData` names the partition (e.g. "email = not-an-email (invalid partition)") |
| Boundary Value Analysis | `testData` gives the exact boundary + position (e.g. "quantity = 0 (one below minimum 1)") — never "a large number" |
| Decision Table | `preconditions`/`testData` enumerate every condition input for the rule row under test |
| State Transition | `preconditions` state the start state; final `expected` states the result state (or that an invalid transition was rejected) |
| Use Case | Steps mirror the actual flow sequence; include system-initiated steps (async response, webhook) |

Copying the technique name without honoring its method above is not acceptable.

## Test Level Decision Rule
Honor the condition's `conditionType` (do not override):
- `component` → `testLevel: "component"`, `coveredConditions: [<this condition's id, e.g. "C-001">]`, `referencedComponentConditions: []`, steps stay within one component.
- `flow` → `testLevel: "integration"`, `coveredConditions: [<the flow condition's id, e.g. "C-008">]`, `referencedComponentConditions: [<component condition ids, e.g. "C-001", "C-006">]` (non-empty), steps traverse 2+ components and assert only the cross-component outcome.

**`coveredConditions` / `referencedComponentConditions` contain CONDITION IDs only** — the `C-xxx` values from the Analyst's output. **NOT requirement IDs** (e.g. `req-aut-auth-session-invalid`), **NOT flow IDs**, **NOT flowStepRefs.flowId**. If you are unsure which condition id to use, look it up: each condition in the input has an `id` field (e.g. `"C-008"`) — that is what goes into `coveredConditions`.

**`referencedComponentConditions` vs `coveredConditions` (most common mistake):** `coveredConditions` = conditions this case VERIFIES. `referencedComponentConditions` = component conditions it ASSUMES as already-verified preconditions. NEVER put a flow-typed id in `referencedComponentConditions` — only component-typed ids belong there. Use real condition ids from the input; never fabricate.

**F12 anti-redundancy:** an integration case's `steps[].expected` must NOT re-assert behavior a sibling component case already verifies. If it does, REMOVE the overlapping assertion from steps (the dependency is declared via `referencedComponentConditions`, not restated in steps or preconditions).

## Precondition Quality (F12-precondition)
`preconditions` must be concrete, settable system states — NOT behaviors that happen during the test.
- WRONG: `"Client-side validation passes for well-formed credentials (per C-005)"` · `"Login page UI is functional (per C-001)"`
- RIGHT: `"User account 'admin' exists with password 'admin123'"` · `"Login page is loaded at /login with all form fields rendered"`

If a precondition uses a behavior verb ("passes"/"works"/"is functional"), rewrite it as a concrete state. Declare behavior dependencies via `referencedComponentConditions`, not preconditions.

## F18 — Step Atomicity Self-Check (before output)
Quickly verify each step: one verb? one target? no `while`/`, then`/`but leave`/`both` signals? data inline in the step? `expected` is a single machine-detectable observation with no semicolons and no `→`/`TC-XXX Step N` mapping? every concrete value in `expected` (URL, title, message text, status code) traceable to requirement/flow/HTML evidence? If any check fails, split and rewrite before outputting.

## Test Data Format (F32)
`testData` entries: `<field> = <value> (<partition/boundary label>)` — e.g. `username = admin (valid partition)`, `password = "" (empty boundary)`, `quantity = 0 (one below minimum boundary)`.

## Case Budget (F31, guideline not hard limit)
critical: 3-5 cases (valid + invalid + boundary + edge) · high: 2-3 (valid + invalid) · medium: 1-2 (valid + one negative) · low: 1 (happy path).

## Test Independence
Each case runs standalone from only its stated `preconditions`. If setup depends on data another case would create (e.g. "user must already exist"), state it explicitly as a precondition.

## Evidence Grounding — `expected` must be traceable (no speculation)
Every step's `expected` and every concrete value in it must trace to ONE of these sources — nothing else:
1. the requirement text (acceptance criteria),
2. the flow/condition wording,
3. the HTML knowledge (actual element text, routes, page titles seen in uploaded pages).

**Never invent concrete values that appear nowhere in the evidence:**
- URLs / route paths (e.g. `/dashboard`) — only allowed if the exact path appears in the requirement, the flow text, or the HTML knowledge. If not evidenced, assert the observable UI state instead (e.g. "a welcome message for the logged-in user is displayed"), not a guessed URL.
- Page titles, button/label text, toast/notification messages, HTTP status codes, storage keys — same rule: only what the evidence explicitly states; otherwise describe the observable class of outcome, not a fabricated literal.
- Page elements that don't appear in the HTML knowledge and aren't named in the requirement.

If the evidence cannot pin down what the UI shows after an action, the weakest honest `expected` is a behavior-level observation a human could still verify ("the login button is no longer in a loading state") — never a confident-looking fabricated literal.

## Self-Review Scoring (be a genuine critic)
- **9-10**: every step atomic & verifiable; test data technique-correct & concrete; case fully independent; `testLevel` correct & honored in step design; preconditions are concrete settable states; traces cleanly.
- **6-8**: minor gaps (a bundled step, missing partition label, `testLevel` not honored, behavior precondition).
- **1-5**: missing preconditions, vague expected results, technique not actually applied, `testLevel` missing/contradictory, hidden external dependency, fabricated literal values (URLs, titles, messages) not present in the evidence.
List concrete `weaknesses`/`suggestions` when any exist — never empty arrays for a flawless score unless the case genuinely is flawless.
