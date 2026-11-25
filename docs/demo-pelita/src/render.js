const {chromium}=require('/usr/local/lib/pnpm/5/.pnpm/playwright-core@1.59.1/node_modules/playwright-core');
const path=require('path');const R=path.join(__dirname,'..');
(async()=>{const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--allow-file-access-from-files']});
const c=await b.newContext({viewport:{width:1440,height:900},deviceScaleFactor:2});const p=await c.newPage();
const fs=['00-storefront','01-gap-proposal','02-approval-1','03-supplier-stock-check','04-listing-promo-draft','05-approval-2','06-published','07-audit-timeline'];
for(const f of fs){await p.goto('file://'+__dirname+'/html/'+f+'.html');await p.evaluate(()=>document.fonts.ready);await p.waitForTimeout(100);
const r=await p.evaluate(()=>{const o=[];const H=900;document.querySelectorAll('body *').forEach(el=>{const b=el.getBoundingClientRect();if(b.bottom>H+0.5&&getComputedStyle(el).position!=='fixed'&&b.height>0)o.push('below:'+el.className+':'+Math.round(b.bottom));if(el.scrollWidth>el.clientWidth+1&&el.clientWidth>0&&!(el instanceof SVGElement))o.push('hx:'+el.className+':'+(el.textContent||'').slice(0,30));const fsz=parseFloat(getComputedStyle(el).fontSize);if(el.childNodes.length&&[...el.childNodes].some(n=>n.nodeType==3&&n.textContent.trim())&&fsz<16)o.push('small:'+fsz+':'+el.textContent.slice(0,20))});return [...new Set(o)].slice(0,12).concat(document.fonts.check('18px Figtree')?[]:['NOFONT'])});
console.log(f,r.join(' | '));await p.screenshot({path:R+'/'+f+'.png'});}
const c2=await b.newContext({viewport:{width:1840,height:1340},deviceScaleFactor:2});const p2=await c2.newPage();await p2.goto('file://'+__dirname+'/html/overview.html');await p2.waitForTimeout(600);await p2.screenshot({path:R+'/overview.png'});
await b.close();})();
