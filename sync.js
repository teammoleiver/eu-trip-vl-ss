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
  function unlockSync(){
    var pw=prompt("Enter your documents/vault password to unlock sync:"); if(!pw) return;
    try{ sessionStorage.setItem("vault_pw",pw); }catch(e){}
    ensureUnlocked().then(function(ok){ if(ok) pull(); else { setChip("locked"); alert("Wrong password, or sync isn't set up on this device."); } });
  }
  function setupSync(){
    var pw=sessionStorage.getItem("vault_pw")||prompt("Enter your documents/vault password (used to encrypt the sync):"); if(!pw) return;
    var tok=prompt("Paste a GitHub token with Contents read/write on "+OWNER+"/"+REPO+".\nCreate one at: github.com/settings/personal-access-tokens"); if(!tok) return;
    tok=tok.replace(/\s+/g,"");
    setChip("sync");
    derive(pw).then(function(k){ KEY=k; TOKEN=tok;
      return fetch("https://api.github.com/repos/"+OWNER+"/"+REPO,{headers:ghHeaders()}).then(function(r){ if(!r.ok) throw new Error("token/repo check failed ("+r.status+") — check the token has Contents access to this repo"); return enc(tok); });
    }).then(function(blob){ localStorage.setItem("sync_gh",blob); try{ sessionStorage.setItem("vault_pw",pw); }catch(e){}
      alert("✅ Sync connected! Edits now save to your GitHub repo (encrypted) and load on every device where you turn on sync with the same password.");
      pull();
    }).catch(function(e){ KEY=null;TOKEN=null; setChip("off"); alert("Couldn't connect sync: "+e.message); });
  }
  function disconnect(){ if(confirm("Turn off sync on THIS device? Your data in the repo stays; other devices keep syncing.")){ localStorage.removeItem("sync_gh"); TOKEN=null;KEY=null; setChip("off"); } }

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
    var s=chipEl()._state;
    if(s==="off") setupSync();
    else if(s==="locked") unlockSync();
    else if(s==="err"){ if(TOKEN&&KEY){ setChip("sync"); ghGet().then(function(){ doPush(); }).catch(function(e){ setChip("err",e.message); }); } else unlockSync(); }
    else { if(confirm("Sync is on ✅\n\nOK = sync now\nCancel = options")){ pull(); } else { disconnect(); } }
  }

  /* ---------- init ---------- */
  function init(){
    if(!localStorage.getItem("sync_gh")){ setChip("off"); return; }
    ensureUnlocked().then(function(ok){
      if(!ok){ setChip("locked"); return; }
      if(sessionStorage.getItem("sync_done")){ setChip("ok"); return; }   // already pulled this session
      pull();
    });
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",init); else init();
})();
