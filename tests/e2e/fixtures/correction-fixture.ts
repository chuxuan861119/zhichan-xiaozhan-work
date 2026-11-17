import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

// Consent belongs only to the disposable fixture profile; never touch the user's receipts.
export async function prepareCorrectionFixtureConsent(userData: string) {
  await writeFile(
    join(userData, "ai-upload-consent.json"),
    JSON.stringify({
      version: 1,
      origins: [createHash("sha256").update("https://api.deepseek.com").digest("hex")],
    }),
  );
}

// Only the disposable hidden test build redirects transport. Production model validation,
// credentials, IPC, SSE parsing, anchoring and editor transactions remain unchanged.
export async function prepareCorrectionFixtureMain(port: number, sourceEntry?: string) {
  const entry = await createRequire(import.meta.url)("./background-electron.cjs")(sourceEntry);
  const source = await readFile(entry, "utf8");
  const original = "const postSse = createHttpsSseClient();";
  if (source.split(original).length !== 2)
    throw new Error("Cannot locate the SSE transport boundary in the test build.");
  await writeFile(
    entry,
    source.replace(
      original,
      `const postSse = createHttpsSseClient({endpointOverride:new URL("http://127.0.0.1:${port}/v1/chat/completions"),resolveEndpoint:async()=>({hostname:"127.0.0.1",addresses:["127.0.0.1"]})});`,
    ),
  );
  return entry;
}
