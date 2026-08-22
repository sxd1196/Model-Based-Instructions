/**
 * A procedurally-built multi-level demo assembly.
 *
 * Exists so the app is testable with zero external files, and so the
 * "separate named objects" contract has a known-good reference. Roughly
 * mimics a gearbox: housing, cover, shaft, bearings, gears, bolt circle.
 */
import * as THREE from 'three';

const STEEL = () => new THREE.MeshStandardMaterial({ color: 0x9aa4b2, roughness: 0.45, metalness: 0.8 });
const CAST = () => new THREE.MeshStandardMaterial({ color: 0x5f6b7a, roughness: 0.85, metalness: 0.2 });
const BRASS = () => new THREE.MeshStandardMaterial({ color: 0xc4a747, roughness: 0.4, metalness: 0.9 });
const SEAL = () => new THREE.MeshStandardMaterial({ color: 0x2c2c30, roughness: 0.95, metalness: 0 });

export function makeDemoAssembly(): { root: THREE.Group; name: string } {
  const root = new THREE.Group();
  root.name = 'Gearbox_Assembly';

  // ---- Housing sub-assembly
  const housingAsm = new THREE.Group();
  housingAsm.name = 'SUB_Housing';

  const housing = new THREE.Mesh(new THREE.BoxGeometry(180, 120, 100), CAST());
  housing.name = 'Housing_Body';
  housingAsm.add(housing);

  const flange = new THREE.Mesh(new THREE.CylinderGeometry(70, 70, 12, 32), CAST());
  flange.name = 'Housing_Flange';
  flange.rotation.x = Math.PI / 2;
  flange.position.set(0, 0, 56);
  housingAsm.add(flange);

  root.add(housingAsm);

  // ---- Cover sub-assembly
  const coverAsm = new THREE.Group();
  coverAsm.name = 'SUB_Cover';

  const cover = new THREE.Mesh(new THREE.CylinderGeometry(68, 68, 10, 32), CAST());
  cover.name = 'Cover_Plate';
  cover.rotation.x = Math.PI / 2;
  cover.position.set(0, 0, 67);
  coverAsm.add(cover);

  const gasket = new THREE.Mesh(new THREE.TorusGeometry(60, 3, 12, 40), SEAL());
  gasket.name = 'Cover_Gasket';
  gasket.position.set(0, 0, 61);
  coverAsm.add(gasket);

  // Bolt circle — 8 instances, each individually named and movable.
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * Math.PI * 2;
    const bolt = new THREE.Group();
    bolt.name = `Bolt_M8_${String(i + 1).padStart(2, '0')}`;

    const shank = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 26, 12), STEEL());
    shank.name = `Bolt_M8_${String(i + 1).padStart(2, '0')}_Shank`;
    shank.rotation.x = Math.PI / 2;

    const head = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 6, 6), STEEL());
    head.name = `Bolt_M8_${String(i + 1).padStart(2, '0')}_Head`;
    head.rotation.x = Math.PI / 2;
    head.position.z = 15;

    bolt.add(shank, head);
    bolt.position.set(Math.cos(angle) * 58, Math.sin(angle) * 58, 70);
    coverAsm.add(bolt);
  }

  root.add(coverAsm);

  // ---- Rotating group
  const shaftAsm = new THREE.Group();
  shaftAsm.name = 'SUB_ShaftAssembly';

  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(12, 12, 190, 24), STEEL());
  shaft.name = 'Main_Shaft';
  shaft.rotation.x = Math.PI / 2;
  shaftAsm.add(shaft);

  const gearBig = new THREE.Mesh(new THREE.CylinderGeometry(45, 45, 18, 40), BRASS());
  gearBig.name = 'Gear_Driven_48T';
  gearBig.rotation.x = Math.PI / 2;
  gearBig.position.z = 20;
  shaftAsm.add(gearBig);

  const gearSmall = new THREE.Mesh(new THREE.CylinderGeometry(26, 26, 18, 28), BRASS());
  gearSmall.name = 'Gear_Pinion_24T';
  gearSmall.rotation.x = Math.PI / 2;
  gearSmall.position.z = -22;
  shaftAsm.add(gearSmall);

  for (const [i, z] of [-60, 45].entries()) {
    const bearing = new THREE.Mesh(new THREE.TorusGeometry(18, 6, 12, 32), STEEL());
    bearing.name = `Bearing_6203_${i + 1}`;
    bearing.position.z = z;
    shaftAsm.add(bearing);
  }

  const key = new THREE.Mesh(new THREE.BoxGeometry(6, 4, 30), STEEL());
  key.name = 'Key_6x4x30';
  key.position.set(0, 13, 20);
  shaftAsm.add(key);

  root.add(shaftAsm);

  // ---- Input side
  const inputAsm = new THREE.Group();
  inputAsm.name = 'SUB_Input';

  const inputShaft = new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 120, 20), STEEL());
  inputShaft.name = 'Input_Shaft';
  inputShaft.rotation.x = Math.PI / 2;
  inputShaft.position.set(0, 62, -20);
  inputAsm.add(inputShaft);

  const coupler = new THREE.Mesh(new THREE.CylinderGeometry(20, 20, 24, 20), CAST());
  coupler.name = 'Coupler';
  coupler.rotation.x = Math.PI / 2;
  coupler.position.set(0, 62, -75);
  inputAsm.add(coupler);

  root.add(inputAsm);

  return { root, name: 'Gearbox (demo)' };
}
