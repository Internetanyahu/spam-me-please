const $=id=>document.getElementById(id);
let busy=false;
const log=s=>{$("log").textContent+="\n"+s;};
function setBusy(v){busy=v;for(const id of ["link","check","apply","saveToken"])$(id).disabled=v;}
async function getToken(){return (await chrome.storage.local.get("githubToken")).githubToken||"";}
async function render(){
 const token=await getToken();$("tokenStatus").textContent=token?"Token saved locally.":"No token saved.";
 const info=await FormFillerUpdater.check(token);
 $("linkStatus").textContent=info.linked?(info.permission==="granted"?"Folder linked; access granted.":"Folder linked; Chrome may ask for permission again."):"Extension folder not linked.";
 $("updateStatus").textContent=info.error|| (info.updateAvailable?"Update available ("+info.remoteSha.slice(0,7)+").":"Up to date.");
 $("apply").disabled=!info.linked||!info.updateAvailable;
 return info;
}
$("saveToken").addEventListener("click",async()=>{
 const token=$("token").value.trim();if(!token){$("tokenStatus").textContent="Enter a token first.";return;}
 await chrome.storage.local.set({githubToken:token});$("token").value="";$("tokenStatus").textContent="Saved locally.";await render();
});
$("link").addEventListener("click",async()=>{
 if(busy)return;setBusy(true);
 try{const name=await FormFillerUpdater.linkFolder();log("Linked folder: "+name);await render();}
 catch(e){log(e.name==="AbortError"?"Folder selection cancelled.":"Folder link failed: "+e.message);}
 finally{setBusy(false);}
});
$("check").addEventListener("click",async()=>{
 if(busy)return;setBusy(true);try{const i=await render();log(i.error|| (i.updateAvailable?"Update available.":"Already up to date."));}
 catch(e){log("Check failed: "+e.message);}finally{setBusy(false);}
});
$("apply").addEventListener("click",async()=>{
 if(busy)return;setBusy(true);
 try{const result=await FormFillerUpdater.apply(await getToken(),{interactive:true});
 if(!result.ok)throw new Error(result.error||"Update failed.");
 log(result.reload?"Updated "+result.changed.length+" file(s). Reloading extension…":"Already up to date.");
 if(result.reload)setTimeout(()=>chrome.runtime.reload(),700);else await render();
 }catch(e){log("Install failed: "+e.message);}finally{setBusy(false);}
});
(async()=>{try{const info=await render();if(info.updateAvailable)log("Update available.");}catch(e){$("updateStatus").textContent=e.message;}})();
