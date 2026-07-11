"use strict";
const $ = s => document.querySelector(s);

/* status: 'seq' = selected sequence | 'src' = all uploaded | 'cut' = rejected */
let photos = [];        // {id,name,status,mark,flagged,uploadIndex}
let currentId = null;
let target = 500;
let cutCounter = 0;
let sessionId = null;   // set when a folder is opened or a session is restored

const thumbURL   = name => `/api/thumb/${sessionId}/${encodeURIComponent(name)}`;
const previewURL = name => `/api/preview/${sessionId}/${encodeURIComponent(name)}`;

/* ------------------------------------------------------------------ */
/* API                                                                */
/* ------------------------------------------------------------------ */
async function api(url, opts){
  const r = await fetch(url, opts);
  if(!r.ok){ const t = await r.text().catch(()=>r.statusText); throw new Error(t||r.status); }
  return r.json();
}
function loadPayload(data){
  sessionId = data.session;
  target = data.target || 500;
  photos = data.photos.map((p,i)=>({
    id: 'p'+i+'_'+p.name,
    name: p.name, status: p.status, mark: p.mark,
    flagged: !!p.flagged, uploadIndex: p.uploadIndex,
  }));
  const first = srcList()[0] || seq()[0] || photos[0];
  currentId = first ? first.id : null;
  renderAll();
}

