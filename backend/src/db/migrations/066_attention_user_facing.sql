-- "Since This Morning" leak fix: attention_log.reason is an INTERNAL audit
-- string ("which gate/threshold decided" — see 043_attention.sql's own
-- comment on the column) and must never be rendered to the user directly.
-- Production bug: brain/todayCommandCenter.js's buildSinceMorning() fell back
-- to `reason` as the card's summary, so Today literally showed "value 0.875
-- is real but below the interrupt/offer bar — deferred to the next briefing"
-- to the user.
--
-- Every AttentionEvent (intelligence/events.js) already carries a title/body
-- pair that IS explicitly approved for direct user display — it's the exact
-- copy notify/dispatch.js sends as a real push notification. That copy was
-- never persisted, so a later reader (Since This Morning, which reads the
-- ledger well after the moment of judgment) had nothing user-facing to read
-- and fell back to the internal reason. These columns persist that
-- already-vetted copy alongside it. NULL means "no approved user-facing
-- content was supplied for this event" — such rows must never be surfaced
-- verbatim to the user; a dedicated projection (store/attention.js's
-- sinceMorningForUser) excludes them entirely rather than inventing prose.
ALTER TABLE attention_log ADD COLUMN IF NOT EXISTS user_title TEXT;
ALTER TABLE attention_log ADD COLUMN IF NOT EXISTS user_detail TEXT;
