(() => {
"use strict";

const STORAGE_KEY = "leadflow_local_v1";
const SETTINGS_KEY = "leadflow_settings_v1";

const APIFY_FORM_KEY = "leadflow_apify_form_v1";


const STATUSES = [
  "Não contatado",
  "Mensagem enviada",
  "Respondeu",
  "Aceitou ver",
  "Demo enviada",
  "Proposta enviada",
  "Fechado",
  "Sem interesse"
];

const DEFAULT_SETTINGS = {
  messageTemplateWithSite:
    "Oi {empresa}, vocês ainda estão abertos?\n\nEncontrei algumas coisas quebradas no seu site. Não tinha se vocês ainda funcionam.\n\nEu já criei um novo site para você e corrigi algumas coisas que vão ajudar a atrair clientes. Você quer ver sem compromisso?",
  messageTemplateWithoutSite:
    "Oi {empresa}, você ainda atua como {categoria}?\n\nTe procurei na internet e não encontrei nenhum site.\n\nEu criei um site para você e corrigi algumas coisas que vão ajudar a atrair clientes. Você quer ver sem compromisso?",
  defaultCountryCode: "55",
  weights: {
    noSite: 35,
    badSite: 25,
    reviews20: 20,
    rating45: 10,
    phone: 10,
    tooManyReviews: -15,
    franchise: -30
  }
};

let leads = [];
let supabaseClient = null;
let currentUser = null;
let realtimeChannel = null;
let activityRequestSeq = 0;
let settings = deepMerge(DEFAULT_SETTINGS, loadJSON(SETTINGS_KEY, {}));
let currentQueue = "new";
let selectedLeadId = null;
let skippedIds = new Set();
let tableFiltered = [];

let lastApifyLeads = [];
let currentApifyRun = null;


const $ = id => document.getElementById(id);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function loadJSON(key, fallback){
  try{
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  }catch{return fallback}
}
function saveJSON(key,val){ localStorage.setItem(key, JSON.stringify(val)); }
function deepMerge(base, override){
  const out = JSON.parse(JSON.stringify(base));
  Object.keys(override || {}).forEach(k=>{
    if(typeof override[k]==="object" && override[k] && !Array.isArray(override[k]) && typeof out[k]==="object"){
      out[k]=deepMerge(out[k],override[k]);
    }else out[k]=override[k];
  });
  return out;
}
function uid(){ return "lead_"+Date.now().toString(36)+"_"+Math.random().toString(36).slice(2,8); }
function norm(v){ return String(v ?? "").trim(); }
function digits(v){ return String(v ?? "").replace(/\D/g,""); }
function num(v){
  if(typeof v==="number") return v;
  let s=norm(v);
  if(!s) return 0;
  if(s.includes(",") && s.includes(".")) s=s.replace(/\./g,"").replace(",",".");
  else s=s.replace(",",".");
  const n=Number(s);
  return Number.isFinite(n)?n:0;
}
function rating(v){
  const n=parseFloat(norm(v).replace(",","."));
  return Number.isFinite(n)?n:0;
}
function esc(v){
  return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
}
function safeUrl(v){
  let s=norm(v);
  if(!s) return "";
  if(!/^https?:\/\//i.test(s)) s="https://"+s;
  try{
    const u=new URL(s);
    return ["http:","https:"].includes(u.protocol)?u.href:"";
  }catch{return ""}
}
function setSyncState(state,text){
  const el=$("syncIndicator"); if(!el)return;
  el.className="sync-indicator"+(state?` ${state}`:"");
  el.textContent=text||"Sincronizado";
}
function leadToRow(l){
  return {
    id:l.id, place_id:l.placeId||null, name:l.name, phone:l.phone||null, website:l.website||null,
    site_quality:l.siteQuality||"none", rating:Number(l.rating||0), reviews:Number(l.reviews||0),
    category:l.category||null, address:l.address||null, city:l.city||null, state:l.state||null,
    maps_url:l.mapsUrl||null, status:l.status||"Não contatado", notes:l.notes||null,
    followup:l.followup||null, franchise:Boolean(l.franchise), sent_at:l.sentAt||null,
    replied_at:l.repliedAt||null, last_contact_at:l.lastContactAt||null,
    created_at:l.createdAt||new Date().toISOString(), updated_at:l.updatedAt||new Date().toISOString()
  };
}
function rowToLead(r){
  return {
    id:r.id, placeId:r.place_id||"", name:r.name||"Empresa sem nome", phone:r.phone||"",
    website:r.website||"", siteQuality:r.site_quality||(r.website?"unknown":"none"),
    rating:Number(r.rating||0), reviews:Number(r.reviews||0), category:r.category||"", address:r.address||"",
    city:r.city||"", state:r.state||"", mapsUrl:r.maps_url||"", status:r.status||"Não contatado",
    notes:r.notes||"", followup:r.followup||"", franchise:Boolean(r.franchise), sentAt:r.sent_at||"",
    repliedAt:r.replied_at||"", lastContactAt:r.last_contact_at||"",
    createdAt:r.created_at||new Date().toISOString(), updatedAt:r.updated_at||new Date().toISOString()
  };
}
async function persist(changedLeads=leads){
  if(!supabaseClient||!currentUser)return;
  const arr=Array.isArray(changedLeads)?changedLeads:[changedLeads];
  if(!arr.length)return;
  setSyncState("syncing","Salvando...");
  const {error}=await supabaseClient.from("leads").upsert(arr.map(leadToRow),{onConflict:"id"});
  if(error){console.error(error);setSyncState("error","Erro ao salvar");toast("Falha ao sincronizar com o Supabase.");return false}
  setSyncState("","Sincronizado");return true;
}
async function persistSettings(){
  saveJSON(SETTINGS_KEY,settings);
  if(!supabaseClient||!currentUser)return;
  const {error}=await supabaseClient.from("app_settings").upsert({id:1,settings,updated_at:new Date().toISOString()},{onConflict:"id"});
  if(error)console.error(error);
}
async function addActivity(leadId,type,description=""){
  if(!supabaseClient||!currentUser||!leadId)return;
  const {error}=await supabaseClient.from("activities").insert({lead_id:leadId,user_id:currentUser.id,type,description:description||null});
  if(error)console.error(error);
}
async function loadActivities(leadId){
  const seq=++activityRequestSeq;
  const box=$("activityList"); if(!box)return;
  box.innerHTML='<span class="activity-empty">Carregando...</span>';
  if(!supabaseClient||!leadId)return;
  const {data,error}=await supabaseClient.from("activities").select("id,type,description,created_at").eq("lead_id",leadId).order("created_at",{ascending:false}).limit(8);
  if(seq!==activityRequestSeq)return;
  if(error){box.innerHTML='<span class="activity-empty">Não foi possível carregar o histórico.</span>';return}
  if(!data?.length){box.innerHTML='<span class="activity-empty">Nenhuma atividade ainda.</span>';return}
  box.innerHTML=data.map(a=>`<div class="activity-item"><span class="activity-dot"></span><div><strong>${esc(a.type)}</strong>${a.description?`<p>${esc(a.description)}</p>`:""}</div><small>${formatDateTime(a.created_at)}</small></div>`).join("");
}
async function loadCloudData(){
  setSyncState("syncing","Sincronizando...");
  const [{data:leadRows,error:leadErr},{data:settingsRows,error:settingsErr}]=await Promise.all([
    supabaseClient.from("leads").select("*").order("created_at",{ascending:false}),
    supabaseClient.from("app_settings").select("settings").eq("id",1).maybeSingle()
  ]);
  if(leadErr)throw leadErr;
  leads=(leadRows||[]).map(rowToLead);
  if(!settingsErr&&settingsRows?.settings)settings=deepMerge(DEFAULT_SETTINGS,settingsRows.settings);
  setSyncState("","Sincronizado");
}
function setupRealtime(){
  if(realtimeChannel)supabaseClient.removeChannel(realtimeChannel);
  realtimeChannel=supabaseClient.channel("leadflow-leads")
    .on("postgres_changes",{event:"*",schema:"public",table:"leads"},async()=>{
      if(!currentUser)return;
      const {data,error}=await supabaseClient.from("leads").select("*").order("created_at",{ascending:false});
      if(!error){leads=(data||[]).map(rowToLead);renderAll();}
    }).subscribe();
}

function persistSettings(){ saveJSON(SETTINGS_KEY,settings); }
function formatDateTime(iso){
  if(!iso) return "—";
  const d=new Date(iso);
  if(Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR",{day:"2-digit",month:"2-digit",hour:"2-digit",minute:"2-digit"}).format(d);
}
function formatDateBR(v){
  if(!v) return "—";
  const [y,m,d]=v.split("-");
  return `${d}/${m}/${y}`;
}
function addDaysISO(days){
  const d=new Date();
  d.setDate(d.getDate()+days);
  return d.toISOString().slice(0,10);
}
function statusSlug(s){ return norm(s).replaceAll(" ","-"); }

function scoreLead(lead){
  const w=settings.weights;
  let s=0;
  if(!lead.website) s+=Number(w.noSite||0);
  else if(lead.siteQuality==="bad") s+=Number(w.badSite||0);
  if(Number(lead.reviews)>=20) s+=Number(w.reviews20||0);
  if(Number(lead.rating)>=4.5) s+=Number(w.rating45||0);
  if(lead.phone) s+=Number(w.phone||0);
  if(Number(lead.reviews)>=500) s+=Number(w.tooManyReviews||0);
  if(lead.franchise) s+=Number(w.franchise||0);
  return Math.max(0,Math.round(s));
}
function priority(score){
  if(score>=80)return"hot";
  if(score>=60)return"good";
  if(score>=40)return"medium";
  return"low";
}
function siteQuality(lead){
  if(!lead.website)return"none";
  return lead.siteQuality || "unknown";
}
function siteLabel(lead){
  return ({none:"Sem site",unknown:"Site não analisado",bad:"Site ruim",ok:"Site razoável",good:"Site bom"})[siteQuality(lead)] || "Site não analisado";
}
function templateMessage(lead){
  const template=lead.website?settings.messageTemplateWithSite:settings.messageTemplateWithoutSite;
  return String(template||"")
    .replaceAll("{empresa}",lead.name||"sua empresa")
    .replaceAll("{cidade}",lead.city||"sua região")
    .replaceAll("{categoria}",lead.category||"seu segmento");
}
function whatsappPhone(phone){
  let d=digits(phone);
  const ddi=digits(settings.defaultCountryCode||"55");
  if(!d)return"";
  d=d.replace(/^0+/,"");
  if(ddi && !d.startsWith(ddi) && d.length<=11)d=ddi+d;
  return d;
}
function whatsappUrl(lead){
  const p=whatsappPhone(lead.phone);
  if(!p)return"";
  return `https://wa.me/${p}?text=${encodeURIComponent(templateMessage(lead))}`;
}
function toast(msg){
  const t=document.createElement("div");
  t.className="toast";t.textContent=msg;$("toastWrap").appendChild(t);
  setTimeout(()=>t.remove(),2800);
}

function switchView(name){
  $$(".view").forEach(v=>v.classList.remove("active"));
  $$(".nav-btn").forEach(b=>b.classList.remove("active"));
  $("view-"+name)?.classList.add("active");
  document.querySelector(`.nav-btn[data-view="${name}"]`)?.classList.add("active");
  if(name==="prospect")renderProspect();
  if(name==="leads")renderLeadsTable();
  if(name==="import")loadApifyForm();
  if(name==="settings")renderSettings();
}

function normalizeLeads(){
  leads=leads.map(l=>({
    id:l.id||uid(),
    placeId:l.placeId||"",
    name:l.name||l.title||"Empresa sem nome",
    phone:l.phone||"",
    website:l.website||"",
    siteQuality:l.siteQuality || (l.website?"unknown":"none"),
    rating:Number(l.rating||0),
    reviews:Number(l.reviews||0),
    category:l.category||"",
    address:l.address||"",
    city:l.city||"",
    state:l.state||"",
    mapsUrl:l.mapsUrl||l.url||"",
    status:l.status||"Não contatado",
    notes:l.notes||"",
    followup:l.followup||"",
    franchise:Boolean(l.franchise),
    sentAt:l.sentAt||"",
    repliedAt:l.repliedAt||"",
    lastContactAt:l.lastContactAt||l.sentAt||"",
    createdAt:l.createdAt||new Date().toISOString(),
    updatedAt:l.updatedAt||new Date().toISOString()
  }));
}

function queuePredicate(lead){
  if(currentQueue==="new") return lead.status==="Não contatado";
  if(currentQueue==="hot") return lead.status==="Não contatado" && scoreLead(lead)>=80;
  if(currentQueue==="sent") return lead.status==="Mensagem enviada";
  if(currentQueue==="followup") return Boolean(lead.followup) && !["Fechado","Sem interesse"].includes(lead.status);
  return true;
}
function currentQueueLeads(){
  const search=$("queueSearch").value.trim().toLowerCase();
  const siteFilter=$("queueSiteFilter").value;
  return leads
    .filter(queuePredicate)
    .filter(l=>!skippedIds.has(l.id) || currentQueue!=="new")
    .filter(l=>{
      const hay=[l.name,l.city,l.category,l.phone].join(" ").toLowerCase();
      if(search && !hay.includes(search))return false;
      if(siteFilter==="none" && l.website)return false;
      if(siteFilter==="has" && !l.website)return false;
      if(siteFilter==="bad" && siteQuality(l)!=="bad")return false;
      return true;
    })
    .sort((a,b)=>scoreLead(b)-scoreLead(a) || Number(b.reviews)-Number(a.reviews));
}

function updateCounters(){
  const newCount=leads.filter(l=>l.status==="Não contatado").length;
  const sentCount=leads.filter(l=>l.status==="Mensagem enviada").length;
  const replies=leads.filter(l=>["Respondeu","Aceitou ver","Demo enviada","Proposta enviada","Fechado"].includes(l.status)).length;
  const closed=leads.filter(l=>l.status==="Fechado").length;
  const hot=leads.filter(l=>l.status==="Não contatado" && scoreLead(l)>=80).length;
  const follow=leads.filter(l=>l.followup && !["Fechado","Sem interesse"].includes(l.status)).length;

  $("statNew").textContent=newCount;
  $("statSent").textContent=sentCount;
  $("statReplies").textContent=replies;
  $("statClosed").textContent=closed;
  $("countNew").textContent=newCount;
  $("countHot").textContent=hot;
  $("countSent").textContent=sentCount;
  $("countFollowup").textContent=follow;
  $("countAll").textContent=leads.length;
}

function renderProspect(){
  updateCounters();
  const list=currentQueueLeads();

  if(selectedLeadId && !list.some(l=>l.id===selectedLeadId)){
    selectedLeadId=list[0]?.id||null;
  }
  if(!selectedLeadId && list.length)selectedLeadId=list[0].id;

  $("queueList").innerHTML=list.map(l=>{
    const sc=scoreLead(l);
    return `<button class="queue-item ${l.id===selectedLeadId?"active":""}" data-select-lead="${esc(l.id)}">
      <div class="queue-company">
        <strong>${esc(l.name)}</strong>
        <small>${esc([l.category,l.city].filter(Boolean).join(" • "))}</small>
      </div>
      <div class="queue-right">
        <span class="queue-score score-${priority(sc)}">${sc}</span>
        <span class="queue-site">${esc(siteLabel(l))}</span>
      </div>
    </button>`;
  }).join("");

  $("queueEmpty").classList.toggle("hidden",list.length>0);
  renderFocus();
}

function renderFocus(){
  const lead=leads.find(l=>l.id===selectedLeadId);
  $("focusEmpty").classList.toggle("hidden",Boolean(lead));
  $("focusContent").classList.toggle("hidden",!lead);
  if(!lead)return;

  const sc=scoreLead(lead);
  $("focusScore").textContent=`Score ${sc}`;
  $("focusName").textContent=lead.name;
  $("focusMeta").textContent=[lead.category,lead.city].filter(Boolean).join(" • ") || "Sem categoria";
  $("focusSiteBadge").textContent=siteLabel(lead);
  $("focusRating").textContent=lead.rating?Number(lead.rating).toFixed(1).replace(".",","):"—";
  $("focusReviews").textContent=Number(lead.reviews||0).toLocaleString("pt-BR");
  $("focusPhone").textContent=lead.phone||"—";

  const site=safeUrl(lead.website), maps=safeUrl(lead.mapsUrl);
  $("focusSiteLink").classList.toggle("hidden",!site);
  $("focusMapsLink").classList.toggle("hidden",!maps);
  if(site)$("focusSiteLink").href=site;
  if(maps)$("focusMapsLink").href=maps;

  $("siteReviewCard").classList.toggle("hidden",!lead.website);
  $$("[data-site-quality]").forEach(btn=>btn.classList.toggle("active",btn.dataset.siteQuality===siteQuality(lead)));

  $("messageTypeLabel").textContent=lead.website?"Lead com site":"Lead sem site";
  $("focusMessage").textContent=templateMessage(lead);

  const wa=$("sendWhatsappBtn");
  wa.disabled=!lead.phone;

  const activity=[];
  if(lead.sentAt)activity.push(`Mensagem aberta em ${formatDateTime(lead.sentAt)}`);
  if(lead.followup)activity.push(`Follow-up: ${formatDateBR(lead.followup)}`);
  if(lead.status)activity.push(`Status: ${lead.status}`);
  $("lastActivity").classList.toggle("hidden",!lead.sentAt && !lead.followup && lead.status==="Não contatado");
  $("lastActivity").textContent=activity.join(" • ");
  loadActivities(lead.id);
}

function selectNextAfter(currentId){
  const list=currentQueueLeads().filter(l=>l.id!==currentId);
  selectedLeadId=list[0]?.id||null;
  renderProspect();
}

async function sendWhatsapp(){
  const lead=leads.find(l=>l.id===selectedLeadId);
  if(!lead)return;
  const url=whatsappUrl(lead);
  if(!url){toast("Este lead não possui telefone.");return}

  const opened=window.open(url,"_blank","noopener");
  const now=new Date().toISOString();
  lead.status="Mensagem enviada";
  lead.sentAt=now;
  lead.lastContactAt=now;
  lead.updatedAt=now;
  await persist(lead);
  await addActivity(lead.id,"Mensagem enviada","WhatsApp aberto pelo CRM");

  const currentId=lead.id;
  toast("Marcado como enviado. Próximo lead pronto.");
  setTimeout(()=>selectNextAfter(currentId),120);
}

async function markStatus(status){
  const lead=leads.find(l=>l.id===selectedLeadId);
  if(!lead)return;
  lead.status=status;
  lead.updatedAt=new Date().toISOString();
  if(status==="Respondeu")lead.repliedAt=new Date().toISOString();
  if(status==="Sem interesse")lead.followup="";
  await persist(lead);
  await addActivity(lead.id,"Status alterado",status);
  const id=lead.id;
  toast(`Status: ${status}`);
  setTimeout(()=>selectNextAfter(id),100);
}
async function addFollowup(){
  const lead=leads.find(l=>l.id===selectedLeadId);
  if(!lead)return;
  lead.followup=addDaysISO(3);
  lead.updatedAt=new Date().toISOString();
  await persist(lead);
  await addActivity(lead.id,"Follow-up agendado",formatDateBR(lead.followup));
  toast("Follow-up marcado para +3 dias.");
  selectNextAfter(lead.id);
}
function skipCurrent(){
  if(!selectedLeadId)return;
  skippedIds.add(selectedLeadId);
  const id=selectedLeadId;
  toast("Lead pulado nesta sessão.");
  selectNextAfter(id);
}
async function setSiteQuality(q){
  const lead=leads.find(l=>l.id===selectedLeadId);
  if(!lead)return;
  lead.siteQuality=q;
  lead.updatedAt=new Date().toISOString();
  await persist(lead);
  await addActivity(lead.id,"Site avaliado",siteLabel(lead));
  renderProspect();
}

function renderLeadsTable(){
  const search=$("leadSearch").value.trim().toLowerCase();
  const status=$("leadStatusFilter").value;
  const site=$("leadSiteFilter").value;
  const pri=$("leadPriorityFilter").value;

  tableFiltered=leads.filter(l=>{
    const hay=[l.name,l.city,l.category,l.phone,l.website].join(" ").toLowerCase();
    if(search && !hay.includes(search))return false;
    if(status && l.status!==status)return false;
    if(site==="none" && l.website)return false;
    if(site==="has" && !l.website)return false;
    if(site==="bad" && siteQuality(l)!=="bad")return false;
    if(pri && priority(scoreLead(l))!==pri)return false;
    return true;
  }).sort((a,b)=>scoreLead(b)-scoreLead(a));

  $("leadResultCount").textContent=`${tableFiltered.length} lead${tableFiltered.length===1?"":"s"}`;
  $("leadsTableBody").innerHTML=tableFiltered.length?tableFiltered.map(l=>{
    const sc=scoreLead(l);
    return `<tr>
      <td class="company-cell"><strong>${esc(l.name)}</strong><small>${esc([l.category,l.city].filter(Boolean).join(" • "))}</small></td>
      <td><span class="queue-score score-${priority(sc)}">${sc}</span></td>
      <td>${l.rating?Number(l.rating).toFixed(1).replace(".",","):"—"}</td>
      <td>${Number(l.reviews||0).toLocaleString("pt-BR")}</td>
      <td><span class="site-badge-table site-${siteQuality(l)}">${esc(siteLabel(l))}</span></td>
      <td><span class="status-badge status-${statusSlug(l.status)}">${esc(l.status)}</span></td>
      <td>${formatDateTime(l.lastContactAt||l.sentAt)}</td>
      <td><button class="text-btn" data-table-edit="${esc(l.id)}">Editar</button></td>
    </tr>`;
  }).join(""):`<tr><td colspan="8" style="text-align:center;color:#6b7280;padding:35px">Nenhum lead encontrado.</td></tr>`;
}

function populateStatuses(){
  $("leadStatusFilter").innerHTML=`<option value="">Todos os status</option>`+STATUSES.map(s=>`<option>${esc(s)}</option>`).join("");
  $("editStatus").innerHTML=STATUSES.map(s=>`<option>${esc(s)}</option>`).join("");
}

function openModal(id=null){
  const l=id?leads.find(x=>x.id===id):null;
  $("editLeadId").value=l?.id||"";
  $("editName").value=l?.name||"";
  $("editPhone").value=l?.phone||"";
  $("editWebsite").value=l?.website||"";
  $("editSiteQuality").value=l?siteQuality(l):"none";
  $("editRating").value=l?.rating||"";
  $("editReviews").value=l?.reviews||"";
  $("editCategory").value=l?.category||"";
  $("editCity").value=l?.city||"";
  $("editStatus").value=l?.status||"Não contatado";
  $("editFollowup").value=l?.followup||"";
  $("editMaps").value=l?.mapsUrl||"";
  $("editFranchise").checked=Boolean(l?.franchise);
  $("editNotes").value=l?.notes||"";
  $("modalTitle").textContent=l?.name||"Novo lead";
  $("deleteLeadBtn").classList.toggle("hidden",!l);
  $("leadModal").classList.remove("hidden");
}
function closeModal(){$("leadModal").classList.add("hidden")}
async function saveModal(){
  const id=$("editLeadId").value||uid();
  const old=leads.find(l=>l.id===id);
  const website=norm($("editWebsite").value);
  let q=$("editSiteQuality").value;
  if(!website)q="none";
  else if(q==="none")q="unknown";

  const l={
    ...(old||{}),
    id,
    name:norm($("editName").value),
    phone:norm($("editPhone").value),
    website,
    siteQuality:q,
    rating:rating($("editRating").value),
    reviews:Math.max(0,Math.round(num($("editReviews").value))),
    category:norm($("editCategory").value),
    city:norm($("editCity").value),
    mapsUrl:norm($("editMaps").value),
    status:$("editStatus").value||"Não contatado",
    followup:$("editFollowup").value||"",
    franchise:$("editFranchise").checked,
    notes:norm($("editNotes").value),
    createdAt:old?.createdAt||new Date().toISOString(),
    updatedAt:new Date().toISOString()
  };
  if(!l.name){toast("Informe o nome da empresa.");return}
  const idx=leads.findIndex(x=>x.id===id);
  if(idx>=0)leads[idx]=l;else leads.push(l);
  const ok=await persist(l);
  if(ok!==false)await addActivity(l.id,old?"Lead atualizado":"Lead criado",l.name);
  selectedLeadId=l.id;closeModal();renderProspect();renderLeadsTable();toast("Lead salvo.");
}
async function deleteLead(){
  const id=$("editLeadId").value;
  if(!id||!confirm("Excluir este lead?"))return;
  const {error}=await supabaseClient.from("leads").delete().eq("id",id);
  if(error){toast("Não foi possível excluir o lead.");return}
  leads=leads.filter(l=>l.id!==id);
  if(selectedLeadId===id)selectedLeadId=null;
  closeModal();renderProspect();renderLeadsTable();toast("Lead excluído.");
}

const ALIASES={
  name:["title","placename","place name","name","empresa","nome"],
  phone:["phone","phoneunformatted","telefone"],
  website:["website","websiteurl","site"],
  rating:["totalscore","rating","nota"],
  reviews:["reviewscount","reviews","reviews count","avaliacoes","avaliações"],
  category:["categoryname","category","categoria"],
  address:["address","endereco","endereço","street"],
  city:["city","cidade"],state:["state","estado"],
  maps:["url","googlemapsurl","mapsurl","google maps url"],
  placeId:["placeid","place_id","googleplaceid"]
};
function canon(k){return norm(k).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[_-]/g," ").replace(/\s+/g," ")}
function pick(row,aliases){
  const entries=Object.entries(row);
  for(const a of aliases){
    const ca=canon(a), found=entries.find(([k])=>canon(k)===ca);
    if(found && norm(found[1]))return found[1];
  }return"";
}
function importedRow(row){
  const website=norm(pick(row,ALIASES.website));
  return {
    id:uid(),placeId:norm(pick(row,ALIASES.placeId)),
    name:norm(pick(row,ALIASES.name))||"Empresa sem nome",
    phone:norm(pick(row,ALIASES.phone)),website,
    siteQuality:website?"unknown":"none",
    rating:rating(pick(row,ALIASES.rating)),
    reviews:Math.max(0,Math.round(num(pick(row,ALIASES.reviews)))),
    category:norm(pick(row,ALIASES.category)),
    address:norm(pick(row,ALIASES.address)),
    city:norm(pick(row,ALIASES.city)),state:norm(pick(row,ALIASES.state)),
    mapsUrl:norm(pick(row,ALIASES.maps)),status:"Não contatado",notes:"",followup:"",
    franchise:false,sentAt:"",repliedAt:"",lastContactAt:"",
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  };
}
function dedupeKey(l){
  if(l.placeId)return"p:"+l.placeId;
  if(digits(l.phone))return"t:"+digits(l.phone);
  return"n:"+canon(l.name)+"|c:"+canon(l.city);
}
function mergeImported(incoming){
  const map=new Map(leads.map(l=>[dedupeKey(l),l]));
  let added=0,updated=0;
  incoming.forEach(n=>{
    const key=dedupeKey(n), old=map.get(key);
    if(old){
      const keep={id:old.id,status:old.status,notes:old.notes,followup:old.followup,franchise:old.franchise,sentAt:old.sentAt,repliedAt:old.repliedAt,lastContactAt:old.lastContactAt,createdAt:old.createdAt};
      const manualSite=["bad","ok","good"].includes(old.siteQuality)?old.siteQuality:n.siteQuality;
      Object.assign(old,n,keep,{siteQuality:manualSite,updatedAt:new Date().toISOString()});
      updated++;
    }else{leads.push(n);map.set(key,n);added++}
  });
  persist(leads);return{added,updated};
}
function parseCSV(text){
  const rows=[];let row=[],cell="",quotes=false;
  for(let i=0;i<text.length;i++){
    const c=text[i],next=text[i+1];
    if(c=='"'&&quotes&&next=='"'){cell+='"';i++}
    else if(c=='"')quotes=!quotes;
    else if(c==","&&!quotes){row.push(cell);cell=""}
    else if((c=="\n"||c=="\r")&&!quotes){if(c=="\r"&&next=="\n")i++;row.push(cell);if(row.some(v=>v!==""))rows.push(row);row=[];cell=""}
    else cell+=c;
  }
  row.push(cell);if(row.some(v=>v!==""))rows.push(row);
  if(!rows.length)return[];
  const headers=rows[0].map(h=>norm(h));
  return rows.slice(1).map(vals=>Object.fromEntries(headers.map((h,i)=>[h,vals[i]??""])));
}
async function handleFile(file){
  if(!file)return;
  try{
    const ext=file.name.split(".").pop().toLowerCase();let rows=[];
    if(ext==="csv")rows=parseCSV(await file.text());
    else if(["xlsx","xls"].includes(ext)){
      if(!window.XLSX)throw new Error("Biblioteca de Excel não carregou. Exporte CSV no Apify.");
      const wb=XLSX.read(await file.arrayBuffer(),{type:"array"});
      rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{defval:""});
    }else throw new Error("Use CSV, XLSX ou XLS.");
    const inc=rows.map(importedRow).filter(l=>l.name!=="Empresa sem nome");
    if(!inc.length)throw new Error("Nenhum lead válido encontrado.");
    const r=mergeImported(inc);
    $("importResult").classList.remove("hidden");
    $("importResult").innerHTML=`<strong>Pronto.</strong> ${r.added} novos e ${r.updated} atualizados.`;
    currentQueue="new";selectedLeadId=null;renderProspect();renderLeadsTable();
    toast("Importação concluída.");
    setTimeout(()=>switchView("prospect"),650);
  }catch(e){
    $("importResult").classList.remove("hidden");
    $("importResult").style.background="#fff0f0";$("importResult").style.borderColor="#f3c4c4";$("importResult").style.color="#9b2c2c";
    $("importResult").textContent=e.message||"Erro ao importar.";
  }finally{$("fileInput").value=""}
}

function loadSample(){
  const sample=[
    ["Clean Sofa Jundiaí","(11) 99999-1010","",4.9,84,"Limpeza de estofados","Jundiaí","sample_1"],
    ["Clima Forte Ar-Condicionado","(11) 98888-2020","https://exemplo.com.br",4.8,52,"Ar-condicionado","Jundiaí","sample_2"],
    ["Eletrix Serviços","(11) 97777-3030","",5,31,"Eletricista","Jundiaí","sample_3"]
  ].map(([name,phone,website,ratingV,reviews,category,city,placeId])=>({
    id:uid(),placeId,name,phone,website,siteQuality:website?"bad":"none",rating:ratingV,reviews,category,city,mapsUrl:"https://maps.google.com/",status:"Não contatado",notes:"",followup:"",franchise:false,sentAt:"",repliedAt:"",lastContactAt:"",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()
  }));
  const r=mergeImported(sample);selectedLeadId=null;renderProspect();renderLeadsTable();toast(`${r.added} exemplos adicionados.`);switchView("prospect");
}

function csvEscape(v){const s=String(v??"");return /[",\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`:s}
function download(content,name,type){
  const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement("a");
  a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function exportCSV(){
  const src=tableFiltered.length?tableFiltered:leads;
  const headers=["Empresa","Telefone","Site","Qualidade site","Nota","Avaliações","Categoria","Cidade","Status","Score","Último contato","Follow-up","Maps","Observações"];
  const lines=[headers.map(csvEscape).join(",")];
  src.forEach(l=>lines.push([l.name,l.phone,l.website,siteLabel(l),l.rating,l.reviews,l.category,l.city,l.status,scoreLead(l),l.lastContactAt,l.followup,l.mapsUrl,l.notes].map(csvEscape).join(",")));
  download("\uFEFF"+lines.join("\r\n"),`leads_${new Date().toISOString().slice(0,10)}.csv`,"text/csv;charset=utf-8");
}
function backup(){
  download(JSON.stringify({version:3,exportedAt:new Date().toISOString(),leads,settings},null,2),`leadflow_backup_${new Date().toISOString().slice(0,10)}.json`,"application/json");
}
async function restore(file){
  try{
    const data=JSON.parse(await file.text());
    if(!Array.isArray(data.leads))throw new Error("Backup inválido.");
    leads=data.leads;settings=deepMerge(DEFAULT_SETTINGS,data.settings||{});
    normalizeLeads();await persist(leads);await persistSettings();selectedLeadId=null;renderAll();renderSettings();toast("Backup restaurado no Supabase.");
  }catch(e){toast(e.message||"Falha ao restaurar.")}
}


function actorIdForApi(value){
  return norm(value).replace("/", "~");
}

function getApifyForm(){
  return {
    actorId: actorIdForApi($("apifyActorId").value || "compass~crawler-google-places"),
    queries: $("apifyQueries").value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean),
    location: norm($("apifyLocation").value),
    maxPlaces: Math.max(1,Number($("apifyMaxPlaces").value||20)),
    language: $("apifyLanguage").value || "pt-BR",
    website: $("apifyWebsiteFilter").value || "allPlaces",
    minStars: $("apifyMinStars").value || "",
    skipClosed: $("apifySkipClosed").checked,
    placeDetails: $("apifyPlaceDetails").checked
  };
}

function saveApifyForm(){
  const f=getApifyForm();
  localStorage.setItem(APIFY_FORM_KEY,JSON.stringify({
    actorId:f.actorId,queries:f.queries,location:f.location,maxPlaces:f.maxPlaces,
    language:f.language,website:f.website,minStars:f.minStars,
    skipClosed:f.skipClosed,placeDetails:f.placeDetails
  }));
}

function loadApifyForm(){
  const saved=loadJSON(APIFY_FORM_KEY,null);
  if(saved){
    $("apifyActorId").value=saved.actorId||"compass~crawler-google-places";
    $("apifyQueries").value=Array.isArray(saved.queries)?saved.queries.join("\n"):(saved.queries||"limpeza de estofados");
    $("apifyLocation").value=saved.location||"Jundiaí, São Paulo, Brazil";
    $("apifyMaxPlaces").value=saved.maxPlaces||20;
    $("apifyLanguage").value=saved.language||"pt-BR";
    $("apifyWebsiteFilter").value=saved.website||"allPlaces";
    $("apifyMinStars").value=saved.minStars||"";
    $("apifySkipClosed").checked=saved.skipClosed!==false;
    $("apifyPlaceDetails").checked=saved.placeDetails!==false;
  }
  updateApifyRunSummary();
}

function updateApifyRunSummary(){
  const queries=$("apifyQueries").value.split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
  const max=Math.max(1,Number($("apifyMaxPlaces").value||20));
  const estimated=queries.length*max;
  $("apifyRunSummary").textContent=queries.length
    ? `Até ${estimated.toLocaleString("pt-BR")} resultados (${queries.length} pesquisa${queries.length===1?"":"s"} × ${max}). O Apify pode cobrar créditos conforme seu plano.`
    : "Adicione pelo menos uma pesquisa.";
}

function setApifyProgress({title,text,status,percent,runId,found,state="running"}){
  $("apifyProgress").classList.remove("hidden");
  $("apifyProgressTitle").textContent=title||"Executando...";
  $("apifyProgressText").textContent=text||"";
  $("apifyRunStatus").textContent=status||"—";
  $("apifyRunId").textContent=runId||"—";
  $("apifyFoundCount").textContent=Number(found||0).toLocaleString("pt-BR");
  $("apifyProgressFill").style.width=`${Math.max(4,Math.min(100,percent||5))}%`;
  $("apifySpinner").className="spinner"+(state==="done"?" done":state==="error"?" error":"");
}

function setRunButtonLoading(loading){
  $("runApifyBtn").disabled=loading;
  $("runApifyBtn").querySelector("span").textContent=loading?"Buscando empresas...":"Buscar no Google Maps";
  $("runApifyBtn").querySelector("small").textContent=loading?"Você pode acompanhar abaixo":"Executar via Apify API";
}

function apifyRunData(payload){
  return payload?.data || payload || {};
}

async function apifyProxy(action,payload={}){
  const {data,error}=await supabaseClient.functions.invoke("apify-proxy",{body:{action,...payload}});
  if(error)throw new Error(error.message||"Falha ao chamar a Edge Function do Apify.");
  if(data?.error)throw new Error(data.error);
  return data;
}

function buildGoogleMapsActorInput(form){
  const input={
    searchStringsArray:form.queries,
    locationQuery:form.location,
    maxCrawledPlacesPerSearch:form.maxPlaces,
    language:form.language,
    website:form.website,
    skipClosedPlaces:form.skipClosed,
    scrapePlaceDetailPage:form.placeDetails,
    maxReviews:0,
    scrapeContacts:false,
    includeWebResults:false,
    scrapeDirectories:false,
    maxImages:0,
    maximumLeadsEnrichmentRecords:0,
    maxCompetitorsToAnalyze:0,
    scrapeSocialMediaProfiles:{
      facebooks:false,
      instagrams:false,
      youtubes:false,
      tiktoks:false,
      twitters:false
    }
  };
  if(form.minStars)input.placeMinimumStars=form.minStars;
  return input;
}

async function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

async function startApifySearch(){
  const form=getApifyForm();

  if(!form.queries.length){toast("Informe pelo menos uma pesquisa.");$("apifyQueries").focus();return}
  if(!form.location){toast("Informe a localização da busca.");$("apifyLocation").focus();return}

  saveApifyForm();
  lastApifyLeads=[];
  currentApifyRun=null;

  $("exportLastApifyBtn").classList.add("hidden");
  $("goProspectAfterApifyBtn").classList.add("hidden");
  $("apifyConsoleLink").classList.add("hidden");
  setRunButtonLoading(true);
  setApifyProgress({
    title:"Enviando busca ao Apify",
    text:"Criando uma nova execução do Google Maps Scraper.",
    status:"STARTING",percent:8,state:"running"
  });

  try{
    const payload=await apifyProxy("start",{
      actorId:form.actorId,
      input:buildGoogleMapsActorInput(form)
    });

    const run=apifyRunData(payload);
    if(!run.id)throw new Error("O Apify iniciou a chamada, mas não retornou um Run ID.");

    currentApifyRun={
      id:run.id,
      datasetId:run.defaultDatasetId||"",
      actorId:form.actorId
    };

    $("apifyConsoleLink").href=`https://console.apify.com/actors/runs/${encodeURIComponent(run.id)}`;
    $("apifyConsoleLink").classList.remove("hidden");

    setApifyProgress({
      title:"Google Maps Scraper em execução",
      text:"Aguardando o Apify finalizar a coleta.",
      status:run.status||"RUNNING",
      runId:run.id,percent:18,state:"running"
    });

    const terminal=["SUCCEEDED","FAILED","ABORTED","TIMED-OUT"];
    let finalRun=run;
    const started=Date.now();
    const maxWaitMs=12*60*1000;

    while(!terminal.includes(finalRun.status)){
      if(Date.now()-started>maxWaitMs){
        throw new Error("A busca ainda está rodando após 12 minutos. Abra a execução no Apify e tente recuperar os resultados depois.");
      }

      await sleep(3000);
      const statusPayload=await apifyProxy("status",{runId:run.id});
      finalRun=apifyRunData(statusPayload);

      const elapsed=Math.round((Date.now()-started)/1000);
      const pseudoProgress=Math.min(82,20+Math.floor(elapsed/4));
      setApifyProgress({
        title:"Coletando empresas no Google Maps",
        text:`Execução em andamento há ${elapsed}s.`,
        status:finalRun.status||"RUNNING",
        runId:run.id,percent:pseudoProgress,state:"running"
      });
    }

    if(finalRun.status!=="SUCCEEDED"){
      throw new Error(`A execução terminou com status ${finalRun.status}. Abra a execução no Apify para ver os detalhes.`);
    }

    const datasetId=finalRun.defaultDatasetId || currentApifyRun.datasetId;
    if(!datasetId)throw new Error("A execução terminou, mas não retornou o ID do dataset.");

    currentApifyRun.datasetId=datasetId;
    setApifyProgress({
      title:"Busca concluída",
      text:"Baixando os resultados do dataset para o CRM.",
      status:"SUCCEEDED",runId:run.id,percent:88,state:"running"
    });

    const datasetPayload=await apifyProxy("dataset",{datasetId});

    const items=Array.isArray(datasetPayload)
      ? datasetPayload
      : (datasetPayload?.data?.items || datasetPayload?.items || []);

    if(!Array.isArray(items))throw new Error("O dataset foi retornado em um formato inesperado.");

    const converted=items.map(importedRow).filter(l=>l.name!=="Empresa sem nome");
    const result=mergeImported(converted);
    lastApifyLeads=converted;

    setApifyProgress({
      title:"Leads enviados para o CRM",
      text:`${result.added} novos leads e ${result.updated} atualizados. Duplicatas foram mescladas automaticamente.`,
      status:"SUCCEEDED",runId:run.id,found:converted.length,percent:100,state:"done"
    });

    $("exportLastApifyBtn").classList.toggle("hidden",converted.length===0);
    $("goProspectAfterApifyBtn").classList.remove("hidden");
    selectedLeadId=null;
    currentQueue="new";
    renderProspect();
    renderLeadsTable();
    toast(`${converted.length} resultados recebidos do Apify.`);
  }catch(error){
    setApifyProgress({
      title:"Não foi possível concluir a busca",
      text:error.message||"Falha ao chamar a API do Apify.",
      status:"ERRO",runId:currentApifyRun?.id||"",percent:100,state:"error"
    });
    toast(error.message||"Erro na integração com Apify.");
  }finally{
    setRunButtonLoading(false);
  }
}

function exportLeadArrayCSV(source,filePrefix="leads"){
  if(!source.length){toast("Não há resultados para exportar.");return}
  const headers=["Empresa","Telefone","Site","Qualidade site","Nota","Avaliações","Categoria","Cidade","Status","Score","Maps"];
  const lines=[headers.map(csvEscape).join(",")];
  source.forEach(l=>lines.push([
    l.name,l.phone,l.website,siteLabel(l),l.rating,l.reviews,l.category,l.city,l.status,scoreLead(l),l.mapsUrl
  ].map(csvEscape).join(",")));
  download("\uFEFF"+lines.join("\r\n"),`${filePrefix}_${new Date().toISOString().slice(0,10)}.csv`,"text/csv;charset=utf-8");
}

function renderSettings(){
  $("messageWithSite").value=settings.messageTemplateWithSite;
  $("messageWithoutSite").value=settings.messageTemplateWithoutSite;
  $("defaultCountryCode").value=settings.defaultCountryCode;
  $("wNoSite").value=settings.weights.noSite;$("wBadSite").value=settings.weights.badSite;
  $("wReviews").value=settings.weights.reviews20;$("wRating").value=settings.weights.rating45;
  $("wPhone").value=settings.weights.phone;$("wManyReviews").value=settings.weights.tooManyReviews;
  $("wFranchise").value=settings.weights.franchise;
}
function saveMessages(){
  settings.messageTemplateWithSite=$("messageWithSite").value.trim()||DEFAULT_SETTINGS.messageTemplateWithSite;
  settings.messageTemplateWithoutSite=$("messageWithoutSite").value.trim()||DEFAULT_SETTINGS.messageTemplateWithoutSite;
  settings.defaultCountryCode=$("defaultCountryCode").value.trim()||"55";
  persistSettings();renderProspect();toast("Mensagens salvas.");
}
function saveWeights(){
  settings.weights={
    noSite:Number($("wNoSite").value||0),badSite:Number($("wBadSite").value||0),
    reviews20:Number($("wReviews").value||0),rating45:Number($("wRating").value||0),
    phone:Number($("wPhone").value||0),tooManyReviews:Number($("wManyReviews").value||0),
    franchise:Number($("wFranchise").value||0)
  };
  persistSettings();renderAll();toast("Score atualizado.");
}
function renderAll(){renderProspect();renderLeadsTable();updateCounters()}

function supabaseConfigured(){
  const c=window.LEADFLOW_SUPABASE||{};
  return c.url&&c.anonKey&&!c.url.includes("COLE_")&&!c.anonKey.includes("COLE_");
}
function showAuth(message=""){
  $("authScreen").classList.remove("hidden");$("authStatus").textContent=message;
}
function hideAuth(){$("authScreen").classList.add("hidden")}
async function login(){
  if(!supabaseConfigured()){showAuth("Configure js/supabase-config.js antes de entrar.");return}
  const email=norm($("authEmail").value),password=$("authPassword").value;
  if(!email||!password){$("authStatus").textContent="Informe e-mail e senha.";return}
  $("authStatus").textContent="Entrando...";
  const {error}=await supabaseClient.auth.signInWithPassword({email,password});
  if(error)$("authStatus").textContent=error.message;
}
async function handleSession(session){
  currentUser=session?.user||null;
  if(!currentUser){showAuth();return}
  hideAuth();
  $("userBtn").textContent=currentUser.email?.split("@")[0]||"Conta";
  try{
    await loadCloudData(); normalizeLeads(); renderSettings(); renderAll(); setupRealtime();
    const local=loadJSON(STORAGE_KEY,[]);
    if(!leads.length&&Array.isArray(local)&&local.length){
      leads=local;normalizeLeads();await persist(leads);localStorage.removeItem(STORAGE_KEY);
      toast(`${leads.length} leads locais migrados para o Supabase.`);renderAll();
    }
  }catch(e){console.error(e);setSyncState("error","Erro de conexão");toast("Não foi possível carregar o Supabase. Confira a configuração e o SQL.");}
}

function bind(){
  $("loginBtn").addEventListener("click",login);
  $("authPassword").addEventListener("keydown",e=>{if(e.key==="Enter")login()});
  $("userBtn").addEventListener("click",async()=>{if(confirm("Sair desta conta?"))await supabaseClient.auth.signOut()});
  $$(".nav-btn").forEach(b=>b.addEventListener("click",()=>switchView(b.dataset.view)));
  $$("[data-go]").forEach(b=>b.addEventListener("click",()=>switchView(b.dataset.go)));

  $("queueTabs").addEventListener("click",e=>{
    const b=e.target.closest("[data-queue]");if(!b)return;
    currentQueue=b.dataset.queue;skippedIds.clear();
    $$(".queue-tab").forEach(x=>x.classList.toggle("active",x===b));
    selectedLeadId=null;renderProspect();
  });
  $("queueList").addEventListener("click",e=>{
    const b=e.target.closest("[data-select-lead]");if(!b)return;
    selectedLeadId=b.dataset.selectLead;renderProspect();
  });
  $("queueSearch").addEventListener("input",()=>{selectedLeadId=null;renderProspect()});
  $("queueSiteFilter").addEventListener("change",()=>{selectedLeadId=null;renderProspect()});

  $("sendWhatsappBtn").addEventListener("click",sendWhatsapp);
  $("skipBtn").addEventListener("click",skipCurrent);
  $("markRepliedBtn").addEventListener("click",()=>markStatus("Respondeu"));
  $("noInterestBtn").addEventListener("click",()=>markStatus("Sem interesse"));
  $("followupBtn").addEventListener("click",addFollowup);
  $("editCurrentBtn").addEventListener("click",()=>selectedLeadId&&openModal(selectedLeadId));

  $("copyMessageBtn").addEventListener("click",async()=>{
    const l=leads.find(x=>x.id===selectedLeadId);if(!l)return;
    await navigator.clipboard?.writeText(templateMessage(l));toast("Mensagem copiada.");
  });
  $("copyPhoneBtn").addEventListener("click",async()=>{
    const l=leads.find(x=>x.id===selectedLeadId);if(!l?.phone)return;
    await navigator.clipboard?.writeText(l.phone);toast("Telefone copiado.");
  });
  $$("[data-site-quality]").forEach(b=>b.addEventListener("click",()=>setSiteQuality(b.dataset.siteQuality)));

  ["leadSearch","leadStatusFilter","leadSiteFilter","leadPriorityFilter"].forEach(id=>{
    $(id).addEventListener(id==="leadSearch"?"input":"change",renderLeadsTable);
  });
  $("leadsTableBody").addEventListener("click",e=>{
    const b=e.target.closest("[data-table-edit]");if(b)openModal(b.dataset.tableEdit);
  });
  $("exportCsvBtn").addEventListener("click",exportCSV);
  $("clearAllBtn").addEventListener("click",async()=>{
    if(!leads.length||!confirm("Apagar TODOS os leads compartilhados do CRM? Esta ação afeta todos os computadores."))return;
    const {error}=await supabaseClient.from("leads").delete().neq("id","");
    if(error){toast("Não foi possível apagar a base.");return}
    leads=[];selectedLeadId=null;renderAll();toast("Base compartilhada apagada.");
  });

  $("addLeadBtn").addEventListener("click",()=>openModal());
  $("closeModalBtn").addEventListener("click",closeModal);
  $("cancelModalBtn").addEventListener("click",closeModal);
  $("leadModal").addEventListener("click",e=>{if(e.target===$("leadModal"))closeModal()});
  $("saveLeadBtn").addEventListener("click",saveModal);
  $("deleteLeadBtn").addEventListener("click",deleteLead);

  $("runApifyBtn").addEventListener("click",startApifySearch);
  ["apifyQueries","apifyMaxPlaces"].forEach(id=>$(id).addEventListener("input",updateApifyRunSummary));
  ["apifyLocation","apifyLanguage","apifyWebsiteFilter","apifyMinStars","apifySkipClosed","apifyPlaceDetails","apifyActorId"]
    .forEach(id=>$(id).addEventListener("change",saveApifyForm));
  $("exportLastApifyBtn").addEventListener("click",()=>exportLeadArrayCSV(lastApifyLeads,"apify_maps"));
  $("goProspectAfterApifyBtn").addEventListener("click",()=>switchView("prospect"));

  $("chooseFileBtn").addEventListener("click",()=>$("fileInput").click());
  $("fileInput").addEventListener("change",e=>handleFile(e.target.files[0]));
  const dz=$("dropzone");
  ["dragenter","dragover"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add("dragover")}));
  ["dragleave","drop"].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.remove("dragover")}));
  dz.addEventListener("drop",e=>handleFile(e.dataTransfer.files[0]));
  $("sampleBtn").addEventListener("click",loadSample);

  $("saveMessagesBtn").addEventListener("click",saveMessages);
  $("saveWeightsBtn").addEventListener("click",saveWeights);
  $("backupBtn").addEventListener("click",backup);
  $("restoreBtn").addEventListener("click",()=>$("restoreInput").click());
  $("restoreInput").addEventListener("change",e=>restore(e.target.files[0]));

  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"&&!$("leadModal").classList.contains("hidden"))closeModal();
    if($("view-prospect").classList.contains("active") && !$("leadModal").classList.contains("hidden"))return;
    if($("view-prospect").classList.contains("active")){
      if(e.key.toLowerCase()==="w" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)){e.preventDefault();sendWhatsapp()}
      if(e.key.toLowerCase()==="s" && !["INPUT","TEXTAREA","SELECT"].includes(document.activeElement.tagName)){e.preventDefault();skipCurrent()}
    }
  });
}

async function init(){
  populateStatuses(); bind(); renderSettings(); loadApifyForm(); renderAll();
  if(!supabaseConfigured()){showAuth("Configure o Supabase em js/supabase-config.js. Veja SUPABASE_SETUP.md.");return}
  supabaseClient=window.supabase.createClient(window.LEADFLOW_SUPABASE.url,window.LEADFLOW_SUPABASE.anonKey);
  const {data:{session}}=await supabaseClient.auth.getSession();
  await handleSession(session);
  supabaseClient.auth.onAuthStateChange((_event,newSession)=>{handleSession(newSession)});
}
init();
})();