"use strict";
const exportBtn = document.getElementById('export');
const exportTextBtn = document.getElementById('export-text');
const statusEl = document.getElementById('status');
const bar = document.getElementById('bar');
function setStatus(msg) {
    statusEl.textContent = msg;
}
// MAIN world で一度だけ実行し、Vue ストアの textInfo を DOM ノードへ継続的にミラーする。
// textInfo はページを表示するたびに遅延更新されるため、開始時の一括取得では
// 未表示ページのデータが欠ける。そこでストアの変更ごとに最新値を DOM に書き出し、
// ISOLATED world のキャプチャループから毎回読み取れるようにする
// （__vue__ は MAIN world でしか見えないが、DOM の textContent は world 間で共有される）。
function installTextInfoBridge() {
    const appElement = document.querySelector("#app");
    if (!appElement || !appElement.__vue__) {
        return { error: 'Vue インスタンスが見つかりません。' };
    }
    const store = appElement.__vue__.$root?.$store;
    if (!store?.state?.ContentsModule) {
        return { error: 'ContentsModuleが見つかりません。' };
    }
    const BRIDGE_ID = '__bookroll_textinfo_bridge__';
    let node = document.getElementById(BRIDGE_ID);
    if (!node) {
        node = document.createElement('script');
        node.id = BRIDGE_ID;
        node.type = 'application/json'; // 実行されず描画もされない入れ物
        document.documentElement.appendChild(node);
    }
    const dump = () => {
        try {
            node.textContent = JSON.stringify(store.state?.ContentsModule?.textInfo ?? []);
        }
        catch (e) {
            // シリアライズ失敗は無視
        }
    };
    dump();
    // Vuex の変更ごとに更新。subscribe が無ければポーリングでフォールバック。
    if (typeof store.subscribe === 'function') {
        store.subscribe(dump);
    }
    else {
        setInterval(dump, 200);
    }
    return {};
}
// 拡張機能に同梱したフォントを取得し、jsPDF が要求する base64 文字列に変換する。
async function loadFontBase64(path) {
    const url = chrome.runtime.getURL(path);
    const buf = await fetch(url).then(r => r.arrayBuffer());
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
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
        // __vue__ の textInfo を DOM へミラーする橋渡しを MAIN world で仕込む。
        // 以降、キャプチャループはページ切り替えのたびに最新の textInfo を読み取れる。
        const bridgeRes = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: installTextInfoBridge
        });
        const bridge = bridgeRes[0]?.result;
        if (!bridge || bridge.error) {
            setStatus('エラー: ' + (bridge?.error ?? 'textInfoの橋渡しに失敗しました。'));
            return;
        }
        // 日本語テキストレイヤー用のフォントを拡張機能側で読み込み、
        // base64 にしてページ内の関数へ渡す（ページ側のURL/world制約を回避するため）。
        const fontBase64 = await loadFontBase64('fonts/NotoSansJP.ttf');
        // ここからは進捗通知（chrome.runtime）が必要なので ISOLATED world で実行する。
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: capturePagesAndBuildPdf,
            args: [fontBase64]
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
// MAIN world で実行し、Vuex ストアの ContentsModule.textAsString を読み取る。
// textAsString は list[string]（index = ページ番号 - 1）で、各ページの本文が入っている。
// __vue__ は MAIN world でしか見えないため、この関数は world: 'MAIN' で実行する必要がある。
function extractTextAsString() {
    const appElement = document.querySelector("#app");
    if (!appElement || !appElement.__vue__) {
        return { error: 'Vue インスタンスが見つかりません。' };
    }
    const store = appElement.__vue__.$root?.$store;
    if (!store?.state?.ContentsModule) {
        return { error: 'ContentsModuleが見つかりません。' };
    }
    const textAsString = store.state.ContentsModule.textAsString;
    if (!Array.isArray(textAsString)) {
        return { error: 'テキスト情報（textAsString）が見つかりません。' };
    }
    // ページ区切りを付けて全ページを1つの文字列に連結する（index + 1 = ページ番号）。
    const text = textAsString
        .map((t, i) => `===== ${i + 1} ページ =====\n${(t ?? '').toString()}`)
        .join('\n\n');
    return { text, pages: textAsString.length };
}
exportTextBtn.addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab.url || !tab.url.includes('bookroll.let.media.kyoto-u.ac.jp')) {
        setStatus('BookRollのページで実行してください。');
        return;
    }
    exportBtn.disabled = true;
    exportTextBtn.disabled = true;
    setStatus('テキスト情報を抽出中...');
    try {
        // __vue__ を参照するため MAIN world で実行する。
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'MAIN',
            func: extractTextAsString
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
        if (result.text === undefined) {
            setStatus('エラー: テキストの抽出に失敗しました。');
            return;
        }
        let title = (tab.title || 'bookroll').replace(/[\\/:*?"<>|]/g, '_').trim();
        if (!title)
            title = 'bookroll';
        const filename = title + '.txt';
        const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(result.text);
        await chrome.downloads.download({
            url: dataUrl,
            filename,
            saveAs: true
        });
        setStatus(`完了: ${result.pages}ページのテキストを書き出しました。`);
    }
    catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        setStatus('エラー: ' + errorMsg);
    }
    finally {
        exportBtn.disabled = false;
        exportTextBtn.disabled = false;
    }
});
async function capturePagesAndBuildPdf(fontBase64) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // installTextInfoBridge が DOM へ書き出した最新の textInfo を読み取る。
    // ストアはページ表示ごとに更新されるため、ループ内で毎回呼んで最新値を得る。
    function readTextInfo() {
        const node = document.getElementById('__bookroll_textinfo_bridge__');
        if (!node || !node.textContent)
            return [];
        try {
            return JSON.parse(node.textContent);
        }
        catch (e) {
            return [];
        }
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
                // 現在表示中ページの最新 textInfo を毎回読み取る。
                const texts = readTextInfo()[cur - 1] || [];
                if (texts.length !== 0 && texts[texts.length - 1].top == 0) {
                    p--;
                    report(Math.round((p / total) * 80), `取得中 ${p}/${total} ページ:テキスト情報を待機 ...`);
                    await sleep(500);
                    continue;
                }
                pages[cur] = {
                    data: canvas.toDataURL('image/png'),
                    texts
                };
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
        const first = await sizeOf(pages[1].data);
        const w = first.w;
        const h = first.h;
        const orient = w >= h ? 'landscape' : 'portrait';
        const { jsPDF } = jsPdfWindow.jspdf;
        const pdf = new jsPDF({ orientation: orient, unit: 'px', format: [w, h], compress: true });
        // 日本語（CJK）を検索可能にするためフォントを登録する。
        // jsPDF の標準フォントは日本語非対応なので、同梱フォントを VFS に登録して使う。
        // 失敗した場合は標準フォントにフォールバックする（英数字のみ有効）。
        if (fontBase64) {
            try {
                pdf.addFileToVFS('NotoSansJP.ttf', fontBase64);
                pdf.addFont('NotoSansJP.ttf', 'NotoSansJP', 'normal');
                pdf.setFont('NotoSansJP');
            }
            catch (e) {
                // フォント登録失敗時は標準フォントのまま継続
            }
        }
        for (let p = 1; p <= total; p++) {
            if (!pages[p])
                continue;
            if (p > 1)
                pdf.addPage([w, h], orient);
            pdf.addImage(pages[p].data, 'PNG', 0, 0, w, h);
            // textInfo の位置情報を元に無色（透明）文字を埋め込む。
            // renderingMode 'invisible' は塗り・線ともに描画しないが、
            // テキストデータは PDF に残るため検索・コピーが可能になる（OCRレイヤー相当）。
            const texts = pages[p].texts;
            for (const t of texts) {
                if (!t.text)
                    continue;
                // 位置は 0~1 の割合だが、BookRoll は縦横とも「幅 w」を基準に正規化している。
                // そのため縦方向も h ではなく w を掛けて実寸（px）に変換する。
                const boxH = (t.bottom - t.top) * w;
                if (boxH <= 0)
                    continue;
                const x = t.left * w;
                const y = t.bottom * w; // ベースラインを文字ボックスの下端に合わせる
                pdf.setFontSize(boxH);
                try {
                    pdf.text(t.text, x, y, {
                        renderingMode: 'invisible',
                        baseline: 'alphabetic'
                    });
                }
                catch (e) {
                    // 1文字単位の埋め込み失敗は無視して処理を継続する
                }
            }
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
