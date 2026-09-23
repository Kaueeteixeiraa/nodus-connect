import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import nodusLogo from "./assets/nodus-logo.png?inline";

function faceTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 704;
  const context = canvas.getContext("2d")!;
  const glow = context.createRadialGradient(256, 350, 15, 256, 350, 340);
  glow.addColorStop(0, "#102a58");
  glow.addColorStop(0.55, "#07152d");
  glow.addColorStop(1, "#030915");
  context.fillStyle = glow;
  context.fillRect(0, 0, 512, 704);
  context.strokeStyle = "rgba(64,155,255,.14)";
  context.lineWidth = 2;
  for (let x = -450; x < 950; x += 72) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x + 500, 704);
    context.stroke();
  }
  context.textAlign = "center";
  context.fillStyle = "#b3dfff";
  context.font = "600 23px Segoe UI";
  context.fillText("N O D U S", 256, 90);
  context.fillStyle = "#a7c8e8";
  context.font = "600 18px Segoe UI";
  context.fillText("C O N N E C T", 256, 625);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const logo = new Image();
  logo.onload = () => {
    context.drawImage(logo, 88, 184, 336, 336);
    texture.needsUpdate = true;
  };
  logo.src = nodusLogo;
  return texture;
}

function glowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 256;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
  gradient.addColorStop(0, "rgba(255,255,255,.8)");
  gradient.addColorStop(0.18, "rgba(125,200,255,.36)");
  gradient.addColorStop(1, "rgba(0,70,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(canvas);
}

function createToken(texture: THREE.Texture, opacity: number): THREE.Group {
  const group = new THREE.Group();
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(2.94, 4.08, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x071326, metalness: 0.65, roughness: 0.24, emissive: 0x092751, emissiveIntensity: 0.55, transparent: opacity < 1, opacity }),
  );
  const border = new THREE.LineSegments(
    new THREE.EdgesGeometry(shell.geometry),
    new THREE.LineBasicMaterial({ color: 0x59b9ff, transparent: true, opacity: opacity * 0.84 }),
  );
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(2.78, 3.92),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity, depthWrite: false }),
  );
  face.position.z = 0.106;
  group.add(shell, border, face);
  const edgeMaterial = new THREE.MeshBasicMaterial({ color: 0x48b6ff, transparent: true, opacity: opacity * 0.85 });
  for (const x of [-1.46, 1.46]) {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(0.018, 4.05, 0.03), edgeMaterial);
    edge.position.set(x, 0, 0.13);
    group.add(edge);
  }
  for (const y of [-2.03, 2.03]) {
    const edge = new THREE.Mesh(new THREE.BoxGeometry(2.94, 0.018, 0.03), edgeMaterial);
    edge.position.set(0, y, 0.13);
    group.add(edge);
  }
  return group;
}

