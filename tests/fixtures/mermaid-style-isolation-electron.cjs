const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');

const output = path.resolve(process.argv[2]);
const root = path.resolve(__dirname, '../..');
const userData = path.join(output, 'user-data');
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.on('window-all-closed', () => {});
const report = { electron: process.versions.electron, platform: process.platform, pid: process.pid, cases: [] };
fs.writeFileSync(path.join(output, 'started.json'), JSON.stringify(report, null, 2));
let window;
let finished = false;
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (error) { report.error = String(error.stack || error); process.stderr.write(`${report.error}\n`); }
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(report, null, 2));
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(error ? 1 : 0);
}
const watchdog = setTimeout(() => finish(new Error('Mermaid isolation fixture timed out')), 30_000);
process.on('uncaughtException', finish);
process.on('unhandledRejection', finish);

app.whenReady().then(async () => {
  const csp = pathToFileURL(path.join(root, 'desktop/src/modules/connection-csp.js')).href;
  fs.writeFileSync(path.join(output, 'fixture.html'), `<!doctype html><html><head><script src="${csp}"></script><style>
    @keyframes hana-pulse {from{opacity:1}to{opacity:1}}
    #outside {animation:hana-pulse 1s infinite}
    .mermaid-diagram {width:380px;overflow-x:auto}
  </style></head><body><div id="outside">Synthetic outside status</div><main id="diagrams"></main><script src="renderer.js"></script></body></html>`);
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.webContents.on('console-message', event => {
    if (event.level === 'error') process.stderr.write(`${event.message}\n`);
  });
  // All inputs and assets are local; reject unexpected network activity.
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !/^(file:|data:|about:)/.test(details.url) });
  });
  await window.loadFile(path.join(output, 'fixture.html'));
  await window.webContents.executeJavaScript(`
    window.fixture = {
      svg(diagram) { return diagram.querySelector('.mermaid-svg')?.shadowRoot?.querySelector('svg') || diagram.querySelector('.mermaid-rendered svg'); },
      create(source) {
        const diagram = document.createElement('div'); diagram.className = 'mermaid-diagram';
        const pre = document.createElement('pre'); pre.className = 'mermaid-source';
        const code = pre.appendChild(document.createElement('code')); code.textContent = source;
        diagram.appendChild(pre); document.querySelector('#diagrams').appendChild(diagram); return diagram;
      },
      async settle() { await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); },
      outside() { const node = document.querySelector('#outside'); return { opacity: getComputedStyle(node).opacity, frames: node.getAnimations()[0].effect.getKeyframes().map(frame => frame.opacity) }; }
    };
    undefined;
  `);
  const keyframes = '@keyframes hana-pulse {from{opacity:0}to{opacity:0}}';
  const cases = [
    ['themeCSS', `%%{init: ${JSON.stringify({ themeCSS: keyframes })}}%%\nflowchart LR\nA-->B`],
    ['fontFamily', `%%{init: ${JSON.stringify({ fontFamily: `x;${keyframes}` })}}%%\nflowchart LR\nA-->B`],
    ['frontmatter', `---\nconfig:\n  themeCSS: '${keyframes}'\n---\nflowchart LR\nA-->B`],
    ['secure-config', `%%{init: ${JSON.stringify({ securityLevel: 'loose', secure: [], themeCSS: keyframes })}}%%\nflowchart LR\nA-->B`],
    ['normal-animated', 'flowchart LR\nA[开始] e1@--> B[完成]\ne1@{ animate: true }'],
    ['state', 'stateDiagram-v2\n[*] --> Ready\nReady --> Done'],
    ['gantt', 'gantt\ndateFormat YYYY-MM-DD\nsection Local\nTask :a1, 2026-10-01, 2d'],
    ['sequence', 'sequenceDiagram\nAlice->>Bob: Hello'],
  ];
  for (const [name, source] of cases) {
    const result = await window.webContents.executeJavaScript(`(async () => {
      const {create,svg,settle,outside}=window.fixture;
      const diagram=create(${JSON.stringify(source)});const samples=[outside()];
      const observer=new MutationObserver(()=>samples.push(outside()));
      observer.observe(document.body,{childList:true,subtree:true});
      try { await window.mermaidRenderer.renderMermaidDiagrams(document.querySelector('#diagrams')); await settle(); }
      finally { samples.push(outside());observer.disconnect(); }
      const image=svg(diagram);const rect=image?.getBoundingClientRect();
      const labels=image?.cloneNode(true);labels?.querySelectorAll('style').forEach(style=>style.remove());
      return {status:diagram.dataset.mermaidStatus,samples,shadow:!!diagram.querySelector('.mermaid-svg')?.shadowRoot,lightSvg:!!diagram.querySelector('.mermaid-rendered svg'),iframes:document.querySelectorAll('iframe').length,text:labels?.textContent,svg:image?.outerHTML,width:rect?.width,height:rect?.height,actorLabels:image?Array.from(image.querySelectorAll('text.actor')).map(node=>({text:node.textContent,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height})):[],animationNames:image?Array.from(image.querySelectorAll('.edge-animation-normal,.edge-animation-fast,.edge-animation-slow')).map(node=>getComputedStyle(node).animationName):[]};
    })()`);
    const { svg, ...summary } = result;
    const svgPath = path.join(output, `${name}.svg`);
    fs.writeFileSync(svgPath, svg || '');
    report.cases.push({ name, ...summary, svgPath });
    assert.equal(result.status, 'rendered', `${name}: diagram must render`);
    for (const sample of result.samples) {
      assert.equal(sample.opacity, '1', `${name}: outside opacity changed`);
      assert.deepEqual(sample.frames, ['1', '1'], `${name}: outside keyframes changed`);
    }
    assert(result.shadow && !result.lightSvg, `${name}: SVG must remain inside its own style boundary`);
    assert.equal(result.iframes, 0, `${name}: temporary rendering frames must be removed`);
    assert(result.width > 0 && result.width <= 380 && result.height > 0, `${name}: responsive SVG must remain visible`);
    if (name === 'normal-animated') {
      assert(result.text.includes('开始') && result.text.includes('完成'));
      assert(result.animationNames.some(value => value !== 'none'), 'Legitimate edge animation must remain active');
    }
    if (name === 'sequence') {
      assert(result.text.includes('Alice') && result.text.includes('Bob'), 'Sequence actor labels must remain present');
      for (const label of ['Alice', 'Bob']) {
        assert(result.actorLabels.some(actor => actor.text === label && actor.width > 0 && actor.height > 0), `${label}: actor label must have visible geometry`);
      }
    }
  }
  const behavior = await window.webContents.executeJavaScript(`(async () => {
    const {create,svg,settle,outside}=window.fixture;
    const diagram=create(${JSON.stringify('flowchart LR\nA[Before]-->B')});
    const container=document.querySelector('#diagrams');
    await window.mermaidRenderer.renderMermaidDiagrams(container);
    const first=svg(diagram);await window.mermaidRenderer.renderMermaidDiagrams(container);
    const reused=svg(diagram)===first;
    let editEvents=0;diagram.addEventListener('mousedown',()=>editEvents++);
    first.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,composed:true}));
    const toggle=diagram.querySelector('.mermaid-source-toggle');toggle.click();
    const sourceVisible=!diagram.querySelector('.mermaid-source').hidden;toggle.click();
    const sourceHidden=diagram.querySelector('.mermaid-source').hidden;
    diagram.querySelector('code').textContent=${JSON.stringify('flowchart LR\nA[After]-->B')};
    await window.mermaidRenderer.renderMermaidDiagrams(container);
    const rerendered=svg(diagram)!==first&&svg(diagram).textContent.includes('After');
    diagram.querySelector('code').textContent='graph Nope';
    await window.mermaidRenderer.renderMermaidDiagrams(container);await settle();
    return {reused,editEvents,sourceVisible,sourceHidden,rerendered,error:diagram.dataset.mermaidStatus==='error',errorVisible:diagram.querySelector('.mermaid-rendered').textContent.includes('failed to render'),errorSourceVisible:!diagram.querySelector('.mermaid-source').hidden,staleSvg:!!svg(diagram),iframes:document.querySelectorAll('iframe').length,outside:outside()};
  })()`);
  report.cases.push({ name: 'editing-and-errors', ...behavior });
  for (const field of ['reused','sourceVisible','sourceHidden','rerendered','error','errorVisible','errorSourceVisible']) assert(behavior[field], field);
  assert.equal(behavior.editEvents, 1);
  assert.equal(behavior.staleSvg, false);
  assert.equal(behavior.iframes, 0);
  assert.equal(behavior.outside.opacity, '1');
  finish();
}).catch(finish);