/* ------------------------------------------------------------------ */
/* autosave (debounced)                                               */
/* ------------------------------------------------------------------ */
let saveTimer=null;
function scheduleSave(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 500);
}
async function doSave(){
  if(!sessionId) return;
  const payload = { session: sessionId, target, photos: photos.map(p=>({name:p.name,status:p.status,mark:p.mark,flagged:p.flagged})) };
  try{
    await api('/api/save', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    flashSaved();
  }catch(e){ /* ignore transient */ }
}
function flashSaved(){
  const f=$("#saveflag"); f.textContent='✓ saved'; f.classList.add('show');
  setTimeout(()=>f.classList.remove('show'), 1200);
}

/* ------------------------------------------------------------------ */
/* list helpers                                                        */
/* ------------------------------------------------------------------ */
const seq     = () => photos.filter(p=>p.status==='seq');
const srcList = () => photos.filter(p=>p.status==='src').sort((a,b)=>a.uploadIndex-b.uploadIndex);
const rejList = () => photos.filter(p=>p.status==='cut').sort((a,b)=>a.uploadIndex-b.uploadIndex);
const idx = id => photos.findIndex(p=>p.id===id);
const seqIndex = id => seq().findIndex(p=>p.id===id);
const byId = id => photos.find(p=>p.id===id);
function currentList(){
  const p=byId(currentId); if(!p) return srcList();
  return p.status==='seq' ? seq() : p.status==='src' ? srcList() : rejList();
}

/* ------------------------------------------------------------------ */
/* navigation                                                          */
/* ------------------------------------------------------------------ */
function selectId(id){ currentId=id; renderPreview(); refreshCurrent(); }
function refreshCurrent(){
  document.querySelectorAll('.cell.current').forEach(c=>c.classList.remove('current'));
  if(!currentId) return;
  const el=document.querySelector('.cell[data-id="'+CSS.escape(currentId)+'"]');
  if(el){ el.classList.add('current'); el.scrollIntoView({inline:'center',block:'nearest'}); }
}
function selectByOffset(delta){
  const list=currentList(); if(!list.length) return;
  let i=list.findIndex(p=>p.id===currentId); if(i<0)i=0;
  i=Math.max(0,Math.min(list.length-1,i+delta));
  currentId=list[i].id; renderPreview(); refreshCurrent();
}
function jump(where){
  const list=currentList(); if(!list.length) return;
  currentId=(where==='home'?list[0]:list[list.length-1]).id;
  renderPreview(); refreshCurrent();
}

/* ------------------------------------------------------------------ */
/* moves                                                               */
/* ------------------------------------------------------------------ */
function setBucket(id, targetStatus, focusId){
  const p=byId(id); if(!p) return;
  if(p.status==='seq' && targetStatus==='cut'){ flashPreview('var(--cut)'); return; }
  p.status=targetStatus;
  if(targetStatus==='seq'){ const from=idx(id); const m=photos.splice(from,1)[0]; photos.push(m); }
  if(targetStatus==='cut'){ p.cutSeq=++cutCounter; }
  currentId = (focusId!==undefined)?focusId:id;
  renderAll(); scheduleSave();
}
function dropIntoSelected(targetId){
  if(!dragId||dragId===targetId) return;
  const p=byId(dragId); if(!p) return;
  p.status='seq';
  const from=idx(dragId); photos.splice(from,1);
  photos.splice(idx(targetId),0,p);
  currentId=p.id; renderAll(); scheduleSave();
}
function onDropReorder(targetId){
  if(!dragId||dragId===targetId) return;
  const from=idx(dragId), moving=photos[from];
  photos.splice(from,1);
  photos.splice(idx(targetId),0,moving);
  renderAll(); scheduleSave();
}
function toggleMark(id, kind){
  const p=byId(id); if(!p||p.status!=='src') return;
  p.mark=(p.mark===kind)?null:kind;
  const cell=document.querySelector('.cell[data-id="'+CSS.escape(id)+'"]');
  if(cell){ cell.classList.remove('mark-flag','mark-star'); if(p.mark) cell.classList.add('mark-'+p.mark);
            const mk=cell.querySelector('.mk'); if(mk) mk.textContent=p.mark==='flag'?'⚑':p.mark==='star'?'★':''; }
  renderActions(p); scheduleSave();
}
function nudge(delta){
  const p=byId(currentId); if(!p||p.status!=='seq') return;
  const s=seq(); const si=seqIndex(currentId); const tgt=si+delta;
  if(tgt<0||tgt>=s.length) return;
  const neighbor=s[tgt]; const from=idx(p.id); photos.splice(from,1);
  const to=idx(neighbor.id)+(delta>0?1:0); photos.splice(to,0,p);
  renderAll(); scheduleSave();
}

/* ------------------------------------------------------------------ */
/* drag plumbing                                                       */
/* ------------------------------------------------------------------ */
let dragId=null;
function onDragStart(e,id){ dragId=id; e.dataTransfer.effectAllowed='move'; e.currentTarget.classList.add('dragging'); }
function onDragEnd(e){ e.currentTarget.classList.remove('dragging'); dragId=null; document.querySelectorAll('.cell.dragover').forEach(c=>c.classList.remove('dragover')); }

/* ------------------------------------------------------------------ */
/* rendering                                                           */
/* ------------------------------------------------------------------ */
function renderAll(){ renderPreview(); renderChips(); renderSelected(); renderSource(); renderReject(); }

function buildCell(p, label, extraClass){
  const cell=document.createElement('div');
  const markCls = p.mark==='flag'?' mark-flag':p.mark==='star'?' mark-star':'';
  cell.className='cell'+(p.id===currentId?' current':'')+(extraClass?' '+extraClass:'')+markCls;
  cell.draggable=true; cell.dataset.id=p.id;
  const n=document.createElement('span'); n.className='n'; n.textContent=label;
  const img=document.createElement('img'); img.loading='lazy'; img.src=thumbURL(p.name);
  const mk=document.createElement('span'); mk.className='mk'; mk.textContent=p.mark==='flag'?'⚑':p.mark==='star'?'★':'';
  cell.append(n,img,mk);
  cell.onclick=()=>selectId(p.id);
  cell.ondragstart=e=>onDragStart(e,p.id);
  cell.ondragend=onDragEnd;
  return cell;
}

function renderPreview(){
  const p=byId(currentId); const img=$("#bigImg");
  if(!p){ img.removeAttribute('src'); $("#pos").textContent=''; $("#fname").textContent = photos.length?'':'No photos in this folder'; renderActions(null); return; }
  img.src=previewURL(p.name);
  $("#fname").textContent=p.name;
  let label;
  if(p.status==='seq'){ const l=seq(); label=`Selected · #${l.findIndex(x=>x.id===p.id)+1} of ${l.length}`; }
  else if(p.status==='src'){ const l=srcList(); label=`All uploaded · ${l.findIndex(x=>x.id===p.id)+1} of ${l.length}`; }
  else { const l=rejList(); label=`Rejected · ${l.findIndex(x=>x.id===p.id)+1} of ${l.length}`; }
  $("#pos").textContent=label;
  renderActions(p);
}

function mkBtn(label, cls, fn){ const b=document.createElement('button'); b.className='big'+(cls?' '+cls:''); b.textContent=label; b.onclick=fn; return b; }
function mkMarkBtn(p, kind){
  const b=document.createElement('button'); b.className='big '+(kind==='flag'?'markFlag':'markStar');
  if(p.mark===kind) b.classList.add('on');
  const ico=document.createElement('span'); ico.className='ico'; ico.textContent=kind==='flag'?'⚑':'★';
  b.append(ico, document.createTextNode(kind==='flag'?'Flag':'Star'));
  b.title=kind==='flag'?'Mark as “might reject” (reference only)':'Mark as “might select” (reference only)';
  b.onclick=()=>toggleMark(p.id,kind);
  return b;
}
function nextInList(list,id){ const i=list.findIndex(p=>p.id===id); return list[i+1]||list[i-1]||null; }
function renderActions(p){
  const bar=$("#actionsV2"); bar.textContent='';
  if(!p) return;
  if(p.status==='src'){
    const nxt=()=>{ const n=nextInList(srcList(),p.id); return n?n.id:p.id; };
    bar.append(
      mkBtn('✕ Reject','cut',()=>setBucket(p.id,'cut',nxt())),
      mkMarkBtn(p,'flag'), mkMarkBtn(p,'star'),
      mkBtn('✓ Add to selected','keep',()=>setBucket(p.id,'seq',nxt()))
    );
  } else if(p.status==='seq'){
    bar.append(mkBtn('↓ Move to all uploaded','',()=>setBucket(p.id,'src')));
  } else {
    bar.append(
      mkBtn('↑ Move to all uploaded','',()=>setBucket(p.id,'src')),
      mkBtn('✓ Move to selected sequence','keep',()=>setBucket(p.id,'seq'))
    );
  }
}

function laneEmpty(strip,text){ const e=document.createElement('div'); e.className='laneempty'; e.textContent=text; strip.appendChild(e); }
function renderSelected(){
  const strip=$("#stripSelected"); const s=seq();
  $("#selInfo").textContent=`${s.length} selected`;
  strip.textContent='';
  if(!s.length){ laneEmpty(strip,'Drag photos up from “All uploaded” to add them here, then drag to reorder.'); return; }
  const frag=document.createDocumentFragment();
  s.forEach((p,i)=>{
    const cell=buildCell(p,i+1);
    cell.ondragover=e=>{e.preventDefault(); cell.classList.add('dragover');};
    cell.ondragleave=()=>cell.classList.remove('dragover');
    cell.ondrop=e=>{e.preventDefault(); e.stopPropagation(); cell.classList.remove('dragover'); dropIntoSelected(p.id);};
    frag.appendChild(cell);
  });
  strip.appendChild(frag);
}
function renderSource(){
  const strip=$("#stripSource"); const all=srcList();
  $("#srcInfo").textContent=`${all.length} to review`;
  strip.textContent='';
  if(!all.length){ laneEmpty(strip,'Empty — every uploaded photo has been sorted into Selected or Reject.'); return; }
  const frag=document.createDocumentFragment();
  all.forEach(p=>frag.appendChild(buildCell(p,p.uploadIndex+1)));
  strip.appendChild(frag);
}
function renderReject(){
  const strip=$("#stripReject"); const all=rejList();
  $("#rejInfo").textContent=`${all.length} rejected`;
  strip.textContent='';
  if(!all.length){ laneEmpty(strip,'Drag photos here from “All uploaded” to reject them. Preview one to send it back.'); return; }
  const frag=document.createDocumentFragment();
  all.forEach(p=>frag.appendChild(buildCell(p,p.uploadIndex+1,'rej')));
  strip.appendChild(frag);
}

function renderChips(){
  const inSeq=seq().length, rej=rejList().length, src=srcList().length, total=photos.length;
  const need=inSeq-target;
  const flagged=photos.filter(p=>p.flagged).length;
  const box=$("#chips"); box.textContent='';
  const chip=(t,cls)=>{ const s=document.createElement('span'); s.className='chip'+(cls?' '+cls:''); s.textContent=t; return s; };
  let cls,label;
  if(inSeq===target){ cls='ok'; label='on target'; }
  else if(inSeq>target){ cls='warn'; label=`cut ${need} more`; }
  else { cls='over'; label=`${Math.abs(need)} under target`; }
  box.append(chip(`Selected ${inSeq} / ${target} · ${label}`,cls),
             chip(`To review ${src}`), chip(`Rejected ${rej}`), chip(`Loaded ${total}`,'muted'));
  $("#btnTarget").textContent=`Target: ${target}`;
}
function flashPreview(color){
  const pv=$("#preview");
  pv.style.transition='none'; pv.style.outline='2px solid '+color;
  setTimeout(()=>{pv.style.transition='outline .4s'; pv.style.outline='none';},60);
}

/* ------------------------------------------------------------------ */
/* folder picker                                                       */
/* ------------------------------------------------------------------ */
let pickerPath=null, pickerCount=0;
async function browse(path){
  const q = path!=null ? ('?path='+encodeURIComponent(path)) : '';
  const data = await api('/api/browse'+q);
  pickerPath=data.path; pickerCount=data.image_count;
  $("#pPath").textContent=data.path;
  $("#pCount").textContent = data.image_count ? `${data.image_count} images here` : '';
  const list=$("#pList"); list.textContent='';
  $("#pUp").disabled = !data.parent;
  $("#pUp").dataset.parent = data.parent || '';
  if(!data.dirs.length){
    const e=document.createElement('div'); e.className='pempty';
    e.textContent = data.image_count ? 'No subfolders. Open this folder to start.' : 'No subfolders here.';
    list.appendChild(e);
  } else {
    data.dirs.forEach(name=>{
      const it=document.createElement('div'); it.className='pitem';
      const ic=document.createElement('span'); ic.className='fic'; ic.textContent='📁';
      const nm=document.createElement('span'); nm.textContent=name;
      it.append(ic,nm);
      it.onclick=()=>browse((pickerPath.endsWith('/')?pickerPath:pickerPath+'/')+name);
      list.appendChild(it);
    });
  }
}
async function openFolder(path){
  const list=$("#pList"); list.innerHTML='<div class="pempty"><span class="spin"></span> Scanning…</div>';
  try{
    const data = await api('/api/open',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path})});
    loadPayload(data);
    history.pushState({}, '', '/session/'+data.session);   // shareable, refresh-safe URL
    $("#picker").classList.remove('show');
  }catch(e){
    list.innerHTML='<div class="pempty">Could not open folder.</div>';
  }
}

