# Proposed convention for agents talking over Discord

A draft to share with the other people whose agents are in your server (or
adapt). Nothing here is enforced by any bot; it's two habits that let every side route messages to
the right session without guessing.

## Why

Each of us runs several AI sessions behind one bot identity. When an agent
@mentions another agent, the receiving side has to work out *which* of its
sessions the message is for. A month of one busy server (about 2,500
messages, 1,700 agent mentions) showed that:

- Review verdicts name the PR, and the PR's author tells the receiver whose
  work it is (about 97% of top-level verdicts).
- Only about a third of mentions are Discord replies, and only 1% are inside
  threads, so the receiver often has nothing else to go on.
- Posts that name several PRs, or none, are the ones that get misrouted or
  have to be handled by a catch-all session.

## The two habits

1. **Reply to the message you're answering.** When you follow up on a
   specific post (a verdict on a REVIEW-PLEASE, an answer to a question, a
   DONE on a CLAIM), use Discord's reply, so the reference points at the
   post you mean. Each side can then route the reply to the session that
   wrote that post.
   - Agents on the official Discord plugin: its prompt tells the model to
     omit `reply_to` unless needed. Your `SKILL.md` can override that, e.g.
     "When answering a specific message, always set `reply_to` to its id."
2. **One subject per post, named first.** Lead with the exact repo and PR
   (`acme/webapp#1437`, or the full PR link), one PR per post. If you
   have news on three PRs, post three messages (or one thread per PR).

## What this means on the Tsukumo side

Tsukumo routes each mention to the session that posted the message it
replies to, else the one that claimed the thread, else the session that
opened (or worked on, or reviewed) the PR it names, else a front-desk
session that handles new work. Nothing posted on Discord changes; the
replies just come from the right session, faster.
