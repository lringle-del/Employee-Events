/* ===== shared winter dashboard logic (loaded via <script src> on winter.html & admin.html) =====
   Plain classic script. Business logic that's genuinely identical between the two
   pages -- event/job state, the reminder sequence, email copy, and job-building --
   lives here once so neither page can drift out of sync with the other.
   Requires /lib/dashboard-shared.js (date helpers, esc, getSendPass, scheduleAction)
   to already be loaded first, and T0 to be defined by the including page. */

const FROM_NAME = "Above & Beyond ABA";
const REPLY_TO = "lringle@abtaba.com"; // every winter email: replies come to Liba, not the directors
const ORG_NAME = "Above and Beyond ABA Therapy"; // sender name on every winter email
const SITE_BASE = "https://summer-appreciation-event.vercel.app";
const RSVP_BASE = SITE_BASE+"/rsvp.html";
const ICS_BASE = SITE_BASE+"/api/ics";

let WINTER_EVENTS = [];
let SERVER_JOBS={}, SERVER_PLS={}, SERVER_DIRECTORS={}, AUD_COUNTS={}, RSVP_COUNTS={}, RSVP_ROSTERS={}, TEMPLATE_OVERRIDES={};

async function loadEvents(){ try{ const r=await fetch("/api/winter-events",{cache:"no-store"}); if(r.ok){ WINTER_EVENTS=(await r.json()).events||[]; } }catch{} }
async function loadSchedule(){ try{ const r=await fetch("/api/schedule",{cache:"no-store"}); if(r.ok){ SERVER_JOBS=(await r.json()).jobs||{}; } }catch{} }
async function loadPLs(){ try{ const r=await fetch("/api/pl",{cache:"no-store"}); if(r.ok){ SERVER_PLS=(await r.json()).pls||{}; } }catch{} }
async function loadDirectors(){ try{ const r=await fetch("/api/director",{cache:"no-store"}); if(r.ok){ SERVER_DIRECTORS=(await r.json()).directors||{}; } }catch{} }
async function loadAudiences(){ try{ const r=await fetch("/api/audience",{cache:"no-store"}); if(r.ok){ AUD_COUNTS=(await r.json()).counts||{}; } }catch{} }
async function loadRsvpCounts(){ try{ const r=await fetch("/api/rsvp",{cache:"no-store"}); if(r.ok){ const j=await r.json(); RSVP_COUNTS=j.counts||{}; RSVP_ROSTERS=j.rosters||{}; } }catch{} }
async function loadTemplateOverrides(){ try{ const r=await fetch("/api/winter-events?templates=1",{cache:"no-store"}); if(r.ok){ TEMPLATE_OVERRIDES=(await r.json()).overrides||{}; } }catch{} }

function getPL(id){ return SERVER_PLS[id]||{name:"",email:""}; }
function getDirector(id){ return SERVER_DIRECTORS[id]||""; }
function audienceCount(label){ const key="Winter "+label; return Object.prototype.hasOwnProperty.call(AUD_COUNTS,key)?AUD_COUNTS[key]:null; }
function rsvpCount(id){ return RSVP_COUNTS[id]||{yes:0,plusOnes:0,total:0}; }
// Rough count of invitees who haven't answered: list size minus answers received. Only an
// estimate; the server matches answers to the list by email at the moment the nudge sends.
function nudgeLeft(e){ const ac=audienceCount(e.label); return ac==null?0:Math.max(0,ac-Object.keys(RSVP_ROSTERS[e.id]||{}).length); }

function getStatus(id,key){
  const j=SERVER_JOBS[id+":"+key]; if(!j) return "draft";
  if(j.sentAt) return "sent";
  if(j.status==="skipped") return "skipped";
  if(j.status!=="approved") return "draft";
  if(j.okToSend) return "confirmed";
  if(j.previewSentAt) return "preview";
  return "scheduled";
}
function statusPill(status,rd){
  if(status==="sent")      return {cls:"c-sent", txt:"Sent ✓"};
  if(status==="skipped")   return {cls:"c-skip", txt:"Ignored"};
  if(status==="confirmed") return {cls:"c-appr", txt:"Approved ✓ · sends "+fmtShort(rd)};
  if(status==="preview")   return {cls:"c-due",  txt:"Preview sent — approve it"};
  if(status==="scheduled") return {cls:"c-sched",txt:"Scheduled · sends "+fmtShort(rd)};
  return {cls:"c-needs", txt:"Needs approval"};
}

