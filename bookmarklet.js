/*
 * 讀墨書單匯出小工具（書籤小工具 / bookmarklet 原始碼）
 *
 * 運作方式：
 *   讀墨網頁版（next.readmoo.com/read）會把你的書櫃快取在瀏覽器本機的 IndexedDB（read-db）。
 *   這支程式只「讀取」這份本機快取，不會呼叫讀墨的伺服器、不會碰帳號密碼。
 *   使用者勾選要分享的書之後，才會：複製 / 下載 CSV / 送到你設定的 ENDPOINT。
 *
 * ENDPOINT：你的 Apps Script 網頁應用程式網址（留空 = 只提供複製與下載）。
 * install.html 會自動把 __ENDPOINT__ 換成你設定的網址。
 */
(async () => {
  const ENDPOINT = '__ENDPOINT__';
  const HAS_ENDPOINT = /^https:\/\//.test(ENDPOINT);
  const PANEL_ID = 'rm-share-import';

  if (location.hostname !== 'next.readmoo.com' || !location.pathname.startsWith('/read')) {
    if (confirm('請在「讀墨網頁版書櫃」頁面使用這個書籤。\n要現在前往嗎？（前往後請再點一次書籤）')) {
      location.href = 'https://next.readmoo.com/read/#/library';
    }
    return;
  }
  if (document.getElementById(PANEL_ID)) return;

  /* ---------- 1. 讀取本機快取 ---------- */
  let db;
  try {
    db = await new Promise((res, rej) => {
      const r = indexedDB.open('read-db');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  } catch (e) {
    alert('無法讀取書櫃資料：' + e);
    return;
  }
  const need = ['library_items', 'readings', 'books'];
  if (!need.every(s => db.objectStoreNames.contains(s))) {
    db.close();
    alert('還沒有書櫃資料。請先打開「書櫃」頁面，等書籍載入完成後再點一次書籤。');
    return;
  }
  const getAll = s => new Promise((res, rej) => {
    const q = db.transaction(s, 'readonly').objectStore(s).getAll();
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
  const optional = s => db.objectStoreNames.contains(s) ? getAll(s) : Promise.resolve([]);
  const [items, readings, books, contributors, categories] = await Promise.all([
    getAll('library_items'), getAll('readings'), getAll('books'), optional('contributors'), optional('categories'),
  ]);
  db.close();

  const readingMap = new Map(readings.map(x => [x.id, x]));
  const bookMap = new Map(books.map(x => [x.id, x]));
  const contribMap = new Map(contributors.map(x => [x.id, x]));
  const categoryMap = new Map(categories.map(x => [x.id, x.attributes?.name]));

  // 把可能含 HTML 的文字轉成純文字（DOMParser 不會執行其中的程式碼）
  const toText = html => {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(
      String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|h\d)>/gi, '\n'), 'text/html');
    return (doc.body.textContent || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };

  const rows = [];
  let borrowedCount = 0;
  for (const it of items) {
    // 向家人「借來」的書不是自己的，不列入
    if (it.attributes?.borrowed) { borrowedCount++; continue; }
    const readingId = it.relationships?.reading?.data?.id;
    const bookId = readingMap.get(readingId)?.relationships?.book?.data?.id;
    const b = bookMap.get(bookId);
    if (!b) continue;
    const a = b.attributes || {};
    const author = a.author ||
      (b.relationships?.contributors?.data || []).map(c => contribMap.get(c.id)?.attributes?.name).filter(Boolean).join('、');
    rows.push({
      readmooId: b.id,
      title: a.title || '',
      author: author || '',
      isbn: a.isbn || '',
      category: categoryMap.get(b.relationships?.top_main_category?.data?.id) || '', // 讀墨大分類，例如「文學小說」
      // 封面只記錄讀墨圖片的網址（直接連到讀墨），不另外下載或保存圖片
      cover: a.cover?.large?.href || a.cover?.medium?.href || '',      // 460px 寬，適合 LINE 卡片
      coverSmall: a.cover?.small?.href || a.cover?.medium?.href || '', // 只用在面板縮圖
      summary: toText(a.short_description),                           // 短簡介（約 100～200 字）；完整介紹請到讀墨書籍頁看
      url: 'https://readmoo.com/book/' + encodeURIComponent(b.id),     // 讀墨書籍頁
      loaned: !!it.attributes?.loaned, // 目前借給家人中
    });
  }
  rows.sort((x, y) => x.title.localeCompare(y.title, 'zh-Hant'));

  if (!rows.length) {
    alert('書櫃裡沒有找到書。請先打開「書櫃」頁面，等書籍載入完成後再試一次。');
    return;
  }

  /* ---------- 2. 介面 ---------- */
  const el = (tag, css, text) => {
    const e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text; // 一律用 textContent，避免書名中的特殊字元被當成 HTML
    return e;
  };
  const btnCss = 'border:0;border-radius:8px;padding:9px 14px;font-size:14px;cursor:pointer;';

  const overlay = el('div', 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-family:system-ui,"Noto Sans TC",sans-serif;');
  overlay.id = PANEL_ID;
  const panel = el('div', 'background:#fff;color:#222;width:min(560px,94vw);max-height:88vh;border-radius:14px;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.3);overflow:hidden;');
  overlay.appendChild(panel);

  const head = el('div', 'padding:16px 18px 10px;border-bottom:1px solid #eee;');
  const titleRow = el('div', 'display:flex;justify-content:space-between;align-items:center;');
  titleRow.appendChild(el('div', 'font-size:18px;font-weight:600;', '📚 匯出我的讀墨書單'));
  const closeBtn = el('button', btnCss + 'background:none;font-size:20px;padding:2px 8px;', '×');
  closeBtn.onclick = () => overlay.remove();
  titleRow.appendChild(closeBtn);
  head.appendChild(titleRow);
  const summary = el('div', 'font-size:13px;color:#666;margin-top:6px;');
  head.appendChild(summary);
  head.appendChild(el('div', 'font-size:12px;color:#888;margin-top:4px;',
    '資料只在你的電腦上處理；按下「送出」前不會傳到任何地方。取消勾選的書不會被分享。'));

  const tools = el('div', 'display:flex;gap:8px;margin-top:10px;align-items:center;');
  const search = el('input', 'flex:1;padding:8px 10px;border:1px solid #ccc;border-radius:8px;font-size:14px;');
  search.placeholder = '搜尋書名或作者';
  const allBox = el('input');
  allBox.type = 'checkbox';
  allBox.checked = true;
  const allLabel = el('label', 'font-size:13px;white-space:nowrap;display:flex;gap:4px;align-items:center;cursor:pointer;');
  allLabel.append(allBox, el('span', null, '全選'));
  tools.append(search, allLabel);
  head.appendChild(tools);
  panel.appendChild(head);

  const list = el('div', 'overflow:auto;flex:1;padding:4px 0;');
  panel.appendChild(list);
  const checks = rows.map(r => {
    const line = el('label', 'display:flex;gap:10px;align-items:flex-start;padding:7px 18px;cursor:pointer;border-bottom:1px solid #f4f4f4;');
    const cb = el('input', 'margin-top:3px;');
    cb.type = 'checkbox';
    cb.checked = true;
    const img = el('img', 'width:34px;height:50px;object-fit:cover;border-radius:3px;background:#eee;flex:none;');
    img.loading = 'lazy';
    img.alt = '';
    if (r.coverSmall) img.src = r.coverSmall;
    const txt = el('div', 'font-size:14px;line-height:1.4;');
    txt.appendChild(el('div', null, r.title));
    txt.appendChild(el('div', 'font-size:12px;color:#888;', [r.author, r.loaned ? '（借出中）' : ''].filter(Boolean).join(' ')));
    line.append(cb, img, txt);
    list.appendChild(line);
    r._line = line;
    r._search = (r.title + ' ' + r.author).toLowerCase();
    cb.onchange = update;
    return cb;
  });

  const foot = el('div', 'padding:12px 18px;border-top:1px solid #eee;display:flex;flex-direction:column;gap:8px;');
  let codeInput = null;
  if (HAS_ENDPOINT) {
    codeInput = el('input', 'padding:8px 10px;border:1px solid #ccc;border-radius:8px;font-size:14px;');
    codeInput.placeholder = '匯入代碼（在 LINE 對機器人輸入「匯入」取得）';
    codeInput.value = new URLSearchParams(location.hash.split('?')[1] || '').get('rmcode') || '';
    foot.appendChild(codeInput);
  }
  const btnRow = el('div', 'display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;');
  const copyBtn = el('button', btnCss + 'background:#eee;', '複製');
  const csvBtn = el('button', btnCss + 'background:#eee;', '下載 CSV');
  btnRow.append(copyBtn, csvBtn);
  let sendBtn = null;
  if (HAS_ENDPOINT) {
    sendBtn = el('button', btnCss + 'background:#06c755;color:#fff;font-weight:600;', '送出');
    btnRow.appendChild(sendBtn);
  }
  foot.appendChild(btnRow);
  const status = el('div', 'font-size:13px;color:#444;min-height:1em;text-align:right;');
  foot.appendChild(status);
  panel.appendChild(foot);
  document.body.appendChild(overlay);

  /* ---------- 3. 行為 ---------- */
  const selected = () => rows.filter((r, i) => checks[i].checked);
  function update() {
    const n = selected().length;
    summary.textContent = `共 ${rows.length} 本，已勾選 ${n} 本` + (borrowedCount ? `（另有 ${borrowedCount} 本是向家人借來的，不列入）` : '');
    if (sendBtn) sendBtn.textContent = `送出 ${n} 本`;
  }
  update();

  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    rows.forEach(r => { r._line.style.display = !q || r._search.includes(q) ? '' : 'none'; });
  };
  allBox.onchange = () => {
    // 只切換目前搜尋結果中看得到的書
    rows.forEach((r, i) => { if (r._line.style.display !== 'none') checks[i].checked = allBox.checked; });
    update();
  };

  const clean = r => ({
    readmooId: r.readmooId, title: r.title, author: r.author, isbn: r.isbn, category: r.category,
    cover: r.cover, summary: r.summary, loaned: r.loaned,
  });
  const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim(); // 複製到表格時不能有換行和 tab

  copyBtn.onclick = async () => {
    const tsv = ['書名\t作者\tISBN\t封面\t簡介\t讀墨連結',
      ...selected().map(r => [r.title, r.author, r.isbn, r.cover, r.summary, r.url].map(oneLine).join('\t'))].join('\n');
    try {
      await navigator.clipboard.writeText(tsv);
      status.textContent = `已複製 ${selected().length} 本，可直接貼到 Google 試算表或 Excel`;
    } catch (e) {
      status.textContent = '複製失敗，請改用「下載 CSV」';
    }
  };

  csvBtn.onclick = () => {
    const q = s => '"' + String(s).replace(/"/g, '""') + '"';
    const csv = '﻿' + [['書名', '作者', 'ISBN', '讀墨ID', '借出中', '封面', '簡介', '讀墨連結'],
      ...selected().map(r => [r.title, r.author, r.isbn, r.readmooId, r.loaned ? '是' : '', r.cover, r.summary, r.url])]
      .map(row => row.map(q).join(',')).join('\r\n');
    const a = el('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    a.download = `讀墨書單_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    status.textContent = `已下載 ${selected().length} 本`;
  };

  if (sendBtn) sendBtn.onclick = async () => {
    const code = codeInput.value.trim();
    if (!code) { status.textContent = '請先輸入匯入代碼'; codeInput.focus(); return; }
    const payload = JSON.stringify({ code, books: selected().map(clean) });
    sendBtn.disabled = true;
    status.textContent = '送出中…';
    try {
      // text/plain 屬於「簡單請求」，Apps Script 可以直接接收
      const res = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: payload });
      const data = await res.json();
      if (data.ok) {
        status.textContent = `✅ 完成！新增 ${data.added} 本` + (data.updated ? `，補上 ${data.updated} 本的封面與簡介` : '') + `，略過 ${data.skipped} 本已有的書`;
      } else {
        status.textContent = '❌ ' + (data.error || '匯入失敗');
        sendBtn.disabled = false;
      }
    } catch (e) {
      status.textContent = '❌ 無法連線到伺服器，請稍後再試，或改用「下載 CSV」';
      sendBtn.disabled = false;
    }
  };
})();
