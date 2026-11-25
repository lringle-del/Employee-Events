/* ===== shared dashboard helpers (loaded via <script src> on events.html & dashboard.html) =====
   Plain classic script (not an ES module) so both pages can load it the same way.
   Pure date/format helpers + the passcode-gated /api/schedule glue — business logic
   that genuinely differs between dashboards (reminders/template/buildJob) stays
   page-local on purpose; see the Winter Holiday Parties plan for the reasoning. */

const MO = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
const MOL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WD = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const WDL = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

function ymd(s){const[y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d);}
function today0(){const n=new Date();return new Date(n.getFullYear(),n.getMonth(),n.getDate());}
function addDays(dt,n){const x=new Date(dt);x.setDate(x.getDate()+n);return x;}
function dbetween(a,b){return Math.round((a-b)/86400000);}
function fmtShort(dt){return WD[dt.getDay()]+" "+MO[dt.getMonth()].charAt(0)+MO[dt.getMonth()].slice(1).toLowerCase()+" "+dt.getDate();}
function fmtLong(dt){return WDL[dt.getDay()]+", "+MOL[dt.getMonth()]+" "+dt.getDate();}
function money(n){return n==null?null:"$"+n.toLocaleString("en-US");}
function esc(s){return(s==null?"":String(s)).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function isoDate(dt){ return dt.getFullYear()+"-"+String(dt.getMonth()+1).padStart(2,"0")+"-"+String(dt.getDate()).padStart(2,"0"); }

function getSendPass(force){
  let p=force?null:localStorage.getItem("send_pass");
  if(!p){ p=(prompt("Enter the send passcode (set as SEND_PASSCODE in Vercel):")||"").trim(); if(p) localStorage.setItem("send_pass",p); }
  return p;
}

/* Expects the including page to declare `let SERVER_JOBS = {};` and a `toast(msg)` function.
   Pass forcePass=true for actions that actually schedule/send real mail (approve, confirm
   send) so the passcode is always re-entered even if it's already cached from an earlier,
   lower-stakes edit (date, PL, BCC, etc.) this session. */
async function scheduleAction(id,action,job,forcePass){
  const pass=getSendPass(forcePass); if(!pass){ toast("Passcode needed."); return false; }
  try{
    const res=await fetch("/api/schedule",{method:"POST",headers:{"content-type":"application/json","x-send-passcode":pass},body:JSON.stringify({id,action,job})});
    const j=await res.json().catch(()=>({}));
    if(res.ok){
      if(action==="remove") delete SERVER_JOBS[id];
      else SERVER_JOBS[id]={status:j.status,sentAt:null,sendOn:job?job.sendOn:(SERVER_JOBS[id]&&SERVER_JOBS[id].sendOn)};
      return true;
    }
    if(res.status===401){ localStorage.removeItem("send_pass"); toast("Incorrect passcode — try again."); }
    else if(res.status===501){ toast("Server not fully configured: "+(j.error||"")); }
    else toast("Couldn't save: "+(j.error||("HTTP "+res.status)));
  }catch(err){ toast("Couldn't reach the server ("+err.message+")."); }
  return false;
}