/* ===== winter reminder sequence: Invite -> +2 day nudge (non-responders) -> 1 week
   before -> 1 day before. Gift-only locations get no automated email at all. ===== */
function winterReminders(e){
  if(e.giftOnly) return [];
  const list=[
    {kind:"att", key:"invite", abbr:"Invite", name:"Invite + RSVP", date:T0},
  ];
  // RSVP nudge: 2 days after the invite goes out, only to invitees who haven't answered yet.
  const inv=SERVER_JOBS[e.id+":invite"];
  const nudgeDate=addDays((inv&&inv.sendOn)?ymd(inv.sendOn):T0,2);
  if(!e.date || dbetween(ymd(e.date),nudgeDate)>0){
    list.push({kind:"att", key:"nudge", abbr:"Nudge · +2 days", name:"RSVP nudge (2 days after the invite, only people who haven't answered)", date:nudgeDate, onlyNonResponders:true});
  }
  if(e.date){
    const d=ymd(e.date);
    list.push({kind:"pl",  key:"pl3",  abbr:"PL · −3 days", name:"PL reminder (3 days before)", date:addDays(d,-3)});
    list.push({kind:"att", key:"att7", abbr:"−1 week", name:"Reminder (1 week before)", date:addDays(d,-7)});
    list.push({kind:"att", key:"att1", abbr:"−1 day",  name:"Reminder (1 day before)",  date:addDays(d,-1)});
  }
  return list;
}

/* ===== festive email copy =====
   Fields that differ only by event -- used both to generate each event's default
   wording and, when a wording edit is "applied to all locations" (see
   saveTemplateOverride in admin.html), to swap the source event's own values
   back out for every other event's values in the edited text. */
function templateFields(e){
  const place=e.city||e.state;
  const where=[e.venue,e.address].filter(Boolean).join(", ");
  const hasDate = !!e.date;
  const link = e.url ? `\n🔗 ${e.url}` : "";
  const details = hasDate ? `📅 ${fmtLong(ymd(e.date))}\n🕕 ${e.time||"time TBD"}\n📍 ${where||"venue TBD"}${link}` : "📅 Date & venue: coming soon!";
  const rsvpLink = RSVP_BASE+"?event="+e.id;
  const pl=getPL(e.id);
  return {place, details, rsvpLink, plName: pl.name||"there"};
}
// Generic stand-ins shown in the Admin page's top "Email wording" editor, which isn't
// tied to one real location -- bracketed so it's obviously a placeholder, not real
// content. Saving "for all locations" swaps these exact strings for each location's
// own values, the same way a per-card edit swaps that card's real values.
const PLACEHOLDER_FIELDS = {place:"[State]", details:"[Date & Venue]", rsvpLink:"[RSVP Link]", plName:"[Party Lead Name]"};
function applyFieldSwap(text, from, to){
  let out=text;
  Object.keys(from).sort((a,b)=>String(from[b]).length-String(from[a]).length).forEach(k=>{
    const fv=from[k], tv=to[k];
    if(fv && tv && fv!==tv) out=out.split(fv).join(tv);
  });
  return out;
}
function template(e,r){
  const base=renderTemplate(templateFields(e),e,r);
  // A per-event override ("Save" -- just this location) always wins over the
  // global one ("Save for all locations"); it's the exact text, no swap needed
  // since it was written for this specific event.
  const own=TEMPLATE_OVERRIDES[r.key+":"+e.id];
  if(own) return {...base, subject:own.subject, body:own.body};
  const ov=TEMPLATE_OVERRIDES[r.key];
  if(!ov) return base;
  let from;
  if(ov.sourceEventId){
    const src=WINTER_EVENTS.find(x=>x.id===ov.sourceEventId);
    if(!src) return base;
    from=templateFields(src);
  }else{
    from=PLACEHOLDER_FIELDS; // saved from the top editor, which uses placeholders instead of a real event
  }
  const to=templateFields(e);
  return {...base, subject:applyFieldSwap(ov.subject,from,to), body:applyFieldSwap(ov.body,from,to)};
}
// The example text shown in the Admin page's top editor -- placeholders instead of a
// real event's values, so it reads as a template rather than one location's actual email.
function placeholderTemplate(r){ return renderTemplate(PLACEHOLDER_FIELDS,null,r); }
function renderTemplate(fields,e,r){
  const {place, details, rsvpLink, plName} = fields;
  const rsvpLine = `\n\nLet us know you're coming (and if you're bringing a plus one):\n\n${rsvpLink}`;

  if(r.kind==="pl"){
    return {
      fromName: ORG_NAME,
      subject: `${place} Holiday Party: PL Details`,
      body: `Hi ${plName},\n\nThank you so much for helping lead the ${place} Winter Holiday Party. We're so excited to celebrate the team with you!\n\n${details}\n\nA couple of things to take care of:\n- Arrive early to help set up\n- Be there to help the event run smoothly\n- Take a few photos and send them our way afterward\n\nWe'll keep you posted as RSVPs come in. Thank you again for everything you do!\n\nWarm regards,\n${FROM_NAME}`
    };
  }
  if(r.key==="invite"){
    return {
      fromName: ORG_NAME,
      subject: `You're Invited: ${place} Winter Holiday Party`,
      flyerUrl: e?e.flyerUrl:undefined,
      body: `Dear Team,\n\nAs we wrap up another incredible year, we want to thank you for your hard work, dedication, and the difference you make every day. We're so grateful for all we've accomplished together, and we're looking forward to celebrating with you at our ${place} Winter Holiday Party!\n\n${details}\n\nPlease RSVP at your earliest convenience, and feel free to bring a guest.${rsvpLine}\n\nThank you for everything you do. We can't wait to celebrate with you.\n\nWarm regards,\nThe ${FROM_NAME} Team`
    };
  }
  if(r.key==="nudge"){
    return {
      fromName: ORG_NAME,
      subject: `Haven't RSVP'd yet? ${place} Holiday Party`,
      body: `Hi there,\n\nWe haven't heard from you yet about the ${place} Winter Holiday Party, and we'd love to celebrate with you!\n\n${details}\n\nPlease let us know whether you can make it (and if you're bringing a plus one):\n\n${rsvpLink}\n\nWe hope to see you there.\n\nWarm regards,\nThe ${FROM_NAME} Team`
    };
  }
  if(r.key==="att1"){
    return {
      fromName: ORG_NAME,
      subject: `🎉 Tomorrow's the day! ${place} Holiday Party`,
      body: `Hi there,\n\nTomorrow's the day! We can't wait to celebrate you and the whole team.\n\n${details}\n\nSee you soon, let's celebrate!\n\nWarm regards,\nThe ${FROM_NAME} Team`
    };
  }
  return { // att7
    fromName: ORG_NAME,
    subject: `🎁 1 Week Away: ${place} Holiday Party`,
    body: `Hi there,\n\nJust one week away! We're so looking forward to celebrating with you at the ${place} Winter Holiday Party.\n\n${details}\n\nHaven't RSVP'd yet? Let us know you're coming:\n\n${rsvpLink}\n\nWe can't wait to see you there.\n\nWarm regards,\nThe ${FROM_NAME} Team`
  };
}

