## Project context
Specs live in _docs: ats-project-scope.md (what), tech-stack.md (how), tradeoffs.md (what is deliberately out of scope). Read them before starting a task.
Work from _docs/tasks.md, one task at a time in strict sequential order. When given a batch of tasks (e.g., Tasks 9–12), proceed automatically to the next task in the batch only after the `reviewer` sub-agent has verified, merged, and closed the current task.
If a task conflicts with the specs, requires an owner decision, or needs external "Owner action required", stop the batch immediately and ask instead of guessing.

## Commits
Make focused, regular commits, and explain your decisions in the commit messages so we can use them as logs.
Run the tests before every commit; don't commit failing tests.
Never commit secrets, .env files or credentials. Exception: `docker-compose.yml` may contain obviously fake, local-only test values (e.g. `local-only-not-secret-…`, the public Azurite account key, Cloudflare's Turnstile test keys, a local Postgres password) so the stack starts on a fresh clone. They must never be used outside the local/CI Compose stack.

## Docs
When a decision changes the specs, update the relevant file in _docs in the same commit.
Mark a task as done in _docs/tasks.md when its "Done when" criteria pass.

## Branching
Doc-only changes during setup: commit directly to main.
Each task from _docs/tasks.md: create a branch named task-<number>-<short-name>, push regularly, mark the task with ` ✅` in `_docs/tasks.md` when its "Done when" criteria pass, and open a pull request.
A pull request may only be merged by the `reviewer` sub-agent after `ci.yml` is green on GitHub and all acceptance criteria and T8 test-integrity checks pass (or directly by the owner).

## Roles
- PM - grooms a task before anyone implements it, follows .claude/agents/pm.md
- Engineer - implements one groomed task, follows .claude/agents/software-engineer.md
- Reviewer - verifies the PR against the issue, specs, T8 and green `ci.yml`, merges the PR and closes the issue, follows .claude/agents/reviewer.md

Act in one role at a time. The PM doesn't write code; the Engineer doesn't edit issue descriptions, merge PRs, or close issues; the Reviewer doesn't write feature code.