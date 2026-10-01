// Remove old demo password fields while retaining the user's local trial work.
// Legacy requests are never treated as live database data or silently imported.
export async function scrubLegacyCredentials() {
  try {
    sessionStorage.removeItem('oak-demo-account-v3');
    if(!indexedDB.databases)return;
    if(!(await indexedDB.databases()).some(db=>db.name==='oak-workflow-prototype'))return;
    await new Promise(resolve=>{
      const request=indexedDB.open('oak-workflow-prototype');
      request.onerror=request.onblocked=()=>resolve();
      request.onsuccess=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('workspace')){db.close();resolve();return;}
        const tx=db.transaction('workspace','readwrite'),store=tx.objectStore('workspace');
        const read=store.get('current');
        read.onsuccess=()=>{const saved=read.result;if(saved?.team){for(const user of saved.team)delete user.password;store.put(saved,'current');}};
        tx.oncomplete=tx.onabort=()=>{db.close();resolve();};
      };
    });
  }catch{/* Storage may be disabled; live login never uses this database. */}
}
