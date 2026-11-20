import { parentPort, workerData } from "node:worker_threads";
import {
  TemporaryPsdDecodeSchema,
  TemporaryPsdExportSchema,
  TemporaryRasterDecodeSchema,
  TemporaryRasterExportSchema,
} from "../../shared/ipc/temporary-images.js";
import { decodeTemporaryRaster, encodeTemporaryRaster } from "./temporary-image-codec.js";
import { decodeTemporaryPsd, encodeTemporaryPsd } from "./temporary-psd-codec.js";

async function run() {
  if (!parentPort) throw new Error("图片处理必须在后台运行。");
  try {
    if (workerData?.action === "decode") {
      const input = TemporaryRasterDecodeSchema.parse(workerData.input);
      const value = await decodeTemporaryRaster(input.bytes, input.page, input.density);
      parentPort.postMessage({ ok: true, value }, [value.bytes.buffer as ArrayBuffer]);
    } else if (workerData?.action === "encode") {
      const input = TemporaryRasterExportSchema.parse(workerData.input);
      const value = await encodeTemporaryRaster(input.bytes, input.options);
      parentPort.postMessage({ ok: true, value }, [value.buffer as ArrayBuffer]);
    } else if (workerData?.action === "decodePsd") {
      const input = TemporaryPsdDecodeSchema.parse(workerData.input);
      const value = await decodeTemporaryPsd(input.bytes);
      parentPort.postMessage({ ok: true, value }, [
        value.psd.buffer as ArrayBuffer,
        ...value.backings.map((item) => item.bytes.buffer as ArrayBuffer),
        ...(value.composite ? [value.composite.buffer as ArrayBuffer] : []),
      ]);
    } else if (workerData?.action === "encodePsd") {
      const input = TemporaryPsdExportSchema.parse(workerData.input);
      const value = await encodeTemporaryPsd(input);
      parentPort.postMessage({ ok: true, value }, [value.buffer as ArrayBuffer]);
    } else throw new Error("不支持的图片处理操作。");
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      message: error instanceof Error ? error.message : "图片转换失败。",
    });
  } finally {
    parentPort.close();
  }
}
void run();
