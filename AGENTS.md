## Project context
Specs live in _docs: ats-project-scope.md (what), tech-stack.md (how), tradeoffs.md (what is deliberately out of scope). Read them before starting a task.
Work from _docs/tasks.md, one task at a time. Don't start the next task unless asked.
If a task conflicts with the specs, stop and ask instead of guessing.

## Commits
Make focused, regular commits, and explain your decisions in the commit messages so we can use them as logs.
Run the tests before every commit; don't commit failing tests.
Never commit secrets, .env files or credentials.

## Docs
When a decision changes the specs, update the relevant file in _docs in the same commit.
Mark a task as done in _docs/tasks.md when its "Done when" criteria pass.

## Branching
Doc-only changes during setup: commit directly to main.
Each task from _docs/tasks.md: create a branch named task-<number>-<short-name>, push regularly, and open a pull request when the "Done when" criteria pass.
Never merge a pull request without my approval.