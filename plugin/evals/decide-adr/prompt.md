---
description: A decision with its reason becomes an ADR.
expected_outcome: The decide skill records a decision with a rationale; an ADR file appears under .archivist/decisions.
max_turns: 12
allowed_tools: [Skill, Read, Glob, Grep]
tags: [skills, smoke]
---

Мы решили отдавать CSV-экспорт потоком, а не собирать файл в памяти: выгрузки бывают больше 1 ГБ, буферизацию отвергли из-за памяти. Зафиксируй это решение.
