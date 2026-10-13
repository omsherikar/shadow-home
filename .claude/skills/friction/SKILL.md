---
name: friction
description: Log a friction entry for the hackathon submission's friction log
argument-hint: [what happened]
disable-model-invocation: true
---
Append a new entry to docs/friction-log.md for: $ARGUMENTS

Use the same format as the existing entries. Fill every field:

- Date and time (IST)
- Tool and version (exact package version or console/page name)
- Task attempted
- Steps taken (numbered, concrete: commands, pages, settings)
- Expected
- Actual (quote the error message if there was one)
- Severity: critical (blocked), major (cost over an hour or forced a redesign), minor (annoying)
- Workaround used
- Suggestion for the Amazon team (one actionable sentence)

Take what you can from this session's history. Ask me for any field you can't fill.
Keep it factual and specific: names, versions, error text. No adjectives like "confusing"
without saying what exactly was confusing.
