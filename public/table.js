import * as THREE from '/vendor/three.module.js';

export function createTable(canvas, { reducedMotion = false, lowPower = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setClearColor(0xceddcb, 1);
  renderer.shadowMap.enabled = !lowPower;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xceddcb, 18, 40);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 70);
  const target = new THREE.Vector3();
  const materials = {};
  const mat = (color) => materials[color] ??= new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0 });
  const mesh = (geometry, color, position, parent = scene) => {
    const object = new THREE.Mesh(geometry, mat(color));
    object.position.set(...position);
    object.castShadow = true;
    object.receiveShadow = true;
    parent.add(object);
    return object;
  };
  const sphere = (r, color, pos, parent) => mesh(new THREE.SphereGeometry(r, 20, 14), color, pos, parent);
  const cylinder = (top, bottom, height, color, pos, parent) => mesh(new THREE.CylinderGeometry(top, bottom, height, 48), color, pos, parent);
  const box = (size, color, pos, parent) => mesh(new THREE.BoxGeometry(...size), color, pos, parent);
  scene.add(new THREE.HemisphereLight(0xfff8df, 0x7d9e8e, 2.8));
  const sun = new THREE.DirectionalLight(0xffeed3, 3.2);
  sun.position.set(-6, 12, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12 });
  sun.shadow.normalBias = 0.04;
  scene.add(sun);
  const ground = cylinder(24, 24, 0.2, 0xc4d5ba, [0, -0.5, 0]);
  ground.castShadow = false;
  cylinder(6.6, 6.7, 0.14, 0xe7d9bd, [0, -0.3, 0]);
  cylinder(5.8, 5.9, 0.05, 0xf0e3c9, [0, -0.21, 0]);

  const table = new THREE.Group();
  scene.add(table);
  const rim = cylinder(3.1, 3.03, 0.35, 0x9b6244, [0, 1.4, 0], table);
  rim.scale.z = 0.8;
  const trim = cylinder(3.04, 3.04, 0.06, 0xe2b878, [0, 1.6, 0], table);
  trim.scale.z = 0.8;
  const felt = cylinder(2.9, 2.9, 0.07, 0x386f5b, [0, 1.65, 0], table);
  felt.scale.z = 0.79;
  const inner = new THREE.Mesh(new THREE.TorusGeometry(2.65, 0.012, 8, 96), mat(0xa6b68a));
  inner.rotation.x = Math.PI / 2;
  inner.scale.y = 0.79;
  inner.position.y = 1.695;
  table.add(inner);
  for (const x of [-1.8, 1.8]) for (const z of [-1.25, 1.25]) cylinder(0.13, 0.22, 1.7, 0x825239, [x, 0.52, z], table);

  // Tiny physical props keep the scene readable without downloaded art assets.
  const cardGroup = new THREE.Group();
  table.add(cardGroup);
  for (let i = 0; i < 5; i++) {
    const card = box([0.49, 0.025, 0.73], i === 4 ? 0xf9eed7 : 0xe7ddc6, [(i - 2) * 0.2, 1.72 + i * 0.015, 0.3], cardGroup);
    card.rotation.y = (i - 2) * 0.15;
    const pip = sphere(0.065, i % 2 ? 0xc96952 : 0x244e43, [card.position.x, card.position.y + 0.02, card.position.z], cardGroup);
    pip.scale.y = 0.2;
  }
  for (const [x, z] of [[-1.6, -0.5], [1.65, -0.4]]) {
    cylinder(0.19, 0.15, 0.25, 0xf4e8d1, [x, 1.83, z], table);
    cylinder(0.145, 0.145, 0.015, 0x7c5035, [x, 1.965, z], table);
    const handle = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.035, 8, 16), mat(0xf4e8d1));
    handle.position.set(x + 0.2, 1.84, z);
    table.add(handle);
  }
  const characters = [];
  function character(x, z, shirt, hair, skin, rotation) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rotation;
    scene.add(group);
    cylinder(0.68, 0.8, 0.18, 0x9b6244, [0, 0.45, 0], group);
    box([1.2, 1.2, 0.16], 0xb47c50, [0, 0.9, -0.4], group);
    cylinder(0.42, 0.6, 1, shirt, [0, 1.05, 0], group);
    sphere(0.52, skin, [0, 1.95, 0], group);
    const cap = sphere(0.535, hair, [0, 2.13, -0.05], group);
    cap.scale.y = 0.68;
    for (const ex of [-0.17, 0.17]) {
      sphere(0.048, 0x263e34, [ex, 1.99, 0.473], group);
      const cheek = sphere(0.09, 0xe8a18a, [ex * 1.65, 1.85, 0.42], group);
      cheek.scale.z = 0.2;
    }
    sphere(0.09, skin, [0, 1.87, 0.51], group);
    for (const side of [-1, 1]) {
      const arm = sphere(0.19, shirt, [side * 0.55, 1.25, 0.3], group);
      arm.scale.y = 1.8;
      sphere(0.16, skin, [side * 0.53, 1.4, 0.58], group);
    }
    characters.push(group);
  }
  character(-2.6, -2.05, 0xe7a354, 0x4c3b32, 0xf5cba2, 0.65);
  character(2.65, -2.05, 0x7a9d92, 0xeee0bf, 0xe8b48c, -0.65);
  character(0, 3.2, 0xc66e55, 0x343f35, 0xf1c6a0, Math.PI);

  function plant(x, z, scale = 1) {
    const plantGroup = new THREE.Group();
    plantGroup.position.set(x, -0.15, z);
    plantGroup.scale.setScalar(scale);
    scene.add(plantGroup);
    cylinder(0.46, 0.31, 0.65, 0xc48665, [0, 0.3, 0], plantGroup);
    cylinder(0.49, 0.49, 0.1, 0xdda17b, [0, 0.65, 0], plantGroup);
    for (let i = 0; i < 7; i++) {
      const angle = i * 2.4;
      const leaf = sphere(0.3, i % 2 ? 0x648f65 : 0x83a36b, [Math.cos(angle) * 0.3, 0.85 + (i % 3) * 0.17, Math.sin(angle) * 0.3], plantGroup);
      leaf.scale.set(0.7, 1.7, 0.65);
      leaf.rotation.z = Math.cos(angle) * 0.6;
    }
  }
  plant(-4.6, 1.4, 1.4);
  plant(4.2, 1.8, 1.1);
  plant(-4, -4, 1.6);
  plant(4.9, -3.1, 1.4);
  for (let i = -5; i <= 5; i++) {
    const post = box([0.18, 1.6, 0.18], 0xeee2c9, [i * 1.0, 0.5, -5.3]);
    post.rotation.y = 0.05;
  }
  box([10.4, 0.12, 0.14], 0xd5c8ae, [0, 0.7, -5.3]);
  box([10.4, 0.12, 0.14], 0xd5c8ae, [0, 0.1, -5.3]);
  for (const x of [-6.5, 6.5]) {
    cylinder(0.16, 0.24, 3.4, 0x9e8060, [x, 1.1, -5.3]);
    for (const [dx, dy] of [[0, 0], [-0.6, -0.3], [0.6, -0.2]]) sphere(1.2, dx ? 0xa2ba80 : 0x8caa75, [x + dx, 3.3 + dy, -5.3]);
  }
  const stringPoints = Array.from({ length: 33 }, (_, i) => new THREE.Vector3(-7 + i * 14 / 32, 4.7 - 0.8 * Math.sin(i / 32 * Math.PI), -4.7));
  const string = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(stringPoints), 32, 0.018, 5, false), mat(0x77836a));
  scene.add(string);
  for (let i = 1; i < 10; i++) sphere(0.11, 0xffe6a3, [-7 + i * 1.4, 4.7 - 0.8 * Math.sin(i / 10 * Math.PI) - 0.12, -4.7]);

  let inGame = false;
  let effect = 0;
  let options = { reducedMotion, lowPower };
  let dirty = true;
  let lastFrame = 0;
  let raf;
  const resize = () => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, options.lowPower ? 1 : 1.75));
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.shadowMap.needsUpdate = true;
    dirty = true;
  };
  const burst = new THREE.Group();
  scene.add(burst);
  for (let i = 0; i < 30; i++) {
    const piece = box([0.08, 0.14, 0.025], [0xe8af57, 0xf2d899, 0xd17c60][i % 3], [0, 0, 0], burst);
    piece.castShadow = false;
  }
  burst.visible = false;
  function animate(time) {
    raf = requestAnimationFrame(animate);
    if (document.hidden || time - lastFrame < (options.lowPower ? 50 : 33)) return;
    if (options.reducedMotion && !dirty && effect === 0) return;
    lastFrame = time;
    const portrait = innerWidth < 700;
    const desired = inGame
      ? new THREE.Vector3(portrait ? 0 : 0.5, portrait ? 12.5 : 10.5, portrait ? 14 : 11)
      : new THREE.Vector3(portrait ? 8 : 9, portrait ? 11 : 9, portrait ? 16 : 12);
    camera.position.lerp(desired, options.reducedMotion ? 1 : 0.065);
    target.lerp(new THREE.Vector3(inGame ? 0 : -1.6, inGame ? 0.4 : 0, 0), options.reducedMotion ? 1 : 0.08);
    camera.lookAt(target);
    characters.forEach((character, i) => { character.position.y = options.reducedMotion ? 0 : Math.sin(time / 1800 + i * 2) * 0.035; });
    if (effect > 0) {
      effect = Math.max(0, effect - 0.02);
      burst.children.forEach((piece, i) => {
        const angle = i * 2.4;
        const t = 1 - effect;
        piece.position.set(Math.cos(angle) * t * 5, 2 + t * 4 - t * t * 5, Math.sin(angle) * t * 3);
        piece.rotation.set(t * i, t * 3, angle);
      });
      burst.visible = effect > 0;
    }
    renderer.render(scene, camera);
    dirty = false;
  }
  resize();
  camera.position.set(9, 9, 12);
  window.addEventListener('resize', resize);
  raf = requestAnimationFrame(animate);
  return {
    setGame(value) { inGame = value; dirty = true; },
    celebrate() { if (!options.reducedMotion) effect = 1; },
    configure(value) { options = { ...options, ...value }; renderer.shadowMap.enabled = !options.lowPower; resize(); },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      scene.traverse((object) => { if (object.isMesh) object.geometry.dispose(); });
      Object.values(materials).forEach((material) => material.dispose());
      renderer.dispose();
    },
  };
}
