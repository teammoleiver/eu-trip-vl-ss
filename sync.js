/* ===================================================================
   Cross-device sync via the user's own GitHub repo.
   - App state (localStorage) is encrypted with the vault password
     (AES-256-GCM, PBKDF2-SHA256 250k) and stored as sync/state.json.
   - A GitHub fine-grained token (Contents: read/write) is stored
     ENCRYPTED in localStorage on this device only (never in the repo).
   - One pull+apply per browser session; every edit pushes (debounced).
   Include with <script src="sync.js" defer></script> on every page.
   =================================================================== */
(function(){
  if(!(window.crypto && crypto.subtle && window.localStorage)) return;
  var OWNER="teammoleiver", REPO="eu-trip-vl-ss", BRANCH="main", FILE="sync/state.json";
  var SALT="eu-trip-sync-salt-v1";
  // keys we never sync: login flag, cached password, the token itself, device-only AI key
  var EXCLUDE={eu_auth_v1:1, vault_pw:1, sync_gh:1, border_ai_key:1};
  var TOKEN=null, KEY=null, SHA=null, applying=false, pushT=null;

  /* ---------- crypto ---------- */
  function b2b64(u){ var s="";for(var i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);return btoa(s); }
  function b64b(b){ b=(b||"").trim();var bin=atob(b);var u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u; }
  function derive(pw){
    return crypto.subtle.importKey("raw",new TextEncoder().encode(pw),"PBKDF2",false,["deriveKey"])
      .then(function(km){ return crypto.subtle.deriveKey({name:"PBKDF2",salt:new TextEncoder().encode(SALT),iterations:250000,hash:"SHA-256"},km,{name:"AES-GCM",length:256},false,["encrypt","decrypt"]); });
  }
  function enc(str){ var iv=crypto.getRandomValues(new Uint8Array(12)); return crypto.subtle.encrypt({name:"AES-GCM",iv:iv},KEY,new TextEncoder().encode(str)).then(function(ct){ return JSON.stringify({iv:b2b64(iv),ct:b2b64(new Uint8Array(ct))}); }); }
  function dec(blob){ var o=JSON.parse(blob); return crypto.subtle.decrypt({name:"AES-GCM",iv:b64b(o.iv)},KEY,b64b(o.ct)).then(function(pt){ return new TextDecoder().decode(new Uint8Array(pt)); }); }

  /* ---------- github contents API ---------- */
  function ghHeaders(){ return {Authorization:"Bearer "+TOKEN, Accept:"application/vnd.github+json"}; }
  function ghGet(){
    return fetch("https://api.github.com/repos/"+OWNER+"/"+REPO+"/contents/"+FILE+"?ref="+BRANCH+"&t="+Date.now(),{headers:ghHeaders(),cache:"no-store"})
      .then(function(r){ if(r.status===404){ SHA=null; return null; } if(!r.ok) throw new Error("GET "+r.status); return r.json(); })
      .then(function(j){ if(!j) return null; SHA=j.sha; return decodeURIComponent(escape(atob((j.content||"").replace(/\s/g,"")))); });
  }
  function ghPut(contentStr, retry){
    var body={message:"sync "+new Date().toISOString(), content:btoa(unescape(encodeURIComponent(contentStr))), branch:BRANCH};
    if(SHA) body.sha=SHA;
    return fetch("https://api.github.com/repos/"+OWNER+"/"+REPO+"/contents/"+FILE,{method:"PUT",headers:Object.assign({"Content-Type":"application/json"},ghHeaders()),body:JSON.stringify(body)})
      .then(function(r){
        if((r.status===409||r.status===422) && !retry){ return ghGet().then(function(){ return ghPut(contentStr,true); }); }
        if(!r.ok) return r.text().then(function(t){ throw new Error("PUT "+r.status+": "+t.slice(0,140)); });
        return r.json();
      })
      .then(function(j){ if(j&&j.content) SHA=j.content.sha; });
  }

  /* ---------- state gather / apply ---------- */
  function gather(){ var o={}; for(var i=0;i<localStorage.length;i++){ var k=localStorage.key(i); if(EXCLUDE[k]) continue; o[k]=localStorage.getItem(k); } return {v:1, at:Date.now(), data:o}; }
  function applyState(obj){
    if(!obj||!obj.data) return false;
    applying=true; var changed=false, k;
    for(k in obj.data){ if(EXCLUDE[k]) continue; if(localStorage.getItem(k)!==obj.data[k]){ localStorage.setItem(k,obj.data[k]); changed=true; } }
    applying=false; return changed;
  }

  /* ---------- push (debounced) ---------- */
  function schedulePush(){ if(applying||!KEY||!TOKEN) return; if(pushT) clearTimeout(pushT); setChip("saving"); pushT=setTimeout(doPush,2000); }
  function doPush(){ if(!KEY||!TOKEN) return; enc(JSON.stringify(gather())).then(ghPut).then(function(){ setChip("ok"); }).catch(function(e){ setChip("err",e.message); }); }
  var _set=Storage.prototype.setItem;
  Storage.prototype.setItem=function(k,v){ _set.apply(this,arguments); try{ if(this===window.localStorage && !EXCLUDE[k]) schedulePush(); }catch(e){} };

  /* ---------- pull (once per session) ---------- */
  function pull(){
    setChip("sync");
    return ghGet().then(function(str){
      sessionStorage.setItem("sync_done","1");
      if(!str){ setChip("ok"); doPush(); return; }        // nothing stored yet -> seed from this device
      return dec(str).then(function(json){
        var changed=applyState(JSON.parse(json));
        setChip("ok");
        if(changed) location.reload();                      // apply pulled data, then re-render once
      }).catch(function(e){ setChip("err","decrypt "+e.message); });
    }).catch(function(e){ setChip("err",e.message); });
  }

  /* ---------- unlock / setup ---------- */
  function ensureUnlocked(){
    var pw=sessionStorage.getItem("vault_pw"), blob=localStorage.getItem("sync_gh");
    if(!blob||!pw) return Promise.resolve(false);
    return derive(pw).then(function(k){ KEY=k; return dec(blob); }).then(function(t){ TOKEN=t; return true; }).catch(function(){ KEY=null;TOKEN=null; return false; });
  }
  /* ---------- settings panel (modal) ---------- */
  var MODAL=null;
  function elc(tag,css,html){ var e=document.createElement(tag); if(css)e.style.cssText=css; if(html!=null)e.innerHTML=html; return e; }
  function buildModal(){
    if(MODAL) return MODAL;
    MODAL=elc("div","position:fixed;inset:0;z-index:100000;background:rgba(16,33,75,.55);display:none;align-items:center;justify-content:center;padding:20px;font-family:'IBM Plex Sans',system-ui,sans-serif");
    MODAL.id="syncModal";
    var card=elc("div","background:#fff;border-radius:16px;max-width:450px;width:100%;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.4)");
    card.innerHTML='<div style="font-family:\'Saira Condensed\',sans-serif;font-weight:800;text-transform:uppercase;font-size:1.35rem;color:#10214B">☁️ Cross-device sync</div>'
      +'<p id="smMsg" style="color:#464C5A;font-size:.9rem;margin:8px 0 14px"></p>'
      +'<div id="smFields"></div><div id="smBtns" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px"></div>'
      +'<div id="smErr" style="color:#B3423A;font-size:.82rem;margin-top:10px;min-height:1em"></div>';
    MODAL.appendChild(card);
    MODAL.addEventListener("click",function(e){ if(e.target===MODAL) hideModal(); });
    (document.body||document.documentElement).appendChild(MODAL);
    return MODAL;
  }
  function hideModal(){ if(MODAL) MODAL.style.display="none"; }
  function mkBtn(label,style,fn){ var b=elc("button",null,label); b.style.cssText="border:none;border-radius:9px;padding:11px 18px;font-weight:800;font-family:'Saira Condensed',sans-serif;text-transform:uppercase;letter-spacing:.03em;font-size:.95rem;cursor:pointer;"+style; b.onclick=fn; return b; }
  function inRow(id,label,ph){ return '<div style="margin-bottom:10px"><label style="display:block;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:#464C5A;font-weight:700;margin-bottom:4px">'+label+'</label><input id="'+id+'" type="password" placeholder="'+(ph||"")+'" autocomplete="off" style="width:100%;box-sizing:border-box;border:1px solid #D8DCE6;border-radius:9px;padding:11px 12px;font-size:16px"></div>'; }
  function show(mode){
    buildModal(); MODAL.style.display="flex";
    var msg=document.getElementById("smMsg"), fields=document.getElementById("smFields"), btns=document.getElementById("smBtns"), err=document.getElementById("smErr");
    btns.innerHTML=""; err.textContent="";
    if(mode==="setup"){
      var pwCached=!!sessionStorage.getItem("vault_pw");
      msg.innerHTML="Save your edits to your own GitHub repo (encrypted) so they appear on every device. You need a GitHub token with <b>Contents: read &amp; write</b> on <b>"+OWNER+"/"+REPO+"</b> — create it at github.com/settings/personal-access-tokens.";
      fields.innerHTML=(pwCached?"":inRow("smPw","Documents / vault password",""))+inRow("smTok","GitHub token (github_pat_…)","");
      btns.appendChild(mkBtn("Connect","background:#1E7A46;color:#fff",doConnect));
      btns.appendChild(mkBtn("Cancel","background:#EEF1F7;color:#10214B",hideModal));
    } else if(mode==="unlock"){
      msg.textContent="Enter your documents / vault password to unlock sync on this device.";
      fields.innerHTML=inRow("smPw","Vault password","");
      btns.appendChild(mkBtn("Unlock","background:#1E7A46;color:#fff",doUnlock));
      btns.appendChild(mkBtn("Not now","background:#EEF1F7;color:#10214B",function(){ try{sessionStorage.setItem("sync_snooze","1");}catch(e){} hideModal(); }));
      setTimeout(function(){ var i=document.getElementById("smPw"); if(i) i.focus(); },60);
    } else { /* status */
      msg.innerHTML="Sync is <b>on</b> ✅ — edits save to your GitHub repo (encrypted) and load on every device unlocked with the same password.";
      fields.innerHTML="";
      btns.appendChild(mkBtn("Sync now","background:#1B3C8C;color:#fff",function(){ hideModal(); setChip("sync"); ghGet().then(function(str){ if(str) return dec(str).then(function(j){ applyState(JSON.parse(j)); }); }).then(function(){ doPush(); setChip("ok"); }).catch(function(e){ setChip("err",e.message); }); }));
      btns.appendChild(mkBtn("Close","background:#EEF1F7;color:#10214B",hideModal));
      btns.appendChild(mkBtn("Disconnect","background:#F3E4E2;color:#B3423A",function(){ localStorage.removeItem("sync_gh"); TOKEN=null;KEY=null; hideModal(); setChip("off"); }));
    }
  }
  function doConnect(){
    var pw=sessionStorage.getItem("vault_pw")||(document.getElementById("smPw")?document.getElementById("smPw").value:"");
    var tok=(document.getElementById("smTok").value||"").replace(/\s+/g,""); var err=document.getElementById("smErr");
    if(!pw){ err.textContent="Enter your vault password."; return; }
    if(!tok){ err.textContent="Paste your GitHub token."; return; }
    err.textContent="Connecting…";
    derive(pw).then(function(k){ KEY=k; TOKEN=tok;
      return fetch("https://api.github.com/repos/"+OWNER+"/"+REPO,{headers:ghHeaders()}).then(function(r){ if(!r.ok) throw new Error("Token/repo check failed ("+r.status+"). Give the token Contents read/write on "+OWNER+"/"+REPO+"."); return enc(tok); });
    }).then(function(blob){ localStorage.setItem("sync_gh",blob); try{sessionStorage.setItem("vault_pw",pw);}catch(e){} hideModal(); setChip("sync"); pull(); })
    .catch(function(e){ KEY=null;TOKEN=null; err.textContent=e.message; });
  }
  function doUnlock(){
    var pw=document.getElementById("smPw").value, err=document.getElementById("smErr");
    if(!pw){ err.textContent="Enter your password."; return; }
    try{sessionStorage.setItem("vault_pw",pw);}catch(e){} err.textContent="Unlocking…";
    ensureUnlocked().then(function(ok){ if(ok){ hideModal(); pull(); } else { try{sessionStorage.removeItem("vault_pw");}catch(e){} err.textContent="Wrong password, or sync isn't set up on this device."; } });
  }

  /* ---------- status chip ---------- */
  function chipEl(){
    var c=document.getElementById("syncChip");
    if(!c){ c=document.createElement("div"); c.id="syncChip";
      c.style.cssText="position:fixed;bottom:14px;right:14px;z-index:9998;background:#10214B;color:#fff;font:600 12px/1.2 'IBM Plex Sans',system-ui,sans-serif;padding:8px 12px;border-radius:999px;box-shadow:0 4px 14px rgba(0,0,0,.28);cursor:pointer;user-select:none";
      c.onclick=chipClick; (document.body||document.documentElement).appendChild(c); }
    return c;
  }
  function setChip(state,extra){ var c=chipEl(); var m={sync:"☁️ syncing…",saving:"☁️ saving…",ok:"✅ synced",err:"⚠️ sync error (tap)",locked:"🔒 sync — tap to unlock",off:"☁️ set up sync"}; c.textContent=m[state]||state; c.title=extra||(state==="off"?"Save your edits across all devices":""); c._state=state; }
  function chipClick(){
    if(!localStorage.getItem("sync_gh")) return show("setup");
    if(!(KEY&&TOKEN)) return show("unlock");
    return show("status");
  }

  /* ---------- init ---------- */
  function afterGate(cb){
    if(!document.getElementById("authGate")){ cb(); return; }
    var t=setInterval(function(){ if(!document.getElementById("authGate")){ clearInterval(t); cb(); } },400);
    setTimeout(function(){ clearInterval(t); },90000);
  }
  function init(){
    if(!localStorage.getItem("sync_gh")){ setChip("off"); return; }
    ensureUnlocked().then(function(ok){
      if(ok){ if(sessionStorage.getItem("sync_done")) setChip("ok"); else pull(); return; }
      setChip("locked");
      afterGate(function(){ if(!(KEY&&TOKEN) && !sessionStorage.getItem("sync_snooze")) show("unlock"); });   // auto-prompt to unlock once per session
    });
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",init); else init();
})();