export default function Standby3D() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [available, setAvailable] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    } catch {
      setAvailable(false);
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
    camera.position.z = 11;
    scene.add(new THREE.AmbientLight(0x7eaaff, 1.3));
    const light = new THREE.PointLight(0x218eff, 90, 18);
    light.position.set(2, 2, 5);
    scene.add(light);

    const texture = faceTexture();
    const glow = glowTexture();
    const aura = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0x167bff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.48 }));
    aura.scale.set(5.5, 6.5, 1);
    aura.position.set(0, 1.05, -1.2);
    scene.add(aura);
    const horizon = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow, color: 0x40aaff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.55 }));
    horizon.scale.set(7, 0.8, 1);
    horizon.position.set(0, -1.62, -0.5);
    scene.add(horizon);
    const token = createToken(texture, 1);
    token.position.y = 1.15;
    token.rotation.set(0.08, -0.28, 0.14);
    scene.add(token);

    const satellites = [-1, 1].map((side) => {
      const satellite = createToken(texture, 0.35);
      satellite.scale.setScalar(0.48);
      satellite.position.set(side * 4.45, 1.05, -2.4);
      satellite.rotation.set(0.04, side * -0.34, side * 0.18);
      scene.add(satellite);
      return satellite;
    });

    const orbitMaterial = new THREE.LineBasicMaterial({ color: 0x3199ff, transparent: true, opacity: 0.66 });
    const orbits = [0, 1].map((index) => {
      const curve = new THREE.EllipseCurve(0, 0, 4.4 + index * 0.25, 0.72 + index * 0.16);
      const points = curve.getPoints(160).map((point) => new THREE.Vector3(point.x, point.y, 0));
      const orbit = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), orbitMaterial);
      orbit.position.y = 1;
      orbit.position.z = -0.6 - index * 0.2;
      orbit.rotation.set(0.23 + index * 0.17, 0.06, index ? -0.1 : 0.15);
      scene.add(orbit);
      return orbit;
    });
    const nodes = Array.from({ length: 9 }, (_, index) => {
      const node = new THREE.Mesh(
        new THREE.SphereGeometry(index % 3 ? 0.025 : 0.045, 8, 8),
        new THREE.MeshBasicMaterial({ color: index % 3 ? 0x5cbfff : 0xc7eaff }),
      );
      scene.add(node);
      return node;
    });

    const starPositions = new Float32Array(210 * 3);
    for (let index = 0; index < 210; index++) {
      starPositions[index * 3] = Math.sin(index * 127.1) * 12;
      starPositions[index * 3 + 1] = Math.cos(index * 91.7) * 6;
      starPositions[index * 3 + 2] = -3 - (index % 5);
    }
    const starGeometry = new THREE.BufferGeometry();
    starGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    scene.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0x4c9aff, size: 0.028, transparent: true, opacity: 0.65 })));

    const resize = () => {
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (!width || !height) return;
      camera.aspect = width / height;
      camera.position.z = camera.aspect < 0.7 ? 13 : 11;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
      renderer.render(scene, camera);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let lastFrame = 0;
    const animate = (time: number) => {
      if (time - lastFrame < 33) return;
      lastFrame = time;
      const seconds = time * 0.001;
      token.position.y = 1.15 + Math.sin(seconds * 1.1) * 0.13;
      token.rotation.y = -0.28 + Math.sin(seconds * 0.43) * 0.17;
      token.rotation.z = 0.14 + Math.sin(seconds * 0.34) * 0.045;
      satellites.forEach((satellite, index) => { satellite.position.y = 1.05 + Math.sin(seconds * 0.75 + index * 2) * 0.2; });
      orbits.forEach((orbit, index) => { orbit.rotation.z = (index ? -0.1 : 0.15) + Math.sin(seconds * 0.22 + index) * 0.11; });
      nodes.forEach((node, index) => {
        const angle = seconds * (index % 2 ? -0.26 : 0.3) + index * 0.7;
        node.position.set(Math.cos(angle) * 4.45, 1 + Math.sin(angle) * 0.75, -0.35 + Math.sin(angle * 2) * 0.4);
      });
      renderer.render(scene, camera);
    };
    const syncMotion = () => {
      renderer.setAnimationLoop(!document.hidden && !reducedMotion.matches ? animate : null);
      if (reducedMotion.matches) renderer.render(scene, camera);
    };
    document.addEventListener("visibilitychange", syncMotion);
    reducedMotion.addEventListener("change", syncMotion);
    syncMotion();

    return () => {
      renderer.setAnimationLoop(null);
      document.removeEventListener("visibilitychange", syncMotion);
      reducedMotion.removeEventListener("change", syncMotion);
      observer.disconnect();
      const geometries = new Set<THREE.BufferGeometry>();
      const materials = new Set<THREE.Material>();
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points || object instanceof THREE.Sprite) {
          if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) geometries.add(object.geometry);
          const entries = Array.isArray(object.material) ? object.material : [object.material];
          entries.forEach((material) => materials.add(material));
        }
      });
      geometries.forEach((geometry) => geometry.dispose());
      materials.forEach((material) => material.dispose());
      texture.dispose();
      glow.dispose();
      renderer.dispose();
    };
  }, []);

  return (
    <div className="standby-screen standby-screen-3d" role="status" aria-label="Aguardando conexão">
      <canvas ref={canvasRef} aria-hidden="true" />
      <div className="standby-3d-brand" translate="no"><i /> <span><b>N O D U S</b><small>C O N N E C T</small></span></div>
      <div className="standby-3d-motto">CONECTANDO<br />PESSOAS<br />A NOVOS<br />HORIZONTES</div>
      <div className="standby-3d-copy">
        <small>CANAL NODUS PRONTO</small>
        <strong>Aguardando conexão</strong>
        <span>Pronto para receber acesso seguro.</span>
        <div className="standby-3d-dots" aria-hidden="true"><i /><i /><i /><i /><i /></div>
        <div className="standby-3d-status"><i /> Conexão segura disponível</div>
      </div>
      <div className="standby-3d-corner">RÁPIDO<br />SEGURO<br />ESTÁVEL</div>
      {!available && <img className="standby-3d-fallback" src={nodusLogo} alt="" />}
    </div>
  );
}
