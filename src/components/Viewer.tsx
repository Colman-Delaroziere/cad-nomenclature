import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Canvas,
  useFrame,
  useThree,
  type ThreeEvent,
} from "@react-three/fiber";
import {
  Environment,
  Lightformer,
  OrbitControls,
  useGLTF,
} from "@react-three/drei";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutlinePass } from "three/examples/jsm/postprocessing/OutlinePass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import astonMartinUrl from "../assets/2020-aston-martin-dbs-gt-zagato-wwwvecarzcom/source/Aston Martin GT Zagato.glb?url";

type PartIdentification = {
  identifiedPart: string;
  confidence: number;
  userDescription?: string;
  [key: string]: unknown;
};

const partNameCache = new Map<string, PartIdentification>();
const CAR_PAINT_COLOR = "#650b18";

type PartMenu = {
  part: THREE.Object3D;
  x: number;
  y: number;
};

type CarModelProps = {
  onHover: (part: THREE.Object3D | null) => void;
  onSelect: (part: THREE.Object3D, event: MouseEvent) => void;
};

function formatVector(vector: THREE.Vector3) {
  return {
    x: Number(vector.x.toFixed(4)),
    y: Number(vector.y.toFixed(4)),
    z: Number(vector.z.toFixed(4)),
  };
}

function extractMaterial(material: THREE.Material) {
  const data: Record<string, string | number | boolean> = {
    name: material.name || "unnamed",
    type: material.type,
    opacity: material.opacity,
    transparent: material.transparent,
  };

  if (material instanceof THREE.MeshStandardMaterial) {
    data.color = `#${material.color.getHexString()}`;
    data.emissive = `#${material.emissive.getHexString()}`;
    data.metalness = material.metalness;
    data.roughness = material.roughness;
    data.hasColorTexture = Boolean(material.map);
    data.hasNormalTexture = Boolean(material.normalMap);
    data.hasMetalnessTexture = Boolean(material.metalnessMap);
    data.hasRoughnessTexture = Boolean(material.roughnessMap);
  }

  return data;
}

function extractPartData(part: THREE.Object3D) {
  const partBox = new THREE.Box3().setFromObject(part);
  const meshes: Array<Record<string, unknown>> = [];
  const nodeNames: string[] = [];
  const colors = new Set<string>();

  part.traverse((child) => {
    if (child.name) nodeNames.push(child.name);
    if (!(child instanceof THREE.Mesh)) return;

    const position = child.geometry.getAttribute("position");
    const materials = (
      Array.isArray(child.material) ? child.material : [child.material]
    ).map(extractMaterial);

    materials.forEach((material) => {
      if (typeof material.color === "string") colors.add(material.color);
    });

    const meshBox = new THREE.Box3().setFromObject(child);
    meshes.push({
      name: child.name || "unnamed",
      geometryType: child.geometry.type,
      vertexCount: position?.count ?? 0,
      triangleCount: Math.floor(
        (child.geometry.index?.count ?? position?.count ?? 0) / 3,
      ),
      dimensions: formatVector(meshBox.getSize(new THREE.Vector3())),
      centerPosition: formatVector(meshBox.getCenter(new THREE.Vector3())),
      materials,
    });
  });

  return {
    vehicle: "2020 Aston Martin DBS GT Zagato",
    coordinateSpace: "Viewer world space; vehicle normalized to 3.8 units",
    part: {
      name: part.name || "unnamed",
      parentAssembly: part.parent?.name || "unknown",
      nodeNames: [...new Set(nodeNames)],
      dimensions: formatVector(partBox.getSize(new THREE.Vector3())),
      centerPosition: formatVector(partBox.getCenter(new THREE.Vector3())),
      colors: [...colors],
      meshes,
    },
  };
}

function parseIdentification(text: string): PartIdentification {
  const json = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const result = JSON.parse(json) as PartIdentification;

  if (!result.identifiedPart || typeof result.confidence !== "number") {
    throw new Error("Part agent returned invalid JSON");
  }

  return result;
}

async function identifyPart(part: THREE.Object3D) {
  const partData = extractPartData(part);

  const response = await fetch("/api/agents/partAgent/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: `Analyze this extracted CAD part data:\n${JSON.stringify(partData, null, 2)}`,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Part agent failed (${response.status}): ${error}`);
  }

  const result = (await response.json()) as { text?: string };
  if (!result.text) throw new Error("Part agent returned no response");

  return parseIdentification(result.text);
}

