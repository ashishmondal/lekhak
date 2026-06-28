# TODOS

Deferred work captured during reviews. Each item carries enough context that
someone picking it up months later understands the motivation and where to start.

---

## TD1 — E4-full: structured per-character state ledger

- **What:** A per-character "current state" record (status, relationships,
  knowledge, location) that the context engine can surface to keep characters
  behaving consistently across chapters.
- **Why:** The story synopsis tracks *plot*, not *character behavior*. Without a
  state ledger, a character can act inconsistently with how they were last
  established (e.g. forgets an injury, re-learns something they already knew).
- **Pros:** Closes the character-consistency gap; the highest-value remaining
  continuity feature after plot synopsis.
- **Cons:** Reliable state tracking is hard — a naive accumulated summary
  hallucinates and drifts worse than nothing (this is exactly why the cheap
  "E4-min state line" was dropped during the 2026-06-28 eng review).
- **Context:** The eng review's outside voice showed that a per-character state
  *line* maintained by accumulation is net-negative: it only covers carded
  entities (not the pronoun/unnamed ones that caused the original bug) and
  contradicts the whole prior chapter sent verbatim. The correct design
  **re-derives** each character's state from source text every chapter (never
  accumulates a summary-of-a-summary), so drift cannot compound. Start from the
  lazy-synopsis infrastructure in Slice 1 (`SynopsisService`, `ai/completion.ts`).
- **Depends on / blocked by:** Slice 1 synopsis infrastructure must land first.

## TD2 — Full LLM-judgment eval harness + dataset

- **What:** A real evaluation runner with a curated dataset and baseline
  comparisons for the LLM-judgment features (drift check, canon check,
  extraction).
- **Why:** CI cannot currently verify the *quality* of these judgments — only the
  plumbing is unit-tested with the FakeProvider. The only quality signal is a
  small key-gated fixture eval that is **skipped in CI**.
- **Pros:** Makes "is the drift checker actually catching real contradictions
  without crying wolf?" a measurable, regression-guarded property.
- **Cons:** Real infrastructure this repo doesn't have (108 tests, all Vitest
  unit, no eval runner); needs a maintained labelled dataset.
- **Context:** During the eng review (T-eval) we chose to ship plumbing unit
  tests now + a tiny opt-in fixture eval, and defer the full harness here. Build
  on the fixture eval format introduced in Slice 2.
- **Depends on / blocked by:** Slices 2–3 (the features being evaluated) shipped;
  the fixture eval format exists.

## TD3 — Revisit default-on for the drift check (E2b) and extraction (E3)

- **What:** Flip E2b (drift check) and E3 (extraction) from opt-in to on-by-
  default.
- **Why:** They ship opt-in (eng-review decision X4) because default-on means
  every user's BYOK key silently pays for background LLM judgment whose quality
  CI can't yet verify. Once that quality is proven, default-on maximizes the
  consistency safety-net's reach (most users never discover an opt-in toggle).
- **Pros:** Broader value delivery; the safety-net helps users who'd never enable
  it manually.
- **Cons:** Premature default-on charges users for an unproven, possibly noisy
  feature.
- **Context:** Gate the flip on TD2 showing acceptable precision/recall and cost.
  The material-diff gate (built in Slice 2) already bounds the spend.
- **Depends on / blocked by:** TD2 (eval harness proving quality).

## TD4 — Document the T9 advisory-flag component in DESIGN.md ✅ DONE

> Resolved with the Slice 2/3 UI: `DESIGN.md` "Signature components" now names the
> advisory drift/extraction **chip + popover** (`--warn`/`--accent` on `.chip`
> opening a `--shadow-menu` popover) and records the advisory-vs-error distinction
> (`.chip` vs the red `.banner`). The settings consistency-toggle row ships in
> `settings.component.{html,css}`. Left below for historical context.

- **What:** After the Slice 2 UI (T9) ships, add the advisory drift/extraction
  **chip + popover** and the **settings-toggle row** to `DESIGN.md` under
  "Signature components".
- **Why:** `DESIGN.md` is the stated single source of truth for the visual
  identity. The advisory chip+popover is a new *named* component pattern (distinct
  from the error `.banner`); if it isn't recorded, future mockups and contributors
  drift from it and may re-introduce the banner-vs-chip confusion this design
  review resolved.
- **Pros:** Keeps mockups and the shipped app in sync; codifies the
  advisory-vs-error distinction (`--warn`/`.chip` vs `--danger`/`.banner`).
- **Cons:** Small documentation chore; only meaningful once the component exists.
- **Context:** Added during the 2026-06-28 `/plan-design-review`. The review
  deliberately reused existing vocabulary (`.chip`, `.menu`, `.mention-menu`)
  rather than invent new components — but the assembled advisory pattern is worth
  naming. Could alternatively be folded into the T9 PR's definition-of-done.
- **Depends on / blocked by:** T9 (Slice 2 UI) landing.
