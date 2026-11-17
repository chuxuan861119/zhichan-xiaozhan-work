import type { CadScene } from "./cadcraft-client";

export type PreviewMesh = {
  vertices: Float32Array;
  origin: [number, number];
  fallback: CadScene["primitives"];
};

/** Tessellate once. Positions stay in CAD coordinates; the shader applies the
 * camera and pixel-sized stroke on each frame without retessellating paths. */
export function previewMesh(
  primitives: CadScene["primitives"],
  width: (p: CadScene["primitives"][number]) => number,
): PreviewMesh {
  const origin: [number, number] = primitives.find((p) => p.points.length)?.points[0] ?? [0, 0];
  const out: number[] = [];
  const fallback: CadScene["primitives"] = [];
  for (const p of primitives) {
    if (p.kind === "mask") continue;
    if (p.kind === "triangles") {
      for (const [x, y] of p.points.slice(0, Math.floor(p.points.length / 3) * 3))
        out.push(x - origin[0], y - origin[1], 0, 0, 0, 0, 0, 1);
      continue;
    }
    const points = p.points.filter(
      (q, i, all) => !i || q[0] !== all[i - 1]?.[0] || q[1] !== all[i - 1]?.[1],
    );
    if (points.length < 2) continue;
    const normals: [number, number][] = [];
    const distances = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!,
        b = points[i]!;
      const dx = b[0] - a[0],
        dy = b[1] - a[1],
        length = Math.hypot(dx, dy);
      normals.push([-dy / length, dx / length]);
      distances.push(distances[i - 1]! + length);
    }
    const closed = points[0]![0] === points.at(-1)![0] && points[0]![1] === points.at(-1)![1];
    let joins: [number, number][];
    try {
      joins = points.map((_, i): [number, number] => {
        const a = normals[i - 1] ?? (closed ? normals.at(-1)! : normals[0]!);
        const b = normals[i] ?? (closed ? normals[0]! : normals.at(-1)!);
        const dot = 1 + a[0] * b[0] + a[1] * b[1];
        if (dot < 1e-8) return b;
        const result: [number, number] = [(a[0] + b[0]) / dot, (a[1] + b[1]) / dot];
        // Use SVG for geometry exceeding its default miter limit rather than
        // change a sharp corner's shape in the accelerated preview.
        if (Math.hypot(...result) > 4) throw new Error("Preview requires SVG bevel joins");
        return result;
      });
    } catch {
      fallback.push(p);
      continue;
    }
    for (let i = 1; i < points.length; i++) {
      for (const [j, side] of [
        [i - 1, -1],
        [i - 1, 1],
        [i, -1],
        [i, -1],
        [i - 1, 1],
        [i, 1],
      ]) {
        const q = points[j!]!,
          n = joins[j!]!;
        out.push(
          q[0] - origin[0],
          q[1] - origin[1],
          n[0],
          n[1],
          distances[j!]!,
          side!,
          width(p),
          0,
        );
      }
    }
  }
  return { vertices: new Float32Array(out), origin, fallback };
}

const vertex = `
attribute vec2 point;
attribute vec2 normal;
attribute vec4 detail;
uniform mat3 camera;
uniform vec2 viewport;
uniform float ratio;
varying float edge;
varying float halfWidth;
varying float along;
varying float filled;
void main() {
  vec2 p = (camera * vec3(point, 1.0)).xy;
  float scale = length(camera[0].xy);
  halfWidth = detail.z * ratio * 0.5;
  vec2 n = (camera * vec3(normal, 0.0)).xy / scale;
  p += n * detail.y * (halfWidth + 0.5);
  edge = detail.y * (halfWidth + 0.5);
  along = detail.x * scale;
  filled = detail.w;
  gl_Position = vec4(p.x / viewport.x * 2.0 - 1.0, 1.0 - p.y / viewport.y * 2.0, 0.0, 1.0);
}`;
const fragment = `
precision highp float;
uniform float ratio;
varying float edge;
varying float halfWidth;
varying float along;
varying float filled;
void main() {
  float alpha;
  if (filled > 0.5) alpha = 0.18;
  else {
    float phase = mod(along, 8.0 * ratio);
    if (phase > 5.0 * ratio) discard;
    alpha = 1.0 - smoothstep(halfWidth - 0.5, halfWidth + 0.5, abs(edge));
  }
  gl_FragColor = vec4(vec3(0.0, 113.0/255.0, 227.0/255.0) * alpha, alpha);
}`;

export function createPreviewGpu(canvas: HTMLCanvasElement, mesh: PreviewMesh) {
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: true,
    depth: false,
    stencil: false,
  });
  if (!gl) throw new Error("WebGL unavailable");
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null,
    buffer: WebGLBuffer | null = null;
  const dispose = () => {
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    for (const s of shaders) gl.deleteShader(s);
  };
  try {
    for (const [type, source] of [
      [gl.VERTEX_SHADER, vertex],
      [gl.FRAGMENT_SHADER, fragment],
    ] as const) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("Shader unavailable");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("Preview shader compilation failed");
    }
    program = gl.createProgram();
    if (!program) throw new Error("Program unavailable");
    for (const shader of shaders) gl.attachShader(program, shader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error("Preview program linking failed");
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL useProgram binds a shader; it is not a React hook.
    gl.useProgram(program);
    buffer = gl.createBuffer();
    if (!buffer) throw new Error("Buffer unavailable");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.STATIC_DRAW);
    for (const [name, size, offset] of [
      ["point", 2, 0],
      ["normal", 2, 8],
      ["detail", 4, 16],
    ] as const) {
      const index = gl.getAttribLocation(program, name);
      gl.enableVertexAttribArray(index);
      gl.vertexAttribPointer(index, size, gl.FLOAT, false, 32, offset);
    }
    const camera = gl.getUniformLocation(program, "camera"),
      viewport = gl.getUniformLocation(program, "viewport"),
      ratio = gl.getUniformLocation(program, "ratio");
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    return {
      draw(matrix: DOMMatrix, width: number, height: number, dpr: number) {
        if (gl.isContextLost()) return false;
        const w = Math.max(1, Math.round(width * dpr)),
          h = Math.max(1, Math.round(height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        const [x, y] = mesh.origin;
        gl.viewport(0, 0, w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.uniformMatrix3fv(camera, false, [
          matrix.a * dpr,
          matrix.b * dpr,
          0,
          matrix.c * dpr,
          matrix.d * dpr,
          0,
          (matrix.e + matrix.a * x + matrix.c * y) * dpr,
          (matrix.f + matrix.b * x + matrix.d * y) * dpr,
          1,
        ]);
        gl.uniform2f(viewport, w, h);
        gl.uniform1f(ratio, dpr);
        gl.drawArrays(gl.TRIANGLES, 0, mesh.vertices.length / 8);
        return gl.getError() === gl.NO_ERROR;
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
