const NS = 'http://www.w3.org/2000/svg';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const LABELS = { topic: 'Topic choose', radar: 'Multipolar decision', scale: 'Five-point agreement' };
const COLORS = ['#79e7c4', '#9bbdff', '#e9c88b', '#c5adf4', '#e6a7b8', '#9ac9d3'];
export function radarPoints(values, radius = 98, cx = 250, cy = 155) {
  return values.map((v, i) => { const angle = i * Math.PI * 2 / values.length - Math.PI / 2; return [cx + Math.cos(angle) * radius * v / 5, cy + Math.sin(angle) * radius * v / 5]; });
}
export function bubblePositions(ballot) {
  const columns = ballot.options.length > 4 ? 3 : 2;
  const centers = ballot.options.map((_, i) => ({ x: 500 / columns * (i % columns + .5), y: 82 + Math.floor(i / columns) * 148 }));
  const used = new Map();
  return ballot.bubbles.flatMap(b => b.choices.map((choice, slot) => {
    const n = used.get(choice) || 0; used.set(choice, n + 1);
    const radius = 10 * Math.sqrt(n), angle = n * 2.399963;
    return { key: `${b.token}-${slot}`, choice, x: centers[choice].x + Math.cos(angle) * radius, y: centers[choice].y + Math.sin(angle) * radius };
  }));
}
export function ballotExport(b) {
  return { question: b.title, mode: LABELS[b.kind], status: b.open ? 'Open' : 'Closed', eligible: b.eligibleCount, responses: b.responded,
    results: b.options.map((option, i) => ({ option, [b.kind === 'radar' ? 'meanRatingOutOf5' : 'selections']: b.values[i] })), conclusion: b.conclusion,
    note: b.multiple ? 'Multiple selections allowed; option counts may exceed response count.' : 'Responses describe preferences, not a binding decision.' };
}
export function createDecisionUI(bridge, { document: doc = document, window: win = window } = {}) {
  const get = id => doc.getElementById(id);
  const ctx = () => bridge.read();
  let state = null, room = null, selected = null, mode = 'topic', seen = new Set(), cards = new Map(), lastRound = -1;
  const sidebar = doc.querySelector('.q-facil-scroll');
  const endButton = get('qEndSessionBtn');
  get('qFocusEnergy')?.remove(); get('qFocusProfile')?.remove(); get('qFocusCompactMeter')?.remove();
  const panel = doc.createElement('section'); panel.className = 'q-card q-thinking';
  panel.innerHTML = `<div class="qd-eyebrow">ROOM STUDIO</div><button type="button" class="qd-launch" id="qdLaunch"><span><b>Ballot studio</b><small>Make room for every perspective</small></span><span class="qd-plus" aria-hidden="true">+</span></button>
    <div class="qd-section-head"><h2>Thinking together</h2><span class="qd-tag">Voluntary</span></div>
    <p class="qd-hint">A useful meeting starts with a clear outcome. Quiet participation counts, too.</p>
    <p id="qdObjective" class="qd-objective">Set one outcome to work toward.</p>
    <form id="qdObjectiveForm" hidden><label>Shared objective<input class="q-input" name="objective" maxlength="240" placeholder="What should we leave with?" required></label><button class="q-btn small" type="submit">Save objective</button></form>
    <label id="qdCohostLabel" hidden>Co-facilitator<select class="q-select" id="qdCohost"><option value="">Host only</option></select></label>
    <div class="qd-progress" id="qdOutcomes"></div>
    <div class="qd-section-head"><h3>Room check-in</h3><span id="qdCheckStatus" class="qd-tag">Not open</span></div>
    <p class="qd-hint">How is the discussion working for you? This is self-reported support, not a measure of attention.</p>
    <div id="qdCheckChoices" class="qd-check-choices" hidden><button type="button" data-check="clear">I’m clear</button><button type="button" data-check="context">I need context</button><button type="button" data-check="pause">I need a pause</button><button type="button" data-check="">Withdraw my check-in</button></div>
    <p id="qdMyCheck" class="qd-hint" role="status"></p><div id="qdCheckResults"></div>
    <p class="qd-hint">No names or live response counts are shared. Results appear together after closing, with at least 3 responses. In small groups, people may still infer answers. You can skip.</p>
    <button class="q-btn small" id="qdCheckControl" type="button" hidden>Open check-in</button><p id="qdFocusError" class="qd-error" role="status"></p>`;
  sidebar?.prepend(panel); if (endButton) panel.append(endButton);
  const studio = doc.createElement('section'); studio.id = 'qdStudio'; studio.className = 'qd-studio'; studio.hidden = true;
  studio.setAttribute('aria-label', 'Ballot studio');
  studio.innerHTML = `<header class="qd-studio-head"><div><div class="qd-eyebrow">QUORUM / COLLECTIVE DECISIONS</div><h2>Different views. A shared direction.</h2></div><button type="button" class="q-icon-btn" id="qdHide" aria-label="Minimize ballot studio">−</button></header>
    <div class="qd-studio-body"><div class="qd-modes" aria-label="Ballot types"><button type="button" data-ballot-mode="topic" aria-pressed="true"><span>01 / CLUSTERS</span><b>Topic choose</b><small>One idea, or a few worth exploring</small></button><button type="button" data-ballot-mode="radar" aria-pressed="false"><span>02 / RADAR</span><b>Multipolar decision</b><small>Compare the dimensions that matter</small></button><button type="button" data-ballot-mode="scale" aria-pressed="false"><span>03 / SPECTRUM</span><b>Five-point agreement</b><small>Make space for yes, no and uncertainty</small></button></div>
    <form id="qdCreate" class="qd-create"><label>Question<input class="q-input" name="title" maxlength="180" required placeholder="Which direction should we explore?"></label><label id="qdOptionsLabel">Choices · one per line<textarea class="q-input" name="options" rows="3" placeholder="Prototype the idea&#10;Talk to customers&#10;Review the evidence" required></textarea></label><label class="qd-multiple" id="qdMultipleLabel"><input name="multiple" type="checkbox"> Allow more than one choice</label><div class="qd-create-foot"><p class="qd-hint" id="qdModeHelp">2–6 choices. Moving bubbles show selections; they are not a statistical classifier.</p><button class="q-btn primary" type="submit">+ Open ballot</button></div></form>
    <p class="qd-privacy">Names are hidden on plots. Live changes can still reveal preferences in small groups. Only people present when a ballot opens can vote; joining later allows viewing. Participation is optional.</p>
    <p id="qdError" class="qd-error" role="status"></p><nav id="qdTabs" class="qd-tabs" aria-label="Room ballots"></nav><div id="qdCards"></div><div id="qdEmpty" class="qd-empty"><span>◎</span><h3>Start with a good question.</h3><p>Open a ballot above. Everyone in the room can respond and watch the plot change.</p></div>
    <footer class="qd-credit">Pattern adapted from <a href="https://uiverse.io/adamgiebl/curvy-earwig-79" target="_blank" rel="noopener noreferrer">adamgiebl on Uiverse</a> · MIT</footer></div>`;
  get('qStage')?.append(studio);
  studio.addEventListener('keydown', event => event.stopPropagation());
  panel.addEventListener('keydown', event => event.stopPropagation());
  const composer = doc.createElement('details'); composer.id='qdComposer'; composer.open=true;
  const composerTitle = doc.createElement('summary'); composerTitle.textContent='Create a ballot';
  get('qdCreate').before(composer); composer.append(composerTitle,get('qdCreate'));
  function open() {
    studio.hidden = false;
    if(win.matchMedia?.('(max-width: 860px)').matches) win.QuorumFocusUI?.setSidebar(true);
    get('qdHide')?.focus();
  }
  get('qdLaunch').onclick = open;
  get('qdHide').onclick = () => { studio.hidden = true; get('qdLaunch').focus(); };
  function send(msg) { get('qdError').textContent = ''; get('qdFocusError').textContent = ''; if (!ctx().joined || !bridge.send(msg)) { handleError({message:'Reconnect to the room before sending changes.'}); return false; } return true; }
  doc.querySelectorAll('[data-ballot-mode]').forEach(button => { button.onclick = () => {
    mode = button.dataset.ballotMode;
    composer.open=true;
    doc.querySelectorAll('[data-ballot-mode]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
    get('qdOptionsLabel').hidden = mode === 'scale'; get('qdCreate').elements.options.required = mode !== 'scale';
    get('qdMultipleLabel').hidden = mode !== 'topic';
    get('qdModeHelp').textContent = mode === 'radar' ? '3–6 criteria, one per line. Everyone rates each from 1 (low) to 5 (high); the radar shows the mean.' : mode === 'scale' ? 'Yes · Somewhat yes · Don’t know · Somewhat no · No. Uncertainty stays a separate answer.' : '2–6 choices. Moving bubbles show selections; they are not a statistical classifier.';
  }; });
  get('qdCreate').onsubmit = e => { e.preventDefault(); const f = e.currentTarget.elements;
    const options = f.options.value.split('\n').map(s => s.trim()).filter(Boolean);
    if (mode !== 'scale' && (options.length < (mode === 'radar' ? 3 : 2) || options.length > 6 || options.some(x => x.length > 60) || new Set(options.map(x=>x.toLowerCase())).size !== options.length)) { handleError({message:'Use distinct options, at most 60 characters each: 2–6 choices or 3–6 radar criteria.'}); return; }
    send({type:'decision:create',kind:mode,title:f.title.value,options,multiple:f.multiple.checked});
  };
  get('qdObjectiveForm').onsubmit = e => { e.preventDefault(); send({type:'thinking:objective',objective:e.currentTarget.elements.objective.value}); };
  get('qdCohost').onchange = e => send({type:'thinking:cohost',id:e.target.value || null});
  get('qdCheckControl').onclick = () => send({type: state.checkinOpen ? 'thinking:finish' : 'thinking:start'});
  panel.querySelectorAll('[data-check]').forEach(b => b.onclick = () => send({type:'thinking:respond',round:state.round,value:b.dataset.check || null}));
  function svgNode(tag, attrs = {}) { const node = doc.createElementNS(NS, tag); for (const [k,v] of Object.entries(attrs)) node.setAttribute(k,v); return node; }
  function makeCard(b) {
    const root = doc.createElement('article'); root.className = 'qd-ballot'; root.dataset.ballotId = b.id;
    root.innerHTML = `<div class="qd-ballot-head"><div><span class="qd-eyebrow">${esc(LABELS[b.kind])}</span><h3>${esc(b.title)}</h3></div><span class="qd-tag qd-live"></span></div><p class="qd-response-count" role="status"></p><div class="qd-ballot-grid"><div class="qd-plot-wrap"><svg class="qd-plot" role="img" aria-label="${esc(LABELS[b.kind])} live results"></svg><p class="qd-plot-note"></p><div class="qd-result-list"></div></div><div class="qd-response"><form class="qd-vote-form"><fieldset><legend>Your response</legend>${b.options.map((opt,i) => b.kind === 'radar' ? `<label class="qd-rating"><span>${esc(opt)}</span><select name="criterion-${i}" required><option value="">Choose…</option>${[1,2,3,4,5].map(n=>`<option value="${n}">${n} — ${['Low','Slight','Moderate','Strong','High'][n-1]}</option>`).join('')}</select></label>` : `<label class="qd-option"><input type="${b.multiple?'checkbox':'radio'}" name="choice" value="${i}"><span>${esc(opt)}</span></label>`).join('')}</fieldset><button class="q-btn primary" type="submit">Share response</button><button class="q-btn ghost" type="button" data-withdraw>Withdraw</button><p class="qd-vote-status" role="status"></p></form><div class="qd-manage"><button class="q-btn small" type="button" data-close>Close voting</button><form class="qd-conclusion-form"><label>Decision / next step<textarea class="q-input" name="conclusion" maxlength="600" rows="3" placeholder="What will we do with these responses?"></textarea></label><button class="q-btn small" type="submit">Save next step</button></form></div><p class="qd-conclusion"></p><button type="button" class="q-btn small" data-export>Download results</button></div></div>`;
    const record = {root, ballot:b, dirty:false, bubbles:new Map(), mineKey:undefined};
    const form = root.querySelector('.qd-vote-form');
    form.oninput = () => { record.dirty = true; root.querySelector('.qd-vote-status').textContent = 'Your draft · share when ready'; };
    form.onsubmit = e => { e.preventDefault();
      const value = b.kind === 'radar' ? b.options.map((_,i)=>Number(form.elements[`criterion-${i}`].value)) : [...form.querySelectorAll('input:checked')].map(i=>Number(i.value));
      if (!value.length) { root.querySelector('.qd-vote-status').textContent = 'Select at least one option.'; return; }
      if (send({type:'decision:vote',id:b.id,value})) record.dirty = false;
    };
    root.querySelector('[data-withdraw]').onclick = () => { if(send({type:'decision:vote',id:b.id,value:null})) record.dirty=false; };
    root.querySelector('[data-close]').onclick = () => send({type:'decision:close',id:b.id});
    root.querySelector('.qd-conclusion-form').onsubmit = e => { e.preventDefault(); send({type:'decision:conclusion',id:b.id,conclusion:e.currentTarget.elements.conclusion.value}); };
    root.querySelector('[data-export]').onclick = () => {
      const url = win.URL.createObjectURL(new win.Blob([JSON.stringify(ballotExport(record.ballot),null,2)], {type:'application/json'}));
      const link = doc.createElement('a'); link.href=url; link.download='quorum-ballot.json'; link.click(); win.setTimeout(()=>win.URL.revokeObjectURL(url),1000);
    };
    get('qdCards').append(root); return record;
  }
  function plot(record) {
    const b = record.ballot, svg = record.root.querySelector('svg');
    if (b.kind === 'topic') {
      const cols = b.options.length > 4 ? 3 : 2, height = Math.ceil(b.options.length/cols)*148+26;
      svg.setAttribute('viewBox',`0 0 500 ${height}`);
      if (!svg.children.length) {
        b.options.forEach((name,i)=>{
          const x=500/cols*(i%cols+.5), y=82+Math.floor(i/cols)*148;
          svg.append(svgNode('circle',{cx:x,cy:y,r:62,fill:COLORS[i],'fill-opacity':'.055',stroke:COLORS[i],'stroke-opacity':'.3','stroke-dasharray':'3 5'}));
          const label=svgNode('text',{x,y:y+82,'text-anchor':'middle',fill:COLORS[i]}); label.textContent=`${i+1}`; svg.append(label);
        });
      }
      const positions=bubblePositions(b), keep=new Set(positions.map(p=>p.key));
      for(const [key,node] of record.bubbles) if(!keep.has(key)){node.remove();record.bubbles.delete(key);}
      for(const p of positions){let node=record.bubbles.get(p.key); if(!node){node=svgNode('circle',{r:7,stroke:'#101b1d','stroke-width':2});node.style.cx='250px';node.style.cy='20px';svg.append(node);record.bubbles.set(p.key,node);} node.setAttribute('fill',COLORS[p.choice]); node.style.cx=`${p.x}px`;node.style.cy=`${p.y}px`;}
    } else {
      svg.replaceChildren(); svg.setAttribute('viewBox','0 0 500 320');
      if(b.kind==='radar') {
        for(let n=1;n<=5;n++) svg.append(svgNode('polygon',{points:radarPoints(b.options.map(()=>n)).map(p=>p.join(',')).join(' '),fill:'none',stroke:'#34454a','stroke-width':1}));
        radarPoints(b.options.map(()=>5)).forEach(([x,y],i)=>{svg.append(svgNode('line',{x1:250,y1:155,x2:x,y2:y,stroke:'#34454a'}));const label=svgNode('text',{x:250+(x-250)*1.24,y:155+(y-155)*1.24+5,fill:COLORS[i],'text-anchor':'middle'});label.textContent=String(i+1);svg.append(label);});
        svg.append(svgNode('polygon',{points:radarPoints(b.values).map(p=>p.join(',')).join(' '),fill:'#79e7c4','fill-opacity':'.22',stroke:'#79e7c4','stroke-width':2}));
        if(b.mine) svg.append(svgNode('polygon',{points:radarPoints(b.mine).map(p=>p.join(',')).join(' '),fill:'none',stroke:'#9bbdff','stroke-width':2,'stroke-dasharray':'5 4'}));
      } else b.options.forEach((name,i)=>{const y=20+i*58;const label=svgNode('text',{x:10,y:y+17,fill:'#d3dce0'});label.textContent=name;svg.append(label,svgNode('rect',{x:150,y,width:310,height:28,rx:5,fill:'#203036'}),svgNode('rect',{x:150,y,width:b.responded?310*b.values[i]/b.responded:0,height:28,rx:5,fill:COLORS[i]}));const count=svgNode('text',{x:480,y:y+19,fill:'#d3dce0','text-anchor':'middle'});count.textContent=String(b.values[i]);svg.append(count);});
    }
    record.root.querySelector('.qd-plot-note').textContent = b.kind==='topic' ? (b.multiple?'One bubble per selection; one person may appear in several clusters.':'Each bubble is one response. Positions inside a cluster have no score.') : b.kind==='radar'?'Mint: room mean · dashed blue: your response · scale 1–5. An empty radar has no responses.':'Each bar is a response count. “Don’t know” is uncertainty, not opposition.';
    record.root.querySelector('.qd-result-list').innerHTML=b.options.map((label,i)=>`<div><span><i style="background:${COLORS[i]}"></i>${i+1}. ${esc(label)}</span><b>${b.kind==='radar'?(b.responded?b.values[i].toFixed(1)+'/5':'—'):b.values[i]}</b></div>`).join('');
  }
  function renderCard(record,b) {
    record.ballot=b;const root=record.root;root.hidden=b.id!==selected;
    root.querySelector('.qd-live').textContent=b.open?'Live':'Closed';
    root.querySelector('.qd-response-count').textContent=`${b.responded} of ${b.eligibleCount} eligible people responded${b.multiple?' · multiple choices allowed':''}`;
    const form=root.querySelector('.qd-vote-form'), key=JSON.stringify(b.mine);
    if(!record.dirty && (key!==record.mineKey || record.mineKey===undefined)) {
      if(b.kind==='radar') b.options.forEach((_,i)=>{form.elements[`criterion-${i}`].value=b.mine?.[i]??'';});
      else form.querySelectorAll('input').forEach(input=>{input.checked=!!b.mine?.includes(Number(input.value));});
      record.mineKey=key;
    }
    form.querySelector('fieldset').disabled=!b.canVote;
    form.querySelector('[type=submit]').disabled=!b.canVote;
    root.querySelector('[data-withdraw]').disabled=!b.canVote || !b.mine;
    if(!record.dirty) root.querySelector('.qd-vote-status').textContent=!b.open?'Voting has closed.':!b.canVote?'You joined after this ballot opened. You can view its results.':b.mine?'Response shared. You can change your mind.':'Your choice is optional.';
    root.querySelector('.qd-manage').hidden=!b.canManage;
    root.querySelector('[data-close]').hidden=!b.open;
    const conclusion=root.querySelector('[name=conclusion]');if(doc.activeElement!==conclusion) conclusion.value=b.conclusion;
    root.querySelector('.qd-conclusion').textContent=b.conclusion?`Next step: ${b.conclusion}`:'';
    plot(record);
  }
  function updateRoom(next) {
    room=next;state=next?.decisions;if(!state)return;
    const ballots=state.ballots;
    const fresh=ballots.filter(b=>!seen.has(b.id));
    if(fresh.length){selected=fresh.at(-1).id;composer.open=false;composerTitle.textContent='Create another ballot';open();fresh.forEach(b=>seen.add(b.id));}
    get('qdEmpty').hidden=ballots.length>0;
    // Keep existing vote controls and drafts intact while remote results stream in.
    const tabs=get('qdTabs'); const activeTab=doc.activeElement?.dataset?.ballotTab;
    tabs.replaceChildren(); ballots.forEach(b=>{const tab=doc.createElement('button');tab.type='button';tab.dataset.ballotTab=b.id;tab.textContent=b.title;tab.setAttribute('aria-current',String(b.id===selected));tab.onclick=()=>{selected=b.id;updateRoom(room);};tabs.append(tab);if(activeTab===b.id)tab.focus();if(!cards.has(b.id))cards.set(b.id,makeCard(b));renderCard(cards.get(b.id),b);});
    get('qdObjective').textContent=state.objective||'Set one outcome to work toward.';
    get('qdObjectiveForm').hidden=!state.canManage;
    const input=get('qdObjectiveForm').elements.objective;if(doc.activeElement!==input)input.value=state.objective;
    get('qdCohostLabel').hidden=!ctx().isHost;
    const select=get('qdCohost');if(doc.activeElement!==select){select.innerHTML='<option value="">Host only</option>'+next.participants.filter(p=>p.id!==next.hostId).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');select.value=state.cohostId||'';}
    const tasks=(next.tools||[]).filter(t=>t.kind==='tasks').flatMap(t=>t.data.items);
    get('qdOutcomes').textContent=`${tasks.filter(t=>t.done).length}/${tasks.length} tasks completed · ${ballots.filter(b=>!b.open).length} ballots closed`;
    get('qdCheckControl').hidden=!state.canManage;get('qdCheckControl').textContent=state.checkinOpen?'Close & share grouped results':'Open check-in';
    get('qdCheckStatus').textContent=state.checkinOpen?'Open':state.published?'Complete':'Not open';
    get('qdCheckChoices').hidden=!state.checkinOpen;
    panel.querySelectorAll('[data-check]').forEach(b=>{b.setAttribute('aria-pressed',String(!!state.myCheckin&&b.dataset.check===state.myCheckin));b.disabled=!ctx().joined;});
    get('qdMyCheck').textContent=state.myCheckin?'Your check-in is saved. You can revise or withdraw before closing.':state.checkinOpen?'Respond if you want to. Skipping has no penalty.':'';
    const result=get('qdCheckResults');
    if(state.round!==lastRound){lastRound=state.round;result.textContent='';}
    if(state.published){const p=state.published;result.textContent=p.withheld?'Fewer than 3 responses: details stay private. Offer context or a short pause to the whole room.':`${p.counts[0]} clear · ${p.counts[1]} need context · ${p.counts[2]} need a pause. ${p.counts[2]?'Offer a short pause.':p.counts[1]?'Recap the question and invite clarification.':'Check the objective, then agree the next step.'}`;}
  }
  function handleError(msg){get('qdError').textContent=msg.message;get('qdFocusError').textContent=msg.message;}
  function reset(){state=null;room=null;selected=null;lastRound=-1;seen.clear();cards.clear();get('qdCards').replaceChildren();get('qdTabs').replaceChildren();get('qdCheckResults').textContent='';studio.hidden=true;composer.open=true;composerTitle.textContent='Create a ballot';}
  updateRoom(ctx().room);
  return {updateRoom,handleError,reset};
}
if(typeof window!=='undefined'&&window.QuorumWorkspaceBridge) window.QuorumDecisionUI=createDecisionUI(window.QuorumWorkspaceBridge);
