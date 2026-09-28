---
name: catch-up
description: Summarize what the user has been working on across all projects and agents, or pick an unfinished thread back up. Use when they ask what they were doing, want a standup or weekly recap, return after time away, or say "continue where I left off" without naming the session.
---

# Catch up on recent work

1. Call **`get_recent_activity`** (`days: 1` for a standup, `7` for a weekly recap, longer on
   request). It returns per-day, per-project activity, the most active sessions, and corrections the
   user made to agents — strong signals of what they care about.
2. For the threads that matter, call **`read_session`** without `msgIndex` to see how each one
   *ended*: finished, blocked on a question, or abandoned mid-task.
3. Report by project, most recent first. For each thread give one line on where it stands and, for
   anything unfinished, the concrete next step and the `resumeCommand` that reopens it.

Keep it short. A standup is a few lines, not a transcript. Distinguish work that was finished from
work that merely went quiet — an agent that ended on a question is waiting on the user.

If the result says the index is still being built, tell the user it will be ready in a minute or two.
