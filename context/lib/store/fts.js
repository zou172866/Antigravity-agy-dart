import { createHash } from "node:crypto";
import {
  MAX_CHUNK_BYTES,
  RRF_K,
  SNIPPET_MAX_BYTES,
  sanitizeFtsQuery,
  sanitizeTrigramQuery,
  truncateUtf8Bytes
} from "./schema.js";

export class FtsMethods {
  /** Safely split an oversized single line into <= maxBytes UTF-8 slices */
  _splitOversizedLine(line, maxBytes) {
    const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : 1;
    const parts = [];
    let buf = Buffer.from(line, "utf8");
    while (buf.length > limit) {
      let cut = limit;
      // Back up if we landed on a UTF-8 continuation byte (10xxxxxx)
      while (cut > 0 && (buf[cut] & 0xc0) === 0x80) {
        cut -= 1;
      }
      if (cut === 0) cut = Math.min(buf.length, limit);
      parts.push(buf.subarray(0, cut).toString("utf8"));
      buf = buf.subarray(cut);
    }
    if (buf.length > 0) parts.push(buf.toString("utf8"));
    return parts;
  }

  /** Detect whether text/label should use heading-aware Markdown chunking */
  _isMarkdownContent(text, label = "") {
    if (/\.(?:md|mdx|markdown|mdown|mkd)$/i.test(String(label || "").trim())) {
      return true;
    }
    if (!text || typeof text !== "string") return false;
    const matches = text.match(/^#{1,6}\s+\S/gm);
    return Boolean(matches && matches.length >= 2);
  }

  /**
   * Heading-aware Markdown chunker (inspired by tobi/qmd MIT patterns):
   * preserves fenced code blocks, tracks heading breadcrumb stacks, and
   * breaks cleanly at heading/paragraph boundaries before byte budget limits.
   */
  chunkContentDetailed(text, maxBytes = MAX_CHUNK_BYTES, { label = "", isMarkdown = null } = {}) {
    if (!text) return [];
    const normalized = String(text).replace(/\r\n/g, "\n");
    const useMarkdown = isMarkdown !== null ? Boolean(isMarkdown) : this._isMarkdownContent(normalized, label);
    const lines = normalized.split("\n");

    if (!useMarkdown) {
      const results = [];
      let currentLines = [];
      let currentBytes = 0;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;

        if (lineBytes > maxBytes) {
          if (currentLines.length > 0) {
            results.push({ body: currentLines.join("\n"), title: label || "untitled" });
            currentLines = [];
            currentBytes = 0;
          }
          for (const slice of this._splitOversizedLine(line, maxBytes)) {
            results.push({ body: slice, title: label || "untitled" });
          }
          continue;
        }

        if (currentBytes + lineBytes > maxBytes && currentLines.length > 0) {
          results.push({ body: currentLines.join("\n"), title: label || "untitled" });
          currentLines = [line];
          currentBytes = lineBytes;
        } else {
          currentLines.push(line);
          currentBytes += lineBytes;
        }
      }
      if (currentLines.length > 0) {
        results.push({ body: currentLines.join("\n"), title: label || "untitled" });
      }
      return results;
    }

    // Markdown heading-aware + fenced-code-aware chunking
    const chunks = [];
    const headingStack = []; // [{ level, text }]
    let currentLines = [];
    let currentLineInFence = [];
    let currentBytes = 0;
    let currentHeadingPath = "";
    let inFence = false;
    let fenceChar = "";
    let fenceLen = 0;

    const formatTitle = (hPath) => {
      if (label && hPath) return `${label} :: ${hPath}`;
      return hPath || label || "untitled";
    };

    const flush = () => {
      if (currentLines.length === 0) return;
      const body = currentLines.join("\n").trimEnd();
      if (body.length > 0) {
        chunks.push({ body, title: formatTitle(currentHeadingPath) });
      }
      currentLines = [];
      currentLineInFence = [];
      currentBytes = 0;
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fenceMatch = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(line);
      if (fenceMatch) {
        const marker = fenceMatch[2];
        const rest = fenceMatch[3] || "";
        if (!inFence) {
          // CommonMark: backtick fence info string cannot contain backticks (prevents ```inline``` poisoning)
          if (marker[0] === "~" || !rest.includes("`")) {
            inFence = true;
            fenceChar = marker[0];
            fenceLen = marker.length;
          }
        } else if (marker[0] === fenceChar && marker.length >= fenceLen && rest.trim() === "") {
          inFence = false;
          fenceChar = "";
          fenceLen = 0;
        }
      }

      if (!inFence) {
        const headingMatch = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
        if (headingMatch) {
          const level = headingMatch[1].length;
          const headingText = headingMatch[2].trim();
          const prevLevel = headingStack.length > 0 ? headingStack[headingStack.length - 1].level : 0;
          const isSiblingOrAscent = prevLevel > 0 && level <= prevLevel;

          // Flush before sibling/higher-level headings (preserves distinct section titles even for short sections),
          // or before child headings once current intro chunk has meaningful content.
          if (
            currentLines.length > 0 &&
            (isSiblingOrAscent || currentBytes >= Math.min(512, Math.floor(maxBytes * 0.2)))
          ) {
            flush();
          }

          while (headingStack.length > 0 && headingStack[headingStack.length - 1].level >= level) {
            headingStack.pop();
          }
          headingStack.push({ level, text: headingText });
          currentHeadingPath = headingStack.map((h) => h.text).join(" > ");
        }
      }

      const lineBytes = Buffer.byteLength(line, "utf8") + 1;

      if (lineBytes > maxBytes) {
        flush();
        for (const slice of this._splitOversizedLine(line, maxBytes)) {
          chunks.push({ body: slice, title: formatTitle(currentHeadingPath) });
        }
        continue;
      }

      if (currentBytes + lineBytes > maxBytes && currentLines.length > 0) {
        // Try to break on a blank line strictly OUTSIDE any fenced code block
        let splitIdx = -1;
        if (!inFence) {
          for (let k = currentLines.length - 1; k >= Math.floor(currentLines.length * 0.5); k--) {
            if (!currentLineInFence[k] && currentLines[k].trim() === "") {
              splitIdx = k;
              break;
            }
          }
        }
        if (splitIdx > 0) {
          const headPart = currentLines.slice(0, splitIdx);
          const tailPart = currentLines.slice(splitIdx + 1);
          const tailFence = currentLineInFence.slice(splitIdx + 1);
          const body = headPart.join("\n").trimEnd();
          if (body.length > 0) {
            chunks.push({ body, title: formatTitle(currentHeadingPath) });
          }
          const tailPlusLine = [...tailPart, line];
          const tailPlusBytes = Buffer.byteLength(tailPlusLine.join("\n"), "utf8") + 1;
          if (tailPlusBytes <= maxBytes) {
            currentLines = tailPlusLine;
            currentLineInFence = [...tailFence, inFence];
            currentBytes = tailPlusBytes;
          } else {
            const tailBody = tailPart.join("\n").trimEnd();
            if (tailBody.length > 0) {
              chunks.push({ body: tailBody, title: formatTitle(currentHeadingPath) });
            }
            currentHeadingPath = headingStack.map((h) => h.text).join(" > ");
            currentLines = [line];
            currentLineInFence = [inFence];
            currentBytes = lineBytes;
          }
        } else {
          flush();
          currentHeadingPath = headingStack.map((h) => h.text).join(" > ");
          currentLines = [line];
          currentLineInFence = [inFence];
          currentBytes = lineBytes;
        }
      } else {
        if (currentLines.length === 0) {
          currentHeadingPath = headingStack.map((h) => h.text).join(" > ");
        }
        currentLines.push(line);
        currentLineInFence.push(inFence);
        currentBytes += lineBytes;
      }
    }

    flush();
    return chunks;
  }