/* Snapshot captured at approval time -- exactly what the daily job will send. Expects
   the including page to have editable subject/body fields with ids "subj:<eventId>:<key>"/
   "body:<eventId>:<key>" -- namespaced by event id since admin.html shows every location's
   fields in the DOM at once (unlike winter.html's single-event modal), so a plain "subj:<key>"
   id would collide across locations sharing the same reminder key. */
function buildJob(e,r){
  const sEl=document.getElementById("subj:"+e.id+":"+r.key), bEl=document.getElementById("body:"+e.id+":"+r.key);
  const t=template(e,r);
  const subject=sEl?sEl.value:t.subject;
  const body=bEl?bEl.value:t.body;
  const job={eventId:e.id,key:r.key,kind:r.kind,label:e.label,sendOn:isoDate(r.date),subject,body,replyTo:t.replyTo||REPLY_TO};
  if(t.fromName) job.fromName=t.fromName;
  if(t.flyerUrl) job.flyerUrl=t.flyerUrl;
  if(r.onlyNonResponders) job.onlyNonResponders=true; // the server leaves out anyone who has already RSVP'd
  const extraBcc=(e.extraBcc&&e.extraBcc.length)?e.extraBcc.slice():[];
  if(r.kind==="pl"){
    job.plEmail=getPL(e.id).email;
    const dir=getDirector(e.id);
    const bcc=(e.plBcc&&e.plBcc.length)?e.plBcc.slice():[];
    if(dir) bcc.push(dir);
    bcc.push(...extraBcc);
    if(bcc.length) job.bcc=bcc;
  }
  if(r.kind==="att"){
    const dir=(r.key==="att7"||r.key==="att1")?getDirector(e.id):"";
    const dirBcc=dir?[dir]:[];
    dirBcc.push(...extraBcc);
    if(dirBcc.length) job.dirBcc=dirBcc;
  }
  return job;
}

