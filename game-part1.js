'use strict';
        // --- EMBEDDED AUDIO ---
        // Any sound listed here is played from its base64 blob instead of the procedural (synth) sound.
        // Format:  "name": "data:audio/mpeg;base64,BASE_64_BLOB_HERE",
        // Uncomment a line below (and paste your blob) to use it. Names are the code-names; chase_music and every
        // ambience* entry loop automatically. "drip" = Poolrooms water drips (silent until you add a blob). Any mime type the browser can decode works (mpeg, ogg, wav...).
        const AUDIO = {};
        function audioFromDataUri(u) { // data URI -> ArrayBuffer (null if malformed)
            try { const i = u.indexOf(','); if (i < 0) return null; const bin = atob(u.slice(i + 1).replace(/\s/g, '')), a = new Uint8Array(bin.length); for (let k = 0; k < bin.length; k++) a[k] = bin.charCodeAt(k); return a.buffer; } catch (e) { return null; }
        }

        // --- CUSTOM RIGS & ANIMATIONS ---
        // RIGS: entity code-name -> Base64 of a GLB or FBX model (a data URI also works). If an entity has no rig here,
        // the built-in generated model is used. The custom model is auto-scaled to the generated model's height.
        // Code-names: bacteria, skinstealer, smiler, hound, window_watcher
        const RIGS = {};
        // ANIMATIONS: entity code-name -> { animationName: Base64 GLB/FBX that contains the clip }. The first clip of each file is used
        // (or the clip whose name matches the key). Tracks are mapped onto the rig's bones by bone name (mixamorig prefixes are ignored),
        // only rotations are applied (+ the hips' height), and the hips are kept in place because the game moves the entity itself.
        // Animation names the game plays:
        //   idle       - standing still (light-frozen, debug gallery)        walk      - wandering / investigating
        //   sprint     - chasing / fleeing (also: run, chase)                stunned   - shot with the shotgun / paused (also: stun)
        //   jumpscare  - the death jumpscare                                 menuPose  - main-menu display (also: menu)
        // Missing ones fall back sensibly (sprint -> walk, stunned -> idle -> walk, jumpscare -> sprint -> walk, menuPose -> idle -> walk).
        // Any other name is loaded too (and clips embedded inside the rig file are picked up when their name matches), it just isn't played.
        const ANIMATIONS = {};

        // MODELS: static-model overrides — id (buildItemModel id, e.g. "shotgun", "axe", "crowbar", "water", "shell", ...) ->
        // Base64-encoded GLB (a data URI like "data:model/gltf-binary;base64,..." also works).
        // When an id is present here, the game replaces that static model at runtime with the GLB's scene.
        const MODELS = {};
        //#ASSETS-START
        // --- OFFLOADED ASSET LOADING (v0.8.0) ---
        // Only active when the page is served over http(s). Opened from file:// nothing changes: the embedded base64 tables above are used.
        // After the whole page has loaded, assets are pulled in ONE AT A TIME with idle-time pacing (and extra breathing room during a run):
        //   1) ./assets.txt (or ../assets.txt) if it exists:   audio: {name: base64; other: base64}   rigs: {...}   animations: {...}
        //        (everything base64; animations may be nested  animations: {bacteria: {walk: b64}}  or flat  {bacteria.walk: b64}  /  {bacteria_walk: b64})
        //   2) otherwise the parent directory, by name:  ../audio/<name>.mp3 (.ogg/.wav)   ../rigs/<type>.glb (.fbx, or base64 .txt)
        //        ../animations/<type>/<name>.txt  (also <type>_<name>.txt / <type>.<name>.txt) - animation files must be base64 text.
        // Anything already embedded in AUDIO / RIGS / ANIMATIONS wins and is skipped. Rigs that arrive after an entity was created are attached to it live.
        const _rigWait = {};
        const ASSETS = {
            server: /^https?:$/.test(location.protocol), on: false, src: '', dec: {}, audioDone: false, rigsDone: false, stat: { audio: 0, rigs: 0, anims: 0 }, oac: null,
            TYPES: ['bacteria', 'skinstealer', 'smiler', 'hound', 'window_watcher', 'fake_partygoer', 'partygoer', 'shopkeeper', 'tiny_creature', 'leviathan'],
            ANIMS: ['idle', 'walk', 'sprint', 'run', 'chase', 'stunned', 'stun', 'jumpscare', 'menupose', 'menuPose', 'menu', 'bacteriaability', 'bacteriaAbility'],
            aext: ['mp3', 'ogg', 'wav'], rext: ['glb', 'fbx', 'txt'], apat: null,
            pendingRigs() { return this.server && !this.rigsDone; },
            sleep: ms => new Promise(r => setTimeout(r, ms)),
            async pace() { // yield to the browser between assets; wait longer while a run is in progress so loading never competes with gameplay
                await new Promise(r => window.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 300 }) : setTimeout(r, 30));
                await this.sleep(GameState.isRunning && !GameState.inShop ? 250 : 12);
            },
            async get(url, as) { // null on any failure, and on servers that answer a missing file with an HTML page
                try { const r = await fetch(url); if (!r.ok || /text\/html/i.test(r.headers.get('content-type') || '')) return null; return as === 'text' ? await r.text() : await r.arrayBuffer(); } catch (e) { return null; }
            },
            magic: (ab, n) => String.fromCharCode(...new Uint8Array(ab, 0, Math.min(n, ab.byteLength))),
            isAudio(ab) { const h = this.magic(ab, 4), u = new Uint8Array(ab, 0, 2); return ab.byteLength > 500 && (/^(ID3|OggS|RIFF|fLaC)/.test(h) || (u[0] === 0xFF && (u[1] & 0xE0) === 0xE0)); },
            isRig(ab) { const h = this.magic(ab, 20); return ab.byteLength > 100 && (h.startsWith('glTF') || h.startsWith('Kaydara FBX') || h.startsWith('; FBX')); },
            isB64: t => typeof t === 'string' && t.length > 16 && /^[A-Za-z0-9+/=\s]{16}/.test(t.trim()) && !/^\s*</.test(t),
            async b64(s) { s = String(s).trim(); if (s.startsWith('data:')) s = s.slice(s.indexOf(',') + 1); return await (await fetch('data:application/octet-stream;base64,' + s.replace(/\s/g, ''))).arrayBuffer(); }, // native decode, no JS loop
            adopt(id, b) { Sfx.buf[id] = b; Sfx.st[id] = { dl: 'OK', dec: 'OK', play: 'OK', src: 'FILE', err: '', origin: 'DOWNLOAD', name: 'offloaded asset' }; },
            async audioIn(id, ab) {
                try {
                    if (!this.isAudio(ab)) return false;
                    if (!this.oac) this.oac = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, 1, 44100); // decode without needing a user gesture
                    const b = await this.oac.decodeAudioData(ab.slice(0)); this.dec[id] = b; this.stat.audio++;
                    if (Sfx.loading || Sfx.ready) this.adopt(id, b); // the sound system already started: hot-swap the procedural sound
                    return true;
                } catch (e) { return false; }
            },
            rigIn(type, data) {
                RIGS[type] = data; this.stat.rigs++;
                const w = _rigWait[type]; delete _rigWait[type]; (w || []).forEach(e => { if (e.mesh && !e._rig) { try { rigAttach(e); } catch (er) {} } }); // entities made before the rig arrived (menu, shop...)
            },
            parseTxt(t) {
                const out = { audio: {}, rigs: {}, animations: {} }, n = t.length, re = /(^|[\s;{}])(audio|rigs|animations)\s*:\s*\{/g; let m;
                const obj = (i, o) => {
                    for (;;) {
                        while (i < n && /[\s;,]/.test(t[i])) i++; if (i >= n) return n; if (t[i] === '}') return i + 1;
                        const c = t.indexOf(':', i); if (c < 0) return n; const key = t.slice(i, c).trim().replace(/^['"]|['"]$/g, ''); i = c + 1; while (i < n && /\s/.test(t[i])) i++;
                        if (t[i] === '{') { o[key] = {}; i = obj(i + 1, o[key]); } else { let e = i; while (e < n && t[e] !== ';' && t[e] !== '}') e++; o[key] = t.slice(i, e).trim(); i = e; }
                    }
                };
                while ((m = re.exec(t))) re.lastIndex = obj(re.lastIndex, out[m[2]]);
                return out;
            },
            normAnims(a) {
                const out = {}, put = (ty, nm, v) => { (out[ty] = out[ty] || {})[nm] = v; }, T = this.TYPES.slice().sort((x, y) => y.length - x.length);
                for (const [k, v] of Object.entries(a)) {
                    if (v && typeof v === 'object') { for (const [nm, b] of Object.entries(v)) put(k, nm, b); continue; }
                    const ty = T.find(x => k.startsWith(x) && /^[._\/-]/.test(k.slice(x.length))); if (ty) put(ty, k.slice(ty.length + 1), v);
                }
                return out;
            },
            async fromBundle(b) {
                const strip = s => s.replace(/\.[a-z0-9]+$/i, '');
                for (const [name, v] of Object.entries(b.audio)) { const id = strip(name); if (AUDIO[id] || this.dec[id]) continue; try { await this.audioIn(id, await this.b64(v)); } catch (e) {} await this.pace(); }
                this.audioDone = true;
                const an = this.normAnims(b.animations);
                for (const [name, v] of Object.entries(b.rigs)) {
                    const ty = strip(name).toLowerCase(); if (RIGS[ty] || !this.isB64(v)) continue;
                    if (an[ty]) { ANIMATIONS[ty] = Object.assign(ANIMATIONS[ty] || {}, an[ty]); this.stat.anims += Object.keys(an[ty]).length; } // animations first, rig last (rigLoad reads them once)
                    this.rigIn(ty, v); await this.pace();
                }
            },
            async fromFolders() {
                const root = new URL('../', location.href).href;
                for (const id of Object.keys(SFX_REG)) {
                    if (AUDIO[id] || this.dec[id]) continue; const alt = String(SFX_REG[id].f || '').replace(/\.[a-z0-9]+$/i, ''), names = [...new Set([id, alt].filter(Boolean))]; let ok = false;
                    for (const nm of names) { for (const ex of this.aext.slice()) { const ab = await this.get(root + 'audio/' + nm + '.' + ex); if (ab && await this.audioIn(id, ab)) { this.aext = [ex, ...this.aext.filter(x => x !== ex)]; ok = true; break; } } if (ok) break; }
                    await this.pace();
                }
                this.audioDone = true;
                for (const ty of this.TYPES) {
                    if (RIGS[ty]) continue; let data = null;
                    for (const ex of this.rext.slice()) {
                        if (ex === 'txt') { const t = await this.get(root + 'rigs/' + ty + '.txt', 'text'); if (this.isB64(t)) data = t.trim(); }
                        else { const ab = await this.get(root + 'rigs/' + ty + '.' + ex); if (ab && this.isRig(ab)) data = ab; }
                        if (data) { this.rext = [ex, ...this.rext.filter(x => x !== ex)]; break; }
                    }
                    if (!data) { await this.pace(); continue; }
                    const pats = [(t, n) => `animations/${t}/${n}.txt`, (t, n) => `animations/${t}_${n}.txt`, (t, n) => `animations/${t}.${n}.txt`]; ANIMATIONS[ty] = ANIMATIONS[ty] || {};
                    for (const nm of this.ANIMS) {
                        if (ANIMATIONS[ty][nm]) continue; const order = this.apat == null ? [0, 1, 2] : [this.apat];
                        for (const pi of order) { const t = await this.get(root + pats[pi](ty, nm), 'text'); if (this.isB64(t)) { ANIMATIONS[ty][nm] = t.trim(); this.apat = pi; this.stat.anims++; break; } }
                        await this.pace();
                    }
                    this.rigIn(ty, data);
                }
            },
            async start() {
                if (!this.server) { this.rigsDone = true; return; }
                this.on = true; const t0 = performance.now();
                try {
                    let bundle = null;
                    for (const u of ['assets.txt', '../assets.txt']) { const txt = await this.get(u, 'text'); if (txt && /(audio|rigs|animations)\s*:\s*\{/.test(txt.slice(0, 4096))) { bundle = this.parseTxt(txt); this.src = u; break; } }
                    if (bundle) await this.fromBundle(bundle); else { this.src = '../audio, ../rigs, ../animations'; await this.fromFolders(); }
                } catch (e) { console.warn('[assets] loading stopped:', e); }
                this.audioDone = this.rigsDone = true; Object.keys(_rigWait).forEach(k => delete _rigWait[k]);
                console.log('[assets] ' + (this.src || 'nothing found') + ': ' + this.stat.audio + ' sounds, ' + this.stat.rigs + ' rigs, ' + this.stat.anims + ' animations in ' + Math.round(performance.now() - t0) + 'ms');
            }
        };
        { const go = () => setTimeout(() => ASSETS.start(), 0); if (document.readyState === 'complete') go(); else window.addEventListener('load', go); } // after the whole page has been parsed and loaded
        //#ASSETS-END
        function replaceContents(g, m) { while (g.children.length) g.remove(g.children[0]); g.add(m); }
        async function loadBase64Model(entry) { // Base64 (or data URI) GLB -> THREE.Group
            const libs = await rigLibs();
            const bin = rigBytes(entry);
            if (!bin) throw new Error('MODELS: not a valid base64 GLB');
            const url = URL.createObjectURL(new Blob([bin], { type: 'model/gltf-binary' }));
            try { return (await new libs.GLTFLoader().loadAsync(url)).scene; } finally { URL.revokeObjectURL(url); }
        }
        const RIG_ALIAS = { run: 'sprint', chase: 'sprint', stun: 'stunned', freeze: 'idle', menu: 'menupose', menupose: 'menupose' };
        const RIG_FALLBACK = { walk: ['walk', 'sprint', 'idle'], sprint: ['sprint', 'walk', 'idle'], idle: ['idle', 'walk'], stunned: ['stunned', 'idle', 'walk'], jumpscare: ['jumpscare', 'sprint', 'walk'], bacteriaability: ['bacteriaability'], menupose: ['menupose', 'idle', 'walk'] };
        const RIG_LIST = new Set(), _rigCache = {}; let _rigLibs = null, _rigRaf = 0, _rigLast = 0;
        const rigNorm = n => String(n).replace(/^mixamorig\d*:?/i, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
        function rigBytes(b64) { // Base64 (or data URI) -> ArrayBuffer; raw bytes (fetched GLB/FBX) pass straight through
            if (b64 instanceof ArrayBuffer) return b64; if (ArrayBuffer.isView(b64)) return b64.buffer.slice(b64.byteOffset, b64.byteOffset + b64.byteLength);
            try { let t = String(b64).trim(); if (t.startsWith('data:')) t = t.slice(t.indexOf(',') + 1); const bin = atob(t.replace(/\s/g, '')), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; } catch (e) { return null; }
        }
        function rigLibs() { // loaded lazily, only when RIGS is actually used
            return _rigLibs || (_rigLibs = Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/loaders/FBXLoader.js'), import('three/addons/utils/SkeletonUtils.js')])
                .then(([g, f, u]) => ({ GLTFLoader: g.GLTFLoader, FBXLoader: f.FBXLoader, clone: u.clone })));
        }
        async function rigParse(b64) { // GLB or FBX -> { scene, clips }
            const ab = rigBytes(b64); if (!ab || ab.byteLength < 20) throw new Error('not valid Base64');
            const L = await rigLibs(), head = String.fromCharCode(...new Uint8Array(ab, 0, 20));
            if (head.startsWith('glTF')) return await new Promise((res, rej) => new L.GLTFLoader().parse(ab, '', g => res({ scene: g.scene, clips: g.animations || [] }), rej));
            if (head.startsWith('Kaydara FBX') || head.startsWith('; FBX')) { const o = new L.FBXLoader().parse(ab, ''); return { scene: o, clips: o.animations || [] }; }
            throw new Error('unknown format (expected GLB or FBX)');
        }
        function rigRetarget(clip, rigScene, key) { // map a clip's tracks onto the rig's bones by name
            const bones = new Map(); let first = null; rigScene.traverse(o => { if (o.isBone) { bones.set(rigNorm(o.name), o); if (!first) first = o; } });
            const hips = bones.get('hips') || first, tracks = [];
            for (const t of clip.tracks) {
                const m = /^(.*)\.(position|quaternion|scale|rotation)$/.exec(t.name); if (!m) continue;
                const bone = bones.get(rigNorm(m[1].split('/').pop())); if (!bone) continue;
                const nm = THREE.PropertyBinding.sanitizeNodeName(bone.name);
                if (m[2] === 'quaternion') tracks.push(new THREE.QuaternionKeyframeTrack(nm + '.quaternion', Array.from(t.times), Array.from(t.values)));
                else if (m[2] === 'position' && bone === hips) { // keep hips height (scaled to this rig), drop horizontal travel -> in place
                    const v = Array.from(t.values), n = v.length / 3; let my = 0; for (let i = 0; i < n; i++) my += v[i * 3 + 1]; my /= n;
                    const k = (Math.abs(my) > 1e-5 && Math.abs(bone.position.y) > 1e-5) ? Math.min(100, Math.max(0.01, bone.position.y / my)) : 1;
                    for (let i = 0; i < n; i++) { v[i * 3] = bone.position.x; v[i * 3 + 1] *= k; v[i * 3 + 2] = bone.position.z; }
                    tracks.push(new THREE.VectorKeyframeTrack(nm + '.position', Array.from(t.times), v));
                }
            }
            if (!tracks.length) { console.warn('[ANIMATIONS] "' + key + '": no track matched the rig bones (check the bone names)'); return null; }
            return new THREE.AnimationClip(key, clip.duration, tracks);
        }
        function rigLoad(type) { // parse the rig + its animations once per entity type
            return _rigCache[type] || (_rigCache[type] = (async () => {
                const L = await rigLibs(), base = await rigParse(RIGS[type]), clips = {};
                base.scene.traverse(o => { if (o.isSkinnedMesh) o.frustumCulled = false; });
                const add = (name, clip) => { const k = RIG_ALIAS[String(name).toLowerCase()] || String(name).toLowerCase(), rc = rigRetarget(clip, base.scene, k); if (rc) clips[k] = rc; };
                (base.clips || []).forEach(c => add(c.name, c));
                for (const [k, v] of Object.entries(ANIMATIONS[type] || {})) {
                    try { const a = await rigParse(v), c = a.clips.find(x => x.name.toLowerCase() === String(k).toLowerCase()) || a.clips[0]; if (c) add(k, c); else console.warn('[ANIMATIONS] "' + type + '.' + k + '" contains no animation clip'); }
                    catch (er) { console.warn('[ANIMATIONS] "' + type + '.' + k + '" failed to load:', er); }
                }
                return { scene: base.scene, clips, clone: L.clone };
            })());
        }
        function rigInWorld(o) { while (o.parent) o = o.parent; return o === scene || o === menuScene; }
        function rigMeasure(e) { // height of the generated model (before extras are added), used to size the custom rig
            if (!RIGS[e.type] && !ASSETS.pendingRigs()) return; e.mesh.updateMatrixWorld(true); // (measured even while rigs are still downloading, before extras are added)
            const b = new THREE.Box3(), t = new THREE.Box3(); e.mesh.children.forEach(c => { if (c === e.stunRing) return; t.setFromObject(c); if (!t.isEmpty()) b.union(t); });
            if (!b.isEmpty()) e._genBox = { min: b.min.y - e.mesh.position.y, max: b.max.y - e.mesh.position.y };
            if (e.type === 'smiler') e._genBox = { min: -1.6, max: 0.8 }; // generated smiler is a flat sprite; give a custom one a normal body height
        }
        function rigAttach(e) {
            if (!RIGS[e.type]) { if (ASSETS.pendingRigs()) (_rigWait[e.type] = _rigWait[e.type] || []).push(e); return; } // no custom rig (yet) -> keep the generated model; offloaded rigs attach later
            rigLoad(e.type).then(lib => rigBuild(e, lib)).catch(er => console.warn('[RIGS] "' + e.type + '": custom rig failed, using the generated model.', er));
        }
        function rigBuild(e, lib) {
            if (e._rig || !e.mesh) return;
            const root = lib.clone(lib.scene), holder = new THREE.Group(); holder.add(root); holder.updateMatrixWorld(true);
            const box = new THREE.Box3().setFromObject(holder), size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
            if (!(size.y > 1e-6)) throw new Error('rig has no visible geometry');
            root.position.set(-ctr.x, -box.min.y, -ctr.z); // feet at 0, centered
            const gb = e._genBox || { min: -1.5, max: 1.5 }; holder.scale.setScalar(Math.max(0.5, gb.max - gb.min) / size.y);
            holder.position.y = e.mesh.parent === scene ? -2 : gb.min; // in the maze: stand on the floor; menu/gallery: same vertical extent as the generated model
            e.mesh.children.slice().forEach(c => { if (c !== e.stunRing) c.visible = false; }); // hide the generated model
            e.mesh.add(holder);
            const mixer = new THREE.AnimationMixer(root), actions = {}; for (const [k, c] of Object.entries(lib.clips)) actions[k] = mixer.clipAction(c);
            e._rig = { e, holder, mixer, actions, cur: null, curKey: null, frozen: false }; RIG_LIST.add(e._rig); rigStartLoop();
        }
        function rigPick(r) { // which animation should this entity be playing right now
            const e = r.e, p = e.mesh.parent;
            if (p === scene) { if (GameState.isJumpscaring && GameState.jumpscareEntity === e) return 'jumpscare'; if (e._abilT > 0 && e.stunTimer <= 0 && r.actions.bacteriaability) return 'bacteriaability'; if (e.stunTimer > 0) return 'stunned'; if ((e.state === 'chase' && e._sprinting !== false) || e.state === 'flee' || e.state === 'lunge' || e.state === 'swarm') return 'sprint'; if (e.state === 'light_freeze') return 'idle'; return 'walk'; }
            return p === menuScene ? 'menupose' : 'idle';
        }
        function rigPlay(r, key) {
            let act = null, used = null; for (const k of (RIG_FALLBACK[key] || [key, 'walk'])) if (r.actions[k]) { act = r.actions[k]; used = k; break; }
            r.frozen = key === 'idle' && used !== 'idle'; // no idle clip: hold a pose instead of walking in place
            if (used === r.curKey) return;
            const prev = r.cur; r.cur = act; r.curKey = used; if (prev && prev !== act) prev.fadeOut(0.25); if (act) act.reset().fadeIn(0.25).play();
        }
        function rigStartLoop() { // one tiny loop drives every custom rig (game, menu, gallery, jumpscare)
            if (_rigRaf) return; _rigLast = performance.now();
            const tick = t => { _rigRaf = requestAnimationFrame(tick); const dt = Math.min((t - _rigLast) / 1000, 0.1); _rigLast = t; if (GameState.isPaused) return;
                for (const r of RIG_LIST) { if (!rigInWorld(r.e.mesh)) { RIG_LIST.delete(r); continue; } rigPlay(r, rigPick(r)); r.mixer.update(r.frozen ? 0 : dt); } };
            _rigRaf = requestAnimationFrame(tick);
        }

        // --- GRAPHICS PRESETS & ENGINE SETTINGS ---
        const GraphicsPresets = {
            potato: {
                id: 'potato',
                label: 'POTATO',
                description: 'Ultra-low 45% render scale, 128px textures, shadows disabled, matte surfaces, and minimal lighting for maximum FPS on low-end integrated hardware.',
                resScale: 0.45,
                aa: 'off',
                shadowSize: 0,
                texSize: 128,
                reflections: 'off',
                rtMode: 'off',
                maxLights: 0,
                vhsFx: 'off'
            },
            low: {
                id: 'low',
                label: 'LOW',
                description: '70% resolution scale, 256px textures, 512px shadows, and sparse ceiling lighting for smooth performance on older laptops and light GPUs.',
                resScale: 0.7,
                aa: 'off',
                shadowSize: 512,
                texSize: 256,
                reflections: 'off',
                rtMode: 'point',
                maxLights: 8,
                vhsFx: 'on'
            },
            medium: {
                id: 'medium',
                label: 'MEDIUM',
                description: 'Native 100% resolution, 512px textures, 1024px soft shadows, PMREM environment reflections, and 16 dynamic ceiling lights.',
                resScale: 1.0,
                aa: 'standard',
                shadowSize: 1024,
                texSize: 512,
                reflections: 'env',
                rtMode: 'point',
                maxLights: 16,
                vhsFx: 'on'
            },
            high: {
                id: 'high',
                label: 'HIGH',
                description: 'Native resolution with ACES Filmic tone mapping, 1024px textures (8x anisotropic), 2048px soft shadows, and 32 dynamic ceiling lights.',
                resScale: 1.0,
                aa: 'filmic',
                shadowSize: 2048,
                texSize: 1024,
                reflections: 'env',
                rtMode: 'point',
                maxLights: 32,
                vhsFx: 'on'
            },
            rtx: {
                id: 'rtx',
                label: 'RTX',
                description: 'Meant for real gaming PCs: Full real-time planar mirror floor reflections, Path Tracing multi-bounce global illumination, 4096px max shadow resolution, 2048px ultra textures (16x anisotropic), and 64 active light sources.',
                resScale: 1.5,
                aa: 'filmic',
                shadowSize: 4096,
                texSize: 2048,
                reflections: 'planar',
                rtMode: 'pathtracing',
                maxLights: 64,
                vhsFx: 'on'
            }
        };

        // --- DIFFICULTY CONFIGURATIONS ---
        const DifficultyConfigs = {
            easy: {
                id: 'easy',
                label: 'EASY',
                description: 'Monsters are slower with poor line of sight and shorter vision range. They must catch you twice to kill you (pausing for 2s after the first catch). Every 45s, an exit arrow appears for 5s.',
                playerSpeedMult: 1.0,
                staminaDrainMult: 0.9,
                sanityDrainMult: 0.85,
                monsterSpeedMult: 0.72,
                monsterMaxSpeedCap: 5.5,
                visionRange: 13,
                visionConeDot: 0.45,
                chances: 2,
                exitArrowInterval: 45,
                exitArrowDuration: 5,
                pitchBlackFog: false,
                fogDensityMult: 0.9,
                pingInterval: 0,
                footstepHearRangeWalk: 3,
                footstepHearRangeSprint: 6,
                shotgunSpawns: false,
                constantTracking: false,
                cornerChase: false // Easy keeps existing behavior (lose the chase on LOS break)
            },
            normal: {
                id: 'normal',
                label: 'NORMAL',
                description: 'Standard Backrooms survival horror experience. Balanced stamina, sanity, fog density, and entity hunting behavior. One catch is fatal.',
                playerSpeedMult: 1.0,
                staminaDrainMult: 1.0,
                sanityDrainMult: 1.0,
                monsterSpeedMult: 1.0,
                monsterMaxSpeedCap: 7.5,
                visionRange: 24,
                visionConeDot: -1.0,
                chances: 1,
                exitArrowInterval: 0,
                exitArrowDuration: 0,
                pitchBlackFog: false,
                fogDensityMult: 1.0,
                pingInterval: 0,
                footstepHearRangeWalk: 5,
                footstepHearRangeSprint: 9,
                shotgunSpawns: false,
                constantTracking: false,
                cornerChase: true
            },
            hard: {
                id: 'hard',
                label: 'HARD',
                description: 'Stamina drains 1.1x faster and fog is pitch-black. Monsters are faster (though still slightly slower than your full sprint). One chance.',
                playerSpeedMult: 1.0,
                staminaDrainMult: 1.1,
                sanityDrainMult: 1.15,
                monsterSpeedMult: 1.22,
                monsterMaxSpeedCap: 7.6, // Player sprint is 8.51, so monsters are faster than walk (4.6) but slower than sprint
                visionRange: 26,
                visionConeDot: -1.0,
                chances: 1,
                exitArrowInterval: 0,
                exitArrowDuration: 0,
                pitchBlackFog: true,
                fogDensityMult: 1.12,
                pingInterval: 0,
                footstepHearRangeWalk: 6,
                footstepHearRangeSprint: 11,
                shotgunSpawns: false,
                constantTracking: false,
                cornerChase: true
            },
            extreme: {
                id: 'extreme',
                label: 'EXTREME',
                description: 'Monsters ping your location every 30s and hear your loud footsteps from afar. Monsters are faster than you! An occasional single-use shotgun spawns (only 1 active at a time) that stuns a monster for 20s. 1.2x stamina drain, 2x sanity drain, thicker fog.',
                playerSpeedMult: 1.0,
                staminaDrainMult: 1.2,
                sanityDrainMult: 2.0,
                monsterSpeedMult: 1.85,
                monsterMaxSpeedCap: 9.4, // Faster than player sprint (8.51)
                visionRange: 28,
                visionConeDot: -1.0,
                chances: 1,
                exitArrowInterval: 0,
                exitArrowDuration: 0,
                pitchBlackFog: false,
                fogDensityMult: 1.35,
                pingInterval: 30,
                footstepHearRangeWalk: 14,
                footstepHearRangeSprint: 24,
                shotgunSpawns: true,
                constantTracking: false,
                cornerChase: true
            },
            impossible: {
                id: 'impossible',
                label: 'IMPOSSIBLE',
                description: 'Monsters constantly know where you are and move faster than you. Fog is much thicker and pitch-black. NO shotguns spawn, and you run 5% slower. Beating this awards an official achievement!',
                playerSpeedMult: 0.95,
                staminaDrainMult: 1.25,
                sanityDrainMult: 2.0,
                monsterSpeedMult: 1.92,
                monsterMaxSpeedCap: 9.5, // Faster than player sprint (8.08)
                visionRange: 40,
                visionConeDot: -1.0,
                chances: 1,
                exitArrowInterval: 0,
                exitArrowDuration: 0,
                pitchBlackFog: true,
                fogDensityMult: 1.65,
                pingInterval: 0,
                footstepHearRangeWalk: 30,
                footstepHearRangeSprint: 45,
                shotgunSpawns: false,
                constantTracking: true,
                cornerChase: true
            }
        };

        // --- GLOBAL STATE ---
        const GameState = {
            isRunning: false,
            isPaused: false,
            isJumpscaring: false,
            jumpscareEntity: null,
            jumpscareTimer: 0,
            isBeingChased: false,
            chasePulseTimer: 0,
            level: 0,
            timeAlive: 0,
            lastFrameTime: 0,
            cellSize: 4,
            gridSize: 36,
            difficulty: 'normal',
            graphicsPreset: 'medium',
            graphics: { ...GraphicsPresets.medium },
            micEnabled: false,
            micVolume: 0,
            micAttractCooldown: 0,
            chancesRemaining: 1,
            globalMonsterPauseTimer: 0,
            graceTimer: 0,
            exitArrowTimer: 45,
            exitArrowShowTimer: 0,
            exitPos: new THREE.Vector3(),
            pingTimer: 30,
            hasShotgun: false,
            inv: [null, null, null, null, null],
            invSel: 0,
            trackerTimer: 60,
            trackerInWorld: false,
            shotgunSpawnedInWorld: false,
            shotgunSpawnTimer: 12,
            bannerTimer: 0,
            player: {
                baseSpeed: 4.6,
                speed: 4.6,
                runMultiplier: 1.85,
                stamina: 100,
                sanity: 100,
                battery: 100,
                flashlightOn: true,
                _immob: 0 // seconds of forced immobility (bacterium scream / punch)
            },
            grid: [],
            entities: [],
            items: [],
            props: [],
            ceilingLights: [],
            rtBounceLights: [],
            floorReflector: null,
            lightsOutEvent: false,
            lightsOutTimer: 0
        };

        const LevelData = [
            {
                name: "Level 0: The Lobby", subTarget: 'Sub-Level 0.2: Remodeled Mess', subChance: 0.4,
                objective: "Find the glitching wall to escape.",
                fogColor: 0x3b3314,
                fogDensity: 0.088,
                ambientLight: 0x262110,
                fixtureColor: 0xfff2c2,
                floorTex: 'carpet',
                wallTex: 'wallpaper',
                ceilTex: 'ceiling',
                layout: 'maze', ceilH: 4,
                entityType: 'bacteria',
                entityCount: 3,
                itemCount: 5,
                exitType: 'glitch'
            },
            {
                name: "Sub-Level 0.2: Remodeled Mess", sub: true,
                objective: "Navigate the unfinished drywall maze to the exit.",
                fogColor: 0x2a261f,
                fogDensity: 0.095,
                ambientLight: 0x1c1914,
                fixtureColor: 0xffe8b0,
                floorTex: 'concrete',
                wallTex: 'drywall',
                ceilTex: 'ceiling',
                layout: 'maze', ceilH: 4.2,
                entityType: 'bacteria',
                entityCount: 3,
                itemCount: 4,
                exitType: 'door'
            },
            {
                name: "Level -1",
                objective: "Follow the endless concrete hallway. The walls keep changing colour. Find the way out.",
                fogColor: 0x10100c, fogDensity: 0.1, ambientLight: 0x2a2418, fixtureColor: 0xd8d0b0,
                floorTex: 'carpet', wallTex: 'concrete_dark', ceilTex: 'ceiling', layout: 'tunnels', ceilH: 3.3,
                entityType: 'smiler', entityCount: 4, itemCount: 5, exitType: 'door', gimmick: 'shift'
            },
            {
                name: "Level 1: Habitable Zone", subTarget: 'Sub-Level 1.5: Inverted', subChance: 0.3,
                objective: "Depth perception is lost in the dark warehouse. Find the stairwell.",
                fogColor: 0x070709,
                fogDensity: 0.122,
                ambientLight: 0x0a0a0d,
                fixtureColor: 0xd9e6ff,
                floorTex: 'concrete_dark',
                wallTex: 'concrete_dark',
                ceilTex: 'ducts',
                layout: 'habitable', ceilH: 7.5,
                entityType: 'skinstealer',
                entityCount: 4,
                itemCount: 5,
                exitType: 'door',
                gimmick: 'lightsout'
            },
            {
                name: "Sub-Level 1.5: Inverted", sub: true,
                objective: "Reality is inverted. Evade the Mother's children and escape.",
                fogColor: 0x1c0508,
                fogDensity: 0.11,
                ambientLight: 0x1a0508,
                fixtureColor: 0xff4d66,
                floorTex: 'inverted_floor',
                wallTex: 'inverted_wall',
                ceilTex: 'inverted_floor',
                layout: 'maze', ceilH: 4,
                entityType: 'skinstealer',
                entityCount: 4,
                itemCount: 4,
                exitType: 'glitch'
            },
            {
                name: "Level 2: Pipe Dreams",
                objective: "Navigate the suffocating steam tunnels to the fire exit.",
                fogColor: 0x0a0707,
                fogDensity: 0.115,
                ambientLight: 0x0e0a0a,
                fixtureColor: 0xffb36b,
                floorTex: 'concrete_dark',
                wallTex: 'pipes',
                ceilTex: 'pipes',
                layout: 'tunnels', ceilH: 3.2,
                entityType: 'mixed',
                entityCount: 5,
                itemCount: 5,
                exitType: 'fireexit',
                gimmick: 'steam'
            },
            {
                name: "Level 3: Electrical Station",
                objective: "Evade the high-voltage arcs and find the elevator.",
                fogColor: 0x060a10,
                fogDensity: 0.11,
                ambientLight: 0x0b121c,
                fixtureColor: 0xbbe6ff,
                floorTex: 'concrete_dark',
                wallTex: 'brick_wires',
                ceilTex: 'ducts',
                layout: 'maze', ceilH: 4.3,
                entityType: 'mixed_l3',
                entityCount: 6,
                itemCount: 5,
                exitType: 'elevator',
                gimmick: 'sparks'
            },
            {
                name: "Level 4: Abandoned Office",
                objective: "Cross the dark cubicles to the stairwell.",
                fogColor: 0x0f1316,
                fogDensity: 0.092,
                ambientLight: 0x13171b,
                fixtureColor: 0xe6f2ff,
                floorTex: 'office_carpet',
                wallTex: 'office_wall',
                ceilTex: 'ceiling',
                layout: 'rooms', ceilH: 3.0,
                entityType: 'window_watcher',
                entityCount: 5,
                itemCount: 5,
                exitType: 'door',
                gimmick: 'rain_windows'
            },
            {
                name: "Level 5: Terror Hotel",
                objective: "Survive the endless crimson corridors and find the final exit.",
                fogColor: 0x180707,
                fogDensity: 0.105,
                ambientLight: 0x190909,
                fixtureColor: 0xffcc88,
                floorTex: 'hotel_carpet',
                wallTex: 'hotel_wall',
                ceilTex: 'ceiling',
                layout: 'hotel', ceilH: 3.4,
                entityType: 'mixed_l5',
                entityCount: 6,
                itemCount: 5,
                exitType: 'fireexit',
                gimmick: 'hotel_props'
            },
            {
                name: "Level 6: Lights Out",
                objective: "The lights are gone. Only your flashlight, your sanity and the sound of something breathing. Find the exit.",
                fogColor: 0x000000, fogDensity: 0.13, ambientLight: 0x050506, fixtureColor: 0x111111,
                floorTex: 'concrete', wallTex: 'concrete_dark', ceilTex: 'ceiling', layout: 'maze', ceilH: 4,
                entityType: 'smiler', entityCount: 6, itemCount: 6, exitType: 'door', gimmick: 'blackout'
            },
            {
                name: "Party Room (BETA)", party: true,
                objective: "Mingle, find a cake. [E] take it, [C] eat it on the spot. Then use the exit.",
                fogColor: 0x2a1030, fogDensity: 0.045, ambientLight: 0x6a4a78, fixtureColor: 0xffc8f0,
                floorTex: 'party_floor', wallTex: 'party_wall', ceilTex: 'ceiling', layout: 'party_dense', ceilH: 4.8,
                entityType: 'bacteria', entityCount: 4, itemCount: 0, exitType: 'door', gimmick: 'party'
            },
            {
                name: "Level !: Run For Your Life", hidden: true, hallway: true, noLol: true, noLeave: true,
                objective: "RUN. Everything is hunting you. The hallway does not end until it does. There is no leaving.",
                fogColor: 0x1a0505, fogDensity: 0.06, ambientLight: 0x3a1010, fixtureColor: 0xff3322,
                floorTex: 'concrete_dark', wallTex: 'concrete_dark', ceilTex: 'ceiling',
                entityType: 'mixed_bang', entityCount: 12, itemCount: 8, exitType: 'door'
            },
            {
                name: "Poolrooms (BETA)", hidden: true, beta: true, pools: true,
                objective: "A massive silent maze of tall tiled rooms. Stay out of the whirlpools. Do not trust the deep. Find the exit.",
                fogColor: 0xcfe9f2, fogDensity: 0.02, ambientLight: 0xe8f6ff, fixtureColor: 0xffffff,
                floorTex: 'pool_tile', wallTex: 'pool_tile', ceilTex: 'pool_sky', layout: 'pools', ceilH: 12, gridSize: 72,
                entityType: 'skinstealer', entityCount: 0, itemCount: 10, exitType: 'door'
            },
            {
                name: "Level 7: Thalassophobia", hidden: true, main: true, pools: true, thalasso: true,
                objective: "An endless open ocean. Cross the black water between the rocks. Something below is listening for you. Stay out of the water.",
                fogColor: 0x0a2230, fogDensity: 0.013, ambientLight: 0x7fb8d0, fixtureColor: 0xaaddff,
                floorTex: 'concrete_dark', wallTex: 'concrete_dark', ceilTex: 'pool_sky', layout: 'thalasso', ceilH: 36, gridSize: 60,
                entityType: 'skinstealer', entityCount: 0, itemCount: 8, exitType: 'door'
            },
            {
                name: "Level 8: Horror Attraction", hidden: true, main: true, creator: true, attraction: true,
                objective: "A creator-made, abandoned horror attraction. Shoot the lights down, watch the corners, break the cracked walls. Something sits at the exit.",
                fogColor: 0x000000, fogDensity: 0.06, ambientLight: 0x0a0608, fixtureColor: 0xff9a5a,
                floorTex: 'concrete_dark', wallTex: 'concrete_dark', ceilTex: 'ceiling', layout: 'attraction', ceilH: 9, gridSize: 64,
                entityType: 'mixed_bang', entityCount: 5, itemCount: 10, exitType: 'door'
            },
            {
                name: "Level 9: Haven", hidden: true, main: true, creator: true, haven: true,
                objective: "A creator-made suburb under a fake dome. Every 30 seconds night falls and the eyes come. Stay indoors, beware the residents, and get inside the water tower.",
                fogColor: 0xaad6ff, fogDensity: 0, ambientLight: 0xffffff, fixtureColor: 0xffffff,
                floorTex: 'concrete_dark', wallTex: 'concrete_dark', ceilTex: 'ceiling', layout: 'haven', ceilH: 4, gridSize: 160,
                entityType: 'skinstealer', entityCount: 0, itemCount: 0, exitType: 'door'
            }
        ];

        // --- ROBUST PROCEDURAL WEB AUDIO ENGINE (GUARANTEED SPEAKER OUTPUT) ---
        // ===================== MULTIPLAYER =====================
        // P2P over PeerJS (WebRTC). The room code is the host's lobby peer id ("BKRM-<CODE>"); everybody also owns a personal peer
        // that carries the full mesh (game data + voice). The host (party leader) owns room settings, the roster, run start/end and
        // the authoritative entity snapshots. A random successor order is re-rolled and broadcast on every roster change, so when the
        // host vanishes every client already knows who takes over and re-claims the same room code.
        //#MPCORE-START
        const MP_MAX = 6, MP_JOIN_CD = 3000, MP_PFX = 'BKRM-', MP_STUN_ITEMS = ['shotgun', 'axe', 'crowbar'];
        const MP_NAMES = ['Wanderer', 'Lurker', 'Moth', 'Static', 'Hum', 'Glitch', 'Drifter', 'Flicker', 'Echo', 'Pilgrim', 'Nobody', 'Liminal', 'Mold', 'Buzz', 'Vacancy', 'Fluorescent'];
        const mpEl = id => document.getElementById(id);
        const mpLS = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } };
        const mpRandName = () => MP_NAMES[Math.floor(Math.random() * MP_NAMES.length)] + Math.floor(10 + Math.random() * 90);
        function mpSanCode(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '').replace(/[-_]{2,}/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 20); }
        function mpRng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
        function mpWithSeed(seed, fn) { const orig = Math.random; Math.random = mpRng(seed); try { return fn(); } finally { Math.random = orig; } }
        const MP = {
            active: false, isHost: false, hostId: null, code: '', peer: null, reg: null, conns: {}, seen: {}, players: {}, net: {}, dead: {}, order: [],
            me: { id: null, name: (mpLS('mp_name', '') || '').slice(0, 16) || mpRandName(), color: Math.random(), ghost: false },
            settings: { allowJoin: true, beta: false, hear: true, diff: 'normal' },
            phase: 'lobby', roomSeed: 1, runNo: 0, seq: [0], runN: 1, votes: {}, shopT0: 0, lastJoin: 0, entN: 0, busy: false,
            game: {}, // hooks filled in by the game-side code (UI, avatars, level building)
            now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
            count: () => Object.keys(MP.players).length,
            newPeer(id) {
                return new Promise((res, rej) => {
                    let p, done = false; try { p = id ? new Peer(id) : new Peer(); } catch (e) { return rej({ type: 'nopeer' }); }
                    p.on('open', () => { done = true; res(p); });
                    p.on('error', e => { if (!done) { done = true; try { p.destroy(); } catch (_) {} rej(e); } else MP.peerError(e); });
                    setTimeout(() => { if (!done) { done = true; try { p.destroy(); } catch (_) {} rej({ type: 'timeout' }); } }, 12000);
                });
            },
            peerError(e) { /* post-open errors: individual connection problems are handled by their close handlers */ },
            info() { return { id: MP.me.id, name: MP.me.name, color: MP.me.color }; },
            // ---------- hosting ----------
            async create(rawCode, allowJoin, beta, diff) {
                if (typeof Peer === 'undefined') return 'Multiplayer could not load PeerJS (are you offline?).';
                if (MP.active || MP.busy) return 'Already in a room.';
                MP.busy = true;
                const custom = mpSanCode(rawCode), gen = () => Array.from({ length: 5 + Math.floor(Math.random() * 2) }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');
                let reg = null, code = '';
                try {
                    for (let t = 0; t < (custom ? 1 : 8) && !reg; t++) {
                        code = custom || gen();
                        try { reg = await MP.newPeer(MP_PFX + code); } catch (e) {
                            if (e && e.type === 'unavailable-id') { if (custom) return 'That room code is already in use.'; continue; }
                            return 'Could not reach the matchmaking server (' + ((e && e.type) || 'error') + ').';
                        }
                    }
                    if (!reg) return 'Could not find a free room code. Try again.';
                    let peer; try { peer = await MP.newPeer(); } catch (e) { try { reg.destroy(); } catch (_) {} return 'Could not reach the matchmaking server.'; }
                    MP.peer = peer; MP.reg = reg; MP.code = code; MP.me.id = peer.id; MP.me.ghost = false;
                    MP.isHost = true; MP.hostId = peer.id; MP.players = { [peer.id]: MP.info() }; MP.net = {}; MP.dead = {}; MP.votes = {}; MP.order = [];
                    MP.settings = { allowJoin: !!allowJoin, beta: !!beta, hear: true, diff: diff || 'normal' };
                    MP.phase = 'lobby'; MP.roomSeed = (Math.random() * 2147483647) | 0; MP.runNo = 0; MP.seq = [0]; MP.active = true;
                    MP.bindPeer(); MP.bindReg(reg);
                    return null;
                } finally { MP.busy = false; }
            },
            bindReg(reg) { reg.on('connection', conn => MP.onRegConn(conn)); reg.on('error', e => { if (e && e.type === 'disconnected') try { reg.reconnect(); } catch (_) {} }); },
            bindPeer() {
                MP.peer.on('connection', c => MP.bindConn(c));
                MP.peer.on('call', call => MP.game.call && MP.game.call(call));
                MP.peer.on('disconnected', () => { try { MP.peer.reconnect(); } catch (_) {} });
            },
            onRegConn(conn) {
                const deny = r => { try { conn.send({ t: 'joinDeny', r }); } catch (e) {} setTimeout(() => { try { conn.close(); } catch (e) {} }, 400); };
                const handle = m => {
                    if (!m || m.t !== 'join') return;
                    if (!MP.active || !MP.isHost) return deny('gone');
                    if (MP.phase !== 'lobby') return deny('inmatch');
                    if (!MP.settings.allowJoin) return deny('closed');
                    if (MP.count() >= MP_MAX && !MP.players[m.id]) return deny('full');
                    if (typeof m.id !== 'string' || !m.id) return deny('gone');
                    MP.players[m.id] = { id: m.id, name: String(m.name || 'Wanderer').slice(0, 16), color: +m.color || 0 };
                    try { conn.send({ t: 'joinOk', players: MP.players, host: MP.me.id, settings: MP.settings, phase: MP.phase, runNo: MP.runNo, roomSeed: MP.roomSeed, code: MP.code }); } catch (e) {}
                    setTimeout(() => { try { conn.close(); } catch (e) {} }, 600);
                    MP.pushRoster(); MP.game.chat && MP.game.chat('', MP.players[m.id].name + ' joined the room.', true);
                };
                conn.on('data', handle);
            },
            pushRoster() {
                if (!MP.isHost) return;
                MP.order = Object.keys(MP.players).filter(i => i !== MP.me.id).sort(() => Math.random() - 0.5); // random successor order
                MP.bcast({ t: 'roster', players: MP.players, host: MP.me.id, order: MP.order, settings: MP.settings, phase: MP.phase, runNo: MP.runNo });
                MP.game.roster && MP.game.roster();
            },
            // ---------- joining ----------
            async join(rawCode) {
                if (typeof Peer === 'undefined') return { err: 'Multiplayer could not load PeerJS (are you offline?).' };
                if (MP.active || MP.busy) return { err: 'Already in a room.' };
                const code = mpSanCode(rawCode); if (!code) return { err: 'Enter a room code.' };
                MP.busy = true; let peer = null;
                try {
                    try { peer = await MP.newPeer(); } catch (e) { return { err: 'Could not reach the matchmaking server.' }; }
                    const conn = peer.connect(MP_PFX + code, { reliable: true, serialization: 'json' });
                    const r = await new Promise(res => {
                        let done = false; const fin = v => { if (!done) { done = true; res(v); } };
                        conn.on('open', () => { try { conn.send(Object.assign({ t: 'join' }, { id: peer.id, name: MP.me.name, color: MP.me.color })); } catch (e) { fin({ t: 'none' }); } });
                        conn.on('data', m => { if (m && (m.t === 'joinOk' || m.t === 'joinDeny')) fin(m); });
                        conn.on('close', () => fin({ t: 'none' })); conn.on('error', () => fin({ t: 'none' }));
                        peer.on('error', e => { if (e && e.type === 'peer-unavailable') fin({ t: 'none' }); });
                        setTimeout(() => fin({ t: 'none' }), 9000);
                    });
                    if (r.t === 'joinDeny') { try { peer.destroy(); } catch (_) {} return { err: ({ full: 'That room is full.', inmatch: 'That room is in the middle of a match.', closed: 'That room is not accepting players right now.', gone: 'That room is unavailable.' })[r.r] || 'That room is unavailable.' }; }
                    if (r.t !== 'joinOk') { try { peer.destroy(); } catch (_) {} return { err: 'No room with that code exists.' }; }
                    MP.peer = peer; MP.reg = null; MP.code = code; MP.me.id = peer.id; MP.me.ghost = false; MP.isHost = false; MP.hostId = r.host;
                    MP.players = r.players; MP.net = {}; MP.dead = {}; MP.votes = {}; MP.settings = r.settings; MP.phase = r.phase; MP.runNo = r.runNo; MP.roomSeed = r.roomSeed; MP.seq = [0]; MP.active = true;
                    MP.bindPeer();
                    Object.keys(MP.players).forEach(id => { if (id !== MP.me.id) MP.link(id); });
                    return { ok: true };
                } finally { MP.busy = false; }
            },
            // ---------- mesh ----------
            link(id) { if (!MP.peer || MP.conns[id] || id === MP.me.id) return; try { MP.bindConn(MP.peer.connect(id, { reliable: true, serialization: 'json' })); } catch (e) {} },
            bindConn(c) {
                const opened = () => { if (MP.conns[c.peer] && MP.conns[c.peer] !== c) { try { c.close(); } catch (e) {} return; } MP.conns[c.peer] = c; MP.seen[c.peer] = MP.now(); try { c.send({ t: 'me', i: MP.info() }); } catch (e) {} MP.game.peerUp && MP.game.peerUp(c.peer); };
                if (c.open) opened(); else c.on('open', opened);
                c.on('data', d => MP.onMsg(c.peer, d));
                c.on('close', () => { if (MP.conns[c.peer] === c || !MP.conns[c.peer]) MP.dropPeer(c.peer); });
                c.on('error', () => { if (MP.conns[c.peer] === c) MP.dropPeer(c.peer); });
            },
            send(m, to) { const c = MP.conns[to]; if (c && c.open) try { c.send(m); } catch (e) {} },
            bcast(m) { for (const id in MP.conns) { const c = MP.conns[id]; if (c && c.open) try { c.send(m); } catch (e) {} } },
            dropPeer(id) {
                if (!MP.active) return;
                const c = MP.conns[id]; delete MP.conns[id]; try { c && c.close(); } catch (e) {}
                MP.game.avatarRemove && MP.game.avatarRemove(id); MP.game.voiceDrop && MP.game.voiceDrop(id); delete MP.net[id]; delete MP.seen[id];
                if (id === MP.hostId) return MP.hostLost();
                const pl = MP.players[id]; if (!pl) return;
                delete MP.players[id]; delete MP.dead[id]; delete MP.votes[id];
                MP.game.chat && MP.game.chat('', pl.name + ' left the room.', true);
                if (MP.isHost) MP.pushRoster(); else MP.game.roster && MP.game.roster();
                MP.afterChange();
            },
            // ---------- host migration ----------
            hostLost() {
                const old = MP.hostId, oldPl = MP.players[old]; delete MP.players[old]; delete MP.dead[old]; delete MP.votes[old]; delete MP.net[old];
                MP.game.chat && MP.game.chat('', (oldPl ? oldPl.name : 'The host') + ' (host) left. Choosing a new host...', true);
                const next = MP.order.find(i => i !== old && MP.players[i]) || (MP.players[MP.me.id] ? Object.keys(MP.players).sort()[0] : null);
                MP.hostId = next;
                if (MP.phase === 'run') MP.endRun('The host left, so the run was ended.', false); // every client ends it locally, identically
                if (next === MP.me.id) MP.becomeHost(); else MP.game.roster && MP.game.roster();
            },
            async becomeHost() {
                MP.isHost = true; MP.hostId = MP.me.id; MP.game.chat && MP.game.chat('', 'You are now the party leader.', true);
                for (let t = 0; t < 20 && MP.active && MP.isHost && !MP.reg; t++) { // the old registration frees up as soon as the old host's socket is gone
                    try { MP.reg = await MP.newPeer(MP_PFX + MP.code); MP.bindReg(MP.reg); } catch (e) { await new Promise(r => setTimeout(r, 1500)); }
                }
                if (!MP.active) return;
                MP.bcast({ t: 'host', id: MP.me.id }); MP.pushRoster();
            },
            // ---------- message handling ----------
            onMsg(from, m) {
                if (!m || typeof m !== 'object') return; MP.seen[from] = MP.now();
                const fromHost = from === MP.hostId;
                switch (m.t) {
                    case 'p': MP.net[from] = m; break;
                    case 'me': if (m.i && MP.players[from]) { MP.players[from].name = String(m.i.name || '').slice(0, 16) || MP.players[from].name; MP.players[from].color = +m.i.color || 0; MP.game.roster && MP.game.roster(); } break;
                    case 'roster':
                        if (!fromHost || MP.isHost) break;
                        MP.players = m.players; MP.order = m.order || []; MP.settings = m.settings; MP.runNo = m.runNo; MP.hostId = m.host;
                        if (MP.phase !== m.phase && m.phase === 'lobby' && MP.phase === 'run') MP.endRun('The run ended.', false);
                        for (const id in MP.players) if (id !== MP.me.id && !MP.conns[id] && MP.me.id < id) MP.link(id); // heal broken mesh links
                        for (const id in MP.conns) if (!MP.players[id]) { try { MP.conns[id].close(); } catch (e) {} delete MP.conns[id]; MP.game.avatarRemove && MP.game.avatarRemove(id); }
                        MP.game.roster && MP.game.roster(); break;
                    case 'host': if (MP.players[m.id] && from === m.id && m.id === MP.hostId) { MP.hostId = m.id; MP.game.roster && MP.game.roster(); } break;
                    case 'settings': if (fromHost && m.s) { MP.settings = m.s; MP.game.roster && MP.game.roster(); } break;
                    case 'chat': MP.game.chat && MP.game.chat((MP.players[from] || {}).name || '?', String(m.m || '').slice(0, 160), false); break;
                    case 'next': MP.onNext(from, m); break;
                    case 'exit': MP.onExit(from, m); break;
                    case 'clear': if (fromHost && !MP.isHost) MP.game.advance && MP.game.advance(m.lvl); break;
                    case 'exiting': if (fromHost && !MP.isHost) { MP.exited = {}; (m.ids || []).forEach(i => MP.exited[i] = 1); } break;
                    case 'arrow': if (fromHost && !MP.isHost) MP.game.arrow && MP.game.arrow(m.lvl); break;
                    case 'kick': if (fromHost && !MP.isHost) MP.game.kicked && MP.game.kicked(); break;
                    case 'died': MP.onDied(from, m); break;
                    case 'take': if (!MP.dead[from]) MP.game.take && MP.game.take(m.u); break; // ghosts cannot pick anything up
                    case 'ents': if (fromHost && !MP.isHost) MP.game.ents && MP.game.ents(m.a); break;
                    case 'stun': // host validates client stun requests, commits them and fans them out; clients only accept the host's word
                        if (MP.isHost && from !== MP.hostId) { if (MP.dead[from] || !MP.players[from] || !MP.game.stunOk(from, m.i)) break; const s = Math.min(30, Math.max(2, +m.s || 2)); MP.game.stunNet(m.i, s); MP.bcast({ t: 'stun', i: m.i, s }); }
                        else if (fromHost) MP.game.stunNet && MP.game.stunNet(m.i, m.s);
                        break;
                    case 'vote': if (MP.players[from]) { if (m.v) MP.votes[from] = 1; else delete MP.votes[from]; MP.afterChange(); } break;
                    case 'end': if (fromHost) MP.endRun(String(m.reason || 'The run ended.'), false); break;
                    case 'abil': if (MP.players[from] && MP.game.abil) MP.game.abil(m.i, +m.d || 0); break;
                    case 'bye': MP.dropPeer(from); break;
                }
            },
            // ---------- run flow ----------
            leader: () => MP.players[MP.hostId],
            canNext() { return MP.isHost || MP.now() - MP.shopT0 >= 60000; },
            buildSeq() {
                const seq = [0], G = MP.game; let n; while ((n = G.nextMain(seq[seq.length - 1])) >= 0 && seq.length < 40) seq.push(n);
                if (MP.settings.beta) G.betaOrder().forEach(i => { if (i >= 0 && !seq.includes(i)) seq.push(i); });
                return seq;
            },
            sendNext() { // called when the local player presses the green button in a waiting room
                const m = { t: 'next' };
                if (MP.phase === 'lobby') { m.seq = MP.buildSeq(); m.n = MP.count(); MP.phase = 'run'; MP.seq = m.seq; MP.runN = m.n; MP.votes = {}; if (MP.isHost) MP.pushRoster(); }
                MP.bcast(m);
            },
            onNext(from, m) {
                if (MP.dead[from]) return;
                const ok = from === MP.hostId || MP.now() - MP.shopT0 >= 58000; if (!ok) return;
                if (MP.phase === 'lobby' && m.seq) { MP.phase = 'run'; MP.seq = m.seq; MP.runN = m.n || MP.count(); MP.votes = {}; }
                MP.game.pressNext && MP.game.pressNext();
            },
            endRun(reason, announce) {
                if (MP.phase !== 'run') return;
                MP.phase = 'lobby'; MP.runNo++; MP.votes = {}; MP.dead = {}; MP.me.ghost = false;
                if (announce !== false && MP.isHost) { MP.bcast({ t: 'end', reason }); MP.pushRoster(); }
                MP.game.chat && MP.game.chat('', reason, true);
                MP.game.toLobby && MP.game.toLobby(reason);
            },
            onDied(from, m) { if (!MP.players[from]) return; MP.dead[from] = 1; MP.game.corpse && MP.game.corpse(from, m); MP.afterChange(); },
            // ---- shared exit: the room only counts as cleared once every living player has reached the exit (host commits it, exactly once) ----
            exited: {}, cleared: false,
            onExit(from, m) {
                if (!MP.isHost || MP.phase !== 'run' || MP.cleared || !MP.players[from] || MP.dead[from] || m.lvl !== MP.game.level() || !MP.game.nearExit(from)) return;
                MP.exited[from] = 1; MP.bcast({ t: 'exiting', ids: Object.keys(MP.exited) }); MP.checkExit();
            },
            checkExit() {
                if (!MP.isHost || MP.phase !== 'run' || MP.cleared) return; const alive = Object.keys(MP.players).filter(i => !MP.dead[i]);
                if (alive.length && alive.every(i => MP.exited[i])) { MP.cleared = true; const l = MP.game.level(); MP.bcast({ t: 'clear', lvl: l }); MP.game.advance(l); }
            },
            sendStun(i, s) { if (i < 0) return; if (MP.isHost) MP.bcast({ t: 'stun', i, s }); else MP.send({ t: 'stun', i, s }, MP.hostId); },
            kick(id) { if (!MP.isHost || id === MP.me.id || !MP.players[id]) return false; MP.send({ t: 'kick' }, id); setTimeout(() => MP.dropPeer(id), 200); return true; },
            afterChange() { // everything that depends on who is still around: end-run votes, wipe-outs
                if (!MP.isHost || MP.phase !== 'run') return;
                MP.checkExit();
                const ids = Object.keys(MP.players), n = ids.length, v = ids.filter(i => MP.votes[i]).length;
                if (n && v * 2 >= n && v > 0) return MP.endRun('At least half the party voted to end the run.');
                if (n && ids.every(i => MP.dead[i] || (i === MP.me.id && MP.me.ghost))) return MP.endRun('Everyone died. Back to the waiting room.');
            },
            // ---------- room settings (leader only) ----------
            setSetting(k, v) { if (!MP.isHost || MP.phase !== 'lobby' && k !== 'allowJoin' && k !== 'hear') return false; MP.settings[k] = v; MP.bcast({ t: 'settings', s: MP.settings }); MP.game.roster && MP.game.roster(); return true; },
            // ---------- leaving ----------
            leave() {
                if (!MP.active) return; MP.bcast({ t: 'bye' });
                const peer = MP.peer, reg = MP.reg; MP.active = false; MP.isHost = false; MP.phase = 'lobby';
                for (const id in MP.conns) { try { MP.conns[id].close(); } catch (e) {} }
                setTimeout(() => { try { reg && reg.destroy(); } catch (e) {} try { peer && peer.destroy(); } catch (e) {} }, 350);
                MP.conns = {}; MP.peer = null; MP.reg = null; MP.players = {}; MP.net = {}; MP.dead = {}; MP.votes = {}; MP.me.ghost = false; MP.hostId = null; MP.order = [];
                MP.game.left && MP.game.left();
            },
            // ---------- balance ----------
            // Stun duration shrinks with how many stunning items (equipped or in any inventory) the whole lobby carries. Players are ranked by their
            // item count and each further player counts for 0.55x the one before, so a 6th player adds far less than a 2nd. Min 2s.
            stunSecs(base) {
                const counts = Object.keys(MP.players).map(i => i === MP.me.id ? MP.game.myStunItems() : ((MP.net[i] || {}).sc || 0)).sort((a, b) => b - a);
                let eff = 0, w = 1; counts.forEach(c => { eff += c * w; w *= 0.55; });
                return Math.max(2, base / (1 + 0.5 * Math.max(0, eff - 1)));
            },
            immMult() { return 1 + 0.1 * MP.count(); }, // +10% stun-immunity per player in the lobby
            lootMult() { return 1 + 0.3 * (Math.max(1, MP.runN) - 1); },
            seedFor(lvl) { return (Math.imul(MP.roomSeed | 0, 2654435761) ^ Math.imul(MP.runNo + 1, 40503) ^ Math.imul(lvl + 3, 9973)) >>> 0; }
        };
        //#MPCORE-END

        // ---------- game side of multiplayer: seeded level building, avatars, pose sync, ghosts, voice, chat, menus ----------
        const mpZ = new THREE.Vector3(0, 0, 1), mpQ = new THREE.Quaternion(), mpQ2 = new THREE.Quaternion(), mpV = new THREE.Vector3(), mpQPi = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
        const mpR = (v, k = 100) => Math.round(v * k) / k;
        Object.assign(MP, { avs: {}, corpses: [], chatLog: [], hearCd: {}, sendT: 0, entT: 0, swing: 0, lastP: null, mv: 0, stream: null, micOn: true, calls: {}, vols: {}, uidN: 0, lmb: false, tvs: {} });
        Object.assign(MP.game, {
            nextMain: i => { const n = nextMainLevel(i); return n >= 0 && LevelData[n].main ? -1 : n; }, // multiplayer keeps its old route (Levels 7 and 8 are single-player)
            betaOrder: () => [LevelData.findIndex(l => l.thalasso), LevelData.findIndex(l => l.party), LevelData.findIndex(l => l.pools && !l.thalasso)], // Thalassophobia, Partyrooms, Poolrooms
            myStunItems: () => GameState.inv.reduce((n, s) => n + (s && MP_STUN_ITEMS.includes(s.id) ? (s.count || 1) : 0), 0),
            chat: (name, text, sys) => MP.chatAdd(name, text, sys),
            roster: () => MP.uiRefresh(),
            peerUp: id => { MP.voiceCall(id); MP.uiRefresh(); },
            avatarRemove: id => MP.rmAvatar(id),
            voiceDrop: id => MP.voiceStop(id),
            call: call => MP.voiceAnswer(call),
            pressNext: () => { if (GameState.inShop && !GameState.shopSliding) { shopPressButton(); MP.uiRefresh(); } },
            toLobby: () => { document.body.style.filter = 'none'; MP.corpses = []; setTimeout(() => MP.enterLobby(), 50); },
            left: () => { clearInterval(MP.hb); MP.rmAllAvatars(); MP.voiceStopAll(); MP.uiRefresh(); GameState.mpMenu = false; GameState.chatOpen = false; document.body.style.filter = 'none'; ['mp-hud', 'mp-feed', 'mp-chatbar'].forEach(i => mpEl(i).style.display = 'none'); },
            advance: lvl => MP.advance(lvl),
            level: () => GameState.level,
            abil: (i, d) => { const e = GameState.entities[i]; if (e && e.type === 'bacteria') e._abilT = Math.min(5, d); },
            nearExit: id => { const n = id === MP.me.id ? controls.getObject().position : MP.net[id]; return !!n && Math.hypot(n.x - GameState.exitPos.x, n.z - GameState.exitPos.z) < 7; },
            stunOk: (from, i) => { const e = GameState.entities[i], n = MP.net[from]; return !!e && !!n && n.sc > 0 && n.lvl === GameState.level && Math.hypot(n.x - e.mesh.position.x, n.z - e.mesh.position.z) < 45; },
            arrow: lvl => { if (lvl === GameState.level) MP.arrowOn = true; },
            kicked: () => { MP.leave(); try { exitToMenu(); } catch (e) {} try { showMenuNotice('You were removed from the room by the host.'); } catch (e) {} },
            corpse: (id, m) => MP.mkCorpse(id, m),
            take: u => { for (let i = GameState.items.length - 1; i >= 0; i--) { const it = GameState.items[i]; if (it.mesh.userData.mpUid === u) { scene.remove(it.mesh); GameState.items.splice(i, 1); } } },
            ents: a => MP.applyEnts(a),
            stunNet: (i, s) => { const e = GameState.entities[i]; if (e && !(e.stunTimer > 0)) { e._ns = true; e._net = true; e.stunImmuneTimer = 0; e.stun(s); } }
        });
        // ---- levels: every client builds the exact same maze/loot/monsters from the shared seed ----
        MP.prepLoot = on => { // more players -> more loot (counts only; the layout is untouched)
            if (on) { const m = MP.lootMult(); MP._ls = { ...LootCfg }; LootCfg.chestChance = Math.min(1, LootCfg.chestChance * m); LootCfg.chestExtra = Math.min(0.6, LootCfg.chestExtra * m); LootCfg.crateMin = Math.round(LootCfg.crateMin * m); LootCfg.crateRand = Math.round(LootCfg.crateRand * m); LootCfg.floorCrowbar *= m; LootCfg.floorLocator *= m; }
            else if (MP._ls) { Object.assign(LootCfg, MP._ls); MP._ls = null; }
        };
        MP.afterSpawn = () => { GameState.subDoor = null; MP.entN = GameState.entities.length; MP.lastP = null; MP.exited = {}; MP.cleared = false; MP.arrowOn = false; MP.lvlT = 0; MP.entLast = []; MP.entKey = 0; MP.lastPk = ''; };
        MP.afterShopBuilt = () => {
            MP.shopT0 = performance.now(); GameState.subDoor = null;
            const cs = GameState.cellSize, z0 = 0.5 * cs + 0.02, bx = 2.6 * cs;
            const sign = labelSprite('ROOM BOARD', 2.6); sign.position.set(bx, 2.5, z0 + 0.15); scene.add(sign);
            const bd = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.3, 0.08), new THREE.MeshStandardMaterial({ color: 0x2a2a1c, emissive: 0x0e2a14, emissiveIntensity: 0.8, roughness: 0.6 })); bd.position.set(bx, 1.6, z0 + 0.06); scene.add(bd);
            MP.board = { x: bx, z: z0 + 1.2 };
            const base = GameState.shopTick;
            GameState.shopTick = t => {
                if (base) base(t); const pr = mpEl('shop-prompt'); if (!pr || GameState.shopOpen || GameState.shopSliding) return;
                const p = controls.getObject().position, sp = GameState.shopPos, dB = Math.hypot(p.x - sp.bx, p.z - sp.bz);
                if (dB < 3.4) { const w = Math.ceil(60 - (performance.now() - MP.shopT0) / 1000); pr.textContent = MP.canNext() ? '[E] PRESS THE BUTTON' : `WAITING FOR PARTY LEADER${MP.leader() ? ' (' + MP.leader().name + ')' : ''} - ANYONE CAN PRESS IN ${w}s`; }
                else if (!pr.textContent && Math.hypot(p.x - MP.board.x, p.z - MP.board.z) < 3.2) pr.textContent = '[E] ROOM BOARD / SETTINGS';
                pr.style.display = pr.textContent ? 'block' : 'none';
            };
            MP.uiRefresh();
        };
        MP.shopAct = p => { // return true when the E press was consumed
            const sp = GameState.shopPos;
            if (Math.hypot(p.x - sp.bx, p.z - sp.bz) < 3.4) { if (MP.me.ghost) { showEventBanner('GHOSTS CANNOT TOUCH THE WORLD', 2); return true; } if (!MP.canNext()) { showEventBanner('ONLY THE PARTY LEADER CAN PRESS THIS YET (60s)', 2); return true; } MP.sendNext(); return false; }
            if (MP.board && Math.hypot(p.x - MP.board.x, p.z - MP.board.z) < 3.2) { MP.openRoom(); return true; }
            return !!MP.me.ghost; // ghosts cannot browse the shop either
        };
        MP.enterLobby = () => {
            ['mp-menu', 'mp-join', 'mp-create'].forEach(i => mpEl(i).style.display = 'none');
            GameState.difficulty = MP.settings.diff || 'normal'; try { updateSettingsSummary(); } catch (e) {}
            GameState.mpMenu = false; mpEl('pause-menu').style.display = 'none'; mpEl('mp-room').style.display = 'none'; mpEl('mp-chat-panel').style.display = 'none';
            clearInterval(MP.hb); MP.hb = setInterval(() => { if (MP.active) MP.bcast({ t: 'hb' }); }, 2000);
            GameState.shopOpen = false; startGame(0).then(() => { ['mp-hud', 'mp-feed'].forEach(i => mpEl(i).style.display = 'block'); MP.uiRefresh(); MP.voiceStart(); });
        };
        MP.exitReached = () => { // only marks YOU as at the exit; the host clears the room once every living player has
            if (MP.me.ghost || GameState.inShop || MP.exited[MP.me.id]) return; AudioSys.playClick(); const l = GameState.level; MP.exited[MP.me.id] = 1;
            showEventBanner('YOU REACHED THE EXIT - WAITING FOR THE REST OF THE PARTY...', 3);
            if (MP.isHost) MP.onExit(MP.me.id, { lvl: l }); else MP.send({ t: 'exit', lvl: l }, MP.hostId);
        };
        MP.advance = lvl => {
            if (!MP.active || GameState.level !== lvl || GameState.inShop || MP.phase !== 'run') return;
            MP.exited = {}; MP.cleared = false; MP.arrowOn = false; MP.lvlT = 0; GameState.exitArrowShowTimer = 0; mpEl('exit-arrow-container').style.display = 'none';
            try { unlockAch('lvl_' + LevelData[lvl].name); AudioSys.playLevelClear(); awardLevelCoins(); } catch (e) {}
            const i = MP.seq.indexOf(lvl), nx = MP.seq[i + 1];
            if (nx === undefined) { if (MP.isHost) MP.endRun('RUN COMPLETE! Everyone returns to the waiting room.'); else MP.pendingEnd = MP.now() + 6000; } // clients also self-end if the host's message never arrives
            else { MP.votes = {}; MP.reviveAll(); buildLevel(nx, true); }
        };
        // ---- deaths: you become a ghost, a corpse stays, your items drop ----
        MP.onDeath = () => {
            if (GameState.debugRoom) return false;
            if (MP.me.ghost) return true;
            MP.me.ghost = true; MP.dead[MP.me.id] = 1;
            const p = controls.getObject().position, items = [];
            GameState.inv.forEach(s => { if (s) for (let k = 0; k < (s.count || 1); k++) items.push({ id: s.id, ammo: s.ammo || 0 }); });
            const m = { t: 'died', x: mpR(p.x), z: mpR(p.z), fy: mpR(p.y - 2), u: Date.now() % 1e6 * 10 + 1, items };
            MP.bcast(m); try { MP.mkCorpse(MP.me.id, m); } catch (e) { console.warn('corpse', e); }
            GameState.inv = [null, null, null, null, null]; GameState.invSel = 0; syncInventory();
            GameState.isJumpscaring = false; GameState.jumpscareEntity = null; GameState.isBeingChased = false; GameState.hidden = false;
            mpEl('jumpscare-flash').style.display = 'none'; camera.fov = GameState.baseFov || 75; camera.rotation.z = 0; camera.updateProjectionMatrix(); flashLight.intensity = 4.2 * PermaFx.light(); flashLight.visible = true;
            for (const k of ['chase-pulse', 'static-overlay', 'chase-border']) { const el = mpEl(k); if (el) el.style.opacity = '0'; }
            try { ChaseAudio.set(0); } catch (e) {}
            document.body.style.filter = 'grayscale(.75) brightness(1.15) contrast(.95)';
            showEventBanner('YOU DIED. YOU ARE NOW A GHOST - ONLY OTHER GHOSTS CAN SEE YOU.', 5);
            MP.chatAdd('', 'You died and became a ghost.', true); MP.afterChange(); MP.uiRefresh();
            return true;
        };
        MP.reviveAll = () => { // everybody who died comes back for the next level with 1 almond water + 1 battery
            const was = MP.me.ghost; MP.dead = {}; if (!was) return;
            MP.me.ghost = false; document.body.style.filter = 'none';
            GameState.inv = [null, null, null, null, null]; GameState.invSel = 0; invAdd(GameState.inv, 'water'); invAdd(GameState.inv, 'battery'); syncInventory();
            const P = GameState.player; P.sanity = PermaFx.maxSan(); P.stamina = 100; P.battery = 100; P._winded = false; P._exh = 0; P._immob = 0; GameState._shopSan = P.sanity; GameState._shopBat = 100;
            showEventBanner('YOU WERE REVIVED WITH 1 ALMOND WATER AND 1 BATTERY', 4); MP.chatAdd('', 'You were revived for the next level.', true);
        };
        MP.mkCorpse = (id, m) => {
            const pl = MP.players[id] || MP.me, a = MP.figure(pl);
            a.kp.rotation.set(-Math.PI / 2, 0, 0); a.kp.position.y = 0.3; a.kp.scale.setScalar(1.1);
            const g = new THREE.Group(); g.add(a.kp); g.position.set(m.x, m.fy != null ? m.fy : 0, m.z); g.rotation.y = (m.u % 628) / 100; scene.add(g); MP.corpses.push(g);
            const tag = MP.tag(pl.name + ' (dead)'); tag.position.set(m.x, (m.fy || 0) + 1, m.z); scene.add(tag); MP.corpses.push(tag);
            (m.items || []).forEach((it, k) => { // dropped inventory, scattered around the corpse (the first person to grab an item takes it for everyone)
                const ang = k * 2.4 + 0.7, r = 0.9 + (k % 3) * 0.35, x = m.x + Math.cos(ang) * r, z = m.z + Math.sin(ang) * r;
                spawnPickup(it.id, x, z); const itm = GameState.items[GameState.items.length - 1]; itm.mesh.userData.mpUid = m.u + ':' + k; itm.mesh.userData.ammo = it.ammo;
            });
            if (id !== MP.me.id) MP.chatAdd('', pl.name + ' died.', true);
        };
        MP.taken = it => { const u = it && it.mesh && it.mesh.userData.mpUid; if (u) MP.bcast({ t: 'take', u }); };
        // ---- entity authority ----
        MP.tv = id => { const n = MP.net[id], v = MP.tvs[id] || (MP.tvs[id] = new THREE.Vector3()); const a = MP.avs[id]; if (a && a.cur) v.set(a.cur.x, a.cur.y, a.cur.z); else if (n) v.set(n.x, n.y, n.z); return v; };
        MP.tgt = (e, p) => { // monsters hunt whichever living player is nearest; a catch only counts for the local player (GameState._rt marks remote targets)
            const ex = e.mesh.position.x, ez = e.mesh.position.z; let best = null, bd = 1e9, remote = false;
            if (!MP.me.ghost) { best = p; bd = Math.hypot(p.x - ex, p.z - ez); }
            for (const id in MP.players) { if (id === MP.me.id || MP.dead[id]) continue; const n = MP.net[id]; if (!n || n.lvl !== GameState.level || n.sh) continue; const d = Math.hypot(n.x - ex, n.z - ez); if (d < bd) { bd = d; best = MP.tv(id); remote = true; } }
            if (!best) { best = p; remote = true; }
            GameState._rt = remote; return best;
        };
        MP.applyEnts = a => {
            if (!a) return; a.forEach(r0 => {
                const i = r0[0], r = r0.slice(1), e = GameState.entities[i]; if (!e || !e.mesh) return; const m = e.mesh, dx = r[0] - m.position.x, dz = r[2] - m.position.z;
                if (dx * dx + dz * dz > 25) m.position.set(r[0], r[1], r[2]); else { m.position.x += dx * 0.45; m.position.z += dz * 0.45; m.position.y = r[1]; }
                m.rotation.y = r[3];
                if (r[5] > 0 && !(e.stunTimer > 0)) { e._ns = true; e._net = true; e.stunImmuneTimer = 0; e.stun(r[5]); } else if (r[5] <= 0 && e.stunTimer > 0.5) e.stunTimer = 0.05;
                // (state is deliberately NOT copied: a monster chasing someone else must not put you in chase)
            });
        };
        // ---- avatars: the shopkeeper figure, recoloured, with a nametag ----
        MP.col = (h, s, l) => new THREE.Color().setHSL(((h % 1) + 1) % 1, s, l).getHex();
        MP.figure = pl => buildShopkeeperFigure(o => new THREE.MeshStandardMaterial(o), { coat: MP.col(pl.color, .5, .24), skin: MP.col(pl.color + .08, .38, .7), hat: MP.col(pl.color + .5, .45, .12) });
        MP.tag = txt => {
            const c = document.createElement('canvas'); c.width = 512; c.height = 96; const x = c.getContext('2d'); x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(0, 0, 512, 96); x.fillStyle = '#fff'; x.font = 'bold 46px Courier New'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt.slice(0, 22), 256, 50);
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true })); s.scale.set(1.8, 0.34, 1); s.renderOrder = 999; return s;
        };
        MP.mkAvatar = id => {
            const pl = MP.players[id]; if (!pl) return null; const f = MP.figure(pl), root = new THREE.Group(); root.add(f.kp);
            const hm = new THREE.MeshStandardMaterial({ color: MP.col(pl.color + .08, .38, .7), roughness: .7 }), hands = [0, 1].map(() => { const h = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), hm); h.visible = false; root.add(h); return h; });
            const arms = [0, 1].map(() => { const g = new THREE.CylinderGeometry(0.05, 0.045, 1, 7); g.translate(0, 0.5, 0); g.rotateX(Math.PI / 2); const c = new THREE.Mesh(g, f.coat); c.visible = false; root.add(c); return c; });
            const tag = MP.tag(pl.name); root.add(tag);
            const a = { id, root, kp: f.kp, head: f.head, fArms: f.arms, hands, arms, tag, name: pl.name, cur: null, held: [null, null], heldId: [null, null], ghostFx: false, ph: 0, swT: 0, swSeen: -1 };
            f.kp.traverse(o => { if (o.material) o.material.userData.base = o.material.color.getHex(); }); scene.add(root); MP.avs[id] = a; return a;
        };
        MP.rmAvatar = id => { const a = MP.avs[id]; if (!a) return; a.root.removeFromParent(); delete MP.avs[id]; };
        MP.rmAllAvatars = () => { for (const id in MP.avs) MP.rmAvatar(id); MP.corpses = []; };
        MP.setGhostFx = (a, on) => { if (a.ghostFx === on) return; a.ghostFx = on; a.kp.traverse(o => { if (o.material) { o.material.transparent = on; o.material.opacity = on ? 0.38 : 1; o.material.emissive && o.material.emissive.setHex(on ? 0x2a4a88 : 0); o.material.depthWrite = !on; o.material.needsUpdate = true; } }); };
        MP.holdItem = (a, i, id, parent) => { if (a.heldId[i] === id) return; if (a.held[i]) a.held[i].removeFromParent(); a.held[i] = null; a.heldId[i] = id; if (!id) return; try { const m = buildItemModel(id); m.scale.setScalar(0.55); m.userData = {}; parent.add(m); a.held[i] = m; } catch (e) {} };
        MP.updAvatar = (a, n, dt) => {
            const pl = MP.players[a.id]; if (!pl) return; const k = 1 - Math.exp(-14 * dt);
            if (!a.cur) a.cur = { x: n.x, y: n.y, z: n.z, yaw: n.yaw, pitch: n.pitch || 0, hy: n.hy || n.y, fy: n.fy != null ? n.fy : n.y - 2 };
            const c = a.cur; c.x += (n.x - c.x) * k; c.y += (n.y - c.y) * k; c.z += (n.z - c.z) * k; let dy = n.yaw - c.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); c.yaw += dy * k; c.pitch += ((n.pitch || 0) - c.pitch) * k;
            c.hy += ((n.hy || n.y) - c.hy) * k; c.fy += ((n.fy != null ? n.fy : n.y - 2) - c.fy) * k;
            const vr = !!n.vr, ghost = !!MP.dead[a.id], seeGhosts = MP.me.ghost;
            a.root.visible = n.lvl === GameState.level && !(ghost && !seeGhosts); MP.setGhostFx(a, ghost);
            if (!a.root.visible) return;
            a.root.position.set(c.x, c.fy, c.z); a.kp.rotation.y = c.yaw + Math.PI;
            if (a.name !== pl.name) { a.name = pl.name; const t = MP.tag(pl.name); t.position.copy(a.tag.position); a.root.remove(a.tag); a.tag = t; a.root.add(t); }
            const sc = vr ? Math.max(0.45, Math.min(1.5, (c.hy - c.fy) / 1.5)) : 1.2; a.kp.scale.set(vr ? 1.1 : 1.2, sc, vr ? 1.1 : 1.2); a.tag.position.set(0, sc * 1.9 + 0.45, 0);
            if (vr && n.hq) { mpQ.set(n.hq[0], n.hq[1], n.hq[2], n.hq[3]); a.kp.updateMatrixWorld(true); mpQ2.setFromEuler(a.kp.rotation).invert(); a.head.quaternion.copy(mpQ2).multiply(mpQ).multiply(mpQPi); }
            else { a.head.quaternion.identity(); a.head.rotation.x = -c.pitch; }
            const sh = [[-0.2, 1.3 * sc], [0.2, 1.3 * sc]], cy = Math.cos(c.yaw + Math.PI), sy = Math.sin(c.yaw + Math.PI);
            if (vr) { // real hand positions: spheres + forearms from the shoulders
                a.fArms.forEach(x => x.visible = false);
                [n.lh, n.rh].forEach((h, i) => {
                    const hd = a.hands[i], ar = a.arms[i]; if (!h) { hd.visible = ar.visible = false; return; }
                    hd.visible = ar.visible = true; hd.position.set(h[0] - c.x, h[1] - c.fy, h[2] - c.z);
                    const shx = sh[i][0] * cy, shz = -sh[i][0] * sy; ar.position.set(shx, sh[i][1], shz); mpV.copy(hd.position).sub(ar.position); const len = Math.max(0.1, mpV.length()); ar.quaternion.setFromUnitVectors(mpZ, mpV.normalize()); ar.scale.set(1, 1, len);
                    MP.holdItem(a, i, i ? n.rid : n.lid, hd); if (a.held[i]) { a.held[i].position.set(0, 0, -0.05); }
                });
            } else { // PC: fixed hand poses that swing while walking, held item in the right hand, melee swing
                a.hands.forEach(h => h.visible = false); a.arms.forEach(x => x.visible = false); a.fArms.forEach(x => x.visible = true);
                a.ph += dt * 9 * Math.min(1, (n.mv || 0) / 3); const sw = Math.sin(a.ph) * 0.35 * Math.min(1, (n.mv || 0) / 3);
                if (n.sw !== a.swSeen) { if (a.swSeen >= 0) a.swT = 0.38; a.swSeen = n.sw; } if (a.swT > 0) a.swT -= dt;
                const sk = a.swT > 0 ? Math.sin(Math.PI * (1 - a.swT / 0.38)) : 0;
                a.fArms[0].rotation.x = -0.6 + sw; a.fArms[1].rotation.x = -0.6 - sw - sk * 1.7;
                MP.holdItem(a, 1, n.hid, a.fArms[1]); if (a.held[1]) a.held[1].position.set(0, -0.38, 0.1);
            }
        };
        // ---- per-frame: send our pose, apply theirs, host entity snapshots, voice-as-noise, housekeeping ----
        MP.pose = (p, dt) => {
            const vr = !!window.__vrOn, m = { t: 'p', x: mpR(p.x), y: mpR(p.y), z: mpR(p.z), yaw: mpR(vr ? VR.yaw : LOOK.yaw, 1000), pitch: mpR(LOOK.pitch, 1000), lvl: GameState.level, sh: GameState.inShop ? 1 : 0, mv: mpR(MP.mv, 10), sw: MP.swing, v: mpR(MP.myVol(), 10), sc: MP.game.myStunItems(), vr: vr ? 1 : 0 };
            const sel = GameState.inv[GameState.invSel]; m.hid = sel ? sel.id : null;
            if (vr) {
                const hp = VR.cam.getWorldPosition(new THREE.Vector3()), hq = VR.cam.getWorldQuaternion(new THREE.Quaternion()), e = new THREE.Euler().setFromQuaternion(hq, 'YXZ');
                m.x = mpR(hp.x); m.z = mpR(hp.z); m.hy = mpR(hp.y); m.fy = mpR(VR.rig.position.y); m.yaw = mpR(e.y, 1000); m.pitch = mpR(e.x, 1000); m.hq = [mpR(hq.x, 1000), mpR(hq.y, 1000), mpR(hq.z, 1000), mpR(hq.w, 1000)];
                ['left', 'right'].forEach((h, i) => {
                    const ci = VR.ctl.findIndex(c => c.userData.src && c.userData.src.handedness === h); if (ci < 0) return; const o = (VR.grip && VR.grip[ci]) || VR.ctl[ci], q = new THREE.Vector3(); o.getWorldPosition(q); m[i ? 'rh' : 'lh'] = [mpR(q.x), mpR(q.y), mpR(q.z)];
                    const H = VR.held[h], it = H && GameState.inv[H.slot]; m[i ? 'rid' : 'lid'] = it ? it.id : null;
                });
            } else { m.fy = mpR(p.y - 2); m.hy = m.y; }
            const k = JSON.stringify(m), now = performance.now(); if (k === MP.lastPk && now - (MP.lastPkT || 0) < 500) return; MP.lastPk = k; MP.lastPkT = now;
            MP.bcast(m);
        };
        MP.arrowTick = (dt, p) => {
            const d = GameState.difficulty, host = MP.isHost && MP.phase === 'run' && !GameState.inShop && !MP.arrowOn && (d === 'normal' || d === 'hard');
            if (host && (MP.lvlT = (MP.lvlT || 0) + dt) >= 210) { MP.arrowOn = true; MP.bcast({ t: 'arrow', lvl: GameState.level }); }
            const on = !GameState.inShop && GameState.isRunning && !MP.exited[MP.me.id] && (d === 'easy' || ((d === 'normal' || d === 'hard') && MP.arrowOn)), w = mpEl('exit-arrow-container');
            GameState.exitArrowShowTimer = on ? 1 : 0; if (!on) { if (w.style.display !== 'none') w.style.display = 'none'; return; }
            w.style.display = 'flex'; mpEl('exit-arrow-label').innerText = 'EXIT SIGNAL';
            const f = camera.getWorldDirection(mpV); f.y = 0; f.normalize(); const t = new THREE.Vector3().subVectors(GameState.exitPos, p).setY(0).normalize();
            mpEl('exit-arrow-svg').style.transform = `rotate(${(Math.atan2(-f.x, -f.z) - Math.atan2(-t.x, -t.z)) * 180 / Math.PI}deg)`;
        };
        MP.tick = (dt, p) => {
            if (!MP.active) return; const now = performance.now(); MP.arrowTick(dt, p);
            if (MP.lastP) MP.mv += (Math.hypot(p.x - MP.lastP.x, p.z - MP.lastP.z) / Math.max(dt, 0.001) - MP.mv) * Math.min(1, dt * 6); MP.lastP = { x: p.x, z: p.z };
            MP.sendT -= dt; if (MP.sendT <= 0) { MP.sendT = 0.083; MP.pose(p, dt); }
            if (MP.isHost && !GameState.inShop) {
                MP.entT -= dt; MP.entKey = (MP.entKey || 0) - dt;
                if (MP.entT <= 0) {
                    MP.entT = 0.125; const full = MP.entKey <= 0; if (full) MP.entKey = 2; const L = MP.entLast || (MP.entLast = []), rows = [];
                    GameState.entities.slice(0, MP.entN || 99).forEach((e, i) => {
                        const m = e.mesh, c = [mpR(m.position.x), mpR(m.position.y), mpR(m.position.z), mpR(m.rotation.y, 100), e.state, e.stunTimer > 0 ? mpR(e.stunTimer, 10) : 0], o = L[i];
                        if (full || !o || Math.abs(c[0] - o[0]) + Math.abs(c[2] - o[2]) > 0.05 || Math.abs(c[1] - o[1]) > 0.08 || Math.abs(c[3] - o[3]) > 0.08 || c[4] !== o[4] || (c[5] > 0) !== (o[5] > 0)) { rows.push([i].concat(c)); L[i] = c; }
                    });
                    if (rows.length) MP.bcast({ t: 'ents', a: rows });
                }
            }
            for (const id in MP.players) {
                if (id === MP.me.id) continue; const n = MP.net[id]; if (!n) continue; let a = MP.avs[id] || MP.mkAvatar(id); if (!a) continue;
                if (a.root.parent !== scene) scene.add(a.root); MP.updAvatar(a, n, dt);
            }
            MP.corpses.forEach(o => { if (o.parent !== scene) scene.add(o); });
            for (const id in MP.conns) if (now - (MP.seen[id] || now) > 20000) MP.dropPeer(id); // silent peers (crash, closed laptop)
            if (MP.pendingEnd && now > MP.pendingEnd) { MP.pendingEnd = 0; if (MP.phase === 'run') MP.endRun('RUN COMPLETE! Everyone returns to the waiting room.', false); }
            // voice -> noise: the leader's setting decides whether monsters hear anybody (local mic included) - identical on every client
            if (MP.settings.hear && !GameState.inShop) {
                const spk = [[p, MP.myVol(), MP.me.id]]; for (const id in MP.players) { const n = MP.net[id]; if (id !== MP.me.id && n && n.v > 0 && !MP.dead[id] && n.lvl === GameState.level) spk.push([MP.tv(id), n.v, id]); }
                spk.forEach(([pos, v, id]) => { MP.hearCd[id] = Math.max(0, (MP.hearCd[id] || 0) - dt); if (v > 0.14 && MP.hearCd[id] <= 0 && !(id === MP.me.id && MP.me.ghost)) { MP.hearCd[id] = 0.35; const r = 8 + v * 44; GameState.entities.forEach(en => { if (en.mesh.position.distanceTo(pos) <= r) en.alertToPosition(pos.clone(), 10 + v * 10); }); } });
            }
            if (MP.me.ghost) { const P = GameState.player; P.sanity = PermaFx.maxSan(); P.stamina = 100; P.battery = 100; P._winded = false; P._exh = 0; } // spectators: every bar pinned at 100%
            MP.voiceUpdate(); MP.hudUpdate(now);
        };
        // ---- voice chat (open mic, positional) ----
        MP.myVol = () => { const an = MP.an; if (!an || !MP.micOn) return 0; an.getByteTimeDomainData(MP.anBuf); let s = 0; for (let i = 0; i < MP.anBuf.length; i++) { const v = (MP.anBuf[i] - 128) / 128; s += v * v; } return Math.min(1, Math.max(0, (Math.sqrt(s / MP.anBuf.length) - 0.012) * 4.2)); };
        MP.actxGet = () => { if (!MP.actx) { const C = window.AudioContext || window.webkitAudioContext; MP.actx = new C(); } if (MP.actx.state === 'suspended') MP.actx.resume().catch(() => {}); return MP.actx; };
        MP.voiceStart = async () => {
            if (MP.stream || MP.voiceTried || !MP.active) return; MP.voiceTried = true;
            try {
                MP.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
                const ctx = MP.actxGet(); MP.an = ctx.createAnalyser(); MP.an.fftSize = 256; MP.anBuf = new Uint8Array(MP.an.frequencyBinCount); ctx.createMediaStreamSource(MP.stream).connect(MP.an);
                MP.stream.getAudioTracks().forEach(t => t.enabled = MP.micOn); Object.keys(MP.conns).forEach(id => MP.voiceCall(id));
            } catch (e) { MP.chatAdd('', 'Microphone unavailable - you can hear others but they cannot hear you.', true); }
        };
        MP.voiceCall = id => { if (!MP.stream || !MP.peer || MP.calls[id + ':out']) return; try { const c = MP.peer.call(id, MP.stream); MP.calls[id + ':out'] = c; MP.voiceBind(c, id); } catch (e) {} };
        MP.voiceAnswer = call => { try { call.answer(MP.stream || undefined); MP.voiceBind(call, call.peer); } catch (e) {} };
        MP.voiceBind = (call, id) => { call.on('stream', st => MP.voicePlay(id, st)); call.on('close', () => { if (MP.calls[id + ':out'] === call) delete MP.calls[id + ':out']; }); call.on('error', () => {}); };
        MP.voicePlay = (id, st) => {
            MP.voiceStop(id, true); const ctx = MP.actxGet(), el = new Audio(); el.srcObject = st; el.muted = true; el.play().catch(() => {}); // (Chrome only feeds WebAudio from remote streams that are also attached to a media element)
            const src = ctx.createMediaStreamSource(st), pan = ctx.createPanner(), g = ctx.createGain(); pan.panningModel = 'equalpower'; pan.distanceModel = 'inverse'; pan.refDistance = 3; pan.maxDistance = 70; pan.rolloffFactor = 1.1;
            src.connect(pan); pan.connect(g); g.connect(ctx.destination); MP.vols[id] = { el, src, pan, g };
        };
        MP.voiceStop = (id, keepCalls) => { const v = MP.vols[id]; if (v) { try { v.src.disconnect(); v.pan.disconnect(); v.g.disconnect(); v.el.srcObject = null; } catch (e) {} delete MP.vols[id]; } if (!keepCalls) { const c = MP.calls[id + ':out']; if (c) { try { c.close(); } catch (e) {} delete MP.calls[id + ':out']; } } };
        MP.voiceStopAll = () => { Object.keys(MP.vols).forEach(i => MP.voiceStop(i)); if (MP.stream) { MP.stream.getTracks().forEach(t => t.stop()); MP.stream = null; } MP.an = null; MP.voiceTried = false; };
        MP.voiceUpdate = () => {
            const ctx = MP.actx; if (!ctx) return; const L = ctx.listener, c = camera.getWorldPosition(mpV), d = camera.getWorldDirection(new THREE.Vector3());
            if (L.positionX) { L.positionX.value = c.x; L.positionY.value = c.y; L.positionZ.value = c.z; L.forwardX.value = d.x; L.forwardY.value = d.y; L.forwardZ.value = d.z; L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0; } else { L.setPosition(c.x, c.y, c.z); L.setOrientation(d.x, d.y, d.z, 0, 1, 0); }
            for (const id in MP.vols) { const v = MP.vols[id], a = MP.avs[id], n = MP.net[id]; if (a && a.cur) { v.pan.positionX ? (v.pan.positionX.value = a.cur.x, v.pan.positionY.value = a.cur.hy, v.pan.positionZ.value = a.cur.z) : v.pan.setPosition(a.cur.x, a.cur.hy, a.cur.z); }
                const ghostHeard = MP.dead[id] && !MP.me.ghost; v.g.gain.value = ghostHeard ? 0 : 1; } // living players do not hear ghosts, either
        };
        // ---- text chat ----
        MP.chatAdd = (name, text, sys) => {
            MP.chatLog.push({ name, text, sys, t: performance.now() }); if (MP.chatLog.length > 60) MP.chatLog.shift();
            const f = mpEl('mp-feed'); if (f) { const d = document.createElement('div'); d.style.cssText = 'margin:2px 0;padding:2px 6px;background:rgba(0,0,0,.5);color:' + (sys ? '#9c9270' : '#eee'); d.textContent = sys ? text : name + ': ' + text; f.appendChild(d); while (f.children.length > 7) f.removeChild(f.firstChild); setTimeout(() => d.remove(), 14000); }
            if (!sys && window.__vrOn) { try { showEventBanner(name + ': ' + text, 4); } catch (e) {} }
            MP.chatPanel();
        };
        MP.chatSend = text => { text = String(text || '').trim().slice(0, 120); if (!text || !MP.active) return; MP.chatAdd(MP.me.name, text, false); MP.bcast({ t: 'chat', m: text }); };
        MP.chatPanel = () => { const l = mpEl('mp-chat-log'); if (!l || mpEl('mp-chat-panel').style.display === 'none') return; l.innerHTML = ''; MP.chatLog.slice(-8).forEach(m => { const d = document.createElement('div'); d.textContent = m.sys ? '* ' + m.text : m.name + ': ' + m.text; d.style.color = m.sys ? '#9c9270' : '#ddd'; l.appendChild(d); }); };
        MP.openChat = () => { if (!MP.active) return; if (window.__vrOn || GameState.mpMenu || GameState.shopOpen) { mpEl('mp-chat-panel').style.display = 'flex'; MP.chatPanel(); return; } const b = mpEl('mp-chatbar'); GameState.chatOpen = true; b.style.display = 'block'; try { controls.unlock(); } catch (e) {} const i = mpEl('mp-chatbar-in'); i.value = ''; setTimeout(() => i.focus(), 0); };
        MP.closeChat = send => { const b = mpEl('mp-chatbar'), i = mpEl('mp-chatbar-in'); if (send) MP.chatSend(i.value); i.value = ''; i.blur(); b.style.display = 'none'; GameState.chatOpen = false; if (GameState.isRunning && !GameState.shopOpen && !GameState.mpMenu) { try { controls.lock(); } catch (e) {} } };
        // ---- pause is a soft pause in multiplayer: the world keeps running for everyone ----
        MP.softPause = () => { GameState.mpMenu = true; for (const k in keys) keys[k] = false; try { controls.unlock(); } catch (e) {} mpEl('pause-menu').style.display = 'flex'; { const cm = mpEl('code-msg'); if (cm) { cm.style.color = '#9c9270'; cm.textContent = 'COINS: ' + Save.coins; } } MP.uiRefresh(); };
        MP.softResume = () => { GameState.mpMenu = false; mpEl('pause-menu').style.display = 'none'; const s = mpEl('settings-modal'); s.style.display = 'none'; s.classList.remove('in-game'); ['mp-chat-panel', 'mp-room'].forEach(i => mpEl(i).style.display = 'none'); GameState.shopOpen = false; try { controls.lock(); } catch (e) {} };
        MP.vote = () => { const on = !MP.votes[MP.me.id]; if (on) MP.votes[MP.me.id] = 1; else delete MP.votes[MP.me.id]; MP.bcast({ t: 'vote', v: on ? 1 : 0 }); MP.afterChange(); MP.uiRefresh(); };
        // ---- HUD + menus ----
        MP.hudUpdate = now => {
            const h = mpEl('mp-hud'); if (!h) return; const ids = Object.keys(MP.players), v = ids.filter(i => MP.votes[i]).length, ghosts = ids.filter(i => MP.dead[i]).length;
            h.textContent = `ROOM ${MP.code} | ${ids.length}/${MP_MAX} players | ${MP.phase === 'run' ? 'RUN ACTIVE' + (ghosts ? ` | ${ghosts} ghost${ghosts > 1 ? 's' : ''}` : '') : 'WAITING ROOM'}` + (MP.phase === 'run' && v ? ` | END-RUN VOTES ${v}/${Math.ceil(ids.length / 2)}` : '') + (MP.phase === 'run' && Object.keys(MP.exited).length ? ` | AT EXIT ${Object.keys(MP.exited).length}/${ids.length - ghosts}` : '') + (MP.me.ghost ? ' | YOU ARE A GHOST' : '');
        };
        MP.uiRefresh = () => {
            const set = (id, v) => { const e = mpEl(id); if (e) e.textContent = v; };
            const pl = mpEl('mp-room-players'); if (pl) { pl.innerHTML = ''; Object.keys(MP.players).forEach(id => { const d = document.createElement('div'); const p = MP.players[id], n = MP.net[id]; d.textContent = (id === MP.hostId ? '[LEADER] ' : '') + p.name + (id === MP.me.id ? ' (you)' : '') + (MP.dead[id] ? ' [GHOST]' : '') + (n && n.v > 0.14 ? ' [talking]' : ''); d.style.cssText = 'padding:3px 0;color:' + (id === MP.me.id ? '#e6c84c' : '#ccc'); if (MP.isHost && id !== MP.me.id) { const kb = document.createElement('button'); kb.className = 'menu-btn'; kb.textContent = 'KICK ' + p.name; kb.style.cssText = 'display:inline-block;width:auto;margin-left:10px;padding:2px 10px;font-size:12px'; kb.addEventListener('click', () => MP.kick(id)); d.appendChild(kb); } pl.appendChild(d); }); }
            set('mp-room-code', MP.code); const lead = MP.isHost, S = MP.settings;
            [['mp-set-join', 'allowJoin', true], ['mp-set-beta', 'beta', MP.phase === 'lobby'], ['mp-set-hear', 'hear', true]].forEach(([id, k, en]) => { const c = mpEl(id); if (!c) return; c.checked = !!S[k]; c.disabled = !(lead && en); });
            set('mp-room-note', lead ? (MP.phase === 'lobby' ? 'You are the party leader. Change the room settings, then press the green NEXT LEVEL button.' : 'A run is active - settings except joining / voice-hearing are locked.') : 'Only the party leader (' + ((MP.leader() || {}).name || '?') + ') can change settings or press NEXT LEVEL, until 60s pass in the waiting room.');
            set('mp-room-diff', 'DIFFICULTY (set by leader at creation): ' + ((DifficultyConfigs[S.diff] || {}).label || S.diff));
            const mb = mpEl('mp-mic-btn'); if (mb) mb.textContent = 'MICROPHONE: ' + (MP.micOn ? 'ON' : 'MUTED');
            const row = mpEl('pause-mp-row'); if (row) row.style.display = MP.active ? 'flex' : 'none';
            const vb = mpEl('pause-vote-btn'); if (vb) { const ids = Object.keys(MP.players), v = ids.filter(i => MP.votes[i]).length; vb.disabled = MP.phase !== 'run'; vb.textContent = (MP.votes[MP.me.id] ? 'WITHDRAW VOTE TO END RUN' : 'VOTE TO END RUN') + ` (${v}/${Math.ceil(ids.length / 2)} NEEDED)`; }
            const nm = mpEl('mp-name'); if (nm && document.activeElement !== nm) nm.value = MP.me.name;
        };
        MP.openRoom = () => { if (!MP.active) return; GameState.shopOpen = true; try { controls.unlock(); } catch (e) {} mpEl('mp-room').style.display = 'flex'; MP.uiRefresh(); };
        MP.closeRoom = () => { mpEl('mp-room').style.display = 'none'; GameState.shopOpen = false; if (GameState.mpMenu) return; try { controls.lock(); } catch (e) {} };
        MP.setName = n => { n = String(n || '').replace(/[^\w \-.!?]/g, '').trim().slice(0, 16) || mpRandName(); MP.me.name = n; try { localStorage.setItem('mp_name', n); } catch (e) {} if (MP.active) { MP.players[MP.me.id] && (MP.players[MP.me.id].name = n); MP.bcast({ t: 'me', i: MP.info() }); if (MP.isHost) MP.pushRoster(); } MP.uiRefresh(); };
        {
            const E = id => mpEl(id), show = (id, on) => E(id).style.display = on ? 'flex' : 'none', msg = (id, t, c) => { const e = E(id); e.textContent = t; e.style.color = c || '#ff9a7a'; };
            const hideAll = () => ['mp-menu', 'mp-join', 'mp-create'].forEach(i => show(i, false));
            E('mp-btn').addEventListener('click', () => { AudioSys.playClick(); show('mp-menu', true); });
            E('mp-menu-back').addEventListener('click', () => show('mp-menu', false));
            E('mp-open-join').addEventListener('click', () => { show('mp-menu', false); msg('mp-join-msg', ''); show('mp-join', true); });
            E('mp-open-create').addEventListener('click', () => { show('mp-menu', false); msg('mp-create-msg', ''); show('mp-create', true); });
            ['mp-join-back', 'mp-create-back'].forEach(i => E(i).addEventListener('click', () => { hideAll(); show('mp-menu', true); }));
            ['mp-join-code', 'mp-create-code', 'mp-name', 'mp-chat-input', 'mp-chatbar-in'].forEach(id => ['keydown', 'keyup', 'keypress'].forEach(ev => E(id).addEventListener(ev, e => { e.stopPropagation(); if (ev === 'keydown') { if (e.key === 'Enter') { if (id === 'mp-join-code') E('mp-join-go').click(); else if (id === 'mp-create-code') E('mp-create-go').click(); else if (id === 'mp-chat-input') E('mp-chat-send').click(); else if (id === 'mp-chatbar-in') MP.closeChat(true); else if (id === 'mp-name') MP.setName(E('mp-name').value); } else if (e.key === 'Escape' && id === 'mp-chatbar-in') MP.closeChat(false); } })));
            E('mp-name').addEventListener('change', () => MP.setName(E('mp-name').value));
            E('mp-name-rand').addEventListener('click', () => MP.setName(mpRandName()));
            let joining = false;
            E('mp-join-go').addEventListener('click', async () => {
                const wait = MP_JOIN_CD - (performance.now() - MP.lastJoin); if (joining || wait > 0) return msg('mp-join-msg', `Please wait ${Math.ceil(Math.max(wait, 0) / 1000)}s before trying again.`);
                MP.lastJoin = performance.now(); joining = true; const b = E('mp-join-go'); b.disabled = true; msg('mp-join-msg', 'Looking for the room...', '#e6c84c');
                const r = await MP.join(E('mp-join-code').value); joining = false; setTimeout(() => b.disabled = false, Math.max(0, MP_JOIN_CD - (performance.now() - MP.lastJoin)));
                if (r.err) return msg('mp-join-msg', r.err); hideAll(); MP.enterLobby();
            });
            E('mp-create-go').addEventListener('click', async () => {
                const b = E('mp-create-go'); b.disabled = true; msg('mp-create-msg', 'Creating the room...', '#e6c84c');
                const err = await MP.create(E('mp-create-code').value, E('mp-allow-join').checked, E('mp-beta').checked, GameState.difficulty); b.disabled = false;
                if (err) return msg('mp-create-msg', err); hideAll(); MP.enterLobby();
            });
            [['mp-set-join', 'allowJoin'], ['mp-set-beta', 'beta'], ['mp-set-hear', 'hear']].forEach(([id, k]) => E(id).addEventListener('change', e => { if (!MP.setSetting(k, e.target.checked)) MP.uiRefresh(); }));
            E('mp-mic-btn').addEventListener('click', () => { MP.micOn = !MP.micOn; if (MP.stream) MP.stream.getAudioTracks().forEach(t => t.enabled = MP.micOn); MP.uiRefresh(); });
            E('mp-room-chat').addEventListener('click', () => { show('mp-chat-panel', true); MP.chatPanel(); });
            E('mp-room-close').addEventListener('click', MP.closeRoom);
            E('mp-room-leave').addEventListener('click', () => { MP.closeRoom(); MP.leave(); exitToMenu(); });
            E('mp-chat-send').addEventListener('click', () => { const i = E('mp-chat-input'); MP.chatSend(i.value); i.value = ''; MP.chatPanel(); });
            E('mp-chat-close').addEventListener('click', () => show('mp-chat-panel', false));
            E('pause-room-btn').addEventListener('click', () => MP.openRoom());
            E('pause-chat-btn').addEventListener('click', () => { show('mp-chat-panel', true); MP.chatPanel(); });
            E('pause-vote-btn').addEventListener('click', () => MP.vote());
            document.addEventListener('keydown', e => { if (e.key === '/' && MP.active && GameState.isRunning && !GameState.chatOpen && !GameState.isPaused && !(e.target && /INPUT|TEXTAREA/.test(e.target.tagName))) { e.preventDefault(); MP.openChat(); } });
            document.addEventListener('mousedown', e => { if (MP.active && e.button === 0 && GameState.isRunning && !GameState.mpMenu) { const s = GameState.inv[GameState.invSel]; if (s && (s.id === 'axe' || s.id === 'crowbar')) MP.swing = (MP.swing + 1) % 1000; } });
            window.addEventListener('beforeunload', () => { try { if (MP.active) MP.bcast({ t: 'bye' }); } catch (e) {} });
        }

        const AudioSys = {
            ctx: null,
            masterGain: null,
            compressor: null,
            humOsc: null,
            humOsc2: null,
            playDrip() {}, playHover() { this._t(1300, 0.025, 'sine', 0.04); },
            playChest() { this._t(150, 0.45, 'sawtooth', 0.1, 260); this._t(90, 0.2, 'square', 0.12, 60, 0.35); }, playCrateBreak() { this._t(120, 0.35, 'sawtooth', 0.22, 40); this._t(300, 0.2, 'square', 0.12, 90, 0.04); },
            playFakeBurst() { this._t(90, 0.5, 'sawtooth', 0.28, 30); this._t(1800, 0.25, 'square', 0.12, 200, 0.02); },
            playLeviathan() { this._t(46, 3.2, 'sine', 0.3, 30); this._t(31, 3.6, 'sine', 0.25, 24, 0.3); }, // silent until a "drip" blob exists in AUDIO
            humGain: null,
            noiseBuffer: null,
            initialized: false,

            async init() {
                if (this.initialized && this.ctx) {
                    await this.ensureReady();
                    return;
                }
                try {
                    const AudioContext = window.AudioContext || window.webkitAudioContext;
                    this.ctx = new AudioContext();

                    this.compressor = this.ctx.createDynamicsCompressor();
                    this.compressor.threshold.setValueAtTime(-16, this.ctx.currentTime);
                    this.compressor.knee.setValueAtTime(20, this.ctx.currentTime);
                    this.compressor.ratio.setValueAtTime(4, this.ctx.currentTime);
                    this.compressor.attack.setValueAtTime(0.005, this.ctx.currentTime);
                    this.compressor.release.setValueAtTime(0.15, this.ctx.currentTime);

                    this.masterGain = this.ctx.createGain();
                    this.masterGain.gain.setValueAtTime(0.95, this.ctx.currentTime);

                    this.masterGain.connect(this.compressor);
                    this.compressor.connect(this.ctx.destination);

                    // Auto-resume if browser interrupts audio context (e.g. mic device activation or tab switch)
                    this.ctx.onstatechange = () => {
                        if (this.ctx && this.ctx.state === 'suspended' && GameState.isRunning && !GameState.isPaused) {
                            this.ctx.resume().catch(() => {});
                        }
                    };

                    // Pre-generate 1.5s white/pink noise buffer for footsteps, steam, and shotgun blasts
                    const sampleRate = this.ctx.sampleRate;
                    const len = Math.floor(sampleRate * 1.5);
                    this.noiseBuffer = this.ctx.createBuffer(1, len, sampleRate);
                    const data = this.noiseBuffer.getChannelData(0);
                    let b0 = 0, b1 = 0, b2 = 0;
                    for (let i = 0; i < len; i++) {
                        const white = Math.random() * 2 - 1;
                        b0 = 0.99765 * b0 + white * 0.099046;
                        b1 = 0.96300 * b1 + white * 0.2965164;
                        b2 = 0.57000 * b2 + white * 1.0526913;
                        data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.25;
                    }

                    // Fluorescent Light Hum (60Hz + 120Hz harmonic buzz)
                    this.humOsc = this.ctx.createOscillator();
                    this.humOsc.type = 'sawtooth';
                    this.humOsc.frequency.setValueAtTime(60, this.ctx.currentTime);

                    this.humOsc2 = this.ctx.createOscillator();
                    this.humOsc2.type = 'triangle';
                    this.humOsc2.frequency.setValueAtTime(120, this.ctx.currentTime);

                    const humFilter = this.ctx.createBiquadFilter();
                    humFilter.type = 'lowpass';
                    humFilter.frequency.setValueAtTime(190, this.ctx.currentTime);

                    this.humGain = this.ctx.createGain();
                    this.humGain.gain.setValueAtTime(0.06, this.ctx.currentTime);

                    this.humOsc.connect(humFilter);
                    this.humOsc2.connect(humFilter);
                    humFilter.connect(this.humGain);
                    this.humGain.connect(this.masterGain);

                    this.humOsc.start();
                    this.humOsc2.start();

                    this.initialized = true;
                    await this.ensureReady();
                } catch (err) {
                    console.warn("Web Audio initialization deferred:", err);
                }
            },

            async ensureReady() {
                if (!this.ctx) return;
                if (this.ctx.state !== 'running') {
                    try {
                        await this.ctx.resume();
                    } catch (e) {}
                }
            },

            playClick() {
                if (!this.ctx) return;
                this.ensureReady();
                const now = this.ctx.currentTime;
                const osc = this.ctx.createOscillator();
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(1150, now);
                osc.frequency.exponentialRampToValueAtTime(320, now + 0.045);
                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(0.28, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.05);
                osc.connect(gain);
                gain.connect(this.masterGain);
                osc.start(now);
                osc.stop(now + 0.055);
            },

            playPickup() {
                if (!this.ctx) return;
                this.ensureReady();
                const now = this.ctx.currentTime;
                const osc = this.ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(520, now);
                osc.frequency.exponentialRampToValueAtTime(1040, now + 0.16);
                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(0.3, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
                osc.connect(gain);
                gain.connect(this.masterGain);
                osc.start(now);
                osc.stop(now + 0.19);
            },

            playPing() {
                if (!this.ctx) return;
                this.ensureReady();
                const now = this.ctx.currentTime;
                const osc = this.ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(980, now);
                osc.frequency.exponentialRampToValueAtTime(420, now + 0.55);
                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(0.32, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
                osc.connect(gain);
                gain.connect(this.masterGain);
                osc.start(now);
                osc.stop(now + 0.62);
            },

            playShotgun() {
                if (!this.ctx) return;
                this.ensureReady();
                const now = this.ctx.currentTime;

                // Explosive noise blast
                if (this.noiseBuffer) {
                    const noise = this.ctx.createBufferSource();
                    noise.buffer = this.noiseBuffer;
                    const filter = this.ctx.createBiquadFilter();
                    filter.type = 'lowpass';
                    filter.frequency.setValueAtTime(2400, now);
                    filter.frequency.exponentialRampToValueAtTime(180, now + 0.65);

                    const nGain = this.ctx.createGain();
                    nGain.gain.setValueAtTime(0.95, now);
                    nGain.gain.exponentialRampToValueAtTime(0.005, now + 0.7);

                    noise.connect(filter);
                    filter.connect(nGain);
                    nGain.connect(this.masterGain);
                    noise.start(now);
                    noise.stop(now + 0.72);
                }

                // Heavy low-end punch
                const punch = this.ctx.createOscillator();
                punch.type = 'sine';
                punch.frequency.setValueAtTime(165, now);
                punch.frequency.exponentialRampToValueAtTime(32, now + 0.35);
                const pGain = this.ctx.createGain();
                pGain.gain.setValueAtTime(0.9, now);
                pGain.gain.exponentialRampToValueAtTime(0.005, now + 0.38);
                punch.connect(pGain);
                pGain.connect(this.masterGain);
                punch.start(now);
                punch.stop(now + 0.4);
            },

            playSecondChanceHit() {
                if (!this.ctx) return;
                this.ensureReady();
                const now = this.ctx.currentTime;
                const osc = this.ctx.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(220, now);
                osc.frequency.exponentialRampToValueAtTime(55, now + 0.5);
                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(0.55, now);
                gain.gain.exponentialRampToValueAtTime(0.005, now + 0.55);
                osc.connect(gain);
                gain.connect(this.masterGain);
                osc.start(now);
                osc.stop(now + 0.56);
            },

            playBacteriaScream() { // the bacterium's functional attack: immobilizes the player
                if (!this.ctx) return;
                this.ensureReady();
                const now = this.ctx.currentTime;
                const osc = this.ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(118, now);
                osc.frequency.exponentialRampToValueAtTime(36, now + 0.3);
                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(0.5, now);
                gain.gain.exponentialRampToValueAtTime(0.002, now + 0.35);
                osc.connect(gain);
                gain.connect(this.masterGain);
                osc.start(now);
                osc.stop(now + 0.4);
            },
            playBacteriaPunch() { // functional punch attack: immobilizes the player briefly
                if (!this.ctx) return;
                this.ensureReady();
                const now = this.ctx.currentTime;
                const osc = this.ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(150, now);
                osc.frequency.exponentialRampToValueAtTime(40, now + 0.3);
                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(0.7, now);
                gain.gain.exponentialRampToValueAtTime(0.002, now + 0.35);
                osc.connect(gain);
                gain.connect(this.masterGain);
                osc.start(now);
                osc.stop(now + 0.4);
            },

            playSpark(distance) {
                if (!this.ctx || distance > 20) return;
                this.ensureReady();
                const now = this.ctx.currentTime;
                const vol = Math.max(0, 1 - (distance / 20)) * 0.35;
                const osc = this.ctx.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(160 + Math.random() * 420, now);
                osc.frequency.linearRampToValueAtTime(90 + Math.random() * 200, now + 0.22);
                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(vol, now);
                gain.gain.exponentialRampToValueAtTime(0.002, now + 0.24);
                osc.connect(gain);
                gain.connect(this.masterGain);
                osc.start(now);
                osc.stop(now + 0.25);
            },

            playJumpscare() {
                if (!this.ctx) return;
                this.ensureReady();
                const now = this.ctx.currentTime;
                const osc1 = this.ctx.createOscillator();
                const osc2 = this.ctx.createOscillator();
                const osc3 = this.ctx.createOscillator();
                osc1.type = 'sawtooth';
                osc2.type = 'square';
                osc3.type = 'sine';
                osc1.frequency.setValueAtTime(110, now);
                osc1.frequency.exponentialRampToValueAtTime(34, now + 1.1);
                osc2.frequency.setValueAtTime(840, now);
                osc2.frequency.linearRampToValueAtTime(230, now + 1.1);
                osc3.frequency.setValueAtTime(150, now);
                osc3.frequency.exponentialRampToValueAtTime(28, now + 1.1);
                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(0.8, now);
                gain.gain.exponentialRampToValueAtTime(0.005, now + 1.15);
                osc1.connect(gain);
                osc2.connect(gain);
                osc3.connect(gain);
                gain.connect(this.jumpBus || this.masterGain);
                osc1.start(now);
                osc2.start(now);
                osc3.start(now);
                osc1.stop(now + 1.16);
                osc2.stop(now + 1.16);
                osc3.stop(now + 1.16);
            },

            playChaseStinger() {
                if (!this.ctx) return;
                this.ensureReady();
                const now = this.ctx.currentTime;
                const osc = this.ctx.createOscillator();
                osc.type = 'sawtooth';
                osc.frequency.setValueAtTime(185, now);
                osc.frequency.exponentialRampToValueAtTime(54, now + 0.45);
                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(0.42, now);
                gain.gain.exponentialRampToValueAtTime(0.005, now + 0.46);
                osc.connect(gain);
                gain.connect(this.masterGain);
                osc.start(now);
                osc.stop(now + 0.47);
            },

            playStep() {
                if (!this.ctx || !this.noiseBuffer) return;
                this.ensureReady();
                const now = this.ctx.currentTime;
                const isCarpet = (GameState.level === 0 || GameState.level === 4);
                const loudMult = GameState.difficulty === 'extreme' ? 1.45 : 1.0;

                const source = this.ctx.createBufferSource();
                source.buffer = this.noiseBuffer;
                source.playbackRate.value = 0.9 + Math.random() * 0.25;

                const filter = this.ctx.createBiquadFilter();
                filter.type = 'bandpass';
                filter.frequency.setValueAtTime(isCarpet ? 320 : 780, now);
                filter.Q.setValueAtTime(1.2, now);

                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(Math.min(0.65, (isCarpet ? 0.34 : 0.44) * loudMult), now);
                gain.gain.exponentialRampToValueAtTime(0.002, now + 0.11);

                source.connect(filter);
                filter.connect(gain);
                gain.connect(this.masterGain);
                source.start(now, Math.random() * 0.5, 0.12);
            },

            playHeartbeat(intensity) {
                if (!this.ctx || intensity <= 0) return;
                this.ensureReady();
                const now = this.ctx.currentTime;
                const osc = this.ctx.createOscillator();
                osc.type = 'sine';
                osc.frequency.setValueAtTime(52, now);
                osc.frequency.exponentialRampToValueAtTime(24, now + 0.22);
                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(Math.min(0.75, intensity * 1.15), now);
                gain.gain.exponentialRampToValueAtTime(0.002, now + 0.23);
                osc.connect(gain);
                gain.connect(this.masterGain);
                osc.start(now);
                osc.stop(now + 0.24);
            },

            playMonsterSound(type, distance) {
                if (!this.ctx || distance > 24) return;
                this.ensureReady();
                const now = this.ctx.currentTime;
                const vol = Math.max(0, 1 - (distance / 24)) * 0.48;
                const osc = this.ctx.createOscillator();
                osc.type = type === 'bacteria' ? 'triangle' : 'sawtooth';
                const freq = type === 'bacteria' ? (Math.random() * 220 + 380) : (Math.random() * 45 + 55);
                osc.frequency.setValueAtTime(freq, now);
                if (type === 'bacteria') {
                    osc.frequency.linearRampToValueAtTime(freq + 190, now + 0.45);
                } else {
                    osc.frequency.linearRampToValueAtTime(freq * 0.7, now + 0.5);
                }
                const gain = this.ctx.createGain();
                gain.gain.setValueAtTime(vol, now);
                gain.gain.exponentialRampToValueAtTime(0.002, now + 0.5);
                osc.connect(gain);
                gain.connect(this.masterGain);
                osc.start(now);
                osc.stop(now + 0.52);
            }
        };

        // Ensure audio context resumes on any user interaction anywhere on the page
        ['pointerdown', 'keydown', 'click'].forEach(evt => {
            window.addEventListener(evt, () => {
                if (AudioSys.ctx && AudioSys.ctx.state !== 'running' && !GameState.isPaused) {
                    AudioSys.ctx.resume().catch(() => {});
                }
            }, { passive: true });
        });

        // --- REAL-TIME MICROPHONE INPUT ANALYSER ---
        const MicSys = {
            stream: null,
            ctx: null,
            analyser: null,
            dataArray: null,
            active: false,

            async enable() {
                if (this.active && this.stream) return true;
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true
                        }
                    });
                    const AudioContext = window.AudioContext || window.webkitAudioContext;
                    this.ctx = new AudioContext();
                    if (this.ctx.state === 'suspended') await this.ctx.resume();

                    const source = this.ctx.createMediaStreamSource(stream);
                    this.analyser = this.ctx.createAnalyser();
                    this.analyser.fftSize = 256;
                    this.analyser.smoothingTimeConstant = 0.5;
                    source.connect(this.analyser);

                    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
                    this.stream = stream;
                    this.active = true;
                    return true;
                } catch (err) {
                    this.active = false;
                    return false;
                }
            },

            disable() {
                this.active = false;
                GameState.micVolume = 0;
                if (this.stream) {
                    this.stream.getTracks().forEach(t => t.stop());
                    this.stream = null;
                }
                if (this.ctx) {
                    this.ctx.close().catch(() => {});
                    this.ctx = null;
                }
                this.analyser = null;
            },

            getVolume() {
                if (!this.active || !this.analyser || !this.dataArray) return 0;
                if (this.ctx && this.ctx.state === 'suspended') {
                    this.ctx.resume().catch(() => {});
                }
                this.analyser.getByteTimeDomainData(this.dataArray);
                let sumSquares = 0;
                for (let i = 0; i < this.dataArray.length; i++) {
                    const normalized = (this.dataArray[i] - 128) / 128;
                    sumSquares += normalized * normalized;
                }
                const rms = Math.sqrt(sumSquares / this.dataArray.length);
                // Scale rms so normal speaking ~0.35-0.65 and shouting ~0.85-1.0
                return Math.min(1, Math.max(0, (rms - 0.012) * 4.2));
            }
        };

        // --- PROCEDURAL TEXTURES & PBR ROUGHNESS MAPS ---
        const TextureGen = {
            cache: {},
            roughnessCache: {},

            clearCache() {
                Object.values(this.cache).forEach(t => t.dispose());
                Object.values(this.roughnessCache).forEach(t => t.dispose());
                this.cache = {};
                this.roughnessCache = {};
            },

            create(type) {
                const res = GameState.graphics.texSize || 512;
                const cacheKey = `${type}_${res}`;
                if (this.cache[cacheKey]) return this.cache[cacheKey];
                
                const canvas = document.createElement('canvas');
                canvas.width = res;
                canvas.height = res;
                const ctx = canvas.getContext('2d');
                const scale = res / 512;
                ctx.save();
                ctx.scale(scale, scale);
                
                if (type === 'carpet') {
                    ctx.fillStyle = '#8b773a';
                    ctx.fillRect(0, 0, 512, 512);
                    const dotCount = Math.floor(40000 * Math.min(1, scale));
                    for (let i = 0; i < dotCount; i++) {
                        ctx.fillStyle = Math.random() > 0.5 ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.05)';
                        ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
                    }
                    for (let s = 0; s < 6; s++) {
                        const grad = ctx.createRadialGradient(
                            120 + (s * 73) % 350, 140 + (s * 97) % 320, 5,
                            120 + (s * 73) % 350, 140 + (s * 97) % 320, 65
                        );
                        grad.addColorStop(0, 'rgba(35, 28, 12, 0.25)');
                        grad.addColorStop(1, 'rgba(35, 28, 12, 0)');
                        ctx.fillStyle = grad;
                        ctx.fillRect(0, 0, 512, 512);
                    }
                } else if (type === 'wallpaper') {
                    ctx.fillStyle = '#d6b847';
                    ctx.fillRect(0, 0, 512, 512);
                    ctx.strokeStyle = '#c4a635';
                    ctx.lineWidth = 4;
                    for (let y = 0; y < 512; y += 32) {
                        ctx.beginPath();
                        ctx.moveTo(0, y);
                        for (let x = 0; x <= 512; x += 32) {
                            ctx.lineTo(x, y + (x % 64 === 0 ? 16 : -16));
                        }
                        ctx.stroke();
                    }
                    const moldCount = Math.floor(5000 * Math.min(1, scale));
                    for (let i = 0; i < moldCount; i++) {
                        ctx.fillStyle = 'rgba(50, 40, 20, 0.05)';
                        ctx.beginPath();
                        ctx.arc(Math.random() * 512, Math.random() * 512, Math.random() * 5 + 1, 0, Math.PI * 2);
                        ctx.fill();
                    }
                } else if (type === 'ceiling') {
                    ctx.fillStyle = '#e0e0e0';
                    ctx.fillRect(0, 0, 512, 512);
                    ctx.strokeStyle = '#999';
                    ctx.lineWidth = 2;
                    for (let i = 0; i <= 512; i += 64) {
                        ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 512); ctx.stroke();
                        ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(512, i); ctx.stroke();
                    }
                    const grainCount = Math.floor(10000 * Math.min(1, scale));
                    for (let i = 0; i < grainCount; i++) {
                        ctx.fillStyle = 'rgba(0,0,0,0.03)';
                        ctx.fillRect(Math.random() * 512, Math.random() * 512, 1, 1);
                    }
                } else if (type === 'concrete' || type === 'concrete_wall' || type === 'concrete_dark') {
                    const base = type === 'concrete_dark' ? '#36383c' : '#777';
                    ctx.fillStyle = base;
                    ctx.fillRect(0, 0, 512, 512);
                    const gritCount = Math.floor(45000 * Math.min(1, scale));
                    for (let i = 0; i < gritCount; i++) {
                        ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.1})`;
                        ctx.fillRect(Math.random() * 512, Math.random() * 512, Math.random() * 3, Math.random() * 3);
                    }
                    if (type === 'concrete' || type === 'concrete_dark') {
                        for (let p = 0; p < 5; p++) {
                            const px = 90 + (p * 91) % 340;
                            const py = 110 + (p * 113) % 310;
                            const grad = ctx.createRadialGradient(px, py, 8, px, py, 75);
                            grad.addColorStop(0, 'rgba(15, 20, 28, 0.42)');
                            grad.addColorStop(1, 'rgba(15, 20, 28, 0)');
                            ctx.fillStyle = grad;
                            ctx.beginPath();
                            ctx.arc(px, py, 75, 0, Math.PI * 2);
                            ctx.fill();
                        }
                    }
                } else if (type === 'ducts' || type === 'pipes') {
                    ctx.fillStyle = '#222';
                    ctx.fillRect(0, 0, 512, 512);
                    ctx.fillStyle = '#4a4e54';
                    for (let x = 20; x < 512; x += 80) {
                        ctx.fillRect(x, 0, 40, 512);
                        ctx.fillStyle = 'rgba(255,255,255,0.16)';
                        ctx.fillRect(x + 10, 0, 10, 512);
                        ctx.fillStyle = '#4a4e54';
                    }
                    if (type === 'pipes') {
                        ctx.fillStyle = '#632922';
                        for (let y = 100; y < 512; y += 200) {
                            ctx.fillRect(0, y, 512, 30);
                        }
                    }
                } else if (type === 'crate') {
                    ctx.fillStyle = '#8b5a2b';
                    ctx.fillRect(0, 0, 512, 512);
                    ctx.strokeStyle = '#5c3a18';
                    ctx.lineWidth = 10;
                    ctx.strokeRect(5, 5, 502, 502);
                    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(512, 512); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(512, 0); ctx.lineTo(0, 512); ctx.stroke();
                } else if (type === 'brick_wires') {
                    ctx.fillStyle = '#3a241d';
                    ctx.fillRect(0, 0, 512, 512);
                    ctx.fillStyle = '#241510';
                    for (let y = 0; y < 512; y += 32) {
                        ctx.fillRect(0, y, 512, 4);
                        const offset = (y / 32) % 2 === 0 ? 0 : 32;
                        for (let x = offset; x < 512; x += 64) {
                            ctx.fillRect(x, y, 4, 32);
                        }
                    }
                    ctx.strokeStyle = '#111';
                    ctx.lineWidth = 8;
                    for (let w = 64; w < 512; w += 128) {
                        ctx.beginPath();
                        ctx.moveTo(w, 0);
                        ctx.bezierCurveTo(w + 20, 170, w - 20, 340, w, 512);
                        ctx.stroke();
                    }
                    ctx.fillStyle = '#363d42';
                    ctx.fillRect(180, 160, 140, 180);
                    ctx.fillStyle = '#d4a017';
                    ctx.fillRect(195, 180, 110, 20);
                } else if (type === 'office_carpet') {
                    ctx.fillStyle = '#38414a';
                    ctx.fillRect(0, 0, 512, 512);
                    const dotCount = Math.floor(45000 * Math.min(1, scale));
                    for (let i = 0; i < dotCount; i++) {
                        ctx.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.12)';
                        ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
                    }
                } else if (type === 'office_wall') {
                    ctx.fillStyle = '#9aa1a6';
                    ctx.fillRect(0, 0, 512, 512);
                    ctx.fillStyle = '#2b3036';
                    ctx.fillRect(0, 460, 512, 52);
                    ctx.fillStyle = '#090d14';
                    ctx.fillRect(96, 80, 320, 240);
                    ctx.strokeStyle = '#454c52';
                    ctx.lineWidth = 10;
                    ctx.strokeRect(96, 80, 320, 240);
                    ctx.beginPath();
                    ctx.moveTo(256, 80);
                    ctx.lineTo(256, 320);
                    ctx.stroke();
                    ctx.strokeStyle = 'rgba(180, 210, 255, 0.22)';
                    ctx.lineWidth = 2;
                    for (let r = 0; r < 40; r++) {
                        const rx = 105 + Math.random() * 300;
                        const ry = 90 + Math.random() * 190;
                        ctx.beginPath();
                        ctx.moveTo(rx, ry);
                        ctx.lineTo(rx - 4, ry + 25);
                        ctx.stroke();
                    }
                } else if (type === 'drywall') {
                    ctx.fillStyle = '#b5aea0';
                    ctx.fillRect(0, 0, 512, 512);
                    ctx.fillStyle = '#dcd7cc';
                    ctx.fillRect(240, 0, 32, 512);
                    ctx.fillRect(0, 240, 512, 32);
                    ctx.fillStyle = '#6e4e2e';
                    ctx.fillRect(0, 0, 24, 512);
                } else if (type === 'inverted_wall' || type === 'inverted_floor') {
                    ctx.fillStyle = type === 'inverted_wall' ? '#140406' : '#26080c';
                    ctx.fillRect(0, 0, 512, 512);
                    ctx.strokeStyle = '#66111b';
                    ctx.lineWidth = 3;
                    for (let i = 0; i < 512; i += 64) {
                        ctx.strokeRect(i, i, 512 - i * 2, 512 - i * 2);
                    }
                } else if (type === 'hotel_carpet') {
                    ctx.fillStyle = '#3d0c11';
                    ctx.fillRect(0, 0, 512, 512);
                    ctx.strokeStyle = '#7a591a';
                    ctx.lineWidth = 4;
                    for (let y = 32; y < 512; y += 64) {
                        for (let x = 32; x < 512; x += 64) {
                            ctx.strokeRect(x - 16, y - 16, 32, 32);
                        }
                    }
                } else if (type === 'hotel_wall') {
                    ctx.fillStyle = '#4a181c';
                    ctx.fillRect(0, 0, 512, 340);
                    ctx.fillStyle = '#241109';
                    ctx.fillRect(0, 340, 512, 172);
                    ctx.fillStyle = '#6e4e1c';
                    ctx.fillRect(0, 332, 512, 12);
                } else if (type === 'party_floor') {
                    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { ctx.fillStyle = (x + y) % 2 ? '#c94f9a' : '#f4e3f0'; ctx.fillRect(x * 64, y * 64, 64, 64); }
                    const cols = ['#ffd54a', '#4fd8e8', '#7bff8a', '#ff6a6a', '#8a7bff'];
                    for (let i = 0; i < 90; i++) { ctx.fillStyle = cols[i % 5]; ctx.save(); ctx.translate(Math.random() * 512, Math.random() * 512); ctx.rotate(Math.random() * 6); ctx.fillRect(-4, -2, 8, 4); ctx.restore(); }
                } else if (type === 'party_wall') {
                    ctx.fillStyle = '#6d2a86'; ctx.fillRect(0, 0, 512, 512);
                    ctx.fillStyle = '#8b3fa8'; for (let x = 0; x < 512; x += 64) ctx.fillRect(x, 0, 32, 512);
                    ctx.fillStyle = '#2a1033'; ctx.fillRect(0, 440, 512, 72); ctx.fillStyle = '#ffd54a'; ctx.fillRect(0, 434, 512, 8);
                    const bc = ['#ff6a6a', '#ffd54a', '#4fd8e8', '#7bff8a'];
                    for (let i = 0; i < 8; i++) { ctx.fillStyle = bc[i % 4]; ctx.beginPath(); ctx.moveTo(i * 64, 0); ctx.lineTo(i * 64 + 64, 0); ctx.lineTo(i * 64 + 32, 70); ctx.fill(); }
                    for (let i = 0; i < 14; i++) { ctx.fillStyle = bc[i % 4]; ctx.beginPath(); ctx.arc(30 + (i * 37) % 460, 150 + (i * 53) % 250, 14, 0, 7); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect(28 + (i * 37) % 460, 164 + (i * 53) % 250, 2, 40); }
                } else if (type === 'pool_tile') {
                    const N = 16, T = 512 / N;
                    ctx.fillStyle = '#8fa9ad'; ctx.fillRect(0, 0, 512, 512); // damp grout
                    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
                        const x = c * T, y = r * T, v = Math.random() * 9 - 4;
                        const g = ctx.createLinearGradient(x, y, x + T, y + T);
                        g.addColorStop(0, `rgb(${240 + v | 0},${250 + v | 0},${252 + v | 0})`); g.addColorStop(0.5, `rgb(${222 + v | 0},${240 + v | 0},${245 + v | 0})`); g.addColorStop(1, `rgb(${200 + v | 0},${226 + v | 0},${234 + v | 0})`);
                        ctx.fillStyle = g; ctx.fillRect(x + 1.5, y + 1.5, T - 3, T - 3);
                        ctx.fillStyle = 'rgba(255,255,255,.9)'; ctx.fillRect(x + 1.5, y + 1.5, T - 3, 1.5); ctx.fillRect(x + 1.5, y + 1.5, 1.5, T - 3);
                        ctx.fillStyle = 'rgba(50,95,110,.38)'; ctx.fillRect(x + 1.5, y + T - 3, T - 3, 1.5); ctx.fillRect(x + T - 3, y + 1.5, 1.5, T - 3);
                        const sg = ctx.createRadialGradient(x + T * 0.3, y + T * 0.27, 0, x + T * 0.3, y + T * 0.27, T * 0.75); sg.addColorStop(0, 'rgba(255,255,255,.6)'); sg.addColorStop(1, 'rgba(255,255,255,0)');
                        ctx.fillStyle = sg; ctx.fillRect(x + 2, y + 2, T - 4, T - 4);
                    }
                    for (let i = 0; i < 46; i++) { ctx.fillStyle = 'rgba(110,185,212,.13)'; ctx.fillRect(Math.random() * 512, Math.random() * 512, 2 + Math.random() * 3, 40 + Math.random() * 140); }
                    for (let i = 0; i < 240; i++) { const x = Math.random() * 512, y = Math.random() * 512, r = 1 + Math.random() * 2.2; ctx.fillStyle = 'rgba(80,140,170,.38)'; ctx.beginPath(); ctx.arc(x, y + 0.5, r + 0.7, 0, 7); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,.95)'; ctx.beginPath(); ctx.arc(x - r * 0.3, y - r * 0.3, r * 0.5, 0, 7); ctx.fill(); }
                    for (let i = 0; i < 7; i++) { const x = Math.random() * 512, y = Math.random() * 512, r = 40 + Math.random() * 70, g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, 'rgba(255,255,255,.28)'); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2); }
                } else if (type === 'pool_sky') {
                    const sg = ctx.createLinearGradient(0, 0, 0, 512); sg.addColorStop(0, '#eaf7ff'); sg.addColorStop(1, '#cfe9f5'); ctx.fillStyle = sg; ctx.fillRect(0, 0, 512, 512);
                    for (let i = 0; i < 6; i++) { ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.beginPath(); ctx.ellipse(60 + (i * 97) % 450, 60 + (i * 83) % 420, 55, 22, 0, 0, 7); ctx.fill(); }
                }

                ctx.restore();
                if (type !== 'pool_tile') { const W = canvas.width; ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); // fine grain + soft edge grime so tiles stop looking flat
                  for (let i = 0; i < W * W / 110; i++) { ctx.fillStyle = Math.random() < 0.55 ? 'rgba(0,0,0,.07)' : 'rgba(255,255,255,.04)'; ctx.fillRect(Math.random() * W, Math.random() * W, 1 + Math.random() * 2, 1 + Math.random() * 2); }
                  const gr = ctx.createRadialGradient(W / 2, W / 2, W * 0.35, W / 2, W / 2, W * 0.75); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,.18)'); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, W);
                  for (let i = 0; i < 5; i++) { const sx = Math.random() * W, sy = Math.random() * W, sr = W * (0.05 + Math.random() * 0.12), sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, sr); sg.addColorStop(0, 'rgba(40,30,10,.10)'); sg.addColorStop(1, 'rgba(40,30,10,0)'); ctx.fillStyle = sg; ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2); }
                  ctx.strokeStyle = 'rgba(0,0,0,.10)'; ctx.lineWidth = Math.max(1, W / 512); for (let i = 0; i < 9; i++) { let cx = Math.random() * W, cy = Math.random() * W; ctx.beginPath(); ctx.moveTo(cx, cy); for (let k = 0; k < 4; k++) { cx += (Math.random() - 0.5) * W * 0.08; cy += (Math.random() - 0.3) * W * 0.08; ctx.lineTo(cx, cy); } ctx.stroke(); }
                  const u = W / 512; ctx.lineWidth = Math.max(1, u);
                  if (/wall|drywall/.test(type)) { for (let y = 32 * u; y < W; y += 64 * u) for (let x = 32 * u; x < W; x += 64 * u) { const dm = (ox, oy, st) => { ctx.strokeStyle = st; ctx.beginPath(); ctx.moveTo(x + ox, y - 12 * u + oy); ctx.lineTo(x + 8 * u + ox, y + oy); ctx.lineTo(x + ox, y + 12 * u + oy); ctx.lineTo(x - 8 * u + ox, y + oy); ctx.closePath(); ctx.stroke(); }; dm(2 * u, 2 * u, 'rgba(0,0,0,.14)'); dm(0, 0, 'rgba(255,255,255,.09)'); } }
                  else if (/carpet/.test(type)) { for (let i = 0; i < W; i += 4 * u) { ctx.strokeStyle = (i / u / 4) % 2 ? 'rgba(0,0,0,.07)' : 'rgba(255,255,255,.04)'; ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, W); ctx.moveTo(0, i); ctx.lineTo(W, i); ctx.stroke(); } }
                  else if (/concrete|brick|pipes|ducts|crate/.test(type)) { for (let i = 0; i < 140; i++) { const px = Math.random() * W, py = Math.random() * W, r = (1 + Math.random() * 2.5) * u; ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.beginPath(); ctx.arc(px, py, r, 0, 7); ctx.fill(); ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.beginPath(); ctx.arc(px - u, py - u, r * 0.7, 0, 7); ctx.fill(); } }
                  ctx.restore(); }

                const tex = new THREE.CanvasTexture(canvas);
                tex.colorSpace = THREE.SRGBColorSpace;
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.anisotropy = res >= 2048 ? 16 : (res >= 1024 ? 8 : (res >= 512 ? 4 : 1));
                tex.repeat.set(1, 1);
                if (['carpet', 'concrete', 'concrete_dark', 'office_carpet', 'hotel_carpet', 'inverted_floor', 'party_floor'].includes(type)) {
                    tex.repeat.set(16, 16);
                } else if (type === 'ceiling' || type === 'ducts' || type === 'pipes' || type === 'pool_sky') {
                    tex.repeat.set(18, 18);
                }
                
                this.cache[cacheKey] = tex;
                return tex;
            },

            // Procedural PBR Roughness Map for realistic light reflection & damp puddles
            createRoughness(type) {
                const res = Math.min(512, GameState.graphics.texSize || 256);
                const cacheKey = `${type}_${res}`;
                if (this.roughnessCache[cacheKey]) return this.roughnessCache[cacheKey];
                const canvas = document.createElement('canvas');
                canvas.width = res;
                canvas.height = res;
                const ctx = canvas.getContext('2d');
                ctx.scale(res / 256, res / 256);

                const isConcrete = type.includes('concrete') || type === 'inverted_floor';
                ctx.fillStyle = isConcrete ? '#b8b8b8' : '#dcdcdc';
                ctx.fillRect(0, 0, 256, 256);

                const patchCount = isConcrete ? 6 : 3;
                for (let p = 0; p < patchCount; p++) {
                    const px = 45 + (p * 45) % 170;
                    const py = 55 + (p * 57) % 160;
                    const grad = ctx.createRadialGradient(px, py, 4, px, py, isConcrete ? 38 : 28);
                    grad.addColorStop(0, isConcrete ? '#141414' : '#4a4a4a');
                    grad.addColorStop(1, isConcrete ? '#b8b8b8' : '#dcdcdc');
                    ctx.fillStyle = grad;
                    ctx.beginPath();
                    ctx.arc(px, py, isConcrete ? 38 : 28, 0, Math.PI * 2);
                    ctx.fill();
                }

                const tex = new THREE.CanvasTexture(canvas);
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                tex.repeat.set(16, 16);
                this.roughnessCache[cacheKey] = tex;
                return tex;
            }
        };

        // --- THREE.JS SCENE, RENDERER & REFLECTION ENVIRONMENT SETUP ---
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 100);
        let renderer = null;
        let webglContextLost = false;

        function createSafeRenderer() {
            const r = new THREE.WebGLRenderer({
                antialias: false,
                powerPreference: 'default',
                failIfMajorPerformanceCaveat: false
            });
            r.setSize(window.innerWidth, window.innerHeight);
            r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
            r.shadowMap.enabled = true;
            r.shadowMap.type = THREE.PCFSoftShadowMap;
            r.toneMapping = THREE.ACESFilmicToneMapping;
            r.toneMappingExposure = 1.25;
            r.outputColorSpace = THREE.SRGBColorSpace;

            r.domElement.addEventListener('webglcontextlost', (e) => {
                e.preventDefault();
                webglContextLost = true;
                GameState.isRunning = false;
                try { controls.unlock(); } catch (err) {}
                document.getElementById('ui-layer').style.display = 'none';
                document.getElementById('vhs-hud').style.display = 'none';
                document.getElementById('start-screen').style.display = 'flex';
                showMenuNotice('GPU context reset after heavy load. Switched to LOW graphics for stability.');
                selectGraphicsPreset('low');
            }, false);

            r.domElement.addEventListener('webglcontextrestored', () => {
                webglContextLost = false;
                TextureGen.clearCache();
                buildReflectionEnv();
                applyGraphicsSettings();
            }, false);

            return r;
        }

        renderer = createSafeRenderer();
        document.body.appendChild(renderer.domElement);

        function showMenuNotice(msg) {
            let notice = document.getElementById('gpu-recovery-notice');
            if (!notice) {
                notice = document.createElement('div');
                notice.id = 'gpu-recovery-notice';
                notice.style.cssText = 'margin-bottom:12px;padding:8px 14px;background:rgba(180,50,20,0.25);border:1px solid #ff7b54;color:#ffb499;border-radius:4px;font-size:12px;max-width:560px;';
                const summary = document.getElementById('active-config-summary');
                summary.parentNode.insertBefore(notice, summary);
            }
            notice.innerText = msg;
            notice.style.display = 'block';
        }

        let pmremEnvTexture = null;
        function buildReflectionEnv() {
            if (!renderer || webglContextLost) return;
            try {
                const pmrem = new THREE.PMREMGenerator(renderer);
                const envScene = new THREE.Scene();
                envScene.background = new THREE.Color(0x16140c);

                const stripMat = new THREE.MeshBasicMaterial({ color: 0xfff3c4 });
                for (let x = -12; x <= 12; x += 6) {
                    for (let z = -12; z <= 12; z += 6) {
                        const strip = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 1.0), stripMat);
                        strip.position.set(x, 6, z);
                        envScene.add(strip);
                    }
                }
                const wallReflectMat = new THREE.MeshBasicMaterial({ color: 0x3a3218, side: THREE.BackSide });
                const envBox = new THREE.Mesh(new THREE.BoxGeometry(30, 14, 30), wallReflectMat);
                envScene.add(envBox);

                const envRT = pmrem.fromScene(envScene, 0.04);
                pmremEnvTexture = envRT.texture;
                scene.environment = pmremEnvTexture;
                pmrem.dispose();
            } catch (e) {
                pmremEnvTexture = null;
            }
        }
        buildReflectionEnv();

        const controls = new PointerLockControls(camera, document.body);
        scene.add(controls.getObject());

        // --- Camera: pure yaw + pitch (no roll possible) ---
        // The built-in PointerLockControls rotation is switched off; we keep yaw/pitch as plain numbers
        // and build the camera rotation straight from them (roll is always exactly 0).
        controls.pointerSpeed = 0;
        camera.rotation.order = 'YXZ';
        const LOOK = { yaw: camera.rotation.y, pitch: camera.rotation.x, sens: 0.002, lim: Math.PI / 2 - 0.01 };
        function applyLook(dx, dy) {
            // pick up external resets (e.g. debug room reposition) before applying the new delta
            if (camera.rotation.y !== LOOK.yaw || camera.rotation.x !== LOOK.pitch) { LOOK.yaw = camera.rotation.y; LOOK.pitch = camera.rotation.x; }
            LOOK.yaw -= dx * LOOK.sens;
            LOOK.pitch = Math.max(-LOOK.lim, Math.min(LOOK.lim, LOOK.pitch - dy * LOOK.sens));
            camera.rotation.set(LOOK.pitch, LOOK.yaw, 0, 'YXZ');
        }
        document.addEventListener('mousemove', (e) => { if (!controls.isLocked) return; const mx = e.movementX || 0, my = e.movementY || 0; if (Math.abs(mx) > 500 || Math.abs(my) > 500) return; /* pointer-lock glitch: a single event this big is a bogus spike, not real hand movement */ applyLook(mx, my); });

        const ambientLight = new THREE.AmbientLight(0x3a331c, 0.28);
        scene.add(ambientLight);
        // Matte-surfaces fill: with reflections off there is no environment light, so add a flat 10% ambient.
        // It lives on the player object, so level rebuilds (which clear every other scene child) never remove it.
        const matteFill = new THREE.AmbientLight(0xffffff, 0.1);
        matteFill.visible = false;
        controls.getObject().add(matteFill);

        // Player Flashlight
        const flashLight = new THREE.SpotLight(0xfffaed, 4.2, 34, Math.PI / 4.8, 0.42, 1);
        flashLight.castShadow = true;
        flashLight.shadow.mapSize.width = 1024;
        flashLight.shadow.mapSize.height = 1024;
        flashLight.shadow.bias = -0.0005;
        camera.add(flashLight);
        flashLight.position.set(0.2, -0.2, 0);
        flashLight.target.position.set(0, -0.2, -5);
        camera.add(flashLight.target);

        // Ambient player light: very dim 10 m PointLight that trails the player (moved only after >=10 cm of travel)
        const playerAmbient = new THREE.PointLight(0x9aa0b8, 0.22, 10, 1.6); playerAmbient.userData.last = new THREE.Vector3(1e9, 0, 0);
        scene.add(playerAmbient);
        // Flashlight fog cut: fog is thinned inside the SpotLight cone (view-space uniforms shared by every fogged material)
        const FLFOG = { p: { value: new THREE.Vector4(0, 0, 0, 0) }, d: { value: new THREE.Vector3(0, 0, -1) } };
        try {
            THREE.ShaderChunk.fog_pars_vertex = THREE.ShaderChunk.fog_pars_vertex.replace('varying float vFogDepth;', 'varying float vFogDepth; varying vec3 vFogVPos;');
            THREE.ShaderChunk.fog_vertex = THREE.ShaderChunk.fog_vertex.replace('vFogDepth = - mvPosition.z;', 'vFogDepth = - mvPosition.z; vFogVPos = mvPosition.xyz;');
            THREE.ShaderChunk.fog_pars_fragment = THREE.ShaderChunk.fog_pars_fragment.replace('varying float vFogDepth;', 'varying float vFogDepth; varying vec3 vFogVPos; uniform vec4 uFlP; uniform vec3 uFlD; float flFogK(){ vec3 v = vFogVPos - uFlP.xyz; float d = length(v); float c = dot(v / max(d, 0.001), uFlD); return 1.0 - uFlP.w * smoothstep(0.82, 0.96, c) * (1.0 - smoothstep(2.0, 34.0, d)) * 0.7; }');
            THREE.ShaderChunk.fog_fragment = THREE.ShaderChunk.fog_fragment.replace('gl_FragColor.rgb = mix(', 'fogFactor *= flFogK(); gl_FragColor.rgb = mix(');
            if (THREE.ShaderChunk.fog_fragment.includes('flFogK')) THREE.Material.prototype.onBeforeCompile = function (sh) { sh.uniforms.uFlP = FLFOG.p; sh.uniforms.uFlD = FLFOG.d; };
        } catch (e) { console.warn('flashlight fog patch failed', e); }
        const _flV = new THREE.Vector3(), _flT = new THREE.Vector3();
        scene.onBeforeRender = (r, sc, cam) => { // keep cone uniforms in view space; strength 0 when the light is off
            const on = flashLight.visible && flashLight.intensity > 0;
            flashLight.getWorldPosition(_flV); flashLight.target.getWorldPosition(_flT); _flT.sub(_flV).normalize();
            _flV.applyMatrix4(cam.matrixWorldInverse); _flT.transformDirection(cam.matrixWorldInverse);
            FLFOG.p.value.set(_flV.x, _flV.y, _flV.z, on ? 1 : 0); FLFOG.d.value.copy(_flT);
        };

        // Path-Tracing Simulated Multi-Bounce Indirect Light attached to player view
        const pathTraceBounceLight = new THREE.PointLight(0xffe8a8, 0, 14, 1.8);
        pathTraceBounceLight.position.set(0, 0.2, -0.5);
        camera.add(pathTraceBounceLight);

        // ===== LAG FIX: stable light state =====
        // three.js bakes the NUMBER of visible lights / shadow casters into every lit material's shader. Toggling flashLight.visible therefore
        // recompiled every material in the scene the first time you pressed F. The flashlight is now ALWAYS a visible light as far as the
        // renderer is concerned; "off" is rendered as intensity 0 with its shadow pass skipped. Game code keeps reading/writing .visible as before.
        const FLG = { vis: true, rendering: false, hold: false, holdT: 0, warmDone: null };
        Object.defineProperty(flashLight, 'visible', { configurable: true, enumerable: true, get() { return FLG.rendering ? true : FLG.vis; }, set(v) { FLG.vis = !!v; } });
        {
            const _render = renderer.render.bind(renderer);
            renderer.render = function (s, c) {
                if (s !== scene) return _render(s, c);
                if (FLG.hold) { if (performance.now() - FLG.holdT < 6000) return; FLG.hold = false; } // freeze the last frame while shaders compile off-thread (6 s safety valve)
                if (GameState._needWarm) { GameState._needWarm = false; if (startWarmHold()) return; }
                const off = !FLG.vis, I = flashLight.intensity; FLG.rendering = true;
                if (off) flashLight.intensity = 0;
                const sh = flashLight.shadow; if (sh) sh.autoUpdate = !off;
                try { return _render(s, c); } finally { FLG.rendering = false; if (off) flashLight.intensity = I; }
            };
        }
        // Compile every material in the freshly built scene (plus a hidden set of items / ghost materials) with the REAL light state before the first frame is drawn.
        function startWarmHold() {
            if (typeof renderer.compileAsync !== 'function' || !GameState.isRunning && !GameState.inShop && !GameState.debugRoom) { const f = GameState.onWarm; GameState.onWarm = null; if (f) f(); return false; }
            FLG.hold = true; FLG.holdT = performance.now();
            const g = new THREE.Group(); g.position.set(0, -80, 0);
            try { warmExtras(g); } catch (e) {}
            scene.add(g);
            const fin = () => { try { scene.remove(g); g.traverse(o => { if (o.geometry && o.geometry.dispose && !o.userData.keepGeo) o.geometry.dispose(); }); } catch (e) {} FLG.hold = false; const f = GameState.onWarm; GameState.onWarm = null; if (f) f(); };
            let doneOnce = false; const once = () => { if (doneOnce) return; doneOnce = true; fin(); };
            try { renderer.compileAsync(scene, camera).then(once, once); } catch (e) { once(); }
            setTimeout(once, 5500);
            return true;
        }
        // Things whose shader variants would otherwise compile the first time they appear in play: ghost (transparent) avatars/corpses, item and chest models.
        function warmExtras(g) {
            const T = { transparent: true, opacity: 0.38, roughness: 0.7, depthWrite: false };
            [{ color: 0x3a3328 }, { color: 0xd9c3a0 }].forEach(o => { const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), new THREE.MeshStandardMaterial(Object.assign({ emissive: 0x2a4a88 }, T, o))); g.add(m); });
            [...new Set([...Object.keys(FLOOR_Y), 'axe', 'crowbar', 'tracker', 'chest_locator'])].forEach(id => { try { g.add(buildItemModel(id)); } catch (e) {} });
            try { g.add(buildChestModel().group); g.add(buildCrateModel(1.1)); } catch (e) {}
            if (typeof pickupGlowSprite === 'function') { try { g.add(pickupGlowSprite()); } catch (e) {} }
        }

        // Apply Graphics Settings Dynamically to Renderer, Shadows, Reflections & Lighting
        function applyGraphicsSettings() {
            if (!renderer || webglContextLost) return;
            const gfx = GameState.graphics;
            const gl = renderer.getContext();
            const maxHwTex = gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048) : 2048;

            // 1. Resolution Scale (clamped to prevent massive backbuffer allocations on Chromebooks/iGPUs)
            const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
            const safeScale = Math.min(gfx.resScale, maxHwTex <= 4096 ? 1.25 : 2.0);
            renderer.setPixelRatio(Math.max(0.35, dpr * safeScale));
            renderer.setSize(window.innerWidth, window.innerHeight);

            // 2. Tone Mapping & Anti-Aliasing Mode
            if (gfx.aa === 'off') {
                renderer.toneMapping = THREE.NoToneMapping;
                renderer.toneMappingExposure = 1.05;
            } else if (gfx.aa === 'standard') {
                renderer.toneMapping = THREE.ReinhardToneMapping;
                renderer.toneMappingExposure = 1.3;
            } else {
                renderer.toneMapping = THREE.ACESFilmicToneMapping;
                renderer.toneMappingExposure = gfx.rtMode === 'pathtracing' ? 1.38 : 1.25;
            }

            // 3. Shadow Map Resolution (clamped to safe hardware limit)
            const safeShadowSize = Math.min(gfx.shadowSize, maxHwTex >= 8192 ? 4096 : 2048);
            if (safeShadowSize === 0) {
                renderer.shadowMap.enabled = false;
                flashLight.castShadow = false;
            } else {
                renderer.shadowMap.enabled = true;
                renderer.shadowMap.type = safeShadowSize >= 2048 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
                flashLight.castShadow = true;
                if (flashLight.shadow.mapSize.width !== safeShadowSize) {
                    flashLight.shadow.mapSize.width = safeShadowSize;
                    flashLight.shadow.mapSize.height = safeShadowSize;
                    if (flashLight.shadow.map) {
                        flashLight.shadow.map.dispose();
                        flashLight.shadow.map = null;
                    }
                }
            }
            renderer.shadowMap.needsUpdate = true;

            // 4. Environment Reflections
            scene.environment = gfx.reflections === 'off' ? null : pmremEnvTexture;
            matteFill.visible = gfx.reflections === 'off';

            // 5. Path Tracing Indirect Bounce Light
            pathTraceBounceLight.intensity = gfx.rtMode === 'pathtracing' ? 0.85 : (gfx.rtMode === 'raytracing' ? 0.35 : 0);

            // 6. VHS Scanline Overlay
            { const _v = gfx.vhsFx === 'on' || window.realMode === true; document.getElementById('vhs-scanlines').style.display = _v ? 'block' : 'none'; document.body.classList.toggle('vhs-on', _v); }
            if (window.menuGfxHook) { try { window.menuGfxHook(); } catch (e) {} }
            if (renderer.__gfxReady) GameState._needWarm = true; // changed tone mapping / lights / shadows: recompile off-thread, then resume drawing
            renderer.__gfxReady = true;
        }

        // ===== Shared item models: the SAME model is used on the floor, when dropped, and in your hand =====
        function buildItemModel(type) {
            const g = new THREE.Group(), PI = Math.PI;
            const M = (c, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.5 }, o));
            const add = (geo, mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); g.add(m); return m; };
            const Cy = (a, b, h, sg = 14) => new THREE.CylinderGeometry(a, b, h, sg), Bx = (w, h, d) => new THREE.BoxGeometry(w, h, d), Sp = (r, sg = 12) => new THREE.SphereGeometry(r, sg, sg);
            const metal = () => M(0x22252a, { metalness: 0.85, roughness: 0.25 }), wood = () => M(0x5c3317, { roughness: 0.65 }), glass = (o = 0.55) => M(0xdff4ff, { transparent: true, opacity: o, roughness: 0.1, metalness: 0.1 });
            switch (type) {
                case 'coin': add(Cy(0.22, 0.22, 0.05, 20), M(0xffc83d, { emissive: 0x6b4a00, metalness: 0.9, roughness: 0.25 }), 0, 0, 0, PI / 2); add(Cy(0.165, 0.165, 0.056, 20), M(0xe0a020, { emissive: 0x553300, metalness: 0.9, roughness: 0.35 }), 0, 0, 0, PI / 2); break;
                case 'water':
                    add(Cy(0.125, 0.13, 0.3), glass(0.8), 0, -0.04, 0); add(Cy(0.05, 0.12, 0.08), glass(0.8), 0, 0.15, 0); add(Cy(0.05, 0.05, 0.06), glass(0.8), 0, 0.21, 0);
                    add(Cy(0.1, 0.1, 0.22), M(0x55aaff, { emissive: 0x113366, emissiveIntensity: 0.6, transparent: true, opacity: 0.75 }), 0, -0.08, 0);
                    add(Cy(0.133, 0.133, 0.13), M(0xf3e3c0, { roughness: 0.85 }), 0, -0.02, 0); add(Cy(0.058, 0.058, 0.04), M(0x2a6fd6), 0, 0.255, 0); break;
                case 'battery':
                    add(Cy(0.09, 0.09, 0.3), M(0xffcc00, { metalness: 0.5, roughness: 0.35, emissive: 0x443300 })); add(Cy(0.0925, 0.0925, 0.08), M(0x111111), 0, -0.05, 0);
                    add(Cy(0.035, 0.035, 0.04, 10), M(0xcccccc, { metalness: 0.9, roughness: 0.2 }), 0, 0.17, 0); add(Cy(0.094, 0.094, 0.03), M(0x888888, { metalness: 0.9, roughness: 0.3 }), 0, -0.14, 0); break;
                case 'shotgun':
                    add(Cy(0.024, 0.026, 0.65, 10), metal(), 0, 0.02, -0.35, PI / 2); add(Cy(0.02, 0.02, 0.52, 10), metal(), 0, -0.015, -0.3, PI / 2);
                    add(Cy(0.032, 0.032, 0.22, 10), wood(), 0, -0.015, -0.32, PI / 2); add(Bx(0.06, 0.08, 0.24), metal(), 0, 0.005, -0.05);
                    add(Bx(0.05, 0.1, 0.26), wood(), 0, -0.03, 0.16, -0.12); add(Bx(0.025, 0.07, 0.04), wood(), 0, -0.06, 0.02, 0.3); break;
                case 'shell':
                    add(Cy(0.06, 0.06, 0.12, 12), M(0xcc2222, { emissive: 0x551111, roughness: 0.5 }), -0.02, 0, 0, 0, 0, PI / 2); add(Cy(0.063, 0.063, 0.045, 12), M(0xd4a73a, { metalness: 0.9, roughness: 0.3 }), 0.05, 0, 0, 0, 0, PI / 2);
                    add(Cy(0.025, 0.025, 0.01, 10), M(0x8a6a20, { metalness: 0.9 }), 0.077, 0, 0, 0, 0, PI / 2); add(Cy(0.045, 0.06, 0.02, 12), M(0xaa1c1c), -0.085, 0, 0, 0, 0, PI / 2); break;
                case 'ammo_crate':
                    add(Bx(0.6, 0.3, 0.4), M(0x3a5a2a, { emissive: 0x1a3a10, emissiveIntensity: 0.8, roughness: 0.6 }), 0, -0.02, 0); add(Bx(0.62, 0.06, 0.42), M(0x2f4a22, { emissive: 0x112a0a, roughness: 0.6 }), 0, 0.16, 0);
                    [-0.2, 0.2].forEach(x => add(Bx(0.04, 0.32, 0.42), M(0x222222, { metalness: 0.7, roughness: 0.4 }), x, -0.02, 0));
                    add(new THREE.TorusGeometry(0.07, 0.012, 6, 12, PI), M(0x999999, { metalness: 0.9, roughness: 0.3 }), 0, 0.19, 0);
                    [0.205, -0.205].forEach(z => add(Bx(0.3, 0.05, 0.01), M(0xe6c84c, { emissive: 0x443300 }), 0, 0, z)); break;
                case 'cake':
                    add(Cy(0.26, 0.26, 0.02, 20), M(0xf2f2f2, { metalness: 0.2, roughness: 0.4 }), 0, -0.11, 0); add(Cy(0.22, 0.22, 0.13, 20), M(0xff8ad8, { emissive: 0x551a44, roughness: 0.6 }), 0, -0.03, 0);
                    add(Cy(0.226, 0.226, 0.025, 20), M(0xfff2f8), 0, 0.04, 0); add(Cy(0.16, 0.16, 0.1, 20), M(0xffb0e8, { emissive: 0x552244, roughness: 0.6 }), 0, 0.1, 0); add(Cy(0.166, 0.166, 0.025, 20), M(0xfff2f8), 0, 0.16, 0);
                    for (let i = 0; i < 5; i++) { const a = i / 5 * PI * 2; add(Sp(0.03, 8), M(0xd8203a, { emissive: 0x440000, roughness: 0.3 }), Math.cos(a) * 0.11, 0.19, Math.sin(a) * 0.11); }
                    add(Cy(0.012, 0.012, 0.12, 8), M(0xfff6a0), 0, 0.24, 0); add(Sp(0.026, 8), new THREE.MeshBasicMaterial({ color: 0xffcc44 }), 0, 0.32, 0).scale.y = 1.7; break;
                case 'lucid_pill': {
                    const a = M(0x66ccff, { emissive: 0x2288cc, emissiveIntensity: 0.8, roughness: 0.3 }), b = M(0xf4faff, { emissive: 0x335566, emissiveIntensity: 0.3, roughness: 0.3 });
                    add(Cy(0.07, 0.07, 0.14, 16), a, -0.07, 0, 0, 0, 0, PI / 2); add(Sp(0.07, 16), a, -0.14, 0, 0); add(Cy(0.07, 0.07, 0.14, 16), b, 0.07, 0, 0, 0, 0, PI / 2); add(Sp(0.07, 16), b, 0.14, 0, 0);
                    add(Cy(0.0715, 0.0715, 0.012, 16), M(0x223344), 0, 0, 0, 0, 0, PI / 2); g.scale.setScalar(1.3); break; }
                case 'battery_core':
                    add(Cy(0.1, 0.1, 0.34, 18), M(0xaaffee, { transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0.2 })); add(Cy(0.065, 0.065, 0.3, 14), M(0x33ff88, { emissive: 0x22ff77, emissiveIntensity: 1.6 }));
                    [0.19, -0.19].forEach(y => add(Cy(0.115, 0.115, 0.04, 18), M(0x333b44, { metalness: 0.9, roughness: 0.3 }), 0, y, 0)); [0.07, -0.07].forEach(y => add(Cy(0.105, 0.105, 0.015, 18), M(0x888f99, { metalness: 0.9, roughness: 0.3 }), 0, y, 0));
                    add(Cy(0.03, 0.03, 0.04, 10), M(0xcccccc, { metalness: 0.9, roughness: 0.2 }), 0, 0.23, 0); break;
                case 'sprint_tonic':
                    add(Sp(0.13, 16), glass(0.5), 0, -0.05, 0); add(Sp(0.11, 16), M(0xffe14a, { emissive: 0xffc800, emissiveIntensity: 1.0 }), 0, -0.07, 0); add(Cy(0.04, 0.05, 0.16, 12), glass(0.5), 0, 0.1, 0); add(Cy(0.045, 0.04, 0.05, 10), M(0x8b5a2b), 0, 0.2, 0);
                    add(Bx(0.03, 0.09, 0.01), M(0xff8800, { emissive: 0xff6600 }), 0.01, -0.02, 0.125, 0, 0, 0.5); add(Bx(0.03, 0.09, 0.01), M(0xff8800, { emissive: 0xff6600 }), -0.01, -0.1, 0.125, 0, 0, 0.5); break;
                case 'tracker': {
                    add(Bx(0.2, 0.3, 0.06), M(0x2b2f33, { metalness: 0.5, roughness: 0.45 })); add(Bx(0.15, 0.11, 0.01), M(0x0a2a14, { emissive: 0x33ff66, emissiveIntensity: 0.9 }), 0, 0.05, 0.036);
                    const mb = new THREE.MeshBasicMaterial({ color: 0x9fff9f }); add(new THREE.RingGeometry(0.02, 0.024, 20), mb, 0, 0.05, 0.042); add(Sp(0.01, 8), mb, 0.025, 0.065, 0.043); add(Sp(0.01, 8), mb, -0.03, 0.03, 0.043);
                    add(Cy(0.008, 0.008, 0.2, 6), M(0x999999, { metalness: 0.9 }), 0.08, 0.24, 0); add(Sp(0.014, 8), M(0xff2a2a, { emissive: 0xff0000 }), 0.08, 0.34, 0);
                    [[-0.05, 0xcc3333], [0, 0x3366cc], [0.05, 0xcccc33]].forEach(([x, c]) => add(Cy(0.018, 0.018, 0.012, 10), M(c), x, -0.09, 0.036, PI / 2)); break; }
                case 'clock': {
                    add(Cy(0.2, 0.2, 0.12, 22), M(0xcc2222, { emissive: 0x551111, emissiveIntensity: 0.8 }), 0, 0, 0, PI / 2); add(Cy(0.165, 0.165, 0.01, 22), M(0xfff6e0), 0, 0, 0.062, PI / 2);
                    const k = new THREE.MeshBasicMaterial({ color: 0x111111 }); for (let i = 0; i < 12; i++) { const a = i / 12 * PI * 2; add(Bx(0.01, i % 3 ? 0.02 : 0.035, 0.004), k, Math.sin(a) * 0.135, Math.cos(a) * 0.135, 0.069, 0, 0, -a); }
                    add(Bx(0.012, 0.1, 0.006), k, 0, 0.05, 0.072); add(Bx(0.01, 0.075, 0.006), k, 0.03, 0.0, 0.074, 0, 0, -PI / 2 + 0.4); add(Sp(0.013, 8), k, 0, 0, 0.074);
                    [-0.12, 0.12].forEach(x => add(new THREE.SphereGeometry(0.07, 14, 8, 0, PI * 2, 0, PI / 2), M(0xd8b04a, { metalness: 0.9, roughness: 0.3 }), x, 0.185, 0, 0, 0, x < 0 ? 0.5 : -0.5));
                    add(Cy(0.006, 0.006, 0.13, 6), M(0x888888, { metalness: 0.9 }), 0, 0.23, 0, 0, 0, PI / 2); [-0.1, 0.1].forEach(x => add(Cy(0.012, 0.02, 0.07, 6), M(0x333333), x, -0.2, 0, 0, 0, x < 0 ? 0.35 : -0.35)); break; }
                case 'crowbar': { const iron = M(0x8b1a1a, { metalness: 0.7, roughness: 0.35 }), dark = M(0x2a2a2e, { metalness: 0.85, roughness: 0.3 });
                    add(Cy(0.016, 0.016, 0.62, 10), iron, 0, 0, -0.17, PI / 2); add(Cy(0.02, 0.02, 0.05, 10), dark, 0, 0, 0.16, PI / 2);
                    add(new THREE.TorusGeometry(0.06, 0.016, 8, 14, PI * 0.9), iron, 0, 0.055, -0.5, 0, 0, PI * 0.55).rotation.y = PI / 2; add(Bx(0.035, 0.012, 0.09), dark, 0, 0.1, -0.56, 0.3); add(Bx(0.028, 0.014, 0.07), dark, 0, 0.0, 0.2); break; }
                case 'axe': { // classic woodcutter's axe: long wooden haft along Z, steel head at the front (-Z): flared cutting blade out to -X, blunt poll behind the eye at +X
                    const steel = M(0xaeb3ba, { metalness: 0.9, roughness: 0.26 }), iron = M(0x3a3e44, { metalness: 0.8, roughness: 0.4 }), hnd = M(0x6a4121, { roughness: 0.7 }), grip = M(0x2b1a0e, { roughness: 0.92 });
                    add(Cy(0.022, 0.019, 0.82, 10), hnd, 0, 0, -0.05, PI / 2);          // haft (z -0.46 .. +0.36)
                    add(Cy(0.029, 0.029, 0.22, 10), grip, 0, 0, 0.23, PI / 2);          // wrapped grip
                    add(Sp(0.036, 10), grip, 0, 0, 0.365).scale.z = 0.75;               // butt knob
                    add(Bx(0.1, 0.09, 0.15), iron, 0, 0, -0.4);                         // eye: the block the haft passes through
                    add(Bx(0.075, 0.062, 0.105), iron, 0.087, 0, -0.4);                 // poll (blunt back of the head)
                    const V = [[-0.05, 0.04, -0.47], [-0.05, 0.04, -0.33], [-0.05, -0.04, -0.33], [-0.05, -0.04, -0.47], [-0.3, 0, -0.6], [-0.3, 0, -0.2]], T = [[0, 5, 4], [0, 1, 5], [3, 4, 5], [3, 5, 2], [0, 4, 3], [1, 2, 5]], pos = [];
                    T.forEach(t => t.forEach(i => pos.push(...V[i]))); const bg = new THREE.BufferGeometry(); bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); bg.computeVertexNormals();
                    add(bg, new THREE.MeshStandardMaterial({ color: 0xaeb3ba, metalness: 0.9, roughness: 0.26, side: THREE.DoubleSide })); // flared wedge blade
                    add(Bx(0.012, 0.016, 0.4), M(0xe8ecf0, { metalness: 1, roughness: 0.15 }), -0.3, 0, -0.4); // bright sharpened edge
                    add(Cy(0.03, 0.03, 0.03, 10), steel, 0, 0, -0.27, PI / 2);          // steel ferrule below the head
                    break; }
                case 'grenade': { // frag grenade: olive ridged body, brass fuse head, spoon lever and pull-ring
                    const body = M(0x4b5a2b, { roughness: 0.55, metalness: 0.35 }), dark = M(0x2a301a, { roughness: 0.6, metalness: 0.4 }), brass = M(0xb08d3a, { metalness: 0.9, roughness: 0.3 }), spoon = M(0x7d8590, { metalness: 0.85, roughness: 0.35 });
                    add(Sp(0.075, 16), body).scale.y = 1.18;
                    [[-0.045, 0.0646], [0, 0.075], [0.045, 0.0646]].forEach(([y, r]) => add(new THREE.TorusGeometry(r, 0.006, 6, 20), dark, 0, y, 0, PI / 2));
                    add(Cy(0.032, 0.042, 0.035, 12), dark, 0, 0.098, 0); add(Cy(0.026, 0.026, 0.045, 10), brass, 0, 0.135, 0);
                    add(Bx(0.014, 0.16, 0.036), spoon, 0.071, 0.045, 0, 0, 0, -0.22); add(Cy(0.011, 0.011, 0.06, 8), brass, 0.02, 0.152, 0, 0, 0, PI / 2);
                    add(new THREE.TorusGeometry(0.028, 0.004, 6, 14), brass, -0.012, 0.17, 0, 0, PI / 2, 0); break; }
                case 'chest_locator': { // brass compass with a green arrow needle
                    add(Cy(0.11, 0.11, 0.04, 24), M(0xb88a2e, { metalness: 0.85, roughness: 0.3 }), 0, 0, 0, PI / 2); add(Cy(0.095, 0.095, 0.012, 24), M(0x10201a, { emissive: 0x0a2a1c, roughness: 0.4 }), 0, 0, 0.024, PI / 2);
                    add(Bx(0.012, 0.075, 0.006), M(0x44ff88, { emissive: 0x22cc66, emissiveIntensity: 1.4 }), 0, 0.03, 0.034); add(new THREE.ConeGeometry(0.028, 0.05, 10), M(0x44ff88, { emissive: 0x22cc66, emissiveIntensity: 1.4 }), 0, 0.085, 0.034);
                    add(Bx(0.012, 0.05, 0.006), M(0xcc3322), 0, -0.04, 0.034); add(Cy(0.012, 0.012, 0.06, 8), M(0xd9a82c, { metalness: 0.9, roughness: 0.3 }), 0, 0.13, 0, PI / 2); break; }
                case 'mega_battery':
                    add(Cy(0.14, 0.14, 0.45, 20), M(0x1b2a38, { metalness: 0.6, roughness: 0.35 })); add(Cy(0.145, 0.145, 0.07, 20), M(0xffcc00, { emissive: 0x553300, metalness: 0.6 }), 0, 0.12, 0); add(Cy(0.145, 0.145, 0.07, 20), M(0xffcc00, { emissive: 0x553300, metalness: 0.6 }), 0, -0.12, 0);
                    add(Cy(0.1, 0.1, 0.16, 18), M(0x44ffee, { emissive: 0x22ddcc, emissiveIntensity: 1.6 }), 0, 0, 0); add(Cy(0.055, 0.055, 0.07, 12), M(0xcccccc, { metalness: 0.9, roughness: 0.2 }), 0, 0.26, 0);
                    add(Bx(0.05, 0.2, 0.012), M(0xffcc00, { emissive: 0x886600 }), 0, 0, 0.142, 0, 0, 0.3); break;
                case 'reality_shard': add(new THREE.OctahedronGeometry(0.14), M(0xb36bff, { emissive: 0x7a2cff, emissiveIntensity: 1.4, transparent: true, opacity: 0.9, roughness: 0.15, metalness: 0.3 })).scale.y = 1.7; add(new THREE.OctahedronGeometry(0.075), M(0xffffff, { emissive: 0xffffff, emissiveIntensity: 1 })).scale.y = 1.7; break;
                default: add(Bx(0.35, 0.12, 0.22), M(0x1c2a1c, { emissive: 0xaa1111, emissiveIntensity: 0.9, roughness: 0.4 }));
            }
            if (MODELS[type]) { // user-supplied static GLB replaces this model
                loadBase64Model(MODELS[type]).then(m => { if (!m) return; console.info('MODELS: replaced "' + type + '"'); replaceContents(g, m); }).catch(e => console.warn('MODELS: failed to load "' + type + '"', e));
            }
            return g;
        }
        const FLOOR_Y = { coin: 0.7, clock: 0.5, shell: 0.4, ammo_crate: 0.4, cake: 0.55, water: 0.34, battery: 0.3, shotgun: 0.45, lucid_pill: 0.5, battery_core: 0.45, sprint_tonic: 0.45, tracker: 0.5, chest_locator: 0.4, crowbar: 0.4, axe: 0.45, grenade: 0.12, mega_battery: 0.45, reality_shard: 0.5 };
        const HELD_XF = { water: [0.22, -0.2, -0.42, 0.15, -0.5, 0.1, 0.85], battery: [0.22, -0.19, -0.38, 0.2, -0.3, 0.1, 1], cake: [0.2, -0.24, -0.46, 0.3, 0, 0, 0.8], lucid_pill: [0.2, -0.18, -0.34, 0, 0.3, 0.4, 1],
            battery_core: [0.22, -0.2, -0.4, 0.2, -0.4, 0, 1], sprint_tonic: [0.22, -0.2, -0.4, 0.15, -0.3, 0.1, 1], tracker: [0.2, -0.2, -0.38, -0.45, 0.15, 0, 1], clock: [0.2, -0.2, -0.42, 0.1, 0.1, 0, 0.9], chest_locator: [0.2, -0.2, -0.4, 0.15, 0.1, 0, 1.1], mega_battery: [0.22, -0.2, -0.42, 0.2, -0.3, 0, 0.9], crowbar: [0.22, -0.2, -0.5, 0.15, 0.5, 0, 1], axe: [0.22, -0.18, -0.52, 0.15, 0.5, 0, 1], grenade: [0.2, -0.2, -0.42, 0.1, 0.3, 0, 1.2], reality_shard: [0.2, -0.2, -0.4, 0.2, 0.4, 0, 1] };
        const heldGroup = new THREE.Group(); let heldId = null;
        function setHeldModel(id) {
            if (id === heldId) return; heldId = id; while (heldGroup.children.length) heldGroup.remove(heldGroup.children[0]);
            const xf = id && HELD_XF[id]; if (!xf) return;
            const m = buildItemModel(id); m.position.set(xf[0], xf[1], xf[2]); m.rotation.set(xf[3], xf[4], xf[5]); m.scale.multiplyScalar(xf[6]); m.userData.baseY = xf[1]; heldGroup.add(m);
        }

        // First-Person Viewmodel Shotgun (shown when picked up in Extreme mode)
        const shotgunViewGroup = buildItemModel('shotgun');
        shotgunViewGroup.position.set(0.28, -0.24, -0.25);
        shotgunViewGroup.visible = false;
        camera.add(shotgunViewGroup); camera.add(heldGroup);

        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            renderer.setPixelRatio(Math.max(0.35, dpr * (GameState.graphics.resScale || 1.0)));
            renderer.setSize(window.innerWidth, window.innerHeight);
        });

        // --- MAZE GENERATOR ---
        function generateMaze(size) {
            const grid = Array.from({ length: size }, () => Array(size).fill(1));
            function carve(x, y) {
                grid[y][x] = 0;
                const dirs = [[0, -2], [2, 0], [0, 2], [-2, 0]].sort(() => Math.random() - 0.5);
                for (const [dx, dy] of dirs) {
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx > 0 && nx < size - 1 && ny > 0 && ny < size - 1 && grid[ny][nx] === 1) {
                        grid[y + dy / 2][x + dx / 2] = 0;
                        carve(nx, ny);
                    }
                }
            }
            carve(1, 1);

            for (let i = 0; i < 24; i++) {
                const rx = Math.floor(Math.random() * (size - 10)) + 3;
                const ry = Math.floor(Math.random() * (size - 10)) + 3;
                const rw = Math.floor(Math.random() * 5) + 4;
                const rh = Math.floor(Math.random() * 5) + 4;
                for (let y = ry; y < ry + rh; y++) {
                    for (let x = rx; x < rx + rw; x++) {
                        if (y < size - 1 && x < size - 1) {
                            grid[y][x] = (x % 2 === 0 && y % 2 === 0 && Math.random() < 0.3) ? 1 : 0;
                        }
                    }
                }
            }
            for (let y = 1; y <= 3; y++) {
                for (let x = 1; x <= 3; x++) {
                    grid[y][x] = 0;
                }
            }
            return grid;
        }

        // --- LAYOUT DISPATCHER: each level picks a distinct generator via LevelData[].layout ---
        function generateLayout(data, size) {
            let grid;
            switch (data.layout) {
                case 'habitable': grid = generateHabitable(size); break;
                case 'tunnels': grid = generateTunnels(size); break;
                case 'rooms': grid = generateOfficeRooms(size); break;
                case 'hotel': grid = generateHotelFloor(size); break;
                case 'party_dense': grid = generatePartyMaze(size); break;
                case 'thalasso': grid = generateThalassoLayout(size); break;
                case 'attraction': grid = generateAttractionLayout(size); break;
                case 'haven': grid = Array.from({ length: size }, () => Array(size).fill(0)); break;
                case 'pools': grid = generatePoolsLayout(size); break;
                default: grid = generateMaze(size); break;
            }
            for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) grid[y][x] = 0; // guarantee a clear spawn, whatever the layout did
            return grid;
        }

        // A pure randomized-DFS labyrinth with no carved-out open rooms: tight, winding 1-wide tunnels only.
        function generateTunnels(size) {
            const grid = Array.from({ length: size }, () => Array(size).fill(1));
            (function carve(x, y) {
                grid[y][x] = 0;
                const dirs = [[0, -2], [2, 0], [0, 2], [-2, 0]].sort(() => Math.random() - 0.5);
                for (const [dx, dy] of dirs) {
                    const nx = x + dx, ny = y + dy;
                    if (nx > 0 && nx < size - 1 && ny > 0 && ny < size - 1 && grid[ny][nx] === 1) { grid[y + dy / 2][x + dx / 2] = 0; carve(nx, ny); }
                }
            })(1, 1);
            return grid;
        }

        // Habitable Zone: one large open warehouse core (with a few support pillars), ringed by an outer band of
        // random branching hallways that run off into small dead-end rooms right at the outskirts.
        function generateHabitable(size) {
            const grid = Array.from({ length: size }, () => Array(size).fill(1));
            const m = Math.max(4, Math.floor(size * 0.26)), lo = m, hi = size - m; // core bounds
            for (let y = lo; y < hi; y++) for (let x = lo; x < hi; x++) grid[y][x] = 0;
            for (let i = 0; i < Math.floor((hi - lo) * (hi - lo) / 30); i++) { // scattered support pillars in the open core
                const x = lo + 2 + Math.floor(Math.random() * (hi - lo - 4)), y = lo + 2 + Math.floor(Math.random() * (hi - lo - 4));
                if (x % 2 === 0 && y % 2 === 0) grid[y][x] = 1;
            }
            function carve(x, y) {
                grid[y][x] = 0;
                const dirs = [[0, -2], [2, 0], [0, 2], [-2, 0]].sort(() => Math.random() - 0.5);
                for (const [dx, dy] of dirs) {
                    const nx = x + dx, ny = y + dy;
                    if (nx > 0 && nx < size - 1 && ny > 0 && ny < size - 1 && grid[ny][nx] === 1 && !(nx >= lo && nx < hi && ny >= lo && ny < hi)) {
                        grid[y + dy / 2][x + dx / 2] = 0; carve(nx, ny);
                    }
                }
            }
            const seeds = []; // points just outside the core's four edges, each starting its own branching hallway
            for (let x = lo + 1; x < hi - 1; x += 4) { seeds.push([x, lo - 2]); seeds.push([x, hi + 1]); }
            for (let y = lo + 1; y < hi - 1; y += 4) { seeds.push([lo - 2, y]); seeds.push([hi + 1, y]); }
            seeds.sort(() => Math.random() - 0.5);
            for (const [sx, sy] of seeds) {
                if (sx <= 0 || sx >= size - 1 || sy <= 0 || sy >= size - 1 || grid[sy][sx] === 0) continue;
                if (Math.random() < 0.55) continue; // not every edge point spawns a hallway - keeps some core walls intact
                carve(sx, sy);
            }
            for (let i = 0; i < 10; i++) { // small dead-end rooms out in the band, near the outer border
                const rx = 2 + Math.floor(Math.random() * (size - 8)), ry = 2 + Math.floor(Math.random() * (size - 8));
                if (rx >= lo && rx < hi && ry >= lo && ry < hi) continue;
                const rw = 2 + Math.floor(Math.random() * 3), rh = 2 + Math.floor(Math.random() * 3);
                for (let y = ry; y < ry + rh && y < size - 1; y++) for (let x = rx; x < rx + rw && x < size - 1; x++) if (x > 0 && y > 0) grid[y][x] = 0;
            }
            return grid;
        }

        // Abandoned Office: a regular lattice of corridors with closed rectangular cubicle rooms (each with its own
        // door gap) between them, instead of an organic maze.
        function generateOfficeRooms(size) {
            const grid = Array.from({ length: size }, () => Array(size).fill(1));
            const block = 6;
            for (let z = 1; z < size - 1; z++) for (let x = 1; x < size - 1; x++) if (x % block === 0 || z % block === 0) grid[z][x] = 0; // corridor lattice
            for (let bz = 1; bz < size - 1; bz += block) {
                for (let bx = 1; bx < size - 1; bx += block) {
                    const rx = bx + 1, rz = bz + 1, rw = Math.min(block - 2, size - 2 - rx), rh = Math.min(block - 2, size - 2 - rz);
                    if (rw < 2 || rh < 2) continue;
                    for (let y = rz; y < rz + rh; y++) for (let x = rx; x < rx + rw; x++) grid[y][x] = 0; // cubicle interior
                    const edges = []; // perimeter wall cells this room could open a door through
                    for (let x = rx; x < rx + rw; x++) { edges.push([x, rz - 1]); edges.push([x, rz + rh]); }
                    for (let y = rz; y < rz + rh; y++) { edges.push([rx - 1, y]); edges.push([rx + rw, y]); }
                    for (let d = 0; d < 1 + (Math.random() < 0.4 ? 1 : 0); d++) {
                        const [dx, dz] = edges[Math.floor(Math.random() * edges.length)];
                        if (dx > 0 && dx < size - 1 && dz > 0 && dz < size - 1) grid[dz][dx] = 0;
                    }
                    for (let x = rx; x < rx + rw; x++) { grid[rz - 1][x] = grid[rz - 1][x] === 0 ? 0 : 1; grid[rz + rh][x] = grid[rz + rh][x] === 0 ? 0 : 1; }
                    for (let y = rz; y < rz + rh; y++) { grid[y][rx - 1] = grid[y][rx - 1] === 0 ? 0 : 1; grid[y][rx + rw] = grid[y][rx + rw] === 0 ? 0 : 1; }
                }
            }
            return grid;
        }

        // Terror Hotel: long straight parallel corridors (a hotel floor) with small rooms off each side, tied
        // together by a few perpendicular cross-corridors.
        function generateHotelFloor(size) {
            const grid = Array.from({ length: size }, () => Array(size).fill(1));
            const spacing = 5, rooms = [];
            for (let z = 1; z < size - 1; z += spacing) for (let x = 1; x < size - 1; x++) grid[z][x] = 0; // horizontal corridors
            for (let x = 1; x < size - 1; x += Math.floor(size / 5)) for (let z = 1; z < size - 1; z++) grid[z][x] = 0; // a few cross-corridors tying them together
            for (let z = 1; z < size - 1; z += spacing) {
                for (let x = 2; x < size - 2; x += 3) {
                    const dir = Math.random() < 0.5 ? 1 : -1, rz = z + dir, rz2 = z + dir * 2;
                    if (rz <= 0 || rz2 <= 0 || rz >= size - 1 || rz2 >= size - 1 || grid[z][x] !== 0) continue;
                    if (Math.random() < 0.25) continue; // leave occasional gaps so it doesn't feel too regular
                    grid[rz][x] = 0; grid[rz2][x] = 0; if (x + 1 < size - 1) grid[rz2][x + 1] = 0;
                }
            }
            return grid;
        }

        // Party Room: a tight pure maze (see generateTunnels) with extra loop connections punched in afterwards.
        // Loops only ever OPEN a wall between two cells that are each already reachable, so the maze stays fully
        // solvable; they just add the blind, unexpected corners and converging turns a chase through a party needs.
        function generatePartyMaze(size) {
            const grid = generateTunnels(size);
            for (let z = 2; z < size - 2; z++) {
                for (let x = 2; x < size - 2; x++) {
                    if (grid[z][x] !== 1 || Math.random() > 0.3) continue;
                    if ((x % 2 === 1) && grid[z][x - 1] === 0 && grid[z][x + 1] === 0) grid[z][x] = 0;
                    else if ((z % 2 === 1) && grid[z - 1][x] === 0 && grid[z + 1][x] === 0) grid[z][x] = 0;
                }
            }
            return grid;
        }

        // Poolrooms: a massive, dense lattice of tall tiled rooms joined by short 2-cell hallways. No pillars.
        // A strip along the bottom holds sealed secret rooms (reached only through glitched deep-pool walls).
        function generatePoolsLayout(size) {
            const grid = Array.from({ length: size }, () => Array(size).fill(1)), SEP = 2;
            const span = lim => { const a = []; let q = 1; while (q + 5 <= lim) { let w = Math.random() < 0.25 ? 12 + Math.floor(Math.random() * 4) : 6 + Math.floor(Math.random() * 5); if (q + w > lim) w = lim - q; if (w < 5) break; a.push([q, q + w - 1]); q += w + SEP; } return a; };
            const xs = span(size - 2), zs = span(size - 10), R = [];
            zs.forEach((zr, j) => xs.forEach((xr, i) => { const r = { i, j, x0: xr[0], x1: xr[1], z0: zr[0], z1: zr[1] }; for (let z = r.z0; z <= r.z1; z++) for (let x = r.x0; x <= r.x1; x++) grid[z][x] = 0; R.push(r); }));
            const at = (i, j) => R[j * xs.length + i], par = R.map((_, k) => k), f = k => par[k] === k ? k : (par[k] = f(par[k]));
            const link = (A, B) => { if (A.j === B.j) { const z = A.z0 + 1 + Math.floor(Math.random() * (A.z1 - A.z0 - 1)); for (let x = A.x1 + 1; x < B.x0; x++) grid[z][x] = 0; } else { const x = A.x0 + 1 + Math.floor(Math.random() * (A.x1 - A.x0 - 1)); for (let z = A.z1 + 1; z < B.z0; z++) grid[z][x] = 0; } };
            const edges = []; R.forEach(A => { if (A.i + 1 < xs.length) edges.push([A, at(A.i + 1, A.j)]); if (A.j + 1 < zs.length) edges.push([A, at(A.i, A.j + 1)]); });
            const first = R[0], right = xs.length > 1 ? at(1, 0) : null; if (right) { link(first, right); par[f(0)] = f(R.indexOf(right)); }
            edges.sort(() => Math.random() - 0.5).forEach(([A, B]) => { if (A === first || B === first) return; const a = f(R.indexOf(A)), b = f(R.indexOf(B)); if (a !== b) { par[a] = b; link(A, B); } else if (Math.random() < 0.3) link(A, B); });
            grid.secret = []; for (let i = 0; 2 + i * 7 + 4 <= size - 3; i++) { const x0 = 2 + i * 7; grid.secret.push({ x0, x1: x0 + 4, z0: size - 8, z1: size - 4 }); for (let z = size - 8; z <= size - 4; z++) for (let x = x0; x <= x0 + 4; x++) grid[z][x] = 0; }
            grid.rooms = R; return grid;
        }

        // Pools per room: standard sunken pools (stepped), long sloped DEEP pools (shallow -> pitch black, tiny creatures live there,
        // one far wall is glitched and leads to a secret room), whirlpool rooms (deadly), split pools and dry halls.
        function generatePoolDepths(grid, size, cs) {
            const mk = () => Array.from({ length: size }, () => Array(size).fill(0));
            const depth = mk(), floor = mk(), ocean = new Set(), blobs = [], glitches = [], sec = (grid.secret || []).slice().sort(() => Math.random() - 0.5);
            const F = t => -(0.5 + 36 * Math.pow(t, 1.8));
            const addStd = (px0, px1, pz0, pz1) => {
                const cells = [];
                for (let z = pz0; z <= pz1; z++) for (let x = px0; x <= px1; x++) { const de = Math.min(x - px0, px1 - x, z - pz0, pz1 - z); floor[z][x] = de === 0 ? -0.9 : de === 1 ? -3.0 : -6.0; depth[z][x] = 1; cells.push([x, z]); }
                blobs.push({ kind: 'std', tier: 2, cells, rect: [px0, px1, pz0, pz1], bottom: Math.min(...cells.map(c => floor[c[1]][c[0]])) });
            };
            for (const r of (grid.rooms || [])) {
                const px0 = r.x0 + 1, px1 = r.x1 - 1, pz0 = r.z0 + 1, pz1 = r.z1 - 1, w = px1 - px0 + 1, h = pz1 - pz0 + 1;
                if (w < 3 || h < 3 || (px0 <= 13 && pz0 <= 8)) continue;
                let ok = true; for (let z = pz0; z <= pz1; z++) for (let x = px0; x <= px1; x++) if (grid[z][x] !== 0) ok = false; if (!ok) continue;
                const roll = Math.random();
                if (roll < 0.14 && w >= 5 && h >= 5) { // whirlpool
                    const cells = []; for (let z = pz0; z <= pz1; z++) for (let x = px0; x <= px1; x++) { floor[z][x] = -9; depth[z][x] = 1; cells.push([x, z]); }
                    blobs.push({ kind: 'whirl', tier: 2, cells, rect: [px0, px1, pz0, pz1], bottom: -9 });
                } else if (roll < 0.40 && Math.max(w, h) >= 8 && sec.length) { // long deep pool
                    const ax = w >= h ? 'x' : 'z', dir = Math.random() < 0.5 ? 1 : -1, L = ax === 'x' ? w : h, cells = [], s0 = sec.pop();
                    for (let z = pz0; z <= pz1; z++) for (let x = px0; x <= px1; x++) { const k = ax === 'x' ? x - px0 : z - pz0, u = dir > 0 ? (k + 0.5) / L : 1 - (k + 0.5) / L; floor[z][x] = F(u); depth[z][x] = 1; cells.push([x, z]); if (floor[z][x] < -9) ocean.add(x + ',' + z); }
                    blobs.push({ kind: 'deep', tier: 2, cells, rect: [px0, px1, pz0, pz1], axis: ax, dir, bottom: F(1) });
                    const cx = (px0 + px1) / 2 * cs, cz = (pz0 + pz1) / 2 * cs, gy = -22;
                    const g = ax === 'x' ? { x: (dir > 0 ? px1 + 0.5 : px0 - 0.5) * cs + (dir > 0 ? -0.06 : 0.06), z: cz, ry: dir > 0 ? -Math.PI / 2 : Math.PI / 2, ret: { x: (dir > 0 ? px0 - 1 : px1 + 1) * cs, z: cz } }
                                         : { x: cx, z: (dir > 0 ? pz1 + 0.5 : pz0 - 0.5) * cs + (dir > 0 ? -0.06 : 0.06), ry: dir > 0 ? Math.PI : 0, ret: { x: cx, z: (dir > 0 ? pz0 - 1 : pz1 + 1) * cs } };
                    glitches.push(Object.assign(g, { y: gy, room: s0, sx: (s0.x0 + s0.x1) / 2 * cs, sz: (s0.z0 + s0.z1) / 2 * cs, smiler: Math.random() < 0.3 }));
                } else if (roll < 0.52) { // dry tiled hall
                } else if (roll < 0.72 && Math.max(w, h) >= 7) { // two pools split by a dry walkway
                    if (w >= h) { const m = px0 + Math.floor(w / 2); addStd(px0, m - 1, pz0, pz1); addStd(m + 1, px1, pz0, pz1); } else { const m = pz0 + Math.floor(h / 2); addStd(px0, px1, pz0, m - 1); addStd(px0, px1, m + 1, pz1); }
                } else addStd(px0, px1, pz0, pz1);
            }
            return { depth, floor, ocean, blobs, glitches };
        }

        // Sloped basin for a deep pool: vertex colours fade to black with depth so the bottom is lost in the dark.
        function deepPoolGeo(b, cs) {
            const [px0, px1, pz0, pz1] = b.rect, ax = b.axis === 'x', L = ax ? px1 - px0 + 1 : pz1 - pz0 + 1, Wd = ax ? pz1 - pz0 + 1 : px1 - px0 + 1;
            const a0 = (ax ? px0 : pz0) * cs - cs / 2, c0 = (ax ? pz0 : px0) * cs - cs / 2, LL = L * cs, WW = Wd * cs, N = L * 3;
            const F = t => -(0.5 + 36 * Math.pow(t, 1.8)), pos = [], uv = [], col = [], idx = [];
            const V = (al, ac, y, u, v) => { const d = Math.max(0, -y), br = Math.max(0.012, 1 - d / 17); pos.push(ax ? al : ac, y, ax ? ac : al); uv.push(u, v); col.push(0.75 * br, 0.93 * br, br); return pos.length / 3 - 1; };
            const dep = i => F(b.dir > 0 ? i / N : 1 - i / N), strip = (A, B) => { for (let i = 0; i < A.length - 1; i++) idx.push(A[i], B[i], A[i + 1], A[i + 1], B[i], B[i + 1]); };
            const fa = [], fb = [], wa = [], wb = [], wc = [], wd = [];
            for (let i = 0; i <= N; i++) {
                const al = a0 + LL * i / N, y = dep(i), u = (al - a0) / cs;
                fa.push(V(al, c0, y, 0, u)); fb.push(V(al, c0 + WW, y, Wd, u));
                wa.push(V(al, c0, 0, u, 0)); wb.push(V(al, c0, y, u, -y / cs)); wc.push(V(al, c0 + WW, 0, u, 0)); wd.push(V(al, c0 + WW, y, u, -y / cs));
            }
            strip(fa, fb); strip(wa, wb); strip(wc, wd);
            for (const e of [0, N]) { const al = a0 + LL * e / N, y = dep(e), q0 = V(al, c0, 0, 0, 0), q1 = V(al, c0 + WW, 0, Wd, 0), q2 = V(al, c0, y, 0, -y / cs), q3 = V(al, c0 + WW, y, Wd, -y / cs); idx.push(q0, q2, q1, q1, q2, q3); }
            const g = new THREE.BufferGeometry();
            g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
            g.setIndex(idx); g.computeVertexNormals(); return g;
        }
        function glitchTexture() {
            const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d'), cols = ['#00ffff', '#ff00ff', '#ffffff', '#000000', '#ff2255', '#22ff88'];
            for (let y = 0; y < 128; y += 4) { x.fillStyle = cols[Math.floor(Math.random() * cols.length)]; x.fillRect(Math.random() * 40, y, 40 + Math.random() * 88, 2 + Math.random() * 6); }
            for (let i = 0; i < 140; i++) { x.fillStyle = cols[Math.floor(Math.random() * cols.length)]; x.fillRect(Math.random() * 128, Math.random() * 128, 2 + Math.random() * 14, 2); }
            const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
        }
        function whirlTexture() {
            const c = document.createElement('canvas'); c.width = c.height = 512; const x = c.getContext('2d');
            const g = x.createRadialGradient(256, 256, 0, 256, 256, 256); g.addColorStop(0, '#000812'); g.addColorStop(0.35, '#06304a'); g.addColorStop(1, '#2fa9d6'); x.fillStyle = g; x.fillRect(0, 0, 512, 512);
            for (let arm = 0; arm < 5; arm++) { x.beginPath(); for (let t = 0; t < 1; t += 0.01) { const r = 16 + t * 236, a = arm * 1.2566 + t * 7; x.lineTo(256 + Math.cos(a) * r, 256 + Math.sin(a) * r); } x.strokeStyle = arm % 2 ? 'rgba(255,255,255,.85)' : 'rgba(120,230,255,.8)'; x.lineWidth = 14; x.stroke(); }
            return new THREE.CanvasTexture(c);
        }
        function makeTinyCreature() {
            const g = new THREE.Group(), pale = new THREE.MeshBasicMaterial({ color: 0xcfd8d0 }), blk = new THREE.MeshBasicMaterial({ color: 0x050505 }), wht = new THREE.MeshBasicMaterial({ color: 0xffffff });
            const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 10), pale); body.scale.set(1, 0.85, 1.5); g.add(body);
            [-0.22, 0.22].forEach(ex => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.17, 10, 8), wht); e.position.set(ex, 0.18, 0.62); g.add(e); const pu = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), blk); pu.position.set(ex, 0.18, 0.76); g.add(pu); });
            const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), blk); mouth.scale.set(1, 0.5, 0.5); mouth.position.set(0, -0.15, 0.7); g.add(mouth);
            for (let i = -2; i <= 2; i++) { const t = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.16, 5), wht); t.position.set(i * 0.1, -0.08, 0.84); t.rotation.x = Math.PI; g.add(t); }
            const tail = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.8, 6), pale); tail.rotation.x = -Math.PI / 2; tail.position.z = -1; g.add(tail);
            return g;
        }


        // ---- Level 8: Horror Attraction. Rooms of many shapes/heights joined by crooked corridors, a big boss arena in the far corner,
        // and a few sealed closets behind cracked (breakable) walls. Extra data for the level lives in GameState.attrGen. ----
        function generateAttractionLayout(size) {
            const g = Array.from({ length: size }, () => Array(size).fill(1)), tall = Array.from({ length: size }, () => Array(size).fill(0)), rooms = [];
            const R = (a, b) => a + Math.floor(Math.random() * (b - a + 1)), inb = (x, z) => x >= 1 && z >= 1 && x < size - 1 && z < size - 1;
            const carve = (x0, z0, w, h, t) => { for (let z = z0; z < z0 + h; z++) for (let x = x0; x < x0 + w; x++) if (inb(x, z)) { g[z][x] = 0; if (t) tall[z][x] = 1; } };
            const AR = 13, ax = size - 2 - AR, az = size - 2 - AR;
            carve(ax, az, AR, AR, true); carve(1, 1, 5, 5, false);
            rooms.push({ cx: 3, cz: 3 });
            const free = (x0, z0, w, h) => { if (x0 < 1 || z0 < 1 || x0 + w > size - 1 || z0 + h > size - 1) return false; if (x0 + w > ax - 2 && z0 + h > az - 2) return false; for (let z = z0 - 1; z <= z0 + h; z++) for (let x = x0 - 1; x <= x0 + w; x++) if (g[z] && g[z][x] === 0) return false; return true; };
            for (let i = 0; i < 140 && rooms.length < 24; i++) {
                const w = R(3, 10), h = R(3, 10), x0 = R(2, size - 3 - w), z0 = R(2, size - 3 - h), t = Math.random() < 0.38, shape = Math.random();
                if (!free(x0, z0, w, h)) continue;
                if (shape < 0.3 && w >= 5 && h >= 5) { // plus / cross
                    const a = R(2, w - 3), b = R(2, h - 3); carve(x0 + a, z0, w - 2 * a + 1 > 1 ? 2 : 1, h, t); carve(x0, z0 + b, w, 2, t);
                } else if (shape < 0.55 && w >= 5 && h >= 5) { // L-shape
                    carve(x0, z0, w, Math.ceil(h / 2), t); carve(x0 + (Math.random() < 0.5 ? 0 : w - Math.ceil(w / 2)), z0, Math.ceil(w / 2), h, t);
                } else {
                    carve(x0, z0, w, h, t);
                    if (w >= 6 && h >= 6) for (let k = 0; k < R(2, 4); k++) { const px = R(x0 + 2, x0 + w - 3), pz = R(z0 + 2, z0 + h - 3); g[pz][px] = 1; } // pillars
                }
                rooms.push({ cx: x0 + (w >> 1), cz: z0 + (h >> 1) });
            }
            const arenaC = { cx: ax + (AR >> 1), cz: az + (AR >> 1) };
            const dig = (x, z, w) => { for (let dz = 0; dz < w; dz++) for (let dx = 0; dx < w; dx++) if (inb(x + dx, z + dz)) g[z + dz][x + dx] = 0; };
            const line = (x0, z0, x1, z1, w) => { let x = x0, z = z0; const sx = Math.sign(x1 - x0), sz = Math.sign(z1 - z0); while (x !== x1) { dig(x, z, w); x += sx; } while (z !== z1) { dig(x, z, w); z += sz; } dig(x, z, w); };
            const link = (a, b) => { // crooked corridor: 1-2 jogs through random waypoints, 1 or 2 wide
                const w = Math.random() < 0.3 ? 2 : 1, pts = [a]; for (let k = R(0, 2); k > 0; k--) pts.push({ cx: R(2, size - 3), cz: R(2, size - 3) }); pts.push(b);
                for (let i = 0; i + 1 < pts.length; i++) { const p = pts[i], q = pts[i + 1]; if (Math.random() < 0.5) { line(p.cx, p.cz, q.cx, p.cz, w); line(q.cx, p.cz, q.cx, q.cz, w); } else { line(p.cx, p.cz, p.cx, q.cz, w); line(p.cx, q.cz, q.cx, q.cz, w); } }
            };
            const all = rooms.concat([arenaC]);
            for (let i = 1; i < all.length; i++) { let best = 0, bd = 1e9; for (let j = 0; j < i; j++) { const d = Math.abs(all[i].cx - all[j].cx) + Math.abs(all[i].cz - all[j].cz); if (d < bd) { bd = d; best = j; } } link(all[i], all[best]); }
            for (let k = 0; k < 7; k++) link(all[R(0, all.length - 1)], all[R(0, all.length - 1)]); // loops + intersections
            for (let z = az; z < az + AR; z++) for (let x = ax; x < ax + AR; x++) { g[z][x] = 0; tall[z][x] = 1; } // the arena stays one clean open room
            // breakable-wall closets: wall W between a corridor/room cell C and a sealed 1-cell pocket K
            const breaks = [], D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            const cand = []; for (let z = 3; z < size - 3; z++) for (let x = 3; x < size - 3; x++) { if (g[z][x] !== 1 || (x < 9 && z < 9) || (x > ax - 3 && z > az - 3)) continue;
                for (const [dx, dz] of D) { const cx = x - dx, cz = z - dz, kx = x + dx, kz = z + dz; if (g[cz][cx] !== 0 || g[kz][kx] !== 1) continue;
                    let ok = true; for (let oz = -1; oz <= 1 && ok; oz++) for (let ox = -1; ox <= 1; ox++) { const nx = kx + ox, nz = kz + oz; if ((nx === x && nz === z) || (nx === kx && nz === kz)) continue; if (!inb(nx, nz) || g[nz][nx] !== 1) { ok = false; break; } }
                    if (ok && g[z + dx][x + dz] === 1 && g[z - dx][x - dz] === 1) cand.push({ gx: x, gz: z, kx, kz, dx, dz }); } }
            cand.sort(() => Math.random() - 0.5);
            for (const c of cand) { if (breaks.length >= 9) break; if (breaks.some(b => Math.abs(b.gx - c.gx) + Math.abs(b.gz - c.gz) < 10)) continue; if (g[c.kz][c.kx] !== 1) continue; g[c.kz][c.kx] = 0; breaks.push(c); }
            GameState.attrGen = { tall, breaks, arena: { gx: arenaC.cx, gz: arenaC.cz, half: AR >> 1 } };
            return g;
        }

        // ---- Level 7: Thalassophobia. Open black water, a few tiled platforms, ruined pillars, huge things far below. ----
        function generateThalassoLayout(size) {
            const grid = Array.from({ length: size }, () => Array(size).fill(1));
            for (let z = 1; z < size - 1; z++) for (let x = 1; x < size - 1; x++) grid[z][x] = 0;
            const isl = [{ x0: 1, x1: 14, z0: 1, z1: 9 }, { x0: size - 9, x1: size - 3, z0: size - 9, z1: size - 3 }];
            for (let t = 0; t < 300 && isl.length < 16; t++) {
                const w = 4 + Math.floor(Math.random() * 4), h = 4 + Math.floor(Math.random() * 4), x0 = 2 + Math.floor(Math.random() * (size - w - 4)), z0 = 2 + Math.floor(Math.random() * (size - h - 4));
                if (isl.every(o => x0 > o.x1 + 4 || x0 + w - 1 < o.x0 - 4 || z0 > o.z1 + 4 || z0 + h - 1 < o.z0 - 4)) isl.push({ x0, x1: x0 + w - 1, z0, z1: z0 + h - 1 });
            }
            for (let i = 0; i < 46; i++) { // ruined pillars standing in the water
                const w = 1 + Math.floor(Math.random() * 2), h = 1 + Math.floor(Math.random() * 3), x0 = 2 + Math.floor(Math.random() * (size - 6)), z0 = 2 + Math.floor(Math.random() * (size - 6));
                if (x0 + w >= size - 1 || z0 + h >= size - 1 || isl.some(o => x0 + w - 1 >= o.x0 - 2 && x0 <= o.x1 + 2 && z0 + h - 1 >= o.z0 - 2 && z0 <= o.z1 + 2)) continue;
                for (let z = z0; z < z0 + h; z++) for (let x = x0; x < x0 + w; x++) grid[z][x] = 1;
            }
            grid.islands = isl; return grid;
        }
        function generateThalassoDepths(grid, size) {
            const mk = () => Array.from({ length: size }, () => Array(size).fill(0)), depth = mk(), floor = mk(), ocean = new Set(), dry = new Set();
            for (const o of grid.islands) for (let z = o.z0; z <= o.z1; z++) for (let x = o.x0; x <= o.x1; x++) dry.add(x + ',' + z);
            for (let z = 1; z < size - 1; z++) for (let x = 1; x < size - 1; x++) if (grid[z][x] === 0 && !dry.has(x + ',' + z)) { depth[z][x] = 1; floor[z][x] = -70; ocean.add(x + ',' + z); }
            return { depth, floor, ocean, blobs: [], glitches: [], islands: grid.islands };
        }
        function glowTexture() {
            const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
            g.addColorStop(0, 'rgba(200,255,235,1)'); g.addColorStop(0.3, 'rgba(120,255,200,.4)'); g.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
        }
        function buildThalasso(pd, cs, size, basinMat) {
            const SURF = -0.22, BOT = -70, ZERO = new THREE.Matrix4().makeScale(0, 0, 0), inst = GameState.poolFloorInst;
            for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) if (pd.depth[z][x]) { const i = GameState.poolFloor[x + ',' + z]; if (i !== undefined && inst) inst.setMatrixAt(i, ZERO); }
            if (inst) { inst.material = new THREE.MeshStandardMaterial({ map: TextureGen.create('concrete_dark'), color: 0x5d6a6d, roughness: 0.97 }); inst.instanceMatrix.needsUpdate = true; }
            const W = (size - 2) * cs, mid = (size - 1) / 2 * cs;
            const wb = new THREE.Mesh(new THREE.BoxGeometry(W - 0.04, SURF - BOT, W - 0.04), new THREE.MeshPhysicalMaterial({ color: 0x0a4560, transparent: true, opacity: 0.55, roughness: 0.05, clearcoat: 1, envMapIntensity: 1.4, depthWrite: false }));
            wb.position.set(mid, (SURF + BOT) / 2, mid); wb.renderOrder = 2; scene.add(wb);
            const fl = new THREE.Mesh(new THREE.PlaneGeometry(W, W), new THREE.MeshBasicMaterial({ color: 0x00060a })); fl.rotation.x = -Math.PI / 2; fl.position.set(mid, BOT, mid); scene.add(fl);
            const iw = basinMat.clone(); iw.map = null; iw.color.setHex(0x182226); iw.roughness = 0.97; iw.clearcoat = 0; iw.needsUpdate = true;
            for (const o of pd.islands) {
                const w = (o.x1 - o.x0 + 1) * cs, d = (o.z1 - o.z0 + 1) * cs, cx = (o.x0 + o.x1) / 2 * cs, cz = (o.z0 + o.z1) / 2 * cs, H = -BOT;
                [[0, -1, w], [0, 1, w], [-1, 0, d], [1, 0, d]].forEach(([dx, dz, ww]) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(ww, H), iw); m.position.set(cx + dx * w / 2, BOT / 2, cz + dz * d / 2); m.rotation.y = dx ? (dx > 0 ? Math.PI / 2 : -Math.PI / 2) : (dz > 0 ? 0 : Math.PI); scene.add(m); });
            }
            // open-ocean atmosphere: depth veils, sea stacks along the horizon, light shafts from the overcast sky
            [-8, -20, -34, -50].forEach(y => { const v = new THREE.Mesh(new THREE.PlaneGeometry(W, W), new THREE.MeshBasicMaterial({ color: 0x021019, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide })); v.rotation.x = -Math.PI / 2; v.position.set(mid, y, mid); v.renderOrder = 1; scene.add(v); });
            const rockM = new THREE.MeshStandardMaterial({ color: 0x1b2427, roughness: 1 });
            for (let i = 0; i < 18; i++) { const t = Math.random() * 4, e = t % 1 * (W - 12) + 6, hh = 22 + Math.random() * 30, st = new THREE.Mesh(new THREE.ConeGeometry(4 + Math.random() * 5, hh, 7), rockM), ins = 3 + Math.random() * 3;
                st.position.set(t < 1 ? 6 + e - 6 : t < 2 ? W - ins : t < 3 ? W - e + 6 : ins, hh / 2 - 8, t < 1 ? ins : t < 2 ? e : t < 3 ? W - ins : W - e + 6); st.rotation.y = Math.random() * 6; scene.add(st); }
            const beamM = new THREE.MeshBasicMaterial({ color: 0x6fb8d0, transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
            for (let i = 0; i < 9; i++) { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 5 + Math.random() * 3, 64, 12, 1, true), beamM); b.position.set(8 + Math.random() * (W - 16), -2, 8 + Math.random() * (W - 16)); scene.add(b); }
            GameState.levs = []; const dark = new THREE.MeshBasicMaterial({ color: 0x02070a }), eye = new THREE.MeshBasicMaterial({ color: 0xcfffe8 });
            for (let i = 0; i < 3; i++) {
                const g = new THREE.Group(), segs = [], R = [3.2, 4.4, 5, 4.6, 3.8, 3, 2.2, 1.5, 0.9];
                R.forEach((r, k) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10), dark); m.position.z = -k * 5; g.add(m); segs.push(m); });
                [-1.9, 1.9].forEach(ex => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 8), eye); e.position.set(ex, 1.2, 2.6); g.add(e); });
                g.visible = true; scene.add(g); GameState.levs.push({ g, segs, a: Math.random() * 6.28, sp: 0.04 + i * 0.01, R: 30 + i * 14, y: -42 - i * 6, mid, near: false });
            }
            const gt = glowTexture(), lm = new THREE.MeshBasicMaterial({ color: 0x9fffe0 }); GameState.lures = [];
            for (let i = 0; i < 16; i++) {
                const x = 6 + Math.random() * (W - 12), z = 6 + Math.random() * (W - 12), y = -15 - Math.random() * 35, o = new THREE.Mesh(new THREE.SphereGeometry(0.25, 8, 8), lm), sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: gt, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
                sp.scale.setScalar(5); o.add(sp); o.position.set(x, y, z); scene.add(o); GameState.lures.push({ o, y, ph: Math.random() * 6 });
            }
        }

        // ---- Fake partygoers: look like the others until you get close ----
        function makePartygoerMesh(hue) {
            const g = new THREE.Group(), body = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.1, 8), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(hue, 0.6, 0.5), roughness: 0.8 })); body.position.y = 0.55;
            const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), new THREE.MeshStandardMaterial({ color: 0xe8c9a8 })); head.position.y = 1.3;
            const hat = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.36, 8), new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0x443300 })); hat.position.y = 1.65; g.add(body, head, hat); return g;
        }
        function fakeTick(g, dt, p) {
            const m = g.mesh, d = Math.hypot(m.position.x - p.x, m.position.z - p.z);
            if (!g.tw && d < 3.6) g.tw = 0.001;
            if (!g.tw) return;
            g.tw += dt; const k = Math.min(1, g.tw * 3);
            m.rotation.z = (Math.random() - 0.5) * 0.7 * k; m.position.x += (Math.random() - 0.5) * 0.1 * k; m.scale.set(1 + (Math.random() - 0.5) * 0.5 * k, 1 + Math.random() * 0.6 * k, 1 + (Math.random() - 0.5) * 0.5 * k);
            if (g.tw > 1.0) {
                const x = m.position.x, z = m.position.z; scene.remove(m); g.done = true; try { AudioSys.at(new THREE.Vector3(x, 0.9, z)).playFakeBurst(); } catch (e) {}
                GameState.bursts = GameState.bursts || [];
                for (let i = 0; i < 16; i++) { const b = new THREE.Mesh(new THREE.SphereGeometry(0.07 + Math.random() * 0.06, 6, 5), new THREE.MeshBasicMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.8, 0.6) })); b.position.set(x, 0.9 + Math.random() * 0.6, z); scene.add(b); GameState.bursts.push({ m: b, v: new THREE.Vector3((Math.random() - 0.5) * 7, Math.random() * 5, (Math.random() - 0.5) * 7), life: 0.9 }); }
                const en = new Entity('skinstealer', x, z); try { en.alertToPosition(p.clone(), 99); } catch (e) {} en.state = 'chase'; en.investigateTimer = 999;
            }
        }
        function updateBursts(dt) { GameState.bursts = (GameState.bursts || []).filter(b => { b.life -= dt; b.v.y -= 9 * dt; b.m.position.addScaledVector(b.v, dt); b.m.scale.setScalar(Math.max(0.01, b.life)); if (b.life <= 0) { scene.remove(b.m); return false; } return true; }); }

        // ---- Shop radio: a little tune through a tinny speaker ----
        const ShopRadio = {
            on: false, i: 0, t: null, g: null, bp: null, pan: null, src: null, MEL: [523.25, 0, 659.25, 0, 783.99, 659.25, 0, 587.33, 523.25, 0, 440, 0, 392, 440, 523.25, 0, 587.33, 0, 698.46, 0, 880, 698.46, 0, 659.25, 587.33, 0, 523.25, 0, 392, 0, 440, 0], BASS: { 0: 130.81, 8: 130.81, 16: 174.61, 24: 98 },
            start(pos) { // positional: the sound comes from the radio itself (HRTF panner, fades out with distance)
                if (this.on || !GameState.inShop) return;
                const A = AudioSys, c = A.ctx; if (!c || !A.masterGain || !pos) return; this.on = true;
                const pan = c.createPanner(); pan.panningModel = 'HRTF'; pan.distanceModel = 'linear'; pan.refDistance = 2; pan.maxDistance = 34; pan.rolloffFactor = 1;
                if (pan.positionX) { pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z; } else pan.setPosition(pos.x, pos.y, pos.z);
                pan.connect(A.masterGain); this.pan = pan; try { Spatial.updateListener(); } catch (e) {}
                if (Sfx.buf.shop_radio) { const s = c.createBufferSource(), g = c.createGain(); s.buffer = Sfx.buf.shop_radio; s.loop = true; g.gain.value = SFX_REG.shop_radio.v; s.connect(g); g.connect(pan); s.start(); this.src = s; this.g = g; return; }
                const g = c.createGain(), bp = c.createBiquadFilter(), ws = c.createWaveShaper(), k = new Float32Array(256); for (let i = 0; i < 256; i++) { const x = i / 128 - 1; k[i] = Math.tanh(x * 2.2); }
                g.gain.value = 0.32; bp.type = 'bandpass'; bp.frequency.value = 1400; bp.Q.value = 0.55; ws.curve = k; bp.connect(ws); ws.connect(g); g.connect(pan); this.g = g; this.bp = bp; this.i = 0;
                this.t = setInterval(() => this.step(), 300); this.step();
            },
            step() {
                const A = AudioSys, c = A.ctx; if (!c || c.state !== 'running' || !this.bp) return; const t = c.currentTime, n = this.MEL[this.i % this.MEL.length], b = this.BASS[this.i % this.MEL.length]; this.i++;
                const note = (f, d, type, v) => { const o = c.createOscillator(), e = c.createGain(); o.type = type; o.frequency.value = f; e.gain.setValueAtTime(0.0001, t); e.gain.linearRampToValueAtTime(v, t + 0.02); e.gain.exponentialRampToValueAtTime(0.0001, t + d); o.connect(e); e.connect(this.bp); o.start(t); o.stop(t + d + 0.05); };
                if (n) note(n, 0.34, 'triangle', 0.5); if (b) note(b, 1.1, 'sine', 0.6);
                if (A.noiseBuffer && Math.random() < 0.5) { const s = c.createBufferSource(), e = c.createGain(); s.buffer = A.noiseBuffer; e.gain.value = 0.015; s.connect(e); e.connect(this.bp); s.start(t, Math.random() * 0.5, 0.06); } // crackle
            },
            stop() {
                if (!this.on) return; this.on = false; clearInterval(this.t); this.t = null;
                try { if (this.src) this.src.stop(); } catch (e) {} const g = this.g, bp = this.bp, pan = this.pan, src = this.src;
                try { if (g) g.gain.setTargetAtTime(0, AudioSys.ctx.currentTime, 0.05); } catch (e) {}
                setTimeout(() => { try { if (g) g.disconnect(); if (bp) bp.disconnect(); if (src) src.disconnect(); if (pan) pan.disconnect(); } catch (e) {} }, 400);
                this.g = this.bp = this.pan = this.src = null;
            }
        };
        setInterval(() => { if (ShopRadio.on && (!GameState.inShop || !GameState.isRunning)) ShopRadio.stop(); }, 250); // never plays in the menu or in a level

        // Pre-level shop room: wipe the top-left corner, carve a 6x3 room (x1-6, z1-3), a sinking wall column (x7) and a 2-cell
        // antechamber (x8-9), then re-attach any orphaned open areas so the level stays fully connected.
        function shopCarve(grid, size) {
            const inZ = (x, z) => x <= 7 && z <= 4;
            for (let z = 0; z <= 4; z++) for (let x = 0; x <= 7; x++) grid[z][x] = 1;
            for (let z = 1; z <= 3; z++) { for (let x = 1; x <= 6; x++) grid[z][x] = 0; for (let x = 8; x <= 9; x++) grid[z][x] = 0; }
            grid[1][4] = 1;
            const lab = Array.from({ length: size }, () => Array(size).fill(-1)), comps = [], D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            for (let z = 1; z < size - 1; z++) for (let x = 1; x < size - 1; x++) {
                if (grid[z][x] !== 0 || lab[z][x] >= 0) continue;
                const id = comps.length, cells = [], q = [[x, z]]; lab[z][x] = id;
                while (q.length) { const [cx, cz] = q.pop(); cells.push([cx, cz]); for (const [dx, dz] of D4) { const nx = cx + dx, nz = cz + dz; if (nx > 0 && nz > 0 && nx < size - 1 && nz < size - 1 && grid[nz][nx] === 0 && lab[nz][nx] < 0) { lab[nz][nx] = id; q.push([nx, nz]); } } }
                comps.push(cells);
            }
            const shopId = lab[2][2], mainId = lab[2][9]; let main = comps[mainId].slice();
            for (let id = 0; id < comps.length; id++) {
                if (id === shopId || id === mainId || (grid.secret && comps[id][0][1] >= size - 9)) continue;
                let best = null, bd = 1e9;
                for (const a of comps[id]) { if (inZ(a[0], a[1])) continue; for (const b of main) { const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]); if (d < bd) { bd = d; best = [a, b]; } } }
                if (!best) continue;
                let [[ax, az], [bx, bz]] = best;
                while (ax !== bx) { ax += Math.sign(bx - ax); if (!inZ(ax, az) && ax > 0 && ax < size - 1) grid[az][ax] = 0; }
                while (az !== bz) { az += Math.sign(bz - az); if (!inZ(ax, az) && az > 0 && az < size - 1) grid[az][ax] = 0; }
                main = main.concat(comps[id]);
            }
        }

        // The shopkeeper model. buildShopRoom uses it as-is; multiplayer avatars reuse it with randomised colours.
        function buildShopkeeperFigure(M, o) {
            o = o || {}; const kp = new THREE.Group();
            const coat = M({ color: o.coat != null ? o.coat : 0x3a3328, roughness: 0.9 }), skin = M({ color: o.skin != null ? o.skin : 0xd9c3a0, roughness: 0.7 }), hatC = o.hat != null ? o.hat : 0x1c1a16;
            const body = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.46, 1.25, 14), coat); body.position.y = 0.62; kp.add(body);
            const head = new THREE.Group(); head.position.y = 1.5; kp.add(head);
            head.add(new THREE.Mesh(new THREE.SphereGeometry(0.23, 16, 14), skin));
            [-0.08, 0.08].forEach(ex => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), M({ color: 0x111111 })); e.position.set(ex, 0.03, 0.21); head.add(e); });
            const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.03, 18), M({ color: hatC })); brim.position.y = 0.17; head.add(brim);
            const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.26, 16), M({ color: hatC })); crown.position.y = 0.31; head.add(crown);
            const arms = [-0.42, 0.42].map(ax => { const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.7, 0.14), coat); arm.position.set(ax, 0.95, 0.15); arm.rotation.x = -0.6; kp.add(arm); return arm; });
            return { kp, head, arms, coat, skin };
        }
        // Lag fix: while you are still in the shop, build the things the level will need the moment you press NEXT LEVEL
        // (item / chest / crate models + their textures, shader programs for the whole level behind the wall, monster rigs),
        // so that press no longer has to create, upload and compile everything inside one frame.
        function shopWarm() {
            if (!renderer) return;
            setTimeout(() => {
                if (!GameState.inShop) return;
                const g = new THREE.Group(); g.position.set(0, -60, 0);
                [...new Set([...Object.keys(FLOOR_Y), 'axe', 'crowbar', 'tracker', 'chest_locator'])].forEach(id => { try { g.add(buildItemModel(id)); } catch (e) {} });
                try { g.add(buildChestModel().group); g.add(buildCrateModel(1.1)); } catch (e) {}
                try { TextureGen.create('crate'); TextureGen.create('concrete_dark'); } catch (e) {}
                const warmKeep = []; // shotgun FX parts + a throwaway skinstealer: built and compiled now so the first shot / the shopkeeper burst doesn't hitch
                try {
                    shotFxInit(); const S = ShotFx; // adds the permanent muzzle light now, not on the first shot (a new light forces every lit material to recompile)
                    ['flash', 'spark', 'smoke'].forEach(k => { const t = shotTex(k); try { if (renderer.initTexture) renderer.initTexture(t); } catch (e) {} });
                    [S.flash, S.cone, ...S.slots.flatMap(s => [s.path, s.head])].forEach(m => { if (m.parent && m.parent !== g && m.parent !== scene) return; m.visible = true; g.add(m); warmKeep.push(m); });
                } catch (e) {}
                try { const ent = new Entity('skinstealer', 0, 0); const k = GameState.entities.indexOf(ent); if (k >= 0) GameState.entities.splice(k, 1); scene.remove(ent.mesh); g.add(ent.mesh); }
                catch (e) {}
                try { GrenadeSys.warm().forEach(m => { m.visible = true; g.add(m); warmKeep.push(m); }); } catch (e) {}
                try { [0x050505, 0x8a0a0a].forEach(c => g.add(new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), new THREE.MeshBasicMaterial({ color: c })))); } catch (e) {}
                scene.add(g);
                const done = () => { warmKeep.forEach(m => { m.visible = false; if (m.parent === g) g.remove(m); }); scene.remove(g); g.traverse(o => { if (o.geometry && o.geometry.dispose) o.geometry.dispose(); }); }; // (materials stay alive so their compiled programs stay cached)
                if (typeof renderer.compileAsync === 'function') renderer.compileAsync(scene, camera).catch(() => {}).finally(done); else setTimeout(done, 50);
                try { Object.keys(RIGS).forEach((t, i) => setTimeout(() => { try { rigLoad(t); } catch (e) {} }, 300 * (i + 1))); } catch (e) {}
            }, 500);
        }
        // The pre-level shop room: Level 0 decor, fully lit, shopkeeper + stand on the left, green button on the far wall.
        function buildShopRoom(cs, ceilH) {
            const H = Math.min(ceilH, 4), x0 = 0.5 * cs + 0.02, x1 = 6.5 * cs - 0.02, z0 = 0.5 * cs + 0.02, z1 = 3.5 * cs - 0.02, W = x1 - x0, D = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
            const L0 = LevelData[0], M = o => new THREE.MeshStandardMaterial(o);
            const tex = (t, rx, ry) => { const c = TextureGen.create(t).clone(); c.repeat.set(rx, ry); c.needsUpdate = true; return c; };
            const put = (m, x, y, z) => { m.position.set(x, y, z); scene.add(m); return m; };
            const box = (w, h, d, mat, x, y, z) => put(new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat), x, y, z);
            const plane = (w, h, mat, x, y, z, rx, ry) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); m.rotation.set(rx || 0, ry || 0, 0); return put(m, x, y, z); };
            plane(W, D, M({ map: tex(L0.floorTex, W / 9, D / 9), roughness: 0.95 }), cx, 0.02, cz, -Math.PI / 2, 0);
            plane(W, D, M({ map: tex(L0.ceilTex, W / 8, D / 8), roughness: 0.8 }), cx, H - 0.01, cz, Math.PI / 2, 0);
            const wm = w => M({ map: tex(L0.wallTex, w / cs, H / cs), roughness: 0.85, side: THREE.DoubleSide });
            plane(W, H, wm(W), cx, H / 2, z0, 0, 0); plane(W, H, wm(W), cx, H / 2, z1, 0, Math.PI); plane(D, H, wm(D), x0, H / 2, cz, 0, Math.PI / 2);
            const bb = M({ color: 0x3b2a14, roughness: 0.7 });
            box(W, 0.22, 0.08, bb, cx, 0.11, z0 + 0.04); box(W, 0.22, 0.08, bb, cx, 0.11, z1 - 0.04); box(0.08, 0.22, D, bb, x0 + 0.04, 0.11, cz);
            const fm = M({ color: 0x222222, metalness: 0.8, roughness: 0.3 });
            for (let i = 0; i < 3; i++) {
                const lx = x0 + W * (i + 0.5) / 3;
                box(1.7, 0.08, 0.8, fm, lx, H - 0.05, cz);
                box(1.5, 0.05, 0.62, M({ color: 0xfff2c2, emissive: 0xfff2c2, emissiveIntensity: 1.9 }), lx, H - 0.1, cz);
                const l = new THREE.PointLight(0xfff2c2, 2.8, 22, 1.4); l.position.set(lx, H - 0.5, cz); scene.add(l);
            }
            // rug, bench, plant: Lobby clutter
            plane(8, 3.4, M({ color: 0x7a3a2a, roughness: 1 }), cx - 3, 0.035, cz + 2.4, -Math.PI / 2, 0); plane(7.2, 2.6, M({ color: 0xa8864a, roughness: 1 }), cx - 3, 0.04, cz + 2.4, -Math.PI / 2, 0);
            box(2.2, 0.45, 0.6, M({ color: 0x5a4630, roughness: 0.8 }), x0 + 4, 0.225, z1 - 0.45);
            const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.22, 0.5, 14), M({ color: 0x7a4a2a })); put(pot, x0 + 1, 0.25, z1 - 0.8);
            put(new THREE.Mesh(new THREE.SphereGeometry(0.46, 14, 12), M({ color: 0x3f6b35, roughness: 0.9 })), x0 + 1, 0.95, z1 - 0.8);
            // shop stand in solid cell (4,1)
            const sx = 4 * cs, sz = cs, wood = M({ color: 0x6b4a2b, roughness: 0.7 });
            box(3.4, 1.05, 1.1, wood, sx, 0.525, sz + 1.3); box(3.7, 0.08, 1.35, M({ color: 0x8a6238, roughness: 0.5 }), sx, 1.09, sz + 1.3);
            box(3.6, 2.4, 0.35, M({ color: 0x4a3520, roughness: 0.8 }), sx, 1.2, z0 + 0.25);
            const pal = [0xd9534f, 0x5bc0de, 0xf0ad4e, 0x5cb85c, 0xe6c84c, 0xb07cd8];
            [0.95, 1.55, 2.15].forEach((y, r) => { box(3.6, 0.05, 0.55, wood, sx, y, z0 + 0.5); for (let c = 0; c < 6; c++) if (r < 3) box(0.32, 0.26, 0.26, M({ color: pal[(c + r * 2) % 6], roughness: 0.5, emissive: pal[(c + r * 2) % 6], emissiveIntensity: 0.12 }), sx - 1.35 + c * 0.54, y + 0.16, z0 + 0.5); });
            for (let i = 0; i < 7; i++) { const st = box(0.55, 0.06, 1.9, M({ color: i % 2 ? 0xf0e8d0 : 0xb8322a, roughness: 0.8 }), sx - 1.65 + i * 0.55, 2.75, sz + 1.0); st.rotation.x = 0.18; }
            [-1.8, 1.8].forEach(o => put(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.8, 8), wood), sx + o, 1.4, sz + 1.9));
            const sign = labelSprite('THE STRANGE SHOP', 3.8); sign.position.set(sx, 3.4, sz + 1.2); scene.add(sign);
            const lamp = new THREE.PointLight(0xffc870, 1.8, 9); lamp.position.set(sx, 2.4, sz + 1.4); scene.add(lamp);
            const _sk = buildShopkeeperFigure(M), kp = _sk.kp, head = _sk.head; kp.position.set(sx, 0, sz + 0.2);
            scene.add(kp);
            // green button on the sinking wall
            box(0.14, 1.0, 0.7, M({ color: 0x1a1a1a, metalness: 0.6, roughness: 0.4 }), x1 - 0.07, 1.45, cz);
            const bm = M({ color: 0x22dd66, emissive: 0x22ff66, emissiveIntensity: 1.4, roughness: 0.3 });
            const bt = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.12, 24), bm); bt.rotation.z = Math.PI / 2; put(bt, x1 - 0.17, 1.45, cz);
            const bl = new THREE.PointLight(0x33ff77, 1.4, 7); bl.position.set(x1 - 0.8, 1.5, cz); scene.add(bl);
            const bs = labelSprite('NEXT LEVEL', 2.6); bs.position.set(x1 - 0.4, 2.4, cz); scene.add(bs);
            let pr = document.getElementById('shop-prompt');
            if (!pr) { pr = document.createElement('div'); pr.id = 'shop-prompt'; pr.style.cssText = 'position:fixed;left:50%;bottom:16%;transform:translateX(-50%);z-index:30;color:#e6c84c;font:bold 18px "Courier New",monospace;letter-spacing:3px;text-shadow:0 0 8px #000;pointer-events:none;display:none'; document.body.appendChild(pr); }
            pr.style.display = 'none';
            const rdx = sx + 1.3, rdz = sz + 1.3; // the radio on the counter
            box(0.55, 0.3, 0.2, M({ color: 0x5b3a1e, roughness: 0.6 }), rdx, 1.28, rdz); box(0.36, 0.2, 0.02, M({ color: 0x111111 }), rdx - 0.06, 1.28, rdz + 0.11);
            box(0.08, 0.08, 0.02, M({ color: 0xffb347, emissive: 0xffa020, emissiveIntensity: 1.2 }), rdx + 0.2, 1.3, rdz + 0.11);
            const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.6, 5), M({ color: 0xcccccc, metalness: 0.8 })); ant.position.set(rdx + 0.2, 1.7, rdz); ant.rotation.z = -0.35; scene.add(ant);
            ShopRadio.start(new THREE.Vector3(rdx, 1.3, rdz));
            GameState.shopPos = { sx, sz: sz + 2, bx: x1 - 0.2, bz: cz, btn: bt, kp, head };
            GameState.shopTick = (t) => {
                const p = controls.getObject().position, sp = GameState.shopPos, dS = Math.hypot(p.x - sp.sx, p.z - sp.sz), dB = Math.hypot(p.x - sp.bx, p.z - sp.bz);
                bm.emissiveIntensity = 1.3 + Math.sin(t * 0.005) * 0.5; head.rotation.y = Math.sin(t * 0.0009) * 0.35;
                pr.textContent = GameState.shopOpen || GameState.shopSliding ? '' : dB < 3.4 ? '[E] PRESS THE BUTTON' : dS < 4.6 ? '[E] BROWSE THE WARES' : '';
                pr.style.display = pr.textContent ? 'block' : 'none';
            };
            controls.getObject().position.set(1.2 * cs, 2, 2 * cs);
            camera.rotation.set(0, -Math.PI / 2, 0, 'YXZ'); LOOK.yaw = -Math.PI / 2; LOOK.pitch = 0;
        }
        function shopInteract(p) {
            const sp = GameState.shopPos; if (!sp || GameState.shopOpen || GameState.shopSliding || GameState.shopDoom) return;
            if (MP.active && MP.shopAct(p)) return;
            if (Math.hypot(p.x - sp.bx, p.z - sp.bz) < 3.4) return shopPressButton();
            if (Math.hypot(p.x - sp.sx, p.z - sp.sz) < 4.6) {
                GameState.shopOpen = true; try { controls.unlock(); } catch (e) {}
                document.getElementById('shop-go-btn').style.display = 'none'; document.getElementById('shop-back-btn').innerText = 'LEAVE SHOP';
                openShop();
            }
        }
        function shopPressButton() {
            if (GameState.shopDoom) return; // the button is dead once the shopkeeper has been shot
            GameState.shopSliding = true; ShopRadio.stop(); AudioSys.playClick(); showEventBanner('THE WALL SINKS INTO THE FLOOR...', 3.2);
            Save.stock = null; sv('backrooms_shop_stock', null);
            const f = GameState.pendingSpawn; GameState.pendingSpawn = null; GameState.inShop = false; GameState.shopTick = null;
            const pr = document.getElementById('shop-prompt'); if (pr) pr.style.display = 'none';
            if (GameState.shopPos && GameState.shopPos.btn) GameState.shopPos.btn.position.x += 0.08;
            { // timing readout (F12 console): how long the spawn took and the worst frame in the following 2 seconds
                const t1 = performance.now(); if (f) f(); const spawnMs = Math.round(performance.now() - t1); let last = performance.now(), worst = 0, n = 0;
                (function m(t) { const d = t - last; last = t; if (n++ > 2) worst = Math.max(worst, d); if (n < 120) requestAnimationFrame(m); else console.log('[next-level] spawn ' + spawnMs + 'ms, worst frame in the next 2s: ' + Math.round(worst) + 'ms'); })(last);
            }
            const h = (LevelData[GameState.level].ceilH || 4), t0 = performance.now(), W = GameState.sliders.slice();
            (function anim(t) {
                const k = Math.min(1, (t - t0) / 2800);
                W.forEach(w => { w.position.y = h / 2 - k * (h + 0.3); w.position.x += (Math.random() - 0.5) * 0.012 * (1 - k); });
                if (k < 1) requestAnimationFrame(anim); else { for (let z = 1; z <= 3; z++) GameState.grid[z][7] = 0; GameState.shopSliding = false; }
            })(t0);
        }


        // --- GRID PATHFINDING (BFS FOR SMART PURSUIT & SOUND INVESTIGATION) ---
        const StamCfg = {
            slow: 0.9, slowTime: 5,      // 10% slower for 5s after hitting 0
            regenLock: 3,                // then no stamina regen for 3s once the slow ends
            runMin: 25,                  // can't run again until stamina is back up to 25
            lockDuringSlow: false        // true = no regen during the 5s slow either (8s total with no regen)
        };
        function getNextGridStep(fromX, fromZ, toX, toZ) {
            const cs = GameState.cellSize;
            const size = GameState.gridSize;
            const startGX = Math.max(1, Math.min(size - 2, Math.round(fromX / cs)));
            const startGZ = Math.max(1, Math.min(size - 2, Math.round(fromZ / cs)));
            const targetGX = Math.max(1, Math.min(size - 2, Math.round(toX / cs)));
            const targetGZ = Math.max(1, Math.min(size - 2, Math.round(toZ / cs)));

            if (startGX === targetGX && startGZ === targetGZ) {
                return new THREE.Vector3(toX - fromX, 0, toZ - fromZ).normalize();
            }

            const visited = Array.from({ length: size }, () => Array(size).fill(false));
            const queue = [[startGX, startGZ, null]];
            visited[startGZ][startGX] = true;

            const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
            let foundFirstStep = null;

            while (queue.length > 0) {
                const [cx, cz, firstStep] = queue.shift();
                if (cx === targetGX && cz === targetGZ) {
                    foundFirstStep = firstStep;
                    break;
                }
                for (const [dx, dz] of dirs) {
                    const nx = cx + dx;
                    const nz = cz + dz;
                    if (nx > 0 && nx < size - 1 && nz > 0 && nz < size - 1 && !visited[nz][nx]) {
                        if (GameState.grid[nz][nx] === 0) {
                            visited[nz][nx] = true;
                            queue.push([nx, nz, firstStep || [nx, nz]]);
                        }
                    }
                }
            }

            if (foundFirstStep) {
                const worldTargetX = foundFirstStep[0] * cs;
                const worldTargetZ = foundFirstStep[1] * cs;
                return new THREE.Vector3(worldTargetX - fromX, 0, worldTargetZ - fromZ).normalize();
            }
            return new THREE.Vector3(toX - fromX, 0, toZ - fromZ).normalize();
        }

        // ===== HOUND AI (beam drain, hide-spot pathfinding, cornered lunge) =====
        const HoundCfg = {
            beamCos: 0.82, beamRange: 30, beamDrain: 3.0, beamMax: 2,   // looking at a hound: +3.0 battery/s each (base drain is 0.35/s), max 2 hounds counted
            fleeSearch: 18,                                              // hounds look up to 18 cells (path distance) for somewhere to hide
            cornerTime: 0.5, lungeRange: 10, lungeSpeed: 2.4,            // cornered for 0.5s with you within 10 units -> lunge at 2.4x speed
            lungeHit: 2.4, lungeTime: 1.6, lungeCooldown: 5,             // hit lands at 2.4 units (always before the 1.45 catch radius)
            stunTime: 3, flickBattery: 1, alertTime: 25                  // lunger stunned 3s, your battery -> 1%, all hounds investigate you for 25s
        };
        function clearLine(ax, az, bx, bz) { // true if no wall cell lies on the straight line a -> b
            const g = GameState.grid, cs = GameState.cellSize; if (!g) return true;
            const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / (cs * 0.45));
            for (let i = 1; i < steps; i++) { const t = i / steps, gx = Math.round((ax + (bx - ax) * t) / cs), gz = Math.round((az + (bz - az) * t) / cs); if (g[gz] && g[gz][gx] === 1) return false; }
            return true;
        }
        const _hbV = new THREE.Vector3(), _hbD = new THREE.Vector3();
        function houndInBeam(e) { // is this hound inside your flashlight cone, in range and in clear line of sight?
            if (!GameState.player.flashlightOn) return false;
            const p = controls.getObject().position; camera.getWorldDirection(_hbD);
            _hbV.subVectors(e.mesh.position, p); const d = _hbV.length(); if (d > HoundCfg.beamRange || d < 0.5) return false;
            _hbV.divideScalar(d); if (_hbV.dot(_hbD) < HoundCfg.beamCos) return false;
            return clearLine(p.x, p.z, e.mesh.position.x, e.mesh.position.z);
        }
        function houndBeamCount() { // hounds currently being lit up by your flashlight (stunned ones don't count)
            let n = 0; for (const e of GameState.entities) if (e.type === 'hound' && e.stunTimer <= 0 && houndInBeam(e)) n++;
            return Math.min(n, HoundCfg.beamMax);
        }
        // Flood-fills outward from the hound (it can't path through the cells around you) and picks the cell that is
        // OUT of your sight, as far from you as possible (score = distance from you - 0.3 * length of the run there).
        // Returns { first: [gx,gz] next cell to step into, hidden, cornered }. cornered = nowhere hidden and nowhere meaningfully farther.
        function houndHideSpot(e, pp) {
            const cs = GameState.cellSize, size = GameState.gridSize, g = GameState.grid, cl = v => Math.max(1, Math.min(size - 2, v));
            const sx = cl(Math.round(e.mesh.position.x / cs)), sz = cl(Math.round(e.mesh.position.z / cs)), px = Math.round(pp.x / cs), pz = Math.round(pp.z / cs);
            const vis = DifficultyConfigs[GameState.difficulty].visionRange, curD = Math.hypot(e.mesh.position.x - pp.x, e.mesh.position.z - pp.z);
            const seen = new Uint8Array(size * size), q = [[sx, sz, 0, null]]; seen[sz * size + sx] = 1;
            let bestHid = null, bestAny = null;
            for (let qi = 0; qi < q.length; qi++) {
                const [cx, cz, d, first] = q[qi], wx = cx * cs, wz = cz * cs, pd = Math.hypot(wx - pp.x, wz - pp.z);
                if (d > 0) {
                    const hid = pd > vis * 0.95 || !clearLine(pp.x, pp.z, wx, wz), score = pd - 0.3 * d * cs;
                    if (hid && pd >= 6 && (!bestHid || score > bestHid.score)) bestHid = { first, score };
                    if (!bestAny || pd > bestAny.pd) bestAny = { first, pd };
                }
                if (d >= HoundCfg.fleeSearch) continue;
                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const nx = cx + dx, nz = cz + dz;
                    if (nx < 1 || nz < 1 || nx >= size - 1 || nz >= size - 1 || seen[nz * size + nx] || g[nz][nx] !== 0) continue;
                    if (Math.abs(nx - px) <= 1 && Math.abs(nz - pz) <= 1) continue; // can't run through you
                    seen[nz * size + nx] = 1; q.push([nx, nz, d + 1, first || [nx, nz]]);
                }
            }
            if (bestHid) return { first: bestHid.first, hidden: true, cornered: false };
            if (bestAny && bestAny.pd > curD + 3) return { first: bestAny.first, hidden: false, cornered: false };
            return { first: null, hidden: false, cornered: true };
        }
        function houndLungeHit(h, p) { // the lunge connects: light flicked off, battery to 1%, lunger stunned, every hound alerted
            const P = GameState.player; if (GameState._flMount) { P.battery = Math.min(P.battery, 15); P.flashlightOn = false; flashLight.visible = false; P._mountOff = true; } else if (P.mega) { P.battery = Math.min(P.battery, 50); P.mega = false; } else { P.battery = Math.min(P.battery, HoundCfg.flickBattery); P.flashlightOn = false; flashLight.visible = false; }
            h._ns = true; h.stun(HoundCfg.stunTime); h._lungeStun = true; h._corner = 0; h._lungeCD = HoundCfg.lungeCooldown;
            for (const o of GameState.entities) {
                if (o.type !== 'hound') continue;
                o.investigateTarget = p.clone(); o.investigateTimer = HoundCfg.alertTime; o.lastKnown = p.clone(); o._hunt = 1; o._huntT = 6; o.ambushWait = 0; o._ambTgt = null; // alerted hounds join the pack
                if (o !== h && o.stunTimer <= 0) { o.state = 'investigate'; o.pathRecalcTimer = 0; }
            }
            AudioSys.playSecondChanceHit(); AudioSys.at(h.mesh.position).playMonsterSound('hound', 0);
            showEventBanner('THE HOUND LUNGES - YOUR LIGHT DIES. EVERY HOUND KNOWS WHERE YOU ARE.', 3.5);
        }

        // ===== HOUND SWARM =====
        // When 2+ hounds are hunting you they stop acting alone and split into roles (re-evaluated every second):
        //   CHASER  : follows you directly (about 40% of the pack, the closest ones).
        //   FLANKER : runs ahead along one of your escape routes (in the direction you are heading) to cut you off and pincer you.
        //   BLOCKER : parks itself in a hallway deeper down another escape route - or on the EXIT if it is near - and holds it.
        // Each hound takes a DIFFERENT escape route where possible, so the routes out of your area get covered one by one.
        // Flankers/blockers pick a position without crossing you (they can't path through the cells around you), hold it quietly,
        // ignore the flashlight unless it is actually shining ON them, and spring the ambush when you get within ambushDist.
        const SwarmCfg = {
            minPack: 2, chaserFrac: 0.4,        // pack size needed; share of the pack that chases head-on (at least 1)
            ambushDist: 7,                      // a holding hound attacks when you come this close with line of sight
            howlRange: 50, howlCD: 10,          // first hound to spot you calls every hound within 50 units; howl cooldown (s)
            depthMax: 14,                       // how far (in cells) from you the escape routes are mapped
            flankDepth: [4, 7], blockDepth: [8, 12], exitRange: 45,
            reassign: 1.0, sightMemory: 8       // targets recomputed every 1.0s; pack disbands after 8s with nobody seeing you
        };
        function openN(g, x, z) { return (g[z][x + 1] === 0 ? 1 : 0) + (g[z][x - 1] === 0 ? 1 : 0) + (g[z + 1][x] === 0 ? 1 : 0) + (g[z - 1][x] === 0 ? 1 : 0); }
        // Breadth-first flood fill. opts: block (cells within 1 of px,pz are impassable except the start), maxD, target [x,z] (stop early), branch (record first-step direction)
        function gridBFS(sx, sz, o) {
            const size = GameState.gridSize, g = GameState.grid, N = size * size, dist = new Int16Array(N).fill(-1), par = new Int32Array(N).fill(-1), br = o.branch ? new Int8Array(N).fill(-1) : null;
            const q = [sz * size + sx], tI = o.target ? o.target[1] * size + o.target[0] : -1, D = [[1, 0], [-1, 0], [0, 1], [0, -1]]; dist[q[0]] = 0;
            for (let qi = 0; qi < q.length; qi++) {
                const idx = q[qi], cx = idx % size, cz = (idx / size) | 0, d = dist[idx];
                if (idx === tI) break; if (o.maxD && d >= o.maxD) continue;
                for (let k = 0; k < 4; k++) {
                    const nx = cx + D[k][0], nz = cz + D[k][1]; if (nx < 1 || nz < 1 || nx >= size - 1 || nz >= size - 1 || g[nz][nx] !== 0) continue;
                    if (o.block && Math.abs(nx - o.px) <= 1 && Math.abs(nz - o.pz) <= 1) continue;
                    const ni = nz * size + nx; if (dist[ni] >= 0) continue;
                    dist[ni] = d + 1; par[ni] = idx; if (br) br[ni] = d === 0 ? k : br[idx]; q.push(ni);
                }
            }
            return { dist, par, br, size };
        }
        function houndPathDir(e, tx, tz, pp) { // unit direction toward the next cell on a route to (tx,tz) that never crosses the player
            const cs = GameState.cellSize, size = GameState.gridSize, cl = v => Math.max(1, Math.min(size - 2, v));
            const sx = cl(Math.round(e.mesh.position.x / cs)), sz = cl(Math.round(e.mesh.position.z / cs)), tgx = cl(Math.round(tx / cs)), tgz = cl(Math.round(tz / cs));
            if (sx === tgx && sz === tgz) return null;
            const B = gridBFS(sx, sz, { block: true, px: Math.round(pp.x / cs), pz: Math.round(pp.z / cs), target: [tgx, tgz] }), tI = tgz * size + tgx, sI = sz * size + sx;
            if (B.dist[tI] < 0) return null;
            let cur = tI; while (B.par[cur] !== sI && B.par[cur] >= 0) cur = B.par[cur];
            return new THREE.Vector3((cur % size) * cs - e.mesh.position.x, 0, ((cur / size) | 0) * cs - e.mesh.position.z).normalize();
        }
        const Swarm = {
            t: 0, n: 0, seen: 0, howlAt: 0, announced: false, lastPos: null, hd: new THREE.Vector3(0, 0, 1), _f: new THREE.Vector3(),
            howl(h, pp) { // the first hound to spot you calls the others
                const now = performance.now(); if (now < this.howlAt) return; this.howlAt = now + SwarmCfg.howlCD * 1000; let n = 0;
                for (const o of GameState.entities) {
                    if (o === h || o.type !== 'hound' || o.stunTimer > 0 || o.state === 'flee' || o.state === 'lunge' || o.mesh.position.distanceTo(pp) > SwarmCfg.howlRange) continue;
                    o.investigateTarget = pp.clone(); o.investigateTimer = 12; o.lastKnown = pp.clone(); o._hunt = 1; o._huntT = 6; o.ambushWait = 0; o._ambTgt = null; if (o.state !== 'swarm') o.state = 'investigate'; n++;
                }
                if (n) AudioSys.at(h.mesh.position).playMonsterSound('hound', 0);
            },
            dissolve(hs) { for (const h of hs) { h._role = null; h._swarmT = 0; if (h.state === 'swarm') h.state = 'wander'; } this.announced = false; },
            tick(dt, pp) {
                const hs = GameState.entities.filter(e => e.type === 'hound'); if (!hs.length) { this.announced = false; return; }
                // which way are you heading? (movement over the last frames, or where the camera points when standing still)
                if (this.lastPos) { const mx = pp.x - this.lastPos.x, mz = pp.z - this.lastPos.z, sp = Math.hypot(mx, mz) / Math.max(dt, 1e-3);
                    if (sp > 0.6) { this.hd.x += (mx / (sp * dt) - this.hd.x) * 0.15; this.hd.z += (mz / (sp * dt) - this.hd.z) * 0.15; }
                    else { camera.getWorldDirection(this._f); this.hd.x += (this._f.x - this.hd.x) * 0.1; this.hd.z += (this._f.z - this.hd.z) * 0.1; }
                    const m = Math.hypot(this.hd.x, this.hd.z) || 1; this.hd.x /= m; this.hd.z /= m; }
                (this.lastPos = this.lastPos || new THREE.Vector3()).copy(pp);
                hs.forEach(h => { if (h._swarmT > 0) h._swarmT -= dt; });
                const pack = hs.filter(h => h.stunTimer <= 0 && isHunting(h));
                const alive = DifficultyConfigs[GameState.difficulty].constantTracking || performance.now() - this.seen < SwarmCfg.sightMemory * 1000;
                if (pack.length < SwarmCfg.minPack || !alive) { if (hs.some(h => h._role)) this.dissolve(hs); return; }
                this.t -= dt; if (this.t > 0) return; this.t = SwarmCfg.reassign; this.assign(pack, pp);
            },
            assign(H, pp) {
                const cs = GameState.cellSize, size = GameState.gridSize, g = GameState.grid, cl = v => Math.max(1, Math.min(size - 2, v)), hd = this.hd, D = [[1, 0], [-1, 0], [0, 1], [0, -1]];
                const pcx = cl(Math.round(pp.x / cs)), pcz = cl(Math.round(pp.z / cs));
                const PB = gridBFS(pcx, pcz, { branch: true, maxD: SwarmCfg.depthMax });
                const branches = [0, 1, 2, 3].map(b => ({ b, cells: [], val: hd.x * D[b][0] + hd.z * D[b][1] }));
                for (let i = 0; i < PB.dist.length; i++) if (PB.dist[i] > 0 && PB.br[i] >= 0) branches[PB.br[i]].cells.push({ x: i % size, z: (i / size) | 0, d: PB.dist[i], i });
                const live = branches.filter(b => b.cells.length); live.forEach(b => b.val += 0.2 * Math.min(1, b.cells.length / 20));
                const deepest = (b, mx) => { let best = null; for (const c of b.cells) if (c.d <= mx && (!best || c.d > best.d)) best = c; return best; };
                const flank = b => { let best = null, bs = -9; for (const c of b.cells) { if (c.d < SwarmCfg.flankDepth[0] || c.d > SwarmCfg.flankDepth[1]) continue; const dx = c.x * cs - pp.x, dz = c.z * cs - pp.z, s2 = (dx * hd.x + dz * hd.z) / (Math.hypot(dx, dz) || 1); if (s2 > bs) { bs = s2; best = c; } } return best || deepest(b, SwarmCfg.flankDepth[1]); };
                const block = b => { let best = null; for (const c of b.cells) { if (c.d < SwarmCfg.blockDepth[0] || c.d > SwarmCfg.blockDepth[1] || openN(g, c.x, c.z) > 2) continue; if (!best || c.d > best.d) best = c; } return best || deepest(b, SwarmCfg.blockDepth[1]); };
                let exitC = null; { const ex = GameState.exitPos, ecx = cl(Math.round(ex.x / cs)), ecz = cl(Math.round(ex.z / cs)), ei = ecz * size + ecx;
                    if (Math.hypot(ex.x - pp.x, ex.z - pp.z) < SwarmCfg.exitRange && PB.dist[ei] > 2) exitC = { x: ecx, z: ecz, d: PB.dist[ei], i: ei }; }
                const byDist = [...H].sort((a, b) => a.mesh.position.distanceTo(pp) - b.mesh.position.distanceTo(pp));
                const nCh = Math.max(1, Math.round(H.length * SwarmCfg.chaserFrac)), chasers = byDist.slice(0, nCh), rest = byDist.slice(nCh).sort((a, b) => (a._id || (a._id = ++this.n)) - (b._id || (b._id = ++this.n)));
                chasers.forEach(h => { h._role = 'chaser'; h._swarmT = 0; });
                const usedF = new Set(), usedB = new Set(); let exitTaken = false;
                rest.forEach((h, i) => {
                    const role = i % 2 === 0 ? 'flanker' : 'blocker', used = role === 'flanker' ? usedF : usedB, hcx = cl(Math.round(h.mesh.position.x / cs)), hcz = cl(Math.round(h.mesh.position.z / cs));
                    const HB = gridBFS(hcx, hcz, { block: true, px: pcx, pz: pcz, maxD: 45 }); let pick = null;
                    for (const strict of [true, false]) { // first try routes nobody of this role has taken, then allow doubling up
                        let bs = 1e9;
                        const cands = []; if (role === 'blocker' && exitC && !exitTaken) cands.push({ c: exitC, key: 'exit', val: 1 });
                        for (const b of live) { if (strict && used.has(b.b)) continue; const c = role === 'flanker' ? flank(b) : block(b); if (c) cands.push({ c, key: b.b, val: b.val }); }
                        for (const k of cands) { const dd = HB.dist[k.c.i !== undefined ? k.c.i : k.c.z * size + k.c.x]; if (dd < 0) continue; const sc = dd - 6 * k.val; if (sc < bs) { bs = sc; pick = k; } }
                        if (pick) break;
                    }
                    if (!pick) { h._role = 'chaser'; h._swarmT = 0; return; }
                    used.add(pick.key); if (pick.key === 'exit') exitTaken = true;
                    h._role = role; h._swarmTgt = { x: pick.c.x * cs, z: pick.c.z * cs }; h._swarmT = SwarmCfg.reassign * 2.5; h._swT = 0;
                });
                if (!this.announced && rest.some(h => h._role === 'flanker' || h._role === 'blocker')) { this.announced = true; showEventBanner('THE HOUNDS HUNT AS A PACK - THEY ARE SPLITTING UP', 3); }
            }
        };

        // HUND AMBUSH (pack waits): hounds closer to the exit than the player take cover in a hallway and wait there.
        function houndAmbushTarget(e, pp) {
            const cs = GameState.cellSize, ex = GameState.exitPos;
            if (!ex) return null;
            const d = houndPathDir(e, Math.round(ex.x / cs), Math.round(ex.z / cs), pp);
            if (!d) return null;
            const depth = 5 + Math.random() * 5; // a few cells deeper in the hallway (shadows, corners)
            const x = e.mesh.position.x + d.x * cs * depth, z = e.mesh.position.z + d.z * cs * depth;
            const gx = Math.round(x / cs), gz = Math.round(z / cs);
            if (gx > 0 && gz > 0 && gx < GameState.gridSize - 1 && gz < GameState.gridSize - 1 && GameState.grid[gz] && GameState.grid[gz][gx] === 0) return new THREE.Vector3(x, 0, z);
            return null;
        }

        // --- SHARED ENTITY SPRINT (stamina-based; active on Extreme & Impossible) ---
        // Max 50, drains 12/s while sprinting, regenerates 7/s when not sprinting.
        const EntitySprint = {
            maxStam: 50, drain: 12, regen: 7,
            minStam: 40, lowStam: 20,   // normally: can't sprint again until >= 40; exception: >20 AND player > 6m away
            farDist: 6, sprintMult: 1.25 // sprint speed > player's running speed
        };
        // --- BACTERIUM ATTACKS: difficulty + sanity select the attack ---
        const bacteriaPunchRange = 5.5, bacteriaPunchDur = 2.5, bacteriaScreamDur = 2.5; // durations in seconds
        // Catching you is a normal jumpscare. The freeze is now the bacterium's ABILITY (see bacteriaAbilityTick): it is not distance-triggered.
        const bacteriaAttack = (e, dist) => { AudioSys.playBacteriaScream(); triggerJumpscare(e); };
        // Ability: only exists when the rig has a "bacteriaability" animation (ANIMATIONS.bacteria.bacteriaability). While the bacterium is chasing
        // you and within range, it rolls every few seconds; a successful roll plays that animation and freezes you for its length.
        const bacteriaAbilityChance = 0.45;
        function bacteriaAbilityTick(e, dt, p) {
            if (e._abilT > 0) e._abilT -= dt;
            const act = e._rig && e._rig.actions && e._rig.actions.bacteriaability; if (!act) return; // ability animation not set: no ability
            if (e.state !== 'chase' || e.stunTimer > 0 || (e._abilT > 0)) return;
            if (MP.active && e._tgtMe === false) return; // only the player it is actually hunting can be hit by it
            if (GameState.isJumpscaring || GameState.player._immob > 0 || GameState.graceTimer > 0 || (MP.active && MP.me.ghost)) return;
            if (e.mesh.position.distanceTo(p) > bacteriaPunchRange) { return; }
            e._abT = (e._abT == null ? 2 + Math.random() * 2 : e._abT) - dt; if (e._abT > 0) return;
            e._abT = 3 + Math.random() * 3; // next roll in 3-6 seconds
            if (Math.random() >= bacteriaAbilityChance) return;
            const dur = Math.max(1, Math.min(5, act.getClip().duration || 2.5));
            e._abilT = dur; GameState.player._immob = Math.max(GameState.player._immob, dur);
            AudioSys.playBacteriaScream(); AudioSys.playBacteriaPunch(); showEventBanner('THE BACTERIUM FREEZES YOU IN PLACE', 2);
            if (MP.active) MP.bcast({ t: 'abil', i: GameState.entities.indexOf(e), d: dur }); // other players only see the animation
        }

        // --- ENTITY AI CLASS ---
        class Entity {
            constructor(type, x, z) {
                this.type = type;
                this.state = 'wander';
                this.stam = EntitySprint.maxStam; this._sprinting = undefined; // shared sprint system (set each frame when active)
                this.stunTimer = 0;
                this.stunImmuneTimer = 0; // monsters get 5s of immunity after being stunned by anything (axe, crowbar, shotgun, ...)
                this.investigateTarget = null;
                this.investigateTimer = 0;
                this.pathRecalcTimer = Math.random() * 0.3;
                this.cachedPathDir = new THREE.Vector3();
                this.ambushWait = 0; this._ambTgt = null; // hound pack ambush: wait in a hallway until you're visible or close
                this.soundTimer = Math.random() * 4;
                this.animTime = Math.random() * 10;
                this.wanderDir = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();
                this.meleeRadius = 0; // larger central hitbox for reliable melee hits (set per type below)
                this.mesh = new THREE.Group();
                this.mesh.position.set(x, 2, z);

                if (type === 'bacteria') {
                    const mat = new THREE.MeshStandardMaterial({ color: 0x070707, roughness: 0.7, metalness: 0.4 });
                    const spine = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 2.9, 6), mat);
                    const head = new THREE.Mesh(new THREE.DodecahedronGeometry(0.28, 0), mat);
                    head.scale.set(0.85, 1.4, 0.9);
                    head.position.set(0, 1.65, 0.08);
                    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffee });
                    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.035), eyeMat);
                    eyeL.position.set(-0.08, 1.68, 0.28);
                    const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.035), eyeMat);
                    eyeR.position.set(0.08, 1.68, 0.28);
                    for (let r = 0; r < 5; r++) {
                        const rib = new THREE.Mesh(new THREE.TorusGeometry(0.22 - r * 0.02, 0.025, 5, 10), mat);
                        rib.rotation.x = Math.PI / 2;
                        rib.position.y = 0.4 + r * 0.2;
                        this.mesh.add(rib);
                    }
                    this.armL = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.025, 2.5, 5), mat);
                    this.armL.position.set(-0.34, 0.15, 0.1);
                    this.armL.rotation.set(0.25, 0, 0.18);
                    this.armR = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.025, 2.5, 5), mat);
                    this.armR.position.set(0.34, 0.15, 0.1);
                    this.armR.rotation.set(0.25, 0, -0.18);
                    this.mesh.add(spine, head, eyeL, eyeR, this.armL, this.armR);
                    this.baseSpeed = 4.1;
                } else if (type === 'skinstealer') {
                    const mat = new THREE.MeshStandardMaterial({ color: 0x9e7460, roughness: 0.45 });
                    const darkMat = new THREE.MeshBasicMaterial({ color: 0x080303 });
                    const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.2, 1.6, 8), mat);
                    torso.position.y = 0.4;
                    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 10), mat);
                    head.scale.set(0.9, 1.25, 0.95);
                    head.position.y = 1.48;
                    const socketL = new THREE.Mesh(new THREE.SphereGeometry(0.055), darkMat);
                    socketL.position.set(-0.09, 1.52, 0.22);
                    const socketR = new THREE.Mesh(new THREE.SphereGeometry(0.055), darkMat);
                    socketR.position.set(0.09, 1.52, 0.22);
                    const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.08), darkMat);
                    mouth.position.set(0, 1.32, 0.22);
                    this.armL = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.05, 1.7, 6), mat);
                    this.armL.position.set(-0.36, 0.35, 0.15);
                    this.armL.rotation.x = 0.4;
                    this.armR = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.05, 1.7, 6), mat);
                    this.armR.position.set(0.36, 0.35, 0.15);
                    this.armR.rotation.x = 0.4;
                    this.mesh.add(torso, head, socketL, socketR, mouth, this.armL, this.armR);
                    this.baseSpeed = 4.4;
                } else if (type === 'smiler') {
                    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 256; const c = cv.getContext('2d');
                    const draw = (col, dx, al) => { c.save(); c.translate(dx, 0); c.globalAlpha = al; c.fillStyle = col; c.beginPath(); c.ellipse(170, 80, 28, 15, 0, 0, 7); c.fill(); c.beginPath(); c.ellipse(342, 80, 28, 15, 0, 0, 7); c.fill();
                        c.beginPath(); c.arc(256, 100, 150, 0.14 * Math.PI, 0.86 * Math.PI); c.arc(256, 62, 150, 0.86 * Math.PI, 0.14 * Math.PI, true); c.fill(); c.restore(); };
                    c.globalCompositeOperation = 'lighter'; draw('#ff1e1e', -7, 0.9); draw('#1effff', 7, 0.9); draw('#ffffff', 0, 0.8); // anaglyph fringe on the texture only
                    const mat = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
                    const spr = new THREE.Sprite(mat); spr.scale.set(2.3, 1.15, 1); spr.position.y = 0.6; this.mesh.add(spr); const _v = new THREE.Vector3();
                    spr.onBeforeRender = (r, sc, cam) => { if (cam !== camera) { mat.opacity = 0.7; return; } const d = spr.getWorldPosition(_v).distanceTo(cam.position); mat.opacity = Math.max(0, Math.min(1, (16 - d) / 10)) * (Math.random() < 0.04 ? 0.35 : 1); };
                    this.baseSpeed = 4.6; this.meleeRadius = 2.6; // the smiler is a small flat plane: a sphere makes axe/crowbar hits reliable in VR
                } else if (type === 'hound') {
                    const mat = new THREE.MeshStandardMaterial({ color: 0x2b221e, roughness: 0.75 });
                    const body = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.5, 1.35), mat);
                    body.position.y = -1.1;
                    const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.42, 0.48), mat);
                    head.position.set(0, -0.95, 0.75);
                    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffaa00 });
                    const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.045), eyeMat);
                    eyeL.position.set(-0.13, -0.9, 0.99);
                    const eyeR = new THREE.Mesh(new THREE.SphereGeometry(0.045), eyeMat);
                    eyeR.position.set(0.13, -0.9, 0.99);
                    this.mesh.add(body, head, eyeL, eyeR);
                    for (const [lx, lz] of [[-0.25, 0.45], [0.25, 0.45], [-0.25, -0.45], [0.25, -0.45]]) {
                        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.04, 0.8), mat);
                        leg.position.set(lx, -1.5, lz);
                        this.mesh.add(leg);
                    }
                    this.baseSpeed = 5.1;
                } else if (type === 'window_watcher') {
                    const mat = new THREE.MeshStandardMaterial({ color: 0x050507, roughness: 0.85 });
                    const coat = new THREE.Mesh(new THREE.ConeGeometry(0.48, 3.1, 8), mat);
                    coat.position.y = -0.1;
                    const head = new THREE.Mesh(new THREE.SphereGeometry(0.26), mat);
                    head.position.y = 1.68;
                    const hatBrim = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.48, 0.04, 12), mat);
                    hatBrim.position.y = 1.84;
                    const eyeMat = new THREE.MeshBasicMaterial({ color: 0xddeeff });
                    const eye1 = new THREE.Mesh(new THREE.SphereGeometry(0.05), eyeMat);
                    eye1.position.set(0.09, 1.7, 0.23);
                    const eye2 = new THREE.Mesh(new THREE.SphereGeometry(0.05), eyeMat);
                    eye2.position.set(-0.09, 1.7, 0.23);
                    this.mesh.add(coat, head, hatBrim, eye1, eye2);
                    this.baseSpeed = 3.9;
                }

                // Stun indicator ring (visible when shot with shotgun on Extreme)
                this.stunRing = new THREE.Mesh(
                    new THREE.TorusGeometry(0.55, 0.04, 6, 16),
                    new THREE.MeshBasicMaterial({ color: 0xffaa00 })
                );
                this.stunRing.rotation.x = Math.PI / 2;
                this.stunRing.position.y = 1.9;
                this.stunRing.visible = false;
                this.mesh.add(this.stunRing);

                scene.add(this.mesh);
                GameState.entities.push(this);
            }

            alertToPosition(targetPos, duration = 12) {
                if (this.stunTimer > 0) return;
                this.investigateTarget = targetPos.clone();
                this.investigateTimer = duration;
                if (this.state === 'wander') {
                    this.state = 'investigate';
                }
            }

            stun(seconds) {
                if (this.stunImmuneTimer > 0) return; // immunity from a previous stun (5s after the last stun)
                let imm = 5;
                if (MP.active) { // multiplayer balance: shorter stuns the more stunning items the lobby carries, longer immunity (+10% per player)
                    if (!this._ns && seconds > 2.5) seconds = MP.stunSecs(seconds);
                    imm = 5 * MP.immMult();
                    if (!this._net) MP.sendStun(GameState.entities.indexOf(this), seconds);
                }
                this._ns = false; this._net = false;
                this.stunTimer = seconds;
                this.stunImmuneTimer = seconds + imm; // re-stunning is blocked for 5s after this stun ends
                this.state = 'stunned';
                this.stunRing.visible = true;
            }

            // Corner investigation (Normal+): turning a corner alone does not end the chase while you stay near
            // the player's last known spot (see DifficultyConfigs.cornerChase).
            cornerKeepChase(playerPos) {
                const d = DifficultyConfigs[GameState.difficulty];
                return !!(d.cornerChase && this.lastKnown && playerPos.distanceTo(this.lastKnown) < 15);
            }
            hasLineOfSight(playerPos) {
                const diffCfg = DifficultyConfigs[GameState.difficulty];
                const dist = this.mesh.position.distanceTo(playerPos);
                if (dist > diffCfg.visionRange) return false;

                // On Easy mode, monsters have narrow/bad line of sight cone unless player is very close
                if (diffCfg.visionConeDot > -0.5 && dist > 4.5) {
                    const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(this.mesh.quaternion);
                    const toPlayer = new THREE.Vector3().subVectors(playerPos, this.mesh.position).setY(0).normalize();
                    if (forward.dot(toPlayer) < diffCfg.visionConeDot) {
                        return false;
                    }
                }

                const steps = Math.ceil(dist / (GameState.cellSize * 0.45));
                const cs = GameState.cellSize;
                for (let i = 1; i < steps; i++) {
                    const t = i / steps;
                    const x = this.mesh.position.x + (playerPos.x - this.mesh.position.x) * t;
                    const z = this.mesh.position.z + (playerPos.z - this.mesh.position.z) * t;
                    const gx = Math.round(x / cs);
                    const gz = Math.round(z / cs);
                    if (GameState.grid[gz] && GameState.grid[gz][gx] === 1) return false;
                }
                return true;
            }

            update(dt, playerPos) {
                const diffCfg = DifficultyConfigs[GameState.difficulty];
                const dist = this.mesh.position.distanceTo(playerPos);

                // Handle shotgun 20s stun or Easy mode 2s pause
                if (this.stunImmuneTimer > 0) this.stunImmuneTimer -= dt;
                if (this._arc) { Attraction.arcStep(this, dt); return; } // boss minion being launched
                if (this.stunTimer > 0) {
                    this.stunTimer -= dt;
                    this.stunRing.rotation.z += dt * 5;
                    this.mesh.position.y = 1.85;
                    if (this.stunTimer <= 0) {
                        this.stunRing.visible = false;
                        this.state = (this._lungeStun && this.investigateTarget) ? 'investigate' : 'wander'; if (this._minion) { this.state = 'chase'; this.investigateTimer = 999; }
                        this._lungeStun = false; this.pathRecalcTimer = 0;
                    }
                    return;
                }
                this.stunRing.visible = false;

                if (GameState.globalMonsterPauseTimer > 0) {
                    return;
                }

                // Catch Check
                if (dist < 1.45 && !GameState._rt && GameState.graceTimer <= 0) {
                    if (this._minion) { Attraction.minionHit(this); return; } // boss minions: -10% sanity + their own 1.5s stun, never an instant kill
                    if (GameState.chancesRemaining > 1) {
                        // Easy mode first catch: survive with 1 chance left, pause monsters for 2.0s!
                        GameState.chancesRemaining -= 1;
                        GameState.globalMonsterPauseTimer = 2.0;
                        GameState.graceTimer = 2.6;
                        this.stun(2.0);
                        AudioSys.playSecondChanceHit();
                        showEventBanner("CAUGHT! 1 CHANCE REMAINING — MONSTERS PAUSED FOR 2s!", 3.0);
                        document.getElementById('lives-hud').innerText = `CHANCES REMAINING: ${GameState.chancesRemaining}`;
                        document.getElementById('lives-hud').style.color = '#ffaa33';
                        return;
                    } else {
                        if (this.type === 'bacteria') bacteriaAttack(this, dist); else triggerJumpscare(this);
                        return;
                    }
                }

                const hasLOS = this.hasLineOfSight(playerPos);
                const prevState = this.state;
                if (this.type === 'hound' && hasLOS) Swarm.seen = performance.now();

                // HUND AMBUSH (pack waits): hounds closer to the exit than the player hold up in a hallway and wait
                if (this.type === 'hound' && this.stunTimer <= 0 && this.state !== 'lunge' && this.state !== 'flee' && this.state !== 'stunned') {
                    if (this.ambushWait) {
                        if (dist < SwarmCfg.ambushDist || hasLOS) { // player visible or close: spring the ambush
                            this.ambushWait = 0; this._ambTgt = null;
                            this.state = 'lunge'; this._lungeT = 0; this._lungeCD = 0; this._fleeRecalc = 0;
                        } else if (!this._ambTgt) this.state = 'wander'; else this.state = 'ambush_wait';
                    } else if (GameState.exitPos && this.state === 'wander' && dist > 14 && this.mesh.position.distanceTo(GameState.exitPos) < playerPos.distanceTo(GameState.exitPos)) {
                        this.ambushWait = 1; this._ambTgt = houndAmbushTarget(this, playerPos); if (!this._ambTgt) this.ambushWait = 0;
                    }
                }

                this.animTime += dt * (this.state === 'chase' ? 12 : 4);
                if (this.armL && this.armR) {
                    this.armL.rotation.x = 0.3 + Math.sin(this.animTime) * 0.45;
                    this.armR.rotation.x = 0.3 - Math.sin(this.animTime) * 0.45;
                }
                this.mesh.position.y = 2 + Math.abs(Math.sin(this.animTime)) * 0.08;
                if (GameState.poolFl) { // swimming: float at the surface, or dive toward a submerged player
                    const ef = ((GameState.poolFl[Math.round(this.mesh.position.z / GameState.cellSize)] || [])[Math.round(this.mesh.position.x / GameState.cellSize)]) || 0;
                    let tgt = 2; if (ef < -0.3) tgt = (playerPos.y < -0.5 && dist < 18) ? Math.max(ef + 1, Math.min(playerPos.y - 0.3, 1.0)) : -0.22 + 1.1;
                    this.swimY = (this.swimY === undefined ? 2 : this.swimY); this.swimY += (tgt - this.swimY) * Math.min(1, dt * 3);
                    this.mesh.position.y = this.swimY + (ef < -0.3 ? Math.sin(this.animTime * 0.5) * 0.1 : 0);
                }

                this.soundTimer -= dt;
                if (this.soundTimer <= 0) {
                    if (this.ambushWait) this.soundTimer = 6; // waiting hounds stay silent so their staleness goes unnoticed
                    else {
                        this.soundTimer = (this.state === 'chase' ? 1.8 : 4.2) + Math.random() * 3;
                        AudioSys.at(this.mesh.position).playMonsterSound(this.type, dist);
                    }
                }

                // Impossible mode: monsters constantly know where you are
                if (diffCfg.constantTracking) {
                    this.state = 'chase';
                } else {
                    if (this.type === 'bacteria') {
                        if (hasLOS && (GameState.player.flashlightOn || dist < (diffCfg.id === 'easy' ? 6 : 10))) {
                            this.state = 'chase';
                        } else if (!hasLOS && this.state === 'chase') {
                            this.state = this.cornerKeepChase(playerPos) ? 'chase' : (this.investigateTimer > 0 ? 'investigate' : 'wander');
                        }
                    } else if (this.type === 'skinstealer') {
                        const detectClose = diffCfg.id === 'easy' ? 6.5 : 11;
                        const detectFlash = diffCfg.id === 'easy' ? 11 : 19;
                        if (hasLOS && (dist < detectClose || (GameState.player.flashlightOn && dist < detectFlash))) {
                            this.state = 'chase';
                        } else if (!hasLOS && this.state === 'chase') {
                            this.state = this.cornerKeepChase(playerPos) ? 'chase' : (this.investigateTimer > 0 ? 'investigate' : 'wander');
                        }
                    } else if (this.type === 'smiler') {
                        if (hasLOS) {
                            const camDir = new THREE.Vector3();
                            camera.getWorldDirection(camDir);
                            const toEntity = new THREE.Vector3().subVectors(this.mesh.position, playerPos).normalize();
                            if (camDir.dot(toEntity) > 0.7) {
                                GameState.player.sanity -= 5 * diffCfg.sanityDrainMult * PermaFx.sanDrain() * dt;
                                this.state = GameState.player.flashlightOn ? 'light_freeze' : 'chase';
                            } else {
                                this.state = 'chase';
                            }
                        } else if (this.state !== 'investigate') {
                            this.state = this.cornerKeepChase(playerPos) ? 'chase' : 'wander'; // Normal+: don't abandon the chase when LOS breaks
                        }
                    } else if (this.type === 'hound') {
                        this._lungeCD = Math.max(0, (this._lungeCD || 0) - dt);
                        if (this.state === 'lunge') {
                            this._lungeT = (this._lungeT || 0) + dt;
                            if (!GameState.player.flashlightOn) this.state = 'chase';            // light already off: nothing to flick, just hunt
                            else if (dist < HoundCfg.lungeHit && !GameState._rt) { houndLungeHit(this, playerPos); return; }
                            else if (this._lungeT > HoundCfg.lungeTime) { this.state = 'flee'; this._lungeCD = HoundCfg.lungeCooldown; this._corner = 0; this._fleeRecalc = 0; } // missed (blocked)
                        } else if (hasLOS) {
                            const swm = this._role && this._role !== 'chaser' && this._swarmT > 0; // a pack flanker/blocker only backs off when your beam is actually on it
                            if (GameState.player.flashlightOn && (!swm || houndInBeam(this))) {
                                if (this.state !== 'flee') { this._fleeRecalc = 0; this._corner = 0; }
                                this.state = 'flee'; this._fleeHold = 2;
                            } else {
                                this.state = 'chase';
                            }
                        } else if (this.state === 'flee' && (this._fleeHold = (this._fleeHold || 0) - dt) > 0) {
                            // lost sight: keep running to the hiding spot for a moment
                        } else if (this.state !== 'investigate') {
                            if (this.ambushWait) { /* waiting quietly in a hallway */ }
                            else this.state = this.cornerKeepChase(playerPos) ? 'chase' : 'wander';
                        }
                    } else if (this.type === 'window_watcher') {
                        if (hasLOS) {
                            const camDir = new THREE.Vector3();
                            camera.getWorldDirection(camDir);
                            const toEntity = new THREE.Vector3().subVectors(this.mesh.position, playerPos).normalize();
                            if (camDir.dot(toEntity) > 0.75 && GameState.player.flashlightOn) {
                                this.state = 'light_freeze';
                            } else {
                                this.state = 'chase';
                            }
                        } else if (this.state !== 'investigate') {
                            this.state = this.cornerKeepChase(playerPos) ? 'chase' : 'wander';
                        }
                    }
                }

                if (this.type === 'hound' && this._role && this._role !== 'chaser' && this._swarmT > 0 && this.state !== 'flee' && this.state !== 'lunge' && this.state !== 'stunned') {
                    if (hasLOS && dist < SwarmCfg.ambushDist) { this.state = 'chase'; this._role = 'chaser'; this._swarmT = 0; } // trap sprung
                    else this.state = 'swarm';
                }
                if (this.type === 'hound' && this.state === 'chase' && prevState !== 'chase') Swarm.howl(this, playerPos);

                if (hasLOS) this.lastKnown = playerPos.clone(); // Normal+: keep tracking so cornerKeepChase can retain the chase

                if (this.investigateTimer > 0) {
                    this.investigateTimer -= dt;
                    if (this.investigateTimer <= 0 && this.state === 'investigate') {
                        this.state = 'wander';
                    }
                }

                if (this.state === 'chase' && prevState !== 'chase' && !this._hunt && performance.now() - (GameState.lastSting || 0) > 9000) { GameState.lastSting = performance.now(); if (!Settings.nightmare) { AudioSys.playMonsterSpot(); AudioSys.playChaseStinger(); } }

                if (this.state === 'light_freeze') return;

                // Speed scaled by difficulty & clamped appropriately
                let scaledBase = this.baseSpeed * diffCfg.monsterSpeedMult;
                if (GameState.lightsOutEvent) scaledBase *= 1.25;
                let currentSpeed = Math.min(diffCfg.monsterMaxSpeedCap, scaledBase);

                // Shared stamina sprint (Extreme & Impossible): entities sprint actively while pursuing
                let sprinting = false;
                if (diffCfg.id === 'extreme' || diffCfg.id === 'impossible') {
                    if (this.state === 'chase' && dist > 0.5) {
                        if (this._sprinting) sprinting = this.stam > 0 && dist > EntitySprint.farDist; // hysteresis: keep sprinting until exhausted
                        else sprinting = this.stam >= EntitySprint.minStam || (this.stam > EntitySprint.lowStam && dist > EntitySprint.farDist);
                    }
                    this._sprinting = sprinting;
                    this.stam = Math.max(0, Math.min(EntitySprint.maxStam, this.stam + (sprinting ? -EntitySprint.drain : EntitySprint.regen) * dt));
                    if (sprinting) currentSpeed = Math.min(diffCfg.monsterMaxSpeedCap * EntitySprint.sprintMult, currentSpeed * EntitySprint.sprintMult); // faster than player's running speed
                }

                if (this._doom) currentSpeed = Math.max(currentSpeed, 11.5); // the shopkeeper's skinstealer: faster than you can sprint, on every difficulty
                let moveDir = new THREE.Vector3();
                this.pathRecalcTimer -= dt;

                if (this.state === 'chase') {
                    if (hasLOS || this._doom) { // the shopkeeper's skinstealer ignores the grid: straight at you through the shop walls
                        moveDir.subVectors(playerPos, this.mesh.position).setY(0).normalize();
                    } else {
                        // Use grid pathfinding around corners when tracking/chasing without direct LOS
                        if (this.pathRecalcTimer <= 0) {
                            this.pathRecalcTimer = 0.35;
                            this.cachedPathDir = getNextGridStep(this.mesh.position.x, this.mesh.position.z, playerPos.x, playerPos.z);
                        }
                        moveDir.copy(this.cachedPathDir);
                    }
                } else if (this.state === 'investigate' && this.investigateTarget) {
                    if (this.cornerKeepChase(playerPos)) this.state = 'chase'; // player is within range: continue pursuing
                    if (this.state === 'investigate') {
                        if (this.pathRecalcTimer <= 0) {
                            this.pathRecalcTimer = 0.4;
                            this.cachedPathDir = getNextGridStep(this.mesh.position.x, this.mesh.position.z, this.investigateTarget.x, this.investigateTarget.z);
                        }
                        moveDir.copy(this.cachedPathDir);
                        currentSpeed *= 0.92;
                        if (this.mesh.position.distanceTo(this.investigateTarget) < 2.0) {
                            this.state = 'wander';
                            this.investigateTimer = 0;
                        }
                    }
                } else if (this.state === 'swarm') { // flanker / blocker: go to its post without crossing the player
                    const T = this._swarmTgt;
                    if (T) {
                        if (this._role === 'blocker' && Math.hypot(T.x - this.mesh.position.x, T.z - this.mesh.position.z) < 1.6) {
                            moveDir.set(0, 0, 0); turnTo(this.mesh, playerPos.x - this.mesh.position.x, playerPos.z - this.mesh.position.z, dt, 3); // holding the hall, watching you
                        } else {
                            this._swT = (this._swT || 0) - dt;
                            if (this._swT <= 0) { this._swT = 0.3; this._swDir = houndPathDir(this, T.x, T.z, playerPos); }
                            if (this._swDir) moveDir.copy(this._swDir); else moveDir.subVectors(playerPos, this.mesh.position).setY(0).normalize();
                            if (this._role === 'flanker') currentSpeed *= 1.1;
                        }
                    }
                } else if (this.state === 'lunge') {
                    moveDir.subVectors(playerPos, this.mesh.position).setY(0).normalize();
                    currentSpeed *= HoundCfg.lungeSpeed;
                } else if (this.state === 'flee') {
                    currentSpeed *= 1.15;
                    this._fleeRecalc = (this._fleeRecalc || 0) - dt;
                    if (this._fleeRecalc <= 0) { this._fleeRecalc = 0.25; this._fleeInfo = houndHideSpot(this, playerPos); }
                    const F = this._fleeInfo, csz = GameState.cellSize;
                    if (F && F.first) {
                        this._corner = 0;
                        moveDir.set(F.first[0] * csz - this.mesh.position.x, 0, F.first[1] * csz - this.mesh.position.z).normalize();
                    } else { // cornered: nowhere to hide and nowhere farther -> stand its ground, then lunge
                        this._corner = (this._corner || 0) + dt;
                        turnTo(this.mesh, playerPos.x - this.mesh.position.x, playerPos.z - this.mesh.position.z, dt, 6);
                        if (this._corner >= HoundCfg.cornerTime && dist < HoundCfg.lungeRange && (this._lungeCD || 0) <= 0 && GameState.player.flashlightOn) {
                            this.state = 'lunge'; this._lungeT = 0; this._corner = 0; AudioSys.at(this.mesh.position).playMonsterSound('hound', 0);
                        }
                    }
                } else if (this.state === 'ambush_wait') {
                    const T = this._ambTgt;
                    if (T && this.mesh.position.distanceTo(T) > 1.5) moveDir.set(T.x - this.mesh.position.x, 0, T.z - this.mesh.position.z).normalize();
                    currentSpeed *= 0.2;
                    turnTo(this.mesh, playerPos.x - this.mesh.position.x, playerPos.z - this.mesh.position.z, dt, 2.8); // keep watching them
                } else {
                    moveDir.copy(this.wanderDir);
                    currentSpeed *= 0.45;
                }

                const step = moveDir.clone().multiplyScalar(currentSpeed * dt);
                const nextX = this.mesh.position.x + step.x;
                const nextZ = this.mesh.position.z + step.z;
                const cs = GameState.cellSize;

                const canMoveX = this._doom || GameState.grid[Math.round(this.mesh.position.z / cs)]?.[Math.round(nextX / cs)] === 0;
                const canMoveZ = this._doom || GameState.grid[Math.round(nextZ / cs)]?.[Math.round(this.mesh.position.x / cs)] === 0;

                if (canMoveX) {
                    this.mesh.position.x = nextX;
                } else if (this.state === 'wander') {
                    this.wanderDir.x *= -1;
                }

                if (canMoveZ) {
                    this.mesh.position.z = nextZ;
                } else if (this.state === 'wander') {
                    this.wanderDir.z *= -1;
                }

                if (moveDir.lengthSq() > 0.001) {
                    turnTo(this.mesh, moveDir.x, moveDir.z, dt, this.state === 'chase' ? 4.2 : 2.4);
                }
            }
        }

        // --- LEVEL BUILDER WITH CEILING LIGHTS, REFLECTIONS & SHOTGUN SPAWNS ---
        function buildLevel(levelIdx, shopMode = false) { const r = _buildLevelOuter(levelIdx, shopMode); GameState._needWarm = true; return r; }
        function _buildLevelOuter(levelIdx, shopMode = false) { // multiplayer: every client builds the same level from a shared seed (more players = more loot)
            if (!MP.active) return _buildLevelInner(levelIdx, shopMode);
            const sd = MP.seedFor(levelIdx); MP.prepLoot(true);
            try { mpWithSeed(sd, () => _buildLevelInner(levelIdx, shopMode)); } finally { MP.prepLoot(false); }
            const ps = GameState.pendingSpawn;
            if (ps) GameState.pendingSpawn = () => { MP.prepLoot(true); try { mpWithSeed(sd + 7919, ps); } finally { MP.prepLoot(false); } MP.afterSpawn(); };
            if (shopMode) MP.afterShopBuilt(); else MP.afterSpawn();
        }
        function _buildLevelInner(levelIdx, shopMode = false) {
            GameState.level = levelIdx;
            const data = LevelData[levelIdx];
            Attraction.reset(); Haven.reset(); if (data.thalasso) Attraction.cpSave(); // Level 7 entry = inventory checkpoint for the Level 8 bossfight
            const diffCfg = DifficultyConfigs[GameState.difficulty];
            const cs = GameState.cellSize;
            GameState.baseGrid = GameState.baseGrid || GameState.gridSize; const size = data.gridSize || GameState.baseGrid; GameState.gridSize = size;

            // Update UI & Atmosphere based on Level + Difficulty
            document.getElementById('level-text').innerText = data.name;
            document.getElementById('objective-text').innerText = data.objective;

            const pbf = diffCfg.pitchBlackFog || (typeof Settings !== 'undefined' && Settings.nightmare); // Nightmare: pitch-black fog on every difficulty
            const activeFogColor = (pbf || data.gimmick === 'blackout') ? 0x000000 : data.fogColor;
            const activeFogDensity = data.fogDensity * diffCfg.fogDensityMult * PermaFx.fog();

            scene.fog = new THREE.FogExp2(activeFogColor, activeFogDensity); GameState.baseFogD = activeFogDensity;
            scene.background = new THREE.Color(activeFogColor);
            ambientLight.color.setHex((pbf || data.gimmick === 'blackout') ? 0x08080a : data.ambientLight);
            ambientLight.intensity = (pbf || data.gimmick === 'blackout') ? 0.16 : (data.pools ? 0.75 : 0.28);

            GameState.lightsOutEvent = false;
            GameState.lightsOutTimer = 35;
            GameState.shotgunSpawnedInWorld = false;
            GameState.shotgunSpawnTimer = 10 + Math.random() * 10;

            applyGraphicsSettings();

            // Clear previous level objects
            for (let i = scene.children.length - 1; i >= 0; i--) {
                const obj = scene.children[i];
                if (obj !== controls.getObject() && obj !== ambientLight) {
                    scene.remove(obj);
                }
            }
            if (GameState.floorReflector) {
                if (GameState.floorReflector.dispose) GameState.floorReflector.dispose();
                GameState.floorReflector = null;
            }
            GameState.entities = [];
            GameState.items = [];
            GameState.props = [];
            GameState.ceilingLights = [];
            GameState.rtBounceLights = [];

            // Generate Layout (each level picks its own generator - see LevelData[].layout)
            GameState.grid = generateLayout(data, size);
            GameState.colliders = []; GameState.chests = []; GameState.crates = []; GameState.locArrow = null;
            GameState.poolDepth = null; GameState.oceanCells = null; GameState.secretWallCell = null; GameState.secretWallFound = false; GameState.subDoor = null; GameState.levExp = 0; GameState.exitFx = [];
            GameState.swimLevel = 0; GameState.oceanScareTimer = 4 + Math.random() * 6; GameState.poolFl = null; GameState.whirls = []; GameState.glitchPanels = []; GameState.tinies = []; GameState.uw = false; GameState.uwK = data.thalasso ? 0.55 : 1; GameState.levs = []; GameState.lures = []; GameState.bursts = []; GameState.eyeY = 2; GameState.vy = 0; GameState.swimming = false; GameState.poolFloorInst = null;
            if (data.hallway) { // one long snaking 3-wide hallway from the top-left to the far corner
                const g = GameState.grid; for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) g[z][x] = 1;
                let kmax = 0; while (1 + 4 * (kmax + 1) + 2 < size - 1) kmax++; if (kmax % 2) kmax--;
                for (let k = 0; k <= kmax; k++) { const r = 1 + 4 * k; for (let z = r; z < r + 3; z++) for (let x = 1; x < size - 1; x++) g[z][x] = 0;
                    if (k < kmax) { const cx = k % 2 === 0 ? size - 4 : 1; for (let z = r + 2; z <= r + 4; z++) for (let x = cx; x < cx + 3; x++) g[z][x] = 0; } }
            }

            ShopRadio.stop(); GameState.inShop = shopMode; GameState.shopTick = null; GameState.pendingSpawn = null; GameState.sliders = []; GameState.shopOpen = false; GameState.shopSliding = false; GameState.poolFloor = null;
            { const sp = document.getElementById('shop-prompt'); if (sp) sp.style.display = 'none'; }
            const _amb = [ambientLight.color.getHex(), ambientLight.intensity];
            if (shopMode) { shopCarve(GameState.grid, size); GameState._shopSan = GameState.player.sanity; GameState._shopBat = GameState.player.battery; }
            if (data.haven) { Haven.build(cs, size, shopMode, _amb); return; } // Level 9 builds its own world

            const gfx = GameState.graphics;
            const useReflections = gfx.reflections !== 'off';
            const usePlanarReflections = gfx.reflections === 'planar' && !data.pools;
            const isRayOrPathTraced = gfx.rtMode === 'raytracing' || gfx.rtMode === 'pathtracing';

            // Floor & Ceiling Planes with PBR Roughness Maps & Optional Real-Time Planar Ray Reflections
            const worldDim = size * cs;
            if (usePlanarReflections) {
                const gl = renderer.getContext();
                const maxHwTex = gl ? (gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048) : 2048;
                const mirrorTexSize = Math.min(1024, maxHwTex >= 8192 ? 1024 : 512);
                const reflector = new Reflector(new THREE.PlaneGeometry(worldDim, worldDim), {
                    clipBias: 0.003,
                    textureWidth: mirrorTexSize,
                    textureHeight: mirrorTexSize,
                    color: 0x666666
                });
                reflector.rotation.x = -Math.PI / 2;
                reflector.position.set(worldDim / 2, 0.001, worldDim / 2);
                scene.add(reflector);
                GameState.floorReflector = reflector;
            }

            const floorMat = new THREE.MeshStandardMaterial({
                map: TextureGen.create(data.floorTex),
                roughnessMap: useReflections ? TextureGen.createRoughness(data.floorTex) : null,
                roughness: usePlanarReflections ? 0.35 : (useReflections ? 0.72 : 0.96),
                metalness: usePlanarReflections ? 0.28 : (useReflections ? 0.12 : 0.0),
                envMapIntensity: useReflections ? (isRayOrPathTraced ? 2.1 : 1.45) : 0.0,
                transparent: usePlanarReflections,
                opacity: usePlanarReflections ? 0.74 : 1.0
            });
            const floor = new THREE.Mesh(new THREE.PlaneGeometry(worldDim, worldDim), floorMat);
            floor.rotation.x = -Math.PI / 2;
            floor.position.set(worldDim / 2, usePlanarReflections ? 0.005 : 0, worldDim / 2);
            floor.receiveShadow = gfx.shadowSize > 0;
            scene.add(floor);
            let poolTile = null, poolBasinMat = null;
            if (data.pools) { // wet ceramic tile, built per cell so pools can be cut into the floor later
                scene.remove(floor);
                poolTile = new THREE.MeshPhysicalMaterial({ map: TextureGen.create('pool_tile'), roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06, envMapIntensity: 1.8 });
                poolBasinMat = new THREE.MeshPhysicalMaterial({ map: TextureGen.create('pool_tile'), color: 0x9edcec, roughness: 0.14, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.6, side: THREE.DoubleSide });
                const fg = new THREE.PlaneGeometry(cs, cs), fc = []; GameState.poolFloor = {};
                for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) if (GameState.grid[z][x] === 0 || (shopMode && x === 7 && z >= 1 && z <= 3)) fc.push([x, z]);
                const fi = new THREE.InstancedMesh(fg, poolTile, fc.length), mt = new THREE.Matrix4(), qa = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)), one = new THREE.Vector3(1, 1, 1);
                fc.forEach(([x, z], i) => { mt.compose(new THREE.Vector3(x * cs, 0.002, z * cs), qa, one); fi.setMatrixAt(i, mt); GameState.poolFloor[x + ',' + z] = i; });
                fi.frustumCulled = false; scene.add(fi); GameState.poolFloorInst = fi;
            }

            const ceilMat = new THREE.MeshStandardMaterial({
                map: TextureGen.create(data.ceilTex),
                roughness: 0.75,
                metalness: 0.1,
                envMapIntensity: useReflections ? 0.8 : 0.0
            });
            const ceilH = data.ceilH || 4; // per-level room height
            const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(worldDim, worldDim), ceilMat);
            ceiling.rotation.x = Math.PI / 2;
            ceiling.position.set(worldDim / 2, ceilH, worldDim / 2);
            scene.add(ceiling);

            // Build Walls & Collect Open Cells
            const wallMat = new THREE.MeshStandardMaterial({
                map: TextureGen.create(data.wallTex),
                roughness: isRayOrPathTraced ? 0.62 : 0.78,
                metalness: isRayOrPathTraced ? 0.14 : 0.08,
                envMapIntensity: useReflections ? (isRayOrPathTraced ? 1.35 : 0.9) : 0.0
            });
            const wallGeo = new THREE.BoxGeometry(cs, ceilH, cs);
            if (data.pools) { wallMat.map = TextureGen.create('pool_tile').clone(); wallMat.map.repeat.set(1, ceilH / cs); wallMat.map.needsUpdate = true; wallMat.roughness = 0.16; wallMat.metalness = 0; wallMat.envMapIntensity = 1.7; }
            if (data.thalasso) { wallMat.map = TextureGen.create('concrete_dark').clone(); wallMat.map.repeat.set(1, 8); wallMat.map.needsUpdate = true; wallMat.color.setHex(0x2d383c); wallMat.roughness = 0.97; wallMat.envMapIntensity = 0.2; ceilMat.color.setHex(0x2c3b45); }
            const poolWallCells = [];
            const instWalls = [];
            const shopWallMat = shopMode ? new THREE.MeshStandardMaterial({ map: TextureGen.create(LevelData[0].wallTex), roughness: 0.85 }) : null;
            const openCells = [];

            // Shared geometries/materials for ceiling light fixtures & reflective floor puddles
            const fixtureFrameGeo = new THREE.BoxGeometry(1.5, 0.08, 0.75);
            const fixtureFrameMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8, roughness: 0.3 });
            const fixturePanelGeo = new THREE.BoxGeometry(1.32, 0.04, 0.58);
            const puddleGeo = new THREE.CircleGeometry(1.35, 16);
            const puddleMat = new THREE.MeshPhysicalMaterial({
                color: 0x11151c,
                roughness: 0.04,
                metalness: 0.2,
                clearcoat: 1.0,
                clearcoatRoughness: 0.03,
                transparent: true,
                opacity: usePlanarReflections ? 0.42 : 0.55,
                envMapIntensity: isRayOrPathTraced ? 2.8 : 2.2
            });

            let realPointLightCount = 0;
            const maxRealPointLights = gfx.maxLights;
            const fixtureStride = data.pools ? 5 : (gfx.maxLights >= 32 ? 2 : 4);

            for (let z = 0; z < size; z++) {
                for (let x = 0; x < size; x++) {
                    if (GameState.grid[z][x] === 1) {
                        if (shopMode && x === 4 && z === 1) continue; // solid cell: drawn as the shop stand
                        const isSl = shopMode && x === 7 && z >= 1 && z <= 3;
                        if (data.pools && !isSl) { poolWallCells.push([x, z]); continue; }
                        if (data.attraction && !(((GameState.grid[z - 1] || [])[x] === 0) || ((GameState.grid[z + 1] || [])[x] === 0) || GameState.grid[z][x - 1] === 0 || GameState.grid[z][x + 1] === 0)) continue; // never visible
                        const isBrk = data.attraction && GameState.attrGen && GameState.attrGen.breaks.some(k => k.gx === x && k.gz === z);
                        if (!isSl && !isBrk) { instWalls.push([x, z]); continue; } // ordinary walls are drawn as ONE instanced mesh (far fewer draw calls / faster level load)
                        const wall = new THREE.Mesh(wallGeo, isSl ? shopWallMat : wallMat);
                        if (data.attraction) Attraction.wallMade(x, z, wall);
                        if (isSl) GameState.sliders.push(wall);
                        wall.position.set(x * cs, ceilH / 2, z * cs);
                        wall.castShadow = gfx.shadowSize > 0;
                        wall.receiveShadow = gfx.shadowSize > 0;
                        scene.add(wall);
                    } else {
                        if (x > 4 || z > 4) {
                            openCells.push({ x: x * cs, z: z * cs });
                        }

                        // Place Occasional Ceiling Light Fixtures that explain the ambient light & illuminate surroundings
                        if (data.attraction ? (x % 4 === 1 && z % 4 === 1 && Math.random() < 0.5) : (x % fixtureStride === 1 && z % fixtureStride === 1)) {
                            const fx = x * cs;
                            const fz = z * cs, fy = data.attraction ? Attraction.fixY(x, z, ceilH) : ceilH;

                            const frame = new THREE.Mesh(fixtureFrameGeo, fixtureFrameMat);
                            frame.position.set(fx, fy - 0.04, fz);
                            scene.add(frame);

                            const panelMat = new THREE.MeshStandardMaterial({
                                color: data.fixtureColor,
                                emissive: data.fixtureColor,
                                emissiveIntensity: diffCfg.pitchBlackFog ? 0.65 : (isRayOrPathTraced ? 1.85 : 1.5),
                                roughness: 0.2
                            });
                            const panel = new THREE.Mesh(fixturePanelGeo, panelMat);
                            panel.position.set(fx, fy - 0.08, fz);
                            scene.add(panel);

                            let pointLight = null;
                            if (realPointLightCount < maxRealPointLights) {
                                pointLight = new THREE.PointLight(
                                    data.fixtureColor,
                                    diffCfg.pitchBlackFog ? 1.1 : (isRayOrPathTraced ? 2.7 : 2.3),
                                    (isRayOrPathTraced ? 16 : 13) + (data.pools ? 8 : 0),
                                    1.6
                                );
                                pointLight.position.set(fx, fy - 0.35, fz);
                                // In RTX Ray/Path Tracing mode, enable shadow casting on key ceiling lights
                                if (isRayOrPathTraced && gfx.shadowSize >= 2048 && realPointLightCount < 6) {
                                    pointLight.castShadow = true;
                                    pointLight.shadow.mapSize.width = 512;
                                    pointLight.shadow.mapSize.height = 512;
                                    pointLight.shadow.bias = -0.002;
                                }
                                scene.add(pointLight);
                                realPointLightCount++;

                                // Path-Tracing Simulated Floor Bounce Fill Light
                                if (gfx.rtMode === 'pathtracing' && realPointLightCount % 2 === 0) {
                                    const bounceLight = new THREE.PointLight(data.fixtureColor, 0.75, 11, 2.0);
                                    bounceLight.position.set(fx, 0.35, fz);
                                    scene.add(bounceLight);
                                    GameState.rtBounceLights.push(bounceLight);
                                }

                                // Add reflective floor sheen/puddle under illuminated fixtures
                                if (useReflections && !data.pools && (x + z) % 4 === 2) {
                                    const puddle = new THREE.Mesh(puddleGeo, puddleMat);
                                    puddle.rotation.x = -Math.PI / 2;
                                    puddle.position.set(fx, usePlanarReflections ? 0.009 : 0.008, fz);
                                    scene.add(puddle);
                                }
                            }

                            GameState.ceilingLights.push({
                                frame, panel, fx, fz, fy, shootable: !!data.attraction && Math.random() < 0.55,
                                panelMat,
                                pointLight,
                                baseIntensity: diffCfg.pitchBlackFog ? 1.1 : (isRayOrPathTraced ? 2.7 : 2.3),
                                baseEmissive: diffCfg.pitchBlackFog ? 0.65 : (isRayOrPathTraced ? 1.85 : 1.5),
                                flickers: Math.random() < 0.25
                            });
                        }
                    }
                }
            }

            if (instWalls.length) {
                const im = new THREE.InstancedMesh(wallGeo, wallMat, instWalls.length), m4w = new THREE.Matrix4();
                instWalls.forEach(([x, z], i) => { m4w.makeTranslation(x * cs, ceilH / 2, z * cs); im.setMatrixAt(i, m4w); });
                im.castShadow = gfx.shadowSize > 0; im.receiveShadow = gfx.shadowSize > 0; im.frustumCulled = false; scene.add(im);
            }
            if (data.pools && poolWallCells.length) {
                const tw = !!data.thalasso, wi = new THREE.InstancedMesh(tw ? new THREE.BoxGeometry(cs, ceilH + 70, cs) : wallGeo, wallMat, poolWallCells.length), m4 = new THREE.Matrix4();
                poolWallCells.forEach(([x, z], i) => { m4.makeTranslation(x * cs, tw ? (ceilH - 70) / 2 : ceilH / 2, z * cs); wi.setMatrixAt(i, m4); });
                wi.frustumCulled = false; scene.add(wi);
            }
            const spawnContents = () => {
            if (shopMode) {
                for (let i = openCells.length - 1; i >= 0; i--) { const c = openCells[i]; if ((Math.round(c.x / cs) <= 12 && Math.round(c.z / cs) <= 7) || (data.pools && Math.round(c.z / cs) >= size - 9)) openCells.splice(i, 1); }
                scene.fog.density = activeFogDensity; GameState.baseFogD = activeFogDensity; ambientLight.color.setHex(_amb[0]); ambientLight.intensity = _amb[1];
                GameState.exitArrowTimer = diffCfg.exitArrowInterval || 45; GameState.pingTimer = diffCfg.pingInterval || 30; GameState.lightsOutTimer = 35; GameState.shotgunSpawnTimer = 10 + Math.random() * 10; GameState.globalMonsterPauseTimer = 4;
            }
            // --- Poolrooms: variable-depth water, a hidden wall stash, and lifeguard towers ---
            if (data.pools) {
                const pd = data.thalasso ? generateThalassoDepths(GameState.grid, size) : generatePoolDepths(GameState.grid, size, cs);
                GameState.poolDepth = pd.depth; GameState.oceanCells = pd.ocean;
                GameState.poolFl = pd.floor; GameState.whirls = []; GameState.glitchPanels = []; GameState.fogCol = activeFogColor; GameState.dryFogD = activeFogDensity;
                for (let i = openCells.length - 1; i >= 0; i--) { const c = openCells[i]; if (pd.depth[Math.round(c.z / cs)][Math.round(c.x / cs)]) openCells.splice(i, 1); }
                const waterMat = new THREE.MeshPhysicalMaterial({ color: 0x2fa9d6, transparent: true, opacity: 0.8, roughness: 0.04, metalness: 0.05, clearcoat: 1, envMapIntensity: 1.6, depthWrite: false });
                const SURF = -0.22, DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]], fh = (x, z) => (pd.floor[z] && pd.floor[z][x]) || 0, pg = new THREE.PlaneGeometry(cs, cs), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
                const basinVC = poolBasinMat.clone(); basinVC.vertexColors = true; basinVC.color.setHex(0xffffff);
                for (const blob of pd.blobs) {
                    for (const [x, z] of blob.cells) { const fi = GameState.poolFloor[x + ',' + z]; if (fi !== undefined && GameState.poolFloorInst) GameState.poolFloorInst.setMatrixAt(fi, ZERO); }
                    if (blob.kind === 'deep') scene.add(new THREE.Mesh(deepPoolGeo(blob, cs), basinVC));
                    else for (const [x, z] of blob.cells) {
                        const y0 = fh(x, z), fl = new THREE.Mesh(pg, poolBasinMat); fl.rotation.x = -Math.PI / 2; fl.position.set(x * cs, y0, z * cs); scene.add(fl);
                        for (const [dx, dz] of DIRS) {
                            const nx = x + dx, nz = z + dz; if (GameState.grid[nz][nx] !== 0) continue;
                            const hgt = fh(nx, nz) - y0; if (hgt <= 0) continue;
                            const wl = new THREE.Mesh(new THREE.PlaneGeometry(cs, hgt), poolBasinMat);
                            wl.position.set(x * cs + dx * cs / 2, y0 + hgt / 2, z * cs + dz * cs / 2); wl.rotation.y = dx ? (dx > 0 ? -Math.PI / 2 : Math.PI / 2) : (dz > 0 ? Math.PI : 0); scene.add(wl);
                        }
                    }
                    const [px0, px1, pz0, pz1] = blob.rect; // one solid block of water filling the whole sunken pool
                    const wb = new THREE.Mesh(new THREE.BoxGeometry((px1 - px0 + 1) * cs - 0.04, SURF - blob.bottom, (pz1 - pz0 + 1) * cs - 0.04), waterMat);
                    wb.position.set((px0 + px1) / 2 * cs, (SURF + blob.bottom) / 2, (pz0 + pz1) / 2 * cs); wb.renderOrder = 2; scene.add(wb);
                    if (blob.kind === 'whirl') { // very noticeable, very deadly
                        const wx = (px0 + px1) / 2 * cs, wz = (pz0 + pz1) / 2 * cs, R = Math.min(px1 - px0 + 1, pz1 - pz0 + 1) * cs / 2 - 0.6;
                        const grp = new THREE.Group(); grp.position.set(wx, SURF + 0.05, wz);
                        const disc = new THREE.Mesh(new THREE.CircleGeometry(R, 48), new THREE.MeshBasicMaterial({ map: whirlTexture(), transparent: true, opacity: 0.95, depthWrite: false })); disc.rotation.x = -Math.PI / 2; grp.add(disc); scene.add(grp);
                        const ring = new THREE.Mesh(new THREE.RingGeometry(R * 0.78, R * 0.86, 48), new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false })); ring.rotation.x = -Math.PI / 2; ring.position.set(wx, SURF + 0.08, wz); scene.add(ring);
                        const funnel = new THREE.Mesh(new THREE.ConeGeometry(R * 0.8, 8, 24, 1, true), new THREE.MeshBasicMaterial({ color: 0x02121c, side: THREE.DoubleSide })); funnel.rotation.x = Math.PI; funnel.position.set(wx, SURF - 4, wz); scene.add(funnel);
                        const wl = new THREE.PointLight(0xff4433, 2.5, 22); wl.position.set(wx, 1.2, wz); scene.add(wl);
                        [[px0 - 1, pz0 - 1], [px1 + 1, pz1 + 1]].forEach(([lx, lz]) => { const sg = labelSprite('DANGER: WHIRLPOOL', 5); sg.position.set(lx * cs, 3.2, lz * cs); scene.add(sg); });
                        GameState.whirls.push({ x: wx, z: wz, R, grp, ring });
                    }
                }
                if (GameState.poolFloorInst) GameState.poolFloorInst.instanceMatrix.needsUpdate = true;
                if (data.thalasso) buildThalasso(pd, cs, size, poolBasinMat);
                // glitched deep-pool walls (only visible up close) -> sealed secret rooms: loot, or a smiler that can never leave
                for (const g of pd.glitches) {
                    const gm = new THREE.Mesh(new THREE.PlaneGeometry(3.4, 3.4), new THREE.MeshBasicMaterial({ map: glitchTexture(), side: THREE.DoubleSide }));
                    gm.position.set(g.x, g.y, g.z); gm.rotation.y = g.ry; gm.visible = false; scene.add(gm);
                    GameState.glitchPanels.push({ m: gm, kind: 'enter', to: { x: g.sx, z: g.sz } });
                    const rm = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 3.2), new THREE.MeshBasicMaterial({ map: glitchTexture(), side: THREE.DoubleSide }));
                    rm.position.set(g.sx, 1.8, (g.room.z0 - 0.5) * cs + 0.08); scene.add(rm);
                    GameState.glitchPanels.push({ m: rm, kind: 'exit', to: g.ret });
                    if (g.smiler) new Entity('smiler', g.sx + cs, g.sz + cs);
                    else {
                        spawnShotgunPickup(g.sx - cs, g.sz + cs); spawnPickup('shell', g.sx + cs, g.sz + cs);
                        for (let k = 0; k < 3; k++) spawnPickup('coin', g.sx + (k - 1) * 1.5, g.sz + 1.2);
                        spawnPickup('water', g.sx + cs, g.sz - 1);
                    }
                }
                // lifeguard towers next to some of the pools, each with one almond water or one shotgun shell (50/50)
                let towers = 0;
                for (const blob of pd.blobs) {
                    if (towers >= 8 || blob.tier === 0 || Math.random() < 0.55) continue;
                    let spot = null;
                    for (const [cx, cz] of blob.cells) {
                        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                            const nx = cx + dx, nz = cz + dz;
                            if (nx > 4 && nz > 4 && nx < size - 1 && nz < size - 1 && GameState.grid[nz][nx] === 0 && !GameState.poolDepth[nz][nx]) { spot = { x: nx * cs, z: nz * cs }; break; }
                        }
                        if (spot) break;
                    }
                    if (!spot) continue;
                    towers++;
                    const poleMat = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 }), redMat = new THREE.MeshStandardMaterial({ color: 0xd43a3a, roughness: 0.5 });
                    const tower = new THREE.Group();
                    for (const [lx, lz] of [[-0.55, -0.4], [0.55, -0.4], [-0.55, 0.4], [0.55, 0.4]]) {
                        const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.7, 8), poleMat); leg.position.set(lx, 0.85, lz); tower.add(leg);
                    }
                    const seat = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 1.0), redMat); seat.position.y = 1.72; tower.add(seat);
                    const back = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.55, 0.08), redMat); back.position.set(0, 2.0, -0.46); tower.add(back);
                    const ladder = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.6, 0.06), poleMat); ladder.position.set(0, 0.8, 0.55); tower.add(ladder);
                    tower.position.set(spot.x, 0, spot.z);
                    scene.add(tower);
                    if (Math.random() < 0.4) new Entity('skinstealer', spot.x, spot.z); // lifeguard chairs attract skin stealers
                    if (Math.random() < 0.5) spawnPickup('shell', spot.x + 0.3, spot.z + 0.7);
                    else { spawnPickup('water', spot.x + 0.3, spot.z + 0.7); }
                }
            }

            // Place Player at Spawn
            if (!shopMode) controls.getObject().position.set(1 * cs, 2, 1 * cs);

            // Place Exit far from Spawn
            openCells.sort((a, b) => (b.x + b.z) - (a.x + a.z));
            if (openCells.length > 0) {
                const exitCell = openCells.shift();
                GameState.exitPos.set(exitCell.x, 2, exitCell.z);
                createExit(exitCell.x, exitCell.z, data.exitType); placeSubEntrance(data, cs, exitCell);
            }
            if (data.attraction) Attraction.setup(cs, size, ceilH);

            // Spawn Collectibles (Almond Water & Batteries)
            for (let i = 0; i < data.itemCount; i++) {
                if (openCells.length === 0) break;
                const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0];
                const isWater = Math.random() > 0.45;
                const mesh = buildItemModel(isWater ? 'water' : 'battery');
                mesh.position.set(cell.x, FLOOR_Y[isWater ? 'water' : 'battery'], cell.z);
                mesh.userData = { type: isWater ? 'water' : 'battery' };
                scene.add(mesh);
                GameState.items.push({ mesh, type: 'item' });
            }
            for (let c = 0, n = (data.party || data.hidden) ? 0 : 2 + Math.floor(Math.random() * 2); c < n && openCells.length; c++) {
                const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0];
                spawnPickup('coin', cell.x, cell.z);
            }

            if (!data.party && !data.hidden) for (const [id, pr] of [['crowbar', LootCfg.floorCrowbar], ['chest_locator', LootCfg.floorLocator], ['grenade', LootCfg.floorGrenade]]) // rare floor loot
                if (Math.random() < pr && openCells.length) { const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0]; spawnPickup(id, cell.x, cell.z); }
            if (!data.party && Math.random() < 0.04 && openCells.length) { const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0]; spawnPickup('ammo_crate', cell.x, cell.z); } // rare AMMO CRATE (4%)
            if (!data.party && !data.hidden && openCells.length > 6 && Math.random() < (Math.random() < 0.2 ? 1 : 0.45)) { // alarm clock: 45% (or guaranteed 20% of the time), one of 6 spots, max 1
                const spots = []; for (let k = 0; k < 6; k++) spots.push(openCells[Math.floor(Math.random() * openCells.length)]); const sp = spots[Math.floor(Math.random() * 6)]; spawnPickup('clock', sp.x, sp.z); }
            // On Extreme mode, spawn initial single-use shotgun if player doesn't already hold one
            if (diffCfg.shotgunSpawns && !GameState.hasShotgun && openCells.length > 0) {
                const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0];
                spawnShotgunPickup(cell.x, cell.z);
            }

            // ---- hallway object helpers: solid cells must never seal a corridor; anything that would gets tucked against a wall with its own collider ----
            const gridOpen = (gx, gz) => !!GameState.grid[gz] && GameState.grid[gz][gx] === 0;
            const D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]], propCells = new Set();
            const canSolidify = (gx, gz) => { // true when turning this cell into wall keeps every open neighbour connected to the others
                if (!gridOpen(gx, gz)) return false;
                const nb = D4.map(([dx, dz]) => [gx + dx, gz + dz]).filter(([x, z]) => gridOpen(x, z));
                if (nb.length < 2) return true;
                const seen = new Set([gx + ',' + gz, nb[0][0] + ',' + nb[0][1]]), q = [nb[0]];
                while (q.length) { const [x, z] = q.pop(); for (const [dx, dz] of D4) { const nx = x + dx, nz = z + dz, k = nx + ',' + nz; if (!seen.has(k) && gridOpen(nx, nz)) { seen.add(k); q.push([nx, nz]); } } }
                return nb.every(([x, z]) => seen.has(x + ',' + z));
            };
            const tuckSpot = (gx, gz, hw, hd, rot) => { // offset from the cell centre that puts a (rotated) hw x hd box against a wall, or into a corner in open space
                const cr = Math.abs(Math.cos(rot)), sr = Math.abs(Math.sin(rot)), ex = cr * hw + sr * hd, ez = sr * hw + cr * hd;
                const lx = Math.max(0, cs / 2 - ex - 0.12), lz = Math.max(0, cs / 2 - ez - 0.12), sides = D4.filter(([dx, dz]) => !gridOpen(gx + dx, gz + dz));
                if (!sides.length) return [(Math.random() < 0.5 ? -1 : 1) * lx, (Math.random() < 0.5 ? -1 : 1) * lz];
                const [dx, dz] = sides[Math.floor(Math.random() * sides.length)];
                return dx !== 0 ? [dx * lx, (Math.random() - 0.5) * 1.2 * lz] : [(Math.random() - 0.5) * 1.2 * lx, dz * lz];
            };
            const addCollider = (x, z, hw, hd, rot, h) => GameState.colliders.push({ x, z, hw, hd, cos: Math.cos(rot), sin: Math.sin(rot), r: Math.hypot(hw, hd), h: h == null ? 99 : h }); // h = box height (items can land on low boxes)
            const solidOrTuck = (cell, obj, hw, hd) => { // obj is already positioned at the cell centre
                const gx = Math.round(cell.x / cs), gz = Math.round(cell.z / cs);
                propCells.add(gx + ',' + gz);
                if (canSolidify(gx, gz)) { GameState.grid[gz][gx] = 1; return; }
                const [ox, oz] = tuckSpot(gx, gz, hw, hd, obj.rotation.y); obj.position.x += ox; obj.position.z += oz;
                addCollider(obj.position.x, obj.position.z, hw, hd, obj.rotation.y);
            };

            // crates: an exact oriented box (the real crate size) tucked against a wall - the old code turned the WHOLE 4x4 cell into an invisible wall
            const tuckCrate = (cell, obj, size) => { const gx = Math.round(cell.x / cs), gz = Math.round(cell.z / cs), hw = size / 2; propCells.add(gx + ',' + gz);
                const [ox, oz] = tuckSpot(gx, gz, hw, hw, obj.rotation.y); obj.position.x += ox; obj.position.z += oz; addCollider(obj.position.x, obj.position.z, hw, hw, obj.rotation.y, size);
                GameState.crates.push({ obj, gx, gz, size, solid: false, col: GameState.colliders[GameState.colliders.length - 1] }); };
            const regCrate = (obj, cell, size) => { const gx = Math.round(cell.x / cs), gz = Math.round(cell.z / cs), solid = GameState.grid[gz][gx] === 1; GameState.crates.push({ obj, gx, gz, size, solid, col: solid ? null : GameState.colliders[GameState.colliders.length - 1] }); };
            if (!data.party) { // chests sit in corners: no longer guaranteed (LootCfg.chestChance), very rarely two
                const g = GameState.grid, isW = (x, z) => !g[z] || g[z][x] === 1;
                const info = c => { const x = Math.round(c.x / cs), z = Math.round(c.z / cs); return { c, x, z, wx: isW(x - 1, z) ? -1 : isW(x + 1, z) ? 1 : 0, wz: isW(x, z - 1) ? -1 : isW(x, z + 1) ? 1 : 0 }; };
                const far = openCells.filter(c => Math.hypot(c.x - cs, c.z - cs) > 14), cand = (far.length > 8 ? far : openCells).map(info);
                let pool = cand.filter(o => o.wx && o.wz); if (!pool.length) pool = cand.filter(o => o.wx || o.wz); if (!pool.length) pool = cand;
                const want = (Math.random() < LootCfg.chestChance ? 1 : 0) + (Math.random() < LootCfg.chestExtra ? 1 : 0);
                for (let k = 0; k < want && pool.length; k++) {
                    const o = pool.splice(Math.floor(Math.random() * pool.length), 1)[0], oi = openCells.indexOf(o.c); if (oi >= 0) openCells.splice(oi, 1);
                    const vx = -o.wx, vz = -o.wz, nrm = Math.hypot(vx, vz), px = o.c.x + o.wx * cs * 0.3, pz = o.c.z + o.wz * cs * 0.3, rot = nrm ? Math.atan2(vx / nrm, vz / nrm) : Math.random() * 6.28;
                    const ch = buildChestModel(); ch.group.position.set(px, 0, pz); ch.group.rotation.y = rot; scene.add(ch.group); addCollider(px, pz, 0.475, 0.3, rot, 0.5);
                    GameState.chests.push(Object.assign(ch, { x: px, z: pz, open: false, t: 0, looted: false, rot }));
                }
            }
            if (!data.party && !data.hidden && levelIdx !== 2) { // decorative crates (a crowbar breaks them open)
                for (let i = 0, n = LootCfg.crateMin + Math.floor(Math.random() * LootCfg.crateRand) + (Math.random() < LootCfg.crateBonus ? 1 : 0); i < n && openCells.length; i++) {
                    const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0], obj = buildCrateModel(1.1);
                    obj.position.set(cell.x, 0.55, cell.z); obj.rotation.y = Math.random() * 0.8; scene.add(obj); tuckCrate(cell, obj, 1.1);
                }
            }
            // Level-Specific Gimmicks & Props
            if (levelIdx === 2) {
                const crateMat = new THREE.MeshStandardMaterial({ map: TextureGen.create('crate'), roughness: 0.9 });
                const pillarMat = new THREE.MeshStandardMaterial({ map: TextureGen.create('concrete_dark'), roughness: 0.85 });
                for (let i = 0; i < 28; i++) {
                    if (openCells.length === 0) break;
                    const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0];
                    let obj, hw;
                    if (i % 2 === 0) { obj = new THREE.Mesh(new THREE.BoxGeometry(1.6, 4, 1.6), pillarMat); obj.position.set(cell.x, 2, cell.z); hw = 0.8; }
                    else { obj = buildCrateModel(1.4); obj.position.set(cell.x, 0.7, cell.z); hw = 0.7; }
                    scene.add(obj);
                    if (i % 2 === 1) tuckCrate(cell, obj, 1.4); else solidOrTuck(cell, obj, hw, hw);
                }
            } else if (data.gimmick === 'steam') {
                for (let i = 0; i < 15; i++) {
                    if (openCells.length === 0) break;
                    const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0];
                    const steam = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.5, 0.8, 4),
                        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.28 })
                    );
                    steam.position.set(cell.x, 2, cell.z);
                    scene.add(steam);
                    GameState.props.push({ mesh: steam, type: 'steam', active: true, timer: Math.random() * 5 });
                }
            } else if (data.gimmick === 'sparks') {
                for (let i = 0; i < 18; i++) {
                    if (openCells.length === 0) break;
                    const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0];
                    const sparkGroup = new THREE.Group();
                    const core = new THREE.Mesh(
                        new THREE.OctahedronGeometry(0.45, 0),
                        new THREE.MeshBasicMaterial({ color: 0x66ccff, wireframe: true })
                    );
                    // Fake glow instead of a real PointLight: real lights that toggle visible/invisible change the scene's
                    // light count, which forces every lit material to recompile its shader (big hitches on Level 3).
                    const glow = new THREE.Mesh(
                        new THREE.SphereGeometry(0.9, 8, 6),
                        new THREE.MeshBasicMaterial({ color: 0x44aaff, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false })
                    );
                    sparkGroup.add(core, glow);
                    sparkGroup.position.set(cell.x, 1.5, cell.z);
                    scene.add(sparkGroup);
                    GameState.props.push({ mesh: sparkGroup, type: 'spark', active: true, timer: Math.random() * 4 });
                }
            } else if (data.gimmick === 'rain_windows') {
                for (let i = 0; i < 25; i++) {
                    if (openCells.length === 0) break;
                    const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0];
                    const desk = new THREE.Mesh(
                        new THREE.BoxGeometry(1.6, 0.8, 0.9),
                        new THREE.MeshStandardMaterial({ color: 0x5c5346, roughness: 0.65 })
                    );
                    desk.position.set(cell.x, 0.4, cell.z);
                    scene.add(desk);
                    GameState.props.push({ mesh: desk, type: 'desk' });
                    solidOrTuck(cell, desk, 0.8, 0.45);
                }
            } else if (data.gimmick === 'party') {
                GameState.partygoers = []; let cakes = 1 + (Math.random() < 0.4 ? 1 : 0);
                GameState.arcades = []; GameState.hideSpots = [];
                for (let i = 0; i < 20 && openCells.length; i++) {
                    const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0], g = new THREE.Group();
                    const top = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.08, 0.95), new THREE.MeshStandardMaterial({ color: 0xfff2f8, roughness: 0.7 })); top.position.y = 0.9;
                    const cloth = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 0.85), new THREE.MeshStandardMaterial({ color: [0xff6aa8, 0x4fd8e8, 0xffd54a][i % 3], roughness: 0.8 })); cloth.position.y = 0.4;
                    g.add(top, cloth); g.position.set(cell.x, 0, cell.z); g.rotation.y = Math.random() < 0.5 ? 0 : Math.PI / 2; scene.add(g);
                    GameState.hideSpots.push({ x: cell.x, z: cell.z, g }); // walkable: hide underneath
                    if (cakes > 0 && (i === 3 || i === 8 || Math.random() < 0.1)) { cakes--; spawnPickup('cake', cell.x, cell.z); GameState.items[GameState.items.length - 1].mesh.position.y = 1.0; }
                }
                for (let i = 0; i < 4 && openCells.length; i++) { // arcade cabinets: [E] to play, restores sanity, NOT safe
                    const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0], g = new THREE.Group();
                    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.8), new THREE.MeshStandardMaterial({ color: 0x15154a, roughness: 0.6 })); cab.position.y = 0.95;
                    const scr = new THREE.Mesh(new THREE.PlaneGeometry(0.65, 0.5), new THREE.MeshBasicMaterial({ color: 0x5c94fc })); scr.position.set(0, 1.35, 0.41); g.add(cab, scr); g.position.set(cell.x, 0, cell.z); scene.add(g);
                    solidOrTuck(cell, g, 0.45, 0.4); GameState.arcades.push({ x: g.position.x, z: g.position.z });
                }
                for (let i = 0; i < 12 && openCells.length; i++) {
                    const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0], g = new THREE.Group();
                    const body = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.1, 8), new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.6, 0.5), roughness: 0.8 })); body.position.y = 0.55;
                    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), new THREE.MeshStandardMaterial({ color: 0xe8c9a8 })); head.position.y = 1.3;
                    const hat = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.36, 8), new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0x443300 })); hat.position.y = 1.65;
                    g.add(body, head, hat); g.position.set(cell.x, 0, cell.z); scene.add(g); GameState.partygoers.push({ mesh: g, ph: Math.random() * 6, spin: (Math.random() - 0.5) * 1.6, fake: i % 5 === 2 });
                }
            } else if (data.gimmick === 'hotel_props') {
                for (let i = 0; i < 22; i++) {
                    if (openCells.length === 0) break;
                    const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0];
                    const table = new THREE.Mesh(
                        new THREE.CylinderGeometry(0.65, 0.55, 0.9, 10),
                        new THREE.MeshStandardMaterial({ color: 0x3b1c0e, roughness: 0.55 })
                    );
                    table.position.set(cell.x, 0.45, cell.z);
                    scene.add(table);
                    solidOrTuck(cell, table, 0.6, 0.6);
                }
            }

            if (!data.party && !data.hallway && !data.hidden) { // furniture & clutter, tucked into cell corners so corridors stay open
                const wood = new THREE.MeshStandardMaterial({ color: 0x5a4028, roughness: 0.8 }), met = new THREE.MeshStandardMaterial({ color: 0x6a6e72, roughness: 0.5, metalness: 0.4 }), bx = (w, h, d, m, x, y, z, g) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); o.position.set(x, y, z); g.add(o); };
                const used = new Set(); // cells (and their neighbours) already holding clutter, so two objects can never pinch a hallway shut
                for (let i = 0, tries = 0; i < 9 && tries < 80 && openCells.length > 8; tries++) {
                    const c = openCells[Math.floor(Math.random() * openCells.length)], gx = Math.round(c.x / cs), gz = Math.round(c.z / cs);
                    let busy = false; for (let dz = -1; dz <= 1 && !busy; dz++) for (let dx = -1; dx <= 1; dx++) if (used.has((gx + dx) + ',' + (gz + dz)) || propCells.has((gx + dx) + ',' + (gz + dz))) { busy = true; break; }
                    if (busy || !gridOpen(gx, gz)) continue;
                    i++;
                    const g = new THREE.Group(), r = Math.floor(Math.random() * 5);
                    let hw, hd;
                    if (r === 0) { bx(1.2, 0.06, 0.7, wood, 0, 0.75, 0, g); [[-.55, -.3], [.55, -.3], [-.55, .3], [.55, .3]].forEach(l => bx(0.06, 0.75, 0.06, wood, l[0], 0.37, l[1], g)); hw = 0.6; hd = 0.35; }
                    else if (r === 1) { bx(0.5, 0.05, 0.5, wood, 0, 0.45, 0, g); bx(0.5, 0.5, 0.05, wood, 0, 0.72, -0.22, g); [[-.2, -.2], [.2, -.2], [-.2, .2], [.2, .2]].forEach(l => bx(0.05, 0.45, 0.05, wood, l[0], 0.22, l[1], g)); hw = 0.25; hd = 0.25; }
                    else if (r === 2) { bx(0.7, 0.7, 0.7, wood, 0, 0.35, 0, g); bx(0.5, 0.5, 0.5, wood, 0.1, 0.95, 0, g); hw = 0.35; hd = 0.35; }
                    else if (r === 3) { bx(0.55, 1.5, 0.5, met, 0, 0.75, 0, g); hw = 0.275; hd = 0.25; }
                    else { const b = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.18, 0.5, 10), met); b.position.y = 0.25; g.add(b); hw = 0.22; hd = 0.22; }
                    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) used.add((gx + dx) + ',' + (gz + dz));
                    const rot = Math.random() * 6, [ox, oz] = tuckSpot(gx, gz, hw, hd, rot);
                    g.position.set(c.x + ox, 0, c.z + oz); g.rotation.y = rot; scene.add(g);
                    addCollider(g.position.x, g.position.z, hw, hd, g.rotation.y);
                }
            }
            // Spawn Entities
            if (data.party) setTimeout(() => { GameState.entities.forEach(en => { if (en.mesh.userData.hat) return; en.mesh.userData.hat = 1; const h = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.45, 8), new THREE.MeshBasicMaterial({ color: 0xffd54a })); h.position.y = 2.1; en.mesh.add(h); }); }, 0);
            if (data.hallway) setTimeout(() => GameState.entities.forEach(en => { en.state = 'chase'; en.investigateTimer = 999; }), 0);
            for (let i = 0; i < data.entityCount; i++) {
                if (openCells.length === 0) break;
                const cell = openCells.splice(Math.floor(Math.random() * openCells.length), 1)[0];
                let type = data.entityType;
                if (type === 'mixed_bang') { type = ['bacteria', 'skinstealer', 'smiler', 'hound', 'window_watcher'][i % 5]; } else if (type === 'mixed') {
                    type = Math.random() > 0.5 ? 'smiler' : 'hound';
                } else if (type === 'mixed_l3') {
                    const roll = Math.random();
                    type = roll < 0.4 ? 'hound' : (roll < 0.75 ? 'skinstealer' : 'smiler');
                } else if (type === 'mixed_l5') {
                    const roll = Math.random();
                    type = roll < 0.45 ? 'window_watcher' : (roll < 0.75 ? 'smiler' : 'skinstealer');
                }
                new Entity(type, cell.x, cell.z);
            }
            };
            if (shopMode) {
                GameState.pendingSpawn = spawnContents;
                scene.fog.density = 0.012; GameState.baseFogD = 0.012; ambientLight.color.setHex(0xfff2c2); ambientLight.intensity = 0.9;
                buildShopRoom(cs, ceilH);
                shopWarm();
            } else spawnContents();
        }
