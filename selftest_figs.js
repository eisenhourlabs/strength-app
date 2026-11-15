// ═══════════════════════════════════════════════════════════════════════════
// selftest_figs.js — one line drawing per self-test (Plan §7.3), drawn as SVG
// from data by ONE helper, so they read as a set: same body proportions, one
// line weight, start pose in grey, end pose in the main text colour, the phone
// as a filled accent bar with a mark on its long edge, an arc or bracket for
// what is measured, and floor / wall / bed as plain lines or boxes. Colours are
// the app's CSS variables. Preview sheet: 07_Documentation/self_test_figures_preview.html.
// Loads after selftests.js, before week.js. stFigureSvg(key) → '<svg…>' or ''.
// ═══════════════════════════════════════════════════════════════════════════

const ST_FIG = { W: 300, H: 180, line: 4, head: 9,
  len: { torso: 54, neck: 5, upper: 30, fore: 28, hand: 7, thigh: 42, shin: 40, foot: 12 } };

function stDir(deg) { const r = deg * Math.PI / 180; return [Math.cos(r), -Math.sin(r)]; }   // math angle, SVG y down
function stAt(p, deg, len) { const d = stDir(deg); return [p[0] + d[0] * len, p[1] + d[1] * len]; }
function stR(n) { return Math.round(n * 10) / 10; }

// A body from a hip point and absolute segment angles (degrees: 0 = right, 90 = up).
//   trunk, head (angle from the shoulders; default = trunk), arms: [[upper, fore], …], legs: [[thigh, shin, foot], …]
// Returns { pts, limbs, head }; points are named (hip, sh, hd, el1, wr1, kn1, an1, toe1, …).
function stBody(o) {
  const L = ST_FIG.len, p = {};
  p.hip = o.hip;
  p.sh = stAt(p.hip, o.trunk, L.torso);
  p.hd = stAt(p.sh, o.head == null ? o.trunk : o.head, L.neck + ST_FIG.head);
  const limbs = [['hip', 'sh']];
  (o.arms || []).forEach(function (a, i) {
    const n = i + 1;
    p['el' + n] = stAt(p.sh, a[0], L.upper);
    p['wr' + n] = stAt(p['el' + n], a[1], L.fore);
    p['hn' + n] = stAt(p['wr' + n], a[2] == null ? a[1] : a[2], L.hand);
    limbs.push(['sh', 'el' + n, 'wr' + n, 'hn' + n]);
  });
  (o.legs || []).forEach(function (g, i) {
    const n = i + 1;
    p['kn' + n] = stAt(p.hip, g[0], L.thigh);
    p['an' + n] = stAt(p['kn' + n], g[1], L.shin);
    p['toe' + n] = stAt(p['an' + n], g[2], L.foot);
    limbs.push(['hip', 'kn' + n, 'an' + n, 'toe' + n]);
  });
  return { pts: p, limbs: limbs, head: 'hd' };
}

