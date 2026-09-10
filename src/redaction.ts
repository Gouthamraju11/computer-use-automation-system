const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi, "Bearer [REDACTED_TOKEN]"],
  [/\b(?:sk|pk|api)[-_][A-Za-z0-9_-]{16,}\b/gi, "[REDACTED_TOKEN]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[REDACTED_SSN]"],
  [/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED_ACCOUNT]"],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[REDACTED_EMAIL]"],
  [/\$\s*-?\d[\d,]*(?:\.\d{2})?/g, "[REDACTED_MONEY]"]
];

export class Redactor {
  private readonly values: string[];

  constructor(sensitiveValues: unknown[] = []) {
    this.values = sensitiveValues
      .filter((value): value is string | number | boolean =>
        ["string", "number", "boolean"].includes(typeof value)
      )
      .map(String)
      .filter((value) => value.length > 0)
      .sort((a, b) => b.length - a.length);
  }

  text(input: string): string {
    let output = input;
    for (const value of this.values) {
      output = output.split(value).join("[REDACTED_INPUT]");
    }
    for (const [pattern, replacement] of SECRET_PATTERNS) {
      output = output.replace(pattern, replacement);
    }
    return output;
  }

  value<T>(input: T): T {
    return JSON.parse(this.text(JSON.stringify(input))) as T;
  }
}
