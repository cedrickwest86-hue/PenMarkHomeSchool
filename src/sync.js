// Sync engine: keeps the tracker's data in Supabase and in step across devices.
// The app saves one JSON document. Each save carries the version it was based on; if another
// device saved first, the two versions are merged item by item (three-way merge) and saved again.

const FILE_PREFIXES = { "hs-file:": "files", "hs-akey:": "keys" };

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Three-way merge. base = last version both sides agreed on, local = this device, remote = the other device.
// Lists of records with an `id` merge by id; lists of plain values merge as sets; objects merge key by key.
// When both sides changed the same value, this device's change wins.
export function merge3(base, local, remote) {
  if (same(local, remote)) return local;
  if (same(local, base)) return remote;
  if (same(remote, base)) return local;
  if (Array.isArray(local) && Array.isArray(remote)) {
    const b = Array.isArray(base) ? base : [];
    const withIds = [...local, ...remote].every((x) => isObj(x) && "id" in x);
    if (withIds) {
      const bm = new Map(b.filter(isObj).map((x) => [x.id, x]));
      const lm = new Map(local.map((x) => [x.id, x]));
      const rm = new Map(remote.map((x) => [x.id, x]));
      const out = [];
      const seen = new Set();
      for (const x of [...local, ...remote]) {
        if (seen.has(x.id)) continue;
        seen.add(x.id);
        const bi = bm.get(x.id), li = lm.get(x.id), ri = rm.get(x.id);
        if (li && ri) out.push(merge3(bi, li, ri));
        else if (li && !ri) { if (!bi || !same(bi, li)) out.push(li); }   // remote deleted it: honor unless we changed it
        else if (!li && ri) { if (!bi || !same(bi, ri)) out.push(ri); }   // we deleted it: honor unless they changed it
      }
      return out;
    }
    const key = (v) => JSON.stringify(v);
    const bs = new Set(b.map(key)), ls = new Set(local.map(key)), rs = new Set(remote.map(key));
    const out = [];
    const seen = new Set();
    for (const v of [...local, ...remote]) {
      const k = key(v);
      if (seen.has(k)) continue;
      seen.add(k);
      const removed = bs.has(k) && (!ls.has(k) || !rs.has(k));
      if (!removed) out.push(v);
    }
    return out;
  }
  if (isObj(local) && isObj(remote)) {
    const b = isObj(base) ? base : {};
    const out = {};
    for (const k of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      const inL = k in local, inR = k in remote, inB = k in b;
      if (inL && inR) out[k] = merge3(b[k], local[k], remote[k]);
      else if (inL) { if (!inB || !same(b[k], local[k])) out[k] = local[k]; }
      else if (inR) { if (!inB || !same(b[k], remote[k])) out[k] = remote[k]; }
    }
    return out;
  }
  return local;
}

const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

// A drop-in replacement for the window.storage API the tracker was written against.
// Only a definite "not a member" from the database counts as disconnected. A failed check (phone just woke up,
// no signal yet, sign-in token still refreshing) never signs anyone out. Confirmed twice, a few seconds apart.
export async function confirmedRemoved(supabase) {
  const check = async () => {
    try {
      await supabase.auth.getSession(); // refreshes an expired sign-in token first
      const { data, error } = await supabase.rpc("my_membership");
      if (error || data == null) return false;
      return Array.isArray(data) ? data.length === 0 : !data;
    } catch { return false; }
  };
  if (!(await check())) return false;
  await new Promise((r) => setTimeout(r, 4000));
  return check();
}