/* ===== approval actions, parameterized by eventId (no reliance on a single "open modal" global,
   so both winter.html's modal and admin.html's always-visible per-event sections can call these
   the same way). Expects the including page to define toast(msg) and refreshAll(). */
async function approveFor(eventId,key){
  const e=WINTER_EVENTS.find(x=>x.id===eventId);const r=winterReminders(e).find(x=>x.key===key);
  if(r.kind==="pl" && !getPL(eventId).email){ toast("Add the PL's email before approving."); return; }
  const ac=audienceCount(e.label);
  const who=r.kind==="pl"?getPL(eventId).email:(r.onlyNonResponders?("people on the "+e.label+" list who haven't answered yet (about "+nudgeLeft(e)+")"):((ac!=null?ac:0)+" recipients ("+e.label+")"));
  const sub=document.getElementById("subj:"+eventId+":"+key).value;
  const dueNow=dbetween(r.date,T0)<=0;
  if(!confirm(`Approve & schedule this email?\n\n"${sub}"\n\n${dueNow?"It will send AS SOON as you approve & send it (next step).":"It will send on "+fmtShort(r.date)+"."}`)) return;
  toast("Scheduling…");
  if(await scheduleAction(eventId+":"+key,"approve",buildJob(e,r),true)){
    refreshAll();
    toast("Scheduled ✓ — tap Approve & send to release it.");
  }
}
async function confirmSendFor(eventId,key){
  const e=WINTER_EVENTS.find(x=>x.id===eventId);const r=winterReminders(e).find(x=>x.key===key);
  const ac=audienceCount(e.label);
  const who=r.kind==="pl"?getPL(eventId).email:(r.onlyNonResponders?("people on the "+e.label+" list who haven't answered yet (about "+nudgeLeft(e)+")"):((ac!=null?ac:0)+" recipients ("+e.label+")"));
  const dueNow=dbetween(r.date,T0)<=0;
  if(!confirm(`Approve "${document.getElementById("subj:"+eventId+":"+key).value}"\n\nTo: ${who}\n${dueNow?"This will SEND now.":"It will send on "+fmtShort(r.date)+"."}\n\nProceed?`)) return;
  const pass=getSendPass(true); if(!pass){ toast("Passcode needed."); return; }
  toast("Approving…");
  // Whoever is signed in gets a copy of exactly what went out, even if it reached
  // zero real recipients -- admin.html sets ADMIN_EMAIL; winter.html has no sign-in
  // gate, so fall back to the owner's own address.
  const approverEmail=(typeof ADMIN_EMAIL!=="undefined"&&ADMIN_EMAIL)?ADMIN_EMAIL:REPLY_TO;
  try{
    const res=await fetch("/api/schedule",{method:"POST",headers:{"content-type":"application/json","x-send-passcode":pass},body:JSON.stringify({id:eventId+":"+key,action:"confirm",approverEmail})});
    const j=await res.json().catch(()=>({}));
    if(res.ok){
      const jb=SERVER_JOBS[eventId+":"+key]||{}; jb.status="approved"; jb.okToSend=true; if(j.status==="sent") jb.sentAt=new Date().toISOString(); SERVER_JOBS[eventId+":"+key]=jb;
      refreshAll();
      toast(j.sentNow?("✓ Sent to "+who+"."):("✓ Approved — will send "+fmtShort(r.date)+"."));
    }else if(res.status===401){ localStorage.removeItem("send_pass"); toast("Incorrect passcode — try again."); }
    else{ toast("Couldn't approve: "+(j.error||("HTTP "+res.status))); }
  }catch(err){ toast("Couldn't reach the server ("+err.message+")."); }
}
async function revokeFor(eventId,key){ if(await scheduleAction(eventId+":"+key,"remove")){ refreshAll(); toast("Reverted to Not scheduled."); } }
async function skipFor(eventId,key){ if(await scheduleAction(eventId+":"+key,"skip")){ refreshAll(); } }
async function restoreFor(eventId,key){ if(await scheduleAction(eventId+":"+key,"remove")){ refreshAll(); } }
function copyMail(eventId,key){
  const s=document.getElementById("subj:"+eventId+":"+key).value, b=document.getElementById("body:"+eventId+":"+key).value;
  navigator.clipboard.writeText("Subject: "+s+"\n\n"+b).then(()=>toast("Email copied to clipboard."));
}
