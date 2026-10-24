# Personal Telegram Onboarding Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Implement the bounded, resumable onboarding requested in issue #6.

**Architecture:** A discoverable repository skill orchestrates native host tools;
a pure checkpoint planner prevents unsafe automatic continuation. Existing Worker
security and transport behavior stay intact; only product display copy changes.

**Tech Stack:** Node.js 24, built-in test runner, Markdown skills, Sites MCP.

**Spec:** `docs/superpowers/specs/2026-10-24-onboarding-design.md`.

## Global constraints

- No live deployment, bot, credentials, permissions, subscription or task changes.
- Keep all operational values in native private configuration, never source/logs/chat.
- Preserve stable identifiers and all existing security and delivery boundaries.
- Publish/merge only after the requested WSL Claude Code review and final CI.

## Review focus

- Partial inventory or uncertain creates must never prompt a duplicate create.
- Deleted Sites/plugins can leave active tasks and a different Telegram webhook.
- A candidate callback origin is not evidence that it is trustworthy.
- An installed plugin can have unavailable tools; wait/reconnect instead of duplicating it.
- Present credentials/configuration do not establish hosted or real-message acceptance.

## Task 1: Bounded setup helper

Files: `scripts/plan-setup.mjs`, `tests/setup.test.mjs`.
Interface: `planSetup(evidence)` returns a fixed status, checkpoint and reason from
strict enum-only observations; CLI reads stdin and prints only the fixed result.

- [ ] Write tests for fresh/resumed checkpoints, incomplete inventory, conflicts,
      uncertain operations, missing host capability, and rejection without echoing secrets.
- [ ] Run tests to see the missing implementation fail.
- [ ] Implement the helper without I/O or mutations in the planning function.
- [ ] Run the focused tests and existing suite.

## Task 2: Skill, agent guidance and public copy

Files: `README.md`, `AGENTS.md`, `.agents/skills/telegram-setup/SKILL.md`,
`docs/operations.md`, `worker/index.js` display text.
Consumes: helper checkpoints. Produces: discoverable, bounded operational workflow.

- [ ] Preserve relevant README material in AGENTS.md and link existing manuals.
- [ ] Write the setup skill with native capability discovery, Site/canonical plugin
      reuse, secure inputs, approval checkpoints, identity/callback gates and safe resumption.
- [ ] Shorten README, update display names, and retain stable client identifiers.
- [ ] Verify the skill's syntax/references and run all tests/build/artifact checks.

## Task 3: Review and authorized publication

- [ ] Have existing WSL Claude Code review the actual diff and setup scenarios;
      address actionable findings with applicable regression coverage.
- [ ] Run final checks, commit and open a draft PR; run required CI on final head.
- [ ] Merge when review and CI are clean, verify remote main and merged commit.
- [ ] Report local/CI checks separately from unrun live acceptance and explain the
      owner's subsequent clean-install checks without deleting anything for them.
