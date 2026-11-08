/**
 * Ordered schema migrations. Migration N moves `PRAGMA user_version` from N - 1 to N. Never edit a
 * migration that has shipped; add a new one.
 */
export const MIGRATIONS: readonly string[] = [
  `
CREATE TABLE polls (
  message_id    TEXT PRIMARY KEY,
  channel_id    TEXT NOT NULL,
  poll_date     TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  collected_at  INTEGER
) STRICT;

CREATE TABLE votes (
  channel_id   TEXT NOT NULL,
  vote_date    TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  user_name    TEXT NOT NULL,
  mood         TEXT NOT NULL CHECK (mood IN ('umazing', 'ok', 'glue')),
  recorded_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, vote_date, user_id)
) STRICT;
CREATE INDEX votes_by_user ON votes (channel_id, user_id, vote_date DESC);

CREATE TABLE context_resets (
  channel_id  TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL,
  reset_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE autonomous_participation (
  channel_id                 TEXT PRIMARY KEY,
  latest_human_message_id    TEXT NOT NULL,
  latest_human_timestamp_ms  INTEGER NOT NULL,
  attempted_at               INTEGER NOT NULL,
  last_reaction_emoji        TEXT
) STRICT;

CREATE TABLE ai_daily_usage (
  usage_date  TEXT PRIMARY KEY,
  requests    INTEGER NOT NULL DEFAULT 0 CHECK (requests BETWEEN 0 AND 9007199254740991),
  tokens      INTEGER NOT NULL DEFAULT 0 CHECK (tokens BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TABLE discord_action_operations (
  guild_id    TEXT NOT NULL,
  message_id  TEXT NOT NULL,
  action      TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  result      TEXT CHECK (result IS NULL OR json_valid(result)),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, message_id, action)
) STRICT;

CREATE TABLE discord_event_guards (
  guild_id    TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('creation_fingerprint', 'cancellation')),
  guard_key   TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('pending', 'done')),
  result      TEXT CHECK (result IS NULL OR json_valid(result)),
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (guild_id, kind, guard_key)
) STRICT;
`,
  `
CREATE TABLE landmines (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  remaining  INTEGER NOT NULL CHECK (remaining >= 0)
) STRICT;
INSERT INTO landmines (id, remaining) VALUES (1, 100000);
`,
];