// Draw a figure spec:
//   floor: y | wall: x | bed: [x, y, w, h] | box: [[x, y, w, h], …]
//   grey: pose | main: pose | extra: [pose, …] (main colour) — pose = { pts, limbs, head? }
//   phone: { a, b, t (0–1 along a→b), off (px, sideways) } — on the main pose's points
//   arc: { c, r, a0, a1 } (point name or [x, y]; math degrees, drawn a0 → a1) | arcs: [...]
//   bracket: [[x1, y1], [x2, y2]] | dash: [[[x1, y1], [x2, y2]], …] | strap: [p, q] | label: [[x, y, text], …]
function stDraw(f) {
  const W = ST_FIG.W, H = ST_FIG.H, lw = ST_FIG.line;
  const main = f.main || { pts: {} };
  const P = function (v, pose) { return typeof v === 'string' ? ((pose || main).pts[v] || (f.grey && f.grey.pts[v])) : v; };
  const C = { grey: 'var(--muted)', main: 'var(--text)', accent: 'var(--accent)', meas: '#d9a441', ground: 'var(--border)' };
  let s = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true" class="st-fig">';
  if (f.bed) s += '<rect x="' + f.bed[0] + '" y="' + f.bed[1] + '" width="' + f.bed[2] + '" height="' + f.bed[3] + '" rx="3" fill="var(--surface)" stroke="' + C.ground + '" stroke-width="2"/>';
  (f.box || []).forEach(function (b) { s += '<rect x="' + b[0] + '" y="' + b[1] + '" width="' + b[2] + '" height="' + b[3] + '" rx="3" fill="var(--surface)" stroke="' + C.ground + '" stroke-width="2"/>'; });
  if (f.floor != null) s += '<line x1="8" y1="' + f.floor + '" x2="' + (W - 8) + '" y2="' + f.floor + '" stroke="' + C.ground + '" stroke-width="3" stroke-linecap="round"/>';
  if (f.wall != null) s += '<line x1="' + f.wall + '" y1="10" x2="' + f.wall + '" y2="' + (f.floor || H - 8) + '" stroke="' + C.ground + '" stroke-width="3" stroke-linecap="round"/>';
  (f.dash || []).forEach(function (d) {
    s += '<line x1="' + stR(d[0][0]) + '" y1="' + stR(d[0][1]) + '" x2="' + stR(d[1][0]) + '" y2="' + stR(d[1][1]) + '" stroke="' + C.grey + '" stroke-width="1.5" stroke-dasharray="4 4"/>';
  });
  const pose = function (ps, col, w) {
    if (!ps) return '';
    let o = '';
    ps.limbs.forEach(function (l) {
      o += '<polyline fill="none" stroke="' + col + '" stroke-width="' + w + '" stroke-linecap="round" stroke-linejoin="round" points="'
        + l.map(function (k) { const q = ps.pts[k]; return stR(q[0]) + ',' + stR(q[1]); }).join(' ') + '"/>';
    });
    (ps.circles || []).forEach(function (c) { o += '<circle cx="' + stR(c[0]) + '" cy="' + stR(c[1]) + '" r="' + c[2] + '" fill="none" stroke="' + col + '" stroke-width="' + w + '"/>'; });
    if (ps.head && ps.pts[ps.head]) { const h = ps.pts[ps.head]; o += '<circle cx="' + stR(h[0]) + '" cy="' + stR(h[1]) + '" r="' + ST_FIG.head + '" fill="var(--bg)" stroke="' + col + '" stroke-width="' + w + '"/>'; }
    return o;
  };
  s += pose(f.grey, C.grey, lw - 1);
  (f.extra || []).forEach(function (e) { s += pose(e, C.main, lw); });
  s += pose(f.main, C.main, lw);
  if (f.strap) { const a = P(f.strap[0]), b = P(f.strap[1]); s += '<line x1="' + stR(a[0]) + '" y1="' + stR(a[1]) + '" x2="' + stR(b[0]) + '" y2="' + stR(b[1]) + '" stroke="' + C.accent + '" stroke-width="2" stroke-dasharray="2 3"/>'; }
  (f.arcs || (f.arc ? [f.arc] : [])).forEach(function (a) {
    const c = P(a.c), p0 = stAt(c, a.a0, a.r), p1 = stAt(c, a.a1, a.r);
    const sweep = a.a1 > a.a0 ? 0 : 1, large = Math.abs(a.a1 - a.a0) > 180 ? 1 : 0;
    s += '<path d="M' + stR(p0[0]) + ' ' + stR(p0[1]) + ' A' + a.r + ' ' + a.r + ' 0 ' + large + ' ' + sweep + ' ' + stR(p1[0]) + ' ' + stR(p1[1]) + '" fill="none" stroke="' + C.meas + '" stroke-width="2.5"/>';
    const tip = stAt(c, a.a1, a.r), back = stAt(c, a.a1 + (a.a1 > a.a0 ? -9 : 9), a.r);
    s += '<circle cx="' + stR(tip[0]) + '" cy="' + stR(tip[1]) + '" r="2.5" fill="' + C.meas + '"/>';
    void back;
  });
  if (f.bracket) {
    const a = f.bracket[0], b = f.bracket[1];
    const d = [b[0] - a[0], b[1] - a[1]], n = Math.hypot(d[0], d[1]) || 1, px = -d[1] / n * 5, py = d[0] / n * 5;
    s += '<path d="M' + stR(a[0] + px) + ' ' + stR(a[1] + py) + ' L' + stR(a[0]) + ' ' + stR(a[1]) + ' L' + stR(b[0]) + ' ' + stR(b[1]) + ' L' + stR(b[0] + px) + ' ' + stR(b[1] + py)
      + '" fill="none" stroke="' + C.meas + '" stroke-width="2.5"/>';
  }
  if (f.phone) {
    const a = P(f.phone.a), b = P(f.phone.b);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
    const t = f.phone.t == null ? 0.5 : f.phone.t;
    const off = f.phone.off == null ? -5 : f.phone.off;
    const cx = a[0] + (b[0] - a[0]) * t, cy = a[1] + (b[1] - a[1]) * t;
    const len = f.phone.len || 24;
    s += '<g transform="translate(' + stR(cx) + ' ' + stR(cy) + ') rotate(' + stR(ang) + ') translate(0 ' + off + ')">'
      + '<rect x="' + (-len / 2) + '" y="-4" width="' + len + '" height="8" rx="2" fill="' + C.accent + '"/>'
      + '<line x1="' + (-len / 2 + 3) + '" y1="-4" x2="' + (len / 2 - 3) + '" y2="-4" stroke="var(--text)" stroke-width="1.5"/></g>';
  }
  (f.label || []).forEach(function (l) { s += '<text x="' + l[0] + '" y="' + l[1] + '" font-size="11" fill="' + (l[3] || C.grey) + '" font-family="-apple-system,system-ui,sans-serif"' + (l[4] ? ' text-anchor="' + l[4] + '"' : '') + '>' + l[2] + '</text>'; });
  return s + '</svg>';
}

