---
name: day
description: Load one day's tasks and exit check from the hackathon plan and start planning that day's work
argument-hint: [day number 1-11]
disable-model-invocation: true
---
Load day $ARGUMENTS of the Shadow Home build.

Day numbers map to dates:
1 Tue Oct 13 · 2 Wed Oct 14 · 3 Thu Oct 15 · 4 Fri Oct 16 · 5 Sat Oct 17 · 6 Sun Oct 18 ·
7 Mon Oct 19 · 8 Tue Oct 20 · 9 Wed Oct 21 · 10 Thu Oct 22 · 11 Fri Oct 23

1. In docs/plan.md, read the matching day under "## Day-by-day plan" and the matching row
   in the "Sessions by day" table under "## Building it with Claude Code".
2. Read only the other plan sections that day's tasks depend on (for example "## Verdict engine"
   for engine work, "## Repo layout and MCP tools" for server work).
3. Run `git log --oneline -15` and `npm test` to see where yesterday ended.
4. Reply with:
   - the day's tasks as a checklist, marking any already done
   - the exit check, word for word
   - anything left over from the previous day that blocks today
   - which task you would start with and why
5. Then wait. The user will switch to plan mode and ask for the detailed plan.
