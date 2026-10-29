/*
 * Changes for this site: plain JavaScript instead of TypeScript and React,
 * dark palette only, no analytics, and on narrow screens the koi fade only
 * under each line of text, since this page scrolls instead of fitting one screen.
 */
(() => {
    "use strict";

    // ── world ─────────────────────────────────────────────────────────────

    const TAU = Math.PI * 2;
    const KOI_NODES = 20;
    const RIPPLE_SPEED = 52;

    const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
    const rand = (lo, hi) => lo + Math.random() * (hi - lo);

    function smoothstep(e0, e1, x) {
        const t = clamp((x - e0) / (e1 - e0), 0, 1);
        return t * t * (3 - 2 * t);
    }

    function angleDiff(a, b) {
        let d = (b - a) % TAU;
        if (d > Math.PI) d -= TAU;
        if (d < -Math.PI) d += TAU;
        return d;
    }

    // Deterministic integer hash to [0, 1), so textures stay pinned to the body.
    function hash3(x, y, z) {
        let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041);
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        h ^= h >>> 16;
        return (h >>> 0) / 4294967296;
    }

    const VARIETY_WEIGHTS = [
        ["kohaku", 3],
        ["sanke", 2],
        ["tancho", 1],
    ];
    const TOTAL_WEIGHT = VARIETY_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);

    function pickVariety() {
        let r = Math.random() * TOTAL_WEIGHT;
        for (const [variety, weight] of VARIETY_WEIGHTS) {
            r -= weight;
            if (r <= 0) return variety;
        }
        return "kohaku";
    }

    const push = { x: 0, y: 0 };

    /** Sum of pushes away from every box within `margin` of (x, y), each scaled 0..1 by closeness. */
    function repel(boxes, x, y, margin, out) {
        out.x = 0;
        out.y = 0;
        for (const b of boxes) {
            let ox = x - clamp(x, b.left, b.right);
            let oy = y - clamp(y, b.top, b.bottom);
            let d = Math.hypot(ox, oy);
            if (d > margin) continue;
            if (d < 1e-3) {
                // Inside the box: head for the nearest edge.
                const edges = [b.left - x, x - b.right, b.top - y, y - b.bottom];
                const nearest = edges.indexOf(Math.max(...edges));
                ox = nearest === 0 ? -1 : nearest === 1 ? 1 : 0;
                oy = nearest === 2 ? -1 : nearest === 3 ? 1 : 0;
                d = 0;
            }
            const len = Math.hypot(ox, oy) || 1;
            out.x += (ox / len) * (1 - d / margin);
            out.y += (oy / len) * (1 - d / margin);
        }
        return out;
    }

    const PELLET_LIFE = 14;
    const BITE_LIFE = 0.45;
    const RUSH_RANGE = 650;
    const FEED_CALM = 2;
    /** Uneaten pellets start to sink this many seconds in, fading out by PELLET_LIFE. */
    const PELLET_SINK = 9;
    const THROW_RADIUS = 34;
    const STARTLE_SPEED = 1100;
    const MAX_PELLETS = 24;

    const rippleLife = (r) => 2.2 + r.strength * 1.6;

    class World {
        constructor() {
            this.width = 0;
            this.height = 0;
            this.time = 0;
            this.koi = [];
            this.pellets = [];
            this.bites = [];
            this.ripples = [];
            /** Moving the mouse to throw food isn't a threat, so swipes don't startle koi for a moment after a throw. */
            this.lastFeed = -Infinity;
            this.pointer = { x: 0, y: 0, speed: 0, active: false };
            /** Page content the koi steer around, in canvas space. */
            this.avoid = [];
        }

        resize(width, height) {
            const first = this.width === 0;
            this.width = width;
            this.height = height;
            if (first) this.seed();
        }

        seed() {
            const { width: W, height: H } = this;
            const minSide = Math.min(W, H);
            const baseLength = clamp(minSide * 0.5, 170, 420);
            const count = clamp(Math.round((W * H) / 240000), 3, 6);
            // Wide screens also get a couple of young koi that keep to the deep water, for a sense of depth.
            const young = W >= 1024 ? 2 : 0;

            this.koi = [];
            for (let i = 0; i < count + young; i++) {
                const isYoung = i >= count;
                const length = baseLength * (isYoung ? rand(0.32, 0.45) : rand(0.6, 1));
                const depthMax = isYoung ? 0.72 : 1;
                const heading = rand(0, TAU);
                const x = rand(W * 0.1, W * 0.9);
                const y = rand(H * 0.1, H * 0.9);
                const nodes = new Float32Array(KOI_NODES * 2);
                const seg = length / (KOI_NODES - 1);
                for (let n = 0; n < KOI_NODES; n++) {
                    nodes[n * 2] = x - Math.cos(heading) * seg * n;
                    nodes[n * 2 + 1] = y - Math.sin(heading) * seg * n;
                }
                this.koi.push({
                    id: i + 1,
                    variety: pickVariety(),
                    length,
                    nodes,
                    heading,
                    speed: 20,
                    phase: rand(0, TAU),
                    turn: 0,
                    wander: 0,
                    curiosity: rand(0.35, 1),
                    depth: rand(0.5, depthMax),
                    depthTarget: rand(0.5, depthMax),
                    depthMax,
                    nextDive: rand(6, 18),
                    nextSurface: rand(3, 14),
                    nextWake: rand(0, 2),
                    beat: 0,
                    rush: 0,
                    food: null,
                    burstUntil: 0,
                    nextBurst: rand(0, 3),
                    finPhase: rand(0, TAU),
                    startle: 0,
                    fleeX: 0,
                    fleeY: 0,
                    gulp: 0,
                });
            }
        }

        /** A loose handful thrown at (x, y): each pellet lands a beat apart with its own splash, then drifts and sinks. */
        feed(x, y) {
            this.lastFeed = this.time;
            this.ripples.push({ x, y, born: this.time, strength: 0.35 });
            // A full pond takes no more food, rather than dropping old pellets out from under koi already going for them.
            const count = Math.min(5 + Math.floor(Math.random() * 3), MAX_PELLETS - this.pellets.length);
            for (let k = 0; k < count; k++) {
                const a = rand(0, TAU);
                const r = Math.sqrt(Math.random()) * THROW_RADIUS;
                const drift = rand(2, 6);
                this.pellets.push({
                    x: x + Math.cos(a) * r * 1.3,
                    y: y + Math.sin(a) * r,
                    born: this.time,
                    landAt: rand(0.15, 0.45),
                    landed: false,
                    vx: Math.cos(a) * drift,
                    vy: Math.sin(a) * drift,
                });
            }
        }

        step(dt) {
            this.time += dt;
            this.pointer.speed *= Math.exp(-dt * 8);
            for (const k of this.koi) this.stepKoi(k, dt);
            const t = this.time;
            this.pellets = this.pellets.filter((p) => t - p.born < PELLET_LIFE);
            for (const p of this.pellets) {
                if (!p.landed) {
                    if (t - p.born < p.landAt) continue;
                    p.landed = true;
                    this.ripples.push({ x: p.x, y: p.y, born: t, strength: 0.1 });
                    // The splash is what koi react to: every koi in range turns and bolts for it at once.
                    for (const k of this.koi) {
                        if (Math.hypot(k.nodes[0] - p.x, k.nodes[1] - p.y) < RUSH_RANGE) k.rush = 1;
                    }
                    continue;
                }
                const damp = Math.exp(-dt * 0.2);
                p.vx *= damp;
                p.vy *= damp;
                p.x += p.vx * dt;
                p.y += p.vy * dt;
            }
            this.ripples = this.ripples.filter((r) => t - r.born < rippleLife(r));
            this.bites = this.bites.filter((b) => t - b.born < BITE_LIFE);
        }

        stepKoi(k, dt) {
            const { width: W, height: H, pointer, time } = this;
            const L = k.length;
            const nodes = k.nodes;
            const hx = nodes[0];
            const hy = nodes[1];

            let dx = Math.cos(k.heading);
            let dy = Math.sin(k.heading);

            k.wander = clamp(k.wander + (Math.random() - 0.5) * dt * 2.4, -0.9, 0.9);
            dx += Math.cos(k.heading + k.wander) * 0.6;
            dy += Math.sin(k.heading + k.wander) * 0.6;

            const food = this.pickFood(k, hx, hy, Math.max(L * 1.6 + 220, k.rush > 0 ? RUSH_RANGE : 0));

            // A fast swipe close by spooks a koi: it bolts away, then calms down over a couple of seconds.
            // A koi already going for food ignores it; feeding beats fear, and clicking to feed moves the mouse fast.
            const pointerD = Math.hypot(pointer.x - hx, pointer.y - hy);
            const feeding = time - this.lastFeed < FEED_CALM;
            if (!food && !feeding && pointer.active && pointer.speed > STARTLE_SPEED && pointerD < L * 0.9) {
                k.startle = 1;
                k.fleeX = pointer.x;
                k.fleeY = pointer.y;
            }
            k.startle = Math.max(0, k.startle - dt * 0.6);
            const fleeing = k.startle > 0.3 && !food;

            let chasing = false;
            let curious = false;
            let closing = 0;
            if (fleeing) {
                const ox = hx - k.fleeX;
                const oy = hy - k.fleeY;
                const d = Math.hypot(ox, oy) || 1;
                dx += (ox / d) * 4 * k.startle;
                dy += (oy / d) * 4 * k.startle;
            } else if (food) {
                const tx = food.x - hx;
                const ty = food.y - hy;
                const d = Math.hypot(tx, ty) || 1;
                dx += (tx / d) * 3;
                dy += (ty / d) * 3;
                chasing = true;
                closing = clamp(1 - d / (L * 1.2), 0, 1);
            } else if (pointer.active) {
                const tx = pointer.x - hx;
                const ty = pointer.y - hy;
                const d = Math.hypot(tx, ty) || 1;
                const range = 300;
                if (d < range) {
                    // Swim up to the cursor, then circle under it rather than parking.
                    const w = k.curiosity * (1 - d / range) * 2.2;
                    const near = clamp(d / (L * 0.6), 0, 1);
                    dx += ((tx / d) * near - (ty / d) * (1 - near)) * w;
                    dy += ((ty / d) * near + (tx / d) * (1 - near)) * w;
                    curious = true;
                }
            }

            for (const other of this.koi) {
                if (other === k) continue;
                const ohx = other.nodes[0];
                const ohy = other.nodes[1];
                if (Math.abs(ohx - hx) > L * 2 || Math.abs(ohy - hy) > L * 2) continue;
                for (let n = 0; n < KOI_NODES; n += 3) {
                    const ox = hx - other.nodes[n * 2];
                    const oy = hy - other.nodes[n * 2 + 1];
                    const d = Math.hypot(ox, oy);
                    // Koi going for food jostle in close, so personal space shrinks and never outweighs the pull.
                    const range = (L + other.length) * (food ? 0.12 : 0.28);
                    if (d < range && d > 1e-3) {
                        const w = (1 - d / range) * 2.4;
                        dx += (ox / d) * w;
                        dy += (oy / d) * w;
                    }
                }
                // Loose shoaling: nearby koi drift the same way.
                if (!chasing && Math.hypot(ohx - hx, ohy - hy) < L * 1.6) {
                    dx += Math.cos(other.heading) * 0.18;
                    dy += Math.sin(other.heading) * 0.18;
                }
            }

            // Drift around page content rather than under it; food and the cursor can still lure them across.
            repel(this.avoid, hx, hy, L * 0.4, push);
            dx += push.x * (chasing || curious ? 0.5 : 1.8);
            dy += push.y * (chasing || curious ? 0.5 : 1.8);

            // Let the body slip off-screen now and then, but always turn back.
            const over = Math.max(-hx, hx - W, -hy, hy - H);
            if (over > -L * 0.25) {
                const w = clamp((over + L * 0.25) / (L * 0.5), 0, 1) * 3.5;
                const toX = W / 2 - hx;
                const toY = H / 2 - hy;
                const d = Math.hypot(toX, toY) || 1;
                dx += (toX / d) * w;
                dy += (toY / d) * w;
            }

            const desired = Math.atan2(dy, dx);
            // Long bodies can't pivot on the spot: the turning circle grows with length.
            const agility =
                (1 + k.rush * 0.6) *
                Math.min(fleeing ? 3 : chasing ? 1.9 + closing : curious ? 1.2 : 0.7, (k.speed / L) * 4);
            const maxTurn = agility * dt;
            const turned = clamp(angleDiff(k.heading, desired), -maxTurn, maxTurn);
            k.heading += turned;
            k.turn += (turned / dt - k.turn) * Math.min(1, dt * 3);

            // Burst and coast: a few strong tail beats, then a long glide that bleeds off speed.
            // Chasing or fleeing koi beat without pause.
            if (time > k.nextBurst && time > k.burstUntil) {
                k.burstUntil = time + rand(0.7, 1.6);
                k.nextBurst = k.burstUntil + rand(1.2, 4);
            }
            const bursting = fleeing || chasing || time < k.burstUntil;
            k.beat += ((bursting ? 1 : 0) - k.beat) * Math.min(1, dt * 3);
            // Tail beats near the surface push small rings out behind the koi; gliding or deep koi leave none.
            if (k.beat > 0.6 && k.depth > 0.65 && time > k.nextWake) {
                const tail = (KOI_NODES - 3) * 2;
                this.ripples.push({ x: nodes[tail], y: nodes[tail + 1], born: time, strength: 0.25 + 0.2 * k.depth });
                k.nextWake = time + rand(0.8, 1.6) / k.beat;
            }
            k.rush = Math.max(0, k.rush - dt * 0.7);
            const cruise = 12 + L * 0.05;
            const target =
                (1 + k.rush * 0.8) *
                (fleeing
                    ? cruise * 3.2
                    : chasing
                      ? cruise * (1.9 + closing)
                      : bursting
                        ? cruise * (curious ? 1.6 : 1.35)
                        : cruise * 0.45);
            k.speed += (target - k.speed) * Math.min(1, dt * (bursting ? 1.6 + k.rush * 3 : 0.35));
            k.phase += dt * (0.6 + k.beat * (2.2 + k.speed / 11));
            k.finPhase += dt * 2.4;
            k.gulp += ((chasing && closing > 0.55 ? 1 : 0) - k.gulp) * Math.min(1, dt * 6);

            // Koi drift between the deep and the surface, and rise for food.
            if (time > k.nextDive) {
                k.depthTarget = rand(0.5, k.depthMax);
                k.nextDive = time + rand(8, 20);
            }
            k.depth += ((chasing ? 1 : k.depthTarget) - k.depth) * Math.min(1, dt * (chasing ? 0.8 : 0.15));

            nodes[0] += Math.cos(k.heading) * k.speed * dt;
            nodes[1] += Math.sin(k.heading) * k.speed * dt;

            const seg = L / (KOI_NODES - 1);
            const maxBend = 0.16;
            let prevAngle = k.heading + Math.PI;
            for (let n = 1; n < KOI_NODES; n++) {
                const px = nodes[(n - 1) * 2];
                const py = nodes[(n - 1) * 2 + 1];
                let angle = Math.atan2(nodes[n * 2 + 1] - py, nodes[n * 2] - px);
                angle = prevAngle + clamp(angleDiff(prevAngle, angle), -maxBend, maxBend);
                nodes[n * 2] = px + Math.cos(angle) * seg;
                nodes[n * 2 + 1] = py + Math.sin(angle) * seg;
                prevAngle = angle;
            }

            const mouthR = L * 0.08 + 6;
            const before = this.pellets.length;
            this.pellets = this.pellets.filter(
                (p) => !p.landed || (p.x - nodes[0]) ** 2 + (p.y - nodes[1]) ** 2 > mouthR * mouthR
            );
            if (this.pellets.length < before) {
                this.ripples.push({ x: nodes[0], y: nodes[1], born: time, strength: 0.6 });
                this.bites.push({ x: nodes[0], y: nodes[1], born: time });
                k.nextSurface = time + rand(6, 16);
            } else if (time > k.nextSurface) {
                this.ripples.push({ x: nodes[0], y: nodes[1], born: time, strength: 0.3 });
                k.nextSurface = time + rand(8, 20);
            }
        }

        /** Keep the current target while it lasts; only switch for a pellet less than half as far away. */
        pickFood(k, x, y, range) {
            if (k.food && !this.pellets.includes(k.food)) k.food = null;
            const nearest = this.nearestPellet(x, y, range);
            if (!k.food) return (k.food = nearest);
            const current = Math.hypot(k.food.x - x, k.food.y - y);
            if (current > range * 1.3) k.food = nearest;
            else if (nearest && Math.hypot(nearest.x - x, nearest.y - y) < current * 0.5) k.food = nearest;
            return k.food;
        }

        nearestPellet(x, y, range) {
            let best = null;
            let bestD = range * range;
            for (const p of this.pellets) {
                if (!p.landed) continue;
                const d = (p.x - x) ** 2 + (p.y - y) ** 2;
                if (d < bestD) {
                    bestD = d;
                    best = p;
                }
            }
            return best;
        }
    }

    // ── shape ─────────────────────────────────────────────────────────────

    const FLAG_BODY = 1;
    const FLAG_FIN = 2;
    const FLAG_EYE = 3;
    const FLAG_DORSAL = 4;
    const FLAG_BARBEL = 5;

    // Top-down outline as a fraction of length: blunt round head, plump shoulders, narrow tail stalk.
    function bodyHalfWidth(s) {
        if (s < 0.12) return 0.11 * Math.pow(Math.sin(((s / 0.12) * Math.PI) / 2), 0.55);
        if (s < 0.3) return 0.11 + 0.025 * smoothstep(0.12, 0.3, s);
        return 0.033 + 0.102 * (1 - smoothstep(0.3, 0.74, s));
    }

    const BODY_END = 0.74;

    // Butterfly tail: fans out from the stalk, with a V notch in the trailing edge.
    const tailHalfWidth = (s) => 0.03 + 0.15 * Math.pow(smoothstep(0.7, 1, s), 0.8);

    /** Test a point against a fin: an ellipse leaning back from a root on the body's edge. */
    function inFin(s, a, rootS, angle, reach, width, out) {
        const rootA = bodyHalfWidth(rootS) * 0.85;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const du = s - rootS;
        const da = a - rootA;
        const along = du * cosA + da * sinA - reach;
        const perp = -du * sinA + da * cosA;
        if ((along / reach) ** 2 + (perp / width) ** 2 > 1) return false;
        out.flag = FLAG_FIN;
        out.du = du;
        out.da = da;
        return true;
    }

    /**
     * Classify a point given in body coordinates, all as fractions of length:
     * `s` along the spine (0 snout, 1 tail tip), `a` distance from it, and
     * `past` how far it sits beyond the tail tip. `flare` spreads the fins.
     */
    function classify(s, a, past, flare, out, ahead = 0, lateral = 0) {
        out.flag = 0;
        out.across = 1;
        out.du = 1;
        out.da = 0;

        // Barbels: a short whisker angling out from each corner of the mouth, the tell that this is a koi.
        if (ahead > 0) {
            if (ahead < 0.05 && Math.abs(lateral - (0.045 + ahead * 0.7)) < 0.016) {
                out.flag = FLAG_BARBEL;
                return true;
            }
            return false;
        }

        const w = bodyHalfWidth(s);
        if (s <= BODY_END && a <= w) {
            const across = a / w;
            out.across = across;
            if (s > 0.055 && s < 0.1 && across > 0.5 && across < 0.85) out.flag = FLAG_EYE;
            else if (s > 0.28 && s < 0.6 && across < 0.14) out.flag = FLAG_DORSAL;
            else out.flag = FLAG_BODY;
            return true;
        }

        if (s > 0.68 && past <= 0) {
            const tw = tailHalfWidth(s) * flare;
            if (a <= tw && s <= 0.86 + 0.14 * (a / tw)) {
                out.flag = FLAG_FIN;
                out.da = (a / tw) * 0.8;
                return true;
            }
        }

        return (
            inFin(s, a, 0.19, 0.85 + 0.5 * (flare - 1), 0.066 * flare, 0.04, out) ||
            inFin(s, a, 0.47, 0.75, 0.036, 0.018, out)
        );
    }

    // ── renderer ──────────────────────────────────────────────────────────

    // How visible a koi stays while it swims under page content.
    const DIM_UNDER_CONTENT = 0.15;

    const PALETTE = {
        /** Page background, which tiles are mixed toward. */
        bg: [17, 20, 28],
        white: [236, 228, 218],
        red: [232, 96, 56],
        black: [92, 90, 108],
        fin: [214, 206, 198],
        eye: [20, 20, 26],
        water: [255, 247, 240],
        shadow: [0, 0, 0],
        shadowAlpha: 0.55,
        pellet: [236, 170, 92],
        alpha: 0.8,
        /** How much a deep koi fades, as the alpha it keeps at the bottom of the pond. */
        depthFloor: 0.4,
        /** How much skin colour a tile carries, from shadow (0) to lit (1); the rest is page background. */
        tile: [0.68, 0.98],
        /** Hi (the red-orange of koi markings) from deep shadow to a lit highlight, so patches shade across hues. */
        hi: [
            [112, 22, 24],
            [168, 34, 28],
            [214, 58, 30],
            [240, 96, 34],
            [250, 138, 52],
            [255, 178, 96],
        ],
        /** Glyph brightness relative to the tile under it. */
        ink: 0.42,
    };

    // Dense glyphs etched into each skin tile, sparse where it catches the light.
    const TILE_GLYPHS = "t%SX8@#";
    const SUBSAMPLES = [0.25, 0.25, 0.75, 0.25, 0.25, 0.75, 0.75, 0.75];

    // A line glyph that follows a direction in screen space, for fin rays and ripple rings.
    function lineGlyph(dx, dy) {
        const d = Math.hypot(dx, dy) || 1;
        if (Math.abs(dy) < 0.38 * d) return "-";
        if (Math.abs(dx) < 0.38 * d) return "|";
        return dx * dy > 0 ? "\\" : "/";
    }

    function valueNoise(x, y, seed) {
        const xi = Math.floor(x);
        const yi = Math.floor(y);
        const u = smoothstep(0, 1, x - xi);
        const v = smoothstep(0, 1, y - yi);
        const a = hash3(xi, yi, seed);
        const b = hash3(xi + 1, yi, seed);
        const c = hash3(xi, yi + 1, seed);
        const d = hash3(xi + 1, yi + 1, seed);
        return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
    }

    const inPatch = (m, s, vn, wobble) => ((s - m.s) / m.rs) ** 2 + ((vn - m.v) / m.rv) ** 2 < 1 + wobble;

    /**
     * Each koi gets a fixed set of markings, seeded by its id, so every fish carries a clear pattern:
     * kohaku a red head and two or three red saddles on white, sanke the same plus small black spots,
     * tancho a single red disc on the crown.
     */
    function koiMarkings(k) {
        const r = (j) => hash3(k.id, j, 41);
        if (k.variety === "tancho") return { red: [{ s: 0.11, v: 0, rs: 0.05, rv: 0.055 }], black: [] };

        const red = [];
        if (r(0) < 0.75) red.push({ s: 0.1, v: (r(1) - 0.5) * 0.03, rs: 0.055 + r(2) * 0.03, rv: 0.11 });
        const saddles = 2 + Math.floor(r(3) * 2);
        for (let j = 0; j < saddles; j++) {
            const span = 0.42 / saddles;
            red.push({
                s: 0.25 + span * (j + 0.5) + (r(10 + j) - 0.5) * span * 0.3,
                v: (r(20 + j) - 0.5) * 0.05,
                rs: span * (0.32 + r(30 + j) * 0.12),
                rv: 0.09 + r(40 + j) * 0.05,
            });
        }

        const black = [];
        if (k.variety === "sanke") {
            const spots = 4 + Math.floor(r(50) * 3);
            for (let j = 0; j < spots; j++) {
                black.push({ s: 0.24 + r(60 + j) * 0.44, v: (r(70 + j) - 0.5) * 0.16, rs: 0.022, rv: 0.026 });
            }
        }
        return { red, black };
    }

    const packRgb = (c) => (c[0] << 16) | (c[1] << 8) | c[2];
    const mix = (a, b, k) => [
        (a[0] + (b[0] - a[0]) * k) | 0,
        (a[1] + (b[1] - a[1]) * k) | 0,
        (a[2] + (b[2] - a[2]) * k) | 0,
    ];
    const shade = (c, k) => [Math.min(255, c[0] * k) | 0, Math.min(255, c[1] * k) | 0, Math.min(255, c[2] * k) | 0];

    /** Sample a colour ramp at t in [0, 1]. */
    function ramp(stops, t) {
        const x = clamp(t, 0, 1) * (stops.length - 1);
        const i = Math.min(stops.length - 2, Math.floor(x));
        return mix(stops[i], stops[i + 1], x - i);
    }

    class KoiRenderer {
        constructor(canvas) {
            const ctx = canvas.getContext("2d");
            if (!ctx) throw new Error("2D canvas unavailable");
            this.ctx = ctx;
            this.dpr = 1;
            this.cw = 8;
            this.ch = 12;
            this.cols = 0;
            this.rows = 0;
            this.palette = PALETTE;
            this.styles = new Map();
            this.markingCache = new Map();
            this.fontFamily = "ui-monospace, SFMono-Regular, Menlo, monospace";

            this.energy = new Float32Array(0);
            this.energyTmp = new Float32Array(0);
            this.cellGlyph = new Uint16Array(0);
            this.cellColor = new Uint32Array(0);
            this.cellAlpha = new Float32Array(0);
            this.cellTile = new Uint32Array(0);
            this.cellTileAlpha = new Float32Array(0);
            this.cellDim = new Float32Array(0);
            /** Cells under a koi's shadow on the pond floor. */
            this.cellShadow = new Uint8Array(0);

            this.spine = new Float32Array(KOI_NODES * 2);
            this.arc = new Float32Array(KOI_NODES);
            this.arcTotal = 1;
            this.flareLeft = 1;
            this.flareRight = 1;
            // Scratch outputs of sample(), to avoid allocating per sample.
            this.hit = { flag: 0, across: 1, du: 1, da: 0 };
            this.hitS = 0;
            this.hitV = 0;
            this.hitDist = 0;
            this.hitTx = 1;
            this.hitTy = 0;
            this.hitSeg = 0;
        }

        resize(width, height, dpr) {
            this.dpr = dpr;
            // Near-square tiles, large enough to read each etched glyph.
            this.cw = clamp(Math.round(width / 125), 8, 12);
            this.ch = this.cw + 2;
            this.cols = Math.ceil(width / this.cw);
            this.rows = Math.ceil(height / this.ch);
            this.ctx.canvas.width = Math.round(width * dpr);
            this.ctx.canvas.height = Math.round(height * dpr);

            const n = this.cols * this.rows;
            this.energy = new Float32Array(n);
            this.energyTmp = new Float32Array(n);
            this.cellGlyph = new Uint16Array(n);
            this.cellColor = new Uint32Array(n);
            this.cellAlpha = new Float32Array(n);
            this.cellTile = new Uint32Array(n);
            this.cellTileAlpha = new Float32Array(n);
            this.cellDim = new Float32Array(n).fill(1);
            this.cellShadow = new Uint8Array(n);
        }

        /** Fade koi under these canvas-space boxes, easing back in over `padCells` cells around them. */
        setDimBoxes(boxes, padCells = 4) {
            const { cols, rows, cw, ch, cellDim } = this;
            cellDim.fill(1);
            const pad = cw * padCells;
            for (const b of boxes) {
                const c0 = Math.max(0, Math.floor((b.left - pad) / cw));
                const c1 = Math.min(cols - 1, Math.floor((b.right + pad) / cw));
                const r0 = Math.max(0, Math.floor((b.top - pad) / ch));
                const r1 = Math.min(rows - 1, Math.floor((b.bottom + pad) / ch));
                for (let r = r0; r <= r1; r++) {
                    for (let c = c0; c <= c1; c++) {
                        const x = c * cw + cw / 2;
                        const y = r * ch + ch / 2;
                        const d = Math.hypot(
                            Math.max(b.left - x, 0, x - b.right),
                            Math.max(b.top - y, 0, y - b.bottom)
                        );
                        const i = r * cols + c;
                        cellDim[i] = Math.min(
                            cellDim[i],
                            DIM_UNDER_CONTENT + (1 - DIM_UNDER_CONTENT) * smoothstep(0, pad, d)
                        );
                    }
                }
            }
        }

        render(world, dt) {
            const { ctx, dpr, cols } = this;
            if (cols === 0) return;

            this.cellGlyph.fill(0);
            this.cellTileAlpha.fill(0);
            this.cellShadow.fill(0);
            // Deeper koi first, so the ones near the surface glide over them.
            for (const k of [...world.koi].sort((a, b) => a.depth - b.depth)) this.rasterizeKoi(k, world.time);
            this.depositWake(world);
            this.diffuse(dt);

            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            ctx.font = `600 ${Math.round(this.ch * 0.72)}px ${this.fontFamily}`;
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";

            this.drawShadows();
            this.drawWake();
            this.drawRipples(world);
            this.drawPellets(world);
            this.drawCells();
            this.drawBites(world);
            ctx.globalAlpha = 1;
        }

        style(rgb) {
            let s = this.styles.get(rgb);
            if (!s) {
                s = `rgb(${rgb >>> 16},${(rgb >>> 8) & 255},${rgb & 255})`;
                this.styles.set(rgb, s);
            }
            return s;
        }

        // Water marks are dimmed under text too, so nothing light crosses a line of copy.
        glyphAt(i, glyph, rgb, alpha) {
            const { ctx, cw, ch, cols } = this;
            ctx.globalAlpha = alpha * this.cellDim[i];
            ctx.fillStyle = this.style(packRgb(rgb));
            ctx.fillText(glyph, (i % cols) * cw + cw / 2, ((i / cols) | 0) * ch + ch / 2);
        }

        cellIndex(x, y) {
            const c = Math.floor(x / this.cw);
            const r = Math.floor(y / this.ch);
            if (c < 0 || r < 0 || c >= this.cols || r >= this.rows) return -1;
            return r * this.cols + c;
        }

        /** Find the nearest point on the render spine, then classify it against the koi's outline. */
        sample(px, py, L, from = 0, to = KOI_NODES - 2) {
            const { spine, arc } = this;
            let best = Infinity;
            let bestS = 0;
            let bestSign = 1;
            let past = 0;
            let ahead = 0;
            let lateral = 0;
            for (let n = from; n <= to; n++) {
                const ax = spine[n * 2];
                const ay = spine[n * 2 + 1];
                const sx = spine[(n + 1) * 2] - ax;
                const sy = spine[(n + 1) * 2 + 1] - ay;
                const len2 = sx * sx + sy * sy || 1;
                const raw = ((px - ax) * sx + (py - ay) * sy) / len2;
                const u = clamp(raw, 0, 1);
                const d2 = (px - ax - sx * u) ** 2 + (py - ay - sy * u) ** 2;
                if (d2 < best) {
                    const len = Math.sqrt(len2);
                    best = d2;
                    bestS = (arc[n] + u * len) / this.arcTotal;
                    bestSign = sx * (py - ay) - sy * (px - ax) >= 0 ? 1 : -1;
                    past = n === KOI_NODES - 2 ? Math.max(0, raw - 1) * len : 0;
                    ahead = n === 0 ? Math.max(0, -raw) * len : 0;
                    lateral = Math.abs(sx * (py - ay) - sy * (px - ax)) / len;
                    this.hitTx = sx / len;
                    this.hitTy = sy / len;
                    this.hitSeg = n;
                }
            }

            const a = Math.sqrt(best);
            this.hitDist = a;
            this.hitS = bestS;
            this.hitV = a * bestSign;
            return classify(
                bestS,
                a / L,
                past / L,
                bestSign > 0 ? this.flareLeft : this.flareRight,
                this.hit,
                ahead / L,
                lateral / L
            );
        }

        /** Skin colour for a body point, from the koi's own markings pinned to body coordinates. */
        skin(k, s, v, across) {
            const p = this.palette;
            const vn = v / k.length;
            // Belly edges and the tail stalk stay white on every variety, which frames the markings.
            if (across > 0.9 || s > 0.74) return p.white;
            // Ragged edges, so patches read as painted markings rather than ellipses.
            const wobble = (valueNoise(s * 14 + k.id, vn * 30, k.id + 3) - 0.5) * 0.6;
            const markings = this.markings(k);
            for (const m of markings.black) if (inPatch(m, s, vn, wobble)) return p.black;
            for (const m of markings.red) if (inPatch(m, s, vn, wobble)) return p.red;
            return p.white;
        }

        markings(k) {
            let m = this.markingCache.get(k.id);
            if (!m) {
                m = koiMarkings(k);
                this.markingCache.set(k.id, m);
            }
            return m;
        }

        rasterizeKoi(k, t) {
            const { spine, arc, cw, ch, cols, rows, cellGlyph, cellColor, cellAlpha, cellTile, cellTileAlpha, palette } =
                this;
            const L = k.length;
            const nodes = k.nodes;
            // The body only undulates while the tail is beating; coasting koi hold almost straight.
            const swim = 0.2 + 1.1 * k.beat;

            // Travelling body wave that grows toward the tail.
            for (let n = 0; n < KOI_NODES; n++) {
                const s = n / (KOI_NODES - 1);
                const a = Math.max(0, n - 1);
                const b = Math.min(KOI_NODES - 1, n + 1);
                let tx = nodes[a * 2] - nodes[b * 2];
                let ty = nodes[a * 2 + 1] - nodes[b * 2 + 1];
                const tl = Math.hypot(tx, ty) || 1;
                tx /= tl;
                ty /= tl;
                const amp = L * 0.04 * (0.05 + 0.95 * Math.pow(s, 2.2)) * swim;
                const off = amp * Math.sin(k.phase - s * 4.6);
                spine[n * 2] = nodes[n * 2] - ty * off;
                spine[n * 2 + 1] = nodes[n * 2 + 1] + tx * off;
            }
            arc[0] = 0;
            for (let n = 1; n < KOI_NODES; n++) {
                arc[n] =
                    arc[n - 1] +
                    Math.hypot(spine[n * 2] - spine[(n - 1) * 2], spine[n * 2 + 1] - spine[(n - 1) * 2 + 1]);
            }
            this.arcTotal = arc[KOI_NODES - 1] || 1;
            // Pectorals tuck in during a burst, scull in turn while coasting, and the inner one spreads to brake on a turn.
            const spread = 1 - 0.25 * k.beat;
            const scull = 0.18 * (1 - k.beat) * Math.sin(k.finPhase);
            const bank = clamp(k.turn * 0.6, -0.35, 0.35);
            this.flareLeft = spread + scull - bank;
            this.flareRight = spread - scull + bank;

            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (let n = 0; n < KOI_NODES; n++) {
                minX = Math.min(minX, spine[n * 2]);
                maxX = Math.max(maxX, spine[n * 2]);
                minY = Math.min(minY, spine[n * 2 + 1]);
                maxY = Math.max(maxY, spine[n * 2 + 1]);
            }
            const reach = L * 0.26;
            const c0 = Math.max(0, Math.floor((minX - reach) / cw));
            const c1 = Math.min(cols - 1, Math.floor((maxX + reach) / cw));
            const r0 = Math.max(0, Math.floor((minY - reach) / ch));
            const r1 = Math.min(rows - 1, Math.floor((maxY + reach) / ch));
            if (c0 > c1 || r0 > r1) return;

            const diag = Math.hypot(cw, ch);
            // Near the surface a koi is brighter and its shadow falls farther away on the floor.
            const shadowDc = Math.round((L * 0.07 * k.depth) / cw) + 1;
            const shadowDr = Math.round((L * 0.05 * k.depth) / ch) + 1;
            const dim = palette.alpha * (palette.depthFloor + (1 - palette.depthFloor) * k.depth);
            const [tile0, tile1] = palette.tile;
            const hit = this.hit;

            for (let r = r0; r <= r1; r++) {
                for (let c = c0; c <= c1; c++) {
                    const x = c * cw;
                    const y = r * ch;
                    const centerHit = this.sample(x + cw / 2, y + ch / 2, L);
                    // Nothing reaches far from the spine at the waist, where the fins end.
                    if (!centerHit && this.hitDist > L * (this.hitS > 0.4 && this.hitS < 0.62 ? 0.15 : 0.25) + diag) {
                        // Distance to the spine changes by at most a cell per cell, so skip cells that can't reach it.
                        c += Math.max(0, Math.floor((this.hitDist - L * 0.25 - diag) / cw));
                        continue;
                    }
                    // Sub-samples sit within a cell of the centre, so only the neighbouring segments can be nearest.
                    const from = Math.max(0, this.hitSeg - 2);
                    const to = Math.min(KOI_NODES - 2, this.hitSeg + 2);
                    let { flag, across } = hit;
                    let s = this.hitS;
                    let v = this.hitV;
                    let tx = this.hitTx;
                    let ty = this.hitTy;

                    let hits = centerHit ? 1 : 0;
                    // Points from the cell centre toward the covered side, i.e. across the outline into the koi.
                    let gx = 0;
                    let gy = 0;
                    // Cells well inside the body can't have a sub-sample outside it, so skip straight to full coverage.
                    const deepInside =
                        centerHit &&
                        flag !== FLAG_FIN &&
                        flag !== FLAG_BARBEL &&
                        s > 0.04 &&
                        s < 0.72 &&
                        bodyHalfWidth(s) * L - this.hitDist > diag * 0.35;
                    if (deepInside) hits = 5;
                    for (let q = 0; !deepInside && q < SUBSAMPLES.length; q += 2) {
                        if (!this.sample(x + SUBSAMPLES[q] * cw, y + SUBSAMPLES[q + 1] * ch, L, from, to)) continue;
                        gx += (SUBSAMPLES[q] - 0.5) * cw;
                        gy += (SUBSAMPLES[q + 1] - 0.5) * ch;
                        if (hits === 0) {
                            ({ flag, across } = hit);
                            s = this.hitS;
                            v = this.hitV;
                            tx = this.hitTx;
                            ty = this.hitTy;
                        }
                        hits++;
                    }
                    if (hits === 0) continue;
                    this.hitTx = tx;
                    this.hitTy = ty;
                    const coverage = hits / 5;
                    const side = v >= 0 ? 1 : -1;

                    const i = r * cols + c;
                    // Body-anchored key so each glyph rides along with the skin.
                    const key = (hash3(Math.round(s * 90), Math.round(v / (cw * 0.8)), k.id) * 4294967295) >>> 0;
                    const solid = centerHit && coverage >= 0.6;

                    let glyph = " ";
                    let rgb = palette.fin;
                    let alpha = dim;
                    let tile = null;
                    let tileAlpha = 0;
                    if (flag === FLAG_BARBEL) {
                        // Drawn along the whisker: forward from the mouth and angled out to its side.
                        glyph = lineGlyph(-tx - side * ty * 0.7, -ty + side * tx * 0.7);
                        rgb = shade(mix(palette.bg, palette.fin, 0.9), palette.ink + 0.3);
                    } else if (flag === FLAG_EYE && solid) {
                        tile = mix(palette.bg, palette.eye, 0.85);
                        tileAlpha = dim;
                        glyph = "o";
                        rgb = mix(palette.bg, palette.white, 0.9);
                    } else if (flag === FLAG_FIN) {
                        // Fins are a pale veil of tiles flecked with dots, so they never compete with the body.
                        tile = mix(palette.bg, palette.fin, 0.55);
                        tileAlpha = dim * 0.45 * coverage;
                        if (key % 2 === 0) {
                            glyph = ".";
                            alpha *= 0.6 * coverage;
                        }
                    } else {
                        // Each skin cell is a tile washed in the skin colour, shaded like a rounded back lit from
                        // the top-left, with a dense glyph etched on top. Edge cells get a paler, empty tile.
                        const skin = this.skin(k, s, v, across);
                        const facing = side * (0.6 * ty - 0.8 * tx) * across;
                        const lum = clamp(0.22 + 0.5 * Math.sqrt(1 - across * across) + 0.18 * facing, 0, 1);
                        if (skin === palette.red) {
                            // Red patches run the full hi ramp: crimson in shadow, vermilion across the back, orange
                            // to amber where the light hits. Each koi leans a little redder or more orange, and a
                            // slow body-pinned noise varies the hue within a patch, like real pigment.
                            const lean = (hash3(k.id, 5, 17) - 0.5) * 0.3;
                            const grain = (valueNoise(s * 9 + k.id, (v / L) * 18, k.id + 21) - 0.5) * 0.25;
                            // A band of shine travels down the body, like light sliding over wet scales.
                            const sheen = Math.max(0, Math.sin(s * 11 - t * 1.8 + k.id) - 0.7) / 0.3;
                            tile = ramp(palette.hi, 0.15 + 0.8 * lum + lean + grain + sheen * 0.35);
                        } else {
                            tile = mix(palette.bg, skin, tile0 + (tile1 - tile0) * lum);
                        }
                        if (hits === 5) {
                            const sc = c + shadowDc;
                            const sr = r + shadowDr;
                            if (sc < cols && sr < rows) this.cellShadow[sr * cols + sc] = 1;
                            tileAlpha = dim;
                            if (s < 0.035 && across < 0.6 && k.gulp > 0.5) {
                                glyph = "o";
                                rgb = palette.eye;
                            } else {
                                const jitter = (key >>> 4) % 3;
                                glyph = TILE_GLYPHS[clamp(Math.round((1 - lum) * 4) + jitter, 0, TILE_GLYPHS.length - 1)];
                                rgb = shade(tile, palette.ink);
                                // White skin is etched lightly so the red and black patches carry the pattern.
                                if (skin === palette.white) alpha *= 0.6;
                                // Scales glint on a staggered clock.
                                const tick = Math.floor(t * 1.4 + (key % 997) / 97);
                                if (hash3(key, tick, 7) < 0.03) tile = mix(tile, palette.bg, 0.45);
                            }
                        } else {
                            tileAlpha = dim * coverage * 0.55;
                            if (Math.hypot(gx, gy) > cw * 0.2 && key % 3 === 0) {
                                glyph = ".";
                                rgb = shade(tile, palette.ink);
                            }
                        }
                    }
                    if (glyph === " " && tileAlpha === 0) continue;
                    cellTile[i] = tile ? packRgb(tile) : 0;
                    cellTileAlpha[i] = tileAlpha;
                    cellGlyph[i] = glyph.charCodeAt(0);
                    cellColor[i] = packRgb(rgb);
                    cellAlpha[i] = alpha;
                }
            }
        }

        drawCells() {
            const { ctx, cw, ch, cols, cellGlyph, cellColor, cellAlpha, cellTile, cellTileAlpha, cellDim } = this;
            for (let i = 0; i < cellGlyph.length; i++) {
                const code = cellGlyph[i];
                if (!code) continue;
                const x = (i % cols) * cw;
                const y = ((i / cols) | 0) * ch;
                if (cellTileAlpha[i] > 0) {
                    ctx.globalAlpha = cellTileAlpha[i] * cellDim[i];
                    ctx.fillStyle = this.style(cellTile[i]);
                    ctx.fillRect(x + 1, y + 1, cw - 1, ch - 1);
                }
                if (code === 32) continue;
                ctx.globalAlpha = cellAlpha[i] * cellDim[i];
                ctx.fillStyle = this.style(cellColor[i]);
                ctx.fillText(String.fromCharCode(code), x + cw / 2, y + ch / 2 + 1);
            }
        }

        // ── water ─────────────────────────────────────────────────────────

        depositWake(world) {
            const { energy } = this;
            for (const k of world.koi) {
                for (let n = KOI_NODES - 4; n < KOI_NODES; n++) {
                    const i = this.cellIndex(k.nodes[n * 2], k.nodes[n * 2 + 1]);
                    if (i >= 0) energy[i] = Math.min(1.5, energy[i] + 0.035 + k.speed * 0.0012);
                }
            }
            if (world.pointer.active) {
                const i = this.cellIndex(world.pointer.x, world.pointer.y);
                if (i >= 0) energy[i] = Math.min(1.5, energy[i] + 0.12);
            }
        }

        /** Blur and decay so wakes spread like ripples and fade. */
        diffuse(dt) {
            const { cols, rows, energy, energyTmp: tmp } = this;
            const decay = Math.exp(-dt * 1.1);
            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const i = r * cols + c;
                    const l = c > 0 ? energy[i - 1] : energy[i];
                    const rt = c < cols - 1 ? energy[i + 1] : energy[i];
                    const u = r > 0 ? energy[i - cols] : energy[i];
                    const d = r < rows - 1 ? energy[i + cols] : energy[i];
                    tmp[i] = (energy[i] * 4 + l + rt + u + d) * 0.125 * decay;
                }
            }
            this.energy = tmp;
            this.energyTmp = energy;
        }

        drawShadows() {
            const { cellShadow, cellGlyph, palette } = this;
            for (let i = 0; i < cellShadow.length; i++) {
                if (!cellShadow[i] || cellGlyph[i]) continue;
                this.glyphAt(i, ":", palette.shadow, palette.shadowAlpha);
            }
        }

        drawWake() {
            const { energy, cellGlyph, cellShadow, palette } = this;
            for (let i = 0; i < energy.length; i++) {
                const e = energy[i];
                if (e < 0.22 || cellGlyph[i] || cellShadow[i]) continue;
                this.glyphAt(i, e > 0.5 ? "-" : ".", palette.water, Math.min(1, (e - 0.22) * 1.4) * 0.35);
            }
        }

        /** Expanding rings drawn as ASCII circles: the glyph follows the ring's tangent. */
        drawRipples(world) {
            const { cw, ch, cols, rows, cellGlyph, palette } = this;
            for (const rp of world.ripples) {
                const age = world.time - rp.born;
                const life = rippleLife(rp);
                const fade = Math.pow(1 - age / life, 1.5) * rp.strength;
                for (let ring = 0; ring < 2; ring++) {
                    const radius = Math.max(0, age - ring * 0.45) * RIPPLE_SPEED * (0.7 + 0.5 * rp.strength);
                    if (radius < 2) continue;
                    const band = cw * 0.6;
                    const c0 = Math.max(0, Math.floor((rp.x - radius - cw) / cw));
                    const c1 = Math.min(cols - 1, Math.floor((rp.x + radius + cw) / cw));
                    const r0 = Math.max(0, Math.floor((rp.y - radius - ch) / ch));
                    const r1 = Math.min(rows - 1, Math.floor((rp.y + radius + ch) / ch));
                    const alpha = fade * (ring === 0 ? 0.55 : 0.3);
                    for (let r = r0; r <= r1; r++) {
                        for (let c = c0; c <= c1; c++) {
                            const i = r * cols + c;
                            if (cellGlyph[i]) continue;
                            const dx = c * cw + cw / 2 - rp.x;
                            const dy = r * ch + ch / 2 - rp.y;
                            const d = Math.hypot(dx, dy);
                            if (Math.abs(d - radius) > band) continue;
                            const glyph = ring === 1 ? "." : lineGlyph(-dy, dx);
                            this.glyphAt(i, glyph, palette.water, alpha);
                        }
                    }
                }
            }
        }

        /** A bite flashes * over the koi's mouth, settling to + then a dot as the splash takes over. */
        drawBites(world) {
            const { palette } = this;
            for (const b of world.bites) {
                const i = this.cellIndex(b.x, b.y);
                if (i < 0) continue;
                const t = (world.time - b.born) / BITE_LIFE;
                const glyph = t < 0.35 ? "*" : t < 0.7 ? "+" : ".";
                this.glyphAt(i, glyph, palette.pellet, Math.min(1, palette.alpha * 1.6) * (1 - t * t));
            }
        }

        /** Pellets fall in (' then .), land as o with a splash, bob while floating, then dim to . as they sink. */
        drawPellets(world) {
            const { cellGlyph, palette, ch } = this;
            for (const p of world.pellets) {
                const age = world.time - p.born;
                if (!p.landed) {
                    const fall = age / p.landAt;
                    // Drawn a little above where it will land, closing in as it drops.
                    const i = this.cellIndex(p.x, p.y - (1 - fall) * ch * 1.5);
                    if (i < 0 || cellGlyph[i]) continue;
                    this.glyphAt(i, fall < 0.5 ? "'" : ".", palette.pellet, palette.alpha * (0.5 + 0.4 * fall));
                    continue;
                }
                const i = this.cellIndex(p.x, p.y);
                if (i < 0 || cellGlyph[i]) continue;
                const sink = smoothstep(PELLET_SINK, PELLET_LIFE, age);
                const bob = 0.8 + 0.2 * Math.sin(age * 3 + p.x);
                this.glyphAt(i, sink > 0.55 ? "." : "o", palette.pellet, palette.alpha * bob * (1 - 0.85 * sink));
            }
        }
    }

    // ── engine ────────────────────────────────────────────────────────────

    const STEP = 1 / 60;
    const MAX_STEPS = 4;
    const INTERACTIVE =
        "a, button, input, textarea, select, label, summary, details, [role='button'], [data-koi-ignore]";
    // Content over the pond carries this attribute; on wide screens koi steer around it and fade beneath it.
    const AVOID_TARGETS = "[data-koi-avoid]";
    // Re-measure the content boxes this often, in frames, to follow layout shifts.
    const MEASURE_EVERY_FRAMES = 30;
    const COLLECT_EVERY_FRAMES = 120;
    // Content boxes closer than this merge, so koi aren't squeezed into the slot between them.
    const MERGE_GAP_PX = 160;
    // Below this width the text fills the screen, so koi swim under it and fade only under each line.
    const NARROW = 700;

    function mergeNearby(boxes) {
        const merged = [];
        for (const b of [...boxes].sort((p, q) => p.top - q.top)) {
            const near = merged.find(
                (m) =>
                    b.top - m.bottom < MERGE_GAP_PX && b.left - m.right < MERGE_GAP_PX && m.left - b.right < MERGE_GAP_PX
            );
            if (!near) {
                merged.push({ ...b });
                continue;
            }
            near.left = Math.min(near.left, b.left);
            near.right = Math.max(near.right, b.right);
            near.bottom = Math.max(near.bottom, b.bottom);
        }
        return merged;
    }

    class PondEngine {
        constructor(canvas) {
            this.canvas = canvas;
            this.world = new World();
            this.renderer = new KoiRenderer(canvas);
            this.raf = 0;
            this.last = 0;
            this.acc = 0;
            this.frames = 0;
            this.lastPointerTime = 0;
            this.blocks = [];
            this.lines = [];
            this.scrollQueued = false;
            this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

            this.frame = this.frame.bind(this);
            this.schedule = this.schedule.bind(this);

            new ResizeObserver(() => this.resize()).observe(canvas);
            // Layout changes (a summary opening, rotation) move the text the koi fade under.
            new ResizeObserver(() => {
                this.collect();
                this.measureContent();
                if (this.reducedMotion.matches) this.drawStill();
            }).observe(document.body);
            this.reducedMotion.addEventListener("change", this.schedule);
            window.addEventListener("pointermove", (e) => this.onPointerMove(e), { passive: true });
            window.addEventListener("click", (e) => this.onClick(e));
            window.addEventListener("scroll", () => this.onScroll(), { passive: true });
            document.documentElement.addEventListener("pointerleave", () => this.onPointerLeave());
            window.addEventListener("blur", () => this.onPointerLeave());
            this.resize();
            this.schedule();
        }

        resize() {
            const rect = this.canvas.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1) return;
            this.renderer.resize(rect.width, rect.height, Math.min(window.devicePixelRatio || 1, 2));
            this.world.resize(rect.width, rect.height);
            this.collect();
            this.measureContent();
            if (this.reducedMotion.matches) this.drawStill();
        }

        schedule() {
            cancelAnimationFrame(this.raf);
            if (this.reducedMotion.matches) {
                this.drawStill();
                return;
            }
            this.last = performance.now();
            this.raf = requestAnimationFrame(this.frame);
        }

        /** Record content boxes and text lines in document space, so scrolling only has to shift them. */
        collect() {
            const sx = window.scrollX;
            const sy = window.scrollY;
            const toDoc = (r) => ({ left: r.left + sx, top: r.top + sy, right: r.right + sx, bottom: r.bottom + sy });
            this.blocks = Array.from(document.querySelectorAll(AVOID_TARGETS), (el) => el.getBoundingClientRect())
                .filter((b) => b.width > 0 && b.height > 0)
                .map(toDoc);
            this.lines = [];
            const range = document.createRange();
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                const el = n.parentElement;
                if (!el || !n.textContent.trim() || el.closest("script, style, .sr")) continue;
                range.selectNodeContents(n);
                for (const r of range.getClientRects()) {
                    if (r.width < 1) continue;
                    const b = toDoc(r);
                    this.lines.push({ left: b.left - 3, top: b.top - 2, right: b.right + 3, bottom: b.bottom + 2 });
                }
            }
        }

        measureContent() {
            const origin = this.canvas.getBoundingClientRect();
            const dx = window.scrollX + origin.left;
            const dy = window.scrollY + origin.top;
            const toCanvas = (b) => ({ left: b.left - dx, top: b.top - dy, right: b.right - dx, bottom: b.bottom - dy });
            const inView = (b) => b.bottom > -40 && b.top < origin.height + 40;
            if (origin.width < NARROW) {
                this.renderer.setDimBoxes(this.lines.map(toCanvas).filter(inView), 1);
                this.world.avoid = [];
            } else {
                const boxes = mergeNearby(this.blocks.map(toCanvas)).filter(inView);
                this.renderer.setDimBoxes(boxes, 4);
                this.world.avoid = boxes;
            }
        }

        onScroll() {
            if (this.scrollQueued) return;
            this.scrollQueued = true;
            requestAnimationFrame(() => {
                this.scrollQueued = false;
                this.measureContent();
                if (this.reducedMotion.matches) this.drawStill();
            });
        }

        frame(now) {
            const dt = Math.min(0.1, (now - this.last) / 1000);
            this.last = now;
            this.acc += dt;
            let steps = 0;
            while (this.acc >= STEP && steps < MAX_STEPS) {
                this.world.step(STEP);
                this.acc -= STEP;
                steps++;
            }
            if (steps === MAX_STEPS) this.acc = 0;
            this.frames++;
            if (this.frames % COLLECT_EVERY_FRAMES === 0) this.collect();
            if (this.frames % MEASURE_EVERY_FRAMES === 0) this.measureContent();
            this.renderer.render(this.world, dt);
            this.raf = requestAnimationFrame(this.frame);
        }

        // Reduced motion: let the koi spread out, then hold a single frame.
        drawStill() {
            if (this.world.time < 4) {
                for (let i = 0; i < 240; i++) this.world.step(STEP);
            }
            this.renderer.render(this.world, STEP);
        }

        toLocal(e) {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            return { x, y, inside: x >= 0 && y >= 0 && x <= rect.width && y <= rect.height };
        }

        onPointerMove(e) {
            const { x, y, inside } = this.toLocal(e);
            const p = this.world.pointer;
            const elapsed = Math.max(1, e.timeStamp - this.lastPointerTime) / 1000;
            const speed = Math.hypot(x - p.x, y - p.y) / elapsed;
            p.speed += (Math.min(speed, 5000) - p.speed) * 0.5;
            this.lastPointerTime = e.timeStamp;
            p.x = x;
            p.y = y;
            p.active = inside && e.pointerType !== "touch";
        }

        // Clicks on empty space drop food; links, buttons, and text selection are left alone.
        onClick(e) {
            if (this.reducedMotion.matches) return;
            if (e.composedPath().some((n) => n instanceof Element && n.matches(INTERACTIVE))) return;
            if (window.getSelection()?.toString()) return;
            const { x, y, inside } = this.toLocal(e);
            if (!inside) return;
            this.world.feed(x, y);
        }

        onPointerLeave() {
            this.world.pointer.active = false;
            this.world.pointer.speed = 0;
        }
    }

    const canvas = document.querySelector(".sea");
    if (canvas) new PondEngine(canvas);
})();