  /** Split content into chunks by byte budget (heading-aware for Markdown) */
  chunkContent(text, maxBytes = MAX_CHUNK_BYTES, options = {}) {
    return this.chunkContentDetailed(text, maxBytes, options).map((c) => c.body);
  }

  /** Index a text, file output, or tool response into SQLite FTS5 */
  indexContent({ sessionId, worktree, agent, kind, label, content, sourceId, isMarkdown = null, dedup = false }) {
    this.open();
    const sid = sessionId || "default";
    const wt = worktree || process.cwd();
    const ag = agent || "antigravity";
    const k = kind || "content";
    const lbl = label || "untitled";
    const rawText = typeof content === "string" ? content : String(content || "");
    const totalBytes = Buffer.byteLength(rawText, "utf8");
    const contentHash = createHash("sha256").update(rawText, "utf8").digest("hex");
    const now = Date.now();

    if (dedup === true && !sourceId && totalBytes > 0) {
      const existing = this.db
        .prepare(`
          SELECT id, label, bytes_total, chunk_count
          FROM sources
          WHERE session_id = ? AND worktree = ? AND content_hash = ?
          ORDER BY accessed_ts DESC
          LIMIT 1
        `)
        .get(sid, wt, contentHash);
      if (existing) {
        this._withBusyRetry(() => {
          this.db.prepare("UPDATE sources SET accessed_ts = ? WHERE id = ?").run(now, existing.id);
        });
        return {
          sourceId: existing.id,
          bytesTotal: existing.bytes_total,
          chunkCount: existing.chunk_count,
          label: existing.label,
          contentHash,
          deduplicated: true
        };
      }
    }

    const id = sourceId || `s_${now}_${(++this.sourceCounter).toString(36)}`;
    const isoDate = new Date(now).toISOString();

    const detailedChunks = this.chunkContentDetailed(rawText, MAX_CHUNK_BYTES, { label: lbl, isMarkdown });
    const chunkCount = detailedChunks.length;

    const deleteOldChunks = this.db.prepare("DELETE FROM chunks WHERE source_id = ?");
    const deleteOldChunksTri = this.db.prepare("DELETE FROM chunks_tri WHERE source_id = ?");
    const insertSource = this.db.prepare(`
      INSERT OR REPLACE INTO sources (
        id, session_id, worktree, agent, kind, label, bytes_total, chunk_count, created_ts, created_at, accessed_ts, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (source_id, session_id, worktree, agent, ord, body, title)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insertChunkTri = this.db.prepare(`
      INSERT INTO chunks_tri (source_id, session_id, ord, body)
      VALUES (?, ?, ?, ?)
    `);

    this._withWriteTx(() => {
      if (sourceId) {
        deleteOldChunks.run(id);
        deleteOldChunksTri.run(id);
      }
      insertSource.run(id, sid, wt, ag, k, lbl, totalBytes, chunkCount, now, isoDate, now, contentHash);

      for (let ord = 0; ord < chunkCount; ord++) {
        const ch = detailedChunks[ord];
        insertChunk.run(id, sid, wt, ag, ord, ch.body, ch.title || lbl);
        insertChunkTri.run(id, sid, ord, ch.body);
      }
    });

    this.pruneStaleSources();

    return {
      sourceId: id,
      bytesTotal: totalBytes,
      chunkCount,
      label: lbl,
      contentHash,
      deduplicated: false,
      chunks: detailedChunks.map((c) => c.body),
      chunkTitles: detailedChunks.map((c) => c.title)
    };
  }

  /** Search indexed chunks using BM25 + Trigram Reciprocal Rank Fusion */
  search({ queries, sourceId, sessionId, worktree, scope = "session", limit = 5, offset = 0 }) {
    this.open();
    const queryList = Array.isArray(queries) ? queries : [queries];
    const maxHits = Math.min(Math.max(1, limit || 5), 20);
    const skipHits = Math.max(0, offset || 0);

    const scores = new Map();

    for (const q of queryList) {
      if (!q || typeof q !== "string") continue;
      const porterQ = sanitizeFtsQuery(q);
      const trigramQ = sanitizeTrigramQuery(q);

      // 1. Porter FTS5 with BM25 ranking
      if (porterQ) {
        let sql = `
          SELECT rowid, source_id, ord, body, title, session_id, worktree, bm25(chunks) AS rank
          FROM chunks
          WHERE chunks MATCH ?
        `;
        const params = [porterQ];

        if (sourceId) {
          sql += " AND source_id = ?";
          params.push(sourceId);
        }
        if (scope === "session" && sessionId) {
          sql += " AND session_id = ?";
          params.push(sessionId);
        } else if (scope === "worktree" && worktree) {
          sql += " AND worktree = ?";
          params.push(worktree);
        }

        sql += " ORDER BY rank LIMIT 30";

        try {
          const rows = this.db.prepare(sql).all(...params);
          rows.forEach((row, rankIdx) => {
            const key = `${row.source_id}:${row.ord}`;
            const rrf = 1.0 / (RRF_K + rankIdx + 1);
            const existing = scores.get(key);
            if (existing) {
              existing.rrfScore += rrf;
              existing.matches.push({ query: q, type: "porter", rank: rankIdx + 1 });
            } else {
              scores.set(key, {
                rowid: row.rowid,
                sourceId: row.source_id,
                ord: row.ord,
                body: row.body,
                title: row.title,
                sessionId: row.session_id,
                worktree: row.worktree,
                rrfScore: rrf,
                matches: [{ query: q, type: "porter", rank: rankIdx + 1 }]
              });
            }
          });
        } catch {
          // Porter match error ignored
        }
      }

      // 2. Trigram FTS5
      if (trigramQ) {
        let sqlTri = `
          SELECT t.rowid, t.source_id, t.ord, t.body, t.session_id, s.worktree
          FROM chunks_tri t
          LEFT JOIN sources s ON s.id = t.source_id
          WHERE chunks_tri MATCH ?
        `;
        const paramsTri = [trigramQ];

        if (sourceId) {
          sqlTri += " AND t.source_id = ?";
          paramsTri.push(sourceId);
        }
        if (scope === "session" && sessionId) {
          sqlTri += " AND t.session_id = ?";
          paramsTri.push(sessionId);
        } else if (scope === "worktree" && worktree) {
          sqlTri += " AND s.worktree = ?";
          paramsTri.push(worktree);
        }

        sqlTri += " LIMIT 30";

        try {
          const rowsTri = this.db.prepare(sqlTri).all(...paramsTri);
          rowsTri.forEach((row, rankIdx) => {
            const key = `${row.source_id}:${row.ord}`;
            const rrf = 1.0 / (RRF_K + rankIdx + 1);
            const existing = scores.get(key);
            if (existing) {
              existing.rrfScore += rrf;
              existing.matches.push({ query: q, type: "trigram", rank: rankIdx + 1 });
            } else {
              scores.set(key, {
                rowid: row.rowid,
                sourceId: row.source_id,
                ord: row.ord,
                body: row.body,
                title: "",
                sessionId: row.session_id,
                worktree: row.worktree || "",
                rrfScore: rrf,
                matches: [{ query: q, type: "trigram", rank: rankIdx + 1 }]
              });
            }
          });
        } catch {
          // Trigram match error ignored
        }
      }
    }

    const allHits = Array.from(scores.values()).sort((a, b) => b.rrfScore - a.rrfScore);
    const paginated = allHits.slice(skipHits, skipHits + maxHits);

    const lookupTitleStmt = this.db.prepare("SELECT title FROM chunks WHERE source_id = ? AND ord = ? LIMIT 1");
    const touchSourceStmt = this.db.prepare("UPDATE sources SET accessed_ts = ? WHERE id = ?");
    const nowTs = Date.now();
    const touchedSources = new Set();

    const formatted = paginated.map((hit) => {
      if (!hit.title) {
        try {
          const row = lookupTitleStmt.get(hit.sourceId, hit.ord);
          if (row && row.title) hit.title = row.title;
        } catch {}
      }
      if (hit.sourceId && !touchedSources.has(hit.sourceId)) {
        touchedSources.add(hit.sourceId);
        try { touchSourceStmt.run(nowTs, hit.sourceId); } catch {}
      }
      let snippet = hit.body;
      if (Buffer.byteLength(snippet, "utf8") > SNIPPET_MAX_BYTES) {
        const suffix = "\n... [truncated, use ctx_search or ctx_index to inspect full]";
        snippet = truncateUtf8Bytes(snippet, Math.max(120, SNIPPET_MAX_BYTES - Buffer.byteLength(suffix, "utf8"))) + suffix;
      }
      return {
        sourceId: hit.sourceId,
        ord: hit.ord,
        title: hit.title || hit.sourceId,
        rrfScore: parseFloat(hit.rrfScore.toFixed(5)),
        matches: hit.matches.length,
        snippet
      };
    });

    return {
      hits: formatted,
      totalMatches: allHits.length,
      returned: formatted.length,
      offset: skipHits,
      limit: maxHits
    };
  }

  /** Record an event in the session journal */
  recordEvent({
    sessionId,
    worktree,
    agent,
    kind,
    tool,
    key,
    path: filePath,
    ok = 1,
    exitCode,
    bytes = 0,
    body = "",
    turn = 0,
    sandboxBytes = 0,
    returnedBytes = 0
  }) {
    this.open();
    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO events (
        session_id, worktree, agent, kind, tool, key, path, ok, exit_code, bytes, body, turn, sandbox_bytes, returned_bytes, created_at, accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = this._withBusyRetry(() =>
      insert.run(
        sessionId || "default",
        worktree || process.cwd(),
        agent || "antigravity",
        kind || "tool",
        tool || null,
        key || null,
        filePath || null,
        ok ? 1 : 0,
        exitCode ?? (ok ? 0 : 1),
        bytes,
        body || null,
        turn,
        sandboxBytes,
        returnedBytes,
        now,
        now
      )
    );

    return { seq: result.lastInsertRowid };
  }

  /** Retrieve compaction / state resume block */
  getResumeState(sessionId, limit = 5, options = {}) {
    this.open();
    const sid = sessionId || "default";
    const sinceTs = options.sinceTs || null;
    const sinceIso = sinceTs ? new Date(sinceTs).toISOString() : null;

    let sources;
    let events;

    if (sid === "all" || sid === "lifetime") {
      sources = this.db
        .prepare(`
          SELECT id, label, kind, bytes_total, chunk_count, created_at
          FROM sources
          ORDER BY created_ts DESC
          LIMIT ?
        `)
        .all(limit);
      events = this.db
        .prepare(`
          SELECT seq, tool, kind, key, path, ok, sandbox_bytes, returned_bytes, agent, created_at
          FROM events
          ORDER BY seq DESC
          LIMIT ?
        `)
        .all(limit);
    } else if (sid === "app" && sinceIso) {
      sources = this.db
        .prepare(`
          SELECT id, label, kind, bytes_total, chunk_count, created_at
          FROM sources
          WHERE created_at >= ? OR created_ts >= ?
          ORDER BY created_ts DESC
          LIMIT ?
        `)
        .all(sinceIso, sinceTs, limit);
      events = this.db
        .prepare(`
          SELECT seq, tool, kind, key, path, ok, sandbox_bytes, returned_bytes, agent, created_at
          FROM events
          WHERE created_at >= ?
          ORDER BY seq DESC
          LIMIT ?
        `)
        .all(sinceIso, limit);
    } else {
      sources = this.db
        .prepare(`
          SELECT id, label, kind, bytes_total, chunk_count, created_at
          FROM sources
          WHERE session_id = ?
          ORDER BY created_ts DESC
          LIMIT ?
        `)
        .all(sid, limit);
      events = this.db
        .prepare(`
          SELECT seq, tool, kind, key, path, ok, sandbox_bytes, returned_bytes, agent, created_at
          FROM events
          WHERE session_id = ?
          ORDER BY seq DESC
          LIMIT ?
        `)
        .all(sid, limit);
    }

    return {
      sessionId: sid,
      recentSources: sources,
      recentEvents: events,
      sessionCheckpoint: this.getSessionCheckpoint(sid)
    };
  }

  /** Retrieve full event body by sequence number (scoped to session when sessionId is provided) */
  getEventBySeq(seq, sessionId = null) {
    this.open();
    if (sessionId && sessionId !== "all" && sessionId !== "lifetime") {
      const row = this.db.prepare("SELECT * FROM events WHERE seq = ? AND session_id = ?").get(seq, sessionId);
      return row || null;
    }
    const row = this.db.prepare("SELECT * FROM events WHERE seq = ?").get(seq);
    return row || null;
  }

  /** Retrieve all chunks for a specific source */
  getSourceChunks(sourceId) {
    this.open();
    if (!sourceId) return [];
    return this.db
      .prepare("SELECT ord, body, title FROM chunks WHERE source_id = ? ORDER BY ord ASC")
      .all(sourceId);
  }
}