export function createSupabaseStorage({ supabase, familyId, onStatus = () => {}, onLostAccess = () => {} }) {
  const synced = {};      // key -> { value, version } last agreed with the server
  const pending = {};     // key -> newest local value not yet saved
  const listeners = {};   // key -> Set(fn) told about values that came from elsewhere
  const timers = {};
  let flushing = {};
  let failures = 0;

  const fileTarget = (key) => {
    const prefix = Object.keys(FILE_PREFIXES).find((p) => key.startsWith(p));
    return prefix ? `${familyId}/${FILE_PREFIXES[prefix]}/${key.replace(/[^A-Za-z0-9_-]/g, "_")}.json` : null;
  };
  const status = () => onStatus(Object.keys(pending).length || Object.values(flushing).some(Boolean) ? (failures ? "offline" : "saving") : "saved");
  const notify = (key, value) => (listeners[key] || new Set()).forEach((fn) => { try { fn(value); } catch {} });

  async function fetchRow(key) {
    const { data, error } = await supabase.from("kv").select("value, version").eq("family_id", familyId).eq("key", key).maybeSingle();
    if (error) throw error;
    return data;
  }

  async function flush(key) {
    if (flushing[key] || !(key in pending)) return;
    flushing[key] = true; status();
    try {
      for (let round = 0; round < 5 && key in pending; round++) {
        const local = pending[key];
        const base = synced[key];
        const { data, error } = await supabase.rpc("kv_put", { p_family: familyId, p_key: key, p_value: local, p_expected: base?.version || 0 });
        if (error) throw error;
        const row = Array.isArray(data) ? data[0] : data;
        if (row?.ok) {
          synced[key] = { value: local, version: Number(row.new_version) };
          if (pending[key] === local) delete pending[key];
          continue;
        }
        // Someone else saved first: merge their version with ours, show the result, and save it.
        if (!row) { synced[key] = null; continue; }
        const remote = { value: row.current_value, version: Number(row.new_version) };
        const merged = JSON.stringify(merge3(parse(base?.value), parse(pending[key]), parse(remote.value)));
        synced[key] = remote;
        pending[key] = merged;
        notify(key, merged);
      }
      failures = 0;
    } catch (e) {
      failures++;
      clearTimeout(timers[key]);
      timers[key] = setTimeout(() => flush(key), Math.min(30000, 2000 * failures));
    } finally {
      flushing[key] = false; status();
    }
  }

  async function poll() {
    try {
      if (await confirmedRemoved(supabase)) { onLostAccess(); return; }
      for (const key of Object.keys(listeners)) {
        if (!listeners[key]?.size || key in pending || flushing[key]) continue;
        const { data } = await supabase.from("kv").select("version").eq("family_id", familyId).eq("key", key).maybeSingle();
        if (data && Number(data.version) > (synced[key]?.version || 0)) {
          const row = await fetchRow(key);
          if (!row || key in pending || flushing[key]) continue;
          synced[key] = { value: row.value, version: Number(row.version) };
          notify(key, row.value);
        }
      }
    } catch {}
  }
  const interval = setInterval(() => { if (document.visibilityState === "visible") poll(); }, 15000);
  const onVisible = () => {
    if (document.visibilityState === "visible") poll();
    else Object.keys(pending).forEach((k) => { clearTimeout(timers[k]); flush(k); });
  };
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", poll);
  const beforeUnload = (e) => { if (Object.keys(pending).length) { e.preventDefault(); e.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);

  return {
    async get(key) {
      const path = fileTarget(key);
      if (path) {
        const { data, error } = await supabase.storage.from("family-files").download(path);
        if (error || !data) throw new Error("not found");
        return { key, value: await data.text() };
      }
      const row = await fetchRow(key);
      if (!row) return null;
      synced[key] = { value: row.value, version: Number(row.version) };
      return { key, value: row.value };
    },
    async set(key, value) {
      const path = fileTarget(key);
      if (path) {
        const blob = () => new Blob([value], { type: "application/json" });
        // New files upload plainly; only an existing file (e.g. during Restore) is overwritten
        let { error } = await supabase.storage.from("family-files").upload(path, blob(), { upsert: false, contentType: "application/json" });
        if (error && /exist|duplicate|409/i.test(`${error.message} ${error.statusCode || ""}`)) {
          ({ error } = await supabase.storage.from("family-files").upload(path, blob(), { upsert: true, contentType: "application/json" }));
        }
        if (error) throw new Error("The file couldn't be saved. Check your connection and try again.");
        return { key, value };
      }
      if (!(key in pending) && synced[key]?.value === value) return { key, value };
      pending[key] = value; status();
      clearTimeout(timers[key]);
      timers[key] = setTimeout(() => flush(key), 700);
      return { key, value };
    },
    async delete(key) {
      const path = fileTarget(key);
      if (path) await supabase.storage.from("family-files").remove([path]);
      else await supabase.from("kv").delete().eq("family_id", familyId).eq("key", key);
      return { key, deleted: true };
    },
    async list() { return { keys: [] }; },
    subscribe(key, fn) {
      (listeners[key] ||= new Set()).add(fn);
      return () => listeners[key].delete(fn);
    },
    async flushAll() { await Promise.all(Object.keys(pending).map((k) => { clearTimeout(timers[k]); return flush(k); })); },
    dispose() {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", poll);
      window.removeEventListener("beforeunload", beforeUnload);
    },
  };
}

// Comparing data from the database with data in the app: same content, regardless of key order
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

// A device connected with one child's own code. The database only ever sends that child's information
// (student_view) and only accepts what a child is allowed to change (student_save). Photos use the normal file storage.
export function createChildStorage({ supabase, familyId, onStatus = () => {}, onLostAccess = () => {} }) {
  const DATA = "hs-tracker:data";
  const base = createSupabaseStorage({ supabase, familyId, onStatus, onLostAccess });
  const listeners = new Set();
  let last = null;       // canonical form of what the app and database last agreed on
  let pending = null;    // newest data from the app not yet saved
  let timer = null, saving = false, failures = 0;
  const notify = (obj) => { const s = JSON.stringify(obj); listeners.forEach((fn) => { try { fn(s); } catch {} }); };
  const status = () => onStatus(pending ? (failures ? "offline" : "saving") : "saved");

  async function save() {
    if (saving || !pending) return;
    saving = true; status();
    const sent = pending;
    try {
      const { data, error } = await supabase.rpc("student_save", { p: sent });
      if (error) throw error;
      if (pending === sent) pending = null;
      failures = 0;
      const c = canonical(data);
      if (c !== canonical(sent)) { last = c; if (!pending) notify(data); } else last = c;
    } catch {
      failures++;
      clearTimeout(timer); timer = setTimeout(save, Math.min(30000, 2000 * failures));
    } finally { saving = false; status(); }
  }
  async function poll() {
    if (pending || saving || document.visibilityState !== "visible") return;
    try {
      if (await confirmedRemoved(supabase)) { onLostAccess(); return; }
      const { data } = await supabase.rpc("student_view");
      if (!data || pending || saving) return;
      const c = canonical(data);
      if (c !== last) { last = c; notify(data); }
    } catch {}
  }
  const interval = setInterval(poll, 15000);
  window.addEventListener("focus", poll);

  return {
    ...base,
    async get(key) {
      if (key !== DATA) return base.get(key);
      const { data, error } = await supabase.rpc("student_view");
      if (error || !data) return null;
      last = canonical(data);
      return { key, value: JSON.stringify(data) };
    },
    async set(key, value) {
      if (key !== DATA) return base.set(key, value);
      const obj = JSON.parse(value);
      if (!pending && canonical(obj) === last) return { key, value };
      pending = obj; status();
      clearTimeout(timer); timer = setTimeout(save, 700);
      return { key, value };
    },
    subscribe(key, fn) {
      if (key !== DATA) return base.subscribe(key, fn);
      listeners.add(fn); return () => listeners.delete(fn);
    },
    async flushAll() { clearTimeout(timer); await save(); await base.flushAll(); },
    dispose() { clearInterval(interval); window.removeEventListener("focus", poll); clearTimeout(timer); base.dispose(); },
  };
}
