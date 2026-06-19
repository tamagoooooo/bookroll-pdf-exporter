const exportBtn = document.getElementById('export');
const statusEl = document.getElementById('status');
const bar = document.getElementById('bar');

function setStatus(msg) { statusEl.textContent = msg; }

exportBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url || !tab.url.includes('bookroll.let.media.kyoto-u.ac.jp')) {
    setStatus('BookRollのページで実行してください。');
    return;
  }

  exportBtn.disabled = true;
  bar.hidden = false;
  setStatus('準備中...');

  // 進捗をポップアップに渡すためのリスナー
  const onMsg = (m) => {
    if (m.type === 'progress') {
      bar.value = m.value;
      setStatus(m.text);
    }
  };
  chrome.runtime.onMessage.addListener(onMsg);

  try {
    // jsPDFを注入
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['jspdf.umd.min.js']
    });

    // メイン処理を注入して実行
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: capturePagesAndBuildPdf
    });

    if (result && result.error) {
      setStatus('エラー: ' + result.error);
      return;
    }

    // base64 PDFをダウンロード
    const dataUrl = 'data:application/pdf;base64,' + result.base64;
    await chrome.downloads.download({
      url: dataUrl,
      filename: result.filename,
      saveAs: true
    });

    bar.value = 100;
    setStatus(`完了: ${result.pages}ページを書き出しました。`);
  } catch (e) {
    setStatus('エラー: ' + (e.message || e));
  } finally {
    chrome.runtime.onMessage.removeListener(onMsg);
    exportBtn.disabled = false;
  }
});

// ===== ページ内で実行される関数（先ほど成功した処理をそのまま関数化） =====
async function capturePagesAndBuildPdf() {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function getCanvas() {
    // material-canvas（高解像度のスライド描画canvas）を探す
    const byClass = document.querySelector('canvas.material-canvas')
      || document.querySelector('.material-canvas canvas');
    if (byClass) return byClass;
    // フォールバック: 最も大きい可視canvas
    const list = [...document.querySelectorAll('canvas')]
      .filter(c => c.width > 0 && c.height > 0)
      .sort((a, b) => (b.width * b.height) - (a.width * a.height));
    return list[0];
  }

  function totalPages() {
    const m = document.body.innerText.match(/\d+\s*\/\s*(\d+)/);
    return m ? parseInt(m[1]) : null;
  }
  function pageNum() {
    const m = document.body.innerText.match(/(\d+)\s*\/\s*\d+/);
    return m ? parseInt(m[1]) : null;
  }

  function report(value, text) {
    try { chrome.runtime.sendMessage({ type: 'progress', value, text }); } catch (e) {}
  }

  async function waitStable() {
    let last = null;
    for (let i = 0; i < 25; i++) {
      await sleep(300);
      const len = getCanvas().toDataURL('image/png').length;
      if (len === last) return;
      last = len;
    }
  }

  try {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      return { error: 'jsPDFが読み込まれていません。' };
    }
    const total = totalPages();
    if (!total) return { error: 'ページ数を取得できませんでした。BookRollの閲覧画面で実行してください。' };

    const nextBtn = document.querySelector('.next-btn');
    const prevBtn = document.querySelector('.back-btn') || document.querySelector('.prev-btn');
    if (!nextBtn) return { error: '「次へ」ボタンが見つかりませんでした。' };

    // 1ページ目まで戻す
    let guard = 0;
    while (pageNum() > 1 && prevBtn && guard < total + 5) {
      prevBtn.click();
      await sleep(800);
      guard++;
    }

    const pages = {};
    for (let p = 1; p <= total; p++) {
      await waitStable();
      const cur = pageNum();
      pages[cur] = getCanvas().toDataURL('image/png');
      report(Math.round((p / total) * 80), `取得中 ${p}/${total} ページ`);
      if (p < total) {
        nextBtn.click();
        await sleep(1200);
      }
    }

    report(85, 'PDFを作成中...');

    // 画像サイズを取得
    const sizeOf = (dataUrl) => new Promise(res => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.src = dataUrl;
    });
    const first = await sizeOf(pages[1]);
    const w = first.w, h = first.h;
    const orient = w >= h ? 'landscape' : 'portrait';

    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: orient, unit: 'px', format: [w, h], compress: true });
    for (let p = 1; p <= total; p++) {
      if (!pages[p]) continue;
      if (p > 1) pdf.addPage([w, h], orient);
      pdf.addImage(pages[p], 'PNG', 0, 0, w, h);
    }

    // base64で返す
    const base64 = pdf.output('datauristring').split(',')[1];

    // ファイル名（タイトルから生成）
    let title = (document.title || 'bookroll').replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!title) title = 'bookroll';
    const filename = title + '.pdf';

    report(100, '完了');
    return { base64, pages: total, filename };
  } catch (e) {
    return { error: e.message || String(e) };
  }
}