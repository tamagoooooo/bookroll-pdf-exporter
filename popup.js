"use strict";
const exportBtn = document.getElementById('export');
const statusEl = document.getElementById('status');
const bar = document.getElementById('bar');
function setStatus(msg) {
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
    const onMsg = (m) => {
        if (m.type === 'progress') {
            bar.value = m.value;
            setStatus(m.text);
        }
    };
    chrome.runtime.onMessage.addListener(onMsg);
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['jspdf.umd.min.js']
        });
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: capturePagesAndBuildPdf
        });
        const result = results[0]?.result;
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
    }
    catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        setStatus('エラー: ' + errorMsg);
    }
    finally {
        chrome.runtime.onMessage.removeListener(onMsg);
        exportBtn.disabled = false;
    }
});
async function capturePagesAndBuildPdf() {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const appElement = document.querySelector("#app");
    if (!appElement || !appElement.__vue__) {
        return { error: 'Vue インスタンスが見つかりません。' };
    }
    function getCanvas() {
        const byClass = document.querySelector('canvas.material-canvas') ||
            document.querySelector('.material-canvas canvas');
        if (byClass)
            return byClass;
        const list = [...document.querySelectorAll('canvas')]
            .filter((c) => {
            const canvas = c;
            return canvas.width > 0 && canvas.height > 0;
        })
            .sort((a, b) => {
            const canvasA = a;
            const canvasB = b;
            return (canvasB.width * canvasB.height) - (canvasA.width * canvasA.height);
        });
        return list[0] || null;
    }
    function totalPages() {
        const m = document.body.innerText.match(/\d+\s*\/\s*(\d+)/);
        return m ? parseInt(m[1], 10) : null;
    }
    function pageNum() {
        const m = document.body.innerText.match(/(\d+)\s*\/\s*\d+/);
        return m ? parseInt(m[1], 10) : null;
    }
    function report(value, text) {
        try {
            chrome.runtime.sendMessage({ type: 'progress', value, text });
        }
        catch (e) {
            // Ignore errors
        }
    }
    async function waitStable() {
        let last = null;
        for (let i = 0; i < 25; i++) {
            await sleep(300);
            const canvas = getCanvas();
            if (!canvas)
                return;
            const len = canvas.toDataURL('image/png').length;
            if (len === last)
                return;
            last = len;
        }
    }
    try {
        const jsPdfWindow = window;
        if (!jsPdfWindow.jspdf || !jsPdfWindow.jspdf.jsPDF) {
            return { error: 'jsPDFが読み込まれていません。' };
        }
        const total = totalPages();
        if (!total) {
            return { error: 'ページ数を取得できませんでした。BookRollの閲覧画面で実行してください。' };
        }
        const nextBtn = document.querySelector('.next-btn');
        const prevBtn = (document.querySelector('.back-btn') ||
            document.querySelector('.prev-btn'));
        if (!nextBtn) {
            return { error: '「次へ」ボタンが見つかりませんでした。' };
        }
        let guard = 0;
        while (pageNum() !== 1 && prevBtn && guard < total + 5) {
            prevBtn.click();
            await sleep(800);
            guard++;
        }
        const pages = {};
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
        const sizeOf = (dataUrl) => new Promise(res => {
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
            if (!pages[p])
                continue;
            if (p > 1)
                pdf.addPage([w, h], orient);
            pdf.addImage(pages[p], 'PNG', 0, 0, w, h);
        }
        const base64 = pdf.output('datauristring').split(',')[1];
        let title = (document.title || 'bookroll').replace(/[\\/:*?"<>|]/g, '_').trim();
        if (!title)
            title = 'bookroll';
        const filename = title + '.pdf';
        report(100, '完了');
        return { base64, pages: total, filename };
    }
    catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        return { error: errorMsg };
    }
}
