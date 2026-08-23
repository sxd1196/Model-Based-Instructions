/**
 * Generate a valid AP203 STEP file containing two separate named box solids.
 *
 *   node scripts/make-step-fixture.mjs > src/cad/fixtures/two_boxes.step
 *
 * Hand-writing this by hand is error-prone: a box needs 8 vertices, 12 edges
 * and 6 ADVANCED_FACEs with consistent orientation. A generator keeps the
 * fixture reproducible and lets us prove the STEP importer preserves SEPARATE
 * parts rather than merging them (AGENTS.md §2.5).
 *
 * Note: BLOCK() — the CSG primitive — parses but tessellates to nothing, which
 * is why this emits explicit B-rep geometry instead.
 */

let id = 0;
const lines = [];
const next = () => `#${++id}`;

const emit = (text) => {
  const ref = next();
  lines.push(`${ref} = ${text};`);
  return ref;
};

const point = (x, y, z) => emit(`CARTESIAN_POINT('',(${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}))`);
const direction = (x, y, z) => emit(`DIRECTION('',(${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}))`);

/** One axis-aligned box as a closed manifold B-rep shell. */
function makeBox(name, ox, oy, oz, w, h, d) {
  // 8 corners
  const c = [
    [ox, oy, oz], [ox + w, oy, oz], [ox + w, oy + h, oz], [ox, oy + h, oz],
    [ox, oy, oz + d], [ox + w, oy, oz + d], [ox + w, oy + h, oz + d], [ox, oy + h, oz + d],
  ];
  const pts = c.map((p) => point(p[0], p[1], p[2]));
  const verts = pts.map((p) => emit(`VERTEX_POINT('',${p})`));

  // 12 edges as (start, end) corner indices
  const edgeDefs = [
    [0, 1], [1, 2], [2, 3], [3, 0],       // bottom
    [4, 5], [5, 6], [6, 7], [7, 4],       // top
    [0, 4], [1, 5], [2, 6], [3, 7],       // verticals
  ];

  const edges = edgeDefs.map(([a, b]) => {
    const dx = c[b][0] - c[a][0];
    const dy = c[b][1] - c[a][1];
    const dz = c[b][2] - c[a][2];
    const len = Math.hypot(dx, dy, dz);
    const dir = direction(dx / len, dy / len, dz / len);
    const org = point(c[a][0], c[a][1], c[a][2]);
    const vec = emit(`VECTOR('',${dir},${len.toFixed(6)})`);
    const line = emit(`LINE('',${org},${vec})`);
    return emit(`EDGE_CURVE('',${verts[a]},${verts[b]},${line},.T.)`);
  });

  /** A face from 4 corner indices plus its outward normal. */
  const face = (corners, normal) => {
    const oriented = [];
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      const idx = edgeDefs.findIndex(
        ([s, e]) => (s === a && e === b) || (s === b && e === a),
      );
      const forward = edgeDefs[idx][0] === a;
      oriented.push(emit(`ORIENTED_EDGE('',*,*,${edges[idx]},${forward ? '.T.' : '.F.'})`));
    }
    const loop = emit(`EDGE_LOOP('',(${oriented.join(',')}))`);
    const bound = emit(`FACE_OUTER_BOUND('',${loop},.T.)`);

    const origin = point(c[corners[0]][0], c[corners[0]][1], c[corners[0]][2]);
    const nrm = direction(normal[0], normal[1], normal[2]);
    // Reference direction must be perpendicular to the normal.
    const ref = Math.abs(normal[2]) > 0.5
      ? direction(1, 0, 0)
      : direction(0, 0, 1);
    const placement = emit(`AXIS2_PLACEMENT_3D('',${origin},${nrm},${ref})`);
    const plane = emit(`PLANE('',${placement})`);
    return emit(`ADVANCED_FACE('',(${bound}),${plane},.T.)`);
  };

  const faces = [
    face([0, 3, 2, 1], [0, 0, -1]),  // bottom
    face([4, 5, 6, 7], [0, 0, 1]),   // top
    face([0, 1, 5, 4], [0, -1, 0]),  // front
    face([2, 3, 7, 6], [0, 1, 0]),   // back
    face([1, 2, 6, 5], [1, 0, 0]),   // right
    face([3, 0, 4, 7], [-1, 0, 0]),  // left
  ];

  const shell = emit(`CLOSED_SHELL('',(${faces.join(',')}))`);
  return emit(`MANIFOLD_SOLID_BREP('${name}',${shell})`);
}

// ---------------------------------------------------------------- document

const appContext = emit("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
emit(`APPLICATION_PROTOCOL_DEFINITION('international standard','config_control_design',1994,${appContext})`);
const prodContext = emit(`PRODUCT_CONTEXT('',${appContext},'mechanical')`);
const defContext = emit(`PRODUCT_DEFINITION_CONTEXT('part definition',${appContext},'design')`);

const lengthUnit = emit('(LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.))');
const angleUnit = emit('(NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.))');
const solidUnit = emit('(NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT())');
const uncertainty = emit(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${lengthUnit},'distance_accuracy_value','confusion accuracy')`);
const geomContext = emit(
  `(GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty})) ` +
  `GLOBAL_UNIT_ASSIGNED_CONTEXT((${lengthUnit},${angleUnit},${solidUnit})) REPRESENTATION_CONTEXT('Context','3D'))`,
);

function addPart(name, ox, oy, oz, w, h, d) {
  const product = emit(`PRODUCT('${name}','${name}','',(${prodContext}))`);
  const formation = emit(`PRODUCT_DEFINITION_FORMATION_WITH_SPECIFIED_SOURCE('','',${product},.NOT_KNOWN.)`);
  const definition = emit(`PRODUCT_DEFINITION('design','',${formation},${defContext})`);
  const shape = emit(`PRODUCT_DEFINITION_SHAPE('','',${definition})`);

  const solid = makeBox(name, ox, oy, oz, w, h, d);

  const origin = point(0, 0, 0);
  const zAxis = direction(0, 0, 1);
  const xAxis = direction(1, 0, 0);
  const placement = emit(`AXIS2_PLACEMENT_3D('',${origin},${zAxis},${xAxis})`);
  const rep = emit(`ADVANCED_BREP_SHAPE_REPRESENTATION('${name}',(${placement},${solid}),${geomContext})`);
  emit(`SHAPE_DEFINITION_REPRESENTATION(${shape},${rep})`);
}

// Part names come from argv so fixtures with DUPLICATE names (instanced
// parts, like two identical faucet handles) can be generated too.
const names = process.argv.slice(2);
const [nameA, nameB] = names.length === 2 ? names : ['BlockA', 'BlockB'];
addPart(nameA, 0, 0, 0, 50, 40, 30);
addPart(nameB, 80, 0, 0, 20, 20, 20);

const out = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('two separate named boxes'),'2;1');
FILE_NAME('two_boxes.step','2026-01-01T00:00:00',('assembly-studio'),(''),'generator','generator','');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
${lines.join('\n')}
ENDSEC;
END-ISO-10303-21;
`;

process.stdout.write(out);