function CarModel({ onHover, onSelect }: CarModelProps) {
  const gltf = useGLTF(astonMartinUrl, `${import.meta.env.BASE_URL}draco/`);
  const { model, meshParts } = useMemo(() => {
    const model = gltf.scene.clone(true);
    const box = new THREE.Box3().setFromObject(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const scale = 3.8 / Math.max(size.x, size.y, size.z);
    const meshParts = new Map<THREE.Mesh, THREE.Object3D>();

    model.position.sub(center);
    model.scale.setScalar(scale);
    model.rotation.y = -Math.PI / 7;

    const parts = model.getObjectByName("RootNode")?.children ?? [];
    parts.forEach((part) => {
      part.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;

        meshParts.set(child, part);
        child.castShadow = true;
        child.receiveShadow = true;

        const materials = Array.isArray(child.material)
          ? child.material
          : [child.material];
        const tunedMaterials = materials.map((sourceMaterial) => {
          const material = sourceMaterial.clone();
          const name = material.name.toLowerCase();

          if (material instanceof THREE.MeshStandardMaterial) {
            if (name.includes("carpaint")) {
              material.color.set(CAR_PAINT_COLOR);
              material.metalness = 0.82;
              material.roughness = 0.2;
            } else if (name.includes("carbon")) {
              material.color.set("#17191b");
              material.metalness = 0.65;
              material.roughness = 0.28;
            } else if (name.includes("chrome")) {
              material.metalness = 1;
              material.roughness = 0.12;
            } else if (name.includes("gold")) {
              material.color.set("#c89235");
              material.metalness = 0.9;
              material.roughness = 0.22;
            } else if (name.includes("wheel")) {
              material.color.set("#171717");
              material.metalness = 0.05;
              material.roughness = 0.72;
            }

            material.envMapIntensity = name.includes("glass") ? 1.8 : 1.25;
          }

          return material;
        });

        child.material = Array.isArray(child.material)
          ? tunedMaterials
          : tunedMaterials[0];
      });
    });

    return { model, meshParts };
  }, [gltf.scene]);

  const hoverPart = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onHover(meshParts.get(event.object as THREE.Mesh) ?? null);
  };

  const selectPart = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const part = meshParts.get(event.object as THREE.Mesh);
    if (part) {
      onHover(part);
      onSelect(part, event.nativeEvent);
    }
  };

  return (
    <primitive
      object={model}
      onPointerOver={hoverPart}
      onPointerMove={hoverPart}
      onPointerOut={() => onHover(null)}
      onClick={selectPart}
    />
  );
}

function PostProcessing({
  selectedPart,
}: {
  selectedPart: THREE.Object3D | null;
}) {
  const { gl, scene, camera, size } = useThree();
  const { composer, gtaoPass, outlinePass, outputPass } = useMemo(() => {
    const composer = new EffectComposer(gl);
    composer.addPass(new RenderPass(scene, camera));

    const gtaoPass = new GTAOPass(scene, camera, size.width, size.height);
    gtaoPass.blendIntensity = 0.72;
    gtaoPass.updateGtaoMaterial({
      radius: 0.18,
      distanceExponent: 1.5,
      thickness: 1.2,
      distanceFallOff: 1,
      samples: 16,
    });
    composer.addPass(gtaoPass);

    const outlinePass = new OutlinePass(new THREE.Vector2(), scene, camera);
    outlinePass.edgeStrength = 7;
    outlinePass.edgeGlow = 1;
    outlinePass.edgeThickness = 3;
    outlinePass.visibleEdgeColor.set("#ff2020");
    outlinePass.hiddenEdgeColor.set("#ff2020");
    composer.addPass(outlinePass);

    const outputPass = new OutputPass();
    composer.addPass(outputPass);

    return { composer, gtaoPass, outlinePass, outputPass };
  }, [camera, gl, scene, size.height, size.width]);

  useEffect(() => {
    composer.setPixelRatio(gl.getPixelRatio());
    composer.setSize(size.width, size.height);
  }, [composer, gl, size]);

  useEffect(() => {
    outlinePass.selectedObjects = selectedPart ? [selectedPart] : [];
  }, [outlinePass, selectedPart]);

  useEffect(() => {
    return () => {
      outlinePass.dispose();
      gtaoPass.dispose();

      outputPass.dispose();
      composer.dispose();
    };
  }, [composer, gtaoPass, outlinePass, outputPass]);

  useFrame(() => composer.render(), 1);
  return null;
}

