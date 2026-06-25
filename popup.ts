interface ProgressMessage {
  type: 'progress';
  value: number;
  text: string;
}

interface ResultMessage {
  error?: string;
  base64?: string;
  pages?: number;
  filename?: string;
}

interface PageData {
  [key: number]: string;
}

interface ImageSize {
  w: number;
  h: number;
}

const exportBtn = document.getElementById('export') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const bar = document.getElementById('bar') as HTMLProgressElement;

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

exportBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url || !tab.url.includes('bookroll.let.media.kyoto-u.ac.jp')) {
    setStatus('BookRollのページで実行してください。');
    return;
  }

  exportBtn.disabled = true;
  bar.hidden = false;
  setStatus('準備中...');

  const onMsg = (m: ProgressMessage) => {
    if (m.type === 'progress') {
      bar.value = m.value;
      setStatus(m.text);
    }
  };
  chrome.runtime.onMessage.addListener(onMsg);

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      files: ['jspdf.umd.min.js']
    });

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id! },
      func: capturePagesAndBuildPdf
    });

    const result = results[0]?.result as ResultMessage | undefined;
    if (!result) {
      setStatus('エラー: 結果を取得できませんでした。');
      return;
    }

    if (result.error) {
      setStatus('エラー: ' + result.error);
      return;
    }

    if (!result.base64 || !result.filename) {
      setStatus('エラー: PDFの生成に失敗しました。');
      return;
    }

    const dataUrl = 'data:application/pdf;base64,' + result.base64;
    await chrome.downloads.download({
      url: dataUrl,
      filename: result.filename,
      saveAs: true
    });

    bar.value = 100;
    setStatus(`完了: ${result.pages}ページを書き出しました。`);
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    setStatus('エラー: ' + errorMsg);
  } finally {
    chrome.runtime.onMessage.removeListener(onMsg);
    exportBtn.disabled = false;
  }
});

async function capturePagesAndBuildPdf(): Promise<ResultMessage> {
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

  const appElement = document.querySelector("#app") as any;
  if (!appElement || !appElement.__vue__) {
    return { error: 'Vue インスタンスが見つかりません。' };
  }

  function getCanvas(): HTMLCanvasElement | null {
    const byClass = document.querySelector('canvas.material-canvas') as HTMLCanvasElement ||
                   document.querySelector('.material-canvas canvas') as HTMLCanvasElement;
    if (byClass) return byClass;

    const list = [...document.querySelectorAll('canvas')]
      .filter((c: Element) => {
        const canvas = c as HTMLCanvasElement;
        return canvas.width > 0 && canvas.height > 0;
      })
      .sort((a: Element, b: Element) => {
        const canvasA = a as HTMLCanvasElement;
        const canvasB = b as HTMLCanvasElement;
        return (canvasB.width * canvasB.height) - (canvasA.width * canvasA.height);
      });

    return list[0] as HTMLCanvasElement || null;
  }

  function totalPages(): number | null {
    const m = document.body.innerText.match(/\d+\s*\/\s*(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  function pageNum(): number | null {
    const m = document.body.innerText.match(/(\d+)\s*\/\s*\d+/);
    return m ? parseInt(m[1], 10) : null;
  }

  function report(value: number, text: string): void {
    try {
      chrome.runtime.sendMessage({ type: 'progress', value, text });
    } catch (e) {
      // Ignore errors
    }
  }

  async function waitStable(): Promise<void> {
    let last: number | null = null;
    for (let i = 0; i < 25; i++) {
      await sleep(300);
      const canvas = getCanvas();
      if (!canvas) return;
      const len = canvas.toDataURL('image/png').length;
      if (len === last) return;
      last = len;
    }
  }

  try {
    const jsPdfWindow = window as any;
    if (!jsPdfWindow.jspdf || !jsPdfWindow.jspdf.jsPDF) {
      return { error: 'jsPDFが読み込まれていません。' };
    }

    const total = totalPages();
    if (!total) {
      return { error: 'ページ数を取得できませんでした。BookRollの閲覧画面で実行してください。' };
    }

    const nextBtn = document.querySelector('.next-btn') as HTMLButtonElement;
    const prevBtn = (document.querySelector('.back-btn') ||
                     document.querySelector('.prev-btn')) as HTMLButtonElement;

    if (!nextBtn) {
      return { error: '「次へ」ボタンが見つかりませんでした。' };
    }

    let guard = 0;
    while (pageNum() !== 1 && prevBtn && guard < total + 5) {
      prevBtn.click();
      await sleep(800);
      guard++;
    }

    const pages: PageData = {};
    for (let p = 1; p <= total; p++) {
      await waitStable();
      const cur = pageNum();
      const canvas = getCanvas();
      if (cur !== null && canvas) {
        pages[cur] = canvas.toDataURL('image/png');
      }
      report(Math.round((p / total) * 80), `取得中 ${p}/${total} ページ`);

      if (p < total) {
        nextBtn.click();
        await sleep(1200);
      }
    }

    report(85, 'PDFを作成中...');

    const sizeOf = (dataUrl: string): Promise<ImageSize> => new Promise(res => {
      const im = new Image();
      im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight });
      im.src = dataUrl;
    });

    const first = await sizeOf(pages[1]);
    const w = first.w;
    const h = first.h;
    const orient = w >= h ? 'landscape' : 'portrait';

    const { jsPDF } = jsPdfWindow.jspdf;
    const pdf = new jsPDF({ orientation: orient, unit: 'px', format: [w, h], compress: true });

    for (let p = 1; p <= total; p++) {
      if (!pages[p]) continue;
      if (p > 1) pdf.addPage([w, h], orient);
      pdf.addImage(pages[p], 'PNG', 0, 0, w, h);
    }

    const base64 = pdf.output('datauristring').split(',')[1];

    let title = (document.title || 'bookroll').replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!title) title = 'bookroll';
    const filename = title + '.pdf';

    report(100, '完了');
    return { base64, pages: total, filename };
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    return { error: errorMsg };
  }
}
