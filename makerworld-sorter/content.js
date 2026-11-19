// MakerWorld ランキング＆フィルタ
// MakerWorld の検索API（キーワード空欄）から上位モデルを取得し、手元で並べ替え・絞り込みする。
(() => {
  if (window.__mwlrLoaded) return;
  window.__mwlrLoaded = true;

  const API = '/api/v1/search-service/select/design2';
  const PAGE = 100;          // 1リクエストあたりの件数（APIの上限）
  const MAX_TOTAL = 10000;   // APIが返す上限
  const STORE_DATA = 'mwlr_data';
  const STORE_PREF = 'mwlr_pref';
  const DAY = 86400000;

  const SORTS = {
    likes: ['いいね数', m => m.likes],
    downloads: ['ダウンロード数', m => m.downloads],
    prints: ['印刷数', m => m.prints],
    collects: ['コレクション数', m => m.collects],
    comments: ['コメント数', m => m.comments],
    boosts: ['ブースト数', m => m.boosts],
    likeRate: ['いいね率（いいね÷DL）', m => m.downloads ? m.likes / m.downloads : 0],
    printRate: ['印刷率（印刷÷DL）', m => m.downloads ? m.prints / m.downloads : 0],
    likesPerDay: ['勢い（1日あたりいいね）', m => m.likes / ageDays(m)],
    dlPerDay: ['勢い（1日あたりDL）', m => m.downloads / ageDays(m)],
    newest: ['投稿日', m => m.created],
  };
  const SERVER_SORTS = { likeCount: 'いいね数', downloadCount: 'ダウンロード数', collectionCount: 'コレクション数' };

  const DEFAULT_PREF = {
    serverSort: 'likeCount', keyword: '', fetchCount: 1000, interval: 0.8,
    sort: 'likes', dir: 'desc',
    minLikes: '', minDownloads: '', minPrints: '', minCollects: '', minLikeRate: '',
    days: '', fromDate: '', include: '', exclude: '', creator: '', license: '',
    staffOnly: false, exclusive: 'any', hideAI: false, hideNsfw: true, printableOnly: false,
  };

  let pref = { ...DEFAULT_PREF };
  let data = { items: [], fetchedAt: 0, query: null };
  let shown = 60;
  let busy = false, stopFlag = false, statusMsg = '';

  function ageDays(m) { return Math.max(1, (Date.now() - m.created) / DAY); }
  const num = v => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);

  function slim(h) {
    const c = h.designCreator || {};
    return {
      id: h.id, slug: h.slug || '', title: h.title || '', titleTr: h.titleTranslated || '',
      cover: h.cover || '', likes: num(h.likeCount), downloads: num(h.downloadCount),
      prints: num(h.printCount), collects: num(h.collectionCount), comments: num(h.commentCount),
      boosts: num(h.boostCnt), created: Date.parse(h.createTime) || 0,
      creator: c.name || '', handle: c.handle || '', license: h.license || '',
      tags: Array.isArray(h.tags) ? h.tags.slice(0, 15) : [],
      staff: !!h.isStaffPicked, exclusive: !!h.isExclusive, ai: !!h.isAIGC,
      nsfw: !!h.nsfw, printable: !!h.is_printable,
    };
  }

  // ---------- 保存 ----------
  const store = {
    get: k => new Promise(r => { try { chrome.storage.local.get(k, v => r(v && v[k])); } catch (e) { r(undefined); } }),
    set: (k, v) => new Promise(r => { try { chrome.storage.local.set({ [k]: v }, () => r()); } catch (e) { r(); } }),
  };
  let prefTimer;
  const savePref = () => { clearTimeout(prefTimer); prefTimer = setTimeout(() => store.set(STORE_PREF, pref), 300); };

  // ---------- 取得 ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function fetchPage(offset, limit) {
    const u = new URL(API, location.origin);
    u.searchParams.set('keyword', pref.keyword.trim());
    u.searchParams.set('orderBy', pref.serverSort);
    u.searchParams.set('offset', offset);
    u.searchParams.set('limit', limit);
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetch(u, { credentials: 'include' });
      if (res.status === 429 || res.status >= 500) { await sleep(3000 * (attempt + 1)); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }
    throw new Error('アクセス制限のため取得できませんでした。時間をおいて再試行してください。');
  }

  async function collect() {
    if (busy) return;
    busy = true; stopFlag = false; render();
    const want = Math.min(MAX_TOTAL, Math.max(PAGE, Number(pref.fetchCount) || 1000));
    const map = new Map();
    let total = Infinity;
    try {
      for (let off = 0; off < want && off < total; off += PAGE) {
        if (stopFlag) break;
        const d = await fetchPage(off, Math.min(PAGE, want - off));
        total = Math.min(num(d.total) || 0, MAX_TOTAL);
        const hits = d.hits || [];
        hits.forEach(h => map.set(h.id, slim(h)));
        setStatus(`取得中… ${map.size} / ${Math.min(want, total)} 件`);
        if (!hits.length) break;
        await sleep(Math.max(0.3, Number(pref.interval) || 0.8) * 1000);
      }
      data = { items: [...map.values()], fetchedAt: Date.now(), query: { k: pref.keyword, o: pref.serverSort } };
      await store.set(STORE_DATA, data);
      setStatus(`${data.items.length} 件を取得しました${stopFlag ? '（途中で停止）' : ''}`);
    } catch (e) {
      if (map.size) {
        data = { items: [...map.values()], fetchedAt: Date.now(), query: { k: pref.keyword, o: pref.serverSort } };
        await store.set(STORE_DATA, data);
      }
      setStatus('エラー: ' + e.message + (map.size ? `（${map.size} 件までは保存済み）` : ''));
    } finally {
      busy = false; shown = 60; renderResults(); renderControls();
    }
  }

  // ---------- 絞り込み ----------
  const words = s => s.toLowerCase().split(/[\s,、]+/).filter(Boolean);
  function filtered() {
    const inc = words(pref.include), exc = words(pref.exclude), cr = pref.creator.trim().toLowerCase();
    const n = k => (pref[k] === '' ? null : Number(pref[k]));
    const minL = n('minLikes'), minD = n('minDownloads'), minP = n('minPrints'), minC = n('minCollects'), minR = n('minLikeRate');
    let since = 0;
    if (pref.days) since = Date.now() - Number(pref.days) * DAY;
    if (pref.fromDate) since = Math.max(since, Date.parse(pref.fromDate) || 0);
    const out = data.items.filter(m => {
      if (minL != null && m.likes < minL) return false;
      if (minD != null && m.downloads < minD) return false;
      if (minP != null && m.prints < minP) return false;
      if (minC != null && m.collects < minC) return false;
      if (minR != null && (m.downloads ? (m.likes / m.downloads) * 100 : 0) < minR) return false;
      if (since && m.created < since) return false;
      if (pref.license && m.license !== pref.license) return false;
      if (pref.staffOnly && !m.staff) return false;
      if (pref.exclusive === 'only' && !m.exclusive) return false;
      if (pref.exclusive === 'hide' && m.exclusive) return false;
      if (pref.hideAI && m.ai) return false;
      if (pref.hideNsfw && m.nsfw) return false;
      if (pref.printableOnly && !m.printable) return false;
      if (cr && !(m.creator.toLowerCase().includes(cr) || m.handle.toLowerCase().includes(cr))) return false;
      if (inc.length || exc.length) {
        const hay = (m.title + ' ' + m.titleTr + ' ' + m.tags.join(' ')).toLowerCase();
        if (inc.some(w => !hay.includes(w))) return false;
        if (exc.some(w => hay.includes(w))) return false;
      }
      return true;
    });
    const f = (SORTS[pref.sort] || SORTS.likes)[1];
    const sgn = pref.dir === 'asc' ? 1 : -1;
    return out.sort((a, b) => sgn * (f(a) - f(b)));
  }

  // ---------- CSV ----------
  function exportCsv() {
    const rows = filtered();
    const head = ['順位', 'タイトル', '作者', 'いいね', 'DL', '印刷', 'コレクション', 'コメント', 'ブースト', 'いいね率%', '投稿日', 'ライセンス', 'URL'];
    const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = [head.map(esc).join(',')].concat(rows.map((m, i) => [
      i + 1, m.title, m.creator, m.likes, m.downloads, m.prints, m.collects, m.comments, m.boosts,
      m.downloads ? (m.likes / m.downloads * 100).toFixed(1) : '', fmtDate(m.created), m.license, modelUrl(m),
    ].map(esc).join(',')));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `makerworld_${pref.sort}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ---------- 表示 ----------
  const lang = (location.pathname.match(/^\/([a-z]{2}(?:-[A-Za-z]{2})?)\//) || [])[1] || 'ja';
  const modelUrl = m => `${location.origin}/${lang}/models/${m.id}${m.slug ? '-' + m.slug : ''}`;
  const fmtDate = t => (t ? new Date(t).toLocaleDateString('ja-JP') : '');
  const fmtN = v => v >= 10000 ? (v / 1000).toFixed(v >= 100000 ? 0 : 1) + 'k' : v.toLocaleString('ja-JP');
  const escH = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const host = document.createElement('div');
  host.id = 'mwlr-host';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
<style>
:host{all:initial}
*{box-sizing:border-box;font-family:"Noto Sans JP","Hiragino Sans","Yu Gothic UI",Meiryo,sans-serif}
.fab{position:fixed;right:20px;bottom:20px;z-index:2147483646;background:#00ae42;color:#fff;border:none;border-radius:24px;padding:12px 18px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
.fab:hover{background:#00953a}
.ov{position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.45);display:none}
.ov.open{display:flex}
.pn{margin:auto;width:min(1280px,96vw);height:92vh;background:#fff;color:#1d1d1f;border-radius:12px;display:flex;overflow:hidden;box-shadow:0 10px 40px rgba(0,0,0,.35)}
.side{width:300px;flex:none;border-right:1px solid #e5e5e5;overflow-y:auto;padding:14px 16px;background:#fafafa}
.main{flex:1;display:flex;flex-direction:column;min-width:0}
.top{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #e5e5e5;flex-wrap:wrap}
.top h2{font-size:16px;margin:0;flex:1}
h3{font-size:13px;margin:16px 0 6px;color:#00953a}
h3:first-child{margin-top:0}
label{display:block;font-size:12px;margin:6px 0 2px;color:#444}
input[type=text],input[type=number],input[type=date],select{width:100%;padding:6px 8px;border:1px solid #ccc;border-radius:6px;font-size:13px;background:#fff;color:#1d1d1f}
.row{display:flex;gap:8px}.row>*{flex:1;min-width:0}
.chk{display:flex;align-items:center;gap:6px;font-size:12px;margin:5px 0;color:#333}
.chk input{margin:0}
button.b{padding:7px 12px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;font-size:13px;color:#1d1d1f}
button.p{background:#00ae42;color:#fff;border-color:#00ae42;font-weight:700}
button.b:disabled{opacity:.5;cursor:default}
.st{font-size:12px;color:#555}
.hint{font-size:11px;color:#777;margin-top:4px;line-height:1.5}
.grid{flex:1;overflow-y:auto;padding:14px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;align-content:start;grid-auto-rows:max-content}
.card{border:1px solid #e5e5e5;border-radius:10px;overflow:hidden;background:#fff;display:flex;flex-direction:column;text-decoration:none;color:inherit}
.card:hover{box-shadow:0 3px 12px rgba(0,0,0,.12)}
.card img{width:100%;aspect-ratio:4/3;object-fit:cover;background:#eee;display:block}
.cb{padding:8px 10px;display:flex;flex-direction:column;gap:4px}
.rk{font-size:11px;font-weight:700;color:#00953a}
.tt{font-size:13px;font-weight:600;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.au{font-size:11px;color:#666}
.ms{display:flex;flex-wrap:wrap;gap:4px 10px;font-size:11px;color:#333}
.bd{font-size:10px;padding:1px 6px;border-radius:8px;background:#eef8f1;color:#00953a;margin-right:4px}
.more{grid-column:1/-1;justify-self:center;margin:8px 0 20px}
.empty{grid-column:1/-1;text-align:center;color:#777;padding:40px 0;font-size:14px;line-height:1.8}
@media (max-width:760px){.pn{flex-direction:column;height:96vh}.side{width:auto;max-height:45%;border-right:none;border-bottom:1px solid #e5e5e5}}
</style>
<button class="fab" id="fab">★ ランキング</button>
<div class="ov" id="ov"><div class="pn">
  <div class="side" id="side"></div>
  <div class="main">
    <div class="top"><h2 id="count">MakerWorld ランキング</h2>
      <button class="b" id="csv">CSV出力</button><button class="b" id="close">閉じる ✕</button></div>
    <div class="grid" id="grid"></div>
  </div>
</div></div>`;
  document.documentElement.appendChild(host);
  const $ = id => root.getElementById(id);

  function setStatus(t) { statusMsg = t; const el = $('status'); if (el) el.textContent = t; }

  function renderControls() {
    const licenses = [...new Set(data.items.map(m => m.license).filter(Boolean))].sort();
    const opt = (o, v) => Object.entries(o).map(([k, l]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${escH(Array.isArray(l) ? l[0] : l)}</option>`).join('');
    const inp = (k, type = 'number', ph = '') => `<input type="${type}" data-k="${k}" value="${escH(pref[k])}" placeholder="${ph}">`;
    const chk = (k, l) => `<div class="chk"><input type="checkbox" data-k="${k}" ${pref[k] ? 'checked' : ''} id="c_${k}"><label for="c_${k}" style="margin:0">${l}</label></div>`;
    $('side').innerHTML = `
<h3>① データ取得</h3>
<label>取得する順番（サーバー側）</label><select data-k="serverSort">${opt(SERVER_SORTS, pref.serverSort)}</select>
<label>キーワード（空欄＝全体）</label>${inp('keyword', 'text', '例: AMS')}
<div class="row"><div><label>取得件数</label>${inp('fetchCount', 'number', '1000')}</div>
<div><label>間隔（秒）</label>${inp('interval', 'number', '0.8')}</div></div>
<div class="row" style="margin-top:8px"><button class="b p" id="go" ${busy ? 'disabled' : ''}>取得開始</button>
<button class="b" id="stop" ${busy ? '' : 'disabled'}>停止</button></div>
<div class="st" id="status" style="margin-top:6px">${statusMsg ? escH(statusMsg) : data.items.length ? `保存済み ${data.items.length} 件（${new Date(data.fetchedAt).toLocaleString('ja-JP')} 取得）` : '未取得'}</div>
<div class="hint">最大1万件。100件ごとに1回通信します（1000件で約10秒）。結果は保存され、次回も使えます。</div>

<h3>② 並べ替え</h3>
<div class="row"><select data-k="sort">${opt(SORTS, pref.sort)}</select>
<select data-k="dir" style="flex:.55"><option value="desc" ${pref.dir === 'desc' ? 'selected' : ''}>多い順</option><option value="asc" ${pref.dir === 'asc' ? 'selected' : ''}>少ない順</option></select></div>

<h3>③ 絞り込み</h3>
<div class="row"><div><label>いいね 以上</label>${inp('minLikes')}</div><div><label>DL 以上</label>${inp('minDownloads')}</div></div>
<div class="row"><div><label>印刷 以上</label>${inp('minPrints')}</div><div><label>コレクション 以上</label>${inp('minCollects')}</div></div>
<label>いいね率（％）以上</label>${inp('minLikeRate', 'number', '例: 30')}
<div class="row"><div><label>投稿期間</label><select data-k="days">
${[['', '全期間'], ['7', '7日以内'], ['30', '30日以内'], ['90', '90日以内'], ['180', '半年以内'], ['365', '1年以内']].map(([v, l]) => `<option value="${v}" ${String(pref.days) === v ? 'selected' : ''}>${l}</option>`).join('')}
</select></div><div><label>この日以降</label>${inp('fromDate', 'date')}</div></div>
<label>含む語（タイトル・タグ、スペース区切りでAND）</label>${inp('include', 'text', '例: holder')}
<label>除外する語</label>${inp('exclude', 'text', '例: keychain')}
<label>作者名</label>${inp('creator', 'text')}
<label>ライセンス</label><select data-k="license"><option value="">すべて</option>${licenses.map(l => `<option ${l === pref.license ? 'selected' : ''}>${escH(l)}</option>`).join('')}</select>
<label>独占モデル（Exclusive）</label><select data-k="exclusive">
<option value="any" ${pref.exclusive === 'any' ? 'selected' : ''}>指定なし</option><option value="only" ${pref.exclusive === 'only' ? 'selected' : ''}>独占のみ</option><option value="hide" ${pref.exclusive === 'hide' ? 'selected' : ''}>独占を除外</option></select>
${chk('staffOnly', 'スタッフピックのみ')}${chk('printableOnly', '印刷プロファイルありのみ')}${chk('hideAI', 'AI生成モデルを除外')}${chk('hideNsfw', 'NSFWを除外')}
<div style="margin-top:10px"><button class="b" id="reset">絞り込みをリセット</button></div>
<div class="hint">②③は取得済みデータの中で即時に反映されます。</div>`;

    root.querySelectorAll('#side [data-k]').forEach(el => {
      const k = el.dataset.k;
      const ev = el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(ev, () => {
        pref[k] = el.type === 'checkbox' ? el.checked : el.value;
        savePref();
        if (!['serverSort', 'keyword', 'fetchCount', 'interval'].includes(k)) { shown = 60; renderResults(); }
      });
    });
    $('go').onclick = collect;
    $('stop').onclick = () => { stopFlag = true; };
    $('reset').onclick = () => {
      ['minLikes', 'minDownloads', 'minPrints', 'minCollects', 'minLikeRate', 'days', 'fromDate', 'include', 'exclude', 'creator', 'license', 'staffOnly', 'exclusive', 'hideAI', 'hideNsfw', 'printableOnly']
        .forEach(k => { pref[k] = DEFAULT_PREF[k]; });
      savePref(); renderControls(); shown = 60; renderResults();
    };
  }

  function renderResults() {
    const list = filtered();
    $('count').textContent = data.items.length ? `${list.length.toLocaleString('ja-JP')} 件 / 取得 ${data.items.length.toLocaleString('ja-JP')} 件` : 'MakerWorld ランキング';
    const grid = $('grid');
    if (!data.items.length) {
      grid.innerHTML = '<div class="empty">左の「取得開始」を押すと、MakerWorld全体のモデルを取得します。<br>キーワードは空欄のままで全体が対象です。</div>';
      return;
    }
    if (!list.length) { grid.innerHTML = '<div class="empty">条件に合うモデルがありません。</div>'; return; }
    const sortLabel = SORTS[pref.sort][0];
    grid.innerHTML = list.slice(0, shown).map((m, i) => {
      const rate = m.downloads ? (m.likes / m.downloads * 100).toFixed(0) + '%' : '-';
      const badges = (m.staff ? '<span class="bd">Staff Pick</span>' : '') + (m.exclusive ? '<span class="bd">独占</span>' : '');
      const extra = pref.sort === 'likesPerDay' ? `<span>勢い ${(m.likes / ageDays(m)).toFixed(1)}/日</span>`
        : pref.sort === 'dlPerDay' ? `<span>勢い ${(m.downloads / ageDays(m)).toFixed(1)}/日</span>`
        : pref.sort === 'printRate' ? `<span>印刷率 ${m.downloads ? (m.prints / m.downloads * 100).toFixed(0) : 0}%</span>` : '';
      return `<a class="card" href="${escH(modelUrl(m))}" target="_blank" rel="noopener">
<img loading="lazy" src="${escH(m.cover)}" alt="">
<div class="cb"><div class="rk">#${i + 1}（${escH(sortLabel)}）</div>
<div class="tt" title="${escH(m.title)}">${escH(m.title)}</div>
<div class="au">${escH(m.creator)}・${fmtDate(m.created)}</div>
<div class="ms"><span>♥ ${fmtN(m.likes)}</span><span>⬇ ${fmtN(m.downloads)}</span><span>🖨 ${fmtN(m.prints)}</span><span>★ ${fmtN(m.collects)}</span><span>💬 ${fmtN(m.comments)}</span><span>率 ${rate}</span>${extra}</div>
<div>${badges}</div></div></a>`;
    }).join('') + (list.length > shown ? `<button class="b more" id="more">さらに表示（残り ${list.length - shown} 件）</button>` : '');
    const more = $('more');
    if (more) more.onclick = () => { shown += 120; renderResults(); };
  }

  function render() { renderControls(); renderResults(); }

  $('fab').onclick = () => { $('ov').classList.add('open'); render(); };
  $('close').onclick = () => $('ov').classList.remove('open');
  $('ov').addEventListener('click', e => { if (e.target === $('ov')) $('ov').classList.remove('open'); });
  $('csv').onclick = exportCsv;
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('ov').classList.remove('open'); });

  (async () => {
    const p = await store.get(STORE_PREF);
    if (p) pref = { ...DEFAULT_PREF, ...p };
    const d = await store.get(STORE_DATA);
    if (d && Array.isArray(d.items)) data = d;
  })();
})();
