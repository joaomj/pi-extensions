---
"@joaomj/pi-claude-usage": patch
---

Load the usage implementation only for Claude sessions, show the footer only while the session uses Claude, defer the first refresh past startup, and skip startup work when the cached value is fresh.
