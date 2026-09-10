import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium, type Browser, type Frame, type Locator, type Page } from "playwright-core";
import type {
  LocatorStrategy,
  Observation,
  ObservedElement,
  Predicate,
  TargetLocator
} from "./types.js";

export interface Surface {
  open(url: string): Promise<void>;
  observe(screenshotPath: string): Promise<Observation>;
  click(target: TargetLocator, timeoutMs: number): Promise<void>;
  type(target: TargetLocator, value: string, timeoutMs: number): Promise<void>;
  extract(target: TargetLocator, timeoutMs: number): Promise<string>;
  wait(timeoutMs: number): Promise<void>;
  reload(timeoutMs: number): Promise<void>;
  verify(predicate: Predicate): Promise<boolean>;
  hasText(text: string): Promise<boolean>;
  currentUrl(): string;
  close(): Promise<void>;
}

interface BrowserSurfaceOptions {
  headless: boolean;
  chromePath?: string;
}

interface RawObservation {
  title: string;
  visibleText: string;
  controls: Array<{
    ref: string;
    kind: "control";
    role: string;
    name: string;
    enabled: boolean;
    htmlName: string;
    tag: string;
    css: string;
  }>;
  readable: Array<{
    ref: string;
    kind: "readable";
    role: string;
    name: string;
    enabled: true;
    rowLabel: string;
    column: number;
  }>;
}

export class BrowserSurface implements Surface {
  private constructor(
    readonly browser: Browser,
    readonly page: Page
  ) {}

  static async launch(options: BrowserSurfaceOptions): Promise<BrowserSurface> {
    const browser = await chromium.launch({
      headless: options.headless,
      ...(options.chromePath === undefined ? {} : { executablePath: options.chromePath })
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    return new BrowserSurface(browser, page);
  }

  async open(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: "domcontentloaded" });
  }

  currentUrl(): string {
    return this.page.url();
  }

  async observe(screenshotPath: string): Promise<Observation> {
    await mkdir(dirname(screenshotPath), { recursive: true });
    await this.page.screenshot({
      path: screenshotPath,
      fullPage: true,
      mask: [
        this.page.locator("input, textarea"),
        this.page.locator("table.result td"),
        this.page.locator("table.layout tr:has(td:nth-child(2)) td:nth-child(2)")
      ],
      maskColor: "#454545"
    });

    const observerScript = await readFile(new URL("./browser/observe-page.js", import.meta.url), "utf8");
    const raw = await this.page.evaluate(observerScript) as RawObservation;

    const controls: ObservedElement[] = raw.controls.map((item) => {
      const strategies: LocatorStrategy[] = [];
      if (item.name && ["button", "link", "textbox", "checkbox", "radio", "combobox"].includes(item.role)) {
        strategies.push({ kind: "role", role: item.role, name: item.name, exact: true });
      }
      if (item.name && ["input", "textarea", "select"].includes(item.tag)) {
        strategies.push({ kind: "label", label: item.name, exact: true });
      }
      if (item.htmlName) strategies.push({ kind: "name", name: item.htmlName });
      if (item.name && ["button", "a"].includes(item.tag)) {
        strategies.push({ kind: "text", text: item.name, exact: true });
      }
      strategies.push({ kind: "css", selector: item.css });
      return {
        ref: item.ref,
        kind: item.kind,
        role: item.role,
        name: item.name,
        enabled: item.enabled,
        locator: {
          strategies,
          robustness: "Semantic role/name first, associated label or name second, structural CSS only as a final fallback."
        }
      };
    });
    const readable: ObservedElement[] = raw.readable.map((item) => ({
      ref: item.ref,
      kind: item.kind,
      role: item.role,
      name: item.name,
      enabled: item.enabled,
      locator: {
        strategies: [{ kind: "table_cell", rowLabel: item.rowLabel, column: item.column }],
        robustness: "Finds the value by its stable row label, never by the runtime value."
      }
    }));
    return {
      url: this.page.url(),
      title: raw.title,
      visibleText: raw.visibleText,
      elements: [...controls, ...readable],
      screenshotPath
    };
  }

  private frameFor(target: TargetLocator): Frame {
    if (target.frameUrlPattern === undefined) return this.page.mainFrame();
    const pattern = new RegExp(target.frameUrlPattern);
    const frame = this.page.frames().find((candidate) => pattern.test(candidate.url()));
    if (frame === undefined) throw new Error(`No frame matched ${target.frameUrlPattern}`);
    return frame;
  }

  private candidate(frame: Frame, strategy: LocatorStrategy): Locator {
    switch (strategy.kind) {
      case "role":
        return frame.getByRole(strategy.role as never, { name: strategy.name, exact: strategy.exact });
      case "label":
        return frame.getByLabel(strategy.label, { exact: strategy.exact });
      case "name":
        return frame.locator(`[name=${JSON.stringify(strategy.name)}]`);
      case "text":
        return frame.getByText(strategy.text, { exact: strategy.exact });
      case "table_cell":
        return frame
          .locator("tr")
          .filter({ has: frame.getByText(strategy.rowLabel, { exact: true }) })
          .locator(":scope > td, :scope > th")
          .nth(strategy.column);
      case "css":
        return frame.locator(strategy.selector);
    }
  }

  private async resolve(target: TargetLocator, timeoutMs: number): Promise<Locator> {
    const frame = this.frameFor(target);
    const failures: string[] = [];
    for (const strategy of target.strategies) {
      const candidate = this.candidate(frame, strategy);
      try {
        const count = await candidate.count();
        if (count !== 1) {
          failures.push(`${strategy.kind}: matched ${count}`);
          continue;
        }
        await candidate.waitFor({ state: "visible", timeout: Math.min(timeoutMs, 3_000) });
        return candidate;
      } catch (error) {
        failures.push(`${strategy.kind}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Target resolution failed (${failures.join("; ")})`);
  }

  async click(target: TargetLocator, timeoutMs: number): Promise<void> {
    const locator = await this.resolve(target, timeoutMs);
    await locator.click({ timeout: timeoutMs });
    await this.page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  }

  async type(target: TargetLocator, value: string, timeoutMs: number): Promise<void> {
    const locator = await this.resolve(target, timeoutMs);
    await locator.fill(value, { timeout: timeoutMs });
  }

  async extract(target: TargetLocator, timeoutMs: number): Promise<string> {
    const locator = await this.resolve(target, timeoutMs);
    if (await locator.evaluate((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      return locator.inputValue({ timeout: timeoutMs });
    }
    return (await locator.innerText({ timeout: timeoutMs })).trim();
  }

  async wait(timeoutMs: number): Promise<void> {
    await this.page.waitForTimeout(timeoutMs);
  }

  async reload(timeoutMs: number): Promise<void> {
    await this.page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
  }

  async hasText(text: string): Promise<boolean> {
    return (await this.page.getByText(text, { exact: false }).count()) > 0;
  }

  async verify(predicate: Predicate): Promise<boolean> {
    switch (predicate.kind) {
      case "url_matches":
        return new RegExp(predicate.pattern).test(this.page.url());
      case "text_present":
        return this.hasText(predicate.text);
      case "element_visible":
        try {
          await this.resolve(predicate.target, 3_000);
          return true;
        } catch {
          return false;
        }
    }
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}
