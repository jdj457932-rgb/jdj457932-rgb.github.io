'use strict';
        // Fake glow (additive sprite). A real PointLight added/removed at runtime forces every lit material in the scene to recompile = a big hitch.
        let _pgTex = null;
        function pickupGlowSprite() {
            if (!_pgTex) { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,190,90,.9)'); gr.addColorStop(.35, 'rgba(255,160,60,.35)'); gr.addColorStop(1, 'rgba(255,140,40,0)'); x.fillStyle = gr; x.fillRect(0, 0, 64, 64); _pgTex = new THREE.CanvasTexture(c); }
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: _pgTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })); s.scale.set(2.2, 2.2, 1); return s;
        }
        function spawnShotgunPickup(x, z) {
            if (GameState.shotgunSpawnedInWorld || GameState.hasShotgun) return;
            const pickupGroup = new THREE.Group(), gm = buildItemModel('shotgun'); gm.scale.setScalar(1.3); gm.rotation.y = Math.PI / 2; pickupGroup.add(gm);
            const glow = pickupGlowSprite();
            glow.position.set(0, 0.4, 0);

            pickupGroup.add(glow);
            pickupGroup.position.set(x, 0.45, z);
            pickupGroup.userData = { type: 'shotgun' };
            scene.add(pickupGroup);

            GameState.items.push({ mesh: pickupGroup, type: 'item' });
            GameState.shotgunSpawnedInWorld = true;
        }

        function trySpawnOccasionalShotgun() {
            const diffCfg = DifficultyConfigs[GameState.difficulty];
            if (!diffCfg.shotgunSpawns || GameState.shotgunSpawnedInWorld || GameState.hasShotgun) return;
            const cs = GameState.cellSize;
            const size = GameState.gridSize;
            const candidates = [];
            for (let z = 2; z < size - 2; z++) {
                for (let x = 2; x < size - 2; x++) {
                    if (GameState.grid[z][x] === 0) {
                        candidates.push({ x: x * cs, z: z * cs });
                    }
                }
            }
            if (candidates.length > 0) {
                const chosen = candidates[Math.floor(Math.random() * candidates.length)];
                spawnShotgunPickup(chosen.x, chosen.z);
                showEventBanner("A SINGLE-USE SHOTGUN HAS APPEARED SOMEWHERE IN THE LEVEL...", 3.5);
            }
        }

        // Sub-levels are secret branches: normal progression skips them; exiting one rejoins the main path.
        // Level builds are synchronous and heavy: paint a LOADING cover first so the click doesn't look like a browser freeze.
        function loadLevelDeferred(i) {
            const o = document.getElementById('level-loading'); if (o) o.style.display = 'flex';
            requestAnimationFrame(() => setTimeout(() => { let ok = false; try { GameState.onWarm = () => { if (o) o.style.display = 'none'; }; setTimeout(() => { if (o) o.style.display = 'none'; }, 7000); buildLevel(i, true); ok = true; } finally { if (!ok && o) o.style.display = 'none'; } }, 30));
        }
        function nextMainLevel(i) { for (let j = i + 1; j < LevelData.length; j++) { const l = LevelData[j]; if (!l.party && (!l.hidden || l.main) && !l.sub) return j; } return -1; }
        function placeSubEntrance(data, cs, exitCell) {
            GameState.subDoor = null;
            if (!data.subTarget || Math.random() > (data.subChance || 0.3)) return;
            const ti = LevelData.findIndex(l => l.name === data.subTarget); if (ti < 0) return;
            const g = GameState.grid, size = GameState.gridSize, D = [[1, 0], [-1, 0], [0, 1], [0, -1]], cand = [];
            for (let z = 1; z < size - 1; z++) for (let x = 1; x < size - 1; x++) {
                if (g[z][x] !== 0) continue;
                const ws = D.filter(([dx, dz]) => !g[z + dz] || g[z + dz][x + dx] !== 0); if (ws.length !== 3) continue; // dead ends only
                const wx = x * cs, wz = z * cs; if (Math.hypot(wx - cs, wz - cs) < 20 || Math.hypot(wx - exitCell.x, wz - exitCell.z) < 10) continue;
                cand.push({ x: wx, z: wz, w: ws[Math.floor(Math.random() * ws.length)], d: Math.hypot(wx - cs, wz - cs) });
            }
            if (!cand.length) return; cand.sort((a, b) => b.d - a.d); const c = cand[Math.floor(Math.random() * Math.min(6, cand.length))], [dx, dz] = c.w;
            const m = new THREE.Mesh(new THREE.PlaneGeometry(cs * 0.7, Math.min(3, (data.ceilH || 4) - 0.6)), new THREE.MeshBasicMaterial({ color: 0xfff2c2, transparent: true, opacity: 0, depthWrite: false }));
            m.position.set(c.x + dx * (cs / 2 - 0.04), 1.6, c.z + dz * (cs / 2 - 0.04)); m.rotation.y = Math.atan2(-dx, -dz); scene.add(m);
            GameState.subDoor = { x: c.x + dx * cs * 0.3, z: c.z + dz * cs * 0.3, mesh: m, to: ti };
        }

        // Exits are built from the Backrooms lore: Level 0 is escaped by noclipping through a wall that isn't real; later levels use a plain door, a fire exit with a panic bar, or an elevator.
        function exitSignTex(txt, col, bg) {
            const c = document.createElement('canvas'); c.width = 256; c.height = 96; const x = c.getContext('2d');
            x.fillStyle = bg; x.fillRect(0, 0, 256, 96); x.strokeStyle = col; x.lineWidth = 6; x.strokeRect(4, 4, 248, 88);
            x.fillStyle = col; x.font = 'bold 60px Arial'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(txt, 128, 52); return new THREE.CanvasTexture(c);
        }
        function createExit(x, z, type) {
            const cs = GameState.cellSize || 4, g = GameState.grid, gx = Math.round(x / cs), gz = Math.round(z / cs); let dx = 0, dz = 0;
            if (g) for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { if (!g[gz + az] || g[gz + az][gx + ax] !== 0) { dx = ax; dz = az; break; } } // stand flush against a neighbouring wall
            const root = new THREE.Group(); root.position.set(x, 2, z); root.userData = { isExit: true, kind: type };
            const face = new THREE.Group(), flush = dx || dz; face.position.set(dx * (flush ? Math.min(cs / 2 - 0.1, 1.9) : 0), 0, dz * (flush ? Math.min(cs / 2 - 0.1, 1.9) : 0)); face.rotation.y = flush ? Math.atan2(-dx, -dz) : Math.random() * Math.PI * 2; root.add(face);
            const fxl = GameState.exitFx = GameState.exitFx || [], M = (c, o) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.7 }, o || {})), BM = c => new THREE.MeshBasicMaterial({ color: c });
            const box = (w, h, d, mat, px, py, pz) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(px, py, pz); face.add(m); return m; };
            const sign = (txt, col, bg, px, py, pz) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 0.26), new THREE.MeshBasicMaterial({ map: exitSignTex(txt, col, bg) })); m.position.set(px, py, pz); face.add(m); return m; };
            let beaconColor = 0x00ff88;
            if (type === 'glitch') { // noclip: a stretch of wall that glitches, tears and shows the void behind it
                beaconColor = 0xff44ff; const gt = glitchTexture();
                const gp = new THREE.Mesh(new THREE.PlaneGeometry(2.1, 2.9), new THREE.MeshBasicMaterial({ map: gt, side: THREE.DoubleSide })); gp.position.set(0, -0.5, 0.03); face.add(gp);
                const vd = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 2.4), BM(0x000000)); vd.position.set(0, -0.55, 0.05); face.add(vd);
                const shards = []; for (let i = 0; i < 6; i++) { const sh = new THREE.Mesh(new THREE.PlaneGeometry(0.15 + Math.random() * 0.5, 0.08 + Math.random() * 0.3), BM(i % 2 ? 0xff44ff : 0xe8ffe8)); sh.position.z = 0.07; shards.push(sh); face.add(sh); }
                fxl.push(() => { gt.offset.set(Math.random(), Math.random()); vd.visible = Math.random() < 0.75; gp.scale.x = 1 + (Math.random() - 0.5) * 0.06; for (const sh of shards) { sh.visible = Math.random() < 0.3; sh.position.x = (Math.random() - 0.5) * 2; sh.position.y = -1.8 + Math.random() * 2.6; } });
            } else if (type === 'elevator') { // steel doors, a call panel, a floor indicator and a seam of light
                beaconColor = 0x44bbff; const st = M(0x8a9298, { metalness: 0.85, roughness: 0.25 });
                box(0.12, 2.5, 0.2, M(0x2b2f31), -0.78, -0.75, 0); box(0.12, 2.5, 0.2, M(0x2b2f31), 0.78, -0.75, 0); box(1.68, 0.14, 0.2, M(0x2b2f31), 0, 0.43, 0);
                box(0.7, 2.3, 0.1, st, -0.36, -0.85, 0.02); box(0.7, 2.3, 0.1, st, 0.36, -0.85, 0.02); box(0.03, 2.3, 0.04, BM(0xcfe9ff), 0, -0.85, 0.08);
                box(0.14, 0.3, 0.05, M(0x15191b), 1.0, -0.8, 0.06); box(0.05, 0.05, 0.03, BM(0xff5533), 1.0, -0.72, 0.1); box(0.05, 0.05, 0.03, BM(0x33ff66), 1.0, -0.86, 0.1);
                const ind = sign('\u25B2', '#7fdcff', '#06141a', 0, 0.72, 0.1); fxl.push(() => { ind.visible = (performance.now() % 2400) < 1700; });
            } else if (type === 'fireexit') { // red steel door, a panic bar, a small wired window and a red EXIT sign
                beaconColor = 0xff3333;
                box(0.12, 2.5, 0.2, M(0x2b2f31), -0.62, -0.75, 0); box(0.12, 2.5, 0.2, M(0x2b2f31), 0.62, -0.75, 0); box(1.36, 0.14, 0.2, M(0x2b2f31), 0, 0.43, 0);
                box(1.12, 2.3, 0.1, M(0x9e1c1c, { metalness: 0.3, roughness: 0.5 }), 0, -0.85, 0.02); box(0.9, 0.07, 0.07, M(0xcfd3d6, { metalness: 0.9, roughness: 0.3 }), 0, -1.0, 0.1);
                box(0.3, 0.5, 0.02, M(0x7fa090, { emissive: 0x112a20, emissiveIntensity: 0.6 }), 0, -0.2, 0.08); sign('EXIT', '#ff3b30', '#1a0505', 0, 0.75, 0.1);
            } else { // plain utility door: grey metal leaf, brass handle, green EXIT sign and a strip of warm light along the edge
                beaconColor = 0x44ff88;
                box(0.12, 2.5, 0.2, M(0x2b2f31), -0.62, -0.75, 0); box(0.12, 2.5, 0.2, M(0x2b2f31), 0.62, -0.75, 0); box(1.36, 0.14, 0.2, M(0x2b2f31), 0, 0.43, 0);
                box(1.12, 2.3, 0.1, M(0x6b7377, { metalness: 0.4, roughness: 0.6 }), 0, -0.85, 0.02); box(1.0, 0.3, 0.02, M(0x555c60, { metalness: 0.5 }), 0, -1.7, 0.08);
                box(0.05, 0.05, 0.12, M(0xb59a4a, { metalness: 0.8, roughness: 0.3 }), 0.4, -0.95, 0.1); box(0.025, 2.3, 0.03, BM(0xffe9a8), 0.58, -0.85, 0.075); sign('EXIT', '#3dff7a', '#04150a', 0, 0.75, 0.1);
            }
            const beaconLight = new THREE.PointLight(beaconColor, 1.3, 9); beaconLight.position.set(0, 1.5, 0); root.add(beaconLight);
            scene.add(root); GameState.items.push({ mesh: root, type: 'exit' });
        }

        function showEventBanner(text, duration = 3.0) {
            const banner = document.getElementById('event-banner');
            banner.innerText = text;
            banner.style.display = 'block';
            GameState.bannerTimer = duration;
        }

        // --- INPUT HANDLING ---
        const keys = { w: false, a: false, s: false, d: false, shift: false, e: false, ' ': false };
        document.addEventListener('keydown', (e) => {
            const key = e.key.toLowerCase();
            if (e.key === 'F3') { e.preventDefault(); toggleFps(); return; }
            if (e.key === 'Escape' && GameState.isRunning && !GameState.isPaused && !GameState.isJumpscaring) { pauseGame(); return; }
            if (GameState.isPaused || GameState.mpMenu) return;
            if (e.key === ' ' && GameState.isRunning) e.preventDefault();
            if (keys.hasOwnProperty(key)) keys[key] = true;
            if (key === 'f') toggleFlashlight();
            if (key === 'e') interact();
            if (key === 'g') useSelected();
            if (key >= '1' && key <= '5') selectSlot(+key - 1);
        });
        document.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            if (keys.hasOwnProperty(key)) keys[key] = false;
        });

        function toggleFlashlight() {
            if (!GameState.isRunning || GameState._flMount) return;
            if (GameState.player.battery > 0) {
                GameState.player.flashlightOn = !GameState.player.flashlightOn;
                flashLight.visible = GameState.player.flashlightOn;
                AudioSys.playClick();
            }
        }

        function fireShotgun() {
            if (!GameState.isRunning || (MP.active && MP.me.ghost)) return;
            if (!(GameState.inv[GameState.invSel] && GameState.inv[GameState.invSel].id === 'shotgun')) {
                if (GameState.hasShotgun) showEventBanner('SELECT THE SHOTGUN SLOT FIRST', 1.6);
                return;
            }
            { const gi = GameState.inv[GameState.invSel]; if (!gi.ammo) { AudioSys.playEmptyClick(); return showEventBanner('SHOTGUN EMPTY - FIND A SHELL (Q DROPS ITEMS)', 2); } gi.ammo--; renderInv(); updateShotgunHud(); }
            GameState.shotgunSpawnTimer = 28 + Math.random() * 12; // Cooldown before another shotgun can spawn

            AudioSys.playShotgun(); setTimeout(() => AudioSys.playReload(), 650);

            // Muzzle flash visual & brief lighting spike
            const mfOverlay = document.getElementById('muzzle-flash-overlay');
            mfOverlay.style.opacity = '1';
            setTimeout(() => { mfOverlay.style.opacity = '0'; }, 95);

            const p = controls.getObject().position;
            const forward = new THREE.Vector3();
            camera.getWorldDirection(forward);
            if (window.__vrAim) forward.copy(window.__vrAim);
            { const aim3 = forward.clone().normalize(), muzzle = (window.__vrOn && window.__vrMuzzle) ? window.__vrMuzzle.clone() : camera.localToWorld(new THREE.Vector3(0.28, -0.25, -0.93)); try { shotFxFire(muzzle, aim3); } catch (e) { console.warn('shot fx', e); } }
            { const aim = new THREE.Vector3(); camera.getWorldDirection(aim); if (window.__vrAim) aim.copy(window.__vrAim); aim.normalize(); const o = camera.getWorldPosition(new THREE.Vector3()); if (LevelData[GameState.level].attraction) { Attraction.shootBoss(o, aim); Attraction.shootLights(o, aim); Attraction.shootWall(o, aim); } if (GameState.inShop && !MP.active) ShopDoom.shot(o, aim); }
            forward.y = 0;
            forward.normalize();

            // Loud shotgun blast alerts distant entities, while stunning any entity in front cone for 20s
            let stunnedCount = 0;
            GameState.entities.forEach(ent => {
                const toEnt = new THREE.Vector3().subVectors(ent.mesh.position, p).setY(0);
                const dist = toEnt.length();
                if (dist > 0.01) {
                    toEnt.normalize();
                    const dot = forward.dot(toEnt);
                    if (dist <= 16 && dot > 0.72 && ent.hasLineOfSight(p)) {
                        if (ent._minion) { Attraction.hitMinion(ent); stunnedCount++; return; }
                        ent.stun(PermaFx.stun()); recordStun(ent.type);
                        stunnedCount++;
                    } else if (dist <= 38) {
                        ent.alertToPosition(p, 15);
                    }
                }
            });

            if (stunnedCount > 0) {
                showEventBanner(`DIRECT HIT! ENTITY STUNNED FOR ${PermaFx.stun()} SECONDS!`, 3.0);
            } else {
                showEventBanner(`SHOTGUN FIRED — MISSED!`, 2.2);
            }
        }

        function interact() {
            if (!GameState.isRunning) return;
            const p = controls.getObject().position;
            if (GameState.inShop) { shopInteract(p); return; }
            if (MP.active && MP.me.ghost) return; // ghosts cannot touch the world
            if (GameState.subDoor && Math.hypot(p.x - GameState.subDoor.x, p.z - GameState.subDoor.z) < 2.8) { const ti = GameState.subDoor.to; GameState.subDoor = null; AudioSys.playSecretItem(); showEventBanner('THE WALL WASN\'T REAL.', 2.2); buildLevel(ti, true); return; }
            for (const ch of GameState.chests || []) if (!ch.open && Math.hypot(p.x - ch.x, p.z - ch.z) < (window.__vrOn ? 1.9 : 2.6)) { openChest(ch); return; }
            { const sel = GameState.inv[GameState.invSel]; if (sel && (sel.id === 'crowbar' || sel.id === 'axe') && (breakNearestCrate(p, window.__vrOn ? 1.5 : 2.8) || Attraction.meleeWall(p))) return; }

            if (GameState.secretWallCell && !GameState.secretWallFound) {
                const dx = p.x - GameState.secretWallCell.x, dz = p.z - GameState.secretWallCell.z;
                if (dx * dx + dz * dz < 2.6 * 2.6) {
                    GameState.secretWallFound = true;
                    AudioSys.playSecretItem();
                    showEventBanner('THE WALL WASN\'T REAL.', 2.2);
                    spawnShotgunPickup(GameState.secretWallCell.x, GameState.secretWallCell.z);
                    return;
                }
            }
            
            for (let i = GameState.items.length - 1; i >= 0; i--) {
                const item = GameState.items[i];
                if (item.mesh.position.distanceTo(p) < 2.6) {
                    if (item.type === 'exit') {
                        if (MP.active) { MP.exitReached(); return; }
                        if (LevelData[GameState.level].attraction && !GameState.bossDead) { showEventBanner('THE EXIT IS SEALED - SOMETHING STILL GUARDS IT', 2.4); return; }
                        AudioSys.playClick();
                        unlockAch('lvl_' + LevelData[GameState.level].name); AudioSys.playLevelClear(); awardLevelCoins();
                        if (LevelData[GameState.level].party || (LevelData[GameState.level].hidden && !LevelData[GameState.level].main)) { if (LevelData[GameState.level].hidden) showEventBanner('YOU MADE IT.', 3); try { enterDebugRoom(); } catch (e) {} return; }
                        const _nx = nextMainLevel(GameState.level);
                        if (_nx >= 0) {
                            Attraction.gate(_nx, () => loadLevelDeferred(_nx));
                        } else {
                            winGame();
                        }
                        return;
                    } else if ((['coin', 'shell', 'ammo_crate'].includes(item.mesh.userData.type) || ItemDefs[item.mesh.userData.type])) {
                        const t = item.mesh.userData.type;
                        if (t === 'shell' || t === 'ammo_crate') {
                            const sg = GameState.inv.filter(x => x && x.id === 'shotgun'), tg = t === 'shell' ? sg.filter(x => !x.ammo) : sg;
                            if (!tg.length) { showEventBanner(sg.length ? 'YOUR SHOTGUN IS ALREADY LOADED' : 'YOU HAVE NO SHOTGUN FOR THIS', 1.8); return; }
                            tg.forEach(x => x.ammo = t === 'shell' ? 1 : Math.max(x.ammo || 0, PermaFx.ammoCrate())); if (t === 'shell') AudioSys.playShellPickup(); else AudioSys.playAmmoPickup();
                            showEventBanner(t === 'shell' ? 'SHOTGUN LOADED' : `AMMO CRATE: ALL SHOTGUNS HOLD ${PermaFx.ammoCrate()} SHELLS`, 2.2); syncInventory(); MP.taken(item); scene.remove(item.mesh); GameState.items.splice(i, 1); return;
                        }
                        if (t === 'coin') { if (!GameState.debugRoom) { Save.coins++; sv('backrooms_coins', Save.coins); } renderInv(); }
                        else if (!invAdd(GameState.inv, t, item.mesh.userData.ammo)) { showEventBanner('INVENTORY FULL (5/5) - USE AN ITEM FIRST', 2.2); return; }
                        else { if (t === 'shotgun') GameState.shotgunSpawnedInWorld = false; if (t === 'tracker') GameState.trackerInWorld = false; syncInventory(); }
                        if (t === 'coin') AudioSys.playCoin(); else AudioSys.playPickup();
                        MP.taken(item); scene.remove(item.mesh);
                        GameState.items.splice(i, 1);
                        return;
                    }
                }
            }
        }

        // --- SETTINGS & ACHIEVEMENT PERSISTENCE ---
        function refreshAchievementUI() {
            const hasImpossibleWin = localStorage.getItem('backrooms_impossible_beaten') === 'true';
            document.getElementById('achievement-banner').style.display = hasImpossibleWin ? 'block' : 'none';
        }

        function updateSettingsSummary() {
            const cfg = DifficultyConfigs[GameState.difficulty];
            const diffEl = document.getElementById('summary-diff');
            diffEl.innerText = cfg.label;
            diffEl.style.color = cfg.id === 'impossible' ? '#ff2a2a' : (cfg.id === 'extreme' ? '#ff6b35' : '#e6c84c');

            const gfxEl = document.getElementById('summary-gfx');
            const gfxLabel = GameState.graphicsPreset.toUpperCase();
            gfxEl.innerText = gfxLabel;
            gfxEl.style.color = GameState.graphicsPreset === 'rtx' ? '#9eff00' : (GameState.graphicsPreset === 'potato' ? '#aaa' : '#4dd0e1');

            const micEl = document.getElementById('summary-mic');
            micEl.innerText = GameState.micEnabled ? 'ON (VOICE ATTRACTS ENTITIES)' : 'OFF';
            micEl.style.color = GameState.micEnabled ? '#4cd964' : '#888';

            document.getElementById('diff-description').innerText = cfg.description; try { if (Settings.loaded) saveSettings(); } catch (e) {}
            updateGraphicsUI();
        }

        function updateGraphicsUI() {
            const presetId = GameState.graphicsPreset;
            document.querySelectorAll('.gfx-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.gfx === presetId);
            });

            const descEl = document.getElementById('gfx-description');
            if (presetId === 'custom') {
                descEl.innerText = 'Custom Graphics Profile: Fine-tune resolution scaling, anti-aliasing, shadow map resolution, textures, reflections, and ray/path-tracing light bounces individually below.';
            } else {
                descEl.innerText = GraphicsPresets[presetId].description;
            }

            // Sync individual dropdown controls with current GameState.graphics
            const g = GameState.graphics;
            document.getElementById('gfx-opt-res').value = String(g.resScale);
            document.getElementById('gfx-opt-aa').value = g.aa;
            document.getElementById('gfx-opt-shadows').value = String(g.shadowSize);
            document.getElementById('gfx-opt-tex').value = String(g.texSize);
            document.getElementById('gfx-opt-reflections').value = g.reflections;
            document.getElementById('gfx-opt-rt').value = g.rtMode;
            document.getElementById('gfx-opt-lights').value = String(g.maxLights);
            document.getElementById('gfx-opt-vhs').value = g.vhsFx;
        }

        function selectGraphicsPreset(presetId) {
            if (window.__vrOn && (presetId === 'rtx' || presetId === 'custom')) presetId = 'high';
            GameState.graphicsPreset = presetId; const _ts = GameState.graphics.texSize;
            if (presetId !== 'custom' && GraphicsPresets[presetId]) {
                GameState.graphics = { ...GraphicsPresets[presetId] };
            }
            if (GameState.graphics.texSize !== _ts) TextureGen.clearCache(); // regenerating every canvas texture is only needed when their size changed
            applyGraphicsSettings();
            updateSettingsSummary();
        }

        // Hardware Diagnose System (Inspects CPU Threads, System RAM, WebGL GPU Renderer, VRAM & Max Texture Size)
        function diagnoseHardware() {
            const cpuThreads = navigator.hardwareConcurrency || 4;
            const systemRamGB = navigator.deviceMemory || null; // Reported in GB on Chromium browsers
            const gl = renderer.getContext();
            let gpuRenderer = 'Standard WebGL GPU';
            let gpuVendor = '';
            try {
                const dbgInfo = gl.getExtension('WEBGL_debug_renderer_info');
                if (dbgInfo) {
                    gpuRenderer = gl.getParameter(dbgInfo.UNMASKED_RENDERER_WEBGL) || gpuRenderer;
                    gpuVendor = gl.getParameter(dbgInfo.UNMASKED_VENDOR_WEBGL) || '';
                }
            } catch (e) {}

            const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
            const gpuLower = gpuRenderer.toLowerCase();

            // Estimate GPU tier & approximate VRAM from GPU architecture string
            let estimatedVramGB = 4;
            let gpuScore = 50;

            const isSoftware = /swiftshader|llvmpipe|software|microsoft basic/i.test(gpuLower);
            const isRtxClass = /rtx\s*(20|30|40|50)|rx\s*(6[789]00|7[789]00|9070)|radeon pro w|quadro rtx|apple m[234]\s*(pro|max|ultra)/i.test(gpuLower);
            const isHighGtxRx = /gtx\s*(1070|1080|1660)|rx\s*(5700|6600|7600)|arc\s*a[57]|apple m[1234]/i.test(gpuLower);
            const isIntegratedLow = /intel.*(uhd|hd graphics|iris)|vega\s*[3-8]|mali|adreno|powervr/i.test(gpuLower);

            if (isSoftware) {
                estimatedVramGB = 0.5;
                gpuScore = 10;
            } else if (isRtxClass) {
                estimatedVramGB = /4090|3090|7900|4080|5080|5090/.test(gpuLower) ? 16 : (/4070|3080|6800|7800/.test(gpuLower) ? 12 : 8);
                gpuScore = 95;
            } else if (isHighGtxRx) {
                estimatedVramGB = 8;
                gpuScore = 75;
            } else if (isIntegratedLow) {
                estimatedVramGB = 2;
                gpuScore = 32;
            } else {
                estimatedVramGB = 4;
                gpuScore = 55;
            }

            // Factor in CPU logical threads and System RAM
            const cpuScore = Math.min(100, cpuThreads * 8.5);
            const ramScore = systemRamGB ? Math.min(100, systemRamGB * 10) : 60;
            const totalScore = gpuScore * 0.6 + cpuScore * 0.25 + ramScore * 0.15;

            let recommendedPreset = 'medium';
            if (isSoftware || totalScore < 28 || (systemRamGB && systemRamGB <= 2)) {
                recommendedPreset = 'potato';
            } else if (totalScore < 46 || (systemRamGB && systemRamGB <= 4)) {
                recommendedPreset = 'low';
            } else if (totalScore < 68) {
                recommendedPreset = 'medium';
            } else if (totalScore < 84 || !isRtxClass) {
                recommendedPreset = 'high';
            } else {
                recommendedPreset = 'rtx';
            }

            selectGraphicsPreset(recommendedPreset);

            const reportEl = document.getElementById('diagnose-report');
            reportEl.style.display = 'block';
            reportEl.innerHTML = `
                <strong>HARDWARE DIAGNOSTIC COMPLETE &mdash; APPLIED: <span style="color:#9eff00;">${recommendedPreset.toUpperCase()}</span></strong><br>
                &bull; <strong>GPU:</strong> ${gpuRenderer} ${gpuVendor ? `(${gpuVendor})` : ''}<br>
                &bull; <strong>Est. VRAM / Max Texture:</strong> ~${estimatedVramGB} GB VRAM &nbsp;|&nbsp; ${maxTexSize}px Max HW Texture<br>
                &bull; <strong>CPU & Memory:</strong> ${cpuThreads} Logical Threads/Cores &nbsp;|&nbsp; ${systemRamGB ? `${systemRamGB} GB System RAM` : 'RAM Size Protected by Browser'}
            `;
        }

        document.getElementById('diagnose-btn').addEventListener('click', async () => {
            await AudioSys.init();
            AudioSys.playPickup();
            diagnoseHardware();
        });

        document.querySelectorAll('.gfx-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                AudioSys.playClick();
                selectGraphicsPreset(btn.dataset.gfx);
            });
        });

        // Bind individual custom graphics dropdowns -> automatically switches preset badge to CUSTOM
        const customBindings = [
            ['gfx-opt-res', 'resScale', v => parseFloat(v)],
            ['gfx-opt-aa', 'aa', v => v],
            ['gfx-opt-shadows', 'shadowSize', v => parseInt(v, 10)],
            ['gfx-opt-tex', 'texSize', v => parseInt(v, 10)],
            ['gfx-opt-reflections', 'reflections', v => v],
            ['gfx-opt-rt', 'rtMode', v => v],
            ['gfx-opt-lights', 'maxLights', v => parseInt(v, 10)],
            ['gfx-opt-vhs', 'vhsFx', v => v]
        ];
        customBindings.forEach(([elId, prop, parser]) => {
            document.getElementById(elId).addEventListener('change', (e) => {
                AudioSys.playClick();
                GameState.graphicsPreset = 'custom';
                GameState.graphics[prop] = parser(e.target.value);
                if (prop === 'texSize') TextureGen.clearCache();
                applyGraphicsSettings();
                updateSettingsSummary();
            });
        });

        let settingsMicPreviewLoop = null;
        function startSettingsMicPreview() {
            const wrap = document.getElementById('settings-mic-meter-wrap');
            const fill = document.getElementById('settings-mic-meter-fill');
            const status = document.getElementById('settings-mic-status');
            wrap.style.display = 'block';
            status.innerText = 'Requesting microphone permission...';

            MicSys.enable().then(ok => {
                if (!ok) {
                    status.innerText = 'Microphone access denied or unavailable in browser.';
                    status.style.color = '#ff5555';
                    GameState.micEnabled = false;
                    document.getElementById('mic-checkbox').checked = false;
                    updateSettingsSummary();
                    return;
                }
                status.innerText = 'Microphone active! Speak to test noise attraction level.';
                status.style.color = '#4cd964';
                const tick = () => {
                    if (document.getElementById('settings-modal').style.display !== 'flex' || !GameState.micEnabled) return;
                    const vol = MicSys.getVolume();
                    fill.style.width = `${Math.round(vol * 100)}%`;
                    fill.style.background = vol > 0.65 ? '#ff3b30' : (vol > 0.3 ? '#ffcc00' : '#4cd964');
                    settingsMicPreviewLoop = requestAnimationFrame(tick);
                };
                tick();
            });
        }

        document.getElementById('settings-btn').addEventListener('click', async () => {
            await AudioSys.init();
            AudioSys.playClick();
            document.getElementById('settings-modal').style.display = 'flex';
            updateSettingsSummary();
            if (GameState.micEnabled) startSettingsMicPreview();
        });

        document.getElementById('close-settings-btn').addEventListener('click', () => {
            AudioSys.playClick();
            if (settingsMicPreviewLoop) cancelAnimationFrame(settingsMicPreviewLoop);
            document.getElementById('settings-modal').style.display = 'none';
            updateSettingsSummary();
        });

        document.querySelectorAll('.diff-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                AudioSys.playClick();
                document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                GameState.difficulty = btn.dataset.diff;
                updateSettingsSummary();
            });
        });

        document.getElementById('mic-checkbox').addEventListener('change', (e) => {
            GameState.micEnabled = e.target.checked;
            updateSettingsSummary();
            if (GameState.micEnabled) {
                startSettingsMicPreview();
            } else {
                if (settingsMicPreviewLoop) cancelAnimationFrame(settingsMicPreviewLoop);
                MicSys.disable();
                document.getElementById('settings-mic-meter-wrap').style.display = 'none';
            }
        });

        // --- GAME START / END LOGIC ---
        async function startGame(startLevel = 0, debug = false) {
            // If ChromeOS GPU process is still stuck from a previous crash, rebuild a clean WebGL renderer
            if (!renderer || webglContextLost || (renderer.getContext() && renderer.getContext().isContextLost())) {
                try {
                    if (renderer && renderer.domElement && renderer.domElement.parentNode) {
                        renderer.domElement.parentNode.removeChild(renderer.domElement);
                    }
                    renderer = createSafeRenderer();
                    document.body.appendChild(renderer.domElement);
                    webglContextLost = false;
                    TextureGen.clearCache();
                    buildReflectionEnv();
                } catch (e) {
                    showMenuNotice('Browser GPU process is recovering. Close extra tabs or restart Chrome if WebGL stays locked.');
                    return;
                }
            }

            // Initialize audio safely without blocking game start if audio hardware is busy
            try {
                await Promise.race([
                    AudioSys.init(),
                    new Promise(resolve => setTimeout(resolve, 350))
                ]);
                AudioSys.playClick();
            } catch (e) {}

            if (GameState.micEnabled) {
                const ok = await MicSys.enable();
                if (!ok) {
                    GameState.micEnabled = false;
                    document.getElementById('mic-checkbox').checked = false;
                    updateSettingsSummary();
                }
            } else {
                MicSys.disable();
            }

            const diffCfg = DifficultyConfigs[GameState.difficulty];
            // Level 8 bossfight death: restart in Level 7 with the inventory captured on entering it. Any other start is a new run: checkpoint dropped.
            const _l7 = LevelData.findIndex(l => l.thalasso); let _cpRestore = false;
            if (!debug && startLevel === 0 && _l7 >= 0 && Attraction.takeRespawn()) { startLevel = _l7; _cpRestore = true; } else { Attraction._respawn = false; Attraction.cp7 = null; }

            document.getElementById('start-screen').style.display = 'none';
            document.getElementById('death-screen').style.display = 'none';
            document.getElementById('end-achievement-card').style.display = 'none';
            document.getElementById('ui-layer').style.display = 'block';
            document.getElementById('vhs-hud').style.display = 'block';
            document.getElementById('event-banner').style.display = 'none';
            document.getElementById('exit-arrow-container').style.display = 'none';
            document.getElementById('shotgun-hud').style.display = 'none';

            // Configure Difficulty HUD & State
            const badge = document.getElementById('difficulty-hud-badge');
            badge.innerText = `MODE: ${diffCfg.label}`;
            badge.style.borderColor = diffCfg.id === 'impossible' ? '#ff2a2a' : (diffCfg.id === 'extreme' ? '#ff6b35' : '#666');
            badge.style.color = diffCfg.id === 'impossible' ? '#ff2a2a' : (diffCfg.id === 'extreme' ? '#ff6b35' : '#e6c84c');

            const livesHud = document.getElementById('lives-hud');
            if (diffCfg.chances > 1) {
                livesHud.style.display = 'block';
                livesHud.innerText = `CHANCES REMAINING: ${diffCfg.chances}`;
                livesHud.style.color = '#66ff88';
            } else {
                livesHud.style.display = 'none';
            }

            document.getElementById('mic-container').style.display = GameState.micEnabled ? 'block' : 'none';
            document.getElementById('mic-label').style.display = GameState.micEnabled ? 'block' : 'none';

            try { controls.lock(); } catch (e) {}
            
            // Reset state
            GameState.isRunning = true;
            GameState.isPaused = false;
            document.getElementById('pause-menu').style.display = 'none';
            GameState.isJumpscaring = false;
            GameState.jumpscareEntity = null;
            GameState.isBeingChased = false;
            document.getElementById('chase-border').style.opacity = '0';
            document.getElementById('jumpscare-flash').style.display = 'none';

            GameState.chancesRemaining = diffCfg.chances;
            GameState.globalMonsterPauseTimer = 0;
            GameState.graceTimer = 0;
            GameState.exitArrowTimer = diffCfg.exitArrowInterval || 45;
            GameState.exitArrowShowTimer = 0;
            GameState.pingTimer = diffCfg.pingInterval || 30;
            GameState.hasShotgun = false;
            shotgunViewGroup.visible = false;
            if (_cpRestore) Attraction.cpRestore(); else resetInventory(debug);
            GameState.jumpscareEntity = null;

            GameState.player.speed = GameState.player.baseSpeed * diffCfg.playerSpeedMult;
            GameState.player.sanity = PermaFx.maxSan();
            GameState.player.stamina = 100; GameState.player._winded = false; GameState.player._exh = 0; GameState.player._lock = 0;
            GameState.player.battery = 100; GameState.player.mega = false;
            GameState.player.flashlightOn = true;
            flashLight.visible = true;
            flashLight.intensity = 4.2 * PermaFx.light();
            GameState.timeAlive = 0;
            GameState.lastFrameTime = performance.now();
            
            GameState.debugRoom = !!debug; GameState.lastCoinAward = 0;
            buildLevel(startLevel, !debug); Attraction._restoring = false;
        }

        // Something unseen in the "ocean"-deep water lunges at the player: a scare, not a kill.
        function poolsOceanScare() { // a tiny pale thing darts out of the dark and into your face
            const p = controls.getObject().position, fw = new THREE.Vector3(), rt = new THREE.Vector3();
            camera.getWorldDirection(fw); rt.crossVectors(fw, new THREE.Vector3(0, 1, 0)).normalize();
            const m = makeTinyCreature(); m.scale.setScalar(0.5); scene.add(m);
            const a = p.clone().addScaledVector(fw, 7).addScaledVector(rt, (Math.random() - 0.5) * 6); a.y += (Math.random() - 0.5) * 3;
            const b = p.clone().addScaledVector(fw, 0.7); b.y -= 0.1;
            (GameState.tinies = GameState.tinies || []).push({ m, a, b, t: 0 }); m.position.copy(a);
            AudioSys.playMonsterSpot();
            setTimeout(() => {
                GameState.oceanShake = 1; GameState.player.sanity = Math.max(0, GameState.player.sanity - 14);
                const flash = document.getElementById('jumpscare-flash'); flash.style.display = 'block'; setTimeout(() => { flash.style.display = 'none'; }, 200);
            }, 600);
        }

        function triggerJumpscare(entity) {
            if (GameState.isJumpscaring) return;
            GameState.isJumpscaring = true;
            GameState.jumpscareEntity = entity;
            GameState.jumpscareTimer = 1.05;
            AudioSys.playJumpscare();
            document.getElementById('jumpscare-flash').style.display = 'block';
            flashLight.visible = true;
            flashLight.intensity = 8.5;
        }

        function gameOver() {
            if (MP.active && MP.onDeath()) return; // multiplayer: you become a ghost instead of seeing the death screen
            if ((LevelData[GameState.level] || {}).noLeave) setTimeout(() => { try { exitToMenu(); } catch (e) { location.reload(); } }, 3500); // death here sends you to the main menu
            if (GameState.isJumpscaring && GameState.jumpscareEntity) unlockAch('die_' + GameState.jumpscareEntity.type);
            Attraction.noteDeath(); // dying mid-bossfight sends you back to Level 7 with its inventory checkpoint
            clearVRHands();
            GameState.isRunning = false;
            GameState.isJumpscaring = false;
            try { controls.unlock(); } catch (e) {}
            document.getElementById('ui-layer').style.display = 'none';
            document.getElementById('vhs-hud').style.display = 'none';
            document.getElementById('chase-border').style.opacity = '0';
            document.getElementById('jumpscare-flash').style.display = 'none';
            document.getElementById('death-screen').style.display = 'flex';
            const title = document.getElementById('end-title');
            title.innerText = GameState.deathMsg || "YOU CLIPPED OUT"; GameState.deathMsg = null;
            title.style.color = "#f00";
            document.getElementById('survival-time').innerText = `You survived for ${Math.floor(GameState.timeAlive)} seconds on ${DifficultyConfigs[GameState.difficulty].label}.`;
            document.getElementById('static-overlay').style.opacity = '0';
            document.body.style.filter = 'none';
            flashLight.intensity = 4.2 * PermaFx.light();
            unloadRun();
        }

        // Tear the run down on death: stop all audio loops, clear jumpscare/chase state, remove the level and every entity.
        // The next startGame() rebuilds everything from scratch.
        function unloadRun() {
            try { ChaseAudio.set(0); } catch (e) {}
            try { ShopRadio.stop(); Sfx.setLoop('chase_music', false); stopAmbience(); if (Sfx.cur) Sfx.cur.stop(); } catch (e) {}
            try { MicSys.disable(); } catch (e) {}
            GameState.isJumpscaring = false; GameState.jumpscareEntity = null; GameState.jumpscareTimer = 0;
            GameState.isBeingChased = false; GameState.chasePulseTimer = 0; GameState.chaseI = 0;
            GameState.hidden = false; GameState.hideDrop = 0; GameState.clk = null;
            GameState.globalMonsterPauseTimer = 0; GameState.graceTimer = 0; GameState.lightsOutEvent = false;
            for (const k of ['chase-pulse', 'static-overlay', 'chase-border']) { const el = document.getElementById(k); if (el) el.style.opacity = '0'; }
            camera.fov = GameState.baseFov || 75; camera.rotation.z = 0; camera.updateProjectionMatrix();
            shotgunViewGroup.visible = false; GameState.hasShotgun = false;
            // remove the level + all entities/items/props from the scene (keeps only the player object and ambient light)
            for (let i = scene.children.length - 1; i >= 0; i--) {
                const obj = scene.children[i]; if (obj === controls.getObject() || obj === ambientLight) continue;
                obj.traverse(o => { if (o.geometry && o.geometry.dispose) o.geometry.dispose(); });
                scene.remove(obj);
            }
            if (GameState.floorReflector) { if (GameState.floorReflector.dispose) GameState.floorReflector.dispose(); GameState.floorReflector = null; }
            GameState.entities = []; GameState.items = []; GameState.props = []; GameState.ceilingLights = []; GameState.rtBounceLights = [];
            GameState.partygoers = []; GameState.arcades = []; GameState.hideSpots = [];
            Attraction.reset();
        }

        function winGame() {
            clearVRHands();
            GameState.isRunning = false;
            try { controls.unlock(); } catch (e) {}
            document.getElementById('ui-layer').style.display = 'none';
            document.getElementById('vhs-hud').style.display = 'none';
            document.getElementById('chase-border').style.opacity = '0';
            document.getElementById('death-screen').style.display = 'flex';

            const title = document.getElementById('end-title');
            title.innerText = "YOU ESCAPED";
            title.style.color = "#0f0";
            document.getElementById('survival-time').innerText = `Total time: ${Math.floor(GameState.timeAlive)} seconds (${DifficultyConfigs[GameState.difficulty].label} Mode).` + (GameState.lastCoinAward ? ` Final level reward: +${GameState.lastCoinAward} coins.` : '');

            // Award permanent achievement if beaten on Impossible difficulty
            if (GameState.difficulty === 'impossible' && !GameState.debugRoom) {
                localStorage.setItem('backrooms_impossible_beaten', 'true');
                unlockAch('impossible');
                const timestamp = new Date().toISOString().split('T')[0];
                localStorage.setItem('backrooms_impossible_date', timestamp);
                const achCard = document.getElementById('end-achievement-card');
                achCard.style.display = 'block';
                document.getElementById('achievement-proof-code').innerText = `VERIFIED CLEAR DATE: ${timestamp} | CLEAR TIME: ${Math.floor(GameState.timeAlive)}s`;
                refreshAchievementUI();
            }
        }

        // --- MAIN LOOP ---
        const velocity = new THREE.Vector3();
        let stepTimer = 0;

        function gameLoop(time) {
            if (!GameState.isRunning || GameState.isPaused) {
                if (!GameState.isRunning) { ChaseAudio.set(0); Sfx.setLoop('chase_music', false); stopAmbience(); if (GameState.debugScene) debugTick(time); else if (menuVisible()) renderMenu(time); }
                GameState.lastFrameTime = time;
                requestAnimationFrame(gameLoop);
                return;
            }

            fpsSample(time - GameState.lastFrameTime);
            const dt = Math.min((time - GameState.lastFrameTime) / 1000, 0.1);
            GameState.lastFrameTime = time;
            const diffCfg = DifficultyConfigs[GameState.difficulty];
            if (GameState.mpMenu || GameState.chatOpen) for (const k in keys) keys[k] = false; // soft pause: the world keeps running, you stand still
            if (GameState.inShop) { // the shop room is fully safe: nothing drains, nothing spawns
                GameState.exitArrowTimer = 999; GameState.pingTimer = 999; GameState.shotgunSpawnTimer = 99; GameState.lightsOutTimer = 99;
                const P = GameState.player; P.sanity = Math.max(P.sanity, GameState._shopSan || 0); P.battery = Math.max(P.battery, GameState._shopBat || 0);
                if (GameState.shopTick) GameState.shopTick(time);
            }

            // Handle visceral Jumpscare camera lock & shake sequence before death screen
            if (GameState.isJumpscaring && GameState.jumpscareEntity) {
                GameState.jumpscareTimer -= dt;
                const p = controls.getObject().position;
                const forward = new THREE.Vector3();
                camera.getWorldDirection(forward);
                forward.y = 0;
                forward.normalize();

                const ent = GameState.jumpscareEntity.mesh;
                ent.position.copy(p).addScaledVector(forward, 1.05);
                ent.position.y = 1.65 + (Math.random() - 0.5) * 0.25;
                ent.lookAt(p.x, ent.position.y, p.z);

                camera.rotation.z = 0;
                camera.fov = 52 + Math.random() * 14;
                camera.updateProjectionMatrix();

                renderMain();
                if (GameState.jumpscareTimer <= 0) {
                    camera.rotation.z = 0;
                    gameOver();
                    requestAnimationFrame(gameLoop); // keep the single loop alive after death (idles in the not-running branch)
                } else {
                    requestAnimationFrame(gameLoop);
                }
                return;
            }

            GameState.timeAlive += dt;
            if (GameState.globalMonsterPauseTimer > 0) GameState.globalMonsterPauseTimer -= dt;
            if (GameState.graceTimer > 0) GameState.graceTimer -= dt;

            if (GameState.bannerTimer > 0) {
                GameState.bannerTimer -= dt;
                if (GameState.bannerTimer <= 0) {
                    document.getElementById('event-banner').style.display = 'none';
                }
            }

            // Update VHS Tape Timestamp (HH:MM:SS)
            const totalSecs = Math.floor(GameState.timeAlive);
            const hrs = String(Math.floor(totalSecs / 3600)).padStart(2, '0');
            const mins = String(Math.floor((totalSecs % 3600) / 60)).padStart(2, '0');
            const secs = String(totalSecs % 60).padStart(2, '0');
            document.getElementById('vhs-timer').innerText = `${hrs}:${mins}:${secs}`;

            // --- Player Movement & Collision ---
            const p = controls.getObject().position;
            const speed = GameState.player.speed;
            GameState.player._immob = Math.max(0, GameState.player._immob - dt); // bacterium screams / punches unfreeze over time

            // --- Water physics (Poolrooms): walk in shallows; SPACE rises, SHIFT sinks, SHIFT+W swims freely along your view ---
            const SURF = -0.22, cs0 = GameState.cellSize, gx0 = Math.round(p.x / cs0), gz0 = Math.round(p.z / cs0);
            const floorY = GameState.poolFl ? (((GameState.poolFl[gz0] || [])[gx0]) || 0) : 0, waterD = floorY < 0 ? SURF - floorY : 0;
            if (GameState.poolFl) {
                if (!GameState.swimming && waterD > 1.8) { GameState.swimming = true; if (!GameState.swimHint) { GameState.swimHint = true; showEventBanner('SPACE: RISE   SHIFT: SINK   SHIFT+W: SWIM FORWARD', 4.5); } }
                else if (GameState.swimming && waterD < 1.3) GameState.swimming = false;
            } else { GameState.swimming = false; GameState.eyeY = 2; GameState.vy = 0; }
            const isSwimming = GameState.swimming, swimFwd = isSwimming && keys.shift && keys.w;
            if (GameState.poolFl) {
                if (isSwimming) {
                    const vT = keys[' '] ? 2.6 : (keys.shift && !keys.w ? -2.8 : -0.5);
                    GameState.vy += (vT - GameState.vy) * Math.min(1, dt * 4);
                    let ey = GameState.eyeY + GameState.vy * dt;
                    if (swimFwd) { const d3 = new THREE.Vector3(); camera.getWorldDirection(d3); ey += d3.y * 4.5 * dt; }
                    ey = Math.min(SURF + 0.32, Math.max(floorY + 0.5, ey)); if (ey >= SURF + 0.32 && GameState.vy > 0) GameState.vy = 0;
                    GameState.eyeY = ey;
                } else { GameState.vy = 0; GameState.eyeY += (floorY + 2 - GameState.eyeY) * Math.min(1, dt * 6); }
            }
            if (GameState.oceanCells && p.y < -5 && GameState.oceanCells.has(gx0 + ',' + gz0)) { // the deep end: tiny things live down here
                GameState.oceanScareTimer -= dt; if (GameState.oceanScareTimer <= 0) { poolsOceanScare(); GameState.oceanScareTimer = 6 + Math.random() * 9; }
            }

            // Sprinting with difficulty stamina drain multiplier
            // Exhaustion (StamCfg): hitting 0 stamina -> slowed for 5s, then no regen for 3s, and no running until stamina is back to 25.
            const SP = GameState.player;
            if (SP.stamina <= 0 && !SP._winded) { SP._winded = true; SP._exh = StamCfg.slowTime; SP._lock = 0; showEventBanner('EXHAUSTED - SLOWED. REGAIN ' + StamCfg.runMin + '% STAMINA TO RUN AGAIN', 2.4); }
            if (SP.stamina < 0) SP.stamina = 0;
            if (SP._exh > 0) { SP._exh -= dt; if (SP._exh <= 0) { SP._exh = 0; SP._lock = StamCfg.regenLock; } }
            else if (SP._lock > 0) SP._lock -= dt;
            let isSprinting = false;
            if (keys.shift && !isSwimming && SP.stamina > 0 && !SP._winded && (keys.w || keys.a || keys.s || keys.d)) {
                isSprinting = true;
                SP.stamina = Math.max(0, SP.stamina - 11 * diffCfg.staminaDrainMult * PermaFx.stamDrain() * dt);
            } else if (!(SP._lock > 0) && !(StamCfg.lockDuringSlow && SP._exh > 0)) {
                SP.stamina = Math.min(100, SP.stamina + 9 * dt);
            }
            if (SP._winded && SP.stamina >= StamCfg.runMin) SP._winded = false;
            const waterSlow = (isSwimming ? (swimFwd ? 1.2 : 0.6) : (waterD > 0.25 ? 0.7 : 1)) * (SP._exh > 0 ? StamCfg.slow : 1);
            const currentSpeed = (isSprinting ? speed * GameState.player.runMultiplier : speed) * waterSlow;

            // Friction
            velocity.x -= velocity.x * 10.0 * dt;
            velocity.z -= velocity.z * 10.0 * dt;

            // Calculate camera-relative forward and right vectors on the XZ plane
            const forward = new THREE.Vector3();
            camera.getWorldDirection(forward);
            forward.y = 0;
            forward.normalize();
            const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

            const moveInput = new THREE.Vector3();
            if (GameState.player._immob > 0) moveInput.set(0, 0, 0); // immobilized by bacterium scream/punch
            else {
                if (keys.w) moveInput.add(forward);
                if (keys.s) moveInput.sub(forward);
                if (keys.d) moveInput.add(right);
                if (keys.a) moveInput.sub(right);
                if (moveInput.lengthSq() > 0) moveInput.normalize();
            }

            velocity.x += moveInput.x * 40.0 * dt;
            velocity.z += moveInput.z * 40.0 * dt;

            let moveX = velocity.x * dt * (currentSpeed / 4.0);
            let moveZ = velocity.z * dt * (currentSpeed / 4.0);
            if (window.__vrMove) { moveX += window.__vrMove.x; moveZ += window.__vrMove.z; window.__vrMove = null; }
            if (Haven.on && Haven.pre(dt, p, keys)) { moveX = 0; moveZ = 0; velocity.x = 0; velocity.z = 0; } // Level 9: ladders, gravity, terrain

            const radius = 0.6;
            const cs = GameState.cellSize;
            
            const isWalkable = (worldX, worldZ) => {
                const offsets = [
                    [-radius, -radius], [radius, -radius],
                    [-radius, radius], [radius, radius]
                ];
                for (let [ox, oz] of offsets) {
                    const gx = Math.round((worldX + ox) / cs);
                    const gz = Math.round((worldZ + oz) / cs);
                    if (GameState.poolFl && GameState.eyeY < -0.5 && (GameState.poolFl[gz] || [])[gx] === 0) return false; // no swimming up through a ledge from below
                    if (!GameState.grid[gz] || GameState.grid[gz][gx] === 1) {
                        return false;
                    }
                }
                // furniture / clutter / crates sitting in the hallways: oriented-box collision (never traps you if you already overlap one)
                const cl = GameState.colliders;
                if (cl && cl.length) {
                    const hit = (c, x, z) => {
                        const dx = x - c.x, dz = z - c.z, rr = c.r + radius;
                        if (dx * dx + dz * dz > rr * rr) return false;
                        const lx = c.cos * dx - c.sin * dz, lz = c.sin * dx + c.cos * dz;
                        const ex = lx - Math.max(-c.hw, Math.min(c.hw, lx)), ez = lz - Math.max(-c.hd, Math.min(c.hd, lz));
                        return ex * ex + ez * ez < radius * radius;
                    };
                    for (let i = 0; i < cl.length; i++) if (hit(cl[i], worldX, worldZ) && !hit(cl[i], p.x, p.z)) return false;
                }
                return true;
            };

            if (isWalkable(p.x + moveX, p.z)) {
                p.x += moveX;
            } else {
                velocity.x = 0;
            }

            if (isWalkable(p.x, p.z + moveZ)) {
                p.z += moveZ;
            } else {
                velocity.z = 0;
            }

            // Footsteps, Head Bob & Footstep Sound Attraction
            const speedSq = velocity.x * velocity.x + velocity.z * velocity.z;
            if (speedSq > 0.25) {
                stepTimer -= dt * (isSprinting ? 1.65 : 1.0);
                if (stepTimer <= 0) {
                    stepTimer = 0.48;
                    AudioSys.playStep();

                    // Alert nearby entities based on difficulty footstep volume
                    const hearRange = isSprinting ? diffCfg.footstepHearRangeSprint : diffCfg.footstepHearRangeWalk;
                    GameState.entities.forEach(ent => {
                        if (ent.mesh.position.distanceTo(p) <= hearRange) {
                            ent.alertToPosition(p, 8);
                        }
                    });
                }
                p.y = 2 + Math.sin(time * (isSprinting ? 0.015 : 0.01)) * 0.06;
                if (GameState.hasShotgun) {
                    shotgunViewGroup.position.y = -0.24 + Math.sin(time * (isSprinting ? 0.015 : 0.01)) * 0.012;
                }
                { const hm = heldGroup.children[0]; if (hm) hm.position.y = hm.userData.baseY + Math.sin(time * (isSprinting ? 0.015 : 0.01)) * 0.012; }
            } else {
                p.y = 2;
            }
            if (Haven.on) p.y += Haven.oy;
            if (GameState.poolFl) { // real eye height from the water physics, then underwater fog, whirlpools, tiny scares, glitch panels, drips
                p.y += GameState.eyeY - 2; if (isSwimming) p.y += Math.sin(time * 0.0035) * 0.06;
                const dep = Math.max(0, SURF - p.y);
                if (dep > 0) { const dn = Math.min(0.4, 0.07 + dep * 0.012) * (GameState.uwK || 1); scene.fog.color.setHex(0x0a3d57); scene.background.setHex(0x0a3d57); GameState.baseFogD = dn; scene.fog.density = dn; GameState.uw = true; }
                else if (GameState.uw) { GameState.uw = false; scene.fog.color.setHex(GameState.fogCol); scene.background.setHex(GameState.fogCol); GameState.baseFogD = GameState.dryFogD; scene.fog.density = GameState.dryFogD; }
                for (const w of GameState.whirls || []) {
                    w.grp.rotation.y -= dt * 1.8; w.ring.material.opacity = 0.55 + 0.4 * Math.sin(time * 0.006);
                    const dx = p.x - w.x, dz = p.z - w.z, d = Math.hypot(dx, dz) || 0.01;
                    if (d < w.R * 0.8 && p.y < 1.2) {
                        w.t = (w.t || 0) + dt; w.rolled = true;
                        p.x += (-dz / d * 3.4 - dx / d * 1.8) * dt; p.z += (dx / d * 3.4 - dz / d * 1.8) * dt;
                        camera.rotation.z = Math.sin(time * 0.01) * 0.12 * Math.min(1, w.t);
                        if (!w.warned) { w.warned = true; showEventBanner('THE WHIRLPOOL IS PULLING YOU DOWN!', 2.5); }
                        if (d < w.R * 0.22 || w.t > 3.5) { GameState.deathMsg = 'SWALLOWED BY THE WHIRLPOOL'; camera.rotation.z = 0; gameOver(); requestAnimationFrame(gameLoop); return; }
                    } else { w.t = Math.max(0, (w.t || 0) - dt * 2); w.warned = false; if (w.rolled) { w.rolled = false; camera.rotation.z = 0; } }
                }
                GameState.tinies = (GameState.tinies || []).filter(t => { t.t += dt; const k = Math.min(1, t.t / 0.7); t.m.position.lerpVectors(t.a, t.b, k); t.m.lookAt(t.b); if (k >= 1) { scene.remove(t.m); return false; } return true; });
                { // Leviathans: patrol the deep; swimming draws one in. It stalks, lunges and kills anyone still in the water. Dry land is safe.
                    const inW = p.y < 1.2; GameState.levExp = Math.max(0, Math.min(20, (GameState.levExp || 0) + (inW ? dt * (isSprinting ? 1.7 : 1) : -dt * 1.5)));
                    const lv = GameState.levs || [], hunting = lv.some(o => o.mode === 'hunt' || o.mode === 'lunge');
                    let nearest = null, nd = 1e9; for (const o of lv) { const d0 = Math.hypot(o.g.position.x - p.x, o.g.position.z - p.z); if (d0 < nd) { nd = d0; nearest = o; } }
                    let shake = 0;
                    for (const l of lv) {
                        if (!l.mode) { l.mode = 'patrol'; l.cd = 0; l.t = 0; l.g.position.set(l.mid + Math.cos(l.a) * l.R, l.y, l.mid + Math.sin(l.a) * l.R); }
                        l.cd = Math.max(0, l.cd - dt); l.t += dt;
                        const lp = l.g.position, hd = Math.hypot(p.x - lp.x, p.z - lp.z);
                        if (l.mode === 'patrol' || l.mode === 'retreat') {
                            l.a += dt * l.sp; const tx = l.mid + Math.cos(l.a) * l.R, tz = l.mid + Math.sin(l.a) * l.R, k = Math.min(1, dt * (l.mode === 'retreat' ? 0.5 : 1.5));
                            lp.x += (tx - lp.x) * k; lp.y += (l.y - lp.y) * k; lp.z += (tz - lp.z) * k; l.g.rotation.set(0, -l.a, 0);
                            if (l.mode === 'retreat' && l.t > 6) l.mode = 'patrol';
                            if (l.mode === 'patrol' && !hunting && l === nearest && l.cd <= 0 && GameState.levExp > 7) { l.mode = 'hunt'; l.t = 0; l.lost = 0; showEventBanner('SOMETHING HAS NOTICED YOU. GET OUT OF THE WATER.', 3.5); try { AudioSys.at(lp).playLeviathan(); } catch (e) {} GameState.player.sanity = Math.max(0, GameState.player.sanity - 8); }
                        } else {
                            l.lost = inW ? 0 : (l.lost || 0) + dt;
                            const lunge = l.mode === 'lunge', sp = lunge ? 30 : 11, ty = lunge ? p.y - 1 : Math.max(-26, p.y - 18);
                            const dx = p.x - lp.x, dz = p.z - lp.z, dy = ty - lp.y, dl = Math.hypot(dx, dy, dz) || 1, st = Math.min(sp * dt, dl);
                            lp.x += dx / dl * st; lp.y += dy / dl * st; lp.z += dz / dl * st; l.g.lookAt(p.x, lunge ? p.y : lp.y, p.z); shake = Math.max(shake, Math.min(1, 40 / (hd + 8)));
                            l.snd = (l.snd || 0) - dt; if (l.snd <= 0) { l.snd = 3; try { AudioSys.at(lp).playLeviathan(); } catch (e) {} }
                            if (l.mode === 'hunt' && hd < 17 && inW) { l.mode = 'lunge'; l.t = 0; showEventBanner('IT IS RISING.', 1.8); }
                            if (l.mode === 'lunge' && inW && lp.distanceTo(p) < 7) { GameState.deathMsg = 'DEVOURED BY THE LEVIATHAN'; camera.rotation.z = 0; gameOver(); requestAnimationFrame(gameLoop); return; }
                            if (l.lost > 2.5 || (l.mode === 'lunge' && l.t > 4) || l.t > 40) { l.mode = 'retreat'; l.t = 0; l.cd = 30; GameState.levExp = 0; if (!inW) showEventBanner('IT LOST YOU. FOR NOW.', 2.5); }
                        }
                        l.segs.forEach((m, k) => { m.position.x = Math.sin(time * 0.0009 - k * 0.6) * 1.4; });
                        const dd = lp.distanceTo(p);
                        if (l.mode === 'patrol' && dd < 45 && !l.near) { l.near = true; showEventBanner('SOMETHING MASSIVE PASSES BENEATH YOU', 3); try { AudioSys.at(lp).playLeviathan(); } catch (e) {} GameState.player.sanity = Math.max(0, GameState.player.sanity - 6); } else if (dd > 70) l.near = false;
                    }
                    if (shake > 0) { camera.rotation.z = Math.sin(time * 0.045) * 0.03 * shake; GameState.levShook = true; } else if (GameState.levShook) { GameState.levShook = false; camera.rotation.z = 0; }
                }
                for (const u of GameState.lures || []) u.o.position.y = u.y + Math.sin(time * 0.001 + u.ph) * 0.8;
                GameState.tpCd = Math.max(0, (GameState.tpCd || 0) - dt);
                for (const g of GameState.glitchPanels || []) {
                    const dd = g.m.position.distanceTo(p);
                    if (g.kind === 'enter') g.m.visible = dd < 9;
                    if (g.m.visible) g.m.material.map.offset.set(Math.random(), Math.random());
                    if (dd < 1.7 && GameState.tpCd <= 0) {
                        GameState.tpCd = 2; p.x = g.to.x; p.z = g.to.z; p.y = 2; GameState.eyeY = 2; GameState.vy = 0; GameState.swimming = false; velocity.x = 0; velocity.z = 0;
                        showEventBanner(g.kind === 'enter' ? 'THE WALL WASN\'T REAL.' : 'BACK TO THE WATER.', 2.5); AudioSys.playSecretItem(); break;
                    }
                }
                GameState.dripT = (GameState.dripT === undefined ? 4 : GameState.dripT) - dt;
                if (GameState.dripT <= 0) { GameState.dripT = 2.5 + Math.random() * 8; try { const q = controls.getObject().position, a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 14; AudioSys.at(new THREE.Vector3(q.x + Math.cos(a) * r, 0.5, q.z + Math.sin(a) * r)).playDrip(); } catch (e) {} }
            }

            // --- Microphone Noise Attraction ---
            if (GameState.micEnabled && MicSys.active && !MP.active) { // (in multiplayer the voice-chat mic drives monster hearing for everyone, see MP.tick)
                const vol = MicSys.getVolume();
                GameState.micVolume = vol;
                const micBar = document.getElementById('mic-bar');
                micBar.style.width = `${Math.round(vol * 100)}%`;
                micBar.style.background = vol > 0.65 ? '#ff3b30' : (vol > 0.3 ? '#ffcc00' : '#4cd964');

                GameState.micAttractCooldown = Math.max(0, GameState.micAttractCooldown - dt);
                if (vol > 0.14 && GameState.micAttractCooldown <= 0) {
                    GameState.micAttractCooldown = 0.35;
                    // Louder voice reaches much farther across the maze and draws more entities
                    const attractRadius = 8 + vol * 44;
                    let attracted = 0;
                    GameState.entities.forEach(ent => {
                        if (ent.mesh.position.distanceTo(p) <= attractRadius) {
                            ent.alertToPosition(p, 10 + vol * 10);
                            attracted++;
                        }
                    });
                    if (vol > 0.72 && attracted > 0) {
                        showEventBanner("YOUR VOICE ECHOED THROUGH THE HALLS!", 1.5);
                    }
                }
            }

            // --- Difficulty Special Timers ---
            // 1. Easy Mode: Every 45s show Exit Arrow for 5s
            if (!MP.active && diffCfg.exitArrowInterval > 0) {
                if (GameState.exitArrowShowTimer > 0) {
                    GameState.exitArrowShowTimer -= dt;
                    const arrowWrap = document.getElementById('exit-arrow-container');
                    arrowWrap.style.display = 'flex';
                    document.getElementById('exit-arrow-label').innerText = `EXIT SIGNAL (${Math.max(0, GameState.exitArrowShowTimer).toFixed(1)}s)`;

                    // Compute angle from player's facing direction to Exit
                    const toExit = new THREE.Vector3().subVectors(GameState.exitPos, p).setY(0).normalize();
                    const playerYaw = Math.atan2(-forward.x, -forward.z);
                    const exitYaw = Math.atan2(-toExit.x, -toExit.z);
                    let relAngle = (playerYaw - exitYaw) * (180 / Math.PI);
                    document.getElementById('exit-arrow-svg').style.transform = `rotate(${relAngle}deg)`;

                    if (GameState.exitArrowShowTimer <= 0) {
                        arrowWrap.style.display = 'none';
                    }
                } else {
                    GameState.exitArrowTimer -= dt;
                    if (GameState.exitArrowTimer <= 0) {
                        GameState.exitArrowTimer = diffCfg.exitArrowInterval;
                        GameState.exitArrowShowTimer = diffCfg.exitArrowDuration;
                        AudioSys.playPickup();
                    }
                }
            }

            // 2. Extreme Mode: Monsters ping location every 30s & occasional shotgun spawns
            if (diffCfg.pingInterval > 0) {
                GameState.pingTimer -= dt;
                if (GameState.pingTimer <= 0) {
                    GameState.pingTimer = diffCfg.pingInterval;
                    AudioSys.playPing();
                    showEventBanner("LOCATION PINGED — ENTITIES HAVE YOUR COORDINATES!", 3.2);
                    GameState.entities.forEach(ent => ent.alertToPosition(p, 22));
                }
            }

            if (diffCfg.shotgunSpawns && !GameState.shotgunSpawnedInWorld && !GameState.hasShotgun) {
                GameState.shotgunSpawnTimer -= dt;
                if (GameState.shotgunSpawnTimer <= 0) {
                    GameState.shotgunSpawnTimer = 30;
                    trySpawnOccasionalShotgun();
                }
            }

            // Darkness Sanity Drain (scaled by difficulty)
            if (!GameState.player.flashlightOn && ambientLight.intensity < 0.12) {
                GameState.player.sanity -= 1.8 * diffCfg.sanityDrainMult * PermaFx.sanDrain() * dt;
            } else if (GameState.player.flashlightOn) {
                GameState.player.sanity = Math.min(PermaFx.maxSan(), GameState.player.sanity + 0.4 * dt);
            }

            if (GameState.player.sanity <= 0) {
                gameOver();
                requestAnimationFrame(gameLoop); // single loop: keep it alive after death
                return;
            }

            // --- Shotgun-mounted flashlight / ambient light / brightness ---
            { const P = GameState.player; if (!window.__vrOn) GameState._flMount = !!(GameState.inv[GameState.invSel] && GameState.inv[GameState.invSel].id === 'shotgun');
              if (!GameState._flMount) P._mountOff = false; else if (!P._mountOff && P.battery > 0) { P.flashlightOn = true; flashLight.visible = true; }
              if (!GameState.isJumpscaring) flashLight.intensity = 4.2 * PermaFx.light();
              const cp = controls.getObject().position; if (cp.distanceTo(playerAmbient.userData.last) >= 0.1) { playerAmbient.userData.last.copy(cp); playerAmbient.position.set(cp.x, cp.y - 0.2, cp.z); } }
            // --- Flashlight Battery & Ceiling Light Fixture Flicker ---
            if (GameState.player.flashlightOn) {
                const hb = houndBeamCount(); // staring at hounds with the light on feeds them
                GameState.player.battery = Math.max(0, GameState.player.battery - (0.35 + hb * HoundCfg.beamDrain) * PermaFx.battery() * (GameState._flMount ? 0.5 : 1) * dt); if (GameState.player.mega && GameState.player.battery <= 100) GameState.player.mega = false;
                if (hb > 0 && performance.now() > (GameState._hbMsg || 0)) { GameState._hbMsg = performance.now() + 15000; showEventBanner('THE HOUND FEEDS ON YOUR LIGHT - LOOK AWAY OR SWITCH IT OFF', 2.5); }
                if (GameState.player.battery === 0) {
                    GameState.player.flashlightOn = false;
                    flashLight.visible = false;
                }
            }

            // Animate Ceiling Lights (authentic fluorescent buzz/flicker on Level 0 & 0.2)
            if (!GameState.lightsOutEvent && (GameState.level === 0 || GameState.level === 1)) {
                for (let i = 0; i < GameState.ceilingLights.length; i++) {
                    const cl = GameState.ceilingLights[i];
                    if (cl.flickers && Math.random() < 0.04) {
                        const dip = Math.random() > 0.5 ? 0.15 : 1.0;
                        cl.panelMat.emissiveIntensity = cl.baseEmissive * dip;
                        if (cl.pointLight) cl.pointLight.intensity = cl.baseIntensity * dip;
                    }
                }
            }

            // Path-Tracing Indirect Bounce Light reacts dynamically to flashlight state
            if (GameState.graphics.rtMode === 'pathtracing') {
                pathTraceBounceLight.intensity = GameState.player.flashlightOn ? 0.95 : 0.25;
            }

            // Lights out gimmick (Level 1: Habitable Zone)
            if (LevelData[GameState.level].gimmick === 'lightsout') {
                GameState.lightsOutTimer -= dt;
                if (GameState.lightsOutTimer <= 0) {
                    GameState.lightsOutEvent = !GameState.lightsOutEvent;
                    GameState.lightsOutTimer = GameState.lightsOutEvent ? 30 : 45;
                    ambientLight.intensity = GameState.lightsOutEvent ? 0.02 : ((diffCfg.pitchBlackFog || Settings.nightmare) ? 0.16 : 0.28);
                    GameState.ceilingLights.forEach(cl => {
                        const mult = GameState.lightsOutEvent ? 0.0 : 1.0;
                        cl.panelMat.emissiveIntensity = cl.baseEmissive * mult;
                        if (cl.pointLight) cl.pointLight.intensity = cl.baseIntensity * mult;
                    });
                    if (GameState.lightsOutEvent) {
                        AudioSys.playMonsterSound('bacteria', 5);
                        showEventBanner("POWER FAILURE — LIGHTS OUT!", 2.5);
                    }
                }
            }

            // Steam gimmick (Level 2)
            if (LevelData[GameState.level].gimmick === 'steam') {
                GameState.props.forEach(prop => {
                    if (prop.type === 'steam') {
                        prop.timer -= dt;
                        if (prop.timer <= 0) {
                            prop.active = !prop.active;
                            prop.timer = prop.active ? 2 : 4;
                            prop.mesh.visible = prop.active;
                        }
                        if (prop.active && prop.mesh.position.distanceTo(p) < 2) {
                            GameState.player.sanity -= 10 * diffCfg.sanityDrainMult * PermaFx.sanDrain() * dt;
                            GameState.player.stamina -= 20 * diffCfg.staminaDrainMult * dt;
                        }
                    }
                });
            }

            // Electrical Sparks gimmick (Level 3)
            if (LevelData[GameState.level].gimmick === 'sparks') {
                GameState.props.forEach(prop => {
                    if (prop.type === 'spark') {
                        prop.timer -= dt;
                        if (prop.timer <= 0) {
                            prop.active = !prop.active;
                            prop.timer = prop.active ? 1.5 : 3.5;
                            prop.mesh.visible = prop.active;
                            if (prop.active) AudioSys.at(prop.mesh.position).playSpark(0);
                        }
                        if (prop.active && prop.mesh.position.distanceTo(p) < 2.2) {
                            GameState.player.sanity -= 12 * diffCfg.sanityDrainMult * PermaFx.sanDrain() * dt;
                            GameState.player.battery = Math.max(0, GameState.player.battery - 15 * dt);
                        }
                    }
                });
            }

            inventoryTick(dt, p);
            { const L = LevelData[GameState.level]; if (L && L.gimmick === 'shift') ambientLight.color.setHSL((GameState.timeAlive * 0.012) % 1, 0.4, 0.17); }

            // Spin world pickups gently
            GameState.items.forEach(it => {
                if (it.type === 'item') {
                    if (!window.__vrOn) it.mesh.rotation.y += dt * 1.6;
                }
            });

            // --- Entities & Chase Sequence Logic ---
            let anyChasing = false;
            let closestChaserDist = 999;
            if (MP.active) MP.tick(dt, p);
            GameState.entities.forEach(e => {
                e.update(dt, MP.active ? MP.tgt(e, p) : p); e._tgtMe = !GameState._rt; GameState._rt = false; if (e.type === 'bacteria') bacteriaAbilityTick(e, dt, p);
                if (isHunting(e) && (!MP.active || e._tgtMe)) {
                    anyChasing = true;
                    const d = e.mesh.position.distanceTo(p);
                    if (d < closestChaserDist) closestChaserDist = d;
                }
            });

            if (GameState.isRunning && !GameState.inShop) { if (LevelData[GameState.level].attraction) Attraction.tick(dt, p); Attraction.footsteps(dt, p); if (Haven.on) Haven.tick(dt, p); }
            const bossCh = Attraction.musicOn(); if (bossCh) closestChaserDist = Math.min(closestChaserDist, Attraction.B.mesh.position.distanceTo(p));
            const hvCh = Haven.on && Haven.chasing; if (hvCh) closestChaserDist = Math.min(closestChaserDist, Haven.nearD);
            GameState.isBeingChased = anyChasing || bossCh || hvCh;
            const chaseBorder = document.getElementById('chase-border');
            // bossfight: no passive chase sanity drain (any difficulty but Impossible); Nightmare hides every chase warning but keeps the chase itself
            if (bossCh ? GameState.difficulty === 'impossible' : anyChasing) GameState.player.sanity -= 2.2 * diffCfg.sanityDrainMult * PermaFx.sanDrain() * dt;
            if ((anyChasing || bossCh) && !Settings.nightmare) {
                const intensity = Math.max(0.35, 1 - (closestChaserDist / 18));
                chaseBorder.style.opacity = String(intensity);
                GameState.chasePulseTimer -= dt;
                if (GameState.chasePulseTimer <= 0) {
                    GameState.chasePulseTimer = Math.max(0.28, closestChaserDist * 0.045);
                    AudioSys.playHeartbeat(0.45 * intensity);
                }
            } else {
                chaseBorder.style.opacity = '0';
            }

            // --- UI & Effects ---
            document.getElementById('stamina-bar').style.width = GameState.player.stamina + '%';
            document.getElementById('sanity-bar').style.width = Math.min(100, GameState.player.sanity / PermaFx.maxSan() * 100) + '%';
            document.getElementById('battery-bar').style.width = Math.min(100, GameState.player.battery) + '%';

            const chaseFovBoost = (anyChasing && !Settings.nightmare) ? (Math.sin(time / 90) * 2.5 + 7) : 0;
            if (GameState.oceanShake > 0) GameState.oceanShake = Math.max(0, GameState.oceanShake - dt * 1.4);
            const oceanShakeBoost = GameState.oceanShake > 0 ? Math.sin(time * 0.09) * 9 * GameState.oceanShake : 0;
            if (GameState.player.sanity < 70) {
                const s = GameState.player.sanity;
                document.getElementById('vignette').style.background = `radial-gradient(circle, transparent ${s}%, rgba(0,0,0,1) 100%)`;
                const blur = (70 - s) * 0.05;
                const sepia = (70 - s) * 1.5;
                const hue = Math.sin(time / 1000) * (70 - s);
                document.body.style.filter = `blur(${blur}px) sepia(${sepia}%) hue-rotate(${hue}deg)`;
                
                if (s < 40) {
                    document.getElementById('static-overlay').style.opacity = (40 - s) / 40;
                } else {
                    document.getElementById('static-overlay').style.opacity = 0;
                }

                if (!anyChasing && s < 30 && Math.random() < 0.02) {
                    AudioSys.playHeartbeat((30 - s) / 30);
                }

                camera.fov = 75 + chaseFovBoost + oceanShakeBoost + Math.sin(time / 500) * (50 - s) * 0.2;
                camera.updateProjectionMatrix();
            } else {
                document.body.style.filter = 'none';
                document.getElementById('static-overlay').style.opacity = 0;
                document.getElementById('vignette').style.background = 'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.92) 100%)';
                camera.fov = 75 + chaseFovBoost + oceanShakeBoost;
                camera.updateProjectionMatrix();
            }

            // Interaction prompt check
            let promptText = null;
            for (const fx of GameState.exitFx || []) fx();
            if (GameState.subDoor) { const sd = GameState.subDoor, sdd = Math.hypot(p.x - sd.x, p.z - sd.z); sd.mesh.material.opacity = sdd < 6 ? (Math.random() < 0.12 ? 0.35 : 0.06) : 0; if (sdd < 2.8) promptText = '[E] Search the Wall'; }
            if (GameState.secretWallCell && !GameState.secretWallFound) {
                const dx = p.x - GameState.secretWallCell.x, dz = p.z - GameState.secretWallCell.z;
                if (dx * dx + dz * dz < 2.6 * 2.6) promptText = '[E] Search the Wall';
            }
            for (let i = 0; i < GameState.items.length && !promptText; i++) {
                const it = GameState.items[i];
                if (it.mesh.position.distanceTo(p) < 2.6) {
                    if (it.type === 'exit') promptText = ({ glitch: '[E] Noclip Through the Wall', fireexit: '[E] Push the Fire Exit Open', elevator: '[E] Step Into the Elevator', door: '[E] Open the Door' })[it.mesh.userData.kind] || '[E] Enter Exit';
                    else if (it.mesh.userData.type === 'water') promptText = '[E] Take Almond Water';
                    else if (it.mesh.userData.type === 'battery') promptText = '[E] Take Battery';
                    else if (it.mesh.userData.type === 'shotgun') promptText = '[E] Pick Up Single-Use Shotgun';
                    else if (it.mesh.userData.type === 'tracker') promptText = '[E] Take Monster Tracker';
                    else if (it.mesh.userData.type === 'chest_locator') promptText = '[E] Take Chest Locator';
                    else if (it.mesh.userData.type === 'crowbar') promptText = '[E] Take Crowbar';
                    else if (it.mesh.userData.type === 'axe') promptText = '[E] Take Axe';
                    else if (it.mesh.userData.type === 'grenade') promptText = '[E] Take Grenade';
                    else if (it.mesh.userData.type === 'coin') promptText = '[E] Take Coin';
                    break;
                }
            }
            const promptEl = document.getElementById('interaction-prompt');
            if (promptText) {
                promptEl.innerText = promptText;
                promptEl.style.display = 'block';
            } else {
                promptEl.style.display = 'none';
            }

            renderMain();
            requestAnimationFrame(gameLoop);
        }

        // --- PERSISTENCE (all new progression data; debug/test code must never write here) ---
        const ld = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch (e) { return d; } };
        const sv = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
        const Save = { coins: ld('backrooms_coins', 0), pending: ld('backrooms_pending', []), stock: ld('backrooms_shop_stock', null), ach: ld('backrooms_achievements', {}), stunned: ld('backrooms_stunned', []), perma: ld('backrooms_perma', {}), permaOff: ld('backrooms_perma_off', false) };

        // --- PERMANENT UPGRADES (bought once in the shop's PERMANENT tab; all switched off by the "disable perma-upgrades" setting) ---
        const PERMA_PRICE = 100;
        const PermaDefs = [
            { id: 'flash', name: 'Strong Flashlight', icon: '\u{1F526}', desc: '1.5x flashlight brightness and 2x battery duration. Fog is 10% thinner.' },
            { id: 'will',  name: 'Will To Live',      icon: '\u{1F9E0}', desc: '+50% maximum sanity and 10% slower sanity drain.' },
            { id: 'blast', name: 'BLASTOFF',          icon: '\u{1F4A5}', desc: 'Shotgun stun lasts 25s. Shotguns start with 3 uses (5 after an ammo crate).' },
            { id: 'sonic', name: 'Sonic',             icon: '\u{1F45F}', desc: 'Sprint lasts 45% longer (stamina drains slower).' }
        ];
        const PermaFx = {
            has(id) { return !!Save.perma[id] && !Save.permaOff; },
            light() { return this.has('flash') ? 1.5 : 1; },
            battery() { return this.has('flash') ? 0.5 : 1; },
            fog() { return this.has('flash') ? 0.9 : 1; },
            maxSan() { return this.has('will') ? 150 : 100; },
            sanDrain() { return this.has('will') ? 0.9 : 1; },
            stun() { return this.has('blast') ? 25 : 20; },
            ammoStart() { return this.has('blast') ? 3 : 1; },
            ammoCrate() { return this.has('blast') ? 5 : 2; },
            stamDrain() { return this.has('sonic') ? 1 / 1.45 : 1; }
        };
        // Level-clear coin rewards
        const LEVEL_COINS = { easy: 5, normal: 12, hard: 15, extreme: 35, impossible: 75 };
        function awardLevelCoins() {
            if (GameState.debugRoom) return 0;
            const L = LevelData[GameState.level]; if (!L || L.party || L.hidden) return 0;
            let n = LEVEL_COINS[GameState.difficulty] || 0;
            if (GameState.difficulty === 'impossible' && Save.permaOff) n = 250; // Impossible with every perma-upgrade disabled
            Save.coins += n; sv('backrooms_coins', Save.coins); GameState.lastCoinAward = n; renderInv();
            showEventBanner(`LEVEL CLEARED: +${n} COINS`, 3.2);
            return n;
        }
        // Re-apply the parts of the upgrades that are normally only set when a run / level starts (used right after buying one in the live shop room)
        function applyPermaNow(oldMaxSan) {
            const P = GameState.player, k = PermaFx.maxSan() / (oldMaxSan || 100);
            if (k !== 1) { P.sanity *= k; if (GameState._shopSan != null) GameState._shopSan *= k; }
            if (!GameState.isJumpscaring) flashLight.intensity = 4.2 * PermaFx.light();
            const d = LevelData[GameState.level], dc = DifficultyConfigs[GameState.difficulty];
            if (d && dc && scene.fog && !GameState.uw) { const nd = d.fogDensity * dc.fogDensityMult * PermaFx.fog(); GameState.baseFogD = nd; scene.fog.density = nd; }
        }

        function batteryRestore() { return ({ hard: 25, extreme: 10, impossible: 5 })[GameState.difficulty] || 50; } // easy/normal: 50%
        // --- ITEMS & INVENTORY (5 slots; stacks for water/battery, single for shotgun/tracker) ---
        const TOOL_MAX = { tracker: 2, chest_locator: 3 }; // use counts (shown above these items in VR)
        // Swing-stun helper: stuns monsters within `reach` of the player (desktop) or the weapon tip (VR). Returns how many.
        function axeStunMonsters(seconds, pos, reach, { sound = 'axe', only = null } = {}) {
            let n = 0; GameState.entities.forEach(e => { if (e._minion) { const d = e.mesh.position.distanceTo(pos); if (only ? e === only : (d <= reach || (e.meleeRadius > 0 && d <= reach + e.meleeRadius))) { if (Attraction.hitMinion(e)) n++; } return; } if (e.stunTimer > 0) return; if (only && e !== only) return; const d = e.mesh.position.distanceTo(pos); if (!only && d > reach && !(e.meleeRadius > 0 && d <= reach + e.meleeRadius)) return; e.stun(seconds); recordStun(e.type); n++; });
            if (n) { // sound + vibration only on a successful stun (must be in range, swung fast, and hit)
                try { (sound === 'crowbar' ? AudioSys.playCrowbarSwing : AudioSys.playAxeSwing).call(AudioSys); } catch (e) {}
                [0, 1].forEach(i => vibI(i, 0.45, 170));
            }
            return n;
        }
        function segDistToPoint(sg, p) { // distance from point p to the segment [sg[0], sg[1]]
            _mL.set(sg[0], sg[1]); _mL.closestPointToPoint(p, true, _mC); return _mC.distanceTo(p);
        }
        // VR melee: weapon segment (grip->tip, plus tip sweep since last frame) vs entity triangles; fast swings only; 0.1 s cooldown
        const _mA = new THREE.Vector3(), _mB = new THREE.Vector3(), _mC = new THREE.Vector3(), _mE1 = new THREE.Vector3(), _mE2 = new THREE.Vector3(), _mP = new THREE.Vector3(), _mT = new THREE.Vector3(), _mQ = new THREE.Vector3(), _mD = new THREE.Vector3(), _mL = new THREE.Line3(), _mS = new THREE.Sphere();
        function segHitsTri(p0, p1, a, b, c) { // Moller-Trumbore, t restricted to the segment
            _mD.subVectors(p1, p0); _mE1.subVectors(b, a); _mE2.subVectors(c, a); _mP.crossVectors(_mD, _mE2); const det = _mE1.dot(_mP); if (Math.abs(det) < 1e-9) return false;
            const inv = 1 / det; _mT.subVectors(p0, a); const u = _mT.dot(_mP) * inv; if (u < 0 || u > 1) return false;
            _mQ.crossVectors(_mT, _mE1); const v = _mD.dot(_mQ) * inv; if (v < 0 || u + v > 1) return false; const t = _mE2.dot(_mQ) * inv; return t >= 0 && t <= 1;
        }
        function weaponHitsEntity(e, segs) {
            e.mesh.updateMatrixWorld(true); let hit = false;
            e.mesh.traverse(o => {
                if (hit || !o.isMesh || !o.geometry || !o.visible || !o.geometry.attributes.position) return; const g = o.geometry; if (!g.boundingSphere) g.computeBoundingSphere();
                _mS.copy(g.boundingSphere).applyMatrix4(o.matrixWorld); if (!segs.some(sg => { _mL.set(sg[0], sg[1]); _mL.closestPointToPoint(_mS.center, true, _mC); return _mC.distanceTo(_mS.center) <= _mS.radius; })) return;
                const pos = g.attributes.position, idx = g.index, n = idx ? idx.count : pos.count, w = o.matrixWorld;
                for (let i = 0; i + 2 < n && !hit; i += 3) {
                    _mA.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(w); _mB.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(w); _mC.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(w);
                    for (const sg of segs) if (segHitsTri(sg[0], sg[1], _mA, _mB, _mC)) { hit = true; break; }
                }
            });
            return hit;
        }
        function vrMelee(it, ctl, hs, gi, t, dt) { // axe / crowbar swing
            const axe = it.id === 'axe', tip = ctl.localToWorld(new THREE.Vector3(0, -0.03, axe ? -0.52 : -0.5)), base = ctl.localToWorld(new THREE.Vector3(0, -0.03, 0));
            const prev = hs.tp ? hs.tp : tip; const sp = tip.distanceTo(prev) / Math.max(dt, 0.008); hs.tp = tip.clone();
            if (sp < 2.2 || t < (hs.mcd || 0)) return; // too slow / cooldown
            const segs = [[base, tip], [prev, tip]]; const mid = base.clone().lerp(tip, 0.5);
            for (const e of GameState.entities) {
                if (e.stunTimer > 0 || !e.mesh || e.mesh.position.distanceTo(mid) > 4 + (e.meleeRadius || 0)) continue;
                if (weaponHitsEntity(e, segs) || (e.meleeRadius > 0 && segs.some(sg => segDistToPoint(sg, e.mesh.position) < e.meleeRadius))) {
                    hs.mcd = t + 100; vibI(gi, axe ? 0.8 : 0.6, 200); axeStunMonsters(axe ? 5 : 3, tip, 0, { sound: axe ? 'axe' : 'crowbar', only: e }); break;
                }
            }
            if (Attraction.B && Attraction.vrBoss(axe ? 'axe' : 'crowbar', segs)) { hs.mcd = t + 100; vibI(gi, 1, 220); }
            if (sp > 3.2 && LevelData[GameState.level].attraction && Attraction.vrWall(tip)) vibI(gi, 1, 220);
            if (sp > 3.2 && t > (VR.cb || 0)) { const c = crateAt(tip) || crateAt(ctl.localToWorld(new THREE.Vector3(0, -0.03, -0.3))); if (c) { VR.cb = t + 500; breakCrate(c); vibI(gi, 1, 220); } }
        }
        const ItemDefs = {
            water: { name: 'Almond Water', icon: '\u{1F4A7}', max: 3, desc: 'Drink to restore 40 sanity and 50 stamina.' },
            battery: { name: 'Battery', icon: '\u{1F50B}', max: 3, get desc() { return 'Restores ' + batteryRestore() + '% flashlight charge.'; } },
            shotgun: { name: 'Shotgun', icon: '\u{1F52B}', max: 1, get desc() { return PermaFx.has('blast') ? '3 shells. Stuns entities in front of you for 25s. Loud.' : 'One shell. Stuns entities in front of you for 20s. Loud.'; } },
            cake: { name: 'Party Cake', icon: '\u{1F370}', max: 1, desc: 'Restores a lost hit. At full hits it grants one extra hit of protection. Rare.',
                use(pl) { const max = DifficultyConfigs[GameState.difficulty].chances || 1; if (GameState.chancesRemaining >= max + 1) { showEventBanner('ALREADY SHIELDED', 1.5); return false; }
                    AudioSys.playCakeEat(); GameState.chancesRemaining++; const h = document.getElementById('lives-hud'); h.style.display = 'block'; h.innerText = `CHANCES REMAINING: ${GameState.chancesRemaining}`;
                    h.style.color = GameState.chancesRemaining > max ? '#ff8ad8' : '#66ff88'; showEventBanner(GameState.chancesRemaining > max ? 'CAKE: EXTRA HIT PROTECTION' : 'CAKE: HIT RESTORED', 2.2); } },
            lucid_pill: { name: 'Lucid Pill', icon: '\u{1F48A}', max: 2, desc: 'Sanity back to 100.', use(pl) { AudioSys.playSecretItem(); pl.sanity = PermaFx.maxSan(); showEventBanner('LUCID PILL: SANITY RESTORED', 1.8); } },
            battery_core: { name: 'Battery Core', icon: '\u{1F9EA}', max: 1, secret: true, desc: 'SECRET. Flashlight to 100%.', use(pl) { AudioSys.playSecretItem(); pl.battery = 100; showEventBanner('BATTERY CORE: FULL CHARGE', 1.8); } },
            sprint_tonic: { name: 'Sprint Tonic', icon: '\u{26A1}', max: 2, secret: true, desc: 'SECRET. Stamina to 100.', use(pl) { AudioSys.playDrink(); pl.stamina = 100; showEventBanner('SPRINT TONIC: STAMINA FULL', 1.8); } },
            clock: { name: 'Alarm Clock', icon: '\u{23F0}', max: 1, desc: 'Use to wind it (10s). LMB throws it. At zero it rings and every monster sprints to it.',
                use() { if (GameState.clk) { showEventBanner('ALREADY WOUND', 1.5); return false; } GameState.clk = { t: 10, thrown: false }; AudioSys.playClockWind(); showEventBanner('WOUND UP: 10s. LMB TO THROW IT. HOLDING IT IS A BAD IDEA.', 3.2); return false; } },
            tracker: { name: 'Monster Tracker', icon: '\u{1F4E1}', max: 1, desc: '2 uses. Pings every monster through walls for 20s. 35s cooldown.' },
            mega_battery: { name: 'Mega-Battery', icon: '\u{1F50C}', max: 1, desc: 'Fills the flashlight to 150%. While it lasts, a lunging hound only drains you to 50% and cannot flick your light off.',
                use(pl) { AudioSys.playBatterySfx(); pl.battery = 150; pl.mega = true; showEventBanner('MEGA-BATTERY: FLASHLIGHT 150%', 2.2); } },
            chest_locator: { name: 'Chest Locator', icon: '\u{1F9ED}', max: 1, desc: '3 uses. Marks the nearest chest with a glowing arrow you can see through walls. The arrow vanishes once you are within 30m of it, or when you leave the level.',
                use(pl, it) { if (!chestLocate(it)) return false; it.uses--; renderInv(); return it.uses <= 0 ? undefined : false; } },
            crowbar: { name: 'Crowbar', icon: '\u{1F527}', max: 1, desc: 'Breaks open crates. Hold it near one and USE or press E. In VR, swing it hard (or press Y).',
                use() { const p = controls.getObject().position; if (!window.__vrOn) { axeStunMonsters(3, p, 3.5, { sound: 'crowbar' }); Attraction.meleeBoss('crowbar'); } if (!breakNearestCrate(p, window.__vrOn ? 1.5 : 2.8) && !Attraction.meleeWall(p)) showEventBanner('NO CRATE IN REACH', 1.2); return false; } },
            axe: { name: 'Axe', icon: '\u{1FA93}', max: 1, desc: 'Heavy iron-and-wood axe. Easy to spot. In VR, physically swing it: smashes nearby crates and stuns monsters 5s.',
                use(pl) { const p = controls.getObject().position; if (!window.__vrOn) { axeStunMonsters(5, p, 3.5); Attraction.meleeBoss('axe'); } if (!breakNearestCrate(p, window.__vrOn ? 1.5 : 2.8)) Attraction.meleeWall(p); return false; } },
            grenade: { name: 'Grenade', icon: '\u{1F4A3}', max: 3, desc: 'Rare. LMB / G throws it (2.6s fuse, real physics, very loud). Within 3m: stuns 8s. Within 1m: stuns 4x as long. Within 0.5m: the monster is torn apart joint by joint and removed from the map.',
                use() { if (!GrenadeSys.throwIt()) return false; } },
            reality_shard: { name: 'Reality Shard', icon: '\u{1F52E}', max: 1, secret: true, desc: 'SECRET (code LMAO999). Sanity, stamina and flashlight back to full.',
                use(pl) { AudioSys.playSecretItem(); pl.sanity = PermaFx.maxSan(); pl.stamina = 100; pl.battery = Math.max(pl.battery, 100); showEventBanner('REALITY SHARD: EVERYTHING RESTORED', 2.2); } }
        };
        const Catalogue = [
            { id: 'water', qty: 1, price: 6 }, { id: 'water', qty: 2, price: 10 }, { id: 'battery', qty: 1, price: 3 },
            { id: 'battery', qty: 2, price: 5 }, { id: 'shotgun', qty: 1, price: 18 }, { id: 'tracker', qty: 1, price: 28 }
        ];
        function invAdd(inv, id, ammo) {
            if (MP.active && MP.me.ghost && inv === GameState.inv) return false; // spectators cannot obtain items
            const def = ItemDefs[id];
            let s = inv.findIndex(x => x && x.id === id && x.count < def.max);
            if (s >= 0) { inv[s].count++; return true; }
            s = inv.indexOf(null);
            if (s < 0) return false;
            inv[s] = { id, count: 1, uses: TOOL_MAX[id] || 2, active: 0, cd: 0, ammo: id === 'shotgun' ? (ammo == null ? PermaFx.ammoStart() : ammo) : 0 };
            return true;
        }
        function invRemoveOne(slot) {
            const it = GameState.inv[slot];
            if (it && --it.count <= 0) GameState.inv[slot] = null;
            syncInventory();
        }
        function resetInventory(debug = false) {
            GameState.inv = [null, null, null, null, null]; GameState.invSel = 0;
            GameState.trackerTimer = 60; GameState.trackerInWorld = false;
            if (debug) ['shotgun', 'tracker', 'water', 'battery'].forEach(id => invAdd(GameState.inv, id)); // test kit; saves untouched
            else { Save.pending.forEach(id => invAdd(GameState.inv, id)); Save.pending = []; Save.stock = null; sv('backrooms_pending', []); sv('backrooms_shop_stock', null); }
            syncInventory();
        }
        function selectSlot(n) { if (MP.active && MP.me.ghost) return; GameState.invSel = n; syncInventory(); }
        function syncInventory() {
            const sel = GameState.inv[GameState.invSel];
            GameState.hasShotgun = GameState.inv.some(x => x && x.id === 'shotgun');
            const holdingGun = !!(sel && sel.id === 'shotgun');
            shotgunViewGroup.visible = holdingGun; setHeldModel(sel && !holdingGun ? sel.id : null);
            document.getElementById('shotgun-hud').style.display = holdingGun ? 'block' : 'none';
            updateShotgunHud();
            renderInv();
        }
        function updateShotgunHud() {
            const slot = GameState.inv.findIndex(x => x && x.id === 'shotgun');
            if (slot < 0) return;
            const n = GameState.inv[slot].ammo || 0;
            document.getElementById('shotgun-hud').textContent = n > 0 ? `[LEFT CLICK / G] PUMP SHOTGUN READY (${n} SHELL${n > 1 ? 'S' : ''})` : '[LEFT CLICK / G] SHOTGUN EMPTY - FIND A SHELL';
            try { hudDraw(); } catch (e) {} // the VR wrist HUD reads this element's text; refresh it immediately on ammo changes
        }
        let lastInvKey = '';
        function renderInv() {
            let h = '';
            for (let i = 0; i < 5; i++) {
                const it = GameState.inv[i];
                h += `<div class="inv-slot${i === GameState.invSel ? ' sel' : ''}"><span class="k">${i + 1}</span>`;
                if (it) {
                    const d = ItemDefs[it.id];
                    let tx = '';
                    if (it.id === 'chest_locator') tx = `${it.uses} USES`; else if (it.id === 'tracker') tx = it.active > 0 ? `ACTIVE ${Math.ceil(it.active)}s` : (it.cd > 0 ? `CD ${Math.ceil(it.cd)}s` : `${it.uses} USES`);
                    h += `<span class="ic">${d.icon}</span><span class="tx">${tx || d.name}</span>${it.count > 1 ? `<span class="ct">x${it.count}</span>` : (it.id === 'tracker' || it.id === 'chest_locator' ? `<span class="ct">${it.uses}</span>` : '')}`;
                }
                h += '</div>';
            }
            h += `<div class="inv-coins">\u{1FA99} ${Save.coins}</div>`;
            document.getElementById('inv-hud').innerHTML = h;
        }
        function useSelected() {
            if (!GameState.isRunning || GameState.isPaused || (MP.active && MP.me.ghost)) return;
            const it = GameState.inv[GameState.invSel], pl = GameState.player;
            if (!it) return;
            if (ItemDefs[it.id] && ItemDefs[it.id].use) { if (ItemDefs[it.id].use(pl, it) !== false) invRemoveOne(GameState.invSel); return; }
            if (it.id === 'shotgun') return fireShotgun();
            if (it.id === 'water') {
                AudioSys.playDrink(); pl.sanity = Math.min(PermaFx.maxSan(), pl.sanity + 40); pl.stamina = Math.min(100, pl.stamina + 50);
                showEventBanner('ALMOND WATER: +SANITY +STAMINA', 1.8); invRemoveOne(GameState.invSel);
            } else if (it.id === 'battery') {
                const rb = batteryRestore();
                if (pl.battery >= 100 - Math.min(5, rb)) return showEventBanner('BATTERY ALREADY FULL', 1.5);
                AudioSys.playBatterySfx(); pl.battery = Math.max(pl.battery, Math.min(100, pl.battery + rb)); invRemoveOne(GameState.invSel);
                showEventBanner('BATTERY: +' + rb + '% FLASHLIGHT', 1.4);
            } else if (it.id === 'tracker') {
                if (it.active > 0) return;
                if (it.cd > 0) return showEventBanner(`TRACKER COOLING DOWN: ${Math.ceil(it.cd)}s`, 1.5);
                AudioSys.playClick(); it.uses--; it.active = 20; showEventBanner('TRACKER PING ACTIVE: 20s', 2); renderInv();
            }
        }
        function spawnPickup(type, x, z) {
            const mesh = buildItemModel(type); mesh.position.set(x, FLOOR_Y[type] || 0.5, z);
            mesh.userData = { type };
            scene.add(mesh);
            GameState.items.push({ mesh, type: 'item' });
        }
        // Rare tracker: 10% chance each 60s of gameplay time (frozen by pause), max one in the world / inventory.
        function inventoryTick(dt, p) {
            GameState.trackerTimer -= dt;
            if (GameState.trackerTimer <= 0) {
                GameState.trackerTimer += 60;
                if (!GameState.trackerInWorld && !GameState.inv.some(x => x && x.id === 'tracker') && Math.random() < 0.10) {
                    const cs = GameState.cellSize, size = GameState.gridSize, c = [];
                    for (let z = 2; z < size - 2; z++) for (let x = 2; x < size - 2; x++)
                        if (GameState.grid[z][x] === 0 && Math.hypot(x * cs - p.x, z * cs - p.z) > 12) c.push({ x: x * cs, z: z * cs });
                    if (c.length) { const s = c[Math.floor(Math.random() * c.length)]; spawnPickup('tracker', s.x, s.z); GameState.trackerInWorld = true; showEventBanner('SOMETHING USEFUL HAS APPEARED IN THE LEVEL...', 3); }
                }
            }
            { const _L = LevelData[GameState.level]; if (_L && _L.party && GameState.partygoers) { const tt = performance.now() * 0.001; GameState.partygoers.forEach(g => { g.mesh.position.y = Math.abs(Math.sin(tt * 3 + g.ph)) * 0.12; g.mesh.rotation.y += g.spin * dt; if (g.fake && !g.done) fakeTick(g, dt, p); }); GameState.partygoers = GameState.partygoers.filter(g => !g.done); } }
            updateBursts(dt); chestTick(dt); try { grenadeTick(dt); } catch (e) { console.warn('grenade', e); }
            GameState.shellTimer = (GameState.shellTimer == null ? 25 : GameState.shellTimer) - dt; // shells appear for an empty shotgun
            if (GameState.shellTimer <= 0) { GameState.shellTimer += 25; const _L2 = LevelData[GameState.level];
                if (!(_L2 && _L2.party) && GameState.inv.some(x => x && x.id === 'shotgun' && !x.ammo) && !GameState.items.some(i => i.mesh.userData.type === 'shell')) {
                    const cs = GameState.cellSize, size = GameState.gridSize, c = []; for (let z = 2; z < size - 2; z++) for (let x = 2; x < size - 2; x++) if (GameState.grid[z][x] === 0 && Math.hypot(x * cs - p.x, z * cs - p.z) > 12) c.push({ x: x * cs, z: z * cs });
                    if (c.length) { const s = c[Math.floor(Math.random() * c.length)]; spawnPickup('shell', s.x, s.z); showEventBanner('A SHOTGUN SHELL GLINTS SOMEWHERE...', 2.5); } } }
            GameState.cakeTimer = (GameState.cakeTimer == null ? 60 : GameState.cakeTimer) - dt; // rare cake: 6% each 60s, never stacked
            if (GameState.cakeTimer <= 0) {
                GameState.cakeTimer += 60;
                if (!GameState.inv.some(x => x && x.id === 'cake') && !GameState.items.some(i => i.mesh.userData.type === 'cake') && false) { // cakes now only spawn in the Party Room
                    const cs = GameState.cellSize, size = GameState.gridSize, c = [];
                    for (let z = 2; z < size - 2; z++) for (let x = 2; x < size - 2; x++) if (GameState.grid[z][x] === 0 && Math.hypot(x * cs - p.x, z * cs - p.z) > 12) c.push({ x: x * cs, z: z * cs });
                    if (c.length) { const s = c[Math.floor(Math.random() * c.length)]; spawnPickup('cake', s.x, s.z); showEventBanner('YOU SMELL SOMETHING SWEET', 2.5); }
                }
            }
            const slot = GameState.inv.findIndex(x => x && x.id === 'tracker');
            const tr = slot >= 0 ? GameState.inv[slot] : null;
            const on = !!(tr && tr.active > 0);
            if (tr) {
                if (tr.active > 0) { tr.active -= dt; if (tr.active <= 0) { tr.active = 0; tr.cd = 35; } }
                else if (tr.cd > 0) tr.cd = Math.max(0, tr.cd - dt);
                if (tr.uses <= 0 && tr.active <= 0 && tr.cd <= 0) { GameState.inv[slot] = null; syncInventory(); }
            }
            let nCh = 0, nInv = 0;
            GameState.entities.forEach(e => { if (e.stunTimer > 0) return; if (MP.active && e._tgtMe === false) return; if (isHunting(e)) nCh++; else if (e.state === 'investigate') nInv++; });
            { const _nm = Settings.nightmare; ChaseAudio.update(_nm ? 0 : (nCh >= 2 ? 3 : (nCh === 1 ? 2 : (nInv > 0 ? 1 : 0))), dt); Sfx.setLoop('chase_music', _nm ? false : (Attraction.musicOn() ? true : (GameState.bossDead ? false : holdChase(nCh >= 1, dt)))); } updateAmbience();
            { GameState.baseFov = GameState.baseFov || camera.fov; const ci = GameState.chaseI = (GameState.chaseI || 0) + ((((nCh >= 1 || Attraction.musicOn()) && !Settings.nightmare) ? 1 : 0) - (GameState.chaseI || 0)) * Math.min(1, dt * 3), beat = Math.sin(performance.now() * 0.001 * Math.PI * 2 * 2.8) * 0.5 + 0.5; // ~168 BPM
              const cp = document.getElementById('chase-pulse'); if (cp) cp.style.opacity = (ci * (0.3 + 0.55 * beat)).toFixed(3);
              if (scene.fog && GameState.baseFogD) scene.fog.density = GameState.baseFogD * (1 + 0.45 * ci * beat);
              camera.fov = GameState.baseFov + ci * (3 + 4 * beat); camera.updateProjectionMatrix(); extraTick(dt, p); }
            GameState.entities.forEach(e => {
                if (on && !e._trk) {
                    e._trk = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 8), new THREE.MeshBasicMaterial({ color: 0xff2a2a, depthTest: false, transparent: true, fog: false }));
                    e._trk.renderOrder = 999; e._trk.position.y = 3.2; e.mesh.add(e._trk);
                } else if (on) {
                    e._trk.scale.setScalar(1 + 0.35 * Math.sin(GameState.timeAlive * 8));
                } else if (e._trk) { e.mesh.remove(e._trk); e._trk.geometry.dispose(); e._trk.material.dispose(); e._trk = null; }
            });
            const key = tr ? `${tr.active > 0 ? Math.ceil(tr.active) : 0}|${Math.ceil(tr.cd)}|${tr.uses}` : '';
            if (key !== lastInvKey) { lastInvKey = key; renderInv(); }
        }

        // --- SHOP (stock persisted until a run starts, so reopening it cannot reroll) ---
        let shopTab = 'stock';
        function openShop() {
            shopTab = 'stock';
            if (!Save.stock) {
                const idx = Catalogue.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, 3);
                Save.stock = idx.map(i => ({ i, sold: false })); sv('backrooms_shop_stock', Save.stock);
            }
            AudioSys.init().then(() => AudioSys.playClick()).catch(() => {});
            renderShop(); document.getElementById('shop-screen').style.display = 'flex';
        }
        function fitsInInventory(ids) { const t = [null, null, null, null, null]; return ids.every(id => invAdd(t, id)); }
        function renderPermaTab() {
            const note = document.getElementById('shop-note');
            note.textContent = Save.permaOff ? 'Permanent upgrades are DISABLED in settings (main menu > SETTINGS). Owned ones will not apply.' : 'Permanent upgrades are bought once and last across every run.';
            note.className = 'shop-note' + (Save.permaOff ? ' warn' : '');
            document.getElementById('shop-cards').innerHTML = PermaDefs.map(d => {
                const owned = !!Save.perma[d.id], label = owned ? 'OWNED' : (Save.coins < PERMA_PRICE ? 'CAN\'T AFFORD' : 'BUY');
                return `<div class="shop-card${owned ? ' owned' : ''}"><div class="ic">${d.icon}</div><div class="nm">${d.name}</div><div class="ds">${d.desc}</div>${owned ? `<div class="st">${Save.permaOff ? 'DISABLED' : 'ACTIVE'}</div>` : `<div class="pr">\u{1FA99} ${PERMA_PRICE}</div>`}<button class="menu-btn" data-perma="${d.id}" ${label !== 'BUY' ? 'disabled' : ''} style="font-size:14px;padding:8px 14px;">${label}</button></div>`;
            }).join('');
        }
        function buyPerma(id) {
            const d = PermaDefs.find(x => x.id === id); if (!d || Save.perma[id] || Save.coins < PERMA_PRICE) return;
            const oldMax = PermaFx.maxSan();
            Save.coins -= PERMA_PRICE; Save.perma[id] = true; sv('backrooms_coins', Save.coins); sv('backrooms_perma', Save.perma);
            if (GameState.isRunning) { applyPermaNow(oldMax); renderInv(); }
            AudioSys.playPickup(); renderShop('"A wise investment. It is yours for good."');
        }
        function renderShop(quote) {
            document.getElementById('shop-coins').innerText = Save.coins;
            document.getElementById('shop-quote').innerText = quote || '"Coins keep. Everything else here does not." - the shopkeeper';
            if (shopTab === 'perma') return renderPermaTab();
            document.getElementById('shop-note').textContent = ''; document.getElementById('shop-note').className = 'shop-note';
            document.getElementById('shop-cards').innerHTML = Save.stock.map((s, n) => {
                const c = Catalogue[s.i], d = ItemDefs[c.id], blocked = c.id === 'shotgun' && GameState.difficulty === 'impossible';
                const label = s.sold ? 'SOLD' : (blocked ? 'NOT ON IMPOSSIBLE' : (Save.coins < c.price ? 'CAN\'T AFFORD' : 'BUY'));
                return `<div class="shop-card"><div class="ic">${d.icon}</div><div class="nm">${d.name}${c.qty > 1 ? ' x' + c.qty : ''}</div><div class="ds">${d.desc}</div><div class="pr">\u{1FA99} ${c.price}</div><button class="menu-btn" data-buy="${n}" ${label !== 'BUY' ? 'disabled' : ''} style="font-size:14px;padding:8px 14px;">${label}</button></div>`;
            }).join('');
        }
        document.getElementById('shop-cards').addEventListener('click', e => {
            const pb = e.target.closest('[data-perma]'); if (pb) return buyPerma(pb.dataset.perma);
            const b = e.target.closest('[data-buy]'); if (!b) return;
            const s = Save.stock[+b.dataset.buy], c = Catalogue[s.i];
            if (s.sold || Save.coins < c.price) return;
            const live = !!GameState.inShop, add = Array(c.qty).fill(c.id), ids = live ? add : Save.pending.concat(add);
            const fits = live ? (() => { const t = GameState.inv.map(x => x ? Object.assign({}, x) : null); return add.every(id => invAdd(t, id)); })() : fitsInInventory(ids);
            if (!fits) return renderShop('"Your hands are full." (inventory would overflow)');
            Save.coins -= c.price; s.sold = true; // deduct only after success
            if (live) { add.forEach(id => invAdd(GameState.inv, id)); syncInventory(); } else { Save.pending = ids; sv('backrooms_pending', Save.pending); }
            sv('backrooms_coins', Save.coins); sv('backrooms_shop_stock', Save.stock);
            AudioSys.playPickup(); renderShop('"Pleasure doing business."');
        });
        document.querySelectorAll('.shop-tab').forEach(b => b.addEventListener('click', () => { shopTab = b.dataset.tab; AudioSys.playClick(); renderShop(); }));
        { const cb = document.getElementById('perma-off'); cb.checked = !!Save.permaOff; cb.addEventListener('change', e => { Save.permaOff = e.target.checked; sv('backrooms_perma_off', Save.permaOff); }); }
        document.getElementById('shop-back-btn').addEventListener('click', () => { AudioSys.playClick(); document.getElementById('shop-screen').style.display = 'none'; if (GameState.shopOpen) { GameState.shopOpen = false; try { controls.lock(); } catch (e) {} } });
        document.getElementById('shop-go-btn').addEventListener('click', () => { document.getElementById('shop-screen').style.display = 'none'; startGame(); });

        // --- ACHIEVEMENTS ---
        const ENTITY_NAMES = { bacteria: 'Bacteria', skinstealer: 'Skin-Stealer', smiler: 'Smiler', hound: 'Hound', window_watcher: 'Window Watcher' };
        const AchRegistry = [
            ...LevelData.filter(l => !l.party && !l.hidden).map(l => ({ id: 'lvl_' + l.name, name: 'Cleared: ' + l.name, desc: 'Reach the exit of ' + l.name + '.' })),
            ...Object.keys(ENTITY_NAMES).map(t => ({ id: 'die_' + t, name: 'Fed the ' + ENTITY_NAMES[t], desc: 'Die to a ' + ENTITY_NAMES[t] + '.' })),
            { id: 'stun_all', name: 'Shell Shocked', desc: 'Stun every entity type with the shotgun.' },
            { id: 'debug', name: 'Behind the Curtain', desc: 'Discover the secret room.' },
            { id: 'impossible', name: 'Beyond the Threshold', desc: 'Escape the Backrooms on Impossible difficulty.' }
        ];
        function unlockAch(id) {
            if ((GameState.debugRoom && id !== 'debug') || Save.ach[id]) return; // no duplicates, none from debug loads
            const a = AchRegistry.find(x => x.id === id); if (!a) return;
            Save.ach[id] = new Date().toISOString().split('T')[0]; sv('backrooms_achievements', Save.ach);
            if (GameState.isRunning) showEventBanner('ACHIEVEMENT UNLOCKED: ' + a.name, 3.5);
        }
        function recordStun(type) {
            if (GameState.debugRoom) return;
            if (!Save.stunned.includes(type)) { Save.stunned.push(type); sv('backrooms_stunned', Save.stunned); }
            if (Object.keys(ENTITY_NAMES).every(t => Save.stunned.includes(t))) unlockAch('stun_all');
        }
        function importLegacyAch() { // keep the original Impossible clear
            if (localStorage.getItem('backrooms_impossible_beaten') === 'true' && !Save.ach.impossible) {
                Save.ach.impossible = localStorage.getItem('backrooms_impossible_date') || new Date().toISOString().split('T')[0]; sv('backrooms_achievements', Save.ach);
            }
        }
        document.getElementById('ach-btn').addEventListener('click', () => {
            AudioSys.init().then(() => AudioSys.playClick()).catch(() => {});
            const got = AchRegistry.filter(a => Save.ach[a.id]).length;
            document.getElementById('ach-list').innerHTML = `<div style="color:#aaa;margin-bottom:8px">${got} / ${AchRegistry.length} unlocked</div>` +
                AchRegistry.map(a => `<div class="ach-row ${Save.ach[a.id] ? 'got' : ''}"><span class="mk">${Save.ach[a.id] ? '\u2605' : '\u2610'}</span><div><strong>${a.name}</strong><small>${a.desc}</small><small>${Save.ach[a.id] ? 'Unlocked ' + Save.ach[a.id] : 'Locked'}</small></div></div>`).join('');
            document.getElementById('ach-modal').style.display = 'flex';
        });
        document.getElementById('ach-close-btn').addEventListener('click', () => document.getElementById('ach-modal').style.display = 'none');

        // ===== SOUND REGISTRY / LOADER / FALLBACK =====
        // Files are looked up under Sfx.base (default "sounds/"). Any asset that fails to download, decode or start playing keeps its procedural sound.
        Object.assign(AudioSys, {
            _t(f, d, type = 'sine', v = 0.2, to = null, delay = 0) { const c = this.ctx; if (!c || !this.masterGain) return; const t = c.currentTime + delay, o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.setValueAtTime(f, t); if (to) o.frequency.exponentialRampToValueAtTime(to, t + d); g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + d); o.connect(g); g.connect(this.masterGain); o.start(t); o.stop(t + d + 0.02); },
            playCoin() { this._t(1318, 0.08, 'square', 0.1); this._t(1760, 0.2, 'square', 0.1, null, 0.07); },
            playReload() { this._t(180, 0.06, 'square', 0.18); this._t(120, 0.08, 'square', 0.18, null, 0.25); this._t(240, 0.05, 'square', 0.18, null, 0.5); this._t(90, 0.12, 'sawtooth', 0.2, null, 0.7); },
            playDrink() { for (let i = 0; i < 3; i++) this._t(300 + i * 40, 0.12, 'sine', 0.15, 520, i * 0.16); },
            playBatterySfx() { this._t(400, 0.05, 'square', 0.12); this._t(800, 0.1, 'square', 0.12, null, 0.06); },
            playMonsterSpot() { this._t(760, 0.55, 'sawtooth', 0.16, 140); },
            playCakeEat() { [520, 660, 880].forEach((f, i) => this._t(f, 0.12, 'triangle', 0.18, null, i * 0.1)); },
            playLevelClear() { [523, 659, 784, 1046].forEach((f, i) => this._t(f, 0.22, 'triangle', 0.16, null, i * 0.12)); },
            playShellPickup() { this._t(2200, 0.05, 'square', 0.1); this._t(1500, 0.08, 'square', 0.1, null, 0.06); this._t(140, 0.12, 'sawtooth', 0.16, null, 0.2); },
            playAmmoPickup() { this.playShellPickup(); this._t(100, 0.2, 'square', 0.15, null, 0.35); },
            playEmptyClick() { this._t(1800, 0.03, 'square', 0.12); },
            playDrop() { this._t(200, 0.08, 'triangle', 0.15, 90); },
            playClockWind() { for (let i = 0; i < 6; i++) this._t(900 + i * 30, 0.03, 'square', 0.08, null, i * 0.07); },
            playAlarm() { this._t(1400, 0.12, 'square', 0.18); this._t(1400, 0.12, 'square', 0.18, null, 0.18); },
            playTableThrow() { this._t(400, 0.4, 'sawtooth', 0.12, 80); },
            playTableSmash() { this._t(120, 0.35, 'sawtooth', 0.3, 40); this._t(300, 0.2, 'square', 0.2, 60, 0.04); },
            playAxeSwing() { this._t(250, 0.5, 'square', 0.3, 80); this._t(900, 0.4, 'sawtooth', 0.22, 42); },
            playCrowbarSwing() { this._t(130, 0.35, 'sawtooth', 0.22, 90); this._t(450, 0.45, 'triangle', 0.42, 150, 0.01); },
            playSecretItem() { this._t(300, 0.4, 'sine', 0.15, 1200); }
        });
        const SFX_REG = {
            coin: { m: 'playCoin', f: 'coin.ogg', v: 0.7, a: [] }, reload: { m: 'playReload', f: 'reload.ogg', v: 0.9, a: [] },
            drink: { m: 'playDrink', f: 'drink.ogg', v: 0.8, a: [] }, battery_use: { m: 'playBatterySfx', f: 'battery_use.ogg', v: 0.8, a: [] },
            monster_spot: { m: 'playMonsterSpot', f: 'monster_spot.ogg', v: 0.9, a: [] }, cake_eat: { m: 'playCakeEat', f: 'cake_eat.ogg', v: 0.9, a: [] },
            level_clear: { m: 'playLevelClear', f: 'level_clear.ogg', v: 0.9, a: [] }, secret_item: { m: 'playSecretItem', f: 'secret_item.ogg', v: 0.9, a: [] },
            shell_pickup: { m: 'playShellPickup', f: 'shell_pickup.ogg', v: 0.9, a: [] }, ammo_pickup: { m: 'playAmmoPickup', f: 'ammo_pickup.ogg', v: 0.9, a: [] },
            shotgun_empty: { m: 'playEmptyClick', f: 'shotgun_empty.ogg', v: 0.8, a: [] }, drop: { m: 'playDrop', f: 'drop.ogg', v: 0.7, a: [] },
            ...Object.fromEntries(['carpet', 'concrete', 'hotel', 'party'].map(k => ['step_' + k, { aux: true, f: 'step_' + k + '.ogg', v: 0.5, a: [] }])),
            ...Object.fromEntries(['lobby', 'habitable', 'pipes', 'electrical', 'office', 'hotel', 'dark', 'party'].map(k => ['ambience_' + k, { aux: true, loop: true, f: 'ambience_' + k + '.ogg', v: 0.5, a: [] }])),
            drip: { m: 'playDrip', f: 'drip.ogg', v: 0.55, a: [] },
            ui_hover: { m: 'playHover', f: 'ui_hover.ogg', v: 0.5, a: [] }, chest_open: { m: 'playChest', f: 'chest_open.ogg', v: 0.8, a: [] }, crate_break: { m: 'playCrateBreak', f: 'crate_break.ogg', v: 0.9, a: [] }, fake_burst: { m: 'playFakeBurst', f: 'fake_burst.ogg', v: 1, a: [] }, leviathan: { m: 'playLeviathan', f: 'leviathan.ogg', v: 0.9, a: [] },
            hum: { loop: true, f: 'hum.ogg', v: 0.5, a: [] }, shop_radio: { loop: true, f: 'shop_radio.ogg', v: 0.5, a: [] }, vhs_hiss: { loop: true, f: 'vhs_hiss.ogg', v: 0.05, a: [] }, vhs_glitch: { aux: true, f: 'vhs_glitch.ogg', v: 0.5, a: [] },
            clock_wind: { m: 'playClockWind', f: 'clock_wind.ogg', v: 0.8, a: [] }, alarm_clock: { m: 'playAlarm', f: 'alarm_clock.ogg', v: 1, a: [] },
            table_throw: { m: 'playTableThrow', f: 'table_throw.ogg', v: 0.9, a: [] }, table_smash: { m: 'playTableSmash', f: 'table_smash.ogg', v: 1, a: [] },
            chase_music: { loop: true, f: 'chase_music.ogg', v: 0.7, a: [] }, ambience: { loop: true, f: 'ambience.ogg', v: 0.5, a: [] },
            click: { m: 'playClick', f: 'click.ogg', v: 0.6, a: [] }, pickup: { m: 'playPickup', f: 'pickup.ogg', v: 0.8, a: [] },
            ping: { m: 'playPing', f: 'ping.ogg', v: 0.8, a: [] }, shotgun: { m: 'playShotgun', f: 'shotgun.ogg', v: 1, a: [] },
            second_chance: { m: 'playSecondChanceHit', f: 'second_chance.ogg', v: 0.9, a: [] },
            spark: { m: 'playSpark', f: 'spark.ogg', v: 0.8, a: [4], vol: d => Math.max(0.1, 1 - (d || 0) / 30) },
            jumpscare: { m: 'playJumpscare', f: 'jumpscare.ogg', v: 1, a: [] }, stinger: { m: 'playChaseStinger', f: 'chase_stinger.ogg', v: 0.9, a: [] },
            step: { m: 'playStep', f: 'step.ogg', v: 0.5, a: [] }, heartbeat: { m: 'playHeartbeat', f: 'heartbeat.ogg', v: 1, a: [0.6], vol: i => Math.min(1.2, (i || 0.5) * 2) },
            ...Object.fromEntries(['bacteria', 'skinstealer', 'smiler', 'hound', 'window_watcher'].map(t => ['monster_' + t, { m: 'playMonsterSound', mt: t, f: 'monster_' + t + '.ogg', v: 0.9, a: [t, 6] }]))
        };
        function idbOpen() { return new Promise((res, rej) => { const r = indexedDB.open('backrooms_sfx', 1); r.onupgradeneeded = () => r.result.createObjectStore('a'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
        async function idbGet(k) { const db = await idbOpen(); return new Promise((res, rej) => { const q = db.transaction('a').objectStore('a').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); }
        async function idbPut(k, v) { const db = await idbOpen(); return new Promise((res, rej) => { const t = db.transaction('a', 'readwrite'); t.objectStore('a').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
        async function idbDel(k) { const db = await idbOpen(); return new Promise((res, rej) => { const t = db.transaction('a', 'readwrite'); t.objectStore('a').delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
        const SFX_LABEL = { chest_open: 'Chest lid creaks open', crate_break: 'Crate breaks open', ui_hover: 'UI button hover', hum: 'Constant fluorescent tone (menu + game)', shop_radio: 'Shop radio tune (loop)', vhs_hiss: 'VHS tape hiss (loop)', vhs_glitch: 'VHS tracking glitch', fake_burst: 'Fake partygoer bursts', leviathan: 'Leviathan passes (Thalassophobia)', drip: 'Poolrooms water drip', coin: 'Coin pickup', reload: 'Shotgun reload / pump', drink: 'Drinking almond water', battery_use: 'Battery swap', monster_spot: 'Monster spots you', cake_eat: 'Eating cake', level_clear: 'Level cleared', secret_item: 'Secret item', chase_music: 'Chase music (loops)', ambience: 'Background ambience (loops)', click: 'Menu / UI click', pickup: 'Item pickup', ping: 'Tracker ping', shotgun: 'Shotgun blast', second_chance: 'Second-chance hit', spark: 'Electric spark', jumpscare: 'Jumpscare', stinger: 'Chase stinger', step: 'Footstep', heartbeat: 'Heartbeat', monster_bacteria: 'Bacteria call', monster_skinstealer: 'Skin-stealer call', monster_smiler: 'Smiler call', monster_hound: 'Hound call', monster_window_watcher: 'Window watcher call' };
        const Sfx = { base: 'sounds/', buf: {}, st: {}, orig: {}, ready: false, loading: null, cur: null,
            play(id, vol = 1, rate = 1) {
                const c = AudioSys.ctx, b = this.buf[id]; if (!c || !b) return null;
                const s = c.createBufferSource(), g = c.createGain(); s.buffer = b; s.playbackRate.value = rate; g.gain.value = vol;
                s.connect(g); g.connect(Sfx.busFor(id)); s.start(); return s;
            },
            verify(id) { // silent real playback through the audio graph; resolves true if the source started and ended
                return new Promise(res => {
                    const c = AudioSys.ctx, b = this.buf[id], s = c.createBufferSource(), g = c.createGain(); g.gain.value = 0;
                    s.buffer = b; s.connect(g); g.connect(c.destination); s.onended = () => res(true); s.start(0, 0, Math.min(0.05, b.duration));
                    setTimeout(() => res(false), 1500);
                });
            },
            async ingest(id, ab) { // size check -> decode -> silent playback check; used by fetch, cache and file-picker paths
                const c = AudioSys.ctx, s = this.st[id] || (this.st[id] = { dl: '-', dec: '-', play: '-', src: 'PROCEDURAL', err: '' });
                try {
                    if (ab.byteLength < 500) throw new Error('file too small / invalid'); s.dl = 'OK';
                    try { this.buf[id] = await c.decodeAudioData(ab.slice(0)); s.dec = 'OK'; } catch (e) { s.dec = 'FAIL'; throw new Error('decode failed'); }
                    s.play = (await this.verify(id)) ? 'OK' : 'FAIL';
                    if (s.play !== 'OK') { delete this.buf[id]; throw new Error('playback did not complete'); }
                    s.src = 'FILE'; s.err = ''; return true;
                } catch (e) { s.err = e.message; return false; }
            },
            async load() {
                const c = AudioSys.ctx; try { await c.resume(); } catch (e) {}
                const isFile = location.protocol === 'file:'; // browsers block fetch() of local files, so don't even try
                await Promise.all(Object.entries(SFX_REG).map(async ([id, d]) => {
                    if (ASSETS.dec[id]) { ASSETS.adopt(id, ASSETS.dec[id]); return; } // already fetched + decoded in the background
                    const s = this.st[id] = { dl: '-', dec: '-', play: '-', src: 'PROCEDURAL', err: '' };
                    let ab = null, fromCache = false, embedded = false;
                    if (typeof AUDIO[id] === 'string' && AUDIO[id].trim()) { ab = audioFromDataUri(AUDIO[id].trim()); embedded = !!ab; if (!ab) { s.dl = 'FAIL'; s.err = 'AUDIO entry is not a valid data URI'; } } // embedded blob wins over everything else
                    if (!ab) { try { ab = await idbGet(id); fromCache = !!ab; } catch (e) {} } // files mapped in an earlier session
                    let fetched = false;
                    if (!ab && !isFile) { try { const r = await fetch(this.base + d.f); if (!r.ok) throw new Error('HTTP ' + r.status); ab = await r.arrayBuffer(); fetched = true; } catch (e) { s.dl = 'FAIL'; s.err = e.message; } }
                    if (!ab) { try { ab = await idbGet('dl:' + id); if (ab) s.err = 'using cached copy'; } catch (e) {} } // offline / blocked: reuse last downloaded copy
                    if (!ab) { if (isFile) { s.dl = 'SKIPPED'; s.err = 'opened from file:// - use LOAD SOUND FILES'; } return; }
                    if (await this.ingest(id, ab)) { // origin: DOWNLOAD = came from the sounds folder (locked), MAPPED = user-mapped (editable)
                        s.origin = fromCache ? 'MAPPED' : 'DOWNLOAD'; if (embedded) s.name = 'embedded (AUDIO table)'; if (fetched) idbPut('dl:' + id, ab).catch(() => {});
                        if (fromCache) { try { s.name = (await idbGet('name:' + id)) || 'saved file'; } catch (e) { s.name = 'saved file'; } }
                    }
                }));
                this.ready = true;
            },
            isLocked(id) { return !!(this.st[id] && this.st[id].origin === 'DOWNLOAD'); },
            async mapFile(id, file) { // map one sound to one user-chosen file; on failure the previous mapping is restored
                if (this.isLocked(id)) return { ok: false, err: 'sound was downloaded and is locked' };
                const prevBuf = this.buf[id], prevSt = this.st[id] ? { ...this.st[id] } : null;
                let ab; try { ab = await file.arrayBuffer(); } catch (e) { return { ok: false, err: 'could not read file' }; }
                if (await this.ingest(id, ab)) {
                    const s = this.st[id]; s.origin = 'MAPPED'; s.name = file.name;
                    idbPut(id, ab).catch(() => {}); idbPut('name:' + id, file.name).catch(() => {});
                    return { ok: true };
                }
                const err = this.st[id].err || 'invalid audio';
                if (prevBuf) this.buf[id] = prevBuf; else delete this.buf[id];
                this.st[id] = prevSt || { dl: '-', dec: '-', play: '-', src: 'PROCEDURAL', err: '' };
                return { ok: false, err };
            },
            async unmap(id) { // back to the procedural sound
                if (this.isLocked(id)) return;
                delete this.buf[id]; this.st[id] = { dl: '-', dec: '-', play: '-', src: 'PROCEDURAL', err: '' };
                idbDel(id).catch(() => {}); idbDel('name:' + id).catch(() => {});
            },
            async pick(files) { // quick auto-match by file name (any extension); only touches sounds that are not locked
                const byName = {}; Object.entries(SFX_REG).forEach(([id, d]) => byName[d.f.replace(/\.[^.]+$/, '').toLowerCase()] = id);
                let n = 0;
                for (const f of files) {
                    const id = byName[f.name.replace(/\.[^.]+$/, '').toLowerCase()]; if (!id || this.isLocked(id)) continue;
                    if ((await this.mapFile(id, f)).ok) n++;
                }
                return n;
            },
            setLoop(id, on) { // looping tracks (chase music / ambience); only plays when a file is mapped
                this.loops = this.loops || {}; const cur = this.loops[id];
                if (on && !cur && this.buf[id] && AudioSys.ctx) { const c = AudioSys.ctx, s = c.createBufferSource(), g = c.createGain(); s.buffer = this.buf[id]; s.loop = true; g.gain.value = SFX_REG[id].v; s.connect(g); g.connect(Sfx.busFor(id)); s.start(); this.loops[id] = s; }
                else if (!on && cur) { try { cur.stop(); } catch (e) {} delete this.loops[id]; }
            },
            preview(id) {
                return new Promise(res => {
                    const s = this.play(id, 1, 1); this.cur = s;
                    if (s) { s.onended = () => res(); return; }
                    const d = SFX_REG[id]; this.orig[id](...d.a); setTimeout(res, 1100);
                });
            }
        };
        for (const [id, d] of Object.entries(SFX_REG)) { // wrap existing methods: same interfaces, file first, procedural fallback
            if (d.loop || d.aux) { Sfx.orig[id] = () => {}; continue; }
            if (d.mt) continue;
            const orig = AudioSys[d.m].bind(AudioSys); Sfx.orig[id] = orig;
            AudioSys[d.m] = (...a) => { if (Sfx.buf[id] && AudioSys.ctx) { AudioSys.ensureReady(); Sfx.play(id, d.v * (d.vol ? d.vol(a[0]) : 1), 0.96 + Math.random() * 0.08); } else orig(...a); };
        }
        { const orig = AudioSys.playMonsterSound.bind(AudioSys);
          for (const [id, d] of Object.entries(SFX_REG)) if (d.mt) Sfx.orig[id] = (t, dist) => orig(t, dist);
          AudioSys.playMonsterSound = (t, dist) => { const id = 'monster_' + t; if (Sfx.buf[id] && AudioSys.ctx) { AudioSys.ensureReady(); Sfx.play(id, SFX_REG[id].v * Math.max(0.1, 1 - dist / 30), 0.95 + Math.random() * 0.1); } else orig(t, dist); }; }
        { const origInit = AudioSys.init.bind(AudioSys);
          AudioSys.init = async () => { await origInit(); if (AudioSys.ctx && !AudioSys.outGain) buildBuses(); if (AudioSys.ctx && !Sfx.loading) Sfx.loading = Sfx.load(); }; }
        const stepKind = () => { const f = (LevelData[GameState.level] || {}).floorTex || ''; return f === 'party_floor' ? 'party' : f === 'hotel_carpet' ? 'hotel' : /carpet/.test(f) ? 'carpet' : 'concrete'; };
        { const w = AudioSys.playStep; AudioSys.playStep = (...a) => { const id = 'step_' + stepKind(); if (Sfx.buf[id] && AudioSys.ctx) { AudioSys.ensureReady(); Sfx.play(id, SFX_REG[id].v, 0.95 + Math.random() * 0.1); } else w(...a); }; }
        const AMB_IDS = ['ambience', ...['lobby', 'habitable', 'pipes', 'electrical', 'office', 'hotel', 'dark', 'party'].map(k => 'ambience_' + k)];
        function ambTheme() { const L = LevelData[GameState.level] || {}, n = L.name || ''; return L.pools ? 'pools' : L.party ? 'party' : /Habitable/.test(n) ? 'habitable' : /Pipe/.test(n) ? 'pipes' : /Electrical/.test(n) ? 'electrical' : /Office/.test(n) ? 'office' : /Hotel/.test(n) ? 'hotel' : /Lights Out/.test(n) ? 'dark' : 'lobby'; }
        function updateAmbience() { const th = ambTheme(), hg = AudioSys.humGain; if (hg && AudioSys.ctx) hg.gain.setTargetAtTime((th === 'pools' || Sfx.buf.hum) ? 0 : 0.06, AudioSys.ctx.currentTime, 0.4); if (th === 'pools') { AMB_IDS.forEach(i => Sfx.setLoop(i, false)); return; } const want = Sfx.buf['ambience_' + ambTheme()] ? 'ambience_' + ambTheme() : 'ambience'; AMB_IDS.forEach(i => Sfx.setLoop(i, i === want)); }
        function stopAmbience() { AMB_IDS.forEach(i => Sfx.setLoop(i, false)); GameState.chaseI = 0; const cp = document.getElementById('chase-pulse'); if (cp) cp.style.opacity = 0; if (GameState.baseFov && camera.fov !== GameState.baseFov) { camera.fov = GameState.baseFov; camera.rotation.z = 0; camera.updateProjectionMatrix(); } }
        ['pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, () => AudioSys.init().catch(() => {}), { once: true }));

        // Adaptive chase layers: 0 explore (silent), 1 investigating, 2 chased, 3 multiple chasers. Procedural drone + tremolo, quiet enough to sit under ambience.
        const ChaseAudio = { lv: 0, n: null, down: 0,
            build() {
                const c = AudioSys.ctx; if (!c || this.n) return;
                const out = c.createGain(); out.gain.value = 0; out.connect(AudioSys.musicBus || AudioSys.masterGain);
                const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 200;
                const trem = c.createGain(); trem.gain.value = 1; lp.connect(trem); trem.connect(out);
                const o1 = c.createOscillator(), o2 = c.createOscillator(), hi = c.createOscillator(), lfo = c.createOscillator();
                o1.type = o2.type = 'sawtooth'; o1.frequency.value = 46; o2.frequency.value = 69.3; o2.detune.value = 14; o1.connect(lp); o2.connect(lp);
                const lg = c.createGain(); lg.gain.value = 0; lfo.frequency.value = 1.5; lfo.connect(lg); lg.connect(trem.gain);
                hi.type = 'triangle'; hi.frequency.value = 392; const hg = c.createGain(); hg.gain.value = 0; hi.connect(hg); hg.connect(out);
                [o1, o2, hi, lfo].forEach(o => o.start()); this.n = { out, lp, lfo, lg, hg };
            },
            set(lv) {
                if (lv === this.lv || !AudioSys.ctx) return; this.build();
                const n = this.n, t = AudioSys.ctx.currentTime, P = [[0, 200, 1.5, 0, 0], [0.05, 260, 1.2, 0, 0], [0.11, 520, 2.4, 0.35, 0.012], [0.16, 900, 3.6, 0.6, 0.02]][lv];
                n.out.gain.setTargetAtTime(P[0], t, 0.5); n.lp.frequency.setTargetAtTime(P[1], t, 0.5); n.lfo.frequency.setTargetAtTime(P[2], t, 0.5);
                n.lg.gain.setTargetAtTime(P[3], t, 0.5); n.hg.gain.setTargetAtTime(P[4], t, 0.5); this.lv = lv;
            },
            update(want, dt) { // rise instantly, fall only after 2.5s of calm (prevents flapping)
                if (want >= this.lv) { this.down = 0; this.set(want); } else { this.down += dt; if (this.down > 2.5) { this.down = 0; this.set(want); } }
            }
        };

        // ===== SFX TEST PANEL =====
        let sfxBusy = false;
        async function runSfxTest() {
            if (sfxBusy) return; sfxBusy = true;
            const log = document.getElementById('sfx-log'), prog = document.getElementById('sfx-prog'); log.textContent = '';
            try {
                await AudioSys.init(); if (AudioSys.ctx.state !== 'running') await AudioSys.ctx.resume();
                prog.textContent = 'Waiting for downloads/decoding...'; await Sfx.loading;
                const ids = Object.keys(SFX_REG); let files = 0;
                for (let i = 0; i < ids.length; i++) {
                    const id = ids[i], s = Sfx.st[id];
                    prog.textContent = `Testing ${i + 1} / ${ids.length}: ${id}`;
                    log.textContent += `${id.padEnd(22)} download:${s.dl} decode:${s.dec} verify:${s.play} => ${s.src}${s.err ? '  (' + s.err + ')' : ''}\n`;
                    log.scrollTop = log.scrollHeight; if (s.src === 'FILE') files++;
                    await Sfx.preview(id);
                }
                prog.textContent = `Done. ${files} file(s), ${ids.length - files} procedural fallback(s). Playback start is verified in the browser; it cannot prove your speakers are audible.`;
            } catch (e) { prog.textContent = 'Audio unavailable: ' + e.message; }
            sfxBusy = false;
        }
        function openSfxPanel() { document.getElementById('sfx-panel').style.display = 'flex'; runSfxTest(); }
        function closeSfxPanel() { document.getElementById('sfx-panel').style.display = 'none'; if (GameState.isPaused && AudioSys.ctx && AudioSys.ctx.state === 'running') AudioSys.ctx.suspend().catch(() => {}); }
        document.getElementById('pause-sfx-btn').addEventListener('click', openSfxPanel);
        document.getElementById('sfx-run').addEventListener('click', runSfxTest);
        document.getElementById('sfx-close').addEventListener('click', closeSfxPanel);

        // ===== MAIN MENU 3D MONSTER (real Entity model, rendered ~25fps only while the menu is visible) =====
        const menuScene = new THREE.Scene(); menuScene.background = new THREE.Color(0x010101);
        const menuCam = new THREE.PerspectiveCamera(32, 1, 0.1, 50); menuCam.position.set(0, 1.5, 7.5);
        let _gt = null; const glowTex = () => _gt || (_gt = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,.5)'); g.addColorStop(1, 'rgba(255,255,255,0)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })());
        const eyeSpr = (col, x, y, z, s) => { const m = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex(), color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false })); m.position.set(x, y, z); m.scale.setScalar(s); m.userData.s = s; return m; };
        function enhanceEntity(e) {
            const m = e.mesh, bb = new THREE.Box3().setFromObject(m), top = bb.max.y - m.position.y, fz = Math.max(0.25, bb.max.z - m.position.z), hw = Math.max(0.3, (bb.max.x - bb.min.x) / 2); e._fx = [];
            const eyes = (col, y, z, sep, s) => [-sep, sep].forEach(x => { const sp = eyeSpr(col, x, y, z, s); m.add(sp); e._fx.push({ k: 'eye', o: sp }); });
            if (e.type === 'bacteria') {
                eyes(0xff2020, top * 0.9, fz * 0.9, 0.1, 0.34); const tm = new THREE.MeshStandardMaterial({ color: 0x1a0505, roughness: 0.8, emissive: 0x330000 });
                for (let i = 0; i < 8; i++) { const g = new THREE.CylinderGeometry(0.015, 0.045, 0.95, 5); g.translate(0, -0.47, 0); const t = new THREE.Mesh(g, tm); t.position.set((Math.random() - 0.5) * hw * 1.6, top * 0.62, (Math.random() - 0.5) * 0.4); m.add(t); e._fx.push({ k: 'sway', o: t, p: i }); }
            } else if (e.type === 'skinstealer') {
                eyes(0xffffff, top * 0.92, fz * 0.9, 0.09, 0.26); const cm = new THREE.MeshStandardMaterial({ color: 0xcfc8b0, roughness: 0.6 });
                for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) { const g = new THREE.ConeGeometry(0.022, 0.55, 5); g.rotateX(Math.PI); g.translate(0, -0.28, 0); const c = new THREE.Mesh(g, cm); c.position.set(sx * hw * 0.95, top * 0.45, (i - 1.5) * 0.07); m.add(c); e._fx.push({ k: 'sway', o: c, p: i + sx }); }
            } else if (e.type === 'hound') {
                eyes(0xffaa00, top - 0.14, fz * 0.97, 0.13, 0.3); const sm = new THREE.MeshStandardMaterial({ color: 0x120c0a, roughness: 0.7 });
                for (let i = 0; i < 8; i++) { const c = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.28 - Math.abs(i - 3.5) * 0.02, 5), sm); c.position.set(0, top - 0.02, -0.55 + i * 0.16); m.add(c); }
            } else if (e.type === 'window_watcher') {
                for (let i = 0; i < 6; i++) { const sp = eyeSpr(0xddddff, (Math.random() - 0.5) * hw * 1.6, top * (0.4 + Math.random() * 0.55), fz * 0.92, 0.16 + Math.random() * 0.12); m.add(sp); e._fx.push({ k: 'eye', o: sp }); }
            }
        }
        function animEntity(e) {
            if (!e._fx) return; const t = performance.now() * 0.001, ch = e.state === 'chase', k = ch ? 1.8 : 1;
            e._fx.forEach(f => { if (f.k === 'eye') f.o.scale.setScalar(f.o.userData.s * (1 + 0.25 * Math.sin(t * (ch ? 16 : 5) + f.o.position.x * 9)) * (ch ? 1.5 : 1)); else f.o.rotation.z = Math.sin(t * 3 * k + f.p) * 0.35 * k; });
        }
        let _BaseEntity = null;
        function makeNoise(pos, radius, loud) { // monsters investigate noises; the position they learn is only approximate
            if (!loud && DifficultyConfigs[GameState.difficulty].id === 'easy') return;
            GameState.entities.forEach(e => { if (e.stunTimer > 0 || e.type === 'window_watcher' || e.mesh.userData.hat) return; const d = e.mesh.position.distanceTo(pos); if (d > radius) return;
                const j = Math.max(1.5, d * 0.22); e.lastKnown = new THREE.Vector3(pos.x + (Math.random() - 0.5) * j, 2, pos.z + (Math.random() - 0.5) * j);
                if (e.state !== 'chase') { e.state = 'investigate'; e.investigateTarget = e.lastKnown.clone(); e.investigateTimer = 10; } });
        }
        function aiExtra(e, dt, pp, prev, los) {
            const ex = e.type === 'window_watcher' || e.mesh.userData.hat, hall = (LevelData[GameState.level] || {}).hallway, P = e.mesh.position, cs = GameState.cellSize;
            if (e.stunTimer > 0) return;
            if (e.type === 'hound' && (e.state === 'flee' || e.state === 'lunge' || e.state === 'swarm')) return; // hound fleeing/lunging/swarming is fully handled by its own AI
            e._wT = (e._wT || 0) - dt; if (e.state === 'wander' && e._wT <= 0) { e._wT = 3 + Math.random() * 4; const d = [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)]; e.wanderDir.set(d[0], 0, d[1]); }
            if (e.mesh.userData.hat && e.hideTarget) { const s = e.hideTarget, sp = GameState.hideSpots || [];
                if (!sp.includes(s)) e.hideTarget = null; else { e.state = 'investigate'; e.investigateTarget = new THREE.Vector3(s.x, 2, s.z); e.investigateTimer = 5;
                    if (P.distanceTo(e.investigateTarget) < 2.6) { const tp = new THREE.Vector3(s.x, 0.5, s.z); AudioSys.at(e.mesh.position).playTableThrow(); setTimeout(() => AudioSys.at(tp).playTableSmash(), 350); scene.remove(s.g); sp.splice(sp.indexOf(s), 1); e.hideTarget = null; showEventBanner('THEY SMASHED YOUR HIDING SPOT', 2); } } }
            if (e.clockT) { e.state = 'investigate'; e.investigateTarget = e.clockT; e.investigateTimer = 5; const d = getNextGridStep(P.x, P.z, e.clockT.x, e.clockT.z), nx = P.x + d.x * 9 * dt, nz = P.z + d.z * 9 * dt; // sprint to the alarm
                if (GameState.grid[Math.round(P.z / cs)]?.[Math.round(nx / cs)] === 0) P.x = nx; if (GameState.grid[Math.round(nz / cs)]?.[Math.round(P.x / cs)] === 0) P.z = nz; return; }
            if (ex) return;
            if (prev === 'chase' && e.state !== 'chase' && !los && e.lastKnown && P.distanceTo(pp) < 60) { e.state = 'investigate'; e.investigateTarget = e.lastKnown.clone(); e.investigateTimer = 10; } // keep hunting the last known position
            if (e.type === 'hound' && e._role) return; // pack hounds are coordinated by the swarm manager, not the one-chaser rule
            if (hall) { if (e.state === 'chase') GameState.chaser = GameState.chaser || e; return; }
            const ch = GameState.chaser, live = ch && ch !== e && GameState.entities.includes(ch) && (ch.state === 'chase' || ch.state === 'investigate' && ch.lastKnown);
            if (!live && ch && ch !== e) GameState.chaser = null;
            if (e.state === 'chase') { if (live) { e.state = 'wander'; } else GameState.chaser = e; }
            else if (GameState.chaser === e && e.state !== 'investigate') GameState.chaser = null;
            const myD = P.distanceTo(pp), closer = GameState.entities.some(o => o !== e && !o.mesh.userData.hat && o.type !== 'window_watcher' && o.mesh.position.distanceTo(pp) < Math.min(myD, 26));
            if (e.state !== 'chase' && myD < 26 && (live || closer)) { const away = P.clone().sub(pp).setY(0).normalize(); e.wanderDir.copy(away); e.state = 'wander'; const nx = P.x + away.x * 3 * dt, nz = P.z + away.z * 3 * dt;
                if (GameState.grid[Math.round(P.z / cs)]?.[Math.round(nx / cs)] === 0) P.x = nx; if (GameState.grid[Math.round(nz / cs)]?.[Math.round(P.x / cs)] === 0) P.z = nz; }
        }
        function extraTick(dt, p) {
            try { Swarm.tick(dt, p); } catch (er) {}
            const sp = (GameState.hideSpots || []).find(s => Math.hypot(s.x - p.x, s.z - p.z) < 0.95), was = GameState.hidden;
            if (sp && !was) GameState.entities.forEach(e => { if (e.mesh.userData.hat && e.mesh.position.distanceTo(p) < 16 && _BaseEntity.prototype.hasLineOfSight.call(e, p)) e.hideTarget = sp; }); // saw you go under
            GameState.hidden = !!sp; GameState.hideDrop = (GameState.hideDrop || 0) + ((sp ? -1.25 : 0) - (GameState.hideDrop || 0)) * Math.min(1, dt * 8); p.y += GameState.hideDrop; if (window.realMode) { p.y -= 0.7; if (Math.abs(camera.rotation.z) < 0.05) { camera.rotation.z = Math.sin(performance.now() * 0.0013) * 0.007; GameState._rr = true; } } else if (GameState._rr) { camera.rotation.z = 0; GameState._rr = false; } // eye height is reset to 2 (+bob) every frame, so apply the crouch as an offset instead of fighting it
            const C = GameState.clk; if (!C) return;
            const kill = () => { stopAlarm(); if (C.mesh) scene.remove(C.mesh); if (!C.thrown) { const i = GameState.inv.findIndex(x => x && x.id === 'clock'); if (i >= 0) invRemoveOne(i); } GameState.entities.forEach(e => e.clockT = null); GameState.clk = null; showEventBanner('THE CLOCK WAS DESTROYED', 2); };
            if (!C.ring) { C.t -= dt; if (C.t <= 0) { C.ring = 1; C.rt = 0; C.age = 0; C.pos = C.thrown ? C.pos : p.clone(); GameState.entities.forEach(e => { if (e.mesh.position.distanceTo(C.pos) < 160) e.clockT = C.pos; }); } return; }
            C.age += dt; C.rt -= dt; if (!C.rang) { C.rang = 1; AudioSys.at(C.pos).playAlarm(); } if (C.rt <= 0) { C.rt = 0.45; makeNoise(C.pos, 160, true); }
            if (C.age > 25 || GameState.entities.some(e => e.clockT && e.mesh.position.distanceTo(C.pos) < 2.2)) kill();
        }
        document.addEventListener('mousedown', e => { // LMB: throw a wound-up clock
            const C = GameState.clk, it = GameState.inv[GameState.invSel]; if (e.button !== 0 || !GameState.isRunning || GameState.isPaused || !C || C.thrown || C.ring || !it || it.id !== 'clock') return;
            C.thrown = true; AudioSys.playClockWind(); setTimeout(() => { const p = controls.getObject().position, f = new THREE.Vector3(), cs = GameState.cellSize; camera.getWorldDirection(f); f.y = 0; f.normalize(); let d = 1;
                for (; d < 9; d += 0.5) if (GameState.grid[Math.round((p.z + f.z * d) / cs)]?.[Math.round((p.x + f.x * d) / cs)] !== 0) break; d = Math.max(1, d - 1);
                const m = buildItemModel('clock'); m.scale.setScalar(0.9); m.position.set(p.x + f.x * d, 0.25, p.z + f.z * d); scene.add(m); C.mesh = m; C.pos = m.position.clone();
                const i = GameState.inv.findIndex(x => x && x.id === 'clock'); if (i >= 0) invRemoveOne(i); }, 500);
        });
        { const _ps = AudioSys.playStep; AudioSys.playStep = (...a) => { _ps(...a); if (GameState.isRunning) makeNoise(controls.getObject().position, 12, false); }; const _sg = AudioSys.playShotgun; AudioSys.playShotgun = (...a) => { _sg(...a); if (GameState.isRunning) makeNoise(controls.getObject().position, 55, true); }; }
        // Rare pink Bacteria (1 in 10 that spawn; never the main-menu one). A gentle colour/emissive shift on every material of the model: no new meshes, textures or lights,
        // and a cloned material has the same shader parameters, so nothing recompiles. Procedural models own their materials (tinted in place); custom rigs share them between
        // clones, so those get per-entity copies. Applies to the generated model and to GLB rigs alike.
        const PINK_HUE = new THREE.Color(0xff6fb5); let _noPink = false;
        function pinkTint(root, cloneMats, skip) {
            const seen = new Map();
            root.traverse(o => {
                if (skip && skip(o)) return; const m0 = o.material; if (!m0) return;
                const tint = m => { if (!m || !m.color) return m; let n = seen.get(m); if (!n) { n = cloneMats ? m.clone() : m; seen.set(m, n); n.color.lerp(PINK_HUE, 0.3); if (n.emissive) n.emissive.lerp(PINK_HUE, 0.07); } return n; };
                o.material = Array.isArray(m0) ? m0.map(tint) : tint(m0);
            });
        }
        function pinkRoll(e) {
            if (_noPink || e.type !== 'bacteria' || Math.random() >= 0.1) return;
            e._pink = true; pinkTint(e.mesh, false, o => o === e.stunRing || (e.stunRing && o.parent === e.stunRing));
        }
        { const _E = _BaseEntity = Entity; Entity = class extends _E { constructor(ty, x, z) { super(ty, x, z); try { smilerPlane(this); } catch (er) {} try { rigMeasure(this); } catch (er) {} try { enhanceEntity(this); } catch (er) {} try { rigAttach(this); } catch (er) {} try { pinkRoll(this); } catch (er) {} }
            hasLineOfSight(pp) { if (GameState.hidden && !this.hideTarget) return false; return super.hasLineOfSight(pp); }
            update(dt, pp) { const prev = this.state, los = this.hasLineOfSight(pp); if (los && prev === 'chase') { this.lastKnown = pp.clone(); } super.update(dt, pp); this._s0 = this.state; try { aiExtra(this, dt, pp, prev, los); animEntity(this); } catch (er) {} try { trackHunt(this, dt); } catch (er) {} } }; }
        let menuEnt = null, menuMouse = 0, menuLastT = 0, menuBack = [];
        function initMenuScene() { // a sealed, lit-up Level 0 room nobody can reach: every entity standing in it
            _noPink = true; // the menu Bacteria is never pink
            try {
                menuEnt = new Entity('bacteria', 0, 0); scene.remove(menuEnt.mesh); GameState.entities = [];
                const m = menuEnt.mesh; m.position.set(2.4, 0, 0); m.scale.setScalar(1.4); menuScene.add(m);
                menuBack = [];
                [['skinstealer', 0.2, -1.8], ['smiler', 4.3, -1.7], ['hound', 1.3, -3.2], ['window_watcher', 3.5, -3.3]].forEach(([t, x, z], i) => { try {
                    const e = new Entity(t, 0, 0); scene.remove(e.mesh); const em = e.mesh; em.position.set(x, 0, z); em.scale.setScalar(1.25); em.rotation.y = -0.5; menuScene.add(em); menuBack.push({ m: em, ph: i * 1.7, bx: x });
                } catch (er) {} });
                GameState.entities = [];
                const pg = makePartygoerMesh(0.9); pg.position.set(3.7, 0, 0.8); pg.scale.setScalar(1.3); menuScene.add(pg); menuBack.push({ m: pg, ph: 5, bx: 3.7 });
                const L0 = LevelData[0], mk = (t, rx, ry) => { const c = TextureGen.create(t).clone(); c.repeat.set(rx, ry); c.needsUpdate = true; return c; }, mats = [];
                const M = o => { const x = new THREE.MeshStandardMaterial(o); mats.push(x); return x; };
                const pl = (w, h, mat, x, y, z, rx, ry) => { const q = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat); q.rotation.set(rx || 0, ry || 0, 0); q.position.set(x, y, z); q.receiveShadow = true; menuScene.add(q); return q; };
                pl(16, 15, M({ map: mk(L0.floorTex, 3, 2.8), roughness: 0.8 }), 0, 0, 1.5, -Math.PI / 2, 0);
                pl(16, 15, M({ map: mk(L0.ceilTex, 2, 2), roughness: 0.8 }), 0, 4.6, 1.5, Math.PI / 2, 0);
                const wm = w => M({ map: mk(L0.wallTex, w / 4, 1.15), roughness: 0.85 });
                pl(16, 4.6, wm(16), 0, 2.3, -6, 0, 0); pl(15, 4.6, wm(15), -8, 2.3, 1.5, 0, Math.PI / 2); pl(15, 4.6, wm(15), 8, 2.3, 1.5, 0, -Math.PI / 2); pl(16, 4.6, wm(16), 0, 2.3, 9, 0, Math.PI);
                const fx = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.07, 0.8), new THREE.MeshBasicMaterial({ color: 0xfff2c2 })); fx.position.set(1.8, 4.57, -0.5); menuScene.add(fx);
                const lamp = new THREE.PointLight(0xfff2c2, 3, 24, 1.4); lamp.position.set(1.8, 4.2, -0.5); menuScene.add(lamp);
                const amb = new THREE.AmbientLight(0x0a0a0e, 0.1); menuScene.add(amb);
                menuScene.traverse(o => { if (o.isMesh && o.geometry && !(o.geometry.type === 'PlaneGeometry')) o.castShadow = true; });
                [m, ...menuBack.map(o => o.m)].forEach(o => o.traverse(c => { if (c.isMesh) c.castShadow = true; }));
                GameState.menuLight = lamp; GameState.menuBase = 3; GameState.menuAmb = amb; GameState.menuMats = mats;
                const cv = document.createElement('canvas'); cv.width = cv.height = 64; const g = cv.getContext('2d').createRadialGradient(32, 32, 0, 32, 32, 32);
                g.addColorStop(0, 'rgba(255,250,200,1)'); g.addColorStop(0.3, 'rgba(255,220,120,.45)'); g.addColorStop(1, 'rgba(0,0,0,0)');
                const x = cv.getContext('2d'); x.fillStyle = g; x.fillRect(0, 0, 64, 64);
                const tex = new THREE.CanvasTexture(cv); menuEnt._glow = [-0.08, 0.08].map(ex => {
                    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
                    sp.position.set(ex, 1.68, 0.3); sp.scale.setScalar(0.38); m.add(sp); return sp; });
                window.menuGfxHook = () => { // follow the graphics settings
                    const g = GameState.graphics, L = GameState.menuLight; if (!L || !renderer) return;
                    L.castShadow = !!renderer.shadowMap.enabled && g.shadowSize > 0;
                    if (L.castShadow) { const sz = Math.min(g.shadowSize, 2048); L.shadow.mapSize.set(sz, sz); L.shadow.bias = -0.002; L.shadow.camera.near = 0.5; L.shadow.camera.far = 30; if (L.shadow.map) { L.shadow.map.dispose(); L.shadow.map = null; } }
                    GameState.menuBase = 3 * (g.rtMode === 'pathtracing' ? 1.3 : g.rtMode === 'raytracing' ? 1.12 : 1);
                    GameState.menuAmb.intensity = g.rtMode === 'pathtracing' ? 0.45 : g.rtMode === 'raytracing' ? 0.22 : 0.1;
                    try { menuScene.environment = g.reflections === 'off' ? null : pmremEnvTexture; } catch (e) {}
                    GameState.menuMats.forEach(x => { x.envMapIntensity = g.reflections === 'off' ? 0 : 1.2; x.roughness = g.reflections === 'off' ? 0.95 : 0.7; x.needsUpdate = true; });
                };
                window.menuGfxHook();
            } catch (e) { menuEnt = null; } finally { _noPink = false; }
        }
        function menuVisible() { return menuEnt && document.getElementById('start-screen').style.display !== 'none' && document.getElementById('shop-screen').style.display !== 'flex'; }
        function renderMenu(t) {
            if ((!window.__vrOn && t - menuLastT < 40) || !renderer || webglContextLost) return; menuLastT = t;
            menuCam.aspect = window.innerWidth / window.innerHeight; menuCam.updateProjectionMatrix();
            const s = t * 0.001, m = menuEnt.mesh;
            m.rotation.y = -0.4 + menuMouse * 0.4 + Math.sin(s * 0.5) * 0.05; m.position.y = Math.sin(s * 0.9) * 0.025;
            if (menuEnt.armL) { menuEnt.armL.rotation.x = 0.25 + Math.sin(s * 1.1) * 0.06; menuEnt.armR.rotation.x = 0.25 + Math.sin(s * 1.1 + 1.3) * 0.06; }
            const fl = (Math.sin(s * 23) > 0.985) ? 0.3 : 1; menuEnt._glow.forEach(g => g.material.opacity = fl * (0.85 + Math.sin(s * 2) * 0.15));
            menuBack.forEach(o => { o.m.position.y = Math.sin(s * 0.7 + o.ph) * 0.03; o.m.rotation.y = -0.5 + menuMouse * 0.25 + Math.sin(s * 0.4 + o.ph) * 0.06; o.m.position.x = o.bx + menuMouse * 0.15; });
            if (GameState.menuLight) GameState.menuLight.intensity = GameState.menuBase * (0.97 + Math.sin(s * 11) * 0.015 + (Math.sin(s * 23) > 0.99 ? -0.25 : 0));
            renderer.render(menuScene, window.__vrOn ? window.__vrCam : menuCam);
        }
        document.addEventListener('mousemove', e => { menuMouse = (e.clientX / window.innerWidth) * 2 - 1; });
        initMenuScene();

        // ===== SECRET DEBUG ROOM (Q-W-E-R-T-Y on the main menu) =====
        const DBG_SEQ = ['q', 'w', 'e', 'r', 't', 'y']; let dbgIdx = 0, dbgLast = 0, dbgData = null;
        const elx = id => document.getElementById(id);
        function menuIdle() { return elx('start-screen').style.display !== 'none' && ['settings-modal', 'shop-screen', 'ach-modal'].every(i => elx(i).style.display !== 'flex' && elx(i).style.display !== 'block'); }
        document.addEventListener('keydown', e => {
            if (GameState.debugScene) { if (e.key.toLowerCase() === 'e' && !e.repeat) debugInteract(); return; }
            if (e.repeat) return;
            if (!menuIdle() || GameState.isRunning) { dbgIdx = 0; return; }
            const k = e.key.toLowerCase();
            if (k === DBG_SEQ[dbgIdx]) { if (++dbgIdx === DBG_SEQ.length) { dbgIdx = 0; enterDebugRoom(); } } else dbgIdx = (k === 'q') ? 1 : 0;
        });
        function labelSprite(text, w = 4) {
            const c = document.createElement('canvas'); c.width = 512; c.height = 128; const x = c.getContext('2d');
            x.fillStyle = 'rgba(0,0,0,.6)'; x.fillRect(0, 0, 512, 128); x.fillStyle = '#e6c84c'; x.font = 'bold 44px Courier New'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 256, 64);
            const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c) })); s.scale.set(w, w / 4, 1); return s;
        }
        function dbgWalkable(x, z, r = 0.4) { return [[r, r], [-r, r], [r, -r], [-r, -r]].every(([a, b]) => dbgData.rects.some(q => x + a >= q[0] && x + a <= q[1] && z + b >= q[2] && z + b <= q[3])); }
        function enterDebugRoom() {
            if (MP.active) return; // debug room is singleplayer-only
            if (!renderer || webglContextLost) return;
            unlockAch('debug');
            GameState.debugRoom = true; GameState.debugScene = true; GameState.dbgPanel = false;
            elx('start-screen').style.display = 'none'; elx('dbg-hud').style.display = 'block';
            for (let i = scene.children.length - 1; i >= 0; i--) { const o = scene.children[i]; if (o !== controls.getObject() && o !== ambientLight) scene.remove(o); }
            GameState.entities = []; GameState.items = []; GameState.props = []; GameState.ceilingLights = []; GameState.rtBounceLights = [];
            if (GameState.floorReflector) { if (GameState.floorReflector.dispose) GameState.floorReflector.dispose(); GameState.floorReflector = null; }
            const G = new THREE.Group(), rects = [[-10, 10, -10, 10], [10, 21, -1.5, 1.5]], inter = [], ents = [];
            rects.push([-22, -10, -1.5, 1.5], [-98, -22, -7, 7]); // texture gallery wing
            const types = Object.keys(ENTITY_NAMES);
            types.forEach((t, i) => { const cx = 28 + 24 * i; rects.push([cx - 7, cx + 7, -7, 7]); if (i < types.length - 1) rects.push([cx + 7, cx + 17, -1.5, 1.5]); });
            const inAny = (x, z) => rects.some(q => x >= q[0] && x <= q[1] && z >= q[2] && z <= q[3]);
            const floorM = new THREE.MeshStandardMaterial({ color: 0x55535a, roughness: 0.85 }), ceilM = new THREE.MeshStandardMaterial({ color: 0x2a2a2e, roughness: 1 });
            const wallPos = [];
            rects.forEach(q => {
                const w = q[1] - q[0], d = q[3] - q[2], cx = (q[0] + q[1]) / 2, cz = (q[2] + q[3]) / 2;
                const f = new THREE.Mesh(new THREE.PlaneGeometry(w, d), floorM); f.rotation.x = -Math.PI / 2; f.position.set(cx, 0, cz); G.add(f);
                const c = new THREE.Mesh(new THREE.PlaneGeometry(w, d), ceilM); c.rotation.x = Math.PI / 2; c.position.set(cx, 4.6, cz); G.add(c);
                for (let x = q[0] + 0.5; x < q[1]; x++) [q[2] - 0.5, q[3] + 0.5].forEach(z => { if (!inAny(x, z)) wallPos.push([x, z]); });
                for (let z = q[2] + 0.5; z < q[3]; z++) [q[0] - 0.5, q[1] + 0.5].forEach(x => { if (!inAny(x, z)) wallPos.push([x, z]); });
            });
            const walls = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 4.6, 1), new THREE.MeshStandardMaterial({ color: 0x4b4a52, roughness: 0.9 }), wallPos.length);
            const mx = new THREE.Matrix4(); wallPos.forEach((p, i) => { mx.setPosition(p[0], 2.3, p[1]); walls.setMatrixAt(i, mx); }); G.add(walls);
            const lamp = (x, z, col = 0xfff0d0, k = 1) => { const l = new THREE.PointLight(col, 34 * k, 26, 1.2); l.position.set(x, 4, z); G.add(l); };
            lamp(-5, 0); lamp(5, 0); lamp(0, -7); lamp(0, 7); lamp(16, 0, 0xcfe0ff, 0.8);
            const term = (x, z, color, text, act) => {
                const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.7, 0.6), new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: color, emissiveIntensity: 0.45 })); b.position.set(x, 0.85, z); G.add(b);
                const l = labelSprite(text); l.position.set(x, 2.6, z); G.add(l); inter.push({ p: new THREE.Vector3(x, 1, z), label: text, act });
            };
            term(-6, -9.4, 0x3366ff, 'LEVEL SELECT', () => openDbgPanel('dbg-level-panel'));
            term(6, -9.4, 0x33cc66, 'AUDIO TEST', () => openDbgPanel('dbg-audio-panel'));
            const btn = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.7, 0.2), new THREE.MeshStandardMaterial({ color: 0xaa0000, emissive: 0xff0000, emissiveIntensity: 0.9 })); btn.position.set(0, 1.5, 9.85); G.add(btn);
            const el = labelSprite('EXIT TO MENU'); el.position.set(0, 2.5, 9.6); G.add(el); inter.push({ p: new THREE.Vector3(0, 1.5, 9.4), label: 'EXIT TO MENU', act: leaveDebugRoom });
            const tgSign = labelSprite('<<  TEXTURE GALLERY', 5); tgSign.position.set(-9.4, 3, 0); G.add(tgSign);
            ['carpet','wallpaper','ceiling','concrete','concrete_wall','concrete_dark','drywall','ducts','pipes','crate','brick_wires','office_carpet','office_wall','hotel_carpet','hotel_wall','inverted_floor','inverted_wall','party_floor','party_wall','glitch','door','elevator','fireexit'].forEach((nm, i) => { try { const tx = TextureGen.create(nm).clone(); tx.repeat.set(2, 2); tx.needsUpdate = true; const north = i < 12, k = north ? i : i - 12;
                const pn = new THREE.Mesh(new THREE.PlaneGeometry(3, 3), new THREE.MeshStandardMaterial({ map: tx, emissive: 0xffffff, emissiveMap: tx, emissiveIntensity: 0.55 })); pn.position.set(-26 - k * 6, 2.2, north ? -6.45 : 6.45); if (!north) pn.rotation.y = Math.PI; G.add(pn);
                const lb = labelSprite(nm, 3); lb.position.set(pn.position.x, 4.1, pn.position.z + (north ? 0.5 : -0.5)); G.add(lb); } catch (e) {} });
            lamp(-40, 0, 0xffffff, 0.5); lamp(-65, 0, 0xffffff, 0.5); lamp(-90, 0, 0xffffff, 0.5);
            const hubSign = labelSprite('ENTITY GALLERY  >>', 5); hubSign.position.set(9.4, 3, 0); G.add(hubSign);
            types.forEach((t, i) => {
                const cx = 28 + 24 * i, e = new Entity(t, cx, 0); scene.remove(e.mesh); GameState.entities = [];
                e.mesh.position.set(cx, 0.4, 0); G.add(e.mesh); ents.push(e);
                const ped = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.1, 0.4, 16), new THREE.MeshStandardMaterial({ color: 0x2a2a30 })); ped.position.set(cx, 0.2, 0); G.add(ped);
                const ls = labelSprite(ENTITY_NAMES[t].toUpperCase(), 4.5); ls.position.set(cx, 3.6, -6.4); G.add(ls);
                lamp(cx, 0, 0xffeedd, 1.1); lamp(cx - 4, 4, 0x8899ff, 0.5);
            });
            scene.add(G); scene.fog = new THREE.FogExp2(0x08080a, 0.01); scene.background = new THREE.Color(0x08080a);
            ambientLight.color.setHex(0x9090a0); ambientLight.intensity = 0.7; flashLight.visible = false; shotgunViewGroup.visible = false;
            dbgData = { G, rects, inter, ents }; applyGraphicsSettings();
            const cam = controls.getObject(); cam.position.set(0, 2, 5); cam.rotation.set(0, 0, 0);
            const ll = elx('dbg-level-list'); ll.innerHTML = '';
            LevelData.forEach((L, i) => { const b = document.createElement('button'); b.className = 'diff-btn'; b.textContent = L.name; b.onclick = () => Attraction.gate(i, () => { leaveDebugRoom(true); startGame(i, true); }, pi => { leaveDebugRoom(true); startGame(pi, true); }); ll.appendChild(b); });
            const sl = elx('dbg-sound-list'); sl.innerHTML = '';
            [...Object.keys(SFX_REG), 'chase_layer_1', 'chase_layer_2', 'chase_layer_3'].forEach(id => { const o = document.createElement('option'); o.value = id; o.textContent = id; sl.appendChild(o); });
            sl.selectedIndex = 0; dbgLast = performance.now(); AudioSys.init().catch(() => {});
            try { controls.lock(); } catch (e) {}
        }
        function openDbgPanel(id) { GameState.dbgPanel = true; try { controls.unlock(); } catch (e) {} elx(id).style.display = 'flex'; }
        function closeDbgPanels() { ['dbg-level-panel', 'dbg-audio-panel'].forEach(i => elx(i).style.display = 'none'); GameState.dbgPanel = false; try { controls.lock(); } catch (e) {} }
        function leaveDebugRoom(toLevel = false) {
            GameState.debugScene = false; elx('dbg-hud').style.display = 'none'; ['dbg-level-panel', 'dbg-audio-panel'].forEach(i => elx(i).style.display = 'none'); GameState.dbgPanel = false;
            if (Sfx.cur) { try { Sfx.cur.stop(); } catch (e) {} } ChaseAudio.set(0);
            applyVolumes();
            if (dbgData) { dbgData.G.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); scene.remove(dbgData.G); dbgData = null; }
            if (!toLevel) { try { controls.unlock(); } catch (e) {} GameState.debugRoom = false; elx('start-screen').style.display = 'flex'; scene.background = new THREE.Color(0x000000); }
        }
        function debugInteract() { if (GameState.dbgPanel || !dbgData) return; const n = dbgNearest(); if (n) n.act(); }
        function dbgNearest() { const p = controls.getObject().position; let best = null, bd = 3.4; dbgData.inter.forEach(i => { const d = Math.hypot(i.p.x - p.x, i.p.z - p.z); if (d < bd) { bd = d; best = i; } }); return best; }
        function debugTick(t) {
            if (!dbgData) return; const dt = Math.min((t - dbgLast) / 1000, 0.05); dbgLast = t;
            const p = controls.getObject().position;
            if ((controls.isLocked || window.__vrOn) && !GameState.dbgPanel) {
                const sp = (keys.shift ? 8 : 5) * dt, f = (keys.w ? 1 : 0) - (keys.s ? 1 : 0), r = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
                let ox = p.x, oz = p.z; controls.moveForward(f * sp); if (!dbgWalkable(p.x, p.z)) { p.x = ox; p.z = oz; }
                ox = p.x; oz = p.z; controls.moveRight(r * sp); if (!dbgWalkable(p.x, p.z)) { p.x = ox; p.z = oz; }
            }
            p.y = 2;
            dbgData.ents.forEach((e, i) => { e.mesh.rotation.y = t * 0.0004 + i; if (e.armL) { e.armL.rotation.x = 0.3 + Math.sin(t * 0.0015) * 0.08; e.armR.rotation.x = 0.3 + Math.sin(t * 0.0015 + 1) * 0.08; } });
            const n = dbgNearest(); elx('dbg-prompt').textContent = (n && !GameState.dbgPanel) ? '[E] ' + n.label : '';
            renderMain();
        }
        document.addEventListener('click', () => { if (GameState.debugScene && !GameState.dbgPanel && !controls.isLocked) { try { controls.lock(); } catch (e) {} } });
        elx('dbg-level-close').addEventListener('click', closeDbgPanels);
        elx('dbg-audio-close').addEventListener('click', () => { if (Sfx.cur) { try { Sfx.cur.stop(); } catch (e) {} } ChaseAudio.set(0); closeDbgPanels(); });
        elx('dbg-vol').addEventListener('input', e => { if (AudioSys.masterGain) AudioSys.masterGain.gain.setValueAtTime(e.target.value / 100, AudioSys.ctx.currentTime); });
        elx('dbg-play').addEventListener('click', async () => {
            const id = elx('dbg-sound-list').value; if (!id) return; await AudioSys.init(); if (AudioSys.ctx.state !== 'running') await AudioSys.ctx.resume();
            if (Sfx.cur) { try { Sfx.cur.stop(); } catch (e) {} Sfx.cur = null; }
            if (id.startsWith('chase_layer_')) { ChaseAudio.set(+id.slice(-1)); elx('dbg-now').textContent = 'looping ' + id + ' (procedural)'; return; }
            ChaseAudio.set(0); elx('dbg-now').textContent = `${id} [${Sfx.buf[id] ? 'FILE' : 'PROCEDURAL'}]`; Sfx.preview(id).then(() => { if (elx('dbg-now').textContent.startsWith(id)) elx('dbg-now').textContent = ''; });
        });
        elx('dbg-stop').addEventListener('click', () => { if (Sfx.cur) { try { Sfx.cur.stop(); } catch (e) {} } ChaseAudio.set(0); elx('dbg-now').textContent = ''; });

        // ===== SOUND MAPPING MENU: key (sound) -> value (file). Only sounds that could not be downloaded from sounds/ are editable. =====
        const SfxMap = {
            pool: [], target: null, err: {}, busy: false,
            el(id) { return document.getElementById(id); },
            mk(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; },
            async open() {
                this.el('sfx-map-panel').style.display = 'flex'; this.el('map-intro').textContent = 'Preparing audio...';
                try { await AudioSys.init(); if (AudioSys.ctx.state !== 'running') await AudioSys.ctx.resume(); if (Sfx.loading) await Sfx.loading; }
                catch (e) { this.el('map-intro').textContent = 'Audio unavailable: ' + e.message; return; }
                this.render();
            },
            close() {
                if (Sfx.cur) { try { Sfx.cur.stop(); } catch (e) {} }
                this.el('sfx-map-panel').style.display = 'none';
                const testOpen = document.getElementById('sfx-panel').style.display === 'flex';
                if (testOpen) runSfxTest();
                else if (GameState.isPaused && AudioSys.ctx && AudioSys.ctx.state === 'running') AudioSys.ctx.suspend().catch(() => {});
            },
            addToPool(f) { if (!this.pool.some(p => p.name === f.name && p.size === f.size)) this.pool.push(f); },
            async addFiles(files) { // multi-select: add to the pool, then auto-match by name for convenience
                files.forEach(f => this.addToPool(f)); this.busy = true;
                const n = await Sfx.pick(files); this.busy = false; this.err = {};
                this.render();
                this.el('map-intro').textContent += n ? `  Auto-matched ${n} file(s) by name; assign the rest from the dropdowns.` : '  No file names matched automatically; assign files from the dropdowns.';
            },
            async assign(id, file) {
                this.busy = true; const r = await Sfx.mapFile(id, file); this.busy = false;
                if (r.ok) delete this.err[id]; else this.err[id] = `${file.name}: ${r.err}. Previous setting kept.`;
                this.render();
            },
            async clear(id) { await Sfx.unmap(id); delete this.err[id]; this.render(); },
            render() {
                const ids = Object.keys(SFX_REG), locked = ids.filter(id => Sfx.isLocked(id)), edit = ids.filter(id => !Sfx.isLocked(id));
                this.el('map-intro').textContent = edit.length
                    ? `${locked.length} / ${ids.length} sounds were downloaded from "${Sfx.base}" and are locked. The ${edit.length} below could not be downloaded: map each one to any audio file (any name, .ogg/.mp3/.wav). Unmapped sounds use the built-in procedural version. Mappings are saved in this browser.`
                    : `All ${ids.length} sounds were downloaded from "${Sfx.base}". Nothing to map.`;
                this.el('map-pool').textContent = this.pool.length ? `${this.pool.length} file(s) available in dropdowns` : '';
                this.el('map-reset').style.display = edit.some(id => Sfx.st[id] && Sfx.st[id].src === 'FILE') ? '' : 'none';
                this.el('map-export').style.display = edit.some(id => Sfx.st[id] && Sfx.st[id].origin === 'MAPPED') ? '' : 'none';
                const list = this.el('map-list'); list.textContent = '';
                for (const id of edit) {
                    const s = Sfx.st[id] || {}, mapped = s.src === 'FILE';
                    const row = this.mk('div', 'map-row' + (mapped ? ' ok' : ''));
                    const key = this.mk('div', 'map-key'); key.append(this.mk('b', null, id), this.mk('small', null, SFX_LABEL[id] || ''));
                    const sel = this.mk('select'); sel.disabled = this.busy;
                    const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); };
                    add('', '— procedural (default) —');
                    const poolIdx = mapped ? this.pool.findIndex(p => p.name === s.name) : -1;
                    if (mapped && poolIdx < 0) add('@saved', (s.name || 'saved file') + ' (saved)');
                    this.pool.forEach((p, i) => add('p' + i, p.name));
                    sel.value = !mapped ? '' : (poolIdx >= 0 ? 'p' + poolIdx : '@saved');
                    sel.addEventListener('change', () => {
                        if (sel.value === '') this.clear(id);
                        else if (sel.value[0] === 'p') this.assign(id, this.pool[+sel.value.slice(1)]);
                    });
                    const act = this.mk('div', 'map-actions');
                    const br = this.mk('button', 'menu-btn', 'BROWSE'); br.title = 'Pick a file for this sound';
                    br.addEventListener('click', () => { this.target = id; this.el('sfx-one-file').click(); });
                    const pl = this.mk('button', 'menu-btn', '\u25B6'); pl.title = 'Preview (file if mapped, otherwise procedural)';
                    pl.addEventListener('click', async () => { try { if (AudioSys.ctx.state !== 'running') await AudioSys.ctx.resume(); if (Sfx.cur) { try { Sfx.cur.stop(); } catch (e) {} } Sfx.preview(id); } catch (e) {} });
                    act.append(br, pl);
                    if (mapped) { const x = this.mk('button', 'menu-btn', '\u2715'); x.title = 'Clear mapping'; x.addEventListener('click', () => this.clear(id)); act.append(x); }
                    row.append(key, sel, act);
                    if (this.err[id]) row.append(this.mk('div', 'map-err', this.err[id]));
                    list.appendChild(row);
                }
                const lk = this.el('map-locked'); lk.textContent = '';
                if (locked.length) { const d = this.mk('details'); d.append(this.mk('summary', null, `Downloaded sounds (${locked.length}, locked)`), this.mk('div', null, locked.join(', '))); lk.appendChild(d); }
            }
        };
        // Export: only sounds mapped from the player's own files (not embedded in AUDIO, not downloaded, not procedural)
        async function exportMappedAsBase64() {
            const msg = document.getElementById('map-export-msg'), lines = [];
            const sniff = u8 => { const t = (a, b) => String.fromCharCode(...u8.slice(a, b));
                if (t(0, 4) === 'OggS') return 'audio/ogg'; if (t(0, 4) === 'RIFF') return 'audio/wav'; if (t(0, 4) === 'fLaC') return 'audio/flac'; if (t(4, 8) === 'ftyp') return 'audio/mp4'; return 'audio/mpeg'; };
            for (const id of Object.keys(SFX_REG)) {
                const st = Sfx.st[id]; if (!st || st.origin !== 'MAPPED' || st.src !== 'FILE') continue;
                let ab = null; try { ab = await idbGet(id); } catch (e) {} if (!ab) continue;
                const u8 = new Uint8Array(ab); let bin = ''; for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
                lines.push(`    "${id}": "data:${sniff(u8)};base64,${btoa(bin)}",`);
            }
            if (!lines.length) { msg.textContent = ' Nothing to export (no sounds mapped from your own files).'; return; }
            const text = lines.join('\n') + '\n'; let copied = false;
            try { await navigator.clipboard.writeText(text); copied = true; } catch (e) {}
            try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = 'audio_table_entries.txt'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); } catch (e) {}
            msg.textContent = ` Exported ${lines.length} sound(s)${copied ? ' (copied to clipboard + ' : ' ('}saved as audio_table_entries.txt). Paste the lines into the AUDIO table.`;
        }
        document.getElementById('map-export').addEventListener('click', exportMappedAsBase64);
        async function onSoundFiles(files) { await SfxMap.open(); await SfxMap.addFiles(files); }
        document.getElementById('snd-btn').addEventListener('click', () => SfxMap.open());
        document.getElementById('sfx-pick').addEventListener('click', () => SfxMap.open());
        { // when every audio slot already has a base64 blob, the LOAD SOUND FILES buttons are replaced by the code "lsf455"
            const all = Object.keys(SFX_REG).every(id => typeof AUDIO[id] === 'string' && AUDIO[id].trim());
            GameState.lsfOnly = all; if (all) ['snd-btn', 'sfx-pick'].forEach(i => { const b = document.getElementById(i); if (b) b.style.display = 'none'; });
            let lb = ''; document.addEventListener('keydown', e => { if (!GameState.lsfOnly || GameState.isRunning || !e.key || e.key.length !== 1) return; lb = (lb + e.key.toLowerCase()).slice(-6); if (lb === 'lsf455') { lb = ''; SfxMap.open(); } });
            let lastH = null; document.addEventListener('mouseover', e => { const b = e.target.closest && e.target.closest('button, .diff-btn, .shop-card, select'); if (b && b !== lastH && !b.disabled) { try { AudioSys.playHover(); } catch (x) {} } lastH = b || null; });
            setInterval(() => { // the constant tone can be overridden with a "hum" file
                const has = !!Sfx.buf.hum, c = AudioSys.ctx; if (has && AudioSys.humGain && c) AudioSys.humGain.gain.setTargetAtTime(0, c.currentTime, 0.2);
                Sfx.setLoop('hum', !!(has && c && c.state === 'running' && ambTheme() !== 'pools'));
            }, 500);
        }
        document.getElementById('map-add').addEventListener('click', () => document.getElementById('sfx-file').click());
        document.getElementById('map-close').addEventListener('click', () => SfxMap.close());
        document.getElementById('map-reset').addEventListener('click', async () => { for (const id of Object.keys(SFX_REG)) if (Sfx.st[id] && Sfx.st[id].src === 'FILE' && !Sfx.isLocked(id)) await Sfx.unmap(id); SfxMap.err = {}; SfxMap.render(); });
        document.getElementById('sfx-file').addEventListener('change', e => { const f = [...e.target.files]; e.target.value = ''; if (f.length) SfxMap.addFiles(f); });
        document.getElementById('sfx-one-file').addEventListener('change', e => { const f = e.target.files[0], id = SfxMap.target; e.target.value = ''; if (f && id) { SfxMap.addToPool(f); SfxMap.assign(id, f); } });

        document.addEventListener('keydown', e => { // C: eat a cake on the spot (party tables)
            if ((e.key || '').toLowerCase() !== 'c' || !GameState.isRunning || GameState.isPaused) return;
            const p = controls.getObject().position, i = GameState.items.findIndex(it => it.mesh.userData.type === 'cake' && Math.hypot(it.mesh.position.x - p.x, it.mesh.position.z - p.z) < 2.4);
            if (i < 0) return; if (ItemDefs.cake.use(GameState.player) !== false) { scene.remove(GameState.items[i].mesh); GameState.items.splice(i, 1); }
        });
        // ===== ARCADE (tiny endless SMB-style 0-0; world keeps running while you play) =====
        { const wrap = document.createElement('div'); wrap.id = 'arcade'; wrap.style.cssText = 'display:none;position:absolute;right:16px;bottom:96px;z-index:15;border:3px solid #e6c84c;background:#000;font:10px monospace;color:#e6c84c;text-align:center';
          wrap.innerHTML = '<canvas id="arc-cv" width="320" height="180" style="display:block;width:320px;image-rendering:pixelated"></canvas>ARROWS: MOVE / JUMP &middot; E: QUIT &middot; +SANITY &middot; YOU ARE NOT SAFE'; document.body.appendChild(wrap);
          const cv = wrap.querySelector('canvas'), c = cv.getContext('2d'), A = { on: false, last: 0, x: 40, y: 134, vy: 0, cam: 0, obs: [], pits: [], next: 220, k: {} };
          const near = () => { const p = controls.getObject().position; return (GameState.arcades || []).some(a => Math.hypot(a.x - p.x, a.z - p.z) < 2.6); };
          const start = () => { Object.assign(A, { on: true, x: 40, y: 134, vy: 0, cam: 0, obs: [], pits: [], next: 220, last: performance.now() }); wrap.style.display = 'block'; requestAnimationFrame(loop); };
          const stop = () => { A.on = false; wrap.style.display = 'none'; };
          const die = () => { A.x = A.cam + 60; A.y = 100; A.vy = 0; };
          function loop(t) {
              if (!A.on) return; if (!GameState.isRunning || !LevelData[GameState.level].party) { stop(); return; }
              const dt = Math.min(0.05, (t - A.last) / 1000); A.last = t; if (GameState.isPaused) { requestAnimationFrame(loop); return; }
              while (A.next < A.cam + 400) { const r = Math.random(); if (r < 0.3) A.obs.push({ t: 'pipe', x: A.next, w: 24, top: 150 - (24 + 8 * Math.floor(Math.random() * 3)) }); else if (r < 0.6) A.obs.push({ t: 'goomba', x: A.next, w: 14, y: 136, vx: -0.4 }); else if (r < 0.8) A.pits.push({ x: A.next, w: 34 }); else A.obs.push({ t: 'brick', x: A.next, w: 48, top: 104 }); A.next += 110 + Math.random() * 90; }
              A.x += ((A.k.ArrowRight ? 90 : 25) - (A.k.ArrowLeft ? 90 : 0)) * dt; A.cam = Math.max(A.cam, A.x - 100); A.vy += 700 * dt; A.y += A.vy * dt; let ground = null;
              const inPit = A.pits.some(p => A.x + 6 > p.x && A.x + 6 < p.x + p.w); if (!inPit && A.y >= 134) { A.y = 134; A.vy = 0; ground = 1; }
              A.obs.forEach(o => { if (A.x + 12 > o.x && A.x < o.x + o.w) { if (o.t === 'goomba') { if (A.vy > 0 && A.y + 16 < o.y + 9) { o.dead = 1; A.vy = -200; } else if (!o.dead && A.y + 16 > o.y + 2) die(); }
                  else if (A.vy >= 0 && A.y + 16 <= o.top + 8) { A.y = o.top - 16; A.vy = 0; ground = 1; } else if (o.t === 'pipe' && A.y + 16 > o.top + 8) A.x = A.x < o.x ? o.x - 12 : o.x + o.w; } if (o.t === 'goomba') o.x += o.vx * 60 * dt; });
              A.obs = A.obs.filter(o => !o.dead && o.x > A.cam - 60); A.pits = A.pits.filter(p => p.x > A.cam - 60); if (A.y > 200) die(); if (ground && A.k.ArrowUp) { A.vy = -260; A.k.ArrowUp = false; }
              GameState.player.sanity = Math.min(PermaFx.maxSan(), GameState.player.sanity + 4 * dt);
              c.fillStyle = '#5c94fc'; c.fillRect(0, 0, 320, 180); c.fillStyle = '#c84c0c'; c.fillRect(0, 150, 320, 30); c.fillStyle = '#5c94fc'; A.pits.forEach(p => c.fillRect(p.x - A.cam, 150, p.w, 30));
              A.obs.forEach(o => { const x = o.x - A.cam; if (o.t === 'pipe') { c.fillStyle = '#00a800'; c.fillRect(x, o.top, o.w, 150 - o.top); } else if (o.t === 'brick') { c.fillStyle = '#e8a050'; c.fillRect(x, o.top, o.w, 12); } else { c.fillStyle = '#8b4513'; c.fillRect(x, o.y, 14, 14); } });
              c.fillStyle = '#e03030'; c.fillRect(A.x - A.cam, A.y, 12, 16); c.fillStyle = '#fff'; c.fillText('0-0', 6, 12); requestAnimationFrame(loop);
          }
          document.addEventListener('keydown', e => { const k = e.key; if (A.on && k.startsWith('Arrow')) { A.k[k] = true; e.preventDefault(); } if (k.toLowerCase() === 'e' && GameState.isRunning && !GameState.isPaused) { if (A.on) stop(); else if (near()) start(); } });
          document.addEventListener('keyup', e => { if (e.key.startsWith('Arrow')) A.k[e.key] = false; }); }
        // ===== Q: drop selected item =====
        document.addEventListener('keydown', e => {
            if ((e.key || '').toLowerCase() !== 'q' || !GameState.isRunning || GameState.isPaused) return; const it = GameState.inv[GameState.invSel]; if (!it) return;
            const p = controls.getObject().position, f = new THREE.Vector3(); camera.getWorldDirection(f); f.y = 0; f.normalize(); const id = it.id, ammo = it.ammo;
            invRemoveOne(GameState.invSel); spawnPickup(id, p.x + f.x * 1.6, p.z + f.z * 1.6); GameState.items[GameState.items.length - 1].mesh.userData.ammo = ammo; AudioSys.playDrop();
        });
        // ===== LOL999 inventory editor =====
        { let buf = ''; const lp = document.getElementById('lol-panel');
          const draw = () => { const rows = document.getElementById('lol-rows'); rows.textContent = '';
              for (let i = 0; i < 5; i++) { const r = document.createElement('div'); r.className = 'map-row'; r.style.gridTemplateColumns = '70px 1fr'; const k = document.createElement('div'); k.className = 'map-key'; k.innerHTML = '<b>SLOT ' + (i + 1) + '</b>';
                  const s = document.createElement('select'); const o0 = document.createElement('option'); o0.value = ''; o0.textContent = '— empty —'; s.appendChild(o0);
                  Object.entries(ItemDefs).forEach(([id, d]) => { const o = document.createElement('option'); o.value = id; o.textContent = d.icon + ' ' + d.name + (d.secret ? ' (secret)' : ''); s.appendChild(o); });
                  const cur = GameState.inv[i]; s.value = cur ? cur.id : '';
                  s.addEventListener('change', () => { GameState.inv[i] = s.value ? { id: s.value, count: 1, uses: TOOL_MAX[s.value] || 2, active: 0, cd: 0, ammo: s.value === 'shotgun' ? PermaFx.ammoStart() : 0 } : null; syncInventory(); });
                  r.append(k, s); rows.appendChild(r); } };
          window.__vrCode = c => { if (MP.active || !GameState.isRunning || (LevelData[GameState.level] || {}).noLol) return false; c = c.toLowerCase();
              if (c === 'abyss7') { const ti = LevelData.findIndex(l => l.thalasso); if (ti >= 0) buildLevel(ti, true); return true; }
              if (c === 'lol999') { draw(); lp.style.display = 'flex'; return true; }
              if (c === 'qwerty') { try { exitToMenu(); enterDebugRoom(); } catch (e) {} return true; } return false; };
          document.addEventListener('keydown', e => { if (MP.active || !GameState.isRunning || (LevelData[GameState.level] || {}).noLol || lp.style.display === 'flex' || !e.key || e.key.length !== 1) return; buf = (buf + e.key.toLowerCase()).slice(-6);
              if (buf === 'abyss7') { buf = ''; const ti = LevelData.findIndex(l => l.thalasso); if (ti >= 0) buildLevel(ti, true); return; }
            if (buf === 'lol999') { buf = ''; try { document.exitPointerLock(); } catch (x) {} draw(); lp.style.display = 'flex'; }
              if (buf.endsWith('qwerty')) { buf = ''; const idx = LevelData.findIndex(l => l.pools); if (idx >= 0) { showEventBanner('...', 0.1); buildLevel(idx); } } });
          document.getElementById('lol-close').addEventListener('click', () => { lp.style.display = 'none'; try { controls.lock(); } catch (x) {} }); }

        { const tips = ['Stay in the light. Watch your noise.', 'Cakes only appear where the party is.', 'Almond water restores sanity and stamina.', 'Something is always standing behind the Bacteria.', 'Map your own sounds with LOAD SOUND FILES.', 'A shop room waits before every level. Press the green button when you are ready.'];
          const tipEl = document.getElementById('menu-tip'); let ti = Math.floor(Math.random() * tips.length); const nextTip = () => { tipEl.style.opacity = 0; setTimeout(() => { tipEl.textContent = 'TIP: ' + tips[ti++ % tips.length]; tipEl.style.opacity = 1; }, 600); }; nextTip(); setInterval(nextTip, 7000);
          document.querySelectorAll('#start-screen .menu-btn').forEach(b => b.addEventListener('mouseenter', () => { if (AudioSys.ctx && AudioSys.ctx.state === 'running') AudioSys._t(900, 0.03, 'square', 0.035); }));
          document.getElementById('upd-btn').addEventListener('click', () => document.getElementById('upd-panel').style.display = 'flex');
          document.getElementById('upd-close').addEventListener('click', () => document.getElementById('upd-panel').style.display = 'none'); }

        // --- FPS COUNTER (ring buffer, DOM refreshed 4x/sec) ---
        const Fps = { buf: new Float32Array(120), i: 0, n: 0, on: localStorage.getItem('backrooms_fps') === '1', last: 0 };
        function fpsSample(ms) {
            if (ms <= 0 || ms > 1000) return;
            Fps.buf[Fps.i] = ms; Fps.i = (Fps.i + 1) % Fps.buf.length; Fps.n = Math.min(Fps.n + 1, Fps.buf.length);
            const now = performance.now();
            if (!Fps.on || now - Fps.last < 250) return;
            Fps.last = now;
            let sum = 0, worst = 0;
            for (let k = 0; k < Fps.n; k++) { sum += Fps.buf[k]; if (Fps.buf[k] > worst) worst = Fps.buf[k]; }
            const lastMs = Fps.buf[(Fps.i + Fps.buf.length - 1) % Fps.buf.length], avgMs = sum / Fps.n;
            document.getElementById('fps-display').textContent =
                `FPS  ${(1000 / lastMs).toFixed(0)}\nAVG  ${(1000 / avgMs).toFixed(0)}\nMIN  ${(1000 / worst).toFixed(0)}\nTIME ${lastMs.toFixed(1)} ms`;
        }
        function applyFpsVisibility() {
            document.getElementById('fps-display').style.display = (Fps.on && GameState.isRunning) ? 'block' : 'none';
            document.getElementById('pause-fps-btn').innerText = `FPS DISPLAY: ${Fps.on ? 'ON' : 'OFF'}`;
        }
        function toggleFps() {
            Fps.on = !Fps.on; Fps.n = 0; Fps.i = 0;
            localStorage.setItem('backrooms_fps', Fps.on ? '1' : '0');
            applyFpsVisibility();
        }

        // --- PAUSE SYSTEM ---
        function clearVRHands() { // items don't stick in your grip when you die, leave the level or pause
            ['left', 'right'].forEach(h => { const H = VR.held[h]; if (!H) return; const i = GameState.inv[H.slot];
                if (i) { const hp = VR.hand[h] && VR.hand[h].pp ? VR.hand[h].pp : new THREE.Vector3(0, 0, 0), ctl = VR.ctl.find(c => c.userData.src && c.userData.src.handedness === h); if (ctl) vrDrop(i.id, i.ammo, hp, new THREE.Vector3(), ctl); }
                VR.held[h] = null; });
            VR.sup = null;
        }
        function pauseGame() {
            if (!GameState.isRunning || GameState.isPaused || GameState.isJumpscaring) return;
            if (MP.active) { if (GameState.mpMenu) MP.softResume(); else MP.softPause(); return; } // multiplayer never freezes the world
            GameState.isPaused = true;
            clearVRHands();
            for (const k in keys) keys[k] = false;
            isDragging = false;
            try { controls.unlock(); } catch (e) {}
            if (AudioSys.ctx && AudioSys.ctx.state === 'running') AudioSys.ctx.suspend().catch(() => {});
            document.getElementById('pause-menu').style.display = 'flex';
            { const cm = document.getElementById('code-msg'); if (cm) { cm.style.color = '#9c9270'; cm.textContent = 'COINS: ' + Save.coins; } }
            applyFpsVisibility();
        }
        function resumeGame() {
            if (MP.active && GameState.mpMenu) { MP.softResume(); return; }
            if (!GameState.isPaused) return;
            document.getElementById('settings-modal').style.display = 'none';
            document.getElementById('settings-modal').classList.remove('in-game');
            document.getElementById('pause-menu').style.display = 'none';
            GameState.isPaused = false;
            GameState.lastFrameTime = performance.now(); // no dt spike after a long pause
            Fps.n = 0; Fps.i = 0;
            if (AudioSys.ctx && AudioSys.ctx.state === 'suspended') AudioSys.ctx.resume().catch(() => {});
            try { controls.lock(); } catch (e) {} // may be refused by the browser; click-to-relock is handled in mousedown
        }
        function exitToMenu() {
            if (MP.active) MP.leave();
            GameState.mpMenu = false; GameState.chatOpen = false;
            GameState.debugRoom = false;
            clearVRHands();
            GameState.isRunning = false; GameState.isPaused = false; GameState.isJumpscaring = false;
            try { controls.unlock(); } catch (e) {}
            document.getElementById('settings-modal').classList.remove('in-game');
            document.getElementById('settings-modal').style.display = 'none';
            ['pause-menu', 'ui-layer', 'vhs-hud', 'fps-display', 'jumpscare-flash'].forEach(id => document.getElementById(id).style.display = 'none');
            document.getElementById('chase-border').style.opacity = '0';
            document.getElementById('static-overlay').style.opacity = '0';
            document.body.style.filter = 'none';
            document.getElementById('start-screen').style.display = 'flex';
            if (AudioSys.ctx && AudioSys.ctx.state === 'suspended') AudioSys.ctx.resume().catch(() => {});
            refreshAchievementUI();
        }
        // Browsers release pointer lock on ESC (and sometimes on their own): treat any unexpected unlock mid-run as a pause.
        controls.addEventListener('unlock', () => {
            if (GameState.isRunning && !GameState.isPaused && !GameState.isJumpscaring && !GameState.shopOpen && !GameState.chatOpen && !GameState.mpMenu) pauseGame();
        });
        document.getElementById('pause-resume-btn').addEventListener('click', resumeGame);
        // One-time codes are remembered in Save.codes so they can never be redeemed twice.
        const ONE_TIME_CODES = { PPP999: 250 };
        Save.codes = ld('backrooms_codes', []);
        function redeemCode() {
            const i = document.getElementById('code-input'), m = document.getElementById('code-msg'), c = i.value.trim().toUpperCase(); if (!c) return;
            if (MP.active) { m.style.color = '#ff6a6a'; m.textContent = 'CODES ARE DISABLED IN MULTIPLAYER'; return; }
            const ok = (txt) => { m.style.color = '#7bff8a'; m.textContent = txt; i.value = ''; }, bad = (txt) => { m.style.color = '#ff6a6a'; m.textContent = txt; }; // wrong codes stay in the box so you can fix a typo
            if (c === 'LMAO111') { Save.coins += 5; sv('backrooms_coins', Save.coins); try { renderInv(); } catch (e) {} ok(c + ': +5 COINS  (TOTAL: ' + Save.coins + ')'); try { AudioSys.playCoin(); } catch (e) {} }
            else if (ONE_TIME_CODES[c]) {
                if (Save.codes.includes(c)) return bad(c + ': ALREADY REDEEMED');
                Save.codes.push(c); sv('backrooms_codes', Save.codes); Save.coins += ONE_TIME_CODES[c]; sv('backrooms_coins', Save.coins); try { renderInv(); } catch (e) {}
                ok(c + ': +' + ONE_TIME_CODES[c] + ' COINS  (TOTAL: ' + Save.coins + ')'); try { AudioSys.playCoin(); } catch (e) {}
            }
            else if (c === 'LMAO999') { if (!invAdd(GameState.inv, 'reality_shard')) return bad(c + ': INVENTORY FULL'); try { syncInventory(); } catch (e) {} ok(c + ': REALITY SHARD ADDED (SECRET ITEM)'); try { AudioSys.playSecretItem(); } catch (e) {} }
            else if (c === 'LSF455' && GameState.lsfOnly) { ok(c + ': OPENING SOUND FILES...'); SfxMap.open(); }
            else bad('INVALID CODE: ' + c);
        }
        // "Fix text": for browsers (seen on Opera GX) that fail to draw text typed into the styled box. Switches to a plain unstyled input,
        // turns off the blur filters behind it, and mirrors what you type in a normal text line underneath.
        {
            const inp = document.getElementById('code-input'), echo = document.getElementById('code-echo'), fb = document.getElementById('code-fix-btn'), pm = document.getElementById('pause-menu');
            const showEcho = () => { echo.textContent = inp.value ? 'TYPED: ' + inp.value.toUpperCase() : ''; };
            const applyFix = on => { inp.classList.toggle('plain', on); pm.classList.toggle('fixtext', on); fb.textContent = 'FIX TEXT: ' + (on ? 'ON' : 'OFF'); showEcho(); };
            applyFix(ld('backrooms_fix_text', false));
            fb.addEventListener('click', () => { const on = !pm.classList.contains('fixtext'); sv('backrooms_fix_text', on); applyFix(on); });
            inp.addEventListener('input', showEcho);
            document.getElementById('code-btn').addEventListener('click', () => setTimeout(showEcho, 0));
            inp.addEventListener('keydown', e => { if (e.key === 'Enter') setTimeout(showEcho, 0); });
        }
        document.getElementById('code-btn').addEventListener('click', redeemCode);
        ['keydown', 'keyup', 'keypress'].forEach(ev => document.getElementById('code-input').addEventListener(ev, e => { e.stopPropagation(); if (ev === 'keydown' && e.key === 'Enter') redeemCode(); }));
        document.getElementById('pause-fps-btn').addEventListener('click', toggleFps);
        document.getElementById('pause-menu-btn').addEventListener('click', () => { if ((LevelData[GameState.level] || {}).noLeave) return showEventBanner('THERE IS NO LEAVING.', 2); exitToMenu(); });
        document.getElementById('pause-gfx-btn').addEventListener('click', () => {
            const m = document.getElementById('settings-modal');
            m.classList.add('in-game'); m.style.display = 'flex';
            updateSettingsSummary();
        });
        // Re-render one frame after a graphics change so it shows while the loop is frozen.
        document.getElementById('settings-modal').addEventListener('click', () => {
            if (GameState.isPaused && renderer && !webglContextLost) renderMain();
        });
        document.getElementById('close-settings-btn').addEventListener('click', () => {
            document.getElementById('settings-modal').classList.remove('in-game');
        });

        // --- EVENT LISTENERS & FALLBACK MOUSE LOOK ---
        document.getElementById('start-btn').addEventListener('click', () => startGame());
        document.getElementById('restart-btn').addEventListener('click', () => startGame());
        document.getElementById('menu-btn').addEventListener('click', () => {
            AudioSys.playClick();
            document.getElementById('death-screen').style.display = 'none';
            document.getElementById('start-screen').style.display = 'flex';
            refreshAchievementUI();
        });

        let isDragging = false;
        let prevMouse = { x: 0, y: 0 };
        const UI_SEL = 'button, input, select, textarea, label, a, .dbg-modal, #shop-screen, #ach-modal, #settings-modal, #pause-menu, #sfx-panel, #upd-panel';
        document.addEventListener('mousedown', (e) => { // click inside the game = capture the mouse; never while paused or over a menu
            if (!GameState.isRunning || GameState.isPaused || GameState.shopOpen || GameState.mpMenu || GameState.chatOpen) return;
            if (controls.isLocked) { if (e.button === 0 && GameState.inv[GameState.invSel]) useSelected(); return; }
            if (e.target.closest && e.target.closest(UI_SEL)) return;
            try { controls.lock(); } catch (err) {}
            isDragging = true; prevMouse = { x: e.clientX, y: e.clientY };
        });
        controls.addEventListener('lock', () => { if (GameState.isPaused || GameState.shopOpen || GameState.mpMenu) { try { controls.unlock(); } catch (e) {} } });
        document.addEventListener('mouseup', () => { isDragging = false; });
        document.addEventListener('mousemove', (e) => {
            if (!GameState.isRunning || GameState.isPaused || controls.isLocked || !isDragging) return;
            const dx = e.clientX - prevMouse.x;
            const dy = e.clientY - prevMouse.y;
            prevMouse = { x: e.clientX, y: e.clientY };

            applyLook(dx * 2, dy * 2);
        });

        /* PATCH v0.6 */
// ===== v0.6: settings persistence, volume buses, alarm control, hunt tracking, turning, VHS =====
const VOLS = ['master', 'music', 'jump', 'sfx'];
const Settings = { loaded: false, vol: { master: 1, music: 1, jump: 1, sfx: 1 }, fx: { sn: false, st: true, tv: true, vhs: true }, real: false, nightmare: false };
function saveSettings() {
    if (!Settings.loaded) return;
    sv('backrooms_settings', { difficulty: GameState.difficulty, preset: GameState.graphicsPreset, graphics: GameState.graphics, mic: GameState.micEnabled, vol: Settings.vol, fx: Settings.fx, sens: LOOK.sens, real: Settings.real, nm: Settings.nightmare, v: 2 });
}
// ---- Real mode lens: render small (chunky pixels), then bend it into a body-cam dome ----
let realRT = null; const realScene = new THREE.Scene(), realCam = new THREE.Camera(), _rsz = new THREE.Vector2(), REAL_PIX = 0.5;
const realMat = new THREE.ShaderMaterial({ uniforms: { t: { value: null } }, depthTest: false, depthWrite: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D t; varying vec2 vUv;
        vec3 samp(vec2 p, float k){ vec2 s = p * (1.0 + k * dot(p, p)) / (1.0 + k); if (abs(s.x) > 1.0 || abs(s.y) > 1.0) return vec3(0.0); return texture2D(t, s * 0.5 + 0.5).rgb; }
        void main(){ vec2 p = vUv * 2.0 - 1.0; float r2 = dot(p, p);
            vec3 c = vec3(samp(p, 0.62).r, samp(p, 0.66).g, samp(p, 0.70).b);
            c *= 1.0 - 0.5 * smoothstep(0.3, 1.7, r2);
            gl_FragColor = vec4(c, 1.0);
            #include <tonemapping_fragment>
            #include <colorspace_fragment>
        }` });
{ const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), realMat); q.frustumCulled = false; realScene.add(q); }
function renderMain() {
    if (window.__vrOn) { const fg = scene.fog, d0 = fg && fg.density; if (fg && window.__vrFog) fg.density = d0 * window.__vrFog; renderer.render(scene, window.__vrCam); if (fg) fg.density = d0; return; }
    if (!window.realMode) return renderer.render(scene, camera);
    renderer.getDrawingBufferSize(_rsz); const w = Math.max(160, Math.round(_rsz.x * REAL_PIX)), h = Math.max(90, Math.round(_rsz.y * REAL_PIX));
    if (!realRT || realRT.width !== w || realRT.height !== h) {
        if (realRT) realRT.dispose(); const f = renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float');
        realRT = new THREE.WebGLRenderTarget(w, h, { type: f ? THREE.HalfFloatType : THREE.UnsignedByteType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true }); realMat.uniforms.t.value = realRT.texture;
    }
    renderer.setRenderTarget(realRT); renderer.render(scene, camera); renderer.setRenderTarget(null); renderer.render(realScene, realCam);
}
function applyReal() {
    const on = !!Settings.real;
    try { GameState._fov0 = GameState._fov0 || GameState.baseFov || camera.fov; GameState.baseFov = on ? Math.min(112, GameState._fov0 * 1.45) : GameState._fov0; camera.fov = GameState.baseFov; camera.updateProjectionMatrix(); } catch (e) {}
    try { window.realMode = on; applyVolumes(); } catch (e) {} window.realMode = on; document.body.classList.toggle('real', on);
    const v = on || GameState.graphics.vhsFx === 'on'; document.getElementById('vhs-scanlines').style.display = v ? 'block' : 'none'; document.body.classList.toggle('vhs-on', v);
}
function applyFx() { const c = document.body.classList; c.toggle('no-fx-static', !Settings.fx.st); c.toggle('no-fx-tv', !Settings.fx.tv); c.toggle('no-fx-vhs', !Settings.fx.vhs); }
function syncSettingsUI() {
    document.getElementById('sens-slider').value = Math.round(LOOK.sens * 10000); document.getElementById('sens-v').textContent = (LOOK.sens * 1000).toFixed(1);
    [['fx-sn', 'sn'], ['fx-st', 'st'], ['fx-tv', 'tv'], ['fx-vhs', 'vhs']].forEach(([id, k]) => { document.getElementById(id).checked = !!Settings.fx[k]; }); applyFx(); document.getElementById('real-cb').checked = !!Settings.real; applyReal(); document.getElementById('nm-cb').checked = !!Settings.nightmare;
    document.querySelectorAll('.diff-btn').forEach(b => b.classList.toggle('active', b.dataset.diff === GameState.difficulty));
    document.getElementById('mic-checkbox').checked = GameState.micEnabled;
    for (const k of VOLS) { const v = Math.round(Settings.vol[k] * 100); document.getElementById('vol-' + k).value = v; document.getElementById('vol-' + k + '-v').textContent = v + '%'; }
}
{
    const S = ld('backrooms_settings', null);
    if (S) {
        if (DifficultyConfigs[S.difficulty]) GameState.difficulty = S.difficulty;
        if (S.vol) for (const k of VOLS) if (typeof S.vol[k] === 'number') Settings.vol[k] = Math.max(0, Math.min(1, S.vol[k]));
        if (S.preset === 'custom' && S.graphics) { GameState.graphicsPreset = 'custom'; GameState.graphics = { ...GameState.graphics, ...S.graphics }; }
        else if (GraphicsPresets[S.preset]) { GameState.graphicsPreset = S.preset; GameState.graphics = { ...GraphicsPresets[S.preset] }; }
        GameState.micEnabled = !!S.mic;
        if (S.fx) Object.assign(Settings.fx, S.fx); if (typeof S.sens === 'number') LOOK.sens = Math.max(0.0005, Math.min(0.006, S.sens));
    }
    if (S) { Settings.real = !!S.real; Settings.nightmare = !!S.nm; if ((S.v || 1) < 2) Settings.fx.sn = false; } // settings v2: Static noise is OFF unless chosen after this update
    syncSettingsUI();
    document.getElementById('nm-cb').addEventListener('change', e => { Settings.nightmare = e.target.checked; saveSettings(); });
    { const rc = document.getElementById('real-cb'); rc.addEventListener('change', e => { Settings.real = e.target.checked; applyReal(); saveSettings(); }); }
    { const sl = document.getElementById('sens-slider'); sl.addEventListener('input', e => { LOOK.sens = e.target.value / 10000; document.getElementById('sens-v').textContent = (LOOK.sens * 1000).toFixed(1); saveSettings(); }); }
    [['fx-sn', 'sn'], ['fx-st', 'st'], ['fx-tv', 'tv'], ['fx-vhs', 'vhs']].forEach(([id, k]) => document.getElementById(id).addEventListener('change', e => { Settings.fx[k] = e.target.checked; applyFx(); saveSettings(); }));
    VOLS.forEach(k => document.getElementById('vol-' + k).addEventListener('input', e => {
        Settings.vol[k] = e.target.value / 100; document.getElementById('vol-' + k + '-v').textContent = e.target.value + '%'; applyVolumes(); saveSettings();
    }));
    Settings.loaded = true;
}

// Audio buses: masterGain stays the SFX bus (all existing code keeps working); music + jumpscare get their own buses; all feed a master gain.
function applyVolumes() {
    const A = AudioSys; if (!A.ctx || !A.outGain) return; const t = A.ctx.currentTime, V = Settings.vol;
    A.outGain.gain.setTargetAtTime(V.master, t, 0.03); A.musicBus.gain.setTargetAtTime(window.realMode ? 0 : V.music, t, 0.03);
    A.jumpBus.gain.setTargetAtTime(V.jump, t, 0.03); A.masterGain.gain.setTargetAtTime(0.95 * V.sfx, t, 0.03);
}
function buildBuses() {
    const A = AudioSys, c = A.ctx; A.outGain = c.createGain(); A.musicBus = c.createGain(); A.jumpBus = c.createGain();
    try { A.masterGain.disconnect(); } catch (e) {}
    A.masterGain.connect(A.outGain); A.musicBus.connect(A.outGain); A.jumpBus.connect(A.outGain); A.outGain.connect(A.compressor); applyVolumes();
}
Sfx.busFor = id => { const A = AudioSys; return /^(chase_music|ambience)/.test(id) ? (A.musicBus || A.masterGain) : id === 'jumpscare' ? (A.jumpBus || A.masterGain) : A.masterGain; };

// Alarm clock: rings ONCE; stopped by jumpscare, death, pause, menu exit or the clock being destroyed.
function stopAlarm() { const a = GameState.alarmSrc; GameState.alarmSrc = null; if (a) { try { a.stop(); } catch (e) {} } }
AudioSys.playAlarm = () => {
    stopAlarm(); if (!AudioSys.ctx) return; AudioSys.ensureReady();
    if (Sfx.buf.alarm_clock) { GameState.alarmSrc = Sfx.play('alarm_clock', SFX_REG.alarm_clock.v, 1); return; }
    const c = AudioSys.ctx, g = c.createGain(), t = c.currentTime; g.connect(AudioSys.masterGain);
    for (let i = 0; i < 8; i++) { const o = c.createOscillator(), og = c.createGain(); o.type = 'square'; o.frequency.value = 1400; og.gain.value = 0.15; o.connect(og); og.connect(g); o.start(t + i * 0.3); o.stop(t + i * 0.3 + 0.13); }
    GameState.alarmSrc = { stop() { try { g.disconnect(); } catch (e) {} } };
};
{
    const _tj = triggerJumpscare; triggerJumpscare = function (e) { stopAlarm(); return _tj(e); };
    const _pg = pauseGame; pauseGame = function () { stopAlarm(); return _pg(); };
    const _ur = unloadRun; unloadRun = function () { stopAlarm(); return _ur(); };
    const _em = exitToMenu; exitToMenu = function () { stopAlarm(); return _em(); };
}

// ===================== 3D POSITIONAL AUDIO =====================
// Usage: AudioSys.at(worldPosition).playSomething(...)  -> plays from that point in the world.
//        AudioSys.playSomething(...)                    -> unchanged, plays flat (2D) as before.
//
// VOLUME MODEL (all distances are world units; one maze cell = GameState.cellSize = 4):
//   d <= ref            : full volume (1.0)
//   ref < d < max       : gain = (1 - (d - ref) / (max - ref)) ^ roll       (roll 1 = linear, 2 = quadratic, ...)
//   d >= max            : silent (the sound is skipped entirely, no audio nodes are created)
// OCCLUSION: the straight line source -> listener is walked across the maze grid. Every wall cell it crosses
//   multiplies gain by OCC_GAIN[n] and drops a low-pass filter to OCC_CUT[n] Hz (muffled through walls).
// DIRECTION: a PannerNode (HRTF) driven by the camera position/orientation puts it left/right/behind you.
//   The panner's own distance attenuation is turned off (rolloffFactor 0) so the model above is the only volume curve.
// Tune everything in Spatial.specs (also reachable from the console as window.Spatial). Spatial.debug = true logs every call.
const Spatial = {
    enabled: true, occlusion: true, debug: false, next: null, lp: new THREE.Vector3(),
    OCC_GAIN: [1, 0.6, 0.4, 0.28], OCC_CUT: [20000, 2200, 900, 500],
    specs: {
        //                  ref   max   roll  occl   life(ms)  fix(args)
        playSpark:        { ref: 3,  max: 28,  roll: 2.0, occl: true,  life: 4000,  fix: a => { a[0] = 0; } },
        playMonsterSound: { ref: 4,  max: 40,  roll: 1.5, occl: true,  life: 6000,  fix: a => { a[1] = 0; } },
        playFakeBurst:    { ref: 4,  max: 32,  roll: 1.5, occl: true,  life: 4000 },
        playTableThrow:   { ref: 4,  max: 36,  roll: 1.5, occl: true,  life: 4000 },
        playTableSmash:   { ref: 4,  max: 36,  roll: 1.5, occl: true,  life: 5000 },
        playAlarm:        { ref: 5,  max: 70,  roll: 1.2, occl: true,  life: 30000 },
        playDrip:         { ref: 2,  max: 22,  roll: 2.0, occl: false, life: 4000 },
        playLeviathan:    { ref: 20, max: 110, roll: 1.0, occl: false, life: 9000 }
    },
    gain(d, sp) { return d <= sp.ref ? 1 : d >= sp.max ? 0 : Math.pow(1 - (d - sp.ref) / (sp.max - sp.ref), sp.roll); },
    walls(a, b) { // wall cells between two points on the maze grid
        const g = GameState.grid, cs = GameState.cellSize; if (!g) return 0;
        const dx = b.x - a.x, dz = b.z - a.z, steps = Math.ceil(Math.hypot(dx, dz) / (cs * 0.25));
        let n = 0, last = '';
        for (let i = 1; i < steps; i++) {
            const gx = Math.round((a.x + dx * i / steps) / cs), gz = Math.round((a.z + dz * i / steps) / cs), k = gx + ',' + gz;
            if (k === last) continue; last = k;
            if (g[gz] && g[gz][gx] === 1) n++;
        }
        return n;
    },
    _f: new THREE.Vector3(), _u: new THREE.Vector3(), _q: new THREE.Quaternion(),
    updateListener() {
        const c = AudioSys.ctx; if (!c || !camera) return;
        camera.updateWorldMatrix(true, false); camera.getWorldPosition(this.lp); camera.getWorldDirection(this._f);
        this._u.set(0, 1, 0).applyQuaternion(camera.getWorldQuaternion(this._q));
        const L = c.listener, p = this.lp, f = this._f, u = this._u;
        if (L.positionX) { L.positionX.value = p.x; L.positionY.value = p.y; L.positionZ.value = p.z; L.forwardX.value = f.x; L.forwardY.value = f.y; L.forwardZ.value = f.z; L.upX.value = u.x; L.upY.value = u.y; L.upZ.value = u.z; }
        else { L.setPosition(p.x, p.y, p.z); L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z); }
    },
    wrap(name) {
        const orig = AudioSys[name], sp = this.specs[name]; if (!orig || !sp) return;
        AudioSys[name] = function (...a) {
            const pos = Spatial.next; Spatial.next = null;
            const c = AudioSys.ctx;
            if (!pos || !Spatial.enabled || !c) return orig.apply(AudioSys, a);   // no position given -> classic flat sound
            Spatial.updateListener();
            const d = Spatial.lp.distanceTo(pos); let g = Spatial.gain(d, sp), n = 0, cut = 20000;
            if (sp.occl && Spatial.occlusion) { n = Math.min(3, Spatial.walls(pos, Spatial.lp)); g *= Spatial.OCC_GAIN[n]; cut = Spatial.OCC_CUT[n]; }
            if (Spatial.debug) console.log('[3D audio]', name, 'dist', d.toFixed(1), 'walls', n, 'gain', g.toFixed(3));
            if (g < 0.004) return;                                                // inaudible: don't even build the sound
            const inp = c.createGain(), lp = c.createBiquadFilter(), vg = c.createGain(), pan = c.createPanner(), real = AudioSys.masterGain;
            lp.type = 'lowpass'; lp.frequency.value = cut; vg.gain.value = g;
            pan.panningModel = 'HRTF'; pan.distanceModel = 'inverse'; pan.refDistance = 1; pan.rolloffFactor = 0; pan.maxDistance = 100000;
            if (pan.positionX) { pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z; } else pan.setPosition(pos.x, pos.y, pos.z);
            inp.connect(lp); lp.connect(vg); vg.connect(pan); pan.connect(real);
            setTimeout(() => { try { inp.disconnect(); lp.disconnect(); vg.disconnect(); pan.disconnect(); } catch (e) {} }, sp.life || 6000);
            AudioSys.masterGain = inp;                                            // everything the sound routes to "master" now goes through the 3D chain
            try { if (sp.fix) sp.fix(a); return orig.apply(AudioSys, a); } finally { AudioSys.masterGain = real; }
        };
    }
};
AudioSys.at = function (pos) { Spatial.next = pos; queueMicrotask(() => { Spatial.next = null; }); return AudioSys; };
Object.keys(Spatial.specs).forEach(n => Spatial.wrap(n));
setInterval(() => { if (GameState.isRunning && !GameState.isPaused && AudioSys.ctx) Spatial.updateListener(); }, 40);
window.Spatial = Spatial;

// Hunt tracking: you stay "in a chase" while anything is chasing, frozen by your light, or heading for your last known position.
function trackHunt(e, dt) {
    if (e.stunTimer > 0) return; const s = e._s0 || e.state;
    if (s === 'chase' || s === 'light_freeze' || s === 'lunge' || s === 'swarm') { e._hunt = 1; e._huntT = 3; }
    else { e._huntT = Math.max(0, (e._huntT || 0) - dt); if (e._hunt && e._huntT <= 0 && !(e.state === 'investigate' && e.investigateTimer > 0)) e._hunt = 0; }
}
function isHunting(e) { return e.stunTimer <= 0 && !!e._hunt && (e._huntT > 0 || e.state === 'chase' || e.state === 'investigate'); }
function holdChase(on, dt) { GameState._ch = on ? 5 : Math.max(0, (GameState._ch || 0) - dt); return GameState._ch > 0; }

// Limited turn speed (rad/s) instead of instantly facing the target.
function turnTo(m, dx, dz, dt, rate) {
    const target = Math.atan2(dx, dz), cur = m.rotation.y, d = Math.atan2(Math.sin(target - cur), Math.cos(target - cur)), s = rate * dt;
    m.rotation.y = cur + Math.max(-s, Math.min(s, d));
}
// Smiler: replace the always-facing sprite with a plane that actually rotates.
function smilerPlane(e) {
    if (e.type !== 'smiler') return; const spr = e.mesh.children.find(o => o.isSprite); if (!spr) return;
    const mat = new THREE.MeshBasicMaterial({ map: spr.material.map, transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.15), mat), v = new THREE.Vector3(); pl.position.copy(spr.position);
    pl.onBeforeRender = (r, sc, cam) => { if (cam !== camera) { mat.opacity = 0.7; return; } const d = pl.getWorldPosition(v).distanceTo(cam.position); mat.opacity = Math.max(0, Math.min(1, (16 - d) / 10)) * (Math.random() < 0.04 ? 0.35 : 1); };
    e.mesh.remove(spr); e.mesh.add(pl);
}

// VHS: very quiet tape hiss (always capped by the compressor) + occasional tracking glitch (sound + picture).
function vhsGlitch() { const c = renderer && renderer.domElement; if (!c) return; c.classList.remove('vhs-glitch'); void c.offsetWidth; c.classList.add('vhs-glitch'); setTimeout(() => c.classList.remove('vhs-glitch'), 260); }
const VhsAudio = { g: null, next: 0,
    ensure() { const A = AudioSys, c = A.ctx; if (this.g || !c || !A.noiseBuffer) return;
        const s = c.createBufferSource(), hp = c.createBiquadFilter(), g = c.createGain(); s.buffer = A.noiseBuffer; s.loop = true; hp.type = 'highpass'; hp.frequency.value = 3200; g.gain.value = 0;
        s.connect(hp); hp.connect(g); g.connect(A.masterGain); s.start(); this.g = g; },
    set(on) { if (Sfx.buf.vhs_hiss) { Sfx.setLoop('vhs_hiss', !!on); if (this.g) this.g.gain.value = 0; return; } if (!this.g) return; this.g.gain.setTargetAtTime(on ? 0.025 : 0, AudioSys.ctx.currentTime, 0.4); },
    glitch() { if (!Settings.fx.sn) { if (Settings.fx.tv) vhsGlitch(); return; } if (Sfx.buf.vhs_glitch) { Sfx.play('vhs_glitch', 0.5); if (Settings.fx.tv) vhsGlitch(); return; } const c = AudioSys.ctx, t = c.currentTime, s = c.createBufferSource(), bp = c.createBiquadFilter(), g = c.createGain();
        s.buffer = AudioSys.noiseBuffer; bp.type = 'bandpass'; bp.frequency.value = 1400 + Math.random() * 1800; bp.Q.value = 0.8;
        g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.07, t + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        s.connect(bp); bp.connect(g); g.connect(AudioSys.masterGain); s.start(t, Math.random() * 0.5, 0.25); if (Settings.fx.tv) vhsGlitch(); } };
setInterval(() => {
    const on = GameState.isRunning && !GameState.isPaused && GameState.graphics.vhsFx === 'on' && AudioSys.ctx && AudioSys.ctx.state === 'running' && AudioSys.noiseBuffer;
    if (on) VhsAudio.ensure(); VhsAudio.set(!!on && Settings.fx.sn);
    if (on && VhsAudio.g && performance.now() > VhsAudio.next) { VhsAudio.next = performance.now() + (7000 + Math.random() * 11000) * (GameState.player.sanity < 40 ? 0.4 : 1); VhsAudio.glitch(); }
    if (window.realMode && GameState.isRunning && !GameState.isPaused && !on && performance.now() > (VhsAudio.nextV || 0)) { VhsAudio.nextV = performance.now() + 7000 + Math.random() * 9000; if (Settings.fx.tv) vhsGlitch(); }
    const gr = document.getElementById('vhs-grain'); if (gr) gr.style.opacity = (0.14 + Math.max(0, 70 - GameState.player.sanity) * 0.004).toFixed(3);
}, 300);
{ const cv = document.getElementById('vhs-grain'), cx = cv.getContext('2d'), id = cx.createImageData(160, 90), d = id.data;
  setInterval(() => { if (!document.body.classList.contains('vhs-on')) return; for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = (Math.random() * 255) | 0; d[i + 3] = 255; } cx.putImageData(id, 0, 0); }, 66); }

// HUD bar readouts + low-value pulse
setInterval(() => { if (!GameState.isRunning) return; const P = GameState.player;
    [['stamina', P.stamina], ['sanity', P.sanity / PermaFx.maxSan() * 100], ['battery', P.battery]].forEach(([k, v]) => { const el = document.getElementById(k + '-container'); el.dataset.v = Math.round(v) + '%'; el.classList.toggle('low', v < 25); }); }, 150);


        // Initial Menu State Setup
        applyGraphicsSettings();
        refreshAchievementUI();
        updateSettingsSummary();
        importLegacyAch(); applyFpsVisibility(); renderInv();
        // ===== Wood + chest textures, chests, breakable crates, loot =====
        const _wt = {};
        function woodTex(kind) {
            if (_wt[kind]) return _wt[kind];
            const c = document.createElement('canvas'); c.width = c.height = 256; const x = c.getContext('2d'), cols = ['#8a5a2b', '#7a4e24', '#93602e', '#80542a'];
            const plank = (px, py, pw, ph, base) => {
                x.fillStyle = base; x.fillRect(px, py, pw, ph);
                for (let i = 0; i < 26; i++) { const gy = py + Math.random() * ph; x.strokeStyle = `rgba(${40 + Math.random() * 30 | 0},${20 + Math.random() * 15 | 0},8,${0.12 + Math.random() * 0.2})`; x.lineWidth = 0.6 + Math.random() * 1.6; x.beginPath(); x.moveTo(px, gy); for (let k = 0; k <= pw; k += 16) x.lineTo(px + k, gy + Math.sin(k * 0.07 + i) * 2.2); x.stroke(); }
                if (Math.random() < 0.5) { const kx = px + 20 + Math.random() * Math.max(1, pw - 40), ky = py + 8 + Math.random() * Math.max(1, ph - 16); x.fillStyle = 'rgba(50,25,8,.7)'; x.beginPath(); x.ellipse(kx, ky, 6, 3.5, 0, 0, 7); x.fill(); x.strokeStyle = 'rgba(60,30,10,.4)'; x.beginPath(); x.ellipse(kx, ky, 10, 6, 0, 0, 7); x.stroke(); }
                x.fillStyle = 'rgba(20,10,4,.85)'; x.fillRect(px, py + ph - 2, pw, 2); x.fillRect(px, py, pw, 1);
            };
            const nail = (nx, ny) => { x.fillStyle = '#2a2a2a'; x.beginPath(); x.arc(nx, ny, 3, 0, 7); x.fill(); x.fillStyle = '#888'; x.beginPath(); x.arc(nx - 1, ny - 1, 1.2, 0, 7); x.fill(); };
            const band = (bx, by, bw, bh) => { const g = x.createLinearGradient(bx, by, bx + bw, by + bh); g.addColorStop(0, '#555c63'); g.addColorStop(0.5, '#8b939a'); g.addColorStop(1, '#444a50'); x.fillStyle = g; x.fillRect(bx, by, bw, bh); x.strokeStyle = '#22262a'; x.lineWidth = 1.5; x.strokeRect(bx, by, bw, bh); };
            if (kind === 'wood') for (let i = 0; i < 4; i++) plank(0, i * 64, 256, 64, cols[i]);
            else if (kind === 'crate') {
                for (let i = 0; i < 4; i++) plank(i * 64, 0, 64, 256, cols[i]); band(0, 0, 256, 24); band(0, 232, 256, 24);
                x.save(); x.translate(128, 128); x.rotate(0.78); plank(-170, -17, 340, 34, '#6f4421'); x.restore(); [[12, 12], [244, 12], [12, 244], [244, 244], [128, 12], [128, 244]].forEach(([a, b]) => nail(a, b));
            } else {
                for (let i = 0; i < 4; i++) plank(0, i * 64, 256, 64, cols[i]); band(30, 0, 30, 256); band(196, 0, 30, 256);
                [[45, 14], [45, 242], [211, 14], [211, 242], [45, 128], [211, 128]].forEach(([a, b]) => nail(a, b));
                if (kind === 'chest_front') { band(100, 74, 56, 66); x.fillStyle = '#d9a82c'; x.fillRect(106, 80, 44, 54); x.fillStyle = '#111'; x.beginPath(); x.arc(128, 100, 6, 0, 7); x.fill(); x.fillRect(125, 100, 6, 18); nail(110, 84); nail(146, 84); nail(110, 130); nail(146, 130); }
            }
            const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.colorSpace = THREE.SRGBColorSpace; return _wt[kind] = t;
        }
        function buildCrateModel(size) {
            const m = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), new THREE.MeshStandardMaterial({ map: woodTex('crate'), roughness: 0.85 }));
            m.userData.crate = true; return m;
        }
        function buildChestModel() {
            const side = new THREE.MeshStandardMaterial({ map: woodTex('chest_body'), roughness: 0.8 }), front = new THREE.MeshStandardMaterial({ map: woodTex('chest_front'), roughness: 0.75 }), top = new THREE.MeshStandardMaterial({ map: woodTex('chest_lid'), roughness: 0.8 });
            const dark = new THREE.MeshStandardMaterial({ color: 0x1a0f06, roughness: 1 }), topD = top.clone(), sideD = side.clone(); topD.side = sideD.side = THREE.DoubleSide;
            const g = new THREE.Group(), body = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.5, 0.6), [side, side, dark, side, front, side]); body.position.y = 0.25; g.add(body);
            const pivot = new THREE.Group(); pivot.position.set(0, 0.5, -0.3); g.add(pivot);
            const lid = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.95, 18, 1, false, 0, Math.PI), [topD, sideD, sideD]); lid.rotation.z = Math.PI / 2; lid.position.set(0, 0, 0.3); pivot.add(lid);
            const clasp = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.03), new THREE.MeshStandardMaterial({ color: 0xd9a82c, metalness: 0.8, roughness: 0.3 })); clasp.position.set(0, 0.0, 0.6); pivot.add(clasp);
            return { group: g, lid: pivot, lidMesh: lid };
        }
        function pickWeighted(t) { let r = Math.random() * t.reduce((a, b) => a + b[0], 0); for (const e of t) { r -= e[0]; if (r <= 0) return e[1]; } return t[0][1]; }
        // Loot odds - tune here. Chests: chance of 1, plus a small extra chance of a 2nd. Crates: min + random(0..crateRand-1) + bonus chance of one more. Floor: chance per level.
        const LootCfg = { chestChance: 0.55, chestExtra: 0.06, crateMin: 2, crateRand: 4, crateBonus: 0.3, floorCrowbar: 0.07, floorLocator: 0.05, floorGrenade: 0.04 };
        const CHEST_LOOT = [
            [14, [['shotgun', 1], ['ammo_crate', 1], ['water', 2]]], [14, [['water', 4], ['mega_battery', 1]]], [14, [['water', 2], ['shell', 1], ['shotgun', 1, 0]]], [16, [['battery', 3], ['water', 2]]],
            [34, [['crowbar', 1]]], [14, [['ammo_crate', 1], ['shotgun', 1]]], [12, [['cake', 2]]], [2.5, [['lucid_pill', 1], ['shotgun', 1]]], [12, [['axe', 1]]], [4, [['grenade', 1]]]
        ];
        const CRATE_LOOT = [[6, [['chest_locator', 1]]], [30, [['shell', 1]]], [7, [['ammo_crate', 1]]], [25, [['water', 2]]], [1.2, [['mega_battery', 1]]], [22, [['battery', 1]]], [10, [['tracker', 1]]], [3, [['axe', 1]]], [2.5, [['grenade', 1]]]];
        function spawnLoot(list, x, y, z, fx, fz) { // list = [[id, count, ammo?]...]; fx,fz = direction items pop towards
            const flat = []; list.forEach(([id, n, am]) => { for (let i = 0; i < n; i++) flat.push([id, am]); });
            flat.forEach(([id, am], i) => {
                const lat = (i - (flat.length - 1) / 2) * 0.32, ox = x + fx * 0.55 - fz * lat, oz = z + fz * 0.55 + fx * lat;
                spawnPickup(id, ox, oz); const m = GameState.items[GameState.items.length - 1].mesh; if (id === 'shotgun') GameState.shotgunSpawnedInWorld = true; if (id === 'tracker') GameState.trackerInWorld = true;
                if (am != null) m.userData.ammo = am;
                if (window.__vrOn) { m.position.set(x, y, z); m.userData.ph = { v: new THREE.Vector3(fx * 1.2 + (Math.random() - 0.5) * 0.6 - fz * lat * 2, 2.6 + Math.random(), fz * 1.2 + (Math.random() - 0.5) * 0.6 + fx * lat * 2), w: new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6), r: 0.12, sleep: false }; }
            });
        }
        function openChest(ch) {
            if (ch.open) return; ch.open = true; ch.t = 0; try { AudioSys.playChest(); } catch (e) {}
        }
        // ===== SHOTGUN FX: visible pellet paths + a real muzzle flash (desktop and VR) =====
        const ShotFx = { slots: [], tmp: [], flash: null, cone: null, light: null, ft: 0, ready: false, tex: {} }, _SY = new THREE.Vector3(0, 1, 0);
        function shotTex(kind) {
            if (ShotFx.tex[kind]) return ShotFx.tex[kind]; const cv = document.createElement('canvas'); cv.width = cv.height = 128; const c = cv.getContext('2d'), g = c.createRadialGradient(64, 64, 0, 64, 64, 62);
            if (kind === 'smoke') { g.addColorStop(0, 'rgba(170,170,170,.55)'); g.addColorStop(1, 'rgba(120,120,120,0)'); c.fillStyle = g; c.fillRect(0, 0, 128, 128); }
            else { g.addColorStop(0, 'rgba(255,255,235,1)'); g.addColorStop(0.2, 'rgba(255,214,120,.95)'); g.addColorStop(0.55, 'rgba(255,120,30,.45)'); g.addColorStop(1, 'rgba(255,60,0,0)'); c.fillStyle = g; c.fillRect(0, 0, 128, 128);
                if (kind === 'flash') { c.translate(64, 64); c.fillStyle = 'rgba(255,230,160,.9)'; for (let i = 0; i < 8; i++) { c.rotate(Math.PI / 4); c.beginPath(); c.moveTo(0, -4); c.lineTo(i % 2 ? 30 : 62, 0); c.lineTo(0, 4); c.fill(); } } }
            return ShotFx.tex[kind] = new THREE.CanvasTexture(cv);
        }
        function shotFxInit() {
            if (ShotFx.ready) return; ShotFx.ready = true; const cyl = new THREE.CylinderGeometry(1, 1, 1, 5, 1, true), add = col => new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
            const mk = (r, col) => { const m = new THREE.Mesh(cyl, add(col)); m.scale.set(r, 1, r); m.frustumCulled = false; m.visible = false; return m; };
            for (let i = 0; i < 27; i++) ShotFx.slots.push({ path: mk(0.011, 0xffb347), head: mk(0.03, 0xfff2c8), on: false });
            ShotFx.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: shotTex('flash'), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false })); ShotFx.flash.visible = false; ShotFx.flash.renderOrder = 997;
            ShotFx.cone = new THREE.Mesh(new THREE.ConeGeometry(0.5, 1, 10, 1, true), new THREE.MeshBasicMaterial({ color: 0xff9a2a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false })); ShotFx.cone.visible = false;
            ShotFx.light = new THREE.PointLight(0xffa24a, 0, 18, 1.4); camera.add(ShotFx.light); // one permanent light (intensity 0 until a shot): never added/removed, so no shader recompiles
        }
        function shotTrace(o, d, maxD) { // where does a pellet stop? walls, floor, ceiling, crates / furniture boxes, monsters
            const g = GameState.grid, cs = GameState.cellSize, ceil = (LevelData[GameState.level] || {}).ceilH || 4, deep = !!GameState.poolFl, cl = GameState.colliders || []; let t = maxD, kind = null;
            for (let s = 0.3; s < maxD; s += 0.25) {
                const x = o.x + d.x * s, y = o.y + d.y * s, z = o.z + d.z * s;
                if (y > ceil || (!deep && y < 0.02)) { t = s; kind = 'wall'; break; }
                const gx = Math.round(x / cs), gz = Math.round(z / cs); if (g[gz] && g[gz][gx] === 1) { t = s; kind = 'wall'; break; }
                let hit = false; for (const c of cl) { const dx = x - c.x, dz = z - c.z; if (dx * dx + dz * dz > c.r * c.r || y > c.h) continue; if (Math.abs(c.cos * dx - c.sin * dz) <= c.hw && Math.abs(c.sin * dx + c.cos * dz) <= c.hd) { hit = true; break; } }
                if (hit) { t = s; kind = 'wall'; break; }
            }
            for (const e of GameState.entities || []) { const cx = e.mesh.position.x - o.x, cy = e.mesh.position.y + 1.2 - o.y, cz = e.mesh.position.z - o.z, tca = cx * d.x + cy * d.y + cz * d.z; if (tca <= 0 || tca >= t) continue; const d2 = cx * cx + cy * cy + cz * cz - tca * tca; if (d2 < 0.64) { const th = tca - Math.sqrt(0.64 - d2); if (th > 0 && th < t) { t = th; kind = 'ent'; } } }
            return { t, kind };
        }
        function shotSprite(kind, pos, life, s0, s1, delay, vel) {
            const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: shotTex(kind), transparent: true, blending: kind === 'smoke' ? THREE.NormalBlending : THREE.AdditiveBlending, depthWrite: false, fog: false })); sp.position.copy(pos); sp.visible = delay <= 0; scene.add(sp);
            ShotFx.tmp.push({ sp, age: -delay, life, s0, s1, vel, kind });
        }
        function shotFxFire(o, aim) {
            shotFxInit(); const S = ShotFx; [S.flash, S.cone].forEach(m => { if (m.parent !== scene) scene.add(m); });
            const upv = Math.abs(aim.y) > 0.95 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), rt = new THREE.Vector3().crossVectors(aim, upv).normalize(), uu = new THREE.Vector3().crossVectors(rt, aim).normalize(), free = S.slots.filter(s => !s.on);
            for (let i = 0; i < 9 && i < free.length; i++) { // 9 pellets: one dead centre + 8 spread in a ~3.5 degree cone
                const a = Math.random() * 6.283, r = i ? Math.sqrt(Math.random()) * 0.06 : 0, d = aim.clone().addScaledVector(rt, Math.cos(a) * r).addScaledVector(uu, Math.sin(a) * r).normalize(), hit = shotTrace(o, d, 45), s = free[i];
                s.on = true; s.o = o.clone(); s.d = d; s.T = hit.t; s.age = 0; s.path.quaternion.setFromUnitVectors(_SY, d); s.head.quaternion.copy(s.path.quaternion);
                [s.path, s.head].forEach(m => { if (m.parent !== scene) scene.add(m); m.visible = true; });
                if (hit.kind) { const hp = o.clone().addScaledVector(d, hit.t), dl = hit.t / 160; if (hit.kind === 'wall') { const c = crateAt(hp, 0.12); if (c) breakCrate(c); } shotSprite('spark', hp, 0.18, 0.25, hit.kind === 'ent' ? 0.9 : 0.7, dl); if (hit.kind === 'wall' && i < 4) shotSprite('smoke', hp, 0.7, 0.2, 0.7, dl, new THREE.Vector3(0, 0.5, 0)); }
            }
            S.ft = 0.1; S.flash.position.copy(o).addScaledVector(aim, 0.06); S.cone.position.copy(o).addScaledVector(aim, 0.42); S.cone.quaternion.setFromUnitVectors(_SY, aim.clone().negate()); S.cone.scale.set(0.5, 0.85, 0.5); S.flash.visible = S.cone.visible = true;
            for (let i = 0; i < 4; i++) shotSprite('smoke', o.clone().addScaledVector(aim, 0.3 + i * 0.12), 1.1, 0.18, 0.8, 0, aim.clone().multiplyScalar(1.4 - i * 0.25).add(new THREE.Vector3((Math.random() - 0.5) * 0.4, 0.45, (Math.random() - 0.5) * 0.4)));
            camera.updateWorldMatrix(true, false); S.light.position.copy(camera.worldToLocal(o.clone().addScaledVector(aim, 0.25)));
        }
        function shotFxTick(dt) {
            const S = ShotFx; if (!S.ready) return;
            for (const s of S.slots) {
                if (!s.on) continue; s.age += dt; const SPD = 160, trav = s.age * SPD, h = Math.min(s.T, trav), done = trav >= s.T, since = done ? s.age - s.T / SPD : 0;
                if (since > 0.5) { s.on = false; s.path.visible = s.head.visible = false; continue; }
                s.path.position.copy(s.o).addScaledVector(s.d, h / 2); s.path.scale.y = Math.max(0.001, h); s.path.material.opacity = 0.6 * Math.max(0, 1 - s.age / (s.T / SPD + 0.5)); // the whole path stays visible, fading out
                const a = Math.max(0, h - 1.8); s.head.position.copy(s.o).addScaledVector(s.d, (a + h) / 2); s.head.scale.y = Math.max(0.001, h - a); s.head.material.opacity = done ? Math.max(0, 1 - since / 0.1) : 1; // bright streak = the pellet itself
            }
            for (let i = S.tmp.length - 1; i >= 0; i--) {
                const t = S.tmp[i]; t.age += dt; if (t.age >= t.life) { scene.remove(t.sp); t.sp.material.dispose(); S.tmp.splice(i, 1); continue; } if (t.age < 0) continue;
                t.sp.visible = true; const k = t.age / t.life; t.sp.scale.setScalar(t.s0 + (t.s1 - t.s0) * k); t.sp.material.opacity = t.kind === 'smoke' ? 0.5 * (1 - k) : 1 - k; if (t.vel) t.sp.position.addScaledVector(t.vel, dt * (1 - k * 0.6));
            }
            if (S.ft > 0) { S.ft -= dt; const k = Math.max(0, S.ft / 0.1); S.flash.scale.setScalar(0.5 + 1.1 * (1 - k)); S.flash.material.opacity = k; S.cone.material.opacity = 0.85 * k; S.light.intensity = 34 * k * k; if (S.ft <= 0) { S.flash.visible = S.cone.visible = false; S.light.intensity = 0; } }
        }
        // ===== CHEST LOCATOR: a glowing arrow floats over the nearest unopened chest (seen through walls) until you are within 30m or change level =====
        function clearLocArrow() { const a = GameState.locArrow; if (a) { if (a.m.parent) a.m.parent.remove(a.m); a.m.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); } GameState.locArrow = null; }
        function chestLocate(it) {
            const p = controls.getObject().position; let best = null, bd = 1e9;
            for (const c of GameState.chests || []) if (!c.open) { const d = Math.hypot(p.x - c.x, p.z - c.z); if (d < bd) { bd = d; best = c; } }
            const say = (msg, ms = 2600) => { showEventBanner(msg, 2.2); if (it) { it.msg = msg.length > 18 ? msg.slice(0, 18) : msg; it.msgUntil = performance.now() + ms; } if (window.__vrOn) [0, 1].forEach(i => vibI(i, 0.25, 70)); };
            if (!best) { say('NO CHESTS HERE'); return false; }
            if (bd < 30) { say('CHEST ' + Math.round(bd) + 'm - CLOSE'); return false; }
            if (GameState.locArrow && GameState.locArrow.ch === best) { say('ALREADY MARKED'); return false; }
            clearLocArrow();
            const M = c => new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true, fog: false }), g = new THREE.Group(), cone = new THREE.Mesh(new THREE.ConeGeometry(0.34, 0.7, 14), M(0x44ff88)), shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.8, 10), M(0x44ff88));
            cone.rotation.x = Math.PI; cone.position.y = 0; shaft.position.y = 0.75; g.add(cone, shaft); g.traverse(o => { o.renderOrder = 998; }); g.position.y = 2.7; best.group.add(g);
            GameState.locArrow = { ch: best, m: g }; AudioSys.playClick(); showEventBanner('CHEST MARKED - ' + Math.round(bd) + 'm AWAY', 2.4); if (it) { it.msg = 'MARKED ' + Math.round(bd) + 'm'; it.msgUntil = performance.now() + 3000; }
            if (window.__vrOn) [0, 1].forEach(i => vibI(i, 0.5, 120)); return true;
        }
        function locArrowTick(dt) {
            const a = GameState.locArrow; if (!a) return; const p = controls.getObject().position, ch = a.ch, d = Math.hypot(p.x - ch.x, p.z - ch.z);
            if (!(GameState.chests || []).includes(ch) || ch.open || d < 30) { clearLocArrow(); return; }
            a.m.position.y = 2.7 + Math.sin(performance.now() * 0.004) * 0.18; a.m.rotation.y += dt * 2; a.m.scale.setScalar(Math.max(1, Math.min(5, d / 14)));
        }
        function chestTick(dt) {
            shotFxTick(dt); locArrowTick(dt);
            const p = controls.getObject().position;
            for (const ch of GameState.chests || []) {
                if (!ch.open) { if (!ch.hinted && Math.hypot(p.x - ch.x, p.z - ch.z) < 3.4) { ch.hinted = true; showEventBanner(window.__vrOn ? 'GRIP THE LID OR PRESS Y TO OPEN THE CHEST' : 'PRESS E TO OPEN THE CHEST', 2.4); } continue; }
                ch.t += dt; const k = Math.min(1, ch.t / 0.8), e = 1 - Math.pow(1 - k, 3); ch.lid.rotation.x = -1.95 * e;
                if (!ch.looted && ch.t > 0.35) { ch.looted = true; spawnLoot(pickWeighted(CHEST_LOOT), ch.x, 0.85, ch.z, Math.sin(ch.rot), Math.cos(ch.rot)); showEventBanner('THE CHEST CREAKS OPEN', 1.6); }
            }
            if (!window.__vrOn && (GameState.crates || []).length) { const it = GameState.inv[GameState.invSel]; if (it && it.id === 'crowbar') { const c = nearestCrate(p, 2.6); if (c && !c.hinted) { c.hinted = true; showEventBanner('PRESS E (OR USE) TO BREAK THE CRATE', 2); } } }
        }
        const _cl = new THREE.Vector3();
        function crateAt(pt, margin = 0.1) { // is this world point inside a crate (real box, +margin)?
            for (const c of GameState.crates || []) { _cl.copy(pt); c.obj.worldToLocal(_cl); const h = c.size / 2 + margin; if (Math.abs(_cl.x) <= h && Math.abs(_cl.y) <= h && Math.abs(_cl.z) <= h) return c; }
            return null;
        }
        function nearChest(ch, pt, margin = 0.12) { // is this world point on / inside the chest's real box (body + lid arch)?
            _cl.copy(pt); ch.group.worldToLocal(_cl);
            return Math.abs(_cl.x) <= 0.475 + margin && Math.abs(_cl.z) <= 0.3 + margin && _cl.y >= -margin && _cl.y <= 0.82 + margin;
        }
        function nearestCrate(pos, range) { let best = null, bd = 1e9; for (const c of GameState.crates || []) { const d = Math.hypot(pos.x - c.obj.position.x, pos.z - c.obj.position.z) - c.size * 0.5; if (d < range && Math.abs(pos.y - c.obj.position.y) < 1.8 + c.size && d < bd) { bd = d; best = c; } } return best; }
        function breakCrate(c) {
            if (c.broken) return; c.broken = true; const pos = c.obj.position.clone(); scene.remove(c.obj); GameState.crates = GameState.crates.filter(x => x !== c);
            GameState.items.forEach(i => { const ph = i.mesh.userData && i.mesh.userData.ph; if (ph) ph.sleep = false; }); if (c.solid && GameState.grid[c.gz]) GameState.grid[c.gz][c.gx] = 0; if (c.col) { const i = GameState.colliders.indexOf(c.col); if (i >= 0) GameState.colliders.splice(i, 1); }
            GameState.bursts = GameState.bursts || [];
            for (let i = 0; i < 18; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.06 + Math.random() * 0.1, 0.03, 0.04 + Math.random() * 0.08), new THREE.MeshStandardMaterial({ color: 0x7a4e24 })); b.position.copy(pos); b.position.y = 0.4 + Math.random() * c.size * 0.5; scene.add(b); GameState.bursts.push({ m: b, v: new THREE.Vector3((Math.random() - 0.5) * 5, 1 + Math.random() * 3.5, (Math.random() - 0.5) * 5), life: 1.2 }); }
            try { AudioSys.playCrateBreak(); } catch (e) {}
            const a = Math.random() * 6.28; spawnLoot(pickWeighted(CRATE_LOOT), pos.x, 0.5 + c.size * 0.4, pos.z, Math.sin(a), Math.cos(a));
        }
        function breakNearestCrate(pos, range) { const c = nearestCrate(pos, range); if (!c) return false; breakCrate(c); return true; }

        // ===================== LEVEL 8: HORROR ATTRACTION + BOSS =====================
        const BOSS_HP = { easy: 250, normal: 350, hard: 450, extreme: 500, impossible: 700 };
        const BOSS_DMG = { crowbar: 30, axe: 35, shotgun_body: 125, shotgun_head: 175 }; // the ONLY source of boss damage numbers
        const Attraction = {
            cp7: null, B: null, S: null, _respawn: false, _restoring: false,
            // ---------- Level 7 inventory checkpoint ----------
            cpSave() { if (this._restoring) return; this.cp7 = GameState.inv.map(s => s ? JSON.parse(JSON.stringify(s)) : null); },
            cpRestore() { this._restoring = true; GameState.inv = this.cp7.map(s => s ? JSON.parse(JSON.stringify(s)) : null); GameState.invSel = 0; GameState.trackerTimer = 60; GameState.trackerInWorld = false; syncInventory(); },
            noteDeath() { this._respawn = !!(this.B && (this.B.state === 'rising' || this.B.state === 'chase')); if (this._respawn) GameState.deathMsg = 'THE RINGMASTER WINS - YOU WAKE IN LEVEL 7'; },
            takeRespawn() { const r = this._respawn && !!this.cp7; this._respawn = false; return r; },
            // ---------- per-level state ----------
            reset() {
                this.S = { falling: [], attr: [], cd: 18, last: null, dir: null, ready: false, slabMat: null };
                this.B = null; GameState.bossDead = false; GameState.shopDoom = null; const h = document.getElementById('boss-hud'); if (h) h.style.display = 'none';
            },
            fixY(x, z, ceilH) { const g = GameState.attrGen; return g && g.tall[z] && !g.tall[z][x] ? 4.0 : ceilH - 0.15; },
            wallMade(x, z, mesh) { const g = GameState.attrGen; if (!g) return; const b = g.breaks.find(k => k.gx === x && k.gz === z); if (b) b.mesh = mesh; },
            clear(ax, az, bx, bz) { const cs = GameState.cellSize, n = Math.ceil(Math.hypot(bx - ax, bz - az) / (cs * 0.4)) || 1; for (let i = 0; i <= n; i++) { const row = GameState.grid[Math.round((az + (bz - az) * i / n) / cs)]; if (!row || row[Math.round((ax + (bx - ax) * i / n) / cs)] === 1) return false; } return true; },
            // ---------- procedural sounds (positional volume, same bus as the rest of the game) ----------
            _g(x, z, vol) { const p = controls.getObject().position, d = Math.hypot(p.x - x, p.z - z); return vol * Math.pow(Math.max(0, 1 - d / 45), 2); },
            _burst(x, z, { f, q = 1, dur = 0.3, vol = 0.5, type = 'bandpass', rate = 1 }) {
                const A = AudioSys; if (!A.ctx || !A.noiseBuffer) return; A.ensureReady(); const v = this._g(x, z, vol); if (v < 0.005) return;
                const c = A.ctx, t = c.currentTime, s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
                s.buffer = A.noiseBuffer; s.playbackRate.value = rate; fl.type = type; fl.frequency.value = f; fl.Q.value = q; g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
                s.connect(fl); fl.connect(g); g.connect(A.masterGain); s.start(t, Math.random() * 0.5, dur + 0.05);
            },
            sfxGlass(x, z) { [0, 0.06, 0.13].forEach((d, i) => setTimeout(() => this._burst(x, z, { f: 5200 - i * 900, q: 0.8, dur: 0.22, vol: 0.55, type: 'highpass' }), d * 1000)); },
            sfxThud(x, z, big) { this._burst(x, z, { f: big ? 90 : 160, q: 0.7, dur: big ? 0.7 : 0.35, vol: big ? 1.0 : 0.8, type: 'lowpass', rate: 0.5 }); this._burst(x, z, { f: 900, q: 1, dur: 0.15, vol: 0.35 }); },
            sfxScare() { const p = controls.getObject().position; try { AudioSys.playMonsterSpot(); } catch (e) {} this._burst(p.x, p.z, { f: 2400, q: 0.6, dur: 0.6, vol: 0.9, type: 'highpass', rate: 1.4 }); this._burst(p.x, p.z, { f: 110, q: 0.7, dur: 0.8, vol: 1.0, type: 'lowpass', rate: 0.5 }); },
            // entity footsteps: movement-driven (called from the main loop), 50% quieter in Nightmare
            stepAt(x, z, vol, rate) {
                const nv = vol * (Settings.nightmare ? 0.5 : 1), v = this._g(x, z, nv); if (v < 0.004) return; const id = 'step_' + stepKind();
                if (Sfx.buf[id] && AudioSys.ctx) { AudioSys.ensureReady(); Sfx.play(id, SFX_REG[id].v * v / 0.5, rate); return; }
                this._burst(x, z, { f: stepKind() === 'carpet' ? 320 : 780, q: 1.2, dur: 0.16, vol: v * 1.4, rate });
            },
            footsteps(dt, p) {
                for (const e of GameState.entities) {
                    if (!e.mesh || e.type === 'smiler' || e._arc) { if (e.mesh) { e._lx = e.mesh.position.x; e._lz = e.mesh.position.z; } continue; }
                    const m = e.mesh.position, lx = e._lx === undefined ? m.x : e._lx, lz = e._lz === undefined ? m.z : e._lz, d = Math.hypot(m.x - lx, m.z - lz); e._lx = m.x; e._lz = m.z;
                    if (d < 0.003 || d > 2 || e.stunTimer > 0) continue;
                    e._stp = (e._stp || 0) + d; const stride = e.type === 'hound' ? 1.1 : (e.type === 'bacteria' ? 2.4 : 1.6);
                    if (e._stp >= stride) { e._stp = 0; this.stepAt(m.x, m.z, e.type === 'bacteria' ? 0.6 : (e.type === 'hound' ? 0.35 : 0.45), e.type === 'bacteria' ? 0.75 : (e.type === 'hound' ? 1.25 : 0.95)); }
                }
            },
            // ---------- level setup (after the exit exists) ----------
            crackTex() {
                const c = document.createElement('canvas'); c.width = 256; c.height = 512; const x = c.getContext('2d');
                x.fillStyle = 'rgba(190,180,150,0.55)'; x.beginPath(); x.ellipse(128, 256, 120, 230, 0, 0, 7); x.fill();
                x.strokeStyle = '#050505'; x.lineWidth = 5; x.lineCap = 'round';
                for (let k = 0; k < 7; k++) { let px = 128, py = 256 + (Math.random() - 0.5) * 60, a = (k / 7) * 6.28 + Math.random(); x.beginPath(); x.moveTo(px, py); for (let s = 0; s < 7; s++) { a += (Math.random() - 0.5) * 1.1; px += Math.cos(a) * (22 + Math.random() * 20); py += Math.sin(a) * (30 + Math.random() * 25); x.lineTo(px, py); } x.stroke(); }
                const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
            },
            setup(cs, size, ceilH) {
                const g = GameState.attrGen, S = this.S; if (!g || !S) return; S.ready = true;
                // lowered ceiling slabs over corridors and normal rooms; the tall rooms keep the high ceiling
                const cells = []; for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) if (GameState.grid[z][x] === 0 && !g.tall[z][x]) cells.push([x, z]);
                S.slabMat = new THREE.MeshStandardMaterial({ color: 0x1b1a18, roughness: 0.95 });
                const slab = new THREE.InstancedMesh(new THREE.BoxGeometry(cs, 0.3, cs), S.slabMat, Math.max(1, cells.length)), m4 = new THREE.Matrix4();
                cells.forEach(([x, z], i) => { m4.makeTranslation(x * cs, 4.15, z * cs); slab.setMatrixAt(i, m4); }); slab.count = cells.length; slab.frustumCulled = false; scene.add(slab);
                // cracked, breakable walls
                const cm = new THREE.MeshStandardMaterial({ map: this.crackTex(), transparent: true, depthWrite: false, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2 }), pg = new THREE.PlaneGeometry(cs * 0.92, 3.4);
                g.breaks.forEach(b => { b.broken = false; const d = new THREE.Mesh(pg, cm); d.position.set(b.gx * cs - b.dx * (cs / 2 + 0.03), 1.9, b.gz * cs - b.dz * (cs / 2 + 0.03)); d.rotation.y = Math.atan2(-b.dx, -b.dz); scene.add(d); b.decal = d; });
                // the boss, sitting passively in the middle of the arena
                const B = this.B = { mesh: null, state: 'passive', max: BOSS_HP[GameState.difficulty] || 350, imm: { crowbar: 0, axe: 0 }, hitAt: 0, pause: 0, mT: 6, rise: 0, flash: 0, tAnim: 0, stepD: 0, R: 22, barrier: null, cx: g.arena.gx * cs, cz: g.arena.gz * cs };
                B.hp = B.max; this.makeBoss(B); B.mesh.position.set(B.cx, 0, B.cz); scene.add(B.mesh);
                GameState.bossDead = false; GameState.attrArenaC = { x: B.cx, z: B.cz };
            },
            // ---------- shootable ceiling lights ----------
            breakLight(l) {
                if (l.broken) return false; l.broken = true; GameState.ceilingLights = GameState.ceilingLights.filter(x => x !== l);
                l.baseIntensity = 0; l.baseEmissive = 0; l.flickers = false; if (l.pointLight) l.pointLight.intensity = 0; if (l.panelMat) { l.panelMat.emissiveIntensity = 0; l.panelMat.color.setHex(0x222222); }
                this.sfxGlass(l.fx, l.fz);
                this.S.falling.push({ x: l.fx, z: l.fz, y: l.fy - 0.04, vy: 0, parts: [l.frame, l.panel], spin: (Math.random() - 0.5) * 4, done: false });
                return true;
            },
            lightsTick(dt) {
                const S = this.S; if (!S.falling.length) return;
                for (const f of S.falling) {
                    if (f.done) continue; f.vy -= 16 * dt; f.y += f.vy * dt; f.parts.forEach((m, i) => { m.position.y = f.y - i * 0.04; m.rotation.z += f.spin * dt; });
                    if (f.y <= 0.12) { f.done = true; f.parts.forEach((m, i) => { m.position.y = 0.12 + i * 0.03; m.rotation.z = 0; }); this.sfxThud(f.x, f.z); this.reveal(f); }
                }
                S.falling = S.falling.filter(f => !f.done);
            },
            reveal(f) { // nothing exists until the light has actually landed (one reveal per light: it is removed from the list first)
                const bossOn = !!this.B && this.B.state !== 'passive';
                if (!bossOn && Math.random() < 0.15) { const e = new Entity('smiler', f.x, f.z); try { e.alertToPosition(controls.getObject().position.clone(), 25); } catch (er) {} showEventBanner('SOMETHING WAS WAITING IN THE LIGHT...', 2.2); }
                else spawnLoot(pickWeighted(CRATE_LOOT), f.x, 0.5, f.z, 0, 1);
            },
            shootLights(o, dir) {
                let best = null, bt = 1e9; for (const l of GameState.ceilingLights) { if (!l.shootable || l.broken) continue; const vx = l.fx - o.x, vy = l.fy - o.y, vz = l.fz - o.z, t = vx * dir.x + vy * dir.y + vz * dir.z; if (t < 0.5 || t > 36 || t >= bt) continue; if (vx * vx + vy * vy + vz * vz - t * t > 1.2) continue; if (!this.clear(o.x, o.z, l.fx, l.fz)) continue; best = l; bt = t; }
                return best ? this.breakLight(best) : false;
            },
            // ---------- breakable walls ----------
            breakWall(b) {
                if (!b || b.broken) return false; b.broken = true; const cs = GameState.cellSize;
                if (b.mesh && b.mesh.parent) b.mesh.parent.remove(b.mesh); if (b.decal) scene.remove(b.decal); GameState.grid[b.gz][b.gx] = 0;
                const sl = new THREE.Mesh(new THREE.BoxGeometry(cs, 0.3, cs), this.S.slabMat); sl.position.set(b.gx * cs, 4.15, b.gz * cs); scene.add(sl);
                try { AudioSys.playCrateBreak(); } catch (e) {} showEventBanner('THE WALL CRUMBLES', 1.6);
                spawnLoot([['water', 1], ['battery', 1]], b.gx * cs, 0.9, b.gz * cs, -b.dx, -b.dz); // exactly 1 Almond Water + 1 Battery, once
                return true;
            },
            meleeWall(p) {
                const g = GameState.attrGen; if (!g || !this.S || !this.S.ready) return false; const cs = GameState.cellSize, fw = new THREE.Vector3(); camera.getWorldDirection(fw); let best = null, bd = 1e9;
                for (const b of g.breaks) { if (b.broken) continue; const wx = b.gx * cs - p.x, wz = b.gz * cs - p.z, d = Math.hypot(wx, wz); if (d > (window.__vrOn ? 3.2 : 3.8) || d >= bd) continue; if ((wx * fw.x + wz * fw.z) / (d || 1) < 0.3 && d > 2.4) continue; best = b; bd = d; }
                return best ? this.breakWall(best) : false;
            },
            vrWall(tip) { const g = GameState.attrGen; if (!g || !this.S || !this.S.ready) return false; const cs = GameState.cellSize, h = cs / 2 + 0.12; for (const b of g.breaks) if (!b.broken && Math.abs(tip.x - b.gx * cs) < h && Math.abs(tip.z - b.gz * cs) < h) return this.breakWall(b); return false; },
            shootWall(o, dir) {
                const g = GameState.attrGen; if (!g || !this.S || !this.S.ready) return false; const cs = GameState.cellSize, h = Math.hypot(dir.x, dir.z) || 1, sx = dir.x / h, sz = dir.z / h;
                for (let d = 0.4; d < 34; d += 0.3) { const gx = Math.round((o.x + sx * d) / cs), gz = Math.round((o.z + sz * d) / cs), row = GameState.grid[gz]; if (!row) return false; if (row[gx] === 1) { const b = g.breaks.find(k => k.gx === gx && k.gz === gz); return b ? this.breakWall(b) : false; } }
                return false;
            },
            // ---------- turning-corner attractions (visual scares only: never registered as entities, no damage code anywhere) ----------
            buildStatic() {
                const M = (c, e = 0x180808) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, emissive: e }), g = new THREE.Group();
                if (Math.random() < 0.5) { // clown head on a body
                    const skin = M(0xe8e0d0), red = M(0xb01818, 0x300404), blk = new THREE.MeshBasicMaterial({ color: 0x000000 });
                    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.42, 1.2, 8), M(0x7a1010)); body.position.y = 0.6; const head = new THREE.Mesh(new THREE.SphereGeometry(0.38, 14, 12), skin); head.position.y = 1.55;
                    const nose = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), red); nose.position.set(0, 1.5, 0.37); const grin = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.035, 6, 14, Math.PI), blk); grin.position.set(0, 1.4, 0.33); grin.rotation.z = Math.PI;
                    g.add(body, head, nose, grin); [-0.13, 0.13].forEach(x => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), blk); e.position.set(x, 1.62, 0.33); g.add(e); const h = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), red); h.position.set(x * 2.4, 1.78, 0); g.add(h); });
                } else { // mannequin, arms out
                    const m = M(0xcfc8bc), body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.25), m); body.position.y = 1.05; const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 10), m); head.position.y = 1.72;
                    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.2), m); legs.position.y = 0.4; g.add(body, head, legs);
                    [-1, 1].forEach(s => { const a = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.9, 6), m); a.position.set(s * 0.4, 1.2, 0.35); a.rotation.x = Math.PI / 2 - 0.2; g.add(a); });
                }
                return g;
            },
            spawnAttraction(p, dx, dz) {
                const cs = GameState.cellSize, gx = Math.round(p.x / cs), gz = Math.round(p.z / cs); let n = 0;
                for (let k = 1; k <= 8; k++) { const row = GameState.grid[gz + dz * k]; if (!row || row[gx + dx * k] !== 0) break; n++; }
                if (n < 3) return; const dist = Math.min((n - 0.5) * cs, 11), S = this.S; let mesh, isEnt = false;
                if (Math.random() < 0.5) { const t = ['bacteria', 'skinstealer', 'smiler', 'hound', 'window_watcher'][Math.floor(Math.random() * 5)], e = new Entity(t, 0, 0); GameState.entities = GameState.entities.filter(x => x !== e); mesh = e.mesh; isEnt = true; } // model only: removed from the AI list immediately
                else { mesh = this.buildStatic(); scene.add(mesh); }
                mesh.position.set(p.x + dx * dist, isEnt ? p.y - 1.4 : 0, p.z + dz * dist); mesh.lookAt(p.x, mesh.position.y, p.z);
                S.attr.push({ mesh, ent: isEnt, t: 0, age: 0, state: 'lunge', from: mesh.position.clone() }); S.cd = 22 + Math.random() * 15; this.sfxScare(); GameState.oceanShake = Math.max(GameState.oceanShake || 0, 0.6);
            },
            attrTick(dt, p) {
                const S = this.S, fw = new THREE.Vector3(); camera.getWorldDirection(fw); fw.y = 0; fw.normalize();
                for (const a of S.attr) {
                    a.age += dt;
                    if (a.state === 'lunge') { a.t = Math.min(1, a.t + dt / 0.28); const k = a.t * a.t, tx = p.x + fw.x * 0.7, tz = p.z + fw.z * 0.7, ty = a.ent ? p.y - 1.4 : 0; a.mesh.position.set(a.from.x + (tx - a.from.x) * k, a.from.y + (ty - a.from.y) * k, a.from.z + (tz - a.from.z) * k); a.mesh.lookAt(p.x, a.mesh.position.y, p.z); if (a.t >= 1) a.state = 'frozen'; }
                }
                S.attr = S.attr.filter(a => { if (a.age > 7 || (a.state === 'frozen' && a.mesh.position.distanceTo(p) > 12)) { scene.remove(a.mesh); return false; } return true; });
            },
            cornerWatch(dt, p) {
                const S = this.S, cs = GameState.cellSize, gx = Math.round(p.x / cs), gz = Math.round(p.z / cs); if (S.cd > 0) S.cd -= dt;
                if (!S.last) { S.last = { gx, gz }; return; } if (gx === S.last.gx && gz === S.last.gz) return;
                const dx = gx - S.last.gx, dz = gz - S.last.gz; S.last = { gx, gz }; if (Math.abs(dx) + Math.abs(dz) !== 1) { S.dir = null; return; }
                const turned = S.dir && (S.dir.x !== dx || S.dir.z !== dz) && !(S.dir.x === -dx && S.dir.z === -dz); S.dir = { x: dx, z: dz };
                if (turned && S.cd <= 0 && !(this.B && this.B.state !== 'passive') && Math.random() < 0.3) this.spawnAttraction(p, dx, dz);
            },
            // ---------- the boss ----------
            makeBoss(B) {
                const M = (c, o = {}) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.7 }, o)), red = M(0x9a1b1b), wht = M(0xe9e2d0), blk = M(0x050505), skin = M(0xd8d0c4, { emissive: 0x1a1814 });
                const g = new THREE.Group(), rig = new THREE.Group(); g.add(rig); const P = {};
                P.legL = new THREE.Group(); P.legR = new THREE.Group(); [[P.legL, -0.32], [P.legR, 0.32]].forEach(([pv, x]) => { pv.position.set(x, 1.6, 0); const l = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 1.6, 8), x < 0 ? red : wht); l.position.y = -0.8; pv.add(l); rig.add(pv); });
                for (let i = 0; i < 7; i++) { const s = new THREE.Mesh(new THREE.BoxGeometry(0.17, 1.5, 0.7), i % 2 ? wht : red); s.position.set(-0.51 + i * 0.17, 2.35, 0); rig.add(s); }
                P.armL = new THREE.Group(); P.armR = new THREE.Group(); [[P.armL, -1], [P.armR, 1]].forEach(([pv, s]) => { pv.position.set(s * 0.74, 3.0, 0); const a = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.09, 2.9, 7), s < 0 ? wht : red); a.position.y = -1.45; const h = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 8), skin); h.position.y = -3.0; h.scale.set(1, 1.5, 0.8); pv.add(a, h); rig.add(pv); });
                P.head = new THREE.Group(); P.head.position.y = 3.55; const hd = new THREE.Mesh(new THREE.SphereGeometry(0.58, 16, 14), skin); hd.scale.set(0.9, 1.2, 0.95); P.head.add(hd);
                const nose = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), red); nose.position.set(0, -0.02, 0.56); const grin = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.05, 6, 16, Math.PI), blk); grin.position.set(0, -0.2, 0.5); grin.rotation.z = Math.PI;
                const hat = new THREE.Mesh(new THREE.ConeGeometry(0.46, 0.95, 10), red); hat.position.y = 0.85; P.head.add(nose, grin, hat);
                [-0.2, 0.2].forEach(x => { const e = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), blk); e.position.set(x, 0.14, 0.5); const w = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 6), new THREE.MeshBasicMaterial({ color: 0xff2200 })); w.position.set(x, 0.14, 0.59); P.head.add(e, w); });
                for (let i = -2; i <= 2; i++) { const t = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.1, 0.04), wht); t.position.set(i * 0.1, -0.2 - Math.abs(i) * 0.02 + 0.06, 0.55); P.head.add(t); }
                rig.add(P.head); B.mesh = g; B.rig = rig; B.parts = P; B.mats = [skin, red, wht]; B.hp = B.max;
                g.scale.setScalar(1.35); rig.scale.y = 0.8; P.head.rotation.x = 0.6; P.armL.rotation.x = P.armR.rotation.x = 0.25; // slumped, sitting
            },
            hud() {
                const B = this.B, h = document.getElementById('boss-hud'); if (!h) return;
                const show = B && (B.state === 'rising' || B.state === 'chase'); h.style.display = show ? 'block' : 'none'; if (show) document.getElementById('boss-fill').style.width = (B.hp / B.max * 100).toFixed(1) + '%';
            },
            activate() {
                const B = this.B; if (!B || B.state !== 'passive') return; B.state = 'rising'; B.rise = 0; GameState.bossActive = true;
                for (const e of GameState.entities.slice()) this.removeEntity(e); // every other entity despawns
                this.S.attr.forEach(a => scene.remove(a.mesh)); this.S.attr = [];
                const bm = new THREE.Mesh(new THREE.CylinderGeometry(B.R, B.R, 7, 56, 1, true), new THREE.MeshBasicMaterial({ color: 0xff2a1a, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false, fog: false }));
                bm.position.set(B.cx, 3.5, B.cz); scene.add(bm); B.barrier = bm; this.sfxThud(B.cx, B.cz, true); showEventBanner('THE RINGMASTER RISES', 3);
            },
            removeEntity(e) { e._dead = true; GameState.entities = GameState.entities.filter(x => x !== e); if (e.mesh) scene.remove(e.mesh); },
            damage(weapon) { // the only function that ever lowers boss HP; callers pass a weapon id, never a number
                const B = this.B; if (!B || B.state === 'dead' || BOSS_DMG[weapon] === undefined) return false; const now = performance.now();
                if (weapon === 'crowbar' || weapon === 'axe') { if (now < B.imm[weapon]) return false; B.imm[weapon] = now + 500; } // 0.5s immunity after a melee hit, enforced here so VR contact can never tick every frame
                let d = BOSS_DMG[weapon]; if (GameState.difficulty === 'extreme' || GameState.difficulty === 'impossible') d *= 0.8;
                if (B.state === 'passive') this.activate();
                B.hp = Math.max(0, B.hp - d); B.flash = 0.12; this.hud();
                if (weapon === 'crowbar') { try { AudioSys.playCrowbarSwing(); } catch (e) {} } else if (weapon === 'axe') { try { AudioSys.playAxeSwing(); } catch (e) {} }
                if (B.hp <= 0) this.kill(); return true;
            },
            meleeBoss(kind) { const B = this.B; if (!B || B.state === 'dead') return false; const p = controls.getObject().position, fw = new THREE.Vector3(); camera.getWorldDirection(fw);
                const dx = B.mesh.position.x - p.x, dz = B.mesh.position.z - p.z, d = Math.hypot(dx, dz); if (d > 5.4 || (dx * fw.x + dz * fw.z) / (d || 1) < 0.25) return false; return this.damage(kind); },
            vrBoss(kind, segs) { const B = this.B; if (!B || B.state === 'dead' || !weaponHitsEntity({ mesh: B.mesh }, segs)) return false; return this.damage(kind); },
            shootBoss(o, dir) {
                const B = this.B; if (!B || B.state === 'dead') return false; const m = B.mesh.position, s = B.rig.scale.y * 1.35, hit = (cx, cy, cz, r) => { const vx = cx - o.x, vy = cy - o.y, vz = cz - o.z, t = vx * dir.x + vy * dir.y + vz * dir.z; return t > 0 && t < 48 && vx * vx + vy * vy + vz * vz - t * t < r * r; };
                if (!this.clear(o.x, o.z, m.x, m.z)) return false;
                if (hit(m.x, 3.55 * s + 0.1, m.z, 0.85)) return this.damage('shotgun_head');
                for (const y of [0.5, 1.4, 2.3, 3.0]) if (hit(m.x, y * s, m.z, 1.35)) return this.damage('shotgun_body');
                return false;
            },
            kill() {
                const B = this.B; B.state = 'dead'; B.dieT = 0; GameState.bossDead = true; GameState.bossActive = false; B.music = false;
                for (const e of GameState.entities.slice()) if (e._minion) this.removeEntity(e); // minions + everything the Bacteria spawned
                if (B.barrier) { scene.remove(B.barrier); B.barrier = null; } try { Sfx.setLoop('chase_music', false); } catch (e) {}
                this.sfxThud(B.cx, B.cz, true); showEventBanner('THE RINGMASTER FALLS - THE EXIT IS OPEN', 4); this.hud();
            },
            musicOn() { return !!(this.B && (this.B.state === 'rising' || this.B.state === 'chase')); },
            bossActive() { return this.musicOn(); },
            lowSanityHit(src) { // a hit taken below 20% sanity: jumpscare (or, with spare chances, burn one like a normal catch)
                if (GameState.isJumpscaring) return; if (GameState.chancesRemaining > 1) { GameState.chancesRemaining--; GameState.graceTimer = 2.6; GameState.globalMonsterPauseTimer = 2; document.getElementById('lives-hud').innerText = `CHANCES REMAINING: ${GameState.chancesRemaining}`; showEventBanner('CAUGHT! 1 CHANCE REMAINING', 2.5); return; }
                triggerJumpscare(src);
            },
            isLow() { return GameState.player.sanity < 0.2 * PermaFx.maxSan(); },
            bossContact(src) {
                const B = this.B, pl = GameState.player; B.hitAt = performance.now() + 2200; B.pause = 0.9;
                if (this.isLow()) { this.lowSanityHit({ type: 'horror_boss', mesh: B.mesh }); return; }
                pl.sanity = Math.max(0, pl.sanity * 0.65); pl.battery = Math.max(0, pl.battery * 0.82); GameState.oceanShake = 1; this.sfxThud(B.mesh.position.x, B.mesh.position.z, true); showEventBanner('THE RINGMASTER GRABS YOU: -35% SANITY, -18% BATTERY', 2.4);
            },
            minionHit(e) {
                if (e._dead) return; const pl = GameState.player; e.stunTimer = 1.5; e.stunRing.visible = true; e.state = 'chase'; // independent per-minion stun
                if (this.isLow()) { this.lowSanityHit(e); return; }
                pl.sanity = Math.max(0, pl.sanity - 0.1 * PermaFx.maxSan()); GameState.oceanShake = 0.7; this.sfxThud(e.mesh.position.x, e.mesh.position.z, false);
            },
            hitMinion(e) {
                if (!e._minion || e._dead || e._arc) return false; const now = performance.now(); if (now < (e._hitCD || 0)) return false; e._hitCD = now + 500; e._hp = (e._hp || 1) - 1;
                if (e._hp <= 0) { this.removeEntity(e); this.sfxThud(e.mesh.position.x, e.mesh.position.z, false); } else { e.stunTimer = Math.max(e.stunTimer, 0.6); e.stunRing.visible = true; }
                return true;
            },
            canWalk(x, z) { const cs = GameState.cellSize, r = 0.9; for (const [ox, oz] of [[-r, -r], [r, -r], [-r, r], [r, r]]) { const row = GameState.grid[Math.round((z + oz) / cs)]; if (!row || row[Math.round((x + ox) / cs)] === 1) return false; } return true; },
            spawnMinion(type, from, to) {
                const e = new Entity(type, from.x, from.z); e._minion = true; e._hp = type === 'bacteria' ? 2 : 1; e._arc = { t: 0, dur: 0.9, from: from.clone(), to: to.clone() }; e.mesh.position.copy(from);
                try { e.alertToPosition(controls.getObject().position.clone(), 99); } catch (er) {} e.state = 'chase'; e.investigateTimer = 999; return e;
            },
            releaseMinion(p) {
                const B = this.B, live = GameState.entities.filter(e => e._minion && !e._dead).length; if (live >= 7) return; const bac = Math.random() < 0.35; let to = null;
                for (let i = 0; i < 8 && !to; i++) { const a = Math.random() * 6.28, r = 3 + Math.random() * 4, x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r; if (this.canWalk(x, z) && Math.hypot(x - B.cx, z - B.cz) < B.R - 1) to = new THREE.Vector3(x, 1.85, z); }
                if (!to) return; this.spawnMinion(bac ? 'bacteria' : 'skinstealer', new THREE.Vector3(B.mesh.position.x, 3, B.mesh.position.z), to); this.sfxThud(B.cx, B.cz, false); showEventBanner('THE RINGMASTER COUGHS SOMETHING UP', 1.8);
            },
            arcStep(e, dt) { const a = e._arc; a.t += dt; const k = Math.min(1, a.t / a.dur); e.mesh.position.set(a.from.x + (a.to.x - a.from.x) * k, a.from.y + (a.to.y - a.from.y) * k + 12.8 * k * (1 - k), a.from.z + (a.to.z - a.from.z) * k); if (k >= 1) { e._arc = null; e.mesh.position.y = 1.85; this.sfxThud(a.to.x, a.to.z, false); } },
            bossTick(dt, p) {
                const B = this.B; B.tAnim += dt; const P = B.parts, now = performance.now();
                B.mats.forEach(m => m.emissive.setHex(B.flash > 0 ? 0x7a0000 : (m === B.mats[0] ? 0x1a1814 : 0x000000))); if (B.flash > 0) B.flash -= dt;
                if (B.state === 'passive') { B.rig.scale.y = 0.8 + Math.sin(B.tAnim * 1.4) * 0.012; return; }
                if (B.state === 'dead') { B.dieT += dt; const k = Math.min(1, B.dieT / 1.6); B.mesh.rotation.x = -1.5 * k; B.mesh.position.y = -0.4 * k; return; }
                this.hud(); const dx = p.x - B.mesh.position.x, dz = p.z - B.mesh.position.z, dist = Math.hypot(dx, dz);
                { const df = ((Math.atan2(dx, dz) - B.mesh.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI; B.mesh.rotation.y += df * Math.min(1, dt * 6); }
                if (B.state === 'rising') { B.rise += dt / 1.6; const k = Math.min(1, B.rise), e = k * k * (3 - 2 * k); B.rig.scale.y = 0.8 + 0.2 * e; P.head.rotation.x = 0.6 * (1 - e); P.armL.rotation.x = P.armR.rotation.x = 0.25 * (1 - e); if (k >= 1) { B.state = 'chase'; this.sfxThud(B.cx, B.cz, true); } this.barrier(p, dt); return; }
                const lightOn = GameState.player.flashlightOn; if (!lightOn) B.hp = Math.min(B.max, B.hp + 2 * dt); // regenerates in the dark, never above max
                const dc = DifficultyConfigs[GameState.difficulty], speed = 4.4 * (dc.monsterSpeedMult || 1) * (lightOn ? 1 : 1.35);
                B.mT -= dt; if (B.mT <= 0) { B.mT = 8 + Math.random() * 5; this.releaseMinion(p); }
                for (const e of GameState.entities.slice()) if (e._minion && e.type === 'bacteria' && !e._arc && e.stunTimer <= 0 && !e._dead) { // Bacteria ability: spawns extra entities that pile up until they're killed
                    e._spT = (e._spT === undefined ? 7 : e._spT) - dt; if (e._spT <= 0) { e._spT = 9; if (GameState.entities.filter(x => x._minion).length < 12) { const f = e.mesh.position.clone(); f.y = 2.5; const t = f.clone().add(new THREE.Vector3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 6)); t.y = 1.85; if (this.canWalk(t.x, t.z)) this.spawnMinion('skinstealer', f, t); } } }
                let moving = false;
                if (B.pause > 0) B.pause -= dt; else if (dist > 2.4) { const nx = dx / dist * speed * dt, nz = dz / dist * speed * dt, m = B.mesh.position; if (this.canWalk(m.x + nx, m.z + nz)) { m.x += nx; m.z += nz; moving = true; } else if (this.canWalk(m.x + nx, m.z)) { m.x += nx; moving = true; } else if (this.canWalk(m.x, m.z + nz)) { m.z += nz; moving = true; } if (moving) { B.stepD += speed * dt; if (B.stepD > 2.6) { B.stepD = 0; this.stepAt(m.x, m.z, 1.0, 0.55); } } }
                const w = moving ? B.tAnim * 6 * (speed / 4.4) : 0; P.legL.rotation.x = Math.sin(w) * 0.7; P.legR.rotation.x = -Math.sin(w) * 0.7; P.armL.rotation.x = -Math.sin(w) * 0.5; P.armR.rotation.x = Math.sin(w) * 0.5; B.rig.position.y = Math.abs(Math.sin(w)) * 0.1;
                if (dist < 3.0 && now > B.hitAt && !GameState.isJumpscaring && GameState.graceTimer <= 0) this.bossContact();
                this.barrier(p, dt);
            },
            barrier(p, dt) { // red cage around the arena: fades in as you near it and pushes you back inside (smoothly if you were shot-activated from far away)
                const B = this.B, dx = p.x - B.cx, dz = p.z - B.cz, d = Math.hypot(dx, dz), lim = B.R - 0.5;
                if (d > lim) { const step = Math.min(d - lim, d - lim > 3 ? 14 * dt : d - lim), k = (d - step) / d; p.x = B.cx + dx * k; p.z = B.cz + dz * k; }
                if (B.barrier) B.barrier.material.opacity = Math.max(0, Math.min(1, (d - (B.R - 9)) / 8)) * (0.22 + 0.1 * Math.sin(performance.now() * 0.006));
            },
            tick(dt, p) {
                const L = LevelData[GameState.level]; if (!L || !L.attraction || GameState.inShop) return; const S = this.S; if (!S || !S.ready) return;
                this.lightsTick(dt); this.attrTick(dt, p); this.cornerWatch(dt, p); if (this.B) this.bossTick(dt, p);
            },
            // ---------- "creator-made" notice ----------
            gate(idx, go, goPool) {
                const L = LevelData[idx], ov = document.getElementById('creator-notice'); if (!L || !L.creator || !ov) return go();
                if (GameState.isRunning && !GameState.isPaused) pauseGame(); ov.style.display = 'flex';
                const close = () => { ov.style.display = 'none'; if (GameState.isRunning && GameState.isPaused) resumeGame(); };
                document.getElementById('cn-pool').onclick = () => { close(); const pi = LevelData.findIndex(l => l.pools && !l.thalasso); (goPool || (() => buildLevel(pi, true)))(pi); };
                document.getElementById('cn-go').onclick = () => { close(); go(); };
            }
        };

        // ===================== LEVEL 9: HAVEN (creator-made) =====================
        // A small suburb under a fake square dome. Terrain rolls (flat around houses, the tower and the shop). Every 30s it turns pitch-black night
        // (no fog) and 6-9 billboarded eyeballs spawn in the corners. Outside a house or the tower chamber they charge. Each house has an odd resident.
        const Haven = {
            on: false, ready: false, CX: 70, CZ: 70, DAY: 30, NIGHT: 22, MAXV: 20, CH: 10.15,
            houses: [], res: [], eyes: [], ladders: [], tankCols: [], oy: 0, vy: 0, night: false, clock: 0, pause: 0, chasing: false, nearD: 999, shr: 0,
            sm(d, a, b) { const t = Math.max(0, Math.min(1, (d - a) / (b - a))); return t * t * (3 - 2 * t); },
            hgt(x, z) { // rolling hills, forced flat around the shop corner, the tower and every house
                let m = this.sm(Math.hypot(Math.max(0, x - 50), Math.max(0, z - 24)), 0, 10);
                m = Math.min(m, this.sm(Math.hypot(x - this.CX, z - this.CZ), 11, 20));
                for (const o of this.houses) { const k = this.sm(Math.hypot(x - o.x, z - o.z), 9, 15); if (k < m) m = k; }
                return m * (1.4 * Math.sin(x * 0.045 + 1.3) * Math.cos(z * 0.04) + 0.8 * Math.sin(x * 0.11 + z * 0.09) + 3 * Math.sin(x * 0.013 + 0.7) * Math.sin(z * 0.012 + 2.1));
            },
            reset() { if (this._em) { for (const q of this._em) q.envMapIntensity = 1; this._em.clear(); } this.on = false; this.ready = false; this.eyes = []; this.res = []; if (this.far0 && camera.far !== this.far0) { camera.far = this.far0; camera.updateProjectionMatrix(); } },
            addCol(x, z, hw, hd, rot, arr) { const c = { x, z, hw, hd, cos: Math.cos(rot), sin: Math.sin(rot), r: Math.hypot(hw, hd), h: 99 }; GameState.colliders.push(c); if (arr) arr.push(c); },
            eyeTex() {
                const c = document.createElement('canvas'); c.width = c.height = 128; const x = c.getContext('2d');
                let g = x.createRadialGradient(64, 64, 10, 64, 64, 62); g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#e2d2c4');
                x.fillStyle = g; x.beginPath(); x.arc(64, 64, 62, 0, 7); x.fill();
                x.strokeStyle = 'rgba(190,20,20,.55)'; x.lineWidth = 1.5;
                for (let i = 0; i < 16; i++) { const a = i / 16 * 6.283 + Math.random() * 0.3; x.beginPath(); x.moveTo(64 + Math.cos(a) * 61, 64 + Math.sin(a) * 61); x.quadraticCurveTo(64 + Math.cos(a + 0.4) * 44, 64 + Math.sin(a + 0.4) * 44, 64 + Math.cos(a) * 30, 64 + Math.sin(a) * 30); x.stroke(); }
                g = x.createRadialGradient(64, 64, 4, 64, 64, 34); g.addColorStop(0, '#ff5a1a'); g.addColorStop(1, '#5a0805');
                x.fillStyle = g; x.beginPath(); x.arc(64, 64, 34, 0, 7); x.fill();
                x.fillStyle = '#000'; x.beginPath(); x.arc(64, 64, 15, 0, 7); x.fill();
                x.fillStyle = 'rgba(255,255,255,.9)'; x.beginPath(); x.arc(54, 52, 6, 0, 7); x.fill();
                return new THREE.CanvasTexture(c);
            },
            skyTex() {
                const c = document.createElement('canvas'); c.width = 1024; c.height = 512; const x = c.getContext('2d');
                const g = x.createLinearGradient(0, 0, 0, 512); g.addColorStop(0, '#1d78e0'); g.addColorStop(1, '#3d97f0'); x.fillStyle = g; x.fillRect(0, 0, 1024, 512);
                const s = x.createRadialGradient(256, 150, 4, 256, 150, 46); s.addColorStop(0, '#fff8c8'); s.addColorStop(0.5, '#ffe98a'); s.addColorStop(1, 'rgba(255,230,120,0)'); x.fillStyle = s; x.fillRect(190, 90, 130, 130);
                x.fillStyle = 'rgba(255,255,255,.16)'; for (let i = 0; i < 14; i++) { const cx = Math.random() * 1024, cy = 120 + Math.random() * 300; for (let k = 0; k < 4; k++) { x.beginPath(); x.ellipse(cx + k * 26, cy + (k % 2) * 6, 40, 12, 0, 0, 7); x.fill(); } }
                x.strokeStyle = 'rgba(255,255,255,.05)'; x.lineWidth = 2; for (let i = 0; i <= 1024; i += 64) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 512); x.stroke(); } for (let j = 0; j <= 512; j += 48) { x.beginPath(); x.moveTo(0, j); x.lineTo(1024, j); x.stroke(); }
                return new THREE.CanvasTexture(c);
            },
            mkResident() {
                const g = new THREE.Group(), M = (c, r) => new THREE.MeshStandardMaterial({ color: c, roughness: r || 0.9 }), skin = M(0xdccbb4), suit = M(0x2b2b30), wh = new THREE.MeshBasicMaterial({ color: 0xffffff }), bk = new THREE.MeshBasicMaterial({ color: 0x000000 });
                const add = (geo, m, x, y, z, p) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); (p || g).add(o); return o; }, B = (w, h, d) => new THREE.BoxGeometry(w, h, d);
                add(B(0.2, 0.85, 0.2), suit, -0.13, 0.43, 0); add(B(0.2, 0.85, 0.2), suit, 0.13, 0.43, 0); add(B(0.5, 0.7, 0.26), suit, 0, 1.2, 0); add(B(0.1, 0.12, 0.1), skin, 0, 1.6, 0);
                const arms = [-1, 1].map(s => { const a = new THREE.Group(); a.position.set(s * 0.32, 1.5, 0); add(B(0.12, 0.75, 0.12), suit, 0, -0.37, 0, a); add(B(0.1, 0.14, 0.1), skin, 0, -0.82, 0, a); g.add(a); return a; });
                const head = add(new THREE.SphereGeometry(0.2, 20, 16), skin, 0, 1.82, 0); head.scale.set(0.9, 1.25, 0.95);
                for (const s of [-1, 1]) { add(new THREE.SphereGeometry(0.075, 14, 12), wh, s * 0.085, 1.88, 0.16); add(new THREE.SphereGeometry(0.016, 8, 8), bk, s * 0.085, 1.88, 0.232); }
                add(B(0.03, 0.07, 0.03), skin, 0, 1.78, 0.2); add(B(0.14, 0.012, 0.01), bk, 0, 1.7, 0.185);
                g.userData.arms = arms; return g;
            },
            build(cs, size, shopMode, amb) {
                const H = this, M = (c, o) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.85 }, o || {}));
                H.S = size * cs; H.CX = H.CZ = H.S / 2; H.env = scene.environment; H.on = true; H.ready = false; H.night = false; H.clock = 0; H.eyes = []; H.res = []; H.houses = []; H.ladders = []; H.tankCols = []; H.oy = 0; H.vy = 0; H.pause = 0; H.chasing = false; H.nearD = 999; H.shr = 0; H._v = new THREE.Vector3();
                H.far0 = H.far0 || camera.far; camera.far = 1500; camera.updateProjectionMatrix();
                const g0 = GameState.grid; for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) g0[z][x] = (x === 0 || z === 0 || x === size - 1 || z === size - 1) ? 1 : 0; shopMode && shopCarve(g0, size);
                // house lots (the four inner ones make room for the tower); houses are all the same building, just turned differently
                const LT = [64, 192, 320, 448, 576]; for (const z of LT) for (const x of LT) { if (Math.hypot(x - H.CX, z - H.CZ) < 60) continue; H.houses.push({ x: x + (Math.random() - 0.5) * 20, z: z + (Math.random() - 0.5) * 20, rot: Math.floor(Math.random() * 4) * Math.PI / 2 }); }
                // ground
                const gg = new THREE.PlaneGeometry(H.S + 4, H.S + 4, 160, 160); gg.rotateX(-Math.PI / 2); gg.translate(H.CX, 0, H.CZ); const gp = gg.attributes.position; for (let i = 0; i < gp.count; i++) gp.setY(i, H.hgt(gp.getX(i), gp.getZ(i))); gg.computeVertexNormals();
                scene.add(new THREE.Mesh(gg, new THREE.MeshLambertMaterial({ color: 0x3fc23f })));
                // the fake dome: a square-based hemisphere that meets the ground at the invisible wall
                const dg = new THREE.SphereGeometry(1, 48, 24, 0, Math.PI * 2, 0, Math.PI / 2), dp = dg.attributes.position;
                for (let i = 0; i < dp.count; i++) { const x = dp.getX(i), y = dp.getY(i), z = dp.getZ(i), f = Math.atan2(z, x), R = (H.S / 2 + 1) / Math.max(Math.abs(Math.cos(f)), Math.abs(Math.sin(f)), 1e-3); dp.setXYZ(i, H.CX + x * R, y * 170, H.CZ + z * R); }
                H.dome = new THREE.Mesh(dg, new THREE.MeshBasicMaterial({ map: H.skyTex(), side: THREE.BackSide, fog: false, depthWrite: false, toneMapped: false })); H.dome.frustumCulled = false; H.dome.renderOrder = -1; scene.add(H.dome);
                H.sun = new THREE.DirectionalLight(0xfff3d6, 1.0); H.sun.position.set(40, 80, 20); scene.add(H.sun);
                // the hole you climbed out of
                const hole = new THREE.Mesh(new THREE.CircleGeometry(1.7, 24), new THREE.MeshBasicMaterial({ color: 0x000000 })); hole.rotation.x = -Math.PI / 2; hole.position.set(46, 0.045, 8); scene.add(hole);
                const rim = new THREE.Mesh(new THREE.RingGeometry(1.7, 2.5, 24), M(0x5a4128)); rim.rotation.x = -Math.PI / 2; rim.position.set(46, 0.035, 8); scene.add(rim);
                // houses
                const wall = M(0xe8dcc0), trim = M(0x7a5a3a), roof = M(0x8a3b2e), flr = M(0x8a6a48), wood = M(0x5a4028), fab = M(0x4a6a8a), bed = M(0xb06a6a), rug = M(0x7a2f2f), glass = M(0x7ab8e8, { roughness: 0.2, metalness: 0.2 }), asph = M(0x3a3a3e), leaf = M(0x2f8f2f), ceil = M(0xf2ecdc);
                const types = ['water', 'battery', 'coin']; let pool = []; for (let i = 0; i < 4; i++) pool.push(...types); pool.sort(() => Math.random() - 0.5);
                H.houses.forEach((h, hi) => {
                    const g = new THREE.Group(), c = Math.cos(h.rot), s = Math.sin(h.rot), W = (lx, lz) => [h.x + lx * c + lz * s, h.z - lx * s + lz * c];
                    const bx = (w, hh, d, m, x, y, z) => { const o = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), m); o.position.set(x, y, z); g.add(o); return o; };
                    const col = (lx, lz, hw, hd) => { const [wx, wz] = W(lx, lz); H.addCol(wx, wz, hw, hd, h.rot); };
                    bx(8.3, 0.2, 8.3, flr, 0, -0.08, 0); bx(8.3, 0.2, 8.3, ceil, 0, 3.3, 0);
                    bx(8.3, 3.2, 0.3, wall, 0, 1.6, -4); bx(0.3, 3.2, 8.3, wall, -4, 1.6, 0); bx(0.3, 3.2, 8.3, wall, 4, 1.6, 0); bx(3.05, 3.2, 0.3, wall, -2.625, 1.6, 4); bx(3.05, 3.2, 0.3, wall, 2.625, 1.6, 4); bx(2.2, 0.7, 0.3, wall, 0, 2.85, 4);
                    col(0, -4, 4.15, 0.2); col(-4, 0, 0.2, 4.15); col(4, 0, 0.2, 4.15); col(-2.625, 4, 1.55, 0.2); col(2.625, 4, 1.55, 0.2);
                    for (const [x, z, a] of [[-2.6, 4, 0], [2.6, 4, 0], [0, -4, 0], [-4, -1.5, 1], [4, -1.5, 1], [-4, 2.5, 1], [4, 2.5, 1]]) bx(a ? 0.36 : 1.4, 1.1, a ? 1.4 : 0.36, glass, x, 1.7, z);
                    const rf = new THREE.Mesh(new THREE.ConeGeometry(6.4, 2.4, 4), roof); rf.rotation.y = Math.PI / 4; rf.position.y = 4.6; g.add(rf);
                    bx(2.4, 0.1, 0.9, trim, 0, 0.03, 4.5); bx(3, 0.02, 7, asph, 0, 0.025, 8);
                    // furniture: the same room every time
                    bx(1.7, 0.08, 1.0, wood, 1.5, 0.9, -0.5); for (const [x, z] of [[0.75, -0.9], [2.25, -0.9], [0.75, -0.1], [2.25, -0.1]]) bx(0.07, 0.9, 0.07, wood, x, 0.45, z); col(1.5, -0.5, 0.85, 0.5);
                    bx(0.9, 0.5, 2.2, fab, 3.3, 0.3, 1.8); bx(0.25, 0.8, 2.2, fab, 3.7, 0.7, 1.8); col(3.3, 1.8, 0.55, 1.1);
                    bx(1.6, 0.45, 2.2, bed, -3.0, 0.3, 1.0); bx(1.6, 0.9, 0.12, wood, -3.0, 0.6, -0.1); bx(0.9, 0.12, 0.4, ceil, -3.0, 0.58, -0.0); col(-3.0, 1.0, 0.8, 1.1);
                    bx(1.4, 1.8, 0.4, wood, -1.2, 0.9, -3.65); col(-1.2, -3.65, 0.7, 0.25); bx(3, 0.02, 2.2, rug, 0.3, 0.03, 1.0);
                    bx(0.15, 1.4, 0.15, trim, 3.4, 0.7, -3.4); bx(0.5, 0.35, 0.5, ceil, 3.4, 1.5, -3.4);
                    // a tree out front
                    const tr = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 2.6, 8), wood); tr.position.set(5.6, 1.3, 3.8); g.add(tr); const cn = new THREE.Mesh(new THREE.SphereGeometry(1.7, 12, 10), leaf); cn.position.set(5.6, 3.6, 3.8); g.add(cn); col(5.6, 3.8, 0.35, 0.35);
                    g.position.set(h.x, 0, h.z); g.rotation.y = h.rot; scene.add(g); h.grp = g;
                    // the item on the table (different per house)
                    const t = pool[hi % pool.length], [tx, tz] = W(1.5, -0.5), m = buildItemModel(t); m.position.set(tx, (FLOOR_Y[t] || 0.5) + 0.94, tz); m.userData = { type: t }; scene.add(m); GameState.items.push({ mesh: m, type: 'item' });
                    // the resident, in a corner
                    const [rx, rz] = W(-3.2, -3.2), rg = H.mkResident(); rg.position.set(rx, 0.02, rz); scene.add(rg); H.res.push({ g: rg, x: rx, z: rz, hx: rx, hz: rz, mode: 'idle', cd: 0, rot: 0 });
                });
                // the water tower
                const CX = H.CX, CZ = H.CZ, met = M(0x7a7f84, { metalness: 0.5, roughness: 0.5 }), tank = M(0xb7bec5, { metalness: 0.4, roughness: 0.5, side: THREE.DoubleSide });
                const add = (geo, m, x, y, z, rx) => { const o = new THREE.Mesh(geo, m); o.position.set(x, y, z); if (rx) o.rotation.x = rx; scene.add(o); return o; };
                for (const [lx, lz] of [[-4.9, -4.9], [4.9, -4.9], [-4.9, 4.9], [4.9, 4.9]]) { add(new THREE.CylinderGeometry(0.22, 0.22, 10.2, 8), met, CX + lx, 5.1, CZ + lz); H.addCol(CX + lx, CZ + lz, 0.3, 0.3, 0); }
                add(new THREE.RingGeometry(4.4, 7.0, 40), M(0x5a5f64, { side: THREE.DoubleSide }), CX, 10, CZ, -Math.PI / 2);
                add(new THREE.CylinderGeometry(4.5, 4.5, 5, 36, 1, true), tank, CX, 12.5, CZ);
                add(new THREE.CircleGeometry(4.5, 36), M(0x555a5e, { side: THREE.DoubleSide }), CX, H.CH, CZ, -Math.PI / 2);
                for (const y of [11.2, 13.8]) add(new THREE.TorusGeometry(4.52, 0.08, 6, 36), met, CX, y, CZ, Math.PI / 2);
                add(new THREE.CylinderGeometry(1.1, 4.9, 2.327, 36, 1, true), M(0x6b7076, { side: THREE.DoubleSide }), CX, 16.1635, CZ);
                add(new THREE.TorusGeometry(1.1, 0.09, 6, 24), M(0x222222), CX, 17.327, CZ, Math.PI / 2);
                const lad = (x, z, y0, y1, zx, zz, sr) => { const g = new THREE.Group(), hh = y1 - y0; for (const s of [-0.33, 0.33]) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.07, hh, 0.07), met); r.position.set(0, hh / 2, s); g.add(r); } for (let y = 0.3; y < hh; y += 0.35) { const r = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.66), met); r.position.y = y; g.add(r); } g.position.set(x, y0, z); scene.add(g); H.ladders.push({ x: zx, z: zz, y0, y1, sr }); };
                lad(CX + 7.3, CZ, 0, 10, CX + 7.85, CZ, 1.3); lad(CX - 4.62, CZ, 10, 15, CX - 5.4, CZ, 1.1);
                for (let i = 0; i < 16; i++) { const a = i / 16 * Math.PI * 2; H.addCol(CX + Math.cos(a) * 4.6, CZ + Math.sin(a) * 4.6, 1.0, 0.25, Math.atan2(-Math.cos(a), -Math.sin(a)), H.tankCols); }
                const cl = new THREE.PointLight(0xffe2a8, 1.6, 14); cl.position.set(CX, 12.8, CZ); scene.add(cl);
                createExit(CX - 3.4, CZ, 'door'); const ex = GameState.items[GameState.items.length - 1].mesh; ex.position.set(CX - 3.4, H.CH + 2, CZ); ex.children[0].rotation.y = Math.PI / 2; ex.children[0].position.set(0, 0, 0); GameState.exitPos.set(ex.position.x, ex.position.y, ex.position.z);
                H.eyeMat = new THREE.SpriteMaterial({ map: H.eyeTex(), fog: false, transparent: true, depthWrite: false });
                H.setDay(false); H.ready = true;
                const spawn = () => { if (shopMode) { GameState.exitArrowTimer = 45; GameState.pingTimer = 30; GameState.globalMonsterPauseTimer = 4; } H.clock = 0; H.setDay(false); };
                if (shopMode) { GameState.pendingSpawn = spawn; scene.fog.density = 0.012; GameState.baseFogD = 0.012; ambientLight.color.setHex(0xfff2c2); ambientLight.intensity = 0.9; buildShopRoom(cs, 4); shopWarm(); }
                else { controls.getObject().position.set(46, 2, 12); spawn(); }
            },
            setDay(announce) {
                this.night = false; this.clock = 0; this.clearEyes(); scene.background = new THREE.Color(0x2a88ea); scene.fog.color.setHex(0x2a88ea); scene.fog.density = 0; GameState.baseFogD = 0;
                this.envK(1); if (typeof pathTraceBounceLight !== 'undefined') pathTraceBounceLight.visible = true; ambientLight.color.setHex(0xffffff); ambientLight.intensity = 1.0; this.sun.intensity = 0.45; this.dome.material.color.setHex(0xffffff); this.chasing = false;
                if (announce) showEventBanner('DAYBREAK. THE EYES ARE GONE.', 2.4);
            },
            setNight(announce) {
                this.night = true; this.clock = 0; scene.background = new THREE.Color(0x000000); scene.fog.color.setHex(0x000000); scene.fog.density = 0; GameState.baseFogD = 0;
                this.blackout(); this.dome.material.color.setHex(0x000000); this.spawnEyes();
                if (announce) { showEventBanner('NIGHT FALLS. GET INSIDE.', 3); try { AudioSys._t(70, 1.3, 'sawtooth', 0.14, 35); } catch (e) {} }
            },
            envK(k) { this._em = this._em || new Set(); scene.traverse(o => { const m = o.material; if (!m) return; for (const q of (Array.isArray(m) ? m : [m])) if ('envMapIntensity' in q) { q.envMapIntensity = k; this._em.add(q); } }); }, // uniform change only: no shader recompiles at dusk/dawn
            blackout() { this.envK(0); ambientLight.intensity = 0; this.sun.intensity = 0; if (typeof pathTraceBounceLight !== 'undefined') pathTraceBounceLight.visible = false; }, // nothing may light the world at night
            clearEyes() { for (const e of this.eyes) scene.remove(e.s); this.eyes = []; },
            spawnEyes() { // a ring around you, 70-120m out, so they reach you a few seconds after dark
                this.clearEyes(); const p = controls.getObject().position, n = 6 + Math.floor(Math.random() * 4), S = this.S;
                for (let i = 0; i < n; i++) {
                    const a = (i / n + Math.random() * 0.1) * Math.PI * 2, r = 70 + Math.random() * 50, x = Math.max(8, Math.min(S - 8, p.x + Math.cos(a) * r)), z = Math.max(8, Math.min(S - 8, p.z + Math.sin(a) * r));
                    const s = new THREE.Sprite(this.eyeMat); s.scale.set(2.6, 2.6, 1); s.position.set(x, this.hgt(x, z) + 1.5, z); scene.add(s); this.eyes.push({ s, sp: 0, acc: 9 + Math.random() * 2, ph: Math.random() * 6 });
                }
            },
            isSafe(p) {
                const o = this.oy; if (Math.hypot(p.x - this.CX, p.z - this.CZ) < 4.3 && o > 9.3 && o < 14) return true;
                for (const h of this.houses) { const dx = p.x - h.x, dz = p.z - h.z, c = Math.cos(h.rot), s = Math.sin(h.rot); if (Math.abs(dx * c - dz * s) < 4.1 && Math.abs(dx * s + dz * c) < 4.1) return true; }
                return false;
            },
            surf(x, z) {
                const o = this.oy, r = Math.hypot(x - this.CX, z - this.CZ); let y = this.hgt(x, z);
                if (o >= 9.3) { if (r >= 4.4 && r <= 7.0) y = Math.max(y, 10); if (r < 4.3 && o < 14) y = Math.max(y, this.CH); }
                if (o >= 14 && r < 4.9) y = Math.max(y, r > 1.1 ? 15 + (4.9 - r) * 0.612 : this.CH);
                for (const l of this.ladders) if (o >= l.y1 - 0.6 && Math.hypot(x - l.x, z - l.z) < l.sr) y = Math.max(y, l.y1);
                return y;
            },
            pre(dt, p, keys) { // called every frame before collision: ladders, gravity, terrain height. Returns true while climbing (movement frozen)
                if (!this.ready) return false;
                let lad = null; for (const l of this.ladders) if (Math.hypot(p.x - l.x, p.z - l.z) < 1.25 && this.oy >= l.y0 - 0.35 && this.oy <= l.y1 + 0.01) { lad = l; break; }
                if (lad) {
                    camera.getWorldDirection(this._v); const dx = lad.x - p.x, dz = lad.z - p.z, dl = Math.hypot(dx, dz) || 1, fl = Math.hypot(this._v.x, this._v.z) || 1, facing = (this._v.x * dx + this._v.z * dz) / dl / fl;
                    if (keys.w && facing > 0.2 && this.oy < lad.y1 - 0.02) { this.oy = Math.min(lad.y1, this.oy + 3.4 * dt); this.vy = 0; this.cols(); return true; }
                    if (keys.s && this.oy > lad.y0 + 0.02) { this.oy = Math.max(lad.y0, this.oy - 3.4 * dt); this.vy = 0; this.cols(); return true; }
                }
                const sf = this.surf(p.x, p.z);
                if (this.oy > sf + 0.02) { this.vy -= 28 * dt; this.oy += this.vy * dt; if (this.oy <= sf) { this.oy = sf; this.vy = 0; } }
                else { this.vy = 0; this.oy += (sf - this.oy) * Math.min(1, dt * 10); }
                this.cols(); return false;
            },
            cols() { // the tank wall only blocks you below roof height, so you can walk onto the roof from the roof ladder
                const off = this.oy > 14.3, has = this.tankCols.length && GameState.colliders.includes(this.tankCols[0]);
                if (off && has) GameState.colliders = GameState.colliders.filter(c => !this.tankCols.includes(c));
                else if (!off && !has) GameState.colliders.push(...this.tankCols);
            },
            caught(obj, msg) {
                if (GameState.isJumpscaring || GameState._rt || GameState.graceTimer > 0) return false;
                if (GameState.chancesRemaining > 1) { GameState.chancesRemaining -= 1; GameState.globalMonsterPauseTimer = 2; GameState.graceTimer = 2.6; this.pause = 2.6; try { AudioSys.playSecondChanceHit(); } catch (e) {} showEventBanner('CAUGHT! 1 CHANCE REMAINING', 3); const lh = document.getElementById('lives-hud'); lh.innerText = 'CHANCES REMAINING: ' + GameState.chancesRemaining; lh.style.color = '#ffaa33'; return 'saved'; }
                GameState.deathMsg = msg; triggerJumpscare(obj); return true;
            },
            tick(dt, p) {
                if (!this.ready) return;
                if (this.pause > 0) this.pause -= dt;
                this.clock += dt; if (this.clock >= (this.night ? this.NIGHT : this.DAY)) { if (this.night) this.setDay(true); else this.setNight(true); }
                if (this.night && ambientLight.intensity > 0) this.blackout();
                this.cullT = (this.cullT || 0) - dt; if (this.cullT <= 0) { this.cullT = 0.4; for (const h of this.houses) { const v = Math.hypot(h.x - p.x, h.z - p.z) < 230; if (h.grp && h.grp.visible !== v) h.grp.visible = v; } } // far houses are not drawn
                const safe = this.isSafe(p); let nearD = 999;
                // eyes
                for (const e of this.eyes) {
                    const s = e.s, tx = p.x, tz = p.z, ty = p.y - 0.4, dx = tx - s.position.x, dy = ty - s.position.y, dz = tz - s.position.z, d = Math.hypot(dx, dy, dz) || 1; nearD = Math.min(nearD, d);
                    if (this.pause > 0) continue;
                    let v;
                    if (!safe) { e.sp = Math.min(this.MAXV, e.sp + e.acc * dt); v = e.sp * (d < 15 ? 0.7 : 1); } else { e.sp = 0; v = d > 14 ? 4 : 0; }
                    const st = Math.min(v * dt, d); s.position.x += dx / d * st; s.position.y += dy / d * st; s.position.z += dz / d * st;
                    if (safe) for (const h of this.houses) { const ox = s.position.x - h.x, oz = s.position.z - h.z; if (Math.abs(ox) < 5 && Math.abs(oz) < 5 && Math.hypot(ox, oz) < 7) { const k = 5.2 / Math.max(Math.abs(ox), Math.abs(oz), 0.01); s.position.x = h.x + ox * k; s.position.z = h.z + oz * k; } }
                    s.position.y += Math.sin(performance.now() * 0.004 + e.ph) * 0.01; const sc = 2.6 + 0.1 * Math.sin(performance.now() * 0.01 + e.ph); s.scale.set(sc, sc, 1);
                    if (!safe && d < 1.3) { const r = this.caught({ type: 'haven_eye', mesh: s }, 'THE EYES FOUND YOU'); if (r === 'saved') { for (const q of this.eyes) { const a = Math.atan2(q.s.position.z - p.z, q.s.position.x - p.x); q.s.position.x = p.x + Math.cos(a) * 28; q.s.position.z = p.z + Math.sin(a) * 28; q.sp = 0; } break; } if (r) return; }
                }
                this.nearD = nearD; this.chasing = this.night && !safe && this.eyes.length > 0 && this.pause <= 0;
                if (this.chasing) { this.shr -= dt; if (this.shr <= 0) { this.shr = 0.95 + Math.random() * 0.4; const v = 0.05 + 0.07 * Math.max(0, 1 - nearD / 90), f = 900 + Math.random() * 250; try { AudioSys._t(f, 0.6, 'sawtooth', v, f * 1.9); AudioSys._t(f * 1.4, 0.5, 'square', v * 0.6, f * 2.2, 0.06); } catch (e) {} } } else this.shr = 0;
                // residents
                for (const r of this.res) {
                    if (this.pause > 0) continue; if (r.cd > 0) r.cd -= dt;
                    const dx = p.x - r.x, dz = p.z - r.z, d = Math.hypot(dx, dz), want = Math.atan2(dx, dz); let df = want - r.rot; df = Math.atan2(Math.sin(df), Math.cos(df)); r.rot += df * Math.min(1, dt * (r.mode === 'lunge' ? 14 : 1.2)); r.g.rotation.y = r.rot;
                    if (r.mode === 'idle') { if (r.cd <= 0 && d < 2.4 && Math.abs(p.y - 2 - this.oy) < 1.5) { r.mode = 'lunge'; for (const a of r.g.userData.arms) a.rotation.x = -1.5; try { AudioSys._t(420, 0.35, 'sawtooth', 0.12, 1500); } catch (e) {} } }
                    else { const st = Math.min(15 * dt, d); r.g.position.x += dx / (d || 1) * st; r.g.position.z += dz / (d || 1) * st; r.x = r.g.position.x; r.z = r.g.position.z;
                        if (d < 1.15) { const q = this.caught({ type: 'haven_resident', mesh: r.g }, 'THE RESIDENT WAS HOME'); if (q === 'saved') { r.mode = 'idle'; r.cd = 5; for (const a of r.g.userData.arms) a.rotation.x = 0; r.x = r.g.position.x = r.hx; r.z = r.g.position.z = r.hz; } else if (q) return; } }
                }
            }
        };

        // ===== THE SHOPKEEPER DOES NOT LIKE BEING SHOT =====
        // Shoot him in the shop: the music dies, the button and the wares stop working, he stares for 3s, twitches, then bursts into a skinstealer that outruns you.
        const ShopDoom = {
            shot(o, dir) {
                const sp = GameState.shopPos; if (GameState.shopDoom || !sp || !sp.kp || GameState.shopSliding || GameState.shopOpen) return;
                const k = sp.kp.position; let hit = false;
                for (const y of [0.4, 1.0, 1.6]) { const vx = k.x - o.x, vy = y - o.y, vz = k.z - o.z, tt = vx * dir.x + vy * dir.y + vz * dir.z; if (tt > 0 && tt < 30 && vx * vx + vy * vy + vz * vz - tt * tt < 0.5) { hit = true; break; } }
                if (hit) this.start();
            },
            start() {
                const sp = GameState.shopPos, d = GameState.shopDoom = { t: 0, phase: 'stare', parts: [], last: performance.now() };
                try { ShopRadio.stop(); } catch (e) {} const pr = document.getElementById('shop-prompt'); if (pr) pr.style.display = 'none';
                const base = GameState.shopTick; GameState.shopTick = tm => { if (base) base(tm); this.tick(tm); };
                sp.kp.userData.home = sp.kp.position.clone(); showEventBanner('...', 2);
            },
            tick(tm) {
                const d = GameState.shopDoom, sp = GameState.shopPos; if (!d || !sp) return; const now = performance.now(), dt = Math.min(0.1, (now - d.last) / 1000); d.last = now;
                const pr = document.getElementById('shop-prompt'); if (pr) pr.style.display = 'none';
                for (const q of d.parts) { q.v.y -= 14 * dt; q.m.position.addScaledVector(q.v, dt); q.m.rotation.x += dt * 6; q.life -= dt; if (q.m.position.y < 0.05) { q.m.position.y = 0.05; q.v.set(0, 0, 0); } if (q.life <= 0) scene.remove(q.m); }
                d.parts = d.parts.filter(q => q.life > 0); if (d.phase === 'gone') return;
                d.t += dt; const kp = sp.kp, h = kp.userData.home, p = controls.getObject().position;
                kp.rotation.y = Math.atan2(p.x - kp.position.x, p.z - kp.position.z); // he just stares
                if (d.t > 3 && d.phase === 'stare') d.phase = 'twitch';
                if (d.phase === 'twitch') {
                    const k = Math.min(1, (d.t - 3) / 0.9); kp.position.set(h.x + (Math.random() - 0.5) * 0.18 * k, h.y, h.z + (Math.random() - 0.5) * 0.18 * k); kp.rotation.z = (Math.random() - 0.5) * 0.5 * k; kp.scale.set(1 + (Math.random() - 0.5) * 0.35 * k, 1 + (Math.random() - 0.3) * 0.45 * k, 1);
                    if (Math.random() < 0.35) Attraction._burst(kp.position.x, kp.position.z, { f: 3000 + Math.random() * 2500, q: 0.8, dur: 0.1, vol: 0.5, type: 'highpass' });
                    if (d.t > 3.9) this.explode();
                }
            },
            explode() {
                const d = GameState.shopDoom, sp = GameState.shopPos, kp = sp.kp, x = kp.position.x, z = kp.position.z; d.phase = 'gone';
                for (let i = 0; i < 34; i++) { const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), new THREE.MeshBasicMaterial({ color: i % 3 ? 0x050505 : 0x8a0a0a })); m.position.set(x, 1.1, z); scene.add(m); d.parts.push({ m, life: 1.6, v: new THREE.Vector3((Math.random() - 0.5) * 9, 2 + Math.random() * 6, (Math.random() - 0.5) * 9) }); }
                scene.remove(kp); Attraction.sfxThud(x, z, true); Attraction.sfxGlass(x, z); GameState.oceanShake = 1.2; GameState.deathMsg = 'YOU SHOT THE SHOPKEEPER';
                const e = new Entity('skinstealer', x, z); e._doom = true; e.mesh.position.set(x, 1.85, z); try { e.alertToPosition(controls.getObject().position.clone(), 99); } catch (er) {} e.state = 'chase'; e.investigateTimer = 999;
                showEventBanner('SOMETHING WAS WEARING HIM', 3);
            }
        };

        // ===== GRENADE =====
        // Thrown with LMB / G (or the VR trigger). Real physics (gravity, bounces, walls, furniture), 2.6s fuse.
        //   within 3m  -> stunned          within 1m -> stunned 4x as long
        //   within 0.5m -> every joint is found, torn off and flung outward; the entity is removed from the map
        // The torn-off pieces are simulated in a Web Worker (separate thread) so a big blast never stalls a frame;
        // the main thread only copies the finished positions onto the meshes. If workers are blocked, the exact same
        // simulation code runs on the main thread instead.
        function makeDebrisSim(scope) { // NOTE: this function is serialised into the worker: it must not touch anything outside itself
            let grid = null, size = 0, cs = 4, floor = 0, ceil = 4, P = [], timer = null, last = 0;
            function step(dt) {
                for (let i = 0; i < P.length; i++) {
                    const p = P[i]; if (p.dead) continue;
                    p.age += dt; if (p.age >= p.life) { p.dead = true; continue; }
                    if (p.sleep) continue;
                    p.vy -= 15 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
                    const h = 0.5 * dt, qx = p.qx, qy = p.qy, qz = p.qz, qw = p.qw;
                    p.qx += h * (p.wx * qw + p.wy * qz - p.wz * qy); p.qy += h * (-p.wx * qz + p.wy * qw + p.wz * qx);
                    p.qz += h * (p.wx * qy - p.wy * qx + p.wz * qw); p.qw += h * (-p.wx * qx - p.wy * qy - p.wz * qz);
                    const ql = 1 / Math.hypot(p.qx, p.qy, p.qz, p.qw); p.qx *= ql; p.qy *= ql; p.qz *= ql; p.qw *= ql;
                    if (p.y < floor + p.r) {
                        p.y = floor + p.r; if (p.vy < 0) p.vy *= -0.35; p.vx *= 0.72; p.vz *= 0.72; p.wx *= 0.7; p.wy *= 0.7; p.wz *= 0.7;
                        if (Math.abs(p.vy) < 1 && Math.hypot(p.vx, p.vz) < 0.8) { p.sleep = true; p.vx = p.vy = p.vz = 0; }
                    }
                    if (p.y > ceil - p.r) { p.y = ceil - p.r; if (p.vy > 0) p.vy *= -0.4; }
                    if (grid) {
                        const gx = Math.round(p.x / cs), gz = Math.round(p.z / cs);
                        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
                            const cx = gx + dx, cz = gz + dz; if (cx < 0 || cz < 0 || cx >= size || cz >= size || grid[cz * size + cx] !== 1) continue;
                            const nx = Math.max(cx * cs - cs / 2, Math.min(cx * cs + cs / 2, p.x)), nz = Math.max(cz * cs - cs / 2, Math.min(cz * cs + cs / 2, p.z));
                            let ex = p.x - nx, ez = p.z - nz; const d2 = ex * ex + ez * ez;
                            if (d2 >= p.r * p.r) continue;
                            if (d2 > 1e-8) { const d = Math.sqrt(d2); ex /= d; ez /= d; p.x = nx + ex * p.r; p.z = nz + ez * p.r; const vn = p.vx * ex + p.vz * ez; if (vn < 0) { p.vx -= 1.5 * vn * ex; p.vz -= 1.5 * vn * ez; } }
                            else { const ox = p.x - cx * cs, oz = p.z - cz * cs; if (Math.abs(ox) > Math.abs(oz)) { p.x = cx * cs + (ox < 0 ? -1 : 1) * (cs / 2 + p.r); p.vx *= -0.4; } else { p.z = cz * cs + (oz < 0 ? -1 : 1) * (cs / 2 + p.r); p.vz *= -0.4; } }
                        }
                    }
                }
            }
            function tick() {
                const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now;
                const sub = Math.max(1, Math.ceil(dt / 0.01)); for (let k = 0; k < sub; k++) step(dt / sub);
                let alive = 0; const out = new Float32Array(P.length * 8);
                for (let i = 0; i < P.length; i++) { const p = P[i], o = i * 8; out[o] = p.x; out[o + 1] = p.y; out[o + 2] = p.z; out[o + 3] = p.qx; out[o + 4] = p.qy; out[o + 5] = p.qz; out[o + 6] = p.qw; out[o + 7] = p.dead ? 0 : 1; if (!p.dead) alive++; }
                scope.postMessage({ t: 'state', buf: out }, [out.buffer]);
                if (!alive && timer) { clearInterval(timer); timer = null; }
            }
            scope.onmessage = e => {
                const d = e.data;
                if (d.t === 'init') { grid = d.grid; size = d.size; cs = d.cs; floor = d.floor; ceil = d.ceil; P = []; }
                else if (d.t === 'clear') { P = []; if (timer) { clearInterval(timer); timer = null; } }
                else if (d.t === 'spawn') {
                    const a = d.data, n = a.length / 15;
                    for (let i = 0; i < n; i++) { const o = i * 15; P.push({ x: a[o], y: a[o + 1], z: a[o + 2], vx: a[o + 3], vy: a[o + 4], vz: a[o + 5], qx: a[o + 6], qy: a[o + 7], qz: a[o + 8], qw: a[o + 9], wx: a[o + 10], wy: a[o + 11], wz: a[o + 12], r: a[o + 13], life: a[o + 14], age: 0, sleep: false, dead: false }); }
                    if (!timer) { last = performance.now(); timer = setInterval(tick, 16); }
                }
            };
        }
        const GrenadeSys = {
            thrown: [], pieces: [], latest: null, worker: null, threaded: false, gridRef: null, ring: null, light: null, boom: null, fxT: 0, _bt: 0,
            GRENADE_STUN: 8, // seconds within 3m (x4 within 1m)
            initWorker() {
                if (this.worker) return;
                try {
                    const src = '(' + makeDebrisSim.toString() + ')(self);';
                    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
                    w.onmessage = e => { if (e.data && e.data.t === 'state') this.latest = e.data.buf; };
                    w.onerror = () => { try { w.terminate(); } catch (e) {} this.worker = null; this.threaded = false; this.initFallback(); };
                    this.worker = w; this.threaded = true;
                } catch (e) { this.initFallback(); }
            },
            initFallback() { // no workers (blocked / unsupported): same simulation, main thread
                const scope = { onmessage: null, postMessage: m => { if (m && m.t === 'state') this.latest = m.buf; } };
                makeDebrisSim(scope); this.worker = { postMessage: m => scope.onmessage({ data: m }) }; this.threaded = false;
            },
            initFx() {
                if (this.ring) return; shotFxInit();
                this.ring = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 44), new THREE.MeshBasicMaterial({ color: 0xffc27a, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
                this.ring.rotation.x = -Math.PI / 2; this.ring.visible = false; this.ring.frustumCulled = false;
                this.light = new THREE.PointLight(0xffb060, 0, 28, 1.3); camera.add(this.light); // permanent (intensity 0 until a blast): no shader recompile when it goes off
            },
            warm() { this.initWorker(); this.initFx(); return [this.ring]; }, // called while you are in the shop
            syncLevel() { // new level (new grid object): throw away anything still flying
                if (this.gridRef === GameState.grid) return;
                this.thrown.forEach(t => scene.remove(t.mesh)); this.thrown = [];
                this.pieces.forEach(p => { scene.remove(p.mesh); }); this.pieces = []; this.latest = null;
                this.gridRef = GameState.grid; if (!GameState.grid) return; this.initWorker();
                const size = GameState.gridSize || GameState.grid.length, g = new Uint8Array(size * size);
                for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) g[z * size + x] = GameState.grid[z] && GameState.grid[z][x] === 1 ? 1 : 0;
                this.worker.postMessage({ t: 'init', grid: g, size, cs: GameState.cellSize, floor: GameState.poolFl ? -3 : 0, ceil: (LevelData[GameState.level] || {}).ceilH || 4 });
            },
            // ---------- throwing ----------
            throwIt() {
                if (GameState.inShop) { showEventBanner('THE SHOPKEEPER WOULD NOT APPRECIATE THAT', 2); return false; }
                this.syncLevel();
                const vr = !!(window.__vrAim), dir = new THREE.Vector3(), o = new THREE.Vector3();
                if (vr) { dir.copy(window.__vrAim); o.copy(window.__vrMuzzle || camera.getWorldPosition(new THREE.Vector3())); } else { camera.getWorldDirection(dir); camera.getWorldPosition(o); }
                dir.normalize(); o.addScaledVector(dir, 0.55); if (!vr) o.y -= 0.12;
                const mesh = buildItemModel('grenade'); mesh.position.copy(o); scene.add(mesh);
                this.thrown.push({ mesh, pos: o.clone(), vel: dir.clone().multiplyScalar(15).add(new THREE.Vector3(0, 2.6, 0)), w: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, 9 + Math.random() * 4), fuse: 2.6, beep: 0, lastBounce: 0 });
                try { AudioSys.playDrop(); } catch (e) {}
                return true;
            },
            stepThrown(t, dt) {
                const r = 0.09, cs = GameState.cellSize, g = GameState.grid, pf = GameState.poolFl, cl = GameState.colliders || [], ceil = (LevelData[GameState.level] || {}).ceilH || 4, p = t.pos, v = t.vel;
                v.y -= 16 * dt; p.addScaledVector(v, dt);
                const gx = Math.round(p.x / cs), gz = Math.round(p.z / cs); let floor = pf && pf[gz] ? (pf[gz][gx] || 0) : 0;
                for (const c of cl) {
                    const dx = p.x - c.x, dz = p.z - c.z; if (dx * dx + dz * dz > (c.r + r) * (c.r + r)) continue;
                    const lx = c.cos * dx - c.sin * dz, lz = c.sin * dx + c.cos * dz, qx = Math.max(-c.hw, Math.min(c.hw, lx)), qz = Math.max(-c.hd, Math.min(c.hd, lz)), ex = lx - qx, ez = lz - qz, d2 = ex * ex + ez * ez;
                    if (c.h < 50 && p.y - r >= c.h - 0.12) { if (d2 < r * r) floor = Math.max(floor, c.h); continue; }
                    if (p.y - r > c.h) continue;
                    let nx, nz, pen;
                    if (d2 > 1e-8) { const d = Math.sqrt(d2); nx = ex / d; nz = ez / d; pen = r - d; if (pen <= 0) continue; }
                    else { const px = c.hw - Math.abs(lx), pz = c.hd - Math.abs(lz); if (px < pz) { nx = lx < 0 ? -1 : 1; nz = 0; pen = px + r; } else { nx = 0; nz = lz < 0 ? -1 : 1; pen = pz + r; } }
                    const wx = c.cos * nx + c.sin * nz, wz = -c.sin * nx + c.cos * nz; p.x += wx * pen; p.z += wz * pen;
                    const vn = v.x * wx + v.z * wz; if (vn < 0) { v.x -= 1.5 * vn * wx; v.z -= 1.5 * vn * wz; this.clink(t, -vn); }
                }
                for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
                    const cx = gx + dx, cz = gz + dz; if (!g[cz] || g[cz][cx] !== 1) continue;
                    const nx = Math.max(cx * cs - cs / 2, Math.min(cx * cs + cs / 2, p.x)), nz = Math.max(cz * cs - cs / 2, Math.min(cz * cs + cs / 2, p.z));
                    let ex = p.x - nx, ez = p.z - nz; const d2 = ex * ex + ez * ez; if (d2 >= r * r) continue;
                    if (d2 > 1e-8) { const d = Math.sqrt(d2); ex /= d; ez /= d; p.x = nx + ex * r; p.z = nz + ez * r; const vn = v.x * ex + v.z * ez; if (vn < 0) { v.x -= 1.45 * vn * ex; v.z -= 1.45 * vn * ez; this.clink(t, -vn); } }
                    else { const ox = p.x - cx * cs, oz = p.z - cz * cs; if (Math.abs(ox) > Math.abs(oz)) { p.x = cx * cs + (ox < 0 ? -1 : 1) * (cs / 2 + r); v.x *= -0.4; } else { p.z = cz * cs + (oz < 0 ? -1 : 1) * (cs / 2 + r); v.z *= -0.4; } }
                }
                if (p.y < floor + r) { p.y = floor + r; if (v.y < -0.9) this.clink(t, -v.y); v.y = v.y < -0.9 ? v.y * -0.42 : 0; v.x *= 0.78; v.z *= 0.78; t.w.multiplyScalar(0.75); }
                if (p.y > ceil - r) { p.y = ceil - r; if (v.y > 0) v.y *= -0.4; }
                if (p.y <= floor + r + 0.002) { const f = Math.exp(-2.4 * dt); v.x *= f; v.z *= f; }
            },
            clink(t, speed) { const now = performance.now(); if (speed < 2 || now - t.lastBounce < 90) return; t.lastBounce = now; try { Attraction._burst(t.pos.x, t.pos.z, { f: 2600, q: 1.4, dur: 0.07, vol: Math.min(0.55, 0.12 + speed * 0.04), rate: 1.3 }); } catch (e) {} },
            // ---------- the blast ----------
            explode(pos) {
                this.initFx(); const S = ShotFx, P = controls.getObject().position;
                // visuals: a handful of pooled-style sprites (reusing the shotgun FX), a shockwave ring, one permanent light
                shotSprite('flash', pos, 0.22, 1.2, 7.5, 0); shotSprite('spark', pos, 0.45, 0.8, 3.2, 0);
                for (let i = 0; i < 20; i++) { const a = Math.random() * 6.283, e = Math.random() * 1.2 - 0.2, sp = 6 + Math.random() * 9; shotSprite('spark', pos, 0.3 + Math.random() * 0.35, 0.18, 0.45, 0, new THREE.Vector3(Math.cos(a) * Math.cos(e) * sp, Math.sin(e) * sp * 0.8 + 1, Math.sin(a) * Math.cos(e) * sp)); }
                for (let i = 0; i < 8; i++) { const a = Math.random() * 6.283; shotSprite('smoke', pos, 1.5 + Math.random() * 1.2, 0.5, 2.8 + Math.random() * 1.4, 0, new THREE.Vector3(Math.cos(a) * (1 + Math.random() * 2.5), 0.8 + Math.random() * 1.4, Math.sin(a) * (1 + Math.random() * 2.5))); }
                if (this.ring.parent !== scene) scene.add(this.ring); this.ring.position.set(pos.x, Math.max(0.06, pos.y - 0.05), pos.z); this.ring.visible = true; this.fxT = 0.38; this.boom = pos.clone();
                camera.updateWorldMatrix(true, false); this.light.position.copy(camera.worldToLocal(pos.clone()));
                const dp = Math.hypot(P.x - pos.x, P.z - pos.z); GameState.oceanShake = Math.max(GameState.oceanShake || 0, 1.15 * Math.max(0, 1 - dp / 24));
                try { Attraction.sfxThud(pos.x, pos.z, true); Attraction._burst(pos.x, pos.z, { f: 1800, q: 0.6, dur: 0.3, vol: 1, type: 'highpass', rate: 1.2 }); Attraction._burst(pos.x, pos.z, { f: 140, q: 0.7, dur: 0.9, vol: 1, type: 'lowpass', rate: 0.45 }); } catch (e) {}
                // victims
                const box = new THREE.Box3(), cp = new THREE.Vector3(), cs = GameState.cellSize, g = GameState.grid;
                const blocked = (a, b) => { const n = Math.ceil(a.distanceTo(b) / 0.3); for (let i = 1; i < n; i++) { const k = i / n, x = a.x + (b.x - a.x) * k, z = a.z + (b.z - a.z) * k; if (g[Math.round(z / cs)] && g[Math.round(z / cs)][Math.round(x / cs)] === 1) return true; } return false; };
                let n3 = 0, n1 = 0, nD = 0;
                for (const ent of GameState.entities.slice()) {
                    if (!ent.mesh) continue; box.setFromObject(ent.mesh); box.clampPoint(pos, cp); const d = cp.distanceTo(pos);
                    if (d > 3) { if (d < 40) { try { ent.alertToPosition(pos.clone(), 10); } catch (e) {} } continue; } // the bang is loud
                    if (ent._minion) { try { Attraction.hitMinion(ent); } catch (e) {} n3++; continue; }
                    if (d < 0.5 && !MP.active) { this.dismantle(ent, pos); nD++; continue; } // (multiplayer: entities are host-synced, so the close blast just stuns 4x there)
                    if (d >= 1 && blocked(pos, cp)) continue; // behind a wall: only the very close blast counts
                    const secs = this.GRENADE_STUN * (d < 1 ? 4 : 1); ent.stunImmuneTimer = 0; ent.stun(Math.max(secs, ent.stunTimer || 0)); try { recordStun(ent.type); } catch (e) {}
                    if (d < 1) n1++; else n3++;
                }
                if (nD) showEventBanner('...', 1.2); else if (n1 || n3) showEventBanner(n1 ? 'DIRECT HIT: STUNNED x4' : 'STUNNED', 1.6);
            },
            dismantle(ent, center) { // find every joint, tear it off, fire it outward, remove the entity
                const root = ent.mesh; root.updateMatrixWorld(true);
                const parts = [], bones = [], skinned = [], v = new THREE.Vector3(), q = new THREE.Quaternion(), pcs = [];
                root.traverse(o => { if (o === ent.stunRing) return; if (o.isBone) bones.push(o); else if (o.isSkinnedMesh) skinned.push(o); else if ((o.isMesh || o.isSprite) && o.visible) parts.push(o); });
                const pieces = []; // { mesh, dispose }
                parts.forEach(o => {
                    if (o.isSprite) { // flat monster: shatter it into shards sharing its texture
                        o.getWorldPosition(v); const sc = o.getWorldScale(new THREE.Vector3());
                        for (let i = 0; i < 10; i++) { const s = new THREE.Sprite(o.material); s.scale.set(sc.x * 0.22, sc.x * 0.22, 1); s.position.set(v.x + (Math.random() - 0.5) * sc.x * 0.8, v.y + (Math.random() - 0.5) * sc.y * 0.6, v.z + (Math.random() - 0.5) * 0.4); scene.add(s); pieces.push({ mesh: s, r: 0.1 }); }
                        o.parent.remove(o); return;
                    }
                    scene.attach(o); const sc = o.getWorldScale(new THREE.Vector3()); let r = 0.1;
                    if (o.geometry) { if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); r = o.geometry.boundingSphere.radius * Math.max(sc.x, sc.y, sc.z); }
                    pieces.push({ mesh: o, r: Math.max(0.04, Math.min(0.45, r)), dispose: true });
                });
                if (bones.length) { // custom rigged model: one flung limb segment per bone (joint)
                    const mat = (skinned[0] && (Array.isArray(skinned[0].material) ? skinned[0].material[0] : skinned[0].material)) || new THREE.MeshStandardMaterial({ color: 0x3a2a24, roughness: 0.8 });
                    const step = Math.max(1, Math.ceil(bones.length / 60)), up = new THREE.Vector3(0, 1, 0), a = new THREE.Vector3(), b = new THREE.Vector3();
                    bones.forEach((bn, i) => {
                        if (i % step) return; bn.getWorldPosition(a); const ch = bn.children.find(c => c.isBone); let len = 0.14;
                        if (ch) { ch.getWorldPosition(b); len = Math.max(0.08, a.distanceTo(b)); } else b.copy(a).add(new THREE.Vector3(0, 0.12, 0));
                        const m = new THREE.Mesh(new THREE.CylinderGeometry(Math.min(0.07, len * 0.14), Math.min(0.09, len * 0.18), len, 6), mat); m.position.copy(a).add(b).multiplyScalar(0.5); m.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize()); scene.add(m); pieces.push({ mesh: m, r: Math.max(0.05, Math.min(0.3, len * 0.45)), dispose: true });
                    });
                    skinned.forEach(s => { s.visible = false; });
                }
                scene.remove(root); const k = GameState.entities.indexOf(ent); if (k >= 0) GameState.entities.splice(k, 1);
                this.syncLevel(); const data = new Float32Array(pieces.length * 15), base = this.pieces.length, now = performance.now();
                pieces.forEach((pc, i) => {
                    const m = pc.mesh, o = i * 15; m.getWorldPosition(v); m.getWorldQuaternion(q);
                    let dx = v.x - center.x, dy = v.y - center.y, dz = v.z - center.z; const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
                    if (dl < 0.05) { dx = Math.random() - 0.5; dz = Math.random() - 0.5; dy = 0.3; }
                    const sp = 8 + Math.random() * 10, life = 14 + Math.random() * 6;
                    data.set([v.x, v.y, v.z, dx * sp + (Math.random() - 0.5) * 3, dy * sp * 0.6 + 4 + Math.random() * 5, dz * sp + (Math.random() - 0.5) * 3, q.x, q.y, q.z, q.w, (Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24, (Math.random() - 0.5) * 24, pc.r, life], o);
                    this.pieces.push({ mesh: m, life, t0: now, s0: m.scale.clone(), dispose: pc.dispose });
                });
                this.worker.postMessage({ t: 'spawn', data }, [data.buffer]);
                try { Attraction._burst(center.x, center.z, { f: 420, q: 0.8, dur: 0.5, vol: 0.9, type: 'lowpass', rate: 0.7 }); } catch (e) {}
            },
            // ---------- per frame ----------
            tick(dt) {
                this.syncLevel();
                for (let i = this.thrown.length - 1; i >= 0; i--) {
                    const t = this.thrown[i]; const n = Math.max(1, Math.ceil(dt / 0.008)); for (let k = 0; k < n; k++) this.stepThrown(t, dt / n);
                    t.mesh.position.copy(t.pos); t.mesh.rotation.x += t.w.x * dt; t.mesh.rotation.y += t.w.y * dt; t.mesh.rotation.z += t.w.z * dt;
                    t.fuse -= dt; t.beep -= dt; if (t.beep <= 0 && t.fuse > 0) { t.beep = Math.max(0.12, t.fuse * 0.28); try { Attraction._burst(t.pos.x, t.pos.z, { f: 3200, q: 3, dur: 0.05, vol: 0.28 }); } catch (e) {} }
                    if (t.fuse <= 0) { scene.remove(t.mesh); this.thrown.splice(i, 1); this.explode(t.pos.clone()); }
                }
                const L = this.latest;
                if (L && this.pieces.length) {
                    const now = performance.now(), cnt = Math.min(this.pieces.length, (L.length / 8) | 0);
                    for (let i = 0; i < cnt; i++) {
                        const pc = this.pieces[i]; if (pc.gone) continue; const o = i * 8;
                        if (!L[o + 7]) { scene.remove(pc.mesh); if (pc.dispose && pc.mesh.geometry) pc.mesh.geometry.dispose(); pc.gone = true; continue; }
                        pc.mesh.position.set(L[o], L[o + 1], L[o + 2]); pc.mesh.quaternion.set(L[o + 3], L[o + 4], L[o + 5], L[o + 6]);
                        const left = pc.life - (now - pc.t0) / 1000; if (left < 1.2) pc.mesh.scale.copy(pc.s0).multiplyScalar(Math.max(0.01, left / 1.2));
                    }
                }
                if (this.fxT > 0) {
                    this.fxT -= dt; const k = Math.max(0, this.fxT / 0.38);
                    this.ring.scale.setScalar(0.4 + 6.4 * (1 - k)); this.ring.material.opacity = 0.9 * k; this.light.intensity = this.fxT > 0.2 ? 90 * ((this.fxT - 0.2) / 0.18) : 0;
                    if (this.fxT <= 0) { this.ring.visible = false; this.light.intensity = 0; }
                }
            }
        };
        function grenadeTick(dt) { GrenadeSys.tick(dt); }

        // ===== VR physics: pickups are real objects (gravity, bounce, walls, furniture, hands bump them) =====
        const _pb = new THREE.Box3(), _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3(), _pq = new THREE.Quaternion();
        const REST_UP = { coin: [0, 0, 1], tracker: [0, 0, 1], chest_locator: [0, 0, 1], battery: [1, 0, 0], battery_core: [1, 0, 0], mega_battery: [1, 0, 0] };
        function phInit(m) { _pb.setFromObject(m); const s = _pb.getSize(_p1); return m.userData.ph = { v: new THREE.Vector3(), w: new THREE.Vector3(), r: Math.max(0.07, Math.min(0.25, 0.55 * Math.cbrt(Math.max(1e-4, s.x * s.y * s.z)))), sleep: false }; }
        function vrPhys(dt, hands) {
            const g = GameState.grid, cs = GameState.cellSize; if (!g || !GameState.items) return; dt = Math.min(dt, 0.033) || 0.016;
            const L = LevelData[GameState.level] || {}, ceil = L.ceilH || 4, pf = GameState.poolFl, cl = GameState.colliders || [];
            for (const it of GameState.items) {
                const m = it.mesh, ty = m.userData && m.userData.type; if (!ty || FLOOR_Y[ty] === undefined) continue;
                const ph = m.userData.ph || phInit(m);
                for (const h of hands) { if (h.held) continue; _p1.copy(m.position).sub(h.p); const d = _p1.length(), rr = ph.r + 0.1;
                    if (d < rr && d > 1e-4) { _p1.multiplyScalar(1 / d); m.position.addScaledVector(_p1, rr - d); ph.v.addScaledVector(_p1, Math.max(0, h.v.dot(_p1)) * 1.1 + 0.4); ph.v.addScaledVector(h.v, 0.35); ph.w.add(_p2.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(6)); ph.sleep = false; } }
                if (ph.sleep) continue;
                const gx = Math.round(m.position.x / cs), gz = Math.round(m.position.z / cs); let fy = pf && pf[gz] ? (pf[gz][gx] || 0) : 0, wet = fy < -0.3 && m.position.y < -0.22;
                ph.v.y += (wet ? -3 : -9.8) * dt; if (wet) { ph.v.multiplyScalar(Math.exp(-2.5 * dt)); ph.w.multiplyScalar(Math.exp(-2 * dt)); }
                m.position.addScaledVector(ph.v, dt);
                const wl = ph.w.length(); if (wl > 1e-3) { _pq.setFromAxisAngle(_p1.copy(ph.w).divideScalar(wl), wl * dt); m.quaternion.premultiply(_pq); }
                for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
                    const cx = gx + dx, cz = gz + dz; if (!g[cz] || g[cz][cx] !== 1) continue;
                    const nx = Math.max(cx * cs - cs / 2, Math.min(cx * cs + cs / 2, m.position.x)), nz = Math.max(cz * cs - cs / 2, Math.min(cz * cs + cs / 2, m.position.z));
                    let ex = m.position.x - nx, ez = m.position.z - nz; const d2 = ex * ex + ez * ez;
                    if (d2 < ph.r * ph.r) {
                        if (d2 > 1e-8) { const d = Math.sqrt(d2); ex /= d; ez /= d; m.position.x = nx + ex * ph.r; m.position.z = nz + ez * ph.r; const vn = ph.v.x * ex + ph.v.z * ez; if (vn < 0) { ph.v.x -= 1.4 * vn * ex; ph.v.z -= 1.4 * vn * ez; ph.w.y += (Math.random() - 0.5) * 3; } }
                        else { const ox = m.position.x - cx * cs, oz = m.position.z - cz * cs; if (Math.abs(ox) > Math.abs(oz)) { m.position.x = cx * cs + Math.sign(ox || 1) * (cs / 2 + ph.r); ph.v.x *= -0.4; } else { m.position.z = cz * cs + Math.sign(oz || 1) * (cs / 2 + ph.r); ph.v.z *= -0.4; } }
                    }
                }
                for (const c of cl) { // furniture / crates / chests: oriented boxes
                    const dx = m.position.x - c.x, dz = m.position.z - c.z; if (dx * dx + dz * dz > (c.r + ph.r) * (c.r + ph.r)) continue;
                    const lx = c.cos * dx - c.sin * dz, lz = c.sin * dx + c.cos * dz, qx = Math.max(-c.hw, Math.min(c.hw, lx)), qz = Math.max(-c.hd, Math.min(c.hd, lz)), ex = lx - qx, ez = lz - qz, d2 = ex * ex + ez * ez;
                    const low = c.h < 50, bot = m.position.y - ph.r;
                    if (low && bot >= c.h - 0.12) { if (d2 < ph.r * ph.r) fy = Math.max(fy, c.h); continue; } // above a low box: it can land on top
                    if (d2 < ph.r * ph.r && d2 > 1e-8) { const d = Math.sqrt(d2), nl = ex / d, nm = ez / d, wx = c.cos * nl + c.sin * nm, wz = -c.sin * nl + c.cos * nm, push = ph.r - d; m.position.x += wx * push; m.position.z += wz * push; const vn = ph.v.x * wx + ph.v.z * wz; if (vn < 0) { ph.v.x -= 1.4 * vn * wx; ph.v.z -= 1.4 * vn * wz; } }
                    else if (d2 <= 1e-8 && low) { const px = c.hw - Math.abs(lx), pz = c.hd - Math.abs(lz), nl = px < pz ? Math.sign(lx || 1) : 0, nm = px < pz ? 0 : Math.sign(lz || 1), mv = (px < pz ? px : pz) + ph.r; m.position.x += (c.cos * nl + c.sin * nm) * mv; m.position.z += (-c.sin * nl + c.cos * nm) * mv; }
                }
                _pb.setFromObject(m); let contact = false;
                if (_pb.min.y < fy) { m.position.y += fy - _pb.min.y; if (ph.v.y < 0) ph.v.y = -ph.v.y * 0.32; if (Math.abs(ph.v.y) < 0.7) ph.v.y = 0; const f = Math.exp(-7 * dt); ph.v.x *= f; ph.v.z *= f; ph.w.multiplyScalar(Math.exp(-5 * dt)); contact = true; }
                if (_pb.max.y > ceil) { m.position.y -= _pb.max.y - ceil; if (ph.v.y > 0) ph.v.y *= -0.3; }
                if (contact && ph.v.length() < 0.4 && ph.w.length() < 3) { // settle flat / upright like a real object
                    const ru = REST_UP[ty] || [0, 1, 0]; _p1.set(ru[0], ru[1], ru[2]).applyQuaternion(m.quaternion); const tgt = (_p1.y >= 0 || ty === 'cake') ? 1 : -1;
                    _p2.crossVectors(_p1, new THREE.Vector3(0, tgt, 0)); const sn = _p2.length();
                    if (sn > 0.015) { _pq.setFromAxisAngle(_p2.divideScalar(sn), Math.min(Math.asin(Math.min(1, sn)), dt * 5)); m.quaternion.premultiply(_pq); }
                    else if (ph.v.length() < 0.05 && ph.w.length() < 0.08) ph.sleep = true;
                }
            }
        }
        function vrDrop(id, am, pos, vel, ctl) {
            spawnPickup(id, pos.x, pos.z); const m = GameState.items[GameState.items.length - 1].mesh; m.position.copy(pos);
            if (ctl) m.quaternion.copy(ctl.getWorldQuaternion(new THREE.Quaternion())); if (am != null) m.userData.ammo = am;
            const ph = phInit(m); if (vel) ph.v.copy(vel); ph.w.set((Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 4); return m;
        }
        function foreHold(h, hp) { // is this hand reaching for the foregrip of a shotgun the OTHER hand is holding?
            const oh = h === 'left' ? 'right' : 'left', H2 = VR.held[oh], i2 = VR.ctl.findIndex(c => c.userData.src && c.userData.src.handedness === oh); if (!H2 || i2 < 0) return false;
            const it2 = GameState.inv[H2.slot]; if (!it2 || it2.id !== 'shotgun') return false;
            return hp.distanceTo(VR.ctl[i2].localToWorld(new THREE.Vector3(0, -0.03, -0.45))) < 0.4;
        }

        // ===== VR SUPPORT (WebXR) - patch =====
        const VR = { on: false, sess: null, rig: new THREE.Group(), cam: new THREE.PerspectiveCamera(70, 1, 0.05, 120), hg: new THREE.Group(), ctl: [], grip: [], rr: null, held: {}, q: [], fl: { at: 'hol' }, kb: null, fog: (() => { try { return localStorage.getItem('vr_clearfog') === '1'; } catch (e) { return false; } })(), mod: [], sph: [], prev: {}, snap: 0, yaw: 0, dead: false, hand: {}, rows: [], H: 0, scroll: 0, ovEl: null, mt: 0, hov: -1, lt: 0, slHov: -1 };
        window.__vrCam = VR.cam; VR.rig.add(VR.cam);
        const _raf = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = cb => cb === gameLoop ? (VR.on ? 0 : _raf(t => { if (VR.on) VR.dead = true; else gameLoop(t); })) : (VR.on ? (VR.q.push(cb), 0) : _raf(cb));
        { const st = document.createElement('style'); st.textContent = 'body.vr #ui-layer,body.vr #vhs-hud,body.vr #shop-prompt{display:none!important}body.vr .gfx-btn[data-gfx="rtx"],body.vr .gfx-btn[data-gfx="custom"],body.vr #real-cb{opacity:.3;pointer-events:none}'; document.head.appendChild(st); }
        const NATIVE = ['shotgun', 'crowbar', 'axe']; // shown at true size in your hand
        const HOL = [[-.3, .05], [-.27, -.12], [.3, .05], [.27, -.12], [0, -.22], [0, .2]], EAT = ['water', 'cake', 'lucid_pill', 'sprint_tonic'];
        // ---- mirror of whatever desktop menu is open (same buttons, toggles, sliders, colours) ----
        const OVS = ['mp-chat-panel', 'mp-room', 'mp-join', 'mp-create', 'mp-menu', 'dbg-level-panel', 'dbg-audio-panel', 'lol-panel', 'settings-modal', 'shop-screen', 'ach-modal', 'sfx-panel', 'upd-panel', 'pause-menu', 'death-screen', 'start-screen'];
        const vis = e => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
        const ovActive = () => { for (const id of OVS) { const e = document.getElementById(id); if (vis(e)) return e; } return null; };
        const mcv = document.createElement('canvas'); mcv.width = 640; mcv.height = 768; const mcx = mcv.getContext('2d'), mtex = new THREE.CanvasTexture(mcv);
        const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.28, 1.536), new THREE.MeshBasicMaterial({ map: mtex }));
        const wrapT = (txt, font, w) => { mcx.font = font; const out = []; let ln = ''; for (const wd of txt.split(' ')) { const t = ln ? ln + ' ' + wd : wd; if (mcx.measureText(t).width > w && ln) { out.push(ln); ln = wd; } else ln = t; } if (ln) out.push(ln); return out.slice(0, 4); };
        function vrKbLayout() {
            const rows = []; let y = 16; const add = (r, h) => { r.y0 = y; r.y1 = y + h; y += h + 8; rows.push(r); };
            add({ k: 't', lines: [VR.kb.title || 'ENTER CODE'], font: 'bold 28px monospace', fg: '#e6c84c' }, 36); add({ k: 't', lines: [VR.kb.text + '_'], font: 'bold 34px monospace', fg: '#fff' }, 44); add({ k: 't', lines: [VR.kb.msg || ''], font: '20px monospace', fg: '#7bff8a' }, 28);
            ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'].forEach(l => add({ k: 'g', keys: [...l] }, 56)); if (VR.kb.el) add({ k: 'g', keys: ['SPACE', '-', '_', '.', '!', '?'] }, 56); add({ k: 'g', keys: ['DEL', 'ENTER', 'BACK'] }, 56); VR.rows = rows; VR.H = y + 10;
        }
        function vrLayout(root) {
            if (VR.kb) return vrKbLayout();
            const rows = []; let y = 16;
            const push = (r, fs, h) => { r.lines = wrapT(r.txt, r.font, 560); r.y0 = y; r.y1 = y + Math.max(h || 0, r.lines.length * fs * 1.25 + (r.k === 't' ? 4 : 18)); y = r.y1 + (r.k === 't' ? 2 : 8); rows.push(r); };
            const walk = el => {
                if (!vis(el) || ['SCRIPT', 'STYLE', 'CANVAS', 'svg', 'TEXTAREA'].includes(el.tagName) || el.id === 'enter-vr-btn') return;
                const cs = getComputedStyle(el), tg = el.tagName, fg = cs.color;
                const off = !!(el.disabled || el.matches('[data-gfx="rtx"],[data-gfx="custom"],#real-cb'));
                if (tg === 'BUTTON') { const bg = cs.backgroundColor; push({ k: 'b', el, off, txt: el.textContent.replace(/\s+/g, ' ').trim(), font: 'bold 22px monospace', fg: off ? '#666' : fg, bg: /rgba\(0, 0, 0, 0\)|transparent/.test(bg) ? '#1c1a10' : bg, bd: el.classList.contains('active') ? '#e6c84c' : cs.borderTopColor }, 22, 52); return; }
                if (tg === 'LABEL' && el.querySelector('input[type=checkbox]')) { const i = el.querySelector('input'); const o = i.matches('#real-cb'); push({ k: 'c', el: i, off: o, txt: (i.checked ? '[X] ' : '[  ] ') + el.textContent.replace(/\s+/g, ' ').trim() + (o ? '  (OFF IN VR)' : ''), font: '20px monospace', fg: o ? '#666' : '#ddd', bg: '#14130c', bd: '#444' }, 20, 40); return; }
                if (tg === 'INPUT') { if (el.type === 'text' && el.dataset.vrkb) { push({ k: 'i', el, txt: (el.dataset.label || 'TEXT') + ': ' + (el.value || '(TAP TO TYPE)'), font: 'bold 20px monospace', fg: '#4dd0e1', bg: '#14130c', bd: '#4dd0e1' }, 20, 48); return; } if (el.type === 'range') push({ k: 'r', el, txt: '<   ' + el.value + '   >', font: 'bold 22px monospace', fg: '#e6c84c', bg: '#14130c', bd: '#444' }, 22, 40); return; }
                if (tg === 'SELECT') { push({ k: 's', el, txt: '< ' + (el.selectedOptions[0] ? el.selectedOptions[0].text : '') + ' >', font: 'bold 20px monospace', fg: '#e6c84c', bg: '#14130c', bd: '#444' }, 20, 40); return; }
                if (el.tagName === 'B' && /-v$/.test(el.id)) return;
                const own = [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').replace(/\s+/g, ' ').trim();
                if (own) { const fs = Math.max(15, Math.min(30, parseFloat(cs.fontSize) * 0.8)); push({ k: 't', txt: own, font: (+cs.fontWeight >= 600 ? 'bold ' : '') + fs + 'px monospace', fg, fs }, fs); }
                [...el.children].forEach(walk);
            };
            walk(root);
            if (root.id === 'settings-modal') push({ k: 'f', txt: 'VR: CLEAR FOG - ' + (VR.fog ? 'ON' : 'OFF'), font: 'bold 22px monospace', fg: '#4dd0e1', bg: '#14130c', bd: '#4dd0e1' }, 22, 52);
            if (root.id === 'start-screen' || root.id === 'pause-menu') push({ k: 'k', txt: 'CODE', font: 'bold 22px monospace', fg: '#4dd0e1', bg: '#14130c', bd: '#4dd0e1' }, 22, 52);
            if (root.id === 'start-screen' || root.id === 'pause-menu' || root.id === 'death-screen') push({ k: 'x', txt: 'EXIT VR', font: 'bold 22px monospace', fg: '#e6c84c', bg: '#3a1a1a', bd: '#e6c84c' }, 22, 52);
            VR.rows = rows; VR.H = y + 10;
        }
        function mirrorDraw() {
            mcx.fillStyle = '#0b0b08'; mcx.fillRect(0, 0, 640, 768); mcx.textAlign = 'center';
            VR.rows.forEach((r, i) => {
                const y0 = r.y0 - VR.scroll, y1 = r.y1 - VR.scroll; if (y1 < 0 || y0 > 768) return;
                if (r.k === 'g') { const n = r.keys.length, w = 600 / n; r.keys.forEach((kk, j) => { mcx.fillStyle = VR.hov === i && VR.hx === j ? '#4a4020' : '#1c1a10'; mcx.fillRect(20 + j * w + 2, y0, w - 4, y1 - y0); mcx.strokeStyle = '#e6c84c'; mcx.lineWidth = 2; mcx.strokeRect(20 + j * w + 2, y0, w - 4, y1 - y0); mcx.fillStyle = '#e6c84c'; mcx.font = 'bold 24px monospace'; mcx.fillText(kk, 20 + j * w + w / 2, (y0 + y1) / 2 + 8); }); return; }
                if (r.k !== 't') { mcx.fillStyle = VR.hov === i && !r.off ? '#4a4020' : r.bg; mcx.fillRect(20, y0, 600, y1 - y0); mcx.strokeStyle = r.bd; mcx.lineWidth = 3; mcx.strokeRect(20, y0, 600, y1 - y0); }
                mcx.font = r.font; mcx.fillStyle = r.fg; const fs = parseFloat(r.font.replace('bold ', '')), lh = fs * 1.25, top = r.k === 't' ? y0 + fs : (y0 + y1) / 2 - (r.lines.length - 1) * lh / 2 + fs * 0.35;
                r.lines.forEach((l, j) => mcx.fillText(l, 320, top + j * lh));
            });
            mcx.strokeStyle = '#e6c84c'; mcx.lineWidth = 6; mcx.strokeRect(3, 3, 634, 762); mtex.needsUpdate = true;
        }
        function mirrorAct(r, ux) {
            const e = r.el; if (r.off) return;
            if (r.k === 'x') return VR.sess && VR.sess.end();
            if (r.k === 'f') { VR.fog = !VR.fog; window.__vrFog = VR.fog ? 0.9 : 0; try { localStorage.setItem('vr_clearfog', VR.fog ? '1' : '0'); } catch (x) {} VR.mt = 0; return; }
            if (r.k === 'i') { VR.kb = { text: r.el.value || '', msg: '', title: r.el.dataset.label, max: +r.el.maxLength || 20, el: r.el }; VR.scroll = 0; VR.mt = 0; return; }
            if (r.k === 'k') { VR.kb = { text: '', msg: '' }; VR.scroll = 0; VR.mt = 0; return; }
            if (r.k === 'g') { const n = r.keys.length, kk = r.keys[Math.max(0, Math.min(n - 1, Math.floor((ux * 640 - 20) / 600 * n)))], K = VR.kb;
                if (kk === 'BACK') VR.kb = null; else if (kk === 'DEL') K.text = K.text.slice(0, -1); else if (kk === 'ENTER') { if (K.el) vrKbDone(K); else vrCodeSubmit(K.text); } else if (K.text.length < (K.max || 12)) K.text += (kk === 'SPACE' ? ' ' : kk); VR.mt = 0; return; }
            if (r.k === 'b' || r.k === 'c') e.click();
            else if (r.k === 's') { e.selectedIndex = (e.selectedIndex + 1) % e.options.length; e.dispatchEvent(new Event('change', { bubbles: true })); }
            else if (r.k === 'r') { const mn = +e.min || 0, mx = +e.max || 100, st = (mx - mn) / 10; e.value = Math.max(mn, Math.min(mx, +e.value + (ux > 0.5 ? st : -st))); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }
            VR.mt = 0;
        }
        function vrKbDone(K) { const el = K.el; VR.kb = null; VR.scroll = 0; VR.mt = 0; el.value = K.text; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); if (el.dataset.submit) { const b = document.getElementById(el.dataset.submit); if (b) b.click(); } }
        function vrCodeSubmit(raw) {
            const c = raw.trim().toUpperCase(), K = VR.kb; if (!c) return;
            if (MP.active && ['QWERTY', 'LOL999', 'ABYSS7', 'LMAO111', 'LMAO999', 'PPP999'].includes(c)) { K.msg = 'DISABLED IN MULTIPLAYER'; K.text = ''; return; }
            if (c === 'QWERTY') { // same as Q-W-E-R-T-Y on the desktop menu: the DEBUG ROOM (not the pools)
                VR.kb = null; VR.scroll = 0; try { if (GameState.isRunning) exitToMenu(); enterDebugRoom(); } catch (e) { console.warn('debug room', e); } return;
            }
            if (['LOL999', 'ABYSS7'].includes(c)) {
                if (!GameState.isRunning) { K.msg = 'START A GAME FIRST'; K.text = ''; return; }
                if (GameState.isPaused) resumeGame(); if (window.__vrCode(c)) { VR.kb = null; return; } K.msg = 'NOT AVAILABLE HERE'; return;
            }
            const i = document.getElementById('code-input'), m = document.getElementById('code-msg'); i.value = c; redeemCode(); K.msg = m.textContent; K.text = i.value;
        }
        function vibI(i, a, ms) { try { const g = VR.ctl[i] && VR.ctl[i].userData.src && VR.ctl[i].userData.src.gamepad; if (!g) return; const h = g.hapticActuators && g.hapticActuators[0]; if (h && h.pulse) h.pulse(a, ms); else if (g.vibrationActuator) g.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: a, weakMagnitude: a }); } catch (e) {} }
        const vibH = (h, a, ms) => vibI(VR.ctl.findIndex(c => c.userData.src && c.userData.src.handedness === h), a, ms);
        window.__vrFog = VR.fog ? 0.9 : 0;
        // ---- wrist bars + desktop-style HUD ----
        const hcv = document.createElement('canvas'); hcv.width = 256; hcv.height = 112; const hcx = hcv.getContext('2d'), htex = new THREE.CanvasTexture(hcv);
        const wrist = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.07), new THREE.MeshBasicMaterial({ map: htex, transparent: true })); wrist.rotation.x = -Math.PI / 2; wrist.position.set(0, 0.06, 0.02);
        function wristDraw() {
            const P = GameState.player, B = [['SAN', P.sanity / PermaFx.maxSan(), '#4dd0e1'], ['STA', P.stamina / 100, '#76e04a'], ['BAT', P.battery / 100, '#e6c84c']];
            hcx.clearRect(0, 0, 256, 112); hcx.fillStyle = 'rgba(0,0,0,.65)'; hcx.fillRect(0, 0, 256, 112); hcx.font = 'bold 22px monospace'; hcx.textAlign = 'left';
            B.forEach((b, i) => { hcx.fillStyle = '#ddd'; hcx.fillText(b[0], 6, 30 + i * 34); hcx.fillStyle = '#333'; hcx.fillRect(66, 12 + i * 34, 182, 22); hcx.fillStyle = b[2]; hcx.fillRect(66, 12 + i * 34, 182 * Math.max(0, Math.min(1, b[1] || 0)), 22); });
            htex.needsUpdate = true;
        }
        const ucv = document.createElement('canvas'); ucv.width = 1024; ucv.height = 512; const ucx = ucv.getContext('2d'), utex = new THREE.CanvasTexture(ucv);
        const hud = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.6), new THREE.MeshBasicMaterial({ map: utex, transparent: true, depthTest: false })); hud.renderOrder = 999; hud.visible = false; hud.position.set(0, -0.12, -1.1); VR.cam.add(hud);
        function hudDraw() {
            const tx = id => { const e = document.getElementById(id); return e && getComputedStyle(e).display !== 'none' ? e.textContent.replace(/\[E\]/g, '[Y]').replace('LEFT CLICK / G', 'TRIGGER') : ''; };
            const T = (str, x, y, font, col, al, bg) => { if (!str) return; ucx.font = font; ucx.textAlign = al; if (bg) { const w = ucx.measureText(str).width + 24; ucx.fillStyle = 'rgba(0,0,0,.6)'; ucx.fillRect(al === 'center' ? x - w / 2 : x - 12, y - 38, w, 52); } ucx.fillStyle = col; ucx.fillText(str, x, y); };
            ucx.clearRect(0, 0, 1024, 512);
            T(tx('level-text'), 20, 40, 'bold 34px monospace', '#e6c84c', 'left'); T(tx('objective-text'), 20, 74, '24px monospace', '#ddd', 'left');
            T(tx('difficulty-hud-badge'), 1004, 40, 'bold 24px monospace', '#e6c84c', 'right'); T(tx('lives-hud'), 1004, 72, '22px monospace', '#f66', 'right');
            T(tx('event-banner'), 512, 250, 'bold 38px monospace', '#fff', 'center', 1); T(tx('interaction-prompt'), 512, 330, 'bold 34px monospace', '#e6c84c', 'center', 1);
            T(tx('shotgun-hud'), 512, 380, '24px monospace', '#ff9a4d', 'center'); T(tx('exit-arrow-container') ? tx('exit-arrow-label') : '', 512, 135, 'bold 28px monospace', '#44ff88', 'center');
            for (let i = 0; i < 5; i++) { const x = 312 + i * 80, it = GameState.inv[i]; ucx.fillStyle = 'rgba(0,0,0,.6)'; ucx.fillRect(x, 410, 72, 72); ucx.strokeStyle = i === GameState.invSel ? '#e6c84c' : '#555'; ucx.lineWidth = 4; ucx.strokeRect(x, 410, 72, 72);
                ucx.fillStyle = '#999'; ucx.font = '16px monospace'; ucx.textAlign = 'left'; ucx.fillText(i + 1, x + 5, 427); if (it) { ucx.font = '40px sans-serif'; ucx.textAlign = 'center'; ucx.fillStyle = '#fff'; ucx.fillText(ItemDefs[it.id].icon, x + 36, 462); if (it.count > 1) { ucx.font = 'bold 18px monospace'; ucx.fillText('x' + it.count, x + 54, 478); } } }
            utex.needsUpdate = true;
        }
        function vrModel(id, sz, nat) {
            const m = buildItemModel(id), b = new THREE.Box3().setFromObject(m), sv = b.getSize(new THREE.Vector3()), k = nat ? 1 : sz * (id === 'shotgun' ? 2.4 : 1) / Math.max(sv.x, sv.y, sv.z, 0.01);
            m.scale.multiplyScalar(k); if (!nat) m.position.sub(b.getCenter(new THREE.Vector3()).multiplyScalar(k)); const w = new THREE.Group(); w.add(m); return w;
        }
        function vrTag(o, it) { // floating use counter above Monster Tracker / Chest Locator (VR has no desktop HUD)
            if (!o) return; const mx = it && TOOL_MAX[it.id]; let L = o.userData.tag;
            if (!mx) { if (L) L.visible = false; return; }
            if (!L) { const cv = document.createElement('canvas'); cv.width = 256; cv.height = 96; L = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false })); L.renderOrder = 998; L.scale.set(0.2, 0.075, 1); L.position.set(0, 0.14, 0); L.userData = { cv, key: '' }; o.add(L); o.userData.tag = L; }
            L.visible = true; const now = performance.now(), l1 = it.uses + '/' + mx + ' USES';
            const l2 = it.msg && now < (it.msgUntil || 0) ? it.msg : it.id === 'tracker' ? (it.active > 0 ? 'PING ' + Math.ceil(it.active) + 's' : it.cd > 0 ? 'COOLDOWN ' + Math.ceil(it.cd) + 's' : 'READY') : 'READY', key = l1 + '|' + l2; if (key === L.userData.key) return; L.userData.key = key;
            const c = L.userData.cv.getContext('2d'); c.clearRect(0, 0, 256, 96); c.fillStyle = 'rgba(0,0,0,.7)'; c.fillRect(0, 0, 256, 96); c.strokeStyle = '#e6c84c'; c.lineWidth = 4; c.strokeRect(2, 2, 252, 92);
            c.textAlign = 'center'; c.fillStyle = '#fff'; c.font = 'bold 40px monospace'; c.fillText(l1, 128, 44); c.fillStyle = it.id === 'tracker' && it.active > 0 ? '#ff6a6a' : '#7bff8a'; c.font = 'bold 28px monospace'; c.fillText(l2, 128, 80); L.material.map.needsUpdate = true;
        }
        function vrSet(slot, id, parent, sz, nat) { if (slot.id === id && slot.p === parent) return; if (slot.o) slot.o.removeFromParent(); slot.id = id; slot.p = parent; slot.o = id ? vrModel(id, sz, nat) : null; if (slot.o) parent.add(slot.o); }
        function vrSetup() {
            if (VR.rr === renderer) return; VR.rr = renderer; VR.ctl = []; VR.grip = [];
            for (let i = 0; i < 2; i++) {
                const c = renderer.xr.getController(i), g = renderer.xr.getControllerGrip(i);
                [c, g].forEach(o => { o.addEventListener('connected', e => { o.userData.src = e.data; }); o.addEventListener('disconnected', () => { o.userData.src = null; }); VR.rig.add(o); });
                g.add(new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffdd00 })));
                const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]), new THREE.LineBasicMaterial({ color: 0xffdd00 })); ln.visible = false; c.add(ln); c.userData.ln = ln;
                VR.ctl.push(c); VR.grip.push(g);
            }
            if (!VR.flm) { const M = c => new THREE.MeshBasicMaterial({ color: c }), fm = new THREE.Group(), bd = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.16, 12), M(0x333333)), hd = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.022, 0.05, 12), M(0x666666)); bd.rotation.x = hd.rotation.x = Math.PI / 2; hd.position.z = -0.1;
                VR.lens = new THREE.Mesh(new THREE.CircleGeometry(0.03, 12), M(0x555544)); VR.lens.position.z = -0.126; VR.lens.rotation.y = Math.PI; fm.add(bd, hd, VR.lens); VR.flm = fm;
                const ar = new THREE.Group(), sh = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.07, 8), M(0x44ff88)), cn = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.05, 10), M(0x44ff88)); sh.rotation.x = Math.PI / 2; cn.rotation.x = Math.PI / 2; cn.position.z = 0.06; ar.add(sh, cn); ar.position.set(0, 0.14, 0); ar.visible = false; VR.arr = ar; }
            if (!VR.sph.length) for (let i = 0; i < 6; i++) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.11, 20, 14), new THREE.MeshBasicMaterial({ color: i === 5 ? 0xffa020 : 0x2f7bff, transparent: true, opacity: 0.35, depthWrite: false })); VR.hg.add(m); VR.sph.push(m); }
        }
        async function vrStart() {
            try {
                const s = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
                window.__vrOn = true; VR.on = true; VR.sess = s; document.body.classList.add('vr');
                VR.prevReal = Settings.real; if (Settings.real) { Settings.real = false; applyReal(); }
                if (GameState.graphicsPreset === 'rtx' || GameState.graphicsPreset === 'custom') selectGraphicsPreset('high');
                vrSetup(); VR.flm.add(flashLight, flashLight.target); flashLight.position.set(0, 0, -0.13); flashLight.target.position.set(0, 0, -6); VR.fl.at = 'hol'; renderer.xr.enabled = true; renderer.xr.setReferenceSpaceType('local-floor'); await renderer.xr.setSession(s);
                s.addEventListener('end', vrEnd); VR.ovEl = null; renderer.setAnimationLoop(vrFrame);
            } catch (e) { console.warn('VR failed', e); vrEnd(); }
        }
        function vrEnd() {
            if (!VR.on) return; clearVRHands(); renderer.setAnimationLoop(null); renderer.xr.enabled = false; VR.on = window.__vrOn = false; document.body.classList.remove('vr');
            VR.rig.removeFromParent(); VR.hg.removeFromParent(); panel.removeFromParent(); VR.sess = null; VR.held = {}; VR.flm.removeFromParent(); camera.add(flashLight, flashLight.target); flashLight.position.set(0.2, -0.2, 0); flashLight.target.position.set(0, -0.2, -5); VR.q.splice(0).forEach(cb => _raf(cb)); if (VR.prevReal) { Settings.real = true; applyReal(); }
            if (VR.dead) { VR.dead = false; requestAnimationFrame(gameLoop); }
        }
        const _wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
        function vrDbgFrame(t, lg, rg, ax, bt, edge) { // debug room in VR: left stick = move, right stick = snap turn, right grip = run, Y / either trigger = use the nearest terminal
            const R = VR.rig, p = camera.position, hl = VR.cam.position;
            const sx = ax(rg, 2); if (Math.abs(sx) > 0.7 && t > VR.snap) { R.rotation.y -= Math.sign(sx) * Math.PI / 6; VR.snap = t + 300; }
            const c2 = Math.cos(R.rotation.y), s2 = Math.sin(R.rotation.y); R.position.set(p.x - (hl.x * c2 + hl.z * s2), p.y - 1.7, p.z - (-hl.x * s2 + hl.z * c2)); R.updateMatrixWorld(true);
            const d = VR.cam.getWorldDirection(new THREE.Vector3()), yaw = Math.atan2(-d.x, -d.z), pit = Math.asin(Math.max(-1, Math.min(1, d.y))); camera.rotation.set(pit, yaw, 0, 'YXZ'); camera.updateMatrix(); LOOK.yaw = yaw; LOOK.pitch = pit;
            const sy = ax(lg, 3), sw = ax(lg, 2), D = 0.3; keys.w = sy < -D; keys.s = sy > D; keys.a = sw < -D; keys.d = sw > D; keys.shift = bt(rg, 4);
            VR.ctl.forEach(c => { c.userData.ln.visible = false; });
            if (edge('dY', bt(lg, 5)) | edge('dTl', bt(lg, 0)) | edge('dTr', bt(rg, 0))) debugInteract();
            gameLoop(t);
        }
        function vrFrame(t) {
            if (!VR.sess) return; const R = VR.rig, run = GameState.isRunning, dbg = !run && !!GameState.debugScene, live = run || dbg, tgt = live ? scene : menuScene; if (R.parent !== tgt) tgt.add(R);
            const byH = h => VR.ctl.findIndex(c => c.userData.src && c.userData.src.handedness === h), gpOf = h => { const i = byH(h); return i < 0 ? null : VR.ctl[i].userData.src.gamepad; };
            const ax = (g, i) => (g && g.axes[i]) || 0, bt = (g, i) => !!(g && g.buttons[i] && g.buttons[i].pressed), edge = (k, v) => { const e = v && !VR.prev[k]; VR.prev[k] = v; return e; };
            if (VR.q.length) VR.q.splice(0).forEach(cb => cb(t));
            const lg = gpOf('left'), rg = gpOf('right'), v = new THREE.Vector3(), dt = Math.min(0.1, (t - VR.lt) / 1000); VR.lt = t;
            const ov = ovActive();
            if (dbg) { if (VR.hg.parent) VR.hg.removeFromParent(); wrist.removeFromParent(); hud.visible = false; window.__vrMove = null; window.__vrAim = null; }
            else if (!run) { if (VR.hg.parent) VR.hg.removeFromParent(); wrist.removeFromParent(); hud.visible = false; R.position.set(0, 0, 5.4); R.rotation.set(0, 0, 0); R.updateMatrixWorld(true); GameState.lastFrameTime = t; VR.hl = null; window.__vrMove = null; window.__vrAim = null; }
            else if (!ov) {
                if (edge('lX', bt(lg, 4))) pauseGame(); else VR.prev.lX = bt(lg, 4);
            } else if (edge('lX', bt(lg, 4)) && (GameState.isPaused || GameState.mpMenu)) resumeGame();
            // ---- menu mirror (main menu, pause, settings, shop, death, achievements...) ----
            if (ov) {
                if (panel.parent !== tgt) tgt.add(panel);
                if (VR.ovEl !== ov || panel.parent !== tgt) { VR.ovEl = ov; VR.scroll = 0; VR.mt = 0; if (!live) { panel.position.set(-0.5, 1.5, 3.9); panel.lookAt(0, 1.55, 5.4); } else { const hd = VR.cam.getWorldPosition(new THREE.Vector3()), dd = VR.cam.getWorldDirection(new THREE.Vector3()); dd.y = 0; dd.normalize(); panel.position.set(hd.x + dd.x * 1.3, hd.y - 0.05, hd.z + dd.z * 1.3); panel.lookAt(hd); } }
                panel.visible = true; if (run) { for (const k in keys) keys[k] = false; hud.visible = false; if (!VR.hg.parent) scene.add(VR.hg); }
                if (t - VR.mt > 200) { VR.mt = t; vrLayout(ov); VR.dirty = 1; }
                VR.scroll = Math.max(0, Math.min(Math.max(0, VR.H - 768), VR.scroll + (Math.abs(ax(rg, 3)) > 0.2 ? ax(rg, 3) : Math.abs(ax(lg, 3)) > 0.2 ? ax(lg, 3) : 0) * dt * 700));
                let hov = -1;
                VR.ctl.forEach((c, i) => { const g = c.userData.src && c.userData.src.gamepad, ln = c.userData.ln; ln.visible = !!c.userData.src; if (!g) return;
                    const o = c.getWorldPosition(new THREE.Vector3()), d = new THREE.Vector3(0, 0, -1).transformDirection(c.matrixWorld), hit = new THREE.Raycaster(o, d, 0, 10).intersectObject(panel)[0]; ln.scale.z = hit ? hit.distance : 2;
                    const trig = edge('m' + i, bt(g, 0)); if (hit) { const cx = hit.uv.x * 640, cy = (1 - hit.uv.y) * 768 + VR.scroll, k = VR.rows.findIndex(r => r.k !== 't' && cy >= r.y0 && cy <= r.y1); if (k >= 0) { hov = k; const rr = VR.rows[k]; if (rr.k === 'g') VR.hx = Math.max(0, Math.min(rr.keys.length - 1, Math.floor((cx - 20) / 600 * rr.keys.length))); if (trig) { vibI(i, 0.3, 30); mirrorAct(rr, cx / 640); } } } });
                if (hov !== VR.hov || VR.hx !== VR.hx0 || VR.dirty || VR.sc !== VR.scroll) { if (hov !== VR.hov && hov >= 0) vibI(0, 0.08, 8); VR.hx0 = VR.hx; VR.hov = hov; VR.dirty = 0; VR.sc = VR.scroll; mirrorDraw(); }
                if (!live) { if (typeof menuEnt !== 'undefined' && menuEnt) renderMenu(t); else renderer.render(menuScene, VR.cam); return; }
                if (GameState.isPaused) { GameState.lastFrameTime = t; renderMain(); return; }
                // overlay open but game running (shop): keep the world going
                heldGroup.visible = false; shotgunViewGroup.visible = false; R.position.set(camera.position.x - VR.cam.position.x, camera.position.y - 1.7, camera.position.z - VR.cam.position.z); R.updateMatrixWorld(true); gameLoop(t); return;
            }
            panel.visible = false; VR.ovEl = null;
            if (dbg) return vrDbgFrame(t, lg, rg, ax, bt, edge);
            if (!run) { if (typeof menuEnt !== 'undefined' && menuEnt) renderMenu(t); else renderer.render(menuScene, VR.cam); return; }
            if (!VR.hg.parent) scene.add(VR.hg); const gl = byH('left'); if (gl >= 0 && wrist.parent !== VR.grip[gl]) VR.grip[gl].add(wrist);
            const p = camera.position, hl = VR.cam.position, cy = Math.cos(R.rotation.y), sy0 = Math.sin(R.rotation.y);
            if (VR.hl) { const dx = hl.x - VR.hl.x, dz = hl.z - VR.hl.z; window.__vrMove = { x: dx * cy + dz * sy0, z: -dx * sy0 + dz * cy }; } VR.hl = { x: hl.x, z: hl.z };
            const sx = ax(rg, 2); if (Math.abs(sx) > 0.7 && t > VR.snap) { R.rotation.y -= Math.sign(sx) * Math.PI / 6; VR.snap = t + 300; }
            const c2 = Math.cos(R.rotation.y), s2 = Math.sin(R.rotation.y); R.position.set(p.x - (hl.x * c2 + hl.z * s2), p.y - 1.7, p.z - (-hl.x * s2 + hl.z * c2));
            R.updateMatrixWorld(true); const d = VR.cam.getWorldDirection(new THREE.Vector3()), yaw = Math.atan2(-d.x, -d.z), pit = Math.asin(Math.max(-1, Math.min(1, d.y)));
            camera.rotation.set(pit, yaw, 0, 'YXZ'); LOOK.yaw = yaw; LOOK.pitch = pit; VR.yaw += _wrap(yaw - VR.yaw) * 0.04;
            const sy = ax(lg, 3), sw = ax(lg, 2), ry = ax(rg, 3), D = 0.3, swim = !!GameState.swimming;
            keys.w = sy < -D; keys.s = sy > D; keys.a = sw < -D; keys.d = sw > D; keys[' '] = swim && ry < -0.4; keys.shift = bt(rg, 4) || (swim && (keys.w || ry > 0.4));
            keys.e = bt(lg, 5); if (edge('lY', keys.e)) { interact(); vibH('left', 0.4, 60); } if (edge('lS', bt(lg, 3)) && !VR.held.left && !VR.held.right) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' }));
            // holster spheres (your inventory), grabbing, pointing
            const head = VR.cam.getWorldPosition(new THREE.Vector3()), c = Math.cos(VR.yaw), s = Math.sin(VR.yaw), slotSpread = { 0: [0.06, 0.04], 1: [-0.08, -0.05], 2: [-0.06, 0.03], 3: [0.08, -0.04], 4: [-0.05, -0.03], 5: [0.05, 0.02] },
                slotPos = i => { const q = slotSpread[i] || [0, 0]; return new THREE.Vector3(head.x + (HOL[i][0] + q[0]) * c + (HOL[i][1] + q[1]) * s, R.position.y + 0.95 + q[1] * 0.3, head.z - (HOL[i][0] + q[0]) * s + (HOL[i][1] + q[1]) * c); };
            ['left', 'right'].forEach(h => { if (VR.held[h] && !GameState.inv[VR.held[h].slot]) VR.held[h] = null; }); const isH = i => !!(VR.held.left && VR.held.left.slot === i || VR.held.right && VR.held.right.slot === i);
            GameState._flMount = ['left', 'right'].some(h => VR.held[h] && GameState.inv[VR.held[h].slot] && GameState.inv[VR.held[h].slot].id === 'shotgun'); if (GameState._flMount && VR.fl.at !== 'hol') VR.fl.at = 'hol';
            const targets = []; GameState.items.forEach((it, i) => targets.push({ pos: it.mesh.getWorldPosition(new THREE.Vector3()), r: 0.4, it, i }));
            const sp = GameState.inShop && GameState.shopPos; if (sp && !GameState.shopOpen) { targets.push({ pos: new THREE.Vector3(sp.sx, 1.3, sp.sz), r: 1.1, shop: { x: sp.sx, z: sp.sz } }, { pos: new THREE.Vector3(sp.bx, 1.3, sp.bz), r: 0.8, shop: { x: sp.bx, z: sp.bz } }); }
            const grab = (h, i) => {
                const it = GameState.items[i], ty = it.mesh.userData.type;
                if (ty === 'coin') { if (!GameState.debugRoom) { Save.coins++; sv('backrooms_coins', Save.coins); } renderInv(); AudioSys.playCoin(); scene.remove(it.mesh); GameState.items.splice(i, 1); }
                else if (ItemDefs[ty]) { const sl = GameState.inv.indexOf(null); if (sl < 0) return showEventBanner('INVENTORY FULL - DROP SOMETHING', 1.8);
                    GameState.inv[sl] = { id: ty, count: 1, uses: TOOL_MAX[ty] || 2, active: 0, cd: 0, ammo: ty === 'shotgun' ? (it.mesh.userData.ammo == null ? PermaFx.ammoStart() : it.mesh.userData.ammo) : 0 };
                    if (ty === 'shotgun') GameState.shotgunSpawnedInWorld = false; if (ty === 'tracker') GameState.trackerInWorld = false; AudioSys.playPickup(); scene.remove(it.mesh); GameState.items.splice(i, 1); VR.held[h] = { slot: sl }; selectSlot(sl); }
                else interact();
                vibH(h, 0.5, 60);
            };
            ['left', 'right'].forEach(h => {
                const gi = byH(h); if (gi < 0) return; const ctl = VR.ctl[gi], g = ctl.userData.src.gamepad, grip = VR.grip[gi], hs = VR.hand[h] || (VR.hand[h] = {}), gv = bt(g, 1), ge = edge(h + 'g', gv), te = edge(h + 't', bt(g, 0)), hp = grip.getWorldPosition(new THREE.Vector3());
                { const hv = hs.pp ? hp.clone().sub(hs.pp).divideScalar(Math.max(dt, 0.008)) : new THREE.Vector3(); hs.vel = (hs.vel || hv.clone()).lerp(hv, 0.5); hs.pp = hp.clone(); }
                const o = ctl.getWorldPosition(new THREE.Vector3()), dir = new THREE.Vector3(0, 0, -1).transformDirection(ctl.matrixWorld); let best = null, bd = 9; const flPos = slotPos(5);
                if (VR.fl.at === h) { if (!gv) VR.fl.at = 'hol'; else if (te) { toggleFlashlight(); vibI(gi, 0.3, 40); } vrSet(hs, null, grip, 0.2); ctl.userData.ln.visible = false; return; }
                const H = VR.held[h]; if (!H) targets.forEach(q => { const w = q.pos.clone().sub(o), tt = w.dot(dir); if (tt < 0 || tt > 6) return; if (w.sub(dir.clone().multiplyScalar(tt)).length() < q.r && tt < bd) { bd = tt; best = q; } });
                ctl.userData.ln.visible = !!best; if (best) ctl.userData.ln.scale.z = bd; if (best !== VR['b' + h]) { VR['b' + h] = best; if (best) vibI(gi, 0.15, 15); }
                 { let sh = -1, sd = 0.2; for (let i = 0; i < 5; i++) { if (VR.held[h] || isH(i)) continue; const d = hp.distanceTo(slotPos(i)); if (d < sd) { sd = d; sh = i; } } if (sh !== VR.slHov) { if (VR.slHov >= 0 && VR.sph[VR.slHov]) VR.sph[VR.slHov].material.color.setHex(VR.slHov === 5 ? 0xffa020 : 0x2f7bff); VR.slHov = sh; if (sh >= 0) { VR.sph[sh].material.color.setHex(0x5cd6ff); vibI(gi, 0.3, 90); } } }
                if (H) {
                    const it = GameState.inv[H.slot], mouth = head.clone().add(new THREE.Vector3(0, -0.13, 0)).addScaledVector(VR.cam.getWorldDirection(new THREE.Vector3()), 0.1);
                    if (it && (it.id === 'crowbar' || it.id === 'axe')) vrMelee(it, ctl, hs, gi, t, dt);
                    if (it && it.id === 'shotgun') { // two-handed grip: other hand on the foregrip aims the barrel
                        const oh = h === 'left' ? 'right' : 'left', og = gpOf(oh), ogi = byH(oh);
                        if (og && bt(og, 1) && !VR.held[oh] && ogi >= 0) { const ohp = VR.grip[ogi].getWorldPosition(new THREE.Vector3()), fore = ctl.localToWorld(new THREE.Vector3(0, -0.03, -0.45));
                            if (VR.sup && VR.sup.main === h) VR.sup.dir.copy(ohp.sub(hp).normalize()); else if (ohp.distanceTo(fore) < 0.4) {
                            const otherW = VR.held[oh] ? GameState.inv[VR.held[oh].slot] : null; // other weapon occupying the other hand, if any
                            if (!otherW) { VR.sup = { main: h, off: oh, dir: ohp.sub(hp).normalize() }; vibH(oh, 0.4, 40); } } }
                        else if (VR.sup && (VR.held[VR.sup.main] || VR.held[VR.sup.off])) VR.sup = null;
                        else if (VR.sup && VR.sup.main === h) VR.sup = null;
                    } else if (VR.sup && VR.sup.main === h) VR.sup = null;
                    if (!gv) { const j = H.slot; let k = -1; for (let i = 0; i < 5; i++) if (hp.distanceTo(slotPos(i)) < 0.2) k = i;
                        if (k >= 0) { const oh = VR.held[h === 'left' ? 'right' : 'left']; if (oh && oh.slot === k) oh.slot = j; const a = GameState.inv[k]; GameState.inv[k] = GameState.inv[j]; GameState.inv[j] = a; selectSlot(k); }
                        else { const id = it.id, am = it.ammo; invRemoveOne(j); vrDrop(id, am, hp, hs.vel, ctl); AudioSys.playDrop(); syncInventory(); }
                        vibI(gi, 0.35, 50); VR.held[h] = null; }
                    else if (te) {
                        selectSlot(H.slot); const sg = it.id === 'shotgun', two = sg && VR.sup && VR.sup.main === h, aim = two ? VR.sup.dir.clone() : dir.clone(), ammo0 = it.ammo;
                        window.__vrAim = aim; window.__vrMuzzle = ctl.localToWorld(new THREE.Vector3(0, -0.03, 0.06)).addScaledVector(aim, 0.68); useSelected(); window.__vrAim = null; window.__vrMuzzle = null; vibI(gi, sg ? 1 : 0.7, sg ? 250 : 120);
                        if (sg && ammo0 > 0) { // recoil: two hands hold it; one hand and it rips out of your grip and tumbles away as a solid object
                            if (two) vibH(VR.sup.off, 1, 250);
                            else { const am = it.ammo; invRemoveOne(H.slot); VR.held[h] = null; vrDrop('shotgun', am, ctl.getWorldPosition(new THREE.Vector3()), hs.vel.clone().addScaledVector(aim, -4.5).add(new THREE.Vector3(0, 2.8, 0)), ctl); showEventBanner('THE RECOIL RIPPED IT OUT OF YOUR HAND - HOLD IT WITH TWO HANDS', 2.8); AudioSys.playDrop(); VR.sup = null; syncInventory(); }
                        }
                    }
                    else if (EAT.includes(it.id) && hp.distanceTo(mouth) < 0.22 && t > (VR.eat || 0)) { VR.eat = t + 1200; selectSlot(H.slot); useSelected(); vibI(gi, 0.6, 150); }
                } else if (ge && VR.fl.at === 'hol' && !GameState._flMount && hp.distanceTo(flPos) < 0.2) { VR.fl.at = h; vibI(gi, 0.5, 60);
                } else if (ge && !foreHold(h, hp)) {
                    const ch = (GameState.chests || []).find(c => !c.open && nearChest(c, hp)); if (ch) { openChest(ch); vibH(h, 0.7, 120); return; }
                    if (!VR.held[h]) { let bs = -1, bd = 0.2; for (let i = 0; i < 5; i++) { if (GameState.inv[i] && !isH(i)) { const d = hp.distanceTo(slotPos(i)); if (d < bd) { bd = d; bs = i; } } } if (bs >= 0) { VR.held[h] = { slot: bs }; selectSlot(bs); } }
                    for (let i = GameState.items.length - 1; i >= 0 && !VR.held[h]; i--) if (GameState.items[i].mesh.getWorldPosition(v).distanceTo(hp) < 0.5) { grab(h, i); break; }
                } else if (te && best) { if (best.shop) shopInteract(best.shop); else grab(h, best.i); }
                { const hid = VR.held[h] && GameState.inv[VR.held[h].slot] ? GameState.inv[VR.held[h].slot].id : null, nat = NATIVE.includes(hid); vrSet(hs, hid, nat ? ctl : grip, 0.2, nat); if (hs.o) vrTag(hs.o, VR.held[h] ? GameState.inv[VR.held[h].slot] : null);
                         if (hid === 'shotgun' && nat && hs.o) { // flashlight bolted under the barrel: SpotLight + target are children of the gun, so the beam always follows the barrel
                             if (!VR.mfm) { const mm = new THREE.Group(), mb = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 0.1, 10), new THREE.MeshStandardMaterial({ color: 0x222226, metalness: 0.8, roughness: 0.4 })), ml = new THREE.Mesh(new THREE.CircleGeometry(0.016, 10), new THREE.MeshBasicMaterial({ color: 0xfffbe0 })); mb.rotation.x = Math.PI / 2; ml.position.z = -0.051; ml.rotation.y = Math.PI; mm.add(mb, ml); VR.mfm = mm; }
                             if (VR.mfm.parent !== hs.o) { hs.o.add(VR.mfm); VR.mfm.position.set(0, -0.06, -0.8); }
                             if (flashLight.parent !== hs.o) hs.o.add(flashLight, flashLight.target); flashLight.position.set(0, -0.06, -0.86); flashLight.quaternion.identity(); flashLight.target.position.set(0, -0.06, -8); }
                  if (hs.o) { if (nat) { hs.o.position.set(0, -0.03, 0.06);
                      if (hid === 'shotgun' && VR.sup && VR.sup.main === h) { const qw = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), VR.sup.dir, new THREE.Vector3(0, 1, 0))), qc = ctl.getWorldQuaternion(new THREE.Quaternion()); hs.o.quaternion.copy(qc.invert().multiply(qw)); } else hs.o.quaternion.identity();
                    } else { hs.o.position.set(0, 0, -0.08); hs.o.quaternion.identity(); } } }
            });
            { const fm = VR.flm, fi = VR.fl.at === 'hol' ? -2 : byH(VR.fl.at), par = fi === -2 ? VR.hg : VR.grip[fi]; fm.visible = !GameState._flMount;
              if (!GameState._flMount) { if (VR.mfm) VR.mfm.removeFromParent(); if (flashLight.parent !== fm) { fm.add(flashLight, flashLight.target); flashLight.position.set(0, 0, -0.13); flashLight.target.position.set(0, 0, -6); flashLight.quaternion.identity(); } } if (!par) VR.fl.at = 'hol'; else if (fm.parent !== par) par.add(fm);
              if (VR.fl.at === 'hol') { const fp = slotPos(5); fm.position.copy(fp); fm.rotation.set(0, VR.yaw, 0); VR.sph[5].position.copy(fp); if (GameState.player.flashlightOn && !GameState._flMount) { GameState.player.flashlightOn = false; flashLight.visible = false; } } else { fm.position.set(0, 0, 0.03); fm.rotation.set(0, 0, 0); }
              VR.lens.material.color.setHex(GameState.player.flashlightOn ? 0xfffbe0 : 0x555544); }
            { const on = GameState.exitArrowShowTimer > 0 && gl >= 0; VR.arr.visible = on; if (on) { if (VR.arr.parent !== VR.grip[gl]) VR.grip[gl].add(VR.arr); const wp = VR.arr.getWorldPosition(new THREE.Vector3()); VR.arr.lookAt(GameState.exitPos.x, wp.y, GameState.exitPos.z); if (!VR.arOn) vibI(gl, 0.6, 200); } VR.arOn = on; }
            if (GameState.isBeingChased && t > (VR.hb || 0)) { VR.hb = t + 650; vibI(0, 0.25, 90); vibI(1, 0.25, 90); }
            if (GameState.isJumpscaring && !VR.js) { VR.js = 1; vibI(0, 1, 500); vibI(1, 1, 500); } else if (!GameState.isJumpscaring) VR.js = 0;
            for (let i = 0; i < 5; i++) { const m = VR.mod[i] || (VR.mod[i] = {}), it = GameState.inv[i], id = it && !isH(i) ? it.id : null, pp = slotPos(i); VR.sph[i].position.copy(pp); vrSet(m, id, VR.hg, 0.15); if (m.o) { m.o.position.copy(pp); vrTag(m.o, it); } }
            if (t - (VR.wt || 0) > 120) { VR.wt = t; wristDraw(); }
            { const hb = []; ['left', 'right'].forEach(hh => { const hs2 = VR.hand[hh]; if (hs2 && hs2.pp) hb.push({ p: hs2.pp, v: hs2.vel || new THREE.Vector3(), held: !!VR.held[hh] }); }); vrPhys(dt, hb); }
            heldGroup.visible = false; shotgunViewGroup.visible = false;
            gameLoop(t);
        }
        // Enter VR button (only when a VR headset/browser is present)
        if (navigator.xr) navigator.xr.isSessionSupported('immersive-vr').then(ok => { if (!ok) return; const b = document.createElement('button'); b.className = 'menu-btn'; b.id = 'enter-vr-btn'; b.textContent = 'Enter VR'; const sb = document.getElementById('start-btn'); sb.parentNode.insertBefore(b, sb.nextSibling); b.addEventListener('click', vrStart); }).catch(() => {});
        requestAnimationFrame(gameLoop); // the one and only game loop (idles cheaply when not running/paused)

        // ======== MOBILE / TOUCH CONTROLS (pointer events only: floating move stick, drag-to-look, multi-touch safe) ========
        if ('ontouchstart' in window || navigator.maxTouchPoints > 0 || (window.matchMedia && matchMedia('(pointer: coarse)').matches)) {
            document.body.classList.add('touch');
            try { selectGraphicsPreset('low'); } catch (e) {} // phones start on LOW; change it in Settings
            const ui = document.createElement('div'); ui.id = 'touch-ui';
            ui.innerHTML = '<div id="t-move"><div class="t-lbl">MOVE</div><div class="t-base"><div class="t-knob"></div></div></div>' +
                '<div class="t-btn" id="t-e">E<br>USE</div><div class="t-btn" id="t-use">HOLD<br>ITEM</div><div class="t-btn" id="t-flash">LIGHT</div><div class="t-btn" id="t-run">RUN</div><div class="t-btn" id="t-up">RISE</div><div class="t-btn" id="t-down">SINK</div><div class="t-btn" id="t-pause">II</div>';
            document.body.appendChild(ui);
            const rot = document.createElement('div'); rot.id = 't-rotate'; rot.textContent = 'ROTATE YOUR DEVICE TO LANDSCAPE'; document.body.appendChild(rot);
            const $ = id => document.getElementById(id);
            const live = () => !!GameState.isRunning && !GameState.isPaused && !GameState.shopOpen && !GameState.isJumpscaring;
            const sync = () => { const c = document.body.classList; c.toggle('t-active', live()); c.toggle('t-swim', !!GameState.swimming); };
            setInterval(sync, 120); sync();
            let runBtn = false, sinkBtn = false, stickAuto = false;
            const setShift = () => { keys.shift = runBtn || sinkBtn || (stickAuto && !GameState.swimming); };
            const releaseAll = () => {
                runBtn = sinkBtn = stickAuto = false; keys.w = keys.a = keys.s = keys.d = keys.shift = keys[' '] = false;
                document.querySelectorAll('.t-btn.on').forEach(b => b.classList.remove('on'));
                if (moveEnd) moveEnd(true);
                looks.clear();
            };
            // ---- floating MOVE stick: appears wherever the left thumb lands inside the left zone ----
            const zone = $('t-move'), base = zone.querySelector('.t-base'), knob = zone.querySelector('.t-knob');
            let mPid = null, mx = 0, my = 0, moveEnd = null;
            const mvec = (cx, cy) => {
                const R = base.offsetWidth / 2 || 60; let dx = (cx - mx) / R, dy = (cy - my) / R; const m = Math.hypot(dx, dy);
                if (m > 1) { dx /= m; dy /= m; }
                knob.style.transform = 'translate(' + (dx * R * 0.9) + 'px,' + (dy * R * 0.9) + 'px)';
                const T = 0.3; keys.w = dy < -T; keys.s = dy > T; keys.a = dx < -T; keys.d = dx > T;
                stickAuto = dy < -0.9 && Math.abs(dx) < 0.6; setShift();
            };
            moveEnd = (force) => {
                mPid = null; knob.style.transform = ''; base.classList.remove('live'); base.style.left = base.style.top = '';
                keys.w = keys.a = keys.s = keys.d = false; stickAuto = false; setShift();
            };
            zone.addEventListener('pointerdown', e => {
                if (mPid !== null || e.target.closest('.t-btn')) return;
                e.preventDefault(); mPid = e.pointerId; try { zone.setPointerCapture(mPid); } catch (x) {}
                const r = zone.getBoundingClientRect(), R = base.offsetWidth / 2 || 60;
                mx = Math.min(r.right - R, Math.max(r.left + R, e.clientX)); my = Math.min(r.bottom - R, Math.max(r.top + R, e.clientY));
                base.style.left = (mx - r.left - R) + 'px'; base.style.top = (my - r.top - R) + 'px'; base.classList.add('live');
                mvec(e.clientX, e.clientY);
            });
            zone.addEventListener('pointermove', e => { if (e.pointerId === mPid) { e.preventDefault(); mvec(e.clientX, e.clientY); } });
            ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => zone.addEventListener(ev, e => { if (e.pointerId === mPid) moveEnd(); }));
            // ---- buttons ----
            const hold = (id, on, off) => { const b = $(id); let pid = null;
                b.addEventListener('pointerdown', e => { e.preventDefault(); e.stopPropagation(); if (pid !== null) return; pid = e.pointerId; try { b.setPointerCapture(pid); } catch (x) {} b.classList.add('on'); on(); });
                ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => b.addEventListener(ev, e => { if (e.pointerId !== pid) return; pid = null; b.classList.remove('on'); if (off) off(); })); };
            hold('t-e', () => interact()); hold('t-use', () => useSelected()); hold('t-flash', () => toggleFlashlight());
            hold('t-run', () => { runBtn = true; setShift(); }, () => { runBtn = false; setShift(); });
            hold('t-down', () => { sinkBtn = true; setShift(); }, () => { sinkBtn = false; setShift(); });
            hold('t-up', () => { keys[' '] = true; }, () => { keys[' '] = false; });
            hold('t-pause', () => { if (GameState.isRunning && !GameState.isPaused && !GameState.isJumpscaring) pauseGame(); });
            // ---- drag anywhere else to look (pointer events, one finger per pointer id, so it never fights the stick/buttons) ----
            const looks = new Map(), SKIP = '#touch-ui, #inv-hud, button, input, select, textarea, label, a, #shop-screen, #pause-menu, #settings-modal, #death-screen, #start-screen, .dbg-modal, #mp-chatbar';
            document.addEventListener('pointerdown', e => {
                if (e.pointerType !== 'touch' || !live()) return;
                if (e.target.closest && e.target.closest(SKIP)) return;
                looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
            }, { passive: true });
            document.addEventListener('pointermove', e => {
                const l = looks.get(e.pointerId); if (!l) return;
                if (!live()) { looks.delete(e.pointerId); return; }
                const dx = e.clientX - l.x, dy = e.clientY - l.y; l.x = e.clientX; l.y = e.clientY;
                applyLook(dx * 1.7, dy * 1.7);
            }, { passive: true });
            ['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, e => looks.delete(e.pointerId), { passive: true }));
            // stop the browser stealing touches from the game surface (scroll, pull-to-refresh, pinch, long-press menu)
            document.addEventListener('touchmove', e => { if (live() && !(e.target.closest && e.target.closest('#pause-menu, #shop-screen, #settings-modal, .dbg-modal'))) e.preventDefault(); }, { passive: false });
            ['gesturestart', 'gesturechange', 'gestureend', 'contextmenu'].forEach(ev => document.addEventListener(ev, e => { if (document.body.classList.contains('touch')) e.preventDefault(); }));
            // inventory: tap a slot
            $('inv-hud').addEventListener('pointerdown', e => { const sl = e.target.closest && e.target.closest('.inv-slot'); if (sl) { const i = [...sl.parentNode.children].indexOf(sl); if (i >= 0 && i < 5) selectSlot(i); } });
            // release every held control when the game pauses, loses focus, or the phone rotates
            setInterval(() => { if (!live()) releaseAll(); }, 250);
            window.addEventListener('blur', releaseAll); window.addEventListener('orientationchange', releaseAll);
            document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
            // go fullscreen + lock landscape on the first tap (where the browser allows it)
            document.addEventListener('pointerup', () => { const d = document.documentElement; if (!document.fullscreenElement && d.requestFullscreen) d.requestFullscreen().then(() => { try { screen.orientation.lock('landscape'); } catch (e) {} }).catch(() => {}); }, { once: true });
        }

