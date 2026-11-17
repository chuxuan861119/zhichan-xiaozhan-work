import katex from "katex";
import "katex/contrib/mhchem";

const textEncoder = new TextEncoder();

export const MAX_CHEMICAL_EQUATION_BYTES = 64 * 1024;

export type ChemicalEquationErrorCode =
  | "CHEMICAL_EQUATION_EMPTY"
  | "CHEMICAL_EQUATION_TOO_LARGE"
  | "CHEMICAL_EQUATION_NESTED_CE"
  | "CHEMICAL_EQUATION_INVALID_SYNTAX";

export type ChemicalEquationNormalization =
  | { ok: true; value: string }
  | { ok: false; error: { code: ChemicalEquationErrorCode } };

const CE_COMMAND = /\\ce\s*\{/u;

function outerCeBody(source: string): string | null | undefined {
  const command = CE_COMMAND.exec(source);
  if (command?.index !== 0) return null;
  const openingBraceIndex = command[0].length - 1;

  let depth = 0;
  for (let index = openingBraceIndex; index < source.length; index += 1) {
    const character = source[index];
    // Escaped braces are literal symbols, not delimiters of the outer ce body.
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        if (source.slice(index + 1).trim().length > 0) return null;
        return source.slice(openingBraceIndex + 1, index);
      }
    }
  }
  return undefined;
}

function invalidSyntax(): ChemicalEquationNormalization {
  return { ok: false, error: { code: "CHEMICAL_EQUATION_INVALID_SYNTAX" } };
}

export function normalizeChemicalEquation(input: string): ChemicalEquationNormalization {
  const source = input.trim();
  if (!source) return { ok: false, error: { code: "CHEMICAL_EQUATION_EMPTY" } };

  const body = outerCeBody(source);
  if (body === undefined) return invalidSyntax();
  if (body !== null && !body.trim()) {
    return { ok: false, error: { code: "CHEMICAL_EQUATION_EMPTY" } };
  }
  if (body !== null && CE_COMMAND.test(body)) {
    return { ok: false, error: { code: "CHEMICAL_EQUATION_NESTED_CE" } };
  }
  if (body === null && CE_COMMAND.test(source)) {
    return { ok: false, error: { code: "CHEMICAL_EQUATION_NESTED_CE" } };
  }

  const normalized = body === null ? String.raw`\ce{${source}}` : String.raw`\ce{${body}}`;
  if (textEncoder.encode(normalized).byteLength > MAX_CHEMICAL_EQUATION_BYTES) {
    return { ok: false, error: { code: "CHEMICAL_EQUATION_TOO_LARGE" } };
  }

  try {
    katex.renderToString(normalized, {
      throwOnError: true,
      // 中文反应条件（如“浓 H_{2}SO_{4}”“加热”）在数学模式下会触发
      // unicodeTextInMathMode 警告。仅忽略这一展示兼容警告，保持用户和
      // MathLive 的原始 LaTeX 不被二次改写；其他严格校验错误仍会阻止插入。
      strict: (errorCode) => (errorCode === "unicodeTextInMathMode" ? "ignore" : "error"),
      trust: false,
      maxSize: 20,
      maxExpand: 1_000,
    });
    return { ok: true, value: normalized };
  } catch {
    return invalidSyntax();
  }
}

/**
 * 从已保存的方程式中提取用户可见的 mhchem 内容体。
 * 如果 source 被 `\ce{...}` 包裹，返回内部内容；否则原样返回。
 * 仅用于编辑时的显示解包装，不参与验证。
 */
export function unwrapChemicalEquation(source: string): string {
  const body = outerCeBody(source);
  if (body) return body;
  return source;
}
