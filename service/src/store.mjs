// SQLite store: sessions + messages + external-content FTS5 index.
import Database from 'better-sqlite3';
import { dbPath } from './paths.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS sessions (
  sessionId      TEXT PRIMARY KEY,
  source         TEXT,               -- cli | ide | sandbox | desktop-cowork
  cwd            TEXT,               -- REAL path (from JSONL) -> O3 folder
  project        TEXT,               -- basename(cwd) -> O1 grouping
  gitBranch      TEXT,
  version        TEXT,
  entrypoint     TEXT,
  title          TEXT,
  model          TEXT,
  firstTs        TEXT,
  lastTs         TEXT,
  lastActivityMs INTEGER,            -- file mtime (authoritative; 77% of last lines have no ts)
  msgCount       INTEGER,
  subagentCount  INTEGER,
  fileSize       INTEGER,
  filePath       TEXT,
  parserSchemaVer INTEGER,
  indexedAtMs    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_activity ON sessions(lastActivityMs DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project  ON sessions(project);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY,
  sessionId  TEXT,
  msgIndex   INTEGER,
  role       TEXT,                   -- user | assistant       -> O2 target
  kind       TEXT,                   -- text|tool_use|tool_result|thinking -> O2 target
  ts         TEXT,
  byteOffset INTEGER,                -- reserved for click-to-jump into raw file
  text       TEXT,
  model      TEXT                    -- model that produced this message (assistant only)
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(sessionId, msgIndex);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
  USING fts5(text, content='messages', content_rowid='id', tokenize='unicode61');

-- Persona layer (schema v3). Facts follow the Persome discipline: every fact carries quoted
-- evidence receipts (sessionId+msgIndex), starts as status='forming', and is promoted to 'active'
-- only after being observed in >= 2 independent sessions. Facts are superseded, never deleted.
CREATE TABLE IF NOT EXISTS persona_facts (
  id           INTEGER PRIMARY KEY,
  key          TEXT UNIQUE,          -- normalized kebab slug, the dedup identity
  kind         TEXT,                 -- profile | preference | workflow | interest
  statement    TEXT,
  status       TEXT,                 -- forming | active | superseded
  confidence   REAL,
  observations INTEGER,              -- how many times independently extracted
  sessionsJson TEXT,                 -- JSON array of distinct sessionIds that support it
  evidenceJson TEXT,                 -- JSON array of {sessionId, msgIndex, quote}
  historyJson  TEXT,                 -- JSON array of prior statements (supersession trail)
  firstSeenMs  INTEGER,
  lastSeenMs   INTEGER
);

-- Deterministic correction/interruption signals mined from transcripts (no LLM).
CREATE TABLE IF NOT EXISTS persona_signals (
  id        INTEGER PRIMARY KEY,
  sessionId TEXT,
  msgIndex  INTEGER,
  kind      TEXT,                    -- redirect | interrupt
  excerpt   TEXT,
  ts        TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_session ON persona_signals(sessionId);

-- Per-session extraction bookkeeping (lazy pipeline: which sessions the LLM has distilled).
CREATE TABLE IF NOT EXISTS persona_state (
  sessionId         TEXT PRIMARY KEY,
  extractedAtMs     INTEGER,
  msgCountAtExtract INTEGER,
  factsAdded        INTEGER,
  factsMerged       INTEGER,
  dropped           INTEGER
);

CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES('delete', old.id, old.text);
END;
`;

export const SCHEMA_VERSION = 3;

export function openStore() {
  const db = new Database(dbPath());
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec(SCHEMA);
  // idempotent migration: messages.model (schema v2) on a pre-existing DB
  const cols = db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name);
  if (!cols.includes('model')) db.exec('ALTER TABLE messages ADD COLUMN model TEXT');
  return new Store(db);
}

/**
 * Build a robust FTS5 MATCH expression: prefix-AND of tokens, safe against special chars.
 * Bare alphanumeric tokens get a trailing `*` (prefix match); anything containing FTS5-special
 * characters (- . / @ : etc.) is wrapped as a "quoted phrase" so it is treated literally.
 */
export function ftsQuery(q) {
  const toks = String(q || '').trim().split(/\s+/).filter(Boolean).slice(0, 16);
  if (!toks.length) return null;
  return toks
    .map((t) => {
      const clean = t.replace(/["*]/g, '');
      if (!clean) return null;
      return /^[A-Za-z0-9_]+$/.test(clean) ? `${clean}*` : `"${clean}"`;
    })
    .filter(Boolean)
    .join(' ');
}

class Store {
  constructor(db) {
    this.db = db;
    this._upsertSession = db.prepare(`
      INSERT INTO sessions (sessionId, source, cwd, project, gitBranch, version, entrypoint,
        title, model, firstTs, lastTs, lastActivityMs, msgCount, subagentCount, fileSize,
        filePath, parserSchemaVer, indexedAtMs)
      VALUES (@sessionId,@source,@cwd,@project,@gitBranch,@version,@entrypoint,@title,@model,
        @firstTs,@lastTs,@lastActivityMs,@msgCount,@subagentCount,@fileSize,@filePath,
        @parserSchemaVer,@indexedAtMs)
      ON CONFLICT(sessionId) DO UPDATE SET
        source=@source, cwd=@cwd, project=@project, gitBranch=@gitBranch, version=@version,
        entrypoint=@entrypoint, title=@title, model=@model, firstTs=@firstTs, lastTs=@lastTs,
        lastActivityMs=@lastActivityMs, msgCount=@msgCount, subagentCount=@subagentCount,
        fileSize=@fileSize, filePath=@filePath, parserSchemaVer=@parserSchemaVer,
        indexedAtMs=@indexedAtMs
    `);
    this._delMessages = db.prepare('DELETE FROM messages WHERE sessionId = ?');
    this._insMessage = db.prepare(
      'INSERT INTO messages (sessionId, msgIndex, role, kind, ts, byteOffset, text, model) VALUES (?,?,?,?,?,?,?,?)'
    );
    this._getMeta = db.prepare('SELECT v FROM meta WHERE k = ?');
    this._setMeta = db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v');
    this._getSessionRow = db.prepare('SELECT * FROM sessions WHERE sessionId = ?');
  }

  getIndexedInfo(sessionId) {
    const row = this.db.prepare('SELECT lastActivityMs, fileSize FROM sessions WHERE sessionId = ?').get(sessionId);
    return row || null;
  }

  /** Fuller state for incremental tailing (M5). */
  getIndexedFull(sessionId) {
    return this.db.prepare('SELECT fileSize, lastActivityMs, msgCount FROM sessions WHERE sessionId = ?').get(sessionId) || null;
  }

  /** Append messages to an existing session without deleting prior ones (M5 tail). */
  appendMessages(sessionId, msgs) {
    const tx = this.db.transaction(() => {
      for (const m of msgs) this._insMessage.run(sessionId, m.msgIndex, m.role, m.kind, m.ts, m.byteOffset ?? null, m.text, m.model || null);
    });
    tx();
  }

  /** Patch selected columns of a session row (M5 tail). */
  patchSession(sessionId, patch) {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    const set = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(`UPDATE sessions SET ${set} WHERE sessionId = @sessionId`).run({ ...patch, sessionId });
  }

  /** Replace a session + all its messages atomically. messages = [{msgIndex,role,kind,ts,byteOffset,text}]. */
  writeSession(session, messages) {
    const tx = this.db.transaction(() => {
      this._delMessages.run(session.sessionId);
      this._upsertSession.run(session);
      for (const m of messages) {
        this._insMessage.run(session.sessionId, m.msgIndex, m.role, m.kind, m.ts, m.byteOffset ?? null, m.text, m.model || null);
      }
    });
    tx();
  }

  meta(k, v) {
    if (v === undefined) return this._getMeta.get(k)?.v ?? null;
    this._setMeta.run(k, String(v));
  }

  /** Delete every session (and its messages) whose cwd matches. Returns count removed. */
  deleteByCwd(cwd) {
    const ids = this.db.prepare('SELECT sessionId FROM sessions WHERE cwd = ?').all(cwd).map((r) => r.sessionId);
    const tx = this.db.transaction(() => {
      for (const id of ids) this._delMessages.run(id);
      this.db.prepare('DELETE FROM sessions WHERE cwd = ?').run(cwd);
    });
    tx();
    return ids.length;
  }

  /** Delete every session (and its messages) for a given source. Returns count removed. */
  deleteBySource(source) {
    const ids = this.db.prepare('SELECT sessionId FROM sessions WHERE source = ?').all(source).map((r) => r.sessionId);
    const tx = this.db.transaction(() => {
      for (const id of ids) this._delMessages.run(id);
      this.db.prepare('DELETE FROM sessions WHERE source = ?').run(source);
    });
    tx();
    return ids.length;
  }

  // ---- read side (API) ----

  listSessions({ project, model, from, to, sort = 'recent' } = {}) {
    const where = [];
    const args = {};
    if (project) { where.push('project = @project'); args.project = project; }
    if (model) { where.push('model LIKE @model'); args.model = `%${model}%`; }
    if (from) { where.push('lastActivityMs >= @from'); args.from = from; }
    if (to) { where.push('lastActivityMs <= @to'); args.to = to; }
    const order = sort === 'title' ? 'title COLLATE NOCASE ASC'
      : sort === 'msgs' ? 'msgCount DESC'
      : 'lastActivityMs DESC';
    const sql = `SELECT * FROM sessions ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order}`;
    return this.db.prepare(sql).all(args);
  }

  projectSummary() {
    return this.db.prepare(`
      SELECT project, COUNT(*) AS sessions, SUM(msgCount) AS messages, MAX(lastActivityMs) AS lastActivityMs
      FROM sessions GROUP BY project ORDER BY lastActivityMs DESC
    `).all();
  }

  /** Session row only (no messages) — for cheap lookups like the open-in-claude handoff. */
  getSessionMeta(sessionId) {
    return this._getSessionRow.get(sessionId) || null;
  }

  getSession(sessionId) {
    const s = this._getSessionRow.get(sessionId);
    if (!s) return null;
    const messages = this.db
      .prepare('SELECT msgIndex, role, kind, ts, text, model FROM messages WHERE sessionId = ? ORDER BY msgIndex')
      .all(sessionId);
    return { session: s, messages };
  }

  /** O2 search: scope (global|project|session) x target (role/kind). Returns hits with O3 provenance. */
  search({ q, scope = 'global', scopeId, role, kind, limit = 200 } = {}) {
    const match = ftsQuery(q);
    if (!match) return [];
    const where = ['messages_fts MATCH @match'];
    const args = { match, limit: Math.min(limit, 500) };
    if (scope === 'session' && scopeId) { where.push('m.sessionId = @scopeId'); args.scopeId = scopeId; }
    if (scope === 'project' && scopeId) { where.push('s.project = @scopeId'); args.scopeId = scopeId; }
    if (role) { where.push('m.role = @role'); args.role = role; }
    if (kind) { where.push('m.kind = @kind'); args.kind = kind; }
    const sql = `
      SELECT m.sessionId, m.msgIndex, m.role, m.kind, m.ts,
             s.project, s.cwd, s.title,
             snippet(messages_fts, 0, '', '', '…', 14) AS snippet,
             bm25(messages_fts) AS rank
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      JOIN sessions s ON s.sessionId = m.sessionId
      WHERE ${where.join(' AND ')}
      ORDER BY rank ASC
      LIMIT @limit`;
    return this.db.prepare(sql).all(args);
  }

  stats() {
    const s = this.db.prepare('SELECT COUNT(*) n, SUM(msgCount) msgs, SUM(fileSize) bytes FROM sessions').get();
    const projects = this.db.prepare('SELECT COUNT(DISTINCT project) n FROM sessions').get().n;
    return { sessions: s.n || 0, messages: s.msgs || 0, bytes: s.bytes || 0, projects };
  }

  // ---- persona: facts ----

  getFact(key) { return this.db.prepare('SELECT * FROM persona_facts WHERE key = ?').get(key) || null; }

  listFacts({ status } = {}) {
    const sql = status
      ? 'SELECT * FROM persona_facts WHERE status = ? ORDER BY observations DESC, lastSeenMs DESC'
      : "SELECT * FROM persona_facts WHERE status != 'superseded' ORDER BY status ASC, observations DESC, lastSeenMs DESC";
    return (status ? this.db.prepare(sql).all(status) : this.db.prepare(sql).all());
  }

  insertFact(f) {
    this.db.prepare(`
      INSERT INTO persona_facts (key, kind, statement, status, confidence, observations,
        sessionsJson, evidenceJson, historyJson, firstSeenMs, lastSeenMs)
      VALUES (@key,@kind,@statement,@status,@confidence,@observations,
        @sessionsJson,@evidenceJson,@historyJson,@firstSeenMs,@lastSeenMs)
    `).run(f);
  }

  updateFact(key, patch) {
    const cols = Object.keys(patch);
    if (!cols.length) return;
    const set = cols.map((c) => `${c} = @${c}`).join(', ');
    this.db.prepare(`UPDATE persona_facts SET ${set} WHERE key = @key`).run({ ...patch, key });
  }

  // ---- persona: signals + extraction state ----

  replaceSignals(sessionId, signals) {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM persona_signals WHERE sessionId = ?').run(sessionId);
      const ins = this.db.prepare('INSERT INTO persona_signals (sessionId, msgIndex, kind, excerpt, ts) VALUES (?,?,?,?,?)');
      for (const s of signals) ins.run(sessionId, s.msgIndex, s.kind, s.excerpt, s.ts || null);
    });
    tx();
  }

  signalsForSession(sessionId) {
    return this.db.prepare('SELECT msgIndex, kind, excerpt, ts FROM persona_signals WHERE sessionId = ? ORDER BY msgIndex').all(sessionId);
  }

  signalStats(fromIso, toIso) {
    const where = fromIso ? 'WHERE p.ts >= ? AND p.ts < ?' : '';
    const args = fromIso ? [fromIso, toIso] : [];
    return this.db.prepare(`
      SELECT p.kind, COUNT(*) n FROM persona_signals p ${where} GROUP BY p.kind
    `).all(...args).reduce((acc, r) => { acc[r.kind] = r.n; return acc; }, {});
  }

  getPersonaState(sessionId) { return this.db.prepare('SELECT * FROM persona_state WHERE sessionId = ?').get(sessionId) || null; }

  setPersonaState(s) {
    this.db.prepare(`
      INSERT INTO persona_state (sessionId, extractedAtMs, msgCountAtExtract, factsAdded, factsMerged, dropped)
      VALUES (@sessionId,@extractedAtMs,@msgCountAtExtract,@factsAdded,@factsMerged,@dropped)
      ON CONFLICT(sessionId) DO UPDATE SET extractedAtMs=@extractedAtMs, msgCountAtExtract=@msgCountAtExtract,
        factsAdded=@factsAdded, factsMerged=@factsMerged, dropped=@dropped
    `).run(s);
  }

  /** Sessions worth distilling that the LLM hasn't seen yet: enough real human input, newest first. */
  extractionCandidates({ limit = 10, minUserMsgs = 3 } = {}) {
    return this.db.prepare(`
      SELECT s.sessionId, s.title, s.project, s.lastActivityMs, s.msgCount,
             (SELECT COUNT(*) FROM messages m WHERE m.sessionId = s.sessionId AND m.role='user' AND m.kind='text') AS userMsgs
      FROM sessions s
      LEFT JOIN persona_state ps ON ps.sessionId = s.sessionId
      WHERE ps.sessionId IS NULL
      GROUP BY s.sessionId
      HAVING userMsgs >= ?
      ORDER BY s.lastActivityMs DESC
      LIMIT ?
    `).all(minUserMsgs, limit);
  }

  personaStatus() {
    const extracted = this.db.prepare('SELECT COUNT(*) n FROM persona_state').get().n;
    const facts = this.db.prepare("SELECT status, COUNT(*) n FROM persona_facts GROUP BY status").all()
      .reduce((a, r) => { a[r.status] = r.n; return a; }, {});
    const signals = this.db.prepare('SELECT COUNT(*) n FROM persona_signals').get().n;
    return { extracted, facts, signals };
  }

  // ---- portrait: everything the visualization layer needs, in one call ----

  vizData({ days = 182 } = {}) {
    const to = new Date();
    const from = new Date(Date.now() - days * 86_400_000);
    const fromIso = from.toISOString(), toIso = to.toISOString();

    // daily heatmap: your prompts + sessions + dominant project per day
    const daily = this.db.prepare(`
      SELECT substr(m.ts,1,10) AS day,
             SUM(m.role='user') AS prompts,
             COUNT(DISTINCT m.sessionId) AS sessions
      FROM messages m WHERE m.ts >= ? AND m.ts < ? AND m.role IN ('user','assistant')
      GROUP BY day ORDER BY day
    `).all(fromIso, toIso);
    const topPerDay = this.db.prepare(`
      SELECT day, project FROM (
        SELECT substr(m.ts,1,10) AS day, s.project AS project, SUM(m.role='user') AS n,
               ROW_NUMBER() OVER (PARTITION BY substr(m.ts,1,10) ORDER BY SUM(m.role='user') DESC) AS rn
        FROM messages m JOIN sessions s ON s.sessionId = m.sessionId
        WHERE m.ts >= ? AND m.ts < ? GROUP BY day, project
      ) WHERE rn = 1
    `).all(fromIso, toIso).reduce((a, r) => { a[r.day] = r.project; return a; }, {});
    for (const d of daily) d.topProject = topPerDay[d.day] || '';

    // hour-of-day histogram (UTC buckets; server = user's machine, caller rotates to local)
    const hoursUtc = new Array(24).fill(0);
    for (const r of this.db.prepare(`
      SELECT strftime('%H', m.ts) AS h, COUNT(*) n FROM messages m
      WHERE m.ts >= ? AND m.role = 'user' GROUP BY h
    `).all(fromIso)) hoursUtc[Number(r.h)] += r.n;

    // weekly attention series for the top projects (stacked river)
    const weekly = this.db.prepare(`
      SELECT strftime('%Y-%m-%d', date(substr(m.ts,1,10), '-' || strftime('%w', substr(m.ts,1,10)) || ' days')) AS week,
             s.project AS project, SUM(m.role='user') AS prompts
      FROM messages m JOIN sessions s ON s.sessionId = m.sessionId
      WHERE m.ts >= ? AND m.ts < ? GROUP BY week, project
    `).all(fromIso, toIso);

    // model mix + firsts + lifetime totals
    const models = this.db.prepare(`
      SELECT model, COUNT(*) n FROM messages WHERE role='assistant' AND model != '' AND model IS NOT NULL
      GROUP BY model ORDER BY n DESC LIMIT 8
    `).all();
    const first = this.db.prepare(`
      SELECT sessionId, title, project, firstTs FROM sessions
      WHERE firstTs != '' ORDER BY firstTs ASC LIMIT 1
    `).get() || null;
    const lifetime = this.db.prepare(`
      SELECT COUNT(*) AS sessions, SUM(msgCount) AS messages, SUM(subagentCount) AS subagents, SUM(fileSize) AS bytes,
             COUNT(DISTINCT project) AS projects
      FROM sessions
    `).get();
    const lifetimePrompts = this.db.prepare("SELECT COUNT(*) n FROM messages WHERE role='user'").get().n;
    const activeDays = this.db.prepare(
      "SELECT COUNT(DISTINCT substr(ts,1,10)) n FROM messages WHERE role='user' AND ts IS NOT NULL"
    ).get().n;

    return { days, from: fromIso, to: toIso, daily, hoursUtc, weekly, models, first, lifetime: { ...lifetime, prompts: lifetimePrompts, activeDays } };
  }

  // ---- retro: time-window activity rollup (deterministic, no LLM) ----

  retro({ fromIso, toIso }) {
    const days = this.db.prepare(`
      SELECT substr(m.ts, 1, 10) AS day, s.project AS project,
             COUNT(DISTINCT m.sessionId) AS sessions,
             SUM(m.role = 'user') AS userMsgs,
             COUNT(*) AS msgs
      FROM messages m JOIN sessions s ON s.sessionId = m.sessionId
      WHERE m.ts >= ? AND m.ts < ? AND m.role IN ('user','assistant')
      GROUP BY day, project
      ORDER BY day DESC, msgs DESC
    `).all(fromIso, toIso);
    const topSessions = this.db.prepare(`
      SELECT m.sessionId, s.title, s.project, s.lastActivityMs, s.msgCount,
             SUM(m.role = 'user') AS userMsgs, MIN(m.ts) AS firstTs, MAX(m.ts) AS lastTs
      FROM messages m JOIN sessions s ON s.sessionId = m.sessionId
      WHERE m.ts >= ? AND m.ts < ? AND m.role IN ('user','assistant')
      GROUP BY m.sessionId
      ORDER BY userMsgs DESC
      LIMIT 15
    `).all(fromIso, toIso);
    const totals = this.db.prepare(`
      SELECT COUNT(DISTINCT m.sessionId) AS sessions, COUNT(DISTINCT s.project) AS projects,
             SUM(m.role = 'user') AS userMsgs, COUNT(*) AS msgs
      FROM messages m JOIN sessions s ON s.sessionId = m.sessionId
      WHERE m.ts >= ? AND m.ts < ? AND m.role IN ('user','assistant')
    `).get(fromIso, toIso);
    const signals = this.db.prepare(`
      SELECT p.kind, COUNT(*) n FROM persona_signals p
      WHERE p.ts >= ? AND p.ts < ? GROUP BY p.kind
    `).all(fromIso, toIso).reduce((a, r) => { a[r.kind] = r.n; return a; }, {});
    const topSignals = this.db.prepare(`
      SELECT p.sessionId, p.msgIndex, p.kind, p.excerpt, p.ts, s.title, s.project
      FROM persona_signals p JOIN sessions s ON s.sessionId = p.sessionId
      WHERE p.ts >= ? AND p.ts < ?
      ORDER BY p.ts DESC LIMIT 20
    `).all(fromIso, toIso);
    return { from: fromIso, to: toIso, totals, days, topSessions, signals, topSignals };
  }

  close() { this.db.close(); }
}
