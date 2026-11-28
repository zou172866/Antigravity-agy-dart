    let searchRequestSeq = 0;

    function invalidateSearchRequests() {
      ++searchRequestSeq;
    }

    function inspectSourceEl(el) {
      if (!el) return;
      return inspectSource(el.dataset.sourceId || '', encodeURIComponent(el.dataset.sourceLabel || ''));
    }

    async function inspectSource(sourceId, encodedLabel) {
      const reqSeq = ++searchRequestSeq;
      const label = decodeURIComponent(encodedLabel || '');
      const input = document.getElementById('search-input');
      if (input) input.value = label;

      const resultsDiv = document.getElementById('search-results');
      resultsDiv.innerHTML = `<div class="muted-note">${escapeHtml(t('loadingChunks'))}</div>`;

      try {
        const res = await apiFetch('/api/source-chunks', {
          method: 'POST',
          body: JSON.stringify({ sourceId })
        });
        if (reqSeq !== searchRequestSeq) return;
        if (res.ok) {
          const data = await res.json();
          if (reqSeq !== searchRequestSeq) return;
          if (data.chunks && data.chunks.length > 0) {
            resultsDiv.innerHTML = data.chunks.map((ch, idx) => {
              const bodyStr = typeof ch?.body === 'string' ? ch.body : String(ch?.body ?? '');
              return `
              <div class="result-item">
                <div class="result-head">
                  <span class="result-title truncate">${escapeHtml(ch?.title || label)} [${escapeHtml(t('chunkLabel', { i: idx + 1, total: data.chunks.length }))}]</span>
                  <span class="result-badge">${bodyStr.length} B</span>
                </div>
                <div class="result-body">${escapeHtml(bodyStr.slice(0, 380))}${bodyStr.length > 380 ? '...' : ''}</div>
              </div>
            `;
            }).join('');
            const card = document.getElementById('search-inspector-card');
            if (card) card.scrollIntoView({ behavior: 'smooth' });
            return;
          }
        }
      } catch (err) {
        if (reqSeq !== searchRequestSeq) return;
        console.error("Failed to load source chunks:", err);
      }

      if (reqSeq !== searchRequestSeq) return;
      executeSearch();
    }

    async function executeSearch() {
      const q = document.getElementById('search-input').value.trim();
      if (!q) return;

      const reqSeq = ++searchRequestSeq;
      const resultsDiv = document.getElementById('search-results');
      resultsDiv.innerHTML = `<div class="muted-note">${escapeHtml(t('searchingFts'))}</div>`;

      try {
        const convId = getActiveConversationId();
        const res = await apiFetch('/api/search', {
          method: 'POST',
          body: JSON.stringify({ query: q, scope: currentScope, conversationId: convId })
        });
        if (reqSeq !== searchRequestSeq) return;
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (reqSeq !== searchRequestSeq) return;

        if (data.hits && data.hits.length > 0) {
          resultsDiv.innerHTML = data.hits.map(h => `
            <div class="result-item">
              <div class="result-head">
                <span class="result-title truncate">${escapeHtml(h.title || h.sourceId)}</span>
                <span class="result-badge">RRF: ${Number(h.rrfScore) || 0}</span>
              </div>
              <div class="result-body">${escapeHtml((h.snippet || '').slice(0, 260))}...</div>
            </div>
          `).join('');
        } else {
          resultsDiv.innerHTML = `<div class="muted-note">${escapeHtml(t('noMatchingChunks'))}</div>`;
        }
      } catch (err) {
        if (reqSeq !== searchRequestSeq) return;
        resultsDiv.innerHTML = `<div class="muted-note val-danger">${escapeHtml(t('searchFailed', { msg: err.message }))}</div>`;
      }
    }

