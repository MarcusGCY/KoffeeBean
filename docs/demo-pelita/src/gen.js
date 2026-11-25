const fs=require('fs'),path=require('path');const A=require('./art');
const OUT=path.join(__dirname,'html');fs.mkdirSync(OUT,{recursive:true});
const MARK=(s=48)=>`<svg viewBox="0 0 72 80" width="${s*0.9}" height="${s}" aria-hidden="true"><rect x="0" y="4" width="72" height="72" rx="20" fill="#B5195B"/><path d="M28 16 h16 a4 4 0 0 1 4 4 v12 h12 a4 4 0 0 1 4 4 v16 a4 4 0 0 1 -4 4 h-12 v12 a4 4 0 0 1 -4 4 h-16 a4 4 0 0 1 -4 -4 v-12 h-12 a4 4 0 0 1 -4 -4 v-16 a4 4 0 0 1 4 -4 h12 v-12 a4 4 0 0 1 4 -4z" fill="#fff"/><path d="M36 27 C44 36 46 43 42 49 C40 52 38 53 36 53 C34 53 32 52 30 49 C26 43 28 36 36 27Z" fill="#FFC93C"/><path d="M36 38 C39 42 39 46 37 48.5 C36.4 49.2 35.6 49.2 35 48.5 C33 46 33 42 36 38Z" fill="#B5195B"/></svg>`;
const MARKW=`<svg viewBox="0 0 72 80" width="46" height="51" aria-hidden="true"><rect x="0" y="4" width="72" height="72" rx="20" fill="#fff"/><path d="M28 16 h16 a4 4 0 0 1 4 4 v12 h12 a4 4 0 0 1 4 4 v16 a4 4 0 0 1 -4 4 h-12 v12 a4 4 0 0 1 -4 4 h-16 a4 4 0 0 1 -4 -4 v-12 h-12 a4 4 0 0 1 -4 -4 v-16 a4 4 0 0 1 4 -4 h12 v-12 a4 4 0 0 1 4 -4z" fill="#B5195B"/><path d="M36 27 C44 36 46 43 42 49 C40 52 38 53 36 53 C34 53 32 52 30 49 C26 43 28 36 36 27Z" fill="#FFC93C"/><path d="M36 38 C39 42 39 46 37 48.5 C36.4 49.2 35.6 49.2 35 48.5 C33 46 33 42 36 38Z" fill="#fff"/></svg>`;
const brand=`<div class="brand">${MARK()}<div><div class="bw">Pelita</div><div class="bm">HEALTH &amp; BEAUTY</div></div></div>`;
const brandW=`<div class="brand">${MARKW}<div><div class="bw" style="color:#fff">Pelita</div><div class="bm" style="color:#FFE7A3">HEALTH &amp; BEAUTY</div></div></div>`;
const AG=(s=28)=>`<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#5B3FD1"/><path d="M12 4.5 L13.7 10.3 L19.5 12 L13.7 13.7 L12 19.5 L10.3 13.7 L4.5 12 L10.3 10.3Z" fill="#fff"/></svg>`;
const HU=(s=28)=>`<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#1E3A8A"/><circle cx="10.5" cy="8.6" r="3.2" fill="#fff"/><path d="M4.6 18.2 C5.4 14.4 7.6 12.9 10.5 12.9 C12 12.9 13.3 13.3 14.3 14.1" fill="#fff"/><path d="M14.2 16.6 L16.2 18.6 L20 14.6" stroke="#fff" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const SYS=(s=28)=>`<svg class="ico" width="${s}" height="${s}" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#047857"/><path d="M7 12.5 L10.5 16 L17 8.5" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const TICK=(c='#065F46',s=20)=>`<svg width="${s}" height="${s}" viewBox="0 0 24 24"><path d="M5 12.5 L10 17 L19 7" stroke="${c}" stroke-width="3.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const demo=`<span class="demo">DEMO DATA</span>`;
const CSS=`
:root{--primary:#B5195B;--primary-d:#8C1046;--primary-50:#FCE7EF;--promo:#FFC93C;--promo-50:#FFF6D6;--promo-t:#8A4B00;--agent:#5B3FD1;--agent-50:#F0EDFF;--human:#1E3A8A;--human-50:#EAF0FF;--ok:#047857;--ok-t:#065F46;--ok-50:#E3F4EC;--warn-t:#B45309;--ink:#0F172A;--ink2:#334155;--ink3:#475569;--line:#CBD5E1;--line2:#E2E8F0;--bg:#FBF6F2;--card:#fff}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:1440px;height:900px;overflow:hidden}
body{font-family:Figtree,system-ui,sans-serif;background:var(--bg);color:var(--ink);font-size:18px;line-height:1.5;font-weight:500;-webkit-font-smoothing:antialiased}
.brand{display:flex;align-items:center;gap:12px}.bw{font-size:30px;font-weight:800;letter-spacing:-.6px;line-height:1}.bm{font-size:12px;font-weight:800;letter-spacing:2.6px;color:var(--primary);margin-top:5px}
.demo{display:inline-flex;align-items:center;font-size:18px;font-weight:800;letter-spacing:.6px;color:var(--ink);background:#fff;border:2px dashed var(--ink);border-radius:8px;padding:3px 12px;white-space:nowrap}
.ico{flex:none;display:inline-block;vertical-align:middle}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;height:56px;padding:0 28px;border-radius:12px;font:700 20px Figtree;border:2px solid transparent;white-space:nowrap}
.btn.p{background:var(--primary);color:#fff}.btn.h{background:var(--human);color:#fff}.btn.s{background:#fff;color:var(--ink);border-color:var(--line)}.btn.g{background:transparent;color:var(--ink2);text-decoration:underline;text-underline-offset:4px}
.pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;font-weight:700;font-size:18px;padding:4px 14px;white-space:nowrap}
.pill.ag{background:var(--agent-50);color:var(--agent)}.pill.hu{background:var(--human-50);color:var(--human)}.pill.ok{background:var(--ok-50);color:var(--ok-t)}.pill.new{background:var(--primary);color:#fff}.pill.best{background:var(--ink);color:#fff}
/* storefront */
.util{height:40px;background:var(--primary-d);color:#fff;display:flex;align-items:center;justify-content:space-between;padding:0 56px;font-size:18px;font-weight:600}
.util span+span:before{content:'·';margin:0 14px;color:#F9A8C9}
.hdr{height:92px;background:var(--primary);display:flex;align-items:center;gap:28px;padding:0 56px}
.search{flex:1;height:56px;background:#fff;border-radius:999px;display:flex;align-items:center;gap:14px;padding:0 24px;font-size:20px;color:var(--ink3)}
.search b{color:var(--ink);font-weight:600}
.hico{display:flex;align-items:center;gap:8px;color:#fff;font-weight:700}
.cart{background:#fff;color:var(--primary-d);border-radius:999px;height:52px;padding:0 20px;display:flex;align-items:center;gap:10px;font-weight:800}
.nav{height:60px;background:#fff;border-bottom:1px solid var(--line2);display:flex;align-items:center;gap:6px;padding:0 56px}
.nav a{font-size:18px;font-weight:700;color:var(--ink);padding:8px 12px;border-radius:999px;white-space:nowrap}
.nav a.off{background:var(--promo);color:var(--ink);padding:8px 18px}
.nav a.cur{background:var(--primary-50);color:var(--primary-d)}
.wrap{padding:0 56px}
.h2{font-size:28px;font-weight:800;letter-spacing:-.3px;display:flex;align-items:center;gap:16px}
.h2 .more{margin-left:auto;font-size:18px;font-weight:700;color:var(--primary-d)}
.cd{display:flex;gap:6px;align-items:center;font-size:18px;font-weight:700;color:var(--ink2)}.cd b{background:var(--ink);color:#fff;border-radius:8px;padding:2px 10px;font-variant-numeric:tabular-nums}
.grid{display:grid;gap:22px;margin-top:14px}
.pc{background:#fff;border:1px solid var(--line2);border-radius:18px;padding:14px;display:flex;flex-direction:column;position:relative}
.pc .img{height:var(--imgh,128px);border-radius:12px;background:#F8F5F2;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden}
.pc .img svg{height:calc(var(--imgh,128px) - 30px);width:calc(var(--imgh,128px) - 30px);margin-bottom:22px}
.pc .tag{position:absolute;top:8px;left:8px}.pc .tag .pill{font-size:16px;padding:2px 10px}
.pc .heart{position:absolute;top:8px;right:8px;width:36px;height:36px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center}
.pc .rib{position:absolute;left:0;right:0;bottom:0;height:32px;background:var(--promo);color:var(--ink);font-weight:800;font-size:18px;display:flex;align-items:center;padding:0 12px}
.pc .nm{font-size:20px;font-weight:700;margin-top:10px;line-height:1.25}
.pc .sz{color:var(--ink3);font-size:18px}
.pc .pr{display:flex;align-items:flex-end;justify-content:space-between;margin-top:4px}
.pc .price{font-size:30px;font-weight:800;letter-spacing:-.5px;line-height:1.1}.pc .price.sale{color:var(--primary)}
.pc .was{display:block;font-size:18px;color:var(--ink3);text-decoration:line-through;font-weight:600;letter-spacing:0;line-height:1.3}
.pc .mem{display:inline-flex;margin-top:6px;font-size:18px;font-weight:700;color:var(--primary-d);background:var(--primary-50);border-radius:8px;padding:1px 10px;align-self:flex-start}
.pc .add{width:50px;height:50px;border-radius:12px;background:var(--primary);display:flex;align-items:center;justify-content:center;flex:none}
.pc .add.off{background:#E2E8F0}
.pc .st{font-size:18px;font-weight:700;margin-top:6px;display:flex;align-items:center;gap:8px}
.st:before{content:'';width:10px;height:10px;border-radius:50%;background:currentColor}
.st.in{color:var(--ok-t)}.st.low{color:var(--warn-t)}.st.out{color:var(--ink3)}
.promo-t{color:var(--promo-t);font-weight:700;font-size:18px}
/* ops */
.ops{height:80px;background:#fff;border-bottom:1px solid var(--line2);display:flex;align-items:center;gap:20px;padding:0 48px}
.ops .sep{width:2px;height:36px;background:var(--line2)}.ops .ttl{font-size:20px;font-weight:700;color:var(--ink2)}.ops .sp{flex:1}
.who{display:flex;align-items:center;gap:12px;font-weight:700}
.av{width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:17px;background:var(--human)}
.rail{display:flex;gap:8px;padding:18px 48px 0}
.rs{flex:1;display:flex;align-items:center;gap:10px;font-size:17px;font-weight:700;color:var(--ink3);padding:10px 12px;border-radius:12px;background:#fff;border:1px solid var(--line2);white-space:nowrap}
.rs .n{width:30px;height:30px;border-radius:50%;background:#E2E8F0;color:var(--ink2);display:flex;align-items:center;justify-content:center;font-size:16px;flex:none}
.rs.done{color:var(--ink2)}.rs.done .n{background:var(--ok-50);color:var(--ok-t)}
.rs.cur{border:2px solid var(--ink);color:var(--ink)}.rs.cur .n{background:var(--ink);color:#fff}
.rs.cur.a{border-color:var(--agent)}.rs.cur.a .n{background:var(--agent)}.rs.cur.h{border-color:var(--human)}.rs.cur.h .n{background:var(--human)}
.main{padding:24px 48px}
.card{background:#fff;border:1px solid var(--line2);border-radius:20px;padding:32px}
.card.agent{border:2px solid #C9BEF5;box-shadow:inset 8px 0 0 var(--agent)}
.card.human{border:2px solid #A9BDEB;box-shadow:inset 8px 0 0 var(--human)}
.kick{display:flex;align-items:center;gap:12px;font-weight:800;font-size:18px;letter-spacing:.2px}.kick.a{color:var(--agent)}.kick.h{color:var(--human)}
.h1{font-size:36px;font-weight:800;letter-spacing:-.6px;line-height:1.2}.sub{font-size:20px;color:var(--ink2)}
.stat{background:#F8FAFC;border:1px solid var(--line2);border-radius:16px;padding:20px 24px}
.stat .v{font-size:40px;font-weight:800;letter-spacing:-1px;line-height:1.1}.stat .l{font-size:18px;color:var(--ink2);font-weight:600;margin-top:4px}
.src{font-size:18px;color:var(--ink3);font-weight:600;display:flex;align-items:center;gap:8px}.src b{color:var(--ink2)}
.kv{display:grid;grid-template-columns:auto 1fr;gap:14px 28px;font-size:20px}.kv dt{color:var(--ink3);font-weight:600}.kv dd{font-weight:700}
.row{display:flex;gap:16px;align-items:center}
.dim{position:fixed;inset:0;background:rgba(15,23,42,.55)}
.modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:780px;background:#fff;border-radius:24px;padding:36px 40px;box-shadow:0 30px 80px rgba(0,0,0,.35)}
.chk{display:flex;align-items:center;gap:14px;font-size:20px;font-weight:600}
.box{width:30px;height:30px;border-radius:8px;background:var(--human);display:flex;align-items:center;justify-content:center;flex:none}
.toast{position:fixed;top:206px;right:56px;width:540px;background:#fff;border:2px solid #7CC4A4;border-radius:18px;padding:20px 24px;box-shadow:0 18px 50px rgba(15,23,42,.2);display:flex;gap:16px}
.comp{display:flex;align-items:center;gap:14px;background:var(--ok-50);border:2px solid #9AD3B8;border-radius:14px;padding:12px 18px}
`;
const page=(t,body)=>`<!doctype html><html><head><meta charset="utf-8"><title>${t}</title><style>${CSS}</style></head><body>${body}</body></html>`;
const S=()=>`<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="2.4" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20 L16 16"/></svg>`;
const BOX=`<span class="box">${TICK('#fff')}</span>`;
const CARTI=(c)=>`<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="${c}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h2l2.4 11h11l2-8H6.2"/><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/></svg>`;
const HEART=`<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#B5195B" stroke-width="2.4"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"/></svg>`;
const CATS=['Health &amp; pharmacy','Vitamins &amp; supplements','Skincare','Hair care','Personal care','Baby &amp; mum','Cosmetics','Wellness'];
const header=(cur)=>`<div class="util"><div><span>Free delivery above S$50</span><span>Pick up in store today</span></div><div><span>Ask a pharmacist</span><span>Find a store</span></div></div>
<div class="hdr">${brandW}<div class="search">${S()}Search vitamins, skincare, pharmacy…</div>
<div class="hico"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2"><circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/></svg>Sign in</div>
<div class="cart">${CARTI('#8C1046')}S$0.00</div>${demo}</div>
<div class="nav"><a class="off">Offers</a>${CATS.map(c=>`<a class="${c===cur?'cur':''}">${c}</a>`).join('')}</div>`;
const card=(p)=>`<div class="pc"${p.hl?' style="border:3px solid var(--primary);box-shadow:0 10px 30px rgba(181,25,91,.18)"':''}><div class="img">${A[p.a]}${p.tag?`<div class="tag">${p.tag==='New'?'<span class="pill new">New</span>':'<span class="pill best">Bestseller</span>'}</div>`:''}<div class="heart">${HEART}</div>${p.rib?`<div class="rib">${p.rib}</div>`:''}</div>
<div class="nm">${p.n}</div><div class="sz">${p.s}</div>
<div class="pr"><div class="price${p.was?' sale':''}">S$${p.p}${p.was?`<span class="was">S$${p.was}</span>`:''}</div><div class="add${p.st==='out'?' off':''}">${CARTI(p.st==='out'?'#475569':'#fff')}</div></div>
${p.mem?`<div class="mem">Member S$${p.mem}</div>`:''}
<div class="st ${p.st}">${{in:'In stock',low:'Low stock · 4 left',out:'Out of stock'}[p.st]}</div></div>`;
const rail=(cur)=>{const L=[['Detect','a'],['Approve sourcing','h'],['Stock check','a'],['Draft listing','a'],['Approve launch','h'],['Live','s'],['Audit','s']];
return `<div class="rail">${L.map(([t,k],i)=>`<div class="rs ${i+1<cur?'done':''} ${i+1===cur?'cur '+k:''}"><span class="n">${i+1<cur?'✓':i+1}</span>${t}</div>`).join('')}</div>`};
const ops=(who)=>`<div class="ops">${brand}<div class="sep"></div><div class="ttl">Ops console · New product launch</div><div class="sp"></div>${demo}<div class="who">${who}</div></div>`;
const P1=`<div class="av">MG</div><div style="line-height:1.25">Mei Ling Goh<div style="font-size:16px;color:var(--ink3);font-weight:600">Category Manager</div></div>`;
const P2=`<div class="av">AM</div><div style="line-height:1.25">Arjun Menon<div style="font-size:16px;color:var(--ink3);font-weight:600">Head of E-commerce</div></div>`;
const F={};
// 00 storefront
F['00-storefront']=page('Storefront',`${header()}
<div class="wrap" style="padding-top:20px;display:grid;grid-template-columns:1fr 400px;gap:20px">
<div style="height:200px;border-radius:20px;background:linear-gradient(100deg,#8C1046 0%,#B5195B 70%);color:#fff;display:flex;align-items:center;padding:0 44px;gap:28px;overflow:hidden">
<div style="flex:1"><div style="font-size:18px;font-weight:700;color:#FFE7A3">Wellness Week · till Sun 29 Nov</div><div style="font-size:40px;font-weight:800;letter-spacing:-1px;line-height:1.12;margin-top:4px">Up to 25% off<br>vitamins</div><div class="btn" style="background:#fff;color:var(--primary-d);height:48px;margin-top:12px;font-size:18px">Shop the offers</div></div>
<div style="display:flex;gap:4px;align-items:flex-end">${['vitc','fishoil','vitd'].map((k,i)=>`<div style="width:${i==1?136:110}px;height:${i==1?136:110}px;background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center">${A[k].replace('<svg',`<svg width="${i==1?104:84}" height="${i==1?104:84}"`)}</div>`).join('')}</div></div>
<div style="height:200px;border-radius:20px;background:var(--promo);display:flex;align-items:center;padding:0 28px;gap:12px;overflow:hidden">
<div style="flex:1"><div style="font-size:18px;font-weight:800;color:var(--ink)">MEMBERS</div><div style="font-size:30px;font-weight:800;line-height:1.15;letter-spacing:-.5px">Extra 10% off skincare</div><div style="font-size:18px;font-weight:700;margin-top:8px;text-decoration:underline">Join free</div></div>
<div style="width:110px;height:110px;background:#fff;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none">${A.sunscreen.replace('<svg','<svg width="86" height="86"')}</div></div></div>
<div class="wrap" style="margin-top:22px"><div class="h2">Deals of the week <span class="cd">Ends in <b>2d</b><b>06h</b><b>14m</b></span><a class="more">See all</a></div>
<div class="grid" style="grid-template-columns:repeat(5,1fr)">
${card({a:'sunscreen',n:'Sunscreen fluid SPF50 PA++++',s:'50 ml',p:'22.50',rib:'2 for S$36.00',tag:'Best',st:'in'})}
${card({a:'shampoo',n:'Anti-dandruff shampoo',s:'400 ml',p:'9.90',rib:'2nd at 50% off',st:'in'})}
${card({a:'vitc',n:'Vitamin C 1000 mg',s:'60 tablets',p:'15.90',was:'19.90',rib:'-20%',st:'in'})}
${card({a:'cleanser',n:'Gentle foaming cleanser',s:'150 ml',p:'15.90',mem:'13.50',st:'low'})}
${card({a:'lipbalm',n:'Tinted lip balm, rose',s:'4.5 g',p:'7.90',st:'out'})}
</div></div>`);
// 01 gap
const spark=(()=>{const d=[88,95,102,110,118,121,135,142,150,158,171,180,196,214];const W=520,H=96,mx=230;return `<svg width="100%" height="96" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline fill="none" stroke="#5B3FD1" stroke-width="4" stroke-linejoin="round" points="${d.map((v,i)=>`${10+i*(W-20)/13},${H-v/mx*H}`).join(' ')}"/><circle cx="${W-10}" cy="${H-214/mx*H}" r="7" fill="#5B3FD1"/></svg>`})();
const gap=(st=1)=>`${ops(P1)}${rail(st)}<div class="main"><div class="card agent" style="padding:32px 40px">
<div class="row" style="justify-content:space-between"><div class="kick a">${AG(32)} SHELF AGENT · DEMAND-GAP PROPOSAL</div><span class="pill ag">Detected 09:02 today</span></div>
<div class="h1" style="margin-top:14px">Shoppers want magnesium glycinate. We don't sell it.</div>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr 1.25fr;gap:20px;margin-top:22px">
<div class="stat"><div class="v">2,180</div><div class="l">searches for “magnesium glycinate” in 14 days</div></div>
<div class="stat"><div class="v" style="color:#B91C1C">0</div><div class="l">matching products in stock</div></div>
<div class="stat"><div class="v">64%</div><div class="l">of those searches ended with no purchase</div></div>
<div class="stat" style="padding:16px 20px 10px"><div class="l" style="margin:0 0 4px;font-weight:700;color:var(--ink)">Searches per day</div>${spark}<div style="display:flex;justify-content:space-between;font-size:18px;color:var(--ink3);font-weight:600"><span>11 Nov</span><span>Today</span></div></div></div>
<div style="display:grid;grid-template-columns:1.2fr 1fr;gap:28px;margin-top:24px">
<div style="background:var(--agent-50);border-radius:18px;padding:22px 28px;display:flex;gap:24px;align-items:center">
<div style="width:120px;height:120px;background:#fff;border-radius:16px;display:flex;align-items:center;justify-content:center;flex:none">${A.magnesium.replace('<svg','<svg width="100" height="100"')}</div>
<div><div style="font-size:18px;font-weight:700;color:var(--agent)">PROPOSED</div><div style="font-size:28px;font-weight:800;line-height:1.2">List Magnesium Glycinate 400 mg,<br>90 capsules, at S$32.90</div><div style="font-size:18px;color:var(--ink2);margin-top:4px">Supplier: Evergreen Nutrition (local)</div></div></div>
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px">
<div class="stat"><div class="v">140</div><div class="l">units / week projected</div></div>
<div class="stat"><div class="v">39%</div><div class="l">gross margin (ex GST)</div></div>
<div class="stat"><div class="v" style="color:var(--ok-t)">High</div><div class="l">confidence · 84%</div></div></div></div>
<div class="row" style="justify-content:space-between;margin-top:26px">
<div class="src">Sources: <b>Site search logs</b> · <b>Catalogue</b> · <b>Supplier price list</b></div>
<div class="row"><div class="btn g">Reject</div><div class="btn s">Edit</div><div class="btn h">Approve…</div></div></div>
</div></div>`;
F['01-gap-proposal']=page('Gap proposal',gap(1));
F['02-approval-1']=page('Approval 1',`${gap(2)}<div class="dim"></div><div class="modal">
<div class="kick h">${HU(32)} HUMAN APPROVAL 1 OF 2</div>
<div class="h1" style="margin-top:12px">Approve sourcing?</div>
<div class="sub" style="margin-top:6px">The agent can't buy anything until you approve.</div>
<div style="background:#F8FAFC;border:1px solid var(--line2);border-radius:16px;padding:22px 26px;margin-top:22px">
<dl class="kv"><dt>Product</dt><dd>Magnesium Glycinate 400 mg · 90 caps</dd><dt>Supplier</dt><dd>Evergreen Nutrition</dd><dt>First order</dt><dd>Up to 600 units (about 4 weeks)</dd><dt>Spend limit</dt><dd style="font-size:28px;line-height:1.1">S$11,500</dd></dl></div>
<div class="row" style="margin-top:20px;justify-content:space-between"><div class="row" style="gap:12px"><div class="av" style="width:48px;height:48px">MG</div><div style="line-height:1.3"><div style="font-weight:800;font-size:20px">Mei Ling Goh</div><div style="color:var(--ink2)">Category Manager, Vitamins &amp; Supplements</div></div></div><span class="pill hu">Records as APR-2051</span></div>
<div class="chk" style="margin-top:20px">${BOX}I've checked the evidence and the spend limit.</div>
<div class="row" style="justify-content:flex-end;margin-top:26px"><div class="btn s">Cancel</div><div class="btn h">Approve sourcing</div></div></div>`);
const cell=(l,v,s,c='')=>`<div class="stat" style="${c}"><div class="l" style="margin:0 0 6px;font-weight:700;color:var(--ink2)">${l}</div><div class="v">${v}</div>${s?`<div class="l">${s}</div>`:''}</div>`;
F['03-supplier-stock-check']=page('Stock check',`${ops(P1)}${rail(3)}<div class="main"><div class="card agent" style="padding:32px 40px">
<div class="row" style="justify-content:space-between"><div class="kick a">${AG(32)} SHELF AGENT · SUPPLIER &amp; STOCK CHECK</div><span class="pill ok">${TICK('#065F46',18)}Checked just now · 09:04</span></div>
<div class="h1" style="margin-top:14px">We can sell it today. 300 units can move from our DC.</div>
<div class="sub" style="margin-top:6px">Within approval APR-2051 (spend limit S$11,500).</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:28px;margin-top:24px">
<div><div style="font-size:22px;font-weight:800;margin-bottom:12px">Supplier · Evergreen Nutrition</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">${cell('Available','6,000','units')}${cell('Lead time','3 days','to our DC')}${cell('Cost price','S$18.50','per unit, ex GST')}${cell('Minimum order','480','units (MOQ)')}</div></div>
<div><div style="font-size:22px;font-weight:800;margin-bottom:12px">Our ERP · Tuas distribution centre</div>
<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">${cell('DC stock','1,200','units, corporate wellness')}${cell('Move to online','300','units, today',"background:var(--ok-50);border-color:#9AD3B8")}
<div class="stat" style="grid-column:span 2;display:flex;justify-content:space-between;align-items:center"><div><div class="l" style="margin:0;font-weight:700;color:var(--ink2)">Purchase order drafted</div><div style="font-size:28px;font-weight:800">PO-61207 · 600 units · S$11,100</div></div><span class="pill ok">Under limit</span></div></div></div></div>
<div class="row" style="justify-content:space-between;margin-top:24px"><div class="src">Sources: <b>Supplier portal API</b> · <b>ERP (stock read, PO draft)</b></div><div class="btn p">Draft the listing →</div></div>
</div></div>`);
const fld=(l,v,big)=>`<div style="padding:10px 0;border-bottom:1px solid var(--line2)"><div style="font-size:18px;color:var(--ink3);font-weight:600">${l}</div><div style="font-size:${big||20}px;font-weight:700;line-height:1.35">${v}</div></div>`;
F['04-listing-promo-draft']=page('Listing draft',`${ops(P1)}${rail(4)}<div class="main" style="display:grid;grid-template-columns:560px 1fr;gap:28px">
<div class="card" style="padding:24px 28px"><div class="row" style="justify-content:space-between"><div style="font-weight:800;font-size:18px;color:var(--ink2)">SHOPPER PREVIEW</div><span class="pill" style="background:#F1F5F9;color:var(--ink2)">Not live yet</span></div>
<div style="height:240px;background:#F8F5F2;border-radius:16px;margin-top:14px;display:flex;align-items:center;justify-content:center;position:relative;overflow:hidden">${A.magnesium.replace('<svg','<svg width="190" height="190" style="margin-bottom:24px"')}<div style="position:absolute;top:14px;left:14px"><span class="pill new">New</span></div><div class="rib" style="position:absolute;left:0;right:0;bottom:0;height:38px;background:var(--promo);font-weight:800;font-size:20px;display:flex;align-items:center;padding:0 16px">2 for S$55.90</div></div>
<div style="font-size:26px;font-weight:800;margin-top:14px;line-height:1.2">Magnesium Glycinate 400 mg · 90 Capsules</div><div style="color:var(--ink3)">Vitamins &amp; supplements › Magnesium &amp; minerals</div>
<div class="row" style="align-items:baseline;margin-top:6px;gap:14px"><div style="font-size:36px;font-weight:800">S$32.90</div><div style="color:var(--ink3)">S$0.37 per capsule</div></div>
<div class="btn p" style="width:100%;margin-top:12px">Add to cart</div></div>
<div class="card agent" style="padding:24px 34px"><div class="kick a">${AG(32)} DRAFTED BY SHELF AGENT · REVIEW BEFORE SENDING</div>
<div style="margin-top:4px">${fld('Title','Magnesium Glycinate 400 mg · 90 Capsules',22)}${fld('Description','Gentle, well-absorbed magnesium. Supports relaxation and restful sleep. One capsule a day. Vegan.')}
<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 28px">${fld('Category','Vitamins › Magnesium &amp; minerals')}${fld('Price','S$32.90 · S$0.37/capsule',22)}${fld('Launch promo','2 for S$55.90',22)}${fld('Runs','Wed 25 Nov – Tue 8 Dec')}${fld('Online stock','300 units')}${fld('Margin at promo','28% · floor is 15%')}</div></div>
<div class="comp" style="margin-top:14px">${SYS(30)}<div style="line-height:1.35"><div style="font-weight:800;font-size:20px;color:var(--ok-t)">Claims check passed</div><div style="color:var(--ink2);font-weight:600">Supplement claims rules (demo) · 1 claim removed</div></div></div>
<div class="row" style="justify-content:flex-end;margin-top:16px"><div class="btn s">Edit</div><div class="btn p">Send for approval →</div></div></div></div>`);
const diffr=(l,v)=>`<div style="display:flex;gap:16px;align-items:center;padding:14px 0;border-bottom:1px solid var(--line2)"><span style="width:30px;height:30px;border-radius:8px;background:var(--ok-50);color:var(--ok-t);font-weight:800;display:flex;align-items:center;justify-content:center;flex:none">+</span><span style="width:170px;color:var(--ink3);font-weight:600;flex:none">${l}</span><span style="font-weight:700;font-size:20px">${v}</span></div>`;
F['05-approval-2']=page('Approval 2',`${ops(P2)}${rail(5)}<div class="main"><div class="card human" style="padding:36px 52px;max-width:1180px;margin:8px auto 0">
<div class="row" style="justify-content:space-between"><div class="kick h">${HU(32)} HUMAN APPROVAL 2 OF 2</div><span class="pill hu">Records as APR-2052</span></div>
<div class="h1" style="margin-top:10px">Approve listing and promo?</div><div class="sub">This goes live to shoppers as soon as you approve.</div>
<div style="display:grid;grid-template-columns:1fr 340px;gap:40px;margin-top:14px;align-items:start">
<div>${diffr('New product','Magnesium Glycinate 400 mg · 90 caps')}${diffr('Category','Vitamins &amp; supplements › Magnesium')}${diffr('Price','S$32.90')}${diffr('Launch promo','2 for S$55.90 · 25 Nov – 8 Dec')}${diffr('Online stock','300 units from Tuas DC')}${diffr('Claims check','Passed · CMP-0412')}</div>
<div style="display:flex;flex-direction:column;gap:12px;margin-top:14px">
<div class="stat" style="padding:14px 20px"><div class="v" style="font-size:32px">28%</div><div class="l">margin at promo, above 15% floor</div></div>
<div class="stat" style="padding:14px 20px"><div class="v" style="font-size:32px">S$3,910</div><div class="l">projected sales, week 1</div></div></div></div>
<div class="row" style="justify-content:space-between;margin-top:26px"><div class="chk">${BOX}I've reviewed the price, promo, copy and claims.</div>
<div class="row"><div class="btn s">Send back</div><div class="btn h">Approve and publish</div></div></div></div></div>`);
F['06-published']=page('Published',`<style>.pc{--imgh:150px}</style>${header('Vitamins &amp; supplements')}
<div class="wrap" style="padding-top:18px"><div style="font-size:18px;color:var(--ink3);font-weight:600">Home › Vitamins &amp; supplements</div>
<div class="row" style="justify-content:space-between;margin-top:2px"><div style="font-size:36px;font-weight:800;letter-spacing:-1px">Vitamins &amp; supplements</div></div>
<div class="row" style="gap:10px;margin-top:10px">${['All','Multivitamins','Fish oil','Magnesium &amp; minerals · 1','Gut health'].map((t,i)=>`<span class="pill" style="font-size:18px;padding:6px 18px;${i==3?'background:var(--ink);color:#fff':'background:#fff;border:2px solid var(--line);color:var(--ink)'}">${t}</span>`).join('')}</div>
<div class="grid" style="grid-template-columns:repeat(5,1fr);margin-top:18px">
${card({a:'magnesium',n:'Magnesium Glycinate 400 mg',s:'90 capsules',p:'32.90',tag:'New',rib:'2 for S$55.90',st:'in',hl:1})}
${card({a:'vitc',n:'Vitamin C 1000 mg',s:'60 tablets',p:'15.90',was:'19.90',rib:'-20%',st:'in'})}
${card({a:'fishoil',n:'Fish oil 1000 mg',s:'120 softgels',p:'28.50',mem:'25.90',st:'in'})}
${card({a:'vitd',n:'Vitamin D3 1000 IU',s:'90 softgels',p:'16.90',rib:'2 for S$29.90',st:'in'})}
${card({a:'probiotic',n:'Daily probiotic 10B',s:'30 capsules',p:'34.90',st:'low'})}
</div>
<div class="card" style="margin-top:18px;padding:16px 24px;display:flex;align-items:center;gap:20px"><div class="search" style="flex:none;width:480px;height:52px;border:2px solid var(--line)">${S()}<b>magnesium glycinate</b></div><div style="font-size:22px;font-weight:700">Before: <span style="color:#B91C1C">0 results</span> &nbsp;→&nbsp; Now: <span style="color:var(--ok-t)">1 result, in stock</span></div></div></div>
<div class="toast">${SYS(40)}<div><div style="font-size:22px;font-weight:800">Magnesium Glycinate is live</div><div style="color:var(--ink2)">Published 09:09 · approved by Arjun Menon</div><div style="color:var(--ink2)">APR-2052 · 300 units online</div></div></div>`);
const ev=[
['09:02:10','a','Shelf Agent','Spotted gap: 2,180 searches, 0 stock','Site search logs, catalogue','PRP-3184'],
['09:02:40','a','Shelf Agent','Proposed listing at S$32.90, 39% margin','Supplier price list','PRP-3184'],
['09:03:35','h','Mei Ling Goh · Category Manager','Approved sourcing, spend limit S$11,500','Ops console','APR-2051'],
['09:04:15','a','Shelf Agent','Checked supplier and DC stock','Supplier portal, ERP','—'],
['09:04:42','a','Shelf Agent','PO 600 units, S$11,100; 300 to online','ERP','PO-61207'],
['09:05:30','a','Shelf Agent','Claims check passed, 1 claim fixed','Supplement claims rules','CMP-0412'],
['09:06:20','a','Shelf Agent','Drafted listing and 2 for S$55.90 promo','Catalogue, promo rules','LST-4471'],
['09:09:05','h','Arjun Menon · Head of E-commerce','Approved listing and promo','Ops console','APR-2052'],
['09:09:21','s','Storefront','Published to Vitamins &amp; supplements','Storefront CMS','LIVE'],
];
const COLS='110px 40px 310px 1fr 240px 120px';
F['07-audit-timeline']=page('Audit',`${ops(P2)}${rail(7)}<div class="main" style="padding-top:18px"><div class="card" style="padding:20px 36px">
<div class="row" style="justify-content:space-between"><div class="h1" style="font-size:30px">Audit trail · Magnesium Glycinate</div>
<div class="row" style="gap:10px"><span class="pill" style="background:var(--ink);color:#fff;font-size:20px;padding:6px 16px">7 min 11 s, gap to live</span><span class="pill ag">${AG(22)} 6 agent steps</span><span class="pill hu">${HU(22)} 2 human approvals</span></div></div>
<div style="display:grid;grid-template-columns:${COLS};column-gap:16px;margin-top:8px;font-size:18px;font-weight:700;color:var(--ink3);padding:6px 0;border-bottom:2px solid var(--line)"><div>Time</div><div></div><div>Actor</div><div>Action</div><div>Data source</div><div>ID</div></div>
${ev.map(([t,k,who,act,src,id])=>`<div style="display:grid;grid-template-columns:${COLS};column-gap:16px;align-items:center;height:56px;border-bottom:1px solid var(--line2);${k==='h'?'background:var(--human-50);margin:0 -36px;padding:0 36px;':''}">
<div style="font-weight:700;font-variant-numeric:tabular-nums">${t}</div><div>${k==='a'?AG(30):k==='h'?HU(30):SYS(30)}</div>
<div style="font-weight:800;color:${k==='a'?'var(--agent)':k==='h'?'var(--human)':'var(--ok-t)'};line-height:1.2">${who}</div><div style="font-weight:600;line-height:1.25">${act}</div><div style="color:var(--ink2);line-height:1.25">${src}</div><div style="font-weight:800;${k==='h'?'color:var(--human)':''}">${id}</div></div>`).join('')}
<div class="row" style="margin-top:12px;gap:12px;font-size:20px;font-weight:700;color:var(--ink2)">${HU(28)} Nothing reaches shoppers without two human approvals. Every agent step is logged.</div>
</div></div>`);
for(const [k,v] of Object.entries(F))fs.writeFileSync(path.join(OUT,k+'.html'),v);
const names=[['00-storefront','00 · Storefront (before)'],['01-gap-proposal','01 · Agent spots a demand gap'],['02-approval-1','02 · Human approval 1: sourcing'],['03-supplier-stock-check','03 · Agent checks supplier + ERP'],['04-listing-promo-draft','04 · Agent drafts listing, promo, claims'],['05-approval-2','05 · Human approval 2: go live'],['06-published','06 · Live on the storefront'],['07-audit-timeline','07 · Audit trail, 7 min 11 s']];
fs.writeFileSync(path.join(OUT,'overview.html'),`<!doctype html><html><head><meta charset="utf-8"><style>${CSS} html,body{width:1840px;height:1340px}body{padding:40px 48px}.g{display:grid;grid-template-columns:repeat(3,1fr);gap:28px 32px;margin-top:24px}.t img{width:100%;border-radius:12px;border:1px solid var(--line);display:block}.t>div:first-child{font-size:22px;font-weight:800;margin-bottom:8px}</style></head><body>
<div class="row" style="justify-content:space-between">${brand}<div style="font-size:30px;font-weight:800">Inventory to new-product launch · demo screens</div><div class="row">${demo}</div></div>
<div class="g">${names.map(([f,l])=>`<div class="t"><div>${l}</div><img src="../../${f}.png"></div>`).join('')}
<div class="t"><div>Legend</div><div style="background:#fff;border:1px solid var(--line);border-radius:12px;height:350px;padding:28px;font-size:20px;font-weight:600;display:flex;flex-direction:column;gap:16px">
<div class="row">${AG(34)}Violet + sparkle = what the AI agent did</div><div class="row">${HU(34)}Navy + person = a human approved it</div><div class="row">${SYS(34)}Green tick = system, check passed, live</div><div class="row"><span class="pill new">New</span><span style="background:#FFC93C;font-weight:800;padding:2px 12px;border-radius:6px">2 for S$55.90</span>badge, promo ribbon</div><div class="row"><span style="font-weight:700;color:#8C1046;background:#FCE7EF;border-radius:8px;padding:1px 10px">Member S$25.90</span>member price</div><div class="row">${demo} on every screen</div></div></div></div></body></html>`);
console.log('ok');
