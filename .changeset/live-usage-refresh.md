---
"@joaomj/pi-claude-usage": minor
---

Keep the usage footer current during a session: refresh at run start, every turn boundary, and run end (at most one request per minute), re-render the reset countdown every 15 seconds, and request again once a window's reset time passes instead of waiting for the five-minute cache to expire. The footer also shows the 5-hour window's reset countdown next to its percentage.
