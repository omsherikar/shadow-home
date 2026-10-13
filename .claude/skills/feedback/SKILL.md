---
name: feedback
description: Draft the hackathon product-feedback answer for one tool, API or SDK from the friction log and git history
argument-hint: [tool name]
disable-model-invocation: true
---
Draft product feedback for: $ARGUMENTS

Sources, in this order: docs/friction-log.md entries for this tool, `git log` messages
that mention it, and the code that uses it (grep for its package name).

Write these five parts, each 2–4 sentences, specific and factual:

1. What we used it for (name the files or features)
2. What worked well (concrete: "createMcpHandler served 2025-03-26 and 2026-07-28 clients unchanged")
3. What needs work (cite friction-log entries by date; quote error messages)
4. Onboarding: time and steps from zero to a working hello world
5. Would we build with it again, and why

If this is an AWS service, also say which service, what it does in our architecture,
and the file that calls it (the hackathon asks for this in the feedback answer).

Save the draft to docs/feedback/<tool-slug>.md and mark it DRAFT at the top.
The user rewrites it in their own words before submitting.
