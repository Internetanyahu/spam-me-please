const $=id=>document.getElementById(id);
let scannedTabId=null, forms=[];
function profile(){
 return Object.fromEntries(["firstName","lastName","email","phone","street","city","state","zip"].map(k=>[k,$(k).value.trim()]));
}
async function activeTab(){
 const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
 if(!tab?.id)throw new Error("No active tab found.");
 return tab;
}
function scanPage(){
 const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none";};
 return Array.from(document.forms).map((form,index)=>{
  const fields=Array.from(form.querySelectorAll("input,textarea,select")).filter(el=>{
   const type=(el.type||"").toLowerCase();
   return visible(el)&&!el.disabled&&!el.readOnly&&!["hidden","password","checkbox","radio","submit","button","reset","image","file"].includes(type);
  });
  const labels=fields.map(el=>{
   const label=el.labels?.[0]?.innerText||el.getAttribute("aria-label")||el.placeholder||el.name||el.id||el.tagName.toLowerCase();
   return label.trim().replace(/\s+/g," ").slice(0,90);
  });
  const rect=form.getBoundingClientRect(),style=getComputedStyle(form);
  return {index,fields:labels,visible:rect.width>0&&rect.height>0&&style.visibility!=="hidden"&&style.display!=="none"};
 }).filter(x=>x.visible&&x.fields.length);
}
function fillForm(formIndex,values){
 const form=Array.from(document.forms)[formIndex];
 if(!form) return {ok:false,error:"That form is no longer on this page. Scan again."};
 const visible=el=>{const r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none";};
 const norm=s=>(s||"").toLowerCase().replace(/[^a-z0-9]+/g," ");
 const filled=[];
 const fullName=[values.firstName,values.lastName].filter(Boolean).join(" ");
 const mappings=[
  {key:"firstName",re:/\b(first name|firstname|given name|given-name)\b/},
  {key:"lastName",re:/\b(last name|lastname|family name|family-name|surname)\b/},
  {key:"email",re:/\b(email|e mail|email address)\b/},
  {key:"phone",re:/\b(phone|telephone|mobile|cell number|tel)\b/},
  {key:"street",re:/\b(street address|address line 1|address1|street)\b/},
  {key:"city",re:/\b(city|locality|address level 2)\b/},
  {key:"state",re:/\b(state|province|region|address level 1)\b/},
  {key:"zip",re:/\b(zip|zip code|postal code|postcode)\b/}
 ];
 for(const el of Array.from(form.querySelectorAll("input,textarea,select"))){
  const type=(el.type||"").toLowerCase();
  if(!visible(el)||el.disabled||el.readOnly||["hidden","password","checkbox","radio","submit","button","reset","image","file"].includes(type))continue;
  const label=el.labels?.[0]?.innerText||"";
  const context=norm([el.autocomplete,el.name,el.id,el.placeholder,el.getAttribute("aria-label"),label].join(" "));
  if(/\b(consent|agree|terms|privacy|marketing|opt in|opt out|subscribe|sms permission)\b/.test(context))continue;
  let value="";
  const match=mappings.find(m=>m.re.test(context)&&values[m.key]);
  if(match)value=values[match.key];
  else if(/\b(full name|your name|name)\b/.test(context)&&fullName)value=fullName;
  if(!value)continue;
  if(el.tagName==="SELECT"){
   const option=Array.from(el.options).find(o=>norm(o.value)===norm(value)||norm(o.textContent)===norm(value));
   if(!option)continue;
   el.value=option.value;
   el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));
  }else{
   const proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
   const setter=Object.getOwnPropertyDescriptor(proto,"value")?.set;
   if(setter)setter.call(el,value);else el.value=value;
   el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));
  }
  filled.push(label||el.name||el.id||el.tagName.toLowerCase());
 }
 return {ok:true,count:filled.length,fields:filled};
}
$("scan").addEventListener("click",async()=>{
 $("scan").disabled=true;$("status").textContent="Scanning visible forms…";
 try{
  const tab=await activeTab();const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:scanPage});
  forms=result?.result||[];scannedTabId=tab.id;
  const select=$("formSelect");select.replaceChildren();
  forms.forEach((form,i)=>{const o=document.createElement("option");o.value=String(form.index);o.textContent="Form "+(i+1)+" · "+form.fields.length+" fields · "+form.fields.slice(0,3).join(", ");select.append(o);});
  select.disabled=!forms.length;$("fill").disabled=!forms.length;
  if(!forms.length){const o=document.createElement("option");o.value="";o.textContent="No visible forms found";select.append(o);}
  $("status").textContent=forms.length?forms.length+" visible form(s) found. Choose exactly one.":"No visible forms found on this page.";
 }catch(e){$("status").textContent="Scan failed: "+e.message;}
 finally{$("scan").disabled=false;}
});
$("fill").addEventListener("click",async()=>{
 $("fill").disabled=true;
 try{
  const tab=await activeTab();if(tab.id!==scannedTabId)throw new Error("The active page changed. Scan the current page again.");
  const index=Number($("formSelect").value);if(!Number.isInteger(index))throw new Error("Choose a form first.");
  const [result]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:fillForm,args:[index,profile()]});
  const r=result?.result;if(!r?.ok)throw new Error(r?.error||"Could not fill this form.");
  $("status").textContent=r.count+" field(s) filled. Review every value and all consent language yourself. The form was not submitted.";
 }catch(e){$("status").textContent="Fill failed: "+e.message;}
 finally{$("fill").disabled=false;}
});
$("updates").addEventListener("click",()=>chrome.tabs.create({url:chrome.runtime.getURL("updater.html")}));
chrome.runtime.sendMessage({type:"CHECK_FORM_FILLER_UPDATE"}).then(r=>{
 if(r?.info?.updateAvailable)$("status").textContent="An extension update is available. Open Updates to install it.";
}).catch(()=>{});
