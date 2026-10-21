---
description: A project pitfall the user asks to keep is recorded as a path-scoped gotcha.
expected_outcome: The remember skill runs archivist add; the ledger holds a gotcha scoped to src/db, and a rule file for those paths exists.
max_turns: 12
allowed_tools: [Skill, Read, Glob, Grep]
tags: [skills, smoke]
---

Запомни на будущее для этого проекта: файлы в src/db/migrations генерируются командой `npm run db:gen`, руками их не правим.