export default function Viewer() {
  const host = useRef<HTMLDivElement>(null);
  const [hoveredPart, setHoveredPart] = useState<THREE.Object3D | null>(null);
  const [partMenu, setPartMenu] = useState<PartMenu | null>(null);
  const partMenuRef = useRef(partMenu);
  const [partResult, setPartResult] = useState<PartIdentification | null>(null);
  const [partError, setPartError] = useState("");
  const [isNaming, setIsNaming] = useState(false);
  partMenuRef.current = partMenu;

  const openPartMenu = (part: THREE.Object3D, event: MouseEvent) => {
    const bounds = host.current?.getBoundingClientRect();
    if (!bounds) return;

    const cacheKey = part.name || part.uuid;
    const cachedName = partNameCache.get(cacheKey) ?? null;
    setPartResult(cachedName);
    setPartError("");
    setPartMenu({
      part,
      x: Math.max(
        8,
        Math.min(event.clientX - bounds.left + 12, bounds.width - 220),
      ),
      y: Math.max(
        8,
        Math.min(event.clientY - bounds.top + 12, bounds.height - 96),
      ),
    });
  };

  const nameSelectedPart = async () => {
    const menu = partMenu;
    if (!menu || isNaming) return;

    const cacheKey = menu.part.name || menu.part.uuid;
    const cachedName = partNameCache.get(cacheKey);
    if (cachedName) {
      setPartResult(cachedName);
      setPartError("");
      return;
    }

    setIsNaming(true);
    setPartResult(null);
    setPartError("");

    try {
      const result = await identifyPart(menu.part);
      partNameCache.set(cacheKey, result);
      console.log("Identified part:", result);

      if (partMenuRef.current?.part === menu.part) setPartResult(result);
    } catch (error) {
      console.error(error);
      if (partMenuRef.current?.part === menu.part) {
        setPartError("Could not identify part");
      }
    } finally {
      setIsNaming(false);
    }
  };

  return (
    <div className="viewer-shell" ref={host}>
      <div className="viewer">
        <Canvas
          camera={{ position: [4.5, 2.1, 6], fov: 38, near: 0.1, far: 100 }}
          dpr={[1, 2]}
          gl={{ antialias: true }}
          onCreated={({ gl }) => {
            gl.toneMapping = THREE.ACESFilmicToneMapping;
            gl.toneMappingExposure = 0.88;
          }}
          onPointerMissed={() => setPartMenu(null)}
        >
          <color attach="background" args={["#eef0f2"]} />
          <ambientLight color="#dce5ee" intensity={0.35} />
          <directionalLight
            color="#fff7ed"
            intensity={1.7}
            position={[-4.5, 5.5, 4]}
          />
          <directionalLight
            color="#dceaff"
            intensity={0.85}
            position={[4, 3, 5]}
          />
          <directionalLight
            color="#ffffff"
            intensity={1.1}
            position={[1, 4, -5]}
          />

          <Environment resolution={256}>
            <Lightformer
              intensity={2.8}
              position={[0, 5, -2]}
              rotation-x={Math.PI / 2}
              scale={[7, 3, 1]}
            />
            <Lightformer
              intensity={2}
              position={[-5, 1.5, 0]}
              rotation-y={Math.PI / 2}
              scale={[5, 2, 1]}
            />
            <Lightformer
              intensity={1.5}
              color="#c8dcff"
              position={[5, 2, -1]}
              rotation-y={-Math.PI / 2}
              scale={[4, 2, 1]}
            />
          </Environment>

          <Suspense fallback={null}>
            <CarModel onHover={setHoveredPart} onSelect={openPartMenu} />
          </Suspense>

          <OrbitControls
            makeDefault
            enableDamping
            target={[0, 0.25, 0]}
            maxPolarAngle={Math.PI * 0.48}
            minDistance={3.5}
            maxDistance={9}
          />

          <PostProcessing selectedPart={hoveredPart} />
        </Canvas>
      </div>

      {partMenu && (
        <div
          className="part-menu"
          style={{ left: `${partMenu.x}px`, top: `${partMenu.y}px` }}
        >
          <button
            type="button"
            disabled={isNaming || Boolean(partResult)}
            onClick={() => void nameSelectedPart()}
          >
            {isNaming ? "Naming..." : partResult ? "Named" : "Name part"}
          </button>

          {partResult && (
            <div className="part-result">
              <strong>{partResult.identifiedPart}</strong>
              <span>
                {Math.round(
                  partResult.confidence <= 1
                    ? partResult.confidence * 100
                    : partResult.confidence,
                )}
                % confidence
              </span>
            </div>
          )}

          {partError && <output>{partError}</output>}
        </div>
      )}
    </div>
  );
}