async function restoreSession(sid){
  try{
    const data = await api('/api/session/'+encodeURIComponent(sid));
    loadPayload(data);
    if(data.folder_ok){
      $("#picker").classList.remove('show');   // restored cleanly — hide the picker
    } else {
      alert("This session's folder is no longer available:\n"+data.folder+
            "\n\nYour decisions are safe. Reconnect by opening the folder again.");
      $("#picker").classList.add('show'); browse(null);
    }
    return true;
  }catch(e){
    return false;   // unknown/corrupt session → fall back to picker
  }
}

/* ------------------------------------------------------------------ */
/* export                                                              */
/* ------------------------------------------------------------------ */
function openExport(){
  const s=seq();
  $("#expSummary").textContent = `${s.length} photos in your selected sequence (target ${target}).` +
    (s.length!==target ? `  ⚠ Not at target.` : '');
  $("#expResult").textContent='';
  $("#exportDlg").classList.add('show');
}
async function runExport(){
  const s=seq(); const mode=document.querySelector('input[name="expmode"]:checked').value;
  $("#expResult").innerHTML='<span class="spin"></span> Exporting…';
  try{
    const data = await api('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({session:sessionId, selected:s.map(p=>p.name), mode})});
    $("#expResult").textContent = mode==='copy'
      ? `✓ Copied ${data.copied}/${data.total} photos to:  ${data.out}`
      : `✓ Wrote manifest (${data.total} entries) to:  ${data.out}/sequence.txt`;
  }catch(e){ $("#expResult").textContent='Export failed: '+e.message; }
}

/* ------------------------------------------------------------------ */
/* wiring                                                              */
/* ------------------------------------------------------------------ */
$("#btnFolder").onclick=()=>{ $("#picker").classList.add('show'); browse(pickerPath); };
$("#pUp").onclick=()=>{ const par=$("#pUp").dataset.parent; if(par) browse(par); };
$("#pOpen").onclick=()=>openFolder(pickerPath);
$("#btnExport").onclick=openExport;
$("#expCancel").onclick=()=>$("#exportDlg").classList.remove('show');
$("#expGo").onclick=runExport;
$("#btnHelp").onclick=()=>$("#help").classList.add('show');
$("#helpClose").onclick=()=>$("#help").classList.remove('show');
$("#btnTarget").onclick=()=>{ const v=prompt("Target number of photos in the final sequence?",target); if(v&&+v>0){ target=+v; renderChips(); scheduleSave(); } };
$("#btnShuffle").onclick=()=>{
  const s=seq();
  for(let i=s.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [s[i],s[j]]=[s[j],s[i]]; }
  photos=[...s, ...photos.filter(p=>p.status!=='seq')];
  renderAll(); scheduleSave();
};
$("#navPrev").onclick=()=>selectByOffset(-1);
$("#navNext").onclick=()=>selectByOffset(1);

function wireLane(sel, onLaneDrop){
  const lane=$(sel);
  lane.addEventListener("dragover",e=>{ if(!dragId)return; e.preventDefault(); lane.classList.add("dropready"); });
  lane.addEventListener("dragleave",e=>{ if(!lane.contains(e.relatedTarget)) lane.classList.remove("dropready"); });
  lane.addEventListener("drop",e=>{ if(!dragId)return; e.preventDefault(); lane.classList.remove("dropready"); onLaneDrop(dragId); });
}
wireLane("#laneSelected", id=>setBucket(id,'seq'));
wireLane("#laneSource",   id=>setBucket(id,'src'));
wireLane("#laneReject",   id=>setBucket(id,'cut'));

document.addEventListener("keydown",e=>{
  if(e.target.tagName==="INPUT") return;
  if(e.key==="Escape"){ document.querySelectorAll('.overlay.show').forEach(o=>{ if(o.id!=='picker'||photos.length) o.classList.remove('show'); }); return; }
  switch(e.key){
    case "ArrowRight": selectByOffset(1); e.preventDefault(); break;
    case "ArrowLeft":  selectByOffset(-1); e.preventDefault(); break;
    case "[": nudge(-1); e.preventDefault(); break;
    case "]": nudge(1); e.preventDefault(); break;
    case "Home": jump('home'); e.preventDefault(); break;
    case "End": jump('end'); e.preventDefault(); break;
  }
});

/* ------------------------------------------------------------------ */
/* boot: restore session from URL, else show picker                    */
/* ------------------------------------------------------------------ */
async function boot(){
  const m = location.pathname.match(/^\/session\/([A-Za-z0-9]+)/);
  if(m){
    const ok = await restoreSession(m[1]);
    if(ok) return;                       // restored (or handled missing folder)
    history.replaceState({}, '', '/');   // bad id → clean URL, show picker
  }
  $("#picker").classList.add('show');
  await loadRecent();
  browse(null);
}

async function loadRecent(){
  const box=$("#pRecent"); if(!box) return;
  try{
    const data = await api('/api/sessions');
    box.textContent='';
    if(!data.sessions.length){ box.style.display='none'; return; }
    box.style.display='';
    const h=document.createElement('div'); h.className='precenthdr'; h.textContent='Recent sessions'; box.appendChild(h);
    data.sessions.slice(0,6).forEach(s=>{
      const it=document.createElement('div'); it.className='pitem';
      const nm=document.createElement('span');
      const short = s.folder.split('/').pop() || s.folder;
      nm.innerHTML='';
      const b=document.createElement('b'); b.textContent=short;
      const sub=document.createElement('span'); sub.className='muted'; sub.style.marginLeft='8px';
      sub.textContent=`${s.selected} selected · ${s.decided} decided${s.folder_ok?'':' · folder missing'}`;
      nm.append(b, sub);
      it.appendChild(nm);
      it.onclick=()=>{ history.pushState({}, '', '/session/'+s.session); restoreSession(s.session); };
      box.appendChild(it);
    });
  }catch(e){ box.style.display='none'; }
}

window.addEventListener('popstate', ()=>{
  const m = location.pathname.match(/^\/session\/([A-Za-z0-9]+)/);
  if(m) restoreSession(m[1]);
});

boot();
