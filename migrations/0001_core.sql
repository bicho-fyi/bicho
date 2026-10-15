CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  public_key TEXT NOT NULL UNIQUE,
  secret_hash TEXT,
  hourly_limit INTEGER NOT NULL DEFAULT 1000 CHECK (hourly_limit BETWEEN 1 AND 1000000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE issues (
  project_id TEXT NOT NULL REFERENCES projects(id),
  id TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved', 'resolved', 'ignored', 'muted')),
  event_count INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE events (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  received_at TEXT NOT NULL,
  level TEXT NOT NULL,
  environment TEXT,
  release TEXT,
  payload_key TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'Error',
  enrichment_status TEXT NOT NULL DEFAULT 'not_applicable' CHECK (enrichment_status IN ('not_applicable', 'pending', 'succeeded', 'failed')),
  enrichment_key TEXT,
  enrichment_error TEXT,
  enrichment_checked_at TEXT,
  enrichment_cursor INTEGER NOT NULL DEFAULT 0,
  enrichment_revision INTEGER NOT NULL DEFAULT 0,
  enrichment_attempts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, id),
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id)
);

CREATE INDEX issues_recent ON issues(project_id, status, last_seen DESC, id);
CREATE INDEX events_issue ON events(project_id, issue_id, received_at DESC, id);
CREATE INDEX events_filters ON events(project_id, environment, release, level);
CREATE INDEX events_received ON events(project_id, received_at DESC, id);
CREATE INDEX events_time ON events(project_id, rtrim(timestamp, 'Z'));
CREATE INDEX events_processing ON events(enrichment_status, enrichment_checked_at, received_at);

CREATE TABLE event_tags (
  project_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (project_id, event_id, key),
  FOREIGN KEY (project_id, event_id) REFERENCES events(project_id, id)
);
CREATE INDEX tags_lookup ON event_tags(project_id, key, value, event_id);

CREATE TABLE issue_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'admin',
  FOREIGN KEY (project_id, issue_id) REFERENCES issues(project_id, id)
);
CREATE INDEX history_issue ON issue_history(project_id, issue_id, id DESC);

CREATE TRIGGER record_status AFTER UPDATE OF status ON issues WHEN OLD.status <> NEW.status BEGIN
  INSERT INTO issue_history (project_id, issue_id, from_status, to_status, changed_at)
  VALUES (NEW.project_id, NEW.id, OLD.status, NEW.status, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;

CREATE TRIGGER enforce_ingest_quota BEFORE INSERT ON events
WHEN NOT EXISTS (SELECT 1 FROM events WHERE project_id = NEW.project_id AND id = NEW.id) BEGIN
  SELECT RAISE(ABORT, 'ingest_quota_exceeded') WHERE
    (SELECT count(*) FROM events WHERE project_id = NEW.project_id
      AND received_at >= substr(NEW.received_at, 1, 13) || ':00:00.000Z'
      AND received_at < strftime('%Y-%m-%dT%H:00:00.000Z', NEW.received_at, '+1 hour'))
    >= (SELECT hourly_limit FROM projects WHERE id = NEW.project_id);
END;

CREATE TABLE source_maps (
  project_id TEXT NOT NULL REFERENCES projects(id),
  debug_id TEXT NOT NULL,
  payload_key TEXT NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, debug_id)
);

CREATE TABLE processing_state (
  name TEXT PRIMARY KEY,
  run_id TEXT,
  last_started_at TEXT,
  last_finished_at TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE UNIQUE INDEX source_maps_debug ON source_maps(project_id, lower(debug_id));

CREATE TRIGGER wake_pending_maps AFTER INSERT ON source_maps BEGIN
  UPDATE events SET enrichment_checked_at=CASE WHEN enrichment_status='pending' THEN NULL ELSE enrichment_checked_at END,
    enrichment_cursor=0,enrichment_revision=enrichment_revision+1
  WHERE project_id=NEW.project_id AND (enrichment_status='pending'
    OR (enrichment_status='failed' AND enrichment_error='Source map enrichment failed' AND enrichment_attempts < 3));
END;

CREATE TRIGGER count_event AFTER INSERT ON events BEGIN
  UPDATE issues SET
    event_count = event_count + 1,
    first_seen = min(first_seen, NEW.timestamp),
    last_seen = max(last_seen, NEW.timestamp)
  WHERE project_id = NEW.project_id AND id = NEW.issue_id;
END;
