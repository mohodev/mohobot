# Immersion and Disclosure Rules

## Discord Presence

Presence is an optional public projection of the simulated world state, not evidence of a real human device or real-world location.

| Internal condition | Public Discord projection |
|---|---|
| offline/away | invisible, `暂时离开` |
| high stress | dnd, `专注于一件事` |
| resting/low energy | idle, `稍后再看消息` |
| normal | online, coarse activity text |

The projection is disabled by default and updates at least every 60 seconds. It must never publish affinity, memory, diary, exact battery/network state, private conversation, tool activity, or operational status.

## Private State

Affinity, impressions, relationship notes, profile signals and diaries are **not chat-queryable**. They are visible only in the authenticated WebUI. The administrator persona may provide a deliberately coarse summary to an allowlisted administrator, but never raw score, private note, source message or another user's profile.

## Character Peer Consultation

One character may ask another character only through an internal private channel when all conditions hold:

- both characters have affinity >= 70 for the relevant relation;
- the queried fact is explicitly tagged `shared`;
- the target character has opted in;
- a private internal channel is used.

Private transcripts, diary entries, raw impressions, relationship scores, user profiles and DM facts are never eligible. The caller receives an abstract answer, not source material.

## Output and Delays

ReplyPlan is the only model-to-Discord output contract. The sender chooses quoting, chunks, typing and delivery timing within Discord limits. The model may request `ignore` or bounded segments, but cannot reveal hidden planning, invoke commands, or bypass mention suppression.
