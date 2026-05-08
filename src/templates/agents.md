<!-- openwolf-start -->
## OpenWolf Memory

This project uses OpenWolf for persistent AI memory. Read these files at the start of every session:

- `.wolf/cerebrum.md` — architectural decisions, patterns, hard-won learnings. **Read this first.**
- `.wolf/memory.md` — rolling session log; check the last 20 lines for open threads.
- `.wolf/anatomy.md` — auto-generated file index; check here before reading any project file.
- `.wolf/buglog.json` — known bugs; check for open entries relevant to your task.

### Session Protocol

**Start of session:**
1. Read `.wolf/cerebrum.md` fully.
2. Read the last 20 lines of `.wolf/memory.md`.
3. Check `.wolf/buglog.json` for OPEN bugs relevant to your task.
4. Check `.wolf/anatomy.md` before opening any file — if the description is sufficient, skip the full read.

**End of session:**
1. Append a session entry to `.wolf/memory.md` (what you did, what's open).
2. Update `.wolf/cerebrum.md` if you made any architectural decisions or discovered new conventions.
3. Update `.wolf/buglog.json` if you fixed or discovered bugs.

**During session:**
- Never re-read a file already read this session.
- When you receive a correction, update `.wolf/cerebrum.md` immediately.
- Low threshold for logging to cerebrum — when in doubt, add it.

Do not modify `.wolf/` files mid-task unless explicitly asked.
<!-- openwolf-end -->
