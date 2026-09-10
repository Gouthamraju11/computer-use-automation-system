import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { StructuredLogEvent } from "./types.js";
import { Redactor } from "./redaction.js";

export class RunLogger {
  constructor(
    readonly runId: string,
    readonly path: string,
    private readonly redactor: Redactor
  ) {}

  redact<T>(value: T): T {
    const portable = JSON.stringify(value).split(process.cwd()).join(".");
    return JSON.parse(this.redactor.text(portable)) as T;
  }

  async log(
    phase: StructuredLogEvent["phase"],
    event: string,
    data: Record<string, unknown>,
    stepId?: string
  ): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const record: StructuredLogEvent = {
      timestamp: new Date().toISOString(),
      runId: this.runId,
      phase,
      event,
      ...(stepId === undefined ? {} : { stepId }),
      data: this.redact(data)
    };
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }
}