// Shared pieces
function stLying(hipX, y, opts) {         // on the back, head to the LEFT, legs to the right
  opts = opts || {};
  return stBody({ hip: [hipX, y], trunk: 180, arms: opts.arms || [[0, 0]], legs: opts.legs || [[0, 0, 90]] });
}
function stProne(hipX, y, opts) {         // face down, head to the LEFT
  opts = opts || {};
  return stBody({ hip: [hipX, y], trunk: 180, arms: opts.arms || [[0, 0]], legs: opts.legs || [[0, 0, -90]] });
}

const ST_FIGS = {
  // Side view on the back. Start: arm by the side (grey); end: overhead, resting toward the floor. Arc at the shoulder; dashed = ribs down.
  shoulder_flexion_supine: function () {
    const g = stLying(200, 150, { arms: [[6, 6]], legs: [[0, 0, 90]] });
    const m = stLying(200, 150, { arms: [[170, 172]], legs: [[0, 0, 90]] });
    return stDraw({ floor: 160, grey: g, main: m, phone: { a: 'el1', b: 'wr1', t: 0.5, off: -6 },
      arc: { c: m.pts.sh, r: 30, a0: 8, a1: 168 }, dash: [[[158, 138], [192, 138]]] });
  },
  // From behind, sitting back on the heels, folded over: left forearm on the floor, right elbow lifting as the chest
  // turns. Phone across the chest; the arc is the turn of the shoulder line from level.
  tspine_rotation: function () {
    const c = [150, 88], half = 30;
    const s0 = [stAt(c, 180, half), stAt(c, 0, half)], s1 = [stAt(c, 215, half), stAt(c, 35, half)];
    const grey = { pts: { a: s0[0], b: s0[1], hd: [150, 70] }, limbs: [['a', 'b']], head: 'hd' };
    const main = { pts: { shL: s1[0], shR: s1[1], hd: [158, 67], c: c, pel: [150, 132], hipL: [132, 134], hipR: [168, 134],
      knL: [128, 160], knR: [172, 160], elL: [116, 132], wrL: [110, 160], hnL: [94, 160], elR: [198, 46], wrR: [160, 86] },
      limbs: [['hipL', 'hipR'], ['knL', 'hipL'], ['knR', 'hipR'], ['pel', 'c'], ['shL', 'shR'], ['shL', 'elL', 'wrL', 'hnL'], ['shR', 'elR', 'wrR']], head: 'hd' };
    return stDraw({ floor: 162, grey: grey, main: main, phone: { a: 'shL', b: 'shR', t: 0.5, off: 0, len: 26 },
      dash: [[[96, c[1]], [210, c[1]]]], arc: { c: c, r: 46, a0: 0, a1: 35 }, label: [[14, 20, 'seen from behind', 'var(--muted)']] });
  },
  // Side view on a bed edge, one knee hugged, the other leg hanging. Grey = thigh level with the bed (a pass);
  // white = thigh floating up. Phone on the hanging thigh; dashed level line through the hip.
  hip_flexor_thomas: function () {
    const m = stBody({ hip: [176, 100], trunk: 180, arms: [[60, 10]], legs: [[135, -50, 0], [12, -90, 0]] });
    const hip = m.pts.hip, kn = stAt(hip, 0, 42), an = stAt(kn, -90, 40);
    const g = { pts: { hip: hip, kn: kn, an: an, toe: stAt(an, 0, 12) }, limbs: [['hip', 'kn', 'an', 'toe']] };
    return stDraw({ bed: [20, 108, 156, 14], floor: 176, grey: g, main: m, phone: { a: 'hip', b: 'kn2', t: 0.55, off: -6 },
      dash: [[[150, 100], [262, 100]]], arc: { c: hip, r: 34, a0: 0, a1: 12 } });
  },
  // Seen from the feet, face down: both shins straight up (grey), then both falling outward. Phone on one shin; arc from vertical.
  hip_ir_prone: function () {
    const kL = [130, 142], kR = [170, 142];
    const mk = function (d) {
      return { pts: { pl: [104, 144], pr: [196, 144], kL: kL, kR: kR, aL: stAt(kL, 90 + d, 46), aR: stAt(kR, 90 - d, 46) },
        limbs: [['pl', 'pr'], ['kL', 'aL'], ['kR', 'aR']] };
    };
    const g = mk(0), m = mk(36);
    return stDraw({ floor: 150, grey: g, main: m, phone: { a: 'kR', b: 'aR', t: 0.62, off: -6 },
      dash: [[kR, [kR[0], 82]]], arc: { c: kR, r: 32, a0: 90, a1: 54 }, label: [[14, 20, 'seen from the feet', 'var(--muted)']] });
  },
  // Side view on the back: one leg raised straight, phone on the shin; arc from the floor.
  hamstring_aslr: function () {
    const g = stLying(196, 150, { arms: [[0, 0]], legs: [[0, 0, 90], [0, 0, 90]] });
    const m = stLying(196, 150, { arms: [[0, 0]], legs: [[0, 0, 90], [76, 76, 166]] });
    return stDraw({ floor: 160, grey: g, main: m, phone: { a: 'kn2', b: 'an2', t: 0.5, off: -6 }, arc: { c: m.pts.hip, r: 36, a0: 2, a1: 76 } });
  },
  // Side view, lunging toward a wall: knee touches the wall, heel down; bracket on the floor from the wall to the big toe.
  ankle_knee_to_wall: function () {
    const p = { toe: [72, 158], an: [96, 152], hl: [104, 158], kn: [58, 122], hip: [96, 96], sh: [100, 42], hd: [102, 28],
      kn2: [122, 128], an2: [146, 154], toe2: [158, 158], el: [80, 60], wr: [58, 56] };
    const m = { pts: p, limbs: [['toe', 'an', 'kn', 'hip', 'sh'], ['an', 'hl', 'toe'], ['hip', 'kn2', 'an2', 'toe2'], ['sh', 'el', 'wr']], head: 'hd' };
    return stDraw({ floor: 160, wall: 54, main: m, bracket: [[54, 170], [72, 170]], label: [[80, 174, 'wall → big toe', 'var(--muted)']] });
  },
  // Side view, standing forward bend: bracket from the fingertips straight down to the floor.
  low_back_toe_touch: function () {
    const m = stBody({ hip: [190, 92], trunk: 185, head: 240, arms: [[282, 282]], legs: [[-90, -90, 180]] });
    return stDraw({ floor: 174, main: m, bracket: [[m.pts.hn1[0] - 12, m.pts.hn1[1]], [m.pts.hn1[0] - 12, 174]] });
  },
  // Side view: from sitting cross-legged on the floor (grey) to standing without using the hands.
  sit_rise: function () {
    const g = stBody({ hip: [90, 158], trunk: 90, arms: [[-60, -20]], legs: [[12, 192, 180]] });
    const m = stBody({ hip: [210, 84], trunk: 90, arms: [[-82, -90]], legs: [[-90, -90, 0]] });
    return stDraw({ floor: 166, grey: g, main: m, dash: [[[124, 112], [188, 84]]] });
  },
  // Side view on the back, upper arm straight out to the side (toward you), elbow bent 90°:
  // forearm straight up (grey), then turned toward the feet. Arc from vertical.
  shoulder_ir_supine: function () { return stShoulderRot(35); },
  // Same set-up, forearm turned back toward the head.
  shoulder_er_supine: function () { return stShoulderRot(150); },
  // Seen from the head end, lying on one side: shoulders stacked (grey), then the top shoulder turned open toward the floor.
  tspine_rotation_side: function () {
    const c = [150, 120], half = 30;
    const s0 = [stAt(c, 90, half), stAt(c, 270, half)], s1 = [stAt(c, 140, half), stAt(c, 320, half)];
    const g = { pts: { a: s0[0], b: s0[1], e: [178, 98], w: [190, 122] }, limbs: [['a', 'b'], ['a', 'e', 'w']] };
    const m = { pts: { a: s1[0], b: s1[1], e: [100, 112], w: [76, 134] }, limbs: [['a', 'b'], ['a', 'e', 'w']], circles: [[c[0], c[1], 10]] };
    return stDraw({ floor: 156, grey: g, main: m, phone: { a: 'a', b: 'b', t: 0.5, off: -16, len: 24 },
      dash: [[c, [c[0], 66]]], arc: { c: c, r: 48, a0: 90, a1: 140 }, label: [[14, 20, 'seen from the head end', 'var(--muted)']] });
  },
  // Seen from the feet, on the back, one leg in a figure 4 (ankle resting on the other knee). The knee drops toward
  // the floor; a tight hip keeps it up. The bent shin's tilt above level is the reading (grey = shin level, the goal).
  hip_er_faber: function () {
    const an = [158, 122], hp = [196, 136];
    const mk = function (kn) { return { pts: { pl: [104, 136], pr: hp, hp: hp, kn: kn, an: an }, limbs: [['pl', 'pr'], ['hp', 'kn', 'an']] }; };
    const g = mk([238, 124]), m = mk([232, 92]);
    m.circles = [[150, 130, 7]];
    const tilt = Math.atan2(-(m.pts.kn[1] - an[1]), m.pts.kn[0] - an[0]) * 180 / Math.PI;
    return stDraw({ floor: 146, grey: g, main: m, phone: { a: 'an', b: 'kn', t: 0.5, off: -6 },
      dash: [[an, [270, an[1]]]], arc: { c: an, r: 50, a0: 0, a1: tilt },
      label: [[14, 20, 'seen from the feet', 'var(--muted)'], [118, 160, 'ankle on the other knee', 'var(--muted)']] });
  },
  // Side view, face down: one knee bent, heel pulled toward the butt with a strap; bracket = the gap.
  knee_heel_to_butt: function () {
    const m = stProne(190, 146, { arms: [[5, 5]], legs: [[0, 0, 0], [0, 140, 50]] });
    return stDraw({ floor: 156, main: m, strap: ['hn1', 'toe2'], bracket: [[m.pts.an2[0] - 4, m.pts.an2[1] + 4], [m.pts.hip[0] + 2, m.pts.hip[1] - 8]] });
  },
  // Seen from above: shoulders and head; facing forward (grey), then turned toward one shoulder.
  neck_rotation: function () {
    const c = [150, 100];
    const nose = function (deg) { return { a: stAt(c, deg, 16), b: stAt(c, deg, 30) }; };
    const n0 = nose(-90), n1 = nose(-12);
    const g = { pts: { a: n0.a, b: n0.b }, limbs: [['a', 'b']] };
    const m = { pts: { l: [88, 104], r: [212, 104], a: n1.a, b: n1.b }, limbs: [['l', 'r'], ['a', 'b']], circles: [[c[0], c[1], 16]] };
    return stDraw({ grey: g, main: m, arc: { c: c, r: 42, a0: -90, a1: -12 }, label: [[14, 20, 'seen from above', 'var(--muted)'], [150, 166, 'chin over the shoulder', 'var(--muted)', 'middle']] });
  },
  // Side view on hands and knees: arm straight up and down over a flat hand; dotted line wrist → shoulder.
  wrist_ext_floor: function () {
    const p = { kn: [200, 154], an: [248, 154], hip: [200, 104], sh: [124, 104], hd: [104, 94], wr: [124, 152], hn: [102, 154] };
    const m = { pts: p, limbs: [['an', 'kn', 'hip', 'sh', 'wr', 'hn']], head: 'hd' };
    return stDraw({ floor: 156, main: m, dash: [[[138, 152], [138, 104]]], label: [[14, 20, 'shoulder straight over the wrist', 'var(--muted)']] });
  },
  // Side view, standing, hands on the low back: upright (grey), then leaning back.
  low_back_extension: function () {
    const leg = [[-90, -90, 0]];
    const g = stBody({ hip: [150, 92], trunk: 90, legs: leg });
    g.pts.el = [142, 64]; g.pts.wr = [142, 86]; g.limbs.push(['sh', 'el', 'wr']);
    const m = stBody({ hip: [150, 92], trunk: 110, head: 116, legs: leg });
    m.pts.el = [122, 66]; m.pts.wr = [140, 84]; m.limbs.push(['sh', 'el', 'wr']);
    return stDraw({ floor: 176, grey: g, main: m, arc: { c: m.pts.hip, r: 40, a0: 90, a1: 110 } });
  },
  // Front view of two straight legs: soft tape around one knee at the middle of the kneecap.
  knee_swelling_girth: function () {
    const m = { pts: { hl: [128, 20], kl: [130, 96], al: [132, 162], fl: [118, 168], hr: [172, 20], kr: [170, 96], ar: [168, 162], fr: [182, 168], pl: [122, 20], pr: [178, 20] },
      limbs: [['pl', 'pr'], ['hl', 'kl', 'al', 'fl'], ['hr', 'kr', 'ar', 'fr']], circles: [[130, 96, 5], [170, 96, 5]] };
    const tape = '<ellipse cx="130" cy="96" rx="15" ry="5" fill="none" stroke="var(--accent)" stroke-width="3"/>';
    return stDraw({ floor: 170, main: m, label: [[98, 100, 'mid-kneecap', 'var(--muted)', 'end']] }).replace('</svg>', tape + '</svg>');
  },
  // Side view, face down on a bed, lower legs hanging straight off the end: one heel sits lower (grey leg);
  // the helper reads the gap between the heels at eye level.
  knee_extension_heel_height: function () {
    const a = stProne(126, 92, { arms: [[-6, 0]], legs: [[0, -3, -95]] });
    const kn = a.pts.kn1, anB = stAt(kn, -15, 40);
    const b = { pts: { k: kn, an: anB, toe: stAt(anB, -105, 12) }, limbs: [['k', 'an', 'toe']] };
    const x = Math.max(a.pts.an1[0], anB[0]) + 12;
    return stDraw({ bed: [16, 100, 154, 16], floor: 176, grey: b, main: a,
      bracket: [[x, a.pts.an1[1]], [x, anB[1]]],
      dash: [[[x + 8, a.pts.an1[1]], [288, a.pts.an1[1]]]], label: [[288, a.pts.an1[1] - 6, '👁 helper, eye level', 'var(--muted)', 'end']] });
  },
};
function stShoulderRot(deg) {
  const base = function (d) {
    const b = stLying(236, 150, { arms: [], legs: [[0, 0, 90]] });
    b.pts.el = [b.pts.sh[0] + 14, 146];
    b.pts.wr = stAt(b.pts.el, d, 36);
    b.limbs.push(['sh', 'el', 'wr']);
    return b;
  };
  const g = base(90), m = base(deg);
  return stDraw({ floor: 160, grey: g, main: m, phone: { a: 'el', b: 'wr', t: 0.6, off: deg > 90 ? 6 : -6 },
    dash: [[m.pts.el, [m.pts.el[0], 92]]], arc: { c: m.pts.el, r: 26, a0: 90, a1: deg },
    label: [[14, 20, 'upper arm out to the side', 'var(--muted)'], [14, 34, 'other hand holds the shoulder', 'var(--muted)']] });
}

function stFigureSvg(key) {
  const f = ST_FIGS[key];
  if (!f) return '';
  try { return f(); } catch (e) { console.error('figure ' + key, e); return ''; }
}
if (typeof module !== 'undefined' && module.exports) module.exports = { stFigureSvg: stFigureSvg, ST_FIGS: ST_FIGS };
