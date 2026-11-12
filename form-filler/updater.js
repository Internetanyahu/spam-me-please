(() => {
  if (self.FormFillerUpdater) return;

  const REPO = "Internetanyahu/spam-me-please";
  const BRANCH = "main";
  const EXT_DIR = "form-filler";
  const API = "https://api.github.com/repos/" + REPO;
  const HANDLE_KEY = "extensionDir";
  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("form-filler-updater", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("handles");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  async function idbRun(mode, action) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("handles", mode);
        const request = action(tx.objectStore("handles"));
        tx.oncomplete = () => resolve(request?.result ?? null);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  }
  const getHandle = () => idbRun("readonly", store => store.get(HANDLE_KEY));
  const setHandle = handle => idbRun("readwrite", store => store.put(handle, HANDLE_KEY));
  const clearHandle = () => idbRun("readwrite", store => store.delete(HANDLE_KEY));
  async function gh(path, token) {
    if (!token) throw new Error("Save your GitHub token first.");
    const response = await fetch(API + path, {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": "Bearer " + token,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      cache: "no-store"
    });
    if (response.status === 401 || response.status === 403) throw new Error("GitHub rejected the saved token (" + response.status + ").");
    if (response.status === 404) throw new Error("Repository or branch not found (404). Check that the token can read " + REPO + ".");
    if (!response.ok) throw new Error("GitHub request failed (" + response.status + ").");
    return response.json();
  }
  async function remoteExtensionSha(token) {
    const root = await gh("/git/trees/" + BRANCH, token);
    const entry = (root.tree || []).find(item => item.path === EXT_DIR && item.type === "tree");
    if (!entry) throw new Error("No " + EXT_DIR + "/ folder found on " + BRANCH + ".");
    return entry.sha;
  }
  async function remoteFiles(token, extensionSha) {
    const listing = await gh("/git/trees/" + extensionSha + "?recursive=1", token);
    if (listing.truncated) throw new Error("GitHub returned a truncated file list; refusing to update.");
    return (listing.tree || []).filter(item => item.type === "blob").map(item => ({ path: item.path, sha: item.sha }));
  }
  async function downloadBlob(token, sha) {
    const blob = await gh("/git/blobs/" + sha, token);
    if (blob.encoding !== "base64") throw new Error("Unexpected blob encoding from GitHub.");
    const binary = atob(String(blob.content).replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  async function gitBlobSha(bytes) {
    const header = new TextEncoder().encode("blob " + bytes.length + "\0");
    const all = new Uint8Array(header.length + bytes.length);
    all.set(header);
    all.set(bytes, header.length);
    const digest = await crypto.subtle.digest("SHA-1", all);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }
  async function readLocal(root, relativePath) {
    const parts = relativePath.split("/");
    const name = parts.pop();
    try {
      let dir = root;
      for (const part of parts) dir = await dir.getDirectoryHandle(part);
      const file = await (await dir.getFileHandle(name)).getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (error) {
      if (error?.name === "NotFoundError" || error?.name === "TypeMismatchError") return null;
      throw error;
    }
  }
  async function writeLocal(root, relativePath, bytes) {
    const parts = relativePath.split("/");
    const name = parts.pop();
    let dir = root;
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: true });
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await writable.write(bytes);
    await writable.close();
  }
  function isExtensionManifest(manifest) {
    return Boolean(manifest && manifest.manifest_version === 3 &&
      typeof manifest.name === "string" && manifest.name.trim() &&
      typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/.test(manifest.version) &&
      typeof manifest.background?.service_worker === "string" &&
      typeof manifest.action?.default_popup === "string" &&
      Array.isArray(manifest.permissions) &&
      Array.isArray(manifest.content_scripts));
  }
  async function findExtensionRoot(picked) {
    const candidates = [picked];
    try { candidates.push(await picked.getDirectoryHandle(EXT_DIR)); } catch {  }
    for (const candidate of candidates) {
      try {
        const file = await (await candidate.getFileHandle("manifest.json")).getFile();
        const manifest = JSON.parse(await file.text());
        if (isExtensionManifest(manifest)) return candidate;
      } catch {  }
    }
    throw new Error("Selected folder does not contain a valid Manifest V3 extension manifest. Select the folder containing manifest.json.");
  }
  async function linkFolder() {
    if (!self.showDirectoryPicker) throw new Error("This browser can't open a folder picker.");
    const picked = await self.showDirectoryPicker({ id: "form-filler-extension", mode: "readwrite" });
    const root = await findExtensionRoot(picked);
    await setHandle(root);
    return root.name;
  }
  async function getUpdaterState() {
    return (await chrome.storage.local.get("formFillerUpdaterState")).formFillerUpdaterState || {};
  }
  async function check(token) {
    const prior = await getUpdaterState();
    const remoteSha = await remoteExtensionSha(token);
    let appliedSha = prior.appliedSha;
    if (!appliedSha) {
      appliedSha = remoteSha;
      await chrome.storage.local.set({ formFillerUpdaterState: { ...prior, appliedSha } });
    }
    const handle = await getHandle().catch(() => null);
    let permission = "none";
    if (handle) permission = await handle.queryPermission({ mode: "readwrite" }).catch(() => "prompt");
    return {
      currentVersion: chrome.runtime.getManifest().version,
      remoteSha,
      appliedSha,
      updateAvailable: remoteSha !== appliedSha,
      linked: Boolean(handle),
      permission,
      lastApplied: prior.lastApplied || null,
      checkedAt: new Date().toISOString(),
      error: null
    };
  }
  async function apply(token, { interactive = false } = {}) {
    if (!navigator.locks) return runApply(token, interactive);
    return navigator.locks.request("form-filler-extension-update", { ifAvailable: true }, async lock => {
      if (!lock) return { ok: false, busy: true, error: "Another update is already running." };
      return runApply(token, interactive);
    });
  }
  async function runApply(token, interactive) {
    const handle = await getHandle();
    if (!handle) return { ok: false, needsLink: true, error: "The extension folder isn't linked yet." };
    let permission = await handle.queryPermission({ mode: "readwrite" });
    if (permission !== "granted" && interactive) permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") return { ok: false, needsPermission: true, error: "Folder access needs to be granted again." };

    const remoteSha = await remoteExtensionSha(token);
    const files = await remoteFiles(token, remoteSha);
    if (!files.some(file => file.path === "manifest.json")) throw new Error("The remote extension folder has no manifest.json; refusing to update.");

    const changed = [];
    for (const file of files) {
      const local = await readLocal(handle, file.path);
      if (!local || await gitBlobSha(local) !== file.sha) changed.push(file);
    }
    changed.sort((a, b) => (a.path === "manifest.json") - (b.path === "manifest.json"));
    const downloaded = [];
    for (const file of changed) {
      const bytes = await downloadBlob(token, file.sha);
      if (await gitBlobSha(bytes) !== file.sha) throw new Error("Download of " + file.path + " failed its integrity check.");
      downloaded.push({ file, bytes });
    }
    const manifest = downloaded.find(item => item.file.path === "manifest.json");
    if (manifest) {
      let parsed;
      try { parsed = JSON.parse(new TextDecoder().decode(manifest.bytes)); }
      catch { throw new Error("The downloaded manifest.json is not valid JSON."); }
      if (!isExtensionManifest(parsed)) throw new Error("The downloaded manifest.json is not a structurally valid Manifest V3 extension manifest.");
    }

    for (const { file, bytes } of downloaded) {
      await writeLocal(handle, file.path, bytes);
      const written = await readLocal(handle, file.path);
      if (!written || await gitBlobSha(written) !== file.sha) throw new Error("Could not verify " + file.path + " after writing it.");
    }

    const prior = await getUpdaterState();
    await chrome.storage.local.set({
      formFillerUpdaterState: {
        ...prior,
        appliedSha: remoteSha,
        lastApplied: new Date().toISOString(),
        lastAppliedFiles: changed.map(file => file.path)
      }
    });
    return { ok: true, changed: changed.map(file => file.path), reload: changed.length > 0 };
  }

  self.FormFillerUpdater = { check, apply, linkFolder, getHandle, clearHandle };
})();
