import { z } from "zod/v4";
import { AppError } from "../errors.js";

export async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) {
      break;
    }
    const chunk = z.instanceof(Uint8Array).parse(item.value);
    if (bytes + chunk.byteLength > maximumBytes) {
      await reader.cancel();
      throw new AppError("response_too_large", "HTTP response exceeded its byte limit");
    }
    chunks.push(chunk);
    bytes += chunk.byteLength;
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}
